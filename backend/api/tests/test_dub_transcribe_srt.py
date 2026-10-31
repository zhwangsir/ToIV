"""GET /api/dub/transcribe/{job_id}?format=srt —— 听写结果导出 SRT 字幕测试。

覆盖:SRT 时间戳格式化(_sec_to_srt_ts)/SRT 组装(_segments_to_srt)纯函数、
端点 format=json 默认行为不变、format=srt 附件下载、空 segments 400、
未完成 409、非法 format 422。作业数据直接写 DB Job(无需 mock 上游 ASR)。
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.routes import dub_text
from app.security import create_token, hash_password

_SEGMENTS = [
    {"index": 0, "start": 0.0, "end": 1.5, "text": "你好"},
    {"index": 1, "start": 1.5, "end": 3.25, "text": "世界"},
]


@pytest.fixture
def ctx():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        tenant = Tenant(name="t")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="srt@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid, tid = user.id, tenant.id
    yield TestClient(app), create_token(uid), engine, uid, tid
    app.dependency_overrides.clear()


def _auth(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _seed_job(engine, uid: str, tid: str, job_id: str, status: str, job_data: dict) -> None:
    with Session(engine) as s:
        s.add(Job(
            tenant_id=tid,
            user_id=uid,
            prompt_id=job_id,
            worker="",
            kind="transcribe",
            status=status,
            prompt="视频听写",
            result=json.dumps(job_data, ensure_ascii=False),
        ))
        s.commit()


# ── 纯函数:时间戳格式化 ─────────────────────────────────────────────
@pytest.mark.parametrize("sec,expected", [
    (0.0, "00:00:00,000"),
    (1.5, "00:00:01,500"),
    (61.25, "00:01:01,250"),
    (3599.999, "00:59:59,999"),
    (3661.5, "01:01:01,500"),   # 跨小时
    (36000.0, "10:00:00,000"),  # 两位数小时
    (-2.0, "00:00:00,000"),     # 负值钳 0
])
def test_sec_to_srt_ts(sec: float, expected: str):
    assert dub_text._sec_to_srt_ts(sec) == expected


# ── 纯函数:SRT 组装 ─────────────────────────────────────────────────
def test_segments_to_srt_format():
    srt = dub_text._segments_to_srt(_SEGMENTS)
    assert srt == (
        "1\n00:00:00,000 --> 00:00:01,500\n你好\n"
        "\n"
        "2\n00:00:01,500 --> 00:00:03,250\n世界\n"
    )


def test_segments_to_srt_single():
    srt = dub_text._segments_to_srt([{"start": 3661.5, "end": 3663.0, "text": "唯一一句"}])
    assert srt == "1\n01:01:01,500 --> 01:01:03,000\n唯一一句\n"


def test_segments_to_srt_empty():
    assert dub_text._segments_to_srt([]) == ""
    assert dub_text._segments_to_srt([{"start": 0.0, "end": 1.0, "text": "  "}]) == ""


def test_segments_to_srt_roundtrip_parse():
    """生成的 SRT 须能被自家 _parse_srt 无损解析回 segments。"""
    srt = dub_text._segments_to_srt(_SEGMENTS)
    parsed = dub_text._parse_srt(srt)
    assert [(s["start"], s["end"], s["text"]) for s in parsed] == [
        (0.0, 1.5, "你好"),
        (1.5, 3.25, "世界"),
    ]


# ── 端点:format=srt 附件下载 ─────────────────────────────────────────
def test_transcribe_srt_download(ctx):
    client, token, engine, uid, tid = ctx
    job_id = "a" * 32
    _seed_job(engine, uid, tid, job_id, "done", {
        "id": job_id, "status": "done", "stage": "完成",
        "count": 2, "segments": _SEGMENTS, "error": None,
        "progress": 100, "elapsed": 3.2,
    })
    r = client.get(f"/api/dub/transcribe/{job_id}?format=srt", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert r.headers["content-type"].startswith("application/x-subrip")
    disposition = r.headers["content-disposition"]
    assert "attachment" in disposition and '.srt"' in disposition
    assert r.text == (
        "1\n00:00:00,000 --> 00:00:01,500\n你好\n"
        "\n"
        "2\n00:00:01,500 --> 00:00:03,250\n世界\n"
    )


def test_transcribe_srt_cross_hour(ctx):
    client, token, engine, uid, tid = ctx
    job_id = "b" * 32
    _seed_job(engine, uid, tid, job_id, "done", {
        "id": job_id, "status": "done", "stage": "完成", "count": 1,
        "segments": [{"index": 0, "start": 3661.5, "end": 3665.001, "text": "跨小时"}],
        "error": None, "progress": 100, "elapsed": 1.0,
    })
    r = client.get(f"/api/dub/transcribe/{job_id}?format=srt", headers=_auth(token))
    assert r.status_code == 200, r.text
    assert "01:01:01,500 --> 01:01:05,001" in r.text


def test_transcribe_srt_no_segments_400(ctx):
    """引擎只返纯文本(segments 空)→ 400 明确文案,不造假时间戳。"""
    client, token, engine, uid, tid = ctx
    job_id = "c" * 32
    _seed_job(engine, uid, tid, job_id, "done", {
        "id": job_id, "status": "done", "stage": "完成", "count": 0,
        "segments": [], "error": None, "progress": 100, "elapsed": 1.0,
    })
    r = client.get(f"/api/dub/transcribe/{job_id}?format=srt", headers=_auth(token))
    assert r.status_code == 400
    assert "该转写结果无时间戳,无法导出 SRT" in r.json()["detail"]


def test_transcribe_srt_running_409(ctx):
    client, token, engine, uid, tid = ctx
    job_id = "d" * 32
    _seed_job(engine, uid, tid, job_id, "running", {
        "id": job_id, "status": "running", "stage": "听写中", "count": 0,
        "segments": [], "error": None, "progress": 40, "elapsed": 5.0,
    })
    r = client.get(f"/api/dub/transcribe/{job_id}?format=srt", headers=_auth(token))
    assert r.status_code == 409
    assert "听写未完成" in r.json()["detail"]


def test_transcribe_invalid_format_422(ctx):
    client, token, engine, uid, tid = ctx
    job_id = "e" * 32
    _seed_job(engine, uid, tid, job_id, "done", {
        "id": job_id, "status": "done", "segments": _SEGMENTS,
    })
    r = client.get(f"/api/dub/transcribe/{job_id}?format=vtt", headers=_auth(token))
    assert r.status_code == 422


# ── 端点:format=json 默认行为不变 ────────────────────────────────────
def test_transcribe_json_default_unchanged(ctx):
    client, token, engine, uid, tid = ctx
    job_id = "f" * 32
    _seed_job(engine, uid, tid, job_id, "done", {
        "id": job_id, "status": "done", "stage": "完成",
        "count": 2, "segments": _SEGMENTS, "error": None,
        "progress": 100, "elapsed": 3.2,
    })
    for url in (f"/api/dub/transcribe/{job_id}", f"/api/dub/transcribe/{job_id}?format=json"):
        r = client.get(url, headers=_auth(token))
        assert r.status_code == 200, r.text
        assert r.headers["content-type"].startswith("application/json")
        body = r.json()
        assert body["status"] == "done"
        assert body["segments"] == _SEGMENTS
        assert body["count"] == 2


def test_transcribe_srt_unknown_job_404(ctx):
    client, token, *_ = ctx
    r = client.get(f"/api/dub/transcribe/{'9' * 32}?format=srt", headers=_auth(token))
    assert r.status_code == 404
