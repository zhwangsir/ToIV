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

_SHEET_STYLES = ("anime", "ancient_realistic")


def _parse_by_style(raw: Any) -> dict[str, list[str]]:
    if isinstance(raw, dict):
        return {
            str(k): [str(u).strip() for u in (v or []) if str(u).strip()]
            for k, v in raw.items()
            if isinstance(v, list) and str(k) in _SHEET_STYLES
        }
    if isinstance(raw, str) and raw.strip():
        try:
            parsed = json.loads(raw)
        except (ValueError, TypeError):
            return {}
        if isinstance(parsed, dict):
            return _parse_by_style(parsed)
    return {}


def resolve_ref_style(
    explicit: str | None = None,
    *,
    project_style: str | None = None,
    cast: list[Any] | None = None,
) -> str | None:
    """决定视频步读哪个 reference_images_by_style 桶。

    优先级：显式 ref_style → 项目画风文案推断 → 角色分桶里唯一有 panel 的风格。
    多桶并存且无法推断时返回 None（回落扁平 reference_images；雨夜样片保持 sample 兜底）。
    """
    e = (explicit or "").strip()
    el = e.lower()
    if el in _SHEET_STYLES:
        return el
    aliases = {
        "二次元": "anime",
        "动漫": "anime",
        "卡通": "anime",
        "cartoon": "anime",
        "古风": "ancient_realistic",
        "古风写实": "ancient_realistic",
        "ancient": "ancient_realistic",
        "汉服": "ancient_realistic",
    }
    if e in aliases:
        return aliases[e]
    if el in aliases:
        return aliases[el]

    raw = project_style or ""
    text = raw.lower()
    anime_keys = ("二次元", "anime", "动漫", "卡通", "cel")
    ancient_keys = ("古风", "ancient", "汉服", "仙侠", "写实古")
    anime_hit = any(k in raw or k in text for k in anime_keys)
    ancient_hit = any(k in raw or k in text for k in ancient_keys)
    if anime_hit and not ancient_hit:
        return "anime"
    if ancient_hit and not anime_hit:
        return "ancient_realistic"

    populated: set[str] = set()
    for c in cast or []:
        by_style = _parse_by_style(getattr(c, "reference_images_by_style", None))
        for st, urls in by_style.items():
            if any("char_panel_" in u for u in urls):
                populated.add(st)
    if len(populated) == 1:
        return next(iter(populated))
    return None


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
    style: str | None = None,
) -> list[RefImage]:
    """立绘+三视图(正/侧/背) + 场景图 → RefImage(最多 max_refs)。

    Batch7 v2(17:45#6):整卡 char_sheet_ 不进 Ref2VA 视频参考链;
    仅使用非设定卡 URL(优先 char_panel_ 立绘/三视图)。
    22:31+:优先 reference_images_by_style[style];无分桶时回落扁平 reference_images。
    """
    refs: list[RefImage] = []
    _panel_slot = {
        "portrait": "立绘",
        "front": "正面",
        "side": "侧面",
        "back": "背面",
    }
    for c in cast:
        name = str(getattr(c, "name", "") or "").strip() or "角色"
        urls: list[str] = []
        by_style = _parse_by_style(getattr(c, "reference_images_by_style", None))
        if style and style in by_style and by_style[style]:
            urls = list(by_style[style])
            # 附加扁平列里的非 panel(sample_*)
            for u in _parse_ref_list(getattr(c, "reference_images", None)):
                if "char_panel_" in u or "char_sheet_" in u:
                    continue
                if u not in urls:
                    urls.append(u)
        else:
            urls = _parse_ref_list(getattr(c, "reference_images", None))
        views = [u for u in urls if "char_sheet_" not in u]
        for i, url in enumerate(views[:4]):
            slot = None
            for key, lab in _panel_slot.items():
                if f"_{key}_" in url or url.rstrip("/").endswith(f"_{key}.png"):
                    slot = lab
                    break
            if slot is None:
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



def resolve_scene_images_for_shot(
    scene_images: list[str] | None,
    shot_idx: int = 0,
) -> list[str]:
    """项目级场景图 → 本镜场景参考。

    - 0 张：[]
    - 1 张：全项目共用（兼容旧种子）
    - ≥2 张：按 shot.idx 取一张（门外/货架/收银台/出门），避免全集共用门外图
    """
    scenes = [str(u).strip() for u in (scene_images or []) if str(u or "").strip()]
    if not scenes:
        return []
    if len(scenes) == 1:
        return scenes
    i = max(0, min(int(shot_idx or 0), len(scenes) - 1))
    return [scenes[i]]

def ref_urls(refs: list[RefImage]) -> list[str]:
    return [r.image_url for r in refs if r.image_url]


def h3_ref_prefix(
    cast: list[Any],
    *,
    engine: str,
    ref_images: list[str] | None = None,
    scene_images: list[str] | None = None,
    style: str | None = None,
) -> tuple[str, list[str]]:
    """返回 (引用行前缀, 实际使用的 URL 列表)。非 h3 → ("", [])。

    ref_images 显式给出时按该列表编号(调用方已排好序,可含场景);
    否则从 cast 三视图(+分桶风格) + scene_images 自动收集。
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
        refs = collect_cast_ref_images(cast, scene_images=scene_images, style=style)
    prefix = build_ref_prefix(refs)
    urls = ref_urls(refs)
    if prefix:
        logger.info("studio h3 注入 %d 张参考图引用行", len(urls))
    return prefix, urls
