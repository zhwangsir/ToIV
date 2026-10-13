"""worker 熔断参数与其调高后的行为(批量烟测的 transport 假失败之根)。

背景:GPU 打满时 /queue 会整次超时报错,原阈值 3 只需约 15s 就把**健康但繁忙**
的 worker 判死并冷 30s。批量烟测实测并发 2 时 9 条里 4 条报
「所有 worker 均不可达(熔断中)」,而同一时刻四口从 core 直连 system_stats
全 200 / ~7ms —— 即那是把可用应用写成假 fail 的来源,不是应用坏。

这些方法体只碰 state,不碰 self,故可传 None 直接当纯函数测。
"""
import importlib
import time

import pytest

from app.comfy import pool as pool_mod
from app.comfy.pool import _WorkerState


def _state():
    return _WorkerState(client=object())


def test_breaker_opens_only_at_threshold():
    n = pool_mod._BREAKER_FAIL_THRESHOLD
    p, st = None, _state()
    for _ in range(n - 1):
        pool_mod.WorkerPool._record_failure(p, st)
    assert pool_mod.WorkerPool._is_breaker_open(p, st, time.monotonic()) is False
    pool_mod.WorkerPool._record_failure(p, st)
    assert pool_mod.WorkerPool._is_breaker_open(p, st, time.monotonic()) is True


def test_threshold_is_not_too_low():
    """阈值必须明显高于「一次抖动」:3 太灵敏,是本轮假 fail 的直接原因。"""
    assert pool_mod._BREAKER_FAIL_THRESHOLD >= 4


def test_probe_ttl_long_enough_to_dampen_load_timeouts():
    """TTL 太短会把探测本身变成负载;5s 下探测频率过高。"""
    assert pool_mod._PROBE_TTL >= 8.0


def test_half_open_after_cooldown():
    p, st = None, _state()
    for _ in range(pool_mod._BREAKER_FAIL_THRESHOLD):
        pool_mod.WorkerPool._record_failure(p, st)
    opened_at = st.breaker_opened_at
    assert pool_mod.WorkerPool._is_breaker_open(p, st, opened_at) is True
    later = opened_at + pool_mod._BREAKER_COOLDOWN + 0.1
    assert pool_mod.WorkerPool._is_breaker_open(p, st, later) is False
    # 转 half-open 时顺手清零,给下一次试探留干净状态
    assert st.breaker_opened_at == 0.0


def test_success_resets_failures_and_closes_breaker():
    p, st = None, _state()
    for _ in range(pool_mod._BREAKER_FAIL_THRESHOLD):
        pool_mod.WorkerPool._record_failure(p, st)
    pool_mod.WorkerPool._record_success(p, st, 0, set(), set())
    assert st.failures == 0
    assert st.breaker_opened_at == 0.0
    assert pool_mod.WorkerPool._is_breaker_open(p, st, time.monotonic()) is False


def test_env_overrides_take_effect(monkeypatch):
    monkeypatch.setenv("TOIV_WORKER_BREAKER_FAILS", "9")
    monkeypatch.setenv("TOIV_WORKER_PROBE_TTL_S", "20")
    monkeypatch.setenv("TOIV_WORKER_BREAKER_COOLDOWN_S", "45")
    reloaded = importlib.reload(pool_mod)
    try:
        assert reloaded._BREAKER_FAIL_THRESHOLD == 9
        assert reloaded._PROBE_TTL == 20.0
        assert reloaded._BREAKER_COOLDOWN == 45.0
    finally:
        monkeypatch.delenv("TOIV_WORKER_BREAKER_FAILS", raising=False)
        monkeypatch.delenv("TOIV_WORKER_PROBE_TTL_S", raising=False)
        monkeypatch.delenv("TOIV_WORKER_BREAKER_COOLDOWN_S", raising=False)
        importlib.reload(pool_mod)


def test_bad_env_falls_back_instead_of_crashing(monkeypatch):
    """现场调参打错字不能把 api 启动搞挂。"""
    monkeypatch.setenv("TOIV_WORKER_BREAKER_FAILS", "abc")
    monkeypatch.setenv("TOIV_WORKER_PROBE_TTL_S", "")
    reloaded = importlib.reload(pool_mod)
    try:
        assert reloaded._BREAKER_FAIL_THRESHOLD == 5
        assert reloaded._PROBE_TTL == 10.0
    finally:
        monkeypatch.delenv("TOIV_WORKER_BREAKER_FAILS", raising=False)
        monkeypatch.delenv("TOIV_WORKER_PROBE_TTL_S", raising=False)
        importlib.reload(pool_mod)
