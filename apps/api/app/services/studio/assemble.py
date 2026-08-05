"""合成服务:按分镜序拼接最终片段 → 项目成片。

各镜 final_clip_url 同规格(视频链/图像运镜链均出 16fps mp4,对口型链 25fps h264),
用 ffmpeg concat demuxer 无损拼接;规格不一的观众端兼容问题留给后续转码增强。

产物落 Studio 输出目录(drama_output_root()/studio,NAS 优先降级本地),
URL 经 /api/studio/files/{name} 访问;回写 project.final_url + status=ready。
"""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlmodel import Session

from app.models import StudioProject, StudioShot
from app.services.studio.ffmpeg_ops import FFmpegError, concat_parts
from app.storage import drama_output_root

_FILES_PREFIX = "/api/studio/files/"


class AssembleError(RuntimeError):
    pass


def collect_clips(shots: list[StudioShot]) -> list[str]:
    """按 idx 排序收集 final_clip_url;任一未就绪 → AssembleError。"""
    ordered = sorted(shots, key=lambda s: s.idx)
    if not ordered:
        raise AssembleError("项目无分镜")
    missing = [s.idx for s in ordered if not s.final_clip_url]
    if missing:
        raise AssembleError(f"分镜未就绪(缺成片):{missing}")
    return [s.final_clip_url for s in ordered]


def _clip_path(url: str) -> Path:
    """/api/studio/files/{name} → 本地路径;拒绝路径穿越与非本服务 URL。"""
    if not url.startswith(_FILES_PREFIX):
        raise AssembleError(f"片段非 Studio 产出:{url}")
    name = Path(url[len(_FILES_PREFIX):]).name
    path = drama_output_root() / "studio" / name
    if not path.is_file():
        raise AssembleError(f"片段文件缺失:{name}")
    return path


async def assemble_project(
    session: Session, project: StudioProject, shots: list[StudioShot]
) -> str:
    """拼接成片,回写 project.final_url/status,返回 URL。"""
    urls = collect_clips(shots)
    parts = [_clip_path(u) for u in urls]
    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    out = out_dir / f"final-{uuid.uuid4().hex}.mp4"
    try:
        await concat_parts(parts, out)
    except FFmpegError as e:
        project.status = "error"
        project.error = str(e)
        session.add(project)
        session.commit()
        raise AssembleError(str(e)) from e
    project.final_url = f"{_FILES_PREFIX}{out.name}"
    project.status = "ready"
    project.error = ""
    session.add(project)
    session.commit()
    session.refresh(project)
    return project.final_url
