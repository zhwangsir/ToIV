"""GET /api/jobs/{prompt_id}/events —— SSE 转发 ComfyUI 进度，完成时回推图片 URL。

后端用 client_id 连 ComfyUI 的 WebSocket，把 progress 事件转成 SSE 推给前端；
执行结束后查 history 取图片引用，推 done 事件（含经后端代理的图片 URL）。
"""
from __future__ import annotations

import json

import websockets
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import mark_status, record_result
from app.db import get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User

router = APIRouter()


def _worker_dep(worker: str) -> ComfyUIClient:
    return resolve_worker(worker)


@router.get("/jobs")
def list_jobs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """当前用户的作业历史(最新在前)。"""
    stmt = select(Job).where(Job.user_id == user.id)
    # R18 软门槛:用户未开时服务端强制剔除成人向作品(Job.nsfw==True)。
    if not user.nsfw_enabled:
        stmt = stmt.where(Job.nsfw == False)  # noqa: E712  SQLModel 需 == 比较生成 SQL
    rows = session.exec(stmt.order_by(Job.created_at.desc()).limit(50)).all()
    return [
        {
            "id": j.id,
            "prompt_id": j.prompt_id,
            "kind": j.kind,
            "status": j.status,
            "prompt": j.prompt,
            "seed": j.seed,
            "created_at": j.created_at.isoformat(),
            "results": json.loads(j.result) if j.result else [],
        }
        for j in rows
    ]


async def _emit_done(client: ComfyUIClient, prompt_id: str) -> dict:
    urls = await record_result(client, prompt_id)
    return {"event": "done", "data": json.dumps({"images": urls})}


@router.get("/jobs/{prompt_id}/events")
async def job_events(
    prompt_id: str,
    client_id: str,
    request: Request,
    client: ComfyUIClient = Depends(_worker_dep),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # 租户隔离:本作业必须属于当前用户的租户
    job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
    if job and job.tenant_id != user.tenant_id:
        raise HTTPException(status_code=403, detail="无权访问该作业")

    async def stream():
        # 防竞态：若任务在 WS 连接前已完成，直接回推结果
        try:
            if await client.get_result_files(prompt_id):
                yield await _emit_done(client, prompt_id)
                return
        except ComfyUIError:
            pass  # history 还没准备好，转入 WS 监听

        try:
            async with websockets.connect(client.ws_url(client_id), max_size=None) as ws:
                async for raw in ws:
                    if await request.is_disconnected():
                        break
                    if isinstance(raw, (bytes, bytearray)):
                        continue  # 预览图二进制帧，P0 忽略
                    msg = json.loads(raw)
                    mtype, data = msg.get("type"), msg.get("data", {})

                    if mtype == "progress":
                        yield {"event": "progress", "data": json.dumps({"value": data.get("value"), "max": data.get("max")})}
                    elif mtype == "executing" and data.get("node") is None and data.get("prompt_id") == prompt_id:
                        yield await _emit_done(client, prompt_id)
                        break
                    elif mtype == "execution_error" and data.get("prompt_id") == prompt_id:
                        mark_status(prompt_id, "error")
                        yield {"event": "error", "data": json.dumps({"message": data.get("exception_message", "执行失败")})}
                        break
        except (OSError, ComfyUIError, websockets.WebSocketException) as e:
            _mark_status(prompt_id, "error")
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(stream())
