"""视频超分(POST /api/video/upscale)测试。

覆盖:
  · 图构建:build_frame_upscale_graph 节点链/参数流(模型/目标宽高/前缀)
  · 目标推导四象限:横屏→3840×2160、竖屏→2160×3840、方形按横屏、非法档位报错
  · 画幅方向护栏:横竖不一致即 ValueError(易错点 28)
  · 端点:401 未认证 / 422 非法档位 / 422 非法来源前缀 / 404 无归属产物 /
    403 R18 产物无专区上下文 / 503 fleet 全挂 / 200 建档秒回(kind/worker/params)
  · 状态与产物端点:进度透出 / 他人作业 404 / 产物 200+206 Range / 非法名 400
  · Job 流程(mock fleet + mock ffmpeg):全成功 done+产物 URL+清帧目录;
    失败帧重试后仍缺失 → error+帧目录保留;断点续跑(已超分帧跳过);竖屏目标推导
  · rerun 注册表:video_upscale 可精确重生
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient
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
    FrameUpscaleParams,
    assert_orientation_compatible,
    build_frame_upscale_graph,
    derive_target_resolution,
)

_MP4 = b"\x00\x00\x00\x18ftypmp42"
_PNG = b"\x89PNG\r\n\x1a\nfake"


@pytest.fixture()
def ctx(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # 后台管线经晚绑定 `from app.db import engine` 取库 → patch 指向测试内存库
    with patch.object(db_mod, "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="vup")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="vup@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
        yield TestClient(app), create_token(uid), engine, uid, tmp_path
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mk_job(engine, uid: str, **over) -> Job:
    fields = {
        "tenant_id": "t",
        "user_id": uid,
        "prompt_id": f"video-upscale-{over.get('id_suffix', 'x')}",
        "worker": "",
        "kind": "video_upscale",
        "status": "queued",
        "prompt": "视频超分 4K",
        "seed": 0,
        "params": json.dumps({"video_url": "/api/drama/output/drama-" + "0" * 32 + ".mp4", "target": "4k"}),
    }
    fields.update(over)
    fields.pop("id_suffix", None)
    with Session(engine) as s:
        user = s.get(User, uid)
        fields["tenant_id"] = user.tenant_id
        job = Job(**fields)
        s.add(job)
        s.commit()
        s.refresh(job)
        return job.id, job.prompt_id


# ---------------------------------------------------------------------------
# 图构建 / 目标推导 / 护栏(纯函数)
# ---------------------------------------------------------------------------


def test_build_frame_upscale_graph_chain():
    g = build_frame_upscale_graph(
        FrameUpscaleParams(image="f.png", target_w=3840, target_h=2160)
    )
    assert g["10"]["class_type"] == "UpscaleModelLoader"
    assert g["10"]["inputs"]["model_name"] == "4x-UltraSharp.pth"
    assert g["11"]["class_type"] == "LoadImage"
    assert g["11"]["inputs"]["image"] == "f.png"
    assert g["12"]["class_type"] == "ImageUpscaleWithModel"
    assert g["12"]["inputs"]["upscale_model"] == ["10", 0]
    assert g["12"]["inputs"]["image"] == ["11", 0]
    assert g["13"]["class_type"] == "ImageScale"
    assert g["13"]["inputs"]["width"] == 3840
    assert g["13"]["inputs"]["height"] == 2160
    assert g["13"]["inputs"]["upscale_method"] == "lanczos"
    assert g["9"]["class_type"] == "SaveImage"
    assert g["9"]["inputs"]["images"] == ["13", 0]


def test_build_frame_upscale_graph_fresh_dict_each_call():
    p = FrameUpscaleParams(image="f.png")
    a, b = build_frame_upscale_graph(p), build_frame_upscale_graph(p)
    a["10"]["inputs"]["model_name"] = "mutated"
    assert b["10"]["inputs"]["model_name"] == "4x-UltraSharp.pth"


def test_derive_target_quadrants():
    assert derive_target_resolution(1920, 1080) == (3840, 2160)  # 横屏
    assert derive_target_resolution(1080, 1920) == (2160, 3840)  # 竖屏
    assert derive_target_resolution(576, 1024) == (2160, 3840)  # 竖屏(诛仙案例)
    assert derive_target_resolution(1000, 1000) == (3840, 2160)  # 方形按横屏
    with pytest.raises(ValueError):
        derive_target_resolution(1920, 1080, "8k")
    assert "4k" in TARGET_CHOICES


def test_orientation_guard():
    assert_orientation_compatible(1920, 1080, 3840, 2160)  # 横→横 通过
    assert_orientation_compatible(576, 1024, 2160, 3840)  # 竖→竖 通过
    with pytest.raises(ValueError, match="方向不一致"):
        assert_orientation_compatible(576, 1024, 3840, 2160)  # 竖→横 拦截
    with pytest.raises(ValueError, match="方向不一致"):
        assert_orientation_compatible(1920, 1080, 2160, 3840)  # 横→竖 拦截


# ---------------------------------------------------------------------------
# 端点校验
# ---------------------------------------------------------------------------


def test_endpoint_requires_auth(ctx):
    client, *_ = ctx
    r = client.post("/api/video/upscale", json={"video_url": "/api/drama/output/x.mp4"})
    assert r.status_code == 401


def test_endpoint_rejects_bad_target(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/upscale",
        headers=_h(token),
        json={"video_url": "/api/drama/output/x.mp4", "target": "8k"},
    )
    assert r.status_code == 422


def test_endpoint_rejects_unknown_source_prefix(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/upscale",
        headers=_h(token),
        json={"video_url": "http://evil.example.com/x.mp4"},
    )
    assert r.status_code == 422


def test_endpoint_images_url_without_sig_and_owner_404(ctx):
    """无 sig 的 /api/images 产物 URL 且无本人/同租户 Job 归属 → 404(防 IDOR 枚举)。"""
    client, token, *_ = ctx
    url = "/api/images?filename=v.mp4&subfolder=&type=output&worker=http://192.168.71.127:8189"
    r = client.post("/api/video/upscale", headers=_h(token), json={"video_url": url})
    assert r.status_code == 404


def test_endpoint_nsfw_source_requires_r18_context(ctx, monkeypatch):
    """R18 源产物:无 X-NSFW 上下文 → 403;带上下文 → 放行且新作业继承 nsfw。"""
    client, token, engine, uid, tmp_path = ctx
    with Session(engine) as s:
        user = s.get(User, uid)
        s.add(Job(
            tenant_id=user.tenant_id, user_id=uid, prompt_id="p-nsfw",
            worker="http://w", kind="ltx_i2v", status="done", seed=1, nsfw=True,
            result=json.dumps(["/api/images?filename=nsfw.mp4&worker=http://w"]),
        ))
        s.commit()
    url = "/api/images?filename=nsfw.mp4&subfolder=&type=output&worker=http://w"
    r = client.post("/api/video/upscale", headers=_h(token), json={"video_url": url})
    assert r.status_code == 403

    async def healthy(_urls=None):
        return ["http://w1"]

    monkeypatch.setattr(svc, "healthy_upscale_workers", healthy)
    monkeypatch.setattr(svc, "spawn_upscale", lambda *a, **k: _close_coro(a))
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)
    headers = {**_h(token), "X-NSFW": "1"}
    r = client.post("/api/video/upscale", headers=headers, json={"video_url": url})
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == r.json()["prompt_id"])).first()
        assert job.nsfw is True


def _close_coro(args) -> None:
    """spawn 替身:端点测试不跑后台管线,关闭协程防 RuntimeWarning。"""
    return None


def test_endpoint_fleet_all_down_503(ctx, monkeypatch):
    client, token, engine, uid, tmp_path = ctx

    async def healthy(_urls=None):
        return []

    monkeypatch.setattr(svc, "healthy_upscale_workers", healthy)
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)
    name = "upscale-" + "a" * 32 + ".mp4"
    (tmp_path / name).write_bytes(_MP4)
    url = f"/api/video/upscale/output/{name}"
    r = client.post("/api/video/upscale", headers=_h(token), json={"video_url": url})
    assert r.status_code == 503
    # 503 不建档(不空转)
    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.kind == "video_upscale")).all()
        assert jobs == []


def test_endpoint_submit_ok(ctx, monkeypatch):
    """200 建档秒回:kind=video_upscale、worker 空(不经 tracker)、params 快照、spawn 被调。"""
    client, token, engine, uid, tmp_path = ctx

    async def healthy(_urls=None):
        return ["http://w1", "http://w2", "http://w3"]

    spawned: list[tuple] = []

    def fake_spawn(*args):
        spawned.append(args)
        return None

    monkeypatch.setattr(svc, "healthy_upscale_workers", healthy)
    monkeypatch.setattr(svc, "spawn_upscale", fake_spawn)
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)
    name = "upscale-" + "b" * 32 + ".mp4"
    (tmp_path / name).write_bytes(_MP4)
    url = f"/api/video/upscale/output/{name}"

    r = client.post("/api/video/upscale", headers=_h(token), json={"video_url": url})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "video_upscale"
    assert body["status"] == "queued"
    assert body["prompt_id"].startswith("video-upscale-")
    assert len(spawned) == 1
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.prompt_id == body["prompt_id"])).first()
        assert job is not None
        assert job.worker == ""  # 不进 ComfyUI tracker(reconcile 跳过空 worker)
        assert json.loads(job.params)["video_url"] == url


def test_status_endpoint_progress_and_owner(ctx):
    client, token, engine, uid, _ = ctx
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="st1")
    svc._PROGRESS[job_id] = {"stage": "upscaling", "done": 3, "total": 10, "pct": 30, "detail": ""}
    r = client.get(f"/api/video/upscale/{job_id}", headers=_h(token))
    assert r.status_code == 200
    body = r.json()
    assert body["status"] == "queued"
    assert body["progress"]["pct"] == 30
    assert body["results"] == []
    svc._PROGRESS.pop(job_id, None)

    # 他人作业 → 404(不泄露存在性)
    with Session(engine) as s:
        other_t = Tenant(name="other")
        s.add(other_t)
        s.commit()
        s.refresh(other_t)
        other = User(
            email="other@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=other_t.id,
        )
        s.add(other)
        s.commit()
        s.refresh(other)
        other_token = create_token(other.id)
    r = client.get(f"/api/video/upscale/{job_id}", headers=_h(other_token))
    assert r.status_code == 404


def test_output_endpoint_range_and_name_guard(ctx, tmp_path, monkeypatch):
    client, token, *_ = ctx
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)
    name = "upscale-" + "c" * 32 + ".mp4"
    (tmp_path / name).write_bytes(_MP4 * 4)

    r = client.get(f"/api/video/upscale/output/{name}", headers=_h(token))
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"

    r = client.get(
        f"/api/video/upscale/output/{name}",
        headers={**_h(token), "Range": "bytes=0-7"},
    )
    assert r.status_code == 206
    assert r.headers["content-range"].startswith("bytes 0-7/")
    assert len(r.content) == 8

    r = client.get("/api/video/upscale/output/..%2F..%2Fevil.mp4", headers=_h(token))
    assert r.status_code in (400, 404, 422)
    r = client.get(f"/api/video/upscale/output/{name}")
    assert r.status_code == 401


def test_rerun_registry_includes_video_upscale():
    from app.routes.jobs import _rerun_registry

    assert "video_upscale" in _rerun_registry()


# ---------------------------------------------------------------------------
# Job 流程(mock fleet + mock ffmpeg,直连 run_pipeline)
# ---------------------------------------------------------------------------


class _Rec:
    """mock 调用记录。"""

    def __init__(self):
        self.remote_calls: list[tuple] = []
        self.encoded: list[tuple] = []


def _mock_pipeline(monkeypatch, tmp_path: Path, rec: _Rec, *,
                   src_wh=(1920, 1080), fail_frames: set[int] | None = None,
                   with_audio: bool = True) -> None:
    async def healthy(urls=None):
        return list(urls or ["http://w1", "http://w2"])

    async def fetch(url, dest):
        dest.write_bytes(_MP4)

    async def probe(path):
        if Path(path).name.startswith("upscale-"):
            tw, th = derive_target_resolution(*src_wh)
            return {"width": tw, "height": th, "fps": 24.0, "frames": 6, "has_audio": with_audio}
        return {"width": src_wh[0], "height": src_wh[1], "fps": 24.0, "frames": 6, "has_audio": with_audio}

    async def extract(video, out_dir):
        out_dir.mkdir(parents=True, exist_ok=True)
        for i in range(1, 7):
            (out_dir / f"frame_{i:06d}.png").write_bytes(_PNG)
        return 6

    async def audio(video, audio_path):
        audio_path.write_bytes(b"AAC")
        return True

    async def remote(client, frame_path, upload_name, model_name, target_w, target_h, timeout=600.0):
        rec.remote_calls.append((client.base_url, frame_path.name, target_w, target_h))
        idx = int(frame_path.stem.split("_")[1])
        if fail_frames and idx in fail_frames:
            raise RuntimeError("fleet boom")
        return _PNG

    async def encode(frames_dir, output, fps, audio_path):
        rec.encoded.append((fps, audio_path is not None))
        output.write_bytes(_MP4)

    monkeypatch.setattr(svc, "healthy_upscale_workers", healthy)
    monkeypatch.setattr(svc, "_fetch_source_local", fetch)
    monkeypatch.setattr(svc, "probe_video", probe)
    monkeypatch.setattr(svc, "extract_frames", extract)
    monkeypatch.setattr(svc, "extract_audio", audio)
    monkeypatch.setattr(svc, "upscale_frame_remote", remote)
    monkeypatch.setattr(svc, "encode_video", encode)
    monkeypatch.setattr(svc, "product_root", lambda: tmp_path)


def _read_job(engine, prompt_id: str) -> Job:
    with Session(engine) as s:
        return s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()


def test_pipeline_success_done_and_cleanup(ctx, monkeypatch):
    """全成功:6 帧 round-robin 到 2 实例 → done + 产物 URL 回写 + 进度 done + 帧目录清理。"""
    _, _, engine, uid, tmp_path = ctx
    rec = _Rec()
    _mock_pipeline(monkeypatch, tmp_path, rec)
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="ok1")

    asyncio.run(svc.run_pipeline(
        job_id, prompt_id, "/api/drama/output/drama-" + "0" * 32 + ".mp4", "4k",
        ["http://w1", "http://w2"],
    ))

    job = _read_job(engine, prompt_id)
    assert job.status == "done"
    urls = json.loads(job.result)
    assert urls == [f"/api/video/upscale/output/upscale-{job_id}.mp4"]
    assert (tmp_path / f"upscale-{job_id}.mp4").is_file()
    # 目标推导进 remote 调用(横屏 → 3840×2160)
    assert all(w == 3840 and h == 2160 for _, _, w, h in rec.remote_calls)
    # round-robin:两个实例都分到帧
    workers_hit = {c[0] for c in rec.remote_calls}
    assert workers_hit == {"http://w1", "http://w2"}
    assert len(rec.remote_calls) == 6
    # 音轨回接(源有音轨)
    assert rec.encoded == [(24.0, True)]
    # 成功后才清帧目录
    assert not (tmp_path / "frames" / job_id).exists()
    # 进度终态
    assert svc.progress_snapshot(job_id)["stage"] == "done"
    # prompt 已带实际规格
    assert "3840×2160" in job.prompt and "6帧" in job.prompt
    svc._PROGRESS.pop(job_id, None)


def test_pipeline_portrait_target(ctx, monkeypatch):
    """竖屏源(576×1024,诛仙案例)→ 目标 2160×3840,方向护栏不拦。"""
    _, _, engine, uid, tmp_path = ctx
    rec = _Rec()
    _mock_pipeline(monkeypatch, tmp_path, rec, src_wh=(576, 1024), with_audio=False)
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="pt1")

    asyncio.run(svc.run_pipeline(
        job_id, prompt_id, "/api/drama/output/drama-" + "0" * 32 + ".mp4", "4k",
        ["http://w1"],
    ))
    job = _read_job(engine, prompt_id)
    assert job.status == "done"
    assert all(w == 2160 and h == 3840 for _, _, w, h in rec.remote_calls)
    # 无音轨 → 补静音轨(encode 仍带 audio 映射,audio_path=None)
    assert rec.encoded == [(24.0, False)]


def test_pipeline_missing_frame_error_keeps_frames(ctx, monkeypatch):
    """帧 3 两次尝试均失败 → 缺失帧检测 error;帧目录保留(可续跑),产物不落。"""
    _, _, engine, uid, tmp_path = ctx
    rec = _Rec()
    _mock_pipeline(monkeypatch, tmp_path, rec, fail_frames={3})
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="err1")

    asyncio.run(svc.run_pipeline(
        job_id, prompt_id, "/api/drama/output/drama-" + "0" * 32 + ".mp4", "4k",
        ["http://w1"],
    ))
    job = _read_job(engine, prompt_id)
    assert job.status == "error"
    # 帧 3 首试 + 1 次重试 = 2 次调用
    assert sum(1 for c in rec.remote_calls if c[1] == "frame_000003.png") == 2
    # 帧目录保留(keep-frames 语义),产物未生成
    assert (tmp_path / "frames" / job_id / "upscaled").is_dir()
    assert not (tmp_path / f"upscale-{job_id}.mp4").exists()
    assert svc.progress_snapshot(job_id)["stage"] == "error"
    svc._PROGRESS.pop(job_id, None)


def test_pipeline_resume_skips_done_frames(ctx, monkeypatch):
    """断点续跑:预置 1-4 帧已超分 → 仅补 5/6 帧,源帧抽取也跳过(已有 frame_*)。"""
    _, _, engine, uid, tmp_path = ctx
    rec = _Rec()
    _mock_pipeline(monkeypatch, tmp_path, rec)
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="res1")
    # 预置续跑现场:源帧 6 个 + 已超分 1-4
    src_dir = tmp_path / "frames" / job_id / "src"
    out_dir = tmp_path / "frames" / job_id / "upscaled"
    src_dir.mkdir(parents=True)
    out_dir.mkdir(parents=True)
    (tmp_path / "frames" / job_id / "source.mp4").write_bytes(_MP4)
    for i in range(1, 7):
        (src_dir / f"frame_{i:06d}.png").write_bytes(_PNG)
    for i in range(1, 5):
        (out_dir / f"upscaled_{i:06d}.png").write_bytes(_PNG)

    asyncio.run(svc.run_pipeline(
        job_id, prompt_id, "/api/drama/output/drama-" + "0" * 32 + ".mp4", "4k",
        ["http://w1"],
    ))
    job = _read_job(engine, prompt_id)
    assert job.status == "done"
    assert len(rec.remote_calls) == 2  # 仅 5/6 两帧
    assert {c[1] for c in rec.remote_calls} == {"frame_000005.png", "frame_000006.png"}
    svc._PROGRESS.pop(job_id, None)


def test_pipeline_fleet_lost_midway_error(ctx, monkeypatch):
    """后台二次健康探测全挂 → error(端点预检与运行期双保险)。"""
    _, _, engine, uid, tmp_path = ctx
    rec = _Rec()
    _mock_pipeline(monkeypatch, tmp_path, rec)

    async def healthy(_urls=None):
        return []

    monkeypatch.setattr(svc, "healthy_upscale_workers", healthy)
    job_id, prompt_id = _mk_job(engine, uid, id_suffix="dn1")
    asyncio.run(svc.run_pipeline(
        job_id, prompt_id, "/api/drama/output/drama-" + "0" * 32 + ".mp4", "4k", ["http://w1"],
    ))
    assert _read_job(engine, prompt_id).status == "error"
    assert rec.remote_calls == []
    svc._PROGRESS.pop(job_id, None)


def test_healthy_upscale_workers_filters_dead(monkeypatch):
    """fleet 健康探测:死实例剔除,活实例保持入参序。"""

    class FakeClient:
        def __init__(self, base_url, timeout=30.0):
            self.base_url = base_url

        async def get_system_stats(self):
            if "dead" in self.base_url:
                from app.comfy.client import ComfyUIError

                raise ComfyUIError("down")
            return {"devices": []}

    monkeypatch.setattr(svc, "ComfyUIClient", FakeClient)
    got = asyncio.run(svc.healthy_upscale_workers(["http://dead1", "http://ok1", "http://ok2"]))
    assert got == ["http://ok1", "http://ok2"]
