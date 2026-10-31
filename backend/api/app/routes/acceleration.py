"""统一「生成加速档」清单端点(任务 #24,2026-10-15)。

GET /api/acceleration/tiers —— 产品 UI 显式加速档选择器的单一数据源:
{
  "families": {
    "h3":   [...],   # 实测档:来自 h3_accel.load_profiles(),已过滤 recommended=false
    "wan":  [...],   # 静态参考档:步数/机制描述,source="reference",speedup=null
    "qwen": [...]
  }
}

每档统一形状:{level, label, speedup, ssim, recommended, source, note}
  · speedup/ssim 为 null 表示无实测倍率/画质数据(wan/qwen 系与 h3 的 off 档);
  · source="measured"(h3 规格文件实测)| "reference"(代码内静态表/off 档);
  · h3 的 lossless 档若基准方标 recommended=false → 直接不出现在选项里(用户拍板)。

产品路径默认满血(off);加速档为显式可选,note 供 UI 展示倍率/机制说明。
"""
from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends

from app.deps import get_current_user
from app.models import User
from app.services import h3_accel

router = APIRouter()


# ── wan / qwen 系静态参考档(无实测倍率/SSIM;步数/机制描述,禁止编造数字)──────
# 语义对齐 workflows/wan_t2v._resolve_sampling 与 workflows/nextgen.resolve_qwen_accel。

_WAN_TIERS: list[dict[str, Any]] = [
    {
        "level": "off",
        "label": "满血(默认)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "原生 20 步采样,CFG 3.5/3.0,不挂加速 LoRA。质量优先默认档。",
    },
    {
        "level": "turbo",
        "label": "草稿极速(4 步)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "Seko 双 LoRA 蒸馏,4 步采样,CFG 1.0。草稿/预览用,画面偏软。",
    },
    {
        "level": "turbo_cache",
        "label": "成片平衡(8 步 + EasyCache)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "Seko 双 LoRA,8 步采样 + EasyCache 缓存加速,CFG 1.0。成片质量/速度平衡档。",
    },
]

_QWEN_TIERS: list[dict[str, Any]] = [
    {
        "level": "off",
        "label": "满血(默认)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "原生采样,不挂 Lightning LoRA / CacheDiT,步数与 CFG 沿用档案。质量优先默认档。",
    },
    {
        "level": "turbo",
        "label": "草稿极速(Lightning 4 步)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "Qwen-Image Lightning 4 步 LoRA,CFG 1.0。草稿/预览用。",
    },
    {
        "level": "turbo_cache",
        "label": "成片平衡(Lightning 8 步 + CacheDiT)",
        "speedup": None,
        "ssim": None,
        "recommended": True,
        "source": "reference",
        "note": "Qwen-Image Lightning 8 步 LoRA + CacheDiT 缓存加速,CFG 1.0。成片平衡档。",
    },
]

# h3 off 档:规格文件里没有 off 条目,补一条满血默认档(无实测倍率/SSIM)。
_H3_OFF_TIER: dict[str, Any] = {
    "level": "off",
    "label": "满血(默认)",
    "speedup": None,
    "ssim": None,
    "recommended": True,
    "source": "reference",
    "note": "原生采样,不做加速改写。质量优先默认档。",
}


def _num(v: Any) -> float | None:
    """实测数值安全转 float;非数值 → None(绝不编造)。"""
    return float(v) if isinstance(v, (int, float)) and not isinstance(v, bool) else None


def build_h3_tiers(profiles: dict[str, Any] | None = None) -> list[dict[str, Any]]:
    """h3 档清单:off 满血档 + 规格文件实测档(过滤 recommended=false 与缺实测倍率的档)。

    顺序按 h3_accel.ACCEL_LEVELS(off → lossless → balanced → extreme);
    仅收录 recommended!=false 且带数值 speedup 的实测档,note 取规格 reason。
    """
    specs = profiles if profiles is not None else (h3_accel.load_profiles() or {})
    tiers: list[dict[str, Any]] = [_H3_OFF_TIER]
    for level in h3_accel.ACCEL_LEVELS:
        if level == "off":
            continue
        spec = specs.get(level)
        if not isinstance(spec, dict):
            continue  # 规格缺失:不编造数字,直接不出现
        if spec.get("recommended") is False:
            continue  # 用户拍板:基准方下架档不得出现在选项里
        speedup = _num(spec.get("speedup"))
        if speedup is None:
            continue  # 无实测倍率:不足以作为可选加速档展示
        tiers.append({
            "level": level,
            "label": str(spec.get("label") or level),
            "speedup": speedup,
            "ssim": _num(spec.get("ssim_vs_native")),
            "recommended": True,
            "source": "measured",
            "note": str(spec.get("reason") or ""),
        })
    return tiers


@router.get("/acceleration/tiers")
def acceleration_tiers(user: User = Depends(get_current_user)) -> dict[str, Any]:
    """三家族加速档清单(h3 实测 / wan / qwen 静态参考),供产品 UI 显式选择器。"""
    return {
        "families": {
            "h3": build_h3_tiers(),
            "wan": [dict(t) for t in _WAN_TIERS],
            "qwen": [dict(t) for t in _QWEN_TIERS],
        }
    }
