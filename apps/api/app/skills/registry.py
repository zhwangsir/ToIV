"""技能正典注册表(P0)。

扫描 app/skills/*/SKILL.md,YAML frontmatter 解析为 Skill dataclass,
body 为 frontmatter 之后的 markdown 正文(原样保留,含 {{slot}} 占位)。

契约(钉死,下游 Team B/C 按此调用):
  · skills_registry.list()              -> list[Skill],按 name 排序
  · skills_registry.get(name)           -> Skill | None,未知名返回 None
  · skills_registry.render(name, **slots) -> str
      body 内 {{slot}} 占位替换为传入值;未提供的 slot 保留 {{…}} 原文;
      未知名抛 KeyError(调用方先 get 判空)。

frontmatter 解析用 pyyaml(requirements.txt 已钉 pyyaml==6.0.3);
解析失败或缺 name 的 SKILL.md 直接跳过,不拖垮注册表。
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

import yaml

_SKILLS_ROOT = Path(__file__).resolve().parent
_FRONTMATTER_RE = re.compile(r"\A---[ \t]*\n(.*?)\n---[ \t]*\n", re.DOTALL)
_SLOT_RE = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")


@dataclass(frozen=True)
class Skill:
    """一个正典技能:frontmatter 元数据 + markdown 正文。

    kind 取值:prompt-writer(提示词编写) | modifier(修改器) | template(模板)。
    """

    name: str
    description: str = ""
    triggers: list[str] = field(default_factory=list)
    inputs: dict[str, str] = field(default_factory=dict)
    outputs: list[str] = field(default_factory=list)
    version: str = ""
    author: str = ""
    kind: str = ""
    body: str = ""
    path: str = ""


def _parse_skill_md(md_path: Path) -> Skill | None:
    """解析单个 SKILL.md;缺 frontmatter / frontmatter 非法 / 缺 name 时返回 None。"""
    text = md_path.read_text(encoding="utf-8")
    m = _FRONTMATTER_RE.match(text)
    if not m:
        return None
    meta = yaml.safe_load(m.group(1))
    if not isinstance(meta, dict) or not meta.get("name"):
        return None
    return Skill(
        name=str(meta["name"]),
        description=str(meta.get("description", "")),
        triggers=[str(t) for t in (meta.get("triggers") or [])],
        inputs={str(k): str(v) for k, v in (meta.get("inputs") or {}).items()},
        outputs=[str(o) for o in (meta.get("outputs") or [])],
        version=str(meta.get("version", "")),
        author=str(meta.get("author", "")),
        kind=str(meta.get("kind", "")),
        body=text[m.end():],
        path=str(md_path),
    )


class SkillsRegistry:
    """扫描并持有 skills 根目录下的全部 Skill。契约方法:list / get / render。"""

    def __init__(self, root: Path | str | None = None) -> None:
        self.root = Path(root) if root is not None else _SKILLS_ROOT
        self._skills: dict[str, Skill] = {}
        self._scan()

    def _scan(self) -> None:
        if not self.root.is_dir():
            return
        for md in sorted(self.root.glob("*/SKILL.md")):
            skill = _parse_skill_md(md)
            if skill is not None:
                self._skills[skill.name] = skill

    def list(self) -> list[Skill]:
        """全部技能,按 name 排序,确定性输出。"""
        return [self._skills[k] for k in sorted(self._skills)]

    def get(self, name: str) -> Skill | None:
        """按 name 精确获取;未知名返回 None。"""
        return self._skills.get(name)

    def render(self, name: str, **slots: object) -> str:
        """渲染 body:{{slot}} 替换为传入值;未提供的 slot 保留 {{…}} 原文。

        未知名抛 KeyError——调用方先用 get 判空。
        """
        skill = self._skills.get(name)
        if skill is None:
            raise KeyError(name)

        def _sub(m: re.Match[str]) -> str:
            key = m.group(1)
            return str(slots[key]) if key in slots else m.group(0)

        return _SLOT_RE.sub(_sub, skill.body)


skills_registry = SkillsRegistry()
