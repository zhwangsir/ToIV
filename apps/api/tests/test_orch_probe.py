"""读取路径探活校正单测(service_orchestrator.probe_and_reconcile / list_services_live)。

覆盖:
  ① 重启丢态校正:stopped + 探测存活 → running(last_request_at 不动);
  ② sleeping + 探测存活 → running(last_request_at 保留);
  ③ running + 探测不可达 → error + last_error「探活失败」;
  ④ 探测抛异常容错:按不可达处理,不向外抛(读请求绝不 500);
  ⑤ 并行探测不串行:4 服务各 0.4s,总耗时 < 单服务超时×2(0.5×2=1.0s,串行需 1.6s);
  ⑥ TCP 探测路径:health_path 空串走 _tcp_probe,不发 HTTP;
  ⑦ waking/error 保守不触碰;
  ⑧ GET 路由返回校正后状态。
全 mock _check_health/_tcp_probe,不触真实设备。
"""
from __future__ import annotations

import asyncio
import json
import time

import pytest

import app.services.service_orchestrator as orch
from app.config import get_settings
from app.models import User
from app.routes import orch as orch_routes


@pytest.fixture(autouse=True)
def _isolate():
    orch.reset_orchestrator()
    yield
    orch.reset_orchestrator()


def _patch_probe(monkeypatch, alive: dict[str, bool]):
    """按服务名返回探测结果的 _check_health 替身。"""

    async def fake(spec) -> bool:
        return alive.get(spec.name, False)

    monkeypatch.setattr(orch, "_check_health", fake)


def _admin() -> User:
    return User(id="a1", tenant_id="t1", email="a@t.com", hashed_password="x")


# --------------------------------------------------------------------------- #
# ① 重启丢态:stopped + 存活 → running
# --------------------------------------------------------------------------- #


async def test_probe_corrects_stopped_to_running_after_restart(monkeypatch):
    """API 重启后内存全 stopped,但 i2l/trainer 实际在跑 → 校正 running。"""
    _patch_probe(monkeypatch, {"i2l": True, "trainer": True})
    payload = await orch.list_services_live()
    by_name = {s["name"]: s for s in payload["services"]}
    assert by_name["i2l"]["status"] == "running"
    assert by_name["trainer"]["status"] == "running"
    assert by_name["lipsync"]["status"] == "stopped", "不可达服务保持 stopped"
    st = orch._state("i2l")
    assert st.last_request_at is None, "状态校正不动 last_request_at(非真实请求)"
    assert st.wake_count == 0, "校正不计唤醒次数(未发 SSH)"


# --------------------------------------------------------------------------- #
# ② sleeping + 存活 → running,last_request_at 保留
# --------------------------------------------------------------------------- #


async def test_probe_corrects_sleeping_to_running_keeps_last_request(monkeypatch):
    _patch_probe(monkeypatch, {"lipsync": True})
    st = orch._state("lipsync")
    st.status = "sleeping"
    st.last_request_at = 1_700_000_000.0

    payload = await orch.list_services_live()
    row = next(s for s in payload["services"] if s["name"] == "lipsync")
    assert row["status"] == "running"
    assert st.last_request_at == 1_700_000_000.0, "last_request_at 不动"
    # 打点保留 → idle_sec 按旧时间戳计算(大正数),不被校正清零
    assert row["idle_sec"] is not None and row["idle_sec"] > 0


# --------------------------------------------------------------------------- #
# ③ running + 不可达 → error + 探活失败
# --------------------------------------------------------------------------- #


async def test_probe_unreachable_running_to_error(monkeypatch):
    _patch_probe(monkeypatch, {})  # 全部不可达
    orch._state("hy3dtex").status = "running"

    payload = await orch.list_services_live()
    row = next(s for s in payload["services"] if s["name"] == "hy3dtex")
    assert row["status"] == "error"
    assert "探活失败" in row["last_error"]
    # stopped 不可达符合预期,不误标 error
    row_i2l = next(s for s in payload["services"] if s["name"] == "i2l")
    assert row_i2l["status"] == "stopped"
    assert row_i2l["last_error"] == ""


# --------------------------------------------------------------------------- #
# ④ 探测抛异常容错(超时/连接重置等未捕获回归)
# --------------------------------------------------------------------------- #


async def test_probe_exception_tolerated_as_unreachable(monkeypatch):
    async def boom(spec):
        raise RuntimeError(f"{spec.name} probe exploded")

    monkeypatch.setattr(orch, "_check_health", boom)
    orch._state("trainer").status = "running"

    payload = await orch.list_services_live()  # 不抛异常
    row = next(s for s in payload["services"] if s["name"] == "trainer")
    assert row["status"] == "error", "异常按不可达 → running 校正 error"
    assert "探活失败" in row["last_error"]
    assert len(payload["services"]) == 4, "读请求正常返回全量清单"


# --------------------------------------------------------------------------- #
# ⑤ 并行探测不串行:总耗时 < 单服务超时×2
# --------------------------------------------------------------------------- #


async def test_probe_runs_in_parallel_not_serial(monkeypatch):
    monkeypatch.setattr(orch, "HEALTH_CHECK_TIMEOUT_SEC", 0.5)

    async def slow(spec) -> bool:
        await asyncio.sleep(0.4)  # 每个探测 0.4s;串行 4×0.4=1.6s > 0.5×2
        return False

    monkeypatch.setattr(orch, "_check_health", slow)
    start = time.monotonic()
    await orch.probe_and_reconcile()
    elapsed = time.monotonic() - start
    assert elapsed < 0.5 * 2, (
        f"并行探测总耗时 {elapsed:.2f}s 应 < 单服务超时×2(1.0s);串行需 1.6s"
    )


# --------------------------------------------------------------------------- #
# ⑥ TCP 探测路径:health_path 空串 → _tcp_probe,不发 HTTP
# --------------------------------------------------------------------------- #


async def test_probe_tcp_path_for_empty_health_path(monkeypatch):
    monkeypatch.setattr(
        get_settings(),
        "orch_services",
        json.dumps({"i2l": {"health_path": ""}}),
    )
    orch.reset_orchestrator()
    spec = orch.get_registry()["i2l"]
    assert spec.health_path == "", "注册表覆盖生效:health_path 空串"

    tcp_calls: list[tuple[str, int]] = []

    async def fake_tcp(host: str, port: int) -> bool:
        tcp_calls.append((host, port))
        return True

    def http_guard(*a, **k):
        raise AssertionError("health_path 空串不应发 HTTP")

    monkeypatch.setattr(orch, "_tcp_probe", fake_tcp)
    monkeypatch.setattr("httpx.AsyncClient", http_guard)

    assert await orch._check_health(spec) is True
    assert tcp_calls == [("192.168.71.127", 9101)], "TCP 探测打向注册表 host:port"

    # 经 list_services_live 全链路:stopped + TCP 存活 → running
    payload = await orch.list_services_live()
    row = next(s for s in payload["services"] if s["name"] == "i2l")
    assert row["status"] == "running"


# --------------------------------------------------------------------------- #
# ⑦ waking / error 保守不触碰
# --------------------------------------------------------------------------- #


async def test_probe_leaves_waking_and_error_untouched(monkeypatch):
    _patch_probe(monkeypatch, {"i2l": False, "trainer": True})
    orch._state("i2l").status = "waking"  # 唤醒在途,健康轮询自己会收敛
    st_err = orch._state("trainer")
    st_err.status = "error"
    st_err.last_error = "systemctl start 失败"

    await orch.probe_and_reconcile()
    assert orch._state("i2l").status == "waking", "waking 在途不被探活打断"
    assert st_err.status == "error", "error 保守留给显式唤醒恢复"
    assert st_err.last_error == "systemctl start 失败", "原错误不被探活覆盖"


# --------------------------------------------------------------------------- #
# ⑧ GET 路由返回校正后状态
# --------------------------------------------------------------------------- #


async def test_route_services_returns_reconciled(monkeypatch):
    _patch_probe(monkeypatch, {"i2l": True})
    payload = await orch_routes.orch_services(_admin())
    by_name = {s["name"]: s for s in payload["services"]}
    assert by_name["i2l"]["status"] == "running"
    assert by_name["trainer"]["status"] == "stopped"
    assert payload["generated_at"]
