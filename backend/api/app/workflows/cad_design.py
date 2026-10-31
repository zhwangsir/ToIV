"""CAD 设计出图工作流构造器(纯函数)。POC 实测:RealVisXL + Union ControlNet(canny)。

输出预设(preset):
  colored_plan  强控形(0.92)→ 俯视着色平面图
  aerial_day/dusk/night  松控形(0.5)→ 45°上帝视角航拍,日/黄昏/夜风格切换
  interior      text2img(不控形)→ 室内实景

space:被渲染空间类型(modern data center / residential apartment / office …),插进提示词。
style:风格修饰(轻奢/老钱/极简/工业…的英文片段),追加到 prompt 末尾(室内/航拍可用)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1
CKPT = "RealVisXL_V5.0_fp16.safetensors"
UNION = "controlnet-union-sdxl-1.0-promax.safetensors"

_NEG = "blurry, lowres, distorted, deformed, text, watermark, signature, people, oversaturated, jpeg artifacts"

# preset → (prompt 模板, negative, controlnet 强度, end_percent, 用 controlnet?)
PRESETS: dict[str, dict] = {
    "colored_plan": {
        "pos": "colorful architectural floor plan diagram of a {space}, top down orthographic flat 2D view, solid color filled zones, color coded rooms and areas, light grey corridors, clean technical presentation drawing, vector illustration, labeled",
        "neg": "perspective, 3d, isometric, photograph, realistic photo, server rack closeup, shadows, depth, people, blurry, lowres",
        "strength": 0.92, "end": 1.0, "control": True,
    },
    "aerial_day": {
        "pos": "aerial drone photograph of a {space}, birds eye top down view, buildings with detailed roofs, access roads with cars, parking, green landscaping and trees, bright clear sunny day, ultra realistic architectural photography, sharp, high detail, 8k",
        "neg": _NEG, "strength": 0.5, "end": 0.5, "control": True,
    },
    "aerial_dusk": {
        "pos": "aerial drone photograph of a {space}, birds eye view, detailed roofs, roads and parking, landscaping, golden hour sunset warm dramatic light, long shadows, ultra realistic, 8k",
        "neg": _NEG, "strength": 0.5, "end": 0.5, "control": True,
    },
    "aerial_night": {
        "pos": "aerial night photograph of a {space}, illuminated facade and roof lights, glowing windows, lit roads and parking lights, dark blue night sky, cinematic, ultra realistic, 8k",
        "neg": _NEG, "strength": 0.5, "end": 0.5, "control": True,
    },
    "interior": {
        "pos": "interior of a {space}, photorealistic architectural visualization, dramatic cinematic lighting, wide angle, polished floor reflections, ultra realistic, high detail, 8k",
        "neg": _NEG, "strength": 0.0, "end": 0.0, "control": False,
    },
}


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class CadParams:
    preset: str  # PRESETS 的键
    control_image: str = ""  # worker input 里的控制图文件名(controlnet preset 必填)
    space: str = "modern data center facility"
    style: str = ""  # 风格英文片段,追加到 prompt(可空)
    width: int = 1344
    height: int = 768
    steps: int = 32
    cfg: float = 5.5
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_cad"

    def __post_init__(self) -> None:
        if self.preset not in PRESETS:
            raise ValueError(f"未知 preset: {self.preset!r};可选 {tuple(PRESETS)}")
        if PRESETS[self.preset]["control"] and not self.control_image:
            raise ValueError(f"preset {self.preset} 需要 control_image")


def build_cad_graph(p: CadParams) -> dict:
    """编译成 ComfyUI API 格式 prompt 图。每次返回新 dict。"""
    cfg = PRESETS[p.preset]
    pos = cfg["pos"].format(space=p.space)
    if p.style.strip():
        pos = f"{pos}, {p.style.strip()} style"
    g: dict = {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": CKPT}},
        "5": {"class_type": "EmptyLatentImage", "inputs": {"width": p.width, "height": p.height, "batch_size": 1}},
        "6": {"class_type": "CLIPTextEncode", "inputs": {"text": pos, "clip": ["4", 1]}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": cfg["neg"], "clip": ["4", 1]}},
        "8": {"class_type": "VAEDecode", "inputs": {"samples": ["3", 0], "vae": ["4", 2]}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0], "filename_prefix": p.filename_prefix}},
    }
    if not cfg["control"]:
        # text2img(室内)
        g["3"] = {"class_type": "KSampler", "inputs": {
            "model": ["4", 0], "positive": ["6", 0], "negative": ["7", 0], "latent_image": ["5", 0],
            "seed": p.seed, "steps": p.steps, "cfg": p.cfg, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0}}
        return g
    # ControlNet(彩平/航拍)
    g["10"] = {"class_type": "LoadImage", "inputs": {"image": p.control_image}}
    g["12"] = {"class_type": "CannyEdgePreprocessor", "inputs": {"image": ["10", 0], "resolution": max(p.width, p.height)}}
    g["13"] = {"class_type": "ControlNetLoader", "inputs": {"control_net_name": UNION}}
    g["14"] = {"class_type": "SetUnionControlNetType", "inputs": {"control_net": ["13", 0], "type": "canny/lineart/anime_lineart/mlsd"}}
    g["15"] = {"class_type": "ControlNetApplyAdvanced", "inputs": {
        "positive": ["6", 0], "negative": ["7", 0], "control_net": ["14", 0], "image": ["12", 0],
        "strength": cfg["strength"], "start_percent": 0.0, "end_percent": cfg["end"]}}
    g["3"] = {"class_type": "KSampler", "inputs": {
        "model": ["4", 0], "positive": ["15", 0], "negative": ["15", 1], "latent_image": ["5", 0],
        "seed": p.seed, "steps": p.steps, "cfg": p.cfg, "sampler_name": "dpmpp_2m", "scheduler": "karras", "denoise": 1.0}}
    return g
