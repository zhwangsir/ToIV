"""ToIV SCoPE 相机运镜视频服务 —— Wan2.2-A14B + SCoPE(腾讯 ARC)FastAPI 封装。

契约(ToIV core routes/scope.py 调用方期望):
  POST /generate  JSON:
      image_base64  (可选,与 image_path 二选一) —— 首帧图 base64(可带 data URL 头)
      image_path    (可选,本机/NAS 挂载路径,白名单前缀内)
      prompt        (必填) 文本提示词
      trajectory    (必填) 轨迹预设名(GET /trajectories 枚举)
      x_fov         (可选,默认 1.11847 rad,水平视场角)
      xi            (可选,默认 0.0,针孔相机)
      seed          (可选,默认 42)
      steps         (可选,默认 40,1-40;e2e/调试用小步数)
      negative_prompt (可选,默认 configs/negative_prompt.txt)
    Response: 200 + mp4 二进制(video/mp4),头带 X-Scope-{Trajectory,Seed,Elapsed};
      失败 JSON {"detail": "..."}(400 参数错 / 404 轨迹不存在 / 500 推理失败)
  GET  /health       → {status, model_loaded, busy, device, vram_limit_gb}
  GET  /trajectories → {trajectories: [{name, source}], count}

并发策略:A14B 双专家 67G 常驻(vram_limit 控显存,余量 offload 到 RAM),
推理是 GPU 单卡同步阻塞,asyncio.Lock 串行排队,同一时刻只跑一个生成
(同 index-tts toiv_tts_server.py 纪律)。

轨迹预设:examples/poses/ 下全部 .npy(名 = 相对路径去后缀,如
"panshot-car-show/dolly_in")+ scope_trajectories.py 生成的参数化预设
("gen/orbit_left" 等 12 个,启动时幂等写盘)。

启动(systemd toiv-scope.service):
  cd /home/merlin/scope-src
  CUDA_VISIBLE_DEVICES=3 SCOPE_VRAM_LIMIT_GB=40 \
    .venv/bin/python toiv_scope_server.py --host 0.0.0.0 --port 9401
"""
from __future__ import annotations

import argparse
import asyncio
import base64
import binascii
import logging
import os
import tempfile
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Any

import numpy as np
import torch
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from scope.config import InferenceConfig
from scope.example_selection import load_pose
from scope.inference import _prepare_device, generate
from scope.weights import load_pipeline, resolve_model_dir

import scope_trajectories

logger = logging.getLogger("toiv-scope")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

REPO_ROOT = Path(__file__).resolve().parent
MODEL_PATH = os.environ.get(
    "SCOPE_MODEL_PATH", "/home/merlin/nas_mount/toiv/comfyui-models/scope"
)
POSES_DIR = Path(os.environ.get("SCOPE_POSES_DIR", REPO_ROOT / "examples" / "poses"))
GEN_POSES_DIR = Path(os.environ.get("SCOPE_GEN_POSES_DIR", REPO_ROOT / "poses_generated"))
NEGATIVE_PROMPT_PATH = REPO_ROOT / "configs" / "negative_prompt.txt"
# image_path 白名单前缀:NAS 挂载 / 本服务目录 / 临时目录,防任意文件读
_IMAGE_PATH_PREFIXES = ("/home/merlin/nas_mount/", str(REPO_ROOT) + "/", "/tmp/")
_MAX_IMAGE_BYTES = 30 * 1024 * 1024  # 首帧图上限 30MB(base64 解码后)

_PIPE = None  # SCoPEPipeline,启动时加载一次,常驻
_DEVICE: torch.device | None = None
_VRAM_LIMIT_GB = float(os.environ.get("SCOPE_VRAM_LIMIT_GB", "40"))
_GEN_LOCK = asyncio.Lock()
_PRESETS: dict[str, Path] = {}
_NEGATIVE_PROMPT = ""


def _discover_presets() -> dict[str, Path]:
    """examples/poses/**/*.npy(相对路径名)+ gen/*(参数化生成,幂等写盘)。"""
    scope_trajectories.write_generated_presets(GEN_POSES_DIR)
    presets: dict[str, Path] = {}
    for p in sorted(POSES_DIR.rglob("*.npy")):
        name = p.relative_to(POSES_DIR).with_suffix("").as_posix()
        presets[name] = p
    for p in sorted(GEN_POSES_DIR.glob("*.npy")):
        presets[f"gen/{p.stem}"] = p
    return presets


class GenerateRequest(BaseModel):
    image_base64: str | None = Field(default=None, max_length=45_000_000)
    image_path: str | None = Field(default=None, max_length=1000)
    prompt: str = Field(min_length=1, max_length=4000)
    trajectory: str = Field(min_length=1, max_length=200)
    x_fov: float = Field(default=1.11847, gt=0.0, lt=3.2)
    xi: float = Field(default=0.0, ge=0.0, le=2.0)
    seed: int = Field(default=42, ge=0, le=2**63 - 1)
    steps: int = Field(default=40, ge=1, le=40)
    negative_prompt: str | None = Field(default=None, max_length=4000)


def _resolve_image(req: GenerateRequest, workdir: Path) -> Path:
    """base64 → 临时 png;image_path → 白名单校验后直接用。返回首帧图路径。"""
    if req.image_base64 and req.image_path:
        raise HTTPException(status_code=400, detail="image_base64 与 image_path 只能传一个")
    if req.image_base64:
        b64 = req.image_base64
        if "," in b64 and b64.split(",", 1)[0].startswith("data:"):
            b64 = b64.split(",", 1)[1]
        try:
            content = base64.b64decode(b64, validate=True)
        except (binascii.Error, ValueError) as e:
            raise HTTPException(status_code=400, detail=f"image_base64 解码失败:{e}") from e
        if not content or len(content) > _MAX_IMAGE_BYTES:
            raise HTTPException(status_code=400, detail="首帧图为空或超过 30MB 上限")
        path = workdir / "first_frame.png"
        path.write_bytes(content)
        return path
    if req.image_path:
        p = Path(req.image_path)
        if not any(str(p).startswith(prefix) for prefix in _IMAGE_PATH_PREFIXES):
            raise HTTPException(status_code=400, detail="image_path 不在允许的前缀内")
        if not p.is_file():
            raise HTTPException(status_code=400, detail=f"image_path 不存在:{p}")
        return p
    raise HTTPException(status_code=400, detail="必须提供 image_base64 或 image_path")


def _run_generation(req: GenerateRequest) -> tuple[bytes, float]:
    """同步推理(在 worker 线程里跑,由 _GEN_LOCK 保证串行)。返回 (mp4 字节, 耗时)。"""
    assert _PIPE is not None and _DEVICE is not None
    started = time.monotonic()
    with tempfile.TemporaryDirectory(prefix="scope-gen-") as td:
        workdir = Path(td)
        image_path = _resolve_image(req, workdir)
        pose_path = _PRESETS.get(req.trajectory)
        if pose_path is None:
            raise HTTPException(
                status_code=404,
                detail=f"未知轨迹预设:{req.trajectory}(GET /trajectories 枚举)",
            )
        pose = load_pose(pose_path, InferenceConfig.num_frames)
        example: dict[str, Any] = {
            "first_frame": image_path,
            "caption": req.prompt,
            "x_fov": req.x_fov,
            "xi": req.xi,
        }
        config = InferenceConfig(seed=req.seed, num_inference_steps=req.steps)
        out = workdir / f"scope-{uuid.uuid4().hex}.mp4"
        generate(
            _PIPE,
            example,
            out,
            config,
            req.negative_prompt if req.negative_prompt is not None else _NEGATIVE_PROMPT,
            _DEVICE,
            pose=pose,
        )
        elapsed = time.monotonic() - started
        return out.read_bytes(), elapsed


@asynccontextmanager
async def _lifespan(app: FastAPI):
    global _PIPE, _DEVICE, _PRESETS, _NEGATIVE_PROMPT
    _PRESETS = _discover_presets()
    logger.info("轨迹预设 %d 个(examples %d + gen)", len(_PRESETS), len(list(POSES_DIR.rglob('*.npy'))))
    _NEGATIVE_PROMPT = NEGATIVE_PROMPT_PATH.read_text(encoding="utf-8").strip()
    logger.info("加载 SCoPE 模型 %s(vram_limit=%.0fGB)...", MODEL_PATH, _VRAM_LIMIT_GB)
    model_dir = resolve_model_dir(MODEL_PATH, None)
    _PIPE = await asyncio.to_thread(load_pipeline, model_dir, InferenceConfig())
    _DEVICE = await asyncio.to_thread(_prepare_device, _PIPE, _VRAM_LIMIT_GB)
    logger.info("SCoPE 已就绪(device=%s)", _DEVICE)
    yield


app = FastAPI(title="ToIV SCoPE Camera Video", lifespan=_lifespan)


@app.get("/health")
async def health() -> dict[str, Any]:
    return {
        "status": "ok",
        "model_loaded": _PIPE is not None,
        "busy": _GEN_LOCK.locked(),
        "device": str(_DEVICE) if _DEVICE else None,
        "vram_limit_gb": _VRAM_LIMIT_GB,
        "trajectories": len(_PRESETS),
    }


@app.get("/trajectories")
async def trajectories() -> dict[str, Any]:
    return {
        "count": len(_PRESETS),
        "trajectories": [
            {"name": name, "source": "generated" if name.startswith("gen/") else "examples"}
            for name in sorted(_PRESETS)
        ],
    }


@app.post("/generate")
async def generate_video(req: GenerateRequest) -> Response:
    if _PIPE is None:
        raise HTTPException(status_code=503, detail="模型尚未加载完成")
    # 串行队列:锁内跑完整推理,等待中的请求排队(同 TTS 服务纪律)
    async with _GEN_LOCK:
        try:
            mp4, elapsed = await asyncio.to_thread(_run_generation, req)
        except HTTPException:
            raise
        except Exception as e:
            logger.exception("SCoPE 推理失败")
            raise HTTPException(status_code=500, detail=f"推理失败:{e}") from e
    logger.info(
        "生成完成 trajectory=%s seed=%d steps=%d 耗时 %.1fs",
        req.trajectory, req.seed, req.steps, elapsed,
    )
    return Response(
        content=mp4,
        media_type="video/mp4",
        headers={
            "X-Scope-Trajectory": req.trajectory,
            "X-Scope-Seed": str(req.seed),
            "X-Scope-Elapsed": f"{elapsed:.1f}",
        },
    )


def main() -> None:
    parser = argparse.ArgumentParser(description="ToIV SCoPE camera video service")
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=9401)
    args = parser.parse_args()
    import uvicorn

    uvicorn.run(app, host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
