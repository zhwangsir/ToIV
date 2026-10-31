"""FU1 词锚时间轴:投影与改词重排纯函数。"""

import json

import pytest

from app.services.svml_timeline import (
    estimate_beat_sec,
    parse_beats_json,
    project_timeline,
    reflow_beats,
)


def test_project_timeline_orders_and_covers():
    beats = [
        {"text": "别跟着我。", "cues": [], "anchor_words": ""},
        {"text": "猛地回头", "cues": ["回头"], "anchor_words": "猛地回头"},
        {"text": "别跟着我。", "cues": ["回头"], "anchor_words": ""},
    ]
    tl = project_timeline(beats)
    assert tl["duration_sec"] >= 3
    assert len(tl["beats"]) == 3
    prev_end = 0.0
    for b in tl["beats"]:
        assert b["start_sec"] == prev_end or abs(b["start_sec"] - prev_end) < 0.05
        assert b["end_sec"] > b["start_sec"]
        prev_end = b["end_sec"]


def test_reflow_keeps_cues_and_shifts_texts():
    beats = [
        {"text": "甲", "cues": ["a"], "anchor_words": "甲"},
        {"text": "乙乙乙乙", "cues": [], "anchor_words": ""},
    ]
    out = reflow_beats(beats, new_texts=["新的短句", "乙"], total_sec=10)
    assert out["duration_sec"] == 10
    assert out["beats"][0]["text"] == "新的短句"
    assert out["beats"][0]["cues"] == ["a"]
    assert out["beats"][0]["anchor_words"] == "甲"
    assert out["beats"][1]["text"] == "乙"


def test_reflow_rejects_length_mismatch():
    import pytest

    with pytest.raises(ValueError):
        reflow_beats([{"text": "x", "cues": [], "anchor_words": ""}], new_texts=["a", "b"])


def test_estimate_and_parse():
    assert estimate_beat_sec("") >= 2
    assert estimate_beat_sec("这是一段比较长的台词内容啊") > 2
    parsed = parse_beats_json('[{"text":"hi","cues":["c"],"anchor_words":"hi"}]')
    assert parsed[0]["cues"] == ["c"]
    assert parse_beats_json("") == []
    assert parse_beats_json("not-json") == []


def assert_coverage(timeline, count):
    assert 3 <= timeline["duration_sec"] <= 60
    assert len(timeline["beats"]) == count
    cursor = 0
    for beat in timeline["beats"]:
        assert beat["start_sec"] == cursor
        assert beat["end_sec"] > cursor
        assert beat["est_sec"] == pytest.approx(beat["end_sec"] - cursor, abs=1e-6)
        cursor = beat["end_sec"]
    if count:
        assert cursor == timeline["duration_sec"]


@pytest.mark.parametrize("texts", [["短"], ["字" * 11], ["字" * 100] * 200, ["短", "字" * 10000]])
def test_projection_covers_clamped_and_rounded_duration(texts):
    beats = [{"text": text} for text in texts]
    projected = project_timeline(beats)
    assert_coverage(projected, len(beats))
    assert projected == reflow_beats(beats)


@pytest.mark.parametrize("total,expected", [(1, 3), (3, 3), (12, 12), (60, 60), (999, 60)])
@pytest.mark.parametrize("texts", [["短"], ["短", "字" * 10000], ["短"] * 200])
def test_explicit_duration_overrides_individual_estimate_limits(total, expected, texts):
    result = reflow_beats([{"text": t} for t in texts], total_sec=total)
    assert result["duration_sec"] == expected
    assert_coverage(result, len(texts))
    assert project_timeline(result["beats"], total_sec=total) == result


def test_blank_edit_preserves_all_beats_and_anchors_across_reload():
    original = [
        {"text": "短", "cues": ["转场"], "anchor_words": ""},
        {"text": "后退", "cues": ["动作"], "anchor_words": "后退"},
        {"text": "空拍", "cues": [], "anchor_words": ""},
    ]
    result = reflow_beats(original, new_texts=["  ", "", ""], total_sec=3)
    parsed = parse_beats_json(json.dumps(result["beats"]))
    assert len(parsed) == 3
    assert [b["cues"] for b in parsed] == [["转场"], ["动作"], []]
    assert parsed[1]["anchor_words"] == "后退"
    assert_coverage(reflow_beats(parsed, new_texts=["新词", "", ""], total_sec=3), 3)
    assert original[0]["text"] == "短"


def test_anchor_annotation_does_not_double_count_spoken_text():
    assert estimate_beat_sec("字" * 42, anchors="字" * 42) == 10


def test_reflow_endpoint_persists():
    """改词重排端点:持久化 beats 与 duration(独立 TestClient,与 test_studio_svml_import 同型)。"""
    from fastapi.testclient import TestClient
    from sqlalchemy.pool import StaticPool
    from sqlmodel import Session, SQLModel, create_engine

    from app.db import get_session
    from app.main import app
    from app.models import Tenant, User
    from app.security import create_token, hash_password

    engine = create_engine(
        "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
    )
    SQLModel.metadata.create_all(engine)

    def override():
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    try:
        with Session(engine) as s:
            tenant = Tenant(name="d")
            s.add(tenant)
            s.commit()
            s.refresh(tenant)
            user = User(
                email="d@toiv.ai",
                hashed_password=hash_password("password1"),
                tenant_id=tenant.id,
            )
            s.add(user)
            s.commit()
            s.refresh(user)
            tok = create_token(user.id)
        client = TestClient(app)
        h = {"Authorization": f"Bearer {tok}"}
        pid = client.post("/api/studio/projects", headers=h, json={"title": "reflow"}).json()["id"]
        beats = [
            {"text": "短", "cues": ["a"], "anchor_words": "短", "kind": "d"},
            {"text": "比较长的一句台词啊", "cues": [], "anchor_words": "", "kind": "d"},
        ]
        r = client.put(
            f"/api/studio/projects/{pid}/shots",
            headers=h,
            json={"shots": [{"scene": "s", "prompt": "p", "dialogue": "短", "duration_sec": 6, "beats": beats}]},
        )
        assert r.status_code == 200, r.text
        shot = r.json()["shots"][0]
        assert shot.get("beats"), shot
        r = client.post(
            f"/api/studio/shots/{shot['id']}/reflow-beats",
            headers=h,
            json={"texts": ["换了更长的台词内容啊", "短"], "total_sec": 12},
        )
        assert r.status_code == 200, r.text
        body = r.json()
        assert body["updated_at"] > shot["updated_at"]
        assert body["duration_sec"] == 12
        assert body["beats"][0]["text"] == "换了更长的台词内容啊"
        assert body["beats"][0]["cues"] == ["a"]
    finally:
        app.dependency_overrides.clear()
