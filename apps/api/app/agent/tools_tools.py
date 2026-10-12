"""V4-1 Agent 同构(2026-10-12):工具页域(音频/图片/视频剪辑/译制)。

对应 canvas 四个工具页(/toiv/audio、/toiv/image-tools、/toiv/video-tools、
/toiv/dub-tools)的后端能力;长任务走既有 Job 语义提交即回。

- synthesize_voice     TTS 配音(IndexTTS2,参考音克隆)
- separate_vocals      人声分离(Demucs 干声)
- transcribe_media     whisper 听写(音/视频→带时间轴分段;异步 Job)
- remove_background    智能去背景(通用/动漫/人物)
- upscale_image        高清增强(2x/4x)
- inpaint_region       局部重绘(文字描述区域)
- fix_faces            人脸修复
- qwen_edit_image      智能编辑(语义+相机控制)
- camera_360           3D 相机环绕(语义编辑特化)
- image_to_3d          图生 3D(GLB)
- render_video_edit    三轨剪辑成片(plan JSON)
- transcribe_dub       译制听写(与 transcribe_media 同链,dub 域)
- translate_segments   LLM 字幕翻译
- generate_voice_track 译制配音轨(克隆源音色;异步 Job)
- lipsync_long         译制对口型成片(分段 GPU;异步 Job)
"""
from __future__ import annotations

import json
import logging

from fastapi import HTTPException

from app.models import User

logger = logging.getLogger(__name__)

AUDIO_EXTS = ("mp3", "wav", "flac", "ogg", "m4a")


def _url_media(url: str) -> tuple[bytes, str]:
    """取回本站媒体字节(P-1:签名 URL 服务端自取一律 401 → 走 worker ComfyUI)。"""
    from app.comfy.client import ComfyUIError, get_image_bytes_any

    data, ct = get_image_bytes_any(url)
    return data, ct


def _err(prefix: str, e: Exception) -> tuple[str, list[dict]]:
    detail = getattr(e, "detail", None) or str(e)
    return f"{prefix}失败:{detail}", []


TOOL_SCHEMAS_TOOLPAGES = [
    {
        "type": "function",
        "function": {
            "name": "synthesize_voice",
            "description": (
                "TTS 配音:文本 → IndexTTS2 语音(约几十秒);voice_ref_url 传本站参考音"
                "则克隆该音色。返回音频地址。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "text": {"type": "string", "description": "台词文本(600 字内)"},
                    "emo_text": {"type": "string", "description": "情绪提示(可选)"},
                    "voice_ref_url": {"type": "string", "description": "参考音地址(可选,克隆音色)"},
                },
                "required": ["text"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "separate_vocals",
            "description": "人声分离:本站音频(Demucs)→ 干声 wav(去 BGM;可作克隆参考音)。",
            "parameters": {
                "type": "object",
                "properties": {"audio_url": {"type": "string", "description": "本站音频地址"}},
                "required": ["audio_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "transcribe_media",
            "description": "whisper 听写:本站音/视频 → 带时间轴的分段文本(异步 job_id,查 check_jobs;长视频数分钟)。",
            "parameters": {
                "type": "object",
                "properties": {"media_url": {"type": "string", "description": "本站音/视频地址"}},
                "required": ["media_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "remove_background",
            "description": "智能去背景:本站图片 → 透明底 cutout(mode: general/anime/human)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "mode": {"type": "string", "description": "general(默认)/anime/human"},
                },
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "upscale_image",
            "description": "高清增强:本站图片放大 2x/4x 并修复细节。",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "scale": {"type": "integer", "description": "2 或 4(默认 2)"},
                },
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "inpaint_region",
            "description": "局部重绘:文字描述要修改的区域与替换内容(后端自理解定位)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "target": {"type": "string", "description": "要修改的区域(如:背景中的天空)"},
                    "positive": {"type": "string", "description": "替换成什么"},
                },
                "required": ["image_url", "target", "positive"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fix_faces",
            "description": "人脸修复:检测并修复本站图片中的模糊/低质量人脸。",
            "parameters": {
                "type": "object",
                "properties": {"image_url": {"type": "string"}},
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "qwen_edit_image",
            "description": (
                "智能编辑(Qwen):自然语言语义编辑(如把外套改红);"
                "camera 传方向可做镜头控制(forward/left/right/up/down/rotate_left/rotate_right/top_down/wide)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "positive": {"type": "string", "description": "编辑指令"},
                    "camera": {"type": "string", "description": "相机动作(可选)"},
                    "fast": {"type": "boolean", "description": "快速模式(默认 true)"},
                },
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "image_to_3d",
            "description": "图生 3D(Hunyuan3D):单图 → GLB 网格(分钟级;异步 job_id)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "image_url": {"type": "string"},
                    "octree_resolution": {"type": "integer", "description": "网格精度 64-512(默认 256)"},
                },
                "required": ["image_url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "render_video_edit",
            "description": (
                "三轨剪辑成片:clips(片段串接)+audios(混音)+texts(文字叠加)→ ffmpeg 渲染。"
                "输入为本站媒体地址数组与时间线参数;总时长 ≤600s。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "media_urls": {"type": "array", "items": {"type": "string"}, "description": "本站媒体地址(下标即 file)"},
                    "clips": {
                        "type": "array",
                        "description": "片段:[{file,in,duration,volume}]",
                        "items": {
                            "type": "object",
                            "properties": {
                                "file": {"type": "integer"}, "in": {"type": "number"},
                                "duration": {"type": "number"}, "volume": {"type": "number"},
                            },
                        },
                    },
                    "audios": {
                        "type": "array",
                        "description": "音频轨:[{file,in,duration,start,volume}](可选)",
                        "items": {"type": "object"},
                    },
                    "texts": {
                        "type": "array",
                        "description": "文字叠加:[{text,start,end,position,fontSize,color}](可选)",
                        "items": {"type": "object"},
                    },
                    "width": {"type": "integer", "description": "默认 1920"},
                    "height": {"type": "integer", "description": "默认 1080(下限 256)"},
                    "fps": {"type": "integer", "description": "默认 24"},
                },
                "required": ["media_urls", "clips"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "translate_segments",
            "description": "LLM 字幕翻译:分段文本 → 目标语译文(en/ja/ko/zh;口语自然贴近朗读时长)。",
            "parameters": {
                "type": "object",
                "properties": {
                    "segments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {"index": {"type": "integer"}, "text": {"type": "string"}},
                        },
                    },
                    "target_lang": {"type": "string", "description": "en/ja/ko/zh"},
                },
                "required": ["segments", "target_lang"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "generate_voice_track",
            "description": (
                "译制配音轨:对已上传到译制域的源视频(name,transcribe 的中间产物)按分段"
                "克隆音色合成整条配音(异步 job_id,查 check_jobs)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "译制域源文件名(dub-*.wav/mp4)"},
                    "segments": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "start": {"type": "number"}, "end": {"type": "number"}, "text": {"type": "string"},
                            },
                        },
                    },
                    "emo_text": {"type": "string", "description": "情绪提示(可选)"},
                },
                "required": ["name", "segments"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "lipsync_long",
            "description": (
                "译制对口型成片:源视频(name)+可选配音轨(audio_name)→ 分段 GPU 对口型"
                "(异步 job_id,查 check_jobs;长视频分钟-十分钟级)。"
            ),
            "parameters": {
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "译制域源视频名"},
                    "audio_name": {"type": "string", "description": "配音轨文件名(可选;空用源音轨)"},
                },
                "required": ["name"],
            },
        },
    },
]


async def _stage(url: str) -> tuple[bytes, str]:
    """取回字节(P-1:签名 URL 服务端自取 401,统一走 worker ComfyUI)。"""
    return await _url_media(url)


# ── executors ────────────────────────────────────────────────────────────

async def exec_synthesize_voice(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from types import SimpleNamespace

    text = str(args.get("text") or "").strip()
    if not text:
        return "text 不能为空。", []
    from app.routes.voice import VoiceRequest, synth_voice

    user: User = ctx["user"]
    session = ctx["session"]
    try:
        r = await synth_voice(
            VoiceRequest(
                text=text[:600],
                emo_text=(str(args.get("emo_text") or "").strip() or None),
                ref_audio_url=(str(args.get("voice_ref_url") or "").strip() or None),
            ),
            user=user, session=session, request=None,
        )
    except HTTPException as e:
        return _err("配音合成", e)
    media = [{"type": "audio", "url": r.get("url") or ""}] if r.get("url") else []
    return f"配音完成:{r.get('url')}(时长 {r.get('duration_sec')}s,可直接播放)。", media


async def exec_separate_vocals(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import audio as audio_route

    url = str(args.get("audio_url") or "").strip()
    if not url.startswith("/api/"):
        return "audio_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"音频取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-sep.wav")
    try:
        from app.routes.audio_tools import audio_separate

        r = await audio_separate(up, user=ctx["user"])
    except HTTPException as e:
        return _err("人声分离", e)
    media = [{"type": "audio", "url": r.get("url") or ""}] if r.get("url") else []
    return f"人声分离完成(干声):{r.get('url')}。", media


async def exec_transcribe_media(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import dub_text as dt
    from app.routes.dub_text import TranscribeRequest, dub_transcribe

    url = str(args.get("media_url") or "").strip()
    if not url.startswith("/api/"):
        return "media_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"媒体取回失败:{e}", []
    # dub 域按 name 读本地文件:先落 dub 目录(transcribe 的取回依赖)
    import uuid as _uuid

    from app.routes.dub_text import _DUB_DIR

    _DUB_DIR.mkdir(parents=True, exist_ok=True)
    name = f"agent-{_uuid.uuid4().hex[:10]}.wav"
    (_DUB_DIR / name).write_bytes(data)
    try:
        r = await dub_transcribe(TranscribeRequest(name=name), user=ctx["user"], session=ctx["session"])
    except HTTPException as e:
        return _err("听写", e)
    job_id = (r or {}).get("job_id") or ""
    return (
        f"听写已提交(异步):job_id={job_id}(GET /api/dub/transcribe/{job_id} 查;"
        "完成后分段文本自动展示)。"
    ), []


async def exec_remove_background(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    if not url.startswith("/api/"):
        return "image_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-rbg.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="img2img", worker=worker, user=ctx["user"], session=ctx["session"])
        res = await gen_route.generate_removebg(
            gen_route.RemoveBgRequest(image=h["filename"], worker=h["worker"], mode=str(args.get("mode") or "general")),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("去背景", e)
    return (
        f"去背景已提交:job_id={res.prompt_id}(池内图像约 1 分钟;check_jobs 查)。"
    ), []


async def exec_upscale_image(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    if not url.startswith("/api/"):
        return "image_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-up.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="img2img", worker=worker, user=ctx["user"], session=ctx["session"])
        res = await gen_route.generate_upscale(
            gen_route.UpscaleRequest(image=h["filename"], worker=h["worker"], scale=float(args.get("scale") or 2)),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("高清增强", e)
    return f"高清增强已提交:job_id={res.prompt_id}(check_jobs 查)。", []


async def exec_inpaint_region(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    target = str(args.get("target") or "").strip()
    positive = str(args.get("positive") or "").strip()
    if not url.startswith("/api/") or not target or not positive:
        return "image_url/target/positive 均必填(target=要改的区域,positive=替换成什么)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-inp.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="img2img", worker=worker, user=ctx["user"], session=ctx["session"])
        res = await gen_route.generate_inpaint(
            gen_route.InpaintRequest(image=h["filename"], worker=h["worker"], target=target, positive=positive),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("局部重绘", e)
    return f"局部重绘已提交:job_id={res.prompt_id}(check_jobs 查)。", []


async def exec_fix_faces(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    if not url.startswith("/api/"):
        return "image_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-face.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="img2img", worker=worker, user=ctx["user"], session=ctx["session"])
        res = await gen_route.generate_facedetailer(
            gen_route.FaceDetailerRequest(image=h["filename"], worker=h["worker"]),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("人脸修复", e)
    return f"人脸修复已提交:job_id={res.prompt_id}(check_jobs 查)。", []


async def exec_qwen_edit_image(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    positive = str(args.get("positive") or "").strip()
    camera = str(args.get("camera") or "").strip()
    if not url.startswith("/api/") or (not positive and not camera):
        return "image_url 必填,且编辑指令与相机动作至少给一个。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-qe.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="img2img", worker=worker, user=ctx["user"], session=ctx["session"])
        res = await gen_route.generate_qwen_edit(
            gen_route.QwenEditRequest(
                image=h["filename"], worker=h["worker"],
                positive=positive, camera=(camera or None), fast=bool(args.get("fast", True)),
            ),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("智能编辑", e)
    return f"智能编辑已提交:job_id={res.prompt_id}(check_jobs 查)。", []


async def exec_image_to_3d(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes import generate as gen_route
    from types import SimpleNamespace

    url = str(args.get("image_url") or "").strip()
    if not url.startswith("/api/"):
        return "image_url 须为本站地址(/api/ 开头)。", []
    try:
        data, _ct = await _stage(url)
    except Exception as e:  # noqa: BLE001
        return f"图片取回失败:{e}", []
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    up = _UF(file=_io.BytesIO(data), filename="agent-3d.png")
    from app.config import get_settings

    settings = get_settings()
    worker = settings.worker_urls[0] if settings.worker_urls else None
    try:
        from app.routes.generate import upload_image as _up

        h = await _up(up, kind="hunyuan3d", worker=worker, user=ctx["user"], session=ctx["session"])
        from app.routes.threed import Gen3DRequest, generate_3d

        res = await generate_3d(
            Gen3DRequest(
                image=h["filename"], worker=h["worker"],
                octree_resolution=int(args.get("octree_resolution") or 256),
            ),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("图生3D", e)
    return f"图生3D已提交:job_id={res.prompt_id}(分钟级;GLB 产物 check_jobs 查)。", []


async def exec_render_video_edit(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    import io as _io

    from starlette.datastructures import UploadFile as _UF

    urls = args.get("media_urls") or []
    if not urls or not isinstance(urls, list):
        return "media_urls 必填(本站媒体地址数组)。", []
    media: list[_UF] = []
    for u in urls:
        u = str(u)
        if not u.startswith("/api/"):
            return f"media 地址须为本站(/api/ 开头):{u[:60]}", []
        try:
            data, _ct = await _stage(u)
        except Exception as e:  # noqa: BLE001
            return f"媒体取回失败:{e}", []
        media.append(_UF(file=_io.BytesIO(data), filename="m.mp4"))
    from app.routes import video_edit as ve

    plan = {
        "width": int(args.get("width") or 1920),
        "height": int(args.get("height") or 1080),
        "fps": int(args.get("fps") or 24),
        "clips": args.get("clips") or [],
        "audios": args.get("audios") or [],
        "texts": args.get("texts") or [],
    }
    try:
        r = await ve.render_video_edit(json.dumps(plan), media, user=ctx["user"])
    except HTTPException as e:
        return _err("三轨剪辑渲染", e)
    out = r.get("url") or ""
    media_ev = [{"type": "video", "url": out}] if out else []
    return (
        f"剪辑成片完成:{out}({r.get('clips')} 片段/{r.get('audios')} 音频/{r.get('texts')} 文字,"
        f"{r.get('duration')}s)。"
    ), media_ev


async def exec_translate_segments(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes.dub_text import translate_endpoint
    from types import SimpleNamespace

    segs = args.get("segments") or []
    lang = str(args.get("target_lang") or "en").strip()
    if not segs:
        return "segments 必填([{index,text}]。)", []
    try:
        r = await dt.dub_translate(dt.TranslateRequest(
            segments=[dt.TranslateSeg(index=int(x.get("index", i)), text=str(x.get("text", ""))) for i, x in enumerate(segs)],
            target_lang=lang,
        ), user=ctx["user"])
    except HTTPException as e:
        return _err("翻译", e)
    out = r.get("translated") or []
    lines = [f"{t.get('index')}: {t.get('translated')}" for t in out[:20]]
    return f"翻译完成({r.get('target_lang')},{len(out)} 段):\n" + "\n".join(lines), []


async def exec_generate_voice_track(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes.dub_voice import VoiceTrackRequest, dub_voice_track
    from app.routes.dub_voice import VoiceSeg

    name = str(args.get("name") or "").strip()
    segs = args.get("segments") or []
    if not name or not segs:
        return "name(译制域源文件)与 segments 均必填。", []
    try:
        r = await dub_voice_track(
            VoiceTrackRequest(
                name=name,
                segments=[VoiceSeg(start=float(x.get("start", 0)), end=float(x.get("end", 0)), text=str(x.get("text", ""))) for x in segs],
                emo_text=(str(args.get("emo_text") or "").strip() or None),
            ),
            user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("生成配音轨", e)
    return (
        f"配音轨已提交(异步):job_id={r.get('job_id')}(完成后 check_jobs 查;产物为整条配音 wav)。"
    ), []


async def exec_lipsync_long(args: dict, ctx: dict) -> tuple[str, list[dict]]:
    from app.routes.dub import LipsyncLongRequest, dub_lipsync_long

    name = str(args.get("name") or "").strip()
    if not name:
        return "name(译制域源视频)必填。", []
    audio = str(args.get("audio_name") or "").strip()
    try:
        r = await dub_lipsync_long(
            LipsyncLongRequest(name=name, audio_name=(audio or None)),
            pool=ctx.get("pool"), user=ctx["user"], session=ctx["session"],
        )
    except HTTPException as e:
        return _err("对口型成片", e)
    return (
        f"对口型成片已提交(异步):job_id={r.get('job_id')}(分段 GPU,长视频数分钟-十分钟;"
        "完成后 check_jobs 查成片)。"
    ), []
