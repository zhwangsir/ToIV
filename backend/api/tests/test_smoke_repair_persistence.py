"""W8-9:烟测修复必须固化回存量图,否则「烟测通过」是假承诺。

_finish 只写 smoke_status/smoke_error,不写 workflow_json;而 combo_repair **不在
routes/apps.py 的生产运行路径上**。所以修复过才通过的应用,存量图仍是坏的,用户真跑必失败。
实测生产库有 13 个应用处于这个状态,且**全部 is_public=true**——已经挂在市场上。

关键安全性质:只回放结构化 edits(绝不直接存运行图,那会把烟测 fixture 的提示词/种子/图片
固化进应用);任何一条 edit 回放不下去就**整体不落库**(半改的图比不改更难查)。
"""
from __future__ import annotations

import copy

import pytest

from app.services.app_smoke import _persist_repairs, apply_edits_to_workflow

WF = {
    "22": {"class_type": "WanVideoModelLoader",
           "inputs": {"model": "wan2.2_i2v_fp16.safetensors", "quantization": "fp8_scaled"}},
    "31": {"class_type": "StringToInt", "inputs": {"text": "x"}},
}


class _FakeApp:
    def __init__(self, wf):
        self.id = "rh-acc-test-0001"
        self.workflow_json = wf


class _FakeSession:
    def __init__(self):
        self.added = []
        self.commits = 0

    def add(self, obj):
        self.added.append(obj)

    def commit(self):
        self.commits += 1


# ── apply_edits_to_workflow ──
def test_applies_input_and_class_type_edits():
    edits = [("22", "input", "model", "wan2.2_i2v_fp16.safetensors", "wan2.2_i2v_fp16_v2.safetensors"),
             ("31", "class_type", None, "StringToInt", "Stringtoint")]
    out, skipped = apply_edits_to_workflow(WF, edits)
    assert skipped == []
    assert out["22"]["inputs"]["model"] == "wan2.2_i2v_fp16_v2.safetensors"
    assert out["31"]["class_type"] == "Stringtoint"


def test_does_not_mutate_the_original_workflow():
    """必须是深拷贝:存量图被就地改坏的话,不落库也已经被污染了。"""
    before = copy.deepcopy(WF)
    apply_edits_to_workflow(WF, [("22", "input", "model",
                                  "wan2.2_i2v_fp16.safetensors", "other.safetensors")])
    assert WF == before


def test_untouched_fields_are_preserved():
    out, _ = apply_edits_to_workflow(
        WF, [("22", "input", "model", "wan2.2_i2v_fp16.safetensors", "b.safetensors")])
    assert out["22"]["inputs"]["quantization"] == "fp8_scaled", "同节点其它字段不得被动到"


def test_missing_node_is_skipped():
    out, skipped = apply_edits_to_workflow(WF, [("999", "input", "model", "a", "b")])
    assert skipped == ["node 999 不在存量图里"]
    assert out == WF


def test_stale_old_value_is_skipped_not_blindly_overwritten():
    """原值对不上说明图已被别处改过,此时硬写会覆盖别人的修改。"""
    out, skipped = apply_edits_to_workflow(WF, [("22", "input", "model", "不是当前值", "b")])
    assert skipped and "已不是" in skipped[0]
    assert out["22"]["inputs"]["model"] == "wan2.2_i2v_fp16.safetensors"


def test_integer_node_ids_are_matched():
    """JSON 反序列化后节点 id 可能是 int 而非 str。"""
    wf = {22: {"class_type": "X", "inputs": {"m": "a"}}}
    out, skipped = apply_edits_to_workflow(wf, [("22", "input", "m", "a", "b")])
    assert skipped == [] and out[22]["inputs"]["m"] == "b"


def test_node_without_inputs_is_skipped():
    wf = {"1": {"class_type": "X"}}
    _, skipped = apply_edits_to_workflow(wf, [("1", "input", "m", "a", "b")])
    assert skipped == ["node 1 无 inputs"]


def test_junk_input_does_not_raise():
    out, skipped = apply_edits_to_workflow(None, [("1", "input", "m", "a", "b")])
    assert out == {} and skipped


# ── _persist_repairs ──
def test_no_edits_means_no_write():
    app, s = _FakeApp(copy.deepcopy(WF)), _FakeSession()
    _persist_repairs(s, app, [])
    assert s.commits == 0 and s.added == []


def test_persists_repaired_workflow_on_pass():
    app, s = _FakeApp(copy.deepcopy(WF)), _FakeSession()
    _persist_repairs(s, app, [("22", "input", "model",
                               "wan2.2_i2v_fp16.safetensors", "wan2.2_i2v_fp16_v2.safetensors")])
    assert s.commits == 1 and s.added == [app]
    assert app.workflow_json["22"]["inputs"]["model"] == "wan2.2_i2v_fp16_v2.safetensors"


def test_never_persists_a_partially_applied_repair():
    """核心安全性质:两条 edit 里有一条落不下去 → 整体不落库。

    半改的图比不改更难查(用户看到的失败与烟测记录的 fixes 对不上)。
    """
    app, s = _FakeApp(copy.deepcopy(WF)), _FakeSession()
    _persist_repairs(s, app, [
        ("22", "input", "model", "wan2.2_i2v_fp16.safetensors", "good.safetensors"),
        ("999", "input", "model", "a", "b"),
    ])
    assert s.commits == 0 and s.added == []
    assert app.workflow_json == WF, "落库被拒时存量图必须原样不动"


def test_runtime_graph_is_never_stored_verbatim():
    """运行图里带着烟测 fixture 的表单值;存回去等于把测试提示词/种子固化进应用。
    这条守的是「只回放 edits」而不是「直接存 graph」的设计决定。"""
    runtime_graph = copy.deepcopy(WF)
    runtime_graph["22"]["inputs"]["prompt"] = "烟测 fixture 的提示词"
    app, s = _FakeApp(copy.deepcopy(WF)), _FakeSession()
    _persist_repairs(s, app, [("22", "input", "model",
                               "wan2.2_i2v_fp16.safetensors", "b.safetensors")])
    assert "prompt" not in app.workflow_json["22"]["inputs"], "运行图的 fixture 值不得进存量图"


def test_non_dict_workflow_is_a_noop():
    for bad in (None, {}, "not-a-dict", []):
        app, s = _FakeApp(bad), _FakeSession()
        _persist_repairs(s, app, [("22", "input", "model", "a", "b")])
        assert s.commits == 0, f"workflow_json={bad!r} 时不该落库"


# ── combo_repair 必须产出可回放的结构化 edits ──
def test_combo_repair_records_edits_matching_its_fixes():
    from app.services.app_smoke import combo_repair

    objinfo = {"WanVideoModelLoader": {"input": {"required": {
        "model": [["wan2.2_i2v_v2.safetensors"]]}}}}
    graph = {"22": {"class_type": "WanVideoModelLoader", "inputs": {"model": "wan2.2_i2v.safetensors"}}}
    edits: list = []
    fixes = combo_repair(graph, objinfo, edits)
    assert fixes and edits
    nid, kind, field, old, new = edits[0]
    assert (nid, kind, field, old, new) == ("22", "input", "model",
                                            "wan2.2_i2v.safetensors", "wan2.2_i2v_v2.safetensors")
    assert graph["22"]["inputs"]["model"] == new, "edits 必须与图上实际发生的改动一致"


def test_combo_repair_records_class_alias_edits():
    from app.services.app_smoke import combo_repair

    objinfo = {"Stringtoint": {"input": {"required": {}}}}
    graph = {"7": {"class_type": "StringToInt", "inputs": {}}}
    edits: list = []
    combo_repair(graph, objinfo, edits)
    assert edits == [("7", "class_type", None, "StringToInt", "Stringtoint")]


def test_combo_repair_without_edits_out_still_works():
    """旧签名(两参)必须继续可用:别为了新功能破坏既有调用方与测试。"""
    from app.services.app_smoke import combo_repair

    objinfo = {"WanVideoModelLoader": {"input": {"required": {
        "model": [["wan2.2_i2v_v2.safetensors"]]}}}}
    graph = {"22": {"class_type": "WanVideoModelLoader", "inputs": {"model": "wan2.2_i2v.safetensors"}}}
    fixes = combo_repair(graph, objinfo)
    assert fixes and graph["22"]["inputs"]["model"] == "wan2.2_i2v_v2.safetensors"


def test_precision_guard_suppresses_edit_recording_too():
    """被精度守卫拒绝的替换既不改图、也不该产出 edit(否则回放会改存量图)。"""
    from app.services.app_smoke import combo_repair

    objinfo = {"WanVideoModelLoader": {"input": {"required": {"model": [["wan_fp16.safetensors"]]}}}}
    graph = {"22": {"class_type": "WanVideoModelLoader",
                    "inputs": {"model": "wan_fp8_scaled.safetensors"}}}
    edits: list = []
    fixes = combo_repair(graph, objinfo, edits)
    assert fixes and "拒绝换成" in fixes[0]
    assert edits == [], "拒绝的替换不得进 edits"
    assert graph["22"]["inputs"]["model"] == "wan_fp8_scaled.safetensors"
