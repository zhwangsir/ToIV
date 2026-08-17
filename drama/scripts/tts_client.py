"""IndexTTS2 语音合成客户端。"""
from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Any

import requests

from config import TTS_URL, REF_AUDIO


def synthesize(text: str, output_path: Path, ref_audio: Path | None = None, emo_text: str = "", emo_alpha: float = 0.0, language: str = "zh") -> dict[str, Any]:
    """调用 IndexTTS2 生成 WAV。"""
    output_path.parent.mkdir(parents=True, exist_ok=True)
    url = f"{TTS_URL}/tts"
    data = {"text": text, "emo_text": emo_text, "emo_alpha": str(emo_alpha), "language": language}
    files = {}
    if ref_audio and ref_audio.is_file():
        files["ref_audio"] = open(ref_audio, "rb")
    try:
        r = requests.post(url, data=data, files=files, timeout=120)
        r.raise_for_status()
        with open(output_path, "wb") as f:
            f.write(r.content)
        return {"ok": True, "path": str(output_path), "size": output_path.stat().st_size}
    finally:
        for f in files.values():
            f.close()


def synthesize_all(narration: list[dict], out_dir: Path, base_ref: Path | None = None) -> list[dict[str, Any]]:
    """批量生成所有台词音频。"""
    out_dir.mkdir(parents=True, exist_ok=True)
    results = []
    for i, line in enumerate(narration):
        speaker = line["speaker"]
        ref = Path(REF_AUDIO.get(speaker, "")) if not base_ref else base_ref
        out = out_dir / f"{i:03d}_{speaker}.wav"
        res = synthesize(line["text"], out, ref_audio=ref if ref.is_file() else None)
        res.update({"index": i, "speaker": speaker, "start": line["start"], "end": line["end"], "text": line["text"]})
        results.append(res)
        time.sleep(0.5)
    return results


if __name__ == "__main__":
    import config
    test_path = Path("drama/output/audio/test.wav")
    r = synthesize("这是 IndexTTS2 测试语音。", test_path)
    print(json.dumps(r, ensure_ascii=False))
