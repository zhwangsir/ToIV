"""Wan2.1-VACE 14B 工作流构建 —— 多参考图(+可选首尾帧)→ 视频。

节点结构/连线照搬官方示例 wanvideo_1_3B_VACE_examples_03.json(:8197 实例 /object_info 实测),
差异:官方示例为 1.3B 主模型 + WanVideoVACEModelSelect 独立模块;本链路用
Comfy-Org repackaged 完整 14B 权重(已含 vace_blocks,kijai loader 自动检测,
nodes_model_loading.py:1325),无需 VACEModelSelect。

关键约束(踩坑记录,勿改):
  · rope_function 必须 "comfy"(同 LongCat,否则 4096 vs 128 维度错);
  · base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa"、
    quantization="fp8_e4m3fn"(fp16 权重运行时量化,等效 fp8 显存)—— GPU0 与 ComfyUI 池/LongCat 共卡;
  · num_frames 必须 4k+1(WanVideo 系时序网格);
  · 多参考图经 ImageConcatMulti(KJNodes,direction=right,match_image_size=True)合成 batch
    喂 WanVideoVACEEncode.ref_images;单张则直连,不走 concat(节点 inputcount≥2);
  · 首尾帧为可选支路:给了 start_image/end_image 才建 WanVideoVACEStartToEndFrame,
    其 images/masks 接 VACEEncode.input_frames/input_masks(官方示例连线)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;文件名按 :8197 /object_info 实测硬编码)
DEFAULT_MODEL = "wan2.1_vace_14B_fp16.safetensors"  # Comfy-Org repackaged 完整权重(含 VACE 模块)
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"

BLOCK_SWAP = 20  # 块交换(GPU2 共卡控制峰值)
MAX_REF_IMAGES = 4  # 多参考图上限(拼接 batch 喂 VACEEncode)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def snap_frames_4k1(v: int) -> int:
    """WanVideo 系帧数网格 (T-1)%4==0:向上取整到 4k+1。"""
    return (max(1, v) - 1 + 3) // 4 * 4 + 1


@dataclass(frozen=True)
class WanVaceParams:
    """Wan2.1-VACE 多参考图视频参数。seed 缺省随机(与 longcat 同一惯例)。

    ref_images 为 :8197 实例 input 目录文件名列表(路由层负责从 pool worker 转运),
    1-4 张;start_image/end_image 可选(首尾帧约束)。num_frames 自动取整 4k+1。
    """

    positive: str
    ref_images: tuple[str, ...]
    negative: str = ""
    start_image: str = ""
    end_image: str = ""
    width: int = 832
    height: int = 480
    num_frames: int = 81    # 17-241,自动取整 4k+1;81 帧@16fps≈5s
    steps: int = 20         # 官方示例 20 步(unipc)
    cfg: float = 5.0        # 官方示例 4-5 区间取 5
    shift: float = 8.0      # 官方示例值
    strength: float = 1.0   # VACE 条件强度(官方示例 1.0)
    fps: int = 16
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    filename_prefix: str = "ToIV_wan/vace"

    def __post_init__(self) -> None:
        object.__setattr__(self, "num_frames", snap_frames_4k1(self.num_frames))


def _ref_image_branch(graph: dict, p: WanVaceParams) -> list:
    """参考图支路:每张 LoadImage → ImageResizeKJv2(16 对齐 crop);
    多张经 ImageConcatMulti 合成 batch。返回喂 ref_images 的 [node, 0] 引用。"""
    resize_ids: list[str] = []
    for i, name in enumerate(p.ref_images):
        load_id = f"{20 + i * 2}"
        resize_id = f"{21 + i * 2}"
        graph[load_id] = {"class_type": "LoadImage", "inputs": {"image": name}}
        graph[resize_id] = {"class_type": "ImageResizeKJv2", "inputs": {
            "image": [load_id, 0], "width": p.width, "height": p.height,
            "upscale_method": "lanczos", "keep_proportion": "crop",
            "pad_color": "0, 0, 0", "crop_position": "center",
            "divisible_by": 16, "device": "cpu"}}
        resize_ids.append(resize_id)
    if len(resize_ids) == 1:
        return [resize_ids[0], 0]
    concat_inputs: dict = {
        "inputcount": len(resize_ids), "direction": "right", "match_image_size": True}
    for i, rid in enumerate(resize_ids, start=1):
        concat_inputs[f"image_{i}"] = [rid, 0]
    graph["30"] = {"class_type": "ImageConcatMulti", "inputs": concat_inputs}
    return ["30", 0]


def build_wan_vace_graph(p: WanVaceParams) -> dict:
    """参数 → ComfyUI API 格式图(节点语义对照官方示例 wanvideo_1_3B_VACE_examples_03)。"""
    if not p.ref_images:
        raise ValueError("VACE 链路至少需要 1 张参考图")
    if len(p.ref_images) > MAX_REF_IMAGES:
        raise ValueError(f"VACE 参考图最多 {MAX_REF_IMAGES} 张")

    graph: dict[str, dict] = {
        "1": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "fp8_e4m3fn",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "block_swap_args": ["2", 0]}},
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": BLOCK_SWAP, "offload_img_emb": True, "offload_txt_emb": True,
            # optional 缺省不会注入默认值 → vace_blocks_to_swap=None 会炸 TypeError
            # (同 wan_animate.py 踩坑,2026-08-13 冒烟实测);VACE 模型 vace_blocks 15 个,
            # 共卡给 8 个交换(官方 1.3B 示例全换 15)
            "use_non_blocking": True, "vace_blocks_to_swap": 8,
            "prefetch_blocks": 1, "block_swap_debug": False}},
        "3": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": p.positive,
            "negative_prompt": p.negative,
            "t5": ["4", 0]}},
        "13": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["1", 0], "text_embeds": ["5", 0], "image_embeds": ["10", 0],
            "steps": p.steps, "cfg": p.cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": "unipc",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "14": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["3", 0], "samples": ["13", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "15": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["14", 0], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }

    # 参考图支路(节点 20/21/22/... + 可选 concat 30)
    vace_inputs: dict = {
        "vae": ["3", 0], "ref_images": _ref_image_branch(graph, p),
        "width": p.width, "height": p.height, "num_frames": p.num_frames,
        "strength": p.strength, "vace_start_percent": 0.0, "vace_end_percent": 1.0}

    # 可选首尾帧支路(官方示例:StartToEndFrame → input_frames/input_masks)
    if p.start_image or p.end_image:
        if p.start_image:
            graph["40"] = {"class_type": "LoadImage", "inputs": {"image": p.start_image}}
            graph["41"] = {"class_type": "ImageResizeKJv2", "inputs": {
                "image": ["40", 0], "width": p.width, "height": p.height,
                "upscale_method": "lanczos", "keep_proportion": "crop",
                "pad_color": "0, 0, 0", "crop_position": "center",
                "divisible_by": 16, "device": "cpu"}}
        if p.end_image:
            graph["42"] = {"class_type": "LoadImage", "inputs": {"image": p.end_image}}
            graph["43"] = {"class_type": "ImageResizeKJv2", "inputs": {
                "image": ["42", 0], "width": p.width, "height": p.height,
                "upscale_method": "lanczos", "keep_proportion": "crop",
                "pad_color": "0, 0, 0", "crop_position": "center",
                "divisible_by": 16, "device": "cpu"}}
        s2e_inputs: dict = {"num_frames": p.num_frames, "empty_frame_level": 0.5}
        if p.start_image:
            s2e_inputs["start_image"] = ["41", 0]
        if p.end_image:
            s2e_inputs["end_image"] = ["43", 0]
        graph["44"] = {"class_type": "WanVideoVACEStartToEndFrame", "inputs": s2e_inputs}
        vace_inputs["input_frames"] = ["44", 0]
        vace_inputs["input_masks"] = ["44", 1]

    graph["10"] = {"class_type": "WanVideoVACEEncode", "inputs": vace_inputs}
    return graph
