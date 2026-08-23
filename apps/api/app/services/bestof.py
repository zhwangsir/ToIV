"""B 评测管线 —— best-of-n 批次提交 + 终态监听 + 自动评分 + 择优。

流程:
  1. submit_h3_best_of_n:同 prompt/参数按 seed 递增提交 n 个 H3 t2v 变体,
     每个变体走既有 h3_service.submit_h3_job 路径(就绪/显存/RAM 预检、
     资源不足自动 hold 排队,全部不绕过),落 EvalBatch 分组(job_ids 存 Job.id,
     hold 放行换 prompt_id 不影响批次跟踪);
  2. spawn_batch_watcher:后台轮询,批次内全部 Job 到终态(done/error/...)后
     触发 finalize_batch;
  3. finalize_batch:逐变体评分(VLM 失败逐变体降级启发式,不炸链路),评分落
     EvalScore(append-only),按 score 降序定 rank/winner(error 变体 score=0
     天然末位),回写 EvalBatch.status=done + winner_job_id。

幂等:finalize_batch 对已 done 的批次直接返回既有结果,重复触发不产生重复排名
(EvalScore 会插新行——append-only 语义,消费端按 created_at 取最新)。
"""
from __future__ import annotations

import asyncio
import json
import logging
import secrets
from datetime import datetime, timezone

from fastapi import HTTPException
from pydantic import BaseModel
from sqlmodel import Session, select

from app.db import engine
from app.models import EvalBatch, EvalScore, Job, User
from app.nsfw_ctx import nsfw_allowed
from app.services import h3 as h3_service
from app.services.eval_scorers import (
    ArtifactScorer,
    HeuristicScorer,
    ScorerError,
    VariantContext,
    VariantScore,
    resolve_scorer,
)
from app.versioning import params_snapshot
from app.workflows.h3_video import H3T2VParams, build_h3_t2v_graph
from app.workflows.lora import LoraSpec

logger = logging.getLogger(__name__)

_TERMINAL_STATUSES = {"done", "error", "canceled"}

# 进行中的 watcher 任务句柄(防 GC 回收;done 回调自动移除)
_WATCH_TASKS: set[asyncio.Task] = set()


# ---------------------------------------------------------------------------
# 提交
# ---------------------------------------------------------------------------


async def submit_h3_best_of_n(
    req: BaseModel,  # routes.h3_studio.H3T2VRequest(服务层不反向 import 路由,鸭子类型)
    *,
    n: int,
    scorer: str,
    user: User,
    session: Session,
) -> dict:
    """提交 n 个 H3 t2v 变体(seed 递增)并落批次分组。

    复用路由层的 LoRA 门控/时长计划与 services.h3 的提交路径(预检/hold 排队
    全保留)。v1 边界:超单段上限的分段续写(extend 链)与 resolution_target
    超分链不进评测(评的是单段原生产物),显式 422 而非静默缩水。
    中途提交失败(实例不可达等):已提交的变体作为普通作业留库,批次不建,
    异常原样抛出。
    """
    # 延迟 import 避免 services → routes 的模块级反向依赖
    from app.routes.h3_studio import _gate_h3_nsfw_loras, _resolve_plan

    _gate_h3_nsfw_loras(req.loras, user)
    plan = _resolve_plan(req)
    if plan.strategy != "direct":
        raise HTTPException(
            status_code=422,
            detail="best-of-n 评测暂不支持分段续写(duration_sec 超单段上限),请缩短时长",
        )
    if req.resolution_target:
        raise HTTPException(
            status_code=422,
            detail="best-of-n 评测不挂超分链(评原生产物),请去掉 resolution_target",
        )

    base_seed = req.seed if req.seed is not None else secrets.randbelow(2**62)
    nsfw = nsfw_allowed(user)
    job_ids: list[str] = []
    seeds: list[int] = []
    submissions: list[dict] = []
    for i in range(n):
        seed = base_seed + i
        params = H3T2VParams(
            positive=req.positive,
            negative=req.negative,
            width=req.width,
            height=req.height,
            length=plan.frames,
            steps=req.steps,
            loras=tuple(LoraSpec(name=l.name, weight=l.strength) for l in req.loras),
            seed=seed,
        )
        graph = build_h3_t2v_graph(params)
        res = await h3_service.submit_h3_job(
            graph, kind="h3_t2v", positive=params.positive, seed=seed,
            req=req, user=user, session=session, nsfw=nsfw,
        )
        # submit_h3_job 不回传 Job.id:按 prompt_id 反查(正常=worker 真实 id,
        # hold=hold-* 占位,均当次唯一);取最新一条防历史同 prompt_id 撞车
        job = session.exec(
            select(Job)
            .where(Job.prompt_id == res["prompt_id"], Job.user_id == user.id)
            .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
        ).first()
        if job is None:
            raise HTTPException(status_code=502, detail="变体作业落库后反查失败")
        job_ids.append(job.id)
        seeds.append(seed)
        submissions.append(res)

    batch = EvalBatch(
        tenant_id=user.tenant_id,
        user_id=user.id,
        engine="h3",
        kind="h3_t2v",
        prompt=req.positive,
        params=params_snapshot(req),
        seeds=json.dumps(seeds),
        job_ids=json.dumps(job_ids),
        n=n,
        scorer=scorer,
        nsfw=nsfw,
    )
    session.add(batch)
    session.commit()
    session.refresh(batch)

    spawn_batch_watcher(batch.id)
    return {
        "batch_id": batch.id,
        "n": n,
        "seeds": seeds,
        "job_ids": job_ids,
        "submissions": submissions,
        "status": batch.status,
    }


# ---------------------------------------------------------------------------
# 终态监听 → 评分
# ---------------------------------------------------------------------------


def spawn_batch_watcher(batch_id: str, *, poll_interval: float | None = None) -> asyncio.Task:
    """后台轮询批次内 Job 终态,全部终态后触发评分。句柄入 _WATCH_TASKS 防 GC。"""
    from app.config import get_settings

    poll = poll_interval or get_settings().eval_watch_poll_sec
    task = asyncio.create_task(_watch_loop(batch_id, poll))
    _WATCH_TASKS.add(task)
    task.add_done_callback(_WATCH_TASKS.discard)
    return task


def _batch_all_terminal(session: Session, batch: EvalBatch) -> bool:
    job_ids = json.loads(batch.job_ids or "[]")
    if not job_ids:
        return True
    jobs = session.exec(select(Job).where(Job.id.in_(job_ids))).all()  # type: ignore[attr-defined]
    if len(jobs) < len(job_ids):
        return False  # 有 Job 行还没落库/被物理删除,继续等(hold 票作废等场景)
    return all(j.status in _TERMINAL_STATUSES for j in jobs)


async def _watch_loop(batch_id: str, poll: float) -> None:
    try:
        while True:
            await asyncio.sleep(poll)
            with Session(engine) as session:
                batch = session.get(EvalBatch, batch_id)
                if batch is None:
                    logger.warning("批次 %s 已删除,watcher 退出", batch_id)
                    return
                if batch.status in ("scoring", "done"):
                    return  # 已被其他路径触发评分(如手动重评),不重复
                if not _batch_all_terminal(session, batch):
                    continue
            await finalize_batch(batch_id)
            return
    except Exception:
        logger.exception("批次 %s 评测 watcher 异常退出", batch_id)


def reconcile_interrupted(*, poll_interval: float | None = None) -> int:
    """api 重启收口:watcher 是进程内任务,重启后 generating 批次无人监听、
    评分中途崩的批次卡在 scoring。此处重挂——generating 重开 watcher,
    scoring 直接重调 finalize(幂等,EvalScore append-only 取最新)。
    返回重挂批次数。"""
    with Session(engine) as session:
        batches = session.exec(
            select(EvalBatch).where(EvalBatch.status.in_(["generating", "scoring"]))  # type: ignore[attr-defined]
        ).all()
        stale = [(b.id, b.status) for b in batches]
    for batch_id, status in stale:
        if status == "generating":
            spawn_batch_watcher(batch_id, poll_interval=poll_interval)
        else:
            task = asyncio.create_task(finalize_batch(batch_id))
            _WATCH_TASKS.add(task)
            task.add_done_callback(_WATCH_TASKS.discard)
    if stale:
        logger.info("评测批次收口:重挂 %d 个未完成批次", len(stale))
    return len(stale)


async def finalize_batch(
    batch_id: str,
    *,
    scorer: ArtifactScorer | None = None,
    fallback: ArtifactScorer | None = None,
) -> EvalBatch | None:
    """批次评分 + 排名 + winner。幂等:已 done 直接返回。

    scorer 缺省按批次记录的评分器名解析(resolve_scorer);VLM 逐变体失败
    (ScorerError/任何异常)降级 fallback(缺省 HeuristicScorer),记录标
    degraded=True,scorer 字段记实际产出分数的评分器。
    """
    with Session(engine) as session:
        batch = session.get(EvalBatch, batch_id)
        if batch is None:
            return None
        if batch.status == "done":
            return batch
        batch.status = "scoring"
        batch.updated_at = datetime.now(timezone.utc)
        session.add(batch)
        session.commit()

        primary = scorer or resolve_scorer(batch.scorer)
        heuristic = fallback or HeuristicScorer()
        job_ids = json.loads(batch.job_ids or "[]")
        jobs = {
            j.id: j
            for j in session.exec(select(Job).where(Job.id.in_(job_ids))).all()  # type: ignore[attr-defined]
        }

        records: list[EvalScore] = []
        for job_id in job_ids:
            job = jobs.get(job_id)
            if job is None:
                rec = EvalScore(
                    batch_id=batch_id, job_id=job_id, user_id=batch.user_id,
                    score=0.0, scorer="terminal", degraded=True,
                    error="job_missing", critique="",
                )
                records.append(rec)
                session.add(rec)
                continue
            score = await _score_job(job, primary, heuristic)
            rec = EvalScore(
                batch_id=batch_id,
                job_id=job.id,
                user_id=batch.user_id,
                prompt=job.prompt,
                params=job.params or "{}",
                result=job.result or "[]",
                seed=job.seed,
                score=score.total,
                breakdown=json.dumps(score.breakdown, ensure_ascii=False),
                scorer=score.scorer,
                degraded=score.degraded,
                critique=score.critique,
                error="" if job.status == "done" else job.status,
            )
            records.append(rec)
            session.add(rec)

        # 排名:score 降序,同分按 seed 升序(确定性);error 变体 score=0 天然末位
        ranked = sorted(records, key=lambda r: (-r.score, r.seed))
        winner_job_id = ""
        for idx, rec in enumerate(ranked):
            rec.rank = idx + 1
            rec.is_winner = False
            if idx == 0 and not rec.error and rec.score > 0:
                rec.is_winner = True
                winner_job_id = rec.job_id
            session.add(rec)

        batch.status = "done"
        batch.winner_job_id = winner_job_id
        batch.updated_at = datetime.now(timezone.utc)
        session.add(batch)
        session.commit()
        session.refresh(batch)
        logger.warning(
            "批次 %s 评分完成:winner=%s,共 %d 变体", batch_id, winner_job_id or "(无)", len(records)
        )
    _maybe_export_preferences(batch_id)
    return batch


def _maybe_export_preferences(batch_id: str) -> None:
    """数据飞轮钩子:批次评分完成后自动尝试偏好数据集导出(TOIV_PREF_EXPORT_AUTO)。

    导出失败不反向影响评测主链路(仅告警);幂等票保证重复触发不重复写文件。
    """
    from app.config import get_settings

    if not get_settings().pref_export_auto:
        return
    try:
        from app.services import pref_dataset

        with Session(engine) as session:
            pref_dataset.export_batch(session, batch_id)
    except Exception:
        logger.exception("批次 %s 偏好数据集自动导出失败(不影响评测结果)", batch_id)


async def _score_job(
    job: Job, primary: ArtifactScorer, fallback: ArtifactScorer
) -> VariantScore:
    """单变体评分:非 done 终态直接 0 分(末位);评分器失败降级 fallback。"""
    if job.status != "done" or not job.result:
        return VariantScore(
            total=0.0,
            breakdown={},
            scorer="terminal",
            degraded=True,
            critique=f"作业终态 {job.status},无产物参与评分",
        )
    try:
        params = json.loads(job.params or "{}")
        if not isinstance(params, dict):
            params = {}
    except json.JSONDecodeError:
        params = {}
    try:
        urls = json.loads(job.result or "[]")
        if not isinstance(urls, list):
            urls = []
    except json.JSONDecodeError:
        urls = []
    ctx = VariantContext(
        job_id=job.id,
        prompt=job.prompt,
        kind=job.kind,
        params=params,
        result_urls=[str(u) for u in urls],
        seed=job.seed,
    )
    try:
        return await primary.score_variant(ctx)
    except Exception as e:
        logger.warning(
            "作业 %s 评分器 %s 失败,降级 %s: %s", job.id, primary.name, fallback.name, e
        )
        score = await fallback.score_variant(ctx)
        return score.model_copy(update={"degraded": True})


# ---------------------------------------------------------------------------
# 查询(批次排名视图)
# ---------------------------------------------------------------------------


def get_batch_view(session: Session, batch_id: str, user: User) -> dict | None:
    """批次详情 + 逐变体排名(归属校验:他人批次返回 None → 路由 404)。

    EvalScore append-only:同 job_id 取 created_at 最新一条参与展示。
    """
    batch = session.get(EvalBatch, batch_id)
    if batch is None or batch.user_id != user.id:
        return None
    scores = session.exec(
        select(EvalScore)
        .where(EvalScore.batch_id == batch_id)
        .order_by(EvalScore.created_at.asc())  # type: ignore[attr-defined]
    ).all()
    latest: dict[str, EvalScore] = {}
    for rec in scores:
        latest[rec.job_id] = rec  # 同 job 后写的覆盖,即最新
    variants = sorted(
        latest.values(), key=lambda r: (r.rank or 1 << 30, r.seed)
    )
    return {
        "batch_id": batch.id,
        "engine": batch.engine,
        "kind": batch.kind,
        "prompt": batch.prompt,
        "params": json.loads(batch.params or "{}"),
        "n": batch.n,
        "scorer": batch.scorer,
        "status": batch.status,
        "winner_job_id": batch.winner_job_id,
        "nsfw": batch.nsfw,
        "created_at": batch.created_at.isoformat(),
        "variants": [
            {
                "job_id": r.job_id,
                "seed": r.seed,
                "score": r.score,
                "breakdown": json.loads(r.breakdown or "{}"),
                "scorer": r.scorer,
                "degraded": r.degraded,
                "critique": r.critique,
                "rank": r.rank,
                "is_winner": r.is_winner,
                "error": r.error,
                "result": json.loads(r.result or "[]"),
            }
            for r in variants
        ],
    }


def list_batches(session: Session, user: User, *, limit: int = 50) -> list[dict]:
    """用户批次列表(新→旧)。nsfw 批次仅 R18 上下文可见(对齐 Job 过滤语义)。"""
    stmt = select(EvalBatch).where(EvalBatch.user_id == user.id)
    if not nsfw_allowed(user):
        stmt = stmt.where(EvalBatch.nsfw.is_(False))  # type: ignore[attr-defined]
    rows = session.exec(
        stmt.order_by(EvalBatch.created_at.desc()).limit(limit)  # type: ignore[attr-defined]
    ).all()
    return [
        {
            "batch_id": b.id,
            "engine": b.engine,
            "kind": b.kind,
            "prompt": b.prompt,
            "n": b.n,
            "scorer": b.scorer,
            "status": b.status,
            "winner_job_id": b.winner_job_id,
            "nsfw": b.nsfw,
            "created_at": b.created_at.isoformat(),
        }
        for b in rows
    ]
