"""V4-3 镜头级 VLM 质检门禁(2026-10-12,story-claw/ViMax 范式)。

对入选候选视频抽帧,用 toiv-vlm 四问打分:
  ① 人物一致性(脸/发型与定妆参考是否同主体)
  ② 服装一致性(与参考服装是否一致)
  ③ 场景匹配(画面与分镜 scene 描述是否相符)
  ④ 幻觉检测(肢体畸变/多余手指/面部崩坏)

结果落 candidates_json 的 qa 字段:{scores:{...}, verdict, reason}。
verdict: pass | warn | fail(低于两项阈值即 fail)。

纪律:
- 纯增量:无 VLM/无参考图/调用失败一律 skip(不阻塞渲染主链);
- 只对入选候选跑(多候选选优已由裁脸门承担;此处验最终入选);
- 失败不自动删产物——由 V4-3b 重试策略消费(只补失败候选)。
"""
from __future__ import annotations

import base64
import json
import logging
import re
import shutil
import tempfile
from pathlib import Path
from typing import Any

import httpx

from app.config import get_settings

logger = logging.getLogger(__name__)

# 四问分项阈值(0-10 分制):总分低于 PASS_MIN 即 fail;单项低于 ITEM_MIN 记 warn
PASS_MIN = 6.0
ITEM_MIN = 4.0
FRAME_SAMPLES = 3  # 均匀抽 3 帧(开头/中间/结尾附近)
_TIMEOUT_S = 180.0

_QA_PROMPT = """你是短视频质检员。对照参考图(第一张)检查生成视频的抽帧(后续张),逐项打 0-10 分:
1. 人物一致性:脸型/五官/发型与参考是否同一人
2. 服装一致性:服装款式/颜色与参考是否一致
3. 场景匹配:画面是否符合分镜描述「{scene}」
4. 画面健康:无肢体畸变/多余手指/面部崩坏/文字乱码
只返回 JSON:{{"person": <0-10>, "outfit": <0-10>, "scene": <0-10>, "health": <0-10>}}"""


def vlm_available() -> bool:
    """toiv-vlm 是否配置(未配置一律 skip)。"""
    s = get_settings()
    return bool((s.vlm_server_url or "").strip()) and bool((s.vlm_model_id or "").strip())


def _extract_frames(video_path: Path, out_dir: Path) -> list[Path]:
    """ffmpeg 均匀抽 3 帧 jpg;失败返回空列表(调用方 skip)。"""
    if shutil.which("ffmpeg") is None:
        return []
    pat = out_dir / "qa_frame_%02d.jpg"
    # 先取时长再均匀取样点;探测失败退化为固定 1s/2s/3s
    dur = 4.0
    try:
        r = subprocess_run_probe(video_path)
        if r:
            dur = max(1.0, float(r))
    except Exception:  # noqa: BLE001
        pass
    points = [dur * f for f in (0.15, 0.5, 0.85)]
    ok: list[Path] = []
    for i, t in enumerate(points):
        p = out_dir / f"qa_frame_{i:02d}.jpg"
        cmd = [
            "ffmpeg", "-y", "-v", "error", "-ss", f"{t:.2f}", "-i", str(video_path),
            "-frames:v", "1", "-q:v", "3", str(p),
        ]
        import subprocess as _sp

        if _sp.run(cmd, capture_output=True, timeout=30).returncode == 0 and p.is_file():
            ok.append(p)
    _ = pat
    return ok


def subprocess_run_probe(video_path: Path) -> str | None:
    """ffprobe 时长(秒);失败 None。"""
    import subprocess as _sp

    if shutil.which("ffprobe") is None:
        return None
    r = _sp.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "default=noprint_wrappers=1:nokey=1", str(video_path)],
        capture_output=True, timeout=30,
    )
    if r.returncode != 0:
        return None
    return r.stdout.decode().strip() or None


def _b64_url(p: Path, mime: str = "image/jpeg") -> str:
    return f"data:{mime};base64,{base64.b64encode(p.read_bytes()).decode('ascii')}"


def _parse_scores(text: str) -> dict[str, float] | None:
    """从 VLM 回复提取四项分数(容错:抓 JSON 块/裸数字)。"""
    m = re.search(r"\{[^{}]*\"person\"[^{}]*\}", text, re.S)
    if not m:
        return None
    try:
        raw = json.loads(m.group(0))
        out = {}
        for k in ("person", "outfit", "scene", "health"):
            v = float(raw[k])
            if not 0 <= v <= 10:
                return None
            out[k] = round(v, 1)
        return out
    except (ValueError, TypeError, KeyError):
        return None


def qa_gate_video(
    video_path: Path,
    *,
    ref_image_path: Path | None,
    scene: str,
) -> dict[str, Any] | None:
    """VLM 四问打分(同步,调用方放线程池)。返回 qa 字段;不可用/失败返回 None。

    qa = {engine, scores:{person,outfit,scene,health}, total, verdict, reason}
    """
    if not vlm_available():
        return None
    with tempfile.TemporaryDirectory(prefix="toiv_qa_") as td:
        tdp = Path(td)
        frames = _extract_frames(video_path, tdp)
        if not frames:
            logger.info("qa_gate: 抽帧失败,跳过(video=%s)", video_path.name)
            return None
        content: list[dict] = []
        if ref_image_path and ref_image_path.is_file():
            content.append({"type": "image_url", "image_url": {"url": _b64_url(ref_image_path)}})
        for f in frames:
            content.append({"type": "image_url", "image_url": {"url": _b64_url(f)}})
        content.append({"type": "text", "text": _QA_PROMPT.format(scene=scene[:200])})
        settings = get_settings()
        payload = {
            "model": settings.vlm_model_id,
            "messages": [{"role": "user", "content": content}],
            "max_tokens": 200,
            "temperature": 0,
        }
        url = f"{settings.vlm_server_url.rstrip('/')}/v1/chat/completions"
        try:
            with httpx.Client(timeout=_TIMEOUT_S, trust_env=False) as client:
                resp = client.post(url, json=payload,
                                   headers={"Authorization": f"Bearer {settings.llm_api_key}"})
            resp.raise_for_status()
            text = resp.json()["choices"][0]["message"]["content"] or ""
        except Exception as e:  # noqa: BLE001 — 门禁失败不阻塞主链
            logger.warning("qa_gate VLM 调用失败(跳过): %s", e)
            return None
        scores = _parse_scores(text)
        if not scores:
            logger.info("qa_gate: 分数解析失败,跳过(raw=%.80s)", text)
            return None
    total = round(sum(scores.values()) / 4, 1)
    low = [k for k, v in scores.items() if v < ITEM_MIN]
    if total < PASS_MIN or len(low) >= 2:
        verdict, reason = "fail", f"总分 {total} 低于 {PASS_MIN}" + (f";低分项 {','.join(low)}" if low else "")
    elif low:
        verdict, reason = "warn", f"低分项 {','.join(low)}"
    else:
        verdict, reason = "pass", f"总分 {total}"
    return {
        "engine": settings.vlm_model_id,
        "scores": scores,
        "total": total,
        "verdict": verdict,
        "reason": reason,
    }


def apply_qa_to_candidates(
    candidates: list[dict[str, Any]],
    *,
    ref_image_path: Path | None,
    scene: str,
    local_url_resolver=None,
) -> dict[str, Any] | None:
    """对入选(done 且有 url)的候选跑四问门禁,把 qa 写回 candidates 条目。

    只对「入选候选」(调用方指定,通常是唯一 done 的单候选或选优胜者)打分——
    本函数按 candidates 里第一个 done 且 url 的条目执行;返回该 qa(未写条目时也返回供日志)。
    resolver: /api/studio/files/... → 本地 Path(同 orchestrator._resolve_vid 语义)。
    """
    target = next(
        (c for c in candidates if isinstance(c, dict) and c.get("status") == "done" and c.get("url")),
        None,
    )
    if not target:
        return None
    vp: Path | None = None
    resolver = local_url_resolver
    if resolver is not None:
        try:
            vp = resolver(str(target["url"]))
        except Exception:  # noqa: BLE001
            vp = None
    if vp is None or not Path(vp).is_file():
        logger.info("qa_gate: 候选视频未落地本地,跳过(url=%s)", str(target.get("url"))[:80])
        return None
    qa = qa_gate_video(Path(vp), ref_image_path=ref_image_path, scene=scene)
    if qa is not None:
        target["qa"] = qa
        logger.info("qa_gate: 候选 %s verdict=%s (%s)", target.get("id"), qa["verdict"], qa["reason"])
    return qa


# ── V4-3b 自动重生成(单候选路径;上限 2 次总尝试,只补失败候选) ──────────────

MAX_ATTEMPTS = 2  # 单镜 qa 驱动的总尝试上限(含首次)


def should_retry(qa: dict[str, Any] | None, attempt: int) -> bool:
    """qa=fail 且尝试未达上限 → 建议重生成一次(warn 不重试,不浪费卡时)。"""
    return bool(qa and qa.get("verdict") == "fail" and attempt < MAX_ATTEMPTS)
