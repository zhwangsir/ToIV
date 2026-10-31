"""h3-seam-polish 转场丝滑增强 modifier 正典技能测试。

· frontmatter 契约:kind=modifier、槽位 anchor/direction、版本与作者;
· 正文规则键:三阶段帧数预算、速度继承、单主导机制、人物跨镜连续、太刀稳定轴、
  禁用清单(单一事实源,docs/skill/转场丝滑增强_补充提示词.txt 已并入本技能);
· render 槽位替换:anchor/direction 注入正文,未提供槽位保留 {{…}} 原文。
"""
from __future__ import annotations

import pytest

from app.skills.registry import skills_registry

_SKILL_NAME = "h3-seam-polish"


@pytest.fixture(scope="module")
def skill():
    s = skills_registry.get(_SKILL_NAME)
    assert s is not None, "正典技能未注册"
    return s


def test_frontmatter_contract(skill):
    assert skill.kind == "modifier"
    for t in ("转场", "matchcut", "匹配剪辑"):
        assert t in skill.triggers
    for k in ("anchor", "direction"):
        assert k in skill.inputs
    assert skill.outputs  # 交付物清单非空
    assert skill.version == "1.0.0"
    assert skill.author == "dgmt"


def test_three_phase_frame_budget(skill):
    """三阶段帧数预算:预备 6-8 / 交接 12-18 / 缓冲 6-10。"""
    for token in ("占6至8帧", "占12至18帧", "占6至10帧", "延迟2至3帧"):
        assert token in skill.body, f"缺三阶段帧数预算: {token}"


def test_core_rule_keys(skill):
    """速度继承 / 单主导机制 / 人物跨镜连续 / 太刀稳定轴 / 禁用清单全部在位。"""
    for key in (
        "转场丝滑度最高优先级",
        "速度匹配",
        "只允许一个主导机制",
        "跨镜头连续",
        "最稳定的运动轴",
        "每3秒最多出现一次",
        "不使用闪白",
        "空帧",
        "同一本高级动态艺术杂志",
    ):
        assert key in skill.body, f"缺规则键: {key}"


def test_render_slots_injected(skill):
    out = skills_registry.render(
        _SKILL_NAME, anchor="太刀刀刃", direction="横向"
    )
    assert "太刀刀刃" in out
    assert "横向" in out
    assert "{{anchor}}" not in out and "{{direction}}" not in out


def test_render_missing_slots_kept(skill):
    """未提供的槽位保留 {{…}} 原文(契约:调用方先 get 判空)。"""
    out = skills_registry.render(_SKILL_NAME)
    assert "{{anchor}}" in out and "{{direction}}" in out
