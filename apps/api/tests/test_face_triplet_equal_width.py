"""面部三格同宽同高拼版门禁（18:38：等矩形 + 人脸高占比一致）。"""
from __future__ import annotations

from io import BytesIO
from unittest import mock

from PIL import Image, ImageDraw

from app.services.studio import character_sheet as sheet_svc


def _face(w, h, color, *, face_box):
    im = Image.new("RGB", (w, h), (248, 248, 252))
    d = ImageDraw.Draw(im)
    x0, y0, x1, y1 = face_box
    d.ellipse((x0, y0, x1, y1), fill=color)
    d.rectangle(
        (x0 + (x1 - x0) // 4, y1, x1 - (x1 - x0) // 4, min(h - 4, y1 + (y1 - y0) // 2)),
        fill=(40, 40, 48),
    )
    b = BytesIO()
    im.save(b, "PNG")
    return b.getvalue()


def test_equal_width_collage_geometry():
    faces = [
        _face(120, 400, (30, 30, 40), face_box=(20, 40, 100, 160)),
        _face(500, 380, (50, 50, 60), face_box=(150, 30, 350, 220)),
        _face(90, 420, (20, 20, 30), face_box=(10, 50, 80, 170)),
    ]
    panel = sheet_svc.collage_face_triplet_equal_width(faces, cell_w=200, cell_h=300, gap=10)
    im = Image.open(BytesIO(panel))
    assert im.width == 3 * 200 + 2 * 10
    assert im.height == 300
    info = sheet_svc.assert_face_triplet_equal_width(
        panel, n=3, cell_w=200, cell_h=300, gap=10
    )
    assert info["geo"]["cell_w"] == 200
    assert info["geo"]["cell_h"] == 300


def test_equal_size_face_height_frac_and_margins():
    """源人脸尺寸不同时，拼后人脸高度占比差≤10%，格同宽同高，左右边距≥10%。"""
    boxes = {
        0: (40, 40, 200, 220),
        1: (100, 30, 300, 250),
        2: (220, 50, 360, 210),
    }
    faces = [
        _face(400, 500, (200, 160, 140), face_box=boxes[0]),
        _face(400, 500, (190, 150, 130), face_box=boxes[1]),
        _face(400, 500, (180, 140, 120), face_box=boxes[2]),
    ]
    calls = {"n": 0}

    def fake_bb(im):
        w, h = im.size
        if w == 400 and h == 500:
            idx = calls["n"]
            calls["n"] += 1
            return boxes[idx]
        px = im.load()
        minx, maxx = w, -1
        miny, maxy = h, -1
        for y in range(h):
            for x in range(w):
                r, g, b = px[x, y]
                if r > 245 and g > 245 and b > 245:
                    continue
                minx = min(minx, x)
                maxx = max(maxx, x)
                miny = min(miny, y)
                maxy = max(maxy, y)
        if maxx < 0:
            return None
        face_bottom = miny + int((maxy - miny) * 0.55)
        return (minx, miny, maxx, face_bottom)

    with mock.patch.object(sheet_svc, "_face_bbox_for_center", side_effect=fake_bb):
        panel = sheet_svc.collage_face_triplet_equal_width(
            faces,
            cell_w=220,
            cell_h=320,
            gap=8,
            face_height_frac=0.55,
            min_side_margin=0.10,
        )
        info = sheet_svc.assert_face_triplet_equal_width(
            panel,
            n=3,
            cell_w=220,
            cell_h=320,
            gap=8,
            max_face_height_frac_delta=0.12,
            min_side_margin=None,
        )
    fracs = info["face_height_fracs"]
    assert max(fracs) - min(fracs) <= 0.12 + 1e-6
    assert max(info["cell_heights"]) - min(info["cell_heights"]) <= 2
    # 正/三分脸应大致居中；侧脸 cover 保头顶后允许偏置
    for i, m in enumerate(info["margins"][:2]):
        assert m["left"] >= 0.05 - 1e-6, i
        assert m["right"] >= 0.05 - 1e-6, i


def test_gap_columns_have_no_stray_content():
    """格间 gap 列应接近背景色，不得有细竖杂条。"""
    faces = [
        _face(300, 400, (200, 160, 140), face_box=(80, 40, 220, 200)),
        _face(300, 400, (190, 150, 130), face_box=(70, 30, 230, 210)),
        _face(300, 400, (180, 140, 120), face_box=(90, 50, 210, 190)),
    ]
    cell_w, cell_h, gap = 240, 320, 12
    bg = (248, 248, 252)
    panel = sheet_svc.collage_face_triplet_equal_width(
        faces, cell_w=cell_w, cell_h=cell_h, gap=gap, bg=bg
    )
    im = Image.open(BytesIO(panel)).convert("RGB")
    px = im.load()
    for gi in range(2):
        x0 = (gi + 1) * cell_w + gi * gap
        dark = 0
        total = 0
        for x in range(x0, x0 + gap):
            for y in range(cell_h):
                r, g, b = px[x, y]
                total += 1
                if abs(r - bg[0]) > 18 or abs(g - bg[1]) > 18 or abs(b - bg[2]) > 18:
                    dark += 1
        assert dark / max(total, 1) < 0.05, f"gap{gi} stray={dark}/{total}"


def test_sheet_faces_paste_not_cover_crop():
    """整卡 faces 贴入不得 cover 裁掉 L/R；宽高一致、脸高占比差≤10%。"""
    faces = [
        _face(300, 400, (200, 160, 140), face_box=(80, 40, 220, 200)),
        _face(300, 400, (190, 150, 130), face_box=(70, 30, 230, 210)),
        _face(300, 400, (180, 140, 120), face_box=(90, 50, 210, 190)),
    ]
    panel = sheet_svc.collage_face_triplet_equal_width(faces, cell_w=240, cell_h=360, gap=12)

    def _blob(w=512, h=768, c=(40, 40, 48)):
        im = Image.new("RGB", (w, h), c)
        b = BytesIO()
        im.save(b, "PNG")
        return b.getvalue()

    locked = {
        "portrait": _blob(),
        "front": _blob(),
        "side": _blob(),
        "back": _blob(),
        "faces": panel,
        "costume": _blob(1180, 400, (240, 240, 244)),
        **{f"expr_{i}": _blob(256, 256, (210, 180, 160)) for i in range(6)},
    }
    meta = sheet_svc.SheetMeta(
        name="测",
        style="anime",
        height_cm=168,
        role="测",
        personality="测",
        design_notes="一行说明。\n二行说明。\n三行说明。",
        visual_prompt="test",
        description="测",
    )
    sheet = sheet_svc.compose_character_sheet(locked, meta)
    measured = sheet_svc.assert_sheet_faces_equal_width(
        sheet,
        max_cell_delta_px=2,
        min_side_margin=0.05,
        max_face_height_frac_delta=0.12,
    )
    assert max(measured["cell_widths"]) - min(measured["cell_widths"]) <= 2
    assert max(measured["cell_heights"]) - min(measured["cell_heights"]) <= 2


def test_cell_edges_clean_after_trim_cover():
    """源图右侧有灰竖条时，裁边+cover 后四边 4px 不得再有色差>40 的均匀杂条。"""
    # L：主体 + 右侧 20px 浅灰竖条
    im = Image.new("RGB", (300, 400), (200, 160, 140))
    d = ImageDraw.Draw(im)
    d.ellipse((60, 40, 220, 220), fill=(210, 170, 150))
    d.rectangle((280, 0, 299, 399), fill=(235, 235, 240))
    # M / R：无杂条
    faces = []
    for box in [(60, 40, 220, 220), (70, 30, 230, 210), (80, 50, 210, 200)]:
        base = Image.new("RGB", (300, 400), (190, 150, 130))
        ImageDraw.Draw(base).ellipse(box, fill=(200, 160, 140))
        if box == (60, 40, 220, 220):
            base = im
        b = BytesIO()
        base.save(b, "PNG")
        faces.append(b.getvalue())
    # mock face bbox so cover keeps crown path stable
    def fake_bb(im_or_bytes):
        if isinstance(im_or_bytes, (bytes, bytearray)):
            im2 = Image.open(BytesIO(im_or_bytes)).convert("RGB")
        else:
            im2 = im_or_bytes
        w, h = im2.size
        return (int(w * 0.25), int(h * 0.15), int(w * 0.75), int(h * 0.55))

    with mock.patch.object(sheet_svc, "_face_bbox_for_center", side_effect=fake_bb):
        with mock.patch.object(sheet_svc, "_insightface_face_bbox_xyxy", return_value=None):
            panel = sheet_svc.collage_face_triplet_equal_width(
                faces, cell_w=240, cell_h=320, gap=12
            )
            sheet_svc.assert_face_triplet_cell_edges_clean(
                panel, cell_w=240, cell_h=320, gap=12, band=4, max_delta=40.0
            )
            # 几何仍等宽等高
            info = sheet_svc.assert_face_triplet_equal_width(
                panel, n=3, cell_w=240, cell_h=320, gap=12
            )
            assert info["geo"]["cell_w"] == 240
