"""说明书知识图谱(P2,2026-09-21)——应用说明卡关系计算与回填。

relations 语义 = 内容级相似(非 knowledge_graph.py 的结构/出处图):
- 信号(全确定性,零 LLM):同 use_case(+3)、共享加载器模型文件(+2/个,上限 6 分)、
  共享自定义节点类(+1/个,上限 6 分)、同 output_kind(+1)、同 RH 家族前缀(+1);
- 取 Top-5(score>0),自引用排除;写入 AppGuide.related_app_ids(预留列,此前零填充)。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from sqlmodel import Session, select

from app.comfy.client import _MODEL_LOADERS
from app.models import App, AppGuide

logger = logging.getLogger(__name__)

_TOP_N = 5
_MODEL_CAP = 6
_CLASS_CAP = 6


def _wf_classes(wf: Any) -> set[str]:
    if isinstance(wf, str):
        try:
            wf = json.loads(wf)
        except ValueError:
            return set()
    if not isinstance(wf, dict):
        return set()
    out: set[str] = set()
    for node in wf.values():
        if isinstance(node, dict):
            ct = str(node.get("class_type") or "").strip()
            if ct:
                out.add(ct)
    return out


def _wf_models(wf: Any) -> set[str]:
    if isinstance(wf, str):
        try:
            wf = json.loads(wf)
        except ValueError:
            return set()
    if not isinstance(wf, dict):
        return set()
    fields = {f for _, f in _MODEL_LOADERS}
    out: set[str] = set()
    for node in wf.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for f in fields:
            v = inputs.get(f)
            if isinstance(v, str) and v.strip():
                out.add(v.strip())
    return out


def _family(app_id: str) -> str:
    """rh-xxx-yyy 的前缀家族(rh-h3/rh-minimax/rh-wan 等);非 rh 返回全长。"""
    parts = str(app_id or "").split("-")
    return "-".join(parts[:2]) if len(parts) > 2 and parts[0] == "rh" else str(app_id or "")


def _features(app: App) -> dict[str, Any]:
    return {
        "classes": _wf_classes(app.workflow_json),
        "models": _wf_models(app.workflow_json),
        "use_case": (app.use_case or "").strip(),
        "output_kind": (app.output_kind or "image").strip(),
        "family": _family(app.id),
    }


def _score(f: dict[str, Any], o: dict[str, Any]) -> int:
    s = 0
    if f["use_case"] and f["use_case"] == o["use_case"]:
        s += 3
    s += min(len(f["models"] & o["models"]), _MODEL_CAP) * 2
    s += min(len(f["classes"] & o["classes"]), _CLASS_CAP)
    if f["output_kind"] == o["output_kind"]:
        s += 1
    if f["family"] == o["family"]:
        s += 1
    return s


def compute_relations(target: App, pool: list[App], top_n: int = _TOP_N) -> list[str]:
    """目标应用 → Top-N 关联应用 id(score>0,分高序,平分按 id 稳定序)。"""
    f = _features(target)
    scored: list[tuple[int, str]] = []
    for other in pool:
        if other.id == target.id:
            continue
        s = _score(f, _features(other))
        if s > 0:
            scored.append((s, other.id))
    scored.sort(key=lambda x: (-x[0], x[1]))
    return [aid for _, aid in scored[:top_n]]


def backfill_relations(session: Session, only_empty: bool = True) -> dict[str, int]:
    """给(published)说明卡回填 related_app_ids。返回 {done, skipped}。"""
    guides = session.exec(
        select(AppGuide).where(AppGuide.status == "published")
    ).all()
    apps = session.exec(select(App).where(App.is_public == True)).all()  # noqa: E712
    by_id = {a.id: a for a in apps}
    done = skipped = 0
    for g in guides:
        existing = g.related_app_ids if isinstance(g.related_app_ids, list) else []
        if only_empty and existing:
            skipped += 1
            continue
        target = by_id.get(g.app_id)
        if target is None:
            skipped += 1
            continue
        g.related_app_ids = compute_relations(target, apps)
        session.add(g)
        session.commit()
        done += 1
    logger.info("说明书关系回填: done=%d skipped=%d", done, skipped)
    return {"done": done, "skipped": skipped}
