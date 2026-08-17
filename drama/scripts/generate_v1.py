"""短剧 V1 生成主控脚本。

流程:
1. 每个镜头用 LTX t2v 直接生成 6s 视频片段
2. 按分镜时长裁剪视频片段
3. 生成 TTS 配音
4. ffmpeg 拼接视频 + 音轨混音 + 烧录字幕
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from config import NARRATION, SHOTS, shot_prompt_with_chars
from comfy_client import ComfyClient, build_ltx_t2v_graph
from tts_client import synthesize_all

ROOT = Path(__file__).parent.parent
OUTPUT = ROOT / "output"
SHOTS_DIR = OUTPUT / "shots"
AUDIO_DIR = OUTPUT / "audio"
FINAL_DIR = OUTPUT / "final"
SHOTS_DIR.mkdir(parents=True, exist_ok=True)
AUDIO_DIR.mkdir(parents=True, exist_ok=True)
FINAL_DIR.mkdir(parents=True, exist_ok=True)

client = ComfyClient()


def generate_video(shot: dict, seed: int) -> Path:
    """用 LTX t2v 生成 6s 视频片段。"""
    prompt = shot_prompt_with_chars(shot)
    graph = build_ltx_t2v_graph(prompt, shot["negative"], seed=seed)
    pid = client.submit(graph)
    print(f"  [{shot['id']}] video prompt_id={pid}")
    history = client.wait(pid, max_wait=900)
    outputs = client.get_outputs(history)
    if not outputs:
        raise RuntimeError(f"video for {shot['id']} produced no output")
    out = outputs[0]
    raw = SHOTS_DIR / shot["id"] / "raw.mp4"
    client.download(out["filename"], out["subfolder"], raw)
    print(f"  -> {raw} ({raw.stat().st_size / 1024:.1f} KB)")
    return raw


def trim_clip(src: Path, shot: dict) -> Path:
    """按分镜时长裁剪到目标秒数。"""
    dest = SHOTS_DIR / shot["id"] / "clip.mp4"
    dur = shot["duration"]
    cmd = [
        "ffmpeg", "-y", "-i", str(src), "-t", str(dur),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-an", str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return dest


def concat_clips(clips: list[Path], output: Path):
    """用 ffmpeg concat demuxer 拼接所有镜头。"""
    list_file = FINAL_DIR / "concat_list.txt"
    with open(list_file, "w") as f:
        for c in clips:
            f.write(f"file '{c.absolute()}'\n")
    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-an", str(output),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def build_subtitle_ass(narration: list[dict], output: Path):
    """生成简单 ASS 字幕文件。"""
    header = """[Script Info]
Title: Drama Subtitle
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Source Han Sans SC,48,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,2,0,2,10,10,60,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
"""
    def fmt(sec: float) -> str:
        h = int(sec // 3600)
        m = int((sec % 3600) // 60)
        s = sec % 60
        return f"{h}:{m:02d}:{s:05.2f}"
    lines = [header]
    for line in narration:
        speaker_tag = {"narrator": "", "goku": "【卡卡罗特】", "vegeta": "【贝吉塔】", "shihhao": "【石昊】", "smalltower": "【小塔】", "goku+vegeta": "【二人】"}.get(line["speaker"], "")
        text = (speaker_tag + line["text"]).replace(",", "，")
        lines.append(f"Dialogue: 0,{fmt(line['start'])},{fmt(line['end'])},Default,,0,0,0,,{text}\n")
    output.write_text("".join(lines), encoding="utf-8")


def mux_final(video: Path, audio_dir: Path, subtitle: Path, output: Path):
    """混音、烧录字幕生成最终成片。"""
    audio_list = sorted(audio_dir.glob("*.wav"))
    if not audio_list:
        subprocess.run(["cp", str(video), str(output)], check=True)
        return

    # 按时间偏移合成所有台词:用 adelay + amix
    inputs = []
    filters = []
    for i, wav in enumerate(audio_list):
        inputs.extend(["-i", str(wav)])
    for i in range(len(audio_list)):
        idx = NARRATION[i]["start"] * 1000  # ms
        filters.append(f"[{i}:a]adelay={idx}|{idx}[a{i}]")
    mix_inputs = "".join(f"[a{i}]" for i in range(len(audio_list)))
    filters.append(f"{mix_inputs}amix=inputs={len(audio_list)}:duration=longest[mix]")
    filter_arg = ";".join(filters)
    tmp_audio = FINAL_DIR / "mixed_audio.wav"
    mix_cmd = ["ffmpeg", "-y"] + inputs + ["-filter_complex", filter_arg, "-map", "[mix]", "-ac", "2", "-ar", "22050", str(tmp_audio)]
    subprocess.run(mix_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # 最终混流 + 烧字幕
    cmd = [
        "ffmpeg", "-y", "-i", str(video), "-i", str(tmp_audio),
        "-vf", f"subtitles={subtitle}:force_style='FontName=Source Han Sans SC'",
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-ar", "22050",
        "-shortest", str(output),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)


def main():
    print("=" * 60)
    print("短剧 V1 生成开始")
    print("=" * 60)
    clips: list[Path] = []

    for shot in SHOTS:
        sid = shot["id"]
        seed = 42 + int(sid.replace("s", "").replace("_", ""))
        (SHOTS_DIR / sid).mkdir(parents=True, exist_ok=True)
        clip_path = SHOTS_DIR / sid / "clip.mp4"
        if clip_path.exists():
            print(f"\n[{sid}] act={shot['act']} dur={shot['duration']}s -> 已存在,跳过")
            clips.append(clip_path)
            continue

        print(f"\n[{sid}] act={shot['act']} dur={shot['duration']}s")
        raw = generate_video(shot, seed)
        clip = trim_clip(raw, shot)
        clips.append(clip)

    print("\n[concat] 拼接视频片段...")
    raw_video = FINAL_DIR / "video_raw.mp4"
    concat_clips(clips, raw_video)

    print("\n[TTS] 生成配音...")
    synthesize_all(NARRATION, AUDIO_DIR)

    print("\n[subtitle] 生成字幕...")
    subtitle = FINAL_DIR / "subtitle.ass"
    build_subtitle_ass(NARRATION, subtitle)

    print("\n[mux] 最终成片...")
    final = FINAL_DIR / "short_drama_v1.mp4"
    mux_final(raw_video, AUDIO_DIR, subtitle, final)

    print(f"\n✅ 成片: {final}")
    print(f"   大小: {final.stat().st_size / 1024 / 1024:.1f} MB")


if __name__ == "__main__":
    main()
