"""candidates_json 必须按 JSON 字符串读写（VARCHAR 列，禁止 jsonb ||）。"""
from __future__ import annotations

import json

from app.services.studio.candidates_json import (
    append_candidates,
    append_failure,
    dumps_candidates,
    loads_candidates,
)


def test_loads_bad_and_non_list():
    assert loads_candidates(None) == []
    assert loads_candidates("") == []
    assert loads_candidates("not-json") == []
    assert loads_candidates('{"a":1}') == []


def test_append_preserves_prior_and_returns_str():
    prior = dumps_candidates([{"id": "a", "status": "done", "is_picked": True, "url": "/x.mp4"}])
    out = append_candidates(prior, [{"id": "b", "status": "done", "is_picked": False, "url": "/y.mp4"}])
    assert isinstance(out, str)
    rows = json.loads(out)
    assert len(rows) == 2
    assert rows[0]["id"] == "a" and rows[0]["is_picked"] is True
    assert rows[1]["id"] == "b"


def test_append_failure_keeps_picked():
    prior = '[{"id":"picked","status":"done","is_picked":true,"url":"/v.mp4"}]'
    out = append_failure(prior, err_msg="face gate", video_model="h3")
    rows = json.loads(out)
    assert rows[0]["is_picked"] is True
    assert rows[-1]["status"] == "error"
    assert "face gate" in rows[-1]["error"]


def test_roundtrip_orm_shape_matches_varchar():
    """模拟 ORM 写入：值必须是 str，json.loads 后再 dumps 不丢字段。"""
    raw = append_candidates("[]", [{"id": "c1", "url": "/c.mp4", "seed": 1, "status": "done", "is_picked": False}])
    assert isinstance(raw, str)
    again = dumps_candidates(loads_candidates(raw))
    assert json.loads(again)[0]["id"] == "c1"
