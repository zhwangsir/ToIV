"""H3 多镜头单次生成 —— 协议组装 / 校验 / 时长分配 / 端点 / R18 打标 测试。

覆盖:
  · 协议组装:2/3/4 镜头中文编号(镜头一/二/三/四)、运镜提示拼接、
    转场连接词(指定/默认硬切)、片头行(总时长/画幅/镜头数)
  · 校验:1 镜头 / 5 镜头 / 总时长 >15s / 单镜头 <2s / 运镜与转场白名单 /
    时长混合(部分给部分不给)/ 均分缺 total_duration / 空提示词
  · 时长分配:均分(3 镜头 12s → 各 4s)/ 自定义
  · POST /api/h3/multishot:成功提交(Job kind=h3_multishot、协议 prompt 进图、
    params 快照存多镜头计划);1 镜头 422;总时长越界 422;镜头时长越界 422
  · R18:X-NSFW 头 → Job 打 nsfw 标 + UNET 换 10Eros-Max
"""
from __future__ import annotations

import json

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.h3 as h3_service
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.services import multishot_protocol as ms
from app.services.multishot_protocol import (
    MultiShotError,
    ShotSpec,
    build_multishot_prompt,
    plan_multishot,
    validate_multishot,
)


@pytest.fixture(autouse=True)
def _fast_vram_settle(monkeypatch):
    """显存驱逐后的落定等待压到 0(生产 5s),与 test_h3_studio 同一手法。"""
    monkeypatch.setattr(h3_service, "_VRAM_SETTLE_SEC", 0.0)


# --------------------------------------------------------------------------- #
# 协议组装
# --------------------------------------------------------------------------- #


def test_prompt_two_shots_basic():
    """2 镜头:中文编号 + 片头行(总时长/16:9/镜头数)+ 默认硬切连接。"""
    prompt = build_multishot_prompt(
        [
            ShotSpec(prompt="深夜便利店,中年女人整理货架", duration_sec=5),
            ShotSpec(prompt="女人抬头看向门口,风铃轻响", duration_sec=5),
        ]
    )
    assert prompt.startswith("生成一段10秒、16:9、原生立体声视频")
    assert "全片共两个镜头" in prompt
    assert "镜头一(约5秒):深夜便利店,中年女人整理货架。" in prompt
    assert "镜头切换:硬切。" in prompt  # 未指定转场默认硬切
    assert "镜头二(约5秒):女人抬头看向门口,风铃轻响。" in prompt


def test_prompt_three_shots_with_hints():
    """3 镜头:运镜提示拼镜头描述末尾;指定转场词进入连接行。"""
    prompt = build_multishot_prompt(
        [
            ShotSpec(prompt="巷口雨夜,刀客按刀而立", duration_sec=4, camera_hint="固定"),
            ShotSpec(prompt="刀客拔刀冲向镜头", duration_sec=4, camera_hint="跟", transition_hint="匹配切口"),
            ShotSpec(prompt="对手倒地,雨水冲淡血迹", duration_sec=4, camera_hint="推", transition_hint="淡入淡出"),
        ]
    )
    assert "全片共三个镜头" in prompt
    assert "镜头一(约4秒):巷口雨夜,刀客按刀而立,固定机位。" in prompt
    assert "镜头切换:匹配切口。\n镜头二" in prompt
    assert "镜头二(约4秒):刀客拔刀冲向镜头,镜头跟随主体移动。" in prompt
    assert "镜头切换:淡入淡出。\n镜头三" in prompt
    assert "镜头三(约4秒):对手倒地,雨水冲淡血迹,镜头缓慢推近。" in prompt


def test_prompt_four_shots_vertical_aspect():
    """4 镜头:编号到「镜头四」;竖屏(宽<高)片头画幅 9:16。"""
    prompt = build_multishot_prompt(
        [ShotSpec(prompt=f"镜头内容{i}", duration_sec=3) for i in range(4)],
        width=768, height=1344,
    )
    assert "9:16" in prompt
    assert "全片共四个镜头" in prompt
    assert "镜头四(约3秒):镜头内容3。" in prompt
    # 3 个连接行(4 镜头 3 次切换)
    assert prompt.count("镜头切换:") == 3


def test_prompt_strips_trailing_period_and_spaces():
    """镜头描述首尾空白/句末句号归一(不叠双句号)。"""
    prompt = build_multishot_prompt(
        [
            ShotSpec(prompt="  一只猫走过屋檐。  ", duration_sec=3),
            ShotSpec(prompt="猫跃上树梢", duration_sec=3),
        ]
    )
    assert "镜头一(约3秒):一只猫走过屋檐。" in prompt
    assert "。。" not in prompt


# --------------------------------------------------------------------------- #
# 校验(纯函数层,MultiShotError)
# --------------------------------------------------------------------------- #


def test_validate_rejects_single_shot():
    with pytest.raises(MultiShotError, match="2-4 个"):
        validate_multishot([ShotSpec(prompt="x", duration_sec=5)])


def test_validate_rejects_five_shots():
    with pytest.raises(MultiShotError, match="2-4 个"):
        validate_multishot([ShotSpec(prompt=f"x{i}", duration_sec=3) for i in range(5)])


def test_validate_rejects_total_over_15s():
    with pytest.raises(MultiShotError, match="最长 15 秒"):
        validate_multishot(
            [ShotSpec(prompt="a", duration_sec=8), ShotSpec(prompt="b", duration_sec=8)]
        )


def test_validate_rejects_shot_under_2s():
    with pytest.raises(MultiShotError, match="≥2 秒"):
        validate_multishot(
            [ShotSpec(prompt="a", duration_sec=1.5), ShotSpec(prompt="b", duration_sec=5)]
        )


def test_validate_rejects_unknown_camera_hint():
    with pytest.raises(MultiShotError, match="运镜提示"):
        validate_multishot(
            [
                ShotSpec(prompt="a", duration_sec=3, camera_hint="无人机环绕"),
                ShotSpec(prompt="b", duration_sec=3),
            ]
        )


def test_validate_rejects_unknown_transition_hint():
    with pytest.raises(MultiShotError, match="转场提示"):
        validate_multishot(
            [
                ShotSpec(prompt="a", duration_sec=3),
                ShotSpec(prompt="b", duration_sec=3, transition_hint="叠化"),
            ]
        )


def test_validate_rejects_empty_prompt():
    with pytest.raises(MultiShotError, match="不能为空"):
        validate_multishot(
            [ShotSpec(prompt="  ", duration_sec=3), ShotSpec(prompt="b", duration_sec=3)]
        )


def test_validate_rejects_mixed_durations():
    """部分镜头给时长、部分留空:语义歧义,报错。"""
    with pytest.raises(MultiShotError, match="不能混合"):
        validate_multishot(
            [ShotSpec(prompt="a", duration_sec=5), ShotSpec(prompt="b")],
            total_duration=10,
        )


def test_validate_rejects_equal_split_without_total():
    """均分模式缺 total_duration。"""
    with pytest.raises(MultiShotError, match="total_duration"):
        validate_multishot([ShotSpec(prompt="a"), ShotSpec(prompt="b")])


def test_validate_rejects_equal_split_too_short():
    """均分后单镜头 <2s(3 镜头共 5s → 各 1.67s)。"""
    with pytest.raises(MultiShotError, match="≥2 秒"):
        validate_multishot(
            [ShotSpec(prompt="a"), ShotSpec(prompt="b"), ShotSpec(prompt="c")],
            total_duration=5,
        )


# --------------------------------------------------------------------------- #
# 时长分配(均分 / 自定义)
# --------------------------------------------------------------------------- #


def test_plan_equal_split_durations():
    """均分:3 镜头 total 12s → 各 4s;plan.total_duration=12。"""
    plan = plan_multishot(
        [ShotSpec(prompt="a"), ShotSpec(prompt="b"), ShotSpec(prompt="c")],
        total_duration=12,
    )
    assert [s.duration_sec for s in plan.shots] == [4.0, 4.0, 4.0]
    assert plan.total_duration == 12.0
    assert "镜头一(约4秒)" in plan.to_prompt()


def test_plan_custom_durations():
    """自定义:各镜头时长直给,总长为和;fps/宽高/seed 进快照。"""
    plan = plan_multishot(
        [ShotSpec(prompt="a", duration_sec=3.5), ShotSpec(prompt="b", duration_sec=6)],
        width=1344, height=768, seed=42,
    )
    assert plan.total_duration == 9.5
    params = plan.to_params()
    assert params["total_duration"] == 9.5
    assert params["fps"] == 24
    assert params["seed"] == 42
    assert [s["duration_sec"] for s in params["shots"]] == [3.5, 6]


# --------------------------------------------------------------------------- #
# 端点 fixtures(与 test_h3_studio 同一套替身)
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
    """H3 实例替身(精简版):object_info/queue_prompt/queue/system_stats 可控,不联网。"""

    def __init__(self, *, reachable: bool = True) -> None:
        self.base_url = "http://fake-h3"
        self._reachable = reachable
        self.graphs: list[dict] = []

    async def object_info(self, node: str) -> dict:
        if not self._reachable:
            raise ComfyUIError("connection refused")
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return "prompt-ms-1"

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
                    "vram_free": 96 * (1 << 30),
                    "vram_total": 96 * (1 << 30),
                }
            ]
        }


def _install_h3(monkeypatch, fake: _FakeH3Client) -> None:
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)


_TWO_SHOTS = {
    "shots": [
        {"prompt": "深夜便利店,中年女人整理货架", "duration_sec": 5, "camera_hint": "固定"},
        {"prompt": "女人抬头看向门口", "duration_sec": 5, "transition_hint": "淡入淡出"},
    ],
    "seed": 42,
}


# --------------------------------------------------------------------------- #
# POST /api/h3/multishot
# --------------------------------------------------------------------------- #


def test_multishot_ok_submits_protocol_prompt_and_job(client, monkeypatch):
    """成功提交:协议 prompt 进图(节点 104),Job kind=h3_multishot,params 存多镜头计划。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-ok")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_TWO_SHOTS,
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["prompt_id"] == "prompt-ms-1"
    assert body["seed"] == 42
    assert body["multishot"]["total_duration"] == 10.0

    graph = fake.graphs[0]
    composed = graph["104"]["inputs"]["prompt"]
    assert "镜头一(约5秒):深夜便利店,中年女人整理货架,固定机位。" in composed
    assert "镜头切换:淡入淡出。" in composed
    assert "镜头二(约5秒):女人抬头看向门口。" in composed
    assert graph["104"]["inputs"]["length"] == 243  # 10s@24fps=240 → 17k+5 吸附 243
    assert graph["15"]["inputs"]["noise_seed"] == 42

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None
        assert job.kind == "h3_multishot"
        assert job.nsfw is False
        assert "镜头一" in job.prompt
        snap = json.loads(job.params)
        assert len(snap["shots"]) == 2
        assert snap["shots"][0]["camera_hint"] == "固定"
        assert snap["shots"][1]["transition_hint"] == "淡入淡出"


def test_multishot_equal_split_via_total_duration(client, monkeypatch):
    """均分模式:镜头时长全留空 + total_duration=9(3 镜头各 3s)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-split")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "shots": [{"prompt": "甲"}, {"prompt": "乙"}, {"prompt": "丙"}],
            "total_duration": 9,
        },
    )
    assert r.status_code == 200, r.text
    composed = fake.graphs[0]["104"]["inputs"]["prompt"]
    assert "镜头一(约3秒):甲。" in composed
    assert "镜头二(约3秒):乙。" in composed
    assert "镜头三(约3秒):丙。" in composed
    assert r.json()["multishot"]["total_duration"] == 9.0


def test_multishot_rejects_single_shot_422(client):
    """1 镜头:pydantic min_length 拦截 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-one")
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"shots": [{"prompt": "x", "duration_sec": 5}]},
    )
    assert r.status_code == 422


def test_multishot_rejects_five_shots_422(client):
    """5 镜头:pydantic max_length 拦截 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-five")
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"shots": [{"prompt": f"x{i}", "duration_sec": 2} for i in range(5)]},
    )
    assert r.status_code == 422


def test_multishot_rejects_total_over_15s_422(client, monkeypatch):
    """总时长越界(8+8=16s):服务层 422,不触碰 H3 实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-over")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"shots": [{"prompt": "a", "duration_sec": 8}, {"prompt": "b", "duration_sec": 8}]},
    )
    assert r.status_code == 422
    assert "15" in r.json()["detail"]
    assert fake.graphs == []


def test_multishot_rejects_shot_under_2s_422(client, monkeypatch):
    """单镜头 <2s:服务层 422(pydantic 只拦 ≤0)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-short")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"shots": [{"prompt": "a", "duration_sec": 1}, {"prompt": "b", "duration_sec": 5}]},
    )
    assert r.status_code == 422
    assert "≥2 秒" in r.json()["detail"]
    assert fake.graphs == []


def test_multishot_rejects_bad_hint_422(client):
    """运镜提示白名单外:服务层 422。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-hint")
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            "shots": [
                {"prompt": "a", "duration_sec": 3, "camera_hint": "环绕"},
                {"prompt": "b", "duration_sec": 3},
            ]
        },
    )
    assert r.status_code == 422
    assert "运镜提示" in r.json()["detail"]


def test_multishot_requires_auth(client):
    c, _ = client
    assert c.post("/api/h3/multishot", json=_TWO_SHOTS).status_code == 401


def test_multishot_instance_unreachable_503(client, monkeypatch):
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-down")
    _install_h3(monkeypatch, _FakeH3Client(reachable=False))
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_TWO_SHOTS,
    )
    assert r.status_code == 503
    assert "不可达" in r.json()["detail"]


# --------------------------------------------------------------------------- #
# R18 打标(与 t2v 同一判定来源)
# --------------------------------------------------------------------------- #


def test_multishot_marks_job_nsfw_and_swaps_unet(client, monkeypatch):
    """/nsfw 专区(X-NSFW: 1):Job 打 nsfw 标,UNET 换 10Eros-Max(TOIV_H3_NSFW_UNET 默认)。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-nsfw")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}", "X-NSFW": "1"},
        json={
            "shots": [
                {"prompt": "卧室暖光,女人侧卧看书", "duration_sec": 5},
                {"prompt": "她放下书看向镜头微笑", "duration_sec": 5},
            ]
        },
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["unet_name"] == (
        "10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors"
    )
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.user_id == uid)).first()
        assert job is not None and job.kind == "h3_multishot" and job.nsfw is True


def test_multishot_nsfw_lora_rejected_without_header(client, monkeypatch):
    """NSFW LoRA 主站直传:403(与 t2v 门控同源),不触碰 H3 实例。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-nsfw-lora")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={
            **_TWO_SHOTS,
            "loras": [{"name": "h3_musubi_v4-000040.safetensors"}],
        },
    )
    assert r.status_code == 403
    assert fake.graphs == []


def test_multishot_sfw_keeps_template_unet(client, monkeypatch):
    """主站(无 X-NSFW 头):UNET 保持模板 minimax 底模。"""
    c, engine = client
    with Session(engine) as s:
        uid = _seed_user(s, "ms-sfw-unet")
    fake = _FakeH3Client()
    _install_h3(monkeypatch, fake)
    r = c.post(
        "/api/h3/multishot",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_TWO_SHOTS,
    )
    assert r.status_code == 200, r.text
    assert fake.graphs[0]["6"]["inputs"]["unet_name"] == (
        "minimax_h3_fl2va_pruned_int8_convrot.safetensors"
    )


# --------------------------------------------------------------------------- #
# 引擎注册表集成
# --------------------------------------------------------------------------- #


def test_engine_registry_has_multishot_entry():
    """注册表含 h3-multishot(SFW、video、submit 路由绑定、复用 H3 探测、无 duration 参数)。"""
    from app.services import engine_registry as er

    er.populate_registry()
    entry = next(e for e in er._REGISTRY if e["id"] == "h3-multishot")
    assert entry["kind"] == "video" and entry["nsfw"] is False
    assert entry["submit"] == {"route": "/api/h3/multishot", "kind": "h3-multishot"}
    keys = [p["key"] for p in entry["params"]]
    assert "duration" not in keys  # 时长由逐镜头决定
    assert "width" in keys and "steps" in keys and "seed" in keys
    er._reset_registry_for_tests()
