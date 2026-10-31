"""W8-11b:socket 越界(连线输出槽索引 ≥ 源类 RETURN_TYPES 长度)静态检出。

真凶形状取自生产实证 `rh-acc-6551162881-57c57b`:
`327(TextEncodeQwenImageEditPlus).prompt ← ['382', 1]`,而 `RHHiddenNodes` 只有 1 个输出。
ComfyUI `execution.py:925-927` 的 `r[val[1]]` 必抛 `tuple index out of range`,
但异常被 inner 分支(`:961`)捕获后挂在**下游消费者**身上,真凶不出现在错误信息里,
故必须靠静态比对点名源类。

该桶与既有三类不同:判据是**确定**的(无容忍反例),不作闸的唯一理由是
preflight 用全 fleet 并集 objinfo,同名类在不同 worker 上 arity 可能不同。
"""
import asyncio

import app.services.app_smoke as app_smoke
from app.services.app_smoke import preflight_check, signature_mismatches


def _oi(outputs, required=None, optional=None):
    return {
        "output": list(outputs),
        "input": {"required": required or {}, "optional": optional or {}},
    }


def _real_case():
    """生产真图的形状(节点 id 沿用实证编号)。"""
    graph = {
        "10": {"class_type": "LoadImage", "inputs": {"image": "a.png"}},
        "11": {"class_type": "CLIPLoader", "inputs": {"clip_name": "c.safetensors"}},
        "382": {"class_type": "RHHiddenNodes", "inputs": {"image_1": ["10", 0]}},
        "327": {"class_type": "TextEncodeQwenImageEditPlus",
                "inputs": {"clip": ["11", 0], "prompt": ["382", 1]}},
    }
    objinfo = {
        "LoadImage": _oi(["IMAGE", "MASK"], required={"image": [["a.png"], {}]}),
        "CLIPLoader": _oi(["CLIP"], required={"clip_name": [["c.safetensors"], {}]}),
        "RHHiddenNodes": _oi(["IMAGE"], optional={
            "image_1": ["IMAGE"], "pwd": ["STRING", {"default": ""}]}),
        "TextEncodeQwenImageEditPlus": _oi(
            ["CONDITIONING"],
            required={"clip": ["CLIP"], "prompt": ["STRING"]},
            optional={"vae": ["VAE"], "image1": ["IMAGE"]}),
    }
    return graph, objinfo


def test_detects_out_of_range_socket_and_names_source_class():
    graph, objinfo = _real_case()
    hits = signature_mismatches(graph, objinfo)["socket_out_of_range"]
    assert len(hits) == 1
    # 必须点名真凶源类,而不是像 ComfyUI 那样只报下游消费者
    assert "RHHiddenNodes" in hits[0]
    assert "TextEncodeQwenImageEditPlus" in hits[0]
    assert "prompt" in hits[0]


def test_in_range_socket_not_reported():
    graph, objinfo = _real_case()
    graph["327"]["inputs"]["prompt"] = ["382", 0]
    assert signature_mismatches(graph, objinfo)["socket_out_of_range"] == []


def test_source_class_absent_from_objinfo_is_not_guessed():
    """源类不在 objinfo(未安装)时不猜 arity——缺类名归 missing_nodes 那条路径。"""
    graph, objinfo = _real_case()
    objinfo.pop("RHHiddenNodes")
    assert signature_mismatches(graph, objinfo)["socket_out_of_range"] == []


def test_dangling_link_is_not_reported_here():
    """指向不存在节点的连线不是 socket 越界,别在这个桶里重复报。"""
    graph, objinfo = _real_case()
    graph["327"]["inputs"]["prompt"] = ["999", 0]
    assert signature_mismatches(graph, objinfo)["socket_out_of_range"] == []


def test_bool_second_element_is_not_treated_as_socket():
    """isinstance(True, int) 为真,必须显式排除,否则 True 会被读成槽 1。"""
    graph, objinfo = _real_case()
    graph["327"]["inputs"]["prompt"] = ["382", True]
    assert signature_mismatches(graph, objinfo)["socket_out_of_range"] == []


def test_widget_list_literal_is_not_treated_as_link():
    graph, objinfo = _real_case()
    graph["327"]["inputs"]["prompt"] = [1, 2]
    assert signature_mismatches(graph, objinfo)["socket_out_of_range"] == []


def test_undeclared_and_socket_buckets_both_fire():
    """未声明的键上挂越界连线:两个桶都要报(新增检查不得吞掉既有 undeclared)。"""
    graph, objinfo = _real_case()
    graph["327"]["inputs"]["not_a_real_field"] = ["382", 1]
    out = signature_mismatches(graph, objinfo)
    assert len(out["socket_out_of_range"]) == 2
    assert any("not_a_real_field" in u for u in out["undeclared"])


def test_existing_buckets_unchanged_for_real_case():
    """回归守卫:新增检查不改变既有三类的判定。"""
    graph, objinfo = _real_case()
    out = signature_mismatches(graph, objinfo)
    assert out["missing_required"] == []
    assert out["combo_invalid"] == []
    assert out["undeclared"] == []


def test_preflight_exposes_bucket_but_does_not_flip_procurable(monkeypatch):
    graph, objinfo = _real_case()

    async def _fake_union(pool):
        return objinfo

    monkeypatch.setattr(app_smoke, "_union_objinfo", _fake_union)
    out = asyncio.run(preflight_check(None, graph))
    assert len(out["signature_socket_out_of_range"]) == 1
    # 只透出、不做闸:并集 arity 未必等于实际接单那台
    assert out["procurable"] is True
    assert out["missing_models"] == []
    assert out["missing_nodes"] == []
