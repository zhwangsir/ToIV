"""应用内「模式 / 示例」(2026-09-29 市场去重后的增值功能)。

市场激进去重后只留 186 张代表卡;被隐藏的同类卡里,凡是真有能力差异的
(极速版、高清放大、多图参考、局部蒙版…)挂到代表卡的「模式」上,
运行页一键切换到那张卡的工作流跑;只差提示词的收成「示例」,一键填入。

数据:app/data/app_variants.json(由 app/data/tools/build_app_variants.py 在
生产库上生成:只收 smoke=pass 且 NSFW 口径与代表卡一致的模式目标;示例值取
源卡提示词槽的默认值/工作流里的原值,去掉模板占位与重复)。

形如 {keeper_id: {"modes": [{label, desc, app_id}], "presets": [{label, values}]}}。
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any

_PATH = Path(__file__).resolve().parent.parent / "data" / "app_variants.json"
_cache: dict[str, Any] = {"mtime": None, "data": {}, "rev": {}}


def _load() -> tuple[dict[str, dict], dict[str, str]]:
    try:
        mt = _PATH.stat().st_mtime
    except OSError:
        return {}, {}
    if _cache["mtime"] != mt:
        try:
            raw = json.loads(_PATH.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            raw = {}
        data: dict[str, dict] = {}
        rev: dict[str, str] = {}
        for kid, v in (raw or {}).items():
            if not isinstance(v, dict) or kid.startswith("_"):
                continue
            modes = [m for m in v.get("modes") or [] if isinstance(m, dict) and m.get("app_id") and m.get("label")]
            presets = [
                p for p in v.get("presets") or []
                if isinstance(p, dict) and p.get("label") and isinstance(p.get("values"), dict)
            ]
            data[kid] = {"modes": modes, "presets": presets}
            for m in modes:
                rev.setdefault(str(m["app_id"]), kid)
        _cache.update(mtime=mt, data=data, rev=rev)
    return _cache["data"], _cache["rev"]


def keeper_of(app_id: str) -> str | None:
    """app_id 是某代表卡的模式目标时返回代表卡 id。"""
    return _load()[1].get(app_id)


def variants_for(app_id: str) -> tuple[str, dict] | None:
    """返回 (keeper_id, {modes, presets});app_id 可为代表卡或其模式目标。"""
    data, rev = _load()
    kid = app_id if app_id in data else rev.get(app_id)
    if not kid:
        return None
    return kid, data[kid]
