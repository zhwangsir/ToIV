"""FU4 短剧项目「文件即记忆」四文档模型(Brief/Treatment/Analysis/Progress)。

设计来源:hypit(修改版 Apache-2.0,单租户本地自用许可,可并码,出处注释保留,
详见 third_party/README.md)的「文件即记忆」理念——项目工作记忆沉淀为
Brief(委托目标)/Treatment(导演阐述)/Analysis(分析结论)/Progress(当前进度)
四份文档,跨会话续接只读文档、不依赖进程内状态。本模块是 ToIV 自研实现:
纯数据模型 + JSON 字符串序列化,不建表、不落库,存储由调用方自带回调。

口径:
- 「任意会话可续接」=全部状态可从 serialize() 的 JSON 字符串恢复,
  模块内无任何可变全局;deserialize() 是唯一恢复入口。
- update() 只改内存;落库由调用方在 save() 时经 on_save 回调完成,
  回调拿到的就是 serialize() 的 JSON 字符串(可直接写 TEXT/JSONB 列)。
"""
from __future__ import annotations

import json
from dataclasses import dataclass, field
from typing import Callable

SECTIONS = ("brief", "treatment", "analysis", "progress")

_SECTION_HEADS = {
    "brief": "## Brief",
    "treatment": "## Treatment",
    "analysis": "## Analysis",
    "progress": "## Progress",
}


class MemoryError(ValueError):
    """文档模型入参/序列化形状错误。"""


@dataclass
class ProjectMemory:
    """短剧项目四文档记忆。字段即文档;render() 输出 agent 可读 markdown。"""

    project_id: str
    title: str
    brief: str = ""
    treatment: str = ""
    analysis: str = ""
    progress: str = ""
    on_save: Callable[[str], None] | None = field(default=None, repr=False, compare=False)

    # ------------------------------------------------------------- lifecycle

    @classmethod
    def init(
        cls,
        project_id: str,
        title: str,
        premise: str,
        on_save: Callable[[str], None] | None = None,
    ) -> "ProjectMemory":
        """建立项目记忆:premise 作为 Brief 的初始一句话前提。"""
        if not isinstance(project_id, str) or not project_id.strip():
            raise MemoryError("project_id 必须非空")
        if not isinstance(title, str) or not title.strip():
            raise MemoryError("title 必须非空")
        if not isinstance(premise, str):
            raise MemoryError("premise 必须是字符串")
        return cls(
            project_id=project_id.strip(),
            title=title.strip(),
            brief=premise.strip(),
            on_save=on_save,
        )

    def update(self, section: str, text: str) -> None:
        """整段覆盖指定文档(Brief/Treatment/Analysis/Progress 之一)。"""
        if section not in SECTIONS:
            raise MemoryError(f"未知文档段:{section!r},合法段={SECTIONS}")
        if not isinstance(text, str):
            raise MemoryError("text 必须是字符串")
        setattr(self, section, text)

    # ------------------------------------------------------------- persistence

    def serialize(self) -> str:
        """落库形状:扁平 JSON 字符串(不建表,列形状由调用方决定)。"""
        return json.dumps(
            {
                "project_id": self.project_id,
                "title": self.title,
                "brief": self.brief,
                "treatment": self.treatment,
                "analysis": self.analysis,
                "progress": self.progress,
            },
            ensure_ascii=False,
        )

    @classmethod
    def deserialize(cls, raw: str, on_save: Callable[[str], None] | None = None) -> "ProjectMemory":
        """从 JSON 字符串恢复(跨会话续接唯一入口,不依赖进程内状态)。"""
        try:
            data = json.loads(raw)
        except (TypeError, ValueError) as exc:
            raise MemoryError(f"记忆 JSON 解析失败:{exc}") from exc
        if not isinstance(data, dict):
            raise MemoryError("记忆 JSON 必须是对象")
        for key in ("project_id", "title"):
            val = data.get(key)
            if not isinstance(val, str) or not val.strip():
                raise MemoryError(f"记忆 JSON 缺少非空字段:{key}")
        sections: dict[str, str] = {}
        for key in SECTIONS:
            val = data.get(key, "")
            if not isinstance(val, str):
                raise MemoryError(f"记忆 JSON 字段 {key} 必须是字符串")
            sections[key] = val
        return cls(
            project_id=data["project_id"].strip(),
            title=data["title"].strip(),
            on_save=on_save,
            **sections,
        )

    def save(self) -> None:
        """经存储回调落盘/落库;无回调时显式报错(存储归调用方所有)。"""
        if self.on_save is None:
            raise MemoryError("未配置存储回调 on_save,无法保存")
        self.on_save(self.serialize())

    # ------------------------------------------------------------- render

    def render(self) -> str:
        """输出 agent 可读 markdown:标题 + 四文档段(固定关键段头)。"""
        parts = [f"# {self.title}", "", f"> project: {self.project_id}", ""]
        for key in SECTIONS:
            body = getattr(self, key).strip() or "_(空)_"
            parts.append(_SECTION_HEADS[key])
            parts.append("")
            parts.append(body)
            parts.append("")
        return "\n".join(parts)
