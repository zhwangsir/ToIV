"""Studio 分镜多参考图:从角色三视图 + 场景图组装 @图片N 引用行。

对齐 services/h3_refs 正典(绝对开头连续引用);仅 H3 引擎注入。
角色槽序固定 正/侧/全身;场景图追加在角色之后。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from app.services.h3_refs import RefImage, build_ref_prefix

logger = logging.getLogger(__name__)

_CHAR_SLOT_LABELS = ("正面", "侧面", "全身")


def _parse_ref_list(raw: Any) -> list[str]:
    if isinstance(raw, list):
        return [str(u).strip() for u in raw if str(u).strip()]
    if isinstance(raw, str) and raw.strip():
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            return []
        if isinstance(data, list):
            return [str(u).strip() for u in data if str(u).strip()]
    return []


def collect_cast_ref_images(
    cast: list[Any],
    *,
    scene_images: list[str] | None = None,
    max_refs: int = 9,
) -> list[RefImage]:
    """角色三视图(正/侧/全身) + 场景图 → RefImage 列表(最多 max_refs,H3 Ref2VA 上限 9)。"""
    refs: list[RefImage] = []
    for c in cast:
        name = str(getattr(c, "name", "") or "").strip() or "角色"
        urls = _parse_ref_list(getattr(c, "reference_images", None))
        for i, url in enumerate(urls[:3]):
            slot = _CHAR_SLOT_LABELS[i] if i < len(_CHAR_SLOT_LABELS) else f"参考{i + 1}"
            refs.append(
                RefImage(
                    label=f"{name}{slot}身份与服装参考",
                    role=name,
                    image_url=url,
                )
            )
            if len(refs) >= max_refs:
                return refs
    for i, url in enumerate(scene_images or []):
        u = str(url or "").strip()
        if not u:
            continue
        refs.append(
            RefImage(
                label=f"场景{i + 1}场景与光影参考",
                role="scene",
                image_url=u,
            )
        )
        if len(refs) >= max_refs:
            break
    return refs


def ref_urls(refs: list[RefImage]) -> list[str]:
    return [r.image_url for r in refs if r.image_url]


def h3_ref_prefix(
    cast: list[Any],
    *,
    engine: str,
    ref_images: list[str] | None = None,
    scene_images: list[str] | None = None,
) -> tuple[str, list[str]]:
    """返回 (引用行前缀, 实际使用的 URL 列表)。非 h3 → ("", [])。

    ref_images 显式给出时按该列表编号(调用方已排好序,可含场景);
    否则从 cast 三视图 + scene_images 自动收集。
    """
    if engine != "h3":
        return "", []
    if ref_images is not None:
        refs = [
            RefImage(label=f"参考图{i + 1}", role="", image_url=u.strip())
            for i, u in enumerate(ref_images)
            if isinstance(u, str) and u.strip()
        ][:9]
    else:
        refs = collect_cast_ref_images(cast, scene_images=scene_images)
    prefix = build_ref_prefix(refs)
    urls = ref_urls(refs)
    if prefix:
        logger.info("studio h3 注入 %d 张参考图引用行", len(urls))
    return prefix, urls
