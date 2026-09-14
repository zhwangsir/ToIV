"""RunningHub Wan / LTX / VACE 社区卡 → 内置/公共应用预设(克隆已有 family 图)。

与 rh_h3_preset_seed 同纪律:
- 每张卡挂到已有 base_id 的 workflow_json / params_schema / bindings(引用共享,不 deepcopy);
- 不新造 Comfy 图,不把 RH 远端图当本地图;
- JSON 行带 provenance(webappId / coverUrl / searches),供 admin 播种与封面对齐。

挂进 app_seed._build_specs 需设环境变量 TOIV_SEED_RH_FAMILY=1,且需
apps/api/app/data/rh_family_presets.json(精选子集)。全量 2k+ 默认不开——太重,
且与 admin API 播种的非内置 rh-* 语义混用。CLI:.regen_tmp/seed_rh_wan_ltx_pilot.py。
"""
from __future__ import annotations

import copy
import hashlib
import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_HERE = Path(__file__).resolve()
_CANDIDATES = (
    _HERE.parents[1] / "data" / "rh_family_presets.json",
    _HERE.parent / "rh_family_presets.json",
    Path("/workspace/toiv-apps/seed-patch/rh_family_presets.json"),
)

# useCase 标签 → 本地 base_id(优先更具体的族)
_BASE_BY_TAG = {
    "wan-animate": "wan-animate-2",
    "vace-edit": "vace-edit",
    "vace": "wan-vace",
    "ltx-lipsync": "ltx-lipsync",
    "ltx-i2v": "ltx-img2video",
    "ltx-t2v": "ltx-txt2video",
    "ltx": "ltx-img2video",
    "wan2.2-i2v": "wan-nsfw-i2v",
    "wan2.2-t2v": "wan-nsfw-i2v",  # 本地暂无独立 Wan T2V 内置;挂 i2v 图并 note 标明
    "wan2.2": "wan-nsfw-i2v",
    "wan": "wan-nsfw-i2v",
}

_FAMILY_LABEL = {
    "wan-i2v": "Wan图生",
    "wan-t2v": "Wan文生",
    "wan-animate": "Wan动作迁移",
    "wan-vace": "Wan-VACE",
    "vace-edit": "VACE编辑",
    "ltx-i2v": "LTX图生",
    "ltx-t2v": "LTX文生",
    "ltx-lipsync": "LTX对口型",
    "ltx": "LTX",
    "other": "RH预设",
}

_UPLOAD_BY_BASE = {
    "wan-nsfw-i2v": "上传首帧图",
    "wan-animate-2": "上传角色参考图+驱动视频",
    "wan-animate": "上传角色参考图+驱动视频",
    "wan-vace": "上传参考图",
    "vace-edit": "上传源视频并填写编辑指令",
    "ltx-txt2video": "填写提示词即可",
    "ltx-img2video": "上传首帧图",
    "ltx-lipsync": "上传人像图+驱动音频",
    "ltx25-multishot": "分镜长句提示词",
}

_LAST_SKIPPED: list[str] = []


def preset_json_path() -> Path:
    for p in _CANDIDATES:
        if p.is_file():
            return p
    return _CANDIDATES[0]


def load_preset_rows(path: Path | None = None) -> list[dict[str, Any]]:
    p = path or preset_json_path()
    if not p.is_file():
        raise FileNotFoundError(f"missing RH family preset catalog: {p}")
    data = json.loads(p.read_text(encoding="utf-8"))
    if isinstance(data, dict):
        data = data.get("items") or data.get("rows") or []
    if not isinstance(data, list):
        raise ValueError(f"rh_family_presets.json must be a list, got {type(data)}")
    return data


def last_skipped() -> list[str]:
    return list(_LAST_SKIPPED)


def _slug_id(prefix: str, webapp_id: str, name: str = "") -> str:
    """稳定短 id:rh-{prefix}-{webapp 末 8}+可选名哈希,≤64,仅 [a-z0-9-]。"""
    wid = re.sub(r"[^0-9a-zA-Z]", "", str(webapp_id))[-10:] or "0"
    h = hashlib.sha1(f"{webapp_id}|{name}".encode()).hexdigest()[:6]
    raw = f"rh-{prefix}-{wid}-{h}".lower()
    raw = re.sub(r"[^a-z0-9-]", "-", raw)
    return raw[:64]


def classify_item(item: dict[str, Any]) -> dict[str, str]:
    """从 catalog 行推断 family / base_id / note。

    优先级: animate > lipsync > vace-edit > vace > wan i2v/t2v > ltx i2v/t2v。
    """
    use = {t.strip().lower() for t in str(item.get("useCase") or "").split(",") if t.strip()}
    name = str(item.get("name") or "")
    name_l = name.lower()
    blob = f"{name_l} {' '.join(sorted(use))}"

    note = ""
    is_wan = ("wan2.2" in use or "wan" in use or "wan2.2" in name_l
              or name_l.startswith("wan") or " wan" in f" {name_l}")
    is_ltx = ("ltx" in use or "ltx" in name_l)
    is_lipsync = ("对口型" in name or "lipsync" in name_l or "lip sync" in name_l)

    if "wan-animate" in use or ("animate" in name_l and is_wan):
        family, base = "wan-animate", _BASE_BY_TAG["wan-animate"]
    elif is_lipsync and is_ltx and not is_wan:
        family, base = "ltx-lipsync", _BASE_BY_TAG["ltx-lipsync"]
    elif is_lipsync and is_wan and not is_ltx:
        # Wan 对口型暂无独立 base,挂 wan-nsfw-i2v 并 note
        family, base = "wan-i2v", _BASE_BY_TAG["wan2.2-i2v"]
        note = "Wan 对口型/S2V 暂挂 wan-nsfw-i2v(无独立 lipsync base)"
    elif "vace-edit" in use or ("vace" in blob and ("edit" in blob or "编辑" in name)):
        family, base = "vace-edit", _BASE_BY_TAG["vace-edit"]
    elif "vace" in use or "vace" in name_l:
        family, base = "wan-vace", _BASE_BY_TAG["vace"]
    elif is_ltx:
        if is_lipsync:
            family, base = "ltx-lipsync", _BASE_BY_TAG["ltx-lipsync"]
        elif "t2v" in use or "文生" in name:
            family, base = "ltx-t2v", _BASE_BY_TAG["ltx-t2v"]
        else:
            family, base = "ltx-i2v", _BASE_BY_TAG["ltx-i2v"]
    elif is_wan:
        if "t2v" in use or "文生" in name or "text-to-video" in name_l:
            family, base = "wan-t2v", _BASE_BY_TAG["wan2.2-t2v"]
            note = "本地无独立 Wan T2V 内置,暂挂 wan-nsfw-i2v 图"
        else:
            family, base = "wan-i2v", _BASE_BY_TAG["wan2.2-i2v"]
    else:
        family, base = "other", ""

    prefix = {
        "wan-i2v": "wan",
        "wan-t2v": "wan",
        "wan-animate": "wanim",
        "wan-vace": "vace",
        "vace-edit": "vacee",
        "ltx-i2v": "ltx",
        "ltx-t2v": "ltx",
        "ltx-lipsync": "ltxlip",
        "other": "rh",
    }.get(family, "rh")

    return {"family": family, "base_id": base, "id_prefix": prefix, "note": note}


def describe_preset(row: dict[str, Any]) -> str:
    family = _FAMILY_LABEL.get(str(row.get("family") or ""), "RH预设")
    author = str(row.get("author") or "").strip() or "未知作者"
    upload = _UPLOAD_BY_BASE.get(str(row.get("base_id") or ""), "按表单上传素材")
    note = str(row.get("note") or "").strip()
    wid = str(row.get("webappId") or "").strip()
    parts = [family, author, upload]
    if note:
        parts.append(note)
    if wid:
        parts.append(f"RH:{wid}")
    # AppCreate.description max 500
    return " · ".join(parts)[:500]


def row_from_candidate(item: dict[str, Any], *, sort: int = 5000) -> dict[str, Any] | None:
    """catalog item → preset row;无法映射则 None。"""
    cls = classify_item(item)
    if not cls["base_id"]:
        return None
    wid = str(item.get("webappId") or "").strip()
    name = str(item.get("name") or "").strip()
    if not wid or not name:
        return None
    return {
        "id": _slug_id(cls["id_prefix"], wid, name),
        "name": name[:120],
        "author": str(item.get("author") or "")[:120],
        "family": cls["family"],
        "base_id": cls["base_id"],
        "is_nsfw": cls["base_id"] in {"wan-nsfw-i2v", "ltx-txt2video", "ltx-img2video", "ltx-lipsync"},
        "sort": int(sort),
        "note": cls["note"],
        "webappId": wid,
        "coverUrl": str(item.get("coverUrl") or "")[:500],
        "useCase": str(item.get("useCase") or ""),
        "useCount": int(item.get("useCount") or 0),
        "searches": list(item.get("searches") or []),
    }



def dedupe_display_name(name: str, used: set[str], webapp_id: str = "") -> str:
    """保证展示名在 used 集合内唯一;冲突时追加 webapp 末 6 位。"""
    base = (name or "").strip()[:120] or "RH预设"
    if base not in used:
        used.add(base)
        return base
    suffix = (re.sub(r"[^0-9]", "", str(webapp_id)) or "0")[-6:]
    cand = f"{base[:110]} · {suffix}"[:120]
    n = 2
    while cand in used:
        cand = f"{base[:108]} · {suffix}-{n}"[:120]
        n += 1
    used.add(cand)
    return cand


def select_batch(
    items: list[dict[str, Any]],
    *,
    wan: int = 100,
    ltx: int = 80,
    vace: int = 0,
    animate: int = 0,
    exclude_webapp_ids: set[str] | None = None,
    high_conf_wan_ltx: bool = True,
) -> list[dict[str, Any]]:
    """按 useCount 取下一批;跳过 exclude_webapp_ids。

    high_conf_wan_ltx=True 时 Wan/LTX 仍要求 useCase/name 含 wan2.2 或 ltx
    (与 select_pilot 同纪律);VACE/animate 直接按 family。
    """
    excl = {str(x) for x in (exclude_webapp_ids or set())}
    buckets: dict[str, list[dict[str, Any]]] = {
        "wan": [],
        "ltx": [],
        "vace": [],
        "animate": [],
    }
    for it in items:
        row = row_from_candidate(it)
        if row is None:
            continue
        wid = str(row.get("webappId") or "")
        if wid and wid in excl:
            continue
        fam = row["family"]
        uc = (row.get("useCase") or "").lower()
        nm = (row.get("name") or "").lower()
        if fam in {"wan-i2v", "wan-t2v"}:
            if high_conf_wan_ltx and not ("wan2.2" in uc or "wan2.2" in nm):
                continue
            buckets["wan"].append(row)
        elif fam.startswith("ltx"):
            if high_conf_wan_ltx and not ("ltx" in uc or "ltx" in nm):
                continue
            buckets["ltx"].append(row)
        elif fam in {"wan-vace", "vace-edit"}:
            buckets["vace"].append(row)
        elif fam == "wan-animate":
            buckets["animate"].append(row)
    for k in buckets:
        buckets[k].sort(key=lambda r: -int(r.get("useCount") or 0))

    limits = {"wan": wan, "ltx": ltx, "vace": vace, "animate": animate}
    sort_base = {"wan": 5200, "ltx": 5400, "vace": 5600, "animate": 5800}
    seen: set[str] = set()
    seen_wid: set[str] = set()
    out: list[dict[str, Any]] = []
    for key in ("wan", "ltx", "vace", "animate"):
        limit = int(limits[key] or 0)
        if limit <= 0:
            continue
        taken = 0
        for i, row in enumerate(buckets[key]):
            if taken >= limit:
                break
            if row["id"] in seen:
                continue
            wid = str(row.get("webappId") or "")
            if wid and wid in seen_wid:
                continue
            row = dict(row)
            row["sort"] = sort_base[key] + i
            seen.add(row["id"])
            if wid:
                seen_wid.add(wid)
            out.append(row)
            taken += 1
    return out


def select_pilot(
    items: list[dict[str, Any]],
    *,
    wan: int = 20,
    ltx: int = 10,
) -> list[dict[str, Any]]:
    """高置信试点:Wan2.2(非 animate/vace 主路)按 useCount top N + LTX top M。"""
    wan_rows: list[dict[str, Any]] = []
    ltx_rows: list[dict[str, Any]] = []
    for it in items:
        row = row_from_candidate(it)
        if row is None:
            continue
        fam = row["family"]
        uc = (row.get("useCase") or "").lower()
        nm = (row.get("name") or "").lower()
        if fam in {"wan-i2v", "wan-t2v"} and ("wan2.2" in uc or "wan2.2" in nm):
            wan_rows.append(row)
        elif fam.startswith("ltx") and ("ltx" in uc or "ltx" in nm):
            ltx_rows.append(row)
    wan_rows.sort(key=lambda r: -int(r.get("useCount") or 0))
    ltx_rows.sort(key=lambda r: -int(r.get("useCount") or 0))
    # 去重 id
    seen: set[str] = set()
    out: list[dict[str, Any]] = []
    for i, row in enumerate(wan_rows):
        if len([x for x in out if x["family"].startswith("wan")]) >= wan:
            break
        if row["id"] in seen:
            continue
        row = dict(row)
        row["sort"] = 5000 + i
        seen.add(row["id"])
        out.append(row)
    for i, row in enumerate(ltx_rows):
        if len([x for x in out if x["family"].startswith("ltx")]) >= ltx:
            break
        if row["id"] in seen:
            continue
        row = dict(row)
        row["sort"] = 5100 + i
        seen.add(row["id"])
        out.append(row)
    return out



# 参考提示词族默认(RH detail 无 STRING 时回退;勿写 NSFW 明示)
_FAMILY_PROMPT_DEFAULTS: dict[str, str] = {
    "qwen-edit": "按参考图编辑：保持人物与构图一致，仅修改需要变化的部分。",
    "flux2-i2i": "严格按照上传图片人物一致",
    "zimage-i2i": "严格按照上传图片人物一致",
    "qwen-i2i": "严格按照上传图片人物一致",
    "flux2-t2i": "一张高质量照片，主体清晰，光影自然，细节丰富。",
    "zimage-t2i": "一张高质量照片，主体清晰，光影自然，细节丰富。",
    "qwen-t2i": "一张高质量照片，主体清晰，光影自然，细节丰富。",
    "wan-i2v": "镜头缓缓推进，主体自然动作，光影稳定。",
    "wan-t2v": "电影感镜头：主体缓缓入画，环境光柔和。",
    "wan-animate": "角色按驱动视频动作，保持外形一致。",
    "wan-vace": "按参考图生成连贯视频，运动自然。",
    "vace-edit": "按编辑指令修改视频内容，保持主体一致。",
    "ltx-i2v": "镜头缓缓推进，主体自然动作，光影稳定。",
    "ltx-t2v": "电影感镜头：主体缓缓入画，环境光柔和。",
    "ltx-lipsync": "人物口型与音频同步，表情自然。",
    "i2v": "镜头缓缓推进，主体自然动作，光影稳定。",
    "t2v": "电影感镜头：主体缓缓入画，环境光柔和。",
    "img-edit": "按参考图编辑：保持主体一致，仅修改描述的部分。",
}

_PROMPT_PARAM_KEYS = frozenset({
    "positive", "prompt", "text", "instruction", "edit_prompt", "edit",
})


def demo_image_default(cover_url: str) -> list[dict[str, str]]:
    """RH/封面 CDN URL → 表单 images 槽位示例句柄(仅预览;提交端会剥离 http(s) demo)。"""
    url = (cover_url or "").strip()
    if not url:
        return []
    return [{
        "filename": url,
        "previewUrl": url,
        "name": "示例参考图",
        "worker": "",
    }]


def inject_rh_ref_defaults(
    params_schema: list[dict[str, Any]],
    *,
    cover_url: str = "",
    example_prompt: str = "",
    family: str = "",
) -> list[dict[str, Any]]:
    """写入示例提示词 / 参考图 default;无素材可写时原样返回(可共享引用)。

    - 提示词:example_prompt > 族默认;仅填空串/None 的 text|textarea 且 key 在白名单。
    - 图片:cover_url → images 类型空 default 槽位。
    - 有变更时 deepcopy,避免污染 base 共享 schema。
    """
    prompt = (example_prompt or "").strip()
    if not prompt:
        prompt = (_FAMILY_PROMPT_DEFAULTS.get(str(family or "").strip()) or "").strip()
    cover = (cover_url or "").strip()
    if not prompt and not cover:
        return params_schema

    touched = False
    for p in params_schema:
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or "")
        ptype = p.get("type")
        if prompt and ptype in ("text", "textarea") and key in _PROMPT_PARAM_KEYS:
            cur = p.get("default")
            if cur is None or cur == "":
                touched = True
                break
        if cover and ptype == "images":
            cur = p.get("default")
            if cur is None or cur == "" or cur == []:
                touched = True
                break
    if not touched:
        return params_schema

    schema = copy.deepcopy(params_schema)
    demo = demo_image_default(cover) if cover else []
    for p in schema:
        if not isinstance(p, dict):
            continue
        key = str(p.get("key") or "")
        ptype = p.get("type")
        if prompt and ptype in ("text", "textarea") and key in _PROMPT_PARAM_KEYS:
            cur = p.get("default")
            if cur is None or cur == "":
                p["default"] = prompt[:2000]
        if demo and ptype == "images":
            cur = p.get("default")
            if cur is None or cur == "" or cur == []:
                # 多图槽位只预填第一张示例,其余仍空
                p["default"] = list(demo)
    return schema


def expand_rh_family_presets(
    base_by_id: dict[str, dict[str, Any]],
    rows: list[dict[str, Any]] | None = None,
) -> list[dict[str, Any]]:
    """Clone each catalog row onto its base spec(共享图引用)。"""
    global _LAST_SKIPPED
    rows = rows if rows is not None else load_preset_rows()
    out: list[dict[str, Any]] = []
    seen: set[str] = set(base_by_id)
    skipped: list[str] = []
    for row in rows:
        pid = str(row.get("id") or "").strip()
        base_id = str(row.get("base_id") or "").strip()
        name = str(row.get("name") or "").strip()
        if not pid or not name:
            skipped.append(f"bad-row:{pid or '?'}")
            continue
        if pid in seen:
            skipped.append(f"id-collision:{pid}")
            continue
        if len(pid) > 64 or not pid.startswith("rh-"):
            skipped.append(f"bad-id:{pid}")
            continue
        base = base_by_id.get(base_id)
        if base is None:
            skipped.append(f"{pid}->{base_id}")
            continue
        schema = inject_rh_ref_defaults(
            base["params_schema"],
            cover_url=str(row.get("coverUrl") or row.get("cover_url") or ""),
            example_prompt=str(row.get("example_prompt") or row.get("examplePrompt") or ""),
            family=str(row.get("family") or ""),
        )
        spec = {
            "id": pid,
            "name": name,
            "description": describe_preset(row),
            "icon": base["icon"],
            "category": base["category"],
            "output_kind": base["output_kind"],
            "workflow_json": base["workflow_json"],
            "params_schema": schema,
            "bindings": base["bindings"],
            "is_nsfw": bool(row.get("is_nsfw", base.get("is_nsfw"))),
            "sort": int(row.get("sort") or 5000),
            "author": str(row.get("author") or ""),
            "cover_url": str(row.get("coverUrl") or row.get("cover_url") or ""),
            # 不入库辅助键(admin 脚本 / 统计用)
            "rh_base_id": base_id,
            "rh_family": str(row.get("family") or ""),
            "rh_author": str(row.get("author") or ""),
            "rh_webapp_id": str(row.get("webappId") or ""),
        }
        out.append(spec)
        seen.add(pid)
    _LAST_SKIPPED = skipped
    if skipped:
        logger.warning("RH family presets skipped %d: %s", len(skipped), skipped[:20])
    return out


def rh_family_seed_stats(specs: list[dict[str, Any]]) -> dict[str, Any]:
    rh = [s for s in specs if str(s.get("id", "")).startswith("rh-") and s.get("rh_family")]
    by_base: dict[str, int] = {}
    by_fam: dict[str, int] = {}
    for s in rh:
        bid = str(s.get("rh_base_id") or "?")
        fam = str(s.get("rh_family") or "?")
        by_base[bid] = by_base.get(bid, 0) + 1
        by_fam[fam] = by_fam.get(fam, 0) + 1
    return {
        "count": len(rh),
        "unique_ids": len({s["id"] for s in rh}),
        "by_base_id": by_base,
        "by_family": by_fam,
        "skipped": list(_LAST_SKIPPED),
    }
