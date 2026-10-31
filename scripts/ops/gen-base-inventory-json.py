#!/usr/bin/env python3
"""Generate vendor/canvas/web/src/generated/base-inventory.json (P1b).

Prefer live NAS scan of checkpoints/ + diffusion_models/ (+ h3/ non-lora weights).
If mount missing, seed from docs/NAS_MODEL_PICKER.json and mark live=false.

Each item carries BaseFamily when resolvable; unknown → family=null (UI must not fake).
"""
from __future__ import annotations

import json
import re
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "vendor/canvas/web/src/generated/base-inventory.json"
PICKER = ROOT / "docs/NAS_MODEL_PICKER.json"
TZ = ZoneInfo("Asia/Shanghai")

WEIGHT_EXT = (".safetensors", ".ckpt", ".pt", ".pth", ".gguf")

NAS_CANDIDATES = [
    Path("/home/merlin/nas_mount/toiv/comfyui-models"),
    Path.home() / "nas_mount/toiv/comfyui-models",
    Path("/mnt/toiv-nas/toiv/comfyui-models"),
]

# Keep in sync with scripts/ops/build-model-compat-graph.py BASEMODEL_ALIASES / FAMILY_META
FAMILY_LABEL = {
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

BASEMODEL_ALIASES: list[tuple[re.Pattern[str], str | None]] = [
    (re.compile(r"qwen", re.I), "qwen-image"),
    (re.compile(r"flux\.?\s*2\s*klein|flux\.2", re.I), "flux.2-klein"),
    (re.compile(r"flux\.?\s*1\s*d|flux\.1\s*dev|flux1d|flux\.1|\bflux\b", re.I), "flux.1-d"),
    (re.compile(r"\bsd\s*1\.?5\b|sd15|dreamshaper|realistic.?vision|urpm|uber.?realistic", re.I), "sd15"),
    (re.compile(r"sdxl|juggernaut", re.I), "sdxl"),
    (re.compile(r"illustrious", re.I), "illustrious"),
    (re.compile(r"noobai|noob\s*ai", re.I), "noobai"),
    (re.compile(r"\bpony\b", re.I), "pony"),
    (re.compile(r"wan\s*video\s*2\.2\s*i2v|wan2\.2.*i2v|wan\s*2\.2\s*i2v", re.I), "wan2.2-i2v-a14b"),
    (re.compile(r"wan\s*video\s*2\.2\s*t2v|wan2\.2.*t2v|wan\s*2\.2\s*t2v", re.I), "wan2.2-t2v-a14b"),
    (re.compile(r"wan.*ti2v|ti2v", re.I), "wan2.2-ti2v"),
    (re.compile(r"\bwan\b", re.I), "wan2.2-i2v-a14b"),
    (re.compile(r"ltxv?\s*2\.3|ltx\s*2\.3|ltxv2", re.I), "ltx-2.3"),
    (re.compile(r"\bltxv?\b", re.I), "ltx-legacy"),
    (re.compile(r"minimax\s*h3|mini.?max\s*h3|(?:^|[^a-z])h3(?:[^a-z]|$)", re.I), "minimax-h3"),
    (re.compile(r"hunyuan", re.I), "hunyuan-video"),
    (re.compile(r"z[\s_-]?image[\s_-]?turbo|zimageturbo|z[\s_-]?image", re.I), "z-image-turbo"),
    (re.compile(r"krea", re.I), "krea-2"),
]


def family_of_basename(basename: str) -> str | None:
    name = basename or ""
    for pat, slug in BASEMODEL_ALIASES:
        if pat.search(name):
            return slug
    return None


def find_nas_root() -> Path | None:
    for p in NAS_CANDIDATES:
        if (p / "checkpoints").is_dir() or (p / "diffusion_models").is_dir():
            return p
    return None


def is_weight(name: str) -> bool:
    low = name.lower()
    return any(low.endswith(ext) for ext in WEIGHT_EXT)


def is_lora_path(rel: str, basename: str) -> bool:
    r = rel.replace("\\", "/").lower()
    b = basename.lower()
    if "/loras/" in f"/{r}/" or r.startswith("loras/") or "/loras" == r:
        return True
    if "lora" in b and ("lora" in r.split("/")[-2] if "/" in r else False):
        return True
    return False


def slots_for(*, section: str, rel: str, purpose: str, family: str | None) -> list[str]:
    r = rel.replace("\\", "/").lower()
    if section == "h3" or r.startswith("h3/") or family == "minimax-h3":
        return ["video-primary"]
    slots: list[str] = []
    if "出图" in purpose or r.startswith("checkpoints/"):
        slots.append("image")
    if "出视频" in purpose or family and family.startswith(("wan", "ltx", "hunyuan")):
        if "image" not in slots or "出视频" in purpose:
            if "video-motion" not in slots:
                slots.append("video-motion")
    if not slots:
        if r.startswith("checkpoints/"):
            slots = ["image"]
        else:
            slots = ["image", "video-motion"]
    # D2: H3 never on image/motion
    if family == "minimax-h3":
        return ["video-primary"]
    return slots


def scan_live(root: Path) -> list[dict]:
    items: list[dict] = []
    seen: set[str] = set()

    def add(rel: str, section: str, purpose: str = "") -> None:
        rel = rel.replace("\\", "/").lstrip("./")
        bn = Path(rel).name
        if not is_weight(bn) or is_lora_path(rel, bn):
            return
        key = bn.lower()
        if key in seen:
            return
        seen.add(key)
        fam = family_of_basename(bn)
        top = rel.split("/", 1)[0] if "/" in rel else ""
        items.append(
            {
                "id": bn,
                "basename": bn,
                "label": Path(bn).stem,
                "relPath": rel,
                "pathRoot": f"toiv/{top}" if top else "toiv",
                "family": fam,
                "familyLabel": FAMILY_LABEL.get(fam or "", None),
                "familyResolved": fam is not None,
                "slots": slots_for(section=section, rel=rel, purpose=purpose, family=fam),
                "bytes": None,
                "purposeZh": purpose or None,
            }
        )

    for sub in ("checkpoints", "diffusion_models"):
        d = root / sub
        if not d.is_dir():
            continue
        for p in sorted(d.rglob("*")):
            if p.is_file() and is_weight(p.name):
                add(str(p.relative_to(root)), "main")

    h3 = root / "h3"
    if h3.is_dir():
        for p in sorted(h3.rglob("*")):
            if not p.is_file() or not is_weight(p.name):
                continue
            rel = str(p.relative_to(root))
            if is_lora_path(rel, p.name):
                continue
            # skip obvious LoRA filenames under h3
            if "lora" in p.name.lower():
                continue
            add(rel, "h3", purpose="H3")
    return items


def seed_from_picker() -> list[dict]:
    data = json.loads(PICKER.read_text(encoding="utf-8"))
    items: list[dict] = []
    seen: set[str] = set()

    def consume(entries: list, section: str) -> None:
        for e in entries:
            if not isinstance(e, dict):
                continue
            rel = str(e.get("rel_path") or "").replace("\\", "/")
            bn = str(e.get("basename") or Path(rel).name)
            if not bn or not is_weight(bn):
                continue
            top = rel.split("/", 1)[0] if rel else ""
            if section == "main" and top not in ("checkpoints", "diffusion_models"):
                continue
            if section == "h3":
                if is_lora_path(rel, bn) or "lora" in bn.lower():
                    continue
            key = bn.lower()
            if key in seen:
                continue
            seen.add(key)
            purpose = str(e.get("用途") or "")
            fam = family_of_basename(bn)
            items.append(
                {
                    "id": bn,
                    "basename": bn,
                    "label": Path(bn).stem,
                    "relPath": rel,
                    "pathRoot": f"toiv/{top}" if top else ("toiv/h3" if section == "h3" else "toiv"),
                    "family": fam,
                    "familyLabel": FAMILY_LABEL.get(fam or "", None),
                    "familyResolved": fam is not None,
                    "slots": slots_for(section=section, rel=rel, purpose=purpose, family=fam),
                    "bytes": e.get("bytes"),
                    "purposeZh": purpose or None,
                }
            )

    consume(data.get("main") or [], "main")
    consume(data.get("h3") or [], "h3")
    return items


def main() -> int:
    nas = find_nas_root()
    if nas is not None:
        items = scan_live(nas)
        source = {"kind": "nas-live", "root": str(nas), "live": True}
        note = "实时 NAS 扫描"
    else:
        if not PICKER.is_file():
            print("ERR: no NAS mount and missing NAS_MODEL_PICKER.json", file=sys.stderr)
            return 1
        items = seed_from_picker()
        picker_meta = json.loads(PICKER.read_text(encoding="utf-8"))
        source = {
            "kind": "nas-picker-seed",
            "live": False,
            "picker": str(PICKER.relative_to(ROOT)),
            "pickerUpdatedAt": picker_meta.get("updated_at"),
            "pickerFrom": picker_meta.get("updated_from"),
        }
        note = "非实时 NAS（MateBook 无挂载；种子 docs/NAS_MODEL_PICKER.json）"

    items.sort(key=lambda x: (0 if x["familyResolved"] else 1, x["basename"].lower()))
    fam_counts = Counter(i["family"] or "unknown" for i in items)
    slot_counts: Counter[str] = Counter()
    for i in items:
        for s in i["slots"]:
            slot_counts[s] += 1

    payload = {
        "generatedAt": datetime.now(TZ).strftime("%Y-%m-%d %H:%M Asia/Shanghai"),
        "timezone": "Asia/Shanghai",
        "schemaVersion": 1,
        "source": source,
        "note": note,
        "rules": {
            "dirs": ["checkpoints", "diffusion_models", "h3 (non-lora weights)"],
            "family": "basename aliases aligned to build-model-compat-graph; unresolved → family=null",
            "honesty": "UI must label unresolved as 族未解析; never invent family",
        },
        "count": len(items),
        "familyResolved": sum(1 for i in items if i["familyResolved"]),
        "familyUnknown": sum(1 for i in items if not i["familyResolved"]),
        "byFamily": dict(fam_counts.most_common()),
        "bySlot": dict(slot_counts),
        "items": items,
    }
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(
        f"wrote {OUT.relative_to(ROOT)} count={payload['count']} "
        f"resolved={payload['familyResolved']} unknown={payload['familyUnknown']} "
        f"live={source.get('live')}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
