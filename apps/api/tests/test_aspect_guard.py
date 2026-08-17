"""宽高比安全域(T-AR,2026-08-17):生成内容宽高超出模型训练分布会出主体被裁/文字溢出。

三层防线同一套规则(保长边、抬短边、step 对齐):
  · workflows/model_profiles.clamp_aspect_ratio —— 纯函数
  · 各视频/图像请求模型 aspect_guard —— pydantic mode="after" 静默归一
  · fit_resolution —— 图像像素档计算前先收敛比例到 AR_IMAGE
"""
from app.routes.avatar_studio import AvatarTalkRequest
from app.routes.generate import Txt2ImgRequest
from app.routes.h3_studio import H3T2VRequest
from app.routes.longcat_studio import LongCatT2VRequest
from app.routes.ltx25_studio import Ltx25T2VRequest
from app.routes.video import LtxT2VRequest, WanI2VRequest
from app.routes.wan_studio import WanAnimateRequest, WanVaceRequest
from app.workflows.model_profiles import (
    AR_IMAGE,
    AR_VIDEO,
    clamp_aspect_ratio,
    fit_resolution,
)

V = AR_VIDEO
I = AR_IMAGE


# ---------- 纯函数 ----------

def test_clamp_overwide_raises_short_side():
    """过宽(1920×256,7.5:1)→ 高抬到 1088,比例回落 16:9 内。"""
    w, h = clamp_aspect_ratio(1920, 256, lo=V[0], hi=V[1], align=32, min_v=256, max_v=1920)
    assert (w, h) == (1920, 1088)
    assert V[0] <= w / h <= V[1]


def test_clamp_overtall_raises_short_side():
    """过高(320×1280,1:4)→ 宽抬到 720,比例 9:16。"""
    w, h = clamp_aspect_ratio(320, 1280, lo=V[0], hi=V[1], align=16, min_v=320, max_v=1280)
    assert (w, h) == (720, 1280)


def test_clamp_image_bounds():
    """图像 1:2~2:1:2048×64 → 高抬 1024;合规 1:1 原样。"""
    assert clamp_aspect_ratio(2048, 64, lo=I[0], hi=I[1], align=8, min_v=64, max_v=2048) == (2048, 1024)
    assert clamp_aspect_ratio(1024, 1024, lo=I[0], hi=I[1], align=8, min_v=64, max_v=2048) == (1024, 1024)


def test_clamp_input_out_of_range_snapped():
    """输入越界先夹回 [min_v, max_v] 再判比例。"""
    w, h = clamp_aspect_ratio(9999, 300, lo=V[0], hi=V[1], align=8, min_v=128, max_v=1280)
    assert w == 1280
    assert V[0] <= w / h <= V[1]


# ---------- 请求模型守卫(各引擎) ----------

def _mk(model, **kw):
    base = dict(positive="x")
    base.update(kw)
    return model(**base)


def test_ltx25_request_guard():
    r = _mk(Ltx25T2VRequest, width=1920, height=256)
    assert (r.width, r.height) == (1920, 1088)


def test_h3_request_guard():
    r = _mk(H3T2VRequest, width=1344, height=256)
    assert (r.width, r.height) == (1344, 768)


def test_longcat_request_guard():
    r = _mk(LongCatT2VRequest, width=320, height=1280)
    assert (r.width, r.height) == (720, 1280)


def test_wan_models_guard():
    anim = WanAnimateRequest(
        positive="x", image="a.png", video="b.mp4", worker="w", width=1280, height=320
    )
    assert (anim.width, anim.height) == (1280, 720)
    vace = WanVaceRequest(positive="x", images=["a.png"], worker="w", width=320, height=1280)
    assert (vace.width, vace.height) == (720, 1280)


def test_avatar_request_guard():
    r = AvatarTalkRequest(
        image="a.png", audio="a.wav", worker="w", positive="x", width=1280, height=320
    )
    assert (r.width, r.height) == (1280, 720)


def test_video_generic_models_guard():
    """video.py:WanI2V(wan-nsfw)与 LtxT2V(LTX2.3)双守卫。"""
    wan = WanI2VRequest(positive="x", image="a.png", worker="w", width=1280, height=128)
    assert (wan.width, wan.height) == (1280, 720)
    ltx = LtxT2VRequest(positive="x", width=1920, height=256)
    assert (ltx.width, ltx.height) == (1920, 1080)


def test_txt2img_request_guard():
    r = _mk(Txt2ImgRequest, width=2048, height=64)
    assert (r.width, r.height) == (2048, 1024)
    ok = _mk(Txt2ImgRequest, width=1024, height=1024)
    assert (ok.width, ok.height) == (1024, 1024)


# ---------- fit_resolution 比例收敛 ----------

def test_fit_resolution_clamps_extreme_ratio():
    """SDXL 2048×128(16:1)→ 比例先收敛 2:1,再按 1MP 预算出像素。"""
    w, h = fit_resolution("ponyDiffusionV6XL_v6.safetensors", 2048, 128)
    assert w / h <= 2.0 + 1e-9
    assert w * h <= 1024 * 1024 + 8 * 2048  # ~1MP(对齐余量)


def test_fit_resolution_normal_ratio_untouched():
    """合规 16:9 比例行为不变(回归保护)。"""
    w, h = fit_resolution("ponyDiffusionV6XL_v6.safetensors", 1344, 768)
    assert abs(w / h - 1344 / 768) < 0.02
