"""输入图尺寸探测 —— 次世代 img2img 的 ModelSamplingFlux 需要 w/h(shift 估算)。

latent 来自 VAEEncode 的真实图像,采样分辨率始终正确;w/h 仅影响
ModelSamplingFlux 的 shift 启发式。探测失败时回退 1024x1024(安全默认),
不让一次图生图因元信息缺失而 400。
"""
from __future__ import annotations

import io
import logging

from PIL import Image

from app.comfy.client import ComfyUIClient

logger = logging.getLogger(__name__)

DEFAULT_DIMS = (1024, 1024)

# (worker_base_url, filename) → (w, h);上传后的 input 图不可变,可安全缓存
_cache: dict[tuple[str, str], tuple[int, int]] = {}


async def input_image_dims(client: ComfyUIClient, filename: str) -> tuple[int, int]:
    """读取 worker input 目录中图片的宽高;失败回退 DEFAULT_DIMS。"""
    key = (client.base_url, filename)
    if key in _cache:
        return _cache[key]
    try:
        data, _ = await client.get_image_bytes(filename, "", "input")
        with Image.open(io.BytesIO(data)) as im:
            dims = (im.width, im.height)
    except Exception as e:  # noqa: BLE001 — 任何失败都不应阻塞出图,回退默认即可
        logger.warning(
            "探测输入图尺寸失败 %s@%s: %s —— 回退默认 %s",
            filename, client.base_url, e, DEFAULT_DIMS,
        )
        dims = DEFAULT_DIMS
    _cache[key] = dims
    return dims
