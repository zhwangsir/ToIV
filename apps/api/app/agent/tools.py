"""智能体工具:文字驱动地调用 ComfyUI 生成能力 + 查询模型。

每个执行器返回 (给 LLM 的文字结果, 推给前端的媒体事件列表)。
"""
from __future__ import annotations

import asyncio
import time
import uuid
from urllib.parse import urlencode

from app.agent.rag import get_kb
from app.capabilities import required_models
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.config import get_settings
from app.models import Job, User
from app.workflows.ace_step import AceStepParams, build_ace_step_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph

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
            "name": "generate_video",
            "description": "根据文字生成一段短视频(用户想要视频/动画/动起来时调用)。内部会先出底图再驱动其运动,耗时约 1-2 分钟。",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "画面与运动的描述,英文效果最佳"},
                    "seconds": {"type": "number", "description": "时长秒,默认 3(范围 1-6)"},
                },
                "required": ["prompt"],
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
    {
        "type": "function",
        "function": {
            "name": "search_knowledge",
            "description": "检索平台知识库(ComfyUI 节点/工作流配方/模型清单/提示词技巧)。搭自定义工作流前、或不确定模型名/参数/节点用法时先调用查证,避免编造。",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {"type": "string", "description": "要查的问题或关键词,如「文生图工作流模板」「img2img 怎么搭」「有哪些视频模型」"},
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_workflow",
            "description": "提交一张自定义的 ComfyUI API 格式工作流图并展示产物。用于标准工具(generate_image/video/music)满足不了的定制需求(指定 seed/批量/特定模型/特殊节点组合)。搭图前务必先 search_knowledge 查配方与真实模型名。",
            "parameters": {
                "type": "object",
                "properties": {
                    "graph": {
                        "type": "object",
                        "description": "ComfyUI API 格式:{节点id: {class_type, inputs}};节点间引用用 [\"id\", 输出序号]。需含一个 Save 类节点。",
                        "additionalProperties": True,
                    },
                    "summary": {"type": "string", "description": "一句话说明这张图做什么(给用户看)"},
                },
                "required": ["graph"],
            },
        },
    },
]

# 工作流里指向模型文件的输入键 → 用于挑选具备这些模型的 worker
_MODEL_INPUT_KEYS = {
    "ckpt_name", "unet_name", "lora_name", "vae_name", "clip_name",
    "control_net_name", "model_name", "style_model_name",
}


def _extract_required(graph: dict) -> set[str]:
    req: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        for key, val in (node.get("inputs") or {}).items():
            if key in _MODEL_INPUT_KEYS and isinstance(val, str):
                req.add(val)
    return req


_MEDIA_BY_EXT = {
    "png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "webp": "image",
    "mp4": "video", "webm": "video",
    "mp3": "audio", "flac": "audio", "wav": "audio", "ogg": "audio",
}


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

    if name == "generate_video":
        prompt = args["prompt"]
        seconds = max(1.0, min(6.0, float(args.get("seconds") or 3)))
        fps, vw, vh = 16, 640, 480
        frames = int(seconds * fps)
        length = max(9, min(121, frames - (frames % 4) + 1))  # Wan 需 4n+1 帧
        # 选一个同时具备「出底图 + Wan 视频」全部模型的 worker
        req = {settings.default_ckpt} | required_models("video")
        try:
            client = await pool.pick(required=req)
        except ComfyUIError as e:
            return f"暂无同时具备出图+视频模型的 worker: {e}", []
        # 1) 文生底图(视频首帧)
        base = Txt2ImgParams(
            positive=prompt,
            negative="blurry, lowres, deformed, watermark",
            ckpt_name=settings.default_ckpt,
            width=vw, height=vh, steps=20,
        )
        try:
            bpid = await client.queue_prompt(build_txt2img_graph(base), uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"视频底图提交失败: {e}", []
        base_files = await _wait_files(client, bpid, timeout=200)
        if not base_files:
            return "视频底图生成超时,请稍后重试。", []
        bf = base_files[0]
        # 2) 取底图字节 → 送进同一 worker 的 input 目录
        try:
            content, _ = await client.get_image_bytes(bf["filename"], bf.get("subfolder", ""), bf.get("type", "output"))
            input_name = await client.upload_image(content, bf["filename"])
        except ComfyUIError as e:
            return f"视频底图转存失败: {e}", []
        # 3) 图生视频(Wan 2.2 i2v)
        vp = WanI2VParams(positive=prompt, image=input_name, width=vw, height=vh, length=length, fps=fps)
        try:
            vpid = await client.queue_prompt(build_wan_i2v_graph(vp), uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"视频提交失败: {e}", []
        _record(session, user, vpid, client.base_url, "agent_video", prompt, vp.seed)
        vfiles = await _wait_files(client, vpid, timeout=320)
        if not vfiles:
            return "视频生成超时(Wan 14B 较慢),请稍后重试。", []
        urls = [_url(client.base_url, f) for f in vfiles]
        return f"已生成 {length} 帧短视频并展示给用户。", [{"type": "video", "urls": urls}]

    if name == "search_knowledge":
        chunks = await get_kb().retrieve(args.get("query") or "", k=4)
        if not chunks:
            return "知识库暂无相关内容(或检索暂不可用),请凭通用知识谨慎作答。", []
        return "知识库检索结果:\n\n" + "\n\n---\n\n".join(c.text for c in chunks), []

    if name == "run_workflow":
        graph = args.get("graph")
        if not isinstance(graph, dict) or not graph:
            return "graph 为空或格式不对(需 {节点id:{class_type,inputs}} 的 API 格式)。", []
        bad = [k for k, v in graph.items() if not (isinstance(v, dict) and v.get("class_type"))]
        if bad:
            return f"节点 {bad[:5]} 缺少 class_type,请修正后重试。", []
        req = _extract_required(graph)
        try:
            client = await pool.pick(required=req)
        except ComfyUIError as e:
            return f"暂无具备所需模型 {sorted(req)} 的 worker: {e}", []
        try:
            pid = await client.queue_prompt(graph, uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"工作流提交失败(图可能有误,请用 search_knowledge 核对节点/参数): {e}", []
        _record(session, user, pid, client.base_url, "agent_workflow", (args.get("summary") or "custom")[:200], 0)
        files = await _wait_files(client, pid, timeout=320)
        if not files:
            return "工作流执行超时或无产物,请确认图里含 Save 类节点(SaveImage/SaveAnimatedWEBP/SaveAudioMP3)。", []
        by_kind: dict[str, list[str]] = {}
        notes: list[str] = []
        for f in files:
            ext = f["filename"].rsplit(".", 1)[-1].lower() if "." in f["filename"] else ""
            kind = _MEDIA_BY_EXT.get(ext)
            if kind:
                by_kind.setdefault(kind, []).append(_url(client.base_url, f))
            else:
                notes.append(f"{f['filename']}({_url(client.base_url, f)})")
        events = [{"type": kind, "urls": urls} for kind, urls in by_kind.items()]
        msg = f"自定义工作流已执行,产出 {len(files)} 个文件并展示。"
        if notes:
            msg += " 非媒体产物(可下载): " + ", ".join(notes)
        return msg, events

    return f"未知工具: {name}", []
