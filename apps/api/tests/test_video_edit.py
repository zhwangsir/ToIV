"""视频编辑 /api/video-edit 单测。

- parse_plan: JSON/范围/类型/越界/奇数取偶/总时长/层级校验 → 422, 合法最小 plan → dict。
- build_render_plan_cmd: 单 clip/多 clip + audio + text / -an / drawtext 转义 / 路径空格引号。
- POST render: 未认证 401 / 非法 plan 422 / 空 media 422 / 穿越文件名 422 / 非法格式 422 /
  超量 422 / 空文件 422 / 成功路径(模拟 ssh + NAS 落盘) / ffmpeg 失败 502 且清理 /
  ffprobe 失败降级。
- GET output: 白名单 404 / 缺失 404 / 存在 200 video/mp4。
"""
from __future__ import annotations

import json
import re
import shlex
import subprocess
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.routes.video_edit import (
    _escape_drawtext,
    build_render_plan_cmd,
    parse_plan,
)
from app.security import create_token, hash_password

_MP4 = b"\x00\x00\x00\x18ftypmp42"
_MP3 = b"\xff\xfb" + b"\x00" * 32


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
        uid = _make_user(s, "ve@toiv.ai")

    imp = tmp_path / "imports"
    out = tmp_path / "outputs"
    monkeypatch.setattr("app.routes.video_edit._IMPORT_DIR", imp)
    monkeypatch.setattr("app.routes.video_edit._OUTPUT_DIR", out)
    monkeypatch.setattr("app.routes.video_edit._WS_IMPORT_DIR", "/ws/imports")
    monkeypatch.setattr("app.routes.video_edit._WS_OUTPUT_DIR", "/ws/outputs")
    monkeypatch.setattr("app.routes.video_edit._SSH_TARGET", "merlin@192.168.71.127")
    monkeypatch.setattr(
        "app.routes.video_edit.enforce_generation_rate_limit", lambda *a, **k: None
    )
    yield TestClient(app), {"Authorization": f"Bearer {create_token(uid)}"}, imp, out
    app.dependency_overrides.clear()


def _fake_run_ok(out_dir: Path, captured: list):
    """模拟 ssh: ffprobe 返回 1\n0\n; ffmpeg 在 out_dir 造同名成片。"""
    def fake_run(cmd, **kwargs):
        captured.append(cmd)
        remote = cmd[-1]
        if "ffprobe" in remote:
            return subprocess.CompletedProcess(cmd, 0, "1\n0\n", "")
        # ffmpeg
        last = remote.rsplit(None, 1)[-1].strip("'\"")
        name = Path(last).name
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / name).write_bytes(b"\x00\x00\x00\x18ftypmp42")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    return fake_run


def _fake_run_fail(cmd, **kwargs):
    return subprocess.CompletedProcess(cmd, 1, "", "x" * 600 + "boom-tail")


def _post(client, auth, files, data):
    return client.post("/api/video-edit/render", files=files, data=data, headers=auth)


# ────────────────────────────────
# parse_plan 校验
# ────────────────────────────────

def test_parse_not_json_422():
    with pytest.raises(Exception) as exc:
        parse_plan("not json", 1)
    assert exc.value.status_code == 422


def test_parse_not_dict_json_422():
    with pytest.raises(Exception) as exc:
        parse_plan('"[]"', 1)
    assert exc.value.status_code == 422


def test_parse_media_count_zero_422():
    with pytest.raises(Exception) as exc:
        parse_plan('{"clips":[{"file":0,"duration":1}]}', 0)
    assert exc.value.status_code == 422


def test_parse_width_height_fps_bounds_422():
    for val, key in [(100, "width"), (5000, "height"), (5, "fps")]:
        plan = json.dumps({"clips": [{"file": 0, "duration": 1}], key: val})
        with pytest.raises(Exception) as exc:
            parse_plan(plan, 1)
        assert exc.value.status_code == 422


def test_parse_bool_width_422():
    plan = json.dumps({"clips": [{"file": 0, "duration": 1}], "width": True})
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_odd_dimensions_snapped_even():
    plan = json.dumps({"clips": [{"file": 0, "duration": 1}], "width": 1279, "height": 719})
    result = parse_plan(plan, 1)
    assert result["width"] == 1278
    assert result["height"] == 718


def test_parse_clips_missing_empty_too_many_422():
    # missing
    with pytest.raises(Exception) as exc:
        parse_plan('{}', 1)
    assert exc.value.status_code == 422
    # empty
    with pytest.raises(Exception) as exc:
        parse_plan('{"clips":[]}', 1)
    assert exc.value.status_code == 422
    # too many
    with pytest.raises(Exception) as exc:
        parse_plan(json.dumps({"clips": [{"file": 0, "duration": 1}] * 21}), 1)
    assert exc.value.status_code == 422


def test_parse_clips_item_not_object_422():
    plan = json.dumps({"clips": ["not-dict"]})
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_clip_duration_bounds_422():
    for dur in [0.05, 601]:
        plan = json.dumps({"clips": [{"file": 0, "duration": dur}]})
        with pytest.raises(Exception) as exc:
            parse_plan(plan, 1)
        assert exc.value.status_code == 422


def test_parse_file_index_bounds_422():
    for idx in [1, -1, "a", True]:
        plan = json.dumps({"clips": [{"file": idx, "duration": 1}]})
        with pytest.raises(Exception) as exc:
            parse_plan(plan, 1)
        assert exc.value.status_code == 422


def test_parse_total_duration_over_600_422():
    clips = [{"file": 0, "duration": 301}, {"file": 0, "duration": 301}]
    plan = json.dumps({"clips": clips})
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_audios_too_many_422():
    audios = [{"file": 0, "duration": 1, "start": 0}] * 11
    plan = json.dumps({"clips": [{"file": 0, "duration": 1}], "audios": audios})
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_audios_start_oob_422():
    plan = json.dumps(
        {"clips": [{"file": 0, "duration": 1}], "audios": [{"file": 0, "duration": 1, "start": 601}]}
    )
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_texts_too_many_empty_space_long_422():
    base = {"clips": [{"file": 0, "duration": 1}]}
    # too many
    texts = [{"text": "a", "start": 0, "end": 1}] * 21
    with pytest.raises(Exception) as exc:
        parse_plan(json.dumps({**base, "texts": texts}), 1)
    assert exc.value.status_code == 422
    # empty
    with pytest.raises(Exception) as exc:
        parse_plan(json.dumps({**base, "texts": [{"text": "", "start": 0, "end": 1}]}), 1)
    assert exc.value.status_code == 422
    # pure space
    with pytest.raises(Exception) as exc:
        parse_plan(json.dumps({**base, "texts": [{"text": "   ", "start": 0, "end": 1}]}), 1)
    assert exc.value.status_code == 422
    # too long (>200)
    with pytest.raises(Exception) as exc:
        parse_plan(
            json.dumps({**base, "texts": [{"text": "a" * 201, "start": 0, "end": 1}]}), 1
        )
    assert exc.value.status_code == 422


def test_parse_text_end_le_start_422():
    plan = json.dumps(
        {"clips": [{"file": 0, "duration": 1}], "texts": [{"text": "hi", "start": 2, "end": 1}]}
    )
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_text_position_invalid_422():
    plan = json.dumps(
        {
            "clips": [{"file": 0, "duration": 1}],
            "texts": [{"text": "hi", "start": 0, "end": 1, "position": "left"}],
        }
    )
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_text_color_invalid_422():
    plan = json.dumps(
        {
            "clips": [{"file": 0, "duration": 1}],
            "texts": [{"text": "hi", "start": 0, "end": 1, "color": "red"}],
        }
    )
    with pytest.raises(Exception) as exc:
        parse_plan(plan, 1)
    assert exc.value.status_code == 422


def test_parse_text_fontsize_bounds_422():
    for sz in [5, 300]:
        plan = json.dumps(
            {
                "clips": [{"file": 0, "duration": 1}],
                "texts": [{"text": "hi", "start": 0, "end": 1, "fontSize": sz}],
            }
        )
        with pytest.raises(Exception) as exc:
            parse_plan(plan, 1)
        assert exc.value.status_code == 422


def test_parse_minimal_plan_ok():
    plan = json.dumps({"clips": [{"file": 0, "duration": 1.5}]})
    result = parse_plan(plan, 1)
    assert result["width"] == 1920
    assert result["height"] == 1080
    assert result["fps"] == 30
    assert result["clips"] == [{"file": 0, "in": 0, "duration": 1.5, "volume": 1}]
    assert result["audios"] == []
    assert result["texts"] == []
    assert result["total"] == 1.5


# ────────────────────────────────
# build_render_plan_cmd 命令构造
# ────────────────────────────────

def test_build_single_clip_no_audio_no_text():
    cmd = build_render_plan_cmd(
        ["/ws/in/001.mp4"],
        {"width": 1280, "height": 720, "fps": 30, "clips": [{"file": 0, "in": 0, "duration": 3, "volume": 1}], "audios": [], "texts": [], "total": 3},
        [False],
        font_path="/usr/share/fonts/font.ttf",
        out_path="/ws/out/job.mp4",
    )
    assert "scale=1280:720:force_original_aspect_ratio=decrease" in cmd
    assert "pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black" in cmd
    assert "fps=30" in cmd
    assert "format=yuv420p" in cmd
    assert "setsar=1" in cmd
    assert "concat=n=1:v=1:a=0" in cmd
    assert "[vcat]null[vout]" in cmd
    assert "-an" in cmd
    assert "-c:v libx264" in cmd
    assert cmd.endswith("-y /ws/out/job.mp4")


def test_build_two_clips_one_audio_one_text():
    plan = {
        "width": 1920,
        "height": 1080,
        "fps": 24,
        "clips": [
            {"file": 0, "in": 0, "duration": 2, "volume": 1},
            {"file": 0, "in": 5, "duration": 3, "volume": 0},
        ],
        "audios": [{"file": 1, "in": 0, "duration": 5, "start": 0, "volume": 1}],
        "texts": [{"text": "hello", "start": 0, "end": 2, "position": "bottom", "fontSize": 48, "color": "#ffffff"}],
        "total": 5,
    }
    cmd = build_render_plan_cmd(
        ["/ws/in/001.mp4", "/ws/in/002.mp3"],
        plan,
        [True, False],
        font_path="/usr/share/fonts/font.ttf",
        out_path="/ws/out/job.mp4",
    )
    # 3 路输入(2 视频段 + 1 音频段),每路各一对 -ss/-t
    argv = shlex.split(cmd)
    assert argv.count("-ss") == 3
    assert argv.count("-t") == 3
    assert "-ss 0 -t 2 -i /ws/in/001.mp4" in cmd
    assert "-ss 5 -t 3 -i /ws/in/001.mp4" in cmd
    assert "-ss 0 -t 5 -i /ws/in/002.mp3" in cmd
    # filtergraph(shlex 去引号后):drawtext 字体/字号/颜色/时间窗
    fc = argv[argv.index("-filter_complex") + 1]
    assert "drawtext=fontfile=/usr/share/fonts/font.ttf:text='hello':" in fc
    assert "fontsize=48" in fc
    assert "fontcolor=#ffffff" in fc
    assert "enable='between(t,0,2)'" in fc
    # clip0 原声(volume=1 且有音轨) + audio 轨 = 2 路混音;clip1 volume=0 丢弃
    assert "amix=inputs=2:duration=longest:normalize=0" in fc
    assert "adelay=0|0" in fc
    # -map [vout] / -map [aout]
    maps = [argv[i + 1] for i, tok in enumerate(argv) if tok == "-map"]
    assert maps == ["[vout]", "[aout]"]
    assert "-c:a aac" in cmd
    assert "-b:a 192k" in cmd


def test_build_no_clip_audio_and_no_audios_an():
    cmd = build_render_plan_cmd(
        ["/ws/in/001.mp4"],
        {"width": 1280, "height": 720, "fps": 30, "clips": [{"file": 0, "in": 0, "duration": 2, "volume": 1}], "audios": [], "texts": [], "total": 2},
        [False],
        font_path="/usr/share/fonts/font.ttf",
        out_path="/ws/out/job.mp4",
    )
    assert "-an" in cmd
    assert "amix" not in cmd


def test_escape_drawtext():
    assert _escape_drawtext("a\nb") == "a b"
    assert _escape_drawtext("a\rb") == "a b"
    assert _escape_drawtext("\\") == "\\\\"
    assert _escape_drawtext("'") == "\\'"
    assert _escape_drawtext("`") == "\\`"
    assert _escape_drawtext(":") == "\\:"
    assert _escape_drawtext(",") == "\\,"
    assert _escape_drawtext(";") == "\\;"
    assert _escape_drawtext("%") == "\\%"
    assert _escape_drawtext("[") == "\\["
    assert _escape_drawtext("]") == "\\]"


def test_build_path_with_spaces_quoted():
    cmd = build_render_plan_cmd(
        ["/ws/my dir/001.mp4"],
        {"width": 1280, "height": 720, "fps": 30, "clips": [{"file": 0, "in": 0, "duration": 2, "volume": 0}], "audios": [], "texts": [], "total": 2},
        [False],
        font_path="/usr/share/fonts/font.ttf",
        out_path="/ws/my dir/out.mp4",
    )
    assert "'/ws/my dir/001.mp4'" in cmd
    assert "'/ws/my dir/out.mp4'" in cmd


# ────────────────────────────────
# POST /api/video-edit/render
# ────────────────────────────────

def test_render_unauthenticated_401(ctx):
    client, _, _, _ = ctx
    files = [("media", ("a.mp4", _MP4, "video/mp4"))]
    r = client.post("/api/video-edit/render", files=files, data={"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 401


def test_render_bad_plan_json_422(ctx):
    client, auth, _, _ = ctx
    files = [("media", ("a.mp4", _MP4, "video/mp4"))]
    r = _post(client, auth, files, {"plan": "not-json"})
    assert r.status_code == 422


def test_render_no_media_422(ctx):
    client, auth, _, _ = ctx
    r = client.post("/api/video-edit/render", data={"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})}, headers=auth)
    assert r.status_code == 422


def test_render_traversal_filename_422(ctx):
    client, auth, _, _ = ctx
    files = [("media", ("../../evil.mp4", _MP4, "video/mp4"))]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 422
    assert "穿越" in r.json()["detail"]


def test_render_invalid_extension_422(ctx):
    client, auth, _, _ = ctx
    files = [("media", ("a.txt", b"text", "text/plain"))]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 422


def test_render_too_many_media_422(ctx):
    client, auth, _, _ = ctx
    files = [("media", (f"{i:03d}.mp4", _MP4, "video/mp4")) for i in range(31)]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}] * 31})})
    assert r.status_code == 422


def test_render_empty_file_422(ctx):
    client, auth, _, _ = ctx
    files = [("media", ("a.mp4", b"", "video/mp4"))]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 422
    assert "空文件" in r.json()["detail"]


def test_render_success(ctx, monkeypatch):
    client, auth, imp, out = ctx
    captured: list = []
    monkeypatch.setattr("subprocess.run", _fake_run_ok(out, captured))

    files = [
        ("media", ("movie.mp4", _MP4, "video/mp4")),
        ("media", ("bgm.mp3", _MP3, "audio/mpeg")),
    ]
    plan = {
        "width": 1920,
        "height": 1080,
        "fps": 30,
        "clips": [{"file": 0, "in": 0, "duration": 3, "volume": 1}],
        "audios": [{"file": 1, "in": 0, "duration": 3, "start": 0, "volume": 0.8}],
        "texts": [{"text": "Hello", "start": 0, "end": 3, "position": "center", "fontSize": 64, "color": "#FF0000"}],
    }
    r = _post(client, auth, files, {"plan": json.dumps(plan)})
    assert r.status_code == 200, r.text
    data = r.json()
    assert re.fullmatch(r"[a-z0-9]{12}", data["job_id"])
    assert data["url"] == f"/api/video-edit/output/{data['job_id']}.mp4"
    assert data["duration"] == 3
    assert data["clips"] == 1 and data["audios"] == 1 and data["texts"] == 1

    job_dir = imp / data["job_id"]
    assert (job_dir / "001.mp4").is_file()
    assert (job_dir / "002.mp3").is_file()

    # ffprobe call
    assert len(captured) == 2
    probe_cmd = captured[0]
    assert probe_cmd[0] == "ssh"
    assert "for f in" in probe_cmd[-1]
    # ffmpeg call
    ffmpeg_cmd = captured[1]
    assert ffmpeg_cmd[0] == "ssh"
    remote = ffmpeg_cmd[-1]
    assert "ffmpeg" in remote
    assert f"/ws/imports/{data['job_id']}/001.mp4" in remote
    assert f"/ws/outputs/{data['job_id']}.mp4" in remote

    assert (out / f"{data['job_id']}.mp4").is_file()


def test_render_ffmpeg_failure_502_and_cleanup(ctx, monkeypatch):
    client, auth, imp, out = ctx
    monkeypatch.setattr("subprocess.run", _fake_run_fail)
    files = [("media", ("a.mp4", _MP4, "video/mp4"))]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 502
    assert "boom-tail" in r.json()["detail"]
    assert list(imp.iterdir()) == []
    assert list(out.glob("*.mp4")) == []


def test_render_ffprobe_failure_degrades_no_audio(ctx, monkeypatch):
    """ffprobe ssh 失败 → 降级为全部无音轨,ffmpeg 继续渲染不报错。"""
    client, auth, imp, out = ctx
    captured: list = []

    def _fake_run_probe_fail(cmd, **kwargs):
        captured.append(cmd)
        remote = cmd[-1]
        if "ffprobe" in remote:
            # ssh 返回非零 → _run_ssh 抛 502 → _probe_audio_streams 捕获降级
            return subprocess.CompletedProcess(cmd, 1, "", "ssh connect fail")
        # ffmpeg success
        last = remote.rsplit(None, 1)[-1].strip("'\"")
        name = Path(last).name
        out.mkdir(parents=True, exist_ok=True)
        (out / name).write_bytes(b"\x00\x00\x00\x18ftypmp42")
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr("subprocess.run", _fake_run_probe_fail)
    files = [("media", ("a.mp4", _MP4, "video/mp4"))]
    r = _post(client, auth, files, {"plan": json.dumps({"clips": [{"file": 0, "duration": 1}]})})
    assert r.status_code == 200, r.text
    assert (out / f"{r.json()['job_id']}.mp4").is_file()


# ────────────────────────────────
# GET /api/video-edit/output
# ────────────────────────────────

def test_output_whitelist_404(ctx):
    client, auth, _, _ = ctx
    for bad in ["../../etc/passwd", "abc.mp4", "ABC123DEF456.mp4", "abc123def456.mp4.bak", "abc123def456"]:
        r = client.get(f"/api/video-edit/output/{bad}", headers=auth)
        assert r.status_code == 404, bad


def test_output_missing_404(ctx):
    client, auth, _, _ = ctx
    r = client.get("/api/video-edit/output/abc123def456.mp4", headers=auth)
    assert r.status_code == 404


def test_output_served(ctx):
    client, auth, _, out = ctx
    out.mkdir(parents=True, exist_ok=True)
    (out / "abc123def456.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42")
    r = client.get("/api/video-edit/output/abc123def456.mp4", headers=auth)
    assert r.status_code == 200
    assert r.headers["content-type"] == "video/mp4"
    assert r.content == b"\x00\x00\x00\x18ftypmp42"
