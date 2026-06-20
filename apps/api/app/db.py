"""数据库引擎与会话（开发期 SQLite，生产可切 Postgres）。"""
from __future__ import annotations

from collections.abc import Iterator

from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

_settings = get_settings()
_connect_args = (
    {"check_same_thread": False} if _settings.database_url.startswith("sqlite") else {}
)
engine = create_engine(_settings.database_url, connect_args=_connect_args)


def init_db() -> None:
    import app.models  # noqa: F401  确保模型已注册到元数据
    SQLModel.metadata.create_all(engine)


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
