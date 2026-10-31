"""E 数据飞轮 —— B 评测管线的评分数据 → 偏好数据集(DPO 风格 JSONL)导出。

闭环:生成(best-of-n)→ 评分(EvalScore)→ 筛选(分差阈值 + degraded/error/空产物
排除)→ 偏好对入库(core 本地 JSONL + EvalDatasetExport 幂等票)。

筛选规则(单批次产 0 或 1 对):
  - 有效变体 = 非 degraded 且非 error 且 result 非空(result 为空/error 变体
    既不当 chosen 也不当 rejected —— 没有产物就没有可训练的对照);
  - 有效变体 < 2 → 跳过(含全灭批次),记 insufficient_valid_variants;
  - chosen = 最高分(同分 seed 升序,与 finalize 排名规则一致),
    rejected = 最低分;分差须严格大于 min_gap(默认 0.15),否则记
    gap_below_threshold —— 分差太小 = 变体无区分度,进集只是噪声。

输出:settings.pref_dataset_dir 下按导出日期滚动、SFW/NSFW 分文件
(pref_sfw_YYYY-MM-DD.jsonl / pref_nsfw_YYYY-MM-DD.jsonl),每条带 nsfw 字段。
幂等:EvalDatasetExport.batch_id 唯一,已处理批次(含不合格)直接返回既有票,
不重复写文件。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from pathlib import Path

from fastapi import HTTPException
from sqlmodel import Session, select

from app.config import get_settings
from app.db import engine
from app.models import EvalBatch, EvalDatasetExport, EvalScore

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# 偏好对构造(纯函数,便于单测)
# ---------------------------------------------------------------------------


def _has_result(result: str) -> bool:
    try:
        urls = json.loads(result or "[]")
    except json.JSONDecodeError:
        return False
    return isinstance(urls, list) and len(urls) > 0


def build_pair(
    batch: EvalBatch, records: list[EvalScore], *, min_gap: float
) -> tuple[dict | None, str]:
    """单批次偏好对构造。返回 (pair, skip_reason);合格时 skip_reason 为空。

    records 应已是「同 job_id 取最新」后的列表(调用方负责,见 _latest_scores)。
    """
    valid = [
        r for r in records if not r.degraded and not r.error and _has_result(r.result)
    ]
    if len(valid) < 2:
        return None, "insufficient_valid_variants"
    ranked = sorted(valid, key=lambda r: (-r.score, r.seed))
    chosen, rejected = ranked[0], ranked[-1]
    gap = chosen.score - rejected.score
    if round(gap, 6) <= min_gap:  # 舍入防 0.85-0.70=0.15000…2 浮点误判
        return None, "gap_below_threshold"
    pair = {
        "prompt": batch.prompt,
        "chosen": {
            "result": json.loads(chosen.result),
            "score": chosen.score,
            "seed": chosen.seed,
        },
        "rejected": {
            "result": json.loads(rejected.result),
            "score": rejected.score,
            "seed": rejected.seed,
        },
        "score_gap": round(gap, 6),
        "scorer": chosen.scorer,  # 实际产出分数的评分器(VLM 降级时为 heuristic)
        "batch_id": batch.id,
        "nsfw": batch.nsfw,
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }
    return pair, ""


# ---------------------------------------------------------------------------
# 导出(写文件 + 幂等票)
# ---------------------------------------------------------------------------


def _latest_scores(session: Session, batch_id: str) -> list[EvalScore]:
    """同 job_id 取 created_at 最新(append-only 语义,对齐 bestof.get_batch_view)。"""
    rows = session.exec(
        select(EvalScore)
        .where(EvalScore.batch_id == batch_id)
        .order_by(EvalScore.created_at.asc())  # type: ignore[attr-defined]
    ).all()
    latest: dict[str, EvalScore] = {}
    for rec in rows:
        latest[rec.job_id] = rec  # 后写覆盖 = 最新
    return list(latest.values())


def _append_pair(out_dir: Path, nsfw: bool, pair: dict) -> Path:
    out_dir.mkdir(parents=True, exist_ok=True)
    date = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    path = out_dir / f"pref_{'nsfw' if nsfw else 'sfw'}_{date}.jsonl"
    with path.open("a", encoding="utf-8") as f:
        f.write(json.dumps(pair, ensure_ascii=False) + "\n")
    return path


def export_batch(
    session: Session, batch_id: str, *, min_gap: float | None = None
) -> dict:
    """导出单批次(幂等:已处理批次直接返回既有票,不重复写文件)。

    未 done 的批次不落票(可能后续才评完),仅返回 not_done 提示。
    """
    settings = get_settings()
    gap = min_gap if min_gap is not None else settings.pref_pair_min_gap

    existing = session.exec(
        select(EvalDatasetExport).where(EvalDatasetExport.batch_id == batch_id)
    ).first()
    if existing is not None:
        return {
            "batch_id": batch_id,
            "exported": False,
            "already_processed": True,
            "pair_count": existing.pair_count,
            "file": existing.file_path or None,
            "skip_reason": existing.skip_reason,
        }

    batch = session.get(EvalBatch, batch_id)
    if batch is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    if batch.status != "done":
        return {
            "batch_id": batch_id,
            "exported": False,
            "already_processed": False,
            "pair_count": 0,
            "file": None,
            "skip_reason": "not_done",
        }

    pair, skip_reason = build_pair(batch, _latest_scores(session, batch_id), min_gap=gap)
    file_path = ""
    if pair is not None:
        file_path = str(_append_pair(Path(settings.pref_dataset_dir), batch.nsfw, pair))

    ticket = EvalDatasetExport(
        batch_id=batch_id,
        nsfw=batch.nsfw,
        pair_count=1 if pair is not None else 0,
        file_path=file_path,
        skip_reason=skip_reason,
    )
    session.add(ticket)
    session.commit()
    logger.warning(
        "批次 %s 偏好导出:%s", batch_id,
        f"写入 {file_path}" if pair is not None else f"跳过({skip_reason})",
    )
    return {
        "batch_id": batch_id,
        "exported": pair is not None,
        "already_processed": False,
        "pair_count": ticket.pair_count,
        "file": file_path or None,
        "skip_reason": skip_reason,
    }


def export_pending(session: Session, *, limit: int = 200) -> dict:
    """手动全量补导:所有 status=done 且未落票的批次(先建先导)。"""
    done = session.exec(
        select(EvalBatch)
        .where(EvalBatch.status == "done")
        .order_by(EvalBatch.created_at.asc())  # type: ignore[attr-defined]
    ).all()
    processed_ids = set(session.exec(select(EvalDatasetExport.batch_id)).all())
    results = []
    for b in done:
        if b.id in processed_ids:
            continue
        results.append(export_batch(session, b.id))
        if len(results) >= limit:
            break
    return {
        "processed": len(results),
        "pairs_written": sum(r["pair_count"] for r in results),
        "results": results,
    }


def get_stats() -> dict:
    """累计统计:已处理批次数 / 偏好对总数(SFW/NSFW 分列)/ 文件清单。"""
    settings = get_settings()
    out_dir = Path(settings.pref_dataset_dir)
    with Session(engine) as session:
        rows = session.exec(select(EvalDatasetExport)).all()
    files = (
        sorted(p.name for p in out_dir.glob("pref_*.jsonl")) if out_dir.is_dir() else []
    )
    return {
        "dataset_dir": str(out_dir),
        "batches_processed": len(rows),
        "pairs_total": sum(r.pair_count for r in rows),
        "sfw_pairs": sum(r.pair_count for r in rows if not r.nsfw),
        "nsfw_pairs": sum(r.pair_count for r in rows if r.nsfw),
        "files": files,
    }
