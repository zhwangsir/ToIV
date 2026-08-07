"""多租户数据模型（SQLModel）。

Tenant 1—N User；Job 归属 Tenant + User，实现租户级隔离。
积分(credits)挂在 Tenant 上，作为配额/计费基础。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel
from sqlalchemy import BigInteger


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
    seed: int = Field(default=0, sa_type=BigInteger)  # PG 须 BIGINT:种子上限 2**63-1(见 workflows/txt2img)
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
    updated_at: datetime = Field(default_factory=_now)


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



# ---------------------------------------------------------------------------
# 用户文档(文档上传与长文本理解)—— 原文/向量索引落盘(content_dir/docs/),
# 表内只存元数据;chunk+向量按文档存 JSON(services/docs.py)。
# ---------------------------------------------------------------------------


class Document(SQLModel, table=True):
    """用户上传的文档:按用户隔离,供对话挂载做 top-k 检索注入。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    filename: str = ""
    kind: str = ""  # pdf | docx | txt | md
    size: int = 0  # 原始字节数
    chunk_count: int = 0
    # ready=已索引;partial=超长截断(前 MAX_CHUNKS 块);no_embed=向量服务不可用(检索降级为空)
    status: str = "ready"
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# 短剧播放分析(Drama Analytics)
# ---------------------------------------------------------------------------

class DramaSession(SQLModel, table=True):
    """一次短剧播放会话。"""

    session_id: str = Field(primary_key=True)
    user_id: str = Field(index=True)
    drama_id: str = Field(index=True)
    video_url: str
    device_ua: str = ""
    device_screen: str = ""
    device_lang: str = ""
    device_platform: str = ""
    started_at: datetime = Field(default_factory=_now)
    ended_at: datetime | None = Field(default=None)
    duration_sec: float | None = Field(default=None)
    is_completed: bool = False
    drop_off_at: float | None = Field(default=None)


class DramaEvent(SQLModel, table=True):
    """短剧播放埋点事件。"""

    id: int | None = Field(default=None, primary_key=True)
    event_id: str = Field(index=True, unique=True)
    session_id: str = Field(foreign_key="dramasession.session_id", index=True)
    user_id: str = Field(index=True)
    drama_id: str = Field(index=True)
    event_type: str = Field(index=True)
    current_time: float | None = Field(default=None)
    duration: float | None = Field(default=None)
    payload: str = ""  # JSON string
    client_ts: int = Field(sa_type=BigInteger)  # 毫秒时间戳 ~1.7e12,PG 须 BIGINT
    server_ts: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# AI 短剧工作室(Drama Studio)—— 剧本→分镜→视频→配音→成片 一站式管线
# P0 核心:剧本 LLM 拆解 + 角色库 + 分镜级流水线状态机 + ffmpeg 一键合成
# ---------------------------------------------------------------------------


class DramaProject(SQLModel, table=True):
    """短剧项目:一个完整的短剧工程,含剧本、角色库、分镜列表。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    title: str
    premise: str = ""  # 故事概要/一句话题材
    style: str = ""  # 画风/风格描述
    script: str = ""  # 完整剧本文本
    status: str = "draft"  # draft|storyboard|generating|ready
    video_url: str = ""  # 最终成片 URL
    duration_sec: float = 0
    width: int = 768
    height: int = 384
    fps: int = 16
    # M4: 创作过程数据(JSON 时间线,对标 LibTV"查看制作过程")
    process_data: str = "[]"
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class DramaCharacter(SQLModel, table=True):
    """角色卡:名称 + 视觉提示词 + 参考图 + 参考音,用于跨镜头一致性。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(foreign_key="dramaproject.id", index=True)
    # M2:可选关联到跨项目资产库
    asset_id: str | None = Field(default=None, index=True)
    name: str
    description: str = ""  # 角色描述(中文)
    visual_prompt: str = ""  # 视觉提示词 token(英文,注入到镜头 prompt)
    ref_image: str = ""  # 参考图 URL
    ref_audio: str = ""  # 参考音频 URL(TTS 音色克隆)
    voice_name: str = ""  # TTS 音色名
    # M1: 角色三视图(正面/侧面/背面),锁定主体一致性,对标 LibTV
    reference_front: str = ""
    reference_side: str = ""
    reference_back: str = ""
    created_at: datetime = Field(default_factory=_now)


class DramaShot(SQLModel, table=True):
    """分镜:流水线最小单元,跟踪视频→配音→合成全链路状态。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(foreign_key="dramaproject.id", index=True)
    idx: int  # 分镜序号(0-based)
    scene: str = ""  # 场景描述(中文)
    prompt: str = ""  # 英文视频生成提示词
    negative: str = "blurry, low quality, text, watermark, deformed"
    characters: str = "[]"  # JSON: 角色名列表
    dialogue: str = ""  # 中文台词
    speaker: str = ""  # 说话人(角色名/narrator)
    duration_sec: int = 6
    start_sec: float = 0  # 在成片中的起始时间
    # M2: 宫格分镜图(9/25 宫格一次性生成的构图参考图 URL)
    grid_image: str = ""
    # M3: 空间构图布局(JSON: {characters:[{name,x,y}], props:[], camera:{angle,zoom}})
    scene_layout: str = ""
    # M6: 视频生成模型(ltx / seedance / kling,空=ltx 默认)
    video_model: str = ""
    # 流水线状态
    video_status: str = "pending"  # pending|generating|done|error
    video_url: str = ""
    voice_status: str = "pending"  # pending|generating|done|error
    voice_url: str = ""
    lipsync_status: str = ""  # generating|done|error
    lipsync_video_url: str = ""
    # 末帧续写(continue-video):段产物 URL 列表 + 可选拼接成片
    continue_status: str = ""  # ""|continuing|done|error
    continue_urls: str = "[]"  # JSON: 续写段视频 URL 列表(/api/drama/output/)
    continue_concat_url: str = ""  # auto_concat 拼接成片 URL
    continue_error: str = ""
    seed: int = Field(default=0, sa_type=BigInteger)  # PG 须 BIGINT(同 Job.seed)
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class DramaShotCandidate(SQLModel, table=True):
    """分镜视频候选:M1 单镜多候选生成,可从中挑选 active。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    shot_id: str = Field(foreign_key="dramashot.id", index=True)
    project_id: str = Field(index=True)
    url: str = ""
    seed: int = Field(default=0, sa_type=BigInteger)  # PG 须 BIGINT(同 Job.seed)
    video_model: str = ""
    status: str = "pending"  # pending|generating|done|error
    is_picked: bool = False
    error: str = ""
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# M2:跨项目角色/场景/道具/风格资产库
# ---------------------------------------------------------------------------


class DramaAsset(SQLModel, table=True):
    """跨项目可复用资产:角色/场景/道具/风格。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    kind: str = "character"  # character | scene | prop | style
    name: str
    description: str = ""  # 中文描述/标签
    visual_prompt: str = ""  # 英文视觉 token
    ref_image: str = ""  # 参考图 URL
    ref_audio: str = ""  # 参考音频 URL(音色克隆)
    voice_name: str = ""  # TTS 音色名
    # 角色三视图
    reference_front: str = ""
    reference_side: str = ""
    reference_back: str = ""
    tags: str = "[]"  # JSON 标签数组
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# Studio 创作工作室(替代 drama_studio / manju,分镜级混合生成)
# ---------------------------------------------------------------------------


class StudioProject(SQLModel, table=True):
    """创作项目:剧本 → 角色 → 分镜(视频/图像运镜混排)→ 合成。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    title: str = ""
    premise: str = ""  # 剧情概要/原文
    style: str = ""  # 整体画风/风格描述
    ckpt_name: str = ""  # 出图底模(图像运镜链用,保跨镜风格一致)
    render_mode_default: str = "video"  # 新分镜默认生成方式: video | image_motion
    status: str = "draft"  # draft | storyboard | generating | ready | error
    final_url: str = ""  # 成片 URL
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class StudioCharacter(SQLModel, table=True):
    """角色卡:跨镜一致性锚点(视觉提示词 + 参考图 + 参考音)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    name: str = ""
    description: str = ""  # 中文角色描述
    visual_prompt: str = ""  # 英文视觉 token(注入分镜 prompt)
    reference_images: str = "[]"  # JSON 数组:参考图 URL 列表
    voice_ref_url: str = ""  # 参考音 URL(TTS 音色克隆)
    created_at: datetime = Field(default_factory=_now)


class StudioShot(SQLModel, table=True):
    """分镜:最小生成单元,render_mode 决定走视频链还是图像运镜链。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    project_id: str = Field(index=True)
    idx: int = 0
    scene: str = ""  # 场景描述(中文)
    prompt: str = ""  # 英文生成提示词
    negative: str = "blurry, low quality, text, watermark, deformed"
    camera: str = ""  # 运镜(推拉摇移)
    dialogue: str = ""  # 台词
    speaker: str = ""  # 说话角色名
    duration_sec: int = 6
    characters: str = "[]"  # JSON 数组:出场角色名
    render_mode: str = "video"  # video | image_motion
    status: str = "draft"  # draft|queued|rendering|rendered|voiced|lipsynced|done|error
    image_url: str = ""
    video_url: str = ""
    voice_url: str = ""
    final_clip_url: str = ""  # 该镜最终片段(运镜/对口型后)
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)
