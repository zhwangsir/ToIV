"""ToIV LoRA 训练 agent —— 部署在 GPU 机(workstation)上，HTTP 服务监听 :9100。

架构: API(CPU 容器)通过 HTTP 调本 agent(同 ComfyUI/TTS/LLM 的访问模式)。
训练后端: AI-Toolkit(ostris)支持 FLUX.2/Qwen-Image/Z-Image/SDXL/MiniMax-H3(视频 LoRA)。
打标后端: Florence2(自动生成 .txt 标签文件)。

接口:
  POST /caption           — Florence2 自动打标
  POST /train             — 启动训练
  GET  /train/{id}/events — SSE 训练进度(step/loss)
  POST /train/{id}/stop   — 停止训练
  GET  /health            — 健康检查

路径环境变量(默认值保留 Windows F:\\ 布局向后兼容;Linux 部署用环境变量注入):
  TOIV_TRAINER_MODELS_ROOT      模型库根目录(默认 F:\\ComfyUIModel\\models)
  TOIV_TRAINER_DATASETS_DIR     数据集目录(默认 F:\\toiv-trainer\\datasets)
  TOIV_TRAINER_AI_TOOLKIT_DIR   ai-toolkit 仓库目录(默认 F:\\toiv-trainer\\ai-toolkit)
  TOIV_TRAINER_VENV_PYTHON      训练 venv python(默认 F:\\toiv-trainer\\.venv\\Scripts\\python.exe)
  TOIV_TRAINER_LORAS_DIR        LoRA 输出目录(默认 <MODELS_ROOT>/loras)
  TOIV_TRAINER_CHECKPOINTS_DIR  底模目录(默认 <MODELS_ROOT>/checkpoints)
  TOIV_TRAINER_H3_MODELS_PATH   H3(MiniMax-H3)权重布局根,训练 subprocess 以 MODELS_PATH 注入
                                (默认 /home/merlin/nas_mount/toiv/comfyui-models/h3)
  TOIV_TRAINER_H3_LORAS_DIR     H3 LoRA 输出目录(默认 <H3_MODELS_PATH>/loras,不用全局 LORAS_DIR)

Florence2 权重经 huggingface_hub 下载,默认直连 HuggingFace;离线/受限网络部署时
设 HF_ENDPOINT=https://hf-mirror.com 走镜像(代码不硬编码镜像地址)。

依赖: toiv-trainer venv(含 torch + ai-toolkit requirements + florence2)
启动(Windows 默认): F:\\toiv-trainer\\.venv\\Scripts\\python.exe toiv-trainer.py
启动(Linux 示例):  TOIV_TRAINER_MODELS_ROOT=/home/merlin/nas_mount/Windows/ComfyUI/ComfyUIModel/models \\
                    TOIV_TRAINER_AI_TOOLKIT_DIR=/home/merlin/ai-toolkit \\
                    TOIV_TRAINER_VENV_PYTHON=/home/merlin/ai-toolkit/.venv/bin/python \\
                    HF_ENDPOINT=https://hf-mirror.com \\
                    /home/merlin/ai-toolkit/.venv/bin/python toiv-trainer.py
"""
from __future__ import annotations

import json
import logging
import os
import re
import subprocess
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("toiv-trainer")

# ---------------------------------------------------------------------------
# 路径常量(默认值保留 Windows F: 盘布局向后兼容;Linux 部署用环境变量覆盖)
# ---------------------------------------------------------------------------
MODELS_ROOT = os.environ.get("TOIV_TRAINER_MODELS_ROOT", r"F:\ComfyUIModel\models")
DATASETS_DIR = os.environ.get("TOIV_TRAINER_DATASETS_DIR", r"F:\toiv-trainer\datasets")
AI_TOOLKIT_DIR = os.environ.get("TOIV_TRAINER_AI_TOOLKIT_DIR", r"F:\toiv-trainer\ai-toolkit")
TRAINER_VENV_PYTHON = os.environ.get("TOIV_TRAINER_VENV_PYTHON", r"F:\toiv-trainer\.venv\Scripts\python.exe")
LORAS_DIR = os.environ.get("TOIV_TRAINER_LORAS_DIR") or os.path.join(MODELS_ROOT, "loras")
CHECKPOINTS_DIR = os.environ.get("TOIV_TRAINER_CHECKPOINTS_DIR") or os.path.join(MODELS_ROOT, "checkpoints")
# H3(MiniMax-H3 视频 LoRA)专用路径:权重(DiT int8/TE nvfp4/VAE)走 NAS ComfyUI 布局,
# 训练 subprocess 以 MODELS_PATH 环境变量注入;LoRA 产物独立目录,不进全局 LORAS_DIR。
H3_MODELS_PATH = os.environ.get(
    "TOIV_TRAINER_H3_MODELS_PATH", "/home/merlin/nas_mount/toiv/comfyui-models/h3"
)
H3_LORAS_DIR = os.environ.get("TOIV_TRAINER_H3_LORAS_DIR") or os.path.join(H3_MODELS_PATH, "loras")
HOST = "0.0.0.0"
PORT = 9100

# ---------------------------------------------------------------------------
# 训练作业管理(内存态,单进程并发训练)
# ---------------------------------------------------------------------------
_jobs: dict[str, dict] = {}  # {trainer_job_id: {proc, status, progress, ...}}
_lock = threading.Lock()


def _resolve_dataset_path(dataset_dir: str) -> str:
    """dataset_dir = job_id → 本地数据集目录。"""
    return os.path.join(DATASETS_DIR, dataset_dir)


def _resolve_ckpt_path(base_ckpt: str) -> str:
    """底模文件名 → 本地 checkpoints 全路径。"""
    return os.path.join(CHECKPOINTS_DIR, base_ckpt)


# ---------------------------------------------------------------------------
# 模型族支持矩阵(与 core apps/api/app/workflows/model_profiles.detect_model_family 对齐)
# ---------------------------------------------------------------------------
# detect_model_family 返回集合:flux2/z_image/z_image_base/qwen_image/10eros/ltx/pony/
# flux/qwen/sdxl_anime/sdxl/sd15。AI-Toolkit 只支持以下族,其余(10eros/ltx/pony/sd15 等)
# 明确拒绝(POST /train 400),禁止静默落进 sdxl 通用模板用错架构。
# arch 字符串 2026-08-27 对 workstation /home/merlin/ai-toolkit 实测核验
# (extensions_built_in/diffusion_models/*/ 各模型类 arch 属性;内置族见 toolkit ModelArch)。
# 注:"h3" 不由 detect_model_family 返回(其返回集无 h3 分支),core 调本 agent 时
# 显式传 family="h3";arch=minimax_h3 为 2026-08-23 workstation 30 步冒烟实证(310MB rank16 LoRA)。
_FLUX_BUILTIN_FAMILY_ARCH = {
    "flux1": "flux",  # FLUX.1 dev 内置 arch(ModelArch Literal 'flux')
    "flux": "flux",   # 通用 flux 命中 FLUX.1 dev 内置模板
}
_EXT_FAMILY_ARCH = {
    "flux2": "flux2",                    # Flux2Model
    "klein": "flux2_klein_9b",           # Flux2Klein9BModel(4B 变体改 flux2_klein_4b)
    "qwen": "qwen_image",                # QwenImageModel
    "qwen_image": "qwen_image",          # 次世代 qwen_image 与 qwen 同路
    "z_image": "zimage",                 # ZImageModel(无下划线,实测)
    "z_image_base": "zimage",            # 非蒸馏底座与蒸馏档同 arch(超参由请求侧区分)
}
_SDXL_FAMILIES = ("sdxl", "sdxl_anime")  # sdxl_anime 允许走 sdxl 通用模板
_H3_FAMILY = "h3"  # MiniMax-H3 视频 LoRA(ai-toolkit minimax_h3 扩展)

SUPPORTED_FAMILIES: tuple[str, ...] = (
    "flux2", "flux1", "klein", "flux",
    "qwen_image", "qwen", "z_image", "z_image_base",
    "sdxl", "sdxl_anime",
    _H3_FAMILY,
)

# H3 视频 VAE 帧网格是 17n+5(2026-08-23 冒烟实证):合法值 5/22/39/56,其他值会被引擎静默裁短
_H3_FRAME_GRID = (5, 22, 39, 56)
_H3_DEFAULT_NUM_FRAMES = 39  # ≈1.6s@24fps


def _snap_h3_num_frames(requested) -> tuple[int, str]:
    """H3 num_frames 向上吸附到 17n+5 网格(5/22/39/56)。

    返回 (吸附后值, warning);请求值恰好合法时 warning 为空串。
    超出网格上限(>56)吸附到最大合法值 56;无法解析时回落默认 39。
    """
    try:
        req = int(requested)
    except (TypeError, ValueError):
        req = _H3_DEFAULT_NUM_FRAMES
    snapped = _H3_FRAME_GRID[-1]
    for value in _H3_FRAME_GRID:
        if req <= value:
            snapped = value
            break
    warning = ""
    if snapped != req:
        warning = (
            f"num_frames {requested} 不在 H3 17n+5 帧网格{_H3_FRAME_GRID},"
            f"已向上吸附为 {snapped}"
        )
    return snapped, warning


class UnsupportedFamilyError(ValueError):
    """不支持的模型族:拒绝训练,避免静默套错 YAML 模板。"""


def _validate_family(family: str) -> None:
    if family not in SUPPORTED_FAMILIES:
        raise UnsupportedFamilyError(
            f"模型族 '{family}' 暂不支持训练;"
            f"当前支持: {'/'.join(SUPPORTED_FAMILIES)}"
        )


def _make_ai_toolkit_config(params: dict) -> tuple[str, str]:
    """根据训练参数生成 AI-Toolkit 的 YAML 配置文件路径。

    AI-Toolkit 用 YAML 配置驱动训练,不同模型族用不同 config 模板。
    这里按 family 生成最小可用配置。

    返回 (config_path, warning);warning 非空表示请求参数被自动修正(目前仅 H3
    num_frames 17n+5 帧网格吸附),调用方应随 /train 响应透传给用户。

    h3 族跳过 _resolve_ckpt_path:H3 权重(DiT int8/TE nvfp4/视频+音频 VAE)由训练
    subprocess 的 MODELS_PATH 布局提供(见 scripts/h3/h3_lora_train.example.yaml),
    YAML 的 name_or_path 只取 tokenizer/config 小文件(调用方传 "MiniMaxAI/MiniMax-H3"),
    拼本地 checkpoints 路径没有意义。
    """
    # 可选参数默认值(与 core routes/train.py TrainStartRequest 对齐;
    # 缺省不炸 KeyError —— 2026-08-27 冒烟 KeyError: batch_size 教训)
    params = {
        "trigger_words": "",
        "network_dim": 16,
        "network_alpha": 16,
        "resolution": 1024,
        "batch_size": 1,
        "steps": 1000,
        "lr": 1e-4,
        "cuda_device": 0,
        "num_frames": 39,
        **params,
    }
    family = params.get("family", "flux2")
    _validate_family(family)  # 不支持族先拒绝,不产生任何目录/配置文件
    for required in ("job_id", "dataset_dir", "base_ckpt"):
        if not params.get(required):
            raise ValueError(f"缺少必填参数: {required}(必填: job_id/dataset_dir/base_ckpt)")
    job_id = params["job_id"]
    lora_name = params.get("lora_name", f"lora_{job_id[:8]}")
    dataset_path = _resolve_dataset_path(params["dataset_dir"])
    is_h3 = family == _H3_FAMILY
    ckpt_path = params["base_ckpt"] if is_h3 else _resolve_ckpt_path(params["base_ckpt"])
    loras_base = H3_LORAS_DIR if is_h3 else LORAS_DIR  # h3 产物独立目录
    output_dir = os.path.join(loras_base, lora_name)
    os.makedirs(output_dir, exist_ok=True)
    warning = ""

    # 按模型族选配置模板(内置 flux 带 is_flux;扩展 arch 无该键,见 H3 实证模板)
    if family in _FLUX_BUILTIN_FAMILY_ARCH:
        model_key = _FLUX_BUILTIN_FAMILY_ARCH[family]
        config = f"""# Auto-generated by ToIV trainer for {lora_name}
job: extension
config:
  name: "{lora_name}"
  process:
    - type: sd_trainer
      training_folder: "{output_dir}"  # 每作业独立目录(共享 loras 根会被 resume 发现误捡其他 LoRA,2026-08-27 实证)
      device: cuda:0  # 物理卡由 subprocess CUDA_VISIBLE_DEVICES 指定(单卡视图,见 H3 实证)
      trigger_word: "{params.get('trigger_words', '')}"
      network:
        type: lora
        linear: {params['network_dim']}
        linear_alpha: {params['network_alpha']}
      save:
        dtype: float16
        save_every: 500
        max_step_saves_to_keep: 4
      datasets:
        - folder_path: "{dataset_path}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [{params['resolution']}]
      train:
        batch_size: {params['batch_size']}
        steps: {params['steps']}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        content_or_style: balanced
        gradient_cliping: 1.0
        noise_scheduler: flowmatch
        optimizer: adamw8bit
        lr: {params['lr']}
        dtype: bf16
      model:
        name_or_path: "{ckpt_path}"
        is_flux: true
        arch: {model_key}
        quantize: false
"""
    elif family in _EXT_FAMILY_ARCH:
        arch = _EXT_FAMILY_ARCH[family]
        config = f"""# Auto-generated by ToIV trainer for {lora_name}
job: extension
config:
  name: "{lora_name}"
  process:
    - type: sd_trainer
      training_folder: "{output_dir}"  # 每作业独立目录(共享 loras 根会被 resume 发现误捡其他 LoRA,2026-08-27 实证)
      device: cuda:0  # 物理卡由 subprocess CUDA_VISIBLE_DEVICES 指定(单卡视图,见 H3 实证)
      trigger_word: "{params.get('trigger_words', '')}"
      network:
        type: lora
        linear: {params['network_dim']}
        linear_alpha: {params['network_alpha']}
      save:
        dtype: float16
        save_every: 500
        max_step_saves_to_keep: 4
      datasets:
        - folder_path: "{dataset_path}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [{params['resolution']}]
      train:
        batch_size: {params['batch_size']}
        steps: {params['steps']}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_cliping: 1.0
        optimizer: adamw8bit
        lr: {params['lr']}
        dtype: bf16
      model:
        name_or_path: "{ckpt_path}"
        arch: {arch}
        quantize: false
"""
    elif is_h3:
        # H3(MiniMax-H3 视频 LoRA):模板按 scripts/h3/h3_lora_train.example.yaml 实证键;
        # 不生成 sample 段(训练不需要采样,以最少必要键为准)。
        num_frames, warning = _snap_h3_num_frames(params.get("num_frames", _H3_DEFAULT_NUM_FRAMES))
        config = f"""# Auto-generated by ToIV trainer for {lora_name}
job: extension
config:
  name: "{lora_name}"
  process:
    - type: sd_trainer
      training_folder: "{output_dir}"  # 每作业独立目录(共享 loras 根会被 resume 发现误捡其他 LoRA,2026-08-27 实证)
      device: cuda:0  # 物理卡由 subprocess CUDA_VISIBLE_DEVICES 指定(单卡视图,见 H3 实证)
      trigger_word: "{params.get('trigger_words', '')}"
      network:
        type: lora
        linear: {params['network_dim']}
        linear_alpha: {params['network_alpha']}
      save:
        dtype: float16
        save_every: 250
        max_step_saves_to_keep: 4
      datasets:
        - folder_path: "{dataset_path}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          num_frames: {num_frames}
          resolution: [{params['resolution']}]
      train:
        batch_size: {params['batch_size']}
        steps: {params['steps']}
        gradient_accumulation: 1
        train_unet: true
        train_text_encoder: false
        gradient_checkpointing: true
        noise_scheduler: flowmatch
        timestep_type: linear
        optimizer: adamw8bit
        lr: {params['lr']}
        optimizer_params:
          weight_decay: 1e-4
        cache_text_embeddings: true
        dtype: bf16
      model:
        name_or_path: "{ckpt_path}"
        arch: minimax_h3
        quantize: false
        quantize_te: false
        low_vram: {str(params.get('low_vram', True)).lower()}  # 默认 true:GPU2 多租户余量 ~41G,40G 模型须 CPU 换入(2026-08-27 OOM 实证)
        model_kwargs:
          partition: fl2va_pruned
          sample_audio: false
"""
    else:  # family in _SDXL_FAMILIES:sdxl/sdxl_anime 走通用模板(其余族已被 _validate_family 拦截)
        config = f"""# Auto-generated by ToIV trainer for {lora_name}
job: extension
config:
  name: "{lora_name}"
  process:
    - type: sd_trainer
      training_folder: "{output_dir}"  # 每作业独立目录(共享 loras 根会被 resume 发现误捡其他 LoRA,2026-08-27 实证)
      device: cuda:0  # 物理卡由 subprocess CUDA_VISIBLE_DEVICES 指定(单卡视图,见 H3 实证)
      trigger_word: "{params.get('trigger_words', '')}"
      network:
        type: lora
        linear: {params['network_dim']}
        linear_alpha: {params['network_alpha']}
      save:
        dtype: float16
        save_every: 500
        max_step_saves_to_keep: 4
      datasets:
        - folder_path: "{dataset_path}"
          caption_ext: "txt"
          caption_dropout_rate: 0.05
          shuffle_tokens: false
          cache_latents_to_disk: true
          resolution: [{params['resolution']}]
      train:
        batch_size: {params['batch_size']}
        steps: {params['steps']}
        gradient_accumulation_steps: 1
        train_unet: true
        train_text_encoder: false
        gradient_cliping: 1.0
        optimizer: adamw8bit
        lr: {params['lr']}
        dtype: bf16
      model:
        name_or_path: "{ckpt_path}"
        is_sdxl: true
        quantize: false
"""
    config_path = os.path.join(output_dir, f"{lora_name}.yaml")
    with open(config_path, "w", encoding="utf-8") as f:
        f.write(config)
    return config_path, warning


# ---------------------------------------------------------------------------
# 训练进程 stdout 解析(提取 step/loss)
# ---------------------------------------------------------------------------
_STEP_RE = re.compile(r"step[:\s]*(\d+)\s*/\s*(\d+)", re.IGNORECASE)
_LOSS_RE = re.compile(r"loss[:\s]*([\d.]+)", re.IGNORECASE)


def _parse_train_output(line: str, job: dict) -> None:
    """解析 AI-Toolkit stdout,提取 step/loss,更新 job['progress']。"""
    step_m = _STEP_RE.search(line)
    loss_m = _LOSS_RE.search(line)
    if step_m:
        job["progress"]["step"] = int(step_m.group(1))
        job["progress"]["total"] = int(step_m.group(2))
    if loss_m:
        loss = float(loss_m.group(1))
        job["progress"]["loss"] = loss
        job["progress"]["recent_losses"].append(loss)
        if len(job["progress"]["recent_losses"]) > 50:
            job["progress"]["recent_losses"] = job["progress"]["recent_losses"][-50:]


def _find_lora_file(output_dir: str) -> str:
    """在作业目录下递归找最新 .safetensors(ai-toolkit 会自附加 name 一层,
    产物在 output_dir/<name>/<name>.safetensors —— 2026-08-27 实证双嵌套)。"""
    if not os.path.isdir(output_dir):
        return ""
    candidates = []
    for root, _dirs, files in os.walk(output_dir):
        for f in files:
            if f.endswith(".safetensors"):
                candidates.append(os.path.join(root, f))
    if not candidates:
        return ""
    return max(candidates, key=os.path.getmtime)


def _monitor_training(trainer_job_id: str, proc: subprocess.Popen, config_path: str, lora_name: str) -> None:
    """后台线程:读训练 stdout,更新进度,训练完标记 done。"""
    job = _jobs[trainer_job_id]
    # config 与 LoRA 产物同目录(h3 族在 H3_LORAS_DIR 下,其余族在 LORAS_DIR 下)
    output_dir = os.path.dirname(config_path)
    try:
        for line in iter(proc.stdout.readline, ""):
            line = line.strip()
            if not line:
                continue
            logger.info("[train %s] %s", trainer_job_id[:8], line)
            with _lock:
                _parse_train_output(line, job)
        proc.wait()
        if proc.returncode == 0:
            lora_file = _find_lora_file(output_dir)
            with _lock:
                job["status"] = "done"
                job["lora_path"] = lora_file
                job["samples"] = []
            logger.info("[train %s] DONE: %s", trainer_job_id[:8], lora_file)
        else:
            with _lock:
                job["status"] = "error"
                job["error"] = f"进程退出码 {proc.returncode}"
            logger.error("[train %s] ERROR: exit %s", trainer_job_id[:8], proc.returncode)
    except Exception as e:
        with _lock:
            job["status"] = "error"
            job["error"] = str(e)
        logger.exception("[train %s] exception", trainer_job_id[:8])


# ---------------------------------------------------------------------------
# Florence2 打标
# ---------------------------------------------------------------------------
def _run_caption(dataset_path: str, cuda_device: int, trigger_words: str) -> list[dict]:
    """用 Florence2 给数据集目录里所有图片打标,生成同名 .txt 文件。

    权重经 huggingface_hub 下载,走 HF_ENDPOINT 环境变量指定的端点(代码不硬编码
    镜像地址);离线/受限网络部署时设 HF_ENDPOINT=https://hf-mirror.com。
    ft 版下载/加载失败时回落到 base 模型。
    """
    from transformers import AutoProcessor, AutoModelForCausalLM  # type: ignore
    import torch

    model_id = "microsoft/Florence-2-large-ft"
    try:
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_id, trust_remote_code=True, torch_dtype=torch.float16
        ).to(f"cuda:{cuda_device}").eval()
    except Exception:
        # 回落到 base 模型(如果 ft 版下载失败)
        model_id = "microsoft/Florence-2-base"
        processor = AutoProcessor.from_pretrained(model_id, trust_remote_code=True)
        model = AutoModelForCausalLM.from_pretrained(
            model_id, trust_remote_code=True, torch_dtype=torch.float16
        ).to(f"cuda:{cuda_device}").eval()

    from PIL import Image
    captions = []
    exts = {".png", ".jpg", ".jpeg", ".webp", ".bmp"}
    for fname in sorted(os.listdir(dataset_path)):
        if Path(fname).suffix.lower() not in exts:
            continue
        fpath = os.path.join(dataset_path, fname)
        try:
            image = Image.open(fpath).convert("RGB")
            inputs = processor(images=image, text="<MORE_DETAILED_CAPTION>", return_tensors="pt").to(
                f"cuda:{cuda_device}", torch.float16
            )
            generated = model.generate(
                input_ids=inputs["input_ids"],
                pixel_values=inputs["pixel_values"],
                max_new_tokens=1024,
                num_beams=3,
                do_sample=False,
            )
            text = processor.batch_decode(generated, skip_special_tokens=True)[0]
            # 前置触发词
            if trigger_words:
                text = f"{trigger_words}, {text}"
            txt_path = os.path.splitext(fpath)[0] + ".txt"
            with open(txt_path, "w", encoding="utf-8") as f:
                f.write(text)
            captions.append({"filename": fname, "caption": text})
        except Exception as e:
            logger.warning("打标失败 %s: %s", fname, e)
            captions.append({"filename": fname, "caption": "", "error": str(e)})
    return captions


# ---------------------------------------------------------------------------
# HTTP handler
# ---------------------------------------------------------------------------
class TrainerHandler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        logger.info("%s - %s", self.address_string(), fmt % args)

    def _json(self, code: int, data: dict) -> None:
        body = json.dumps(data).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        length = int(self.headers.get("Content-Length", 0))
        if length == 0:
            return {}
        raw = self.rfile.read(length)
        return json.loads(raw)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/health":
            self._json(200, {"ok": True, "jobs": len(_jobs)})
            return

        # SSE: /train/{id}/events
        m = re.match(r"^/train/([^/]+)/events$", path)
        if m:
            self._sse_events(m.group(1))
            return

        # 作业状态(轮询用,飞轮编排脚本依赖):/train/{id}
        m = re.match(r"^/train/([^/]+)$", path)
        if m:
            self._handle_train_status(m.group(1))
            return

        self._json(404, {"error": "not found"})

    def _handle_train_status(self, trainer_job_id: str) -> None:
        job = _jobs.get(trainer_job_id)
        if not job:
            self._json(404, {"error": f"作业不存在: {trainer_job_id}"})
            return
        self._json(200, {
            "trainer_job_id": trainer_job_id,
            "status": job.get("status"),
            "progress": job.get("progress"),
            "lora_path": job.get("lora_path", ""),
            "error": job.get("error", ""),
        })

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/caption":
            self._handle_caption()
            return

        if path == "/upload":
            self._handle_upload()
            return

        if path == "/train":
            self._handle_train()
            return

        m = re.match(r"^/train/([^/]+)/stop$", path)
        if m:
            self._handle_stop(m.group(1))
            return

        self._json(404, {"error": "not found"})

    # -- /upload (API 通过 HTTP multipart 传数据集图片,trainer 存本地) --
    def _handle_upload(self) -> None:
        import cgi
        form = cgi.FieldStorage(
            fp=self.rfile,
            headers=self.headers,
            environ={"REQUEST_METHOD": "POST", "CONTENT_TYPE": self.headers.get("Content-Type", "")},
        )
        job_id = form.getvalue("job_id", str(uuid.uuid4())[:8])
        dst_dir = os.path.join(DATASETS_DIR, job_id)
        os.makedirs(dst_dir, exist_ok=True)
        count = 0
        for item in form.list:
            if item.filename:
                ext = os.path.splitext(item.filename)[1].lower() or ".png"
                fname = f"img-{count:03d}{ext}"
                with open(os.path.join(dst_dir, fname), "wb") as f:
                    f.write(item.file.read())
                count += 1
        logger.info("[upload] job_id=%s count=%d", job_id, count)
        self._json(200, {"job_id": job_id, "count": count, "dataset_dir": job_id})

    # -- /caption --
    def _handle_caption(self) -> None:
        body = self._read_body()
        dataset_dir = body.get("dataset_dir", "")
        cuda_device = body.get("cuda_device", 0)
        trigger_words = body.get("trigger_words", "")
        if not dataset_dir:
            self._json(400, {"error": "dataset_dir required"})
            return
        dataset_path = _resolve_dataset_path(dataset_dir)
        if not os.path.isdir(dataset_path):
            self._json(404, {"error": f"数据集目录不存在: {dataset_path}"})
            return
        try:
            captions = _run_caption(dataset_path, cuda_device, trigger_words)
            self._json(200, {"count": len(captions), "captions": captions})
        except Exception as e:
            logger.exception("打标失败")
            self._json(500, {"error": str(e)})

    # -- /train --
    def _handle_train(self) -> None:
        body = self._read_body()
        job_id = body.get("job_id", "")
        if not job_id:
            self._json(400, {"error": "job_id required"})
            return
        trainer_job_id = str(uuid.uuid4())[:8]
        try:
            config_path, warning = _make_ai_toolkit_config(body)
        except UnsupportedFamilyError as e:
            self._json(400, {"error": str(e), "supported_families": list(SUPPORTED_FAMILIES)})
            return
        except (KeyError, ValueError) as e:
            # 必填参数缺失/参数非法,返回 400 而非断连(2026-08-27 冒烟教训)
            self._json(400, {"error": f"参数错误: {e}"})
            return
        lora_name = body.get("lora_name", f"lora_{job_id[:8]}")

        # 启动 AI-Toolkit 训练进程
        env = os.environ.copy()
        env["CUDA_VISIBLE_DEVICES"] = str(body.get("cuda_device", 0))
        if body.get("family") == _H3_FAMILY:
            # H3 权重布局根(DiT int8/TE nvfp4/VAE 按 ComfyUI 目录布局寻址),仅 h3 族注入
            env["MODELS_PATH"] = H3_MODELS_PATH
        # AI-Toolkit 的 run.py 配置文件是位置参数(config_file_list,2026-08-27 实测 argparse)
        cmd = [TRAINER_VENV_PYTHON, os.path.join(AI_TOOLKIT_DIR, "run.py"), config_path]
        logger.info("[train %s] starting: %s", trainer_job_id, " ".join(cmd))
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            cwd=AI_TOOLKIT_DIR,
            env=env,
        )

        with _lock:
            _jobs[trainer_job_id] = {
                "proc": proc,
                "status": "training",
                "progress": {"step": 0, "total": body.get("steps", 1000), "loss": 0, "recent_losses": []},
                "lora_path": "",
                "samples": [],
                "error": "",
                "lora_name": lora_name,
                "config_path": config_path,
            }

        # 后台线程读 stdout 更新进度
        t = threading.Thread(target=_monitor_training, args=(trainer_job_id, proc, config_path, lora_name), daemon=True)
        t.start()

        self._json(200, {"trainer_job_id": trainer_job_id, "warning": warning})

    # -- /train/{id}/stop --
    def _handle_stop(self, trainer_job_id: str) -> None:
        with _lock:
            job = _jobs.get(trainer_job_id)
            if not job:
                self._json(404, {"error": "作业不存在"})
                return
            if job["proc"].poll() is None:
                job["proc"].terminate()
            job["status"] = "error"
            job["error"] = "用户停止"
        self._json(200, {"ok": True})

    # -- SSE /train/{id}/events --
    def _sse_events(self, trainer_job_id: str) -> None:
        job = _jobs.get(trainer_job_id)
        if not job:
            self._json(404, {"error": "作业不存在"})
            return

        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "keep-alive")
        self.end_headers()

        last_step = -1
        while True:
            with _lock:
                j = _jobs.get(trainer_job_id)
                if not j:
                    break
                status = j["status"]
                progress = dict(j["progress"])
                lora_path = j.get("lora_path", "")
                error = j.get("error", "")
                samples = j.get("samples", [])

            if progress["step"] != last_step or status in ("done", "error"):
                last_step = progress["step"]
                if status == "training":
                    data = {"event": "progress", **progress}
                elif status == "done":
                    data = {"event": "done", "lora_path": lora_path, "samples": samples}
                else:
                    data = {"event": "error", "message": error or "训练失败"}
                self.wfile.write(f"data: {json.dumps(data)}\n\n")
                self.wfile.flush()

            if status in ("done", "error"):
                break
            time.sleep(1.0)


def main() -> None:
    os.makedirs(DATASETS_DIR, exist_ok=True)
    os.makedirs(LORAS_DIR, exist_ok=True)
    server = ThreadingHTTPServer((HOST, PORT), TrainerHandler)
    logger.info("ToIV Trainer agent listening on %s:%d", HOST, PORT)
    logger.info("AI-Toolkit: %s", AI_TOOLKIT_DIR)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        logger.info("Shutting down...")
        server.shutdown()


if __name__ == "__main__":
    main()
