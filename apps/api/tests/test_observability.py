"""观测面板聚合端点(tests/test_observability.py)。

覆盖:
- 权限:非管理员 403;
- 聚合:队列分桶(queued/held/running/other)、24h 成功率(窗口外/软删除不计)、
  held 原因分布;
- GPU 拓扑归并:/system_stats 替身上报 VRAM → 卡级 max 聚合、实例清单;
- 降级:单实例探测异常 → 该实例 offline,整接口仍 200;
- 缓存:10s TTL 内二次请求不再打 /system_stats。
"""
from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.routes import observability as obs
from app.security import create_token, hash_password

# system_stats 替身返回值:每实例 8G/16G 占用,便于断言聚合数学
_FAKE_TOTAL = 16 * 1024**3
_FAKE_USED = 8 * 1024**3


def _make_user(session: Session, email: str, role: str = "user") -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        role=role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


def _make_job(session: Session, user_id: str, tenant_id: str, **kw) -> Job:
    job = Job(
        tenant_id=tenant_id,
        user_id=user_id,
        prompt_id=kw.pop("prompt_id", f"p-{kw.get('status', 'x')}-{id(kw)}"),
        worker="w1",
        **kw,
    )
    session.add(job)
    session.commit()
    return job


@pytest.fixture
def ctx(monkeypatch):
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
    obs.reset_observability_cache()

    calls: list[str] = []

    async def fake_fetch(_client, url: str) -> dict:
        calls.append(url)
        if "8197" in url:  # LongCat 实例模拟挂掉
            raise ConnectionError("boom")
        return {
            "vram_total": _FAKE_TOTAL,
            "vram_free": _FAKE_TOTAL - _FAKE_USED,
            "queue_running": 1,
            "queue_pending": 2,
        }

    monkeypatch.setattr(obs, "_fetch_instance_stats", fake_fetch)

    with Session(engine) as s:
        admin_id = _make_user(s, "admin@toiv.ai", role="admin")
        user_id = _make_user(s, "bob@toiv.ai", role="user")
        admin = s.get(User, admin_id)
        tenant_id = admin.tenant_id
        yield {
            "client": TestClient(app),
            "admin_token": create_token(admin_id),
            "user_token": create_token(user_id),
            "session_engine": engine,
            "user_id": user_id,
            "tenant_id": tenant_id,
            "calls": calls,
        }
    app.dependency_overrides.clear()
    obs.reset_observability_cache()


def _auth(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def test_forbidden_for_regular_user(ctx):
    res = ctx["client"].get("/api/observability", headers=_auth(ctx["user_token"]))
    assert res.status_code == 403


def test_aggregate_queue_success_and_held(ctx):
    engine = ctx["session_engine"]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    with Session(engine) as s:
        uid, tid = ctx["user_id"], ctx["tenant_id"]
        _make_job(s, uid, tid, status="queued")
        _make_job(s, uid, tid, status="queued")
        _make_job(s, uid, tid, status="running")
        _make_job(s, uid, tid, status="held", hold_reason="显存不足: 需 36G")
        _make_job(s, uid, tid, status="held", hold_reason="显存不足: 需 36G")
        _make_job(s, uid, tid, status="held", hold_reason="RAM 不足")
        _make_job(s, uid, tid, status="done")
        _make_job(s, uid, tid, status="done")
        _make_job(s, uid, tid, status="done")
        _make_job(s, uid, tid, status="error")
        # 窗口外(25h 前)的 done 不计入 24h 成功率
        _make_job(s, uid, tid, status="done", created_at=now - timedelta(hours=25))
        # 软删除的 queued 不计入队列
        _make_job(s, uid, tid, status="queued", deleted_at=now)

    res = ctx["client"].get("/api/observability", headers=_auth(ctx["admin_token"]))
    assert res.status_code == 200
    body = res.json()

    assert body["queue"] == {"queued": 2, "held": 3, "running": 1, "other": 0}

    succ = body["success_24h"]
    assert succ["done"] == 3 and succ["error"] == 1 and succ["total"] == 4
    assert succ["rate"] == 0.75
    assert succ["window_hours"] == 24

    held = body["held"]
    assert held["total"] == 3
    assert held["reasons"][0] == {"reason": "显存不足: 需 36G", "count": 2}
    assert {r["reason"] for r in held["reasons"]} == {"显存不足: 需 36G", "RAM 不足"}

    # GPU 拓扑:卡数 = 拓扑表行数;GPU2 三实例(8195/8197/8262)
    cards = {c["id"]: c for c in body["gpus"]}
    assert len(cards) == len(obs.GPU_TOPOLOGY)
    gpu2 = cards["GPU2"]
    assert len(gpu2["instances"]) == 3
    # 8197 挂掉 → 该实例 offline;卡仍在线(其余实例上报),卡级 VRAM = 8/16G = 50%
    inst_by_url = {i["url"]: i for i in gpu2["instances"]}
    dead = inst_by_url["http://192.168.71.127:8197"]
    assert dead["online"] is False and dead["vram_used_gb"] is None
    live = inst_by_url["http://192.168.71.127:8195"]
    assert live["online"] is True
    assert live["vram_used_gb"] == 8.0 and live["vram_total_gb"] == 16.0
    assert live["vram_used_pct"] == 50.0
    assert gpu2["online"] is True
    assert gpu2["vram_used_gb"] == 8.0 and gpu2["vram_used_pct"] == 50.0
    # 卡级队列 = 在线实例之和(8195+8262 各 running1+pending2;8197 离线计 0)
    assert gpu2["queue_running"] == 2 and gpu2["queue_pending"] == 4


def test_all_instances_down_still_200(ctx, monkeypatch):
    async def always_fail(_client, url: str) -> dict:
        raise ConnectionError("cluster down")

    monkeypatch.setattr(obs, "_fetch_instance_stats", always_fail)
    obs.reset_observability_cache()

    res = ctx["client"].get("/api/observability", headers=_auth(ctx["admin_token"]))
    assert res.status_code == 200
    body = res.json()
    assert all(c["online"] is False for c in body["gpus"])
    assert all(c["vram_used_gb"] is None for c in body["gpus"])
    assert body["queue"] == {"queued": 0, "held": 0, "running": 0, "other": 0}
    assert body["success_24h"]["rate"] is None


def test_cache_avoids_reprobe_within_ttl(ctx):
    client = ctx["client"]
    headers = _auth(ctx["admin_token"])
    n_instances = sum(len(insts) for _c, _h, insts in obs.GPU_TOPOLOGY)

    res1 = client.get("/api/observability", headers=headers)
    assert res1.status_code == 200
    first = len(ctx["calls"])
    assert first == n_instances

    res2 = client.get("/api/observability", headers=headers)
    assert res2.status_code == 200
    assert len(ctx["calls"]) == first, "TTL 内二次请求不应重新探测"
    assert res2.json()["generated_at"] == res1.json()["generated_at"]

    obs.reset_observability_cache()
    res3 = client.get("/api/observability", headers=headers)
    assert len(ctx["calls"]) == first + n_instances
    assert res3.status_code == 200


def test_series_sampling_and_alignment(ctx):
    """每次重建采样一条;各数组等长对齐;离线卡 vram_pct 为 null(8197 挂掉的 GPU2 仍在线→非 null)。"""
    client = ctx["client"]
    headers = _auth(ctx["admin_token"])

    with Session(ctx["session_engine"]) as s:
        _make_job(s, ctx["user_id"], ctx["tenant_id"], status="queued")
        _make_job(s, ctx["user_id"], ctx["tenant_id"], status="running")

    res1 = client.get("/api/observability", headers=headers)
    s1 = res1.json()["series"]
    assert len(s1["timestamps"]) == 1
    for key in ("queued", "held", "running"):
        assert len(s1[key]) == 1, f"{key} 应与 timestamps 等长"
    assert s1["queued"] == [1] and s1["running"] == [1] and s1["held"] == [0]
    card_ids = [c for c, _h, _i in obs.GPU_TOPOLOGY]
    assert list(s1["vram_pct"].keys()) == card_ids
    for cid in card_ids:
        assert len(s1["vram_pct"][cid]) == 1
    # 替身 8G/16G = 50%;GPU2 虽有一实例挂掉但卡在线 → 50.0 而非 null
    assert s1["vram_pct"]["GPU0"] == [50.0]
    assert s1["vram_pct"]["GPU2"] == [50.0]

    # 缓存命中不再采样;强制缓存过期(不动缓冲)后重建追加一条,时间戳即 generated_at
    res2 = client.get("/api/observability", headers=headers)
    assert len(res2.json()["series"]["timestamps"]) == 1, "TTL 内不应追加采样"
    obs._cache_at = 0.0
    res3 = client.get("/api/observability", headers=headers)
    body3 = res3.json()
    s3 = body3["series"]
    assert len(s3["timestamps"]) == 2
    assert s3["timestamps"][-1] == body3["generated_at"]
    assert all(len(s3[k]) == 2 for k in ("queued", "held", "running"))


def test_series_offline_card_null(ctx, monkeypatch):
    """全实例挂掉 → 每卡 vram_pct 采样为 null(保持数组长度对齐)。"""
    async def always_fail(_client, url: str) -> dict:
        raise ConnectionError("cluster down")

    monkeypatch.setattr(obs, "_fetch_instance_stats", always_fail)
    obs.reset_observability_cache()

    res = ctx["client"].get("/api/observability", headers=_auth(ctx["admin_token"]))
    assert res.status_code == 200
    series = res.json()["series"]
    assert len(series["timestamps"]) == 1
    for cid, values in series["vram_pct"].items():
        assert values == [None], f"{cid} 离线应采样 null"


def test_hourly_bucket_distribution(ctx):
    """24 个整点桶零填充升序;done/error 按 created_at 落桶;窗口外/软删除不计。"""
    engine = ctx["session_engine"]
    now = datetime.now(timezone.utc).replace(tzinfo=None)
    this_hour = now.replace(minute=0, second=0, microsecond=0)
    with Session(engine) as s:
        uid, tid = ctx["user_id"], ctx["tenant_id"]
        # 当前整点:2 done + 1 error
        _make_job(s, uid, tid, status="done", created_at=this_hour + timedelta(minutes=3))
        _make_job(s, uid, tid, status="done", created_at=this_hour + timedelta(minutes=40))
        _make_job(s, uid, tid, status="error", created_at=this_hour + timedelta(minutes=59, seconds=59))
        # 3 小时前那一桶:1 done
        _make_job(s, uid, tid, status="done", created_at=this_hour - timedelta(hours=3) + timedelta(minutes=10))
        # 24h 整点窗口外(25h 前)不计
        _make_job(s, uid, tid, status="error", created_at=this_hour - timedelta(hours=25))
        # 软删除不计
        _make_job(s, uid, tid, status="done", created_at=this_hour, deleted_at=now)
        # 非终态不影响分桶
        _make_job(s, uid, tid, status="queued", created_at=this_hour)

    res = ctx["client"].get("/api/observability", headers=_auth(ctx["admin_token"]))
    assert res.status_code == 200
    hourly = res.json()["hourly"]
    assert len(hourly) == 24
    by_hour = {b["hour"]: b for b in hourly}
    cur = by_hour[this_hour.isoformat()]
    assert cur["done"] == 2 and cur["error"] == 1
    prev = by_hour[(this_hour - timedelta(hours=3)).isoformat()]
    assert prev["done"] == 1 and prev["error"] == 0
    # 零填充:24 桶内 done 合计 = 3(25h 前那条被窗口排除)
    assert sum(b["done"] for b in hourly) == 3
    assert sum(b["error"] for b in hourly) == 1
    # 升序:首桶 = 当前整点 -23h,末桶 = 当前整点
    assert hourly[0]["hour"] == (this_hour - timedelta(hours=23)).isoformat()
    assert hourly[-1]["hour"] == this_hour.isoformat()
