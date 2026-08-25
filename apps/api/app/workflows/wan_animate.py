"""Wan2.2-Animate 14B 工作流构建 —— 参考图角色 + 驱动视频 → 动作迁移视频。

节点结构/连线照搬官方示例 wanvideo_WanAnimate_example_01.json(:8197 实例 /object_info 实测):
  VHS_LoadVideo(驱动视频)→ WanVideoUniAnimateDWPoseDetector(wrapper 自带姿态提取,
  不依赖 controlnet_aux 的 DWPreprocessor)→ WanVideoAnimateEmbeds
  (+ CLIPVisionLoader/WanVideoClipVisionEncode 参考图语义 → WanVideoSampler → WanVideoDecode)

关键约束(踩坑记录,勿改):
  · rope_function 必须 "comfy"(同 LongCat,否则 4096 vs 128 维度错);
  · base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa"、
    quantization="fp8_e4m3fn"(bf16 合并权重运行时量化,等效 fp8 权重显存 ~16-20GB)
    —— GPU0 与 ComfyUI 池/LongCat 共卡,全程 offload 控制峰值;
  · 姿态提取用 wrapper 自带 WanVideoUniAnimateDWPoseDetector(yolox+dwpose 已预置
    custom_nodes/ComfyUI-WanVideoWrapper/unianimate/models/DWPose/);官方示例的
    DWPreprocessor(controlnet_aux):8197 未安装,不可换用;
  · num_frames 必须 4k+1(WanVideo 系时序网格);驱动视频经 VHS_LoadVideo
    frame_load_cap 同步截断到同一帧数,保证姿态序列与生成帧数一致;
  · relight_lora 置空串则不挂重打光 LoRA(Animation 模式默认不需要;
    Replacement 模式换背景时才需要)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;文件名按 :8197 /object_info 实测硬编码)
DEFAULT_MODEL = "wan2.2_animate_14B_bf16.safetensors"  # 官方 4 分片流式合并,见 roadmap R2.1
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"
DEFAULT_CLIP_VISION = "clip_vision_h.safetensors"  # ComfyUI 转换版(.pth 原始格式 CLIPVisionLoader 无法解析,2026-08-13 冒烟实测)
DEFAULT_RELIGHT_LORA = "WanAnimate_relight_lora.ckpt"

BLOCK_SWAP = 25  # 块交换(官方示例值;GPU2 共卡控制峰值)
FRAME_WINDOW = 77  # Animate 时序注意力窗口(官方示例值)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def snap_frames_4k1(v: int) -> int:
    """WanVideo 系帧数网格 (T-1)%4==0:向上取整到 4k+1(与 avatar 续段同一约束)。"""
    return (max(1, v) - 1 + 3) // 4 * 4 + 1


@dataclass(frozen=True)
class WanAnimateParams:
    """Wan2.2-Animate 动作迁移参数。seed 缺省随机(与 longcat 同一惯例)。

    image/video 为 :8197 实例 input 目录文件名(路由层负责从 pool worker 转运)。
    num_frames 自动取整 4k+1;驱动视频被截断到该帧数(frame_load_cap)。
    """

    positive: str
    image: str          # 参考图(角色形象)
    video: str          # 驱动视频(动作来源)
    negative: str = ""
    width: int = 832
    height: int = 480
    num_frames: int = 121   # 17-501,自动取整 4k+1;121 帧@16fps≈7.5s
    steps: int = 6          # 官方示例 6 步(dpm++_sde 低步数出片)
    cfg: float = 1.0        # 官方示例值
    shift: float = 5.0      # 官方示例值
    fps: int = 16           # VHS_LoadVideo force_rate 与打包帧率同源
    seed: int = field(default_factory=_random_seed)
    relight_lora: str = ""  # 空 = 不挂重打光 LoRA(Replacement 模式才需要)
    model_name: str = DEFAULT_MODEL
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    clip_vision_name: str = DEFAULT_CLIP_VISION
    filename_prefix: str = "ToIV_wan/animate"

    def __post_init__(self) -> None:
        object.__setattr__(self, "num_frames", snap_frames_4k1(self.num_frames))


def build_wan_animate_graph(p: WanAnimateParams) -> dict:
    """参数 → ComfyUI API 格式图(节点语义对照官方示例 wanvideo_WanAnimate_example_01)。"""
    graph: dict[str, dict] = {
        "1": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "fp8_e4m3fn",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": ["16", 0] if p.relight_lora else None,
            "block_swap_args": ["2", 0]}},
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": BLOCK_SWAP, "offload_img_emb": True, "offload_txt_emb": True,
            # optional 缺省不会注入 INPUT_TYPES 默认值(API 模式)→ vace_blocks_to_swap=None
            # 会让 model.py `vace_blocks_to_swap > 0` 炸 TypeError(2026-08-13 冒烟实测);
            # 显式给 0(Animate 非 VACE 模型,vace_layers=None,0→1 后安全跳过),其余对齐官方示例
            "use_non_blocking": True, "vace_blocks_to_swap": 0,
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
        # 参考图支路:LoadImage → 16 对齐 crop → CLIP 视觉编码 + ref_images
        "6": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "7": {"class_type": "ImageResizeKJv2", "inputs": {
            "image": ["6", 0], "width": p.width, "height": p.height,
            "upscale_method": "lanczos", "keep_proportion": "crop",
            "pad_color": "0, 0, 0", "crop_position": "center",
            "divisible_by": 16, "device": "cpu"}},
        "8": {"class_type": "CLIPVisionLoader", "inputs": {
            "clip_name": p.clip_vision_name}},
        "9": {"class_type": "WanVideoClipVisionEncode", "inputs": {
            "clip_vision": ["8", 0], "image_1": ["7", 0],
            "strength_1": 1.0, "strength_2": 1.0, "crop": "center",
            "combine_embeds": "average", "force_offload": True}},
        # 驱动视频支路:VHS_LoadVideo(帧数截断同步)→ wrapper 自带姿态提取
        "10": {"class_type": "VHS_LoadVideo", "inputs": {
            "video": p.video, "force_rate": p.fps,
            "custom_width": p.width, "custom_height": p.height,
            "frame_load_cap": p.num_frames, "skip_first_frames": 0,
            "select_every_nth": 1, "format": "AnimateDiff"}},
        "11": {"class_type": "WanVideoUniAnimateDWPoseDetector", "inputs": {
            "pose_images": ["10", 0], "score_threshold": 0.3, "stick_width": 4,
            "draw_body": True, "body_keypoint_size": 4,
            "draw_feet": True, "draw_hands": True, "hand_keypoint_size": 4,
            "colorspace": "RGB", "handle_not_detected": "empty", "draw_head": True}},
        # Animate 条件组装(Animation 模式:ref + pose;face/bg/mask 为 Replacement 支路,不接)
        "12": {"class_type": "WanVideoAnimateEmbeds", "inputs": {
            "vae": ["3", 0], "clip_embeds": ["9", 0],
            "ref_images": ["7", 0], "pose_images": ["11", 0],
            "width": p.width, "height": p.height, "num_frames": p.num_frames,
            "force_offload": True, "frame_window_size": FRAME_WINDOW,
            "colormatch": "disabled", "pose_strength": 1.0, "face_strength": 1.0}},
        "13": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["1", 0], "image_embeds": ["12", 0], "text_embeds": ["5", 0],
            "steps": p.steps, "cfg": p.cfg, "shift": p.shift, "seed": p.seed,
            "force_offload": True, "scheduler": "dpm++_sde",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "14": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["3", 0], "samples": ["13", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        # audio=[10,2]:驱动视频原声回打包(VHS_LoadVideo 无音轨时该输出为空,节点容忍)
        "15": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["14", 0], "audio": ["10", 2], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }
    if p.relight_lora:
        graph["16"] = {"class_type": "WanVideoLoraSelectMulti", "inputs": {
            "lora_0": p.relight_lora, "strength_0": 1.0,
            "lora_1": "none", "strength_1": 1.0,
            "lora_2": "none", "strength_2": 1.0,
            "lora_3": "none", "strength_3": 1.0,
            "low_mem_load": False, "merge_loras": False}}
    return graph
