"""Studio 创作工作室路由(薄层):项目/角色/分镜 CRUD + 剧本拆解 + 渲染编排。

业务编排入 app.services.studio;配音/对口型/合成端点见 M3 追加。
"""
from __future__ import annotations

import json
import logging
from pathlib import Path

from fastapi import APIRouter, Body, Depends, File, Form, HTTPException, Query, Request, UploadFile
from fastapi.responses import FileResponse, JSONResponse
from pydantic import BaseModel, Field, field_validator
from pydantic_core import PydanticCustomError
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin, get_current_user, get_pool
from app.ratelimit import enforce_generation_rate_limit
from app.models import StudioCharacter, StudioProject, StudioShot, User
from app.services.drama_pipeline import compute_studio_next_step
from app.services import h3_accel
from app.services.svml_lite import drafts_to_coerced, parse_svml_script as svml_parse_script
from app.services.studio import assemble as assemble_svc
from app.services.studio import lipsync as lipsync_svc
from app.services.studio import orchestrator, storyboard
from app.services.studio import voice as voice_svc
from app.services.studio.renderers.base import RenderError
import uuid

from app.services.studio.schemas import (
    CharacterAssetCardRequest,
    CharacterAssetCoveragePlanRequest,
    CharacterAssetPutRequest,
    CharacterAssetRefreshRequest,
    CharacterCreate,
    CharacterPatch,
    CharacterSheetPanelsRequest,
    CharacterSheetRecomposeRequest,
    CharacterSheetRequest,
    ProjectCreate,
    AssembleOptions,
    ProjectPatch,
    ScriptParseRequest,
    ShotsSaveRequest,
)

router = APIRouter()
logger = logging.getLogger(__name__)


@router.get("/studio/deps-status")
async def studio_deps_status(
    user: User = Depends(get_current_user),
) -> dict:
    """短剧依赖三态(L5):工作站 API / 配音 / 视频引擎。可达|降级|不可达;**不暴露端口**。"""
    import asyncio
    import httpx
    from app.config import get_settings

    settings = get_settings()
    user  # 鉴权占位:任意登录用户可读

    async def _probe(url: str, path: str = "") -> str:
        """返回 reachable | unreachable(本函数不做 degraded;上层拼)。"""
        base = (url or "").strip().rstrip("/")
        if not base:
            return "unreachable"
        target = f"{base}{path}" if path else base
        try:
            async with httpx.AsyncClient(timeout=3.0, trust_env=False) as client:
                r = await client.get(target)
            # 任何 HTTP 响应视为可达(与 fleet 口径一致)
            _ = r.status_code
            return "reachable"
        except Exception:  # noqa: BLE001
            return "unreachable"

    # 工作站=本 API 能答即可达(本请求即证明);降级留给将来扩展
    api_state = "reachable"
    tts_url = getattr(settings, "tts_url", "") or ""
    h3_url = getattr(settings, "h3_base_url", "") or ""
    tts_state, h3_state = await asyncio.gather(
        _probe(tts_url, "/health"),
        _probe(h3_url, "/system_stats"),
    )
    # H3 偶发 /system_stats 404 仍算可达——再试根路径
    if h3_state == "unreachable":
        h3_state = await _probe(h3_url, "/")

    def _pack(key: str, state: str, label: str, blocked_cta: str) -> dict:
        human = {
            "reachable": f"{label}可用",
            "degraded": f"{label}降级可用，部分功能可能变慢",
            "unreachable": {
                "tts": "配音服务暂不可用，可先完成分镜与出视频，稍后再配音。",
                "h3": "视频引擎暂不可用，可先写剧本与定妆，稍后再生成。",
                "api": "工作站暂不可达，请稍后刷新。",
            }.get(key, f"{label}暂不可用"),
        }[state]
        return {
            "id": key,
            "label": label,
            "state": state,
            "summary": human,
            "block_cta": state == "unreachable",
            "blocked_hint": blocked_cta if state == "unreachable" else "",
        }

    deps = [
        _pack("api", api_state, "工作站算力", "请稍后刷新再试"),
        _pack("tts", tts_state, "配音服务", "可先完成分镜与出视频，稍后再配音。"),
        _pack("h3", h3_state, "视频引擎", "可先写剧本与定妆，稍后再生成。"),
    ]
    overall = "reachable"
    if any(d["state"] == "unreachable" for d in deps):
        overall = "unreachable" if all(d["state"] == "unreachable" for d in deps[1:]) else "degraded"
    elif any(d["state"] == "degraded" for d in deps):
        overall = "degraded"
    return {"overall": overall, "deps": deps}




# ── 工具 ──────────────────────────────────────────────────────────────────


def _get_project(session: Session, pid: str, user: User) -> StudioProject:
    p = session.get(StudioProject, pid)
    if not p or p.tenant_id != user.tenant_id:
        raise HTTPException(status_code=404, detail="项目不存在")
    return p



def _character_out(c: StudioCharacter) -> dict:
    """角色响应:扁平 reference_images + 按风格分存 reference_images_by_style。"""
    from app.services.studio import character_sheet as sheet_svc

    try:
        refs = json.loads(c.reference_images or "[]")
    except (ValueError, TypeError):
        refs = []
    if not isinstance(refs, list):
        refs = []
    by_style = sheet_svc.parse_refs_by_style(
        getattr(c, "reference_images_by_style", None) or "{}"
    )
    data = c.model_dump()
    data.pop("reference_images_by_style", None)
    data["reference_images"] = refs
    data["reference_images_by_style"] = by_style
    return data


def _parse_scene_images(raw: str | None) -> list[str]:
    try:
        scenes = json.loads(raw or "[]")
    except (ValueError, TypeError):
        scenes = []
    if not isinstance(scenes, list):
        return []
    return [u for u in scenes if isinstance(u, str) and u.strip()]


def _project_out(p: StudioProject) -> dict:
    """项目响应:scene_images_json → scene_images list(不泄漏 JSON 串列名)。"""
    data = p.model_dump()
    data.pop("scene_images_json", None)
    data["scene_images"] = _parse_scene_images(getattr(p, "scene_images_json", None))
    return data


def _project_detail(session: Session, p: StudioProject) -> dict:
    # S5(2026-10-11):惰性回写——异步渲染(wait=false)的 Job 终态在此映射回镜,
    # UI 渲染期 10s 轮询详情即自愈通道;失败不影响详情(内部已 try)。
    from app.services.studio.render_reconcile import reconcile_project_renders

    try:
        reconcile_project_renders(session, p.id)
    except Exception:  # noqa: BLE001
        logger.warning("render_reconcile 项目级回写异常 pid=%s", p.id[:12])
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == p.id)
    ).all()
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    return {
        **_project_out(p),
        "characters": [_character_out(c) for c in chars],
        "shots": [_shot_out(s) for s in shots],
    }


# ── 项目 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/import-svml")
def import_svml_studio(
    pid: str,
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """SVML-lite 词锚定脚本 → 分镜草稿(hypit 语法,确定性解析,不经 LLM)。

    返回与 script/parse 同构的 shots 草稿,**不落库**——前端复用既有
    「建角色 + PUT shots 全量替换」链路确认落库(与 AI 拆解同一写路径)。
    语法:|| 拍分隔 / @{cue}词@{/cue} 跨拍词锚 / <角色|voice> 说话人 /
    [scene:/mood:/beat:] 元数据 / --- 分镜分隔;字数估时(4.2 字/s,夹 2-15s)。
    """
    from dataclasses import asdict
    from app.services.svml_timeline import project_timeline

    _get_project(session, pid, user)
    script = (body or {}).get("script", "")
    if not isinstance(script, str) or not script.strip():
        raise HTTPException(status_code=422, detail="script 为空")
    if len(script) > 50000:
        raise HTTPException(status_code=422, detail="script 过长(上限 50000 字符)")
    try:
        drafts = svml_parse_script(script)
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=f"SVML 解析失败:{exc}") from exc
    if (body or {}).get("auto_duration") is False:
        for d in drafts:
            if d.duration_auto:
                d.duration_sec = 6
    coerced = drafts_to_coerced(drafts)
    shots = [
        {
            "scene": c["scene"],
            "prompt": c["prompt"],
            "camera": "",
            "dialogue": c["dialogue"],
            "speaker": c["speaker"],
            "duration_sec": c["duration_sec"],
            "characters": c["characters"],
            "render_mode": "video",
            # 拍声明保留视觉/对白通道；所有响应共用服务端投影。
            **project_timeline(
                [asdict(b) for b in d.beats],
                total_sec=d.duration_sec if not d.duration_auto or body.get("auto_duration") is False else None,
            ),
        }
        for c, d in zip(coerced, drafts)
    ]
    characters = sorted({n for c in coerced for n in c["characters"]})
    return {"shots": shots, "characters": characters, "count": len(shots)}


@router.post("/studio/projects")
def create_project(
    body: ProjectCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = StudioProject(
        tenant_id=user.tenant_id,
        user_id=user.id,
        title=body.title,
        premise=body.premise,
        style=body.style,
        ckpt_name=body.ckpt_name,
        render_mode_default=body.render_mode_default,
        width=body.width,
        height=body.height,
        fps=body.fps,
    )
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_out(p)


@router.get("/studio/projects")
def list_projects(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(StudioProject)
        .where(StudioProject.tenant_id == user.tenant_id)
        .order_by(StudioProject.updated_at.desc())
    ).all()
    out = []
    for p in rows:
        item = _project_out(p)
        # Batch5:列表进度点(复用 compute_studio_next_step)
        item["pipeline"] = _studio_pipeline_brief(session, p.id)
        out.append(item)
    return out


@router.get("/studio/projects/{pid}")
def get_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return _project_detail(session, _get_project(session, pid, user))


@router.patch("/studio/projects/{pid}")
def patch_project(
    pid: str,
    body: ProjectPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    data = body.model_dump(exclude_none=True)
    # Batch3:scene_images list → DB JSON 字符串列
    if "scene_images" in data:
        scenes = data.pop("scene_images") or []
        if not isinstance(scenes, list):
            raise HTTPException(status_code=400, detail="scene_images 须为字符串数组")
        if len(scenes) > 4:
            raise HTTPException(status_code=400, detail="scene_images 最多 4 张")
        for u in scenes:
            if not isinstance(u, str) or not u.strip():
                raise HTTPException(status_code=400, detail="scene_images 项无效")
        data["scene_images_json"] = json.dumps(scenes, ensure_ascii=False)
    if "bgm_url" in data:
        from app.services.studio.bgm_bed import (
            is_allowed_bgm_url,
            normalize_bgm_url,
            to_relative_bgm_url,
        )
        raw = normalize_bgm_url(data.get("bgm_url"))
        if raw and not is_allowed_bgm_url(raw):
            raise HTTPException(status_code=422, detail="声床 URL 须为站内路径（/api/studio/files/…）")
        data["bgm_url"] = to_relative_bgm_url(raw) if raw else ""
    if "bgm_volume" in data and data["bgm_volume"] is not None:
        from app.services.studio.bgm_bed import normalize_bgm_volume
        data["bgm_volume"] = normalize_bgm_volume(data["bgm_volume"])
    if "bgm_duck" in data and data["bgm_duck"] is not None:
        from app.services.studio.bgm_bed import normalize_bgm_duck
        data["bgm_duck"] = normalize_bgm_duck(data["bgm_duck"])
    for k, v in data.items():
        setattr(p, k, v)
    session.add(p)
    session.commit()
    session.refresh(p)
    return _project_out(p)


@router.delete("/studio/projects/{pid}")
def delete_project(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    p = _get_project(session, pid, user)
    for model in (StudioShot, StudioCharacter):
        for row in session.exec(select(model).where(model.project_id == pid)).all():
            session.delete(row)
    session.delete(p)
    from app import audit as _audit

    _audit.record(
        session, user=user, action="project.delete", target_type="studio_project",
        target_id=pid, summary=f"删除 Studio 项目:{p.title or pid[:8]}",
        detail={"title": p.title, "project_id": pid},
    )
    session.commit()
    return {"ok": True}


# ── 角色 CRUD ─────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/characters")
def create_character(
    pid: str,
    body: CharacterCreate,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    c = StudioCharacter(
        project_id=pid,
        name=body.name,
        description=body.description,
        visual_prompt=body.visual_prompt,
    )
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_out(c)


@router.patch("/studio/characters/{cid}")
def patch_character(
    cid: str,
    body: CharacterPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)  # 租户校验
    data = body.model_dump(exclude_none=True)
    # 非 ORM 字段:风格匹配白名单(仅守卫用)
    allowed_panel_styles = data.pop("allowed_panel_styles", None)
    # Batch2:reference_images list → DB JSON 字符串列
    if "reference_images" in data:
        refs = data["reference_images"] or []
        if not isinstance(refs, list):
            raise HTTPException(status_code=400, detail="reference_images 须为字符串数组")
        if len(refs) > 8:
            raise HTTPException(status_code=400, detail="reference_images 最多 8 张")
        for u in refs:
            if not isinstance(u, str) or len(u) > 1024:
                raise HTTPException(status_code=400, detail="reference_images 项无效")
        # 12:01 守卫:char_panel_* 须显式风格匹配
        from app.services.studio import character_sheet as sheet_svc
        allowed: set[str] = set()
        if isinstance(allowed_panel_styles, (list, tuple, set)):
            allowed = {str(s) for s in allowed_panel_styles}
        try:
            sheet_svc.assert_reference_images_panel_style(refs, allowed_styles=allowed)
        except sheet_svc.ReferenceImagesStyleError as e:
            raise HTTPException(status_code=e.status_code, detail=str(e)) from e
        data["reference_images"] = json.dumps(refs, ensure_ascii=False)
    if "reference_images_by_style" in data:
        from app.services.studio import character_sheet as sheet_svc
        raw = data["reference_images_by_style"] or {}
        if not isinstance(raw, dict):
            raise HTTPException(status_code=400, detail="reference_images_by_style 须为对象")
        by_style = sheet_svc.parse_refs_by_style(raw)
        # 逐桶守卫
        for st, urls in by_style.items():
            try:
                sheet_svc.assert_reference_images_panel_style(urls, allowed_styles={st})
            except sheet_svc.ReferenceImagesStyleError as e:
                raise HTTPException(status_code=e.status_code, detail=str(e)) from e
            if len(urls) > 8:
                raise HTTPException(status_code=400, detail=f"reference_images_by_style[{st}] 最多 8 张")
        data["reference_images_by_style"] = json.dumps(by_style, ensure_ascii=False)
    for k, v in data.items():
        setattr(c, k, v)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_out(c)


@router.delete("/studio/characters/{cid}")
def delete_character(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    session.delete(c)
    from app import audit as _audit

    _audit.record(
        session, user=user, action="character.delete", target_type="studio_character",
        target_id=cid, summary=f"删除 Studio 角色:{c.name or cid[:8]}",
        detail={"name": c.name, "project_id": c.project_id},
    )
    session.commit()
    return {"ok": True}


# ── Batch7 角色设定卡 ───────────────────────────────────────────────────────


@router.post("/studio/characters/{cid}/character-sheet")
async def generate_character_sheet_route(
    cid: str,
    body: CharacterSheetRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool=Depends(get_pool),
):
    """分格出图 + Pillow 固定版式拼版;默认只落设定卡文件,不写 reference_images。"""
    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    return await _generate_sheet_core(c, body, session, pool)


async def _generate_sheet_core(
    c,
    body: "CharacterSheetRequest",
    session: Session,
    pool,
) -> dict:
    """设定卡生成核心(同步/异步 Job 共用):校验 → 出图 → 首次定妆自动写 by_style。"""
    from app.services.studio import character_sheet as sheet_svc

    name = (c.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="角色名为空")

    visual = (body.visual_prompt_override or c.visual_prompt or "").strip()
    if not visual and not (c.description or "").strip():
        raise HTTPException(status_code=422, detail="角色缺少视觉描述")

    try:
        sheet_svc.assert_design_notes_ok((body.design_notes or "").strip())
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    meta = sheet_svc.SheetMeta(
        name=name,
        style=body.style,
        height_cm=body.height_cm,
        role=(body.role or "").strip(),
        personality=(body.personality or "").strip(),
        design_notes=(body.design_notes or "").strip(),
        colors=list(body.colors or []),
        visual_prompt=visual,
        description=(c.description or "").strip(),
        template=(getattr(body, "template", "") or "").strip(),
    )
    try:
        # 17:45#2:默认不复用旧 sample 三视图;allow_reuse_refs=False
        url, _png, panel_urls = await sheet_svc.generate_character_sheet(
            character_id=c.id,
            meta=meta,
            pool=pool,
            worker=body.worker,
            seed=body.seed,
            reuse_ref_urls=None,
            allow_reuse_refs=False,
        )
    except sheet_svc.CharacterSheetError as e:
        from app.services.studio.character_sheet import ux as sheet_ux

        payload = sheet_ux.build_sheet_gate_failure_payload(
            e, character_id=c.id, style=body.style
        )
        raise HTTPException(status_code=e.status_code, detail=payload) from e

    # 12:01/22:31:默认不写视频参考;apply_to_video_refs 时按风格分桶写入,不互盖
    # 10/05:首次定妆(本风格分桶为空)自动写入视频参考,否则新角色进视频步 C/c_hybrid 无参考直接失败;
    # 已有分桶时仍尊重 apply_to_video_refs=False,不覆盖已确认的参考。
    _bucket_empty = not sheet_svc.parse_refs_by_style(
        getattr(c, "reference_images_by_style", None) or "{}"
    ).get(body.style)
    _apply_refs = bool(getattr(body, "apply_to_video_refs", False)) or _bucket_empty
    if _apply_refs:
        try:
            existing = json.loads(c.reference_images or "[]")
        except (ValueError, TypeError):
            existing = []
        if not isinstance(existing, list):
            existing = []
        by_style = sheet_svc.parse_refs_by_style(
            getattr(c, "reference_images_by_style", None) or "{}"
        )
        try:
            by_style = sheet_svc.merge_video_refs_by_style(
                by_style,
                style=body.style,
                panel_urls=panel_urls,
                sheet_url=url,
            )
        except (
            sheet_svc.ReferenceImagesStyleError,
            sheet_svc.CharacterSheetError,
        ) as e:
            raise HTTPException(status_code=getattr(e, "status_code", 422), detail=str(e)) from e
        # 22:31:只写 by_style 分桶,不改扁平 reference_images(雨夜写实仍保留 sample_linxia×3)
        c.reference_images_by_style = json.dumps(by_style, ensure_ascii=False)
        session.add(c)
        session.commit()
        session.refresh(c)
    _note_asset_regeneration(
        c.id, body.style, reason="character-sheet 整卡生成"
    )
    out = _character_out(c)
    out["sheet_url"] = url
    out["sheet_style"] = body.style
    out["panel_urls"] = panel_urls
    out["apply_to_video_refs"] = _apply_refs
    return out



class FrameVariantsRequest(BaseModel):
    style: str = Field(default="anime", pattern="^(ancient_realistic|anime|realistic|ink_wash|cyberpunk|three_d)$")


# ── S9(2026-10-11):字幕对齐——台词↔whisper 时间轴,SRT 内嵌/外挂双出 ──
@router.post("/studio/projects/{pid}/subtitles")
async def build_subtitles_endpoint(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """整片字幕:配音镜走 ASR+台词对齐 → SRT 外挂(studio 文件域)。

    返回 {srt_url, cues, shots_covered, total_duration}。
    """
    _get_project(session, pid, user)
    from app.services.studio.subtitles import build_project_subtitles

    try:
        return await build_project_subtitles(session, pid)
    except Exception as e:  # noqa: BLE001 — 明确归一为 502,不带栈
        raise HTTPException(status_code=502, detail=f"字幕生成失败:{e}") from e


@router.post("/studio/projects/{pid}/subtitles/burn")
async def burn_subtitles_endpoint(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """内嵌:整片成片(或首可用视频)烧字幕 → <pid>_sub.mp4。"""
    p = _get_project(session, pid, user)
    from app.services.studio.subtitles import build_project_subtitles, burn_subtitles

    try:
        subs = await build_project_subtitles(session, pid)
        if not subs["cues"]:
            raise HTTPException(status_code=422, detail="无可用配音镜头,先生成字幕源(配音)")
        video_url = (p.final_url or "").strip()
        if not video_url:
            shot = session.exec(
                select(StudioShot)
                .where(StudioShot.project_id == pid)
                .order_by(StudioShot.idx)
            ).first()
            video_url = (getattr(shot, "video_url", "") or "").strip() if shot else ""
        if not video_url:
            raise HTTPException(status_code=422, detail="项目无成片/视频可烧字幕")
        out = await burn_subtitles(video_url, subs["srt_url"], f"{pid[:12]}_sub.mp4")
        return {"video_url": out, "srt_url": subs["srt_url"], "shots_covered": subs["shots_covered"]}
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(status_code=502, detail=f"字幕内嵌失败:{e}") from e


# ── S6(2026-10-11):资产下沉——全局主体库 Entity 在 Studio 域接入(只读+选用) ──
# 数据源真值核正:生产 DramaAsset=0,全局主体库是 Entity(24,模型注释明确
# 「DramaCharacter 旧数据由 db.py 启动迁移 copy 进本表」)。图片列是句柄 JSON
# 或纯 URL 双形态,经 parse_image_handle 解析为 /api/images URL 供渲染直接用。
def _entity_image_url(value: str) -> str:
    from app.services.entities import parse_image_handle

    v = (value or "").strip()
    if not v:
        return ""
    h = parse_image_handle(v)
    if h:
        from urllib.parse import quote

        return (
            f"/api/images?filename={quote(h['filename'])}"
            f"&type=input&worker={quote(h['worker'])}"
        )
    return v  # 纯 URL 原样


@router.get("/studio/assets")
def studio_shared_assets(
    kind: str | None = Query(default=None, description="character|scene|prop|avatar"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[dict]:
    """共享资产库(全局主体 Entity,只读引用;Studio 域不双写)。"""
    from app.models import Entity

    q = select(Entity).where(Entity.user_id == user.id)
    if kind:
        q = q.where(Entity.kind == kind)
    rows = session.exec(q.order_by(Entity.updated_at.desc())).all()
    return [
        {
            "id": a.id, "kind": a.kind, "name": a.name,
            "description": a.description, "visual_prompt": a.prompt_hint,
            "ref_image": _entity_image_url(a.ref_image),
            "has_three_view": bool(a.reference_front or a.reference_side or a.reference_back),
        }
        for a in rows
    ]


@router.post("/studio/assets/{aid}/apply-to-project/{pid}")
def studio_apply_asset(
    aid: str,
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """选用全局主体为项目角色卡(同名去重;character/avatar 类可选用)。

    参考图聚合:三视图(句柄→URL)优先,supplement ref_image;≤8 张(渲染契约)。
    """
    from app.models import Entity

    a = session.get(Entity, aid)
    if not a or a.user_id != user.id:
        raise HTTPException(status_code=404, detail="主体不存在")
    if (a.kind or "character") not in ("character", "avatar"):
        raise HTTPException(status_code=422, detail="仅角色/形象类主体可选用为项目角色")
    _get_project(session, pid, user)
    dup = session.exec(
        select(StudioCharacter).where(
            StudioCharacter.project_id == pid, StudioCharacter.name == a.name
        )
    ).first()
    if dup:
        return _character_out(dup)
    c = StudioCharacter(
        project_id=pid,
        name=a.name,
        description=a.description,
        visual_prompt=a.prompt_hint,
        voice_ref_url=a.ref_audio,
    )
    refs = [
        _entity_image_url(u)
        for u in (a.reference_front, a.reference_side, a.reference_back, a.ref_image)
    ]
    refs = [u for u in refs if u]
    if refs:
        c.reference_images = json.dumps(refs[:8], ensure_ascii=False)
    session.add(c)
    session.commit()
    session.refresh(c)
    return _character_out(c)


# ── W2.4(2026-10-11):工作流模板库(node_mapping 声明式注册) ──
@router.get("/studio/workflow-templates")
def workflow_templates_list(user: User = Depends(get_current_user)) -> list[dict]:
    """模板清单:含 node_mapping/能力约束/激活态。"""
    from app.services.studio.workflow_templates import list_templates

    return list_templates()


@router.get("/studio/workflow-templates/{tid}")
def workflow_template_get(tid: str, user: User = Depends(get_current_user)) -> dict:
    from app.services.studio.workflow_templates import get_template

    t = get_template(tid)
    if t is None:
        raise HTTPException(status_code=404, detail="模板不存在")
    return t


@router.put("/studio/workflow-templates/{tid}/activate")
def workflow_template_activate(
    tid: str, admin: User = Depends(get_current_admin)
) -> dict:
    """切换激活(管理员;同一 (engine,mode) 单激活,状态落 data 域)。"""
    from app.services.studio.workflow_templates import set_active

    try:
        return set_active(tid)
    except KeyError:
        raise HTTPException(status_code=404, detail="模板不存在") from None


# ── W2.2(2026-10-11):多视角分镜扩展(单角色参考图→多景别示意图,异步 Job) ──
_FRAME_KIND = "studio_frame_variants"


async def _run_frame_variants_job(job_id: str, sid: str, style: str) -> None:
    from app.db import engine as _engine
    from app.models import Job

    def _finish(status: str, result: dict) -> None:
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status in ("done", "error", "canceled"):
                return
            job.status = status
            job.result = json.dumps(result, ensure_ascii=False)
            s.add(job)
            s.commit()

    from app.services.studio.character_sheet import CharacterSheetError
    from app.services.studio.shot_frame import FrameVariantError, generate_frame_variants

    try:
        with Session(_engine) as s:
            job0 = s.get(Job, job_id)
            if not job0 or job0.status == "canceled":
                return
            job0.status = "running"
            s.add(job0)
            s.commit()

        with Session(_engine) as s:
            shot = s.get(StudioShot, sid)
            if not shot:
                _finish("error", {"error": "分镜不存在"})
                return
            variants = await generate_frame_variants(s, shot, style=style)
        _finish("done", {"variants": variants})
    except FrameVariantError as e:
        _finish("error", {"error": str(e)})
    except CharacterSheetError as e:
        _finish("error", {"error": f"出图失败:{e}"})
    except Exception as e:  # noqa: BLE001
        logger.exception("frame_variants job %s 意外失败", job_id)
        _finish("error", {"error": f"配景生成失败:{e}"})


@router.post("/studio/shots/{sid}/frame-variants")
async def submit_frame_variants(
    sid: str,
    body: "FrameVariantsRequest | None" = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """提交多景别配景(异步):3 景别示意图(远/中/近),Job+轮询(模式同设定卡 S3-b)。"""
    import asyncio as _asyncio

    from app.models import Job
    from app.versioning import params_snapshot

    shot = _get_shot(session, sid, user)
    style = (body.style if body else None) or "anime"
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",
        worker="",
        kind=_FRAME_KIND,
        status="queued",
        prompt=f"配景 {shot.scene[:60]}".strip()[:200],
        params=params_snapshot(FrameVariantsRequest(style=style), sid=sid),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"frame-{job.id}"
    session.add(job)
    session.commit()
    _asyncio.create_task(_run_frame_variants_job(job.id, sid, style))
    return {"job_id": job.id, "status": "queued"}


@router.get("/studio/shots/{sid}/frame-variants/{job_id}")
def frame_variants_status(
    sid: str,
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """轮询配景结果:done → {variants:[{scale,url}]}。"""
    from app.models import Job

    _get_shot(session, sid, user)
    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _FRAME_KIND:
        raise HTTPException(status_code=404, detail="作业不存在")
    out: dict = {"status": job.status}
    if job.result:
        try:
            out.update(json.loads(job.result))
        except (ValueError, TypeError):
            pass
    return out


# ── S3-b(2026-10-11):设定卡生成异步化——15-20min 同步等待是 UX/可靠性双重雷 ──
# 模式复用 script/parse:Job 建档 + 进程内后台协程 + 轮询端点;任务中心天然可见/可取消。
_SHEET_KIND = "studio_sheet_gen"


async def _run_sheet_job(job_id: str, cid: str, body: CharacterSheetRequest) -> None:
    from app.db import engine as _engine
    from app.models import Job

    def _finish(status: str, result: dict) -> None:
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status in ("done", "error", "canceled"):
                return
            job.status = status
            job.result = json.dumps(result, ensure_ascii=False)
            s.add(job)
            s.commit()

    try:
        with Session(_engine) as s:
            job0 = s.get(Job, job_id)
            if not job0 or job0.status == "canceled":
                return
            job0.status = "running"
            s.add(job0)
            s.commit()
        with Session(_engine) as s:
            c = s.get(StudioCharacter, cid)
            if not c:
                _finish("error", {"error": "角色不存在"})
                return
            out = await _generate_sheet_core(c, body, s, get_pool())
        _finish("done", {
            k: out.get(k)
            for k in ("sheet_url", "sheet_style", "panel_urls", "apply_to_video_refs")
        })
    except HTTPException as e:
        detail = e.detail
        if isinstance(detail, dict):
            _finish("error", detail)
        else:
            from app.services.studio.character_sheet import ux as sheet_ux

            _finish(
                "error",
                sheet_ux.build_sheet_gate_failure_payload(
                    str(detail),
                    character_id=cid,
                    style=getattr(body, "style", "") or "anime",
                    status_code=e.status_code,
                ),
            )
    except Exception as e:  # noqa: BLE001 — 后台任务绝不静默死掉
        logger.exception("sheet job %s 意外失败", job_id)
        from app.services.studio.character_sheet import ux as sheet_ux

        _finish(
            "error",
            sheet_ux.build_sheet_gate_failure_payload(
                f"设定卡生成失败:{e}",
                character_id=cid,
                style=getattr(body, "style", "") or "anime",
                status_code=500,
            ),
        )


@router.post("/studio/characters/{cid}/character-sheet/async")
async def generate_character_sheet_async(
    cid: str,
    body: CharacterSheetRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """提交设定卡生成(异步):建档 Job + 后台跑;前端轮询 async/{job_id} 取结果。

    全管线 15-20 分钟级(portrait 颜色门禁/徽标 inpaint/表情×6 VLM 质检),
    同步等待必然撞浏览器/代理超时——工作区与长链客户端一律走本端点。
    """
    import asyncio as _asyncio

    from app.models import Job
    from app.versioning import params_snapshot

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",
        worker="",
        kind=_SHEET_KIND,
        status="queued",
        prompt=f"设定卡 {c.name or cid[:8]} {body.style}".strip()[:200],
        params=params_snapshot(body, cid=cid),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"sheet-{job.id}"
    session.add(job)
    session.commit()
    _asyncio.create_task(_run_sheet_job(job.id, cid, body))
    return {"job_id": job.id, "status": "queued"}


@router.get("/studio/characters/{cid}/character-sheet/async/{job_id}")
def sheet_job_status(
    cid: str,
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """轮询设定卡生成:done → {sheet_url, panel_urls…};error → {error}。"""
    from app.models import Job

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _SHEET_KIND:
        raise HTTPException(status_code=404, detail="作业不存在")
    out: dict = {"status": job.status}
    if job.result:
        try:
            out.update(json.loads(job.result))
        except (ValueError, TypeError):
            pass
    return out


@router.post("/studio/characters/{cid}/character-sheet/panels")
async def regenerate_character_sheet_panels_route(
    cid: str,
    body: CharacterSheetPanelsRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    pool=Depends(get_pool),
):
    """单格/多格重生成:锁定合格区,仅重做 keys。

    默认只落设定卡/分格文件,不写视频参考。
    apply_to_video_refs=true 时只写 reference_images_by_style 本风格分桶
    (portrait+front/side/back),绝不改扁平 reference_images(sample_linxia×3 兜底保留)。
    """
    from app.services.studio import character_sheet as sheet_svc
    from app.storage import drama_output_root

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)

    name = (c.name or "").strip()
    if not name:
        raise HTTPException(status_code=422, detail="角色名为空")
    visual = (body.visual_prompt_override or c.visual_prompt or "").strip()
    if not visual and not (c.description or "").strip():
        raise HTTPException(status_code=422, detail="角色缺少视觉描述")

    try:
        sheet_svc.assert_design_notes_ok((body.design_notes or "").strip())
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    meta = sheet_svc.SheetMeta(
        name=name,
        style=body.style,
        height_cm=body.height_cm,
        role=(body.role or "").strip(),
        personality=(body.personality or "").strip(),
        design_notes=(body.design_notes or "").strip(),
        colors=list(body.colors or []),
        visual_prompt=visual,
        description=(c.description or "").strip(),
        template=(getattr(body, "template", "") or "").strip(),
    )

    locked: dict[str, bytes] = {}
    if body.lock_from_sheet:
        # 从 studio 目录取该角色该风格最新 portrait(及未列入 keys 的 turnaround)
        studio = drama_output_root() / "studio"
        style = body.style
        prefix = f"char_panel_{cid[:8]}_{style}_"
        regen_set = set(body.keys)
        # 锁定 portrait 必须
        portraits = sorted(studio.glob(f"{prefix}portrait_*.png"), key=lambda p: p.stat().st_mtime)
        if portraits:
            locked["portrait"] = portraits[-1].read_bytes()
        for key in ("front", "side", "back", "faces", "costume", *sheet_svc._EXPR_KEYS):
            if key in regen_set or key == "portrait":
                continue
            hits = sorted(studio.glob(f"{prefix}{key}_*.png"), key=lambda p: p.stat().st_mtime)
            if hits:
                locked[key] = hits[-1].read_bytes()
        # 磁盘无 expr_* 时从最新整卡裁出,禁止重生单格时表情被占位脸裁掉
        if sum(1 for k in sheet_svc._EXPR_KEYS if k in locked) < 6:
            sheets = sorted(
                studio.glob(f"char_sheet_{cid[:8]}_{style}_*.png"),
                key=lambda p: p.stat().st_mtime,
            )
            if sheets:
                locked = sheet_svc.extract_locked_panels_from_sheet(
                    sheets[-1].read_bytes(),
                    existing=locked,
                )
                # 重生键仍以 regen 为准(整卡裁出的同名键丢掉)
                for rk in regen_set:
                    locked.pop(rk, None)
        if "portrait" not in locked:
            raise HTTPException(status_code=422, detail="无可用锁定立绘,请先整卡或提供 portrait")

    try:
        url, _png, panel_urls, debug = await sheet_svc.regenerate_sheet_panels(
            character_id=c.id,
            meta=meta,
            pool=pool,
            locked_panels=locked,
            regen_keys=list(body.keys),
            n_candidates=body.n_candidates,
            worker=body.worker,
            seed=body.seed,
        )
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    refs_out = None
    by_style_out = None
    # 10/05:首次定妆(本风格分桶为空)自动写入视频参考,否则新角色进视频步 C/c_hybrid 无参考直接失败;
    # 已有分桶时仍尊重 apply_to_video_refs=False,不覆盖已确认的参考。
    _bucket_empty = not sheet_svc.parse_refs_by_style(
        getattr(c, "reference_images_by_style", None) or "{}"
    ).get(body.style)
    _apply_refs = bool(getattr(body, "apply_to_video_refs", False)) or _bucket_empty
    if _apply_refs:
        try:
            existing = json.loads(c.reference_images or "[]")
        except (ValueError, TypeError):
            existing = []
        if not isinstance(existing, list):
            existing = []
        by_style = sheet_svc.parse_refs_by_style(
            getattr(c, "reference_images_by_style", None) or "{}"
        )
        try:
            by_style = sheet_svc.merge_video_refs_by_style(
                by_style,
                style=body.style,
                panel_urls=panel_urls,
                sheet_url=url,
            )
        except (
            sheet_svc.ReferenceImagesStyleError,
            sheet_svc.CharacterSheetError,
        ) as e:
            raise HTTPException(status_code=getattr(e, "status_code", 422), detail=str(e)) from e
        # 22:31:只写 by_style 分桶,不改扁平 reference_images(雨夜写实仍保留 sample_linxia×3)
        c.reference_images_by_style = json.dumps(by_style, ensure_ascii=False)
        session.add(c)
        session.commit()
        session.refresh(c)
        refs_out = [u for u in existing if isinstance(u, str)]
        by_style_out = by_style
    _note_asset_regeneration(
        cid, body.style, reason=f"面板重生成:{','.join(body.keys)}"
    )
    out = _character_out(c)
    out["sheet_url"] = url
    out["sheet_style"] = body.style
    out["panel_urls"] = panel_urls
    out["debug"] = debug
    out["apply_to_video_refs"] = _apply_refs
    if refs_out is not None:
        out["reference_images"] = refs_out
    if by_style_out is not None:
        out["reference_images_by_style"] = by_style_out
    return out



@router.get("/studio/characters/{cid}/character-sheets")
def list_character_sheets(
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """列出角色已落盘设定卡(按风格取最新 sheet + 分格)。不改 reference_images。"""
    from app.services.studio import character_sheet as sheet_svc
    from app.storage import drama_output_root

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    studio = drama_output_root() / "studio"
    out = []
    if studio.exists():
        for style in sheet_svc.SHEET_STYLES:
            sheets = sorted(
                studio.glob(f"char_sheet_{cid[:8]}_{style}_*.png"),
                key=lambda p: p.stat().st_mtime,
            )
            if not sheets:
                continue
            latest = sheets[-1]
            prefix = f"char_panel_{cid[:8]}_{style}_"
            panels: dict[str, str] = {}
            for key in ("portrait", "front", "side", "back", "faces", "costume"):
                hits = sorted(
                    studio.glob(f"{prefix}{key}_*.png"),
                    key=lambda p: p.stat().st_mtime,
                )
                if hits:
                    panels[key] = f"/api/studio/files/{hits[-1].name}"
            item = {
                "style": style,
                "sheet_url": f"/api/studio/files/{latest.name}",
                "mtime": latest.stat().st_mtime,
                "panel_urls": panels,
            }
            warn = sheet_svc.load_gate_warn_meta(latest.name)
            if warn and warn.get("warning"):
                item["gate_warning"] = True
                item["gate_warning_zh"] = warn.get("reason_zh") or "门禁未过（警告保留）"
            out.append(item)
    return {"character_id": cid, "sheets": out}


class KeepRejectedSheetBody(BaseModel):
    """本地学习软模式：警告下保留拒图为设定卡。"""

    style: str
    preview_url: str
    reason_zh: str = ""
    technical_detail: str = ""


@router.post("/studio/characters/{cid}/character-sheet/keep-rejected")
def keep_rejected_character_sheet(
    cid: str,
    body: KeepRejectedSheetBody,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """把门禁拒图晋升为带警告标记的设定卡（不宣称质检已过；本地学习 UX）。"""
    from app.services.studio.character_sheet import ux as sheet_ux

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    style = (body.style or "").strip()
    if style not in ("ancient_realistic", "anime"):
        raise HTTPException(status_code=422, detail="style 无效")
    try:
        out = sheet_ux.keep_rejected_as_warning_sheet(
            character_id=c.id,
            style=style,
            preview_url=body.preview_url,
            reason_zh=body.reason_zh,
            technical_detail=body.technical_detail,
        )
    except FileNotFoundError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return out


@router.post("/studio/characters/{cid}/character-sheet/panel-replace")
async def replace_character_sheet_panel(
    cid: str,
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """用上传图替换单格并重拼整卡。body: style,key,image_b64 或 image_url。不写 reference_images。"""
    import base64
    import time
    from app.services.studio import character_sheet as sheet_svc
    from app.storage import drama_output_root

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)

    style = str(body.get("style") or "")
    key = str(body.get("key") or "")
    if style not in sheet_svc.SHEET_STYLES:
        raise HTTPException(status_code=422, detail="style 无效")
    allowed_keys = {
        "portrait", "front", "side", "back", "faces", "costume",
        *sheet_svc._EXPR_KEYS,
    }
    if key not in allowed_keys:
        raise HTTPException(status_code=422, detail=f"key 无效:{key}")

    raw: bytes | None = None
    b64 = body.get("image_b64")
    if isinstance(b64, str) and b64.strip():
        try:
            raw = base64.b64decode(b64.split(",")[-1])
        except Exception as e:  # noqa: BLE001
            raise HTTPException(status_code=422, detail="image_b64 无效") from e
    elif isinstance(body.get("image_url"), str) and body["image_url"].strip():
        # 仅允许本站 studio files
        name = Path(body["image_url"]).name
        path = drama_output_root() / "studio" / name
        if not path.is_file():
            raise HTTPException(status_code=404, detail="替换图不存在")
        raw = path.read_bytes()
    if not raw:
        raise HTTPException(status_code=422, detail="需要 image_b64 或 image_url")

    studio = drama_output_root() / "studio"
    studio.mkdir(parents=True, exist_ok=True)
    prefix = f"char_panel_{cid[:8]}_{style}_"
    locked: dict[str, bytes] = {key: raw}
    for k in ("portrait", "front", "side", "back", "faces", "costume", *sheet_svc._EXPR_KEYS):
        if k == key:
            continue
        hits = sorted(studio.glob(f"{prefix}{k}_*.png"), key=lambda p: p.stat().st_mtime)
        if hits:
            locked[k] = hits[-1].read_bytes()
    # 缺格(含表情 expr_0..5)一律从最新整卡裁切补齐;禁止空白占位盖掉已有表情
    _need = ("portrait", "front", "side", "back", "faces", "costume")
    _need_expr = (
        "expressions" not in locked
        and sum(1 for k in locked if k.startswith("expr_") and locked.get(k)) < 6
    )
    if (
        "portrait" not in locked
        or any(k not in locked for k in _need)
        or _need_expr
    ):
        sheets = sorted(
            studio.glob(f"char_sheet_{cid[:8]}_{style}_*.png"),
            key=lambda p: p.stat().st_mtime,
        )
        if sheets:
            locked = sheet_svc.extract_locked_panels_from_sheet(
                sheets[-1].read_bytes(),
                existing=locked,
            )
    if "portrait" not in locked:
        raise HTTPException(status_code=422, detail="无立绘,无法重拼")
    # 仍缺表情且无整卡可裁时才浅底占位(极端冷启动);有整卡时绝不用空白盖表情
    if "expressions" not in locked and sum(
        1 for k in locked if k.startswith("expr_") and locked.get(k)
    ) < 6:
        sheets = sorted(
            studio.glob(f"char_sheet_{cid[:8]}_{style}_*.png"),
            key=lambda p: p.stat().st_mtime,
        )
        if sheets:
            locked = sheet_svc.extract_locked_panels_from_sheet(
                sheets[-1].read_bytes(),
                existing=locked,
            )
        else:
            from io import BytesIO
            from PIL import Image
            buf = BytesIO()
            Image.new("RGB", (980, 480), (248, 248, 252)).save(buf, format="PNG")
            locked["expressions"] = buf.getvalue()

    dest = studio / f"{prefix}{key}_{_sheet_token()}.png"
    dest.write_bytes(raw)
    # 持久化其余锁定格(含 expr_*),避免下次再丢表情
    for k, data in locked.items():
        if k == key or k == "expressions":
            continue
        if not data:
            continue
        if not list(studio.glob(f"{prefix}{k}_*.png")):
            (studio / f"{prefix}{k}_{_sheet_token()}.png").write_bytes(data)

    meta = sheet_svc.SheetMeta(
        name=(c.name or "").strip() or "角色",
        style=style,
        height_cm=int(body.get("height_cm") or 168),
        role=str(body.get("role") or ""),
        personality=str(body.get("personality") or ""),
        design_notes=str(body.get("design_notes") or ""),
        visual_prompt=(c.visual_prompt or "").strip(),
        description=(c.description or "").strip(),
        template=str(body.get("template") or "").strip(),
    )
    try:
        png = (
            sheet_svc.compose_reference_board(locked, meta)
            if meta.template == "toonflow_board"
            else sheet_svc.compose_character_sheet(locked, meta)
        )
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    sheet_name = f"char_sheet_{cid[:8]}_{style}_{_sheet_token()}.png"
    (studio / sheet_name).write_bytes(png)
    # 真实 URL:用最新文件名;expressions 合成区无独立文件时仍报 expr_0..5
    panel_urls: dict[str, str] = {}
    for k in locked:
        if k == "expressions":
            continue
        hits = sorted(studio.glob(f"{prefix}{k}_*.png"), key=lambda p: p.stat().st_mtime)
        if hits:
            panel_urls[k] = f"/api/studio/files/{hits[-1].name}"
    # 保证响应含 6 表情键(即使刚从整卡裁出并落盘)
    for ek in sheet_svc._EXPR_KEYS:
        if ek not in panel_urls and ek in locked:
            hits = sorted(studio.glob(f"{prefix}{ek}_*.png"), key=lambda p: p.stat().st_mtime)
            if hits:
                panel_urls[ek] = f"/api/studio/files/{hits[-1].name}"
    return {
        "sheet_url": f"/api/studio/files/{sheet_name}",
        "sheet_style": style,
        "panel_urls": panel_urls,
        "replaced_key": key,
        "apply_to_video_refs": False,
        "preserved_keys": sorted(k for k in locked if k != key and locked.get(k)),
    }



@router.post("/studio/characters/{cid}/character-sheet/recompose")
def recompose_character_sheet_meta(
    cid: str,
    body: CharacterSheetRecomposeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """只改资料文字重拼整卡:锁全部图像格,不跑 Comfy,绝不写 reference_images。"""
    from app.services.studio import character_sheet as sheet_svc
    from app.storage import drama_output_root

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)

    style = body.style
    if style not in sheet_svc.SHEET_STYLES:
        raise HTTPException(status_code=422, detail="style 无效")

    studio_dir = drama_output_root() / "studio"
    studio_dir.mkdir(parents=True, exist_ok=True)
    sheets = sorted(
        studio_dir.glob(f"char_sheet_{cid[:8]}_{style}_*.png"),
        key=lambda p: p.stat().st_mtime,
    )
    if not sheets:
        raise HTTPException(status_code=404, detail="尚无该风格设定卡,请先新建")

    prefix = f"char_panel_{cid[:8]}_{style}_"
    locked: dict[str, bytes] = {}
    for k in ("portrait", "front", "side", "back", "faces", "costume", *sheet_svc._EXPR_KEYS):
        hits = sorted(studio_dir.glob(f"{prefix}{k}_*.png"), key=lambda p: p.stat().st_mtime)
        if hits:
            locked[k] = hits[-1].read_bytes()
    locked = sheet_svc.extract_locked_panels_from_sheet(sheets[-1].read_bytes(), existing=locked)
    if "portrait" not in locked or not locked.get("portrait"):
        raise HTTPException(status_code=422, detail="无立绘,无法重拼")

    try:
        sheet_svc.assert_design_notes_ok((body.design_notes or "").strip())
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    meta = sheet_svc.SheetMeta(
        name=(c.name or "").strip() or "角色",
        style=style,
        height_cm=body.height_cm,
        role=(body.role or "").strip(),
        personality=(body.personality or "").strip(),
        design_notes=(body.design_notes or "").strip(),
        colors=list(body.colors or []),
        visual_prompt=(c.visual_prompt or "").strip(),
        description=(c.description or "").strip(),
        template=(getattr(body, "template", "") or "").strip(),
    )
    try:
        png = (
            sheet_svc.compose_reference_board(locked, meta)
            if meta.template == "toonflow_board"
            else sheet_svc.compose_character_sheet(locked, meta)
        )
    except sheet_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e

    sheet_name = f"char_sheet_{cid[:8]}_{style}_{_sheet_token()}.png"
    (studio_dir / sheet_name).write_bytes(png)

    if body.persist_description:
        parts = [
            part
            for part in (
                (body.role or "").strip(),
                (body.personality or "").strip(),
                (body.design_notes or "").strip(),
            )
            if part
        ]
        if parts:
            c.description = "\n".join(parts)[:2000]
            session.add(c)
            session.commit()
            session.refresh(c)

    panel_urls: dict[str, str] = {}
    for k in ("portrait", "front", "side", "back", "faces", "costume", *sheet_svc._EXPR_KEYS):
        hits = sorted(studio_dir.glob(f"{prefix}{k}_*.png"), key=lambda p: p.stat().st_mtime)
        if hits:
            panel_urls[k] = f"/api/studio/files/{hits[-1].name}"

    out = _character_out(c)
    out["sheet_url"] = f"/api/studio/files/{sheet_name}"
    out["sheet_style"] = style
    out["panel_urls"] = panel_urls
    out["apply_to_video_refs"] = False
    return out



def _sheet_token() -> str:
    return uuid.uuid4().hex[:12]


# ── 角色资产协议 L2(Character Asset Definition) ──────────────────────────


def _note_asset_regeneration(cid: str, style: str, *, reason: str) -> None:
    """生成链钩子:已物化资产做版本级联;未物化跳过(首次 GET 落 v1)。不阻塞主链。"""
    try:
        from app.services.studio import character_asset as asset_svc

        asset_svc.note_sheet_generated(cid, style, reason=reason)
    except Exception:  # noqa: BLE001
        logger.exception("character asset note_sheet_generated failed cid=%s", cid)


def _ensure_character_asset(
    session: Session, cid: str, style: str, user: User
) -> tuple[StudioCharacter, dict, bool]:
    from app.services.studio import character_asset as asset_svc

    c = session.get(StudioCharacter, cid)
    if not c:
        raise HTTPException(status_code=404, detail="角色不存在")
    _get_project(session, c.project_id, user)
    existed = asset_svc.load_asset(cid, style) is not None
    try:
        asset = asset_svc.ensure_asset(
            character_id=cid,
            style=style,
            name=(c.name or "").strip(),
            description=(c.description or "").strip(),
            visual_prompt=(c.visual_prompt or "").strip(),
        )
    except asset_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return c, asset, existed


@router.get("/studio/characters/{cid}/character-asset")
def get_character_asset(
    cid: str,
    style: str = "anime",
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """L2 资产定义;JSON 不存在时从存量面板文件+角色行自动物化 v1(D3 回填)。"""
    _, asset, existed = _ensure_character_asset(session, cid, style, user)
    out = dict(asset)
    out["materialized_now"] = not existed
    return out


@router.put("/studio/characters/{cid}/character-asset")
def put_character_asset(
    cid: str,
    body: CharacterAssetPutRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """白名单字段补丁:锚点/档案/负向约束/锁定/色板/覆盖/QA;校验失败 422。"""
    from app.services.studio import character_asset as asset_svc

    _, asset, _ = _ensure_character_asset(session, cid, body.style, user)
    patch = body.model_dump(exclude={"style"}, exclude_none=True)
    for field in (
        "identity_anchors",
        "profile",
        "canonical_prompt",
        "lock",
        "color_palette",
        "coverage",
        "qa",
        "style_variants",
    ):
        if field in patch:
            asset[field] = patch[field]
    if "variants_allowed" in patch:
        asset.setdefault("style", {})["variants_allowed"] = bool(
            patch["variants_allowed"]
        )
    try:
        asset_svc.save_asset(asset)
    except asset_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return asset


@router.post("/studio/characters/{cid}/character-asset/refresh")
def refresh_character_asset(
    cid: str,
    body: CharacterAssetRefreshRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """面板重生成后的版本级联:刷新 coverage/panels 登记 + version+1 + derived_from。"""
    from app.services.studio import character_asset as asset_svc

    _, asset, _ = _ensure_character_asset(session, cid, body.style, user)
    panels = asset_svc.latest_panel_paths(cid, body.style)
    if panels:
        asset["panels"] = {k: True for k in panels}
        asset["coverage"] = {
            **asset_svc.default_coverage(list(panels.keys())),
            "two_shot": bool((asset.get("coverage") or {}).get("two_shot")),
        }
    asset_svc.record_regeneration(
        asset, reason=body.reason, workflow="asset-refresh"
    )
    try:
        asset_svc.save_asset(asset)
    except asset_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return asset


@router.post("/studio/characters/{cid}/character-asset/card")
def render_character_asset_card(
    cid: str,
    body: CharacterAssetCardRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """D2 展示卡:资产集的模板渲染视图(对外传播形态),非一致性来源。"""
    from app.services.studio import character_asset as asset_svc

    _, asset, _ = _ensure_character_asset(session, cid, body.style, user)
    try:
        url, _png = asset_svc.render_character_card(
            character_id=cid, style=body.style, asset=asset
        )
    except asset_svc.CharacterSheetError as e:
        raise HTTPException(status_code=e.status_code, detail=str(e)) from e
    return {
        "character_id": cid,
        "style": body.style,
        "asset_version": asset.get("version"),
        "card_url": url,
    }


@router.post("/studio/characters/{cid}/character-asset/coverage-plan")
def character_asset_coverage_plan(
    cid: str,
    body: CharacterAssetCoveragePlanRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """M2:短剧覆盖缺口登记 + 补拍计划(只出计划,执行挂现有生成链)。"""
    from app.services.studio import character_asset as asset_svc

    _, asset, _ = _ensure_character_asset(session, cid, body.style, user)
    profile = None
    if body.angles or body.framings or body.lightings:
        profile = {
            "angles": body.angles or [],
            "framings": body.framings or [],
            "lightings": body.lightings or [],
        }
    gaps = asset_svc.coverage_gaps(asset.get("coverage") or {}, profile)
    plan = asset_svc.coverage_backfill_plan(asset, profile)
    return {
        "character_id": cid,
        "style": body.style,
        "coverage": asset.get("coverage") or {},
        "gaps": gaps,
        "plan": plan,
    }





class AdoptKeyframeRequest(BaseModel):
    """F1：将配景/上传图采用为镜头关键帧（写入 image_url）。"""

    url: str = Field(..., min_length=1, max_length=2000)


@router.post("/studio/shots/{sid}/adopt-keyframe")
def adopt_shot_keyframe(
    sid: str,
    body: AdoptKeyframeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """采用关键帧：校验工作室文件域 URL → 写入 shot.image_url（不改视频/成片）。"""
    from datetime import datetime

    from app.services.studio.keyframe_drive import is_studio_file_url

    shot = _get_shot(session, sid, user)
    url = (body.url or "").strip()
    if not is_studio_file_url(url):
        raise HTTPException(status_code=422, detail="关键帧须为 /api/studio/files/ 下的站内文件")
    # 仅保留 path 形态，避免跨 host 泄漏
    if "/api/studio/files/" in url:
        url = "/api/studio/files/" + url.rsplit("/api/studio/files/", 1)[-1]
    shot.image_url = url
    shot.updated_at = datetime.utcnow()
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return _shot_out(shot)


# ── 分镜批量保存 ───────────────────────────────────────────────────────────


@router.put("/studio/projects/{pid}/shots")
def save_shots(
    pid: str,
    body: ShotsSaveRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    _get_project(session, pid, user)
    out: list[StudioShot] = []
    for i, item in enumerate(body.shots):
        if item.id:
            shot = session.get(StudioShot, item.id)
            if not shot or shot.project_id != pid:
                raise HTTPException(status_code=404, detail=f"分镜不存在:{item.id}")
        else:
            shot = StudioShot(project_id=pid)
        shot.idx = i
        shot.scene = item.scene
        shot.prompt = item.prompt
        if item.negative is not None:
            shot.negative = item.negative
        shot.camera = item.camera
        shot.dialogue = item.dialogue
        shot.speaker = item.speaker
        shot.duration_sec = item.duration_sec
        shot.characters = json.dumps(item.characters, ensure_ascii=False)
        if item.seam_to_next is not None:
            shot.seam_to_next = item.seam_to_next
        if item.seam_anchor is not None:
            shot.seam_anchor = item.seam_anchor
        if item.ref_epoch is not None:
            shot.ref_epoch = item.ref_epoch
        if item.ref_epoch_note is not None:
            shot.ref_epoch_note = item.ref_epoch_note
        # FU1 词锚:拍结构落库(None=不改;[]=清空)，消费文本从声明派生。
        from app.services.svml_timeline import _norm_beats, beat_text_fields, parse_beats_json, project_timeline

        if item.beats is not None:
            declarations = _norm_beats([b.model_dump() for b in item.beats])
            shot.beats_json = json.dumps(declarations, ensure_ascii=False)
        else:
            declarations = parse_beats_json(shot.beats_json)
        if declarations:
            shot.duration_sec = project_timeline(declarations, total_sec=shot.duration_sec)["duration_sec"]
            if all(b.get("kind") in ("v", "d") for b in declarations):
                for field, text in beat_text_fields(declarations).items():
                    setattr(shot, field, text)
        # 生成方式变化 → 旧媒体失效,回到草稿
        if shot.render_mode != item.render_mode:
            shot.render_mode = item.render_mode
            shot.image_url = shot.video_url = shot.final_clip_url = ""
            shot.status = "draft"
        session.add(shot)
        out.append(shot)
    # 全量替换语义:请求未包含的旧分镜删除(前端拆解剧本/删镜依赖此契约)
    keep = {s.id for s in out}
    for s in session.exec(select(StudioShot).where(StudioShot.project_id == pid)).all():
        if s.id not in keep:
            session.delete(s)
    # 统一提交:循环内逐个 commit 会 expire 已产出的 shot 对象,导致 model_dump 丢字段
    session.commit()
    for shot in out:
        session.refresh(shot)
    return {"shots": [_shot_out(s) for s in out]}


class ShotReflowRequest(BaseModel):
    """FU1 改词重排:改台词后重投影拍时长(锚/cue 不动)。"""

    texts: list[str] | None = Field(default=None, max_length=200)
    total_sec: int | None = Field(default=None, ge=3, le=60)
    persist: bool = True


@router.post("/studio/shots/{sid}/reflow-beats")
def reflow_shot_beats(
    sid: str,
    body: ShotReflowRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """hypit 词锚投影:改词 → 按新文本重分时长;声明源仍是 beats 文本。"""
    from datetime import datetime
    from app.services.svml_timeline import (
        _norm_beats, beat_text_fields, bind_beat_channels, parse_beats_json, reflow_beats,
    )

    shot = _get_shot(session, sid, user)
    beats = parse_beats_json(shot.beats_json)
    if not beats and body.texts:
        raise HTTPException(status_code=422, detail="该镜无词锚拍结构,无法重排")
    try:
        if body.texts is not None:
            beats = bind_beat_channels(beats, dialogue=shot.dialogue, prompt=shot.prompt)
        result = reflow_beats(
            beats, new_texts=body.texts,
            total_sec=body.total_sec if body.total_sec is not None else shot.duration_sec,
        )
        fields = beat_text_fields(result["beats"])
    except ValueError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    if body.persist:
        # 只存声明，不把 start/end 等派生时间写回真源。
        shot.beats_json = json.dumps(_norm_beats(result["beats"]), ensure_ascii=False)
        shot.duration_sec = result["duration_sec"]
        for field, text in fields.items():
            setattr(shot, field, text)
        shot.updated_at = datetime.utcnow()
        session.add(shot)
        session.commit()
        session.refresh(shot)
        return _shot_out(shot)
    return {**_shot_out(shot), **result, **fields, "persisted": False}


# ── 剧本拆解 ───────────────────────────────────────────────────────────────

# 2026-08-29 异步化(生产实证:长文本同步拆解必然撞前端 120s fetch 墙):
# POST 提交即建档 Job(kind=studio_script_parse)+ 进程内后台任务跑 LLM,
# 前端 2s 轮询 GET parse-status 拉结果;任务中心可见/可中止(取消 → error 态返回)。
_PARSE_KIND = "studio_script_parse"


async def _run_script_parse(job_id: str, pid: str, body: ScriptParseRequest) -> None:
    """后台跑 LLM 拆解,结果写 Job.result;取消/终态不回写(与 tracker canceled 语义一致)。"""
    from app.db import engine as _engine
    from app.models import Job

    def _finish(status: str, result: dict) -> None:
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            # 用户中止/异常回收的终态不覆盖
            if not job or job.status in ("done", "error", "canceled"):
                return
            job.status = status
            job.result = json.dumps(result, ensure_ascii=False)
            s.add(job)
            s.commit()

    try:
        # 启动自检:已被用户中止(cancel 端点直写库)直接退出,否则标记 running
        with Session(_engine) as s:
            job0 = s.get(Job, job_id)
            if not job0 or job0.status == "canceled":
                return
            job0.status = "running"
            s.add(job0)
            s.commit()
        # 合法角色名集合注入校验上下文(与原同步路径同语义)
        with Session(_engine) as s:
            known = [
                c.name
                for c in s.exec(
                    select(StudioCharacter).where(StudioCharacter.project_id == pid)
                ).all()
            ]
        characters, shots = await storyboard.parse_script(
            body.premise,
            num_shots=body.num_shots,
            style=body.style,
            known_characters=known or None,
        )
        _finish("done", {
            "characters": [c.model_dump() for c in characters],
            "shots": [s.model_dump() for s in shots],
        })
    except storyboard.StoryboardError as e:
        _finish("error", {"error": str(e)})
    except Exception as e:  # noqa: BLE001 — 后台任务绝不静默死掉
        logger.exception("script parse job %s 意外失败", job_id)
        _finish("error", {"error": f"拆解失败:{e}"})


def reconcile_stuck_renders() -> int:
    """S4-b(2026-10-11):启动时收口僵尸渲染态 studioushot。

    实测病灶:同步 render 撞客户端断连/VRAM 驱逐路径,handler 死亡后
    status 永久停在 rendering/queued(E-7 反向:DB 标 rendering ≠ 在跑)。
    api 重启时一切进程内 handler 必死,故启动时见 rendering/queued 即僵尸。
    (异步 wait=false 路径由 tracker/Job 语义自愈,不受影响——其镜状态
    由 orchestrator 落库,重启后 reconcile_interrupted 类兜底;此处只兜同步残留。)
    """
    from app.db import engine as _engine
    from app.models import Job, StudioShot

    n = 0
    with Session(_engine) as s:
        rows = s.exec(
            select(StudioShot).where(
                StudioShot.status.in_(("rendering", "queued"))  # type: ignore[attr-defined]
            )
        ).all()
        for sh in rows:
            # S5:有 queued 候选(Job 在身)的镜归 render_reconcile 管(Job 终态定生死),
            # 此处误杀会把 Job 已 done 的可救镜打成 error(实测#5 竞态)。
            try:
                cands = json.loads(sh.candidates_json or "[]")
            except (ValueError, TypeError):
                cands = []
            if isinstance(cands, list) and any(
                isinstance(c, dict) and c.get("status") == "queued" and c.get("db_job_id")
                for c in cands
            ):
                continue
            sh.status = "error"
            sh.error = "渲染中断(服务重启或请求断开),请重新渲染"
            s.add(sh)
            n += 1
        if n:
            s.commit()
    if n:
        logger.info("reconcile_stuck_renders: 收口 %d 个僵尸渲染态 studioshot", n)
    return n


def reconcile_parse_jobs() -> int:
    """api 重启后收口在跑拆解作业(进程内协程随重启消失):标 error 允许重试。

    参照 drama_studio.reconcile_interrupted;tracker.reconcile_pending 按空 worker
    跳过此类作业,收口责任在本函数。返回收口数量。
    """
    from app.db import engine as _engine
    from app.models import Job

    n = 0
    with Session(_engine) as s:
        rows = s.exec(
            select(Job).where(
                Job.kind.in_((_PARSE_KIND, _SHEET_KIND, _FRAME_KIND, _IMAGE_PARSE_KIND, "studio_batch_render")),  # type: ignore[attr-defined]
                Job.status.in_(("queued", "running")),  # type: ignore[attr-defined]
            )
        ).all()
        for job in rows:
            job.status = "error"
            job.result = json.dumps({"error": "服务重启,拆解中断,请重新提交"}, ensure_ascii=False)
            s.add(job)
            n += 1
        if n:
            s.commit()
    if n:
        logger.info("reconcile_parse_jobs: 收口 %d 个中断的拆解作业为 error", n)
    return n


@router.post("/studio/projects/{pid}/script/parse")
async def parse_script_endpoint(
    pid: str,
    body: ScriptParseRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """提交剧本拆解(异步):建档 Job + 后台跑 LLM,前端轮询 parse-status 取结果。

    返回 {job_id, status: "queued"};拆解结果不落项目库,前端确认后走 CRUD 保存。
    """
    import asyncio as _asyncio

    from app.models import Job
    from app.versioning import params_snapshot

    p = _get_project(session, pid, user)
    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",  # 回填 job.id(占位;非 ComfyUI 作业,tracker reconcile 按空 worker 跳过)
        worker="",
        kind=_PARSE_KIND,
        status="queued",
        prompt=body.premise[:200],
        params=params_snapshot(body, pid=pid),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"parse-{job.id}"
    session.add(job)
    session.commit()
    _asyncio.create_task(_run_script_parse(job.id, p.id, body))
    return {"job_id": job.id, "status": "queued"}


@router.get("/studio/projects/{pid}/script/parse/{job_id}")
def get_script_parse_status(
    pid: str,
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """轮询拆解结果:done → {characters, shots};error → {error};进行中 → {status}。"""
    from app.models import Job

    _get_project(session, pid, user)
    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _PARSE_KIND:
        raise HTTPException(status_code=404, detail="拆解任务不存在")
    out: dict = {"status": job.status}
    if job.status == "done":
        out.update(json.loads(job.result or "{}"))
    elif job.status == "error":
        try:
            out["error"] = json.loads(job.result or "{}").get("error") or "拆解失败"
        except (ValueError, TypeError):
            out["error"] = "拆解失败"
    elif job.status == "canceled":
        out["error"] = "已中止"
    return out


# ── 从图片创建(F3 融合,2026-10-11)──────────────────────────────────────
# 经典 animatic 的 AI 解析模式迁入 v2 域:上传 1-9 张图 → VLM 解析(复用
# drama_image.analyze_storyboard_images,后端零改动)→ 建 StudioProject +
# StudioCharacter + StudioShot。异步 Job(studio_image_parse)+ 轮询,与
# script/parse 同范式;autorun 自动管线不随迁(v2 工作区逐镜渲染/管线 C 即后续),
# 拼接小工具仍走经典 /api/animatic。
_IMAGE_PARSE_KIND = "studio_image_parse"
_FROM_IMG_MIME = {".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp"}
_FROM_IMG_MAX_BYTES = 20 * 1024 * 1024


async def _run_image_parse(
    job_id: str,
    tenant_id: str,
    user_id: str,
    payloads: list[tuple[bytes, str]],
    hint: str,
    style: str,
    num_shots: int,
    width: int,
    height: int,
    fps: int,
) -> None:
    """后台跑 VLM 解析并落 StudioProject/角色/分镜;结果写 Job.result。"""
    import asyncio as _asyncio

    from app.db import engine as _engine
    from app.models import Job
    from app.routes.drama_studio import _coerce_shot
    from app.services.drama_image import analyze_storyboard_images

    def _finish(status: str, result: dict) -> None:
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            if not job or job.status in ("done", "error", "canceled"):
                return
            job.status = status
            job.result = json.dumps(result, ensure_ascii=False)
            s.add(job)
            s.commit()

    try:
        with Session(_engine) as s:
            job0 = s.get(Job, job_id)
            if not job0 or job0.status == "canceled":
                return
            job0.status = "running"
            s.add(job0)
            s.commit()

        obj = await analyze_storyboard_images(payloads, hint, style, num_shots)
        coerced = [_coerce_shot(sc, i) for i, sc in enumerate(obj["shots"][:num_shots])]
        if not any(sc["prompt"] for sc in coerced):
            _finish("error", {"error": "图片解析失败(无有效提示词),请重试"})
            return
        warnings = [str(w) for w in (obj.get("warnings") or [])]

        with Session(_engine) as s:
            p = StudioProject(
                tenant_id=tenant_id,
                user_id=user_id,
                title=obj["title"][:200] or "图片解析项目",
                premise=obj["premise"][:2000],
                style=style.strip()[:300],
                width=width,
                height=height,
                fps=fps,
                status="storyboard",
            )
            s.add(p)
            s.flush()

            # 出场角色自动建档(与 _create_shots_from_analysis 同语义)
            seen: set[str] = set()
            for sc in coerced:
                for cname in sc.get("characters", []):
                    if cname and cname not in seen:
                        seen.add(cname)
                        s.add(StudioCharacter(project_id=p.id, name=cname))
            s.flush()

            for i, sc in enumerate(coerced):
                s.add(StudioShot(
                    project_id=p.id,
                    idx=i,
                    scene=sc["scene"],
                    prompt=sc["prompt"],
                    dialogue=sc["dialogue"],
                    speaker=sc.get("speaker", ""),
                    duration_sec=sc.get("duration_sec", 6),
                    characters=json.dumps(sc.get("characters", []), ensure_ascii=False),
                    seam_to_next=sc.get("seam_to_next", ""),
                    seam_anchor=sc.get("seam_anchor", ""),
                ))
            s.commit()
            s.refresh(p)
            pid = p.id
            title = p.title

        _finish("done", {
            "project_id": pid,
            "title": title,
            "shot_count": len(coerced),
            "character_count": len(seen),
            "warnings": warnings,
        })
    except HTTPException as e:
        _finish("error", {"error": str(e.detail)})
    except Exception as e:  # noqa: BLE001 — 后台任务绝不静默死掉
        logger.exception("image parse job %s 意外失败", job_id)
        _finish("error", {"error": f"图片解析失败:{e}"})


@router.post("/studio/projects/from-image")
async def create_project_from_image_v2(
    images: list[UploadFile] = File(...),
    hint: str = Form(""),
    style: str = Form(""),
    num_shots: int = Form(8),
    width: int = Form(768),
    height: int = Form(1344),
    fps: int = Form(24),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict[str, object]:
    """上传 1-9 张参考图 → VLM 解析 → 建 StudioProject(异步):返回 {job_id,status}。

    校验口径与经典 /drama/projects/from-image 一致(数量 1-9/格式/路径穿越/20MB;
    镜头 4-16;宽 256-1920 高 256-1344 取偶;帧率 4-30);完成后经
    GET /studio/projects/from-image/{job_id} 轮询拿 project_id 跳工作区。
    """
    import asyncio as _asyncio

    from app.models import Job

    enforce_generation_rate_limit(user)
    if not 1 <= len(images) <= 9:
        raise HTTPException(status_code=422, detail="图片数量须为 1-9 张")
    payloads: list[tuple[bytes, str]] = []
    for img in images:
        name = img.filename or ""
        if not name or "/" in name or "\\" in name or ".." in name:
            raise HTTPException(status_code=422, detail="非法文件名(禁止路径穿越)")
        from pathlib import Path as _P

        ext = _P(name).suffix.lower()
        mime = _FROM_IMG_MIME.get(ext)
        if not mime:
            raise HTTPException(
                status_code=422,
                detail=f"不支持的图片格式(仅 {', '.join(sorted(_FROM_IMG_MIME))})",
            )
        data = await img.read()
        if not data:
            raise HTTPException(status_code=422, detail=f"图片为空: {name}")
        if len(data) > _FROM_IMG_MAX_BYTES:
            raise HTTPException(status_code=422, detail=f"图片超过 20MB: {name}")
        payloads.append((data, mime))

    if not 4 <= num_shots <= 16:
        raise HTTPException(status_code=422, detail="镜头数量须为 4-16")
    if not 256 <= width <= 1920 or not 256 <= height <= 1344:
        raise HTTPException(status_code=422, detail="分辨率越界(宽 256-1920,高 256-1344)")
    if not 4 <= fps <= 30:
        raise HTTPException(status_code=422, detail="帧率须为 4-30")
    width -= width % 2
    height -= height % 2

    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",  # 回填 job.id(非 ComfyUI 作业,tracker 按空 worker 跳过)
        worker="",
        kind=_IMAGE_PARSE_KIND,
        status="queued",
        prompt=(hint or "图片解析建项目")[:200],
        params=json.dumps({
            "images": len(payloads), "hint": hint[:200], "style": style[:200],
            "num_shots": num_shots, "width": width, "height": height, "fps": fps,
        }, ensure_ascii=False),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"imgparse-{job.id}"
    session.add(job)
    session.commit()
    _asyncio.create_task(_run_image_parse(
        job.id, user.tenant_id, user.id, payloads,
        hint.strip(), style.strip(), num_shots, width, height, fps,
    ))
    return {"job_id": job.id, "status": "queued"}


@router.get("/studio/projects/from-image/{job_id}")
def get_image_parse_status(
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """轮询图片解析结果:done → {project_id,...};error → {error};进行中 → {status}。"""
    from app.models import Job

    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _IMAGE_PARSE_KIND:
        raise HTTPException(status_code=404, detail="解析任务不存在")
    out: dict = {"status": job.status}
    if job.status == "done":
        out.update(json.loads(job.result or "{}"))
    elif job.status == "error":
        try:
            out["error"] = json.loads(job.result or "{}").get("error") or "解析失败"
        except (ValueError, TypeError):
            out["error"] = "解析失败"
    elif job.status == "canceled":
        out["error"] = "已中止"
    return out


# ── 分镜 AI 扩写(Skill 化剧本优化,2026-08-18)─────────────────────────────


class ShotOptimizeRequest(BaseModel):
    """简短描述 → 结构化分镜字段(镜头/动作/人物/场景)。

    shot_id 可选:传入时以既有分镜为上下文重写(保留台词/角色骨架);
    省略时纯从 brief 扩写(前端用作「追加新分镜」)。
    skill_id 可选:Skill 市场技能(公共/本人导入),其 system_prompt 作为风格
    人格拼在分镜系统提示之前(2026-08-18 与 /api/optimize 三层叠加同构)。
    """

    brief: str = Field(min_length=1, max_length=2000)
    shot_id: str | None = None
    style_hint: str | None = Field(default=None, max_length=500)
    skill_id: str | None = Field(default=None, max_length=64)


_SHOT_OPTIMIZE_SYSTEM = """你是资深影视分镜师与 AI 视频提示词工程师。
用户给出一句简短的中文画面描述,你要把它扩写为可直接用于 AI 图像/视频生成的完整分镜。

要求:
1. scene:中文场景描述——时间、地点、光线氛围、人物位置与动作(2-4 句,具体可视)
2. camera:中文运镜与景别(如「中近景,缓慢推近」「广角俯拍,跟随横移」)
3. prompt:英文生成提示词——主体外观+服装+具体动作+表情+环境细节+光线+构图;
   若提供角色视觉 token,必须原样融入对应角色描述;运动学动词具体(piston/bounce/pan/zoom 等)
4. negative:英文负向提示词(质量类:blurry, low quality, distorted, watermark, text)
5. characters:出场角色名列表(只能从提供的角色表选;未提供角色表则返回 [])

只输出 JSON,不要任何解释:
{"scene": "...", "camera": "...", "prompt": "...", "negative": "...", "characters": ["..."]}"""


@router.post("/studio/projects/{pid}/optimize-shot")
async def optimize_shot_endpoint(
    pid: str,
    body: ShotOptimizeRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """分镜 AI 扩写:简短描述 → {scene, camera, prompt, negative, characters}(不落库,前端回填)。"""
    project = _get_project(session, pid, user)

    # 角色注册表:name + visual_prompt(英文 token)+ 中文描述,注入 LLM 保证人物一致性
    chars = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == pid)
    ).all()
    char_lines = [
        f"- {c.name}: {c.visual_prompt or '(无视觉token)'} | {c.description[:120]}"
        for c in chars
    ] or ["(项目暂无角色,自由设计人物外观)"]

    # 既有分镜上下文:重写模式带原字段(保留台词骨架,动作/场景升维)
    ref_lines: list[str] = []
    if body.shot_id:
        shot = session.get(StudioShot, body.shot_id)
        if shot and shot.project_id == pid:
            ref_lines = [
                f"原场景:{shot.scene or '(空)'}",
                f"原提示词:{shot.prompt or '(空)'}",
                f"原台词:{shot.dialogue or '(无)'}(说话人:{shot.speaker or '无'})",
                f"原时长:{shot.duration_sec}s",
            ]

    user_payload = {
        "项目概要": project.premise[:400],
        "画风": project.style or "不限",
        "额外风格要求": body.style_hint or "无",
        "角色表": char_lines,
        "原分镜(重写模式,空为新写)": ref_lines,
        "简短描述": body.brief,
    }
    from app.harness.ctx import get_ctx

    # Skill 风格人格(与 /api/optimize 三层叠加同构):
    # style_hint(用户指定,最高优先级,已在 user_payload)→ skill.system_prompt → 分镜系统提示
    system_prompt = _SHOT_OPTIMIZE_SYSTEM
    if body.skill_id:
        from app.models import Agent
        from app.nsfw_ctx import nsfw_allowed

        skill = session.get(Agent, body.skill_id)
        if not skill or (skill.user_id and skill.user_id != user.id):
            raise HTTPException(status_code=404, detail="技能不存在")
        if skill.is_nsfw and not nsfw_allowed(user):
            raise HTTPException(status_code=403, detail="该技能需要 R18 鉴权")
        system_prompt = f"{skill.system_prompt}\n\n{_SHOT_OPTIMIZE_SYSTEM}"

    try:
        msg = await get_ctx().service("llm").chat_layered(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": json.dumps(user_payload, ensure_ascii=False)},
            ],
            layer="L3",  # 分镜级质量:结构化输出走精修层(降级链 L3→L2→L1)
            max_tokens=3000,
        )
    except Exception as e:  # noqa: BLE001 —— llm.LLMError 等统一 502
        raise HTTPException(status_code=502, detail=f"LLM 不可用:{e}") from e

    raw = (msg.get("content") or "").strip()
    # 容错抽取:容忍 ```json 围栏与前后噪声(与 storyboard._extract_json 同思路,轻量内联)
    start, end = raw.find("{"), raw.rfind("}")
    obj = None
    if start >= 0 and end > start:
        try:
            obj = json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            obj = None
    if not obj or not str(obj.get("prompt") or "").strip():
        raise HTTPException(status_code=502, detail="LLM 返回不可解析,请重试")

    # 角色名约束:LLM 幻觉出的角色名过滤回库内名(近名纠错,与 parse_script 策略一致)
    known_lower = {c.name.strip().lower(): c.name for c in chars}
    picked: list[str] = []
    for name in obj.get("characters") or []:
        if not isinstance(name, str) or not name.strip():
            continue
        fixed = known_lower.get(name.strip().lower())
        if fixed and fixed not in picked:
            picked.append(fixed)

    return {
        "scene": str(obj.get("scene") or "").strip(),
        "camera": str(obj.get("camera") or "").strip(),
        "prompt": str(obj.get("prompt") or "").strip(),
        "negative": str(obj.get("negative") or "blurry, low quality, text, watermark").strip(),
        "characters": picked,
    }


# ── 渲染编排 ───────────────────────────────────────────────────────────────


def _get_shot(session: Session, sid: str, user: User) -> StudioShot:
    shot = session.get(StudioShot, sid)
    if not shot:
        raise HTTPException(status_code=404, detail="分镜不存在")
    _get_project(session, shot.project_id, user)  # 租户校验
    return shot


def _shot_out(s: StudioShot) -> dict:
    """分镜响应:characters/candidates/ref_images 解析为 list。"""
    try:
        candidates = json.loads(s.candidates_json or "[]")
    except (ValueError, TypeError):
        candidates = []
    try:
        ref_images = json.loads(s.ref_images_json or "[]")
    except (ValueError, TypeError):
        ref_images = []
    data = s.model_dump()
    data.pop("candidates_json", None)
    data.pop("ref_images_json", None)
    data["characters"] = json.loads(s.characters or "[]")
    data["candidates"] = candidates if isinstance(candidates, list) else []
    data["ref_images"] = ref_images if isinstance(ref_images, list) else []
    data.setdefault("video_model", getattr(s, "video_model", None) or "h3")
    from app.services.svml_timeline import parse_beats_json, project_timeline

    data.pop("beats_json", None)
    beats = parse_beats_json(s.beats_json)
    data["beats"] = []
    if beats:
        data.update(project_timeline(beats, total_sec=s.duration_sec))
    return data


class RenderShotBody(BaseModel):
    """Batch6 视频步:引擎 / 管线 C / 多候选 / 多参考(均可选;缺省兼容旧客户端)。"""

    video_model: str = Field(default="h3", max_length=16)
    pipeline: str = Field(default="ref2va", max_length=16)  # ref2va(默认) | c | c_hybrid | legacy
    worker_url: str | None = Field(
        default=None,
        max_length=64,
        description="仅管理员：单次指定 H3 worker（白名单 :8195 / :8264）",
    )
    num_candidates: int = Field(default=2, ge=1, le=4)
    seed: int | None = Field(default=None, ge=0, description="固定种子；同 seed 跨 worker 对比用")
    ref_images: list[str] | None = Field(default=None, max_length=9)
    scene_images: list[str] | None = Field(default=None, max_length=4)
    ref_style: str | None = Field(
        default=None,
        max_length=32,
        description="anime|ancient_realistic；空则按项目画风/唯一分桶推断，多桶并存回落扁平 sample",
    )
    wait: bool = Field(
        default=True,
        description="True=同步等片（默认）；False=登记 Job 后立即返回 job_id，tracker 后台继续",
    )
    # 任务 #24：显式加速档（产品路径默认满血 off）；仅 H3 家族图生效，非 H3 原样提交。
    # 非法值 → 422（h3_accel.validate_acceleration）；wan/qwen 系不经此渲染路径。
    accel: str = Field(default="off", max_length=16)
    # F1：专家旁路关键帧软闸（项目 preferred_drive_mode=keyframe 时仍可单次强制直出）
    force_direct: bool = Field(default=False, description="True=跳过关键帧驱动软闸")

    @field_validator("accel")
    @classmethod
    def _check_accel(cls, v: str) -> str:
        return h3_accel.validate_acceleration(v)

    @field_validator("pipeline")
    @classmethod
    def _check_pipeline(cls, v: str) -> str:
        p = (v or "ref2va").strip().lower() or "ref2va"
        if p not in ("ref2va", "c", "c_hybrid", "legacy"):
            # PydanticCustomError：ctx 不含异常对象，main 的 422 处理器可 JSON 序列化
            raise PydanticCustomError(
                "pipeline_invalid", "pipeline 仅支持 ref2va | c | c_hybrid | legacy"
            )
        return p


class RenderProjectBody(BaseModel):
    """整批渲染请求体(任务 #24)。全部可选;缺省兼容旧客户端(无 body / 空 body)。"""

    # 显式加速档:产品默认满血 off;非法值 → 422(h3_accel.validate_acceleration)。
    accel: str = Field(default="off", max_length=16)
    # Wave P2 / D7-A:整批也可选管线;默认 ref2va(与单镜一致);c/c_hybrid 为专家档。
    pipeline: str = Field(default="ref2va", max_length=16)
    # 待办 #2:默认 wait=true 兼容 canvas 长等({rendered,failed});
    # wait=false → 202+job_id,回写挂 Job 生命周期(断连不杀)。
    wait: bool = Field(
        default=True,
        description="True=HTTP 等整批结束(默认,兼容旧客户端);False=立即 202+job_id,后台继续",
    )

    @field_validator("accel")
    @classmethod
    def _check_accel(cls, v: str) -> str:
        return h3_accel.validate_acceleration(v)

    @field_validator("pipeline")
    @classmethod
    def _check_pipeline(cls, v: str) -> str:
        p = (v or "ref2va").strip().lower() or "ref2va"
        if p not in ("ref2va", "c", "c_hybrid", "legacy"):
            raise PydanticCustomError(
                "pipeline_invalid", "pipeline 仅支持 ref2va | c | c_hybrid | legacy"
            )
        return p


@router.post("/studio/shots/{sid}/render")
async def render_one(
    sid: str,
    body: RenderShotBody | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
):
    """渲染单镜。默认同步等待；body.wait=false 时登记 Job 后立即返回 job_id。

    body 缺省(旧客户端/批量):video_model=h3、num_candidates=1、wait=true。
    视频步 UI 显式传 num_candidates(默认 2)与 ref_images。
    """
    shot = _get_shot(session, sid, user)
    # F1 关键帧驱动软闸：项目默认 keyframe 且本镜无 image_url → 422 + 失败码
    from app.services.studio.keyframe_drive import keyframe_gate_blocks

    _proj = session.get(StudioProject, shot.project_id)
    _drive = getattr(_proj, "preferred_drive_mode", None) if _proj is not None else "keyframe"
    _force = bool(body.force_direct) if body is not None else False
    _blocked = keyframe_gate_blocks(drive_mode=_drive, shot=shot, force_direct=_force)
    if _blocked is not None:
        raise HTTPException(status_code=422, detail=_blocked)
    # 无 body → 单候选(兼容 renderStudioShot 旧调用与批量路径语义)
    vm = (body.video_model if body else None) or "h3"
    n = body.num_candidates if body is not None else 1
    refs = body.ref_images if body is not None else None
    scenes = body.scene_images if body is not None else None
    pipe = (body.pipeline if body is not None else "ref2va") or "ref2va"
    rstyle = body.ref_style if body is not None else None
    fixed_seed = body.seed if body is not None else None
    accel = (body.accel if body is not None else "off") or "off"
    accel_echo: dict = {}
    do_wait = True if body is None else bool(body.wait)
    worker_url = None
    if body is not None and (body.worker_url or "").strip():
        if (getattr(user, "role", "") or "") != "admin":
            raise HTTPException(status_code=403, detail="worker_url 仅管理员可用")
        from app.services.h3 import validate_worker_override

        try:
            worker_url = validate_worker_override(body.worker_url)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
    # V4-3b 质检自动重试:单候选同步路径 qa=fail → 换 seed 重生成(上限 MAX_ATTEMPTS);
    # 多候选/异步路径不重试(选优与 tracker 各有语义)。RenderError 由底部 except 转 502。
    attempt = 0
    while True:
        attempt += 1
        try:
            out_shot = await orchestrator.render_shot(
                session,
                shot,
                request=request,
                video_model=vm,
                num_candidates=n,
                ref_images=refs,
                scene_images=scenes,
                pipeline=pipe,
                ref_style=rstyle,
                seed=fixed_seed,
                worker_url=worker_url,
                accel=accel,
                accel_echo=accel_echo,
                wait=do_wait,
            )
        except RenderError as e:
            raise HTTPException(status_code=502, detail=str(e)) from e
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        if do_wait:
            from app.services.studio.qa_gate import MAX_ATTEMPTS as _QA_MAX, should_retry as _qa_retry

            qa = None
            try:
                _rows = json.loads(out_shot.candidates_json or "[]")
                qa = next(
                    (c.get("qa") for c in _rows
                     if isinstance(c, dict) and c.get("status") == "done" and isinstance(c.get("qa"), dict)),
                    None,
                )
            except (ValueError, TypeError):
                qa = None
            if _qa_retry(qa, attempt) and n == 1:
                import logging as _log

                _log.getLogger(__name__).warning(
                    "qa 重试 shot=%s verdict=%s attempt=%s/%s(换 seed 重生成)",
                    sid, qa.get("verdict"), attempt, _QA_MAX,
                )
                fixed_seed = None  # 换 seed
                continue
            data = _shot_out(out_shot)
            data["acceleration"] = accel
            data["acceleration_applied"] = bool(accel_echo.get("applied"))
            return data
        import json as _json

        db_job_id = ""
        comfy_pid = ""
        try:
            cands = _json.loads(out_shot.candidates_json or "[]")
        except (ValueError, TypeError):
            cands = []
        if isinstance(cands, list):
            for c in cands:
                if isinstance(c, dict) and (c.get("db_job_id") or c.get("job_id")):
                    db_job_id = str(c.get("db_job_id") or "")
                    comfy_pid = str(c.get("job_id") or "")
                    break
        if not db_job_id:
            raise HTTPException(status_code=502, detail="异步渲染未登记到 Job")
        return {
            "job_id": db_job_id,
            "prompt_id": comfy_pid,
            "status": "queued",
            "shot_id": out_shot.id,
            "acceleration": accel,
            "acceleration_applied": bool(accel_echo.get("applied")),
            "shot": _shot_out(out_shot),
        }


@router.post("/studio/shots/{sid}/candidates/{cid}/pick")
def pick_shot_candidate(
    sid: str,
    cid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """选用某个候选视频为当前分镜成片。"""
    shot = _get_shot(session, sid, user)
    try:
        return _shot_out(orchestrator.pick_candidate(session, shot, cid))
    except RenderError as e:
        raise HTTPException(status_code=400, detail=str(e)) from e


_BATCH_KIND = "studio_batch_render"


async def _run_batch_render(job_id: str, pid: str, accel: str, pipeline: str = "ref2va") -> None:
    """整批渲染后台协程:自持 Session,与 HTTP 请求生命周期脱钩(待办 #2)。

    客户端断连只取消等待方,不取消本任务;进度写入 Job.progress / 终态写 result。
    pipeline 默认 ref2va(Wave P2 管线选择器);seam=continue 单镜仍由 orchestrator 内部切 C。
    """
    from app.db import engine as _engine
    from app.models import Job

    done, failed = 0, 0
    applied_any = False

    def _patch(status: str | None = None, *, result: dict | None = None, progress: dict | None = None) -> bool:
        """更新 Job;若已 canceled 返回 False 供上层停跑。"""
        with Session(_engine) as s:
            job = s.get(Job, job_id)
            if not job:
                return False
            if job.status == "canceled":
                return False
            if status:
                job.status = status
            if result is not None:
                job.result = json.dumps(result, ensure_ascii=False)
            if progress is not None:
                job.progress = json.dumps(progress, ensure_ascii=False)
            s.add(job)
            s.commit()
            return True

    try:
        if not _patch("running", progress={"rendered": 0, "failed": 0, "total": 0}):
            return
        with Session(_engine) as s:
            shots = s.exec(
                select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
            ).all()
            pending = [
                sh.id
                for sh in shots
                if (sh.status or "") not in orchestrator.terminal_states()
            ]
        total = len(pending)
        _patch(progress={"rendered": 0, "failed": 0, "total": total})
        for sid in pending:
            with Session(_engine) as s:
                job = s.get(Job, job_id)
                if not job or job.status == "canceled":
                    return
                shot = s.get(StudioShot, sid)
                if shot is None or (shot.status or "") in orchestrator.terminal_states():
                    continue
                accel_echo: dict = {}
                try:
                    # 不传 request:后台无客户端连接;断连无法取消单镜(由 Job.cancel 管)
                    await orchestrator.render_shot(
                        s,
                        shot,
                        request=None,
                        video_model="h3",
                        num_candidates=2,
                        pipeline=pipeline or "ref2va",
                        accel=accel,
                        accel_echo=accel_echo,
                        wait=True,
                    )
                    done += 1
                    applied_any = applied_any or bool(accel_echo.get("applied"))
                except RenderError:
                    failed += 1
            if not _patch(
                progress={
                    "rendered": done,
                    "failed": failed,
                    "total": total,
                    "acceleration_applied": applied_any,
                }
            ):
                return
        _patch(
            "done",
            result={
                "rendered": done,
                "failed": failed,
                "project_id": pid,
                "acceleration": accel,
                "pipeline": pipeline or "ref2va",
                "acceleration_applied": applied_any,
            },
            progress={
                "rendered": done,
                "failed": failed,
                "total": total,
                "acceleration_applied": applied_any,
            },
        )
    except Exception as e:  # noqa: BLE001 — 后台任务绝不静默死掉
        logger.exception("batch render job %s 意外失败", job_id)
        _patch(
            "error",
            result={
                "error": f"整批渲染失败:{e}",
                "rendered": done,
                "failed": failed,
                "project_id": pid,
                "acceleration": accel,
            },
        )


@router.post("/studio/projects/{pid}/render")
async def render_batch(
    pid: str,
    body: RenderProjectBody | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None  # FastAPI 注入;勿标 Optional 否则当 Pydantic 字段,
):
    """批量渲染:跳过已终态分镜;单镜失败不阻塞其余。

    待办 #2:整批改挂 Job + 进程内后台协程——回写不绑 HTTP 请求。
      · wait=false → 202 + job_id(立即返回;轮询 GET .../render/{job_id} 或 /api/jobs/lookup)
      · wait=true(默认) → 后台跑 + HTTP 等到终态,仍回 {rendered,failed}(兼容 canvas);
        客户端断连只取消等待,不杀后台回写。
    """
    import asyncio as _asyncio

    from app.models import Job
    from app.versioning import params_snapshot

    project = _get_project(session, pid, user)
    accel = (body.accel if body is not None else "off") or "off"
    pipe = (body.pipeline if body is not None else "ref2va") or "ref2va"
    do_wait = True if body is None else bool(body.wait)

    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id="",
        worker="",
        kind=_BATCH_KIND,
        status="queued",
        prompt=f"整批渲染 {project.title or pid[:8]}".strip()[:200],
        params=params_snapshot(
            body or RenderProjectBody(),
            project_id=pid,
            accel=accel,
            pipeline=pipe,
        ),
    )
    session.add(job)
    session.commit()
    session.refresh(job)
    job.prompt_id = f"batch-render-{job.id}"
    session.add(job)
    session.commit()

    _asyncio.create_task(_run_batch_render(job.id, pid, accel, pipe))

    if not do_wait:
        return JSONResponse(
            status_code=202,
            content={
                "job_id": job.id,
                "status": "queued",
                "project_id": pid,
                "acceleration": accel,
                "pipeline": pipe,
            },
        )

    # 兼容路径:轮询本 Job 终态(后台在跑;断连 CancelledError 不波及 create_task)
    import asyncio as _aio

    from app.db import engine as _engine

    while True:
        await _aio.sleep(0.05)
        with Session(_engine) as s:
            j = s.get(Job, job.id)
            if j is None:
                raise HTTPException(status_code=500, detail="整批作业丢失")
            if j.status in ("done", "error", "canceled"):
                result: dict = {}
                if j.result:
                    try:
                        result = json.loads(j.result)
                    except (ValueError, TypeError):
                        result = {}
                if j.status == "error" and not result.get("rendered") and result.get("error"):
                    # 整批意外失败仍给计数口径,避免前端崩
                    return {
                        "job_id": job.id,
                        "rendered": int(result.get("rendered") or 0),
                        "failed": int(result.get("failed") or 0),
                        "acceleration": accel,
                        "acceleration_applied": bool(result.get("acceleration_applied")),
                        "error": result.get("error"),
                        "status": j.status,
                    }
                return {
                    "job_id": job.id,
                    "rendered": int(result.get("rendered") or 0),
                    "failed": int(result.get("failed") or 0),
                    "acceleration": result.get("acceleration") or accel,
                    "acceleration_applied": bool(result.get("acceleration_applied")),
                    "status": j.status,
                }


@router.get("/studio/projects/{pid}/render/{job_id}")
def batch_render_status(
    pid: str,
    job_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """轮询整批渲染:queued/running/done/error + rendered/failed 计数。"""
    from app.models import Job

    _get_project(session, pid, user)
    job = session.get(Job, job_id)
    if not job or job.user_id != user.id or job.kind != _BATCH_KIND:
        raise HTTPException(status_code=404, detail="作业不存在")
    # 防串项目:params 快照含 project_id
    try:
        params = json.loads(job.params or "{}")
    except (ValueError, TypeError):
        params = {}
    if params.get("project_id") and params.get("project_id") != pid:
        raise HTTPException(status_code=404, detail="作业不存在")
    out: dict = {"job_id": job.id, "status": job.status, "project_id": pid}
    for blob in (job.progress, job.result):
        if not blob:
            continue
        try:
            data = json.loads(blob)
        except (ValueError, TypeError):
            continue
        if isinstance(data, dict):
            for k in ("rendered", "failed", "total", "acceleration", "acceleration_applied", "error"):
                if k in data:
                    out[k] = data[k]
    return out




# ── 管线 C 异步链（阶段 B / BeefTV；不改 sync render / wait=false 语义）────────


@router.post("/studio/c-chains")
async def create_c_chain_endpoint(
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """新建续写链并开跑；202，job_id=DB Job.id（绝非 Comfy prompt_id）。"""
    import asyncio as _asyncio

    from app.services.studio import c_chain as c_chain_svc

    try:
        parsed = c_chain_svc.CChainCreateBody.model_validate(body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    worker_url = None
    if (parsed.worker_url or "").strip():
        if (getattr(user, "role", "") or "") != "admin":
            raise HTTPException(status_code=403, detail="worker_url 仅管理员可用")
        from app.services.h3 import validate_worker_override

        try:
            worker_url = validate_worker_override(parsed.worker_url)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        out = c_chain_svc.create_c_chain(session, user, parsed, worker_url=worker_url)
    except RenderError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    _asyncio.create_task(c_chain_svc.run_c_chain(out["job_id"]))
    return JSONResponse(status_code=202, content=out)


@router.post("/studio/c-chains/{chain_id}/segments")
async def append_c_chain_segments(
    chain_id: str,
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """向已结束的链追加段；202，job_id=DB Job.id。"""
    import asyncio as _asyncio

    from app.services.studio import c_chain as c_chain_svc

    try:
        parsed = c_chain_svc.CChainAppendBody.model_validate(body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e

    worker_url = None
    if (parsed.worker_url or "").strip():
        if (getattr(user, "role", "") or "") != "admin":
            raise HTTPException(status_code=403, detail="worker_url 仅管理员可用")
        from app.services.h3 import validate_worker_override

        try:
            worker_url = validate_worker_override(parsed.worker_url)
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e

    try:
        out = c_chain_svc.create_append_job(
            session, user, chain_id, parsed, worker_url=worker_url
        )
    except RenderError as e:
        detail = str(e)
        code = 422
        if "不存在" in detail:
            code = 404
        elif "进行中" in detail:
            code = 409
        raise HTTPException(status_code=code, detail=detail) from e

    _asyncio.create_task(c_chain_svc.run_c_chain(out["job_id"]))
    return JSONResponse(status_code=202, content=out)


@router.get("/studio/c-chains/{chain_id}")
def get_c_chain_endpoint(
    chain_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """链详情：段/候选/成片。"""
    from app.services.studio import c_chain as c_chain_svc

    try:
        return c_chain_svc.get_c_chain(session, user, chain_id)
    except RenderError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


@router.post("/studio/c-chains/{chain_id}/segments/{seg_index}/pick")
def pick_c_chain_segment(
    chain_id: str,
    seg_index: int,
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """人工改选链尾段候选。"""
    from app.services.studio import c_chain as c_chain_svc

    try:
        parsed = c_chain_svc.CChainPickBody.model_validate(body)
    except Exception as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    try:
        return c_chain_svc.pick_segment_candidate(
            session, user, chain_id, int(seg_index), parsed.candidate_id
        )
    except RenderError as e:
        detail = str(e)
        code = 400
        if "不存在" in detail:
            code = 404
        elif "进行中" in detail:
            code = 409
        raise HTTPException(status_code=code, detail=detail) from e


@router.get("/studio/projects/{pid}/status")
def project_status(
    pid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """聚合状态:各阶段计数 + next_step(状态重算),供前端轮询与断点续跑。"""
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    next_step = compute_studio_next_step(shots)
    next_step["action"] = next_step["action"].replace("{pid}", pid)
    return {"total": len(shots), "by_status": counts, "next_step": next_step}


# ── 配音 / 对口型(M3)─────────────────────────────────────────────────────


@router.post("/studio/shots/{sid}/voice")
async def voice_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """单镜配音:按说话人命中角色卡(带参考音则克隆音色);状态 rendered → voiced。

    Batch4 边界:
      · 空台词 → 422
      · 有说话人但角色卡不存在 / 未配置音色 → 422(不静默降级默认音糊弄)
      · 无说话人(旁白) → 允许默认音色
      · TTS 不可达 → 502(VoiceError)
    """
    shot = _get_shot(session, sid, user)
    if not shot.dialogue.strip():
        raise HTTPException(status_code=422, detail="该镜无台词")
    character = None
    speaker = (shot.speaker or "").strip()
    if speaker:
        character = session.exec(
            select(StudioCharacter).where(
                StudioCharacter.project_id == shot.project_id,
                StudioCharacter.name == speaker,
            )
        ).first()
        if character is None:
            raise HTTPException(
                status_code=422, detail=f"未找到说话人「{speaker}」的角色卡"
            )
        if not (character.voice_ref_url or "").strip():
            raise HTTPException(
                status_code=422, detail=f"角色「{speaker}」未配置音色"
            )
    try:
        await voice_svc.synth_for_shot(session, shot, character)
    except voice_svc.VoiceError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return _shot_out(shot)


@router.post("/studio/shots/{sid}/lipsync/skip")
async def lipsync_skip(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """跳过对口型(二次确认后调用):mux 配音→成片,标 lipsync_skipped=未对口型。"""
    shot = session.get(StudioShot, sid)
    if not shot:
        raise HTTPException(status_code=404, detail="分镜不存在")
    _get_project(session, shot.project_id, user)
    if (shot.render_mode or "video") == "image_motion":
        raise HTTPException(status_code=422, detail="图像运镜镜无需对口型")
    try:
        await lipsync_svc.skip_lipsync_for_shot(session, shot)
    except lipsync_svc.LipsyncError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    return _shot_out(shot)


@router.post("/studio/shots/{sid}/lipsync")
async def lipsync_one(
    sid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """对口型:仅视频镜(已有视频+配音);LatentSync 产物覆盖 final_clip_url。"""
    shot = _get_shot(session, sid, user)
    if shot.render_mode != "video":
        raise HTTPException(status_code=422, detail="仅视频镜支持对口型")
    if not shot.video_url or not shot.voice_url:
        raise HTTPException(status_code=422, detail="需要先出视频并配音")
    try:
        await lipsync_svc.lipsync_for_shot(session, shot)
    except lipsync_svc.LipsyncError as e:
        raise HTTPException(status_code=502, detail=str(e)) from e
    return _shot_out(shot)




@router.post("/studio/projects/{pid}/bgm")
async def upload_project_bgm(
    pid: str,
    file: UploadFile = File(...),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """F3:上传声床音频到 studio 产出目录，并写入项目 bgm_url。"""
    from app.storage import drama_output_root

    project = _get_project(session, pid, user)
    raw_name = (file.filename or "bgm.mp3").strip()
    ext = Path(raw_name).suffix.lower()
    if ext not in {".mp3", ".wav", ".m4a", ".aac", ".ogg", ".flac"}:
        raise HTTPException(status_code=422, detail="声床仅支持 mp3/wav/m4a/aac/ogg/flac")
    content = await file.read()
    if not content or len(content) < 32:
        raise HTTPException(status_code=422, detail="声床文件为空")
    if len(content) > 40 * 1024 * 1024:
        raise HTTPException(status_code=422, detail="声床文件过大（上限 40MB）")
    out_dir = drama_output_root() / "studio"
    out_dir.mkdir(parents=True, exist_ok=True)
    dest = out_dir / f"bgm-{uuid.uuid4().hex}{ext}"
    dest.write_bytes(content)
    url = f"/api/studio/files/{dest.name}"
    project.bgm_url = url
    session.add(project)
    session.commit()
    session.refresh(project)
    return {"bgm_url": url, "project": _project_out(project)}


# ── 合成(M3)───────────────────────────────────────────────────────────────


@router.post("/studio/projects/{pid}/assemble")
async def assemble_project_endpoint(
    pid: str,
    body: AssembleOptions | None = Body(default=None),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """拼接全部就绪分镜 → 项目成片;任一镜缺 final_clip_url → 422。

    F3:可选 body 覆盖声床；成功/失败写北向 KPI episode_assembled。
    """
    project = _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    opts = body or AssembleOptions()
    ok = False
    err_msg = ""
    try:
        await assemble_svc.assemble_project(
            session,
            project,
            shots,
            bgm_url=opts.bgm_url,
            bgm_volume=opts.bgm_volume,
            bgm_duck=opts.bgm_duck,
        )
        ok = True
    except assemble_svc.AssembleError as e:
        err_msg = str(e)
        code = 422 if "未就绪" in err_msg or "无分镜" in err_msg or "白名单" in err_msg else 502
        try:
            from app.services import product_kpi as _kpi
            _kpi.record_event(
                session,
                tenant_id=user.tenant_id,
                user_id=user.id,
                project_id=pid,
                event_type="episode_assembled",
                payload={"success": False, "surface": "drama_workspace", "error": err_msg[:200]},
            )
        except Exception:  # noqa: BLE001 — KPI 失败不挡业务
            logger.warning("kpi episode_assembled(fail) 记录失败 pid=%s", pid[:12])
        raise HTTPException(status_code=code, detail=err_msg) from e
    try:
        from app.services import product_kpi as _kpi
        _kpi.record_event(
            session,
            tenant_id=user.tenant_id,
            user_id=user.id,
            project_id=pid,
            event_type="episode_assembled",
            payload={"success": True, "surface": "drama_workspace"},
        )
    except Exception:  # noqa: BLE001
        logger.warning("kpi episode_assembled(ok) 记录失败 pid=%s", pid[:12])
    return _project_detail(session, project)



# ── Batch5:样片种子 + 步骤整组重跑 ─────────────────────────────────────────

SAMPLE_RAIN_NIGHT_TITLE = "雨夜便利店·林夏"
SAMPLE_RAIN_NIGHT_MARKER = "[sample:rain-night]"
SAMPLE_RAIN_NIGHT_PREMISE = (
    f"{SAMPLE_RAIN_NIGHT_MARKER} 雨夜便利店短剧样片。"
    "林夏进店→冷柜→结账→出门四拍；竖屏 9:16 768p。"
)

# 四拍与 H3 长视频实验剧本对齐(对白含验收句)
_SAMPLE_SHOTS = [
    {
        "scene": "雨夜便利店门口·进店",
        "prompt": (
            "vertical 9:16 short drama, rainy night convenience store, young woman Lin Xia "
            "pushes glass door, shakes water off umbrella, looks at clerk"
        ),
        "dialogue": "还营业吧？",
        "speaker": "林夏",
        "camera": "跟拍推进",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "便利店冷柜·货架",
        "prompt": (
            "same rainy night convenience store aisle, Lin Xia walks to fridge, "
            "picks a bottle of water, soft cold white light"
        ),
        "dialogue": "加班到现在…就这一瓶。",
        "speaker": "林夏",
        "camera": "手部特写到脸",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "收银台·结账",
        "prompt": (
            "convenience store checkout, Lin Xia puts water bottle on counter, "
            "asks clerk about WeChat pay"
        ),
        "dialogue": "微信可以吗？",
        "speaker": "林夏",
        "camera": "过肩",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
    {
        "scene": "便利店门口·出门",
        "prompt": (
            "Lin Xia with plastic bag pushes door open, looks back into store, "
            "then walks into heavier rain on neon street"
        ),
        "dialogue": "外面雨更大了。",
        "speaker": "林夏",
        "camera": "后退跟拍",
        "duration_sec": 15,
        "characters": ["林夏"],
    },
]

_LINXIA_DESC = (
    "年轻女人林夏，黑色冲锋衣，湿发贴额，神情克制；雨夜便利店冷白灯。"
)
_LINXIA_VISUAL = (
    "young East Asian woman Lin Xia, black windbreaker, wet hair on forehead, "
    "restrained expression, rainy night convenience store cold white light"
)


def _sample_asset_candidates() -> list[Path]:
    """样片素材搜索路径:优先 H3 实验资产,其次本地 uploads/assets。"""
    from app.storage import drama_output_root

    roots = [
        Path("/home/merlin/toiv/tmp/h3_long_exp/assets"),
        Path(__file__).resolve().parents[4] / "tmp" / "h3_long_exp" / "assets",
        drama_output_root() / "sample_assets",
        Path("/home/merlin/toiv/uploads/assets"),
    ]
    # 去重保序
    seen: set[str] = set()
    out: list[Path] = []
    for r in roots:
        key = str(r)
        if key in seen:
            continue
        seen.add(key)
        out.append(r)
    return out


def _stage_sample_image(src_name: str, dest_name: str) -> str | None:
    """复制样片图到 studio 产出目录,返回 /api/studio/files URL;不可用则 None。

    若目标已在 studio 落盘（如先前手工/脚本放入的每镜场景图），直接复用。
    """
    import shutil
    from app.storage import drama_output_root

    dest_dir = drama_output_root() / "studio"
    dest_dir.mkdir(parents=True, exist_ok=True)
    dest = dest_dir / dest_name
    # 已落盘目标优先（雨夜每镜 scene_shotN_*.png）
    if dest.is_file() and dest.stat().st_size > 0:
        return f"/api/studio/files/{dest_name}"
    src: Path | None = None
    for root in _sample_asset_candidates():
        for cand_name in (src_name, dest_name):
            cand = root / cand_name
            if cand.is_file():
                src = cand
                break
        if src is not None:
            break
    if src is None:
        return None
    if not dest.is_file() or dest.stat().st_size != src.stat().st_size:
        shutil.copy2(src, dest)
    return f"/api/studio/files/{dest_name}"


def _find_sample_rain_night(session: Session, user: User) -> StudioProject | None:
    rows = session.exec(
        select(StudioProject).where(
            StudioProject.tenant_id == user.tenant_id,
            StudioProject.user_id == user.id,
        )
    ).all()
    for p in rows:
        if SAMPLE_RAIN_NIGHT_MARKER in (p.premise or ""):
            return p
        if (p.title or "").strip() == SAMPLE_RAIN_NIGHT_TITLE:
            return p
    return None


def _studio_pipeline_brief(session: Session, pid: str) -> dict:
    """项目级管线摘要(供样片返回/列表进度点)。"""
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid)
    ).all()
    next_step = compute_studio_next_step(shots)
    counts: dict[str, int] = {}
    for s in shots:
        counts[s.status] = counts.get(s.status, 0) + 1
    return {
        "total_shots": len(shots),
        "by_status": counts,
        "next_step": next_step,
    }


@router.post("/studio/sample-projects/rain-night")
def seed_rain_night_sample(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """幂等种子:创建/更新固定样片「雨夜便利店·林夏」。

    - 重复调用不堆第二个项目(按 premise marker / 标题命中)
    - 三视图/场景图可得则绑定 URL;不可用仍建角色卡并标 assets_ready=false
    - 返回 project id + pipeline status
    """
    front = _stage_sample_image("linxia_front.png", "sample_linxia_front.png")
    side = _stage_sample_image("linxia_side.png", "sample_linxia_side.png")
    full = _stage_sample_image("linxia_full.png", "sample_linxia_full.png")
    scene = _stage_sample_image("scene_rain_store.png", "sample_scene_rain_store.png")
    # 每镜场景参考（门外/货架/收银台/出门）；素材缺失时回落样片门外图
    shot_scenes = [
        _stage_sample_image("scene_shot0_door.png", "scene_shot0_door.png")
        or _stage_sample_image("scene_rain_store.png", "scene_shot0_door.png"),
        _stage_sample_image("scene_shot1_aisle.png", "scene_shot1_aisle.png")
        or scene,
        _stage_sample_image("scene_shot2_checkout.png", "scene_shot2_checkout.png")
        or scene,
        _stage_sample_image("scene_shot3_exit.png", "scene_shot3_exit.png")
        or scene,
    ]
    refs = [u for u in (front, side, full) if u]
    scenes_bound = [u for u in shot_scenes if u]
    if not scenes_bound and scene:
        scenes_bound = [scene]
    assets_ready = len(refs) >= 3 and bool(scenes_bound)
    asset_notes: list[str] = []
    if len(refs) < 3:
        asset_notes.append("角色三视图未齐(素材不可用)")
    if not scenes_bound:
        asset_notes.append("场景图不可用")
    elif len(scenes_bound) < 4:
        asset_notes.append(f"场景图仅 {len(scenes_bound)}/4 镜（缺镜将回落）")

    existing = _find_sample_rain_night(session, user)
    created = existing is None
    if existing is None:
        p = StudioProject(
            tenant_id=user.tenant_id,
            user_id=user.id,
            title=SAMPLE_RAIN_NIGHT_TITLE,
            premise=SAMPLE_RAIN_NIGHT_PREMISE,
            style="雨夜便利店冷白灯/霓虹积水，竖屏 9:16",
            render_mode_default="video",
            width=768,
            height=1344,
            fps=24,
            status="storyboard",
        )
        session.add(p)
        session.commit()
        session.refresh(p)
    else:
        p = existing
        p.title = SAMPLE_RAIN_NIGHT_TITLE
        p.premise = SAMPLE_RAIN_NIGHT_PREMISE
        p.style = "雨夜便利店冷白灯/霓虹积水，竖屏 9:16"
        p.width = 768
        p.height = 1344
        p.fps = 24
        if p.status in ("draft", ""):
            p.status = "storyboard"
        session.add(p)
        session.commit()
        session.refresh(p)

    # 场景图：按镜序绑定（门外/货架/收银台/出门），渲染时按 idx 取一张
    scenes = scenes_bound
    p.scene_images_json = json.dumps(scenes, ensure_ascii=False)
    session.add(p)

    # 角色:林夏(幂等按名)
    char = session.exec(
        select(StudioCharacter).where(
            StudioCharacter.project_id == p.id,
            StudioCharacter.name == "林夏",
        )
    ).first()
    if char is None:
        char = StudioCharacter(project_id=p.id, name="林夏")
    char.description = _LINXIA_DESC
    char.visual_prompt = _LINXIA_VISUAL
    char.reference_images = json.dumps(refs, ensure_ascii=False)
    session.add(char)

    # 分镜:固定 4 镜全量替换(样片契约;保留已有媒体若镜数/对白一致则尽量按 idx 复用 id)
    old_shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == p.id).order_by(StudioShot.idx)
    ).all()
    by_idx = {s.idx: s for s in old_shots}
    keep_ids: set[str] = set()
    for i, spec in enumerate(_SAMPLE_SHOTS):
        shot = by_idx.get(i)
        if shot is None:
            shot = StudioShot(project_id=p.id)
        shot.idx = i
        shot.scene = spec["scene"]
        shot.prompt = spec["prompt"]
        shot.dialogue = spec["dialogue"]
        shot.speaker = spec["speaker"]
        shot.camera = spec["camera"]
        shot.duration_sec = int(spec["duration_sec"])
        shot.characters = json.dumps(spec["characters"], ensure_ascii=False)
        shot.render_mode = "video"
        shot.video_model = "h3"
        if shot.status in ("", None):
            shot.status = "draft"
        session.add(shot)
        session.flush()
        keep_ids.add(shot.id)
    for s in old_shots:
        if s.id not in keep_ids:
            session.delete(s)

    session.commit()
    session.refresh(p)
    pipeline = _studio_pipeline_brief(session, p.id)
    detail = _project_detail(session, p)
    return {
        "id": p.id,
        "title": p.title,
        "created": created,
        "assets_ready": assets_ready,
        "asset_notes": asset_notes,
        "reference_images": refs,
        "scene_images": scenes,
        "pipeline": pipeline,
        "project": detail,
    }


@router.post("/studio/projects/{pid}/steps/{step}/rerun")
async def step_group_rerun(
    pid: str,
    step: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    request: Request = None,
):
    """步骤整组重跑:对当前步未完成或失败镜头批量触发,错误写入 errors 不静默吞。

    step ∈ video | voice | lipsync | storyboard
      · video/storyboard: draft/error/queued/rendering 以外的未达 rendered+ 镜
      · voice: 有台词且未 voiced+ 的镜(需已出视频;否则记入 errors)
      · lipsync: 未 lipsynced+ 且具备视频+配音的镜
    """
    step = (step or "").strip().lower()
    if step not in {"video", "voice", "lipsync", "storyboard"}:
        raise HTTPException(
            status_code=422, detail="step 须为 video|voice|lipsync|storyboard"
        )
    _get_project(session, pid, user)
    shots = session.exec(
        select(StudioShot).where(StudioShot.project_id == pid).order_by(StudioShot.idx)
    ).all()
    if not shots:
        raise HTTPException(status_code=422, detail="无分镜可重跑")

    rendered_ok = {"rendered", "voiced", "lipsynced", "done"}
    voiced_ok = {"voiced", "lipsynced", "done"}
    lipsync_ok = {"lipsynced", "done"}

    targets: list[StudioShot] = []
    if step in ("video", "storyboard"):
        # 未达 rendered+ 的镜(含 draft/error/queued/rendering)
        targets = [s for s in shots if s.status not in rendered_ok]
    elif step == "voice":
        targets = [
            s
            for s in shots
            if (s.dialogue or "").strip() and s.status not in voiced_ok
        ]
    else:  # lipsync
        targets = [s for s in shots if s.status not in lipsync_ok]

    attempted = 0
    ok = 0
    failed = 0
    errors: list[dict] = []

    for shot in targets:
        if request is not None and await request.is_disconnected():
            break
        attempted += 1
        try:
            if step in ("video", "storyboard"):
                await orchestrator.render_shot(
                    session,
                    shot,
                    request=request,
                    video_model="h3",
                    num_candidates=2,
                    pipeline="ref2va",
                )
            elif step == "voice":
                if not (shot.dialogue or "").strip():
                    raise ValueError("该镜无台词")
                if shot.status not in rendered_ok and not shot.video_url:
                    raise ValueError("需要先出视频")
                character = None
                speaker = (shot.speaker or "").strip()
                if speaker:
                    character = session.exec(
                        select(StudioCharacter).where(
                            StudioCharacter.project_id == shot.project_id,
                            StudioCharacter.name == speaker,
                        )
                    ).first()
                    if character is None:
                        raise ValueError(f"未找到说话人「{speaker}」的角色卡")
                    if not (character.voice_ref_url or "").strip():
                        raise ValueError(f"角色「{speaker}」未配置音色")
                await voice_svc.synth_for_shot(session, shot, character)
            else:
                if shot.render_mode != "video":
                    raise ValueError("仅视频镜支持对口型")
                if not shot.video_url or not shot.voice_url:
                    raise ValueError("需要先出视频并配音")
                await lipsync_svc.lipsync_for_shot(session, shot)
            ok += 1
        except Exception as e:  # noqa: BLE001 — 整组聚合错误,不中断其余镜
            failed += 1
            errors.append(
                {
                    "shot_id": shot.id,
                    "idx": shot.idx,
                    "detail": str(e)[:240],
                }
            )

    pipeline = _studio_pipeline_brief(session, pid)
    return {
        "step": step,
        "attempted": attempted,
        "ok": ok,
        "failed": failed,
        "errors": errors,
        "pipeline": pipeline,
    }



# ── 产出文件服务 ───────────────────────────────────────────────────────────

_MEDIA_TYPES = {
    ".mp4": "video/mp4",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".wav": "audio/wav",
}


@router.get("/studio/files/{name}", response_model=None)
def studio_file(
    name: str,
    sig: str = "",
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> FileResponse:
    """Studio 产出静图/片段/配音文件(渲染器落盘目录,NAS 优先降级本地)。

    路径穿越防护:仅允许纯文件名(拒绝任何含路径分隔的输入)。
    P-1 归属:签名(sig)即能力,或 DB 归属回退;他人统一 404。
    """
    from app.storage import drama_output_root
    from app.services.studio_file_access import assert_studio_file_access

    safe = Path(name).name
    if not safe or safe != name:
        raise HTTPException(status_code=400, detail="非法文件名")
    path = drama_output_root() / "studio" / safe
    if not path.is_file():
        raise HTTPException(status_code=404, detail="文件不存在")
    assert_studio_file_access(session, user, safe, sig=sig)
    return FileResponse(
        path, media_type=_MEDIA_TYPES.get(path.suffix.lower(), "application/octet-stream")
    )
