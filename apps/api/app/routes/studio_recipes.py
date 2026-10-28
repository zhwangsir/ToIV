"""C1b 用户生成配方(StudioRecipe)REST 接口。

全部读写 user_id 隔离(他人 404 不泄露存在性);快照/导入/导出逻辑在
services/studio/recipes.py。复用 routes/studio 的 _get_shot/_shot_out(函数
级懒导入,避免与 studio 路由模块循环引用)。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import StudioProject, StudioRecipe, User
from app.services.studio import recipes as recipe_svc

logger = logging.getLogger(__name__)
router = APIRouter()


def _get_shot_checked(session: Session, shot_id: str, user: User):
    from app.routes.studio import _get_shot  # 懒导入:避免路由模块循环引用

    return _get_shot(session, shot_id, user)


def _recipe_or_404(session: Session, rid: str, user: User) -> StudioRecipe:
    try:
        return recipe_svc.get_recipe(session, rid, user.id)
    except LookupError as e:
        raise HTTPException(status_code=404, detail=str(e)) from e


def _wrap(fn, *args, **kwargs):
    from app.services.studio.stages import StageConflictError

    try:
        return fn(*args, **kwargs)
    except StageConflictError as e:
        raise HTTPException(status_code=409, detail=str(e)) from e
    except recipe_svc.RecipeError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e


class RecipeCreateFromShot(BaseModel):
    shot_id: str = Field(..., min_length=1, max_length=64)
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=1000)


@router.post("/studio/recipes/from-shot")
def create_recipe_from_shot(
    body: RecipeCreateFromShot,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """从成功 shot 创建配方:快照取 render 修订(生成输入),出处诚实标注。"""
    shot = _get_shot_checked(session, body.shot_id, user)
    return recipe_svc.recipe_out(
        _wrap(
            recipe_svc.create_from_shot,
            session,
            user_id=user.id,
            shot=shot,
            name=body.name or "",
            description=body.description or "",
        )
    )


@router.get("/studio/recipes")
def list_recipes(
    engine: str | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """我的配方列表(可按引擎过滤);空集合返回空数组。"""
    rows = recipe_svc.list_recipes(session, user.id, engine=engine)
    return {"recipes": [recipe_svc.recipe_out(r) for r in rows]}


@router.get("/studio/recipes/{rid}")
def get_recipe(
    rid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    return recipe_svc.recipe_out(_recipe_or_404(session, rid, user))


class RecipePatch(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    description: str | None = Field(default=None, max_length=1000)
    prompt: str | None = Field(default=None, max_length=4000)
    negative: str | None = Field(default=None, max_length=2000)
    pick_strategy: str | None = Field(default=None, max_length=16)


@router.patch("/studio/recipes/{rid}")
def patch_recipe(
    rid: str,
    body: RecipePatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """编辑名称/描述/prompt(+negative)/pick_strategy。"""
    recipe = _recipe_or_404(session, rid, user)
    recipe = _wrap(
        recipe_svc.update_recipe,
        session, recipe,
        name=body.name, description=body.description,
        prompt=body.prompt, negative=body.negative,
        pick_strategy=body.pick_strategy,
    )
    return recipe_svc.recipe_out(recipe)


class RecipeClone(BaseModel):
    name: str | None = Field(default=None, max_length=100)


@router.post("/studio/recipes/{rid}/clone")
def clone_recipe(
    rid: str,
    body: RecipeClone | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    recipe = _recipe_or_404(session, rid, user)
    dup = recipe_svc.clone_recipe(session, recipe, (body.name if body else None) or "")
    return recipe_svc.recipe_out(dup)


@router.post("/studio/recipes/{rid}/set-default")
def set_default_recipe(
    rid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """设为默认:每 (user, engine) 唯一,同事务清同引擎旧默认。"""
    recipe = _recipe_or_404(session, rid, user)
    return recipe_svc.recipe_out(recipe_svc.set_default(session, recipe))


@router.delete("/studio/recipes/{rid}")
def delete_recipe(
    rid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """删除配方:只删配方行,不碰源镜/产物。"""
    recipe = _recipe_or_404(session, rid, user)
    recipe_svc.delete_recipe(session, recipe)
    return {"deleted": True, "id": rid}


@router.get("/studio/recipes/{rid}/export")
def export_recipe(
    rid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    recipe = _recipe_or_404(session, rid, user)
    return recipe_svc.export_recipe(recipe)


@router.post("/studio/recipes/import")
def import_recipe(
    body: dict,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """导入导出 JSON:来源 id 清空、非默认;校验失败 422(不落半成品)。"""
    recipe = _wrap(recipe_svc.import_recipe, session, user.id, body)
    return recipe_svc.recipe_out(recipe)


@router.get("/studio/recipes/{rid}/diff")
def recipe_diff(
    rid: str,
    shot_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """配方与指定 shot 的逐字段差异(from=live shot,to=配方)。"""
    recipe = _recipe_or_404(session, rid, user)
    shot = _get_shot_checked(session, shot_id, user)
    return recipe_svc.diff_vs_shot(recipe, shot)


class RecipeApply(BaseModel):
    shot_id: str = Field(..., min_length=1, max_length=64)
    # C1a 乐观并发:与 shot.current_revision_id 不符 → 409(不静默覆盖人工编辑)
    expected_revision: str | None = Field(default=None, max_length=64)
    # 项目规格默认不动;显式 True 才把 width/height/fps/ckpt 写入项目
    apply_project_specs: bool = False


@router.post("/studio/recipes/{rid}/apply")
def apply_recipe(
    rid: str,
    body: RecipeApply,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """应用配方到 shot:保留剧情/roster;留 revision(相同内容去重);
    render_mode 改变沿用 superseded 语义。返回 shot + render_one 可用参数。"""
    from app.routes.studio import _shot_out  # 懒导入:避免路由模块循环引用

    recipe = _recipe_or_404(session, rid, user)
    shot = _get_shot_checked(session, body.shot_id, user)
    if body.expected_revision is not None and (
        shot.current_revision_id or ""
    ) != body.expected_revision:
        raise HTTPException(
            status_code=409,
            detail=(
                "分镜已被其他修改更新"
                f"(current={shot.current_revision_id or 'unknown'})"
            ),
        )
    result = _wrap(
        recipe_svc.apply_to_shot, session,
        recipe=recipe, shot=shot, user_id=user.id,
    )
    session.refresh(shot)
    project = session.get(StudioProject, shot.project_id)
    project_specs_changed: list[str] = []
    if body.apply_project_specs and project is not None:
        snapshot = recipe_svc.load_snapshot(recipe)
        # 显式选择也不写入非法规格:与导入同一 ProjectPatch 校验真源
        try:
            recipe_svc._validate_specs(snapshot)
        except recipe_svc.RecipeError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
        from datetime import datetime, timezone

        for key, attr in (("width", "width"), ("height", "height"),
                          ("fps", "fps"), ("ckpt_name", "ckpt_name")):
            value = snapshot.get(key)
            if value is None:
                continue  # 未知项不伪造
            if getattr(project, attr) != value:
                setattr(project, attr, value)
                project_specs_changed.append(key)
        if project_specs_changed:
            project.updated_at = datetime.now(timezone.utc)
            session.add(project)
            session.commit()
    return {
        "shot": _shot_out(shot, session),
        "render_params": result["render_params"],
        "applied_fields": result["applied_fields"],
        "project_specs_changed": project_specs_changed,
    }
