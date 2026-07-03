"""生成内容存储根 —— 统一走 config.content_dir(默认 /data;可设 NAS 挂载点集中存储)。

各路由的产物目录(dub/manju/forge/cad)用 content_subdir(name) 取,
从而一处切换就能把生成内容整体落到 NAS(cifs 卷挂 /data/nas/toiv)。
"""
from __future__ import annotations

import tempfile
from pathlib import Path

from app.config import get_settings


def content_subdir(name: str) -> Path:
    """返回 content_dir/<name>(尽力创建);根不可写(本地开发无 /data)则退到临时目录。"""
    base = Path(get_settings().content_dir)
    try:
        target = base / name
        target.mkdir(parents=True, exist_ok=True)
        return target
    except OSError:
        return Path(tempfile.gettempdir()) / f"toiv-{name}"
