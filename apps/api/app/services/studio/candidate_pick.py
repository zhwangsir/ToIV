"""管线 C 多候选选优：裁脸相似度优先，疑似烧录字幕/乱码降权。

insightface / cv2 可用时走真评分；不可用时回落「首个成功候选」，并在 meta 标明。
OCR 可选：若安装 pytesseract 则检测中部字幕带文字密度。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

_FACE_APP = None


def _get_face_app():
    """复用 FaceAnalysis，避免每次选优重新加载 buffalo_l 堵死 API。"""
    global _FACE_APP
    if _FACE_APP is not None:
        return _FACE_APP
    from insightface.app import FaceAnalysis

    app = FaceAnalysis(name="buffalo_l", providers=["CPUExecutionProvider"])
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
    density = float(edges.mean()) / 255.0
    # 经验：正常画面下方 edge 均值通常 <0.08；字幕带常 >0.12
    if density < 0.08:
        return 0.0
    return min(0.3, (density - 0.08) * 2.0)


def _ocr_penalty(frame_bgr) -> float:
    try:
        import pytesseract
        from PIL import Image
        import cv2
    except Exception:
        return 0.0
    h, w = frame_bgr.shape[:2]
    band = frame_bgr[int(h * 0.7) : h, :]
    rgb = cv2.cvtColor(band, cv2.COLOR_BGR2RGB)
    text = (pytesseract.image_to_string(Image.fromarray(rgb), lang="chi_sim+eng") or "").strip()
    if not text:
        return 0.0
    # 有可识别文字 → 重罚
    return 0.5 if len(text) >= 2 else 0.2


def score_video_face(
    video_path: str | Path,
    ref_image_path: str | Path,
) -> dict[str, Any]:
    """对视频首/中/尾帧与参考脸算余弦相似度均值；失败返回 face_mean=None。"""
    out: dict[str, Any] = {
        "face_mean": None,
        "sims": [],
        "burnin_penalty": 0.0,
        "ocr_penalty": 0.0,
        "error": "",
    }
    if not _try_import_face():
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
        out["error"] = "参考图未检测到脸"
        return out
    ref_emb = sorted(
        faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]), reverse=True
    )[0].normed_embedding

    cap = cv2.VideoCapture(str(vid_p))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    idxs = [0, max(0, n // 2), max(0, n - 1)]
    sims: list[float] = []
    burn = 0.0
    ocr = 0.0
    for i in idxs:
        cap.set(cv2.CAP_PROP_POS_FRAMES, i)
        ok, frame = cap.read()
        if not ok or frame is None:
            continue
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
    cap.release()
    out["sims"] = sims
    out["burnin_penalty"] = burn
    out["ocr_penalty"] = ocr
    if sims:
        out["face_mean"] = float(sum(sims) / len(sims))
    return out


def pick_best_candidate(
    candidates: list[dict[str, Any]],
    *,
    ref_image_path: str | Path | None,
    local_url_resolver=None,
) -> tuple[str | None, list[dict[str, Any]]]:
    """按 face_mean - burnin - ocr 选优；返回 (winner_id, 更新后的 candidates)。

    local_url_resolver: (url)->本地路径；缺省仅接受已是本地路径的 url。
    """
    done = [c for c in candidates if c.get("status") == "done" and c.get("url")]
    if not done:
        return None, candidates

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

    if not ref_image_path or not Path(ref_image_path).is_file() or not _try_import_face():
        # 回落：保留现有 is_picked 或首个成功
        winner = next((c for c in done if c.get("is_picked")), done[0])
        for c in candidates:
            c["is_picked"] = c.get("id") == winner.get("id")
            c.setdefault("pick_score", None)
            c.setdefault("pick_note", "face_scorer_unavailable_fallback_first")
        return winner.get("id"), candidates

    best_id = None
    best_score = float("-inf")
    for c in done:
        path = _local(str(c["url"]))
        if path is None:
            c["pick_score"] = None
            c["pick_note"] = "video_path_unresolved"
            c["face_mean"] = None
            continue
        m = score_video_face(path, ref_image_path)
        face = m.get("face_mean")
        pen = float(m.get("burnin_penalty") or 0) + float(m.get("ocr_penalty") or 0)
        score = (float(face) if face is not None else -1.0) - pen
        # 无脸直接淘汰到极低分
        if face is None:
            score = -2.0 - pen
        c["face_mean"] = face
        c["burnin_penalty"] = m.get("burnin_penalty")
        c["ocr_penalty"] = m.get("ocr_penalty")
        c["pick_score"] = score
        c["pick_note"] = m.get("error") or "facecrop"
        if score > best_score:
            best_score = score
            best_id = c.get("id")

    if best_id is None:
        best_id = done[0].get("id")
    for c in candidates:
        c["is_picked"] = c.get("id") == best_id
    return best_id, candidates
