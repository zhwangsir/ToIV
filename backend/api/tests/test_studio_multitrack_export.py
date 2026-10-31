"""P2-9：创作台全量多轨导出（EDL/FCPXML + 分轨 ZIP）— 纯函数 + 端点。

覆盖：时间线投影纯函数、同一批 shots 剪映与 EDL 切点一致、FCPXML 多轨、
缺素材/时长超限清单、422 空项目、租户隔离。
"""
from __future__ import annotations

import io
import json
import zipfile
from pathlib import Path
from types import SimpleNamespace
from xml.etree import ElementTree as ET

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

from app.db import get_session
from app.main import app
from app.models import StudioProject, StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import export_timeline as et
from app.services.studio import jianying_draft as jy


def _shots() -> list[SimpleNamespace]:
    return [
        SimpleNamespace(
            id="s-b", idx=1, duration_sec=4, final_clip_url="/api/studio/files/b.mp4",
            video_url="", voice_url="/api/studio/files/b.wav", dialogue="第二镜 & 台词",
        ),
        SimpleNamespace(
            id="s-a", idx=0, duration_sec=3, final_clip_url="/api/studio/files/a.mp4",
            video_url="", voice_url="", dialogue="第一镜",
        ),
        SimpleNamespace(
            id="s-c", idx=2, duration_sec=5, final_clip_url="/api/studio/files/c.mp4",
            video_url="", voice_url="/api/studio/files/c.wav", dialogue="",
        ),
    ]


def _timeline() -> tuple[et.MultitrackTimeline, et.ExportChecklist]:
    return et.project_studio_shots(
        _shots(),
        bgm_url="/api/studio/files/bgm.mp3",
        title="雨夜多轨",
        fps=30,
    )


# ── 纯函数：投影 ────────────────────────────────────────────────────────────


def test_project_studio_shots_cut_points():
    timeline, checklist = _timeline()
    assert checklist.missing_assets == []
    assert checklist.duration_issues == []
    videos = timeline.of(et.TRACK_VIDEO)
    assert [(c.clip_id, c.start_us, c.duration_us) for c in videos] == [
        ("s-a", 0, 3_000_000),
        ("s-b", 3_000_000, 4_000_000),
        ("s-c", 7_000_000, 5_000_000),
    ]
    dialogue = timeline.of(et.TRACK_DIALOGUE)
    # voice 对齐 shot_start
    assert [(c.clip_id, c.start_us, c.duration_us) for c in dialogue] == [
        ("s-b_voice", 3_000_000, 4_000_000),
        ("s-c_voice", 7_000_000, 5_000_000),
    ]
    subs = timeline.of(et.TRACK_SUBTITLE)
    assert [(c.clip_id, c.start_us, c.end_us, c.text) for c in subs] == [
        ("s-a_sub", 0, 3_000_000, "第一镜"),
        ("s-b_sub", 3_000_000, 7_000_000, "第二镜 & 台词"),
    ]
    bgm = timeline.of(et.TRACK_BGM)
    assert len(bgm) == 1
    # BGM 从 0 覆盖总长
    assert bgm[0].start_us == 0
    assert bgm[0].duration_us == 12_000_000
    assert timeline.total_duration_us == 12_000_000


def test_projection_matches_jianying_cut_points():
    """同一批 shots：剪映 video target start/end 与多轨投影完全一致。"""
    shots = _shots()
    jy_clips = jy.clips_from_studio_shots(
        shots,
        resolve_path=lambda u: None,
        bgm_url="/api/studio/files/bgm.mp3",
    )
    doc = jy.build_draft_document(draft_id="D1", name="x", clips=jy_clips)
    jy_video = [
        (s["target_timerange"]["start"], s["target_timerange"]["duration"])
        for t in doc["tracks"] if t["type"] == "video"
        for s in t["segments"]
    ]
    timeline, _ = et.project_studio_shots(shots, bgm_url="/api/studio/files/bgm.mp3")
    et_video = [(c.start_us, c.duration_us) for c in timeline.of(et.TRACK_VIDEO)]
    assert et_video == jy_video

    jy_audio = {
        s["target_timerange"]["start"]: s["target_timerange"]["duration"]
        for t in doc["tracks"] if t["type"] == "audio"
        for s in t["segments"]
    }
    et_voice = [(c.start_us, c.duration_us) for c in timeline.of(et.TRACK_DIALOGUE)]
    for start, dur in et_voice:
        assert jy_audio.get(start) == dur
    # BGM：0 起覆盖视频总长，与剪映声床段一致
    assert jy_audio.get(0) == 12_000_000
    bgm = timeline.of(et.TRACK_BGM)[0]
    assert (bgm.start_us, bgm.duration_us) == (0, 12_000_000)


def test_illegal_duration_fallback_matches_jianying():
    """非法时长（0）按 6s 回退，剪映与多轨投影同时长；并进 duration_issues。"""
    shots = [
        SimpleNamespace(
            id="s0", idx=0, duration_sec=0, final_clip_url="/api/studio/files/z.mp4",
            video_url="", voice_url="", dialogue="",
        ),
    ]
    jy_clips = jy.clips_from_studio_shots(shots, resolve_path=lambda u: None)
    doc = jy.build_draft_document(draft_id="D1", name="x", clips=jy_clips)
    vseg = next(
        s for t in doc["tracks"] if t["type"] == "video" for s in t["segments"]
    )
    timeline, checklist = et.project_studio_shots(shots)
    assert timeline.of(et.TRACK_VIDEO)[0].duration_us == vseg["target_timerange"]["duration"]
    assert vseg["target_timerange"]["duration"] == 6_000_000
    kinds = {i["kind"] for i in checklist.duration_issues}
    assert "illegal_duration" in kinds


# ── 纯函数：清单 ────────────────────────────────────────────────────────────


def test_checklist_missing_assets_and_duration_limits():
    shots = [
        # 缺 final_clip_url（video_url 也没有）
        SimpleNamespace(
            id="m1", idx=0, duration_sec=3, final_clip_url="", video_url="",
            voice_url="", dialogue="",
        ),
        # 时长超限 + 素材不可读
        SimpleNamespace(
            id="m2", idx=1, duration_sec=90, final_clip_url="/api/studio/files/m2.mp4",
            video_url="", voice_url="/api/studio/files/m2.wav", dialogue="hi",
        ),
    ]
    timeline, checklist = et.project_studio_shots(
        shots,
        resolve_path=lambda u: None,
        bgm_url="/api/studio/files/bgm.mp3",
    )
    missing = checklist.missing_assets
    kinds = [m["kind"] for m in missing]
    assert kinds.count("missing_final_clip") == 1
    assert missing[0]["shot_id"] == "m1"
    # m2 视频/配音 + BGM 均解析不到
    media_labels = {m["label"] for m in missing if m["kind"] == "missing_media_file"}
    assert {"shot_01", "shot_01_voice", "bgm"} <= media_labels
    over = [i for i in checklist.duration_issues if i["kind"] == "duration_over_limit"]
    assert len(over) == 1 and over[0]["raw"] == 90 and over[0]["limit_sec"] == 60
    # 超限不改切点：仍按原值进时间线（与剪映一致）
    assert timeline.of(et.TRACK_VIDEO)[0].duration_us == 90_000_000
    assert timeline.of(et.TRACK_BGM)[0].duration_us == 90_000_000


def test_check_duration_pure():
    assert et.check_duration(6) is None
    assert et.check_duration(0)["kind"] == "illegal_duration"
    assert et.check_duration(-1)["reason"] == "non_positive"
    assert et.check_duration("x")["reason"] == "non_numeric"
    assert et.check_duration(61)["kind"] == "duration_over_limit"
    assert et.check_duration(0.5)["reason"] == "below_minimum"
    assert et.check_duration(0)["applied_sec"] == 6.0


# ── 纯函数：时间码 / EDL / FCPXML ───────────────────────────────────────────


def test_us_to_timecode_and_fcpxml_time():
    assert et.us_to_timecode(0, 30) == "00:00:00:00"
    assert et.us_to_timecode(3_000_000, 30) == "00:00:03:00"
    assert et.us_to_timecode(1_500_000, 24) == "00:00:01:12"
    assert et.us_to_timecode(3_661_000_000, 25) == "01:01:01:00"
    assert et.us_to_fcpxml_time(0) == "0s"
    assert et.us_to_fcpxml_time(3_000_000) == "3s"
    assert et.us_to_fcpxml_time(1_500_000) == "3/2s"


def test_build_edl_multitrack_and_traceability():
    timeline, _ = _timeline()
    text = et.build_edl(timeline)
    assert text.startswith("TITLE: 雨夜多轨\nFCM: NON-DROP FRAME\n")
    assert "* TOIV TRACK SECTION: video" in text
    assert "* TOIV TRACK SECTION: dialogue" in text
    assert "* TOIV TRACK SECTION: bgm" in text
    # 视频切点（record in/out）：0-3 / 3-7 / 7-12（与剪映 target 一致）
    assert "001  TOIV0001 V  C        00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00" in text
    assert "00:00:00:00 00:00:04:00 00:00:03:00 00:00:07:00" in text
    assert "00:00:00:00 00:00:05:00 00:00:07:00 00:00:12:00" in text
    # 台词轨(A) + BGM(A2)
    assert "\nA  C" in text or "\nA C" in text or " A  C" in text
    assert "A2 C" in text or "A2  C" in text
    # 可追溯标识 + 字幕注释
    assert "* TOIV CLIP ID: s-b" in text
    assert "* TOIV SHOT ID: s-b" in text
    assert "* TOIV SUBTITLE: 第二镜 & 台词" in text
    # 事件号连续递增
    nums = [ln.split()[0] for ln in text.splitlines() if ln[:3].isdigit()]
    assert nums == [f"{i:03d}" for i in range(1, len(nums) + 1)]


def test_build_fcpxml_multitrack():
    timeline, _ = _timeline()
    text = et.build_fcpxml(timeline)
    assert text.startswith('<?xml version="1.0" encoding="UTF-8"?>')
    root = ET.fromstring(text.split("?>\n", 1)[1].split("\n", 1)[1])
    assert root.tag == "fcpxml"
    spine = root.find("./event/project/sequence/spine")
    assert spine is not None
    asset_clips = spine.findall("asset-clip")
    assert len(asset_clips) == 3
    assert [a.get("offset") for a in asset_clips] == ["0s", "3s", "7s"]
    audios = spine.findall("audio")
    lanes = sorted({a.get("lane") for a in audios})
    assert lanes == ["-1", "1"]
    assert sum(1 for a in audios if a.get("lane") == "1") == 2  # 台词
    bgm = [a for a in audios if a.get("lane") == "-1"]
    assert len(bgm) == 1 and bgm[0].get("offset") == "0s" and bgm[0].get("duration") == "12s"
    titles = spine.findall("title")
    assert len(titles) == 2
    assert {t.get("lane") for t in titles} == {"2"}
    title_texts = [t.findtext("./text/text-style") for t in titles]
    assert "第二镜 & 台词" in title_texts and "第一镜" in title_texts
    # 可追溯标识（XML 注释 + name）
    assert "toiv clip_id=s-a shot_id=s-a" in text
    names = [a.get("name") for a in asset_clips]
    assert names == ["shot_00", "shot_01", "shot_02"]


def test_build_edl_fcpxml_empty_raises():
    timeline = et.MultitrackTimeline(title="empty", clips=())
    with pytest.raises(et.ExportTimelineError):
        et.build_edl(timeline)
    with pytest.raises(et.ExportTimelineError):
        et.build_fcpxml(timeline)
    with pytest.raises(et.ExportTimelineError):
        et.require_video_clips(timeline)


# ── 纯函数：多轨 ZIP ────────────────────────────────────────────────────────


def test_multitrack_zip_contents():
    shots = [
        SimpleNamespace(
            id="m1", idx=0, duration_sec=3, final_clip_url="", video_url="",
            voice_url="", dialogue="",
        ),
        SimpleNamespace(
            id="m2", idx=1, duration_sec=90, final_clip_url="/api/studio/files/m2.mp4",
            video_url="", voice_url="", dialogue="hi",
        ),
    ]
    timeline, checklist = et.project_studio_shots(shots, resolve_path=lambda u: None)
    data = et.build_multitrack_zip(timeline, checklist)
    with zipfile.ZipFile(io.BytesIO(data), "r") as zf:
        names = set(zf.namelist())
        assert {
            "timeline.edl",
            "timeline.fcpxml",
            "toiv_manifest.json",
            "cut_list.json",
            "missing_assets.json",
            "duration_issues.json",
        } <= names
        manifest = json.loads(zf.read("toiv_manifest.json"))
        assert manifest["format"] == et.EXPORT_FORMAT_VERSION
        assert manifest["missing_assets_count"] == len(checklist.missing_assets)
        assert manifest["duration_issues_count"] == len(checklist.duration_issues)
        cuts = json.loads(zf.read("cut_list.json"))["cuts"]
        assert [(c["track"], c["start_us"], c["duration_us"]) for c in cuts] == [
            ("video", 0, 90_000_000),
            ("subtitle", 0, 90_000_000),
        ]
        missing = json.loads(zf.read("missing_assets.json"))["missing_assets"]
        assert any(m["kind"] == "missing_final_clip" for m in missing)
        dur = json.loads(zf.read("duration_issues.json"))["duration_issues"]
        assert any(d["kind"] == "duration_over_limit" for d in dur)
        ET.fromstring(zf.read("timeline.fcpxml").decode("utf-8").split("?>\n", 1)[1].split("\n", 1)[1])


# ── 端点 ────────────────────────────────────────────────────────────────────


@pytest.fixture()
def ctx():
    engine = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(engine)

    def _session():
        with Session(engine) as s:
            yield s

    app.dependency_overrides[get_session] = _session
    with Session(engine) as s:
        t = Tenant(name="t-p2-9")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email=f"p2-9-{t.id[:8]}@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        token = create_token(u.id)
        p = StudioProject(
            tenant_id=t.id, user_id=u.id, title="雨夜P2-9", bgm_url="/api/studio/files/bgm.mp3"
        )
        s.add(p)
        s.commit()
        s.refresh(p)
        s.add(
            StudioShot(
                project_id=p.id,
                idx=0,
                scene="进店",
                duration_sec=3,
                final_clip_url="/api/studio/files/p2-9-a.mp4",
                dialogue="第一镜",
            )
        )
        s.add(
            StudioShot(
                project_id=p.id,
                idx=1,
                scene="结账",
                duration_sec=4,
                final_clip_url="/api/studio/files/p2-9-b.mp4",
                voice_url="/api/studio/files/p2-9-b.wav",
                dialogue="第二镜",
            )
        )
        s.commit()
        pid = p.id

        # 空项目（无分镜）
        p_empty = StudioProject(tenant_id=t.id, user_id=u.id, title="empty-p2-9")
        s.add(p_empty)
        s.commit()
        s.refresh(p_empty)
        # 有分镜但全缺 final_clip_url
        p_noclip = StudioProject(tenant_id=t.id, user_id=u.id, title="noclip-p2-9")
        s.add(p_noclip)
        s.commit()
        s.refresh(p_noclip)
        s.add(
            StudioShot(
                project_id=p_noclip.id, idx=0, scene="空镜", duration_sec=3,
                final_clip_url="", video_url="", dialogue="",
            )
        )
        s.commit()

        # 租户 B（隔离用）
        t2 = Tenant(name="t-p2-9-b")
        s.add(t2)
        s.commit()
        s.refresh(t2)
        u2 = User(
            email=f"p2-9b-{t2.id[:8]}@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t2.id,
        )
        s.add(u2)
        s.commit()
        s.refresh(u2)
        token2 = create_token(u2.id)
        empty_pid = p_empty.id
        noclip_pid = p_noclip.id

    client = TestClient(app)
    yield {
        "client": client,
        "headers": {"Authorization": f"Bearer {token}"},
        "headers_b": {"Authorization": f"Bearer {token2}"},
        "pid": pid,
        "empty_pid": empty_pid,
        "noclip_pid": noclip_pid,
    }
    app.dependency_overrides.clear()


def test_export_edl_endpoint(ctx):
    r = ctx["client"].get(
        f"/api/studio/projects/{ctx['pid']}/export/edl", headers=ctx["headers"]
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("text/plain")
    assert r.headers.get("x-toiv-export-format") == et.EXPORT_FORMAT_VERSION
    # 两个视频 + 一个配音 + BGM 均未落盘
    assert int(r.headers.get("x-toiv-missing-assets") or 0) == 4
    text = r.text
    assert "TITLE: 雨夜P2-9" in text
    assert "FCM: NON-DROP FRAME" in text
    assert "* TOIV TRACK SECTION: video" in text
    assert "001  TOIV0001 V  C        00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00" in text
    assert "* TOIV SUBTITLE: 第二镜" in text


def test_export_fcpxml_endpoint(ctx):
    r = ctx["client"].get(
        f"/api/studio/projects/{ctx['pid']}/export/fcpxml", headers=ctx["headers"]
    )
    assert r.status_code == 200, r.text
    assert r.headers.get("content-type", "").startswith("application/x-fcpxml")
    body = r.content.decode("utf-8")
    root = ET.fromstring(body.split("?>\n", 1)[1].split("\n", 1)[1])
    spine = root.find("./event/project/sequence/spine")
    assert len(spine.findall("asset-clip")) == 2
    lanes = {a.get("lane") for a in spine.findall("audio")}
    assert "1" in lanes and "-1" in lanes  # 台词 + BGM
    assert len(spine.findall("title")) == 2  # 字幕轨


def test_export_multitrack_cut_consistent_with_jianying(ctx):
    """同一批 shots：剪映 target start/end 与多轨 cut_list 完全一致。"""
    client, headers, pid = ctx["client"], ctx["headers"], ctx["pid"]
    r_jy = client.get(
        f"/api/studio/projects/{pid}/export/jianying",
        params={"include_media": "false"},
        headers=headers,
    )
    assert r_jy.status_code == 200, r_jy.text
    with zipfile.ZipFile(io.BytesIO(r_jy.content), "r") as zf:
        doc = json.loads(
            zf.read(next(n for n in zf.namelist() if n.endswith("draft_content.json")))
        )
    jy_video = [
        (s["target_timerange"]["start"], s["target_timerange"]["duration"])
        for t in doc["tracks"] if t["type"] == "video"
        for s in t["segments"]
    ]
    jy_audio = [
        (s["target_timerange"]["start"], s["target_timerange"]["duration"])
        for t in doc["tracks"] if t["type"] == "audio"
        for s in t["segments"]
    ]

    r_mt = client.get(f"/api/studio/projects/{pid}/export/multitrack", headers=headers)
    assert r_mt.status_code == 200, r_mt.text
    assert r_mt.headers.get("content-type", "").startswith("application/zip")
    with zipfile.ZipFile(io.BytesIO(r_mt.content), "r") as zf:
        names = set(zf.namelist())
        assert {
            "timeline.edl", "timeline.fcpxml", "toiv_manifest.json",
            "cut_list.json", "missing_assets.json", "duration_issues.json",
        } <= names
        cuts = json.loads(zf.read("cut_list.json"))["cuts"]
        edl_text = zf.read("timeline.edl").decode("utf-8")
    mt_video = [
        (c["start_us"], c["duration_us"]) for c in cuts if c["track"] == "video"
    ]
    assert mt_video == jy_video
    assert mt_video == [(0, 3_000_000), (3_000_000, 4_000_000)]
    # 台词对齐 shot_start（剪映 voice 段同 start/duration）
    mt_voice = [
        (c["start_us"], c["duration_us"]) for c in cuts if c["track"] == "dialogue"
    ]
    assert mt_voice == [(3_000_000, 4_000_000)]
    assert (3_000_000, 4_000_000) in jy_audio
    # BGM 从 0 覆盖总长（与剪映声床段一致）
    mt_bgm = [c for c in cuts if c["track"] == "bgm"]
    assert len(mt_bgm) == 1
    assert (mt_bgm[0]["start_us"], mt_bgm[0]["duration_us"]) == (0, 7_000_000)
    assert (0, 7_000_000) in jy_audio
    # EDL 时间码与切点同帧
    assert "00:00:00:00 00:00:03:00 00:00:00:00 00:00:03:00" in edl_text
    assert "00:00:00:00 00:00:04:00 00:00:03:00 00:00:07:00" in edl_text


def test_export_empty_project_422(ctx):
    for path in ("edl", "fcpxml", "multitrack"):
        r = ctx["client"].get(
            f"/api/studio/projects/{ctx['empty_pid']}/export/{path}",
            headers=ctx["headers"],
        )
        assert r.status_code == 422, (path, r.text)
        assert "无分镜" in r.text


def test_export_no_final_clip_422(ctx):
    for path in ("edl", "fcpxml", "multitrack"):
        r = ctx["client"].get(
            f"/api/studio/projects/{ctx['noclip_pid']}/export/{path}",
            headers=ctx["headers"],
        )
        assert r.status_code == 422, (path, r.text)
        assert "final_clip_url" in r.text


def test_export_tenant_isolation_404(ctx):
    for path in ("edl", "fcpxml", "multitrack"):
        r = ctx["client"].get(
            f"/api/studio/projects/{ctx['pid']}/export/{path}",
            headers=ctx["headers_b"],
        )
        assert r.status_code == 404, (path, r.text)
