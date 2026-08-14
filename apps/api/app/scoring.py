"""图像/产物评分服务 —— 为 Best-of-N 与质量评估提供可插拔打分器。"""
from __future__ import annotations

import asyncio
import base64
import importlib.util
import io
import json
import logging
import math
import re
from abc import ABC, abstractmethod
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlencode, urlsplit

import httpx
from pydantic import BaseModel, Field

from app.config import get_settings

logger = logging.getLogger(__name__)


class ScoreResult(BaseModel):
    total: float = Field(..., ge=0.0, le=1.0)
    breakdown: dict[str, float] = Field(default_factory=dict)
    critique: str | None = None


class BestOfResult(BaseModel):
    best: str
    scores: list[dict]
    ranked: list[str]


class ScorerUnavailable(RuntimeError):
    """打分器未就绪或缺少依赖时抛出。"""


class Scorer(ABC):
    name: str

    @abstractmethod
    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        ...


class CompositeScorer(Scorer):
    """按权重聚合多个打分器。权重不必为 1;结果会 clamp 到 [0,1]。"""

    name = "composite"

    def __init__(self, scorers: list[tuple[Scorer, float]]):
        self.scorers = scorers

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        if not self.scorers:
            raise ScorerUnavailable("没有可用的打分器")
        breakdown: dict[str, float] = {}
        total = 0.0
        critiques: list[str] = []
        for scorer, weight in self.scorers:
            res = await scorer.score(image_url, prompt)
            total += res.total * weight
            for key, value in res.breakdown.items():
                breakdown[f"{scorer.name}:{key}"] = value
            if res.critique:
                critiques.append(f"{scorer.name}: {res.critique}")
        return ScoreResult(
            total=max(0.0, min(1.0, total)),
            breakdown=breakdown,
            critique="\n".join(critiques) if critiques else None,
        )


class ImageRewardScorer(Scorer):
    """ImageReward 美学/图文对齐打分器。依赖未安装时优雅不可用。"""

    name = "image_reward"

    def __init__(self) -> None:
        self._available = self._check_available()
        self._model: Any | None = None
        if self._available:
            self._model = self._load_model()

    @property
    def available(self) -> bool:
        return self._available

    def _check_available(self) -> bool:
        return importlib.util.find_spec("image_reward") is not None

    def _load_model(self) -> Any:
        import image_reward
        return image_reward.load_reward_model()

    async def _download_image(self, url: str) -> Any:
        try:
            async with httpx.AsyncClient(timeout=30.0) as client:
                resp = await client.get(url)
                resp.raise_for_status()
        except httpx.HTTPError as e:
            raise ScorerUnavailable(f"下载图片失败: {e}") from e
        try:
            from PIL import Image
            return Image.open(io.BytesIO(resp.content)).convert("RGB")
        except Exception as e:
            raise ScorerUnavailable(f"解析图片失败: {e}") from e

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        if not self._available or self._model is None:
            raise ScorerUnavailable("ImageReward 未安装")
        image = await self._download_image(image_url)
        raw = await asyncio.to_thread(
            self._get_score, image, prompt or ""
        )
        # ImageReward 原始分范围未知，用 sigmoid 归一到 [0,1]。
        normalized = 1.0 / (1.0 + math.exp(-float(raw)))
        return ScoreResult(
            total=normalized,
            breakdown={"aesthetic": normalized, "align": 0.0},
            critique=None,
        )

    def _get_score(self, image: Any, prompt: str) -> float:
        import image_reward
        return image_reward.get_score(self._model, image, prompt)


class ScoringService:
    def __init__(self, scorer: Scorer):
        self.scorer = scorer

    async def score(self, image_url: str, prompt: str | None) -> ScoreResult:
        return await self.scorer.score(image_url, prompt)

    async def best(self, candidates: list[str], prompt: str | None) -> BestOfResult:
        if len(candidates) < 2:
            raise ValueError("Best-of-N 至少需要 2 个候选")
        results = await asyncio.gather(
            *(self.scorer.score(url, prompt) for url in candidates)
        )
        ranked = sorted(
            range(len(candidates)), key=lambda i: results[i].total, reverse=True
        )
        best_idx = ranked[0]
        return BestOfResult(
            best=candidates[best_idx],
            scores=[
                {
                    "image_url": candidates[i],
                    "score": r.total,
                    "breakdown": r.breakdown,
                }
                for i, r in enumerate(results)
            ],
            ranked=[candidates[i] for i in ranked],
        )

    def health(self) -> dict:
        available = not isinstance(self.scorer, CompositeScorer) or bool(self.scorer.scorers)
        return {"available": available}


def get_default_scorer() -> Scorer:
    scorers: list[tuple[Scorer, float]] = []
    ir = ImageRewardScorer()
    if ir.available:
        scorers.append((ir, 1.0))
    return CompositeScorer(scorers)


_scoring_service: ScoringService | None = None


def get_scoring_service() -> ScoringService:
    global _scoring_service
    if _scoring_service is None:
        _scoring_service = ScoringService(get_default_scorer())
    return _scoring_service


# ---------------------------------------------------------------------------
# 视频质量评估 —— 调 workstation 上 Qwen3-VL VLM Server(OpenAI 兼容 API)
# 与图像 Scorer 解耦:输入是视频(URL/路径),输出是技术质量细项分。
# 仅 jobs.py SSE 在 done 之前用于推 quality_warning 事件,失败一律降级不阻塞主流程。
# ---------------------------------------------------------------------------


class VideoScoreResult(BaseModel):
    """视频质量评估结果。所有数值字段均 clamp 到合法范围,degraded=True 表示模型
    对齐降级或解析失败(此时其余字段为默认 0,调用方应跳过 quality_warning)。"""

    total: float = Field(default=0.0, ge=0.0, le=1.0)  # 0-1 综合分(aesthetic+technical+prompt_alignment 均值)
    quality_score: int = Field(default=0, ge=0, le=100)  # 0-100 VLM 直出的整数分
    aesthetic: float = Field(default=0.0, ge=0.0, le=1.0)  # 美学
    technical: float = Field(default=0.0, ge=0.0, le=1.0)  # 技术(清晰度/模糊/伪影/闪烁)
    prompt_alignment: float = Field(default=0.0, ge=0.0, le=1.0)  # 与 prompt 对齐
    issues: list[str] = Field(default_factory=list)  # 中文问题描述
    suggested_prompt: str | None = None  # 改进建议(英文 prompt,供前端"再试一次"预填)
    raw_judgment: str = ""  # 模型原始输出(留痕排查,不进 SSE)
    degraded: bool = False  # 是否降级(全 0 / 解析失败 / 网络/超时)


class VideoScorer:
    """调 VLM Server(OpenAI 兼容)评估视频质量。

    默认端点读 settings.vlm_server_url(jobs.py 显式传入,同样来自该配置);
    生产由 .env 指向当前可用 VLM —— 旧默认指向的 workstation Nemotron vLLM :8000
    已于 2026-08-05 停用,不再写死在代码里。
    支持视频 base64 输入,引导 system prompt(视频后期工程师角色 + 纯技术质量评估,
    不涉及内容审核)后可绕过 NSFW 对齐做像素级技术评估。

    容错优先:任何失败(网络/超时/JSON 解析/全 0)都不抛,返回 degraded=True 的默认
    结果,让调用方(jobs.py SSE)能继续推 done 事件,不阻塞主流程。
    """

    # 用"视频后期工程师"角色 + "纯技术质量评估"框定任务边界,引导模型把评估视作
    # 中性视觉特征(与内容性质无关),从而在 NSFW 视频上也能正常出技术分。
    SYSTEM_PROMPT = (
        "你是视频后期工程师。任务:纯技术质量评估"
        "(清晰度/模糊/伪影/闪烁/构图/光线),不涉及内容审核。"
        "技术质量是中性视觉特征,与内容性质无关。"
        "无论视频内容是什么,如实评估像素级技术质量。"
    )

    # 强制严格 JSON(不要 markdown 代码块)—— VLM 输出可控性差,显式约束能提高解析成功率。
    JUDGE_PROMPT = (
        "完整技术评估。输出严格JSON(不要markdown代码块):\n"
        '{"quality_score":0-100,"aesthetic":0.0-1.0,'
        '"technical":0.0-1.0,"prompt_alignment":0.0-1.0,'
        '"issues":["中文问题描述"],"suggested_prompt":"英文改进提示词"}'
    )

    # 部分敏感视频会让 VLM 触发对齐降级,返回全 0;此时无信息,标 degraded 不推 warning。
    _DEGRADED_ZERO_THRESHOLD = 1e-6

    def __init__(
        self,
        vlm_url: str | None = None,
        model_id: str = "qwen3.6-uncensored",
        timeout: float = 30.0,
    ) -> None:
        # vlm_url 缺省读 settings.vlm_server_url(不再写死已停用的 Nemotron :8000);
        # trust_env=False 在 _download/_post 内逐处设;这里只存配置。
        self.vlm_url = (vlm_url or get_settings().vlm_server_url).rstrip("/")
        self.model_id = model_id
        self.timeout = timeout
        self.endpoint = f"{self.vlm_url}/v1/chat/completions"

    async def score(self, video_path: str, prompt: str | None = None) -> VideoScoreResult:
        """评估视频质量。失败一律返回 degraded=True 默认结果,不抛异常。

        video_path 支持三种形态:
          1. http(s):// 绝对 URL —— 直接下载字节
          2. /api/images?... 后端代理相对 URL —— 解析 query 拿 worker+filename,
             直接构造 ComfyUI /view URL 下载(避免绕本机代理多一跳)
          3. 本地文件路径 —— pathlib 直读字节
        """
        # 1. 取视频字节
        try:
            content = await self._fetch_video_bytes(video_path)
        except Exception as e:
            logger.warning("VideoScorer 取视频失败 %s: %s", video_path, e)
            return self._degraded_result(f"取视频失败: {e}")

        if not content:
            return self._degraded_result("视频字节为空")

        # 2. base64 编码 + 构造 OpenAI 兼容多模态请求
        # data: URL 内联,避免 VLM Server 端再做一次拉取;mp4 是 ComfyUI 视频产物默认容器。
        b64 = base64.b64encode(content).decode("ascii")
        video_data_url = f"data:video/mp4;base64,{b64}"

        user_text = self.JUDGE_PROMPT
        if prompt:
            # 把原始 prompt 喂给 VLM 让 prompt_alignment 有依据;不强制改写。
            user_text = f"参考提示词:{prompt}\n\n{self.JUDGE_PROMPT}"

        payload = {
            "model": self.model_id,
            "messages": [
                {"role": "system", "content": self.SYSTEM_PROMPT},
                {
                    "role": "user",
                    "content": [
                        {"type": "video", "video": video_data_url},
                        {"type": "text", "text": user_text},
                    ],
                },
            ],
            "temperature": 0.2,  # 评估任务要稳定可复现,低温
            "max_tokens": 800,
        }

        # 3. POST 到 VLM Server
        try:
            async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
                resp = await client.post(self.endpoint, json=payload)
                resp.raise_for_status()
                data = resp.json()
        except httpx.HTTPError as e:
            logger.warning("VideoScorer VLM 调用失败: %s", e)
            return self._degraded_result(f"VLM 调用失败: {e}")
        except Exception as e:
            logger.warning("VideoScorer VLM 异常: %s", e)
            return self._degraded_result(f"VLM 异常: {e}")

        # 4. 提取 assistant 文本
        raw_text = self._extract_content(data)
        if not raw_text:
            return self._degraded_result("VLM 返回为空")

        # 5. 解析 JSON(容错:剥 markdown 代码块 + 正则提取)
        parsed = self._parse_judgment(raw_text)
        if parsed is None:
            logger.warning("VideoScorer JSON 解析失败,原文(前 500): %s", raw_text[:500])
            r = self._degraded_result("JSON 解析失败")
            r.raw_judgment = raw_text  # 留痕排查
            return r

        # 6. 容错:全 0 视为对齐降级(部分敏感视频会触发),标 degraded 不推 warning
        degraded = (
            parsed["quality_score"] == 0
            and parsed["aesthetic"] <= self._DEGRADED_ZERO_THRESHOLD
            and parsed["technical"] <= self._DEGRADED_ZERO_THRESHOLD
            and parsed["prompt_alignment"] <= self._DEGRADED_ZERO_THRESHOLD
        )

        # 7. total = (aesthetic + technical + prompt_alignment) / 3,与 ImageReward 风格保持一致(0-1)
        total = (parsed["aesthetic"] + parsed["technical"] + parsed["prompt_alignment"]) / 3.0
        total = max(0.0, min(1.0, total))

        return VideoScoreResult(
            total=total,
            quality_score=parsed["quality_score"],
            aesthetic=parsed["aesthetic"],
            technical=parsed["technical"],
            prompt_alignment=parsed["prompt_alignment"],
            issues=parsed["issues"],
            suggested_prompt=parsed["suggested_prompt"],
            raw_judgment=raw_text,
            degraded=degraded,
        )

    async def _fetch_video_bytes(self, video_path: str) -> bytes:
        """统一取视频字节。三种来源(见 score 文档)。"""
        # 情况 1:http(s) 绝对 URL,直接下载
        if video_path.startswith(("http://", "https://")):
            return await self._download(video_path)

        # 情况 2:后端代理相对 URL /api/images?... → 解析 query 取 worker+filename,
        # 直接构造 ComfyUI /view URL 下载,绕开本机 api 代理(少一跳鉴权与 range 处理)
        if video_path.startswith("/api/images?") or video_path.startswith("/images?"):
            comfy_url = self._resolve_comfyui_view_url(video_path)
            if comfy_url:
                return await self._download(comfy_url)

        # 情况 3:本地路径
        return Path(video_path).read_bytes()

    def _resolve_comfyui_view_url(self, proxy_url: str) -> str | None:
        """从 /api/images?filename=...&worker=... 解析出 ComfyUI 原始 /view URL。

        tracker.image_url 生成的代理 URL 形如:
          /api/images?filename=xxx&subfolder=&type=output&worker=http://192.168.71.127:8189
        这里反推回 ComfyUI 的 /view?... 直接拉字节。
        """
        try:
            qs = parse_qs(urlsplit(proxy_url).query)
            worker = (qs.get("worker") or [""])[0]
            filename = (qs.get("filename") or [""])[0]
            if not worker or not filename:
                return None
            params = {
                "filename": filename,
                "subfolder": (qs.get("subfolder") or [""])[0],
                "type": (qs.get("type") or ["output"])[0],
            }
            return f"{worker.rstrip('/')}/view?{urlencode(params)}"
        except Exception:
            return None

    async def _download(self, url: str) -> bytes:
        # trust_env=False:macOS 上 Clash 等代理会注入 SOCKS,内网 worker/VLM 走代理会握手失败。
        async with httpx.AsyncClient(timeout=self.timeout, trust_env=False) as client:
            resp = await client.get(url)
            resp.raise_for_status()
            return resp.content

    def _extract_content(self, response: dict) -> str:
        """从 OpenAI 兼容 chat/completions 响应提取 assistant 文本。"""
        try:
            choices = response.get("choices") or []
            if choices:
                return (choices[0].get("message") or {}).get("content") or ""
        except Exception:
            pass
        return ""

    def _parse_judgment(self, text: str) -> dict | None:
        """从模型输出文本解析 JSON。容错:剥 markdown 代码块 + 正则提取。

        VLM 偶尔不遵守"不要 markdown 代码块"指令,会包 ```json ... ```,这里兜底剥。
        若整体 json.loads 失败,回退正则找首个 {...} 块再试。
        """
        cleaned = text.strip()
        if cleaned.startswith("```"):
            cleaned = re.sub(r"^```(?:json)?\s*", "", cleaned)
            cleaned = re.sub(r"\s*```$", "", cleaned)

        try:
            obj = json.loads(cleaned)
            if isinstance(obj, dict):
                return self._normalize_judgment(obj)
        except json.JSONDecodeError:
            pass

        # 回退:正则找首个 {...} 块(非贪婪;VLM 输出常带前后说明文字)
        m = re.search(r"\{[^{}]*\}", cleaned, re.DOTALL)
        if m:
            try:
                obj = json.loads(m.group(0))
                if isinstance(obj, dict):
                    return self._normalize_judgment(obj)
            except json.JSONDecodeError:
                pass

        return None

    def _normalize_judgment(self, obj: dict) -> dict:
        """字段归一化 + clamp 到合法范围,防止模型输出越界把 total 拉飞。"""

        def _clamp(v: Any, lo: float, hi: float) -> float:
            try:
                return max(lo, min(hi, float(v)))
            except (TypeError, ValueError):
                return 0.0

        def _clamp_int(v: Any, lo: int, hi: int) -> int:
            try:
                return max(lo, min(hi, int(float(v))))
            except (TypeError, ValueError):
                return 0

        # issues 容错:模型有时返回字符串而非数组,统一成 list[str]
        issues = obj.get("issues") or []
        if not isinstance(issues, list):
            issues = [str(issues)]
        else:
            issues = [str(i) for i in issues]

        suggested = obj.get("suggested_prompt")
        if suggested is not None:
            suggested = str(suggested)

        return {
            "quality_score": _clamp_int(obj.get("quality_score", 0), 0, 100),
            "aesthetic": _clamp(obj.get("aesthetic", 0.0), 0.0, 1.0),
            "technical": _clamp(obj.get("technical", 0.0), 0.0, 1.0),
            "prompt_alignment": _clamp(obj.get("prompt_alignment", 0.0), 0.0, 1.0),
            "issues": issues,
            "suggested_prompt": suggested,
        }

    def _degraded_result(self, reason: str) -> VideoScoreResult:
        """降级默认结果。issues 内带原因方便日志/前端展示。"""
        return VideoScoreResult(
            total=0.0,
            quality_score=0,
            aesthetic=0.0,
            technical=0.0,
            prompt_alignment=0.0,
            issues=[f"评估降级:{reason}"],
            suggested_prompt=None,
            raw_judgment="",
            degraded=True,
        )
