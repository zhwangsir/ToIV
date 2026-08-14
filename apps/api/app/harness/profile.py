"""Harness profile 组合:按 TOIV_HARNESS_PROFILE 裁剪内建插件集。

三档:
- full:全部内建插件(llm + tool + 引擎 + 质量门)
- minimal:llm + tool + 引擎(基础图像/视频子集),无质量门
- headless:llm + tool + 引擎,无质量门无人格

引擎子集通过 EnginePlugin 的 disabled_engines 传入,minimal 档停用
专用实例引擎(H3/LongCat/LTX-2.5/Wan/Avatar)与 NSFW 引擎,仅保留
基础图像(txt2img/img2img)与 ACE 音乐。
"""
from __future__ import annotations

import logging
from typing import Any

from app.config import get_settings
from app.harness.context import HarnessContext
from app.harness.plugin import Plugin, PluginRegistry

logger = logging.getLogger(__name__)

# minimal/headless 档停用的引擎(专用实例 + NSFW + 高级视频引擎)
_MINIMAL_DISABLED = {
    "ltx25-t2v", "ltx25-i2v",
    "ltx-nsfw-t2v", "ltx-nsfw-i2v", "ltx-nsfw-lipsync",
    "h3-t2v", "h3-i2v", "h3-nsfw-t2v", "h3-nsfw-i2v",
    "longcat-t2v", "longcat-i2v", "longcat-continue",
    "avatar-talk", "wan-animate", "wan-vace",
    "nsfw-txt2img", "nsfw-img2img",
}

_HEADLESS_DISABLED = set(_MINIMAL_DISABLED)  # headless 与 minimal 停用同一引擎集

# profile 定义:插件工厂列表(延迟构造,避免循环 import)
# tool 插件(H2)在所有 profile 中保留(核心工具注册表+守卫管线)
_PROFILES: dict[str, dict[str, Any]] = {
    "full": {
        "plugins": ["llm", "tool", "engine", "quality"],
        "disabled_engines": set(),
    },
    "minimal": {
        "plugins": ["llm", "tool", "engine"],
        "disabled_engines": _MINIMAL_DISABLED,
    },
    "headless": {
        "plugins": ["llm", "tool", "engine"],
        "disabled_engines": _HEADLESS_DISABLED,
    },
}


def available_profiles() -> list[str]:
    """可用 profile 名列表。"""
    return list(_PROFILES.keys())


def _make_plugin(name: str, disabled_engines: set[str]) -> Plugin:
    """按名构造插件实例(延迟 import,避免模块加载环)。"""
    if name == "llm":
        from app.harness.llm_seam import LLMPlugin

        return LLMPlugin()
    if name == "tool":
        from app.harness.tool_seam import ToolPlugin

        return ToolPlugin()
    if name == "engine":
        from app.harness.engine_seam import EnginePlugin

        return EnginePlugin(disabled_engines=disabled_engines)
    if name == "quality":
        from app.harness.quality_seam import QualityPlugin

        return QualityPlugin()
    raise ValueError(f"未知内建插件: {name}")


def bootstrap_profile(ctx: HarnessContext, registry: PluginRegistry) -> None:
    """按 TOIV_HARNESS_PROFILE 引导插件。未知 profile 回退 full 并记 warning。"""
    profile_name = get_settings().harness_profile
    spec = _PROFILES.get(profile_name)
    if spec is None:
        logger.warning(
            "未知 harness profile %r,回退 full;可选: %s",
            profile_name,
            ", ".join(available_profiles()),
        )
        profile_name = "full"
        spec = _PROFILES["full"]

    disabled = spec["disabled_engines"]
    for plugin_name in spec["plugins"]:
        registry.use(_make_plugin(plugin_name, disabled))
    logger.info(
        "harness profile=%s,插件=%s,停用引擎=%d 个",
        profile_name,
        spec["plugins"],
        len(disabled),
    )
