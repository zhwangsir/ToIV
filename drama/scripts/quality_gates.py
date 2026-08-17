"""短剧生成管线质量门（M4.2 / M5 增强）。

每个 gate 函数成功返回 None，失败返回人类可读的错误信息字符串。
M5 新增视觉检查：模糊检测、分辨率校验、人脸/角色一致性（VLM）。
"""
from __future__ import annotations

import json
import logging
import subprocess
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

# studio04 mlx-vlm 自定义反推端点（角色一致性对比复用）
DEFAULT_VLM_URL = "http://192.168.71.113:9303/v1/reverse"

# Laplacian 方差低于该值判定为模糊（经验阈值，1024×1024 清晰图通常 >300）
DEFAULT_BLUR_THRESHOLD = 100.0


def check_storyboard(data: dict) -> list[str]:
    """校验分镜字段、镜头数、时长。

    返回错误信息列表；空列表表示校验通过。
    """
    errors: list[str] = []
    if not isinstance(data, dict):
        return ["分镜数据必须是 dict"]

    title = data.get("title")
    if not title or not str(title).strip():
        errors.append("缺少 title 或 title 为空")

    characters = data.get("characters")
    if not isinstance(characters, list) or len(characters) == 0:
        errors.append("characters 必须是包含至少一个角色的列表")

    shots = data.get("shots")
    if not isinstance(shots, list) or len(shots) == 0:
        errors.append("shots 必须是包含至少一个镜头的列表")
    else:
        total_duration = 0.0
        for i, shot in enumerate(shots):
            prefix = f"镜头[{i}]"
            if not isinstance(shot, dict):
                errors.append(f"{prefix} 必须是 dict")
                continue
            sid = shot.get("id")
            if not sid or not str(sid).strip():
                errors.append(f"{prefix} 缺少 id")
            duration = shot.get("duration")
            if duration is None:
                errors.append(f"{prefix}({sid}) 缺少 duration")
            else:
                try:
                    dur = float(duration)
                    if not (0 < dur <= 120):
                        errors.append(f"{prefix}({sid}) duration={dur}s 超出合理范围 (0, 120]")
                    total_duration += dur
                except (TypeError, ValueError):
                    errors.append(f"{prefix}({sid}) duration 不是合法数字")
            if not shot.get("prompt"):
                errors.append(f"{prefix}({sid}) 缺少 prompt")
        if total_duration > 300:
            errors.append(f"总时长 {total_duration:.1f}s 超过 300s 上限")

    narration = data.get("narration")
    if not isinstance(narration, list):
        errors.append("narration 必须是列表")
    else:
        for i, cue in enumerate(narration):
            if not isinstance(cue, dict):
                errors.append(f"旁白[{i}] 必须是 dict")
                continue
            try:
                start = float(cue.get("start", 0))
                end = float(cue.get("end", 0))
                if end <= start:
                    errors.append(f"旁白[{i}] end <= start")
            except (TypeError, ValueError):
                errors.append(f"旁白[{i}] start/end 不是合法数字")
            if not cue.get("text"):
                errors.append(f"旁白[{i}] text 为空")

    return errors


def _ffprobe_stream(path: Path) -> Optional[dict]:
    """调用 ffprobe 返回首个视频/音频流信息。"""
    if not path.exists():
        return None
    cmd = [
        "ffprobe", "-v", "error",
        "-print_format", "json",
        "-show_streams", str(path),
    ]
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=30, check=True).stdout
        return json.loads(out)
    except Exception:
        return None


def check_keyframe(path: Path) -> Optional[str]:
    """校验关键帧：非空、尺寸 ≥1024、非全黑。

    优先用 PIL 检查像素；PIL 不可用时降级为 ffprobe 尺寸检查。
    """
    if not path.exists():
        return f"关键帧不存在: {path}"
    if path.stat().st_size == 0:
        return f"关键帧为空文件: {path}"

    try:
        from PIL import Image

        with Image.open(path) as img:
            w, h = img.size
            if w < 1024 or h < 1024:
                return f"关键帧尺寸 {w}×{h} 小于 1024×1024"
            # 全黑检查：取样缩略图判断最大亮度
            thumb = img.convert("L").resize((64, 64))
            if max(thumb.get_flattened_data()) == 0:
                return "关键帧为全黑图像"
        return None
    except ImportError:
        pass
    except Exception as e:
        return f"无法读取关键帧 {path}: {e}"

    # PIL 不可用：用 ffprobe 做基础检查
    info = _ffprobe_stream(path)
    if not info:
        return f"ffprobe 无法解析关键帧: {path}"
    streams = info.get("streams", [])
    video_streams = [s for s in streams if s.get("codec_type") == "video"]
    if not video_streams:
        return f"关键帧未包含视频流: {path}"
    s0 = video_streams[0]
    w = int(s0.get("width", 0))
    h = int(s0.get("height", 0))
    if w < 1024 or h < 1024:
        return f"关键帧尺寸 {w}×{h} 小于 1024×1024"
    return None


def check_video(path: Path, expected_frames: Optional[int] = None) -> Optional[str]:
    """校验视频：存在、可播放、可选帧数符合。"""
    if not path.exists():
        return f"视频不存在: {path}"
    if path.stat().st_size == 0:
        return f"视频为空文件: {path}"

    info = _ffprobe_stream(path)
    if not info:
        return f"ffprobe 无法解析视频: {path}"
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    if not streams:
        return f"视频未包含视频流: {path}"
    s0 = streams[0]
    w = int(s0.get("width", 0))
    h = int(s0.get("height", 0))
    if w <= 0 or h <= 0:
        return f"视频分辨率异常 {w}×{h}: {path}"

    if expected_frames is not None and expected_frames > 0:
        try:
            cmd = [
                "ffprobe", "-v", "error",
                "-count_frames", "-select_streams", "v:0",
                "-show_entries", "stream=nb_read_frames",
                "-of", "json", str(path),
            ]
            out = subprocess.run(cmd, capture_output=True, text=True, timeout=60, check=True).stdout
            data = json.loads(out)
            actual = int(data["streams"][0].get("nb_read_frames", 0))
            if actual != expected_frames:
                return f"视频帧数 {actual} 与期望 {expected_frames} 不符: {path}"
        except Exception as e:
            return f"无法统计视频帧数 {path}: {e}"
    return None


def check_audio(path: Path) -> Optional[str]:
    """校验音频：WAV 头、采样率 ≥22050Hz、时长 >0。"""
    if not path.exists():
        return f"音频不存在: {path}"
    if path.stat().st_size == 0:
        return f"音频为空文件: {path}"

    info = _ffprobe_stream(path)
    if not info:
        return f"ffprobe 无法解析音频: {path}"
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "audio"]
    if not streams:
        return f"音频未包含音频流: {path}"
    s0 = streams[0]

    # 检查 WAV 头（前 4 字节应为 RIFF）
    try:
        header = path.read_bytes()[:4]
        if header != b"RIFF":
            return f"音频不是 WAV 格式(缺少 RIFF 头): {path}"
    except Exception as e:
        return f"无法读取音频文件头 {path}: {e}"

    sample_rate = int(s0.get("sample_rate", 0))
    # IndexTTS2 原生输出 22050Hz；混音阶段统一重采样，这里只拦低质音源
    if sample_rate < 22050:
        return f"音频采样率 {sample_rate}Hz 低于 22050Hz: {path}"

    duration = float(s0.get("duration", 0))
    if duration <= 0:
        return f"音频时长 {duration}s 不大于 0: {path}"
    return None


def check_final(path: Path, expected_resolution: Optional[tuple[int, int]] = None) -> Optional[str]:
    """校验成片：分辨率、可播放。"""
    if not path.exists():
        return f"成片不存在: {path}"
    if path.stat().st_size == 0:
        return f"成片为空文件: {path}"

    info = _ffprobe_stream(path)
    if not info:
        return f"ffprobe 无法解析成片: {path}"
    streams = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
    if not streams:
        return f"成片未包含视频流: {path}"
    s0 = streams[0]
    w = int(s0.get("width", 0))
    h = int(s0.get("height", 0))
    if w <= 0 or h <= 0:
        return f"成片分辨率异常 {w}×{h}: {path}"
    if expected_resolution is not None:
        exp_w, exp_h = expected_resolution
        if (w, h) != (exp_w, exp_h):
            return f"成片分辨率 {w}×{h} 与期望 {exp_w}×{exp_h} 不符: {path}"
    return None


# ---------------------------------------------------------------------------
# M5 视觉检查：模糊 / 分辨率 / 角色一致性
# ---------------------------------------------------------------------------
def check_resolution(path: Path, min_width: int, min_height: int) -> Optional[str]:
    """通用分辨率校验：图片或视频需 ≥ min_width × min_height。"""
    if not path.exists():
        return f"文件不存在: {path}"
    try:
        from PIL import Image

        with Image.open(path) as img:
            w, h = img.size
    except Exception:
        # 非图片或 PIL 不可用：走 ffprobe
        info = _ffprobe_stream(path)
        if not info:
            return f"无法解析文件: {path}"
        streams = [s for s in info.get("streams", []) if s.get("codec_type") == "video"]
        if not streams:
            return f"文件未包含视频流: {path}"
        w = int(streams[0].get("width", 0))
        h = int(streams[0].get("height", 0))
    if w < min_width or h < min_height:
        return f"分辨率 {w}×{h} 小于要求 {min_width}×{min_height}: {path}"
    return None


def blur_score(path: Path) -> Optional[float]:
    """计算图像 Laplacian 方差（清晰度分数）。PIL 不可用或读取失败返回 None。

    优先用 numpy 做带符号卷积（真实 Laplacian 方差）；
    numpy 不可用时降级为 PIL Kernel：scale=16（核绝对值和）+ offset=128
    保留符号信息，再乘 16² 归一化到与 numpy 路径一致的量纲。
    分数越低越模糊；清晰摄影图通常 >300，重度模糊 <50。
    """
    try:
        from PIL import Image
    except ImportError:
        return None
    try:
        with Image.open(path) as img:
            gray = img.convert("L")
            # 限制计算量，同时保持模糊特征
            if max(gray.size) > 1024:
                gray = gray.resize((min(1024, gray.size[0]), min(1024, gray.size[1])))
            try:
                import numpy as np

                a = np.asarray(gray, dtype=np.float64)
                # 标准 4-邻域 Laplacian（保留符号，方差才有判别力）
                lap = (
                    -4.0 * a[1:-1, 1:-1]
                    + a[:-2, 1:-1] + a[2:, 1:-1]
                    + a[1:-1, :-2] + a[1:-1, 2:]
                )
                return float(lap.var())
            except ImportError:
                from PIL import ImageFilter, ImageStat

                # 8-邻域 Laplacian；scale=16 防溢出，offset=128 保留负值，
                # 输出方差 = 真实方差 / 16²，乘回去对齐 numpy 量纲。
                # 注意：PIL Kernel 不处理最外 1px 边框（直接复制源像素），
                # 必须裁掉边框再算方差，否则边框值污染结果。
                laplacian = gray.filter(
                    ImageFilter.Kernel(
                        (3, 3),
                        (-1, -1, -1, -1, 8, -1, -1, -1, -1),
                        scale=16,
                        offset=128,
                    )
                )
                w, h = laplacian.size
                if w > 2 and h > 2:
                    laplacian = laplacian.crop((1, 1, w - 1, h - 1))
                return ImageStat.Stat(laplacian).var[0] * (16.0 ** 2)
    except Exception:
        return None


def check_blur(path: Path, threshold: float = DEFAULT_BLUR_THRESHOLD) -> Optional[str]:
    """模糊检测：Laplacian 方差低于阈值判定模糊。

    PIL 不可用或无法计算时软通过（返回 None 并记日志），避免阻塞管线。
    """
    if not path.exists():
        return f"图片不存在: {path}"
    score = blur_score(path)
    if score is None:
        logger.warning("[gate] 无法计算模糊分数(PIL 不可用或读取失败)，软通过: %s", path)
        return None
    if score < threshold:
        return f"图像模糊(Laplacian 方差 {score:.1f} < {threshold}): {path}"
    return None


def _create_side_by_side(left: Path, right: Path, dest: Path) -> Path:
    """用 ffmpeg 把两张图水平拼接，供 VLM 单图对比。"""
    cmd = [
        "ffmpeg", "-y",
        "-i", str(left), "-i", str(right),
        "-filter_complex",
        "[0:v]scale=1024:1024[ref];[1:v]scale=1024:1024[frame];[ref][frame]hstack=inputs=2",
        str(dest),
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    return dest


def check_character_consistency(
    shot_keyframe: Path,
    character_ref: Path,
    *,
    vlm_url: Optional[str] = None,
    timeout: float = 120.0,
    strict: bool = False,
) -> Optional[str]:
    """角色一致性校验：用 VLM 对比镜头关键帧与角色定妆参考图。

    Args:
        shot_keyframe: 镜头关键帧（含角色的场景图）。
        character_ref: 角色定妆图（portrait_front 等）。
        vlm_url: mlx-vlm 反推端点；None 时用默认 studio04 地址。
        timeout: VLM 请求超时。
        strict: True 时 VLM 不可达也视为失败；False（默认）时软通过并记日志。

    Returns:
        一致或软通过返回 None；VLM 明确判定不一致返回错误字符串。
    """
    import base64

    if not shot_keyframe.exists():
        return f"镜头关键帧不存在: {shot_keyframe}"
    if not character_ref.exists():
        return f"角色参考图不存在: {character_ref}"

    url = vlm_url or DEFAULT_VLM_URL
    combined = shot_keyframe.parent / f".consistency_{shot_keyframe.stem}_vs_{character_ref.stem}.png"
    try:
        _create_side_by_side(character_ref, shot_keyframe, combined)
        b64 = base64.b64encode(combined.read_bytes()).decode("utf-8")
        prompt = (
            "This image shows two panels side-by-side. LEFT panel is a character reference portrait. "
            "RIGHT panel is a scene keyframe that should feature the same character. "
            "Does the character in the RIGHT panel match the LEFT reference in face, hair, and clothing style? "
            "If no character is clearly visible in the RIGHT panel, answer 'no'. "
            "Answer exactly: 'Consistent: yes/no. Reason: one sentence.'"
        )
        try:
            import requests
        except ImportError:
            if strict:
                return "角色一致性校验失败: requests 未安装"
            logger.warning("[gate] requests 未安装，角色一致性软通过: %s", shot_keyframe)
            return None
        try:
            r = requests.post(
                url,
                json={
                    "prompt": prompt,
                    "image_url": f"data:image/png;base64,{b64}",
                    "max_tokens": 256,
                    "temperature": 0.2,
                },
                timeout=timeout,
            )
            r.raise_for_status()
            answer = r.json().get("prompt", "")
        except Exception as e:
            if strict:
                return f"角色一致性 VLM 校验不可达({e}): {shot_keyframe}"
            logger.warning("[gate] VLM 不可达(%s)，角色一致性软通过: %s", e, shot_keyframe)
            return None
        logger.info("[gate] 一致性结论(%s vs %s): %s", shot_keyframe.name, character_ref.name, answer)
        if "Consistent: no" in answer or "Consistent:no" in answer:
            return f"角色不一致(VLM: {answer}): {shot_keyframe} vs {character_ref}"
        return None
    except subprocess.CalledProcessError as e:
        if strict:
            return f"角色一致性拼接图失败({e}): {shot_keyframe}"
        logger.warning("[gate] ffmpeg 拼接失败(%s)，角色一致性软通过", e)
        return None
    finally:
        try:
            if combined.exists():
                combined.unlink()
        except Exception:
            pass
