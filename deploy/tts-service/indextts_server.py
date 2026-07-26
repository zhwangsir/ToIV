"""ToIV TTS Service —— IndexTTS2 FastAPI 封装,接口兼容 ToIV /tts 契约。

兼容契约(ToIV voice.py / dub_voice.py 调用方期望):
  POST /tts
    Form: text, emo_text(可选), emo_alpha(可选,默认 0.8), language(可选,仅日志)
    Files: ref_audio(可选, multipart) —— 音色克隆参考音频;无则用默认音色兜底
    Response: 200 + wav 二进制(24kHz/16bit/mono);失败 JSON {"detail": "..."}

IndexTTS2 推理参数映射:
  spk_audio_prompt  ← ref_audio(临时落盘)
  text              ← text
  use_emo_text      ← True if emo_text else False
                      True 时调用 Qwen3 推情感向量(如 "开心地说" / "愤怒地")
  emo_text          ← emo_text
  emo_alpha         ← emo_alpha(0.0-1.0,情感混合权重)
  output_path       ← 临时 wav 文件
  emo_audio_prompt  ← None(use_emo_text=True 时由 IndexTTS2 内部置空,情感与音色解耦)

并发策略:IndexTTS2 推理是 GPU 单卡同步阻塞,用 asyncio.Lock 保证一次一个推理,
避免显存竞争。等待中的请求排队,符合 ToIV 配音场景(单 GPU 节点)。

启动:
  cd ~/index-tts
  uv run python toiv_tts_server.py --host 0.0.0.0 --port 9200
"""
from __future__ import annotations

import argparse
import asyncio
import logging
import os
import tempfile
import time
from pathlib import Path
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import Response

logger = logging.getLogger("toiv-tts")
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)s %(message)s",
)

# 默认参考音频:无 ref_audio 时用此样本兜底,保证服务可用
# 路径优先级:环境变量 TOIV_TTS_DEFAULT_REF > 项目内默认样本
DEFAULT_REF_CANDIDATES = [
    os.environ.get("TOIV_TTS_DEFAULT_REF", ""),
    "checkpoints/default_ref.wav",
    "examples/default_ref.wav",
    "assets/default_ref.wav",
]

MAX_TEXT_LEN = 2000
# IndexTTS2 推荐 emo_alpha 接近 1.0(情感向量与音色解耦,alpha 控制情感强度)
DEFAULT_EMO_ALPHA = 0.8
# Qwen3 情感文本推理(use_emo_text=True)在部分环境会触发 max_length 警告并卡死,
# 默认禁用:emo_text 仅作日志记录,不调 Qwen3。设 TOIV_TTS_ENABLE_EMO_TEXT=true 启用。
# 禁用时仍支持:音色克隆(ref_audio)+ 基础合成 + emo_alpha(透传但不影响输出)。
_ENABLE_EMO_TEXT = os.environ.get("TOIV_TTS_ENABLE_EMO_TEXT", "false").lower() in ("1", "true", "yes")

app = FastAPI(title="ToIV TTS Service (IndexTTS2)")

# 全局模型实例 + 推理锁(避免 GPU 并发竞争)
_tts = None
_infer_lock = asyncio.Lock()
_default_ref_audio: Optional[str] = None


def _resolve_default_ref() -> Optional[str]:
    """从候选路径找一个存在的默认参考音频;找不到返回 None(无 ref 请求将报错)。"""
    for path in DEFAULT_REF_CANDIDATES:
        if path and Path(path).is_file():
            return path
    return None


def _save_upload_to_tmp(upload: UploadFile, suffix: str = ".wav") -> str:
    """把 UploadFile 落盘到临时文件,返回路径(调用方负责清理)。"""
    fd, tmp_path = tempfile.mkstemp(suffix=suffix, prefix="toiv_tts_ref_")
    os.close(fd)
    try:
        with open(tmp_path, "wb") as f:
            while True:
                chunk = upload.file.read(64 * 1024)
                if not chunk:
                    break
                f.write(chunk)
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return tmp_path


def _do_infer(spk_audio: str, text: str, output_path: str,
              use_emo_text: bool, emo_text: Optional[str], emo_alpha: float) -> None:
    """同步调用 IndexTTS2.infer;在 threadpool 里跑,不阻塞 event loop。"""
    result = _tts.infer(
        spk_audio_prompt=spk_audio,
        text=text,
        output_path=output_path,
        use_emo_text=use_emo_text,
        emo_text=emo_text if use_emo_text else None,
        emo_alpha=emo_alpha,
    )
    if result is None:
        raise RuntimeError("IndexTTS2.infer 返回 None(可能因输入被过滤或内部错误)")


@app.on_event("startup")
async def _load_model() -> None:
    """启动时加载 IndexTTS2 模型(耗时 30-60s);加载完成前 /health 返回 loading。"""
    global _tts, _default_ref_audio
    model_dir = os.environ.get("INDEXTTS_MODEL_DIR", "checkpoints")
    cfg_path = os.environ.get("INDEXTTS_CFG_PATH", f"{model_dir}/config.yaml")
    device = os.environ.get("INDEXTTS_DEVICE", "")  # 空 = 自动(cuda:0)
    use_fp16 = os.environ.get("INDEXTTS_USE_FP16", "true").lower() in ("1", "true", "yes")

    logger.info("加载 IndexTTS2 模型:cfg=%s model_dir=%s device=%s fp16=%s",
                cfg_path, model_dir, device or "auto", use_fp16)
    t0 = time.perf_counter()

    from indextts.infer_v2 import IndexTTS2  # type: ignore

    kwargs = {
        "cfg_path": cfg_path,
        "model_dir": model_dir,
        "use_fp16": use_fp16,
    }
    if device:
        kwargs["device"] = device
    _tts = IndexTTS2(**kwargs)
    _default_ref_audio = _resolve_default_ref()
    logger.info("IndexTTS2 加载完成,耗时 %.1fs;默认参考音频=%s",
                time.perf_counter() - t0, _default_ref_audio or "(无,需 caller 传 ref_audio)")


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok" if _tts is not None else "loading",
        "engine": "indextts2",
        "model_loaded": _tts is not None,
        "default_ref_audio": _default_ref_audio is not None,
        "device": getattr(_tts, "device", None) if _tts else None,
    }


@app.post("/tts")
async def tts(
    text: str = Form(...),
    emo_text: Optional[str] = Form(None),
    emo_alpha: Optional[str] = Form(str(DEFAULT_EMO_ALPHA)),
    language: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
):
    if _tts is None:
        raise HTTPException(status_code=503, detail="IndexTTS2 模型尚未加载完成,请稍后重试")

    text = text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="text 不能为空")
    if len(text) > MAX_TEXT_LEN:
        raise HTTPException(status_code=400, detail=f"text 过长,上限 {MAX_TEXT_LEN} 字符")

    try:
        alpha = float(emo_alpha) if emo_alpha is not None else DEFAULT_EMO_ALPHA
    except (ValueError, TypeError):
        alpha = DEFAULT_EMO_ALPHA
    alpha = max(0.0, min(1.0, alpha))

    use_emo_text = _ENABLE_EMO_TEXT and bool(emo_text and emo_text.strip())
    emo_text_value = emo_text.strip() if (emo_text and emo_text.strip()) else None

    # 处理参考音频:caller 传 ref_audio 用之;否则用默认兜底
    tmp_ref_path: Optional[str] = None
    if ref_audio is not None and ref_audio.filename:
        try:
            tmp_ref_path = _save_upload_to_tmp(ref_audio)
            spk_audio = tmp_ref_path
        except Exception as e:
            logger.exception("保存 ref_audio 失败")
            raise HTTPException(status_code=400, detail=f"ref_audio 保存失败: {e}")
    else:
        if not _default_ref_audio:
            raise HTTPException(
                status_code=400,
                detail="未传 ref_audio 且服务端未配置默认参考音频;请上传 ref_audio",
            )
        spk_audio = _default_ref_audio

    # 输出临时文件
    fd, out_path = tempfile.mkstemp(suffix=".wav", prefix="toiv_tts_out_")
    os.close(fd)

    try:
        # GPU 推理串行化,避免显存竞争
        async with _infer_lock:
            t0 = time.perf_counter()
            await asyncio.to_thread(
                _do_infer,
                spk_audio, text, out_path,
                use_emo_text, emo_text_value, alpha,
            )
            elapsed = time.perf_counter() - t0

        if not Path(out_path).is_file() or os.path.getsize(out_path) == 0:
            raise HTTPException(status_code=500, detail="IndexTTS2 未生成音频文件")

        logger.info(
            "tts ok: text_len=%d emo_text=%s alpha=%.2f lang=%s ref=%s elapsed=%.2fs",
            len(text), emo_text_value or "-", alpha, language or "-",
            "upload" if tmp_ref_path else "default", elapsed,
        )
        with open(out_path, "rb") as f:
            wav_data = f.read()
        return Response(content=wav_data, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("IndexTTS2 推理失败")
        raise HTTPException(status_code=502, detail=f"TTS 合成失败: {e}")
    finally:
        for p in (tmp_ref_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="ToIV TTS Service (IndexTTS2)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9200)
    parser.add_argument("--workers", type=int, default=1,
                        help="uvicorn workers;IndexTTS2 单进程加载模型,多 worker 会复制模型占显存,默认 1")
    args = parser.parse_args()

    import uvicorn

    logger.info("启动 ToIV TTS Service (IndexTTS2) on %s:%d", args.host, args.port)
    uvicorn.run(
        "toiv_tts_server:app",
        host=args.host,
        port=args.port,
        workers=args.workers,
        log_level="info",
        timeout_keep_alive=120,
    )


if __name__ == "__main__":
    main()
