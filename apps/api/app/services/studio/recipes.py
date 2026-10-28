"""C1b:用户生成配方(StudioRecipe)领域逻辑——快照构建/脱敏/CRUD/diff/apply/导入导出。

口径纪律(与 C1a 同一真源):
  · 快照只存真实生成输入;没有值存 null/省略,绝不伪造。
  · 剧情字段(scene/dialogue/speaker/idx/beats)与角色 roster 永不入配方,
    apply 也不触碰(roster 由 shot.characters 维持)。
  · 剥离 worker_url / context_latent_path / parent_chain_job_id;URL 一律去
    query(签名/密钥不进配方,防泄漏与 SSRF)。
  · 快照出处诚实:优先 shot.rendered_revision_id(生成输入修订);否则
    current_revision_id(内容修订);旧 shot 用 live 快照且 source_revision_id
    留空——不虚构渲染历史。
"""
from __future__ import annotations

import json
import logging
from typing import Any
from urllib.parse import urlsplit, urlunsplit

from sqlmodel import Session, select

from app.models import (
    RECIPE_PICK_STRATEGIES,
    StudioRecipe,
    StudioShot,
    StudioShotRevision,
)

logger = logging.getLogger(__name__)

EXPORT_SCHEMA = "toiv_generation_recipe_v1"
MAX_IMPORT_BYTES = 64 * 1024
MAX_NAME = 100
MAX_DESCRIPTION = 1000
MAX_PROMPT = 4000
MAX_NEGATIVE = 2000
PIPELINES = ("ref2va", "c", "c_hybrid", "legacy")
ENGINES = ("h3", "ltx")
RENDER_MODES = ("video", "image_motion")

# 配方覆盖的镜头字段(shot 列):剧情字段与 roster 不在此列。
# ref_images_json 以 snapshot.ref_images(list)为唯一真源,apply/diff 做映射。
APPLICABLE_SHOT_FIELDS = (
    "prompt", "negative", "camera", "duration_sec", "video_model", "render_mode",
    "ref_images_json", "ref_epoch", "ref_epoch_note", "scene_ref_json",
)

# 快照键(渲染参数层,不落在 shot 列,apply 时作为 render_one 参数返回)
RENDER_PARAM_KEYS = (
    "pipeline", "num_candidates", "seed", "ref_images", "scene_images",
    "ref_style", "accel",
)


class RecipeError(ValueError):
    """配方领域错误;路由映射 422(校验)或 404(LookupError 另行处理)。"""


# ── 快照构建 ─────────────────────────────────────────────────────────────────

# /api/images 产物定位:仅保留非敏感定位字段(剥 sig/token 等,保留可定位性)
_SAFE_IMAGE_QUERY_KEYS = {"filename", "subfolder", "worker", "type"}


def strip_url_secret(url: str) -> str:
    """脱敏:剥 userinfo(凭据)与敏感 query。

    - /api/images?...:保留 filename/subfolder/worker/type 定位字段(其余 query
      含 sig/token 一律剥除)——产物定位不丢,签名不落配方;
    - 其他 URL(含 http worker 引用):只留路径,query 全剥;
    - 裸文件名/站内路径:原样(去 query)。
    """
    u = (url or "").strip()
    if not u:
        return u
    try:
        parts = urlsplit(u)
        host = parts.hostname or ""
        if host and parts.port:
            host = f"{host}:{parts.port}"
    except ValueError as e:
        # 非法端口/主机(如 :badport):422;消息不得回显原文(可能带签名)
        raise RecipeError("URL 格式非法(主机/端口无法解析)") from e
    query = ""
    if parts.query:
        from urllib.parse import parse_qsl, urlencode

        pairs = parse_qsl(parts.query, keep_blank_values=True)
        if parts.path.startswith("/api/images"):
            pairs = [(k, v) for k, v in pairs if k in _SAFE_IMAGE_QUERY_KEYS]
        else:
            pairs = []
        query = urlencode(pairs)
    return urlunsplit((parts.scheme, host, parts.path, query, ""))


def sanitize_scene_ref(raw: Any) -> str | None:
    """scene_ref_json 的 anchor_image 同法脱敏;非对象/空 → 原样(None/空串)。"""
    if not raw:
        return None
    if isinstance(raw, str):
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            # 非 JSON 原文(旧数据游离字符串):按 URL 同法脱敏,query 不带入配方
            return strip_url_secret(raw)
    else:
        data = raw
    if not isinstance(data, dict):
        return json.dumps(data, ensure_ascii=False) if not isinstance(raw, str) else raw
    image = data.get("anchor_image")
    if isinstance(image, str) and image:
        data["anchor_image"] = strip_url_secret(image)
    return json.dumps(data, ensure_ascii=False)


def _parse_url_list(raw: Any) -> list[str]:
    """JSON 字符串或 list → list;逐项脱敏。"""
    if isinstance(raw, str):
        try:
            raw = json.loads(raw or "[]")
        except (ValueError, TypeError):
            raw = []
    return _strip_url_list(raw)


def _strip_url_list(urls: Any) -> list[str]:
    if not isinstance(urls, list):
        return []
    return [u for u in (strip_url_secret(str(x)) for x in urls) if u]


def _project_specs(session: Session, shot: StudioShot) -> dict[str, Any]:
    from app.models import StudioProject

    project = session.get(StudioProject, shot.project_id)
    if project is None:
        return {"width": None, "height": None, "fps": None, "ckpt_name": None}
    return {
        "width": project.width,
        "height": project.height,
        "fps": project.fps,
        "ckpt_name": project.ckpt_name or None,
    }


def _snapshot_from_render_params(rp: dict[str, Any], content: dict[str, Any]) -> dict[str, Any]:
    """render 修订 → 配方快照(只取真实生成输入,剥离 worker/上下文/父链)。"""
    specs = {k: rp.get(k) for k in ("width", "height", "fps")}
    specs["ckpt_name"] = rp.get("ckpt_name") or None
    return {
        "engine": rp.get("video_model") or content.get("video_model") or "h3",
        "render_mode": content.get("render_mode") or "video",
        "pipeline": rp.get("pipeline"),
        "pick_strategy": ("manual" if rp.get("auto_pick") is False else "auto_best"),
        "prompt": content.get("prompt"),
        "negative": content.get("negative"),
        "camera": content.get("camera"),
        "duration_sec": content.get("duration_sec"),
        "num_candidates": rp.get("num_candidates"),
        "seed": rp.get("seed"),
        "ref_images": _strip_url_list(rp.get("ref_images")),
        "scene_images": _strip_url_list(rp.get("scene_images")),
        "ref_style": rp.get("ref_style") or None,
        "accel": rp.get("accel") or None,
        "ref_epoch": content.get("ref_epoch", 0),
        "ref_epoch_note": content.get("ref_epoch_note") or None,
        "scene_ref_json": sanitize_scene_ref(content.get("scene_ref_json")),
        **specs,
    }


def _snapshot_from_content(content: dict[str, Any], shot: StudioShot, specs: dict[str, Any]) -> dict[str, Any]:
    """内容修订/live shot → 可说明快照(无渲染参数,未知项=None 不伪造)。"""
    return {
        "engine": content.get("video_model") or getattr(shot, "video_model", "") or "h3",
        "render_mode": content.get("render_mode") or "video",
        "pipeline": None,
        "pick_strategy": "auto_best",
        "prompt": content.get("prompt"),
        "negative": content.get("negative"),
        "camera": content.get("camera"),
        "duration_sec": content.get("duration_sec"),
        "num_candidates": None,
        "seed": None,
        "ref_images": _parse_url_list(getattr(shot, "ref_images_json", "[]")),
        "scene_images": [],
        "ref_style": None,
        "accel": None,
        "ref_epoch": content.get("ref_epoch", 0),
        "ref_epoch_note": content.get("ref_epoch_note") or None,
        "scene_ref_json": sanitize_scene_ref(content.get("scene_ref_json")),
        **specs,
    }


def build_snapshot(
    session: Session, shot: StudioShot
) -> tuple[dict[str, Any], str, str]:
    """(snapshot, source_revision_id, source_kind)。

    source_kind ∈ render|content|legacy,诚实标注快照出处;legacy=旧 shot 无
    修订,用 live 输入(source_revision_id 空)。无可快照输入 → RecipeError。
    """
    if shot.rendered_revision_id:
        rev = session.get(StudioShotRevision, shot.rendered_revision_id)
        if rev is not None:
            try:
                content = json.loads(rev.content_json or "{}")
            except (ValueError, TypeError):
                content = {}
            rp = content.get("render_params") or {}
            return _snapshot_from_render_params(rp, content), rev.id, "render"
    if shot.current_revision_id:
        rev = session.get(StudioShotRevision, shot.current_revision_id)
        if rev is not None:
            try:
                content = json.loads(rev.content_json or "{}")
            except (ValueError, TypeError):
                content = {}
            return (
                _snapshot_from_content(content, shot, _project_specs(session, shot)),
                rev.id,
                "content",
            )
    if (shot.video_url or "").strip() or (shot.image_url or "").strip():
        content = {f: getattr(shot, f, None) for f in APPLICABLE_SHOT_FIELDS}
        return (
            _snapshot_from_content(content, shot, _project_specs(session, shot)),
            "",
            "legacy",
        )
    raise RecipeError("该镜还没有可复用的生成输入(先渲染或保存分镜再创建配方)")


def load_snapshot(recipe: StudioRecipe) -> dict[str, Any]:
    try:
        data = json.loads(recipe.snapshot_json or "{}")
    except (ValueError, TypeError):
        data = {}
    return data if isinstance(data, dict) else {}


# ── CRUD ─────────────────────────────────────────────────────────────────────


def create_from_shot(
    session: Session, *, user_id: str, shot: StudioShot,
    name: str, description: str,
) -> StudioRecipe:
    snapshot, source_revision_id, _kind = build_snapshot(session, shot)
    recipe = StudioRecipe(
        user_id=user_id,
        name=(name or "").strip() or f"配方·{shot.scene or shot.prompt[:20] or shot.id[:8]}",
        description=(description or "").strip(),
        engine=snapshot.get("engine") or "h3",
        render_mode=snapshot.get("render_mode") or "video",
        pipeline=snapshot.get("pipeline") or "ref2va",
        pick_strategy=snapshot.get("pick_strategy") or "auto_best",
        snapshot_json=json.dumps(snapshot, ensure_ascii=False),
        source_revision_id=source_revision_id,
        source_shot_id=shot.id,
        is_default=False,
    )
    session.add(recipe)
    session.commit()
    session.refresh(recipe)
    return recipe


def list_recipes(session: Session, user_id: str, engine: str | None = None) -> list[StudioRecipe]:
    q = select(StudioRecipe).where(StudioRecipe.user_id == user_id)
    if engine:
        q = q.where(StudioRecipe.engine == engine)
    rows = session.exec(q.order_by(StudioRecipe.updated_at.desc())).all()  # type: ignore[attr-defined]
    return list(rows)


def get_recipe(session: Session, recipe_id: str, user_id: str) -> StudioRecipe:
    recipe = session.get(StudioRecipe, recipe_id)
    if recipe is None or recipe.user_id != user_id:
        raise LookupError("配方不存在")
    return recipe


def _validate_pick_strategy(v: str) -> str:
    p = (v or "").strip()
    if p not in RECIPE_PICK_STRATEGIES:
        raise RecipeError(f"pick_strategy 仅支持 {' | '.join(RECIPE_PICK_STRATEGIES)}")
    return p


def update_recipe(
    session: Session, recipe: StudioRecipe, *,
    name: str | None, description: str | None,
    prompt: str | None, negative: str | None,
    pick_strategy: str | None,
) -> StudioRecipe:
    snapshot = load_snapshot(recipe)
    if name is not None:
        if len(name) > MAX_NAME:
            raise RecipeError(f"名称超长(上限 {MAX_NAME})")
        recipe.name = name.strip()
    if description is not None:
        if len(description) > MAX_DESCRIPTION:
            raise RecipeError(f"描述超长(上限 {MAX_DESCRIPTION})")
        recipe.description = description.strip()
    if prompt is not None:
        if len(prompt) > MAX_PROMPT:
            raise RecipeError(f"提示词超长(上限 {MAX_PROMPT})")
        snapshot["prompt"] = prompt
    if negative is not None:
        if len(negative) > MAX_NEGATIVE:
            raise RecipeError(f"反向词超长(上限 {MAX_NEGATIVE})")
        snapshot["negative"] = negative
    if pick_strategy is not None:
        recipe.pick_strategy = _validate_pick_strategy(pick_strategy)
        snapshot["pick_strategy"] = recipe.pick_strategy
    recipe.snapshot_json = json.dumps(snapshot, ensure_ascii=False)
    from datetime import datetime, timezone

    recipe.updated_at = datetime.now(timezone.utc)
    session.add(recipe)
    session.commit()
    session.refresh(recipe)
    return recipe


def clone_recipe(session: Session, recipe: StudioRecipe, name: str | None) -> StudioRecipe:
    dup = StudioRecipe(
        user_id=recipe.user_id,
        name=(name or "").strip() or f"{recipe.name or '配方'} 副本"[:MAX_NAME],
        description=recipe.description,
        engine=recipe.engine,
        render_mode=recipe.render_mode,
        pipeline=recipe.pipeline,
        pick_strategy=recipe.pick_strategy,
        snapshot_json=recipe.snapshot_json,
        source_revision_id=recipe.source_revision_id,
        source_shot_id=recipe.source_shot_id,
        is_default=False,
    )
    session.add(dup)
    session.commit()
    session.refresh(dup)
    return dup


def set_default(session: Session, recipe: StudioRecipe) -> StudioRecipe:
    """每 (user_id, engine) 唯一默认:同事务清同引擎旧默认再置位。"""
    from datetime import datetime, timezone

    now = datetime.now(timezone.utc)
    for other in session.exec(
        select(StudioRecipe).where(
            StudioRecipe.user_id == recipe.user_id,
            StudioRecipe.engine == recipe.engine,
            StudioRecipe.is_default.is_(True),  # type: ignore[attr-defined]
            StudioRecipe.id != recipe.id,
        )
    ).all():
        other.is_default = False
        other.updated_at = now
        session.add(other)
    recipe.is_default = True
    recipe.updated_at = now
    session.add(recipe)
    session.commit()
    session.refresh(recipe)
    return recipe


def delete_recipe(session: Session, recipe: StudioRecipe) -> None:
    session.delete(recipe)
    session.commit()


# ── 导入 / 导出 ──────────────────────────────────────────────────────────────


def export_recipe(recipe: StudioRecipe) -> dict[str, Any]:
    from datetime import datetime, timezone

    return {
        "schema": EXPORT_SCHEMA,
        "name": recipe.name,
        "description": recipe.description,
        "engine": recipe.engine,
        "render_mode": recipe.render_mode,
        "pipeline": recipe.pipeline,
        "pick_strategy": recipe.pick_strategy,
        "snapshot": load_snapshot(recipe),
        "exported_at": datetime.now(timezone.utc).isoformat(),
    }


def _classify_import_ref(u: str, field: str) -> None:
    """引用分类守卫(通过即合法,异常即 422):
    - `//host/path` 协议相对 URL = 远程引用 → 拒绝;
    - 绝对路径仅接受 `/api/` 站内引用(/etc/passwd 之类本机路径拒绝);
    - http(s) → 拒绝;
    - 其余(裸文件名)合法。
    """
    if u.startswith("//"):
        raise RecipeError(f"{field} 禁远程引用(SSRF):协议相对 URL")
    if u.startswith("/"):
        if not u.startswith("/api/"):
            raise RecipeError(f"{field} 仅允许 /api/ 下的站内引用")
        return
    if "://" in u:
        raise RecipeError(f"{field} 禁远程引用(SSRF):{u[:60]}")


def _validate_import_url_list(value: Any, field: str, max_len: int = 9) -> list[str]:
    """禁远程引用(SSRF):仅允许 /api/ 站内引用或裸文件名;query 剥除(定位字段另保)。

    max_len:ref_images=9(RenderShotBody 同),scene_images=4(RenderShotBody 同)。"""
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > max_len:
        raise RecipeError(f"{field} 须为长度 ≤{max_len} 的数组")
    out = []
    for item in value:
        u = strip_url_secret(str(item or ""))
        if not u:
            continue
        _classify_import_ref(u, field)
        out.append(u)
    return out


def _to_int(value: Any, field: str) -> int | None:
    """int 化;非数字/null 类型 → RecipeError(422),绝不 500。"""
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError) as e:
        raise RecipeError(f"{field} 须为整数") from e


def _validate_specs(snapshot: dict[str, Any]) -> dict[str, Any]:
    """项目规格(width/height/fps/ckpt)复用 ProjectPatch 同一校验真源。"""
    from pydantic import ValidationError

    from app.services.studio.schemas import ProjectPatch

    raw = {
        "width": snapshot.get("width"),
        "height": snapshot.get("height"),
        "fps": snapshot.get("fps"),
        "ckpt_name": snapshot.get("ckpt_name"),
    }
    try:
        patch = ProjectPatch(**{k: v for k, v in raw.items() if v is not None})
    except ValidationError as e:
        first = e.errors()[0]
        raise RecipeError(f"项目规格非法:{first.get('msg', first)}") from e
    return {
        "width": patch.width,
        "height": patch.height,
        "fps": patch.fps,
        "ckpt_name": patch.ckpt_name,
    }


def _validate_scene_ref_import(raw: Any) -> str | None:
    """scene_ref_json:anchor_image 同法脱敏;远程引用按 ref 同一 SSRF 规则拒绝。"""
    if not raw:
        return None
    try:
        data = json.loads(raw) if isinstance(raw, str) else raw
    except (ValueError, TypeError) as e:
        raise RecipeError("scene_ref_json 须为 JSON 对象") from e
    if not isinstance(data, dict):
        raise RecipeError("scene_ref_json 须为 JSON 对象")
    image = data.get("anchor_image")
    if isinstance(image, str) and image:
        cleaned = strip_url_secret(image)
        _classify_import_ref(cleaned, "scene_ref_json")
        data["anchor_image"] = cleaned
    return json.dumps(data, ensure_ascii=False)


def validate_import(session: Session, user_id: str, body: dict) -> dict[str, Any]:
    """导入校验:大小/类型/管线/候选数/提示词上限;剥离 worker/父链/上下文。"""
    if len(json.dumps(body, ensure_ascii=False)) > MAX_IMPORT_BYTES:
        raise RecipeError("导入内容过大(上限 64KB)")
    if not isinstance(body, dict) or body.get("schema") != EXPORT_SCHEMA:
        raise RecipeError(f"schema 须为 {EXPORT_SCHEMA}")
    snapshot = body.get("snapshot")
    if not isinstance(snapshot, dict):
        raise RecipeError("缺少 snapshot 对象")
    # 禁带入执行面参数:worker / 上一镜上下文 / 父链作业(出现即拒,不静默剥离)
    for banned in ("worker_url", "context_latent_path", "parent_chain_job_id"):
        if snapshot.get(banned) or body.get(banned):
            raise RecipeError(f"导入禁止携带 {banned}")

    name = str(body.get("name") or "").strip()
    if not name:
        raise RecipeError("name 不能为空")
    if len(name) > MAX_NAME:
        raise RecipeError(f"名称超长(上限 {MAX_NAME})")
    description = str(body.get("description") or "")
    if len(description) > MAX_DESCRIPTION:
        raise RecipeError(f"描述超长(上限 {MAX_DESCRIPTION})")
    engine = str(body.get("engine") or "h3")
    if engine not in ENGINES:
        raise RecipeError(f"engine 仅支持 {' | '.join(ENGINES)}")
    render_mode = str(body.get("render_mode") or "video")
    if render_mode not in RENDER_MODES:
        raise RecipeError(f"render_mode 仅支持 {' | '.join(RENDER_MODES)}")
    pipeline = str(body.get("pipeline") or snapshot.get("pipeline") or "ref2va")
    if pipeline not in PIPELINES:
        raise RecipeError(f"pipeline 仅支持 {' | '.join(PIPELINES)}")
    pick_strategy = _validate_pick_strategy(str(body.get("pick_strategy") or "auto_best"))

    prompt = snapshot.get("prompt")
    if prompt is not None and len(str(prompt)) > MAX_PROMPT:
        raise RecipeError(f"提示词超长(上限 {MAX_PROMPT})")
    negative = snapshot.get("negative")
    if negative is not None and len(str(negative)) > MAX_NEGATIVE:
        raise RecipeError(f"反向词超长(上限 {MAX_NEGATIVE})")
    n = _to_int(snapshot.get("num_candidates"), "num_candidates")
    if n is not None and not (1 <= n <= 4):
        raise RecipeError("num_candidates 须在 1-4")
    seed = _to_int(snapshot.get("seed"), "seed")
    duration = _to_int(snapshot.get("duration_sec"), "duration_sec")
    if duration is not None and not (1 <= duration <= 60):
        raise RecipeError("duration_sec 须在 1-60")
    specs = _validate_specs(snapshot)
    scene_ref_json = _validate_scene_ref_import(snapshot.get("scene_ref_json"))

    clean = {
        "engine": engine,
        "render_mode": render_mode,
        "pipeline": pipeline,
        "pick_strategy": pick_strategy,
        "prompt": None if prompt is None else str(prompt),
        "negative": None if negative is None else str(negative),
        "camera": None if snapshot.get("camera") is None else str(snapshot.get("camera")),
        "duration_sec": None if duration is None else int(duration),
        "num_candidates": None if n is None else int(n),
        "seed": seed,
        "ref_images": _validate_import_url_list(snapshot.get("ref_images"), "ref_images", max_len=9),
        "scene_images": _validate_import_url_list(snapshot.get("scene_images"), "scene_images", max_len=4),
        "ref_style": None if not snapshot.get("ref_style") else str(snapshot.get("ref_style")),
        "accel": None if not snapshot.get("accel") else str(snapshot.get("accel")),
        "ref_epoch": _to_int(snapshot.get("ref_epoch"), "ref_epoch") or 0,
        "ref_epoch_note": None if not snapshot.get("ref_epoch_note") else str(snapshot.get("ref_epoch_note"))[:200],
        "scene_ref_json": scene_ref_json,
        **specs,
    }
    return {
        "user_id": user_id,
        "name": name,
        "description": description.strip(),
        "engine": engine,
        "render_mode": render_mode,
        "pipeline": pipeline,
        "pick_strategy": pick_strategy,
        "snapshot_json": json.dumps(clean, ensure_ascii=False),
        "source_revision_id": "",
        "source_shot_id": "",
        "is_default": False,
    }


def import_recipe(session: Session, user_id: str, body: dict) -> StudioRecipe:
    fields = validate_import(session, user_id, body)
    recipe = StudioRecipe(**fields)
    session.add(recipe)
    session.commit()
    session.refresh(recipe)
    return recipe


# ── diff / apply ─────────────────────────────────────────────────────────────


def _planned_value(snapshot: dict[str, Any], field: str) -> Any:
    """配方对指定 shot 列的目标值;未知(None)不伪造。ref_images_json 以
    snapshot.ref_images(list)为唯一真源(存 shot 列时序列化)。"""
    if field == "video_model":
        return snapshot.get("engine")
    if field == "ref_images_json":
        refs = snapshot.get("ref_images")
        if refs is None:
            return None
        return json.dumps(refs, ensure_ascii=False)
    return snapshot.get(field)


def _live_value(shot: StudioShot, field: str) -> Any:
    """live shot 的比较口径:ref_images_json 解析+脱敏成 list 再比(sig 不假差异)。"""
    if field == "video_model":
        return shot.video_model or "h3"
    if field == "ref_images_json":
        return _parse_url_list(getattr(shot, "ref_images_json", "[]"))
    return getattr(shot, field, None)


def _planned_compare_value(snapshot: dict[str, Any], field: str) -> Any:
    """与 _live_value 同口径的比较值(ref_images_json → 脱敏 list)。"""
    if field == "ref_images_json":
        return _strip_url_list(snapshot.get("ref_images"))
    return _planned_value(snapshot, field)


def diff_vs_shot(recipe: StudioRecipe, shot: StudioShot) -> dict[str, Any]:
    """配方 vs 指定 shot 的逐字段差异(from=live shot,to=配方);null 项不比较。

    参考图按脱敏后 list 双侧比较,签名 query 不产生假差异。"""
    snapshot = load_snapshot(recipe)
    fields: dict[str, dict[str, Any]] = {}
    for field in APPLICABLE_SHOT_FIELDS:
        to = _planned_compare_value(snapshot, field)
        if to is None:
            continue  # 未声明/未知字段一律不比较(None 无假差异)
        frm = _live_value(shot, field)
        report_field = "ref_images" if field == "ref_images_json" else field
        if frm != to:
            fields[report_field] = {"from": frm, "to": to}
    return {
        "recipe_id": recipe.id,
        "shot_id": shot.id,
        "fields": fields,
        "render_params": render_params_for(recipe),
    }


def render_params_for(recipe: StudioRecipe) -> dict[str, Any]:
    """可直接喂给现有 render_one(RenderShotBody) 的参数;未知项不伪造。"""
    snapshot = load_snapshot(recipe)
    params: dict[str, Any] = {
        "video_model": snapshot.get("engine") or recipe.engine,
        "auto_pick": recipe.pick_strategy != "manual",
        "wait": True,
    }
    for key in RENDER_PARAM_KEYS:
        v = snapshot.get(key)
        if v is not None and v != "" and v != []:
            params[key] = v
    return params


def apply_to_shot(
    session: Session, *, recipe: StudioRecipe, shot: StudioShot, user_id: str
) -> dict[str, Any]:
    """把配方镜头字段应用到 shot(剧情/roster 保留),返回 shot + render_one 参数。

    - applied_fields 按真实变化计算;无变化不造 revision、不写库。
    - 参考图等 CONTENT_FIELDS 之外的变化经 ensure_content_revision(force=True)
      留 revision(C1a 编辑去重口径不变,force 仅服务已判真的变化)。
    - render_mode 改变沿用 save_shots 的 superseded 语义。
    - 项目规格(width/height/fps/ckpt)不在此处改——由路由在显式选择时单独落库。
    """
    from app.services.studio import revisions as rev_svc

    snapshot = load_snapshot(recipe)
    planned: dict[str, Any] = {}
    for field in APPLICABLE_SHOT_FIELDS:
        to = _planned_value(snapshot, field)
        if to is None:
            continue  # 未知项不伪造、不覆盖
        frm = _live_value(shot, field)
        if field == "ref_images_json":
            if _strip_url_list(snapshot.get("ref_images")) != frm:
                planned[field] = to
            continue
        if frm != to:
            planned[field] = to
    if not planned:
        return {"render_params": render_params_for(recipe), "applied_fields": []}

    prior_render_mode = shot.render_mode
    for field, to in planned.items():
        setattr(shot, field, to)

    if shot.render_mode != prior_render_mode:
        # render_mode 被配方切换:沿用 save_shots 的媒体失效/superseded 语义
        shot.image_url = shot.video_url = shot.final_clip_url = ""
        shot.status = "draft"
        shot.rendered_revision_id = ""
        shot.final_visual_revision_id = shot.final_voice_revision_id = ""
        try:
            cands = json.loads(shot.candidates_json or "[]")
        except (ValueError, TypeError):
            cands = []
        superseded = False
        for c in cands:
            if isinstance(c, dict) and c.get("status") == "queued":
                c["status"] = "superseded"
                c["error"] = "render_mode 已被配方切换,本次在途生成被放弃(本地产物不回写)"
                superseded = True
        if superseded:
            shot.candidates_json = json.dumps(cands, ensure_ascii=False)

    from datetime import datetime, timezone

    shot.updated_at = datetime.now(timezone.utc)
    session.add(shot)
    session.commit()
    rev_svc.ensure_content_revision(
        session, shot, source="manual-edit", created_by=user_id, force=True
    )
    session.add(shot)
    session.commit()
    from app.models import StudioProject
    from app.services.studio import stages as stages_svc

    project = session.get(StudioProject, shot.project_id)
    if project is not None:
        stages_svc.invalidate_stages(
            session, project, stages=["storyboard", "generate", "voice", "timeline"],
            source="system", note="生成配方真实变更,下游确认失效", created_by=user_id,
        )
    return {
        "render_params": render_params_for(recipe),
        "applied_fields": sorted(planned.keys()),
    }


def recipe_out(recipe: StudioRecipe) -> dict[str, Any]:
    return {
        "id": recipe.id,
        "name": recipe.name,
        "description": recipe.description,
        "engine": recipe.engine,
        "render_mode": recipe.render_mode,
        "pipeline": recipe.pipeline,
        "pick_strategy": recipe.pick_strategy,
        "snapshot": load_snapshot(recipe),
        "source_revision_id": recipe.source_revision_id,
        "source_shot_id": recipe.source_shot_id,
        "is_default": recipe.is_default,
        "created_at": recipe.created_at.isoformat() if recipe.created_at else "",
        "updated_at": recipe.updated_at.isoformat() if recipe.updated_at else "",
    }
