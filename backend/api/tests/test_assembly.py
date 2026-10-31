"""漫剧/短剧合成链 assembly 单测。

- _build_ffmpeg_command:preset/crf 编码参数、转场(none concat / crossfade xfade)、
  字幕(drawtext / Pillow overlay 降级)、BGM ducking(sidechaincompress)开关差异。
- _download_all:gather 并发(Semaphore 限流)、结果顺序、单失败传播。
- _download_clip:同源本地产物走文件拷贝(to_thread),不经 HTTP。
- _run_ffmpeg:超时 kill 进程并抛错;非零退出带 stderr 尾。
- _kenburns_filter / _escape_drawtext / _subtitle_filter:纯函数覆盖。
- POST /api/manju/assemble、/api/manju/kenburns:mock 下载与 ffmpeg 的成功/校验路径。
"""
from __future__ import annotations

import asyncio
import re
from pathlib import Path

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes import assembly
from app.routes.assembly import (
    AssembleOptions,
    _build_ffmpeg_command,
    _download_all,
    _download_clip,
    _escape_drawtext,
    _kenburns_filter,
    _run_ffmpeg,
    _subtitle_filter,
)
from app.security import create_token, hash_password

_MP4 = b"\x00\x00\x00\x18ftypmp42"


# ────────────────────────────────
# ffmpeg 命令构造(纯函数)
# ────────────────────────────────

def _cmd(n: int, options, bgm=None, voices=None, durations=None, targets=None,
         dims=(1280, 720), out=Path("/t/out.mp4"), clip_audio=None):
    return _build_ffmpeg_command(
        [Path(f"/t/clip-{i:03d}.mp4") for i in range(n)],
        options,
        bgm,
        voices if voices is not None else [None] * n,
        durations if durations is not None else [2.0] * n,
        targets if targets is not None else [],
        dims,
        out,
        clip_audio=clip_audio,
    )


def _filtergraph(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def test_build_cmd_has_x264_preset_crf():
    cmd = _cmd(2, AssembleOptions())
    assert cmd[cmd.index("-preset") + 1] == "veryfast"
    assert cmd[cmd.index("-crf") + 1] == "20"
    assert "-c:v" in cmd and "libx264" in cmd
    # 无配音无 BGM:不出音轨参数
    assert "-c:a" not in cmd


def test_build_cmd_transition_none_concat():
    cmd = _cmd(3, AssembleOptions(transition="none"))
    assert "concat=n=3:v=1:a=0[vout]" in _filtergraph(cmd)
    assert "xfade" not in _filtergraph(cmd)


def test_build_cmd_crossfade_xfade():
    cmd = _cmd(2, AssembleOptions(transition="crossfade"), durations=[2.0, 3.0])
    fc = _filtergraph(cmd)
    assert "xfade=transition=fade:duration=0.5" in fc
    # offset 用上一镜实际时长 - 交叠时长,精确不漂移
    assert "offset=1.50" in fc
    assert "concat=n=" not in fc


def test_build_cmd_subtitles_drawtext_when_available(monkeypatch):
    monkeypatch.setattr("app.routes.assembly._HAS_DRAWTEXT", True)
    cmd = _cmd(1, AssembleOptions(subtitles=["第一句台词"], sub_size=32))
    fc = _filtergraph(cmd)
    assert "drawtext=" in fc
    assert "fontsize=32" in fc
    assert "overlay=" not in fc


def test_build_cmd_pillow_overlay_fallback(monkeypatch, tmp_path):
    """drawtext 不可用 → Pillow 渲染 PNG + overlay,PNG 作为额外输入。"""
    monkeypatch.setattr("app.routes.assembly._HAS_DRAWTEXT", False)
    png = tmp_path / "sub.png"
    png.write_bytes(b"png")
    render_calls: list = []

    def fake_render(text, options, width):
        render_calls.append((text, width))
        return png

    monkeypatch.setattr("app.routes.assembly._render_subtitle_png", fake_render)
    cmd = _cmd(2, AssembleOptions(subtitles=["你好", ""]))
    fc = _filtergraph(cmd)
    assert "drawtext" not in fc
    assert "overlay=x=(W-w)/2" in fc
    # 只有第 0 镜有字幕 → 只渲染一张 PNG,作为额外 -i 输入
    assert render_calls == [("你好", 1280)]
    assert str(png) in cmd
    # 带字幕的镜用 overlay 后的 label 参与 concat
    assert "[v0sub][v1]concat=n=2" in fc


def test_build_cmd_bgm_duck_sidechain():
    voices = [Path("/t/voice-000.wav"), None]
    cmd = _cmd(2, AssembleOptions(duck=True), bgm=Path("/t/bgm.mp3"), voices=voices)
    fc = _filtergraph(cmd)
    assert "sidechaincompress" in fc
    assert "adelay=0|0" in fc  # 第 0 镜配音偏移 0
    assert "-c:a" in cmd

    cmd2 = _cmd(2, AssembleOptions(duck=False), bgm=Path("/t/bgm.mp3"), voices=voices)
    assert "sidechaincompress" not in _filtergraph(cmd2)


def test_build_cmd_voice_offsets_align():
    """配音按片段起始偏移对齐(逐镜 adelay)。"""
    voices = [Path("/t/v0.wav"), Path("/t/v1.wav")]
    cmd = _cmd(2, AssembleOptions(), voices=voices, durations=[2.0, 3.0])
    fc = _filtergraph(cmd)
    assert "adelay=0|0" in fc
    assert "adelay=2000|2000" in fc
    assert "amix=inputs=2" in fc


def test_build_cmd_grade_and_trim():
    opt = AssembleOptions(grade="bw")
    cmd = _cmd(1, opt, targets=[1.5])
    fc = _filtergraph(cmd)
    assert "hue=s=0" in fc  # 调色滤镜接入
    assert "trim=0:1.50" in fc  # 时间线裁切


# ────────────────────────────────
# P1-a:片段内嵌音轨保留(clip_audio)
# ────────────────────────────────

def test_build_cmd_embedded_audio_chain():
    """无配音无 BGM + clip_audio=[True,False,True] → anullsrc 补偿 + concat a=1 + 映射 aout。"""
    cmd = _cmd(
        3, AssembleOptions(transition="none"),
        durations=[2.0, 2.0, 3.0], clip_audio=[True, False, True],
    )
    fc = _filtergraph(cmd)
    # 无音轨的第 1 镜补 anullsrc 静音 lavfi 输入(以 -f lavfi -i 形式入参)
    # anullsrc 选项为 channel_layout(单数),真机 ffmpeg 已验证可解析
    assert "-f" in cmd and "lavfi" in cmd
    assert any("anullsrc=channel_layout=stereo:sample_rate=44100" in a for a in cmd)
    # 有音轨片段:atrim 截齐 + aresample 归一;无音轨片段:anullsrc 输入 atrim 截齐
    assert "[0:a]atrim=0:2.00,asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo[a0]" in fc
    assert ":a]atrim=0:2.00,asetpts=PTS-STARTPTS[a1]" in fc
    assert "[2:a]atrim=0:3.00,asetpts=PTS-STARTPTS,aresample=44100,aformat=channel_layouts=stereo[a2]" in fc
    # concat 带音频 + 映射 [aout] + aac 编码参数
    assert "concat=n=3:v=1:a=1[vout][aout]" in fc
    maps = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
    assert "[aout]" in maps
    assert "-c:a" in cmd and "aac" in cmd


def test_build_cmd_embedded_audio_all_silent_noop():
    """clip_audio 全 False(无任何音轨)→ 旧行为:concat 不带音频。"""
    cmd = _cmd(2, AssembleOptions(), clip_audio=[False, False])
    assert "concat=n=2:v=1:a=0[vout]" in _filtergraph(cmd)
    assert "-c:a" not in cmd


def test_build_cmd_clip_audio_none_keeps_legacy():
    """clip_audio=None(默认)→ 旧行为不变(concat 不带音频,不出音轨参数)。"""
    cmd = _cmd(2, AssembleOptions(), clip_audio=None)
    assert "concat=n=2:v=1:a=0[vout]" in _filtergraph(cmd)
    assert "-c:a" not in cmd


def test_build_cmd_voice_overrides_embedded():
    """有配音 + clip_audio 提供 → 旧行为:配音链照旧,内嵌音轨不映射、不补 anullsrc。"""
    voices = [Path("/t/v0.wav"), None]
    cmd = _cmd(2, AssembleOptions(), voices=voices, clip_audio=[True, True])
    fc = _filtergraph(cmd)
    assert not any("anullsrc" in a for a in cmd)
    assert "concat=n=2:v=1:a=0[vout]" in fc
    assert "adelay=0|0" in fc  # 配音链照旧
    # 映射的是配音混出的 [aout],与内嵌音轨无关
    assert "amix" in fc or "[aout]" in fc


def test_build_cmd_crossfade_drops_embedded_with_warning(caplog):
    """crossfade + 内嵌音轨 → 保持旧行为(xfade 丢音轨)+ 记 warning。"""
    import logging

    with caplog.at_level(logging.WARNING, logger="app.routes.assembly"):
        cmd = _cmd(
            2, AssembleOptions(transition="crossfade"),
            durations=[2.0, 3.0], clip_audio=[True, True],
        )
    fc = _filtergraph(cmd)
    assert "xfade" in fc
    assert "concat" not in fc
    assert not any("anullsrc" in a for a in cmd)
    assert "-c:a" not in cmd
    assert any("内嵌音轨" in r.message for r in caplog.records)


# ────────────────────────────────
# KenBurns / 字幕纯函数
# ────────────────────────────────

def test_kenburns_filter_motions():
    f_in = _kenburns_filter("zoom-in", 60, 832, 480, 30)
    assert "z='1+0.18*on/59'" in f_in
    assert "zoompan" in f_in and "s=832x480" in f_in and "fps=30" in f_in

    f_left = _kenburns_filter("pan-left", 60, 832, 480, 30)
    assert "(1-on/59)" in f_left

    f_out = _kenburns_filter("zoom-out", 60, 832, 480, 30)
    assert "z='1.18-0.18*on/59'" in f_out

    # 未知 motion 回落 zoom-in
    assert _kenburns_filter("bogus", 60, 832, 480, 30) == f_in


def test_escape_drawtext():
    assert _escape_drawtext("a:b,c;d") == "a\\:b\\,c\\;d"
    assert _escape_drawtext("it's") == "it’s"  # 单引号换排版引号
    assert _escape_drawtext("多\n行") == "多 行"


def test_subtitle_filter_empty_returns_empty():
    assert _subtitle_filter("   ", AssembleOptions()) == ""


def test_subtitle_filter_positions():
    assert "y=40" in _subtitle_filter("hi", AssembleOptions(sub_pos="top"))
    assert "y=(h-text_h)/2" in _subtitle_filter("hi", AssembleOptions(sub_pos="center"))
    assert "y=h-text_h-40" in _subtitle_filter("hi", AssembleOptions(sub_pos="bottom"))
    # sub_box 开关:描边盒 vs 文字描边
    assert "box=1" in _subtitle_filter("hi", AssembleOptions(sub_box=True))
    assert "borderw=2" in _subtitle_filter("hi", AssembleOptions(sub_box=False))


# ────────────────────────────────
# 并发下载
# ────────────────────────────────

async def test_download_all_concurrent_and_ordered(monkeypatch, tmp_path):
    running = 0
    max_running = 0

    async def fake_download(client, url, dest):
        nonlocal running, max_running
        running += 1
        max_running = max(max_running, running)
        # 乱序完成:后面的片段先返回,验证结果仍按索引落位
        await asyncio.sleep(0.02 * ((7 - int(url)) % 3 + 1))
        dest.write_text(url)
        running -= 1

    monkeypatch.setattr("app.routes.assembly._download_clip", fake_download)
    items = [(str(i), tmp_path / f"f{i}") for i in range(8)]
    await _download_all(None, items)  # client 未被 fake 使用

    assert 1 < max_running <= assembly._DOWNLOAD_CONCURRENCY
    for url, dest in items:
        assert dest.read_text() == url


async def test_download_all_failure_propagates(monkeypatch, tmp_path):
    async def fake_download(client, url, dest):
        if url == "bad":
            raise HTTPException(status_code=502, detail="片段下载失败:bad")
        dest.write_text(url)

    monkeypatch.setattr("app.routes.assembly._download_clip", fake_download)
    items = [("ok1", tmp_path / "a"), ("bad", tmp_path / "b"), ("ok2", tmp_path / "c")]
    with pytest.raises(HTTPException) as exc:
        await _download_all(None, items)
    assert exc.value.status_code == 502
    assert "片段下载失败" in exc.value.detail


async def test_download_clip_local_copy(monkeypatch, tmp_path):
    """同源 manju 产物直接本地拷贝(to_thread copyfile),不经 HTTP。"""
    out_dir = tmp_path / "out"
    out_dir.mkdir()
    name = "manju-" + "a" * 32 + ".mp4"
    (out_dir / name).write_bytes(_MP4)
    monkeypatch.setattr("app.routes.assembly._OUTPUT_DIR", out_dir)

    copy_calls: list = []
    real_copyfile = assembly.shutil.copyfile

    def spy_copyfile(src, dst):
        copy_calls.append((Path(src).name, Path(dst).name))
        return real_copyfile(src, dst)

    monkeypatch.setattr("app.routes.assembly.shutil.copyfile", spy_copyfile)
    dest = tmp_path / "clip-000.mp4"
    await _download_clip(None, f"/api/manju/output/{name}", dest)  # client 不应被使用
    assert dest.read_bytes() == _MP4
    assert copy_calls == [(name, "clip-000.mp4")]


# ────────────────────────────────
# _run_ffmpeg:超时 / 非零退出
# ────────────────────────────────

class _HungProc:
    """模拟挂起的 ffmpeg:communicate 永不返回。"""

    def __init__(self):
        self.returncode = None
        self.killed = False
        self.waited = False

    async def communicate(self):
        await asyncio.sleep(3600)
        return b"", b""

    def kill(self):
        self.killed = True
        self.returncode = -9

    async def wait(self):
        self.waited = True
        return self.returncode


class _FailProc:
    returncode = 1

    async def communicate(self):
        return b"", b"x" * 900 + b"boom-tail"


async def test_run_ffmpeg_timeout_kills_process(monkeypatch):
    proc = _HungProc()

    async def fake_exec(*args, **kwargs):
        return proc

    monkeypatch.setattr("app.routes.assembly.asyncio.create_subprocess_exec", fake_exec)
    with pytest.raises(HTTPException) as exc:
        await _run_ffmpeg(["ffmpeg", "-y"], timeout=0.05)
    assert exc.value.status_code == 500
    assert "超时" in exc.value.detail
    assert proc.killed and proc.waited


async def test_run_ffmpeg_nonzero_raises_with_stderr_tail(monkeypatch):
    async def fake_exec(*args, **kwargs):
        return _FailProc()

    monkeypatch.setattr("app.routes.assembly.asyncio.create_subprocess_exec", fake_exec)
    with pytest.raises(HTTPException) as exc:
        await _run_ffmpeg(["ffmpeg", "-y"])
    assert exc.value.status_code == 500
    assert "boom-tail" in exc.value.detail  # stderr 尾 800 字符随 detail 返回


# ────────────────────────────────
# POST /api/manju/assemble、/api/manju/kenburns(mock 下载 + ffmpeg)
# ────────────────────────────────

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


@pytest.fixture()
def ctx(tmp_path, monkeypatch):
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    with Session(engine) as s:
        uid = _make_user(s, "asm@toiv.ai")

    out = tmp_path / "outputs"
    monkeypatch.setattr("app.routes.assembly._OUTPUT_DIR", out)
    monkeypatch.setattr(
        "app.routes.assembly.enforce_generation_rate_limit", lambda *a, **k: None
    )
    monkeypatch.setattr("app.routes.assembly.shutil.which", lambda c: "/usr/bin/ffmpeg")
    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}, out
    app.dependency_overrides.clear()


def _mock_pipeline(monkeypatch, captured: dict):
    async def fake_download_all(client, items):
        captured["downloads"] = list(items)
        for _, dest in items:
            dest.write_bytes(_MP4)

    async def fake_probe(path):
        return 2.0

    async def fake_ffmpeg(cmd, timeout=300.0):
        captured.setdefault("cmds", []).append(cmd)
        Path(cmd[-1]).write_bytes(_MP4)

    monkeypatch.setattr("app.routes.assembly._download_all", fake_download_all)
    monkeypatch.setattr("app.routes.assembly._probe_duration", fake_probe)
    monkeypatch.setattr("app.routes.assembly._run_ffmpeg", fake_ffmpeg)


def test_assemble_success(ctx, monkeypatch):
    client, auth, out = ctx
    captured: dict = {}
    _mock_pipeline(monkeypatch, captured)

    r = client.post(
        "/api/manju/assemble",
        json={
            "clips": ["/media/a.mp4", "/media/b.mp4"],
            "voice_urls": ["/media/v0.wav", ""],
            "options": {"transition": "crossfade", "title": "序章"},
        },
        headers=auth,
    )
    assert r.status_code == 200, r.text
    data = r.json()
    assert re.fullmatch(r"manju-[0-9a-f]{32}\.mp4", data["name"])
    assert data["url"] == f"/api/manju/output/{data['name']}"
    assert (out / data["name"]).is_file()

    # 片段 + 配音统一一次并发下载,顺序与索引对应(空串配音跳过)
    urls = [u for u, _ in captured["downloads"]]
    assert urls == ["/media/a.mp4", "/media/b.mp4", "/media/v0.wav"]

    # 有片头卡:正片 + 卡 + concat 共 3 次 ffmpeg
    assert len(captured["cmds"]) == 3
    film_cmd = captured["cmds"][0]
    assert film_cmd[film_cmd.index("-preset") + 1] == "veryfast"
    assert "xfade" in film_cmd[film_cmd.index("-filter_complex") + 1]


def test_assemble_no_bookends_single_ffmpeg(ctx, monkeypatch):
    client, auth, out = ctx
    captured: dict = {}
    _mock_pipeline(monkeypatch, captured)
    r = client.post(
        "/api/manju/assemble",
        json={"clips": ["/media/a.mp4", "/media/b.mp4"]},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert len(captured["cmds"]) == 1  # 无片头片尾直接出成片


def test_assemble_bad_transition_422(ctx):
    client, auth, _ = ctx
    r = client.post(
        "/api/manju/assemble",
        json={"clips": ["/media/a.mp4"], "options": {"transition": "zoom"}},
        headers=auth,
    )
    assert r.status_code == 422
    assert "转场" in r.json()["detail"]


def test_assemble_clip_not_whitelisted_400(ctx):
    client, auth, _ = ctx
    r = client.post(
        "/api/manju/assemble",
        json={"clips": ["http://evil.example.com/x.mp4"]},
        headers=auth,
    )
    assert r.status_code == 400
    assert "白名单" in r.json()["detail"]


def test_assemble_unauthenticated_401(ctx):
    client, _, _ = ctx
    r = client.post("/api/manju/assemble", json={"clips": ["/media/a.mp4"]})
    assert r.status_code == 401


def test_kenburns_success(ctx, monkeypatch, tmp_path):
    client, auth, out = ctx
    captured: dict = {}

    async def fake_download(client, url, dest):
        dest.write_bytes(b"\x89PNG\r\n\x1a\n")

    async def fake_ffmpeg(cmd, timeout=300.0):
        captured.setdefault("cmds", []).append(cmd)
        Path(cmd[-1]).write_bytes(_MP4)

    monkeypatch.setattr("app.routes.assembly._download_clip", fake_download)
    monkeypatch.setattr("app.routes.assembly._run_ffmpeg", fake_ffmpeg)
    r = client.post(
        "/api/manju/kenburns",
        json={"image_url": "/media/img.png", "duration": 3.0, "motion": "pan-left"},
        headers=auth,
    )
    assert r.status_code == 200, r.text
    assert re.fullmatch(r"manju-[0-9a-f]{32}\.mp4", r.json()["name"])
    cmd = captured["cmds"][0]
    assert cmd[cmd.index("-preset") + 1] == "veryfast"
    assert cmd[cmd.index("-crf") + 1] == "20"
    assert "zoompan" in cmd[cmd.index("-vf") + 1]


def test_kenburns_bad_motion_422(ctx):
    client, auth, _ = ctx
    r = client.post(
        "/api/manju/kenburns",
        json={"image_url": "/media/img.png", "motion": "spin"},
        headers=auth,
    )
    assert r.status_code == 422
