import os, time, tempfile
from fastapi import FastAPI, UploadFile, Form
from fastapi.responses import PlainTextResponse

app = FastAPI(title="ToIV Whisper ASR (mlx-whisper)")


def _ts(seconds):
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:06.3f}".replace(".", ",")


@app.post("/v1/audio/transcriptions")
async def transcriptions(file: UploadFile, language: str = Form(None),
                         response_format: str = Form("json"), model: str = Form("large-v3"),
                         timestamp_granularities: list[str] = Form(default=[], alias="timestamp_granularities[]")):
    import mlx_whisper
    audio = await file.read()
    suffix = os.path.splitext(file.filename or "audio.wav")[1] or ".wav"
    with tempfile.NamedTemporaryFile(suffix=suffix, delete=False) as f:
        f.write(audio)
        path = f.name
    want_words = "word" in (timestamp_granularities or [])
    try:
        import numpy as np
        import soundfile as sf
        data, _sr = sf.read(path, dtype="float32")
        if data.ndim > 1:
            data = data.mean(axis=1)
        t0 = time.time()
        kwargs = dict(path_or_hf_repo="mlx-community/whisper-large-v3-mlx", audio=np.ascontiguousarray(data))
        if language:
            kwargs["language"] = language
        if want_words:
            kwargs["word_timestamps"] = True
        result = mlx_whisper.transcribe(**kwargs)
        elapsed = time.time() - t0
    finally:
        os.unlink(path)
    if response_format == "srt":
        lines = []
        for i, seg in enumerate(result.get("segments", []), 1):
            text = seg["text"].strip()
            lines.append(f"{i}\n{_ts(seg['start'])} --> {_ts(seg['end'])}\n{text}\n")
        return PlainTextResponse("\n".join(lines), media_type="text/plain")
    if response_format == "verbose_json":
        out = {"text": result.get("text", ""), "language": result.get("language"),
               "duration": result.get("duration"), "elapsed_s": round(elapsed, 2),
               "segments": [{"start": s["start"], "end": s["end"], "text": s["text"]}
                            for s in result.get("segments", [])]}
        if want_words:
            words = [w for s in result.get("segments", []) for w in s.get("words", [])]
            if not words:
                words = result.get("words") or []
            out["words"] = [{"word": w.get("word"), "start": w.get("start"), "end": w.get("end")}
                            for w in words]
        return out
    return {"text": result.get("text", ""), "language": result.get("language"),
            "duration": result.get("duration"), "elapsed_s": round(elapsed, 2),
            "segments": len(result.get("segments", []))}


@app.get("/health")
async def health():
    return {"status": "ok", "service": "whisper-mlx", "port": 9310}
