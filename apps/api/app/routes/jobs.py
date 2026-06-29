"""GET /api/jobs/{prompt_id}/events —— SSE 转发 ComfyUI 进度，完成时回推图片 URL。

后端用 client_id 连 ComfyUI 的 WebSocket，把 progress 事件转成 SSE 推给前端；
执行结束后查 history 取图片引用，推 done 事件（含经后端代理的图片 URL）。
"""
from __future__ import annotations

import asyncio
import json

import websockets
from fastapi import APIRouter, Depends, HTTPException, Request
from sqlmodel import Session, select
from sse_starlette.sse import EventSourceResponse

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import mark_status, record_result
from app.config import get_settings
from app.db import engine, get_session
from app.deps import get_current_user, resolve_worker
from app.models import Job, User

router = APIRouter()


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


@router.delete("/jobs/{job_id}")
def delete_job(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """从作品库删除当前用户的一件作品(删库记录使其从作品库消失)。

    仅删自己的作业(user_id 校验);非本人/不存在一律 404(不泄露存在性)。
    产物文件留在 worker 输出目录(物理清理属另一关注点,不在此处理)。
    """
    job = session.exec(select(Job).where(Job.id == job_id)).first()
    if not job or job.user_id != user.id:
        raise HTTPException(status_code=404, detail="作品不存在")
    session.delete(job)
    session.commit()
    return {"ok": True, "id": job_id}


async def _emit_done(client: ComfyUIClient, prompt_id: str) -> dict:
    urls = await record_result(client, prompt_id)
    return {"event": "done", "data": json.dumps({"images": urls})}


async def _forge_stream(prompt_id: str, request: Request):
    """Forge 引擎作业的 SSE:轮询 sdapi 全局进度 + 监听进程内作业态(完成/出错)。

    Forge 同步出图无 WS / per-job 进度;ToIV 单实例串行,/sdapi/v1/progress 即当前任务。
    进程态(forge.engine._jobs)由后台出图 task 写;api 重启丢失则回落 DB Job。
    """
    from app.forge.client import ForgeClient, ForgeError
    from app.forge.engine import job_state

    fc = ForgeClient(get_settings().forge_base, timeout=12.0)
    while True:
        if await request.is_disconnected():
            return
        st = job_state(prompt_id)
        if st and st["status"] == "done":
            yield {"event": "done", "data": json.dumps({"images": st["images"]})}
            return
        if st and st["status"] == "error":
            yield {"event": "error", "data": json.dumps({"message": st.get("error") or "Forge 出图失败"})}
            return
        if st is None:
            # 进程态丢失(api 重启)→ 回落 DB
            with Session(engine) as s:
                db = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                if db and db.status == "done":
                    yield {"event": "done", "data": json.dumps({"images": json.loads(db.result or "[]")})}
                    return
                if db and db.status == "error":
                    yield {"event": "error", "data": json.dumps({"message": "Forge 出图失败"})}
                    return
        try:
            pr = await fc.progress()
            stt = pr.get("state") or {}
            step = int(stt.get("sampling_step") or 0)
            total = int(stt.get("sampling_steps") or 0)
            if total > 0:
                yield {"event": "progress", "data": json.dumps({"value": step, "max": total})}
        except ForgeError:
            pass
        await asyncio.sleep(0.6)


@router.get("/jobs/{prompt_id}/events")
async def job_events(
    prompt_id: str,
    client_id: str,
    worker: str,
    request: Request,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    # 租户隔离:本作业必须属于当前用户的租户
    job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
    if job and job.tenant_id != user.tenant_id:
        raise HTTPException(status_code=403, detail="无权访问该作业")

    # Forge 引擎作业:无 ComfyUI WS,改轮询 sdapi 进度 + 进程内作业态。
    settings = get_settings()
    if settings.forge_base and worker.rstrip("/") == settings.forge_base:
        return EventSourceResponse(_forge_stream(prompt_id, request))

    client = resolve_worker(worker)

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
