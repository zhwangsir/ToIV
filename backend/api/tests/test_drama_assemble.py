"""短剧一键合成(POST /drama/projects/{pid}/assemble)参数继承与内嵌音轨测试(P1-a/P1-b)。

覆盖:
  ⑤ aspect="auto"(新默认)→ 输出尺寸取项目宽高(奇数取偶兜底);
    fps=0(新默认)→ 继承项目 fps
  ⑥ 端点级:默认值调用(mock 下载/ffprobe/ffmpeg),断言 ffmpeg 命令的 scale/fps 来自项目,
    且片段带内嵌音轨时 concat 带音频、映射 [aout]
  · 显式 aspect/fps 旧值行为不变;片段无内嵌音轨时保持旧行为(concat a=0)

不触真 ffmpeg:下载/_probe_duration/_probe_has_audio/_run_ffmpeg 全部 mock。
"""
from __future__ import annotations

import re
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.routes.drama_studio as drama_studio_route
from app.db import get_session
from app.main import app
from app.models import DramaProject, DramaShot, Tenant, User
from app.security import create_token, hash_password

_MP4 = b"\x00\x00\x00\x18ftypmp42"


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
    with Session(engine) as s:
        tenant = Tenant(name="asm")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(
            email="asm@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=tenant.id,
        )
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        # 项目 1344×768@24(dogfood 实测项目参数);两个已完成分镜视频
        project = DramaProject(
            tenant_id=tenant.id, user_id=uid, title="合成继承",
            width=1344, height=768, fps=24,
        )
        s.add(project)
        s.commit()
        s.refresh(project)
        for i in range(2):
            s.add(DramaShot(
                project_id=project.id, idx=i, prompt=f"shot{i}",
                duration_sec=5, video_status="done",
                video_url=f"/media/clip{i}.mp4",
            ))
        s.commit()
        pid = project.id
    yield TestClient(app), create_token(uid), engine, pid, tmp_path
    app.dependency_overrides.clear()


def _h(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def _mock_pipeline(monkeypatch, tmp_path: Path, captured: dict, clip_audio: bool = True) -> None:
    """mock _do_assemble 的外部副作用:成片目录/ffmpeg 查找/下载/探测/执行,capture ffmpeg 命令。"""
    monkeypatch.setattr(drama_studio_route, "_drama_dir", lambda: tmp_path)
    monkeypatch.setattr(drama_studio_route.shutil, "which", lambda c: "/usr/bin/ffmpeg")

    async def fake_download(client, url, dest):
        dest.write_bytes(_MP4)

    async def fake_probe_duration(path):
        return 5.0

    async def fake_has_audio(path):
        return clip_audio

    async def fake_ffmpeg(cmd, timeout=300.0):
        captured.setdefault("cmds", []).append(cmd)
        Path(cmd[-1]).write_bytes(_MP4)

    # _do_assemble 在函数体内 from app.routes.assembly import ... → patch 源模块属性生效
    monkeypatch.setattr("app.routes.assembly._download_clip", fake_download)
    monkeypatch.setattr("app.routes.assembly._probe_duration", fake_probe_duration)
    monkeypatch.setattr("app.routes.assembly._run_ffmpeg", fake_ffmpeg)
    monkeypatch.setattr(drama_studio_route, "_probe_has_audio", fake_has_audio)


def _filtergraph(cmd: list[str]) -> str:
    return cmd[cmd.index("-filter_complex") + 1]


def test_assemble_defaults_inherit_project_dims_fps(ctx, monkeypatch):
    """⑤⑥:aspect/fps 缺省(auto/0)→ 继承项目 1344×768@24;内嵌音轨保留(concat a=1 + aout)。"""
    client, token, _, pid, tmp_path = ctx
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)

    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    assert re.fullmatch(r"drama-[0-9a-f]{32}\.mp4", r.json()["name"])
    assert len(captured["cmds"]) == 1  # 无片头片尾卡:单次 ffmpeg

    cmd = captured["cmds"][0]
    fc = _filtergraph(cmd)
    # dims 来自项目 1344×768(aspect="auto"),fps 来自项目 24(fps=0 继承)
    assert "scale=1344:768" in fc
    assert "crop=1344:768" in fc
    assert "fps=24" in fc
    assert cmd[cmd.index("-r") + 1] == "24"
    # 内嵌音轨保留:concat 带音频 + 映射 [aout] + aac 编码
    assert "concat=n=2:v=1:a=1[vout][aout]" in fc
    maps = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
    assert "[aout]" in maps
    assert "-c:a" in cmd and "aac" in cmd


def test_assemble_auto_odd_dims_rounded_even(ctx, monkeypatch):
    """⑤:aspect="auto" 时项目奇数宽高向下取偶(yuv420p 要求),缺省不落 16:9。"""
    client, token, engine, _, tmp_path = ctx
    # 直接插一个奇数尺寸项目(绕过 ProjectIn 校验,覆盖线上历史数据情形)
    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "asm@toiv.ai")).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="奇数尺寸",
            width=1345, height=767, fps=24,
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        s.add(DramaShot(
            project_id=p.id, idx=0, prompt="x", duration_sec=5,
            video_status="done", video_url="/media/odd.mp4",
        ))
        s.commit()
        pid = p.id

    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)
    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    fc = _filtergraph(captured["cmds"][0])
    assert "scale=1344:766" in fc  # 1345→1344,767→766
    assert "crop=1344:766" in fc


def test_assemble_explicit_aspect_fps_unchanged(ctx, monkeypatch):
    """显式 aspect="9:16"/fps=10 → 旧行为(预设尺寸 + 指定帧率),不受 auto 影响。"""
    client, token, _, pid, tmp_path = ctx
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)

    r = client.post(
        f"/api/drama/projects/{pid}/assemble",
        headers=_h(token),
        json={"aspect": "9:16", "fps": 10},
    )
    assert r.status_code == 200, r.text
    cmd = captured["cmds"][0]
    fc = _filtergraph(cmd)
    assert "scale=720:1280" in fc
    assert "fps=10" in fc
    assert cmd[cmd.index("-r") + 1] == "10"


def test_assemble_no_embedded_audio_legacy(ctx, monkeypatch):
    """片段无内嵌音轨(探测全 False)→ 旧行为:concat a=0,不映射音轨、不补 anullsrc。"""
    client, token, _, pid, tmp_path = ctx
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=False)

    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    cmd = captured["cmds"][0]
    fc = _filtergraph(cmd)
    assert "concat=n=2:v=1:a=0[vout]" in fc
    assert not any("anullsrc" in a for a in cmd)
    assert "-c:a" not in cmd


# ---------------------------------------------------------------------------
# P1 衔接策略层:接缝级转场(overlap → xfade+acrossfade,其余声明接缝硬切)
# ---------------------------------------------------------------------------

def _make_seam_project(engine, seams: list[str]) -> str:
    """建 24fps 项目 + len(seams)+1 个 done 分镜,逐镜写 seam_to_next,返回 pid。"""
    with Session(engine) as s:
        user = s.exec(select(User).where(User.email == "asm@toiv.ai")).first()
        p = DramaProject(
            tenant_id=user.tenant_id, user_id=user.id, title="接缝",
            width=1344, height=768, fps=24,
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        for i in range(len(seams) + 1):
            s.add(DramaShot(
                project_id=p.id, idx=i, prompt=f"shot{i}",
                duration_sec=5, video_status="done",
                video_url=f"/media/clip{i}.mp4",
                seam_to_next=seams[i] if i < len(seams) else "",
            ))
        s.commit()
        return p.id


def test_overlap_xfade_sec_clamp():
    """时长折算:12-18 帧(中值 15)按 fps 折算,clamp 0.4-0.75s。"""
    from app.routes.assembly import _overlap_xfade_sec

    assert _overlap_xfade_sec(24) == 15 / 24  # 0.625,区间内不 clamp
    assert _overlap_xfade_sec(30) == 0.5
    assert _overlap_xfade_sec(16) == 0.75  # 15/16=0.9375 → 上限
    assert _overlap_xfade_sec(60) == 0.4  # 15/60=0.25 → 下限


def test_assemble_mixed_seams_xfade_and_hardcut(ctx, monkeypatch):
    """P1:overlap 接缝 xfade+acrossfade(同 duration),hardcut 接缝保持 concat;内嵌音轨配对。"""
    client, token, engine, _, tmp_path = ctx
    pid = _make_seam_project(engine, ["overlap", "hardcut"])
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)

    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    assert len(captured["cmds"]) == 1
    cmd = captured["cmds"][0]
    fc = _filtergraph(cmd)
    d = 15 / 24  # fps=24 → 0.625s
    # 接缝1(overlap):xfade 交叠,offset = 首镜时长 - 交叠时长;音轨 acrossfade 同 duration
    assert f"xfade=transition=fade:duration={d:.2f}:offset={5.0 - d:.2f}[xf1]" in fc
    assert f"acrossfade=d={d:.2f}" in fc
    # 接缝2(hardcut):视频/音轨均 concat 硬切
    assert "concat=n=2:v=1:a=0[cc2]" in fc
    assert "concat=n=2:v=0:a=1[ac2]" in fc
    # 映射混排链末端 + aac 编码
    maps = [cmd[i + 1] for i, a in enumerate(cmd) if a == "-map"]
    assert "[cc2]" in maps and "[ac2]" in maps
    assert "-c:a" in cmd and "aac" in cmd


def test_assemble_overlap_seam_silent_clip_anullsrc(ctx, monkeypatch):
    """P1:overlap 接缝中无音轨片段补 anullsrc 静音(stereo/44.1k),acrossfade 链不断。"""
    client, token, engine, _, tmp_path = ctx
    pid = _make_seam_project(engine, ["overlap"])
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)

    async def fake_has_audio(path):  # 第二镜无内嵌音轨
        return "clip-000" in str(path)

    monkeypatch.setattr(drama_studio_route, "_probe_has_audio", fake_has_audio)

    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    cmd = captured["cmds"][0]
    fc = _filtergraph(cmd)
    assert any("anullsrc=channel_layout=stereo" in a for a in cmd)
    assert "acrossfade" in fc


def test_assemble_declared_cut_seams_no_xfade(ctx, monkeypatch):
    """P1:全部已声明非 overlap 接缝(continue/matchcut/hardcut)→ 纯硬切,无 xfade/acrossfade。"""
    client, token, engine, _, tmp_path = ctx
    pid = _make_seam_project(engine, ["continue", "matchcut"])
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=False)

    r = client.post(f"/api/drama/projects/{pid}/assemble", headers=_h(token), json={})
    assert r.status_code == 200, r.text
    fc = _filtergraph(captured["cmds"][0])
    assert "xfade" not in fc and "acrossfade" not in fc
    assert "concat=n=2:v=1:a=0[cc1]" in fc
    assert "concat=n=2:v=1:a=0[cc2]" in fc


def test_assemble_undeclared_seam_falls_back_global_crossfade(ctx, monkeypatch):
    """P1 向后兼容:全局 transition=crossfade 时未声明接缝沿用 0.5s xfade;声明 overlap 用折算时长。"""
    client, token, engine, _, tmp_path = ctx
    pid = _make_seam_project(engine, ["overlap", ""])
    captured: dict = {}
    _mock_pipeline(monkeypatch, tmp_path, captured, clip_audio=True)

    r = client.post(
        f"/api/drama/projects/{pid}/assemble",
        headers=_h(token), json={"transition": "crossfade"},
    )
    assert r.status_code == 200, r.text
    fc = _filtergraph(captured["cmds"][0])
    d = 15 / 24
    # 接缝1(overlap):折算 0.625s;接缝2(未声明):沿用全局 0.5s
    assert f"duration={d:.2f}" in fc
    assert "duration=0.50" in fc
    # 两接缝全 xfade:无硬切 concat
    assert "concat=n=2:v=1:a=0" not in fc
