"""FU4 文件即记忆 + plan→build→get + known-errors 测试。

覆盖:
  · ProjectMemory 四文档(Brief/Treatment/Analysis/Progress)模型校验与 render 关键段
  · serialize/deserialize JSON 落库形状与跨会话续接(无进程内状态)
  · 存储回调 save() 行为
  · plan→build→get 状态机:拓扑排序/环检测/步数上限/失败保留已产出
  · 产物候选按哈希/URL 键显式复用
  · known-errors 条目模型校验 + render_skill_md 含三段式 + 三域种子数据
"""
from __future__ import annotations

import json

import pytest

from app.services.memory.known_errors import (
    SEED_ENTRIES,
    KnownError,
    render_skill_md,
)
from app.services.memory.plan_build_get import (
    Artifact,
    PlanError,
    ReuseCandidate,
    Step,
    StepResult,
    build,
    get,
    plan,
)
from app.services.memory.project_memory import MemoryError, ProjectMemory

# ---------------------------------------------------------------- project_memory


def test_init_seeds_brief_and_render_has_key_sections():
    m = ProjectMemory.init("p1", "雨夜追凶", "一句话前提:女主追查失踪的姐姐")
    assert m.project_id == "p1"
    assert "女主追查" in m.brief
    out = m.render()
    for head in ("# 雨夜追凶", "## Brief", "## Treatment", "## Analysis", "## Progress"):
        assert head in out


def test_init_rejects_empty_identity():
    with pytest.raises(MemoryError):
        ProjectMemory.init("", "t", "p")
    with pytest.raises(MemoryError):
        ProjectMemory.init("p1", "", "p")


def test_update_section_and_unknown_section_rejected():
    m = ProjectMemory.init("p1", "t", "premise")
    m.update("treatment", "导演阐述:冷色影调")
    assert "冷色影调" in m.render()
    with pytest.raises(MemoryError):
        m.update("timeline", "无关段")
    with pytest.raises(MemoryError):
        m.update("brief", 123)  # type: ignore[arg-type]


def test_serialize_deserialize_roundtrip_and_cross_session_resume():
    m = ProjectMemory.init("p1", "t", "premise")
    m.update("analysis", "节奏分析:前三镜必须留白")
    raw = m.serialize()
    data = json.loads(raw)
    assert data["project_id"] == "p1"
    assert set(data) >= {"brief", "treatment", "analysis", "progress"}
    # 模拟「新会话」:只拿 JSON 字符串恢复,不依赖任何进程内状态
    m2 = ProjectMemory.deserialize(raw)
    assert m2.project_id == m.project_id
    assert m2.analysis == "节奏分析:前三镜必须留白"
    m2.update("progress", "已完成 2/6 镜")
    assert "2/6" in m2.render()
    assert "前三镜必须留白" in m2.render()  # 旧内容保留


def test_deserialize_rejects_bad_shape():
    with pytest.raises(MemoryError):
        ProjectMemory.deserialize("not json")
    with pytest.raises(MemoryError):
        ProjectMemory.deserialize(json.dumps({"title": "缺 project_id"}))
    with pytest.raises(MemoryError):
        ProjectMemory.deserialize(json.dumps({"project_id": "p", "title": 5}))


def test_save_uses_storage_callback_and_requires_one():
    saved: list[str] = []
    m = ProjectMemory.init("p1", "t", "premise", on_save=saved.append)
    m.update("progress", "开工")
    m.save()
    assert saved and json.loads(saved[0])["progress"] == "开工"
    m2 = ProjectMemory.init("p2", "t2", "p")
    with pytest.raises(MemoryError):
        m2.save()


# ---------------------------------------------------------------- plan_build_get


def test_plan_topological_order_and_basic_shape():
    p = plan(
        [
            Step(id="compose", depends_on=("voice", "render")),
            Step(id="voice", depends_on=("shots",)),
            Step(id="render", depends_on=("shots",)),
            Step(id="shots"),
        ]
    )
    ids = [s.id for s in p.steps]
    assert ids.index("shots") < ids.index("voice")
    assert ids.index("shots") < ids.index("render")
    assert ids.index("voice") < ids.index("compose")
    assert ids.index("render") < ids.index("compose")


def test_plan_detects_cycle():
    with pytest.raises(PlanError):
        plan(
            [
                Step(id="a", depends_on=("b",)),
                Step(id="b", depends_on=("a",)),
            ]
        )


def test_plan_rejects_dup_missing_dep_and_step_limit():
    with pytest.raises(PlanError):
        plan([Step(id="a"), Step(id="a")])
    with pytest.raises(PlanError):
        plan([Step(id="a", depends_on=("ghost",))])
    with pytest.raises(PlanError):
        plan([Step(id=f"s{i}") for i in range(5)], max_steps=3)


def test_build_failure_keeps_completed_and_partial_artifacts():
    p = plan([Step(id="a"), Step(id="b"), Step(id="c")])
    result = build(
        p,
        {
            "a": StepResult(ok=True, artifacts=(Artifact(key="ka", url="u://a"),)),
            "b": StepResult(
                ok=False,
                artifacts=(Artifact(key="kb", hash="h-b"),),
                error="boom",
            ),
            "c": StepResult(ok=True, artifacts=(Artifact(key="kc", url="u://c"),)),
        },
    )
    assert result.failed_step == "b"
    assert result.completed == ("a",)
    keys = {a.key for a in result.artifacts}
    # 失败步的已产出保留,已完成步产物不清;失败步之后的不执行
    assert keys == {"ka", "kb"}
    assert result.pending == ("c",)


def test_build_partial_without_failure_result():
    p = plan([Step(id="a"), Step(id="b")])
    result = build(p, {"a": StepResult(ok=True, artifacts=(Artifact(key="ka"),))})
    assert result.failed_step is None
    assert result.pending == ("b",)
    with pytest.raises(PlanError):
        build(p, {"ghost": StepResult(ok=True)})


def test_get_reuses_candidates_by_hash_or_url_key():
    p = plan([Step(id="a"), Step(id="b")])
    result = build(
        p,
        {
            "a": StepResult(ok=True, artifacts=(Artifact(key="ka", hash="h1", url="u://a"),)),
            "b": StepResult(ok=True, artifacts=(Artifact(key="kb", url="u://b"),)),
        },
    )
    reused = get(
        result,
        [
            ReuseCandidate(hash="h1"),
            ReuseCandidate(url="u://b"),
            ReuseCandidate(url="u://missing"),
        ],
    )
    assert [a.key for a in reused] == ["ka", "kb"]
    # 显式复用:无哈希/URL 键的候选不命中
    assert get(result, [ReuseCandidate()]) == ()
    assert get(result, [ReuseCandidate(hash="other")]) == ()


# ---------------------------------------------------------------- known_errors


def test_known_error_model_validation():
    with pytest.raises(ValueError):
        KnownError(
            domain="",
            title="t",
            symptom="s",
            root_cause="r",
            verification="v",
        )
    with pytest.raises(ValueError):
        KnownError(
            domain="d",
            title="t",
            symptom="s",
            root_cause="r",
            verification="",
        )


def test_render_skill_md_has_three_parts_and_seed_domains():
    md = render_skill_md(SEED_ENTRIES)
    for marker in ("Symptom", "Root cause", "Verification"):
        assert marker in md
    for domain in ("comfy-worker", "face-gate", "svml-import"):
        assert domain in md
    assert all(e.domain in {"comfy-worker", "face-gate", "svml-import"} for e in SEED_ENTRIES)
    assert {e.domain for e in SEED_ENTRIES} == {"comfy-worker", "face-gate", "svml-import"}


def test_render_skill_md_accepts_custom_entries():
    e = KnownError(
        domain="demo-domain",
        title="示例条目",
        symptom="现象描述",
        root_cause="根因描述",
        verification="验证步骤",
    )
    md = render_skill_md([e])
    assert "demo-domain" in md
    assert "现象描述" in md and "根因描述" in md and "验证步骤" in md
