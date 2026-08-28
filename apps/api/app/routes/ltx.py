"""LTX-2.5 Multishot 一键多镜头 —— 新一代一键分镜(云端「AI 导演」的本地化)。

POST /api/ltx/multishot —— 单次采样产出多镜头音画视频(2-4 镜,单产物,
角色/环境/光线/嗓音跨切一致,一致性由 LTX-2.5 模型原生保证)。

与现有多镜头方案的定位区分:
- H3 multishot 协议(/api/h3/multishot):单 prompt 切镜协议,H3 引擎多段生成;
- 关键帧转场链:多段独立生成 + 首尾帧转场拼接;
- 本端点:LTX-2.5 原生 multishot,单 prompt 分镜一次出片,音画同出,
  落地 pc01(RTX 5090,ComfyUI 0.32+ 原生节点,NVFP4 蒸馏 transformer)。
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator, model_validator
from sqlmodel import Session

from app.capabilities import required_nodes
from app.comfy.client import ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.video import _raise_from_comfy_error
from app.versioning import params_snapshot
from app.workflows.ltx_multishot import (
    DEFAULT_LTX25_NEGATIVE,
    MAX_TOTAL_SECONDS,
    LtxMultishotParams,
    LtxShot,
    build_ltx_multishot_graph,
    compose_multishot_prompt,
    total_seconds,
    validate_multishot,
)

router = APIRouter()


class LtxShotIn(BaseModel):
    """单镜头:分镜描述(建议含景别/动作,并重复跨镜一致的角色识别细节)+ 时长秒。"""

    prompt: str = Field(min_length=1, max_length=800)
    seconds: int = Field(default=4, ge=1, le=10)


class LtxMultishotRequest(BaseModel):
    """LTX-2.5 Multishot 请求。"""

    shots: list[LtxShotIn] = Field(min_length=2, max_length=4)
    global_style: str = Field(default="", max_length=600)
    negative: str = Field(default=DEFAULT_LTX25_NEGATIVE, max_length=1000)
    width: int = Field(default=1280, ge=512, le=1920)
    height: int = Field(default=720, ge=512, le=1088)
    fps: int = Field(default=24, ge=16, le=50)
    audio: bool = True
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    worker: str | None = Field(default=None, max_length=200)  # 缺省 settings.ltx25_worker

    @field_validator("shots", mode="before")
    @classmethod
    def _shots_from_text(cls, v):
        """前端文本域兼容:每行一镜「镜头描述|秒数」;结构化列表原样通过。"""
        if isinstance(v, str):
            out = []
            for line in v.strip().splitlines():
                line = line.strip()
                if not line:
                    continue
                prompt, _, sec = line.rpartition("|")
                if not sec.strip().isdigit():
                    prompt, sec = line, "4"  # 无秒数默认 4s
                out.append({"prompt": prompt.strip(), "seconds": int(sec.strip() or 4)})
            return out
        return v

    @field_validator("width", "height")
    @classmethod
    def _mult16(cls, v: int) -> int:
        if v % 16:
            raise ValueError("width/height 须为 16 倍数(两阶段采样)")
        return v

    @model_validator(mode="after")
    def _frame_grid(self) -> "LtxMultishotRequest":
        secs = sum(s.seconds for s in self.shots)
        if secs > MAX_TOTAL_SECONDS:
            raise ValueError(f"总时长 {secs}s 超上限 {MAX_TOTAL_SECONDS}s")
        if (secs * self.fps) % 8 != 0:
            raise ValueError(f"fps({self.fps}) × 总时长({secs}s) 不满足 8n+1 帧网格")
        return self


@router.post("/ltx/multishot")
async def generate_ltx_multishot(
    req: LtxMultishotRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """LTX-2.5 一键多镜头:单产物多镜头 + 原生音轨,跨镜角色/光线/嗓音一致。"""
    enforce_generation_rate_limit(user)
    settings = get_settings()

    shots = tuple(LtxShot(prompt=s.prompt, seconds=s.seconds) for s in req.shots)
    params = LtxMultishotParams(
        shots=shots,
        global_style=req.global_style,
        negative=req.negative,
        width=req.width,
        height=req.height,
        fps=req.fps,
        audio=req.audio,
        seed=req.seed if req.seed is not None else LtxMultishotParams(shots=()).seed,
    )
    try:
        validate_multishot(params)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    graph = build_ltx_multishot_graph(params)

    # 白名单防 SSRF:仅允许配置过的 worker(pool 成员 :8188 精确匹配命中)
    client = resolve_worker((req.worker or settings.ltx25_worker).strip())

    # 模型/节点双校验:缺则 503(避免 ComfyUI 执行期 400 黑盒)。
    # audio_vae 无条件必需:audio=False 仅跳过解码挂轨,采样链仍加载音频 VAE
    # (LTXVEmptyLatentAudio 接 VAELoader,音画联合 transformer 架构约束)。
    model_set = {
        params.unet_name,
        params.gemma_name,
        params.video_vae_name,
        params.audio_vae_name,
        params.upscaler_name,
    }
    try:
        owned = await client.model_names()
        owned_nodes = await client.node_names()
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=f"LTX-2.5 worker 不可达: {e}") from e
    missing = sorted(model_set - owned)
    if missing:
        raise HTTPException(
            status_code=503, detail=f"worker 缺少 LTX-2.5 模型: {', '.join(missing)}"
        )
    missing_nodes = sorted(required_nodes("ltx_multishot") - owned_nodes)
    if missing_nodes:
        raise HTTPException(
            status_code=503,
            detail=f"worker 缺少 LTX-2.5 节点(需 ComfyUI 0.32+ 原生支持): {', '.join(missing_nodes)}",
        )

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        _raise_from_comfy_error(e)

    prompt_text = compose_multishot_prompt(shots, req.global_style)
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind="ltx_multishot",
            status="queued",
            prompt=prompt_text,
            seed=params.seed,
            nsfw=False,
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()

    # 服务端后台追踪:前端 SSE 断开后产物仍落库
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
        "shots": len(shots),
        "seconds": total_seconds(shots),
        "audio": params.audio,
    }
