"""设定卡门禁失败 UX：拒图可见 + 人话原因 + 软保留（本地学习）。"""
from __future__ import annotations

import json
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image

from app.services.studio import character_sheet as cs
from app.services.studio.character_sheet import ux as sheet_ux


def _png(color=(90, 106, 122), size=(128, 128)) -> bytes:
    im = Image.new("RGB", size, color)
    buf = BytesIO()
    im.save(buf, format="PNG")
    return buf.getvalue()


@pytest.fixture
def studio_root(tmp_path, monkeypatch):
    out = tmp_path / "drama_out"
    (out / "studio").mkdir(parents=True)
    monkeypatch.setattr("app.storage.drama_output_root", lambda: out)
    return out


def test_humanize_slate_and_emblem_and_compose():
    slate = sheet_ux.humanize_gate_failure(
        "颜色门禁失败:portrait服装主色#AABBCC距#5A6A7A=120>85，须重出"
    )
    assert slate["code"] == "slate_color"
    assert "板岩" in slate["title"] or "颜色" in slate["title"]
    assert "AABBCC" in slate["detail"] or "距" in slate["detail"]

    emblem = sheet_ux.humanize_gate_failure("一致性门禁失败:主立绘胸口检出贴标/徽标")
    assert emblem["code"] == "emblem"
    assert "徽标" in emblem["title"]

    compose = sheet_ux.humanize_gate_failure("expr_0构图门禁: 测不到脸")
    assert compose["code"] in ("compose", "face")
    assert compose["title"]


def test_humanize_unknown_keeps_detail():
    h = sheet_ux.humanize_gate_failure("出图后端不可用:none")
    assert h["code"] == "backend"
    assert "后端" in h["title"]
    assert h["detail"] == "出图后端不可用:none"
    other = sheet_ux.humanize_gate_failure("某种从未见过的失败码 XYZ-999")
    assert other["code"] == "other"
    assert other["detail"] == "某种从未见过的失败码 XYZ-999"


def test_build_payload_includes_preview_url(studio_root):
    data = _png((200, 40, 40))
    token = cs._SHEET_REJECT_CTX.set(
        {
            "dir": studio_root / "rej",
            "seed": 42,
            "panels": {"portrait": data},
            "current_key": "portrait",
        }
    )
    try:
        payload = sheet_ux.build_sheet_gate_failure_payload(
            "颜色门禁失败:portrait服装主色过浅近白(#EEEEEE)，须板岩灰",
            character_id="abcdef12-xxxx-yyyy-zzzz-ffffffffffff",
            style="anime",
        )
    finally:
        cs._SHEET_REJECT_CTX.reset(token)

    assert payload["error"]
    assert payload["reason_code"] == "slate_color"
    assert payload["reason_zh"]
    assert payload["technical_detail"]
    assert payload["rejected_preview_url"]
    assert payload["rejected_preview_url"].startswith("/api/studio/files/")
    assert "sig=" in payload["rejected_preview_url"]
    assert payload["soft_keep_available"] is True
    assert payload["gate_failures"]
    assert payload["gate_failures"][0]["code"] == "slate_color"
    name = payload["rejected_preview_url"].split("/api/studio/files/", 1)[1].split("?", 1)[0]
    assert (studio_root / "studio" / name).is_file()


def test_build_payload_without_bytes_still_has_reason():
    payload = sheet_ux.build_sheet_gate_failure_payload(
        "一致性门禁失败:主立绘胸口检出贴标/徽标",
        character_id="cid00001-xxxx",
        style="anime",
    )
    assert payload["reason_code"] == "emblem"
    assert payload["rejected_preview_url"] is None
    assert payload["soft_keep_available"] is False


def test_keep_rejected_as_warning_sheet(studio_root):
    studio = studio_root / "studio"
    data = _png((40, 40, 200))
    preview_name = "char_panel_abcdef12_anime_rejected_portrait_aabbccddee.png"
    (studio / preview_name).write_bytes(data)
    preview_url = f"/api/studio/files/{preview_name}"

    out = sheet_ux.keep_rejected_as_warning_sheet(
        character_id="abcdef12-xxxx-yyyy-zzzz-ffffffffffff",
        style="anime",
        preview_url=preview_url,
        reason_zh="服装颜色未过门禁（可警告保留）",
        technical_detail="颜色门禁失败:…",
    )
    assert out["warning"] is True
    assert out["sheet_url"].startswith("/api/studio/files/char_sheet_")
    assert "sig=" in out["sheet_url"]
    sheet_name = out["sheet_url"].split("/api/studio/files/", 1)[1].split("?", 1)[0]
    assert (studio / sheet_name).is_file()
    warn_side = studio / f"{Path(sheet_name).stem}.gate_warn.json"
    assert warn_side.is_file()
    meta = json.loads(warn_side.read_text(encoding="utf-8"))
    assert meta["warning"] is True
    assert "门禁" in meta["reason_zh"]


def test_character_sheet_error_keeps_rejected_bytes(tmp_path):
    data = _png()
    token = cs._SHEET_REJECT_CTX.set(
        {"dir": tmp_path, "seed": 1, "panels": {"front": data}, "current_key": "front"}
    )
    try:
        err = cs.CharacterSheetError(
            "一致性门禁失败:主立绘胸口检出贴标/徽标", status_code=422
        )
    finally:
        cs._SHEET_REJECT_CTX.reset(token)
    assert getattr(err, "rejected_bytes", None) == data
    assert getattr(err, "rejected_panel", None) == "front"


def test_payload_from_character_sheet_error_uses_exc_bytes(studio_root):
    data = _png((10, 200, 10))
    err = cs.CharacterSheetError("expr_3发长相对主立绘过长（须齐下巴）", status_code=422)
    err.rejected_bytes = data
    err.rejected_panel = "expr_3"
    payload = sheet_ux.build_sheet_gate_failure_payload(
        err,
        character_id="abcdef12-xxxx-yyyy-zzzz-ffffffffffff",
        style="anime",
    )
    assert payload["reason_code"] == "hair"
    assert payload["rejected_preview_url"]
    assert payload["soft_keep_available"] is True
