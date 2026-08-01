"""ComfyUI HTTP 连接池缓存测试(P1-4)。

验证:
- 同 (base_url, timeout) 两次获取是同一 AsyncClient(连接池复用);
- 不同 timeout 是不同 client;
- close_clients() 关闭全部缓存 client,再次获取重新创建。
"""
import asyncio

from app.comfy.client import ComfyUIClient, _pooled_client, close_clients


def teardown_module():
    asyncio.run(close_clients())  # 不泄漏打开的 client 到其他测试


def test_same_key_reuses_client():
    c1 = _pooled_client("http://pool-a:8188", 30.0)
    c2 = _pooled_client("http://pool-a:8188", 30.0)
    assert c1 is c2


def test_different_timeout_separate_client():
    a = _pooled_client("http://pool-a:8188", 30.0)
    b = _pooled_client("http://pool-a:8188", 4.0)
    assert a is not b


def test_close_clients_then_recreate():
    c1 = _pooled_client("http://pool-b:8188", 30.0)
    asyncio.run(close_clients())
    assert c1.is_closed
    c2 = _pooled_client("http://pool-b:8188", 30.0)
    assert c2 is not c1
    assert not c2.is_closed


def test_comfy_client_uses_pool_key():
    c = ComfyUIClient("http://pool-c:8188/", timeout=30.0)  # 尾斜杠会被 rstrip
    assert _pooled_client("http://pool-c:8188", 30.0) is _pooled_client(c.base_url, c._timeout)
