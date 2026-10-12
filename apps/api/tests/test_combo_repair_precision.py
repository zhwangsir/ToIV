"""W8-7:combo_repair 不得跨精度换权重。

实测雷:路由落到缺权重的 :8197 后,combo_repair 拿**被选中那台**的清单把
wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors 换成 …fp16,却不动与之耦合的
quantization=fp8_scaled 部件,于是报「The model is not a scaled fp8 model, please
disable '_scaled' in quantization」——把「路由错/缺权重」伪装成「权重不兼容」,
归因被修复动作覆盖(与 LLM 补丁删绑定目标节点撞 422 遮蔽真因同型)。

换精度不是修复:显存占用与出图特性都会变。同精度的版本差异(v6→v7)仍照旧替换。
"""
from __future__ import annotations

import pytest

from app.services.app_smoke import _precision_of, combo_repair

# 生产实证的原文件名(rh-acc-4952026113-5417df 等 3 条)
FP8_SCALED = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
FP16 = "wan2.2_i2v_high_noise_14B_fp16.safetensors"


def _objinfo(combo: list[str], ct: str = "WanVideoModelLoader", field: str = "model") -> dict:
    return {ct: {"input": {"required": {field: [combo]}}}}


def _graph(val: str, ct: str = "WanVideoModelLoader", field: str = "model",
           extra: dict | None = None) -> dict:
    return {"24": {"class_type": ct, "inputs": {field: val, **(extra or {})}}}


# ── 精度 token 提取 ──
@pytest.mark.parametrize("name,expected", [
    (FP8_SCALED, "fp8_scaled"),
    ("wan2.2_i2v_low_noise_14B_fp16.safetensors", "fp16"),
    ("Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v3.0.safetensors", "fp8_e4m3fn"),
    ("qwen_image_nvfp4.safetensors", "nvfp4"),
    ("some_fp4_model.safetensors", "fp4"),
    ("flux_int8.safetensors", "int8"),
    ("wan_bf16.safetensors", "bf16"),
    ("model-Q8_0.gguf", "gguf"),
    ("majicmixRealistic_v7.safetensors", None),
    ("", None),
])
def test_precision_of(name, expected):
    assert _precision_of(name) == expected


def test_precision_of_long_token_wins_over_substring():
    """fp8_scaled 必须读成 fp8_scaled 而不是 fp8,否则与 fp16 的比较逻辑还在、
    但 fp8_scaled↔fp8 这类真差异会被判成同精度而放行。"""
    assert _precision_of("x_fp8_scaled.safetensors") == "fp8_scaled"
    assert _precision_of("x_fp8.safetensors") == "fp8"
    assert _precision_of("x_fp8_scaled.safetensors") != _precision_of("x_fp8.safetensors")
    assert _precision_of("x_nvfp4.safetensors") == "nvfp4"
    assert _precision_of("x_fp4.safetensors") == "fp4"


# ── 跨精度替换必须被拒 ──
def test_refuses_fp8_scaled_to_fp16_swap_and_leaves_graph_untouched():
    g = _graph(FP8_SCALED, extra={"quantization": "fp8_scaled"})
    fixes = combo_repair(g, _objinfo([FP16, "other_fp16.safetensors"]))

    assert g["24"]["inputs"]["model"] == FP8_SCALED, "跨精度替换必须被拒绝,图不得被改"
    assert g["24"]["inputs"]["quantization"] == "fp8_scaled"
    assert len(fixes) == 1
    note = fixes[0]
    assert "拒绝换成" in note and FP16 in note
    assert "真因" in note, "必须写明真因是缺权重/路由错,而不是让调用方以为修好了"
    assert "fp8_scaled" in note and "fp16" in note


def test_refuses_swap_even_without_a_quantization_widget():
    """守卫不依赖同节点是否存在量化部件:跨精度本身就改变了显存与出图特性。"""
    g = _graph(FP8_SCALED)
    fixes = combo_repair(g, _objinfo([FP16]))
    assert g["24"]["inputs"]["model"] == FP8_SCALED
    assert fixes and "拒绝换成" in fixes[0]


def test_refuses_fp8_scaled_to_plain_fp8_swap():
    g = _graph("model_fp8_scaled.safetensors")
    fixes = combo_repair(g, _objinfo(["model_fp8.safetensors"]))
    assert g["24"]["inputs"]["model"] == "model_fp8_scaled.safetensors"
    assert fixes and "拒绝换成" in fixes[0]


# ── 有用的替换必须保留 ──
# 注意 _stem 会把 fp8/fp16/scaled/int8/bf16/e4m3fn 等精度噪声**全部剥掉**,
# 所以「最近变体」天然就是跨精度的那个文件——这正是本守卫存在的理由。
# 下面用例的候选必须让 _stem(value) 成为 _stem(cand) 的子串才会被 _best_match 选中。
def test_still_swaps_same_precision_suffix_variant():
    g = _graph(FP16)
    cand = "wan2.2_i2v_high_noise_14B_fp16_v2.safetensors"
    fixes = combo_repair(g, _objinfo([cand]))
    assert g["24"]["inputs"]["model"] == cand
    assert fixes == [f"node 24: WanVideoModelLoader.model {FP16} → {cand}"]


def test_still_swaps_when_precision_tokens_match():
    """同为 fp8_scaled 的两个变体:精度没变,照常替换。"""
    val = "wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors"
    cand = "wan2.2_i2v_high_noise_14B_fp8_scaled_v2.safetensors"
    g = _graph(val, extra={"quantization": "fp8_scaled"})
    fixes = combo_repair(g, _objinfo([cand]))
    assert g["24"]["inputs"]["model"] == cand
    assert fixes and "拒绝" not in fixes[0]


def test_still_swaps_when_neither_side_has_a_precision_token():
    g = _graph("majicmix.safetensors", ct="CheckpointLoaderSimple", field="ckpt_name")
    cand = "majicmixRealistic_v7.safetensors"
    fixes = combo_repair(g, _objinfo([cand], ct="CheckpointLoaderSimple", field="ckpt_name"))
    assert g["24"]["inputs"]["ckpt_name"] == cand
    assert fixes and "拒绝" not in fixes[0]


def test_stem_normalization_erases_precision_which_is_why_the_guard_exists():
    """把 _stem 的行为钉住:它剥掉精度噪声,故 fp8_scaled 与 fp16 的 stem 完全相同。

    若哪天 _stem 改成保留精度,combo_repair 就不会再选中跨精度候选,本守卫自然空转——
    这条测试用来提醒:守卫与 _stem 是配对存在的。
    """
    from app.services.app_smoke import _stem
    assert _stem(FP8_SCALED) == _stem(FP16)


def test_no_swap_when_value_already_in_combo():
    g = _graph(FP8_SCALED)
    assert combo_repair(g, _objinfo([FP8_SCALED, FP16])) == []
    assert g["24"]["inputs"]["model"] == FP8_SCALED


def test_class_alias_repair_still_runs_alongside_the_guard():
    """守卫只作用于 combo 替换,不能影响第 1 步的类名别名修复。"""
    g = {"7": {"class_type": "StringToInt", "inputs": {}},
         "24": {"class_type": "WanVideoModelLoader", "inputs": {"model": FP8_SCALED}}}
    objinfo = _objinfo([FP16])
    objinfo["Stringtoint"] = {"input": {"required": {}}}
    fixes = combo_repair(g, objinfo)

    assert g["7"]["class_type"] == "Stringtoint"
    assert any("class StringToInt → Stringtoint" in f for f in fixes)
    assert g["24"]["inputs"]["model"] == FP8_SCALED, "同一次调用里精度守卫仍须生效"
