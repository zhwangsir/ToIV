"""LongCat-Avatar 音频驱动数字人工作流构建(专用 ComfyUI 实例 :8197)。

节点结构/连线照搬真机冒烟通过的 workstation /tmp/longcat_avatar_smoke.py(v1.5 链路):
  LoadImage → ImageResizeKJv2(crop 到目标分辨率)→ WanVideoEncode 首帧编码
  LoadAudio → MelBandRoFormerSampler(人声分离)→ LongCatAvatarWhisperEmbeds
    (whisper-large-v3 特征,fps=25/audio_stride=1)
  WanVideoLoraSelect(dmd 蒸馏 LoRA)→ WanVideoModelLoader(GGUF Q8_0,+ WanVideoBlockSwap 25)
  → WanVideoLongCatAvatarExtendEmbeds(首帧 latents + 音频 embeds 融合)
  → WanVideoSamplerv2(scheduler=longcat_distill_euler)→ WanVideoDecode
  → VHS_VideoCombine(h264-mp4,带原音频)

关键约束(踩坑记录,勿改):
  · 音频编码必须 whisper-large-v3(WhisperModelLoader):v1.0 旧路线 wav2vec2 与
    v1.5 的 AudioProjModel 维度不匹配(报 mat1/mat2 维度错);
  · WanVideoModelLoader 用 GGUF Q8_0(diffusion_models/LongCat-Avatar/),
    base_precision="bf16"、load_device="offload_device"、attention_mode="sdpa",
    块交换固定 25(冒烟 480×832/93 帧峰值 ~20GB,可与 GPU2 ASR/demucs 共存);
  · DMD2 蒸馏 LoRA 低步数出片(steps 默认 8,官方 8 NFE 规格;旧默认 12 可经
    请求参数显式回退);cfg 默认 1.0(蒸馏链路);
  · 长音频自动续段:num_frames > WINDOW_FRAMES(93)时按官方示例
    LongCatAvatar_audio_image_to_video_example_01.json 的链式形态自动切多段——
    第 N 段 ExtendEmbeds(prev_latents=上一段采样器输出,ref_latent=首帧 latents,
    prev_images=上一段解码帧 + vae 走 v1.5 重编码 overlap,frames_processed 累计),
    段间 ImageBatchExtendWithOverlap(overlap=13/new_images/cut)拼帧后进 VHS。
    官方示例用 GetNode/SetNode(UI 虚拟连线,API JSON 下无效),此处等价改为直连。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;按实例实测文件名硬编码为默认值)
DEFAULT_MODEL = "LongCat-Avatar/LongCat-Avatar-15_comfy-Q8_0.gguf"
DEFAULT_DMD_LORA = "LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors"
DEFAULT_T5 = "umt5-xxl-enc-fp8_e4m3fn.safetensors"
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"
DEFAULT_WHISPER = "whisper-large-v3.safetensors"          # audio_encoders 类目
DEFAULT_VOCAL_SEP = "MelBandRoformer_fp32.safetensors"     # diffusion_models 类目

# 冒烟脚本实测负向提示词(数字人口型链路通用负向,作为请求缺省值)
DEFAULT_NEGATIVE = (
    "色调艳丽,过曝,静态,细节模糊不清,字幕,风格,作品,画作,画面,静止,整体发灰,"
    "最差质量,低质量,JPEG压缩残留,丑陋的,残缺的,多余的手指,画得不好的手部,"
    "画得不好的脸部,畸形的,毁容的,形态畸形的肢体,手指融合,静止不动的画面,"
    "杂乱的背景,三条腿,背景人很多,倒着走"
)

BLOCK_SWAP = 25  # 冒烟压测值(GPU2 峰值 ~20GB)

# 续段开窗(官方示例 frames_per_window=93 / overlap=13):
# 每段采样 WINDOW_FRAMES 帧,续段前 WINDOW_OVERLAP 帧为 warmup(用上一段真实
# 解码帧重编码垫底),拼帧时切掉 → 每续一段净增 WINDOW_FRAMES - WINDOW_OVERLAP 帧
WINDOW_FRAMES = 93
WINDOW_OVERLAP = 13


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


@dataclass(frozen=True)
class LongCatAvatarParams:
    """LongCat-Avatar 数字人参数。seed 缺省随机(与 longcat_video 同一惯例)。

    image/audio 为实例 input 目录文件名(路由层负责从上传落点 worker 转运);
    model/whisper 等模型文件名为扩展位,默认与冒烟脚本一致。
    """

    positive: str
    image: str
    audio: str
    negative: str = DEFAULT_NEGATIVE
    width: int = 480
    height: int = 832
    num_frames: int = 93  # 93 帧@25fps≈3.7s(冒烟验证值)
    fps: int = 25         # WhisperEmbeds 特征帧率与 VHS 打包帧率同源
    steps: int = 8        # DMD2 蒸馏 LoRA 官方 8 NFE(旧默认 12,请求参数可回退)
    shift: float = 12.0
    cfg: float = 1.0      # 蒸馏链路
    dmd_lora_strength: float = 1.0
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    dmd_lora: str = DEFAULT_DMD_LORA
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    whisper_name: str = DEFAULT_WHISPER
    vocal_sep_name: str = DEFAULT_VOCAL_SEP
    filename_prefix: str = "ToIV_avatar/talk"


def plan_segments(total_frames: int) -> list[int]:
    """总帧数 → 每段采样帧数列表(首段=窗口,仅末段可为残段)。

    续段净增 WINDOW_FRAMES - WINDOW_OVERLAP 帧(warmup 帧拼帧时切掉),
    故段数 N = 1 + ceil((total - WINDOW_FRAMES) / (WINDOW_FRAMES - WINDOW_OVERLAP))。
    """
    if total_frames <= WINDOW_FRAMES:
        return [total_frames]
    segs = [WINDOW_FRAMES]
    remaining = total_frames - WINDOW_FRAMES
    while remaining > 0:
        w = min(WINDOW_FRAMES, remaining + WINDOW_OVERLAP)
        if w < WINDOW_FRAMES:
            # 残段向上取整到 4k+1 网格:采样器要求 (T-1) 可被 4 整除
            # (model.py rearrange "b (n_t n) w s c", n=4),故实际产出
            # 总帧数可能比 num_frames 多 1-3 帧
            w = (w - 1 + 3) // 4 * 4 + 1
        segs.append(w)
        remaining -= w - WINDOW_OVERLAP
    return segs


def _extend_embeds_inputs(prev_latents: list, num_frames: int, overlap: int,
                          frames_processed: int) -> dict:
    """WanVideoLongCatAvatarExtendEmbeds 公共输入(首段与续段同参数族)。"""
    return {
        "prev_latents": prev_latents, "audio_embeds": ["7", 0],
        "num_frames": num_frames, "overlap": overlap,
        "frames_processed": frames_processed,
        "if_not_enough_audio": "pad_with_start",
        "ref_frame_index": 10, "ref_mask_frame_range": 3}


def build_longcat_avatar_graph(p: LongCatAvatarParams) -> dict:
    """参数 → ComfyUI API 格式图。

    单段(num_frames ≤ 93)节点 id 1-19 与 longcat_avatar_smoke.py 一致;
    多段从 id 20 起每段 3 节点(ExtendEmbeds/Sampler/Decode),随后是
    ImageBatchExtendWithOverlap 拼帧链,VHS(节点 19)改接拼帧链尾。
    """
    segs = plan_segments(p.num_frames)
    graph: dict = {
        "1": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "2": {"class_type": "ImageResizeKJv2", "inputs": {
            "image": ["1", 0], "width": p.width, "height": p.height,
            "upscale_method": "lanczos", "keep_proportion": "crop",
            "pad_color": "0, 0, 0", "crop_position": "center",
            "divisible_by": 16, "device": "cpu"}},
        "3": {"class_type": "LoadAudio", "inputs": {"audio": p.audio}},
        "4": {"class_type": "MelBandRoFormerModelLoader", "inputs": {
            "model_name": p.vocal_sep_name}},
        "5": {"class_type": "MelBandRoFormerSampler", "inputs": {
            "model": ["4", 0], "audio": ["3", 0]}},
        "6": {"class_type": "WhisperModelLoader", "inputs": {
            "model": p.whisper_name,
            "base_precision": "fp16", "load_device": "main_device"}},
        # num_frames=总帧数:WhisperEmbeds 一次性编码整段音频,
        # 各段 ExtendEmbeds 按 frames_processed 自行切片
        "7": {"class_type": "LongCatAvatarWhisperEmbeds", "inputs": {
            "whisper_model": ["6", 0], "audio_1": ["5", 0],
            "normalize_loudness": True, "num_frames": p.num_frames,
            "fps": float(p.fps), "audio_scale": 1.0,
            "audio_cfg_scale": 1.0, "multi_audio_type": "para"}},
        "8": {"class_type": "WanVideoBlockSwap", "inputs": {
            "blocks_to_swap": BLOCK_SWAP, "offload_img_emb": False,
            "offload_txt_emb": False, "use_non_blocking": False,
            "vace_blocks_to_swap": 0, "prefetch_blocks": 1,
            "block_swap_debug": False}},
        "9": {"class_type": "WanVideoLoraSelect", "inputs": {
            "lora": p.dmd_lora, "strength": p.dmd_lora_strength,
            "low_mem_load": False, "merge_loras": False}},
        "10": {"class_type": "WanVideoModelLoader", "inputs": {
            "model": p.model_name,
            "base_precision": "bf16", "quantization": "disabled",
            "load_device": "offload_device", "attention_mode": "sdpa",
            "lora": ["9", 0], "block_swap_args": ["8", 0]}},
        "11": {"class_type": "LoadWanVideoT5TextEncoder", "inputs": {
            "model_name": p.t5_name,
            "precision": "bf16", "load_device": "offload_device"}},
        "12": {"class_type": "WanVideoTextEncode", "inputs": {
            "t5": ["11", 0],
            "positive_prompt": p.positive, "negative_prompt": p.negative}},
        "13": {"class_type": "WanVideoSchedulerv2", "inputs": {
            "scheduler": "longcat_distill_euler", "steps": p.steps,
            "shift": p.shift, "start_step": 0, "end_step": -1,
            "enhance_hf": False}},
        "14": {"class_type": "WanVideoVAELoader", "inputs": {
            "model_name": p.vae_name,
            "precision": "bf16", "use_cpu_cache": False}},
        "15": {"class_type": "WanVideoEncode", "inputs": {
            "vae": ["14", 0], "image": ["2", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144,
            "tile_stride_y": 128,
            "noise_aug_strength": 0.0, "latent_strength": 1.0}},
        # 首段:prev_latents=首帧编码,overlap=1/frames_processed=0(同冒烟脚本)
        "16": {"class_type": "WanVideoLongCatAvatarExtendEmbeds", "inputs":
               _extend_embeds_inputs(["15", 0], segs[0], 1, 0)},
        "17": {"class_type": "WanVideoSamplerv2", "inputs": {
            "model": ["10", 0], "image_embeds": ["16", 0],
            "text_embeds": ["12", 0], "scheduler": ["13", 0],
            "cfg": p.cfg, "seed": p.seed, "force_offload": True}},
        "18": {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["14", 0], "samples": ["17", 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144,
            "tile_stride_y": 128, "normalization": "default"}},
        "19": {"class_type": "VHS_VideoCombine", "inputs": {
            "images": ["18", 0], "audio": ["3", 0], "frame_rate": p.fps,
            "loop_count": 0, "filename_prefix": p.filename_prefix,
            "format": "video/h264-mp4", "pix_fmt": "yuv420p", "crf": 19,
            "save_metadata": True, "trim_to_audio": False,
            "pingpong": False, "save_output": True}},
    }
    if len(segs) == 1:
        return graph

    prev_sampler, prev_decode = "17", "18"
    for i in range(1, len(segs)):
        eid = 20 + (i - 1) * 3
        sid, did = str(eid + 1), str(eid + 2)
        frames_processed = sum(segs[j] - WINDOW_OVERLAP for j in range(i)) + WINDOW_OVERLAP
        graph[str(eid)] = {"class_type": "WanVideoLongCatAvatarExtendEmbeds",
                           "inputs": {
                               **_extend_embeds_inputs([prev_sampler, 0], segs[i],
                                                       WINDOW_OVERLAP, frames_processed),
                               # v1.5:上一段真实解码帧重编码做 overlap 垫底;
                               # ref_latent=首帧 latents 保一致(官方示例同)
                               "ref_latent": ["15", 0],
                               "prev_images": [prev_decode, 0],
                               "vae": ["14", 0]}}
        graph[sid] = {"class_type": "WanVideoSamplerv2", "inputs": {
            "model": ["10", 0], "image_embeds": [str(eid), 0],
            "text_embeds": ["12", 0], "scheduler": ["13", 0],
            "cfg": p.cfg, "seed": p.seed, "force_offload": True}}
        graph[did] = {"class_type": "WanVideoDecode", "inputs": {
            "vae": ["14", 0], "samples": [sid, 0], "enable_vae_tiling": False,
            "tile_x": 272, "tile_y": 272, "tile_stride_x": 144,
            "tile_stride_y": 128, "normalization": "default"}}
        prev_sampler, prev_decode = sid, did

    # 拼帧链:warmup(WINDOW_OVERLAP)帧切掉,new_images 侧重叠区取新段
    # (官方示例 ImageBatchExtendWithOverlap 参数:new_images/cut)
    source = ["18", 0]
    for i in range(1, len(segs)):
        xid = str(20 + (len(segs) - 1) * 3 + (i - 1))
        graph[xid] = {"class_type": "ImageBatchExtendWithOverlap", "inputs": {
            "source_images": source,
            "new_images": [str(20 + (i - 1) * 3 + 2), 0],
            "overlap": WINDOW_OVERLAP,
            "overlap_side": "new_images", "overlap_mode": "cut"}}
        source = [xid, 2]  # extended_images 输出槽
    graph["19"]["inputs"]["images"] = source
    return graph
