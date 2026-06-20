"""GET /api/jobs/{prompt_id}/events —— SSE 转发 ComfyUI 进度，完成时回推图片 URL。

后端用 client_id 连 ComfyUI 的 WebSocket，把 progress 事件转成 SSE 推给前端；
执行结束后查 history 取图片引用，推 done 事件（含经后端代理的图片 URL）。
"""
from __future__ import annotations

import json
from urllib.parse import urlencode

import websockets
from fastapi import APIRouter, Depends, Request
from sse_starlette.sse import EventSourceResponse

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.deps import resolve_worker

router = APIRouter()


def _worker_dep(worker: str) -> ComfyUIClient:
    return resolve_worker(worker)


def _image_url(worker: str, image: dict) -> str:
    return f"/api/images?{urlencode({**image, 'worker': worker})}"


async def _emit_done(client: ComfyUIClient, prompt_id: str) -> dict:
    images = await client.get_images(prompt_id)
    return {"event": "done", "data": json.dumps({"images": [_image_url(client.base_url, im) for im in images]})}


@router.get("/jobs/{prompt_id}/events")
async def job_events(
    prompt_id: str,
    client_id: str,
    request: Request,
    client: ComfyUIClient = Depends(_worker_dep),
):
    async def stream():
        # 防竞态：若任务在 WS 连接前已完成，直接回推结果
        try:
            if await client.get_images(prompt_id):
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
                        yield {"event": "error", "data": json.dumps({"message": data.get("exception_message", "执行失败")})}
                        break
        except (OSError, ComfyUIError, websockets.WebSocketException) as e:
            yield {"event": "error", "data": json.dumps({"message": str(e)})}

    return EventSourceResponse(stream())
