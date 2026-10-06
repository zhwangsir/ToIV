"""角色资产协议 L2 层:Character Asset Definition(结构化资产)+ 展示卡渲染。

协议 docs/ops/CHARACTER_ASSET_PROTOCOL.md(2026-10-06 拍板):
- 角色卡三层资产:L1 视觉(面板文件)/ L2 结构化(本模块 JSON)/ L3 生成资产(参考图索引)。
- 生成次序反转:canonical 底图先行 → 门禁派生面板 → 设定卡/展示卡只是资产的渲染视图。
- identity_anchors / coverage / provenance 是相对外部规范稿新增的承重字段。

存储约定(与 character_sheet 文件态一致,drama_output_root()/studio/):
- char_asset_{cid8}_{style}.json        L2 资产定义(单文件,写入原子替换)
- char_card_{cid8}_{style}_{uuid}.png   展示卡(对外传播形态,只增不改)
"""
from __future__ import annotations

import json
import re
import time
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from app.services.studio.character_sheet import (
    SHEET_STYLES,
    CharacterSheetError,
    SheetMeta,
    extract_ancient_costume_spec,
    placeholder_panel,
    resolve_cjk_font,
)
from app.storage import drama_output_root

ASSET_SCHEMA_VERSION = 1

# ── 词表(协议单一真源) ────────────────────────────────────────────────

ANCHOR_KINDS = (
    "identity",
    "hair",
    "eyes",
    "face",
    "skin",
    "body",
    "costume",
    "accessory",
    "weapon",
    "color",
    "creature",
)
ENFORCE_MODES = ("prompt", "prompt+negative", "gate")

PANEL_KEYS = ("portrait", "front", "side", "back", "faces", "costume")
ANGLE_BY_PANEL = {"front": "front", "side": "side", "back": "back"}
COVERAGE_ANGLES = ("front", "side", "back")
COVERAGE_FRAMINGS = ("full_body", "medium_closeup", "over_shoulder", "extreme_closeup")
COVERAGE_LIGHTINGS = ("day", "night", "rain_backlit", "indoor_warm")
MOUTH_SERIES = ("closed", "O_small", "wide_open")
EXPRESSION_EMOTIONS = ("威严", "冷酷", "沉思", "温柔", "惊恐", "果断")
DETAIL_REGIONS = ("collar", "cuff", "hem", "boots")

# 短剧默认覆盖画像:镜头侧按此对照补拍
DEFAULT_DRAMA_COVERAGE_PROFILE: dict[str, list[str]] = {
    "angles": ["front", "side", "back"],
    "framings": ["full_body", "medium_closeup"],
    "lightings": ["day", "night"],
}

# 跨风格 variant(M2):锚点不动,画风重绘
STYLE_VARIANTS: dict[str, dict[str, str]] = {
    "ancient_realistic": {
        "zh": "古风写实",
        "positive": "ancient chinese style, realistic painting, cinematic lighting",
        "negative": "anime, cel shading, cartoon lines",
    },
    "anime": {
        "zh": "二次元",
        "positive": "anime style, cel shading, clean lineart",
        "negative": "photorealistic skin texture, film grain",
    },
    "realistic": {
        "zh": "写实",
        "positive": "photorealistic, 85mm lens, natural skin texture",
        "negative": "anime, illustration, painting brush strokes",
    },
    "ink_wash": {
        "zh": "水墨",
        "positive": "chinese ink wash painting, shuimo, monochrome brushwork",
        "negative": "vivid saturated colors, 3d render",
    },
    "cyberpunk": {
        "zh": "赛博朋克",
        "positive": "cyberpunk, neon rim light, futuristic city vibe",
        "negative": "ancient chinese architecture, traditional painting",
    },
    "three_d": {
        "zh": "3D",
        "positive": "3d character render, pixar-like stylization, soft global illumination",
        "negative": "flat 2d lineart, paper texture",
    },
}

_CARD_MARK = "char_card_"
ASSET_JSON_MARK = "char_asset_"

CARD_W, CARD_H = 1600, 2240

_CARD_THEMES: dict[str, dict[str, Any]] = {
    "ancient_realistic": {
        "bg": (243, 237, 225),
        "title_bar": (72, 60, 46),
        "title_text": (243, 237, 225),
        "text": (56, 46, 36),
        "text_dim": (120, 106, 88),
        "outline": (150, 134, 110),
        "panel_bg": (252, 249, 242),
    },
    "anime": {
        "bg": (240, 240, 247),
        "title_bar": (52, 52, 72),
        "title_text": (245, 245, 250),
        "text": (48, 48, 60),
        "text_dim": (118, 118, 138),
        "outline": (150, 150, 176),
        "panel_bg": (250, 250, 254),
    },
}
_CARD_THEME_DEFAULT = _CARD_THEMES["anime"]


# ── 工具 ──────────────────────────────────────────────────────────────

_HEX_RE = re.compile(r"^#?[0-9a-fA-F]{6}$")


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S+08:00", time.localtime())


def _norm_hex(raw: str) -> str:
    """'#ABC' / 'ABCDEF' / '#abcdef ' → '#abcdef';非法返回原样(校验层兜)。"""
    s = (raw or "").strip()
    if re.fullmatch(r"#?[0-9a-fA-F]{3}", s):
        s = "#" + "".join(c * 2 for c in s.lstrip("#"))
    if _HEX_RE.fullmatch(s) and not s.startswith("#"):
        s = "#" + s
    return s.lower()


def _is_hex(raw: str) -> bool:
    return _HEX_RE.fullmatch((raw or "").strip()) is not None


# ── 锚点数据化 ────────────────────────────────────────────────────────

_HAIR_TOKEN_RE = re.compile(
    r"\b((?:short|long|medium|shoulder[- ]length|chin[- ]length|black|white|silver|grey|gray|brown|blonde|blue|pink|red|purple|pink|twin|ponytail|bob)[\w-]*\s+(?:hair|bangs|ponytail))\b",
    re.IGNORECASE,
)
_EYE_TOKEN_RE = re.compile(
    r"\b((?:blue|violet|purple|grey|gray|green|golden|amber|red|pink|black|brown|ice[- ]blue|heterochromatic)[\w-]*\s+eyes)\b",
    re.IGNORECASE,
)
_HAIR_ZH_RE = re.compile(r"([黑白金银红棕紫蓝绿]色?)(短发|长发|头发|马尾|双马尾|齐下巴)")
_ACC_ZH_RE = re.compile(r"(雨衣|连帽衫|斗篷|面具|耳环|发冠|步摇|玉佩|围巾|徽章)")


def default_identity_anchors(meta: SheetMeta) -> list[dict[str, str]]:
    """从 SheetMeta(视觉描述+服装 spec)抽取 3–10 条身份锚点。

    数据化来源:①身份(恒有) ②发型/瞳色 token 扫描(visual_prompt) ③古风服装 spec
    (extract_ancient_costume_spec 的结构化产物) ④中文关键词兜底。
    """
    anchors: list[dict[str, str]] = [
        {"kind": "identity", "desc": (meta.name or "").strip() or "角色", "enforce": "prompt"}
    ]
    seen = {("identity", anchors[0]["desc"])}

    def _add(kind: str, desc: str, enforce: str = "prompt+negative") -> None:
        desc = (desc or "").strip().strip(",;、")
        if not desc or (kind, desc.lower()) in seen:
            return
        seen.add((kind, desc.lower()))
        anchors.append({"kind": kind, "desc": desc, "enforce": enforce})

    text = f"{meta.visual_prompt} {meta.description}"
    for m in _HAIR_TOKEN_RE.finditer(text):
        _add("hair", m.group(1).lower())
    for m in _EYE_TOKEN_RE.finditer(text):
        _add("eyes", m.group(1).lower())
    if meta.style == "ancient_realistic":
        spec = extract_ancient_costume_spec(meta)
        if spec.get("garment_en"):
            garment = spec["garment_en"]
            colors = spec.get("colors") or []
            if colors:
                garment = f"{colors[0]['en']} {garment}"
            _add("costume", garment)
        for tag in (spec.get("accessory_tags") or [])[:2]:
            _add("accessory", tag)
        if spec.get("hair"):
            _add("hair", spec["hair"])
    for m in _HAIR_ZH_RE.finditer(text):
        _add("hair", f"{m.group(1)}{m.group(2)}")
    for m in _ACC_ZH_RE.finditer(text):
        _add("accessory", m.group(1))
    return anchors[:10]


# ── 色板 ──────────────────────────────────────────────────────────────

def sample_palette_from_image(data: bytes, n: int = 6) -> list[str]:
    """从主立绘采样主色(Pillow 量化,确定性,无第三方依赖)。"""
    try:
        img = Image.open(BytesIO(data)).convert("RGB")
    except Exception:  # noqa: BLE001
        return []
    img = img.resize((64, 64))
    q = img.quantize(colors=max(n, 4))
    palette = q.getpalette() or []
    counts = sorted(q.getcolors() or [], reverse=True)
    out: list[str] = []
    for cnt, idx in counts[:n]:
        r, g, b = palette[idx * 3 : idx * 3 + 3]
        hx = f"#{r:02x}{g:02x}{b:02x}"
        if hx not in out:
            out.append(hx)
    return out


def build_palette(colors: list[str] | None, portrait_bytes: bytes | None = None) -> dict[str, Any]:
    """>colors 优先;否则从主立绘采样。结构:{primary/secondary/accent, extras[]}。"""
    hexes: list[str] = []
    for c in colors or []:
        hx = _norm_hex(c)
        if _is_hex(hx):
            hexes.append(hx)
    if not hexes and portrait_bytes:
        hexes = sample_palette_from_image(portrait_bytes)
    hexes = hexes[:8]
    out: dict[str, Any] = {
        "primary": hexes[0] if hexes else "",
        "secondary": hexes[1] if len(hexes) > 1 else "",
        "accent": hexes[2] if len(hexes) > 2 else "",
        "extras": hexes[3:],
        "variants": {},
    }
    return out


# ── 覆盖登记 ──────────────────────────────────────────────────────────

def default_coverage(panel_keys: list[str]) -> dict[str, Any]:
    keys = {k for k in panel_keys if k in PANEL_KEYS}
    angles = [ANGLE_BY_PANEL[k] for k in ("front", "side", "back") if k in keys]
    return {
        "angles": angles,
        "framings": ["full_body"] if "portrait" in keys else [],
        "lightings": [],
        "two_shot": False,
    }


def coverage_gaps(
    coverage: dict[str, Any], profile: dict[str, list[str]] | None = None
) -> dict[str, list[str]]:
    prof = profile or DEFAULT_DRAMA_COVERAGE_PROFILE
    cov = coverage or {}

    def _gap(key: str) -> list[str]:
        have = {str(x) for x in (cov.get(key) or [])}
        return [r for r in prof.get(key, []) if r not in have]

    return {k: _gap(k) for k in ("angles", "framings", "lightings")}


_FRAMING_PROMPTS = {
    "full_body": "full body standing shot",
    "medium_closeup": "medium close-up, chest and above, facing camera",
    "over_shoulder": "over-the-shoulder shot from behind, head turned three-quarter",
    "extreme_closeup": "extreme close-up of face, eyes sharp",
}
_LIGHTING_PROMPTS = {
    "day": "soft daylight, outdoor",
    "night": "night scene, cool moonlight, low-key lighting",
    "rain_backlit": "rainy night, backlit silhouette, rim light through rain",
    "indoor_warm": "indoor warm lamplight, cozy tone",
}


def coverage_backfill_plan(
    asset: dict[str, Any], profile: dict[str, list[str]] | None = None
) -> list[dict[str, str]]:
    """M2:覆盖缺口补拍计划(只出计划,不执行;执行挂现有生成链)。"""
    gaps = coverage_gaps(asset.get("coverage") or {}, profile)
    anchors = asset.get("identity_anchors") or []
    anchor_text = ", ".join(a["desc"] for a in anchors if a.get("desc"))
    negative = ", ".join(asset.get("canonical_prompt", {}).get("negative_constraints") or [])
    plan: list[dict[str, str]] = []
    for angle in gaps["angles"]:
        plan.append(
            {
                "kind": "angle",
                "key": angle,
                "positive": f"same character, {anchor_text}, {angle} view, full body, neutral standing pose",
                "negative": negative,
            }
        )
    for framing in gaps["framings"]:
        plan.append(
            {
                "kind": "framing",
                "key": framing,
                "positive": f"same character, {anchor_text}, {_FRAMING_PROMPTS.get(framing, framing)}",
                "negative": negative,
            }
        )
    for lighting in gaps["lightings"]:
        plan.append(
            {
                "kind": "lighting",
                "key": lighting,
                "positive": f"same character, {anchor_text}, {_LIGHTING_PROMPTS.get(lighting, lighting)}",
                "negative": negative,
            }
        )
    return plan


# ── 跨风格 variant(M2) ──────────────────────────────────────────────

def build_style_variant_prompt(asset: dict[str, Any], target_style: str) -> dict[str, Any]:
    """锚点不动、画风重绘的 variant 提示词对。未知风格 → ValueError。"""
    if target_style not in STYLE_VARIANTS:
        raise ValueError(f"未知风格: {target_style}")
    spec = STYLE_VARIANTS[target_style]
    anchors = asset.get("identity_anchors") or []
    anchor_text = ", ".join(a["desc"] for a in anchors if a.get("desc"))
    neg = asset.get("canonical_prompt", {}).get("negative_constraints") or []
    return {
        "target_style": target_style,
        "style_zh": spec["zh"],
        "positive": f"same character (canonical identity unchanged), {anchor_text}, {spec['positive']}",
        "negative": ", ".join([*neg, spec["negative"]]),
        "anchors": anchors,
        "rule": "Identity Anchors 优先级高于画风;变体从 canonical 出发派生,不是重造角色",
    }


# ── 版本 / 溯源 ───────────────────────────────────────────────────────

def record_regeneration(
    asset: dict[str, Any],
    *,
    reason: str,
    workflow: str = "",
    model: str = "",
    seed: int | None = None,
) -> dict[str, Any]:
    """底图/面板重生成 → 版本 +1 + derived_from 级联记录(协议第三节 Canonical Rule 3)。"""
    prev = int(asset.get("version") or 1)
    asset["version"] = prev + 1
    asset["derived_from"] = {
        "base_version": prev,
        "regen_reason": (reason or "").strip(),
    }
    prov = asset.setdefault("provenance", {})
    regens = prov.setdefault("regenerations", [])
    entry: dict[str, Any] = {"at": _now_iso(), "reason": (reason or "").strip()}
    if workflow:
        entry["workflow"] = workflow
    if model:
        entry["model"] = model
    if seed is not None:
        entry["seed"] = seed
    regens.append(entry)
    asset["updated_at"] = _now_iso()
    return asset


# ── 校验 ──────────────────────────────────────────────────────────────

def validate_asset(d: dict[str, Any]) -> list[str]:
    """L2 资产校验;返回错误清单(空=通过)。PUT 端点据此 422。"""
    errs: list[str] = []
    if not isinstance(d, dict):
        return ["资产必须是 JSON 对象"]
    if d.get("schema_version") != ASSET_SCHEMA_VERSION:
        errs.append(f"schema_version 须为 {ASSET_SCHEMA_VERSION}")
    cid = d.get("character_id")
    if not isinstance(cid, str) or not cid.strip():
        errs.append("character_id 不能为空")
    if not isinstance(d.get("version"), int) or int(d.get("version") or 0) < 1:
        errs.append("version 须为 ≥1 整数")
    anchors = d.get("identity_anchors")
    if anchors is not None:
        if not isinstance(anchors, list) or len(anchors) > 10:
            errs.append("identity_anchors 须为 ≤10 条列表")
        else:
            for i, a in enumerate(anchors):
                if not isinstance(a, dict):
                    errs.append(f"identity_anchors[{i}] 须为对象")
                    continue
                if a.get("kind") not in ANCHOR_KINDS:
                    errs.append(f"identity_anchors[{i}].kind 非法")
                if not str(a.get("desc") or "").strip():
                    errs.append(f"identity_anchors[{i}].desc 不能为空")
                if a.get("enforce") not in ENFORCE_MODES:
                    errs.append(f"identity_anchors[{i}].enforce 非法")
    pal = d.get("color_palette")
    if pal is not None:
        if not isinstance(pal, dict):
            errs.append("color_palette 须为对象")
        else:
            for k in ("primary", "secondary", "accent"):
                v = pal.get(k, "")
                if v and not _is_hex(str(v)):
                    errs.append(f"color_palette.{k} 非 HEX")
            for j, v in enumerate(pal.get("extras") or []):
                if not _is_hex(str(v)):
                    errs.append(f"color_palette.extras[{j}] 非 HEX")
    cov = d.get("coverage")
    if cov is not None:
        if not isinstance(cov, dict):
            errs.append("coverage 须为对象")
        else:
            for k, vocab in (
                ("angles", COVERAGE_ANGLES),
                ("framings", COVERAGE_FRAMINGS),
                ("lightings", COVERAGE_LIGHTINGS),
            ):
                vals = cov.get(k)
                if vals is None:
                    continue
                if not isinstance(vals, list):
                    errs.append(f"coverage.{k} 须为列表")
                else:
                    for v in vals:
                        if v not in vocab:
                            errs.append(f"coverage.{k} 含未知值 {v}")
            if not isinstance(cov.get("two_shot", False), bool):
                errs.append("coverage.two_shot 须为布尔")
    expr = d.get("expressions")
    if expr is not None:
        if not isinstance(expr, dict):
            errs.append("expressions 须为对象")
        else:
            ms = expr.get("mouth_series")
            if ms is not None and any(m not in MOUTH_SERIES for m in ms):
                errs.append("expressions.mouth_series 含未知口型")
    lock = d.get("lock")
    if lock is not None:
        if not isinstance(lock, dict):
            errs.append("lock 须为对象")
        else:
            # panels 是锁定面板键列表;base/layout 是布尔
            for k, v in lock.items():
                if k == "panels":
                    if not isinstance(v, list) or not all(
                        isinstance(x, str) for x in v
                    ):
                        errs.append("lock.panels 须为字符串列表")
                elif not isinstance(v, bool):
                    errs.append(f"lock.{k} 须为布尔")
    cp = d.get("canonical_prompt")
    if cp is not None and not isinstance(cp, dict):
        errs.append("canonical_prompt 须为对象")
    sv = d.get("style_variants")
    if sv is not None:
        # M2 跨风格变体登记:{ink_wash: {url, prompt, negative, seed, ckpt, at}}
        if not isinstance(sv, dict):
            errs.append("style_variants 须为对象")
        else:
            for key, v in sv.items():
                if not isinstance(key, str) or not key.strip():
                    errs.append("style_variants 键须为非空字符串")
                    continue
                if not isinstance(v, dict) or not str(v.get("url") or "").strip():
                    errs.append(f"style_variants.{key} 须含 url")
    return errs


# ── 资产构建 / 物化(D3 回填引擎) ────────────────────────────────────

def new_asset(
    *,
    character_id: str,
    style: str,
    meta: SheetMeta,
    panel_keys: list[str] | None = None,
    portrait_bytes: bytes | None = None,
) -> dict[str, Any]:
    anchors = default_identity_anchors(meta)
    palette = build_palette(meta.colors, portrait_bytes)
    coverage = default_coverage(panel_keys or [])
    return {
        "schema_version": ASSET_SCHEMA_VERSION,
        "character_id": character_id,
        "style": {"current": style, "variants_allowed": True},
        "version": 1,
        "provenance": {"base": {}, "regenerations": []},
        "derived_from": None,
        "lock": {"base": False, "panels": [], "layout": False},
        "identity_anchors": anchors,
        "face": {},
        "body": {"height_cm": meta.height_cm},
        "hair": {},
        "eyes": {},
        "skin": {},
        "costume": {"detail_regions": list(DETAIL_REGIONS)},
        "accessories": [],
        "weapon": [],
        "color_palette": palette,
        "expressions": {
            "emotions": list(EXPRESSION_EMOTIONS),
            "mouth_series": list(MOUTH_SERIES),
        },
        "coverage": coverage,
        "profile": {
            "name": (meta.name or "").strip(),
            "role": (meta.role or "").strip(),
            "personality": (meta.personality or "").strip(),
            "background": (meta.description or "").strip(),
            "speech_style": "",
        },
        "canonical_prompt": {
            "positive": (meta.visual_prompt or "").strip(),
            "negative_constraints": [],
        },
        "style_variants": {},
        "panels": {k: True for k in (panel_keys or [])},
        "qa": {"face_gate": {"threshold": 0.94, "last": None}, "human_review": ""},
        "created_at": _now_iso(),
        "updated_at": _now_iso(),
    }


def asset_json_path(character_id: str, style: str) -> Path:
    return (
        drama_output_root()
        / "studio"
        / f"{ASSET_JSON_MARK}{character_id[:8]}_{style}.json"
    )


def load_asset(character_id: str, style: str) -> dict[str, Any] | None:
    p = asset_json_path(character_id, style)
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (ValueError, OSError):
        return None
    return data if isinstance(data, dict) else None


def save_asset(asset: dict[str, Any]) -> Path:
    errs = validate_asset(asset)
    if errs:
        raise CharacterSheetError(
            f"角色资产校验失败: {'; '.join(errs[:4])}", status_code=422
        )
    asset["updated_at"] = _now_iso()
    p = asset_json_path(asset["character_id"], asset["style"]["current"])
    p.parent.mkdir(parents=True, exist_ok=True)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(
        json.dumps(asset, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    tmp.replace(p)
    return p


def latest_panel_paths(character_id: str, style: str) -> dict[str, Path]:
    """复用 character-sheets 列表口径:char_panel_{cid8}_{style}_{key}_*.png 取最新。"""
    studio = drama_output_root() / "studio"
    out: dict[str, Path] = {}
    if not studio.exists():
        return out
    prefix = f"char_panel_{character_id[:8]}_{style}_"
    for key in PANEL_KEYS:
        hits = sorted(
            studio.glob(f"{prefix}{key}_*.png"),
            key=lambda p: p.stat().st_mtime,
        )
        if hits:
            out[key] = hits[-1]
    return out


def ensure_asset(
    *,
    character_id: str,
    style: str,
    name: str,
    description: str = "",
    visual_prompt: str = "",
    height_cm: int = 168,
) -> dict[str, Any]:
    """读取侧物化:JSON 在则返回;不在则从存量面板文件 + 角色行回填 v1(D3)。"""
    if style not in SHEET_STYLES:
        raise CharacterSheetError(
            f"style 须为 {'/'.join(SHEET_STYLES)}", status_code=422
        )
    existing = load_asset(character_id, style)
    if existing is not None:
        return existing
    panels = latest_panel_paths(character_id, style)
    portrait_bytes: bytes | None = None
    if "portrait" in panels:
        try:
            portrait_bytes = panels["portrait"].read_bytes()
        except OSError:
            portrait_bytes = None
    meta = SheetMeta(
        name=name,
        style=style,
        height_cm=height_cm,
        visual_prompt=visual_prompt,
        description=description,
    )
    asset = new_asset(
        character_id=character_id,
        style=style,
        meta=meta,
        panel_keys=list(panels.keys()),
        portrait_bytes=portrait_bytes,
    )
    if panels:
        asset["provenance"]["base"] = {
            "source": "backfill",
            "panels_found": sorted(panels.keys()),
            "materialized_at": _now_iso(),
        }
    save_asset(asset)
    return asset


def note_sheet_generated(
    character_id: str, style: str, *, reason: str, workflow: str = "character_sheet"
) -> dict[str, Any] | None:
    """生成链钩子:设定卡/面板重生成后版本级联(资产未物化时跳过,首次 GET 落 v1)。"""
    asset = load_asset(character_id, style)
    if asset is None:
        return None
    record_regeneration(asset, reason=reason, workflow=workflow)
    save_asset(asset)
    return asset


# ── 展示卡渲染(D2:对外「一张图全家桶」形态) ─────────────────────────

def _fit_cover(img: Image.Image, box: tuple[int, int, int, int]) -> Image.Image:
    x0, y0, x1, y1 = box
    bw, bh = x1 - x0, y1 - y0
    sw, sh = img.size
    scale = max(bw / sw, bh / sh)
    img = img.resize((max(1, round(sw * scale)), max(1, round(sh * scale))))
    sw, sh = img.size
    left = max(0, (sw - bw) // 2)
    top = max(0, (sh - bh) // 2)
    return img.crop((left, top, left + bw, top + bh))


def _wrap(text: str, font: ImageFont.FreeTypeFont, max_w: int) -> list[str]:
    lines: list[str] = []
    cur = ""
    for ch in text:
        if font.getlength(cur + ch) > max_w and cur:
            lines.append(cur)
            cur = ch
        else:
            cur += ch
    if cur:
        lines.append(cur)
    return lines


def compose_asset_card(
    panels: dict[str, Any],
    asset: dict[str, Any],
    *,
    font_path_probe: bool = True,
) -> bytes:
    """渲染展示卡 PNG:资产集的视图,非一致性来源;缺面板用占位格,不抛错。"""
    style = (asset.get("style") or {}).get("current") or "anime"
    theme = _CARD_THEMES.get(style, _CARD_THEME_DEFAULT)
    if font_path_probe:
        f_title = resolve_cjk_font(44)
        f_name = resolve_cjk_font(52)
        f_section = resolve_cjk_font(24)
        f_body = resolve_cjk_font(20)
        f_small = resolve_cjk_font(16)
    else:  # pragma: no cover
        f_title = f_name = f_section = f_body = f_small = ImageFont.load_default()

    canvas = Image.new("RGB", (CARD_W, CARD_H), theme["bg"])
    draw = ImageDraw.Draw(canvas)

    def _panel(key: str) -> Image.Image:
        raw = panels.get(key)
        if isinstance(raw, Image.Image):
            return raw.convert("RGB")
        if isinstance(raw, (bytes, bytearray)):
            try:
                return Image.open(BytesIO(bytes(raw))).convert("RGB")
            except Exception:  # noqa: BLE001
                pass
        return placeholder_panel(theme["outline"], size=(512, 768)).convert("RGB")

    def _frame(box: tuple[int, int, int, int], label: str) -> None:
        draw.rectangle(box, outline=theme["outline"], width=2)
        lx, ly, _, _ = box
        # 标签带底衬:避免白字直接压在图像上不可读
        tw = int(f_small.getlength(label))
        draw.rectangle(
            [lx + 2, ly + 2, lx + 12 + tw, ly + 24], fill=theme["title_bar"]
        )
        draw.text((lx + 7, ly + 4), label, font=f_small, fill=theme["title_text"])

    # 顶栏
    draw.rectangle([0, 0, CARD_W, 44], fill=theme["title_bar"])
    style_zh = {
        "ancient_realistic": "古风写实",
        "anime": "二次元",
    }.get(style, style)
    cid = asset.get("character_id", "")
    ver = asset.get("version", 1)
    draw.text(
        (40, 10),
        f"角色资产卡 · {style_zh} · {cid[:8]} · v{ver}",
        font=f_section,
        fill=theme["title_text"],
    )

    # 主视觉(左)
    hero_box = (40, 64, 820, 1284)
    canvas.paste(_fit_cover(_panel("portrait"), hero_box), (hero_box[0], hero_box[1]))
    _frame(hero_box, "主视觉 HERO")

    # 名字块
    profile = asset.get("profile") or {}
    name = (profile.get("name") or "").strip() or (asset.get("character_id") or "?")
    draw.text((860, 64), name[:10], font=f_name, fill=theme["text"])
    y = 140
    for label, val in (
        ("身份", profile.get("role")),
        ("性格", profile.get("personality")),
    ):
        if val:
            draw.text((860, y), f"{label}: {val}"[:26], font=f_body, fill=theme["text"])
            y += 32
    if profile.get("speech_style"):
        draw.text((860, y), f"口吻: {profile['speech_style']}"[:26], font=f_body, fill=theme["text_dim"])

    # 识别锚点
    ay = 276
    draw.text((860, ay), "识别锚点 IDENTITY ANCHORS", font=f_section, fill=theme["text"])
    ay += 36
    for a in (asset.get("identity_anchors") or [])[:10]:
        desc = str(a.get("desc") or "")[:34]
        kind = str(a.get("kind") or "")[:10]
        draw.text((868, ay), f"· [{kind}] {desc}", font=f_body, fill=theme["text"])
        ay += 27
        if ay > 610:
            break

    # 三视图
    turn_y = 656
    draw.text((860, turn_y), "多角度 TURNAROUND", font=f_section, fill=theme["text"])
    cell_w, cell_h = 220, 356
    for i, key in enumerate(("front", "side", "back")):
        bx0 = 860 + i * (cell_w + 10)
        box = (bx0, turn_y + 36, bx0 + cell_w, turn_y + 36 + cell_h)
        canvas.paste(_fit_cover(_panel(key), box), (box[0], box[1]))
        _frame(box, {"front": "正", "side": "侧", "back": "背"}[key])

    # 表情/口型
    ex_y = 1088
    ex_box = (860, ex_y, 1560, ex_y + 196)
    canvas.paste(_fit_cover(_panel("faces"), ex_box), (ex_box[0], ex_box[1]))
    _frame(ex_box, "表情/口型 EXPRESSIONS")

    # 色板
    pal_y = 1304
    draw.text((40, pal_y), "色彩系统 PALETTE", font=f_section, fill=theme["text"])
    pal = asset.get("color_palette") or {}
    hexes = [pal.get(k) for k in ("primary", "secondary", "accent")] + list(
        pal.get("extras") or []
    )
    hexes = [h for h in hexes if h and _is_hex(str(h))][:7]
    sw_w = (CARD_W - 80) // max(len(hexes), 1)
    for i, hx in enumerate(hexes):
        sx = 40 + i * sw_w
        r, g, b = (int(hx[j : j + 2], 16) for j in (1, 3, 5))
        draw.rectangle([sx, pal_y + 36, sx + sw_w - 8, pal_y + 80], fill=(r, g, b))
        draw.text((sx + 4, pal_y + 84), hx, font=f_small, fill=theme["text_dim"])

    # 服化道
    co_box = (40, 1416, CARD_W - 40, 1836)
    canvas.paste(_fit_cover(_panel("costume"), co_box), (co_box[0], co_box[1]))
    _frame(co_box, "服化道对版 COSTUME")

    # 档案:描述行 + 常驻结构化摘要,短描述也不留大片空白
    pr_y = 1852
    draw.text((40, pr_y), "身份档案 PROFILE", font=f_section, fill=theme["text"])
    pr_y += 36
    body = (profile.get("background") or "").strip()
    desc_lines = _wrap(body, f_body, CARD_W - 96)[:4] if body else []
    for line in desc_lines:
        draw.text((48, pr_y), line, font=f_body, fill=theme["text_dim"])
        pr_y += 27
    pr_y += 8
    cov = asset.get("coverage") or {}
    body_h = (asset.get("body") or {}).get("height_cm")
    expr = asset.get("expressions") or {}
    lock = asset.get("lock") or {}
    locked_panels = "/".join(lock.get("panels") or []) or "—"
    summary = [
        f"角色: {name[:12]}    身高: {body_h or '—'} cm    锁定面板: {locked_panels}",
        f"覆盖: 角度 {'/'.join(cov.get('angles') or []) or '—'} · 景别 {'/'.join(cov.get('framings') or []) or '—'} · 光照 {'/'.join(cov.get('lightings') or []) or '—'}",
        f"表情: {'/'.join(expr.get('emotions') or []) or '—'}    口型: {'/'.join(expr.get('mouth_series') or []) or '—'}",
    ]
    if not body:
        summary.append("背景档案待补:经 PUT character-asset 写入 profile.background")
    for s in summary[:5]:
        draw.text((48, pr_y), s, font=f_body, fill=theme["text_dim"])
        pr_y += 30

    # 页脚:协议 + 溯源
    draw.line([(40, 2160), (CARD_W - 40, 2160)], fill=theme["outline"], width=2)
    derived = asset.get("derived_from")
    prov_txt = f"base v{derived.get('base_version')} → v{asset.get('version')}" if derived else f"v{asset.get('version')}"
    draw.text(
        (40, 2172),
        f"ToIV Character Asset Protocol v{ASSET_SCHEMA_VERSION} · canonical reference · {prov_txt}",
        font=f_small,
        fill=theme["text_dim"],
    )
    updated = asset.get("updated_at") or ""
    draw.text((40, 2196), updated[:19], font=f_small, fill=theme["text_dim"])

    buf = BytesIO()
    canvas.save(buf, format="PNG")
    return buf.getvalue()


def save_card_png(data: bytes, *, character_id: str, style: str) -> str:
    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    name = f"{_CARD_MARK}{character_id[:8]}_{style}_{uuid.uuid4().hex[:12]}.png"
    (out_dir / name).write_bytes(data)
    return f"/api/studio/files/{name}"


def render_character_card(
    *, character_id: str, style: str, asset: dict[str, Any] | None = None
) -> tuple[str, bytes]:
    """高层入口:取最新面板 + 资产 → 渲染展示卡并落盘。"""
    if asset is None:
        asset = load_asset(character_id, style) or {}
    panels = latest_panel_paths(character_id, style)
    data = compose_asset_card(
        {k: p.read_bytes() for k, p in panels.items()}, asset
    )
    url = save_card_png(data, character_id=character_id, style=style)
    return url, data
