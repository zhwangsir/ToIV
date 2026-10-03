"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。

已有入选片时(video_url/final_clip_url 或 is_picked 候选,或 status 已是
rendered/voiced/lipsynced/done 且有视频):重试失败只追加候选失败记录,
不得把镜次 status 打成 error、不得清除入选 URL。
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, select

from app.harness import events as ev
from app.models import StudioCharacter, StudioProject, StudioShot
from app.services.studio.renderers.base import RenderError, get_renderer
from app.services.studio.candidates_json import (
    append_failure as _append_candidate_failures_helper,
    dumps_candidates,
    loads_candidates,
)
import asyncio

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

# 已具备最终媒体的状态:批量渲染跳过
_TERMINAL_SKIP = {"rendered", "voiced", "lipsynced", "done"}


def terminal_states() -> set[str]:
    """批量渲染跳过的状态集合(副本,防调用方改内部常量)。"""
    return set(_TERMINAL_SKIP)


def _prior_has_selected_media(
    *,
    prior_status: str,
    prior_video_url: str,
    prior_final_clip_url: str,
    prior_candidates_json: str,
) -> bool:
    """重试前是否已有可保留的入选片。"""
    url = (prior_video_url or prior_final_clip_url or "").strip()
    if url:
        return True
    rows = loads_candidates(prior_candidates_json)
    for c in rows:
        if (
            isinstance(c, dict)
            and c.get("is_picked")
            and c.get("status") == "done"
            and str(c.get("url") or "").strip()
        ):
            return True
    # voiced/lipsynced 且有 video_url 已在上方 url 分支覆盖
    _ = prior_status
    return False


def _append_candidate_failures(
    prior_candidates_json: str,
    attempt: list[dict[str, Any]],
    *,
    err_msg: str,
    video_model: str,
) -> str:
    """把本轮失败候选追加到已有 candidates,不覆盖入选项（VARCHAR JSON 字符串）。"""
    return _append_candidate_failures_helper(
        prior_candidates_json,
        err_msg=err_msg,
        video_model=video_model,
        attempt=attempt,
    )



def _cast_for(session: Session, shot: StudioShot) -> list[StudioCharacter]:
    """按 shot.characters(角色名 JSON)取角色卡。"""
    names = set(json.loads(shot.characters or "[]"))
    if not names:
        return []
    rows = session.exec(
        select(StudioCharacter).where(StudioCharacter.project_id == shot.project_id)
    ).all()
    return [c for c in rows if c.name in names]


async def render_shot(
    session: Session, shot: StudioShot, pool: "WorkerPool | None" = None,
    request: Any = None,
    *,
    video_model: str | None = None,
    num_candidates: int = 1,
    ref_images: list[str] | None = None,
    scene_images: list[str] | None = None,
    pipeline: str | None = None,
    context_latent_path: str | None = None,
    auto_pick: bool = True,
    ref_style: str | None = None,
    seed: int | None = None,
) -> StudioShot:
    """渲染单镜:按 render_mode 分发;状态与媒体 URL 落库。

    Batch6 视频步(默认管线 C):
      · video_model 默认 h3;pipeline 默认 c(Motion Context+Ref2VA+原生音频);
      · num_candidates>1 时串行多 seed,按裁脸相似度+无烧录字幕选优;
      · 同项目上一镜的 context_latent 自动续写(也可显式传入)。
    """
    import random
    import uuid

    if pool is None:
        from app.deps import get_pool

        pool = get_pool()
    # 快照入选态:重试失败时用于恢复,避免把 voiced/lipsynced 覆盖成 error
    prior_status = (shot.status or "").strip() or "draft"
    prior_video_url = shot.video_url or ""
    prior_final_clip_url = shot.final_clip_url or ""
    prior_candidates_json = shot.candidates_json or "[]"
    prior_error = shot.error or ""
    preserve_selected = _prior_has_selected_media(
        prior_status=prior_status,
        prior_video_url=prior_video_url,
        prior_final_clip_url=prior_final_clip_url,
        prior_candidates_json=prior_candidates_json,
    )
    shot.status = "rendering"
    shot.error = ""
    session.add(shot)
    session.commit()
    # 项目级产出规格 + 出图底模注入渲染器(此前 ckpt_name 定义了却从未下发,图像运镜链恒走默认底模)
    project = session.get(StudioProject, shot.project_id)
    render_kw: dict[str, Any] = {}
    if project is not None:
        render_kw = {
            "ckpt_name": project.ckpt_name,
            "width": project.width,
            "height": project.height,
            "fps": project.fps,
        }
    engine = (video_model or getattr(shot, "video_model", "") or "h3").strip() or "h3"
    if engine not in ("h3", "ltx"):
        engine = "h3"
    shot.video_model = engine
    n = max(1, min(4, int(num_candidates or 1)))
    cast = _cast_for(session, shot)
    # 多参考:显式列表优先;否则从角色三视图(+场景)自动收集,并落库供 UI 回显
    from app.services.studio.shot_refs import (
        collect_cast_ref_images,
        ref_urls,
        resolve_ref_style,
        resolve_scene_images_for_shot,
    )

    # 场景参考：显式 > 项目列表按镜 idx 解析（≥2 张时每镜一张）
    if scene_images is None and project is not None:
        try:
            scene_images = json.loads(getattr(project, "scene_images_json", None) or "[]")
        except (ValueError, TypeError):
            scene_images = []
        if not isinstance(scene_images, list):
            scene_images = []
    if scene_images is not None:
        scene_images = resolve_scene_images_for_shot(
            scene_images, getattr(shot, "idx", 0) or 0
        )
        render_kw["scene_images"] = scene_images

    sheet_style = resolve_ref_style(
        ref_style,
        project_style=getattr(project, "style", None) if project is not None else None,
        cast=cast,
    )
    if sheet_style:
        render_kw["ref_style"] = sheet_style

    if ref_images is not None:
        resolved_refs = [u for u in ref_images if isinstance(u, str) and u.strip()]
        # 显式列表:渲染器按该序编号(标签简化为参考图N)
        render_kw["ref_images"] = resolved_refs
    else:
        resolved_refs = ref_urls(
            collect_cast_ref_images(
                cast, scene_images=scene_images, style=sheet_style
            )
        )
        # 自动收集:留给渲染器从 cast 重建带角色名的 @图片N 标签
    shot.ref_images_json = json.dumps(resolved_refs, ensure_ascii=False)
    if request is not None:
        render_kw["request"] = request
    render_kw["video_model"] = engine
    pipe = (pipeline or "c").strip().lower() if engine == "h3" else "legacy"
    if pipe not in ("c", "legacy"):
        pipe = "c"
    render_kw["pipeline"] = pipe
    # 续写：显式 context > 同项目上一镜 picked 的 context_latent
    ctx = (context_latent_path or "").strip()
    if not ctx and pipe == "c" and shot.render_mode == "video":
        siblings = session.exec(
            select(StudioShot).where(StudioShot.project_id == shot.project_id)
        ).all()
        prev = None
        for s in siblings:
            if s.idx < shot.idx and (prev is None or s.idx > prev.idx):
                prev = s
        if prev is not None:
            try:
                prev_cands = json.loads(prev.candidates_json or "[]")
            except (ValueError, TypeError):
                prev_cands = []
            if isinstance(prev_cands, list):
                for c in prev_cands:
                    if isinstance(c, dict) and c.get("is_picked") and c.get("context_latent"):
                        ctx = str(c["context_latent"])
                        break
    if ctx:
        render_kw["context_latent_path"] = ctx
    render_kw["clip_index"] = int(getattr(shot, "idx", 0) or 0) + 1
    renderer = get_renderer(shot)
    # 提交渲染前读侧写入(video_model/ref_images)，结束事务后再 await。
    # 否则 SQLAlchemy 隐式事务会在长轮询期间 idle in transaction 锁住镜次行。
    session.add(shot)
    session.commit()

    async def _once(seed_arg: int | None = None) -> Any:
        kw = dict(render_kw)
        if seed_arg is not None:
            kw["seed"] = seed_arg
        return await renderer.render(shot, cast, pool, **kw)

    candidates: list[dict[str, Any]] = []
    try:
        if shot.render_mode != "video" or n <= 1:
            result = await _once(seed)
            candidates = []
        else:
            # 多候选:不同 seed 串行提交(不并行,避免打爆 H3 单实例队列)
            if seed is not None:
                seeds = [int(seed) + i for i in range(n)]
            else:
                seeds = [random.randint(0, 2**31 - 1) for _ in range(n)]
            candidates = []
            result = None
            first_err: Exception | None = None
            for seed in seeds:
                cid = uuid.uuid4().hex
                entry: dict[str, Any] = {
                    "id": cid,
                    "url": "",
                    "seed": seed,
                    "status": "generating",
                    "is_picked": False,
                    "error": "",
                    "video_model": engine,
                }
                try:
                    r = await _once(seed)
                    entry["url"] = r.url
                    entry["status"] = "done"
                    meta = getattr(r, "pipeline_meta", None) or {}
                    if isinstance(meta, dict):
                        if meta.get("context_latent"):
                            entry["context_latent"] = meta["context_latent"]
                        if meta.get("pipeline"):
                            entry["pipeline"] = meta["pipeline"]
                        if meta.get("prompt"):
                            entry["prompt"] = str(meta["prompt"])[:500]
                    if result is None:
                        result = r
                        entry["is_picked"] = True
                except RenderError as e:
                    entry["status"] = "error"
                    entry["error"] = str(e)[:200]
                    if first_err is None:
                        first_err = e
                candidates.append(entry)
            if result is None:
                raise first_err or RenderError("全部候选生成失败")
            # Batch6：裁脸选优（可关）；失败标 shot 失败，禁止静默回落
            if auto_pick and len(candidates) > 1:
                from app.services.studio.candidate_pick import (
                    CandidatePickError,
                    pick_best_candidate,
                )
                from app.storage import drama_output_root

                ref_path = None
                for c in cast:
                    urls = []
                    try:
                        urls = json.loads(getattr(c, "reference_images", None) or "[]")
                    except (ValueError, TypeError):
                        urls = []
                    if urls:
                        u = str(urls[0])
                        marker = "/api/studio/files/"
                        if marker in u:
                            name = u.split(marker, 1)[1].split("?", 1)[0]
                            candp = drama_output_root() / "studio" / name
                            if candp.is_file():
                                ref_path = candp
                                break

                def _resolve_vid(url: str):
                    marker = "/api/studio/files/"
                    if marker in url:
                        name = url.split(marker, 1)[1].split("?", 1)[0]
                        p = drama_output_root() / "studio" / name
                        return str(p) if p.is_file() else None
                    return None

                # 上一镜成片 / 场景参考：抑制候选场景回退（雨夜镜2 曾出现）
                prev_video_path = None
                siblings = session.exec(
                    select(StudioShot).where(StudioShot.project_id == shot.project_id)
                ).all()
                prev_shot = None
                for s in siblings:
                    if s.idx < shot.idx and (prev_shot is None or s.idx > prev_shot.idx):
                        prev_shot = s
                if prev_shot is not None:
                    prev_url = (prev_shot.video_url or "").strip()
                    if not prev_url:
                        try:
                            pc = json.loads(prev_shot.candidates_json or "[]")
                        except (ValueError, TypeError):
                            pc = []
                        for c in pc if isinstance(pc, list) else []:
                            if isinstance(c, dict) and c.get("is_picked") and c.get("url"):
                                prev_url = str(c["url"])
                                break
                    if prev_url:
                        prev_video_path = _resolve_vid(prev_url)

                scene_ref_path = None
                for u in (scene_images or []) if isinstance(scene_images, list) else []:
                    if isinstance(u, str) and u.strip():
                        sp = _resolve_vid(u.strip())
                        if sp:
                            scene_ref_path = sp
                            break
                        marker = "/api/studio/files/"
                        if marker in u:
                            name = u.split(marker, 1)[1].split("?", 1)[0]
                            candp = drama_output_root() / "studio" / name
                            if candp.is_file():
                                scene_ref_path = str(candp)
                                break

                # 镜0 成片作为回退锚点：扣「与开场过像」的候选（雨夜镜2 门外回退）
                regression_ref_path = None
                if shot.idx > 0:
                    shot0 = None
                    for s in siblings:
                        if s.idx == 0:
                            shot0 = s
                            break
                    if shot0 is not None:
                        s0_url = (shot0.video_url or "").strip()
                        if not s0_url:
                            try:
                                s0c = json.loads(shot0.candidates_json or "[]")
                            except (ValueError, TypeError):
                                s0c = []
                            for c in s0c if isinstance(s0c, list) else []:
                                if isinstance(c, dict) and c.get("is_picked") and c.get("url"):
                                    s0_url = str(c["url"])
                                    break
                        if s0_url:
                            regression_ref_path = _resolve_vid(s0_url)

                # insightface/cv2 同步且重：单 worker 下会堵死事件循环（雨夜镜1 API 挂死）
                try:
                    win_id, candidates = await asyncio.to_thread(
                        pick_best_candidate,
                        candidates,
                        ref_image_path=ref_path,
                        local_url_resolver=_resolve_vid,
                        prev_video_path=prev_video_path,
                        scene_ref_path=scene_ref_path,
                        regression_ref_path=regression_ref_path,
                    )
                except CandidatePickError as e:
                    # 候选已出片但选优失败：先写入 candidates；外层按是否已有入选决定 error 或保留
                    shot.candidates_json = dumps_candidates(candidates)
                    raise RenderError(str(e)) from e
                if win_id:
                    for c in candidates:
                        if c.get("id") == win_id and c.get("url"):
                            # 构造轻量 result 替换
                            class _R:
                                kind = "video"
                                url = c["url"]
                                pipeline_meta = {
                                    "context_latent": c.get("context_latent"),
                                    "pipeline": c.get("pipeline") or pipe,
                                }
                            result = _R()
                            break
    except RenderError as e:
        if preserve_selected:
            # 已有入选片:失败只记候选,恢复镜次 status/URL,绝不打成 error
            restore_status = prior_status
            if restore_status not in ("rendered", "voiced", "lipsynced", "done"):
                restore_status = "rendered"
            shot.status = restore_status
            shot.video_url = prior_video_url
            shot.final_clip_url = prior_final_clip_url
            shot.error = prior_error
            shot.candidates_json = _append_candidate_failures(
                prior_candidates_json,
                candidates,
                err_msg=str(e),
                video_model=engine,
            )
            session.add(shot)
            session.commit()
            logger.warning(
                "render_shot 重试失败但保留入选片: shot=%s status=%s err=%s",
                shot.id,
                restore_status,
                str(e)[:160],
            )
            raise
        shot.status = "error"
        shot.error = str(e)
        # 无入选时若本轮已有候选失败列表,一并落库供 UI 标红
        if candidates:
            shot.candidates_json = dumps_candidates(candidates)
        session.add(shot)
        session.commit()
        raise

    if result.kind == "image":
        shot.image_url = result.url
        try:
            from app.harness.ctx import get_ctx

            await get_ctx().events.emit(
                ev.QUALITY_ADVISORY,
                {"image_url": result.url, "prompt": shot.prompt, "shot_id": shot.id},
            )
        except Exception:
            logger.debug("render_shot 质量门事件发射异常(降级忽略):shot=%s", shot.id, exc_info=True)
    else:
        shot.video_url = result.url
        shot.final_clip_url = result.url
    if candidates:
        shot.candidates_json = dumps_candidates(candidates)
    elif n <= 1 and shot.render_mode == "video":
        # 单候选也写一条,便于 UI 统一展示
        meta = getattr(result, "pipeline_meta", None) or {}
        shot.candidates_json = dumps_candidates(
            [
                {
                    "id": uuid.uuid4().hex,
                    "url": result.url if result.kind == "video" else "",
                    "seed": int((meta.get("seed") if isinstance(meta, dict) else None) or seed or 0),
                    "status": "done",
                    "is_picked": True,
                    "error": "",
                    "video_model": engine,
                    "pipeline": ((meta.get("pipeline") if isinstance(meta, dict) else None) or (pipe if engine == "h3" else "")),
                    "context_latent": (meta.get("context_latent") if isinstance(meta, dict) else "") or "",
                }
            ]
        )
    shot.status = "rendered"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot


def pick_candidate(session: Session, shot: StudioShot, candidate_id: str) -> StudioShot:
    """将指定候选标为采用,回写 video_url/final_clip_url。"""
    rows = loads_candidates(shot.candidates_json)
    if not rows:
        raise RenderError("无候选可挑选")
    found = None
    for c in rows:
        if not isinstance(c, dict):
            continue
        if c.get("id") == candidate_id:
            found = c
            c["is_picked"] = True
        else:
            c["is_picked"] = False
    if not found:
        raise RenderError("候选不存在")
    if found.get("status") != "done" or not found.get("url"):
        raise RenderError("候选未完成或无产物")
    shot.video_url = str(found["url"])
    shot.final_clip_url = str(found["url"])
    shot.candidates_json = dumps_candidates(rows)
    if found.get("video_model"):
        shot.video_model = str(found["video_model"])
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot

