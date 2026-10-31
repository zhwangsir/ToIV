"""D0 渲染工作量/价格预估与提交准入契约测试。"""
from __future__ import annotations

import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine, select

import app.db as db_mod
from app.db import get_session
from app.main import app
from app.models import Job, StudioProject, StudioShot, StudioShotRevision, Tenant, User
from app.security import create_token, hash_password
from app.services.studio import orchestrator as orch


@pytest.fixture()
def ctx(monkeypatch):
    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    monkeypatch.setattr(db_mod, "engine", engine)
    with Session(engine) as s:
        tenant = Tenant(name="estimate")
        s.add(tenant)
        s.commit()
        s.refresh(tenant)
        user = User(email="estimate@toiv.ai", hashed_password=hash_password("p"), tenant_id=tenant.id)
        s.add(user)
        s.commit()
        s.refresh(user)
        uid = user.id
        other_tenant = Tenant(name="estimate-other")
        s.add(other_tenant)
        s.commit()
        s.refresh(other_tenant)
        other = User(email="estimate2@toiv.ai", hashed_password=hash_password("p"), tenant_id=other_tenant.id)
        s.add(other)
        s.commit()
        s.refresh(other)
        other_uid = other.id
    with TestClient(app) as client:
        yield client, create_token(uid), create_token(other_uid), engine
    app.dependency_overrides.clear()


def _h(token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {token}"}


def _project(client, H, **over):
    drive_mode = over.pop("preferred_drive_mode", "direct")
    body = {"title": "D0", "premise": "p"}
    body.update(over)
    r = client.post("/api/studio/projects", headers=H, json=body)
    assert r.status_code == 200, r.text
    pid = r.json()["id"]
    r = client.patch(f"/api/studio/projects/{pid}", headers=H,
                     json={"preferred_drive_mode": drive_mode})
    assert r.status_code == 200, r.text
    return pid


def _shots(client, H, pid, shots):
    r = client.put(f"/api/studio/projects/{pid}/shots", headers=H, json={"shots": shots})
    assert r.status_code == 200, r.text
    return r.json()["shots"]


def _confirm_storyboard(client, H, pid):
    for stage, action in (("script", "confirm"), ("assets", "skip"), ("storyboard", "confirm")):
        r = client.post(
            f"/api/studio/projects/{pid}/stage-transition",
            headers=H,
            json={"stage": stage, "action": action, "note": "测试夹具"},
        )
        assert r.status_code == 200, r.text


def _rates(monkeypatch, raw="", budget="0"):
    monkeypatch.setattr(
        "app.services.studio.estimates.get_settings",
        lambda: SimpleNamespace(studio_cost_rates_json=raw, studio_render_budget_limit=budget),
    )


def test_shot_estimate_unpriced_work_and_legacy_candidate_semantics(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _rates(monkeypatch)
    pid = _project(client, H, width=768, height=1344, fps=24)
    shot = _shots(client, H, pid, [{"scene": "A", "prompt": "a", "duration_sec": 6}])[0]

    r = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["schema"] == "toiv_render_estimate_v1"
    assert body["scope"] == "shot" and body["project_id"] == pid
    assert body["shot_id"] == shot["id"] and body["allowed"] is True
    assert body["blockers"] == []
    assert body["work"] == {
        "shot_count": 1,
        "candidate_upper_bound": 1,
        "requested_duration_sec": 6,
        "requested_frame_count": 144,
        "pixel_frame_upper_bound": 144 * 768 * 1344,
        "image_motion_count": 0,
    }
    assert body["items"][0]["candidates"] == 1
    assert body["items"][0]["frames"] == 144
    assert body["pricing"] == {
        "status": "unpriced", "currency": None, "total": None,
        "rate_source": "TOIV_STUDIO_COST_RATES_JSON", "unknowns": ["h3:video:ref2va"],
    }
    assert body["budget"] == {"status": "disabled", "limit": None, "currency": None}
    assert body["input_fingerprint"]
    assert any("重试" in w["message"] for w in body["warnings"])

    r2 = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H, json={})
    assert r2.status_code == 200
    assert r2.json()["work"]["candidate_upper_bound"] == 2
    assert r2.json()["work"]["requested_frame_count"] == 288
    explicit_one = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H,
                               json={"num_candidates": 1})
    assert explicit_one.json()["input_fingerprint"] == body["input_fingerprint"]


def test_estimate_decimal_pricing_fingerprint_and_tenant_isolation(ctx, monkeypatch):
    client, token, other_token, _ = ctx
    H = _h(token)
    rates = json.dumps({
        "currency": "CNY",
        "rates": {
            "h3:video:ref2va": {"pixel_frame": "0.000001"},
            "h3:image_motion:ref2va": {"candidate": "0.25"},
        },
    })
    _rates(monkeypatch, rates, budget="100")
    pid = _project(client, H, width=256, height=256, fps=10)
    video, motion = _shots(client, H, pid, [
        {"scene": "A", "prompt": "a", "duration_sec": 2},
        {"scene": "B", "prompt": "b", "duration_sec": 3, "render_mode": "image_motion"},
    ])
    _confirm_storyboard(client, H, pid)

    r = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H, json={})
    assert r.status_code == 200, r.text
    body = r.json()
    # 两镜均按批量旧语义 2 候选: video=2*10*2*256*256*0.000001, motion=2*0.25
    assert body["work"]["candidate_upper_bound"] == 4
    assert body["work"]["image_motion_count"] == 1
    assert body["pricing"]["status"] == "estimated"
    assert body["pricing"]["total"] == "3.121440"
    assert body["pricing"]["currency"] == "CNY"
    assert body["budget"]["status"] == "within"
    assert body["budget"]["currency"] == "CNY"

    again = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H, json={"wait": False})
    assert again.json()["input_fingerprint"] == body["input_fingerprint"], "wait 不影响估算"
    changed = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H, json={"pipeline": "c"})
    assert changed.json()["input_fingerprint"] != body["input_fingerprint"]

    assert client.post(
        f"/api/studio/shots/{video['id']}/render-estimate", headers=_h(other_token)
    ).status_code == 404
    assert client.post(
        f"/api/studio/projects/{pid}/render-estimate", headers=_h(other_token)
    ).status_code == 404


def test_unknown_component_never_partial_sum_and_budget_admission(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _project(client, H)
    _shots(client, H, pid, [
        {"scene": "A", "prompt": "a"},
        {"scene": "B", "prompt": "b", "render_mode": "image_motion"},
    ])
    _confirm_storyboard(client, H, pid)
    _rates(monkeypatch, json.dumps({
        "currency": "CNY", "rates": {"h3:video:ref2va": {"pixel_frame": "0.01"}}
    }), budget="1")

    r = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H, json={})
    assert r.status_code == 200
    body = r.json()
    assert body["pricing"]["status"] == "unpriced" and body["pricing"]["total"] is None
    assert "h3:image_motion:ref2va" in body["pricing"]["unknowns"]
    assert body["budget"]["status"] == "unpriced"
    assert body["allowed"] is False
    assert any(b["code"] == "COST_UNPRICED" for b in body["blockers"])

    submit = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert submit.status_code == 409 and "核价" in submit.json()["detail"]


def test_budget_exceeded_blocks_and_bad_config_is_503(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _project(client, H)
    shot = _shots(client, H, pid, [{"scene": "A", "prompt": "a", "duration_sec": 1}])[0]
    configured = json.dumps({"currency": "CNY", "rates": {"h3:video:ref2va": {"candidate": "2.50"}}})
    _rates(monkeypatch, configured, budget="1.00")
    preview = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H)
    assert preview.status_code == 200
    assert preview.json()["budget"]["status"] == "exceeded"
    assert preview.json()["allowed"] is False
    assert any(b["code"] == "RENDER_BUDGET_EXCEEDED" for b in preview.json()["blockers"])
    submit = client.post(f"/api/studio/shots/{shot['id']}/render", headers=H)
    assert submit.status_code == 409 and "预算" in submit.json()["detail"]

    for bad in ("{", json.dumps({"currency": "CNY", "rates": {"h3:video:ref2va": {"candidate": "-1"}}}),
                json.dumps({"currency": "CNY", "rates": {"h3:video:ref2va": {"candidate": "NaN"}}}),
                json.dumps({"currency": "not-a-currency", "rates": {}})):
        _rates(monkeypatch, bad)
        r = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H)
        assert r.status_code == 503, (bad, r.text)


def test_empty_batch_stays_allowed_even_with_unpriced_budget(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _rates(monkeypatch, budget="10")
    pid = _project(client, H)
    preview = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H)
    assert preview.status_code == 200, preview.text
    assert preview.json()["work"]["shot_count"] == 0
    assert preview.json()["allowed"] is True
    assert preview.json()["pricing"]["status"] == "unpriced"
    assert preview.json()["pricing"]["unknowns"]
    submit = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert submit.status_code == 202, submit.text


def test_keyframe_and_storyboard_blockers_match_submit(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    _rates(monkeypatch)
    pid = _project(client, H, preferred_drive_mode="keyframe")
    shot = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]
    preview = client.post(f"/api/studio/shots/{shot['id']}/render-estimate", headers=H)
    assert preview.status_code == 200 and preview.json()["allowed"] is False
    assert preview.json()["blockers"][0]["code"] == "KEYFRAME_REQUIRED"
    submit = client.post(f"/api/studio/shots/{shot['id']}/render", headers=H)
    assert submit.status_code == 422 and submit.json()["detail"]["code"] == "KEYFRAME_REQUIRED"

    batch_preview = client.post(f"/api/studio/projects/{pid}/render-estimate", headers=H)
    codes = {b["code"] for b in batch_preview.json()["blockers"]}
    assert {"KEYFRAME_REQUIRED", "STORYBOARD_NOT_CONFIRMED"} <= codes


def test_submit_recomputes_and_persists_estimate_snapshots(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    _rates(monkeypatch, json.dumps({
        "currency": "CNY", "rates": {"h3:video:ref2va": {"candidate": "0.5"}}
    }))
    pid = _project(client, H)
    shot = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]

    class FakeRenderer:
        name = "video"

        async def render(self, shot, cast, pool, **kw):
            return SimpleNamespace(kind="video", url="/api/studio/files/x.mp4", pipeline_meta={})

    monkeypatch.setattr(orch, "get_renderer", lambda shot: FakeRenderer())
    r = client.post(
        f"/api/studio/shots/{shot['id']}/render", headers=H,
        json={"num_candidates": 1, "wait": True, "input_fingerprint": "forged", "pricing": {"total": "0"}},
    )
    # 前端伪造的额外价格/fingerprint 字段不被信任；服务端仍以当前输入重算。
    assert r.status_code == 200, r.text
    with Session(engine) as s:
        rev = s.exec(select(StudioShotRevision).where(StudioShotRevision.source == "render")).first()
        content = json.loads(rev.content_json)
        estimate = content["render_params"]["estimate"]
        assert estimate["input_fingerprint"] and estimate["pricing"]["total"] == "0.5"
        assert "env" not in json.dumps(estimate).lower()

    _confirm_storyboard(client, H, pid)
    # 恢复 draft 以形成实际待渲染批次；后台渲染替身不调用模型。
    with Session(engine) as s:
        sh = s.get(StudioShot, shot["id"])
        sh.status = "draft"
        s.add(sh)
        s.commit()

    async def ok(session, shot, pool=None, request=None, **kw):
        shot.status = "rendered"
        session.add(shot)
        session.commit()
        return shot

    monkeypatch.setattr(orch, "render_shot", ok)
    r = client.post(f"/api/studio/projects/{pid}/render", headers=H, json={"wait": False})
    assert r.status_code == 202, r.text
    with Session(engine) as s:
        job = s.get(Job, r.json()["job_id"])
        params = json.loads(job.params)
        assert params["estimate"]["work"]["shot_count"] == 1
        assert params["estimate"]["pricing"]["total"] == "1.0"
        assert params["estimate"]["budget"]["status"] == "disabled"
        assert params["estimate"]["input_fingerprint"]


def _estimate_shot(client, H, sid):
    r = client.post(f"/api/studio/shots/{sid}/render-estimate", headers=H)
    assert r.status_code == 200, r.text
    return r.json()


def test_fingerprint_tracks_drive_mode_and_image_url_without_revision_change(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    _rates(monkeypatch)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    base = _estimate_shot(client, H, sid)

    with Session(engine) as s:
        project = s.get(StudioProject, pid)
        revision = int(project.stage_revision)
        project.preferred_drive_mode = "keyframe"
        s.add(project)
        s.commit()
    changed_drive = _estimate_shot(client, H, sid)
    assert changed_drive["input_fingerprint"] != base["input_fingerprint"]
    assert changed_drive["blockers"][0]["stage"] == "storyboard"
    with Session(engine) as s:
        assert int(s.get(StudioProject, pid).stage_revision) == revision

    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        current_revision = shot.current_revision_id
        shot.image_url = "/api/studio/files/keyframe.png?sig=private"
        s.add(shot)
        s.commit()
    changed_image = _estimate_shot(client, H, sid)
    assert changed_image["input_fingerprint"] != changed_drive["input_fingerprint"]
    assert changed_image["allowed"] is True
    assert "keyframe.png" not in json.dumps(changed_image)
    assert "sig=private" not in json.dumps(changed_image)
    with Session(engine) as s:
        assert s.get(StudioShot, sid).current_revision_id == current_revision


def test_fingerprint_tracks_effective_engine_when_body_omits_it(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    _rates(monkeypatch)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    base = _estimate_shot(client, H, sid)
    assert base["items"][0]["engine"] == "h3"
    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        shot.video_model = "ltx"
        s.add(shot)
        s.commit()
    changed = _estimate_shot(client, H, sid)
    assert changed["items"][0]["engine"] == "ltx"
    assert changed["input_fingerprint"] != base["input_fingerprint"]


def test_fingerprint_tracks_normalized_effective_reference_inputs(ctx, monkeypatch):
    client, token, _, engine = ctx
    H = _h(token)
    _rates(monkeypatch)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    previous = _estimate_shot(client, H, sid)
    mutations = [
        ("shot", "ref_images_json", json.dumps(["/api/studio/files/private-ref.png"])),
        ("shot", "scene_ref_json", json.dumps({"anchor_image": "/api/studio/files/private-anchor.png", "z": 1})),
        ("project", "scene_images_json", json.dumps(["/api/studio/files/private-scene.png"])),
        ("project", "style", "anime"),
        ("project", "ckpt_name", "private-model.ckpt"),
    ]
    for owner, field, value in mutations:
        with Session(engine) as s:
            row = s.get(StudioShot if owner == "shot" else StudioProject, sid if owner == "shot" else pid)
            setattr(row, field, value)
            s.add(row)
            s.commit()
        current = _estimate_shot(client, H, sid)
        assert current["input_fingerprint"] != previous["input_fingerprint"], (owner, field)
        assert "private-" not in json.dumps(current)
        previous = current

    # 同一 JSON 对象的键序/空白不是输入变化，媒体数组顺序则有语义、不得排序。
    with Session(engine) as s:
        shot = s.get(StudioShot, sid)
        shot.scene_ref_json = '{ "z": 1, "anchor_image": "/api/studio/files/private-anchor.png" }'
        s.add(shot)
        s.commit()
    assert _estimate_shot(client, H, sid)["input_fingerprint"] == previous["input_fingerprint"]


def test_fingerprint_rate_config_order_is_deterministic(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    first = {"currency": "CNY", "rates": {
        "h3:video": {"candidate": "1"}, "ltx:video:legacy": {"pixel_frame": "0.1"},
    }}
    second = {"rates": {
        "ltx:video:legacy": {"pixel_frame": "0.1"}, "h3:video": {"candidate": "1"},
    }, "currency": "CNY"}
    _rates(monkeypatch, json.dumps(first))
    base = _estimate_shot(client, H, sid)
    _rates(monkeypatch, json.dumps(second))
    assert _estimate_shot(client, H, sid)["input_fingerprint"] == base["input_fingerprint"]


@pytest.mark.parametrize("key", [
    "h3:video:ref2va:extra", "h3:audio", "h3:video:nope",
    "wan:video", "h3", "h3:video:",
])
def test_invalid_rate_key_shape_is_503(ctx, monkeypatch, key):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    _rates(monkeypatch, json.dumps({"currency": "CNY", "rates": {key: {}}}))
    r = client.post(f"/api/studio/shots/{sid}/render-estimate", headers=H)
    assert r.status_code == 503, r.text


def test_empty_rate_components_are_explicit_zero_price(ctx, monkeypatch):
    client, token, _, _ = ctx
    H = _h(token)
    pid = _project(client, H)
    sid = _shots(client, H, pid, [{"scene": "A", "prompt": "a"}])[0]["id"]
    _rates(monkeypatch, json.dumps({"currency": "CNY", "rates": {"h3:video:ref2va": {}}}))
    body = _estimate_shot(client, H, sid)
    assert body["pricing"]["status"] == "estimated"
    assert body["pricing"]["total"] == "0"
    assert body["pricing"]["unknowns"] == []
    assert body["allowed"] is True
