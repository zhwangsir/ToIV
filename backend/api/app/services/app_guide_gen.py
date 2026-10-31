"""应用说明卡(AppGuide)LLM 生成(P1)。

照 services/app_packager 的范本:system prompt 契约 + 截断的图 + _extract_json
(容忍 ```json 围栏)+ Pydantic 校验 + LLMError 上抛(路由侧统一 503)。

输入组装:App 元信息(name/description/category/output_kind/author)
+ workflow_analyzer.analyze_workflow 的结构分析(优先喂分析结果,不塞整图)
+ required_nodes(空则从图提取,同 routes/apps 运行期做法)
+ params_schema 字段摘要;workflow_json 超 _GRAPH_PROMPT_LIMIT 截断。

产出 GuideDraft(purpose/when_to_use/steps/inputs/outputs/tips 均为字符串,
steps 为 list[str]);落库时 inputs/outputs/tips 按 AppGuide 的 JSON list 列
语义转为单元素列表(与 routes/app_guides._guide_out 的 list 输出契约对齐)。
"""
from __future__ import annotations

import json
import logging
from datetime import datetime, timezone
from typing import Any

from pydantic import BaseModel, Field, ValidationError
from sqlmodel import Session

from app.agent.llm import LLMError, chat
from app.models import App, AppGuide
from app.services.app_packager import _extract_json
from app.services.workflow_analyzer import analyze_workflow

logger = logging.getLogger(__name__)

# LLM 可见的图 JSON 体积上限:与 app_packager 同惯例,超大图截断(分析结果已足够)
_GRAPH_PROMPT_LIMIT = 20000

_SYSTEM_PROMPT = """你是 AI 应用商店的应用说明撰写专家。根据给定应用的信息,为普通用户撰写应用说明卡,输出**唯一一个 JSON 对象**,不要输出任何其他文字(不要用 ``` 围栏)。

输出 JSON 结构:
{
  "purpose": "一段话:这是什么、能干什么(≤80 字)",
  "when_to_use": "适用场景:什么时候该用这个应用(≤80 字)",
  "steps": ["使用步骤", "..."],
  "inputs": "需要用户提供什么输入(≤80 字)",
  "outputs": "产出什么、大概多久(≤60 字)",
  "tips": "使用提示/注意事项(≤80 字)"
}

铁律:
1. 面向普通用户,零术语:严禁出现 ComfyUI、节点、class_type、工作流、模型文件名等技术词汇。
2. steps 为 3-6 条字符串数组,每步 ≤40 字,按用户实际操作顺序写。
3. 不编造应用没有的能力:只能根据给定的名称/简介/分类/输入输出信息撰写,拿不准就写通用但诚实的说法。
4. 与给定的 description/category 保持一致,不矛盾。
5. inputs/outputs/tips 是字符串(一段话),不是数组。"""


class GuideDraft(BaseModel):
    """LLM 说明卡产出(结构校验;steps 强制 list[str])。"""

    purpose: str = Field(min_length=1, max_length=300)
    when_to_use: str = Field(default="", max_length=300)
    steps: list[str] = Field(min_length=1, max_length=10)
    inputs: str = Field(default="", max_length=300)
    outputs: str = Field(default="", max_length=300)
    tips: str = Field(default="", max_length=300)


def _required_nodes(app: App, graph: dict) -> list[str]:
    """required_nodes 空则从图提取(同 routes/apps 运行期做法)。"""
    if app.required_nodes:
        return list(app.required_nodes)
    return sorted({
        n["class_type"] for n in graph.values()
        if isinstance(n, dict) and n.get("class_type")
    })


def _params_summary(schema: Any) -> list[dict]:
    """params_schema 字段名/类型摘要(不含默认值等大 payload)。"""
    out: list[dict] = []
    for p in schema or []:
        if not isinstance(p, dict) or not p.get("key"):
            continue
        out.append({
            "key": p.get("key"),
            "label": p.get("label", ""),
            "type": p.get("type", "text"),
            "required": bool(p.get("required")),
        })
    return out


def build_messages(app: App) -> list[dict]:
    """组 LLM 消息:system(契约)+ user(应用元信息 + 结构分析 + 截断的图)。

    工作流无法分析(既非 UI 也非 API 格式)时抛 ValueError(路由侧 422)。
    """
    analysis = analyze_workflow(app.workflow_json or {})
    graph_json = json.dumps(analysis.graph, ensure_ascii=False)
    if len(graph_json) > _GRAPH_PROMPT_LIMIT:
        graph_json = graph_json[:_GRAPH_PROMPT_LIMIT] + "…(图过大已截断,请优先依据结构分析撰写)"
    info = {
        "name": app.name,
        "description": app.description or "",
        "category": app.category,
        "output_kind": app.output_kind,
        "author": app.author or "",
        "params": _params_summary(app.params_schema),
        "required_nodes": _required_nodes(app, analysis.graph),
    }
    user = (
        "应用信息:\n" + json.dumps(info, ensure_ascii=False)
        + "\n\n工作流结构分析:\n" + json.dumps(analysis.to_prompt_dict(), ensure_ascii=False)
        + "\n\n工作流图(参考,可能已截断):\n" + graph_json
        + "\n\n请输出说明卡 JSON。"
    )
    return [
        {"role": "system", "content": _SYSTEM_PROMPT},
        {"role": "user", "content": user},
    ]


async def generate_guide_draft(app: App) -> dict:
    """LLM 生成说明卡草稿:组消息 → chat → 提取 JSON → Pydantic 校验。

    Returns:
        GuideDraft.model_dump()(purpose/when_to_use/steps/inputs/outputs/tips)。

    Raises:
        LLMError: LLM 不可用/超时/产出非 JSON/结构校验失败(路由侧统一 503)。
        ValueError: 应用工作流格式无法分析(路由侧 422)。
    """
    messages = build_messages(app)
    try:
        msg = await chat(messages, max_tokens=1200, temperature=0.3,
                         enable_thinking=False)
    except LLMError:
        raise
    except Exception as e:  # 超时/连接等非 LLMError 形态统一收敛
        raise LLMError(f"说明卡生成 LLM 调用失败: {e!r}") from e
    data = _extract_json(str(msg.get("content") or ""))
    try:
        draft = GuideDraft.model_validate(data)
    except ValidationError as e:
        raise LLMError(f"说明卡产出结构不合法: {e.errors()[:3]}") from e
    return draft.model_dump()


def _as_text_list(v: Any) -> list[str]:
    """LLM 产出的字符串字段 → AppGuide JSON list 列(单元素列表);空串 → []。"""
    if isinstance(v, list):
        return [str(x) for x in v if str(x).strip()]
    s = str(v or "").strip()
    return [s] if s else []


def save_guide(session: Session, app_id: str, draft: dict,
               status: str = "draft") -> AppGuide:
    """upsert AppGuide:存在则更新字段+status+updated_at,不存在则插入。"""
    g = session.get(AppGuide, app_id)
    if not g:
        g = AppGuide(app_id=app_id)
    g.purpose = str(draft.get("purpose") or "")
    g.when_to_use = str(draft.get("when_to_use") or "")
    steps = draft.get("steps")
    g.steps = [str(s) for s in steps if str(s).strip()] if isinstance(steps, list) else []
    g.inputs = _as_text_list(draft.get("inputs"))
    g.outputs = _as_text_list(draft.get("outputs"))
    g.tips = _as_text_list(draft.get("tips"))
    g.status = status
    g.updated_at = datetime.now(timezone.utc)
    session.add(g)
    session.commit()
    session.refresh(g)
    return g
