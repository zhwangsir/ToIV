"""c_hybrid 服装/帽兜状态一致性（仅记录，不拦不扣分）。

2026-10-05 雨夜 shot1（931f3b96）：前 ~127 帧帽兜放下，之后戴上；镜内状态跳变。
做法：人脸锚定头部裁剪 → open_clip ViT-B-32 零样本「帽兜戴上 / 放下」概率。
实测 931f：放下帧 p_up≈0.08–0.10，戴上帧 0.15–0.43，余量小；背影无脸（含 shot0 尾帧）无法判定。
→ 不够稳，只写 hood_log（reliable=False），供人工复核与后续标定。
"""
from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

HOOD_UP_MIN = 0.15  # p_up ≥ → up
HOOD_DOWN_MAX = 0.11  # p_up ≤ → down；中间 = unsure
HOOD_SAMPLES = 12
_UP_TEXTS = (
    "a photo of a woman wearing a hood pulled up over her head",
    "a person with the jacket hood up covering the head",
)
_DOWN_TEXTS = (
    "a photo of a woman with her hood down and her hair visible",
    "a person with bare head, hair tied, hood resting on the back",
)
_CLIP = None


def _clip():
    global _CLIP
    if _CLIP is None:
        import torch
        from app.services.studio.scene_gate import _cached_openclip

        model, preprocess, tok, dev = _cached_openclip("cpu", "ViT-B-32", "openai")
        with torch.no_grad():
            te = model.encode_text(tok(list(_UP_TEXTS + _DOWN_TEXTS)).to(dev))
            te = te / te.norm(dim=-1, keepdim=True)
        _CLIP = (model, preprocess, te, dev)
    return _CLIP


def _head_crop(frame_bgr, face_app):
    faces = face_app.get(frame_bgr)
    if not faces:
        return None
    f = max(faces, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
    x1, y1, x2, y2 = [float(v) for v in f.bbox]
    fw, fh = x2 - x1, y2 - y1
    h, w = frame_bgr.shape[:2]
    return frame_bgr[
        max(0, int(y1 - 0.9 * fh)) : min(h, int(y2 + 0.3 * fh)),
        max(0, int(x1 - 0.8 * fw)) : min(w, int(x2 + 0.8 * fw)),
    ]


def hood_up_prob(frame_bgr, face_app) -> float | None:
    """单帧帽兜戴上概率；无脸 → None。"""
    import cv2
    import torch
    from PIL import Image

    crop = _head_crop(frame_bgr, face_app)
    if crop is None or crop.size == 0:
        return None
    model, preprocess, te, dev = _clip()
    t = preprocess(Image.fromarray(cv2.cvtColor(crop, cv2.COLOR_BGR2RGB))).unsqueeze(0).to(dev)
    with torch.no_grad():
        ie = model.encode_image(t)
        ie = ie / ie.norm(dim=-1, keepdim=True)
        p = (100.0 * ie @ te.T).softmax(-1)[0].cpu().numpy()
    return float(p[: len(_UP_TEXTS)].sum())


def _state(p: float | None) -> str:
    if p is None:
        return "unknown"
    if p >= HOOD_UP_MIN:
        return "up"
    if p <= HOOD_DOWN_MAX:
        return "down"
    return "unsure"


def check_refs_vs_first_frame(
    first_frame_bgr,
    refs: list[dict[str, Any]],
    *,
    expected_text: str | None = None,
    prob_fn=None,
) -> dict[str, Any]:
    """参考图 vs 首帧 帽兜状态一致性（c_hybrid 提交前）。只告警，不拦、不自动换图。

    refs: [{label, url, image(bgr), overridden(bool)}]（场景图可不传）。
    目标状态 target = 首帧状态（有脸可判时），否则回落文字口径 expected_text（prompt 的 hood up/down）。
    参考图状态可判且 ≠ target → mismatches，action="warn"；已被镜头级覆盖（overridden）的参考图记
    overridden_ok。prob_fn 默认人脸锚定头部 CLIP（余量小、背影无脸=unknown，故 reliable=False）。
    """
    out: dict[str, Any] = {
        "first_frame": None, "expected_text": expected_text, "target": None,
        "refs": [], "mismatches": [], "action": "ok", "reliable": False, "error": "",
    }
    try:
        if prob_fn is None:
            from app.services.studio.candidate_pick import _get_face_app

            fa = _get_face_app()
            prob_fn = lambda fr: hood_up_prob(fr, fa)  # noqa: E731
        ff_p = prob_fn(first_frame_bgr) if first_frame_bgr is not None else None
        ff_state = _state(ff_p)
        out["first_frame"] = {"p_up": None if ff_p is None else round(ff_p, 3), "state": ff_state}
        target = ff_state if ff_state in ("up", "down") else (expected_text if expected_text in ("up", "down") else None)
        out["target"] = target
        for r in refs:
            img = r.get("image")
            p = prob_fn(img) if img is not None else None
            st = _state(p)
            item = {"label": r.get("label", ""), "url": r.get("url", ""),
                    "p_up": None if p is None else round(p, 3), "state": st,
                    "overridden": bool(r.get("overridden"))}
            out["refs"].append(item)
            if target and st in ("up", "down") and st != target:
                out["mismatches"].append(item["label"] or item["url"])
        if out["mismatches"]:
            out["action"] = "warn"
            logger.warning(
                "outfit_state 参考图与首帧帽兜状态不一致 target=%s first_frame=%s mismatches=%s；"
                "建议用镜头级参考覆盖（ref_overrides）换成与首帧一致的版本",
                target, out["first_frame"], out["mismatches"],
            )
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}:{e}"[:200]
    return out


def hood_state_log(
    video_path: str | Path,
    *,
    prev_video_path: str | Path | None = None,
    skip_until_frame: int = 0,
    samples: int = HOOD_SAMPLES,
    prob_fn=None,
) -> dict[str, Any]:
    """返回 {frames:[{frame,p_up,state}], states, changes, prev_tail, mismatch_prev, reliable=False, error}。仅日志。"""
    out: dict[str, Any] = {
        "frames": [], "changes": 0, "prev_tail": None, "mismatch_prev": None,
        "reliable": False, "log_only": True, "error": "",
    }
    p = Path(video_path)
    if not p.is_file():
        out["error"] = "missing_video"
        return out
    try:
        import cv2
    except Exception as e:  # noqa: BLE001
        out["error"] = f"cv2_unavailable:{type(e).__name__}"
        return out
    cap = cv2.VideoCapture(str(p))
    if not cap.isOpened():
        out["error"] = "open_failed"
        return out
    try:
        n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
        if n <= 0:
            out["error"] = "no_frames"
            return out
        if prob_fn is None:
            from app.services.studio.candidate_pick import _get_face_app

            fa = _get_face_app()
            prob_fn = lambda fr: hood_up_prob(fr, fa)  # noqa: E731
        start = min(max(0, int(skip_until_frame or 0)), n - 1)
        k = max(2, int(samples))
        idxs = sorted({start + int(round(j * (n - 1 - start) / (k - 1))) for j in range(k)})
        last = None
        for i in idxs:
            cap.set(cv2.CAP_PROP_POS_FRAMES, i)
            ok, fr = cap.read()
            if not ok or fr is None:
                continue
            pu = prob_fn(fr)
            st = _state(pu)
            out["frames"].append({"frame": i, "p_up": None if pu is None else round(pu, 3), "state": st})
            if st in ("up", "down"):
                if last is not None and st != last:
                    out["changes"] += 1
                last = st
        first = next((f["state"] for f in out["frames"] if f["state"] in ("up", "down")), None)
        if prev_video_path and Path(prev_video_path).is_file():
            pc = cv2.VideoCapture(str(prev_video_path))
            pn = int(pc.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
            pc.set(cv2.CAP_PROP_POS_FRAMES, max(0, pn - 1))
            ok, tail = pc.read()
            pc.release()
            if ok and tail is not None:
                pt = prob_fn(tail)
                out["prev_tail"] = {"p_up": None if pt is None else round(pt, 3), "state": _state(pt)}
                ps = out["prev_tail"]["state"]
                if ps in ("up", "down") and first:
                    out["mismatch_prev"] = ps != first
        if out["changes"] or out["mismatch_prev"]:
            logger.info("hood_state log-only %s changes=%s mismatch_prev=%s frames=%s",
                        p.name, out["changes"], out["mismatch_prev"], out["frames"])
        return out
    except Exception as e:  # noqa: BLE001
        out["error"] = f"{type(e).__name__}:{e}"[:200]
        return out
    finally:
        cap.release()
