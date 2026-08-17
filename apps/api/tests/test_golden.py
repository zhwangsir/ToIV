"""quality.golden 黄金回归集注册表测试。

覆盖:内置 manifest 注册与元数据完整性、golden 文件存在性、
register_golden 自定义挂载、load_golden 未知名 KeyError、list 排序。
"""
from __future__ import annotations

import pytest

from app.quality import golden
from app.quality.golden import GoldenCase, GoldenSet, list_golden, load_golden, register_golden


def test_builtin_manifests_registered():
    names = [s.name for s in list_golden()]
    assert "zhuxian-25shots" in names
    assert "silent-eclipse-pv" in names
    assert names == sorted(names)  # 确定性排序


def test_zhuxian_manifest_metadata():
    """诛仙 25 镜:仅元数据壳(不内嵌生产库分镜),关键特征齐备。"""
    gset = load_golden("zhuxian-25shots")
    md = gset.metadata
    assert md["shot_count"] == 25
    assert md["duration"] == "5min"
    assert md["aspect"] == "9:16"
    assert md["verified"] == "2026-08-15"
    assert "质量门回归" in md["purpose"]
    assert gset.cases == ()  # 测试不连生产库:无内嵌分镜数据


def test_silent_eclipse_pv_files_exist():
    """20s/30s 双黄金稿指向 editorial-mg-pv/evals/golden/,文件真实存在。"""
    gset = load_golden("silent-eclipse-pv")
    assert len(gset.cases) == 2
    by_id = {c.id: c for c in gset.cases}
    assert set(by_id) == {"silent-eclipse-30s", "silent-eclipse-20s"}
    for case in gset.cases:
        assert case.exists(), f"黄金稿缺失: {case.path}"
        text = case.read_text()
        assert len(text) > 1000
        assert "SILENT ECLIPSE" in text
    assert by_id["silent-eclipse-30s"].metadata["duration"] == 30
    assert by_id["silent-eclipse-20s"].metadata["duration"] == 20


def test_register_and_load_custom():
    custom = GoldenSet(
        name="custom-demo",
        description="自定义回归集",
        cases=(GoldenCase(id="c1", note="元数据壳"),),
        metadata={"purpose": "演示"},
    )
    register_golden(custom)
    try:
        loaded = load_golden("custom-demo")
        assert loaded is custom
        assert loaded.cases[0].exists() is False  # 无 path 元数据壳
        with pytest.raises(FileNotFoundError):
            loaded.cases[0].read_text()
    finally:
        golden._REGISTRY.pop("custom-demo", None)  # 不污染全局注册表


def test_load_unknown_raises_keyerror():
    with pytest.raises(KeyError):
        load_golden("不存在的黄金集")
