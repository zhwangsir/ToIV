"""W8-10:combo_repair 第三步——缺的 required widget 按**已安装节点自己声明的默认值**补齐。

动机(实测):RH 导出图会省略「等于默认值」的 widget,而部分节点版本在 API 格式下仍强制
要求它出现——`AILab_QwenVL_Advanced: Required input is missing use_torch_compile`
(影响 183 个应用)、`SeedVR2: … missing input_noise_scale`(影响 1347 个)。

为什么这样补是安全的:补进去的就是节点自己声明的默认值,所以 ComfyUI 本来会自动填的
情况下这是**语义空操作**,强制要求的情况下则直接修好——两头都不亏。这正是必要的,因为
我实测过「有没有 default」并不决定 ComfyUI 是否强制(use_torch_compile 有 default:false
却被强制;ImageScaleToTotalPixels.resolution_steps 有 default:1 却被容忍),
**没有可靠的静态判据**能提前分辨,所以按「补了不亏」处理。

边界:连线型(["IMAGE"]/["MODEL"])没有默认值,**不硬造**——造一条连线等于改拓扑,
那不是修复是编造。
"""
from __future__ import annotations

import pytest

from app.services.app_smoke import _MISSING, _spec_default, apply_edits_to_workflow, combo_repair


# ── _spec_default ──
@pytest.mark.parametrize("spec,expected", [
    (["BOOLEAN", {"default": False}], False),
    (["FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}], 0.0),
    (["INT", {"default": 1, "advanced": True}], 1),
    (["STRING", {"default": "", "multiline": True}], ""),
    ([["a", "b", "c"]], "a"),                              # combo 隐式默认=第一项
    (["COMBO", {"options": ["x", "y"]}], "x"),              # ComfyUI 0.34 动态 COMBO
])
def test_spec_default_reads_declared_defaults(spec, expected):
    assert _spec_default(spec) == expected


@pytest.mark.parametrize("spec", [
    ["IMAGE"], ["MODEL"], ["LATENT"], ["STRING"], ["BOOLEAN"],   # 连线型/无默认 widget
    [], None, "garbage", [None], [[], {}],
])
def test_spec_default_refuses_to_invent(spec):
    """补不出来的必须明确说补不出来,不能返回 None 之类会被当成合法默认值的东西。"""
    assert _spec_default(spec) is _MISSING


def test_spec_default_prefers_options_over_default_key():
    assert _spec_default(["COMBO", {"options": ["x"], "default": "ignored"}]) == "x"


# ── combo_repair 第三步 ──
def _g(inputs, ct="AILab_QwenVL_Advanced"):
    return {"7": {"class_type": ct, "inputs": dict(inputs)}}


def test_fills_missing_boolean_widget_with_declared_default():
    """真机实证形态::8196 上 use_torch_compile = ["BOOLEAN", {"default": false}]。"""
    objinfo = {"AILab_QwenVL_Advanced": {"input": {"required": {
        "image": ["IMAGE"],
        "use_torch_compile": ["BOOLEAN", {"default": False}],
    }}}}
    g = _g({"image": ["1", 0]})
    edits: list = []
    fixes = combo_repair(g, objinfo, edits)

    assert g["7"]["inputs"]["use_torch_compile"] is False
    assert any("use_torch_compile" in f and "默认值补" in f for f in fixes)
    assert edits == [("7", "input_missing", "use_torch_compile", None, False)]


def test_fills_missing_float_widget():
    """SeedVR2.input_noise_scale 真机实证形态:["FLOAT", {"default": 0.0, …}]。"""
    objinfo = {"SeedVR2": {"input": {"required": {
        "image": ["IMAGE"], "input_noise_scale": ["FLOAT", {"default": 0.0, "min": 0.0, "max": 1.0}],
    }}}}
    g = _g({"image": ["1", 0]}, ct="SeedVR2")
    combo_repair(g, objinfo)
    assert g["7"]["inputs"]["input_noise_scale"] == 0.0


def test_does_not_invent_a_link_for_missing_required_image():
    """连线型补不出来就不补:凭空造一条连线等于改拓扑。"""
    objinfo = {"N": {"input": {"required": {"image": ["IMAGE"], "flag": ["BOOLEAN", {"default": True}]}}}}
    g = _g({}, ct="N")
    edits: list = []
    combo_repair(g, objinfo, edits)
    assert "image" not in g["7"]["inputs"], "不得凭空造连线"
    assert g["7"]["inputs"]["flag"] is True, "但有默认值的 widget 该补"
    assert [e[1] for e in edits] == ["input_missing"]


def test_present_values_are_never_overwritten():
    objinfo = {"N": {"input": {"required": {"steps": ["INT", {"default": 1}]}}}}
    g = _g({"steps": 42}, ct="N")
    assert combo_repair(g, objinfo) == []
    assert g["7"]["inputs"]["steps"] == 42


def test_unknown_class_is_skipped():
    g = _g({}, ct="NotInstalledAnywhere")
    assert combo_repair(g, {"N": {"input": {"required": {"a": ["INT", {"default": 1}]}}}}) == []
    assert g["7"]["inputs"] == {}


def test_malformed_objinfo_does_not_raise():
    objinfo = {"A": {"input": None}, "B": {"input": {"required": "nope"}}, "C": {},
               "D": {"input": {"required": {"x": ["INT", {"default": 3}]}}}}
    g = {"1": {"class_type": "A", "inputs": {}}, "2": {"class_type": "B", "inputs": {}},
         "3": {"class_type": "C", "inputs": {}}, "4": {"class_type": "D", "inputs": {}},
         "5": {"class_type": "D"}}  # 连 inputs 都没有
    fixes = combo_repair(g, objinfo)
    assert g["4"]["inputs"]["x"] == 3
    assert "inputs" not in g["5"], "无 inputs 的畸形节点不该被凭空加一个"
    assert len(fixes) == 1


def test_step3_coexists_with_alias_and_combo_steps():
    """三步(类名别名 / combo 变体 / 补缺省)必须同时生效,别互相挤掉。"""
    objinfo = {
        "Stringtoint": {"input": {"required": {}}},
        "WanVideoModelLoader": {"input": {"required": {
            "model": [["wan2.2_i2v_v2.safetensors"]],
            "attention_mode": [["sdpa", "flash_attn"]],
        }}},
    }
    g = {"1": {"class_type": "StringToInt", "inputs": {}},
         "2": {"class_type": "WanVideoModelLoader",
               "inputs": {"model": "wan2.2_i2v.safetensors"}}}
    edits: list = []
    fixes = combo_repair(g, objinfo, edits)

    assert g["1"]["class_type"] == "Stringtoint"
    assert g["2"]["inputs"]["model"] == "wan2.2_i2v_v2.safetensors"
    assert g["2"]["inputs"]["attention_mode"] == "sdpa"
    assert [e[1] for e in edits] == ["class_type", "input", "input_missing"]
    assert len(fixes) == 3


# ── input_missing 的回放 ──
WF = {"7": {"class_type": "AILab_QwenVL_Advanced", "inputs": {"image": ["1", 0]}}}


def test_replay_fills_absent_key_in_stored_workflow():
    out, skipped = apply_edits_to_workflow(
        WF, [("7", "input_missing", "use_torch_compile", None, False)])
    assert skipped == []
    assert out["7"]["inputs"]["use_torch_compile"] is False
    assert "use_torch_compile" not in WF["7"]["inputs"], "不得就地改存量图"


def test_replay_does_not_override_an_explicit_value():
    """存量图里已有显式值 → 不能用默认值覆盖(那是别处填的,不是缺失)。"""
    wf = {"7": {"class_type": "X", "inputs": {"flag": True}}}
    out, skipped = apply_edits_to_workflow(wf, [("7", "input_missing", "flag", None, False)])
    assert skipped and "已有值" in skipped[0]
    assert out["7"]["inputs"]["flag"] is True


def test_replay_treats_explicit_null_as_absent():
    wf = {"7": {"class_type": "X", "inputs": {"flag": None}}}
    out, skipped = apply_edits_to_workflow(wf, [("7", "input_missing", "flag", None, False)])
    assert skipped == [] and out["7"]["inputs"]["flag"] is False
