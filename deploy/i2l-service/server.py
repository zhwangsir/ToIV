"""ToIV i2L 风格 LoRA 服务 —— 部署在 workstation,HTTP 监听 0.0.0.0:9101。

业务:Z-Image i2L(图→LoRA)管线产品化。上传 1-8 张同风格图,经 DiffSynth-Studio
ZImage-i2L-v2 元模型一次前向产出 LoRA,键名转换为 ComfyUI LoraLoaderModelOnly
兼容格式(加 diffusion_model. 前缀、去 .default),落 NAS loras/ 目录。
实证来源:scripts/ops/zimage_i2l_export.py(2026-08-24 flatvector 冒烟,workstation
真机出 LoRA 并在 ComfyUI LoraLoaderModelOnly 加载出图验证)。

契约(core 端按此对接):
  GET  /health → 200 {"ok": true, "busy": bool, "gpu": "<CUDA_VISIBLE_DEVICES>",
                      "models": {"z_image": bool, "i2l": bool}}
                 (models = 启动时探测权重目录存在性)
  POST /i2l    multipart/form-data:
                 files[]      风格图 1-8 张(png/jpg/jpeg/webp)
                 lora_name    必填,清洗为 [a-zA-Z0-9_-],清洗后为空 → 400
                 demo_prompt  可选,非空则用导出的 LoRA 出一张 demo 图
                 overwrite    可选,="true" 时允许覆盖同名 LoRA
    忙时(单并发)              → 409 {"error": "busy"}
    同名已存在且未 overwrite   → 400 {"error": ...}
    成功 → 200 {"ok": true, "lora_name": "<lora_name>.safetensors",
                "lora_path": "<绝对路径>", "size_mb": float,
                "demo_png": "<绝对路径|null>"}
    导出失败 → 500 {"error": "<含异常尾部>"}

路径环境变量(默认值按 workstation 实证布局):
  ZIMAGE_DIFFUSERS_DIR  Z-Image diffusers 基座(默认 /home/merlin/nas_mount/toiv/zimage_diffusers,
                        下含 z-image/transformer 与 z-image-turbo/text_encoder|vae|tokenizer)
  ZIMAGE_I2L_DIR        i2L 元模型目录(默认 /home/merlin/nas_mount/toiv/comfyui-models/zimage_i2l)
  I2L_LORAS_DIR         LoRA 输出目录(默认 /home/merlin/nas_mount/toiv/comfyui-models/loras)
  I2L_UPLOAD_DIR        上传暂存目录(默认 /home/merlin/i2l-service/uploads)

设计要点:
- 标准库 http.server(与 deploy/toiv-trainer.py 同风格,不引 FastAPI)。
- torch/diffsynth 全部惰性 import:首次 /i2l 调用时加载管线并常驻显存(bf16,~26G),
  后续调用复用;加载失败 500 并解锁 busy。
- 单并发:threading.Lock 非阻塞获取,持锁期间整个导出串行(保显存)。
- DIFFSYNTH_SKIP_DOWNLOAD=true 写进服务环境(权重全本地,禁联网下载)。
- 上传图存 I2L_UPLOAD_DIR/<uuid>/;LoRA 输出 I2L_LORAS_DIR/<lora_name>.safetensors。

systemd 部署(workstation,/etc/systemd/system/toiv-i2l.service):
  [Unit]
  Description=ToIV Z-Image i2L style-LoRA service (port 9101)
  After=network-online.target
  Wants=network-online.target

  [Service]
  Type=simple
  User=merlin
  WorkingDirectory=/home/merlin/i2l-service
  Environment=CUDA_VISIBLE_DEVICES=0
  Environment=HF_ENDPOINT=https://hf-mirror.com
  ExecStart=/home/merlin/diffsynth-venv/bin/python /home/merlin/i2l-service/server.py
  Restart=on-failure
  RestartSec=5
  MemoryMax=48G

  [Install]
  WantedBy=multi-user.target
"""
from __future__ import annotations

import glob
import json
import logging
import os
import re
import threading
import traceback
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("toiv-i2l")

# 权重全本地路径,禁止 DiffSynth 联网下载(必须在惰性 import diffsynth 之前生效)
os.environ.setdefault("DIFFSYNTH_SKIP_DOWNLOAD", "true")

# ---------------------------------------------------------------------------
# 路径常量(env 覆盖,默认值按 workstation 实证布局)
# ---------------------------------------------------------------------------
ZIMAGE_DIFFUSERS_DIR = os.environ.get("ZIMAGE_DIFFUSERS_DIR", "/home/merlin/nas_mount/toiv/zimage_diffusers")
ZIMAGE_I2L_DIR = os.environ.get("ZIMAGE_I2L_DIR", "/home/merlin/nas_mount/toiv/comfyui-models/zimage_i2l")
LORAS_DIR = os.environ.get("I2L_LORAS_DIR", "/home/merlin/nas_mount/toiv/comfyui-models/loras")
UPLOAD_DIR = os.environ.get("I2L_UPLOAD_DIR", "/home/merlin/i2l-service/uploads")
HOST = "0.0.0.0"
PORT = 9101

MAX_IMAGES = 8
ALLOWED_EXTS = {".png", ".jpg", ".jpeg", ".webp"}
_LORA_NAME_RE = re.compile(r"[^a-zA-Z0-9_-]")

# demo 图采样参数(官方 i2L 示例,与实证脚本一致)
_DEMO_STEPS = 50
_DEMO_CFG = 4.0

# ---------------------------------------------------------------------------
# 管线单例(惰性加载,常驻显存)+ 单并发锁
# ---------------------------------------------------------------------------
_pipe = None
_template = None
_load_lock = threading.Lock()
_busy_lock = threading.Lock()


def _probe_models() -> dict:
    """启动时探测权重目录存在性(/health 的 models 字段)。"""
    base = os.path.join(ZIMAGE_DIFFUSERS_DIR, "z-image")
    turbo = os.path.join(ZIMAGE_DIFFUSERS_DIR, "z-image-turbo")
    return {
        "z_image": os.path.isdir(base) and os.path.isdir(turbo),
        "i2l": os.path.isdir(ZIMAGE_I2L_DIR),
    }


MODELS_STATUS = _probe_models()


def _weight_files(*parts: str) -> list[str]:
    hits = sorted(glob.glob(os.path.join(*parts)))
    if not hits:
        raise FileNotFoundError(os.path.join(*parts))
    return hits


def _load_pipelines():
    """惰性加载 ZImagePipeline(base transformer + turbo TE/VAE/tokenizer)与
    i2L TemplatePipeline,常驻显存;线程锁防并发重复载入。"""
    global _pipe, _template
    with _load_lock:
        if _pipe is not None and _template is not None:
            return _pipe, _template
        import torch
        from diffsynth.diffusion.template import TemplatePipeline
        from diffsynth.pipelines.z_image import ModelConfig, ZImagePipeline

        base = os.path.join(ZIMAGE_DIFFUSERS_DIR, "z-image")
        turbo = os.path.join(ZIMAGE_DIFFUSERS_DIR, "z-image-turbo")

        logger.info("[i2l] 加载 ZImagePipeline(base transformer + turbo TE/VAE/tokenizer)...")
        pipe = ZImagePipeline.from_pretrained(
            torch_dtype=torch.bfloat16,
            device="cuda",
            model_configs=[
                ModelConfig(path=_weight_files(base, "transformer", "*.safetensors")),
                ModelConfig(path=_weight_files(turbo, "text_encoder", "*.safetensors")),
                ModelConfig(path=_weight_files(turbo, "vae", "diffusion_pytorch_model.safetensors")),
            ],
            tokenizer_config=ModelConfig(path=os.path.join(turbo, "tokenizer")),
        )
        pipe.enable_lora_hot_loading(pipe.dit)

        logger.info("[i2l] 加载 i2L 元模型(ZImage-i2L-v2)...")
        template = TemplatePipeline.from_pretrained(
            torch_dtype=torch.bfloat16,
            device="cuda",
            model_configs=[ModelConfig(path=ZIMAGE_I2L_DIR)],
        )
        _pipe, _template = pipe, template
        logger.info("[i2l] 管线加载完成,常驻显存")
        return _pipe, _template


def _export_lora(image_paths: list[str], out_path: str, demo_prompt: str = "") -> str | None:
    """风格图 → LoRA safetensors(ComfyUI 兼容键名);demo_prompt 非空附出 demo 图。

    返回 demo 图绝对路径(未出 demo 返回 None)。异常原样上抛,由调用方转 500。
    """
    import torch
    from PIL import Image
    from safetensors.torch import save_file

    pipe, template = _load_pipelines()

    images = [Image.open(p).convert("RGB") for p in image_paths]
    logger.info("[i2l] %d 张风格图 → LoRA 权重...", len(images))
    cache = template.call_single_side(pipe=pipe, inputs=[{"image": images}])
    lora = cache.get("lora")
    if not lora:
        raise RuntimeError("i2L 元模型未产出 LoRA(template_cache 无 lora 键)")

    # DiffSynth 键名 → ComfyUI LoraLoaderModelOnly 兼容
    # (layers.*.lora_A.default.weight → diffusion_model.layers.*.lora_A.weight)
    converted = {}
    for k, v in lora.items():
        nk = "diffusion_model." + k.replace(".lora_A.default.weight", ".lora_A.weight") \
                                   .replace(".lora_B.default.weight", ".lora_B.weight")
        converted[nk] = v.contiguous().to(torch.bfloat16).cpu()
    os.makedirs(os.path.dirname(os.path.abspath(out_path)), exist_ok=True)
    save_file(converted, out_path)
    logger.info("[i2l] 导出 %d 个张量 → %s", len(converted), out_path)

    demo_path = None
    if demo_prompt:
        import numpy as np

        logger.info("[i2l] 用导出的 LoRA 出 demo 图...")
        image = template(
            pipe,
            prompt=demo_prompt,
            seed=0, cfg_scale=_DEMO_CFG, num_inference_steps=_DEMO_STEPS,
            template_inputs=[{"image": images}],
            negative_template_inputs=[{
                "image": [Image.fromarray(np.zeros_like(np.array(i)) + 128) for i in images],
            }],
        )
        demo_path = os.path.splitext(out_path)[0] + "_demo.png"
        image.save(demo_path)
        logger.info("[i2l] demo 图 → %s", demo_path)
    return demo_path


# ---------------------------------------------------------------------------
# multipart 解析(标准库实现,cgi 已在 3.13 移除)
# ---------------------------------------------------------------------------
def _parse_multipart(body: bytes, content_type: str) -> tuple[dict, list]:
    """返回 (fields, files):fields={name: str},files=[(filename, bytes), ...]。"""
    m = re.search(r'boundary=(?:"([^"]+)"|([^;\s]+))', content_type)
    if not m:
        raise ValueError("multipart boundary 缺失")
    boundary = (m.group(1) or m.group(2)).encode()
    fields: dict[str, str] = {}
    files: list[tuple[str, bytes]] = []
    for part in body.split(b"--" + boundary):
        part = part.strip(b"\r\n")
        if not part or part == b"--":
            continue
        if part.endswith(b"--"):
            part = part[:-2].rstrip(b"\r\n")
        head, sep, content = part.partition(b"\r\n\r\n")
        if not sep:
            continue
        disp = re.search(r"Content-Disposition:\s*form-data;([^\r\n]+)", head.decode("utf-8", "replace"), re.I)
        if not disp:
            continue
        name_m = re.search(r'name="([^"]*)"', disp.group(1))
        if not name_m:
            continue
        name = name_m.group(1)
        fn_m = re.search(r'filename="([^"]*)"', disp.group(1))
        if fn_m and fn_m.group(1):
            files.append((fn_m.group(1), content))
        else:
            fields[name] = content.decode("utf-8", "replace")
    return fields, files


def _clean_lora_name(raw: str) -> str:
    """清洗为 [a-zA-Z0-9_-];清洗后为空由调用方判 400。"""
    return _LORA_NAME_RE.sub("", raw)


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class I2LHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _json(self, code: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        if path == "/health":
            self._json(200, {
                "ok": True,
                "busy": _busy_lock.locked(),
                "gpu": os.environ.get("CUDA_VISIBLE_DEVICES", ""),
                "models": dict(MODELS_STATUS),
            })
            return
        self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        if path == "/i2l":
            self._handle_i2l()
            return
        self._json(404, {"error": "not found"})

    def _handle_i2l(self) -> None:
        content_type = self.headers.get("Content-Type", "")
        if "multipart/form-data" not in content_type:
            self._json(400, {"error": "Content-Type 须为 multipart/form-data"})
            return
        length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(length) if length else b""
        try:
            fields, files = _parse_multipart(body, content_type)
        except ValueError as e:
            self._json(400, {"error": str(e)})
            return

        lora_name = _clean_lora_name((fields.get("lora_name") or "").strip())
        if not lora_name:
            self._json(400, {"error": "lora_name 必填且清洗后不能为空(仅允许 [a-zA-Z0-9_-])"})
            return
        demo_prompt = (fields.get("demo_prompt") or "").strip()[:500]
        overwrite = (fields.get("overwrite") or "").strip().lower() == "true"

        if not files:
            self._json(400, {"error": "files[] 至少 1 张风格图"})
            return
        if len(files) > MAX_IMAGES:
            self._json(400, {"error": f"files[] 最多 {MAX_IMAGES} 张"})
            return
        for fname, _ in files:
            if os.path.splitext(fname)[1].lower() not in ALLOWED_EXTS:
                self._json(400, {"error": f"不支持的图片格式: {fname}(仅 png/jpg/jpeg/webp)"})
                return

        out_path = os.path.join(LORAS_DIR, f"{lora_name}.safetensors")
        if os.path.exists(out_path) and not overwrite:
            self._json(400, {"error": f"同名 LoRA 已存在: {lora_name}.safetensors(overwrite=true 显式覆盖)"})
            return

        # 单并发:忙时直接 409,不排队
        if not _busy_lock.acquire(blocking=False):
            self._json(409, {"error": "busy"})
            return
        try:
            job_dir = os.path.join(UPLOAD_DIR, uuid.uuid4().hex)
            os.makedirs(job_dir, exist_ok=True)
            image_paths = []
            for idx, (fname, data) in enumerate(files):
                ext = os.path.splitext(fname)[1].lower()
                fpath = os.path.join(job_dir, f"style-{idx:02d}{ext}")
                with open(fpath, "wb") as f:
                    f.write(data)
                image_paths.append(fpath)
            logger.info("[i2l] lora_name=%s images=%d demo=%s", lora_name, len(image_paths), bool(demo_prompt))

            demo_path = _export_lora(image_paths, out_path, demo_prompt)
            size_mb = round(os.path.getsize(out_path) / (1024 * 1024), 2)
            self._json(200, {
                "ok": True,
                "lora_name": f"{lora_name}.safetensors",
                "lora_path": os.path.abspath(out_path),
                "size_mb": size_mb,
                "demo_png": os.path.abspath(demo_path) if demo_path else None,
            })
        except Exception as e:
            logger.exception("[i2l] 导出失败")
            tail = traceback.format_exc()[-800:]
            self._json(500, {"error": f"i2l 导出失败: {tail}"})
        finally:
            _busy_lock.release()


def main() -> None:
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    os.makedirs(LORAS_DIR, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), I2LHandler)
    logger.info("ToIV i2L service listening on %s:%d", HOST, PORT)
    logger.info("models: %s", MODELS_STATUS)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
