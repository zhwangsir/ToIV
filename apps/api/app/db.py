"""数据库引擎与会话（开发期 SQLite，生产可切 Postgres）。"""
from __future__ import annotations

from collections.abc import Iterator

from sqlalchemy import text
from sqlalchemy.exc import OperationalError
from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

_settings = get_settings()
_connect_args = (
    {"check_same_thread": False} if _settings.database_url.startswith("sqlite") else {}
)
engine = create_engine(_settings.database_url, connect_args=_connect_args)


# R18 软开关相关的幂等迁移。create_all 只建新表、不 ALTER 既有表,
# 所以 prod 上已存在的 user/job 表需手动补列。每项 (表, 列, DDL 片段)。
_SQLITE_MIGRATIONS: tuple[tuple[str, str, str], ...] = (
    ('"user"', "nsfw_enabled", "nsfw_enabled BOOLEAN NOT NULL DEFAULT 0"),
    ("job", "nsfw", "nsfw BOOLEAN NOT NULL DEFAULT 0"),
)


def _sqlite_columns(conn, table: str) -> set[str]:
    """读取 SQLite 某表已有列名(table 可带引号,PRAGMA 需去引号)。"""
    bare = table.strip('"')
    rows = conn.exec_driver_sql(f'PRAGMA table_info("{bare}")').fetchall()
    return {row[1] for row in rows}


def _run_sqlite_migrations() -> None:
    """对 SQLite 幂等补列:已存在则跳过;竞态下吞 duplicate column 的 OperationalError。

    不破坏既有数据(纯 ADD COLUMN,带 NOT NULL DEFAULT)。Postgres 等非 SQLite
    后端不在此处处理(留给正式迁移工具)。
    """
    with engine.begin() as conn:
        for table, column, ddl in _SQLITE_MIGRATIONS:
            if column in _sqlite_columns(conn, table):
                continue
            try:
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
            except OperationalError:
                # duplicate column(并发/重复执行)→ 幂等吞掉,列已就位即可。
                pass


def init_db() -> None:
    import app.models  # noqa: F401  确保模型已注册到元数据
    SQLModel.metadata.create_all(engine)
    if _settings.database_url.startswith("sqlite"):
        _run_sqlite_migrations()


def bootstrap_admin() -> None:
    """按环境变量引导管理员:不存在则建,存在则提升为 admin。"""
    settings = get_settings()
    if not (settings.admin_email and settings.admin_password):
        return
    from sqlmodel import select

    from app.models import Tenant, User
    from app.security import hash_password

    email = settings.admin_email.strip().lower()
    with Session(engine) as session:
        user = session.exec(select(User).where(User.email == email)).first()
        if user:
            # .env 为准:同步角色与密码(改 .env 密码后重启即生效)
            user.role = "admin"
            user.hashed_password = hash_password(settings.admin_password)
            session.add(user)
            session.commit()
            return
        tenant = Tenant(name=email.split("@")[0])
        session.add(tenant)
        session.commit()
        session.refresh(tenant)
        session.add(
            User(
                email=email,
                hashed_password=hash_password(settings.admin_password),
                tenant_id=tenant.id,
                role="admin",
            )
        )
        session.commit()


def get_session() -> Iterator[Session]:
    with Session(engine) as session:
        yield session
