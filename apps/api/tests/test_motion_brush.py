"""Motion Brush 局部动效标记 —— 笔画校验 / mask 栅格化 / 端点 / VACE 集成 测试。

覆盖:
  · validate_strokes:坐标越界/半径越界(5-100)/强度越界/非有限值/空列表/超上限/
    画布过小 → MotionBrushError;方向矢量模长 >1 归一化(不报错);零向量保持无方向
  · generate_mask:单笔画圆形区域(RGB=strength*255,圆外全 0);多笔画重叠强度取 max;
    方向角编码进 alpha(静止区/无方向=0);零强度笔画不产生像素;PNG 字节可回读
  · POST /api/motion-brush/mask:缺图 422(源 worker 404)/worker 故障 502/
    笔画非法 422/缺鉴权 401/成功上传返回 mask 文件名 + 回读 URL
  · VACE 集成(workflows/wan_vace):motion_mask → LoadImage+ImageToMask(red)→
    VACEEncode.input_masks;与首尾帧支路并存时 MaskComposite multiply 取交集
"""
from __future__ import annotations

import math

import pytest
from fastapi.testclient import TestClient
from PIL import Image
from sqlalchemy.pool import StaticPool
from sqlmodel import Session, SQLModel, create_engine

import app.routes.motion_brush as mb_route
from app.comfy.client import ComfyUIError
from app.db import get_session
from app.main import app
from app.models import Tenant, User
from app.security import create_token, hash_password
from app.services.motion_brush import (
    MAX_STROKES,
    BrushStroke,
    MotionBrushError,
    MotionBrushMask,
    generate_mask,
    mask_to_png_bytes,
    validate_strokes,
)
from app.workflows.wan_vace import WanVaceParams, build_wan_vace_graph


def _seed_user(session: Session, email: str) -> str:
    tenant = Tenant(name=email)
    session.add(tenant)
    session.commit()
    session.refresh(tenant)
    user = User(
        email=email,
        hashed_password=hash_password("password1"),
        tenant_id=tenant.id,
    )
    session.add(user)
    session.commit()
    session.refresh(user)
    return user.id


@pytest.fixture
def engine():
    eng = create_engine(
        "sqlite://",
        connect_args={"check_same_thread": False},
        poolclass=StaticPool,
    )
    SQLModel.metadata.create_all(eng)
    yield eng


@pytest.fixture
def client(engine):
    def override() -> Session:
        with Session(engine) as session:
            yield session

    app.dependency_overrides[get_session] = override
    yield TestClient(app), engine
    app.dependency_overrides.clear()


class _FakeWorker:
    """上传落点 worker 替身:get_image_bytes/upload_image 可控。"""

    def __init__(self, *, missing: bool = False, broken: bool = False) -> None:
        self.base_url = "http://fake-worker"
        self._missing = missing
        self._broken = broken
        self.uploads: list[tuple[bytes, str]] = []

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        if self._missing:
            raise ComfyUIError("no such file", status_code=404)
        if self._broken:
            raise ComfyUIError("connection refused")  # 无 status_code = 网络层失败
        return b"source-image-bytes", "image/png"

    async def upload_image(self, content: bytes, filename: str) -> str:
        self.uploads.append((content, filename))
        return filename


def _install_worker(monkeypatch, fake: _FakeWorker) -> None:
    monkeypatch.setattr(mb_route, "resolve_worker", lambda worker: fake)


def _stroke(**kw) -> dict:
    base = {"center_x": 50.0, "center_y": 40.0, "radius": 20.0}
    base.update(kw)
    return base


# --------------------------------------------------------------------------- #
# validate_strokes
# --------------------------------------------------------------------------- #


def test_validate_ok_normalizes_overshoot_direction():
    """方向矢量模长 >1:归一化为单位向量,不报错。"""
    out = validate_strokes(
        [BrushStroke(center_x=50, center_y=50, radius=20, direction_x=3.0, direction_y=4.0)],
        100, 100,
    )
    assert len(out) == 1
    assert math.isclose(math.hypot(out[0].direction_x, out[0].direction_y), 1.0, abs_tol=1e-6)
    assert math.isclose(out[0].direction_x, 0.6, abs_tol=1e-6)
    assert math.isclose(out[0].direction_y, 0.8, abs_tol=1e-6)


def test_validate_keeps_zero_direction():
    """零向量 = 只标区域不定向,保持 (0,0)。"""
    out = validate_strokes([BrushStroke(center_x=10, center_y=10, radius=5)], 100, 100)
    assert out[0].direction_x == 0.0 and out[0].direction_y == 0.0


@pytest.mark.parametrize("cx,cy", [(-1, 50), (100, 50), (50, -5), (50, 100)])
def test_validate_rejects_out_of_canvas_center(cx, cy):
    with pytest.raises(MotionBrushError, match="超出画布"):
        validate_strokes([BrushStroke(center_x=cx, center_y=cy, radius=20)], 100, 100)


@pytest.mark.parametrize("radius", [4, 0, -10, 101, 1000])
def test_validate_rejects_out_of_range_radius(radius):
    with pytest.raises(MotionBrushError, match="半径"):
        validate_strokes([BrushStroke(center_x=50, center_y=50, radius=radius)], 200, 200)


@pytest.mark.parametrize("radius", [5, 100])
def test_validate_accepts_radius_bounds(radius):
    out = validate_strokes([BrushStroke(center_x=110, center_y=110, radius=radius)], 220, 220)
    assert out[0].radius == radius


@pytest.mark.parametrize("strength", [-0.1, 1.1])
def test_validate_rejects_out_of_range_strength(strength):
    with pytest.raises(MotionBrushError, match="强度"):
        validate_strokes(
            [BrushStroke(center_x=50, center_y=50, radius=20, strength=strength)], 100, 100
        )


@pytest.mark.parametrize("field", ["center_x", "center_y", "radius", "strength"])
def test_validate_rejects_non_finite(field):
    kw = {"center_x": 50.0, "center_y": 50.0, "radius": 20.0, "strength": 1.0}
    kw[field] = float("nan")
    with pytest.raises(MotionBrushError, match="有限"):
        validate_strokes([BrushStroke(**kw)], 100, 100)


def test_validate_rejects_empty_strokes():
    with pytest.raises(MotionBrushError, match="至少需要 1 条"):
        validate_strokes([], 100, 100)


def test_validate_rejects_too_many_strokes():
    strokes = [BrushStroke(center_x=50, center_y=50, radius=5)] * (MAX_STROKES + 1)
    with pytest.raises(MotionBrushError, match="最多"):
        validate_strokes(strokes, 100, 100)


def test_validate_rejects_tiny_canvas():
    with pytest.raises(MotionBrushError, match="画布尺寸过小"):
        validate_strokes([BrushStroke(center_x=5, center_y=5, radius=5)], 8, 8)


# --------------------------------------------------------------------------- #
# generate_mask
# --------------------------------------------------------------------------- #


def test_mask_single_stroke_circle():
    """单笔画:圆内 RGB=strength*255,圆外全 0;无方向 → alpha=0。"""
    img = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(BrushStroke(center_x=50, center_y=50, radius=20, strength=1.0),),
    ))
    assert img.mode == "RGBA" and img.size == (100, 100)
    r, g, b, a = img.getpixel((50, 50))
    assert (r, g, b) == (255, 255, 255)
    assert a == 0  # 无方向笔画 alpha=0(方向通道保留语义,非透明通道)
    assert img.getpixel((0, 0)) == (0, 0, 0, 0)  # 圆外静止
    assert img.getpixel((50, 71))[0] == 0  # 半径外(中心 y+21)


def test_mask_strength_scales_intensity():
    img = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(BrushStroke(center_x=50, center_y=50, radius=20, strength=0.5),),
    ))
    assert img.getpixel((50, 50))[0] == round(0.5 * 255)


def test_mask_zero_strength_paints_nothing():
    """strength=0 = 该区域保持静止,不产生像素。"""
    img = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(BrushStroke(center_x=50, center_y=50, radius=20, strength=0.0),),
    ))
    assert img.getpixel((50, 50)) == (0, 0, 0, 0)


def test_mask_overlap_takes_max_intensity():
    """多笔画重叠:强度取 max(弱笔不压暗强笔)。"""
    img = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(
            BrushStroke(center_x=40, center_y=50, radius=20, strength=1.0),
            BrushStroke(center_x=60, center_y=50, radius=20, strength=0.5),
        ),
    ))
    assert img.getpixel((50, 50))[0] == 255  # 重叠区取 max
    assert img.getpixel((75, 50))[0] == round(0.5 * 255)  # 仅弱笔覆盖区


def test_mask_direction_encoded_in_alpha():
    """方向角量化进 alpha:右=约 1/2 量程,上/下相差约半圈;静止区 alpha=0。"""
    right = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(BrushStroke(center_x=50, center_y=50, radius=20, direction_x=1.0, direction_y=0.0),),
    ))
    down = generate_mask(MotionBrushMask(
        width=100, height=100,
        strokes=(BrushStroke(center_x=50, center_y=50, radius=20, direction_x=0.0, direction_y=1.0),),
    ))
    a_right = right.getpixel((50, 50))[3]
    a_down = down.getpixel((50, 50))[3]
    assert a_right == 1 + round(0.5 * 254)  # atan2(0,1)=0 → 中点
    assert a_down == 1 + round(0.75 * 254)  # atan2(1,0)=π/2 → 3/4 量程
    assert right.getpixel((0, 0))[3] == 0  # 静止区 alpha=0


def test_mask_png_bytes_roundtrip():
    import io

    img = generate_mask(MotionBrushMask(
        width=64, height=48,
        strokes=(BrushStroke(center_x=32, center_y=24, radius=10),),
    ))
    data = mask_to_png_bytes(img)
    assert data[:4] == b"\x89PNG"
    back = Image.open(io.BytesIO(data))
    assert back.size == (64, 48) and back.mode == "RGBA"


# --------------------------------------------------------------------------- #
# POST /api/motion-brush/mask
# --------------------------------------------------------------------------- #


def _payload(**kw) -> dict:
    base = {
        "source_image": "first-frame.png",
        "worker": "http://fake-worker",
        "strokes": [_stroke()],
        "width": 832,
        "height": 480,
    }
    base.update(kw)
    return base


def test_endpoint_ok_uploads_mask_and_returns_name(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-ok")
    fake = _FakeWorker()
    _install_worker(monkeypatch, fake)
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(strokes=[_stroke(direction_x=2.0, direction_y=0.0, strength=0.8)]),
    )
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["mask"].startswith("motion-brush-") and body["mask"].endswith(".png")
    assert body["width"] == 832 and body["height"] == 480 and body["strokes"] == 1
    assert body["url"].startswith("/api/images?") and "type=input" in body["url"]
    # mask PNG 已上传到源 worker input(可被 VACE 提交时同路转运)
    assert len(fake.uploads) == 1
    content, name = fake.uploads[0]
    assert name == body["mask"] and content[:4] == b"\x89PNG"


def test_endpoint_missing_source_image_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-missing")
    _install_worker(monkeypatch, _FakeWorker(missing=True))
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 422
    assert "不存在" in r.json()["detail"]


def test_endpoint_worker_broken_502(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-broken")
    _install_worker(monkeypatch, _FakeWorker(broken=True))
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(),
    )
    assert r.status_code == 502
    assert "读取失败" in r.json()["detail"]


def test_endpoint_rejects_empty_strokes_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-empty")
    _install_worker(monkeypatch, _FakeWorker())
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(strokes=[]),
    )
    assert r.status_code == 422


def test_endpoint_rejects_out_of_canvas_stroke_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-oob")
    _install_worker(monkeypatch, _FakeWorker())
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(strokes=[_stroke(center_x=900.0)]),
    )
    assert r.status_code == 422
    assert "超出画布" in r.json()["detail"]


def test_endpoint_rejects_bad_radius_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-radius")
    _install_worker(monkeypatch, _FakeWorker())
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(strokes=[_stroke(radius=3.0)]),
    )
    assert r.status_code == 422
    assert "半径" in r.json()["detail"]


def test_endpoint_rejects_path_traversal_422(client, monkeypatch):
    c, eng = client
    with Session(eng) as s:
        uid = _seed_user(s, "mb-trav")
    _install_worker(monkeypatch, _FakeWorker())
    r = c.post(
        "/api/motion-brush/mask",
        headers={"Authorization": f"Bearer {create_token(uid)}"},
        json=_payload(source_image="../evil.png"),
    )
    assert r.status_code == 422


def test_endpoint_requires_auth(client):
    c, _ = client
    r = c.post("/api/motion-brush/mask", json=_payload())
    assert r.status_code == 401


# --------------------------------------------------------------------------- #
# VACE 集成(workflows/wan_vace motion_mask 连线)
# --------------------------------------------------------------------------- #


def test_vace_motion_mask_branch_wires_input_masks():
    """只给 motion_mask:LoadImage → ImageToMask(red) → VACEEncode.input_masks。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="红旗飘动", ref_images=("r1.png",), motion_mask="motion-brush-x.png", seed=1,
    ))
    assert g["50"]["class_type"] == "LoadImage"
    assert g["50"]["inputs"]["image"] == "motion-brush-x.png"
    assert g["51"]["class_type"] == "ImageToMask"
    assert g["51"]["inputs"]["image"] == ["50", 0]
    assert g["51"]["inputs"]["channel"] == "red"  # alpha 是方向角,不可直接当 mask
    assert g["10"]["inputs"]["input_masks"] == ["51", 0]
    assert "52" not in g  # 无首尾帧支路:不需要合并


def test_vace_motion_mask_merged_with_start_end_masks():
    """与首尾帧支路并存:MaskComposite multiply 取交集(两约束同时生效)。"""
    g = build_wan_vace_graph(WanVaceParams(
        positive="x", ref_images=("r1.png",),
        start_image="s.png", end_image="e.png",
        motion_mask="motion-brush-x.png", seed=1,
    ))
    assert g["44"]["class_type"] == "WanVideoVACEStartToEndFrame"
    comp = g["52"]
    assert comp["class_type"] == "MaskComposite"
    assert comp["inputs"]["destination"] == ["44", 1]  # 首尾帧 masks 为底
    assert comp["inputs"]["source"] == ["51", 0]
    assert comp["inputs"]["operation"] == "multiply"
    assert g["10"]["inputs"]["input_masks"] == ["52", 0]
    assert g["10"]["inputs"]["input_frames"] == ["44", 0]  # 首尾帧图像支路不受影响


def test_vace_without_motion_mask_unchanged():
    """不给 motion_mask:无 50/51/52 节点,input_masks 缺省(行为与此前一致)。"""
    g = build_wan_vace_graph(WanVaceParams(positive="x", ref_images=("r1.png",), seed=1))
    assert "50" not in g and "51" not in g and "52" not in g
    assert "input_masks" not in g["10"]["inputs"]
