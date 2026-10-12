"""自愈链守卫:LLM 补丁若删掉表单绑定的目标节点,必须被拒而不是拿去试跑。

2026-10-13 实证:rh-acc-0052555778-19dac9 的 smoke 报
`422: 绑定 text_text 指向不存在的节点 144`、`cls=app_data`。真因是 LLM 修补后的图删掉了
Text 节点 144,而试跑仍用库内 `app.bindings`(指向 144)→ _write_leaf 422;这条 422 又把
**首跑的真实失败原因盖掉**,归因成 app_data,误导后续处置。
"""
from __future__ import annotations

from app.services.app_smoke import _missing_binding_targets


def test_detects_binding_target_dropped_by_patch():
    wf = {"111": {"class_type": "QwenImageEdit", "inputs": {"prompt": "x"}}}
    bindings = {
        "loadimage_image": {"node": "78", "field": "inputs.image"},
        "text_text": {"node": "144", "field": "inputs.text"},
    }
    assert _missing_binding_targets(wf, bindings) == {"78", "144"}


def test_all_targets_present_returns_empty():
    wf = {
        "78": {"class_type": "LoadImage", "inputs": {}},
        "144": {"class_type": "Text", "inputs": {"text": "v"}},
    }
    bindings = {
        "loadimage_image": {"node": "78", "field": "inputs.image"},
        "text_text": {"node": "144", "field": "inputs.text"},
    }
    assert _missing_binding_targets(wf, bindings) == set()


def test_int_node_ids_are_normalized_to_str():
    """图键可能是 int,bindings 里是 str(或反之),不能因此误判为缺失。"""
    wf = {144: {"class_type": "Text", "inputs": {"text": "v"}}}
    assert _missing_binding_targets(wf, {"text_text": {"node": "144", "field": "inputs.text"}}) == set()
    assert _missing_binding_targets(wf, {"text_text": {"node": 144, "field": "inputs.text"}}) == set()


def test_tolerates_empty_and_junk_shapes():
    assert _missing_binding_targets({}, {}) == set()
    assert _missing_binding_targets(None, None) == set()          # type: ignore[arg-type]
    assert _missing_binding_targets({"1": "junk"}, {"k": "notadict"}) == set()
    # 绑定没有 node 键 → 无从判定,不算缺失
    assert _missing_binding_targets({"1": {"class_type": "X"}}, {"k": {"field": "inputs.a"}}) == set()


def test_non_dict_nodes_do_not_count_as_present():
    wf = {"144": "corrupted", "1": {"class_type": "X", "inputs": {}}}
    assert _missing_binding_targets(wf, {"t": {"node": "144", "field": "inputs.text"}}) == {"144"}
