"""P4(2026-10-17):旧 LTX 链图像级锚点注入——无角色首帧时,冻结锚点快照作 i2v 首帧(跨镜共背景)。"""
from __future__ import annotations

import asyncio
import json

import pytest

from app.models import DramaShot


def _shot_with_anchor(anchor: str = "/api/studio/files/scene_anchor_abc.png") -> DramaShot:
    layout = json.dumps({"scene_ref": {"scene_id": "s1", "scene_name": "雨巷", "anchor_image": anchor,
                                       "anchor_sha256": "abc"}}) if anchor else ""
    return DramaShot(project_id="p1", idx=0, prompt="x", scene_layout=layout)


class _FakeClient:
    def __init__(self):
        self.uploads = []

    async def upload_image(self, data, name):
        self.uploads.append((data, name))
        return "worker_input_" + name


def test_anchor_keyframe_uploaded_from_snapshot(monkeypatch):
    from app.routes import drama_studio as ds

    async def fake_fetch(pool, url):
        assert url.endswith("scene_anchor_abc.png")
        return b"anchor-bytes"

    monkeypatch.setattr(ds, "_fetch_ref_image_bytes", fake_fetch)
    client = _FakeClient()
    fn = asyncio.run(ds._resolve_anchor_keyframe(_shot_with_anchor(), object(), client))
    assert fn and fn.startswith("worker_input_drama_anchor_")
    assert client.uploads[0][0] == b"anchor-bytes"


def test_no_anchor_returns_none():
    from app.routes import drama_studio as ds

    client = _FakeClient()
    assert asyncio.run(ds._resolve_anchor_keyframe(_shot_with_anchor(""), object(), client)) is None
    assert client.uploads == []


def test_fetch_failure_falls_back_to_none(monkeypatch):
    from app.routes import drama_studio as ds

    async def boom(pool, url):
        raise RuntimeError("unreadable")

    monkeypatch.setattr(ds, "_fetch_ref_image_bytes", boom)
    client = _FakeClient()
    assert asyncio.run(ds._resolve_anchor_keyframe(_shot_with_anchor(), object(), client)) is None
    assert client.uploads == []
