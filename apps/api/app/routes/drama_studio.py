"""DEPRECATED(2026-08-05): 本模块已由 studio 创作工作室替代(app/routes/studio.py)。

保留仅作旧项目数据只读查询,不再新增功能。新需求一律走 /api/studio/*。

AI 短剧工作室 —— 剧本→分镜→视频→配音→成片 一站式 MVP 管线。

P0 核心端点(nsfw=true 须 X-NSFW 头,与 ltx_studio 同款 R18 门控):
  · 项目 CRUD            POST/GET/PATCH /api/drama/projects
  · 剧本 LLM 拆解        POST /api/drama/projects/{pid}/storyboard
  · 角色库 CRUD          POST/GET/DELETE  /api/drama/projects/{pid}/characters
  · 单分镜视频生成       POST /api/drama/shots/{sid}/generate-video  (LTX t2v)
  · 末帧续写(多段 i2v)   POST /api/drama/shots/{sid}/continue-video  (LTX/H3 i2v 串长镜头)
  · 单分镜配音           POST /api/drama/shots/{sid}/generate-voice  (IndexTTS2)
  · 一键合成成片         POST /api/drama/projects/{pid}/assemble     (ffmpeg)

复用既有基建:
  · LLM 拆解模式抄自 manju.py(_STORYBOARD_SYSTEM + llm.chat + _parse_json_obj)
  · 视频生成复用 ltx_video.py 工作流 + comfy.tracker
  · 配音复用 voice.py 的 TTS 调用 + /api/manju/voice 产物目录
  · 合成复用 assembly.py 的 _build_ffmpeg_command / _run_ffmpeg / _download_clip
"""
from __future__ import annotations

import asyncio
import json
import logging
import re
import shutil
import tempfile
import time
import uuid
import wave
from collections.abc import Coroutine
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, File, Form, HTTPException, UploadFile
from fastapi.responses import FileResponse
from pydantic import (
    BaseModel,
    Field,
    ValidationError,
    ValidationInfo,
    field_validator,
    model_validator,
)
from sqlmodel import Session, delete, select

from app.agent import llm
from app.harness.ctx import get_ctx
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker, wait_for_jobs
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_user, get_pool, resolve_worker
from app.models import (
    DramaAsset,
    DramaCharacter,
    DramaEvent,
    DramaProject,
    DramaSession,
    DramaShot,
    DramaShotCandidate,
    Job,
    User,
    _now,
)
from app.ratelimit import enforce_generation_rate_limit
from app.jsonutil import parse_json_obj
from app.routes.lipsync import _allowed as _lipsync_allowed, _resolve as _lipsync_resolve
from app.routes.reverse import _chat_completion, _data_url
from app.routes.video import _gate_ltx_nsfw
from app.services.h3_refs import ref_prefix_for_shot
from app.services.drama_image import analyze_storyboard_images
from app.services.drama_presence import (
    assign_character_colors,
    check_regions,
    color_mark_prompt_suffix,
    detect_character_presence,
    detect_grid_panels,
    fetch_product_image_bytes,
    parse_image_url,
)
from app.services.duration import snap_engine_frames, validate_engine_frames
from app.services.studio.schemas import reconcile_character_names
from app.skills.registry import skills_registry
from app.storage import drama_output_root
from app.versioning import params_snapshot
from app.workflows.ipadapter import IPAdapterTxt2ImgParams, build_ipadapter_txt2img_graph
from app.workflows.pulid import PulidTxt2ImgParams, build_pulid_txt2img_graph
from app.workflows.pulid import is_available as pulid_is_available
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph
from app.workflows.ltx_video import LtxI2VParams, LtxT2VParams, build_ltx_i2v_graph, build_ltx_t2v_graph
from app.workflows.model_profiles import fit_resolution, is_nextgen, nextgen_recipe, profile_for
from app.workflows.nextgen import NextgenParams, build_nextgen_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

logger = logging.getLogger(__name__)

router = APIRouter()

# NAS 统一存储:成片与配音统一落到 TOIV_DRAMA_VIDEO_DIR(生产指向 NAS 成片目录),
# 与 drama_analytics.py 的播放器代理共享同一路径,避免生成与播放目录不一致。
# 运行时解析(60s 缓存):NAS 恢复后无需重启自动回切,不可达立即降级本地。
def _drama_dir() -> Path:
    return drama_output_root()


_VOICE_NAME_RE = re.compile(r"^voice(?:ref)?-[0-9a-f]{32}\.wav$")
_DRAMA_OUTPUT_RE = re.compile(r"^drama-[0-9a-f]{32}\.mp4$")
# P1 衔接策略层:seam_to_next 枚举域(空串=未规划,按硬切处理)
_SEAM_KINDS = ("continue", "overlap", "matchcut", "hardcut")
_TTS_TIMEOUT = 180.0
# LiveAct 全身数字人:生成时长 = 音频时长(103s 音频约 3.5 分钟),轮询给足余量
_LIVEACT_POLL_INTERVAL = 3.0
_LIVEACT_TIMEOUT = 1200.0

# 后台任务强引用集合:asyncio 对 create_task 的返回值仅持弱引用,
# 无外部强引用时可能被 GC 提前回收(参考 app.comfy.tracker.spawn 的模式)
_BG_TASKS: set[asyncio.Task] = set()


def _spawn(coro: Coroutine[Any, Any, Any]) -> asyncio.Task:
    """fire-and-forget 启动后台协程,持强引用直到完成,防 GC 提前回收。"""
    task = asyncio.create_task(coro)
    _BG_TASKS.add(task)
    task.add_done_callback(_BG_TASKS.discard)
    return task


# ===========================================================================
# 剧本拆解 LLM 系统提示(短剧版,偏影视叙事而非 danbooru 标签)
# ===========================================================================
_STORYBOARD_SYSTEM = (
    "你是 AI 短剧导演 + 分镜师。把用户给的剧本文本拆解成连贯的影视分镜脚本。\n"
    "\n"
    "【视频提示词铁律 —— 直接决定 LTX 视频生成画面质量】\n"
    "1. 每个镜头只表现【一个清晰的瞬间、一个主体焦点】。**绝对禁止** montage / "
    "蒙太奇 / 拼贴 / 分屏 / split screen / collage / multiple scenes。单镜头画不下。\n"
    "2. 多人物场景只聚焦 1-2 个主要角色的单一动作(例:与其写 'A打B、C逃跑',"
    "只写 'A一拳挥向B')。\n"
    "3. prompt 必须是【英文影视描述】,逗号分隔的关键词为主,适配 LTX 视频模型:"
    "`主体(1boy/1girl/2boys 等) + 外貌服装 + 单一动作 + 表情 + 场景地点 + 光影氛围 + "
    "画质标签(cinematic, masterpiece, 8k, highly detailed, film grain)`。\n"
    "4. **禁用**会被误解成拼贴的词:dynamic angles、fight montage、multiple、several、"
    "various、collage、abstract。构图用单一明确的:close-up / medium shot / wide shot / "
    "from side / low angle / overhead shot 之一。\n"
    "5. 角色出场时用其固定外貌特征(发色/瞳色/服装)保持跨镜一致。\n"
    "6. 视频时长建议 4-8 秒(整数),动作戏可适当延长。\n"
    "\n"
    "【镜头接缝策略 —— 逐镜规划本镜与下一镜的衔接方式】\n"
    "除最后一镜外,每个镜头必须给出 seam_to_next,四选一:\n"
    "- continue:相邻镜为同场景的连续动作(下一镜从本镜末帧直接续写);\n"
    "- hardcut:时间跳跃 / 场景转换,直接硬切(拿不准一律用 hardcut);\n"
    "- matchcut:需要图形/动作匹配变形转场(如刀刃拉直成装订线、圆环扩大成表盘),"
    "必须同时给出 seam_anchor(两镜共享的视觉锚体:刀刃/圆环/瞳孔/色块等);\n"
    "- overlap:需要柔和叠化过渡,同时给出 seam_anchor(叠化时保持连续的主体/色块)。\n"
    "seam_anchor 用简短中文名词短语;continue/hardcut 时 seam_anchor 留空。\n"
    "最后一镜没有下一镜,seam_to_next 必须为空字符串。\n"
    "\n"
    "对每一个镜头(shot)给出:\n"
    "- scene:该镜的场景/地点简述(中文);\n"
    "- prompt:遵守上述铁律的英文视频提示词(单主体单动作);\n"
    "- characters:该镜出场角色名字数组(只用 characters 列表里给定的名字,没有则空数组);\n"
    "- dialogue:该镜的【中文】台词或旁白(没有则空字符串);\n"
    "- speaker:说话人(角色名 / narrator / 空=无对白);\n"
    "- duration_sec:该镜建议时长(秒,整数,4-8);\n"
    "- seam_to_next:与下一镜的接缝策略(continue/overlap/matchcut/hardcut,最后一镜空字符串);\n"
    "- seam_anchor:matchcut/overlap 时的共享锚体描述(其余策略空字符串);\n"
    "- mood:该镜情绪标签(简短中文词,如 紧张/悲壮/温情/悬疑);\n"
    "- beat:该镜叙事节拍(简短中文短语,如 建立/对峙/转折/高潮/收束)。\n"
    "镜头数量严格等于用户要求的数量。若 style 给定请融入画质/氛围标签。\n"
    '只输出 JSON,形如 {"shots":[{"scene":"...","prompt":"1boy, ...",'
    '"characters":["..."],"dialogue":"...","speaker":"...","duration_sec":6,'
    '"seam_to_next":"hardcut","seam_anchor":"","mood":"紧张","beat":"对峙"}, ...]},'
    "不要解释,不要代码块标记。"
)


# ===========================================================================
# 请求 / 响应模型
# ===========================================================================
class ProjectIn(BaseModel):
    title: str = Field(min_length=1, max_length=200)
    premise: str = Field(default="", max_length=2000)
    style: str = Field(default="", max_length=300)
    script: str = Field(default="", max_length=20000)
    width: int = Field(default=768, ge=256, le=1920)
    height: int = Field(default=384, ge=256, le=1080)
    fps: int = Field(default=16, ge=4, le=30)


class ProjectPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    premise: str | None = Field(default=None, max_length=2000)
    style: str | None = Field(default=None, max_length=300)
    script: str | None = Field(default=None, max_length=20000)
    status: str | None = Field(default=None, max_length=20)
    width: int | None = Field(default=None, ge=256, le=1920)
    height: int | None = Field(default=None, ge=256, le=1080)
    fps: int | None = Field(default=None, ge=4, le=30)


class CharacterIn(BaseModel):
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    visual_prompt: str = Field(default="", max_length=1000)
    ref_image: str = Field(default="", max_length=1000)
    ref_audio: str = Field(default="", max_length=1000)
    voice_name: str = Field(default="", max_length=64)
    # M2:可选关联到资产库
    asset_id: str | None = Field(default=None, max_length=64)


class CharacterPatch(BaseModel):
    name: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    visual_prompt: str | None = Field(default=None, max_length=1000)
    ref_image: str | None = Field(default=None, max_length=1000)
    ref_audio: str | None = Field(default=None, max_length=1000)
    voice_name: str | None = Field(default=None, max_length=64)
    asset_id: str | None = Field(default=None, max_length=64)


# M2:跨项目资产库请求模型
class AssetIn(BaseModel):
    kind: str = Field(default="character", max_length=20)
    name: str = Field(min_length=1, max_length=64)
    description: str = Field(default="", max_length=500)
    visual_prompt: str = Field(default="", max_length=1000)
    ref_image: str = Field(default="", max_length=1000)
    ref_audio: str = Field(default="", max_length=1000)
    voice_name: str = Field(default="", max_length=64)
    reference_front: str = Field(default="", max_length=1000)
    reference_side: str = Field(default="", max_length=1000)
    reference_back: str = Field(default="", max_length=1000)
    tags: list[str] = Field(default_factory=list)


class AssetPatch(BaseModel):
    kind: str | None = Field(default=None, max_length=20)
    name: str | None = Field(default=None, max_length=64)
    description: str | None = Field(default=None, max_length=500)
    visual_prompt: str | None = Field(default=None, max_length=1000)
    ref_image: str | None = Field(default=None, max_length=1000)
    ref_audio: str | None = Field(default=None, max_length=1000)
    voice_name: str | None = Field(default=None, max_length=64)
    reference_front: str | None = Field(default=None, max_length=1000)
    reference_side: str | None = Field(default=None, max_length=1000)
    reference_back: str | None = Field(default=None, max_length=1000)
    tags: list[str] | None = None


class StoryboardRequest(BaseModel):
    num_shots: int = Field(default=6, ge=1, le=30)
    style: str | None = Field(default=None, max_length=300)
    # 可选:覆盖项目里的 script;不传则用项目 script
    script: str | None = Field(default=None, max_length=20000)


class ShotPatch(BaseModel):
    scene: str | None = Field(default=None, max_length=500)
    prompt: str | None = Field(default=None, max_length=2000)
    negative: str | None = Field(default=None, max_length=2000)
    characters: list[str] | None = None
    dialogue: str | None = Field(default=None, max_length=1000)
    speaker: str | None = Field(default=None, max_length=64)
    duration_sec: int | None = Field(default=None, ge=1, le=30)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    # LibTV 工作台:情绪标签 + 节拍注记
    mood: str | None = Field(default=None, max_length=64)
    beat: str | None = Field(default=None, max_length=200)
    # P1 衔接策略层:与下一镜的接缝策略 + 衔接锚点(空=未规划,按硬切处理)
    seam_to_next: str | None = Field(default=None, max_length=16)
    seam_anchor: str | None = Field(default=None, max_length=200)

    @field_validator("seam_to_next")
    @classmethod
    def _seam_known(cls, v: str | None) -> str | None:
        if v is not None and v not in ("", *_SEAM_KINDS):
            raise ValueError("seam_to_next 仅支持 continue/overlap/matchcut/hardcut(空=未规划)")
        return v


class GenerateVideoRequest(BaseModel):
    worker: str | None = Field(default=None, max_length=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    use_upscale: bool = False
    use_rife: bool = False
    # NSFW 开关:True 走 LTX-2.3 + 10Eros pool 链路(R18 保留);False(默认)SFW 链路
    # 已随 LTX-2.5 退役(2026-08-23)移除,生成器返回退役提示(SFW 请用 h3)
    nsfw: bool = False
    # 覆盖该镜的 prompt(空=用分镜已存的 prompt)
    prompt_override: str | None = Field(default=None, max_length=2000)


class ContinueVideoRequest(BaseModel):
    """末帧续写请求:抽当前视频末帧作 i2v 首帧,逐段延续生成串长镜头。

    engine 空 = 沿用分镜 video_model(仅 ltx/h3 有效,其余回落 ltx)。
    length/fps 空 = 按项目 fps × 分镜时长换算并向下对齐引擎帧数网格;
    显式 length 须满足引擎约束(LTX 8k+1 @9-241;H3 17k+5 @22-362,固定 24fps)。
    fps 覆盖仅 LTX 生效(H3 忽略)。
    """

    segments: int = Field(default=1, ge=1, le=5)
    engine: str = Field(default="", max_length=16)
    auto_concat: bool = False
    length: int | None = Field(default=None, ge=9, le=362)
    fps: int | None = Field(default=None, ge=4, le=30)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    prompt_override: str | None = Field(default=None, max_length=2000)
    # NSFW 开关:True 续写段用 NSFW 专用视频底模(10Eros)并给段 Job 打 nsfw 标
    # (须 X-NSFW 头,与 generate-video 同一判定来源;R18 分镜续写产物不进主站作品库)
    nsfw: bool = False

    @field_validator("engine")
    @classmethod
    def _engine_known(cls, v: str) -> str:
        if v not in ("", "ltx", "h3"):
            raise ValueError("engine 仅支持 ltx / h3(空 = 沿用分镜引擎)")
        return v


class GenerateVoiceRequest(BaseModel):
    # 覆盖该镜的台词(空=用分镜已存的 dialogue)
    text_override: str | None = Field(default=None, max_length=600)
    # 覆盖参考音(空=用 speaker 对应角色的 ref_audio)
    ref_audio_url: str | None = Field(default=None, max_length=2000)
    # 情感描述与强度，透传给 IndexTTS2
    emo_text: str | None = Field(default=None, max_length=200)
    emo_alpha: float = Field(default=0.6, ge=0.0, le=1.0)


class LipsyncRequest(BaseModel):
    """M3: 分镜对口型请求。复用 manju lipsync 同款参数。"""

    lips_expression: float = Field(default=1.5, ge=1.0, le=3.0)
    inference_steps: int = Field(default=20, ge=1, le=50)
    # 采样种子:缺省随机;rerun keep 锁 seed 时精确复现口型采样
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


class AssembleOptions(BaseModel):
    transition: str = Field(default="none")
    bgm_url: str | None = Field(default=None, max_length=2000)
    title: str = Field(default="", max_length=120)
    credits: str = Field(default="", max_length=600)
    # aspect="auto"(默认):合成沿用项目宽高(取偶数兜底);显式 16:9/9:16/1:1 走预设尺寸
    aspect: str = Field(default="auto")
    # fps=0(默认):合成沿用项目 fps;显式 >0 覆盖
    fps: int = Field(default=0, ge=0, le=60)
    grade: str = Field(default="none", max_length=20)
    sub_size: int = Field(default=28, ge=12, le=72)
    sub_color: str = Field(default="white", max_length=12)
    sub_pos: str = Field(default="bottom", max_length=10)
    sub_box: bool = Field(default=True)
    voice_volume: float = Field(default=1.0, ge=0.0, le=2.0)
    bgm_volume: float = Field(default=0.0, ge=0.0, le=1.0)
    duck: bool = Field(default=True)
    # M3:前端显式指定合成片段,优先使用 lipsync_video_url;空则后端兜底
    clips: list[str] | None = Field(default=None)


class GenerateReferenceRequest(BaseModel):
    """M1: 角色三视图生成请求。空 visual_prompt_override 则用角色已有的 visual_prompt。"""

    visual_prompt_override: str | None = Field(default=None, max_length=1000)
    worker: str | None = Field(default=None, max_length=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


class GridStoryboardRequest(BaseModel):
    """M2: 9/25 宫格分镜请求。空 script 则用项目已有的 script。"""

    num_shots: int = Field(default=9, ge=1, le=25)  # 9 或 25
    style: str | None = Field(default=None, max_length=300)
    script: str | None = Field(default=None, max_length=20000)
    # DramaClaw 借鉴 #4:为角色分配标记色并注入宫格图 prompt(纯色火柴人草图),
    # 供 presence-check 事后检测角色在场;默认 False 零行为变更
    color_mark: bool = False


# ===========================================================================
# 序列化
# ===========================================================================
def _project_dict(p: DramaProject) -> dict:
    try:
        process = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        process = []
    return {
        "id": p.id,
        "title": p.title,
        "premise": p.premise,
        "style": p.style,
        "script": p.script,
        "status": p.status,
        "video_url": p.video_url,
        "duration_sec": p.duration_sec,
        "width": p.width,
        "height": p.height,
        "fps": p.fps,
        "process_data": process,
        "created_at": p.created_at.isoformat(),
        "updated_at": p.updated_at.isoformat(),
    }


def _character_dict(c: DramaCharacter) -> dict:
    return {
        "id": c.id,
        "project_id": c.project_id,
        "asset_id": c.asset_id,
        "name": c.name,
        "description": c.description,
        "visual_prompt": c.visual_prompt,
        "ref_image": c.ref_image,
        "ref_audio": c.ref_audio,
        "voice_name": c.voice_name,
        "reference_front": c.reference_front,
        "reference_side": c.reference_side,
        "reference_back": c.reference_back,
    }


def _asset_dict(a: DramaAsset) -> dict:
    try:
        tags = json.loads(a.tags) if a.tags else []
    except (ValueError, TypeError):
        tags = []
    return {
        "id": a.id,
        "kind": a.kind,
        "name": a.name,
        "description": a.description,
        "visual_prompt": a.visual_prompt,
        "ref_image": a.ref_image,
        "ref_audio": a.ref_audio,
        "voice_name": a.voice_name,
        "reference_front": a.reference_front,
        "reference_side": a.reference_side,
        "reference_back": a.reference_back,
        "tags": tags,
        "created_at": a.created_at.isoformat(),
        "updated_at": a.updated_at.isoformat(),
    }


def _candidate_dict(c: DramaShotCandidate) -> dict:
    return {
        "id": c.id,
        "shot_id": c.shot_id,
        "project_id": c.project_id,
        "url": c.url,
        "seed": c.seed,
        "video_model": c.video_model,
        "status": c.status,
        "is_picked": c.is_picked,
        "error": c.error,
        "created_at": c.created_at.isoformat(),
    }


def _shot_dict(s: DramaShot, session: Session | None = None) -> dict:
    try:
        chars = json.loads(s.characters) if s.characters else []
    except (ValueError, TypeError):
        chars = []
    try:
        layout = json.loads(s.scene_layout) if s.scene_layout else None
    except (ValueError, TypeError):
        layout = None
    try:
        continue_urls = json.loads(s.continue_urls) if s.continue_urls else []
    except (ValueError, TypeError):
        continue_urls = []
    try:
        detected_colors = json.loads(s.detected_colors) if s.detected_colors else None
    except (ValueError, TypeError):
        detected_colors = None
    candidates: list[dict] = []
    if session is not None:
        rows = session.exec(
            select(DramaShotCandidate).where(DramaShotCandidate.shot_id == s.id)
        ).all()
        candidates = [_candidate_dict(c) for c in rows]
    return {
        "id": s.id,
        "project_id": s.project_id,
        "idx": s.idx,
        "scene": s.scene,
        "prompt": s.prompt,
        "negative": s.negative,
        "characters": chars,
        "dialogue": s.dialogue,
        "speaker": s.speaker,
        "duration_sec": s.duration_sec,
        "start_sec": s.start_sec,
        "grid_image": s.grid_image,
        "scene_layout": layout,
        "video_model": s.video_model,
        "mood": s.mood,
        "beat": s.beat,
        "seam_to_next": s.seam_to_next,
        "seam_anchor": s.seam_anchor,
        "video_status": s.video_status,
        "video_url": s.video_url,
        "voice_status": s.voice_status,
        "voice_url": s.voice_url,
        "lipsync_status": s.lipsync_status,
        "lipsync_video_url": s.lipsync_video_url,
        "continue_status": s.continue_status,
        "continue_urls": continue_urls,
        "continue_concat_url": s.continue_concat_url,
        "continue_error": s.continue_error,
        "detected_colors": detected_colors,
        "seed": s.seed,
        "error": s.error,
        "candidates": candidates,
        "updated_at": s.updated_at.isoformat(),
    }


def _append_process(p: DramaProject, step: str, detail: str = "") -> None:
    """M4: 追加一条创作过程记录到 process_data(对标 LibTV 查看制作过程)。"""
    try:
        steps = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        steps = []
    steps.append({
        "step": step,
        "detail": detail,
        "ts": _now().isoformat(),
    })
    p.process_data = json.dumps(steps, ensure_ascii=False)


# ===========================================================================
# 鉴权辅助
# ===========================================================================
def _owned_project(pid: str, user: User, session: Session) -> DramaProject:
    p = session.get(DramaProject, pid)
    if not p or p.user_id != user.id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p


def _owned_shot(sid: str, user: User, session: Session) -> DramaShot:
    s = session.get(DramaShot, sid)
    if not s:
        raise HTTPException(status_code=404, detail="分镜不存在")
    _owned_project(s.project_id, user, session)
    return s


# ===========================================================================
# 项目 CRUD
# ===========================================================================
@router.post("/drama/projects")
def create_project(
    body: ProjectIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = DramaProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=body.title,
        premise=body.premise,
        style=body.style,
        script=body.script,
        width=body.width,
        height=body.height,
        fps=body.fps,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_dict(p)


@router.get("/drama/projects")
def list_projects(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    rows = session.exec(
        select(DramaProject)
        .where(DramaProject.user_id == user.id)
        .order_by(DramaProject.created_at.desc())  # type: ignore[union-attr]
    ).all()
    return [_project_dict(p) for p in rows]


@router.get("/drama/projects/{pid}")
def get_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = _owned_project(pid, user, session)
    out = _project_dict(p)
    # 一并返回角色 + 分镜,前端单次拉齐
    chars = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == pid)
    ).all()
    shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == pid).order_by(DramaShot.idx)
    ).all()
    out["characters"] = [_character_dict(c) for c in chars]
    out["shots"] = [_shot_dict(s, session) for s in shots]
    return out


@router.patch("/drama/projects/{pid}")
def patch_project(
    pid: str,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = _owned_project(pid, user, session)
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(p, k, v)
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_dict(p)


@router.delete("/drama/projects/{pid}")
def delete_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    p = _owned_project(pid, user, session)
    # 级联删除:候选 → 分镜 → 角色 → 项目。
    # 必须用 bulk DELETE 语句按序执行:ORM session.delete 在无 Relationship 时
    # UOW 不按表级 FK 拓扑排序(PG 迁移后 confdeltype=NO ACTION,SQLite 时代靠
    # 驱动不强制 FK 才没炸)。2026-08-05 实测 DELETE dramaproject 先于 dramashot
    # 执行,FK 冲突 500。
    session.exec(
        delete(DramaShotCandidate).where(
            DramaShotCandidate.shot_id.in_(
                select(DramaShot.id).where(DramaShot.project_id == pid)
            )
        )
    )
    session.exec(delete(DramaShot).where(DramaShot.project_id == pid))
    session.exec(delete(DramaCharacter).where(DramaCharacter.project_id == pid))
    session.delete(p)
    # SAFETY 审计:不可逆级联删除留底(标题/规格快照;角色/分镜数)
    from app import audit as _audit

    _audit.record(
        session, user=user, action="project.delete", target_type="drama_project",
        target_id=pid, summary=f"删除短剧项目:{p.title or pid[:8]}",
        detail={"title": p.title, "project_id": pid},
    )
    session.commit()
    return {"ok": True}


# ===========================================================================
# M5: 播放数据反哺创作 —— 分镜级洞察
# ===========================================================================
class ShotPlaybackInsight(BaseModel):
    shot_id: str
    idx: int
    scene: str
    start_sec: float
    duration_sec: int
    enters: int
    drop_offs: int
    avg_watch_sec: float
    completion_rate: float
    retention: float
    replay_count: int
    like_count: int
    mark_good_count: int
    mark_boring_count: int
    share_count: int
    heat_score: float
    suggestions: list[str]


class ProjectPlaybackInsight(BaseModel):
    sessions: int
    plays: int
    completed: int
    completion_rate: float
    avg_watch_sec: float
    engagement_rate: float


class PlaybackInsightsResponse(BaseModel):
    project: ProjectPlaybackInsight
    shots: list[ShotPlaybackInsight]
    generated_at: str


def _shot_time_windows(shots: list[DramaShot]) -> list[tuple[float, float]]:
    """返回每个 shot 的 [start, end] 时间窗口。

    优先使用 shot.start_sec;未组装时按分镜 duration 累加兜底。
    """
    windows: list[tuple[float, float]] = []
    cumulative = 0.0
    for shot in sorted(shots, key=lambda s: s.idx):
        start = shot.start_sec if shot.start_sec > 0 else cumulative
        end = start + shot.duration_sec
        windows.append((start, end))
        cumulative = end
    return windows


def _compute_playback_insights(
    shots: list[DramaShot],
    sessions: list[DramaSession],
    events: list[DramaEvent],
) -> PlaybackInsightsResponse:
    windows = _shot_time_windows(shots)
    total_sessions = len(sessions)
    session_by_id = {s.session_id: s for s in sessions}

    # 按会话聚合事件中的 current_time,用于判断完播/流失
    times_by_session: dict[str, list[float]] = {}
    for ev in events:
        if ev.current_time is None:
            continue
        times_by_session.setdefault(ev.session_id, []).append(ev.current_time)

    # 项目级指标
    plays = len({ev.session_id for ev in events if ev.event_type == "play"})
    completed = sum(1 for s in sessions if s.is_completed)
    avg_watch = (
        sum(s.drop_off_at or 0 for s in sessions) / total_sessions
        if total_sessions
        else 0.0
    )
    engaged_sessions = {
        ev.session_id
        for ev in events
        if ev.event_type in ("like", "mark_good", "mark_boring", "share_click")
    }
    engagement_rate = len(engaged_sessions) / total_sessions if total_sessions else 0.0

    shot_insights: list[ShotPlaybackInsight] = []
    for shot, (start, end) in zip(sorted(shots, key=lambda s: s.idx), windows):
        # 进入该镜的会话(有任意事件落在窗口内)
        entered: set[str] = set()
        for ev in events:
            if ev.current_time is None:
                continue
            if start <= ev.current_time <= end:
                entered.add(ev.session_id)

        enters = len(entered)
        if enters == 0:
            shot_insights.append(
                ShotPlaybackInsight(
                    shot_id=shot.id,
                    idx=shot.idx,
                    scene=shot.scene,
                    start_sec=start,
                    duration_sec=shot.duration_sec,
                    enters=0,
                    drop_offs=0,
                    avg_watch_sec=0.0,
                    completion_rate=0.0,
                    retention=0.0,
                    replay_count=0,
                    like_count=0,
                    mark_good_count=0,
                    mark_boring_count=0,
                    share_count=0,
                    heat_score=0.0,
                    suggestions=["暂无播放数据，发布后可观察该分镜表现。"],
                )
            )
            continue

        # 窗口内观看时长
        watch_times: list[float] = []
        for sid in entered:
            max_t = max(
                (t for t in times_by_session.get(sid, []) if start <= t <= end),
                default=start,
            )
            watch_times.append(max(0.0, min(max_t, end) - start))
        avg_shot_watch = sum(watch_times) / len(watch_times)

        # 完播:以该镜窗口内最后事件 / drop_off 为准,避免被后续镜头播放带偏
        completed_shot = 0
        drop_offs = 0
        for sid in entered:
            sess = session_by_id.get(sid)
            if not sess:
                continue
            in_window = [t for t in times_by_session.get(sid, []) if start <= t <= end]
            last_in_window = max(in_window, default=start)
            if (
                sess.is_completed
                or last_in_window >= end - 1
                or (sess.drop_off_at is not None and sess.drop_off_at >= end - 1)
            ):
                completed_shot += 1
            elif sess.drop_off_at is not None and start <= sess.drop_off_at <= end:
                drop_offs += 1

        completion_rate = completed_shot / enters

        # 互动/重播按会话去重,避免同一用户多次点击刷量扭曲指标
        replay_sessions: set[str] = set()
        like_sessions: set[str] = set()
        mark_good_sessions: set[str] = set()
        mark_boring_sessions: set[str] = set()
        share_sessions: set[str] = set()
        for ev in events:
            if ev.current_time is None:
                continue
            if not (start <= ev.current_time <= end):
                continue
            if ev.event_type == "replay":
                replay_sessions.add(ev.session_id)
            elif ev.event_type == "like":
                like_sessions.add(ev.session_id)
            elif ev.event_type == "mark_good":
                mark_good_sessions.add(ev.session_id)
            elif ev.event_type == "mark_boring":
                mark_boring_sessions.add(ev.session_id)
            elif ev.event_type == "share_click":
                share_sessions.add(ev.session_id)

        replay_count = len(replay_sessions)
        like_count = len(like_sessions)
        mark_good_count = len(mark_good_sessions)
        mark_boring_count = len(mark_boring_sessions)
        share_count = len(share_sessions)

        retention = enters / total_sessions if total_sessions else 0.0
        engagement_count = len(
            like_sessions | mark_good_sessions | mark_boring_sessions | share_sessions
        )

        # 热度分(0-100):留存 40% + 完播 30% + 互动率 20% + 重播率 10%
        replay_rate = replay_count / enters
        engagement_rate_shot = engagement_count / enters
        heat_score = min(
            100.0,
            retention * 40
            + completion_rate * 30
            + engagement_rate_shot * 20
            + replay_rate * 10,
        )

        # 生成建议
        suggestions: list[str] = []
        if total_sessions > 0 and retention < 0.2:
            suggestions.append("曝光占比低，可尝试前置该镜或优化封面/标题吸引点击。")
        if drop_offs / enters > 0.4:
            suggestions.append("该镜流失严重，建议缩短时长、加快节奏或强化视觉钩子。")
        if completion_rate >= 0.8:
            suggestions.append("完播率高，是留住用户的关键镜头，建议保持当前叙事节奏。")
        if replay_rate > 0.3:
            suggestions.append("用户反复回看，适合作为预告/封面高光或二创切片。")
        if like_count / enters > 0.2 or mark_good_count / enters > 0.2:
            suggestions.append("高互动片段，可在社交媒体引导点赞与转发。")
        if mark_boring_count / enters > 0.2:
            suggestions.append("被标记为无聊，建议精简台词、增加冲突或替换画面。")
        if not suggestions:
            suggestions.append("表现平稳，继续观察累计数据后再决策。")

        shot_insights.append(
            ShotPlaybackInsight(
                shot_id=shot.id,
                idx=shot.idx,
                scene=shot.scene,
                start_sec=start,
                duration_sec=shot.duration_sec,
                enters=enters,
                drop_offs=drop_offs,
                avg_watch_sec=round(avg_shot_watch, 2),
                completion_rate=round(completion_rate, 3),
                retention=round(retention, 3),
                replay_count=replay_count,
                like_count=like_count,
                mark_good_count=mark_good_count,
                mark_boring_count=mark_boring_count,
                share_count=share_count,
                heat_score=round(heat_score, 1),
                suggestions=suggestions,
            )
        )

    return PlaybackInsightsResponse(
        project=ProjectPlaybackInsight(
            sessions=total_sessions,
            plays=plays,
            completed=completed,
            completion_rate=round(completed / total_sessions, 3) if total_sessions else 0.0,
            avg_watch_sec=round(avg_watch, 2),
            engagement_rate=round(engagement_rate, 3),
        ),
        shots=shot_insights,
        generated_at=_now().isoformat(),
    )


@router.get("/drama/projects/{pid}/playback-insights")
def get_playback_insights(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> PlaybackInsightsResponse:
    """基于真实播放埋点，生成项目级 + 分镜级创作建议。"""
    _owned_project(pid, user, session)
    shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == pid).order_by(DramaShot.idx)
    ).all()
    sessions = session.exec(
        select(DramaSession).where(DramaSession.drama_id == pid)
    ).all()
    events = session.exec(
        select(DramaEvent).where(DramaEvent.drama_id == pid)
    ).all()
    return _compute_playback_insights(shots, sessions, events)


# ===========================================================================
# 剧本 → 分镜 LLM 拆解
# ===========================================================================
def _parse_json_obj(text: str) -> dict | None:
    # 共用实现 app.jsonutil.parse_json_obj,锚定 "shots" 键做平衡括号匹配
    return parse_json_obj(text, anchors=('{"shots"', "{'shots'", '"shots"'))


def _build_user_prompt(script: str, num_shots: int, style: str | None,
                       characters: list[DramaCharacter]) -> str:
    lines = [f"剧本:{script}", f"镜头数量:{num_shots}"]
    if style:
        lines.append(f"整体风格:{style}")
    if characters:
        roster = "; ".join(
            f"{c.name}({c.description})" if c.description else c.name
            for c in characters
        )
        lines.append(f"出场角色:{roster}")
    return "\n".join(lines)


# ===========================================================================
# 剧本拆解 LLM 输出模型(pydantic v2 validation_context 注入合法角色名集合,
# 参照 DramaClaw literal_script_writing;无 pydantic-ai 依赖,用原生 context)
# ===========================================================================
class ShotOut(BaseModel):
    """LLM 拆解的单个镜头输出(键对齐旧 _coerce_shot 手工规整产物)。

    字段级 before-validator 复刻旧手工规整行为(字符串 strip / duration 钳制
    2-15 / characters 非数组回退空);characters 额外按 validation_context 中的
    valid_character_names 做合法集合校验(精确命中通过、近匹配纠正、新名放行)。
    """

    scene: str = ""
    prompt: str = ""
    characters: list[str] = Field(default_factory=list)
    dialogue: str = ""
    speaker: str = ""
    duration_sec: int = Field(default=6, ge=2, le=15)
    # P1 衔接策略层:与下一镜的接缝策略(空=未规划)+ 共享锚体描述
    seam_to_next: str = ""
    seam_anchor: str = ""
    # WORKBENCH 补齐:情绪标签/叙事节拍(LLM 拆解产出,前端 ShotTableRow 行内可编)
    mood: str = ""
    beat: str = ""

    @field_validator("scene", "prompt", "dialogue", "speaker", "seam_anchor", mode="before")
    @classmethod
    def _normalize_str(cls, v: object) -> str:
        # 等价旧 _coerce_shot:任意类型 str() 化并 strip,None/0/False → ""
        return str(v or "").strip()

    @field_validator("mood", "beat", mode="before")
    @classmethod
    def _normalize_mood_beat(cls, v: object, info: ValidationInfo) -> str:
        # LLM 输出不可信:strip + 按 ShotPatch 上限截断(mood 64 / beat 200),不阻断
        limit = 64 if info.field_name == "mood" else 200
        return str(v or "").strip()[:limit]

    @field_validator("seam_to_next", mode="before")
    @classmethod
    def _normalize_seam(cls, v: object) -> str:
        return str(v or "").strip().lower()

    @field_validator("seam_to_next")
    @classmethod
    def _seam_domain(cls, v: str) -> str:
        # 枚举域(continue/overlap/matchcut/hardcut);域外值(LLM 自由发挥)
        # 按未规划回落空串,不阻断整段拆解(grid-storyboard 共用本模型,无重试通道)
        return v if v in _SEAM_KINDS else ""

    @field_validator("duration_sec", mode="before")
    @classmethod
    def _clamp_duration(cls, v: object) -> int:
        # 等价旧逻辑:非数字回退 6,再钳制 [2,15](ge/le 兜底硬约束)
        try:
            d = int(v or 6)
        except (ValueError, TypeError):
            d = 6
        return max(2, min(d, 15))

    @field_validator("characters", mode="before")
    @classmethod
    def _normalize_characters(cls, v: object, info: ValidationInfo) -> list[str]:
        if not isinstance(v, list):
            return []
        names = [s for s in (str(c).strip() for c in v) if s]
        return reconcile_character_names(names, info.context, log=logger)


class ShotAnalysisOut(BaseModel):
    """LLM 拆解的顶层输出(shots 至少 1 条;缺字段/类型错抛 ValidationError)。"""

    shots: list[ShotOut] = Field(min_length=1)

    @model_validator(mode="after")
    def _last_shot_no_seam(self) -> "ShotAnalysisOut":
        # 末镜没有「下一镜」,seam_to_next 强制置空(LLM 违例就地纠正,不阻断)
        if self.shots:
            self.shots[-1].seam_to_next = ""
        return self


def _coerce_shot(raw: object, index: int) -> dict:
    """把 LLM 返回的单个镜头对象规整成 dict(委托 ShotOut 校验,行为与历史实现等价)。

    grid-storyboard / from-image 共用;无 validation_context 注入 → 角色名原样放行。
    index 参数仅为兼容既有调用签名保留。
    """
    obj = raw if isinstance(raw, dict) else {}
    return ShotOut.model_validate(obj).model_dump()


def _job_wait_timeout(cap: float) -> float:
    """wait_for_jobs 本地等待窗口:取既有上限与 tracker 作业生命周期的较小值。

    tracker 在 settings.job_track_timeout(默认 7200s)到达后把作业标 error 回收,
    本地等待超过该窗口没有意义;cap 保留各链路原有语义(后台回写 900s / 同步等待 600s)。
    """
    return min(cap, get_settings().job_track_timeout)


async def _request_storyboard_analysis(
    *,
    script: str,
    num_shots: int,
    style: str | None,
    characters: list[DramaCharacter],
    layer: str,
    pid: str,
) -> "ShotAnalysisOut":
    """调 LLM 拆解剧本 + pydantic validation_context 校验(合法角色名集合硬约束)。

    校验策略(与既有「新角色自动建行」特性兼容,见 ShotOut):
      ① 角色名精确命中项目角色集合 → 通过;
      ② 大小写/空白近匹配 → 自动纠正为集合内名字(logger.info 留痕);
      ③ 全新名字 → 放行并记入 new_characters(logger.info),由
        _create_shots_from_analysis 走既有自动建行路径;
      ④ 输出结构非法(非 JSON / shots 缺字段或类型错)→ ValidationError,
        把错误摘要反馈进 user prompt 重调 LLM 重试一次;仍失败 → HTTPException(502)。
    LLM 不可用 → HTTPException(503)(旧语义不变)。
    """
    valid_names = [c.name for c in characters if c.name and c.name.strip()]
    # validation_context:合法角色名集合 + new_characters 收集桶(校验器就地追加)
    vctx: dict[str, Any] = {"valid_character_names": valid_names, "new_characters": []}
    last_error: str | None = None
    for attempt in (1, 2):
        user_prompt = _build_user_prompt(script, num_shots, style, characters)
        if last_error:
            # 校验失败重试:错误摘要反馈进 prompt,给 LLM 一次自我修正机会
            user_prompt += (
                "\n\n【上次输出未通过结构校验,请修正后重新输出完整 JSON】\n" + last_error
            )
            logger.info(
                "storyboard 校验失败,携带错误摘要重试 project=%s attempt=%d err=%s",
                pid, attempt, last_error,
            )
        try:
            # 默认走配置层;L2/L3 当前依赖 EXO,未就绪时会自动降级,默认 L1 保证可用性。
            msg = await get_ctx().service("llm").chat_layered(
                [
                    {"role": "system", "content": _STORYBOARD_SYSTEM},
                    {"role": "user", "content": user_prompt},
                ],
                layer=layer,
                max_tokens=8192,
                temperature=0.5,
            )
        except llm.LLMError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e

        raw = (msg.get("content") or "").strip()
        obj = _parse_json_obj(raw)
        if obj is None:
            logger.warning(
                "storyboard parse failed layer=%s project=%s raw_length=%d raw_preview=%s",
                layer, pid, len(raw), raw[:800].replace("\n", " "),
            )
            last_error = "输出不是合法 JSON 对象"
            continue
        # 与旧行为一致:多余镜头先截断再校验(截断外的坏数据不阻断)
        shots_raw = obj.get("shots")
        if isinstance(shots_raw, list):
            obj = {**obj, "shots": shots_raw[:num_shots]}
        try:
            out = ShotAnalysisOut.model_validate(obj, context=vctx)
        except ValidationError as e:
            last_error = "; ".join(
                f"{'.'.join(str(x) for x in err.get('loc', ()))}: {err.get('msg', '')}"
                for err in e.errors()[:5]
            )
            logger.warning(
                "storyboard validation failed layer=%s project=%s err=%s",
                layer, pid, last_error,
            )
            continue
        new_names = vctx.get("new_characters") or []
        if new_names:
            logger.info(
                "storyboard project=%s LLM 报出新角色 %s,放行待自动建行", pid, new_names
            )
        return out
    raise HTTPException(
        status_code=502, detail=f"分镜生成失败,请重试({last_error or '未知错误'})"
    )


def _create_shots_from_analysis(
    p: DramaProject,
    coerced: list[dict],
    session: Session,
    *,
    log_step: str = "storyboard",
    log_detail: str | None = None,
) -> list[DramaShot]:
    """把 LLM 拆解出的分镜落库:清旧分镜 → 自动建角色 → 注入角色视觉 token → 建行。

    storyboard / from-image 共用。置 p.status="storyboard" 并追加过程记录后 commit;
    不写 p.script(由调用方各自处理)。返回新建分镜列表(已 refresh)。
    """
    # 清掉旧分镜(重新拆解),角色库保留
    for old in session.exec(select(DramaShot).where(DramaShot.project_id == p.id)).all():
        session.delete(old)
    session.flush()

    characters = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == p.id)
    ).all()
    # 把角色视觉 token 注入到分镜 prompt(角色一致性)
    char_map = {c.name: c for c in characters}
    # 自动创建 LLM 识别出的新角色
    _seen_chars: set[str] = set()
    for sc in coerced:
        for cname in sc.get("characters", []):
            if cname and cname not in char_map and cname not in _seen_chars:
                _seen_chars.add(cname)
                nc = DramaCharacter(project_id=p.id, name=cname)
                session.add(nc)
                char_map[cname] = nc
    session.flush()

    created: list[DramaShot] = []
    for i, sc in enumerate(coerced):
        # 注入出场角色的视觉 token
        prompt = sc["prompt"]
        for cname in sc["characters"]:
            ch = char_map.get(cname)
            if ch and ch.visual_prompt:
                # 把角色 token 前置注入(主体描述前)
                prompt = f"{ch.visual_prompt}, {prompt}" if prompt else ch.visual_prompt
        shot = DramaShot(
            project_id=p.id,
            idx=i,
            scene=sc["scene"],
            prompt=prompt,
            characters=json.dumps(sc["characters"], ensure_ascii=False),
            dialogue=sc["dialogue"],
            speaker=sc["speaker"],
            duration_sec=sc["duration_sec"],
            # P1 衔接策略层:LLM 规划的接缝策略/锚点落库(缺省空=未规划)
            seam_to_next=sc.get("seam_to_next", ""),
            seam_anchor=sc.get("seam_anchor", ""),
            # 情绪标签/叙事节拍(LLM 拆解产出落库,缺省空)
            mood=sc.get("mood", ""),
            beat=sc.get("beat", ""),
            width=p.width,
            height=p.height,
        )
        session.add(shot)
        created.append(shot)

    p.status = "storyboard"
    _append_process(p, log_step, log_detail or f"LLM 拆解出 {len(created)} 个分镜")
    session.add(p)
    session.commit()
    for s in created:
        session.refresh(s)
    return created


@router.post("/drama/projects/{pid}/storyboard")
async def storyboard(
    pid: str,
    body: StoryboardRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """剧本 → 分镜 LLM 拆解,落库并返回分镜列表。

    会先清掉该项目既有分镜(重新拆解),角色库保留。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    script = body.script if body.script else p.script
    if not script.strip():
        raise HTTPException(status_code=422, detail="剧本为空,无法拆解")
    style = body.style if body.style else p.style
    characters = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == pid)
    ).all()

    layer = get_settings().drama_storyboard_layer.upper()
    if layer not in ("L1", "L2", "L3", "L4"):
        layer = "L1"
    # LLM 拆解 + validation_context 校验(合法角色名集合注入);结构非法重试一次
    analysis = await _request_storyboard_analysis(
        script=script,
        num_shots=body.num_shots,
        style=style,
        characters=characters,
        layer=layer,
        pid=pid,
    )
    coerced = [s.model_dump() for s in analysis.shots]
    if not any(s["prompt"] for s in coerced):
        logger.warning(
            "storyboard no valid prompts layer=%s project=%s shots=%s",
            layer, pid, coerced
        )
        raise HTTPException(status_code=502, detail="分镜生成失败(无有效提示词),请重试")

    # p.script 留在端点层(提取出的 _create_shots_from_analysis 不写 script)
    p.script = script
    created = _create_shots_from_analysis(p, coerced, session)
    return {"shots": [_shot_dict(s, session) for s in created]}


# ===========================================================================
# 角色库 CRUD
# ===========================================================================
@router.post("/drama/projects/{pid}/characters")
def create_character(
    pid: str,
    body: CharacterIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    project = _owned_project(pid, user, session)
    # M2:如果指定了 asset_id,校验资产存在且同租户
    if body.asset_id:
        asset = session.get(DramaAsset, body.asset_id)
        if not asset or asset.tenant_id != user.tenant_id:
            raise HTTPException(status_code=404, detail="关联资产不存在")
    # M2:从资产自动填充缺失字段
    asset = session.get(DramaAsset, body.asset_id) if body.asset_id else None
    c = DramaCharacter(
        project_id=pid,
        asset_id=body.asset_id,
        name=body.name,
        description=body.description or (asset.description if asset else ""),
        visual_prompt=body.visual_prompt or (asset.visual_prompt if asset else ""),
        ref_image=body.ref_image or (asset.ref_image if asset else ""),
        ref_audio=body.ref_audio or (asset.ref_audio if asset else ""),
        voice_name=body.voice_name or (asset.voice_name if asset else ""),
        reference_front=asset.reference_front if asset else "",
        reference_side=asset.reference_side if asset else "",
        reference_back=asset.reference_back if asset else "",
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_dict(c)


@router.get("/drama/projects/{pid}/characters")
def list_characters(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    _owned_project(pid, user, session)
    rows = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == pid)
    ).all()
    return [_character_dict(c) for c in rows]


@router.patch("/drama/characters/{cid}")
def patch_character(
    cid: str,
    body: CharacterPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    c = session.get(DramaCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _owned_project(c.project_id, user, session)
    # M2:变更 asset_id 时校验资产归属
    if body.asset_id is not None:
        if body.asset_id:
            asset = session.get(DramaAsset, body.asset_id)
            if not asset or asset.tenant_id != user.tenant_id:
                raise HTTPException(status_code=404, detail="关联资产不存在")
    data = body.model_dump(exclude_unset=True)
    for k, v in data.items():
        setattr(c, k, v)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_dict(c)


@router.delete("/drama/characters/{cid}")
def delete_character(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    c = session.get(DramaCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _owned_project(c.project_id, user, session)
    session.delete(c)
    from app import audit as _audit

    _audit.record(
        session, user=user, action="character.delete", target_type="drama_character",
        target_id=cid, summary=f"删除短剧角色:{c.name or cid[:8]}",
        detail={"name": c.name, "project_id": c.project_id},
    )
    session.commit()
    return {"ok": True}


def _owned_asset(aid: str, user: User, session: Session) -> DramaAsset:
    a = session.get(DramaAsset, aid)
    if not a or a.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="资产不存在")
    return a


# ===========================================================================
# M2:跨项目资产库 CRUD
# ===========================================================================
@router.post("/drama/assets")
def create_asset(
    body: AssetIn,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = DramaAsset(
        tenant_id=user.tenant_id,
        user_id=user.id,
        kind=body.kind,
        name=body.name,
        description=body.description,
        visual_prompt=body.visual_prompt,
        ref_image=body.ref_image,
        ref_audio=body.ref_audio,
        voice_name=body.voice_name,
        reference_front=body.reference_front,
        reference_side=body.reference_side,
        reference_back=body.reference_back,
        tags=json.dumps(body.tags, ensure_ascii=False),
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _asset_dict(a)


@router.get("/drama/assets")
def list_assets(
    kind: str | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    stmt = select(DramaAsset).where(DramaAsset.tenant_id == user.tenant_id)
    if kind:
        stmt = stmt.where(DramaAsset.kind == kind)
    rows = session.exec(stmt.order_by(DramaAsset.updated_at.desc())).all()
    return {"assets": [_asset_dict(a) for a in rows]}


@router.patch("/drama/assets/{aid}")
def patch_asset(
    aid: str,
    body: AssetPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = _owned_asset(aid, user, session)
    data = body.model_dump(exclude_unset=True)
    if "tags" in data:
        data["tags"] = json.dumps(data["tags"], ensure_ascii=False)
    for k, v in data.items():
        setattr(a, k, v)
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    return _asset_dict(a)


@router.delete("/drama/assets/{aid}")
def delete_asset(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = _owned_asset(aid, user, session)
    session.delete(a)
    session.commit()
    return {"ok": True}


@router.post("/drama/assets/{aid}/apply-to-project")
def apply_asset_to_project(
    aid: str,
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    a = _owned_asset(aid, user, session)
    _owned_project(pid, user, session)
    c = DramaCharacter(
        project_id=pid,
        asset_id=a.id,
        name=a.name,
        description=a.description,
        visual_prompt=a.visual_prompt,
        ref_image=a.ref_image,
        ref_audio=a.ref_audio,
        voice_name=a.voice_name,
        reference_front=a.reference_front,
        reference_side=a.reference_side,
        reference_back=a.reference_back,
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_dict(c)


def _shot_characters(shot: DramaShot, session: Session) -> list[DramaCharacter]:
    """返回该分镜出场角色对应的数据库记录。"""
    try:
        names = json.loads(shot.characters) if shot.characters else []
    except (ValueError, TypeError):
        names = []
    if not names:
        return []
    chars = session.exec(
        select(DramaCharacter).where(
            DramaCharacter.project_id == shot.project_id,
            DramaCharacter.name.in_(names),
        )
    ).all()
    return list(chars)


async def _wait_result_files(client, prompt_id: str, timeout: float = 180.0) -> list[dict]:
    """同步等待 ComfyUI 工作流产物。"""
    start = time.monotonic()
    while time.monotonic() - start < timeout:
        try:
            files = await client.get_result_files(prompt_id)
            if files:
                return files
        except ComfyUIError:
            pass
        await asyncio.sleep(1.5)
    return []


async def _generate_keyframe_for_shot(
    client,
    shot: DramaShot,
    project: DramaProject,
    settings,
    session: Session,
    pool: WorkerPool,
) -> str | None:
    """为分镜生成带角色一致性的首帧图,返回上传到 worker input 后的文件名。

    仅当分镜有关联角色且角色有 ref_image 时执行;失败时返回 None,调用方应回退到 t2v。

    注意:IPAdapter 构图(ipadapter.py)用 CheckpointLoaderSimple,仅兼容传统
    checkpoint 底模;次世代 UNET 底模(flux2/qwen_image/z_image,当前默认
    settings.default_ckpt=flux2_dev)未与 IPAdapter 打通(与 manju._build_shot_graph
    的次世代降级一致)。次世代场景改用 PuLID-Flux 首帧链(workflows/pulid.py,
    FLUX.1 底模 settings.pulid_flux_ckpt,PuLID-Flux v0.9.1 仅适配 FLUX.1);
    pool 探测不可用(缺 PuLID 节点/底模)时明确记 warning 并回退 t2v,
    不再硬塞 UNET 模型进 CheckpointLoaderSimple(worker 找不到该 checkpoint,
    异常被吞后静默回退)。
    """
    chars = _shot_characters(shot, session)
    ref_char = next((c for c in chars if c.ref_image.strip()), None)
    if not ref_char:
        return None

    ref_url = ref_char.ref_image.strip()
    if not _allowed_ref(ref_url):
        logger.warning("角色 %s 参考图来源不在白名单: %s", ref_char.name, ref_url)
        return None

    # 次世代 UNET 底模不支持 IPAdapter;优先尝试 PuLID-Flux(FLUX.1)角色首帧,
    # pool 探测不可用时回退 t2v(见 docstring)
    nextgen = is_nextgen(settings.default_ckpt)
    pulid_ckpt = getattr(settings, "pulid_flux_ckpt", "") or ""
    if nextgen:
        if not pulid_ckpt or not await pulid_is_available(pool, pulid_ckpt):
            logger.warning(
                "分镜 #%s 跳过 PuLID 角色首帧:默认底模 %s 为次世代 UNET 模型,"
                "且 PuLID-Flux 链不可用(缺节点或底模 %s),回退 t2v",
                shot.idx,
                settings.default_ckpt,
                pulid_ckpt,
            )
            return None

    try:
        ref_bytes = await _fetch_ref_image_bytes(pool, ref_url)
        ref_fn = await client.upload_image(
            ref_bytes, f"drama_ref_{uuid.uuid4().hex}.png"
        )

        if nextgen:
            # PuLID-Flux:FLUX.1 底模 + 角色参考图注入脸一致性
            pulid_params = PulidTxt2ImgParams(
                positive=shot.prompt,
                ref_image=ref_fn,
                ckpt_name=pulid_ckpt,
                width=_snap8(project.width),
                height=_snap8(project.height),
                filename_prefix=f"ToIV_drama_keyframe{shot.idx}",
            )
            graph = build_pulid_txt2img_graph(pulid_params)
        else:
            # 传统 checkpoint 底模:走 IPAdapter txt2img,注入角色脸一致性
            ipa_params = IPAdapterTxt2ImgParams(
                positive=shot.prompt,
                ref_image=ref_fn,
                ckpt_name=settings.default_ckpt,
                width=_snap8(project.width),
                height=_snap8(project.height),
                filename_prefix=f"ToIV_drama_keyframe{shot.idx}",
            )
            graph = build_ipadapter_txt2img_graph(ipa_params)
        client_id = uuid.uuid4().hex
        prompt_id = await client.queue_prompt(graph, client_id)
        files = await _wait_result_files(client, prompt_id, timeout=180.0)
        if not files:
            logger.warning("首帧生成无产物,分镜 #%s 回退到 t2v", shot.idx)
            return None

        f = files[0]
        img_bytes, _ = await client.get_image_bytes(
            f["filename"], f.get("subfolder", ""), f.get("type", "output")
        )
        keyframe_fn = await client.upload_image(
            img_bytes, f"drama_kf_{uuid.uuid4().hex}.png"
        )
        logger.info(
            "分镜 #%s 生成角色一致首帧: ref=%s keyframe=%s",
            shot.idx,
            ref_char.name,
            keyframe_fn,
        )
        return keyframe_fn
    except Exception as e:  # noqa: BLE001
        logger.warning("首帧生成异常,分镜 #%s 回退到 t2v: %s", shot.idx, e)
        return None


# ===========================================================================
# 单分镜视频生成(LTX t2v / i2v)
# ===========================================================================
def _prev_shot(session: Session, shot: DramaShot) -> DramaShot | None:
    """同项目内 idx-1 的前一镜(首镜/缺行返回 None)。"""
    if shot.idx <= 0:
        return None
    return session.exec(
        select(DramaShot).where(
            DramaShot.project_id == shot.project_id,
            DramaShot.idx == shot.idx - 1,
        )
    ).first()


def _apply_seam_modifier(
    prompt: str,
    shot: DramaShot,
    prev_shot: DramaShot | None,
    *,
    project: DramaProject | None = None,
) -> str:
    """P1 衔接策略层:前一镜声明 matchcut 接缝时,在本镜生成 prompt 末尾追加
    h3-seam-polish 转场约束(modifier 是管线行为,非用户 prompt 一部分——
    prompt_override 存在时同样追加)。其余接缝/首镜/技能未注册时原样返回。
    direction 槽位按项目画幅推导(横屏→横向,竖屏→纵向)。
    """
    if prev_shot is None or prev_shot.seam_to_next != "matchcut":
        return prompt
    if skills_registry.get("h3-seam-polish") is None:
        return prompt
    anchor = prev_shot.seam_anchor or "上一镜头主导视觉锚点"
    w = (project.width if project else 0) or getattr(shot, "width", 0) or 0
    h = (project.height if project else 0) or getattr(shot, "height", 0) or 0
    direction = "横向" if w >= h else "纵向"
    block = skills_registry.render(
        "h3-seam-polish", anchor=anchor, direction=direction
    ).strip()
    return f"{prompt}\n\n{block}" if prompt else block


async def _submit_shot_video(
    shot: DramaShot,
    project: DramaProject,
    *,
    pool: WorkerPool,
    session: Session,
    user: User,
    worker: str | None = None,
    steps: int = 20,
    cfg: float = 1.0,
    seed: int | None = None,
    use_upscale: bool = False,
    use_rife: bool = False,
    prompt_override: str | None = None,
    first_image_bytes: bytes | None = None,
    nsfw: bool = False,
) -> tuple[str, str, str, int]:
    """提交单分镜视频生成作业(LTX t2v / i2v),返回 (prompt_id, client_id, worker, seed)。

    generate-video 端点与 from-image 自动管线共用。first_image_bytes 非空时
    (from-image 首镜):把上传原图直接传到选中的 worker 作 i2v 首帧;
    上传失败回退到常规 IPAdapter 首帧,再退 t2v。
    nsfw=True 时用 NSFW 专用视频底模(10Eros),否则用 SFW 默认(ltx-2.3-22b-distilled-1.1)。
    """
    prompt = (prompt_override or shot.prompt).strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="分镜提示词为空")
    # P1 衔接策略层:前一镜 matchcut 时追加 h3-seam-polish 转场约束
    prompt = _apply_seam_modifier(prompt, shot, _prev_shot(session, shot), project=project)

    # 选 worker
    if worker:
        client = resolve_worker(worker)
    else:
        from app.capabilities import required_nodes, required_models
        try:
            client = await pool.pick(
                required=required_models("ltx_t2v"),
                required_nodes=required_nodes("ltx_t2v"),
            )
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e
        if client is None:
            raise HTTPException(status_code=503, detail="无可用 worker(缺 LTX 模型)")

    settings = get_settings()
    # SFW/NSFW 视频底模分流:nsfw=True 才用 10Eros 成人底模,否则 SFW 默认(ltx-2.3-distilled)
    video_ckpt = settings.nsfw_default_video_ckpt if nsfw else settings.default_video_ckpt
    seed_used = seed if seed is not None else LtxT2VParams(positive="").seed

    # 首帧:from-image 上传原图优先;否则角色一致性 IPAdapter 首帧;都没有则 t2v
    keyframe_fn: str | None = None
    if first_image_bytes is not None:
        try:
            keyframe_fn = await client.upload_image(
                first_image_bytes, f"drama_fromimg_{uuid.uuid4().hex}.png"
            )
        except Exception as e:  # noqa: BLE001
            logger.warning("分镜 #%s 首帧原图上传失败,回退常规首帧: %s", shot.idx, e)
    if keyframe_fn is None:
        # 角色一致性：若分镜有关联角色且角色有 ref_image，先生成带 IPAdapter 的高质量首帧
        keyframe_fn = await _generate_keyframe_for_shot(
            client, shot, project, settings, session, pool
        )

    common_params = {
        "positive": prompt,
        "negative": shot.negative,
        "unet_name": video_ckpt,
        "gemma_name": settings.nsfw_default_gemma,
        "vae_name": settings.nsfw_default_vae,
        "width": project.width,
        "height": project.height,
        "length": max(9, int(project.fps * shot.duration_sec)),
        "fps": project.fps,
        "steps": steps,
        "cfg": cfg,
        "seed": seed_used,
        "use_upscale": use_upscale,
        "use_rife": use_rife,
        "filename_prefix": f"ToIV_drama_shot{shot.idx}",
    }
    if keyframe_fn:
        params = LtxI2VParams(image=keyframe_fn, **common_params)
        graph = build_ltx_i2v_graph(params)
        video_kind = "drama_shot_video_i2v"
    else:
        params = LtxT2VParams(**common_params)
        graph = build_ltx_t2v_graph(params)
        video_kind = "drama_shot_video"

    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        shot.video_status = "error"
        shot.error = str(e)
        session.add(shot)
        session.commit()
        status = e.status_code if e.status_code is not None else 502
        if status < 400 or status == 500:
            status = 502
        raise HTTPException(status_code=status, detail=str(e)) from e

    # Job 参数快照:重建等价请求模型,快照结构与原端点实现一致
    req = GenerateVideoRequest(
        worker=worker,
        seed=seed,
        steps=steps,
        cfg=cfg,
        use_upscale=use_upscale,
        use_rife=use_rife,
        nsfw=nsfw,
        prompt_override=prompt_override,
    )
    # 落 Job(便于全局作业追踪 + 历史页查看)
    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind=video_kind,
            status="queued",
            prompt=prompt,
            seed=seed_used,
            nsfw=nsfw,  # NSFW 底模打标保历史页过滤
            params=params_snapshot(req, seed=seed_used),
        )
    )
    # 分镜状态置 generating,记录 seed
    shot.video_status = "generating"
    shot.video_url = ""  # 重置,等 tracker 落库后前端刷新
    shot.seed = seed_used
    shot.error = ""
    _append_process(project, "generate_video", f"分镜 #{shot.idx} 提交生成(seed={seed_used})")
    session.add(shot)
    session.commit()

    # 后台追踪结果(独立于客户端 SSE),完成后通过 GET 分镜查 video_url
    spawn_tracker(client, prompt_id)
    return prompt_id, client_id, client.base_url, seed_used


async def _await_shot_video_writeback(sid: str, prompt_id: str) -> bool:
    """等待 tracker 完成并把 video_url 回写到 DramaShot;返回是否成功回写。

    generate-video 端点 fire-and-forget 调用;from-image 自动管线则 await 串行等待。

    预算内循环续等(2026-08-15 永久 generating 修复):单轮等待窗口(≤900s)远短于
    tracker 作业生命周期,排队作业(如 H3 单实例多镜排队 ~6min/镜)极易超窗;此前
    「超时豁免」直接 return,之后 Job done 也无人回写 → 分镜永久 generating。现改为
    以 settings.job_track_timeout(默认 7200s,与 tracker 兜底窗口对齐)为总预算
    循环续等:每轮 wait_for_jobs(min(900, 剩余预算)),超时后 commit 刷新快照重读
    Job——done 有产物 → 回写返回 True;error / 不存在 → 抛出走通用标 error 路径;
    仍非终态且预算未尽 → 续等下一轮;预算耗尽 → 标 error(超出 tracker 兜底窗口)。
    作业已 error / 不存在等其他异常路径维持标 error 旧语义不变。
    """
    from app.db import engine
    try:
        with Session(engine) as s:
            budget = get_settings().job_track_timeout
            deadline = time.monotonic() + budget
            round_no = 0
            while True:
                round_no += 1
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # 预算耗尽:超出 tracker 兜底窗口仍未完成 → 标 error 终态收口
                    shot_obj = s.get(DramaShot, sid)
                    if shot_obj and shot_obj.video_status == "generating":
                        shot_obj.video_status = "error"
                        shot_obj.error = "生成超时(超出 tracker 兜底窗口)"
                        s.add(shot_obj)
                        s.commit()
                    logger.warning(
                        "shot %s video writeback: 等待预算 %.0fs 耗尽,作业 %s 仍未完成,"
                        "标 error 收口",
                        sid, budget, prompt_id,
                    )
                    return False
                wait_err: RuntimeError | None = None
                try:
                    await wait_for_jobs(
                        s, [prompt_id], timeout=_job_wait_timeout(min(900.0, remaining))
                    )
                except RuntimeError as e:
                    wait_err = e  # 先读 Job 最新状态再定性(续等 or 真失败)
                # commit 结束当前读事务快照,确保看到 tracker 其他 Session 的最新提交
                # (与 wait_for_jobs 内每轮 commit 同理)
                s.commit()
                job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                if job and job.status == "done" and job.result:
                    urls = json.loads(job.result)
                    if urls:
                        shot_obj = s.get(DramaShot, sid)
                        if shot_obj:
                            shot_obj.video_url = urls[0]
                            shot_obj.video_status = "done"
                            s.add(shot_obj)
                            s.commit()
                            return True
                if wait_err is not None:
                    if job and job.status not in ("done", "error"):
                        # 仍非终态且预算未尽:续等下一轮(排队/长跑作业不再永久 generating)
                        logger.warning(
                            "shot %s video writeback: 第 %d 轮等待超时但作业 %s 仍为 %s,"
                            "预算内续等(剩余 %.0fs)",
                            sid, round_no, prompt_id, job.status, remaining,
                        )
                        continue
                    raise wait_err  # 作业已 error / 不存在 → 走通用异常标 error(旧语义)
                # wait 正常返回但无产物(job done 但 result 空)→ 失败标记(旧语义)
                shot_obj = s.get(DramaShot, sid)
                if shot_obj and shot_obj.video_status == "generating":
                    shot_obj.video_status = "error"
                    shot_obj.error = "生成失败或超时"
                    s.add(shot_obj)
                    s.commit()
                return False
    except Exception as e:  # noqa: BLE001
        logger.exception("shot %s video writeback failed: %s", sid, e)
        with Session(engine) as s:
            shot_obj = s.get(DramaShot, sid)
            if shot_obj and shot_obj.video_status == "generating":
                shot_obj.video_status = "error"
                shot_obj.error = f"回写异常: {type(e).__name__}: {e}"[:200]
                s.add(shot_obj)
                s.commit()
        return False


@router.post("/drama/shots/{sid}/generate-video")
async def generate_shot_video(
    sid: str,
    body: GenerateVideoRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """单分镜视频生成(LTX t2v)。nsfw=true(10Eros 成人底模)仅限 /nsfw 专区。"""
    enforce_generation_rate_limit(user)
    # R18 门控:nsfw=true 走 NSFW 专用视频底模(10Eros),无 X-NSFW 头一律 403,
    # 与 ltx_studio 选 10eros 底模同款门槛(堵主站直传 nsfw=true 的绕过)
    if body.nsfw:
        _gate_ltx_nsfw(user)
    shot = _owned_shot(sid, user, session)
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    prompt_id, client_id, worker_url, seed = await _submit_shot_video(
        shot,
        project,
        pool=pool,
        session=session,
        user=user,
        worker=body.worker,
        steps=body.steps,
        cfg=body.cfg,
        seed=body.seed,
        use_upscale=body.use_upscale,
        use_rife=body.use_rife,
        prompt_override=body.prompt_override,
        nsfw=body.nsfw,
    )

    # 挂一个回调:tracker 完成后把 video_url 回写到 DramaShot
    _spawn(_await_shot_video_writeback(sid, prompt_id))

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": worker_url,
        "seed": seed,
        "shot_id": sid,
    }


# ===========================================================================
# 末帧续写(continue-video):抽当前视频末帧作 i2v 首帧,逐段延续串长镜头
# ===========================================================================
def _snap_ltx_length(n: int) -> int:
    """LTX 帧数网格 8k+1(9-241),向下取整对齐(委托 services.duration 统一网格)。"""
    return snap_engine_frames("ltx", n, direction="down")


def _snap_h3_length(n: int) -> int:
    """H3 帧数网格 17k+5(22-362 @24fps),向下取整对齐(委托 services.duration 统一网格)。"""
    return snap_engine_frames("h3", n, direction="down")


def _continue_engine(shot: DramaShot, body: ContinueVideoRequest) -> str:
    """续写引擎:显式指定优先;否则沿用分镜 video_model(非 ltx/h3 回落 ltx)。"""
    if body.engine:
        return body.engine
    return shot.video_model if shot.video_model in ("ltx", "h3") else "ltx"


def _continue_length(
    engine_name: str, shot: DramaShot, project: DramaProject, body: ContinueVideoRequest
) -> tuple[int, int]:
    """每段 (length, fps)。显式 length 严格校验引擎网格(422);缺省按 时长×fps 换算并向下对齐。"""
    if engine_name == "h3":
        fps = 24  # H3 固定 24fps(body.fps 覆盖仅 LTX 生效)
        if body.length is not None:
            if err := validate_engine_frames("h3", body.length):
                raise HTTPException(status_code=422, detail=err)
            return body.length, fps
        return _snap_h3_length(24 * shot.duration_sec), fps
    fps = body.fps if body.fps is not None else project.fps
    if body.length is not None:
        if err := validate_engine_frames("ltx", body.length):
            raise HTTPException(status_code=422, detail=err)
        return body.length, fps
    return _snap_ltx_length(fps * shot.duration_sec), fps


async def _extract_last_frame(video: Path, out: Path) -> None:
    """ffmpeg 抽视频末帧为 jpg(-sseof 倒 seek 定位,避免全片解码)。"""
    from app.routes.assembly import _run_ffmpeg

    await _run_ffmpeg([
        "ffmpeg", "-y", "-sseof", "-0.1", "-i", str(video),
        "-frames:v", "1", "-q:v", "2", str(out),
    ])
    if not out.exists() or out.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="末帧抽取失败(ffmpeg 产物为空)")


async def _resolve_shot_video_local(pool: WorkerPool, video_url: str, dest: Path) -> None:
    """把分镜视频 URL 落成本地文件:/api/images? 走 worker 直读;/api/drama/output/ 走成片目录。"""
    if video_url.startswith("/api/images?"):
        await _download_images_clip(pool, video_url, dest)
        return
    if video_url.startswith("/api/drama/output/"):
        name = video_url.rsplit("/", 1)[-1]
        if not _DRAMA_OUTPUT_RE.match(name):
            raise HTTPException(status_code=422, detail="分镜视频文件名非法,无法末帧续写")
        src = _drama_dir() / name
        if not src.is_file():
            raise HTTPException(status_code=422, detail="分镜视频文件不存在,请重新生成")
        await asyncio.to_thread(shutil.copyfile, src, dest)
        return
    raise HTTPException(
        status_code=422, detail="分镜视频来源不支持末帧续写(需 worker 产物或成片目录文件)"
    )


async def _probe_has_audio(path: Path) -> bool:
    """ffprobe 探测是否含音轨(决定 concat 是否带音频);无 ffprobe 视为有。"""
    if shutil.which("ffprobe") is None:
        return True
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "a",
        "-show_entries", "stream=codec_name", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    return bool(out.decode().strip())


async def _probe_video_meta(path: Path) -> tuple[int, int, int] | None:
    """ffprobe 探测 (width, height, fps);失败返回 None(调用方回落项目参数)。

    续写段的生成参数必须向源视频实测值对齐:project.width/height/fps 只是
    项目默认值,分镜实际视频可能是别的分辨率/帧率(历史项目常见),直接用
    项目参数会导致段产物与源视频参数不一致,concat 滤镜报
    "Failed to configure output pad"。
    """
    if shutil.which("ffprobe") is None:
        return None
    proc = await asyncio.create_subprocess_exec(
        "ffprobe", "-v", "error", "-select_streams", "v:0",
        "-show_entries", "stream=width,height,avg_frame_rate", "-of", "csv=p=0", str(path),
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, _ = await proc.communicate()
    try:
        w_s, h_s, rate = out.decode().strip().split(",")[:3]
        num, den = rate.split("/")
        fps = max(1, round(int(num) / max(1, int(den))))
        return int(w_s), int(h_s), fps
    except (ValueError, AttributeError):
        return None


async def _run_continue_video(
    sid: str,
    body: ContinueVideoRequest,
    engine_name: str,
    tenant_id: str,
    user_id: str,
) -> None:
    """末帧续写后台任务:抽末帧 → i2v 续写 → 逐段串接,产物落成片目录并回写分镜。

    独立 DB session(参照 _await_liveact_result)。每段登记 Job
    (kind=drama_shot_continue_i2v / drama_shot_continue_h3_i2v,与现有产物同走
    tracker 落库),段视频落盘 _drama_dir()/drama-<hex>.mp4(LiveAct 同款路径形式,
    /api/drama/output/ 可播放、可作下次续写源)。
    """
    from app.db import engine as db_engine

    seg_urls: list[str] = []
    try:
        settings = get_settings()
        pool = get_pool()
        with Session(db_engine) as s:
            shot = s.get(DramaShot, sid)
            if not shot:
                return
            project = s.get(DramaProject, shot.project_id)
            user_obj = s.get(User, user_id)
            if not project or not user_obj:
                raise RuntimeError("项目或用户不存在")
            prompt = (body.prompt_override or shot.prompt).strip()
            if not prompt:
                raise RuntimeError("分镜提示词为空")
            # P1 衔接策略层:前一镜 matchcut 时追加 h3-seam-polish 转场约束
            prompt = _apply_seam_modifier(prompt, shot, _prev_shot(s, shot), project=project)
            # @图片N 引用行【刻意不注入】(2026-08-16 评估结论,对照 v2 :4291):
            # 末帧续写每段真实提交的图片是上一段末帧(i2v 首帧),按正典「实际提交
            # 顺序编号」规则末帧即图片1;角色参考图引用行从图片1 起编会与真实图片
            # 槽位错位。角色身份已由首帧承载,引用行边际收益低而错位风险真实;
            # 待 H3 链路真实下发多图字节 + ref_prefix 支持首图占位偏移后再评估。
            length, fps = _continue_length(engine_name, shot, project, body)
            seeds = _next_seeds(body.seed, shot.seed, body.segments)

            # LTX:worker 一次选定,按实际 i2v 参数推所需模型/节点(同 ltx_studio 推导)
            ltx_client = None
            # SFW/NSFW 底模分流:nsfw=True(端点已过 R18 门控)用 10Eros,与 generate-video 同一来源
            video_ckpt = settings.nsfw_default_video_ckpt if body.nsfw else settings.default_video_ckpt
            if engine_name == "ltx":
                from app.capabilities import required_nodes
                model_set = {
                    video_ckpt, settings.nsfw_default_gemma, settings.nsfw_default_vae,
                }
                try:
                    ltx_client = await pool.pick(
                        required=model_set, required_nodes=required_nodes("ltx_i2v")
                    )
                except ComfyUIError as e:
                    raise RuntimeError(f"无可用 worker(缺 LTX 模型): {e}") from e
                if ltx_client is None:
                    raise RuntimeError("无可用 worker(缺 LTX 模型)")

            with tempfile.TemporaryDirectory(prefix="drama-cont-") as tmp:
                tmp_dir = Path(tmp)
                src_path = tmp_dir / "seg-000.mp4"
                await _resolve_shot_video_local(pool, shot.video_url, src_path)
                part_paths = [src_path]

                # 段参数向源视频实测对齐(分辨率/帧率),保证逐段一致、concat 可用
                src_meta = await _probe_video_meta(src_path)
                if src_meta:
                    src_w, src_h, src_fps = src_meta
                else:
                    src_w, src_h, src_fps = project.width, project.height, fps
                if engine_name == "h3":
                    seg_w = min(1344, max(256, src_w // 32 * 32))
                    seg_h = min(1344, max(256, src_h // 32 * 32))
                else:
                    seg_w = min(1920, max(256, src_w // 8 * 8))
                    seg_h = min(1080, max(256, src_h // 8 * 8))
                    if body.fps is None and src_meta:
                        # 未显式指定 fps 时沿用源视频帧率(项目默认值常与实测不符)
                        fps = max(4, min(30, src_fps))
                        if body.length is None:
                            length = _snap_ltx_length(fps * shot.duration_sec)

                for i in range(body.segments):
                    frame_path = tmp_dir / f"frame-{i:03d}.jpg"
                    await _extract_last_frame(src_path, frame_path)
                    frame_bytes = await asyncio.to_thread(frame_path.read_bytes)
                    seed_i = seeds[i]

                    if engine_name == "h3":
                        from app.services import h3 as h3_service
                        from app.workflows.h3_video import (
                            H3I2VParams,
                            build_h3_i2v_graph,
                        )

                        h3_client = h3_service.get_h3_client()
                        # 后端直传 H3 实例 input(不经 /api/upload 的 pool worker 转运)
                        image_name = await h3_client.upload_image(
                            frame_bytes, f"drama_cont_{uuid.uuid4().hex}.jpg"
                        )
                        h3_params = H3I2VParams(
                            positive=prompt,
                            negative=shot.negative,
                            image=image_name,
                            width=seg_w,
                            height=seg_h,
                            length=length,
                            steps=body.steps,
                            seed=seed_i,
                            filename_prefix=f"ToIV_drama_shot{shot.idx}_cont",
                        )
                        graph = build_h3_i2v_graph(h3_params)
                        result = await h3_service.submit_h3_job(
                            graph,
                            kind="drama_shot_continue_h3_i2v",
                            positive=prompt,
                            seed=seed_i,
                            req=body,
                            user=user_obj,
                            session=s,
                            client=h3_client,
                            nsfw=body.nsfw,  # R18 分镜续写段打标(端点已过门控)
                        )
                        prompt_id = result["prompt_id"]
                    else:
                        image_name = await ltx_client.upload_image(
                            frame_bytes, f"drama_cont_{uuid.uuid4().hex}.jpg"
                        )
                        ltx_params = LtxI2VParams(
                            positive=prompt,
                            image=image_name,
                            negative=shot.negative,
                            unet_name=video_ckpt,
                            gemma_name=settings.nsfw_default_gemma,
                            vae_name=settings.nsfw_default_vae,
                            width=seg_w,
                            height=seg_h,
                            length=length,
                            fps=fps,
                            steps=body.steps,
                            cfg=body.cfg,
                            seed=seed_i,
                            use_upscale=False,
                            use_rife=False,
                            filename_prefix=f"ToIV_drama_shot{shot.idx}_cont",
                        )
                        graph = build_ltx_i2v_graph(ltx_params)
                        prompt_id = await ltx_client.queue_prompt(graph, uuid.uuid4().hex)
                        s.add(
                            Job(
                                tenant_id=tenant_id,
                                user_id=user_id,
                                prompt_id=prompt_id,
                                worker=ltx_client.base_url,
                                kind="drama_shot_continue_i2v",
                                status="queued",
                                prompt=prompt,
                                seed=seed_i,
                                nsfw=body.nsfw,  # R18 分镜续写段打标,不进主站作品库
                                params=params_snapshot(body, seed=seed_i),
                            )
                        )
                        s.commit()
                        spawn_tracker(ltx_client, prompt_id)

                    # 段等待(2026-08-15 分裂修复,同 _await_shot_video_writeback 思路):
                    # 本地窗口 ≤900s 超时往往只是作业没跑完,直接判负会分裂为
                    # Job=done / shot.continue_status=error 且后续段被放弃。
                    # 单次 split-check:超时/异常后重读 Job 最新状态再定性;
                    # 竞态 done 直接取产物继续;已 error 判负;非终态仍判负(串行管线
                    # 不能无限阻塞,保持旧语义,由 reconcile_interrupted 兜底)。
                    wait_err: RuntimeError | None = None
                    try:
                        results = await wait_for_jobs(
                            s, [prompt_id], timeout=_job_wait_timeout(900.0)
                        )
                        urls: list[str] = results.get(prompt_id, [])
                    except RuntimeError as e:
                        wait_err = e  # 先读 Job 最新状态再定性
                        # commit 结束当前读事务快照,看到 tracker 其他 Session 的最新提交
                        s.commit()
                        job = s.exec(
                            select(Job).where(Job.prompt_id == prompt_id)
                        ).first()
                        if job and job.status == "done" and job.result:
                            urls = json.loads(job.result)
                        else:
                            if job and job.status not in ("done", "error"):
                                logger.warning(
                                    "shot %s continue-video 第 %d 段: 等待超时但作业 %s"
                                    "仍为 %s,串行管线不无限阻塞,判负待 reconcile 兜底",
                                    sid, i + 1, prompt_id, job.status,
                                )
                            raise wait_err  # 作业已 error / 不存在 / 非终态超时 → 判负(旧语义)
                    if not urls:
                        raise RuntimeError(f"第 {i + 1} 段续写无产物")
                    seg_path = tmp_dir / f"seg-{i + 1:03d}.mp4"
                    await _download_images_clip(pool, urls[0], seg_path)
                    # 段产物落盘成片目录(稳定可播放;worker output 清理后 URL 仍有效)
                    _drama_dir().mkdir(parents=True, exist_ok=True)
                    name = f"drama-{uuid.uuid4().hex}.mp4"
                    await asyncio.to_thread(shutil.copyfile, seg_path, _drama_dir() / name)
                    seg_urls.append(f"/api/drama/output/{name}")
                    part_paths.append(seg_path)
                    src_path = seg_path  # 下一段从本段末帧继续

                concat_url = ""
                if body.auto_concat:
                    from app.routes.assembly import _concat_parts

                    name = f"drama-{uuid.uuid4().hex}.mp4"
                    out_path = _drama_dir() / name
                    # 全部片段带音轨才拼音频(concat 滤镜要求各段流一致)
                    with_audio = all([await _probe_has_audio(p) for p in part_paths])
                    await _concat_parts(part_paths, fps, with_audio, out_path)
                    if not out_path.exists() or out_path.stat().st_size == 0:
                        raise RuntimeError("续写拼接产物为空")
                    concat_url = f"/api/drama/output/{name}"

            shot = s.get(DramaShot, sid)
            if shot:
                shot.continue_status = "done"
                shot.continue_urls = json.dumps(seg_urls)
                shot.continue_concat_url = concat_url
                shot.continue_error = ""
                proj = s.get(DramaProject, shot.project_id)
                if proj:
                    _append_process(
                        proj,
                        "continue_video",
                        f"分镜 #{shot.idx} 续写 {len(seg_urls)} 段完成(engine={engine_name})",
                    )
                    s.add(proj)
                s.add(shot)
                s.commit()
    except Exception as e:  # noqa: BLE001
        logger.exception("shot %s continue-video failed: %s", sid, e)
        with Session(db_engine) as s:
            shot = s.get(DramaShot, sid)
            if shot and shot.continue_status == "continuing":
                shot.continue_status = "error"
                shot.continue_error = f"{type(e).__name__}: {e}"[:200]
                s.add(shot)
                s.commit()


@router.post("/drama/shots/{sid}/continue-video")
async def continue_shot_video(
    sid: str,
    body: ContinueVideoRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """末帧续写:抽该镜当前视频末帧作 i2v 首帧,延续生成 N 段串长镜头。

    fire-and-forget:进度与产物经 GET 分镜轮询
    (continue_status / continue_urls / continue_concat_url / continue_error)。
    """
    enforce_generation_rate_limit(user)
    # R18 门控:nsfw=true(续写段走 10Eros 成人底模)无 X-NSFW 头一律 403,
    # 与 generate-video 同款(堵主站借续写绕过 G1;R18 分镜续写产物打标隔离)
    if body.nsfw:
        _gate_ltx_nsfw(user)
    shot = _owned_shot(sid, user, session)
    if shot.video_status != "done" or not shot.video_url:
        raise HTTPException(status_code=422, detail="分镜尚无已完成视频,无法末帧续写")
    if shot.continue_status == "continuing":
        raise HTTPException(status_code=409, detail="该分镜已有续写任务进行中")
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    engine_name = _continue_engine(shot, body)
    # 显式 length 网格校验(422)提前到提交前;缺省值此处换算仅用于响应回显
    length, fps = _continue_length(engine_name, shot, project, body)

    shot.continue_status = "continuing"
    shot.continue_urls = "[]"
    shot.continue_concat_url = ""
    shot.continue_error = ""
    _append_process(
        project,
        "continue_video",
        f"分镜 #{shot.idx} 末帧续写 {body.segments} 段(engine={engine_name}, {length}帧@{fps}fps)",
    )
    session.add(shot)
    session.commit()

    _spawn(_run_continue_video(sid, body, engine_name, user.tenant_id, user.id))

    return {
        "shot_id": sid,
        "segments": body.segments,
        "engine": engine_name,
        "length": length,
        "fps": fps,
        "auto_concat": body.auto_concat,
        "status": "continuing",
    }


# ===========================================================================
# 单分镜配音(IndexTTS2)
# ===========================================================================
def _allowed_ref(url: str) -> bool:
    if url.startswith("/"):
        return True
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        return False
    host = parts.hostname or ""
    settings = get_settings()
    allowed = {urlsplit(w).hostname for w in settings.worker_urls if urlsplit(w).hostname}
    return host in allowed or host in {"127.0.0.1", "localhost"}


def _resolve_url(url: str) -> str:
    if url.startswith("http://") or url.startswith("https://"):
        return url
    base = get_settings().api_base_url.rstrip("/")
    return base + (url if url.startswith("/") else "/" + url)


def _wav_duration(path: Path) -> float:
    try:
        with wave.open(str(path), "rb") as w:
            return round(w.getnframes() / float(w.getframerate() or 1), 2)
    except (wave.Error, OSError):
        return 0.0


async def _stream_to_path(
    resp: httpx.Response, path: Path, *, chunk_size: int = 4 << 20
) -> None:
    """流式把 HTTP 响应体写盘(4MB 块,参照 nas_models._download_url)。

    落盘目标是 cifs NAS 挂载:同步写会阻塞事件循环,open/write/close 一律
    走 asyncio.to_thread 让出事件循环。
    """
    f = await asyncio.to_thread(open, path, "wb")
    try:
        async for chunk in resp.aiter_bytes(chunk_size):
            if chunk:
                await asyncio.to_thread(f.write, chunk)
    finally:
        await asyncio.to_thread(f.close)


async def _submit_shot_voice(
    shot: DramaShot,
    session: Session,
    settings,
    *,
    text_override: str | None = None,
    ref_audio_url: str | None = None,
    emo_text: str | None = None,
    emo_alpha: float = 0.6,
) -> str:
    """调 IndexTTS2 为该分镜配音,落盘短剧成片目录并回写 voice_url,返回 voice_url。

    generate-voice 端点与 from-image 自动管线共用。
    优先级:ref_audio_url 参数 > speaker 对应角色的 ref_audio > 默认音色。
    """
    text = (text_override or shot.dialogue).strip()
    if not text:
        raise HTTPException(status_code=422, detail="分镜台词为空")

    # 解析参考音:参数传入 > speaker 对应角色的 ref_audio
    if not ref_audio_url and shot.speaker:
        # 查角色库找 speaker 的 ref_audio
        chars = session.exec(
            select(DramaCharacter).where(DramaCharacter.project_id == shot.project_id)
        ).all()
        for c in chars:
            if c.name == shot.speaker and c.ref_audio:
                ref_audio_url = c.ref_audio
                break

    tts_target = settings.tts_url.rstrip("/")
    data: dict[str, str] = {"text": text}
    # 情感控制：优先用请求体传入，其次尝试从分镜场景推断。
    emo_text = (emo_text or "").strip()
    if not emo_text and shot.scene:
        emo_text = shot.scene.strip()
    if emo_text:
        data["emo_text"] = emo_text
        data["emo_alpha"] = str(max(0.0, min(1.0, emo_alpha)))

    _drama_dir().mkdir(parents=True, exist_ok=True)
    name = f"voice-{uuid.uuid4().hex}.wav"
    path = _drama_dir() / name

    async with httpx.AsyncClient(
        timeout=_TTS_TIMEOUT, follow_redirects=True, trust_env=False
    ) as client:
        files = None
        if ref_audio_url:
            if not _allowed_ref(ref_audio_url):
                raise HTTPException(status_code=400, detail="参考音来源不在白名单内")
            try:
                rr = await client.get(_resolve_url(ref_audio_url))
                rr.raise_for_status()
            except httpx.HTTPError as e:
                raise HTTPException(status_code=502, detail=f"参考音下载失败:{e}") from e
            files = {"ref_audio": ("ref.wav", rr.content, "audio/wav")}

        shot.voice_status = "generating"
        session.add(shot)
        session.commit()

        header_checked = False
        bad_audio = False
        try:
            # 流式读响应:首块校验 RIFF 头,块写盘走 to_thread(cifs NAS 同步写阻塞事件循环)
            async with client.stream(
                "POST", tts_target + "/tts", data=data, files=files
            ) as resp:
                if resp.status_code != 200:
                    await resp.aread()  # 取错误详情前先读完响应体
                    detail = "TTS 合成失败"
                    try:
                        detail = resp.json().get("detail", detail)
                    except (ValueError, KeyError):
                        detail = resp.text[:200] or detail
                    shot.voice_status = "error"
                    shot.error = detail
                    session.add(shot)
                    session.commit()
                    raise HTTPException(status_code=502, detail=detail)
                f = await asyncio.to_thread(open, path, "wb")
                try:
                    async for chunk in resp.aiter_bytes(1 << 20):
                        if not chunk:
                            continue
                        if not header_checked:
                            header_checked = True
                            if chunk[:4] != b"RIFF":
                                bad_audio = True
                                break
                        await asyncio.to_thread(f.write, chunk)
                finally:
                    await asyncio.to_thread(f.close)
        except httpx.HTTPError as e:
            shot.voice_status = "error"
            shot.error = f"TTS 不可达:{e}"
            session.add(shot)
            session.commit()
            raise HTTPException(status_code=502, detail=f"TTS 服务不可达:{e}") from e

    if bad_audio or not header_checked:
        await asyncio.to_thread(path.unlink, missing_ok=True)  # 不留半成品
        shot.voice_status = "error"
        shot.error = "TTS 返回非音频"
        session.add(shot)
        session.commit()
        raise HTTPException(status_code=502, detail="TTS 返回非音频")

    shot.voice_url = f"/api/drama/voice/{name}"
    shot.voice_status = "done"
    shot.error = ""
    session.add(shot)
    session.commit()
    return shot.voice_url


@router.post("/drama/shots/{sid}/generate-voice")
async def generate_shot_voice(
    sid: str,
    body: GenerateVoiceRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """单分镜配音(IndexTTS2)。复用 voice.py 的 TTS 调用模式。

    优先级:body.ref_audio_url > 角色 ref_audio > 默认音色。
    """
    enforce_generation_rate_limit(user)
    shot = _owned_shot(sid, user, session)
    text = (body.text_override or shot.dialogue).strip()
    if not text:
        raise HTTPException(status_code=422, detail="分镜台词为空")

    settings = get_settings()
    voice_url = await _submit_shot_voice(
        shot,
        session,
        settings,
        text_override=body.text_override,
        ref_audio_url=body.ref_audio_url,
        emo_text=body.emo_text,
        emo_alpha=body.emo_alpha,
    )

    name = voice_url.rsplit("/", 1)[-1]
    return {
        "url": voice_url,
        "name": name,
        "duration_sec": _wav_duration(_drama_dir() / name),
        "shot_id": sid,
    }


@router.post("/drama/shots/{sid}/lipsync")
async def generate_shot_lipsync(
    sid: str,
    body: LipsyncRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M3: 分镜对口型(LatentSync 1.6)。复用 manju lipsync 内部函数,不走 HTTP 自调。

    要求 shot.video_status == "done" 且 shot.voice_status == "done";
    提交后 lipsync_status="generating",tracker 完成后回写 lipsync_video_url。
    """
    enforce_generation_rate_limit(user)
    shot = _owned_shot(sid, user, session)

    if shot.video_status != "done" or not shot.video_url:
        raise HTTPException(status_code=422, detail="分镜视频尚未完成")
    if shot.voice_status != "done" or not shot.voice_url:
        raise HTTPException(status_code=422, detail="分镜配音尚未完成")

    for u in (shot.video_url, shot.voice_url):
        if not _lipsync_allowed(u):
            raise HTTPException(status_code=400, detail="来源不在白名单内")

    try:
        client = await pool.pick(required=set())
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    async with httpx.AsyncClient(timeout=_TTS_TIMEOUT, follow_redirects=True) as http:
        try:
            v = await http.get(_lipsync_resolve(shot.video_url))
            v.raise_for_status()
            a = await http.get(_lipsync_resolve(shot.voice_url))
            a.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"源下载失败:{e}") from e
    if not v.content or not a.content:
        raise HTTPException(status_code=502, detail="源视频或配音为空")

    try:
        vfn = await client.upload_image(v.content, f"drama_lipsync_src_{uuid.uuid4().hex}.mp4")
        afn = await client.upload_image(a.content, f"drama_lipsync_voice_{uuid.uuid4().hex}.wav")
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=f"上传 worker 失败:{e}") from e

    seed_kw: dict = {}
    if body.seed is not None:
        seed_kw["seed"] = body.seed
    params = LatentSyncParams(
        video=vfn,
        audio=afn,
        lips_expression=body.lips_expression,
        inference_steps=body.inference_steps,
        filename_prefix=f"ToIV_drama_lipsync_shot{shot.idx}",
        **seed_kw,
    )
    graph = build_latentsync_graph(params)
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=prompt_id,
            worker=client.base_url,
            kind="drama_shot_lipsync",
            status="queued",
            prompt="对口型",
            seed=params.seed,
            params=params_snapshot(body, seed=params.seed),
        )
    )
    shot.lipsync_status = "generating"
    shot.lipsync_video_url = ""
    shot.error = ""
    session.add(shot)
    session.commit()
    spawn_tracker(client, prompt_id)

    async def _writeback_lipsync() -> None:
        """对口型作业完成后回写 lipsync_video_url/status。

        超时豁免(2026-08-15 分裂修复,同 _await_shot_video_writeback):本地等待
        窗口(≤900s)远短于 tracker 作业生命周期;超时往往只是作业还没跑完,直接
        标 error 会分裂为 Job=done / shot=error 且产物永不回写。故超时时保持
        generating 待 tracker/reconcile 兜底;作业已 error / 不存在维持标 error。
        """
        from app.comfy.tracker import wait_for_jobs
        from app.db import engine

        try:
            with Session(engine) as s:
                wait_err: RuntimeError | None = None
                results: dict[str, list[str]] = {}
                try:
                    results = await wait_for_jobs(s, [prompt_id], timeout=_job_wait_timeout(900.0))
                except RuntimeError as e:
                    wait_err = e  # 先读 Job 最新状态再定性(超时豁免 or 真失败)
                # commit 结束当前读事务快照,确保看到 tracker 其他 Session 的最新提交
                s.commit()
                job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                urls = results.get(prompt_id, [])
                if not urls and job and job.status == "done" and job.result:
                    urls = json.loads(job.result)  # 竞态 done:wait 抛超时瞬间作业恰好完成
                shot_obj = s.get(DramaShot, sid)
                if urls and shot_obj:
                    shot_obj.lipsync_video_url = urls[0]
                    shot_obj.lipsync_status = "done"
                    shot_obj.error = ""
                    s.add(shot_obj)
                    s.commit()
                    return
                if wait_err is not None:
                    if job and job.status not in ("done", "error"):
                        # 超时豁免:作业仍在 tracker 窗口内,保持 generating 不标 error
                        logger.warning(
                            "shot %s lipsync writeback: 等待超时但作业 %s 仍为 %s,"
                            "保持 generating 待 tracker/reconcile 兜底",
                            sid, prompt_id, job.status,
                        )
                        return
                    raise wait_err  # 作业已 error / 不存在 → 走通用异常标 error(旧语义)
                # wait 正常返回但无产物 → 失败标记(旧语义)
                if shot_obj and shot_obj.lipsync_status == "generating":
                    shot_obj.lipsync_status = "error"
                    shot_obj.error = "对口型失败或超时"
                    s.add(shot_obj)
                    s.commit()
        except Exception as e:  # noqa: BLE001
            logger.exception("shot %s lipsync writeback failed: %s", sid, e)
            with Session(engine) as s:
                shot_obj = s.get(DramaShot, sid)
                if shot_obj and shot_obj.lipsync_status == "generating":
                    shot_obj.lipsync_status = "error"
                    shot_obj.error = f"回写异常: {type(e).__name__}: {e}"[:200]
                    s.add(shot_obj)
                    s.commit()

    _spawn(_writeback_lipsync())

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": params.seed,
        "shot_id": sid,
        "lipsync_status": "generating",
    }


@router.get("/drama/voice/{name}")
async def get_voice(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _VOICE_NAME_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _drama_dir() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="配音不存在")
    return FileResponse(
        path,
        media_type="audio/wav",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ===========================================================================
# 分镜 PATCH(手动改提示词 / 台词 / seed)
# ===========================================================================
@router.patch("/drama/shots/{sid}")
def patch_shot(
    sid: str,
    body: ShotPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    s = _owned_shot(sid, user, session)
    data = body.model_dump(exclude_unset=True)
    if "characters" in data:
        data["characters"] = json.dumps(data["characters"], ensure_ascii=False)
    for k, v in data.items():
        setattr(s, k, v)
    session.add(s)
    session.commit()
    session.refresh(s)
    return _shot_dict(s, session)


# ===========================================================================
# 一键合成成片(复用 assembly.py 的 ffmpeg 逻辑)
# ===========================================================================
async def _fetch_ref_image_bytes(pool: WorkerPool, ref_url: str) -> bytes:
    """下载角色参考图字节。

    /api/images? 产物 URL 走 pool 从 ComfyUI worker 直读(绕过 HTTP 自调鉴权
    401,与 _download_images_clip 同源);其余白名单 URL 走 httpx 自调。
    """
    if ref_url.startswith("/api/images?"):
        from urllib.parse import parse_qs, urlsplit

        qs = parse_qs(urlsplit(ref_url).query)
        filename = qs.get("filename", [""])[0]
        subfolder = qs.get("subfolder", [""])[0]
        type_ = qs.get("type", ["output"])[0]
        worker = qs.get("worker", [""])[0]
        if not filename or not worker:
            raise HTTPException(status_code=400, detail=f"无效的产物 URL: {ref_url}")
        primary = resolve_worker(worker)
        host = urlsplit(primary.base_url).hostname or primary.base_url
        siblings = [
            c
            for c in pool.clients
            if (urlsplit(c.base_url).hostname or c.base_url) == host
            and c.base_url != primary.base_url
        ]
        last_err: Exception | None = None
        for client in [primary, *siblings]:
            try:
                content, _ = await client.get_image_bytes(filename, subfolder, type_)
                return content
            except ComfyUIError as e:
                last_err = e
        raise HTTPException(
            status_code=502,
            detail=f"角色参考图下载失败(同机 worker 均不可达): {ref_url} ({last_err})",
        )

    async with httpx.AsyncClient(
        timeout=60.0, follow_redirects=True, trust_env=False
    ) as http:
        try:
            rr = await http.get(_resolve_url(ref_url))
            rr.raise_for_status()
        except httpx.HTTPError as e:
            raise HTTPException(status_code=502, detail=f"角色参考图下载失败:{e}") from e
    return rr.content


async def _download_images_clip(
    pool: WorkerPool, url: str, dest: Path
) -> None:
    """下载 /api/images? 产物,绕过 HTTP 自调鉴权。

    drama 分镜视频/配音 URL 形如 /api/images?filename=...&worker=...,
    走 assembly._download_clip 会内部 HTTP 自调 /api/images 撞 401(服务端
    内部下载无 Bearer token)。这里解析 query 参数,直接用 pool 客户端
    从 ComfyUI worker 取字节写本地,与 images.py 同源回退逻辑一致。
    """
    from urllib.parse import parse_qs, urlsplit

    qs = parse_qs(urlsplit(url).query)
    filename = qs.get("filename", [""])[0]
    subfolder = qs.get("subfolder", [""])[0]
    type_ = qs.get("type", ["output"])[0]
    worker = qs.get("worker", [""])[0]
    if not filename or not worker:
        raise HTTPException(status_code=400, detail=f"无效的产物 URL: {url}")
    primary = resolve_worker(worker)
    host = urlsplit(primary.base_url).hostname or primary.base_url
    siblings = [
        c for c in pool.clients
        if (urlsplit(c.base_url).hostname or c.base_url) == host
        and c.base_url != primary.base_url
    ]
    last_err: Exception | None = None
    for client in [primary, *siblings]:
        try:
            content, _ = await client.get_image_bytes(filename, subfolder, type_)
            await asyncio.to_thread(dest.write_bytes, content)
            return
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(
        status_code=502,
        detail=f"片段下载失败(同机 worker 均不可达): {url} ({last_err})",
    )


# 配音对齐补全(成片合成前):配音长于镜时长 + 容差时 atempo 压回时槽
_VOICE_FIT_TOLERANCE = 0.3  # 时长容差(秒):超出才处理
_VOICE_FIT_TEMPO_MAX = 1.3  # 压缩比上限:超出不压,保留原样避免变速失真
_ATEMPO_SEG_MAX = 2.0       # atempo 单段上限(与 dub_voice._TEMPO_MAX 一致)


def _atempo_filter(tempo: float) -> str:
    """构造 atempo 串联链(单段 ≤2.0;当前压缩比上限 1.3,常态只有一段)。"""
    parts: list[str] = []
    t = tempo
    while t > _ATEMPO_SEG_MAX:
        parts.append(f"atempo={_ATEMPO_SEG_MAX:.3f}")
        t /= _ATEMPO_SEG_MAX
    parts.append(f"atempo={t:.3f}")
    return ",".join(parts)


async def _fit_voice_to_slot(
    src: Path, slot: float, tmp_dir: Path, index: int
) -> tuple[Path, dict]:
    """配音时长对齐镜时长:超长且压缩比 ≤1.3 时 atempo 加速贴回时槽。

    返回 (配音路径, 对齐记录{index,src_duration,slot,tempo,action,final_duration})。
    ≤容差不处理;压缩比 >1.3 不压(保留原样并 log.warning);atempo 产物异常回退原文件。
    ffprobe/ffmpeg 走 assembly 的异步封装,不阻塞事件循环。
    """
    from app.routes.assembly import _probe_duration, _run_ffmpeg

    rec: dict = {
        "index": index, "slot": round(slot, 3), "tempo": 1.0, "action": "unchanged",
    }
    dur = await _probe_duration(src)
    rec["src_duration"] = round(dur, 3)
    if slot <= 0 or dur <= slot + _VOICE_FIT_TOLERANCE:
        return src, rec

    tempo = dur / slot
    rec["tempo"] = round(tempo, 3)
    if tempo > _VOICE_FIT_TEMPO_MAX:
        rec["action"] = "skipped"
        rec["final_duration"] = rec["src_duration"]
        logger.warning(
            "配音对齐: 镜%d 配音 %.2fs 远超镜时长 %.2fs(压缩比 %.2f > %.1f),保留原样",
            index, dur, slot, tempo, _VOICE_FIT_TEMPO_MAX,
        )
        return src, rec

    out = tmp_dir / f"voice-fit-{index:03d}.wav"
    await _run_ffmpeg([
        "ffmpeg", "-y", "-i", str(src),
        "-filter:a", _atempo_filter(tempo),
        str(out),
    ])
    if not out.exists() or out.stat().st_size == 0:
        logger.warning("配音对齐: 镜%d atempo 产物为空,保留原样", index)
        rec["action"] = "skipped"
        rec["final_duration"] = rec["src_duration"]
        return src, rec

    new_dur = await _probe_duration(out)
    rec["action"] = "compressed"
    rec["final_duration"] = round(new_dur, 3)
    logger.info(
        "配音对齐: 镜%d 配音 %.2fs → %.2fs(atempo %.3f,镜时长 %.2fs)",
        index, dur, new_dur, tempo, slot,
    )
    return out, rec


async def _do_assemble(
    p: DramaProject,
    body: AssembleOptions,
    pool: WorkerPool,
    session: Session,
) -> dict:
    """一键合成成片:把项目下所有 done 状态的分镜视频按序拼接 + 配音 + 字幕。

    assemble 端点与 from-image 自动管线共用。
    复用 assembly.py 的 _build_ffmpeg_command / _run_ffmpeg / _download_clip。
    """
    shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == p.id).order_by(DramaShot.idx)
    ).all()
    ready = [s for s in shots if s.video_status == "done" and s.video_url]
    if not ready:
        raise HTTPException(status_code=422, detail="无已完成的分镜视频可合成")

    if shutil.which("ffmpeg") is None:
        raise HTTPException(status_code=500, detail="服务端未安装 ffmpeg")

    # 复用 assembly.py 的内部函数(避免重写 ffmpeg 逻辑)
    from app.routes.assembly import (
        _ASPECT_DIMS,
        _build_ffmpeg_command,
        _download_clip,
        _probe_duration,
        _run_ffmpeg,
        _gen_card,
        _concat_parts,
        _is_allowed_clip,
        _OUTPUT_DIR as _MANJU_OUTPUT_DIR,
        _TRANSITIONS,
    )

    if body.transition not in _TRANSITIONS:
        raise HTTPException(status_code=422, detail="未知的转场类型")
    # M3:校验 clips 来源白名单
    clips_to_validate = body.clips if body.clips else [s.video_url for s in ready]
    for i, url in enumerate(clips_to_validate):
        if not _is_allowed_clip(url):
            raise HTTPException(status_code=400, detail=f"分镜 {ready[i].idx if i < len(ready) else i} 视频来源不在白名单内")
    if body.bgm_url and not _is_allowed_clip(body.bgm_url):
        raise HTTPException(status_code=400, detail="BGM 来源不在白名单内")

    _drama_dir().mkdir(parents=True, exist_ok=True)
    name = f"drama-{uuid.uuid4().hex}.mp4"
    out_path = _drama_dir() / name

    # P1-b:aspect="auto"(默认)→ 沿用项目宽高(各取偶数兜底,缺省落 16:9);
    # fps=0(默认)→ 沿用项目 fps(缺省 16)。显式预设值行为不变。
    if body.aspect == "auto":
        pw, ph = p.width or 0, p.height or 0
        if pw > 0 and ph > 0:
            # yuv420p/libx264 要求偶数尺寸,奇数向下取偶
            dims = (max(2, pw - pw % 2), max(2, ph - ph % 2))
        else:
            dims = _ASPECT_DIMS["16:9"]
    else:
        dims = _ASPECT_DIMS.get(body.aspect, _ASPECT_DIMS["16:9"])
    eff_fps = body.fps if body.fps > 0 else (p.fps if p.fps and p.fps > 0 else 16)

    # 把 AssembleOptions 翻译成 assembly.py 的 AssembleOptions
    from app.routes.assembly import AssembleOptions as _AsmOpt
    asm_opt = _AsmOpt(
        transition=body.transition,
        bgm_url=body.bgm_url,
        subtitles=[s.dialogue for s in ready],  # 逐镜台词作字幕
        fps=eff_fps,
        aspect=body.aspect,
        title=body.title,
        credits=body.credits,
        voice_volume=body.voice_volume,
        bgm_volume=body.bgm_volume,
        duck=body.duck,
        grade=body.grade,
        sub_size=body.sub_size,
        sub_color=body.sub_color,
        sub_pos=body.sub_pos,
        sub_box=body.sub_box,
    )

    # M3:优先使用前端显式传入的 clips(已按 lipsync_video_url > video_url 处理);否则兜底 video_url
    clips = body.clips if body.clips else [s.video_url for s in ready]
    voice_urls = [s.voice_url for s in ready]  # 空串=无配音
    durations_targets = [float(s.duration_sec) for s in ready]  # 用分镜配置的目标时长
    # P1 衔接策略层:逐镜接缝策略(shot.seam_to_next)传入 ffmpeg 命令构造,
    # overlap 接缝走 xfade+acrossfade,其余已声明接缝硬切;clips 与分镜对不齐时不传(旧行为)
    seam_list: list[str] | None = (
        [s.seam_to_next for s in ready] if len(clips) == len(ready) else None
    )

    with tempfile.TemporaryDirectory(prefix="drama-asm-") as tmp:
        tmp_dir = Path(tmp)
        clip_paths: list[Path] = []
        voice_paths: list[Path | None] = [None] * len(clips)
        async with httpx.AsyncClient(
            timeout=120.0, follow_redirects=True, trust_env=False
        ) as client:
            for i, url in enumerate(clips):
                dest = tmp_dir / f"clip-{i:03d}.mp4"
                # /api/images? 产物走 pool 直读,绕过 HTTP 自调鉴权(401)
                if url.startswith("/api/images?"):
                    await _download_images_clip(pool, url, dest)
                else:
                    await _download_clip(client, url, dest)
                clip_paths.append(dest)
            bgm_path: Path | None = None
            if body.bgm_url:
                bgm_path = tmp_dir / "bgm.audio"
                await _download_clip(client, body.bgm_url, bgm_path)
            for i, vurl in enumerate(voice_urls):
                if vurl:
                    vdest = tmp_dir / f"voice-{i:03d}.wav"
                    if vurl.startswith("/api/images?"):
                        await _download_images_clip(pool, vurl, vdest)
                    else:
                        await _download_clip(client, vurl, vdest)
                    voice_paths[i] = vdest

        probed = [await _probe_duration(p) for p in clip_paths]
        # P1-a:逐镜探测片段是否自带音轨(H3 引擎分镜视频常带原生音轨),
        # 供 _build_ffmpeg_command 在无配音/无 BGM 时保留内嵌音轨。
        clip_audio = [await _probe_has_audio(cp) for cp in clip_paths]
        targets = durations_targets
        durations = [
            min(probed[i], targets[i]) if i < len(targets) and targets[i] > 0 else probed[i]
            for i in range(len(probed))
        ]
        # 配音对齐补全:配音长于镜时长 + 0.3s 容差时 atempo 压回(压缩比上限 1.3)
        align_recs: list[dict] = []
        for i, vp in enumerate(voice_paths):
            if vp is None:
                continue
            fitted, rec = await _fit_voice_to_slot(vp, durations[i], tmp_dir, i)
            voice_paths[i] = fitted
            if rec["action"] != "unchanged":
                align_recs.append(rec)
        if align_recs:
            _append_process(
                p, "voice_align",
                "; ".join(
                    f"镜{r['index']}:{r['src_duration']:.2f}s→{r['final_duration']:.2f}s"
                    f"(x{r['tempo']:.2f},{'压缩' if r['action'] == 'compressed' else '超上限保留'})"
                    for r in align_recs
                ),
            )
        # dims 已在 asm_opt 构造前按 aspect="auto"/显式预设解析(见上),此处不再重算
        has_bookends = bool(asm_opt.title.strip() or asm_opt.credits.strip())
        film_path = (tmp_dir / "film.mp4") if has_bookends else out_path
        cmd = _build_ffmpeg_command(
            clip_paths, asm_opt, bgm_path, voice_paths, durations, targets, dims, film_path,
            clip_audio=clip_audio,
            seams=seam_list,
        )
        await _run_ffmpeg(cmd)

        if has_bookends:
            # 内嵌音轨保留时正片同样带音轨,片头/片尾卡需配静音轨才能 concat
            embedded_used = (
                any(clip_audio)
                and not any(voice_paths)
                and bgm_path is None
                and (
                    asm_opt.transition == "none"
                    or bool(seam_list) and any(s == "overlap" for s in seam_list or [])
                )
            )
            film_has_audio = any(voice_paths) or bgm_path is not None or embedded_used
            parts: list[Path] = []
            if asm_opt.title.strip():
                tcard = tmp_dir / "title.mp4"
                await _gen_card(asm_opt.title, dims, asm_opt.fps, 2.4, film_has_audio, tcard)
                parts.append(tcard)
            parts.append(film_path)
            if asm_opt.credits.strip():
                ccard = tmp_dir / "credits.mp4"
                await _gen_card(asm_opt.credits, dims, asm_opt.fps, 3.4, film_has_audio, ccard)
                parts.append(ccard)
            await _concat_parts(parts, asm_opt.fps, film_has_audio, out_path)

    if not out_path.exists() or out_path.stat().st_size == 0:
        raise HTTPException(status_code=500, detail="合成产物为空")

    # 计算总时长(粗略:逐镜目标和)
    total_sec = sum(durations)
    p.video_url = f"/api/drama/output/{name}"
    p.duration_sec = total_sec
    p.status = "ready"
    _append_process(p, "assemble", f"合成成片 {name} ({total_sec:.1f}s)")
    session.add(p)
    session.commit()

    return {"url": p.video_url, "name": name, "duration_sec": total_sec}


@router.post("/drama/projects/{pid}/assemble")
async def assemble_project(
    pid: str,
    body: AssembleOptions,
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """一键合成成片:把项目下所有 done 状态的分镜视频按序拼接 + 配音 + 字幕。

    复用 assembly.py 的 _build_ffmpeg_command / _run_ffmpeg / _download_clip。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    return await _do_assemble(p, body, pool, session)


@router.get("/drama/output/{name}")
async def get_drama_output(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _DRAMA_OUTPUT_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _drama_dir() / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="成片不存在")
    return FileResponse(
        path,
        media_type="video/mp4",
        filename=name,
        headers={"Cache-Control": "public, max-age=86400"},
    )


# ===========================================================================
# M1: 角色三视图生成(正面/侧面/背面)
# ===========================================================================
def _snap8(v: int) -> int:
    """SD 潜空间要求宽高是 8 的倍数。"""
    return max(8, v - v % 8)


def _t2i_required_models(ckpt_name: str) -> set[str]:
    """返回 t2i 所需的模型文件集合(用于 pool.pick 路由)。

    次世代族(flux2/qwen_image/z_image)需 UNET + 文本编码器 + VAE 三件齐;
    传统 SD checkpoint 只需 ckpt 自身。
    """
    if is_nextgen(ckpt_name):
        recipe = nextgen_recipe(ckpt_name)
        if recipe:
            return {ckpt_name, recipe.clip_name, recipe.vae_name}
    return {ckpt_name}


def _build_t2i_graph(
    positive: str,
    ckpt_name: str,
    width: int,
    height: int,
    seed: int | None,
    filename_prefix: str,
) -> tuple[dict, int]:
    """构建 t2i 图(自动适配次世代/传统底模),返回 (graph, seed_used)。

    次世代族走 UNETLoader + 独立 CLIP/VAE;传统族走 CheckpointLoaderSimple。
    参数(steps/cfg/sampler)按 model_profiles 推荐档自动选取。
    """
    seed_kw: dict = {"seed": seed} if seed is not None else {}
    if is_nextgen(ckpt_name):
        prof = profile_for(ckpt_name)
        w, h = fit_resolution(ckpt_name, _snap8(width), _snap8(height))
        ng = NextgenParams(
            model_name=ckpt_name,
            positive=positive,
            negative="" if not prof.neg_prompt else "low quality, blurry, deformed",
            width=w,
            height=h,
            steps=prof.steps,
            cfg=prof.cfg,
            sampler=prof.sampler,
            scheduler=prof.scheduler,
            filename_prefix=filename_prefix,
            **seed_kw,
        )
        return build_nextgen_graph(ng), ng.seed
    params = Txt2ImgParams(
        positive=positive,
        negative="low quality, blurry, deformed, watermark, text",
        ckpt_name=ckpt_name,
        width=_snap8(width),
        height=_snap8(height),
        steps=20,
        cfg=7.0,
        sampler="euler",
        scheduler="normal",
        filename_prefix=filename_prefix,
        **seed_kw,
    )
    return build_txt2img_graph(params), params.seed


@router.post("/drama/characters/{cid}/generate-reference")
async def generate_character_reference(
    cid: str,
    body: GenerateReferenceRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M1: 角色三视图生成(正面/侧面/背面),锁定主体一致性,对标 LibTV。

    取角色 visual_prompt,追加视角后缀后调 ComfyUI t2i 生成 3 张图,
    同步等待结果落库到 reference_front/side/back。
    """
    enforce_generation_rate_limit(user, count=3)
    c = session.get(DramaCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    project = _owned_project(c.project_id, user, session)

    prompt = (body.visual_prompt_override or c.visual_prompt).strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="角色缺少视觉描述")

    settings = get_settings()
    ckpt_name = settings.default_ckpt
    required = _t2i_required_models(ckpt_name)

    # 选 worker:给定 worker → 只路由该机;否则 pool.pick 选最闲机
    if body.worker:
        client = resolve_worker(body.worker)
    else:
        try:
            client = await pool.pick(required=required)
        except ComfyUIError as e:
            raise HTTPException(status_code=503, detail=str(e)) from e

    # 三个视角的 prompt(追加视角后缀)
    views: list[tuple[str, str]] = [
        ("front", f"{prompt}, front view, character reference sheet"),
        ("side", f"{prompt}, side view, character reference sheet"),
        ("back", f"{prompt}, back view, character reference sheet"),
    ]

    # 提交 3 个 t2i 作业
    prompt_ids: list[str] = []
    for view_name, view_prompt in views:
        graph, seed_used = _build_t2i_graph(
            positive=view_prompt,
            ckpt_name=ckpt_name,
            width=768,
            height=1024,  # 竖图适合角色全身参考
            seed=body.seed,
            filename_prefix=f"ToIV_drama_char_{view_name}",
        )
        client_id = uuid.uuid4().hex
        try:
            pid = await client.queue_prompt(graph, client_id)
        except ComfyUIError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        prompt_ids.append(pid)
        session.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=user.id,
                prompt_id=pid,
                worker=client.base_url,
                kind=f"drama_char_reference_{view_name}",
                status="queued",
                prompt=view_prompt,
                seed=seed_used,
                params=params_snapshot(body, seed=seed_used, ckpt_name=ckpt_name),
            )
        )
    session.commit()

    # 后台追踪结果(独立于客户端 SSE)
    for pid in prompt_ids:
        spawn_tracker(client, pid)

    # 同步等待 3 个作业完成
    try:
        results = await wait_for_jobs(session, prompt_ids, timeout=_job_wait_timeout(600.0))
    except RuntimeError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e

    # 每个作业取第一张图 URL
    urls = [results.get(pid, []) for pid in prompt_ids]
    c.reference_front = urls[0][0] if urls[0] else ""
    c.reference_side = urls[1][0] if urls[1] else ""
    c.reference_back = urls[2][0] if urls[2] else ""

    _append_process(project, "generate_reference", f"角色 {c.name} 三视图生成完成")
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_dict(c)


# ===========================================================================
# M2: 9/25 宫格分镜(LLM 拆解 + 宫格构图参考图)
# ===========================================================================
# P2 阶段B 纪律(dogfood 高优 #1,治动漫偏置):宫格图生成后,先经 VLM 逐格观察
# 实际画面,再由 LLM 据实改写各镜 prompt;任一环节失败回落 LLM 原始 prompt。
# {cols}/{n} 由 .replace 注入(正文含 JSON 花括号,禁用 .format)。
_GRID_OBSERVE_SYSTEM = (
    "你是短剧分镜校对员。用户上传一张 {cols} 宫格分镜母版图,共 {n} 格,"
    "从左到右、从上到下依次编号 1 到 {n}。\n"
    "逐格描述该格**实际可见**的画面内容,每格覆盖:主体与身份特征、姿态/动作、"
    "镜位与景别、场景环境、可见服装与配色、与相邻格的明显差异。\n"
    "铁律:只描述实际可见内容,禁止脑补身份、剧情与情绪;某格模糊或被遮挡时"
    "如实写「不清晰」。\n"
    '只输出 JSON:{"panels":[{"index":1,"description":"第1格实际画面描述"}]},'
    "不要解释,不要代码块标记。"
)

_GRID_GROUND_SYSTEM = (
    "你是短剧分镜校对员。输入每个镜头的原始生成意图(英文 prompt)与宫格母版"
    "对应格的实际画面描述。\n"
    "任务:据实改写每个镜头的英文 prompt —— 人物身份、服装、姿态、镜位、场景"
    "一律以宫格实际成图为准;宫格描述未覆盖的细节(光线、氛围、质感、风格词)"
    "允许保留原意图。\n"
    "约束:逐镜对齐格号(panel_index),不改镜头数量与顺序,不合并/拆分镜头;"
    "输出英文 prompt;原 prompt 中的角色名与关键外观 token 予以保留,"
    "除非与实际画面描述冲突。\n"
    '只输出 JSON:{"prompts":[{"index":0,"prompt":"改写后的英文提示词"}]},'
    "不要解释,不要代码块标记。"
)


async def _ground_grid_prompts(
    pool: WorkerPool,
    grid_url: str,
    coerced: list[dict],
    *,
    layer: str,
) -> list[str] | None:
    """阶段B:观察实际宫格图,据实改写各镜 prompt。

    返回与 coerced 等长的改写 prompt 列表(某格 VLM 未描述/LLM 未改写时
    该镜保留原 prompt);取图失败 / VLM 失败或不可解析 / 二次 LLM 失败 →
    返回 None,调用方整体回落 LLM 原始 prompt(grounding_status="fallback")。
    本函数永不抛异常:grounding 是增强链,失败不拖垮宫格分镜主流程。
    """
    loc = parse_image_url(grid_url)
    if loc is None:
        return None
    try:
        img_bytes = await fetch_product_image_bytes(
            pool,
            worker=loc["worker"],
            filename=loc["filename"],
            subfolder=loc["subfolder"],
            type_=loc["type"],
        )
        if not img_bytes:
            logger.info("grid grounding: 宫格图取字节失败,回落原 prompt")
            return None
        # 宫格数判定与 presence-check(:3609)同口径:≤9 格 3x3,否则 5x5
        cols = 3 if len(coerced) <= 9 else 5
        observe_system = _GRID_OBSERVE_SYSTEM.replace("{cols}", f"{cols}x{cols}").replace(
            "{n}", str(len(coerced))
        )
        part = {
            "type": "image_url",
            "image_url": {"url": _data_url(img_bytes, "image", "image/png")},
        }
        raw = await _chat_completion(
            observe_system, part, get_settings().reverse_vlm_base_url
        )
        obj = parse_json_obj(raw)
        panels = obj.get("panels") if obj else None
        if not isinstance(panels, list) or not panels:
            logger.info("grid grounding: VLM 返回无法解析,回落原 prompt")
            return None
        panel_desc: dict[int, str] = {}
        for item in panels:
            if not isinstance(item, dict):
                continue
            try:
                pidx = int(item.get("index"))
            except (TypeError, ValueError):
                continue
            desc = str(item.get("description") or "").strip()
            if desc:
                panel_desc[pidx] = desc
        if not panel_desc:
            return None

        # 二次 LLM(与 storyboard 同层配置):原意图 + 对应格实际描述 → 据实改写
        payload = {
            "shots": [
                {
                    "index": i,
                    "panel_index": i + 1,
                    "intent": sc["prompt"],
                    "panel_actual": panel_desc.get(i + 1, ""),
                }
                for i, sc in enumerate(coerced)
            ]
        }
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": _GRID_GROUND_SYSTEM},
                {"role": "user", "content": json.dumps(payload, ensure_ascii=False)},
            ],
            layer=layer,
            max_tokens=8192,
            temperature=0.3,
        )
        robj = parse_json_obj((msg.get("content") or "").strip())
        rewrites = robj.get("prompts") if robj else None
        if not isinstance(rewrites, list) or not rewrites:
            logger.info("grid grounding: 二次 LLM 返回无法解析,回落原 prompt")
            return None
        by_index: dict[int, str] = {}
        for item in rewrites:
            if not isinstance(item, dict):
                continue
            try:
                ridx = int(item.get("index"))
            except (TypeError, ValueError):
                continue
            text = str(item.get("prompt") or "").strip()
            if text:
                by_index[ridx] = text
        if not by_index:
            return None
        logger.info(
            "grid grounding: %d/%d 镜据宫格实图改写", len(by_index), len(coerced)
        )
        return [by_index.get(i) or sc["prompt"] for i, sc in enumerate(coerced)]
    except Exception as e:  # noqa: BLE001 — grounding 一律降级,不炸主流程
        logger.warning("grid grounding 失败,回落原 prompt: %s", e)
        return None


@router.post("/drama/projects/{pid}/grid-storyboard")
async def grid_storyboard(
    pid: str,
    body: GridStoryboardRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M2: 9/25 宫格分镜 —— LLM 拆剧本成 num_shots 个镜头 + 生成宫格构图参考图。

    复用 storyboard 的 LLM 拆解逻辑,额外调用 t2i 生成一张包含全部镜头构图的
    宫格参考图(3x3 或 5x5),保存到每个 shot 的 grid_image 字段。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    script = body.script if body.script else p.script
    if not script.strip():
        raise HTTPException(status_code=422, detail="项目缺少剧本")
    style = body.style if body.style else p.style
    characters = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == pid)
    ).all()

    # LLM 拆解剧本成 num_shots 个镜头(复用 storyboard 提示词);
    # 与普通 storyboard 一致走配置层(TOIV_DRAMA_STORYBOARD_LAYER),不再绕过配置直调 L1。
    layer = _drama_llm_layer(get_settings().drama_storyboard_layer)
    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": _STORYBOARD_SYSTEM},
                {
                    "role": "user",
                    "content": _build_user_prompt(
                        script, body.num_shots, style, characters
                    ),
                },
            ],
            layer=layer,
            # 与普通 storyboard 一致 8192:Nemotron 等思考型模型 reasoning 占 token,
            # 4096 偶发被截断 → JSON 不完整 → 解析失败 502。8192 实测稳定。
            max_tokens=8192,
            temperature=0.5,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    raw = (msg.get("content") or "").strip()
    obj = _parse_json_obj(raw)
    shots_raw = obj.get("shots") if obj else None
    if not isinstance(shots_raw, list) or not shots_raw:
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")

    coerced = [_coerce_shot(s, i) for i, s in enumerate(shots_raw[: body.num_shots])]
    if not any(s["prompt"] for s in coerced):
        raise HTTPException(status_code=502, detail="分镜生成失败(无有效提示词),请重试")

    # 生成宫格构图参考图:把各镜头 prompt 拼成一张宫格图
    grid_size = "3x3" if body.num_shots <= 9 else "5x5"
    panel_summaries = "; ".join(s["prompt"][:120] for s in coerced if s["prompt"])
    grid_prompt = (
        f"grid of {body.num_shots} panels, storyboard layout, {grid_size} grid, "
        f"each panel shows a different scene, character reference sheet, "
        f"cinematic, highly detailed, masterpiece, {panel_summaries}"
    )

    # DramaClaw 借鉴 #4(颜色标记草图):为项目全部角色(含 LLM 本次新识别、
    # 尚未落库的)分配稳定标记色,注入宫格图 prompt;presence-check 用同一映射检测。
    # 名字集合在拆镜后即可确定,无需等下方角色建行。
    color_map: dict[str, str] = {}
    if body.color_mark:
        all_names = {c.name for c in characters}
        for sc in coerced:
            all_names.update(sc["characters"])
        color_map = assign_character_colors(list(all_names))
        if color_map:
            grid_prompt += color_mark_prompt_suffix(color_map)

    settings = get_settings()
    ckpt_name = settings.default_ckpt
    required = _t2i_required_models(ckpt_name)
    try:
        client = await pool.pick(required=required)
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    grid_graph, grid_seed = _build_t2i_graph(
        positive=grid_prompt,
        ckpt_name=ckpt_name,
        width=1024,
        height=1024,  # 方形适合宫格布局
        seed=None,
        filename_prefix="ToIV_drama_grid",
    )
    client_id = uuid.uuid4().hex
    try:
        grid_pid = await client.queue_prompt(grid_graph, client_id)
    except ComfyUIError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e

    session.add(
        Job(
            tenant_id=user.tenant_id,
            user_id=user.id,
            prompt_id=grid_pid,
            worker=client.base_url,
            kind="drama_grid_storyboard",
            status="queued",
            prompt=grid_prompt,
            seed=grid_seed,
            params=params_snapshot(body, seed=grid_seed, ckpt_name=ckpt_name),
        )
    )
    session.commit()
    spawn_tracker(client, grid_pid)

    # 同步等待宫格图生成完成
    try:
        results = await wait_for_jobs(session, [grid_pid], timeout=_job_wait_timeout(600.0))
    except RuntimeError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e

    grid_urls = results.get(grid_pid, [])
    grid_url = grid_urls[0] if grid_urls else ""

    # P2 阶段B 纪律:先观察实际宫格,再据实改写各镜 prompt(治 LLM 纯想象偏置)。
    # VLM/二次 LLM 任一失败 → 回落现状路径(LLM 原 prompt),shots 标 grounding_status。
    grounded_prompts: list[str] | None = None
    grounding_status = ""
    if grid_url and settings.grid_grounding_enabled:
        grounded_prompts = await _ground_grid_prompts(
            pool, grid_url, coerced, layer=layer
        )
        grounding_status = "grounded" if grounded_prompts is not None else "fallback"

    # 清掉旧分镜(重新拆解),角色库保留
    for old in session.exec(select(DramaShot).where(DramaShot.project_id == pid)).all():
        session.delete(old)
    session.flush()

    # 把角色视觉 token 注入到分镜 prompt(角色一致性)
    char_map = {c.name: c for c in characters}
    # 自动创建 LLM 识别出的新角色
    _seen_chars: set[str] = set()
    for sc in coerced:
        for cname in sc.get("characters", []):
            if cname and cname not in char_map and cname not in _seen_chars:
                _seen_chars.add(cname)
                nc = DramaCharacter(project_id=pid, name=cname)
                session.add(nc)
                char_map[cname] = nc
    session.flush()

    created: list[DramaShot] = []
    for i, sc in enumerate(coerced):
        # 阶段B:有据实改写结果时以实际宫格为准,否则用 LLM 原始 prompt
        shot_prompt = grounded_prompts[i] if grounded_prompts else sc["prompt"]
        for cname in sc["characters"]:
            ch = char_map.get(cname)
            if ch and ch.visual_prompt:
                shot_prompt = (
                    f"{ch.visual_prompt}, {shot_prompt}" if shot_prompt else ch.visual_prompt
                )
        # color_mark:把该 shot 期望在场角色的标记色写入 detected_colors 的 expected 段,
        # 供前端预览与 presence-check 比对
        shot_detected = ""
        detected_meta: dict[str, Any] = {}
        if color_map:
            shot_colors = {n: color_map[n] for n in sc["characters"] if n in color_map}
            detected_meta.update(
                {"color_map": shot_colors, "expected": sc["characters"],
                 "checked_at": "", "source": "color-mark"}
            )
        # 阶段B grounding 元数据与 color_mark 共存于 detected_colors JSON(免迁移)
        if grounding_status:
            detected_meta["grounding_status"] = grounding_status
        if detected_meta:
            shot_detected = json.dumps(detected_meta, ensure_ascii=False)
        shot = DramaShot(
            project_id=pid,
            idx=i,
            scene=sc["scene"],
            prompt=shot_prompt,
            characters=json.dumps(sc["characters"], ensure_ascii=False),
            dialogue=sc["dialogue"],
            speaker=sc["speaker"],
            duration_sec=sc["duration_sec"],
            grid_image=grid_url,
            detected_colors=shot_detected,
            # P1 衔接策略层:与 text storyboard 路径一致,LLM 规划的接缝策略/锚点落库
            seam_to_next=sc.get("seam_to_next", ""),
            seam_anchor=sc.get("seam_anchor", ""),
            # 情绪标签/叙事节拍(与 text 路径一致落库)
            mood=sc.get("mood", ""),
            beat=sc.get("beat", ""),
            width=p.width,
            height=p.height,
        )
        session.add(shot)
        created.append(shot)

    p.status = "storyboard"
    p.script = script
    _append_process(p, "grid_storyboard", f"生成 {body.num_shots} 宫格分镜")
    session.add(p)
    session.commit()
    for s in created:
        session.refresh(s)
    return {
        "project": _project_dict(p),
        "shots": [_shot_dict(s, session) for s in created],
        "grid_image": grid_url,
    }


# ===========================================================================
# M3: 3D 导演台(轻量 2D 版)—— 2D 画布拖拽角色/道具,生成空间构图参考图
# ===========================================================================
class SceneLayoutBody(BaseModel):
    """2D 空间布局:角色/道具位置 + 镜头参数,用于生成构图参考图。"""

    layout: dict  # {actors:[{name,x,y,facing,scale}], props:[{name,x,y,scale}], camera:{angle,distance}, notes:str}
    generate_reference: bool = False  # 是否同时生成构图参考图
    # DramaClaw 借鉴 #4:生成参考图时给 layout 角色注入标记色火柴人指令;
    # 仅 generate_reference=True 时生效(无图可注则忽略),默认 False 零行为变更
    color_mark: bool = False
    worker: str | None = Field(default=None, max_length=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)


def _layout_to_prompt(layout: dict) -> str:
    """把 2D 空间布局翻译成英文 t2i 提示词(构图参考图用)。

    坐标约定:x 取值 [0,1],0=最左、1=最右;facing 为 left/right/forward。
    """
    actors = layout.get("actors") or []
    props = layout.get("props") or []
    camera = layout.get("camera") or {}
    notes = str(layout.get("notes") or "").strip()

    def _pos(x: float) -> str:
        try:
            xv = float(x)
        except (TypeError, ValueError):
            return "center"
        if xv < 0.33:
            return "left"
        if xv > 0.66:
            return "right"
        return "center"

    parts: list[str] = []
    if actors:
        # 主体数量标签(1boy/2boys/1girl/2girls/...),按性别启发式:无性别信息时统一 boy
        parts.append(f"{len(actors)}boys" if len(actors) > 1 else "1boy")
        for a in actors:
            facing = str(a.get("facing") or "").strip().lower()
            pos = _pos(a.get("x", 0.5))
            frag = f"one at {pos}"
            if facing in ("left", "right", "forward", "back"):
                frag += f" facing {facing}"
            parts.append(frag)
    for pr in props:
        pname = str(pr.get("name") or "object").strip().lower() or "object"
        parts.append(f"{pname} at {_pos(pr.get('x', 0.5))}")

    # 镜头距离 → 构图描述
    distance = str(camera.get("distance") or "").strip().lower()
    if distance in ("close", "closeup", "close-up"):
        parts.append("close-up shot")
    elif distance in ("medium", "mid"):
        parts.append("medium shot")
    elif distance in ("wide", "far", "long"):
        parts.append("wide shot")
    else:
        parts.append("medium shot")

    angle = str(camera.get("angle") or "").strip().lower()
    if angle in ("low", "high", "overhead", "side", "front"):
        parts.append(f"{angle} angle")

    parts.append("cinematic composition")
    if notes:
        parts.append(notes)
    return ", ".join(parts)


@router.get("/drama/shots/{sid}/scene-layout")
def get_scene_layout(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M3: 读取分镜的 2D 空间布局。空 scene_layout 返回 null。"""
    shot = _owned_shot(sid, user, session)
    raw = shot.scene_layout or ""
    parsed: dict | None = None
    if raw:
        try:
            obj = json.loads(raw)
            parsed = obj if isinstance(obj, dict) else None
        except (ValueError, TypeError):
            parsed = None
    return {"shot_id": sid, "scene_layout": parsed, "raw": raw}


@router.put("/drama/shots/{sid}/scene-layout")
async def update_scene_layout(
    sid: str,
    body: SceneLayoutBody,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M3: 更新分镜的 2D 空间布局;可选生成构图参考图(复用 t2i 链路)。

    布局序列化为 JSON 存入 shot.scene_layout;若 generate_reference=True,
    基于 layout 构造英文 prompt 调 ComfyUI t2i,把返回图片 URL 存入 shot.grid_image。
    """
    shot = _owned_shot(sid, user, session)
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")

    layout = body.layout or {}
    shot.scene_layout = json.dumps(layout, ensure_ascii=False)

    actors = layout.get("actors") or []
    props = layout.get("props") or []
    detail = f"更新场景构图: {len(actors)} 角色 {len(props)} 道具"

    if body.generate_reference:
        prompt = _layout_to_prompt(layout)
        if prompt.strip():
            # DramaClaw 借鉴 #4:layout actors 中与项目角色同名者用项目级稳定色,
            # 未知名一并分配新色(与项目角色合并排序后取模,保持确定性)
            if body.color_mark:
                proj_chars = session.exec(
                    select(DramaCharacter).where(DramaCharacter.project_id == shot.project_id)
                ).all()
                actor_names = [
                    n for n in (str(a.get("name") or "").strip() for a in actors) if n
                ]
                cmap = assign_character_colors([c.name for c in proj_chars] + actor_names)
                sub = {n: cmap[n] for n in actor_names if n in cmap}
                if sub:
                    prompt += color_mark_prompt_suffix(sub)
            enforce_generation_rate_limit(user)
            settings = get_settings()
            ckpt_name = settings.default_ckpt
            required = _t2i_required_models(ckpt_name)
            if body.worker:
                client = resolve_worker(body.worker)
            else:
                try:
                    client = await pool.pick(required=required)
                except ComfyUIError as e:
                    raise HTTPException(status_code=503, detail=str(e)) from e
            graph, seed_used = _build_t2i_graph(
                positive=prompt,
                ckpt_name=ckpt_name,
                width=project.width or 768,
                height=project.height or 384,
                seed=body.seed,
                filename_prefix=f"ToIV_drama_scene_layout_shot{shot.idx}",
            )
            client_id = uuid.uuid4().hex
            try:
                ref_pid = await client.queue_prompt(graph, client_id)
            except ComfyUIError as e:
                raise HTTPException(status_code=502, detail=str(e)) from e

            session.add(
                Job(
                    tenant_id=user.tenant_id,
                    user_id=user.id,
                    prompt_id=ref_pid,
                    worker=client.base_url,
                    kind="drama_scene_layout",
                    status="queued",
                    prompt=prompt,
                    seed=seed_used,
                    params=params_snapshot(body, seed=seed_used, ckpt_name=ckpt_name),
                )
            )
            session.commit()
            spawn_tracker(client, ref_pid)
            try:
                results = await wait_for_jobs(session, [ref_pid], timeout=_job_wait_timeout(600.0))
            except RuntimeError as e:
                raise HTTPException(status_code=504, detail=str(e)) from e
            urls = results.get(ref_pid, [])
            if urls:
                shot.grid_image = urls[0]
            detail += " 并生成构图参考图"

    _append_process(project, "scene_layout", detail)
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return _shot_dict(shot, session)


# ===========================================================================
# DramaClaw 借鉴 #4:颜色标记草图在场校验(只读 + CPU 检测,不生成产物,不加生成限流)
# ===========================================================================
class PresenceCheckBody(BaseModel):
    """在场校验请求:shot_ids 为 None 则校验项目下全部分镜。"""

    shot_ids: list[str] | None = None
    persist: bool = True  # 检测结果写回 shot.detected_colors 并记创作过程


@router.post("/drama/projects/{pid}/presence-check")
async def presence_check(
    pid: str,
    body: PresenceCheckBody,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """逐分镜核对 grid_image(宫格图或构图参考图)中角色标记色的在场情况。

    宫格判定:同一张 grid_image URL 被项目内多个 shot 共享 → 宫格参考图,
    按共享数推断 3x3(≤9)/5x5(>9),切第 shot.idx 块(行优先)检测;否则整图检测。
    与 shot.characters 期望集合比对得出 missing(漏画)/unexpected(多画)。
    图片取不回的分镜记 status=unavailable,不影响其它分镜。
    """
    p = _owned_project(pid, user, session)
    t0 = time.monotonic()

    # 项目级稳定颜色映射(与 grid-storyboard color_mark 同源:名字排序取模)
    proj_chars = session.exec(
        select(DramaCharacter).where(DramaCharacter.project_id == pid)
    ).all()
    color_map = assign_character_colors([c.name for c in proj_chars])

    all_shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == pid).order_by(DramaShot.idx)
    ).all()
    # 宫格判定用的引用计数须覆盖项目全部 shot(而非仅本次选中子集)
    url_refcount: dict[str, int] = {}
    for s in all_shots:
        if s.grid_image:
            url_refcount[s.grid_image] = url_refcount.get(s.grid_image, 0) + 1

    shots = all_shots
    if body.shot_ids is not None:
        wanted = set(body.shot_ids)
        shots = [s for s in all_shots if s.id in wanted]

    results: list[dict] = []
    bytes_cache: dict[str, bytes | None] = {}  # 宫格图多 shot 共享,同 URL 只取一次
    for shot in shots:
        try:
            expected = json.loads(shot.characters) if shot.characters else []
        except (ValueError, TypeError):
            expected = []
        entry: dict = {"shot_id": shot.id, "idx": shot.idx, "expected": expected}
        loc = parse_image_url(shot.grid_image)
        if loc is None:
            # 无图(空串)或不是产物代理 URL 都无法校验
            entry.update(
                status="unavailable",
                reason="no_image" if not shot.grid_image else "bad_url",
            )
            results.append(entry)
            continue
        if shot.grid_image not in bytes_cache:
            bytes_cache[shot.grid_image] = await fetch_product_image_bytes(
                pool,
                worker=loc["worker"],
                filename=loc["filename"],
                subfolder=loc["subfolder"],
                type_=loc["type"],
            )
        img_bytes = bytes_cache[shot.grid_image]
        if img_bytes is None:
            entry.update(status="unavailable", reason="fetch_failed")
            results.append(entry)
            continue
        # 宫格图:切出该 shot 对应面板再检测
        if url_refcount.get(shot.grid_image, 0) > 1:
            cols = 3 if url_refcount[shot.grid_image] <= 9 else 5
            panels = detect_grid_panels(img_bytes, f"{cols}x{cols}")
            if shot.idx < len(panels):
                img_bytes = panels[shot.idx]
        per_character = detect_character_presence(img_bytes, color_map) if color_map else {}
        detected = sorted(n for n, info in per_character.items() if info["present"])
        missing = sorted(set(expected) - set(detected))
        unexpected = sorted(set(detected) - set(expected))
        entry.update(
            status="ok",
            detected=detected,
            missing=missing,
            unexpected=unexpected,
            per_character=per_character,
        )
        # 位置感知校验:有 2D 布局(actors 带 x)时附带分带结果
        if shot.scene_layout and color_map:
            try:
                layout_obj = json.loads(shot.scene_layout)
            except (ValueError, TypeError):
                layout_obj = None
            actors = (layout_obj or {}).get("actors") or []
            if actors:
                entry["region_check"] = check_regions(img_bytes, color_map, actors)
        if body.persist:
            shot.detected_colors = json.dumps(
                {
                    "color_map": {n: color_map[n] for n in expected if n in color_map},
                    "per_character": per_character,
                    "checked_at": _now().isoformat(),
                    "source": "presence-check",
                },
                ensure_ascii=False,
            )
            session.add(shot)
        results.append(entry)

    total = len(results)
    ok = sum(1 for r in results if r.get("status") == "ok" and not r.get("missing"))
    missing_chars = sum(len(r.get("missing") or []) for r in results)
    no_image = sum(1 for r in results if r.get("status") == "unavailable")
    if body.persist:
        _append_process(p, "presence_check", f"在场校验 {ok}/{total} 通过, 缺失 {missing_chars} 角色")
        session.add(p)
        session.commit()
    logger.info(
        "presence-check project=%s shots=%d ok=%d missing_chars=%d no_image=%d elapsed=%.2fs",
        pid, total, ok, missing_chars, no_image, time.monotonic() - t0,
    )
    return {
        "shots": results,
        "summary": {
            "total": total,
            "ok": ok,
            "missing_chars": missing_chars,
            "no_image": no_image,
        },
    }


# ===========================================================================
# M6: 视频生成模型聚合(对标 liblib.tv 的 Seedance/Kling 多模型可选)
# ===========================================================================
class GenerateVideoV2Request(BaseModel):
    """M6: 多模型视频生成请求。model 字段决定走哪个生成器。"""

    model: str = Field(default="ltx", max_length=32)
    worker: str | None = Field(default=None, max_length=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    use_upscale: bool = False
    use_rife: bool = False
    # NSFW 开关:True 走 LTX-2.3 + 10Eros pool 链路(R18 保留);False(默认)SFW 链路
    # 已随 LTX-2.5 退役(2026-08-23)移除,生成器返回退役提示(SFW 请用 h3)
    nsfw: bool = False
    prompt_override: str | None = Field(default=None, max_length=2000)
    num_candidates: int = Field(default=1, ge=1, le=4)


@router.get("/drama/video-generators")
async def list_video_generators(
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
) -> dict:
    """M6: 列出所有已注册的视频生成器(供前端选择器)。

    QA-FULL-2026-08-11 P3(引擎状态一致性):available/unavailable_reason 由后端统一
    下发,数据源与 GET /api/models/engines 相同(engine_registry.list_engines,含并行
    探测 + 8s TTL 缓存);前端不再维护白名单,避免两处状态显示不一致。
    """
    from app.services.engine_registry import list_engines
    from app.services.video_generators import list_generators

    engines = {e["id"]: e for e in await list_engines(pool, user)}
    # 生成器 → 引擎注册表条目映射;ltx 仅余 R18 链路(LTX-2.5 SFW 已退役),
    # 映射 ltx-nsfw-t2v——SFW 上下文该条目被过滤,eng=None → 标不可用;
    # liveact 无注册表条目(走独立 worker,可用性=已配置
    # 基址);seedance/kling 为 stub(规划中,generate 返回固定错误),固定不可用。
    _ENGINE_OF = {"ltx": "ltx-nsfw-t2v", "h3": "h3-t2v"}
    liveact_ready = bool(get_settings().liveact_base)
    out: list[dict] = []
    for g in list_generators():
        eid = _ENGINE_OF.get(g["name"])
        if eid is not None:
            eng = engines.get(eid)
            if eng is None:
                # 映射条目在当前上下文不可见(如 R18 引擎在 SFW 上下文被过滤)
                g["available"] = False
                g["unavailable_reason"] = "引擎在当前内容上下文不可用(R18 专用或已退役)"
            else:
                g["available"] = bool(eng.get("available"))
                if eng.get("unavailable_reason"):
                    g["unavailable_reason"] = eng["unavailable_reason"]
        elif g["name"] == "liveact":
            g["available"] = liveact_ready
            if not liveact_ready:
                g["unavailable_reason"] = "LiveAct 未部署(TOIV_LIVEACT_BASE_URL 为空)"
        else:
            g["available"] = False
            g["unavailable_reason"] = "规划中,尚未接入"
        out.append(g)
    return {"generators": out}


def _next_seeds(base_seed: int | None, shot_seed: int, n: int) -> list[int]:
    """生成 n 个候选 seed。base_seed 优先,其次 shot_seed,其余随机。"""
    import random

    seeds: list[int] = []
    first = base_seed if base_seed is not None else (shot_seed if shot_seed > 0 else random.randint(0, 2**63 - 1))
    seeds.append(first)
    for _ in range(n - 1):
        seeds.append(random.randint(0, 2**63 - 1))
    return seeds


async def _writeback_candidate(prompt_id: str, candidate_id: str, shot_id: str) -> None:
    """候选生成任务完成后回写 candidate.url/status,并自动 pick 首个完成的候选。

    预算内循环续等(2026-08-15 永久 generating 修复,同 _await_shot_video_writeback):
    单轮等待窗口(≤900s)远短于 tracker 作业生命周期,排队作业极易超窗;此前
    「超时豁免」直接 return,之后 Job done 也无人回写 → 候选永久 generating。现改为
    以 settings.job_track_timeout(默认 7200s)为总预算循环续等:每轮
    wait_for_jobs(min(900, 剩余预算)),超时后 commit 刷新快照重读 Job——done(含
    竞态 done)取产物回写并保持首个完成者自动 pick;error / 不存在 → 抛走通用标
    error 路径;仍非终态且预算未尽 → 续等下一轮;预算耗尽 → 候选标 error(超出
    tracker 兜底窗口)。作业已 error / 不存在等其他异常路径维持标 error 旧语义不变。
    """
    from app.db import engine

    try:
        with Session(engine) as s:
            budget = get_settings().job_track_timeout
            deadline = time.monotonic() + budget
            round_no = 0
            while True:
                round_no += 1
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    # 预算耗尽:超出 tracker 兜底窗口仍未完成 → 候选标 error 终态收口
                    cand = s.get(DramaShotCandidate, candidate_id)
                    if cand and cand.status == "generating":
                        cand.status = "error"
                        cand.error = "生成超时(超出 tracker 兜底窗口)"
                        s.add(cand)
                        s.commit()
                    logger.warning(
                        "candidate %s writeback: 等待预算 %.0fs 耗尽,作业 %s 仍未完成,"
                        "候选标 error 收口",
                        candidate_id, budget, prompt_id,
                    )
                    return
                wait_err: RuntimeError | None = None
                results: dict[str, list[str]] = {}
                try:
                    results = await wait_for_jobs(
                        s, [prompt_id], timeout=_job_wait_timeout(min(900.0, remaining))
                    )
                except RuntimeError as e:
                    wait_err = e  # 先读 Job 最新状态再定性(续等 or 真失败)
                # commit 结束当前读事务快照,确保看到 tracker 其他 Session 的最新提交
                s.commit()
                job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
                urls = results.get(prompt_id, [])
                if not urls and job and job.status == "done" and job.result:
                    urls = json.loads(job.result)  # 竞态 done:wait 抛超时瞬间作业恰好完成
                cand = s.get(DramaShotCandidate, candidate_id)
                if not cand:
                    return
                if urls:
                    cand.url = urls[0]
                    cand.status = "done"
                    cand.error = ""
                    # 自动 pick:以 shot.video_url 为空作为竞争条件,首个完成者写入
                    shot = s.get(DramaShot, shot_id)
                    if shot and not shot.video_url:
                        cand.is_picked = True
                        shot.video_url = cand.url
                        shot.video_status = "done"
                        s.add(shot)
                elif wait_err is not None:
                    if job and job.status not in ("done", "error"):
                        # 仍非终态且预算未尽:续等下一轮
                        logger.warning(
                            "candidate %s writeback: 第 %d 轮等待超时但作业 %s 仍为 %s,"
                            "预算内续等(剩余 %.0fs)",
                            candidate_id, round_no, prompt_id, job.status, remaining,
                        )
                        continue
                    raise wait_err  # 作业已 error / 不存在 → 走通用异常标 error(旧语义)
                else:
                    # wait 正常返回但无产物(job done 但 result 空)→ 失败标记(旧语义)
                    cand.status = "error"
                    cand.error = "生成结果为空"
                s.add(cand)
                s.commit()
                return
    except Exception as e:  # noqa: BLE001
        logger.exception("candidate %s writeback failed: %s", candidate_id, e)
        with Session(engine) as s:
            cand = s.get(DramaShotCandidate, candidate_id)
            if cand and cand.status == "generating":
                cand.status = "error"
                cand.error = f"回写异常: {type(e).__name__}: {e}"[:200]
                s.add(cand)
                s.commit()


# ===========================================================================
# LiveAct 全身数字人(SoulX LiveAct 14B,workstation 独立 worker)
# ===========================================================================
def _v2_error_status(error: str) -> int:
    """generate-video-v2 生成失败的 HTTP 状态分类(语义化,不再一律 501)。

    - 生成器未接入(stub)/未部署 → 501(功能不存在,客户端重试无意义);
    - 上游 worker 不可达/超时/无可用 worker → 503(上游暂时不可用,可重试);
    - 其余(上游拒绝工作流等)→ 502(上游返回了错误响应)。
    """
    if "尚未接入" in error or "未部署" in error:
        return 501
    if (
        "不可达" in error
        or "超时" in error
        or "没有具备所需模型且可用的 worker" in error
    ):
        return 503
    return 502


async def _await_liveact_result(sid: str, task_id: str) -> None:
    """轮询 LiveAct worker /status,done 后拉 /result 落盘并回写 DramaShot。

    独立 DB session 生命周期(参照 _writeback_candidate),不与请求 session 共享。
    进程重启后轮询任务丢失:启动时 reconcile_interrupted 会把仍 generating 的
    LiveAct 分镜标 error(task_id 未持久化,找不回),前端可重新发起。
    """
    from app.db import engine

    base = get_settings().liveact_base
    deadline = time.monotonic() + _LIVEACT_TIMEOUT
    try:
        _drama_dir().mkdir(parents=True, exist_ok=True)
        name = f"drama-{uuid.uuid4().hex}.mp4"
        async with httpx.AsyncClient(timeout=60.0, trust_env=False) as http:
            while True:
                resp = await http.get(f"{base}/status/{task_id}")
                resp.raise_for_status()
                info = resp.json()
                status = info.get("status")
                if status == "done":
                    break
                if status == "error":
                    raise RuntimeError(info.get("error") or "LiveAct 生成失败")
                if time.monotonic() > deadline:
                    raise TimeoutError("LiveAct 生成超时(20 分钟)")
                await asyncio.sleep(_LIVEACT_POLL_INTERVAL)
            # mp4 流式落盘(不全量读内存;写盘走 to_thread,cifs NAS 不阻塞事件循环)
            async with http.stream("GET", f"{base}/result/{task_id}") as rr:
                rr.raise_for_status()
                await _stream_to_path(rr, _drama_dir() / name)

        with Session(engine) as s:
            shot = s.get(DramaShot, sid)
            if shot:
                shot.video_url = f"/api/drama/output/{name}"
                shot.video_status = "done"
                shot.video_model = "liveact"
                shot.error = ""
                s.add(shot)
                s.commit()
    except Exception as e:  # noqa: BLE001
        logger.exception("liveact task %s failed: %s", task_id, e)
        with Session(engine) as s:
            shot = s.get(DramaShot, sid)
            if shot and shot.video_status == "generating":
                shot.video_status = "error"
                shot.error = f"LiveAct 生成失败: {type(e).__name__}: {e}"[:200]
                s.add(shot)
                s.commit()


async def _generate_shot_video_liveact(
    sid: str,
    body: "GenerateVideoV2Request",
    shot: DramaShot,
    project: DramaProject,
    prompt: str,
    gen,
    user: User,
    session: Session,
    pool: WorkerPool,
) -> dict:
    """generate-video-v2 的 LiveAct 分支:参考图 + 配音音频直推 worker,后台轮询回写。"""
    if body.num_candidates > 1:
        raise HTTPException(status_code=422, detail="LiveAct 暂不支持多候选生成")
    if shot.voice_status != "done" or not shot.voice_url:
        raise HTTPException(
            status_code=422, detail="LiveAct 全身数字人需先完成配音(生成时长=配音时长)"
        )

    # 参考图:取分镜出场角色中第一个有 ref_image 的角色
    chars = _shot_characters(shot, session)
    ref_char = next((c for c in chars if c.ref_image.strip()), None)
    if not ref_char:
        raise HTTPException(
            status_code=422, detail="LiveAct 需要角色参考图,请先为出场角色设置参考图"
        )
    ref_url = ref_char.ref_image.strip()
    if not _allowed_ref(ref_url):
        raise HTTPException(status_code=400, detail="角色参考图来源不在白名单内")

    # 配音音频:voice_url 指向成片目录落盘的 wav,直接读盘
    voice_name = shot.voice_url.rsplit("/", 1)[-1]
    if not _VOICE_NAME_RE.match(voice_name):
        raise HTTPException(status_code=422, detail="配音文件非法,请重新生成配音")
    voice_path = _drama_dir() / voice_name
    if not voice_path.is_file():
        raise HTTPException(status_code=422, detail="配音文件不存在,请重新生成配音")
    audio_bytes = await asyncio.to_thread(voice_path.read_bytes)

    ref_image_bytes = await _fetch_ref_image_bytes(pool, ref_url)

    result = await gen.generate(
        prompt,
        fps=project.fps,
        seed=body.seed,
        ref_image_bytes=ref_image_bytes,
        audio_bytes=audio_bytes,
    )
    if not result.success:
        shot.video_status = "error"
        shot.error = result.error
        session.add(shot)
        session.commit()
        raise HTTPException(status_code=_v2_error_status(result.error), detail=result.error)

    task_id = (result.raw or {}).get("task_id", result.job_id)
    shot.video_model = "liveact"
    shot.video_status = "generating"
    shot.video_url = ""
    shot.error = ""
    _append_process(
        _owned_project(shot.project_id, user, session),
        "generate_video",
        "模型: liveact(SoulX 全身数字人,生成时长=配音时长)",
    )
    session.add(shot)
    session.commit()

    # 后台轮询 worker 状态,完成后落盘并回写 video_url(独立 DB session)
    _spawn(_await_liveact_result(sid, task_id))

    return {
        "task_id": task_id,
        "worker": (result.raw or {}).get("worker", ""),
        "shot_id": sid,
        "model": "liveact",
    }


@router.post("/drama/shots/{sid}/generate-video-v2")
async def generate_shot_video_v2(
    sid: str,
    body: GenerateVideoV2Request,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M6/M1: 多模型视频生成分发,支持单镜多候选。nsfw=true(10Eros)仅限 /nsfw 专区。"""
    enforce_generation_rate_limit(user)
    # R18 门控:nsfw=true 走 NSFW 专用视频底模(10Eros),无 X-NSFW 头一律 403(与 v1 同款)
    if body.nsfw:
        _gate_ltx_nsfw(user)
    shot = _owned_shot(sid, user, session)
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    prompt = (body.prompt_override or shot.prompt).strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="分镜提示词为空")
    # P1 衔接策略层:前一镜 matchcut 时追加 h3-seam-polish 转场约束
    prompt = _apply_seam_modifier(prompt, shot, _prev_shot(session, shot), project=project)
    # P2 @图片N 多参考图(services/h3_refs):H3 引擎且分镜角色有参考图
    # (三视图取正面)时,prompt 绝对开头加引用行;seam modifier 在末尾,互不干扰
    prompt = ref_prefix_for_shot(shot, session, engine=body.model) + prompt

    from app.services.video_generators import get_generator

    try:
        gen = get_generator(body.model, pool=pool)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

    # LiveAct 全身数字人:参考图 + 配音音频直推 worker,不走 ComfyUI pool/tracker
    if body.model == "liveact":
        return await _generate_shot_video_liveact(
            sid, body, shot, project, prompt, gen, user, session, pool
        )

    # 单候选:保持旧行为,直接更新 shot.video_status/video_url
    if body.num_candidates <= 1:
        result = await gen.generate(
            prompt,
            negative=shot.negative,
            width=project.width,
            height=project.height,
            duration_sec=shot.duration_sec,
            fps=project.fps,
            seed=body.seed,
            worker=body.worker,
            steps=body.steps,
            cfg=body.cfg,
            use_upscale=body.use_upscale,
            use_rife=body.use_rife,
            nsfw=body.nsfw,
            filename_prefix=f"ToIV_drama_shot{shot.idx}",
        )

        if not result.success:
            shot.video_status = "error"
            shot.error = result.error
            session.add(shot)
            session.commit()
            raise HTTPException(status_code=_v2_error_status(result.error), detail=result.error)

        raw = result.raw or {}
        prompt_id = raw.get("prompt_id", result.job_id)
        client_id = raw.get("client_id", "")
        worker_url = raw.get("worker", "")
        seed_used = raw.get("seed", body.seed or 0)
        session.add(
            Job(
                tenant_id=user.tenant_id,
                user_id=user.id,
                prompt_id=prompt_id,
                worker=worker_url,
                kind="drama_shot_video_v2",
                status="queued",
                prompt=prompt,
                seed=seed_used,
                nsfw=body.nsfw,
                params=params_snapshot(body, seed=seed_used, model=body.model),
            )
        )
        shot.video_model = body.model
        shot.video_status = "generating"
        shot.video_url = ""
        shot.seed = seed_used
        shot.error = ""
        _append_process(
            _owned_project(shot.project_id, user, session),
            "generate_video",
            f"模型: {body.model}",
        )
        session.add(shot)
        session.commit()

        # 挂回写:tracker 落库后把 video_url 写回 DramaShot(与 v1 端点同模式,
        # 否则 shot 永远停在 generating,前端轮询超时)
        _spawn(_await_shot_video_writeback(sid, prompt_id))

        return {
            "prompt_id": prompt_id,
            "client_id": client_id,
            "worker": worker_url,
            "seed": seed_used,
            "shot_id": sid,
            "model": body.model,
        }

    # 多候选:为每个候选创建记录并提交独立 Job
    seeds = _next_seeds(body.seed, shot.seed, body.num_candidates)
    shot.video_model = body.model
    shot.video_status = "generating"
    shot.video_url = ""
    shot.error = ""
    _append_process(
        _owned_project(shot.project_id, user, session),
        "generate_video",
        f"模型: {body.model}, 候选数: {body.num_candidates}",
    )
    session.add(shot)
    session.flush()

    created_candidates: list[DramaShotCandidate] = []
    jobs_info: list[tuple[str, str, str]] = []  # (prompt_id, candidate_id, worker_url)
    for i, seed in enumerate(seeds):
        result = await gen.generate(
            prompt,
            negative=shot.negative,
            width=project.width,
            height=project.height,
            duration_sec=shot.duration_sec,
            fps=project.fps,
            seed=seed,
            worker=body.worker,
            steps=body.steps,
            cfg=body.cfg,
            use_upscale=body.use_upscale,
            use_rife=body.use_rife,
            nsfw=body.nsfw,
            filename_prefix=f"ToIV_drama_shot{shot.idx}_c{i}",
        )

        cand = DramaShotCandidate(
            shot_id=sid,
            project_id=shot.project_id,
            seed=seed,
            video_model=body.model,
            status="generating" if result.success else "error",
            error="" if result.success else (result.error or "生成提交失败"),
        )
        session.add(cand)
        session.flush()
        created_candidates.append(cand)

        if result.success:
            raw = result.raw or {}
            prompt_id = raw.get("prompt_id", result.job_id)
            worker_url = raw.get("worker", "")
            session.add(
                Job(
                    tenant_id=user.tenant_id,
                    user_id=user.id,
                    prompt_id=prompt_id,
                    worker=worker_url,
                    kind="drama_shot_video_v2",
                    status="queued",
                    prompt=prompt,
                    seed=seed,
                    nsfw=body.nsfw,
                    params=params_snapshot(body, seed=seed, model=body.model),
                )
            )
            jobs_info.append((prompt_id, cand.id, worker_url))
        else:
            cand.error = result.error or "生成提交失败"
            session.add(cand)

    session.commit()

    for prompt_id, candidate_id, _worker_url in jobs_info:
        _spawn(_writeback_candidate(prompt_id, candidate_id, sid))

    return {
        "shot_id": sid,
        "model": body.model,
        "num_candidates": len(created_candidates),
        "candidates": [_candidate_dict(c) for c in created_candidates],
    }


# ===========================================================================
# M1: 候选管理(列表 / 挑选 / 删除)
# ===========================================================================
@router.get("/drama/shots/{sid}/candidates")
def list_shot_candidates(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """获取分镜的所有视频候选。"""
    _owned_shot(sid, user, session)
    rows = session.exec(
        select(DramaShotCandidate)
        .where(DramaShotCandidate.shot_id == sid)
        .order_by(DramaShotCandidate.created_at)
    ).all()
    return [_candidate_dict(c) for c in rows]


@router.post("/drama/shots/{sid}/candidates/{cid}/pick")
def pick_shot_candidate(
    sid: str,
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """把指定候选设为 active,并更新 shot.video_url/video_status=done。"""
    shot = _owned_shot(sid, user, session)
    cand = session.get(DramaShotCandidate, cid)
    if not cand or cand.shot_id != sid:
        raise HTTPException(status_code=404, detail="候选不存在")

    # 把其他候选 unpick
    for other in session.exec(
        select(DramaShotCandidate).where(DramaShotCandidate.shot_id == sid)
    ).all():
        other.is_picked = False
        session.add(other)

    cand.is_picked = True
    shot.video_url = cand.url
    shot.video_status = "done"
    session.add(cand)
    session.add(shot)
    session.commit()
    session.refresh(cand)
    return _candidate_dict(cand)


@router.delete("/drama/shots/{sid}/candidates/{cid}")
def delete_shot_candidate(
    sid: str,
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删除指定候选;若删除的是 active 候选,回退 shot 状态。"""
    shot = _owned_shot(sid, user, session)
    cand = session.get(DramaShotCandidate, cid)
    if not cand or cand.shot_id != sid:
        raise HTTPException(status_code=404, detail="候选不存在")

    was_picked = cand.is_picked
    session.delete(cand)

    remaining = session.exec(
        select(DramaShotCandidate).where(DramaShotCandidate.shot_id == sid)
    ).all()
    # 过滤掉已删除的当前对象(会话中仍可能出现在列表里)
    remaining = [c for c in remaining if c.id != cid]

    if was_picked:
        # active 被删:看是否还有生成中的候选
        any_generating = any(c.status == "generating" for c in remaining)
        shot.video_url = ""
        shot.video_status = "generating" if any_generating else "pending"
        session.add(shot)
    session.commit()
    return {"ok": True}


# ===========================================================================
# AICG 四层模型流水线 — L2 润色 / L3 精修（2026-07-24 接入）
# ===========================================================================

class RefineRequest(BaseModel):
    """L2/L3 文本润色/精修请求。"""
    text: str = Field(..., description="待润色/精修的文本（剧本/对白/分镜描述）")
    instruction: str = Field(
        default="润色以下文本，增强情感张力和画面感，保持原意不变：",
        description="润色/精修指令",
    )
    temperature: float = Field(default=0.6, description="采样温度")


_L2_REFINE_SYSTEM = (
    "你是短剧编剧大师。对用户给出的剧本/对白进行润色，增强情感张力、"
    "画面感和节奏感。保持原意不变，不增删情节，只提升表达质量。"
    "直接输出润色后的文本，不要输出任何解释或分析。"
)

_L3_POLISH_SYSTEM = (
    "你是金牌剧本终稿编辑。对用户给出的文本进行深度精修："
    "优化对白自然度、强化戏剧冲突、打磨转场节奏、统一风格基调。"
    "保持原意和情节结构不变，只提升终稿质量。"
    "直接输出精修后的文本，不要输出任何解释或分析。"
)


def _drama_llm_layer(value: str) -> str:
    """校验配置的 LLM 层,非法值回退 L1(与 storyboard 同一策略)。"""
    layer = (value or "").upper()
    return layer if layer in ("L1", "L2", "L3", "L4") else "L1"


def _layer_model_name(layer: str) -> str:
    """返回指定层实际使用的模型名(用于响应回显)。"""
    s = get_settings()
    return {
        "L2": s.llm_l2_model,
        "L3": s.llm_l3_model,
    }.get(layer, s.llm_model)


def _polish_layer() -> str:
    """精修(polish,含批量)走配置层;默认 L1 保持行为不变,EXO 恢复后可切 L3。"""
    return _drama_llm_layer(get_settings().drama_polish_layer)


def _refine_layer() -> str:
    """润色(refine)走独立配置层(默认 L2);EXO 未就绪时 chat_layered 自动降级 L1。"""
    return _drama_llm_layer(get_settings().drama_refine_layer)


@router.post("/drama/projects/{pid}/refine")
async def refine_script(
    pid: str,
    body: RefineRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """主力润色 — 走配置层(TOIV_DRAMA_REFINE_LAYER,默认 L2)。

    适合关键场景打磨、情感戏、转折点。同步返回结果（timeout 120s）。
    EXO 未就绪时 chat_layered 自动降级 L1,功能可用;恢复后走 Kimi-K3。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="待润色文本为空")

    layer = _refine_layer()

    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": _L2_REFINE_SYSTEM},
                {"role": "user", "content": f"{body.instruction}\n\n{body.text}"},
            ],
            layer=layer,
            temperature=body.temperature,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    refined = (msg.get("content") or "").strip()
    if not refined:
        raise HTTPException(status_code=502, detail=f"{layer} 润色返回空内容，请重试")

    _append_process(p, "refine_l2", f"{layer} 润色: {body.text[:30]}... → {len(refined)} 字")
    session.add(p)
    session.commit()

    return {
        "layer": layer,
        "model": _layer_model_name(layer),
        "original": body.text,
        "refined": refined,
    }


@router.post("/drama/projects/{pid}/polish")
async def polish_script(
    pid: str,
    body: RefineRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """终稿精修 — 走配置层(TOIV_DRAMA_POLISH_LAYER,默认 L1)。

    适合终稿质量提升、高难度剧情。同步返回（timeout 300s）。
    EXO 恢复后可将配置切 L3(GLM-5.2-DQ4plus-q8)。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="待精修文本为空")

    layer = _polish_layer()
    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": _L3_POLISH_SYSTEM},
                {"role": "user", "content": f"{body.instruction}\n\n{body.text}"},
            ],
            layer=layer,
            temperature=body.temperature,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    polished = (msg.get("content") or "").strip()
    if not polished:
        raise HTTPException(status_code=502, detail=f"{layer} 精修返回空内容，请重试")

    _append_process(p, "polish_l3", f"{layer} 精修: {body.text[:30]}... → {len(polished)} 字")
    session.add(p)
    session.commit()

    return {
        "layer": layer,
        "model": _layer_model_name(layer),
        "original": body.text,
        "polished": polished,
    }


# ===========================================================================
# L3 异步批量精修（GLM-5.2-fp8 单镜 ~115s，串行阻塞用户交互）
#
# 设计:
#   · POST /drama/projects/{pid}/polish/batch  立即返回 task_id,后台并发执行
#   · GET  /drama/projects/{pid}/polish-tasks/{task_id}  查询进度/结果
#   · 进度存入 DramaProject.process_data(step=polish_batch_l3,task_id=...)
#   · asyncio.Semaphore 限并发(默认 4,匹配 EXO 4 台 Mac Studio)
#   · uvicorn 单进程重启会丢任务(个人学习项目可接受,生产级需 Celery/RQ)
# ===========================================================================

class BatchPolishRequest(BaseModel):
    """L3 批量精修请求。"""
    # 优先用 shot_ids:取分镜 prompt+dialogue 作为待精修文本,精修后回写 shot.prompt
    shot_ids: list[str] | None = Field(default=None, description="待精修的分镜 ID 列表")
    # 或直接传文本数组(与 shot_ids 二选一;同时传以 shot_ids 为准)
    texts: list[str] | None = Field(default=None, description="待精修的文本数组")
    instruction: str = Field(
        default="深度精修以下分镜描述与对白,优化画面感、戏剧张力和节奏:",
        description="精修指令",
    )
    temperature: float = Field(default=0.6, ge=0.0, le=2.0)
    # 并发上限:EXO 4 台 Mac Studio,默认 4
    concurrency: int = Field(default=4, ge=1, le=8)


# 批量任务在 process_data 中的最大保留条数(防止无限增长)
_MAX_BATCH_TASKS_IN_PROCESS = 20


def _append_batch_polish_task(p: DramaProject, task_id: str, total: int,
                              source: str, instruction: str) -> None:
    """在 process_data 末尾追加一条批量精修任务初始记录(pending)。"""
    try:
        steps = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        steps = []
    # 保留最近 N 条 polish_batch_l3 记录,删除更早的
    batch_tasks = [s for s in steps if s.get("step") == "polish_batch_l3"]
    if len(batch_tasks) >= _MAX_BATCH_TASKS_IN_PROCESS:
        # 删除最早的(按 ts 排序)
        batch_tasks.sort(key=lambda s: s.get("ts", ""))
        for old in batch_tasks[:len(batch_tasks) - _MAX_BATCH_TASKS_IN_PROCESS + 1]:
            steps.remove(old)
    steps.append({
        "step": "polish_batch_l3",
        "task_id": task_id,
        "ts": _now().isoformat(),
        "status": "pending",
        "source": source,  # "shots" 或 "texts"
        "instruction": instruction[:200],
        "total": total,
        "done": 0,
        "results": [],
    })
    p.process_data = json.dumps(steps, ensure_ascii=False)


def _update_batch_polish_task(pid: str, task_id: str, *,
                              status: str | None = None,
                              add_result: dict | None = None) -> None:
    """后台任务更新批量精修进度(独立 Session,避免跨 await 复用)。"""
    from app.db import engine
    with Session(engine) as s:
        p = s.get(DramaProject, pid)
        if not p:
            return
        try:
            steps = json.loads(p.process_data) if p.process_data else []
        except (ValueError, TypeError):
            steps = []
        for step in steps:
            if (step.get("step") == "polish_batch_l3"
                    and step.get("task_id") == task_id):
                if status:
                    step["status"] = status
                if add_result is not None:
                    step.setdefault("results", []).append(add_result)
                    step["done"] = len(step["results"])
                step["ts"] = _now().isoformat()
                break
        p.process_data = json.dumps(steps, ensure_ascii=False)
        s.add(p)
        s.commit()


def _find_batch_polish_task(p: DramaProject, task_id: str) -> dict | None:
    """从 process_data 查找指定 task_id 的批量精修任务记录。"""
    try:
        steps = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        return None
    for step in steps:
        if (step.get("step") == "polish_batch_l3"
                and step.get("task_id") == task_id):
            return step
    return None


async def _run_batch_polish(
    pid: str, task_id: str,
    items: list[dict],  # [{"shot_id": "...", "text": "..."}]
    instruction: str, temperature: float, concurrency: int,
) -> None:
    """后台执行批量精修(层由配置决定)。每个 item 独立调用 chat_layered,失败不中断整体。"""
    sem = asyncio.Semaphore(concurrency)
    layer = _polish_layer()
    _update_batch_polish_task(pid, task_id, status="running")

    async def _polish_one(item: dict) -> dict:
        async with sem:
            shot_id = item.get("shot_id")
            text = item["text"]
            try:
                msg = await get_ctx().service("llm").chat_layered(
                    [
                        {"role": "system", "content": _L3_POLISH_SYSTEM},
                        {"role": "user", "content": f"{instruction}\n\n{text}"},
                    ],
                    layer=layer,
                    temperature=temperature,
                )
                polished = (msg.get("content") or "").strip()
                if not polished:
                    return {
                        "shot_id": shot_id, "original": text, "polished": "",
                        "status": "error", "error": f"{layer} 返回空内容",
                    }
                # 若来源是分镜,回写精修结果到 shot.prompt
                if shot_id:
                    from app.db import engine
                    with Session(engine) as s:
                        shot = s.get(DramaShot, shot_id)
                        if shot:
                            # 仅当项目归属一致时回写(防御性)
                            if shot.project_id == pid:
                                shot.prompt = polished[:2000]
                                s.add(shot)
                                s.commit()
                return {
                    "shot_id": shot_id, "original": text, "polished": polished,
                    "status": "done", "error": "",
                }
            except Exception as e:  # noqa: BLE001
                logger.exception("batch polish shot %s failed: %s", shot_id, e)
                return {
                    "shot_id": shot_id, "original": text, "polished": "",
                    "status": "error", "error": f"{type(e).__name__}: {e}"[:200],
                }

    tasks = [_polish_one(item) for item in items]
    for coro in asyncio.as_completed(tasks):
        result = await coro
        _update_batch_polish_task(pid, task_id, add_result=result)

    _update_batch_polish_task(pid, task_id, status="done")


@router.post("/drama/projects/{pid}/polish/batch")
async def polish_batch(
    pid: str,
    body: BatchPolishRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """异步批量精修 — 层由 TOIV_DRAMA_POLISH_LAYER 决定(当前默认 L1),并发处理多个分镜/文本。

    立即返回 task_id,后台 _spawn 协程执行。
    进度通过 GET /drama/projects/{pid}/polish-tasks/{task_id} 查询。

    Args:
        shot_ids: 待精修分镜 ID(取 prompt+dialogue 拼接作为待精修文本,
                  精修结果回写 shot.prompt)。优先于 texts。
        texts: 待精修文本数组(shot_ids 为空时使用)。
        concurrency: 并发上限(默认 4,匹配 EXO 4 台 Mac Studio)。

    Returns:
        task_id / total / status:"pending"。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)

    # 构造 items:[{"shot_id": "...", "text": "..."}]
    items: list[dict] = []
    if body.shot_ids:
        for sid in body.shot_ids:
            shot = session.get(DramaShot, sid)
            if not shot or shot.project_id != pid:
                raise HTTPException(
                    status_code=404, detail=f"分镜不存在或归属不匹配: {sid}")
            text_parts = []
            if shot.prompt:
                text_parts.append(f"[画面提示] {shot.prompt}")
            if shot.dialogue:
                text_parts.append(f"[对白] {shot.dialogue}")
            if shot.scene:
                text_parts.append(f"[场景] {shot.scene}")
            text = "\n".join(text_parts) if text_parts else ""
            if not text.strip():
                continue  # 空分镜跳过
            items.append({"shot_id": sid, "text": text})
        source = "shots"
    elif body.texts:
        for i, text in enumerate(body.texts):
            if text.strip():
                items.append({"shot_id": None, "text": text})
        source = "texts"
    else:
        raise HTTPException(
            status_code=422, detail="shot_ids 和 texts 至少提供一个且非空")

    if not items:
        raise HTTPException(
            status_code=422, detail="待精修内容为空(分镜无 prompt/dialogue/scene)")

    task_id = uuid.uuid4().hex
    _append_batch_polish_task(p, task_id, len(items), source, body.instruction)
    session.add(p)
    session.commit()

    # 启动后台任务(独立 Session,避免复用当前 session)
    _spawn(_run_batch_polish(
        pid, task_id, items, body.instruction, body.temperature, body.concurrency,
    ))

    return {
        "task_id": task_id,
        "total": len(items),
        "status": "pending",
        "poll_url": f"/api/drama/projects/{pid}/polish-tasks/{task_id}",
        "poll_interval_sec": 10,
        "note": "GLM-5.2-fp8 单镜 ~115s,全量完成预计 total * 115 / concurrency 秒",
    }


@router.get("/drama/projects/{pid}/polish-tasks/{task_id}")
def get_polish_task(
    pid: str,
    task_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """查询 L3 批量精修任务进度。"""
    p = _owned_project(pid, user, session)
    task = _find_batch_polish_task(p, task_id)
    if not task:
        raise HTTPException(status_code=404, detail="批量精修任务不存在")
    return {
        "task_id": task_id,
        "status": task.get("status", "unknown"),
        "source": task.get("source", ""),
        "total": task.get("total", 0),
        "done": task.get("done", 0),
        "results": task.get("results", []),
        "started_at": task.get("ts"),
        "updated_at": task.get("ts"),
        "model": _layer_model_name(_polish_layer()),
    }


@router.get("/drama/projects/{pid}/polish-tasks")
def list_polish_tasks(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """列出项目最近的所有批量精修任务(精简版,不含 results 详情)。"""
    p = _owned_project(pid, user, session)
    try:
        steps = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        steps = []
    out = []
    for step in steps:
        if step.get("step") != "polish_batch_l3":
            continue
        out.append({
            "task_id": step.get("task_id"),
            "status": step.get("status", "unknown"),
            "source": step.get("source", ""),
            "total": step.get("total", 0),
            "done": step.get("done", 0),
            "ts": step.get("ts"),
        })
    # 按 ts 倒序(最新在前)
    out.sort(key=lambda t: t.get("ts", ""), reverse=True)
    return out


# ===========================================================================
# 图片 → VLM 解析 → 自动建项目+分镜 → 后台自动管线(autorun)
#
# 设计(对齐 polish/batch 的任务记录模式):
#   · POST /drama/projects/from-image  上传 1-9 张图,VLM 解析扩写成短剧,
#     立即返回 project+shots;auto=true 时追加 autorun 记录并后台执行
#   · autorun 进度存 DramaProject.process_data(step=autorun,task_id=...)
#   · 后台管线:逐镜视频(首镜用上传原图作 i2v 首帧) → 逐镜配音 → 合成成片
#   · 单镜失败不中断整体;uvicorn 单进程重启丢任务(与批量精修同级可接受)
# ===========================================================================

# 上传图片格式 → MIME(与 animatic 同一安全策略:拒绝路径穿越,按扩展名定 MIME)
_FROM_IMAGE_MIME: dict[str, str] = {
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".png": "image/png",
    ".webp": "image/webp",
}
_FROM_IMAGE_MAX_BYTES = 20 * 1024 * 1024  # 单张 ≤ 20MB(同 animatic)
# autorun 任务在 process_data 中的最大保留条数(防无限增长)
_MAX_AUTORUN_TASKS_IN_PROCESS = 20


def _append_autorun_task(p: DramaProject, task_id: str, total: int) -> None:
    """在 process_data 末尾追加一条 autorun 任务初始记录(pending)。"""
    try:
        steps = json.loads(p.process_data) if p.process_data else []
    except (ValueError, TypeError):
        steps = []
    # 保留最近 N 条 autorun 记录,删除更早的(与批量精修同一策略)
    autorun_tasks = [s for s in steps if s.get("step") == "autorun"]
    if len(autorun_tasks) >= _MAX_AUTORUN_TASKS_IN_PROCESS:
        autorun_tasks.sort(key=lambda s: s.get("ts", ""))
        for old in autorun_tasks[:len(autorun_tasks) - _MAX_AUTORUN_TASKS_IN_PROCESS + 1]:
            steps.remove(old)
    steps.append({
        "step": "autorun",
        "task_id": task_id,
        "ts": _now().isoformat(),
        "status": "pending",
        "total": total,
        "done": 0,
        "current": "",
        "error": "",
    })
    p.process_data = json.dumps(steps, ensure_ascii=False)


def _update_autorun_task(pid: str, task_id: str, *,
                         status: str | None = None,
                         current: str | None = None,
                         error: str | None = None,
                         done: int | None = None) -> None:
    """后台任务更新 autorun 进度(独立 Session,避免跨 await 复用)。"""
    from app.db import engine
    with Session(engine) as s:
        p = s.get(DramaProject, pid)
        if not p:
            return
        try:
            steps = json.loads(p.process_data) if p.process_data else []
        except (ValueError, TypeError):
            steps = []
        for step in steps:
            if step.get("step") == "autorun" and step.get("task_id") == task_id:
                if status is not None:
                    step["status"] = status
                if current is not None:
                    step["current"] = current
                if error is not None:
                    step["error"] = error
                if done is not None:
                    step["done"] = done
                step["ts"] = _now().isoformat()
                break
        p.process_data = json.dumps(steps, ensure_ascii=False)
        s.add(p)
        s.commit()


async def _run_autorun(pid: str, task_id: str, first_image: bytes | None) -> None:
    """from-image 自动管线:逐镜视频(有界并发) → 逐镜配音(有界并发) → 合成成片。

    单镜失败不中断整体(该镜标 error 继续);全程短 Session,不跨 await 持有。
    首镜(idx=0)若有上传原图则作 i2v 首帧,锁定与参考图的视觉一致性。
    视频阶段 Semaphore 限流(ComfyUI WorkerPool 可把并发任务摊到多 worker),
    配音阶段另配更小的限流(IndexTTS2 单卡);进度经集中计数 + 锁更新,
    防并发下 done 计数互相覆盖。
    """
    from app.db import engine
    try:
        _update_autorun_task(pid, task_id, status="running")
        pool = get_pool()  # lru_cache 单例,与端点 Depends(get_pool) 同一实例
        settings = get_settings()

        with Session(engine) as s:
            shot_ids = [
                sh.id for sh in s.exec(
                    select(DramaShot)
                    .where(DramaShot.project_id == pid)
                    .order_by(DramaShot.idx)
                ).all()
            ]
        total = len(shot_ids)
        progress_lock = asyncio.Lock()
        progress = {"video_done": 0, "voice_done": 0}

        async def _tick_video() -> None:
            # 集中式进度更新:计数与落库在同一锁内,防并发写互相覆盖
            async with progress_lock:
                progress["video_done"] += 1
                _update_autorun_task(
                    pid, task_id, done=progress["video_done"],
                    current=f"分镜视频 {progress['video_done']}/{total} 完成",
                )

        # —— 阶段 1:逐镜视频(有界并发,单镜失败不中断) ——
        video_sem = asyncio.Semaphore(max(1, settings.drama_autorun_video_concurrency))

        async def _video_one(i: int, sid: str) -> None:
            async with video_sem:
                try:
                    with Session(engine) as s:
                        shot = s.get(DramaShot, sid)
                        project = s.get(DramaProject, pid)
                        owner = s.get(User, project.user_id) if project else None
                        if not shot or not project or not owner:
                            return
                        prompt_id, _cid, _wurl, _seed = await _submit_shot_video(
                            shot,
                            project,
                            pool=pool,
                            session=s,
                            user=owner,
                            steps=20,
                            cfg=1.0,
                            use_upscale=False,
                            use_rife=False,
                            first_image_bytes=first_image if i == 0 else None,
                        )
                    ok = await _await_shot_video_writeback(sid, prompt_id)
                    if not ok:
                        logger.warning("autorun %s 分镜 %s 视频回写失败", task_id, sid)
                except Exception as e:  # noqa: BLE001
                    logger.exception("autorun %s 分镜 %s 视频提交失败: %s", task_id, sid, e)
                    with Session(engine) as s2:
                        shot2 = s2.get(DramaShot, sid)
                        if shot2 and shot2.video_status not in ("done", "error"):
                            shot2.video_status = "error"
                            shot2.error = f"自动管线提交失败: {type(e).__name__}: {e}"[:200]
                            s2.add(shot2)
                            s2.commit()
                finally:
                    await _tick_video()

        await asyncio.gather(*(_video_one(i, sid) for i, sid in enumerate(shot_ids)))

        # —— 阶段 2:逐镜配音(有台词的镜,有界并发) ——
        with Session(engine) as s:
            voice_total = sum(
                1 for sid in shot_ids
                if (sh := s.get(DramaShot, sid)) and sh.dialogue.strip()
            )
        voice_sem = asyncio.Semaphore(max(1, settings.drama_autorun_voice_concurrency))

        async def _voice_one(sid: str) -> None:
            async with voice_sem:
                with Session(engine) as s:
                    shot = s.get(DramaShot, sid)
                    if not shot or not shot.dialogue.strip():
                        return
                    try:
                        await _submit_shot_voice(shot, s, settings)
                    except Exception as e:  # noqa: BLE001
                        logger.exception("autorun %s 分镜 %s 配音失败: %s", task_id, sid, e)
                        shot.voice_status = "error"
                        shot.error = f"配音失败: {type(e).__name__}: {e}"[:200]
                        s.add(shot)
                        s.commit()
                async with progress_lock:
                    progress["voice_done"] += 1
                    _update_autorun_task(
                        pid, task_id,
                        current=f"分镜配音 {progress['voice_done']}/{voice_total} 完成",
                    )

        await asyncio.gather(*(_voice_one(sid) for sid in shot_ids))

        # —— 阶段 3:合成成片(≥1 镜完成才合成) ——
        _update_autorun_task(pid, task_id, status="assembling", current="合成成片中")
        with Session(engine) as s:
            p = s.get(DramaProject, pid)
            if not p:
                return
            ready = [
                sh for sh in s.exec(
                    select(DramaShot).where(DramaShot.project_id == pid)
                ).all()
                if sh.video_status == "done" and sh.video_url
            ]
            if not ready:
                _update_autorun_task(
                    pid, task_id, status="error",
                    error="无已完成分镜视频,跳过合成",
                )
                return
            # _do_assemble 成功后会回写 p.video_url / p.status="ready" 并 commit
            await _do_assemble(p, AssembleOptions(), pool, s)

        _update_autorun_task(pid, task_id, status="done", current="")
    except Exception as e:  # noqa: BLE001
        logger.exception("autorun %s 项目 %s 失败: %s", task_id, pid, e)
        _update_autorun_task(
            pid, task_id, status="error",
            error=f"{type(e).__name__}: {e}"[:200],
        )


# 后台任务记录的非终态状态(重启后永远停在这些状态,需 reconcile 收口)
_INTERRUPTED_STEP_STATUS = ("pending", "running", "assembling")


def reconcile_interrupted() -> dict:
    """api 启动时收口因进程重启中断的短剧后台任务(参照 comfy.tracker.reconcile_pending)。

    - video_status=generating 的 ComfyUI 分镜:按 seed+prompt 从 Job 表找回
      prompt_id → 重挂 _await_shot_video_writeback(Job 本身的追踪由
      tracker.reconcile_pending 重挂);Job 已 done 的直接回写 video_url;
      找不回/已 error 的标 error,不永久 generating。
      两段匹配(2026-08-15 prompt_override 误标 error 修复):generate-video-v2
      传 prompt_override 时 Job.prompt 存的是 override 文本,shot.prompt 仍是原
      LLM 提示词,精确匹配必然落空 → 先按 kind+seed+prompt 精确匹配;查不到且
      seed 非 0(seed=0 是默认值,碰撞率高,不启用兜底)则回退为 kind+seed+同用户
      (项目属主)最新一条并 logger.info 记录;仍查不到才标 error。
    - LiveAct 分镜(task_id 未持久化,重启后找不回):标 error,提示重新生成。
    - process_data 中 autorun/批量精修记录停在非终态:标 error 并注明
      「服务重启中断,可重新触发」,不自动重跑整管,避免意外算力消耗。
    需在已有事件循环的上下文调用(_spawn 内用 create_task)。返回各类处置计数。
    """
    from app.db import engine

    stats = {"rehang": 0, "writeback": 0, "error": 0, "task_interrupted": 0}
    rehang: list[tuple[str, str]] = []  # (shot_id, prompt_id)
    with Session(engine) as s:
        shots = s.exec(
            select(DramaShot).where(DramaShot.video_status == "generating")
        ).all()
        for shot in shots:
            if shot.video_model == "liveact":
                shot.video_status = "error"
                shot.error = "服务重启中断,LiveAct 任务不可恢复,请重新生成"
                s.add(shot)
                stats["error"] += 1
                continue
            # 第一段:kind + seed + prompt 精确匹配
            job = s.exec(
                select(Job)
                .where(Job.kind.like("drama_shot_video%"))  # type: ignore[union-attr]
                .where(Job.seed == shot.seed)
                .where(Job.prompt == shot.prompt.strip())
                .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
            ).first()
            if job is None and shot.seed != 0:
                # 第二段兜底:prompt_override 时 Job.prompt 存的是 override 文本,
                # 与 shot.prompt(原 LLM 提示词)不一致,精确匹配必然落空 → 回退为
                # kind + seed + 同用户(项目属主)最新一条。seed=0 是默认值碰撞率高,
                # 不启用兜底,只认精确匹配,防误配他人/他镜作业。
                project = s.get(DramaProject, shot.project_id)
                if project is not None:
                    job = s.exec(
                        select(Job)
                        .where(Job.kind.like("drama_shot_video%"))  # type: ignore[union-attr]
                        .where(Job.seed == shot.seed)
                        .where(Job.user_id == project.user_id)
                        .order_by(Job.created_at.desc())  # type: ignore[attr-defined]
                    ).first()
                    if job is not None:
                        logger.info(
                            "drama reconcile: shot %s prompt 精确匹配落空,"
                            "走 seed+属主兜底找回作业 %s",
                            shot.id, job.prompt_id,
                        )
            if job and job.prompt_id and job.status in ("queued", "running"):
                rehang.append((shot.id, job.prompt_id))
                stats["rehang"] += 1
            elif job and job.status == "done" and job.result:
                urls = json.loads(job.result)
                if urls:
                    shot.video_url = urls[0]
                    shot.video_status = "done"
                    shot.error = ""
                    s.add(shot)
                    stats["writeback"] += 1
                else:
                    shot.video_status = "error"
                    shot.error = "生成结果为空(重启收口)"
                    s.add(shot)
                    stats["error"] += 1
            else:
                shot.video_status = "error"
                shot.error = "服务重启中断,生成任务不可恢复,请重新生成"
                s.add(shot)
                stats["error"] += 1

        # autorun / 批量精修任务记录:停在非终态 → 标中断(不自动重跑)
        for p in s.exec(select(DramaProject)).all():
            try:
                steps = json.loads(p.process_data) if p.process_data else []
            except (ValueError, TypeError):
                continue
            changed = False
            for step in steps:
                if (
                    step.get("step") in ("autorun", "polish_batch_l3")
                    and step.get("status") in _INTERRUPTED_STEP_STATUS
                ):
                    step["status"] = "error"
                    step["error"] = "服务重启中断,可重新触发"
                    step["current"] = ""
                    step["ts"] = _now().isoformat()
                    changed = True
                    stats["task_interrupted"] += 1
            if changed:
                p.process_data = json.dumps(steps, ensure_ascii=False)
                s.add(p)
        s.commit()

    for sid, prompt_id in rehang:
        _spawn(_await_shot_video_writeback(sid, prompt_id))
    if any(stats.values()):
        logger.info("drama reconcile: %s", stats)
    return stats


@router.post("/drama/projects/from-image")
async def create_project_from_image(
    images: list[UploadFile] = File(...),
    hint: str = Form(""),
    style: str = Form(""),
    num_shots: int = Form(8),
    width: int = Form(1920),
    height: int = Form(1080),
    fps: int = Form(16),
    auto: bool = Form(True),
    user: User = Depends(get_current_user),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """上传参考图 → VLM 解析 → 自动建短剧项目+分镜 → 后台自动管线(autorun)。

    图片 1-9 张(jpg/jpeg/png/webp,单张 ≤20MB);auto=true 时后台自动执行
    逐镜视频 → 配音 → 合成成片,进度在 project.process_data(step=autorun) 查询。
    """
    enforce_generation_rate_limit(user)

    # —— 上传校验(数量/格式/路径穿越/大小,同 animatic 安全策略) ——
    if not 1 <= len(images) <= 9:
        raise HTTPException(status_code=422, detail="图片数量须为 1-9 张")
    payloads: list[tuple[bytes, str]] = []
    for img in images:
        name = img.filename or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            raise HTTPException(status_code=422, detail="非法文件名(禁止路径穿越)")
        ext = Path(name).suffix.lower()
        mime = _FROM_IMAGE_MIME.get(ext)
        if not mime:
            raise HTTPException(
                status_code=422,
                detail=f"不支持的图片格式(仅 {', '.join(sorted(_FROM_IMAGE_MIME))})",
            )
        data = await img.read()
        if not data:
            raise HTTPException(status_code=422, detail=f"图片为空: {name}")
        if len(data) > _FROM_IMAGE_MAX_BYTES:
            raise HTTPException(status_code=422, detail=f"图片超过 20MB: {name}")
        payloads.append((data, mime))

    # —— 参数校验(分辨率/帧率复用 ProjectIn 约束,宽高取偶) ——
    if not 4 <= num_shots <= 16:
        raise HTTPException(status_code=422, detail="镜头数量须为 4-16")
    if not 256 <= width <= 1920 or not 256 <= height <= 1080:
        raise HTTPException(status_code=422, detail="分辨率越界(宽 256-1920,高 256-1080)")
    if not 4 <= fps <= 30:
        raise HTTPException(status_code=422, detail="帧率须为 4-30")
    width -= width % 2
    height -= height % 2

    # —— VLM 解析图片 → 短剧 JSON ——
    obj = await analyze_storyboard_images(payloads, hint, style, num_shots)
    coerced = [_coerce_shot(s, i) for i, s in enumerate(obj["shots"][:num_shots])]
    if not any(s["prompt"] for s in coerced):
        raise HTTPException(status_code=502, detail="图片解析失败(无有效提示词),请重试")
    vlm_warnings = [str(w) for w in (obj.get("warnings") or [])]

    # —— 建项目 + 分镜 ——
    p = DramaProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=obj["title"][:200],
        premise=obj["premise"][:2000],
        style=style.strip()[:300],
        script=obj["script"][:20000],
        width=width,
        height=height,
        fps=fps,
    )
    session.add(p)
    session.commit()
    session.refresh(p)

    # 首图落盘(留档供首镜 i2v / 排查;失败不影响主流程)
    try:
        _drama_dir().mkdir(parents=True, exist_ok=True)
        await asyncio.to_thread(
            (_drama_dir() / f"fromimg-{p.id}.jpg").write_bytes, payloads[0][0]
        )
    except OSError as e:
        logger.warning("from-image 首图落盘失败(忽略): %s", e)

    created = _create_shots_from_analysis(
        p, coerced, session,
        log_step="from_image",
        log_detail=(
            f"图片解析建分镜 {len(coerced)} 个"
            + (f";字段校验告警 {len(vlm_warnings)} 条" if vlm_warnings else "")
        ),
    )

    # —— 自动管线 ——
    task_id: str | None = None
    if auto:
        task_id = uuid.uuid4().hex[:12]
        _append_autorun_task(p, task_id, total=len(created))
        session.add(p)
        session.commit()
        _spawn(_run_autorun(p.id, task_id, payloads[0][0]))

    return {
        "project": _project_dict(p),
        "shots": [_shot_dict(s, session) for s in created],
        "autorun_task_id": task_id,
        "warnings": vlm_warnings,
    }
