"""ComfyUI UI(LiteGraph nodes[]/links[])↔ API prompt 图({id:{class_type,inputs}})双向转换。

纯函数,无 IO 无网络,供 M4 存量包装(seed)与 M5 智能导入(分析前置归一化)共用。

ComfyUI 官方转换规则(参照 ComfyUI 前端 graphToPrompt):
- links[] 每条 [link_id, 源节点id, 源输出槽, 目标节点id, 目标输入槽, 类型];
  节点 inputs[] 里带 link 的输入解析为 [源节点id(字符串), 源输出槽] 写入 inputs.<输入名>。
- widgets_values 按节点类固定的 widget 顺序映射为具名 inputs(_WIDGET_INPUTS 表);
  顺序表中的 None 是 UI 专属控件(如 KSampler 的 control_after_generate),不进 API 图。
- mode=2(muted)/4(bypassed) 的节点不进 prompt 图(ComfyUI 提交时同样剔除)。
- 模板未覆盖的 class_type:strict=True 时抛错(seed 用,保证全保真);
  默认宽松模式保留连线输入、丢弃 widgets(具名映射缺 data 源,运行期由 ComfyUI 校验报错)。
"""
from __future__ import annotations

from typing import Any

# class_type → widgets_values 顺序对应的 API inputs 名;None = UI 专属控件(跳过)。
# 覆盖范围:app/workflows/ 下 5 个 UI JSON 模板(txt2img_basic/img2img_basic/
# ltx_txt2video/ltx_img2video/ltx_lipsync)出现的全部节点类型;
# 映射与 workflows/ltx_video.py 等手写 API 构造器的字段名逐一核对一致。
_WIDGET_INPUTS: dict[str, list[str | None]] = {
    # ── 基础 SD 链 ──
    "CheckpointLoaderSimple": ["ckpt_name"],
    "CLIPTextEncode": ["text"],
    "EmptyLatentImage": ["width", "height", "batch_size"],
    # KSampler 第 2 个 widget 是 control_after_generate(UI 控件,非 API 输入)
    "KSampler": ["seed", None, "steps", "cfg", "sampler_name", "scheduler", "denoise"],
    "VAEDecode": [],
    "VAEEncode": [],
    "SaveImage": ["filename_prefix"],
    # LoadImage 第 2 个 widget 是上传方式选择(UI 控件),API 只需 image 文件名
    "LoadImage": ["image"],
    "LoadAudio": ["audio"],
    "LoadVideo": ["file"],
    # WAS Node Suite:新版必填 dynamic_prompts;缺省由 apps._normalize_* 回填 False
    "Text Multiline": ["text", "dynamic_prompts"],
    "Text Multiline (Code Compatible)": ["text"],
    # ── LTX2.3 链(字段名同 workflows/ltx_video.py)──
    "UNETLoader": ["unet_name", "weight_dtype"],
    "VAELoader": ["vae_name"],
    "LTXVGemmaCLIPModelLoader": ["gemma_path", "ltxv_path", "max_length"],
    "LTXVConditioning": ["frame_rate"],
    "EmptyLTXVLatentVideo": ["width", "height", "length", "batch_size"],
    "LTXVImgToVideo": ["width", "height", "length", "batch_size", "strength"],
    "LTXVAudioVAELoader": ["ckpt_name"],
    "LTXVReferenceAudio": ["identity_guidance_scale", "start_percent", "end_percent"],
    # VHS_VideoCombine:该节点 UI 保存序 format 在最前(模板实证),
    # 字段名同 workflows/ltx_video.py 的 _append_postprocess
    "VHS_VideoCombine": [
        "format", "frame_rate", "loop_count", "filename_prefix", "pingpong", "save_output",
    ],
}

# mode 2=muted / 4=bypassed:不进 prompt 图(与 ComfyUI 提交行为一致)
_SKIP_MODES = {2, 4}


def is_ui_format(workflow: Any) -> bool:
    """UI(LiteGraph)格式嗅探:含 list 类型的 nodes 键即视为 UI 工作流。"""
    return isinstance(workflow, dict) and isinstance(workflow.get("nodes"), list)


def ui_to_api(ui: dict, *, strict: bool = False) -> dict:
    """把 UI 格式工作流转成 API prompt 图。

    Args:
        ui: LiteGraph 序列化 dict(必须含 nodes/links;links 可缺省为空)。
        strict: True 时遇到未覆盖 class_type 抛 ValueError(seed 全保真校验用);
                False 时该类节点仅保留连线输入、丢弃 widgets。

    Returns:
        {节点id(str): {"class_type": ..., "inputs": {...}}} 的 API 格式图。

    Raises:
        ValueError: 结构不合法(缺 nodes、link id 悬空、strict 下未知节点类)。
    """
    if not is_ui_format(ui):
        raise ValueError("不是 ComfyUI UI 格式(缺少 nodes 数组)")

    # link_id → (源节点id, 源输出槽)
    link_src: dict[int, tuple[str, int]] = {}
    for link in ui.get("links") or []:
        if not (isinstance(link, (list, tuple)) and len(link) >= 5):
            raise ValueError(f"links 项格式非法: {link!r}")
        link_id, src_node, src_slot = link[0], link[1], link[2]
        link_src[int(link_id)] = (str(src_node), int(src_slot))

    graph: dict[str, dict] = {}
    for node in ui["nodes"]:
        if not isinstance(node, dict) or "id" not in node or "type" not in node:
            raise ValueError(f"节点缺少 id/type: {node!r}")
        if node.get("mode", 0) in _SKIP_MODES:
            continue
        nid = str(node["id"])
        class_type = str(node["type"])
        inputs: dict[str, Any] = {}
        # 连线输入
        for inp in node.get("inputs") or []:
            if not isinstance(inp, dict):
                continue
            link_id = inp.get("link")
            if link_id is None:
                continue
            src = link_src.get(int(link_id))
            if src is None:
                raise ValueError(f"节点 {nid} 输入 {inp.get('name')} 指向悬空 link {link_id}")
            inputs[str(inp["name"])] = [src[0], src[1]]
        # widget 输入(按类固定顺序具名化;None 位与超长尾巴丢弃)
        names = _WIDGET_INPUTS.get(class_type)
        values = node.get("widgets_values")
        if names is None:
            if strict and values:
                raise ValueError(f"未覆盖的节点类型 {class_type}(节点 {nid}),widgets 无法具名映射")
        elif isinstance(values, list):
            for name, value in zip(names, values):
                if name is not None:
                    inputs[name] = value
        graph[nid] = {"class_type": class_type, "inputs": inputs}
    return graph



# UI 专属 widget 占位默认值(api_to_ui 填 None 槽;与常见 Comfy 前端一致)
_WIDGET_UI_DEFAULTS: dict[str, dict[int, Any]] = {
    "KSampler": {1: "fixed"},
    "LoadImage": {1: "image"},
}


def is_api_format(workflow: Any) -> bool:
    """API prompt 图嗅探:非 UI,且至少一节点含 class_type。"""
    if not isinstance(workflow, dict) or not workflow or is_ui_format(workflow):
        return False
    return any(
        isinstance(v, dict) and isinstance(v.get("class_type"), str) for v in workflow.values()
    )


def _topo_columns(api: dict) -> list[list[str]]:
    """按最长路径深度分列(环截断为 0),供 api_to_ui 摆坐标。"""
    ids = [k for k, v in api.items() if isinstance(v, dict) and "class_type" in v]
    id_set = set(ids)
    parents: dict[str, list[str]] = {i: [] for i in ids}
    for nid in ids:
        for v in (api[nid].get("inputs") or {}).values():
            if isinstance(v, (list, tuple)) and len(v) >= 1 and str(v[0]) in id_set:
                parents[nid].append(str(v[0]))
    depth: dict[str, int] = {}

    def resolve(nid: str, seen: set[str]) -> int:
        if nid in depth:
            return depth[nid]
        if nid in seen:
            return 0
        seen.add(nid)
        d = 0
        for p in parents[nid]:
            d = max(d, resolve(p, seen) + 1)
        depth[nid] = d
        return d

    for nid in ids:
        resolve(nid, set())
    cols: dict[int, list[str]] = {}
    for nid in ids:
        cols.setdefault(depth.get(nid, 0), []).append(nid)
    return [cols[k] for k in sorted(cols)]


def api_to_ui(api: dict) -> dict:
    """把 API prompt 图转成可被 ComfyUI Load / ?workflow= 打开的 UI(LiteGraph)JSON。

    - 连线输入([src_id, slot]) → links[] + inputs[].link
    - 标量输入 → widgets_values(按 _WIDGET_INPUTS 逆映射;未知 class 按 key 排序尽力)
    - 坐标:拓扑分列自动布局(无原始 pos)
    - 输出端口按被引用 slot 建桩(类型用 "*");Comfy 加载时会按节点定义补全

    Raises:
        ValueError: 不是 API 格式图。
    """
    if is_ui_format(api):
        raise ValueError("已是 ComfyUI UI 格式(含 nodes 数组),无需 api_to_ui")
    if not is_api_format(api):
        raise ValueError("不是 ComfyUI API 格式(缺少 class_type 节点)")

    node_ids = [k for k, v in api.items() if isinstance(v, dict) and "class_type" in v]
    id_set = set(node_ids)

    # 先收集每节点:linked inputs(保序)与 scalar widgets
    linked: dict[str, list[tuple[str, str, int]]] = {}  # nid → [(in_name, src_id, src_slot)]
    scalars: dict[str, dict[str, Any]] = {}
    for nid in node_ids:
        linked[nid] = []
        scalars[nid] = {}
        for name, val in (api[nid].get("inputs") or {}).items():
            if (
                isinstance(val, (list, tuple))
                and len(val) >= 2
                and str(val[0]) in id_set
                and isinstance(val[1], (int, float))
            ):
                linked[nid].append((str(name), str(val[0]), int(val[1])))
            else:
                scalars[nid][str(name)] = val

    # links + 端口索引
    links: list[list[Any]] = []
    link_id = 0
    # nid → list of input dicts (with link filled)
    node_inputs: dict[str, list[dict]] = {n: [] for n in node_ids}
    # (src_nid, src_slot) → list of link_ids
    out_links: dict[tuple[str, int], list[int]] = {}
    max_out_slot: dict[str, int] = {n: -1 for n in node_ids}

    for nid in node_ids:
        for slot_idx, (in_name, src_id, src_slot) in enumerate(linked[nid]):
            link_id += 1
            links.append([link_id, int(src_id) if src_id.isdigit() else src_id, src_slot, int(nid) if nid.isdigit() else nid, slot_idx, "*"])
            node_inputs[nid].append({"name": in_name, "type": "*", "link": link_id})
            out_links.setdefault((src_id, src_slot), []).append(link_id)
            max_out_slot[src_id] = max(max_out_slot[src_id], src_slot)

    # widgets_values
    def build_widgets(class_type: str, vals: dict[str, Any]) -> list[Any]:
        names = _WIDGET_INPUTS.get(class_type)
        if names is None:
            # 未知类:稳定顺序尽力塞入(加载后 widget 对齐可能不准,但节点/连线可用)
            return [vals[k] for k in sorted(vals)]
        out: list[Any] = []
        defaults = _WIDGET_UI_DEFAULTS.get(class_type, {})
        used: set[str] = set()
        for i, name in enumerate(names):
            if name is None:
                out.append(defaults.get(i, ""))
            else:
                out.append(vals.get(name))
                used.add(name)
        # 未映射进表的剩余标量追加(保信息不丢;Comfy 可能忽略超长尾巴)
        for k in sorted(vals):
            if k not in used:
                out.append(vals[k])
        return out

    # 坐标
    gap_x, gap_y = 320, 160
    pos: dict[str, list[float]] = {}
    for col_i, col in enumerate(_topo_columns(api)):
        for row_i, nid in enumerate(col):
            pos[nid] = [30 + col_i * gap_x, 30 + row_i * gap_y]

    nodes: list[dict] = []
    for order, nid in enumerate(node_ids):
        class_type = str(api[nid]["class_type"])
        # outputs 桩:覆盖被引用的最大 slot
        n_out = max(max_out_slot[nid] + 1, 0)
        outputs = []
        for s in range(n_out):
            outputs.append({
                "name": f"out_{s}" if n_out > 1 else "OUT",
                "type": "*",
                "links": out_links.get((nid, s), []) or None,
                "shape": 3,
                "slot_index": s,
            })
        # 无输出引用也给一个空输出桩,避免部分节点在 UI 里不可见出口
        if not outputs:
            outputs = [{"name": "OUT", "type": "*", "links": None, "shape": 3, "slot_index": 0}]

        try:
            nid_num: Any = int(nid)
        except ValueError:
            nid_num = nid

        nodes.append({
            "id": nid_num,
            "type": class_type,
            "pos": pos.get(nid, [30, 30]),
            "size": {"0": 280, "1": 100 + 24 * len(node_inputs[nid])},
            "flags": {},
            "order": order,
            "mode": 0,
            "inputs": node_inputs[nid],
            "outputs": outputs,
            "properties": {"Node name for S&R": class_type},
            "widgets_values": build_widgets(class_type, scalars[nid]),
        })

    # last_node_id:数字 id 取 max,否则用节点数
    numeric_ids = [n["id"] for n in nodes if isinstance(n["id"], int)]
    last_node_id = max(numeric_ids) if numeric_ids else len(nodes)

    return {
        "last_node_id": last_node_id,
        "last_link_id": link_id,
        "nodes": nodes,
        "links": links,
        "groups": [],
        "config": {},
        "extra": {"toiv_api_to_ui": True},
        "version": 0.4,
    }
