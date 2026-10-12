#!/usr/bin/env python3
"""ToIV production capability gap scan: all core apps vs Comfy workers."""
from __future__ import annotations

import concurrent.futures as cf
import json
import os
import re
import sys
import time
import traceback
import urllib.error
import urllib.request
from collections import Counter, defaultdict
from pathlib import Path
from urllib.parse import quote

CORE = os.environ.get("TOIV_CORE", "http://192.168.71.47:8090").rstrip("/")
OUT = Path(os.environ.get(
    "TOIV_GAP_OUT",
    # 默认写到仓库内 tmp(不覆盖 .regen_tmp 下的历史证据快照,如 capability_gap_scan_market_reset_20261010)
    "/Users/wangzhenyu/Desktop/ALLProject/ToIV/tmp/gap_scan_latest",
))
EMAIL = os.environ.get("TOIV_EMAIL", "admin")
PASSWORD = os.environ.get("TOIV_PASSWORD", "admin123")

MODEL_INPUT_KEYS = {
    "ckpt_name", "unet_name", "lora_name", "vae_name", "clip_name",
    "control_net_name", "model_name", "style_model_name", "model", "lora",
    "gemma_path", "text_encoder", "model_path", "audio_vae_name",
    "clip_vision_name", "ipadapter_file", "upscale_model", "weight_name",
    "gguf_name", "unet_gguf", "clip1", "clip2", "clip3", "vae",
    "diffusion_model", "transformer_name", "mm_name",
}

MODEL_EXTS = (".safetensors", ".gguf", ".pt", ".pth", ".bin", ".ckpt", ".sft", ".onnx")

MODEL_FOLDERS = [
    "checkpoints", "diffusion_models", "unet", "unets", "loras", "vae", "vaes",
    "text_encoders", "clip", "clip_vision", "controlnet", "upscale_models",
    "embeddings", "photomaker", "style_models", "gligen", "hypernetworks",
    "model_patches", "animatediff_models", "animatediff_motion_lora",
    "ipadapter", "insightface", "ultralytics", "ultralytics_bbox", "ultralytics_segm",
    "sams", "LLM", "llm",
    "ggml", "configs", "jpeg_models", "frame_interpolation", "facerestore_models",
    "facedetection", "nsfw_detector", "grounding-dino", "OCR", "llm_gguf",
    # v3: folders previously exposed on workers but omitted (caused false missing_models)
    "onnx", "SEEDVR2", "pose", "detection",
    "audio_encoders", "vae_approx", "clip_gguf",
    # v22b: ComfyUI-GGUF lists via /models/unet_gguf (NOT /models/unet which 404s by design)
    "unet_gguf", "pulid",
    "instantid", "mmdets", "diffusers",
    # v12: RMBG folder (RMBG-2.0 lives under /models/RMBG/)
    "RMBG", "rmbg",
    # v13b: expanded folders previously present on workers but omitted from scan
    "latent_upscale_models",
    "vocal_separator",
    "MelBandRoFormer",
]

# 2026-10-13(W8 批3)一度置空,理由是「三台 worker 的 object_info 都装了 RHHiddenNodes shim」。
# 实弹部分推翻、部分支持该判断,故最终采取「**标注风险但不排除**」:
#   · shim 签名 = image_1(IMAGE,required) + image_2/3/4/pwd(optional) → 输出 IMAGE(手写图像多路器);
#   · RH 原图里 RHHiddenNodes 常用 `images_1`(复数)/`num_frames_2`,甚至有只给 `pwd` 的节点
#     (实证 app rh-acc-8847936513-e3edd5 节点 294/295/296)→ smoke 报
#     `RHHiddenNodes: Required input is missing image_1`(validation 失败);
#   · **但并非普遍致命**:生产 424 个用 RHHiddenNodes 的应用里,有 6 个 is_public=true 且 smoke=pass
#     (PG 实测)。一刀切排除会误杀这 6 个已证明可跑的。
# 结论:静态扫描只做**风险标注**(见 KNOWN_RISKY_NODES),可跑与否的最终裁判是 smoke 真跑
# (仓库既有纪律「盘上有 ≠ 产品在用」)。需要硬排除时用 TOIV_UNLOCALIZABLE_NODES=A,B 显式声明。
UNLOCALIZABLE_NODES = {
    n.strip() for n in os.environ.get("TOIV_UNLOCALIZABLE_NODES", "").split(",") if n.strip()
}

# 已知「shim 装着但签名可能与 RH 原图不符」的节点:命中即打 risk flag,供下游优先 smoke / 标注,
# 不参与 ok|blocked 判定。
KNOWN_RISKY_NODES = {"RHHiddenNodes"}

# Prefix / exact → suggested custom node package (owner/repo)
NODE_PACKAGE_HINTS = [
    (re.compile(r"^RHHiddenNodes$"), "RunningHub proprietary (unlocalizable)"),
    (re.compile(r"^SDVN"), "StableDiffusionVN/SDVN_Comfy_node"),
    (re.compile(r"^WanVideo"), "kijai/ComfyUI-WanVideoWrapper"),
    (re.compile(r"^VHS_"), "Kosinkadink/ComfyUI-VideoHelperSuite"),
    (re.compile(r"^Impact"), "ltdrdata/ComfyUI-Impact-Pack"),
    (re.compile(r"^UltralyticsDetectorProvider$|^SAMLoader$|^FaceDetailer"), "ltdrdata/ComfyUI-Impact-Pack"),
    (re.compile(r"^IPAdapter"), "cubiq/ComfyUI_IPAdapter_plus"),
    (re.compile(r"^Pulid|^ApplyPulid"), "cubiq/PuLID_ComfyUI"),
    (re.compile(r"^InstantID"), "cubiq/ComfyUI_InstantID"),
    (re.compile(r"^Nunchaku"), "nunchaku-tech/ComfyUI-nunchaku"),
    (re.compile(r"^HyVideo|^DownloadAndLoadHyVideo"), "kijai/ComfyUI-HunyuanVideoWrapper"),
    (re.compile(r"^Hy3D|^Hunyuan3D|^VoxelToMesh|^SaveGLB"), "kijai/ComfyUI-Hunyuan3DWrapper"),
    (re.compile(r"^LTXV|^LTXAV|^LTXAdd|^LTXIC"), "Lightricks/ComfyUI-LTXVideo"),
    (re.compile(r"^MiniMaxH3|^MinimaxH3"), "dedicated H3 instance (not pool)"),
    (re.compile(r"^LongCat|^WanAnimate|^WanPhantom|^WanVace|^WanVideoLongCat"), "dedicated LongCat/Animate instance"),
    (re.compile(r"^TextEncodeQwenImageEdit"), "dedicated Qwen-Edit instance / ComfyUI-QwenImageEdit"),
    (re.compile(r"^LayerUtility|^LayerMask|^LayerStyle"), "chflame163/ComfyUI_LayerStyle"),
    (re.compile(r"^easy "), "yoland68/ComfyUI-Easy-Use"),
    (re.compile(r"^CR "), "Suzie1/ComfyUI_Comfyroll_CustomNodes"),
    (re.compile(r"^DWPreprocessor|^OpenposePreprocessor|^CannyEdgePreprocessor|^DepthAnything|^MiDaS"), "Fannovel16/comfyui_controlnet_aux"),
    (re.compile(r"^RemBG|^ImageRemoveBackground"), "cubiq/ComfyUI_essentials"),
    (re.compile(r"^FrameInterpolat|^RIFE"), "Fannovel16/ComfyUI-Frame-Interpolation"),
    (re.compile(r"^Jjk"), "jjkramhoeft/ComfyUI-Jjk-Nodes"),
    (re.compile(r"^QwenEdit|^CropWithPadInfo"), "lrzjason/ComfyUI-EditUtils"),
    (re.compile(r"^FlowMatchEulerDiscreteScheduler"), "erosDiffusion/ComfyUI-EulerDiscreteScheduler"),
    (re.compile(r"^ACE_Step|^AceStep"), "ace-step related custom nodes"),
    (re.compile(r"^GGUF|^UnetLoaderGGUF|^CLIPLoaderGGUF"), "city96/ComfyUI-GGUF"),
    (re.compile(r"^VideoHelperSuite"), "Kosinkadink/ComfyUI-VideoHelperSuite"),
]


def suggested_package(class_type: str) -> str | None:
    for rx, pkg in NODE_PACKAGE_HINTS:
        if rx.search(class_type):
            return pkg
    return None


def http_json(url: str, *, method: str = "GET", data=None, headers=None, timeout=120):
    hdrs = dict(headers or {})
    body = None
    if data is not None:
        body = json.dumps(data).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(url, data=body, headers=hdrs, method=method)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        raw = resp.read()
        if not raw:
            return None
        return json.loads(raw.decode("utf-8"))


def login() -> str:
    d = http_json(f"{CORE}/api/auth/login", method="POST", data={"email": EMAIL, "password": PASSWORD})
    return d["token"]


def auth_headers(token: str) -> dict:
    return {"Authorization": f"Bearer {token}"}


def list_app_ids(token: str) -> list[dict]:
    """List endpoint returns slim rows (workflow_json=None). Keep id/name/public."""
    d = http_json(f"{CORE}/api/apps", headers=auth_headers(token), timeout=180)
    if not isinstance(d, list):
        items = d.get("items") or d.get("apps") or d.get("data") or []
    else:
        items = d
    return items


def fetch_app(token: str, aid: str) -> dict:
    url = f"{CORE}/api/apps/{quote(aid, safe='')}"
    return http_json(url, headers=auth_headers(token), timeout=120)


def normalize_graph(wj) -> dict:
    if not wj:
        return {}
    if isinstance(wj, str):
        wj = json.loads(wj)
    if not isinstance(wj, dict):
        return {}
    # UI format: {nodes:[{type, widgets_values}], links:...}
    if "nodes" in wj and isinstance(wj["nodes"], list) and not any(
        isinstance(v, dict) and "class_type" in v for v in wj.values()
    ):
        out = {}
        for i, n in enumerate(wj["nodes"]):
            if not isinstance(n, dict):
                continue
            ct = n.get("type") or n.get("class_type")
            if not ct:
                continue
            inputs = {}
            # best-effort: widgets often parallel input names unknown; skip values
            out[str(n.get("id", i))] = {"class_type": ct, "inputs": inputs}
        return out
    return wj


def looks_like_model(val: str) -> bool:
    if not val or not isinstance(val, str):
        return False
    s = val.strip()
    if not s or s.startswith(("http://", "https://", "data:")):
        return False
    # skip obvious non-files
    if s in ("default", "none", "None", "null", "auto", "Disable", "enable", "disable"):
        return False
    low = s.lower()
    if any(low.endswith(ext) for ext in MODEL_EXTS):
        return True
    # path-like without extension still maybe model folder entry
    return False


def extract_nodes_models(graph: dict) -> tuple[set[str], set[str]]:
    nodes: set[str] = set()
    models: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if isinstance(ct, str) and ct:
            nodes.add(ct)
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for key, val in inputs.items():
            if isinstance(val, str):
                if key in MODEL_INPUT_KEYS or looks_like_model(val):
                    if looks_like_model(val) or key in MODEL_INPUT_KEYS:
                        # only keep if looks like model file OR known key with path-ish value
                        if looks_like_model(val):
                            models.add(val)
                        elif key in MODEL_INPUT_KEYS and ("/" in val or "." in val) and len(val) > 3:
                            # e.g. folder paths without ext
                            if not val.replace("_", "").replace("-", "").isalnum() or "/" in val:
                                models.add(val)
            elif isinstance(val, list) and val and isinstance(val[0], str) and looks_like_model(val[0]):
                # rare: some nodes put [filename, ...]
                models.add(val[0])
    return nodes, models


def basename(p: str) -> str:
    return p.replace("\\", "/").split("/")[-1]


def fetch_worker_caps(base_url: str) -> dict:
    base = base_url.rstrip("/")
    nodes: set[str] = set()
    models: set[str] = set()  # as reported (may include subdir)
    models_by_folder: dict[str, list[str]] = {}
    err = None
    try:
        info = http_json(f"{base}/object_info", timeout=180)
        if isinstance(info, dict):
            nodes = set(info.keys())
            # also harvest combo options from loaders present
            loader_fields = [
                ("CheckpointLoaderSimple", "ckpt_name"),
                ("UNETLoader", "unet_name"),
                ("VAELoader", "vae_name"),
                ("CLIPLoader", "clip_name"),
                ("LoraLoader", "lora_name"),
                ("LoraLoaderModelOnly", "lora_name"),
                ("ControlNetLoader", "control_net_name"),
                ("UpscaleModelLoader", "model_name"),
                ("UnetLoaderGGUF", "unet_name"),
                ("CLIPLoaderGGUF", "clip_name"),
            ]
            for node, field in loader_fields:
                try:
                    ninfo = info.get(node) or {}
                    opts = ninfo.get("input", {}).get("required", {}).get(field, [[]])
                    if opts and isinstance(opts[0], list):
                        models.update(x for x in opts[0] if isinstance(x, str))
                    elif (len(opts) > 1 and isinstance(opts[0], str)
                          and isinstance(opts[1], dict)
                          and isinstance(opts[1].get("options"), list)):
                        models.update(x for x in opts[1]["options"] if isinstance(x, str))
                except Exception:
                    pass
    except Exception as e:
        err = f"object_info: {e}"

    for folder in MODEL_FOLDERS:
        try:
            lst = http_json(f"{base}/models/{folder}", timeout=60)
            if isinstance(lst, list):
                models_by_folder[folder] = [x for x in lst if isinstance(x, str)]
                models.update(models_by_folder[folder])
        except Exception:
            pass

    # v12: index basenames + each path segment + parent folder names for robust matching
    # e.g. listed "RMBG-2.0/model.safetensors" also indexes "RMBG-2.0", "model.safetensors"
    models_basenames = set()
    for m in models:
        n = m.replace("\\", "/")
        models_basenames.add(basename(n))
        parts = [p for p in n.split("/") if p]
        for seg in parts:
            models_basenames.add(seg)
        if len(parts) >= 2:
            models_basenames.add(parts[-2])  # parent dir basename
            models_basenames.add("/".join(parts[:-1]))  # parent path

    return {
        "url": base,
        "nodes": nodes,
        "models": models,
        "models_basenames": models_basenames,
        "models_by_folder": {k: len(v) for k, v in models_by_folder.items()},
        "error": err,
    }


def model_present(req: str, caps: dict) -> bool:
    """v12: match req against listed paths with folder/prefix tolerance.
    Example: req='RMBG-2.0', listed='RMBG-2.0/model.safetensors' → True
    """
    models = caps["models"]
    basenames = caps["models_basenames"]
    req_n = (req or "").replace("\\", "/").strip("/")
    if not req_n:
        return False
    if req_n in models or req in models:
        return True
    b = basename(req_n)
    if b in basenames or req_n in basenames:
        return True
    if b in models:
        return True
    # path equals req/... prefix, or any path segment / parent dir basename equals req
    prefix = req_n + "/"
    for m in models:
        mn = m.replace("\\", "/")
        if mn == req_n or mn.startswith(prefix):
            return True
        parts = [p for p in mn.split("/") if p]
        if req_n in parts or b in parts:
            return True
        if parts and (parts[0] == req_n or parts[0] == b):
            return True
        if len(parts) >= 2 and (parts[-2] == req_n or parts[-2] == b):
            return True
    return False


def main() -> int:
    OUT.mkdir(parents=True, exist_ok=True)
    t0 = time.time()
    print("login...", flush=True)
    token = login()
    health = http_json(f"{CORE}/api/health", headers=auth_headers(token))
    workers = list(health.get("workers") or [])
    print(f"workers from health: {workers}", flush=True)
    # v22: general pool only
    # 2026-10-13(W8 批3)实测口径:workstation 六口全活——8196 gpu0-alt / 8188 ComfyUI-LB /
    # 8264 H3 生产 / 8195 H3 试验 / 8197 LongCat / 8199 Wan-Animate-2。
    # 旧值含 pc02 192.168.71.114:8193(2026-09-13 下线)与 pc01 192.168.71.116:8188(10-05 起失联),
    # 导致下面 len(inter)==3 永不成立、扫描池实际只剩 :8196,专用实例上的能力被误报为缺口(27 条假缺口)。
    # 注意:纳入专用实例后 status=ok 只证明「某个 worker 能跑」,不等于「deps.resolve_worker() 会路由到它」
    # (E-1);判定路由必须看 per_worker 里是哪台 ok。
    GENERAL_POOL = [
        "http://192.168.71.127:8196",
        "http://192.168.71.127:8188",
        "http://192.168.71.127:8264",
        "http://192.168.71.127:8197",
        "http://192.168.71.127:8199",
    ]
    forced = os.environ.get("TOIV_WORKERS", "").strip()
    if forced:
        workers = [w.strip() for w in forced.split(",") if w.strip()]
        print(f"workers forced via TOIV_WORKERS: {workers}", flush=True)
    else:
        # prefer intersection with known general pool; if health empty/mismatch, use GENERAL_POOL
        inter = [w for w in GENERAL_POOL if w in workers]
        if len(inter) == len(GENERAL_POOL):
            workers = inter
            print(f"workers filtered to general pool: {workers}", flush=True)
        elif not workers:
            workers = list(GENERAL_POOL)
            print(f"workers fallback GENERAL_POOL: {workers}", flush=True)
        else:
            # keep health but warn if extras
            extras = [w for w in workers if w not in GENERAL_POOL]
            missing = [w for w in GENERAL_POOL if w not in workers]
            if extras or missing:
                print(f"WARN health workers extras={extras} missing={missing}; forcing GENERAL_POOL", flush=True)
                workers = list(GENERAL_POOL)
    if not workers:
        print("ERROR: no workers", file=sys.stderr)
        return 1

    print("listing apps...", flush=True)
    rows = list_app_ids(token)
    print(f"listed {len(rows)} apps", flush=True)
    with open(OUT / "apps_list_slim.json", "w", encoding="utf-8") as f:
        json.dump([{"id": a.get("id"), "name": a.get("name"), "is_public": a.get("is_public"),
                     "is_builtin": a.get("is_builtin"), "is_nsfw": a.get("is_nsfw"),
                     "smoke_status": a.get("smoke_status"), "use_case": a.get("use_case"),
                     "category": a.get("category"), "rh_webapp_id": a.get("rh_webapp_id"),
                     "output_kind": a.get("output_kind")}
                    for a in rows], f, ensure_ascii=False, indent=2)

    print("fetching worker capabilities...", flush=True)
    worker_caps = []
    with cf.ThreadPoolExecutor(max_workers=len(workers)) as ex:
        futs = {ex.submit(fetch_worker_caps, w): w for w in workers}
        for fut in cf.as_completed(futs):
            caps = fut.result()
            worker_caps.append(caps)
            print(f"  {caps['url']}: nodes={len(caps['nodes'])} models={len(caps['models'])} err={caps['error']}", flush=True)
    worker_caps.sort(key=lambda c: workers.index(c["url"]) if c["url"] in workers else 99)
    with open(OUT / "workers_snapshot.json", "w", encoding="utf-8") as f:
        json.dump([
            {"url": c["url"], "nodes_count": len(c["nodes"]), "models_count": len(c["models"]),
             "models_by_folder": c["models_by_folder"], "error": c["error"]}
            for c in worker_caps
        ], f, ensure_ascii=False, indent=2)

    # union / intersection helpers
    all_worker_nodes = set.union(*(c["nodes"] for c in worker_caps)) if worker_caps else set()
    nodes_on_all = set.intersection(*(c["nodes"] for c in worker_caps)) if worker_caps else set()

    print("fetching app details + analyzing...", flush=True)
    ids = [a["id"] for a in rows if a.get("id")]
    name_by_id = {a["id"]: a.get("name") for a in rows}

    apps_ok = []
    apps_blocked = []
    unlocalizable = []
    errors = []

    # aggregators
    missing_model_apps: dict[str, list[str]] = defaultdict(list)  # basename -> app ids
    missing_node_apps: dict[str, list[str]] = defaultdict(list)
    model_present_workers: dict[str, set[str]] = defaultdict(set)  # basename -> workers that have it
    node_present_workers: dict[str, set[str]] = defaultdict(set)

    # precompute model presence map for all worker models
    for c in worker_caps:
        for m in c["models"]:
            model_present_workers[basename(m)].add(c["url"])
            model_present_workers[m].add(c["url"])
        for n in c["nodes"]:
            node_present_workers[n].add(c["url"])

    def process_one(aid: str) -> dict:
        try:
            detail = fetch_app(token, aid)
        except Exception as e:
            return {"id": aid, "error": str(e)}
        graph = normalize_graph(detail.get("workflow_json"))
        req_nodes_cfg = set(detail.get("required_nodes") or [])
        nodes, models = extract_nodes_models(graph)
        if req_nodes_cfg:
            nodes = req_nodes_cfg | nodes
        # drop empty model strings
        models = {m for m in models if m and isinstance(m, str)}

        unloc = sorted(nodes & UNLOCALIZABLE_NODES)
        # per-worker gaps
        per_worker = []
        any_ok = False
        for c in worker_caps:
            miss_n = sorted(n for n in nodes if n not in c["nodes"])
            miss_m = sorted(m for m in models if not model_present(m, c))
            ok = (not miss_n) and (not miss_m)
            if ok:
                any_ok = True
            per_worker.append({
                "worker": c["url"],
                "missing_nodes": miss_n,
                "missing_models": miss_m,
                "ok": ok,
            })

        # global gaps: nodes missing on ALL workers; models present on NO worker
        miss_nodes_all = sorted(n for n in nodes if not any(n in c["nodes"] for c in worker_caps))
        miss_models_none = sorted(m for m in models if not any(model_present(m, c) for c in worker_caps))

        status = "ok" if any_ok else "blocked"
        block_kind = None
        if not any_ok:
            has_n = bool(miss_nodes_all) or any(pw["missing_nodes"] for pw in per_worker)
            has_m = bool(miss_models_none) or any(pw["missing_models"] for pw in per_worker)
            # more precise: for each worker either nodes or models block; classify by whether
            # ANY worker has all nodes, ANY has all models, but none has both
            any_nodes_ok = any(not pw["missing_nodes"] for pw in per_worker)
            any_models_ok = any(not pw["missing_models"] for pw in per_worker)
            if unloc:
                block_kind = "unlocalizable"
            elif not any_nodes_ok and not any_models_ok:
                block_kind = "both"
            elif not any_nodes_ok:
                block_kind = "nodes_only"
            elif not any_models_ok:
                block_kind = "models_only"
            else:
                # each worker misses different things (combination gap)
                block_kind = "both"

        return {
            "id": aid,
            "name": detail.get("name") or name_by_id.get(aid),
            "is_public": detail.get("is_public"),
            "is_nsfw": detail.get("is_nsfw"),
            "is_builtin": detail.get("is_builtin"),
            # 已知 shim 签名可能不兼容的节点(如 RHHiddenNodes):不影响 ok|blocked,供下游优先 smoke/标注
            "risk_nodes": sorted(nodes & KNOWN_RISKY_NODES),
            "nodes": sorted(nodes),
            "models": sorted(models),
            "unlocalizable_nodes": unloc,
            "status": status,
            "block_kind": block_kind,
            "per_worker": per_worker,
            "missing_nodes_on_all_workers": miss_nodes_all,
            "missing_models_on_no_worker": miss_models_none,
            "node_count": len(nodes),
            "model_count": len(models),
            "error": None,
        }

    results = []
    done = 0
    max_workers = min(32, max(8, os.cpu_count() or 8))
    with cf.ThreadPoolExecutor(max_workers=max_workers) as ex:
        futs = [ex.submit(process_one, aid) for aid in ids]
        for fut in cf.as_completed(futs):
            r = fut.result()
            results.append(r)
            done += 1
            if done % 50 == 0 or done == len(ids):
                print(f"  apps {done}/{len(ids)}", flush=True)

    # classify
    for r in results:
        if r.get("error") and r.get("status") is None:
            errors.append(r)
            continue
        if r.get("unlocalizable_nodes"):
            unlocalizable.append(r)
        if r.get("status") == "ok":
            apps_ok.append(r)
        else:
            apps_blocked.append(r)
            for m in r.get("missing_models_on_no_worker") or []:
                missing_model_apps[basename(m)].append(r["id"])
            # also count models that no single worker has together with nodes? 
            # For top missing models: models that appear in blocked apps and aren't on any worker
            for m in r.get("models") or []:
                if not any(model_present(m, c) for c in worker_caps):
                    if r["id"] not in missing_model_apps[basename(m)]:
                        missing_model_apps[basename(m)].append(r["id"])
            for n in r.get("missing_nodes_on_all_workers") or []:
                missing_node_apps[n].append(r["id"])
            # nodes that aren't on all workers but cause block: also count nodes missing from every worker
            for n in r.get("nodes") or []:
                if not any(n in c["nodes"] for c in worker_caps):
                    if r["id"] not in missing_node_apps[n]:
                        missing_node_apps[n].append(r["id"])

    # counts by block kind (exclude unlocalizable from blocked_* buckets for summary?
    # User wants: ok, blocked_models_only, blocked_nodes_only, blocked_both, unlocalizable
    # An app with RHHiddenNodes is unlocalizable; may also be counted separately.
    unloc_ids = {r["id"] for r in unlocalizable}
    blocked_models_only = [r for r in apps_blocked if r.get("block_kind") == "models_only" and r["id"] not in unloc_ids]
    blocked_nodes_only = [r for r in apps_blocked if r.get("block_kind") == "nodes_only" and r["id"] not in unloc_ids]
    blocked_both = [r for r in apps_blocked if r.get("block_kind") == "both" and r["id"] not in unloc_ids]
    # unlocalizable apps are those with RHHiddenNodes (even if also ok on nodes otherwise - they're still unlocalizable)
    # If an app has RHHiddenNodes, status won't be ok because node missing on all workers.
    unloc_only = unlocalizable

    summary = {
        "scanned_at": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "core": CORE,
        "workers": workers,
        "worker_stats": [
            {"url": c["url"], "nodes": len(c["nodes"]), "models": len(c["models"]),
             "models_by_folder": c["models_by_folder"]}
            for c in worker_caps
        ],
        "totals": {
            "apps": len(ids),
            "ok": len(apps_ok),
            "blocked": len(apps_blocked),
            "blocked_models_only": len(blocked_models_only),
            "blocked_nodes_only": len(blocked_nodes_only),
            "blocked_both": len(blocked_both),
            "unlocalizable": len(unloc_only),
            "fetch_errors": len(errors),
        },
        "elapsed_sec": round(time.time() - t0, 1),
        "notes": [
            "App OK iff EXISTS a worker with nodes⊇required AND models⊇required (basename-tolerant).",
            "Model inventory = /models/* folders ∪ loader combo options from /object_info.",
            "RHHiddenNodes apps listed in unlocalizable; also appear in blocked.",
            "Dedicated-instance nodes (MiniMaxH3/LongCat/…) missing from pool count as node gaps.",
        ],
    }

    # missing_models.json
    missing_models_out = []
    for bname, aids in sorted(missing_model_apps.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        missing_models_out.append({
            "basename": bname,
            "count_apps": len(aids),
            "sample_app_ids": aids[:15],
            "present_on_workers": sorted(model_present_workers.get(bname, [])),
        })

    # missing_nodes.json — only nodes missing on ALL workers (true global gap)
    # Also include nodes that blocked apps need and aren't universal? User asked:
    # 「全集缺口」（所有 worker 都缺的节点；没有任何 worker 有的模型）
    missing_nodes_out = []
    for ct, aids in sorted(missing_node_apps.items(), key=lambda kv: (-len(kv[1]), kv[0])):
        present = sorted(node_present_workers.get(ct, []))
        # skip if present on some worker — those aren't "全集缺口"
        # BUT still useful for device manager: keep all that appear in missing_nodes_on_all
        if present:
            continue
        missing_nodes_out.append({
            "class_type": ct,
            "count_apps": len(aids),
            "sample_app_ids": aids[:15],
            "present_on_workers": present,
            "suggested_package": suggested_package(ct),
        })

    # Also write nodes that are missing on some but not all (partial) for device管家 — optional file
    partial_nodes = []
    node_app_need: dict[str, set[str]] = defaultdict(set)
    for r in apps_blocked:
        for n in r.get("nodes") or []:
            node_app_need[n].add(r["id"])
    for ct, aids in node_app_need.items():
        present = sorted(node_present_workers.get(ct, []))
        if not present:
            continue  # already in missing_nodes
        if len(present) < len(worker_caps):
            # installed but not on all — not a full-gap; skip per user definition
            pass

    # market-reset: full status index for keep / soft-hide postprocess
    with open(OUT / "apps_status.jsonl", "w", encoding="utf-8") as f:
        for r in sorted(results, key=lambda x: str(x.get("id") or "")):
            slim = {
                "id": r.get("id"),
                "name": r.get("name"),
                "is_public": r.get("is_public"),
                "is_builtin": r.get("is_builtin"),
                "is_nsfw": r.get("is_nsfw"),
                "status": r.get("status"),
                "block_kind": r.get("block_kind"),
                "missing_nodes_on_all_workers": (r.get("missing_nodes_on_all_workers") or [])[:40],
                "missing_models_on_no_worker": (r.get("missing_models_on_no_worker") or [])[:40],
                "unlocalizable_nodes": r.get("unlocalizable_nodes") or [],
                "error": r.get("error"),
            }
            f.write(json.dumps(slim, ensure_ascii=False) + "\n")

    with open(OUT / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary, f, ensure_ascii=False, indent=2)

    with open(OUT / "missing_models.json", "w", encoding="utf-8") as f:
        json.dump(missing_models_out, f, ensure_ascii=False, indent=2)

    with open(OUT / "missing_nodes.json", "w", encoding="utf-8") as f:
        json.dump(missing_nodes_out, f, ensure_ascii=False, indent=2)

    unloc_out = []
    for r in unloc_only:
        unloc_out.append({
            "id": r["id"],
            "name": r.get("name"),
            "unlocalizable_nodes": r.get("unlocalizable_nodes"),
            "other_missing_nodes_on_all": [n for n in (r.get("missing_nodes_on_all_workers") or []) if n not in UNLOCALIZABLE_NODES][:30],
            "missing_models_on_no_worker": (r.get("missing_models_on_no_worker") or [])[:30],
        })
    with open(OUT / "unlocalizable.json", "w", encoding="utf-8") as f:
        json.dump(unloc_out, f, ensure_ascii=False, indent=2)

    with open(OUT / "apps_blocked.jsonl", "w", encoding="utf-8") as f:
        for r in sorted(apps_blocked, key=lambda x: x["id"]):
            brief = {
                "id": r["id"],
                "name": r.get("name"),
                "block_kind": r.get("block_kind"),
                "missing_nodes_on_all_workers": r.get("missing_nodes_on_all_workers"),
                "missing_models_on_no_worker": r.get("missing_models_on_no_worker"),
                "unlocalizable_nodes": r.get("unlocalizable_nodes"),
                "per_worker_summary": [
                    {
                        "worker": pw["worker"],
                        "missing_nodes_count": len(pw["missing_nodes"]),
                        "missing_models_count": len(pw["missing_models"]),
                        "missing_nodes_sample": pw["missing_nodes"][:8],
                        "missing_models_sample": pw["missing_models"][:8],
                    }
                    for pw in r.get("per_worker") or []
                ],
            }
            f.write(json.dumps(brief, ensure_ascii=False) + "\n")

    if errors:
        with open(OUT / "fetch_errors.json", "w", encoding="utf-8") as f:
            json.dump(errors, f, ensure_ascii=False, indent=2)

    # REPORT.md
    top_nodes = missing_nodes_out[:20]
    top_models = missing_models_out[:20]
    lines = []
    lines.append("# ToIV 生产能力缺口扫描报告")
    lines.append("")
    lines.append(f"- 扫描时间: {summary['scanned_at']}")
    lines.append(f"- Core: `{CORE}`")
    lines.append(f"- Workers: {', '.join(f'`{w}`' for w in workers)}")
    lines.append(f"- 耗时: {summary['elapsed_sec']}s")
    lines.append("")
    lines.append("## 汇总")
    lines.append("")
    t = summary["totals"]
    lines.append(f"| 指标 | 数量 |")
    lines.append(f"|---|---|")
    lines.append(f"| 应用总数 | {t['apps']} |")
    lines.append(f"| OK（至少一个 worker 可路由） | {t['ok']} |")
    lines.append(f"| 仅缺模型 | {t['blocked_models_only']} |")
    lines.append(f"| 仅缺节点 | {t['blocked_nodes_only']} |")
    lines.append(f"| 节点+模型皆缺（或组合缺口） | {t['blocked_both']} |")
    lines.append(f"| 不可本地化（含 RHHiddenNodes） | {t['unlocalizable']} |")
    lines.append(f"| 拉取失败 | {t['fetch_errors']} |")
    lines.append("")
    lines.append("## Worker 快照")
    lines.append("")
    for ws in summary["worker_stats"]:
        lines.append(f"- `{ws['url']}`: nodes={ws['nodes']}, models={ws['models']}")
    lines.append("")
    lines.append("## Top 缺节点（全集：所有 worker 都没有）")
    lines.append("")
    lines.append("| class_type | apps | suggested_package |")
    lines.append("|---|---:|---|")
    for n in top_nodes:
        lines.append(f"| `{n['class_type']}` | {n['count_apps']} | {n.get('suggested_package') or ''} |")
    lines.append("")
    lines.append("## Top 缺模型（全集：没有任何 worker 有）")
    lines.append("")
    lines.append("| basename | apps |")
    lines.append("|---|---:|")
    for m in top_models:
        lines.append(f"| `{m['basename']}` | {m['count_apps']} |")
    lines.append("")
    lines.append("## 建议")
    lines.append("")
    lines.append("1. **模型下载**：按 `missing_models.json` 的 count_apps 降序补齐；优先 Top 模型可解锁最多应用。")
    lines.append("2. **设备管家 / 自定义节点**：按 `missing_nodes.json` 的 suggested_package 安装；已在任一 worker 存在的节点不要报成「全员缺失」。")
    lines.append("3. **RHHiddenNodes**：RunningHub 专有，无法本地化；见 `unlocalizable.json`，应用侧应改写/剔除或保持 RH 云端执行。")
    lines.append("4. **专用实例节点**（MiniMaxH3 / LongCat / WanAnimate / QwenEdit）：不在 health 通用池内属预期；需确认专用实例在线，或从本扫描的「缺节点」里单独过滤。")
    lines.append("5. Worker `116:8188` 若模型目录接近空，会放大「仅该机可跑」类应用的组合缺口；核对模型挂载。")
    lines.append("")
    lines.append("## 产出文件")
    lines.append("")
    lines.append("- `summary.json`")
    lines.append("- `missing_models.json`")
    lines.append("- `missing_nodes.json`")
    lines.append("- `unlocalizable.json`")
    lines.append("- `apps_blocked.jsonl`")
    lines.append("- `workers_snapshot.json`")
    lines.append("")

    (OUT / "REPORT.md").write_text("\n".join(lines), encoding="utf-8")

    print(json.dumps(summary["totals"], ensure_ascii=False, indent=2), flush=True)
    print("Top10 missing nodes:", flush=True)
    for n in top_nodes[:10]:
        print(f"  {n['count_apps']:4d}  {n['class_type']}  ({n.get('suggested_package')})", flush=True)
    print("Top10 missing models:", flush=True)
    for m in top_models[:10]:
        print(f"  {m['count_apps']:4d}  {m['basename']}", flush=True)
    print(f"Wrote to {OUT}", flush=True)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        traceback.print_exc()
        raise SystemExit(2)
