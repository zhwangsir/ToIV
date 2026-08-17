"""短剧分镜 JSON Schema（Pydantic BaseModel）。

该模块被 novel_to_storyboard.py、config.py 和单元测试共用，
提供从 LLM 输出到结构化分镜的校验与序列化。
"""
from __future__ import annotations

from pathlib import Path
from pydantic import BaseModel, Field, field_validator


# 镜头类型建议值；schema 本身保留字符串以兼容 LLM 的创造性输出
SHOT_TYPE_VALUES = {"scene", "action", "dialogue", "transition", "close_up", "wide", "establishing"}


class Character(BaseModel):
    """短剧角色定义。"""

    name: str = Field(..., description="角色名（剧本内标识）")
    description: str = Field(..., description="角色外貌/性格/背景描述，用于视觉生成")
    voice_tag: str = Field(default="", description="TTS 音色标签或参考音标识")
    is_narrator: bool = Field(default=False, description="是否为旁白/解说角色")


class Dialogue(BaseModel):
    """单镜头内的对白。"""

    speaker: str = Field(..., description="说话角色名，对应 characters[].name 或 narrator")
    text: str = Field(..., description="对白原文")


class Shot(BaseModel):
    """单个分镜。"""

    id: str = Field(..., description="分镜唯一标识，如 s1_1、s2_3")
    act: int = Field(..., ge=1, description="所属幕/场编号")
    duration: float = Field(
        ..., gt=0, le=60, description="镜头时长（秒），建议 3–10s"
    )
    type: str = Field(
        default="scene",
        description="镜头类型：scene/action/dialogue/transition 等",
    )

    @field_validator("type")
    @classmethod
    def _normalize_type(cls, v: str) -> str:
        v = (v or "scene").strip().lower()
        # 若 LLM 给出非建议值，归一化为 scene，避免下游解析失败
        if v not in SHOT_TYPE_VALUES:
            return "scene"
        return v
    description: str = Field(..., description="镜头中文内容描述，用于人工审阅")
    prompt: str = Field(
        ..., description="英文视觉提示词，直接用于文生视频/图生视频模型"
    )
    motion_prompt: str = Field(
        default="",
        description="英文镜头运动/动作描述，补充视频动态",
    )
    characters: list[str] = Field(
        default_factory=list,
        description="本镜出场角色名列表",
    )
    dialogue: Dialogue | None = Field(
        default=None,
        description="本镜对白（可选）；也可在 narration 时间轴统一维护",
    )
    negative: str = Field(
        default="blurry, low quality, text, watermark, deformed, extra limbs",
        description="负面提示词",
    )

    @field_validator("id")
    @classmethod
    def _id_non_empty(cls, v: str) -> str:
        if not v or not v.strip():
            raise ValueError("shot id cannot be empty")
        return v.strip()


class NarrationCue(BaseModel):
    """旁白/对白时间轴条目。"""

    start: float = Field(..., ge=0, description="开始时间（秒）")
    end: float = Field(..., gt=0, description="结束时间（秒）")
    speaker: str = Field(..., description="说话角色名或 narrator")
    text: str = Field(..., description="该时间段内的台词/旁白文本")

    @field_validator("end")
    @classmethod
    def _end_after_start(cls, v: float, info) -> float:
        start = info.data.get("start")
        if start is not None and v <= start:
            raise ValueError("end must be greater than start")
        return v


class Storyboard(BaseModel):
    """完整分镜脚本。"""

    title: str = Field(..., description="短剧标题")
    characters: list[Character] = Field(
        default_factory=list, description="角色列表"
    )
    shots: list[Shot] = Field(
        default_factory=list, description="分镜数组"
    )
    narration: list[NarrationCue] = Field(
        default_factory=list, description="旁白/对白时间轴"
    )

    def to_json_file(self, path: str | Path) -> Path:
        """序列化到 JSON 文件（UTF-8，2 空格缩进）。"""
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(self.model_dump_json(indent=2, ensure_ascii=False), encoding="utf-8")
        return p

    @classmethod
    def from_dict(cls, data: dict) -> "Storyboard":
        return cls.model_validate(data)

    @classmethod
    def from_json_file(cls, path: str | Path) -> "Storyboard":
        return cls.model_validate_json(Path(path).read_text(encoding="utf-8"))
