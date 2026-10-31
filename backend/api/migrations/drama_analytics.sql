-- PostgreSQL / SQLite 通用(SQLite 将 JSONB 改为 TEXT 即可)
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
);

CREATE INDEX IF NOT EXISTS idx_dramasession_drama ON dramasession(drama_id);
CREATE INDEX IF NOT EXISTS idx_dramasession_user   ON dramasession(user_id);
CREATE INDEX IF NOT EXISTS idx_dramasession_started ON dramasession(started_at);

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
);

CREATE INDEX IF NOT EXISTS idx_dramaevent_session ON dramaevent(session_id);
CREATE INDEX IF NOT EXISTS idx_dramaevent_type    ON dramaevent(event_type);
CREATE INDEX IF NOT EXISTS idx_dramaevent_drama   ON dramaevent(drama_id, event_type);
