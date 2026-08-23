"""Wan-Animate-2 工作流构建 —— 参考图角色 + 驱动视频 → 动作迁移/视频换人(原生节点)。

与 v1(workflows/wan_animate.py,kijai WanVideoWrapper 路线 :8197)完全独立:
v2 是换代模型(2026-08-07 开源),端到端 DiT 直接吃驱动视频帧,不再需要 DWPose
中间件;ComfyUI master 原生支持(comfy/ldm/wan/model_animate2.py +
comfy_extras/nodes_wan.py WanAnimate2ToVideo/WanAnimate2Cache,节点语义见节点源码),
kijai wrapper 停在 2026-05 不支持 v2。专用实例 :8199(workstation GPU3)。

节点结构(全原生节点,零 custom_nodes 依赖):
  UNETLoader(蒸馏版 bf16,10 步无 CFG)→ KSampler(euler/simple,cfg=1)
  CLIPLoader(type=wan,umt5-xxl)→ CLIPTextEncode ×2
  LoadImage(参考图)→ CLIPVisionLoader/CLIPVisionEncode(clip_vision_h)
  LoadVideo → GetVideoComponents(驱动视频帧 + 原声)
  WanAnimate2ToVideo(条件组装:ref latent + pose_video_latent + clip vision)
  → KSampler → TrimVideoLatent(ref latent 帧裁掉)→ VAEDecode
  → CreateVideo(驱动视频原声回打包)→ SaveVideo

关键约束(侦察实证,勿改):
  · 权重用 Comfy-Org 转换版蒸馏权重(官方:10 步 cfg=1.0,euler flow solver;
    默认 int8_convrot 共卡档,bf16 蒸馏备选;base 版 40 步带 CFG 慢 4×);
  · shift 不挂 ModelSamplingShift:WAN_Animate2 sampling_settings shift=5.0 由
    model_sampling 自动应用(comfy/model_base.py model_sampling() 读 model_config);
  · 文本编码器必须是 Comfy-Org repackaged 的 umt5_xxl_fp8_e4m3fn_scaled.safetensors
    (内嵌 spiece_model;NAS toiv 的 umt5-xxl-enc-fp8 是 kijai wrapper 键名,
    CLIPLoader 解析不了);
  · 官方提示词要求:prompt 只描述参考图「外观+背景」,不描述动作(动作全由驱动
    视频决定);路由层 positive 留空时自动 VLM 反推外观 caption;
  · 帧数 4k+1 时序网格(latent_length=((length-1)//4)+1,同 v1);
  · 驱动视频帧 1:1 映射到输出帧(无 v1 的 force_rate 重采样):输出 fps 只是
    打包帧率,驱动视频帧率与输出 fps 不一致时动作会变速,提示用户对齐;
  · WanAnimate2Cache(姿态分支激活缓存,~12.5G RAM/作业)默认不挂:workstation
    RAM 是稀缺资源(2026-08-21 OOM 事故),先求稳。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# 模型资产(实例 extra_model_paths 已指向 NAS;文件名按 :8199 /object_info 实测硬编码)
# ⚠️ 必须用 Comfy-Org 转换版(Comfy-Org/Wan-Animate-2,NAS wan_animate_2/comfyui/):
# Wan-AI 官方 safetensors 是原始仓格式(blocks.N.block.* 嵌套键、无 __metadata__),
# ComfyUI model_detection 无法识别(KeyError blocks.0.ffn.0.weight,2026-08-24 实测);
# model_type=animate2 依赖转换版内嵌 metadata config 判定。
DEFAULT_MODEL = "wan_animate_2_distill_int8_convrot.safetensors"  # 蒸馏+int8:10 步无 CFG,共卡友好
DEFAULT_MODEL_BF16 = "wan_animate_2_distill_bf16.safetensors"  # 蒸馏 bf16 画质档(备选)
DEFAULT_T5 = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"  # Comfy-Org repackaged(内嵌 spiece)
DEFAULT_VAE = "Wan2_1_VAE_bf16.safetensors"  # WAN_Animate2 latent_format=Wan21(16ch)
DEFAULT_CLIP_VISION = "clip_vision_h.safetensors"  # ViT-H(open-clip xlm-roberta 的图像塔)

# 官方反推指令(github.com/Wan-Video/Wan-Animate-2 README):只描述外观+背景,不描述动作
APPEARANCE_CAPTION_INSTRUCTION = (
    "用中文客观描述图片中的内容,包括以下要点:人物外观描述,不描述动作行为。"
    "背景描述,忽略主观评价和情绪推测。下面给出描述范例,必须遵循这个范式,"
    "不要输出额外的符号:人物外观描述:穿着一件浅蓝色的校服衬衫,领口和袖口有白色边饰。"
    "胸前有一个圆形徽章。背景描述:背景为明亮、整洁的教室或办公室,氛围安静有序。"
)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


def snap_frames_4k1(v: int) -> int:
    """WanVideo 系帧数网格 (T-1)%4==0:向上取整到 4k+1(与 v1/avatar 同一约束)。"""
    return (max(1, v) - 1 + 3) // 4 * 4 + 1


@dataclass(frozen=True)
class WanAnimate2Params:
    """Wan-Animate-2 动作迁移参数。seed 缺省随机(与 longcat/wan 同一惯例)。

    image/video 为 :8199 实例 input 目录文件名(路由层负责从 pool worker 转运)。
    num_frames 自动取整 4k+1;驱动视频帧由 WanAnimate2ToVideo 截断/末帧补齐到该帧数。
    """

    positive: str       # 官方要求:只描述参考图外观+背景(路由层留空时自动反推)
    image: str          # 参考图(角色形象)
    video: str          # 驱动视频(动作来源)
    negative: str = ""
    width: int = 832
    height: int = 480
    num_frames: int = 121   # 17-501,自动取整 4k+1;121 帧@16fps≈7.5s
    steps: int = 10         # 蒸馏版官方 10 步
    cfg: float = 1.0        # 蒸馏版无 CFG(官方 sample_guide_scale=1.0)
    fps: int = 16           # 仅成片打包帧率(帧 1:1 映射,不重采样驱动视频)
    sampler: str = "euler"  # 官方蒸馏 flow_solver=euler
    scheduler: str = "simple"
    seed: int = field(default_factory=_random_seed)
    model_name: str = DEFAULT_MODEL
    t5_name: str = DEFAULT_T5
    vae_name: str = DEFAULT_VAE
    clip_vision_name: str = DEFAULT_CLIP_VISION
    filename_prefix: str = "ToIV_wan/animate2"

    def __post_init__(self) -> None:
        object.__setattr__(self, "num_frames", snap_frames_4k1(self.num_frames))


def build_wan_animate2_graph(p: WanAnimate2Params) -> dict:
    """参数 → ComfyUI API 格式图(节点语义对照 comfy_extras/nodes_wan.py WanAnimate2ToVideo)。"""
    return {
        "1": {"class_type": "UNETLoader", "inputs": {
            "unet_name": p.model_name, "weight_dtype": "default"}},
        "2": {"class_type": "CLIPLoader", "inputs": {
            "clip_name": p.t5_name, "type": "wan"}},
        "3": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "4": {"class_type": "CLIPTextEncode", "inputs": {
            "clip": ["2", 0], "text": p.positive}},
        "5": {"class_type": "CLIPTextEncode", "inputs": {
            "clip": ["2", 0], "text": p.negative}},
        # 参考图支路:LoadImage → CLIP 视觉编码(参考图语义;WanAnimate2ToVideo 内部
        # 自行做 vae.encode 与尺寸对齐,无需预 resize)
        "6": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "7": {"class_type": "CLIPVisionLoader", "inputs": {
            "clip_name": p.clip_vision_name}},
        "8": {"class_type": "CLIPVisionEncode", "inputs": {
            "clip_vision": ["7", 0], "image": ["6", 0], "crop": "center"}},
        # 驱动视频支路:原生 LoadVideo → 拆帧/音轨(帧 1:1 映射,无重采样)
        "9": {"class_type": "LoadVideo", "inputs": {"file": p.video}},
        "10": {"class_type": "GetVideoComponents", "inputs": {"video": ["9", 0]}},
        # Animate2 条件组装:ref latent + pose_video_latent + clip vision
        "11": {"class_type": "WanAnimate2ToVideo", "inputs": {
            "positive": ["4", 0], "negative": ["5", 0], "vae": ["3", 0],
            "width": p.width, "height": p.height, "length": p.num_frames,
            "batch_size": 1,
            "reference_image": ["6", 0], "pose_video": ["10", 0],
            "clip_vision_output": ["8", 0],
            "video_frame_offset": 0,
            "pose_strength": 1.0, "pose_start_percent": 0.0, "pose_end_percent": 1.0,
            "reference_image_strength": 1.0}},
        "12": {"class_type": "KSampler", "inputs": {
            "model": ["1", 0], "positive": ["11", 0], "negative": ["11", 1],
            "latent_image": ["11", 2],
            "seed": p.seed, "steps": p.steps, "cfg": p.cfg,
            "sampler_name": p.sampler, "scheduler": p.scheduler, "denoise": 1.0}},
        # 参考图 latent 帧(首部 trim_latent 帧)裁掉后再解码
        "13": {"class_type": "TrimVideoLatent", "inputs": {
            "samples": ["12", 0], "trim_amount": ["11", 3]}},
        "14": {"class_type": "VAEDecode", "inputs": {
            "samples": ["13", 0], "vae": ["3", 0]}},
        # audio=[10,1]:驱动视频原声回打包(无音轨素材由路由层 ensure_audio_track 补静音轨)
        "15": {"class_type": "CreateVideo", "inputs": {
            "images": ["14", 0], "audio": ["10", 1], "fps": float(p.fps)}},
        "16": {"class_type": "SaveVideo", "inputs": {
            "video": ["15", 0], "filename_prefix": p.filename_prefix,
            "format": "mp4", "codec": "h264"}},
    }
