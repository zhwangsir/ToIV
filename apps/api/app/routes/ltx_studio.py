"""LTX-2.3 工作室 —— LTX 视频生成独立板块(SFW 为主,可选 NSFW 底模)。

GET  /api/ltx2/models —— 板块可用资产清单(白名单底模 + loras/ltx2.3/ LoRA,带 worker 可用性)
POST /api/ltx2/t2v    —— 文生视频(底模白名单 + LoRA 叠加,最多 3 个)
POST /api/ltx2/i2v    —— 图生视频(同上 + image/worker)
POST /api/ltx2/lipdub —— 视频重配音对口型(IC-LoRA 链路,video/audio 文件名 + worker)

与 NSFW 专区(/api/generate/ltx-*)的区别:
- 底模白名单可选:distilled/dev(SFW)无门槛;10eros(NSFW)仍走 _gate_ltx_nsfw
- 支持 LoRA 叠加:图中在 UNET 之后、采样之前注入 LoraLoader 链(txt2img 同款模式)
- Job kind 独立(ltx2_t2v / ltx2_i2v / ltx2_lipdub),按所选底模打 nsfw 标(10eros → True)
"""
from __future__ import annotations

import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session

from app.capabilities import required_nodes
from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.video import _gate_ltx_nsfw, _raise_from_comfy_error
from app.versioning import params_snapshot
from app.workflows.lora import LoraSpec
from app.workflows.ltx_video import (
    LtxI2VParams,
    LtxLipdubParams,
    LtxT2VParams,
    build_ltx_i2v_graph,
    build_ltx_lipdub_graph,
    build_ltx_t2v_graph,
)

router = APIRouter()

# ── 板块资产白名单 ──────────────────────────────────────────────
# 底模候选:(文件名, 是否 NSFW)。NSFW 底模触发 X-NSFW 门槛并把 Job 打 nsfw 标。
_LTX2_UNETS: tuple[tuple[str, bool], ...] = (
    ("ltx-2.3-22b-distilled-1.1.safetensors", False),
    ("ltx-2.3-22b-dev.safetensors", False),
    ("10eros_v14.safetensors", True),
)
_UNET_WHITELIST = {name for name, _ in _LTX2_UNETS}
_NSFW_UNETS = {name for name, nsfw in _LTX2_UNETS if nsfw}

# LoRA 沙箱:仅允许 loras/ltx2.3/ 子目录(camera / IC-LoRA / 风格),防路径穿越
_LORA_DIR_PREFIX = "ltx2.3/"
_MAX_LORAS = 3


# ──────────────────────────────────────────────────────────────
# GET /api/ltx2/models —— 资产清单(探测 worker 实际持有)
# ──────────────────────────────────────────────────────────────

@router.get("/ltx2/models")
async def list_ltx2_models(
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """板块可用资产:白名单底模标 available;loras/ltx2.3/ 目录 LoRA 按 worker 枚举列出。

    单个 worker 不可达时跳过(其余 worker 的并集仍给出),不因此 5xx。
    """
    available: set[str] = set()
    for client in pool.clients:
        try:
            available |= await client.model_names()
        except ComfyUIError:
            continue
    settings = get_settings()
    return {
        "unets": [
            {"name": name, "nsfw": nsfw, "available": name in available}
            for name, nsfw in _LTX2_UNETS
        ],
        # 来自 worker 枚举即可见即可用;过滤子目录前缀 + 防穿越
        "loras": [
            {"name": name, "available": True}
            for name in sorted(available)
            if name.startswith(_LORA_DIR_PREFIX) and ".." not in name
        ],
        "gemma": settings.nsfw_default_gemma,
        "vae": settings.nsfw_default_vae,
    }


# ──────────────────────────────────────────────────────────────
# 请求模型
# ──────────────────────────────────────────────────────────────

class Ltx2LoraInput(BaseModel):
    """单个叠加 LoRA:限 loras/ltx2.3/ 目录(沙箱),强度 0-2。"""
    name: str = Field(min_length=1, max_length=512)
    strength: float = Field(default=1.0, ge=0.0, le=2.0)

    @field_validator("name")
    @classmethod
    def _sandbox(cls, v: str) -> str:
        name = v.strip().replace("\\", "/")
        if ".." in name or not name.startswith(_LORA_DIR_PREFIX):
            raise ValueError(f"LoRA 仅限 loras/{_LORA_DIR_PREFIX} 目录")
        return name


class Ltx2T2VRequest(BaseModel):
    """LTX-2.3 工作室文生视频请求。"""
    positive: str = Field(min_length=1, max_length=2000)
    negative: str = Field(default="", max_length=2000)
    unet_name: str = Field(default="ltx-2.3-22b-distilled-1.1.safetensors")
    loras: list[Ltx2LoraInput] = Field(default_factory=list, max_length=_MAX_LORAS)
    width: int = Field(default=768, ge=256, le=1920)
    height: int = Field(default=384, ge=256, le=1080)
    length: int = Field(default=97, ge=9, le=241)
    fps: int = Field(default=16, ge=4, le=30)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    use_upscale: bool = False
    use_rife: bool = False

    @field_validator("unet_name")
    @classmethod
    def _whitelist(cls, v: str) -> str:
        if v not in _UNET_WHITELIST:
            raise ValueError(f"未知底模: {v}(限白名单 {sorted(_UNET_WHITELIST)})")
        return v


class Ltx2I2VRequest(Ltx2T2VRequest):
    """LTX-2.3 工作室图生视频请求。"""
    image: str = Field(min_length=1, max_length=512)
    worker: str  # 图片所在 worker(防 SSRF)


class Ltx2LipdubRequest(BaseModel):
    """LTX-2.3 工作室 LipDub 请求(视频重配音对口型,IC-LoRA 链路)。"""
    video: str = Field(min_length=1, max_length=512)  # worker input 目录中的视频文件名
    worker: str  # 视频/音频所在 worker(防 SSRF)
    audio: str | None = Field(default=None, max_length=512)  # 嗓音参考音频;空=用原视频音轨
    positive: str = Field(min_length=1, max_length=4000)  # 场景描述 + 新台词(原生文字)
    negative: str = Field(default="", max_length=2000)
    width: int = Field(default=960, ge=256, le=1920)
    height: int = Field(default=544, ge=256, le=1088)
    length: int = Field(default=121, ge=9, le=241)  # 输出帧数,必须 8k+1 且 ≤ 视频帧数
    steps: int = Field(default=8, ge=1, le=50)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    lipdub_lora_strength: float = Field(default=1.0, ge=0.0, le=2.0)
    two_stage: bool = False  # 预留:True 追加官方二阶段(latent 2× 上采样精修)

    @field_validator("video", "audio")
    @classmethod
    def _no_traversal(cls, v: str | None) -> str | None:
        if v is None:
            return v
        name = v.strip().replace("\\", "/")
        if ".." in name or name.startswith("/"):
            raise ValueError("文件名不允许路径穿越")
        return name

    @field_validator("length")
    @classmethod
    def _frames_mod8(cls, v: int) -> int:
        if (v - 1) % 8 != 0:
            raise ValueError("length 必须为 8k+1(LTX 帧数约束)")
        return v


# ──────────────────────────────────────────────────────────────
# POST /api/ltx2/t2v | /api/ltx2/i2v
# ──────────────────────────────────────────────────────────────

@router.post("/ltx2/t2v")
async def generate_ltx2_t2v(
    req: Ltx2T2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """LTX-2.3 工作室文生视频。SFW 底模无门槛;选 10eros 走 NSFW 门槛。"""
    enforce_generation_rate_limit(user)
    if req.unet_name in _NSFW_UNETS:
        _gate_ltx_nsfw(user)

    settings = get_settings()
    params = LtxT2VParams(
        positive=req.positive,
        negative=req.negative,
        unet_name=req.unet_name,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxT2VParams(positive="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
        loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras),
        filename_prefix="ToIV_ltx2_vid",
    )
    graph = build_ltx_t2v_graph(params)
    return await _submit_ltx2_job(graph, params, req, "ltx2_t2v", user, session, pool)


@router.post("/ltx2/i2v")
async def generate_ltx2_i2v(
    req: Ltx2I2VRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """LTX-2.3 工作室图生视频。图片先经 /api/upload 上传,带 filename + worker 调本端点。"""
    enforce_generation_rate_limit(user)
    if req.unet_name in _NSFW_UNETS:
        _gate_ltx_nsfw(user)

    settings = get_settings()
    client = resolve_worker(req.worker)
    params = LtxI2VParams(
        positive=req.positive,
        image=req.image,
        negative=req.negative,
        unet_name=req.unet_name,
        gemma_name=settings.nsfw_default_gemma,
        vae_name=settings.nsfw_default_vae,
        width=req.width,
        height=req.height,
        length=req.length,
        fps=req.fps,
        steps=req.steps,
        cfg=req.cfg,
        seed=req.seed if req.seed is not None else LtxI2VParams(positive="", image="").seed,
        use_upscale=req.use_upscale,
        use_rife=req.use_rife,
        loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras),
        filename_prefix="ToIV_ltx2_vid",
    )
    graph = build_ltx_i2v_graph(params)
    return await _submit_ltx2_job(graph, params, req, "ltx2_i2v", user, session, pool, client=client)


# ──────────────────────────────────────────────────────────────
# POST /api/ltx2/lipdub —— 视频重配音对口型(IC-LoRA)
# ──────────────────────────────────────────────────────────────

@router.post("/ltx2/lipdub")
async def generate_ltx2_lipdub(
    req: Ltx2LipdubRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool: WorkerPool = Depends(get_pool),
):
    """LTX-2.3 工作室 LipDub(视频重配音对口型)。

    素材准备(v1):video/audio 须已在目标 worker 的 input 目录——可用 worker 原生
    POST /upload/image(multipart 字段 image,接受 mp4/wav)或 ToIV POST /api/upload
    (kind=ltx_lipdub&worker=<url>)上传后引用文件名。
    positive 须含新台词(目标语言原生文字),模型按提示词生成新口型与新语音;
    audio 仅作嗓音参考(缺省用原视频音轨)。台词长度与原片台词相近效果最佳。
    """
    enforce_generation_rate_limit(user)

    client = resolve_worker(req.worker)
    params = LtxLipdubParams(
        positive=req.positive,
        video=req.video,
        audio=req.audio or "",
        negative=req.negative,
        lipdub_lora_strength=req.lipdub_lora_strength,
        width=req.width,
        height=req.height,
        length=req.length,
        steps=req.steps,
        seed=req.seed if req.seed is not None else LtxLipdubParams(positive="", video="").seed,
        two_stage=req.two_stage,
    )
    graph = build_ltx_lipdub_graph(params)
    model_set = {params.ckpt_name, params.gemma_name, params.lipdub_lora}
    node_set = required_nodes("ltx_lipdub")
    if params.two_stage:
        model_set.add(params.upscale_model)
        node_set = node_set | {"LatentUpscaleModelLoader", "LTXVLatentUpsampler"}
    return await _submit_ltx2_job(
        graph, params, req, "ltx2_lipdub", user, session, pool,
        client=client, model_set=model_set, node_set=node_set, nsfw=False,
    )


async def _submit_ltx2_job(
    graph: dict,
    params: LtxT2VParams | LtxI2VParams | LtxLipdubParams,
    req: Ltx2T2VRequest | Ltx2LipdubRequest,
    kind: str,
    user: User,
    session: Session,
    pool: WorkerPool,
    client: ComfyUIClient | None = None,
    model_set: set[str] | None = None,
    node_set: set[str] | None = None,
    nsfw: bool | None = None,
):
    """提交 LTX2 工作室作业:pool.pick(含 LoRA 模型要求)→ queue_prompt → 落 Job → 后台追踪。

    client=None(t2v)时按所需模型/节点选 worker;i2v/lipdub 由素材所在 worker 指定,
    此时校验该 worker 持有全部所需模型(缺则 503,避免 ComfyUI 执行期 400)。
    lipdub 的资产体系与 t2v/i2v 不同(22B checkpoint + IC-LoRA),由调用方显式传入
    model_set/node_set/nsfw;缺省保持 t2v/i2v 原有推导逻辑不变。
    """
    if model_set is None:
        model_set = {params.unet_name, params.gemma_name, params.vae_name}
        model_set |= {lora.name for lora in params.loras}
        if params.use_upscale:
            model_set.add(params.upscale_model)
    if node_set is None:
        node_set = required_nodes("ltx_i2v" if kind == "ltx2_i2v" else "ltx_t2v")
        if params.loras:
            node_set = node_set | {"LoraLoader"}
    if nsfw is None:
        nsfw = params.unet_name in _NSFW_UNETS

    if client is None:
        try:
            client = await pool.pick(required=model_set, required_nodes=node_set)
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=f"无可用 worker(缺 LTX 模型或节点): {e}") from e
    else:
        try:
            owned = await client.model_names()
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=f"素材所在 worker 不可达: {e}") from e
        missing = sorted(model_set - owned)
        if missing:
            raise HTTPException(
                status_code=503, detail=f"素材所在 worker 缺少模型: {', '.join(missing)}"
            )

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        _raise_from_comfy_error(e)

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind=kind,
            status="queued",
            prompt=params.positive,
            seed=params.seed,
            nsfw=nsfw,
            params=params_snapshot(req, seed=params.seed),
        )
    )
    session.commit()

    # 启动服务端后台追踪:前端 SSE 断开后仍可把结果落库,避免"一直生成中"
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
    }
