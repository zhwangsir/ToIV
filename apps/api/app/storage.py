"""生成内容存储根 —— 统一走 config.content_dir(默认 /data;可设 NAS 挂载点集中存储)。

各路由的产物目录(dub/manju/forge/cad)用 content_subdir(name) 取,
从而一处切换就能把生成内容整体落到 NAS(cifs 卷挂 /data/nas/toiv)。

短剧成片目录(drama_output_root)单独走 TOIV_DRAMA_VIDEO_DIR:
运行时解析 + 60s 缓存,NAS 恢复后无需重启自动回切,不可达立即降级本地。

音频产物目录(audio_output_root)走 TOIV_AUDIO_DIR(AGENTS.md 第六节 outputs/audio),
同一套运行时解析 + 60s 缓存降级模式。
"""
from __future__ import annotations

import logging
import os
import tempfile
import time
from pathlib import Path

from app.config import get_settings

logger = logging.getLogger(__name__)


def content_subdir(name: str) -> Path:
    """返回 content_dir/<name>(尽力创建);根不可写(本地开发无 /data)则退到临时目录。"""
    base = Path(get_settings().content_dir)
    try:
        target = base / name
        target.mkdir(parents=True, exist_ok=True)
        return target
    except OSError:
        return Path(tempfile.gettempdir()) / f"toiv-{name}"


# 短剧成片根目录解析缓存:每次调用走 drama_output_root(),TTL 内复用上轮结果。
# 模块 import 时一次性解析的写法在 NAS 恢复后不会回切(必须重启),故改为运行时解析。
_DRAMA_ROOT_TTL = 60.0
_drama_root_cache: tuple[float, Path] | None = None


def _resolve_drama_root() -> Path:
    """解析短剧成片根目录。

    优先级:
    1. TOIV_DRAMA_VIDEO_DIR 环境变量(生产环境指向 NAS 挂载点)
    2. 本地候选路径(开发/Docker 回退)

    若环境变量指向的 NAS 路径不可访问,自动降级到本地路径并记录警告。
    """
    if env_dir := os.environ.get("TOIV_DRAMA_VIDEO_DIR"):
        env_path = Path(env_dir)
        try:
            if env_path.is_dir():
                return env_path
        except OSError as exc:
            logger.warning(
                "TOIV_DRAMA_VIDEO_DIR NAS 路径不可访问,降级到本地路径: %s (%s)",
                env_dir,
                exc,
            )
        else:
            logger.warning(
                "TOIV_DRAMA_VIDEO_DIR 目录不存在,降级到本地路径: %s", env_dir
            )

    # 候选路径相对 app 包目录定位:本地开发时 apps/api 位于仓库 apps/ 下;
    # Docker 中 /app 即 apps/api 内容
    app_dir = Path(__file__).resolve().parent  # apps/api/app
    candidates = [
        app_dir.parent.parent.parent / "drama" / "output" / "final",  # 仓库根(本地)
        app_dir.parent / "drama" / "output" / "final",  # apps/api(Docker /app)
        Path("/app/drama/output/final"),
    ]
    for p in candidates:
        if p.is_dir():
            return p
    return candidates[0]


def drama_output_root() -> Path:
    """短剧成片根目录(每次调用解析,60s 缓存;NAS 恢复后自动回切,失败立即降本地)。"""
    global _drama_root_cache
    now = time.monotonic()
    if _drama_root_cache is not None and now - _drama_root_cache[0] < _DRAMA_ROOT_TTL:
        return _drama_root_cache[1]
    root = _resolve_drama_root()
    _drama_root_cache = (now, root)
    return root


# 音频产物根目录解析缓存:与短剧成片同一套运行时解析 + 60s 缓存模式。
_AUDIO_ROOT_TTL = 60.0
_audio_root_cache: tuple[float, Path] | None = None


def _resolve_audio_root() -> Path:
    """解析音频产物根目录(人声分离等独立音频工具产物)。

    优先级:
    1. TOIV_AUDIO_DIR 配置(生产 core 指向 NAS 挂载点 /mnt/toiv-nas/toiv/outputs/audio)
    2. 本地候选路径(开发/Docker 回退)

    若配置指向的 NAS 路径不可访问(OSError: 掉线/超时/权限),自动降级到本地路径
    并记录警告;调用方写入时再遇 OSError 应降级 content_subdir("audio") 兜底。
    """
    env_dir = get_settings().audio_dir.strip()
    if env_dir:
        env_path = Path(env_dir)
        try:
            if env_path.is_dir():
                return env_path
        except OSError as exc:
            logger.warning(
                "TOIV_AUDIO_DIR NAS 路径不可访问,降级到本地路径: %s (%s)",
                env_dir,
                exc,
            )
        else:
            logger.warning(
                "TOIV_AUDIO_DIR 目录不存在,降级到本地路径: %s", env_dir
            )

    # 候选路径相对 app 包目录定位:本地开发时 apps/api 位于仓库 apps/ 下;
    # Docker 中 /app 即 apps/api 内容。目录可不存在(调用方写入前 mkdir)。
    app_dir = Path(__file__).resolve().parent  # apps/api/app
    candidates = [
        app_dir.parent / "outputs" / "audio",  # apps/api/outputs/audio(本地/Docker /app)
        Path("/app/outputs/audio"),
    ]
    for p in candidates:
        try:
            if p.is_dir():
                return p
        except OSError:
            continue
    return candidates[0]


def audio_output_root() -> Path:
    """音频产物根目录(每次调用解析,60s 缓存;NAS 恢复后自动回切,失败立即降本地)。"""
    global _audio_root_cache
    now = time.monotonic()
    if _audio_root_cache is not None and now - _audio_root_cache[0] < _AUDIO_ROOT_TTL:
        return _audio_root_cache[1]
    root = _resolve_audio_root()
    _audio_root_cache = (now, root)
    return root
