"""LLM 层路由 —— 按内容类型/场景选择最佳 LLM 层。

端点单一事实源(2026-08-01 P2-3 统一):
  四层端点(base_url / model_id / timeout)全部从 app.config.settings 解析,
  与 app/agent/llm.py 的 chat()/chat_layered() 同一来源,不再硬编码。
  解析入口 = resolve_llm_endpoint();agent/llm.py 的 chat_layered 亦复用它。

四层模型流水线(见 AGENTS.md §集群依赖,模型 ID 以 settings 为准):
  L1 初稿: settings.llm_base_url / llm_model(实时交互,响应快)
  L2 主力润色: settings.llm_l2_*(关键场景;EXO 未就绪时 chat_layered 自动降级 L1)
  L3 终稿精修: settings.llm_l3_*(异步批量;降级链 L3→L2→L1)
  L4 NSFW: settings.llm_nsfw_*(空则回落主模型;无审查内容)

路由原则:
  - 实时对话/快速草稿 → L1
  - 剧本/分镜/营销文案 → L2
  - 终稿润色/长文/高质量 → L3
  - NSFW 内容生成 → L4
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum

from app.config import Settings, get_settings


class LLMLayer(str, Enum):
    L1_DRAFT = "L1"
    L2_MAIN = "L2"
    L3_POLISH = "L3"
    L4_NSFW = "L4"


@dataclass(frozen=True)
class LLMEndpoint:
    layer: LLMLayer
    base_url: str
    model_id: str
    timeout: float
    description: str
    enable_thinking: bool = False


def resolve_llm_endpoint(
    layer: LLMLayer | str,
    settings: Settings | None = None,
) -> LLMEndpoint:
    """层 → (base_url, model_id, timeout) 解析的**单一事实源**。

    全部取自 settings(环境变量 TOIV_LLM_* 可覆盖),改配置即生效;
    agent/llm.py 的 chat_layered 与本模块的 route_llm 都经此解析。
    """
    s = settings or get_settings()
    ly = LLMLayer(layer) if isinstance(layer, str) else layer

    if ly is LLMLayer.L2_MAIN:
        return LLMEndpoint(
            layer=ly,
            base_url=s.llm_l2_base_url.rstrip("/"),
            model_id=s.llm_l2_model,
            timeout=s.llm_l2_timeout,
            description="主力润色/剧本创作(settings.llm_l2_*)",
            enable_thinking=False,
        )
    if ly is LLMLayer.L3_POLISH:
        return LLMEndpoint(
            layer=ly,
            base_url=s.llm_l3_base_url.rstrip("/"),
            model_id=s.llm_l3_model,
            timeout=s.llm_l3_timeout,
            description="终稿精修/长文/高质量输出(settings.llm_l3_*)",
            enable_thinking=False,
        )
    if ly is LLMLayer.L4_NSFW:
        # NSFW 专用端点未配时回落主模型(与 agent/llm.py chat() 的 NSFW 路由一致)
        return LLMEndpoint(
            layer=ly,
            base_url=(s.llm_nsfw_base_url or s.llm_base_url).rstrip("/"),
            model_id=(s.llm_nsfw_model or s.llm_model).strip(),
            timeout=180.0,
            description="无审查/NSFW 内容(settings.llm_nsfw_*,空则回落主模型)",
            enable_thinking=False,
        )
    # L1 = 主模型
    return LLMEndpoint(
        layer=LLMLayer.L1_DRAFT,
        base_url=s.llm_base_url.rstrip("/"),
        model_id=s.llm_model,
        timeout=30.0,
        description="实时交互/快速初稿(settings.llm_base_url/llm_model)",
        enable_thinking=False,
    )


def llm_endpoints(settings: Settings | None = None) -> dict[LLMLayer, LLMEndpoint]:
    """四层端点快照;每次调用从 settings 重新解析(配置变更即时生效)。"""
    s = settings or get_settings()
    return {layer: resolve_llm_endpoint(layer, s) for layer in LLMLayer}


class ContentType(str, Enum):
    CHAT = "chat"
    DRAFT_SCRIPT = "draft_script"
    SCRIPT = "script"
    STORYBOARD = "storyboard"
    MARKETING_COPY = "marketing_copy"
    TECHNICAL_DOC = "technical_doc"
    CREATIVE_STORY = "creative_story"
    DIALOGUE = "dialogue"
    CAPTION = "caption"
    IMAGE_PROMPT = "image_prompt"
    VIDEO_PROMPT = "video_prompt"
    NSFW_SCRIPT = "nsfw_script"
    NSFW_IMAGE_PROMPT = "nsfw_image_prompt"
    POLISH = "polish"
    TRANSLATION = "translation"
    TTS_SCRIPT = "tts_script"


_CONTENT_TYPE_ROUTING: dict[ContentType, LLMLayer] = {
    ContentType.CHAT: LLMLayer.L1_DRAFT,
    ContentType.DRAFT_SCRIPT: LLMLayer.L1_DRAFT,
    ContentType.IMAGE_PROMPT: LLMLayer.L2_MAIN,
    ContentType.VIDEO_PROMPT: LLMLayer.L2_MAIN,
    ContentType.CAPTION: LLMLayer.L2_MAIN,
    ContentType.DIALOGUE: LLMLayer.L2_MAIN,
    ContentType.TTS_SCRIPT: LLMLayer.L2_MAIN,
    ContentType.MARKETING_COPY: LLMLayer.L2_MAIN,
    ContentType.STORYBOARD: LLMLayer.L2_MAIN,
    ContentType.TRANSLATION: LLMLayer.L2_MAIN,
    ContentType.SCRIPT: LLMLayer.L3_POLISH,
    ContentType.CREATIVE_STORY: LLMLayer.L3_POLISH,
    ContentType.TECHNICAL_DOC: LLMLayer.L3_POLISH,
    ContentType.POLISH: LLMLayer.L3_POLISH,
    ContentType.NSFW_SCRIPT: LLMLayer.L4_NSFW,
    ContentType.NSFW_IMAGE_PROMPT: LLMLayer.L4_NSFW,
}


def route_llm(
    content_type: ContentType | str,
    force_layer: LLMLayer | str | None = None,
    is_nsfw: bool = False,
) -> LLMEndpoint:
    """按内容类型路由到最佳 LLM 端点(端点取自 settings,见 resolve_llm_endpoint)。

    Args:
        content_type: 内容类型(ContentType 枚举或字符串)
        force_layer: 强制指定层(覆盖自动路由)
        is_nsfw: 是否 NSFW 内容(强制路由到 L4)
    """
    if is_nsfw:
        return resolve_llm_endpoint(LLMLayer.L4_NSFW)
    if force_layer is not None:
        return resolve_llm_endpoint(force_layer)
    ct = ContentType(content_type) if isinstance(content_type, str) else content_type
    layer = _CONTENT_TYPE_ROUTING.get(ct, LLMLayer.L2_MAIN)
    return resolve_llm_endpoint(layer)


def list_llm_endpoints() -> list[dict]:
    """返回所有 LLM 端点信息(供前端/管理页展示;实时反映 settings)。"""
    return [
        {
            "layer": ep.layer.value,
            "model_id": ep.model_id,
            "base_url": ep.base_url,
            "timeout": ep.timeout,
            "description": ep.description,
        }
        for ep in llm_endpoints().values()
    ]


def list_content_types() -> list[dict]:
    """返回内容类型→层映射(供前端/管理页展示)。"""
    endpoints = llm_endpoints()
    return [
        {
            "content_type": ct.value,
            "recommended_layer": layer.value,
            "model_id": endpoints[layer].model_id,
        }
        for ct, layer in _CONTENT_TYPE_ROUTING.items()
    ]
