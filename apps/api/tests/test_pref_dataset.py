"""E 数据飞轮测试:偏好对构造数学 / 阈值过滤 / degraded 排除 / 幂等重复导出 /
nsfw 隔离 / stats 端点 / finalize 自动导出钩子。全部 mock,不依赖真机。
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.bestof as bestof
import app.services.pref_dataset as pref_dataset
from app.config import get_settings
from app.models import EvalBatch, EvalDatasetExport, EvalScore, Job, User
from app.routes.eval_batch import preference_dataset_stats
from app.services.eval_scorers import VariantScore


@pytest.fixture
def db(monkeypatch):
    eng = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(eng)
    monkeypatch.setattr(pref_dataset, "engine", eng)
    monkeypatch.setattr(bestof, "engine", eng)
    return eng


@pytest.fixture
def out_dir():
    """conftest autouse 基件已把 pref_dataset_dir 指到 tmp,这里取回路径用。"""
    return Path(get_settings().pref_dataset_dir)


def _seed_batch(eng, *, nsfw=False, variants, status="done"):
    """直接落一个批次 + EvalScore 行。variants: dict(seed, score, degraded?, error?, result?)。"""
    with Session(eng) as s:
        batch = EvalBatch(
            tenant_id="t", user_id="u", prompt="a cat walking in rain",
            status=status, n=len(variants), nsfw=nsfw,
        )
        s.add(batch)
        s.commit()
        s.refresh(batch)
        for i, v in enumerate(variants):
            result = v.get("result", [f"/api/images?filename=v{i}.mp4&worker=http://h3"])
            s.add(EvalScore(
                batch_id=batch.id, job_id=f"j-{batch.id}-{i}", user_id="u",
                prompt=batch.prompt, result=json.dumps(result),
                seed=v["seed"], score=v["score"], scorer=v.get("scorer", "heuristic"),
                degraded=v.get("degraded", False), error=v.get("error", ""),
                rank=i + 1, is_winner=(i == 0),
            ))
        s.commit()
        return batch.id


def _read_jsonl(path: Path) -> list[dict]:
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines()]


# ---------------------------------------------------------------------------
# 1. 偏好对构造数学
# ---------------------------------------------------------------------------


def test_export_builds_dpo_pair(db, out_dir):
    batch_id = _seed_batch(db, variants=[
        {"seed": 1000, "score": 0.9},
        {"seed": 1001, "score": 0.5},
        {"seed": 1002, "score": 0.2},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    assert res["exported"] is True
    assert res["pair_count"] == 1
    assert res["skip_reason"] == ""

    lines = _read_jsonl(Path(res["file"]))
    assert len(lines) == 1
    pair = lines[0]
    assert pair["prompt"] == "a cat walking in rain"
    assert pair["batch_id"] == batch_id
    assert pair["nsfw"] is False
    assert pair["scorer"] == "heuristic"
    # chosen = 最高分,rejected = 最低分
    assert pair["chosen"]["score"] == 0.9
    assert pair["chosen"]["seed"] == 1000
    assert pair["chosen"]["result"] == ["/api/images?filename=v0.mp4&worker=http://h3"]
    assert pair["rejected"]["score"] == 0.2
    assert pair["rejected"]["seed"] == 1002
    assert pair["score_gap"] == pytest.approx(0.7)
    # 文件名:SFW + 日期滚动
    assert Path(res["file"]).name.startswith("pref_sfw_")
    assert Path(res["file"]).parent == out_dir


# ---------------------------------------------------------------------------
# 2. 阈值过滤
# ---------------------------------------------------------------------------


def test_gap_below_threshold_skipped(db, out_dir):
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.80},
        {"seed": 2, "score": 0.70},  # 分差 0.10 ≤ 0.15
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    assert res["exported"] is False
    assert res["pair_count"] == 0
    assert res["skip_reason"] == "gap_below_threshold"
    assert not list(out_dir.glob("pref_*.jsonl"))  # 不落文件


def test_gap_exactly_at_threshold_skipped(db):
    """「超过阈值」= 严格大于;等于阈值不入集。"""
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.85},
        {"seed": 2, "score": 0.70},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id, min_gap=0.15)
    assert res["exported"] is False
    assert res["skip_reason"] == "gap_below_threshold"


# ---------------------------------------------------------------------------
# 3. degraded / error / 空产物排除
# ---------------------------------------------------------------------------


def test_degraded_variants_excluded(db):
    """最高分变体 degraded → chosen 让给下一个有效变体。"""
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.95, "degraded": True},
        {"seed": 2, "score": 0.6},
        {"seed": 3, "score": 0.2},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    pair = _read_jsonl(Path(res["file"]))[0]
    assert pair["chosen"]["seed"] == 2
    assert pair["chosen"]["score"] == 0.6
    assert pair["rejected"]["seed"] == 3


def test_only_one_valid_variant_skipped(db):
    """degraded 排除后只剩 1 个有效变体 → 无法成对。"""
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.9, "degraded": True},
        {"seed": 2, "score": 0.8, "degraded": True},
        {"seed": 3, "score": 0.5},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    assert res["exported"] is False
    assert res["skip_reason"] == "insufficient_valid_variants"


def test_error_and_empty_result_not_chosen(db):
    """error / 空产物变体即使分高也不得当 chosen(质量护栏)。"""
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.99, "error": "error"},  # error 变体分被构造得很高
        {"seed": 2, "score": 0.6, "result": []},  # 空产物
        {"seed": 3, "score": 0.5},
        {"seed": 4, "score": 0.2},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    pair = _read_jsonl(Path(res["file"]))[0]
    assert pair["chosen"]["seed"] == 3
    assert pair["rejected"]["seed"] == 4


def test_all_failed_batch_skipped(db, out_dir):
    """全灭批次(所有变体 error)→ 跳过,不落文件。"""
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.0, "error": "error"},
        {"seed": 2, "score": 0.0, "error": "canceled"},
    ])
    with Session(db) as s:
        res = pref_dataset.export_batch(s, batch_id)
    assert res["exported"] is False
    assert res["skip_reason"] == "insufficient_valid_variants"
    assert not list(out_dir.glob("pref_*.jsonl"))


# ---------------------------------------------------------------------------
# 4. 幂等重复导出
# ---------------------------------------------------------------------------


def test_reexport_is_idempotent(db):
    batch_id = _seed_batch(db, variants=[
        {"seed": 1, "score": 0.9},
        {"seed": 2, "score": 0.2},
    ])
    with Session(db) as s:
        first = pref_dataset.export_batch(s, batch_id)
        second = pref_dataset.export_batch(s, batch_id)
    assert second["already_processed"] is True
    assert second["exported"] is False
    assert second["pair_count"] == 1
    # 文件不重复追加
    assert len(_read_jsonl(Path(first["file"]))) == 1
    # 幂等票一张
    with Session(db) as s:
        tickets = s.exec(
            select(EvalDatasetExport).where(EvalDatasetExport.batch_id == batch_id)
        ).all()
    assert len(tickets) == 1


def test_export_pending_only_unprocessed(db):
    """全量补导:只处理 done 且未落票的批次;generating 批次不碰。"""
    done1 = _seed_batch(db, variants=[{"seed": 1, "score": 0.9}, {"seed": 2, "score": 0.1}])
    done2 = _seed_batch(db, variants=[{"seed": 3, "score": 0.8}, {"seed": 4, "score": 0.3}])
    _seed_batch(db, status="generating", variants=[{"seed": 5, "score": 0.9}, {"seed": 6, "score": 0.1}])
    with Session(db) as s:
        res = pref_dataset.export_pending(s)
    assert res["processed"] == 2
    assert res["pairs_written"] == 2
    assert {r["batch_id"] for r in res["results"]} == {done1, done2}
    # 再跑一次:无未处理批次
    with Session(db) as s:
        res2 = pref_dataset.export_pending(s)
    assert res2["processed"] == 0


# ---------------------------------------------------------------------------
# 5. nsfw 隔离
# ---------------------------------------------------------------------------


def test_nsfw_batches_export_to_separate_file(db, out_dir):
    sfw = _seed_batch(db, variants=[{"seed": 1, "score": 0.9}, {"seed": 2, "score": 0.1}])
    nsfw = _seed_batch(db, nsfw=True, variants=[{"seed": 3, "score": 0.8}, {"seed": 4, "score": 0.2}])
    with Session(db) as s:
        res_sfw = pref_dataset.export_batch(s, sfw)
        res_nsfw = pref_dataset.export_batch(s, nsfw)

    assert Path(res_sfw["file"]).name.startswith("pref_sfw_")
    assert Path(res_nsfw["file"]).name.startswith("pref_nsfw_")
    assert res_sfw["file"] != res_nsfw["file"]
    sfw_lines = _read_jsonl(Path(res_sfw["file"]))
    nsfw_lines = _read_jsonl(Path(res_nsfw["file"]))
    assert all(p["nsfw"] is False for p in sfw_lines)
    assert all(p["nsfw"] is True for p in nsfw_lines)
    assert sfw_lines[0]["batch_id"] == sfw
    assert nsfw_lines[0]["batch_id"] == nsfw


# ---------------------------------------------------------------------------
# 6. stats 端点
# ---------------------------------------------------------------------------


async def test_stats_endpoint(db, out_dir):
    _seed_batch(db, variants=[{"seed": 1, "score": 0.9}, {"seed": 2, "score": 0.1}])
    _seed_batch(db, nsfw=True, variants=[{"seed": 3, "score": 0.8}, {"seed": 4, "score": 0.2}])
    _seed_batch(db, variants=[{"seed": 5, "score": 0.7}, {"seed": 6, "score": 0.65}])  # 分差不足
    with Session(db) as s:
        pref_dataset.export_pending(s)

    stats = await preference_dataset_stats(user=User(id="u", email="e", hashed_password="x", tenant_id="t"))
    assert stats["batches_processed"] == 3  # 不合格批次也计(落了 0 对票)
    assert stats["pairs_total"] == 2
    assert stats["sfw_pairs"] == 1
    assert stats["nsfw_pairs"] == 1
    assert len(stats["files"]) == 2
    assert any(f.startswith("pref_sfw_") for f in stats["files"])
    assert any(f.startswith("pref_nsfw_") for f in stats["files"])
    assert stats["dataset_dir"] == str(out_dir)


# ---------------------------------------------------------------------------
# 7. finalize 自动导出钩子
# ---------------------------------------------------------------------------


class _FakeScorer:
    """按 job_id 查表给分的假评分器。"""

    name = "fake"

    def __init__(self, scores: dict[str, float]):
        self.scores = scores

    async def score_variant(self, ctx):
        return VariantScore(
            total=self.scores[ctx.job_id], breakdown={}, scorer="fake",
            degraded=False, critique="",
        )


async def test_finalize_triggers_auto_export(db, out_dir):
    """finalize_batch 完成后自动导出该批次(开关默认开),幂等票落库。"""
    with Session(db) as s:
        jobs = []
        for i, seed in enumerate((1000, 1001, 1002)):
            job = Job(
                tenant_id="t", user_id="u", prompt_id=f"pid-{seed}", worker="http://h3",
                kind="h3_t2v", status="done", prompt="a cat", seed=seed,
                result=json.dumps([f"/api/images?filename=v{i}.mp4&worker=http://h3"]),
            )
            s.add(job)
            jobs.append(job)
        s.commit()
        for j in jobs:
            s.refresh(j)
        batch = EvalBatch(
            tenant_id="t", user_id="u", prompt="a cat", status="generating",
            job_ids=json.dumps([j.id for j in jobs]), seeds=json.dumps([1000, 1001, 1002]),
            n=3, scorer="fake",
        )
        s.add(batch)
        s.commit()
        s.refresh(batch)
        batch_id = batch.id
        scores = {jobs[0].id: 0.9, jobs[1].id: 0.5, jobs[2].id: 0.1}

    await bestof.finalize_batch(batch_id, scorer=_FakeScorer(scores))

    with Session(db) as s:
        ticket = s.exec(
            select(EvalDatasetExport).where(EvalDatasetExport.batch_id == batch_id)
        ).first()
    assert ticket is not None
    assert ticket.pair_count == 1
    pair = _read_jsonl(Path(ticket.file_path))[0]
    assert pair["chosen"]["score"] == 0.9
    assert pair["rejected"]["score"] == 0.1
    assert pair["scorer"] == "fake"


async def test_auto_export_respects_switch(db, out_dir, monkeypatch):
    """TOIV_PREF_EXPORT_AUTO=off 时 finalize 不导出。"""
    monkeypatch.setattr(get_settings(), "pref_export_auto", False)
    batch_id = _seed_batch(db, status="generating", variants=[
        {"seed": 1, "score": 0.9}, {"seed": 2, "score": 0.1},
    ])
    # _seed_batch 只落 EvalScore;finalize 需要 Job 行,这里直接调钩子验证开关
    assert get_settings().pref_export_auto is False
    bestof._maybe_export_preferences(batch_id)
    with Session(db) as s:
        ticket = s.exec(
            select(EvalDatasetExport).where(EvalDatasetExport.batch_id == batch_id)
        ).first()
    assert ticket is None
    assert not list(out_dir.glob("pref_*.jsonl"))
