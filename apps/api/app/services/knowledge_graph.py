"""内置 AI 最小知识图谱 —— 实体(engines/apps/loras/models) + 关系,供助手/admin 导出。

最小切片(2026-09-07):
- 不建新表;运行时从引擎注册表、App(is_builtin)、lora_catalog、ModelCard 拼图。
- 关系:lora→engine(compatible_with)、app→engine(clones_base / same_id)、
  model→source(enriched_from,仅含 admin 出处字段)、app→rh_webapp(provenance)。
- 入口:admin GET /api/admin/knowledge-graph(全量 JSON)与 ?entity= 一跳邻域。
"""
from __future__ import annotations

from typing import Any

from sqlmodel import Session, select

from app.models import App, ModelCard
from app.services import lora_catalog
from app.services.engine_registry import _REGISTRY, _ensure_registry, get_engine_spec
from app.services.provenance import extract_rh_webapp_id

# rh-* 应用 id 前缀 → 本地 base 引擎/内置应用 id(与 rh_family_preset_seed 对齐)
_RH_PREFIX_BASE: tuple[tuple[str, str], ...] = (
    ("rh-wanim-", "wan-animate-2"),
    ("rh-vacee-", "vace-edit"),
    ("rh-vace-", "wan-vace"),
    ("rh-ltxlip-", "ltx-nsfw-lipsync"),
    ("rh-ltx-", "ltx-nsfw-i2v"),
    ("rh-wan-", "wan-nsfw-i2v"),
    ("rh-h3-", "h3-t2v"),
)


def _node(nid: str, ntype: str, label: str, **props: Any) -> dict[str, Any]:
    return {"id": nid, "type": ntype, "label": label, "props": {k: v for k, v in props.items() if v not in (None, "", [], {})}}


def _edge(src: str, rel: str, dst: str, **props: Any) -> dict[str, Any]:
    e: dict[str, Any] = {"from": src, "rel": rel, "to": dst}
    extra = {k: v for k, v in props.items() if v not in (None, "", [], {})}
    if extra:
        e["props"] = extra
    return e


def _rh_base_id(app_id: str) -> str:
    aid = (app_id or "").lower()
    for prefix, base in _RH_PREFIX_BASE:
        if aid.startswith(prefix):
            return base
    return ""


def build_builtin_knowledge_graph(session: Session) -> dict[str, Any]:
    """拼装最小图谱(含 admin 出处字段;端点已 admin 门控)。"""
    _ensure_registry()
    nodes: dict[str, dict[str, Any]] = {}
    edges: list[dict[str, Any]] = []

    # ── engines ──
    for spec in _REGISTRY:
        eid = f"engine:{spec['id']}"
        src = spec.get("source") or {}
        nodes[eid] = _node(
            eid, "engine", spec.get("label") or spec["id"],
            engine_id=spec["id"],
            kind=spec.get("kind"),
            nsfw=bool(spec.get("nsfw")),
            description=spec.get("description") or "",
            source_name=src.get("name") or "",
            source_author=src.get("author") or "",
            source_url=src.get("url") or "",
        )

    # ── curated LoRAs ──
    for card in lora_catalog.CATALOG:
        lid = f"lora:{card.name}"
        nodes[lid] = _node(
            lid, "lora", card.label or card.name,
            filename=card.name,
            role=card.role,
            nsfw=bool(card.nsfw),
            default_strength=card.default_strength,
            trigger_words=list(card.trigger_words),
        )
        for eng in sorted(card.engines):
            # lora_catalog 用短族名(wan/ltx/h3);尽量挂到注册表里带此前缀的引擎
            targets = [s["id"] for s in _REGISTRY if s["id"] == eng or s["id"].startswith(f"{eng}-")]
            if not targets and get_engine_spec(eng):
                targets = [eng]
            if not targets:
                # 族节点(无精确引擎时仍保留可查询锚点)
                fam = f"engine_family:{eng}"
                if fam not in nodes:
                    nodes[fam] = _node(fam, "engine_family", eng, family=eng)
                edges.append(_edge(lid, "compatible_with", fam))
                continue
            for tid in targets:
                edges.append(_edge(lid, "compatible_with", f"engine:{tid}"))

    # ── builtin apps ──
    apps = session.exec(select(App).where(App.is_builtin == True)).all()  # noqa: E712
    for a in apps:
        aid = f"app:{a.id}"
        wid = extract_rh_webapp_id(a.description)
        nodes[aid] = _node(
            aid, "app", a.name,
            app_id=a.id,
            category=a.category,
            output_kind=a.output_kind,
            author=a.author or "",
            is_nsfw=bool(a.is_nsfw),
            cover_url=a.cover_url or "",
            rh_webapp_id=wid,
            description_public=a.description or "",
        )
        # 同 id 引擎
        if get_engine_spec(a.id):
            edges.append(_edge(aid, "implements", f"engine:{a.id}"))
        base = _rh_base_id(a.id)
        if base:
            base_app = f"app:{base}"
            if base_app in nodes or session.get(App, base):
                if base_app not in nodes:
                    ba = session.get(App, base)
                    if ba:
                        nodes[base_app] = _node(
                            base_app, "app", ba.name,
                            app_id=ba.id, category=ba.category, is_builtin=True,
                        )
                edges.append(_edge(aid, "clones_base", base_app, base_id=base))
            if get_engine_spec(base):
                edges.append(_edge(aid, "uses_engine", f"engine:{base}"))
        if wid:
            rid = f"rh_webapp:{wid}"
            nodes[rid] = _node(rid, "rh_webapp", f"RH {wid}", webapp_id=wid)
            edges.append(_edge(aid, "provenance", rid))

    # ── ModelCard 富化缓存(外部出处)──
    for mc in session.exec(select(ModelCard)).all():
        mid = f"model:{mc.id}"
        nodes[mid] = _node(
            mid, "model", mc.label or mc.filename,
            filename=mc.filename,
            model_type=mc.model_type,
            base_model=mc.base_model or "",
            creator=mc.creator or "",
            source=mc.source or "",
            civitai_id=mc.civitai_id or "",
            civitai_url=mc.civitai_url or "",
            nsfw=bool(mc.nsfw),
        )
        if mc.civitai_id:
            sid = f"civitai:{mc.civitai_id}"
            nodes[sid] = _node(
                sid, "external_source", f"Civitai {mc.civitai_id}",
                provider="civitai", source_id=mc.civitai_id, url=mc.civitai_url or "",
            )
            edges.append(_edge(mid, "enriched_from", sid))

    return {
        "version": 1,
        "nodes": list(nodes.values()),
        "edges": edges,
        "counts": {
            "nodes": len(nodes),
            "edges": len(edges),
            "by_type": _count_by(nodes.values(), "type"),
            "by_rel": _count_rel(edges),
        },
    }


def query_neighborhood(graph: dict[str, Any], entity: str, *, depth: int = 1) -> dict[str, Any]:
    """按 id / label / props.* 模糊命中种子节点,返回 ≤depth 跳子图。"""
    q = (entity or "").strip().lower()
    if not q:
        return {"seeds": [], "nodes": [], "edges": [], "counts": {"nodes": 0, "edges": 0}}
    nodes = graph.get("nodes") or []
    edges = graph.get("edges") or []
    by_id = {n["id"]: n for n in nodes}

    seeds: list[str] = []
    for n in nodes:
        blob = " ".join(
            [
                str(n.get("id") or ""),
                str(n.get("label") or ""),
                " ".join(f"{k}:{v}" for k, v in (n.get("props") or {}).items()),
            ]
        ).lower()
        if q in blob:
            seeds.append(n["id"])

    keep = set(seeds)
    frontier = set(seeds)
    for _ in range(max(1, min(depth, 3))):
        nxt: set[str] = set()
        for e in edges:
            if e["from"] in frontier or e["to"] in frontier:
                keep.add(e["from"])
                keep.add(e["to"])
                nxt.add(e["from"])
                nxt.add(e["to"])
        frontier = nxt
    sub_nodes = [by_id[i] for i in keep if i in by_id]
    sub_edges = [e for e in edges if e["from"] in keep and e["to"] in keep]
    return {
        "seeds": seeds,
        "nodes": sub_nodes,
        "edges": sub_edges,
        "counts": {"nodes": len(sub_nodes), "edges": len(sub_edges)},
    }


def _count_by(items, key: str) -> dict[str, int]:
    out: dict[str, int] = {}
    for it in items:
        k = str(it.get(key) or "?")
        out[k] = out.get(k, 0) + 1
    return out


def _count_rel(edges: list[dict[str, Any]]) -> dict[str, int]:
    out: dict[str, int] = {}
    for e in edges:
        k = str(e.get("rel") or "?")
        out[k] = out.get(k, 0) + 1
    return out
