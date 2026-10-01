"""短剧选优场景门禁：CLIP（open_clip ViT-L/14）+ Florence-2 caption 交叉核对。

入选需 face_mean≥阈值 且 scene_gate=pass。启发式易误放（如雨夜镜2 46635），
本模块以模型判定为准。
"""
from __future__ import annotations

import logging
import os
import re
from pathlib import Path
from typing import Any, Callable, Sequence

logger = logging.getLogger(__name__)

DEFAULT_POSITIVE = (
    "woman in black raincoat, hood down, medium shot, "
    "inside convenience store at checkout counter"
)
DEFAULT_NEGATIVES = (
    "outdoor rain close-up portrait",
    "hood up covering head in rain",
    "hands close-up",
    "back view",
    "street night rain face close-up",
)

# Florence / caption 出现这些词 → 场景否（户外/街景）
_CAPTION_REJECT_RE = re.compile(
    r"\b(outdoor|outside|street|alley|roadside|rain\s*night|night\s*rain|"
    r"in\s+the\s+rain|umbrella\s+rain|dark\s+street)\b",
    re.I,
)
_CAPTION_INDOOR_HINT_RE = re.compile(
    r"\b(convenience\s*store|checkout|cashier|counter|aisle|indoor|inside|"
    r"shop|store\s+interior|fluorescent)\b",
    re.I,
)

FrameScorer = Callable[[Path, str, Sequence[str]], dict[str, Any]]
Captioner = Callable[[Path], str]


class SceneGateError(RuntimeError):
    """场景门禁依赖不可用或帧无法评分。"""


def decide_scene_gate(
    frame_results: Sequence[dict[str, Any]],
    *,
    min_pass_frames: int = 2,
) -> dict[str, Any]:
    """根据每帧 CLIP/caption 结果做最终判定（纯逻辑，便于单测）。

    每帧需含：
      pos_score: float
      neg_scores: dict[str, float] 或 list[float]
      caption: str（可空）
      pass_clip: 可选，缺省时用 pos>每个 neg 计算
    规则：
      - CLIP：正向分须严格高于每一个反向分
      - caption：含 outdoor/street/rain night 等 → 该帧否
      - 三帧中至少 min_pass_frames 帧同时过 CLIP（且未被 caption 否）
    """
    frames_out: list[dict[str, Any]] = []
    n_pass = 0
    for fr in frame_results:
        pos = float(fr.get("pos_score") if fr.get("pos_score") is not None else -1e9)
        neg_raw = fr.get("neg_scores") or {}
        if isinstance(neg_raw, dict):
            neg_items = list(neg_raw.items())
            neg_vals = [float(v) for _, v in neg_items]
        else:
            neg_items = [(str(i), float(v)) for i, v in enumerate(neg_raw)]
            neg_vals = [float(v) for v in neg_raw]
        if "pass_clip" in fr and fr["pass_clip"] is not None:
            pass_clip = bool(fr["pass_clip"])
        else:
            pass_clip = bool(neg_vals) and all(pos > v for v in neg_vals)
            if not neg_vals:
                pass_clip = False
        caption = str(fr.get("caption") or "")
        caption_reject = bool(caption and _CAPTION_REJECT_RE.search(caption))
        # 有 caption 且无任何室内提示、又很短时不单独否；仅明确户外词否
        frame_pass = pass_clip and not caption_reject
        if frame_pass:
            n_pass += 1
        frames_out.append(
            {
                "path": fr.get("path"),
                "pos_score": pos,
                "neg_scores": dict(neg_items) if neg_items else {},
                "pass_clip": pass_clip,
                "caption": caption,
                "caption_reject": caption_reject,
                "pass": frame_pass,
            }
        )
    status = "pass" if n_pass >= int(min_pass_frames) else "fail"
    return {
        "scene_gate": status,
        "pass": status == "pass",
        "n_pass_frames": n_pass,
        "min_pass_frames": int(min_pass_frames),
        "frames": frames_out,
    }


def extract_video_frames(
    video_path: str | Path,
    *,
    ratios: Sequence[float] = (0.2, 0.5, 0.7),
    out_dir: str | Path | None = None,
) -> list[Path]:
    """抽 t2/t5/t7（默认 0.2/0.5/0.7）帧，返回 jpg 路径列表。"""
    import cv2

    vid = Path(video_path)
    if not vid.is_file():
        raise SceneGateError(f"视频不存在: {vid}")
    dest = Path(out_dir) if out_dir else vid.parent / f"{vid.stem}_scene_frames"
    dest.mkdir(parents=True, exist_ok=True)
    cap = cv2.VideoCapture(str(vid))
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT) or 0)
    fps = float(cap.get(cv2.CAP_PROP_FPS) or 0) or 24.0
    paths: list[Path] = []
    labels = ("t2", "t5", "t7")
    for lab, ratio in zip(labels, ratios):
        if n > 1:
            idx = max(0, min(n - 1, int(round((n - 1) * float(ratio)))))
        else:
            idx = 0
        cap.set(cv2.CAP_PROP_POS_FRAMES, idx)
        ok, frame = cap.read()
        if not ok or frame is None:
            # 时间戳回退
            cap.set(cv2.CAP_PROP_POS_MSEC, 1000.0 * float(ratio) * max(1.0, n / fps))
            ok, frame = cap.read()
        if not ok or frame is None:
            continue
        out = dest / f"{lab}.jpg"
        cv2.imwrite(str(out), frame)
        paths.append(out)
    cap.release()
    if len(paths) < 2:
        raise SceneGateError(f"抽帧不足: {vid} got={len(paths)}")
    return paths


def _default_clip_python() -> str | None:
    return os.environ.get("TOIV_OPENCLIP_PYTHON") or os.environ.get("TOIV_SCENE_GATE_PYTHON")


def score_frame_clip_openclip(
    frame_path: Path,
    positive: str,
    negatives: Sequence[str],
    *,
    model_name: str = "ViT-L-14",
    pretrained: str = "openai",
    device: str | None = None,
) -> dict[str, Any]:
    """本进程加载 open_clip 打分（需 torch+open_clip）。"""
    import open_clip
    import torch
    from PIL import Image

    if device is None:
        device = os.environ.get("TOIV_SCENE_GATE_DEVICE") or (
            "cuda:0" if torch.cuda.is_available() else "cpu"
        )
        # 硬规则：不用 cuda:3
        if device.startswith("cuda:") and device.split(":")[-1] == "3":
            device = "cuda:0" if torch.cuda.device_count() > 0 else "cpu"

    model, _, preprocess = open_clip.create_model_and_transforms(
        model_name, pretrained=pretrained
    )
    model = model.to(device).eval()
    tokenizer = open_clip.get_tokenizer(model_name)
    texts = [positive, *list(negatives)]
    tok = tokenizer(texts).to(device)
    img = preprocess(Image.open(frame_path).convert("RGB")).unsqueeze(0).to(device)
    with torch.no_grad():
        tfeat = model.encode_text(tok)
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)
        ifeat = model.encode_image(img)
        ifeat = ifeat / ifeat.norm(dim=-1, keepdim=True)
        raw = (ifeat @ tfeat.T).squeeze(0)
    pos = float(raw[0])
    neg_scores = {n: float(raw[i + 1]) for i, n in enumerate(negatives)}
    return {
        "path": str(frame_path),
        "pos_score": pos,
        "neg_scores": neg_scores,
        "pass_clip": all(pos > v for v in neg_scores.values()),
        "device": device,
        "model": f"{model_name}:{pretrained}",
    }


_CLIP_CACHE: dict[str, Any] = {}


def _cached_openclip(device: str, model_name: str, pretrained: str):
    key = f"{device}|{model_name}|{pretrained}"
    if key in _CLIP_CACHE:
        return _CLIP_CACHE[key]
    import open_clip

    model, _, preprocess = open_clip.create_model_and_transforms(
        model_name, pretrained=pretrained
    )
    model = model.to(device).eval()
    tokenizer = open_clip.get_tokenizer(model_name)
    _CLIP_CACHE[key] = (model, preprocess, tokenizer, device)
    return _CLIP_CACHE[key]


def score_frames_clip(
    frame_paths: Sequence[Path],
    *,
    positive: str = DEFAULT_POSITIVE,
    negatives: Sequence[str] = DEFAULT_NEGATIVES,
    scorer: FrameScorer | None = None,
) -> list[dict[str, Any]]:
    """对多帧打 CLIP 分。可注入 scorer 便于单测。"""
    if scorer is not None:
        return [scorer(Path(p), positive, negatives) for p in frame_paths]

    try:
        import open_clip  # noqa: F401
        import torch
        from PIL import Image  # noqa: F401
    except Exception as e:
        raise SceneGateError(f"open_clip/torch 不可用: {e}") from e

    device = os.environ.get("TOIV_SCENE_GATE_DEVICE")
    if not device:
        device = "cuda:0" if torch.cuda.is_available() else "cpu"
    if device.endswith(":3"):
        device = "cpu"
    model, preprocess, tokenizer, device = _cached_openclip(
        device, "ViT-L-14", "openai"
    )
    texts = [positive, *list(negatives)]
    tok = tokenizer(texts).to(device)
    import torch as _torch
    from PIL import Image

    with _torch.no_grad():
        tfeat = model.encode_text(tok)
        tfeat = tfeat / tfeat.norm(dim=-1, keepdim=True)

    out: list[dict[str, Any]] = []
    for p in frame_paths:
        img = preprocess(Image.open(p).convert("RGB")).unsqueeze(0).to(device)
        with _torch.no_grad():
            ifeat = model.encode_image(img)
            ifeat = ifeat / ifeat.norm(dim=-1, keepdim=True)
            raw = (ifeat @ tfeat.T).squeeze(0)
        pos = float(raw[0])
        neg_scores = {n: float(raw[i + 1]) for i, n in enumerate(negatives)}
        out.append(
            {
                "path": str(p),
                "pos_score": pos,
                "neg_scores": neg_scores,
                "pass_clip": all(pos > v for v in neg_scores.values()),
                "caption": "",
            }
        )
    return out


def caption_florence_comfy(
    frame_path: Path,
    *,
    comfy_url: str | None = None,
    timeout_sec: float = 120.0,
) -> str:
    """经 Comfy :8197 Florence-2 出 caption；节点不可用时返回空串（不阻断 CLIP）。"""
    import json
    import urllib.error
    import urllib.request
    import uuid

    base = (comfy_url or os.environ.get("TOIV_FLORENCE_COMFY_URL") or "").rstrip("/")
    if not base:
        return ""
    # 探测节点
    try:
        with urllib.request.urlopen(base + "/object_info", timeout=8) as resp:
            info = json.loads(resp.read().decode())
    except Exception as e:
        logger.info("Florence Comfy object_info 失败: %s", e)
        return ""
    run_node = next((k for k in info if "Florence2Run" in k), None)
    load_node = next((k for k in info if "Florence2ModelLoader" in k), None)
    if not run_node or not load_node:
        logger.info("Florence 节点不在 %s", base)
        return ""
    # 简化：上传图像后跑 caption 工作流（若环境无完整节点则跳过）
    try:
        bound = {"image": ("image.jpg", Path(frame_path).read_bytes(), "image/jpeg")}
        # multipart 手写过重；改为把文件放 input 目录的 HTTP 上传
        import mimetypes

        boundary = uuid.uuid4().hex
        body = bytearray()
        filename = Path(frame_path).name
        mime = mimetypes.guess_type(filename)[0] or "application/octet-stream"
        body.extend(f"--{boundary}\r\n".encode())
        body.extend(
            f'Content-Disposition: form-data; name="image"; filename="{filename}"\r\n'.encode()
        )
        body.extend(f"Content-Type: {mime}\r\n\r\n".encode())
        body.extend(Path(frame_path).read_bytes())
        body.extend(b"\r\n")
        body.extend(f"--{boundary}--\r\n".encode())
        req = urllib.request.Request(
            base + "/upload/image",
            data=bytes(body),
            headers={"Content-Type": f"multipart/form-data; boundary={boundary}"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            up = json.loads(resp.read().decode())
        image_name = up.get("name") or filename
    except Exception as e:
        logger.info("Florence 上传帧失败: %s", e)
        return ""

    prompt = {
        "1": {
            "class_type": load_node,
            "inputs": {"model": "microsoft/Florence-2-base", "precision": "fp16"},
        },
        "2": {
            "class_type": "LoadImage",
            "inputs": {"image": image_name},
        },
        "3": {
            "class_type": run_node,
            "inputs": {
                "florence2_model": ["1", 0],
                "image": ["2", 0],
                "task": "more_detailed_caption",
                "text_input": "",
                "max_new_tokens": 64,
                "num_beams": 3,
                "do_sample": False,
            },
        },
    }
    try:
        data = json.dumps({"prompt": prompt}).encode()
        req = urllib.request.Request(
            base + "/prompt",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=30) as resp:
            sub = json.loads(resp.read().decode())
        pid = sub.get("prompt_id")
        if not pid:
            return ""
        import time

        deadline = time.time() + timeout_sec
        while time.time() < deadline:
            with urllib.request.urlopen(base + f"/history/{pid}", timeout=15) as resp:
                hist = json.loads(resp.read().decode())
            if pid in hist:
                outputs = hist[pid].get("outputs") or {}
                for node_out in outputs.values():
                    for key in ("text", "caption", "string"):
                        if key in node_out:
                            val = node_out[key]
                            if isinstance(val, list) and val:
                                return str(val[0])
                            if isinstance(val, str):
                                return val
                # 某些节点把 caption 放在 ui
                ui = (hist[pid].get("status") or {}).get("messages") or []
                return ""
            time.sleep(1.0)
    except Exception as e:
        logger.info("Florence 推理失败: %s", e)
        return ""
    return ""


def gate_frames(
    frame_paths: Sequence[str | Path],
    *,
    positive: str = DEFAULT_POSITIVE,
    negatives: Sequence[str] = DEFAULT_NEGATIVES,
    min_pass_frames: int = 2,
    scorer: FrameScorer | None = None,
    captioner: Captioner | None = None,
    florence_comfy_url: str | None = None,
) -> dict[str, Any]:
    """对已有帧做场景门禁，写入 scene_gate 字段结构。"""
    paths = [Path(p) for p in frame_paths]
    scored = score_frames_clip(
        paths, positive=positive, negatives=negatives, scorer=scorer
    )
    cap_fn = captioner
    if cap_fn is None and (florence_comfy_url or os.environ.get("TOIV_FLORENCE_COMFY_URL")):
        url = florence_comfy_url or os.environ.get("TOIV_FLORENCE_COMFY_URL")

        def cap_fn(p: Path) -> str:
            return caption_florence_comfy(p, comfy_url=url)

    if cap_fn is not None:
        for fr in scored:
            try:
                fr["caption"] = cap_fn(Path(fr["path"])) or ""
            except Exception as e:
                fr["caption"] = ""
                fr["caption_error"] = str(e)
    result = decide_scene_gate(scored, min_pass_frames=min_pass_frames)
    result["positive"] = positive
    result["negatives"] = list(negatives)
    return result


def gate_video(
    video_path: str | Path,
    *,
    positive: str = DEFAULT_POSITIVE,
    negatives: Sequence[str] = DEFAULT_NEGATIVES,
    min_pass_frames: int = 2,
    scorer: FrameScorer | None = None,
    captioner: Captioner | None = None,
    florence_comfy_url: str | None = None,
    frame_dir: str | Path | None = None,
) -> dict[str, Any]:
    """抽 t2/t5/t7 → CLIP + Florence → scene_gate pass/fail。"""
    frames = extract_video_frames(video_path, out_dir=frame_dir)
    result = gate_frames(
        frames,
        positive=positive,
        negatives=negatives,
        min_pass_frames=min_pass_frames,
        scorer=scorer,
        captioner=captioner,
        florence_comfy_url=florence_comfy_url,
    )
    result["video_path"] = str(video_path)
    result["frame_paths"] = [str(p) for p in frames]
    return result
