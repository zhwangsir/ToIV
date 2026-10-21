"""F4：剪映（Jianying / CapCut CN）草稿包 — ToIV 原创导出。

只依据公开/社区文档化的目录与 JSON 形状（draft_content / draft_info /
draft_meta_info；tracks/segments/materials；时间单位微秒；app_source=lv）自行拼装。

**硬纪律（DEEP_DELTA §3.5 / COMPETITIVE）：**
- 不拷贝 AGPL/GPL/NC 源码（ArcReel、pyJianYingDraft、Koma 等）进仓；
- 本模块为 ToIV 自写 best-effort `toiv_jianying_draft_v1`；
- 新版剪映可能加密/升级草稿；用户打开后若提示损坏，按 IMPORT.md 降级到
  明文可打开的专业版线，或在剪映内手动重链素材。

产物：一个可下载的 ZIP，解压后得到 `<draft_id>/` 文件夹，可放入本机
`JianyingPro/User Data/Projects/com.lveditor.draft/`（或同级 CapCut 目录）。
"""
from __future__ import annotations

import json
import logging
import shutil
import time
import uuid
import zipfile
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable, Sequence

logger = logging.getLogger(__name__)

DRAFT_FORMAT_VERSION = "toiv_jianying_draft_v1"
# 目标明文线：社区普遍报告 5.9.x 为可读写明文；仅作声明，不保证各客户端必开。
TARGET_APP_SOURCE = "lv"
TARGET_APP_VERSION = "5.9.0"
DEFAULT_FPS = 30
DEFAULT_WIDTH = 1080
DEFAULT_HEIGHT = 1920
DEFAULT_RATIO = "9:16"
US_PER_SEC = 1_000_000


class JianyingDraftError(RuntimeError):
    """导出失败（无可用片段 / 打包错误等）。"""


@dataclass(frozen=True)
class TimelineClip:
    """时间线一镜/一轨素材（导出输入）。"""

    clip_id: str
    label: str
    duration_us: int
    kind: str = "video"  # video | audio
    media_url: str = ""
    local_path: Path | None = None
    width: int = DEFAULT_WIDTH
    height: int = DEFAULT_HEIGHT
    dialogue: str = ""
    # 音频可选：钉在时间线绝对起点；None 则按同 kind 顺序拼接（视频始终顺序）
    timeline_start_us: int | None = None


@dataclass
class DraftBuildResult:
    draft_id: str
    draft_dir: Path
    zip_path: Path | None
    duration_us: int
    video_segments: int
    audio_segments: int
    media_copied: int
    media_missing: list[str] = field(default_factory=list)
    format_version: str = DRAFT_FORMAT_VERSION


def new_id() -> str:
    return str(uuid.uuid4()).upper()


def sec_to_us(sec: float | int | None, *, fallback_sec: float = 6.0) -> int:
    try:
        v = float(sec) if sec is not None else fallback_sec
    except (TypeError, ValueError):
        v = fallback_sec
    if v <= 0:
        v = fallback_sec
    return int(round(v * US_PER_SEC))


def sanitize_draft_filename(title: str, *, draft_id: str) -> str:
    base = (title or "toiv-draft").strip() or "toiv-draft"
    out = []
    for ch in base:
        if ch.isalnum() or ch in "-_." or ("\u4e00" <= ch <= "\u9fff"):
            out.append(ch)
        elif ch.isspace():
            out.append("_")
    name = "".join(out).strip("._")[:48] or "toiv-draft"
    short = draft_id.replace("-", "")[:8]
    return f"{name}_{short}"


def _empty_materials() -> dict[str, list[Any]]:
    # 保留常见键，值为空数组 —— 避免部分客户端对缺键过敏。
    return {
        "videos": [],
        "audios": [],
        "texts": [],
        "stickers": [],
        "video_effects": [],
        "material_animations": [],
        "transitions": [],
        "masks": [],
        "common_masks": [],
        "canvases": [],
        "speeds": [],
        "audio_fades": [],
        "placeholder_infos": [],
        "vocal_separations": [],
        "sound_channel_mappings": [],
        "smart_crops": [],
        "manual_deformations": [],
    }


def _video_material(
    *,
    mat_id: str,
    path: str,
    duration_us: int,
    width: int,
    height: int,
    material_name: str,
) -> dict[str, Any]:
    return {
        "id": mat_id,
        "type": "video",
        "path": path,
        "material_name": material_name,
        "duration": duration_us,
        "width": width,
        "height": height,
        "category_name": "local",
        "category_id": "",
        "check_flag": 63487,
        "crop": {
            "upper_left_x": 0.0,
            "upper_left_y": 0.0,
            "upper_right_x": 1.0,
            "upper_right_y": 0.0,
            "lower_left_x": 0.0,
            "lower_left_y": 1.0,
            "lower_right_x": 1.0,
            "lower_right_y": 1.0,
        },
        "crop_ratio": "free",
        "crop_scale": 1.0,
        "has_audio": True,
        "media_path": path,
    }


def _audio_material(
    *,
    mat_id: str,
    path: str,
    duration_us: int,
    material_name: str,
) -> dict[str, Any]:
    return {
        "id": mat_id,
        "type": "extract_music",
        "path": path,
        "material_name": material_name,
        "duration": duration_us,
        "category_name": "local",
        "category_id": "",
        "music_id": "",
        "tone_type": "",
        "wave_points": [],
    }


def _segment(
    *,
    seg_id: str,
    material_id: str,
    start_us: int,
    duration_us: int,
    render_index: int,
    volume: float = 1.0,
    for_audio: bool = False,
) -> dict[str, Any]:
    seg: dict[str, Any] = {
        "id": seg_id,
        "material_id": material_id,
        "target_timerange": {"start": start_us, "duration": duration_us},
        "source_timerange": {"start": 0, "duration": duration_us},
        "speed": 1.0,
        "volume": volume,
        "visible": True,
        "render_index": render_index,
        "render_uniform_index": -1,
        "extra_material_refs": [],
    }
    if for_audio:
        seg["clip"] = None
    else:
        seg["clip"] = {
            "alpha": 1.0,
            "flip": {"horizontal": False, "vertical": False},
            "rotation": 0.0,
            "scale": {"x": 1.0, "y": 1.0},
            "transform": {"x": 0.0, "y": 0.0},
        }
    return seg


def build_draft_document(
    *,
    draft_id: str,
    name: str,
    clips: Sequence[TimelineClip],
    canvas_width: int = DEFAULT_WIDTH,
    canvas_height: int = DEFAULT_HEIGHT,
    ratio: str = DEFAULT_RATIO,
    fps: int = DEFAULT_FPS,
    material_paths: dict[str, str] | None = None,
) -> dict[str, Any]:
    """由时间线片段拼装 draft_content / draft_info 主体（纯函数，不碰盘）。"""
    if not clips:
        raise JianyingDraftError("无可用时间线片段，无法导出剪映草稿")

    paths = material_paths or {}
    materials = _empty_materials()
    video_segments: list[dict[str, Any]] = []
    audio_segments: list[dict[str, Any]] = []
    cursor = 0
    v_idx = 0
    a_idx = 0

    audio_cursor = 0
    for clip in clips:
        dur = int(clip.duration_us)
        if dur <= 0:
            continue
        mat_id = new_id()
        seg_id = new_id()
        rel = paths.get(clip.clip_id) or f"assets/{clip.kind}/{clip.clip_id}"
        if clip.kind == "audio":
            materials["audios"].append(
                _audio_material(
                    mat_id=mat_id,
                    path=rel,
                    duration_us=dur,
                    material_name=clip.label or clip.clip_id,
                )
            )
            if clip.timeline_start_us is not None:
                start = max(0, int(clip.timeline_start_us))
            else:
                start = audio_cursor
                audio_cursor = start + dur
            audio_segments.append(
                _segment(
                    seg_id=seg_id,
                    material_id=mat_id,
                    start_us=start,
                    duration_us=dur,
                    render_index=a_idx,
                    for_audio=True,
                )
            )
            a_idx += 1
        else:
            materials["videos"].append(
                _video_material(
                    mat_id=mat_id,
                    path=rel,
                    duration_us=dur,
                    width=clip.width,
                    height=clip.height,
                    material_name=clip.label or clip.clip_id,
                )
            )
            video_segments.append(
                _segment(
                    seg_id=seg_id,
                    material_id=mat_id,
                    start_us=cursor,
                    duration_us=dur,
                    render_index=v_idx,
                )
            )
            cursor += dur
            v_idx += 1

    if not video_segments and not audio_segments:
        raise JianyingDraftError("片段时长均为 0，无法导出")

    duration_us = 0
    for seg in video_segments:
        end = int(seg["target_timerange"]["start"]) + int(seg["target_timerange"]["duration"])
        duration_us = max(duration_us, end)
    for seg in audio_segments:
        end = int(seg["target_timerange"]["start"]) + int(seg["target_timerange"]["duration"])
        duration_us = max(duration_us, end)

    tracks: list[dict[str, Any]] = []
    if video_segments:
        tracks.append(
            {
                "id": new_id(),
                "type": "video",
                "name": "video",
                "attribute": 0,
                "flag": 0,
                "segments": video_segments,
            }
        )
    if audio_segments:
        tracks.append(
            {
                "id": new_id(),
                "type": "audio",
                "name": "audio",
                "attribute": 0,
                "flag": 0,
                "segments": audio_segments,
            }
        )

    now_ms = int(time.time() * 1000)
    doc: dict[str, Any] = {
        "id": draft_id,
        "name": name,
        "duration": duration_us,
        "fps": fps,
        "canvas_config": {
            "width": canvas_width,
            "height": canvas_height,
            "ratio": ratio,
        },
        "platform": {
            "app_id": 3704,
            "app_source": TARGET_APP_SOURCE,
            "app_version": TARGET_APP_VERSION,
            "os": "mac",
            "os_version": "",
            "os_name": "Mac",
        },
        "last_modified_platform": {
            "app_source": TARGET_APP_SOURCE,
            "app_version": TARGET_APP_VERSION,
            "os": "mac",
        },
        "tracks": tracks,
        "materials": materials,
        "extra_info": {
            "toiv_format": DRAFT_FORMAT_VERSION,
            "toiv_exported_at_ms": now_ms,
            "toiv_note": "Original ToIV exporter; learn protocol only — not ArcReel/pyJianYingDraft code.",
        },
        "free_render_index_mode_on": False,
        "new_version": "75.0.0",
        "version": 360000,
    }
    return doc


def build_meta_info(*, draft_id: str, name: str, duration_us: int, draft_fold_path: str = "") -> dict[str, Any]:
    now = int(time.time() * 1_000_000)
    return {
        "draft_id": draft_id,
        "draft_name": name,
        "draft_fold_path": draft_fold_path,
        "draft_root_path": draft_fold_path,
        "tm_duration": duration_us,
        "tm_draft_create": now,
        "tm_draft_modified": now,
        "tm_draft_cloud_entrance": now,
        "draft_is_ai_shorts": False,
        "draft_is_invisible": False,
        "draft_removable_storage_device": "",
        "draft_timeline_materials_size_": 0,
        "draft_cover": "",
        "draft_materials": [],
        "draft_materials_copied_info": [],
        "draft_segment_extra_info": [],
        "toiv_format": DRAFT_FORMAT_VERSION,
    }


def import_readme(*, name: str, format_version: str, media_missing: Sequence[str]) -> str:
    missing_block = ""
    if media_missing:
        lines = "\n".join(f"- {m}" for m in media_missing)
        missing_block = f"\n## 未打包进 ZIP 的素材（需在剪映内重链）\n\n{lines}\n"
    return f"""# ToIV → 剪映草稿（{format_version}）

项目名：{name}

## 如何导入

1. 解压本 ZIP，得到以草稿 UUID 命名的文件夹（内含 `draft_content.json` / `draft_info.json` / `draft_meta_info.json` 与 `assets/`）。
2. 将整个文件夹复制到本机剪映草稿目录，例如：
   - macOS 剪映专业版：`~/Movies/JianyingPro/User Data/Projects/com.lveditor.draft/`
   - Windows 剪映：`%LOCALAPPDATA%\\JianyingPro\\User Data\\Projects\\com.lveditor.draft\\`
   - CapCut（国际）：对应 `CapCut/User Data/Projects/com.lveditor.draft/`
3. 重启剪映 / CapCut，在草稿列表中打开该项目。
4. 若提示素材丢失：在剪映内对红字片段「重新链接」到本文件夹 `assets/video` / `assets/audio`。

## 兼容说明

- 本包为目标 **明文** 草稿（声明 `platform.app_source=lv` / `app_version={TARGET_APP_VERSION}`）。
- 剪映 6.0+ 可能在打开后加密改写；若打不开，请换用仍接受明文草稿的版本，或仅作时间线参考后在剪映内重建。
- ToIV **不拷贝** AGPL/GPL 第三方草稿库代码；结构为 best-effort，非官方 SDK。
{missing_block}
## 文件

- `draft_content.json` / `draft_info.json`：同一时间线正文（双写提高打开率）
- `draft_meta_info.json`：草稿元数据
- `toiv_manifest.json`：ToIV 侧清单（镜头 URL、格式版本）
- `assets/`：已复制的成片 / 配音 / 声床（若源文件当时可读）
"""


def _copy_media(
    clip: TimelineClip,
    assets_root: Path,
) -> tuple[str, bool]:
    """复制素材到 assets/{kind}/；返回 (相对路径, 是否复制成功)。"""
    kind_dir = "audio" if clip.kind == "audio" else "video"
    dest_dir = assets_root / kind_dir
    dest_dir.mkdir(parents=True, exist_ok=True)
    src = clip.local_path
    if src is not None and src.is_file():
        suffix = src.suffix.lower() or (".mp3" if clip.kind == "audio" else ".mp4")
        dest_name = f"{clip.clip_id}{suffix}"
        dest = dest_dir / dest_name
        shutil.copy2(src, dest)
        return f"assets/{kind_dir}/{dest_name}", True
    # 无本地文件：仍写占位相对路径，便于结构与重链
    suffix = ".mp3" if clip.kind == "audio" else ".mp4"
    dest_name = f"{clip.clip_id}{suffix}"
    return f"assets/{kind_dir}/{dest_name}", False


def write_draft_folder(
    out_parent: Path,
    *,
    name: str,
    clips: Sequence[TimelineClip],
    draft_id: str | None = None,
    canvas_width: int = DEFAULT_WIDTH,
    canvas_height: int = DEFAULT_HEIGHT,
    include_media: bool = True,
) -> DraftBuildResult:
    """写出草稿文件夹（含 JSON + 可选素材）。"""
    did = (draft_id or new_id()).upper()
    draft_dir = out_parent / did
    if draft_dir.exists():
        shutil.rmtree(draft_dir)
    draft_dir.mkdir(parents=True, exist_ok=True)
    assets_root = draft_dir / "assets"
    assets_root.mkdir(parents=True, exist_ok=True)

    material_paths: dict[str, str] = {}
    media_copied = 0
    media_missing: list[str] = []
    for clip in clips:
        if include_media:
            rel, ok = _copy_media(clip, assets_root)
        else:
            kind_dir = "audio" if clip.kind == "audio" else "video"
            suffix = ".mp3" if clip.kind == "audio" else ".mp4"
            rel, ok = f"assets/{kind_dir}/{clip.clip_id}{suffix}", False
        material_paths[clip.clip_id] = rel
        if ok:
            media_copied += 1
        else:
            hint = clip.media_url or str(clip.local_path or clip.clip_id)
            media_missing.append(f"{clip.label or clip.clip_id}: {hint}")

    doc = build_draft_document(
        draft_id=did,
        name=name,
        clips=clips,
        canvas_width=canvas_width,
        canvas_height=canvas_height,
        material_paths=material_paths,
    )
    duration_us = int(doc["duration"])
    meta = build_meta_info(draft_id=did, name=name, duration_us=duration_us)

    content_text = json.dumps(doc, ensure_ascii=False, indent=2)
    (draft_dir / "draft_content.json").write_text(content_text, encoding="utf-8")
    (draft_dir / "draft_info.json").write_text(content_text, encoding="utf-8")
    (draft_dir / "draft_meta_info.json").write_text(
        json.dumps(meta, ensure_ascii=False, indent=2), encoding="utf-8"
    )

    video_n = sum(1 for t in doc["tracks"] if t.get("type") == "video" for _ in t.get("segments") or [])
    audio_n = sum(1 for t in doc["tracks"] if t.get("type") == "audio" for _ in t.get("segments") or [])

    manifest = {
        "format": DRAFT_FORMAT_VERSION,
        "draft_id": did,
        "name": name,
        "duration_us": duration_us,
        "video_segments": video_n,
        "audio_segments": audio_n,
        "media_copied": media_copied,
        "media_missing": media_missing,
        "clips": [
            {
                "clip_id": c.clip_id,
                "label": c.label,
                "kind": c.kind,
                "duration_us": c.duration_us,
                "media_url": c.media_url,
                "rel_path": material_paths.get(c.clip_id),
            }
            for c in clips
        ],
        "license_note": "Original ToIV implementation; do not vend AGPL/GPL draft libraries.",
    }
    (draft_dir / "toiv_manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8"
    )
    (draft_dir / "IMPORT.md").write_text(
        import_readme(name=name, format_version=DRAFT_FORMAT_VERSION, media_missing=media_missing),
        encoding="utf-8",
    )

    return DraftBuildResult(
        draft_id=did,
        draft_dir=draft_dir,
        zip_path=None,
        duration_us=duration_us,
        video_segments=video_n,
        audio_segments=audio_n,
        media_copied=media_copied,
        media_missing=media_missing,
    )


def zip_draft_folder(draft_dir: Path, zip_path: Path) -> Path:
    """将草稿文件夹打成 ZIP（根入口为 draft_id/…）。"""
    zip_path.parent.mkdir(parents=True, exist_ok=True)
    if zip_path.exists():
        zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for path in sorted(draft_dir.rglob("*")):
            if path.is_file():
                zf.write(path, arcname=str(path.relative_to(draft_dir.parent)))
    return zip_path


def export_draft_zip(
    out_parent: Path,
    *,
    name: str,
    clips: Sequence[TimelineClip],
    draft_id: str | None = None,
    include_media: bool = True,
) -> DraftBuildResult:
    """写出草稿文件夹并打包 ZIP。"""
    result = write_draft_folder(
        out_parent,
        name=name,
        clips=clips,
        draft_id=draft_id,
        include_media=include_media,
    )
    fname = sanitize_draft_filename(name, draft_id=result.draft_id)
    zip_path = out_parent / f"{fname}.zip"
    zip_draft_folder(result.draft_dir, zip_path)
    result.zip_path = zip_path
    return result


def clips_from_studio_shots(
    shots: Iterable[Any],
    *,
    resolve_path: Callable[[str], Path | None],
    bgm_url: str = "",
    bgm_path: Path | None = None,
    default_duration_sec: float = 6.0,
) -> list[TimelineClip]:
    """从 StudioShot 行投影时间线（按 idx）。缺 final_clip_url 的镜跳过。"""
    ordered = sorted(list(shots), key=lambda s: int(getattr(s, "idx", 0) or 0))
    out: list[TimelineClip] = []
    video_cursor = 0
    for s in ordered:
        url = (getattr(s, "final_clip_url", None) or getattr(s, "video_url", None) or "").strip()
        if not url:
            continue
        dur_us = sec_to_us(getattr(s, "duration_sec", None), fallback_sec=default_duration_sec)
        local = resolve_path(url)
        idx = int(getattr(s, "idx", 0) or 0)
        sid = str(getattr(s, "id", "") or new_id())
        label = f"shot_{idx:02d}"
        dialogue = (getattr(s, "dialogue", None) or "").strip()
        shot_start = video_cursor
        out.append(
            TimelineClip(
                clip_id=sid,
                label=label,
                duration_us=dur_us,
                kind="video",
                media_url=url,
                local_path=local,
                dialogue=dialogue,
            )
        )
        voice = (getattr(s, "voice_url", None) or "").strip()
        if voice:
            vpath = resolve_path(voice)
            out.append(
                TimelineClip(
                    clip_id=f"{sid}_voice",
                    label=f"{label}_voice",
                    duration_us=dur_us,
                    kind="audio",
                    media_url=voice,
                    local_path=vpath,
                    timeline_start_us=shot_start,
                )
            )
        video_cursor += dur_us
    if bgm_url or bgm_path is not None:
        total = sum(c.duration_us for c in out if c.kind == "video") or sec_to_us(default_duration_sec)
        out.append(
            TimelineClip(
                clip_id=f"bgm_{new_id()[:8]}",
                label="bgm",
                duration_us=total,
                kind="audio",
                media_url=bgm_url or "",
                local_path=bgm_path,
                timeline_start_us=0,
            )
        )
    return out
