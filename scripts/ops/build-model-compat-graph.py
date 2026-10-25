#!/usr/bin/env python3
"""Build apps/canvas/web/src/generated/model-compat-graph.json (schemaVersion=1).

Inputs (read-only):
  - generated/lora-inventory.json (whitelist = available P-A/P-B × source A/B)
  - apps/api/app/services/lora_catalog.py (confidence A: engines/strength/trigger)
  - docs/ops/_card_cache_20261025/civ_*.json baseModels (confidence B)
  - docs/MODEL_SOURCES.json notes trainedWords / strength tip (confidence B, parseable only)
  - HF/Qwen package URL+basename/cluster → qwen-image compatible_with B (not C)
  - pathRoot / cluster / filename heuristics (confidence C)
  - civitai trainedWords/baseModels/strength-from-description: docs/ops/_card_cache_20261025/civ_*.json
    (token never written into JSON; strength_source=card|heuristic|catalog|model_sources)

Hard rules (拍板 2026-10-25):
  D2  H3 exclusive → only family:minimax-h3 + slot:video-primary
  D3  JSON ledger (this file)
  D4  Parallel to inventory; join by basename
  Never ingest quarantine / P-C / source C|D
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from itertools import combinations
from dataclasses import dataclass, field
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INVENTORY = ROOT / "apps/canvas/web/src/generated/lora-inventory.json"
CARD_CACHE = ROOT / "docs/ops/_card_cache_20261025"
OUT = ROOT / "apps/canvas/web/src/generated/model-compat-graph.json"
HUMAN = ROOT / "docs/ops/MODEL_COMPAT_GRAPH_20261025.md"

sys.path.insert(0, str(ROOT / "apps/api"))
from app.services.lora_catalog import CATALOG  # noqa: E402

# ── §3.1 family dictionary ──────────────────────────────────────────
FAMILY_META: dict[str, str] = {
    "qwen-image": "Qwen-Image",
    "flux.1-d": "Flux.1 D",
    "flux.2-klein": "Flux.2 Klein",
    "sd15": "SD 1.5",
    "sdxl": "SDXL 1.0",
    "illustrious": "Illustrious",
    "noobai": "NoobAI",
    "pony": "Pony",
    "wan2.2-i2v-a14b": "Wan 2.2 I2V-A14B",
    "wan2.2-t2v-a14b": "Wan 2.2 T2V-A14B",
    "wan2.2-ti2v": "Wan 2.2 TI2V",
    "ltx-2.3": "LTX 2.3",
    "ltx-legacy": "LTX legacy",
    "minimax-h3": "MiniMax H3",
    "hunyuan-video": "Hunyuan Video",
    "z-image-turbo": "ZImageTurbo",
    "krea-2": "Krea 2",
}

# Civitai / card baseModels string → family slug
BASEMODEL_ALIASES: list[tuple[re.Pattern[str], str]] = [
    (re.compile(r"qwen", re.I), "qwen-image"),
    (re.compile(r"flux\.?\s*2\s*klein|flux\.2", re.I), "flux.2-klein"),
    (re.compile(r"flux\.?\s*1\s*d|flux\.1\s*dev|flux1d|flux\.1", re.I), "flux.1-d"),
    (re.compile(r"\bsd\s*1\.?5\b|sd15", re.I), "sd15"),
    (re.compile(r"sdxl", re.I), "sdxl"),
    (re.compile(r"illustrious", re.I), "illustrious"),
    (re.compile(r"noobai|noob\s*ai", re.I), "noobai"),
    (re.compile(r"\bpony\b", re.I), "pony"),
    (re.compile(r"wan\s*video\s*2\.2\s*i2v|wan2\.2.*i2v|wan\s*2\.2\s*i2v", re.I), "wan2.2-i2v-a14b"),
    (re.compile(r"wan\s*video\s*2\.2\s*t2v|wan2\.2.*t2v|wan\s*2\.2\s*t2v", re.I), "wan2.2-t2v-a14b"),
    (re.compile(r"wan.*ti2v|ti2v", re.I), "wan2.2-ti2v"),
    (re.compile(r"\bwan\b", re.I), "wan2.2-i2v-a14b"),  # generic wan → I2V default + note
    (re.compile(r"ltxv?\s*2\.3|ltx\s*2\.3|ltxv2", re.I), "ltx-2.3"),
    (re.compile(r"\bltxv?\b", re.I), "ltx-legacy"),
    (re.compile(r"minimax\s*h3|mini.?max\s*h3|\bh3\b", re.I), "minimax-h3"),
    (re.compile(r"hunyuan", re.I), "hunyuan-video"),
    (re.compile(r"z[\s_-]?image[\s_-]?turbo|zimageturbo", re.I), "z-image-turbo"),
    (re.compile(r"krea", re.I), "krea-2"),
]

ENGINE_TO_FAMILY = {
    "wan": "wan2.2-i2v-a14b",
    "h3": "minimax-h3",
    "ltx": "ltx-2.3",
}
ENGINE_TO_SLOT = {
    "wan": "video-motion",
    "h3": "video-primary",
    "ltx": "video-motion",
}

SEED_BASE_MODELS: list[tuple[str, str, str]] = [
    # basename, family, label
    ("Qwen-Rapid-AIO-SFW-v23.safetensors", "qwen-image", "Qwen Rapid AIO SFW v23"),
    ("minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax-h3", "H3 FL2VA pruned int8"),
    ("minimax_h3_ref2va_pruned_int8_convrot.safetensors", "minimax-h3", "H3 REF2VA pruned int8"),
]

CIV_ID_RE = re.compile(r"civitai\.com/models/(\d+)", re.I)

CONF_RANK = {"A": 3, "B": 2, "C": 1, "D": 0}


@dataclass
class Edge:
    type: str
    frm: str
    to: str
    confidence: str | None = None
    evidence: str | None = None
    notes: str | None = None
    strength_range: dict | None = None
    mode: str | None = None
    scope: str | None = None
    extra: dict = field(default_factory=dict)

    def key(self) -> tuple:
        return (self.type, self.frm, self.to)

    def as_dict(self) -> dict:
        d: dict = {"type": self.type, "from": self.frm, "to": self.to}
        if self.confidence:
            d["confidence"] = self.confidence
        if self.evidence:
            d["evidence"] = self.evidence
        if self.notes:
            d["notes"] = self.notes
        if self.strength_range:
            d["strength_range"] = self.strength_range
        if self.mode:
            d["mode"] = self.mode
        if self.scope:
            d["scope"] = self.scope
        d.update(self.extra)
        return d


def normalize_family(raw: str) -> str | None:
    s = (raw or "").strip()
    if not s:
        return None
    if s.startswith("family:"):
        s = s[len("family:") :]
    if s in FAMILY_META:
        return s
    for pat, slug in BASEMODEL_ALIASES:
        if pat.search(s):
            return slug
    return None


def is_h3_exclusive(path_root: str, cluster: str, basename: str) -> bool:
    pr = (path_root or "").lower()
    c = (cluster or "").lower()
    name = (basename or "").lower()
    if "h3/loras" in pr:
        return True
    if c.startswith("catalog:h3") or c == "h3_family":
        return True
    if "minimax" in name and "h3" in name:
        return True
    # filename strongly H3 (avoid matching "high" etc.)
    if re.search(r"(^|[_-])h3([_-]|$)|minimaxh3|mini.?max.?h3", name):
        return True
    return False


def heuristic_families(basename: str, cluster: str, path_root: str) -> list[tuple[str, str]]:
    """Return [(family, notes)] from naming / cluster / path. Confidence always C."""
    name = basename.lower()
    c = cluster.lower()
    pr = path_root.lower()
    out: list[tuple[str, str]] = []

    if is_h3_exclusive(path_root, cluster, basename):
        return [("minimax-h3", "path/cluster/name H3 exclusive")]

    def add(fam: str, note: str) -> None:
        if fam not in {f for f, _ in out}:
            out.append((fam, note))

    if "flux" in c or "flux" in name:
        if "klein" in name or "flux2" in name.replace(".", "").replace("_", "").replace("-", ""):
            add("flux.2-klein", "filename/cluster flux2/klein")
        else:
            add("flux.1-d", "filename/cluster flux")
    if "qwen" in c or "qwen" in name:
        add("qwen-image", "filename/cluster qwen")
    if "wan" in c or "wan" in name or c.startswith("catalog:wan"):
        if "t2v" in name and "i2v" not in name:
            add("wan2.2-t2v-a14b", "filename wan t2v; side_uncertain")
        elif "ti2v" in name:
            add("wan2.2-ti2v", "filename wan ti2v; side_uncertain")
        else:
            add("wan2.2-i2v-a14b", "filename/cluster wan; side_uncertain" if "i2v" not in name else "filename/cluster wan i2v")
    if "ltx" in c or "ltx" in name or c.startswith("catalog:ltx") or "theme_path:ltx" in c:
        add("ltx-2.3", "filename/cluster ltx")
    if "pony" in name or "pony" in c:
        add("pony", "filename/cluster pony")
    if "sdxl" in name or "sdxl" in c:
        add("sdxl", "filename/cluster sdxl")
    if "illustrious" in name or "illustrious" in c:
        add("illustrious", "filename/cluster illustrious")
    if "sd15" in name or "sd1.5" in name or "sd_1.5" in name:
        add("sd15", "filename sd15")
    if "hunyuan" in name or "hunyuan" in c:
        add("hunyuan-video", "filename/cluster hunyuan")
    if "zimage" in name.replace("_", "").replace("-", "") or "z-image-turbo" in name:
        add("z-image-turbo", "filename z-image-turbo")
    if "longcat" in name or c == "longcat":
        # no dedicated family in P0 dict — leave family empty; slot only
        pass

    # path-only h3 already handled
    if "h3" in pr and "h3/loras" in pr:
        add("minimax-h3", "path h3/loras")

    return out


def heuristic_slots(path_root: str, cluster: str, basename: str, families: list[str]) -> list[str]:
    """Slot edges (C), with D2 H3 strict."""
    if is_h3_exclusive(path_root, cluster, basename) or "minimax-h3" in families:
        if is_h3_exclusive(path_root, cluster, basename):
            return ["video-primary"]
    # mirror gen-lora-inventory slots_for but D2-safe
    pr = path_root.lower()
    c = cluster.lower()
    slots: set[str] = set()
    if "h3" in pr or "h3" in c or c.startswith("catalog:h3"):
        slots.add("video-primary")
    if any(x in c for x in ("flux", "qwen_img", "slider", "identity")):
        slots.add("image")
    if any(
        x in c
        for x in (
            "wan",
            "ltx",
            "longcat",
            "camera",
            "theme_path",
            "accel",
            "nsfw",
            "edit",
            "catalog:wan",
            "catalog:ltx",
        )
    ):
        slots.add("video-motion")
    if "toiv/loras" in pr and "h3" not in pr:
        slots.add("image")
        slots.add("video-motion")
    if "windows" in pr:
        slots.add("image")
        if "h3" not in pr:
            slots.add("video-motion")
    if not slots:
        if "h3" in pr:
            slots.add("video-primary")
        else:
            slots.update(["image", "video-motion"])
    # D2: strip H3 from non-primary if somehow mixed; and strip image/motion from pure H3
    if is_h3_exclusive(path_root, cluster, basename):
        return ["video-primary"]
    # D2: non-H3 items should not claim video-primary unless family/cluster says H3
    if "minimax-h3" not in families and "h3" not in c and "h3" not in pr:
        slots.discard("video-primary")
    return sorted(slots)


def load_civ_basemodels() -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    if not CARD_CACHE.is_dir():
        return out
    for f in CARD_CACHE.glob("civ_*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        mid = str(d.get("id") or "")
        bm = d.get("baseModels") or []
        if mid and isinstance(bm, list) and bm:
            out[mid] = [str(x) for x in bm if x]
    return out


def load_civ_usage() -> dict[str, dict]:
    """civitai modelId → {triggers, baseModels, fileNames, strength?} from card cache."""
    out: dict[str, dict] = {}
    if not CARD_CACHE.is_dir():
        return out
    for f in CARD_CACHE.glob("civ_*.json"):
        try:
            d = json.loads(f.read_text(encoding="utf-8"))
        except Exception:
            continue
        mid = str(d.get("id") or "").strip()
        if not mid:
            continue
        triggers: list[str] = []
        for tw in d.get("trainedWords") or []:
            s = str(tw).strip()
            if s and len(s) <= 64 and s not in triggers:
                triggers.append(s)
        # also scan nested modelVersions if present (full cache copies)
        for v in d.get("modelVersions") or []:
            if not isinstance(v, dict):
                continue
            for tw in v.get("trainedWords") or []:
                s = str(tw).strip()
                if s and len(s) <= 64 and s not in triggers:
                    triggers.append(s)
        files = [str(x) for x in (d.get("fileNames") or []) if x]
        bms = [str(x) for x in (d.get("baseModels") or []) if x]
        strength = None
        raw_sr = d.get("recommendedStrength") or d.get("recommended_strength")
        if isinstance(raw_sr, dict) and raw_sr.get("default") is not None:
            strength = {
                "default": float(raw_sr["default"]),
                "min": float(raw_sr.get("min", max(0.1, float(raw_sr["default"]) * 0.6))),
                "max": float(raw_sr.get("max", max(1.0, float(raw_sr["default"])))),
                "source": str(raw_sr.get("source") or "card"),
            }
        elif isinstance(raw_sr, (int, float)):
            n = float(raw_sr)
            strength = {"default": n, "min": max(0.1, n * 0.6), "max": max(1.0, n), "source": "card"}
        if strength is None:
            strength = parse_strength_from_text(str(d.get("description") or ""))
        out[mid] = {
            "triggers": triggers[:24],
            "baseModels": bms,
            "fileNames": files,
            "strength": strength,
        }
    return out


MODEL_SOURCES = ROOT / "docs/MODEL_SOURCES.json"
TRAINED_WORDS_RE = re.compile(r"trainedWords\s*=\s*(\[[^\]]*\])")
STRENGTH_TIP_RE = re.compile(r"strength\s*tip\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)", re.I)


def _clamp_strength(n: float) -> float:
    return max(0.05, min(3.0, round(float(n), 2)))


_TEXT_STRENGTH_RES: list[re.Pattern[str]] = [
    re.compile(
        r"(?:recommended\s+)?(?:weight|strength)s?\s*(?:tip|:|=|\s)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:[-~–—]|to|~|～)\s*([0-9]+(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(r"(?:recommended\s+)?(?:weight|strength)s?\s*(?:tip)?\s*[:=]?\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    re.compile(
        r"set(?:\s+to)?\s+([0-9]+(?:\.[0-9]+)?)\s*(?:[-~–—]|to)\s*([0-9]+(?:\.[0-9]+)?)\s*(?:strength|weight)?",
        re.I,
    ),
    re.compile(
        r"(?:run|tested|use|works?)\s+(?:at\s+)?([0-9]+(?:\.[0-9]+)?)\s*(?:[-~–—]|to)\s*([0-9]+(?:\.[0-9]+)?)\s*strength",
        re.I,
    ),
    re.compile(r"(?:run|tested|use)\s+at\s+strength\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    re.compile(r"strength\s+([0-9]+(?:\.[0-9]+)?)\s*(?:[-~–—]|to)\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    re.compile(r"(?:try\s+at\s+)?weights?\s+([0-9]+(?:\.[0-9]+)?)\s*(?:[-~–—]|to)\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    re.compile(r"\bstrength\b\s*[-:]\s*([0-9]+(?:\.[0-9]+)?)", re.I),
    re.compile(
        r"(?:推荐)?(?:强度|权重)\s*[：:=]?\s*([0-9]+(?:\.[0-9]+)?)\s*[-~～到至]+\s*([0-9]+(?:\.[0-9]+)?)",
        re.I,
    ),
    re.compile(r"(?:推荐)?(?:强度|权重)\s*[：:=]?\s*([0-9]+(?:\.[0-9]+)?)", re.I),
]


def parse_strength_from_text(text: str) -> dict | None:
    """Parse recommended strength/weight tip from card description or notes."""
    if not text:
        return None
    t = re.sub(r"<[^>]+>", " ", text)
    t = re.sub(r"&[a-z]+;", " ", t, flags=re.I)
    hits: list[tuple[int, list[float]]] = []
    for pat in _TEXT_STRENGTH_RES:
        for m in pat.finditer(t):
            nums = [float(x) for x in m.groups() if x is not None]
            nums = [n for n in nums if 0.05 <= n <= 3.5]
            if nums:
                hits.append((m.start(), nums))
    if not hits:
        return None
    _, nums = hits[0]
    if len(nums) >= 2:
        lo, hi = min(nums[0], nums[1]), max(nums[0], nums[1])
        default = round(lo + (hi - lo) * 0.4, 2) if hi - lo >= 0.25 else round((lo + hi) / 2, 2)
        return {
            "default": _clamp_strength(default),
            "min": _clamp_strength(lo),
            "max": _clamp_strength(hi),
            "source": "card",
        }
    n = nums[0]
    return {
        "default": _clamp_strength(n),
        "min": _clamp_strength(max(0.1, n * 0.6)),
        "max": _clamp_strength(max(n, 1.0) if n <= 1.0 else min(3.0, n * 1.15)),
        "source": "card",
    }


def heuristic_strength(type_tag: str, cluster: str, basename: str, path_root: str) -> dict:
    """Community-default intervals by purpose/type. Always source=heuristic."""
    tag = (type_tag or "").strip()
    c = (cluster or "").lower()
    name = (basename or "").lower()
    pr = (path_root or "").lower()

    def pack(default: float, lo: float, hi: float) -> dict:
        return {
            "default": _clamp_strength(default),
            "min": _clamp_strength(lo),
            "max": _clamp_strength(hi),
            "source": "heuristic",
        }

    if is_h3_exclusive(path_root, cluster, basename) or tag == "H3" or c.startswith("catalog:h3") or c == "h3_family":
        return pack(0.8, 0.5, 1.0)
    if tag == "加速" or c.startswith("accel") or "lightning" in name or "distill" in name or "turbo" in name:
        return pack(1.0, 0.8, 1.0)
    if tag == "画风" or c in ("slider_style", "flux_family") or "style" in name or "slider" in name:
        return pack(0.7, 0.6, 0.85)
    if tag == "角色" or c == "identity" or "character" in name:
        return pack(0.8, 0.7, 0.95)
    if tag == "NSFW" or c == "nsfw_action" or "nsfw" in pr:
        return pack(0.7, 0.5, 0.9)
    if tag == "运镜" or c == "camera_pose" or "camera" in name or "pose" in name:
        return pack(0.7, 0.5, 0.9)
    if tag == "编辑" or c == "edit_control":
        return pack(0.75, 0.5, 1.0)
    if tag == "Wan" or c in ("wan_family", "catalog:wan") or "wan" in name:
        return pack(0.8, 0.6, 1.0)
    if tag == "LTX" or c == "ltx_family" or c.startswith("theme_path:ltx") or "ltx" in name:
        return pack(0.7, 0.4, 1.0)
    if tag == "题材" or c.startswith("theme_path:"):
        return pack(0.7, 0.55, 0.9)
    if tag == "出图" or "qwen" in name:
        return pack(0.75, 0.55, 1.0)
    return pack(0.6, 0.4, 0.9)


# Official / package publishers that declare Qwen-Image family (evidence B, not filename-C).
QWEN_HF_URL_RE = re.compile(
    r"(lightx2v/Qwen|fal/Qwen|DiffSynth-Studio/Qwen|Wuli-art/Qwen|thornmaze/qie|"
    r"lrzjason/(?:Qwen|Consistance|QwenEdit|QwenImage)|lovis93/next-scene-qwen|"
    r"Osrivers/Qwen|Comfy-Org/Qwen|starsfriday/Qwen|metapi74/qwen|djasiod/Qwen|"
    r"Qwen-Image|QwenImage|qwen-image-edit|qwen-outfit|qie-lora)",
    re.I,
)
QWEN_NAME_RE = re.compile(
    r"(?:^|[^a-z0-9])qwen[-_ ]?image|qwen[-_ ]?edit|qwenrebalance|wuli-qwen|"
    r"next-scene_lora|consistance_lora_qwenedit",
    re.I,
)


def load_ms_usage() -> dict[str, dict]:
    """basename → {triggers: list[str], strength: float|None} from MODEL_SOURCES notes."""
    out: dict[str, dict] = {}
    if not MODEL_SOURCES.is_file():
        return out
    try:
        payload = json.loads(MODEL_SOURCES.read_text(encoding="utf-8"))
    except Exception:
        return out
    for it in payload.get("items") or []:
        bn = str(it.get("basename") or "").strip()
        if not bn:
            continue
        notes = str(it.get("notes") or "")
        row = out.setdefault(bn, {"triggers": [], "strength": None})
        m = TRAINED_WORDS_RE.search(notes)
        if m:
            try:
                arr = json.loads(m.group(1))
            except Exception:
                arr = None
            if isinstance(arr, list):
                for tw in arr:
                    s = str(tw).strip()
                    # skip absurd long caption dumps
                    if s and len(s) <= 64 and s not in row["triggers"]:
                        row["triggers"].append(s)
        sm = STRENGTH_TIP_RE.search(notes)
        if sm and row["strength"] is None:
            try:
                row["strength"] = float(sm.group(1))
            except Exception:
                pass
        if row["strength"] is None:
            parsed = parse_strength_from_text(notes)
            if parsed:
                row["strength"] = float(parsed["default"])
    return out


def qwen_package_evidence(basename: str, source_url: str, cluster: str) -> str | None:
    """Return evidence string if this inventory item is a declared Qwen-Image package (B)."""
    name = basename or ""
    url = source_url or ""
    c = (cluster or "").lower()
    if c == "qwen_img":
        return "inventory.cluster=qwen_img"
    # avoid Wan Lightning false friends
    low = name.lower()
    if "wan" in low and "qwen" not in low:
        return None
    if QWEN_HF_URL_RE.search(url):
        return "hf.qwen-package-url"
    if QWEN_NAME_RE.search(name) and ("huggingface" in url.lower() or "hf-mirror" in url.lower() or "qwen" in low):
        return "hf.qwen-package-name"
    if QWEN_NAME_RE.search(name) and c.startswith("accel"):
        return "name+cluster.qwen-accel"
    return None


def main() -> None:
    inv = json.loads(INVENTORY.read_text(encoding="utf-8"))
    items = inv.get("items") or []
    if not items:
        raise SystemExit(f"empty inventory: {INVENTORY}")

    civ_bm = load_civ_basemodels()
    civ_usage = load_civ_usage()
    ms_usage = load_ms_usage()
    nodes: dict[str, dict] = {}
    edges_by_key: dict[tuple, Edge] = {}
    stats = Counter()

    def add_node(nid: str, ntype: str, **props) -> None:
        if nid not in nodes:
            nodes[nid] = {"id": nid, "type": ntype, **props}
            stats[f"node:{ntype}"] += 1

    def upsert_edge(edge: Edge) -> None:
        k = edge.key()
        prev = edges_by_key.get(k)
        if prev is None:
            edges_by_key[k] = edge
            stats[f"edge:{edge.type}"] += 1
            if edge.confidence:
                stats[f"conf:{edge.confidence}"] += 1
            return
        # keep higher confidence; merge notes
        if CONF_RANK.get(edge.confidence or "D", 0) > CONF_RANK.get(prev.confidence or "D", 0):
            if prev.notes and not edge.notes:
                edge.notes = prev.notes
            elif prev.notes and edge.notes and prev.notes not in edge.notes:
                edge.notes = f"{edge.notes}; {prev.notes}"
            if prev.strength_range and not edge.strength_range:
                edge.strength_range = prev.strength_range
            edges_by_key[k] = edge
            stats[f"conf:{edge.confidence}"] += 1
            stats[f"conf_replaced:{prev.confidence}"] += 1
        else:
            # same or lower: maybe fill strength/notes
            if edge.strength_range and not prev.strength_range:
                prev.strength_range = edge.strength_range
            if edge.notes and (not prev.notes or edge.notes not in (prev.notes or "")):
                prev.notes = f"{prev.notes}; {edge.notes}" if prev.notes else edge.notes

    # families
    for slug, label in FAMILY_META.items():
        add_node(f"family:{slug}", "BaseFamily", label=label)

    # slots
    for slot in ("image", "video-primary", "video-motion"):
        add_node(f"slot:{slot}", "EngineSlot", label=slot)

    # seed base models
    for basename, fam, label in SEED_BASE_MODELS:
        bid = f"base:{basename}"
        add_node(bid, "BaseModel", label=label, basename=basename)
        upsert_edge(Edge("instance_of", bid, f"family:{fam}", confidence="A", evidence="product-default"))

    # P1b light: extra BaseModel instances from known product/local defaults + inventory path hints
    EXTRA_BASES: list[tuple[str, str, str]] = [
        ("Qwen-Rapid-AIO-SFW-v23.safetensors", "qwen-image", "Qwen Rapid AIO SFW v23"),
        ("minimax_h3_fl2va_pruned_int8_convrot.safetensors", "minimax-h3", "H3 FL2VA pruned int8"),
        ("minimax_h3_ref2va_pruned_int8_convrot.safetensors", "minimax-h3", "H3 REF2VA pruned int8"),
    ]
    # discover wan / flux basenames mentioned in MODEL_SOURCES type=checkpoint lightly
    try:
        ms_payload = json.loads(MODEL_SOURCES.read_text(encoding="utf-8")) if MODEL_SOURCES.is_file() else {}
        for it in ms_payload.get("items") or []:
            bn = str(it.get("basename") or "").strip()
            typ = str(it.get("type") or it.get("kind") or "").lower()
            notes = str(it.get("notes") or "")
            url0 = str(it.get("url") or it.get("sourceUrl") or "")
            if not bn.endswith(".safetensors"):
                continue
            if "checkpoint" not in typ and "base" not in typ and "unet" not in typ and "diffusion" not in notes.lower():
                # also accept known family keywords in basename
                low = bn.lower()
                if not any(k in low for k in ("qwen", "wan2.2", "wan22", "flux", "minimax_h3", "sdxl", "ltx")):
                    continue
            fam = normalize_family(bn) or normalize_family(notes) or normalize_family(url0)
            if not fam:
                continue
            if any(bn == x[0] for x in EXTRA_BASES):
                continue
            EXTRA_BASES.append((bn, fam, bn.rsplit(".", 1)[0][:64]))
            if len(EXTRA_BASES) >= 40:
                break
    except Exception:
        pass

    for basename, fam, label in EXTRA_BASES:
        bid = f"base:{basename}"
        if bid in nodes:
            continue
        add_node(bid, "BaseModel", label=label, basename=basename)
        upsert_edge(Edge("instance_of", bid, f"family:{fam}", confidence="B", evidence="p1b.local-or-sources"))
        stats["p1b_base"] += 1

    catalog_by_name = {c.name: c for c in CATALOG}

    for it in items:
        basename = it["id"]
        path_root = it.get("pathRoot") or ""
        cluster = it.get("cluster") or ""
        lid = f"lora:{basename}"
        add_node(lid, "LoRA", label=it.get("label") or basename)

        # purpose projection
        if cluster:
            pid = f"purpose:{cluster}"
            add_node(pid, "PurposeTag", label=cluster)
            upsert_edge(
                Edge(
                    "purpose",
                    lid,
                    pid,
                    confidence=it.get("purposeGrade") or "B",
                    evidence="inventory",
                    extra={"grade": it.get("purposeGrade")},
                )
            )

        # sourced_from
        url = (it.get("sourceUrl") or "").strip()
        if url:
            m = CIV_ID_RE.search(url)
            if m:
                sid = f"source:civitai:{m.group(1)}"
                add_node(sid, "SourceCard", url=url)
                upsert_edge(Edge("sourced_from", lid, sid, evidence="inventory.sourceUrl"))
            elif "huggingface.co" in url:
                # crude repo extract
                parts = url.rstrip("/").split("huggingface.co/")[-1].split("/")
                repo = "/".join(parts[:2]) if len(parts) >= 2 else parts[0]
                sid = f"source:hf:{repo}"
                add_node(sid, "SourceCard", url=url)
                upsert_edge(Edge("sourced_from", lid, sid, evidence="inventory.sourceUrl"))

        h3_ex = is_h3_exclusive(path_root, cluster, basename)
        families_from_ab: set[str] = set()

        # ── A: catalog ──
        card = catalog_by_name.get(basename)
        if card:
            for eng in card.engines:
                fam = ENGINE_TO_FAMILY.get(eng)
                slot = ENGINE_TO_SLOT.get(eng)
                if fam:
                    if h3_ex and fam != "minimax-h3":
                        continue
                    if not h3_ex and fam == "minimax-h3" and eng != "h3":
                        pass
                    families_from_ab.add(fam)
                    sr = {
                        "default": float(card.default_strength),
                        "min": 0.4,
                        "max": 1.0,
                        "source": "catalog",
                    }
                    upsert_edge(
                        Edge(
                            "compatible_with",
                            lid,
                            f"family:{fam}",
                            confidence="A",
                            evidence=f"lora_catalog.engines={eng}",
                            strength_range=sr,
                            notes=f"role={card.role}" + (f"; wan_side={card.wan_side}" if card.wan_side else ""),
                        )
                    )
                if slot:
                    if h3_ex and slot != "video-primary":
                        slot = "video-primary"
                    upsert_edge(
                        Edge(
                            "used_in_slot",
                            lid,
                            f"slot:{slot}",
                            confidence="A",
                            evidence="lora_catalog",
                        )
                    )
            # triggers
            for tw in card.trigger_words:
                tid = f"trigger:{tw.lower()}"
                add_node(tid, "TriggerPhrase", text=tw)
                upsert_edge(
                    Edge(
                        "requires_trigger",
                        lid,
                        tid,
                        mode=card.trigger_mode or "all",
                        evidence="lora_catalog",
                    )
                )
            # recommended_strength as edge attribute already on compatible_with;
            # also emit standalone for query convenience
            upsert_edge(
                Edge(
                    "recommended_strength",
                    lid,
                    lid,  # self-literal; consumers read strength_range
                    evidence="lora_catalog",
                    strength_range={
                        "default": float(card.default_strength),
                        "min": 0.4,
                        "max": 1.0,
                        "source": "catalog",
                    },
                )
            )
            # conflicts → purpose tags
            for role in card.conflicts:
                pid = f"purpose:{role}"
                add_node(pid, "PurposeTag", label=role)
                upsert_edge(
                    Edge(
                        "conflicts_with",
                        lid,
                        pid,
                        scope="role",
                        notes=f"同 role={role} 至多一张",
                        evidence="lora_catalog.conflicts",
                    )
                )
            stats["catalog_hit"] += 1

        # ── B: civ baseModels ──
        if url:
            m = CIV_ID_RE.search(url)
            if m:
                for raw_bm in civ_bm.get(m.group(1), []):
                    fam = normalize_family(raw_bm)
                    if not fam:
                        stats["civ_bm_unmapped"] += 1
                        continue
                    if h3_ex and fam != "minimax-h3":
                        # D2: H3 exclusive ignore other families from multi-base cards
                        stats["civ_bm_skipped_h3_strict"] += 1
                        continue
                    if not h3_ex and fam == "minimax-h3" and "h3" not in cluster.lower() and "h3" not in path_root.lower():
                        # multi-base card listing H3 among many — keep as B but OK
                        pass
                    families_from_ab.add(fam)
                    upsert_edge(
                        Edge(
                            "compatible_with",
                            lid,
                            f"family:{fam}",
                            confidence="B",
                            evidence="civitai.baseModels",
                            notes=f"卡页声明 {raw_bm}",
                        )
                    )
                    stats["civ_bm_edge"] += 1

        # ── B+: Qwen HF / package declaration (upgrade C→B without forging A) ──
        qwen_ev = qwen_package_evidence(basename, url, cluster)
        if qwen_ev and not h3_ex:
            families_from_ab.add("qwen-image")
            upsert_edge(
                Edge(
                    "compatible_with",
                    lid,
                    "family:qwen-image",
                    confidence="B",
                    evidence=qwen_ev,
                    notes="HF/包名/cluster 声明 Qwen-Image 族",
                )
            )
            upsert_edge(
                Edge(
                    "used_in_slot",
                    lid,
                    "slot:image",
                    confidence="B",
                    evidence=qwen_ev,
                )
            )
            stats["qwen_package_b"] += 1

        # ── B: MODEL_SOURCES trainedWords / strength tip (parseable only) ──
        usage = ms_usage.get(basename) or {}
        for tw in usage.get("triggers") or []:
            tid = f"trigger:{tw.lower()}"
            add_node(tid, "TriggerPhrase", text=tw)
            # do not overwrite catalog mode if already present
            k = ("requires_trigger", lid, tid)
            if k not in edges_by_key:
                upsert_edge(
                    Edge(
                        "requires_trigger",
                        lid,
                        tid,
                        mode="all",
                        evidence="MODEL_SOURCES.trainedWords",
                    )
                )
                stats["ms_trigger"] += 1

        # ── B: civitai trainedWords (card cache, API-enriched 2026-10-26) ──
        civ_mid = None
        if url:
            mm = CIV_ID_RE.search(url)
            if mm:
                civ_mid = mm.group(1)
        civ_u = civ_usage.get(civ_mid or "") or {}
        for tw in civ_u.get("triggers") or []:
            tid = f"trigger:{tw.lower()}"
            add_node(tid, "TriggerPhrase", text=tw)
            k = ("requires_trigger", lid, tid)
            if k not in edges_by_key:
                upsert_edge(
                    Edge(
                        "requires_trigger",
                        lid,
                        tid,
                        mode="all",
                        evidence="civitai.trainedWords",
                    )
                )
                stats["civ_trigger"] += 1
        if usage.get("strength") is not None and ("recommended_strength", lid, lid) not in edges_by_key:
            sr = {
                "default": float(usage["strength"]),
                "min": 0.4,
                "max": max(2.0, float(usage["strength"])),
                "source": "model_sources",
            }
            upsert_edge(
                Edge(
                    "recommended_strength",
                    lid,
                    lid,
                    evidence="MODEL_SOURCES.strength_tip",
                    strength_range=sr,
                )
            )
            for fam in list(families_from_ab) or []:
                k = ("compatible_with", lid, f"family:{fam}")
                prev = edges_by_key.get(k)
                if prev and not prev.strength_range:
                    prev.strength_range = sr
            stats["ms_strength"] += 1

        # ── B: civitai card description / recommendedStrength ──
        civ_sr = civ_u.get("strength") if isinstance(civ_u, dict) else None
        if isinstance(civ_sr, dict) and civ_sr.get("default") is not None:
            if ("recommended_strength", lid, lid) not in edges_by_key:
                sr = {
                    "default": float(civ_sr["default"]),
                    "min": float(civ_sr.get("min", 0.4)),
                    "max": float(civ_sr.get("max", max(1.0, float(civ_sr["default"])))),
                    "source": str(civ_sr.get("source") or "card"),
                }
                upsert_edge(
                    Edge(
                        "recommended_strength",
                        lid,
                        lid,
                        evidence="civitai.card_description",
                        strength_range=sr,
                    )
                )
                for fam in list(families_from_ab) or []:
                    k = ("compatible_with", lid, f"family:{fam}")
                    prev = edges_by_key.get(k)
                    if prev and not prev.strength_range:
                        prev.strength_range = sr
                stats["civ_strength"] += 1

        # ── C: heuristic strength fill (always last; mark source=heuristic) ──
        if ("recommended_strength", lid, lid) not in edges_by_key:
            sr = heuristic_strength(
                str(it.get("typeTag") or ""),
                cluster,
                basename,
                path_root,
            )
            upsert_edge(
                Edge(
                    "recommended_strength",
                    lid,
                    lid,
                    evidence="heuristic.typeTag/cluster",
                    strength_range=sr,
                )
            )
            for fam in list(families_from_ab) or []:
                k = ("compatible_with", lid, f"family:{fam}")
                prev = edges_by_key.get(k)
                if prev and not prev.strength_range:
                    prev.strength_range = sr
            stats["heuristic_strength"] += 1

        # ── C: path / cluster / filename ──
        heur = heuristic_families(basename, cluster, path_root)
        fam_list = [f for f, _ in heur]
        if h3_ex:
            fam_list = ["minimax-h3"]
            heur = [("minimax-h3", "H3 exclusive")]
        for fam, note in heur:
            # only add C if no A/B already for this family
            k = ("compatible_with", lid, f"family:{fam}")
            existing = edges_by_key.get(k)
            if existing and CONF_RANK.get(existing.confidence or "D", 0) >= CONF_RANK["B"]:
                continue
            upsert_edge(
                Edge(
                    "compatible_with",
                    lid,
                    f"family:{fam}",
                    confidence="C",
                    evidence="path/cluster/filename",
                    notes=note,
                )
            )

        # used_in_slot C (fill gaps)
        slot_list = heuristic_slots(path_root, cluster, basename, fam_list or list(families_from_ab))
        for slot in slot_list:
            k = ("used_in_slot", lid, f"slot:{slot}")
            existing = edges_by_key.get(k)
            if existing and CONF_RANK.get(existing.confidence or "D", 0) >= CONF_RANK["A"]:
                continue
            if existing and existing.confidence == "A":
                continue
            upsert_edge(
                Edge(
                    "used_in_slot",
                    lid,
                    f"slot:{slot}",
                    confidence="C",
                    evidence="slots_for_heuristic",
                )
            )

        stats["lora"] += 1

    # ── P2: file-level conflicts_with + substitutes + catalog/product A ──
    # 务实可证伪：仅来自 lora_catalog；不伪造雨夜实测。
    catalog_in_inventory = {
        c.name: c for c in CATALOG if f"lora:{c.name}" in nodes
    }
    # Group by (engines frozenset frozen as sorted tuple, mutex role)
    role_groups: dict[tuple, list[str]] = {}
    for name, card in catalog_in_inventory.items():
        eng_key = tuple(sorted(card.engines))
        for role in card.conflicts:
            role_groups.setdefault((eng_key, role), []).append(name)

    for (eng_key, role), names in role_groups.items():
        names = sorted(set(names))
        for a, b in combinations(names, 2):
            for frm, to in ((a, b), (b, a)):
                upsert_edge(
                    Edge(
                        "conflicts_with",
                        f"lora:{frm}",
                        f"lora:{to}",
                        scope="file",
                        evidence="lora_catalog.role_mutex",
                        notes=f"同 engines={'+'.join(eng_key)} 同 conflicts role={role} 互斥",
                    )
                )
                stats["p2_conflict_file"] += 1

    # substitutes: same engines + same role (bidirectional)
    sub_groups: dict[tuple, list[str]] = {}
    for name, card in catalog_in_inventory.items():
        eng_key = tuple(sorted(card.engines))
        sub_groups.setdefault((eng_key, card.role), []).append(name)
    for (eng_key, role), names in sub_groups.items():
        names = sorted(set(names))
        if len(names) < 2:
            continue
        for a, b in combinations(names, 2):
            for frm, to in ((a, b), (b, a)):
                upsert_edge(
                    Edge(
                        "substitutes",
                        f"lora:{frm}",
                        f"lora:{to}",
                        evidence="lora_catalog.same_role",
                        notes=f"同 engines={'+'.join(eng_key)} 同 role={role}",
                    )
                )
                stats["p2_substitutes"] += 1

    # confidence A: catalog-named compatible_with already A; upgrade any B/C on those
    for name, card in catalog_in_inventory.items():
        lid = f"lora:{name}"
        for eng in card.engines:
            fam = ENGINE_TO_FAMILY.get(eng)
            if not fam:
                continue
            k = ("compatible_with", lid, f"family:{fam}")
            prev = edges_by_key.get(k)
            if prev is None:
                upsert_edge(
                    Edge(
                        "compatible_with",
                        lid,
                        f"family:{fam}",
                        confidence="A",
                        evidence="lora_catalog",
                        notes=f"P2 product/catalog default; role={card.role}",
                        strength_range={
                            "default": float(card.default_strength),
                            "min": 0.4,
                            "max": 1.0,
                            "source": "catalog",
                        },
                    )
                )
                stats["p2_compat_a_new"] += 1
            elif CONF_RANK.get(prev.confidence or "D", 0) < CONF_RANK["A"]:
                upsert_edge(
                    Edge(
                        "compatible_with",
                        lid,
                        f"family:{fam}",
                        confidence="A",
                        evidence="lora_catalog",
                        notes=(prev.notes or "") + "; P2 upgrade→A",
                        strength_range=prev.strength_range
                        or {
                            "default": float(card.default_strength),
                            "min": 0.4,
                            "max": 1.0,
                            "source": "catalog",
                        },
                    )
                )
                stats["p2_compat_a_upgrade"] += 1

    # product-default bases ↔ catalog family: ensure used_in_slot A for matching slots
    for basename, fam, _label in SEED_BASE_MODELS:
        for name, card in catalog_in_inventory.items():
            for eng in card.engines:
                if ENGINE_TO_FAMILY.get(eng) != fam:
                    continue
                lid = f"lora:{name}"
                slot = ENGINE_TO_SLOT.get(eng)
                k = ("compatible_with", lid, f"family:{fam}")
                if k not in edges_by_key:
                    upsert_edge(
                        Edge(
                            "compatible_with",
                            lid,
                            f"family:{fam}",
                            confidence="A",
                            evidence="product-default+lora_catalog",
                            notes=f"seed base {basename}",
                        )
                    )
                    stats["p2_seed_compat_a"] += 1
                if slot:
                    sk = ("used_in_slot", lid, f"slot:{slot}")
                    prev = edges_by_key.get(sk)
                    if prev is None or CONF_RANK.get(prev.confidence or "D", 0) < CONF_RANK["A"]:
                        upsert_edge(
                            Edge(
                                "used_in_slot",
                                lid,
                                f"slot:{slot}",
                                confidence="A",
                                evidence="product-default+lora_catalog",
                            )
                        )
                        stats["p2_seed_slot_a"] += 1

    payload = {
        "generatedAt": "2026-10-26",
        "timezone": "Asia/Shanghai",
        "schemaVersion": 1,
        "joinKey": "basename",
        "inventoryRef": "apps/canvas/web/src/generated/lora-inventory.json",
        "decisions": {
            "D1": "gray-force-heuristic",
            "D2": "h3-strict-family",
            "D3": "json-ledger",
            "D4": "parallel-join",
            "ratifiedAt": "2026-10-25",
        },
        "phase": "P2",
        "phaseNotes": "P2: file-level conflicts_with (lora_catalog.role_mutex) + substitutes (same_role) + catalog/product A; no LoRA live-test backfill (雨夜未测 LoRA 组合); token never in ledger",
        "stats": dict(stats),
        "nodes": list(nodes.values()),
        "edges": [e.as_dict() for e in edges_by_key.values()],
    }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")

    # human summary
    by_fam: dict[str, Counter] = {}
    for e in edges_by_key.values():
        if e.type != "compatible_with":
            continue
        fam = e.to.replace("family:", "")
        by_fam.setdefault(fam, Counter())[e.confidence or "?"] += 1

    lines = [
        "# 模型兼容图谱摘要（P2）",
        "",
        "> 日期：2026-10-26（Asia/Shanghai）  ",
        "> 生成：`scripts/ops/build-model-compat-graph.py` → `generated/model-compat-graph.json`  ",
        "> 拍板：D1 灰显可强制 · D2 H3 严格分族 · D3 JSON · D4 并列 join",
        "> P2：文件级 conflicts_with + substitutes + catalog/产品 A；无 LoRA 实测回写；P1.5b 强度/trigger 保留",
        "",
        f"- inventory 白名单 LoRA 节点：**{stats['lora']}**",
        f"- 节点合计：**{len(nodes)}** · 边合计：**{len(edges_by_key)}**",
        f"- compatible_with 按置信度：A={stats.get('conf:A', 0)} B={stats.get('conf:B', 0)} C={stats.get('conf:C', 0)}（含非 compatible 边的 conf 计数，见 stats）",
        f"- catalog 命中：{stats.get('catalog_hit', 0)} · civ baseModels 边：{stats.get('civ_bm_edge', 0)} · Qwen 包 B：{stats.get('qwen_package_b', 0)}",
        f"- requires_trigger：ms={stats.get('ms_trigger', 0)} civ={stats.get('civ_trigger', 0)} · strength catalog/ms/civ/heuristic={stats.get('catalog_hit', 0)}/{stats.get('ms_strength', 0)}/{stats.get('civ_strength', 0)}/{stats.get('heuristic_strength', 0)} · p1b_base={stats.get('p1b_base', 0)}",
        "",
        "## 按 BaseFamily 的兼容边（confidence 计数）",
        "",
        "| family | A | B | C |",
        "|--------|---|---|---|",
    ]
    for fam in sorted(by_fam.keys()):
        c = by_fam[fam]
        lines.append(f"| `{fam}` | {c.get('A', 0)} | {c.get('B', 0)} | {c.get('C', 0)} |")
    lines += [
        "",
        "## 种子 BaseModel",
        "",
    ]
    for basename, fam, label in SEED_BASE_MODELS:
        lines.append(f"- `{basename}` → `family:{fam}`（{label}）")
    lines += [
        "",
        "## 使用",
        "",
        "- 前端：`src/lib/model-compat.ts` + 设置页 LoRA 管理按当前底模族过滤",
        "- Agent：`queryCompat({ baseId|family, slot, minConfidence })`",
        "- 再生：`python3 scripts/ops/build-model-compat-graph.py`",
        "",
    ]
    HUMAN.parent.mkdir(parents=True, exist_ok=True)
    HUMAN.write_text("\n".join(lines), encoding="utf-8")

    # precise compatible_with conf counts
    cw = Counter()
    for e in edges_by_key.values():
        if e.type == "compatible_with":
            cw[e.confidence or "?"] += 1
    print(f"wrote {OUT} bytes={OUT.stat().st_size}")
    print(f"nodes={len(nodes)} edges={len(edges_by_key)} lora={stats['lora']}")
    print(f"compatible_with conf {dict(cw)}")
    print(f"catalog_hit={stats.get('catalog_hit')} civ_bm_edge={stats.get('civ_bm_edge')} qwen_package_b={stats.get('qwen_package_b')}")
    print(f"ms_trigger={stats.get('ms_trigger')} civ_trigger={stats.get('civ_trigger')} civ_strength={stats.get('civ_strength')} heuristic_strength={stats.get('heuristic_strength')} ms_strength={stats.get('ms_strength')} p1b_base={stats.get('p1b_base')}")
    trig = sum(1 for e in edges_by_key.values() if e.type == "requires_trigger")
    stren = sum(1 for e in edges_by_key.values() if e.type == "recommended_strength")
    qwen_ab = sum(
        1
        for e in edges_by_key.values()
        if e.type == "compatible_with"
        and e.to == "family:qwen-image"
        and (e.confidence or "") in ("A", "B")
    )
    conf_file = sum(1 for e in edges_by_key.values() if e.type == "conflicts_with" and e.scope == "file")
    conf_role = sum(1 for e in edges_by_key.values() if e.type == "conflicts_with" and e.scope == "role")
    subs = sum(1 for e in edges_by_key.values() if e.type == "substitutes")
    print(f"requires_trigger={trig} recommended_strength={stren} qwen-image A/B={qwen_ab}")
    print(f"P2 conflicts_with file={conf_file} role={conf_role} substitutes={subs}")
    print(f"p2_stats conflict_file={stats.get('p2_conflict_file')} substitutes={stats.get('p2_substitutes')} a_up={stats.get('p2_compat_a_upgrade')} a_new={stats.get('p2_compat_a_new')}")
    print(f"human {HUMAN}")


if __name__ == "__main__":
    main()
