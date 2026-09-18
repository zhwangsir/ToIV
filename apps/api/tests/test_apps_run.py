"""应用市场 M2(POST /api/apps/{id}/run 运行器)测试。

覆盖:
  - 鉴权 401 / 应用不存在 404 / 他人个人应用 404
  - 表单校验 422:未知参数 / 类型错误 / min/max 越界 / 枚举外值 / 缺 required
  - binding 写图正确(inputs 叶子替换;库内原图不被改写;缺省值补默认)
  - 拓扑注入拒绝:绑定指向连线(list)/不存在节点/写入复合值 一律 422
  - widgets_values 叶子写入
  - 提交建档:Job(kind=app_run, params 存 app_id+表单快照)+ 审计 app.run;
    usage_count 提交时不变,仅 Job 到 done 时 +1(tracker.mark_done,2026-08-30 P2)
  - pool.pick 收到 _extract_required 模型依赖 + 图自动派生的 class_type 集
  - worker 不可达 503
  - NSFW 门控:is_nsfw 应用无 X-NSFW 头 403,带头放行且 Job.nsfw 打标
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, AuditLog, Job, Tenant, User
from app.security import create_token, hash_password

# --------------------------------------------------------------------------- #
# fixtures / fakes
# --------------------------------------------------------------------------- #


def _make_user(session: Session, email: str, role: str = "user") -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
        role=role,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


# 图:3=提示词(含一条连线 inputs.clip —— 拓扑注入诱饵),4=Checkpoint(模型依赖),9=SaveImage
_GRAPH = {
    "3": {"class_type": "CLIPTextEncode", "inputs": {"text": "default prompt", "clip": ["4", 1]}},
    "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
    "8": {"class_type": "KSampler", "inputs": {"steps": 20, "seed": 0}},
    "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
}
_SCHEMA = [
    {"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True},
    {"key": "steps", "label": "步数", "type": "number", "default": 20, "min": 1, "max": 50},
    {"key": "res", "label": "分辨率", "type": "select", "default": "512",
     "options": [{"value": "512", "label": "512"}, {"value": "768", "label": "768"}]},
]
_BINDINGS = {
    "prompt": {"node": "3", "field": "inputs.text"},
    "steps": {"node": "8", "field": "inputs.steps"},
}


def _seed_app(session: Session, **over) -> App:
    a = App(
        id=over.pop("id", "t2i-basic"),
        name=over.pop("name", "文生图基础"),
        workflow_json=over.pop("workflow_json", json.loads(json.dumps(_GRAPH))),
        params_schema=over.pop("params_schema", _SCHEMA),
        bindings=over.pop("bindings", _BINDINGS),
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
        self.calls: list[dict] = []

    @property
    def clients(self) -> list:
        return [self._client]

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        self.calls.append({"required": set(required), "required_nodes": set(required_nodes)})
        return self._client


class _FailPool(_FakePool):
    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        raise ComfyUIError("没有具备所需模型且可用的 worker")


@pytest.fixture
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake_client = _FakeClient()
    pool = _FakePool(fake_client)
    app.dependency_overrides[get_pool] = lambda: pool
    # 不触发真实后台追踪(不联 worker)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        user_id = _make_user(s, "bob@toiv.ai")
        other_id = _make_user(s, "carol@toiv.ai")
        _seed_app(s)
    yield (
        TestClient(app),
        {"user": create_token(user_id), "other": create_token(other_id)},
        {"user": user_id, "other": other_id},
        engine,
        fake_client,
        pool,
    )
    app.dependency_overrides.clear()


def _h(tokens: dict, who: str = "user", nsfw: bool = False) -> dict:
    headers = {"Authorization": f"Bearer {tokens[who]}"}
    if nsfw:
        headers["X-NSFW"] = "1"
    return headers


# --------------------------------------------------------------------------- #
# 鉴权 / 可见性
# --------------------------------------------------------------------------- #
def test_run_requires_auth(ctx):
    c, *_ = ctx
    assert c.post("/api/apps/t2i-basic/run", json={"values": {}}).status_code == 401


def test_run_404_unknown(ctx):
    c, tokens, *_ = ctx
    r = c.post("/api/apps/nope/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 404


def test_run_personal_app_hidden_from_other(ctx):
    c, tokens, ids, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="mine", user_id=ids["user"], is_public=False)
    r = c.post("/api/apps/mine/run", headers=_h(tokens, "other"), json={"values": {"prompt": "x"}})
    assert r.status_code == 404


# --------------------------------------------------------------------------- #
# 表单校验 422
# --------------------------------------------------------------------------- #
def test_run_unknown_value_key_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "ghost": 1}},
    )
    assert r.status_code == 422


def test_run_type_mismatch_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "steps": "twenty"}},
    )
    assert r.status_code == 422


def test_run_min_max_violation_422(ctx):
    c, tokens, *_ = ctx
    for bad in (0, 51):
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens),
            json={"values": {"prompt": "a cat", "steps": bad}},
        )
        assert r.status_code == 422, bad


def test_run_select_enum_violation_422(ctx):
    c, tokens, *_ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "a cat", "res": "999"}},
    )
    assert r.status_code == 422


def test_run_required_missing_422(ctx):
    c, tokens, *_ = ctx
    r = c.post("/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {}})
    assert r.status_code == 422
    assert "prompt" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# 拓扑注入拒绝
# --------------------------------------------------------------------------- #
def test_run_binding_to_link_rejected(ctx):
    """绑定指向连线(list 节点引用)→ 422(禁改拓扑)。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        # 直接落库绕过创建期交叉校验(交叉校验只查节点存在,不查叶子形态)
        _seed_app(s, id="evil", bindings={"prompt": {"node": "3", "field": "inputs.clip"}})
    r = c.post("/api/apps/evil/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_binding_to_missing_node_rejected(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="evil2", bindings={"prompt": {"node": "99", "field": "inputs.text"}})
    r = c.post("/api/apps/evil2/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_binding_to_missing_leaf_rejected(ctx):
    """目标 inputs 键不存在(=新增键改拓扑)→ 422。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="evil3", bindings={"prompt": {"node": "3", "field": "inputs.ghost"}})
    r = c.post("/api/apps/evil3/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 422


def test_run_composite_value_rejected(ctx):
    """复合值不能写入图叶子:多元素 list/dict 422;单元素媒体文件名数组允许窄化为字符串
    (LoadImage/LoadVideo 单文件绑定,2026-08-31 起)。"""
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(
            s, id="evil4",
            params_schema=[{"key": "x", "label": "x", "type": "loras", "default": None}],
            bindings={"x": {"node": "3", "field": "inputs.text"}},
        )
    # 多元素 list 仍拒绝
    r = c.post("/api/apps/evil4/run", headers=_h(tokens), json={"values": {"x": ["a", "b"]}})
    assert r.status_code == 422
    # dict 拒绝
    r = c.post("/api/apps/evil4/run", headers=_h(tokens), json={"values": {"x": {"a": 1}}})
    assert r.status_code == 422


def test_run_images_list_binding_fan_out(ctx):
    """images 列表绑定:两张图写入 110/111,未占用的 112 从提交图省略。"""
    c, tokens, _, engine, fake, _ = ctx
    graph = {
        "110": {"class_type": "LoadImage", "inputs": {"image": "d1.png"}},
        "111": {"class_type": "LoadImage", "inputs": {"image": "d2.png"}},
        "112": {"class_type": "LoadImage", "inputs": {"image": "d3.png"}},
        "4": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "a.safetensors"}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
        "104": {
            "class_type": "FakeRef",
            "inputs": {
                "ref_image_1": ["110", 0],
                "ref_image_2": ["111", 0],
                "ref_image_3": ["112", 0],
            },
        },
    }
    with Session(engine) as s:
        _seed_app(
            s, id="multi-ref",
            workflow_json=graph,
            params_schema=[
                {"key": "images", "label": "参考图", "type": "images", "max": 3, "required": True},
            ],
            bindings={"images": [
                {"node": "110", "field": "inputs.image"},
                {"node": "111", "field": "inputs.image"},
                {"node": "112", "field": "inputs.image"},
            ]},
        )
    r = c.post(
        "/api/apps/multi-ref/run", headers=_h(tokens),
        json={"values": {"images": ["a.png", "b.png"]}},
    )
    assert r.status_code == 200, r.text
    submitted = fake.graphs[0]
    assert submitted["110"]["inputs"]["image"] == "a.png"
    assert submitted["111"]["inputs"]["image"] == "b.png"
    assert "112" not in submitted
    assert submitted["104"]["inputs"]["ref_image_1"] == ["110", 0]
    assert submitted["104"]["inputs"]["ref_image_2"] == ["111", 0]
    assert "ref_image_3" not in submitted["104"]["inputs"]


# --------------------------------------------------------------------------- #
# 写图正确性 + 提交建档
# --------------------------------------------------------------------------- #




def test_build_graph_backfills_text_multiline_dynamic_prompts():
    """WAS Text Multiline 缺 dynamic_prompts 时提交前回填 False(不覆盖已有值)。"""
    from app.routes.apps import _build_graph

    graph = {
        "169": {
            "class_type": "Text Multiline",
            "inputs": {"text": "女人举起双手"},
        },
        "170": {
            "class_type": "Text Multiline",
            "inputs": {"text": "已显式", "dynamic_prompts": True},
        },
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert built["169"]["inputs"]["text"] == "女人举起双手"
    assert built["169"]["inputs"]["dynamic_prompts"] is False
    assert built["170"]["inputs"]["dynamic_prompts"] is True
    # 库内原件不被改写
    assert "dynamic_prompts" not in graph["169"]["inputs"]


_HASH_IMG = "5b4aafaa16a02ec24bcbd30991ff8ef2f21f1314dc707217dc10f219a463827a.png"
_HASH_AUDIO = "194e4fe37050d34777d747ab762cfc83543464f0017ed2212690c862f7d518af.mp3"


def test_build_graph_strips_unbound_hash_load_dead_node():
    """未绑定且哈希文件名的死 Load* 节点(RH 原站残留)从提交图剥离。"""
    from app.routes.apps import _build_graph

    graph = {
        "145": {"class_type": "LoadImage", "inputs": {"image": _HASH_IMG}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert "145" not in built
    assert "145" in graph  # 库内原件不动


def test_build_graph_strips_unbound_hash_load_h3_ref_audio_chain():
    """LoadAudio(未绑定哈希) → AudioCrop → H3 ref_audios 槽:级联剥离。"""
    from app.routes.apps import _build_graph

    graph = {
        "137": {"class_type": "LoadImage", "inputs": {"image": "user_upload.png"}},
        "141": {"class_type": "LoadAudio", "inputs": {"audio": _HASH_AUDIO}},
        "142": {"class_type": "AudioCrop", "inputs": {"audio": ["141", 0], "start_time": "0:00"}},
        "136": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "ref_images.ref_image_0": ["137", 0],
                "ref_audios.ref_audio_0": ["142", 0],
                "prompt": "hello",
            },
        },
    }
    bindings = {"loadimage_image": {"node": "137", "field": "inputs.image"}}
    built = _build_graph(graph, bindings, {})
    assert "141" not in built and "142" not in built
    assert "ref_audios.ref_audio_0" not in built["136"]["inputs"]
    assert built["136"]["inputs"]["ref_images.ref_image_0"] == ["137", 0]
    assert built["137"]["inputs"]["image"] == "user_upload.png"


def test_build_graph_strips_unbound_hash_load_h3_ref_image_via_resize():
    """未绑定哈希 LoadImage → ImageResizeKJv2 → H3 ref_images 槽:级联剥离。"""
    from app.routes.apps import _build_graph

    graph = {
        "151": {"class_type": "LoadImage", "inputs": {"image": _HASH_IMG}},
        "150": {
            "class_type": "ImageResizeKJv2",
            "inputs": {"image": ["151", 0], "width": ["115", 0], "keep_proportion": "crop"},
        },
        "147": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {"ref_images.ref_image_1": ["150", 0], "prompt": "hi"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert "151" not in built and "150" not in built
    assert "ref_images.ref_image_1" not in built["147"]["inputs"]


def test_build_graph_strips_unbound_hash_load_h3_first_frame():
    """未绑定哈希 LoadImage → MiniMaxH3ImageToVideo.first_frame(optional):剥成 t2v。"""
    from app.routes.apps import _build_graph

    graph = {
        "4": {"class_type": "LoadImage", "inputs": {"image": _HASH_IMG}},
        "34": {
            "class_type": "MiniMaxH3ImageToVideo",
            "inputs": {"first_frame": ["4", 0], "prompt": "hi"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert "4" not in built
    assert "first_frame" not in built["34"]["inputs"]


def test_build_graph_keeps_bound_or_unstrippable_load_nodes():
    """绑定的哈希 Load(表单会覆写)与非哈希/非安全下游形态的 Load 一律不剥。"""
    from app.routes.apps import _build_graph

    graph = {
        "207": {"class_type": "LoadImage", "inputs": {"image": _HASH_IMG}},
        "30": {"class_type": "VAEEncode", "inputs": {"pixels": ["207", 0]}},
        "137": {"class_type": "LoadImage", "inputs": {"image": _HASH_IMG}},
        "147": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {"ref_images.ref_image_0": ["137", 0], "prompt": "hi"},
        },
        "240": {"class_type": "LoadImage", "inputs": {"image": "example.png"}},
    }
    bindings = {"loadimage_image": {"node": "137", "field": "inputs.image"}}
    built = _build_graph(graph, bindings, {})
    # 绑定节点保留(表单值覆写哈希)
    assert "137" in built
    # 下游是必需像素输入(VAEEncode) → 非安全形态,不剥
    assert "207" in built
    # 普通文件名不动
    assert "240" in built


_TOIVREF_IMG = "toivref-2cbdebc680534affa8695cc725d07a89.jpg"


def test_build_graph_strips_unbound_toivref_load_node():
    """未绑定 toivref-<32hex> Load*(ToIV 导入残留引用)同哈希规则剥离。"""
    from app.routes.apps import _build_graph

    graph = {
        "67": {"class_type": "LoadImage", "inputs": {"image": _TOIVREF_IMG}},
        "9": {"class_type": "SaveImage", "inputs": {"images": ["8", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert "67" not in built
    assert "67" in graph  # 库内原件不动




def test_build_graph_scheduler_sampler_aliases():
    """RH 非标 scheduler/sampler 别名 → 本地枚举;合法值不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "45": {"class_type": "KSampler", "inputs": {"scheduler": "beta57", "sampler_name": "res_2s"}},
        "4": {"class_type": "KSampler", "inputs": {"scheduler": "bong_tangent", "sampler_name": "res_2m"}},
        "7": {"class_type": "KSampler", "inputs": {"scheduler": "karras", "sampler_name": "euler"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["45"]["inputs"]["scheduler"] == "beta"
    assert built["45"]["inputs"]["sampler_name"] == "dpmpp_2s_ancestral"
    assert built["4"]["inputs"]["scheduler"] == "karras"
    assert built["4"]["inputs"]["sampler_name"] == "dpmpp_2m"
    assert built["7"]["inputs"]["scheduler"] == "karras"
    assert built["7"]["inputs"]["sampler_name"] == "euler"


def test_build_graph_scheduler_alias_after_binding_write():
    """表单 select 绑定写入的非法枚举(beta57)同样被 remap(wave19b 实证)。"""
    from app.routes.apps import _build_graph

    graph = {
        "45": {"class_type": "KSampler", "inputs": {"scheduler": "simple", "sampler_name": "euler"}},
        "48": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_bf16.safetensors"}},
    }
    bindings = {
        "ksampler_scheduler": {"node": "45", "field": "inputs.scheduler"},
        "unetloader_unet_name": {"node": "48", "field": "inputs.unet_name"},
    }
    built = _build_graph(
        graph, bindings,
        {"ksampler_scheduler": "beta57", "unetloader_unet_name": "MiniMax-H3-FL2VA-int8-convrot.safetensors"},
    )
    assert built["45"]["inputs"]["scheduler"] == "beta"
    # 2026-09-14 起精确 int8 已落盘,别名表清空:原值保留不再改写 pruned
    assert built["48"]["inputs"]["unet_name"] == "MiniMax-H3-FL2VA-int8-convrot.safetensors"


def test_build_graph_h3_unet_aliases():
    """H3 权重别名表已清空(精确 int8_convrot 落盘,改写 pruned 反致 mat1/mat2):原值不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "475": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_fl2va_int8_convrot.safetensors"}},
        "1": {"class_type": "UNETLoader", "inputs": {"unet_name": "MiniMax-H3-FL2VA-int8-convrot.safetensors"}},
        "127": {"class_type": "UNETLoader", "inputs": {"unet_name": "MiniMax-H3-Ref2VA-int8-convrot.safetensors"}},
        "9": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3_ref2va_bf16.safetensors"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["475"]["inputs"]["unet_name"] == "minimax_h3_fl2va_int8_convrot.safetensors"
    assert built["1"]["inputs"]["unet_name"] == "MiniMax-H3-FL2VA-int8-convrot.safetensors"
    assert built["127"]["inputs"]["unet_name"] == "MiniMax-H3-Ref2VA-int8-convrot.safetensors"
    assert built["9"]["inputs"]["unet_name"] == "minimax_h3_ref2va_bf16.safetensors"


def test_build_graph_rmbg_white_background():
    """RMBG background 'white' → 'Color' + 补 #FFFFFF;已有 background_color 不覆盖。"""
    from app.routes.apps import _build_graph

    graph = {
        "96": {"class_type": "RMBG", "inputs": {"image": ["95", 0], "background": "white"}},
        "97": {"class_type": "RMBG", "inputs": {"image": ["95", 0], "background": "#FFFFFF", "background_color": "#00FF00"}},
        "98": {"class_type": "RMBG", "inputs": {"image": ["95", 0], "background": "Alpha"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["96"]["inputs"]["background"] == "Color"
    assert built["96"]["inputs"]["background_color"] == "#FFFFFF"
    assert built["97"]["inputs"]["background"] == "Color"
    assert built["97"]["inputs"]["background_color"] == "#00FF00"
    assert built["98"]["inputs"]["background"] == "Alpha"
    assert "background_color" not in built["98"]["inputs"]


def test_build_graph_required_backfill():
    """节点包新增 required 入参按 object_info 默认值回填;已有键不覆盖。"""
    from app.routes.apps import _build_graph

    graph = {
        "46": {"class_type": "LTXDirector", "inputs": {"model": ["1", 0], "clip": ["2", 0], "end_frame": 240}},
        "44": {"class_type": "PainterFluxImageEdit", "inputs": {"clip": ["1", 0], "prompt": "hi", "mode": "2_image"}},
        "179": {"class_type": "AILab_QwenVL", "inputs": {"model_name": "Qwen3-VL-4B-Instruct"}},
        "34": {"class_type": "UltimateSDUpscale", "inputs": {"image": ["1", 0]}},
        "99": {"class_type": "Flux2Scheduler", "inputs": {"steps": 20}},
        "14": {"class_type": "NunchakuQwenImageDiTLoader", "inputs": {"model_name": "10eros_v14.safetensors"}},
    }
    built = _build_graph(graph, {}, {})
    lt = built["46"]["inputs"]
    assert lt["start_second"] == 0.0 and lt["start_frame"] == 0
    assert lt["end_frame"] == 240  # 已有值不覆盖
    assert lt["duration_frames"] == 120 and lt["timeline_data"] == ""
    pf = built["44"]["inputs"]
    assert pf["mode"] == "2_image" and pf["batch_size"] == 1
    assert built["179"]["inputs"]["attention_mode"] == "auto"
    assert built["34"]["inputs"]["batch_size"] == 1
    fx = built["99"]["inputs"]
    assert fx["width"] == 1024 and fx["height"] == 1024
    assert built["14"]["inputs"]["cpu_offload"] == "auto"


def test_build_graph_qwen_vqa_attention_backfill():
    """Qwen2_VQA/Qwen3_VQA 换代新增 attention required;旧图缺键回填 eager。"""
    from app.routes.apps import _build_graph

    graph = {
        "22": {"class_type": "Qwen2_VQA", "inputs": {"text": "hi", "model": "Qwen2-VL-7B-Instruct"}},
        "23": {"class_type": "Qwen3_VQA", "inputs": {"text": "hi", "attention": "sdpa"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["22"]["inputs"]["attention"] == "eager"
    assert built["23"]["inputs"]["attention"] == "sdpa"  # 已有键不覆盖


def test_build_graph_qwen_edit_prompt_uses_string_slot():
    """TextEncodeQwenImageEdit*.prompt 接 easy promptLine COMBO 槽 → 改接 STRING 槽。"""
    from app.routes.apps import _build_graph

    graph = {
        "3": {"class_type": "easy promptLine", "inputs": {"prompt": "hi", "start_index": 0, "max_rows": 1000}},
        "14": {
            "class_type": "TextEncodeQwenImageEditPlusAdvance_lrzjason",
            "inputs": {"prompt": ["3", 1], "clip": ["15", 0]},
        },
        "16": {
            "class_type": "TextEncodeQwenImageEditPlusAdvance_lrzjason",
            "inputs": {"prompt": ["5", 0], "clip": ["15", 0]},
        },
        "18": {
            "class_type": "TextEncodeQwenImageEditPlusAdvance_lrzjason",
            "inputs": {"prompt": "裸字符串", "clip": ["15", 0]},
        },
    }
    graph["5"] = {"class_type": "Text Multiline", "inputs": {"text": "x"}}
    built = _build_graph(graph, {}, {})
    assert built["14"]["inputs"]["prompt"] == ["3", 0]
    assert built["16"]["inputs"]["prompt"] == ["5", 0]
    assert built["18"]["inputs"]["prompt"] == "裸字符串"


def test_build_graph_tiny_vae_and_sd3_clip_basename():
    """ModelPreviewOverrideKJ taeh3→none;CLIP 加载器 sd3/ 子路径 → basename。"""
    from app.routes.apps import _build_graph

    graph = {
        "218": {"class_type": "ModelPreviewOverrideKJ", "inputs": {"model": ["1", 0], "tiny_vae": "taeh3.safetensors"}},
        "219": {"class_type": "ModelPreviewOverrideKJ", "inputs": {"model": ["1", 0], "tiny_vae": "none"}},
        "42": {"class_type": "DualCLIPLoader", "inputs": {"clip_name1": "sd3/t5xxl_fp16.safetensors", "clip_name2": "sd3/clip_l.safetensors"}},
        "11": {"class_type": "CLIPLoader", "inputs": {"clip_name": "clip_l.safetensors"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["218"]["inputs"]["tiny_vae"] == "none"
    assert built["219"]["inputs"]["tiny_vae"] == "none"
    assert built["42"]["inputs"]["clip_name1"] == "t5xxl_fp16.safetensors"
    assert built["42"]["inputs"]["clip_name2"] == "clip_l.safetensors"
    assert built["11"]["inputs"]["clip_name"] == "clip_l.safetensors"


def test_build_graph_ltxv_dynamiccombo_parent_backfill():
    """仅点号键但缺父键 num_images → 按最大 image 序号回填(wave10 execute 缺参)。"""
    from app.routes.apps import _build_graph

    graph = {
        "48": {
            "class_type": "LTXVImgToVideoInplaceKJ",
            "inputs": {
                "vae": ["70", 0],
                "num_images.image_1": ["56", 0],
                "num_images.strength_1": 0.8,
            },
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["48"]["inputs"]["num_images"] == "1"
    assert built["48"]["inputs"]["num_images.image_1"] == ["56", 0]


def test_build_graph_trim_audio_duration_swaps_inverted_range():
    """TrimAudioDuration start>=end 时交换;正常范围不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "1": {"class_type": "TrimAudioDuration", "inputs": {"audio": ["9", 0], "start_time": "0:05", "end_time": "0:02"}},
        "2": {"class_type": "TrimAudioDuration", "inputs": {"audio": ["9", 0], "start_time": "0:01", "end_time": "0:04"}},
        "3": {"class_type": "TrimAudioDuration", "inputs": {"audio": ["9", 0], "start_time": 5.0, "end_time": 2}},
    }
    built = _build_graph(graph, {}, {})
    assert built["1"]["inputs"]["start_time"] == "0:02"
    assert built["1"]["inputs"]["end_time"] == "0:05"
    assert built["2"]["inputs"]["start_time"] == "0:01"
    assert built["2"]["inputs"]["end_time"] == "0:04"
    assert built["3"]["inputs"]["start_time"] == 2
    assert built["3"]["inputs"]["end_time"] == 5.0




def test_build_graph_rewrites_ltxv_inplace_kj_dynamiccombo():
    """LTXVImgToVideoInplaceKJ 裸 image_1 → num_images.image_1;回填 num_images。"""
    from app.routes.apps import _build_graph

    graph = {
        "48": {
            "class_type": "LTXVImgToVideoInplaceKJ",
            "inputs": {
                "vae": ["70", 0],
                "latent": ["59", 0],
                "image_1": ["56", 0],
                "strength_1": 1.0,
                "index_1": 0,
                "strength_2": 1.0,
                "index_2": 0,  # 无 image_2 → 丢弃, num_images=1
            },
        },
        "49": {
            "class_type": "LTXVImgToVideoInplaceKJ",
            "inputs": {
                "vae": ["70", 0],
                "latent": ["59", 0],
                "num_images": "1",
                "num_images.image_1": ["56", 0],
                "num_images.strength_1": 0.8,
            },
        },
    }
    built = _build_graph(graph, {}, {})
    inp = built["48"]["inputs"]
    assert inp["num_images"] == "1"
    assert inp["num_images.image_1"] == ["56", 0]
    assert inp["num_images.strength_1"] == 1.0
    assert inp["num_images.index_1"] == 0
    assert "num_images.strength_2" not in inp
    assert "strength_2" not in inp
    assert "image_1" not in inp
    assert "strength_1" not in inp
    # 已是点号键不动
    inp2 = built["49"]["inputs"]
    assert inp2["num_images"] == "1"
    assert inp2["num_images.image_1"] == ["56", 0]
    assert inp2["num_images.strength_1"] == 0.8
    assert "image_1" not in inp2
    # 库内原件不被改写
    assert "image_1" in graph["48"]["inputs"]
    assert "num_images.image_1" not in graph["48"]["inputs"]



def test_build_graph_rewrites_ltxv_add_guide_multi_dynamiccombo():
    """LTXVAddGuideMulti 裸 image_1 → num_guides.image_1;回填 num_guides。"""
    from app.routes.apps import _build_graph

    graph = {
        "422": {
            "class_type": "LTXVAddGuideMulti",
            "inputs": {
                "positive": ["9", 0],
                "negative": ["9", 1],
                "vae": ["70", 0],
                "latent": ["59", 0],
                "image_1": ["289", 0],
                "image_2": ["347", 0],
                "frame_idx_1": 0,
                "frame_idx_2": 8,
                "strength_1": 0.5,
                "strength_2": 0.8,
                "strength_3": 1.0,  # 无 image_3 → 丢弃
            },
        }
    }
    built = _build_graph(graph, {}, {})
    inp = built["422"]["inputs"]
    assert inp["num_guides"] == "2"
    assert inp["num_guides.image_1"] == ["289", 0]
    assert inp["num_guides.image_2"] == ["347", 0]
    assert inp["num_guides.frame_idx_2"] == 8
    assert inp["num_guides.strength_1"] == 0.5
    assert "num_guides.strength_3" not in inp
    assert "image_1" not in inp
    assert "strength_3" not in inp
    assert "image_1" in graph["422"]["inputs"]




def test_build_graph_remaps_latent_upscale_x2_1_0():
    """LatentUpscaleModelLoader 残缺 x2-1.0 → x2-1.1。"""
    from app.routes.apps import _build_graph

    graph = {
        "313": {
            "class_type": "LatentUpscaleModelLoader",
            "inputs": {"model_name": "ltx-2.3-spatial-upscaler-x2-1.0.safetensors"},
        },
        "314": {
            "class_type": "LatentUpscaleModelLoader",
            "inputs": {"model_name": "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["313"]["inputs"]["model_name"] == "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
    assert built["314"]["inputs"]["model_name"] == "ltx-2.3-spatial-upscaler-x2-1.1.safetensors"
    assert graph["313"]["inputs"]["model_name"] == "ltx-2.3-spatial-upscaler-x2-1.0.safetensors"



def test_build_graph_remaps_wan_sampler_teacache_args():
    """WanVideoSampler 旧 teacache_args → cache_args(不覆盖已有 cache_args)。"""
    from app.routes.apps import _build_graph

    graph = {
        "317": {
            "class_type": "WanVideoSampler",
            "inputs": {
                "model": ["22", 0],
                "image_embeds": ["341", 0],
                "steps": 30,
                "cfg": 4.0,
                "shift": 5.0,
                "seed": 1,
                "force_offload": True,
                "scheduler": "unipc",
                "riflex_freq_index": 0,
                "teacache_args": ["330", 0],
            },
        },
        "318": {
            "class_type": "WanVideoSampler",
            "inputs": {
                "model": ["22", 0],
                "image_embeds": ["341", 0],
                "steps": 20,
                "cfg": 1.0,
                "shift": 5.0,
                "seed": 1,
                "force_offload": True,
                "scheduler": "unipc",
                "riflex_freq_index": 0,
                "cache_args": ["330", 0],
                "teacache_args": ["999", 0],
            },
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["317"]["inputs"]["cache_args"] == ["330", 0]
    assert "teacache_args" not in built["317"]["inputs"]
    assert built["318"]["inputs"]["cache_args"] == ["330", 0]
    assert "teacache_args" not in built["318"]["inputs"]
    assert "teacache_args" in graph["317"]["inputs"]



def test_build_graph_backfills_wan_experimental_args():
    """WanVideoExperimentalArgs 缺 use_tcfg 等新字段时回填默认。"""
    from app.routes.apps import _build_graph

    graph = {
        "332": {
            "class_type": "WanVideoExperimentalArgs",
            "inputs": {
                "video_attention_split_steps": "",
                "cfg_zero_star": False,
                "use_zero_init": False,
                "zero_star_steps": 0,
                "use_fresca": False,
                "fresca_scale_low": 1.0,
                "fresca_scale_high": 1.25,
                "fresca_freq_cutoff": 20,
            },
        },
        "333": {
            "class_type": "WanVideoExperimentalArgs",
            "inputs": {
                "video_attention_split_steps": "",
                "cfg_zero_star": True,
                "use_zero_init": False,
                "zero_star_steps": 0,
                "use_fresca": False,
                "fresca_scale_low": 1.0,
                "fresca_scale_high": 1.25,
                "fresca_freq_cutoff": 20,
                "use_tcfg": True,
                "raag_alpha": 0.5,
            },
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["332"]["inputs"]["use_tcfg"] is False
    assert built["332"]["inputs"]["raag_alpha"] == 0.0
    assert built["332"]["inputs"]["tsr_k"] == 0.95
    assert built["333"]["inputs"]["use_tcfg"] is True
    assert built["333"]["inputs"]["raag_alpha"] == 0.5
    assert "use_tcfg" not in graph["332"]["inputs"]


def test_build_graph_remaps_wan_vae_rh_filename():
    """WanVideoVAELoader RH wan_2.1_vae.safetensors → Wan2.1_VAE.pth。"""
    from app.routes.apps import _build_graph

    graph = {
        "38": {
            "class_type": "WanVideoVAELoader",
            "inputs": {"model_name": "wan_2.1_vae.safetensors", "precision": "bf16"},
        },
        "39": {
            "class_type": "WanVideoVAELoader",
            "inputs": {"model_name": "Wan2.1_VAE.pth", "precision": "bf16"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["38"]["inputs"]["model_name"] == "Wan2.1_VAE.pth"
    assert built["39"]["inputs"]["model_name"] == "Wan2.1_VAE.pth"
    assert graph["38"]["inputs"]["model_name"] == "wan_2.1_vae.safetensors"


def test_build_graph_backfills_ailab_qwen_vl_video_frame_size():
    """AILab_QwenVL_Advanced 缺 video_frame_size 时回填 auto(不覆盖已有值)。"""
    from app.routes.apps import _build_graph

    graph = {
        "418": {
            "class_type": "AILab_QwenVL_Advanced",
            "inputs": {
                "model_name": "Qwen3-VL-4B-Instruct",
                "quantization": "None (FP16)",
                "attention_mode": "auto",
                "use_torch_compile": False,
                "device": "auto",
                "preset_prompt": "🖼️ Detailed Description",
                "custom_prompt": "",
                "max_tokens": 1024,
                "temperature": 0.6,
                "top_p": 0.9,
                "num_beams": 1,
                "repetition_penalty": 1.2,
                "frame_count": 16,
                "keep_model_loaded": True,
                "seed": 1,
                "image": ["7", 0],
            },
        },
        "607": {
            "class_type": "AILab_QwenVL_Advanced",
            "inputs": {
                "model_name": "Qwen3-VL-4B-Instruct",
                "frame_count": 16,
                "video_frame_size": "512",
            },
        },
        "1": {
            "class_type": "AILab_QwenVL",
            "inputs": {"model_name": "Qwen3-VL-4B-Instruct"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["418"]["inputs"]["video_frame_size"] == "auto"
    assert built["418"]["inputs"]["frame_count"] == 16
    assert built["607"]["inputs"]["video_frame_size"] == "512"
    assert "video_frame_size" not in built["1"]["inputs"]
    # 库内原件不被改写
    assert "video_frame_size" not in graph["418"]["inputs"]


def test_build_graph_remaps_melband_fs_path_and_sampler_defaults():
    """ethanfel MelBand:FS 路径→registry 显示名;Sampler 缺省回填新 required 字段。"""
    from app.routes.apps import _build_graph

    graph = {
        "359": {
            "class_type": "MelBandRoFormerModelLoader",
            "inputs": {
                "model_name": "MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors",
            },
        },
        "360": {
            "class_type": "MelBandRoFormerSampler",
            "inputs": {
                "model": ["359", 0],
                "audio": ["331", 0],
            },
        },
        "361": {
            "class_type": "MelBandRoFormerModelLoader",
            "inputs": {
                "model_name": "Vocals · Kim fp16 ⭐ [Kijai]",
            },
        },
        "362": {
            "class_type": "MelBandRoFormerSampler",
            "inputs": {
                "model": ["361", 0],
                "audio": ["331", 0],
                "chunk_size": 4.0,
                "overlap": 4,
            },
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["359"]["inputs"]["model_name"] == "Vocals · Kim fp16 ⭐ [Kijai]"
    assert built["360"]["inputs"]["chunk_size"] == 8.0
    assert built["360"]["inputs"]["overlap"] == 2
    assert built["360"]["inputs"]["fade_size"] == 0.1
    assert built["360"]["inputs"]["batch_size"] == 1
    assert built["360"]["inputs"]["intensity"] == 1.0
    # 已是 registry 名不动;已有 sampler 字段不覆盖
    assert built["361"]["inputs"]["model_name"] == "Vocals · Kim fp16 ⭐ [Kijai]"
    assert built["362"]["inputs"]["chunk_size"] == 4.0
    assert built["362"]["inputs"]["overlap"] == 4
    assert built["362"]["inputs"]["fade_size"] == 0.1
    # 库内原件不被改写
    assert graph["359"]["inputs"]["model_name"] == (
        "MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors"
    )
    assert "chunk_size" not in graph["360"]["inputs"]


def test_build_graph_melband_alias_after_binding_write():
    """表单绑定写入的 FS 路径 MelBand 值同样在 binding 后被 remap(Lane A2)。"""
    from app.routes.apps import _build_graph

    graph = {
        "359": {
            "class_type": "MelBandRoFormerModelLoader",
            "inputs": {"model_name": "Vocals · Kim fp32 [Kijai]"},
        },
    }
    bindings = {
        "melband_model_name": {"node": "359", "field": "inputs.model_name"},
    }
    built = _build_graph(
        graph, bindings,
        {"melband_model_name": "MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors"},
    )
    assert built["359"]["inputs"]["model_name"] == "Vocals · Kim fp16 ⭐ [Kijai]"


def test_build_graph_strips_scaled_quant_for_non_scaled_wan():
    """fp16 Wan 底模配 fp8_*_scaled 时提交前剥 _scaled;scaled 权重保留。"""
    from app.routes.apps import _build_graph

    graph = {
        "22": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "wan2.2_t2v_high_noise_14B_fp16.safetensors",
                "quantization": "fp8_e4m3fn_scaled",
                "base_precision": "fp16_fast",
            },
        },
        "103": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "wan2.2_t2v_low_noise_14B_fp16.safetensors",
                "quantization": "fp8_e4m3fn_scaled_fast",
                "base_precision": "fp16_fast",
            },
        },
        "104": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors",
                "quantization": "fp8_e4m3fn_scaled",
            },
        },
        "105": {
            "class_type": "WanVideoModelLoader",
            "inputs": {
                "model": "wan2.2_t2v_high_noise_14B_fp16.safetensors",
                "quantization": "fp8_e4m3fn",
            },
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["22"]["inputs"]["quantization"] == "fp8_e4m3fn"
    assert built["103"]["inputs"]["quantization"] == "fp8_e4m3fn_fast"
    assert built["104"]["inputs"]["quantization"] == "fp8_e4m3fn_scaled"
    assert built["105"]["inputs"]["quantization"] == "fp8_e4m3fn"
    # 库内原件不被改写
    assert graph["22"]["inputs"]["quantization"] == "fp8_e4m3fn_scaled"


def test_build_graph_rewrites_h3_r2v_bare_autogrow_slots():
    """_build_graph 对 MiniMaxH3ReferenceToVideo 裸槽改写为 AUTOGROW 点号键并省略空槽。"""
    from app.routes.apps import _build_graph

    graph = {
        "110": {"class_type": "LoadImage", "inputs": {"image": "d1.png"}},
        "111": {"class_type": "LoadImage", "inputs": {"image": "d2.png"}},
        "112": {"class_type": "LoadImage", "inputs": {"image": "d3.png"}},
        "104": {
            "class_type": "MiniMaxH3ReferenceToVideo",
            "inputs": {
                "prompt": "x",
                "ref_image_1": ["110", 0],
                "ref_image_2": ["111", 0],
                "ref_image_3": ["112", 0],
            },
        },
    }
    bindings = {
        "images": [
            {"node": "110", "field": "inputs.image"},
            {"node": "111", "field": "inputs.image"},
            {"node": "112", "field": "inputs.image"},
        ],
    }
    built = _build_graph(graph, bindings, {"images": ["a.png", "b.png"]})
    assert built["110"]["inputs"]["image"] == "a.png"
    assert built["111"]["inputs"]["image"] == "b.png"
    assert "112" not in built
    assert built["104"]["inputs"]["ref_images.ref_image_0"] == ["110", 0]
    assert built["104"]["inputs"]["ref_images.ref_image_1"] == ["111", 0]
    assert "ref_image_1" not in built["104"]["inputs"]
    assert "ref_image_3" not in built["104"]["inputs"]
    assert "ref_images.ref_image_2" not in built["104"]["inputs"]


def test_run_ok_writes_graph_and_creates_job(ctx):
    c, tokens, ids, engine, fake, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens),
        json={"values": {"prompt": "一只猫", "steps": 30, "res": "768"}},
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-app-1"
    assert body["worker"] == "http://fake-worker"
    assert body["app_id"] == "t2i-basic"

    # binding 写进提交图:叶子替换,连线不动
    submitted = fake.graphs[0]
    assert submitted["3"]["inputs"]["text"] == "一只猫"
    assert submitted["3"]["inputs"]["clip"] == ["4", 1]  # 拓扑原样
    assert submitted["8"]["inputs"]["steps"] == 30
    # 库内原图不被改写
    with Session(engine) as s:
        a = s.get(App, "t2i-basic")
        assert a.workflow_json["3"]["inputs"]["text"] == "default prompt"

    # Job 建档:kind 按产物类型派生(默认 submit_kind=app_run 视作未定制 → app_image),
    # params 存 app_id+表单快照,prompt 取首个文本参数
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job is not None
        assert job.kind == "app_image"
        assert job.status == "queued"
        assert job.prompt == "一只猫"
        snap = json.loads(job.params)
        assert snap["app_id"] == "t2i-basic"
        assert snap["values"]["prompt"] == "一只猫"
        assert snap["values"]["res"] == "768"


def test_run_defaults_applied(ctx):
    """未提供的参数按 default 写图(steps 缺省 20)。"""
    c, tokens, _, _, fake, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "dog"}}
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["8"]["inputs"]["steps"] == 20


def test_run_usage_count_not_incremented_on_submit(ctx):
    """2026-08-30 P2:提交即 +1 是误计(失败也计)——run 不再动 usage_count,仅审计。"""
    c, tokens, _, engine, _, _ = ctx
    for _ in range(2):
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 200
    assert r.json()["usage_count"] == 0  # 提交后未 done,不计数
    with Session(engine) as s:
        a = s.get(App, "t2i-basic")
        assert a.usage_count == 0
        logs = s.exec(select(AuditLog).where(AuditLog.action == "app.run")).all()
        assert len(logs) == 2
        assert logs[0].target_type == "app" and logs[0].target_id == "t2i-basic"


def test_run_usage_count_incremented_on_done(ctx):
    """Job 到 done 时 tracker.mark_done 按 params.app_id +1;幂等不重复计;
    失败/取消不 +1;应用被删时 done 不炸。"""
    from unittest.mock import patch

    import app.comfy.tracker as tracker_mod

    c, tokens, _, engine, _, _ = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 0

    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-1", ["/api/images?filename=a.png"])
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job.status == "done"

        # 幂等:重复 mark_done 不重复计数
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-1", ["/api/images?filename=a.png"])
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1

    # 失败作业不计数(第二条作业直接落库,prompt_id 与第一条不同)
    with Session(engine) as s:
        s.add(Job(
            tenant_id=job.tenant_id, user_id=job.user_id, prompt_id="prompt-app-2",
            worker="http://fake-worker", kind="app_run", status="queued",
            prompt="y", params=json.dumps({"app_id": "t2i-basic", "values": {}}),
        ))
        s.commit()
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_status("prompt-app-2", "error", "worker 执行失败")
    with Session(engine) as s:
        assert s.get(App, "t2i-basic").usage_count == 1

    # 应用已删除:done 回写不炸、不阻塞落库
    with Session(engine) as s:
        s.add(Job(
            tenant_id=job.tenant_id, user_id=job.user_id, prompt_id="prompt-app-3",
            worker="http://fake-worker", kind="app_run", status="queued",
            prompt="z", params=json.dumps({"app_id": "deleted-app", "values": {}}),
        ))
        s.commit()
    with patch.object(tracker_mod, "engine", engine):
        tracker_mod.mark_done("prompt-app-3", ["/api/images?filename=b.png"])
    with Session(engine) as s:
        job3 = s.exec(select(Job).where(Job.prompt_id == "prompt-app-3")).first()
        assert job3.status == "done"


def test_run_pick_receives_models_and_nodes(ctx):
    """pool.pick 收到 _extract_required 的模型依赖 + 图自动派生的 class_type 集。"""
    c, tokens, _, _, _, pool = ctx
    r = c.post(
        "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    call = pool.calls[0]
    assert call["required"] == {"a.safetensors"}  # ckpt_name 提取
    assert call["required_nodes"] == {
        "CLIPTextEncode", "CheckpointLoaderSimple", "KSampler", "SaveImage"
    }


def test_run_explicit_required_nodes_used(ctx):
    """required_nodes 非空时用配置值(不从图派生)。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_app(s, id="custom-nodes", required_nodes=["MyCustomNode"])
    r = c.post(
        "/api/apps/custom-nodes/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
    )
    assert r.status_code == 200
    assert pool.calls[-1]["required_nodes"] == {"MyCustomNode"}


def test_run_widgets_values_binding(ctx):
    """widgets_values 叶子(widgets_values.N)同样可写。"""
    c, tokens, _, engine, fake, _ = ctx
    g = json.loads(json.dumps(_GRAPH))
    g["8"]["widgets_values"] = [0, 20, "euler"]  # UI 导出形态
    with Session(engine) as s:
        _seed_app(
            s, id="wv", workflow_json=g,
            bindings={"steps": {"node": "8", "field": "widgets_values.1"}},
        )
    r = c.post(
        "/api/apps/wv/run", headers=_h(tokens),
        json={"values": {"prompt": "x", "steps": 42}},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["8"]["widgets_values"][1] == 42


def test_run_pool_unavailable_503(ctx):
    c, tokens, *_ = ctx
    app.dependency_overrides[get_pool] = lambda: _FailPool(_FakeClient())
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 503
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]


def test_run_worker_4xx_passthrough(ctx):
    """worker 拒绝(400)透传,不建档、不计数。"""

    class _RejectClient(_FakeClient):
        async def queue_prompt(self, graph, client_id):  # noqa: ANN001
            raise ComfyUIError("bad prompt", status_code=400, detail="bad prompt")

    c, tokens, _, engine, _, _ = ctx
    app.dependency_overrides[get_pool] = lambda: _FakePool(_RejectClient())
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
        assert r.status_code == 400
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.kind == "app_run")).first() is None
        assert s.get(App, "t2i-basic").usage_count == 0


# --------------------------------------------------------------------------- #
# NSFW 门控
# --------------------------------------------------------------------------- #
def test_run_nsfw_app_requires_header(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="nsfw-app", is_nsfw=True)
    r = c.post("/api/apps/nsfw-app/run", headers=_h(tokens), json={"values": {"prompt": "x"}})
    assert r.status_code == 403


def test_run_nsfw_app_with_header_ok(ctx):
    c, tokens, _, engine, _, _ = ctx
    with Session(engine) as s:
        _seed_app(s, id="nsfw-app", is_nsfw=True)
    r = c.post(
        "/api/apps/nsfw-app/run", headers=_h(tokens, nsfw=True),
        json={"values": {"prompt": "x"}},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == "prompt-app-1")).first()
        assert job.nsfw is True  # NSFW 应用产物打 R18 标

def test_run_h3_graph_uses_dedicated_client_not_pool(ctx, monkeypatch):
    """海螺图含 MiniMaxH3* 时走 pick_h3_client,不进通用 WorkerPool。"""
    from unittest.mock import AsyncMock

    c, tokens, _, engine, _, pool = ctx
    graph = {
        "6": {"class_type": "UNETLoader", "inputs": {"unet_name": "minimax_h3.safetensors"}},
        "104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"prompt": "hi"}},
        "9": {"class_type": "SaveVideo", "inputs": {}},
    }
    with Session(engine) as s:
        _seed_app(
            s, id="h3-i2v-app",
            workflow_json=graph,
            params_schema=[{"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True}],
            bindings={"prompt": {"node": "104", "field": "inputs.prompt"}},
        )

    fake = pool.client if hasattr(pool, "client") else None
    # 复用 pool 里那台假 client 的 queue_prompt,但 pick 不应被调用
    h3_client = pool._client if hasattr(pool, "_client") else None

    class _H3:
        def __init__(self, inner):
            self.inner = inner
            self.base_url = "http://192.168.71.127:8195"
        async def queue_prompt(self, graph, client_id):  # noqa: ANN001
            return await self.inner.queue_prompt(graph, client_id)

    inner = pool
    # ctx pool 是 _RecordingPool,本身 queue_prompt 在其 client 上
    rec = pool

    async def _pick_h3():
        # 借用 recording pool 的 queue: 直接返回一个带 queue_prompt 的对象
        class C:
            base_url = "http://192.168.71.127:8195"
            async def queue_prompt(self, graph, client_id):  # noqa: ANN001
                return "h3-prompt-id"
        return C()

    monkeypatch.setattr("app.services.h3.pick_h3_client", _pick_h3)
    monkeypatch.setattr("app.services.h3.ensure_h3_enabled", lambda: None)

    async def _ready(client, node="MiniMaxH3ImageToVideo"):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_ready", _ready)

    async def _vram(client):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_vram", _vram)

    r = c.post(
        "/api/apps/h3-i2v-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "一只猫"}},
    )
    assert r.status_code == 200, r.text
    assert r.json()["prompt_id"] == "h3-prompt-id"
    assert pool.calls == []


# --------------------------------------------------------------------------- #
# 媒体转运:专用实例不在 WorkerPool,上传 kind 钉传可能落在任一专用实例
# (2026-09-13 wave16 实证 :8195 上传 → H3 双池改选 :8198 提交,转运源只查
# pool.clients → 404「媒体文件无法转运到运行实例」)
# --------------------------------------------------------------------------- #
class _MediaClient:
    """带 input 文件柜的假 worker client:记录上传,可按名读回。"""

    def __init__(self, base_url: str, files: dict | None = None) -> None:
        self.base_url = base_url
        self.files = dict(files or {})
        self.uploaded: list[str] = []

    async def get_image_bytes(self, name: str, subfolder: str, type_: str):  # noqa: ANN001
        if name in self.files:
            return self.files[name], "image/jpeg"
        raise ComfyUIError(f"读取图片失败: {name} not found")

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.files[filename] = content
        self.uploaded.append(filename)
        return filename

    async def queue_prompt(self, graph: dict, client_id: str) -> str:  # noqa: ANN001
        return "prompt-media-1"


_MEDIA_GRAPH = {
    "110": {"class_type": "LoadImage", "inputs": {"image": "ref_pic.jpg"}},
    "104": {"class_type": "MiniMaxH3ImageToVideo", "inputs": {"prompt": "hi", "ref_image": ["110", 0]}},
    "9": {"class_type": "SaveVideo", "inputs": {}},
}


def _seed_media_app(session: Session, aid: str = "h3-media-app") -> None:
    _seed_app(
        session,
        id=aid,
        workflow_json=json.loads(json.dumps(_MEDIA_GRAPH)),
        params_schema=[
            {"key": "prompt", "label": "提示词", "type": "textarea", "default": "", "required": True},
            {"key": "img", "label": "参考图", "type": "images", "required": True},
        ],
        bindings={
            "prompt": {"node": "104", "field": "inputs.prompt"},
            "img": {"node": "110", "field": "inputs.image"},
        },
    )


def _patch_dedicated_sources(monkeypatch, pool_client, target_client, extra_sources):
    """把专用实例源换成假 client:pool 之外挂 extra_sources(H3 第二实例等)。"""
    monkeypatch.setattr(
        "app.services.h3.h3_instances", lambda: [s.base_url for s in extra_sources]
    )
    by_url = {s.base_url: s for s in extra_sources}
    monkeypatch.setattr(
        apps_route, "ComfyUIClient",
        lambda url, timeout=None: by_url.get(url, _MediaClient(url)),
    )
    for name, module in (
        ("get_longcat_client", "app.services.longcat"),
        ("get_animate2_client", "app.services.wan_animate2"),
        ("get_qwen_edit_client", "app.services.qwen_edit"),
    ):
        monkeypatch.setattr(f"{module}.{name}", lambda: (_ for _ in ()).throw(RuntimeError), raising=False)

    async def _pick_h3():
        return target_client

    monkeypatch.setattr("app.services.h3.pick_h3_client", _pick_h3)
    monkeypatch.setattr("app.services.h3.ensure_h3_enabled", lambda: None)

    async def _ready(client, node="MiniMaxH3ImageToVideo"):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_ready", _ready)

    async def _vram(client):  # noqa: ANN001
        return None
    monkeypatch.setattr("app.services.h3.ensure_h3_vram", _vram)


def test_run_transfers_media_from_dedicated_h3_peer(ctx, monkeypatch):
    """媒体在 H3 另一实例(不在通用池)→ /run 转运成功,提交不被 502 拦下。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_media_app(s)
    pool._client = _MediaClient("http://fake-worker")
    target = _MediaClient("http://192.168.71.116:8198")  # 提交落点
    h3_peer = _MediaClient("http://192.168.71.127:8195", {"ref_pic.jpg": b"jpg-bytes"})
    _patch_dedicated_sources(monkeypatch, pool._client, target, [h3_peer])

    r = c.post(
        "/api/apps/h3-media-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "一只猫", "img": "ref_pic.jpg"}},
    )
    assert r.status_code == 200, r.text
    assert target.files["ref_pic.jpg"] == b"jpg-bytes"
    assert target.uploaded == ["ref_pic.jpg"]


def test_run_transfers_media_from_pool_worker_still_works(ctx, monkeypatch):
    """回归:媒体只在通用池 worker 上的旧路径不受影响。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_media_app(s)
    pool._client = _MediaClient("http://fake-worker", {"ref_pic.jpg": b"pool-bytes"})
    target = _MediaClient("http://192.168.71.116:8198")
    _patch_dedicated_sources(monkeypatch, pool._client, target, [])

    r = c.post(
        "/api/apps/h3-media-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "x", "img": "ref_pic.jpg"}},
    )
    assert r.status_code == 200, r.text
    assert target.files["ref_pic.jpg"] == b"pool-bytes"


def test_run_media_transfer_impossible_502(ctx, monkeypatch):
    """池与专用实例都没有该媒体 → 502 且不建档。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_media_app(s)
    pool._client = _MediaClient("http://fake-worker")  # 池里也没有
    target = _MediaClient("http://192.168.71.116:8198")
    _patch_dedicated_sources(monkeypatch, pool._client, target, [])

    r = c.post(
        "/api/apps/h3-media-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "x", "img": "ghost.jpg"}},
    )
    assert r.status_code == 502
    assert "媒体文件无法转运" in r.json()["detail"]
    assert "110(LoadImage)" in r.json()["detail"]  # 点名图内引用节点,便于分流
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.kind == "app_run")).first() is None


def test_run_media_already_on_target_skips_transfer(ctx, monkeypatch):
    """媒体已在目标实例(pin 上传路径)→ 零转运直接提交。"""
    c, tokens, _, engine, _, pool = ctx
    with Session(engine) as s:
        _seed_media_app(s)
    target = _MediaClient("http://192.168.71.116:8198", {"ref_pic.jpg": b"already"})
    _patch_dedicated_sources(monkeypatch, pool._client, target, [])

    r = c.post(
        "/api/apps/h3-media-app/run",
        headers=_h(tokens),
        json={"values": {"prompt": "x", "img": "ref_pic.jpg"}},
    )
    assert r.status_code == 200, r.text
    assert target.uploaded == []


# --------------------------------------------------------------------------- #
# 部分校验失败(ComfyUI ≥0.3x):/prompt 200 + node_errors,主保存节点被判死
# → 提交层立即 422 透出真因并撤销入队作业(wave16「主保存节点未产出」根因)
# --------------------------------------------------------------------------- #
class _PartialValidationClient(_FakeClient):
    def __init__(self, node_errors: dict) -> None:
        super().__init__()
        self.node_errors = node_errors
        self.canceled: list[str] = []

    async def queue_prompt_validated(self, graph: dict, client_id: str):  # noqa: ANN001
        return "prompt-doomed-1", self.node_errors

    async def cancel_prompt(self, prompt_id: str) -> str:
        self.canceled.append(prompt_id)
        return "dequeued"


def test_run_partial_validation_doomed_save_422(ctx, monkeypatch):
    """失效节点的 dependent_outputs 覆盖全部保存节点 → 422 + 撤销 + 不建档。"""
    c, tokens, _, engine, _, pool = ctx
    node_errors = {
        "72": {
            "errors": [{"type": "value_not_in_list", "message": "Value not in list",
                        "details": "model: 'sam3.pt' not in []"}],
            "dependent_outputs": ["73", "9"],
            "class_type": "easy sam3ModelLoader",
        },
        "8": {
            "errors": [{"type": "required_input_missing", "message": "Required input is missing",
                        "details": "mode"}],
            "dependent_outputs": ["9"],
            "class_type": "PainterFluxImageEdit",
        },
    }
    client = _PartialValidationClient(node_errors)
    app.dependency_overrides[get_pool] = lambda: _FakePool(client)
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]
    assert r.status_code == 422
    detail = r.json()["detail"]
    assert "主保存节点不会执行" in detail
    assert "sam3.pt" in detail
    assert client.canceled == ["prompt-doomed-1"]
    with Session(engine) as s:
        assert s.exec(select(Job).where(Job.kind == "app_run")).first() is None


def test_run_partial_validation_save_survives_ok(ctx, monkeypatch):
    """校验失败但保存节点不在 dependent_outputs → 正常提交(部分图分支可容错)。"""
    c, tokens, _, engine, _, pool = ctx
    node_errors = {
        "72": {
            "errors": [{"type": "value_not_in_list", "message": "Value not in list",
                        "details": "model: 'x.pt' not in []"}],
            "dependent_outputs": ["73"],  # 只影响 Preview 分支
            "class_type": "easy sam3ModelLoader",
        },
    }
    client = _PartialValidationClient(node_errors)
    app.dependency_overrides[get_pool] = lambda: _FakePool(client)
    try:
        r = c.post(
            "/api/apps/t2i-basic/run", headers=_h(tokens), json={"values": {"prompt": "x"}}
        )
    finally:
        app.dependency_overrides[get_pool] = lambda: ctx[5]
    assert r.status_code == 200, r.text
    assert client.canceled == []


def test_doomed_save_nodes_unit():
    """_doomed_save_nodes:空错误/无保存节点/部分判死 三分支。"""
    from app.routes.apps import _doomed_save_nodes

    graph = {
        "9": {"class_type": "SaveImage", "inputs": {}},
        "20": {"class_type": "VHS_VideoCombine", "inputs": {}},
    }
    assert _doomed_save_nodes(graph, {}) == (set(), [])
    assert _doomed_save_nodes(graph, None) == (set(), [])
    # 保存节点自身失效
    doomed, reasons = _doomed_save_nodes(graph, {
        "9": {"errors": [{"message": "bad", "details": "x"}], "dependent_outputs": []},
    })
    assert doomed == {"9"}
    assert reasons and "SaveImage" in reasons[0]
    # 只判死一个保存节点 → 返回交集
    doomed, _ = _doomed_save_nodes(graph, {
        "72": {"errors": [], "dependent_outputs": ["20"], "class_type": "LoaderX"},
    })
    assert doomed == {"20"}
    # 纯前置节点(无保存节点的图)→ 空(无从判死,交由 tracker 事后按产物判定)
    assert _doomed_save_nodes({"1": {"class_type": "KSampler", "inputs": {}}}, {
        "1": {"errors": [{"message": "m", "details": "d"}], "dependent_outputs": []},
    }) == (set(), [])


def test_client_queue_prompt_validated():
    """ComfyUIClient.queue_prompt_validated:200+node_errors 原样返回;拒绝时抛错。"""
    import asyncio
    from unittest.mock import AsyncMock

    from app.comfy.client import ComfyUIClient, ComfyUIError

    client = ComfyUIClient("http://127.0.0.1:9")
    ok = {"prompt_id": "p1", "number": 3, "node_errors": {"8": {"dependent_outputs": ["9"]}}}
    client._post_json = AsyncMock(return_value=ok)
    pid, errors = asyncio.run(client.queue_prompt_validated({}, "cid"))
    assert pid == "p1" and errors == {"8": {"dependent_outputs": ["9"]}}

    client._post_json = AsyncMock(return_value={"node_errors": {"8": {}}, "error": "bad"})
    with pytest.raises(ComfyUIError):
        asyncio.run(client.queue_prompt_validated({}, "cid"))



def test_build_graph_nunchaku_sm120_int4_to_fp4():
    """nunchaku SVDQ int4 → 同构 fp4(SM120 只支持 fp4);表外/已有 fp4 不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "1": {"class_type": "NunchakuQwenImageDiTLoader", "inputs": {"model_name": "svdq-int4_r32-qwen-image-lightningv1.1-8steps.safetensors"}},
        "2": {"class_type": "NunchakuQwenImageDiTLoader", "inputs": {"model_name": "svdq-int4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors"}},
        "3": {"class_type": "NunchakuQwenImageDiTLoader", "inputs": {"model_name": "svdq-fp4_r32-qwen-image.safetensors"}},
        "4": {"class_type": "NunchakuQwenImageDiTLoader", "inputs": {"model_name": "svdq-int4_r32-unknown-model.safetensors"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["1"]["inputs"]["model_name"] == "svdq-fp4_r32-qwen-image-lightningv1.1-8steps.safetensors"
    assert built["2"]["inputs"]["model_name"] == "svdq-fp4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors"
    assert built["3"]["inputs"]["model_name"] == "svdq-fp4_r32-qwen-image.safetensors"
    assert built["4"]["inputs"]["model_name"] == "svdq-int4_r32-unknown-model.safetensors"


def test_build_graph_node_class_aliases():
    """RH 显示名/旧包节点名 → fleet 现网 class_name;本地名不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "1": {"class_type": "GIMM-VFI Interpolate", "inputs": {"gimmvfi_model": ["2", 0], "images": ["3", 0]}},
        "2": {"class_type": "String to Int", "inputs": {"string": "42"}},
        "3": {"class_type": "Depth Anything V2", "inputs": {"images": ["4", 0], "da_model": ["5", 0]}},
        "4": {"class_type": "GIMMVFI_interpolate", "inputs": {"images": ["3", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert built["1"]["class_type"] == "GIMMVFI_interpolate"
    assert built["2"]["class_type"] == "StringToInt"
    assert built["3"]["class_type"] == "DepthAnything_V2"
    assert built["4"]["class_type"] == "GIMMVFI_interpolate"


def test_build_graph_vace_encode_required_backfill():
    """WanVideoVACEEncode 缺 vace_start/end_percent → 0.0/1.0;已有值不覆盖。"""
    from app.routes.apps import _build_graph

    graph = {
        "10": {"class_type": "WanVideoVACEEncode", "inputs": {"vae": ["5", 0], "input_frames": ["30", 0], "width": 832, "height": 480}},
        "11": {"class_type": "WanVideoVACEEncode", "inputs": {"vae": ["5", 0], "vace_start_percent": 0.2}},
    }
    built = _build_graph(graph, {}, {})
    assert built["10"]["inputs"]["vace_start_percent"] == 0.0
    assert built["10"]["inputs"]["vace_end_percent"] == 1.0
    assert built["11"]["inputs"]["vace_start_percent"] == 0.2


def test_build_graph_ltxv_img2video_num_images_from_flat_keys():
    """LTXVImgToVideoInplaceKJ 缺 num_images,flat strength_N/index_N → 按最大序号回填。"""
    from app.routes.apps import _build_graph

    graph = {
        "582": {
            "class_type": "LTXVImgToVideoInplaceKJ",
            "inputs": {"vae": ["553", 0], "latent": ["577", 0], "index_1": "1", "strength_1": 1, "index_5": 0, "strength_5": 1},
        },
        "583": {"class_type": "LTXVImgToVideoInplaceKJ", "inputs": {"vae": ["553", 0], "num_images": "2", "strength_1": 1}},
    }
    built = _build_graph(graph, {}, {})
    assert built["582"]["inputs"]["num_images"] == "5"
    assert built["583"]["inputs"]["num_images"] == "2"


def test_build_graph_wan_video_decode_tile_stride_clamp():
    """WanVideoDecode tile_stride_* > tile_* 时压到 tile 尺寸;合法值不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "28": {"class_type": "WanVideoDecode", "inputs": {"vae": ["38", 0], "samples": ["90", 0], "tile_y": 272, "tile_x": 272, "tile_stride_y": 400, "tile_stride_x": 144}},
        "29": {"class_type": "WanVideoDecode", "inputs": {"vae": ["38", 0], "samples": ["90", 0], "tile_y": 272, "tile_x": 272, "tile_stride_y": 128, "tile_stride_x": 144}},
    }
    built = _build_graph(graph, {}, {})
    assert built["28"]["inputs"]["tile_stride_y"] == 272
    assert built["28"]["inputs"]["tile_stride_x"] == 144
    assert built["29"]["inputs"]["tile_stride_y"] == 128


def test_build_graph_upscale_model_alias_to_local_safetensors():
    """UpscaleModelLoader:RH .pth 名 → 本地已落盘 .safetensors;其它名不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "1": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "2xNomosUni_span_multijpg_ldl.pth"}},
        "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": "4x-UltraSharp.pth"}},
    }
    built = _build_graph(graph, {}, {})
    assert built["1"]["inputs"]["model_name"] == "2xNomosUni_span_multijpg_ldl.safetensors"
    assert built["2"]["inputs"]["model_name"] == "4x-UltraSharp.pth"


def test_build_graph_image_rembg_model_rename():
    """Image Rembg 旧入参 model → required rembg_model;已有 rembg_model 不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "363": {
            "class_type": "Image Rembg (Remove Background)",
            "inputs": {"images": ["361", 0], "model": "u2net", "alpha_matting": False},
        },
        "364": {
            "class_type": "Image Rembg (Remove Background)",
            "inputs": {"images": ["361", 0], "rembg_model": "isnet-general-use"},
        },
    }
    built = _build_graph(graph, {}, {})
    assert built["363"]["inputs"]["rembg_model"] == "u2net"
    assert "model" not in built["363"]["inputs"]
    assert built["364"]["inputs"]["rembg_model"] == "isnet-general-use"


def test_build_graph_compress_images_rename_and_saveimage_wire():
    """CompressImages 旧字段名 → images;孤儿 SaveImage 接同一 IMAGE 源;已连线不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "18": {"class_type": "VAEDecode", "inputs": {"samples": ["23", 0], "vae": ["2", 2]}},
        "26": {
            "class_type": "CompressImages",
            "inputs": {"images or video_path": ["18", 0], "filename_prefix": "ComfyUI"},
        },
        "20": {"class_type": "SaveImage", "inputs": {"filename_prefix": "Qwen-AIO"}},
        "21": {"class_type": "SaveImage", "inputs": {"filename_prefix": "X", "images": ["18", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert built["26"]["inputs"]["images"] == ["18", 0]
    assert "images or video_path" not in built["26"]["inputs"]
    assert built["20"]["inputs"]["images"] == ["18", 0]
    assert built["21"]["inputs"]["images"] == ["18", 0]

    # 无 CompressImages 的图不动孤儿 SaveImage
    graph2 = {"20": {"class_type": "SaveImage", "inputs": {"filename_prefix": "Y"}}}
    built2 = _build_graph(graph2, {}, {})
    assert "images" not in built2["20"]["inputs"]


def test_build_graph_comfy_literals_number_str_after_binding():
    """绑定/回填把 5.0/'5.0' 写进 Int.Number → 整数串;Float 保 float;连线不动。"""
    from app.routes.apps import _build_graph

    graph = {
        "39": {"class_type": "Int", "inputs": {"Number": "720"}},
        "58": {"class_type": "Int", "inputs": {"Number": "5.0"}},
        "60": {"class_type": "Float", "inputs": {"Number": "2"}},
        "61": {"class_type": "Int", "inputs": {"Number": ["39", 0]}},
    }
    bindings = {"int_value_2": {"node": "58", "field": "inputs.Number"}}
    values = {"int_value_2": 5.0}
    built = _build_graph(graph, bindings, values)
    assert built["39"]["inputs"]["Number"] == "720"
    assert built["58"]["inputs"]["Number"] == "5"
    assert built["60"]["inputs"]["Number"] == "2.0"
    assert "61" not in built, "连线喂 Number 的 Int 被 bypass 摘除"


def test_build_graph_wan_experimental_args_fresca_backfill():
    """WanVideoExperimentalArgs 缺 fresca 组 → 回填默认;已有值不覆盖。"""
    from app.routes.apps import _build_graph

    graph = {
        "20": {"class_type": "WanVideoExperimentalArgs", "inputs": {"use_fresca": True, "fresca_scale_high": 1.5}},
    }
    built = _build_graph(graph, {}, {})
    ins = built["20"]["inputs"]
    assert ins["use_fresca"] is True
    assert ins["fresca_scale_high"] == 1.5
    assert ins["fresca_scale_low"] == 1.0
    assert ins["fresca_freq_cutoff"] == 20
    assert ins["cfg_zero_star"] is False
    assert "video_attention_split_steps" not in ins


def test_build_graph_comfy_literals_int_preserves_link():
    """Int.value 是连线时不得 str 化(运行期 int(\"['59', 0]\") 必炸,wave23 烟测实证)。"""
    from app.routes.apps import _build_graph

    graph = {
        "58": {"class_type": "Int", "inputs": {"value": "5"}},
        "59": {"class_type": "MathExpression|pysssss", "inputs": {"a": ["58", 0], "expression": "a*16+1"}},
        "60": {"class_type": "Int", "inputs": {"value": ["59", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert built["58"]["inputs"]["Number"] == "5"
    assert "60" not in built, "连线喂 Number 的 Int 被 bypass 摘除(消费方直连 59)"


def test_build_graph_bypass_comfy_literals_link_node():
    """Int/Float 吃连线的冗余层:消费方直连上游、节点摘除。
    (bindings 绑到连线槽会 422=既有拓扑防护,不在此重复测。)"""
    from app.routes.apps import _build_graph
    import pytest as _pt
    from fastapi import HTTPException as _HE

    graph = {
        "58": {"class_type": "Int", "inputs": {"value": "5"}},
        "59": {"class_type": "MathExpression|pysssss", "inputs": {"a": ["58", 0], "expression": "a*16+1"}},
        "60": {"class_type": "Int", "inputs": {"value": ["59", 0]}},
        "61": {"class_type": "Foo", "inputs": {"x": ["60", 0]}},
    }
    built = _build_graph(graph, {}, {})
    assert "60" not in built, "连线喂 Number 的 Int 应被摘除"
    assert built["61"]["inputs"]["x"] == ["59", 0], "消费方直连上游"

    # 绑定命中连线喂 Number 的节点 → 保留节点(不 bypass),写值时由拓扑防护 422
    graph2 = {
        "58": {"class_type": "Int", "inputs": {"value": "5"}},
        "70": {"class_type": "Int", "inputs": {"value": ["58", 0]}},
    }
    bindings2 = {"seconds": {"node": "70", "field": "inputs.Number"}}
    with _pt.raises(_HE) as ei:
        _build_graph(graph2, bindings2, {"seconds": 5})
    assert ei.value.status_code == 422


# --------------------------------------------------------------------------- #
# kind 派生(2026-09-15 作品库×应用搭配):app_run 遗留默认视作未定制,按产物归类
# --------------------------------------------------------------------------- #
def test_app_job_kind_derivation():
    from app.models import App

    def mk(**kw) -> App:
        base = dict(id="k", name="k", output_kind="video")
        base.update(kw)
        return App(**base)

    f = apps_route._app_job_kind
    assert f(mk()) == "app_video", "遗留 app_run 默认 → 按产物类型派生"
    assert f(mk(submit_kind="")) == "app_video"
    assert f(mk(output_kind="image")) == "app_image"
    assert f(mk(output_kind="audio")) == "app_audio"
    assert f(mk(output_kind="3d")) == "app_3d"
    assert f(mk(output_kind="weird")) == "app_image", "未知产物类型兜底图像"
    assert f(mk(submit_kind="my_custom")) == "my_custom", "显式定制 submit_kind 照旧尊重"
