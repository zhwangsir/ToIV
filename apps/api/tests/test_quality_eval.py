"""视频评分器灰度观察(2026-08-27):超时配置接线 / 结构化日志 / 评分落库 / 迁移幂等。

背景:VideoScorer 旧 30s 超时对 32B VLM 长视频评分系统性降级;degraded 此前静默
return None,降级率无法统计;quality_warning 纯 SSE 瞬态无法回溯。本组锁定:
settings.video_scorer_timeout 接线、每次点火 quality_eval 结构化日志、三列落库。
"""
from __future__ import annotations

import asyncio
import json
import logging

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import SQLModel, Session, create_engine

from app.models import Job
from app.routes import jobs as jobs_route
from app.scoring import VideoScoreResult


class _Settings:
    video_scorer_enabled = True
    video_scorer_timeout = 120.0
    video_scorer_threshold = 0.65
    vlm_server_url = "http://vlm.example"
    vlm_model_id = "qwen3-vl-32b"


@pytest.fixture
def env(monkeypatch):
    """内存库 + 一条视频作业;jobs 模块的 engine/get_settings 替换为测试替身。"""
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    with Session(eng) as s:
        s.add(
            Job(
                id="j-q1", tenant_id="t1", user_id="u1", prompt_id="p-q1",
                worker="w", kind="wan_t2v", status="done", prompt="a cat",
            )
        )
        s.commit()
    monkeypatch.setattr(jobs_route, "engine", eng)
    monkeypatch.setattr(jobs_route, "get_settings", lambda: _Settings())
    return eng


class _FakeScorer:
    """VideoScorer 替身:记录构造参数,返回预置结果(每测试用例显式设置)。"""

    result: VideoScoreResult = VideoScoreResult()
    init_kwargs: dict = {}

    def __init__(self, url, model_id, timeout=30.0):  # noqa: ANN001
        type(self).init_kwargs = {"url": url, "model_id": model_id, "timeout": timeout}

    async def score(self, video_path, prompt=None):  # noqa: ANN001
        return type(self).result


def _load_job(env) -> Job:  # noqa: ANN001
    with Session(env) as s:
        return s.get(Job, "j-q1")


async def test_scorer_timeout_wired_from_settings(env, monkeypatch):
    """settings.video_scorer_timeout 传入 VideoScorer,外层 wait_for 用其 +10。"""
    _FakeScorer.result = VideoScoreResult(total=0.9, quality_score=90)
    monkeypatch.setattr(jobs_route, "VideoScorer", _FakeScorer)
    recorded: dict = {}
    real_wait_for = asyncio.wait_for

    async def _spy(coro, timeout):  # noqa: ANN001
        recorded["timeout"] = timeout
        return await real_wait_for(coro, timeout=timeout)

    monkeypatch.setattr(jobs_route.asyncio, "wait_for", _spy)

    out = await jobs_route._maybe_quality_warning(_load_job(env), "http://x/v.mp4")

    assert out is None  # 高分(≥阈值)不推 warning,既有行为不变
    assert _FakeScorer.init_kwargs == {
        "url": "http://vlm.example",
        "model_id": "qwen3-vl-32b",
        "timeout": 120.0,
    }
    assert recorded["timeout"] == pytest.approx(130.0)


async def test_degraded_persisted_and_logged(env, monkeypatch, caplog):
    """degraded 结果:落库 quality_degraded/issues + 结构化日志 reason + 返回 None。"""
    _FakeScorer.result = VideoScoreResult(degraded=True, issues=["JSON 解析失败"])
    monkeypatch.setattr(jobs_route, "VideoScorer", _FakeScorer)

    with caplog.at_level(logging.INFO, logger="app.routes.jobs"):
        out = await jobs_route._maybe_quality_warning(_load_job(env), "http://x/v.mp4")

    assert out is None
    with Session(env) as s:
        db = s.get(Job, "j-q1")
        assert db.quality_degraded is True
        assert db.quality_total == 0.0
        assert json.loads(db.quality_issues) == ["JSON 解析失败"]
    recs = [r.getMessage() for r in caplog.records if "quality_eval" in r.getMessage()]
    assert len(recs) == 1
    assert "degraded=True" in recs[0]
    assert "reason=JSON 解析失败" in recs[0]
    assert "dur_ms=" in recs[0]


async def test_low_score_persisted_and_warns(env, monkeypatch):
    """低分结果:落库 quality_total + 仍返回 quality_warning(既有行为不破坏)。"""
    _FakeScorer.result = VideoScoreResult(
        total=0.5, quality_score=55, issues=["画面模糊", "闪烁", "噪点", "第四条应被截断"]
    )
    monkeypatch.setattr(jobs_route, "VideoScorer", _FakeScorer)

    out = await jobs_route._maybe_quality_warning(_load_job(env), "http://x/v.mp4")

    assert out is not None and out["event"] == "quality_warning"
    payload = json.loads(out["data"])
    assert payload["total"] == pytest.approx(0.5)
    assert payload["quality_score"] == 55
    with Session(env) as s:
        db = s.get(Job, "j-q1")
        assert db.quality_total == pytest.approx(0.5)
        assert db.quality_degraded is False
        assert json.loads(db.quality_issues) == ["画面模糊", "闪烁", "噪点"]  # 只留前 3 条


async def test_timeout_logs_reason_without_db_write(env, monkeypatch, caplog):
    """超时路径:quality_eval 日志带 reason=timeout,返回 None,不落库、不抛异常。"""

    class _SlowScorer:
        def __init__(self, *a, **k):  # noqa: ANN002, ANN003
            pass

        async def score(self, video_path, prompt=None):  # noqa: ANN001
            await asyncio.sleep(60)

    monkeypatch.setattr(jobs_route, "VideoScorer", _SlowScorer)
    real_wait_for = asyncio.wait_for

    async def _fast(coro, timeout):  # 记录语义不变,实际超时缩到 50ms 让测试快
        return await real_wait_for(coro, timeout=0.05)

    monkeypatch.setattr(jobs_route.asyncio, "wait_for", _fast)

    with caplog.at_level(logging.WARNING, logger="app.routes.jobs"):
        out = await jobs_route._maybe_quality_warning(_load_job(env), "http://x/v.mp4")

    assert out is None
    recs = [r.getMessage() for r in caplog.records if "quality_eval" in r.getMessage()]
    assert len(recs) == 1
    assert "reason=timeout" in recs[0]
    assert "dur_ms=" in recs[0]
    with Session(env) as s:
        db = s.get(Job, "j-q1")
        assert db.quality_total is None  # 未点火语义不被污染
        assert db.quality_degraded is False


def test_job_quality_columns_migration_idempotent(monkeypatch):
    """job 表评分三列迁移幂等:对缺列旧表跑两遍不炸,列齐备。"""
    import app.db as db_mod

    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    with eng.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE job (id TEXT PRIMARY KEY, prompt_id TEXT)")
    monkeypatch.setattr(db_mod, "engine", eng)

    db_mod._run_column_migrations()  # 第一次:补列
    db_mod._run_column_migrations()  # 第二次:幂等,不应报错

    with eng.begin() as conn:
        cols = {r[1] for r in conn.exec_driver_sql("PRAGMA table_info(job)").fetchall()}
    assert {"quality_total", "quality_degraded", "quality_issues"} <= cols


def test_boolean_migrations_pg_safe_default():
    """BOOLEAN 列迁移禁 DEFAULT 0/1:PG 只认 TRUE/FALSE(2026-08-27 部署启动失败实证)。"""
    import re

    import app.db as db_mod

    for _table, _col, ddl in db_mod._SQLITE_MIGRATIONS:
        if "BOOLEAN" in ddl.upper():
            assert re.search(r"DEFAULT\s+(TRUE|FALSE)", ddl, re.IGNORECASE), (
                f"BOOLEAN 迁移须用 TRUE/FALSE 默认值(PG 不认 0/1): {ddl}"
            )
