"""分镜单镜生成(M2,2026-09-21)——按 shot_meta 构造引擎请求,直调引擎路由函数提交。

与 jobs.py rerun 复放原端点同范式:不重写引擎链路,构造请求对象调
generate_phantom_s2v / generate_h3_r2v / generate_h3_t2v(各自含就绪探测/限流/落 Job)。

三引擎分支:
- phantom-s2v:entity_ids 服务端实质解图(角色锁定语义最对口)——无图主体必须预过滤
  (路由 `_entity_ref_handles` 对无句柄主体 422);num_frames 由 duration_sec×fps 推出
- h3-r2v:entity_ids 只写 prompt 前缀不进图槽——先 resolve-refs 出钉 worker 句柄,
  entity_ids 过滤为 refs 产出子集(保序),保 @图片N 与图槽对齐
- h3-t2v:entity_ids 全量透传(服务端自动首帧/前缀,容忍无图主体),无角色也能纯 t2v
"""
from __future__ import annotations

import json
from typing import Any

from fastapi import HTTPException
from sqlmodel import Session

from app.comfy.pool import WorkerPool
from app.models import BoardItem, Entity, User
from app.routes.entities import ResolveRefsRequest, resolve_entity_refs
from app.routes.h3_studio import H3R2VRequest, H3T2VRequest, generate_h3_r2v, generate_h3_t2v
from app.routes.phantom_studio import PhantomS2VRequest, generate_phantom_s2v
from app.services.board_storyboard import resolve_shot_entities
from app.services.entities import image_handle_for_injection

ENGINE_IDS = ("phantom-s2v", "h3-r2v", "h3-t2v")


def prepare_shot_meta(item: BoardItem) -> dict[str, Any]:
    """行 → shot_meta(手动占位行以 shot_text 作 scene 兜底,generate 路由与 agent 工具共用)。"""
    meta: dict[str, Any] = {}
    if item.shot_meta:
        try:
            obj = json.loads(item.shot_meta)
            if isinstance(obj, dict):
                meta = obj
        except ValueError:
            meta = {}
    if not str(meta.get("scene") or "").strip() and item.shot_text.strip():
        meta["scene"] = item.shot_text.strip()
    return meta


def build_shot_positive(meta: dict[str, Any]) -> str:
    """分镜生成提示词:shot_meta.prompt → scene 兜底;皆空抛 ValueError(路由转 422)。"""
    positive = str(meta.get("prompt") or "").strip()
    if not positive:
        positive = str(meta.get("scene") or "").strip()
    if not positive:
        raise ValueError("该分镜行没有可用提示词(请先编辑分镜文本或由剧本拆镜生成)")
    return positive


def _entity_has_image(e: Entity) -> bool:
    """主体是否有可注入的定妆照(句柄 JSON / 站内 /api/images URL 双形态)。"""
    return image_handle_for_injection(e) is not None


def _image_bearing_entities(
    session: Session, user_id: str, meta: dict[str, Any]
) -> list[Entity]:
    """分镜实体解析(对齐列表滤空 + 按 id 去重保序 + 仅留有可解析定妆照的主体)。"""
    out: list[Entity] = []
    seen: set[str] = set()
    for ent in resolve_shot_entities(session, user_id, meta):
        if ent is None or ent.id in seen or not _entity_has_image(ent):
            continue
        seen.add(ent.id)
        out.append(ent)
    return out


def _duration_sec_of(meta: dict[str, Any]) -> float:
    try:
        d = float(meta.get("duration_sec") or 6)
    except (ValueError, TypeError):
        d = 6.0
    return max(1.0, min(60.0, d))


_NO_IMAGE_HINT = "角色实体均无定妆照:请先到主体库生成/上传参考图(或改用 h3-t2v 引擎)"


async def submit_shot_generation(
    session: Session,
    pool: WorkerPool,
    user: User,
    meta: dict[str, Any],
    engine: str,
    seed: int | None = None,
    fps: int = 16,
) -> dict:
    """提交单镜生成。HTTPException 直抛(422 语义/引擎 503 透传);返回引擎响应+engine。"""
    positive = build_shot_positive(meta)
    duration = _duration_sec_of(meta)
    seed_kw: dict[str, Any] = {"seed": seed} if seed is not None else {}

    if engine == "phantom-s2v":
        ids = [e.id for e in _image_bearing_entities(session, user.id, meta)][:4]
        if not ids:
            raise HTTPException(status_code=422, detail=_NO_IMAGE_HINT)
        frames = min(241, max(17, round(duration * fps)))
        req = PhantomS2VRequest(
            positive=positive, entity_ids=ids, num_frames=frames, fps=fps, **seed_kw
        )
        result = await generate_phantom_s2v(req, user=user, session=session)
    elif engine == "h3-r2v":
        ids = [e.id for e in _image_bearing_entities(session, user.id, meta)][:8]
        if not ids:
            raise HTTPException(status_code=422, detail=_NO_IMAGE_HINT)
        # 参考图落点不钉 H3 实例(其模型门控不含通用 img2img):池内通用 worker 中转,
        # r2v 路由自带二次转运(transfer_ref_image 到 H3 实例 input)
        resolved = await resolve_entity_refs(
            ResolveRefsRequest(entity_ids=ids, kind="img2img"),
            user=user, session=session, pool=pool,
        )
        refs = resolved.get("refs") or []
        if not refs:
            raise HTTPException(
                status_code=422,
                detail=f"角色参考图均不可用(skipped={resolved.get('skipped')}),请到主体库检查定妆照",
            )
        req = H3R2VRequest(
            positive=positive,
            images=[r["filename"] for r in refs],
            worker=resolved["worker"],
            entity_ids=[r["entity_id"] for r in refs],
            duration_sec=duration,
            **seed_kw,
        )
        result = await generate_h3_r2v(req, user=user, session=session)
    elif engine == "h3-t2v":
        entity_ids = [
            e.id
            for e in resolve_shot_entities(session, user.id, meta)
            if e is not None
        ]
        req = H3T2VRequest(
            positive=positive,
            entity_ids=entity_ids or None,
            duration_sec=duration,
            **seed_kw,
        )
        result = await generate_h3_t2v(req, user=user, session=session)
    else:
        raise HTTPException(status_code=422, detail=f"不支持的引擎: {engine}")

    out = dict(result)
    out["engine"] = engine
    return out
