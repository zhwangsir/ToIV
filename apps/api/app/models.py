"""多租户数据模型（SQLModel）。

Tenant 1—N User；Job 归属 Tenant + User，实现租户级隔离。
积分(credits)挂在 Tenant 上，作为配额/计费基础。
"""
from __future__ import annotations

import uuid
from datetime import date, datetime, timezone
from typing import Optional

from sqlmodel import Field, SQLModel
from sqlalchemy import BigInteger, Column, JSON


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
    # [DEPRECATED] R18 分区账户软开关:自 2026-08-08 起不再作为任何判定来源
    # (全站统一读 X-NSFW 请求头,见 nsfw_ctx.nsfw_allowed)。字段与历史数据保留
    # (不删列、不做迁移),仅作「曾经开启过」的记录;marketplace 已切换到请求上下文。
    nsfw_enabled: bool = False
    # 出生日期(可选,空=未填写)。用于未成年防护硬阻断:nsfw_allowed 与
    # /account/nsfw 开关均会校验,未成年一律不可见 R18。空视为成年以兼容老数据。
    birthdate: Optional[date] = Field(default=None, index=True)
    # 当前默认智能体 id(顶栏全局默认;为空=走 kind 默认系统提示)。见 Agent 表。
    # 外键不强制(删除 agent 时此处自然失效, optimize 端兜底为 kind 默认)。
    default_agent_id: Optional[str] = Field(default=None)
    # 微信小程序登录绑定(openid);空 = 非微信用户(账密账号)。
    wechat_openid: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=_now)


class Job(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    # prompt_id 加索引(tracker 按 prompt_id 反查 Job);不加 unique —— 历史数据可能有重复
    prompt_id: str = Field(index=True)
    worker: str
    kind: str = "txt2img"
    status: str = "queued"  # 加索引:tracker reconcile 定期扫 queued/running
    prompt: str = ""
    seed: int = Field(default=0, sa_type=BigInteger)  # PG 须 BIGINT:种子上限 2**63-1(见 workflows/txt2img)
    nsfw: bool = False  # 该作品是否成人向(建档时由 checkpoint 是否 NSFW 决定)
    result: str = ""  # 完成后的产物 URL 列表(JSON)
    # 时长后处理(trim/extend)标记:""=无/完成,processing=后台裁切链进行中
    # (此时 result 是未裁原片,前端结果区应显示「精确裁切中」而非直接播放)
    post_status: str = ""
    # —— 版本树(精修迭代地基):每次生成挂到父版本,同链共根 ——
    parent_id: str = ""  # 父版本 Job.id(空=无父,自身即根)
    root_id: str = ""  # 版本树根 Job.id(空=自身即根;查链用 root_id or id)
    params: str = ""  # 建档时完整请求快照(JSON),支撑精确重生/锁seed微调/分支
    # 软删除时间(操作防护体系 SAFETY-2026-08-17):空=正常;非空=已进回收站,
    # 保留期(audit.UNDO_TTL_SECONDS,72h)内可经 /api/undo/{token} 或回收站恢复,
    # 过期后由清理任务(audit.trash_purge_loop)物理删除。
    deleted_at: Optional[datetime] = Field(default=None, index=True)
    # 资源预算二期(hold 排队):status=held 时为 hold 原因(预检 503 detail);
    # 放行/正常作业为空;hold 超时标 error 时改写为超时说明(前端列表直接可读)。
    hold_reason: str = ""
    # 生成进度快照(2026-08-29 全量进度体系):JSON {pct,step,total,queue_pos,updated_at};
    # tracker 查 /queue 写排队位置(无观众也有粗进度),SSE progress 事件节流写
    # step/total(有观众时精确);空串=无进度信息。任务中心 GET /api/jobs/active 消费。
    progress: str = ""
    # —— 视频评分器灰度观察(2026-08-27):点火结果落库,降级率/低分率可回溯 ——
    # quality_total=None = 未点火(开关关/非视频/无 URL);degraded=True = 评估降级
    # (VLM 不可达/解析失败/全 0 对齐降级),此时 total 无信息,统计时应单列。
    quality_total: Optional[float] = None
    quality_degraded: bool = False
    quality_issues: str = ""  # issues 前 3 条(JSON list 字符串,同 result/params 风格)
    created_at: datetime = Field(default_factory=_now, index=True)  # 加索引:未终态作业按时间排序扫描


class HeldJob(SQLModel, table=True):
    """资源预算二期 hold 排队票:预检(RAM/VRAM)不足的作业在此等资源释放。

    每票对应一个 status=held 的 Job(列表可见);graph 入库使 api 重启后仍可放行。
    调度循环(services/hold_queue.hold_scheduler_loop)按 created_at FIFO 复查,
    资源够 → queue_prompt + Job 换真实 prompt_id 转 queued + 删票;
    超 TOIV_HOLD_TIMEOUT_SEC → Job 标 error 删票;Job 被删/状态脱离 held → 票作废。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    job_id: str = Field(index=True)  # 对应 Job.id(status=held)
    engine: str  # h3/longcat/wan —— 决定放行时跑哪套预检(见 hold_queue._precheck)
    worker: str  # 目标 ComfyUI 实例 base_url
    graph: str  # 待提交 graph(JSON;建图时随机性已固化,放行即原样提交)
    reason: str = ""  # hold 原因(预检 503 detail)
    needs: str = "{}"  # 所需资源快照(JSON,如 {"vram_gb":36.0,"ram_gb":25.0})
    created_at: datetime = Field(default_factory=_now, index=True)  # FIFO 依据


# ---------------------------------------------------------------------------
# 模型百科(WIKI-2026-08-18):civitai 富化结果缓存(按 文件名+类目 唯一)。
# curated 部分在 workflows/model_wiki.py(纯代码,不落库);本表只存外部
# 富化事实(描述/触发词/基模/许可/下载量),RAG 问答语料 = curated ∪ 本表。
# ---------------------------------------------------------------------------
class ModelCard(SQLModel, table=True):
    """模型百科富化缓存。id = sha1(filename|model_type)[:16](稳定派生,幂等 upsert)。"""

    id: str = Field(primary_key=True)
    filename: str = Field(index=True)  # worker 上的完整文件名(含子目录)
    model_type: str = "checkpoints"  # checkpoints/loras/vae/controlnet/upscale/diffusion_models
    source: str = "civitai"  # 富化来源(civitai/huggingface/manual)
    label: str = ""  # 官方名
    base_model: str = ""  # 基模(SDXL/Illustrious/Pony/Flux.1/...)
    description: str = ""  # 用途描述(富化原文或人工整理,中文优先)
    trigger_words: str = "[]"  # JSON 数组:LoRA 触发词
    negative_hint: str = ""
    creator: str = ""
    license: str = ""
    civitai_id: str = ""  # civitai model id(再次富化/详情跳转用)
    civitai_url: str = ""
    downloads: int = 0
    nsfw: bool = False
    enriched_at: datetime = Field(default_factory=_now)  # 富化时间(过期可重拉)



# ---------------------------------------------------------------------------
# 操作防护体系(SAFETY,2026-08-17):关键操作审计日志。
# 记录用户的重要/危险操作(删除、撤销、admin 级动作、分区开关、部署等),
# undo_token + undo_expires_at 承载「规定时间内恢复误操作」的寻址凭据。
# ---------------------------------------------------------------------------
class AuditLog(SQLModel, table=True):
    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    user_email: str = ""  # 冗余展示列(用户被删后日志仍可读)
    action: str = Field(index=True)  # job.delete / job.undo / project.delete / admin.user.delete ...
    target_type: str = ""  # job / drama_project / studio_project / character / user ...
    target_id: str = ""
    summary: str = ""  # 人话摘要(审计页直接展示)
    detail: str = ""  # 结构化快照 JSON(恢复/排障用;敏感字段由记录方负责脱敏)
    undo_token: Optional[str] = Field(default=None, index=True)  # 非空=该操作可撤销
    undo_expires_at: Optional[datetime] = Field(default=None)
    undone: bool = False  # 已被撤销的删除操作打标(防重复 undo)
    created_at: datetime = Field(default_factory=_now, index=True)


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
    """提示词优化智能体(Skill 市场技能卡):绑定一个 system_prompt 主人格,优化时拼接在 kind 系统提示前。

    applies_to 为逗号分隔串(如 "image,video" / "all" / "audio" / "train"),
    含 "all" 表示适用所有 kind。is_nsfw=True 的智能体仅 R18 鉴权用户可见。
    user_id 空 = 公共(内置 seed / admin 建);非空 = 用户从 Skill 市场导入的个人技能,
    仅属主可见/可改/可删(2026-08-18 Skill 市场化)。
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
    # 属主用户(空=公共)。个人导入技能的归属与可见性边界。
    user_id: str = Field(default="", index=True)
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
    # 三视图生成状态:""=未生成 / generating / done / error(异步回写,同 lipsync 模式)
    reference_status: str = ""
    reference_error: str = ""
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
    # 颜色标记草图在场校验(DramaClaw 借鉴 #4):
    # JSON {color_map, per_character, checked_at, source};color_mark 生成时写 expected 段,
    # presence-check 校验后写 per_character 检测明细
    detected_colors: str = ""
    # M6: 视频生成模型(ltx / seedance / kling,空=ltx 默认)
    video_model: str = ""
    # LibTV 工作台:情绪标签 + 节拍注记(wind-comic 实证,节奏在列表视图可读)
    mood: str = ""
    beat: str = ""
    # P1 衔接策略层:与下一镜的接缝策略(空=未规划,按硬切处理)+ 衔接锚点描述
    seam_to_next: str = ""  # continue(末帧续写)|overlap(共享帧重叠)|matchcut(匹配切口)|hardcut(硬切)
    seam_anchor: str = ""  # matchcut/overlap 时 LLM 填写的共享锚体(刀刃/圆环/瞳孔/色块…)
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
# P1 全局主体库(2026-08-26):角色/场景/道具三类主体跨项目复用(对标 Vidu RefHub)。
# 与 DramaAsset 的区别:Entity 是全局资产(不挂任何业务线),drama/生成页/助手
# 均可引用;DramaCharacter 旧数据由 db.py 启动迁移一次性 copy 进本表。
# ---------------------------------------------------------------------------


class Entity(SQLModel, table=True):
    """全局主体:角色(可带三视图)/场景/道具/数字人形象(avatar,2026-08-29 归并 ReferenceAsset)。

    图片四列(ref_image + reference_front/side/back)统一存两种形态:
    ① 上传句柄 JSON 串 {"filename","worker"}(/api/upload 或 /api/assets/from-job 返回);
    ② 纯 URL 字符串(作品库/迁移旧数据)。解析统一走 services/entities.parse_image_handle。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    kind: str = Field(default="character", index=True)  # character | scene | prop | avatar
    name: str
    description: str = ""  # 中文描述
    ref_image: str = ""  # 单图(句柄 JSON 或 URL)
    # 三视图(仅 character/avatar 使用)
    reference_front: str = ""
    reference_side: str = ""
    reference_back: str = ""
    prompt_hint: str = ""  # 注入提示词用的主体描述(英文 token 优先)
    # 数字人形象(kind=avatar)扩展(归并自 ReferenceAsset,2026-08-29):
    green_screen: bool = False  # 绿幕素材标记(抠像/合成工作流用)
    ref_audio: str = ""  # 形象默认音色参考音频 URL(可空)
    nsfw: bool = False  # R18 主体:SFW 上下文(无 X-NSFW 头)查询过滤(预留,消费侧下轮)
    # 三视图生成状态(异步回写,同 DramaCharacter 模式):"" / generating / done / error
    reference_status: str = ""
    reference_error: str = ""
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
    # 产出规格:视频链/图像运镜链共用(合成同规格拼接的前提);8 对齐,LTX 预设 32 对齐
    width: int = 768
    height: int = 384
    fps: int = 16
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


# ---------------------------------------------------------------------------
# R2.3:参考资产库(Reference Asset Library)—— 项目级常驻角色/场景/道具/风格卡
# 对标 MiniMax Design 分工式参考 / Lovart Brand Kit:每镜头生成时从资产库勾选引用,
# 而非每次重新上传。images 只持久化 /api/upload 返回的 {filename, worker} 句柄,
# 文件本体不重复存储;1-4 张上限(业界共识:参考元素 ≤4 是质量拐点)。
# ---------------------------------------------------------------------------


class ReferenceAsset(SQLModel, table=True):
    """参考资产卡:角色/场景/道具/风格。多用户隔离(按 user_id),NSFW 资产按请求上下文过滤。"""

    __tablename__ = "reference_assets"

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)  # 资产属主(他人不可见/不可改)
    kind: str = "character"  # character | scene | prop | style | avatar
    name: str = ""  # 资产名(1-100 字符,长度校验在路由层 pydantic)
    description: str = ""  # 提示词语义描述(后续反哺 prompt;≤2000 字符,校验在路由层)
    # 参考图句柄列表 list[{filename, worker}]。选 JSON 列而非关联表:
    # 数量硬上限 4 张、无独立生命周期、不跨资产复用,关联表纯属过度设计。
    images: list[dict] = Field(default_factory=list, sa_column=Column(JSON, nullable=False))
    nsfw: bool = False  # R18 资产:SFW 上下文(无 X-NSFW 头)查询时过滤
    # 数字人形象(kind=avatar,对标 aigcpanel「我的形象」)扩展两列:
    green_screen: bool = False  # 绿幕素材标记(后续抠像/合成工作流用)
    ref_audio: str = ""  # 形象默认音色参考音频 URL(可空;空=合成时用默认音色)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# R3.1:Agent Team 统一入口(「计划可见+秒回+任务卡片」壳)—— 数据底座 4 表
# 字段定义与后端 Agent Team 契约一致;
# 本期零 LangGraph 依赖,checkpoint_ns 等字段为 R3.2 接 LangGraph 预留。
# ---------------------------------------------------------------------------


class AgentRun(SQLModel, table=True):
    """一次 Agent Team 任务(LangGraph 接入后 id 即 thread_id)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(index=True)  # 归属校验按用户(他人 404)
    level: str  # L0/L1/L2(Director Gate 判定)
    goal: str  # 用户原始需求
    plan_json: str = ""  # DAG 计划快照(可编辑版):{tasks:[...], opts:{}, characters:[...]}
    status: str = Field(default="planning", index=True)  # planning/awaiting_confirm/running/
    # awaiting_assembly/done/error/canceled
    checkpoint_ns: str = "agent_team"  # R3.2 PostgresSaver namespace 预留
    error: str = ""
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class AgentTask(SQLModel, table=True):
    """DAG 节点(任务卡片的数据底座)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    run_id: str = Field(index=True)
    kind: str  # script/storyboard/image/video/audio/subtitle/verify/assemble
    title: str  # 卡片标题("镜头 3:雨夜追逐")
    depends_on: str = "[]"  # 上游 node_id JSON 数组
    status: str = "pending"  # pending/queued/running/verifying/rejected/approved/done/error
    attempt: int = 0  # ≤2(Verifier 打回/手动 regenerate 共用上限,防成本爆炸)
    input_json: str = "{}"  # 提示词/参考资产 entity_id/参数/StudioShot 映射(shot_id)
    output_json: str = "{}"  # 产物 URL/文本/EDL 片段
    verdict_json: str = ""  # 评语/失败原因(打回原因对卡片可见;R3.2 Verifier 评语)
    gpu_hint: str = ""  # 调度提示(本期静态 "pool";真实队列位置 R3.2 接 comfy/pool)
    idempotency_key: str = ""  # run_id+node_id+attempt(副作用幂等键)


class AgentEvent(SQLModel, table=True):
    """SSE 事件流水(秒回与节点汇报);id 自增,消费端按 after=last_id 增量拉。"""

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)
    ts: datetime = Field(default_factory=_now)
    type: str  # ack/plan/task_status/verdict/confirm_required/blocked/decision_required/done/error
    payload_json: str = "{}"


class AgentApproval(SQLModel, table=True):
    """HITL 裁决落库(接 R5 阈值校准/evals 回流)。"""

    id: int | None = Field(default=None, primary_key=True)
    run_id: str = Field(index=True)
    task_id: str | None = None  # 空 = 计划级确认门
    gate: str  # plan/assembly
    action: str  # approve/reject/modify/regenerate/upload
    feedback: str = ""  # 方向性批注("角色发色不一致")
    decided_by: str = "human"  # human/timeout_default(R3.2 超时默认动作)
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# H2:智能体会话日志(model-visible means logged)—— 会话 + 追加消息事件流。
# 进 LLM 的 user/assistant/tool 消息逐条落库,回放/分叉/跨设备续聊从日志派生。
# ---------------------------------------------------------------------------


class AgentSession(SQLModel, table=True):
    """一次对话会话(AssistantView 对话流)。nsfw=True 的会话仅 R18 上下文可见
    (对齐 Job 过滤语义,见 routes/agent.py 与 nsfw_ctx.nsfw_allowed)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(index=True)
    title: str = ""  # 首条 user 消息前 30 字自动生成
    nsfw: bool = False  # 建档时按请求上下文(X-NSFW)决定
    # 深度接管:待确认的提案(JSON 字符串,可空)。propose_plan 工具写入
    # (status=pending),/agent/chat/resume 确认/修改/拒绝后改写 status 保留存根。
    pending_proposal: Optional[str] = Field(default=None)
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class AgentMessage(SQLModel, table=True):
    """会话消息事件(append-only):role=user/assistant/tool;content 即进 LLM 的原文,
    tool_calls/media 为 JSON 串。id 自增,同会话内按 id 升序即对话顺序。"""

    id: int | None = Field(default=None, primary_key=True)
    session_id: str = Field(index=True)
    role: str  # user | assistant | tool
    content: str = ""
    tool_calls: str = ""  # JSON:assistant 的 tool_calls 数组 / tool 消息的 {tool_call_id,name,args}
    media: str = ""  # JSON:该工具产出的媒体事件列表 [{"type":"image","urls":[...]}]
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# B 评测管线(2026-08-23):best-of-n 批次分组 + 自动评分记录。
# EvalBatch 把「同 prompt/参数、seed 递增的 n 个变体 Job」聚成一批;
# EvalScore 是评分落库表,(prompt, params, 产物引用, 分数, 评分器)五元组存全,
# 即后续偏好数据集(数据飞轮)导出的直接数据源——导出直接查 EvalScore,本表即 schema 预留。
# ---------------------------------------------------------------------------


class EvalBatch(SQLModel, table=True):
    """一次 best-of-n 评测批次。

    job_ids 存 Job.id 而非 prompt_id:hold 排队放行后 prompt_id 会换名
    (hold-* 占位 → worker 真实 id),Job.id 全程稳定。
    status: generating(有变体未终态) → scoring → done;
    winner_job_id 空 = 全部变体失败,无胜者。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    tenant_id: str = Field(index=True)
    user_id: str = Field(index=True)
    engine: str = "h3"  # 生成引擎(h3;后续图像链等同表复用)
    kind: str = "h3_t2v"  # 变体 Job 的 kind
    prompt: str = ""
    params: str = "{}"  # 请求快照(JSON,同 Job.params 语义;逐变体 seed 在 seeds)
    seeds: str = "[]"  # JSON 数组:逐变体 seed(基础 seed 递增)
    job_ids: str = "[]"  # JSON 数组:逐变体 Job.id(与 seeds 同序)
    n: int = 0
    scorer: str = "auto"  # 请求指定的评分器:auto | heuristic | vlm
    status: str = "generating"  # generating | scoring | done
    winner_job_id: str = ""
    nsfw: bool = False  # 建档时按请求上下文(X-NSFW)打标,查询对齐 Job 过滤语义
    created_at: datetime = Field(default_factory=_now, index=True)
    updated_at: datetime = Field(default_factory=_now)


class EvalScore(SQLModel, table=True):
    """单变体评分记录(append-only:同 job_id 重评插新行,消费端取 created_at 最新)。

    偏好数据集导出字段已存全:prompt / params(生成参数快照) / result(产物引用) /
    seed / score / breakdown(维度明细) / scorer(实际产出分数的评分器,VLM 降级时
    为 heuristic) / degraded。error 非空 = 该变体生成失败(score 恒 0,排名末位)。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    batch_id: str = Field(index=True)
    job_id: str = Field(index=True)
    user_id: str = Field(index=True)
    prompt: str = ""
    params: str = "{}"
    result: str = "[]"  # 产物 URL 列表 JSON(同 Job.result)
    seed: int = Field(default=0, sa_type=BigInteger)  # PG 须 BIGINT(同 Job.seed)
    score: float = 0.0
    breakdown: str = "{}"  # 维度明细 JSON
    scorer: str = ""
    degraded: bool = False
    critique: str = ""  # 评分器评语(VLM 产出;启发式/终态分为原因说明)
    rank: int = 0  # 批次内名次(1 起;score 降序,同分按 seed 升序保确定性)
    is_winner: bool = False
    error: str = ""  # 变体非 done 终态时的状态(error/canceled/...)
    created_at: datetime = Field(default_factory=_now)


class EvalDatasetExport(SQLModel, table=True):
    """偏好数据集导出记录(幂等票,E 数据飞轮,2026-08-23)。

    每个 EvalBatch 最多一条(batch_id 唯一):不合格批次也落票(pair_count=0 +
    skip_reason 记原因),防止手动全量导出反复重试同一批。file_path 指向写入的
    JSONL 文件(SFW/NSFW 分文件、按日期滚动,见 services/pref_dataset)。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    batch_id: str = Field(index=True, unique=True)  # 幂等键:同批次只处理一次
    nsfw: bool = False
    pair_count: int = 0
    file_path: str = ""  # 写入的 JSONL 路径;不合格批次为空
    skip_reason: str = ""  # insufficient_valid_variants | gap_below_threshold;合格为空
    created_at: datetime = Field(default_factory=_now)


# ---------------------------------------------------------------------------
# 直播助手(数字人 M5,2026-08-27):知识库问答 / 违禁词 / 互动事件
# 通用互动网关(不做平台弹幕抓取):手动/webhook 摄入 → 违禁词拦截 →
# KB 触发词匹配 → LLM 兜底 → OpenTalking 播报状态机。
# ---------------------------------------------------------------------------


class LiveKB(SQLModel, table=True):
    """直播知识库条目:触发词命中 → 固定文本回复 / 视频回复。

    trigger_words 存 JSON 数组字符串(与 EvalBatch.seeds 同约定,避免关联表)。
    priority 小值优先(首个 enabled 命中即返,不叠加)。
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)  # 属主隔离
    trigger_words: str = "[]"  # JSON 数组:list[str]
    reply_type: str = "text"  # text | video
    reply_text: str = ""  # text 回复正文
    reply_asset_url: str = ""  # video 回复的产物 URL(reply_type=video 时必填)
    priority: int = 100  # 小优先
    enabled: bool = True
    created_at: datetime = Field(default_factory=_now)
    updated_at: datetime = Field(default_factory=_now)


class LiveEvent(SQLModel, table=True):
    """直播互动事件(append-only):摄入 → 回复 → 播报结果全留痕。

    status 状态机:
    - banned:输入或回复文本命中违禁词(不播报)
    - replied:已回复但未播报(reply_type=video,文本之外的回复不送 speak)
    - no_session:文本回复但用户无活跃 OpenTalking 会话
    - spoken:已送 OpenTalking speak 且上游接受
    - speak_failed:有会话但 speak 调用失败(上游错误/不可达)
    """

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)  # 属主隔离
    source: str = "manual"  # manual | webhook
    author: str = ""  # 观众昵称(可空)
    text: str = ""  # 摄入原文
    matched_kb_id: Optional[str] = Field(default=None)  # 命中的 KB id;LLM/违禁词拦截为 None
    reply_text: str = ""  # 最终回复文本(video 回复时为产物 URL)
    reply_type: str = "text"  # text | video
    status: str = "replied"
    created_at: datetime = Field(default_factory=_now, index=True)


class LiveBannedWord(SQLModel, table=True):
    """违禁词:输入与回复文本双向拦截(大小写不敏感子串匹配)。"""

    id: str = Field(default_factory=_uid, primary_key=True)
    user_id: str = Field(foreign_key="user.id", index=True)  # 属主隔离
    word: str
    created_at: datetime = Field(default_factory=_now)
