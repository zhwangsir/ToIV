"""输入图尺寸探测(imagedims):成功解析 / 缓存命中 / 失败回退默认。

不依赖真实 worker:用 stub client 替身 ComfyUIClient.get_image_bytes。
"""
from __future__ import annotations

import io

import pytest
from PIL import Image

from app.comfy.imagedims import DEFAULT_DIMS, input_image_dims


def _png_bytes(w: int, h: int) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (w, h), (128, 64, 32)).save(buf, format="PNG")
    return buf.getvalue()


class _StubClient:
    """最小 ComfyUIClient 替身:只实现 get_image_bytes。"""

    base_url = "http://stub:8188"

    def __init__(self, payload: bytes | Exception) -> None:
        self._payload = payload
        self.calls = 0

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        self.calls += 1
        if isinstance(self._payload, Exception):
            raise self._payload
        return self._payload, "image/png"


@pytest.fixture(autouse=True)
def _clear_cache():
    """每个用例前清空模块级缓存,避免用例间串扰。"""
    from app.comfy import imagedims

    imagedims._cache.clear()
    yield
    imagedims._cache.clear()


async def test_parses_real_dims():
    client = _StubClient(_png_bytes(832, 1216))
    assert await input_image_dims(client, "a.png") == (832, 1216)
    assert client.calls == 1


async def test_cache_hit_skips_second_fetch():
    client = _StubClient(_png_bytes(640, 480))
    assert await input_image_dims(client, "b.png") == (640, 480)
    assert await input_image_dims(client, "b.png") == (640, 480)
    assert client.calls == 1  # 第二次走缓存


async def test_failure_falls_back_to_default():
    client = _StubClient(RuntimeError("worker down"))
    assert await input_image_dims(client, "c.png") == DEFAULT_DIMS


async def test_garbage_bytes_fall_back_to_default():
    client = _StubClient(b"not an image")
    assert await input_image_dims(client, "d.png") == DEFAULT_DIMS
