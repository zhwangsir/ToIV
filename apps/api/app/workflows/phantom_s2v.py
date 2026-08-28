"""Phantom-Wan-14B 角色一致性视频(Subject-to-Video)工作流构造器。

节点结构/连线照搬 Kijai WanVideoWrapper 官方示例
example_workflows/wanvideo_2_1_14B_phantom_subject2vid_example_02.json
(workstation :8197 实例实测节点,2026-08-28):
  LoadImage×N → ImageResizeKJv2(lanczos, **pad 白边 255,255,255**, divisible 16)
    → WanVideoEncode(vae) → phantom_latent_N(N=1..4)
  WanVideoPhantomEmbeds(num_frames, phantom_latent_1..4, phantom_cfg_scale, 0→1)
  WanVideoModelLoader(Phantom fp8, offload) ← WanVideoBlockSwap(20) [+ WanVideoLoraSelect 蒸馏]
  LoadWanVideoT5TextEncoder → WanVideoTextEncode
  WanVideoSampler → WanVideoDecode → VHS_VideoCombine(h264-mp4)

关键约束(示例实测 + 集群踩坑,勿改):
  · 参考图缩放模式必须 pad(白边),crop 会把主体特征裁掉(官方示例明确 pad);
  · rope_function 必须 "comfy"(E-2:WanVideoWrapper 默认 rope 会 4096 vs 128 维度错);
  · 加速档 accel="turbo"(默认,示例蒸馏配置):lightx2v T2V v2 蒸馏 LoRA rank64 强度 0.8、
    steps=8、cfg=1.0、scheduler=dpm++_sde、phantom_cfg_scale=2.0(示例值);
  · 满血档 accel="off":不挂蒸馏,steps=30、cfg=5.0、scheduler=unipc、
    phantom_cfg_scale=5.0(节点默认,官方 infer.sh guide_scale);
  · shift=5.0(Wan2.1 480p 训练甜点,与 wan_t2v 一致);
  · num_frames 4n+1(Phantom 节点 step=4,与 Wan VAE 帧网格一致)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# Wan 官方推荐负面提示词(与 wan_i2v 同源)
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)

# 模型资产(:8197 实例 extra_model_paths 指向 NAS,平铺根目录,勿入子目录)
DEFAULT_MODEL = "Phantom-Wan-14B_fp8_e4m3fn.safetensors"
DEFAULT_DISTILL_LORA = "lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors"
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"

# 参考图硬上限(Phantom 节点 phantom_latent_1..4)
MAX_REF_IMAGES = 4
# 块交换(官方示例值;GPU0 与 ComfyUI#1/LongCat 共卡,offload 控峰值)
BLOCK_SWAP = 20


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def snap_frames(v: int) -> int:
    """帧数吸附到 4n+1 网格(Phantom/Wan VAE 硬要求),向下取整,最低 17。"""
    return max(17, (v - 1) // 4 * 4 + 1)


@dataclass(frozen=True)
class PhantomS2VParams:
    """Phantom Subject-to-Video 参数。seed 缺省随机(与 longcat/ltx 同一惯例)。

    images:实例 input 目录文件名元组(1-4 张,路由层负责转运后填入);
    accel: turbo=蒸馏 8 步草稿(默认) / off=满血 30 步成片;
    steps/cfg/phantom_cfg_scale 显式给定时覆盖档位默认(与 wan_i2v 同风格)。
    """

    positive: str
    images: tuple[str, ...]
    negative: str = DEFAULT_NEGATIVE
    width: int = 832
    height: int = 480
    num_frames: int = 81  # 4n+1;81 帧@16fps≈5s
    accel: str = "turbo"  # turbo=蒸馏 8 步 / off=满血 30 步
    steps: int | None = None  # None=按档默认(turbo 8 / off 30)
    cfg: float | None = None  # None=按档默认(turbo 1.0 / off 5.0)
    phantom_cfg_scale: float | None = None  # None=按档默认(turbo 2.0 / off 5.0)
    shift: float = 5.0
    fps: int = 16  # 仅影响 VHS_VideoCombine 打包帧率
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    distill_lora: str = DEFAULT_DISTILL_LORA
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    block_swap: int = BLOCK_SWAP
    filename_prefix: str = "ToIV_phantom"

    def __post_init__(self) -> None:
        if not 1 <= len(self.images) <= MAX_REF_IMAGES:
            raise ValueError(f"参考图数量须 1-{MAX_REF_IMAGES} 张(实收 {len(self.images)})")
        if self.accel not in ("turbo", "off"):
            raise ValueError(f"未知 Phantom 加速档: {self.accel!r}(可选 turbo/off)")


def _resolve_sampling(p: PhantomS2VParams) -> tuple[int, float, float, str, bool]:
    """加速档 → (steps, cfg, phantom_cfg_scale, scheduler, use_distill_lora)。

    - turbo:示例蒸馏配置(8 步/cfg1/dpm++_sde/phantom_cfg 2.0/挂蒸馏 LoRA)
    - off:  满血(30 步/cfg5/unipc/phantom_cfg 5.0/不挂蒸馏)
    """
    if p.accel == "turbo":
        return (
            p.steps if p.steps is not None else 8,
            p.cfg if p.cfg is not None else 1.0,
            p.phantom_cfg_scale if p.phantom_cfg_scale is not None else 2.0,
            "dpm++_sde",
            True,
        )
    return (
        p.steps if p.steps is not None else 30,
        p.cfg if p.cfg is not None else 5.0,
        p.phantom_cfg_scale if p.phantom_cfg_scale is not None else 5.0,
        "unipc",
        False,
    )


def build_phantom_s2v_graph(p: PhantomS2VParams) -> dict:
    """参数 → ComfyUI API 格式图(节点 id 静态 1-14 + 参考图链 20 起动态)。"""
    steps, cfg, phantom_cfg, scheduler, use_lora = _resolve_sampling(p)
    g: dict[str, dict] = {
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": p.block_swap, "offload_img_emb": False, "offload_txt_emb": False}},
        "3": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "fp16_fast", "quantization": "disabled",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": ["1", 0] if use_lora else None,
            "block_swap_args": ["2", 0]}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": p.positive,
            "negative_prompt": p.negative,
            "t5": ["4", 0]}},
        "8": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "7": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["3", 0], "image_embeds": ["6", 0], "text_embeds": ["5", 0],
            "steps": steps, "cfg": cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": scheduler,
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "9": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["8", 0], "samples": ["7", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "10": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["9", 0], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }
    if use_lora:
        g["1"] = {"class_type": "WanVideoLoraSelect", "inputs": {
            "lora": p.distill_lora, "strength": 0.8,
            "low_mem_load": False, "merge_loras": False}}

    # 参考图链(官方示例:LoadImage → pad 白边缩放 → VAE 编码 → phantom_latent_N)
    phantom_inputs: dict = {
        "num_frames": p.num_frames,
        "phantom_cfg_scale": phantom_cfg,
        "phantom_start_percent": 0.0,
        "phantom_end_percent": 1.0,
    }
    node_id = 20
    for i, image in enumerate(p.images):
        load_id, resize_id, encode_id = str(node_id), str(node_id + 1), str(node_id + 2)
        node_id += 3
        g[load_id] = {"class_type": "LoadImage", "inputs": {"image": image}}
        g[resize_id] = {"class_type": "ImageResizeKJv2", "inputs": {
            "image": [load_id, 0],
            "width": p.width, "height": p.height,
            "upscale_method": "lanczos", "keep_proportion": "pad",
            "pad_color": "255, 255, 255", "crop_position": "center",
            "divisible_by": 16, "device": "cpu"}}
        g[encode_id] = {"class_type": "WanVideoEncode", "inputs": {
            "vae": ["8", 0], "image": [resize_id, 0],
            "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128,
            "noise_aug_strength": 0.0, "latent_strength": 1.0}}
        phantom_inputs[f"phantom_latent_{i + 1}"] = [encode_id, 0]
    g["6"] = {"class_type": "WanVideoPhantomEmbeds", "inputs": phantom_inputs}
    return g
