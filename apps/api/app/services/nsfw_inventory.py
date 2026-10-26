"""NSFW 可见性分类 —— 显式元数据优先、文件名/LoRA 命名兜底、unknown 策略。

口径(2026-10-26 TL):
  - 显式元数据字段为准(registry JSON / 调用方传入 explicit)
  - 文件名 hints(`model_profiles.is_nsfw`)仅兜底
  - unknown:普通模式藏、成人模式显
  - 成人列表:nsfw + unknown(已知 SFW 不进成人专列,与既有 NSFW-only 一致)
  - 普通列表:仅已知 sfw
"""
from __future__ import annotations

import json
import logging
from functools import lru_cache
from pathlib import Path
from typing import Any, Literal

from app.workflows.model_profiles import is_nsfw

logger = logging.getLogger(__name__)

NsfwClass = Literal["nsfw", "sfw", "unknown"]

_META_PATH = Path(__file__).resolve().parents[1] / "data" / "model_nsfw_meta.json"


@lru_cache(maxsize=1)
def _explicit_registry() -> dict[str, Any]:
    """可选显式元数据:{ "models": { "name.safetensors": true|false|null } }。"""
    try:
        if not _META_PATH.is_file():
            return {}
        data = json.loads(_META_PATH.read_text(encoding="utf-8"))
        models = data.get("models") if isinstance(data, dict) else None
        return models if isinstance(models, dict) else {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("model_nsfw_meta 读取失败: %s", exc)
        return {}


def lookup_explicit_nsfw(name: str) -> bool | None | object:
    """查显式元数据。

    返回:
      True/False — 显式布尔
      None — 显式声明 unknown(JSON null)
      _MISSING — 无登记(调用方再走文件名兜底)
    """
    reg = _explicit_registry()
    if name in reg:
        val = reg[name]
        if val is None:
            return None
        return bool(val)
    # 也试 basename
    base = name.split("/")[-1]
    if base != name and base in reg:
        val = reg[base]
        if val is None:
            return None
        return bool(val)
    return _MISSING


class _MissingType:
    __slots__ = ()

    def __repr__(self) -> str:
        return "<MISSING>"


_MISSING = _MissingType()


def classify_model_nsfw(name: str, *, explicit: bool | None | object = _MISSING) -> NsfwClass:
    """分类为 nsfw / sfw / unknown。"""
    if explicit is _MISSING:
        explicit = lookup_explicit_nsfw(name)
    if explicit is _MISSING:
        # 无显式 → 文件名兜底;无 NSFW hint → 视为已知 sfw(避免空 registry 藏光全部底模)
        return "nsfw" if is_nsfw(name) else "sfw"
    if explicit is None:
        return "unknown"
    return "nsfw" if explicit else "sfw"


def model_visible_for_account(*, name: str, adult: bool, explicit: bool | None | object = _MISSING) -> bool:
    """按账号成人态决定模型是否可见。"""
    cls = classify_model_nsfw(name, explicit=explicit)
    if adult:
        return cls in ("nsfw", "unknown")
    return cls == "sfw"


def filter_names_for_account(names: list[str], *, adult: bool) -> list[str]:
    return [n for n in names if model_visible_for_account(name=n, adult=adult)]
