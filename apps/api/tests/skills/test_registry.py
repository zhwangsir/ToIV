"""app.skills.registry 加载器契约测试。

契约钉死(下游 Team B/C 依赖,命名不可改):
  · skills_registry.list()              -> list[Skill],按 name 排序
  · skills_registry.get(name)           -> Skill | None,未知名 None
  · skills_registry.render(name, **slots) -> str,{{slot}} 替换;
    未提供的 slot 保留 {{…}} 原文;未知名抛 KeyError。

覆盖:frontmatter 字段解析、缺 name/无 frontmatter 跳过、list 排序、
get 未知名回退 None、render 槽位替换与保留、单例加载正典技能。
"""
from __future__ import annotations

import pytest

from app.skills.registry import Skill, SkillsRegistry, skills_registry

_SAMPLE = """---
name: demo-skill
description: 演示技能
kind: template
triggers: [甲, 乙]
inputs: {topic: "主题"}
outputs: ["一份结果"]
version: 0.1.0
author: tester
---

# 正文

首行 {{topic}} 与 {{missing}}。
"""


def _write(root, dirname: str, text: str) -> None:
    d = root / dirname
    d.mkdir(parents=True)
    (d / "SKILL.md").write_text(text, encoding="utf-8")


def test_frontmatter_parse(tmp_path):
    _write(tmp_path, "demo", _SAMPLE)
    skill = SkillsRegistry(root=tmp_path).get("demo-skill")
    assert isinstance(skill, Skill)
    assert skill.description == "演示技能"
    assert skill.kind == "template"
    assert skill.triggers == ["甲", "乙"]
    assert skill.inputs == {"topic": "主题"}
    assert skill.outputs == ["一份结果"]
    assert skill.version == "0.1.0"
    assert skill.author == "tester"
    assert skill.body.startswith("\n# 正文")  # frontmatter 之后的 markdown 正文
    assert skill.path.endswith("demo/SKILL.md")


def test_list_sorted_and_skip_invalid(tmp_path):
    _write(tmp_path, "b", _SAMPLE.replace("demo-skill", "beta"))
    _write(tmp_path, "a", _SAMPLE.replace("demo-skill", "alpha"))
    _write(tmp_path, "bad", "no frontmatter at all")
    _write(tmp_path, "noname", "---\ndescription: 缺 name\n---\n正文")
    reg = SkillsRegistry(root=tmp_path)
    assert [s.name for s in reg.list()] == ["alpha", "beta"]  # 排序 + 两个非法文件被跳过
    assert reg.get("不存在") is None  # 未知名回退 None


def test_render_slots(tmp_path):
    _write(tmp_path, "demo", _SAMPLE)
    reg = SkillsRegistry(root=tmp_path)
    out = reg.render("demo-skill", topic="太刀")
    assert "首行 太刀 与 {{missing}}。" in out  # 已提供替换;未提供槽位保留 {{…}} 原文
    with pytest.raises(KeyError):
        reg.render("不存在")


def test_singleton_loads_canon():
    """模块级单例扫描 app/skills/,正典技能必须在册且契约字段齐备。"""
    assert "h3-prompt-writer" in [s.name for s in skills_registry.list()]
    skill = skills_registry.get("h3-prompt-writer")
    assert skill.kind == "prompt-writer"
    assert "{{duration}}" in skill.body
