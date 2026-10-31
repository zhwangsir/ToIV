"""JWT 生产密钥护栏测试(P1-12)。

production + 仓库默认密钥(dev-insecure 前缀)→ ERROR 日志 + 拒绝启动(RuntimeError);
非 production + 默认密钥 → WARNING 提醒,不阻断;自定义密钥 → 静默通过。
"""
from __future__ import annotations

import logging

import pytest

from app.config import Settings
from app.main import _jwt_secret_guard

_DEFAULT_SECRET = Settings.model_fields["jwt_secret"].default


def _settings(environment: str, secret: str) -> Settings:
    return Settings(environment=environment, jwt_secret=secret)


def test_production_default_secret_refuses_startup(caplog):
    with caplog.at_level(logging.ERROR, logger="toiv.security"):
        with pytest.raises(RuntimeError, match="TOIV_JWT_SECRET"):
            _jwt_secret_guard(_settings("production", _DEFAULT_SECRET))
    errors = [r.getMessage() for r in caplog.records if r.levelno == logging.ERROR]
    assert any("默认 JWT 密钥" in m for m in errors), errors


def test_production_custom_secret_passes_silently(caplog):
    with caplog.at_level(logging.WARNING, logger="toiv.security"):
        _jwt_secret_guard(_settings("production", "real-random-secret-32bytes-minimum"))
    assert not [r for r in caplog.records if r.name == "toiv.security"]


def test_development_default_secret_warns_but_starts(caplog):
    with caplog.at_level(logging.WARNING, logger="toiv.security"):
        _jwt_secret_guard(_settings("development", _DEFAULT_SECRET))  # 不抛
    warnings = [r.getMessage() for r in caplog.records if r.levelno == logging.WARNING]
    assert any("默认开发值" in m for m in warnings), warnings
