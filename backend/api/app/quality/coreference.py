"""指代消解闸门 — 检测分镜 prompt/scene 中未消解的代词。

设计依据(竞品调研方向二):
生成 prompt 必须自包含——角色以「名字+外观 token」出现,禁止裸代词,
否则下游扩散模型无法把「他/她/he/she」绑定到具体实体,跨镜头一致性崩盘。

本模块是确定性检测器(纯正则,零依赖),供两处使用:
1. storyboard.parse_script 后处理:发现未消解代词 → LLM 受约束重写/兜底注入
2. quality.gateway 第四道防线:作为 advisory 报告(v1 不阻断主流程)
"""
from __future__ import annotations

import re
from dataclasses import dataclass, field

# 英文人称代词(词边界,不含 it/its——prompt 中 "its" 常作物主形容,误报高)
_EN_PRONOUNS = re.compile(
    r"\b(he|she|him|his|her|hers|they|them|their|theirs)\b", re.IGNORECASE
)
# 中文人称代词;⚠️ 排除「其他/其它/他日」等常见复合词,只匹配独立指代用法
_ZH_PRONOUNS = re.compile(r"(?<!其)(?<!其　)(他|她|它|牠|TA|他们|她们|它们)")


def find_pronouns(text: str) -> list[str]:
    """返回文本中出现的人称代词(去重,保持首次出现顺序)。"""
    if not text:
        return []
    found: list[str] = []
    for m in _EN_PRONOUNS.finditer(text):
        tok = m.group(0).lower()
        if tok not in found:
            found.append(tok)
    for m in _ZH_PRONOUNS.finditer(text):
        tok = m.group(0)
        if tok not in found:
            found.append(tok)
    return found


def unresolved_pronouns(text: str, entity_names: list[str]) -> list[str]:
    """返回未消解代词:文本含代词且没有任何实体名出现(代词无所指)。"""
    pronouns = find_pronouns(text)
    if not pronouns:
        return []
    names = [n for n in entity_names if n]
    if any(n in text for n in names):
        return []  # 名字在场,代词有显式共指对象,视为已消解
    return pronouns


@dataclass
class CorefIssue:
    """单条指代问题。"""

    shot_index: int
    field: str  # prompt | scene
    pronouns: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "shot_index": self.shot_index,
            "field": self.field,
            "pronouns": self.pronouns,
        }


@dataclass
class CorefReport:
    """指代闸门报告。passed=False 仅作 advisory(gateway v1 不据此阻断)。"""

    passed: bool
    issues: list[CorefIssue] = field(default_factory=list)

    @property
    def issue_count(self) -> int:
        return len(self.issues)

    def to_dict(self) -> dict:
        return {
            "passed": self.passed,
            "issue_count": self.issue_count,
            "issues": [i.to_dict() for i in self.issues],
        }


def check_shots(shots: list[dict], entity_names: list[str] | None = None) -> CorefReport:
    """对分镜列表执行指代检测。

    Args:
        shots: 分镜 dict 列表(含 prompt/scene,可选 characters 名单)。
        entity_names: 实体注册表(角色名);为 None 时从各镜 characters 字段求并集。
    """
    if entity_names is None:
        names: list[str] = []
        for s in shots:
            for n in s.get("characters") or []:
                n = str(n).strip()
                if n and n not in names:
                    names.append(n)
    else:
        names = [n for n in entity_names if n]

    issues: list[CorefIssue] = []
    for idx, shot in enumerate(shots):
        for fld in ("prompt", "scene"):
            text = str(shot.get(fld) or "")
            unresolved = unresolved_pronouns(text, names)
            if unresolved:
                issues.append(CorefIssue(shot_index=idx, field=fld, pronouns=unresolved))
    return CorefReport(passed=not issues, issues=issues)
