"""c_hybrid 出片文字门禁（2026-10-05 雨夜 shot0 误报修复）。

只拦字幕式横排中文（底部带/居中/够宽/≥2 连续采样帧）；胸口徽标 blob 与店招 OCR 仅记录；
首帧锚定段第 0..ANCHORED_FIRST_FRAME_SKIP_FRAMES 帧不检。
夹具：tests/fixtures/chybrid_text_gate/（真实误报帧取自 rain shot0 候选 1/2 与首帧定妆图）。
"""
from __future__ import annotations

from pathlib import Path

import pytest

cv2 = pytest.importorskip("cv2")
pytest.importorskip("pytesseract")
np = pytest.importorskip("numpy")

from app.services.studio import candidate_pick as cp  # noqa: E402

FIX = Path(__file__).parent / "fixtures" / "chybrid_text_gate"


def _tesseract_chi_sim_or_skip():
    import pytesseract

    try:
        langs = set(pytesseract.get_languages(config=""))
    except Exception as e:  # pragma: no cover
        pytest.skip(f"tesseract 不可用: {e}")
    if "chi_sim" not in langs:
        pytest.skip("tesseract 缺 chi_sim")


def _img(name: str):
    im = cv2.imread(str(FIX / name))
    assert im is not None, name
    return im


def _video(tmp_path: Path, frames: list, name: str = "v.avi") -> Path:
    h, w = frames[0].shape[:2]
    out = tmp_path / name
    vw = cv2.VideoWriter(str(out), cv2.VideoWriter_fourcc(*"MJPG"), 24.0, (w, h))
    if not vw.isOpened():
        pytest.skip("cv2 VideoWriter(MJPG) 不可用")
    for f in frames:
        vw.write(f)
    vw.release()
    return out


def test_anchor_skip_constant_is_12():
    assert cp.ANCHORED_FIRST_FRAME_SKIP_FRAMES == 12


def test_subtitle_frame_detects_bottom_centered_cjk_line():
    _tesseract_chi_sim_or_skip()
    r = cp.subtitle_ocr_frame(_img("synthetic_subtitle.jpg"))
    assert r["hit"] is True, r
    ln = max(r["hit_lines"], key=lambda x: x["cjk"])
    x, y, w, _h = ln["box"]
    assert ln["cjk"] >= cp.SUBTITLE_MIN_CJK
    assert y >= int(1344 * cp.SUBTITLE_BAND_Y0)
    assert w >= cp.SUBTITLE_MIN_WIDTH_RATIO * 768


def test_real_subtitle_sequence_hits(tmp_path):
    _tesseract_chi_sim_or_skip()
    sub = _img("synthetic_subtitle.jpg")
    v = _video(tmp_path, [sub] * 32)
    r = cp.garment_brand_ocr_hit(v)
    assert r["hit"] is True, r
    assert r["kind"] == "subtitle"
    assert r["text"].startswith("subtitle:")
    assert len(r["subtitle_run"]) >= cp.SUBTITLE_MIN_CONSECUTIVE


def test_single_sampled_subtitle_frame_is_not_enough(tmp_path):
    """只在 1 个采样帧出现（闪字）不拦：要求 ≥2 个连续采样帧。"""
    _tesseract_chi_sim_or_skip()
    clean = _img("first_frame_linxia_full.jpg")
    sub = _img("synthetic_subtitle.jpg")
    frames = [clean] * 32
    frames[10] = sub  # n=32 → 采样步长 2：仅采样帧 10 有字
    r = cp.garment_brand_ocr_hit(_video(tmp_path, frames))
    assert r["hit"] is False, r
    assert [f["frame"] for f in r["subtitle_frames"]] == [10]


@pytest.mark.parametrize(
    "name",
    ["first_frame_linxia_full.jpg", "cand1_f180_emblem_fp.jpg", "cand2_f0_emblem_fp.jpg"],
)
def test_rain_shot0_emblem_false_positive_frames_do_not_hit(tmp_path, name):
    _tesseract_chi_sim_or_skip()
    im = _img(name)
    fr = cp.garment_brand_ocr_frame(im)
    assert fr["hit"] is False, fr
    assert fr.get("emblem_log_only") is True
    r = cp.garment_brand_ocr_hit(_video(tmp_path, [im] * 16))
    assert r["hit"] is False, r
    assert r["kind"] == ""


def test_emblem_blob_is_log_only(tmp_path):
    """首帧定妆图 / 候选1 f180 仍被 emblem 检测器判中——但只进 emblem_log，不拦。"""
    for name in ("first_frame_linxia_full.jpg", "cand1_f180_emblem_fp.jpg"):
        im = _img(name)
        assert cp.garment_chest_emblem_hit(im)["hit"] is True, name
        r = cp.garment_brand_ocr_hit(_video(tmp_path, [im] * 16, name + ".avi"))
        assert r["hit"] is False, r
        assert r["emblem_log"], r


@pytest.mark.parametrize("name", ["cand2_f48_shop_sign.jpg", "synthetic_cjk_shop_sign.jpg"])
def test_shop_sign_frames_do_not_hit(tmp_path, name):
    _tesseract_chi_sim_or_skip()
    im = _img(name)
    assert cp.subtitle_ocr_frame(im)["hit"] is False
    r = cp.garment_brand_ocr_hit(_video(tmp_path, [im] * 16))
    assert r["hit"] is False, r


def test_scene_sign_hit_is_log_only(tmp_path, monkeypatch):
    """店招 OCR 命中只进 sign_log。"""
    im = _img("cand2_f48_shop_sign.jpg")
    monkeypatch.setattr(
        cp, "scene_sign_ocr_frame", lambda frame: {"hit": True, "text": "SEVEN ELEVEN", "error": ""}
    )
    r = cp.garment_brand_ocr_hit(_video(tmp_path, [im] * 16))
    assert r["hit"] is False, r
    assert r["sign_log"] and r["sign_log"][0]["text"] == "SEVEN ELEVEN"


def test_empty_frames_do_not_hit(tmp_path):
    black = np.zeros((1344, 768, 3), dtype=np.uint8)
    assert cp.subtitle_ocr_frame(black)["hit"] is False
    r = cp.garment_brand_ocr_hit(_video(tmp_path, [black] * 16))
    assert r["hit"] is False, r


def test_anchored_frames_skipped(tmp_path):
    """第 0..12 帧（首帧锚定段）带字幕：skip 时不检不拦；不 skip 时拦。"""
    _tesseract_chi_sim_or_skip()
    clean = _img("first_frame_linxia_full.jpg")
    sub = _img("synthetic_subtitle.jpg")
    skip = cp.ANCHORED_FIRST_FRAME_SKIP_FRAMES
    frames = [sub] * (skip + 1) + [clean] * 27  # n=40
    v = _video(tmp_path, frames)
    r_skip = cp.garment_brand_ocr_hit(v, skip_until_frame=skip)
    assert r_skip["hit"] is False, r_skip
    assert r_skip["subtitle_frames"] == []
    r_all = cp.garment_brand_ocr_hit(v)
    assert r_all["hit"] is True and r_all["kind"] == "subtitle", r_all
    assert all(f["frame"] <= skip for f in r_all["subtitle_run"])
