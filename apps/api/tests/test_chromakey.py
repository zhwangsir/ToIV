"""绿幕抠像合成(POST /api/video/chromakey)测试。

覆盖:
  · ffmpeg 命令构造(纯函数):纯色背景 lavfi color 画布、图片背景 loop+缩放充满,
    chromakey 滤镜串(key_color/similarity/blend)、overlay shortest=1、音轨透传
  · 契约校验:401 未认证 / image 缺 background_url 400 / 背景非白名单 400 /
    key_color、similarity 非法 422 / 前景来源前缀非法 422
  · 前景:下载失败 400 / 非视频 400(真 ffprobe)/ R18 源无专区上下文 403
  · 成功链路(mock ffmpeg):纯色 + 图片背景,断言滤镜串与产物建档
    (Job kind=chromakey status=done result=产物 URL,params 快照溯源,nsfw 继承)
  · ffmpeg 缺失/失败 → 500(detail 带 stderr 尾部)
  · 产物端点:200/206 Range/非法名 400/不存在 404
  · 真 ffmpeg e2e(有 ffmpeg 时):绿色纯色视频抠像到红底,出片可 ffprobe
"""
from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.services.video_upscale as upscale_svc
from app.db import get_session
from app.main import app
from app.models import Job, Tenant, User
from app.routes import chromakey as ck
from app.security import create_token, hash_password
from app.services.studio.ffmpeg_ops import FFmpegError

_MP4 = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64
_PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 64


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
    with Session(engine) as s:
        tenant = Tenant(name="ck")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="ck@toiv.ai",
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


def _fg_url(tmp_path: Path, content: bytes = _MP4) -> str:
    """造一个本地产物来源(超分产物 URL 形态),返回其 URL。"""
    name = "upscale-" + "a" * 32 + ".mp4"
    (tmp_path / name).write_bytes(content)
    return f"/api/video/upscale/output/{name}"


def _patch_storage(monkeypatch, tmp_path: Path) -> None:
    """产物/来源目录指向 tmp:抠像产物根 + 超分产物根(前景来源)。"""
    monkeypatch.setattr(ck, "product_root", lambda: tmp_path / "ck_out")
    monkeypatch.setattr(upscale_svc, "product_root", lambda: tmp_path)


def _patch_pipeline(
    monkeypatch, tmp_path: Path, recorded: dict, *, write_output: bool = True
) -> None:
    """mock 探测与 ffmpeg:记录命令并按需写出产物文件。"""

    async def _fake_probe(path: Path):
        return {"width": 320, "height": 240, "rate": "25/1"}

    async def _fake_run(cmd, timeout=0.0):
        recorded["cmd"] = cmd
        if write_output:
            Path(cmd[-1]).write_bytes(_MP4)

    monkeypatch.setattr(ck, "_probe_video", _fake_probe)
    monkeypatch.setattr(ck, "run_ffmpeg", _fake_run)
    monkeypatch.setattr(ck, "ensure_ffmpeg", lambda: "ffmpeg")


class _FakeBGClient:
    """背景图下载替身(记录请求 URL)。"""

    def __init__(self, content: bytes = _PNG):
        self.calls: list[str] = []
        self._content = content

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass

    async def get(self, url: str):
        self.calls.append(url)

        class _Resp:
            content = self._content

            def raise_for_status(self):
                return None

        return _Resp()


# ---------------------------------------------------------------------------
# ffmpeg 命令构造(纯函数)
# ---------------------------------------------------------------------------


def test_build_cmd_color_background():
    cmd = ck.build_chromakey_cmd(
        Path("fg.mp4"), Path("out.mp4"),
        width=1920, height=1080, rate="30/1",
        key_color="0x00FF00", similarity=0.18, blend=0.08,
        background_type="color", background_color="black",
    )
    s = " ".join(cmd)
    assert "color=c=black:s=1920x1080:r=30/1" in s
    assert "chromakey=0x00FF00:0.18:0.08" in s
    assert "overlay=shortest=1" in s
    assert cmd[cmd.index("-map") + 1] == "[out]"
    assert "0:a?" in cmd  # 音轨透传前景
    assert "-shortest" in cmd


def test_build_cmd_image_background():
    cmd = ck.build_chromakey_cmd(
        Path("fg.mp4"), Path("out.mp4"),
        width=1080, height=1920, rate="25/1",
        key_color="0x00FF00", similarity=0.3, blend=0.1,
        background_type="image", background_path=Path("bg.png"),
    )
    s = " ".join(cmd)
    # 图片背景:loop 输入 + 同帧率 + 充满裁边到前景尺寸
    assert "-loop 1 -framerate 25/1 -i bg.png" in s
    assert "scale=1080:1920:force_original_aspect_ratio=increase,crop=1080:1920" in s
    assert "chromakey=0x00FF00:0.3:0.1" in s
    assert "overlay=shortest=1" in s
    assert "1:a?" in cmd  # 音轨取自前景(输入 1)


# ---------------------------------------------------------------------------
# 契约校验
# ---------------------------------------------------------------------------


def test_endpoint_requires_auth(ctx):
    client, *_ = ctx
    r = client.post("/api/video/chromakey", json={"foreground_url": "/api/drama/output/x.mp4"})
    assert r.status_code == 401


def test_image_type_without_background_url_400(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": "/api/drama/output/drama-" + "0" * 32 + ".mp4",
              "background_type": "image"},
    )
    assert r.status_code == 400
    assert "background_url" in r.json()["detail"]


def test_background_url_not_whitelisted_400(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": "/api/drama/output/x.mp4",
              "background_type": "image",
              "background_url": "http://evil.example.com/bg.png"},
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


def test_invalid_key_color_422(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": "/api/drama/output/x.mp4", "key_color": "red;rm -rf /"},
    )
    assert r.status_code == 422


def test_similarity_out_of_range_422(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": "/api/drama/output/x.mp4", "similarity": 2.0},
    )
    assert r.status_code == 422


def test_foreground_unknown_prefix_422(ctx):
    client, token, *_ = ctx
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": "http://evil.example.com/x.mp4"},
    )
    assert r.status_code == 422


# ---------------------------------------------------------------------------
# 前景校验
# ---------------------------------------------------------------------------


def test_foreground_download_failure_400(ctx, monkeypatch, tmp_path):
    """前景下载失败(worker 不可达等)→ 400。"""
    client, token, *_ = ctx
    _patch_storage(monkeypatch, tmp_path)

    async def _boom(url, dest):
        raise upscale_svc.VideoUpscaleError("源视频下载失败(同机 worker 均不可达)")

    monkeypatch.setattr(upscale_svc, "_fetch_source_local", _boom)
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path)},
    )
    assert r.status_code == 400
    assert "前景视频下载失败" in r.json()["detail"]


def test_foreground_not_video_400(ctx, monkeypatch, tmp_path):
    """前景字节不是视频(真 ffprobe 探测失败)→ 400。"""
    client, token, *_ = ctx
    _patch_storage(monkeypatch, tmp_path)
    if shutil.which("ffprobe") is None:
        pytest.skip("ffprobe 不可用")
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path, content=b"not a video at all")},
    )
    assert r.status_code == 400
    assert "有效视频" in r.json()["detail"]


def test_r18_foreground_requires_context_403(ctx, monkeypatch, tmp_path):
    """R18 绿幕源(本人 Job 产物)无 X-NSFW 上下文 → 403。"""
    client, token, engine, uid, tmp_path = ctx
    with Session(engine) as s:
        user = s.get(User, uid)
        s.add(Job(
            tenant_id=user.tenant_id, user_id=uid, prompt_id="p-gs",
            worker="http://w", kind="avatar_talk", status="done", seed=1, nsfw=True,
            result=json.dumps(["/api/images?filename=green.mp4&worker=http://w"]),
        ))
        s.commit()
    url = "/api/images?filename=green.mp4&subfolder=&type=output&worker=http://w"
    r = client.post(
        "/api/video/chromakey", headers=_h(token), json={"foreground_url": url}
    )
    assert r.status_code == 403


# ---------------------------------------------------------------------------
# 成功链路(mock ffmpeg)
# ---------------------------------------------------------------------------


def test_success_color_background_mock_ffmpeg(ctx, monkeypatch, tmp_path):
    """纯色背景:滤镜串正确 + 产物建档(kind=chromakey, done, result URL, params 溯源)。"""
    client, token, engine, uid, tmp_path = ctx
    _patch_storage(monkeypatch, tmp_path)
    recorded: dict = {}
    _patch_pipeline(monkeypatch, tmp_path, recorded)

    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path),
              "background_color": "black", "key_color": "0x00FF00",
              "similarity": 0.2, "blend": 0.1},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["kind"] == "chromakey"
    assert data["url"].startswith("/api/video/chromakey/output/chromakey-")
    assert data["job_id"]

    filters = recorded["cmd"][recorded["cmd"].index("-filter_complex") + 1]
    assert "chromakey=0x00FF00:0.2:0.1" in filters
    assert "overlay=shortest=1" in filters
    assert "color=c=black:s=320x240:r=25/1" in " ".join(recorded["cmd"])

    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "chromakey")).first()
    assert job is not None and job.status == "done"
    assert json.loads(job.result) == [data["url"]]
    assert job.id == data["job_id"]
    params = json.loads(job.params)
    assert params["key_color"] == "0x00FF00"
    assert params["background_type"] == "color"
    assert params["similarity"] == 0.2


def test_success_image_background_mock_ffmpeg(ctx, monkeypatch, tmp_path):
    """图片背景:背景图经白名单下载,loop+scale 滤镜,音轨取自前景。"""
    client, token, engine, uid, tmp_path = ctx
    _patch_storage(monkeypatch, tmp_path)
    recorded: dict = {}
    _patch_pipeline(monkeypatch, tmp_path, recorded)
    bg_client = _FakeBGClient()
    monkeypatch.setattr("httpx.AsyncClient", lambda *a, **k: bg_client)

    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path),
              "background_type": "image",
              "background_url": "/api/images?filename=bg.png&worker=http://w"},
    )
    assert r.status_code == 200, r.text
    cmd = recorded["cmd"]
    s = " ".join(cmd)
    assert "-loop 1" in s
    assert "scale=320:240:force_original_aspect_ratio=increase,crop=320:240" in s
    assert "chromakey=0x00FF00:0.18:0.08" in s  # 默认抠像参数
    assert "1:a?" in cmd
    # 背景图相对 URL 经 api_base_url 解析后下载
    assert bg_client.calls and bg_client.calls[0].endswith(
        "/api/images?filename=bg.png&worker=http://w"
    )
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "chromakey")).first()
    assert json.loads(job.params)["background_url"].startswith("/api/images?")


def test_success_inherits_nsfw_flag(ctx, monkeypatch, tmp_path):
    """R18 源 + 专区上下文:新作业继承 nsfw=True(不进主站作品库)。"""
    client, token, engine, uid, tmp_path = ctx
    _patch_storage(monkeypatch, tmp_path)
    _patch_pipeline(monkeypatch, tmp_path, {})
    with Session(engine) as s:
        user = s.get(User, uid)
        s.add(Job(
            tenant_id=user.tenant_id, user_id=uid, prompt_id="p-gs2",
            worker="http://w", kind="avatar_talk", status="done", seed=1, nsfw=True,
            result=json.dumps(["/api/images?filename=green2.mp4&worker=http://w"]),
        ))
        s.commit()

    async def _fake_fetch(url, dest):
        dest.write_bytes(_MP4)

    monkeypatch.setattr(upscale_svc, "_fetch_source_local", _fake_fetch)
    url = "/api/images?filename=green2.mp4&subfolder=&type=output&worker=http://w"
    r = client.post(
        "/api/video/chromakey", headers={**_h(token), "X-NSFW": "1"},
        json={"foreground_url": url},
    )
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "chromakey")).first()
    assert job.nsfw is True


# ---------------------------------------------------------------------------
# ffmpeg 错误
# ---------------------------------------------------------------------------


def test_ffmpeg_failure_500(ctx, monkeypatch, tmp_path):
    """ffmpeg 非零退出 → 500,detail 带 stderr 尾部。"""
    client, token, *_ = ctx
    _patch_storage(monkeypatch, tmp_path)
    recorded: dict = {}
    _patch_pipeline(monkeypatch, tmp_path, recorded)

    async def _bad_run(cmd, timeout=0.0):
        raise FFmpegError("ffmpeg 失败(code=1): Error opening output file: tail-xyz")

    monkeypatch.setattr(ck, "run_ffmpeg", _bad_run)
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path)},
    )
    assert r.status_code == 500
    assert "tail-xyz" in r.json()["detail"]


def test_ffmpeg_missing_500(ctx, monkeypatch, tmp_path):
    """ffmpeg 未安装 → 500。"""
    client, token, *_ = ctx
    _patch_storage(monkeypatch, tmp_path)
    recorded: dict = {}
    _patch_pipeline(monkeypatch, tmp_path, recorded)

    def _no_ffmpeg():
        raise FFmpegError("服务端未安装 ffmpeg")

    monkeypatch.setattr(ck, "ensure_ffmpeg", _no_ffmpeg)
    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": _fg_url(tmp_path)},
    )
    assert r.status_code == 500
    assert "ffmpeg" in r.json()["detail"]


# ---------------------------------------------------------------------------
# 产物服务端点
# ---------------------------------------------------------------------------


def test_output_endpoint_range_and_guards(ctx, monkeypatch, tmp_path):
    client, token, *_ = ctx
    _patch_storage(monkeypatch, tmp_path)
    out_dir = tmp_path / "ck_out"
    out_dir.mkdir(parents=True)
    name = "chromakey-" + "b" * 32 + ".mp4"
    (out_dir / name).write_bytes(_MP4)

    r = client.get(f"/api/video/chromakey/output/{name}", headers=_h(token))
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.headers["Content-Type"] == "video/mp4"

    r2 = client.get(
        f"/api/video/chromakey/output/{name}",
        headers={**_h(token), "Range": "bytes=0-7"},
    )
    assert r2.status_code == 206
    assert r2.headers["Content-Range"].startswith("bytes 0-7/")

    r3 = client.get("/api/video/chromakey/output/..%2F..%2Fetc", headers=_h(token))
    assert r3.status_code in (400, 404, 422)

    r4 = client.get(
        "/api/video/chromakey/output/chromakey-" + "c" * 32 + ".mp4", headers=_h(token)
    )
    assert r4.status_code == 404


# ---------------------------------------------------------------------------
# 真 ffmpeg e2e(有 ffmpeg 时)
# ---------------------------------------------------------------------------


@pytest.mark.skipif(
    shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None,
    reason="ffmpeg/ffprobe 不可用",
)
def test_real_ffmpeg_chromakey_e2e(ctx, monkeypatch, tmp_path):
    """真链路:绿色视频抠像叠红底 → 出片可 ffprobe,尺寸与源一致。"""
    import subprocess

    client, token, engine, uid, tmp_path = ctx
    _patch_storage(monkeypatch, tmp_path)
    (tmp_path / "ck_out").mkdir(parents=True, exist_ok=True)

    # 造源:64x64 纯绿 5 帧短视频(绿幕主体为零 —— 验证滤镜可跑通即可)
    src = _fg_url(tmp_path)
    src_path = tmp_path / src.rsplit("/", 1)[-1]
    subprocess.run(
        ["ffmpeg", "-y", "-f", "lavfi", "-i",
         "color=c=0x00FF00:s=64x64:d=0.2:r=5",
         "-pix_fmt", "yuv420p", str(src_path)],
        check=True, capture_output=True,
    )

    r = client.post(
        "/api/video/chromakey", headers=_h(token),
        json={"foreground_url": src, "background_color": "red"},
    )
    assert r.status_code == 200, r.text
    data = r.json()
    out_name = data["url"].rsplit("/", 1)[-1]
    out_path = tmp_path / "ck_out" / out_name
    assert out_path.is_file() and out_path.stat().st_size > 0

    probe = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height", "-of", "csv=p=0", str(out_path)],
        check=True, capture_output=True, text=True,
    )
    assert probe.stdout.strip() == "64,64"

    # 产物可回读 + Job 建档
    r2 = client.get(data["url"], headers=_h(token))
    assert r2.status_code == 200
    with Session(engine) as s:
        job = s.exec(select(Job).where(Job.kind == "chromakey")).first()
    assert job is not None and job.status == "done"
