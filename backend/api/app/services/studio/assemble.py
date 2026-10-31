"""合成服务:按分镜序拼接最终片段 → 项目成片。

各镜 final_clip_url **规格并不保证一致**(视频链/图像运镜链出 16fps mp4,对口型链出 25fps h264;
H3 侧音频采样率也未必是 48k)。因此拼接走 `concat_parts_uniform`:
先 ffprobe 逐片取规格,全一致 → concat demuxer 流拷贝(无损快路径);
有差异 → 逐片重编码归一到首片几何/帧率 + 平台统一音频规格后再拷贝拼接。

**为什么不能无条件流拷贝**:concat demuxer + `-c copy` 要求各输入编解码参数一致;不一致时输出
沿用首片流头参数,后续片段可能变速/静默/播放器 desync,而 `probe_duration` 仍返回完整时长
→ 所有时长断言照过、尾部哑音无人发现(2026-10-13 W0-3 登记的活雷)。

产物落 Studio 输出目录(drama_output_root()/studio,NAS 优先降级本地),
URL 经 /api/studio/files/{name} 访问;回写 project.final_url + status=ready。

合成前断言:每镜成片时长 ≈ 该镜视频原长(误差 <0.5s),防止对口型短配音截断成片;
以及每镜有音轨(对口型剥音未 mux 时拦截)。

F3:项目挂了 bgm_url 时,拼接后再混入声床(音量/对白闪避)。
"""
from __future__ import annotations

import logging
import uuid
from pathlib import Path

from sqlmodel import Session

from app.models import StudioProject, StudioShot
from app.services.studio.bgm_bed import (
    bgm_active,
    is_allowed_bgm_url,
    normalize_bgm_duck,
    normalize_bgm_url,
    normalize_bgm_volume,
    to_relative_bgm_url,
)
from app.services.studio.ffmpeg_ops import (
    FFmpegError,
    concat_parts_uniform,
    mix_bgm_under_video,
    probe_duration,
    probe_has_audio,
)
from app.storage import drama_output_root

logger = logging.getLogger(__name__)

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


def resolve_bgm_path(url: str) -> Path:
    """声床 URL → 本地文件。仅站内相对前缀;优先直接读盘避免自调鉴权。"""
    rel = to_relative_bgm_url(normalize_bgm_url(url))
    if not rel or not is_allowed_bgm_url(rel):
        raise AssembleError("声床 URL 不在站内白名单")
    name = Path(rel).name
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        # Path(rel).name 已去目录;再防空
        raise AssembleError("声床文件名无效")
    candidates: list[Path] = []
    root = drama_output_root()
    if rel.startswith(_FILES_PREFIX):
        candidates.append(root / "studio" / name)
    elif rel.startswith("/api/manju/output/") or rel.startswith("/api/manju/voice/"):
        candidates.append(root / "manju" / name)
        candidates.append(root / name)
    elif rel.startswith("/api/audio/files/"):
        candidates.append(root / "audio" / name)
        candidates.append(root / "studio" / name)
    elif rel.startswith("/api/images/"):
        candidates.append(root / "images" / name)
        candidates.append(root / "studio" / name)
    else:
        candidates.append(root / "studio" / name)
    for p in candidates:
        if p.is_file():
            return p
    raise AssembleError(f"声床文件缺失:{name}")


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


async def assert_clips_have_audio(shots: list[StudioShot]) -> None:
    """断言每镜 final_clip 含音轨;对口型剥音未 mux 时在合成前拦截。"""
    ordered = sorted(shots, key=lambda s: s.idx)
    missing = []
    for s in ordered:
        if not s.final_clip_url:
            continue
        clip_p = _clip_path(s.final_clip_url)
        try:
            has = await probe_has_audio(clip_p)
        except Exception as e:  # noqa: BLE001 — 探测异常视为无音
            raise AssembleError(f"镜{s.idx}音轨探测失败:{e}") from e
        if not has:
            missing.append(s.idx)
    if missing:
        raise AssembleError(
            f"分镜成片缺音轨(对口型未 mux 配音):{missing};请重跑 lipsync"
        )


async def assemble_project(
    session: Session,
    project: StudioProject,
    shots: list[StudioShot],
    *,
    bgm_url: str | None = None,
    bgm_volume: float | None = None,
    bgm_duck: bool | None = None,
) -> str:
    """拼接成片,回写 project.final_url/status,返回 URL。

    F3:可选覆盖声床参数;缺省读项目字段。
    """
    urls = collect_clips(shots)
    parts = [_clip_path(u) for u in urls]
    try:
        await assert_clip_durations_match_source(shots)
        await assert_clips_have_audio(shots)
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
        report = await concat_parts_uniform(parts, out)
    except FFmpegError as e:
        project.status = "error"
        project.error = str(e)
        session.add(project)
        session.commit()
        raise AssembleError(str(e)) from e
    if report.get("mode") == "transcode":
        # 不静默:混规格片段经过了重编码归一(流拷贝会让尾部变速/哑音而时长检查照样过)
        logger.warning(
            "assemble project=%s 片段规格不一致,已转码归一 %s/%s 片;差异字段=%s",
            project.id, report.get("normalized"), len(parts), report.get("diff"),
        )

    # F3 声床：拼接后再混（不改各镜源片）
    eff_url = normalize_bgm_url(
        bgm_url if bgm_url is not None else getattr(project, "bgm_url", "") or ""
    )
    if bgm_active(eff_url):
        if not is_allowed_bgm_url(eff_url):
            project.status = "error"
            project.error = "声床 URL 不在站内白名单"
            session.add(project)
            session.commit()
            raise AssembleError(project.error)
        vol = normalize_bgm_volume(
            bgm_volume if bgm_volume is not None else getattr(project, "bgm_volume", None)
        )
        duck = normalize_bgm_duck(
            bgm_duck if bgm_duck is not None else getattr(project, "bgm_duck", True)
        )
        try:
            bgm_path = resolve_bgm_path(eff_url)
            mixed = out_dir / f"final-bgm-{uuid.uuid4().hex}.mp4"
            await mix_bgm_under_video(out, bgm_path, mixed, volume=vol, duck=duck)
            try:
                out.unlink(missing_ok=True)
            except OSError:
                pass
            out = mixed
        except AssembleError:
            raise
        except FFmpegError as e:
            project.status = "error"
            project.error = f"声床混音失败:{e}"
            session.add(project)
            session.commit()
            raise AssembleError(project.error) from e

    project.final_url = f"{_FILES_PREFIX}{out.name}"
    project.status = "ready"
    project.error = ""
    session.add(project)
    session.commit()
    session.refresh(project)
    return project.final_url
