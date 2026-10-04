"""19:55：表情 VLM 六类判官 + 温柔/果断提示 + 同尺度 0.55–0.65 含嘴。"""
from __future__ import annotations

from io import BytesIO
from unittest.mock import AsyncMock

import numpy as np
import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _png(img: Image.Image | np.ndarray) -> bytes:
    if isinstance(img, np.ndarray):
        img = Image.fromarray(img.astype(np.uint8), mode="RGB")
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _face_cell(*, face_top: float, face_bot: float, size: int = 256) -> bytes:
    out = Image.new("RGB", (size, size), (235, 235, 240))
    d = ImageDraw.Draw(out)
    y1, y2 = int(size * face_top), int(size * face_bot)
    x1, x2 = int(size * 0.28), int(size * 0.72)
    d.ellipse((x1, y1, x2, y2), fill=(220, 185, 165))
    mid = (y1 + y2) // 2
    # eyes
    d.ellipse((x1 + 18, mid - 18, x1 + 48, mid + 8), fill=(40, 60, 160))
    d.ellipse((x2 - 48, mid - 18, x2 - 18, mid + 8), fill=(40, 60, 160))
    # mouth lower face
    my = int(y1 + 0.72 * (y2 - y1))
    d.ellipse((size // 2 - 22, my - 6, size // 2 + 22, my + 8), fill=(150, 80, 80))
    # hair top
    d.rectangle((x1 - 8, max(0, y1 - 20), x2 + 8, y1 + 8), fill=(25, 28, 36))
    # shoulders
    d.rectangle((int(size * 0.18), y2, int(size * 0.82), size), fill=(90, 106, 122))
    return _png(out)


def test_parse_vlm_json_and_aliases():
    raw = '{"label":"温柔","scores":{"威严":0.05,"冷酷":0.05,"沉思":0.1,"温柔":0.7,"惊恐":0.05,"果断":0.05}}'
    parsed = sheet_svc._parse_vlm_expression_json(raw)
    assert parsed["label"] == "温柔"
    assert abs(sum(parsed["scores"].values()) - 1.0) < 1e-6
    assert parsed["scores"]["温柔"] == max(parsed["scores"].values())

    fenced = "```json\n" + raw + "\n```"
    assert sheet_svc._parse_vlm_expression_json(fenced)["label"] == "温柔"

    en = '{"label":"gentle","scores":{"gentle":0.8,"stern":0.2}}'
    p2 = sheet_svc._parse_vlm_expression_json(en)
    assert p2["label"] == "温柔"


def test_assert_vlm_match_pass_and_fail():
    cell = _face_cell(face_top=0.12, face_bot=0.72)
    ok = {
        "label": "威严",
        "scores": {
            "威严": 0.55,
            "冷酷": 0.1,
            "沉思": 0.1,
            "温柔": 0.1,
            "惊恐": 0.05,
            "果断": 0.1,
        },
        "raw": "{}",
        "model": "mock",
    }
    info = sheet_svc.assert_expression_vlm_match(cell, "expr_0", ok)
    assert info["want"] == "威严"

    wrong = dict(ok)
    wrong["label"] = "温柔"
    wrong["scores"] = {
        "威严": 0.1,
        "冷酷": 0.1,
        "沉思": 0.1,
        "温柔": 0.5,
        "惊恐": 0.1,
        "果断": 0.1,
    }
    with pytest.raises(sheet_svc.CharacterSheetError, match="VLM 判错|want=威严"):
        sheet_svc.assert_expression_vlm_match(cell, "expr_0", wrong)

    # label 对但 argmax 不对
    bad_argmax = {
        "label": "威严",
        "scores": {
            "威严": 0.2,
            "冷酷": 0.5,
            "沉思": 0.1,
            "温柔": 0.1,
            "惊恐": 0.05,
            "果断": 0.05,
        },
        "raw": "{}",
    }
    with pytest.raises(sheet_svc.CharacterSheetError, match="argmax"):
        sheet_svc.assert_expression_vlm_match(cell, "expr_0", bad_argmax)


@pytest.mark.asyncio
async def test_classify_expression_vlm_failure_raises(monkeypatch):
    """VLM 失败必须抛错，不许静默伪过检。"""

    class BoomClient:
        base_url = "http://100.68.100.90:8262"

        async def upload_image(self, *_a, **_k):
            return "x.png"

        async def queue_prompt(self, *_a, **_k):
            raise sheet_svc.CharacterSheetError("boom", status_code=502)

        async def get_history(self, *_a, **_k):
            return {}

    monkeypatch.setattr(
        "app.comfy.client.ComfyUIClient",
        lambda *a, **k: BoomClient(),
    )
    # bypass allowed-port via real url shape; _assert uses port
    with pytest.raises(sheet_svc.CharacterSheetError, match="VLM|失败|boom"):
        await sheet_svc.classify_expression_vlm(
            _face_cell(face_top=0.12, face_bot=0.72),
            worker_url="http://100.68.100.90:8262",
        )


@pytest.mark.asyncio
async def test_classify_expression_vlm_mock_pass(monkeypatch):
    class OkClient:
        base_url = "http://100.68.100.90:8262"

        async def upload_image(self, *_a, **_k):
            return "x.png"

        async def queue_prompt(self, *_a, **_k):
            return "pid1"

        async def get_history(self, prompt_id):
            return {
                prompt_id: {
                    "status": {"status_str": "success", "completed": True},
                    "outputs": {
                        "3": {
                            "text": [
                                '{"label":"温柔","scores":{"威严":0.05,"冷酷":0.05,"沉思":0.1,"温柔":0.7,"惊恐":0.05,"果断":0.05}}'
                            ]
                        }
                    },
                }
            }

    monkeypatch.setattr(
        "app.comfy.client.ComfyUIClient",
        lambda *a, **k: OkClient(),
    )
    out = await sheet_svc.classify_expression_vlm(
        _face_cell(face_top=0.12, face_bot=0.72),
        worker_url="http://100.68.100.90:8262",
    )
    assert out["label"] == "温柔"
    assert out["scores"]["温柔"] == max(out["scores"].values())
    assert "model" in out
    sheet_svc.assert_expression_vlm_match(
        _face_cell(face_top=0.12, face_bot=0.72), "expr_3", out
    )


def test_expr_same_scale_055_065_and_mouth_gate():
    # 直接用 squareize 压到 0.55–0.65；合成头肩经检测框可能偏大，裁剪后须落窗
    raw = _face_cell(face_top=0.10, face_bot=0.68, size=512)
    cropped = sheet_svc.squareize_face_center_crop(raw, size=256)
    info = sheet_svc.assert_face_closeup_framing(
        cropped,
        min_face_height_frac=0.55,
        max_face_height_frac=0.65,
        require_mouth_in_frame=True,
    )
    assert 0.55 <= info["face_height_frac"] <= 0.65
    assert info.get("mouth_in_frame") is True

    # 贴底超近裁：脸框下沿贴底 → 嘴门禁失败
    tight = _face_cell(face_top=0.02, face_bot=0.98, size=256)
    with pytest.raises(
        sheet_svc.CharacterSheetError,
        match="mouth|eyes-only|too high|too large|clipped|face height",
    ):
        sheet_svc.assert_face_closeup_framing(
            tight,
            min_face_height_frac=0.55,
            max_face_height_frac=0.65,
            require_mouth_in_frame=True,
        )


def test_squareize_defaults_to_expr_scale():
    import inspect

    sig = inspect.signature(sheet_svc.squareize_face_center_crop)
    assert float(sig.parameters["min_face_height_frac"].default) == 0.55
    assert float(sig.parameters["max_face_height_frac"].default) == 0.65


def test_gentle_determined_prompt_strings():
    assert "gentle closed-eye smile" in sheet_svc._EXPR_PROMPTS[3]
    assert "soft smile" in sheet_svc._EXPR_PROMPTS[3]
    assert "relaxed eyebrows" in sheet_svc._EXPR_PROMPTS[3] or "relaxed" in sheet_svc._EXPR_PROMPTS[3]
    assert "determined" in sheet_svc._EXPR_PROMPTS[5].lower()
    assert "firm closed mouth" in sheet_svc._EXPR_PROMPTS[5]
    assert "focused eyes" in sheet_svc._EXPR_PROMPTS[5]
    assert "eyebrows slightly lowered" in sheet_svc._EXPR_PROMPTS[5]

    assert "gentle closed-eye smile" in sheet_svc._EXPR_INPAINT_PROMPTS[3]
    assert "frown" in sheet_svc._EXPR_INPAINT_PROMPTS[3] or "pout" in sheet_svc._EXPR_INPAINT_PROMPTS[3]
    assert "firm closed mouth" in sheet_svc._EXPR_INPAINT_PROMPTS[5]
    assert "focused eyes" in sheet_svc._EXPR_INPAINT_PROMPTS[5]
    assert "surprised" in sheet_svc._EXPR_INPAINT_PROMPTS[5] or "open mouth" in sheet_svc._EXPR_INPAINT_PROMPTS[5]

    g = sheet_svc._EXPR_EDIT_INSTRUCTIONS[3]
    assert "闭眼微笑" in g or "gentle closed-eye smile" in g
    assert "pout" in g.lower() or "嘟嘴" in g
    d = sheet_svc._EXPR_EDIT_INSTRUCTIONS[5]
    assert "determined" in d.lower() or "firm closed mouth" in d
    assert "surprised" in d.lower() or "open mouth" in d.lower() or "张嘴" in d

    # 几何 lift 硬拒已撤回（注释/源中不应再对温柔 lift<0.02 硬拒）
    src = sheet_svc.__file__
    text = open(src, encoding="utf-8").read()
    assert "须嘴角微扬 lift=" not in text
    assert "classify_expression_vlm" in text
    assert "assert_expression_vlm_match" in text
