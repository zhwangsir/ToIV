"""W8 批 E:`Text`/`Bool` 字面量原语归一(内联或 binding 重指)。

背景:RH 导出的图里 `Text`/`Bool` 是纯常量原语(`{"class_type":"Text","inputs":{"text":"…"}}`,
不接上游、输出槽 0 为常量),但本地 worker 没有这两个类名 → 235 + 35 个应用被静态扫描判为
「缺节点」而无法本地部署。抽样 40 条实测:70% 的 Text 是表单 binding 落点、多消费方仅 1/40。

这里锁住四种情形与两条不许破的边界:
  (a) 非 binding 落点 → 常量内联进**所有**消费方,摘节点;
  (b) binding 落点 + 单消费方 → binding 重指到消费方槽位,摘节点;
  (c) binding 落点 + 多消费方 → **不动**(同一值写多处会把表单语义写歪);
  (d) 输入里有连线 → 不是纯字面量,**整条跳过**。
"""
from __future__ import annotations

from app.routes.apps import _build_graph, _normalize_primitive_literal_nodes


def _graph_text(consumers: int = 1, text: str = "hello", bound_field: str = "text"):
    g = {
        "29": {"class_type": "Text", "inputs": {bound_field: text}, "_meta": {"title": "文本"}},
    }
    for i in range(consumers):
        g[str(100 + i)] = {
            "class_type": "CR Text Concatenate",
            "inputs": {"text1": ["29", 0], "text2": "movie clip"},
        }
    return g


# ---------- (a) 纯常量内联 ----------

def test_pure_constant_text_inlined_into_single_consumer():
    g = _graph_text(consumers=1, text="一只猫")
    out = _normalize_primitive_literal_nodes(g, {})
    assert "29" not in g
    assert g["100"]["inputs"]["text1"] == "一只猫"
    assert out == {}


def test_pure_constant_text_inlined_into_every_consumer():
    g = _graph_text(consumers=3, text="prompt")
    _normalize_primitive_literal_nodes(g, {})
    assert "29" not in g
    for nid in ("100", "101", "102"):
        assert g[nid]["inputs"]["text1"] == "prompt"


def test_bool_literal_inlined():
    g = {
        "7": {"class_type": "Bool", "inputs": {"boolean": True}},
        "8": {"class_type": "KSampler", "inputs": {"denoise": ["7", 0], "seed": 1}},
    }
    _normalize_primitive_literal_nodes(g, {})
    assert "7" not in g
    assert g["8"]["inputs"]["denoise"] is True
    assert g["8"]["inputs"]["seed"] == 1


def test_unconsumed_literal_is_dropped():
    """没人消费的字面量原语直接摘掉——它同样会让 worker 报「缺节点」。"""
    g = {"29": {"class_type": "Text", "inputs": {"text": "orphan"}},
         "1": {"class_type": "KSampler", "inputs": {"seed": 3}}}
    _normalize_primitive_literal_nodes(g, {})
    assert "29" not in g
    assert g["1"]["inputs"]["seed"] == 3


# ---------- (b) binding 重指 ----------

def test_bound_text_with_single_consumer_redirects_binding():
    g = _graph_text(consumers=1, text="默认提示词")
    bindings = {"text_text": {"node": "29", "field": "inputs.text"}}
    out = _normalize_primitive_literal_nodes(g, bindings)
    assert "29" not in g
    assert out["text_text"] == {"node": "100", "field": "inputs.text1"}
    # 摘掉原语后消费方槽位必须已是标量(否则悬空连线 → _write_leaf 422 禁改拓扑)
    assert g["100"]["inputs"]["text1"] == "默认提示词"


def test_redirect_survives_full_build_graph_and_value_lands_on_consumer():
    """端到端:表单值必须落到消费方槽位,而不是随节点一起消失。"""
    wf = _graph_text(consumers=1, text="旧默认值")
    bindings = {"text_text": {"node": "29", "field": "inputs.text"}}
    built = _build_graph(wf, bindings, {"text_text": "用户填的新提示词"})
    assert "29" not in built
    assert built["100"]["inputs"]["text1"] == "用户填的新提示词"


def test_original_workflow_is_never_mutated():
    """库内原件永不被改写(_build_graph 的既有契约)。"""
    wf = _graph_text(consumers=1, text="原件")
    bindings = {"text_text": {"node": "29", "field": "inputs.text"}}
    _build_graph(wf, bindings, {"text_text": "写入值"})
    assert "29" in wf and wf["29"]["inputs"]["text"] == "原件"
    assert wf["100"]["inputs"]["text1"] == ["29", 0]
    assert bindings["text_text"] == {"node": "29", "field": "inputs.text"}


# ---------- (c) 多消费方时不许重指 ----------

def test_bound_text_with_multiple_consumers_is_left_alone():
    g = _graph_text(consumers=2)
    bindings = {"text_text": {"node": "29", "field": "inputs.text"}}
    out = _normalize_primitive_literal_nodes(g, bindings)
    assert "29" in g, "多消费方时摘节点会把同一个表单值写歪,必须保留"
    assert out["text_text"] == {"node": "29", "field": "inputs.text"}


# ---------- (d) 带连线输入的不是字面量 ----------

def test_text_with_linked_input_is_skipped():
    g = {
        "29": {"class_type": "Text", "inputs": {"text": ["5", 0]}},
        "5": {"class_type": "StringSwitch", "inputs": {}},
        "100": {"class_type": "CR Text Concatenate", "inputs": {"text1": ["29", 0]}},
    }
    _normalize_primitive_literal_nodes(g, {})
    assert "29" in g
    assert g["100"]["inputs"]["text1"] == ["29", 0]


def test_non_literal_classes_untouched():
    g = {
        "1": {"class_type": "CLIPTextEncode", "inputs": {"text": "keep me"}},
        "2": {"class_type": "KSampler", "inputs": {"seed": 1}},
    }
    before = {k: dict(v["inputs"]) for k, v in g.items()}
    _normalize_primitive_literal_nodes(g, {})
    assert g["1"]["inputs"] == before["1"]
    assert g["2"]["inputs"] == before["2"]


def test_missing_output_slot_is_not_treated_as_consumer():
    """只有槽 0 是常量输出;引用其它槽的连线不该被内联成常量。"""
    g = {
        "29": {"class_type": "Text", "inputs": {"text": "v"}},
        "9": {"class_type": "Weird", "inputs": {"x": ["29", 1]}},
    }
    _normalize_primitive_literal_nodes(g, {})
    assert g["9"]["inputs"]["x"] == ["29", 1]


def test_non_dict_inputs_are_ignored():
    g = {"29": {"class_type": "Text", "inputs": None}}
    assert _normalize_primitive_literal_nodes(g, {}) == {}
    assert "29" in g


def test_none_bindings_tolerated():
    g = _graph_text(consumers=1)
    assert _normalize_primitive_literal_nodes(g, None) == {}
    assert g["100"]["inputs"]["text1"] == "hello"
