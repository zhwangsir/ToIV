"""DramaClaw 借鉴 #4:颜色标记草图在场校验(color-marked sketch presence check)。

思路来源:DramaClaw 的 sketch_color_detector + EpisodeOptimizer.assign_sketch_colors
——给每个角色分配一个高饱和标记色,让 t2i 模型把角色画成纯色火柴人,
事后用颜色检测核对「期望在场的角色是否真的画出来了」。
本模块按其思路适配 ToIV drama studio(不照抄):
  · 调色板重新设计为色相环 12 等分全饱和色,保证 RGB 空间两两可分离(见 PALETTE 注释);
  · 检测从 HSV 容差改为 RGB 欧氏距离 + 5bit 量化记忆化(纯 PIL,无 numpy 依赖);
  · 新增宫格面板切分与 2D 布局分带(位置感知)校验,对接 scene_layout 的 x 坐标。

下游用途:
  1. grid-storyboard / scene-layout 生成时把颜色指令注入 prompt(color_mark=True);
  2. POST /drama/projects/{pid}/presence-check 事后检测在场/缺失/意外角色并落库。
"""
from __future__ import annotations

import io
import logging
from urllib.parse import parse_qs, urlsplit

from PIL import Image

from app.comfy.client import ComfyUIError
from app.deps import resolve_worker

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 调色板:色相环 0°~330° 每 30° 一色,全饱和全明度(S=1,V=1)。
# 相邻色 RGB 欧氏距离 ≈127~128(单通道差 127/128),非相邻更远,
# 即任意两色距离 > 2 × distance_threshold(默认 60),
# 所以一个像素不可能同时命中两个目标色——检测无串色,这是相对 DramaClaw
# 荧光调色板(#00FFCC 与 #00FFFF 距离仅 51,阈值 60 下会互相污染)的关键修正。
# ---------------------------------------------------------------------------
PALETTE: list[tuple[str, str, str]] = [
    # (hex, 英文名(prompt 用), 中文名(UI 展示用))
    ("#FF0000", "bright red", "亮红"),
    ("#FF8000", "bright orange", "亮橙"),
    ("#FFFF00", "bright yellow", "明黄"),
    ("#80FF00", "lime green", "嫩芽绿"),
    ("#00FF00", "bright green", "纯绿"),
    ("#00FF80", "spring green", "春绿"),
    ("#00FFFF", "cyan", "青色"),
    ("#0080FF", "azure blue", "天蓝"),
    ("#0000FF", "blue", "纯蓝"),
    ("#8000FF", "violet", "紫罗兰"),
    ("#FF00FF", "magenta", "品红"),
    ("#FF0080", "rose pink", "玫红"),
]

_HEX_TO_EN = {hex_: en for hex_, en, _ in PALETTE}
_HEX_TO_CN = {hex_: cn for hex_, _, cn in PALETTE}

# 检测前降采样上限:覆盖率 = 命中像素/总像素,缩放后比例基本不变;
# 384² 配合 5bit 量化记忆化,1024² 原图检测实测 < 200ms。
_ANALYSIS_MAX_DIM = 384

# 近似无彩色(白底/黑线/灰面)快速排除阈值:max(r,g,b)-min(r,g,b) 低于此值
# 不可能是标记色(DramaClaw 教训:草图白底与灰线占绝大多数像素,先排除省时)。
_ACHROMATIC_DIFF = 30


def assign_character_colors(names: list[str]) -> dict[str, str]:
    """为角色名确定性分配标记色:按名字排序后取模,跨调用/跨端点稳定。

    同名集合任意顺序传入结果一致;角色数 > 12 时颜色复用(取模),
    串色风险由调用方接受(drama 项目角色通常 ≤ 8)。
    """
    ordered = sorted(n for n in names if n)
    return {name: PALETTE[i % len(PALETTE)][0] for i, name in enumerate(ordered)}


def color_english_name(hex_color: str) -> str:
    return _HEX_TO_EN.get(hex_color.upper(), hex_color)


def color_mark_prompt_suffix(color_map: dict[str, str]) -> str:
    """拼颜色标记 prompt 片段:要求模型画线稿草图 + 白底 + 纯色火柴人。

    颜色用英文名(模型理解更稳),角色名原样保留(中英兼容)。
    """
    pairs = ", ".join(
        f"{name}→{color_english_name(hex_)}" for name, hex_ in color_map.items()
    )
    return (
        ", line-art storyboard sketch, white background, "
        "each character drawn as a solid flat-colored stick figure: " + pairs
    )


def _hex_to_rgb(hex_color: str) -> tuple[int, int, int]:
    h = hex_color.lstrip("#")
    return int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)


def _open_rgb(image_bytes: bytes) -> Image.Image:
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    longest = max(w, h)
    if longest > _ANALYSIS_MAX_DIM:
        scale = _ANALYSIS_MAX_DIM / longest
        img = img.resize(
            (max(1, round(w * scale)), max(1, round(h * scale))), Image.BILINEAR
        )
    return img


def detect_character_presence(
    image_bytes: bytes,
    color_map: dict[str, str],
    *,
    min_coverage: float = 0.002,
    distance_threshold: int = 60,
) -> dict[str, dict]:
    """检测图片中各角色标记色的在场情况(纯函数,纯 PIL 实现)。

    Args:
        image_bytes: 图片字节(PNG/JPEG 均可,PIL 解码)
        color_map: {角色名: "#RRGGBB"}(assign_character_colors 的输出)
        min_coverage: 在场判定覆盖率下限(命中像素/总像素)。默认 0.002(0.2%):
            DramaClaw 用 0.8%,但那是 HSV 宽容差(色相 ±25°)下的防误报阈值;
            本实现调色板两两距离 > 2×distance_threshold,无串色,误报主要来自
            压缩噪点(离散分布难成规模),故可放宽到 0.2% 以降低漏报
            (1024² 原图约对应一个 45×45 色块,小尺寸火柴人躯干可稳定命中)。
        distance_threshold: RGB 欧氏距离容差。默认 60 的依据:
            草图实画颜色会偏淡/偏深 + JPEG/缩放伪影(实测偏移多在 10~40),
            60 能容忍这些偏移;同时 < 调色板最小两两距离(127)的一半,
            保证任何像素至多命中一个目标色,宁可漏检边缘像素也不串色。

    Returns:
        {角色名: {"present": bool, "coverage": float, "color": "#RRGGBB"}}
    """
    img = _open_rgb(image_bytes)
    w, h = img.size
    total = w * h

    targets = [(name, _hex_to_rgb(hex_)) for name, hex_ in color_map.items()]
    counts = {name: 0 for name, _ in targets}
    thr2 = distance_threshold * distance_threshold

    # 5bit 量化记忆化:同图大量重复/相近像素,量化后键空间 ≤ 32768,
    # 每键只做一次 12 色距离计算,其余走 dict 命中,1024² 检测 < 200ms。
    # 量化误差每通道 ≤4,折合距离误差 ≤ ~12,相对阈值 60 可忽略。
    # (tobytes 逐字节迭代:getdata 在 Pillow 12 已标记弃用)
    memo: dict[int, str | None] = {}
    raw = img.tobytes()
    for i in range(0, len(raw), 3):
        r = raw[i]
        g = raw[i + 1]
        b = raw[i + 2]
        # 快速排除白底/黑线/灰面(草图占绝大多数)
        mx = r if r > g else g
        if b > mx:
            mx = b
        mn = r if r < g else g
        if b < mn:
            mn = b
        if mx - mn < _ACHROMATIC_DIFF:
            continue
        key = (r >> 3 << 10) | (g >> 3 << 5) | (b >> 3)
        hit = memo.get(key, 0)  # 0 = 未计算;None = 未命中
        if hit == 0:
            hit = None
            for name, (tr, tg, tb) in targets:
                dr = r - tr
                dg = g - tg
                db = b - tb
                if dr * dr + dg * dg + db * db <= thr2:
                    hit = name
                    break
            memo[key] = hit
        if hit is not None:
            counts[hit] += 1

    return {
        name: {
            "present": counts[name] / total >= min_coverage,
            "coverage": round(counts[name] / total, 6),
            "color": hex_,
        }
        for name, hex_ in color_map.items()
    }


def detect_grid_panels(image_bytes: bytes, grid_size: str | int) -> list[bytes]:
    """把宫格图均分为 N 个面板,返回按行优先(从左到右、从上到下)的面板字节列表。

    grid_size: "3x3" / "5x5" 字符串,或总格数 int(9→3x3、25→5x5,其余取平方上取整)。
    边缘余数像素归最后一行/列(与 DramaClaw 的整除切法等价,余数不足 1px 影响可忽略)。
    """
    if isinstance(grid_size, str):
        cols = int(grid_size.lower().split("x", 1)[0])
        rows = int(grid_size.lower().split("x", 1)[1])
    else:
        side = 1
        while side * side < int(grid_size):
            side += 1
        rows = cols = side

    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    w, h = img.size
    panel_w, panel_h = w // cols, h // rows
    panels: list[bytes] = []
    for r_idx in range(rows):
        for c_idx in range(cols):
            # 最后一行/列吃掉余数边缘,保证 panel 覆盖全图
            right = w if c_idx == cols - 1 else (c_idx + 1) * panel_w
            bottom = h if r_idx == rows - 1 else (r_idx + 1) * panel_h
            panel = img.crop((c_idx * panel_w, r_idx * panel_h, right, bottom))
            buf = io.BytesIO()
            panel.save(buf, format="PNG")
            panels.append(buf.getvalue())
    return panels


def check_regions(
    image_bytes: bytes,
    color_map: dict[str, str],
    actors: list[dict],
    *,
    band_half_width: float = 0.15,
    min_coverage: float = 0.002,
    distance_threshold: int = 60,
) -> dict[str, dict]:
    """位置感知校验:对照 2D 布局(scene_layout actors 的 x∈[0,1],左→右)分带检测。

    每个 actor 取画面 x±band_half_width 竖带(y 无则用全高),带内命中该 actor
    颜色 → "region"(位置命中);带内未命中但全图命中 → "elsewhere"(画出来了但
    位置不对);全图都未命中 → "missing"。
    带内覆盖率的分母是带内像素数(小区域更敏感,阈值语义与全图检测一致)。

    Returns:
        {actor名: {"status": "region"|"elsewhere"|"missing", "color": hex,
                   "region_coverage": float, "global_coverage": float}}
    """
    img = _open_rgb(image_bytes)
    w, h = img.size

    # 全图检测只做一次(各 actor 的 global_coverage 共用)
    global_result = detect_character_presence(
        image_bytes, color_map,
        min_coverage=min_coverage, distance_threshold=distance_threshold,
    )

    out: dict[str, dict] = {}
    for actor in actors:
        name = str(actor.get("name") or "").strip()
        if not name or name not in color_map:
            continue
        try:
            x = float(actor.get("x", 0.5))
        except (TypeError, ValueError):
            x = 0.5
        x = max(0.0, min(1.0, x))
        left = max(0, round((x - band_half_width) * w))
        right = min(w, round((x + band_half_width) * w))
        band = img.crop((left, 0, right, h))
        buf = io.BytesIO()
        band.save(buf, format="PNG")
        band_result = detect_character_presence(
            buf.getvalue(), {name: color_map[name]},
            min_coverage=min_coverage, distance_threshold=distance_threshold,
        )
        region_hit = band_result[name]["present"]
        global_hit = global_result[name]["present"]
        status = "region" if region_hit else ("elsewhere" if global_hit else "missing")
        out[name] = {
            "status": status,
            "color": color_map[name],
            "region_coverage": band_result[name]["coverage"],
            "global_coverage": global_result[name]["coverage"],
        }
    return out


# ---------------------------------------------------------------------------
# 产物图片字节获取(/api/images 同款韧性:主 worker + 同机 siblings 回退)
# ---------------------------------------------------------------------------
def parse_image_url(url: str) -> dict | None:
    """解析 /api/images?filename=..&subfolder=..&type=..&worker=.. 产物 URL。

    返回 {"filename","subfolder","type","worker"};非产物 URL/缺关键参数 → None。
    """
    if not url:
        return None
    parts = urlsplit(url)
    if not parts.path.endswith("/api/images"):
        return None
    qs = parse_qs(parts.query)
    filename = qs.get("filename", [""])[0]
    worker = qs.get("worker", [""])[0]
    if not filename or not worker:
        return None
    return {
        "filename": filename,
        "subfolder": qs.get("subfolder", [""])[0],
        "type": qs.get("type", ["output"])[0],
        "worker": worker,
    }


def _host(url: str) -> str:
    return urlsplit(url).hostname or url


async def fetch_product_image_bytes(
    pool,
    *,
    worker: str,
    filename: str,
    subfolder: str = "",
    type_: str = "output",
) -> bytes | None:
    """按 /api/images 路由同款逻辑取产物字节:resolve_worker(SSRF 白名单)主取,
    同机 siblings 共享输出目录作回退;全部失败返回 None(由调用方降级,不炸全局)。
    """
    primary = resolve_worker(worker)
    host = _host(primary.base_url)
    siblings = [
        c for c in pool.clients
        if _host(c.base_url) == host and c.base_url != primary.base_url
    ]
    for client in [primary, *siblings]:
        try:
            content, _ct = await client.get_image_bytes(filename, subfolder, type_)
            return content
        except ComfyUIError as e:
            logger.info("presence 取图失败(worker=%s): %s", client.base_url, e)
    return None
