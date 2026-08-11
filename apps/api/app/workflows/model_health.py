"""模型健康检查与性能评估机制。

功能:
  1. check_worker_models(): 查询 ComfyUI worker /object_info,核实模型文件是否存在
  2. check_llm_endpoints(): 检查 LLM 四层端点连通性
  3. ModelEvaluator: 定期评估模型在特定任务上的表现(基于best-of-n评分)
  4. 生成健康报告,检测缺失模型并给出替代建议
"""
from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass, field
from enum import Enum
from typing import Any

import httpx


class HealthStatus(str, Enum):
    HEALTHY = "healthy"
    DEGRADED = "degraded"
    UNHEALTHY = "unhealthy"
    UNKNOWN = "unknown"


@dataclass
class ModelHealth:
    name: str
    model_type: str
    status: HealthStatus
    exists: bool
    response_time_ms: float | None = None
    error: str | None = None
    last_checked: float = field(default_factory=time.time)


@dataclass
class LLMEndpointHealth:
    layer: str
    base_url: str
    model_id: str
    status: HealthStatus
    response_time_ms: float | None = None
    error: str | None = None
    last_checked: float = field(default_factory=time.time)


@dataclass
class HealthReport:
    timestamp: float
    overall_status: HealthStatus
    image_models: list[ModelHealth]
    video_models: list[ModelHealth]
    text_encoders: list[ModelHealth]
    vaes: list[ModelHealth]
    llm_endpoints: list[LLMEndpointHealth]
    missing_critical: list[str] = field(default_factory=list)
    suggestions: list[str] = field(default_factory=list)


# ─────────────────────────────────────────────────────────────────────────────
# Worker 模型文件检查
# ─────────────────────────────────────────────────────────────────────────────

_COMFY_OBJECT_INFO_TIMEOUT = 10.0


async def _fetch_object_info(
    base_url: str, node_name: str, client: httpx.AsyncClient
) -> list[str] | None:
    """从 ComfyUI /object_info/{node} 获取模型列表,失败返回 None。"""
    try:
        resp = await client.get(
            f"{base_url.rstrip('/')}/object_info/{node_name}",
            timeout=_COMFY_OBJECT_INFO_TIMEOUT,
        )
        resp.raise_for_status()
        data = resp.json()
        # 不同节点的输入字段不同
        node_data = data.get(node_name, {})
        required = node_data.get("input", {}).get("required", {})
        for key in ("ckpt_name", "unet_name", "clip_name", "vae_name"):
            if key in required:
                return required[key][0] if isinstance(required[key], list) else required[key][0]
        return []
    except Exception:
        return None


async def check_worker_models(base_url: str) -> dict[str, list[str]]:
    """检查单个 ComfyUI worker 上实际存在的模型文件。

    Returns:
        {"checkpoints": [...], "diffusion_models": [...], "text_encoders": [...], "vaes": [...]}
    """
    result = {
        "checkpoints": [],
        "diffusion_models": [],
        "text_encoders": [],
        "vaes": [],
    }
    async with httpx.AsyncClient() as client:
        tasks = [
            _fetch_object_info(base_url, "CheckpointLoaderSimple", client),
            _fetch_object_info(base_url, "UNETLoader", client),
            _fetch_object_info(base_url, "CLIPLoader", client),
            _fetch_object_info(base_url, "VAELoader", client),
        ]
        ckpts, unets, clips, vaes = await asyncio.gather(*tasks)
        if ckpts is not None:
            result["checkpoints"] = sorted(ckpts)
        if unets is not None:
            result["diffusion_models"] = sorted(unets)
        if clips is not None:
            result["text_encoders"] = sorted(clips)
        if vaes is not None:
            result["vaes"] = sorted(vaes)
    return result


async def check_all_workers_models(
    worker_urls: list[str] | None = None,
) -> dict[str, list[str]]:
    """查询所有 ComfyUI worker 并聚合模型文件列表(取并集)。

    模型分布式部署在多个 worker 上,单查 LB(8188) 无法看到全量模型。
    本函数并发查询所有 worker,将结果取并集。
    """
    from app.config import get_settings

    if worker_urls is None:
        worker_urls = get_settings().worker_urls

    merged: dict[str, set[str]] = {
        "checkpoints": set(),
        "diffusion_models": set(),
        "text_encoders": set(),
        "vaes": set(),
    }
    all_urls = list(dict.fromkeys(["http://192.168.71.127:8188"] + list(worker_urls)))

    async def _query_one(url: str) -> dict[str, list[str]]:
        try:
            return await check_worker_models(url)
        except Exception:
            return {"checkpoints": [], "diffusion_models": [], "text_encoders": [], "vaes": []}

    results = await asyncio.gather(*[_query_one(u) for u in all_urls], return_exceptions=False)
    for result in results:
        for key in merged:
            merged[key].update(result.get(key, []))

    return {k: sorted(v) for k, v in merged.items()}


async def check_llm_endpoint(
    layer: str, base_url: str, model_id: str, timeout: float = 10.0
) -> LLMEndpointHealth:
    """检查单个 LLM 端点连通性(GET /models)。"""
    start = time.monotonic()
    try:
        async with httpx.AsyncClient() as client:
            resp = await client.get(f"{base_url.rstrip('/')}/models", timeout=timeout)
            resp.raise_for_status()
            elapsed = (time.monotonic() - start) * 1000
            return LLMEndpointHealth(
                layer=layer,
                base_url=base_url,
                model_id=model_id,
                status=HealthStatus.HEALTHY,
                response_time_ms=round(elapsed, 1),
            )
    except Exception as e:
        elapsed = (time.monotonic() - start) * 1000
        return LLMEndpointHealth(
            layer=layer,
            base_url=base_url,
            model_id=model_id,
            status=HealthStatus.UNHEALTHY,
            response_time_ms=round(elapsed, 1),
            error=str(e)[:200],
        )


async def check_all_llm_endpoints() -> list[LLMEndpointHealth]:
    """检查所有四层 LLM 端点(端点从 settings 实时解析,见 llm_router)。"""
    from .llm_router import LLMLayer, llm_endpoints

    endpoints = llm_endpoints()
    tasks = []
    for layer in [LLMLayer.L1_DRAFT, LLMLayer.L2_MAIN, LLMLayer.L3_POLISH, LLMLayer.L4_NSFW]:
        ep = endpoints[layer]
        tasks.append(check_llm_endpoint(ep.layer.value, ep.base_url, ep.model_id))
    return await asyncio.gather(*tasks)


# ─────────────────────────────────────────────────────────────────────────────
# 健康报告生成
# ─────────────────────────────────────────────────────────────────────────────

# 关键模型清单(style_presets / nextgen_recipe 实际依赖)
_CRITICAL_IMAGE_MODELS = [
    "flux2_dev_fp8mixed.safetensors",
    "qwen_image_fp8_e4m3fn.safetensors",
    "z_image_turbo_bf16.safetensors",
    "majicMIX realistic 麦橘写实_v7.safetensors",
    "waiIllustriousSDXL_v170.safetensors",
    "noobaiXL_vpred10.safetensors",
    "ponyDiffusionV6XL_v6.safetensors",
    "flux-2-klein-4b.safetensors",
    "ltx-video-2b-v0.9.5.safetensors",
]

_CRITICAL_ENCODERS = [
    "mistral_3_small_flux2_fp8.safetensors",
    "qwen_2.5_vl_7b_fp8_scaled.safetensors",
    "qwen_3_4b.safetensors",
    "umt5_xxl_fp8_e4m3fn_scaled.safetensors",
]

_CRITICAL_VAES = [
    "flux2-vae.safetensors",
    "qwen_image_vae.safetensors",
    "ae.safetensors",
]


def _check_critical(
    existing: list[str], critical: list[str]
) -> tuple[list[ModelHealth], list[str]]:
    """检查关键模型是否存在,返回健康列表和缺失列表。"""
    health = []
    missing = []
    existing_lower = {n.lower(): n for n in existing}
    for name in critical:
        found = name.lower() in existing_lower
        if not found:
            missing.append(name)
            health.append(ModelHealth(
                name=name,
                model_type="critical",
                status=HealthStatus.UNHEALTHY,
                exists=False,
            ))
        else:
            health.append(ModelHealth(
                name=name,
                model_type="critical",
                status=HealthStatus.HEALTHY,
                exists=True,
            ))
    return health, missing


def _suggest_fallbacks(missing: list[str]) -> list[str]:
    """对缺失模型给出替代建议。"""
    suggestions = []
    fallback_map = {
        "flux2_dev_fp8mixed.safetensors": "替代方案: z_image_turbo_bf16(快速) 或 flux-2-klein-4b(轻量)",
        "qwen_image_fp8_e4m3fn.safetensors": "替代方案: flux2_dev_fp8mixed(文字渲染也很好) 或 z_image_turbo",
        "z_image_turbo_bf16.safetensors": "替代方案: flux2_dev_fp8mixed 或 flux-2-klein-4b",
        "majicMIX realistic 麦橘写实_v7.safetensors": "替代方案: cyberrealistic_v120",
        "waiIllustriousSDXL_v170.safetensors": "替代方案: hassakuXLIllustrious_v34 或 waiSHUFFLENOOB_vPred04",
        "noobaiXL_vpred10.safetensors": "替代方案: waiSHUFFLENOOB_vPred04(v-pred) 或 waiIllustriousSDXL",
        "flux-2-klein-4b.safetensors": "替代方案: flux2_dev_fp8mixed(高品质)",
        "ltx-video-2b-v0.9.5.safetensors": "视频模型缺失,需确认WAN/LTX视频模型放置路径(diffusion_models/)",
        "mistral_3_small_flux2_fp8.safetensors": "FLUX.2 dev 必需编码器,Comfy-Org/flux2-dev",
        "qwen_2.5_vl_7b_fp8_scaled.safetensors": "Qwen-Image 必需编码器,Comfy-Org/Qwen-Image_ComfyUI",
        "qwen_3_4b.safetensors": "Z-Image/FLUX.2 Klein 共享编码器,通用下载",
        "umt5_xxl_fp8_e4m3fn_scaled.safetensors": "WAN视频必需T5编码器",
        "flux2-vae.safetensors": "FLUX.2 专用VAE,Comfy-Org/flux2-dev",
        "qwen_image_vae.safetensors": "Qwen-Image 专用VAE,Comfy-Org/Qwen-Image_ComfyUI",
        "ae.safetensors": "Z-Image/FLUX.1 共用VAE,Comfy-Org/flux1-dev",
    }
    for m in missing:
        if m in fallback_map:
            suggestions.append(fallback_map[m])
    return suggestions


async def generate_health_report(
    comfy_url: str = "http://192.168.71.127:8188",
) -> HealthReport:
    """生成完整模型健康报告(聚合所有 worker 模型)。"""
    from .style_presets import ALL_PRESETS

    worker_models = await check_all_workers_models()
    llm_health = await check_all_llm_endpoints()

    all_image = worker_models["checkpoints"] + worker_models["diffusion_models"]
    img_health, missing_img = _check_critical(all_image, _CRITICAL_IMAGE_MODELS)
    enc_health, missing_enc = _check_critical(worker_models["text_encoders"], _CRITICAL_ENCODERS)
    vae_health, missing_vae = _check_critical(worker_models["vaes"], _CRITICAL_VAES)

    all_missing = missing_img + missing_enc + missing_vae
    suggestions = _suggest_fallbacks(all_missing)

    healthy_count = sum(
        1 for h in img_health + enc_health + vae_health + llm_health
        if h.status == HealthStatus.HEALTHY
    )
    unhealthy_count = sum(
        1 for h in img_health + enc_health + vae_health + llm_health
        if h.status == HealthStatus.UNHEALTHY
    )

    if unhealthy_count == 0:
        overall = HealthStatus.HEALTHY
    elif unhealthy_count <= 2:
        overall = HealthStatus.DEGRADED
    else:
        overall = HealthStatus.UNHEALTHY

    return HealthReport(
        timestamp=time.time(),
        overall_status=overall,
        image_models=img_health,
        video_models=[],
        text_encoders=enc_health,
        vaes=vae_health,
        llm_endpoints=llm_health,
        missing_critical=all_missing,
        suggestions=suggestions,
    )


# ─────────────────────────────────────────────────────────────────────────────
# 模型性能评估(基于 best-of-n 评分历史)
# ─────────────────────────────────────────────────────────────────────────────

@dataclass
class ModelScore:
    """单个模型在特定风格/任务上的评分记录。"""

    model_name: str
    style_id: str
    avg_score: float
    sample_count: int
    last_evaluated: float = field(default_factory=time.time)


class ModelEvaluator:
    """模型性能评估器。

    基于 best-of-n 作业的评分数据,统计各模型在不同风格上的平均表现,
    用于动态调整推荐预设。
    """

    def __init__(self) -> None:
        self._scores: dict[tuple[str, str], ModelScore] = {}

    def record_score(
        self, model_name: str, style_id: str, score: float
    ) -> None:
        key = (model_name, style_id)
        if key in self._scores:
            existing = self._scores[key]
            total = existing.avg_score * existing.sample_count + score
            new_count = existing.sample_count + 1
            self._scores[key] = ModelScore(
                model_name=model_name,
                style_id=style_id,
                avg_score=total / new_count,
                sample_count=new_count,
            )
        else:
            self._scores[key] = ModelScore(
                model_name=model_name,
                style_id=style_id,
                avg_score=score,
                sample_count=1,
            )

    def get_best_model(self, style_id: str) -> str | None:
        """获取某风格下评分最高的模型。"""
        candidates = [s for s in self._scores.values() if s.style_id == style_id and s.sample_count >= 3]
        if not candidates:
            return None
        return max(candidates, key=lambda s: s.avg_score).model_name

    def get_all_scores(self) -> list[dict]:
        """返回所有评分记录(可序列化)。"""
        return [
            {
                "model_name": s.model_name,
                "style_id": s.style_id,
                "avg_score": round(s.avg_score, 3),
                "sample_count": s.sample_count,
                "last_evaluated": s.last_evaluated,
            }
            for s in sorted(
                self._scores.values(),
                key=lambda x: (x.style_id, -x.avg_score),
            )
        ]


evaluator = ModelEvaluator()
