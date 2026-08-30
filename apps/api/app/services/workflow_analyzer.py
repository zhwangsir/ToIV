"""应用市场 M5:ComfyUI 工作流结构分析器(智能导入的第一棒)。

输入任意来源的 ComfyUI JSON,自动嗅探格式并归一化为 API 图:
- UI(LiteGraph)格式:含 nodes 数组 → 先经 services/workflow_convert.ui_to_api 转换;
- API 格式:{节点id: {class_type, inputs}};外层包 {"prompt": {...}} 的归档形态自动拆壳。

解析产物(WorkflowAnalysis)喂给 services/app_packager 的 LLM 包装:
- class_types:图中出现的全部节点类(去重排序);
- 输入透镜:用户该填内容的入口 ——
  · CLIPTextEncode → prompt textarea(text 是标量才入选;被连线占用的不算);
  · LoadImage → images / LoadVideo → video / LoadAudio → audio;
- numeric_candidates:数值 widget 候选(steps/cfg/seed/width/height/帧数等白名单字段名,
  仅标量 int/float 叶子;连线与字符串不入候选);
- output_kind:按产物节点推断(SaveVideo/VHS_VideoCombine/CreateVideo → video,
  SaveAudio 系 → audio,SaveImage/PreviewImage → image;都没有按 image 兜底)。
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from app.services.workflow_convert import is_ui_format, ui_to_api

# 数值 widget 候选白名单:只有这些语义的数值叶子值得暴露成表单参数
_NUMERIC_FIELD_NAMES = {
    "steps", "cfg", "seed", "noise_seed", "width", "height", "length",
    "batch_size", "frame_rate", "fps", "denoise", "max_length", "strength",
}

_OUTPUT_VIDEO_NODES = {"SaveVideo", "VHS_VideoCombine", "CreateVideo"}
_OUTPUT_AUDIO_NODES = {"SaveAudio", "SaveAudioMP3", "PreviewAudio"}
_OUTPUT_IMAGE_NODES = {"SaveImage", "PreviewImage"}


@dataclass(frozen=True)
class WorkflowAnalysis:
    """工作流结构分析结果(全部可 JSON 序列化,直接喂 LLM prompt)。"""

    format: str  # "api" | "ui"
    graph: dict  # 归一化后的 API 格式图
    class_types: list[str]
    prompt_inputs: list[dict] = field(default_factory=list)
    image_inputs: list[dict] = field(default_factory=list)
    video_inputs: list[dict] = field(default_factory=list)
    audio_inputs: list[dict] = field(default_factory=list)
    numeric_candidates: list[dict] = field(default_factory=list)
    output_kind: str = "image"

    def to_prompt_dict(self) -> dict:
        """LLM prompt 注入形态(不含完整图 —— 图由 packager 按需附带)。"""
        return {
            "format": self.format,
            "node_count": len(self.graph),
            "class_types": self.class_types,
            "prompt_inputs": self.prompt_inputs,
            "image_inputs": self.image_inputs,
            "video_inputs": self.video_inputs,
            "audio_inputs": self.audio_inputs,
            "numeric_candidates": self.numeric_candidates,
            "output_kind_guess": self.output_kind,
        }


def sniff_format(workflow: Any) -> str:
    """格式嗅探:返回 "ui" / "api";都不是抛 ValueError(路由侧 422)。"""
    if is_ui_format(workflow):
        return "ui"
    if isinstance(workflow, dict):
        inner = workflow.get("prompt")
        if isinstance(inner, dict) and inner:
            return "api"  # {"prompt": {...}} 归档壳
        if workflow and all(
            isinstance(v, dict) and isinstance(v.get("class_type"), str)
            for v in workflow.values()
        ):
            return "api"
    raise ValueError("无法识别的 ComfyUI 工作流格式(既非 UI nodes 数组也非 API prompt 图)")


def normalize_to_api(workflow: Any) -> tuple[str, dict]:
    """嗅探 + 归一化:返回 (原格式, API 图)。非法输入抛 ValueError。"""
    fmt = sniff_format(workflow)
    if fmt == "ui":
        return "ui", ui_to_api(workflow)  # 宽松模式:未知节点类丢 widgets 保连线
    inner = workflow.get("prompt") if isinstance(workflow, dict) else None
    graph = inner if isinstance(inner, dict) and inner else workflow
    return "api", graph


def _guess_output_kind(class_types: set[str]) -> str:
    if class_types & _OUTPUT_VIDEO_NODES:
        return "video"
    if class_types & _OUTPUT_AUDIO_NODES:
        return "audio"
    return "image"  # SaveImage/PreviewImage 或无显式产物节点都按 image 兜底


def analyze_workflow(workflow: Any) -> WorkflowAnalysis:
    """结构分析主入口:归一化 → 透镜识别 + 数值候选 + 产物类型推断。"""
    fmt, graph = normalize_to_api(workflow)
    class_types: set[str] = set()
    prompt_inputs: list[dict] = []
    image_inputs: list[dict] = []
    video_inputs: list[dict] = []
    audio_inputs: list[dict] = []
    numeric: list[dict] = []

    for nid, node in graph.items():
        class_type = node["class_type"]  # sniff 已保 class_type 存在
        class_types.add(class_type)
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if class_type == "CLIPTextEncode":
            text = inputs.get("text")
            if isinstance(text, str):  # 连线占用的 text 不是表单入口
                prompt_inputs.append({
                    "node": nid, "field": "inputs.text",
                    "preview": text[:80], "role": "positive" if len(prompt_inputs) == 0 else "extra",
                })
        elif class_type == "LoadImage":
            image_inputs.append({"node": nid, "field": "inputs.image", "value": inputs.get("image")})
        elif class_type == "LoadVideo":
            video_inputs.append({"node": nid, "field": "inputs.file", "value": inputs.get("file")})
        elif class_type == "LoadAudio":
            audio_inputs.append({"node": nid, "field": "inputs.audio", "value": inputs.get("audio")})
        for name, value in inputs.items():
            if name in _NUMERIC_FIELD_NAMES and isinstance(value, (int, float)) \
                    and not isinstance(value, bool):
                numeric.append({
                    "node": nid, "field": f"inputs.{name}", "class_type": class_type,
                    "value": value, "kind": "int" if isinstance(value, int) else "float",
                })

    return WorkflowAnalysis(
        format=fmt,
        graph=graph,
        class_types=sorted(class_types),
        prompt_inputs=prompt_inputs,
        image_inputs=image_inputs,
        video_inputs=video_inputs,
        audio_inputs=audio_inputs,
        numeric_candidates=numeric,
        output_kind=_guess_output_kind(class_types),
    )
