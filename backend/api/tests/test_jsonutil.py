"""app.jsonutil.parse_json_obj 共用 JSON 提取测试(P3 四合一合并)。

行为契约 = 原四处拷贝的并集:
  · 无锚(原 manju/optimize 版):think 剥离后首 { 到末 } 解析;
  · 有锚(原 drama_image/drama_studio 版):先按锚做平衡大括号匹配,
    思考段里散落的 {…} 示例不得被误当成最终结果;
  · 兜底:代码块包裹剥离、非法 JSON 返回 None。
"""
from __future__ import annotations

from app.jsonutil import parse_json_obj

_SHOTS_ANCHORS = ('{"shots"', "{'shots'", '"shots"')


# ── 无锚模式(原 manju/optimize 行为) ─────────────────────────────────────
def test_plain_object():
    assert parse_json_obj('{"a": 1}') == {"a": 1}


def test_prefix_suffix_tolerated():
    assert parse_json_obj('好的,结果如下 {"a": 1} 以上。') == {"a": 1}


def test_think_wrapped():
    raw = '<think>让我想想 {"a": 0} 不对</think>{"a": 1}'
    assert parse_json_obj(raw) == {"a": 1}


def test_markdown_fenced():
    raw = '```json\n{"a": 1}\n```'
    assert parse_json_obj(raw) == {"a": 1}


def test_invalid_returns_none():
    assert parse_json_obj("没有 JSON") is None
    assert parse_json_obj("{not json}") is None


def test_non_dict_returns_none():
    assert parse_json_obj("[1, 2, 3]") is None
    assert parse_json_obj('"just a string"') is None


# ── 锚定模式(原 drama_image/drama_studio 行为) ───────────────────────────
def test_anchored_plain():
    obj = parse_json_obj('{"title":"t","shots":[{"prompt":"p"}]}', anchors=_SHOTS_ANCHORS)
    assert obj == {"title": "t", "shots": [{"prompt": "p"}]}


def test_anchored_ignores_decoy_in_think():
    """思考段里的 {…} 示例不得被当成最终 JSON(锚定提取的核心价值)。"""
    raw = (
        '<think>格式像这样 {"shots": 弱示例, 非法} 嗯</think>'
        '最终答案:{"title":"t","shots":[{"prompt":"p"}]}'
    )
    obj = parse_json_obj(raw, anchors=_SHOTS_ANCHORS)
    assert obj == {"title": "t", "shots": [{"prompt": "p"}]}


def test_anchored_balanced_braces_with_nested_strings():
    """字符串内的花括号/转义引号不干扰平衡匹配。"""
    raw = '{"title":"t","shots":[{"prompt":"a {b} \\"c\\""}]}'
    obj = parse_json_obj(raw, anchors=_SHOTS_ANCHORS)
    assert obj["shots"][0]["prompt"] == 'a {b} "c"'


def test_anchored_fallback_when_anchor_absent():
    """锚不存在(模型给了别的键)→ 兜底:代码块剥离后首 { 到末 } 解析。"""
    raw = '```json\n{"title":"t","scenes":[]}\n```'
    obj = parse_json_obj(raw, anchors=_SHOTS_ANCHORS)
    assert obj == {"title": "t", "scenes": []}


def test_anchored_invalid_returns_none():
    assert parse_json_obj("没有 JSON", anchors=_SHOTS_ANCHORS) is None


# ── 四处调用方保留各自语义 ────────────────────────────────────────────────
def test_callers_keep_their_flavor():
    from app.routes import manju, optimize
    from app.routes import drama_studio
    from app.services import drama_image

    decoy = '<think>示例 {"a": 0}</think>{"title":"t","shots":[{"prompt":"p"}]}'
    # 无锚两处:首 { 到末 }(think 已剥离,取到完整对象)
    assert manju._parse_json_obj(decoy) == {"title": "t", "shots": [{"prompt": "p"}]}
    assert optimize._parse_json_obj(decoy) == {"title": "t", "shots": [{"prompt": "p"}]}
    # 锚定两处:同样取到目标块
    assert drama_studio._parse_json_obj(decoy) == {"title": "t", "shots": [{"prompt": "p"}]}
    assert drama_image._parse_json_obj(decoy) == {"title": "t", "shots": [{"prompt": "p"}]}
