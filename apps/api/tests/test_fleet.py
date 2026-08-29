"""设备舰队端点(tests/test_fleet.py)。

覆盖:
- 注册表完整性:设备 id 唯一、必需设备在列、端口/探测类型合法、workstation
  服务清单与 AGENTS.md 分配一致(sysmetrics=True 仅 workstation);
- 权限:非管理员 403;
- 聚合:mock 单服务探测 → x/y 计数、online 三态(True/False/None)、
  headline(sysmetrics VRAM 峰值 / NAS 剩余 / 默认);
- 降级:全部探测失败 → 整接口仍 200,设备 offline 灰显;
- 详情:meta/services/sys/series 结构 + 未知设备 404;
- 缓存:TTL 内不重复探测;时序采样等长对齐。
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlmodel import Session

from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services import fleet
from app.services.fleet_registry import DEVICE_REGISTRY, DEVICES_BY_ID


# ─────────────────────────── 注册表完整性(纯数据,无需 client) ───────────────────────────


def test_registry_device_ids_unique_and_complete():
    ids = [d["id"] for d in DEVICE_REGISTRY]
    assert len(ids) == len(set(ids)), "设备 id 必须唯一"
    expected = {
        "workstation", "core", "pc01", "pc02", "nas", "spark01", "spark02",
        # studio01-04 已于 2026-08-29 全线下线,移出舰队注册表
        "openclaw01", "openclaw02", "openclaw03", "openclaw04",
        "cloud", "beijing",
    }
    assert expected <= set(ids)
    assert not {"studio01", "studio02", "studio03", "studio04"} & set(ids), \
        "Studio01-04 已下线,不得留在注册表"


def test_registry_service_specs_legal():
    for d in DEVICE_REGISTRY:
        assert d["probe_host"], f"{d['id']} 缺 probe_host"
        seen_ports: set[int] = set()
        for svc in d["services"]:
            assert svc["probe"] in ("http", "tcp", "none")
            assert 1 <= svc["port"] <= 65535
            assert svc["port"] not in seen_ports, f"{d['id']} 端口重复 {svc['port']}"
            seen_ports.add(svc["port"])
            if svc["probe"] == "http":
                assert svc.get("path", "/").startswith("/")


def test_registry_workstation_services_match_fleet():
    """workstation 关键服务端口齐全(AGENTS.md 第三节分配,OpenTalking 实测 :4403)。"""
    ports = {s["port"] for s in DEVICES_BY_ID["workstation"]["services"]}
    assert {8189, 8195, 8197, 8199, 8261, 8262, 8263, 8300, 9004,
            9200, 9201, 9202, 9203, 9210, 9211, 9220, 9302, 9304,
            9400, 9401, 9402, 9403, 4403} <= ports
    assert DEVICES_BY_ID["workstation"]["sysmetrics"] is True
    # sysmetrics 全量只挂 workstation;NAS 经 sysmetrics nas 段取数
    assert [d["id"] for d in DEVICE_REGISTRY if d.get("sysmetrics")] == ["workstation"]


# ─────────────────────────── 端点(mock 探测) ───────────────────────────

_FAKE_SYSM = {
    "cpu": {"percent": 5.0, "load1": 1.0, "load5": 1.2, "load15": 1.1, "cores": 64},
    "memory": {"total_gb": 183.8, "used_gb": 100.0, "available_gb": 83.8,
               "used_pct": 54.4},
    "disk_root": {"total_gb": 7000.0, "used_gb": 1000.0, "free_gb": 6000.0,
                  "used_pct": 14.3},
    "nas": {"mountpoint": "/home/merlin/nas_mount", "mounted": True,
            "total_gb": 44000.0, "used_gb": 13000.0, "free_gb": 31744.0},
    "gpus": [
        {"index": 0, "name": "RTX PRO 6000", "vram_used_mb": 8000,
         "vram_total_mb": 97000, "vram_used_pct": 8.2, "temp_c": 40},
        {"index": 1, "name": "RTX PRO 6000", "vram_used_mb": 80000,
         "vram_total_mb": 97000, "vram_used_pct": 82.5, "temp_c": 55},
    ],
}


def _make_user(session: Session, email: str, role: str) -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"),
                tenant_id=tenant.id, role=role)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def ctx(monkeypatch):
    from app.db import get_session
    from sqlalchemy.pool import StaticPool
    from sqlmodel import SQLModel, create_engine

    engine = create_engine("sqlite://",
                           connect_args={"check_same_thread": False},
                           poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fleet.reset_fleet_cache()

    calls: list[tuple[str, int]] = []

    async def fake_probe(_client, host: str, svc: dict) -> dict:
        calls.append((host, svc["port"]))
        base = {"name": svc["name"], "port": svc["port"],
                "latency_ms": 12.5, "extra": {}}
        if svc.get("probe") == "none":
            return {**base, "status": "unknown", "latency_ms": None}
        # pc01 全挂(模拟关机);core Redis 挂(部分降级);其余 up
        if host == "192.168.71.116":
            return {**base, "status": "down", "latency_ms": None}
        if svc["port"] == 6379:
            return {**base, "status": "down", "latency_ms": None}
        return {**base, "status": "up"}

    async def fake_sysm(_client) -> dict:
        return _FAKE_SYSM

    monkeypatch.setattr(fleet, "_probe_service", fake_probe)
    monkeypatch.setattr(fleet, "_fetch_sysmetrics", fake_sysm)

    with Session(engine) as s:
        admin_id = _make_user(s, "admin@toiv.ai", "admin")
        user_id = _make_user(s, "bob@toiv.ai", "user")
        yield {
            "client": TestClient(app),
            "admin": {"Authorization": f"Bearer {create_token(admin_id)}"},
            "user": {"Authorization": f"Bearer {create_token(user_id)}"},
            "calls": calls,
        }
    app.dependency_overrides.clear()
    fleet.reset_fleet_cache()


def test_forbidden_for_regular_user(ctx):
    assert ctx["client"].get("/api/fleet", headers=ctx["user"]).status_code == 403
    assert ctx["client"].get("/api/fleet/workstation",
                             headers=ctx["user"]).status_code == 403


def test_summary_aggregation(ctx):
    res = ctx["client"].get("/api/fleet", headers=ctx["admin"])
    assert res.status_code == 200
    body = res.json()
    devices = {d["id"]: d for d in body["devices"]}
    assert set(devices) == {d["id"] for d in DEVICE_REGISTRY}

    ws = devices["workstation"]
    assert ws["online"] is True
    assert ws["services_up"] == ws["services_total"]  # mock 全 up
    # headline 取 sysmetrics GPU VRAM 峰值 82.5 → "VRAM 峰值 82%" + RAM 54%
    assert "82" in ws["headline"] and "RAM" in ws["headline"]

    pc01 = devices["pc01"]
    assert pc01["online"] is False and pc01["services_up"] == 0
    assert pc01["headline"] == "全部离线"

    core = devices["core"]
    assert core["online"] is True  # Redis 挂但其余 up
    assert core["services_up"] == 3 and core["services_total"] == 4
    assert core["headline"] == "3/4 服务在线"

    nas = devices["nas"]
    assert nas["headline"].startswith("NAS 剩")  # 31744G → 31.0T
    assert "31" in nas["headline"]


def test_detail_structure(ctx):
    res = ctx["client"].get("/api/fleet/workstation", headers=ctx["admin"])
    assert res.status_code == 200
    body = res.json()
    assert body["meta"]["lan_ip"] == "192.168.71.127"
    assert body["meta"]["ts_ip"] == "100.68.100.90"
    assert body["meta"]["hardware"]
    assert len(body["services"]) == len(DEVICES_BY_ID["workstation"]["services"])
    svc = body["services"][0]
    assert {"name", "port", "status", "latency_ms", "extra"} <= set(svc)
    # sysmetrics 全量挂在 workstation 详情
    assert body["sys"]["memory"]["total_gb"] == 183.8
    assert len(body["sys"]["gpus"]) == 2
    # 时序:timestamps/online/latency 等长对齐
    series = body["series"]
    assert len(series["timestamps"]) == 1
    assert series["online"] == [1]
    for name, values in series["latency"].items():
        assert len(values) == 1, f"{name} 延迟序列应与 timestamps 等长"
    assert series["latency"]["ComfyUI 通用"] == [12.5]


def test_detail_nas_sys_section(ctx):
    body = ctx["client"].get("/api/fleet/nas", headers=ctx["admin"]).json()
    assert body["sys"]["nas"]["mounted"] is True
    assert body["sys"]["nas"]["free_gb"] == 31744.0
    assert "memory" not in body["sys"]  # NAS 只取 nas 段


def test_detail_unknown_device_404(ctx):
    res = ctx["client"].get("/api/fleet/nonexistent", headers=ctx["admin"])
    assert res.status_code == 404


def test_all_probes_down_still_200(ctx, monkeypatch):
    async def always_down(_client, host, svc):
        return {"name": svc["name"], "port": svc["port"], "status": "down",
                "latency_ms": None, "extra": {}}

    async def no_sysm(_client):
        return None

    monkeypatch.setattr(fleet, "_probe_service", always_down)
    monkeypatch.setattr(fleet, "_fetch_sysmetrics", no_sysm)
    fleet.reset_fleet_cache()

    res = ctx["client"].get("/api/fleet", headers=ctx["admin"])
    assert res.status_code == 200
    body = res.json()
    assert all(d["online"] is False for d in body["devices"])
    assert all(d["headline"] == "全部离线" for d in body["devices"])

    detail = ctx["client"].get("/api/fleet/workstation",
                               headers=ctx["admin"]).json()
    assert detail["sys"] is None
    assert detail["series"]["online"] == [0]


def test_cache_avoids_reprobe_within_ttl(ctx):
    client, headers = ctx["client"], ctx["admin"]
    n_services = sum(len(d["services"]) for d in DEVICE_REGISTRY)

    res1 = client.get("/api/fleet", headers=headers)
    assert res1.status_code == 200
    first = len(ctx["calls"])
    assert first == n_services

    res2 = client.get("/api/fleet/workstation", headers=headers)
    assert res2.status_code == 200
    assert len(ctx["calls"]) == first, "TTL 内详情请求应命中缓存不重探"

    fleet._cache_at = 0.0  # 强制过期(保留时序缓冲)
    res3 = client.get("/api/fleet", headers=headers)
    assert res3.status_code == 200
    assert len(ctx["calls"]) == first + n_services
    detail = client.get("/api/fleet/pc01", headers=headers).json()
    assert len(detail["series"]["timestamps"]) == 2
    assert detail["series"]["online"] == [0, 0]
