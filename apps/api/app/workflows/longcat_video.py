"""LongCat-Video 工作流构建 —— t2v(i2v 预留扩展位)。

节点结构/连线照搬真机已验证出片的 scripts/longcat_smoke.py build_graph():
  WanVideoLoraSelect(蒸馏加速 LoRA)→ WanVideoModelLoader(+ WanVideoBlockSwap 10 块)
  → WanVideoSampler(scheduler=longcat_distill_euler, cfg=1.0, shift=12.0)
  → WanVideoDecode → VHS_VideoCombine(h264-mp4)

关键约束(踩坑记录,勿改):
  · rope_function 必须 "comfy",否则采样报 4096 vs 128 维度错;
  · base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa"、
    force_offload=True —— GPU2 与 ASR/H3 共卡,全程 offload 控制峰值(实测 480p49f 峰值 21GB);
  · 蒸馏 LoRA 低步数出片(steps 默认 10);cfg 固定 1.0(蒸馏链路)。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;按实例实测文件名硬编码为默认值)
DEFAULT_MODEL = "LongCat/LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors"
DEFAULT_DISTILL_LORA = "LongCat_distill_lora_alpha64_bf16.safetensors"
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class LongCatT2VParams:
    """LongCat 文生视频参数。seed 缺省随机(与 ltx_video 同一惯例)。

    distill_lora 置空串则不挂蒸馏加速 LoRA(质量优先、步数需自行调高);
    model_name/t5_name/vae_name 暴露为字段,为后续 i2v / refinement LoRA 留扩展位。
    """

    positive: str
    negative: str = ""
    width: int = 832
    height: int = 480
    num_frames: int = 121  # 17-961;961 帧@16fps≈60s 单镜头
    steps: int = 10        # 蒸馏 LoRA 低步数;不挂蒸馏 LoRA 时建议 ≥ 20
    fps: int = 16          # 仅影响 VHS_VideoCombine 打包帧率
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    distill_lora: str = DEFAULT_DISTILL_LORA
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    filename_prefix: str = "ToIV_longcat/t2v"


def build_longcat_t2v_graph(p: LongCatT2VParams) -> dict:
    """参数 → ComfyUI API 格式图(节点 id 与 longcat_smoke.py 一致,便于对照)。"""
    graph: dict[str, dict] = {
        "2": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": 10, "offload_img_emb": True, "offload_txt_emb": True}},
        "3": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "disabled",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": ["1", 0] if p.distill_lora else None,
            "block_swap_args": ["2", 0]}},
        "4": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "5": {"class_type": "WanVideoTextEncode", "inputs": {
            "positive_prompt": p.positive,
            "negative_prompt": p.negative,
            "t5": ["4", 0]}},
        "6": {"class_type": "WanVideoEmptyEmbeds", "inputs": {
            "width": p.width, "height": p.height, "num_frames": p.num_frames}},
        "7": {"class_type": "WanVideoSampler", "inputs": {
            "model": ["3", 0], "image_embeds": ["6", 0], "text_embeds": ["5", 0],
            "steps": p.steps, "cfg": 1.0, "shift": 12.0, "seed": p.seed,
            "force_offload": True, "scheduler": "longcat_distill_euler",
            "riflex_freq_index": 0, "rope_function": "comfy"}},
        "8": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name, "precision": "bf16"}},
        "9": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["8", 0], "samples": ["7", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}},
        "10": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["9", 0], "frame_rate": p.fps, "loop_count": 0,
            "filename_prefix": p.filename_prefix, "format": "video/h264-mp4",
            "pix_fmt": "yuv420p", "crf": 19, "save_metadata": True,
            "trim_to_audio": False, "pingpong": False, "save_output": True}},
    }
    if p.distill_lora:
        graph["1"] = {"class_type": "WanVideoLoraSelect", "inputs": {
            "lora": p.distill_lora, "strength": 1.0,
            "low_mem_load": False, "merge_loras": False}}
    return graph
