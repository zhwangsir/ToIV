"""合成服务:按分镜序拼接最终片段 → 项目成片。

各镜 final_clip_url 同规格(视频链/图像运镜链均出 16fps mp4,对口型链 25fps h264),
用 ffmpeg concat demuxer 无损拼接;规格不一的观众端兼容问题留给后续转码增强。

产物落 Studio 输出目录(drama_output_root()/studio,NAS 优先降级本地),
URL 经 /api/studio/files/{name} 访问;回写 project.final_url + status=ready。

合成前断言:每镜成片时长 ≈ 该镜视频原长(误差 <0.5s),防止对口型短配音截断成片。
"""
from __future__ import annotations

import uuid
from pathlib import Path

from sqlmodel import Session

from app.models import StudioProject, StudioShot
from app.services.studio.ffmpeg_ops import FFmpegError, concat_parts, probe_duration
from app.storage import drama_output_root

_FILES_PREFIX = "/api/studio/files/"
# 成片相对源视频允许的时长误差(秒)
_DURATION_TOLERANCE_SEC = 0.5


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


async def assert_clip_durations_match_source(shots: list[StudioShot]) -> None:
    """断言每镜 final_clip 时长 ≈ video_url 原长;误差 ≥0.5s 报错。"""
    ordered = sorted(shots, key=lambda s: s.idx)
    for s in ordered:
        if not s.final_clip_url:
            continue
        clip_p = _clip_path(s.final_clip_url)
        src_url = (s.video_url or "").strip()
        if not src_url:
            # 无源视频时退化为与 duration_sec 比对
            try:
                clip_dur = await probe_duration(clip_p)
            except FFmpegError as e:
                raise AssembleError(f"镜{s.idx}成片时长探测失败:{e}") from e
            expected = float(getattr(s, "duration_sec", 0) or 0)
            if expected > 0 and abs(clip_dur - expected) >= _DURATION_TOLERANCE_SEC:
                raise AssembleError(
                    f"镜{s.idx}成片时长异常:成片={clip_dur:.2f}s "
                    f"期望≈{expected:.2f}s(误差≥{_DURATION_TOLERANCE_SEC}s)"
                )
            continue
        if not src_url.startswith(_FILES_PREFIX):
            # 非本服务源跳过断言(无法取原片)
            continue
        try:
            src_p = _clip_path(src_url)
        except AssembleError:
            # 源文件缺失时仍用 duration_sec
            src_p = None
        try:
            clip_dur = await probe_duration(clip_p)
            if src_p is not None:
                src_dur = await probe_duration(src_p)
            else:
                src_dur = float(getattr(s, "duration_sec", 0) or 0)
                if src_dur <= 0:
                    continue
        except FFmpegError as e:
            raise AssembleError(f"镜{s.idx}时长探测失败:{e}") from e
        if abs(clip_dur - src_dur) >= _DURATION_TOLERANCE_SEC:
            raise AssembleError(
                f"镜{s.idx}成片被截断:成片={clip_dur:.2f}s "
                f"源视频={src_dur:.2f}s(误差≥{_DURATION_TOLERANCE_SEC}s,请重跑对口型)"
            )


async def assemble_project(
    session: Session, project: StudioProject, shots: list[StudioShot]
) -> str:
    """拼接成片,回写 project.final_url/status,返回 URL。"""
    urls = collect_clips(shots)
    parts = [_clip_path(u) for u in urls]
    try:
        await assert_clip_durations_match_source(shots)
    except AssembleError as e:
        project.status = "error"
        project.error = str(e)
        session.add(project)
        session.commit()
        raise
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
