"""Wan 2.2 图生视频(i2v)API 工作流构造器。

Wan 2.2 双专家(high/low noise)。本构造器经 2026 调研重做,修掉旧版四个质量硬伤:
  ① 缺 ModelSamplingSD3(shift)—— Wan 原生工作流硬要求,缺了 sigma 调度偏离训练分布,
     动作/质量直接崩。现每个专家后插 ModelSamplingSD3(shift=5)。
  ② cfg=1.0 —— 关掉引导,提示遵循与动作幅度全塌。现 high 段 3.0、low 段 1.0(加速档)。
  ③ 4 步纯 lightning —— lightx2v 官方承认 "bad motion"。现默认 8 步,high LoRA 0.8/low 1.0。
  ④ 640×480/49 帧 —— 偏离训练甜点。现 832×480/81 帧。

节点链:
  UNETLoader×2 →(可选 lightx2v 加速 LoRA)→ ModelSamplingSD3(shift)×2
  CLIPLoader(umt5,wan) + VAELoader(wan_2.1_vae) + CLIPTextEncode×2 + LoadImage → WanImageToVideo
  KSamplerAdvanced(high, 0→boundary, cfg=high_cfg) → KSamplerAdvanced(low, boundary→steps, cfg=low_cfg)
  → VAEDecode → VHS_VideoCombine(h264-mp4)

两档(由 use_accel_lora 切换):
  · 加速档(默认,use_accel_lora=True):8 步 + lightx2v LoRA,high_cfg≈3 / low_cfg=1,平衡快与质。
  · 满血档(use_accel_lora=False):不挂加速 LoRA,steps≈20-30,high_cfg≈3.5 / low_cfg≈3,漫剧成片首选。
"""
from __future__ import annotations

import secrets
from dataclasses import dataclass, field

MAX_SEED = 2**63 - 1

# Wan 官方推荐负面提示词(动漫向另在调用方追加 (realistic) 压写实偏置)
DEFAULT_NEGATIVE = (
    "色调艳丽，过曝，静态，细节模糊不清，字幕，风格，作品，画作，画面，静止，"
    "整体发灰，最差质量，低质量，JPEG压缩残留，丑陋的，残缺的，多余的手指，"
    "画得不好的手部，画得不好的脸部，畸形的，毁容的，形态畸形的肢体，手指融合，"
    "静止不动的画面，杂乱的背景，三条腿，背景人很多，倒着走"
)


def _random_seed() -> int:
    return secrets.randbelow(MAX_SEED)


# ── NSFW LoRA 注册表(2026-08-16 Civitai 爆款配方逆向,见 docs/2026-08-16-wan22-i2v-nsfw-recipe.md)──
# 2026-08-17 升级为元数据卡(参考 DashBox 提示词 RFC「触发词是确定性知识,不交给 LLM 自由发挥」):
# 触发词来自 Civitai 作者官方 trainedWords,由 /api/optimize 与提交链确定性注入,
# 高强度 LoRA(概念/物理)宁低勿高:过强会畸变,社区甜点位 0.6-0.8。
@dataclass(frozen=True)
class WanNsfwLoraMeta:
    """Wan2.2 NSFW LoRA 元数据卡。trigger_mode: all=触发词全置前 / pick_one=按场景选一个。
    role: concept(通用概念)/physics(物理)/pose(体位)/cumshot(射精)/accel(加速)/aesthetics(质感)。"""

    side: str  # "high"(构图/动作轨迹)| "low"(细节/质感)——双专家架构挂错侧=无效/崩坏
    default_strength: float
    trigger_words: tuple[str, ...] = ()
    trigger_mode: str = "all"
    role: str = ""


WAN_I2V_NSFW_LORAS: dict[str, WanNsfwLoraMeta] = {
    # HIGH 侧(构图/动作轨迹)
    "NSFW-22-H-e8.safetensors": WanNsfwLoraMeta(
        "high", 0.8, ("nsfwsks",), "all", "concept"),  # WAN General NSFW:通用概念解锁
    "wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors": WanNsfwLoraMeta(
        "high", 0.7, ("m4crom4sti4",), "all", "physics"),  # 胸部物理
    "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors": WanNsfwLoraMeta(
        "high", 0.7, ("b0dyshot", "pull0ut", "sp0ntaneous", "s3lf", "p4rtner"), "pick_one", "cumshot"),
    # lightx2v v1030 加速 LoRA(kenpechi 同款新版);选中时替代默认 v1 加速 LoRA,不叠加;无触发词
    "Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors": WanNsfwLoraMeta(
        "high", 0.8, (), "all", "accel"),
    # LOW 侧(细节/质感)
    "DR34ML4Y_I2V_14B_LOW_V2.safetensors": WanNsfwLoraMeta(
        "low", 0.8, ("m15510n4ry", "bl0wj0b", "d0gg1e", "c0wg1rl", "d0ubl3_bj"), "pick_one", "pose"),
    "56Low-noise-Cumshot-Aesthetics.safetensors": WanNsfwLoraMeta(
        "low", 0.6, (), "all", "aesthetics"),  # 动漫体液美学(beta,配合 HIGH 词,强度宁低)
}


def pick_trigger_words(lora_names: list[str], scene_text: str = "") -> list[str]:
    """确定性触发词选择(DashBox L0 思想):注册表内 LoRA 的触发词按场景文本关键词命中。

    - trigger_mode=all:全部必选,原样返回
    - trigger_mode=pick_one:按 scene_text 关键词命中映射,无命中取第一个
    未注册的名字静默跳过(调用方负责 422/剔除);返回保序去重。
    """
    # pick_one 场景关键词映射(英文小写子串 → 触发词索引)
    _SCENE_HINTS: dict[str, dict[str, int]] = {
        "DR34ML4Y_I2V_14B_LOW_V2.safetensors": {
            "missionary": 0, "blowjob": 1, "fellatio": 1, "deepthroat": 1, "facefuck": 1,
            "doggy": 2, "cowgirl": 3, "double": 4, "threesome": 4,
        },
        "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors": {
            "pull out": 1, "pullout": 1, "spontaneous": 2, "self": 3, "partner": 4,
        },
    }
    out: list[str] = []
    low = scene_text.lower()
    for name in lora_names:
        meta = WAN_I2V_NSFW_LORAS.get(name)
        if meta is None or not meta.trigger_words:
            continue
        if meta.trigger_mode == "all":
            picks: list[str] = list(meta.trigger_words)
        else:
            idx = 0
            hints = _SCENE_HINTS.get(name, {})
            for kw, i in hints.items():
                if kw in low:
                    idx = i
                    break
            picks = [meta.trigger_words[min(idx, len(meta.trigger_words) - 1)]]
        for w in picks:
            if w not in out:
                out.append(w)
    return out


@dataclass(frozen=True)
class WanI2VParams:
    positive: str
    image: str
    negative: str = DEFAULT_NEGATIVE
    high_unet: str = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    low_unet: str = "wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors"
    high_lora: str = "wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors"
    low_lora: str = "wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors"
    # NSFW LoRA 叠加链(2026-08-16):[(文件名, 强度)],由路由层按 WAN_I2V_NSFW_LORAS 分侧;
    # 串联在加速 LoRA 之后、ModelSamplingSD3 之前(加速贴底模,概念/动作后挂)
    high_loras: tuple[tuple[str, float], ...] = ()
    low_loras: tuple[tuple[str, float], ...] = ()
    clip_name: str = "umt5_xxl_fp8_e4m3fn_scaled.safetensors"
    vae_name: str = "wan_2.1_vae.safetensors"
    # 训练甜点档:480p 档为 832×480,81 帧(4n+1)≈5s@16fps
    width: int = 832
    height: int = 480
    length: int = 81
    fps: int = 16
    # Wan 原生硬要求:ModelSamplingSD3 的 sigma shift(缺则动作/质量崩)
    shift: float = 5.0
    # 加速档默认:8 步双专家 + lightx2v LoRA(修掉 4 步的 bad motion)
    use_accel_lora: bool = True
    steps: int = 8
    high_cfg: float = 3.0  # high 段拉回引导换动作幅度(满血档约 3.5)
    low_cfg: float = 1.0  # low 段细化,加速档可低;满血档约 3.0
    high_lora_strength: float = 0.8  # high LoRA 降到 0.6~0.8 换回运动(官方建议)
    low_lora_strength: float = 1.0
    sampler: str = "euler"
    scheduler: str = "simple"  # 官方:换 scheduler 常破坏运动,别动
    seed: int = field(default_factory=_random_seed)
    filename_prefix: str = "ToIV_vid"


def build_wan_i2v_graph(p: WanI2VParams) -> dict:
    boundary = max(1, p.steps // 2)
    g: dict = {
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": p.high_unet, "weight_dtype": "default"}},
        "2": {"class_type": "UNETLoader", "inputs": {"unet_name": p.low_unet, "weight_dtype": "default"}},
        "5": {"class_type": "CLIPLoader", "inputs": {"clip_name": p.clip_name, "type": "wan"}},
        "6": {"class_type": "VAELoader", "inputs": {"vae_name": p.vae_name}},
        "7": {"class_type": "CLIPTextEncode", "inputs": {"text": p.positive, "clip": ["5", 0]}},
        "8": {"class_type": "CLIPTextEncode", "inputs": {"text": p.negative, "clip": ["5", 0]}},
        "9": {"class_type": "LoadImage", "inputs": {"image": p.image}},
        "10": {
            "class_type": "WanImageToVideo",
            "inputs": {
                "positive": ["7", 0],
                "negative": ["8", 0],
                "vae": ["6", 0],
                "width": p.width,
                "height": p.height,
                "length": p.length,
                "batch_size": 1,
                "start_image": ["9", 0],
            },
        },
    }

    # 模型链:UNET →(可选 lightx2v 加速 LoRA)→(NSFW LoRA 叠加链)→ ModelSamplingSD3(shift)
    # v1030 加速 LoRA(高噪链选中时)替代默认 v1,不叠加避免双重加速;满血档(不挂加速)忽略 v1030
    high_extras = list(p.high_loras)
    v1030 = "Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors"
    use_v1030 = p.use_accel_lora and any(n == v1030 for n, _ in high_extras)
    high_extras = [(n, s) for n, s in high_extras if n != v1030]

    high_src: list = ["1", 0]
    low_src: list = ["2", 0]
    node_id = 20  # 动态 LoRA 链节点起始 id(避开静态 1-16)
    if p.use_accel_lora:
        # 加速档:v1030 选中则替代默认 v1 加速 LoRA(贴底模位)
        g["3"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": high_src, "lora_name": v1030 if use_v1030 else p.high_lora, "strength_model": p.high_lora_strength}}
        g["4"] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": low_src, "lora_name": p.low_lora, "strength_model": p.low_lora_strength}}
        high_src, low_src = ["3", 0], ["4", 0]

    for name, strength in high_extras:
        nid = str(node_id); node_id += 1
        g[nid] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": high_src, "lora_name": name, "strength_model": strength}}
        high_src = [nid, 0]
    for name, strength in p.low_loras:
        nid = str(node_id); node_id += 1
        g[nid] = {"class_type": "LoraLoaderModelOnly", "inputs": {"model": low_src, "lora_name": name, "strength_model": strength}}
        low_src = [nid, 0]

    g["15"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": high_src, "shift": p.shift}}
    g["16"] = {"class_type": "ModelSamplingSD3", "inputs": {"model": low_src, "shift": p.shift}}

    g["11"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["15", 0],
            "add_noise": "enable",
            "noise_seed": p.seed,
            "steps": p.steps,
            "cfg": p.high_cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["10", 0],
            "negative": ["10", 1],
            "latent_image": ["10", 2],
            "start_at_step": 0,
            "end_at_step": boundary,
            "return_with_leftover_noise": "enable",
        },
    }
    g["12"] = {
        "class_type": "KSamplerAdvanced",
        "inputs": {
            "model": ["16", 0],
            "add_noise": "disable",
            "noise_seed": p.seed,
            "steps": p.steps,
            "cfg": p.low_cfg,
            "sampler_name": p.sampler,
            "scheduler": p.scheduler,
            "positive": ["10", 0],
            "negative": ["10", 1],
            "latent_image": ["11", 0],
            "start_at_step": boundary,
            "end_at_step": p.steps,
            "return_with_leftover_noise": "disable",
        },
    }
    g["13"] = {"class_type": "VAEDecode", "inputs": {"samples": ["12", 0], "vae": ["6", 0]}}
    # 输出真 mp4(h264):可分享/可下载、ffmpeg 可直接拼接(自动剪辑)
    g["14"] = {
        "class_type": "VHS_VideoCombine",
        "inputs": {
            "images": ["13", 0],
            "frame_rate": float(p.fps),
            "loop_count": 0,
            "filename_prefix": p.filename_prefix,
            "format": "video/h264-mp4",
            "pingpong": False,
            "save_output": True,
        },
    }
    return g
