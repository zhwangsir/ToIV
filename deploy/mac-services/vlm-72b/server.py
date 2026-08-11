import os
import sys
import time
import base64
import binascii
import tempfile
import logging
from contextlib import asynccontextmanager
from typing import Optional
from pathlib import Path

import requests
from fastapi import FastAPI, Form, File, UploadFile, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
import uvicorn

from mlx_vlm import load, generate, apply_chat_template

# ---------------------------------------------------------------------------
# Configuration
# ---------------------------------------------------------------------------
MODEL_PATH = os.environ.get("TOIV_VLM_MODEL_PATH", os.path.expanduser(
    "~/toiv-vlm-mlx/models/Qwen2.5-VL-72B-Instruct-4bit"))
HOST = os.environ.get("TOIV_VLM_HOST", "0.0.0.0")
PORT = int(os.environ.get("TOIV_VLM_PORT", "9303"))
DEFAULT_MAX_TOKENS = int(os.environ.get("TOIV_VLM_MAX_TOKENS", "300"))
DEFAULT_TEMPERATURE = float(os.environ.get("TOIV_VLM_TEMPERATURE", "0.2"))
DEFAULT_PROMPT = (
    "Describe this image in detail, focusing on subject, style, lighting, "
    "composition, colors, and mood. Output a concise prompt suitable for "
    "text-to-image generation."
)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[logging.StreamHandler(sys.stdout)],
)
logger = logging.getLogger("toiv-vlm")

# ---------------------------------------------------------------------------
# Model loading (done once at startup)
# ---------------------------------------------------------------------------
model = None
processor = None
model_name = os.path.basename(MODEL_PATH)


def _load_model():
    global model, processor
    logger.info("Loading model from %s", MODEL_PATH)
    start = time.time()
    model, processor = load(MODEL_PATH, lazy=False)
    logger.info("Model loaded in %.2f seconds", time.time() - start)


@asynccontextmanager
async def lifespan(app: FastAPI):
    _load_model()
    yield
    logger.info("Shutting down VLM server")


app = FastAPI(title="ToIV VLM Reverse Service", lifespan=lifespan)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
def _decode_data_url(url: str) -> bytes:
    try:
        header, encoded = url.split(",", 1)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid data URL")
    try:
        return base64.b64decode(encoded)
    except binascii.Error as e:
        raise HTTPException(status_code=400, detail=f"Invalid base64 data: {e}")


def _save_temp(data: bytes, suffix: str) -> str:
    fd, path = tempfile.mkstemp(prefix="toiv_vlm_", suffix=suffix)
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(data)
    except Exception:
        os.remove(path)
        raise
    return path


def _fetch_image(url: str) -> bytes:
    try:
        resp = requests.get(url, timeout=60)
        resp.raise_for_status()
        return resp.content
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Failed to fetch image_url: {e}")


def _infer_media_suffix(path_or_url: str) -> str:
    lowered = path_or_url.lower()
    for ext in [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"]:
        if lowered.endswith(ext):
            return ext
    return ".png"


def _process_image_url(image_url: str) -> str:
    if image_url.startswith("data:"):
        data = _decode_data_url(image_url)
        suffix = ".png"
        if "image/jpeg" in image_url[:100]:
            suffix = ".jpg"
        elif "image/webp" in image_url[:100]:
            suffix = ".webp"
        elif "image/png" in image_url[:100]:
            suffix = ".png"
        return _save_temp(data, suffix)
    if image_url.startswith(("http://", "https://")):
        data = _fetch_image(image_url)
        suffix = _infer_media_suffix(image_url)
        return _save_temp(data, suffix)
    # Treat as local path
    if not os.path.exists(image_url):
        raise HTTPException(status_code=400, detail=f"image_url path not found: {image_url}")
    return image_url


def _run_inference(media_path: str, prompt_text: str, media_type: str,
                   max_tokens: int, temperature: float) -> dict:
    if model is None or processor is None:
        raise HTTPException(status_code=503, detail="Model not loaded")

    start = time.time()
    try:
        if media_type == "image":
            formatted = apply_chat_template(
                processor, model.config, prompt_text, num_images=1
            )
            result = generate(
                model, processor, formatted, image=media_path,
                max_tokens=max_tokens, temperature=temperature, verbose=False,
            )
        elif media_type == "video":
            formatted = apply_chat_template(
                processor, model.config, prompt_text, num_images=0, video=media_path,
            )
            result = generate(
                model, processor, formatted, video=media_path,
                max_tokens=max_tokens, temperature=temperature, verbose=False,
            )
        else:
            raise HTTPException(status_code=400, detail=f"Unsupported media_type: {media_type}")
    except Exception as e:
        logger.exception("Generation failed")
        raise HTTPException(status_code=500, detail=f"Generation failed: {e}")

    elapsed = time.time() - start
    text = result.text.strip() if hasattr(result, "text") else str(result).strip()
    peak_mem = getattr(result, "peak_memory", None)
    prompt_tokens = getattr(result, "prompt_tokens", None)
    generation_tokens = getattr(result, "generation_tokens", None)

    logger.info(
        "Generated %d tokens in %.2fs (peak_mem=%s)",
        generation_tokens or 0, elapsed,
        f"{peak_mem:.2f} GB" if peak_mem else "unknown",
    )

    return {
        "prompt": text,
        "caption": text,
        "model": model_name,
        "media_type": media_type,
        "elapsed_seconds": elapsed,
        "prompt_tokens": prompt_tokens,
        "generation_tokens": generation_tokens,
        "peak_memory_gb": peak_mem,
    }


# ---------------------------------------------------------------------------
# API schemas
# ---------------------------------------------------------------------------
class ReverseRequest(BaseModel):
    image_url: Optional[str] = None
    video_path: Optional[str] = None
    prompt: Optional[str] = DEFAULT_PROMPT
    max_tokens: int = Field(default=DEFAULT_MAX_TOKENS, ge=1, le=2048)
    temperature: float = Field(default=DEFAULT_TEMPERATURE, ge=0.0, le=2.0)


class ReverseResponse(BaseModel):
    prompt: str
    caption: str
    model: str
    media_type: str
    elapsed_seconds: float
    prompt_tokens: Optional[int] = None
    generation_tokens: Optional[int] = None
    peak_memory_gb: Optional[float] = None


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
@app.get("/health")
def health():
    return {
        "status": "ok",
        "model": model_name,
        "loaded": model is not None,
    }


@app.post("/v1/reverse", response_model=ReverseResponse)
@app.post("/reverse", response_model=ReverseResponse)
async def reverse_json(body: ReverseRequest):
    prompt_text = body.prompt or DEFAULT_PROMPT
    temp_paths = []

    try:
        if body.image_url:
            media_path = _process_image_url(body.image_url)
            temp_paths.append(media_path)
            media_type = "image"
        elif body.video_path:
            if not os.path.exists(body.video_path):
                raise HTTPException(status_code=400, detail=f"video_path not found: {body.video_path}")
            media_path = body.video_path
            media_type = "video"
        else:
            raise HTTPException(status_code=400, detail="Provide image_url or video_path")

        # Run inference in threadpool to avoid blocking the event loop
        from concurrent.futures import ThreadPoolExecutor
        import asyncio
        loop = asyncio.get_event_loop()
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = await loop.run_in_executor(
                pool,
                _run_inference,
                media_path,
                prompt_text,
                media_type,
                body.max_tokens,
                body.temperature,
            )
    finally:
        for p in temp_paths:
            try:
                if p.startswith(tempfile.gettempdir()):
                    os.remove(p)
            except Exception:
                pass

    return result


@app.post("/v1/reverse/file", response_model=ReverseResponse)
@app.post("/reverse/file", response_model=ReverseResponse)
async def reverse_file(
    image_file: UploadFile = File(...),
    prompt: Optional[str] = Form(DEFAULT_PROMPT),
    max_tokens: int = Form(DEFAULT_MAX_TOKENS),
    temperature: float = Form(DEFAULT_TEMPERATURE),
):
    if not image_file.filename:
        raise HTTPException(status_code=400, detail="No file uploaded")

    suffix = Path(image_file.filename).suffix or ".png"
    data = await image_file.read()
    temp_path = _save_temp(data, suffix)
    try:
        from concurrent.futures import ThreadPoolExecutor
        import asyncio
        loop = asyncio.get_event_loop()
        with ThreadPoolExecutor(max_workers=1) as pool:
            result = await loop.run_in_executor(
                pool,
                _run_inference,
                temp_path,
                prompt or DEFAULT_PROMPT,
                "image",
                max_tokens,
                temperature,
            )
    finally:
        try:
            os.remove(temp_path)
        except Exception:
            pass

    return result


if __name__ == "__main__":
    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
