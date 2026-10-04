"""管线 C 多候选选优：裁脸相似度优先，疑似烧录字幕/乱码降权。

insightface / cv2 可用时走真评分。选优失败必须抛 CandidatePickError，
禁止静默回落首候选（掩盖假选优）。OCR 可选。
连贯分：奖励贴近上一镜末帧/场景参考；扣「与镜0首帧过像」的回退候选。
"""
from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# 13:20：CLIP/人脸门禁缺依赖或不出分 → 一律「未通过-需复核」，禁止空分放行
GATE_NEEDS_REVIEW = "未通过-需复核"


from app.services.studio.scene_gate import SceneGateError, gate_video


class CandidatePickError(RuntimeError):
    """选优不可用或全部候选无法评分时抛出；调用方应标 shot 失败，禁止静默回落。"""

_FACE_APP = None


def _get_face_app():
    """复用 FaceAnalysis，避免每次选优重新加载 buffalo_l 堵死 API。"""
    global _FACE_APP
    if _FACE_APP is not None:
        return _FACE_APP
    from insightface.app import FaceAnalysis
    import os

    root = os.environ.get("INSIGHTFACE_HOME") or os.path.expanduser("~/.insightface")
    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"], root=root)
    app.prepare(ctx_id=-1, det_size=(640, 640))
    _FACE_APP = app
    return app


def _try_import_face():
    try:
        import cv2  # noqa: F401
        from insightface.app import FaceAnalysis  # noqa: F401
        return True
    except Exception:
        return False


def _burnin_penalty(frame_bgr) -> float:
    """粗检画面下方字幕带：高对比边缘过多 → 疑似烧录字，返回 0~0.3 罚分。"""
    try:
        import cv2
        import numpy as np
    except Exception:
        return 0.0
    h, w = frame_bgr.shape[:2]
    band = frame_bgr[int(h * 0.72) : h, int(w * 0.1) : int(w * 0.9)]
    if band.size == 0:
        return 0.0
    gray = cv2.cvtColor(band, cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 80, 160)
    # 7-Eleven 类橙/绿/红横色带：只记录不扣分 → 色带行(±2)边缘不计入烧录字密度
    rows = _color_band_rows(band)
    if rows:
        keep = np.ones(edges.shape[0], dtype=bool)
        for r in rows:
            keep[max(0, r - 2) : r + 3] = False
        edges = edges[keep] if keep.any() else edges[:0]
        if edges.size == 0:
            return 0.0
    density = float(edges.mean()) / 255.0
    # 经验：正常画面下方 edge 均值通常 <0.08；字幕带常 >0.12
    if density < 0.08:
        return 0.0
    return min(0.3, (density - 0.08) * 2.0)


# 连锁店招横色带（7-Eleven 橙/绿/红条）：仅记录，任何门禁/打分都不扣分
CHAIN_BAND_MIN_ROW_FRAC = 0.35  # 该行该色相饱和像素占比
CHAIN_BAND_MIN_COLORS = 2  # 至少两种色相条纹相邻出现
_CHAIN_BAND_HUES = {
    "red": ((0, 6), (170, 180)),
    "orange": ((7, 22),),
    "green": ((40, 90),),
}


def _color_band_rows_by_hue(frame_bgr) -> dict[str, list[int]]:
    try:
        import cv2
        import numpy as np
    except Exception:
        return {}
    if frame_bgr is None or getattr(frame_bgr, "size", 0) == 0:
        return {}
    hsv = cv2.cvtColor(frame_bgr, cv2.COLOR_BGR2HSV)
    hch, sch, vch = hsv[..., 0], hsv[..., 1], hsv[..., 2]
    sat = (sch >= 120) & (vch >= 90)
    out: dict[str, list[int]] = {}
    for name, ranges in _CHAIN_BAND_HUES.items():
        m = np.zeros(hch.shape, dtype=bool)
        for lo, hi in ranges:
            m |= (hch >= lo) & (hch <= hi)
        frac = (m & sat).mean(axis=1)
        rows = [int(i) for i in np.nonzero(frac >= CHAIN_BAND_MIN_ROW_FRAC)[0]]
        if rows:
            out[name] = rows
    return out


def _color_band_rows(frame_bgr) -> list[int]:
    by = _color_band_rows_by_hue(frame_bgr)
    if len(by) < CHAIN_BAND_MIN_COLORS:
        return []
    return sorted({r for rows in by.values() for r in rows})


def chain_color_band_frame(frame_bgr) -> dict[str, Any]:
    """检测连锁店横色带（橙/绿/红条，7-Eleven 型）。仅用于日志：hit 不拦、不扣分。"""
    by = _color_band_rows_by_hue(frame_bgr)
    hit = len(by) >= CHAIN_BAND_MIN_COLORS
    return {
        "hit": hit,
        "colors": sorted(by),
        "rows": {k: [min(v), max(v)] for k, v in by.items()},
        "penalty": 0.0,
    }


def _ocr_penalty(frame_bgr) -> float:
    """选优用字幕罚分：与出片字幕门禁同口径（subtitle_ocr_frame：底部带、conf≥60、CJK≥4、够宽、居中）。

    旧实现对底部带 image_to_string 任意 ≥2 字符即罚 0.5，雨夜湿地反光/霓虹噪声常被读成乱码
    （shot0 候选3 因此 pick_score -0.07）。现仅真实字幕行才罚 0.5。
    """
    try:
        r = subtitle_ocr_frame(frame_bgr)
    except Exception:
        return 0.0
    return 0.5 if r.get("hit") else 0.0


def score_scene_continuity(
    video_path: str | Path,
    prev_video_path: str | Path | None,
    *,
    scene_ref_path: str | Path | None = None,
    regression_ref_path: str | Path | None = None,
) -> dict[str, Any]:
    """与上一镜末帧 / 场景参考图的画面相近度（0~1），用于抑制场景回退。

    regression_ref_path：镜0（或锚点）视频；与其首帧过像时写入 regression 罚分
    （0~1，越高越像回退）。用 HSV 直方图相关，不依赖 insightface。
    """
    out: dict[str, Any] = {"continuity": None, "regression": None, "error": ""}
    try:
        import cv2
        import numpy as np
    except Exception:
        out["error"] = "cv2 不可用"
        return out

    def _hist(img_bgr):
        hsv = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2HSV)
        hist = cv2.calcHist([hsv], [0, 1], None, [32, 32], [0, 180, 0, 256])
        cv2.normalize(hist, hist)
        return hist

    def _frame_at(path: Path, at: str):
        cap = cv2.VideoCapture(str(path))
        if not cap.isOpened():
            return None
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if at == "first":
            cap.set(cv2.CAP_PROP_POS_FRAMES, 0)
        else:
            cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, n - 1))
        ok, frame = cap.read()
        cap.release()
        return frame if ok else None

    refs = []
    if prev_video_path and Path(prev_video_path).is_file():
        fr = _frame_at(Path(prev_video_path), "last")
        if fr is not None:
            refs.append(fr)
    if scene_ref_path and Path(scene_ref_path).is_file():
        img = cv2.imread(str(scene_ref_path))
        if img is not None:
            refs.append(img)
    if not refs:
        out["error"] = "无上一镜或场景参考"
        return out
    cur = _frame_at(Path(video_path), "first")
    if cur is None:
        # 视频读首帧失败时再试中帧
        cur = _frame_at(Path(video_path), "last")
    if cur is None:
        out["error"] = "候选视频读帧失败"
        return out
    h0 = _hist(cur)
    scores = []
    for r in refs:
        corr = float(cv2.compareHist(h0, _hist(r), cv2.HISTCMP_CORREL))
        scores.append(max(0.0, min(1.0, (corr + 1.0) / 2.0)))  # [-1,1] -> [0,1]
    out["continuity"] = float(sum(scores) / len(scores))

    # 与镜0首帧过像 → regression 罚分（抑制场景回退到开场）
    if regression_ref_path and Path(regression_ref_path).is_file():
        reg_fr = _frame_at(Path(regression_ref_path), "first")
        if reg_fr is not None:
            corr = float(cv2.compareHist(h0, _hist(reg_fr), cv2.HISTCMP_CORREL))
            # [-1,1] -> [0,1]；越高越像镜0
            out["regression"] = float(max(0.0, min(1.0, (corr + 1.0) / 2.0)))
    return out


def _upper_body_crop_bgr(frame_bgr):
    """上半身/头肩裁剪：顶部 60% × 水平居中 80%，供动漫 CLIP 相似度。"""
    h, w = frame_bgr.shape[:2]
    y2 = max(1, int(h * 0.60))
    x1 = int(w * 0.10)
    x2 = max(x1 + 1, int(w * 0.90))
    return frame_bgr[0:y2, x1:x2]


def _cosine(a, b) -> float:
    import numpy as np

    aa = np.asarray(a, dtype=np.float32).reshape(-1)
    bb = np.asarray(b, dtype=np.float32).reshape(-1)
    denom = float(np.linalg.norm(aa) * np.linalg.norm(bb) + 1e-9)
    return float(np.dot(aa, bb) / denom)


def _openclip_image_embedder():
    """懒加载 CLIP 图像编码器：优先 open_clip（scene_gate 缓存），否则 transformers。"""
    try:
        import os
        import torch
        from PIL import Image
        from app.services.studio.scene_gate import _cached_openclip

        device = os.environ.get("TOIV_SCENE_GATE_DEVICE") or (
            "cuda:0" if torch.cuda.is_available() else "cpu"
        )
        if str(device).endswith(":3"):
            device = "cpu"
        model_name = os.environ.get("TOIV_OPENCLIP_MODEL") or "ViT-B-32"
        model, preprocess, _tokenizer, device = _cached_openclip(
            device, model_name, "openai"
        )

        def _embed_oc(pil_img: "Image.Image"):
            import torch as _torch

            t = preprocess(pil_img.convert("RGB")).unsqueeze(0).to(device)
            with _torch.no_grad():
                feat = model.encode_image(t)
                feat = feat / feat.norm(dim=-1, keepdim=True)
            return feat.squeeze(0).detach().float().cpu().numpy()

        return _embed_oc
    except Exception as e:
        logger.info("open_clip 不可用，尝试 transformers CLIP: %s", e)

    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor

        name = os.environ.get("TOIV_TRANSFORMERS_CLIP") or (
            "/mnt/toiv-nas/toiv/comfyui-code/models/clip/clip-vit-large-patch14"
            if __import__("pathlib").Path(
                "/mnt/toiv-nas/toiv/comfyui-code/models/clip/clip-vit-large-patch14"
            ).is_dir()
            else "openai/clip-vit-base-patch32"
        )
        model = CLIPModel.from_pretrained(name, local_files_only=("openai/" not in str(name)))
        proc = CLIPProcessor.from_pretrained(name, local_files_only=("openai/" not in str(name)))
        model.eval()

        def _embed_hf(pil_img: "Image.Image"):
            import torch as _torch

            inputs = proc(images=pil_img.convert("RGB"), return_tensors="pt")
            with _torch.no_grad():
                vision = model.vision_model(pixel_values=inputs["pixel_values"])
                feat = model.visual_projection(vision.pooler_output)
                feat = feat / feat.norm(dim=-1, keepdim=True)
            return feat.squeeze(0).detach().float().cpu().numpy()

        return _embed_hf
    except Exception as e:
        logger.info("transformers CLIP 不可用，动漫脸 CLIP 跳过: %s", e)
        return None


def score_video_face_clip(
    video_path: str | Path,
    ref_image_path: str | Path,
    *,
    embedder=None,
) -> dict[str, Any]:
    """动漫镜人脸分：CLIP 图像相似度（参考图上半身 vs 出片上半身裁剪均值）。

    参考图 insightface 检不出脸时必须走此路径，禁止空分放行。
    embedder: 可选 (PIL.Image)->1d vector，单测注入；默认 open_clip ViT-L/14。
    """
    out: dict[str, Any] = {
        "face_mean": None,
        "sims": [],
        "burnin_penalty": 0.0,
        "ocr_penalty": 0.0,
        "error": "",
        "score_backend": "clip",
    }
    try:
        import cv2
        import numpy as np
        from PIL import Image
    except Exception:
        out["error"] = "cv2/PIL 不可用"
        return out

    ref_p = Path(ref_image_path)
    vid_p = Path(video_path)
    if not ref_p.is_file() or not vid_p.is_file():
        out["error"] = "参考图或视频不存在"
        return out

    enc = embedder if embedder is not None else _openclip_image_embedder()
    if enc is None:
        out["error"] = "open_clip 不可用"
        out["gate_status"] = GATE_NEEDS_REVIEW
        out["pass"] = False
        return out

    ref_bgr = cv2.imread(str(ref_p))
    if ref_bgr is None:
        out["error"] = "参考图读取失败"
        return out
    ref_crop = _upper_body_crop_bgr(ref_bgr)
    ref_pil = Image.fromarray(cv2.cvtColor(ref_crop, cv2.COLOR_BGR2RGB))
    try:
        ref_emb = enc(ref_pil)
    except Exception as e:
        out["error"] = f"CLIP 参考编码失败:{e}"
        return out

    cap = cv2.VideoCapture(str(vid_p))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if n <= 1:
        idxs = [0]
    else:
        idxs = sorted(
            {
                max(0, min(n - 1, int(round(x))))
                for x in [0, n * 0.15, n * 0.35, n // 2, n * 0.65, n * 0.85, n - 1]
            }
        )
    sims: list[float] = []
    burn = 0.0
    ocr = 0.0
    frames_ok = 0
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        frames_ok += 1
        burn = max(burn, _burnin_penalty(frame))
        ocr = max(ocr, _ocr_penalty(frame))
        crop = _upper_body_crop_bgr(frame)
        pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        try:
            emb = enc(pil)
            sims.append(_cosine(ref_emb, emb))
        except Exception:
            continue
    cap.release()
    out["sims"] = sims
    out["burnin_penalty"] = burn
    out["ocr_penalty"] = ocr
    out["frames_sampled"] = frames_ok
    if sims:
        out["face_mean"] = float(sum(sims) / len(sims))
    elif frames_ok > 0:
        out["error"] = "CLIP 帧编码失败"
    else:
        out["error"] = "视频帧读取失败"
    return out



def _identity_crop_bgr(frame_bgr):
    """优先裁检测到的脸（扩边），否则上半身；供相对身份门禁用。"""
    try:
        if _try_import_face():
            app = _get_face_app()
            faces = app.get(frame_bgr)
            if faces:
                face = sorted(
                    faces,
                    key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                    reverse=True,
                )[0]
                x1, y1, x2, y2 = [int(v) for v in face.bbox]
                h, w = frame_bgr.shape[:2]
                bw, bh = x2 - x1, y2 - y1
                # 扩到含上半身肩线
                pad_x = int(bw * 0.35)
                pad_y_top = int(bh * 0.45)
                pad_y_bot = int(bh * 1.2)
                xa = max(0, x1 - pad_x)
                xb = min(w, x2 + pad_x)
                ya = max(0, y1 - pad_y_top)
                yb = min(h, y2 + pad_y_bot)
                if xb > xa + 8 and yb > ya + 8:
                    return frame_bgr[ya:yb, xa:xb]
    except Exception:
        pass
    return _upper_body_crop_bgr(frame_bgr)


def score_clip_identity_relative(
    video_path: str | Path,
    ref_image_path: str | Path,
    negative_ref_paths: list[str | Path] | None = None,
    *,
    margin: float = 0.03,
    embedder=None,
) -> dict[str, Any]:
    """相对身份门禁：对本角色参考的相似度须 ≥ 对负样本参考最高分 + margin。

    先裁脸/上半身再算 CLIP；返回 face_mean（对本角色）、neg_max、margin、pass。
    """
    out: dict[str, Any] = {
        "face_mean": None,
        "neg_max": None,
        "margin": float(margin),
        "pass": False,
        "sims": [],
        "neg_scores": {},
        "burnin_penalty": 0.0,
        "ocr_penalty": 0.0,
        "error": "",
        "score_backend": "clip_relative",
        "gate_status": "",
    }
    try:
        import cv2
        from PIL import Image
    except Exception:
        out["error"] = "cv2/PIL 不可用"
        out["gate_status"] = GATE_NEEDS_REVIEW
        return out

    ref_p = Path(ref_image_path)
    vid_p = Path(video_path)
    if not ref_p.is_file() or not vid_p.is_file():
        out["error"] = "参考图或视频不存在"
        out["gate_status"] = GATE_NEEDS_REVIEW
        return out

    enc = embedder if embedder is not None else _openclip_image_embedder()
    if enc is None:
        out["error"] = "open_clip 不可用"
        out["gate_status"] = GATE_NEEDS_REVIEW
        out["pass"] = False
        return out

    def _emb_path(p: Path):
        bgr = cv2.imread(str(p))
        if bgr is None:
            return None
        # 动漫 CLIP：统一上半身裁（insightface 裁脸会把 1052/立绘排序打乱）
        crop = _upper_body_crop_bgr(bgr)
        pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        return enc(pil)

    try:
        ref_emb = _emb_path(ref_p)
    except Exception as e:
        out["error"] = f"CLIP 参考编码失败:{e}"
        out["gate_status"] = GATE_NEEDS_REVIEW
        return out
    if ref_emb is None:
        out["error"] = "参考图读取失败"
        out["gate_status"] = GATE_NEEDS_REVIEW
        return out

    neg_embs: dict[str, Any] = {}
    for raw in negative_ref_paths or []:
        npth = Path(raw)
        if not npth.is_file():
            continue
        try:
            e = _emb_path(npth)
        except Exception:
            continue
        if e is not None:
            neg_embs[str(npth)] = e

    cap = cv2.VideoCapture(str(vid_p))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    if n <= 1:
        idxs = [0]
    else:
        idxs = sorted(
            {
                max(0, min(n - 1, int(round(x))))
                for x in [0, n * 0.15, n * 0.35, n // 2, n * 0.65, n * 0.85, n - 1]
            }
        )
    self_sims: list[float] = []
    neg_acc: dict[str, list[float]] = {k: [] for k in neg_embs}
    burn = 0.0
    ocr = 0.0
    frames_ok = 0
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        frames_ok += 1
        burn = max(burn, _burnin_penalty(frame))
        ocr = max(ocr, _ocr_penalty(frame))
        crop = _upper_body_crop_bgr(frame)
        pil = Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))
        try:
            emb = enc(pil)
        except Exception:
            continue
        self_sims.append(_cosine(ref_emb, emb))
        for k, ne in neg_embs.items():
            neg_acc[k].append(_cosine(ne, emb))
    cap.release()

    out["sims"] = self_sims
    out["burnin_penalty"] = burn
    out["ocr_penalty"] = ocr
    out["frames_sampled"] = frames_ok
    if not self_sims:
        out["error"] = "CLIP 帧编码失败" if frames_ok else "视频帧读取失败"
        out["gate_status"] = GATE_NEEDS_REVIEW
        out["pass"] = False
        return out

    face_mean = float(sum(self_sims) / len(self_sims))
    out["face_mean"] = face_mean
    neg_means = {
        k: float(sum(vs) / len(vs)) for k, vs in neg_acc.items() if vs
    }
    out["neg_scores"] = neg_means
    neg_max = max(neg_means.values()) if neg_means else None
    out["neg_max"] = neg_max
    if neg_max is None:
        # 无负样本时无法相对判定 → 需复核（禁止仅靠绝对阈值）
        out["error"] = "无负样本参考，相对门禁无法判定"
        out["gate_status"] = GATE_NEEDS_REVIEW
        out["pass"] = False
        return out
    ok_rel = face_mean >= float(neg_max) + float(margin)
    out["pass"] = bool(ok_rel)
    out["relative_delta"] = float(face_mean - float(neg_max))
    if not ok_rel:
        out["gate_status"] = GATE_NEEDS_REVIEW
        out["error"] = (
            f"相对门禁未过:self={face_mean:.3f} neg_max={neg_max:.3f} "
            f"需≥+{margin:.2f}"
        )
    return out


# 写实选优：线上 face 与 facecrop（实验口径：pad0.35→放大≥512→重嵌入，仅正/3/4 侧）取 min 排序与门禁。
# 单看线上均值会被「少量大脸特写帧」抬高（雨夜 shot0 候选2：online 0.563 / facecrop 0.129）。
FACE_RANK_MIN_DEFAULT = 0.40


def _yaw_from_kps(kps) -> float | None:
    import numpy as np

    if kps is None or len(kps) < 3:
        return None
    le, re_, nose = kps[0], kps[1], kps[2]
    off = (nose[0] - 0.5 * (le[0] + re_[0])) / (abs(re_[0] - le[0]) + 1e-6)
    return float(np.clip(off, -1.5, 1.5) * 60.0)


def _pose_label(yaw: float | None) -> str:
    if yaw is None:
        return "unknown"
    a = abs(yaw)
    return "front" if a <= 25 else "three_quarter" if a <= 55 else "side" if a <= 80 else "backish"


def _crop_up(img, bbox, min_side: int = 512, pad: float = 0.35):
    import cv2

    h, w = img.shape[:2]
    x1, y1, x2, y2 = [float(v) for v in bbox]
    side = max(x2 - x1, y2 - y1) * (1 + pad)
    cx, cy = (x1 + x2) / 2, (y1 + y2) / 2
    c = img[max(0, int(cy - side / 2)):min(h, int(cy + side / 2)),
            max(0, int(cx - side / 2)):min(w, int(cx + side / 2))]
    if c.size == 0:
        return None
    ch, cw = c.shape[:2]
    if min(ch, cw) < min_side:
        sc = min_side / max(1, min(ch, cw))
        c = cv2.resize(c, (max(min_side, int(cw * sc)), max(min_side, int(ch * sc))),
                       interpolation=cv2.INTER_CUBIC)
    return c


def _want_clip_face(mode: str, ref_style: str | None) -> bool:
    m = (mode or "auto").strip().lower()
    if m == "clip":
        return True
    if m == "insightface":
        return False
    st = (ref_style or "").strip().lower()
    return st in ("anime", "二次元", "动漫", "cartoon")


def score_video_face(
    video_path: str | Path,
    ref_image_path: str | Path,
    *,
    mode: str = "auto",
    ref_style: str | None = None,
    clip_embedder=None,
    skip_until_frame: int = 0,
    with_facecrop: bool = False,
) -> dict[str, Any]:
    """对视频帧与参考脸算相似度均值；失败返回 face_mean=None。

    skip_until_frame>0：首帧锚定（c_hybrid）第 0..N 帧不评分（那是 first_frame 本身）。
    with_facecrop（仅 InsightFace）：同采样帧再算 facecrop_mean（实验口径，正/3/4 侧才计分）。

    mode:
      - insightface：仅 InsightFace（写实）
      - clip：仅 CLIP 上半身图相似（动漫）
      - auto：动漫风格走 CLIP；否则 InsightFace，参考图无脸时回退 CLIP（禁止空分放行）
    """
    if _want_clip_face(mode, ref_style):
        return score_video_face_clip(
            video_path, ref_image_path, embedder=clip_embedder
        )

    out: dict[str, Any] = {
        "face_mean": None,
        "sims": [],
        "burnin_penalty": 0.0,
        "ocr_penalty": 0.0,
        "error": "",
        "score_backend": "insightface",
    }
    if not _try_import_face():
        # 无 insightface 时仍尝试 CLIP，避免空分
        clip_out = score_video_face_clip(
            video_path, ref_image_path, embedder=clip_embedder
        )
        if clip_out.get("face_mean") is not None:
            return clip_out
        out["error"] = "insightface/cv2 不可用"
        return out
    import cv2
    import numpy as np

    ref_p = Path(ref_image_path)
    vid_p = Path(video_path)
    if not ref_p.is_file() or not vid_p.is_file():
        out["error"] = "参考图或视频不存在"
        return out

    try:
        app = _get_face_app()
    except Exception as e:
        out["error"] = f"FaceAnalysis 初始化失败:{e}"
        return out
    ref_img = cv2.imread(str(ref_p))
    if ref_img is None:
        out["error"] = "参考图读取失败"
        return out
    faces = app.get(ref_img)
    if not faces:
        # 12:48：参考图检不出脸不得空分放行 → CLIP
        clip_out = score_video_face_clip(
            video_path, ref_image_path, embedder=clip_embedder
        )
        if clip_out.get("face_mean") is not None or clip_out.get("error"):
            clip_out.setdefault("score_backend", "clip")
            clip_out["fallback_from"] = "insightface_no_ref_face"
            return clip_out
        out["error"] = "参考图未检测到脸"
        return out
    ref_emb = sorted(
        faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True
    )[0].normed_embedding

    cap = cv2.VideoCapture(str(vid_p))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    # 密采样：避免只踩到手部特写帧导致 face_mean=null（雨夜镜1 v2 候选2）
    if n <= 1:
        idxs = [0]
    else:
        idxs = sorted({max(0, min(n - 1, int(round(x)))) for x in [
            0, n * 0.15, n * 0.35, n // 2, n * 0.65, n * 0.85, n - 1
        ]})
    skip = max(0, int(skip_until_frame or 0))
    if skip > 0:
        idxs = [i for i in idxs if i > skip] or [max(0, n - 1)]
        out["skip_until_frame"] = skip
    fc_sims: list[float] = []
    fc_poses: list[str] = []
    sims: list[float] = []
    burn = 0.0
    ocr = 0.0
    frames_ok = 0
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
        frames_ok += 1
        burn = max(burn, _burnin_penalty(frame))
        ocr = max(ocr, _ocr_penalty(frame))
        fl = app.get(frame)
        if not fl:
            continue
        face = sorted(
            fl, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True
        )[0]
        emb = face.normed_embedding.astype(np.float32)
        r = ref_emb.astype(np.float32)
        sim = float(np.dot(r, emb) / (np.linalg.norm(r) * np.linalg.norm(emb) + 1e-9))
        sims.append(sim)
        if with_facecrop:
            pose = _pose_label(_yaw_from_kps(getattr(face, "kps", None)))
            fc_poses.append(pose)
            if pose in ("front", "three_quarter"):
                emb2 = emb
                crop = _crop_up(frame, face.bbox)
                if crop is not None:
                    cf = app.get(crop)
                    if cf:
                        emb2 = sorted(
                            cf, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]),
                            reverse=True,
                        )[0].normed_embedding.astype(np.float32)
                fc_sims.append(
                    float(np.dot(r, emb2) / (np.linalg.norm(r) * np.linalg.norm(emb2) + 1e-9))
                )
    cap.release()
    if with_facecrop:
        out["facecrop_sims"] = fc_sims
        out["facecrop_poses"] = fc_poses
        out["facecrop_mean"] = float(sum(fc_sims) / len(fc_sims)) if fc_sims else None
    out["sims"] = sims
    out["burnin_penalty"] = burn
    out["ocr_penalty"] = ocr
    out["frames_sampled"] = frames_ok
    if sims:
        out["face_mean"] = float(sum(sims) / len(sims))
    elif frames_ok > 0:
        out["error"] = "无人脸检出"
    else:
        out["error"] = "视频帧读取失败"
    return out


def pick_best_candidate(
    candidates: list[dict[str, Any]],
    *,
    ref_image_path: str | Path | None,
    local_url_resolver=None,
    prev_video_path: str | Path | None = None,
    scene_ref_path: str | Path | None = None,
    regression_ref_path: str | Path | None = None,
    continuity_weight: float = 0.25,
    regression_weight: float = 0.35,
    min_face_mean: float = 0.45,
    require_scene_gate: bool = False,
    scene_positive: str | None = None,
    scene_negatives: list[str] | None = None,
    scene_gate_fn=None,
    face_score_mode: str = "auto",
    ref_style: str | None = None,
    clip_embedder=None,
    negative_ref_paths: list[str | Path] | None = None,
    relative_margin: float = 0.03,
    use_relative_identity: bool | None = None,
    min_face_rank: float = FACE_RANK_MIN_DEFAULT,
    hard_cut_rule: bool = True,
    text_gate: bool = True,
    hood_log: bool = True,
) -> tuple[str | None, list[dict[str, Any]]]:
    """按 face_mean - burnin - ocr + 连贯加分 - 回退罚分 选优。

    选优失败抛 CandidatePickError（禁止静默回落首候选）。
    regression_ref_path：通常为镜0成片，扣「与开场过像」的回退候选。
    min_face_mean：人脸门禁（默认 0.45；动漫 CLIP 建议 0.60）；face_mean 为空或低于门禁的候选不得入选。
    face_score_mode / ref_style：动漫走 CLIP 图相似，参考图无脸禁止空分放行。
    写实 InsightFace：face_rank=min(线上 face_mean, facecrop_mean) 参与打分与门禁（≥min_face_rank），
    不单看线上均值；候选带 first_frame（c_hybrid 锚定）时第 0..ANCHORED_FIRST_FRAME_SKIP_FRAMES 帧不评分。
    hard_cut_rule（默认开，见 hard_cut.py）：锚定区内/首 1 秒内硬切 → 自动裁片头（音频同步裁），
    候选 url 换成裁后文件并写 head_trim；1 秒后硬切按 hard_cut_penalty 扣分。
    店招/连锁色带只记录不扣分。
    text_gate（默认开）：选优也跑出片文字门禁 garment_brand_ocr_hit（字幕 / 衣物品牌字，RapidOCR+tesseract），
    命中的候选不得入选（此前只在出片后换 seed 路径跑，选优/重选时不查）。
    hood_log（默认开，仅记录）：帽兜状态逐帧与上一镜尾帧对比写 hood_log，不拦不扣分。
    硬切门禁（随 hard_cut_rule）：裁片头后仍有 ≥HARD_CUT_INELIGIBLE_MIN(2) 处镜内硬切的候选
    写 cut_gate.blocked，不得入选；全部被拦（文字/硬切）则抛 CandidatePickError。
    """
    done = [c for c in candidates if c.get("status") == "done" and c.get("url")]
    if not done:
        raise CandidatePickError("无成功候选可评分")

    def _local(url: str) -> Path | None:
        if local_url_resolver is not None:
            try:
                p = local_url_resolver(url)
                if p:
                    return Path(p)
            except Exception:
                return None
        p = Path(url)
        return p if p.is_file() else None

    want_clip = _want_clip_face(face_score_mode, ref_style)
    # CLIP 路径不依赖 insightface；insightface 路径仍可在无脸时回退 CLIP
    face_ok = bool(
        ref_image_path
        and Path(ref_image_path).is_file()
        and (want_clip or _try_import_face() or clip_embedder is not None)
    )
    have_cont_material = bool(prev_video_path or scene_ref_path)

    if not face_ok and not have_cont_material:
        for c in candidates:
            c["is_picked"] = False
            c.setdefault("pick_score", None)
            c["pick_note"] = "face_scorer_unavailable"
        for c in candidates:
            c["gate_status"] = GATE_NEEDS_REVIEW
        raise CandidatePickError(
            f"选优失败:人脸评分不可用且无连贯材料，{GATE_NEEDS_REVIEW}，禁止静默回落首候选"
        )

    def _text_blocked(c: dict[str, Any]) -> bool:
        return bool((c.get("text_gate") or {}).get("hit"))

    def _cut_blocked(c: dict[str, Any]) -> bool:
        return bool((c.get("cut_gate") or {}).get("blocked"))

    def _blocked(c: dict[str, Any]) -> bool:
        return _text_blocked(c) or _cut_blocked(c)

    try:
        best_id = None
        best_score = float("-inf")
        scored_any = False
        for c in done:
            path = _local(str(c["url"]))
            if path is None:
                c["pick_score"] = None
                c["pick_note"] = "video_path_unresolved"
                c["face_mean"] = None
                continue
            face = None
            pen = 0.0
            note_parts: list[str] = []
            anchored = bool(str(c.get("first_frame") or "").strip())
            skip_frames = ANCHORED_FIRST_FRAME_SKIP_FRAMES if anchored else 0
            cut_pen = 0.0
            if hard_cut_rule:
                from app.services.studio.hard_cut import apply_hard_cut_rule

                try:
                    hc = apply_hard_cut_rule(c, path, anchor_frames=skip_frames)
                except Exception as e:  # noqa: BLE001  规则异常不拦选优，只记
                    c["hard_cut_detect"] = {"error": f"{type(e).__name__}:{e}"[:200]}
                else:
                    path = Path(hc["path"])
                    cut_pen = float(hc["penalty"] or 0.0)
                    skip_frames = int(hc["skip_until_frame"])
                    if c.get("head_trim"):
                        note_parts.append(f"head_trim={c['head_trim']['frames']}f")
                    if cut_pen:
                        note_parts.append(f"late_cuts={len(c.get('hard_cut_late') or [])}")
                    from app.services.studio.hard_cut import HARD_CUT_INELIGIBLE_MIN

                    n_late = len(c.get("hard_cut_late") or [])
                    c["cut_gate"] = {
                        "blocked": n_late >= HARD_CUT_INELIGIBLE_MIN,
                        "late_cuts": n_late,
                        "min": HARD_CUT_INELIGIBLE_MIN,
                    }
                    if n_late >= HARD_CUT_INELIGIBLE_MIN:
                        c["gate_status"] = GATE_NEEDS_REVIEW
                        note_parts.append(f"cut_gate={n_late}cuts")
            if text_gate:
                try:
                    tg = garment_brand_ocr_hit(path, skip_until_frame=skip_frames)
                except Exception as e:  # noqa: BLE001
                    tg = {"hit": False, "error": f"{type(e).__name__}:{e}"[:200]}
                c["text_gate"] = {k: tg.get(k) for k in ("hit", "kind", "text", "frames_checked", "error")}
                if tg.get("brand_run"):
                    c["text_gate"]["brand_run"] = [
                        {"frame": r.get("frame"), "words": [w.get("text") for w in r.get("words") or []]}
                        for r in tg["brand_run"]
                    ]
                if tg.get("subtitle_run"):
                    c["text_gate"]["subtitle_run"] = [
                        {"frame": r.get("frame"), "text": r.get("text")} for r in tg["subtitle_run"]
                    ]
                if tg.get("hit"):
                    c["gate_status"] = GATE_NEEDS_REVIEW
                    note_parts.append(f"text_gate={tg.get('kind') or 'hit'}")
            if hood_log:
                try:
                    from app.services.studio.outfit_state import hood_state_log

                    c["hood_log"] = hood_state_log(
                        path, prev_video_path=prev_video_path, skip_until_frame=skip_frames
                    )
                except Exception as e:  # noqa: BLE001
                    c["hood_log"] = {"error": f"{type(e).__name__}:{e}"[:200], "log_only": True}
            if face_ok:
                m = score_video_face(
                    path,
                    ref_image_path,
                    mode=face_score_mode,
                    ref_style=ref_style,
                    clip_embedder=clip_embedder,
                    skip_until_frame=skip_frames,
                    with_facecrop=not want_clip,
                )
                face = m.get("face_mean")
                if anchored:
                    c["face_skip_until_frame"] = skip_frames
                if "facecrop_mean" in m and m.get("score_backend", "insightface") == "insightface":
                    # 写实：线上分与 facecrop 取 min，二者都须过线
                    fc = m.get("facecrop_mean")
                    c["online_face"] = face
                    c["facecrop_mean"] = fc
                    face_rank = min(float(face), float(fc)) if (face is not None and fc is not None) else None
                    c["face_rank"] = face_rank
                    c["face_rank_rule"] = "min(online,facecrop)"
                    face = face_rank
                pen = float(m.get("burnin_penalty") or 0) + float(m.get("ocr_penalty") or 0)
                c["face_mean"] = m.get("face_mean")
                c["burnin_penalty"] = m.get("burnin_penalty")
                c["ocr_penalty"] = m.get("ocr_penalty")
                c["face_score_backend"] = m.get("score_backend")
                note_parts.append(
                    (m.get("error") or m.get("score_backend") or "facecrop")
                )
            else:
                c["face_mean"] = None
                note_parts.append("continuity_only")

            cont_m = score_scene_continuity(
                path,
                prev_video_path,
                scene_ref_path=scene_ref_path,
                regression_ref_path=regression_ref_path,
            )
            cont = cont_m.get("continuity")
            reg = cont_m.get("regression")
            cont_bonus = float(cont) * float(continuity_weight) if cont is not None else 0.0
            reg_pen = float(reg) * float(regression_weight) if reg is not None else 0.0
            # 过像镜0 且连贯分也低时加重（典型：场景回退到门外）
            if reg is not None and cont is not None and float(reg) >= 0.7 and float(cont) <= 0.45:
                reg_pen = max(reg_pen, float(reg) * float(regression_weight) * 1.4)

            if face_ok:
                score = (float(face) if face is not None else -1.0) - pen + cont_bonus - reg_pen
                if face is None:
                    score = -2.0 - pen + cont_bonus - reg_pen
            else:
                score = (float(cont) if cont is not None else -1.0) - reg_pen
            score -= cut_pen

            c["continuity"] = cont
            c["regression"] = reg
            c["pick_score"] = score
            if cont is not None:
                note_parts.append(f"continuity={cont:.3f}")
            elif cont_m.get("error"):
                note_parts.append(f"continuity_skip:{cont_m.get('error')}")
            if reg is not None:
                note_parts.append(f"regression={reg:.3f}")
            c["pick_note"] = "+".join(note_parts) if note_parts else "scored"
            scored_any = True
            if score > best_score and not _blocked(c):
                best_score = score
                best_id = c.get("id")

        if scored_any and best_id is None and any(_blocked(c) for c in done):
            for c in candidates:
                c["is_picked"] = False
            hits = [f"{c.get('id')}:{(c.get('text_gate') or {}).get('text', '')[:40]}" for c in done if _text_blocked(c)]
            cuts = [f"{c.get('id')}:{(c.get('cut_gate') or {}).get('late_cuts')}处" for c in done if _cut_blocked(c)]
            if hits and not cuts:
                raise CandidatePickError(
                    f"选优失败:全部候选未过文字门禁(衣物品牌字/字幕) {hits}，{GATE_NEEDS_REVIEW}，禁止入选并应改提示词重跑"
                )
            raise CandidatePickError(
                f"选优失败:全部候选未过门禁 文字门禁={hits} 镜内硬切≥2={cuts}，{GATE_NEEDS_REVIEW}，禁止入选并应改提示词重跑"
            )
        if not scored_any or best_id is None:
            for c in candidates:
                c["is_picked"] = False
            raise CandidatePickError("选优失败:全部候选无法解析本地路径或评分")

        # 人脸门禁：动漫/CLIP 优先相对身份（对本角色 − 负样本最高 ≥ margin）；
        # 无负样本时回退绝对阈值（写实 insightface）。
        _rel = use_relative_identity
        if _rel is None:
            _rel = bool(want_clip and negative_ref_paths)
        if face_ok and _rel and negative_ref_paths:
            for c in done:
                path = _local(str(c["url"]))
                if path is None or ref_image_path is None:
                    c["relative_pass"] = False
                    continue
                rel = score_clip_identity_relative(
                    path,
                    ref_image_path,
                    list(negative_ref_paths),
                    margin=float(relative_margin),
                    embedder=clip_embedder,
                )
                c["face_mean"] = rel.get("face_mean", c.get("face_mean"))
                c["neg_max"] = rel.get("neg_max")
                c["relative_delta"] = rel.get("relative_delta")
                c["relative_pass"] = bool(rel.get("pass"))
                c["face_score_backend"] = rel.get("score_backend")
                note = str(c.get("pick_note") or "")
                delta = rel.get("relative_delta")
                tag = (
                    f"rel_delta={delta:.3f}"
                    if isinstance(delta, (int, float))
                    else "rel_fail"
                )
                c["pick_note"] = (note + "+" if note else "") + tag
                if not c["relative_pass"]:
                    c["gate_status"] = GATE_NEEDS_REVIEW
            gated = [
                c
                for c in done
                if c.get("relative_pass") and c.get("pick_score") is not None and not _blocked(c)
            ]
            if not gated:
                for c in candidates:
                    c["is_picked"] = False
                    note = str(c.get("pick_note") or "")
                    if "rel_gate" not in note:
                        c["pick_note"] = (note + "+" if note else "") + (
                            f"rel_gate<+{float(relative_margin):.2f}"
                        )
                    c["gate_status"] = GATE_NEEDS_REVIEW
                raise CandidatePickError(
                    f"选优失败:无人脸相对门禁达标(需 self≥neg_max+{float(relative_margin):.2f})，"
                    f"{GATE_NEEDS_REVIEW}，禁止入选并应加候选重跑"
                )
            best_id = max(gated, key=lambda c: float(c["pick_score"])).get("id")
        elif face_ok and float(min_face_mean) > 0:
            def _face_gate_ok(c: dict[str, Any]) -> bool:
                if "face_rank" in c:
                    r = c.get("face_rank")
                    return r is not None and float(r) >= float(min_face_rank)
                return c.get("face_mean") is not None and float(c["face_mean"]) >= float(min_face_mean)

            gated = [
                c for c in done
                if _face_gate_ok(c) and c.get("pick_score") is not None and not _blocked(c)
            ]
            if not gated:
                faces = [
                    float(c["face_mean"])
                    for c in done
                    if c.get("face_mean") is not None
                ]
                face_best = max(faces) if faces else None
                for c in candidates:
                    c["is_picked"] = False
                    note = str(c.get("pick_note") or "")
                    if "face_gate" not in note:
                        c["pick_note"] = (note + "+" if note else "") + (
                            f"face_gate<{min_face_mean:.2f}"
                        )
                for c in candidates:
                    c["gate_status"] = GATE_NEEDS_REVIEW
                ranks = [c.get("face_rank") for c in done if "face_rank" in c]
                blocked = [c.get("id") for c in done if _blocked(c)]
                raise CandidatePickError(
                    f"选优失败:无人脸达标(需 face_mean≥{min_face_mean:.2f}"
                    f"{'；写实 min(online,facecrop)≥%.2f' % float(min_face_rank) if ranks else ''}，"
                    f"最佳={face_best!r}，face_rank={ranks!r}，文字门禁未过={blocked!r})，"
                    f"{GATE_NEEDS_REVIEW}，禁止入选并应加候选重跑"
                )
            best_id = max(gated, key=lambda c: float(c["pick_score"])).get("id")
        else:
            gated = [
                c for c in done if c.get("pick_score") is not None and c.get("id") == best_id
            ]

        # 场景门禁（CLIP+Florence）：require_scene_gate 时人脸过线候选还须 scene_gate=pass
        if require_scene_gate:
            gate_fn = scene_gate_fn or gate_video
            scene_ok: list[dict[str, Any]] = []
            pool = [
                c
                for c in done
                if c.get("pick_score") is not None
                and not _blocked(c)
                and (
                    not face_ok
                    or float(min_face_mean) <= 0
                    or (
                        c.get("face_mean") is not None
                        and float(c["face_mean"]) >= float(min_face_mean)
                    )
                )
            ]
            for c in pool:
                path = _local(str(c["url"]))
                if path is None:
                    c["scene_gate"] = "fail"
                    c["scene_gate_detail"] = {"error": "video_path_unresolved"}
                    continue
                try:
                    kwargs = {}
                    if scene_positive:
                        kwargs["positive"] = scene_positive
                    if scene_negatives:
                        kwargs["negatives"] = scene_negatives
                    detail = gate_fn(path, **kwargs)
                    c["scene_gate"] = detail.get("scene_gate") or ("pass" if detail.get("pass") else "fail")
                    c["scene_gate_detail"] = detail
                except SceneGateError as e:
                    c["scene_gate"] = "fail"
                    c["scene_gate_detail"] = {"error": str(e)}
                except Exception as e:
                    c["scene_gate"] = "fail"
                    c["scene_gate_detail"] = {"error": f"{type(e).__name__}:{e}"}
                note = str(c.get("pick_note") or "")
                c["pick_note"] = (note + "+" if note else "") + f"scene_gate={c['scene_gate']}"
                if c.get("scene_gate") == "pass":
                    scene_ok.append(c)
            if not scene_ok:
                for c in candidates:
                    c["is_picked"] = False
                raise CandidatePickError(
                    "选优失败:无人脸+场景双门禁同时达标(scene_gate=pass)，禁止入选并应改提示词重跑"
                )
            best_id = max(scene_ok, key=lambda c: float(c["pick_score"])).get("id")

        for c in candidates:
            c["is_picked"] = c.get("id") == best_id
        return best_id, candidates
    except CandidatePickError:
        raise
    except Exception as e:
        logger.warning("pick_best_candidate 异常，标失败不回落: %s", e)
        for c in candidates:
            c["is_picked"] = False
            c.setdefault("pick_score", None)
            c["pick_note"] = f"face_scorer_error:{type(e).__name__}"
        raise CandidatePickError(f"选优失败:{type(e).__name__}: {e}") from e


# --- 衣物区域品牌 OCR（管线 C 出片后自动换 seed 重跑用）---
# 躯干 ROI：高 25%–70%、宽中 20%–80%；拉丁字母/品牌词命中则 hit。
# pytesseract / cv2 可选；不可用则 hit=False 不拦。

_BRAND_WORDS = (
    "north face",
    "the north face",
    "nike",
    "adidas",
    "gucci",
    "supreme",
    "puma",
    "reebok",
    "under armour",
    "columbia",
    "patagonia",
    "logo",
)

_LATIN_RUN = re.compile(r"[A-Za-z]{3,}")


def _garment_roi_box(h: int, w: int) -> tuple[int, int, int, int]:
    """返回 (y0, y1, x0, x1) 上半身躯干裁剪。"""
    y0 = int(h * 0.25)
    y1 = int(h * 0.70)
    x0 = int(w * 0.20)
    x1 = int(w * 0.80)
    return y0, max(y0 + 1, y1), x0, max(x0 + 1, x1)



def _chest_emblem_roi_box(h: int, w: int) -> tuple[int, int, int, int]:
    """上胸口徽标区（竖屏中景）：覆盖左胸小图标 + 右胸方形贴标。

    避开帽绳抽绳扣/拉链下段高光误报。
    """
    y0 = int(h * 0.32)
    y1 = int(h * 0.48)
    x0 = int(w * 0.26)
    x1 = int(w * 0.74)
    return y0, max(y0 + 1, y1), x0, max(x0 + 1, x1)


def garment_chest_emblem_hit(image) -> dict[str, Any]:
    """检测深色雨衣胸口徽标：高对比亮斑 + 小尺寸彩色图标 + 矩形贴标。

    启发式（任一命中）：
    1) 亮斑：相对暗底孤立亮块，面积约占 ROI 0.15%–4%
    2) 彩标：HSV 饱和度高的紧凑色块（山形折线小图标）
    3) 贴标：近矩形、填充高、亮度/色相对衣身有差的方块
    返回 {hit, area_ratio, blobs, error, modes}。
    """
    out: dict[str, Any] = {
        "hit": False,
        "area_ratio": 0.0,
        "blobs": 0,
        "error": "",
        "modes": [],
    }
    try:
        import cv2
        import numpy as np
    except Exception as e:
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    try:
        if hasattr(image, "convert"):
            arr = np.asarray(image.convert("RGB"))
            bgr = arr[:, :, ::-1].copy()
        else:
            arr = np.asarray(image)
            if arr.ndim != 3 or arr.shape[2] < 3:
                out["error"] = "bad_frame"
                return out
            bgr = arr[:, :, :3].copy()
        h, w = bgr.shape[:2]
        y0, y1, x0, x1 = _chest_emblem_roi_box(h, w)
        roi = bgr[y0:y1, x0:x1]
        if roi.size == 0:
            return out
        gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY)
        hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
        med = float(np.median(gray))
        rh, rw = gray.shape[:2]
        roi_area = float(rh * rw) or 1.0
        hits = 0
        best = 0.0
        modes: list[str] = []

        def _accept_contour(c, *, mode: str, min_ratio: float, max_ratio: float,
                            aspect_lo: float, aspect_hi: float, fill_lo: float) -> bool:
            nonlocal hits, best
            area = float(cv2.contourArea(c))
            ratio = area / roi_area
            if ratio < min_ratio or ratio > max_ratio:
                return False
            x, y, cw, ch = cv2.boundingRect(c)
            if cw < 6 or ch < 6:
                return False
            aspect = cw / max(ch, 1)
            if aspect < aspect_lo or aspect > aspect_hi:
                return False
            fill = area / float(max(cw * ch, 1))
            if fill < fill_lo:
                return False
            hits += 1
            best = max(best, ratio)
            modes.append(mode)
            return True

        # --- 1) 亮斑（原路径，阈值略降以接小图标）---
        thr = max(int(med + 55), 150)
        _, bw = cv2.threshold(gray, thr, 255, cv2.THRESH_BINARY)
        bw = cv2.morphologyEx(bw, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        bw = cv2.morphologyEx(bw, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        cnts, _ = cv2.findContours(bw, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts:
            mask = np.zeros(gray.shape, dtype=np.uint8)
            cv2.drawContours(mask, [c], -1, 255, -1)
            mean_blob = float(cv2.mean(gray, mask=mask)[0])
            if mean_blob < med + 40:
                continue
            _accept_contour(
                c, mode="bright", min_ratio=0.0025, max_ratio=0.03,
                aspect_lo=0.4, aspect_hi=2.6, fill_lo=0.22,
            )

        # --- 2) 高饱和彩色小图标 ---
        sat = hsv[:, :, 1]
        val = hsv[:, :, 2]
        color_mask = ((sat > 60) & (val > 40) & (val < 245)).astype("uint8") * 255
        color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        color_mask = cv2.morphologyEx(color_mask, cv2.MORPH_CLOSE, np.ones((3, 3), np.uint8))
        cnts2, _ = cv2.findContours(color_mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts2:
            _accept_contour(
                c, mode="color", min_ratio=0.0012, max_ratio=0.035,
                aspect_lo=0.35, aspect_hi=2.8, fill_lo=0.18,
            )

        # --- 3) 矩形贴标（边缘+近似矩形）---
        edges = cv2.Canny(gray, 60, 140)
        edges = cv2.dilate(edges, np.ones((2, 2), np.uint8), iterations=1)
        cnts3, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for c in cnts3:
            peri = cv2.arcLength(c, True)
            approx = cv2.approxPolyDP(c, 0.06 * peri, True)
            if len(approx) < 4 or len(approx) > 6:
                continue
            x, y, cw, ch = cv2.boundingRect(c)
            if cw < 8 or ch < 8:
                continue
            aspect = cw / max(ch, 1)
            if aspect < 0.6 or aspect > 2.4:
                continue
            area = float(cw * ch)
            ratio = area / roi_area
            if ratio < 0.002 or ratio > 0.05:
                continue
            patch = gray[y : y + ch, x : x + cw]
            if patch.size == 0:
                continue
            # 贴标相对衣身有亮度差
            if abs(float(np.mean(patch)) - med) < 18:
                continue
            hits += 1
            best = max(best, ratio)
            modes.append("rect")

        out["blobs"] = hits
        out["area_ratio"] = best
        out["modes"] = modes[:6]
        # 雨滴/湿反光：多枚小亮斑或彩噪，无主导贴标/大图标 → 不命中
        # 真徽标：少量（≤3）且有足够大的一块，或含 rect 贴标模式
        n_rect = sum(1 for m in modes if m == "rect")
        n_bright = sum(1 for m in modes if m == "bright")
        n_color = sum(1 for m in modes if m == "color")
        cluster = (n_bright + n_color) >= 4
        # 孤立贴标/清晰小图标才算；与雨滴簇并存的 rect 多半是湿反光外框
        if n_rect >= 1 and best >= 0.002 and not cluster and hits <= 3:
            out["hit"] = True
        elif hits >= 1 and hits <= 3 and best >= 0.008 and not cluster:
            out["hit"] = True
        elif hits >= 1 and best >= 0.015 and hits <= 2:
            out["hit"] = True
        else:
            out["hit"] = False
            if hits:
                out["reject_reason"] = "rain_or_specular_cluster"
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


def brand_text_hit(text: str) -> bool:
    """OCR 文本是否含品牌词或明显拉丁字母串（衣物印花）。"""
    t = (text or "").strip()
    if not t:
        return False
    low = t.lower()
    for w in _BRAND_WORDS:
        if w in low:
            return True
    # 连续拉丁字母 ≥3 且总拉丁字母较长 → 疑似胸口英文标
    runs = _LATIN_RUN.findall(t)
    if not runs:
        return False
    joined = "".join(runs)
    if len(joined) >= 6:
        return True
    if any(len(r) >= 4 for r in runs) and len(joined) >= 4:
        return True
    return False


_SIGN_LATIN_RUN = re.compile(r"[A-Za-z]{4,}")
_SIGN_MIN_CONF = 55.0


def sign_text_hit(text: str) -> bool:
    """店招乱码判定：严于 brand_text_hit，滤条纹噪声假阳。

    - 品牌词仍命中
    - 至少 6 个拉丁字母，且元音≥2（拒绝 eee/符号噪声）
    - 至少一段连续拉丁 ≥5，或合格段合计 ≥8
    """
    t = (text or "").strip()
    if not t:
        return False
    low = t.lower()
    for w in _BRAND_WORDS:
        if w in low:
            return True
    letters = re.findall(r"[A-Za-z]", t)
    if len(letters) < 6:
        return False
    joined_all = "".join(letters).lower()
    vowels = sum(1 for c in joined_all if c in "aeiou")
    if vowels < 2:
        return False
    runs = _SIGN_LATIN_RUN.findall(t)
    if not runs:
        return False
    joined = "".join(runs)
    if any(len(r) >= 5 for r in runs):
        return True
    if len(joined) >= 8:
        return True
    return False


def _tesseract_words_confident(crop, *, min_conf: float = _SIGN_MIN_CONF) -> tuple[str, list[float]]:
    """返回高置信度英文词拼接文本 + 置信度列表。失败则回落空。"""
    try:
        import pytesseract
    except Exception:
        return "", []
    try:
        data = pytesseract.image_to_data(crop, lang="eng", output_type=pytesseract.Output.DICT)
    except Exception:
        return "", []
    words: list[str] = []
    confs: list[float] = []
    texts = data.get("text") or []
    conf_raw = data.get("conf") or []
    for txt, conf in zip(texts, conf_raw):
        raw = (txt or "").strip()
        if not raw:
            continue
        try:
            c = float(conf)
        except (TypeError, ValueError):
            continue
        if c < min_conf:
            continue
        if not re.search(r"[A-Za-z]{3,}", raw):
            continue
        words.append(raw)
        confs.append(c)
    return " ".join(words), confs



def _scene_sign_roi_boxes(h: int, w: int) -> list[tuple[int, int, int, int]]:
    """店招/霓虹 ROI：上半约 0–40% + 左右上角；刻意避开躯干服装 ROI。

    返回若干 (y0, y1, x0, x1)。
    """
    gy0, _gy1, gx0, gx1 = _garment_roi_box(h, w)
    top_y1 = max(1, int(h * 0.40))
    boxes: list[tuple[int, int, int, int]] = []
    # 服装上方顶条（通常含横幅/霓虹店招）
    y_above = max(1, min(top_y1, gy0))
    boxes.append((0, y_above, 0, w))
    # 左上霓虹（服装左侧）
    if gx0 > 1:
        boxes.append((0, top_y1, 0, gx0))
    # 右上霓虹（服装右侧）
    if gx1 < w - 1:
        boxes.append((0, top_y1, gx1, w))
    return boxes


def scene_sign_ocr_frame(image) -> dict[str, Any]:
    """对单帧上半/霓虹区做店招乱码 OCR。

    返回 {hit, text, error, rois}。pytesseract 不可用则 hit=False。
    命中条件用 sign_text_hit + tesseract 置信度≥55；滤条纹短噪声假阳。
    """
    out: dict[str, Any] = {"hit": False, "text": "", "error": "", "rois": 0}
    try:
        import pytesseract
        from PIL import Image
        import numpy as np
    except Exception as e:
        out["error"] = f"ocr_unavailable:{type(e).__name__}"
        return out

    try:
        if hasattr(image, "convert"):
            im = image.convert("RGB")
        else:
            arr = np.asarray(image)
            if arr.ndim == 3 and arr.shape[2] == 3:
                try:
                    import cv2
                    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
                except Exception:
                    rgb = arr
                im = Image.fromarray(rgb.astype("uint8"))
            else:
                out["error"] = "bad_frame"
                return out
        w, h = im.size
        boxes = _scene_sign_roi_boxes(h, w)
        out["rois"] = len(boxes)
        texts: list[str] = []
        for y0, y1, x0, x1 in boxes:
            if y1 <= y0 or x1 <= x0:
                continue
            crop = im.crop((x0, y0, x1, y1))
            cw, ch = crop.size
            if cw < 8 or ch < 8:
                continue
            if max(cw, ch) < 320:
                scale = max(2, 320 // max(cw, ch))
                crop = crop.resize((cw * scale, ch * scale), Image.Resampling.LANCZOS)
            conf_text, confs = _tesseract_words_confident(crop)
            # 回落：无高置信词时仍收全量文本供日志，但不用于 hit
            raw = (pytesseract.image_to_string(crop, lang="eng") or "").strip()
            text = conf_text or ""
            if conf_text:
                texts.append(conf_text)
            elif raw:
                texts.append("~" + raw[:80])
            if conf_text and sign_text_hit(conf_text):
                out["text"] = conf_text[:200]
                out["hit"] = True
                out["conf_mean"] = round(sum(confs) / max(len(confs), 1), 1)
                return out
        out["text"] = " | ".join(texts)[:200]
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


def garment_brand_ocr_frame(image) -> dict[str, Any]:
    """对单帧（PIL.Image 或 RGB/BGR ndarray）做衣物区 OCR。

    返回 {hit, text, error}。pytesseract 不可用则 hit=False。
    """
    out: dict[str, Any] = {"hit": False, "text": "", "error": ""}
    try:
        import pytesseract
        from PIL import Image
        import numpy as np
    except Exception as e:
        out["error"] = f"ocr_unavailable:{type(e).__name__}"
        return out

    try:
        if hasattr(image, "convert"):
            im = image.convert("RGB")
        else:
            arr = np.asarray(image)
            if arr.ndim == 3 and arr.shape[2] == 3:
                # 启发式：OpenCV BGR 常见；若已是 RGB 也大致可 OCR
                try:
                    import cv2
                    rgb = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)
                except Exception:
                    rgb = arr
                im = Image.fromarray(rgb.astype("uint8"))
            else:
                out["error"] = "bad_frame"
                return out
        w, h = im.size
        y0, y1, x0, x1 = _garment_roi_box(h, w)
        crop = im.crop((x0, y0, x1, y1))
        # 放大一点利于小 logo
        cw, ch = crop.size
        if max(cw, ch) < 400:
            scale = max(2, 400 // max(cw, ch))
            crop = crop.resize((cw * scale, ch * scale), Image.Resampling.LANCZOS)
        text = (pytesseract.image_to_string(crop, lang="eng") or "").strip()
        out["text"] = text[:200]
        out["hit"] = brand_text_hit(text)
        if not out["hit"]:
            # 胸口徽标 blob 仅记录不拦：雨夜湿反光/袖口褶皱/店内霓虹大量误报，
            # 且 c_hybrid 锚定首帧（定妆图本身）即命中（2026-10-05 雨夜 shot0）。
            emb = garment_chest_emblem_hit(image)
            out["emblem"] = {k: emb.get(k) for k in ("hit", "area_ratio", "blobs", "error")}
            out["emblem_log_only"] = True
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


# ───────────── 出片文字门禁（2026-10-05 c_hybrid 雨夜误报修复）─────────────
# 只拦「字幕/对白式」横排中文：底部带、居中、够宽、连续多采样帧出现。
# 胸口徽标 blob（garment_chest_emblem_hit）与店招 OCR（scene_sign_ocr_frame）降为仅记录：
# 二者在雨夜湿反光/霓虹/锚定首帧上大量误报（首帧定妆图本身即命中 emblem）。

# c_hybrid 首帧锚定：第 0..N 帧被 first_frame 关键帧钉住，门禁跳过（含第 N 帧）
ANCHORED_FIRST_FRAME_SKIP_FRAMES = 12

SUBTITLE_BAND_Y0 = 0.70
SUBTITLE_BAND_Y1 = 0.95
SUBTITLE_MIN_CJK = 4
SUBTITLE_MIN_CONF = 60.0
SUBTITLE_MIN_WIDTH_RATIO = 0.30
SUBTITLE_CENTER_TOL = 0.15  # |行中心x - w/2| ≤ tol·w
SUBTITLE_MIN_CONSECUTIVE = 2
SUBTITLE_SAMPLE_DIVISOR = 16  # 字幕密采样：约每 n/16 帧一采

_CJK_CHAR = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")


def _to_pil_rgb(image):
    from PIL import Image
    import numpy as np

    if hasattr(image, "convert"):
        return image.convert("RGB")
    arr = np.asarray(image)
    if arr.ndim != 3 or arr.shape[2] < 3:
        raise ValueError("bad_frame")
    try:
        import cv2

        rgb = cv2.cvtColor(arr[:, :, :3], cv2.COLOR_BGR2RGB)
    except Exception:
        rgb = arr[:, :, :3]
    return Image.fromarray(rgb.astype("uint8"))


def _subtitle_lines_from_data(data: dict, *, scale: float, x_off: int, y_off: int) -> list[dict]:
    """image_to_data → 按 (block, par, line) 聚合；只用 conf≥阈值 的词。"""
    groups: dict[tuple, dict] = {}
    n = len(data.get("text") or [])
    for j in range(n):
        raw = str((data["text"][j] or "")).strip()
        if not raw:
            continue
        try:
            conf = float(data["conf"][j])
        except (TypeError, ValueError):
            continue
        if conf < SUBTITLE_MIN_CONF:
            continue
        key = (data["block_num"][j], data["par_num"][j], data["line_num"][j])
        g = groups.setdefault(key, {"words": [], "confs": [], "x0": 10**9, "y0": 10**9, "x1": -1, "y1": -1})
        g["words"].append(raw)
        g["confs"].append(conf)
        l, t = int(data["left"][j]), int(data["top"][j])
        r, b = l + int(data["width"][j]), t + int(data["height"][j])
        g["x0"], g["y0"] = min(g["x0"], l), min(g["y0"], t)
        g["x1"], g["y1"] = max(g["x1"], r), max(g["y1"], b)
    lines: list[dict] = []
    for g in groups.values():
        text = "".join(g["words"])
        x0 = int(g["x0"] / scale) + x_off
        x1 = int(g["x1"] / scale) + x_off
        y0 = int(g["y0"] / scale) + y_off
        y1 = int(g["y1"] / scale) + y_off
        lines.append(
            {
                "text": text[:80],
                "cjk": len(_CJK_CHAR.findall(text)),
                "conf_mean": round(sum(g["confs"]) / max(len(g["confs"]), 1), 1),
                "box": [x0, y0, x1 - x0, y1 - y0],
            }
        )
    return lines


def subtitle_ocr_frame(image) -> dict[str, Any]:
    """单帧字幕检测：底部带 y∈[0.70,0.95]h，tesseract chi_sim+eng image_to_data。

    行命中：conf≥60 的词合计 ≥4 个 CJK 字、行宽 ≥0.3w、行中心水平居中（±0.15w）。
    返回 {hit, lines, hit_lines, error}；pytesseract 不可用 → hit=False。
    """
    out: dict[str, Any] = {"hit": False, "lines": [], "hit_lines": [], "error": ""}
    try:
        import pytesseract
        from PIL import Image, ImageOps
    except Exception as e:
        out["error"] = f"ocr_unavailable:{type(e).__name__}"
        return out
    try:
        im = _to_pil_rgb(image)
    except Exception:
        out["error"] = "bad_frame"
        return out
    try:
        w, h = im.size
        y0 = int(h * SUBTITLE_BAND_Y0)
        y1 = max(y0 + 1, int(h * SUBTITLE_BAND_Y1))
        band = im.crop((0, y0, w, y1)).convert("L")
        scale = 1.0
        if w < 1000:
            scale = 1000.0 / float(w)
            band = band.resize((int(w * scale), int((y1 - y0) * scale)), Image.Resampling.LANCZOS)
        lines: list[dict] = []
        # 白字黑边/黑字白底两种极性各跑一次
        for variant in (band, ImageOps.invert(band)):
            data = pytesseract.image_to_data(
                variant, lang="chi_sim+eng", config="--psm 6",
                output_type=pytesseract.Output.DICT,
            )
            lines.extend(_subtitle_lines_from_data(data, scale=scale, x_off=0, y_off=y0))
        out["lines"] = lines
        for ln in lines:
            bx, _by, bw, _bh = ln["box"]
            cx = bx + bw / 2.0
            if (
                ln["cjk"] >= SUBTITLE_MIN_CJK
                and bw >= SUBTITLE_MIN_WIDTH_RATIO * w
                and abs(cx - w / 2.0) <= SUBTITLE_CENTER_TOL * w
            ):
                out["hit_lines"].append(ln)
        out["hit"] = bool(out["hit_lines"])
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


BRAND_TEXT_MIN_CONF = 60.0
BRAND_TEXT_MIN_LETTERS = 3
BRAND_TEXT_MIN_CONSECUTIVE = 2
BRAND_TEXT_OCR_PASSES = ((1.5, 6), (1.0, 11))  # (缩放, tesseract psm)
# RapidOCR（PaddleOCR DB 检测 + CRNN，onnxruntime CPU）：斜体/小字号 logo 字 tesseract 读不出
# （雨夜 shot1 931f3b96 胸口「PEB NORTH FACE」约 11px 字高，tesseract 紧裁×4 仍为乱码），
# RapidOCR 在同帧读出 NORTH 0.71–0.75 / FACE 0.77–0.79。分数≥此值且含≥3 连续字母才算。
BRAND_RAPID_MIN_SCORE = 0.50
_RAPID_OCR = None
_RAPID_OCR_FAILED = False


def _get_rapid_ocr():
    global _RAPID_OCR, _RAPID_OCR_FAILED
    if _RAPID_OCR is None and not _RAPID_OCR_FAILED:
        try:
            from rapidocr_onnxruntime import RapidOCR

            _RAPID_OCR = RapidOCR()
        except Exception as e:  # noqa: BLE001
            _RAPID_OCR_FAILED = True
            logger.warning("rapidocr unavailable, brand gate falls back to tesseract only: %s", e)
    return _RAPID_OCR
_BRAND_WORD_RUN = re.compile(r"[A-Za-z]{3,}")


def _person_torso_box(frame_bgr) -> tuple[int, int, int, int] | None:
    """由最大人脸推人物躯干框 (x0,y0,x1,y1)：脸下沿起约 3.5 脸高、左右各 1.6 脸宽。无脸/无 insightface → None。"""
    if not _try_import_face():
        return None
    try:
        app = _get_face_app()
        faces = app.get(frame_bgr)
    except Exception:
        return None
    if not faces:
        return None
    f = sorted(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True)[0]
    x1, y1, x2, y2 = [float(v) for v in f.bbox]
    fw, fh = max(1.0, x2 - x1), max(1.0, y2 - y1)
    cx = (x1 + x2) / 2.0
    h, w = frame_bgr.shape[:2]
    return (
        max(0, int(cx - 1.6 * fw)),
        min(h - 1, int(y2)),
        min(w - 1, int(cx + 1.6 * fw)),
        min(h - 1, int(y2 + 3.5 * fh)),
    )


def garment_brand_text_words(frame_bgr) -> dict[str, Any]:
    """衣物英文字严格检测（单帧）：先由最大人脸推人物躯干框，只对躯干框做 tesseract eng image_to_data
    （psm6@1.5x + psm11@1.0x 取并集；整幅杂景 OCR 对 JPEG 压缩极不稳定），
    词 conf≥60 且含 ≥3 连续拉丁字母才算。无人物 → 不判（error=no_person）。
    返回 {hit, words, torso, error}。
    """
    out: dict[str, Any] = {"hit": False, "words": [], "torso": None, "error": ""}
    try:
        import pytesseract
        from PIL import Image
        import numpy as np
    except Exception as e:
        out["error"] = f"ocr_unavailable:{type(e).__name__}"
        return out
    try:
        if hasattr(frame_bgr, "convert"):
            arr = np.asarray(frame_bgr.convert("RGB"))[:, :, ::-1].copy()
        else:
            arr = np.asarray(frame_bgr)
        torso = _person_torso_box(arr)
        if torso is None:
            out["error"] = "no_person"
            return out
        out["torso"] = list(torso)
        tx0, ty0, tx1, ty1 = torso
        if tx1 - tx0 < 16 or ty1 - ty0 < 16:
            out["error"] = "torso_too_small"
            return out
        seen: set[tuple] = set()
        out["engines"] = []
        eng = _get_rapid_ocr()
        if eng is not None:
            out["engines"].append("rapidocr")
            out["rapid_raw"] = []
            try:
                res, _el = eng(np.ascontiguousarray(arr[ty0:ty1, tx0:tx1]))
            except Exception as e:  # noqa: BLE001
                res = None
                out["rapid_error"] = f"{type(e).__name__}:{e}"[:120]
            for r in res or []:
                try:
                    box, t, sc = r[0], str(r[1] or "").strip(), float(r[2])
                except (TypeError, ValueError, IndexError):
                    continue
                out["rapid_raw"].append({"text": t[:40], "score": round(sc, 3)})
                if sc < BRAND_RAPID_MIN_SCORE:
                    continue
                if not any(len(x) >= BRAND_TEXT_MIN_LETTERS for x in _BRAND_WORD_RUN.findall(t)):
                    continue
                xs = [float(pt[0]) for pt in box]
                ys = [float(pt[1]) for pt in box]
                bx, by = int(min(xs)) + tx0, int(min(ys)) + ty0
                key = (t.upper(), bx // 24, by // 24)
                if key in seen:
                    continue
                seen.add(key)
                out["words"].append({"text": t[:40], "conf": round(sc * 100.0, 1),
                                     "box": [bx, by, int(max(xs) - min(xs)), int(max(ys) - min(ys))],
                                     "in_torso": True, "engine": "rapidocr"})
        out["engines"].append("tesseract")
        crop = _to_pil_rgb(arr).crop((tx0, ty0, tx1, ty1)).convert("L")
        for scale, psm in BRAND_TEXT_OCR_PASSES:
            cc = crop
            if scale != 1.0:
                cc = crop.resize((int(crop.size[0] * scale), int(crop.size[1] * scale)),
                                 Image.Resampling.LANCZOS)
            data = pytesseract.image_to_data(
                cc, lang="eng", config=f"--psm {psm}", output_type=pytesseract.Output.DICT
            )
            for j, raw in enumerate(data.get("text") or []):
                t = str(raw or "").strip()
                if not t:
                    continue
                try:
                    conf = float(data["conf"][j])
                except (TypeError, ValueError):
                    continue
                if conf < BRAND_TEXT_MIN_CONF:
                    continue
                if not any(len(r) >= BRAND_TEXT_MIN_LETTERS for r in _BRAND_WORD_RUN.findall(t)):
                    continue
                bx = int(data["left"][j] / scale) + tx0
                by = int(data["top"][j] / scale) + ty0
                bw = int(data["width"][j] / scale)
                bh = int(data["height"][j] / scale)
                key = (t.upper(), bx // 24, by // 24)
                if key in seen:
                    continue
                seen.add(key)
                out["words"].append({"text": t[:40], "conf": conf, "box": [bx, by, bw, bh],
                                     "in_torso": True, "psm": psm, "engine": "tesseract"})
        out["hit"] = bool(out["words"])
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


def garment_brand_ocr_hit(
    video_path: str | Path,
    *,
    skip_until_frame: int = 0,
) -> dict[str, Any]:
    """出片后文字门禁。hit True 时应换 seed 重跑。

    拦截（hit）：
      · subtitle：底部带横排中文字幕在 ≥2 个连续采样帧出现（kind=subtitle）
      · brand：衣物英文字（tesseract 词 conf≥60、≥3 连续字母、框在人物躯干框内）
        在 ≥2 个连续采样帧出现（kind=brand）
    仅记录（不拦）：
      · 胸口徽标 blob（emblem_log）、店招 OCR（sign_log）
      · 旧版衣物 OCR（image_to_string 无置信度/空识别占位，brand_log）
    skip_until_frame>0（c_hybrid 首帧锚定）：第 0..skip_until_frame 帧不检。
    返回 {hit, text, frames_checked, error, kind, ...}。
    """
    out: dict[str, Any] = {
        "hit": False,
        "text": "",
        "frames_checked": 0,
        "error": "",
        "kind": "",
        "skip_until_frame": int(skip_until_frame or 0),
        "emblem_log": [],
        "sign_log": [],
        "subtitle_frames": [],
        "brand_log": [],
        "brand_frames": [],
        "band_log": [],
    }
    path = Path(video_path) if video_path else None
    if path is None or not path.is_file():
        out["error"] = "missing_video"
        return out
    try:
        import cv2
    except Exception as e:
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    try:
        import pytesseract  # noqa: F401
    except Exception as e:
        out["error"] = f"ocr_unavailable:{type(e).__name__}"
        return out

    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        out["error"] = "open_failed"
        return out
    try:
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        skip = max(0, int(skip_until_frame or 0))
        if n <= 1:
            brand_idxs = {0}
            sub_idxs = [0]
        else:
            step = max(1, n // 8)
            brand_idxs = {0, n - 1, *range(0, n, step)}
            sub_step = max(1, n // SUBTITLE_SAMPLE_DIVISOR)
            sub_idxs = sorted({n - 1, *range(0, n, sub_step)})
        if skip > 0:
            brand_idxs = {i for i in brand_idxs if i > skip}
            sub_idxs = [i for i in sub_idxs if i > skip]
        idxs = sorted(set(sub_idxs) | brand_idxs)
        sub_set = set(sub_idxs)
        texts: list[str] = []
        consecutive = 0
        run: list[dict] = []
        b_consecutive = 0
        b_run: list[dict] = []
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            out["frames_checked"] += 1
            if i in sub_set:
                sr = subtitle_ocr_frame(frame)
                if sr.get("hit"):
                    consecutive += 1
                    best = max(sr["hit_lines"], key=lambda ln: ln["cjk"])
                    run.append({"frame": i, "text": best["text"], "box": best["box"],
                                "conf_mean": best["conf_mean"]})
                    out["subtitle_frames"].append(run[-1])
                    if consecutive >= SUBTITLE_MIN_CONSECUTIVE:
                        out["hit"] = True
                        out["kind"] = "subtitle"
                        out["text"] = ("subtitle:" + run[-1]["text"])[:200]
                        out["subtitle_run"] = run[-consecutive:]
                        return out
                else:
                    consecutive = 0
                    run = []
                bw = garment_brand_text_words(frame)
                if bw.get("hit"):
                    b_consecutive += 1
                    words = [x for x in bw["words"] if x.get("in_torso")]
                    b_run.append({"frame": i, "words": words, "torso": bw.get("torso")})
                    out["brand_frames"].append(b_run[-1])
                    if b_consecutive >= BRAND_TEXT_MIN_CONSECUTIVE:
                        out["hit"] = True
                        out["kind"] = "brand"
                        out["text"] = " ".join(x["text"] for x in words)[:200]
                        out["brand_run"] = b_run[-b_consecutive:]
                        return out
                else:
                    b_consecutive = 0
                    b_run = []
            if i in brand_idxs:
                fr = garment_brand_ocr_frame(frame)
                if fr.get("text"):
                    texts.append(str(fr["text"]))
                emb = fr.get("emblem") or {}
                if emb.get("hit"):
                    out["emblem_log"].append({"frame": i, **emb})
                if fr.get("hit"):
                    # 旧单帧 image_to_string 判定：无置信度/无人物框 → 仅记录
                    out["brand_log"].append({"frame": i, "text": str(fr.get("text") or "")[:120]})
                sg = scene_sign_ocr_frame(frame)
                if sg.get("text"):
                    texts.append("sign:" + str(sg["text"]))
                if sg.get("hit"):
                    out["sign_log"].append({"frame": i, "text": str(sg.get("text") or "")[:120]})
                try:
                    cb = chain_color_band_frame(frame)
                except Exception:
                    cb = {}
                if cb.get("hit"):
                    out["band_log"].append({"frame": i, "colors": cb["colors"], "rows": cb["rows"]})
        if out["emblem_log"] or out["sign_log"] or out["brand_log"] or out["band_log"]:
            logger.info(
                "text_gate log-only path=%s emblem_frames=%s sign=%s brand=%s band_frames=%s",
                path.name,
                [e["frame"] for e in out["emblem_log"]],
                out["sign_log"][:3],
                out["brand_log"][:3],
                [b["frame"] for b in out["band_log"]],
            )
        out["text"] = " | ".join(texts)[:200]
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out
    finally:
        cap.release()


def _hex_to_rgb(h: str) -> tuple[int, int, int]:
    s = (h or "").strip().lstrip("#")
    if len(s) != 6:
        return (0, 0, 0)
    return int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16)


def garment_main_color_miss(
    image,
    expected_hexes: list[str] | None,
    *,
    black_luma_max: float = 35.0,
) -> dict[str, Any]:
    """出片主色校验：期望板岩灰等非黑时，躯干 ROI 过黑则 hit（应换 seed）。

    expected_hexes 来自设定卡服装色；含 slate/灰 且不含「仅纯黑」时启用。
    """
    out: dict[str, Any] = {
        "hit": False,
        "mean_luma": 0.0,
        "mean_bgr": [],
        "expected": list(expected_hexes or []),
        "error": "",
    }
    ex = [e for e in (expected_hexes or []) if isinstance(e, str) and e.strip()]
    if not ex:
        return out
    # 是否期望非黑灰调
    rgbs = [_hex_to_rgb(e) for e in ex]
    has_grayish = any(40 <= (0.299 * r + 0.587 * g + 0.114 * b) <= 160 for r, g, b in rgbs)
    only_near_black = all((0.299 * r + 0.587 * g + 0.114 * b) < 35 for r, g, b in rgbs)
    if not has_grayish or only_near_black:
        return out
    try:
        import cv2
        import numpy as np
    except Exception as e:
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    try:
        if hasattr(image, "convert"):
            arr = np.asarray(image.convert("RGB"))
            bgr = arr[:, :, ::-1].copy()
        else:
            arr = np.asarray(image)
            if arr.ndim != 3 or arr.shape[2] < 3:
                out["error"] = "bad_frame"
                return out
            bgr = arr[:, :, :3].copy()
        h, w = bgr.shape[:2]
        y0, y1, x0, x1 = _garment_roi_box(h, w)
        roi = bgr[y0:y1, x0:x1]
        if roi.size == 0:
            return out
        mean = [float(x) for x in cv2.mean(roi)[:3]]
        # OpenCV BGR
        b, g, r = mean
        luma = 0.299 * r + 0.587 * g + 0.114 * b
        out["mean_bgr"] = [round(b, 1), round(g, 1), round(r, 1)]
        out["mean_luma"] = round(luma, 1)
        gray_lumas = [
            0.299 * rr + 0.587 * gg + 0.114 * bb
            for rr, gg, bb in rgbs
            if 40 <= (0.299 * rr + 0.587 * gg + 0.114 * bb) <= 160
        ]
        ref_luma = max(gray_lumas) if gray_lumas else 100.0
        out["ref_luma"] = round(ref_luma, 1)
        # 夜景相对亮度：低于参考灰×0.55 或绝对过黑 → 判 miss（压成纯黑）
        rel_floor = max(float(black_luma_max), float(ref_luma) * 0.55)
        out["rel_floor"] = round(rel_floor, 1)
        if luma <= rel_floor:
            out["hit"] = True
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


def garment_main_color_miss_video(
    video_path: str | Path,
    expected_hexes: list[str] | None,
) -> dict[str, Any]:
    """对视频抽中段帧做主色校验。"""
    out: dict[str, Any] = {
        "hit": False,
        "mean_luma": 0.0,
        "frames_checked": 0,
        "error": "",
        "expected": list(expected_hexes or []),
    }
    path = Path(video_path) if video_path else None
    if path is None or not path.is_file():
        out["error"] = "missing_video"
        return out
    try:
        import cv2
    except Exception as e:
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    cap = cv2.VideoCapture(str(path))
    if not cap.isOpened():
        out["error"] = "open_failed"
        return out
    try:
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        idxs = [max(0, n // 2)] if n > 0 else [0]
        if n >= 5:
            idxs = [n // 4, n // 2, (3 * n) // 4]
        lumas = []
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            out["frames_checked"] += 1
            r = garment_main_color_miss(frame, expected_hexes)
            if r.get("error"):
                out["error"] = r["error"]
                continue
            lumas.append(float(r.get("mean_luma") or 0))
            if r.get("hit"):
                out["hit"] = True
                out["mean_luma"] = r.get("mean_luma")
                out["mean_bgr"] = r.get("mean_bgr")
                return out
        if lumas:
            out["mean_luma"] = round(sum(lumas) / len(lumas), 1)
        return out
    finally:
        cap.release()

