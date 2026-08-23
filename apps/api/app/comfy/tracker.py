"""服务端作业追踪 —— 提交后即在后台把结果回写库,独立于客户端 SSE。

修复的真实 bug:历史上结果只在客户端连 `/api/jobs/{id}/events` 时由 SSE 流写库;
前端不连 / 中途断开 → 结果永不落库,任务永远停在 "queued"(用户丢图)。

这里在提交时 fire-and-forget 启动一个**轮询 /history** 的后台任务,完成即落库,
幂等。客户端 SSE 仍可连(实时进度),与本追踪共用同一套落库函数,双写无害。

ComfyUIClient 底层经模块级 AsyncClient 连接池(client.py)复用连接,
故可安全用于请求生命周期之外。
"""
from __future__ import annotations

import asyncio
import hashlib
import hmac
import json
import logging
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

from sqlmodel import Session, select

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.config import get_settings
from app.db import engine
from app.models import Job

logger = logging.getLogger(__name__)

# 持有后台任务强引用(asyncio 仅持弱引用,否则可能被 GC 提前回收)
_tasks: set[asyncio.Task] = set()
# 正在追踪的 prompt_id(spawn 按此幂等,避免同一作业被重复挂多个追踪)
_tracked: set[str] = set()

_POLL_START = 2.0
_POLL_MAX = 8.0
# 启动后 + 周期性 reconcile 间隔:重挂仍未终态作业的追踪(防 api 重启孤儿化)
_RECONCILE_INTERVAL = 300.0
# 孤儿检测的 /queue 查询间隔:每轮都查太浪费,~30s 一次足够捕捉 worker 重启
_QUEUE_CHECK_INTERVAL = 30.0
# 连续多少次「queue 与 history 均无此作业」才认定 worker 重启丢作业(防单次抖动误杀)
_ORPHAN_STRIKES = 2
# reconcile 超龄回收在追踪超时之上再留的宽限(刚超时作业的标 error 由 _track 自己完成)
_RECONCILE_GRACE = 1800.0


def image_sig(filename: str, subfolder: str, type_: str, worker: str) -> str:
    """产物代理 URL 签名(HMAC-SHA256 截断 24 hex):签名即能力,持 URL 即可取产物。

    口径必须与 /api/images 校验端一致:subfolder 缺省 ""、type 缺省 "output",
    且对未编码的原始参数值签名(查询参数解码后校验端得到同一字符串)。
    """
    key = f"toiv-img:{get_settings().jwt_secret}".encode()
    msg = f"{filename}|{subfolder}|{type_}|{worker}".encode()
    return hmac.new(key, msg, hashlib.sha256).hexdigest()[:24]


def image_url(worker: str, image: dict) -> str:
    # 规范化缺省口径与校验端一致;sig 覆盖全部定位参数,防 IDOR 枚举他人产物
    filename = image["filename"]
    subfolder = image.get("subfolder", "")
    type_ = image.get("type", "output")
    params = {
        "filename": filename,
        "subfolder": subfolder,
        "type": type_,
        "worker": worker,
        "sig": image_sig(filename, subfolder, type_, worker),
    }
    return f"/api/images?{urlencode(params)}"


def mark_status(prompt_id: str, status: str) -> None:
    """更新状态(独立短会话);已完成的作业不回退。"""
    with Session(engine) as session:
        job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = status
            session.add(job)
            session.commit()


def mark_done(prompt_id: str, urls: list[str]) -> None:
    """完成时持久化状态与产物 URL;幂等(已 done 则跳过,避免重复写)。"""
    with Session(engine) as session:
        job = session.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
        if job and job.status != "done":
            job.status = "done"
            job.result = json.dumps(urls)
            session.add(job)
            session.commit()


async def record_result(client: ComfyUIClient, prompt_id: str) -> list[str]:
    """从 ComfyUI history 取产物 → 代理 URL → 落库。幂等。供 SSE 与追踪共用。"""
    files = await client.get_result_files(prompt_id)
    urls = [image_url(client.base_url, f) for f in files]
    mark_done(prompt_id, urls)
    return urls


async def _poll_once(client: ComfyUIClient, prompt_id: str) -> str | None:
    """查一次 history。完成→落库返回 'done';执行出错→标 error;未完成→None。"""
    try:
        history = await client.get_history(prompt_id)
    except ComfyUIError:
        return None  # worker 暂不可达/历史未就绪,下次再试
    entry = history.get(prompt_id)
    if not entry:
        return None  # 还没进 history(排队 / 执行中)
    status = entry.get("status") or {}
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
    if files:
        mark_done(prompt_id, [image_url(client.base_url, f) for f in files])
        return "done"
    if status.get("status_str") == "error":
        mark_status(prompt_id, "error")
        return "error"
    if status.get("completed"):
        mark_done(prompt_id, [])  # 完成但无产物(罕见)
        return "done"
    return None


async def _orphan_check(client: ComfyUIClient, prompt_id: str) -> tuple[bool, bool]:
    """孤儿检测:返回 (orphan, in_queue)。

    orphan=True:/queue 与 /history 均无此 prompt_id(疑似 worker 重启丢作业);
    in_queue=True:仍在 worker 队列(排队/执行中)—— 调用方可据此豁免超时计数。
    worker 不可达(ComfyUIError)两者均 False:网络抖动 ≠ 孤儿,保持现有重试节奏。
    """
    get_queue = getattr(client, "get_queue", None)
    if get_queue is None:
        return False, False  # 无 /queue 能力的替身(测试假 client)不做孤儿判定
    try:
        queued = await get_queue()
    except ComfyUIError:
        return False, False
    if prompt_id in queued:
        return False, True
    # /queue 可达不代表本轮 history 查过(history 查询可能刚失败),这里独立确认
    try:
        history = await client.get_history(prompt_id)
    except ComfyUIError:
        return False, False
    return prompt_id not in history, False


async def _track(
    client: ComfyUIClient,
    prompt_id: str,
    timeout: float | None = None,
) -> None:
    """轮询 history 直到完成/出错/孤儿/超时,把结果落库(独立于任何客户端连接)。

    - 孤儿回收:worker 重启会丢队列作业,连续 _ORPHAN_STRIKES 次确认后标 error 终态;
    - 超时(默认 settings.job_track_timeout,2h 覆盖 LongCat 65min 作业)到达时
      同样标 error 终态回收,不再让作业永远停在 queued 空转。
    """
    if timeout is None:
        timeout = get_settings().job_track_timeout
    delay, waited = _POLL_START, 0.0
    strikes = 0
    # 首次孤儿检测推迟一个间隔:刚提交的作业可能尚未进入 worker /queue,避免误记 strike
    last_queue_check = time.monotonic()
    while waited < timeout:
        try:
            outcome = await _poll_once(client, prompt_id)
            if outcome is not None:
                return
        except Exception as e:  # noqa: BLE001 — 后台任务绝不能因意外冒泡而静默死掉
            logger.warning("job tracker %s poll error: %s", prompt_id, e)
        now = time.monotonic()
        if now - last_queue_check >= _QUEUE_CHECK_INTERVAL:
            last_queue_check = now
            try:
                orphan, in_queue = await _orphan_check(client, prompt_id)
            except Exception as e:  # noqa: BLE001 — 检测本身失败不误杀,下轮再试
                logger.warning("job tracker %s orphan check error: %s", prompt_id, e)
                orphan, in_queue = False, False
            if orphan:
                strikes += 1
                if strikes >= _ORPHAN_STRIKES:
                    logger.warning(
                        "job tracker %s: 连续 %d 次 queue/history 均无此作业,"
                        "按 worker 重启丢失回收为 error",
                        prompt_id,
                        strikes,
                    )
                    mark_status(prompt_id, "error")
                    return
            else:
                strikes = 0
                if in_queue:
                    # 作业仍在 worker 队列排队/执行:排队等待不计入超时窗口。
                    # 2026-08-21 教训:H3 单实例 17 段串行排队,后位作业光排队
                    # 就超 7200s,被超时误标 error 而 ComfyUI 实际全部生成成功
                    # (产物在盘上仅 DB 状态错)。超时只回收「worker 已不认识」
                    # 的作业,排队中的作业归 orphan/正常轮询管。
                    waited = 0.0
        await asyncio.sleep(delay)
        waited += delay
        delay = min(delay * 1.4, _POLL_MAX)
    logger.warning(
        "job tracker %s timed out after %.0fs, 标记 error 终态回收", prompt_id, timeout
    )
    mark_status(prompt_id, "error")


def spawn(client: ComfyUIClient, prompt_id: str) -> None:
    """提交后即启动后台追踪(fire-and-forget,保留强引用防 GC)。

    按 prompt_id 幂等:同一作业已在追踪则跳过,故 reconcile 可安全重复调用。
    """
    if prompt_id in _tracked:
        return
    _tracked.add(prompt_id)
    task = asyncio.create_task(_track(client, prompt_id))
    _tasks.add(task)

    def _cleanup(t: asyncio.Task) -> None:
        _tasks.discard(t)
        _tracked.discard(prompt_id)

    task.add_done_callback(_cleanup)


def reconcile_pending() -> int:
    """重扫库中仍未终态(queued/running)的作业并重挂追踪。

    内存追踪任务在 api 进程重启后会全部丢失 → 那些长视频作业会永远停在 "queued"。
    本函数在启动时 + 周期性调用,把它们重新接上(spawn 幂等,不会重复)。
    需在已有事件循环的上下文调用(spawn 内用 create_task)。返回重挂数量。

    超龄回收:created_at 超过 job_track_timeout + 宽限 的作业,其追踪协程早已
    超时退出(或历经多次 api 重启),重挂只会再空转一个超时周期 —— 直接标 error
    终态回收,不再 spawn。追踪协程仍在世(_tracked)的作业豁免:排队等待已由
    _track 的队列豁免不计入超时(2026-08-21 教训),存活追踪会自行终态化。
    """
    settings = get_settings()
    timeout = settings.request_timeout
    max_age = settings.job_track_timeout + _RECONCILE_GRACE
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        rows = session.exec(
            select(Job).where(Job.status.in_(("queued", "running")))  # type: ignore[attr-defined]
        ).all()
        pending: list[tuple[str, str]] = []
        stale: list[str] = []
        for j in rows:
            if not j.prompt_id or not j.worker:
                continue
            if j.prompt_id in _tracked:
                pending.append((j.prompt_id, j.worker))  # 追踪在世,不超龄回收
                continue
            created = j.created_at
            if created is not None:
                # SQLite 读出为 naive datetime,按 UTC 解释(写入侧即 UTC)
                if created.tzinfo is None:
                    created = created.replace(tzinfo=timezone.utc)
                if (now - created).total_seconds() > max_age:
                    stale.append(j.prompt_id)
                    continue
            pending.append((j.prompt_id, j.worker))
    for prompt_id in stale:
        mark_status(prompt_id, "error")
    if stale:
        logger.info(
            "reconcile: 回收 %d 个超龄(>%.0fs)未终态作业为 error", len(stale), max_age
        )
    n = 0
    for prompt_id, worker in pending:
        if prompt_id in _tracked:
            continue
        spawn(ComfyUIClient(worker, timeout=timeout), prompt_id)
        n += 1
    if n:
        logger.info("reconcile: 重挂 %d 个未终态作业的追踪", n)
    return n


async def reconcile_loop() -> None:
    """周期性 reconcile(防任何原因导致的追踪丢失,自我修复)。"""
    while True:
        await asyncio.sleep(_RECONCILE_INTERVAL)
        try:
            reconcile_pending()
        except Exception as e:  # noqa: BLE001
            logger.warning("reconcile loop error: %s", e)
 
 
async def wait_for_jobs(
    session: Session,
    prompt_ids: list[str],
    timeout: float = 300.0,
    poll_interval: float = 1.0,
) -> dict[str, list[str]]:
    """轮询数据库，等待所有指定作业完成并返回 prompt_id -> 产物 URL 列表。

    任一作业进入 error 或超时即抛出 RuntimeError。

    每轮用单条 `prompt_id IN (...)` 查询取回全部候选(替代逐 pid 的 N+1)。

    关键:每次循环前显式 commit() 结束当前事务。SQLAlchemy 同步 Session
    在第一次 SQL 时开启事务,后续 SELECT 在同一事务快照内,看不到其他
    Session(如 tracker.mark_done)的 commit → 会一直读到旧 status,直到
    超时。commit() 无 DML 时为空操作,但会结束事务,下次 SELECT 重开新
    事务,从而看到最新数据。
    """
    pending = set(prompt_ids)
    waited = 0.0
    results: dict[str, list[str]] = {}
    while pending and waited < timeout:
        # commit() 保留:纯读但会结束当前事务,下一轮 SELECT 重开新快照,
        # 才能看到 tracker.mark_done 等其他 Session 的提交(见 docstring)。
        session.commit()
        # 单条 IN 查询取回全部候选,替代逐 pid SELECT 的 N+1
        rows = session.exec(
            select(Job).where(Job.prompt_id.in_(pending))  # type: ignore[attr-defined]
        ).all()
        by_pid = {j.prompt_id: j for j in rows}
        done: set[str] = set()
        for pid in list(pending):
            job = by_pid.get(pid)
            if not job:
                raise RuntimeError(f"作业 {pid} 不存在")
            if job.status == "done":
                results[pid] = json.loads(job.result) if job.result else []
                done.add(pid)
            elif job.status == "error":
                raise RuntimeError(f"作业 {pid} 执行失败")
        pending -= done
        if not pending:
            break
        await asyncio.sleep(poll_interval)
        waited += poll_interval
    if pending:
        raise RuntimeError(f"等待作业超时: {pending}")
    return results
