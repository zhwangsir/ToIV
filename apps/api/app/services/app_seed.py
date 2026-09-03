"""应用市场 M4:存量工作流包装为内置应用(启动幂等播种)。

把 generate 引擎与 app/workflows/ 下可诚实成图的模板/构造器包装成内置应用
(is_builtin=True,一工作流一表单 App):
- h3/{t2v,i2v}_prompt.json:API 格式(外层 {"prompt": {...}}),直接取内层图;
- txt2img_basic / img2img_basic 走次世代 Flux2 构造器(UNETLoader+CLIPLoader);
- ltx_txt2video / ltx_img2video / ltx_lipsync:UI 格式,经 ui_to_api(strict=True);
- 其余生产引擎复用 generate 已用的 python graph builder,bindings 只绑标量叶子。

幂等:按 id 判重;已存在的内置应用按代码规格更新图/schema/bindings(代码即正典),
个人/公共应用行不动,与 agents_seed 同一纪律。

⚠️ seed(text) 写数值叶子依赖 routes/apps._write_leaf 的窄化规则:
   空串不写(保留图内模板值)、可解析数字串转 int/float;本模块 seed 默认 "" 即
   「留空用模板默认」,与 engine_registry._seed() 的表单习惯一致。
"""
from __future__ import annotations

import copy
import json
import logging
from functools import lru_cache
from pathlib import Path

from sqlmodel import Session, select

from app.config import get_settings
from app.models import App, _now
from app.services.workflow_convert import ui_to_api
from app.services.rh_h3_preset_seed import expand_rh_h3_presets
from app.workflows.ace_step import AceStep15Params, AceStepParams, build_ace_step_15_graph, build_ace_step_graph
from app.workflows.controlnet import ControlNetParams, build_controlnet_graph
from app.workflows.facedetailer import FaceDetailerParams, build_facedetailer_graph
from app.workflows.flux_nunchaku import FluxNunchakuParams, build_flux_nunchaku_graph
from app.workflows.h3_video import (
    H3I2VParams,
    H3R2VParams,
    apply_nsfw_unet,
    build_h3_i2v_graph,
    build_h3_r2v_graph,
)
from app.workflows.hunyuan_i2v import HunyuanI2VParams, build_hunyuan_i2v_graph
from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.inpaint import InpaintParams, build_inpaint_graph
from app.workflows.ipadapter import IPAdapterTxt2ImgParams, build_ipadapter_txt2img_graph
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph
from app.workflows.longcat_avatar import LongCatAvatarParams, build_longcat_avatar_graph
from app.workflows.longcat_video import LongCatI2VParams, LongCatT2VParams, build_longcat_i2v_graph, build_longcat_t2v_graph
from app.workflows.ltx_multishot import LtxMultishotParams, LtxShot, build_ltx_multishot_graph
from app.workflows.nextgen import (
    NextgenImg2ImgParams,
    NextgenParams,
    build_nextgen_graph,
    build_nextgen_img2img_graph,
)
from app.workflows.ovi import OviI2VParams, OviT2VParams, assemble_ovi_prompt, build_ovi_i2v_graph, build_ovi_t2v_graph
from app.workflows.phantom_s2v import PhantomS2VParams, build_phantom_s2v_graph
from app.workflows.pulid import PulidTxt2ImgParams, build_pulid_txt2img_graph
from app.workflows.qwen_edit import QwenEditParams, build_qwen_edit_graph
from app.workflows.removebg import RemoveBgParams, build_removebg_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.upscale import UpscaleParams, build_upscale_graph
from app.workflows.wan_animate import WanAnimateParams, build_wan_animate_graph
from app.workflows.wan_animate2 import WanAnimate2Params, build_wan_animate2_graph
from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph
from app.workflows.wan_vace import WanVaceEditParams, WanVaceParams, build_wan_vace_edit_graph, build_wan_vace_graph

logger = logging.getLogger(__name__)

_WORKFLOWS_DIR = Path(__file__).resolve().parents[1] / "workflows"

# 图像内置应用的底模(与 engine_registry 默认 flux2_dev 同族;fp8mixed 是 UNET-only,
# 必须走 UNETLoader+CLIPLoader 的次世代图——2026-08-31 生产事故:经 CheckpointLoaderSimple
# 模板转换的图缺 CLIP 必然 clip input is invalid)
_T2I_MODEL = "flux2_dev_fp8mixed.safetensors"
# R18 图像默认底模(与 engine_registry._NSFW_DEFAULT_CKPT / URPM v1.3 同源)
_NSFW_T2I_CKPT = "uberRealisticPornMerge_urpmv13.safetensors"


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


def _h3_graph(rel: str, *, nsfw: bool = False) -> dict:
    """H3 模板深拷贝;NSFW 切换 UNETLoader 底模(apply_nsfw_unet)。"""
    graph = copy.deepcopy(_load_api_template(rel))
    if nsfw:
        apply_nsfw_unet(graph, get_settings().h3_nsfw_unet)
    return graph


# ---------------------------------------------------------------------------
# params_schema 构件(与 services/engine_registry 同款范式)
# ---------------------------------------------------------------------------
def _positive(hint: str, *, key: str = "positive", label: str = "提示词",
              required: bool = True, default: str = "") -> dict:
    d = {
        "key": key, "label": label, "type": "textarea",
        "default": default, "hint": hint,
    }
    if required:
        d["required"] = True
    return d


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


def _images(label: str = "参考图", *, key: str = "images", max_: int = 1,
            required: bool = True, hint: str | None = None) -> dict:
    d: dict = {
        "key": key, "label": label, "type": "images", "max": max_,
        "default": None,
        "hint": hint or "jpg / png / webp,单张 ≤ 20MB",
    }
    if required:
        d["required"] = True
    return d


def _audio(label: str = "音频", *, key: str = "audio", required: bool = True,
           max_: int = 1, hint: str | None = None) -> dict:
    d: dict = {
        "key": key, "label": label, "type": "audio", "max": max_, "default": None,
        "hint": hint or "wav / mp3,单文件 ≤ 20MB",
    }
    if required:
        d["required"] = True
    return d


def _video(label: str = "视频", *, key: str = "video", required: bool = True,
           max_: int = 1, hint: str | None = None) -> dict:
    d: dict = {
        "key": key, "label": label, "type": "video", "max": max_, "default": None,
        "hint": hint or "mp4 / webm / mov,≤ 200MB",
    }
    if required:
        d["required"] = True
    return d


def _b(node: str, field: str) -> dict:
    return {"node": node, "field": field}


def _spec(id: str, name: str, description: str, *, icon: str, category: str,
          output_kind: str, workflow_json: dict, params_schema: list[dict],
          bindings: dict, is_nsfw: bool, sort: int) -> dict:
    return {
        "id": id, "name": name, "description": description,
        "icon": icon, "category": category, "output_kind": output_kind,
        "workflow_json": workflow_json, "params_schema": params_schema,
        "bindings": bindings, "is_nsfw": is_nsfw, "sort": sort,
    }


# ---------------------------------------------------------------------------
# 内置应用规格(图在 _build_specs 里装配,校验后落库)
# ---------------------------------------------------------------------------
def _h3_params(*, with_images: bool = False, with_last_frame: bool = False,
               with_r2v: bool = False, length: int = 124, steps: int = 20,
               audio_required: bool = False) -> list[dict]:
    """H3 表单;length/steps 仅改默认值,图与 bindings 复用核心 h3-*。"""
    params: list[dict] = []
    if with_r2v:
        params.append(_images(
            label="参考图",
            hint="jpg / png / webp;提示词用 1-based 标签 <Picture 1> 引用。最多 9 张,可与视频/音频组合。",
            max_=9,
        ))
        params.append(_video(
            label="参考视频", required=False, max_=3,
            hint="可选;最多 3 段,mp4 / webm / mov,须 ≥5 帧;提示词 <Video 1>",
        ))
        audio_hint = (
            "须配参考音频(最多 3 段);声音参考/克隆须配图或视频,不能纯音频;提示词 <Audio 1>"
            if audio_required else
            "可选;最多 3 段,wav / mp3;提示词 <Audio 1>"
        )
        params.append(_audio(
            label="参考音频", required=audio_required, max_=3, hint=audio_hint,
        ))
    elif with_images:
        params.append(_images(label="首帧图", hint="jpg / png / webp,单张 ≤ 20MB;绑到 LoadImage 节点 100"))
        if with_last_frame:
            params.append(_images(
                label="尾帧图", key="last_frame",
                hint="jpg / png / webp,单张 ≤ 20MB;绑到 LoadImage 节点 101",
            ))
    length_hint = (
        "17k+5 网格 @24fps;本预设默认 362≈15s(H3 原生单段上限)"
        if length >= 362 else
        "17k+5 网格 @24fps;124≈5.2s,上限 362≈15s"
    )
    params += [
        _positive("场景描述 + 对白 + 音频氛围,海螺 H3 按三段式理解"),
        _num("width", "宽度", 1344, min_=320, max_=1344, step=32),
        _num("height", "高度", 768, min_=240, max_=768, step=32),
        _num("length", "帧数", length, min_=17, max_=362, hint=length_hint),
        _num("steps", "采样步数", steps, min_=1, max_=50),
        _seed(),
    ]
    return params


def _h3_bindings(*, with_images: bool = False, with_last_frame: bool = False,
                 with_r2v: bool = False) -> dict:
    # 节点 id:104=H3 条件节点(prompt/width/height/length), 15=RandomNoise,
    # 9=BasicScheduler(steps), 100/101=LoadImage(i2v/fl2v),
    # r2v: LoadImage 110-118 / LoadVideo 120,122,124 / LoadAudio 130-132
    b = {
        "positive": _b("104", "inputs.prompt"),
        "width": _b("104", "inputs.width"),
        "height": _b("104", "inputs.height"),
        "length": _b("104", "inputs.length"),
        "steps": _b("9", "inputs.steps"),
        "seed": _b("15", "inputs.noise_seed"),
    }
    if with_r2v:
        b["images"] = [_b(str(110 + i), "inputs.image") for i in range(9)]
        b["video"] = [_b(str(120 + i * 2), "inputs.file") for i in range(3)]
        b["audio"] = [_b(str(130 + i), "inputs.audio") for i in range(3)]
    elif with_images:
        b["images"] = _b("100", "inputs.image")
        if with_last_frame:
            b["last_frame"] = _b("101", "inputs.image")
    return b


def _h3_fl2v_graph(*, nsfw: bool = False) -> dict:
    """内置应用需要节点 101 已存在(app-run 不能改拓扑),故用带尾帧的 i2v 图。"""
    graph = build_h3_i2v_graph(H3I2VParams(positive="", image="first.png", last_frame="last.png"))
    if nsfw:
        apply_nsfw_unet(graph, get_settings().h3_nsfw_unet)
    return graph


def _h3_r2v_graph(*, nsfw: bool = False) -> dict:
    """预置 Ref2VA 全部参考槽(9 图 + 3 视频对 + 3 音频);app-run 按上传数量写入并省略空槽。"""
    graph = build_h3_r2v_graph(H3R2VParams(
        positive="",
        images=tuple(f"ref{i}.png" for i in range(1, 10)),
        videos=tuple(f"ref{i}.mp4" for i in range(1, 4)),
        audios=tuple(f"ref{i}.wav" for i in range(1, 4)),
    ))
    if nsfw:
        apply_nsfw_unet(graph, get_settings().h3_nsfw_unet)
    return graph


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


def _ltx_params(*, with_negative: bool = True, with_images: bool = False,
                with_audio: bool = False) -> list[dict]:
    params: list[dict] = []
    if with_images:
        params.append(_images(label="首帧图"))
    if with_audio:
        params.append(_audio(label="参考音频", hint="wav / mp3,口型驱动音频"))
    params.append(_positive("自然语言长句:先主体与场景,再动作与运镜,最后光线氛围"))
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


def _ltx_i2v_bindings(*, with_audio: bool = False) -> dict:
    # 转换后:4/5=CLIPTextEncode, 6=LoadImage, 7=LTXVImgToVideo, 8=KSampler;
    # lipsync 另有 11=LoadAudio
    b = {
        "images": _b("6", "inputs.image"),
        "positive": _b("4", "inputs.text"),
        "negative": _b("5", "inputs.text"),
        "width": _b("7", "inputs.width"),
        "height": _b("7", "inputs.height"),
        "frames": _b("7", "inputs.length"),
        "steps": _b("8", "inputs.steps"),
        "seed": _b("8", "inputs.seed"),
    }
    if with_audio:
        b["audio"] = _b("11", "inputs.audio")
    return b


def _sd15_t2i_params(*, nsfw: bool) -> list[dict]:
    return [
        _positive("正向提示词"),
        _negative(),
        _num("width", "宽度", 1024, min_=256, max_=2048, step=64),
        _num("height", "高度", 1024, min_=256, max_=2048, step=64),
        _num("steps", "采样步数", 20, min_=1, max_=50),
        _num("cfg", "CFG", 7.0, min_=0, max_=20, step=0.5),
        _seed(),
    ]


def _build_specs() -> list[dict]:
    """装配全部内置应用规格(含 UI→API 转换与 bindings 校验)。"""
    specs: list[dict] = [
        # ----- 已有 7(补 h3-i2v 首帧 / LTX i2v+lipsync 媒体) -----
        _spec(
            "h3-t2v", "海螺 H3 文生视频",
            "MiniMax H3 音画直出:场景+对白+音频一段提示词出 5 秒短剧视频",
            icon="film", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/t2v_prompt.json"),
            params_schema=_h3_params(), bindings=_h3_bindings(),
            is_nsfw=False, sort=10,
        ),
        _spec(
            "h3-i2v", "海螺 H3 图生视频",
            "首帧图驱动 H3:紧接画面续写动作/对白/音频,适合分镜接力",
            icon="video", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/i2v_prompt.json"),
            params_schema=_h3_params(with_images=True),
            bindings=_h3_bindings(with_images=True),
            is_nsfw=False, sort=20,
        ),
        _spec(
            "h3-fl2v", "海螺 H3 首尾帧转场",
            "首尾帧转场:首帧+尾帧驱动 H3 ImageToVideo,两张图之间插值出短片(不是 9 参考 Ref2VA)",
            icon="layers", category="video", output_kind="video",
            workflow_json=_h3_fl2v_graph(),
            params_schema=_h3_params(with_images=True, with_last_frame=True),
            bindings=_h3_bindings(with_images=True, with_last_frame=True),
            is_nsfw=False, sort=21,
        ),
        _spec(
            "h3-r2v", "海螺 H3 全能参考",
            "全能参考:最多 9 图 + 3 视频 + 3 音频;提示词用 1-based 标签 <Picture 1> / <Video 1> / <Audio 1>",
            icon="users", category="video", output_kind="video",
            workflow_json=_h3_r2v_graph(),
            params_schema=_h3_params(with_r2v=True),
            bindings=_h3_bindings(with_r2v=True),
            is_nsfw=False, sort=22,
        ),
        _spec(
            "h3-multishot", "海螺 H3 多镜头",
            "同一 H3 文生视频图:在提示词里写「镜头一…镜头二…」(2-4 镜单 prompt 协议)",
            icon="clapperboard", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/t2v_prompt.json"),
            params_schema=_h3_params(), bindings=_h3_bindings(),
            is_nsfw=False, sort=25,
        ),
        _spec(
            "h3-nsfw-t2v", "海螺 H3 文生视频(R18)",
            "H3 + 10Eros-Max NSFW UNET:音画直出成人向短剧",
            icon="film", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/t2v_prompt.json", nsfw=True),
            params_schema=_h3_params(), bindings=_h3_bindings(),
            is_nsfw=True, sort=26,
        ),
        _spec(
            "h3-nsfw-i2v", "海螺 H3 图生视频(R18)",
            "首帧图驱动 H3 NSFW UNET:姿态延续的成人向短片",
            icon="video", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/i2v_prompt.json", nsfw=True),
            params_schema=_h3_params(with_images=True),
            bindings=_h3_bindings(with_images=True),
            is_nsfw=True, sort=27,
        ),
        _spec(
            "h3-nsfw-fl2v", "海螺 H3 首尾帧转场(R18)",
            "首尾帧转场(R18):首帧+尾帧驱动 H3 NSFW UNET,两张图之间插值的成人向短片(不是 9 参考)",
            icon="layers", category="video", output_kind="video",
            workflow_json=_h3_fl2v_graph(nsfw=True),
            params_schema=_h3_params(with_images=True, with_last_frame=True),
            bindings=_h3_bindings(with_images=True, with_last_frame=True),
            is_nsfw=True, sort=28,
        ),
        _spec(
            "h3-nsfw-r2v", "海螺 H3 全能参考(R18)",
            "全能参考(R18):最多 9 图 + 3 视频 + 3 音频;提示词用 1-based 标签 <Picture 1> / <Video 1> / <Audio 1>",
            icon="users", category="video", output_kind="video",
            workflow_json=_h3_r2v_graph(nsfw=True),
            params_schema=_h3_params(with_r2v=True),
            bindings=_h3_bindings(with_r2v=True),
            is_nsfw=True, sort=29,
        ),
        # h3-i2v-20s: H3 原生单段上限 362 帧≈15s@24fps;20s 是末帧 i2v 分段续写
        # (segment_extend),不是一镜到底。不伪造 20s 内置应用。
        _spec(
            "h3-t2v-15s-fast", "海螺 H3 文生 15 秒加速",
            "文生 15 秒加速:默认 362 帧≈15s、8 步;同一 t2v 图,锁定加速默认降低学习成本",
            icon="film", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/t2v_prompt.json"),
            params_schema=_h3_params(length=362, steps=8), bindings=_h3_bindings(),
            is_nsfw=False, sort=30,
        ),
        _spec(
            "h3-i2v-15s-fast", "海螺 H3 图生 15 秒加速",
            "图生 15 秒加速:须上传首帧;默认 362 帧≈15s、8 步;同一 i2v 图",
            icon="video", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/i2v_prompt.json"),
            params_schema=_h3_params(with_images=True, length=362, steps=8),
            bindings=_h3_bindings(with_images=True),
            is_nsfw=False, sort=31,
        ),
        _spec(
            "h3-r2v-voice", "海螺 H3 声音参考",
            "声音参考/克隆须配图或视频,不能纯音频。同一 Ref2VA 图:最多 9 图 3 视频 3 音频;提示词用 1-based 标签 <Picture 1> / <Audio 1>",
            icon="mic", category="video", output_kind="video",
            workflow_json=_h3_r2v_graph(),
            params_schema=_h3_params(with_r2v=True, audio_required=True),
            bindings=_h3_bindings(with_r2v=True),
            is_nsfw=False, sort=32,
        ),
        _spec(
            "h3-nsfw-t2v-15s-fast", "海螺 H3 文生 15 秒加速(R18)",
            "文生 15 秒加速(R18):默认 362 帧≈15s、8 步;同一 t2v NSFW 图",
            icon="film", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/t2v_prompt.json", nsfw=True),
            params_schema=_h3_params(length=362, steps=8), bindings=_h3_bindings(),
            is_nsfw=True, sort=33,
        ),
        _spec(
            "h3-nsfw-i2v-15s-fast", "海螺 H3 图生 15 秒加速(R18)",
            "图生 15 秒加速(R18):须上传首帧;默认 362 帧≈15s、8 步;同一 i2v NSFW 图",
            icon="video", category="video", output_kind="video",
            workflow_json=_h3_graph("h3/i2v_prompt.json", nsfw=True),
            params_schema=_h3_params(with_images=True, length=362, steps=8),
            bindings=_h3_bindings(with_images=True),
            is_nsfw=True, sort=34,
        ),
        _spec(
            "h3-nsfw-r2v-voice", "海螺 H3 声音参考(R18)",
            "声音参考/克隆(R18)须配图或视频,不能纯音频。同一 Ref2VA NSFW 图:最多 9 图 3 视频 3 音频",
            icon="mic", category="video", output_kind="video",
            workflow_json=_h3_r2v_graph(nsfw=True),
            params_schema=_h3_params(with_r2v=True, audio_required=True),
            bindings=_h3_bindings(with_r2v=True),
            is_nsfw=True, sort=35,
        ),
        _spec(
            "txt2img-basic", "Flux2 文生图",
            "一句话出图:Flux2 基础文生图,正向/负向/尺寸/步数全可调",
            icon="image", category="image", output_kind="image",
            workflow_json=build_nextgen_graph(NextgenParams(
                model_name=_T2I_MODEL, positive="", width=1024, height=1024,
            )),
            params_schema=_t2i_params(),
            bindings={
                "positive": _b("4", "inputs.text"),
                "negative": _b("5", "inputs.text"),
                "width": _b("7", "inputs.width"),
                "height": _b("7", "inputs.height"),
                "steps": _b("8", "inputs.steps"),
                "cfg": _b("8", "inputs.cfg"),
                "seed": _b("8", "inputs.seed"),
            },
            is_nsfw=False, sort=30,
        ),
        _spec(
            "nsfw-txt2img", "文生图(R18)",
            "URPM v1.3 SD1.5 成人向文生图,正向/负向/尺寸/步数可调",
            icon="image", category="image", output_kind="image",
            workflow_json=build_txt2img_graph(Txt2ImgParams(
                positive="", ckpt_name=_NSFW_T2I_CKPT, width=1024, height=1024,
            )),
            params_schema=_sd15_t2i_params(nsfw=True),
            bindings={
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "width": _b("5", "inputs.width"),
                "height": _b("5", "inputs.height"),
                "steps": _b("3", "inputs.steps"),
                "cfg": _b("3", "inputs.cfg"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=True, sort=35,
        ),
        _spec(
            "flux1-nunchaku", "FLUX.1 Nunchaku",
            "Nunchaku SVDQuant fp4 FLUX.1-dev 文生图:5090 热跑约 2s/张",
            icon="zap", category="image", output_kind="image",
            workflow_json=build_flux_nunchaku_graph(FluxNunchakuParams(positive="")),
            params_schema=[
                _positive("英文描述画面内容"),
                _num("width", "宽度", 1024, min_=256, max_=2048, step=64),
                _num("height", "高度", 1024, min_=256, max_=2048, step=64),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _num("guidance", "引导强度", 3.5, min_=1.0, max_=10.0, step=0.5,
                     hint="FluxGuidance,非 KSampler CFG"),
                _seed(),
            ],
            bindings={
                "positive": _b("3", "inputs.text"),
                "width": _b("6", "inputs.width"),
                "height": _b("6", "inputs.height"),
                "steps": _b("7", "inputs.steps"),
                "guidance": _b("5", "inputs.guidance"),
                "seed": _b("7", "inputs.seed"),
            },
            is_nsfw=False, sort=36,
        ),
        _spec(
            "img2img-basic", "Flux2 图生图",
            "参考图重绘:调 denoise 控制改动幅度,适合风格迁移/精修",
            icon="wand", category="edit", output_kind="image",
            workflow_json=build_nextgen_img2img_graph(NextgenImg2ImgParams(
                model_name=_T2I_MODEL, image="", positive="",
            )),
            params_schema=[
                _images(label="参考图"),
                _positive("描述目标画面(在参考图基础上的改动方向)"),
                _negative(),
                _num("denoise", "重绘幅度", 0.75, min_=0.05, max_=1.0, step=0.05,
                     hint="越小越贴近原图,越大改动越彻底"),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("7", "inputs.image"),
                "positive": _b("4", "inputs.text"),
                "negative": _b("5", "inputs.text"),
                "denoise": _b("10", "inputs.denoise"),
                "steps": _b("10", "inputs.steps"),
                "seed": _b("10", "inputs.seed"),
            },
            is_nsfw=False, sort=40,
        ),
        _spec(
            "nsfw-img2img", "图生图(R18)",
            "URPM v1.3 成人向图生图:参考图 + denoise 控制改动幅度",
            icon="wand", category="edit", output_kind="image",
            workflow_json=build_img2img_graph(Img2ImgParams(
                positive="", image="", ckpt_name=_NSFW_T2I_CKPT,
            )),
            params_schema=[
                _images(label="参考图"),
                _positive("描述目标画面(在参考图基础上的改动方向)"),
                _negative(),
                _num("denoise", "重绘幅度", 0.6, min_=0.05, max_=1.0, step=0.05),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("10", "inputs.image"),
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "denoise": _b("3", "inputs.denoise"),
                "steps": _b("3", "inputs.steps"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=True, sort=41,
        ),
        _spec(
            "qwen-image-edit", "智能编辑(Qwen)",
            "Qwen-Image-Edit-2509:自然语言语义编辑,专用实例 :8194",
            icon="sparkles", category="edit", output_kind="image",
            workflow_json=build_qwen_edit_graph(QwenEditParams(image="", positive="")),
            params_schema=[
                _images(label="源图"),
                _positive("编辑指令,如「把衣服换成红色」"),
                _seed(),
            ],
            bindings={
                "images": _b("7", "inputs.image"),
                "positive": _b("4", "inputs.prompt"),
                "seed": _b("8", "inputs.seed"),
            },
            is_nsfw=False, sort=42,
        ),
        _spec(
            "ltx-txt2video", "LTX 文生视频(R18)",
            "LTX2.3 + 10Eros 底模文生视频:镜头语言长句提示词,16fps mp4 直出",
            icon="clapperboard", category="video", output_kind="video",
            workflow_json=_load_ui_template("ltx_txt2video.json"),
            params_schema=_ltx_params(), bindings=_ltx_t2v_bindings(),
            is_nsfw=True, sort=50,
        ),
        _spec(
            "ltx-img2video", "LTX 图生视频(R18)",
            "首帧图 + 运镜提示词驱动 LTX2.3:姿态延续性好,适合 R18 短片",
            icon="play", category="video", output_kind="video",
            workflow_json=_load_ui_template("ltx_img2video.json"),
            params_schema=_ltx_params(with_images=True),
            bindings=_ltx_i2v_bindings(),
            is_nsfw=True, sort=60,
        ),
        _spec(
            "ltx-lipsync", "LTX 对口型视频(R18)",
            "参考音频驱动口型:人像图 + 音频 + 描述,16fps 音画同步直出",
            icon="mic", category="video", output_kind="video",
            workflow_json=_load_ui_template("ltx_lipsync.json"),
            params_schema=_ltx_params(with_images=True, with_audio=True),
            bindings=_ltx_i2v_bindings(with_audio=True),
            is_nsfw=True, sort=70,
        ),
        _spec(
            "ltx25-multishot", "LTX-2.5 多镜头",
            "LTX-2.5 22B 原生音画多镜头:在提示词里写 Shot 1/2…(官方 2-4 镜窗口)",
            icon="clapperboard", category="video", output_kind="video",
            workflow_json=build_ltx_multishot_graph(LtxMultishotParams(
                shots=(LtxShot("establishing shot of the scene", 4),
                       LtxShot("close-up reaction", 4)),
            )),
            params_schema=[
                _positive("分镜长句:建议 Shot 1 (Ns): … / Shot 2 (Ns): …,总时长 ≤20s"),
                _negative(),
                _seed(),
            ],
            bindings={
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "seed": _b("13", "inputs.noise_seed"),
            },
            is_nsfw=False, sort=75,
        ),
        _spec(
            "wan-nsfw-i2v", "Wan 图生视频(R18)",
            "Wan2.2 双专家 I2V:首帧图驱动成人向短视频(默认 8 步加速档)",
            icon="play", category="video", output_kind="video",
            workflow_json=build_wan_i2v_graph(WanI2VParams(positive="", image="")),
            params_schema=[
                _images(label="首帧图"),
                _positive("动作与运镜描述;NSFW 触发词由配方侧注入"),
                _negative(),
                _num("width", "宽度", 832, min_=320, max_=1280, step=16),
                _num("height", "高度", 480, min_=320, max_=1280, step=16),
                _num("frames", "帧数", 81, min_=17, max_=121, step=4,
                     hint="4n+1 网格;81 帧≈5s @16fps,上限 121≈7.5s"),
                _seed(),
            ],
            bindings={
                "images": _b("9", "inputs.image"),
                "positive": _b("7", "inputs.text"),
                "negative": _b("8", "inputs.text"),
                "width": _b("10", "inputs.width"),
                "height": _b("10", "inputs.height"),
                "frames": _b("10", "inputs.length"),
                "seed": _b("11", "inputs.noise_seed"),
            },
            is_nsfw=True, sort=80,
        ),
        _spec(
            "wan-animate", "Wan-Animate 动作迁移",
            "参考图角色 + 驱动视频 → Wan2.2-Animate 动作迁移(DWPose 中间件)",
            icon="video", category="video", output_kind="video",
            workflow_json=build_wan_animate_graph(WanAnimateParams(
                positive="", image="", video="",
            )),
            params_schema=[
                _images(label="角色参考图"),
                _video(label="驱动视频"),
                _positive("外观/场景描述(动作由驱动视频决定)"),
                _negative(),
                _num("steps", "采样步数", 6, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("6", "inputs.image"),
                "video": _b("10", "inputs.video"),
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "steps": _b("13", "inputs.steps"),
                "seed": _b("13", "inputs.seed"),
            },
            is_nsfw=False, sort=81,
        ),
        _spec(
            "wan-animate-2", "Wan-Animate-2 动作迁移",
            "Wan-Animate-2 原生节点:参考图 + 驱动视频,蒸馏 10 步无 CFG",
            icon="video", category="video", output_kind="video",
            workflow_json=build_wan_animate2_graph(WanAnimate2Params(
                positive="", image="", video="",
            )),
            params_schema=[
                _images(label="角色参考图"),
                _video(label="驱动视频", hint="mp4 / webm / mov;帧 1:1 映射,请与输出帧率对齐"),
                _positive("只描述参考图外观+背景,不要写动作"),
                _negative(),
                _num("steps", "采样步数", 10, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("6", "inputs.image"),
                "video": _b("9", "inputs.file"),
                "positive": _b("4", "inputs.text"),
                "negative": _b("5", "inputs.text"),
                "steps": _b("12", "inputs.steps"),
                "seed": _b("12", "inputs.seed"),
            },
            is_nsfw=False, sort=82,
        ),
        _spec(
            "wan-vace", "Wan-VACE 多参考图",
            "Wan2.1-VACE:一张参考图驱动角色/物体一致性视频(单参考静态图)",
            icon="layers", category="video", output_kind="video",
            workflow_json=build_wan_vace_graph(WanVaceParams(
                positive="", ref_images=("",),
            )),
            params_schema=[
                _images(label="参考图"),
                _positive("场景与动作描述"),
                _negative(),
                _num("frames", "帧数", 81, min_=17, max_=241, step=4,
                     hint="4k+1 网格;81 帧≈5s @16fps"),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("20", "inputs.image"),
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "frames": _b("10", "inputs.num_frames"),
                "steps": _b("13", "inputs.steps"),
                "seed": _b("13", "inputs.seed"),
            },
            is_nsfw=False, sort=83,
        ),
        _spec(
            "vace-edit", "VACE 视频编辑",
            "Wan2.1-VACE 视频到视频编辑:源视频 + 编辑指令 → 对象替换/风格迁移/重打光(默认 81 帧≈5s@16fps);关键帧锚点/区域 mask 仍走高级引擎编辑器",
            icon="wand", category="video", output_kind="video",
            workflow_json=build_wan_vace_edit_graph(WanVaceEditParams(
                positive="edit the source video as instructed",
                ref_images=(),
                source_video="source.mp4",
                edit_prompt="edit the source video as instructed",
            )),
            params_schema=[
                _video(label="源视频", hint="mp4 / webm / mov,≤200MB,建议 ≤10s"),
                _positive("英文编辑指令,只描述要改的内容,如 make it snow / replace the car with a bicycle"),
                _negative(),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "video": _b("50", "inputs.video"),
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "steps": _b("13", "inputs.steps"),
                "seed": _b("13", "inputs.seed"),
            },
            is_nsfw=False, sort=84,
        ),
        _spec(
            "longcat-t2v", "LongCat 文生视频",
            "LongCat-Video 蒸馏 LoRA 文生视频:默认 10 步,单镜头最长约 60s",
            icon="film", category="video", output_kind="video",
            workflow_json=build_longcat_t2v_graph(LongCatT2VParams(positive="")),
            params_schema=[
                _positive("自然语言描述画面与运动"),
                _negative(),
                _num("width", "宽度", 832, min_=320, max_=1280, step=16),
                _num("height", "高度", 480, min_=320, max_=1280, step=16),
                _num("frames", "帧数", 121, min_=17, max_=241,
                     hint="默认 121≈7.5s @16fps;更长由工作室走上下文窗口"),
                _num("steps", "采样步数", 10, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "width": _b("6", "inputs.width"),
                "height": _b("6", "inputs.height"),
                "frames": _b("6", "inputs.num_frames"),
                "steps": _b("7", "inputs.steps"),
                "seed": _b("7", "inputs.seed"),
            },
            is_nsfw=False, sort=90,
        ),
        _spec(
            "longcat-i2v", "LongCat 图生视频",
            "LongCat 首帧图驱动:ImageResize + WanVideoEncode 接入 t2v 骨架",
            icon="play", category="video", output_kind="video",
            workflow_json=build_longcat_i2v_graph(LongCatI2VParams(positive="", image="")),
            params_schema=[
                _images(label="首帧图"),
                _positive("紧接首帧续写动作"),
                _negative(),
                _num("frames", "帧数", 121, min_=17, max_=241),
                _num("steps", "采样步数", 10, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("11", "inputs.image"),
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "frames": _b("6", "inputs.num_frames"),
                "steps": _b("7", "inputs.steps"),
                "seed": _b("7", "inputs.seed"),
            },
            is_nsfw=False, sort=91,
        ),
        _spec(
            "avatar-talk", "数字人口播",
            "LongCat-Avatar:人像首帧 + 驱动音频 → 口型同步数字人视频",
            icon="user", category="video", output_kind="video",
            workflow_json=build_longcat_avatar_graph(LongCatAvatarParams(
                positive="", image="", audio="",
            )),
            params_schema=[
                _images(label="人像首帧"),
                _audio(label="驱动音频"),
                _positive("外观与场景(口型由音频决定)"),
                _negative(),
                _seed(),
            ],
            bindings={
                "images": _b("1", "inputs.image"),
                "audio": _b("3", "inputs.audio"),
                "positive": _b("12", "inputs.positive_prompt"),
                "negative": _b("12", "inputs.negative_prompt"),
                "seed": _b("17", "inputs.seed"),
            },
            is_nsfw=False, sort=92,
        ),
        _spec(
            "ovi-t2v", "Ovi 文生音画",
            "Ovi 1.1 音画联合:画面描述 + <S>台词<E> + Audio: 音效,10s@960 直出",
            icon="volume", category="video", output_kind="video",
            workflow_json=build_ovi_t2v_graph(OviT2VParams(
                positive=assemble_ovi_prompt("a person in a quiet room"),
            )),
            params_schema=[
                _positive("完整 Ovi 提示词:画面 + <S>台词<E> + Audio: 环境音(缺 <S> 不出人声)"),
                _negative(),
                _num("steps", "采样步数", 50, min_=1, max_=80),
                _seed(),
            ],
            bindings={
                "positive": _b("3", "inputs.positive_prompt"),
                "negative": _b("3", "inputs.negative_prompt"),
                "steps": _b("8", "inputs.steps"),
                "seed": _b("8", "inputs.seed"),
            },
            is_nsfw=False, sort=100,
        ),
        _spec(
            "ovi-i2v", "Ovi 图生音画",
            "Ovi 1.1 首帧图 + 音画联合提示词:口型与环境音同步直出",
            icon="volume", category="video", output_kind="video",
            workflow_json=build_ovi_i2v_graph(OviI2VParams(
                positive=assemble_ovi_prompt("a person in a quiet room"),
                image="",
            )),
            params_schema=[
                _images(label="首帧图"),
                _positive("完整 Ovi 提示词:画面 + <S>台词<E> + Audio: 环境音"),
                _negative(),
                _num("steps", "采样步数", 50, min_=1, max_=80),
                _seed(),
            ],
            bindings={
                "images": _b("14", "inputs.image"),
                "positive": _b("3", "inputs.positive_prompt"),
                "negative": _b("3", "inputs.negative_prompt"),
                "steps": _b("8", "inputs.steps"),
                "seed": _b("8", "inputs.seed"),
            },
            is_nsfw=False, sort=101,
        ),
        _spec(
            "phantom-s2v", "Phantom 角色视频",
            "Phantom-Wan-14B Subject-to-Video:一张角色参考图保持身份出视频",
            icon="users", category="video", output_kind="video",
            workflow_json=build_phantom_s2v_graph(PhantomS2VParams(
                positive="", images=("",),
            )),
            params_schema=[
                _images(label="角色参考图"),
                _positive("动作与场景(参考图决定身份)"),
                _negative(),
                _num("frames", "帧数", 81, min_=17, max_=121, step=4),
                _num("steps", "采样步数", 8, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("20", "inputs.image"),
                "positive": _b("5", "inputs.positive_prompt"),
                "negative": _b("5", "inputs.negative_prompt"),
                "frames": _b("6", "inputs.num_frames"),
                "steps": _b("7", "inputs.steps"),
                "seed": _b("7", "inputs.seed"),
            },
            is_nsfw=False, sort=110,
        ),
        _spec(
            "ace-music", "ACE 文生音乐",
            "ACE-Step 1.5 Turbo:风格标签 + 可选歌词,出 MP3(默认 30s / 8 步)",
            icon="audio", category="audio", output_kind="audio",
            workflow_json=build_ace_step_15_graph(AceStep15Params(tags="")),
            params_schema=[
                _positive("风格/流派标签,如 lofi hip hop, chill, piano",
                          key="tags", label="风格标签"),
                _positive("歌词,留空=纯音乐;支持 [verse]/[chorus]",
                          key="lyrics", label="歌词", required=False),
                _num("seconds", "时长(秒)", 30, min_=5, max_=600),
                _num("steps", "采样步数", 8, min_=1, max_=150),
                _seed(),
            ],
            bindings={
                "tags": _b("3", "inputs.tags"),
                "lyrics": _b("3", "inputs.lyrics"),
                "seconds": _b("5", "inputs.seconds"),
                "steps": _b("6", "inputs.steps"),
                "seed": _b("6", "inputs.seed"),
            },
            is_nsfw=False, sort=120,
        ),
        _spec(
            "ace-music-legacy", "ACE 文生音乐(1.0)",
            "ACE-Step 1.0 旧版文生音乐工作流,可回退",
            icon="audio", category="audio", output_kind="audio",
            workflow_json=build_ace_step_graph(AceStepParams(tags="")),
            params_schema=[
                _positive("风格/流派标签", key="tags", label="风格标签"),
                _positive("歌词,留空=纯音乐", key="lyrics", label="歌词", required=False),
                _num("seconds", "时长(秒)", 30, min_=5, max_=240),
                _num("steps", "采样步数", 50, min_=10, max_=150),
                _num("cfg", "CFG", 5.0, min_=0, max_=20, step=0.5),
                _seed(),
            ],
            bindings={
                "tags": _b("3", "inputs.tags"),
                "lyrics": _b("3", "inputs.lyrics"),
                "seconds": _b("2", "inputs.seconds"),
                "steps": _b("5", "inputs.steps"),
                "cfg": _b("5", "inputs.cfg"),
                "seed": _b("5", "inputs.seed"),
            },
            is_nsfw=False, sort=121,
        ),
        # ----- 其他可诚实成图的存量工作流 -----
        _spec(
            "inpaint", "文字定向重绘",
            "Florence2 按文字分割目标区域后局部重绘,无需手绘蒙版",
            icon="eraser", category="edit", output_kind="image",
            workflow_json=build_inpaint_graph(InpaintParams(
                image="", target="the object", positive="",
            )),
            params_schema=[
                _images(label="源图"),
                _positive("要替换的区域(分割短语,如 the hat)",
                          key="target", label="目标区域"),
                _positive("该区域重绘成什么"),
                _num("denoise", "重绘幅度", 0.85, min_=0.1, max_=1.0, step=0.05),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("11", "inputs.image"),
                "target": _b("31", "inputs.text_input"),
                "positive": _b("6", "inputs.text"),
                "denoise": _b("3", "inputs.denoise"),
                "steps": _b("3", "inputs.steps"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=False, sort=200,
        ),
        _spec(
            "upscale", "图像放大",
            "4x-UltraSharp ESRGAN 放大(原生 4 倍)",
            icon="zoom-in", category="edit", output_kind="image",
            workflow_json=build_upscale_graph(UpscaleParams(image="")),
            params_schema=[_images(label="源图")],
            bindings={"images": _b("11", "inputs.image")},
            is_nsfw=False, sort=201,
        ),
        _spec(
            "removebg", "抠图去背",
            "rembg u2net 通用抠图,输出透明底 PNG",
            icon="scissors", category="edit", output_kind="image",
            workflow_json=build_removebg_graph(RemoveBgParams(image="")),
            params_schema=[_images(label="源图")],
            bindings={"images": _b("11", "inputs.image")},
            is_nsfw=False, sort=202,
        ),
        _spec(
            "controlnet", "ControlNet 控图",
            "Canny 控制图 + SD1.5 文生图(默认 control_v11p canny)",
            icon="layers", category="image", output_kind="image",
            workflow_json=build_controlnet_graph(ControlNetParams(
                positive="", image="",
            )),
            params_schema=[
                _images(label="控制图"),
                _positive("正向提示词"),
                _negative(),
                _num("strength", "控制强度", 0.8, min_=0.0, max_=2.0, step=0.05),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("10", "inputs.image"),
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "strength": _b("15", "inputs.strength"),
                "steps": _b("3", "inputs.steps"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=False, sort=203,
        ),
        _spec(
            "ipadapter", "IP-Adapter 参考出图",
            "IP-Adapter PLUS FACE:参考人像风格/身份 + 提示词出图",
            icon="user", category="image", output_kind="image",
            workflow_json=build_ipadapter_txt2img_graph(IPAdapterTxt2ImgParams(
                positive="", ref_image="",
            )),
            params_schema=[
                _images(label="参考人像"),
                _positive("正向提示词"),
                _negative(),
                _num("width", "宽度", 512, min_=256, max_=2048, step=64),
                _num("height", "高度", 512, min_=256, max_=2048, step=64),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("202", "inputs.image"),
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "width": _b("5", "inputs.width"),
                "height": _b("5", "inputs.height"),
                "steps": _b("3", "inputs.steps"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=False, sort=204,
        ),
        _spec(
            "pulid", "PuLID 身份出图",
            "PuLID-Flux:参考人脸保持身份的 Flux 文生图",
            icon="user", category="image", output_kind="image",
            workflow_json=build_pulid_txt2img_graph(PulidTxt2ImgParams(
                positive="", ref_image="",
            )),
            params_schema=[
                _images(label="参考人脸"),
                _positive("正向提示词"),
                _negative(),
                _num("width", "宽度", 1024, min_=256, max_=2048, step=64),
                _num("height", "高度", 1024, min_=256, max_=2048, step=64),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("304", "inputs.image"),
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "width": _b("5", "inputs.width"),
                "height": _b("5", "inputs.height"),
                "steps": _b("3", "inputs.steps"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=False, sort=205,
        ),
        _spec(
            "facedetailer", "脸部精修",
            "FaceDetailer:检测人脸后局部重绘修脸",
            icon="sparkles", category="edit", output_kind="image",
            workflow_json=build_facedetailer_graph(FaceDetailerParams(
                image="", positive="",
            )),
            params_schema=[
                _images(label="源图"),
                _positive("脸部重绘提示词"),
                _negative(),
                _num("denoise", "重绘幅度", 0.5, min_=0.1, max_=1.0, step=0.05),
                _num("steps", "采样步数", 20, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("11", "inputs.image"),
                "positive": _b("6", "inputs.text"),
                "negative": _b("7", "inputs.text"),
                "denoise": _b("22", "inputs.denoise"),
                "steps": _b("22", "inputs.steps"),
                "seed": _b("22", "inputs.seed"),
            },
            is_nsfw=False, sort=206,
        ),
        _spec(
            "hunyuan-i2v", "混元图生视频",
            "HunyuanVideo I2V:首帧图 + 提示词出 720p 短视频",
            icon="video", category="video", output_kind="video",
            workflow_json=build_hunyuan_i2v_graph(HunyuanI2VParams(
                positive="", image="",
            )),
            params_schema=[
                _images(label="首帧图"),
                _positive("动作与场景描述"),
                _num("steps", "采样步数", 10, min_=1, max_=50),
                _seed(),
            ],
            bindings={
                "images": _b("4", "inputs.image"),
                "positive": _b("5", "inputs.prompt"),
                "steps": _b("7", "inputs.steps"),
                "seed": _b("7", "inputs.seed"),
            },
            is_nsfw=False, sort=210,
        ),
        _spec(
            "latentsync", "LatentSync 对口型",
            "已有视频 + 音频 → LatentSync 口型同步(非 LTX 生成链路)",
            icon="mic", category="video", output_kind="video",
            workflow_json=build_latentsync_graph(LatentSyncParams(
                video="", audio="",
            )),
            params_schema=[
                _video(label="源视频"),
                _audio(label="驱动音频"),
                _seed(),
            ],
            bindings={
                "video": _b("1", "inputs.video"),
                "audio": _b("2", "inputs.audio"),
                "seed": _b("3", "inputs.seed"),
            },
            is_nsfw=False, sort=211,
        ),
    ]
    for spec in specs:
        _validate_spec(spec)
    specs.extend(expand_rh_h3_presets({s["id"]: s for s in specs}))
    return specs


def _validate_spec(spec: dict) -> None:
    """bindings 全量校验:节点在图内、字段叶子存在且为标量(上架即坏的防线的代码侧)。"""
    graph = spec["workflow_json"]
    schema_keys = {p["key"] for p in spec["params_schema"]}
    for key, target in spec["bindings"].items():
        if key not in schema_keys:
            raise ValueError(f"{spec['id']}: 绑定 {key} 在 params_schema 中无对应参数")
        slots = target if isinstance(target, list) else [target]
        if not slots:
            raise ValueError(f"{spec['id']}: 绑定 {key} 的列表不能为空")
        for t in slots:
            node = graph.get(t["node"])
            if not isinstance(node, dict):
                raise ValueError(f"{spec['id']}: 绑定 {key} 指向不存在的节点 {t['node']}")
            root, leaf = t["field"].split(".", 1)
            container = node.get(root)
            if root == "inputs":
                if not isinstance(container, dict) or leaf not in container:
                    raise ValueError(
                        f"{spec['id']}: 绑定 {key} 目标 {t['node']}.inputs.{leaf} 不存在"
                    )
                if isinstance(container[leaf], (dict, list)):
                    raise ValueError(
                        f"{spec['id']}: 绑定 {key} 目标 {t['node']}.inputs.{leaf} 是连线,不能绑表单"
                    )
            else:
                raise ValueError(
                    f"{spec['id']}: 绑定 {key} 的 field 根仅支持 inputs(API 图无 widgets_values)"
                )


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
