"""db.py 幂等迁移可观测性测试(P1-10)。

迁移失败保持「吞掉」语义(幂等设计不变),但必须留 warning 日志 ——
studioproject 缺列 500 事故的根源正是 except 裸 pass 零日志。
"""
from __future__ import annotations

import logging

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import create_engine

from app import db


@pytest.fixture
def _mem_engine(monkeypatch):
    """迁移函数读模块级 engine;换成内存库,避免碰开发库文件。"""
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(db, "engine", engine)
    return engine


def test_raw_migration_failure_logs_warning(_mem_engine, monkeypatch, caplog):
    """必失败的 raw SQL:执行不抛(幂等吞掉),但 warning 日志必须出现且含语句片段。"""
    monkeypatch.setattr(
        db, "_SQLITE_RAW_MIGRATIONS", ("CREATE TABL bogus_syntax (((",)
    )
    monkeypatch.setattr(db, "_SQLITE_MIGRATIONS", ())

    with caplog.at_level(logging.WARNING, logger="app.db"):
        db._run_column_migrations()  # 不抛异常

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("迁移跳过" in m and "CREATE TABL bogus_syntax" in m for m in warnings), warnings


def test_column_migration_failure_logs_warning(_mem_engine, monkeypatch, caplog):
    """列迁移失败(表不存在):不抛,warning 含 表.列 定位信息。"""
    monkeypatch.setattr(db, "_SQLITE_RAW_MIGRATIONS", ())
    monkeypatch.setattr(
        db, "_SQLITE_MIGRATIONS", (("no_such_table", "ghost_col", "ghost_col INTEGER"),)
    )

    with caplog.at_level(logging.WARNING, logger="app.db"):
        db._run_column_migrations()

    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("no_such_table.ghost_col" in m for m in warnings), warnings


def test_successful_migrations_no_warning(_mem_engine, monkeypatch, caplog):
    """正常迁移(合法建表 + 对已建表补已存在列)不产生 warning。"""
    monkeypatch.setattr(
        db,
        "_SQLITE_RAW_MIGRATIONS",
        ("CREATE TABLE IF NOT EXISTS mig_raw_t (id TEXT PRIMARY KEY)",),
    )
    # mig_t.ok 已存在 → 探测命中 continue,无 ALTER、无日志
    with _mem_engine.begin() as conn:
        conn.exec_driver_sql("CREATE TABLE mig_t (id TEXT PRIMARY KEY, ok TEXT)")
    monkeypatch.setattr(db, "_SQLITE_MIGRATIONS", (("mig_t", "ok", "ok TEXT"),))

    with caplog.at_level(logging.WARNING, logger="app.db"):
        db._run_column_migrations()

    assert not [r for r in caplog.records if r.levelno >= logging.WARNING]


def test_job_index_migrations_present_and_idempotent(_mem_engine):
    """P1-9:Job 表 4 条索引迁移在 raw 迁移列表中,且对既有库可重复执行。"""
    raw = " ".join(db._SQLITE_RAW_MIGRATIONS)
    for name in (
        "idx_job_prompt_id",
        "idx_job_status",
        "idx_job_created_at",
        "idx_job_status_created",
    ):
        assert f"CREATE INDEX IF NOT EXISTS {name}" in raw
    # 真跑一遍(先建 job 表再执行索引语句),重复执行不抛
    with _mem_engine.begin() as conn:
        conn.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS job (id TEXT PRIMARY KEY, prompt_id TEXT,"
            " status TEXT, created_at TIMESTAMP)"
        )
    idx_stmts = tuple(s for s in db._SQLITE_RAW_MIGRATIONS if "idx_job_" in s)
    for stmt in idx_stmts * 2:  # 跑两遍验证幂等
        with _mem_engine.begin() as conn:
            conn.exec_driver_sql(stmt)
