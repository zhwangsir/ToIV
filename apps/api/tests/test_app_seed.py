"""应用市场 M4:内置应用播种测试(services/app_seed)。

覆盖:
  - 规格数 ≥5 且 id 集符合预期(h3 两件套 + txt2img/img2img + ltx 三件套)
  - 全部规格过结构校验(_check_workflow/_check_params_schema/_check_bindings/_cross_check)
  - 播种幂等(第二次 0 新增)且不回滚人工改动
  - 每个内置应用默认值经 _validate_params + _build_graph 全链路可写图
  - 经 HTTP 运行内置应用:seed(text) 写数值叶子窄化("42"→int、"" 保留模板值)
"""
from __future__ import annotations

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.apps as apps_route
from app.db import get_session
from app.deps import get_pool
from app.main import app
from app.models import App, Tenant, User
from app.routes.apps import _build_graph, _check_bindings, _check_params_schema, _check_workflow, _cross_check, _validate_params
from app.security import create_token, hash_password
from app.services.app_seed import _build_specs, seed_builtin_apps

_EXPECTED_IDS = {
    # 原 7
    "h3-t2v", "h3-i2v", "txt2img-basic", "img2img-basic",
    "ltx-txt2video", "ltx-img2video", "ltx-lipsync",
    # 生产引擎补齐
    "h3-multishot", "h3-fl2v", "h3-r2v",
    "h3-t2v-15s-fast", "h3-i2v-15s-fast", "h3-r2v-voice",
    "h3-nsfw-t2v", "h3-nsfw-i2v", "h3-nsfw-fl2v", "h3-nsfw-r2v",
    "h3-nsfw-t2v-15s-fast", "h3-nsfw-i2v-15s-fast", "h3-nsfw-r2v-voice",
    "nsfw-txt2img", "nsfw-img2img", "qwen-image-edit", "flux1-nunchaku",
    "ltx25-multishot", "wan-nsfw-i2v", "wan-animate", "wan-animate-2", "wan-vace", "vace-edit",
    "longcat-t2v", "longcat-i2v", "avatar-talk",
    "ovi-t2v", "ovi-i2v", "phantom-s2v",
    "ace-music", "ace-music-legacy",
    # 其他可诚实成图的存量工作流
    "inpaint", "upscale", "removebg", "controlnet", "ipadapter", "pulid",
    "facedetailer", "hunyuan-i2v", "latentsync",
}


def _engine():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)
    return engine


def test_specs_at_least_five_and_ids():
    specs = _build_specs()
    assert len(specs) >= 5
    ids = {s["id"] for s in specs}
    assert _EXPECTED_IDS <= ids
    rh = {i for i in ids if i.startswith("rh-")}
    assert len(rh) >= 1000
    assert rh.isdisjoint(_EXPECTED_IDS)


def test_specs_pass_route_validators():
    """全部内置应用走与创建端点同一套校验:图结构 + schema + bindings + 交叉校验。"""
    for spec in _build_specs():
        assert _check_workflow(spec["workflow_json"])
        assert _check_params_schema(spec["params_schema"])
        assert _check_bindings(spec["bindings"])
        _cross_check(spec["workflow_json"], spec["params_schema"], spec["bindings"])


def test_specs_binding_targets_are_scalar_leaves():
    """bindings 不仅节点在图内,字段叶子也必须存在且为标量(app_seed._validate_spec 已断言,
    这里再独立验证一遍字段存在性语义)。"""
    for spec in _build_specs():
        for key, target in spec["bindings"].items():
            slots = target if isinstance(target, list) else [target]
            for t in slots:
                leaf = spec["workflow_json"][t["node"]]["inputs"][
                    t["field"].split(".", 1)[1]
                ]
                assert not isinstance(leaf, (dict, list)), f"{spec['id']}.{key} 绑到连线上了"


def _required_values(schema: list[dict]) -> dict:
    """按 schema 给每个 required 项一个可通过校验的占位值。"""
    out: dict = {}
    for p in schema:
        if not p.get("required"):
            continue
        t = p.get("type", "text")
        if t == "images":
            out[p["key"]] = ["ref.png"]
        elif t == "audio":
            out[p["key"]] = "ref.wav"
        elif t == "video":
            out[p["key"]] = "ref.mp4"
        else:
            out[p["key"]] = "测试提示词"
    return out


def test_specs_default_values_build_runnable_graph():
    """每个内置应用:必填项给值 + 其余默认,能无错写进深拷贝图,且库内原件不被改写。"""
    for spec in _build_specs():
        values = _validate_params(spec["params_schema"], _required_values(spec["params_schema"]))
        graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
        assert graph  # 非空
        # seed 默认 "" → 不写,图内保留模板原值(以 KSampler/RandomNoise 为例抽查)
        assert graph is not spec["workflow_json"]


def test_seed_idempotent_and_builtin_upsert():
    engine = _engine()
    with Session(engine) as s:
        created = seed_builtin_apps(s)
        assert created >= len(_EXPECTED_IDS) + 1000
        assert seed_builtin_apps(s) == 0  # 幂等:重复启动不重复建
        # 内置应用代码即正典(禁止 PUT):人工改动会被播种修复回规格值
        # (2026-08-31 起,用于修复存量坏图/规格漂移;个人应用行仍不动)
        a = s.get(App, "h3-t2v")
        a.name = "人工改名"
        s.add(a)
        s.commit()
        assert seed_builtin_apps(s) == 0
        assert s.get(App, "h3-t2v").name == "海螺 H3 文生视频"
        # 删掉的内置应用下次播种会补回(按 id 判缺)
        s.delete(s.get(App, "h3-i2v"))
        s.commit()
        assert seed_builtin_apps(s) == 1
        rows = s.exec(select(App).where(App.is_builtin == True)).all()  # noqa: E712
        ids = {r.id for r in rows}
        assert _EXPECTED_IDS <= ids
        assert sum(1 for i in ids if i.startswith("rh-")) >= 1000


def test_seed_apps_nsfw_flags():
    """NSFW 引擎(10Eros/URPM/H3-NSFW/Wan-NSFW)标 True,其余 SFW 不标。"""
    specs = {s["id"]: s for s in _build_specs()}
    nsfw_ids = {
        "ltx-txt2video", "ltx-img2video", "ltx-lipsync",
        "h3-nsfw-t2v", "h3-nsfw-i2v", "h3-nsfw-fl2v", "h3-nsfw-r2v",
        "h3-nsfw-t2v-15s-fast", "h3-nsfw-i2v-15s-fast", "h3-nsfw-r2v-voice",
        "nsfw-txt2img", "nsfw-img2img",
        "wan-nsfw-i2v",
    }
    for sid in nsfw_ids:
        assert specs[sid]["is_nsfw"] is True, sid
    for sid in ("h3-t2v", "h3-i2v", "h3-t2v-15s-fast", "h3-i2v-15s-fast",
                "h3-r2v-voice", "txt2img-basic", "img2img-basic",
                "qwen-image-edit", "longcat-t2v", "flux1-nunchaku"):
        assert specs[sid]["is_nsfw"] is False, sid


def test_h3_i2v_requires_images_and_binds_loadimage():
    """h3-i2v 必须上传首帧,绑定 LoadImage 节点 100;缺图走校验 422。"""
    from fastapi import HTTPException

    spec = next(s for s in _build_specs() if s["id"] == "h3-i2v")
    images = next(p for p in spec["params_schema"] if p["key"] == "images")
    assert images.get("required") is True
    assert images["type"] == "images"
    assert images.get("max") == 1
    assert spec["bindings"]["images"] == {"node": "100", "field": "inputs.image"}
    assert spec["workflow_json"]["100"]["class_type"] == "LoadImage"
    try:
        _validate_params(spec["params_schema"], {"positive": "x"})
        raise AssertionError("缺 images 应 422")
    except HTTPException as e:
        assert e.status_code == 422
        assert "images" in str(e.detail)
    values = _validate_params(spec["params_schema"], {"positive": "x", "images": ["first.png"]})
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["100"]["inputs"]["image"] == "first.png"


def test_qwen_edit_defaults_build_runnable_graph():
    """新引擎抽查:qwen-image-edit 用默认值能写出可提交图。"""
    spec = next(s for s in _build_specs() if s["id"] == "qwen-image-edit")
    values = _validate_params(
        spec["params_schema"], {"positive": "把衣服换成红色", "images": ["ref.png"]},
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["7"]["class_type"] == "LoadImage"
    assert graph["7"]["inputs"]["image"] == "ref.png"
    assert graph["4"]["inputs"]["prompt"] == "把衣服换成红色"


def test_vace_edit_requires_video_and_binds_loadvideo():
    """vace-edit 包装 WanVace 编辑图:必填源视频,绑 VHS_LoadVideo 节点 50;缺视频 422。"""
    from fastapi import HTTPException

    spec = next(s for s in _build_specs() if s["id"] == "vace-edit")
    video = next(p for p in spec["params_schema"] if p["key"] == "video")
    assert video.get("required") is True
    assert video["type"] == "video"
    assert spec["bindings"]["video"] == {"node": "50", "field": "inputs.video"}
    assert spec["workflow_json"]["50"]["class_type"] == "VHS_LoadVideo"
    assert spec["workflow_json"]["10"]["class_type"] == "WanVideoVACEEncode"
    try:
        _validate_params(spec["params_schema"], {"positive": "make it snow"})
        raise AssertionError("缺 video 应 422")
    except HTTPException as e:
        assert e.status_code == 422
        assert "video" in str(e.detail)
    values = _validate_params(
        spec["params_schema"], {"positive": "make it snow", "video": "clip.mp4"},
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["50"]["inputs"]["video"] == "clip.mp4"
    assert graph["5"]["inputs"]["positive_prompt"] == "make it snow"


def test_longcat_t2v_defaults_build_runnable_graph():
    """新引擎抽查:longcat-t2v 用默认值能写出可提交图。"""
    spec = next(s for s in _build_specs() if s["id"] == "longcat-t2v")
    values = _validate_params(spec["params_schema"], {"positive": "一只猫在窗台晒太阳"})
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["5"]["inputs"]["positive_prompt"] == "一只猫在窗台晒太阳"
    assert graph["7"]["class_type"] == "WanVideoSampler"


# ---------------------------------------------------------------------------
# 经 HTTP 运行内置应用(seed → run 端到端,pool/tracker 替身)
# ---------------------------------------------------------------------------
def _make_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email.split("@")[0])
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(email=email, hashed_password=hash_password("password1"),
                tenant_id=tenant.id, role="user")
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


class _FakeClient:
    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-seed-1"


class _FakePool:
    def __init__(self, client) -> None:
        self._client = client

    async def pick(self, required=(), required_nodes=()):  # noqa: ANN001
        return self._client


@pytest.fixture
def ctx(monkeypatch):
    engine = _engine()

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    fake = _FakeClient()
    app.dependency_overrides[get_pool] = lambda: _FakePool(fake)
    monkeypatch.setattr(apps_route, "spawn_tracker", lambda client, prompt_id: None)
    with Session(engine) as s:
        user_id = _make_user(s, "bob@toiv.ai")
        seed_builtin_apps(s)
    yield TestClient(app), create_token(user_id), fake
    app.dependency_overrides.clear()


def test_builtin_h3_i2v_run_requires_image(ctx):
    c, token, fake = ctx
    headers = {"Authorization": f"Bearer {token}"}
    miss = c.post(
        "/api/apps/h3-i2v/run", headers=headers,
        json={"values": {"positive": "续写动作"}},
    )
    assert miss.status_code == 422
    assert not fake.graphs
    ok = c.post(
        "/api/apps/h3-i2v/run", headers=headers,
        json={"values": {"positive": "续写动作", "images": ["first.png"]}},
    )
    assert ok.status_code == 200, ok.text
    graph = fake.graphs[0]
    assert graph["100"]["inputs"]["image"] == "first.png"
    assert graph["104"]["inputs"]["prompt"] == "续写动作"


def test_builtin_vace_edit_run_requires_video(ctx):
    c, token, fake = ctx
    headers = {"Authorization": f"Bearer {token}"}
    miss = c.post(
        "/api/apps/vace-edit/run", headers=headers,
        json={"values": {"positive": "make it snow"}},
    )
    assert miss.status_code == 422
    assert not fake.graphs
    ok = c.post(
        "/api/apps/vace-edit/run", headers=headers,
        json={"values": {"positive": "make it snow", "video": "clip.mp4"}},
    )
    assert ok.status_code == 200, ok.text
    graph = fake.graphs[0]
    assert graph["50"]["inputs"]["video"] == "clip.mp4"
    assert graph["5"]["inputs"]["positive_prompt"] == "make it snow"
    assert graph["10"]["class_type"] == "WanVideoVACEEncode"


def test_builtin_h3_run_writes_params(ctx):
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "一只猫在窗台晒太阳", "width": 768, "seed": "42"}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["104"]["inputs"]["prompt"] == "一只猫在窗台晒太阳"
    assert graph["104"]["inputs"]["width"] == 768
    # seed(text)→数值叶子窄化:字符串 "42" 写成 int 42(ComfyUI INT 校验要求)
    assert graph["15"]["inputs"]["noise_seed"] == 42
    assert isinstance(graph["15"]["inputs"]["noise_seed"], int)
    # height 未提供 → 默认值 768 补全写入
    assert graph["104"]["inputs"]["height"] == 768


def test_builtin_seed_empty_keeps_template_value(ctx):
    """seed 留空(默认 "")→ 不写叶子,图内保留模板原值 42,不会把空串写给 worker。"""
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x"}},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["15"]["inputs"]["noise_seed"] == 42  # 模板原值,非 ""


def test_builtin_seed_non_numeric_422(ctx):
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-t2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x", "seed": "abc"}},
    )
    assert r.status_code == 422
    assert not fake.graphs  # 校验失败不提交 worker


def test_builtin_txt2img_run_and_nsfw_gate(ctx):
    c, token, fake = ctx
    # SFW 内置应用可直接跑
    r = c.post(
        "/api/apps/txt2img-basic/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "a cat", "negative": "blurry"}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    # 次世代图节点:4=正向/5=负向 CLIPTextEncode(2026-08-31 从 CheckpointLoaderSimple 模板迁入)
    assert graph["4"]["inputs"]["text"] == "a cat"
    assert graph["5"]["inputs"]["text"] == "blurry"
    # CLIP 必须由独立 CLIPLoader 提供(flux2 fp8mixed 是 UNET-only,CheckpointLoaderSimple 必炸)
    assert graph["3"]["class_type"] == "CLIPLoader"
    assert graph["1"]["class_type"] == "UNETLoader"
    # NSFW 内置应用无 X-NSFW 头 403
    r2 = c.post(
        "/api/apps/ltx-txt2video/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x"}},
    )
    assert r2.status_code == 403
    # 新增 NSFW 引擎同样无 X-NSFW 头 403;带头可提交
    r3 = c.post(
        "/api/apps/nsfw-txt2img/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "x"}},
    )
    assert r3.status_code == 403
    r4 = c.post(
        "/api/apps/nsfw-txt2img/run",
        headers={"Authorization": f"Bearer {token}", "X-NSFW": "1"},
        json={"values": {"positive": "a cat"}},
    )
    assert r4.status_code == 200, r4.text
    assert fake.graphs[-1]["6"]["inputs"]["text"] == "a cat"



def test_h3_fl2v_requires_two_frames_and_binds_loadimage_101():
    """h3-fl2v 必须上传首帧+尾帧,绑定 LoadImage 100/101;缺尾帧 422。"""
    from fastapi import HTTPException

    spec = next(s for s in _build_specs() if s["id"] == "h3-fl2v")
    images = next(p for p in spec["params_schema"] if p["key"] == "images")
    last = next(p for p in spec["params_schema"] if p["key"] == "last_frame")
    assert images.get("required") is True and last.get("required") is True
    assert spec["bindings"]["images"] == {"node": "100", "field": "inputs.image"}
    assert spec["bindings"]["last_frame"] == {"node": "101", "field": "inputs.image"}
    assert spec["workflow_json"]["100"]["class_type"] == "LoadImage"
    assert spec["workflow_json"]["101"]["class_type"] == "LoadImage"
    assert spec["workflow_json"]["104"]["inputs"]["first_frame"] == ["100", 0]
    assert spec["workflow_json"]["104"]["inputs"]["last_frame"] == ["101", 0]
    try:
        _validate_params(spec["params_schema"], {"positive": "x", "images": ["first.png"]})
        raise AssertionError("缺 last_frame 应 422")
    except HTTPException as e:
        assert e.status_code == 422
        assert "last_frame" in str(e.detail)
    values = _validate_params(
        spec["params_schema"],
        {"positive": "x", "images": ["first.png"], "last_frame": ["last.png"]},
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["100"]["inputs"]["image"] == "first.png"
    assert graph["101"]["inputs"]["image"] == "last.png"


def test_h3_r2v_binds_first_ref_image_and_uses_ref2va_node():
    """h3-r2v 预置 9 图 + 3 视频 + 3 音频槽;节点是 ReferenceToVideo + SFW Ref2VA UNET。"""
    spec = next(s for s in _build_specs() if s["id"] == "h3-r2v")
    assert spec["workflow_json"]["104"]["class_type"] == "MiniMaxH3ReferenceToVideo"
    assert spec["workflow_json"]["104"]["inputs"]["audio_vae"] == ["24", 0]
    assert spec["workflow_json"]["104"]["inputs"]["ref_image_1"] == ["110", 0]
    assert spec["workflow_json"]["104"]["inputs"]["ref_image_9"] == ["118", 0]
    assert spec["workflow_json"]["110"]["class_type"] == "LoadImage"
    assert spec["workflow_json"]["118"]["class_type"] == "LoadImage"
    images_b = spec["bindings"]["images"]
    assert images_b[0] == {"node": "110", "field": "inputs.image"}
    assert images_b[8] == {"node": "118", "field": "inputs.image"}
    assert len(images_b) == 9
    assert spec["bindings"]["video"][0] == {"node": "120", "field": "inputs.file"}
    assert spec["bindings"]["audio"][0] == {"node": "130", "field": "inputs.audio"}
    images_p = next(p for p in spec["params_schema"] if p["key"] == "images")
    assert images_p.get("max") == 9
    assert next(p for p in spec["params_schema"] if p["key"] == "video").get("max") == 3
    assert next(p for p in spec["params_schema"] if p["key"] == "audio").get("max") == 3
    assert "minimax_h3_ref2va_pruned_int8_convrot.safetensors" in spec["workflow_json"]["6"]["inputs"]["unet_name"]
    nsfw = next(s for s in _build_specs() if s["id"] == "h3-nsfw-r2v")
    assert nsfw["is_nsfw"] is True
    assert "10Eros_Max_h3_TURBO_ref2va" in nsfw["workflow_json"]["6"]["inputs"]["unet_name"]


def test_h3_r2v_three_images_fan_out_and_omits_unused():
    """3 张参考图写入 110/111/112;空槽 LoadImage/视频/音频从提交图省略。"""
    spec = next(s for s in _build_specs() if s["id"] == "h3-r2v")
    values = _validate_params(
        spec["params_schema"],
        {"positive": "x", "images": ["a.png", "b.png", "c.png"]},
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["110"]["inputs"]["image"] == "a.png"
    assert graph["111"]["inputs"]["image"] == "b.png"
    assert graph["112"]["inputs"]["image"] == "c.png"
    assert "113" not in graph
    assert "118" not in graph
    assert "120" not in graph
    assert "121" not in graph
    assert "130" not in graph
    assert graph["104"]["inputs"]["ref_image_1"] == ["110", 0]
    assert graph["104"]["inputs"]["ref_image_3"] == ["112", 0]
    assert "ref_image_4" not in graph["104"]["inputs"]
    assert "ref_video_1" not in graph["104"]["inputs"]
    assert "ref_audio_1" not in graph["104"]["inputs"]


def test_h3_r2v_video_audio_fan_out():
    """可选视频/音频按序写入 120/122 与 130;未占用槽省略。"""
    spec = next(s for s in _build_specs() if s["id"] == "h3-r2v")
    values = _validate_params(
        spec["params_schema"],
        {
            "positive": "x",
            "images": ["a.png"],
            "video": ["v1.mp4", "v2.mp4"],
            "audio": ["s1.wav"],
        },
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["110"]["inputs"]["image"] == "a.png"
    assert "111" not in graph
    assert graph["120"]["inputs"]["file"] == "v1.mp4"
    assert graph["122"]["inputs"]["file"] == "v2.mp4"
    assert "124" not in graph
    assert graph["130"]["inputs"]["audio"] == "s1.wav"
    assert "131" not in graph
    assert graph["104"]["inputs"]["ref_video_1"] == ["121", 0]
    assert graph["104"]["inputs"]["ref_video_2"] == ["123", 0]
    assert "ref_video_3" not in graph["104"]["inputs"]
    assert graph["104"]["inputs"]["ref_audio_1"] == ["130", 0]


def test_h3_r2v_images_over_max_422():
    from fastapi import HTTPException

    spec = next(s for s in _build_specs() if s["id"] == "h3-r2v")
    try:
        _validate_params(
            spec["params_schema"],
            {"positive": "x", "images": [f"{i}.png" for i in range(10)]},
        )
        raise AssertionError("10 张应 422")
    except HTTPException as e:
        assert e.status_code == 422
        assert "images" in str(e.detail)


def test_img2img_basic_single_image_still_writes_one_leaf():
    """单图应用仍只写一个 LoadImage 叶子,不扇出。"""
    spec = next(s for s in _build_specs() if s["id"] == "img2img-basic")
    values = _validate_params(
        spec["params_schema"], {"positive": "x", "images": ["only.png"]},
    )
    graph = _build_graph(spec["workflow_json"], spec["bindings"], values)
    assert graph["7"]["class_type"] == "LoadImage"
    assert graph["7"]["inputs"]["image"] == "only.png"


def test_builtin_h3_r2v_run_fans_out_three_images(ctx):
    """HTTP: h3-r2v 三张图写入 110/111/112,空槽省略。"""
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-r2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "<Picture 1>", "images": ["a.png", "b.png", "c.png"]}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["110"]["inputs"]["image"] == "a.png"
    assert graph["111"]["inputs"]["image"] == "b.png"
    assert graph["112"]["inputs"]["image"] == "c.png"
    assert "113" not in graph


def test_builtin_h3_fl2v_run_writes_both_frames(ctx):
    """HTTP: h3-fl2v 首帧+尾帧分别写入 LoadImage 100/101。"""
    c, token, fake = ctx
    r = c.post(
        "/api/apps/h3-fl2v/run",
        headers={"Authorization": f"Bearer {token}"},
        json={
            "values": {
                "positive": "从站到坐",
                "images": ["first.png"],
                "last_frame": ["last.png"],
            }
        },
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["100"]["inputs"]["image"] == "first.png"
    assert graph["101"]["inputs"]["image"] == "last.png"


def test_builtin_img2img_run_single_image(ctx):
    """HTTP: img2img-basic 单图不扇出、不 422。"""
    c, token, fake = ctx
    r = c.post(
        "/api/apps/img2img-basic/run",
        headers={"Authorization": f"Bearer {token}"},
        json={"values": {"positive": "改成水彩", "images": ["only.png"]}},
    )
    assert r.status_code == 200, r.text
    graph = fake.graphs[0]
    assert graph["7"]["inputs"]["image"] == "only.png"

def test_h3_capability_preset_defaults():
    """能力族预设:锁默认值/文案,复用核心图;不伪造 20s。"""
    specs = {s["id"]: s for s in _build_specs()}
    assert "h3-i2v-20s" not in specs

    t2v = specs["h3-t2v-15s-fast"]
    i2v = specs["h3-i2v-15s-fast"]
    voice = specs["h3-r2v-voice"]
    assert t2v["workflow_json"] == specs["h3-t2v"]["workflow_json"]
    assert i2v["workflow_json"] == specs["h3-i2v"]["workflow_json"]
    # r2v builder 每次随机 noise_seed,只比拓扑 + UNET
    assert set(voice["workflow_json"]) == set(specs["h3-r2v"]["workflow_json"])
    assert voice["workflow_json"]["104"]["class_type"] == specs["h3-r2v"]["workflow_json"]["104"]["class_type"]
    assert voice["workflow_json"]["6"]["inputs"]["unet_name"] == specs["h3-r2v"]["workflow_json"]["6"]["inputs"]["unet_name"]
    assert next(p for p in t2v["params_schema"] if p["key"] == "length")["default"] == 362
    assert next(p for p in t2v["params_schema"] if p["key"] == "steps")["default"] == 8
    assert next(p for p in i2v["params_schema"] if p["key"] == "length")["default"] == 362
    assert next(p for p in i2v["params_schema"] if p["key"] == "images").get("required") is True
    audio = next(p for p in voice["params_schema"] if p["key"] == "audio")
    assert audio.get("required") is True and audio.get("max") == 3
    assert "全能参考" in specs["h3-r2v"]["description"]
    assert "9 图" in specs["h3-r2v"]["description"]
    assert "1-based" in specs["h3-r2v"]["description"]
    assert "首尾帧转场" in specs["h3-fl2v"]["name"]
    assert "不能纯音频" in voice["description"]

    nsfw_fast = specs["h3-nsfw-t2v-15s-fast"]
    assert nsfw_fast["is_nsfw"] is True
    sfw_unet = specs["h3-t2v"]["workflow_json"]["6"]["inputs"]["unet_name"]
    nsfw_unet = nsfw_fast["workflow_json"]["6"]["inputs"]["unet_name"]
    assert nsfw_unet != sfw_unet
    assert "10Eros" in nsfw_unet
    voice_nsfw = specs["h3-nsfw-r2v-voice"]
    assert "10Eros_Max_h3_TURBO_ref2va" in voice_nsfw["workflow_json"]["6"]["inputs"]["unet_name"]

