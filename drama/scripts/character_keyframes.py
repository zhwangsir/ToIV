"""短剧角色定妆关键帧生成。

为每个角色生成 3 张固定视角/姿态的定妆图(portrait_front / portrait_34 / action_pose),
并支持把角色外貌描述注入到镜头关键帧 prompt,为下游 i2v 首帧锁死提供一致参考。
"""
from __future__ import annotations

import asyncio
import logging
import re
import time
from pathlib import Path
from typing import Any

# 兼容脚本被直接调用时未安装 app 包的场景
try:
    from config import COMFY_ENDPOINT
except Exception:
    COMFY_ENDPOINT = "http://192.168.71.127:8189"

try:
    import requests
except Exception:  # pragma: no cover - 无 requests 时仅 API 调用失败,纯工具函数仍可用
    requests = None  # type: ignore[assignment]

logger = logging.getLogger(__name__)

# 默认核心 API 基址(可被环境变量覆盖)
CORE_API_BASE = "http://192.168.71.47:8090"
# 默认账号(开发环境;生产应使用服务账号或环境变量注入)
DEFAULT_EMAIL = "admin"
DEFAULT_PASSWORD = "admin123"

# 画风/质量尾缀(SFW,不触发 NSFW)
_QUALITY_SUFFIX = (
    "masterpiece, best quality, highly detailed, cinematic lighting, "
    "sharp focus, vivid colors, professional illustration"
)

# 姿态提示词模板
_POSE_TEMPLATES: dict[str, str] = {
    "portrait_front": "frontal portrait of {description}, looking directly at viewer, neutral expression, clean background",
    "portrait_34": "three-quarter view portrait of {description}, head turned 30 degrees to the side, gentle side lighting",
    "action_pose": "dynamic full-body action pose of {description}, heroic stance, energetic composition, dramatic angle",
}

_VALID_POSES = set(_POSE_TEMPLATES.keys())


def _api_base() -> str:
    import os

    return os.environ.get("TOIV_CORE_API_BASE", CORE_API_BASE).rstrip("/")


def _safe_name(name: str, description: str = "") -> str:
    """把角色名转成目录安全字符串(小写、非字母数字变下划线、连续下划线合并)。

    中文角色名优先转拼音(依赖 pypinyin);未安装 pypinyin 时用内置常见字映射兜底,
    无法识别的 CJK 字符会被忽略,若结果为空则回退到 "character"。
    同名角色通过 description 的短 hash 区分目录,避免不同角色覆盖同一目录。
    """
    import hashlib

    raw = name.strip()

    # 优先用 pypinyin(如果安装)
    try:
        from pypinyin import lazy_pinyin
        pinyin = "_".join(lazy_pinyin(raw))
        s = re.sub(r"[^a-z0-9]+", "_", pinyin.lower())
        base = s.strip("_") or "character"
    except Exception:
        # 内置常见字拼音映射(短剧常用角色名兜底)
        _PINYIN_MAP = {
            "林": "lin", "凡": "fan", "悟": "wu", "空": "kong",
            "旁": "pang", "白": "bai", "石": "shi", "昊": "hao",
            "小": "xiao", "塔": "ta", "贝": "bei", "吉": "ji",
            "卡": "ka", "罗": "luo", "特": "te",
        }
        translated = []
        for ch in raw:
            if ch.isascii() and ch.isalnum():
                translated.append(ch.lower())
            elif ch in _PINYIN_MAP:
                translated.append("_" + _PINYIN_MAP[ch] + "_")
        s = re.sub(r"_+", "_", "".join(translated)).strip("_")
        base = s or "character"

    # 同名区分：用描述前 20 字生成 6 位 hash 后缀
    if description:
        suffix = hashlib.md5(description.strip()[:20].encode("utf-8")).hexdigest()[:6]
        return f"{base}_{suffix}"
    return base


def _character_dir(character_name: str, output_dir: Path, description: str = "") -> Path:
    return output_dir / "characters" / _safe_name(character_name, description)


def _build_pose_prompt(description: str, pose: str) -> str:
    if pose not in _VALID_POSES:
        raise ValueError(f"未知姿态: {pose}; 可用: {list(_VALID_POSES)}")
    body = _POSE_TEMPLATES[pose].format(description=description.strip().rstrip(",. "))
    return f"{body}, {_QUALITY_SUFFIX}"


def _login(email: str | None = None, password: str | None = None) -> str:
    """调用 /api/auth/login 获取 JWT token。"""
    email = email or DEFAULT_EMAIL
    password = password or DEFAULT_PASSWORD
    url = f"{_api_base()}/api/auth/login"
    r = requests.post(url, json={"email": email, "password": password}, timeout=30)
    r.raise_for_status()
    data = r.json()
    token = data.get("token")
    if not token:
        raise RuntimeError(f"登录响应缺少 token: {data}")
    return token


def _auth_headers(token: str | None = None, email: str | None = None, password: str | None = None) -> dict[str, str]:
    if token is None:
        token = _login(email, password)
    return {"Authorization": f"Bearer {token}", "Content-Type": "application/json"}


def _wait_for_job(prompt_id: str, token: str, timeout: float = 300.0, poll_interval: float = 3.0) -> dict:
    """轮询 GET /api/jobs 直到指定 prompt_id 完成或超时。"""
    url = f"{_api_base()}/api/jobs"
    headers = {"Authorization": f"Bearer {token}"}
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        r = requests.get(url, headers=headers, params={"limit": 200}, timeout=30)
        r.raise_for_status()
        for job in r.json():
            if job.get("prompt_id") == prompt_id:
                status = job.get("status")
                if status == "done":
                    return job
                if status == "error":
                    raise RuntimeError(f"作业 {prompt_id} 执行出错")
        time.sleep(poll_interval)
    raise TimeoutError(f"等待作业 {prompt_id} 完成超时({timeout}s)")


def _download_image(image_url: str, dest: Path, token: str) -> Path:
    """下载 /api/images?... 产物到本地。"""
    dest.parent.mkdir(parents=True, exist_ok=True)
    if image_url.startswith("/api/"):
        image_url = f"{_api_base()}{image_url}"
    headers = {"Authorization": f"Bearer {token}"}
    r = requests.get(image_url, headers=headers, timeout=120)
    r.raise_for_status()
    dest.write_bytes(r.content)
    return dest


def _submit_txt2img(prompt: str, negative: str = "", width: int = 1024, height: int = 1344,
                    steps: int = 20, seed: int | None = None, ckpt_name: str | None = None,
                    token: str | None = None, email: str | None = None, password: str | None = None) -> dict:
    """调用 /api/generate/txt2img 提交文生图,返回含 prompt_id/worker/seed 的字典。"""
    if token is None:
        token = _login(email, password)
    payload: dict[str, Any] = {
        "positive": prompt,
        "negative": negative,
        "width": width,
        "height": height,
        "steps": steps,
        "batch_size": 1,
    }
    if seed is not None:
        payload["seed"] = seed
    if ckpt_name:
        payload["ckpt_name"] = ckpt_name
    r = requests.post(
        f"{_api_base()}/api/generate/txt2img",
        headers=_auth_headers(token),
        json=payload,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


async def generate_character_keyframes(
    character: dict,
    output_dir: Path,
    *,
    token: str | None = None,
    email: str | None = None,
    password: str | None = None,
    base_seed: int = 42,
    ckpt_name: str | None = None,
    width: int = 1024,
    height: int = 1344,
) -> dict:
    """为单个角色生成 3 张定妆图。

    Args:
        character: {"name": str, "description": str, ...}
        output_dir: 项目 output 目录(会写到 output_dir/characters/{safe_name}/)
        token: 已登录的 JWT;为空则自动登录
        email/password: 自动登录用的账号
        base_seed: 基础 seed,3 张图分别用 base_seed, base_seed+1, base_seed+2
        ckpt_name: 指定底模;默认 None 表示用 core 默认底模(FLUX)
        width/height: 出图分辨率

    Returns:
        {
            "character": character,
            "dir": Path,
            "keyframes": {"portrait_front": {"path": Path, "seed": int, "prompt": str}, ...},
        }
    """
    if token is None:
        token = _login(email, password)
    name = character.get("name", "unknown")
    description = character.get("description", "")
    if not description:
        raise ValueError(f"角色 {name} 缺少 description")

    char_dir = _character_dir(name, output_dir, description=description)
    char_dir.mkdir(parents=True, exist_ok=True)

    results: dict[str, dict[str, Any]] = {}
    for i, pose in enumerate(_VALID_POSES):
        prompt = _build_pose_prompt(description, pose)
        seed = base_seed + i
        try:
            handle = _submit_txt2img(
                prompt=prompt,
                negative="blurry, low quality, text, watermark, deformed, extra limbs, nsfw",
                width=width,
                height=height,
                steps=20,
                seed=seed,
                ckpt_name=ckpt_name,
                token=token,
            )
            job = _wait_for_job(handle["prompt_id"], token, timeout=300.0)
            urls = job.get("results", [])
            if not urls:
                raise RuntimeError(f"角色 {name} {pose} 生成无产物")
            dest = char_dir / f"{pose}.png"
            _download_image(urls[0], dest, token)
            results[pose] = {"path": dest, "seed": seed, "prompt": prompt, "job": job}
            logger.info("生成定妆图 %s/%s (seed=%s)", char_dir.name, pose, seed)
        except Exception as e:
            logger.error("生成定妆图 %s/%s 失败: %s", char_dir.name, pose, e)
            results[pose] = {"path": None, "seed": seed, "prompt": prompt, "error": str(e)}

    return {
        "character": character,
        "dir": char_dir,
        "keyframes": results,
    }


def get_character_keyframe(character_name: str, pose: str = "portrait_front", project_dir: Path | None = None, description: str = "") -> Path:
    """读取已生成的定妆图路径(project_dir/output/characters/...)。"""
    if project_dir is None:
        project_dir = Path(__file__).resolve().parent.parent
    if pose not in _VALID_POSES:
        raise ValueError(f"未知姿态: {pose}; 可用: {list(_VALID_POSES)}")
    path = _character_dir(character_name, project_dir / "output", description=description) / f"{pose}.png"
    if not path.exists():
        raise FileNotFoundError(f"定妆图不存在: {path}")
    return path


def get_character_keyframe_path(character_name: str, output_dir: Path, pose: str = "portrait_front", description: str = "") -> Path:
    """读取已生成的定妆图路径(output_dir/characters/...),供 generate_v2 使用。"""
    if pose not in _VALID_POSES:
        raise ValueError(f"未知姿态: {pose}; 可用: {list(_VALID_POSES)}")
    return _character_dir(character_name, output_dir, description=description) / f"{pose}.png"


def build_shot_keyframe_prompt(shot: dict, characters: list[dict]) -> str:
    """结合镜头场景描述 + 出场角色外貌描述,生成该镜头关键帧的英文 prompt。

    Args:
        shot: 分镜 dict,含 prompt, characters(角色名列表)
        characters: 完整角色列表,每个 dict 含 name + description

    Returns:
        英文 prompt 字符串
    """
    shot_prompt = (shot.get("prompt") or "").strip()
    char_names = {c.strip() for c in shot.get("characters", [])}
    char_descs: list[str] = []
    for c in characters:
        if c.get("name", "").strip() in char_names:
            desc = (c.get("description") or "").strip()
            if desc:
                char_descs.append(desc)

    parts = [shot_prompt]
    if char_descs:
        # 把角色外貌描述前置,强化主体一致性
        char_block = "; ".join(char_descs)
        parts.insert(0, f"featuring {char_block}")
    parts.append(_QUALITY_SUFFIX)
    return ", ".join(p for p in parts if p)


def _upload_image_to_core(image_path: Path, token: str, kind: str = "h3_i2v", worker: str | None = None) -> dict:
    """上传图片到 core /api/upload,返回 {"filename": str, "worker": str}。"""
    url = f"{_api_base()}/api/upload"
    headers = {"Authorization": f"Bearer {token}"}
    params: dict[str, str] = {"kind": kind}
    if worker:
        params["worker"] = worker
    with open(image_path, "rb") as f:
        files = {"image": (image_path.name, f, "image/png")}
        r = requests.post(url, headers=headers, params=params, files=files, timeout=60)
    r.raise_for_status()
    return r.json()


def _submit_h3_i2v(
    image_filename: str,
    worker: str,
    positive: str,
    *,
    negative: str = "",
    width: int = 1344,
    height: int = 768,
    length: int = 124,
    steps: int = 20,
    seed: int | None = None,
    token: str | None = None,
) -> dict:
    """调用 /api/h3/i2v 提交 H3 图生视频。"""
    if token is None:
        token = _login()
    payload: dict[str, Any] = {
        "image": image_filename,
        "worker": worker,
        "positive": positive,
        "negative": negative,
        "width": width,
        "height": height,
        "length": length,
        "steps": steps,
    }
    if seed is not None:
        payload["seed"] = seed
    r = requests.post(
        f"{_api_base()}/api/h3/i2v",
        headers=_auth_headers(token),
        json=payload,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def _submit_longcat_i2v(
    image_filename: str,
    worker: str,
    positive: str,
    *,
    negative: str = "",
    width: int = 832,
    height: int = 480,
    num_frames: int = 121,
    steps: int = 10,
    fps: int = 16,
    seed: int | None = None,
    token: str | None = None,
) -> dict:
    """调用 /api/longcat/i2v 提交 LongCat 图生视频。"""
    if token is None:
        token = _login()
    payload: dict[str, Any] = {
        "image": image_filename,
        "worker": worker,
        "positive": positive,
        "negative": negative,
        "width": width,
        "height": height,
        "num_frames": num_frames,
        "steps": steps,
        "fps": fps,
    }
    if seed is not None:
        payload["seed"] = seed
    r = requests.post(
        f"{_api_base()}/api/longcat/i2v",
        headers=_auth_headers(token),
        json=payload,
        timeout=60,
    )
    r.raise_for_status()
    return r.json()


def generate_longcat_i2v_from_keyframe(
    keyframe_path: Path,
    shot: dict,
    characters: list[dict],
    *,
    token: str | None = None,
    num_frames: int = 121,
    fps: int = 16,
    seed: int | None = None,
    worker: str | None = None,
) -> dict:
    """用定妆图作为首帧,调用 LongCat i2v 生成视频(同步阻塞等待完成)。

    Args:
        keyframe_path: 定妆图本地路径
        shot: 目标分镜 dict
        characters: 完整角色列表
        token: JWT
        num_frames: LongCat 帧数(默认 121 ≈ 7.6s @16fps)
        fps: 打包帧率
        seed: 采样 seed
        worker: 强制指定上传 worker;None 则由 core 自动选择

    Returns:
        {"longcat_handle": {...}, "job": {...}, "video_url": str, "video_path": Path}
    """
    if token is None:
        token = _login()

    positive = build_shot_keyframe_prompt(shot, characters)
    upload_info = _upload_image_to_core(keyframe_path, token, kind="longcat_i2v", worker=worker)
    filename = upload_info["filename"]
    upload_worker = upload_info["worker"]

    handle = _submit_longcat_i2v(
        image_filename=filename,
        worker=upload_worker,
        positive=positive,
        negative="blurry, low quality, text, watermark, deformed, extra limbs, nsfw",
        num_frames=num_frames,
        fps=fps,
        seed=seed,
        token=token,
    )
    job = _wait_for_job(handle["prompt_id"], token, timeout=1800.0)
    urls = job.get("results", [])
    if not urls:
        raise RuntimeError("LongCat i2v 无产物")
    video_url = urls[0]
    dest = keyframe_path.parent / f"longcat_i2v_{keyframe_path.stem}.mp4"
    _download_image(video_url, dest, token)
    return {
        "longcat_handle": handle,
        "job": job,
        "video_url": video_url,
        "video_path": dest,
        "prompt": positive,
    }


def generate_h3_i2v_from_keyframe(
    keyframe_path: Path,
    shot: dict,
    characters: list[dict],
    *,
    token: str | None = None,
    length: int = 124,
    seed: int | None = None,
    worker: str | None = None,
) -> dict:
    """用定妆图作为首帧,调用 H3 i2v 生成视频(同步阻塞等待完成)。

    Args:
        keyframe_path: 定妆图本地路径
        shot: 目标分镜 dict
        characters: 完整角色列表
        token: JWT
        length: H3 帧数(默认 124 ≈ 5.2s)
        seed: H3 采样 seed
        worker: 强制指定上传 worker;None 则由 core 自动选择

    Returns:
        {"h3_handle": {...}, "job": {...}, "video_url": str, "video_path": Path}
    """
    if token is None:
        token = _login()

    positive = build_shot_keyframe_prompt(shot, characters)
    upload_info = _upload_image_to_core(keyframe_path, token, kind="h3_i2v", worker=worker)
    filename = upload_info["filename"]
    upload_worker = upload_info["worker"]

    handle = _submit_h3_i2v(
        image_filename=filename,
        worker=upload_worker,
        positive=positive,
        negative="blurry, low quality, text, watermark, deformed, extra limbs, nsfw",
        length=length,
        seed=seed,
        token=token,
    )
    job = _wait_for_job(handle["prompt_id"], token, timeout=1800.0)
    urls = job.get("results", [])
    if not urls:
        raise RuntimeError("H3 i2v 无产物")
    video_url = urls[0]
    dest = keyframe_path.parent / f"i2v_{keyframe_path.stem}.mp4"
    _download_image(video_url, dest, token)
    return {
        "h3_handle": handle,
        "job": job,
        "video_url": video_url,
        "video_path": dest,
        "prompt": positive,
    }


if __name__ == "__main__":
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    # 简单 CLI: python character_keyframes.py <storyboard_json>
    import json
    import sys

    if len(sys.argv) < 2:
        print("Usage: python character_keyframes.py <storyboard_json> [output_dir]")
        sys.exit(1)

    storyboard_path = Path(sys.argv[1])
    out_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else storyboard_path.parent
    data = json.loads(storyboard_path.read_text(encoding="utf-8"))
    chars = [c for c in data.get("characters", []) if not c.get("is_narrator")]
    if not chars:
        print("没有可生成定妆图的角色")
        sys.exit(1)

    async def _main():
        token = _login()
        for char in chars:
            result = await generate_character_keyframes(char, out_dir, token=token)
            print(result["dir"], result["keyframes"].keys())

    asyncio.run(_main())
