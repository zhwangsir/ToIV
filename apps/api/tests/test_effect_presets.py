"""特效预设体系(Pikaffects 式一键物理特效,2026-08-26 P0)测试。

覆盖:
  · 预设清单:≥15 个、key 唯一且 kebab-case、必填字段非空、positive_prompt 为英文
    自然语言(H3 风格,无 CJK)、适配引擎含 h3、描述注明 R18(10Eros-Max)兼容、
    推荐参数(cfg/steps)范围合法
  · 参数校验:validate_effect_key 空值→None、合法→key、未知→ValueError(→422)
  · 注入逻辑:apply_effect_preset 拼前部/负向合并/未知或空 key 防御式 no-op
  · 注册表集成:h3-t2v/h3-i2v/h3-nsfw-*/wan-nsfw-i2v 含 effect_preset 下拉(带 desc),
    txt2img 等图像引擎不含;SFW 上下文特效选项无 nsfw 标
  · 端点链路:POST /api/h3/t2v 注入后构图 prompt 以预设开头且含用户原文、Job.prompt
    同源、未知 key 422;POST /api/generate/video 同样注入 + 负向合并 + 未知 422
"""
from __future__ import annotations

import re

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.h3_studio as h3_route
import app.routes.video as video_route
import app.services.h3 as h3_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.nsfw_ctx import nsfw_intent_var
from app.security import create_token, hash_password
from app.services.effect_presets import (
    EffectPreset,
    apply_effect_preset,
    get_effect_preset,
    list_effect_presets,
    validate_effect_key,
)
from app.services import engine_registry
from app.services.engine_registry import list_engines

# --------------------------------------------------------------------------- #
# 预设清单(纯数据)
# --------------------------------------------------------------------------- #

_REQUIRED_KEYS = {
    "melt", "explode", "crush", "inflate", "squish", "levitate", "dissolve",
    "deflate", "eye-pop", "shatter", "freeze", "burn", "vanish", "transform",
    "camera-shake",
}
_CJK = re.compile(r"[一-鿿]")


def test_registry_has_15_plus_presets_with_required_keys():
    presets = list_effect_presets()
    assert len(presets) >= 15
    keys = {p.key for p in presets}
    assert len(keys) == len(presets), "key 不允许重复"
    assert _REQUIRED_KEYS <= keys, f"缺任务书要求的特效: {_REQUIRED_KEYS - keys}"


def test_preset_fields_complete_and_h3_style():
    for p in list_effect_presets():
        assert re.fullmatch(r"[a-z0-9]+(-[a-z0-9]+)*", p.key), f"{p.key} 非 kebab-case"
        assert p.label_zh.strip(), f"{p.key} 缺中文名"
        assert p.description.strip(), f"{p.key} 缺描述"
        # R18 兼容注明(10Eros-Max)
        assert "10Eros-Max" in p.description, f"{p.key} 描述未注明 R18 兼容"
        # positive_prompt:英文自然语言(H3 风格),不含 CJK,含物理/电影感线索
        assert len(p.positive_prompt) >= 80, f"{p.key} 特效描述过短"
        assert not _CJK.search(p.positive_prompt), f"{p.key} positive_prompt 必须英文"
        assert "h3" in p.engines, f"{p.key} 必须适配 H3(主力引擎)"
        assert set(p.engines) <= {"h3", "wan"}, f"{p.key} 引擎族越界"
        if p.cfg is not None:
            assert 0 < p.cfg <= 20, f"{p.key} cfg 越界"
        if p.steps is not None:
            assert 1 <= p.steps <= 50, f"{p.key} steps 越界"
        # negative 若有,同样不含 CJK(引擎 negative 通道)
        assert not _CJK.search(p.negative_prompt), f"{p.key} negative_prompt 必须英文"


def test_get_effect_preset_lookup():
    assert get_effect_preset("melt").label_zh == "融化"  # type: ignore[union-attr]
    assert get_effect_preset(None) is None
    assert get_effect_preset("") is None
    assert get_effect_preset("no-such-effect") is None
    assert get_effect_preset(" melt ") is not None  # 空白容错


# --------------------------------------------------------------------------- #
# 参数校验 / 注入逻辑
# --------------------------------------------------------------------------- #


def test_validate_effect_key():
    assert validate_effect_key(None) is None
    assert validate_effect_key("") is None
    assert validate_effect_key("   ") is None
    assert validate_effect_key("shatter") == "shatter"
    with pytest.raises(ValueError, match="未知特效预设"):
        validate_effect_key("explode2")


def test_apply_effect_preset_prepends_and_merges_negative():
    preset = get_effect_preset("explode")
    assert preset is not None and preset.negative_prompt
    pos, neg = apply_effect_preset("a ceramic vase on a table", "blurry", "explode")
    assert pos.startswith(preset.positive_prompt)
    assert "a ceramic vase on a table" in pos
    assert pos.index(preset.positive_prompt) < pos.index("a ceramic vase")
    assert neg == f"blurry, {preset.negative_prompt}"


def test_apply_effect_preset_empty_user_fields():
    preset = get_effect_preset("melt")
    assert preset is not None and not preset.negative_prompt
    pos, neg = apply_effect_preset("", "", "melt")
    assert pos == preset.positive_prompt
    assert neg == ""
    # 有负向的预设 + 空用户负向 → 直接用预设负向
    pos2, neg2 = apply_effect_preset("", "", "vanish")
    assert neg2 == get_effect_preset("vanish").negative_prompt  # type: ignore[union-attr]


def test_apply_effect_preset_noop_on_none_or_unknown():
    assert apply_effect_preset("a cat", "bad", None) == ("a cat", "bad")
    assert apply_effect_preset("a cat", "bad", "") == ("a cat", "bad")
    assert apply_effect_preset("a cat", "bad", "nope") == ("a cat", "bad")


# --------------------------------------------------------------------------- #
# 注册表集成(list_engines)
# --------------------------------------------------------------------------- #


class _FakeClient:
    """worker 替身:queue_len/model_names/node_names/object_info 可控,不联网。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"

    async def queue_len(self) -> int:
        return 0

    async def model_names(self) -> set[str]:
        return set()

    async def node_names(self) -> set[str]:
        return set()

    async def object_info(self, node: str) -> dict:
        return {}


@pytest.fixture
def user() -> User:
    return User(id="u-1", email="tester", hashed_password="x", tenant_id="t-1")


@pytest.fixture
def pool():
    from app.comfy.pool import WorkerPool

    return WorkerPool([_FakeClient()])


@pytest.fixture(autouse=True)
def _h3_stub(monkeypatch):
    """H3 实例探测替身:默认在线(不向局域网真实实例发 HTTP)。"""

    async def _fake() -> set[str]:
        return {"MiniMaxH3ImageToVideo"}

    monkeypatch.setattr(engine_registry, "_fetch_h3_nodes", _fake)


@pytest.fixture(autouse=True)
def _h3_lora_stub(monkeypatch):
    async def _fake() -> list[str] | None:
        return []

    monkeypatch.setattr(engine_registry, "_fetch_h3_loras", _fake)


def _param(engine: dict, key: str) -> dict | None:
    return next((p for p in engine["params"] if p["key"] == key), None)


@pytest.mark.parametrize("eid", ["h3-t2v", "h3-i2v"])
async def test_effect_select_on_h3_sfw_engines(pool, user, eid):
    engines = await list_engines(pool, user)
    eng = next(e for e in engines if e["id"] == eid)
    p = _param(eng, "effect_preset")
    assert p is not None, f"{eid} 缺特效预设字段"
    assert p["type"] == "select" and p["default"] == ""
    # 「不使用」空项 + ≥15 个预设项
    assert p["options"][0] == {"value": "", "label": "不使用"}
    assert len(p["options"]) >= 16
    # 每项带中文 label + desc 描述(前端选中即展示);SFW 上下文无 nsfw 标
    for o in p["options"][1:]:
        assert o["label"].strip() and o.get("desc"), f"{eid} 选项缺描述: {o}"
        assert not o.get("nsfw"), f"{eid} 特效选项不应打 R18 标: {o}"


async def test_effect_select_absent_on_image_engines(pool, user):
    engines = await list_engines(pool, user)
    for eid in ("txt2img", "img2img"):
        eng = next(e for e in engines if e["id"] == eid)
        assert _param(eng, "effect_preset") is None, f"{eid} 不应有特效预设字段"


async def test_effect_select_on_nsfw_engines(pool, user):
    token = nsfw_intent_var.set(True)
    try:
        engines = await list_engines(pool, user)
    finally:
        nsfw_intent_var.reset(token)
    for eid in ("h3-nsfw-t2v", "h3-nsfw-i2v", "wan-nsfw-i2v"):
        eng = next(e for e in engines if e["id"] == eid)
        p = _param(eng, "effect_preset")
        assert p is not None, f"{eid} 缺特效预设字段"
        assert len(p["options"]) >= 16


# --------------------------------------------------------------------------- #
# 端点链路(注入进图 + 落库 + 422)
# --------------------------------------------------------------------------- #


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine):
    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeH3Client:
    """H3 实例替身:object_info/queue_prompt/system_stats 可控,不联网。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-h3"
        self.graphs: list[dict] = []

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-h3-fx"

    async def queue_len(self) -> int:
        return 0

    async def queue_counts(self) -> tuple[int, int]:
        return 0, 0

    async def get_system_stats(self) -> dict:
        return {
            "devices": [
                {
                    "name": "cuda:0 FakeGPU",
                    "type": "cuda",
                    "vram_free": int(96 * (1 << 30)),
                    "vram_total": 96 * (1 << 30),
                }
            ]
        }


class _FakeWanClient:
    """Wan pool worker 替身:queue_prompt 记录图。"""

    def __init__(self) -> None:
        self.base_url = "http://fake-worker"
        self.graphs: list[dict] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-wan-fx"


@pytest.fixture(autouse=True)
def _fast_vram_settle(monkeypatch):
    """显存驱逐后的落定等待压到 0(与 test_h3_studio 同一手法)。"""
    monkeypatch.setattr(h3_service, "_VRAM_SETTLE_SEC", 0.0)


def _install_h3(monkeypatch, fake: _FakeH3Client) -> None:
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)


def test_h3_t2v_injects_effect_prompt(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "fx-h3-inject")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a ceramic vase on a wooden table",
            "length": 141,
            "seed": 42,
            "effect_preset": "melt",
        },
    )
    assert r.status_code == 200, r.text
    preset = get_effect_preset("melt")
    prompt_in_graph = fake.graphs[0]["104"]["inputs"]["prompt"]
    assert prompt_in_graph.startswith(preset.positive_prompt)  # type: ignore[union-attr]
    assert "a ceramic vase on a wooden table" in prompt_in_graph
    # Job.prompt 与构图同源(注入后全文);快照保留 effect_preset 键(可复现)
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.prompt == prompt_in_graph
        assert '"effect_preset": "melt"' in job.params


def test_h3_t2v_without_preset_keeps_prompt(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "fx-h3-plain")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "一只猫跳过围墙", "length": 141},
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["104"]["inputs"]["prompt"] == "一只猫跳过围墙"


def test_h3_t2v_unknown_effect_422(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "fx-h3-422")
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "length": 141, "effect_preset": "melt2"},
    )
    assert r.status_code == 422


def test_wan_i2v_injects_effect_and_merges_negative(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "fx-wan-inject")
    fake = _FakeWanClient()
    monkeypatch.setattr(video_route, "resolve_worker", lambda worker: fake)
    monkeypatch.setattr(video_route, "spawn_tracker", lambda client, prompt_id: None)
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "海浪拍打礁石",
            "negative": "模糊",
            "image": "in.png",
            "worker": "http://fake-worker",
            "seed": 7,
            "effect_preset": "shatter",
        },
    )
    assert r.status_code == 200, r.text
    preset = get_effect_preset("shatter")
    graph = fake.graphs[0]
    # Wan 图:节点 7 = positive CLIPTextEncode,节点 8 = negative(见 workflows/wan_i2v)
    pos_text = graph["7"]["inputs"]["text"]
    assert pos_text.startswith(preset.positive_prompt)  # type: ignore[union-attr]
    assert "海浪拍打礁石" in pos_text
    neg_text = graph["8"]["inputs"]["text"]
    assert preset.negative_prompt in neg_text  # type: ignore[union-attr]
    assert "模糊" in neg_text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.prompt == pos_text


def test_wan_i2v_unknown_effect_422(client):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "fx-wan-422")
    r = c.post(
        "/api/generate/video",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "positive": "a",
            "image": "in.png",
            "worker": "http://fake-worker",
            "effect_preset": "nope",
        },
    )
    assert r.status_code == 422
