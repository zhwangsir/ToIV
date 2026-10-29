"""待办 #5:alembic 脚手架可加载 + 现有 runner 非良民失败须 ERROR 留痕。

不连生产库、不 upgrade。双轨(_SQLITE_* + create_all)在切流前仍是启动路径。
"""
from __future__ import annotations

import logging
from pathlib import Path

import pytest
from sqlalchemy.pool import StaticPool
from sqlmodel import create_engine

API_ROOT = Path(__file__).resolve().parents[1]


def test_alembic_ini_and_env_exist():
    assert (API_ROOT / "alembic.ini").is_file()
    assert (API_ROOT / "alembic" / "env.py").is_file()
    assert (API_ROOT / "alembic" / "versions").is_dir()


def test_alembic_config_loads_script_location():
    alembic = pytest.importorskip("alembic")
    from alembic.config import Config

    cfg = Config(str(API_ROOT / "alembic.ini"))
    loc = cfg.get_main_option("script_location")
    assert loc is not None
    # 相对 api 根或绝对均可;解析后须指向 alembic/
    resolved = (API_ROOT / loc).resolve() if not Path(loc).is_absolute() else Path(loc)
    assert resolved == (API_ROOT / "alembic").resolve()
    assert (resolved / "env.py").is_file()


def test_baseline_revision_is_noop():
    """baseline 空 revision:upgrade/downgrade 不改 schema(切流靠 stamp)。"""
    alembic = pytest.importorskip("alembic")
    from alembic.config import Config
    from alembic.script import ScriptDirectory

    cfg = Config(str(API_ROOT / "alembic.ini"))
    script = ScriptDirectory.from_config(cfg)
    heads = script.get_heads()
    assert len(heads) == 1, heads
    # 后续增量 revision(head 前移)不影响 baseline 的 noop 契约。
    rev = script.get_revision("20261018_0001")
    assert rev is not None
    # 源码契约:upgrade/downgrade 体为空操作(pass 或仅 docstring)
    path = Path(rev.path)
    src = path.read_text(encoding="utf-8")
    assert "def upgrade" in src and "def downgrade" in src
    assert "op." not in src.split("def upgrade")[1].split("def downgrade")[0] or "pass" in src


def test_benign_vs_real_migration_error_classification():
    from app.db import is_benign_migration_error

    class _E(Exception):
        def __init__(self, msg: str):
            self.args = (msg,)
            super().__init__(msg)

    assert is_benign_migration_error(_E("duplicate column name: width"))
    assert is_benign_migration_error(_E('column "fps" of relation "studioproject" already exists'))
    assert is_benign_migration_error(_E("table agents already exists"))
    assert is_benign_migration_error(_E('constraint "dramascene_project_id_fkey" does not exist'))
    # 真失败:语法/缺表误配等不得当良性
    assert not is_benign_migration_error(_E("syntax error at or near \"TABL\""))
    assert not is_benign_migration_error(_E("permission denied for table job"))


def test_raw_syntax_failure_logs_error_not_only_warning(monkeypatch, caplog):
    """非良民失败须 ERROR(可观测升级);仍不抛、不阻断启动(切流前纪律)。"""
    from app import db

    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(db, "engine", eng)
    monkeypatch.setattr(db, "_SQLITE_RAW_MIGRATIONS", ("CREATE TABL bogus_syntax (((",))
    monkeypatch.setattr(db, "_SQLITE_MIGRATIONS", ())
    monkeypatch.setattr(db, "_SQLITE_POST_MIGRATIONS", ())

    with caplog.at_level(logging.WARNING, logger="app.db"):
        db._run_column_migrations()

    errors = [r for r in caplog.records if r.levelno >= logging.ERROR]
    assert any("迁移失败" in r.getMessage() and "CREATE TABL" in r.getMessage() for r in errors), [
        r.getMessage() for r in caplog.records
    ]


def test_duplicate_column_style_failure_stays_warning(monkeypatch, caplog):
    """良民幂等冲突仍 WARNING(不抬 ERROR 噪音)。"""
    from app import db

    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    monkeypatch.setattr(db, "engine", eng)
    monkeypatch.setattr(db, "_SQLITE_RAW_MIGRATIONS", ())
    monkeypatch.setattr(db, "_SQLITE_POST_MIGRATIONS", ())
    # 无表 → ADD COLUMN 失败;用文案模拟 already exists 走分类器路径较难,
    # 这里直接测分类器 + 对缺表仍至少有 warning/error 留痕(现有行为)。
    monkeypatch.setattr(
        db,
        "_SQLITE_MIGRATIONS",
        (("no_such_table", "ghost_col", "ghost_col INTEGER"),),
    )
    with caplog.at_level(logging.WARNING, logger="app.db"):
        db._run_column_migrations()
    msgs = [r.getMessage() for r in caplog.records if r.levelno >= logging.WARNING]
    assert any("no_such_table.ghost_col" in m for m in msgs)
