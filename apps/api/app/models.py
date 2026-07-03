"""多租户数据模型（SQLModel）。

Tenant 1—N User；Job 归属 Tenant + User，实现租户级隔离。
积分(credits)挂在 Tenant 上，作为配额/计费基础。
"""
from __future__ import annotations

import uuid
from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


def _uid() -> str:
    return uuid.uuid4().hex


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Tenant(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    name: str
    created_at: datetime = Field(default_factory=_now)


class User(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    email: str = Field(index=True, unique=True)
    hashed_password: str
    tenant_id: str = Field(foreign_key="tenant.id", index=True)
    role: str = "user"  # "user" | "admin"
    # R18 分区软开关:默认 False=SFW(无年龄确认弹窗)。关闭时服务端强制全分区过滤
    # 掉一切 NSFW 内容(成人底模 / 市场 NSFW / R18 作品);开启后方可进入 R18 区。
    nsfw_enabled: bool = False
    created_at: datetime = Field(default_factory=_now)


class Job(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    prompt_id: str
    worker: str
    kind: str = "txt2img"
    status: str = "queued"
    prompt: str = ""
    seed: int = 0
    nsfw: bool = False  # 该作品是否成人向(建档时由 checkpoint 是否 NSFW 决定)
    result: str = ""  # 完成后的产物 URL 列表(JSON)
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# 漫剧工作台(manju)—— 可追踪/可调整/可复用的 AI 漫剧生产流水线
# 项目(ManjuProject)1—N 资产(ManjuAsset)与镜头(ManjuShot)。
# 资产=可复用的角色/场景/道具/风格;镜头按 characters 引用资产名,改资产可全剧同步。
# ---------------------------------------------------------------------------


class ManjuProject(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    title: str = ""
    premise: str = ""  # 剧情/小说原文或梗概
    style: str = ""  # 整体画风(融入出图提示词)
    ckpt_name: str = ""  # 该项目固定的出图底模(保跨镜风格一致)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class ManjuAsset(SQLModel, table=True):
    """可复用资产:角色/场景/道具/风格。镜头按 name 引用,改资产可全剧同步。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    tenant_id: str = Field(index=True)
    kind: str = "character"  # character | scene | prop | style
    name: str = ""
    description: str = ""  # danbooru 标签风格的固定特征(发色/瞳色/服装等),保跨镜一致
    ref_image: str = ""  # 定妆图/三视图参考图 URL(角色一致性 IPAdapter 用)
    ref_audio: str = ""  # 定妆音色 URL(配音音色克隆参考,见 routes/voice.py)
    created_at: datetime = Field(default_factory=_now)


class ManjuShot(SQLModel, table=True):
    """分镜镜头:出图提示词 + 运动提示词 + 引用资产 + 关键帧/视频作业追踪。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    tenant_id: str = Field(index=True)
    idx: int = 0  # 镜序(0 起)
    scene: str = ""
    prompt: str = ""  # 出图提示词(danbooru 标签)
    motion: str = ""  # i2v 运动提示词
    characters: str = ""  # JSON 数组:本镜引用的角色资产名
    camera: str = ""
    dialogue: str = ""
    duration_sec: int = 3
    negative: str = ""  # AI 润色反向词(逐镜定制,须持久化否则重载丢)
    image_job_id: str = ""  # 关键帧作业 id(可追踪)
    video_job_id: str = ""  # 视频作业 id
    image_url: str = ""  # 已出关键帧 URL(持久化,否则保存重载后分镜图全丢)
    video_url: str = ""  # 已出视频 URL(持久化)
    voice_url: str = ""  # 配音 wav 的 URL(TTS 合成台词,见 routes/voice.py)
    speaker: str = ""  # 说话角色名(配音用其音色克隆;空=出场角色首位/兜底音)
    status: str = "draft"  # draft | image_done | video_done
    created_at: datetime = Field(default_factory=_now)
