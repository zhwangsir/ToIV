"""POST /api/audio/orchestrate —— 音频编排层:把已能独立运行的音频引擎(TTS/人声分离)
统一成一条顺序执行的编排 API。纯编排,不动引擎本身。

已落地链:
- 多角色 TTS 对白合成(2026-08-23):steps 里多个 tts 步骤(可选 role → 请求级 voices 音色映射)
  顺序合成 → concat 步骤用 ffmpeg 拼接成一条对白 wav。
- 人声分离(2026-08-23):separate 步骤包装 services.audio_sep(demucs @ workstation),
  source_url 指向本 API 资产或白名单来源(防 SSRF,同 voice.py 纪律)。
- 混音(2026-08-27):mix 步骤用 ffmpeg amix 把前序产物混成单轨
  (各输入先 aresample 归一 24k,amix normalize=0 不自动衰减,duration=longest)。
- TTS 变体(2026-08-27):variant 步骤对最近一次 tts 步骤按 duration_factors
  语速列表逐个重跑合成,产出 N 个真实变体(仅 zh/en——IndexTTS 2.5 支持
  duration_factor;多语言引擎不支持语速扰动,明确 422 不造相同产物)。

音效(sfx)现无现成引擎,steps 里传 sfx 明确返回 501 占位,不造假。

执行语义:顺序执行;任一步失败即中断,HTTPException detail 带步骤序号;
ffmpeg 不可用时不硬拼——concat 返回全部分段产物 + note 标注,mix 明确 500。
产物建档与 voice.py/audio_tools.py 同口径:Job(kind=audio_orchestrate, status=done),
result = 产物 URL 列表(最终产物在前),前端作品库经 /api/jobs 回读。
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import uuid
import wave
from pathlib import Path
from typing import Annotated, Literal
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import Response
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.images import _ranged_response
from app.services.audio_sep import separate_accompaniment, separate_vocals
from app.storage import audio_output_root, content_subdir

logger = logging.getLogger(__name__)

router = APIRouter()

_TTS_TIMEOUT = 180.0  # 同 voice.py:TTS 服务懒加载模型,给足余量
_OUT_NAME_RE = re.compile(r"^audioorch-[0-9a-f]{32}\.wav$")
_ALLOWED_LANGUAGES = {"zh", "en", "ja", "ko", "yue"}
_MAX_SOURCE_BYTES = 50 * 1024 * 1024  # 分离源音频上限 50MB,同 audio_tools


# ---------- 步骤 schema ----------

class VoiceSpec(BaseModel):
    """角色音色映射条目:tts 步骤带 role 时取这里的默认值(步骤级字段优先)。"""
    ref_audio_url: str | None = Field(default=None, max_length=2000)
    language: str = Field(default="zh", max_length=10)
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float = Field(default=0.6, ge=0.0, le=1.0)


class TtsStep(BaseModel):
    type: Literal["tts"]
    text: str = Field(min_length=1, max_length=600)
    role: str | None = Field(default=None, max_length=50)  # 命中请求级 voices 映射
    ref_audio_url: str | None = Field(default=None, max_length=2000)
    language: str | None = Field(default=None, max_length=10)
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float | None = Field(default=None, ge=0.0, le=1.0)


class SeparateStep(BaseModel):
    type: Literal["separate"]
    source_url: str = Field(min_length=1, max_length=2000)  # 相对路径或白名单 URL
    stem: Literal["vocals", "accompaniment"] = "vocals"


class ConcatStep(BaseModel):
    type: Literal["concat"]  # 拼接本轮此前所有 tts 分段(按步骤顺序)


class MixStep(BaseModel):
    """混音:把前序步骤产出的音频产物用 ffmpeg amix 混成单轨。

    inputs 显式给前序步骤序号(从 0 起;引用该步骤产出的全部产物,
    引用 variant 步骤一次即带入其 N 个变体);缺省 = 本轮此前全部产物(按步骤顺序)。
    S10(2026-10-11) BGM 语义:gains_db 按输入顺序逐路增益(空=不增益);
    duck=True 时对第 2..N 路做 sidechain 压制(第 1 路为主音轨如对白)。
    """
    type: Literal["mix"]
    inputs: list[int] | None = Field(default=None, max_length=20)
    gains_db: list[float] | None = Field(default=None, max_length=20, description="逐路增益 dB(BGM 常用 -12~-18)")
    duck: bool = Field(default=False, description="对白优先:非首路按首路 sidechain 压制")


class VariantStep(BaseModel):
    """TTS 变体:对最近一次 tts 步骤按 duration_factors 逐个重跑合成,产出 N 个变体。

    duration_factor 是 IndexTTS 2.5 语速参数(0.5-2.0,<1 加速 >1 减速);
    文本/音色/情感等其余参数沿用源 tts 步骤。仅 zh/en 源可用(多语言引擎不支持语速扰动)。
    """
    type: Literal["variant"]
    duration_factors: list[Annotated[float, Field(ge=0.5, le=2.0)]] = Field(
        min_length=1, max_length=5
    )


# ── S10:音效素材库 ──────────────────────────────────────────────────────
# 原则:无现成音效引擎 → 用 ffmpeg 合成基础音效(真实可听的波形,非静音非假数据)。
# 素材按需生成落 Studio 文件域,同音效名幂等复用。扩展=加条目即可。
_SFX_LIBRARY: dict[str, dict] = {
    "rain": {"desc": "雨声(粉噪+低通)", "gen": ["-f", "lavfi", "-i", "anoisesrc=color=pink:duration=8:amplitude=0.28", "-af", "lowpass=f=900,highpass=f=200"]},
    "wind": {"desc": "风声(棕噪+带通)", "gen": ["-f", "lavfi", "-i", "anoisesrc=color=brown:duration=8:amplitude=0.35", "-af", "bandpass=f=400:width_type=h:w=300"]},
    "thunder": {"desc": "雷声(棕噪+低通+衰减包络)", "gen": ["-f", "lavfi", "-i", "anoisesrc=color=brown:duration=4:amplitude=0.6", "-af", "lowpass=f=300,afade=t=in:d=0.05,afade=t=out:st=1.5:d=2.5"]},
    "doorbell": {"desc": "门铃(双音正弦)", "gen": ["-f", "lavfi", "-i", "sine=frequency=880:duration=0.5", "-f", "lavfi", "-i", "sine=frequency=1100:duration=0.5", "-filter_complex", "[0][1]concat=n=2:v=0:a=1,afade=t=out:st=0.8:d=0.2"]},
    "beep": {"desc": "提示音(单正弦)", "gen": ["-f", "lavfi", "-i", "sine=frequency=1200:duration=0.3", "-af", "afade=t=out:st=0.2:d=0.1"]},
    "footstep": {"desc": "脚步(短噪脉冲×4)", "gen": ["-f", "lavfi", "-i", "anoisesrc=color=white:duration=0.15:amplitude=0.5", "-af", "lowpass=f=600,adelay=0|300|600|900,apulsator=hz=0.01"]},
    "city": {"desc": "城市底噪(白噪+带通+颤)", "gen": ["-f", "lavfi", "-i", "anoisesrc=color=white:duration=8:amplitude=0.15", "-af", "bandpass=f=800:width_type=h:w=1200,tremolo=f=0.5"]},
    "night": {"desc": "夜晚虫鸣(正弦组+颤)", "gen": ["-f", "lavfi", "-i", "sine=frequency=4200:duration=8", "-af", "tremolo=f=8:d=0.7,volume=0.15,lowpass=f=6000"]},
}


def _sfx_cache_path(name: str) -> Path:
    from app.storage import drama_output_root

    d = drama_output_root() / "studio"
    d.mkdir(parents=True, exist_ok=True)
    return d / f"sfx_{name}.wav"


def _ensure_sfx(name: str) -> Path:
    """幂等生成音效素材(ffmpeg lavfi 合成;已存在直接复用)。"""
    entry = _SFX_LIBRARY.get(name)
    if entry is None:
        raise HTTPException(
            status_code=422,
            detail=f"未知音效「{name}」;可用: {', '.join(sorted(_SFX_LIBRARY))}",
        )
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="ffmpeg 不可用,音效素材无法生成")
    cache = _sfx_cache_path(name)
    if cache.is_file() and cache.stat().st_size > 0:
        return cache
    import subprocess

    cmd = ["ffmpeg", "-y", "-v", "error", *entry["gen"], "-ar", "24000", "-ac", "1", str(cache)]
    r = subprocess.run(cmd, capture_output=True, timeout=30)
    if r.returncode != 0 or not cache.is_file():
        raise HTTPException(status_code=500, detail=f"音效「{name}」合成失败: {r.stderr.decode()[:120]}")
    return cache


class SfxStep(BaseModel):
    """音效:S10(2026-10-11)素材库方案——无生成引擎,不造假。

    effect 指定素材库条目(内置库见 _SFX_LIBRARY;可循环/增益)。
    素材缺失 → 422 明细;库为空 → 503(与「引擎未配置」同语义)。
    """
    type: Literal["sfx"]
    effect: str = Field(default="", max_length=64, description="素材库音效名(空=列出可用)")
    loop: bool = Field(default=False, description="循环铺满 target_duration")
    target_duration: float | None = Field(default=None, ge=0.5, le=600, description="循环目标时长(秒)")
    gain_db: float = Field(default=0.0, ge=-24, le=12, description="增益 dB")


Step = Annotated[
    TtsStep | SeparateStep | ConcatStep | MixStep | VariantStep | SfxStep,
    Field(discriminator="type"),
]


class OrchestrateRequest(BaseModel):
    steps: list[Step] = Field(min_length=1, max_length=20)
    title: str | None = Field(default=None, max_length=200)
    voices: dict[str, VoiceSpec] = Field(default_factory=dict, max_length=20)


# ---------- 内部工具 ----------

def _wav_duration(path: Path) -> float | None:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 3)
    except (wave.Error, OSError):
        return None


def _allowed_source(url: str) -> bool:
    """来源白名单:相对路径(本 API)或白名单 worker host,防 SSRF(同 voice.py)。

    回环仅放行本 API 自身端口,不再全端口通配(语义详见 lipsync._allowed)。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    settings = get_settings()
    allowed = {urlsplit(w).hostname for w in settings.worker_urls if urlsplit(w).hostname}
    if host in allowed:
        return True
    if host in {"127.0.0.1", "localhost"}:
        api = urlsplit(settings.api_base_url)
        api_port = api.port or (443 if api.scheme == "https" else 80)
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:  # 非法端口
            return False
        return port == api_port
    return False


def _check_redirect(resp: httpx.Response, initial_url: str) -> None:
    """重定向复验(follow_redirects 下载):最终落点须仍过白名单或与初始
    (已验)URL 同源,否则 400——防白名单内地址开放重定向绕过 SSRF 检查。"""
    final = str(resp.url)
    if final == initial_url:
        return
    f, i = urlsplit(final), urlsplit(initial_url)
    if f.scheme == i.scheme and f.netloc.lower() == i.netloc.lower():
        return
    if not _allowed_source(final):
        raise HTTPException(status_code=400, detail="重定向目标不在白名单内")


def _resolve_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


def _write_output(audio: bytes) -> tuple[Path, str]:
    """产物写音频产物根目录(NAS 优先);不可写时降级本地回退目录(同 audio_tools)。"""
    name = f"audioorch-{uuid.uuid4().hex}.wav"
    root = audio_output_root()
    try:
        root.mkdir(parents=True, exist_ok=True)
        out = root / name
        out.write_bytes(audio)
        return out, name
    except OSError as e:
        logger.warning("音频产物根目录不可写(%s),降级本地回退目录:%s", root, e)
        fallback = content_subdir("audio")
        fallback.mkdir(parents=True, exist_ok=True)
        out = fallback / name
        out.write_bytes(audio)
        return out, name


async def _synth_tts(
    client: httpx.AsyncClient,
    step: TtsStep,
    spec: VoiceSpec,
    duration_factor: float | None = None,
) -> bytes:
    """单段 TTS 合成(多语言路由同 voice.py:zh/en 走 tts_url,ja/ko/yue 走多语言)。

    duration_factor:语速扰动(variant 步骤专用),透传 IndexTTS 2.5 的
    duration_factor(0.5-2.0);None = 不带该字段,引擎按默认语速。
    """
    language = step.language or spec.language
    if language not in _ALLOWED_LANGUAGES:
        raise HTTPException(status_code=422, detail=f"不支持的合成语言:{language}")
    emo_text = step.emo_text if step.emo_text is not None else spec.emo_text
    emo_alpha = step.emo_alpha if step.emo_alpha is not None else spec.emo_alpha
    ref_audio_url = step.ref_audio_url or spec.ref_audio_url

    settings = get_settings()
    if language in {"ja", "ko", "yue"}:
        tts_target = settings.tts_multilingual_url.strip().rstrip("/")
        if not tts_target:
            raise HTTPException(status_code=503, detail="多语言 TTS 服务未配置")
    else:
        tts_target = settings.tts_url.strip().rstrip("/")

    data: dict[str, str] = {"text": step.text}
    if emo_text and emo_text.strip():
        data["emo_text"] = emo_text.strip()
        data["emo_alpha"] = str(emo_alpha)
    if duration_factor is not None:
        data["duration_factor"] = str(duration_factor)
    if language in {"ja", "ko", "yue"}:
        data["language"] = language

    files = None
    if ref_audio_url:
        if not _allowed_source(ref_audio_url):
            raise HTTPException(status_code=400, detail="参考音来源不在白名单内")
        try:
            rr = await client.get(_resolve_url(ref_audio_url))
            rr.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"参考音下载失败:{e}") from e
        files = {"ref_audio": ("ref.wav", rr.content, "audio/wav")}

    try:
        resp = await client.post(tts_target + "/tts", data=data, files=files)
    except httpx.HTTPError as e:
        raise HTTPException(status_code=502, detail=f"TTS 服务不可达:{e}") from e
    if resp.status_code != 200:
        detail = "TTS 合成失败"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError, AttributeError):
            detail = (resp.text or "")[:200] or detail
        raise HTTPException(status_code=502, detail=detail)
    if not resp.content or resp.content[:4] != b"RIFF":
        raise HTTPException(status_code=502, detail="TTS 返回非音频")
    return resp.content


async def _concat_wav(segments: list[Path]) -> bytes:
    """ffmpeg concat 拼接分段(重编码归一 24k 单声道,容错各段参数差异)。"""
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    with tempfile.TemporaryDirectory() as td:
        lst = Path(td) / "concat.txt"
        lst.write_text(
            "".join(f"file '{p}'\n" for p in segments), encoding="utf-8"
        )
        out = Path(td) / "out.wav"
        proc = await asyncio.create_subprocess_exec(
            "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(lst),
            "-ac", "1", "-ar", "24000", str(out),
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            tail = (stderr or b"").decode("utf-8", "replace")[-300:]
            raise HTTPException(status_code=500, detail=f"音频拼接失败:{tail}")
        return out.read_bytes()


async def _mix_wav(inputs: list[Path], *, gains_db: list[float] | None = None, duck: bool = False) -> bytes:
    """ffmpeg amix 混音:各输入先 aresample 归一 24k(采样率不统一也能混),
    再 amix 合成单轨——normalize=0 不做自动衰减,duration=longest 不截断长输入。

    S10: gains_db 逐路增益(BGM 常用);duck=True 时第 2..N 路以第 1 路
    sidechaincompress 压制(对白优先,BGM 让位),再 amix。"""
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")
    with tempfile.TemporaryDirectory() as td:
        out = Path(td) / "out.wav"
        cmd = ["ffmpeg", "-y"]
        for p in inputs:
            cmd += ["-i", str(p)]
        filters = "".join(f"[{k}:a]aresample=24000[a{k}];" for k in range(len(inputs)))
        if gains_db:
            for k, g in enumerate(gains_db[: len(inputs)]):
                filters += f"[a{k}]volume={g}dB[g{k}];"
            for k in range(len(inputs)):
                src_tag = f"g{k}" if k < len(gains_db) else f"a{k}"
                filters += f"[{src_tag}]"
        else:
            filters += "".join(f"[a{k}]" for k in range(len(inputs)))
        if duck and len(inputs) >= 2:
            # 主轨(0)为 sidechain 源;各副轨压缩后统一 amix
            filters = filters[: filters.rindex("".join(f"[a{k}]" for k in range(len(inputs))))] if not gains_db else filters
            parts = []
            chain = "".join(f"[g{k}]" if gains_db and k < len(gains_db) else f"[a{k}]" for k in range(len(inputs)))
            filters = filters[: filters.rindex(chain)] if chain in filters else filters
            for k in range(1, len(inputs)):
                tag_in = f"g{k}" if gains_db and k < len(gains_db) else f"a{k}"
                filters += f"[a0][{tag_in}]sidechaincompress=threshold=0.03:ratio=8:attack=5:release=300[d{k}];"
            parts.append("[a0]" if not (gains_db and 0 < len(gains_db)) else "[g0]")
            parts += [f"[d{k}]" for k in range(1, len(inputs))]
            filters += "".join(parts)
        filters += f"amix=inputs={len(inputs)}:duration=longest:normalize=0[aout]"
        cmd += ["-filter_complex", filters, "-map", "[aout]", "-ar", "24000", str(out)]
        proc = await asyncio.create_subprocess_exec(
            *cmd,
            stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
        )
        _, stderr = await proc.communicate()
        if proc.returncode != 0 or not out.exists() or out.stat().st_size == 0:
            tail = (stderr or b"").decode("utf-8", "replace")[-300:]
            raise HTTPException(status_code=500, detail=f"音频混音失败:{tail}")
        return out.read_bytes()


# ---------- 端点 ----------

@router.post("/audio/orchestrate")
async def audio_orchestrate(
    body: OrchestrateRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """顺序执行编排步骤,产物落盘 + Job(kind=audio_orchestrate) 建档。

    失败纪律:任一步失败即中断,detail 前缀「步骤 N(类型)」;引擎不可达 502,
    服务未配置 503;sfx 占位 501;mix 输入不足/引用步骤无产物 422、ffmpeg 缺失 500;
    variant 无前序 tts/多语言源 422;concat 在 ffmpeg 缺失时不硬拼,返回分段 + note。
    """
    enforce_generation_rate_limit(user)

    segments: list[Path] = []  # tts 分段(concat 的输入)
    produced: dict[int, list[Path]] = {}  # 步骤序号 → 产物路径(mix 的输入来源)
    last_tts: tuple[TtsStep, VoiceSpec] | None = None  # 最近一次 tts 步骤(variant 的源)
    artifacts: list[dict[str, object]] = []  # 全部产物(分段/分离/拼接/混音/变体)
    final_url: str | None = None
    note: str | None = None

    async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False) as client:
        for i, step in enumerate(body.steps):
            try:
                if isinstance(step, SfxStep):
                    if not (step.effect or "").strip():
                        # 列表模式:返回可用音效(不产文件)
                        artifacts.append({
                            "step": i, "type": "sfx_list",
                            "effects": {k: v["desc"] for k, v in _SFX_LIBRARY.items()},
                        })
                        continue
                    sfx_path = _ensure_sfx(step.effect.strip())
                    out_path = sfx_path
                    if step.loop and step.target_duration:
                        looped = _sfx_cache_path(f"{step.effect}_loop{int(step.target_duration)}")
                        if not looped.is_file():
                            import subprocess as _sp

                            rc = _sp.run(
                                ["ffmpeg", "-y", "-v", "error", "-stream_loop", "-1",
                                 "-i", str(sfx_path), "-t", str(step.target_duration),
                                 "-ar", "24000", "-ac", "1", str(looped)],
                                capture_output=True, timeout=60,
                            )
                            if rc.returncode != 0:
                                raise HTTPException(status_code=500, detail=f"音效循环失败: {rc.stderr.decode()[:120]}")
                        out_path = looped
                    if step.gain_db:
                        gained = _sfx_cache_path(f"{step.effect}_g{int(step.gain_db)}")
                        if not gained.is_file():
                            import subprocess as _sp

                            rc = _sp.run(
                                ["ffmpeg", "-y", "-v", "error", "-i", str(out_path),
                                 "-af", f"volume={step.gain_db}dB", str(gained)],
                                capture_output=True, timeout=30,
                            )
                            if rc.returncode != 0:
                                raise HTTPException(status_code=500, detail=f"音效增益失败: {rc.stderr.decode()[:120]}")
                        out_path = gained
                    produced.setdefault(i, []).append(out_path)
                    name = out_path.name
                    artifacts.append({
                        "step": i, "type": "sfx", "effect": step.effect,
                        "url": f"/api/studio/files/{name}",
                        "duration_sec": _wav_duration(out_path),
                    })
                if isinstance(step, TtsStep):
                    spec = body.voices.get(step.role or "") or VoiceSpec()
                    wav = await _synth_tts(client, step, spec)
                    path, name = _write_output(wav)
                    segments.append(path)
                    produced.setdefault(i, []).append(path)
                    last_tts = (step, spec)
                    artifacts.append({
                        "step": i, "type": "tts", "role": step.role,
                        "url": f"/api/audio/orch/files/{name}",
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, SeparateStep):
                    if not _allowed_source(step.source_url):
                        raise HTTPException(status_code=400, detail="分离源不在白名单内")
                    src_resolved = _resolve_url(step.source_url)
                    try:
                        rr = await client.get(src_resolved)
                        _check_redirect(rr, src_resolved)
                        rr.raise_for_status()
                    except httpx.HTTPError as e:
                        raise HTTPException(status_code=502, detail=f"分离源下载失败:{e}") from e
                    if len(rr.content) > _MAX_SOURCE_BYTES:
                        raise HTTPException(status_code=413, detail="分离源音频过大(上限 50MB)")
                    fn = urlsplit(step.source_url).path.rsplit("/", 1)[-1] or "audio.wav"
                    if step.stem == "accompaniment":
                        wav = await separate_accompaniment(rr.content, filename=fn)
                    else:
                        wav = await separate_vocals(rr.content, filename=fn)
                    path, name = _write_output(wav)
                    produced.setdefault(i, []).append(path)
                    artifacts.append({
                        "step": i, "type": "separate", "stem": step.stem,
                        "url": f"/api/audio/orch/files/{name}",
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, ConcatStep):
                    if not segments:
                        raise HTTPException(status_code=422, detail="没有可拼接的 TTS 分段")
                    if shutil.which("ffmpeg") is None:
                        # 不硬拼:分段产物照常交付,note 标注(任务纪律)。
                        note = "服务端无 ffmpeg,跳过拼接,仅返回分段产物"
                        logger.warning("audio/orchestrate: ffmpeg 不可用,concat 步骤跳过")
                        continue
                    wav = await _concat_wav(segments)
                    path, name = _write_output(wav)
                    produced.setdefault(i, []).append(path)
                    final_url = f"/api/audio/orch/files/{name}"
                    artifacts.append({
                        "step": i, "type": "concat",
                        "url": final_url,
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, MixStep):
                    if step.inputs is None:
                        mix_inputs = [p for paths in produced.values() for p in paths]
                    else:
                        missing = [idx for idx in step.inputs if not produced.get(idx)]
                        if missing:
                            raise HTTPException(
                                status_code=422, detail=f"混音输入步骤 {missing} 无产物"
                            )
                        mix_inputs = [p for idx in step.inputs for p in produced[idx]]
                    if len(mix_inputs) < 2:
                        raise HTTPException(
                            status_code=422, detail="混音至少需要两个输入产物"
                        )
                    wav = await _mix_wav(mix_inputs, gains_db=step.gains_db, duck=step.duck)
                    path, name = _write_output(wav)
                    produced.setdefault(i, []).append(path)
                    final_url = f"/api/audio/orch/files/{name}"
                    artifacts.append({
                        "step": i, "type": "mix", "inputs": len(mix_inputs),
                        "url": final_url,
                        "duration_sec": _wav_duration(path),
                    })
                elif isinstance(step, VariantStep):
                    if last_tts is None:
                        raise HTTPException(
                            status_code=422, detail="没有可变体的前序 TTS 步骤"
                        )
                    src_step, src_spec = last_tts
                    src_language = src_step.language or src_spec.language
                    if src_language in {"ja", "ko", "yue"}:
                        raise HTTPException(
                            status_code=422,
                            detail=(
                                f"变体暂不支持多语言源({src_language}):"
                                "语速扰动仅 zh/en 引擎(IndexTTS 2.5 duration_factor)支持"
                            ),
                        )
                    for factor in step.duration_factors:
                        wav = await _synth_tts(
                            client, src_step, src_spec, duration_factor=factor
                        )
                        path, name = _write_output(wav)
                        produced.setdefault(i, []).append(path)
                        artifacts.append({
                            "step": i, "type": "variant", "duration_factor": factor,
                            "url": f"/api/audio/orch/files/{name}",
                            "duration_sec": _wav_duration(path),
                        })
            except HTTPException as e:
                # 失败中断:标注步骤序号后原码上抛。
                e.detail = f"步骤 {i}({step.type}) 失败:{e.detail}"
                raise

    result_urls = ([final_url] if final_url else []) + [
        str(a["url"]) for a in artifacts if a.get("url") and a["url"] != final_url
    ]
    prompt = (body.title or "").strip() or next(
        (s.text for s in body.steps if isinstance(s, TtsStep)), "audio orchestration"
    )

    # 建档(同 voice.py 纪律:产物已落盘,建档失败不炸主流程)
    try:
        session.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=user.id,
                prompt_id=f"orch-{uuid.uuid4().hex}",
                worker="local",
                kind="audio_orchestrate",
                status="done",
                prompt=prompt[:500],
                seed=0,
                result=json.dumps(result_urls, ensure_ascii=False),
                params=json.dumps(
                    {
                        "title": body.title,
                        "steps": [
                            s.model_dump(exclude_none=True) for s in body.steps
                        ],
                        "note": note,
                    },
                    ensure_ascii=False,
                ),
            )
        )
        session.commit()
    except Exception:
        session.rollback()
        logger.warning("编排产物建档失败(音频已落盘)", exc_info=True)

    return {
        "kind": "audio_orchestrate",
        "url": final_url,
        "artifacts": artifacts,
        "note": note,
    }


@router.get("/audio/orch/files/{name}")
async def get_orch_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),
) -> Response:
    """回读编排产物。NAS 根目录与本地回退目录依次找;手动 Range 支持(同 audio_tools)。"""
    if not _OUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    for root in (audio_output_root(), content_subdir("audio")):
        try:
            path = root / name
            if path.is_file():
                return _ranged_response(
                    path.read_bytes(), "audio/wav", request.headers.get("range")
                )
        except OSError as e:
            logger.warning("音频产物目录不可达(%s):%s", root, e)
    raise HTTPException(status_code=404, detail="音频产物不存在")
