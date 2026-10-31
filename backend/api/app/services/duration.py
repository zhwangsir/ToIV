"""统一生成时长策略层 —— 秒数 → 引擎帧计划(direct / trim / extend)。

背景(2026-08-16 时长按秒选择改造):此前各链路秒→帧换算在 6 处重复且超上限
行为不一(H3 硬 422、LTX 静默钳位)。本模块收敛为唯一事实源:

  · resolve_duration(engine, seconds, fps) → DurationPlan
      - direct:理想帧数在引擎 [min,max] 内,网格向上取整后秒差 ≤0.25s,直接生成
      - trim:网格帧对应秒数与请求差 >0.25s,生成后用 ffmpeg 精确裁到请求秒数
      - extend:理想帧数超单段上限,按 max 网格分段续写(末帧 i2v 链),拼好后精确裁剪;
               安全上限 extend_max_sec(H3 ≤60s),超出报错
      - 引擎不支持 extend(extend_max_sec=None)→ 超上限报错(调用方转 422)
  · snap_engine_frames / validate_engine_frames:drama 末帧续写链的网格取整/显式
    帧数校验也委托此处,消灭重复换算(行为口径与旧 _snap_*_length 完全一致)。

本模块为纯函数层:不做 IO、不依赖 fastapi/DB,方便全矩阵单测。
"""
from __future__ import annotations

import math
from dataclasses import dataclass, field

# 网格帧对应秒数与请求秒数之差超过该阈值时,生成后精确裁剪(strategy=trim)
TRIM_TOLERANCE_SEC = 0.25


class DurationLimitError(ValueError):
    """时长超引擎能力上限(路由层转 422;生成器层翻译为 error 文案)。"""


@dataclass(frozen=True)
class EngineDurationSpec:
    """单引擎时长约束。

    grid: (k, offset) → 合法帧数 = k*n + offset(如 H3 17k+5);None = 无网格。
    extend_max_sec: 分段续写安全上限(秒);None = 不支持 extend(超上限报错)。
    context_notice_frames: 超过该帧数时给「引擎自动上下文窗口」提示(LongCat)。
    """

    min_frames: int
    max_frames: int
    grid: tuple[int, int] | None
    default_fps: int
    extend_max_sec: float | None = None
    context_notice_frames: int | None = None


# 引擎时长约束表(与 engine_registry / 各 studio 路由同一事实源)
_ENGINE_SPECS: dict[str, EngineDurationSpec] = {
    # MiniMax H3:17k+5 ∈[22,362] @24fps(362≈15s)
    "h3": EngineDurationSpec(22, 362, (17, 5), 24, extend_max_sec=60.0),
    # LTX-2.3(NSFW/drama 续写段):8k+1 ∈[9,241];一期不支持 extend
    "ltx": EngineDurationSpec(9, 241, (8, 1), 16, extend_max_sec=None),
    # LongCat-Video:[17,961] 无网格(>241 自动上下文窗口);单镜头引擎不续写
    "longcat": EngineDurationSpec(17, 961, None, 16, extend_max_sec=None,
                                  context_notice_frames=241),
    # Wan2.2-Animate:4k+1 ∈[17,501]
    "animate": EngineDurationSpec(17, 501, (4, 1), 16, extend_max_sec=None),
    # Wan-Animate-2(原生节点 :8199):4k+1 ∈[17,501],与 v1 同一时序网格
    "animate2": EngineDurationSpec(17, 501, (4, 1), 16, extend_max_sec=None),
    # Wan2.1-VACE:4k+1 ∈[17,241]
    "vace": EngineDurationSpec(17, 241, (4, 1), 16, extend_max_sec=None),
    # LongCat-Avatar:4k+1 ∈[17,2500](图内多段,无需外层续写)
    "avatar": EngineDurationSpec(17, 2500, (4, 1), 25, extend_max_sec=None),
}


def engine_spec(engine: str) -> EngineDurationSpec:
    """取引擎时长约束;未知名称抛 ValueError。"""
    spec = _ENGINE_SPECS.get(engine)
    if spec is None:
        raise ValueError(f"未知时长引擎: {engine},可选: {sorted(_ENGINE_SPECS)}")
    return spec


def _snap_up(n: int, *, grid: tuple[int, int], lo: int, hi: int) -> int:
    """向上吸附最近合法网格帧并钳位 [lo, hi](hi 自身须在网格上)。"""
    k, offset = grid
    if n <= lo:
        return lo
    idx = -(-(n - offset) // k)  # ceil((n - offset) / k)
    return min(hi, max(lo, k * idx + offset))


def _snap_down(n: int, *, grid: tuple[int, int], lo: int, hi: int) -> int:
    """向下吸附最近合法网格帧并钳位 [lo, hi](与旧 drama _snap_*_length 同口径)。"""
    k, offset = grid
    n = max(lo, min(hi, n))
    return ((n - offset) // k) * k + offset


def snap_engine_frames(engine: str, n: int, *, direction: str = "up") -> int:
    """按引擎网格吸附帧数。direction="up"(时长解析默认)或 "down"(drama 续写段口径)。"""
    spec = engine_spec(engine)
    if spec.grid is None:
        return max(spec.min_frames, min(spec.max_frames, int(n)))
    if direction == "down":
        return _snap_down(int(n), grid=spec.grid, lo=spec.min_frames, hi=spec.max_frames)
    if direction == "up":
        return _snap_up(int(n), grid=spec.grid, lo=spec.min_frames, hi=spec.max_frames)
    raise ValueError(f"未知吸附方向: {direction}")


def validate_engine_frames(engine: str, v: int) -> str | None:
    """显式帧数校验:合法 → None;非法 → 人话错误文案(与旧 drama 422 文案一致)。"""
    spec = engine_spec(engine)
    k, offset = spec.grid if spec.grid else (1, 0)
    on_grid = spec.grid is None or (v - offset) % k == 0
    if on_grid and spec.min_frames <= v <= spec.max_frames:
        return None
    if engine == "h3":
        return "H3 length 必须为 17k+5 且 22-362(如 124/141/362)"
    if engine == "ltx":
        return "LTX length 必须为 8k+1 且 9-241(如 97/121/241)"
    if spec.grid is not None:
        return (
            f"帧数必须为 {spec.grid[0]}k+{spec.grid[1]} 且 "
            f"{spec.min_frames}-{spec.max_frames}"
        )
    return f"帧数必须在 {spec.min_frames}-{spec.max_frames} 之间"


@dataclass(frozen=True)
class DurationPlan:
    """时长解析结果。

    frames: 首段(direct/trim 即唯一段)帧数;segment_frames: 每段帧数(extend >1 段)。
    strategy: direct(直接生成)/ trim(生成后 ffmpeg 精确裁至 trim_to 秒)/
              extend(末帧续写多段,拼接后精确裁至 trim_to 秒)。
    notice: 人话提示(空串 = 无需提示);路由/生成器透出为 duration_notice。
    """

    engine: str
    seconds: float
    fps: int
    frames: int
    strategy: str = "direct"
    segments: int = 1
    segment_frames: tuple[int, ...] = field(default=())
    notice: str = ""
    trim_to: float | None = None


def _fmt_sec(v: float) -> str:
    """紧凑秒数显示(6.0 → "6",6.5 → "6.5")。"""
    return f"{v:g}"


def resolve_duration(engine: str, seconds: float, fps: int | None = None) -> DurationPlan:
    """秒数 → 引擎帧计划。超能力上限抛 DurationLimitError(调用方转 422 / error)。"""
    spec = engine_spec(engine)
    # None = 未指定 → 回退引擎默认帧率;显式传 0/负数 = 调用方错误,报错不静默回退
    # (路由层 fps 字段均有 ge≥4 约束,生产路径到不了此分支;策略层自身防御)
    fps_used = spec.default_fps if fps is None else int(fps)
    if fps_used <= 0:
        raise DurationLimitError("帧率必须大于 0")
    try:
        secs = float(seconds)
    except (TypeError, ValueError):
        raise DurationLimitError("时长必须大于 0 秒") from None
    if not math.isfinite(secs) or secs <= 0:
        raise DurationLimitError("时长必须大于 0 秒")

    ideal = max(1, round(fps_used * secs))
    max_sec = spec.max_frames / fps_used

    # ── 超单段上限:extend 或报错 ──
    if ideal > spec.max_frames:
        if spec.extend_max_sec is None:
            raise DurationLimitError(
                f"超过引擎单段上限 {spec.max_frames} 帧(约 {_fmt_sec(max_sec)} 秒),"
                "该引擎暂不支持自动分段续写,请缩短时长"
            )
        if secs > spec.extend_max_sec:
            raise DurationLimitError(
                f"最长支持 {_fmt_sec(spec.extend_max_sec)} 秒(分段续写安全上限),"
                f"当前请求 {_fmt_sec(secs)} 秒,请缩短时长"
            )
        # 按 max 网格分段,末段残量向上取整(多出的尾巴由最终裁剪削掉)
        n_full, rem = divmod(ideal, spec.max_frames)
        segs = [spec.max_frames] * n_full
        if rem:
            segs.append(snap_engine_frames(engine, rem, direction="up"))
        return DurationPlan(
            engine=engine,
            seconds=secs,
            fps=fps_used,
            frames=segs[0],
            strategy="extend",
            segments=len(segs),
            segment_frames=tuple(segs),
            notice=(
                f"超过单段上限(约 {_fmt_sec(max_sec)} 秒),已自动分 {len(segs)} 段续写,"
                f"生成后精确裁至 {_fmt_sec(secs)} 秒"
            ),
            trim_to=secs,
        )

    # ── 范围内:网格向上取整,秒差超阈值 → trim ──
    frames = snap_engine_frames(engine, ideal, direction="up")
    gen_sec = frames / fps_used
    if abs(gen_sec - secs) > TRIM_TOLERANCE_SEC:
        return DurationPlan(
            engine=engine,
            seconds=secs,
            fps=fps_used,
            frames=frames,
            strategy="trim",
            segment_frames=(frames,),
            notice=(
                f"引擎帧网格取整为 {frames} 帧(约 {gen_sec:.2f} 秒),"
                f"生成后精确裁至 {_fmt_sec(secs)} 秒"
            ),
            trim_to=secs,
        )

    # direct:LongCat 超上下文窗口给提示
    notice = ""
    if spec.context_notice_frames is not None and frames > spec.context_notice_frames:
        notice = (
            f"超过 {spec.context_notice_frames} 帧,引擎自动启用上下文窗口分段采样"
            "(长镜头连贯性由引擎保障)"
        )
    return DurationPlan(
        engine=engine,
        seconds=secs,
        fps=fps_used,
        frames=frames,
        strategy="direct",
        segment_frames=(frames,),
        notice=notice,
    )
