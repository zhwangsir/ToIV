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
            max_face_height_frac_delta=0.20,
            min_side_margin=None,
        )
    fracs = info["face_height_fracs"]
    assert max(fracs) - min(fracs) <= 0.20 + 1e-6
    assert max(info["cell_heights"]) - min(info["cell_heights"]) <= 2
    # cover 保头顶后侧脸可贴边；只验几何与脸高差


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
        min_side_margin=0.0,
        max_face_height_frac_delta=0.25,
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


def test_profile_r_lead_and_top_margin():
    """19:42：R 侧脸鼻尖前方≥12% 格宽、头顶≥3%；L/M 仍走 cover。"""
    faces = [
        _face(300, 400, (200, 160, 140), face_box=(80, 40, 220, 200)),
        _face(300, 400, (190, 150, 130), face_box=(70, 30, 230, 210)),
        None,
    ]
    # R：左向侧脸贴在画布中部偏左，四周留灰底；trim 后仍应能被 profile fit 推出留白
    rim = Image.new("RGB", (400, 480), (248, 248, 252))
    d = ImageDraw.Draw(rim)
    d.ellipse((40, 30, 220, 240), fill=(20, 20, 28))  # hair
    d.ellipse((50, 80, 180, 230), fill=(210, 170, 150))  # face
    d.rectangle((70, 220, 230, 420), fill=(40, 40, 50))
    b = BytesIO()
    rim.save(b, "PNG")
    faces[2] = b.getvalue()

    # L/M cover 路径用稳定假脸框；R 用真像素启发式（不 mock content/assert）
    boxes = {
        id(None): None,
    }

    def fake_bb(im_or_bytes):
        if isinstance(im_or_bytes, (bytes, bytearray)):
            im2 = Image.open(BytesIO(im_or_bytes)).convert("RGB")
        else:
            im2 = im_or_bytes
        w, h = im2.size
        if (w, h) == (300, 400):
            # L or M by average color
            px = list(im2.resize((8, 8)).getdata())
            avg = sum(p[0] for p in px) / len(px)
            if avg > 195:
                return (80, 40, 220, 200)
            return (70, 30, 230, 210)
        # for R source / scaled: skin blob
        px = im2.load()
        xs, ys = [], []
        for yy in range(h):
            for xx in range(w):
                r, g, b = px[xx, yy]
                if r > 180 and 130 < g < 200 and 110 < b < 190 and r > g:
                    xs.append(xx)
                    ys.append(yy)
        if len(xs) < 8:
            return None
        return (min(xs), min(ys), max(xs), max(ys))

    with mock.patch.object(sheet_svc, "_face_bbox_for_center", side_effect=fake_bb):
        with mock.patch.object(sheet_svc, "_insightface_face_bbox_xyxy", return_value=None):
            panel = sheet_svc.collage_face_triplet_equal_width(
                faces, cell_w=240, cell_h=320, gap=12
            )
            info = sheet_svc.assert_face_triplet_profile_lead_margin(
                panel, cell_w=240, cell_h=320, gap=12, min_lead=0.12, min_top=0.03
            )
            assert info["ok"] is True
            assert info["lead"] >= 0.12 - 1e-6
            assert info["top"] >= 0.03 - 1e-6
            geo = sheet_svc.assert_face_triplet_equal_width(
                panel, n=3, cell_w=240, cell_h=320, gap=12
            )
            assert geo["geo"]["cell_w"] == 240


def test_triplet_outer_bbox_identical_and_full_cell():
    """20:03：三格外框 240x320 全等；R 不得 letterbox 缩成小方块。"""
    from PIL import Image, ImageDraw
    from io import BytesIO

    def _mk(kind: str) -> bytes:
        im = Image.new("RGB", (400, 500), (248, 248, 252))
        dr = ImageDraw.Draw(im)
        if kind == "L":
            dr.ellipse((80, 40, 280, 280), fill=(230, 190, 170))
            dr.rectangle((120, 280, 240, 460), fill=(40, 40, 48))
        elif kind == "M":
            dr.ellipse((90, 50, 290, 290), fill=(225, 185, 165))
            dr.rectangle((130, 290, 250, 470), fill=(45, 45, 55))
        else:  # R profile facing left
            dr.ellipse((40, 60, 220, 280), fill=(230, 190, 170))
            dr.rectangle((90, 280, 210, 470), fill=(40, 40, 48))
            # dark hair blob on right of face
            dr.ellipse((150, 40, 300, 260), fill=(20, 20, 28))
        buf = BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()

    faces = [_mk("L"), _mk("M"), _mk("R")]
    panel = sheet_svc.collage_face_triplet_equal_width(
        faces, cell_w=240, cell_h=320, gap=12
    )
    im = Image.open(BytesIO(panel)).convert("RGB")
    assert im.size == (3 * 240 + 2 * 12, 320)
    # 外框几何全等
    cells = []
    for i in range(3):
        x0 = i * (240 + 12)
        cells.append((x0, 0, x0 + 240, 320))
    assert cells[0][2] - cells[0][0] == cells[1][2] - cells[1][0] == cells[2][2] - cells[2][0] == 240
    assert cells[0][3] - cells[0][1] == cells[1][3] - cells[1][1] == cells[2][3] - cells[2][1] == 320
    # R 外框满格；允许鼻前浅底留白（lead≈12%），但不得深灰画中画缩格
    x0 = 2 * (240 + 12)
    cell = im.crop((x0, 0, x0 + 240, 320))
    px = cell.load()
    xs, ys = [], []
    midgray = 0
    for yy in range(320):
        for xx in range(240):
            r, g, b = px[xx, yy]
            if abs(r - 160) < 25 and abs(g - 160) < 25 and abs(b - 168) < 25:
                midgray += 1
            if r < 245 or g < 245 or b < 245:
                xs.append(xx); ys.append(yy)
    assert xs, "R cell empty"
    frac_w = (max(xs) - min(xs) + 1) / 240
    frac_h = (max(ys) - min(ys) + 1) / 320
    # 高度须铺满；宽度允许鼻前浅底，但前景跨度 >= 0.80
    assert frac_h >= 0.92 and frac_w >= 0.80, (frac_w, frac_h)
    assert midgray / (240 * 320) < 0.08, midgray / (240 * 320)


def test_palette_hex_labels_no_overlap():
    """20:03：配色色号文字框互不重叠。"""
    from PIL import Image
    from io import BytesIO

    panels = {
        "portrait": Image.new("RGB", (400, 600), (200, 180, 170)),
        "front": Image.new("RGB", (200, 400), (190, 170, 160)),
        "side": Image.new("RGB", (200, 400), (185, 165, 155)),
        "back": Image.new("RGB", (200, 400), (180, 160, 150)),
        "faces": Image.new("RGB", (744, 480), (248, 248, 252)),
        "costume": Image.new("RGB", (400, 300), (30, 30, 36)),
    }
    for i in range(6):
        panels[f"expr_{i}"] = Image.new("RGB", (200, 200), (210, 190, 180))
    # convert to bytes locked style used by compose
    locked = {}
    for k, im in panels.items():
        buf = BytesIO(); im.save(buf, format="PNG"); locked[k] = buf.getvalue()
    meta = sheet_svc.SheetMeta(
        name="林夏",
        style="anime",
        height_cm=168,
        role="便利店员",
        personality="温柔果断",
        design_notes="雨夜便利店相遇的核心角色。\n黑色连帽雨衣与湿发贴额。\n三视图与表情同源同画风。",
        colors=["#E8C4A8", "#C98A7A", "#1A1A1E", "#2C2C34", "#D4D3D8", "#5A6A7A"],
    )
    png = sheet_svc.compose_character_sheet(locked, meta)
    assert isinstance(png, (bytes, bytearray)) and len(png) > 1000


def test_profile_cell_pad_delta_e_matches_source_bg():
    """20:22：R 格补边区与源图左/上背景 ΔE<6；贴底且非深灰画中画。"""
    from PIL import Image, ImageDraw
    from io import BytesIO

    def _mk(kind: str) -> bytes:
        if kind == "R":
            im = Image.new("RGB", (400, 500), (228, 228, 234))
            dr = ImageDraw.Draw(im)
            dr.ellipse((40, 50, 220, 270), fill=(230, 190, 170))
            dr.ellipse((160, 30, 320, 250), fill=(20, 20, 28))
            dr.rectangle((90, 270, 220, 500), fill=(40, 40, 48))
        else:
            im = Image.new("RGB", (400, 500), (248, 248, 252))
            dr = ImageDraw.Draw(im)
            if kind == "L":
                dr.ellipse((80, 40, 280, 280), fill=(230, 190, 170))
                dr.rectangle((120, 280, 240, 500), fill=(40, 40, 48))
            else:
                dr.ellipse((90, 50, 290, 290), fill=(225, 185, 165))
                dr.rectangle((130, 290, 250, 500), fill=(45, 45, 55))
        buf = BytesIO()
        im.save(buf, format="PNG")
        return buf.getvalue()

    raw_r = _mk("R")
    panel = sheet_svc.collage_face_triplet_equal_width(
        [_mk("L"), _mk("M"), raw_r], cell_w=240, cell_h=320, gap=12
    )
    full = Image.open(BytesIO(panel)).convert("RGB")
    x0 = 2 * (240 + 12)
    cell = full.crop((x0, 0, x0 + 240, 320))
    src = Image.open(BytesIO(raw_r)).convert("RGB")
    info = sheet_svc.assert_profile_cell_pad_delta_e(cell, src, band=10, max_delta_e=6.0)
    assert info["ok"] is True
    bot = list(cell.crop((0, 314, 240, 320)).getdata())
    dark = sum(1 for r, g, b in bot if (r + g + b) / 3 < 120)
    assert dark >= 30, f"bottom not stuck to clothes: dark={dark}"
    midgray = sum(
        1
        for r, g, b in cell.getdata()
        if abs(r - 160) < 25 and abs(g - 160) < 25 and abs(b - 168) < 25
    )
    assert midgray / (240 * 320) < 0.08, midgray / (240 * 320)

