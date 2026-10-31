"""设定卡门禁失败的用户感知层（本地学习优先）：人话原因 + 拒图落盘 URL + 警告软保留。

不放宽门禁判定本身；只把失败结果对用户可见、可读、可重试、可选保留。
"""
from __future__ import annotations

import json
import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# code → 短中文标题（抽屉主文案）
_REASON_TITLES: dict[str, str] = {
    "slate_color": "服装颜色未过门禁（常见：板岩灰偏差/过浅过深）",
    "emblem": "胸口检出徽标/贴标（设定卡要求素面）",
    "hair": "发型/发长与锁定不一致",
    "compose": "构图未过门禁（脸位/铺满/裁切）",
    "face": "人脸/头肩未过门禁",
    "seam": "接缝/硬边未过门禁",
    "pose": "姿态（正侧背）未过门禁",
    "qa": "表情问答质检未过",
    "clip": "图文一致性（CLIP）未过",
    "expr_weak": "表情变化不足或张嘴不合规",
    "iris": "瞳色漂移未过门禁",
    "accessory": "饰品门禁未过",
    "timeout": "出图等待超时（作业可能仍在跑）",
    "backend": "出图后端不可用",
    "other": "设定卡质检未通过",
}


def classify_gate_code(message: str) -> str:
    msg = message or ""
    low = msg.lower()
    if "超时" in msg or "timeout" in low:
        return "timeout"
    if "后端不可用" in msg or "fleet" in low or "worker 不在" in msg:
        return "backend"
    if "徽标" in msg or "贴标" in msg or "字样" in msg or "emblem" in low:
        return "emblem"
    if "板岩" in msg or "颜色门禁" in msg or "服装主色" in msg or "slate" in low:
        return "slate_color"
    if "发长" in msg or "齐下巴" in msg or ("发顶" in msg) or ("发饰" in msg and "金" in msg):
        if "发饰" in msg or "木簪" in msg or "金色" in msg:
            return "accessory"
        return "hair"
    if "饰品" in msg or "木簪" in msg or "金色占比" in msg:
        return "accessory"
    if "接缝" in msg or "硬边" in msg or "seam" in low:
        return "seam"
    if "姿态门禁" in msg or "yaw" in low or ("side" in low and "正脸" in msg) or "back 仍可见" in msg:
        return "pose"
    if "瞳色" in msg or "色相" in msg:
        return "iris"
    if "专项问答" in msg or ("qa" in low and "未过" in msg):
        return "qa"
    if "clip" in low:
        return "clip"
    if "张嘴" in msg or "表情差过弱" in msg or "过于相似" in msg:
        return "expr_weak"
    if "构图门禁" in msg or "未全铺满" in msg or "stamp" in low or "letterbox" in low or "近白边" in msg:
        return "compose"
    if "人脸" in msg or "头肩" in msg or "测不到脸" in msg or "face" in low or "近景" in msg:
        return "face"
    return "other"


def humanize_gate_failure(message: str) -> dict[str, str]:
    """技术错误 → {code, title, detail}；detail 保留原文便于折叠查看。"""
    detail = (message or "").strip() or "未知门禁失败"
    code = classify_gate_code(detail)
    title = _REASON_TITLES.get(code, _REASON_TITLES["other"])
    # 对 other：尽量截一句可读前缀
    if code == "other" and detail:
        title = detail.split(":", 1)[0][:40] if ":" in detail else detail[:40]
    return {"code": code, "title": title, "detail": detail}


def _signed_studio_url(path_or_url: str) -> str:
    """确保 /api/studio/files/{name} 带 sig，便于 <img> 无 Authorization 头也能取。"""
    from app.services.studio_file_access import studio_file_sig

    u = (path_or_url or "").strip()
    if not u:
        return u
    if u.startswith("/api/studio/files/"):
        name = u.split("/api/studio/files/", 1)[-1].split("?", 1)[0]
    else:
        name = Path(u).name
    if not name or "/" in name or name.startswith("."):
        return u
    return f"/api/studio/files/{name}?sig={studio_file_sig(name)}"


def _panel_bytes_from_ctx() -> tuple[str | None, bytes | None]:
    from app.services.studio.character_sheet.constants import _SHEET_REJECT_CTX

    ctx = _SHEET_REJECT_CTX.get()
    if not ctx or not isinstance(ctx, dict):
        return None, None
    panels = ctx.get("panels") or {}
    panel = ctx.get("current_key") or "unknown"
    data = panels.get(panel) if isinstance(panels, dict) else None
    if data is None and isinstance(panels, dict) and panels:
        panel, data = list(panels.items())[-1]
    if isinstance(data, (bytes, bytearray)) and data:
        return str(panel), bytes(data)
    return str(panel) if panel else None, None


def _save_rejected_preview(
    data: bytes,
    *,
    character_id: str,
    style: str,
    panel: str,
) -> str:
    """落盘为 char_panel_*_rejected_*，返回带 sig 的 URL。"""
    from app.services.studio.character_sheet.layout import save_panel_png

    key = f"rejected_{re.sub(r'[^a-zA-Z0-9_]+', '_', panel or 'panel')[:32]}"
    url = save_panel_png(data, character_id=character_id, style=style, key=key)
    return _signed_studio_url(url)


def build_sheet_gate_failure_payload(
    message_or_exc: Any,
    *,
    character_id: str,
    style: str,
    status_code: int | None = None,
) -> dict[str, Any]:
    """组装 Job.error / HTTP detail 用的结构化失败载荷。"""
    rejected_bytes: bytes | None = None
    rejected_panel: str | None = None
    if isinstance(message_or_exc, Exception):
        msg = str(message_or_exc)
        status_code = status_code or int(getattr(message_or_exc, "status_code", 422) or 422)
        rejected_bytes = getattr(message_or_exc, "rejected_bytes", None)
        rejected_panel = getattr(message_or_exc, "rejected_panel", None)
    else:
        msg = str(message_or_exc or "")
        status_code = status_code or 422

    if not rejected_bytes:
        p, b = _panel_bytes_from_ctx()
        if b:
            rejected_bytes, rejected_panel = b, p or rejected_panel

    human = humanize_gate_failure(msg)
    preview_url: str | None = None
    if rejected_bytes:
        try:
            preview_url = _save_rejected_preview(
                rejected_bytes,
                character_id=character_id or "unknown00",
                style=style or "anime",
                panel=rejected_panel or "panel",
            )
        except Exception as e:  # noqa: BLE001 — UX 兜底，不因落盘失败丢掉原因
            logger.warning("save rejected preview failed: %s", e)

    gate_item = {
        "code": human["code"],
        "title": human["title"],
        "detail": human["detail"],
        "panel": rejected_panel,
        "preview_url": preview_url,
    }
    return {
        "error": human["title"],
        "reason_code": human["code"],
        "reason_zh": human["title"],
        "technical_detail": human["detail"],
        "rejected_preview_url": preview_url,
        "rejected_panel": rejected_panel,
        "gate_failures": [gate_item],
        "soft_keep_available": bool(preview_url),
        "status_code": status_code,
        "style": style,
    }


def keep_rejected_as_warning_sheet(
    *,
    character_id: str,
    style: str,
    preview_url: str,
    reason_zh: str = "",
    technical_detail: str = "",
) -> dict[str, Any]:
    """本地学习软模式：把门禁拒图晋升为带警告的设定卡文件（不宣称质检已过）。"""
    from app.services.studio.character_sheet.layout import save_sheet_png
    from app.storage import drama_output_root

    name = preview_url.split("/api/studio/files/", 1)[-1].split("?", 1)[0] if "/api/studio/files/" in preview_url else Path(preview_url).name
    if not name or "/" in name or name.startswith("."):
        raise ValueError("非法 preview_url")
    src = drama_output_root() / "studio" / name
    if not src.is_file():
        raise FileNotFoundError(f"拒图不存在: {name}")
    data = src.read_bytes()
    sheet_url = save_sheet_png(data, character_id=character_id, style=style)
    sheet_name = sheet_url.split("/api/studio/files/", 1)[-1].split("?", 1)[0]
    warn_path = drama_output_root() / "studio" / f"{Path(sheet_name).stem}.gate_warn.json"
    meta = {
        "warning": True,
        "reason_zh": reason_zh or "门禁未过，已按警告保留（本地学习）",
        "technical_detail": technical_detail or "",
        "source_preview": name,
        "soft_keep": True,
    }
    warn_path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return {
        "sheet_url": _signed_studio_url(sheet_url),
        "sheet_style": style,
        "warning": True,
        "reason_zh": meta["reason_zh"],
        "gate_warn_meta": meta,
    }


def load_gate_warn_meta(sheet_filename: str) -> dict[str, Any] | None:
    """list sheets 时读 sidecar。"""
    from app.storage import drama_output_root

    stem = Path(sheet_filename).stem
    p = drama_output_root() / "studio" / f"{stem}.gate_warn.json"
    if not p.is_file():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
        return data if isinstance(data, dict) else None
    except (ValueError, OSError):
        return None
