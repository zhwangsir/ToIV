"""统一日志配置 + 全局异常兜底测试(LOG-2026-08-12)。

覆盖:
  · setup_logging:幂等(重复调用不叠加 handler)、级别可调、第三方降噪生效
  · create_app 接入:root 获得带 _toiv_handler 标记的 stdout handler
  · 全局异常处理器:未处理异常 → 500 JSON(不泄露内部细节)+ 带请求上下文 ERROR 日志
"""
from __future__ import annotations

import logging

import pytest
from fastapi.testclient import TestClient

from app import main
from app.logging_config import _QUIET_LOGGERS, redact_token_in_query, setup_logging


@pytest.fixture
def _restore_logging():
    """快照 root handler/级别与降噪 logger 级别,测试后还原,避免污染其它用例。"""
    root = logging.getLogger()
    old_handlers, old_level = root.handlers[:], root.level
    quiet = {name: logging.getLogger(name).level for name in _QUIET_LOGGERS}
    yield
    root.handlers[:] = old_handlers
    root.setLevel(old_level)
    for name, lvl in quiet.items():
        logging.getLogger(name).setLevel(lvl)


def _toiv_handlers() -> list:
    return [h for h in logging.getLogger().handlers if getattr(h, "_toiv_handler", False)]


@pytest.mark.usefixtures("_restore_logging")
def test_setup_logging_adds_single_handler_and_level():
    root = logging.getLogger()
    root.handlers[:] = [h for h in root.handlers if not getattr(h, "_toiv_handler", False)]

    setup_logging("INFO")
    setup_logging("INFO")  # 幂等:不叠加

    assert len(_toiv_handlers()) == 1
    assert root.level == logging.INFO


@pytest.mark.usefixtures("_restore_logging")
def test_setup_logging_level_adjustable():
    setup_logging("DEBUG")
    assert logging.getLogger().level == logging.DEBUG


@pytest.mark.usefixtures("_restore_logging")
def test_setup_logging_quiets_noisy_loggers():
    setup_logging("INFO")
    for name in _QUIET_LOGGERS:
        assert logging.getLogger(name).level == logging.WARNING


def test_create_app_configures_root_logging():
    # main.app 在导入时已走 create_app → root 必须已有统一 handler
    assert main.app is not None
    assert len(_toiv_handlers()) >= 1


def test_unhandled_exception_returns_json_500_and_logs(caplog):
    app = main.create_app()

    @app.get("/api/_test_unhandled_raise")
    async def _raise():  # pragma: no cover - 只用于触发 500
        raise RuntimeError("boom-test")

    client = TestClient(app, raise_server_exceptions=False)
    with caplog.at_level(logging.ERROR, logger="toiv.unhandled"):
        resp = client.get("/api/_test_unhandled_raise")

    assert resp.status_code == 500
    assert resp.json() == {"detail": "服务器内部错误"}
    assert any(
        "未处理异常 GET /api/_test_unhandled_raise" in r.getMessage()
        for r in caplog.records
    )


def test_http_exception_not_hijacked_by_global_handler():
    """HTTPException(如 404/403)必须仍走自身 handler,不被全局兜底改写。"""
    client = TestClient(main.app)
    r = client.get("/api/definitely-not-exists")
    assert r.status_code == 404
    assert r.json() == {"detail": "Not Found"}


# ── access log 查询串 token 脱敏(P1-12) ──────────────────────────────


def test_redact_token_in_query():
    """token 值脱敏为 ***;大小写不敏感;其它参数原样保留。"""
    assert redact_token_in_query("token=abc.def.ghi") == "token=***"
    assert redact_token_in_query("a=1&token=secret&b=2") == "a=1&token=***&b=2"
    assert redact_token_in_query("TOKEN=Secret") == "TOKEN=***"
    assert redact_token_in_query("a=1&b=2") == "a=1&b=2"
    assert redact_token_in_query("") == ""


def test_access_log_middleware_redacts_token(caplog):
    """?token= 明文 JWT 不得落 toiv.access 访问日志;路径/状态码照常记录。"""
    client = TestClient(main.app)
    with caplog.at_level(logging.INFO, logger="toiv.access"):
        r = client.get("/api/health?token=supersecretjwt&x=1")
    assert r.status_code == 200
    access = [rec.getMessage() for rec in caplog.records if rec.name == "toiv.access"]
    assert any("GET /api/health?token=***&x=1 200" in m for m in access), access
    assert all("supersecretjwt" not in m for m in access)


def test_access_log_middleware_without_query(caplog):
    """无查询串时只记 method+path+status。"""
    client = TestClient(main.app)
    with caplog.at_level(logging.INFO, logger="toiv.access"):
        client.get("/api/health")
    access = [rec.getMessage() for rec in caplog.records if rec.name == "toiv.access"]
    assert any("GET /api/health 200" in m for m in access), access
