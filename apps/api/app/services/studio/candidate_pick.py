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
    # 密采样：避免只踩到手部特写帧导致 face_mean=null（雨夜镜1 v2 候选2）
    if n <= 1:
        idxs = [0]
    else:
        idxs = sorted({max(0, min(n - 1, int(round(x)))) for x in [
            0, n * 0.15, n * 0.35, n // 2, n * 0.65, n * 0.85, n - 1
        ]})
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
    cap.release()
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
) -> tuple[str | None, list[dict[str, Any]]]:
    """按 face_mean - burnin - ocr + 连贯加分 - 回退罚分 选优。

    选优失败抛 CandidatePickError（禁止静默回落首候选）。
    regression_ref_path：通常为镜0成片，扣「与开场过像」的回退候选。
    min_face_mean：人脸门禁（默认 0.45）；face_mean 为空或低于门禁的候选不得入选。
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

    face_ok = bool(
        ref_image_path and Path(ref_image_path).is_file() and _try_import_face()
    )
    have_cont_material = bool(prev_video_path or scene_ref_path)

    if not face_ok and not have_cont_material:
        for c in candidates:
            c["is_picked"] = False
            c.setdefault("pick_score", None)
            c["pick_note"] = "face_scorer_unavailable"
        raise CandidatePickError(
            "选优失败:人脸评分不可用且无连贯材料，禁止静默回落首候选"
        )

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
            if face_ok:
                m = score_video_face(path, ref_image_path)
                face = m.get("face_mean")
                pen = float(m.get("burnin_penalty") or 0) + float(m.get("ocr_penalty") or 0)
                c["face_mean"] = face
                c["burnin_penalty"] = m.get("burnin_penalty")
                c["ocr_penalty"] = m.get("ocr_penalty")
                note_parts.append(m.get("error") or "facecrop")
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
            if score > best_score:
                best_score = score
                best_id = c.get("id")

        if not scored_any or best_id is None:
            for c in candidates:
                c["is_picked"] = False
            raise CandidatePickError("选优失败:全部候选无法解析本地路径或评分")

        # 人脸门禁：仅在 face_mean≥阈值 的候选中按 score 入选；全员未过则失败
        if face_ok and float(min_face_mean) > 0:
            gated = [
                c
                for c in done
                if c.get("face_mean") is not None
                and float(c["face_mean"]) >= float(min_face_mean)
                and c.get("pick_score") is not None
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
                raise CandidatePickError(
                    f"选优失败:无人脸达标(需 face_mean≥{min_face_mean:.2f}，"
                    f"最佳={face_best!r})，禁止入选并应加候选重跑"
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
            emb = garment_chest_emblem_hit(image)
            out["emblem"] = {k: emb.get(k) for k in ("hit", "area_ratio", "blobs", "error")}
            if emb.get("hit"):
                out["hit"] = True
                if not out["text"]:
                    out["text"] = "chest_emblem_blob"
        return out
    except Exception as e:
        out["error"] = f"{type(e).__name__}:{e}"
        return out


def garment_brand_ocr_hit(video_path: str | Path) -> dict[str, Any]:
    """出片后衣物品牌 + 场景店招 OCR。hit True 时应换 seed 重跑。

    返回 {hit, text, frames_checked, error, kind?}；店招命中 text 带 sign: 前缀。
    pytesseract/cv2 不可用则 hit=False 不拦。品牌与店招共用调用方 max_submits 配额。
    """
    out: dict[str, Any] = {
        "hit": False,
        "text": "",
        "frames_checked": 0,
        "error": "",
        "kind": "",
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
        # 采前/中/后三帧（竖屏胸口常在中前段可见）
        if n <= 0:
            idxs = [0]
        elif n == 1:
            idxs = [0]
        else:
            # 密采样：图标型 logo 常只在若干秒可见；3 点会漏检
            step = max(1, n // 8)
            idxs = sorted({0, max(0, n - 1), *range(0, n, step)})
        texts: list[str] = []
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, frame = cap.read()
            if not ok or frame is None:
                continue
            out["frames_checked"] += 1
            fr = garment_brand_ocr_frame(frame)
            if fr.get("text"):
                texts.append(str(fr["text"]))
            if fr.get("hit"):
                out["hit"] = True
                out["kind"] = "brand"
                out["text"] = str(fr.get("text") or "chest_emblem_blob")[:200]
                out["emblem"] = fr.get("emblem") or {}
                return out
            # 店招/霓虹乱码：与品牌共用同一换 seed 配额
            sr = scene_sign_ocr_frame(frame)
            if sr.get("text"):
                texts.append("sign:" + str(sr["text"]))
            if sr.get("hit"):
                out["hit"] = True
                out["kind"] = "sign"
                out["text"] = ("sign:" + str(sr.get("text") or "sign_latin"))[:200]
                return out
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

