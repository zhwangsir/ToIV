"""H3 多镜头单次生成协议 —— N 个镜头按「镜头一…镜头二…」组装为单段 H3 prompt。

对标 Vidu Q3 单 prompt 多镜头 / PixVerse MultiShot:一次提交、单段视频内自动切镜,
不同镜头内容按指定顺序连贯生成(H3 原生音画直出,单段上限 15s@24fps)。

分层(与 services/duration、services/keyframe_chain 同一风格):
  · 纯函数层(validate_multishot / plan_multishot / build_multishot_prompt):
    不做 IO、不依赖 fastapi/DB,方便全矩阵单测;非法输入抛 MultiShotError(路由层转 422)
  · MultiShotPlan.to_prompt():按 h3-prompt-writer 正典组装单段提示词
    (全正向、「生成一段…秒」开头、时间段无缺口覆盖、镜头切换关键词连接)

协议规则(正典来源:skills/h3-prompt-writer):
  · 镜头编号用中文数字(镜头一/镜头二/镜头三/镜头四)
  · 每镜头描述包含:主体+动作+场景(+可选运镜提示,拼在镜头描述末尾)
  · 镜头间用「镜头切换:硬切|淡入淡出|匹配切口」连接(未指定默认硬切;
    transition_hint 挂在被进入的镜头上,首镜头忽略)
  · 总时长按镜头数均分(duration_sec 全空 + 显式 total_duration)或逐镜头自定义

与关键帧链式转场正交:多镜头 = 单段内切镜(一次 ComfyUI 提交);关键帧链 = 多段独立
转场拼接。与 drama_studio 分镜线独立:多镜头是单 prompt 协议,drama 是分镜表驱动。
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any

MIN_SHOTS = 2
MAX_SHOTS = 4
MIN_SHOT_SEC = 2.0
MAX_TOTAL_SEC = 15.0  # H3 单段上限(17k+5 网格 362 帧@24fps≈15.1s)
DEFAULT_FPS = 24

# 运镜提示白名单(可选;拼在镜头描述末尾,全正向表述)
CAMERA_HINTS: dict[str, str] = {
    "推": "镜头缓慢推近",
    "拉": "镜头缓慢拉远",
    "摇": "摇镜",
    "移": "镜头平移",
    "跟": "镜头跟随主体移动",
    "固定": "固定机位",
}

# 转场提示白名单(可选;挂在被进入的镜头上,首镜头忽略;未指定默认硬切)
TRANSITION_HINTS: dict[str, str] = {
    "硬切": "硬切",
    "淡入淡出": "淡入淡出",
    "匹配切口": "匹配切口",
}

DEFAULT_TRANSITION = "硬切"

# 镜头编号:中文数字(协议硬性要求,最多四镜)
_CN_NUMERALS = ("一", "二", "三", "四")
# 片头总数计数:量词句用「两」(共两个镜头,非「共二个」)
_CN_COUNTERS = ("一", "两", "三", "四")


class MultiShotError(ValueError):
    """多镜头计划参数非法(路由层转 422)。"""


@dataclass(frozen=True)
class ShotSpec:
    """单镜头规格。

    duration_sec 为 None 表示参与均分(须全部镜头都留空并显式给 total_duration);
    transition_hint 描述本镜头相对上一镜头的进入方式(首镜头忽略)。
    """

    prompt: str
    duration_sec: float | None = None
    camera_hint: str | None = None
    transition_hint: str | None = None


@dataclass(frozen=True)
class MultiShotPlan:
    """完整多镜头计划:shots 已按序解析出非空 duration_sec;total_duration 为各镜头之和。"""

    shots: tuple[ShotSpec, ...]
    total_duration: float
    fps: int
    width: int
    height: int
    seed: int | None

    def to_prompt(self) -> str:
        """按「镜头一…镜头二…」协议组装单段 H3 提示词(全正向,无缺口时间线)。"""
        aspect = "16:9" if self.width >= self.height else "9:16"
        n = len(self.shots)
        lines = [
            f"生成一段{self.total_duration:g}秒、{aspect}、原生立体声视频,"
            f"全片共{_CN_COUNTERS[n - 1]}个镜头,按镜头顺序连续呈现;"
            f"镜头之间主体、服装、场景与叙事保持连贯,每个镜头完整进入成片。"
        ]
        for i, shot in enumerate(self.shots):
            if i > 0:
                transition = TRANSITION_HINTS.get(shot.transition_hint or "", DEFAULT_TRANSITION)
                lines.append(f"镜头切换:{transition}。")
            desc = shot.prompt.strip().rstrip("。")
            camera = CAMERA_HINTS.get(shot.camera_hint or "")
            if camera:
                desc = f"{desc},{camera}"
            lines.append(f"镜头{_CN_NUMERALS[i]}(约{shot.duration_sec:g}秒):{desc}。")
        return "\n".join(lines)

    def to_params(self) -> dict[str, Any]:
        """Job.params 多镜头计划快照(排查/精确重生的事实源)。"""
        return {
            "shots": [
                {
                    "prompt": s.prompt,
                    "duration_sec": s.duration_sec,
                    "camera_hint": s.camera_hint,
                    "transition_hint": s.transition_hint,
                }
                for s in self.shots
            ],
            "total_duration": self.total_duration,
            "fps": self.fps,
            "width": self.width,
            "height": self.height,
            "seed": self.seed,
        }


def _cn_num(n: int) -> str:
    """1-4 → 中文数字(协议编号/总数均用中文)。"""
    if not (1 <= n <= len(_CN_NUMERALS)):
        raise MultiShotError(f"镜头数超出协议范围(1-{len(_CN_NUMERALS)})")
    return _CN_NUMERALS[n - 1]


def _validate_hints(shots: list[ShotSpec] | tuple[ShotSpec, ...]) -> None:
    for i, s in enumerate(shots):
        if s.camera_hint is not None and s.camera_hint not in CAMERA_HINTS:
            raise MultiShotError(
                f"镜头{_CN_NUMERALS[i + 1]}运镜提示须为:{'/'.join(CAMERA_HINTS)}(当前「{s.camera_hint}」)"
            )
        if s.transition_hint is not None and s.transition_hint not in TRANSITION_HINTS:
            raise MultiShotError(
                f"镜头{_CN_NUMERALS[i + 1]}转场提示须为:{'/'.join(TRANSITION_HINTS)}(当前「{s.transition_hint}」)"
            )


def _resolve_durations(
    shots: list[ShotSpec] | tuple[ShotSpec, ...], total_duration: float | None
) -> list[float]:
    """逐镜头时长:全部自定义(各 ≥2s,总长 ≤15s)或全部留空按 total_duration 均分。

    混合(部分给部分不给)语义歧义,直接报错。
    """
    n = len(shots)
    given = [s.duration_sec for s in shots]
    if all(d is None for d in given):
        if total_duration is None:
            raise MultiShotError(
                "镜头时长全部留空时须显式给 total_duration(按镜头数均分)"
            )
        total = float(total_duration)
        each = round(total / n, 2)
        out = [each] * n
    elif any(d is None for d in given):
        raise MultiShotError("镜头时长须全部给出(自定义)或全部留空(均分),不能混合")
    else:
        out = [float(d) for d in given if d is not None]
        total = sum(out)
    for i, d in enumerate(out):
        if d < MIN_SHOT_SEC:
            raise MultiShotError(
                f"每镜头时长须 ≥{MIN_SHOT_SEC:g} 秒(镜头{_CN_NUMERALS[i + 1]}当前 {d:g} 秒)"
            )
    if total > MAX_TOTAL_SEC:
        raise MultiShotError(
            f"多镜头总时长最长 {MAX_TOTAL_SEC:g} 秒(H3 单段上限,当前 {total:g} 秒),"
            "请缩短各镜头时长"
        )
    return out


def validate_multishot(
    shots: list[ShotSpec] | tuple[ShotSpec, ...],
    total_duration: float | None = None,
) -> None:
    """校验多镜头计划;非法抛 MultiShotError(2-4 镜头/每镜头 ≥2s/总长 ≤15s/提示白名单)。"""
    plan_multishot(shots, total_duration=total_duration)


def plan_multishot(
    shots: list[ShotSpec] | tuple[ShotSpec, ...],
    *,
    total_duration: float | None = None,
    fps: int = DEFAULT_FPS,
    width: int = 1344,
    height: int = 768,
    seed: int | None = None,
) -> MultiShotPlan:
    """把 N 个镜头规格解析为完整计划(时长均分/自定义归一 + 全量校验)。"""
    n = len(shots)
    if not (MIN_SHOTS <= n <= MAX_SHOTS):
        raise MultiShotError(f"镜头数须为 {MIN_SHOTS}-{MAX_SHOTS} 个(当前 {n} 个)")
    if any(not s.prompt.strip() for s in shots):
        raise MultiShotError("每镜头提示词不能为空")
    _validate_hints(shots)
    durations = _resolve_durations(shots, total_duration)
    resolved = tuple(
        ShotSpec(
            prompt=s.prompt.strip(),
            duration_sec=durations[i],
            camera_hint=s.camera_hint,
            transition_hint=s.transition_hint,
        )
        for i, s in enumerate(shots)
    )
    return MultiShotPlan(
        shots=resolved,
        total_duration=round(sum(durations), 2),
        fps=fps,
        width=width,
        height=height,
        seed=seed,
    )


def build_multishot_prompt(
    shots: list[ShotSpec] | tuple[ShotSpec, ...],
    *,
    total_duration: float | None = None,
    fps: int = DEFAULT_FPS,
    width: int = 1344,
    height: int = 768,
    seed: int | None = None,
) -> str:
    """校验并组装单段 H3 多镜头提示词(等价 plan_multishot(...).to_prompt())。"""
    return plan_multishot(
        shots, total_duration=total_duration, fps=fps, width=width, height=height, seed=seed
    ).to_prompt()
