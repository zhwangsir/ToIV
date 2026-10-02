"""面部三格等宽拼版门禁（18:00）。"""
from __future__ import annotations
from io import BytesIO
from PIL import Image, ImageDraw
from app.services.studio import character_sheet as sheet_svc

def _face(w, h, color):
    im = Image.new("RGB", (w, h), (248, 248, 252))
    d = ImageDraw.Draw(im)
    d.ellipse((w//4, h//8, 3*w//4, 5*h//8), fill=color)
    d.rectangle((w//3, 5*h//8, 2*w//3, 7*h//8), fill=(40,40,48))
    b = BytesIO(); im.save(b, "PNG"); return b.getvalue()

def test_equal_width_collage_geometry():
    faces = [_face(120, 400, (30,30,40)), _face(500, 380, (50,50,60)), _face(90, 420, (20,20,30))]
    panel = sheet_svc.collage_face_triplet_equal_width(faces, cell_w=200, cell_h=300, gap=10)
    im = Image.open(BytesIO(panel))
    assert im.width == 3*200 + 2*10
    assert im.height == 300
    info = sheet_svc.assert_face_triplet_equal_width(panel, n=3, cell_w=200, gap=10)
    assert info["geo"]["cell_w"] == 200

def test_unequal_legacy_hstack_fails_assert():
    imgs = []
    for w in (80, 400, 90):
        im = Image.new("RGB", (w, 200), (248,248,252))
        d = ImageDraw.Draw(im)
        d.rectangle((5,5,w-5,195), fill=(30,30,40))
        imgs.append(im)
    h=200; gap=8
    canvas=Image.new("RGB",(sum(i.width for i in imgs)+2*gap,h),(248,248,252))
    x=0
    for im in imgs:
        canvas.paste(im,(x,0)); x+=im.width+gap
    b=BytesIO(); canvas.save(b,"PNG")
    try:
        sheet_svc.assert_face_triplet_equal_width(b.getvalue(), n=3, max_content_ratio=1.35)
        raised=False
    except sheet_svc.CharacterSheetError:
        raised=True
    assert raised
