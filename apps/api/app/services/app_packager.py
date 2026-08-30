"""应用市场 M5:LLM 智能包装器(智能导入的第二棒)。

输入 services/workflow_analyzer 的 WorkflowAnalysis(+ 归一化后的 API 图),
调 LLM(chat_layered L1)产出应用草稿,Pydantic 校验 + 本地消毒后返回:

- icon 白名单:apps/web/components/ui/Icon.tsx 的 ICON_MAP 键快照
  (2026-08-30 抄录,改前端图标表需同步);LLM 产出不在白名单 → 回落默认 + warning;
- category/output_kind 非法 → 按分析推断值回落 + warning(不因小错整单 503);
- params_schema:type 白名单(与 routes/apps._PARAM_TYPES 同源)/key 唯一/select 带 options,
  违规项剔除 + warning;
- bindings:悬空一律剔除 + warning —— 节点不在图内、field 路径非法、
  目标叶子不存在或是连线/复合结构、binding key 无对应 schema 参数;
- LLM 超时/不可用/产出非 JSON/Pydantic 结构校验失败 → 抛 LLMError,路由侧统一 503。
"""
from __future__ import annotations

import json
import logging
import re
from typing import Any

from pydantic import BaseModel, Field, ValidationError

from app.agent.llm import LLMError, chat_layered
from app.services.workflow_analyzer import WorkflowAnalysis

logger = logging.getLogger(__name__)

# ── icon 白名单:apps/web/components/ui/Icon.tsx ICON_MAP 键快照(2026-08-30)──
# 快照原因:api 不读 web 源码(部署分离);前端 ICON_MAP 变更时需人工同步本表。
ICON_WHITELIST: frozenset[str] = frozenset({
    "chat", "create", "canvas", "manju", "drama", "dub", "train", "library",
    "backlot", "models", "admin", "settings", "send", "upload", "download",
    "delete", "close", "menu", "search", "refresh", "success", "error",
    "loading", "playing", "queued", "image", "video", "audio", "model3d",
    "file", "link", "warning", "lock", "chevron-down", "chevron-left",
    "chevron-right", "chevron-up", "check", "sparkles", "camera", "palette",
    "film", "brush", "cpu", "minus", "package", "mic", "database", "user",
    "users", "eye", "grid", "filevideo", "history", "fileimage", "filecode",
    "sheet", "filejson", "filetype", "slides", "box", "drag", "barchart",
    "alert", "sun", "moon", "monitor", "workflow", "panel-right", "home",
    "plus", "clapperboard", "braincircuit", "zap", "info", "phone",
    "phone-off", "square", "play", "pause", "volume", "mute", "maximize",
    "minimize", "heart", "replay", "share", "thumbs-up", "thumbs-down",
    "crop", "scissors", "sliders", "type", "undo", "redo", "eraser", "wand",
    "layers", "rotate-cw", "flip", "contrast", "zoom-in", "zoom-out", "save",
    "skip-back", "skip-forward", "bot", "ban", "radio", "pencil", "hand",
    "clock", "x-circle", "list-ordered", "shield-check", "badge-check",
    "layout-grid", "store",
})
_DEFAULT_ICON = "sparkles"

# 与 routes/apps 同源(避免 routes→services 反向依赖):category/output_kind/参数类型
_CATEGORIES = {"image", "video", "audio", "edit", "3d", "other"}
_OUTPUT_KINDS = {"image", "video", "audio"}
_PARAM_TYPES = {
    "text", "textarea", "number", "select", "switch", "slider",
    "images", "audio", "video", "loras",
}
_BINDING_FIELD_RE = re.compile(r"^(inputs|widgets_values)\.[A-Za-z0-9_]+$")

# LLM 可见的图 JSON 体积上限:超大图截断(透镜/候选已足以定位绑定目标)
_GRAPH_PROMPT_LIMIT = 20000

_SYSTEM_PROMPT = """你是 ComfyUI 工作流包装师。把一个 ComfyUI 工作流(API 格式 prompt 图)包装成面向普通用户的表单应用,输出**唯一一个 JSON 对象**,不要输出任何其他文字。

输出 JSON 结构:
{
  "name": "应用名(≤20 字,人话,不出现节点类名)",
  "description": "一句话简介(≤60 字,说清用户填什么、得到什么)",
  "icon": "图标名(必须从给定白名单选)",
  "category": "image|video|audio|edit|3d|other 之一",
  "output_kind": "image|video|audio(产物类型)",
  "is_nsfw_guess": false,
  "params_schema": [ ... ],
  "bindings": { ... }
}

params_schema 每项范式(与平台引擎注册表同款):
- 文本:  {"key":"positive","label":"提示词","type":"textarea","required":true,"default":"","hint":"..."}
- 数字:  {"key":"steps","label":"采样步数","type":"number","default":20,"min":1,"max":50,"step":1}
- 种子:  {"key":"seed","label":"随机种子","type":"text","default":"","hint":"留空用模板默认;填整数可复现"}
- 下拉:  {"key":"sampler","label":"采样器","type":"select","default":"euler","options":[{"value":"euler","label":"euler"}]}
- 开关:  {"key":"hires","label":"高清修复","type":"switch","default":false}
- 媒体:  {"key":"images","label":"参考图","type":"images","max":1,"default":null}
type 仅允许:text/textarea/number/select/switch/slider/images/audio/video/loras。

bindings 把表单参数写到图叶子:{"表单key": {"node": "节点id", "field": "inputs.<输入名>"}}。
铁律:
1. bindings 的 node 必须是给定图里真实存在的节点 id,field 必须是该节点 inputs 里真实存在的标量字段(值是字符串/数字/布尔的叶子;值是 [节点,槽] 的连线字段禁止绑定)。
2. 每个 bindings 的 key 必须在 params_schema 里有同 key 的项,一一对应。
3. 优先把「输入透镜」(prompt_inputs/image_inputs 等)做成参数;numeric_candidates 里有语义的(steps/cfg/seed/width/height)做成 number/text 参数,默认值取候选里的 value。
4. 文本编码节点的正负向提示词按内容区分(positive/negative),不要漏掉正向。
5. is_nsfw_guess:模型文件名或提示词含明显成人信号(nsfw/10eros/porn/hentai 等)时 true。
6. 不要发明节点 id 或字段名;拿不准的参数宁可不做。"""


class PackagedApp(BaseModel):
    """LLM 包装产出(结构校验;语义消毒在 package_with_llm)。"""

    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    icon: str = Field(default=_DEFAULT_ICON, max_length=64)
    category: str = "other"
    output_kind: str = "image"
    params_schema: list[dict] = Field(default_factory=list)
    bindings: dict = Field(default_factory=dict)
    is_nsfw_guess: bool = False


def _extract_json(content: str) -> dict:
    """从 LLM 产出提取首个 JSON 对象(容忍 ```json 围栏与前后散文)。"""
    text = content.strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text)
        text = re.sub(r"\s*```$", "", text)
    start, end = text.find("{"), text.rfind("}")
    if start < 0 or end <= start:
        raise LLMError("LLM 包装产出不含 JSON 对象")
    try:
        data = json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        raise LLMError(f"LLM 包装产出 JSON 解析失败: {e}") from e
    if not isinstance(data, dict):
        raise LLMError("LLM 包装产出不是 JSON 对象")
    return data


def build_messages(analysis: WorkflowAnalysis) -> list[dict]:
    """组 LLM 消息:system(契约+范式)+ user(分析结果 + 图 + icon 白名单)。"""
    graph_json = json.dumps(analysis.graph, ensure_ascii=False)
    if len(graph_json) > _GRAPH_PROMPT_LIMIT:
        graph_json = graph_json[:_GRAPH_PROMPT_LIMIT] + "…(图过大已截断,绑定请优先用透镜/候选里的节点)"
    user = (
        "工作流结构分析:\n" + json.dumps(analysis.to_prompt_dict(), ensure_ascii=False)
        + "\n\nAPI 图(节点 id → class_type/inputs):\n" + graph_json
        + "\n\nicon 白名单:" + ", ".join(sorted(ICON_WHITELIST))
        + "\n\n请输出包装 JSON。"
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


def _sanitize_params_schema(schema: Any, warnings: list[str]) -> list[dict]:
    """params_schema 消毒:结构/type/key 唯一性/select options;违规项剔除进 warnings。"""
    if not isinstance(schema, list):
        warnings.append("params_schema 不是数组,已整体丢弃")
        return []
    out: list[dict] = []
    seen: set[str] = set()
    for p in schema:
        if not isinstance(p, dict) or not isinstance(p.get("key"), str) or not p["key"].strip():
            warnings.append(f"剔除无 key 的参数项: {str(p)[:60]}")
            continue
        key = p["key"]
        if key in seen:
            warnings.append(f"剔除重复 key 的参数: {key}")
            continue
        ptype = p.get("type", "text")
        if ptype not in _PARAM_TYPES:
            warnings.append(f"参数 {key} 类型不支持({ptype}),已剔除")
            continue
        if ptype == "select":
            opts = p.get("options")
            if not isinstance(opts, list) or not opts:
                warnings.append(f"select 参数 {key} 缺 options,已剔除")
                continue
        seen.add(key)
        out.append(p)
    return out


def _sanitize_bindings(bindings: Any, graph: dict, schema_keys: set[str],
                       warnings: list[str]) -> dict:
    """bindings 消毒:悬空(节点不存在/路径非法/叶子不存在/连线/无 schema 对应)剔除进 warnings。"""
    if not isinstance(bindings, dict):
        warnings.append("bindings 不是对象,已整体丢弃")
        return {}
    out: dict[str, dict] = {}
    for key, target in bindings.items():
        if key not in schema_keys:
            warnings.append(f"绑定 {key} 在 params_schema 中无对应参数,已剔除")
            continue
        if not isinstance(target, dict):
            warnings.append(f"绑定 {key} 结构非法,已剔除")
            continue
        node_id, field_path = target.get("node"), target.get("field")
        node = graph.get(node_id) if isinstance(node_id, str) else None
        if node is None:
            warnings.append(f"绑定 {key} 指向不存在的节点 {node_id},已剔除")
            continue
        if not isinstance(field_path, str) or not _BINDING_FIELD_RE.match(field_path):
            warnings.append(f"绑定 {key} 的 field 路径非法({field_path}),已剔除")
            continue
        root, leaf = field_path.split(".", 1)
        container = node.get(root)
        leaf_val: Any = None
        if root == "inputs":
            if not isinstance(container, dict) or leaf not in container:
                warnings.append(f"绑定 {key} 目标 {node_id}.inputs.{leaf} 不存在,已剔除")
                continue
            leaf_val = container[leaf]
        else:  # widgets_values:API 图一般没有,有则按序号校验
            if not isinstance(container, list) or not leaf.isdigit() \
                    or int(leaf) >= len(container):
                warnings.append(f"绑定 {key} 目标 {node_id}.widgets_values.{leaf} 越界,已剔除")
                continue
            leaf_val = container[int(leaf)]
        if isinstance(leaf_val, (dict, list)):
            warnings.append(f"绑定 {key} 目标 {node_id}.{field_path} 是连线/复合结构,已剔除")
            continue
        out[key] = {"node": node_id, "field": field_path}
    return out


async def package_with_llm(analysis: WorkflowAnalysis) -> tuple[PackagedApp, list[str]]:
    """LLM 包装主入口:调 L1 → 提取 JSON → Pydantic 校验 → 消毒。

    Returns:
        (PackagedApp, warnings)。

    Raises:
        LLMError: LLM 不可用/超时/产出无法校验(路由侧统一转 503)。
    """
    messages = build_messages(analysis)
    try:
        msg = await chat_layered(messages, layer="L1", temperature=0.2,
                                 max_tokens=4000, enable_thinking=False)
    except LLMError:
        raise
    except Exception as e:  # 超时/连接等非 LLMError 形态统一收敛
        raise LLMError(f"智能包装 LLM 调用失败: {e!r}") from e
    data = _extract_json(str(msg.get("content") or ""))
    try:
        packaged = PackagedApp.model_validate(data)
    except ValidationError as e:
        raise LLMError(f"LLM 包装产出结构不合法: {e.errors()[:3]}") from e

    warnings: list[str] = []
    if packaged.icon not in ICON_WHITELIST:
        warnings.append(f"图标 {packaged.icon} 不在白名单,已回落 {_DEFAULT_ICON}")
        packaged.icon = _DEFAULT_ICON
    if packaged.category not in _CATEGORIES:
        warnings.append(f"分类 {packaged.category} 非法,已回落 other")
        packaged.category = "other"
    if packaged.output_kind not in _OUTPUT_KINDS:
        warnings.append(f"产物类型 {packaged.output_kind} 非法,已按分析推断 {analysis.output_kind}")
        packaged.output_kind = analysis.output_kind
    packaged.params_schema = _sanitize_params_schema(packaged.params_schema, warnings)
    packaged.bindings = _sanitize_bindings(
        packaged.bindings, analysis.graph,
        {p["key"] for p in packaged.params_schema}, warnings,
    )
    return packaged, warnings
