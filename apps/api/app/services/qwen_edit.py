"""Qwen-Image-Edit-2509 专用实例(pc02 :8194)的客户端与可用性检查。

与 services/h3.py 同模式:专用实例不入 WorkerPool,提交/探测都走
TOIV_QWEN_EDIT_BASE_URL 直连;图构造见 workflows/qwen_edit.py。
"""
from __future__ import annotations

from app.comfy.client import ComfyUIClient
from app.config import get_settings

# 语义编辑关键节点(ComfyUI ≥ 0.3.x 内置;仅 :8194 实例确认装有)
QWEN_EDIT_NODE = "TextEncodeQwenImageEdit"


def get_qwen_edit_client() -> ComfyUIClient:
    settings = get_settings()
    return ComfyUIClient(settings.qwen_edit_base, timeout=settings.request_timeout)
