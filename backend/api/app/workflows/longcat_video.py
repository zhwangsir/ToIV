"""LongCat-Video 工作流构建 —— t2v / i2v / 视频续写(复用 i2v 图)。

节点结构/连线照搬真机已验证出片的 scripts/e2e/longcat_smoke.py build_graph():
  WanVideoLoraSelect(蒸馏加速 LoRA)→ WanVideoModelLoader(+ WanVideoBlockSwap 10 块)
  → WanVideoSampler(scheduler=longcat_distill_euler, cfg=1.0, shift=12.0)
  → WanVideoDecode → VHS_VideoCombine(h264-mp4)
i2v 首帧连线照搬官方示例 LongCat_TI2V_example_01.json(实例 :8197 实测节点):
  LoadImage → ImageResizeKJv2(crop 到目标分辨率)→ WanVideoEncode
  → WanVideoEmptyEmbeds.extra_latents(示例 note:For T2V disconnect the extra_latents)

关键约束(踩坑记录,勿改):
  · rope_function 必须 "comfy",否则采样报 4096 vs 128 维度错;
  · base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa"、
    force_offload=True —— GPU2 与 ASR/H3 共卡,全程 offload 控制峰值(实测 480p49f 峰值 21GB);
  · 蒸馏 LoRA 低步数出片(steps 默认 10);cfg 固定 1.0(蒸馏链路);
  · 长帧数(num_frames > CONTEXT_WINDOW_THRESHOLD)自动加 WanVideoContextOptions
    (81 帧/overlap 16)并把块交换 10→30 —— P1b 压测 961 帧不开窗直接 OOM
    (66GB+13GB),开窗+块交换30 后显存恒定 ~21.7GB;≤241 帧保持 10 块交换即可。
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

# 长帧数自动上下文窗口(P1b 压测经验)
CONTEXT_WINDOW_THRESHOLD = 241  # >241 帧必须开窗;≤121 帧实测无需开窗,留一档余量
CONTEXT_FRAMES = 81             # 上下文窗口帧数(压测值)
CONTEXT_OVERLAP = 16            # 窗口重叠帧数(压测值)
BLOCK_SWAP_SHORT = 10           # 短片块交换
BLOCK_SWAP_LONG = 30            # 开窗长片块交换(压测值)


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


@dataclass(frozen=True)
class LongCatI2VParams(LongCatT2VParams):
    """LongCat 图生视频参数:在 t2v 基础上加首帧参考图(实例 input 目录文件名)。

    视频续写复用本结构:服务端先把源视频末帧抽成图传进实例,再按 i2v 提交。
    image 默认空串仅为 dataclass 字段顺序(路由层 min_length=1 强制非空)。
    """

    image: str = ""
    filename_prefix: str = "ToIV_longcat/i2v"


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
    _apply_context_window(graph, p.num_frames)
    return graph


def _apply_context_window(graph: dict, num_frames: int) -> None:
    """长帧数自动开上下文窗口:>CONTEXT_WINDOW_THRESHOLD 帧加 WanVideoContextOptions
    (81 帧/overlap 16,uniform_standard)并把块交换 10→30;≤阈值保持现状。

    P1b 压测:961 帧不开窗 OOM(66GB 已分配+13GB 请求);开窗+块交换30 显存恒定
    ~21.7GB(720p 峰值 29GB 出现在解码期)。对 t2v/i2v/续写统一生效。
    """
    if num_frames <= CONTEXT_WINDOW_THRESHOLD:
        return
    graph["2"]["inputs"]["blocks_to_swap"] = BLOCK_SWAP_LONG
    graph["14"] = {"class_type": "WanVideoContextOptions", "inputs": {
        "context_schedule": "uniform_standard",
        "context_frames": CONTEXT_FRAMES,
        "context_stride": 4,
        "context_overlap": CONTEXT_OVERLAP,
        "freenoise": True,
        "verbose": False}}
    graph["7"]["inputs"]["context_options"] = ["14", 0]


def build_longcat_i2v_graph(p: LongCatI2VParams) -> dict:
    """i2v 图:t2v 骨架 + 首帧编码支路(节点 11/12/13,编号接 t2v 之后便于对照)。

    连线照搬官方示例 LongCat_TI2V_example_01.json(:8197 实例 /object_info 核实):
    首帧 LoadImage → ImageResizeKJv2(lanczos/crop 到生成分辨率,16 对齐)
    → WanVideoEncode(VAE 编码)→ WanVideoEmptyEmbeds.extra_latents。
    """
    graph = build_longcat_t2v_graph(p)  # 子类参数透传(含自动上下文窗口)
    graph["6"]["inputs"]["extra_latents"] = ["13", 0]
    graph["11"] = {"class_type": "LoadImage", "inputs": {"image": p.image}}
    graph["12"] = {"class_type": "ImageResizeKJv2", "inputs": {
        "image": ["11", 0], "width": p.width, "height": p.height,
        "upscale_method": "lanczos", "keep_proportion": "crop",
        "pad_color": "0, 0, 0", "crop_position": "center",
        "divisible_by": 16, "device": "cpu"}}
    graph["13"] = {"class_type": "WanVideoEncode", "inputs": {
        "vae": ["8", 0], "image": ["12", 0], "enable_vae_tiling": False,
        "tile_x": 272, "tile_y": 272, "tile_stride_x": 144, "tile_stride_y": 128}}
    return graph
