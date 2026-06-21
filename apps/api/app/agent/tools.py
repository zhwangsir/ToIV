"""智能体工具:文字驱动地调用 ComfyUI 生成能力 + 查询模型。

每个执行器返回 (给 LLM 的文字结果, 推给前端的媒体事件列表)。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from urllib.parse import urlencode

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.models import Job, User
from app.workflows.ace_step import AceStepParams, build_ace_step_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

_ASPECTS = {"1:1": (512, 512), "2:3": (512, 768), "3:2": (768, 512), "hd": (768, 768)}

TOOL_SCHEMAS = [
    {
        "type": "function",
        "function": {
            "name": "generate_image",
            "description": "根据文字提示词生成图片(用户想要图/画/海报/插画/照片等视觉内容时调用)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "画面描述,英文提示词效果最佳,含主体/风格/质量词"},
                    "negative": {"type": "string", "description": "不想出现的元素(可选)"},
                    "aspect": {"type": "string", "enum": ["1:1", "2:3", "3:2", "hd"], "description": "画幅,默认 1:1"},
                    "steps": {"type": "integer", "description": "采样步数,默认 20"},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_music",
            "description": "根据风格标签(可选歌词)生成原创音乐(用户想要音乐/BGM/歌曲时调用)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "tags": {"type": "string", "description": "风格/流派/乐器/节奏,如 lofi, chill, piano, 90bpm"},
                    "lyrics": {"type": "string", "description": "歌词(可选,留空=纯音乐)"},
                    "seconds": {"type": "number", "description": "时长秒,默认 30"},
                },
                "required": ["tags"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_models",
            "description": "列出当前可用的图像大模型(checkpoint)。用户询问有哪些模型/能力时调用。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
]


def _url(worker: str, f: dict) -> str:
    return f"/api/images?{urlencode({**f, 'worker': worker})}"


async def _wait_files(client, prompt_id: str, timeout: float = 200.0) -> list[dict]:
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            files = await client.get_result_files(prompt_id)
            if files:
                return files
        except ComfyUIError:
            pass
        await asyncio.sleep(1.5)
    return []


def _record(session, user: User, prompt_id: str, worker: str, kind: str, prompt: str, seed: int) -> None:
    try:
        session.add(Job(tenant_id=user.tenant_id, user_id=user.id, prompt_id=prompt_id,
                        worker=worker, kind=kind, status="done", prompt=prompt[:500], seed=seed))
        session.commit()
    except Exception:
        session.rollback()


async def execute(name: str, args: dict, pool: WorkerPool, user: User, session) -> tuple[str, list[dict]]:
    settings = get_settings()

    if name == "list_models":
        try:
            info = await pool.clients[0].object_info("CheckpointLoaderSimple")
            opts = info.get("CheckpointLoaderSimple", {}).get("input", {}).get("required", {}).get("ckpt_name", [[]])[0]
        except ComfyUIError:
            opts = []
        return "当前可用图像大模型: " + (", ".join(opts[:30]) or "(查询失败)"), []

    if name == "generate_image":
        w, h = _ASPECTS.get(args.get("aspect") or "1:1", (512, 512))
        p = Txt2ImgParams(
            positive=args["prompt"],
            negative=(args.get("negative") or "blurry, lowres, deformed, watermark"),
            ckpt_name=settings.default_ckpt,
            width=w, height=h,
            steps=int(args.get("steps") or 20),
        )
        graph = build_txt2img_graph(p)
        try:
            client = await pool.pick(required={p.ckpt_name})
        except ComfyUIError as e:
            return f"暂无可用的图像 worker: {e}", []
        try:
            pid = await client.queue_prompt(graph, uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"提交失败: {e}", []
        _record(session, user, pid, client.base_url, "agent_image", p.positive, p.seed)
        files = await _wait_files(client, pid)
        if not files:
            return "图片生成超时,请稍后重试。", []
        urls = [_url(client.base_url, f) for f in files]
        return f"已生成 {len(urls)} 张图片并展示给用户(seed={p.seed})。", [{"type": "image", "urls": urls}]

    if name == "generate_music":
        p = AceStepParams(
            tags=args["tags"],
            lyrics=(args.get("lyrics") or ""),
            seconds=float(args.get("seconds") or 30),
        )
        graph = build_ace_step_graph(p)
        try:
            client = await pool.pick(required={p.ckpt_name})
        except ComfyUIError as e:
            return f"暂无可用的音频 worker: {e}", []
        try:
            pid = await client.queue_prompt(graph, uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"提交失败: {e}", []
        _record(session, user, pid, client.base_url, "agent_audio", p.tags, p.seed)
        files = await _wait_files(client, pid)
        if not files:
            return "音乐生成超时,请稍后重试。", []
        urls = [_url(client.base_url, f) for f in files]
        return "已生成音乐并展示给用户。", [{"type": "audio", "urls": urls}]

    return f"未知工具: {name}", []
