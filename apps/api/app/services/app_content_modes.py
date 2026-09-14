"""SFW/R18 content-mode merge for market apps.

One market card (SFW parent) can expose both SFW + NSFW modes when a twin
exists. R18 twin cards are soft-hidden (is_public=False); the runner swaps
to the twin workflow_json/bindings when content_mode=nsfw.

Keep product builtins; map is code-side so builtin PUT whitelist stays narrow.
"""
from __future__ import annotations

# SFW parent id → NSFW twin id (identical params_schema; different graph/UNET)
SFW_NSFW_TWINS: dict[str, str] = {
    # H3 family (clearest case)
    "h3-t2v": "h3-nsfw-t2v",
    "h3-i2v": "h3-nsfw-i2v",
    "h3-fl2v": "h3-nsfw-fl2v",
    "h3-r2v": "h3-nsfw-r2v",
    "h3-t2v-15s-fast": "h3-nsfw-t2v-15s-fast",
    "h3-i2v-15s-fast": "h3-nsfw-i2v-15s-fast",
    "h3-r2v-voice": "h3-nsfw-r2v-voice",
    # image twins
    "txt2img-basic": "nsfw-txt2img",
    "img2img-basic": "nsfw-img2img",
}

# Reverse: NSFW twin → SFW parent (for redirects / hide lists)
NSFW_TO_SFW: dict[str, str] = {v: k for k, v in SFW_NSFW_TWINS.items()}

# Soft-hide these twin cards from market (keep rows for runner swap)
MERGE_HIDE_IDS: tuple[str, ...] = tuple(SFW_NSFW_TWINS.values())


def content_modes_for(app_id: str, *, is_nsfw: bool, has_twin: bool) -> list[str]:
    """Return market/runner content mode tags for an app card."""
    if app_id in SFW_NSFW_TWINS and has_twin:
        return ["sfw", "nsfw"]
    if is_nsfw or app_id in NSFW_TO_SFW:
        return ["nsfw"]
    return ["sfw"]


def nsfw_variant_id_for(app_id: str) -> str | None:
    return SFW_NSFW_TWINS.get(app_id)
