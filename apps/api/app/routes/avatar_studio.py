"""LongCat-Avatar 音频驱动数字人工作室 —— 人像首帧 + 音频 → 口型数字人视频。

POST /api/avatar/talk —— 数字人说话视频(LongCat-Avatar v1.5,专用实例 :8197,
                        与 LongCat t2v/i2v 同一 ComfyUI 实例,不走 WorkerPool)

输入链路(同 longcat i2v 模式):人像图与驱动音频先经 /api/upload(kind=avatar)
上传到 pool worker,提交时由后端转运到 LongCat 实例 input 目录
(ComfyUI /upload/image 接受任意文件,LoadAudio 从 input 目录读取音频)。

参数约束(参考 workstation /tmp/longcat_avatar_smoke.py 真机冒烟):
  · 时长按秒选择(duration_sec,任意值;内部经统一策略层 services/duration 换算,
    4k+1 网格吸附后秒差大时生成后精确裁切);num_frames(帧数)为 deprecated 兼容入参
  · 帧数 17-2500(旧默认 93 ≈ 3.7s@25fps;>93 帧自动按 93 帧窗口链式续段,段间 13 帧
    warmup 重编码垫底后切掉;残段向上取整 4k+1 采样网格,实际产出最多
    多 3 帧;2500 帧@25fps≈100s。续段链路 2026-08-08 真机验证:186 帧
    3 段链式出片 189 帧/7.56s,缝口无跳帧)
  · 宽/高 320-1280,16 对齐(非对齐自动向下取整);默认 480×832
  · steps 1-50(默认 12,dmd 蒸馏 LoRA 低步数);fps 8-30(默认 25,
    WhisperEmbeds 特征帧率与成片打包帧率同源)
  · cfg 默认 1.0(蒸馏链路);shift 默认 12.0
  · 音频时长与 num_frames 不一致时以 num_frames 为准:音频超长部分截断,
    不足时 ExtendEmbeds 按 if_not_enough_audio=pad_with_start 以首帧音频填充
    (尾段口型静止,与官方示例一致的缺省行为)
"""
from __future__ import annotations

import uuid

import httpx
from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import User
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.routes.audio_orchestrate import _allowed_source, _check_redirect, _resolve_url, _TTS_TIMEOUT
from app.workflows.model_profiles import AR_VIDEO, aspect_guard
from app.services import longcat as longcat_service
from app.services import video_generators as vgen
from app.services.duration import DurationLimitError, DurationPlan, resolve_duration
from app.workflows.longcat_avatar import (
    DEFAULT_NEGATIVE,
    LongCatAvatarParams,
    build_longcat_avatar_graph,
)

router = APIRouter()


class AvatarTalkRequest(BaseModel):
    """LongCat-Avatar 数字人请求:image/audio 为上传句柄文件名,worker 为上传落点
    (防 SSRF,两者须在同一 worker)。宽/高非 16 对齐时向下取整(同 longcat_studio)。

    驱动源二选一(互斥,都给或都不给 → 400):
    · audio:上传句柄音频文件名(现有路径,经源 worker 转运到实例)
    · drive_text:驱动文本(≤2000 字),先经 IndexTTS 合成 wav 再上传实例驱动;
      voice 为音色克隆参考音 URL(空=引擎默认音色),speed 透传 duration_factor

    时长:优先 duration_sec(秒,任意值;4k+1 网格吸附后秒差大时生成后精确裁切);
    num_frames(帧数)为 deprecated 兼容入参,与 duration_sec 同给时忽略。
    """
    image: str = Field(min_length=1, max_length=512)
    audio: str | None = Field(default=None, max_length=512)
    worker: str
    positive: str = Field(min_length=1, max_length=4000)
    # TTS 直通(与 audio 互斥):文本 → IndexTTS → 驱动音频
    drive_text: str | None = Field(default=None, max_length=2000)
    voice: str = Field(default="", max_length=2000)  # 音色参考音 URL,空=默认音色
    speed: float = Field(default=1.0, ge=0.5, le=2.0)  # 透传 IndexTTS duration_factor
    negative: str = Field(default=DEFAULT_NEGATIVE, max_length=2000)
    width: int = Field(default=480, ge=320, le=1280)
    height: int = Field(default=832, ge=320, le=1280)
    duration_sec: float | None = Field(default=None, gt=0, le=600)
    # deprecated:兼容入参,请改用 duration_sec;同给时忽略
    num_frames: int | None = Field(default=None, ge=17, le=2500)
    fps: int = Field(default=25, ge=8, le=30)
    steps: int = Field(default=12, ge=1, le=50)
    shift: float = Field(default=12.0, ge=1.0, le=30.0)
    cfg: float = Field(default=1.0, ge=0.0, le=10.0)
    dmd_lora_strength: float = Field(default=1.0, ge=0.0, le=2.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)

    @field_validator("width", "height")
    @classmethod
    def _snap16(cls, v: int) -> int:
        return v // 16 * 16

    # 宽高比守卫:9:16~16:9 静默归一(训练分布;极端比例出主体被裁/文字溢出)
    _ratio = aspect_guard(*AR_VIDEO, align=16, min_v=320, max_v=1280)

    @field_validator("image", "audio")
    @classmethod
    def _no_traversal(cls, v: str | None) -> str | None:
        if v is None:
            return v
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name


# 旧默认时长:93 帧@25fps=3.72s → 3.7s(4k+1 网格吸附回 93 帧,与历史默认一致)
_DEFAULT_SECONDS = 3.7


async def _synth_drive_audio(text: str, voice: str, speed: float) -> bytes:
    """drive_text → IndexTTS wav 字节(与音频编排 _synth_tts 同构的 IndexTTS 调用:
    form 表单 POST {tts_url}/tts;voice 作音色克隆参考音,SSRF 白名单同源复用;
    speed≠1.0 时透传 duration_factor,1.0 不带字段走引擎默认语速)。

    失败语义:服务不可达/合成失败/返回非音频一律 502,参考音来源非法 400 —
    本函数在一切 worker 写入之前调用,失败不会在实例上留半成品。
    """
    tts_target = get_settings().tts_url.strip().rstrip("/")
    data: dict[str, str] = {"text": text}
    if speed != 1.0:
        data["duration_factor"] = str(speed)
    async with httpx.AsyncClient(
        timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False
    ) as client:
        files = None
        if voice:
            if not _allowed_source(voice):
                raise HTTPException(status_code=400, detail="音色参考音来源不在白名单内")
            voice_resolved = _resolve_url(voice)
            try:
                rr = await client.get(voice_resolved)
                _check_redirect(rr, voice_resolved)
                rr.raise_for_status()
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"音色参考音下载失败:{e}") from e
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


async def _upload_drive_audio(client: ComfyUIClient, wav: bytes) -> str:
    """TTS wav 上传到 LongCat 实例 input 目录(与用户上传音频同一落点机制:
    ComfyUI /upload/image 接受任意文件,LoadAudio 从 input 目录读取)。"""
    name = f"toiv-tts-{uuid.uuid4().hex}.wav"
    try:
        return await client.upload_image(wav, name)
    except ComfyUIError as e:
        raise HTTPException(
            status_code=502, detail=f"TTS 音频上传到 LongCat 实例失败: {e}"
        ) from e


def _resolve_plan(req: AvatarTalkRequest) -> DurationPlan:
    """秒数 → 时长计划(统一策略层);legacy num_frames 换算为等价 direct 计划(行为不变)。"""
    if req.duration_sec is None and req.num_frames is not None:
        return DurationPlan(
            engine="avatar", seconds=req.num_frames / req.fps, fps=req.fps,
            frames=req.num_frames, segment_frames=(req.num_frames,),
        )
    try:
        return resolve_duration(
            "avatar",
            req.duration_sec if req.duration_sec is not None else _DEFAULT_SECONDS,
            req.fps,
        )
    except DurationLimitError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


@router.post("/avatar/talk")
async def generate_avatar_talk(
    req: AvatarTalkRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LongCat-Avatar 数字人说话视频。实例不可达/缺 WanVideo 节点 → 503(同 longcat)。

    驱动源二选一:audio(上传句柄)或 drive_text(TTS 直通);都给/都不给 → 400。
    drive_text 路径先合成 wav(TTS 失败 502 不半提交),再走与现有音频完全一致的
    实例上传 → 建图 → submit 链路(NSFW 门控/hold 排队/资源预检零绕行)。
    """
    has_audio = bool(req.audio and req.audio.strip())
    has_text = bool(req.drive_text and req.drive_text.strip())
    if has_audio == has_text:
        raise HTTPException(
            status_code=400,
            detail="驱动源必须二选一:audio(上传音频)与 drive_text(文本合成)"
            "不能同时提供,也不能都不提供",
        )
    enforce_generation_rate_limit(user)
    plan = _resolve_plan(req)
    client = longcat_service.get_longcat_client()
    source = resolve_worker(req.worker)
    drive_wav: bytes | None = None
    if has_text:
        # 先合成再动 worker:TTS 不可达/失败直接 502,实例侧零写入
        drive_wav = await _synth_drive_audio(
            req.drive_text.strip(), req.voice.strip(), req.speed
        )
    image_name = await longcat_service.transfer_ref_image(client, source, req.image)
    if drive_wav is not None:
        audio_name = await _upload_drive_audio(client, drive_wav)
    else:
        audio_name = await longcat_service.transfer_ref_audio(client, source, req.audio)
    params = LongCatAvatarParams(
        positive=req.positive,
        negative=req.negative,
        image=image_name,
        audio=audio_name,
        width=req.width,
        height=req.height,
        num_frames=plan.frames,
        fps=req.fps,
        steps=req.steps,
        shift=req.shift,
        cfg=req.cfg,
        dmd_lora_strength=req.dmd_lora_strength,
        **({"seed": req.seed} if req.seed is not None else {}),
    )
    graph = build_longcat_avatar_graph(params)
    result = await longcat_service.submit_longcat_job(
        graph, kind="avatar_talk", positive=params.positive, seed=params.seed,
        req=req, user=user, session=session, client=client,
        # R18 上下文(X-NSFW 头)打标进 /nsfw 专区作品库;nsfw_allowed 含未成年硬阻断,
        # 与 longcat_studio 同一判定来源,主站(无头)恒 False 行为不变
        nsfw=nsfw_allowed(user),
    )
    if plan.strategy != "direct":
        vgen.spawn_duration_chain(
            client=client,
            plan=plan,
            first_prompt_id=result["prompt_id"],
        )
    if plan.notice:
        result["duration_notice"] = plan.notice
    return result
