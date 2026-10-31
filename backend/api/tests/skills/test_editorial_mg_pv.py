"""editorial-mg-pv 正典模板技能测试。

· frontmatter 契约:kind=template、7 个输入槽位、version/author;
· evals/cases.json 全量驱动:对 render() 产物做确定性结构断言(不调 LLM);
· 黄金稿结构对齐:render 默认槽位产物的章节标题序列与 golden/30s.txt 的
  章节序列对齐率 ≥80%(章节键规范化后按序贪心匹配);
· golden/ 双稿(20s.txt/30s.txt)存在且非空。
"""
from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from app.skills.registry import skills_registry

_SKILL_NAME = "editorial-mg-pv"

#: render 默认槽位(与黄金稿 SILENT ECLIPSE 设定一致)
_DEFAULT_SLOTS = {
    "character": "22岁年轻女性,黑蓝齐肩短发,冰青色瞳孔,黑色立领制服",
    "weapon": "单刃太刀",
    "palette": "午夜深蓝#07152D,钴蓝#1746D1,冰青#69E4E8,墨黑#05070A,暖纸白#F4F2EA,危险猩红#D93636",
    "title": "SILENT ECLIPSE",
    "duration": 30,
    "aspect": "16:9",
    "segments": 2,
}


@pytest.fixture(scope="module")
def skill():
    s = skills_registry.get(_SKILL_NAME)
    assert s is not None, "editorial-mg-pv 技能未注册"
    return s


@pytest.fixture(scope="module")
def cases(skill):
    cases_path = Path(skill.path).parent / "evals" / "cases.json"
    return json.loads(cases_path.read_text(encoding="utf-8"))


@pytest.fixture(scope="module")
def golden_dir(skill):
    return Path(skill.path).parent / "evals" / "golden"


def test_frontmatter_contract(skill):
    assert skill.kind == "template"
    assert skill.version == "1.0.0"
    assert skill.author == "dgmt"
    for k in ("character", "weapon", "palette", "title", "duration", "aspect", "segments"):
        assert k in skill.inputs, f"inputs 缺槽位: {k}"
    assert skill.outputs
    assert skill.triggers


def test_golden_files_exist(golden_dir):
    """双黄金稿已从 docs/skill 迁入 evals/golden/,非空且含标题文案。"""
    for name in ("20s.txt", "30s.txt"):
        p = golden_dir / name
        assert p.is_file(), f"缺黄金稿: {p}"
        text = p.read_text(encoding="utf-8")
        assert len(text) > 1000
        assert "SILENT ECLIPSE" in text


# ── 黄金稿结构对齐:章节序列对齐率 ≥80% ──────────────────────────────────
def _golden_section_seq(text: str) -> list[str]:
    """从黄金稿提取 【...】 章节头并规范化为正典章节键(保序去重)。"""
    seq: list[str] = []
    for h in re.findall(r"【(.+?)】", text):
        if "整体创意" in h or "项目目标" in h:
            key = "整体创意"
        elif "美术风格" in h:
            key = "美术风格"
        elif "角色锁定" in h or "角色基准" in h:
            key = "角色锁定"
        elif "变形链" in h or "转场" in h:
            key = "变形链"
        elif "空间与运动" in h or "构图与运动" in h:
            key = "空间与运动"
        elif "标题落版" in h:
            key = "标题落版"
        elif re.match(r"^\d+—\d+秒", h):
            key = "分段"
        elif "严格限制" in h:
            key = "严格限制"
        else:
            continue
        if not seq or seq[-1] != key:
            seq.append(key)
    return seq


def test_golden_structure_alignment(skill, golden_dir):
    """render 默认槽位产物的章节标题序列与黄金稿章节序列对齐率 ≥80%。"""
    golden_text = (golden_dir / "30s.txt").read_text(encoding="utf-8")
    golden_seq = _golden_section_seq(golden_text)
    assert len(golden_seq) >= 6, f"黄金稿章节提取异常: {golden_seq}"

    out = skills_registry.render(_SKILL_NAME, **_DEFAULT_SLOTS)
    pos, matched = 0, 0
    for key in golden_seq:
        i = out.find(key, pos)
        if i >= 0:
            matched += 1
            pos = i + len(key)
    rate = matched / len(golden_seq)
    assert rate >= 0.8, f"章节序列对齐率 {rate:.0%} < 80%(黄金序列: {golden_seq})"


# ── evals:cases.json 全量,确定性结构断言 ────────────────────────────────
def test_evals_cases(skill, cases):
    assert cases["skill"] == _SKILL_NAME
    assert len(cases["cases"]) >= 4
    for case in cases["cases"]:
        out = skills_registry.render(_SKILL_NAME, **case["input"])
        for token in case["expect"].get("contains", []):
            assert token in out, f"{case['id']}: 缺 {token!r}"
        for token in case["expect"].get("not_contains", []):
            assert token not in out, f"{case['id']}: 不应出现 {token!r}"
