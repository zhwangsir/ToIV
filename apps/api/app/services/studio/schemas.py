"""Studio 模块请求/响应 DTO。"""
from __future__ import annotations

from pydantic import BaseModel, Field


class CharacterDraft(BaseModel):
    """LLM 拆解产出的角色草稿。"""

    name: str = ""
    description: str = ""
    visual_prompt: str = ""


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


class ScriptParseResponse(BaseModel):
    characters: list[CharacterDraft]
    shots: list[ShotDraft]


class ProjectCreate(BaseModel):
    title: str = Field(default="", max_length=200)
    premise: str = Field(default="", max_length=20000)
    style: str = Field(default="", max_length=2000)
    ckpt_name: str = Field(default="", max_length=512)
    render_mode_default: str = Field(default="video", pattern="^(video|image_motion)$")


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    premise: str | None = Field(default=None, max_length=20000)
    style: str | None = Field(default=None, max_length=2000)
    ckpt_name: str | None = Field(default=None, max_length=512)
    render_mode_default: str | None = Field(default=None, pattern="^(video|image_motion)$")
    status: str | None = Field(default=None, max_length=32)


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
