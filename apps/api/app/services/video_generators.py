"""视频生成模型聚合层 —— 抽象 VideoGenerator 接口,支持多模型可选。

对标 liblib.tv 的多模型聚合(Seedance/Kling)。LTX(SFW 走 LTX-2.5 专用实例,
NSFW 走 LTX-2.3 ComfyUI pool)与 LiveAct(独立 worker)实际可用,
Seedance/Kling 为 stub(返回占位错误响应),预留接口供后续接入。

设计要点:
  · VideoGenerator 抽象基类统一 generate() 签名,各实现按需翻译参数
  · LtxVideoGenerator 双链路:SFW → LTX-2.5 专用实例(build_ltx25_t2v_graph,
    音画同出);NSFW → LTX-2.3+10Eros(build_ltx_t2v_graph + pool.pick)
  · 实际等待(wait_for_jobs)由调用方决定,生成器只负责提交 + 返回 job_id
  · list_generators() / get_generator() 工厂供路由层与前端选择器使用
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import tempfile
import time
import uuid
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import httpx
from sqlmodel import Session, select

from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import image_url
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.models import Job
from app.services.duration import (
    DurationLimitError,
    DurationPlan,
    resolve_duration,
)
from app.workflows.ltx_video import LtxT2VParams, build_ltx_t2v_graph

logger = logging.getLogger(__name__)


@dataclass
class VideoGenResult:
    """视频生成统一结果。"""

    success: bool
    video_url: str = ""
    job_id: str = ""
    model: str = ""
    error: str = ""
    raw: dict | None = None
    # 时长策略提示(trim/extend/上下文窗口时为人话说明,否则空串)
    duration_notice: str = ""


# ---------------------------------------------------------------------------
# 时长后处理链(trim / extend)—— 生成完成后 ffmpeg 精确裁剪,产物回写 Job
# ---------------------------------------------------------------------------
#
# 生成器与路由均为 fire-and-forget(提交即返 prompt_id,tracker 异步落库)。
# resolve_duration 判定 trim/extend 时,本链在后台接力:
#   trim  :等产物 → 下载 → ffmpeg -t 精确裁 → 回传 worker input → 改写 Job.result
#   extend:等首段 → 抽末帧 → submit_next(i2v 续段)→ 逐段串接 concat → 精确裁 → 回写
# 链失败仅记日志(保留原始未裁剪产物,不把事情搞砸);调用方经 notice 告知用户。

_POST_POLL_INTERVAL = 3.0
# 单段产物等待上限:与 TOIV_JOB_TRACK_TIMEOUT 默认对齐——多条 extend 链共用单实例
# 排队时,单段从提交到出片实测可超 80min(2026-08-19 五路批量 H3×2 链均在此超时);
# 超时则整链放弃、Job 回落首段产物。调用方可按需注入更短超时(测试)。
_POST_WAIT_TIMEOUT = 7200.0
_FFMPEG_TIMEOUT = 600.0

# 持有后台链强引用(asyncio 仅持弱引用,防 GC 提前回收;与 tracker 同一手法)
_post_tasks: set[asyncio.Task] = set()


async def _run_ffmpeg(cmd: list[str], timeout: float = _FFMPEG_TIMEOUT) -> None:
    """执行 ffmpeg(与 routes/assembly._run_ffmpeg 同模式;service 层抛 RuntimeError)。"""
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        proc.kill()
        await proc.wait()
        raise RuntimeError(f"ffmpeg 执行超时({timeout:.0f}s)") from None
    if proc.returncode != 0:
        tail = (stderr or b"").decode("utf-8", "replace")[-800:]
        raise RuntimeError(f"ffmpeg 执行失败:{tail}")


async def _probe_has_audio(path: Path) -> bool:
    """ffprobe 探测是否含音轨(决定裁剪是否带音频);无 ffprobe 视为有。"""
    if shutil.which("ffprobe") is None:
        return True
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    return bool(out.decode().strip())


def _history_files(entry: dict) -> list[dict]:
    """从 history 条目提取产物文件 [{filename, subfolder, type}](与 client.get_result_files 同口径)。"""
    files: list[dict] = []
    for node_out in (entry.get("outputs") or {}).values():
        for value in node_out.values():
            if not isinstance(value, list):
                continue
            for item in value:
                if isinstance(item, dict) and "filename" in item:
                    files.append(
                        {
                            "filename": item["filename"],
                            "subfolder": item.get("subfolder", ""),
                            "type": item.get("type", "output"),
                        }
                    )
    return files


async def _wait_files(
    client: Any,
    prompt_id: str,
    *,
    timeout: float = _POST_WAIT_TIMEOUT,
    poll: float = _POST_POLL_INTERVAL,
) -> list[dict]:
    """轮询 worker history 直到出现产物文件;执行报错/超时抛 RuntimeError。

    超时按挂钟计(2026-08-20 修复):此前以 poll 累加计数,get_history 本身耗时
    (大 history 响应秒级)不计入,实际等待可达名义值的 ~1.4×(3600s 名义 →
    实测 5000s+ 才超时),与调用方预期不符。
    """
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            history = await client.get_history(prompt_id)
        except ComfyUIError:
            history = {}  # worker 暂不可达/历史未就绪,下轮再试
        entry = history.get(prompt_id) or {}
        files = _history_files(entry)
        if files:
            return files
        status = entry.get("status") or {}
        if status.get("status_str") == "error":
            raise RuntimeError(f"作业 {prompt_id} 执行失败")
        await asyncio.sleep(poll)
    raise RuntimeError(f"等待作业产物超时: {prompt_id}")


async def _concat_trim(
    seg_paths: list[Path],
    out: Path,
    seconds: float,
    *,
    ffmpeg: Callable[..., Awaitable[None]],
) -> None:
    """concat 多段(单段即纯裁剪)+ -t 精确裁到 seconds(重编码保证帧级精确)。"""
    audio = True
    for p in seg_paths:
        if not await _probe_has_audio(p):
            audio = False  # 任一段无音轨 → 整体去音轨(混排会炸 concat,丢音轨保时长)
            break
    list_file = out.parent / "concat.txt"
    await asyncio.to_thread(
        list_file.write_text, "".join(f"file '{p}'\n" for p in seg_paths)
    )
    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-t", f"{seconds:.3f}", "-c:v", "libx264", "-pix_fmt", "yuv420p",
    ]
    cmd += ["-c:a", "aac"] if audio else ["-an"]
    cmd += ["-movflags", "+faststart", str(out)]
    await ffmpeg(cmd)


def mark_post_processing(prompt_id: str, flag: str) -> None:
    """置位/清零时长后处理标记(processing=后台裁切链进行中);Job 不存在则跳过(仅日志)。

    前端据此在结果区显示「精确裁切中」而非直接播放未裁原片。
    """
    from app.db import engine as db_engine

    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None:
            logger.warning("时长后处理:Job %s 不存在,跳过 post_status=%s", prompt_id, flag)
            return
        job.post_status = flag
        s.add(job)
        s.commit()


def rewrite_job_result(prompt_id: str, urls: list[str]) -> None:
    """把作业产物改写为后处理最终产物(trim/extend);Job 不存在则跳过(仅日志)。

    同一 commit 内清零 post_status:终产物与「裁切完成」状态原子生效,
    前端不会出现「已裁产物 + 仍显示裁切中」的中间态。
    """
    from app.db import engine as db_engine

    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None:
            logger.warning("时长后处理:Job %s 不存在,跳过产物回写", prompt_id)
            return
        job.status = "done"
        job.result = json.dumps(urls)
        job.post_status = ""
        s.add(job)
        s.commit()


async def run_duration_chain(
    *,
    client: Any,
    plan: DurationPlan,
    first_prompt_id: str,
    submit_next: Callable[[bytes, int, int], Awaitable[str]] | None = None,
    on_final: Callable[[list[str]], Awaitable[None]] | None = None,
    wait_files: Callable[..., Awaitable[list[dict]]] | None = None,
    ffmpeg: Callable[..., Awaitable[None]] | None = None,
) -> None:
    """trim/extend 后处理链(direct 直接返回)。

    submit_next(frame_bytes, frames, idx) → 续段 prompt_id(extend 必填):
      由调用方按引擎构造 i2v 图提交(路由版会登记段 Job;生成器版直接 queue)。
    on_final(urls):最终产物回写(缺省 rewrite_job_result 到首段 Job)。
    wait_files / ffmpeg:测试注入点。
    """
    if plan.strategy == "direct":
        return
    if plan.strategy == "extend" and submit_next is None:
        raise ValueError("extend 策略需要 submit_next 续段提交回调")
    wait = wait_files or _wait_files
    ff = ffmpeg or _run_ffmpeg
    trim_to = plan.trim_to if plan.trim_to is not None else plan.seconds

    with tempfile.TemporaryDirectory(prefix="toiv-dur-") as tmp:
        tmp_dir = Path(tmp)
        seg_ids = [first_prompt_id]
        seg_paths: list[Path] = []
        for i in range(plan.segments):
            files = await wait(client, seg_ids[-1])
            if not files:
                raise RuntimeError(f"作业 {seg_ids[-1]} 无产物文件")
            data, _ = await client.get_image_bytes(
                files[0]["filename"],
                files[0].get("subfolder", ""),
                files[0].get("type", "output"),
            )
            seg_path = tmp_dir / f"seg-{i:03d}.mp4"
            await asyncio.to_thread(seg_path.write_bytes, data)
            seg_paths.append(seg_path)
            if i + 1 < plan.segments:
                frame_path = tmp_dir / f"frame-{i:03d}.jpg"
                await ff([
                    "ffmpeg", "-y", "-sseof", "-0.1", "-i", str(seg_path),
                    "-frames:v", "1", "-q:v", "2", str(frame_path),
                ])
                frame_bytes = await asyncio.to_thread(frame_path.read_bytes)
                if not frame_bytes:
                    raise RuntimeError("末帧抽取失败(ffmpeg 产物为空)")
                seg_ids.append(
                    await submit_next(frame_bytes, plan.segment_frames[i + 1], i + 1)  # type: ignore[misc]
                )

        final_path = tmp_dir / "final.mp4"
        await _concat_trim(seg_paths, final_path, trim_to, ffmpeg=ff)
        final_bytes = await asyncio.to_thread(final_path.read_bytes)
        if not final_bytes:
            raise RuntimeError("裁剪合成失败(ffmpeg 产物为空)")
        name = await client.upload_image(final_bytes, f"toiv_dur_{uuid.uuid4().hex}.mp4")
        url = image_url(client.base_url, {"filename": name, "type": "input"})
        if on_final is not None:
            await on_final([url])
        else:
            rewrite_job_result(first_prompt_id, [url])


def spawn_duration_chain(
    *,
    client: Any,
    plan: DurationPlan,
    first_prompt_id: str,
    submit_next: Callable[[bytes, int, int], Awaitable[str]] | None = None,
    on_final: Callable[[list[str]], Awaitable[None]] | None = None,
) -> None:
    """后台挂时长后处理链(direct 不挂)。异常只记日志,保留原始产物不标错误。

    挂链即把 Job.post_status 置 processing(前端结果区显示「精确裁切中」而非未裁原片);
    成功由 rewrite_job_result 随终产物同一 commit 清零,失败/异常在此清零回落原始产物。
    重启后残留 processing 由 db.init_db 的 _clear_stale_post_status 启动自愈清零。
    """
    if plan.strategy == "direct":
        return
    mark_post_processing(first_prompt_id, "processing")

    async def _runner() -> None:
        try:
            await run_duration_chain(
                client=client,
                plan=plan,
                first_prompt_id=first_prompt_id,
                submit_next=submit_next,
                on_final=on_final,
            )
        except Exception as e:  # noqa: BLE001 — 后台链绝不能冒泡;原始产物仍在
            logger.warning("时长后处理链 %s 失败(保留原始产物): %s", first_prompt_id, e)
            mark_post_processing(first_prompt_id, "")

    task = asyncio.create_task(_runner())
    _post_tasks.add(task)
    task.add_done_callback(_post_tasks.discard)


class VideoGenerator(ABC):
    """视频生成器抽象接口。"""

    name: str = "base"
    display_name: str = "基础"
    description: str = ""
    supports_image2video: bool = False
    supports_text2video: bool = True

    @abstractmethod
    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 16,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        """提交一次视频生成作业,返回结果(stub 实现直接返回失败)。"""
        ...


class LtxVideoGenerator(VideoGenerator):
    """LTX 视频生成器:SFW 走 LTX-2.5 专用实例(音画同出),NSFW 保留 LTX-2.3 pool 链路。

    SFW(2026-08-13 起替换 LTX-2.3 链路):
      Ltx25T2VParams → build_ltx25_t2v_graph → :8198 专用实例
      (ensure_ltx25_enabled/ensure_ltx25_ready)→ queue_prompt → spawn_tracker;
      与 WorkerPool 无关(独立实例,同 H3 模式),worker 钉选不适用。
    NSFW(R18 保留,不迁移):
      LtxT2VParams(10Eros)→ build_ltx_t2v_graph → pool.pick → queue_prompt → spawn_tracker
    只提交不等待,调用方拿 job_id 自行决定是否同步 wait_for_jobs。
    """

    name = "ltx"
    display_name = "LTX 2.5"
    description = "LTX-2.5 音画同出视频(SFW 主力);R18 走 LTX-2.3 + 10Eros"
    supports_image2video = True
    supports_text2video = True

    def __init__(self, pool: WorkerPool | None = None, tracker=spawn_tracker) -> None:
        self._pool = pool
        self._tracker = tracker  # 测试时可注入 mock

    @staticmethod
    def _snap32(v: int, lo: int, hi: int) -> int:
        """吸附 32 对齐并钳位 [lo, hi](LTX-2.5 分辨率约束)。"""
        v = max(lo, min(hi, int(v)))
        return max(lo, (v // 32) * 32)

    def _ltx25_extend_submit(self, client: Any, base: Any) -> Callable[[bytes, int, int], Awaitable[str]]:
        """extend 续段提交(生成器链路:末帧 i2v,直提实例不登记段 Job;strength=1.0 硬锁末帧保连贯)。"""
        from app.workflows.ltx25_video import Ltx25I2VParams, build_ltx25_i2v_graph

        async def _submit(frame_bytes: bytes, frames: int, idx: int) -> str:
            image_name = await client.upload_image(frame_bytes, f"toiv_ext_{uuid.uuid4().hex}.jpg")
            p = Ltx25I2VParams(
                positive=base.positive,
                negative=base.negative,
                image=image_name,
                width=base.width,
                height=base.height,
                length=frames,
                fps=base.fps,
                steps=base.steps,
                strength=1.0,
                seed=base.seed + idx,
                filename_prefix=base.filename_prefix,
            )
            return await client.queue_prompt(build_ltx25_i2v_graph(p), uuid.uuid4().hex)

        return _submit

    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 16,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        if not prompt.strip():
            return VideoGenResult(success=False, model=self.name, error="提示词为空")
        if bool(kwargs.get("nsfw", False)):
            return await self._generate_nsfw_pool(
                prompt, negative=negative, width=width, height=height,
                duration_sec=duration_sec, fps=fps, seed=seed, worker=worker, **kwargs,
            )
        return await self._generate_ltx25(
            prompt, negative=negative, width=width, height=height,
            duration_sec=duration_sec, fps=fps, seed=seed, **kwargs,
        )

    async def _generate_ltx25(
        self,
        prompt: str,
        *,
        negative: str,
        width: int,
        height: int,
        duration_sec: int,
        fps: int,
        seed: int | None,
        **kwargs: Any,
    ) -> VideoGenResult:
        """SFW 链路:LTX-2.5 专用实例(音画同出,蒸馏单阶段)。"""
        from fastapi import HTTPException

        from app.services import ltx25 as ltx25_service
        from app.workflows.ltx25_video import Ltx25T2VParams, build_ltx25_t2v_graph

        try:
            ltx25_service.ensure_ltx25_enabled()
            client = ltx25_service.get_ltx25_client()
            await ltx25_service.ensure_ltx25_ready(client)
        except HTTPException as e:
            return VideoGenResult(success=False, model=self.name, error=str(e.detail))

        fps_used = max(8, min(60, int(fps)))
        try:
            plan = resolve_duration("ltx25", float(duration_sec), fps_used)
        except DurationLimitError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))

        seed_used = seed if seed is not None else Ltx25T2VParams(positive="").seed
        params = Ltx25T2VParams(
            positive=prompt,
            negative=negative,
            width=self._snap32(width, 256, 1920),
            height=self._snap32(height, 256, 1088),
            length=plan.frames,
            fps=fps_used,
            steps=max(1, min(50, int(kwargs.get("steps", 8)))),
            seed=seed_used,
            filename_prefix=kwargs.get("filename_prefix", "ToIV_drama_video"),
        )
        graph = build_ltx25_t2v_graph(params)
        client_id = uuid.uuid4().hex
        try:
            prompt_id = await client.queue_prompt(graph, client_id)
        except ComfyUIError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))

        self._tracker(client, prompt_id)
        if plan.strategy != "direct":
            spawn_duration_chain(
                client=client,
                plan=plan,
                first_prompt_id=prompt_id,
                submit_next=self._ltx25_extend_submit(client, params),
            )
        return VideoGenResult(
            success=True,
            job_id=prompt_id,
            model=self.name,
            duration_notice=plan.notice,
            raw={
                "prompt_id": prompt_id,
                "client_id": client_id,
                "worker": client.base_url,
                "seed": seed_used,
                "duration_notice": plan.notice,
            },
        )

    async def _generate_nsfw_pool(
        self,
        prompt: str,
        *,
        negative: str,
        width: int,
        height: int,
        duration_sec: int,
        fps: int,
        seed: int | None,
        worker: str | None,
        **kwargs: Any,
    ) -> VideoGenResult:
        """NSFW 链路:LTX-2.3 + 10Eros 走 WorkerPool(R18 保留)。"""
        if self._pool is None:
            return VideoGenResult(success=False, model=self.name, error="未注入 WorkerPool")

        # 选 worker:优先走指定 worker,否则 pool.pick 路由 ltx_t2v 所需模型/节点
        from app.capabilities import required_models, required_nodes
        from app.deps import resolve_worker

        if worker:
            try:
                client = resolve_worker(worker)
            except Exception as e:  # resolve_worker 抛 HTTPException(未知 worker 等)
                return VideoGenResult(success=False, model=self.name, error=str(e))
        else:
            try:
                client = await self._pool.pick(
                    required=required_models("ltx_t2v"),
                    required_nodes=required_nodes("ltx_t2v"),
                )
            except ComfyUIError as e:
                return VideoGenResult(success=False, model=self.name, error=str(e))

        settings = get_settings()
        try:
            plan = resolve_duration("ltx", float(duration_sec), int(fps))
        except DurationLimitError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))
        # NSFW 专用视频底模(10Eros);gemma/vae 与 SFW 共用同一套
        seed_used = seed if seed is not None else LtxT2VParams(positive="").seed
        params = LtxT2VParams(
            positive=prompt,
            negative=negative,
            unet_name=settings.nsfw_default_video_ckpt,
            gemma_name=settings.nsfw_default_gemma,
            vae_name=settings.nsfw_default_vae,
            width=width,
            height=height,
            length=plan.frames,
            fps=fps,
            steps=kwargs.get("steps", 20),
            cfg=kwargs.get("cfg", 1.0),
            seed=seed_used,
            use_upscale=kwargs.get("use_upscale", False),
            use_rife=kwargs.get("use_rife", False),
            filename_prefix=kwargs.get("filename_prefix", "ToIV_drama_video"),
        )
        graph = build_ltx_t2v_graph(params)
        client_id = uuid.uuid4().hex
        try:
            prompt_id = await client.queue_prompt(graph, client_id)
        except ComfyUIError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))

        # 后台追踪结果(独立于客户端 SSE)
        self._tracker(client, prompt_id)
        if plan.strategy != "direct":  # ltx 无 extend(超上限已在 resolve 拦截),只会是 trim
            spawn_duration_chain(client=client, plan=plan, first_prompt_id=prompt_id)

        return VideoGenResult(
            success=True,
            job_id=prompt_id,
            model=self.name,
            duration_notice=plan.notice,
            raw={
                "prompt_id": prompt_id,
                "client_id": client_id,
                "worker": client.base_url,
                "seed": seed_used,
                "duration_notice": plan.notice,
            },
        )


class H3VideoGenerator(VideoGenerator):
    """MiniMax H3 文生视频生成器(专用 ComfyUI 实例,不走 WorkerPool,音画同发)。

    与 LTX 的差异(见 services/h3.py / workflows/h3_video.py):
      · 固定 24fps,帧数须 17k+5 网格(22-362)——由 duration_sec 自动吸附
      · 分辨率 32 对齐、256-1344(上限 1344×768)——分镜宽高自动吸附/钳位
      · 无 cfg/负向输入(节点无该输入,negative 仅快照保留)
      · 提交前经 ensure_h3_ready/ensure_h3_vram 就绪+显存预检,不足返回错峰原因
    """

    name = "h3"
    display_name = "MiniMax H3"
    description = "MiniMax H3 文生视频(音画同发,固定 24fps)"
    supports_image2video = False
    supports_text2video = True

    def __init__(self, tracker=spawn_tracker) -> None:
        self._tracker = tracker

    @staticmethod
    def _snap32(v: int) -> int:
        """吸附到 32 对齐并钳位 [256, 1344](H3 分辨率约束)。"""
        v = max(256, min(1344, int(v)))
        return max(256, (v // 32) * 32)

    def _h3_extend_submit(self, client: Any, base: Any) -> Callable[[bytes, int, int], Awaitable[str]]:
        """extend 续段提交(生成器链路:末帧 i2v,直提实例不登记段 Job)。"""
        from app.workflows.h3_video import H3I2VParams, build_h3_i2v_graph

        async def _submit(frame_bytes: bytes, frames: int, idx: int) -> str:
            image_name = await client.upload_image(frame_bytes, f"toiv_ext_{uuid.uuid4().hex}.jpg")
            p = H3I2VParams(
                positive=base.positive,
                negative=base.negative,
                image=image_name,
                width=base.width,
                height=base.height,
                length=frames,
                steps=base.steps,
                seed=base.seed + idx,
                loras=base.loras,
                filename_prefix=base.filename_prefix,
            )
            return await client.queue_prompt(build_h3_i2v_graph(p), uuid.uuid4().hex)

        return _submit

    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 16,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        if not prompt.strip():
            return VideoGenResult(success=False, model=self.name, error="提示词为空")

        from fastapi import HTTPException

        from app.services import h3 as h3_service
        from app.workflows.h3_video import H3T2VParams, build_h3_t2v_graph

        try:
            h3_service.ensure_h3_enabled()
            client = h3_service.get_h3_client()
            await h3_service.ensure_h3_ready(client)
            await h3_service.ensure_h3_vram(client)
        except HTTPException as e:
            return VideoGenResult(success=False, model=self.name, error=str(e.detail))

        # H3 固定 24fps(模板 CreateVideo 锁定),时长经统一策略层解析(17k+5 网格)
        try:
            plan = resolve_duration("h3", float(duration_sec), 24)
        except DurationLimitError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))
        seed_used = seed if seed is not None else H3T2VParams(positive="").seed
        params = H3T2VParams(
            positive=prompt,
            negative=negative,
            width=self._snap32(width),
            height=self._snap32(height),
            length=plan.frames,
            steps=max(1, min(50, int(kwargs.get("steps", 20)))),
            seed=seed_used,
            filename_prefix=kwargs.get("filename_prefix", "ToIV_drama_h3"),
        )
        graph = build_h3_t2v_graph(params)
        client_id = uuid.uuid4().hex
        try:
            prompt_id = await client.queue_prompt(graph, client_id)
        except ComfyUIError as e:
            return VideoGenResult(success=False, model=self.name, error=str(e))

        self._tracker(client, prompt_id)
        if plan.strategy != "direct":
            spawn_duration_chain(
                client=client,
                plan=plan,
                first_prompt_id=prompt_id,
                submit_next=self._h3_extend_submit(client, params),
            )

        return VideoGenResult(
            success=True,
            job_id=prompt_id,
            model=self.name,
            duration_notice=plan.notice,
            raw={
                "prompt_id": prompt_id,
                "client_id": client_id,
                "worker": client.base_url,
                "seed": seed_used,
                "duration_notice": plan.notice,
            },
        )


class SeedanceVideoGenerator(VideoGenerator):
    """Seedance 视频生成器(stub,接口预留,未接入)。"""

    name = "seedance"
    display_name = "Seedance"
    supports_image2video = True
    supports_text2video = True

    async def generate(self, *args: Any, **kwargs: Any) -> VideoGenResult:
        return VideoGenResult(
            success=False,
            model=self.name,
            error="Seedance 生成器尚未接入,当前为 stub",
        )


class KlingVideoGenerator(VideoGenerator):
    """Kling 视频生成器(stub,接口预留,未接入)。"""

    name = "kling"
    display_name = "Kling"
    supports_image2video = True
    supports_text2video = True

    async def generate(self, *args: Any, **kwargs: Any) -> VideoGenResult:
        return VideoGenResult(
            success=False,
            model=self.name,
            error="Kling 生成器尚未接入,当前为 stub",
        )


class LiveActVideoGenerator(VideoGenerator):
    """SoulX LiveAct 14B 全身数字人生成器(workstation 真机独立 worker,需先配音)。

    与 ComfyUI 系生成器不同:不走 pool/tracker,直接调 LiveAct worker HTTP API。
    输入为角色参考图 + 配音音频,生成时长 = 音频时长,因此分镜必须先完成配音。
    只提交不等待,raw 里回 task_id,由调用方轮询 /status + 拉 /result。
    """

    name = "liveact"
    display_name = "LiveAct 全身数字人"
    description = "SoulX LiveAct 14B 全身数字人(需先配音)"
    supports_image2video = True
    supports_text2video = False

    async def generate(
        self,
        prompt: str,
        *,
        negative: str = "",
        width: int = 768,
        height: int = 384,
        duration_sec: int = 6,
        fps: int = 20,
        seed: int | None = None,
        image_url: str = "",
        worker: str | None = None,
        **kwargs: Any,
    ) -> VideoGenResult:
        base = get_settings().liveact_base
        if not base:
            return VideoGenResult(success=False, model=self.name, error="LiveAct 未部署")
        ref_image_bytes = kwargs.get("ref_image_bytes")
        audio_bytes = kwargs.get("audio_bytes")
        if not ref_image_bytes:
            return VideoGenResult(success=False, model=self.name, error="缺少角色参考图")
        if not audio_bytes:
            return VideoGenResult(success=False, model=self.name, error="缺少配音音频")

        files = {
            "image": ("ref.png", ref_image_bytes, "image/png"),
            "audio": ("voice.wav", audio_bytes, "audio/wav"),
        }
        data = {
            "prompt": prompt,
            "fps": str(fps),
            "size": kwargs.get("size", "416*720"),
            "seed": str(seed if seed is not None else 42),
        }
        try:
            async with httpx.AsyncClient(timeout=120.0, trust_env=False) as client:
                resp = await client.post(base + "/generate", data=data, files=files)
        except httpx.HTTPError as e:
            return VideoGenResult(
                success=False, model=self.name, error=f"LiveAct worker 不可达:{e}"
            )
        if resp.status_code != 200:
            detail = "LiveAct 提交失败"
            try:
                detail = resp.json().get("detail", detail)
            except (ValueError, KeyError):
                detail = resp.text[:200] or detail
            return VideoGenResult(success=False, model=self.name, error=detail)

        task_id = resp.json().get("task_id", "")
        if not task_id:
            return VideoGenResult(
                success=False, model=self.name, error="LiveAct 未返回 task_id"
            )
        return VideoGenResult(
            success=True,
            job_id=task_id,
            model=self.name,
            raw={"task_id": task_id, "worker": base},
        )


# 工厂注册表
_REGISTRY: dict[str, type[VideoGenerator]] = {
    "ltx": LtxVideoGenerator,
    "h3": H3VideoGenerator,
    "seedance": SeedanceVideoGenerator,
    "kling": KlingVideoGenerator,
    "liveact": LiveActVideoGenerator,
}


def list_generators() -> list[dict]:
    """返回所有已注册生成器的元信息(供前端渲染选择器)。"""
    return [
        {
            "name": cls.name,
            "display_name": cls.display_name,
            "description": cls.description,
            "supports_image2video": cls.supports_image2video,
            "supports_text2video": cls.supports_text2video,
        }
        for cls in _REGISTRY.values()
    ]


def get_generator(name: str, pool: WorkerPool | None = None, tracker=spawn_tracker) -> VideoGenerator:
    """按名称获取生成器实例。未知名称抛 ValueError。"""
    cls = _REGISTRY.get(name)
    if cls is None:
        raise ValueError(f"未知视频生成器: {name},可选: {list(_REGISTRY.keys())}")
    if name == "ltx":
        return cls(pool, tracker)
    if name == "h3":
        return cls(tracker)
    return cls()
