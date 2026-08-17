"""真机验证:为 storyboard_latest.json 第一个非旁白角色生成定妆图并用首帧跑 H3 i2v。

运行:
    /tmp/toiv-val-venv/bin/python validate_character_keyframes.py

输出:
    - 3 张定妆图路径
    - H3 i2v 视频路径
    - 首帧 vs 视频第 1 秒一致性结论(基于 VLM 或人工观察)
"""
from __future__ import annotations

import asyncio
import json
import logging
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

from character_keyframes import (
    _safe_name,
    build_shot_keyframe_prompt,
    generate_character_keyframes,
    get_character_keyframe,
)
from config import load_storyboard

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)

PROJECT_DIR = Path(__file__).resolve().parent.parent
OUTPUT_DIR = PROJECT_DIR / "output"


def _extract_frame_1s(video_path: Path, dest: Path) -> Path:
    """用 ffmpeg 提取视频第 1 秒帧。"""
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg, "-y", "-i", str(video_path),
        "-ss", "00:00:01.000", "-vframes", "1",
        str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return dest


def _generate_h3_i2v_direct(
    keyframe_path: Path,
    positive: str,
    h3_base: str = "http://192.168.71.127:8195",
    length: int = 124,
    seed: int = 20260809,
) -> dict:
    """直接提交到 H3 ComfyUI 实例,绕过 core 的 VRAM 预检(用于 core 503 回退)。"""
    import copy
    import json
    import time
    import uuid

    import requests

    template_path = Path(__file__).resolve().parent.parent.parent / "apps" / "api" / "app" / "workflows" / "h3" / "i2v_prompt.json"
    graph = copy.deepcopy(json.loads(template_path.read_text(encoding="utf-8"))["prompt"])

    # 上传首帧到 H3 实例
    upload_url = f"{h3_base}/upload/image"
    with open(keyframe_path, "rb") as f:
        r = requests.post(upload_url, files={"image": (keyframe_path.name, f, "image/png")}, timeout=60)
    r.raise_for_status()
    image_name = r.json().get("name") or keyframe_path.name

    # 注入参数
    graph["104"]["inputs"]["prompt"] = positive
    graph["104"]["inputs"]["length"] = length
    graph["100"]["inputs"]["image"] = image_name
    graph["15"]["inputs"]["noise_seed"] = seed

    # 提交
    prompt_id = str(uuid.uuid4())
    r = requests.post(
        f"{h3_base}/prompt",
        json={"prompt": graph, "client_id": prompt_id},
        timeout=60,
    )
    r.raise_for_status()
    prompt_id = r.json()["prompt_id"]

    # 轮询
    deadline = time.monotonic() + 1800.0
    while time.monotonic() < deadline:
        r = requests.get(f"{h3_base}/history/{prompt_id}", timeout=60)
        r.raise_for_status()
        history = r.json()
        if prompt_id in history:
            entry = history[prompt_id]
            outputs = entry.get("outputs", {})
            files = []
            for node_out in outputs.values():
                for key in ("gifs", "videos", "images"):
                    for item in node_out.get(key, []):
                        files.append({
                            "filename": item["filename"],
                            "subfolder": item.get("subfolder", ""),
                            "type": item.get("type", "output"),
                        })
            if files:
                f = files[0]
                filename = f["filename"]
                subfolder = f["subfolder"]
                dest = keyframe_path.parent / f"i2v_{keyframe_path.stem}.mp4"
                params = {"filename": filename, "subfolder": subfolder, "type": f["type"]}
                r = requests.get(f"{h3_base}/view?{requests.compat.urlencode(params)}", timeout=120)
                r.raise_for_status()
                dest.write_bytes(r.content)
                return {
                    "h3_handle": {"prompt_id": prompt_id, "worker": h3_base},
                    "video_path": dest,
                    "video_url": f"/api/images?filename={filename}&subfolder={subfolder}&worker={h3_base}&type={f['type']}",
                    "prompt": positive,
                }
            status = (entry.get("status") or {}).get("status_str")
            if status == "error":
                raise RuntimeError(f"H3 direct i2v error: {entry.get('status')}")
        time.sleep(3.0)
    raise TimeoutError("H3 direct i2v timeout")


def _create_side_by_side(left: Path, right: Path, dest: Path) -> Path:
    """用 ffmpeg 把两张图水平拼接,供 mlx-vlm 单图对比。"""
    ffmpeg = shutil.which("ffmpeg") or "ffmpeg"
    cmd = [
        ffmpeg, "-y",
        "-i", str(left), "-i", str(right),
        "-filter_complex", "[0:v]scale=1344:768[ref]; [1:v]scale=1344:768[frame]; [ref][frame]hstack=inputs=2",
        str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return dest


def _ask_vlm_consistency(first_frame: Path, video_frame_1s: Path) -> str:
    """调用 studio04 mlx-vlm 自定义 /v1/reverse 对比两张图角色一致性。"""
    import base64
    import requests

    url = "http://192.168.71.113:9303/v1/reverse"

    def _b64(p: Path) -> str:
        return base64.b64encode(p.read_bytes()).decode("utf-8")

    combined = first_frame.parent / "consistency_side_by_side.png"
    _create_side_by_side(first_frame, video_frame_1s, combined)

    prompt = (
        "This image shows two panels side-by-side. LEFT panel is the reference keyframe. "
        "RIGHT panel is a frame at 1 second from a video generated using the left panel as the first frame. "
        "Does the character remain consistent in face, hair, and clothing between left and right? "
        "Answer exactly: 'Consistent: yes/no. Reason: one sentence.'"
    )
    payload = {
        "prompt": prompt,
        "image_url": f"data:image/png;base64,{_b64(combined)}",
        "max_tokens": 256,
        "temperature": 0.2,
    }
    try:
        r = requests.post(url, json=payload, timeout=120)
        r.raise_for_status()
        return r.json().get("prompt", "")
    except Exception as e:
        return f"VLM 对比失败: {e}"


async def main():
    data = load_storyboard()
    if not data:
        logger.error("无法加载 storyboard_latest.json")
        sys.exit(1)

    characters = [c for c in data.get("characters", []) if not c.get("is_narrator")]
    if not characters:
        logger.error("没有可生成定妆图的角色")
        sys.exit(1)

    character = characters[0]
    logger.info("选择角色: %s", character["name"])

    # 1. 生成 3 张定妆图(若已存在则跳过复用)
    char_dir = OUTPUT_DIR / "characters" / _safe_name(character["name"])
    poses = ["portrait_front", "portrait_34", "action_pose"]
    existing = {pose: char_dir / f"{pose}.png" for pose in poses}
    if all(p.exists() for p in existing.values()):
        logger.info("定妆图已存在,直接复用: %s", char_dir)
        keyframe_result = {
            "character": character,
            "dir": char_dir,
            "keyframes": {
                pose: {"path": path, "seed": 42 + i, "prompt": ""}
                for i, (pose, path) in enumerate(existing.items())
            },
        }
    else:
        logger.info("生成 3 张定妆图...")
        keyframe_result = await generate_character_keyframes(character, OUTPUT_DIR)
        for pose, info in keyframe_result["keyframes"].items():
            if info.get("path"):
                logger.info("  %s -> %s (seed=%s)", pose, info["path"], info["seed"])
            else:
                logger.error("  %s 生成失败: %s", pose, info.get("error"))
        failed = [pose for pose, info in keyframe_result["keyframes"].items() if not info.get("path")]
        if failed:
            logger.error("定妆图生成失败: %s", failed)
            sys.exit(1)

    # 2. 选一个带该角色的镜头做 i2v 验证
    target_shot = None
    for shot in data.get("shots", []):
        if character["name"] in shot.get("characters", []):
            target_shot = shot
            break
    if not target_shot:
        logger.error("未找到包含 %s 的镜头", character["name"])
        sys.exit(1)
    logger.info("选择镜头 %s: %s", target_shot["id"], target_shot.get("description") or target_shot["prompt"])

    # 3. 用 portrait_front 作为首帧生成 H3 i2v(124 帧 ≈ 5.2s)
    front_path = get_character_keyframe(character["name"], "portrait_front", PROJECT_DIR)
    positive = build_shot_keyframe_prompt(target_shot, data["characters"])
    logger.info("提交 H3 i2v, 首帧: %s", front_path)
    i2v_result = None
    try:
        from character_keyframes import generate_h3_i2v_from_keyframe
        i2v_result = generate_h3_i2v_from_keyframe(
            front_path,
            target_shot,
            data["characters"],
            length=124,
            seed=20260809,
        )
        logger.info("H3 i2v(core API)完成: %s", i2v_result["video_path"])
    except Exception as e:
        logger.warning("H3 i2v 经 core API 失败(%s),回退到直连 H3 实例", e)
        try:
            i2v_result = _generate_h3_i2v_direct(front_path, positive, length=124, seed=20260809)
            logger.info("H3 i2v(直连)完成: %s", i2v_result["video_path"])
        except Exception as e2:
            logger.error("H3 i2v 直连也失败: %s", e2)
            sys.exit(1)
    logger.info("视频 URL: %s", i2v_result["video_url"])

    # 4. 提取视频第 1 秒帧
    video_path = i2v_result["video_path"]
    frame_1s_path = video_path.parent / f"{video_path.stem}_frame_1s.png"
    try:
        _extract_frame_1s(video_path, frame_1s_path)
        logger.info("提取视频第 1 秒帧: %s", frame_1s_path)
    except Exception as e:
        logger.error("ffmpeg 提取帧失败: %s", e)
        frame_1s_path = None

    # 5. VLM 一致性判断
    if frame_1s_path:
        conclusion = _ask_vlm_consistency(front_path, frame_1s_path)
        logger.info("一致性结论: %s", conclusion)

    # 6. 写验证报告
    report = {
        "character": character,
        "keyframes": {
            pose: {"path": str(info["path"]), "seed": info["seed"], "prompt": info["prompt"]}
            for pose, info in keyframe_result["keyframes"].items()
        },
        "shot": target_shot,
        "i2v": {
            "video_path": str(video_path),
            "video_url": i2v_result["video_url"],
            "prompt": i2v_result["prompt"],
            "seed": i2v_result["job"].get("seed"),
        },
        "frame_1s_path": str(frame_1s_path) if frame_1s_path else None,
        "consistency_conclusion": conclusion if frame_1s_path else None,
    }
    report_path = keyframe_result["dir"] / "validation_report.json"
    report_path.write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    logger.info("验证报告已保存: %s", report_path)


if __name__ == "__main__":
    asyncio.run(main())
