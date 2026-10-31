"""RES-2026-08-18 输出分辨率档(融合超分链)测试。

覆盖:
  · workflows:TARGET_CHOICES 四档(720p/1080p/2k/4k)+ derive 横竖推导
    + validate_resolution_target 三分支(None/空串/合法/非法)
  · 路由请求模型:H3/LongCat/Wan/LTX-NSFW 四族 resolution_target 校验一致
  · H3 路由挂链:合法档 → maybe_chain_upscale 调用 + upscale_notice 透出;
    未传档 → 不挂链;非法档 → 422
  · engine_registry:全部视频生成引擎含「输出分辨率」select(720p→4k+原生直出)
  · services:maybe_chain_upscale 等待循环(done+post_status 清零才触发 /
    生成 error 放弃 / 幂等)+ _fused_finish 原子回写 + run_pipeline fused
    失败仅清 post_status 不标 error(原片不毁)
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as db_mod
import app.services.video_upscale as svc
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.security import create_token, hash_password
from app.workflows.video_upscale import (
    TARGET_CHOICES,
    derive_target_resolution,
    validate_resolution_target,
)

# --------------------------------------------------------------------------- #
# workflows 纯函数
# --------------------------------------------------------------------------- #


def test_target_choices_contain_full_ladder():
    """720p→4K 全阶梯:Wan 原生甜点 480p,720p 也须经超分达成。"""
    assert TARGET_CHOICES == ("720p", "1080p", "2k", "4k")


@pytest.mark.parametrize(
    "target,src,expect",
    [
        ("720p", (832, 480), (1280, 720)),
        ("720p", (480, 832), (720, 1280)),
        ("1080p", (1344, 768), (1920, 1080)),
        ("1080p", (768, 1344), (1080, 1920)),
        ("2k", (1280, 720), (2560, 1440)),
        ("4k", (832, 480), (3840, 2160)),
        ("4k", (480, 832), (2160, 3840)),
    ],
)
def test_derive_target_all_tiers(target, src, expect):
    assert derive_target_resolution(src[0], src[1], target) == expect


def test_validate_resolution_target_branches():
    assert validate_resolution_target(None) is None
    assert validate_resolution_target("") is None
    assert validate_resolution_target("4k") == "4k"
    with pytest.raises(ValueError, match="resolution_target"):
        validate_resolution_target("8k")


# --------------------------------------------------------------------------- #
# 路由请求模型校验(五族同一套 validator)
# --------------------------------------------------------------------------- #

_BASE = {"positive": "x"}


@pytest.mark.parametrize(
    "model_cls,extra",
    [
        ("H3T2VRequest", {}),
        ("LongCatT2VRequest", {}),
        ("LongCatContinueRequest", {"video": "/api/images?filename=v.mp4&worker=w1"}),
        ("WanI2VRequest", {"image": "a.png", "worker": "w1"}),
        ("LtxT2VRequest", {}),
    ],
)
def test_route_models_accept_valid_target(model_cls, extra):
    from app.routes import h3_studio, longcat_studio, video

    cls = {
        "H3T2VRequest": h3_studio.H3T2VRequest,
        "LongCatT2VRequest": longcat_studio.LongCatT2VRequest,
        "LongCatContinueRequest": longcat_studio.LongCatContinueRequest,
        "WanI2VRequest": video.WanI2VRequest,
        "LtxT2VRequest": video.LtxT2VRequest,
    }[model_cls]
    req = cls(**_BASE, resolution_target="1080p", **extra)
    assert req.resolution_target == "1080p"


@pytest.mark.parametrize(
    "model_cls,extra",
    [
        ("H3T2VRequest", {}),
        ("LongCatT2VRequest", {}),
        ("LongCatContinueRequest", {"video": "/api/images?filename=v.mp4&worker=w1"}),
        ("WanI2VRequest", {"image": "a.png", "worker": "w1"}),
        ("LtxT2VRequest", {}),
    ],
)
def test_route_models_reject_invalid_target(model_cls, extra):
    from app.routes import h3_studio, longcat_studio, video

    cls = {
        "H3T2VRequest": h3_studio.H3T2VRequest,
        "LongCatT2VRequest": longcat_studio.LongCatT2VRequest,
        "LongCatContinueRequest": longcat_studio.LongCatContinueRequest,
        "WanI2VRequest": video.WanI2VRequest,
        "LtxT2VRequest": video.LtxT2VRequest,
    }[model_cls]
    with pytest.raises(ValidationError):
        cls(**_BASE, resolution_target="8k", **extra)


# --------------------------------------------------------------------------- #
# H3 路由挂链(fixture 参照 test_h3_studio)
# --------------------------------------------------------------------------- #


@pytest.fixture()
def client():
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with patch.object(db_mod, "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="res-chain")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="res-chain@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
        yield TestClient(app), engine, uid
    app.dependency_overrides.clear()


class _FakeH3Client:
    base_url = "http://fake-h3"

    async def object_info(self, node: str) -> dict:
        return {node: {}}

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        return "prompt-res-1"

    async def queue_len(self) -> int:
        return 0

    async def queue_counts(self) -> tuple[int, int]:
        return 0, 0

    async def get_system_stats(self) -> dict:
        return {"devices": [{"name": "cuda:0", "type": "cuda", "vram_free": 90 << 30, "vram_total": 96 << 30}]}


def _install_h3(monkeypatch) -> _FakeH3Client:
    from app.services import h3 as h3_service

    fake = _FakeH3Client()
    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "spawn_tracker", lambda client, prompt_id: None)
    return fake


def test_h3_t2v_chains_upscale_and_returns_notice(client, monkeypatch):
    c, engine, uid = client
    fake = _install_h3(monkeypatch)
    import app.routes.h3_studio as h3_route

    calls: list[tuple[str, str]] = []
    monkeypatch.setattr(
        h3_route, "maybe_chain_upscale",
        lambda pid, target, workers=None: calls.append((pid, target)) or True,
    )
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "resolution_target": "4k"},
    )
    assert r.status_code == 200, r.text
    assert calls == [("prompt-res-1", "4k")]
    assert "4K" in r.json()["upscale_notice"]


def test_h3_t2v_without_target_no_chain(client, monkeypatch):
    c, engine, uid = client
    _install_h3(monkeypatch)
    import app.routes.h3_studio as h3_route

    called = []
    monkeypatch.setattr(
        h3_route, "maybe_chain_upscale",
        lambda pid, target, workers=None: called.append(target) or True,
    )
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat"},
    )
    assert r.status_code == 200, r.text
    assert called == []
    assert "upscale_notice" not in r.json()


def test_h3_t2v_invalid_target_422(client, monkeypatch):
    c, engine, uid = client
    _install_h3(monkeypatch)
    r = c.post(
        "/api/h3/t2v",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json={"positive": "a cat", "resolution_target": "8k"},
    )
    assert r.status_code == 422


# --------------------------------------------------------------------------- #
# engine_registry:全部视频生成引擎带「输出分辨率」
# --------------------------------------------------------------------------- #


def test_all_video_gen_engines_have_resolution_target():
    from app.services.engine_registry import _default_registry

    expected = {
        "h3-t2v", "h3-i2v",
        "ltx-nsfw-t2v", "ltx-nsfw-i2v", "ltx-nsfw-lipsync",
        "h3-nsfw-t2v", "h3-nsfw-i2v", "longcat-t2v", "longcat-i2v",
        "wan-nsfw-i2v",
    }
    by_id = {e["id"]: e for e in _default_registry()}
    assert expected <= set(by_id), f"注册表缺引擎: {expected - set(by_id)}"

    for eid in expected:
        e = by_id[eid]
        assert e["kind"] == "video", eid
        sel = next(
            (p for p in e["params"] if p.get("key") == "resolution_target"), None
        )
        assert sel is not None, f"{eid} 缺 resolution_target 参数"
        values = {o["value"] for o in sel["options"]}
        assert {"", "720p", "1080p", "2k", "4k"} <= values, eid
        assert sel["default"] == ""


# --------------------------------------------------------------------------- #
# services:maybe_chain_upscale 等待链 + fused 终态
# --------------------------------------------------------------------------- #


def _mk_gen_job(engine, uid: str, status: str, result: str | None, post: str = "") -> str:
    with Session(engine) as s:
        user = s.get(User, uid)
        pid = f"gen-{status}-{uid[:6]}"
        s.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=uid,
                prompt_id=pid,
                worker="http://w",
                kind="h3_t2v",
                status=status,
                prompt="x",
                seed=0,
                result=result,
                post_status=post,
            )
        )
        s.commit()
        return pid


async def _no_sleep(_t: float) -> None:
    return None


# 真实 sleep(测试导入时留存):fast_chain patch 掉全局 asyncio.sleep 后,
# drain 循环必须用真实 sleep(0) 让出控制权,否则后台 task 永不被调度 → 忙等死锁
_REAL_SLEEP = asyncio.sleep


@pytest.fixture()
def fast_chain(monkeypatch):
    """等待循环 sleep 即时返回;清后台任务残留。"""
    monkeypatch.setattr(svc.asyncio, "sleep", _no_sleep)
    svc._BG_TASKS.clear()
    yield
    for t in list(svc._BG_TASKS):
        t.cancel()
    svc._BG_TASKS.clear()


async def _drain_bg() -> None:
    """等 _BG_TASKS 全部收尾(真实 sleep 让步,防止忙等)。"""
    for _ in range(2000):  # 兜底防挂死
        if all(t.done() for t in svc._BG_TASKS):
            return
        await _REAL_SLEEP(0)


def test_maybe_chain_waits_then_runs_fused(client, fast_chain):
    """job done 且 post_status 清零 → 置 processing → run_pipeline(fused=True)。"""
    c, engine, uid = client
    pid = _mk_gen_job(
        engine, uid, "done", json.dumps(["/api/images?filename=a.mp4&worker=w1"])
    )
    fused_calls: list[tuple[str, str, bool]] = []

    async def _fake_run(job_id, p_id, url, target, workers=None, *, fused=False):
        fused_calls.append((p_id, target, fused))

    async def _body():
        with patch.object(svc, "run_pipeline", _fake_run):
            assert svc.maybe_chain_upscale(pid, "4k") is True
            await _drain_bg()

    asyncio.run(_body())
    assert fused_calls == [(pid, "4k", True)]
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
        assert job.post_status == "processing"  # _fake_run 未回写,标记保持


def test_maybe_chain_gives_up_on_error(client, fast_chain):
    c, engine, uid = client
    pid = _mk_gen_job(engine, uid, "error", None)

    async def _fake_run(*a, **k):
        raise AssertionError("不应执行超分")

    async def _body():
        with patch.object(svc, "run_pipeline", _fake_run):
            svc.maybe_chain_upscale(pid, "4k")
            await _drain_bg()

    asyncio.run(_body())


def test_maybe_chain_idempotent(client, fast_chain):
    c, engine, uid = client
    pid = _mk_gen_job(engine, uid, "done", json.dumps(["/api/images?filename=a.mp4&worker=w1"]))

    async def _fake_run(*a, **k):
        return None

    async def _body():
        with patch.object(svc, "run_pipeline", _fake_run):
            assert svc.maybe_chain_upscale(pid, "4k") is True
            assert svc.maybe_chain_upscale(pid, "4k") is False  # 同链在跑,跳过

    asyncio.run(_body())


def test_fused_finish_writes_result_and_clears_post(client):
    c, engine, uid = client
    pid = _mk_gen_job(engine, uid, "done", json.dumps(["old.mp4"]), post="processing")
    svc._fused_finish(pid, ["/api/video/upscale/output/upscale-x.mp4"])
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
        assert job.status == "done"
        assert job.post_status == ""
        assert json.loads(job.result) == ["/api/video/upscale/output/upscale-x.mp4"]


def test_run_pipeline_fused_failure_keeps_original(client, fast_chain, monkeypatch, tmp_path):
    """fused 超分失败:只清 post_status 回落原片,不标 error(生成是成功的)。"""
    c, engine, uid = client
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)
    original = json.dumps(["/api/images?filename=raw.mp4&worker=w1"])
    pid = _mk_gen_job(engine, uid, "done", original, post="processing")

    async def _fetch(url, dest):
        dest.write_bytes(b"fake-mp4")

    async def _boom(path):
        raise svc.VideoUpscaleError("fleet 全挂")

    async def _body():
        with patch.object(svc, "_fetch_source_local", _fetch), \
             patch.object(svc, "probe_video", _boom):
            # 模拟 maybe_chain_upscale 的调用方式(fused=True 直调,不经 spawn_upscale)
            t = asyncio.create_task(
                svc.run_pipeline("jobid-1", pid, "/api/images?filename=raw.mp4&worker=w1", "4k", fused=True),
                name="video-upscale:jobid-1",
            )
            svc._BG_TASKS.add(t)
            while not t.done():
                await _REAL_SLEEP(0)

    asyncio.run(_body())
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == pid)).first()
        assert job.status == "done"  # 不毁原片
        assert job.post_status == ""
        assert json.loads(job.result) == json.loads(original)
