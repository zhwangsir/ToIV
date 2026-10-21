"""F1 / P4：关键帧驱动默认（BigBanana / LMD）。

项目 preferred_drive_mode=keyframe（默认）时，视频镜开拍前须有 image_url。
direct / force_direct 旁路软闸。纯函数便于单测。
"""
from __future__ import annotations

from typing import Any

DEFAULT_DRIVE_MODE = "keyframe"
VALID_DRIVE_MODES = frozenset({"keyframe", "direct"})

KEYFRAME_REQUIRED_CODE = "KEYFRAME_REQUIRED"
KEYFRAME_REQUIRED_DETAIL = {
    "code": KEYFRAME_REQUIRED_CODE,
    "message": "关键帧驱动：请先生成并采用本镜关键帧，再开拍视频。",
    "qa_hint": "分镜表点「AI 配景」→ 采用一帧；或将驱动改为「直接出视频（专家）」。",
}


def normalize_drive_mode(raw: Any) -> str:
    v = str(raw or "").strip().lower()
    return v if v in VALID_DRIVE_MODES else DEFAULT_DRIVE_MODE


def shot_has_keyframe(shot: Any) -> bool:
    url = getattr(shot, "image_url", None)
    if url is None and isinstance(shot, dict):
        url = shot.get("image_url")
    return bool(str(url or "").strip())


def video_already_started(shot: Any) -> bool:
    status = str(getattr(shot, "status", None) or (shot.get("status") if isinstance(shot, dict) else "") or "").strip()
    video_url = getattr(shot, "video_url", None)
    if video_url is None and isinstance(shot, dict):
        video_url = shot.get("video_url")
    if str(video_url or "").strip():
        return True
    return status in {"rendered", "voiced", "lipsynced", "done", "rendering", "queued"}


def keyframe_gate_blocks(
    *,
    drive_mode: Any,
    shot: Any,
    force_direct: bool = False,
) -> dict[str, str] | None:
    """若应拦截开拍，返回 detail dict（含 code）；否则 None。"""
    if force_direct:
        return None
    if normalize_drive_mode(drive_mode) != "keyframe":
        return None
    render_mode = getattr(shot, "render_mode", None)
    if render_mode is None and isinstance(shot, dict):
        render_mode = shot.get("render_mode")
    if str(render_mode or "video") != "video":
        return None
    if video_already_started(shot) or shot_has_keyframe(shot):
        return None
    return dict(KEYFRAME_REQUIRED_DETAIL)


def is_studio_file_url(url: str) -> bool:
    u = (url or "").strip()
    if not u:
        return False
    # 站内工作室文件域或同源相对路径
    if u.startswith("/api/studio/files/"):
        return True
    if u.startswith("http://") or u.startswith("https://"):
        return "/api/studio/files/" in u
    return False
