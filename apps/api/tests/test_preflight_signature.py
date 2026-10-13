"""W8-8:签名级预检——「类名在但版本不匹配」的包只有这一层能拦住。

能力扫描只比类名是否存在,于是装了旧版的包一路骗过分类:先导批 25 条里 4 条是这类,
分类却全判 ok。本文件用**生产实测的真实报错**做用例,不用假想的签名。

**判定口径只能按实测,而实测结论是「没有可靠的静态判据」**:拿先导批 25 条真图 × 真 smoke
结果回测,「required 里的键必须全部出现」这条规则做闸的话——14 条失败只抓到 1 条,却把 1 条
实际 pass 的应用误判为不可得。逐条查 object_info 后发现反例互斥:
`AILab_QwenVL_Advanced.use_torch_compile` 是 `["BOOLEAN", {"default": false}]` 却被强制,
`ImageScaleToTotalPixels.resolution_steps` 是 `["INT", {"default": 1}]` 却被容忍。
故三类签名问题一律只作告警透出,**都不参与 procurable 判定**。下面这些测试守的就是这条边界。
"""
from __future__ import annotations

import pytest

from app.services.app_smoke import preflight_check, signature_mismatches


def _node(required: dict, optional: dict | None = None) -> dict:
    spec: dict = {"required": required}
    if optional:
        spec["optional"] = optional
    return {"input": spec}


# ── 实测报错 1:RHHiddenNodes 缺必填连线(09-15 版 shim 把 image_1 声明为 required) ──
def test_flags_missing_required_link_input():
    objinfo = {"RHHiddenNodes": _node({"image_1": ["IMAGE"]},
                                      {"image_2": ["IMAGE"], "pwd": ["STRING", {"default": ""}]})}
    graph = {"296": {"class_type": "RHHiddenNodes", "inputs": {"pwd": "x"}}}
    out = signature_mismatches(graph, objinfo)
    assert out["missing_required"] == ["RHHiddenNodes(node 296): 缺必填输入 image_1"]


def test_optional_inputs_may_be_absent():
    objinfo = {"RHHiddenNodes": _node({"image_1": ["IMAGE"]},
                                      {"image_2": ["IMAGE"], "pwd": ["STRING", {"default": ""}]})}
    graph = {"1": {"class_type": "RHHiddenNodes", "inputs": {"image_1": ["9", 0]}}}
    out = signature_mismatches(graph, objinfo)
    assert out["missing_required"] == [] and out["undeclared"] == []


# ── 实测报错 2:AILab_QwenVL_Advanced 缺 widget 型必填(证明 widget 也强制) ──
def test_flags_missing_required_widget_even_with_default():
    """带 default 的 widget 也算必填:实测 ComfyUI 报过
    'AILab_QwenVL_Advanced: Required input is missing use_torch_compile'。
    若哪天放宽成「有 default 就可省」,这条会红——那时请先拿真机复验再改。"""
    objinfo = {"AILab_QwenVL_Advanced": _node({
        "image": ["IMAGE"],
        "use_torch_compile": ["BOOLEAN", {"default": False}],
    })}
    graph = {"7": {"class_type": "AILab_QwenVL_Advanced", "inputs": {"image": ["1", 0]}}}
    out = signature_mismatches(graph, objinfo)
    assert any("use_torch_compile" in m for m in out["missing_required"])


def test_seedvr2_missing_input_noise_scale():
    objinfo = {"SeedVR2": _node({"image": ["IMAGE"], "input_noise_scale": ["FLOAT", {"default": 0.5}]})}
    graph = {"3": {"class_type": "SeedVR2", "inputs": {"image": ["1", 0]}}}
    out = signature_mismatches(graph, objinfo)
    assert any("input_noise_scale" in m for m in out["missing_required"])


# ── 未声明输入只告警,不判死 ──
def test_undeclared_input_is_advisory_only():
    """RH 图给 RHHiddenNodes 传 images_1(旧 shim 未声明)。实测 ComfyUI 报的是「缺必填」
    而不是「多了未声明」,说明多余输入未必致命 → 只进 undeclared,不参与 procurable。"""
    objinfo = {"RHHiddenNodes": _node({"image_1": ["IMAGE"]}, {"pwd": ["STRING", {"default": ""}]})}
    graph = {"5": {"class_type": "RHHiddenNodes", "inputs": {"image_1": ["1", 0], "images_1": ["2", 0]}}}
    out = signature_mismatches(graph, objinfo)
    assert out["undeclared"] == ["RHHiddenNodes(node 5): 未声明的输入 images_1"]
    assert out["missing_required"] == []


# ── combo 字面量越界:只告警(_build_graph 的 _normalize_* 会修一部分) ──
def test_vhs_legacy_format_flagged_as_combo_invalid_not_procurable_blocker():
    objinfo = {"VHS_VideoCombine": _node({
        "images": ["IMAGE"],
        "format": [["video/h264-mp4", "video/h265-mp4", "image/gif"]],
        "frame_rate": ["FLOAT", {"default": 16}],
    })}
    graph = {"22": {"class_type": "VHS_VideoCombine",
                    "inputs": {"images": ["6", 0], "format": "video/h264-mp4.json",
                               "frame_rate": 16}}}
    out = signature_mismatches(graph, objinfo)
    assert out["combo_invalid"] and "video/h264-mp4.json" in out["combo_invalid"][0]
    assert out["missing_required"] == [], "combo 越界不得升级为硬错误,否则会误杀可被归一修好的图"


def test_dynamic_combo_form_is_understood():
    """ComfyUI 0.34 的动态 COMBO 形如 ["COMBO", {"options": [...]}],直接取 [0] 会得到
    字符串 "COMBO",逐字符迭代会污染判断(_combo_opts 就是为这个坑写的)。"""
    objinfo = {"SomeNode": _node({"mode": ["COMBO", {"options": ["a", "b"]}]})}
    bad = signature_mismatches({"1": {"class_type": "SomeNode", "inputs": {"mode": "zzz"}}}, objinfo)
    good = signature_mismatches({"1": {"class_type": "SomeNode", "inputs": {"mode": "b"}}}, objinfo)
    assert bad["combo_invalid"] and "zzz" in bad["combo_invalid"][0]
    assert good["combo_invalid"] == []


def test_plain_string_widget_is_not_treated_as_combo():
    objinfo = {"SomeNode": _node({"text": ["STRING", {"default": "", "multiline": True}]})}
    out = signature_mismatches({"1": {"class_type": "SomeNode", "inputs": {"text": "anything"}}}, objinfo)
    assert out["combo_invalid"] == []


# ── 健壮性 ──
def test_unknown_class_is_skipped_not_flagged():
    """类名不在 object_info 归 missing_nodes 那条路径管,这里必须沉默,否则重复报错。"""
    out = signature_mismatches({"1": {"class_type": "TotallyUnknown", "inputs": {}}}, {})
    assert out == {"missing_required": [], "combo_invalid": [], "undeclared": []}


@pytest.mark.parametrize("graph", [
    {}, {"1": "not-a-dict"}, {"1": {"class_type": "X"}},
    {"1": {"class_type": "X", "inputs": "nope"}}, None,
])
def test_junk_graphs_do_not_raise(graph):
    out = signature_mismatches(graph, {"X": _node({"a": ["IMAGE"]})})
    assert isinstance(out, dict) and set(out) == {"missing_required", "combo_invalid", "undeclared"}


def test_malformed_objinfo_is_tolerated():
    objinfo = {"X": {"input": None}, "Y": {"input": {"required": "not-a-dict"}}, "Z": {}}
    out = signature_mismatches({"1": {"class_type": "X", "inputs": {}},
                                "2": {"class_type": "Y", "inputs": {}},
                                "3": {"class_type": "Z", "inputs": {}}}, objinfo)
    assert out["missing_required"] == []


def test_linked_values_are_not_combo_checked():
    """连线(list)运行时才有值,不能当字面量校验 combo。"""
    objinfo = {"SomeNode": _node({"mode": [["a", "b"]]})}
    out = signature_mismatches({"1": {"class_type": "SomeNode", "inputs": {"mode": ["9", 0]}}}, objinfo)
    assert out["combo_invalid"] == [] and out["missing_required"] == []


# ── preflight_check 集成 ──
@pytest.mark.asyncio
async def test_missing_required_is_reported_but_does_not_block_procurable(monkeypatch):
    """缺必填输入要透出给人看,但**不得**据此判不可得。

    实测依据:25 条先导批回测里,这条规则做闸只抓到 14 条失败中的 1 条,
    却误杀了 1 条实际 pass 的应用(ImageScaleToTotalPixels.resolution_steps 缺失但照跑通过)。
    漏判 + 误杀同时存在 → 不配做闸。
    """
    objinfo = {"RHHiddenNodes": _node({"image_1": ["IMAGE"]})}

    async def fake_union(pool):
        return objinfo

    monkeypatch.setattr("app.services.app_smoke._union_objinfo", fake_union)
    res = await preflight_check(None, {"1": {"class_type": "RHHiddenNodes", "inputs": {}}},
                                ["RHHiddenNodes"])
    assert res["signature_missing_required"], "缺必填要透出,否则人工分诊没线索"
    assert res["procurable"] is True, "但不得据此判死:实测这条规则漏判 13/14 且误杀 1 条 pass"


@pytest.mark.asyncio
async def test_preflight_procurable_true_when_only_combo_invalid(monkeypatch):
    objinfo = {"VHS_VideoCombine": _node({"images": ["IMAGE"],
                                          "format": [["video/h264-mp4"]]})}

    async def fake_union(pool):
        return objinfo

    monkeypatch.setattr("app.services.app_smoke._union_objinfo", fake_union)
    res = await preflight_check(None, {"22": {"class_type": "VHS_VideoCombine", "inputs": {
        "images": ["6", 0], "format": "video/h264-mp4.json"}}}, ["VHS_VideoCombine"])
    assert res["signature_combo_invalid"], "combo 越界要透出给人看"
    assert res["procurable"] is True, "但不得据此判死:_build_graph 的归一层会修"


@pytest.mark.asyncio
async def test_preflight_reports_all_three_signature_buckets(monkeypatch):
    objinfo = {"N": _node({"req_link": ["IMAGE"], "mode": [["a", "b"]]}, {"opt": ["INT", {"default": 1}]})}

    async def fake_union(pool):
        return objinfo

    monkeypatch.setattr("app.services.app_smoke._union_objinfo", fake_union)
    res = await preflight_check(None, {"1": {"class_type": "N", "inputs": {
        "mode": "zzz", "extra": 1}}}, ["N"])
    assert res["signature_missing_required"] == ["N(node 1): 缺必填输入 req_link"]
    assert res["signature_combo_invalid"] and "zzz" in res["signature_combo_invalid"][0]
    assert res["signature_undeclared"] == ["N(node 1): 未声明的输入 extra"]
    assert res["procurable"] is True, "签名三类都只是告警,procurable 只由缺模型/缺类名否决"


@pytest.mark.asyncio
async def test_preflight_union_unavailable_does_not_false_accuse(monkeypatch):
    """并集取不到时不得误杀(宁可放过,不可错判不可得)。"""
    async def boom(pool):
        raise RuntimeError("union down")

    monkeypatch.setattr("app.services.app_smoke._union_objinfo", boom)
    res = await preflight_check(None, {"1": {"class_type": "X", "inputs": {}}}, ["X"])
    assert res["procurable"] is True
    assert "union unavailable" in res["note"]
    assert res["signature_missing_required"] == []


@pytest.mark.asyncio
async def test_procurable_still_blocked_by_missing_model_and_node(monkeypatch):
    """降为告警不等于没闸:缺模型/缺类名这两条**原有**判据必须继续否决 procurable。"""
    objinfo = {"CheckpointLoaderSimple": _node({"ckpt_name": [["a.safetensors"]]})}

    async def fake_union(pool):
        return objinfo

    monkeypatch.setattr("app.services.app_smoke._union_objinfo", fake_union)
    res = await preflight_check(
        None, {"1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": "ghost.safetensors"}}},
        ["CheckpointLoaderSimple", "NodeThatDoesNotExist"])
    assert res["procurable"] is False
    assert res["missing_models"] and res["missing_nodes"] == ["NodeThatDoesNotExist"]
