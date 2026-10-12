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


# ── W8-7:专用实例分支必须在模型检查之前先验模型 ──────────────────────────────
# 实测雷:n.startswith("WanVideo") → longcat_like → 直接 return :8197,而 required
# 只在函数最后一行 pool.pick(required=…) 才被消费,故模型可用性从不被检查。
# :8197 只有 wan2.2_i2v_…fp16、没有 …fp8_scaled(:8196/:8188 两者都有),路由落 :8197 后
# combo_repair 把权重静默换成 fp16 却不动耦合的 quantization=fp8_scaled,报
# 「not a scaled fp8 model」——把路由错伪装成权重不兼容。生产生成走同一个 picker。
_FP8 = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
_FP16 = "wan2.2_i2v_high_noise_14B_fp16.safetensors"
_WAN_NODES = {"WanVideoModelLoader", "WanVideoSampler", "WanVideoDecode", "LoadImage"}


class _ModelsClient(_FakeClient):
    """可配置 model_names() 的替身:空集在 _dedicated_satisfies 里等于「放行」。"""

    def __init__(self, base_url, models=None, *, raise_on_probe=False):
        super().__init__(base_url)
        self._models = set(models or [])
        self._raise = raise_on_probe
        self.probe_calls = 0

    async def model_names(self):
        self.probe_calls += 1
        if self._raise:
            raise ComfyUIError("object_info 探测抖动")
        return set(self._models)


class _RaisingPool(_FakePool):
    async def pick(self, required=None, required_nodes=None):
        self.pick_calls.append((set(required or []), set(required_nodes or [])))
        raise ComfyUIError("没有具备所需模型且可用的 worker")


def _patch_longcat(monkeypatch, client):
    import app.services.longcat as longcat_svc
    monkeypatch.setattr(longcat_svc, "get_longcat_client", lambda: client, raising=False)
    monkeypatch.setattr("app.services.longcat.get_longcat_client", lambda: client, raising=False)


@pytest.mark.asyncio
async def test_pick_longcat_falls_through_to_pool_when_dedicated_lacks_the_weight(monkeypatch):
    """专用实例缺该权重、通用池接得住 → 穿透到 pool.pick(修复前会硬返回 :8197)。"""
    dedicated = _ModelsClient("http://dedicated-longcat:8197", {_FP16})
    pool_client = _ModelsClient("http://pool:8196", {_FP8, _FP16})
    pool = _FakePool([pool_client])
    _patch_longcat(monkeypatch, dedicated)

    got = await apps_routes._pick_app_client(pool, set(_WAN_NODES), {_FP8})

    assert got is pool_client, "缺权重的专用实例不该被选中"
    assert pool.pick_calls == [({_FP8}, set(_WAN_NODES))], "穿透时必须把 required 与 nodes 都带上"


@pytest.mark.asyncio
async def test_pick_longcat_short_circuits_when_dedicated_has_the_weight(monkeypatch):
    """专用实例备齐权重 → 直接返回,不白花一次 pool 探测(保持原路由行为)。"""
    dedicated = _ModelsClient("http://dedicated-longcat:8197", {_FP8, _FP16})
    pool = _FakePool([_ModelsClient("http://pool:8196", {_FP8})])
    _patch_longcat(monkeypatch, dedicated)

    got = await apps_routes._pick_app_client(pool, set(_WAN_NODES), {_FP8})

    assert got is dedicated
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_pick_longcat_keeps_dedicated_when_pool_cannot_serve(monkeypatch):
    """通用池也接不住 → 仍返回专用实例。

    宁可保持原行为与原错误信息,也不要把「缺权重」换成「无可用 worker」这种更难查的 503。
    """
    dedicated = _ModelsClient("http://dedicated-longcat:8197", {_FP16})
    pool = _RaisingPool([_ModelsClient("http://pool:8196", set())])
    _patch_longcat(monkeypatch, dedicated)

    got = await apps_routes._pick_app_client(pool, set(_WAN_NODES), {_FP8})

    assert got is dedicated
    assert len(pool.pick_calls) == 1


@pytest.mark.asyncio
async def test_pick_longcat_empty_required_never_probes(monkeypatch):
    """required 为空时不该探测模型(绝大多数应用不带模型约束,别给热路径加开销)。"""
    dedicated = _ModelsClient("http://dedicated-longcat:8197", set())
    pool = _FakePool([_ModelsClient("http://pool:8196", set())])
    _patch_longcat(monkeypatch, dedicated)

    got = await apps_routes._pick_app_client(pool, set(_WAN_NODES), set())

    assert got is dedicated
    assert dedicated.probe_calls == 0
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_dedicated_probe_failure_does_not_block_routing(monkeypatch):
    """探测抖动一律放行:一次 object_info 失败不该把只能跑专用实例的应用整体打成 503。"""
    dedicated = _ModelsClient("http://dedicated-longcat:8197", raise_on_probe=True)
    pool = _FakePool([_ModelsClient("http://pool:8196", {_FP8})])
    _patch_longcat(monkeypatch, dedicated)

    got = await apps_routes._pick_app_client(pool, set(_WAN_NODES), {_FP8})

    assert got is dedicated
    assert pool.pick_calls == []


@pytest.mark.asyncio
async def test_dedicated_satisfies_semantics():
    """_dedicated_satisfies 的五种判定:空要求/齐/缺/空清单/探测异常。"""
    f = apps_routes._dedicated_satisfies
    assert await f(_ModelsClient("u", set()), set()) is True, "required 空 → 不探测直接放行"
    assert await f(_ModelsClient("u", {_FP8, _FP16}), {_FP8}) is True
    assert await f(_ModelsClient("u", {_FP16}), {_FP8}) is False
    assert await f(_ModelsClient("u", set()), {_FP8}) is True, "空清单视为未枚举,不能误判缺模型"
    assert await f(_ModelsClient("u", raise_on_probe=True), {_FP8}) is True
