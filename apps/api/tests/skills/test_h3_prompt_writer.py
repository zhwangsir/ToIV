"""h3-prompt-writer 正典技能测试。

· evals/cases.json 全量驱动:对 render() 产物做确定性结构断言(不调 LLM);
· 正典正文契约:节奏预算表全档位数字、三流程规则键、@图片N 规则、9:16 构图、
  全正向原则与「严格限制负向块」实验注记;
· 5s→6s 固化:6s 档存在,正文+描述无任何旧 5s 档残留。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.skills.registry import skills_registry

_SKILL_NAME = "h3-prompt-writer"


@pytest.fixture(scope="module")
def skill():
    s = skills_registry.get(_SKILL_NAME)
    assert s is not None, "正典技能未注册"
    return s


@pytest.fixture(scope="module")
def cases(skill):
    cases_path = Path(skill.path).parent / "evals" / "cases.json"
    return json.loads(cases_path.read_text(encoding="utf-8"))


def test_frontmatter_contract(skill):
    assert skill.kind == "prompt-writer"
    for t in ("MiniMax H3", "H3提示词", "视频提示词", "文戏", "武戏", "九宫格", "分镜提示词"):
        assert t in skill.triggers
    for k in ("duration", "aspect", "flow", "story", "images", "style"):
        assert k in skill.inputs
    assert skill.outputs  # 交付物清单非空
    assert skill.version == "1.0.0"
    assert skill.author == "dgmt"


# ── 节奏预算表:全档位数字逐一钉死 ────────────────────────────────────────
_BUDGET_TOKENS = [
    "| 项 | 6s | 10s | 15s |",  # 表头三档
    "3—5", "5—7", "6—8",  # 文戏段落数
    "0.5—1.2", "0.4—0.8",  # 文戏结尾余波(6s/15s 同为 0.5—1.2)
    "14—20", "10—16", "因果链",  # 武戏有效动作
    "≤0.5", "0.20—0.35",  # 武戏开场起势
    "≤0.6", "关键接触",  # 武戏慢动作
    "1.5—2.5", "3—6", "1.2—2.0", "同 10s",  # 武戏单段串联
    "≤0.3", "0.20—0.30",  # 武戏结尾定格
    "0.5—0.6", "0.8—1.3", "1.2—1.8",  # 九宫格每格时长
]


def test_budget_table_all_durations(skill):
    for token in _BUDGET_TOKENS:
        assert token in skill.body, f"节奏预算表缺档位数字: {token}"


def test_three_flows_rule_keys(skill):
    for key in ("## 入口", "## 流程一:文戏", "## 流程二:武戏", "阶段 A", "阶段 B",
                "## 修改规则", "交付前自检", "全正向"):
        assert key in skill.body, f"缺章节/规则键: {key}"


def test_image_ref_rules(skill):
    """txt 版 @图片N 规则完整并入:绝对开头示例、紧贴对象、九宫格引用写法。"""
    assert "@图片1作为主角身份与服装参考@图片2作为对手身份与装备参考@图片3作为场景与光影参考" in skill.body
    assert "绝对开头" in skill.body
    assert "（@图片1）" in skill.body
    assert "九宫格时序、构图与画面状态参考" in skill.body


def test_portrait_aspect_rules(skill):
    """画幅参数化:9:16 竖屏构图注意(负空间上下分布、主体中轴、安全区)。"""
    for key in ("9:16", "16:9", "负空间", "中轴", "安全区", "1152×2048", "2048×1152"):
        assert key in skill.body


def test_negative_block_note(skill):
    """全正向原则 + 「严格限制负向块」对比实验注记,结论经 evals 回写。"""
    assert "全正向" in skill.body
    assert "负向" in skill.body and "evals" in skill.body


def test_6s_solidified_no_legacy_5s(skill):
    text = skill.body + "\n" + skill.description
    assert "生成一段5秒" not in text
    assert "minimax-h3-5s" not in text
    assert not re.search(r"(?<![\d.])5\s*秒", text), "存在独立 5 秒表述残留"
    assert not re.search(r"(?<![\d.])5s(?![\w])", text), "存在独立 5s 表述残留"


# ── evals:cases.json 全量,确定性结构断言 ────────────────────────────────
def test_evals_cases(skill, cases):
    assert cases["skill"] == _SKILL_NAME
    assert len(cases["cases"]) >= 6
    for case in cases["cases"]:
        out = skills_registry.render(_SKILL_NAME, **case["input"])
        for token in case["expect"].get("contains", []):
            assert token in out, f"{case['id']}: 缺 {token!r}"
        for token in case["expect"].get("not_contains", []):
            assert token not in out, f"{case['id']}: 不应出现 {token!r}"
