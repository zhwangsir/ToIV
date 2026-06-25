"""任意工作流(raw)端点的 R18 门槛扫描单测。"""
from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from app.routes.generate import _gate_raw_graph_nsfw

_SFW = "DreamShaper_8_pruned.safetensors"
_NSFW = "moodyPornMix_zitV7.safetensors"


def _graph(ckpt: str) -> dict:
    return {
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": ckpt}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }


def test_sfw_graph_passes_returns_false():
    user = SimpleNamespace(nsfw_enabled=False)
    assert _gate_raw_graph_nsfw(_graph(_SFW), user) is False


def test_nsfw_graph_blocked_when_disabled():
    user = SimpleNamespace(nsfw_enabled=False)
    with pytest.raises(HTTPException) as ei:
        _gate_raw_graph_nsfw(_graph(_NSFW), user)
    assert ei.value.status_code == 403


def test_nsfw_graph_allowed_when_enabled():
    user = SimpleNamespace(nsfw_enabled=True)
    assert _gate_raw_graph_nsfw(_graph(_NSFW), user) is True


def test_graph_without_ckpt_is_sfw():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {"1": {"class_type": "EmptyLatentImage", "inputs": {"width": 512}}}
    assert _gate_raw_graph_nsfw(g, user) is False


def test_malformed_nodes_ignored():
    user = SimpleNamespace(nsfw_enabled=False)
    g = {"1": "not a dict", "2": {"no_inputs": True}, "3": {"inputs": "bad"}}
    assert _gate_raw_graph_nsfw(g, user) is False
