"""H3 智能加速(2026-09-12)测试。

覆盖:
  · services/h3_accel 纯函数:档位校验 / H3 家族判定 / 规格缺失降级 /
    假 spec 图改写(nodes_to_replace / nodes_to_add / sampler_params,不污染原图)
  · profile_summaries:实测优先,缺失档回落社区参考值并注明 source
  · POST /api/apps/{id}/run:非法档 422 / 非 H3 应用非 off 档 422 /
    H3 应用 + 假 spec → 提交图被改写 + 响应与 Job 回显 / 规格缺失 → 200 降级 applied=false
  · POST /api/h3/t2v:非法档 422(不触碰 worker)/ + 假 spec → 图改写 + 回显
  · GET /api/h3/acceleration/profiles:档位清单 200
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
import app.services.h3 as h3_service
import app.services.h3_accel as h3_accel
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Job, Tenant, User
from app.security import create_token, hash_password

# --------------------------------------------------------------------------- #
# 假规格(与 .regen_tmp/h3_sglang_bench_20260912/profiles.json 同一契约:
# 占位符 id 无关 + model 链 rewire 由实现自动完成 + sampler_params 定向落点)
# --------------------------------------------------------------------------- #

_FAKE_PROFILES = {
    "lossless": {
        "label": "无损加速",
        "recommended": True,
        "speedup": 1.4,
        "nodes_to_add": [
            {
                "class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
                "inputs": {"model": ["<UNETLoader_node>", 0]},
            },
        ],
        "sampler_params": {"steps": 12, "flow_shift_video": 6.0},
    },
    "balanced": {
        "label": "甜点位",
        "recommended": True,
        "speedup": 2.0,
        "nodes_to_add": [
            {
                "class_type": "MiniMaxH3MemoryEfficientSageAttentionPatch",
                "inputs": {"model": ["<UNETLoader_node>", 0]},
            },
            {
                "class_type": "MiniMaxH3BlockCacheT8",
                "inputs": {"model": ["<SagePatch_node>", 0], "residual_diff_threshold": 0.12},
            },
        ],
        "sampler_params": {"steps": 8, "scheduler": "karras"},
    },
    "extreme": {
        "label": "极速预览",
        "recommended": False,  # 安全门用例:下架档必须降级
        "speedup": 3.2,
        "nodes_to_replace": {
            "KSamplerSelect": {"class_type": "MiniMaxH3TurboSampler", "inputs": {}},
        },
        "nodes_to_add": [
            {
                "class_type": "MiniMaxH3TurboLoRA",
                "inputs": {
                    "model": ["<UNETLoader_node>", 0],
                    "lora_name": "turbo.safetensors",
                    "strength": 0.75,
                    "low_vram": False,
                },
            },
        ],
        "sampler_params": {
            "steps": 4,
            "scheduler": "simple",
            "sampler": "<MiniMaxH3TurboSampler>",  # 占位符值 → 跳过,由 replace 负责
            "flow_shift_video": 12.0,
            "flow_shift_audio": 3.0,
        },
    },
    "dangling": {
        "label": "坏规格",
        "recommended": True,
        "nodes_to_add": [
            {"class_type": "GhostPatch", "inputs": {"model": ["<NoSuchNode>", 0]}},
        ],
    },
}

# 直连 KSampler 图形状(基准 hand-built 图):验证两种形状都支持
_KSAMPLER_DIRECT_GRAPH = {
    "3": {"class_type": "UNETLoader", "inputs": {"unet_name": "h3.safetensors"}},
    "7": {"class_type": "KSampler", "inputs": {"model": ["3", 0], "steps": 20, "sampler_name": "euler"}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["7", 0]}},
}

# SamplerCustomAdvanced 三元组链形状(生产 h3-t2v 模板的迷你版,结构同构)
_FAKE_GRAPH = {
    "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3.safetensors"}},
    "9": {"class_type": "BasicScheduler", "inputs": {"model": ["6", 0], "steps": 20, "scheduler": "simple"}},
    "16": {"class_type": "BasicGuider", "inputs": {"model": ["6", 0], "conditioning": ["104", 0]}},
    "17": {"class_type": "KSamplerSelect", "inputs": {"sampler_name": "res_multistep"}},
    "14": {"class_type": "SamplerCustomAdvanced",
           "inputs": {"noise": ["15", 0], "guider": ["16", 0], "sampler": ["17", 0],
                      "sigmas": ["9", 0], "latent_image": ["104", 1]}},
    "15": {"class_type": "RandomNoise", "inputs": {"noise_seed": 0}},
    "104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"prompt": "hi"}},
    "92": {"class_type": "SaveVideo", "inputs": {}},
}


# --------------------------------------------------------------------------- #
# services/h3_accel 纯函数
# --------------------------------------------------------------------------- #


def test_validate_acceleration_ok_and_bad():
    assert h3_accel.validate_acceleration("off") == "off"
    assert h3_accel.validate_acceleration(" Balanced ") == "balanced"
    for bad in ("", "fast", "turbo", "on"):
        with pytest.raises(ValueError):
            h3_accel.validate_acceleration(bad)


def test_is_h3_family_by_id_prefix_and_nodes():
    assert h3_accel.is_h3_family("h3-anything", set())
    assert h3_accel.is_h3_family("rh-acc-1", {"MiniMaxH3ImageToVideo", "SaveVideo"})
    assert h3_accel.is_h3_family("rh-acc-1", {"RHMiniMaxH3Foo"})
    assert h3_accel.is_h3_family("rh-acc-1", {"MyHailuoH3Node"})
    assert not h3_accel.is_h3_family("rh-acc-1", {"KSampler", "SaveVideo"})
    assert not h3_accel.is_h3_family("", set())


def test_apply_acceleration_off_unchanged():
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "off", profiles=_FAKE_PROFILES)
    assert applied is False
    assert out == _FAKE_GRAPH


def test_apply_acceleration_missing_spec_degrades(monkeypatch):
    """规格缺失/档位缺失/空改写/recommended=false → 原样提交,applied=False(降级不报错)。"""
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: None)  # 自包含:不依赖真实规格文件
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "balanced", profiles=None)
    assert applied is False
    assert out == _FAKE_GRAPH
    # 安全门:extreme 在假规格里 recommended=false → 降级(生产事故 2026-09-12 的处置口径)
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "extreme", profiles=_FAKE_PROFILES)
    assert applied is False
    assert out == _FAKE_GRAPH
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "balanced", profiles={"balanced": {}})
    assert applied is False


def _assert_links_valid(out: dict):
    """每条 [node_id, slot] 引用必须指向图内存在节点(无悬空/无字符串入对象槽)。"""
    for nid, node in out.items():
        for key, value in (node.get("inputs") or {}).items():
            if isinstance(value, list) and len(value) == 2 and isinstance(value[0], str) and isinstance(value[1], int):
                assert value[0] in out, f"节点 {nid}.{key} 引用不存在的节点 {value[0]}"


def test_apply_acceleration_transform_with_fake_spec():
    """lossless 档:SagePatch 追加 + 占位符解析 + model 链改接 + 定向 steps。"""
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "lossless", profiles=_FAKE_PROFILES)
    assert applied is True
    # nodes_to_add:占位符 <UNETLoader_node> 按 class_type 解析成真实节点 id
    patch_id = next(k for k, v in out.items() if v["class_type"] == "MiniMaxH3MemoryEfficientSageAttentionPatch")
    assert out[patch_id]["inputs"]["model"] == ["6", 0]
    # model 链改接:BasicGuider/BasicScheduler 的 model 从 UNETLoader(6) 改接 patch 输出
    assert out["16"]["inputs"]["model"] == [patch_id, 0]
    assert out["9"]["inputs"]["model"] == [patch_id, 0]
    # sampler_params 定向:steps→BasicScheduler(不污染 KSamplerSelect/SamplerCustomAdvanced)
    assert out["9"]["inputs"]["steps"] == 12
    assert "steps" not in out["17"]["inputs"]
    assert "steps" not in out["14"]["inputs"]
    # SamplerCustomAdvanced.sampler 保持连线(生产 bug 回归:不得被字符串覆盖)
    assert out["14"]["inputs"]["sampler"] == ["17", 0]
    # flow_shift_video → H3 家族节点(104)
    assert out["104"]["inputs"]["flow_shift_video"] == 6.0
    # 连线校验:全图无悬空引用
    _assert_links_valid(out)
    # 原图不被污染(deepcopy):原值保持,新增键不存在
    assert _FAKE_GRAPH["9"]["inputs"]["steps"] == 20
    assert "flow_shift_video" not in _FAKE_GRAPH["104"]["inputs"]
    assert all("SagePatch" not in v["class_type"] for v in _FAKE_GRAPH.values())


def test_apply_acceleration_balanced_two_link_chain():
    """balanced 档:loader → sagePatch → blockCache → guider/scheduler 两环链。"""
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "balanced", profiles=_FAKE_PROFILES)
    assert applied is True
    patch_id = next(k for k, v in out.items() if "SageAttentionPatch" in v["class_type"])
    cache_id = next(k for k, v in out.items() if "BlockCache" in v["class_type"])
    assert out[cache_id]["inputs"]["model"] == [patch_id, 0]  # <SagePatch_node> 解析
    assert out["16"]["inputs"]["model"] == [cache_id, 0]  # 链尾改接
    assert out["9"]["inputs"]["model"] == [cache_id, 0]
    assert out["9"]["inputs"]["steps"] == 8
    assert out["9"]["inputs"]["scheduler"] == "karras"
    assert out["14"]["inputs"]["sampler"] == ["17", 0]
    _assert_links_valid(out)


def test_apply_acceleration_ksampler_direct_shape():
    """直连 KSampler 图形状(基准 hand-built):model 改接 + steps/sampler 定向。"""
    out, applied = h3_accel.apply_acceleration(_KSAMPLER_DIRECT_GRAPH, "balanced", profiles=_FAKE_PROFILES)
    assert applied is True
    patch_id = next(k for k, v in out.items() if "SageAttentionPatch" in v["class_type"])
    cache_id = next(k for k, v in out.items() if "BlockCache" in v["class_type"])
    assert out["7"]["inputs"]["model"] == [cache_id, 0]
    assert out[cache_id]["inputs"]["model"] == [patch_id, 0]
    assert out["7"]["inputs"]["steps"] == 8
    _assert_links_valid(out)


def test_apply_acceleration_extreme_replace_and_placeholder_skip():
    """extreme 档(推荐态):KSamplerSelect 原位换 TurboSampler,占位符 sampler 值跳过。"""
    extreme = json.loads(json.dumps(_FAKE_PROFILES["extreme"]))
    extreme["recommended"] = True
    out, applied = h3_accel.apply_acceleration(
        _FAKE_GRAPH, "extreme", profiles={"extreme": extreme},
    )
    assert applied is True
    # 原位替换:节点 id 17 不变(连线保持),class_type 换实现
    assert out["17"]["class_type"] == "MiniMaxH3TurboSampler"
    assert out["14"]["inputs"]["sampler"] == ["17", 0]
    # TurboLoRA 追加 + model 链改接
    lora_id = next(k for k, v in out.items() if v["class_type"] == "MiniMaxH3TurboLoRA")
    assert out[lora_id]["inputs"]["model"] == ["6", 0]
    assert out["16"]["inputs"]["model"] == [lora_id, 0]
    # sampler_params:占位符值 <MiniMaxH3TurboSampler> 不落地;sampler_name 不被字符串覆盖
    assert "sampler" not in out["17"]["inputs"]
    assert out["17"]["inputs"].get("sampler_name", "res_multistep") != "<MiniMaxH3TurboSampler>"
    assert out["9"]["inputs"]["steps"] == 4
    _assert_links_valid(out)


def test_apply_acceleration_unresolvable_placeholder_degrades():
    """占位符无法解析/连线悬空 → 整体降级原生提交(不提交坏图)。"""
    out, applied = h3_accel.apply_acceleration(_FAKE_GRAPH, "dangling", profiles=_FAKE_PROFILES)
    assert applied is False
    assert out == _FAKE_GRAPH


# --------------------------------------------------------------------------- #
# 生产图形状回归(2026-09-12 接线 bug:fixtures 为 core 真机拉取的 h3-t2v/i2v/fl2v)
# --------------------------------------------------------------------------- #

from tests.h3_prod_graphs_fixture import (  # noqa: E402
    H3_FL2V_GRAPH,
    H3_I2V_GRAPH,
    H3_T2V_GRAPH,
)


@pytest.mark.parametrize("graph", [H3_T2V_GRAPH, H3_I2V_GRAPH, H3_FL2V_GRAPH])
@pytest.mark.parametrize("level", ["lossless", "balanced"])
def test_production_graph_transform_links_and_model_chain(graph, level):
    """生产 SamplerCustomAdvanced 链图 × lossless/balanced:改接后每条边有效、
    model 链 loader→patch→(cache)→guider/scheduler、SamplerCustomAdvanced.sampler 恒为连线。"""
    out, applied = h3_accel.apply_acceleration(graph, level, profiles=_FAKE_PROFILES)
    assert applied is True
    _assert_links_valid(out)
    by_class = {}
    for nid, node in out.items():
        by_class.setdefault(node["class_type"], []).append(nid)
    unet = by_class["UNETLoader"][0]
    guider = by_class["BasicGuider"][0]
    sched = by_class["BasicScheduler"][0]
    sca = by_class["SamplerCustomAdvanced"][0]
    # SamplerCustomAdvanced 四元输入全部保持连线(生产 bug:str 入 sampler 槽)
    for slot in ("noise", "guider", "sampler", "sigmas", "latent_image"):
        v = out[sca]["inputs"][slot]
        assert isinstance(v, list) and v[0] in out, f"{level}: {slot} 必须是有效连线,实际 {v!r}"
    # model 链:guider/scheduler 不再直连 UNETLoader,而是接链尾追加节点
    tail_expected = "MiniMaxH3BlockCacheT8" if level == "balanced" else "MiniMaxH3MemoryEfficientSageAttentionPatch"
    tail = by_class[tail_expected][0]
    assert out[guider]["inputs"]["model"] == [tail, 0]
    assert out[sched]["inputs"]["model"] == [tail, 0]
    if level == "balanced":
        patch = by_class["MiniMaxH3MemoryEfficientSageAttentionPatch"][0]
        assert out[tail]["inputs"]["model"] == [patch, 0]
        assert out[patch]["inputs"]["model"] == [unet, 0]
    else:
        assert out[tail]["inputs"]["model"] == [unet, 0]
    # 定向参数落点:steps→BasicScheduler;sampler 名不被污染
    assert out[sched]["inputs"]["steps"] == (8 if level == "balanced" else 12)
    ks = by_class["KSamplerSelect"][0]
    assert "sampler" not in out[ks]["inputs"]


def test_production_graph_lossless_matches_bench_rewire_doc():
    """与 profiles.json rewire 文档逐字对齐:BasicGuider.model 与 BasicScheduler.model
    改接 SagePatch MODEL 输出;采样/解码链不动。"""
    out, applied = h3_accel.apply_acceleration(H3_T2V_GRAPH, "lossless", profiles=_FAKE_PROFILES)
    assert applied is True
    sched = next(k for k, v in out.items() if v["class_type"] == "BasicScheduler")
    guider = next(k for k, v in out.items() if v["class_type"] == "BasicGuider")
    sca = next(k for k, v in out.items() if v["class_type"] == "SamplerCustomAdvanced")
    ks = next(k for k, v in out.items() if v["class_type"] == "KSamplerSelect")
    decode = next(k for k, v in out.items() if v["class_type"] == "VAEDecode")
    # 采样/解码链不动:除 model 外所有输入与原生图一致
    for nid in (sca, ks, decode):
        before = {k: v for k, v in H3_T2V_GRAPH[nid]["inputs"].items()}
        after = {k: v for k, v in out[nid]["inputs"].items() if k in before}
        assert after == before, f"{nid} 采样/解码链被意外改写"
    assert out[sched]["inputs"]["model"] == out[guider]["inputs"]["model"]


def test_profile_summaries_measured_and_reference(tmp_path):
    spec = tmp_path / "profiles.json"
    spec.write_text(json.dumps({"profiles": {
        "balanced": {"label": "甜点位", "speedup": 2.3},
        "lossless": {"label": "近似无损", "speedup": 1.32, "recommended": False},
    }}))
    data = h3_accel.profile_summaries(spec)
    levels = {l["level"]: l for l in data["levels"]}
    assert data["default"] == "off"
    assert levels["balanced"]["source"] == "measured" and levels["balanced"]["speedup"] == 2.3
    assert levels["balanced"]["recommended"] is True  # 未标 recommended → 默认可用
    assert levels["lossless"]["recommended"] is False  # 基准方下架 → 前端置灰
    assert levels["lossless"]["source"] == "measured"
    assert levels["extreme"]["source"] == "reference"  # 缺失档回落参考值
    assert levels["extreme"]["recommended"] is True
    assert levels["off"]["speedup"] is None and levels["off"]["recommended"] is True
    # 文件缺失 → 全部参考值,不炸
    data = h3_accel.profile_summaries(tmp_path / "nope.json")
    assert all(l["source"] == "reference" for l in data["levels"] if l["level"] != "off")
    assert all(l["recommended"] is True for l in data["levels"])


# --------------------------------------------------------------------------- #
# fixtures / fakes(应用 /run 链路)
# --------------------------------------------------------------------------- #


def _make_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"), tenant_id=tenant.id)
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


def _seed_app(session: Session, **over) -> App:
    a = App(
        id=over.pop("id", "h3-x"),
        name=over.pop("name", "H3 测试应用"),
        workflow_json=over.pop("workflow_json", json.loads(json.dumps(_FAKE_GRAPH))),
        params_schema=over.pop(
            "params_schema",
            [{"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True}],
        ),
        bindings=over.pop("bindings", {"prompt": {"node": "104", "field": "inputs.prompt"}}),
        **over,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return a


class _FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-app-1"


class _FakePool:
    def __init__(self, client) -> None:
        self._client = client

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake_client = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake_client)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    # h3-x 走 _pick_app_client 的 h3 专用分支:桩掉真实实例探测/排队(不联网)
    async def _pick_h3():
        return fake_client

    async def _ready(client, node="MiniMaxH3ImageToVideo"):  # noqa: ANN001
        return None

    async def _vram(client):  # noqa: ANN001
        return None

    monkeypatch.setattr("app.services.h3.pick_h3_client", _pick_h3)
    monkeypatch.setattr("app.services.h3.ensure_h3_enabled", lambda: None)
    monkeypatch.setattr("app.services.h3.ensure_h3_ready", _ready)
    monkeypatch.setattr("app.services.h3.ensure_h3_vram", _vram)
    # 默认空规格(降级路径);个别用例注入假规格
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: None)
    with Session(engine) as s:
        uid = _make_user(s, "accel@toiv.ai")
        _seed_app(s)
        _seed_app(s, id="plain-t2i", workflow_json={
            "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "x", "clip": ["4", 1]}},
            "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
            "8": {"class_type": "KSampler", "inputs": {"steps": 20}},
            "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
        }, params_schema=[], bindings={})
    yield TestClient(app), create_token(uid), engine, fake_client
    app.dependency_overrides.clear()


def _h(token: str, nsfw: bool = False) -> dict:
    headers = {"Authorization": f"Bearer {token}"}
    if nsfw:
        headers["X-NSFW"] = "1"
    return headers


# --------------------------------------------------------------------------- #
# POST /api/apps/{id}/run
# --------------------------------------------------------------------------- #


def test_run_rejects_bad_acceleration_level(ctx):
    c, token, *_ = ctx
    for bad in ("turbo", "on", ""):
        r = c.post(
            "/api/apps/h3-x/run", headers=_h(token),
            json={"values": {"prompt": "x"}, "acceleration": bad},
        )
        assert r.status_code == 422, bad


def test_run_non_h3_app_rejects_acceleration(ctx):
    c, token, *_ = ctx
    r = c.post(
        "/api/apps/plain-t2i/run", headers=_h(token),
        json={"values": {}, "acceleration": "balanced"},
    )
    assert r.status_code == 422
    assert "H3" in r.json()["detail"]
    # off(缺省)不受限
    r = c.post("/api/apps/plain-t2i/run", headers=_h(token), json={"values": {}})
    assert r.status_code == 200
    assert r.json()["acceleration"] == "off"
    assert r.json()["acceleration_applied"] is False


def test_run_h3_with_spec_transforms_graph(ctx, monkeypatch):
    c, token, engine, fake = ctx
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: _FAKE_PROFILES)
    r = c.post(
        "/api/apps/h3-x/run", headers=_h(token),
        json={"values": {"prompt": "一只猫"}, "acceleration": "lossless"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["acceleration"] == "lossless"
    assert r.json()["acceleration_applied"] is True

    submitted = fake.graphs[0]
    # lossless 档新契约:SagePatch 追加 + 占位符解析 + model 链改接 + 定向 steps
    patch_id = next(k for k, v in submitted.items() if "SageAttentionPatch" in v["class_type"])
    assert submitted[patch_id]["inputs"]["model"] == ["6", 0]
    assert submitted["16"]["inputs"]["model"] == [patch_id, 0]
    assert submitted["9"]["inputs"]["model"] == [patch_id, 0]
    assert submitted["9"]["inputs"]["steps"] == 12
    assert submitted["14"]["inputs"]["sampler"] == ["17", 0]  # 生产 bug 回归:连线不被字符串覆盖
    assert submitted["104"]["inputs"]["prompt"] == "一只猫"  # 表单写值不被加速改写冲掉

    # Job params + 作业查询回显
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        snap = json.loads(job.params)
        assert snap["acceleration"] == "lossless"
        assert snap["acceleration_applied"] is True
    r = c.get("/api/jobs/lookup", params={"prompt_id": "prompt-app-1"}, headers=_h(token))
    assert r.status_code == 200
    body = r.json()
    assert body["acceleration"] == "lossless"
    assert body["acceleration_applied"] is True


def test_run_h3_missing_spec_degrades_gracefully(ctx):
    """规格缺失:200 + applied=false + 图原样(不 500)。"""
    c, token, engine, fake = ctx
    r = c.post(
        "/api/apps/h3-x/run", headers=_h(token),
        json={"values": {"prompt": "x"}, "acceleration": "balanced"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["acceleration"] == "balanced"
    assert r.json()["acceleration_applied"] is False
    assert fake.graphs[0]["9"]["class_type"] == "BasicScheduler"


def test_run_h3_off_no_transform(ctx):
    c, token, engine, fake = ctx
    from app.services import h3_accel as accel

    monkey_profiles = _FAKE_PROFILES

    def _boom(*a, **k):  # off 档不应触规格读取
        raise AssertionError("off 档不应读规格")

    import app.routes.apps as apps_mod

    orig = apps_mod.h3_accel.load_profiles
    apps_mod.h3_accel.load_profiles = _boom
    try:
        r = c.post("/api/apps/h3-x/run", headers=_h(token), json={"values": {"prompt": "x"}})
    finally:
        apps_mod.h3_accel.load_profiles = orig
    assert r.status_code == 200
    assert "ac0" not in fake.graphs[0]


# --------------------------------------------------------------------------- #
# POST /api/h3/t2v(引擎工作台链路)
# --------------------------------------------------------------------------- #


class _FakeH3Client:
    def __init__(self) -> None:
        self.base_url = "http://fake-h3"
        self.graphs: list[dict] = []

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-h3-1"

    async def queue_counts(self) -> tuple[int, int]:
        return 0, 0

    async def queue_len(self) -> int:
        return 0

    async def free_memory(self) -> None:
        return None

    async def get_system_stats(self) -> dict:
        return {
            "devices": [
                {
                    "name": "cuda:0 FakeGPU",
                    "type": "cuda",
                    "vram_free": 96 * (1 << 30),
                    "vram_total": 96 * (1 << 30),
                }
            ]
        }


def _install_h3(monkeypatch, fake: _FakeH3Client) -> None:
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)


@pytest.fixture
def h3ctx(monkeypatch):
    engine = create_engine("sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool)
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: None)
    with Session(engine) as s:
        uid = _make_user(s, "accel-h3@toiv.ai")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    yield TestClient(app), create_token(uid), engine, fake
    app.dependency_overrides.clear()


def test_h3_t2v_rejects_bad_acceleration(h3ctx):
    c, token, *_ = h3ctx
    r = c.post(
        "/api/h3/t2v", headers=_h(token),
        json={"positive": "x", "acceleration": "turbo"},
    )
    assert r.status_code == 422  # 参数校验层,不依赖 worker


def test_h3_t2v_off_default_no_echo_change(h3ctx):
    c, token, engine, fake = h3ctx
    r = c.post("/api/h3/t2v", headers=_h(token), json={"positive": "x"})
    assert r.status_code == 200, r.text
    assert r.json()["acceleration"] == "off"
    assert r.json()["acceleration_applied"] is False


def test_h3_t2v_with_spec_transforms_and_echoes(h3ctx, monkeypatch):
    c, token, engine, fake = h3ctx
    monkeypatch.setattr(h3_accel, "load_profiles", lambda *a, **k: _FAKE_PROFILES)
    r = c.post(
        "/api/h3/t2v", headers=_h(token),
        json={"positive": "楼道里的女人", "acceleration": "balanced"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["acceleration"] == "balanced"
    assert r.json()["acceleration_applied"] is True
    assert fake.graphs[0]["9"]["inputs"]["steps"] == 8  # BasicScheduler steps 被改
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-h3-1")).first()
        snap = json.loads(job.params)
        assert snap["acceleration"] == "balanced"
        assert snap["acceleration_applied"] is True


def test_h3_t2v_missing_spec_degrades(h3ctx):
    c, token, engine, fake = h3ctx
    r = c.post(
        "/api/h3/t2v", headers=_h(token),
        json={"positive": "x", "acceleration": "extreme"},
    )
    assert r.status_code == 200, r.text
    assert r.json()["acceleration_applied"] is False
    assert "steps" in fake.graphs[0]["9"]["inputs"]  # 原模板 steps 仍在


def test_h3_accel_profiles_endpoint(h3ctx, monkeypatch):
    c, token, *_ = h3ctx
    r = c.get("/api/h3/acceleration/profiles", headers=_h(token))
    assert r.status_code == 200
    body = r.json()
    assert body["default"] == "off"
    levels = {l["level"]: l for l in body["levels"]}
    assert set(levels) == {"off", "lossless", "balanced", "extreme"}
    # 无规格文件 → 非 off 档全为社区参考值
    assert all(levels[k]["source"] == "reference" for k in ("lossless", "balanced", "extreme"))
    assert isinstance(levels["balanced"]["speedup"], float)
