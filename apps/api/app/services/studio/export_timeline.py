"""P2-9：创作台全量多轨导出 — 时间线投影 + 原创 CMX3600 EDL / FCPXML。

把 StudioShot 时间线投影为「视频 / 台词(voice) / 字幕 / BGM」分轨，再由同一份
投影生成：

- CMX3600 EDL（视频 V + 台词 A + BGM A2；字幕以 `* TOIV SUBTITLE` 注释随镜事件，
  CMX3600 本体无字幕轨，完整字幕轨在 FCPXML 与 cut_list.json）；
- FCPXML（spine 视频 + lane=1 台词音频 + lane=-1 BGM + lane=2 字幕 title）；
- 多轨 ZIP：EDL/FCPXML + manifest/切点清单 + 缺素材/时长超限清单。

**切点语义与 `jianying_draft.clips_from_studio_shots` 完全一致**（同一批 shots）：
- 视频：按 idx 升序、缺 final_clip_url（含 video_url 回退）的镜整体跳过且不占
  时间线；每镜时长 `sec_to_us(duration_sec)`（≤0 回退 6s）；target start 为顺序
  累计游标，end = start + duration；
- 台词(voice)：start 对齐本镜 shot_start，时长同本镜视频时长；
- 字幕：start/end 同本镜视频段，文本取 dialogue；
- BGM：start=0，时长覆盖全部视频段总长。

**硬纪律（AGENTS / DEEP_DELTA §3.5）：** 本模块为 ToIV 原创实现，只按公开的
CMX3600 / FCPXML 文本格式自行拼装，不拷贝 AGPL/GPL/NC 第三方（ArcReel、
pyJianYingDraft 等）源码；产物 best-effort，NLE 导入抽检以达芬奇/Premiere/FCP
实际打开为准。
"""
from __future__ import annotations

import json
import zipfile
import io
import math
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence
from xml.etree import ElementTree as ET

from app.services.studio.jianying_draft import US_PER_SEC, sec_to_us

EXPORT_FORMAT_VERSION = "toiv_multitrack_export_v1"
DEFAULT_FPS = 30
DEFAULT_WIDTH = 768
DEFAULT_HEIGHT = 1344
# 与 schemas.ShotDraft._clamp_duration 的 [1,60] 产品口径一致
SHOT_DURATION_MIN_SEC = 1.0
SHOT_DURATION_MAX_SEC = 60.0

TRACK_VIDEO = "video"
TRACK_DIALOGUE = "dialogue"  # 台词/配音音频轨
TRACK_SUBTITLE = "subtitle"  # 字幕文本轨
TRACK_BGM = "bgm"
TRACK_ORDER = (TRACK_VIDEO, TRACK_DIALOGUE, TRACK_SUBTITLE, TRACK_BGM)


class ExportTimelineError(RuntimeError):
    """导出失败（空时间线等）。"""


@dataclass(frozen=True)
class TrackClip:
    """时间线上一段（导出中间表示，可追溯 clip/shot 标识）。"""

    clip_id: str
    label: str
    track: str
    start_us: int
    duration_us: int
    shot_id: str = ""
    shot_idx: int | None = None
    media_url: str = ""
    text: str = ""  # 字幕/台词文本（subtitle 轨）

    @property
    def end_us(self) -> int:
        return self.start_us + self.duration_us


@dataclass(frozen=True)
class MultitrackTimeline:
    """一条多轨时间线（视频/台词/字幕/BGM）。"""

    title: str
    fps: int = DEFAULT_FPS
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    clips: tuple[TrackClip, ...] = ()

    def of(self, track: str) -> list[TrackClip]:
        return [c for c in self.clips if c.track == track]

    @property
    def total_duration_us(self) -> int:
        return max((c.end_us for c in self.clips), default=0)


@dataclass
class ExportChecklist:
    """导出前校验清单：缺素材 + 时长问题（含超限）。"""

    missing_assets: list[dict[str, Any]] = field(default_factory=list)
    duration_issues: list[dict[str, Any]] = field(default_factory=list)


# ── 时长校验 ────────────────────────────────────────────────────────────────


def check_duration(raw: Any, *, default_sec: float = 6.0) -> dict[str, Any] | None:
    """时长体检；非法回退 default_sec（与 sec_to_us 一致），超限仍用原值保持切点一致。

    返回 None=正常；否则 {kind: illegal_duration|duration_over_limit, ...}。
    """
    v: float
    try:
        if isinstance(raw, bool):
            raise TypeError("bool")
        v = float(raw) if raw is not None else float(default_sec)
    except (TypeError, ValueError):
        return {
            "kind": "illegal_duration",
            "reason": "non_numeric",
            "raw": repr(raw),
            "applied_sec": float(default_sec),
        }
    if not math.isfinite(v):
        return {
            "kind": "illegal_duration",
            "reason": "non_finite",
            "raw": repr(raw),
            "applied_sec": float(default_sec),
        }
    if v <= 0:
        return {
            "kind": "illegal_duration",
            "reason": "non_positive",
            "raw": v,
            "applied_sec": float(default_sec),
        }
    if v < SHOT_DURATION_MIN_SEC:
        return {
            "kind": "illegal_duration",
            "reason": "below_minimum",
            "raw": v,
            "applied_sec": v,
        }
    if v > SHOT_DURATION_MAX_SEC:
        return {
            "kind": "duration_over_limit",
            "reason": "above_maximum",
            "raw": v,
            "applied_sec": v,
            "limit_sec": SHOT_DURATION_MAX_SEC,
        }
    return None


# ── 时间线投影 ──────────────────────────────────────────────────────────────


def project_studio_shots(
    shots: Iterable[Any],
    *,
    resolve_path: Callable[[str], Path | None] | None = None,
    bgm_url: str = "",
    title: str = "toiv-multitrack",
    fps: int = DEFAULT_FPS,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
    default_duration_sec: float = 6.0,
) -> tuple[MultitrackTimeline, ExportChecklist]:
    """把 StudioShot 序列投影为多轨时间线 + 校验清单（切点同 clips_from_studio_shots）。"""
    ordered = sorted(list(shots), key=lambda s: int(getattr(s, "idx", 0) or 0))
    checklist = ExportChecklist()
    clips: list[TrackClip] = []
    video_cursor = 0

    for s in ordered:
        idx = int(getattr(s, "idx", 0) or 0)
        sid = str(getattr(s, "id", "") or "")
        label = f"shot_{idx:02d}"
        raw_dur = getattr(s, "duration_sec", None)
        issue = check_duration(raw_dur, default_sec=default_duration_sec)
        if issue is not None:
            checklist.duration_issues.append(
                {"shot_id": sid, "idx": idx, "label": label, **issue}
            )
        url = (
            getattr(s, "final_clip_url", None) or getattr(s, "video_url", None) or ""
        ).strip()
        if not url:
            checklist.missing_assets.append(
                {
                    "kind": "missing_final_clip",
                    "shot_id": sid,
                    "idx": idx,
                    "label": label,
                    "media_url": "",
                    "detail": "缺 final_clip_url，未进时间线",
                }
            )
            continue
        dur_us = sec_to_us(raw_dur, fallback_sec=default_duration_sec)
        if resolve_path is not None and resolve_path(url) is None:
            checklist.missing_assets.append(
                {
                    "kind": "missing_media_file",
                    "shot_id": sid,
                    "idx": idx,
                    "label": label,
                    "media_url": url,
                    "detail": "视频素材不可读/未落盘",
                }
            )
        shot_start = video_cursor
        clips.append(
            TrackClip(
                clip_id=sid or label,
                label=label,
                track=TRACK_VIDEO,
                start_us=shot_start,
                duration_us=dur_us,
                shot_id=sid,
                shot_idx=idx,
                media_url=url,
            )
        )
        voice = (getattr(s, "voice_url", None) or "").strip()
        if voice:
            if resolve_path is not None and resolve_path(voice) is None:
                checklist.missing_assets.append(
                    {
                        "kind": "missing_media_file",
                        "shot_id": sid,
                        "idx": idx,
                        "label": f"{label}_voice",
                        "media_url": voice,
                        "detail": "配音素材不可读/未落盘",
                    }
                )
            clips.append(
                TrackClip(
                    clip_id=f"{sid or label}_voice",
                    label=f"{label}_voice",
                    track=TRACK_DIALOGUE,
                    start_us=shot_start,
                    duration_us=dur_us,
                    shot_id=sid,
                    shot_idx=idx,
                    media_url=voice,
                )
            )
        dialogue = (getattr(s, "dialogue", None) or "").strip()
        if dialogue:
            clips.append(
                TrackClip(
                    clip_id=f"{sid or label}_sub",
                    label=f"{label}_sub",
                    track=TRACK_SUBTITLE,
                    start_us=shot_start,
                    duration_us=dur_us,
                    shot_id=sid,
                    shot_idx=idx,
                    text=dialogue,
                )
            )
        video_cursor += dur_us

    bgm_url = (bgm_url or "").strip()
    if bgm_url:
        if resolve_path is not None and resolve_path(bgm_url) is None:
            checklist.missing_assets.append(
                {
                    "kind": "missing_media_file",
                    "shot_id": "",
                    "idx": None,
                    "label": "bgm",
                    "media_url": bgm_url,
                    "detail": "BGM 素材不可读/未落盘",
                }
            )
        clips.append(
            TrackClip(
                clip_id="bgm",
                label="bgm",
                track=TRACK_BGM,
                start_us=0,
                duration_us=video_cursor,
                media_url=bgm_url,
            )
        )

    timeline = MultitrackTimeline(
        title=title or "toiv-multitrack",
        fps=int(fps) if int(fps) > 0 else DEFAULT_FPS,
        width=int(width) if int(width) > 0 else DEFAULT_WIDTH,
        height=int(height) if int(height) > 0 else DEFAULT_HEIGHT,
        clips=tuple(clips),
    )
    return timeline, checklist


# ── 时间码 ──────────────────────────────────────────────────────────────────


def us_to_timecode(us: int, fps: int = DEFAULT_FPS) -> str:
    """微秒 → CMX3600 时间码 HH:MM:SS:FF（四舍五入到帧）。"""
    if fps <= 0:
        raise ValueError("fps 必须为正")
    total_frames = int(us * fps / US_PER_SEC + 0.5)
    ss, ff = divmod(total_frames, fps)
    mm, ss = divmod(ss, 60)
    hh, mm = divmod(mm, 60)
    return f"{hh:02d}:{mm:02d}:{ss:02d}:{ff:02d}"


def us_to_fcpxml_time(us: int) -> str:
    """微秒 → FCPXML 有理秒时间值（如 3/2s）。"""
    us = int(us)
    if us == 0:
        return "0s"
    a, b = abs(us), US_PER_SEC
    while b:
        a, b = b, a % b
    g = a or 1
    sign = "-" if us < 0 else ""
    num, den = us // g, US_PER_SEC // g
    if den == 1:
        return f"{sign}{num}s"
    return f"{sign}{num}/{den}s"


# ── CMX3600 EDL ─────────────────────────────────────────────────────────────

_EDL_TRACK_CODE = {TRACK_VIDEO: "V", TRACK_DIALOGUE: "A", TRACK_BGM: "A2"}


def _edl_event(
    *,
    number: int,
    clip: TrackClip,
    fps: int,
    reel: str,
    track_code: str,
) -> list[str]:
    src_in = us_to_timecode(0, fps)
    src_out = us_to_timecode(clip.duration_us, fps)
    rec_in = us_to_timecode(clip.start_us, fps)
    rec_out = us_to_timecode(clip.end_us, fps)
    lines = [
        f"{number:03d}  {reel:<8} {track_code:<2} C        "
        f"{src_in} {src_out} {rec_in} {rec_out}",
        f"* FROM CLIP NAME: {clip.label}",
        f"* TOIV CLIP ID: {clip.clip_id}",
    ]
    if clip.shot_id:
        lines.append(f"* TOIV SHOT ID: {clip.shot_id}")
    if clip.shot_idx is not None:
        lines.append(f"* TOIV SHOT IDX: {clip.shot_idx}")
    lines.append(f"* TOIV TRACK: {clip.track}")
    if clip.media_url:
        lines.append(f"* TOIV MEDIA URL: {clip.media_url}")
    return lines


def build_edl(timeline: MultitrackTimeline, *, title: str | None = None) -> str:
    """生成原创 CMX3600 EDL 文本（多轨：V/A/A2 + 字幕注释）。"""
    if not timeline.clips:
        raise ExportTimelineError("时间线无片段，无法导出 EDL")
    fps = timeline.fps
    name = (title or timeline.title or "toiv-multitrack").replace("\n", " ").strip()
    out: list[str] = [f"TITLE: {name}", "FCM: NON-DROP FRAME", ""]

    subs_by_shot = {
        c.shot_id: c for c in timeline.of(TRACK_SUBTITLE) if c.shot_id
    }
    number = 0
    for track in (TRACK_VIDEO, TRACK_DIALOGUE, TRACK_BGM):
        track_clips = sorted(timeline.of(track), key=lambda c: (c.start_us, c.clip_id))
        if not track_clips:
            continue
        out.append(f"* TOIV TRACK SECTION: {track}")
        out.append("")
        for clip in track_clips:
            number += 1
            reel = f"TOIV{number:04d}"
            out.extend(
                _edl_event(
                    number=number,
                    clip=clip,
                    fps=fps,
                    reel=reel,
                    track_code=_EDL_TRACK_CODE[track],
                )
            )
            if track == TRACK_VIDEO:
                sub = subs_by_shot.get(clip.shot_id)
                if sub is not None and sub.text:
                    out.append(f"* TOIV SUBTITLE: {sub.text}")
            out.append("")
    return "\n".join(out).rstrip() + "\n"


# ── FCPXML ──────────────────────────────────────────────────────────────────


def build_fcpxml(timeline: MultitrackTimeline, *, title: str | None = None) -> str:
    """生成原创 FCPXML（spine 视频 + lane=1 台词 + lane=-1 BGM + lane=2 字幕）。"""
    if not timeline.clips:
        raise ExportTimelineError("时间线无片段，无法导出 FCPXML")
    fps = timeline.fps
    name = (title or timeline.title or "toiv-multitrack").replace("\n", " ").strip()

    root = ET.Element("fcpxml", {"version": "1.8"})
    resources = ET.SubElement(root, "resources")
    fmt = ET.SubElement(
        resources,
        "format",
        {
            "id": "r1",
            "name": f"toiv-{timeline.width}x{timeline.height}-{fps}",
            "frameDuration": f"1/{fps}s",
            "width": str(timeline.width),
            "height": str(timeline.height),
        },
    )
    _ = fmt
    # 字幕 title 效果位（best-effort 资源声明；NLE 导入时可重链到本机标题模板）
    ET.SubElement(
        resources,
        "effect",
        {
            "id": "rE",
            "name": "Basic Title",
            "src": "build-in title effect placeholder",
        },
    )

    asset_id_by_clip: dict[str, str] = {}
    res_n = 2  # r1=format, rE=effect
    for clip in timeline.clips:
        if clip.track == TRACK_SUBTITLE:
            continue
        rid = f"r{res_n}"
        res_n += 1
        asset_id_by_clip[clip.clip_id] = rid
        attrs = {
            "id": rid,
            "name": clip.label,
            "start": "0s",
            "duration": us_to_fcpxml_time(clip.duration_us),
        }
        if clip.track == TRACK_VIDEO:
            attrs["hasVideo"] = "1"
            attrs["hasAudio"] = "1"
        else:
            attrs["hasAudio"] = "1"
        attrs["format"] = "r1"
        asset = ET.SubElement(resources, "asset", attrs)
        src = clip.media_url or f"missing/{clip.label}"
        ET.SubElement(
            asset,
            "media-rep",
            {"kind": "original-media", "src": src},
        )

    event = ET.SubElement(root, "event", {"name": "toiv-export"})
    project = ET.SubElement(event, "project", {"name": name})
    seq = ET.SubElement(
        project,
        "sequence",
        {
            "format": "r1",
            "duration": us_to_fcpxml_time(timeline.total_duration_us),
            "tcStart": "0s",
            "tcFormat": "NDF",
        },
    )
    spine = ET.SubElement(seq, "spine")

    def _attach(parent: ET.Element, clip: TrackClip) -> None:
        parent.append(ET.Comment(f" toiv clip_id={clip.clip_id} shot_id={clip.shot_id} "))

    for clip in sorted(timeline.of(TRACK_VIDEO), key=lambda c: (c.start_us, c.clip_id)):
        _attach(spine, clip)
        ET.SubElement(
            spine,
            "asset-clip",
            {
                "ref": asset_id_by_clip[clip.clip_id],
                "name": clip.label,
                "offset": us_to_fcpxml_time(clip.start_us),
                "start": "0s",
                "duration": us_to_fcpxml_time(clip.duration_us),
            },
        )
    for clip in sorted(timeline.of(TRACK_DIALOGUE), key=lambda c: (c.start_us, c.clip_id)):
        _attach(spine, clip)
        ET.SubElement(
            spine,
            "audio",
            {
                "ref": asset_id_by_clip[clip.clip_id],
                "name": clip.label,
                "lane": "1",
                "offset": us_to_fcpxml_time(clip.start_us),
                "start": "0s",
                "duration": us_to_fcpxml_time(clip.duration_us),
            },
        )
    for clip in sorted(timeline.of(TRACK_BGM), key=lambda c: (c.start_us, c.clip_id)):
        _attach(spine, clip)
        ET.SubElement(
            spine,
            "audio",
            {
                "ref": asset_id_by_clip[clip.clip_id],
                "name": clip.label,
                "lane": "-1",
                "offset": us_to_fcpxml_time(clip.start_us),
                "start": "0s",
                "duration": us_to_fcpxml_time(clip.duration_us),
            },
        )
    for i, clip in enumerate(
        sorted(timeline.of(TRACK_SUBTITLE), key=lambda c: (c.start_us, c.clip_id)), start=1
    ):
        _attach(spine, clip)
        title_el = ET.SubElement(
            spine,
            "title",
            {
                "ref": "rE",
                "name": clip.label,
                "lane": "2",
                "offset": us_to_fcpxml_time(clip.start_us),
                "duration": us_to_fcpxml_time(clip.duration_us),
            },
        )
        text_el = ET.SubElement(title_el, "text")
        ts_id = f"ts{i}"
        ET.SubElement(text_el, "text-style", {"ref": ts_id}).text = clip.text
        tsd = ET.SubElement(title_el, "text-style-def", {"id": ts_id})
        ET.SubElement(tsd, "text-style", {"fontSize": "64"})

    body = ET.tostring(root, encoding="unicode")
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        "<!DOCTYPE fcpxml>\n" + body + "\n"
    )


# ── manifest / 切点清单 / ZIP ───────────────────────────────────────────────


def cut_list(timeline: MultitrackTimeline) -> list[dict[str, Any]]:
    """切点清单：每轨每段的可追溯切点（us 口径，与剪映 target_timerange 一致）。"""
    order = {t: i for i, t in enumerate(TRACK_ORDER)}
    rows: list[dict[str, Any]] = []
    for c in sorted(
        timeline.clips, key=lambda c: (order.get(c.track, 99), c.start_us, c.clip_id)
    ):
        rows.append(
            {
                "clip_id": c.clip_id,
                "shot_id": c.shot_id,
                "shot_idx": c.shot_idx,
                "label": c.label,
                "track": c.track,
                "start_us": c.start_us,
                "end_us": c.end_us,
                "duration_us": c.duration_us,
                "media_url": c.media_url,
                "text": c.text,
            }
        )
    return rows


def build_manifest(
    timeline: MultitrackTimeline,
    checklist: ExportChecklist,
    *,
    format_version: str = EXPORT_FORMAT_VERSION,
) -> dict[str, Any]:
    counts = {t: len(timeline.of(t)) for t in TRACK_ORDER}
    return {
        "format": format_version,
        "title": timeline.title,
        "fps": timeline.fps,
        "width": timeline.width,
        "height": timeline.height,
        "total_duration_us": timeline.total_duration_us,
        "tracks": counts,
        "clip_count": len(timeline.clips),
        "missing_assets_count": len(checklist.missing_assets),
        "duration_issues_count": len(checklist.duration_issues),
        "license_note": (
            "Original ToIV implementation; CMX3600/FCPXML composed from public "
            "format docs — no AGPL/GPL third-party sources copied."
        ),
    }


def build_multitrack_zip(
    timeline: MultitrackTimeline,
    checklist: ExportChecklist,
) -> bytes:
    """打包多轨导出 ZIP（EDL + FCPXML + manifest/切点清单 + 缺素材/时长清单）。"""
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        zf.writestr("timeline.edl", build_edl(timeline))
        zf.writestr("timeline.fcpxml", build_fcpxml(timeline))
        zf.writestr(
            "toiv_manifest.json",
            json.dumps(build_manifest(timeline, checklist), ensure_ascii=False, indent=2),
        )
        zf.writestr(
            "cut_list.json",
            json.dumps(
                {"format": EXPORT_FORMAT_VERSION, "cuts": cut_list(timeline)},
                ensure_ascii=False,
                indent=2,
            ),
        )
        zf.writestr(
            "missing_assets.json",
            json.dumps(
                {"format": EXPORT_FORMAT_VERSION, "missing_assets": checklist.missing_assets},
                ensure_ascii=False,
                indent=2,
            ),
        )
        zf.writestr(
            "duration_issues.json",
            json.dumps(
                {"format": EXPORT_FORMAT_VERSION, "duration_issues": checklist.duration_issues},
                ensure_ascii=False,
                indent=2,
            ),
        )
    return buf.getvalue()


def require_video_clips(timeline: MultitrackTimeline) -> Sequence[TrackClip]:
    """空可导时间线 → ExportTimelineError（路由层转 422）。"""
    videos = timeline.of(TRACK_VIDEO)
    if not videos:
        raise ExportTimelineError("无可用成片片段（缺 final_clip_url）")
    return videos
