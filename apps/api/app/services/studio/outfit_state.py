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


# ───────────────── 镜头级参考图验收门禁（VLM 问答，2026-10-05 04:09 决策）─────────────────
# 背景：雨夜 shot1–3 帽兜放下版参考（Qwen-Edit）被人工驳回：帽兜仍在头上/成麻花辫/外套被改成衬衫领、
# 铆钉高领皮夹克/多出耳环。脸分（0.75–0.88）只能证明脸没变，CLIP 帽兜概率不可靠（仅告警）。
# 验收 = 四问全过 + 与原参考图脸相似度 ≥ REF_FACE_SIM_MIN。VLM 复用设定卡表情专项问答同一路径
# （Comfy Qwen2_VQA / Qwen3-VL，仅 :8262/:8264）。

REF_FACE_SIM_MIN = 0.75
OUTFIT_VLM_MODEL = "Qwen3-VL-8B-Instruct"
OUTFIT_VLM_QUESTIONS: tuple[tuple[str, str, tuple[str, ...], str], ...] = (
    ("hood_on_head", "图中人物的帽兜是否盖在头顶上？只答 是/否", ("是", "否"), "否"),
    (
        "same_jacket",
        "图中人物穿的是否是纯黑色、无 logo、无字的连帽风衣（带帽兜的防风外套；衬衫、衬衫领、"
        "皮夹克、铆钉夹克、高领夹克都不算）？只答 是/否",
        ("是", "否"),
        "是",
    ),
    ("accessories", "图中人物是否戴有耳环、项链、发饰等任何饰品？只答 是/否", ("是", "否"), "否"),
    ("hairstyle", "图中人物的发型是 马尾/麻花辫/披发 中的哪一种？只答其中一个词", ("马尾", "麻花辫", "披发"), "马尾"),
)


def parse_vlm_choice(raw: str, choices: tuple[str, ...]) -> str | None:
    """把 VLM 原始回答归一到 choices 之一；无法判定 → None（按不通过处理）。"""
    import re as _re

    t = _re.sub(r"<think>.*?</think>", "", str(raw or ""), flags=_re.S).strip()
    # Comfy PreviewAny 常把 STRING 列表序列化成 JSON（含 \\uXXXX 转义）：'[\n "\\u5426"\n]'
    if t.startswith("[") or "\\u" in t:
        import json as _json

        try:
            v = _json.loads(t)
            if isinstance(v, list):
                t = " ".join(str(x) for x in v)
            elif isinstance(v, str):
                t = v
        except ValueError:
            try:
                t = t.encode("utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8")
            except Exception:  # noqa: BLE001
                pass
        t = t.strip().strip("[]").strip()
    t = t.strip(" \n\t：:。.!！\"'“”`*")
    if not t:
        return None
    low = t.lower()
    if set(choices) == {"是", "否"}:
        head = t[:8]
        if head.startswith(("不确定", "无法", "不清楚", "看不清", "不能确定")) or low.startswith(("unsure", "uncertain", "can't", "cannot")):
            return None  # 不确定按不通过处理（不能让「帽兜是否在头上=不确定」被当成「否」放行）
        if head.startswith(("否", "不是", "没有", "无", "不")) or low.startswith("no"):
            return "否"
        if head.startswith(("是", "有")) or low.startswith("yes"):
            return "是"
        if "否" in head or "不是" in head:
            return "否"
        if "是" in head:
            return "是"
        return None
    if set(choices) == {"马尾", "麻花辫", "披发"}:
        hits = []
        for key, lab in (("麻花", "麻花辫"), ("辫", "麻花辫"), ("braid", "麻花辫"),
                         ("马尾", "马尾"), ("ponytail", "马尾"),
                         ("披", "披发"), ("loose", "披发")):
            i = low.find(key)
            if i >= 0:
                hits.append((i, lab))
        return min(hits)[1] if hits else None
    for c in choices:
        if c in t:
            return c
    return None


def outfit_vlm_verdict(answers: dict[str, str], face_sim: float | None, *, hood: str = "down") -> dict[str, Any]:
    """四问 + 脸分 → {pass, checks:[{key,question,raw,parsed,want,ok}], face_sim, face_ok, failed, hood}。

    hood="down"（默认）：帽兜须放下；hood="up"（ToIV 开发 05:19 方案1：镜1–3 全程戴帽）：帽兜须盖在头上。
    其余三问（同款风衣/无饰品/马尾）与脸分阈值不变。"""
    if hood not in ("down", "up"):
        raise ValueError(f"hood 只能是 down/up：{hood!r}")
    checks = []
    for key, q, choices, want in OUTFIT_VLM_QUESTIONS:
        if key == "hood_on_head" and hood == "up":
            want = "是"
        raw = answers.get(key)
        parsed = parse_vlm_choice(raw or "", choices)
        checks.append({"key": key, "question": q, "raw": raw, "parsed": parsed, "want": want,
                       "ok": parsed == want})
    face_ok = face_sim is not None and float(face_sim) >= REF_FACE_SIM_MIN
    failed = [c["key"] for c in checks if not c["ok"]] + ([] if face_ok else ["face_sim"])
    return {"pass": not failed, "checks": checks, "face_sim": face_sim, "face_ok": face_ok,
            "face_min": REF_FACE_SIM_MIN, "failed": failed, "hood": hood}



# ---- :8262 排队规则（ToIV 开发 04:30）：角色卡优先；其余任务每批 ≤8，上一批排空 + 间隔后再提交下一批 ----
QE_BATCH_MAX = 8
QE_BATCH_GAP_S = 15.0
QE_OUR_CLIENT_PREFIXES = ("outfit_qa_", "toiv-rain-")
_QE_LOCKS: dict = {}


def _is_char_sheet_job(q) -> bool:
    """队列项是否角色卡任务（filename_prefix 含 char_sheet，或输入图为 sheet_*）。"""
    wf = q[2] if len(q) > 2 and isinstance(q[2], dict) else {}
    for n in wf.values():
        inp = (n or {}).get("inputs") or {}
        if "char_sheet" in str(inp.get("filename_prefix", "")) or str(inp.get("image", "")).startswith("sheet_"):
            return True
    return False


def qe_queue_census(queue: dict, our_prefixes=QE_OUR_CLIENT_PREFIXES) -> dict:
    """/queue → {char_sheet: 角色卡在队数, char_sheet_pending: 角色卡排队数, ours: 我方在队数(running+pending), ours_pending_ids}。"""
    cs = csp = ours = 0
    ours_pending: list[str] = []
    for k in ("queue_running", "queue_pending"):
        for q in queue.get(k) or []:
            cid = str(((q[3] if len(q) > 3 else None) or {}).get("client_id") or "")
            if _is_char_sheet_job(q):
                cs += 1
                csp += k == "queue_pending"
            elif cid.startswith(tuple(our_prefixes)):
                ours += 1
                if k == "queue_pending":
                    ours_pending.append(q[1])
    return {"char_sheet": cs, "char_sheet_pending": csp, "ours": ours, "ours_pending_ids": ours_pending}


async def wait_qe_batch_slot(client, n_new: int, *, gap_s: float = QE_BATCH_GAP_S,
                             poll_s: float = 5.0, max_wait_s: float = 3600.0, sleep=None) -> dict:
    """提交一批前阻塞：n_new ≤ 8；等我方上一批全部排空且无角色卡在排队（正在跑的那个不算，
    否则角色卡连续串行提交时会永久饿死），再隔 gap_s 复核一次。"""
    import asyncio

    if n_new > QE_BATCH_MAX:
        raise ValueError(f":8262 每批最多 {QE_BATCH_MAX} 个任务，本批 {n_new}")
    sleep = sleep or asyncio.sleep
    waited = 0.0
    gap_done = False
    while True:
        c = qe_queue_census(await client._get_json("/queue"))
        if c["ours"] == 0 and c["char_sheet_pending"] == 0:
            if gap_done:
                return c
            await sleep(gap_s)
            waited += gap_s
            gap_done = True
            continue
        gap_done = False
        if waited >= max_wait_s:
            raise TimeoutError(f":8262 等待批次空位超时 {max_wait_s}s：{c}")
        await sleep(poll_s)
        waited += poll_s


async def ask_outfit_vlm(
    image_bytes: bytes,
    *,
    worker_url: str = "http://100.68.100.90:8262",
    model: str = OUTFIT_VLM_MODEL,
    timeout_s: float = 600.0,
    seed: int = 42,
    batch_kw: dict | None = None,
) -> dict[str, str]:
    """四问各提交一次 Comfy Qwen2_VQA（排队，不打断他人）；返回 {key: 原始回答}。仅允许 :8262/:8264。"""
    import asyncio

    from app.comfy.client import ComfyUIClient
    from app.services.studio.character_sheet import _assert_sheet_worker_allowed

    url = str(worker_url).rstrip("/")
    _assert_sheet_worker_allowed(url)
    client = ComfyUIClient(url, timeout=180.0)
    lock = _QE_LOCKS.setdefault(url, asyncio.Lock())
    async with lock:  # 同进程内逐图串行：一图一批（4 问 ≤ 8）
        await wait_qe_batch_slot(client, len(OUTFIT_VLM_QUESTIONS), **(batch_kw or {}))
        return await _ask_outfit_vlm_batch(client, image_bytes, model=model, seed=seed, timeout_s=timeout_s)


async def _ask_outfit_vlm_batch(client, image_bytes: bytes, *, model: str, seed: int, timeout_s: float) -> dict[str, str]:
    import asyncio
    import uuid

    from app.services.studio.character_sheet import _extract_history_text, build_expression_vlm_graph

    fname = await client.upload_image(image_bytes, f"outfit_qa_{uuid.uuid4().hex[:10]}.png")
    pids: dict[str, str] = {}
    for key, q, _choices, _want in OUTFIT_VLM_QUESTIONS:
        g = build_expression_vlm_graph(fname, prompt=q, model=model, seed=seed, backend="Qwen2_VQA")
        g["2"]["inputs"]["max_new_tokens"] = 128  # 节点下限 128
        g["2"]["inputs"]["temperature"] = 0.1
        pids[key] = await client.queue_prompt(g, client_id=f"outfit_qa_{uuid.uuid4().hex[:8]}")
    out: dict[str, str] = {}
    waited = 0.0
    while len(out) < len(pids) and waited < timeout_s:
        for key, pid in pids.items():
            if key in out:
                continue
            hist = await client.get_history(pid)
            entry = (hist or {}).get(pid) or {}
            st = (entry.get("status") or {}).get("status_str")
            if entry.get("outputs"):
                txt = _extract_history_text(entry)
                if txt:
                    out[key] = txt
            elif st == "error":
                out[key] = ""
        if len(out) < len(pids):
            await asyncio.sleep(2.0)
            waited += 2.0
    left = [pids[k] for k in pids if k not in out]
    if left:  # 超时：撤掉我方仍在排队的任务，不留孤儿占 :8262（不打断正在跑的）
        try:
            await client.delete_from_queue(left)
        except Exception:  # noqa: BLE001
            pass
    for key in pids:
        out.setdefault(key, "")
    return out


def face_similarity(img_bgr, ref_bgr) -> float | None:
    """与选优门禁同一 InsightFace（最大脸 normed_embedding 余弦）。"""
    import numpy as np

    from app.services.studio.candidate_pick import _get_face_app

    fa = _get_face_app()

    def _emb(im):
        fs = fa.get(im)
        if not fs:
            return None
        f = max(fs, key=lambda f: (f.bbox[2] - f.bbox[0]) * (f.bbox[3] - f.bbox[1]))
        e = f.normed_embedding
        return e / np.linalg.norm(e)

    a, b = _emb(img_bgr), _emb(ref_bgr)
    if a is None or b is None:
        return None
    return float(np.dot(a, b))


async def scene_ref_gate(
    image_bytes: bytes,
    original_bytes: bytes,
    *,
    ask_fn=None,
    face_fn=None,
    hood: str = "down",
) -> dict[str, Any]:
    """镜头级参考图验收：VLM 四问 + 脸分（vs 原参考）≥0.75。CLIP 不参与（仍只在 hood_state_log 告警）。"""
    import cv2
    import numpy as np

    img = cv2.imdecode(np.frombuffer(image_bytes, np.uint8), cv2.IMREAD_COLOR)
    ref = cv2.imdecode(np.frombuffer(original_bytes, np.uint8), cv2.IMREAD_COLOR)
    sim = (face_fn or face_similarity)(img, ref)
    answers = await (ask_fn or ask_outfit_vlm)(image_bytes)
    v = outfit_vlm_verdict(answers, sim, hood=hood)
    v["answers"] = answers
    return v


def ref_overrides_gate_check(overrides: dict[str, str] | None, gate_record: dict[str, Any] | None) -> dict[str, Any]:
    """镜头级参考覆盖启用前的验收核对：每个替换图（按文件名）都必须在验收记录里且 pass=True。

    gate_record 为 scripts/chybrid_ref_gate.py 输出（{name: verdict{image, url?, pass, failed, ...}}）。
    返回 {ok, passed:[文件名], missing:[文件名], failed:{文件名: failed_keys}}。
    """
    out: dict[str, Any] = {"ok": True, "passed": [], "missing": [], "failed": {}}
    if not overrides:
        return out
    by_name: dict[str, dict[str, Any]] = {}
    for v in (gate_record or {}).values():
        if not isinstance(v, dict):
            continue
        for k in ("url", "image"):
            if v.get(k):
                by_name[str(v[k]).rsplit("/", 1)[-1]] = v
    for new in overrides.values():
        name = str(new).rsplit("/", 1)[-1]
        v = by_name.get(name)
        if v is None:
            out["missing"].append(name)
        elif not v.get("pass"):
            out["failed"][name] = list(v.get("failed") or ["not_pass"])
        else:
            out["passed"].append(name)
    out["ok"] = not out["missing"] and not out["failed"]
    return out
