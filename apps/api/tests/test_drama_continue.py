"""末帧续写(continue-video)测试。

覆盖:
  · 端点校验:无已完成视频 422 / segments 上限 422 / 非法 engine 422 /
    续写进行中 409 / 显式 length 帧数网格 422 / 正常提交 200(状态置 continuing)
  · 抽帧逻辑:_extract_last_frame 的 ffmpeg 命令(-sseof 倒 seek + -frames:v 1,mock 执行)
  · 帧数网格:_snap_ltx_length(8k+1)/ _snap_h3_length(17k+5)取整与钳位
  · i2v 提交参数:LTX 两段续写(图上传 → i2v 图 LoadImage/length 8k+1 → Job 登记
    → 段产物落成片目录 → 段间末帧链式衔接 → continue_urls 回写)
  · H3 引擎:length 17k+5、24fps、宽高 32 对齐,复用 h3_service.submit_h3_job
  · auto_concat:拼接 ffmpeg 被调用且 continue_concat_url 回写
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.drama_studio as drama_studio_route
from app.db import get_session
from app.main import app
from app.models import DramaProject, DramaShot, Job, Tenant, User
from app.security import create_token, hash_password


@pytest.fixture()
def ctx(tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    # 后台任务用 `from app.db import engine` 取独立 Session,patch 指向测试内存库
    with patch.object(__import__("app.db", fromlist=["engine"]), "engine", engine):
        with Session(engine) as s:
            tenant = Tenant(name="cont")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="cont@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            uid = user.id
            # 一个项目 + 一个已完成视频的分镜(video_url 为 worker 产物代理 URL)
            project = DramaProject(
                tenant_id=tenant.id, user_id=uid, title="续写测试", fps=16,
                width=768, height=384,
            )
            s.add(project)
            s.commit()
            s.refresh(project)
            shot = DramaShot(
                project_id=project.id, idx=0, prompt="1boy, walking, cinematic",
                duration_sec=6, video_status="done",
                video_url="/api/images?filename=v.mp4&subfolder=&type=output&worker=http://worker",
                seed=42,
            )
            s.add(shot)
            s.commit()
            s.refresh(shot)
            pid, sid = project.id, shot.id
        yield TestClient(app), create_token(uid), engine, pid, sid, tmp_path
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _set_shot(engine, sid: str, **fields) -> None:
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        for k, v in fields.items():
            setattr(shot, k, v)
        s.add(shot)
        s.commit()


def _close_coro(coro) -> None:
    """_spawn 替身:关闭协程避免 RuntimeWarning(后台链路单独直连测试)。"""
    coro.close()
    return None


# ---------------------------------------------------------------------------
# 端点校验
# ---------------------------------------------------------------------------


def test_continue_requires_done_video(ctx):
    client, token, engine, pid, sid, _ = ctx
    _set_shot(engine, sid, video_status="pending", video_url="")
    r = client.post(f"/api/drama/shots/{sid}/continue-video", headers=_h(token), json={})
    assert r.status_code == 422
    assert "尚无已完成视频" in r.json()["detail"]


def test_continue_segments_out_of_range(ctx):
    client, token, _, pid, sid, _ = ctx
    for bad in (0, 6):
        r = client.post(
            f"/api/drama/shots/{sid}/continue-video",
            headers=_h(token),
            json={"segments": bad},
        )
        assert r.status_code == 422, f"segments={bad} 应 422"


def test_continue_rejects_unknown_engine(ctx):
    client, token, _, pid, sid, _ = ctx
    r = client.post(
        f"/api/drama/shots/{sid}/continue-video",
        headers=_h(token),
        json={"engine": "wan"},
    )
    assert r.status_code == 422


def test_continue_conflict_when_continuing(ctx):
    client, token, engine, pid, sid, _ = ctx
    _set_shot(engine, sid, continue_status="continuing")
    r = client.post(f"/api/drama/shots/{sid}/continue-video", headers=_h(token), json={})
    assert r.status_code == 409


def test_continue_explicit_length_grid_validated(ctx):
    """显式 length 必须满足引擎帧数网格,否则 422(缺省则自动对齐)。"""
    client, token, _, pid, sid, _ = ctx
    # LTX:100 非 8k+1
    r = client.post(
        f"/api/drama/shots/{sid}/continue-video",
        headers=_h(token),
        json={"length": 100},
    )
    assert r.status_code == 422
    assert "8k+1" in r.json()["detail"]
    # H3:100 非 17k+5
    r = client.post(
        f"/api/drama/shots/{sid}/continue-video",
        headers=_h(token),
        json={"engine": "h3", "length": 100},
    )
    assert r.status_code == 422
    assert "17k+5" in r.json()["detail"]


def test_continue_submit_ok(ctx):
    """正常提交:200 + 状态置 continuing + 响应回显引擎/帧数/fps。"""
    client, token, engine, pid, sid, _ = ctx
    with patch.object(drama_studio_route, "_spawn", _close_coro):
        r = client.post(
            f"/api/drama/shots/{sid}/continue-video",
            headers=_h(token),
            json={"segments": 2, "auto_concat": True},
        )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "continuing"
    assert body["segments"] == 2 and body["engine"] == "ltx"
    # 缺省 length:16fps × 6s = 96 → 向下对齐 8k+1 = 89
    assert body["length"] == 89 and body["fps"] == 16
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == "continuing"
        assert shot.continue_error == ""


# ---------------------------------------------------------------------------
# 抽帧逻辑(mock ffmpeg)
# ---------------------------------------------------------------------------


def test_extract_last_frame_command(ctx):
    """末帧抽取:-sseof 倒 seek + -frames:v 1 + -q:v 2,产物为空时报错。"""
    *_, tmp_path = ctx
    src = tmp_path / "in.mp4"
    src.write_bytes(b"video")
    out = tmp_path / "frame.jpg"
    calls: list[list[str]] = []

    async def fake_ffmpeg(cmd: list[str], timeout: float = 600.0) -> None:
        calls.append(cmd)
        Path(cmd[-1]).write_bytes(b"jpg")

    with patch("app.routes.assembly._run_ffmpeg", fake_ffmpeg):
        asyncio.run(drama_studio_route._extract_last_frame(src, out))
    cmd = calls[0]
    assert "-sseof" in cmd and "-frames:v" in cmd
    i = cmd.index("-frames:v")
    assert cmd[i + 1] == "1"
    assert str(src) in cmd and cmd[-1] == str(out)

    # ffmpeg 未产出 → HTTPException 500
    from fastapi import HTTPException

    async def fake_ffmpeg_noop(cmd: list[str], timeout: float = 600.0) -> None:
        pass

    with patch("app.routes.assembly._run_ffmpeg", fake_ffmpeg_noop):
        with pytest.raises(HTTPException):
            asyncio.run(drama_studio_route._extract_last_frame(src, tmp_path / "f2.jpg"))


def test_snap_length_helpers():
    s_ltx = drama_studio_route._snap_ltx_length
    s_h3 = drama_studio_route._snap_h3_length
    assert s_ltx(96) == 89 and s_ltx(97) == 97
    assert s_ltx(1) == 9 and s_ltx(500) == 241
    assert s_h3(144) == 141 and s_h3(124) == 124
    assert s_h3(10) == 22 and s_h3(400) == 362


# ---------------------------------------------------------------------------
# 后台续写链路(直连 _run_continue_video,fake worker)
# ---------------------------------------------------------------------------


class _FakeClient:
    """最小化 ComfyUIClient 替身:记录上传与提交的图。"""

    def __init__(self, base_url: str = "http://worker") -> None:
        self.base_url = base_url
        self.uploads: list[tuple[bytes, str]] = []
        self.graphs: list[dict] = []

    async def upload_image(self, content: bytes, name: str) -> str:
        self.uploads.append((content, name))
        return f"up-{len(self.uploads)}.jpg"

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        self.graphs.append(graph)
        return f"pid-{len(self.graphs)}"


def _graph_length(graph: dict) -> int | None:
    for node in graph.values():
        if isinstance(node, dict) and "length" in node.get("inputs", {}):
            return node["inputs"]["length"]
    return None


def _install_common_mocks(tmp_path, fake_client, monkeypatch):
    """挂接 _run_continue_video 的外部依赖:pool/ffmpeg/tracker/下载/成片目录。

    返回 (下载调用 list, 抽帧调用 list)。抽帧/下载用文件读写模拟真实副作用,
    使段间「上一段产物 → 下一段抽帧源」的链式衔接可被断言。
    """
    pool = MagicMock()
    pool.pick = AsyncMock(return_value=fake_client)
    pool.clients = [fake_client]
    monkeypatch.setattr(drama_studio_route, "get_pool", lambda: pool)
    monkeypatch.setattr(drama_studio_route, "spawn_tracker", lambda c, p: None)
    monkeypatch.setattr(drama_studio_route, "_drama_dir", lambda: tmp_path)

    downloads: list[str] = []

    async def fake_download(pool_, url: str, dest: Path) -> None:
        downloads.append(url)
        dest.write_bytes(b"video")

    monkeypatch.setattr(drama_studio_route, "_download_images_clip", fake_download)

    extracts: list[str] = []

    async def fake_extract(video: Path, out: Path) -> None:
        assert video.is_file(), f"抽帧源不存在: {video}"
        extracts.append(video.name)
        out.write_bytes(b"jpg")

    monkeypatch.setattr(drama_studio_route, "_extract_last_frame", fake_extract)
    return downloads, extracts


def test_run_continue_ltx_two_segments(ctx, monkeypatch):
    """LTX 两段续写:i2v 参数正确、Job 登记、段间末帧链式衔接、产物回写。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    downloads, extracts = _install_common_mocks(tmp_path, fake, monkeypatch)

    seg_urls = {
        "pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"],
        "pid-2": ["/api/images?filename=s2.mp4&type=output&worker=http://worker"],
    }
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(side_effect=lambda s, pids, **kw: {p: seg_urls[p] for p in pids}),
    )

    body = drama_studio_route.ContinueVideoRequest(segments=2, seed=7)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    # 提交了两张 i2v 图:LoadImage 引用上传名;length 8k+1;fps 沿用项目
    assert len(fake.graphs) == 2
    for g in fake.graphs:
        assert g["9"]["class_type"] == "LoadImage"
        assert _graph_length(g) == 89  # 16fps × 6s = 96 → 89
    assert fake.graphs[0]["9"]["inputs"]["image"] == "up-1.jpg"
    assert fake.graphs[1]["9"]["inputs"]["image"] == "up-2.jpg"
    assert len(fake.uploads) == 2 and all(u[1].endswith(".jpg") for u in fake.uploads)

    # 段间衔接:源视频 → 段1 → 段2;段产物经 worker 产物 URL 下载
    assert extracts == ["seg-000.mp4", "seg-001.mp4"]
    assert downloads[0].startswith("/api/images?")  # 源视频
    assert downloads[1] == seg_urls["pid-1"][0]
    assert downloads[2] == seg_urls["pid-2"][0]

    # Job 登记(kind 下划线风格,与现有产物同走 tracker 语义)
    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.kind == "drama_shot_continue_i2v")).all()
        assert len(jobs) == 2
        assert {j.seed for j in jobs} == {7, jobs[1].seed}  # 首段用指定 seed
        assert jobs[0].seed == 7
        # 分镜回写:done + 两段成片目录 URL
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == "done"
        urls = json.loads(shot.continue_urls)
        assert len(urls) == 2
        assert all(u.startswith("/api/drama/output/drama-") for u in urls)
        assert shot.continue_concat_url == ""
        # 段产物文件真实落盘
        for u in urls:
            assert (tmp_path / u.rsplit("/", 1)[-1]).is_file()


def test_run_continue_h3_params(ctx, monkeypatch):
    """H3 引擎:length 17k+5(6s@24fps=144→141)、宽高 32 对齐、复用 submit_h3_job。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient(base_url="http://h3")
    downloads, extracts = _install_common_mocks(tmp_path, fake, monkeypatch)

    submitted: list[dict] = []

    async def fake_submit(graph, *, kind, positive, seed, req, user, session, client=None, nsfw=False):
        submitted.append({"graph": graph, "kind": kind, "seed": seed, "nsfw": nsfw})
        return {"prompt_id": "h3p-1", "client_id": "c", "worker": "http://h3", "seed": seed}

    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"h3p-1": ["/api/images?filename=h1.mp4&type=output&worker=http://h3"]}),
    )
    import app.services.h3 as h3_service

    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "submit_h3_job", fake_submit)

    body = drama_studio_route.ContinueVideoRequest(segments=1, engine="h3")
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "h3", tid, uid))

    assert len(submitted) == 1
    assert submitted[0]["kind"] == "drama_shot_continue_h3_i2v"
    graph = submitted[0]["graph"]
    assert _graph_length(graph) == 141  # 24fps × 6s = 144 → 141(17k+5)
    # 宽高 32 对齐注入(项目 768×384 已对齐)
    h3_node = next(
        n for n in graph.values()
        if isinstance(n, dict) and n.get("class_type") == "MiniMaxH3ImageToVideo"
    )
    assert h3_node["inputs"]["width"] % 32 == 0
    assert h3_node["inputs"]["height"] % 32 == 0
    # 参考图直传 H3 实例(不经 pool worker 转运)
    assert len(fake.uploads) == 1

    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == "done"
        assert len(json.loads(shot.continue_urls)) == 1


def test_run_continue_auto_concat(ctx, monkeypatch):
    """auto_concat=True:续写完成后 ffmpeg 拼接 源视频+各段,continue_concat_url 回写。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"]}),
    )
    monkeypatch.setattr(drama_studio_route, "_probe_has_audio", AsyncMock(return_value=True))

    concat_calls: list[dict] = []

    async def fake_concat(parts, fps, with_audio, out):
        concat_calls.append({"parts": list(parts), "fps": fps, "with_audio": with_audio})
        out.write_bytes(b"concat")

    with patch("app.routes.assembly._concat_parts", fake_concat):
        body = drama_studio_route.ContinueVideoRequest(segments=1, auto_concat=True)
        with Session(engine) as s:
            uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
            tid = s.get(DramaProject, pid).tenant_id
        asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    assert len(concat_calls) == 1
    # 拼接 = 源视频 + 1 段续写,带音轨,fps 沿用项目
    assert len(concat_calls[0]["parts"]) == 2
    assert concat_calls[0]["fps"] == 16 and concat_calls[0]["with_audio"] is True
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == "done"
        assert shot.continue_concat_url.startswith("/api/drama/output/drama-")
        assert (tmp_path / shot.continue_concat_url.rsplit("/", 1)[-1]).is_file()


def test_run_continue_error_marks_status(ctx, monkeypatch):
    """续写中段失败:continue_status 置 error 且带原因,不静默。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(side_effect=RuntimeError("作业 pid-1 执行失败")),
    )
    body = drama_studio_route.ContinueVideoRequest(segments=1)
    _set_shot(engine, sid, continue_status="continuing")  # 端点先行置位,后台任务仅回写
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == "error"
        assert "执行失败" in shot.continue_error


def _graph_dims(graph: dict) -> tuple[int, int] | None:
    for node in graph.values():
        inputs = node.get("inputs", {}) if isinstance(node, dict) else {}
        if "width" in inputs and "height" in inputs:
            return inputs["width"], inputs["height"]
    return None


def test_run_continue_aligns_to_source_video_meta(ctx, monkeypatch):
    """段参数向源视频实测对齐:probe 到 640×360@24 时,图参数/fps 用实测值而非项目默认值。

    回归场景:历史项目 project.width/height/fps 与分镜实际视频不一致(如项目
    默认 256×256@8,实际视频 768×384@16),段产物参数必须与源视频一致,否则
    concat 滤镜报 "Failed to configure output pad"。
    """
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"]}),
    )
    monkeypatch.setattr(
        drama_studio_route, "_probe_video_meta", AsyncMock(return_value=(640, 360, 24))
    )

    body = drama_studio_route.ContinueVideoRequest(segments=1, seed=7)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    assert len(fake.graphs) == 1
    g = fake.graphs[0]
    assert _graph_dims(g) == (640, 360)  # 实测分辨率(8 对齐)
    assert _graph_length(g) == 137  # 24fps × 6s = 144 → 137(8k+1,按实测 fps 换算)


def test_run_continue_probe_fallback_to_project(ctx, monkeypatch):
    """probe 失败(返回 None)时回落项目参数,行为与修复前一致。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"]}),
    )
    monkeypatch.setattr(drama_studio_route, "_probe_video_meta", AsyncMock(return_value=None))

    body = drama_studio_route.ContinueVideoRequest(segments=1, seed=7)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    g = fake.graphs[0]
    assert _graph_dims(g) == (768, 384)  # 项目默认 768×384@16
    assert _graph_length(g) == 89  # 16fps × 6s = 96 → 89


# ---------------------------------------------------------------------------
# R18 回归(2026-08-08):续写段 nsfw 门控 + 打标传播
# 修复前 continue-video 硬编码 nsfw=False:R18 分镜续写产物漏进主站作品库,
# 且入口无 _gate_ltx_nsfw,主站可借续写绕过 G1。判定来源与 generate-video
# 同一套(请求体 nsfw 字段 + X-NSFW 头门控,10Eros 底模分流)。
# ---------------------------------------------------------------------------


def test_continue_nsfw_blocked_without_x_nsfw(ctx):
    """continue-video:nsfw=true 无 X-NSFW 头 → 403,分镜状态不被置 continuing。"""
    client, token, engine, pid, sid, _ = ctx
    r = client.post(
        f"/api/drama/shots/{sid}/continue-video",
        headers=_h(token),
        json={"nsfw": True},
    )
    assert r.status_code == 403, r.text
    assert "NSFW 专区" in r.json()["detail"]
    with Session(engine) as s:
        shot = s.get(DramaShot, sid)
        assert shot.continue_status == ""  # 门控先于状态置位,无副作用
        assert s.exec(select(Job)).all() == []


def test_continue_nsfw_allowed_with_x_nsfw(ctx, monkeypatch):
    """continue-video:带 X-NSFW 头门控放行(后台链路 mock,验证全链路 200)。"""
    client, token, engine, pid, sid, _ = ctx
    monkeypatch.setattr(drama_studio_route, "_spawn", _close_coro)
    r = client.post(
        f"/api/drama/shots/{sid}/continue-video",
        headers={**_h(token), "X-NSFW": "1"},
        json={"nsfw": True, "segments": 1},
    )
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "continuing"
    with Session(engine) as s:
        assert s.get(DramaShot, sid).continue_status == "continuing"


def test_run_continue_ltx_nsfw_uses_10eros_and_marks_jobs(ctx, monkeypatch):
    """LTX 续写 nsfw=True:段图用 10Eros 底模(非 SFW 默认),段 Job 打 nsfw 标。"""
    from app.config import get_settings

    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"]}),
    )

    body = drama_studio_route.ContinueVideoRequest(segments=1, seed=7, nsfw=True)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    settings = get_settings()
    assert fake.graphs[0]["1"]["inputs"]["unet_name"] == settings.nsfw_default_video_ckpt
    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.kind == "drama_shot_continue_i2v")).all()
        assert len(jobs) == 1 and jobs[0].nsfw is True


def test_run_continue_ltx_sfw_default_jobs_not_nsfw(ctx, monkeypatch):
    """SFW 默认(nsfw=False)行为不变:段图用 SFW 底模,段 Job 不打标。"""
    from app.config import get_settings

    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient()
    _install_common_mocks(tmp_path, fake, monkeypatch)
    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"pid-1": ["/api/images?filename=s1.mp4&type=output&worker=http://worker"]}),
    )

    body = drama_studio_route.ContinueVideoRequest(segments=1, seed=7)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "ltx", tid, uid))

    settings = get_settings()
    assert fake.graphs[0]["1"]["inputs"]["unet_name"] == settings.default_video_ckpt
    with Session(engine) as s:
        jobs = s.exec(select(Job).where(Job.kind == "drama_shot_continue_i2v")).all()
        assert len(jobs) == 1 and jobs[0].nsfw is False


def test_run_continue_h3_nsfw_propagates_to_submit(ctx, monkeypatch):
    """H3 续写 nsfw=True:标记透传到 submit_h3_job(由服务层落 Job 打标)。"""
    _, _, engine, pid, sid, tmp_path = ctx
    fake = _FakeClient(base_url="http://h3")
    _install_common_mocks(tmp_path, fake, monkeypatch)

    submitted: list[dict] = []

    async def fake_submit(graph, *, kind, positive, seed, req, user, session, client=None, nsfw=False):
        submitted.append({"kind": kind, "nsfw": nsfw})
        return {"prompt_id": "h3p-1", "client_id": "c", "worker": "http://h3", "seed": seed}

    monkeypatch.setattr(
        drama_studio_route, "wait_for_jobs",
        AsyncMock(return_value={"h3p-1": ["/api/images?filename=h1.mp4&type=output&worker=http://h3"]}),
    )
    import app.services.h3 as h3_service

    monkeypatch.setattr(h3_service, "get_h3_client", lambda: fake)
    monkeypatch.setattr(h3_service, "submit_h3_job", fake_submit)

    body = drama_studio_route.ContinueVideoRequest(segments=1, engine="h3", nsfw=True)
    with Session(engine) as s:
        uid = s.exec(select(User).where(User.email == "cont@toiv.ai")).first().id
        tid = s.get(DramaProject, pid).tenant_id
    asyncio.run(drama_studio_route._run_continue_video(sid, body, "h3", tid, uid))

    assert submitted == [{"kind": "drama_shot_continue_h3_i2v", "nsfw": True}]
