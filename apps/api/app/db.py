"""数据库引擎与会话（开发期 SQLite，生产可切 Postgres）。"""
from __future__ import annotations

import logging
from collections.abc import Iterator

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlmodel import Session, SQLModel, create_engine

from app.config import get_settings

logger = logging.getLogger(__name__)

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
    # 漫剧逐镜配音 wav URL(音频层),已存在的 manjushot 表需补列
    ("manjushot", "voice_url", "voice_url VARCHAR NOT NULL DEFAULT ''"),
    # 角色定妆音色 URL(音色克隆参考),manjuasset 补列
    ("manjuasset", "ref_audio", "ref_audio VARCHAR NOT NULL DEFAULT ''"),
    # 逐镜说话角色(配音持久化),manjushot 补列
    ("manjushot", "speaker", "speaker VARCHAR NOT NULL DEFAULT ''"),
    # 逐镜产物/反向词持久化(否则保存重载后分镜的已出图/视频/AI润色反向词全丢)
    ("manjushot", "negative", "negative VARCHAR NOT NULL DEFAULT ''"),
    ("manjushot", "image_url", "image_url VARCHAR NOT NULL DEFAULT ''"),
    ("manjushot", "video_url", "video_url VARCHAR NOT NULL DEFAULT ''"),
    # 版本树三列(父版本/链根/参数快照,精修迭代地基),已存在的 job 表补列
    ("job", "parent_id", "parent_id VARCHAR NOT NULL DEFAULT ''"),
    ("job", "root_id", "root_id VARCHAR NOT NULL DEFAULT ''"),
    ("job", "params", "params VARCHAR NOT NULL DEFAULT ''"),
    # 未成年防护:用户出生日期(可空,空=未填写,视为成年以兼容老数据)。
    # 可空列无需 NOT NULL DEFAULT,SQLite ADD COLUMN 直接支持。
    ('"user"', "birthdate", "birthdate DATE"),
    # D 期:LoRA 训练作业表(create_all 建新表;此条保 prod 既有库幂等)
    # trainjob 表由 SQLModel.metadata.create_all 自动创建,无需手 ALTER。
    # 智能体系统:用户当前默认智能体 id(空=走 kind 默认系统提示)
    ('"user"', "default_agent_id", "default_agent_id VARCHAR"),
    # Studio 项目产出规格(分辨率/帧率),已存在的 studioproject 表补列
    ("studioproject", "width", "width INTEGER NOT NULL DEFAULT 768"),
    ("studioproject", "height", "height INTEGER NOT NULL DEFAULT 384"),
    ("studioproject", "fps", "fps INTEGER NOT NULL DEFAULT 16"),
)

# 整段 SQL 幂等迁移(CREATE TABLE IF NOT EXISTS 等,非 ADD COLUMN 场景)。
# agents 表:create_all 已建新库;此处保 prod 既有库幂等补建。
_SQLITE_RAW_MIGRATIONS: tuple[str, ...] = (
    """
    CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT DEFAULT '',
        icon TEXT DEFAULT 'sparkles',
        applies_to TEXT DEFAULT 'all',
        system_prompt TEXT NOT NULL,
        is_nsfw INTEGER DEFAULT 0,
        is_builtin INTEGER DEFAULT 0,
        llm_model_override TEXT,
        sort INTEGER DEFAULT 100,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE TABLE IF NOT EXISTS dramasession (
        session_id      TEXT PRIMARY KEY,
        user_id         TEXT NOT NULL,
        drama_id        TEXT NOT NULL,
        video_url       TEXT NOT NULL,
        device_ua       TEXT DEFAULT '',
        device_screen   TEXT DEFAULT '',
        device_lang     TEXT DEFAULT '',
        device_platform TEXT DEFAULT '',
        started_at      TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ended_at        TIMESTAMP,
        duration_sec    REAL,
        is_completed    BOOLEAN NOT NULL DEFAULT FALSE,
        drop_off_at     REAL
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramasession_drama ON dramasession(drama_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramasession_user ON dramasession(user_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramasession_started ON dramasession(started_at)
    """,
    """
    CREATE TABLE IF NOT EXISTS dramaevent (
        id            INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id      TEXT NOT NULL UNIQUE,
        session_id    TEXT NOT NULL REFERENCES dramasession(session_id) ON DELETE CASCADE,
        user_id       TEXT NOT NULL,
        drama_id      TEXT NOT NULL,
        event_type    TEXT NOT NULL,
        current_time  REAL,
        duration      REAL,
        payload       TEXT DEFAULT '',
        client_ts     BIGINT NOT NULL,
        server_ts     TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaevent_session ON dramaevent(session_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaevent_type ON dramaevent(event_type)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaevent_drama ON dramaevent(drama_id, event_type)
    """,
    # ──────────────────────────────────────────────────────────
    # AI 短剧工作室(Drama Studio):项目/角色/分镜 三表
    # ──────────────────────────────────────────────────────────
    """
    CREATE TABLE IF NOT EXISTS dramaproject (
        id           TEXT PRIMARY KEY,
        tenant_id    TEXT NOT NULL,
        user_id      TEXT NOT NULL,
        title        TEXT NOT NULL,
        premise      TEXT DEFAULT '',
        style        TEXT DEFAULT '',
        script       TEXT DEFAULT '',
        status       TEXT DEFAULT 'draft',
        video_url    TEXT DEFAULT '',
        duration_sec REAL DEFAULT 0,
        width        INTEGER DEFAULT 768,
        height       INTEGER DEFAULT 384,
        fps          INTEGER DEFAULT 16,
        process_data TEXT DEFAULT '[]',
        created_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at   TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaproject_user ON dramaproject(tenant_id, user_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS dramacharacter (
        id             TEXT PRIMARY KEY,
        project_id     TEXT NOT NULL REFERENCES dramaproject(id) ON DELETE CASCADE,
        name           TEXT NOT NULL,
        description    TEXT DEFAULT '',
        visual_prompt  TEXT DEFAULT '',
        ref_image      TEXT DEFAULT '',
        ref_audio      TEXT DEFAULT '',
        voice_name     TEXT DEFAULT '',
        reference_front TEXT DEFAULT '',
        reference_side  TEXT DEFAULT '',
        reference_back  TEXT DEFAULT '',
        created_at     TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramacharacter_proj ON dramacharacter(project_id)
    """,
    """
    CREATE TABLE IF NOT EXISTS dramashot (
        id            TEXT PRIMARY KEY,
        project_id    TEXT NOT NULL REFERENCES dramaproject(id) ON DELETE CASCADE,
        idx           INTEGER NOT NULL,
        scene         TEXT DEFAULT '',
        prompt        TEXT DEFAULT '',
        negative      TEXT DEFAULT 'blurry, low quality, text, watermark, deformed',
        characters    TEXT DEFAULT '[]',
        dialogue      TEXT DEFAULT '',
        speaker       TEXT DEFAULT '',
        duration_sec  INTEGER DEFAULT 6,
        start_sec     REAL DEFAULT 0,
        grid_image    TEXT DEFAULT '',
        scene_layout  TEXT DEFAULT '',
        video_model   TEXT DEFAULT '',
        video_status  TEXT DEFAULT 'pending',
        video_url     TEXT DEFAULT '',
        voice_status  TEXT DEFAULT 'pending',
        voice_url     TEXT DEFAULT '',
        seed          INTEGER DEFAULT 0,
        error         TEXT DEFAULT '',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramashot_proj ON dramashot(project_id, idx)
    """,
    """
    CREATE TABLE IF NOT EXISTS dramashotcandidate (
        id            TEXT PRIMARY KEY,
        shot_id       TEXT NOT NULL REFERENCES dramashot(id) ON DELETE CASCADE,
        project_id    TEXT NOT NULL,
        url           TEXT DEFAULT '',
        seed          INTEGER DEFAULT 0,
        video_model   TEXT DEFAULT '',
        status        TEXT DEFAULT 'pending',
        is_picked     BOOLEAN NOT NULL DEFAULT FALSE,
        error         TEXT DEFAULT '',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramashotcandidate_shot ON dramashotcandidate(shot_id)
    """,
    # ── M2:跨项目资产库 ──
    """
    CREATE TABLE IF NOT EXISTS dramaasset (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        user_id         TEXT NOT NULL,
        kind            TEXT DEFAULT 'character',
        name            TEXT NOT NULL,
        description     TEXT DEFAULT '',
        visual_prompt   TEXT DEFAULT '',
        ref_image       TEXT DEFAULT '',
        ref_audio       TEXT DEFAULT '',
        voice_name      TEXT DEFAULT '',
        reference_front TEXT DEFAULT '',
        reference_side  TEXT DEFAULT '',
        reference_back  TEXT DEFAULT '',
        tags            TEXT DEFAULT '[]',
        created_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at      TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaasset_user ON dramaasset(tenant_id, user_id)
    """,
    """
    CREATE INDEX IF NOT EXISTS idx_dramaasset_kind ON dramaasset(kind)
    """,
    # ── 幂等补列:旧库升级(已有表追加新列,带 DEFAULT 不破坏数据)──
    "ALTER TABLE dramaproject ADD COLUMN process_data TEXT DEFAULT '[]'",
    "ALTER TABLE dramacharacter ADD COLUMN asset_id TEXT",
    "ALTER TABLE dramacharacter ADD COLUMN reference_front TEXT DEFAULT ''",
    "ALTER TABLE dramacharacter ADD COLUMN reference_side TEXT DEFAULT ''",
    "ALTER TABLE dramacharacter ADD COLUMN reference_back TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN grid_image TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN scene_layout TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN video_model TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN lipsync_status TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN lipsync_video_url TEXT DEFAULT ''",
    # 末帧续写(continue-video)四列
    "ALTER TABLE dramashot ADD COLUMN continue_status TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN continue_urls TEXT DEFAULT '[]'",
    "ALTER TABLE dramashot ADD COLUMN continue_concat_url TEXT DEFAULT ''",
    "ALTER TABLE dramashot ADD COLUMN continue_error TEXT DEFAULT ''",
    # ── Job 表索引(既有库幂等补建;新库由 SQLModel index=True 建 ix_job_*,
    # 与本 idx_job_* 不同名不冲突,双索引并存代价可忽略)──
    # tracker 按 prompt_id 反查 Job
    "CREATE INDEX IF NOT EXISTS idx_job_prompt_id ON job(prompt_id)",
    # tracker reconcile 每 300s 扫 queued/running
    "CREATE INDEX IF NOT EXISTS idx_job_status ON job(status)",
    "CREATE INDEX IF NOT EXISTS idx_job_created_at ON job(created_at)",
    # 复合:未终态扫描 + created_at 排序
    "CREATE INDEX IF NOT EXISTS idx_job_status_created ON job(status, created_at)",
    # ── R3.1:Agent Team 数据底座 4 表(agentrun/agenttask/agentevent/agentapproval)──
    # 新库由 SQLModel create_all 建立;此处保 prod 既有库幂等补建(PG 上 AUTOINCREMENT
    # 等 SQLite 方言报错由执行器吞掉,对应表已被 create_all 覆盖,与既有条目同双轨写法)
    """
    CREATE TABLE IF NOT EXISTS agentrun (
        id            TEXT PRIMARY KEY,
        user_id       TEXT NOT NULL,
        level         TEXT NOT NULL,
        goal          TEXT NOT NULL,
        plan_json     TEXT DEFAULT '',
        status        TEXT DEFAULT 'planning',
        checkpoint_ns TEXT DEFAULT 'agent_team',
        error         TEXT DEFAULT '',
        created_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at    TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agentrun_user ON agentrun(user_id)",
    "CREATE INDEX IF NOT EXISTS idx_agentrun_status ON agentrun(status)",
    """
    CREATE TABLE IF NOT EXISTS agenttask (
        id              TEXT PRIMARY KEY,
        run_id          TEXT NOT NULL,
        kind            TEXT NOT NULL,
        title           TEXT DEFAULT '',
        depends_on      TEXT DEFAULT '[]',
        status          TEXT DEFAULT 'pending',
        attempt         INTEGER DEFAULT 0,
        input_json      TEXT DEFAULT '{}',
        output_json     TEXT DEFAULT '{}',
        verdict_json    TEXT DEFAULT '',
        gpu_hint        TEXT DEFAULT '',
        idempotency_key TEXT DEFAULT ''
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agenttask_run ON agenttask(run_id)",
    """
    CREATE TABLE IF NOT EXISTS agentevent (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id       TEXT NOT NULL,
        ts           TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        type         TEXT NOT NULL,
        payload_json TEXT DEFAULT '{}'
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agentevent_run ON agentevent(run_id)",
    """
    CREATE TABLE IF NOT EXISTS agentapproval (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        run_id     TEXT NOT NULL,
        task_id    TEXT,
        gate       TEXT NOT NULL,
        action     TEXT NOT NULL,
        feedback   TEXT DEFAULT '',
        decided_by TEXT DEFAULT 'human',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agentapproval_run ON agentapproval(run_id)",
    # ── H2:智能体会话日志 2 表(agentsession/agentmessage)──
    # 新库由 SQLModel create_all 建立;此处保 prod 既有库幂等补建(与 agentrun 同双轨写法)
    """
    CREATE TABLE IF NOT EXISTS agentsession (
        id         TEXT PRIMARY KEY,
        user_id    TEXT NOT NULL,
        title      TEXT DEFAULT '',
        nsfw       BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agentsession_user ON agentsession(user_id)",
    """
    CREATE TABLE IF NOT EXISTS agentmessage (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        role       TEXT NOT NULL,
        content    TEXT DEFAULT '',
        tool_calls TEXT DEFAULT '',
        media      TEXT DEFAULT '',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
    """,
    "CREATE INDEX IF NOT EXISTS idx_agentmessage_session ON agentmessage(session_id)",
)


def _existing_columns(conn, table: str) -> set[str]:
    """读取某表已有列名(table 可带引号)。SQLite 用 PRAGMA,Postgres 等走 information_schema。"""
    bare = table.strip('"')
    if conn.dialect.name == "sqlite":
        rows = conn.exec_driver_sql(f'PRAGMA table_info("{bare}")').fetchall()
        return {row[1] for row in rows}
    rows = conn.exec_driver_sql(
        "SELECT column_name FROM information_schema.columns "
        f"WHERE table_name = '{bare}'"
    ).fetchall()
    return {row[0] for row in rows}


def _run_column_migrations() -> None:
    """幂等补列:已存在则跳过;竞态/重复执行时吞 duplicate column 错误。

    不破坏既有数据(纯 ADD COLUMN,带 NOT NULL DEFAULT)。SQLite 与 Postgres 通用:
    列探测按方言分支,ALTER 语句两边语法一致。
    ⚠️ 每条语句独立事务:PG 中任一语句报错会 abort 整个事务,后续语句全挂
    (如 raw 里 SQLite 方言的 AUTOINCREMENT),独立事务保证单条失败不影响其余。
    """
    # 先跑整段 SQL(CREATE TABLE IF NOT EXISTS 等,天然幂等)。
    # PG 下个别 SQLite 方言语句(如 AUTOINCREMENT)会报错,吞掉即可——
    # 对应表已由 SQLModel create_all 建立。
    for raw in _SQLITE_RAW_MIGRATIONS:
        try:
            with engine.begin() as conn:
                conn.execute(text(raw))
        except SQLAlchemyError as exc:
            # 幂等吞掉(语义不变),但必须留痕:语句前 40 字符 + 异常,否则又是静默事故
            logger.warning("迁移跳过(语句 %.40s): %s", " ".join(raw.split()), exc)
    for table, column, ddl in _SQLITE_MIGRATIONS:
        try:
            with engine.begin() as conn:
                if column in _existing_columns(conn, table):
                    continue
                conn.execute(text(f"ALTER TABLE {table} ADD COLUMN {ddl}"))
        except SQLAlchemyError as exc:
            # duplicate column(并发/重复执行)或表不存在 → 幂等吞掉,但留 warning
            # (studioproject 缺列 500 事故教训:静默吞异常让缺列长期无人发现)
            logger.warning("迁移跳过(%s.%s): %s", table, column, exc)


def init_db() -> None:
    import app.models  # noqa: F401  确保模型已注册到元数据
    SQLModel.metadata.create_all(engine)
    # 2026-08-10 起 PG 也跑列迁移:core 生产库的存量表同样需要补列,
    # 此前仅 SQLite 分支执行导致 prod studioproject 缺 width/height/fps 500。
    _run_column_migrations()


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
