"""Studio 编排:分镜状态机 + 渲染/配音/合成的服务侧入口。

状态机:draft → queued → rendering → rendered → voiced → (lipsynced) → done
任何步骤异常落 error 并记录 shot.error,支持单镜重试。

已有入选片时(video_url/final_clip_url 或 is_picked 候选,或 status 已是
rendered/voiced/lipsynced/done 且有视频):重试失败只追加候选失败记录,
不得把镜次 status 打成 error、不得清除入选 URL。
"""
from __future__ import annotations

import json
from pathlib import Path
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



# H3 管线：默认 ref2va（逐镜独立）；C 家族 c / c_hybrid 为显式可选的续写路线
from app.services.studio.pipelines import (  # noqa: E402
    C_PIPELINES,
    DEFAULT_VIDEO_PIPELINE,
    INDEP_PIPELINE,
    VIDEO_PIPELINES,
)
_STUDIO_MARKER = "/api/studio/files/"


def _picked_video_url(s: StudioShot) -> str:
    """镜次入选的原始视频：is_picked 候选 url 优先，回落 video_url。"""
    for c in loads_candidates(s.candidates_json or "[]"):
        if (
            isinstance(c, dict)
            and c.get("is_picked")
            and (c.get("status") or "done") == "done"
            and str(c.get("url") or "").strip()
        ):
            return str(c["url"]).strip()
    return (s.video_url or "").strip()


def _studio_local_path(url: str) -> Path | None:
    """/api/studio/files/<name> → 本地文件（Studio 输出根 / NAS），不存在 → None。"""
    import os
    from app.storage import drama_output_root

    u = (url or "").strip()
    if _STUDIO_MARKER not in u:
        p = Path(u)
        return p if u.startswith("/") and p.is_file() else None
    name = Path(u.split(_STUDIO_MARKER, 1)[1].split("?", 1)[0]).name
    if not name or name.startswith("."):
        return None
    roots = [drama_output_root() / "studio"]
    extra = os.environ.get("TOIV_DRAMA_VIDEO_DIR", "")
    if extra:
        roots.append(Path(extra) / "studio")
    roots.append(Path("/mnt/toiv-nas/toiv/outputs/drama/final/studio"))
    for root in roots:
        p = root / name
        if p.is_file():
            return p
    return None


def _first_frame_out_dir() -> Path:
    from app.storage import drama_output_root

    d = drama_output_root() / "studio"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _extract_last_frame(src: Path, dst: Path) -> None:
    """ffmpeg 抽视频最后一帧为 PNG（-sseof 定位尾部 + -update 覆盖写出最后一帧）。"""
    import subprocess

    cmd = [
        "ffmpeg", "-y", "-loglevel", "error",
        "-sseof", "-1.0", "-i", str(src),
        "-update", "1", str(dst),
    ]
    try:
        subprocess.run(cmd, check=True, timeout=60, capture_output=True)
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired, OSError) as e:
        raise RenderError(f"c_hybrid 抽上一镜尾帧失败:{e}") from e
    if not dst.is_file() or dst.stat().st_size == 0:
        raise RenderError("c_hybrid 抽上一镜尾帧失败:输出为空")


def _full_body_ref_url(cast: list[StudioCharacter], style: str | None) -> str | None:
    """角色全身定妆图（c_hybrid 首镜首帧）。

    优先级：
      1. 文件名含 full/全身（sample_*_full.png 等显式全身图）；
      2. 设定卡三视图正面格 char_panel_{cid8}_{style}_front_*（全身正面站姿）；
         设定卡分桶顺序为 portrait/front/side/back，portrait 是半身立绘，不能当全身首帧；
      3. 非设定卡参考图的槽标签「全身」（扁平三视图 正/侧/全身 约定）。
    设定卡 panel 不走槽标签兜底：分桶顺序与 正/侧/全身 槽位不对应（第 3 张是 side）。
    """
    from app.services.studio.shot_refs import collect_cast_ref_images

    refs = [r for r in collect_cast_ref_images(cast, style=style) if r.role != "scene"]

    def _name(u: str | None) -> str:
        return (u or "").split("?", 1)[0].rsplit("/", 1)[-1].lower()

    for r in refs:
        name = _name(r.image_url)
        if "full" in name or "全身" in name:
            return r.image_url
    for r in refs:
        name = _name(r.image_url)
        if "char_panel_" in name and "_front_" in name:
            return r.image_url
    for r in refs:
        if "char_panel_" in _name(r.image_url):
            continue
        if "全身" in (r.label or ""):
            return r.image_url
    return None


async def _resolve_hybrid_first_frame(
    session: Session,
    shot: StudioShot,
    cast: list[StudioCharacter],
    style: str | None,
) -> str:
    """c_hybrid 首帧：上一镜入选视频尾帧；无上一镜 → 角色全身定妆图。失败 RenderError。"""
    import uuid

    siblings = session.exec(
        select(StudioShot).where(StudioShot.project_id == shot.project_id)
    ).all()
    prev = None
    for s in siblings:
        if s.idx < shot.idx and (prev is None or s.idx > prev.idx):
            prev = s
    if prev is None:
        url = _full_body_ref_url(cast, style)
        if not url:
            raise RenderError("c_hybrid 首镜需要角色全身定妆图（参考图含 full/全身）")
        return url
    vurl = _picked_video_url(prev)
    if not vurl:
        raise RenderError(f"c_hybrid 需要上一镜(idx={prev.idx})入选视频")
    src = _studio_local_path(vurl)
    if src is None:
        raise RenderError(f"c_hybrid 上一镜视频不在本地:{vurl[:80]}")
    name = f"chybrid_ff_{str(shot.id)[:8]}_{uuid.uuid4().hex[:8]}.png"
    dst = _first_frame_out_dir() / name
    await asyncio.to_thread(_extract_last_frame, src, dst)
    return f"{_STUDIO_MARKER}{name}"


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
    worker_url: str | None = None,
    ref_overrides: dict[str, str] | None = None,
    outfit_desc: str | None = None,
    wait: bool = True,
) -> StudioShot:
    """渲染单镜:按 render_mode 分发;状态与媒体 URL 落库。

    视频步(10-07 拍板默认逐镜独立 Ref2VA):
      · video_model 默认 h3;pipeline 默认 ref2va(每镜 4 张定妆参考,不续写上一镜);
      · 显式 pipeline=c / c_hybrid 才走 Motion Context,并自动续写上一镜 context_latent;
      · num_candidates>1 时串行多 seed,按裁脸相似度+无烧录字幕选优。
    """
    import random
    import uuid

    # 独立镜不接受续写参数：在改镜次状态之前拒绝，避免静默丢弃 context
    _req_pipe = (pipeline or DEFAULT_VIDEO_PIPELINE).strip().lower() or DEFAULT_VIDEO_PIPELINE
    if (context_latent_path or "").strip() and _req_pipe == INDEP_PIPELINE:
        raise RenderError("独立镜 Ref2VA 不续写上一镜 context_latent；需要续写请显式选 pipeline=c")

    # 管理员 worker 覆盖：白名单校验前置（在改镜次状态之前）
    pinned_worker = None
    if worker_url:
        from app.services.h3 import validate_worker_override

        try:
            pinned_worker = validate_worker_override(worker_url)
        except ValueError as e:
            raise RenderError(str(e)) from e

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
            # 管线 C 阶段 A：贯通属主，供 render_pipeline_c 落 Job
            "tenant_id": project.tenant_id,
            "user_id": project.user_id,
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
        from app.services.studio.shot_refs import apply_ref_overrides

        resolved_refs = ref_urls(
            apply_ref_overrides(
                collect_cast_ref_images(
                    cast, scene_images=scene_images, style=sheet_style
                ),
                ref_overrides,
            )
        )
        # 自动收集:留给渲染器从 cast 重建带角色名的 @图片N 标签
    shot.ref_images_json = json.dumps(resolved_refs, ensure_ascii=False)
    if request is not None:
        render_kw["request"] = request
    render_kw["video_model"] = engine
    pipe = (pipeline or DEFAULT_VIDEO_PIPELINE).strip().lower() if engine == "h3" else "legacy"
    if pipe not in VIDEO_PIPELINES + ("legacy",):
        pipe = DEFAULT_VIDEO_PIPELINE
    render_kw["pipeline"] = pipe
    if pipe in VIDEO_PIPELINES:
        if ref_overrides:
            render_kw["ref_overrides"] = dict(ref_overrides)
        if (outfit_desc or "").strip():
            render_kw["outfit_desc"] = outfit_desc.strip()
    if pinned_worker:
        render_kw["worker_url"] = pinned_worker
    # 续写（仅 c / c_hybrid）：显式 context > 同项目上一镜 picked 的 context_latent；ref2va 每镜独立不续写
    ctx = (context_latent_path or "").strip()
    if not ctx and pipe in C_PIPELINES and shot.render_mode == "video":
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
    do_wait = bool(wait)
    render_kw["wait"] = do_wait
    if not do_wait:
        # 阶段 B 最小：异步只跑单候选，避免多 seed 串行堵在 HTTP
        n = 1
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
        # c_hybrid：首帧 = 上一镜入选尾帧 / 首镜全身定妆图（失败走下方统一错误处理）
        if pipe == "c_hybrid" and shot.render_mode == "video":
            render_kw["first_frame_url"] = await _resolve_hybrid_first_frame(
                session, shot, cast, sheet_style
            )
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
                    "pipeline": pipe if engine == "h3" else "",
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
                        if meta.get("first_frame"):
                            entry["first_frame"] = str(meta["first_frame"])
                        if meta.get("worker"):
                            entry["worker"] = str(meta["worker"])
                        if meta.get("job_id"):
                            entry["job_id"] = str(meta["job_id"])
                        if meta.get("db_job_id"):
                            entry["db_job_id"] = str(meta["db_job_id"])
                        if meta.get("prompt"):
                            entry["prompt"] = str(meta["prompt"])[:500]
                        if meta.get("outfit_check"):
                            oc_ = meta["outfit_check"]
                            entry["outfit_check"] = {
                                k: oc_.get(k) for k in ("action", "target", "first_frame", "mismatches", "error")
                            }
                        if meta.get("hard_cut_reseed_hits"):
                            entry["hard_cut_reseed_hits"] = list(meta["hard_cut_reseed_hits"])
                        if meta.get("ref_overrides"):
                            entry["ref_overrides"] = dict(meta["ref_overrides"])
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
                neg_ref_paths = []
                primary_cid = None
                for c in cast:
                    urls = []
                    try:
                        urls = json.loads(getattr(c, "reference_images", None) or "[]")
                    except (ValueError, TypeError):
                        urls = []
                    if not urls:
                        continue
                    u = str(urls[0])
                    marker = "/api/studio/files/"
                    resolved = None
                    if marker in u:
                        name = u.split(marker, 1)[1].split("?", 1)[0]
                        candp = drama_output_root() / "studio" / name
                        if candp.is_file():
                            resolved = candp
                    if resolved is None:
                        continue
                    cid = str(getattr(c, "id", "") or "")
                    if ref_path is None:
                        ref_path = resolved
                        primary_cid = cid
                    elif cid and cid != primary_cid:
                        neg_ref_paths.append(resolved)

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
                # 动漫镜：CLIP 图相似，门禁 0.60；参考图无脸禁止空分放行（12:48）
                _anime = (sheet_style or "").strip().lower() in (
                    "anime", "二次元", "动漫", "cartoon",
                )
                try:
                    # 动漫：相对身份门禁（本角色 vs 同项目其他角色/通用负样本 +0.03）
                    if _anime:
                        _generic_cands = [
                            drama_output_root()
                            / "studio"
                            / "fixtures"
                            / "anime_face_clip"
                            / "neg_haokun.jpg",
                            Path(__file__).resolve().parents[3]
                            / "tests"
                            / "fixtures"
                            / "anime_face_clip"
                            / "neg_haokun.jpg",
                        ]
                        for _generic_neg in _generic_cands:
                            if _generic_neg.is_file():
                                neg_ref_paths.append(_generic_neg)
                                break
                    # 去重且排除主参考
                    _seen = set()
                    _negs = []
                    for p in neg_ref_paths:
                        sp = str(p)
                        if ref_path and sp == str(ref_path):
                            continue
                        if sp in _seen:
                            continue
                        _seen.add(sp)
                        _negs.append(p)
                    win_id, candidates = await asyncio.to_thread(
                        pick_best_candidate,
                        candidates,
                        ref_image_path=ref_path,
                        local_url_resolver=_resolve_vid,
                        prev_video_path=prev_video_path,
                        scene_ref_path=scene_ref_path,
                        regression_ref_path=regression_ref_path,
                        face_score_mode="clip" if _anime else "auto",
                        ref_style=sheet_style,
                        min_face_mean=0.60 if _anime else 0.45,
                        negative_ref_paths=_negs if _anime else None,
                        relative_margin=0.03,
                        use_relative_identity=True if _anime else False,
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

    # 阶段 B 最小：wait=false → 已登记 Job + spawn_tracker，立即返回；不落成片 URL
    _meta_async = getattr(result, "pipeline_meta", None) or {}
    if (
        not do_wait
        and isinstance(_meta_async, dict)
        and _meta_async.get("waited") is False
        and (_meta_async.get("db_job_id") or "")
    ):
        import uuid as _uuid

        shot.candidates_json = dumps_candidates(
            [
                {
                    "id": _uuid.uuid4().hex,
                    "url": "",
                    "seed": int(_meta_async.get("seed") or seed or 0),
                    "status": "queued",
                    "is_picked": False,
                    "error": "",
                    "video_model": engine,
                    "pipeline": str(_meta_async.get("pipeline") or pipe or ""),
                    "job_id": str(_meta_async.get("job_id") or ""),
                    "db_job_id": str(_meta_async.get("db_job_id") or ""),
                    "worker": str(_meta_async.get("worker") or ""),
                    "context_latent": str(_meta_async.get("context_latent") or ""),
                }
            ]
        )
        # 保持 rendering：成片由后续轮询/回收接上（本刀不写 URL）
        shot.status = "rendering"
        shot.error = ""
        session.add(shot)
        session.commit()
        session.refresh(shot)
        return shot

    # 硬切规则（C 管线视频）：pick_best_candidate 未跑时（单候选/关闭选优）在此执行，
    # 锚定区/首 1 秒硬切 → 裁片头（音频同步裁），片尾不变，续写 latent 仍有效。
    single_trim: dict[str, Any] | None = None
    if (
        result.kind == "video"
        and pipe in VIDEO_PIPELINES
        and not any(isinstance(c, dict) and "hard_cuts" in c for c in candidates)
    ):
        from app.services.studio.candidate_pick import ANCHORED_FIRST_FRAME_SKIP_FRAMES
        from app.services.studio.hard_cut import apply_hard_cut_rule

        _meta0 = getattr(result, "pipeline_meta", None) or {}
        _anchor = ANCHORED_FIRST_FRAME_SKIP_FRAMES if (
            isinstance(_meta0, dict) and _meta0.get("first_frame")
        ) else 0
        targets = [c for c in candidates if isinstance(c, dict) and c.get("status") == "done" and c.get("url")]
        if not targets:
            single_trim = {"url": result.url}
            targets = [single_trim]
        for c in targets:
            lp = _studio_local_path(str(c["url"]))
            if lp is None:
                continue
            try:
                await asyncio.to_thread(apply_hard_cut_rule, c, lp, anchor_frames=_anchor)
            except Exception:  # noqa: BLE001
                logger.warning("hard_cut rule failed shot=%s", shot.id, exc_info=True)
        picked_url = next(
            (str(c["url"]) for c in targets if c is single_trim or c.get("is_picked")), ""
        )
        if picked_url and picked_url != result.url:
            class _RT:
                kind = "video"
                url = picked_url
                pipeline_meta = _meta0
            result = _RT()

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
        # 独立镜：回显实际提交的定妆参考（每镜 4 张 + 场景），而非全量收集列表
        _rm = getattr(result, "pipeline_meta", None) or {}
        if pipe == INDEP_PIPELINE and isinstance(_rm, dict) and isinstance(_rm.get("ref_images"), list):
            shot.ref_images_json = json.dumps(list(_rm["ref_images"]), ensure_ascii=False)
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
                    "first_frame": (meta.get("first_frame") if isinstance(meta, dict) else "") or "",
                    **{k: v for k, v in (single_trim or {}).items() if k != "url"},
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

