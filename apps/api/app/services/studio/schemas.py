"""Studio 模块请求/响应 DTO。"""
from __future__ import annotations

import logging

from pydantic import BaseModel, Field, ValidationInfo, field_validator

logger = logging.getLogger(__name__)

_VALID_RENDER_MODES = {"video", "image_motion"}


def fold_character_name(name: str) -> str:
    """角色名归一化(去全部空白 + casefold),供大小写/空白近匹配比较。"""
    return "".join(name.split()).casefold()


def _stripped_str(v: object) -> str:
    """字段级规整:任意输入 str() 化并去空白(None/0/False 等 falsy → "")。"""
    return str(v or "").strip()


def reconcile_character_names(
    names: list[str],
    context: object,
    *,
    log: logging.Logger | None = None,
) -> list[str]:
    """按 pydantic validation_context 校验/纠正角色名(链 A drama / 链 B studio 共用)。

    参照 DramaClaw literal_script_writing 的 validation_context 设计:把「只用既有
    角色名」从 prompt 恳求变为 schema 侧约束,但兼容 ToIV 既有「新角色自动建行」
    特性——全新名字放行并记录,不打回。

    context 约定(dict):
      - "valid_character_names": list[str] —— 既有合法角色名集合;**键不存在** 表示
        校验未启用,原样放行(兼容 grid/from-image 等未注入 roster 的拆解链)。
      - "new_characters": list[str] —— 可选收集桶,全新名字就地追加(调用方走
        既有自动建行路径),不阻断拆解。

    策略:① 精确命中 → 通过;② 大小写/空白近匹配 → 自动纠正为集合内名字;
    ③ 全新名字 → 放行并记录。纠正与新名全程 logger.info 留痕。
    """
    lg = log or logger
    ctx = context if isinstance(context, dict) else {}
    if "valid_character_names" not in ctx:
        return names  # 未注入合法集合 → 校验未启用,原样放行(旧行为)
    valid = [
        n for n in (ctx.get("valid_character_names") or [])
        if isinstance(n, str) and n.strip()
    ]
    valid_set = set(valid)
    folded = {fold_character_name(n): n for n in valid}
    new_bucket = ctx.get("new_characters")
    out: list[str] = []
    for name in names:
        if name in valid_set:
            out.append(name)  # ① 精确命中
            continue
        hit = folded.get(fold_character_name(name))
        if hit is not None:
            # ② 大小写/空白近匹配 → 自动纠正为集合内名字
            lg.info("角色名近匹配自动纠正: %r → %r", name, hit)
            out.append(hit)
            continue
        # ③ 全新名字:放行并记录,走既有自动建行/确认路径,不阻断
        lg.info("角色名 %r 不在合法集合,按新角色放行", name)
        if isinstance(new_bucket, list) and name not in new_bucket:
            new_bucket.append(name)
        out.append(name)
    return out


class CharacterDraft(BaseModel):
    """LLM 拆解产出的角色草稿。"""

    name: str = ""
    description: str = ""
    visual_prompt: str = ""

    @field_validator("name", mode="before")
    @classmethod
    def _normalize_name(cls, v: object, info: ValidationInfo) -> str:
        name = _stripped_str(v)
        if not name:
            return ""
        # context 注入 valid_character_names 时对齐既有角色(近匹配纠正/新名记录)
        return reconcile_character_names([name], info.context)[0]

    @field_validator("description", "visual_prompt", mode="before")
    @classmethod
    def _normalize_str(cls, v: object) -> str:
        return _stripped_str(v)


class ShotDraft(BaseModel):
    """LLM 拆解产出的分镜草稿。"""

    scene: str = ""
    prompt: str = ""
    negative: str = ""
    camera: str = ""
    dialogue: str = ""
    speaker: str = ""
    duration_sec: int = 6
    characters: list[str] = Field(default_factory=list)
    render_mode: str = "video"  # video | image_motion

    @field_validator(
        "scene", "prompt", "negative", "camera", "dialogue", "speaker", mode="before"
    )
    @classmethod
    def _normalize_str(cls, v: object) -> str:
        return _stripped_str(v)

    @field_validator("duration_sec", mode="before")
    @classmethod
    def _clamp_duration(cls, v: object) -> int:
        # 等价旧 _coerce_shot:非数字回退 6,再钳制 [1,60]
        try:
            d = int(v or 6)
        except (ValueError, TypeError):
            d = 6
        return max(1, min(60, d))

    @field_validator("render_mode", mode="before")
    @classmethod
    def _normalize_mode(cls, v: object) -> str:
        # 非法/缺省回退 video 链(与旧 _coerce_shot 一致)
        mode = _stripped_str(v)
        return mode if mode in _VALID_RENDER_MODES else "video"

    @field_validator("characters", mode="before")
    @classmethod
    def _normalize_characters(cls, v: object, info: ValidationInfo) -> list[str]:
        if not isinstance(v, list):
            return []
        names = [s for s in (_stripped_str(c) for c in v) if s]
        # context 注入 valid_character_names 时按合法集合校验/纠正
        return reconcile_character_names(names, info.context)


class ScriptParseResponse(BaseModel):
    characters: list[CharacterDraft]
    shots: list[ShotDraft]


class ProjectCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    premise: str = Field(default="", max_length=20000)
    style: str = Field(default="", max_length=2000)
    ckpt_name: str = Field(default="", max_length=512)
    render_mode_default: str = Field(default="video", pattern="^(video|image_motion)$")
    # 产出规格:视频/图像运镜两链共用;8 对齐(前端预设均为 32 对齐,LTX 兼容)
    # 宽高上限对称 1920:竖屏短剧(如 720×1280)需要 height > 1080
    width: int = Field(default=768, ge=256, le=1920, multiple_of=8)
    height: int = Field(default=384, ge=256, le=1920, multiple_of=8)
    fps: int = Field(default=16, ge=4, le=30)


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    premise: str | None = Field(default=None, max_length=20000)
    style: str | None = Field(default=None, max_length=2000)
    ckpt_name: str | None = Field(default=None, max_length=512)
    render_mode_default: str | None = Field(default=None, pattern="^(video|image_motion)$")
    status: str | None = Field(default=None, max_length=32)
    width: int | None = Field(default=None, ge=256, le=1920, multiple_of=8)
    height: int | None = Field(default=None, ge=256, le=1920, multiple_of=8)
    fps: int | None = Field(default=None, ge=4, le=30)


class CharacterCreate(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    description: str = Field(default="", max_length=2000)
    visual_prompt: str = Field(default="", max_length=2000)


class CharacterPatch(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=2000)
    visual_prompt: str | None = Field(default=None, max_length=2000)
    voice_ref_url: str | None = Field(default=None, max_length=1024)


class ShotInput(BaseModel):
    """批量保存分镜的单条输入(无 id = 新增,有 id = 更新)。"""

    id: str | None = None
    scene: str = Field(default="", max_length=2000)
    prompt: str = Field(default="", max_length=4000)
    negative: str | None = Field(default=None, max_length=2000)
    camera: str = Field(default="", max_length=200)
    dialogue: str = Field(default="", max_length=2000)
    speaker: str = Field(default="", max_length=100)
    duration_sec: int = Field(default=6, ge=1, le=60)
    characters: list[str] = Field(default_factory=list)
    render_mode: str = Field(default="video", pattern="^(video|image_motion)$")


class ShotsSaveRequest(BaseModel):
    shots: list[ShotInput]


class ScriptParseRequest(BaseModel):
    premise: str = Field(min_length=1, max_length=20000)
    num_shots: int = Field(default=8, ge=1, le=50)
    style: str = Field(default="", max_length=2000)
