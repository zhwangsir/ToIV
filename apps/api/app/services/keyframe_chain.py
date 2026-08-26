"""关键帧链式转场 —— 2-5 张关键帧 → N-1 段首尾帧转场 → ffmpeg 拼接为整条视频。

对标 Pika 2.5 Pikaframes(最多 5 张关键帧链式转场,单段 1-10s,链式拼接至 25s)。

分层(与 services/duration 同一风格):
  · 纯函数层(validate_keyframe_chain / plan_keyframe_chain):不做 IO、不依赖
    fastapi/DB,方便全矩阵单测;非法输入抛 KeyframeChainError(路由层转 422)
  · 合并链(run/spawn/reconcile):后台等全部段产物 → concat + -t 精确裁到总时长
    → 回传 worker input → 回写合并 Job(复用 video_generators 的
    _wait_files/_concat_trim,与 duration extend 链同一机制)

平滑过渡设计:
  · 段间衔接:第 i 段尾帧 = 第 i+1 段首帧(用户提供的关键帧),各段复用 transition
    的 VACE 首尾帧链路,衔接处两帧一致、天然零跳变
  · 时长分配:durations 缺省时每段 5s 均分;显式给出时逐段 1-10s、总长 ≤25s
  · 帧网格对齐:每段帧数按 Wan VACE 4k+1 网格向上吸附(snap_engine_frames)

与 DurationPlan extend 策略正交:extend 是单视频末帧续写(段依赖上段产物),
关键帧链是多组独立转场(段间只共享用户给定的衔接帧,可并行排队)。
"""
from __future__ import annotations

import asyncio
import json
import logging
import tempfile
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.comfy.tracker import image_url
from app.services import video_generators as vgen
from app.services.duration import snap_engine_frames

logger = logging.getLogger(__name__)

MIN_KEYFRAMES = 2
MAX_KEYFRAMES = 5
MIN_SEGMENT_SEC = 1.0
MAX_SEGMENT_SEC = 10.0
MAX_TOTAL_SEC = 25.0
# durations 缺省时每段均分时长(与 transition 旧默认 81 帧@16fps≈5s 一致)
DEFAULT_SEGMENT_SEC = 5.0

# 段帧数吸附用引擎网格(Wan2.1-VACE 4k+1,与 transition 同一链路)
_CHAIN_ENGINE = "vace"


class KeyframeChainError(ValueError):
    """关键帧链参数非法(路由层转 422)。"""


@dataclass(frozen=True)
class KeyframeSegment:
    """单段转场:首帧 → 尾帧(段 i 尾帧 = 段 i+1 首帧,链式衔接)。"""

    first_frame: str
    last_frame: str
    prompt: str
    duration_sec: float
    frames: int  # 4k+1 网格吸附后帧数
    steps: int
    cfg: float
    seed: int | None  # 段种子(基础 seed + 段序号;无基础种子为 None=各段随机)


@dataclass(frozen=True)
class KeyframeChainPlan:
    """完整链式计划:segments 按链序;total_duration 为各段时长之和(请求口径)。"""

    segments: tuple[KeyframeSegment, ...]
    total_duration: float
    fps: int
    width: int
    height: int
    seed: int | None

    def to_params(self) -> dict[str, Any]:
        """Job.params 快照(排查/精确重生/api 重启重挂拼接链的事实源)。"""
        return {
            "segments": [
                {
                    "first_frame": s.first_frame,
                    "last_frame": s.last_frame,
                    "prompt": s.prompt,
                    "duration_sec": s.duration_sec,
                    "frames": s.frames,
                    "steps": s.steps,
                    "cfg": s.cfg,
                    "seed": s.seed,
                }
                for s in self.segments
            ],
            "total_duration": self.total_duration,
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "seed": self.seed,
        }


def _resolve_prompts(prompts: str | list[str], n_seg: int) -> list[str]:
    """单 string → 全段共用;list → 逐段(数量须等于段数)。每段非空。"""
    if isinstance(prompts, str):
        out = [prompts.strip()] * n_seg
    else:
        if len(prompts) != n_seg:
            raise KeyframeChainError(
                f"提示词数量({len(prompts)})须等于转场段数({n_seg});单 string 则全段共用"
            )
        out = [p.strip() for p in prompts]
    if any(not p for p in out):
        raise KeyframeChainError("每段提示词不能为空")
    return out


def _resolve_durations(durations: list[float] | None, n_seg: int) -> list[float]:
    """None → 每段默认 5s 均分;list → 逐段 1-10s 且总长 ≤25s。"""
    if durations is None:
        return [DEFAULT_SEGMENT_SEC] * n_seg
    if len(durations) != n_seg:
        raise KeyframeChainError(
            f"时长数量({len(durations)})须等于转场段数({n_seg});留空则每段均分"
        )
    out = [float(d) for d in durations]
    for d in out:
        if not (MIN_SEGMENT_SEC <= d <= MAX_SEGMENT_SEC):
            raise KeyframeChainError(
                f"每段时长须在 {MIN_SEGMENT_SEC:g}-{MAX_SEGMENT_SEC:g} 秒之间(当前 {d:g} 秒)"
            )
    total = sum(out)
    if total > MAX_TOTAL_SEC:
        raise KeyframeChainError(
            f"链式转场总时长最长 {MAX_TOTAL_SEC:g} 秒(当前 {total:g} 秒),请缩短各段时长"
        )
    return out


def validate_keyframe_chain(
    keyframes: list[str],
    prompts: str | list[str],
    durations: list[float] | None,
    *,
    fps: int = 16,
) -> None:
    """校验关键帧链参数;非法抛 KeyframeChainError(2-5 帧/段 1-10s/总长 ≤25s/数齐)。"""
    plan_keyframe_chain(keyframes, prompts, durations, fps=fps)


def plan_keyframe_chain(
    keyframes: list[str],
    prompts: str | list[str],
    durations: list[float] | None,
    *,
    fps: int = 16,
    width: int = 832,
    height: int = 480,
    steps: int = 20,
    cfg: float = 5.0,
    seed: int | None = None,
) -> KeyframeChainPlan:
    """把 N 张关键帧拆为 N-1 个转场段(段 i:keyframes[i] → keyframes[i+1])。"""
    n = len(keyframes)
    if not (MIN_KEYFRAMES <= n <= MAX_KEYFRAMES):
        raise KeyframeChainError(
            f"关键帧须为 {MIN_KEYFRAMES}-{MAX_KEYFRAMES} 张(当前 {n} 张)"
        )
    if any(not k.strip() for k in keyframes):
        raise KeyframeChainError("关键帧文件名不能为空")
    n_seg = n - 1
    seg_prompts = _resolve_prompts(prompts, n_seg)
    seg_durations = _resolve_durations(durations, n_seg)
    segments = tuple(
        KeyframeSegment(
            first_frame=keyframes[i],
            last_frame=keyframes[i + 1],
            prompt=seg_prompts[i],
            duration_sec=seg_durations[i],
            frames=snap_engine_frames(
                _CHAIN_ENGINE, round(fps * seg_durations[i]), direction="up"
            ),
            steps=steps,
            cfg=cfg,
            seed=seed + i if seed is not None else None,
        )
        for i in range(n_seg)
    )
    return KeyframeChainPlan(
        segments=segments,
        total_duration=sum(seg_durations),
        fps=fps,
        width=width,
        height=height,
        seed=seed,
    )


# --------------------------------------------------------------------------- #
# 合并链(后台):等全部段产物 → concat+精确裁 → 回传 worker → 回写合并 Job
# --------------------------------------------------------------------------- #
#
# 段作业由 submit_longcat_job 各自 spawn_tracker 落库(产物保留,便于调试);
# 本链只负责把各段产物按链序拼成整条视频并回写到 kind=keyframe_chain 的合并 Job。
# 段可能处于 held(资源排队):_wait_files 自带放行跟随(hold-* 占位 → 真实 prompt_id)。


async def run_keyframe_chain_merge(
    *,
    client: Any,
    prompt_ids: list[str],
    seconds: float,
    on_final: Callable[[list[str]], Awaitable[None]] | None = None,
    merged_prompt_id: str | None = None,
    wait_files: Callable[..., Awaitable[list[dict]]] | None = None,
    ffmpeg: Callable[..., Awaitable[None]] | None = None,
) -> None:
    """按链序逐段等产物 → ffmpeg concat + -t 精确裁到总时长 → 回传 worker → 回写。

    on_final(urls):终产物回写回调(测试注入);缺省 rewrite_job_result 到
    merged_prompt_id 合并作业(二者必给其一)。任一段失败/无产物上抛 RuntimeError。
    """
    if on_final is None and merged_prompt_id is None:
        raise ValueError("run_keyframe_chain_merge 需要 on_final 或 merged_prompt_id")
    wait = wait_files or vgen._wait_files
    ff = ffmpeg or vgen._run_ffmpeg
    with tempfile.TemporaryDirectory(prefix="toiv-kfchain-") as tmp:
        tmp_dir = Path(tmp)
        seg_paths: list[Path] = []
        for i, pid in enumerate(prompt_ids):
            files = await wait(client, pid)
            if not files:
                raise RuntimeError(f"段作业 {pid} 无产物文件")
            data, _ = await client.get_image_bytes(
                files[0]["filename"],
                files[0].get("subfolder", ""),
                files[0].get("type", "output"),
            )
            seg_path = tmp_dir / f"seg-{i:03d}.mp4"
            await asyncio.to_thread(seg_path.write_bytes, data)
            seg_paths.append(seg_path)

        final_path = tmp_dir / "final.mp4"
        await vgen._concat_trim(seg_paths, final_path, seconds, ffmpeg=ff)
        final_bytes = await asyncio.to_thread(final_path.read_bytes)
        if not final_bytes:
            raise RuntimeError("链式拼接失败(ffmpeg 产物为空)")
        name = await client.upload_image(final_bytes, f"toiv_kfchain_{uuid.uuid4().hex}.mp4")
        url = image_url(client.base_url, {"filename": name, "type": "input"})
        if on_final is not None:
            await on_final([url])
        else:
            vgen.rewrite_job_result(merged_prompt_id or "", [url])


# 持有后台合并链强引用(asyncio 仅持弱引用,防 GC 提前回收;与 tracker 同一手法)
_merge_tasks: set[asyncio.Task] = set()


def _mark_chain_error(prompt_id: str) -> None:
    """合并失败:合并作业标 error 终态(段作业产物各自保留,不空转 queued)。"""
    from app.db import engine as db_engine
    from sqlmodel import Session, select

    from app.models import Job

    with Session(db_engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job is None:
            logger.warning("关键帧链合并:Job %s 不存在,跳过 error 标记", prompt_id)
            return
        job.status = "error"
        s.add(job)
        s.commit()


def spawn_keyframe_chain_merge(
    *,
    client: Any,
    prompt_ids: list[str],
    seconds: float,
    merged_prompt_id: str,
) -> None:
    """后台挂合并链。异常只记日志并标 error(段产物仍在各段 Job,不把事情搞砸)。

    挂链即把合并 Job.post_status 置 processing(前端结果区显示「拼接中」);
    成功由 rewrite_job_result 随终产物同一 commit 清零,失败在此清零并标 error。
    """
    vgen.mark_post_processing(merged_prompt_id, "processing")

    async def _runner() -> None:
        try:
            await run_keyframe_chain_merge(
                client=client,
                prompt_ids=prompt_ids,
                seconds=seconds,
                merged_prompt_id=merged_prompt_id,
            )
        except Exception as e:  # noqa: BLE001 — 后台链绝不能冒泡;段产物各自保留
            logger.warning("关键帧链合并 %s 失败(段产物仍各自保留): %s", merged_prompt_id, e)
            vgen.mark_post_processing(merged_prompt_id, "")
            _mark_chain_error(merged_prompt_id)

    task = asyncio.create_task(_runner())
    _merge_tasks.add(task)
    task.add_done_callback(_merge_tasks.discard)


def reconcile_interrupted() -> int:
    """api 重启收口:queued 的合并作业按 params 快照重挂拼接链(幂等)。

    合并任务是进程内的;重启后段作业由 tracker reconcile 自行重挂(它们是真实
    ComfyUI prompt),合并作业在此按 params.segment_prompt_ids 重建等待链——
    段已完成的直接进拼接,未完成的继续等。params 损坏的作业标 error 不空转。
    """
    from sqlmodel import Session, select

    from app.comfy.client import ComfyUIClient
    from app.config import get_settings
    from app.db import engine as db_engine
    from app.models import Job

    n = 0
    with Session(db_engine) as s:
        rows = s.exec(
            select(Job).where(Job.kind == "keyframe_chain", Job.status == "queued")  # type: ignore[attr-defined]
        ).all()
        for job in rows:
            try:
                params = json.loads(job.params or "{}")
                prompt_ids = [str(p) for p in params["segment_prompt_ids"]]
                seconds = float(params["total_duration"])
                if not prompt_ids or seconds <= 0:
                    raise ValueError("段序列空或总时长非法")
            except (KeyError, TypeError, ValueError) as e:
                logger.warning("关键帧链合并作业 %s params 损坏,标 error: %s", job.prompt_id, e)
                job.status = "error"
                s.add(job)
                s.commit()
                continue
            spawn_keyframe_chain_merge(
                client=ComfyUIClient(job.worker, timeout=get_settings().request_timeout),
                prompt_ids=prompt_ids,
                seconds=seconds,
                merged_prompt_id=job.prompt_id,
            )
            n += 1
    if n:
        logger.info("关键帧链:重挂 %d 个中断的合并作业", n)
    return n
