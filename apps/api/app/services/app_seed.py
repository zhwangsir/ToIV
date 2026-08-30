"""应用市场 M4:存量工作流包装为内置应用(启动幂等播种)。

把 app/workflows/ 下的存量模板包装成内置应用(is_builtin=True):
- h3/{t2v,i2v}_prompt.json:API 格式(外层 {"prompt": {...}}),直接取内层图;
- txt2img_basic / img2img_basic / ltx_txt2video / ltx_img2video / ltx_lipsync:
  UI(LiteGraph)格式,经 services/workflow_convert.ui_to_api(strict=True) 转 API 图。

幂等:按 id 判重,已存在整行跳过(不动任何人改过的行),与 agents_seed 同一纪律。
bindings 落库前逐条做「节点存在 + 字段叶子存在且为标量」校验,防上架即坏。

⚠️ seed(text) 写数值叶子依赖 routes/apps._write_leaf 的窄化规则:
   空串不写(保留图内模板值)、可解析数字串转 int/float;本模块 seed 默认 "" 即
   「留空用模板默认」,与 engine_registry._seed() 的表单习惯一致。
"""
from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path

from sqlmodel import Session, select

from app.models import App, _now
from app.services.workflow_convert import ui_to_api
from app.workflows.nextgen import (
    NextgenImg2ImgParams,
    NextgenParams,
    build_nextgen_graph,
    build_nextgen_img2img_graph,
)

logger = logging.getLogger(__name__)

_WORKFLOWS_DIR = Path(__file__).resolve().parents[1] / "workflows"

# 图像内置应用的底模(与 engine_registry 默认 flux2_dev 同族;fp8mixed 是 UNET-only,
# 必须走 UNETLoader+CLIPLoader 的次世代图——2026-08-31 生产事故:经 CheckpointLoaderSimple
# 模板转换的图缺 CLIP 必然 clip input is invalid)
_T2I_MODEL = "flux2_dev_fp8mixed.safetensors"


@lru_cache
def _load_api_template(rel: str) -> dict:
    """加载 API 格式模板(外层 {"prompt": {...}} 的取内层)。缓存后须 deepcopy/只读使用。"""
    with open(_WORKFLOWS_DIR / rel, encoding="utf-8") as f:
        data = json.load(f)
    return data.get("prompt", data)


@lru_cache
def _load_ui_template(rel: str) -> dict:
    """加载 UI 格式模板并 strict 转 API 图(未知节点类直接抛错,启动即暴露 coverage 缺口)。"""
    with open(_WORKFLOWS_DIR / rel, encoding="utf-8") as f:
        data = json.load(f)
    return ui_to_api(data, strict=True)


# ---------------------------------------------------------------------------
# params_schema 构件(与 services/engine_registry 同款范式)
# ---------------------------------------------------------------------------
def _positive(hint: str) -> dict:
    return {
        "key": "positive", "label": "提示词", "type": "textarea",
        "default": "", "required": True, "hint": hint,
    }


def _negative() -> dict:
    return {
        "key": "negative", "label": "负向提示词", "type": "textarea",
        "default": "", "hint": "描述不想要的内容,可留空",
    }


def _num(key: str, label: str, default: float, *, min_: float, max_: float,
         step: float = 1, hint: str | None = None) -> dict:
    d: dict = {
        "key": key, "label": label, "type": "number",
        "default": default, "min": min_, "max": max_, "step": step,
    }
    if hint:
        d["hint"] = hint
    return d


def _seed() -> dict:
    return {
        "key": "seed", "label": "随机种子", "type": "text", "default": "",
        "hint": "留空用模板默认;填整数可复现同一结果",
    }


def _b(node: str, field: str) -> dict:
    return {"node": node, "field": field}


# ---------------------------------------------------------------------------
# 内置应用规格(图在 _build_specs 里装配,校验后落库)
# ---------------------------------------------------------------------------
def _h3_params() -> list[dict]:
    return [
        _positive("场景描述 + 对白 + 音频氛围,海螺 H3 按三段式理解"),
        _num("width", "宽度", 1344, min_=320, max_=1344, step=32),
        _num("height", "高度", 768, min_=240, max_=768, step=32),
        _seed(),
    ]


def _h3_bindings() -> dict:
    # 节点 id 读自 workflows/h3/{t2v,i2v}_prompt.json:
    # 104=MiniMaxH3ImageToVideo(prompt/width/height), 15=RandomNoise(noise_seed)
    return {
        "positive": _b("104", "inputs.prompt"),
        "width": _b("104", "inputs.width"),
        "height": _b("104", "inputs.height"),
        "seed": _b("15", "inputs.noise_seed"),
    }


def _t2i_params() -> list[dict]:
    return [
        _positive("英文 tag 风格描述画面内容"),
        _negative(),
        _num("width", "宽度", 1024, min_=256, max_=2048, step=64),
        _num("height", "高度", 1024, min_=256, max_=2048, step=64),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _num("cfg", "CFG", 1.0, min_=0, max_=20, step=0.5,
             hint="Flux2 蒸馏链建议保持 1.0"),
        _seed(),
    ]


def _ltx_params(*, with_negative: bool = True) -> list[dict]:
    params = [_positive("自然语言长句:先主体与场景,再动作与运镜,最后光线氛围")]
    if with_negative:
        params.append(_negative())
    params += [
        _num("width", "宽度", 768, min_=256, max_=1280, step=32),
        _num("height", "高度", 384, min_=256, max_=1280, step=32),
        _num("frames", "帧数", 97, min_=9, max_=257, step=8,
             hint="须为 8k+1;97 帧 ≈ 6s @16fps"),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _seed(),
    ]
    return params


def _ltx_t2v_bindings() -> dict:
    # ltx_txt2video.json:4/5=CLIPTextEncode, 7=EmptyLTXVLatentVideo, 8=KSampler
    return {
        "positive": _b("4", "inputs.text"),
        "negative": _b("5", "inputs.text"),
        "width": _b("7", "inputs.width"),
        "height": _b("7", "inputs.height"),
        "frames": _b("7", "inputs.length"),
        "steps": _b("8", "inputs.steps"),
        "seed": _b("8", "inputs.seed"),
    }


def _ltx_i2v_bindings() -> dict:
    # ltx_img2video.json / ltx_lipsync.json:4/5=CLIPTextEncode, 7=LTXVImgToVideo, 8=KSampler
    return {
        "positive": _b("4", "inputs.text"),
        "negative": _b("5", "inputs.text"),
        "width": _b("7", "inputs.width"),
        "height": _b("7", "inputs.height"),
        "frames": _b("7", "inputs.length"),
        "steps": _b("8", "inputs.steps"),
        "seed": _b("8", "inputs.seed"),
    }


def _build_specs() -> list[dict]:
    """装配全部内置应用规格(含 UI→API 转换与 bindings 校验)。"""
    specs: list[dict] = [
        {
            "id": "h3-t2v",
            "name": "海螺 H3 文生视频",
            "description": "MiniMax H3 音画直出:场景+对白+音频一段提示词出 5 秒短剧视频",
            "icon": "film", "category": "video", "output_kind": "video",
            "workflow_json": _load_api_template("h3/t2v_prompt.json"),
            "params_schema": _h3_params(), "bindings": _h3_bindings(),
            "is_nsfw": False, "sort": 10,
        },
        {
            "id": "h3-i2v",
            "name": "海螺 H3 图生视频",
            "description": "首帧图驱动 H3:紧接画面续写动作/对白/音频,适合分镜接力",
            "icon": "video", "category": "video", "output_kind": "video",
            "workflow_json": _load_api_template("h3/i2v_prompt.json"),
            "params_schema": _h3_params(), "bindings": _h3_bindings(),
            "is_nsfw": False, "sort": 20,
        },
        {
            "id": "txt2img-basic",
            "name": "Flux2 文生图",
            "description": "一句话出图:Flux2 基础文生图,正向/负向/尺寸/步数全可调",
            "icon": "image", "category": "image", "output_kind": "image",
            # 次世代图(UNETLoader+CLIPLoader+VAELoader):4=正/5=负 CLIPTextEncode,
            # 7=空 latent(width/height), 8=KSampler(seed/steps/cfg)
            "workflow_json": build_nextgen_graph(NextgenParams(
                model_name=_T2I_MODEL, positive="", width=1024, height=1024,
            )),
            "params_schema": _t2i_params(),
            "bindings": {
                "positive": _b("4", "inputs.text"),
                "negative": _b("5", "inputs.text"),
                "width": _b("7", "inputs.width"),
                "height": _b("7", "inputs.height"),
                "steps": _b("8", "inputs.steps"),
                "cfg": _b("8", "inputs.cfg"),
                "seed": _b("8", "inputs.seed"),
            },
            "is_nsfw": False, "sort": 30,
        },
        {
            "id": "img2img-basic",
            "name": "Flux2 图生图",
            "description": "参考图重绘:调 denoise 控制改动幅度,适合风格迁移/精修",
            "icon": "wand", "category": "edit", "output_kind": "image",
            # 次世代 img2img 图:4=正/5=负, 7=LoadImage(image), 10=KSampler(denoise/steps/seed)
            "workflow_json": build_nextgen_img2img_graph(NextgenImg2ImgParams(
                model_name=_T2I_MODEL, image="", positive="",
            )),
            "params_schema": [
                {"key": "images", "label": "参考图", "type": "images", "max": 1,
                 "default": None, "required": True,
                 "hint": "jpg / png / webp,单张 ≤ 20MB"},
                _positive("描述目标画面(在参考图基础上的改动方向)"),
                _negative(),
                _num("denoise", "重绘幅度", 0.75, min_=0.05, max_=1.0, step=0.05,
                     hint="越小越贴近原图,越大改动越彻底"),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            "bindings": {
                "images": _b("7", "inputs.image"),
                "positive": _b("4", "inputs.text"),
                "negative": _b("5", "inputs.text"),
                "denoise": _b("10", "inputs.denoise"),
                "steps": _b("10", "inputs.steps"),
                "seed": _b("10", "inputs.seed"),
            },
            "is_nsfw": False, "sort": 40,
        },
        {
            "id": "ltx-txt2video",
            "name": "LTX 文生视频(R18)",
            "description": "LTX2.3 + 10Eros 底模文生视频:镜头语言长句提示词,16fps mp4 直出",
            "icon": "clapperboard", "category": "video", "output_kind": "video",
            "workflow_json": _load_ui_template("ltx_txt2video.json"),
            "params_schema": _ltx_params(), "bindings": _ltx_t2v_bindings(),
            # 10Eros 系底模,与 engine_registry 的 nsfw=true 口径一致
            "is_nsfw": True, "sort": 50,
        },
        {
            "id": "ltx-img2video",
            "name": "LTX 图生视频(R18)",
            "description": "首帧图 + 运镜提示词驱动 LTX2.3:姿态延续性好,适合 R18 短片",
            "icon": "play", "category": "video", "output_kind": "video",
            "workflow_json": _load_ui_template("ltx_img2video.json"),
            "params_schema": _ltx_params(), "bindings": _ltx_i2v_bindings(),
            "is_nsfw": True, "sort": 60,
        },
        {
            "id": "ltx-lipsync",
            "name": "LTX 对口型视频(R18)",
            "description": "参考音频驱动口型:人像图 + 音频 + 描述,16fps 音画同步直出",
            "icon": "mic", "category": "video", "output_kind": "video",
            "workflow_json": _load_ui_template("ltx_lipsync.json"),
            "params_schema": _ltx_params(), "bindings": _ltx_i2v_bindings(),
            "is_nsfw": True, "sort": 70,
        },
    ]
    for spec in specs:
        _validate_spec(spec)
    return specs


def _validate_spec(spec: dict) -> None:
    """bindings 全量校验:节点在图内、字段叶子存在且为标量(上架即坏的防线的代码侧)。"""
    graph = spec["workflow_json"]
    schema_keys = {p["key"] for p in spec["params_schema"]}
    for key, target in spec["bindings"].items():
        node = graph.get(target["node"])
        if not isinstance(node, dict):
            raise ValueError(f"{spec['id']}: 绑定 {key} 指向不存在的节点 {target['node']}")
        root, leaf = target["field"].split(".", 1)
        container = node.get(root)
        if root == "inputs":
            if not isinstance(container, dict) or leaf not in container:
                raise ValueError(
                    f"{spec['id']}: 绑定 {key} 目标 {target['node']}.inputs.{leaf} 不存在"
                )
            if isinstance(container[leaf], (dict, list)):
                raise ValueError(
                    f"{spec['id']}: 绑定 {key} 目标 {target['node']}.inputs.{leaf} 是连线,不能绑表单"
                )
        else:
            raise ValueError(f"{spec['id']}: 绑定 {key} 的 field 根仅支持 inputs(API 图无 widgets_values)")
        if key not in schema_keys:
            raise ValueError(f"{spec['id']}: 绑定 {key} 在 params_schema 中无对应参数")


def seed_builtin_apps(session: Session) -> int:
    """播种内置应用。新建幂等;已存在的内置应用按代码规格**更新**图/schema/bindings
    (内置应用禁止 PUT 编辑,代码即正典——2026-08-31 起用于修复存量坏图),
    个人/公共应用行不动。返回新建数量。"""
    rows = {a.id: a for a in session.exec(select(App)).all()}
    created = 0
    now = _now()
    for spec in _build_specs():
        row = rows.get(spec["id"])
        if row is not None:
            if row.is_builtin:  # 内置规格漂移修复
                row.workflow_json = spec["workflow_json"]
                row.params_schema = spec["params_schema"]
                row.bindings = spec["bindings"]
                row.name = spec["name"]
                row.description = spec["description"]
                row.icon = spec["icon"]
                row.category = spec["category"]
                row.output_kind = spec["output_kind"]
                row.is_nsfw = spec["is_nsfw"]
                row.sort = spec["sort"]
                row.updated_at = now
                session.add(row)
            continue
        session.add(
            App(
                id=spec["id"],
                name=spec["name"],
                description=spec["description"],
                icon=spec["icon"],
                category=spec["category"],
                workflow_json=spec["workflow_json"],
                params_schema=spec["params_schema"],
                bindings=spec["bindings"],
                required_nodes=[],  # 运行时从图自动取 class_type 集
                output_kind=spec["output_kind"],
                submit_kind="app_run",
                is_builtin=True,
                is_nsfw=spec["is_nsfw"],
                is_public=True,
                user_id="",
                usage_count=0,
                sort=spec["sort"],
                created_at=now,
                updated_at=now,
            )
        )
        created += 1
    session.commit()  # 更新路径也可能有写(内置规格漂移修复),统一提交
    if created:
        logger.info("内置应用播种完成:新增 %d 个", created)
    return created
