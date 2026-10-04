"""04:30 父代理：头肩裁剪禁止灰垫 + 与锁定格同比例；VLM 判闭嘴+情绪；超时只计执行、排队不计失败。"""
from __future__ import annotations

import asyncio
from io import BytesIO
from pathlib import Path

import pytest
from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _resolve_0305_rejects() -> Path:
    cands = [
        Path.home() / "Desktop/ALLProject/toiv_report_sheet_anime_0305/out/rejects",
        Path("/home/merlin/toiv/tmp/toiv_report_sheet_anime_0305/out/rejects"),
        Path("/Users/wangzhenyu/Desktop/ALLProject/toiv_report_sheet_anime_0305/out/rejects"),
    ]
    for c in cands:
        if (c / "expr_2_qedit_headcrop_10050305_a1.png").is_file():
            return c
    return cands[0]


_REJ = _resolve_0305_rejects()


def _png(img: Image.Image) -> bytes:
    buf = BytesIO()
    img.save(buf, format="PNG")
    return buf.getvalue()


def _headshoulder(size: int = 768, *, scale: float = 1.0, dy: float = 0.0) -> bytes:
    """合成头肩：发 + 脸 + 两眼 + 肩/衣服铺到底。scale 缩放人物、dy 上下平移（相对边长）。"""
    im = Image.new("RGB", (size, size), (200, 200, 205))
    d = ImageDraw.Draw(im)

    def box(x1, y1, x2, y2):
        cx, cy = 0.5, 0.30 + dy
        return (
            size * (cx + (x1 - cx) * scale),
            size * (cy + (y1 - cy) * scale),
            size * (cx + (x2 - cx) * scale),
            size * (cy + (y2 - cy) * scale),
        )

    d.ellipse(box(0.32, 0.10, 0.68, 0.34), fill=(30, 30, 40))
    d.ellipse(box(0.36, 0.22, 0.64, 0.46), fill=(225, 190, 170))
    d.ellipse(box(0.41, 0.30, 0.46, 0.35), fill=(40, 50, 140))
    d.ellipse(box(0.54, 0.30, 0.59, 0.35), fill=(40, 50, 140))
    x1, y1, x2, _ = box(0.20, 0.52, 0.80, 0.52)
    d.rectangle((x1, y1, x2, size), fill=(70, 90, 110))
    # 衣服纹理：底行不能是纯色
    for x in range(int(x1), int(x2), 12):
        d.line((x, y1, x, size), fill=(60, 80, 100), width=3)
    return _png(im)


# ---------- ① 禁止灰垫 ----------

def test_0430_short_source_raises_not_gray_pad():
    """脸占满画面、下方没身体：必须抛 HeadcropSourceShort，绝不出灰垫图。"""
    size = 768
    im = Image.new("RGB", (size, size), (200, 200, 205))
    d = ImageDraw.Draw(im)
    d.ellipse((size * 0.22, size * 0.02, size * 0.78, size * 0.42), fill=(30, 30, 40))
    d.ellipse((size * 0.28, size * 0.22, size * 0.72, size * 0.62), fill=(225, 190, 170))
    d.ellipse((size * 0.36, size * 0.36, size * 0.44, size * 0.44), fill=(40, 50, 140))
    d.ellipse((size * 0.56, size * 0.36, size * 0.64, size * 0.44), fill=(40, 50, 140))
    d.rectangle((size * 0.20, size * 0.80, size * 0.80, size), fill=(70, 90, 110))
    with pytest.raises(sheet_svc.HeadcropSourceShort, match="禁止灰垫"):
        sheet_svc.crop_expr_head_closeup(_png(im), size=768)


def test_0430_short_source_frame_path_raises():
    raw = _headshoulder(scale=1.0, dy=0.45)  # 人物整体下移，下方不够
    frame = {"face_frac": 0.30, "face_top_frac": 0.20, "face_cx_frac": 0.5}
    with pytest.raises(sheet_svc.HeadcropSourceShort):
        sheet_svc.crop_expr_head_closeup(raw, size=768, frame=frame)


def test_0430_wide_source_no_bottom_band():
    out = sheet_svc.crop_expr_head_closeup(_headshoulder(scale=1.0), size=768)
    assert sheet_svc.uniform_bottom_band_frac(out) <= 0.06
    sheet_svc.assert_no_uniform_bottom_band(out, expr_key="expr_2")


def test_0430_synth_gray_pad_rejected():
    im = Image.open(BytesIO(_headshoulder())).convert("RGB")
    d = ImageDraw.Draw(im)
    d.rectangle((0, 560, 768, 768), fill=(200, 200, 205))  # 底部大块灰垫
    with pytest.raises(sheet_svc.CharacterSheetError, match="底部纯色垫块"):
        sheet_svc.assert_no_uniform_bottom_band(_png(im), expr_key="expr_2")


def test_0430_real_0305_a1_headcrop_gray_pad_rejected():
    f = _REJ / "expr_2_qedit_headcrop_10050305_a1.png"
    if not f.is_file():
        pytest.skip("0305 a1 headcrop 证据不在本机")
    with pytest.raises(sheet_svc.CharacterSheetError, match="底部纯色垫块"):
        sheet_svc.assert_no_uniform_bottom_band(f.read_bytes(), expr_key="expr_2")


def test_0430_real_locked_cells_pass_band_gate():
    fs = [_REJ / "expr_1_locked_10050305.png", _REJ / "override_expr_5.png"]
    fs = [f for f in fs if f.is_file()]
    if not fs:
        pytest.skip("0305 锁定格证据不在本机")
    for f in fs:
        sheet_svc.assert_no_uniform_bottom_band(f.read_bytes(), expr_key=f.stem)


# ---------- ① 与锁定格同比例 ----------

def test_0430_frame_crop_matches_locked_proportion():
    locked = [_headshoulder(scale=s) for s in (1.6, 1.65, 1.7)]
    frame = sheet_svc.locked_expr_frame(locked)
    assert frame is not None and frame["n"] == 3
    raw = _headshoulder(scale=1.0)  # 更宽的源（同一人更小）
    out = sheet_svc.crop_expr_head_closeup(raw, size=768, frame=frame)
    info = sheet_svc.assert_expr_frame_match(out, frame, expr_key="expr_2")
    assert info["d_face"] <= 0.07 and info["d_top"] <= 0.07
    sheet_svc.assert_no_uniform_bottom_band(out, expr_key="expr_2")


def test_0430_frame_mismatch_rejected():
    frame = {"face_frac": 0.60, "face_top_frac": 0.12, "face_cx_frac": 0.5}
    small = _headshoulder(scale=0.7)
    with pytest.raises(sheet_svc.CharacterSheetError, match="构图门禁"):
        sheet_svc.assert_expr_frame_match(small, frame, expr_key="expr_2")


def test_0430_locked_frame_needs_two_cells():
    assert sheet_svc.locked_expr_frame([_headshoulder()]) is None


# ---------- ② VLM 判闭嘴 + 情绪 ----------

def test_0430_qa_prompts_mouth_closed_and_emotion():
    p2 = sheet_svc._EXPR_QA_PROMPTS["expr_2"]
    p3 = sheet_svc._EXPR_QA_PROMPTS["expr_3"]
    for p in (p2, p3):
        assert "mouth CLOSED" in p
        assert "O-shaped" in p
    assert "DOWNWARD" in p2 and "blank" in p2
    assert "gentle" in p3.lower() and "smile" in p3
    with pytest.raises(sheet_svc.CharacterSheetError, match="专项问答未过"):
        sheet_svc.assert_expression_qa_match("expr_2", {"q1": False, "q2": True})
    with pytest.raises(sheet_svc.CharacterSheetError, match="专项问答未过"):
        sheet_svc.assert_expression_qa_match("expr_3", {"q1": True, "q2": False})
    assert sheet_svc.assert_expression_qa_match("expr_3", {"q1": True, "q2": True})["pass"]


def test_0430_edit_instructions_closed_mouth():
    ins = sheet_svc._EXPR_EDIT_INSTRUCTIONS
    assert "嘴唇闭合" in ins[2] and "O 形嘴" in ins[2]
    assert "闭嘴浅笑" in ins[3] and "禁止张嘴" in ins[3]


# ---------- ③ 超时只计执行、排队不计 ----------

class _FakeClient:
    def __init__(self, states: list[str], images_after: int | None):
        self.states = states
        self.i = 0
        self.images_after = images_after
        self.deleted: list[str] = []

    async def get_images(self, pid):
        if self.images_after is not None and self.i >= self.images_after:
            return [{"filename": "x.png"}]
        return []

    async def get_history(self, pid):
        return {}

    async def get_queue_detail(self):
        st = self.states[min(self.i, len(self.states) - 1)]
        self.i += 1
        if st == "pending":
            return set(), {"p1": 3}
        if st == "running":
            return {"p1"}, {}
        return set(), {}

    async def delete_from_queue(self, ids):
        self.deleted.extend(ids)


def test_0430_queue_time_not_counted(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_POLL_INTERVAL", 0.0)
    # 排队 50 轮（远超 exec_timeout 对应轮数），之后执行 2 轮出图 → 不应超时
    states = ["pending"] * 50 + ["running"] * 5
    cli = _FakeClient(states, images_after=52)
    monkeypatch.setattr(sheet_svc, "_POLL_INTERVAL", 1.0)

    async def _nosleep(_):
        return None

    monkeypatch.setattr(sheet_svc.asyncio, "sleep", _nosleep)
    imgs = asyncio.run(
        sheet_svc._wait_images(cli, "p1", exec_timeout=10.0, queue_wait_max=100.0)
    )
    assert imgs and not cli.deleted


def test_0430_exec_timeout_counts_only_running(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_POLL_INTERVAL", 1.0)

    async def _nosleep(_):
        return None

    monkeypatch.setattr(sheet_svc.asyncio, "sleep", _nosleep)
    cli = _FakeClient(["pending"] * 5 + ["running"] * 100, images_after=None)
    with pytest.raises(sheet_svc.CharacterSheetError, match="执行计时") as ei:
        asyncio.run(sheet_svc._wait_images(cli, "p1", exec_timeout=10.0, queue_wait_max=100.0))
    assert not isinstance(ei.value, sheet_svc.CharacterSheetQueueWait)
    assert "queue_wait=5s" in str(ei.value)


def test_0430_queue_wait_over_max_dequeues_and_raises(monkeypatch):
    monkeypatch.setattr(sheet_svc, "_POLL_INTERVAL", 1.0)

    async def _nosleep(_):
        return None

    monkeypatch.setattr(sheet_svc.asyncio, "sleep", _nosleep)
    cli = _FakeClient(["pending"] * 1000, images_after=None)
    with pytest.raises(sheet_svc.CharacterSheetQueueWait) as ei:
        asyncio.run(sheet_svc._wait_images(cli, "p1", exec_timeout=10.0, queue_wait_max=30.0))
    assert ei.value.queue_wait >= 30.0
    assert cli.deleted == ["p1"]


def test_0430_defaults():
    assert sheet_svc._POLL_TIMEOUT == 420.0
    assert sheet_svc._QUEUE_WAIT_MAX == 1200.0


# ---------- 源码契约：管线接线 ----------

def test_0430_pipeline_contract():
    src = Path(sheet_svc.__file__).read_text(encoding="utf-8")
    assert "crop_expr_head_closeup(raw, size=768, frame=expr_frame)" in src
    assert "assert_no_uniform_bottom_band(cell_b, expr_key=ek)" in src
    assert "except CharacterSheetQueueWait as qw:" in src
    assert "attempt -= 1" in src  # queue_wait 不消耗次数
    assert "_QUEUE_WAIT_RETRY_MAX" in src
    # 不再用紧裁 crop_face_ref+squareize 做沉思/温柔编辑底
    seg = src[src.index("04:30：编辑底用**宽头肩源**"):src.index("except CharacterSheetQueueWait as qw:")]
    assert "squareize_face_center_crop(edit_base" not in seg
    assert "squareize_face_center_crop(cell_b" not in seg


def test_0430_real_0305_bases_framing():
    """真实 0305：按锁定格中位比例裁，base_expr_2 可用（无灰垫、同比例）；base_expr_3 自带底白条须被拒。"""
    out_dir = _REJ.parent
    names = ["expr_0_locked_10050305.png", "expr_1_locked_10050305.png", "override_expr_4.png", "override_expr_5.png"]
    if not all((_REJ / n).is_file() for n in names) or not (out_dir / "base_expr_2.png").is_file():
        pytest.skip("0305 证据不在本机")
    frame = sheet_svc.locked_expr_frame([(_REJ / n).read_bytes() for n in names])
    assert frame is not None
    ok = sheet_svc.crop_expr_head_closeup((out_dir / "base_expr_2.png").read_bytes(), size=768, frame=frame)
    sheet_svc.assert_no_uniform_bottom_band(ok, expr_key="base_expr_2")
    sheet_svc.assert_expr_frame_match(ok, frame, expr_key="base_expr_2")
    bad = sheet_svc.crop_expr_head_closeup((out_dir / "base_expr_3.png").read_bytes(), size=768, frame=frame)
    with pytest.raises(sheet_svc.CharacterSheetError, match="底部纯色垫块"):
        sheet_svc.assert_no_uniform_bottom_band(bad, expr_key="base_expr_3")
    # 0305 a1 紧裁 Qwen 输出按锁定比例裁不出 → 抛错而非灰垫
    a1 = _REJ / "expr_2_qedit_raw_10050305_a1.png"
    if a1.is_file():
        with pytest.raises(sheet_svc.HeadcropSourceShort):
            sheet_svc.crop_expr_head_closeup(a1.read_bytes(), size=768, frame=frame)
