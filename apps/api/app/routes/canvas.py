"""无限画布 REST API + SSE 事件推送(M1.1)。

实现画布 / 节点 / 边的 CRUD + 节点执行骨架 + SSE 事件流。
所有端点带 ``Depends(get_current_user)`` 鉴权 + 多租户隔离,
非本人画布一律 404(不泄露存在性)。

SSE 端点 M1.1 仅做心跳保活(每 15s 推一个 ``{type:"heartbeat"}``),
实际的节点事件推送由 M1.2 的 Agent 工具通过 ``app.canvas_events.publish`` 触发,
SSE 端点已通过事件总线订阅,Agent 工具 publish 后会自动转发给所有订阅者。
"""
from __future__ import annotations

import asyncio
import json

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session, delete, select
from sse_starlette.sse import EventSourceResponse

import uuid
from pathlib import Path

from app.agent.tools import (
    _MEDIA_BY_EXT,
    _node_to_dict,
    _record,
    _url,
    _wait_files,
    run_canvas_node,
)
from app.canvas_comfy_bridge import (
    canvas_subgraph_to_comfy_prompt,
    comfy_prompt_to_canvas_subgraph,
    comfy_ui_graph_to_api,
)
from app.canvas_events import publish as publish_canvas_event, subscribe_queue, unsubscribe_queue
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.db import get_session
from app.deps import get_current_user, get_pool
from app.models import Canvas, CanvasEdge, CanvasNode, User, _now

router = APIRouter()

# 节点 kind 枚举(与 models.py 注释对齐)
_NODE_KINDS: tuple[str, ...] = (
    "text", "prompt", "image", "video", "audio",
    "model3d", "llm", "comfy_workflow", "tts", "asr",
)
# 节点 status 枚举
_NODE_STATUSES: tuple[str, ...] = ("idle", "running", "done", "error")

# SSE 心跳间隔(秒)
_HEARTBEAT_SEC: int = 15


# ---------------------------------------------------------------------------
# 请求体
# ---------------------------------------------------------------------------
class CreateCanvasBody(BaseModel):
    name: str = Field(default="未命名画布", max_length=200)


class UpdateCanvasBody(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    voice_active: bool | None = None
    default_ref_audio: str | None = Field(default=None, max_length=1000)


class CreateNodeBody(BaseModel):
    kind: str = Field(max_length=50)
    title: str | None = Field(default=None, max_length=200)
    position_x: float = 0.0
    position_y: float = 0.0
    payload: dict | None = None
    width: int | None = Field(default=None, ge=1, le=4096)
    height: int | None = Field(default=None, ge=1, le=4096)


class UpdateNodeBody(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    position_x: float | None = None
    position_y: float | None = None
    width: int | None = Field(default=None, ge=1, le=4096)
    height: int | None = Field(default=None, ge=1, le=4096)
    payload: dict | None = None
    status: str | None = Field(default=None, max_length=20)
    error: str | None = Field(default=None, max_length=2000)


class CreateEdgeBody(BaseModel):
    source: str = Field(min_length=1, max_length=64)
    target: str = Field(min_length=1, max_length=64)
    source_handle: str | None = Field(default=None, max_length=64)
    target_handle: str | None = Field(default=None, max_length=64)
    label: str | None = Field(default=None, max_length=200)


# ---------------------------------------------------------------------------
# 序列化(字段对齐前端 lib/canvas/types.ts)
# ---------------------------------------------------------------------------
def _canvas_dict(c: Canvas) -> dict:
    return {
        "id": c.id,
        "name": c.name,
        "voice_active": c.voice_active,
        "default_ref_audio": c.default_ref_audio,
        "created_at": c.created_at.isoformat(),
        "updated_at": c.updated_at.isoformat(),
    }


def _node_dict(n: CanvasNode) -> dict:
    return {
        "id": n.id,
        "canvas_id": n.canvas_id,
        "kind": n.kind,
        "title": n.title,
        "position_x": n.position_x,
        "position_y": n.position_y,
        "width": n.width,
        "height": n.height,
        # payload 是 JSON 串(前端解析为 CanvasNodePayload),不在 API 层转 dict
        "payload": n.payload,
        "status": n.status,
        "error": n.error,
        # parent_ids 也是 JSON 串(版本树,前端按需解析)
        "parent_ids": n.parent_ids,
        "created_at": n.created_at.isoformat(),
        "updated_at": n.updated_at.isoformat(),
    }


def _edge_dict(e: CanvasEdge) -> dict:
    return {
        "id": e.id,
        "canvas_id": e.canvas_id,
        "source": e.source,
        "target": e.target,
        "source_handle": e.source_handle,
        "target_handle": e.target_handle,
        "label": e.label,
    }


# ---------------------------------------------------------------------------
# 鉴权辅助:取本人画布/节点,否则 404(不泄露存在性)
# ---------------------------------------------------------------------------
def _owned_canvas(cid: str, user: User, session: Session) -> Canvas:
    c = session.get(Canvas, cid)
    if not c or c.user_id != user.id:
        raise HTTPException(status_code=404, detail="画布不存在")
    return c


def _owned_node(cid: str, nid: str, user: User, session: Session) -> tuple[Canvas, CanvasNode]:
    """取本人画布下的节点;canvas_id 不匹配也 404(防越权引用)。"""
    canvas = _owned_canvas(cid, user, session)
    node = session.get(CanvasNode, nid)
    if not node or node.canvas_id != cid:
        raise HTTPException(status_code=404, detail="节点不存在")
    return canvas, node


async def _publish_event(canvas_id: str, event: dict) -> None:
    """发布画布事件到事件总线,异常一律吞掉(不应影响 REST 响应)。

    复用 ``app.canvas_events.publish`` —— 与 Agent 工具的 ``_publish_canvas_event``
    行为对齐,SSE 订阅者会自动收到。
    """
    try:
        await publish_canvas_event(canvas_id, event)
    except Exception:  # noqa: BLE001 — 事件总线故障不阻断主流程
        pass


# ---------------------------------------------------------------------------
# 画布 CRUD
# ---------------------------------------------------------------------------
@router.get("/canvas")
def list_canvases(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """列出当前用户的画布(按 updated_at 倒序)。"""
    rows = session.exec(
        select(Canvas)
        .where(Canvas.user_id == user.id)
        .order_by(Canvas.updated_at.desc())
    ).all()
    return {"items": [_canvas_dict(c) for c in rows]}


@router.post("/canvas")
def create_canvas(
    body: CreateCanvasBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    c = Canvas(
        tenant_id=user.tenant_id,
        user_id=user.id,
        name=body.name,
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return _canvas_dict(c)


@router.get("/canvas/{cid}")
def get_canvas(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """取画布完整快照:{canvas, nodes, edges}。"""
    c = _owned_canvas(cid, user, session)
    nodes = session.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
    edges = session.exec(select(CanvasEdge).where(CanvasEdge.canvas_id == cid)).all()
    return {
        "canvas": _canvas_dict(c),
        "nodes": [_node_dict(n) for n in nodes],
        "edges": [_edge_dict(e) for e in edges],
    }


@router.patch("/canvas/{cid}")
def update_canvas(
    cid: str,
    body: UpdateCanvasBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    c = _owned_canvas(cid, user, session)
    if body.name is not None:
        c.name = body.name
    if body.voice_active is not None:
        c.voice_active = body.voice_active
    if body.default_ref_audio is not None:
        c.default_ref_audio = body.default_ref_audio
    c.updated_at = _now()
    session.add(c)
    session.commit()
    session.refresh(c)
    return _canvas_dict(c)


@router.delete("/canvas/{cid}")
def delete_canvas(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_canvas(cid, user, session)
    # SQLite 不强制 FK,手动级联删节点和边
    session.exec(delete(CanvasEdge).where(CanvasEdge.canvas_id == cid))
    session.exec(delete(CanvasNode).where(CanvasNode.canvas_id == cid))
    session.exec(delete(Canvas).where(Canvas.id == cid))
    session.commit()
    return {"ok": True, "id": cid}


# ---------------------------------------------------------------------------
# 节点 CRUD
# ---------------------------------------------------------------------------
@router.post("/canvas/{cid}/nodes")
def add_node(
    cid: str,
    body: CreateNodeBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_canvas(cid, user, session)
    if body.kind not in _NODE_KINDS:
        raise HTTPException(status_code=400, detail=f"非法 kind: {body.kind}")
    # payload 接受 dict,落库时 json.dumps 为串(对齐前端 payload: string)
    n = CanvasNode(
        canvas_id=cid,
        kind=body.kind,
        title=body.title or "",
        position_x=body.position_x,
        position_y=body.position_y,
        width=body.width,
        height=body.height,
        payload=json.dumps(body.payload or {}, ensure_ascii=False),
    )
    session.add(n)
    session.commit()
    session.refresh(n)
    return _node_dict(n)


@router.patch("/canvas/{cid}/nodes/{nid}")
def update_node(
    cid: str,
    nid: str,
    body: UpdateNodeBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _, n = _owned_node(cid, nid, user, session)
    if body.title is not None:
        n.title = body.title
    if body.position_x is not None:
        n.position_x = body.position_x
    if body.position_y is not None:
        n.position_y = body.position_y
    if body.width is not None:
        n.width = body.width
    if body.height is not None:
        n.height = body.height
    if body.payload is not None:
        n.payload = json.dumps(body.payload, ensure_ascii=False)
    if body.status is not None:
        if body.status not in _NODE_STATUSES:
            raise HTTPException(status_code=400, detail=f"非法 status: {body.status}")
        n.status = body.status
    if body.error is not None:
        n.error = body.error
    n.updated_at = _now()
    session.add(n)
    session.commit()
    session.refresh(n)
    return _node_dict(n)


@router.delete("/canvas/{cid}/nodes/{nid}")
async def delete_node(
    cid: str,
    nid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _, n = _owned_node(cid, nid, user, session)
    # 级联删除相关边(source 或 target 匹配);先取 id,删除后推 SSE 用
    cascaded_edge_ids = [
        e.id
        for e in session.exec(
            select(CanvasEdge).where(
                (CanvasEdge.source == nid) | (CanvasEdge.target == nid)
            )
        ).all()
    ]
    session.exec(
        delete(CanvasEdge).where(
            (CanvasEdge.source == nid) | (CanvasEdge.target == nid)
        )
    )
    session.delete(n)
    session.commit()
    # O3.2:REST 删除也推 SSE(此前仅 Agent 工具推,REST 删节点其他订阅者无感知)
    await _publish_event(cid, {"type": "node_deleted", "canvas_id": cid, "node_id": nid})
    for eid in cascaded_edge_ids:
        await _publish_event(cid, {"type": "edge_deleted", "canvas_id": cid, "edge_id": eid})
    return {"ok": True, "id": nid}


# ---------------------------------------------------------------------------
# 边 CRUD
# ---------------------------------------------------------------------------
@router.post("/canvas/{cid}/edges")
def add_edge(
    cid: str,
    body: CreateEdgeBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_canvas(cid, user, session)
    # 校验 source/target 节点都在此画布内(防越权引用别人画布的节点)
    src = session.get(CanvasNode, body.source)
    tgt = session.get(CanvasNode, body.target)
    if not src or src.canvas_id != cid:
        raise HTTPException(status_code=400, detail="source 节点不存在")
    if not tgt or tgt.canvas_id != cid:
        raise HTTPException(status_code=400, detail="target 节点不存在")
    e = CanvasEdge(
        canvas_id=cid,
        source=body.source,
        target=body.target,
        source_handle=body.source_handle or "",
        target_handle=body.target_handle or "",
        label=body.label or "",
    )
    session.add(e)
    session.commit()
    session.refresh(e)
    return _edge_dict(e)


@router.delete("/canvas/{cid}/edges/{eid}")
async def delete_edge(
    cid: str,
    eid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    _owned_canvas(cid, user, session)
    e = session.get(CanvasEdge, eid)
    if not e or e.canvas_id != cid:
        raise HTTPException(status_code=404, detail="边不存在")
    session.delete(e)
    session.commit()
    # O3.2:推 SSE,与节点删除对齐
    await _publish_event(cid, {"type": "edge_deleted", "canvas_id": cid, "edge_id": eid})
    return {"ok": True, "id": eid}


# ---------------------------------------------------------------------------
# 节点执行(M1.5a:复用 agent/tools.run_canvas_node 真执行器)
# ---------------------------------------------------------------------------
@router.post("/canvas/{cid}/run/{nid}")
async def run_node(
    cid: str,
    nid: str,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """触发节点执行:按 kind 路由到对应执行器(image/tts/llm/prompt/text),
    完成后通过 SSE 推送状态变更到所有订阅者。其余 kind 暂不支持自动执行。

    流程:running → (执行) → done/error,每步通过 ``canvas_events.publish``
    推 ``{type:"node_updated", canvas_id, node}`` 给 SSE 订阅者。执行逻辑复用
    ``app.agent.tools.run_canvas_node``,与 ``canvas_run_subgraph`` 工具一致。
    """
    _, n = _owned_node(cid, nid, user, session)

    # 1) 置 running + 推送(让前端立刻看到 running 状态)
    n.status = "running"
    n.error = ""
    n.updated_at = _now()
    session.add(n)
    session.commit()
    session.refresh(n)
    await _publish_event(cid, {
        "type": "node_updated", "canvas_id": cid, "node": _node_to_dict(n),
    })

    # 2) 执行(失败不抛出去,落 error 状态)
    try:
        _, media_events = await run_canvas_node(n, pool, user, session)
        # 媒体产物收集到 payload.urls(与 canvas_run_subgraph 行为一致)
        if media_events:
            urls_collected: list[str] = []
            for ev in media_events:
                if isinstance(ev, dict) and ev.get("type") in (
                    "image", "video", "audio", "model3d"
                ):
                    urls_collected.extend(ev.get("urls") or [])
            if urls_collected:
                try:
                    p = json.loads(n.payload) if n.payload else {}
                except ValueError:
                    p = {}
                p["urls"] = urls_collected
                n.payload = json.dumps(p, ensure_ascii=False)
        n.status = "done"
    except Exception as e:  # noqa: BLE001 — 单节点失败不抛 500,落 error 状态
        n.status = "error"
        n.error = str(e)[:500]

    # 3) 落库 + 推送最终状态
    n.updated_at = _now()
    session.add(n)
    session.commit()
    session.refresh(n)
    await _publish_event(cid, {
        "type": "node_updated", "canvas_id": cid, "node": _node_to_dict(n),
    })
    return _node_dict(n)


# ---------------------------------------------------------------------------
# SSE 事件流
# ---------------------------------------------------------------------------
@router.get("/canvas/{cid}/events")
async def canvas_events(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """SSE 事件流:M1.1 每 15s 推心跳,M1.2 起 Agent 工具会通过事件总线推节点变更。

    EventSource 不支持自定义 header,JWT 通过 ``?token=`` 查询参数传
    (见 deps.get_current_user)。
    """
    _owned_canvas(cid, user, session)

    async def stream():
        """事件流主体:订阅事件总线 + 周期性心跳。

        M1.1 没有任何代码调用 publish,所以只会发心跳;M1.2 起 Agent 工具会
        通过 ``canvas_events.publish`` 推送 ``node_added`` / ``node_updated`` 等
        事件,本流会自动转发给所有订阅者。
        """
        # 先订阅事件总线,再发首字节 —— 否则如果在 yield 之后才订阅,
        # 客户端在收到 ``: connected`` 后立即 publish 的事件会因订阅未建立而丢失。
        queue = subscribe_queue(cid)
        try:
            # 先发一个 SSE 注释行(: 开头,客户端 EventSource 自动忽略),
            # 让响应头立即返回 —— 否则要等 15s 心跳才发首字节,部分客户端/代理会缓冲。
            yield {"comment": "connected"}
            while True:
                try:
                    # 15s 内有事件就发,否则发心跳保活
                    event = await asyncio.wait_for(
                        queue.get(), timeout=_HEARTBEAT_SEC
                    )
                    yield {"data": json.dumps(event, ensure_ascii=False)}
                except asyncio.TimeoutError:
                    yield {"data": json.dumps({"type": "heartbeat"}, ensure_ascii=False)}
        finally:
            # SSE 关闭(客户端断开/服务取消)时清理订阅,防内存泄漏
            unsubscribe_queue(cid, queue)

    return EventSourceResponse(stream())


# ---------------------------------------------------------------------------
# M2: 画布子图 ↔ ComfyUI API JSON 双向桥
# ---------------------------------------------------------------------------
class RunSubgraphBody(BaseModel):
    timeout: float = Field(default=320.0, ge=10.0, le=600.0)
    # 执行完成后是否把产物自动 pin 为画布节点(默认开;前端子图执行体验闭环)
    auto_pin: bool = True
    # M3.3:选中执行的节点 id 子集;None/空 = 整张画布(向后兼容)
    node_ids: list[str] | None = None


class ImportWorkflowBody(BaseModel):
    template_id: str | None = Field(default=None, max_length=128)
    graph: dict | None = None
    format: str = Field(default="api", pattern="^(api|ui)$")
    base_position_x: float = 0.0
    base_position_y: float = 0.0


@router.post("/canvas/{cid}/run_subgraph")
async def run_subgraph(
    cid: str,
    body: RunSubgraphBody,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """把画布子图编译为 ComfyUI prompt 并提交执行。

    子图须恰好含一个 comfy_workflow 节点(带 payload.graph),其余节点通过边
    作为输入透镜覆盖图中对应输入口。执行完成后返回产物文件列表。
    """
    _owned_canvas(cid, user, session)
    nodes = session.exec(select(CanvasNode).where(CanvasNode.canvas_id == cid)).all()
    edges = session.exec(select(CanvasEdge).where(CanvasEdge.canvas_id == cid)).all()

    # M3.3:选中执行 —— 只编译选中节点及其内部边(工作流节点须在选区内)
    if body.node_ids:
        picked = set(body.node_ids)
        nodes = [n for n in nodes if n.id in picked]
        edges = [e for e in edges if e.source in picked and e.target in picked]

    try:
        graph, report = canvas_subgraph_to_comfy_prompt(nodes, edges)
    except ValueError as e:
        # 子图结构不合法(无/多工作流节点、边标签无法解析等)→ 400 而非 500
        raise HTTPException(status_code=400, detail=str(e)) from e

    # M3.3:工作流节点状态机 —— running → done/error,每步推 SSE(前端进度可视化)
    wf_node = next(
        (n for n in nodes if n.id == report.get("workflow_node_id")), None
    )
    if wf_node is not None:
        wf_node.status = "running"
        wf_node.error = ""
        wf_node.updated_at = _now()
        session.add(wf_node)
        session.commit()
        session.refresh(wf_node)
        await _publish_event(cid, {
            "type": "node_updated", "canvas_id": cid, "node": _node_to_dict(wf_node),
        })

    # 提取所需模型(按图中 loader 节点)
    req: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ctype = node.get("class_type", "")
        if ctype in ("CheckpointLoaderSimple", "UNETLoader"):
            val = (node.get("inputs") or {}).get("ckpt_name") or (node.get("inputs") or {}).get("unet_name")
            if isinstance(val, str):
                req.add(val)
        if ctype == "VAELoader":
            val = (node.get("inputs") or {}).get("vae_name")
            if isinstance(val, str):
                req.add(val)

    try:
        client = await pool.pick(required=req)
    except ComfyUIError as e:
        await _finish_wf_node(session, cid, wf_node, "error", f"无可用 worker: {e}")
        raise HTTPException(status_code=503, detail=f"无可用 worker: {e}") from e

    prompt_id = await client.queue_prompt(graph, uuid.uuid4().hex)
    _record(session, user, prompt_id, client.base_url, "canvas_subgraph", report.get("workflow_node_id", "")[:200], 0)

    files = await _wait_files(client, prompt_id, timeout=body.timeout)
    if not files:
        await _finish_wf_node(session, cid, wf_node, "error", "工作流执行超时")
        raise HTTPException(status_code=504, detail="工作流执行超时")
    urls = [_url(client.base_url, f) for f in files]

    # M3.1: 执行完成后自动把产物 pin 为画布节点(按扩展名归类,一种类型一个节点)
    pinned: list[dict] = []
    if body.auto_pin:
        pinned = await _pin_result_nodes(cid, nodes, report, files, urls, session)

    await _finish_wf_node(session, cid, wf_node, "done", "")
    return {
        "prompt_id": prompt_id,
        "worker": client.base_url,
        "report": report,
        "files": files,
        "urls": urls,
        "pinned": pinned,
    }


async def _finish_wf_node(
    session: Session,
    cid: str,
    wf_node: CanvasNode | None,
    status: str,
    error: str,
) -> None:
    """run_subgraph 收尾:置工作流节点最终状态并推 SSE。"""
    if wf_node is None:
        return
    wf_node.status = status
    wf_node.error = error[:500]
    wf_node.updated_at = _now()
    session.add(wf_node)
    session.commit()
    session.refresh(wf_node)
    await _publish_event(cid, {
        "type": "node_updated", "canvas_id": cid, "node": _node_to_dict(wf_node),
    })


# 自动 pin 节点布局:相对工作流节点右侧偏移,多类型纵向级联
_PIN_OFFSET_X = 420.0
_PIN_GAP_Y = 240.0


async def _pin_result_nodes(
    cid: str,
    canvas_nodes: list[CanvasNode],
    report: dict,
    files: list[dict],
    urls: list[str],
    session: Session,
) -> list[dict]:
    """把 run_subgraph 产物按类型 pin 为画布节点,并推 SSE node_added。

    - 按文件扩展名归类(image/video/audio),一种类型一个节点;
    - 位置:工作流节点右侧 _PIN_OFFSET_X,多类型按 _PIN_GAP_Y 纵向级联;
    - parent_ids 指向工作流节点(版本树可追溯);
    - 返回 pinned 节点 dict 列表(供 REST 响应 + 测试断言)。
    """
    wf_id = report.get("workflow_node_id") or ""
    wf_node = next((n for n in canvas_nodes if n.id == wf_id), None)
    base_x = (wf_node.position_x if wf_node else 0.0) + _PIN_OFFSET_X
    base_y = wf_node.position_y if wf_node else 0.0
    wf_title = (wf_node.title if wf_node else "") or "工作流"

    # 按类型分组,保持文件原始顺序
    grouped: dict[str, list[str]] = {}
    for f, u in zip(files, urls):
        fname = str(f.get("filename") or "")
        ext = fname.rsplit(".", 1)[-1].lower() if "." in fname else ""
        kind = _MEDIA_BY_EXT.get(ext)
        if not kind:
            continue
        grouped.setdefault(kind, []).append(u)
    if not grouped:
        return []

    pinned: list[dict] = []
    for i, (kind, kind_urls) in enumerate(grouped.items()):
        node = CanvasNode(
            canvas_id=cid,
            kind=kind,
            title=f"{wf_title} · {kind} 产物",
            position_x=base_x,
            position_y=base_y + i * _PIN_GAP_Y,
            payload=json.dumps({"urls": kind_urls}, ensure_ascii=False),
            status="done",
            parent_ids=json.dumps([wf_id] if wf_id else [], ensure_ascii=False),
        )
        session.add(node)
        session.commit()
        session.refresh(node)
        node_dict = _node_to_dict(node)
        pinned.append(node_dict)
        await _publish_event(cid, {
            "type": "node_added", "canvas_id": cid, "node": node_dict,
        })
    return pinned


_WORKFLOW_DIR = Path(__file__).parent.parent / "workflows"

# O2:模板列表缓存 —— 目录内容签名(文件名+mtime)变化时才重新解析,
# 避免每次请求都读盘 + UI→API 全量转换(5 个模板转换约数十 ms)。
_template_cache: tuple[tuple, list[dict]] | None = None


def _workflow_dir_signature() -> tuple:
    """模板目录内容签名:(文件名, mtime_ns) 排序元组;目录不存在时为空元组。"""
    try:
        return tuple(
            sorted(
                (fp.name, fp.stat().st_mtime_ns)
                for fp in _WORKFLOW_DIR.glob("*.json")
            )
        )
    except OSError:
        return ()


def _list_workflow_templates() -> list[dict]:
    """扫描内置工作流模板,返回元数据 + API 格式 prompt(用于画布导入)。

    带内容签名缓存:模板文件不变时直接返回上次结果(进程内共享,只读使用)。
    """
    global _template_cache
    sig = _workflow_dir_signature()
    if _template_cache is not None and _template_cache[0] == sig:
        return _template_cache[1]
    templates = []
    for fp in sorted(_WORKFLOW_DIR.glob("*.json")):
        if fp.name.startswith("_"):
            continue
        try:
            ui_data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception:
            continue
        nid = fp.stem
        # 推断标签
        node_types = {n.get("type") for n in ui_data.get("nodes", [])}
        tags = []
        if "CheckpointLoaderSimple" in node_types or "UNETLoader" in node_types:
            tags.append("基础模型")
        if "LoadImage" in node_types:
            tags.append("图生图")
        if "EmptyLTXVLatentVideo" in node_types or "LTXVImgToVideo" in node_types:
            tags.append("视频")
        if "VHS_VideoCombine" in node_types:
            tags.append("VHS")
        # UI 格式转 API 格式
        try:
            api_prompt = comfy_ui_graph_to_api(ui_data)
        except Exception:
            api_prompt = {}
        templates.append({
            "id": nid,
            "name": _human_template_name(nid),
            "description": _human_template_desc(nid),
            "kind_hint": _infer_kind_hint(node_types),
            "tags": tags,
            "node_count": len(ui_data.get("nodes", [])),
            "prompt": api_prompt,
        })
    _template_cache = (sig, templates)
    return templates


def _infer_kind_hint(node_types: set) -> str:
    """从 ComfyUI 节点类型集合推断模板的主产物类型(前端展示用)。"""
    if (
        "EmptyLTXVLatentVideo" in node_types
        or "LTXVImgToVideo" in node_types
        or "VHS_VideoCombine" in node_types
    ):
        return "video"
    if "LoadAudio" in node_types or "SaveAudio" in node_types or "VHS_LoadAudio" in node_types:
        return "audio"
    return "image"


def _human_template_name(nid: str) -> str:
    mapping = {
        "txt2img_basic": "文生图基础工作流",
        "img2img_basic": "图生图基础工作流",
        "ltx_txt2video": "LTX 文生视频(NSFW)",
        "ltx_img2video": "LTX 图生视频(NSFW)",
        "ltx_lipsync": "LTX 口型同步(NSFW)",
    }
    return mapping.get(nid, nid.replace("_", " ").title())


def _human_template_desc(nid: str) -> str:
    mapping = {
        "txt2img_basic": "Checkpoint + CLIP 正负提示词 + KSampler + 保存图片。适合快速验证模型/提示词。",
        "img2img_basic": "加载图片 + VAEEncode + KSampler(denoise 0.75) 重绘。适合风格迁移/局部重绘。",
        "ltx_txt2video": "10eros_v14 + Gemma 3 12B + ltx_vae,768×384@97帧。NSFW 视频生成专用。",
        "ltx_img2video": "首帧引导 + 10eros_v14 + Gemma 3 12B,图生视频(NSFW)。",
        "ltx_lipsync": "图生视频 + 参考音频驱动,10eros_v14 + mmaudio 音频 VAE(NSFW)。",
    }
    return mapping.get(nid, "")


@router.get("/canvas/workflows/templates")
async def list_workflow_templates() -> dict:
    """列出可用 ComfyUI 工作流模板(含 API 格式 prompt,可直接导入画布)。"""
    return {"items": _list_workflow_templates()}


@router.post("/canvas/{cid}/import_workflow")
async def import_workflow(
    cid: str,
    body: ImportWorkflowBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """把 ComfyUI 工作流模板导入画布为子图。

    支持两种方式:
    - 传 template_id:从内置模板文件读取(UI 格式自动转 API 格式)
    - 传 graph:直接提供 API 格式 dict

    导入后创建一个 comfy_workflow 节点 + 提取出的 prompt/image/audio 节点,
    并建立边连接。返回新增节点和边的列表。
    """
    _owned_canvas(cid, user, session)

    # 获取 API 格式 prompt
    if body.template_id:
        fp = _WORKFLOW_DIR / f"{body.template_id}.json"
        if not fp.exists() or fp.name.startswith("_"):
            raise HTTPException(status_code=404, detail="模板不存在")
        try:
            ui_data = json.loads(fp.read_text(encoding="utf-8"))
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"读取模板失败: {exc}") from exc
        if body.format == "ui":
            try:
                prompt = comfy_ui_graph_to_api(ui_data)
            except Exception as exc:
                raise HTTPException(status_code=400, detail=f"UI 格式转换失败: {exc}") from exc
        else:
            # 即使传 api,如果文件本身就是 UI 格式也自动转换
            if "nodes" in ui_data and "links" in ui_data:
                try:
                    prompt = comfy_ui_graph_to_api(ui_data)
                except Exception as exc:
                    raise HTTPException(status_code=400, detail=f"UI 格式转换失败: {exc}") from exc
            else:
                prompt = ui_data
    elif body.graph:
        prompt = body.graph
    else:
        raise HTTPException(status_code=400, detail="template_id 或 graph 必填其一")

    # 生成画布子图规格
    try:
        nodes_spec, edges_spec = comfy_prompt_to_canvas_subgraph(
            prompt,
            canvas_id=cid,
            base_position=(body.base_position_x, body.base_position_y),
            title=_human_template_name(body.template_id or "custom"),
        )
    except ValueError as e:
        # prompt 结构不合法(空/缺 class_type 等)→ 400 而非 500
        raise HTTPException(status_code=400, detail=str(e)) from e

    # 持久化:先创建节点,再映射 ref → 真实 id,最后创建边
    ref_to_id: dict[str, str] = {}
    created_nodes: list[dict] = []
    for ns in nodes_spec:
        n = CanvasNode(
            canvas_id=cid,
            kind=ns["kind"],
            title=ns["title"],
            position_x=ns["position_x"],
            position_y=ns["position_y"],
            payload=json.dumps(ns["payload"], ensure_ascii=False),
        )
        session.add(n)
        session.commit()
        session.refresh(n)
        ref_to_id[ns["ref"]] = n.id
        created_nodes.append(_node_dict(n))

    created_edges: list[dict] = []
    for es in edges_spec:
        src_id = ref_to_id.get(es["source_ref"])
        tgt_id = ref_to_id.get(es["target_ref"])
        if not src_id or not tgt_id:
            continue
        e = CanvasEdge(
            canvas_id=cid,
            source=src_id,
            target=tgt_id,
            label=es["label"],
        )
        session.add(e)
        session.commit()
        session.refresh(e)
        created_edges.append(_edge_dict(e))

    # O4.2:推 SSE(前端契约声明节点经 node_added/edge_added 落画布;
    # 此前只落库不推事件 → 导入后画布上看不到,刷新才出现)
    for nd in created_nodes:
        await _publish_event(cid, {"type": "node_added", "canvas_id": cid, "node": nd})
    for ed in created_edges:
        await _publish_event(cid, {"type": "edge_added", "canvas_id": cid, "edge": ed})

    # 响应契约对齐前端 api.ts importWorkflow:{node_ids, edge_ids, count}
    return {
        "node_ids": [n["id"] for n in created_nodes],
        "edge_ids": [e["id"] for e in created_edges],
        "count": len(created_nodes),
    }
