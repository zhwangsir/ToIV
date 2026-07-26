"""LLM 层路由 —— 按内容类型/场景选择最佳 LLM 层。

四层模型流水线(见 AGENTS.md §集群依赖):
  L1 初稿: qwen3.6-uncensored (SGLang, :8000) —— 实时交互,响应快
  L2 主力润色: Kimi-K2.7-Code-4bit (EXO, :52415) —— 关键场景,120s timeout
  L3 终稿精修: GLM-5.2-fp8 (EXO, :52415) —— 异步批量,300s timeout
  L4 NSFW: euryale-70b (vLLM TP=2, :8080) —— 无审查,成人内容

路由原则:
  - 实时对话/快速草稿 → L1
  - 剧本/分镜/营销文案 → L2
  - 终稿润色/长文/高质量 → L3
  - NSFW 内容生成 → L4
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum


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


LLM_ENDPOINTS: dict[LLMLayer, LLMEndpoint] = {
    LLMLayer.L1_DRAFT: LLMEndpoint(
        layer=LLMLayer.L1_DRAFT,
        base_url="http://192.168.71.127:8000/v1",
        model_id="qwen3.6-uncensored",
        timeout=30.0,
        description="实时交互/快速初稿,qwen3.6-uncensored on SGLang",
        enable_thinking=False,
    ),
    LLMLayer.L2_MAIN: LLMEndpoint(
        layer=LLMLayer.L2_MAIN,
        base_url="http://192.168.71.109:52415/v1",
        model_id="mlx-community/Kimi-K2.7-Code-4bit",
        timeout=120.0,
        description="主力润色/剧本创作,Kimi-K2.7 on EXO集群",
        enable_thinking=False,
    ),
    LLMLayer.L3_POLISH: LLMEndpoint(
        layer=LLMLayer.L3_POLISH,
        base_url="http://192.168.71.109:52415/v1",
        model_id="mlx-community/GLM-5.2-fp8",
        timeout=300.0,
        description="终稿精修/长文/高质量输出,GLM-5.2 on EXO集群",
        enable_thinking=False,
    ),
    LLMLayer.L4_NSFW: LLMEndpoint(
        layer=LLMLayer.L4_NSFW,
        base_url="http://192.168.71.82:8000/v1",
        model_id="euryale-70b",
        timeout=120.0,
        description="无审查/NSFW内容,Euryale-70B on vLLM TP=2",
        enable_thinking=False,
    ),
}


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
    """按内容类型路由到最佳 LLM 端点。

    Args:
        content_type: 内容类型(ContentType 枚举或字符串)
        force_layer: 强制指定层(覆盖自动路由)
        is_nsfw: 是否 NSFW 内容(强制路由到 L4)
    """
    if is_nsfw:
        return LLM_ENDPOINTS[LLMLayer.L4_NSFW]
    if force_layer is not None:
        layer = LLMLayer(force_layer) if isinstance(force_layer, str) else force_layer
        return LLM_ENDPOINTS[layer]
    ct = ContentType(content_type) if isinstance(content_type, str) else content_type
    layer = _CONTENT_TYPE_ROUTING.get(ct, LLMLayer.L2_MAIN)
    return LLM_ENDPOINTS[layer]


def list_llm_endpoints() -> list[dict]:
    """返回所有 LLM 端点信息(供前端/管理页展示)。"""
    return [
        {
            "layer": ep.layer.value,
            "model_id": ep.model_id,
            "base_url": ep.base_url,
            "timeout": ep.timeout,
            "description": ep.description,
        }
        for ep in LLM_ENDPOINTS.values()
    ]


def list_content_types() -> list[dict]:
    """返回内容类型→层映射(供前端/管理页展示)。"""
    return [
        {
            "content_type": ct.value,
            "recommended_layer": layer.value,
            "model_id": LLM_ENDPOINTS[layer].model_id,
        }
        for ct, layer in _CONTENT_TYPE_ROUTING.items()
    ]
