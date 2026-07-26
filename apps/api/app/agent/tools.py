"""智能体工具:文字驱动地调用 ComfyUI 生成能力 + 查询模型 + 画布操作。

每个执行器返回 (给 LLM 的文字结果, 推给前端的媒体事件列表)。
"""
from __future__ import annotations

import asyncio
import json
import random
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
from app.workflows.hunyuan3d import Hunyuan3DParams, build_hunyuan3d_graph
from app.workflows.img2img import Img2ImgParams, build_img2img_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph
from app.workflows.wan_i2v import WanI2VParams, build_wan_i2v_graph

# 画布事件总线(M1.1 产出)。未就位时 no-op 占位,不影响其他工具与测试。
# TODO: M1.1 待对接 —— app/canvas_events.py 由 M1.1 提供,接口 publish(canvas_id, event) async
try:
    from app import canvas_events  # type: ignore
except ImportError:
    canvas_events = None  # type: ignore[assignment]

# 画布节点 kind 枚举(与 models.CanvasNode.kind 注释对齐,10 种)
_CANVAS_NODE_KINDS = [
    "text", "prompt", "image", "video", "audio",
    "model3d", "llm", "comfy_workflow", "tts", "asr",
]

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
            "name": "edit_image",
            "description": "对用户上传的图片做重绘/编辑(图生图)。仅当用户本轮上传了图片、且想修改它(换风格/改细节/重绘)时调用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "想要的画面/修改方向,英文效果最佳"},
                    "strength": {"type": "number", "description": "重绘强度 0-1,越大改动越大;默认 0.6(0.4 轻改/0.8 大改)"},
                },
                "required": ["prompt"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_3d",
            "description": "生成可旋转查看的 3D 模型(GLB)。用户想要 3D/模型/手办时调用。若本轮上传了图片则直接用该图转 3D;否则先按描述出图再转 3D。耗时约 1-3 分钟。",
            "parameters": {
                "type": "object",
                "properties": {
                    "prompt": {"type": "string", "description": "无上传图时,用于先出底图的描述(英文最佳)。有上传图时可省略"},
                },
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
    # —— 画布操作工具(M1.2):仅在 canvas_id 上下文生效,canvas_id 由 runner 注入 ——
    {
        "type": "function",
        "function": {
            "name": "canvas_inspect",
            "description": "列出当前画布所有节点(摘要:id/kind/title/status),用于了解画布现状。canvas_id 由系统自动注入,无需传入。",
            "parameters": {"type": "object", "properties": {}},
        },
    },
    {
        "type": "function",
        "function": {
            "name": "canvas_add_node",
            "description": "在当前画布上添加一个节点。kind 决定 payload 结构(详见 CanvasNode 注释),canvas_id 由系统自动注入。",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": _CANVAS_NODE_KINDS,
                        "description": "节点类型",
                    },
                    "title": {"type": "string", "description": "节点标题(可选,前端节点卡片顶部显示)"},
                    "payload": {
                        "type": "object",
                        "description": "节点负载,结构随 kind 变化(如 image:{urls:[...]}, prompt:{text,negative?}, tts:{text,ref_audio?} 等)",
                    },
                    "position": {
                        "type": "object",
                        "properties": {
                            "x": {"type": "number"},
                            "y": {"type": "number"},
                        },
                        "description": "节点坐标(可选,缺省由后端随机散布,前端可拖动)",
                    },
                },
                "required": ["kind"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "canvas_connect_nodes",
            "description": "在当前画布上连接两个节点(源→目标),可加边标签(如 'prompt'/'image')。canvas_id 由系统自动注入。",
            "parameters": {
                "type": "object",
                "properties": {
                    "source_id": {"type": "string", "description": "源节点 id"},
                    "target_id": {"type": "string", "description": "目标节点 id"},
                    "label": {"type": "string", "description": "边标签(可选)"},
                },
                "required": ["source_id", "target_id"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "canvas_run_subgraph",
            "description": "运行画布上的若干节点:按 kind 触发对应执行器(image→生成图、tts→调 TTS、llm→调 LLM、prompt/text→返回文本),执行完更新节点 status/payload。耗时较长,会流式产出媒体事件。",
            "parameters": {
                "type": "object",
                "properties": {
                    "node_ids": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "要运行的节点 id 列表",
                    },
                },
                "required": ["node_ids"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "canvas_pin_result",
            "description": "把上一步生成的结果(图/视频/音频/3D)固定为画布节点,便于后续引用、迭代或重用。",
            "parameters": {
                "type": "object",
                "properties": {
                    "kind": {
                        "type": "string",
                        "enum": ["image", "video", "audio", "model3d"],
                        "description": "产物类型",
                    },
                    "urls": {
                        "type": "array",
                        "items": {"type": "string"},
                        "description": "产物 URL 列表",
                    },
                    "title": {"type": "string", "description": "节点标题(可选)"},
                    "parent_id": {"type": "string", "description": "父节点 id(可选,用于版本树/迭代精修)"},
                },
                "required": ["kind", "urls"],
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


def _client_for(pool: WorkerPool, base_url: str):
    """按 base_url 在池内找 client(白名单内才用,防 SSRF)。"""
    norm = (base_url or "").rstrip("/")
    return next((c for c in pool.clients if c.base_url == norm), None)


# —— 画布工具辅助(M1.2)——

def _node_to_dict(node) -> dict:
    """CanvasNode 序列化为前端友好的 dict(payload/parent_ids 已解析)。"""
    try:
        payload = json.loads(node.payload) if node.payload else {}
    except (ValueError, TypeError):
        payload = {}
    try:
        parent_ids = json.loads(node.parent_ids) if node.parent_ids else []
    except (ValueError, TypeError):
        parent_ids = []
    return {
        "id": node.id,
        "canvas_id": node.canvas_id,
        "kind": node.kind,
        "title": node.title,
        "position": {"x": node.position_x, "y": node.position_y},
        "width": node.width,
        "height": node.height,
        "payload": payload,
        "status": node.status,
        "error": node.error,
        "parent_ids": parent_ids,
        "created_at": node.created_at.isoformat() if node.created_at else None,
        "updated_at": node.updated_at.isoformat() if node.updated_at else None,
    }


async def _publish_canvas_event(canvas_id: str, event: dict) -> None:
    """发布画布事件到进程内事件总线(M1.1 canvas_events 未就位时 no-op)。

    事件总线故障不应影响工具主流程,异常一律吞掉。
    """
    if canvas_events is None or not canvas_id:
        return
    try:
        await canvas_events.publish(canvas_id, event)  # type: ignore[attr-defined]
    except Exception:
        pass


async def _tts_synth_for_canvas(text: str, ref_audio: str | None = None) -> str:
    """画布 TTS 节点执行器:调 TTS 服务合成语音,落本地 manju 目录,返回 URL。

    复用 voice.py 的契约(IndexTTS2 /tts form {text, emo_text?, emo_alpha?, language?, ref_audio?});
    ref_audio 仅允许相对路径或白名单来源(防 SSRF),失败时退默认音色不阻断。
    """
    import httpx  # 局部导入:仅 TTS 节点路径需要

    from app.storage import content_subdir

    settings = get_settings()
    tts_target = settings.tts_url.rstrip("/")
    voice_dir = content_subdir("manju")
    voice_dir.mkdir(parents=True, exist_ok=True)

    data: dict[str, str] = {"text": text}
    files = None
    async with httpx.AsyncClient(timeout=180.0, follow_redirects=True, trust_env=False) as client:
        if ref_audio:
            try:
                from app.routes.voice import _allowed_ref, _resolve_url

                if _allowed_ref(ref_audio):
                    rr = await client.get(_resolve_url(ref_audio))
                    rr.raise_for_status()
                    files = {"ref_audio": ("ref.wav", rr.content, "audio/wav")}
            except Exception:
                # 参考音获取失败 → 退默认音色,不阻断 TTS
                files = None
        resp = await client.post(tts_target + "/tts", data=data, files=files)

    if resp.status_code != 200 or not resp.content or resp.content[:4] != b"RIFF":
        raise RuntimeError(f"TTS 合成失败(status={resp.status_code})")

    name = f"voice-{uuid.uuid4().hex}.wav"
    (voice_dir / name).write_bytes(resp.content)
    return f"/api/manju/voice/{name}"


async def run_canvas_node(
    node, pool: WorkerPool, user: User, session
) -> tuple[str, list[dict]]:
    """根据 CanvasNode.kind 路由到对应执行器,返回 (给 LLM 的文字, 媒体事件列表)。

    供 REST 端点(``POST /api/canvas/{cid}/run/{nid}``)与 Agent 工具
    (``canvas_run_subgraph``)共用,避免执行逻辑重复实现。

    支持 kind:image(复用 generate_image)、tts(调 TTS 服务)、llm(调 llm.chat)、
    prompt/text(返回文本)。其余 kind 暂不支持自动执行,返回提示给 LLM。
    """
    try:
        payload = json.loads(node.payload) if node.payload else {}
    except ValueError:
        payload = {}

    kind = node.kind

    if kind == "image":
        prompt_text = (
            payload.get("text") or payload.get("prompt") or node.title
            or "a beautiful image"
        )
        return await execute(
            "generate_image",
            {"prompt": prompt_text},
            pool, user, session,
        )

    if kind == "tts":
        text = payload.get("text") or node.title
        if not text:
            return "TTS 节点缺少 text", []
        url = await _tts_synth_for_canvas(text, payload.get("ref_audio"))
        payload["url"] = url
        node.payload = json.dumps(payload, ensure_ascii=False)
        return f"已合成语音: {url}", [{"type": "audio", "urls": [url]}]

    if kind == "llm":
        from app.agent import llm

        text = payload.get("text") or ""
        if not text:
            return "LLM 节点缺少 text", []
        try:
            resp = await llm.chat([{"role": "user", "content": text}])
            content = resp.get("content") or ""
        except llm.LLMError as e:
            return f"LLM 调用失败: {e}", []
        payload["response"] = content
        node.payload = json.dumps(payload, ensure_ascii=False)
        return content, []

    if kind == "prompt":
        return f"提示词: {payload.get('text') or node.title}", []

    if kind == "text":
        return payload.get("text") or node.title or "(空文本)", []

    return f"kind={kind} 暂不支持自动执行(请手工配置或用 canvas_pin_result 固定产物)", []


# 向后兼容别名:tools.py 内部 canvas_run_subgraph 仍调 ``_run_canvas_node``。
# 新代码(REST 端点等)应直接用 ``run_canvas_node``。
_run_canvas_node = run_canvas_node


async def execute(
    name: str, args: dict, pool: WorkerPool, user: User, session,
    attachment: dict | None = None,
    canvas_id: str | None = None,
) -> tuple[str, list[dict]]:
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
        seconds = max(1.0, min(7.5, float(args.get("seconds") or 3)))
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

    if name == "edit_image":
        if not attachment or not attachment.get("filename"):
            return "请先在对话框上传一张图片,再让我编辑/重绘它。", []
        client = _client_for(pool, attachment.get("worker", ""))
        if client is None:
            return "上传图片所在的 worker 不可用,请重新上传图片。", []
        p = Img2ImgParams(
            positive=args["prompt"],
            image=attachment["filename"],
            negative="blurry, lowres, deformed, watermark",
            ckpt_name=settings.default_ckpt,
            denoise=max(0.1, min(1.0, float(args.get("strength") or 0.6))),
        )
        try:
            pid = await client.queue_prompt(build_img2img_graph(p), uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"图生图提交失败: {e}", []
        _record(session, user, pid, client.base_url, "agent_img2img", p.positive, p.seed)
        files = await _wait_files(client, pid)
        if not files:
            return "重绘超时,请稍后重试。", []
        urls = [_url(client.base_url, f) for f in files]
        return f"已按要求重绘并展示(强度 {p.denoise})。", [{"type": "image", "urls": urls}]

    if name == "generate_3d":
        threed_req = required_models("threed")
        if attachment and attachment.get("filename"):
            # 用上传图:取字节 → 转存到具备 3D 模型的 worker
            src = _client_for(pool, attachment.get("worker", ""))
            if src is None:
                return "上传图片所在 worker 不可用,请重新上传图片。", []
            try:
                client = await pool.pick(required=threed_req)
            except ComfyUIError as e:
                return f"暂无具备 3D 模型的 worker: {e}", []
            try:
                content, _ = await src.get_image_bytes(attachment["filename"], "", "input")
                input_name = await client.upload_image(content, attachment["filename"])
            except ComfyUIError as e:
                return f"源图转存失败: {e}", []
        else:
            prompt = args.get("prompt")
            if not prompt:
                return "请描述你想要的 3D 物体,或上传一张图片。", []
            try:
                client = await pool.pick(required={settings.default_ckpt} | threed_req)
            except ComfyUIError as e:
                return f"暂无同时具备出图+3D模型的 worker: {e}", []
            base = Txt2ImgParams(
                positive=prompt, negative="blurry, lowres, deformed, watermark",
                ckpt_name=settings.default_ckpt, width=768, height=768, steps=20,
            )
            try:
                bpid = await client.queue_prompt(build_txt2img_graph(base), uuid.uuid4().hex)
            except ComfyUIError as e:
                return f"3D 底图提交失败: {e}", []
            bfiles = await _wait_files(client, bpid, timeout=200)
            if not bfiles:
                return "3D 底图生成超时,请稍后重试。", []
            bf = bfiles[0]
            try:
                content, _ = await client.get_image_bytes(bf["filename"], bf.get("subfolder", ""), bf.get("type", "output"))
                input_name = await client.upload_image(content, bf["filename"])
            except ComfyUIError as e:
                return f"3D 底图转存失败: {e}", []
        tp = Hunyuan3DParams(image=input_name)
        try:
            tpid = await client.queue_prompt(build_hunyuan3d_graph(tp), uuid.uuid4().hex)
        except ComfyUIError as e:
            return f"3D 提交失败: {e}", []
        _record(session, user, tpid, client.base_url, "agent_3d", (args.get("prompt") or "image-to-3d")[:200], tp.seed)
        files = await _wait_files(client, tpid, timeout=400)
        if not files:
            return "3D 生成超时(Hunyuan3D 较慢),请稍后重试。", []
        glb = next((f for f in files if f["filename"].lower().endswith(".glb")), files[0])
        return "已生成 3D 模型并展示(可旋转查看)。", [{"type": "model3d", "urls": [_url(client.base_url, glb)]}]

    # —— 画布操作工具(M1.2):仅在 canvas_id 上下文生效 ——
    if name in ("canvas_inspect", "canvas_add_node", "canvas_connect_nodes",
                "canvas_run_subgraph", "canvas_pin_result"):
        if not canvas_id:
            return f"工具 {name} 需在画布上下文中调用(当前 canvas_id 为空)。", []
        from sqlmodel import select

        from app.models import CanvasEdge, CanvasNode

        if name == "canvas_inspect":
            nodes = session.exec(
                select(CanvasNode).where(CanvasNode.canvas_id == canvas_id)
            ).all()
            if not nodes:
                return "画布为空(尚无节点)。", []
            summary = "\n".join(
                f"- {n.id} [{n.kind}] {n.title or '(无标题)'} status={n.status}"
                for n in nodes
            )
            return f"画布现有 {len(nodes)} 个节点:\n{summary}", []

        if name == "canvas_add_node":
            kind = args.get("kind")
            if kind not in _CANVAS_NODE_KINDS:
                return f"非法 kind: {kind}(允许: {_CANVAS_NODE_KINDS})", []
            pos = args.get("position") or {}
            px = pos.get("x") if isinstance(pos, dict) else None
            py = pos.get("y") if isinstance(pos, dict) else None
            node = CanvasNode(
                canvas_id=canvas_id,
                kind=kind,
                title=args.get("title") or "",
                position_x=float(px) if px is not None else random.uniform(0, 800),
                position_y=float(py) if py is not None else random.uniform(0, 600),
                payload=json.dumps(args.get("payload") or {}, ensure_ascii=False),
                status="idle",
            )
            session.add(node)
            session.commit()
            session.refresh(node)
            node_ev = {"type": "node_added", "node": _node_to_dict(node)}
            await _publish_canvas_event(canvas_id, node_ev)
            return f"已在画布添加 {kind} 节点(id={node.id})。", [node_ev]

        if name == "canvas_connect_nodes":
            sid, tid = args.get("source_id"), args.get("target_id")
            if not sid or not tid:
                return "source_id 和 target_id 都必填。", []
            src = session.get(CanvasNode, sid)
            tgt = session.get(CanvasNode, tid)
            if not src or src.canvas_id != canvas_id:
                return f"源节点 {sid} 不存在或不属于当前画布。", []
            if not tgt or tgt.canvas_id != canvas_id:
                return f"目标节点 {tid} 不存在或不属于当前画布。", []
            edge = CanvasEdge(
                canvas_id=canvas_id, source=sid, target=tid,
                label=args.get("label") or "",
            )
            session.add(edge)
            session.commit()
            session.refresh(edge)
            edge_ev = {
                "type": "edge_added",
                "edge": {
                    "id": edge.id, "source": edge.source, "target": edge.target,
                    "label": edge.label,
                },
            }
            await _publish_canvas_event(canvas_id, edge_ev)
            return f"已连接 {sid} → {tid}。", []

        if name == "canvas_pin_result":
            kind = args.get("kind")
            if kind not in ("image", "video", "audio", "model3d"):
                return f"非法 kind: {kind}(允许: image/video/audio/model3d)", []
            urls = args.get("urls") or []
            if not isinstance(urls, list) or not urls:
                return "urls 必填且为非空数组。", []
            parent_id = args.get("parent_id")
            parent_ids = [parent_id] if parent_id else []
            node = CanvasNode(
                canvas_id=canvas_id,
                kind=kind,
                title=args.get("title") or f"已固定 {kind}",
                position_x=random.uniform(0, 800),
                position_y=random.uniform(0, 600),
                payload=json.dumps({"urls": urls}, ensure_ascii=False),
                status="done",
                parent_ids=json.dumps(parent_ids, ensure_ascii=False),
            )
            session.add(node)
            session.commit()
            session.refresh(node)
            node_ev = {"type": "node_added", "node": _node_to_dict(node)}
            await _publish_canvas_event(canvas_id, node_ev)
            return f"已把 {len(urls)} 个 {kind} 产物固定为节点(id={node.id})。", [node_ev]

        if name == "canvas_run_subgraph":
            node_ids = args.get("node_ids") or []
            if not isinstance(node_ids, list) or not node_ids:
                return "node_ids 必填且非空。", []
            results: list[str] = []
            events: list[dict] = []
            for nid in node_ids:
                node = session.get(CanvasNode, nid)
                if not node or node.canvas_id != canvas_id:
                    results.append(f"{nid}: 节点不存在或不属于当前画布")
                    continue
                # 标记 running
                node.status = "running"
                node.error = ""
                session.add(node)
                session.commit()
                await _publish_canvas_event(
                    canvas_id, {"type": "node_updated", "node": _node_to_dict(node)}
                )
                try:
                    text, media_events = await _run_canvas_node(node, pool, user, session)
                    events.extend(media_events)
                    node.status = "done"
                    # 媒体产物落 payload.urls
                    if media_events:
                        urls_collected: list[str] = []
                        for ev in media_events:
                            if isinstance(ev, dict) and ev.get("type") in (
                                "image", "video", "audio", "model3d"
                            ):
                                urls_collected.extend(ev.get("urls") or [])
                        if urls_collected:
                            try:
                                p = json.loads(node.payload) if node.payload else {}
                            except ValueError:
                                p = {}
                            p["urls"] = urls_collected
                            node.payload = json.dumps(p, ensure_ascii=False)
                    session.add(node)
                    session.commit()
                    session.refresh(node)
                    await _publish_canvas_event(
                        canvas_id, {"type": "node_updated", "node": _node_to_dict(node)}
                    )
                    results.append(f"{nid}({node.kind}): {text}")
                except Exception as e:  # noqa: BLE001 — 单节点失败不阻断子图其余节点
                    node.status = "error"
                    node.error = str(e)[:500]
                    session.add(node)
                    session.commit()
                    session.refresh(node)
                    await _publish_canvas_event(
                        canvas_id, {"type": "node_updated", "node": _node_to_dict(node)}
                    )
                    results.append(f"{nid}({node.kind}): 执行失败 - {e}")
            return "子图执行完成:\n" + "\n".join(results), events

    return f"未知工具: {name}", []
