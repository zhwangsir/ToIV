"""市场应用 /run 专用实例路由 + 媒体同机转运。

L2 P0:WanVideo* KJ 图(wan-animate / longcat-i2v / VACE)曾误走通用池 → 503;
H3/animate2 上传落 pool 而 run 在专用机 → Invalid image file。
"""
from __future__ import annotations

import pytest

from app.comfy.client import ComfyUIError
from app.routes import apps as apps_routes


class _FakeClient:
    def __init__(self, base_url: str, *, files: set[str] | None = None):
        self.base_url = base_url
        self.files = set(files or [])
        self.uploads: list[tuple[bytes, str]] = []
        self.ready_calls: list[str] = []
        self.vram_calls = 0

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str):
        if filename not in self.files:
            raise ComfyUIError(f"missing {filename}")
        return b"bytes:" + filename.encode(), "image/png"

    async def upload_image(self, content: bytes, name: str) -> str:
        self.uploads.append((content, name))
        self.files.add(name)
        return name

    async def model_names(self) -> set[str]:
        return set()

    async def node_names(self) -> set[str]:
        return set()


class _FakePool:
    def __init__(self, clients: list[_FakeClient]):
        self.clients = clients
        self.pick_calls: list[tuple] = []

    async def pick(self, required=None, required_nodes=None):
        self.pick_calls.append((set(required or []), set(required_nodes or [])))
        return self.clients[0]


@pytest.mark.asyncio
async def test_pick_wan_animate_kj_nodes_uses_longcat(monkeypatch):
    """WanVideoAnimateEmbeds(wan-animate 真图)须派 :8197,不能 pool.pick。"""
    longcat = _FakeClient("http://dedicated-longcat:8197")
    pool = _FakePool([_FakeClient("http://pool:8188")])

    monkeypatch.setattr(
        "app.services.longcat.get_longcat_client", lambda: longcat, raising=False
    )
    # routes import via services.longcat module attribute
    import app.services.longcat as longcat_svc
    monkeypatch.setattr(longcat_svc, "get_longcat_client", lambda: longcat)

    client = await apps_routes._pick_app_client(
        pool, {"WanVideoAnimateEmbeds", "WanVideoModelLoader", "LoadImage"}, set()
    )
    assert client is longcat
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_pick_longcat_i2v_kj_nodes_uses_longcat(monkeypatch):
    longcat = _FakeClient("http://dedicated-longcat:8197")
    pool = _FakePool([_FakeClient("http://pool:8188")])
    import app.services.longcat as longcat_svc
    monkeypatch.setattr(longcat_svc, "get_longcat_client", lambda: longcat)

    client = await apps_routes._pick_app_client(
        pool, {"WanVideoModelLoader", "WanVideoEmptyEmbeds", "WanVideoSampler"}, set()
    )
    assert client is longcat
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_pick_animate2_uses_animate2_not_longcat(monkeypatch):
    animate2 = _FakeClient("http://dedicated-animate2:8199")
    longcat = _FakeClient("http://dedicated-longcat:8197")
    pool = _FakePool([_FakeClient("http://pool:8188")])
    import app.services.longcat as longcat_svc
    monkeypatch.setattr(longcat_svc, "get_longcat_client", lambda: longcat)

    import app.services.wan_animate2 as a2
    monkeypatch.setattr(a2, "get_animate2_client", lambda: animate2)

    client = await apps_routes._pick_app_client(
        pool, {"WanAnimate2ToVideo", "LoadImage", "LoadVideo"}, set()
    )
    assert client is animate2
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_pick_h3_like_nodes_uses_h3(monkeypatch):
    h3 = _FakeClient("http://dedicated-h3:8195")
    pool = _FakePool([_FakeClient("http://pool:8188")])

    async def _pick():
        return h3

    async def _ready(client, node="MiniMaxH3ImageToVideo"):
        client.ready_calls.append(node)

    async def _vram(client):
        client.vram_calls += 1

    monkeypatch.setattr("app.services.h3.ensure_h3_enabled", lambda: None)
    monkeypatch.setattr("app.services.h3.pick_h3_client", _pick)
    monkeypatch.setattr("app.services.h3.ensure_h3_ready", _ready)
    monkeypatch.setattr("app.services.h3.ensure_h3_vram", _vram)

    client = await apps_routes._pick_app_client(
        pool, {"MiniMaxH3ImageToVideo", "LoadImage"}, set()
    )
    assert client is h3
    assert h3.ready_calls == ["MiniMaxH3ImageToVideo"]
    assert h3.vram_calls == 1
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_pick_general_graph_still_uses_pool():
    pool_client = _FakeClient("http://pool:8188")
    pool = _FakePool([pool_client])
    client = await apps_routes._pick_app_client(
        pool, {"CheckpointLoaderSimple", "CLIPTextEncode", "SaveImage"}, {"a.safetensors"}
    )
    assert client is pool_client
    assert len(pool.pick_calls) == 1
    assert pool.pick_calls[0][0] == {"a.safetensors"}


@pytest.mark.asyncio
async def test_ensure_media_transfers_from_pool_to_dedicated():
    pool_client = _FakeClient("http://pool:8188", files={"ref.png", "drive.mp4"})
    dedicated = _FakeClient("http://dedicated-h3:8195")
    pool = _FakePool([pool_client])
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}},
        "2": {"class_type": "VHS_LoadVideo", "inputs": {"video": "drive.mp4"}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "hi", "clip": ["9", 0]}},
    }
    await apps_routes._ensure_graph_media_on_client(dedicated, pool, graph)
    assert {n for _, n in dedicated.uploads} == {"ref.png", "drive.mp4"}
    assert "ref.png" in dedicated.files and "drive.mp4" in dedicated.files


@pytest.mark.asyncio
async def test_ensure_media_skips_when_already_on_dedicated():
    dedicated = _FakeClient("http://dedicated-h3:8195", files={"ref.png"})
    pool = _FakePool([_FakeClient("http://pool:8188")])  # pool 无文件
    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    await apps_routes._ensure_graph_media_on_client(dedicated, pool, graph)
    assert dedicated.uploads == []  # 未重复上传


@pytest.mark.asyncio
async def test_ensure_media_noop_for_pool_client():
    pool_client = _FakeClient("http://pool:8188", files={"ref.png"})
    pool = _FakePool([pool_client])
    graph = {"1": {"class_type": "LoadImage", "inputs": {"image": "ref.png"}}}
    await apps_routes._ensure_graph_media_on_client(pool_client, pool, graph)
    assert pool_client.uploads == []


def test_iter_graph_media_skips_node_links():
    graph = {
        "1": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "2": {"class_type": "LoadImage", "inputs": {"image": ["1", 0]}},  # 连线
        "3": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "m.safetensors"}},
    }
    assert apps_routes._iter_graph_media_filenames(graph) == ["a.png"]
