"""AI 短剧工作室 —— 剧本→分镜→视频→配音→成片 一站式 MVP 管线。

P0 核心端点(本地学习用,跳过内容合规层):
  · 项目 CRUD            POST/GET/PATCH /api/drama/projects
  · 剧本 LLM 拆解        POST /api/drama/projects/{pid}/storyboard
  · 角色库 CRUD          POST/GET/DELETE  /api/drama/projects/{pid}/characters
  · 单分镜视频生成       POST /api/drama/shots/{sid}/generate-video  (LTX t2v)
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
from pathlib import Path
from urllib.parse import urlsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import FileResponse
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.agent import llm
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
from app.routes.drama_analytics import _drama_root
from app.routes.lipsync import _allowed as _lipsync_allowed, _resolve as _lipsync_resolve
from app.versioning import params_snapshot
from app.workflows.ipadapter import IPAdapterTxt2ImgParams, build_ipadapter_txt2img_graph
from app.workflows.lipsync import LatentSyncParams, build_latentsync_graph
from app.workflows.ltx_video import LtxI2VParams, LtxT2VParams, build_ltx_i2v_graph, build_ltx_t2v_graph
from app.workflows.model_profiles import fit_resolution, is_nextgen, nextgen_recipe, profile_for
from app.workflows.nextgen import NextgenParams, build_nextgen_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

logger = logging.getLogger(__name__)

router = APIRouter()

# NAS 统一存储:成片与配音统一落到 TOIV_DRAMA_VIDEO_DIR(生产指向 NAS 成片目录),
# 与 drama_analytics.py 的播放器代理共享同一路径,避免生成与播放目录不一致。
_DRAMA_DIR = _drama_root()
_VOICE_NAME_RE = re.compile(r"^voice(?:ref)?-[0-9a-f]{32}\.wav$")
_DRAMA_OUTPUT_RE = re.compile(r"^drama-[0-9a-f]{32}\.mp4$")
_TTS_TIMEOUT = 180.0


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
    "对每一个镜头(shot)给出:\n"
    "- scene:该镜的场景/地点简述(中文);\n"
    "- prompt:遵守上述铁律的英文视频提示词(单主体单动作);\n"
    "- characters:该镜出场角色名字数组(只用 characters 列表里给定的名字,没有则空数组);\n"
    "- dialogue:该镜的【中文】台词或旁白(没有则空字符串);\n"
    "- speaker:说话人(角色名 / narrator / 空=无对白);\n"
    "- duration_sec:该镜建议时长(秒,整数,4-8)。\n"
    "镜头数量严格等于用户要求的数量。若 style 给定请融入画质/氛围标签。\n"
    '只输出 JSON,形如 {"shots":[{"scene":"...","prompt":"1boy, ...",'
    '"characters":["..."],"dialogue":"...","speaker":"...","duration_sec":6}, ...]},'
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


class GenerateVideoRequest(BaseModel):
    worker: str | None = Field(default=None, max_length=512)
    seed: int | None = Field(default=None, ge=0, le=2**63 - 1)
    steps: int = Field(default=20, ge=1, le=50)
    cfg: float = Field(default=1.0, ge=0.0, le=20.0)
    use_upscale: bool = False
    use_rife: bool = False
    # 覆盖该镜的 prompt(空=用分镜已存的 prompt)
    prompt_override: str | None = Field(default=None, max_length=2000)


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
    aspect: str = Field(default="16:9")
    fps: int = Field(default=16, ge=1, le=60)
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
        "video_status": s.video_status,
        "video_url": s.video_url,
        "voice_status": s.voice_status,
        "voice_url": s.voice_url,
        "lipsync_status": s.lipsync_status,
        "lipsync_video_url": s.lipsync_video_url,
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
    # 级联删除角色 + 分镜(SQLite ON DELETE CASCADE 已配,这里显式删保幂等)
    for c in session.exec(select(DramaCharacter).where(DramaCharacter.project_id == pid)).all():
        session.delete(c)
    for s in session.exec(select(DramaShot).where(DramaShot.project_id == pid)).all():
        session.delete(s)
    session.delete(p)
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
    t = text.strip()
    # Qwen3 等思考型模型把推理过程包在 <think>...</think> 中,
    # 真正的 JSON 输出在 </think> 之后。剥离思考前缀,避免误把思考里
    # 出现的 {…} 示例当成最终 JSON。
    if "</think>" in t:
        t = t.split("</think>", 1)[1].strip()

    # 1) 直攻预期目标:寻找 {"shots":... 这类完整 JSON 块(平衡大括号匹配)。
    #    即便思考段里散落 {…} 示例,也能精确锁定目标 JSON。
    for anchor in ('{"shots"', "{'shots'", '"shots"'):
        idx = t.find(anchor)
        if idx == -1:
            continue
        # 向左回溯到对应的左大括号
        start = t.rfind("{", 0, idx + 1)
        if start == -1:
            continue
        # 平衡大括号匹配,提取最外层完整 JSON
        depth = 0
        in_str = False
        escape = False
        for i in range(start, len(t)):
            ch = t[i]
            if in_str:
                if escape:
                    escape = False
                elif ch == "\\":
                    escape = True
                elif ch == '"':
                    in_str = False
            else:
                if ch == '"':
                    in_str = True
                elif ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                    if depth == 0:
                        candidate = t[start : i + 1]
                        try:
                            obj = json.loads(candidate)
                            if isinstance(obj, dict):
                                return obj
                        except (ValueError, TypeError):
                            pass
                        break
        # 当前 anchor 失败,换下一个

    # 2) 兜底:剥离代码块标记后,整体取首 { 到末 } 再试
    t_clean = t.strip()
    if t_clean.startswith("```"):
        # 去掉 ```json ... ``` 包裹
        t_clean = t_clean.split("\n", 1)[-1] if "\n" in t_clean else t_clean[3:]
        if t_clean.endswith("```"):
            t_clean = t_clean[:-3]
        t_clean = t_clean.strip()
    if "{" in t_clean and "}" in t_clean:
        candidate = t_clean[t_clean.index("{") : t_clean.rindex("}") + 1]
        try:
            obj = json.loads(candidate)
            return obj if isinstance(obj, dict) else None
        except (ValueError, TypeError):
            return None
    return None


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


def _coerce_shot(raw: object, index: int) -> dict:
    """把 LLM 返回的单个镜头对象规整成 dict(字段缺失/类型不符时回退到安全默认)。"""
    obj = raw if isinstance(raw, dict) else {}
    chars_raw = obj.get("characters")
    characters = (
        [str(c).strip() for c in chars_raw if str(c).strip()]
        if isinstance(chars_raw, list)
        else []
    )
    try:
        duration = int(obj.get("duration_sec") or 6)
    except (ValueError, TypeError):
        duration = 6
    duration = max(2, min(duration, 15))
    return {
        "scene": str(obj.get("scene") or "").strip(),
        "prompt": str(obj.get("prompt") or "").strip(),
        "characters": characters,
        "dialogue": str(obj.get("dialogue") or "").strip(),
        "speaker": str(obj.get("speaker") or "").strip(),
        "duration_sec": duration,
    }


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
    try:
        # 默认走配置层;L2/L3 当前依赖 EXO,未就绪时会自动降级,默认 L1 保证可用性。
        msg = await llm.chat_layered(
            [
                {"role": "system", "content": _STORYBOARD_SYSTEM},
                {"role": "user", "content": _build_user_prompt(
                    script, body.num_shots, style, characters
                )},
            ],
            layer=layer,
            max_tokens=8192,
            temperature=0.5,
        )
    except llm.LLMError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e

    raw = (msg.get("content") or "").strip()
    obj = _parse_json_obj(raw)
    shots_raw = obj.get("shots") if obj else None
    if not isinstance(shots_raw, list) or not shots_raw:
        logger.warning(
            "storyboard parse failed layer=%s project=%s raw_length=%d raw_preview=%s",
            layer, pid, len(raw), raw[:800].replace("\n", " ")
        )
        raise HTTPException(status_code=502, detail="分镜生成失败,请重试")

    coerced = [_coerce_shot(s, i) for i, s in enumerate(shots_raw[: body.num_shots])]
    if not any(s["prompt"] for s in coerced):
        logger.warning(
            "storyboard no valid prompts layer=%s project=%s shots=%s",
            layer, pid, coerced
        )
        raise HTTPException(status_code=502, detail="分镜生成失败(无有效提示词),请重试")

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
        # 注入出场角色的视觉 token
        prompt = sc["prompt"]
        for cname in sc["characters"]:
            ch = char_map.get(cname)
            if ch and ch.visual_prompt:
                # 把角色 token 前置注入(主体描述前)
                prompt = f"{ch.visual_prompt}, {prompt}" if prompt else ch.visual_prompt
        shot = DramaShot(
            project_id=pid,
            idx=i,
            scene=sc["scene"],
            prompt=prompt,
            characters=json.dumps(sc["characters"], ensure_ascii=False),
            dialogue=sc["dialogue"],
            speaker=sc["speaker"],
            duration_sec=sc["duration_sec"],
            width=p.width,
            height=p.height,
        )
        session.add(shot)
        created.append(shot)

    p.status = "storyboard"
    p.script = script
    _append_process(p, "storyboard", f"LLM 拆解出 {len(created)} 个分镜")
    session.add(p)
    session.commit()
    for s in created:
        session.refresh(s)
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
) -> str | None:
    """为分镜生成带角色一致性的首帧图,返回上传到 worker input 后的文件名。

    仅当分镜有关联角色且角色有 ref_image 时执行;失败时返回 None,调用方应回退到 t2v。
    """
    chars = _shot_characters(shot, session)
    ref_char = next((c for c in chars if c.ref_image.strip()), None)
    if not ref_char:
        return None

    ref_url = ref_char.ref_image.strip()
    if not _allowed_ref(ref_url):
        logger.warning("角色 %s 参考图来源不在白名单: %s", ref_char.name, ref_url)
        return None

    try:
        async with httpx.AsyncClient(
            timeout=60.0, follow_redirects=True, trust_env=False
        ) as http:
            rr = await http.get(_resolve_url(ref_url))
            rr.raise_for_status()
            ref_fn = await client.upload_image(
                rr.content, f"drama_ref_{uuid.uuid4().hex}.png"
            )

        # 用默认底模走 IPAdapter txt2img,注入角色脸一致性
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
@router.post("/drama/shots/{sid}/generate-video")
async def generate_shot_video(
    sid: str,
    body: GenerateVideoRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """单分镜视频生成(LTX t2v)。本地学习用,跳过 NSFW 合规门槛。"""
    enforce_generation_rate_limit(user)
    shot = _owned_shot(sid, user, session)
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    prompt = (body.prompt_override or shot.prompt).strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="分镜提示词为空")

    # 选 worker
    if body.worker:
        client = resolve_worker(body.worker)
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
    # 用 settings 的 NSFW 默认视频底模(10Eros),本地学习场景跳过 NSFW 门槛
    seed = body.seed if body.seed is not None else LtxT2VParams(positive="").seed

    # 角色一致性：若分镜有关联角色且角色有 ref_image，先生成带 IPAdapter 的高质量首帧
    keyframe_fn = await _generate_keyframe_for_shot(
        client, shot, project, settings, session
    )

    common_params = {
        "positive": prompt,
        "negative": shot.negative,
        "unet_name": settings.nsfw_default_video_ckpt,
        "gemma_name": settings.nsfw_default_gemma,
        "vae_name": settings.nsfw_default_vae,
        "width": project.width,
        "height": project.height,
        "length": max(9, int(project.fps * shot.duration_sec)),
        "fps": project.fps,
        "steps": body.steps,
        "cfg": body.cfg,
        "seed": seed,
        "use_upscale": body.use_upscale,
        "use_rife": body.use_rife,
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
            seed=seed,
            nsfw=True,  # 10Eros 底模属 NSFW,打标保历史页过滤
            params=params_snapshot(body, seed=seed),
        )
    )
    # 分镜状态置 generating,记录 seed
    shot.video_status = "generating"
    shot.video_url = ""  # 重置,等 tracker 落库后前端刷新
    shot.seed = seed
    shot.error = ""
    _append_process(_owned_project(shot.project_id, user, session), "generate_video", f"分镜 #{shot.idx} 提交生成(seed={seed})")
    session.add(shot)
    session.commit()

    # 后台追踪结果(独立于客户端 SSE),完成后通过 GET 分镜查 video_url
    spawn_tracker(client, prompt_id)

    # 挂一个回调:tracker 完成后把 video_url 回写到 DramaShot
    async def _writeback():
        from app.comfy.tracker import wait_for_jobs
        from app.db import engine
        try:
            with Session(engine) as s:
                await wait_for_jobs(s, [prompt_id], timeout=900.0)
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
                            return
                # 失败标记
                shot_obj = s.get(DramaShot, sid)
                if shot_obj and shot_obj.video_status == "generating":
                    shot_obj.video_status = "error"
                    shot_obj.error = "生成失败或超时"
                    s.add(shot_obj)
                    s.commit()
        except Exception as e:  # noqa: BLE001
            logger.exception("shot %s video writeback failed: %s", sid, e)
            with Session(engine) as s:
                shot_obj = s.get(DramaShot, sid)
                if shot_obj and shot_obj.video_status == "generating":
                    shot_obj.video_status = "error"
                    shot_obj.error = f"回写异常: {type(e).__name__}: {e}"[:200]
                    s.add(shot_obj)
                    s.commit()

    asyncio.create_task(_writeback())

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "seed": seed,
        "shot_id": sid,
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

    # 解析参考音:body 传入 > speaker 对应角色的 ref_audio
    ref_audio_url = body.ref_audio_url
    if not ref_audio_url and shot.speaker:
        # 查角色库找 speaker 的 ref_audio
        chars = session.exec(
            select(DramaCharacter).where(DramaCharacter.project_id == shot.project_id)
        ).all()
        for c in chars:
            if c.name == shot.speaker and c.ref_audio:
                ref_audio_url = c.ref_audio
                break

    settings = get_settings()
    tts_target = settings.tts_url.rstrip("/")
    data: dict[str, str] = {"text": text}
    # 情感控制：优先用请求体传入，其次尝试从分镜场景推断。
    emo_text = (body.emo_text or "").strip()
    if not emo_text and shot.scene:
        emo_text = shot.scene.strip()
    if emo_text:
        data["emo_text"] = emo_text
        data["emo_alpha"] = str(max(0.0, min(1.0, body.emo_alpha)))

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

        try:
            resp = await client.post(tts_target + "/tts", data=data, files=files)
        except httpx.HTTPError as e:
            shot.voice_status = "error"
            shot.error = f"TTS 不可达:{e}"
            session.add(shot)
            session.commit()
            raise HTTPException(status_code=502, detail=f"TTS 服务不可达:{e}") from e

    if resp.status_code != 200:
        shot.voice_status = "error"
        detail = "TTS 合成失败"
        try:
            detail = resp.json().get("detail", detail)
        except (ValueError, KeyError):
            detail = resp.text[:200] or detail
        shot.error = detail
        session.add(shot)
        session.commit()
        raise HTTPException(status_code=502, detail=detail)
    if not resp.content or resp.content[:4] != b"RIFF":
        shot.voice_status = "error"
        shot.error = "TTS 返回非音频"
        session.add(shot)
        session.commit()
        raise HTTPException(status_code=502, detail="TTS 返回非音频")

    _DRAMA_DIR.mkdir(parents=True, exist_ok=True)
    name = f"voice-{uuid.uuid4().hex}.wav"
    path = _DRAMA_DIR / name
    path.write_bytes(resp.content)

    shot.voice_url = f"/api/drama/voice/{name}"
    shot.voice_status = "done"
    shot.error = ""
    session.add(shot)
    session.commit()

    return {
        "url": shot.voice_url,
        "name": name,
        "duration_sec": _wav_duration(path),
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
        from app.comfy.tracker import wait_for_jobs
        from app.db import engine

        try:
            with Session(engine) as s:
                results = await wait_for_jobs(s, [prompt_id], timeout=900.0)
                urls = results.get(prompt_id, [])
                shot_obj = s.get(DramaShot, sid)
                if urls and shot_obj:
                    shot_obj.lipsync_video_url = urls[0]
                    shot_obj.lipsync_status = "done"
                    shot_obj.error = ""
                    s.add(shot_obj)
                    s.commit()
                    return
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

    asyncio.create_task(_writeback_lipsync())

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
    path = _DRAMA_DIR / name
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
            dest.write_bytes(content)
            return
        except ComfyUIError as e:
            last_err = e
    raise HTTPException(
        status_code=502,
        detail=f"片段下载失败(同机 worker 均不可达): {url} ({last_err})",
    )


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
    shots = session.exec(
        select(DramaShot).where(DramaShot.project_id == pid).order_by(DramaShot.idx)
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

    _DRAMA_DIR.mkdir(parents=True, exist_ok=True)
    name = f"drama-{uuid.uuid4().hex}.mp4"
    out_path = _DRAMA_DIR / name

    # 把 AssembleOptions 翻译成 assembly.py 的 AssembleOptions
    from app.routes.assembly import AssembleOptions as _AsmOpt
    asm_opt = _AsmOpt(
        transition=body.transition,
        bgm_url=body.bgm_url,
        subtitles=[s.dialogue for s in ready],  # 逐镜台词作字幕
        fps=body.fps,
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
        targets = durations_targets
        durations = [
            min(probed[i], targets[i]) if i < len(targets) and targets[i] > 0 else probed[i]
            for i in range(len(probed))
        ]
        dims = _ASPECT_DIMS.get(body.aspect, _ASPECT_DIMS["16:9"])
        has_bookends = bool(asm_opt.title.strip() or asm_opt.credits.strip())
        film_path = (tmp_dir / "film.mp4") if has_bookends else out_path
        cmd = _build_ffmpeg_command(
            clip_paths, asm_opt, bgm_path, voice_paths, durations, targets, dims, film_path
        )
        await _run_ffmpeg(cmd)

        if has_bookends:
            film_has_audio = any(voice_paths) or bgm_path is not None
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


@router.get("/drama/output/{name}")
async def get_drama_output(
    name: str,
    user: User = Depends(get_current_user),
) -> FileResponse:
    if not _DRAMA_OUTPUT_RE.match(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = _DRAMA_DIR / name
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
        results = await wait_for_jobs(session, prompt_ids, timeout=600.0)
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

    # LLM 拆解剧本成 num_shots 个镜头(复用 storyboard 提示词)
    try:
        msg = await llm.chat(
            [
                {"role": "system", "content": _STORYBOARD_SYSTEM},
                {
                    "role": "user",
                    "content": _build_user_prompt(
                        script, body.num_shots, style, characters
                    ),
                },
            ],
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
        results = await wait_for_jobs(session, [grid_pid], timeout=600.0)
    except RuntimeError as e:
        raise HTTPException(status_code=504, detail=str(e)) from e

    grid_urls = results.get(grid_pid, [])
    grid_url = grid_urls[0] if grid_urls else ""

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
        shot_prompt = sc["prompt"]
        for cname in sc["characters"]:
            ch = char_map.get(cname)
            if ch and ch.visual_prompt:
                shot_prompt = (
                    f"{ch.visual_prompt}, {shot_prompt}" if shot_prompt else ch.visual_prompt
                )
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
                results = await wait_for_jobs(session, [ref_pid], timeout=600.0)
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
    prompt_override: str | None = Field(default=None, max_length=2000)
    num_candidates: int = Field(default=1, ge=1, le=4)


@router.get("/drama/video-generators")
def list_video_generators(
    user: User = Depends(get_current_user),
) -> dict:
    """M6: 列出所有已注册的视频生成器(供前端选择器)。"""
    from app.services.video_generators import list_generators

    return {"generators": list_generators()}


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
    """候选生成任务完成后回写 candidate.url/status,并自动 pick 首个完成的候选。"""
    from app.db import engine

    try:
        with Session(engine) as s:
            results = await wait_for_jobs(s, [prompt_id], timeout=900.0)
            cand = s.get(DramaShotCandidate, candidate_id)
            if not cand:
                return
            urls = results.get(prompt_id, [])
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
            else:
                cand.status = "error"
                cand.error = "生成结果为空"
            s.add(cand)
            s.commit()
    except Exception as e:  # noqa: BLE001
        logger.exception("candidate %s writeback failed: %s", candidate_id, e)
        with Session(engine) as s:
            cand = s.get(DramaShotCandidate, candidate_id)
            if cand and cand.status == "generating":
                cand.status = "error"
                cand.error = f"回写异常: {type(e).__name__}: {e}"[:200]
                s.add(cand)
                s.commit()


@router.post("/drama/shots/{sid}/generate-video-v2")
async def generate_shot_video_v2(
    sid: str,
    body: GenerateVideoV2Request,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """M6/M1: 多模型视频生成分发,支持单镜多候选。"""
    enforce_generation_rate_limit(user)
    shot = _owned_shot(sid, user, session)
    project = session.get(DramaProject, shot.project_id)
    if not project:
        raise HTTPException(status_code=404, detail="项目不存在")
    prompt = (body.prompt_override or shot.prompt).strip()
    if not prompt:
        raise HTTPException(status_code=422, detail="分镜提示词为空")

    from app.services.video_generators import get_generator

    try:
        gen = get_generator(body.model, pool=pool)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e

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
            filename_prefix=f"ToIV_drama_shot{shot.idx}",
        )

        if not result.success:
            shot.video_status = "error"
            shot.error = result.error
            session.add(shot)
            session.commit()
            raise HTTPException(status_code=501, detail=result.error)

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
                nsfw=True,
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
                    nsfw=True,
                    params=params_snapshot(body, seed=seed, model=body.model),
                )
            )
            jobs_info.append((prompt_id, cand.id, worker_url))
        else:
            cand.error = result.error or "生成提交失败"
            session.add(cand)

    session.commit()

    for prompt_id, candidate_id, _worker_url in jobs_info:
        asyncio.create_task(_writeback_candidate(prompt_id, candidate_id, sid))

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
    """润色/精修统一走配置层;EXO 未就绪期间默认 L1 保证可用。"""
    return _drama_llm_layer(get_settings().drama_polish_layer)


@router.post("/drama/projects/{pid}/refine")
async def refine_script(
    pid: str,
    body: RefineRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """主力润色 — 默认走配置层(TOIV_DRAMA_POLISH_LAYER,当前 L1)。

    适合关键场景打磨、情感戏、转折点。同步返回结果（timeout 120s）。
    EXO 恢复后可将配置改回 L2(Kimi-K2.7-Code)。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="待润色文本为空")

    layer = _polish_layer()

    try:
        msg = await llm.chat_layered(
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
    """终稿精修 — 默认走配置层(TOIV_DRAMA_POLISH_LAYER,当前 L1)。

    适合终稿质量提升、高难度剧情。同步返回（timeout 300s）。
    EXO 恢复后可将配置改回 L3(GLM-5.2-fp8)。
    """
    enforce_generation_rate_limit(user)
    p = _owned_project(pid, user, session)
    if not body.text.strip():
        raise HTTPException(status_code=422, detail="待精修文本为空")

    layer = _polish_layer()
    try:
        msg = await llm.chat_layered(
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
                msg = await llm.chat_layered(
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

    立即返回 task_id,后台 asyncio.create_task 执行。
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
    asyncio.create_task(_run_batch_polish(
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
