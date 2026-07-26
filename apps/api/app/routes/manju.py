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
from app.quality.gateway import run_quality_checks
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import Job, User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.generate import _gate_nsfw_ckpt
from app.versioning import params_snapshot
from app.workflows.ipadapter import (
    DEFAULT_PRESET,
    IPAdapterTxt2ImgParams,
    build_ipadapter_txt2img_graph,
)
from app.workflows.model_profiles import (
    fit_resolution,
    is_nextgen,
    nextgen_recipe,
    profile_for,
)
from app.workflows.nextgen import NextgenParams, build_nextgen_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

router = APIRouter()

# 单镜 IPAdapter 出图所需自定义节点;参考图分发全 pool 后据此只选装了它们的 worker。
_IPADAPTER_NODES = {"IPAdapterUnifiedLoader", "IPAdapterAdvanced"}

_STORYBOARD_SYSTEM = (
    "你是漫剧(动画短剧)导演 + 分镜师。把用户给的剧情拆解成连贯的分镜脚本。\n"
    "\n"
    "【出图提示词铁律 —— 直接决定画面质量,违反会让出图崩成碎片拼贴,务必严守】\n"
    "1. 每个镜头只表现【一个清晰的瞬间、一个主体焦点】。**绝对禁止** montage / 蒙太奇 / "
    "拼贴 / 分屏 / split screen / collage / 多格 / various scenes / multiple panels,"
    "也**绝不**在一张图里塞多个不同动作或多个角色各做各的事——单张图画不下,只会崩成碎片。\n"
    "2. 多人物的剧情场景,**只聚焦 1-2 个主要角色的单一动作**(例:与其写 "
    "'A打人、B挨打、C躲藏',只写 'A一拳打向对手' 这一个焦点)。\n"
    "3. description 必须是【danbooru 标签风格】——逗号分隔的英文标签,**不是句子**,"
    "适配 anime SDXL 模型(它的母语是标签):"
    "`主体(1boy/1girl/2boys等) + 外貌服装 + 单一动作姿势 + 表情 + 场景地点 + 光影 + "
    "画质标签(masterpiece, best quality, very aesthetic, absurdres, highly detailed)`。\n"
    "4. **禁用**会被模型误解成拼贴/乱构图的词:dynamic angles、fight montage、"
    "multiple、several、various、collage、abstract。构图用单一明确的:close-up / "
    "upper body / full body / from side / wide shot 之一。\n"
    "5. 角色出场时用其固定外貌特征标签(发色/瞳色/服装)保持跨镜一致。\n"
    "\n"
    "对每一个镜头(shot)给出:\n"
    "- scene:该镜的场景/地点简述(中文);\n"
    "- description:遵守上述铁律的 danbooru 标签英文提示词(单主体单动作);\n"
    "- characters:该镜出场角色名字数组(只用 characters 列表里给定的名字,没有则空数组);\n"
    "- camera:运镜方式(中文,如 缓慢推进 / 特写 / 全景 / 跟随 / 摇镜 / 仰拍);\n"
    "- dialogue:该镜的【中文】台词或旁白(没有则空字符串);\n"
    "- duration_sec:该镜建议时长(秒,整数,通常 2-6)。\n"
    "镜头数量严格等于用户要求的数量。若 style 给定请融入画质/画风标签。\n"
    '只输出 JSON,形如 {"shots":[{"scene":"...","description":"1boy, ...","characters":["..."],'
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
    quality: dict | None = None  # 三重防线质量报告(None=未执行)


def _parse_json_obj(text: str) -> dict | None:
    """从 LLM 文本里稳健地抽出 JSON 对象(容忍代码块/前后缀/思考标签)。"""
    t = text.strip()
    # Qwen3 等思考型模型把推理过程包在 <think>...</think> 中,
    # 真正的 JSON 输出在 </think> 之后。剥离思考前缀,避免误把思考里
    # 出现的 {…} 示例当成最终 JSON。
    if "</think>" in t:
        t = t.split("</think>", 1)[1].strip()
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

    # 反 PPT 三重防线:幻灯片风险 + 场景变化 + 节奏验证
    report = run_quality_checks([s.model_dump() for s in shots])
    if not report.passed:
        # blocking: 分镜严重 PPT 化,返回 422 + 详细报告让前端引导用户修改
        raise HTTPException(
            status_code=422,
            detail={
                "message": f"分镜未通过质量三重防线:{report.blocking_reason}",
                "quality": report.to_dict(),
            },
        )
    return StoryboardResponse(shots=shots, quality=report.to_dict())


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
    # 参考图已分发全 pool 时 worker 可空 → 后端 pool.pick 选装了 IPAdapter 节点的最闲机
    # (批量出图真并行);给定时只路由到该机(旧单机行为,向后兼容)。
    worker: str | None = Field(default=None, max_length=512)
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
    """据请求选用 IPAdapter 或 txt2img/次世代构图。返回 (graph, mode)。

    mode 用于 Job.kind 与响应,便于前端/历史区分该镜是否启用了角色一致性。
    无 character_ref(空/None)→ txt2img/次世代;有 → IPAdapter(传统 checkpoint  only)。
    次世代模型(flux2/qwen_image/z_image)走 UNETLoader,不能硬塞进 CheckpointLoaderSimple。
    """
    ref = (req.character_ref or "").strip()
    # 前端宽高仅定宽高比;按底模架构(SDXL/SD1.5/次世代)缩放到合适像素档。
    width, height = fit_resolution(ckpt_name, _snap8(req.width), _snap8(req.height))
    seed_kw = {"seed": req.seed} if req.seed is not None else {}

    # 次世代族走独立图构造(UNET+CLIP+VAE);目前 IPAdapter 与次世代未打通,有参考图时降级。
    if is_nextgen(ckpt_name):
        prof = profile_for(ckpt_name)
        ng = NextgenParams(
            model_name=ckpt_name,
            positive=req.positive,
            negative=req.negative if prof.neg_prompt else "",
            width=width,
            height=height,
            steps=prof.steps,
            cfg=prof.cfg,
            sampler=prof.sampler,
            scheduler=prof.scheduler,
            filename_prefix="ToIV_shot",
            **seed_kw,
        )
        return build_nextgen_graph(ng), "manju_shot_nextgen"

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
    # R18 硬门槛 + 打标:与 generate 各端点同一门槛(rerun overrides 换底模时同样复检)
    job_nsfw = _gate_nsfw_ckpt(ckpt_name, user)
    # 给定 worker → 只路由该机(参考图仅在该机,旧行为);未给 → 参考图已分发全 pool,
    # 选装了 IPAdapter 节点的最闲 worker 分发,让带参考图的批量出图也能跨机真并行。
    # 次世代族(flux2/qwen_image/z_image)需 UNET+CLIP+VAE 三件齐,且不走 IPAdapter。
    recipe = nextgen_recipe(ckpt_name) if is_nextgen(ckpt_name) else None
    if req.worker:
        client = resolve_worker(req.worker)
    else:
        try:
            if recipe:
                required = {ckpt_name, recipe.clip_name, recipe.vae_name}
                required_nodes: set[str] = set()
            else:
                required = {ckpt_name}
                required_nodes = _IPADAPTER_NODES
            client = await pool.pick(required=required, required_nodes=required_nodes)
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
    graph, kind = _build_shot_graph(req, ckpt_name)

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    # 次世代 KSampler 是节点 8,传统 txt2img/IPAdapter 是节点 3;按 class_type 取 seed。
    seed = next(
        (
            node["inputs"]["seed"]
            for node in graph.values()
            if isinstance(node, dict)
            and node.get("class_type") == "KSampler"
            and "seed" in node.get("inputs", {})
        ),
        req.seed,
    )
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
            nsfw=job_nsfw,
            params=params_snapshot(req, seed=seed),
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
