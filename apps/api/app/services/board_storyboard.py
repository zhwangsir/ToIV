"""分镜板 v2(M1,2026-09-21)——画板 shot_text/shot_meta 的纯函数层。

- compose_shot_text:ShotDraft(LLM 拆镜草稿)→ 人读分镜文本(写 BoardItem.shot_text)
- build_export_document:板+成员 → drama_studio 格式导出文档
  (字段名对齐 routes/drama_studio.py `_shot_dict` 序列化形态;media 取自挂载作品)
"""
from __future__ import annotations

import json
import re
from typing import Any

from app.models import Board, BoardItem, Job
from app.services.studio.schemas import ShotDraft

# 产物 URL 的扩展名常在 query(/api/videos?filename=v.mp4)而非路径,整串匹配
_VIDEO_RE = re.compile(r"\.(mp4|webm|mov|mkv|avi)([?&/#]|$)")
_IMAGE_RE = re.compile(r"\.(png|jpe?g|webp|gif|bmp)([?&/#]|$)")


def compose_shot_text(draft: ShotDraft) -> str:
    """LLM 拆镜草稿 → 人读分镜文本(scene + 台词 + 运镜;≤2000,全空回退 prompt)。"""
    parts: list[str] = []
    scene = draft.scene.strip()
    if scene:
        parts.append(scene)
    dialogue = draft.dialogue.strip()
    if dialogue:
        speaker = draft.speaker.strip() or "旁白"
        parts.append(f"台词({speaker}):{dialogue}")
    camera = draft.camera.strip()
    if camera:
        parts.append(f"运镜:{camera}")
    text = "\n".join(parts) or draft.prompt.strip()
    return text[:2000]


def _meta_of(item: BoardItem) -> dict[str, Any]:
    if not item.shot_meta:
        return {}
    try:
        obj = json.loads(item.shot_meta)
        return obj if isinstance(obj, dict) else {}
    except ValueError:
        return {}


def _duration_of(meta: dict[str, Any]) -> int:
    try:
        d = int(meta.get("duration_sec") or 6)
    except (ValueError, TypeError):
        d = 6
    return max(1, min(60, d))


def _job_results(job: Job | None) -> list[str]:
    if job is None or not job.result:
        return []
    try:
        rs = json.loads(job.result)
        return [str(u) for u in rs if str(u).strip()] if isinstance(rs, list) else []
    except ValueError:
        return []


def _split_media(urls: list[str]) -> tuple[str, str]:
    """产物 URL 列表 → (video_url, image_url),按扩展名/端点前缀分流,各取首个。"""
    video = image = ""
    for u in urls:
        low = u.lower()
        path = low.split("?")[0]
        is_video = bool(_VIDEO_RE.search(low)) or path.rstrip("/").endswith("/videos")
        is_image = bool(_IMAGE_RE.search(low)) or path.rstrip("/").endswith("/images")
        if is_video and not video:
            video = u
        elif is_image and not image:
            image = u
    return video, image


def build_export_document(
    board: Board, rows: list[tuple[BoardItem, Job | None]]
) -> dict[str, Any]:
    """整板导出 drama_studio 格式(rows 须已按 sort_order 排序)。

    seam_to_next:shot_meta 有草稿值优先;否则除末镜 hardcut、末镜空(drama_studio 铁律:
    拿不准一律 hardcut)。narration:有台词的行按全镜时长累计起止。
    """
    shots: list[dict[str, Any]] = []
    characters: list[str] = []
    narration: list[dict[str, Any]] = []
    cursor = 0.0
    total = len(rows)
    for i, (item, job) in enumerate(rows):
        meta = _meta_of(item)
        duration = _duration_of(meta)
        urls = _job_results(job)
        video_url, image_url = _split_media(urls)
        shot_chars = [str(c) for c in (meta.get("characters") or []) if str(c).strip()]
        for name in shot_chars:
            if name not in characters:
                characters.append(name)
        seam = str(meta.get("seam_to_next") or "").strip()
        if not seam:
            seam = "" if i == total - 1 else "hardcut"
        dialogue = str(meta.get("dialogue") or "").strip()
        speaker = str(meta.get("speaker") or "").strip()
        shots.append(
            {
                "idx": i + 1,
                "scene": item.shot_text or str(meta.get("scene") or ""),
                "prompt": str(meta.get("prompt") or "") or (job.prompt if job else ""),
                "negative": str(meta.get("negative") or ""),
                "characters": shot_chars,
                "dialogue": dialogue,
                "speaker": speaker,
                "duration_sec": duration,
                "mood": str(meta.get("mood") or ""),
                "beat": str(meta.get("beat") or ""),
                "seam_to_next": seam,
                "seam_anchor": str(meta.get("seam_anchor") or ""),
                "video_url": video_url,
                "image_url": image_url,
                "job_id": item.job_id,
                "seed": job.seed if job else None,
                "status": job.status if job else "pending",
            }
        )
        if dialogue:
            narration.append(
                {
                    "start": round(cursor, 3),
                    "end": round(cursor + duration, 3),
                    "speaker": speaker or "narrator",
                    "text": dialogue,
                }
            )
        cursor += duration
    return {
        "title": board.name,
        "description": board.description,
        "characters": [{"name": n} for n in characters],
        "shots": shots,
        "narration": narration,
        "duration_sec": round(cursor, 3),
    }
