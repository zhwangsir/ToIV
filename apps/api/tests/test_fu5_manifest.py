"""FU5 管线 manifest 声明化测试。

覆盖:
  · stage/skill/produces/success_criteria 声明模型的手写 JSON Schema 等价校验
  · 缺字段/类型错/未知字段/重复 stage id 拒绝
  · drama 合成 6 段(script→assets→shots→render→voice→compose)内置模板可解析
  · checkpoint/history 归档结构 append-only(events 不可变、顺序保留、可序列化)
  · asset manifest id 引用解析(未知 id 报错)
"""
from __future__ import annotations

import pytest

from app.services.pipeline.manifest import (
    DRAMA_COMPOSE_MANIFEST_DICT,
    Event,
    History,
    ManifestError,
    checkpoint_event,
    drama_compose_manifest,
    resolve_asset_refs,
    validate_manifest,
)


def _stage(**over):
    base = {
        "id": "script",
        "skill": "drama.script",
        "produces": ["script_doc"],
        "success_criteria": ["script_doc 非空"],
    }
    base.update(over)
    return base


def _manifest(**over):
    base = {"name": "demo", "stages": [_stage()]}
    base.update(over)
    return base


def test_validate_manifest_rejects_missing_fields():
    with pytest.raises(ManifestError):
        validate_manifest({"stages": [_stage()]})  # 缺 name
    with pytest.raises(ManifestError):
        validate_manifest({"name": "demo"})  # 缺 stages
    for missing in ("id", "skill", "produces", "success_criteria"):
        stage = _stage()
        del stage[missing]
        with pytest.raises(ManifestError):
            validate_manifest({"name": "demo", "stages": [stage]})


def test_validate_manifest_rejects_bad_types_and_unknown_keys():
    with pytest.raises(ManifestError):
        validate_manifest(_manifest(stages=[_stage(produces="script_doc")]))  # 非列表
    with pytest.raises(ManifestError):
        validate_manifest(_manifest(stages=[_stage(success_criteria=[])]))  # 空列表
    with pytest.raises(ManifestError):
        validate_manifest(_manifest(stages=[_stage(id="")]))
    with pytest.raises(ManifestError):
        validate_manifest(_manifest(stages=[_stage(extra="未知字段")]))
    with pytest.raises(ManifestError):
        validate_manifest(_manifest(unknown_top="x"))


def test_validate_manifest_rejects_duplicate_stage_ids():
    with pytest.raises(ManifestError):
        validate_manifest({"name": "demo", "stages": [_stage(), _stage()]})


def test_validate_manifest_returns_typed_model():
    m = validate_manifest(_manifest(stages=[_stage(needs=["upstream_asset"])]))
    assert m.name == "demo"
    assert m.stages[0].skill == "drama.script"
    assert m.stages[0].produces == ("script_doc",)
    assert m.stages[0].success_criteria == ("script_doc 非空",)
    assert m.stages[0].needs == ("upstream_asset",)


def test_drama_compose_template_has_six_ordered_stages():
    m = drama_compose_manifest()
    assert [s.id for s in m.stages] == [
        "script",
        "assets",
        "shots",
        "render",
        "voice",
        "compose",
    ]
    # 内置模板字典本身须过校验(声明化:模板即数据)
    parsed = validate_manifest(DRAMA_COMPOSE_MANIFEST_DICT)
    assert [s.id for s in parsed.stages] == [s.id for s in m.stages]
    for s in m.stages:
        assert s.skill
        assert s.produces
        assert s.success_criteria


def test_history_append_only_and_roundtrip():
    h0 = History()
    e1 = checkpoint_event("script", "done", produced=("script_doc",), at="2026-10-16T00:00:00Z")
    e2 = checkpoint_event("assets", "failed", produced=("hero_ref",), at="2026-10-16T00:01:00Z")
    h1 = h0.append(e1)
    h2 = h1.append(e2)
    # append 返回新实例,旧实例不变(append-only 的可验证形态)
    assert h0.events == ()
    assert len(h1.events) == 1
    assert [e.kind for e in h2.events] == ["checkpoint", "checkpoint"]
    assert h2.events[0].data["stage_id"] == "script"
    assert h2.events[1].data["produced"] == ("hero_ref",)
    # 归档序列化往返保序
    restored = History.from_json(h2.to_json())
    assert [e.data["stage_id"] for e in restored.events] == ["script", "assets"]
    assert restored.events[1].data["status"] == "failed"


def test_event_and_checkpoint_shape():
    ev = Event(kind="note", at="2026-10-16T00:02:00Z", data={"text": "x"})
    assert ev.kind == "note"
    cp = checkpoint_event("render", "running", at="2026-10-16T00:03:00Z")
    assert cp.kind == "checkpoint"
    assert cp.data["stage_id"] == "render"
    assert cp.data["status"] == "running"
    assert cp.data["produced"] == ()


def test_resolve_asset_refs():
    m = validate_manifest(
        _manifest(
            stages=[_stage()],
            assets=[
                {"id": "hero_ref", "kind": "image", "url": "u://hero.png", "hash": "h1"},
                {"id": "voice_ref", "kind": "audio"},
            ],
        )
    )
    got = resolve_asset_refs(m, ["hero_ref", "voice_ref"])
    assert got["hero_ref"].url == "u://hero.png"
    assert got["hero_ref"].hash == "h1"
    assert got["voice_ref"].kind == "audio"
    with pytest.raises(ManifestError):
        resolve_asset_refs(m, ["ghost"])
