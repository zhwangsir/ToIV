"""多租户数据模型（SQLModel）。

Tenant 1—N User；Job 归属 Tenant + User，实现租户级隔离。
积分(credits)挂在 Tenant 上，作为配额/计费基础。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional

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
    # 出生日期(可选,空=未填写)。用于未成年防护硬阻断:nsfw_allowed 与
    # /account/nsfw 开关均会校验,未成年一律不可见 R18。空视为成年以兼容老数据。
    birthdate: Optional[date] = Field(default=None, index=True)
    # 当前默认智能体 id(顶栏全局默认;为空=走 kind 默认系统提示)。见 Agent 表。
    # 外键不强制(删除 agent 时此处自然失效, optimize 端兜底为 kind 默认)。
    default_agent_id: Optional[str] = Field(default=None)
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
    # —— 版本树(精修迭代地基):每次生成挂到父版本,同链共根 ——
    parent_id: str = ""  # 父版本 Job.id(空=无父,自身即根)
    root_id: str = ""  # 版本树根 Job.id(空=自身即根;查链用 root_id or id)
    params: str = ""  # 建档时完整请求快照(JSON),支撑精确重生/锁seed微调/分支
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


# ---------------------------------------------------------------------------
# LoRA 训练作业(D 期)—— 用户上传样本 → 自动打标 → 训练 → 注册进模型库
# ---------------------------------------------------------------------------


class TrainJob(SQLModel, table=True):
    """LoRA 训练作业。训完的 LoRA 落 NAS loras/，自动注册进 model_profiles。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    name: str = ""  # 用户起的训练名(也作 LoRA 文件名)
    base_ckpt: str = ""  # 底模文件名(决定训练后端:flux2/qwen/z_image→AI-Toolkit, sdxl→Kohya)
    dataset_dir: str = ""  # 数据集目录(NAS 路径)
    trigger_words: str = ""  # 触发词
    # 训练超参(有合理默认,前端高级折叠)
    lr: float = 1e-4
    steps: int = 1000
    network_dim: int = 16
    network_alpha: int = 16
    resolution: int = 1024
    batch_size: int = 1
    cuda_device: int = 0  # 用哪张卡训练
    # 运行态
    worker: str = ""  # 训练用 worker URL(用于 pool.mark_busy)
    trainer_job_id: str = ""  # trainer agent 侧的作业 id
    status: str = "queued"  # queued|captioning|training|sampling|done|error
    progress: str = ""  # JSON: {step,total,loss,recent_losses:[]}
    lora_path: str = ""  # 训练完 LoRA 文件 NAS 路径
    sample_urls: str = ""  # 验证样本 URL(JSON)
    error: str = ""  # 失败原因
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# 智能体(Agent)—— 提示词优化系统的人格预设
# 内置 11 个种子 + 用户自定义 CRUD。优化提示词时按所选智能体的 system_prompt
# 主人格 + 原 kind 系统提示(含模型族方言)组合调 LLM,产出不同风格的提示词。
# ---------------------------------------------------------------------------


class Agent(SQLModel, table=True):
    """提示词优化智能体:绑定一个 system_prompt 主人格,优化时拼接在 kind 系统提示前。

    applies_to 为逗号分隔串(如 "image,video" / "all" / "audio" / "train"),
    含 "all" 表示适用所有 kind。is_nsfw=True 的智能体仅 R18 鉴权用户可见。
    """

    id: str = Field(primary_key=True)  # 'realist' / 'cinematographer' ...
    name: str
    description: str = ""  # 一句话简介
    icon: str = "sparkles"  # lucide-react 图标名
    applies_to: str = "all"  # 'all' / 'image,video' / 'audio' / 'train'
    system_prompt: str  # 主人格 system prompt
    is_nsfw: bool = False
    is_builtin: bool = False  # 内置种子:可改不可删
    llm_model_override: Optional[str] = Field(default=None)  # 绑定特定 LLM(None=走全局)
    sort: int = 100
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
