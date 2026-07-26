"""画布子图 ↔ ComfyUI API JSON 双向桥(M2.1 + M2.2)。

M2 目标:画布既能「导入现有 ComfyUI 工作流模板作为子图构件」,也能
「把画布子图转换回 ComfyUI prompt 提交执行」。本模块是纯函数层(无 IO、
无数据库访问),路由层(routes/canvas.py)负责持久化与执行。

核心契约
========

**comfy_workflow 节点是图的载体**:其 ``payload.graph`` 保存完整的 ComfyUI
API JSON(``{节点id: {class_type, inputs}}``)。画布上的 prompt / text /
image / audio 节点通过**边**连到 comfy_workflow 节点,作为「输入透镜」在
导出时覆盖图里对应输入口。

**边标签(label)约定**(源节点 → comfy_workflow 节点):

- ``positive`` / ``prompt`` / ``text`` → 图中第一个 CLIPTextEncode 的 ``text``
- ``negative`` → 图中第二个 CLIPTextEncode 的 ``text``
- ``<节点id>.<输入键>`` → 显式指定,如 ``6.text`` / ``9.image``

**导入方向**(ComfyUI API JSON → 画布子图):整张图原样存进一个
comfy_workflow 节点(保证往返无损),同时把 CLIPTextEncode / LoadImage /
LoadAudio 提取为独立的 prompt / image / audio 节点,用显式标签边连回
工作流节点 —— 用户导入后即可在画布上直接改提示词/换图。

**UI 格式转换**:ComfyUI 前端导出的 ``*.json`` 是 UI 格式(nodes/links/
widgets_values),与 API 格式不同。``comfy_ui_graph_to_api`` 用内置
widgets 名称表(覆盖本仓 5 个内置模板的全部 class_type)完成转换;
未知 class_type 的 widgets 无法映射时抛 ValueError(显式失败,不静默出残图)。
"""
from __future__ import annotations

import copy
import json
from typing import Any
from urllib.parse import parse_qs, urlparse

# ---------------------------------------------------------------------------
# class_type ↔ kind 映射
# ---------------------------------------------------------------------------

# 导入时提取为独立画布节点的 class_type → 画布节点 kind。
# 未列出的 class_type 一律留在 comfy_workflow 节点的 graph 内(不提取)。
CLASS_TYPE_TO_KIND: dict[str, str] = {
    "CLIPTextEncode": "prompt",
    "LoadImage": "image",
    "LoadAudio": "audio",
    # M3.2:视频输入(ComfyUI 核心 LoadVideo + VideoHelperSuite VHS_LoadVideo)
    "LoadVideo": "video",
    "VHS_LoadVideo": "video",
}


# ---------------------------------------------------------------------------
# 节点 payload 解析(CanvasNode.payload 是 JSON 串,可能残缺)
# ---------------------------------------------------------------------------
def _node_payload(node: Any) -> dict:
    """解析 CanvasNode.payload(JSON 串)为 dict;残缺时回退空 dict。"""
    raw = getattr(node, "payload", "") or ""
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError):
        return {}
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------------------
# kind → ComfyUI 输入值 构造器(导出方向)
# ---------------------------------------------------------------------------
def _build_text_override(node: Any) -> str:
    """prompt / text 节点 → 文本值(覆盖 CLIPTextEncode.text 等)。"""
    text = _node_payload(node).get("text") or getattr(node, "title", "")
    if not text:
        raise ValueError(f"节点 {getattr(node, 'id', '?')} 没有可用文本")
    return str(text)


def _build_file_override(*payload_keys: str):
    """生成「产物节点 → 文件名」构造器(image/audio/video 节点共用)。

    依次尝试 payload[filename] / payload[image|audio|video|file] /
    payload.urls[0](先解析 ``/api/images?filename=...`` 查询串,再退化为
    路径 basename),都为空时报错。
    """

    def build(node: Any) -> str:
        p = _node_payload(node)
        name = p.get("filename")
        for key in payload_keys:
            name = name or p.get(key)
        if not name:
            urls = p.get("urls") or []
            if urls:
                u = str(urls[0])
                # /api/images?filename=x.png&worker=... → x.png
                qs = parse_qs(urlparse(u).query)
                name = (qs.get("filename") or [""])[0]
                if not name:
                    name = u.rsplit("/", 1)[-1].split("?")[0]
        if not name:
            raise ValueError(
                f"节点 {getattr(node, 'id', '?')} 缺少文件名"
                "(payload.filename / urls 均为空)"
            )
        return str(name)

    return build


# 画布节点 kind → ComfyUI 输入值构造器。
# 只有列出的 kind 能作为 comfy_workflow 的输入源;其余 kind(llm/tts/asr/
# model3d)与 ComfyUI 图无语义对应,导出时报错而非静默丢弃。
KIND_TO_COMFY_BUILDERS: dict[str, Any] = {
    "prompt": _build_text_override,
    "text": _build_text_override,
    "image": _build_file_override("image"),
    "audio": _build_file_override("audio"),
    # M3.2:video 节点(pin 的产物或上传视频)→ LoadVideo 文件名
    "video": _build_file_override("video", "file"),
}


# ---------------------------------------------------------------------------
# ComfyUI prompt 结构校验与节点查找
# ---------------------------------------------------------------------------
def validate_comfy_prompt(prompt: Any) -> None:
    """校验 ComfyUI API JSON 结构:{节点id: {class_type, inputs}}。不合格抛 ValueError。"""
    if not isinstance(prompt, dict) or not prompt:
        raise ValueError("ComfyUI prompt 为空或不是 dict")
    bad = [
        k for k, v in prompt.items()
        if not (isinstance(v, dict) and v.get("class_type"))
    ]
    if bad:
        raise ValueError(f"ComfyUI 节点 {bad[:5]} 缺少 class_type")


def _nid_sort_key(nid: str) -> tuple[int, Any]:
    """节点 id 排序键:数字 id 按数值排,非数字按字符串排(稳定且符合直觉)。"""
    return (0, int(nid)) if str(nid).isdigit() else (1, str(nid))


def _text_encode_ids(graph: dict) -> list[str]:
    """图中全部 CLIPTextEncode 节点 id(按 id 排序;第一个=正向,第二个=负向)。"""
    ids = [
        nid for nid, n in graph.items()
        if isinstance(n, dict) and n.get("class_type") == "CLIPTextEncode"
    ]
    return sorted(ids, key=_nid_sort_key)


def _resolve_label(graph: dict, label: str) -> tuple[str, str]:
    """把边标签解析为 (目标节点id, 输入键)。

    支持 shorthand(positive/negative/prompt/text)与显式 ``<nid>.<key>``。
    解析失败抛 ValueError(信息里带可用目标,便于排查)。
    """
    label = (label or "").strip() or "positive"
    shorthand = label.lower()
    if shorthand in ("positive", "prompt", "text", "negative"):
        te_ids = _text_encode_ids(graph)
        if not te_ids:
            raise ValueError("图中没有 CLIPTextEncode 节点可接收文本输入")
        if shorthand == "negative":
            if len(te_ids) < 2:
                raise ValueError("图中没有第二个 CLIPTextEncode 节点可作负向输入")
            return te_ids[1], "text"
        return te_ids[0], "text"
    if "." in label:
        nid, key = label.split(".", 1)
        nid, key = nid.strip(), key.strip()
        if nid not in graph:
            raise ValueError(
                f"边标签 {label!r} 指向的节点 {nid!r} 不在图中"
                f"(可用: {sorted(graph.keys(), key=_nid_sort_key)})"
            )
        inputs = graph[nid].get("inputs") or {}
        if key not in inputs:
            raise ValueError(
                f"边标签 {label!r} 指向的输入键 {key!r} 不存在于节点 {nid} "
                f"(可用: {sorted(inputs.keys())})"
            )
        return nid, key
    raise ValueError(
        f"无法解析边标签 {label!r}(支持 positive/negative 或 <节点id>.<输入键>)"
    )


# ---------------------------------------------------------------------------
# 导出:画布子图 → ComfyUI API prompt
# ---------------------------------------------------------------------------
def canvas_subgraph_to_comfy_prompt(
    nodes: list[Any],
    edges: list[Any],
) -> tuple[dict, dict]:
    """把画布子图编译为 ComfyUI API prompt。

    参数:
        nodes: 子图内的 CanvasNode 列表(须恰好含一个带 payload.graph 的
            comfy_workflow 节点)。
        edges: 子图内的 CanvasEdge 列表(只考虑目标为工作流节点的边)。

    返回:
        (graph, report):
        - graph: 应用了覆盖后的 ComfyUI API prompt(深拷贝,不改原 payload)。
        - report: {"workflow_node_id": 工作流节点 id,
                   "overrides": {"<nid>.<key>": 源画布节点 id}}

    异常:
        ValueError —— 没有/多个工作流节点、边标签无法解析、源节点 kind 不支持。
    """
    wf_nodes = [
        n for n in nodes
        if getattr(n, "kind", None) == "comfy_workflow"
        and _node_payload(n).get("graph")
    ]
    if not wf_nodes:
        raise ValueError("子图中需要一个含 graph 的 comfy_workflow 节点")
    if len(wf_nodes) > 1:
        raise ValueError("子图最多包含一个 comfy_workflow 节点(M2 限制)")
    wf = wf_nodes[0]

    graph = copy.deepcopy(_node_payload(wf)["graph"])
    validate_comfy_prompt(graph)

    node_ids = {getattr(n, "id", None) for n in nodes}
    by_id = {getattr(n, "id", None): n for n in nodes}
    overrides: dict[str, str] = {}
    for e in edges:
        if getattr(e, "target", None) != getattr(wf, "id", None):
            continue
        src = by_id.get(getattr(e, "source", None))
        if src is None or getattr(e, "source", None) not in node_ids:
            continue
        builder = KIND_TO_COMFY_BUILDERS.get(getattr(src, "kind", ""))
        if builder is None:
            raise ValueError(
                f"kind={getattr(src, 'kind', '?')} 不能作为 ComfyUI 输入"
                f"(支持: {sorted(KIND_TO_COMFY_BUILDERS)})"
            )
        nid, key = _resolve_label(graph, getattr(e, "label", "") or "")
        graph[nid].setdefault("inputs", {})[key] = builder(src)
        overrides[f"{nid}.{key}"] = getattr(src, "id", "")

    return graph, {
        "workflow_node_id": getattr(wf, "id", ""),
        "overrides": overrides,
    }


# ---------------------------------------------------------------------------
# 导入:ComfyUI API prompt → 画布子图(节点/边规格,由路由层持久化)
# ---------------------------------------------------------------------------
def comfy_prompt_to_canvas_subgraph(
    comfy_prompt: dict,
    *,
    canvas_id: str,
    base_position: tuple[float, float] = (0.0, 0.0),
    title: str = "",
) -> tuple[list[dict], list[dict]]:
    """把 ComfyUI API prompt 展开为画布子图规格(不持久化,纯数据)。

    整张图原样存进一个 comfy_workflow 节点(payload.graph,保证往返无损),
    并把 CLASS_TYPE_TO_KIND 列出的 class_type 提取为独立节点,用显式标签
    边连回工作流节点(导入后可直接在画布上改提示词/换输入图)。

    返回:
        (nodes, edges):
        - nodes: [{"ref","canvas_id","kind","title","position_x","position_y",
                   "payload"(dict)}],ref 是临时引用键(路由层落库后映射为真实 id)。
        - edges: [{"source_ref","target_ref","label"}]
    """
    validate_comfy_prompt(comfy_prompt)
    graph = copy.deepcopy(comfy_prompt)
    bx, by = base_position

    nodes: list[dict] = [{
        "ref": "workflow",
        "canvas_id": canvas_id,
        "kind": "comfy_workflow",
        "title": title or "ComfyUI 工作流",
        "position_x": float(bx),
        "position_y": float(by),
        "payload": {
            "graph": graph,
            "summary": f"{len(graph)} 节点 ComfyUI 工作流",
        },
    }]
    edges: list[dict] = []

    # 待提取节点:(节点id, kind, 标题, 提取值, 输入键)
    extracted: list[tuple[str, str, str, Any, str]] = []
    te_ids = _text_encode_ids(graph)
    for i, nid in enumerate(te_ids):
        text = (graph[nid].get("inputs") or {}).get("text", "")
        label = "正向提示词" if i == 0 else ("负向提示词" if i == 1 else f"提示词 {nid}")
        extracted.append((nid, "prompt", label, str(text), "text"))
    _MEDIA_TITLES = {"image": "输入图片", "audio": "输入音频", "video": "输入视频"}
    for nid in sorted(graph.keys(), key=_nid_sort_key):
        node = graph[nid]
        ctype = node.get("class_type")
        kind = CLASS_TYPE_TO_KIND.get(ctype)
        if kind in _MEDIA_TITLES:
            inputs = node.get("inputs") or {}
            fname = inputs.get(kind) or inputs.get("file") or inputs.get("filename") or ""
            # 输入键取图中实际存在的键(优先与 kind 同名),供显式标签边回写
            input_key = next(
                (k for k in (kind, "file", "filename") if k in inputs), kind
            )
            extracted.append((nid, kind, _MEDIA_TITLES[kind], fname, input_key))

    for idx, (nid, kind, node_title, value, input_key) in enumerate(extracted):
        ref = f"x:{nid}"
        payload: dict[str, Any]
        if kind == "prompt":
            payload = {"text": value}
        else:
            payload = {"filename": value, "urls": []}
        nodes.append({
            "ref": ref,
            "canvas_id": canvas_id,
            "kind": kind,
            "title": node_title,
            # 提取节点竖排在工作流节点左侧,间距与前端节点高度匹配
            "position_x": float(bx) - 440.0,
            "position_y": float(by) + idx * 190.0,
            "payload": payload,
        })
        edges.append({
            "source_ref": ref,
            "target_ref": "workflow",
            "label": f"{nid}.{input_key}",
        })

    return nodes, edges


# ---------------------------------------------------------------------------
# ComfyUI UI 格式 → API 格式(内置模板 *.json 导入用)
# ---------------------------------------------------------------------------

# class_type → widgets_values 名称表(按 UI 导出顺序;None = UI 专属控件,丢弃)。
# 覆盖本仓 app/workflows/*.json 全部 class_type;顺序经 2026-07 实测核对:
#   - KSampler 第 2 项 control_after_generate("randomize")是 UI 专属,API 无此键。
#   - LoadImage 第 2 项("image")是上传按钮标记,丢弃。
#   - VHS_VideoCombine 的 format 排在 widgets 首位(与 inputs 书写顺序无关)。
_WIDGET_NAMES: dict[str, list[str | None]] = {
    "CheckpointLoaderSimple": ["ckpt_name"],
    "CLIPTextEncode": ["text"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    "KSampler": ["seed", None, "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    "VAEDecode": [],
    "VAEEncode": [],
    "SaveImage": ["filename_prefix"],
    "LoadImage": ["image", None],
    "LoadAudio": ["audio"],
    # M3.2:LoadVideo 第 2 项是上传按钮标记(同 LoadImage),丢弃;
    # VHS_LoadVideo 仅登记首个文件控件,其余(force_rate/force_size 等)走默认。
    "LoadVideo": ["video", None],
    "VHS_LoadVideo": ["video"],
    "UNETLoader": ["unet_name", "weight_dtype"],
    "LTXVGemmaCLIPModelLoader": ["gemma_path", "ltxv_path", "max_length"],
    "VAELoader": ["vae_name"],
    "LTXVConditioning": ["frame_rate"],
    "EmptyLTXVLatentVideo": ["width", "height", "length", "batch_size"],
    "LTXVImgToVideo": ["width", "height", "length", "batch_size", "strength"],
    "LTXVAudioVAELoader": ["ckpt_name"],
    "LTXVReferenceAudio": ["identity_guidance_scale", "start_percent", "end_percent"],
    "VHS_VideoCombine": [
        "format", "frame_rate", "loop_count", "filename_prefix", "pingpong", "save_output",
    ],
}


def comfy_ui_graph_to_api(ui_graph: dict) -> dict:
    """把 ComfyUI 前端导出的 UI 格式 JSON 转为 API 格式 prompt。

    UI 格式:{nodes: [{id, type, inputs: [{name, link}], widgets_values: [...]}],
              links: [[link_id, src_id, src_slot, dst_id, dst_slot, type], ...]}
    API 格式:{节点id(str): {class_type, inputs: {键: 标量 | [src_id, src_slot]}}}

    widgets 映射依赖 _WIDGET_NAMES;未知 class_type 带 widgets 时抛 ValueError
    (显式失败,避免静默产出缺参数的残图)。
    """
    nodes = ui_graph.get("nodes")
    if not isinstance(nodes, list) or not nodes:
        raise ValueError("UI 格式缺少 nodes 数组")
    links = ui_graph.get("links") or []
    link_by_id = {l[0]: l for l in links if isinstance(l, list) and len(l) >= 5}

    out: dict[str, dict] = {}
    for n in nodes:
        ctype = n.get("type")
        if not ctype:
            raise ValueError(f"UI 节点 {n.get('id')} 缺少 type")
        nid = str(n.get("id"))
        inputs: dict[str, Any] = {}
        # 链接输入:目标节点的 inputs[].link → links 表查源 (src_id, src_slot)
        for inp in n.get("inputs") or []:
            lid = inp.get("link")
            if lid is None:
                continue
            link = link_by_id.get(lid)
            if link is None:
                continue
            inputs[inp["name"]] = [str(link[1]), link[2]]
        # widget 输入:按名称表顺序映射(None 项丢弃)
        widget_names = _WIDGET_NAMES.get(ctype)
        widget_values = n.get("widgets_values") or []
        if widget_names is None:
            if widget_values:
                raise ValueError(
                    f"暂不支持转换 {ctype} 的 widgets(需在 _WIDGET_NAMES 登记)"
                )
            widget_names = []
        for key, value in zip(widget_names, widget_values):
            if key is None:
                continue
            inputs[key] = value
        out[nid] = {"class_type": ctype, "inputs": inputs}
    return out
