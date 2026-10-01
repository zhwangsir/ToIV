"""管线 C 多候选选优：裁脸相似度优先，疑似烧录字幕/乱码降权。

insightface / cv2 可用时走真评分。选优失败必须抛 CandidatePickError，
禁止静默回落首候选（掩盖假选优）。OCR 可选。
连贯分：奖励贴近上一镜末帧/场景参考；扣「与镜0首帧过像」的回退候选。
"""
from __future__ import annotations

import logging
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
