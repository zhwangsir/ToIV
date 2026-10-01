"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。
"""
from __future__ import annotations

import json
import logging
from typing import TYPE_CHECKING, Any

from sqlmodel import Session, select

from app.harness import events as ev
from app.models import StudioCharacter, StudioProject, StudioShot
from app.services.studio.renderers.base import RenderError, get_renderer

if TYPE_CHECKING:
    from app.comfy.pool import WorkerPool

logger = logging.getLogger(__name__)

# 已具备最终媒体的状态:批量渲染跳过
_TERMINAL_SKIP = {"rendered", "voiced", "lipsynced", "done"}


def terminal_states() -> set[str]:
    """批量渲染跳过的状态集合(副本,防调用方改内部常量)。"""
    return set(_TERMINAL_SKIP)


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
    from app.services.studio.shot_refs import collect_cast_ref_images, ref_urls

    if ref_images is not None:
        resolved_refs = [u for u in ref_images if isinstance(u, str) and u.strip()]
        # 显式列表:渲染器按该序编号(标签简化为参考图N)
        render_kw["ref_images"] = resolved_refs
    else:
        resolved_refs = ref_urls(
            collect_cast_ref_images(cast, scene_images=scene_images)
        )
        # 自动收集:留给渲染器从 cast 重建带角色名的 @图片N 标签
        if scene_images is not None:
            render_kw["scene_images"] = scene_images
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
    # 项目场景图：未显式传时从项目读取
    if scene_images is None and project is not None:
        try:
            scene_images = json.loads(getattr(project, "scene_images_json", None) or "[]")
        except (ValueError, TypeError):
            scene_images = []
        if not isinstance(scene_images, list):
            scene_images = []
        render_kw["scene_images"] = scene_images
    renderer = get_renderer(shot)

    async def _once(seed: int | None = None) -> Any:
        kw = dict(render_kw)
        if seed is not None:
            kw["seed"] = seed
        return await renderer.render(shot, cast, pool, **kw)

    try:
        if shot.render_mode != "video" or n <= 1:
            result = await _once()
            candidates: list[dict[str, Any]] = []
        else:
            # 多候选:不同 seed 串行提交(不并行,避免打爆 H3 单实例队列)
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
            # Batch6：裁脸选优（可关）
            if auto_pick and len(candidates) > 1:
                from app.services.studio.candidate_pick import pick_best_candidate
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

                win_id, candidates = pick_best_candidate(
                    candidates, ref_image_path=ref_path, local_url_resolver=_resolve_vid
                )
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
        shot.status = "error"
        shot.error = str(e)
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
        shot.candidates_json = json.dumps(candidates, ensure_ascii=False)
    elif n <= 1 and shot.render_mode == "video":
        # 单候选也写一条,便于 UI 统一展示
        meta = getattr(result, "pipeline_meta", None) or {}
        shot.candidates_json = json.dumps(
            [
                {
                    "id": uuid.uuid4().hex,
                    "url": result.url if result.kind == "video" else "",
                    "seed": 0,
                    "status": "done",
                    "is_picked": True,
                    "error": "",
                    "video_model": engine,
                    "pipeline": ((meta.get("pipeline") if isinstance(meta, dict) else None) or (pipe if engine == "h3" else "")),
                    "context_latent": (meta.get("context_latent") if isinstance(meta, dict) else "") or "",
                }
            ],
            ensure_ascii=False,
        )
    shot.status = "rendered"
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot


def pick_candidate(session: Session, shot: StudioShot, candidate_id: str) -> StudioShot:
    """将指定候选标为采用,回写 video_url/final_clip_url。"""
    try:
        rows = json.loads(shot.candidates_json or "[]")
    except (ValueError, TypeError):
        rows = []
    if not isinstance(rows, list) or not rows:
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
    shot.candidates_json = json.dumps(rows, ensure_ascii=False)
    if found.get("video_model"):
        shot.video_model = str(found["video_model"])
    session.add(shot)
    session.commit()
    session.refresh(shot)
    return shot

