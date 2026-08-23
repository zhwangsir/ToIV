"""ToIV TTS Service —— IndexTTS 2.5 FastAPI 封装,接口兼容 ToIV /tts 契约。

兼容契约(ToIV voice.py / dub_voice.py 调用方期望,2.5 升级后保持不变):
  POST /tts
    Form: text, emo_text(可选), emo_alpha(可选,默认 0.8), language(可选),
          top_p/temperature(可选,采样透传), duration_factor(可选,0.5-2.0 语速,默认 1.0)
    Files: ref_audio(可选, multipart) —— 音色克隆参考音频;无则用默认音色兜底
    Response: 200 + wav 二进制(24kHz/16bit/mono);失败 JSON {"detail": "..."}

IndexTTS 2.5 推理参数映射:
  spk_audio_prompt  ← ref_audio(临时落盘)
  text              ← text
  lang              ← language 字段(规范化)或按文本启发式判定(ZH/JA/AR/EN),默认 ZH
                      2.5 新增必选参数,合法值 ZH/EN/JA/ES/AR
  use_emo_text      ← True if emo_text else False
                      True 时调用 Qwen3 推情感向量(如 "开心地说" / "愤怒地")
                      需构造时 use_qwen_emo=True(由 TOIV_TTS_ENABLE_EMO_TEXT 控制)
  emo_text          ← emo_text
  emo_alpha         ← emo_alpha(0.0-1.0,情感混合权重)
  duration_factor   ← duration_factor(0.5-2.0,<1 加速 >1 减速,2.5 新增)
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
import re
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
# 2.5 的 Qwen3 情感文本推理(use_emo_text=True)已稳定(2.0 时代 max_length 卡死问题不再),
# 默认启用;设 TOIV_TTS_ENABLE_EMO_TEXT=false 回退为仅记录日志不调 Qwen3。
# 启用时构造 IndexTTS2 会传 use_qwen_emo=True(2.5 强制要求,否则 RuntimeError)。
_ENABLE_EMO_TEXT = os.environ.get("TOIV_TTS_ENABLE_EMO_TEXT", "true").lower() in ("1", "true", "yes")

# 2.5 lang 合法值:ZH/EN/JA/ES/AR(infer_v2_5 必选参数)
_LANG_ALIASES = {
    "zh": "ZH", "zhen": "ZH", "cn": "ZH", "zh-cn": "ZH", "cmn": "ZH",
    "yue": "ZH",  # 粤语用 ZH 前缀(多语种 tokenizer 已含粤字表)
    "en": "EN", "en-us": "EN", "en-gb": "EN",
    "ja": "JA", "jp": "JA",
    "es": "ES",
    "ar": "AR",
}
_RE_KANA = re.compile(r"[぀-ヿ]")
_RE_CJK = re.compile(r"[一-鿿]")
_RE_ARABIC = re.compile(r"[؀-ۿݐ-ݿ]")


def _resolve_lang(language: Optional[str], text: str) -> str:
    """language 字段优先(规范化到 ZH/EN/JA/ES/AR);否则按文本字符启发式判定,默认 ZH。"""
    if language and language.strip():
        mapped = _LANG_ALIASES.get(language.strip().lower())
        if mapped:
            return mapped
        logger.warning("未识别的 language=%r,回退启发式判定", language)
    if _RE_KANA.search(text):
        return "JA"
    if _RE_ARABIC.search(text):
        return "AR"
    if _RE_CJK.search(text):
        return "ZH"
    return "EN"


app = FastAPI(title="ToIV TTS Service (IndexTTS 2.5)")

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


def _do_infer(spk_audio: str, text: str, output_path: str, lang: str,
              use_emo_text: bool, emo_text: Optional[str], emo_alpha: float,
              duration_factor: float,
              top_p: Optional[float] = None, temperature: Optional[float] = None) -> None:
    """同步调用 IndexTTS2.infer;在 threadpool 里跑,不阻塞 event loop。

    top_p/temperature 非空时经 generation_kwargs 透传给 GPT 采样
    (库默认 top_p=0.8/temperature=0.8;AI-Omni M32.30 基准 0.75/0.65,输出更收敛稳定)。
    """
    gen_kwargs: dict = {}
    if top_p is not None:
        gen_kwargs["top_p"] = top_p
    if temperature is not None:
        gen_kwargs["temperature"] = temperature
    result = _tts.infer(
        spk_audio_prompt=spk_audio,
        text=text,
        output_path=output_path,
        lang=lang,
        use_emo_text=use_emo_text,
        emo_text=emo_text if use_emo_text else None,
        emo_alpha=emo_alpha,
        duration_factor=duration_factor,
        **gen_kwargs,
    )
    if result is None:
        raise RuntimeError("IndexTTS2.infer 返回 None(可能因输入被过滤或内部错误)")


@app.on_event("startup")
async def _load_model() -> None:
    """启动时加载 IndexTTS 2.5 模型(耗时 30-60s);加载完成前 /health 返回 loading。"""
    global _tts, _default_ref_audio
    model_dir = os.environ.get("INDEXTTS_MODEL_DIR", "checkpoints")
    cfg_path = os.environ.get("INDEXTTS_CFG_PATH", f"{model_dir}/config.yaml")
    device = os.environ.get("INDEXTTS_DEVICE", "")  # 空 = 自动(cuda:0)
    use_bf16 = os.environ.get("INDEXTTS_USE_BF16", "true").lower() in ("1", "true", "yes")

    logger.info("加载 IndexTTS 2.5 模型:cfg=%s model_dir=%s device=%s bf16=%s qwen_emo=%s",
                cfg_path, model_dir, device or "auto", use_bf16, _ENABLE_EMO_TEXT)
    t0 = time.perf_counter()

    # M32.30 修复:torchaudio 的 sox 后端在本机段错误(libtorchaudio_sox.so),
    # 强制 load/save 走 soundfile 后端(已验证可用,24kHz ref 读取正常)。
    import torchaudio as _ta

    _ta_load_orig, _ta_save_orig = _ta.load, _ta.save

    def _ta_load_sf(*args, **kwargs):  # type: ignore
        kwargs.setdefault("backend", "soundfile")
        return _ta_load_orig(*args, **kwargs)

    def _ta_save_sf(*args, **kwargs):  # type: ignore
        kwargs.setdefault("backend", "soundfile")
        return _ta_save_orig(*args, **kwargs)

    _ta.load, _ta.save = _ta_load_sf, _ta_save_sf

    from indextts.infer_v2_5 import IndexTTS2  # type: ignore

    kwargs = {
        "cfg_path": cfg_path,
        "model_dir": model_dir,
        "use_bf16": use_bf16,
        "use_qwen_emo": _ENABLE_EMO_TEXT,
    }
    if device:
        kwargs["device"] = device
    _tts = IndexTTS2(**kwargs)
    _default_ref_audio = _resolve_default_ref()
    logger.info("IndexTTS 2.5 加载完成,耗时 %.1fs;默认参考音频=%s",
                time.perf_counter() - t0, _default_ref_audio or "(无,需 caller 传 ref_audio)")


@app.get("/health")
async def health() -> dict:
    return {
        "status": "ok" if _tts is not None else "loading",
        "engine": "indextts2",
        "version": "2.5",
        "model_loaded": _tts is not None,
        "default_ref_audio": _default_ref_audio is not None,
        "emo_text_enabled": _ENABLE_EMO_TEXT,
        "device": getattr(_tts, "device", None) if _tts else None,
    }


@app.post("/tts")
async def tts(
    text: str = Form(...),
    emo_text: Optional[str] = Form(None),
    emo_alpha: Optional[str] = Form(str(DEFAULT_EMO_ALPHA)),
    language: Optional[str] = Form(None),
    duration_factor: Optional[str] = Form(None),
    top_p: Optional[str] = Form(None),
    temperature: Optional[str] = Form(None),
    ref_audio: Optional[UploadFile] = File(None),
):
    if _tts is None:
        raise HTTPException(status_code=503, detail="IndexTTS 2.5 模型尚未加载完成,请稍后重试")

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

    def _parse_opt_float(value: Optional[str], lo: float, hi: float) -> Optional[float]:
        try:
            v = float(value) if value is not None else None
        except (ValueError, TypeError):
            return None
        return max(lo, min(hi, v)) if v is not None else None

    top_p_value = _parse_opt_float(top_p, 0.0, 1.0)
    temperature_value = _parse_opt_float(temperature, 0.05, 1.5)
    duration_value = _parse_opt_float(duration_factor, 0.5, 2.0) or 1.0

    lang = _resolve_lang(language, text)

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
                spk_audio, text, out_path, lang,
                use_emo_text, emo_text_value, alpha, duration_value,
                top_p_value, temperature_value,
            )
            elapsed = time.perf_counter() - t0

        if not Path(out_path).is_file() or os.path.getsize(out_path) == 0:
            raise HTTPException(status_code=500, detail="IndexTTS 2.5 未生成音频文件")

        logger.info(
            "tts ok: text_len=%d lang=%s emo_text=%s alpha=%.2f dur=%.2f ref=%s elapsed=%.2fs",
            len(text), lang, emo_text_value or "-", alpha, duration_value,
            "upload" if tmp_ref_path else "default", elapsed,
        )
        with open(out_path, "rb") as f:
            wav_data = f.read()
        return Response(content=wav_data, media_type="audio/wav")

    except HTTPException:
        raise
    except Exception as e:
        logger.exception("IndexTTS 2.5 推理失败")
        raise HTTPException(status_code=502, detail=f"TTS 合成失败: {e}")
    finally:
        for p in (tmp_ref_path, out_path):
            if p:
                try:
                    os.unlink(p)
                except OSError:
                    pass


def main() -> None:
    parser = argparse.ArgumentParser(description="ToIV TTS Service (IndexTTS 2.5)")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9200)
    parser.add_argument("--workers", type=int, default=1,
                        help="uvicorn workers;IndexTTS2 单进程加载模型,多 worker 会复制模型占显存,默认 1")
    args = parser.parse_args()

    import uvicorn

    logger.info("启动 ToIV TTS Service (IndexTTS 2.5) on %s:%d", args.host, args.port)
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
