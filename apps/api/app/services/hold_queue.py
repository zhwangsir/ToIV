"""资源预算二期:hold 排队 —— 预检不足不再直接 503,作业 held 入库等资源释放。

一期(services/resource_budget)在 RAM/VRAM 不足时直接抛 503 错峰,用户只能
手工重试。二期把 503 改为 hold:作业落库(status=held + HeldJob 票,graph/原因/
所需资源快照随票入库,api 重启不丢),由本模块的调度循环周期性复查:

  held ──资源够──▶ queued(换真实 prompt_id,挂 tracker,后续流转与正常作业一致)
   │
   ├─超 TOIV_HOLD_TIMEOUT_SEC─▶ error(hold_reason 写超时说明,不无限等)
   └─作品删除(软删进回收站)─▶ 暂停放行(票保留,72h 内恢复可继续;物理删除则票作废)

防雪崩与公平:
  · 严格 FIFO(按票 created_at):队首资源仍不够本轮就停,不允许后面的作业插队;
  · 单轮放行数上限(TOIV_HOLD_RELEASE_MAX_PER_ROUND,默认 2),每张票放行前
    都独立重跑预检,不会把刚回升的资源一次打爆;
  · 复查间隔 TOIV_HOLD_CHECK_INTERVAL_SEC(默认 30s,预检可能触发缓存驱逐,
    不宜过密)。

手动干预:沿用作品删除机制(DELETE /api/jobs/{id} 软删)即可取消 held 作业。

循环依赖说明:h3/longcat/wan_video 等 services 调用本模块 place_hold,而放行时
又要重跑它们的预检 → 预检在 _precheck 内惰性 import,模块顶层不反向依赖。
"""
from __future__ import annotations

import asyncio
import json
import logging
import uuid
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.comfy.client import ComfyUIClient, ComfyUIError
from app.comfy.tracker import spawn as spawn_tracker
from app.config import get_settings
from app.db import engine
from app.models import HeldJob, Job, User
from app.versioning import params_snapshot

logger = logging.getLogger(__name__)


def holdable(exc: HTTPException) -> bool:
    """该异常是否可转 hold:开关开 + 资源类 503。

    调用方保证只把预检(ensure_*_vram/ensure_host_ram/ensure_vram)抛出的 503
    传进来;实例不可达/缺节点等 503 在调用点之前已分流,不经此判定。
    """
    return bool(get_settings().hold_queue_enabled) and exc.status_code == 503


def place_hold(
    *,
    engine: str,
    graph: dict,
    kind: str,
    positive: str,
    seed: int,
    req: BaseModel,
    user: User,
    session: Session,
    client: ComfyUIClient,
    reason: str,
    needs: dict,
    nsfw: bool = False,
) -> dict:
    """预检失败的收口:落 held Job + HeldJob 票,返回与正常提交同形状的结果 dict。

    prompt_id 为占位符(hold-*),放行后换成 worker 真实 prompt_id;
    返回多带 held/hold_reason 两个键,前端可据此显示「资源排队中」。
    """
    ticket_id = uuid.uuid4().hex
    placeholder = f"hold-{ticket_id[:16]}"
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=placeholder,
        worker=client.base_url,
        kind=kind,
        status="held",
        prompt=positive,
        seed=seed,
        nsfw=nsfw,
        params=params_snapshot(req, seed=seed),
        hold_reason=reason,
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    session.add(
        HeldJob(
            id=ticket_id,
            job_id=job.id,
            engine=engine,
            worker=client.base_url,
            graph=json.dumps(graph),
            reason=reason,
            needs=json.dumps(needs),
        )
    )
    session.commit()
    logger.warning(
        "资源不足,作业 %s(%s)进入 hold 排队: %s", job.id, engine, reason
    )
    return {
        "prompt_id": placeholder,
        "client_id": "",
        "worker": client.base_url,
        "seed": seed,
        "queued_behind": 0,
        "held": True,
        "hold_reason": reason,
    }


def _make_client(worker: str) -> ComfyUIClient:
    """按票上的 worker URL 建客户端(独立函数,测试可替换为假实例)。"""
    return ComfyUIClient(worker, timeout=get_settings().request_timeout)


async def _precheck(ticket: HeldJob, client: ComfyUIClient) -> None:
    """放行前重跑该引擎的预检(与提交时同一套,阈值取当前配置)。

    惰性 import 防循环依赖(services/h3、wan_video 都 import 本模块)。
    预检内部失败降级放行(读不到 stats)与 503(资源仍不足)语义与提交时一致。
    """
    from app.services import h3 as h3_service
    from app.services import wan_animate2 as animate2_service
    from app.services import wan_video as wan_service
    from app.services.resource_budget import ensure_host_ram, ensure_vram

    settings = get_settings()
    if ticket.engine == "h3":
        await h3_service.ensure_h3_vram(client)
    elif ticket.engine == "wan":
        await wan_service.ensure_wan_vram(client)
    elif ticket.engine == "wan_animate2":
        await animate2_service.ensure_animate2_vram(client)
    else:  # longcat(Wan 系直投,经 submit_longcat_job 非 prechecked 路径入 hold)
        await ensure_vram(client, settings.longcat_min_free_vram_gb, "LongCat")
        await ensure_host_ram(client, settings.longcat_min_free_ram_gb, "LongCat")


def _fail_job(ticket_id: str, job_id: str, message: str) -> None:
    """把 held 作业标 error 终态并删票(超时/快照损坏等不可放行场景)。"""
    with Session(engine) as session:
        job = session.get(Job, job_id)
        if job is not None and job.status == "held":
            job.status = "error"
            job.hold_reason = message
            session.add(job)
        ticket = session.get(HeldJob, ticket_id)
        if ticket is not None:
            session.delete(ticket)
        session.commit()


def _drop_ticket(ticket_id: str) -> None:
    with Session(engine) as session:
        ticket = session.get(HeldJob, ticket_id)
        if ticket is not None:
            session.delete(ticket)
            session.commit()


async def _try_release(ticket: HeldJob) -> str:
    """尝试放行一张票。返回 "released"(已提交) / "blocked"(仍等待,队首阻塞)
    / "resolved"(票已了结:作业失效或判死,可继续看下一张)。"""
    client = _make_client(ticket.worker)
    try:
        await _precheck(ticket, client)
    except HTTPException as e:
        logger.info("hold %s 资源仍不足,继续等待: %s", ticket.id, e.detail)
        return "blocked"
    except Exception as e:  # noqa: BLE001 — 预检意外失败保守处理:不放行不误杀
        logger.warning("hold %s 预检异常,本轮跳过: %s", ticket.id, e)
        return "blocked"
    try:
        graph = json.loads(ticket.graph)
    except json.JSONDecodeError:
        logger.warning("hold %s graph 快照损坏,作业标 error", ticket.id)
        _fail_job(ticket.id, ticket.job_id, "hold 快照损坏,无法放行")
        return "resolved"
    try:
        prompt_id = await client.queue_prompt(graph, uuid.uuid4().hex)
    except ComfyUIError as e:
        # 实例暂不可达等瞬时失败:票保留,下轮重试(不消耗放行名额语义上的「资源」)
        logger.warning("hold %s 放行提交失败(下轮重试): %s", ticket.id, e)
        return "blocked"
    with Session(engine) as session:
        job = session.get(Job, ticket.job_id)
        if job is None or job.status != "held":
            # 罕见竞态:预检~提交之间作业被并发处理(如物理删除)。worker 侧已入队
            # 的 prompt 无法精确回收,记日志即可(其产物无人认领,不属任何作品)。
            logger.warning(
                "hold %s 放行时作业已脱离 held(已提交 prompt %s),票作废",
                ticket.id, prompt_id,
            )
            ticket_row = session.get(HeldJob, ticket.id)
            if ticket_row is not None:
                session.delete(ticket_row)
            session.commit()
            return "resolved"
        job.prompt_id = prompt_id
        job.status = "queued"
        job.hold_reason = ""
        session.add(job)
        ticket_row = session.get(HeldJob, ticket.id)
        if ticket_row is not None:
            session.delete(ticket_row)
        session.commit()
    spawn_tracker(client, prompt_id)
    logger.warning("hold %s 资源到位已放行,作业转 queued(prompt %s)", ticket.id, prompt_id)
    return "released"


async def run_release_round() -> dict[str, int]:
    """一轮调度:失效票回收 → 超时兜底 → 严格 FIFO 放行(受单轮上限约束)。

    返回统计 {"released","timed_out","dropped"};供调度循环与测试直接调用。
    """
    settings = get_settings()
    stats = {"released": 0, "timed_out": 0, "dropped": 0}
    now = datetime.now(timezone.utc)
    with Session(engine) as session:
        tickets = session.exec(
            select(HeldJob).order_by(HeldJob.created_at)  # FIFO:先 hold 先放行
        ).all()
        # 在同一会话内取齐 Job,随后 expunge 出会话逐票处理(放行要写库,用独立会话;
        # expunge 保留已加载属性,与 tracker.reconcile_pending 取快照同一目的)
        rows = [(t, session.get(Job, t.job_id)) for t in tickets]
        session.expunge_all()
    for ticket, job in rows:
        if job is None or job.status != "held":
            # Job 物理删除(回收站 purge)或状态已脱离 held(正常不会到这里,
            # 放行的票当场删;这里是重启/并发残留的自愈)
            _drop_ticket(ticket.id)
            stats["dropped"] += 1
            continue
        if job.deleted_at is not None:
            # 软删除(回收站 72h 保留期):暂停放行但票保留,恢复后可继续
            continue
        created = ticket.created_at
        if created.tzinfo is None:  # SQLite 读出为 naive,按 UTC 解释(写入侧即 UTC)
            created = created.replace(tzinfo=timezone.utc)
        if (now - created).total_seconds() > settings.hold_timeout_sec:
            hours = settings.hold_timeout_sec / 3600.0
            _fail_job(
                ticket.id,
                ticket.job_id,
                f"资源等待超时(上限 {hours:.1f}h):{ticket.reason}",
            )
            stats["timed_out"] += 1
            logger.warning(
                "hold %s 超 %.0fs 未放行,作业标 error 回收",
                ticket.id, settings.hold_timeout_sec,
            )
            continue
        if stats["released"] >= settings.hold_release_max_per_round:
            break  # 单轮放行名额用完,其余下轮再看
        outcome = await _try_release(ticket)
        if outcome == "released":
            stats["released"] += 1
        elif outcome == "blocked":
            break  # 严格 FIFO:队首资源不够即停,不允许后面插队(防雪崩)
    return stats


async def hold_scheduler_loop() -> None:
    """hold 调度循环:周期性 run_release_round。异常不外冒(与 reconcile_loop 同原则)。"""
    interval = max(5.0, get_settings().hold_check_interval_sec)
    while True:
        await asyncio.sleep(interval)
        try:
            stats = await run_release_round()
            if any(stats.values()):
                logger.info("hold 调度轮: %s", stats)
        except Exception as e:  # noqa: BLE001 — 循环绝不能死
            logger.warning("hold 调度轮异常: %s", e)
