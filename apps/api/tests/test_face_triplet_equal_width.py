"""面部三格等宽拼版门禁（18:10：几何等宽 + 人脸框居中）。"""
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
    info = sheet_svc.assert_face_triplet_equal_width(panel, n=3, cell_w=200, gap=10)
    assert info["geo"]["cell_w"] == 200


def test_equal_width_face_bbox_and_margins():
    """源人脸宽不同时，按注入 bbox 拼版后人脸等宽±2px 且左右边距≥10%。"""
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
        # 源图 400x500 时返回预设；拼后的 cell 按几何反推困难，改为按非浅底像素估
        w, h = im.size
        if w == 400 and h == 500:
            idx = calls["n"]
            calls["n"] += 1
            return boxes[idx]
        # cell 内：找非背景色块
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
        # 用人脸椭圆近似：排除衣服矩形下层，取上部 55% 为脸
        face_bottom = miny + int((maxy - miny) * 0.55)
        return (minx, miny, maxx, face_bottom)

    with mock.patch.object(sheet_svc, "_face_bbox_for_center", side_effect=fake_bb):
        panel = sheet_svc.collage_face_triplet_equal_width(
            faces, cell_w=220, cell_h=320, gap=8, face_width_frac=0.70, min_side_margin=0.10
        )
        info = sheet_svc.assert_face_triplet_equal_width(
            panel,
            n=3,
            cell_w=220,
            gap=8,
            max_face_width_delta_px=2,
            min_side_margin=0.10,
        )
    assert max(info["face_widths"]) - min(info["face_widths"]) <= 2
    for m in info["margins"]:
        assert m["left"] >= 0.10 - 1e-6
        assert m["right"] >= 0.10 - 1e-6


def test_sheet_faces_paste_not_cover_crop():
    """整卡 faces 贴入不得 cover 裁掉 L/R（回归 18:10）。"""
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
        sheet, max_cell_delta_px=2, min_side_margin=0.08
    )
    assert max(measured["cell_widths"]) - min(measured["cell_widths"]) <= 2
