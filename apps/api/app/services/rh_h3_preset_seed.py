"""RunningHub H3 社区卡 → 内置应用预设。

每张卡克隆已有 family 图(base_id)的 workflow_json / params_schema / bindings,
不新造 Comfy 图。workflow_json 按引用共享,避免 1000+ 次 deepcopy。

JSON: apps/api/app/data/rh_h3_presets.json
  {id, name, author, family, base_id, is_nsfw, sort, note}
"""
from __future__ import annotations

import copy
import json
import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_HERE = Path(__file__).resolve()
_CANDIDATES = (
    _HERE.parents[1] / "data" / "rh_h3_presets.json",  # app/data/  (wired)
    _HERE.parent / "rh_h3_presets.json",                 # seed-patch 旁路
    Path("/workspace/toiv-apps/rh_h3_presets.json"),
    Path("/workspace/toiv-apps/seed-patch/rh_h3_presets.json"),
)

_FAMILY_LABEL = {
    "t2v": "文生视频",
    "t2v-fast": "文生加速",
    "i2v": "图生视频",
    "i2v-fast": "图生加速",
    "fl2v": "首尾帧",
    "r2v": "全能参考",
    "r2v-voice": "声音参考",
    "swap": "角色替换",
    "v2v": "参考视频",
    "multishot": "多镜头",
    "img-edit": "图像编辑",
    "timefreeze": "时间静止",
    "scene": "场景预设",
    "upscale": "画质放大",
}

_UPLOAD_BY_BASE = {
    "h3-t2v": "填写提示词即可",
    "h3-nsfw-t2v": "填写提示词即可",
    "h3-i2v": "上传首帧图",
    "h3-nsfw-i2v": "上传首帧图",
    "h3-fl2v": "上传首帧+尾帧",
    "h3-nsfw-fl2v": "上传首帧+尾帧",
    "h3-r2v": "上传参考图(最多9张),可选视频/音频",
    "h3-nsfw-r2v": "上传参考图(最多9张),可选视频/音频",
    "h3-r2v-voice": "须配参考音频,并配图或视频,不能纯音频",
    "h3-nsfw-r2v-voice": "须配参考音频,并配图或视频,不能纯音频",
    "h3-t2v-15s-fast": "填写提示词;默认15s/8步,单段上限15s(原生1344x768,非928P)",
    "h3-nsfw-t2v-15s-fast": "填写提示词;默认15s/8步,单段上限15s(原生1344x768,非928P)",
    "h3-i2v-15s-fast": "上传首帧;默认15s/8步,单段上限15s(原生1344x768,非928P)",
    "h3-nsfw-i2v-15s-fast": "上传首帧;默认15s/8步,单段上限15s(原生1344x768,非928P)",
    "h3-multishot": "在提示词里写「镜头一…镜头二…」",
    "wan-animate-2": "上传角色参考图+驱动视频",
    "qwen-image-edit": "上传源图并填写编辑指令",
}

_TIMEFREEZE_PROMPT = "时间静止：环境与镜头凝滞，仅主体可动；从锁定首帧只写动作。"

# 最近一次 expand 的跳过项(未知 base / id 碰撞),供报告用。
_LAST_SKIPPED: list[str] = []


def preset_json_path() -> Path:
    for p in _CANDIDATES:
        if p.is_file():
            return p
    return _CANDIDATES[0]


def load_preset_rows() -> list[dict[str, Any]]:
    path = preset_json_path()
    if not path.is_file():
        raise FileNotFoundError(f"missing RH H3 preset catalog: {path}")
    data = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(data, list):
        raise ValueError(f"rh_h3_presets.json must be a list, got {type(data)}")
    return data


def describe_preset(row: dict[str, Any]) -> str:
    family = _FAMILY_LABEL.get(str(row.get("family") or ""), "H3预设")
    author = str(row.get("author") or "").strip() or "未知作者"
    upload = _UPLOAD_BY_BASE.get(str(row.get("base_id") or ""), "按表单上传素材")
    note = str(row.get("note") or "").strip()
    parts = [family, author, upload]
    if note and note not in upload:
        parts.append(note)
    return " · ".join(parts)


def last_skipped() -> list[str]:
    return list(_LAST_SKIPPED)


def expand_rh_h3_presets(base_by_id: dict[str, dict[str, Any]]) -> list[dict[str, Any]]:
    """Clone each catalog row onto its base spec.

    Shares workflow_json / bindings / params_schema by reference (timefreeze
    只 deepcopy params_schema 以写入默认提示词前缀)。未知 base_id 跳过并记入
    last_skipped(),不抛——便于缺图时仍能启动。
    """
    global _LAST_SKIPPED
    out: list[dict[str, Any]] = []
    seen: set[str] = set(base_by_id)
    skipped: list[str] = []
    for row in load_preset_rows():
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
        schema = base["params_schema"]
        if str(row.get("family") or "") == "timefreeze":
            schema = copy.deepcopy(base["params_schema"])
            for p in schema:
                if p.get("key") == "positive":
                    p["default"] = _TIMEFREEZE_PROMPT
        spec = {
            "id": pid,
            "name": name,
            "description": describe_preset(row),
            "icon": base["icon"],
            "category": base["category"],
            "output_kind": base["output_kind"],
            "workflow_json": base["workflow_json"],  # share, do not deepcopy
            "params_schema": schema,
            "bindings": base["bindings"],
            "is_nsfw": bool(row.get("is_nsfw")),
            "sort": int(row.get("sort") or 4000),
            # 下列键不入库;seed_builtin_apps 只读 App 字段。测试/统计用。
            "rh_base_id": base_id,
            "rh_family": str(row.get("family") or ""),
            "rh_author": str(row.get("author") or ""),
        }
        out.append(spec)
        seen.add(pid)
    _LAST_SKIPPED = skipped
    if skipped:
        logger.warning("RH H3 presets skipped %d: %s", len(skipped), skipped[:20])
    return out


def rh_h3_seed_stats(specs: list[dict[str, Any]]) -> dict[str, Any]:
    rh = [s for s in specs if str(s.get("id", "")).startswith("rh-")]
    by_base: dict[str, int] = {}
    nsfw = 0
    for s in rh:
        bid = str(s.get("rh_base_id") or "?")
        by_base[bid] = by_base.get(bid, 0) + 1
        if s.get("is_nsfw"):
            nsfw += 1
    return {
        "count": len(rh),
        "unique_ids": len({s["id"] for s in rh}),
        "nsfw": nsfw,
        "sfw": len(rh) - nsfw,
        "by_base_id": by_base,
        "skipped": list(_LAST_SKIPPED),
    }
