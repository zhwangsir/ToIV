"""ComfyUI UI 工作流(LiteGraph nodes[]/links[])→ API prompt 图({id:{class_type,inputs}})转换。

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
