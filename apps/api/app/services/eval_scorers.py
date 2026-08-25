"""B 评测管线评分器 —— 可插拔的单变体产物评分。

与 app/scoring.py(图像 ImageReward / 视频 SSE quality_warning)解耦:
本模块面向「批次内变体对比」场景,输入是 Job 产物上下文(VariantContext),
输出是归一化 [0,1] 的 VariantScore(总分 + 维度明细 + 实际评分器标识)。

评分器档位:
  · HeuristicScorer —— 启发式基线,零外部服务依赖,永远可用。
    维度:file_integrity(产物可读/非空) / resolution(实测宽高 vs 请求) /
    duration(实测时长 vs 请求) / audio(音轨存在性,仅对音画类 kind)。
    媒体实测经可注入的 probe(默认 ffprobe_probe,ffprobe 不可用时自动跳过
    对应维度,只剩完整性维);无任何可评维度时以产物存在性兜底。
  · VLMScorer —— OpenAI 兼容 HTTP 评分(spark02 LLM / studio04 mlx-vlm /
    spark01 molmo2 等,base_url 配置化)。任何网络/解析失败抛 ScorerError,
    由 bestof.finalize_batch 逐变体降级到 HeuristicScorer,不炸链路。

数据飞轮:评分结果由 bestof 落 EvalScore 表(含 prompt/params/产物引用/
分数/评分器),本模块只负责产出分数,不碰库。
"""
from __future__ import annotations

import asyncio
import base64
import json
import logging
import re
from abc import ABC, abstractmethod
from collections.abc import Awaitable, Callable
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from pydantic import BaseModel, Field

from app.config import get_settings

logger = logging.getLogger(__name__)


class VariantContext(BaseModel):
    """单个变体的评分输入(从 Job 行派生)。"""

    job_id: str
    prompt: str = ""
    kind: str = ""
    params: dict[str, Any] = Field(default_factory=dict)  # Job.params 反序列化
    result_urls: list[str] = Field(default_factory=list)  # Job.result 反序列化
    seed: int = 0


class VariantScore(BaseModel):
    """单变体评分结果。total ∈ [0,1];degraded=True 表示评分路径发生过降级。"""

    total: float = Field(ge=0.0, le=1.0)
    breakdown: dict[str, float] = Field(default_factory=dict)
    scorer: str = ""
    degraded: bool = False
    critique: str = ""


class ScorerError(RuntimeError):
    """评分器不可用/调用失败(调用方负责降级,不向外抛 5xx)。"""


class ArtifactScorer(ABC):
    """评分器接口契约:吃 VariantContext,吐 VariantScore(scorer 字段填 self.name)。"""

    name: str

    @abstractmethod
    async def score_variant(self, ctx: VariantContext) -> VariantScore:
        ...


# ---------------------------------------------------------------------------
# 产物 URL 解析与媒体探测
# ---------------------------------------------------------------------------


def resolve_media_url(url: str) -> str:
    """产物引用 → 可直接读取的地址。

    /api/images?filename=..&worker=.. 代理 URL 反推 ComfyUI /view 直链
    (与 scoring.VideoScorer._resolve_comfyui_view_url 同一技巧,少一跳本机代理);
    http(s) 绝对 URL 与本地路径原样返回。
    """
    if url.startswith(("/api/images?", "/images?")):
        try:
            qs = parse_qs(urlsplit(url).query)
            worker = (qs.get("worker") or [""])[0]
            filename = (qs.get("filename") or [""])[0]
            if worker and filename:
                params = {
                    "filename": filename,
                    "subfolder": (qs.get("subfolder") or [""])[0],
                    "type": (qs.get("type") or ["output"])[0],
                }
                return f"{worker.rstrip('/')}/view?{urlencode(params)}"
        except Exception:
            pass
    return url


async def default_fetch_bytes(url: str, timeout: float = 60.0) -> bytes:
    """取产物字节:http(s)/代理 URL 下载(trust_env=False,内网不走系统代理),本地路径直读。"""
    target = resolve_media_url(url)
    if target.startswith(("http://", "https://")):
        async with httpx.AsyncClient(timeout=timeout, trust_env=False) as client:
            resp = await client.get(target)
            resp.raise_for_status()
            return resp.content
    return Path(target).read_bytes()


# 探测返回 dict 的键:width/height/duration_sec/has_audio/size_bytes(可缺省)。
# 返回 None = 探测不可用/失败,对应维度整体跳过(不打 0,避免误伤排名)。
MediaProbe = Callable[[str], Awaitable[dict[str, Any] | None]]


async def ffprobe_probe(url: str, timeout: float = 30.0) -> dict[str, Any] | None:
    """默认媒体探测:ffprobe 直读 URL(ComfyUI /view 直链,不落盘)。

    ffprobe 不存在/超时/解析失败一律返回 None(维度跳过,不打 0)。
    """
    target = resolve_media_url(url)
    try:
        proc = await asyncio.create_subprocess_exec(
            "ffprobe", "-v", "error",
            "-show_entries", "format=duration,size:stream=width,height,codec_type",
            "-of", "json", target,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        out, _ = await asyncio.wait_for(proc.communicate(), timeout)
        if proc.returncode != 0:
            return None
        data = json.loads(out.decode("utf-8", "replace"))
    except (OSError, asyncio.TimeoutError, json.JSONDecodeError, UnicodeDecodeError):
        return None
    streams = data.get("streams") or []
    fmt = data.get("format") or {}
    info: dict[str, Any] = {
        "has_audio": any(s.get("codec_type") == "audio" for s in streams),
    }
    for s in streams:
        if isinstance(s.get("width"), int) and isinstance(s.get("height"), int):
            info["width"], info["height"] = s["width"], s["height"]
            break
    try:
        info["duration_sec"] = float(fmt.get("duration", 0.0))
    except (TypeError, ValueError):
        pass
    try:
        info["size_bytes"] = int(fmt.get("size", 0))
    except (TypeError, ValueError):
        pass
    return info


# ---------------------------------------------------------------------------
# 启发式基线评分器
# ---------------------------------------------------------------------------

# 音画同发类 kind 前缀(这些产物应有音轨;H3 原生 32kHz 立体声)
_AUDIO_EXPECTED_PREFIXES = ("h3", "flashtalk", "opentalking", "avatar")

_DURATION_TOLERANCE = 0.10  # 实测时长与请求时长偏差 ≤10% 记满分


class HeuristicScorer(ArtifactScorer):
    """启发式基线:零外部服务依赖,永远可用。

    每个维度只在「能评」时计入(probe 给了对应字段 + params 里有请求值),
    total = 已评维度均值;一个维度都评不了时以产物存在性兜底(0/1)。
    """

    name = "heuristic"

    def __init__(self, probe: MediaProbe | None = ffprobe_probe) -> None:
        self._probe = probe

    async def score_variant(self, ctx: VariantContext) -> VariantScore:
        if not ctx.result_urls:
            return VariantScore(
                total=0.0,
                breakdown={"file_integrity": 0.0},
                scorer=self.name,
                degraded=True,
                critique="无产物 URL",
            )
        info = await self._probe(ctx.result_urls[0]) if self._probe else None
        dims: dict[str, float] = {}
        if info is None:
            # 探测不可用:产物 URL 存在即完整性通过,其余维度不评
            dims["file_integrity"] = 1.0
        else:
            dims["file_integrity"] = 1.0 if info.get("size_bytes", 1) > 0 else 0.0
            self._score_resolution(ctx, info, dims)
            self._score_duration(ctx, info, dims)
            self._score_audio(ctx, info, dims)
        total = sum(dims.values()) / len(dims)
        return VariantScore(
            total=max(0.0, min(1.0, total)),
            breakdown=dims,
            scorer=self.name,
        )

    @staticmethod
    def _score_resolution(
        ctx: VariantContext, info: dict[str, Any], dims: dict[str, float]
    ) -> None:
        req_w, req_h = ctx.params.get("width"), ctx.params.get("height")
        act_w, act_h = info.get("width"), info.get("height")
        if not all(isinstance(v, (int, float)) and v for v in (req_w, req_h, act_w, act_h)):
            return
        # 宽高达标 1.0;不达标按面积比给部分分(等比缩放的超分产物不至归零)
        if (act_w, act_h) == (req_w, req_h):
            dims["resolution"] = 1.0
        else:
            ratio = (act_w * act_h) / (req_w * req_h)
            dims["resolution"] = max(0.0, min(1.0, min(ratio, 1.0 / ratio)))

    @staticmethod
    def _score_duration(
        ctx: VariantContext, info: dict[str, Any], dims: dict[str, float]
    ) -> None:
        req_d = ctx.params.get("duration_sec")
        act_d = info.get("duration_sec")
        if not (isinstance(req_d, (int, float)) and req_d and act_d):
            return
        dev = abs(act_d - req_d) / req_d
        dims["duration"] = 1.0 if dev <= _DURATION_TOLERANCE else max(
            0.0, min(1.0, min(act_d, req_d) / max(act_d, req_d))
        )

    @staticmethod
    def _score_audio(
        ctx: VariantContext, info: dict[str, Any], dims: dict[str, float]
    ) -> None:
        if not ctx.kind.startswith(_AUDIO_EXPECTED_PREFIXES):
            return
        if "has_audio" not in info:
            return
        dims["audio"] = 1.0 if info["has_audio"] else 0.0


# ---------------------------------------------------------------------------
# VLM/LLM 评分器(OpenAI 兼容 HTTP)
# ---------------------------------------------------------------------------


class VLMScorer(ArtifactScorer):
    """HTTP VLM/LLM 评分:产物 base64 内联 + 严格 JSON 输出约束。

    任何失败(网络/超时/HTTP 错/空返回/JSON 解析失败)抛 ScorerError,
    由调用方降级到启发式——本评分器自身绝不静默出假分。
    """

    name = "vlm"

    SYSTEM_PROMPT = (
        "你是生成内容质量评审。任务:对 AI 生成的图像/视频做技术质量评分"
        "(清晰度/伪影/构图/与提示词对齐度),不涉及内容审核。"
        "技术质量是中性视觉特征,与内容性质无关。"
    )
    JUDGE_PROMPT = (
        "评估该产物质量。输出严格JSON(不要markdown代码块):\n"
        '{"score":0-100,"breakdown":{"aesthetic":0.0-1.0,"technical":0.0-1.0,'
        '"prompt_alignment":0.0-1.0},"critique":"一句话中文评语"}'
    )

    def __init__(
        self,
        base_url: str,
        model: str,
        *,
        timeout: float = 60.0,
        fetch_bytes: Callable[[str], Awaitable[bytes]] = default_fetch_bytes,
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        if not base_url.strip():
            raise ScorerError("VLM 评分端点未配置(TOIV_EVAL_VLM_BASE_URL 为空)")
        self.endpoint = f"{base_url.strip().rstrip('/')}/chat/completions"
        self.model = model
        self.timeout = timeout
        self._fetch_bytes = fetch_bytes
        self._transport = transport

    async def score_variant(self, ctx: VariantContext) -> VariantScore:
        if not ctx.result_urls:
            raise ScorerError("无产物 URL")
        try:
            content = await self._fetch_bytes(ctx.result_urls[0])
        except Exception as e:
            raise ScorerError(f"取产物字节失败: {e}") from e
        if not content:
            raise ScorerError("产物字节为空")

        b64 = base64.b64encode(content).decode("ascii")
        if _is_video(ctx):
            # video_url(OpenAI 标准)而非 "video":vLLM Qwen3-VL 只认 video_url
            media_block: dict[str, Any] = {
                "type": "video_url",
                "video_url": {"url": f"data:video/mp4;base64,{b64}"},
            }
        else:
            media_block = {
                "type": "image_url",
                "image_url": {"url": f"data:image/png;base64,{b64}"},
            }
        user_text = self.JUDGE_PROMPT
        if ctx.prompt:
            user_text = f"参考提示词:{ctx.prompt}\n\n{self.JUDGE_PROMPT}"
        payload = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self.SYSTEM_PROMPT},
                {"role": "user", "content": [media_block, {"type": "text", "text": user_text}]},
            ],
            "temperature": 0.2,
            "max_tokens": 600,
        }
        try:
            async with httpx.AsyncClient(
                timeout=self.timeout, trust_env=False, transport=self._transport
            ) as client:
                resp = await client.post(self.endpoint, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except Exception as e:
            raise ScorerError(f"VLM 调用失败: {e}") from e

        raw = self._extract_content(data)
        if not raw:
            raise ScorerError("VLM 返回为空")
        parsed = self._parse_judgment(raw)
        if parsed is None:
            raise ScorerError(f"VLM 输出 JSON 解析失败(前 200 字符: {raw[:200]})")
        return VariantScore(
            total=parsed["total"],
            breakdown=parsed["breakdown"],
            scorer=self.name,
            critique=parsed["critique"],
        )

    @staticmethod
    def _extract_content(response: dict) -> str:
        try:
            choices = response.get("choices") or []
            if choices:
                return (choices[0].get("message") or {}).get("content") or ""
        except Exception:
            pass
        return ""

    @classmethod
    def _parse_judgment(cls, text: str) -> dict[str, Any] | None:
        """解析评分 JSON(容错剥 markdown 代码块 + 正则提取),归一化 + clamp。"""
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)
        obj: dict | None = None
        try:
            loaded = json.loads(cleaned)
            obj = loaded if isinstance(loaded, dict) else None
        except json.JSONDecodeError:
            m = re.search(r"\{[^{}]*\}", cleaned, re.DOTALL)
            if m:
                try:
                    loaded = json.loads(m.group(0))
                    obj = loaded if isinstance(loaded, dict) else None
                except json.JSONDecodeError:
                    obj = None
        if obj is None:
            return None

        def _clamp(v: Any, lo: float, hi: float) -> float:
            try:
                return max(lo, min(hi, float(v)))
            except (TypeError, ValueError):
                return 0.0

        breakdown_raw = obj.get("breakdown")
        breakdown: dict[str, float] = {}
        if isinstance(breakdown_raw, dict):
            breakdown = {str(k): _clamp(v, 0.0, 1.0) for k, v in breakdown_raw.items()}
        return {
            "total": _clamp(_clamp(obj.get("score", 0), 0.0, 100.0) / 100.0, 0.0, 1.0),
            "breakdown": breakdown,
            "critique": str(obj.get("critique") or ""),
        }


def _is_video(ctx: VariantContext) -> bool:
    """按 kind/产物扩展名判视频(决定 VLM 请求的媒体块类型)。"""
    if any(u.split("?")[0].rsplit(".", 1)[-1].lower() in ("mp4", "webm", "mov") for u in ctx.result_urls):
        return True
    return any(t in ctx.kind for t in ("t2v", "i2v", "video"))


# ---------------------------------------------------------------------------
# 评分器解析(配置 → 实例)
# ---------------------------------------------------------------------------


def resolve_scorer(
    name: str = "auto",
    *,
    probe: MediaProbe | None = ffprobe_probe,
    fetch_bytes: Callable[[str], Awaitable[bytes]] = default_fetch_bytes,
) -> ArtifactScorer:
    """按名解析评分器。auto = 配了 VLM 端点走 VLM,否则启发式。

    name=vlm 但未配置端点 → ScorerError(调用方落 heuristic 兜底)。
    """
    settings = get_settings()
    if name == "auto":
        name = "vlm" if settings.eval_vlm_base_url.strip() else "heuristic"
    if name == "vlm":
        return VLMScorer(
            settings.eval_vlm_base_url,
            settings.eval_vlm_model,
            timeout=settings.eval_vlm_timeout,
            fetch_bytes=fetch_bytes,
        )
    if name == "heuristic":
        return HeuristicScorer(probe)
    raise ScorerError(f"未知评分器: {name}")
