#!/usr/bin/env python3
"""
demucs-mlx FastAPI server for studio01.
Compatible with ToIV /api/audio/separate contract.
"""

import asyncio
import hashlib
import logging
import os
import tempfile
import time
import traceback
import urllib.parse
import uuid
from pathlib import Path
from typing import Optional

import aiohttp
import soundfile as sf
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel

from demucs_mlx import Separator, save_audio

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
HOST = os.getenv("TOIV_DEMUX_HOST", "0.0.0.0")
PORT = int(os.getenv("TOIV_DEMUX_PORT", "9221"))
MODEL = os.getenv("TOIV_DEMUX_MODEL", "htdemucs")
OUTPUT_DIR = Path(os.getenv("TOIV_DEMUX_OUTPUT_DIR", "~/toiv-demucs-mlx/outputs")).expanduser()
MAX_AGE_SECONDS = int(os.getenv("TOIV_DEMUX_MAX_AGE_SECONDS", "86400"))
REQUEST_TIMEOUT = int(os.getenv("TOIV_DEMUX_REQUEST_TIMEOUT", "300"))
# Optional external base URL for returned download links, e.g. http://192.168.71.109:9221
BASE_URL = os.getenv("TOIV_DEMUX_BASE_URL", f"http://127.0.0.1:{PORT}")

OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
)
logger = logging.getLogger("demucs-mlx-server")

# ---------------------------------------------------------------------------
# Model loading
# ---------------------------------------------------------------------------
logger.info(f"Loading demucs-mlx model: {MODEL}")
_separator: Optional[Separator] = None
_sep_lock = asyncio.Lock()


def get_separator() -> Separator:
    global _separator
    if _separator is None:
        _separator = Separator(model=MODEL, shifts=1, overlap=0.25, split=True, batch_size=1)
        logger.info(
            f"Model loaded: sources={_separator._model.sources}, "
            f"sr={_separator.samplerate}, channels={_separator.audio_channels}"
        )
    return _separator


# ---------------------------------------------------------------------------
# FastAPI app
# ---------------------------------------------------------------------------
app = FastAPI(title="ToIV demucs-mlx audio separation", version="1.0.0")


@app.on_event("startup")
async def startup():
    # Warm up model in a thread to avoid blocking the event loop.
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, get_separator)
    logger.info(f"Server ready on {HOST}:{PORT}")


@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL, "sources": get_separator()._model.sources}


@app.get("/")
async def root():
    return {"service": "demucs-mlx", "model": MODEL, "health": "/health", "separate": "/separate"}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------
async def download_audio(url: str, dest: Path) -> None:
    timeout = aiohttp.ClientTimeout(total=60)
    async with aiohttp.ClientSession(timeout=timeout) as session:
        async with session.get(url) as resp:
            if resp.status != 200:
                raise HTTPException(status_code=400, detail=f"Failed to download audio: {resp.status}")
            with open(dest, "wb") as f:
                async for chunk in resp.content.iter_chunked(8192):
                    f.write(chunk)


def make_output_dir(job_id: str) -> Path:
    out = OUTPUT_DIR / job_id
    out.mkdir(parents=True, exist_ok=True)
    return out


def cleanup_old_outputs():
    now = time.time()
    for item in OUTPUT_DIR.iterdir():
        if item.is_dir():
            try:
                mtime = item.stat().st_mtime
                if now - mtime > MAX_AGE_SECONDS:
                    for f in item.iterdir():
                        f.unlink()
                    item.rmdir()
                    logger.info(f"Cleaned up old output dir: {item}")
            except Exception as e:
                logger.warning(f"Cleanup error for {item}: {e}")


def run_separation(input_path: Path, output_dir: Path) -> dict:
    sep = get_separator()
    wav, stems = sep.separate_audio_file(str(input_path), return_mx=False)

    results = {}
    for stem_name, stem_audio in stems.items():
        out_path = output_dir / f"{stem_name}.wav"
        save_audio(stem_audio, out_path, samplerate=sep.samplerate, clip="rescale")
        results[stem_name] = out_path

    # accompaniment = drums + bass + other
    if {"drums", "bass", "other"}.issubset(stems.keys()):
        import numpy as np
        acc = np.sum([np.asarray(stems[name]) for name in ("drums", "bass", "other")], axis=0)
        acc_path = output_dir / "accompaniment.wav"
        save_audio(acc, acc_path, samplerate=sep.samplerate, clip="rescale")
        results["accompaniment"] = acc_path

    return results


def build_urls(job_id: str, files: dict) -> dict:
    urls = {}
    for name, path in files.items():
        urls[f"{name}_url"] = f"{BASE_URL}/outputs/{job_id}/{path.name}"
    return urls


# ---------------------------------------------------------------------------
# Endpoints
# ---------------------------------------------------------------------------
class SeparateRequest(BaseModel):
    audio_url: Optional[str] = None


@app.post("/separate")
async def separate(
    audio_url: Optional[str] = Form(None),
    audio_file: Optional[UploadFile] = File(None),
    callback_url: Optional[str] = Form(None),
):
    if not audio_url and not audio_file:
        raise HTTPException(status_code=400, detail="Either audio_url or audio_file must be provided")

    job_id = uuid.uuid4().hex[:16]
    output_dir = make_output_dir(job_id)

    with tempfile.TemporaryDirectory() as tmpdir:
        tmp_path = Path(tmpdir) / f"{job_id}_input"

        try:
            if audio_file is not None:
                content = await audio_file.read()
                tmp_path.write_bytes(content)
                logger.info(f"[{job_id}] Received upload: {audio_file.filename}, size={len(content)}")
            else:
                await download_audio(audio_url, tmp_path)
                logger.info(f"[{job_id}] Downloaded from {audio_url}")

            # Validate audio.
            info = sf.info(str(tmp_path))
            logger.info(f"[{job_id}] Audio info: sr={info.samplerate}, frames={info.frames}, channels={info.channels}")
        except HTTPException:
            raise
        except Exception as e:
            logger.error(f"[{job_id}] Input error: {e}\n{traceback.format_exc()}")
            raise HTTPException(status_code=400, detail=f"Invalid audio input: {e}")

        # Run separation under lock to serialize GPU/ANE access.
        start = time.time()
        try:
            async with _sep_lock:
                loop = asyncio.get_event_loop()
                files = await asyncio.wait_for(
                    loop.run_in_executor(None, run_separation, tmp_path, output_dir),
                    timeout=REQUEST_TIMEOUT,
                )
        except asyncio.TimeoutError:
            raise HTTPException(status_code=504, detail="Separation timed out")
        except Exception as e:
            logger.error(f"[{job_id}] Separation error: {e}\n{traceback.format_exc()}")
            raise HTTPException(status_code=500, detail=f"Separation failed: {e}")
        elapsed = time.time() - start

    urls = build_urls(job_id, files)
    cleanup_old_outputs()

    response = {
        "job_id": job_id,
        "model": MODEL,
        "elapsed_seconds": round(elapsed, 3),
        "sources": list(files.keys()),
    }
    response.update(urls)

    logger.info(f"[{job_id}] Separation complete in {elapsed:.2f}s: {files.keys()}")
    return JSONResponse(content=response)


@app.get("/outputs/{job_id}/{filename}")
async def serve_output(job_id: str, filename: str):
    path = OUTPUT_DIR / job_id / filename
    if not path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(path, media_type="audio/wav", filename=filename)


# ---------------------------------------------------------------------------
# Entrypoint
# ---------------------------------------------------------------------------
if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host=HOST, port=PORT, log_level="info")
