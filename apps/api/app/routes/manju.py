"""漫剧工作室路由。

- POST /api/manju/storyboard —— M1:把剧情用 LLM 拆成结构化分镜。
  入参剧情(premise)+ 镜数 + 风格 + 角色,产出 shots[]:每镜含英文出图提示词
  (适合 SD/anime)、出场角色、运镜、中文台词、时长。前端据此渲染分镜板并逐镜出图。
  复用 optimize.py 的健壮 JSON 解析(容忍 ```json 代码块/前后缀)。

- POST /api/manju/shot —— M2:用 IPAdapter 出单镜图,使其与角色参考图保持一致。
  带 character_ref(已上传到 worker 的角色参考图)时走 IPAdapter 工作流;无参考图
  时优雅降级为普通 txt2img。沿用现有 pool/resolve_worker + Job 建档 + spawn_tracker。

沿用现有鉴权与限流。
"""
from __future__ import annotations

import json
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.agent import llm
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.workflows.ipadapter import (
    DEFAULT_PRESET,
    IPAdapterTxt2ImgParams,
    build_ipadapter_txt2img_graph,
)
from app.workflows.model_profiles import fit_resolution
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

router = APIRouter()

_STORYBOARD_SYSTEM = (
    "你是漫剧(动画短剧)导演 + 分镜师。把用户给的剧情拆解成连贯的分镜脚本。\n"
    "对每一个镜头(shot)给出:\n"
    "- scene:该镜的场景/地点简述(中文);\n"
    "- description:一句结构化、画面感强的【英文】出图提示词,适合 Stable Diffusion / "
    "anime 风格(含主体、动作、构图、光影、画质词如 highly detailed, anime style),"
    "若提供了 style 请融入其中,若该镜有角色出场请在提示词里体现其外貌特征;\n"
    "- characters:该镜出场角色名字数组(只用 characters 列表里给定的名字,没有则空数组);\n"
    "- camera:运镜方式(中文,如 缓慢推进 / 特写 / 全景 / 跟随 / 摇镜 / 仰拍);\n"
    "- dialogue:该镜的【中文】台词或旁白(没有则空字符串);\n"
    "- duration_sec:该镜建议时长(秒,整数,通常 2-6)。\n"
    "镜头数量严格等于用户要求的数量。\n"
    '只输出 JSON,形如 {"shots":[{"scene":"...","description":"...","characters":["..."],'
    '"camera":"...","dialogue":"...","duration_sec":3}, ...]},'
    "不要解释,不要代码块标记。"
)


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    desc: str = Field(default="", max_length=500)


class StoryboardRequest(BaseModel):
    # 支持喂完整剧本(一集 ~1-2 万字),不止短梗概
    premise: str = Field(min_length=1, max_length=20000)
    num_shots: int = Field(default=6, ge=1, le=60)
    style: str | None = Field(default=None, max_length=300)
    characters: list[CharacterIn] = Field(default_factory=list)


class Shot(BaseModel):
    id: str
    scene: str
    description: str
    characters: list[str] = Field(default_factory=list)
    camera: str = ""
    dialogue: str = ""
    duration_sec: int = 3


class StoryboardResponse(BaseModel):
    shots: list[Shot]


def _parse_json_obj(text: str) -> dict | None:
    """从 LLM 文本里稳健地抽出 JSON 对象(容忍代码块/前后缀)。"""
    t = text.strip()
    if "{" in t and "}" in t:
        t = t[t.index("{") : t.rindex("}") + 1]
    try:
        obj = json.loads(t)
        return obj if isinstance(obj, dict) else None
    except (ValueError, TypeError):
        return None


def _build_user_prompt(body: StoryboardRequest) -> str:
    lines = [f"剧情:{body.premise}", f"镜头数量:{body.num_shots}"]
    if body.style:
        lines.append(f"整体画风:{body.style}")
    if body.characters:
        roster = "; ".join(
            f"{c.name}({c.desc})" if c.desc else c.name for c in body.characters
        )
        lines.append(f"出场角色:{roster}")
    return "\n".join(lines)


def _coerce_shot(raw: object, index: int) -> Shot:
    """把 LLM 返回的单个镜头对象规整成 Shot(字段缺失/类型不符时回退到安全默认)。"""
    obj = raw if isinstance(raw, dict) else {}
    chars_raw = obj.get("characters")
    characters = (
        [str(c).strip() for c in chars_raw if str(c).strip()]
        if isinstance(chars_raw, list)
        else []
    )
    try:
        duration = int(obj.get("duration_sec") or 3)
    except (ValueError, TypeError):
        duration = 3
    duration = max(1, min(duration, 30))
    return Shot(
        id=f"shot-{index + 1}",
        scene=str(obj.get("scene") or "").strip(),
        description=str(obj.get("description") or "").strip(),
        characters=characters,
        camera=str(obj.get("camera") or "").strip(),
        dialogue=str(obj.get("dialogue") or "").strip(),
        duration_sec=duration,
    )


@router.post("/manju/storyboard", response_model=StoryboardResponse)
async def generate_storyboard(
    body: StoryboardRequest,
    user: User = Depends(get_current_user),
) -> StoryboardResponse:
    enforce_generation_rate_limit(user)

    try:
        msg = await llm.chat(
            [
                {"role": "system", "content": _STORYBOARD_SYSTEM},
                {"role": "user", "content": _build_user_prompt(body)},
            ]
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    raw = (msg.get("content") or "").strip()
    obj = _parse_json_obj(raw)
    shots_raw = obj.get("shots") if obj else None
    if not isinstance(shots_raw, list) or not shots_raw:
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")

    shots = [
        _coerce_shot(s, i)
        for i, s in enumerate(shots_raw[: body.num_shots])
    ]
    # 至少要有可出图的描述,否则视为失败
    if not any(s.description for s in shots):
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")
    return StoryboardResponse(shots=shots)


# ---------------------------------------------------------------------------
# M2:单镜出图(IPAdapter 角色一致性,无参考图时降级 txt2img)
# ---------------------------------------------------------------------------


def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数(与 generate 路由一致)。"""
    return max(8, v - v % 8)


class ShotRenderRequest(BaseModel):
    """单镜出图请求。

    character_ref:已上传到 worker 的角色参考图文件名。给定时走 IPAdapter 保持人物
    一致;为空(None/空串)时优雅降级为普通 txt2img(同分镜不带参考的常规出图)。
    worker:角色参考图所在的 worker(白名单内);校验后只路由到该机,避免缺图。
    """

    positive: str = Field(min_length=1, max_length=2000)
    worker: str = Field(min_length=1, max_length=512)
    character_ref: str | None = Field(default=None, max_length=512)
    negative: str = Field(default="", max_length=2000)
    ckpt_name: str | None = None
    preset: str = Field(default=DEFAULT_PRESET, max_length=64)
    weight: float = Field(default=0.8, ge=0.0, le=2.0)
    weight_type: str = Field(default="linear", max_length=64)
    start_at: float = Field(default=0.0, ge=0.0, le=1.0)
    end_at: float = Field(default=1.0, ge=0.0, le=1.0)
    width: int = Field(default=512, ge=64, le=2048)
    height: int = Field(default=512, ge=64, le=2048)
    steps: int = Field(default=20, ge=1, le=150)
    cfg: float = Field(default=7.0, ge=0.0, le=30.0)
    sampler: str = Field(default="euler", max_length=64)
    scheduler: str = Field(default="normal", max_length=64)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


def _build_shot_graph(req: ShotRenderRequest, ckpt_name: str) -> tuple[dict, str]:
    """据请求选用 IPAdapter 或 txt2img 构图。返回 (graph, mode)。

    mode 用于 Job.kind 与响应,便于前端/历史区分该镜是否启用了角色一致性。
    无 character_ref(空/None)→ txt2img 降级;有 → IPAdapter。
    """
    ref = (req.character_ref or "").strip()
    # 前端宽高仅定宽高比;按底模架构(SDXL/SD1.5)缩放到合适像素档,避免分辨率失配崩坏。
    width, height = fit_resolution(ckpt_name, _snap8(req.width), _snap8(req.height))
    seed_kw = {"seed": req.seed} if req.seed is not None else {}
    if not ref:
        params = Txt2ImgParams(
            positive=req.positive,
            negative=req.negative,
            ckpt_name=ckpt_name,
            width=width,
            height=height,
            steps=req.steps,
            cfg=req.cfg,
            sampler=req.sampler,
            scheduler=req.scheduler,
            filename_prefix="ToIV_shot",
            **seed_kw,
        )
        return build_txt2img_graph(params), "manju_shot_txt2img"
    ipa_params = IPAdapterTxt2ImgParams(
        positive=req.positive,
        ref_image=ref,
        negative=req.negative,
        ckpt_name=ckpt_name,
        preset=req.preset,
        weight=req.weight,
        weight_type=req.weight_type,
        start_at=req.start_at,
        end_at=req.end_at,
        width=width,
        height=height,
        steps=req.steps,
        cfg=req.cfg,
        sampler=req.sampler,
        scheduler=req.scheduler,
        filename_prefix="ToIV_shot",
        **seed_kw,
    )
    return build_ipadapter_txt2img_graph(ipa_params), "manju_shot_ipadapter"


@router.post("/manju/shot")
async def render_shot(
    req: ShotRenderRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """漫剧 M2:用同一角色参考图出该镜图,使人物在各镜间保持一致。

    带 character_ref 时走 IPAdapter(参考图须先上传到所选 worker);无参考图时降级为
    普通 txt2img。沿用 resolve_worker(白名单防 SSRF)+ Job 建档 + spawn_tracker。
    """
    enforce_generation_rate_limit(user)
    settings = get_settings()
    ckpt_name = req.ckpt_name or settings.default_ckpt
    # 参考图所在的 worker(白名单校验);IPAdapter 与 txt2img 都固定提交到该机
    client = resolve_worker(req.worker)
    graph, kind = _build_shot_graph(req, ckpt_name)

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    seed = graph["3"]["inputs"]["seed"]
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind=kind,
            status="queued",
            prompt=req.positive,
            seed=seed,
        )
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端是否连 SSE
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
        "mode": kind,
    }
