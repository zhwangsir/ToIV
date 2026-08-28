"""策划 LoRA 卡目录 —— 视频提交 AI 选配的唯一文件名来源。

只收录仓库里已经点名的文件(Wan 元数据卡 / H3_NSFW_LORAS / NSFW 推荐 desc 里的
文件名 / LTX 工作室与 platform-models 点名的 ltx* LoRA)。不发明 Civitai 文件。
前端不得把 NAS 整目录当混搭池;文件名与默认强度只来自本表。
"""
from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class LoraCard:
    """单张策划卡。filename 必须已在仓库出现过;engines 决定哪个提交链路可挂。"""

    name: str
    engines: frozenset[str]
    nsfw: bool
    role: str
    default_strength: float
    conflicts: frozenset[str] = field(default_factory=frozenset)
    trigger_words: tuple[str, ...] = ()
    trigger_mode: str = "all"
    wan_side: str | None = None
    keywords: tuple[str, ...] = ()
    label: str = ""


def _card(
    name: str,
    engines: str | tuple[str, ...],
    *,
    nsfw: bool,
    role: str,
    strength: float,
    conflicts: tuple[str, ...] = (),
    trigger_words: tuple[str, ...] = (),
    trigger_mode: str = "all",
    wan_side: str | None = None,
    keywords: tuple[str, ...] = (),
    label: str = "",
) -> LoraCard:
    eng = frozenset((engines,) if isinstance(engines, str) else engines)
    return LoraCard(
        name=name,
        engines=eng,
        nsfw=nsfw,
        role=role,
        default_strength=strength,
        conflicts=frozenset(conflicts),
        trigger_words=trigger_words,
        trigger_mode=trigger_mode,
        wan_side=wan_side,
        keywords=keywords,
        label=label or name,
    )


# 同角色互斥(体位/局部结构/通用概念/加速各最多一张)
_POSE = ("pose",)
_ANAT = ("anatomy",)
_CONCEPT = ("concept",)
_ACCEL = ("accel",)

CATALOG: tuple[LoraCard, ...] = (
    # ── Wan 2.2 I2V(WAN_I2V_NSFW_LORAS 六件套,侧别/强度/触发词原样)──
    _card(
        "NSFW-22-H-e8.safetensors", "wan",
        nsfw=True, role="concept", strength=0.8, conflicts=_CONCEPT,
        trigger_words=("nsfwsks",), wan_side="high",
        keywords=("nsfw", "nsfwsks"),
        label="通用 NSFW 概念·HIGH",
    ),
    _card(
        "wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors", "wan",
        nsfw=True, role="physics", strength=0.7,
        trigger_words=("m4crom4sti4",), wan_side="high",
        keywords=("breast", "bounce", "jiggle", "chest", "胸", "晃"),
        label="胸部物理·HIGH",
    ),
    _card(
        "WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors", "wan",
        nsfw=True, role="cumshot", strength=0.7,
        trigger_words=("b0dyshot", "pull0ut", "sp0ntaneous", "s3lf", "p4rtner"),
        trigger_mode="pick_one", wan_side="high",
        keywords=("cum", "cumshot", "pullout", "pull out", "射", "体外"),
        label="POV 体精/拔出·HIGH",
    ),
    _card(
        "Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors",
        "wan",
        nsfw=True, role="accel", strength=0.8, conflicts=_ACCEL,
        wan_side="high",
        keywords=("v1030", "4step", "turbo"),
        label="加速 v1030·HIGH",
    ),
    _card(
        "DR34ML4Y_I2V_14B_LOW_V2.safetensors", "wan",
        nsfw=True, role="pose", strength=0.8, conflicts=_POSE,
        trigger_words=("m15510n4ry", "bl0wj0b", "d0gg1e", "c0wg1rl", "d0ubl3_bj"),
        trigger_mode="pick_one", wan_side="low",
        keywords=(
            "missionary", "blowjob", "fellatio", "deepthroat", "facefuck",
            "doggy", "cowgirl", "double", "threesome",
            "传教士", "口交", "后入", "骑乘",
        ),
        label="体位五件套·LOW",
    ),
    _card(
        "56Low-noise-Cumshot-Aesthetics.safetensors", "wan",
        nsfw=True, role="aesthetics", strength=0.6, wan_side="low",
        keywords=("cum", "aesthetics", "体液", "动漫"),
        label="体液美学·LOW",
    ),
    # ── MiniMax H3(H3_NSFW_LORAS + NSFW_RECOMMENDATIONS 已点名文件)──
    _card(
        "HMNSFW_AIO_V2.safetensors", "h3",
        nsfw=True, role="concept", strength=0.6, conflicts=_CONCEPT,
        keywords=("nsfw", "aio", "sex"),
        label="HMNSFW AIO 综合",
    ),
    _card(
        "SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors", "h3",
        nsfw=True, role="concept", strength=0.6, conflicts=_CONCEPT,
        keywords=("naughty", "sexgod"),
        label="NaughtyTimes 综合动作",
    ),
    _card(
        "riding_pose_H3_i2v_v1.0.safetensors", "h3",
        nsfw=True, role="pose", strength=0.6, conflicts=_POSE,
        keywords=("riding", "cowgirl", "骑乘", "女上"),
        label="骑乘位 POV",
    ),
    _card(
        "H3_footjob_v0_step1000_fixed.safetensors", "h3",
        nsfw=True, role="pose", strength=0.6, conflicts=_POSE,
        keywords=("footjob", "足交", "脚"),
        label="足交",
    ),
    _card(
        "deepthroat_v1.safetensors", "h3",
        nsfw=True, role="pose", strength=0.6, conflicts=_POSE,
        keywords=("deepthroat", "blowjob", "fellatio", "深喉", "口交"),
        label="深喉",
    ),
    _card(
        "h3_musubi_v4-000040.safetensors", "h3",
        nsfw=True, role="anatomy", strength=0.6, conflicts=_ANAT,
        keywords=("pussy", "innie", "私处"),
        label="Innie Pussy",
    ),
    _card(
        "minimax_vag_000002500.safetensors", "h3",
        nsfw=True, role="anatomy", strength=0.6, conflicts=_ANAT,
        keywords=("vagina", "pussy", "私处"),
        label="H3 Vagina",
    ),
    _card(
        "vagassist_e40.safetensors", "h3",
        nsfw=True, role="anatomy", strength=0.6, conflicts=_ANAT,
        keywords=("pussy", "anus", "私处"),
        label="HMPussy",
    ),
    _card(
        "stomach_bulge_H3_i2v_v1.0.safetensors", "h3",
        nsfw=True, role="physics", strength=0.6,
        keywords=("bulge", "stomach", "腹部", "隆起"),
        label="腹部隆起",
    ),
    _card(
        "cxy_kiss_lora_h3_v01_step1500.safetensors", "h3",
        nsfw=False, role="pose", strength=0.6, conflicts=_POSE,
        keywords=("kiss", "亲吻", "吻"),
        label="亲吻(SFW)",
    ),
    _card(
        "AI_Girl_Fictional_Women_Series30_H3.safetensors", "h3",
        nsfw=False, role="aesthetics", strength=0.6,
        keywords=("girl", "character", "角色"),
        label="架空女性角色",
    ),
    _card(
        "minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors", "h3",
        nsfw=False, role="accel", strength=0.8, conflicts=_ACCEL,
        keywords=("turbo", "4step", "加速"),
        label="H3 lightx2v Turbo",
    ),
    _card(
        "minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors", "h3",
        nsfw=False, role="accel", strength=0.8, conflicts=_ACCEL,
        keywords=("turbo", "4step", "加速", "pruned"),
        label="H3 Turbo 850 剪枝",
    ),
    # ── LTX 2.3(platform-models / ltx_video 已点名;工作室沙箱前缀不是这些文件的登记名)──
    _card(
        "ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors",
        "ltx",
        nsfw=False, role="motion", strength=0.8,
        keywords=("dynamic", "motion", "运动", "动态"),
        label="LTX 动态增强",
    ),
    _card(
        "ltx-2-19b-lora-camera-control-dolly-left.safetensors", "ltx",
        nsfw=False, role="camera", strength=1.0,
        keywords=("dolly", "camera", "pan", "zoom", "运镜", "推镜", "摇镜"),
        label="运镜 Dolly Left",
    ),
)


_BY_NAME: dict[str, LoraCard] = {c.name: c for c in CATALOG}


def card_by_name(name: str) -> LoraCard | None:
    """按精确文件名取卡;带子目录前缀时再试 basename。"""
    hit = _BY_NAME.get(name)
    if hit is not None:
        return hit
    base = name.replace("\\", "/").rsplit("/", 1)[-1]
    return _BY_NAME.get(base)


def cards_for(engine: str, *, nsfw: bool | None = None) -> tuple[LoraCard, ...]:
    """engine 过滤;nsfw=False 剔除 R18 卡,None 全要,True 保留 SFW+NSFW(R18 上下文可用运镜等)。"""
    out = [c for c in CATALOG if engine in c.engines]
    if nsfw is False:
        out = [c for c in out if not c.nsfw]
    return tuple(out)


def catalog_options(engine: str) -> list[dict]:
    """引擎注册表 type=loras 的 options(value/label/nsfw)。"""
    return [
        {"value": c.name, "label": c.label or c.name, **({"nsfw": True} if c.nsfw else {})}
        for c in CATALOG
        if engine in c.engines
    ]
