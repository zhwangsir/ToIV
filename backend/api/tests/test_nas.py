"""NAS SFTP 连接超时测试(P3):paramiko.Transport 不再无超时裸连。

_connect 必须:
  · TCP connect 带 timeout(15s),超时/失败抛明确 RuntimeError;
  · banner/auth 超时显式设置;
  · 握手/认证失败关闭 transport 并抛明确错误。
"""
from __future__ import annotations

import socket
from unittest.mock import MagicMock

import pytest

from app import nas


@pytest.fixture()
def _nas_settings(monkeypatch):
    s = MagicMock()
    s.nas_enabled = True
    s.nas_host = "192.168.71.7"
    s.nas_port = 22
    s.nas_user = "dgmt-nas"
    s.nas_password = "secret"
    monkeypatch.setattr(nas, "get_settings", lambda: s)
    return s


def test_connect_sets_timeouts(_nas_settings, monkeypatch):
    """create_connection 带 15s 超时,Transport 设置 banner/auth 超时。"""
    calls = {}

    def _fake_create_connection(addr, timeout=None):
        calls["addr"] = addr
        calls["timeout"] = timeout
        return MagicMock(name="sock")

    transport = MagicMock(name="transport")
    sftp = MagicMock(name="sftp")
    monkeypatch.setattr(nas.socket, "create_connection", _fake_create_connection)
    monkeypatch.setattr(nas.paramiko, "Transport", MagicMock(return_value=transport))
    monkeypatch.setattr(
        nas.paramiko.SFTPClient, "from_transport", MagicMock(return_value=sftp)
    )

    got_sftp, got_transport = nas._connect()

    assert calls["addr"] == ("192.168.71.7", 22)
    assert calls["timeout"] == nas._CONNECT_TIMEOUT == 15.0
    assert transport.banner_timeout == 15.0
    assert transport.auth_timeout == 15.0
    transport.connect.assert_called_once_with(username="dgmt-nas", password="secret")
    assert (got_sftp, got_transport) == (sftp, transport)


def test_connect_tcp_timeout_raises_clear_error(_nas_settings, monkeypatch):
    """TCP 连接超时 → 明确 RuntimeError(含地址),不无限挂起。"""
    def _timeout(addr, timeout=None):
        raise socket.timeout("timed out")

    monkeypatch.setattr(nas.socket, "create_connection", _timeout)

    with pytest.raises(RuntimeError, match="NAS 连接失败或超时.*192.168.71.7:22"):
        nas._connect()


def test_connect_handshake_failure_closes_transport(_nas_settings, monkeypatch):
    """握手/认证失败 → 关闭 transport 并抛明确错误。"""
    transport = MagicMock(name="transport")
    transport.connect.side_effect = socket.timeout("timed out")
    monkeypatch.setattr(nas.socket, "create_connection", MagicMock())
    monkeypatch.setattr(nas.paramiko, "Transport", MagicMock(return_value=transport))

    with pytest.raises(RuntimeError, match="NAS 握手/认证失败或超时"):
        nas._connect()
    transport.close.assert_called_once_with()
