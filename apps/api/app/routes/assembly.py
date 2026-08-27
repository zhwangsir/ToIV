"""POST /api/manju/assemble —— 漫剧自动剪辑:把每镜视频片段拼成成片。

漫剧每镜先出图、再"关键帧转视频"得到一个视频片段(videoUrl)。本端点把这些
片段按顺序下载到临时目录,用 ffmpeg 拼接成一条 mp4,可选:转场(crossfade)、
烧录字幕(每镜文案)、混入 BGM。产出落到 /data 下,再由 GET /api/manju/output/{name}
取回。

健壮性:
- clip URL 仅允许指向本 API(相对路径或同源)或白名单 worker,防 SSRF。
- 任一 clip 下载失败 / ffmpeg 非零退出 → 抛清晰错误,不静默吞。
"""
from __future__ import annotations

import asyncio
import glob
import logging
import re
import shutil
import tempfile
import uuid
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field

try:
    from PIL import Image, ImageDraw, ImageFont
    _PILLOW_OK = True
except ImportError:
    _PILLOW_OK = False

from app.config import get_settings
from app.deps import get_current_user
from app.models import User
from app.storage import content_subdir, drama_output_root
from app.ratelimit import enforce_generation_rate_limit

router = APIRouter()
logger = logging.getLogger(__name__)

# 成片输出目录:容器挂了 toiv-data:/data;无 /data(本地)则回落到临时目录。
_OUTPUT_DIR = content_subdir("manju")  # 与 voice 同目录(生成内容根,可切 NAS)
# 短剧成片/配音统一落到 NAS drama final 目录,与 drama_studio.py 保持一致。
# 运行时解析(drama_output_root,60s 缓存):NAS 恢复后无需重启自动回切。

_TRANSITIONS = {"none", "crossfade"}
# 多平台导出预设:aspect → (宽, 高)。逐镜 scale+crop 填充到此尺寸。
_ASPECT_DIMS: dict[str, tuple[int, int]] = {
    "16:9": (1280, 720),  # 横屏(B站/YouTube)
    "9:16": (720, 1280),  # 竖屏(抖音/快手/Reels)
    "1:1": (1080, 1080),  # 方屏(Ins)
}
_TITLE_SEC = 2.4  # 片头标题卡时长
_CREDITS_SEC = 3.4  # 片尾字幕卡时长
_OUTPUT_NAME_RE = re.compile(r"^manju-[0-9a-f]{32}\.mp4$")
_DRAMA_OUTPUT_NAME_RE = re.compile(r"^drama-[0-9a-f]{32}\.mp4$")
_DEFAULT_FPS = 16
_CROSSFADE_SEC = 0.5  # 相邻片段交叠时长
# P1 接缝级重叠(overlap seam):12-18 帧按项目 fps 折算,clamp 到 0.4-0.75s
_OVERLAP_FRAMES = 15
_OVERLAP_MIN_SEC = 0.4
_OVERLAP_MAX_SEC = 0.75
_CLIP_EST_SEC = 2.0  # xfade offset 估计:每片段约 2s(漫剧片段普遍偏短)
_DOWNLOAD_TIMEOUT = 120.0
_DOWNLOAD_CONCURRENCY = 4  # 片段并发下载上限(同一 httpx client 复用,限流防压垮源端)
_FFMPEG_TIMEOUT = 300.0  # 本地 ffmpeg 合成上限:超时 kill 进程,防请求永久悬挂(对齐 animatic 300s)
# libx264 编码参数:合成产物多为中间产物(后续还会拼卡/重编码),速度优先,质量损失可忽略
_X264_ARGS: list[str] = ["-preset", "veryfast", "-crf", "20"]

# 调色滤镜预设(P3):全片统一电影级色调。值为 ffmpeg 视频滤镜串(接每镜链尾)。
# 故意只用 eq/colorbalance/hue/curves=preset(无内嵌引号),避免 filtergraph 转义坑。
_GRADES: dict[str, str] = {
    "none": "",
    "cinematic": "eq=contrast=1.06:saturation=1.05,colorbalance=rs=0.06:bs=-0.06:rm=0.04:bm=-0.04:rh=-0.04:bh=0.06",
    "warm": "colorbalance=rs=0.12:gs=0.04:bs=-0.12:rm=0.06:bm=-0.06,eq=saturation=1.08",
    "cool": "colorbalance=rs=-0.10:bs=0.12:rm=-0.05:bm=0.06,eq=saturation=1.02",
    "bw": "hue=s=0,eq=contrast=1.10",
    "vivid": "eq=saturation=1.35:contrast=1.08:brightness=0.02",
    "vintage": "curves=preset=vintage,eq=saturation=0.92",
}


def _find_cjk_font() -> str:
    """解析容器内 CJK 字体路径(fonts-noto-cjk),供 drawtext 渲染中文字幕/卡。"""
    for pat in (
        "/usr/share/fonts/opentype/noto/NotoSansCJK*.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK*.ttc",
        "/usr/share/fonts/**/*[Cc][Jj][Kk]*.tt?",
    ):
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]
    return ""


_CJK_FONT = _find_cjk_font()
_FONT_OPT = f"fontfile={_CJK_FONT}:" if _CJK_FONT else ""


class AssembleOptions(BaseModel):
    transition: str = Field(default="none")
    bgm_url: str | None = Field(default=None, max_length=2000)
    subtitles: list[str] = Field(default_factory=list)
    fps: int = Field(default=_DEFAULT_FPS, ge=1, le=60)
    aspect: str = Field(default="16:9")  # 16:9 横屏 / 9:16 竖屏 / 1:1 方屏(多平台)
    title: str = Field(default="", max_length=120)  # 片头标题卡(空=无)
    credits: str = Field(default="", max_length=600)  # 片尾字幕卡(空=无)
    # 专业混音(P2):逐轨音量 + BGM 闪避(对白响时自动压低 BGM,保人声清晰)
    voice_volume: float = Field(default=1.0, ge=0.0, le=2.0)
    bgm_volume: float = Field(default=0.35, ge=0.0, le=1.0)
    duck: bool = Field(default=True)
    # 调色滤镜(P3):none/cinematic/warm/cool/bw/vivid/vintage —— 全片统一电影级色调
    grade: str = Field(default="none", max_length=20)
    # 字幕样式(P4):字号 / 颜色(白名单)/ 位置(bottom/top/center)/ 描边盒
    sub_size: int = Field(default=28, ge=12, le=72)
    sub_color: str = Field(default="white", max_length=12)
    sub_pos: str = Field(default="bottom", max_length=10)
    sub_box: bool = Field(default=True)


class AssembleRequest(BaseModel):
    clips: list[str] = Field(min_length=1, max_length=48)
    # 逐镜配音 URL,与 clips 对齐(空串=该镜无配音);成片时对齐混入对白轨。
    voice_urls: list[str] = Field(default_factory=list, max_length=48)
    # 时间线编辑:逐镜目标时长(秒,与 clips 对齐;0/缺省=用片段原长)。小于原长则裁切。
    clip_durations: list[float] = Field(default_factory=list, max_length=48)
    options: AssembleOptions = Field(default_factory=AssembleOptions)


class AssembleResponse(BaseModel):
    url: str
    name: str


def _is_allowed_clip(url: str) -> bool:
    """clip 来源白名单:相对路径(本 API)或同源 / 白名单 worker host,防 SSRF。

    回环仅放行本 API 自身端口,不再全端口通配(语义详见 lipsync._allowed)。"""
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    settings = get_settings()
    allowed_hosts = {
        urlsplit(w).hostname for w in settings.worker_urls if urlsplit(w).hostname
    }
    # 同源(经反代回到本 API)也允许:本 API 的图片代理 /api/images 会带 host。
    if host in allowed_hosts:
        return True
    if host in {"127.0.0.1", "localhost"}:
        api = urlsplit(settings.api_base_url)
        api_port = api.port or (443 if api.scheme == "https" else 80)
        try:
            port = parts.port or (443 if parts.scheme == "https" else 80)
        except ValueError:  # 非法端口
            return False
        return port == api_port
    return False


def _check_redirect(resp: httpx.Response, initial_url: str) -> None:
    """重定向复验(follow_redirects 下载):最终落点须仍过白名单或与初始
    (已验)URL 同源,否则 400——防白名单内地址开放重定向绕过 SSRF 检查。"""
    final = str(resp.url)
    if final == initial_url:
        return
    f, i = urlsplit(final), urlsplit(initial_url)
    if f.scheme == i.scheme and f.netloc.lower() == i.netloc.lower():
        return
    if not _is_allowed_clip(final):
        raise HTTPException(status_code=400, detail="重定向目标不在白名单内")


def _resolve_clip_url(url: str) -> str:
    """相对路径补全成可下载的绝对 URL(指回本 API 自身)。"""
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    if url.startswith("/"):
        return base + url
    return f"{base}/{url}"


_VOICE_NAME_RE = re.compile(r"^voice(?:ref)?-[0-9a-f]{32}\.wav$")


async def _download_clip(client: httpx.AsyncClient, url: str, dest: Path) -> None:
    # 同源 manju/drama 产物(配音 wav / 成片 mp4)直接读本地文件,避免内部 HTTP 自调
    # 撞鉴权(这些端点要 Bearer token,而此处是服务端内部下载无 token)。
    name = url.rsplit("/", 1)[-1]
    if url.startswith(("/api/manju/output/", "/api/manju/voice/")):
        if (_OUTPUT_NAME_RE.match(name) or _VOICE_NAME_RE.match(name)):
            local = _OUTPUT_DIR / name
            if local.is_file():
                # 文件拷贝走线程池,避免整文件读进内存 + 同步 IO 阻塞事件循环
                await asyncio.to_thread(shutil.copyfile, local, dest)
                return
    if url.startswith(("/api/drama/output/", "/api/drama/voice/")):
        if (_DRAMA_OUTPUT_NAME_RE.match(name) or _VOICE_NAME_RE.match(name)):
            local = drama_output_root() / name
            if local.is_file():
                await asyncio.to_thread(shutil.copyfile, local, dest)
                return
    resolved = _resolve_clip_url(url)
    try:
        resp = await client.get(resolved)
        _check_redirect(resp, resolved)
        resp.raise_for_status()
    except httpx.HTTPError as e:
        raise HTTPException(
            status_code=502, detail=f"片段下载失败:{url}({e})"
        ) from e
    if not resp.content:
        raise HTTPException(status_code=502, detail=f"片段为空:{url}")
    await asyncio.to_thread(dest.write_bytes, resp.content)


async def _download_all(
    client: httpx.AsyncClient, items: list[tuple[str, Path]]
) -> None:
    """并发下载全部片段(同 client 复用,Semaphore 限流);任一失败即抛,不静默吞。

    用 return_exceptions 收齐结果再抛首个异常:等所有任务收尾,避免临时目录
    提前清理导致后台任务写失败/异常无人领取。
    """
    sem = asyncio.Semaphore(_DOWNLOAD_CONCURRENCY)

    async def _one(url: str, dest: Path) -> None:
        async with sem:
            await _download_clip(client, url, dest)

    results = await asyncio.gather(
        *(_one(url, dest) for url, dest in items), return_exceptions=True
    )
    for r in results:
        if isinstance(r, BaseException):
            raise r


async def _probe_duration(path: Path) -> float:
    """ffprobe 测片段实际时长(秒),供逐镜配音偏移对齐;失败回落估计值。"""
    if shutil.which("ffprobe") is None:
        return _CLIP_EST_SEC
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-show_entries", "format=duration",
        "-of", "default=nw=1:nk=1", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        return float(out.decode().strip())
    except (ValueError, AttributeError):
        return _CLIP_EST_SEC


def _escape_drawtext(text: str) -> str:
    """转义 drawtext 文案里的特殊字符(ffmpeg 滤镜语法敏感)。"""
    return (
        text.replace("\\", "\\\\")
        .replace(":", "\\:")
        .replace("'", "’")  # 单引号在 filtergraph 里难转义,直接换成排版引号
        .replace("%", "\\%")
        .replace("[", "\\[")
        .replace("]", "\\]")
        .replace(",", "\\,")
        .replace(";", "\\;")
        .replace("\n", " ")
    )


# 字幕颜色白名单(防注入;值为 ffmpeg 可识别色)
_SUB_COLORS: dict[str, str] = {
    "white": "white",
    "yellow": "yellow",
    "cyan": "0x66e0ff",
    "pink": "0xff9ecb",
    "green": "0x9cff8f",
    "black": "black",
}

# PIL 颜色名(ffmpeg 色名 → PIL RGB 元组)
_PIL_COLORS: dict[str, tuple[int, int, int]] = {
    "white": (255, 255, 255),
    "yellow": (255, 255, 0),
    "cyan": (0x66, 0xe0, 0xff),
    "pink": (0xff, 0x9e, 0xcb),
    "green": (0x9c, 0xff, 0x8f),
    "black": (0, 0, 0),
}


def _find_pillow_font() -> str:
    """查找可用 CJK 字体路径(Pillow 渲染中文用)。"""
    for pat in (
        "/System/Library/Fonts/PingFang.ttc",
        "/System/Library/Fonts/STHeiti Medium.ttc",
        "/System/Library/Fonts/Supplemental/Songti.ttc",
        "/usr/share/fonts/opentype/noto/NotoSansCJK*.ttc",
        "/usr/share/fonts/truetype/noto/NotoSansCJK*.ttc",
    ):
        hits = sorted(glob.glob(pat, recursive=True))
        if hits:
            return hits[0]
    return ""


_PIL_FONT_PATH = _find_pillow_font()


def _render_subtitle_png(text: str, options: "AssembleOptions", width: int) -> Path | None:
    """用 Pillow 渲染字幕成透明 PNG,返回临时文件路径(drawtext 不可用时的回退)。

    - 描边盒:半透明黑底圆角盒(options.sub_box=True)
    - 无盒:文字描边(黑色 stroke)
    - 位置由 options.sub_pos 控制(top/center/bottom),返回的 PNG 已按 width 撑满,
      overlay 时只需水平居中 + 垂直定位。
    """
    if not _PILLOW_OK or not _PIL_FONT_PATH or not text.strip():
        return None
    size = options.sub_size
    color = _PIL_COLORS.get(options.sub_color, (255, 255, 255))
    try:
        font = ImageFont.truetype(_PIL_FONT_PATH, size)
    except Exception:
        return None
    # 测量文本尺寸
    tmp = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # PNG 宽度撑满视频宽,高度按文本 + padding
    pad_x = max(20, size // 2)
    pad_y = max(12, size // 3)
    img_w = width
    img_h = th + pad_y * 2
    img = Image.new("RGBA", (img_w, img_h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # 水平居中
    tx = (img_w - tw) // 2 - bbox[0]
    ty = pad_y - bbox[1]
    if options.sub_box:
        # 半透明黑底圆角盒
        box_pad = max(8, size // 3)
        draw.rounded_rectangle(
            [tx - box_pad, ty - box_pad // 2, tx + tw + box_pad, ty + th + box_pad // 2],
            radius=max(6, size // 4),
            fill=(0, 0, 0, 115),
        )
        draw.text((tx, ty), text, font=font, fill=color + (255,))
    else:
        # 黑色描边(4 方向各画一次)+ 主色文字
        stroke = max(2, size // 14)
        for dx, dy in [(-stroke, 0), (stroke, 0), (0, -stroke), (0, stroke)]:
            draw.text((tx + dx, ty + dy), text, font=font, fill=(0, 0, 0, 220))
        draw.text((tx, ty), text, font=font, fill=color + (255,))
    # 写临时文件
    tmp_path = Path(tempfile.gettempdir()) / f"sub_{uuid.uuid4().hex}.png"
    img.save(tmp_path, "PNG")
    return tmp_path


def _subtitle_filter(text: str, options: "AssembleOptions") -> str:
    """单镜烧录字幕:可调字号/颜色/位置/描边盒(P4 字幕样式)。

    返回 drawtext 滤镜串(ffmpeg 有 drawtext 时用)。无 drawtext 时走 _render_subtitle_png + overlay,
    由 _build_ffmpeg_command 处理。
    """
    safe = _escape_drawtext(text.strip())
    if not safe:
        return ""
    size = options.sub_size
    color = _SUB_COLORS.get(options.sub_color, "white")
    if options.sub_pos == "top":
        y = "40"
    elif options.sub_pos == "center":
        y = "(h-text_h)/2"
    else:
        y = "h-text_h-40"
    deco = (
        f":box=1:boxcolor=black@0.45:boxborderw={max(8, size // 2)}"
        if options.sub_box
        else ":borderw=2:bordercolor=black@0.85"
    )
    return (
        "drawtext=" + _FONT_OPT + "text='" + safe + "'"
        f":fontcolor={color}:fontsize={size}:line_spacing=6"
        f"{deco}"
        f":x=(w-text_w)/2:y={y}"
    )


def _ffmpeg_has_drawtext() -> bool:
    """运行时检测 ffmpeg 是否编译了 drawtext 滤镜(Homebrew 默认无,需 libfreetype)。"""
    import subprocess
    try:
        r = subprocess.run(
            ["ffmpeg", "-hide_banner", "-filters"],
            capture_output=True, text=True, timeout=5,
        )
        return "drawtext" in r.stdout
    except Exception:
        return False


# 模块加载时一次性检测(drawtext 不可用则全片走 Pillow overlay 路径)
_HAS_DRAWTEXT = _ffmpeg_has_drawtext()


def _embedded_clip_audio_filters(
    n: int, durations: list[float], silent_idx: dict[int, int]
) -> tuple[list[str], list[str]]:
    """逐镜内嵌音轨归一(与视频 trim 对齐防音画漂移):有音轨片段 aresample 到
    stereo/44.1k,无音轨片段用 anullsrc 静音输入(silent_idx)补偿。
    返回 (filters, alabels),供 concat 或 acrossfade 链引用。
    """
    filters: list[str] = []
    alabels: list[str] = []
    for i in range(n):
        dur = durations[i] if i < len(durations) else _CLIP_EST_SEC
        if i in silent_idx:
            filters.append(
                f"[{silent_idx[i]}:a]atrim=0:{dur:.2f},asetpts=PTS-STARTPTS[a{i}]"
            )
        else:
            filters.append(
                f"[{i}:a]atrim=0:{dur:.2f},asetpts=PTS-STARTPTS,"
                f"aresample=44100,aformat=channel_layouts=stereo[a{i}]"
            )
        alabels.append(f"a{i}")
    return filters, alabels


def _overlap_xfade_sec(fps: int) -> float:
    """overlap 接缝交叠时长:12-18 帧(取中值 15)按项目 fps 折算,clamp 0.4-0.75s。"""
    sec = _OVERLAP_FRAMES / max(1, fps)
    return min(_OVERLAP_MAX_SEC, max(_OVERLAP_MIN_SEC, sec))


def _build_ffmpeg_command(
    clips: list[Path],
    options: AssembleOptions,
    bgm: Path | None,
    voices: list[Path | None],
    durations: list[float],
    targets: list[float],
    dims: tuple[int, int],
    out: Path,
    clip_audio: list[bool] | None = None,
    seams: list[str] | None = None,
) -> list[str]:
    """构造 ffmpeg 命令。

    - 字幕:drawtext 可用→逐 clip drawtext;不可用→Pillow 渲染 PNG + overlay(每镜一个 PNG input)。
    - 转场 none:用 concat 滤镜首尾相接;crossfade:用 xfade 链式交叠。
    - P1 接缝级转场(seams,可选):seams[i] 为第 i 镜与第 i+1 镜的接缝策略——
      "overlap" → 该接缝 xfade 交叠(12-18 帧按 fps 折算,clamp 0.4-0.75s),
      内嵌音轨模式下音轨 acrossfade 同 duration 配对;
      已声明非 overlap(continue/matchcut/hardcut)→ 该接缝硬切;
      未声明(空串)→ 沿用全局 transition(向后兼容);
      seams=None 或全部未声明时完全走旧行为(命令形状不变)。
    - 音频:有配音则逐镜按片段起始偏移 adelay 对齐成对白轨,叠可选 BGM(降音垫底)amix;
      无配音仅 BGM 时沿用原单轨逻辑(漫剧片段普遍无声)。
    - 片段内嵌音轨(clip_audio,可选):无配音、无 BGM、至少一片段有音轨且转场为 none
      (或接缝计划含 xfade)时,保留片段原生音轨——有音轨片段 aresample 归一,
      无音轨片段补 anullsrc 静音,concat/acrossfade 带音频输出;其他情形保持旧行为。
    """
    has_voice = any(v is not None for v in voices)
    # 内嵌音轨模式判定:配音/BGM 优先(内嵌音轨丢弃,仅记日志)
    has_embedded = bool(clip_audio) and any(clip_audio)
    if has_embedded and (has_voice or bgm is not None):
        logger.info("合成:片段内嵌音轨被配音/BGM 覆盖,不映射内嵌音轨")
    # 接缝级转场计划:逐接缝 (kind, duration);kind ∈ {"xfade", "cut"}。
    # 仅当存在已声明(非空)接缝时启用;全部未声明走旧分支,命令形状与历史完全一致。
    seam_plan: list[tuple[str, float]] | None = None
    if (
        seams is not None
        and len(clips) > 1
        and any((seams[i] if i < len(seams) else "") for i in range(len(clips) - 1))
    ):
        seam_plan = []
        for i in range(len(clips) - 1):
            s = seams[i] if i < len(seams) else ""
            if s == "overlap":
                seam_plan.append(("xfade", _overlap_xfade_sec(options.fps)))
            elif s in ("continue", "matchcut", "hardcut"):
                seam_plan.append(("cut", 0.0))
            elif options.transition == "crossfade":
                seam_plan.append(("xfade", _CROSSFADE_SEC))
            else:
                seam_plan.append(("cut", 0.0))
    plan_has_xfade = bool(seam_plan) and any(k == "xfade" for k, _ in seam_plan)
    use_embedded = (
        has_embedded
        and not has_voice
        and bgm is None
        and (options.transition == "none" or plan_has_xfade)
    )
    if (
        has_embedded
        and not has_voice
        and bgm is None
        and options.transition != "none"
        and not plan_has_xfade
    ):
        # 旧全局 crossfade(无接缝声明)仍不支持保留内嵌音轨;接缝级 xfade 走 acrossfade
        logger.warning(
            "合成:crossfade 转场暂不支持保留片段内嵌音轨(acrossfade 混音链未实现),内嵌音轨将被丢弃"
        )
    cmd: list[str] = ["ffmpeg", "-y"]
    for clip in clips:
        cmd += ["-i", str(clip)]
    bgm_idx = len(clips)
    if bgm is not None:
        cmd += ["-i", str(bgm)]
    # 配音输入排在 clips(+BGM)之后,记录每个 present 配音的 (镜序, 输入索引)
    voice_inputs: list[tuple[int, int]] = []
    _next_idx = len(clips) + (1 if bgm is not None else 0)
    for i, vp in enumerate(voices):
        if vp is not None:
            cmd += ["-i", str(vp)]
            voice_inputs.append((i, _next_idx))
            _next_idx += 1
    # 内嵌音轨链:无音轨片段补 anullsrc 静音 lavfi 输入(索引接在 clips/BGM/配音之后)
    # 注意:anullsrc 的选项是 channel_layout(单数),与 aformat 的 channel_layouts(复数)不同
    silent_idx: dict[int, int] = {}  # 镜序 → anullsrc 输入索引
    if use_embedded:
        for i in range(len(clips)):
            if i >= len(clip_audio) or not clip_audio[i]:
                cmd += [
                    "-f", "lavfi",
                    "-i", "anullsrc=channel_layout=stereo:sample_rate=44100",
                ]
                silent_idx[i] = _next_idx
                _next_idx += 1

    # 字幕 PNG inputs(drawtext 不可用时):每镜一个 PNG,排在所有输入最后
    subs = options.subtitles
    _w, _h = dims
    sub_png_idx: dict[int, int] = {}  # 镜序 → PNG input 索引
    if not _HAS_DRAWTEXT:
        for i in range(len(clips)):
            if i < len(subs) and subs[i].strip():
                png = _render_subtitle_png(subs[i], options, _w)
                if png is not None:
                    cmd += ["-i", str(png)]
                    sub_png_idx[i] = _next_idx
                    _next_idx += 1

    filters: list[str] = []
    # 每镜先 fps 归一 + 像素格式标准化 + 可选烧字幕,产出 [vN]
    vlabels: list[str] = []
    for i in range(len(clips)):
        # 多平台预设:缩放到覆盖目标尺寸再中心裁切(填满无黑边),社媒标准做法
        chain = []
        # 时间线逐镜裁切:目标时长 < 原长则截短(setpts 重置时间戳,避免拼接时间轴错乱)
        tgt = targets[i] if i < len(targets) else 0.0
        if tgt and tgt > 0:
            chain += [f"trim=0:{tgt:.2f}", "setpts=PTS-STARTPTS"]
        chain += [
            f"scale={_w}:{_h}:force_original_aspect_ratio=increase",
            f"crop={_w}:{_h}",
            "setsar=1",  # 统一 SAR 1:1,与片头/片尾卡 concat 不失配
            f"fps={options.fps}",
            "format=yuv420p",
        ]
        # 调色滤镜(P3):全片统一色调(接在缩放/裁切之后、字幕之前)
        grade = _GRADES.get(options.grade, "")
        if grade:
            chain.append(grade)
        # 字幕:drawtext 可用→加到 chain;不可用→单独 overlay 步骤(需引用 PNG input)
        if _HAS_DRAWTEXT:
            sub = _subtitle_filter(subs[i], options) if i < len(subs) and subs[i].strip() else ""
            if sub:
                chain.append(sub)
        label = f"v{i}"
        filters.append(f"[{i}:v]" + ",".join(chain) + f"[{label}]")
        vlabels.append(label)
        # Pillow overlay:在 v{i} 之上叠加字幕 PNG → v{i}sub
        if i in sub_png_idx:
            png_i = sub_png_idx[i]
            # overlay 的 y 用 H-h-40 形式(H=视频高,h=PNG 高),水平居中 x=(W-w)/2
            if options.sub_pos == "top":
                y_expr = "40"
            elif options.sub_pos == "center":
                y_expr = "(H-h)/2"
            else:
                y_expr = "H-h-40"
            sub_label = f"v{i}sub"
            filters.append(
                f"[{label}][{png_i}:v]overlay=x=(W-w)/2:y={y_expr}[{sub_label}]"
            )
            vlabels[-1] = sub_label  # 替换为带字幕的 label


    aout: str | None = None
    if seam_plan is not None and len(clips) > 1:
        # ── P1 接缝级混合链:xfade 接缝交叠 / 硬切接缝 concat,同一条 filtergraph 混排 ──
        prev = vlabels[0]
        acc = durations[0] if durations else _CLIP_EST_SEC
        for i in range(1, len(clips)):
            kind, dsec = seam_plan[i - 1]
            cur_dur = durations[i] if i < len(durations) else _CLIP_EST_SEC
            if kind == "xfade":
                # 交叠落在累积时间线尾部:offset = 已累积时长 - 交叠时长(精确不漂移)
                offset = max(0.1, acc - dsec)
                filters.append(
                    f"[{prev}][{vlabels[i]}]xfade=transition=fade"
                    f":duration={dsec:.2f}:offset={offset:.2f}[xf{i}]"
                )
                acc = acc + cur_dur - dsec
                prev = f"xf{i}"
            else:
                filters.append(f"[{prev}][{vlabels[i]}]concat=n=2:v=1:a=0[cc{i}]")
                acc += cur_dur
                prev = f"cc{i}"
        vout = prev
        if use_embedded:
            # 内嵌音轨与视频链配对:xfade 接缝 acrossfade(同 duration),硬切接缝 a=1 concat
            af, alabels = _embedded_clip_audio_filters(len(clips), durations, silent_idx)
            filters.extend(af)
            aprev = alabels[0]
            for i in range(1, len(clips)):
                kind, dsec = seam_plan[i - 1]
                if kind == "xfade":
                    filters.append(
                        f"[{aprev}][{alabels[i]}]acrossfade=d={dsec:.2f}[ax{i}]"
                    )
                    aprev = f"ax{i}"
                else:
                    filters.append(
                        f"[{aprev}][{alabels[i]}]concat=n=2:v=0:a=1[ac{i}]"
                    )
                    aprev = f"ac{i}"
            aout = aprev
    elif options.transition == "crossfade" and len(clips) > 1:
        prev = vlabels[0]
        offset = 0.0
        for i in range(1, len(clips)):
            out_label = f"xf{i}"
            # 交叠落在上一段尾部:用上一镜实际(裁切后)时长累积,offset 精确不漂移。
            prev_dur = durations[i - 1] if (i - 1) < len(durations) else _CLIP_EST_SEC
            offset += max(0.1, prev_dur - _CROSSFADE_SEC)
            filters.append(
                f"[{prev}][{vlabels[i]}]xfade=transition=fade"
                f":duration={_CROSSFADE_SEC}:offset={max(offset, 0.1):.2f}[{out_label}]"
            )
            prev = out_label
        vout = prev
    elif use_embedded:
        # 内嵌音轨链:逐镜音频按该镜有效时长截齐(与视频 trim 对齐防音画漂移),
        # 有音轨片段归一到 stereo/44.1k,无音轨片段用 anullsrc 补偿,concat 带音频。
        af, alabels = _embedded_clip_audio_filters(len(clips), durations, silent_idx)
        filters.extend(af)
        concat_inputs = "".join(
            f"[{vlabels[i]}][{alabels[i]}]" for i in range(len(clips))
        )
        filters.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=1[vout][aout]")
        vout = "vout"
        aout = "aout"
    elif len(clips) > 1:
        concat_inputs = "".join(f"[{label}]" for label in vlabels)
        filters.append(f"{concat_inputs}concat=n={len(clips)}:v=1:a=0[vout]")
        vout = "vout"
    else:
        vout = vlabels[0]

    # ---- 音频:逐镜配音对齐(逐轨音量)+ 可选 BGM(可对白闪避)----
    if has_voice:
        offsets: list[float] = []
        acc = 0.0
        for d in durations:
            offsets.append(acc)
            acc += d
        total = acc or _CLIP_EST_SEC
        vvol = options.voice_volume
        dia_labels: list[str] = []
        for clip_i, in_idx in voice_inputs:
            off_ms = int(offsets[clip_i] * 1000) if clip_i < len(offsets) else 0
            lbl = f"d{clip_i}"
            # 延迟到该镜起始 + 对白音量 + 统一声道布局,便于 amix/sidechain
            filters.append(
                f"[{in_idx}:a]adelay={off_ms}|{off_ms},volume={vvol:.2f},aformat=channel_layouts=stereo[{lbl}]"
            )
            dia_labels.append(f"[{lbl}]")
        # 合成单条对白轨 [dia]
        if len(dia_labels) == 1:
            dia = dia_labels[0]
        else:
            filters.append(
                f"{''.join(dia_labels)}amix=inputs={len(dia_labels)}:normalize=0:dropout_transition=0[dia]"
            )
            dia = "[dia]"
        if bgm is not None:
            filters.append(
                f"[{bgm_idx}:a]volume={options.bgm_volume:.2f},aformat=channel_layouts=stereo[bg]"
            )
            if options.duck:
                # 对白做 sidechain key:对白响 → 压低 BGM(保人声)。asplit 复用对白轨(一路压制一路入混)
                filters.append(f"{dia}asplit=2[diak][diam]")
                filters.append(
                    "[bg][diak]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=350[bgd]"
                )
                filters.append(
                    f"[diam][bgd]amix=inputs=2:normalize=0:dropout_transition=0[mix];"
                    f"[mix]apad,atrim=0:{total:.2f}[aout]"
                )
            else:
                filters.append(
                    f"{dia}[bg]amix=inputs=2:normalize=0:dropout_transition=0[mix];"
                    f"[mix]apad,atrim=0:{total:.2f}[aout]"
                )
        else:
            filters.append(f"{dia}apad,atrim=0:{total:.2f}[aout]")
        aout = "aout"

    cmd += ["-filter_complex", ";".join(filters), "-map", f"[{vout}]"]

    if aout is not None:
        cmd += ["-map", f"[{aout}]"]
    elif bgm is not None:
        cmd += ["-map", f"{bgm_idx}:a", "-shortest"]

    cmd += [
        "-c:v",
        "libx264",
        *_X264_ARGS,
        "-pix_fmt",
        "yuv420p",
        "-r",
        str(options.fps),
        "-movflags",
        "+faststart",
    ]
    if aout is not None or bgm is not None:
        cmd += ["-c:a", "aac", "-b:a", "192k"]
    cmd.append(str(out))
    return cmd


async def _run_ffmpeg(cmd: list[str], timeout: float = _FFMPEG_TIMEOUT) -> None:
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    try:
        _, stderr = await asyncio.wait_for(proc.communicate(), timeout=timeout)
    except TimeoutError:
        # ffmpeg 挂起:kill 进程并回收,抛明确错误,不让请求永久悬挂
        proc.kill()
        await proc.wait()
        raise HTTPException(
            status_code=500, detail=f"合成失败(ffmpeg):执行超时({timeout:.0f}s)"
        ) from None
    if proc.returncode != 0:
        tail = (stderr or b"").decode("utf-8", "replace")[-800:]
        raise HTTPException(status_code=500, detail=f"合成失败(ffmpeg):{tail}")


def _aspect_dims(aspect: str) -> tuple[int, int]:
    """aspect 预设 → 目标 (宽, 高);未知回落 16:9。"""
    return _ASPECT_DIMS.get(aspect, _ASPECT_DIMS["16:9"])


async def _gen_card(
    text: str, dims: tuple[int, int], fps: int, dur: float, with_audio: bool, out: Path
) -> None:
    """生成片头/片尾卡:深底 + 居中文字,WxH/fps 与正片一致便于拼接。

    with_audio:正片有音轨时卡也配静音轨(concat 需各段流一致),否则纯视频。
    drawtext 不可用时用 Pillow 渲染文字 PNG + overlay。
    """
    w, h = dims
    fontsize = max(30, h // 15)
    cmd: list[str] = [
        "ffmpeg", "-y",
        "-f", "lavfi", "-i", f"color=c=0x111119:s={w}x{h}:r={fps}:d={dur:.2f}",
    ]
    if with_audio:
        cmd += ["-f", "lavfi", "-i", "anullsrc=channel_layout=stereo:sample_rate=44100"]
    if _HAS_DRAWTEXT:
        safe = _escape_drawtext(text.strip())
        draw = (
            f"drawtext={_FONT_OPT}text='{safe}':fontcolor=white:fontsize={fontsize}:line_spacing=12"
            f":x=(w-text_w)/2:y=(h-text_h)/2"
        )
        cmd += ["-t", f"{dur:.2f}", "-filter_complex", f"[0:v]{draw}[v]", "-map", "[v]"]
    else:
        # Pillow 渲染文字 PNG → overlay 到纯色背景
        text_png = _render_card_text_png(text, w, h, fontsize)
        if text_png is None:
            # 无 Pillow/字体:纯色卡无文字(降级,不阻塞)
            cmd += ["-t", f"{dur:.2f}", "-map", "0:v"]
        else:
            cmd += ["-i", str(text_png)]
            # PNG input 索引:有音频时是 2(0=视频背景,1=静音音频,2=PNG),无音频时是 1
            png_idx = 2 if with_audio else 1
            cmd += [
                "-t", f"{dur:.2f}",
                "-filter_complex", f"[0:v][{png_idx}:v]overlay=x=(W-w)/2:y=(H-h)/2[v]",
                "-map", "[v]",
            ]
    if with_audio:
        cmd += ["-map", "1:a", "-c:a", "aac", "-b:a", "192k"]
    cmd += ["-c:v", "libx264", *_X264_ARGS, "-pix_fmt", "yuv420p", "-r", str(fps), "-shortest", str(out)]
    await _run_ffmpeg(cmd)


def _render_card_text_png(text: str, video_w: int, video_h: int, fontsize: int) -> Path | None:
    """Pillow 渲染片头/片尾卡文字成透明 PNG(白色文字,居中)。"""
    if not _PILLOW_OK or not _PIL_FONT_PATH or not text.strip():
        return None
    try:
        font = ImageFont.truetype(_PIL_FONT_PATH, fontsize)
    except Exception:
        return None
    tmp = Image.new("RGBA", (1, 1), (0, 0, 0, 0))
    d = ImageDraw.Draw(tmp)
    bbox = d.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    # PNG 尺寸 = 文本尺寸 + padding,overlay 时居中
    pad = fontsize // 2
    img = Image.new("RGBA", (tw + pad * 2, th + pad * 2), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    tx = pad - bbox[0]
    ty = pad - bbox[1]
    draw.text((tx, ty), text, font=font, fill=(255, 255, 255, 255))
    tmp_path = Path(tempfile.gettempdir()) / f"card_{uuid.uuid4().hex}.png"
    img.save(tmp_path, "PNG")
    return tmp_path


async def _concat_parts(parts: list[Path], fps: int, with_audio: bool, out: Path) -> None:
    """把 [片头?, 正片, 片尾?] 按序拼接(concat 滤镜重编码,容差不同参数)。"""
    cmd: list[str] = ["ffmpeg", "-y"]
    for p in parts:
        cmd += ["-i", str(p)]
    n = len(parts)
    if with_audio:
        streams = "".join(f"[{i}:v][{i}:a]" for i in range(n))
        fc = f"{streams}concat=n={n}:v=1:a=1[v][a]"
        maps = ["-map", "[v]", "-map", "[a]", "-c:a", "aac", "-b:a", "192k"]
    else:
        streams = "".join(f"[{i}:v]" for i in range(n))
        fc = f"{streams}concat=n={n}:v=1:a=0[v]"
        maps = ["-map", "[v]"]
    cmd += ["-filter_complex", fc, *maps,
            "-c:v", "libx264", *_X264_ARGS, "-pix_fmt", "yuv420p", "-r", str(fps),
            "-movflags", "+faststart", str(out)]
    await _run_ffmpeg(cmd)


@router.post("/manju/assemble", response_model=AssembleResponse)
async def assemble_manju(
    body: AssembleRequest,
    user: User = Depends(get_current_user),
) -> AssembleResponse:
    enforce_generation_rate_limit(user)

    if body.options.transition not in _TRANSITIONS:
        raise HTTPException(status_code=422, detail="未知的转场类型")
    for clip in body.clips:
        if not _is_allowed_clip(clip):
            raise HTTPException(status_code=400, detail="片段来源不在白名单内")
    if body.options.bgm_url and not _is_allowed_clip(body.options.bgm_url):
        raise HTTPException(status_code=400, detail="BGM 来源不在白名单内")
    for v in body.voice_urls:
        if v and not _is_allowed_clip(v):
            raise HTTPException(status_code=400, detail="配音来源不在白名单内")

    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    name = f"manju-{uuid.uuid4().hex}.mp4"
    out_path = _OUTPUT_DIR / name

    with tempfile.TemporaryDirectory(prefix="manju-asm-") as tmp:
        tmp_dir = Path(tmp)
        clip_paths: list[Path] = []
        voice_paths: list[Path | None] = [None] * len(body.clips)
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            # 片段 + BGM + 逐镜配音统一并发下载(Semaphore 限流),任一失败即抛
            downloads: list[tuple[str, Path]] = []
            for i, url in enumerate(body.clips):
                dest = tmp_dir / f"clip-{i:03d}.mp4"
                downloads.append((url, dest))
                clip_paths.append(dest)

            bgm_path: Path | None = None
            if body.options.bgm_url:
                bgm_path = tmp_dir / "bgm.audio"
                downloads.append((body.options.bgm_url, bgm_path))

            # 逐镜配音(与 clips 对齐;空串=该镜无配音)
            for i, vurl in enumerate(body.voice_urls[: len(body.clips)]):
                if vurl:
                    vdest = tmp_dir / f"voice-{i:03d}.wav"
                    downloads.append((vurl, vdest))
                    voice_paths[i] = vdest

            await _download_all(client, downloads)

        probed = [await _probe_duration(p) for p in clip_paths]
        # 时间线逐镜目标时长:小于原长则裁切;有效时长用于转场/配音偏移精确对齐
        targets = list(body.clip_durations)
        durations = [
            min(probed[i], targets[i])
            if i < len(targets) and targets[i] and targets[i] > 0
            else probed[i]
            for i in range(len(probed))
        ]
        dims = _aspect_dims(body.options.aspect)
        opt = body.options
        # 有片头/片尾卡时:先出正片到临时,再拼接卡;否则直接出到成片。
        has_bookends = bool(opt.title.strip() or opt.credits.strip())
        film_path = (tmp_dir / "film.mp4") if has_bookends else out_path
        cmd = _build_ffmpeg_command(
            clip_paths, opt, bgm_path, voice_paths, durations, targets, dims, film_path
        )
        await _run_ffmpeg(cmd)

        if has_bookends:
            film_has_audio = any(voice_paths) or bgm_path is not None
            parts: list[Path] = []
            if opt.title.strip():
                tcard = tmp_dir / "title.mp4"
                await _gen_card(opt.title, dims, opt.fps, _TITLE_SEC, film_has_audio, tcard)
                parts.append(tcard)
            parts.append(film_path)
            if opt.credits.strip():
                ccard = tmp_dir / "credits.mp4"
                await _gen_card(opt.credits, dims, opt.fps, _CREDITS_SEC, film_has_audio, ccard)
                parts.append(ccard)
            await _concat_parts(parts, opt.fps, film_has_audio, out_path)

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="合成产物为空")

    return AssembleResponse(url=f"/api/manju/output/{name}", name=name)


@router.get("/manju/output/{name}")
async def get_manju_output(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _OUTPUT_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _OUTPUT_DIR / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ── KenBurns 运镜:静图 → 带推拉/平移的动态片段(免 GPU)─────────────────
# 给「只出图、没转视频」的镜一个轻量动态选项;产物同源(/api/manju/output/{name}),
# 可直接作为某镜 videoUrl 喂回 /manju/assemble 拼进成片。
_KEN_MOTIONS = {"zoom-in", "zoom-out", "pan-left", "pan-right", "pan-up", "pan-down"}


class KenBurnsRequest(BaseModel):
    image_url: str = Field(min_length=1, max_length=2000)
    duration: float = Field(default=3.0, ge=1.0, le=12.0)
    motion: str = Field(default="zoom-in")
    width: int = Field(default=832, ge=64, le=2048)
    height: int = Field(default=480, ge=64, le=2048)
    fps: int = Field(default=30, ge=8, le=60)


class KenBurnsResponse(BaseModel):
    url: str
    name: str


def _kenburns_filter(motion: str, frames: int, width: int, height: int, fps: int) -> str:
    """zoompan 表达式:on=输出帧序;先 2× 预放大降抖动,再 zoom/pan 到目标尺寸。"""
    n = max(frames - 1, 1)
    cx = "iw/2-(iw/zoom/2)"
    cy = "ih/2-(ih/zoom/2)"
    if motion == "zoom-out":
        z, x, y = f"1.18-0.18*on/{n}", cx, cy
    elif motion == "pan-right":
        z, x, y = "1.12", f"(iw-iw/zoom)*on/{n}", cy
    elif motion == "pan-left":
        z, x, y = "1.12", f"(iw-iw/zoom)*(1-on/{n})", cy
    elif motion == "pan-up":
        z, x, y = "1.12", cx, f"(ih-ih/zoom)*(1-on/{n})"
    elif motion == "pan-down":
        z, x, y = "1.12", cx, f"(ih-ih/zoom)*on/{n}"
    else:  # zoom-in(默认)
        z, x, y = f"1+0.18*on/{n}", cx, cy
    pre_w, pre_h = width * 2, height * 2
    return (
        f"scale={pre_w}:{pre_h}:force_original_aspect_ratio=increase,"
        f"crop={pre_w}:{pre_h},"
        f"zoompan=z='{z}':x='{x}':y='{y}':d={frames}:s={width}x{height}:fps={fps},"
        f"format=yuv420p"
    )


@router.post("/manju/kenburns", response_model=KenBurnsResponse)
async def manju_kenburns(
    body: KenBurnsRequest,
    user: User = Depends(get_current_user),
) -> KenBurnsResponse:
    enforce_generation_rate_limit(user)
    if body.motion not in _KEN_MOTIONS:
        raise HTTPException(status_code=422, detail="未知的运镜类型")
    if not _is_allowed_clip(body.image_url):
        raise HTTPException(status_code=400, detail="图片来源不在白名单内")
    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")

    _OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    name = f"manju-{uuid.uuid4().hex}.mp4"
    out_path = _OUTPUT_DIR / name
    frames = max(1, round(body.duration * body.fps))

    with tempfile.TemporaryDirectory(prefix="manju-kb-") as tmp:
        img = Path(tmp) / "src"
        async with httpx.AsyncClient(
            timeout=_DOWNLOAD_TIMEOUT, follow_redirects=True, trust_env=False
        ) as client:
            await _download_clip(client, body.image_url, img)
        vf = _kenburns_filter(body.motion, frames, body.width, body.height, body.fps)
        cmd = [
            "ffmpeg", "-y", "-loop", "1", "-i", str(img),
            "-vf", vf, "-t", f"{body.duration}",
            "-c:v", "libx264", *_X264_ARGS, "-pix_fmt", "yuv420p", "-r", str(body.fps),
            "-movflags", "+faststart", str(out_path),
        ]
        await _run_ffmpeg(cmd)

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="运镜片段生成失败")

    return KenBurnsResponse(url=f"/api/manju/output/{name}", name=name)
