"""真片 dogfood 全链 · CI 可跑切片(全 mock,零 GPU)。

对照 2026-10-17 波 B 真机 dogfood(pid 78e17c5b)与 P1 e2e(tmp/p0-20261016/e2e_p1.py):

  SVML 词锚导入 → save shots → reflow dryrun → reflow persist → 场景冻结+绑定
  → 整批渲染(mock) → 配音(mock) → 成片拼接(mock) → Packed Transcript 总线
  → fusion E-8 路径闸(产品 URL) → EDL 体检/剪点(无媒体解码)

真机依赖(Comfy/H3/TTS/ffmpeg concat/Whisper/QA 帧采样)刻意不进本测;
那些归 nightly/manual。本测锁定 dogfood 抓漏的两处接缝回归:

  · 5edc8efc fusion 路径闸 E-8 双形态(URL 被 403 误拒)
  · 3b410558 studio 回写须经 artifacts/video-done 总线触发转写
"""
from __future__ import annotations

import inspect
import json
import time
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

from app.db import get_session
from app.main import app
from app.models import StudioShot, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch

pytestmark = pytest.mark.dogfood_ci

SVML = (
    "[duration:12]\n"
    "[scene:雨巷]\n"
    "推近||@{光}亮起@{/光}\n"
    "<小周>旧词一句||旧尾三字"
)


@pytest.fixture()
def ctx(monkeypatch, tmp_path):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    import app.db as db_mod

    monkeypatch.setattr(db_mod, "engine", engine)

    # drama 输出根:成片/侧车/E-8 路径闸共用
    root = tmp_path / "drama"
    (root / "studio").mkdir(parents=True)
    (root / "output").mkdir(parents=True)
    monkeypatch.setattr("app.storage.drama_output_root", lambda: root)

    with Session(engine) as s:
        t = Tenant(name="dogfood-ci")
        s.add(t)
        s.commit()
        s.refresh(t)
        u = User(
            email="dogfood-ci@toiv.ai",
            hashed_password=hash_password("password1"),
            tenant_id=t.id,
        )
        s.add(u)
        s.commit()
        s.refresh(u)
        uid = u.id

    with TestClient(app) as client:
        yield {
            "client": client,
            "H": {"Authorization": f"Bearer {create_token(uid)}"},
            "engine": engine,
            "root": root,
        }
    app.dependency_overrides.clear()


def _h(ctx):
    return ctx["H"]


def _gate_stages_for_batch(client, H, pid):
    """C1c 门禁:批量渲染前显式完成 storyboard 阶段(测试夹具,非放宽生产门禁)。
    空项目(无分镜)不设防——生产门禁对空批次/空项目本就不拦。"""
    detail = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    if not detail.get("shots"):
        return
    states = detail["stage_states"]
    script_action = "confirm" if states["script"]["ready"] else "skip"
    for stage, action in (("script", script_action), ("assets", "skip"), ("storyboard", "confirm")):
        r = client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H,
                        json={"stage": stage, "action": action, "note": "测试夹具"})
        assert r.status_code == 200, r.text


def _gate_stages_for_assemble(client, H, pid):
    """C1c 门禁:合成前显式完成 storyboard/generate/voice 阶段。"""
    _gate_stages_for_batch(client, H, pid)
    for stage in ("generate", "voice"):
        r = client.post(f"/api/studio/projects/{pid}/stage-transition", headers=H,
                        json={"stage": stage, "action": "skip", "note": "测试夹具"})
        assert r.status_code == 200, r.text


def test_dogfood_source_contracts_lock_dogfood_fixes():
    """源码契约:studio 回写尾须 emit 总线(3b410558);不靠 mock 假装。"""
    from app.services.studio import orchestrator as o

    src = inspect.getsource(o.render_shot) + inspect.getsource(o._fire_video_transcript)
    assert "_fire_video_transcript" in inspect.getsource(o.render_shot)
    assert "emit_artifacts_video_done" in inspect.getsource(o._fire_video_transcript)
    assert "studio.orchestrator" in src or "emit_artifacts_video_done" in src


def test_dogfood_full_chain_mocked(ctx, monkeypatch):
    """一条测走完真片链的 CI 可跑段;渲染/配音/拼接全 mock。"""
    from app.services import domain_events as de

    client, H, engine, root = ctx["client"], ctx["H"], ctx["engine"], ctx["root"]
    bus: list[dict] = []
    de.clear_listeners(de.ARTIFACTS_VIDEO_DONE)
    de.on(de.ARTIFACTS_VIDEO_DONE, lambda p: bus.append(dict(p)))

    # ── 1. 建项目 + SVML 导入(不落库)──────────────────────────────────
    pid = client.post(
        "/api/studio/projects",
        headers=H,
        json={"title": "dogfood-ci-真片链", "premise": "CI mock", "style": "anime"},
    ).json()["id"]
    imp = client.post(
        f"/api/studio/projects/{pid}/import-svml",
        headers=H,
        json={"script": SVML},
    )
    assert imp.status_code == 200, imp.text
    shots = imp.json()["shots"]
    assert len(shots) == 1
    beats = shots[0]["beats"]
    assert len(beats) == 4, beats
    assert abs(beats[-1]["end_sec"] - 12) < 0.01, beats[-1]

    # ── 2. save shots(词锚落库)────────────────────────────────────────
    item = {
        k: shots[0][k]
        for k in ("scene", "prompt", "dialogue", "duration_sec", "render_mode", "speaker")
        if k in shots[0]
    }
    item["characters"] = shots[0].get("characters") or ["小周"]
    item["beats"] = [
        {
            "text": b["text"],
            "cues": b.get("cues") or [],
            "anchor_words": b.get("anchor_words") or "",
            "kind": b.get("kind"),
            "block": b.get("block", 0),
        }
        for b in beats
    ]
    saved = client.put(
        f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": [item]}
    )
    assert saved.status_code == 200, saved.text
    sid = saved.json()["shots"][0]["id"]

    # ── 3. reflow dryrun(不落库)→ persist(改词重排)────────────────────
    dry = client.post(
        f"/api/studio/shots/{sid}/reflow-beats",
        headers=H,
        json={
            "texts": ["新词啦", "新锚起", "新台词四个字", "新尾巴"],
            "total_sec": 14,
            "persist": False,
        },
    )
    assert dry.status_code == 200, dry.text
    assert dry.json().get("persisted") is False
    assert dry.json()["duration_sec"] == 14

    rf = client.post(
        f"/api/studio/shots/{sid}/reflow-beats",
        headers=H,
        json={
            "texts": ["新词啦", "新锚起", "新台词四个字", "新尾巴"],
            "total_sec": 14,
            "persist": True,
        },
    )
    assert rf.status_code == 200, rf.text
    assert rf.json()["duration_sec"] == 14
    assert "新台词四个字" in (rf.json().get("dialogue") or "")

    det = client.get(f"/api/studio/projects/{pid}", headers=H).json()
    shot = next(s for s in (det.get("shots") or []) if s["id"] == sid)
    assert len(shot["beats"]) == 4
    assert shot["duration_sec"] == 14
    assert "新台词四个字" in shot["dialogue"]

    # ── 4. 场景锚点冻结 + 绑定(读图 mock,无 GPU)──────────────────────
    import app.routes.drama_scenes as ds

    monkeypatch.setattr(ds, "_read_image_bytes", lambda url: b"dogfood-anchor-bytes")
    sc = client.post(
        f"/api/drama/projects/{pid}/scenes",
        headers=H,
        json={
            "name": "雨巷",
            "environment_prompt": "rainy alley, neon signs",
            "master_ref": "/api/studio/files/master.png",
        },
    )
    assert sc.status_code == 200, sc.text
    scene_id = sc.json()["scene"]["id"]
    fz = client.post(
        f"/api/drama/scenes/{scene_id}/freeze-anchor",
        headers=H,
        json={"anchor_id": "master"},
    )
    assert fz.status_code == 200, fz.text
    frozen = fz.json()["scene"]["frozen_anchor"]
    assert frozen["snapshot_url"].startswith("/api/studio/files/scene_anchor_")
    assert frozen["sha256"]

    at = client.post(
        f"/api/drama/scenes/{scene_id}/attach",
        headers=H,
        json={"shot_id": sid, "use_frozen": True},
    )
    assert at.status_code == 200, at.text
    assert at.json()["anchor_image"] == frozen["snapshot_url"]
    ref = client.get(f"/api/drama/shots/{sid}/scene-ref", headers=H)
    assert ref.status_code == 200, ref.text
    assert ref.json()["scene_ref"]["anchor_image"] == frozen["snapshot_url"]

    # ── 5. 整批渲染 mock(写回尾须打转写总线 — dogfood 抓漏)────────────
    video_name = f"{sid}.mp4"
    video_url = f"/api/studio/files/{video_name}"
    (root / "studio" / video_name).write_bytes(b"fake-mp4")

    async def fake_render(session, shot, pool=None, request=None, **kw):
        shot.status = "rendered"
        shot.video_url = video_url
        shot.final_clip_url = video_url
        shot.candidates_json = json.dumps(
            [
                {
                    "id": f"c-{shot.id[:8]}",
                    "url": video_url,
                    "status": "done",
                    "is_picked": True,
                }
            ]
        )
        session.add(shot)
        session.commit()
        session.refresh(shot)
        # 与生产 render_shot 尾相同:回写后触发总线(3b410558 接缝)
        orch._fire_video_transcript(shot.video_url)
        return shot

    monkeypatch.setattr(orch, "render_shot", fake_render)
    keyframe_name = f"{sid}-keyframe.png"
    (root / "studio" / keyframe_name).write_bytes(b"fake-keyframe")
    adopted = client.post(
        f"/api/studio/shots/{sid}/adopt-keyframe",
        headers=H,
        json={"url": f"/api/studio/files/{keyframe_name}"},
    )
    assert adopted.status_code == 200, adopted.text
    _gate_stages_for_batch(client, H, pid)
    r = client.post(
        f"/api/studio/projects/{pid}/render",
        headers=H,
        json={"wait": False, "accel": "off"},
    )
    assert r.status_code == 202, r.text
    job_id = r.json()["job_id"]
    deadline = time.monotonic() + 5
    final = None
    while time.monotonic() < deadline:
        final = client.get("/api/jobs/lookup", headers=H, params={"job_id": job_id}).json()
        if final["status"] in ("done", "error", "canceled"):
            break
        time.sleep(0.05)
    assert final and final["status"] == "done", final

    with Session(engine) as s:
        row = s.exec(select(StudioShot).where(StudioShot.id == sid)).one()
        assert row.status == "rendered"
        assert row.video_url == video_url

    assert any(
        video_url in (p.get("urls") or []) and "studio" in str(p.get("source") or "")
        for p in bus
    ), bus

    # ── 6. 配音 mock──────────────────────────────────────────────────
    cr = client.post(
        f"/api/studio/projects/{pid}/characters",
        headers=H,
        json={"name": "小周", "visual_prompt": "1boy"},
    )
    assert cr.status_code == 200, cr.text
    cid = cr.json()["id"]
    client.patch(
        f"/api/studio/characters/{cid}",
        headers=H,
        json={"voice_ref_url": "/api/studio/files/zhou-ref.wav"},
    )

    async def fake_synth(session, shot, character):
        shot.voice_url = f"/api/studio/files/{shot.id}.wav"
        shot.status = "voiced"
        shot.error = ""
        session.add(shot)
        session.commit()
        return shot.voice_url

    monkeypatch.setattr("app.services.studio.voice.synth_for_shot", fake_synth)
    vr = client.post(f"/api/studio/shots/{sid}/voice", headers=H)
    assert vr.status_code == 200, vr.text
    assert vr.json()["status"] == "voiced"

    # ── 7. 成片拼接 mock──────────────────────────────────────────────
    final_name = "final-dogfood-ci.mp4"
    final_url = f"/api/studio/files/{final_name}"
    (root / "studio" / final_name).write_bytes(b"fake-final")

    async def fake_assemble(session, project, shots, **kw):
        project.final_url = final_url
        project.status = "done"
        session.add(project)
        session.commit()
        return final_url

    monkeypatch.setattr(
        "app.services.studio.assemble.assemble_project", fake_assemble
    )
    _gate_stages_for_assemble(client, H, pid)
    ar = client.post(f"/api/studio/projects/{pid}/assemble", headers=H)
    assert ar.status_code == 200, ar.text
    assert final_url in (ar.json().get("final_url") or ar.text)

    # ── 8. fusion E-8:产品 URL 不得 403(5edc8efc)─────────────────────
    import app.routes.fusion_tools as ft

    resolved = ft._safe_media_path(final_url)
    assert resolved == (root / "studio" / final_name).resolve()
    with pytest.raises(Exception):
        ft._safe_media_path("/api/studio/files/../../../etc/passwd")

    # Packed Transcript 侧车可读(of-video,产品路径形态)
    side = root / "studio" / f"{Path(video_name).stem}.transcript.md"
    # 钩子落点在 drama 根文件名侧车(见 artifact_transcript.sidecar_path)
    side_root = root / f"{Path(video_name).stem}.transcript.md"
    side_root.write_text("[000.00-000.40] 新词啦\n", encoding="utf-8")
    tr = client.get(
        "/api/fusion/transcript/of-video",
        headers=H,
        params={"path": video_url},
    )
    # of-video 可能要从归属校验过;至少路径闸不得因 URL 形态直接 403
    assert tr.status_code != 403, tr.text
    assert tr.status_code in (200, 404), tr.text  # 404=侧车未认领归属时仍可接受闸位

    # ── 9. EDL 体检 + 剪点(无媒体解码,纯词边界)────────────────────────
    words = [
        {"word": "新词啦", "start": 0.0, "end": 0.4},
        {"word": "新锚起", "start": 0.5, "end": 0.9},
        {"word": "新台词四个字", "start": 1.0, "end": 1.8},
        {"word": "新尾巴", "start": 2.0, "end": 2.4},
    ]
    edl = {
        "items": [
            {
                "source": video_name,
                "start": 0.0,
                "end": 2.4,
                "beat": "b0",
                "quote": "新词啦",
                "reason": "dogfood-ci",
            }
        ]
    }
    ev = client.post(
        "/api/fusion/edl/validate",
        headers=H,
        json={"edl": edl, "words_by_source": {video_name: words}},
    )
    assert ev.status_code == 200, ev.text
    assert "ok" in ev.json()

    cp = client.post(
        "/api/fusion/edl/cut-plan",
        headers=H,
        json={"words": words, "pad_ms": 120, "min_silence": 0.4},
    )
    assert cp.status_code == 200, cp.text
