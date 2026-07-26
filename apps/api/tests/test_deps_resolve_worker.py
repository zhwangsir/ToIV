"""resolve_worker 白名单校验单测。

覆盖场景:
1. 精确匹配(原行为,主路径)
2. hostname 级回退(旧产物 URL 的 worker 端口已退役,但同机仍有存活 worker)
3. 完全未知 hostname → 400
"""
from __future__ import annotations

import pytest

from app.deps import resolve_worker


@pytest.fixture
def settings_workers(monkeypatch):
    """注入测试 worker 白名单(模拟生产 8189-8192 配置)。"""
    monkeypatch.setattr(
        "app.config.get_settings",
        lambda: type(
            "S",
            (),
            {
                "worker_urls": [
                    "http://192.168.71.127:8189",
                    "http://192.168.71.127:8190",
                    "http://192.168.71.127:8191",
                    "http://192.168.71.127:8192",
                ],
                "request_timeout": 30.0,
            },
        )(),
    )
    # resolve_worker 内部调用 get_settings(),需 patch app.deps 模块的引用
    monkeypatch.setattr(
        "app.deps.get_settings",
        lambda: type(
            "S",
            (),
            {
                "worker_urls": [
                    "http://192.168.71.127:8189",
                    "http://192.168.71.127:8190",
                    "http://192.168.71.127:8191",
                    "http://192.168.71.127:8192",
                ],
                "request_timeout": 30.0,
            },
        )(),
    )


def test_resolve_worker_exact_match(settings_workers):
    """白名单内的完整 URL 精确匹配。"""
    client = resolve_worker("http://192.168.71.127:8189")
    assert client.base_url == "http://192.168.71.127:8189"


def test_resolve_worker_hostname_fallback_for_legacy_url(settings_workers):
    """旧产物 URL 的 worker 端口(8188)已不在白名单,但同机(192.168.71.127)
    仍有存活 worker → hostname 级回退命中,返回白名单中第一个同机 worker。

    场景:用户早期通过 LB 8188 生成的视频,产物 URL 存的是 worker=8188;
    后续 LB 退役改直连 8189-8192,旧视频 URL 仍应可访问(同机共享输出目录)。
    """
    client = resolve_worker("http://192.168.71.127:8188")
    assert client.base_url in (
        "http://192.168.71.127:8189",
        "http://192.168.71.127:8190",
        "http://192.168.71.127:8191",
        "http://192.168.71.127:8192",
    )
    # 同机校验
    from urllib.parse import urlsplit

    assert urlsplit(client.base_url).hostname == "192.168.71.127"


def test_resolve_worker_rejects_unknown_host(settings_workers):
    """完全未知 hostname → 400(防 SSRF)。"""
    from fastapi import HTTPException

    with pytest.raises(HTTPException) as exc:
        resolve_worker("http://evil.example.com:8188")
    assert exc.value.status_code == 400


def test_resolve_worker_strips_trailing_slash(settings_workers):
    """带尾斜杠的 worker URL 应归一化匹配。"""
    client = resolve_worker("http://192.168.71.127:8189/")
    assert client.base_url == "http://192.168.71.127:8189"
