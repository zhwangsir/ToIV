"""自愈闭环 LLM 修复器(Phase1-P1.6,2026-09-15)。

烟测失败且确定性修复器(combo 校准)无解时:DSv4 读「原始工作流图 + 失败归因 +
目标实例相关 combo 清单」→ 提议受约束图补丁(改字段值/删死节点/改类名)→
本地沙箱校验(_build_graph + combo 在列检查)→ 试提交烟测 → 通过则落库。

安全边界:
- 补丁 ops 白名单:set_input(仅标量)/delete_node/rename_class;禁止加节点/改连线
- 每次修复原始图备份进 SelfhealProposal;reject 一键还原
- 总开关 settings.selfheal_llm_enabled
"""
from __future__ import annotations

import json
from sqlmodel import Session

from app.agent import llm as llm_svc
from app.agent.llm import LLMError
from app.models import App, SelfhealProposal
from app.services.app_packager import _extract_json
from app.services.app_smoke import _COMBO_LOADERS, _combo_opts

# 允许 LLM 改写的输入字段(combo/标量类);连线与拓扑不在白名单
_ALLOWED_FIELDS = set(_COMBO_LOADERS.values()) | {"model"} | {
    "steps", "cfg", "guidance", "denoise", "seed", "width", "height",
    "length", "duration_sec", "fps", "frame_rate", "batch_size", "strength",
}


def build_repair_messages(graph: dict, cls: str, error: str, combos: dict) -> list[dict]:
    """组装修复提示:图 + 归因 + 相关 loader 的在列清单(裁剪防爆上下文)。"""
    combo_lines: list[str] = []
    for ct, field in _COMBO_LOADERS.items():
        try:
            vals = _combo_opts(combos.get(ct, {}).get("input", {}).get("required", {}).get(field))
        except (KeyError, TypeError, IndexError):
            continue
        if not vals:
            continue
        shown = vals[:60]
        combo_lines.append(f"{ct}.{field} 可选值({len(vals)}个): {json.dumps(shown, ensure_ascii=False)}")
    system = (
        "你是 ComfyUI 工作流修复器。给定一张 API 格式工作流图、失败原因和相关加载器的合法取值,"
        "输出 JSON 补丁让图可执行。只允许三种 op:\n"
        '{"op":"set_input","node":"<id>","field":"<input名>","value":<标量>}\n'
        '{"op":"delete_node","node":"<id>"}(仅当该节点已死且无人依赖其输出)\n'
        '{"op":"rename_class","node":"<id>","class_type":"<合法类名>"}\n'
        "约束:不得新增节点/改连线;set_input 仅限标量且目标字段必须在合法值列表内;"
        "输出 {'patch':[...]} 一个 JSON 对象,不要解释。"
    )
    user = (
        f"失败归因: {cls}\n错误: {error[:400]}\n\n"
        f"工作流图:\n{json.dumps(graph, ensure_ascii=False)[:14000]}\n\n"
        + "\n".join(combo_lines[:20])
    )
    return [
        {"role": "system", "content": system},
        {"role": "user", "content": user},
    ]


def apply_patch(graph: dict, patch: list[dict], objinfo: dict) -> tuple[dict, list[str]]:
    """白名单内应用补丁;非法 op 丢弃并记 warning。返回(新图, 应用的说明)。"""
    g = json.loads(json.dumps(graph))  # 深拷贝
    applied: list[str] = []
    for op in patch or []:
        if not isinstance(op, dict):
            continue
        kind = op.get("op")
        nid = str(op.get("node") or "")
        node = g.get(nid)
        if kind == "set_input":
            field = op.get("field")
            if not node or field not in _ALLOWED_FIELDS or not isinstance(field, str):
                continue
            val = op.get("value")
            if isinstance(val, (list, dict)):
                continue  # 禁止连线/复合
            node.setdefault("inputs", {})[field] = val
            applied.append(f"node {nid}: {field} = {val!r}")
        elif kind == "delete_node":
            if node is not None:
                g.pop(nid, None)
                applied.append(f"node {nid}: deleted")
        elif kind == "rename_class":
            ct = op.get("class_type")
            if node is not None and isinstance(ct, str) and ct in objinfo:
                old = node.get("class_type")
                node["class_type"] = ct
                applied.append(f"node {nid}: class {old} → {ct}")
    return g, applied


def combo_violations(graph: dict, objinfo: dict) -> list[str]:
    """沙箱检查:combo loader 字段的值必须在在列清单内。返回违规描述。"""
    bad: list[str] = []
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        field = _COMBO_LOADERS.get(ct)
        if not field or ct not in objinfo:
            continue
        combo = _combo_opts((objinfo[ct].get("input") or {}).get("required", {}).get(field))
        if not combo:
            continue
        val = (node.get("inputs") or {}).get(field)
        if isinstance(val, str) and combo and val not in combo:
            bad.append(f"node {nid}: {ct}.{field} '{val}' 不在列表")
    return bad


async def propose_and_validate(
    graph: dict, cls: str, error: str, objinfo: dict,
) -> tuple[list[dict], dict, list[str]] | None:
    """DSv4 提议补丁并本地校验。全部合法返回 (patch, patched_graph, applied);
    LLM 不可用/无补丁/校验不过返回 None(LLMError 收敛为 None + 日志由调用方记)。"""
    messages = build_repair_messages(graph, cls, error, objinfo)
    try:
        msg = await llm_svc.chat(messages, max_tokens=1024, temperature=0.0, enable_thinking=False)
    except LLMError:
        return None
    except Exception:
        return None
    data = _extract_json(str(msg.get("content") or ""))
    patch = data.get("patch")
    if not isinstance(patch, list) or not patch:
        return None
    patched, applied = apply_patch(graph, patch, objinfo)
    if not applied:
        return None
    bad = combo_violations(patched, objinfo)
    if bad:
        return None
    return patch, patched, applied


def record_proposal(
    session: Session, app: App, cls: str, error: str,
    patch: list[dict], original_workflow: dict, note: str,
) -> SelfhealProposal:
    """落提案(含原始图备份,供 reject 还原)。"""
    p = SelfhealProposal(
        app_id=app.id,
        failure_cls=cls,
        original_error=(error or "")[:300],
        patch_json=json.dumps(patch, ensure_ascii=False),
        original_workflow_json=json.dumps(original_workflow, ensure_ascii=False),
        status="applied",
        note=note[:300],
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return p


def reject_proposal(session: Session, proposal_id: str) -> dict:
    """驳回提案并还原原始工作流图。返回 {app_id, restored}。"""
    p = session.get(SelfhealProposal, proposal_id)
    if not p:
        raise ValueError("提案不存在")
    original = json.loads(p.original_workflow_json)
    a = session.get(App, p.app_id)
    restored = False
    if a is not None:
        a.workflow_json = original
        a.smoke_status = ""  # 还原后重开烟测资格
        session.add(a)
        restored = True
    p.status = "rejected"
    p.note = (p.note + " | rejected: 还原原始图")[:300]
    session.add(p)
    session.commit()
    return {"app_id": p.app_id, "restored": restored}


def _patch_summary(p: SelfhealProposal) -> dict:
    return {
        "id": p.id,
        "app_id": p.app_id,
        "cls": p.failure_cls,
        "original_error": p.original_error,
        "patch": json.loads(p.patch_json or "[]"),
        "status": p.status,
        "note": p.note,
        "created_at": p.created_at.isoformat(timespec="seconds") if p.created_at else None,
    }


def list_proposals(session: Session, limit: int = 50) -> list[dict]:
    rows = session.query(SelfhealProposal).order_by(SelfhealProposal.created_at.desc()).limit(limit).all()
    return [_patch_summary(p) for p in rows]
