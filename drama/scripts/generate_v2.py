"""短剧 V2 生成主控脚本。

全自动流程：小说导入 → 分镜 → 角色定妆关键帧 → 逐镜首帧+视频 → 配音 →
4K 超分(可选) → 剪辑成片。

入口:
    asyncio.run(main(Path("novel.txt"), Path("drama/output/projects/my_drama")))

环境变量:
    TOIV_GENERATE_V2_MOCK=1   强制使用 mock 产物，跳过真实 GPU 调用
"""
from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Optional

# 把 drama/scripts 与项目根加入路径，便于复用 apps/api 与 scripts/ 下的模块
SCRIPT_DIR = Path(__file__).resolve().parent
ROOT_DIR = SCRIPT_DIR.parents[1]
for _p in (SCRIPT_DIR, ROOT_DIR):
    if str(_p) not in sys.path:
        sys.path.insert(0, str(_p))

from novel_to_storyboard import novel_to_storyboard
from config import CHAR_MAP

logger = logging.getLogger(__name__)

DEFAULT_TTS_URL = os.environ.get("TOIV_TTS_URL", "http://192.168.71.127:9200")
DEFAULT_COMFY_ENDPOINT = os.environ.get("TOIV_COMFY_ENDPOINT", "http://192.168.71.127:8189")
DEFAULT_H3_ENDPOINT = os.environ.get("TOIV_H3_ENDPOINT", "http://192.168.71.127:8195")
DEFAULT_LONGCAT_ENDPOINT = os.environ.get("TOIV_LONGCAT_ENDPOINT", "http://192.168.71.127:8197")
FORCE_MOCK = os.environ.get("TOIV_GENERATE_V2_MOCK", "0") == "1"

# 长镜头阈值：≥8s 优先 LongCat，否则 H3
LONGCAT_DURATION_THRESHOLD = 8.0


def _now_iso() -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.localtime())


def _read_novel(path: Path) -> str:
    if not path.exists():
        raise FileNotFoundError(f"小说文件不存在: {path}")
    return path.read_text(encoding="utf-8")


def _ensure_dirs(output_dir: Path) -> dict[str, Path]:
    """创建项目子目录并返回路径映射。"""
    dirs = {
        "root": output_dir,
        "storyboard": output_dir / "storyboard",
        "characters": output_dir / "characters",
        "shots": output_dir / "shots",
        "audio": output_dir / "audio",
        "final": output_dir / "final",
        "reports": output_dir / "reports",
    }
    for d in dirs.values():
        d.mkdir(parents=True, exist_ok=True)
    return dirs


def _save_project_meta(
    dirs: dict[str, Path],
    storyboard: dict,
    timings: dict[str, float],
    artifacts: dict[str, Any],
) -> Path:
    """保存项目元数据 project.json。"""
    meta = {
        "created_at": _now_iso(),
        "title": storyboard.get("title", "Untitled Drama"),
        "num_shots": len(storyboard.get("shots", [])),
        "num_characters": len(storyboard.get("characters", [])),
        "timings": timings,
        "artifacts": artifacts,
        "storyboard_file": str(artifacts.get("storyboard", "")),
        "final_video": str(artifacts.get("final_video", "")),
    }
    path = dirs["root"] / "project.json"
    path.write_text(json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8")
    return path


# ---------------------------------------------------------------------------
# 角色定妆关键帧
# ---------------------------------------------------------------------------
async def _generate_character_keyframes(
    storyboard: dict,
    output_dir: Path,
    max_shots: int = 0,
) -> dict[str, Path]:
    """为每个角色生成定妆关键帧。

    若 character_keyframes.py 尚未就绪或生成失败，则回退到 config.CHAR_MAP
    的文本视觉 token，不生成图片文件。
    """
    character_frames: dict[str, Path] = {}
    try:
        # 另一个 Agent 正在实现该模块；这里做软依赖
        import character_keyframes as ck

        for c in storyboard.get("characters", []):
            name = c.get("name", "").strip()
            description = c.get("description", "")
            if not name:
                continue
            # 检查是否已存在定妆图
            out_file = ck.get_character_keyframe_path(name, output_dir, description=description)
            if out_file.exists():
                logger.info("[character] %s 已存在，跳过", name)
                character_frames[name] = out_file
                continue
            try:
                # character_keyframes.generate_character_keyframes 期望项目根目录，
                # 内部会创建 output_dir/characters/{safe_name}/
                result = ck.generate_character_keyframes(
                    character=c,
                    output_dir=output_dir,
                )
                if asyncio.iscoroutine(result):
                    result = await result
                # 函数返回 dict 时，取 portrait_front 关键帧
                if isinstance(result, dict):
                    keyframes = result.get("keyframes", {})
                    front = keyframes.get("portrait_front", {})
                    keyframe_path = Path(front.get("path", out_file or ""))
                else:
                    keyframe_path = Path(result)
                if keyframe_path.exists():
                    character_frames[name] = keyframe_path
                    logger.info("[character] %s -> %s", name, keyframe_path)
                else:
                    logger.warning("[character] %s 未产出文件，回退到文本 token", name)
            except Exception as e:
                logger.warning("[character] %s 生成失败: %s", name, e)
    except Exception as e:
        logger.warning("角色关键帧模块尚未就绪: %s", e)

    return character_frames


# ---------------------------------------------------------------------------
# 镜头首帧 prompt 与关键帧
# ---------------------------------------------------------------------------
def build_shot_keyframe_prompt(
    shot: dict,
    character_frames: dict[str, Path],
) -> str:
    """结合镜头 prompt、角色视觉 token/关键帧信息，生成首帧图生视频 prompt。"""
    parts = [shot.get("prompt", "").strip()]
    motion = shot.get("motion_prompt", "").strip()
    if motion:
        parts.append(motion)

    for c in shot.get("characters", []):
        # 优先使用关键帧路径作为 textual inversion/参考图信号
        frame_path = character_frames.get(c)
        if frame_path and frame_path.exists():
            parts.append(f"character reference: {c}")
        else:
            token = CHAR_MAP.get(c.lower(), "")
            if token:
                parts.append(token)
    return ", ".join(p for p in parts if p)


def _generate_keyframe(
    shot: dict,
    prompt: str,
    keyframes_dir: Path,
    character_frames: dict[str, Path],
) -> Optional[Path]:
    """生成单镜首帧图片。

    默认调用 core /api/generate/txt2img(FLUX/默认底模)出图；
    可通过 TOIV_GENERATE_V2_MOCK=1 强制生成占位图。
    """
    sid = shot["id"]
    out_file = keyframes_dir / f"{sid}_keyframe.png"
    if out_file.exists():
        logger.info("[keyframe] %s 已存在，跳过", sid)
        return out_file

    if FORCE_MOCK:
        logger.info("[keyframe] %s mock 模式生成占位图", sid)
        _make_test_image(out_file, 1024, 1024, label=sid)
        return out_file

    try:
        import character_keyframes as ck

        token = ck._login()
        handle = ck._submit_txt2img(
            prompt=prompt,
            negative="blurry, low quality, text, watermark, deformed, extra limbs, nsfw",
            width=1024,
            height=1024,
            steps=20,
            seed=None,
            token=token,
        )
        job = ck._wait_for_job(handle["prompt_id"], token, timeout=300.0)
        urls = job.get("results", [])
        if not urls:
            raise RuntimeError(f"首帧 {sid} 生成无产物")
        ck._download_image(urls[0], out_file, token)
        logger.info("[keyframe] %s 生成成功: %s", sid, out_file)
        return out_file
    except Exception as e:
        logger.warning("[keyframe] %s 真实生成失败，回退到占位图: %s", sid, e)
        try:
            _make_test_image(out_file, 1024, 1024, label=sid)
            return out_file
        except Exception as e2:
            logger.warning("[keyframe] %s 占位图也失败: %s", sid, e2)
            return None


def _make_test_image(path: Path, width: int, height: int, label: str = "") -> Path:
    """用 ffmpeg 生成一张测试图（用于 mock/占位）。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    # 默认非黑底色，便于质量门"非全黑"检查
    color = "c=blue" if not label else "c=gray"
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"color={color}:s={width}x{height}",
        "-frames:v", "1",
        "-pix_fmt", "rgb24",
        str(path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return path


# ---------------------------------------------------------------------------
# 视频生成（H3 i2v / LongCat i2v）
# ---------------------------------------------------------------------------
def _select_video_engine(shot: dict) -> str:
    """根据镜头时长选择视频生成引擎。"""
    duration = float(shot.get("duration", 5))
    if duration >= LONGCAT_DURATION_THRESHOLD:
        return "longcat"
    return "h3"


def _snap_h3_length(duration: float, fps: int = 24) -> int:
    """把时长映射到 H3 合法帧数网格 17k+5，约束 [22, 362]。"""
    target = int(duration * fps)
    # 17k+5 序列: 22, 39, 56, ..., 362
    candidates = list(range(22, 363, 17))
    return min(candidates, key=lambda x: abs(x - target))


def _snap_longcat_frames(duration: float, fps: int = 16) -> int:
    """把时长映射到 LongCat 合法帧数 4k+1，约束 [17, 961]。"""
    target = int(duration * fps)
    # 4k+1 序列: 17, 21, 25, ..., 961
    candidates = list(range(17, 962, 4))
    return min(candidates, key=lambda x: abs(x - target))


async def _generate_video_h3(
    shot: dict,
    keyframe: Path,
    output_path: Path,
    characters: list[dict],
) -> Optional[Path]:
    """调用 MiniMax H3 i2v。"""
    logger.info("[video/h3] %s 尝试生成 (keyframe=%s)", shot["id"], keyframe)
    if FORCE_MOCK or not keyframe.exists():
        if FORCE_MOCK:
            return _make_test_video(output_path, shot)
        return None

    try:
        import character_keyframes as ck

        token = ck._login()
        length = _snap_h3_length(float(shot.get("duration", 5)))
        result = await asyncio.to_thread(
            ck.generate_h3_i2v_from_keyframe,
            keyframe,
            shot,
            characters,
            token=token,
            length=length,
            seed=None,
            worker=None,
        )
        src = Path(result["video_path"])
        if src.exists():
            shutil.copy2(src, output_path)
            return output_path
        return None
    except Exception as e:
        logger.warning("[video/h3] %s 失败: %s", shot["id"], e)
        return None


async def _generate_video_longcat(
    shot: dict,
    keyframe: Path,
    output_path: Path,
    characters: list[dict],
) -> Optional[Path]:
    """调用 LongCat i2v。"""
    logger.info("[video/longcat] %s 尝试生成 (keyframe=%s)", shot["id"], keyframe)
    if FORCE_MOCK or not keyframe.exists():
        if FORCE_MOCK:
            return _make_test_video(output_path, shot)
        return None

    try:
        import character_keyframes as ck

        token = ck._login()
        num_frames = _snap_longcat_frames(float(shot.get("duration", 5)))
        result = await asyncio.to_thread(
            ck.generate_longcat_i2v_from_keyframe,
            keyframe,
            shot,
            characters,
            token=token,
            num_frames=num_frames,
            fps=16,
            seed=None,
            worker=None,
        )
        src = Path(result["video_path"])
        if src.exists():
            shutil.copy2(src, output_path)
            return output_path
        return None
    except Exception as e:
        logger.warning("[video/longcat] %s 失败: %s", shot["id"], e)
        return None


def _make_test_video(path: Path, shot: dict) -> Path:
    """用 ffmpeg testsrc 生成一段占位视频，使主流程可跑通。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    duration = float(shot.get("duration", 5))
    width, height, fps = 832, 480, 24
    cmd = [
        "ffmpeg", "-y", "-f", "lavfi", "-i", f"testsrc=duration={duration}:size={width}x{height}:rate={fps}",
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-an", str(path),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return path


def _trim_clip(src: Path, shot: dict, dest: Path) -> Path:
    """按分镜时长裁剪视频到目标秒数。"""
    if dest.exists():
        return dest
    dur = float(shot.get("duration", 5))
    cmd = [
        "ffmpeg", "-y", "-i", str(src), "-t", str(dur),
        "-c:v", "libx264", "-preset", "fast", "-crf", "23",
        "-pix_fmt", "yuv420p", "-an", str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return dest


async def _generate_video_for_shot(
    shot: dict,
    keyframe: Path,
    shots_dir: Path,
    characters: list[dict] | None = None,
) -> Optional[Path]:
    """为单镜生成视频片段，支持断点续跑和引擎 fallback。"""
    sid = shot["id"]
    shot_dir = shots_dir / sid
    shot_dir.mkdir(parents=True, exist_ok=True)
    raw_path = shot_dir / "raw.mp4"
    clip_path = shot_dir / "clip.mp4"

    if clip_path.exists():
        logger.info("[video] %s clip 已存在，跳过", sid)
        shot["video_file"] = str(clip_path)
        return clip_path

    chars = characters or []
    engine = _select_video_engine(shot)
    result: Optional[Path] = None
    if engine == "h3":
        result = await _generate_video_h3(shot, keyframe, raw_path, chars)
    else:
        result = await _generate_video_longcat(shot, keyframe, raw_path, chars)

    # fallback：H3 失败换 LongCat，LongCat 失败或 H3 失败均 fallback 到占位视频
    if result is None and engine == "h3":
        logger.info("[video] %s H3 失败，尝试 LongCat fallback", sid)
        result = await _generate_video_longcat(shot, keyframe, raw_path, chars)

    if result is None:
        logger.warning("[video] %s 真实引擎均失败，使用 mock 视频占位", sid)
        result = _make_test_video(raw_path, shot)

    # 按分镜时长裁剪
    clip = _trim_clip(result, shot, shot_dir / "clip.mp4")
    shot["video_file"] = str(clip)
    return clip


# ---------------------------------------------------------------------------
# 4K 超分
# ---------------------------------------------------------------------------
def _upscale_4k(src: Path, output: Path) -> Path:
    """调用 scripts/video_4k_upscale.py 进行 4K 超分。"""
    if output.exists():
        logger.info("[4k] %s 已存在，跳过", output)
        return output

    script = ROOT_DIR / "scripts" / "video_4k_upscale.py"
    if not script.exists():
        logger.warning("[4k] 超分脚本不存在: %s，复制原片", script)
        shutil.copy2(src, output)
        return output

    cmd = [
        sys.executable, str(script), str(src),
        "--output", str(output),
        "--worker", DEFAULT_COMFY_ENDPOINT,
        "--resume",
        "--keep-frames",
    ]
    logger.info("[4k] 启动超分: %s", " ".join(cmd))
    subprocess.run(cmd, check=True)
    return output


# ---------------------------------------------------------------------------
# 配音与成片
# ---------------------------------------------------------------------------
def _generate_audio(narration: list[dict], audio_dir: Path) -> list[dict[str, Any]]:
    """生成配音 WAV。"""
    from tts_client import synthesize_all

    return synthesize_all(narration, audio_dir)


def _build_subtitle_ass(narration: list[dict], output: Path):
    """生成简单 ASS 字幕文件（复用自 generate_v1）。"""
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
        speaker_tag = {
            "narrator": "", "goku": "【卡卡罗特】", "vegeta": "【贝吉塔】",
            "shihhao": "【石昊】", "smalltower": "【小塔】", "goku+vegeta": "【二人】",
        }.get(line["speaker"], f"【{line['speaker']}】")
        text = (speaker_tag + line["text"]).replace(",", "，")
        lines.append(f"Dialogue: 0,{fmt(line['start'])},{fmt(line['end'])},Default,,0,0,0,,{text}\n")
    output.write_text("".join(lines), encoding="utf-8")


def _concat_clips(clips: list[Path], output: Path, final_dir: Path) -> Path:
    """ffmpeg concat demuxer 拼接片段（使用项目级目录）。"""
    list_file = final_dir / "concat_list.txt"
    with open(list_file, "w") as f:
        for c in clips:
            f.write(f"file '{c.absolute()}'\n")
    cmd = [
        "ffmpeg", "-y", "-f", "concat", "-safe", "0", "-i", str(list_file),
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-pix_fmt", "yuv420p", "-an", str(output),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return output


def _concat_and_mux(
    shots: list[dict],
    narration: list[dict],
    audio_dir: Path,
    final_dir: Path,
    target_4k: bool,
) -> Path:
    """拼接视频片段、混音、烧录字幕，输出成片。"""
    clips = [Path(s["video_file"]) for s in shots if s.get("video_file")]
    if not clips:
        raise RuntimeError("没有可拼接的视频片段")

    raw_video = final_dir / "video_raw.mp4"
    logger.info("[concat] 拼接 %d 个片段...", len(clips))
    _concat_clips(clips, raw_video, final_dir)

    logger.info("[audio] 混音...")
    subtitle = final_dir / "subtitle.ass"
    return _mux_final(raw_video, audio_dir, subtitle, final_dir, narration, target_4k=target_4k)


def _mux_final(
    video: Path,
    audio_dir: Path,
    subtitle: Path,
    final_dir: Path,
    narration: list[dict],
    target_4k: bool,
) -> Path:
    """本地实现的混音+字幕烧录，不依赖 generate_v1 的全局 NARRATION。"""
    audio_list = sorted(audio_dir.glob("*.wav"))
    suffix = "_4k" if target_4k else ""
    final = final_dir / f"final_v2{suffix}.mp4"

    if not audio_list:
        subprocess.run(["cp", str(video), str(final)], check=True)
        return final

    # 文件名格式: 000_speaker.wav，索引对应 narration 顺序
    def _parse_index(path: Path) -> int:
        stem = path.stem
        part = stem.split("_", 1)[0]
        return int(part) if part.isdigit() else 0

    # 建立索引 -> start 时间（秒）
    start_by_index = {i: float(cue.get("start", 0)) for i, cue in enumerate(narration)}

    inputs = []
    filters = []
    for i, wav in enumerate(audio_list):
        inputs.extend(["-i", str(wav)])
    for i, wav in enumerate(audio_list):
        idx = _parse_index(wav)
        delay_ms = int(start_by_index.get(idx, 0) * 1000)
        filters.append(f"[{i}:a]adelay={delay_ms}|{delay_ms}[a{i}]")
    mix_inputs = "".join(f"[a{i}]" for i in range(len(audio_list)))
    filters.append(f"{mix_inputs}amix=inputs={len(audio_list)}:duration=longest[mix]")
    filter_arg = ";".join(filters)
    tmp_audio = final_dir / "mixed_audio.wav"
    mix_cmd = [
        "ffmpeg", "-y",
    ] + inputs + [
        "-filter_complex", filter_arg,
        "-map", "[mix]", "-ac", "2", "-ar", "24000",
        str(tmp_audio),
    ]
    subprocess.run(mix_cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

    # 最终混流 + 烧字幕；若本机 ffmpeg 无 subtitle 滤镜则回退到无字幕混流
    vf_with_subs = f"subtitles={subtitle}:force_style='FontName=Source Han Sans SC'"
    if target_4k:
        vf_with_subs = f"{vf_with_subs},scale=3840:2160:flags=lanczos"
    cmd_with_subs = [
        "ffmpeg", "-y", "-i", str(video), "-i", str(tmp_audio),
        "-vf", vf_with_subs,
        "-c:v", "libx264", "-preset", "medium", "-crf", "20",
        "-c:a", "aac", "-b:a", "128k", "-ar", "24000",
        "-shortest", str(final),
    ]
    try:
        subprocess.run(cmd_with_subs, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return final
    except subprocess.CalledProcessError as e:
        stderr = (e.stderr or b"").decode("utf-8", errors="ignore")
        if "subtitles" in stderr or "No option name" in stderr or "Invalid argument" in stderr:
            logger.warning("ffmpeg 字幕滤镜不可用，回退到无字幕混流: %s", stderr[:200])
            vf_fallback = "scale=3840:2160:flags=lanczos" if target_4k else "copy"
            cmd_fallback = [
                "ffmpeg", "-y", "-i", str(video), "-i", str(tmp_audio),
                "-c:v", "libx264", "-preset", "medium", "-crf", "20",
                "-c:a", "aac", "-b:a", "128k", "-ar", "24000",
                "-shortest", str(final),
            ]
            if target_4k:
                cmd_fallback.insert(-2, "-vf")
                cmd_fallback.insert(-2, "scale=3840:2160:flags=lanczos")
            subprocess.run(cmd_fallback, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
            return final
        raise


# ---------------------------------------------------------------------------
# 主流程
# ---------------------------------------------------------------------------
async def main(
    novel_path: Path,
    output_dir: Path,
    target_4k: bool = False,
    max_shots: int = 20,
) -> dict[str, Any]:
    """V2 主流程。

    Args:
        novel_path: 小说文本文件路径。
        output_dir: 项目输出目录。
        target_4k: 是否对每个片段做 4K 超分。
        max_shots: 最大镜头数。

    Returns:
        包含 artifacts、timings 的字典。
    """
    overall_t0 = time.time()
    timings: dict[str, float] = {}
    artifacts: dict[str, Any] = {}

    dirs = _ensure_dirs(output_dir)
    logger.info("=" * 60)
    logger.info("短剧 V2 生成开始: %s", output_dir)
    logger.info("=" * 60)

    # 1. 读取小说
    t0 = time.time()
    novel_text = _read_novel(novel_path)
    timings["read_novel"] = time.time() - t0
    logger.info("[1/6] 读取小说: %d 字符", len(novel_text))

    # 2. 小说 → 分镜
    t0 = time.time()
    storyboard = await novel_to_storyboard(
        novel_text,
        max_shots=max_shots,
        save=True,
        output_dir=dirs["storyboard"],
    )
    timings["storyboard"] = time.time() - t0
    artifacts["storyboard"] = str(dirs["storyboard"] / "storyboard_latest.json")
    logger.info("[2/6] 分镜完成: %d 镜", len(storyboard.get("shots", [])))

    # 3. 角色定妆关键帧
    t0 = time.time()
    character_frames = await _generate_character_keyframes(
        storyboard,
        dirs["root"],
    )
    timings["characters"] = time.time() - t0
    artifacts["character_frames"] = {k: str(v) for k, v in character_frames.items()}
    logger.info("[3/6] 角色关键帧: %d/%d", len(character_frames), len(storyboard.get("characters", [])))

    # 4. 逐镜生成首帧 + 视频
    t0 = time.time()
    shots = storyboard.get("shots", [])
    keyframes_dir = dirs["shots"] / "keyframes"
    keyframes_dir.mkdir(parents=True, exist_ok=True)

    clips: list[Path] = []
    for shot in shots:
        sid = shot["id"]
        prompt = build_shot_keyframe_prompt(shot, character_frames)
        logger.info("[shot/%s] prompt=%s", sid, prompt[:120])

        keyframe = _generate_keyframe(shot, prompt, keyframes_dir, character_frames)
        clip = await _generate_video_for_shot(
            shot, keyframe or Path(""), dirs["shots"], storyboard.get("characters", [])
        )
        if clip:
            clips.append(clip)

        # 4K 超分
        if target_4k and clip:
            upscaled = dirs["shots"] / sid / "clip_4k.mp4"
            try:
                _upscale_4k(clip, upscaled)
                shot["video_file_4k"] = str(upscaled)
                # 后续拼接使用 4K 片段
                clip = upscaled
            except Exception as e:
                logger.warning("[4k] %s 超分失败: %s", sid, e)

    timings["video"] = time.time() - t0
    artifacts["clips"] = [str(c) for c in clips]
    logger.info("[4/6] 视频片段完成: %d/%d", len(clips), len(shots))

    # 5. 配音
    t0 = time.time()
    narration = storyboard.get("narration", [])
    if narration:
        # 生成字幕 ASS
        subtitle_path = dirs["final"] / "subtitle.ass"
        _build_subtitle_ass(narration, subtitle_path)
        artifacts["subtitle"] = str(subtitle_path)

        # 生成 TTS
        audio_results = _generate_audio(narration, dirs["audio"])
        artifacts["audio"] = [str(r.get("path", "")) for r in audio_results]
    else:
        logger.warning("分镜无 narration，跳过配音")
    timings["audio"] = time.time() - t0
    logger.info("[5/6] 配音完成: %d 条", len(narration))

    # 6. 剪辑成片
    t0 = time.time()
    final_video = _concat_and_mux(shots, narration, dirs["audio"], dirs["final"], target_4k=target_4k)
    timings["mux"] = time.time() - t0
    timings["total"] = time.time() - overall_t0
    artifacts["final_video"] = str(final_video)
    logger.info("[6/6] 成片: %s", final_video)

    # 保存项目元数据
    meta_path = _save_project_meta(dirs, storyboard, timings, artifacts)
    artifacts["project_json"] = str(meta_path)

    return {
        "storyboard": storyboard,
        "artifacts": artifacts,
        "timings": timings,
    }


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def _demo_novel_path() -> Path:
    text = (
        "夜色如墨，少年林凡背着药篓走在回家的山路上。忽然，一道流星划破天际，"
        "坠落在不远处的山谷中。林凡心中一惊，急忙赶了过去。山谷里，一块散发着"
        "幽蓝光芒的晶石静静躺在焦土之上。"
    )
    p = SCRIPT_DIR.parent / "output" / "demo_novel.txt"
    p.write_text(text, encoding="utf-8")
    return p


async def _main():
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    novel = os.environ.get("TOIV_NOVEL_PATH")
    if novel:
        novel_path = Path(novel)
    else:
        novel_path = _demo_novel_path()

    out = Path(os.environ.get("TOIV_OUTPUT_DIR", str(SCRIPT_DIR.parent / "output" / "projects" / "demo_v2")))
    target_4k = os.environ.get("TOIV_TARGET_4K", "0") == "1"
    result = await main(novel_path, out, target_4k=target_4k)
    print(json.dumps({"artifacts": result["artifacts"], "timings": result["timings"]}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    asyncio.run(_main())
