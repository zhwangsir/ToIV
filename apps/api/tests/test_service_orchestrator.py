"""按需资源分配 R1:冷层服务编排(services/service_orchestrator + routes/orch)。

覆盖:
  · 注册表:内置四服务默认值 / TOIV_ORCH_SERVICES 覆盖合并(dict+list 形态) /
    非法 JSON 回退默认 / unit 注入字符剔除;
  · SSH argv 构造与 _run_systemctl 返回码透传(子进程全 mock,不真连任何设备);
  · mark_request:打点更新 / 未知服务 False;
  · ensure_running:running 短路(不发 SSH)/ stopped→waking→running 成功路径
    (审计 orch.wake)/ SSH 失败 502 + error + orch.wake_failed / 健康检查超时
    504 + error + orch.wake_failed / health_path 空串走 TCP 探测;
  · idle_sweep:safe_idle=true 且闲置超阈值回收(审计 orch.sleep)/ 默认
    safe_idle=false 不动 / 近期有请求不动 / 从未打点不动 / 有关联活跃 Job 不动 /
    关联作业已终态则回收;
  · 端点:GET 仅 admin(401/403/200 + 载荷结构)、wake 需登录(401)/ 用户唤醒
    成功 / 未知服务 404。
"""
from __future__ import annotations

import json
import time

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.service_orchestrator as orch
from app.config import get_settings
from app.db import get_session
from app.main import app
from app.models import AuditLog, Job, Tenant, User
from app.security import create_token, hash_password


# --------------------------------------------------------------------------- #
# 公共 fixtures / fakes
# --------------------------------------------------------------------------- #


@pytest.fixture(autouse=True)
def _isolate():
    """编排器模块级状态(注册表缓存/状态机/锁)用例间隔离。"""
    orch.reset_orchestrator()
    yield
    orch.reset_orchestrator()


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    return eng


@pytest.fixture
def orch_db(engine, monkeypatch):
    """编排器的审计/作业查询落到测试库(模块级 engine 替身,同 hold_queue 测试模式)。"""
    monkeypatch.setattr(orch, "engine", engine)
    return engine


class _FakeSSH:
    """_run_systemctl 替身:记录 (服务名, action),返回可控 returncode。"""

    def __init__(self, rc: int = 0):
        self.calls: list[tuple[str, str]] = []
        self.rc = rc

    async def __call__(self, spec, action: str):
        self.calls.append((spec.name, action))
        return self.rc, "" if self.rc == 0 else "Permission denied"


def _patch_ssh(monkeypatch, rc: int = 0) -> _FakeSSH:
    fake = _FakeSSH(rc)
    monkeypatch.setattr(orch, "_run_systemctl", fake)
    return fake


def _patch_health_ok(monkeypatch, seen_status: list[str] | None = None):
    async def healthy(spec) -> bool:
        if seen_status is not None:
            seen_status.append(orch._state(spec.name).status)
        return True

    monkeypatch.setattr(orch, "_check_health", healthy)


def _set_running(name: str, idle_for: float = 0.0) -> None:
    st = orch._state(name)
    st.status = "running"
    st.last_request_at = time.time() - idle_for


def _audit_actions(engine) -> list[str]:
    with Session(engine) as s:
        return [row.action for row in s.exec(select(AuditLog)).all()]


# --------------------------------------------------------------------------- #
# 注册表
# --------------------------------------------------------------------------- #


def test_registry_defaults_four_cold_services():
    reg = orch.get_registry()
    assert set(reg) == {"i2l", "trainer", "lipsync", "hy3dtex"}
    i2l = reg["i2l"]
    assert i2l.systemd_unit == "toiv-i2l.service"
    assert i2l.host == "192.168.71.127"
    assert i2l.port == 9101
    assert i2l.health_path == "/health"
    assert i2l.tier == "cold"
    assert i2l.safe_idle is False  # 默认保守:不自动回收
    assert i2l.idle_timeout_sec == 0  # 0 = 用全局默认 900
    assert reg["trainer"].port == 9100
    assert reg["lipsync"].port == 9103 and reg["lipsync"].job_kinds == ("lipsync",)
    assert reg["hy3dtex"].port == 9404 and reg["hy3dtex"].job_kinds == ("threed_texture",)


def test_registry_env_override_merges(monkeypatch):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({
            "i2l": {"safe_idle": True, "idle_timeout_sec": 300},
            "myagent": {"systemd_unit": "toiv-myagent.service",
                        "host": "192.168.71.127", "port": 9500,
                        "health_path": "", "safe_idle": True},
        }),
    )
    orch.reset_orchestrator()
    reg = orch.get_registry()
    assert reg["i2l"].safe_idle is True
    assert reg["i2l"].idle_timeout_sec == 300
    assert reg["i2l"].port == 9101  # 未覆盖字段继承内置默认
    assert reg["myagent"].port == 9500 and reg["myagent"].health_path == ""
    assert reg["trainer"].safe_idle is False  # 未提及服务不受影响


def test_registry_env_override_list_form(monkeypatch):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps([{"name": "lipsync", "idle_timeout_sec": 60}]),
    )
    orch.reset_orchestrator()
    assert orch.get_registry()["lipsync"].idle_timeout_sec == 60


def test_registry_invalid_json_keeps_defaults(monkeypatch):
    monkeypatch.setattr(get_settings(), "orch_services", "{not-json")
    orch.reset_orchestrator()
    assert set(orch.get_registry()) == {"i2l", "trainer", "lipsync", "hy3dtex"}


def test_registry_rejects_unit_injection(monkeypatch):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({
            "evil": {"systemd_unit": "x.service; rm -rf /",
                     "host": "192.168.71.127", "port": 9500},
            "i2l": {"systemd_unit": "a.service && reboot"},  # 覆盖把内置改非法
        }),
    )
    orch.reset_orchestrator()
    reg = orch.get_registry()
    assert "evil" not in reg
    assert "i2l" not in reg  # 非法覆盖连同内置一并剔除,不放行
    assert "trainer" in reg


# --------------------------------------------------------------------------- #
# SSH / 健康检查构造
# --------------------------------------------------------------------------- #


def test_ssh_argv_shape():
    spec = orch.get_spec("i2l")
    argv = orch._ssh_argv(spec, "start")
    assert argv[0] == "ssh"
    assert "BatchMode=yes" in argv and "ConnectTimeout=10" in argv
    assert argv[-2] == get_settings().orch_ssh_target  # 默认 workstation 别名
    assert argv[-1] == "sudo -n systemctl start toiv-i2l.service"


async def test_run_systemctl_passthrough(monkeypatch):
    """子进程替身:返回码与 stderr 尾部透传(不真起进程)。"""

    class _Proc:
        returncode = 3

        async def communicate(self):
            return b"", b"Permission denied"

    async def fake_exec(*argv, **kw):
        return _Proc()

    monkeypatch.setattr(orch.asyncio, "create_subprocess_exec", fake_exec)
    rc, tail = await orch._run_systemctl(orch.get_spec("i2l"), "start")
    assert rc == 3 and "denied" in tail


# --------------------------------------------------------------------------- #
# mark_request
# --------------------------------------------------------------------------- #


def test_mark_request_known_updates_timestamp():
    assert orch.mark_request("i2l") is True
    st = orch._state("i2l")
    assert st.last_request_at is not None
    assert abs(time.time() - st.last_request_at) < 5


def test_mark_request_unknown_returns_false():
    assert orch.mark_request("nonexistent") is False
    assert "nonexistent" not in orch._states


# --------------------------------------------------------------------------- #
# ensure_running
# --------------------------------------------------------------------------- #


async def test_ensure_running_already_running_skips_ssh(monkeypatch, orch_db):
    ssh = _patch_ssh(monkeypatch)
    _set_running("i2l")
    snap = await orch.ensure_running("i2l")
    assert snap["status"] == "running"
    assert ssh.calls == [], "running 态不应再发 SSH"


async def test_ensure_running_success_path(monkeypatch, orch_db):
    ssh = _patch_ssh(monkeypatch)
    seen: list[str] = []
    _patch_health_ok(monkeypatch, seen_status=seen)

    snap = await orch.ensure_running("lipsync")
    assert snap["status"] == "running"
    assert snap["wake_count"] == 1
    assert ssh.calls == [("lipsync", "start")]
    assert seen and all(s == "waking" for s in seen), "健康轮询期间应处于 waking 态"
    assert _audit_actions(orch_db) == ["orch.wake"]


async def test_ensure_running_ssh_failure_502(monkeypatch, orch_db):
    _patch_ssh(monkeypatch, rc=1)
    health_called = False

    async def health(spec):
        nonlocal health_called
        health_called = True
        return True

    monkeypatch.setattr(orch, "_check_health", health)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await orch.ensure_running("i2l")
    assert exc.value.status_code == 502
    st = orch._state("i2l")
    assert st.status == "error" and "rc=1" in st.last_error
    assert health_called is False, "SSH 失败不应再探健康"
    assert _audit_actions(orch_db) == ["orch.wake_failed"]


async def test_ensure_running_health_timeout_504(monkeypatch, orch_db):
    _patch_ssh(monkeypatch)

    async def never_healthy(spec) -> bool:
        return False

    monkeypatch.setattr(orch, "_check_health", never_healthy)
    monkeypatch.setattr(orch, "WAKE_POLL_INTERVAL_SEC", 0.01)
    monkeypatch.setattr(get_settings(), "orch_wake_timeout_sec", 0.05)

    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await orch.ensure_running("trainer")
    assert exc.value.status_code == 504
    assert orch._state("trainer").status == "error"
    assert _audit_actions(orch_db) == ["orch.wake_failed"]


async def test_ensure_running_tcp_health_fallback(monkeypatch, orch_db):
    """health_path 空串 → TCP 连通探测(不発 HTTP)。"""
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({"myagent": {"systemd_unit": "toiv-myagent.service",
                                "host": "192.168.71.127", "port": 9500,
                                "health_path": ""}}),
    )
    orch.reset_orchestrator()
    _patch_ssh(monkeypatch)
    tcp_calls: list[tuple[str, int]] = []

    async def fake_tcp(host: str, port: int) -> bool:
        tcp_calls.append((host, port))
        return True

    monkeypatch.setattr(orch, "_tcp_probe", fake_tcp)

    snap = await orch.ensure_running("myagent")
    assert snap["status"] == "running"
    assert tcp_calls == [("192.168.71.127", 9500)]


async def test_ensure_running_unknown_404(orch_db):
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        await orch.ensure_running("nonexistent")
    assert exc.value.status_code == 404


# --------------------------------------------------------------------------- #
# idle_sweep
# --------------------------------------------------------------------------- #


def _make_safe_idle(monkeypatch, name: str = "lipsync", **extra):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({name: {"safe_idle": True, **extra}}),
    )
    orch.reset_orchestrator()


async def test_idle_sweep_stops_idle_safe_service(monkeypatch, orch_db):
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    _set_running("lipsync", idle_for=2000.0)  # 超默认 900s 阈值

    result = await orch.idle_sweep()
    assert result["stopped"] == ["lipsync"]
    assert ssh.calls == [("lipsync", "stop")]
    st = orch._state("lipsync")
    assert st.status == "sleeping" and st.stop_count == 1
    assert _audit_actions(orch_db) == ["orch.sleep"]


async def test_idle_sweep_skips_default_unsafe_services(monkeypatch, orch_db):
    """默认注册表全 safe_idle=false:即使闲置超阈值也不回收(保守默认)。"""
    ssh = _patch_ssh(monkeypatch)
    for name in ("i2l", "trainer", "lipsync", "hy3dtex"):
        _set_running(name, idle_for=99999.0)
    result = await orch.idle_sweep()
    assert result["stopped"] == []
    assert ssh.calls == []


async def test_idle_sweep_skips_recent_request(monkeypatch, orch_db):
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    _set_running("lipsync", idle_for=10.0)  # 未超 900s 阈值
    result = await orch.idle_sweep()
    assert result["stopped"] == [] and ssh.calls == []


async def test_idle_sweep_skips_never_requested(monkeypatch, orch_db):
    """从未打点(last_request_at=None)= 编排器没见过它服务请求,保守不动。"""
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    orch._state("lipsync").status = "running"  # 无 last_request_at
    result = await orch.idle_sweep()
    assert result["stopped"] == [] and ssh.calls == []


async def test_idle_sweep_skips_not_running(monkeypatch, orch_db):
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    st = orch._state("lipsync")
    st.status = "sleeping"
    st.last_request_at = time.time() - 99999.0
    result = await orch.idle_sweep()
    assert result["stopped"] == [] and ssh.calls == []


async def test_idle_sweep_skips_with_active_job(monkeypatch, orch_db):
    """有关联 queued/running/held 作业引用该服务 → 不回收。"""
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    with Session(orch_db) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id="p1", worker="w",
                  kind="lipsync", status="running"))
        s.commit()
    _set_running("lipsync", idle_for=99999.0)
    result = await orch.idle_sweep()
    assert result["stopped"] == [] and ssh.calls == []
    assert orch._state("lipsync").status == "running"


async def test_idle_sweep_stops_when_job_terminal(monkeypatch, orch_db):
    """关联作业已终态(done)不算在跑 → 正常回收。"""
    _make_safe_idle(monkeypatch)
    ssh = _patch_ssh(monkeypatch)
    with Session(orch_db) as s:
        s.add(Job(tenant_id="t", user_id="u", prompt_id="p1", worker="w",
                  kind="lipsync", status="done"))
        s.commit()
    _set_running("lipsync", idle_for=99999.0)
    result = await orch.idle_sweep()
    assert result["stopped"] == ["lipsync"]
    assert ssh.calls == [("lipsync", "stop")]


async def test_idle_sweep_stop_failure_marks_error(monkeypatch, orch_db):
    _make_safe_idle(monkeypatch)
    _patch_ssh(monkeypatch, rc=5)
    _set_running("lipsync", idle_for=99999.0)
    result = await orch.idle_sweep()
    assert result["stopped"] == []
    assert orch._state("lipsync").status == "error"
    assert _audit_actions(orch_db) == []  # 未成功不收睡眠审计


# --------------------------------------------------------------------------- #
# 端点
# --------------------------------------------------------------------------- #


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
def ctx(engine, monkeypatch):
    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(orch, "engine", engine)
    with Session(engine) as s:
        admin_id = _make_user(s, "admin@toiv.ai", "admin")
        user_id = _make_user(s, "bob@toiv.ai", "user")
    yield {
        "client": TestClient(app),
        "admin": {"Authorization": f"Bearer {create_token(admin_id)}"},
        "user": {"Authorization": f"Bearer {create_token(user_id)}"},
    }
    app.dependency_overrides.clear()


def test_endpoint_list_requires_admin(ctx):
    assert ctx["client"].get("/api/orch/services").status_code == 401
    assert ctx["client"].get(
        "/api/orch/services", headers=ctx["user"]).status_code == 403


def test_endpoint_list_admin_ok(ctx):
    res = ctx["client"].get("/api/orch/services", headers=ctx["admin"])
    assert res.status_code == 200
    body = res.json()
    services = {s["name"]: s for s in body["services"]}
    assert set(services) == {"i2l", "trainer", "lipsync", "hy3dtex"}
    i2l = services["i2l"]
    assert i2l["status"] == "stopped"
    assert i2l["idle_sec"] is None  # 从未打点
    assert i2l["wake_count"] == 0 and i2l["stop_count"] == 0
    assert i2l["idle_timeout_sec"] == 900  # 全局默认值透出
    assert i2l["systemd_unit"] == "toiv-i2l.service"
    assert i2l["tier"] == "cold" and i2l["safe_idle"] is False


def test_endpoint_wake_requires_auth(ctx):
    assert ctx["client"].post("/api/orch/services/i2l/wake").status_code == 401


def test_endpoint_wake_user_ok(ctx, monkeypatch):
    _patch_ssh(monkeypatch)
    _patch_health_ok(monkeypatch)
    res = ctx["client"].post("/api/orch/services/lipsync/wake", headers=ctx["user"])
    assert res.status_code == 200
    body = res.json()
    assert body["status"] == "running" and body["wake_count"] == 1
    assert body["last_request_at"] is not None


def test_endpoint_wake_unknown_404(ctx):
    res = ctx["client"].post(
        "/api/orch/services/nonexistent/wake", headers=ctx["user"])
    assert res.status_code == 404
