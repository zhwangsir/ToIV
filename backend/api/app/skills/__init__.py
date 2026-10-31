"""技能正典包:扫描 app/skills/*/SKILL.md,向 Agent/路由层提供稳定契约。

下游(Team B/C/D)调用方式,命名钉死:

    from app.skills.registry import skills_registry
    skills_registry.list()                   # -> list[Skill]
    skills_registry.get("h3-prompt-writer")  # -> Skill | None
    skills_registry.render("h3-prompt-writer", duration=10, aspect="16:9")  # -> str
"""
from __future__ import annotations

from .registry import Skill, SkillsRegistry, skills_registry

__all__ = ["Skill", "SkillsRegistry", "skills_registry"]
