"""真实 Demo 封面(2026-09-14,用户拍板「封面必须由对应应用真跑产出」)。

与插画封面(services/app_covers,txt2img 装饰图)互补:本服务把每个公开应用
**用自己的工作流真跑一遍**(美女素材包 + 场景提示词注入),产物(图直接用、
视频 ffmpeg 抽中帧)裁成封面回写 App.cover_url——每个封面都有
Job(kind=app_cover_demo) 存档可溯源。

- 素材包:app/data/fixtures/beauty01-12.png(平台自产 SFW 写真,已人工审)
  + drive_2s.mp4(动作驱动)+ dlg_h3b.wav(口播音频);上传名沿用 smoke_ 前缀,
  复用 app_smoke._upload_fixtures 的同名匹配,零改动。
- 提示词注入:纯生成类(无媒体输入)换美女场景模板;视频类(含 i2v)换动作
  模板(与美女参考图自洽);图片编辑类保留应用默认提示词(语义是编辑操作)。
- 复用 run_app_smoke 全套(combo 校准修复 + LLM 自愈 + smoke 字段落库)——
  demo 跑批顺带把未烟测应用的真实 E2E 覆盖补齐。
- 目标清单:公开、非 R18(R18 卡市场端模糊展示,保留抽象封面)、音频产物跳过;
  排序 = featured → smoke 已证可跑 → 无封面 → usage 降序。
- 单飞批处理,批内并发 2(不与生产抢卡);成功才覆盖封面,失败保留原图。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import random
import sys
import re
import time
import uuid
from datetime import datetime
from pathlib import Path

from sqlmodel import Session, select

from app.comfy.client import ComfyUIClient
from app.comfy.pool import WorkerPool
from app.db import engine
from app.models import App, Job

logger = logging.getLogger(__name__)

_DEMO_URL_MARK = "/appcover-demo-"  # demo 封面文件名标记(区别于插画 appcover-)
_BATCH_CONCURRENCY = 6  # 队列消费路数(fleet 6 实例:LB×2+H3×2+longcat+animate2)
_PER_APP_CAP_S = {"video": 2100, "image": 900, "audio": 600, "3d": 900}  # 单应用整体时限
_COVER_VIDEO_EXTS = {".mp4", ".webm", ".mov", ".gif", ".mkv", ".avi"}
_COVER_IMG_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
_MAX_FIXES_LOG = 5

# 与素材包 beauty01-12 一一对应的场景描述(txt2img 同款,保证「参考图风格=提示词风格」自洽)
_SCENES = [
    "elegant black evening dress, studio portrait, softbox lighting, dark background, gentle smile",
    "white blouse and straw hat, golden hour sunlight, city street, bokeh background, natural smile",
    "traditional hanfu dress, classical garden, cherry blossom, paper umbrella, serene expression",
    "business suit, modern office, glass wall background, confident expression, arms crossed",
    "sporty athleisure outfit, morning park, ponytail, energetic, full body",
    "glamorous golden evening gown, gala night, bokeh lights background, graceful pose",
    "casual denim jacket, sitting by cafe window, holding coffee cup, relaxed smile",
    "white summer sundress, beach at sunset, walking along shore, wind in hair, warm backlight",
    "black leather jacket, neon lit night street, cinematic lighting, cool expression",
    "floral sundress, spring park full of blossoms, twirling pose, joyful smile",
    "close-up beauty portrait, natural makeup, detailed eyes, soft window light",
    "autumn wool coat and scarf, tree-lined avenue with fallen leaves, gentle look",
]
_POS_TAIL = "photorealistic, professional photography, 85mm portrait lens, detailed skin texture, natural skin, tasteful, elegant, beautiful young woman"
_MOTION_TAILS = [
    "the beautiful young woman smiles gently and looks at the camera, hair swaying in the breeze, smooth natural motion, cinematic lighting",
    "the beautiful young woman walks forward slowly, dress flowing, cinematic camera follow, golden hour light, smooth motion",
    "the beautiful young woman turns her head and smiles, city bokeh lights behind, graceful cinematic motion",
    "the beautiful young woman dances gracefully, flowing elegant motion, studio lighting, cinematic",
    "the beautiful young woman waves and smiles by the cafe window, warm sunlight, natural motion",
]
_VIDEO_LEN_KEYS = {"length", "num_frames", "video_length", "frames", "frame_count", "duration"}
_SEED_KEY_RE = re.compile(r"seed", re.I)
_VIDEO_LEN_CAP = 73  # 封面只取一帧,超长视频压到 ~3s 档,波次跑得动(仍是真实产物)

# 长度参数提示词之外的白名单注入——
_PROMPT_KEY_RE = re.compile(r"prompt", re.I)
_NEG_RE = re.compile(r"neg", re.I)


def demo_values(app: App, idx: int) -> tuple[dict, str]:
    """合成 demo 表单值;返回 (values, 注入的主提示词——未注入则为 "")。

    媒体槽按类型喂素材包(smoke_ 前缀命名,复用 _upload_fixtures 匹配);
    提示词注入规则见模块 docstring;超长视频长度参数压到 _VIDEO_LEN_CAP。
    """
    schema = app.params_schema or []
    id_salt = int(hashlib.md5(app.id.encode()).hexdigest(), 16)
    values: dict = {}
    has_media = False
    prompt_keys: list[str] = []
    textarea_keys: list[str] = []
    for p in schema:
        key = p.get("key")
        if not key:
            continue
        t = p.get("type", "text")
        if t in ("images", "image", "video", "audio"):
            has_media = True
            if t == "audio":
                values[key] = f"smoke_{key}_dlg_h3b.wav"
            elif t == "video":
                values[key] = f"smoke_{key}_drive_2s.mp4"
            else:
                n = (id_salt % len(_SCENES)) + 1
                values[key] = f"smoke_{key}_beauty{n:02d}.png"
        elif t in ("text", "textarea"):
            if _PROMPT_KEY_RE.search(key) and not _NEG_RE.search(key):
                prompt_keys.append(key)
            elif key.lower() in ("text", "content", "positive"):
                prompt_keys.append(key)
            if t == "textarea":
                textarea_keys.append(key)
        elif t == "number" and key.lower() in _VIDEO_LEN_KEYS:
            default = p.get("default")
            if isinstance(default, (int, float)) and default > _VIDEO_LEN_CAP:
                values[key] = _VIDEO_LEN_CAP
        elif t == "number" and _SEED_KEY_RE.search(key):
            # 每应用随机 seed:工作流模板常钉死种子,提示词轮换池又小,
            # 不随机会让几十个同类应用撞出同一张封面(2026-09-16 实证 32 个 H3 同图)
            values[key] = random.randrange(1, 2**31)

    scene = _SCENES[id_salt % len(_SCENES)]
    is_video = (app.output_kind or "") == "video"
    if is_video:
        injected = f"{_MOTION_TAILS[id_salt % len(_MOTION_TAILS)]}, high quality"
    else:
        injected = f"1girl, chinese young woman, solo, {scene}, {_POS_TAIL}"
    # 注入条件:纯生成类(无媒体输入)一律换;视频类带图输入也换(动作模板与
    # 人像参考自洽);图片编辑类保留默认提示词(它描述的是编辑操作本身)。
    target_key = ""
    if (not has_media or is_video) and prompt_keys:
        target_key = prompt_keys[0]
        values[target_key] = injected
    elif not has_media and textarea_keys:
        target_key = textarea_keys[0]
        values[target_key] = injected
    return values, (injected if target_key else "")


def plan_demo_targets(session: Session, limit: int) -> list[App]:
    """待做清单:公开、非 R18、非音频产物、还没有 demo 封面;按优先级排序截断。"""
    rows = session.exec(select(App).where(App.is_public == True)).all()  # noqa: E712
    todo = [
        a for a in rows
        if not a.is_nsfw
        and (a.output_kind or "image") != "audio"
        and _DEMO_URL_MARK not in (a.cover_url or "")
    ]
    # smoke 已知失败/超时的沉底(多为内容缺口/上游 bug,先给可跑的应用出封面)
    def _rank(a: App) -> tuple:
        rank = {"pass": 0, "": 1, "running": 1}.get(a.smoke_status or "", 2)
        return (
            0 if a.featured else 1,
            rank,
            0 if not (a.cover_url or "").strip() else 1,
            -a.usage_count,
            a.id,
        )

    todo.sort(key=_rank)
    return todo[: max(limit, 0)]


async def _extract_frame(video: bytes) -> bytes | None:
    """ffmpeg 抽视频帧做封面:优先 1s 处(避开首帧噪声),失败退回首帧。"""
    import tempfile

    with tempfile.TemporaryDirectory(prefix="coverdemo") as td:
        src = Path(td) / "in.bin"
        src.write_bytes(video)
        for seek in ("1", "0"):
            dst = Path(td) / f"frame_{seek}.jpg"
            proc = await asyncio.create_subprocess_exec(
                "ffmpeg", "-y", "-loglevel", "error", "-ss", seek, "-i", str(src),
                "-frames:v", "1", "-q:v", "3", str(dst),
                stdout=asyncio.subprocess.DEVNULL, stderr=asyncio.subprocess.DEVNULL,
            )
            try:
                await asyncio.wait_for(proc.wait(), timeout=60)
            except TimeoutError:
                proc.kill()
                return None
            if dst.exists() and dst.stat().st_size > 0:
                return dst.read_bytes()
    return None


def _sniff_ext(content: bytes) -> str:
    if content.startswith(b"\x89PNG\r\n\x1a\n"):
        return "png"
    if content.startswith(b"\xff\xd8\xff"):
        return "jpg"
    if len(content) >= 12 and content[:4] == b"RIFF" and content[8:12] == b"WEBP":
        return "webp"
    return "png"


async def _make_cover(worker_url: str, files: list[dict]) -> tuple[str, str] | None:
    """从产物清单取第一个可用文件做封面;返回 (cover_url, source_name)。"""
    from app.storage import content_subdir

    client = ComfyUIClient(worker_url, timeout=60)
    for f in files:
        name = f.get("filename") or ""
        ext = Path(name).suffix.lower()
        if ext not in (_COVER_VIDEO_EXTS | _COVER_IMG_EXTS):
            continue
        try:
            content, _ = await client.get_image_bytes(name, f.get("subfolder", ""), f.get("type", "output"))
        except Exception:  # noqa: BLE001 — 单文件不可取,试下一个产物
            continue
        if not content:
            continue
        if ext in _COVER_VIDEO_EXTS:
            frame = await _extract_frame(content)
            if frame is None:
                continue
            content, out_ext = frame, "jpg"
        else:
            out_ext = _sniff_ext(content)
        dest = content_subdir("app-covers") / f"appcover-demo-{uuid.uuid4().hex}.{out_ext}"
        dest.write_bytes(content)
        return f"/api/apps/covers/file/{dest.name}", name
    return None


async def _demo_one(pool: WorkerPool, app_id: str, idx: int) -> dict:
    """单应用 demo 封面全链;独立 session(并发任务不共享 ORM 会话)。"""
    from app.services.app_smoke import run_app_smoke

    out: dict = {"app_id": app_id, "ok": False}
    with Session(engine) as session:
        app = session.get(App, app_id)
        if app is None:
            out["error"] = "app missing"
            return out
        values, injected = demo_values(app, idx)
        try:
            result = await run_app_smoke(pool, session, app, values_override=values, collect_result=True)
        except Exception as exc:  # noqa: BLE001 — 单应用失败不中断批次
            out["error"] = f"smoke error: {exc!r}"[:200]
            return out
        out["smoke"] = result["status"]
        out["cls"] = result.get("cls", "")
        if result["status"] != "pass" or not result.get("files"):
            out["error"] = result.get("detail", "")[:200]
            return out
        try:
            made = await _make_cover(result["worker"], result["files"])
        except Exception as exc:  # noqa: BLE001
            out["error"] = f"cover error: {exc!r}"[:200]
            return out
        if made is None:
            out["error"] = "无可封面产物(非图/视频或缺字节)"
            return out
        cover_url, source = made
        app.cover_url = cover_url  # 成功才覆盖(失败路径不触碰封面)
        job = Job(
            tenant_id="",
            user_id="",  # 系统维护作业,无属主
            prompt_id="",  # run_app_smoke 未透传 prompt_id,溯源靠 params+smoke_at
            worker=result["worker"],
            kind="app_cover_demo",
            status="done",
            prompt=(injected or "[demo] 应用默认提示词")[:500],
            seed=0,
            result=json.dumps([cover_url], ensure_ascii=False),
            params=json.dumps(
                {"app_id": app_id, "source": source, "fixes": result.get("fixes", [])[:_MAX_FIXES_LOG]},
                ensure_ascii=False,
            ),
        )
        session.add(job)
        session.add(app)
        session.commit()
        out.update(ok=True, cover_url=cover_url, source=source)
    return out


async def _run_batch(pool: WorkerPool, limit: int) -> int:
    """队列消费模式:4 路并发各取各的下一个目标,病态应用不再堵住整批(队头阻塞修复)。

    单应用整体时限 _PER_APP_CAP_S(output_kind 分档):run_app_smoke 内部有轮询
    上限,但探测/上传/修复阶段可能病态卡住——超时强杀并把 smoke 标记为 timeout,
    让它在本批沉底,不反复重烧。
    """
    global _DEMO_SUMMARY
    with Session(engine) as session:
        targets = plan_demo_targets(session, limit)
    _DEMO_SUMMARY["total"] = len(targets)

    queue: asyncio.Queue[str] = asyncio.Queue()
    for t in targets:
        queue.put_nowait(t.id)
    cap_by_kind = {t.id: _PER_APP_CAP_S.get(t.output_kind or "image", 900) for t in targets}
    state = {"idx": 0, "done": 0, "ok": 0}
    idx_lock = asyncio.Lock()

    async def _next_idx() -> int:
        async with idx_lock:
            v = state["idx"]
            state["idx"] += 1
            return v

    def _mark_timeout(app_id: str, cap_s: int) -> None:
        try:
            with Session(engine) as session:
                a = session.get(App, app_id)
                if a is not None and a.smoke_status == "running":
                    a.smoke_status = "timeout"
                    a.smoke_cls = "timeout"
                    a.smoke_error = f"demo 整体超时 {cap_s}s(探测/生成卡死)"
                    a.smoke_at = datetime.utcnow()
                    session.add(a)
                    session.commit()
        except Exception:  # noqa: BLE001 — 标记失败不中断批次
            pass

    async def _consumer() -> None:
        while True:
            try:
                app_id = queue.get_nowait()
            except asyncio.QueueEmpty:
                return
            cap_s = cap_by_kind.get(app_id, 900)
            idx = await _next_idx()
            try:
                r = await asyncio.wait_for(_demo_one(pool, app_id, idx), timeout=cap_s)
            except (TimeoutError, asyncio.TimeoutError):
                _mark_timeout(app_id, cap_s)
                r = {"app_id": app_id, "ok": False, "error": f"整体超时 {cap_s}s"}
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 — 单应用失败不中断批次
                r = {"app_id": app_id, "ok": False, "error": repr(exc)[:200]}
            state["done"] += 1
            state["ok"] += 1 if r.get("ok") else 0
            _DEMO_SUMMARY.update(
                done=state["done"], ok=state["ok"],
                finished_at=datetime.utcnow().isoformat(timespec="seconds"),
            )
            if state["done"] % 10 == 0 or state["done"] == len(targets):
                logger.info("demo cover %d/%d ok=%d", state["done"], len(targets), state["ok"])
            queue.task_done()

    await asyncio.gather(*(_consumer() for _ in range(_BATCH_CONCURRENCY)))
    return state["ok"]


_DEMO_TASK: asyncio.Task | None = None
_DEMO_SUMMARY: dict = {}


def spawn_demo_batch(pool: WorkerPool, limit: int = 40) -> asyncio.Task | None:
    """fire-and-forget 启动 demo 封面批(单飞);运行中返回 None。"""
    global _DEMO_TASK, _DEMO_SUMMARY
    if demo_running():
        return None
    _DEMO_SUMMARY = {"started_at": datetime.utcnow().isoformat(timespec="seconds"),
                     "started_mono": time.monotonic(), "done": 0, "ok": 0, "total": 0}
    _DEMO_TASK = asyncio.create_task(_run_batch(pool, limit))
    return _DEMO_TASK


def demo_running() -> bool:
    return _DEMO_TASK is not None and not _DEMO_TASK.done()


async def autorefire_loop(pool: WorkerPool, interval_s: int = 300) -> None:
    """api 内建持续批送(2026-09-18):每 5 min 查一次,空闲且有目标就自动续发。

    取代跑在外部 Mac 上的 watcher——Mac 换网/休眠会导致链路断而无人续发。
    """
    while True:
        try:
            if not demo_running():
                with Session(engine) as session:
                    pending = plan_demo_targets(session, 1)
                if pending:
                    logger.info("cover autorefire: 空闲续发(%d 个目标)", len(pending))
                    spawn_demo_batch(pool, 600)
        except Exception:  # noqa: BLE001 — 守护循环绝不抛出
            logger.warning("cover autorefire 异常: %s", repr(sys.exc_info()[1])[:120])
        await asyncio.sleep(interval_s)


def last_demo_summary() -> dict:
    if not _DEMO_SUMMARY:
        return {"running": False, "never_run": True}
    out = {k: v for k, v in _DEMO_SUMMARY.items() if k != "started_mono"}
    out["running"] = demo_running()
    if out["running"] and _DEMO_SUMMARY.get("started_mono"):
        out["elapsed_s"] = int(time.monotonic() - _DEMO_SUMMARY["started_mono"])
    return out
