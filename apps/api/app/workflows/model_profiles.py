"""模型档案 —— 按 checkpoint 文件名做能力适配与分类(纯函数,不封锁)。

平台理念:对 NSFW 不做硬封锁,后端只暴露**分类 / 能力适配**,限制留给用户自加。

本模块两件事:
  1. v-prediction 检测 + 推荐采样:NoobAI-XL-Vpred 等 v-pred 模型出图须在
     checkpoint 后插 `ModelSamplingDiscrete`(sampling="v_prediction", zsnr=True),
     否则发灰/糊。`is_vpred(name)` 按文件名子串判定,`vpred_sampling()` 给推荐采样。
  2. NSFW / R18 分类:`is_nsfw(name)` 按文件名子串或 curated 集合判定,**仅打标不过滤**。

所有判定基于文件名(大小写不敏感),纯函数返回新对象,无副作用。
class_type 与 inputs 依 ComfyUI `comfy_extras/nodes_model_advanced.py` 的
`ModelSamplingDiscrete`:required model(MODEL) / sampling(enum) / zsnr(BOOLEAN),输出 MODEL@0。
"""
from __future__ import annotations

import os
from dataclasses import dataclass

# ---------------------------------------------------------------------------
# v-prediction
# ---------------------------------------------------------------------------

# 文件名命中以下任一子串(大小写不敏感)即视为 v-prediction 模型。
# 覆盖常见写法:vpred / v-pred / v_pred / v-prediction / v_prediction。
_VPRED_HINTS: tuple[str, ...] = (
    "vpred",
    "v-pred",
    "v_pred",
    "v-prediction",
    "v_prediction",
)


@dataclass(frozen=True)
class SamplingProfile:
    """v-pred 推荐采样参数(供前端默认值 / 后端兜底,不强制)。

    NoobAI-XL-Vpred 等 v-pred 模型实测:euler + normal/karras、cfg 4~5 较稳;
    zsnr=True 配合 ModelSamplingDiscrete 修正灰图。rescale 可选,默认不开。
    """

    sampling: str = "v_prediction"
    zsnr: bool = True
    sampler: str = "euler"
    scheduler: str = "normal"
    cfg: float = 4.5


# 单例推荐档(不可变);需要变体时另建,不修改本对象。
VPRED_SAMPLING = SamplingProfile()


def is_vpred(name: str) -> bool:
    """文件名是否提示 v-prediction(子串匹配,大小写不敏感)。"""
    low = name.lower()
    return any(h in low for h in _VPRED_HINTS)


def vpred_sampling() -> SamplingProfile:
    """返回 v-pred 推荐采样档(不可变单例)。"""
    return VPRED_SAMPLING


# ---------------------------------------------------------------------------
# NSFW / R18 分类(仅打标,不封锁)
# ---------------------------------------------------------------------------

# 文件名命中以下任一子串(大小写不敏感)即归为 NSFW 档。包含两类:
#   - 倾向 NSFW 的底模家族(pony / noobai / animagine / illustrious / realisticvision …)
#   - 显式 NSFW 关键词(nsfw / r18 / hentai / uncensored / porn / xxx …)
# 仅用于前端「NSFW 档」筛选与提示,**不据此过滤任何模型**。
_DEFAULT_NSFW_HINTS: tuple[str, ...] = (
    # 底模家族
    "pony",
    "noobai",
    "animagine",
    "illustrious",
    "realisticvision",
    # 显式关键词
    "nsfw",
    "r18",
    "hentai",
    "uncensored",
    "porn",
    "xxx",
)

# 允许通过环境变量覆盖/扩展 curated 集合(逗号分隔,大小写不敏感)。
# TOIV_NSFW_HINTS 设置后**替换**默认集合;TOIV_NSFW_EXTRA 在默认基础上**追加**。
_ENV_NSFW_OVERRIDE = "TOIV_NSFW_HINTS"
_ENV_NSFW_EXTRA = "TOIV_NSFW_EXTRA"


def _parse_hint_env(value: str) -> tuple[str, ...]:
    return tuple(h.strip().lower() for h in value.split(",") if h.strip())


def nsfw_hints() -> tuple[str, ...]:
    """当前生效的 NSFW 判定子串集合(环境变量可覆盖/追加)。

    - 设 TOIV_NSFW_HINTS → 整体替换默认集合。
    - 设 TOIV_NSFW_EXTRA → 在默认集合基础上追加。
    二者皆未设 → 返回内置默认集合。每次返回新元组(读快照,不缓存)。
    """
    override = os.environ.get(_ENV_NSFW_OVERRIDE, "").strip()
    if override:
        return _parse_hint_env(override)
    extra = os.environ.get(_ENV_NSFW_EXTRA, "").strip()
    if extra:
        return _DEFAULT_NSFW_HINTS + _parse_hint_env(extra)
    return _DEFAULT_NSFW_HINTS


def is_nsfw(name: str) -> bool:
    """文件名是否归为 NSFW / R18 档(子串匹配,大小写不敏感)。

    注意:这是**分类**而非封锁——调用方据此打标/提示,绝不据此过滤模型。
    """
    low = name.lower()
    return any(h in low for h in nsfw_hints())


# ---------------------------------------------------------------------------
# ModelSamplingDiscrete 节点注入(v-pred 出图链修正)
# ---------------------------------------------------------------------------

# v-pred 注入节点 id:避开主图常用小数字 id(1-20)与 LoRA 链基址(100+)。
_VPRED_NODE_ID = "50"


def model_sampling_node(
    src_model: list,
    profile: SamplingProfile = VPRED_SAMPLING,
    node_id: str = _VPRED_NODE_ID,
) -> tuple[dict, list]:
    """构造一个 `ModelSamplingDiscrete` 节点,接在 src_model 之后。

    返回 (节点 dict, 新 model 引用)。把 src_model(通常是 checkpoint 的 [ckpt,0]
    或 LoRA 链末端)穿过本节点,下游 KSampler.model 改引本节点输出 [node_id, 0]。
    不可变:返回新 dict 与新引用,不改动入参。
    """
    nodes = {
        node_id: {
            "class_type": "ModelSamplingDiscrete",
            "inputs": {
                "model": list(src_model),
                "sampling": profile.sampling,
                "zsnr": profile.zsnr,
            },
        }
    }
    return nodes, [node_id, 0]
