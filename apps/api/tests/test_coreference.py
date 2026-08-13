"""指代消解闸门测试:代词检测、未消解判定、分镜报告、gateway advisory 接入。"""
from __future__ import annotations

from app.quality import coreference
from app.quality.gateway import run_quality_checks


def test_find_pronouns_english():
    found = coreference.find_pronouns("he walks in, she follows him")
    assert "he" in found and "she" in found and "him" in found


def test_find_pronouns_chinese_excludes_compounds():
    # 「其他/其它」是复合词,不应计为代词
    assert coreference.find_pronouns("其他人都在场") == []
    assert coreference.find_pronouns("它没有尾巴") == ["它"]
    assert coreference.find_pronouns("他走进来") == ["他"]


def test_find_pronouns_empty():
    assert coreference.find_pronouns("") == []
    assert coreference.find_pronouns("a quiet alley, neon lights") == []


def test_unresolved_when_pronoun_without_name():
    names = ["楚生"]
    assert coreference.unresolved_pronouns("he walks into the alley", names) == ["he"]
    # 名字在场 → 代词有共指对象,视为已消解
    assert coreference.unresolved_pronouns("楚生 walks in, he looks tired", names) == []
    assert coreference.unresolved_pronouns("rainy alley, neon", names) == []


def test_check_shots_aggregates_issues():
    shots = [
        {"prompt": "楚生 walks in", "scene": "雨夜", "characters": ["楚生"]},
        {"prompt": "he looks around", "scene": "她回头", "characters": ["楚生"]},
    ]
    report = coreference.check_shots(shots)
    assert not report.passed
    assert report.issue_count == 2  # shot1 prompt(he) + scene(她)
    fields = {(i.shot_index, i.field) for i in report.issues}
    assert (1, "prompt") in fields and (1, "scene") in fields
    d = report.to_dict()
    assert d["issues"][0]["pronouns"]


def test_check_shots_clean():
    shots = [{"prompt": "rainy alley, neon", "scene": "空镜", "characters": []}]
    report = coreference.check_shots(shots)
    assert report.passed and report.issue_count == 0


def test_gateway_coref_advisory_non_blocking():
    """指代问题只进 advisory 报告,不影响三重防线的 passed 判定。"""
    shots = [
        {
            "scene": "他走进雨夜小巷",
            "description": "追逐戏,情绪激烈",
            "prompt": "he runs fast, chasing",
            "camera": "跟拍特写",
            "dialogue": "站住!",
            "motion": "快速奔跑",
            "duration_sec": 6,
            "characters": ["楚生"],
        },
        {
            "scene": "仓库对峙",
            "description": "两人对峙,剑拔弩张",
            "prompt": "楚生 confronts the stranger in warehouse",
            "camera": "全景环绕",
            "dialogue": "你逃不掉。",
            "motion": "拔枪",
            "duration_sec": 8,
            "characters": ["楚生"],
        },
    ]
    report = run_quality_checks(shots)
    assert "coref" in report.to_dict()
    assert report.coref.issue_count >= 2  # shot0 scene「他」+ prompt「he」
    # advisory:三重防线过则 passed 仍为 True(指代问题不阻断)
    assert report.passed
