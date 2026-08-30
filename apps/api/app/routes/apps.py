"""应用市场(App Market)—— 把 ComfyUI API 工作流图包装成表单应用(对标 RunningHub)。

M1 CRUD(可见性三区同 routes/agents 范式):
- GET /api/apps?category=&q=:列表,公共(user_id 空)+ 本人 + 属主上架(is_public)的
  个人应用;NSFW 应用仅 R18 上下文可见(nsfw_ctx.nsfw_allowed 门控);按 sort/name 排序。
- GET /api/apps/{id}:详情;workflow_json 仅属主/admin 透出(原始图是实现细节,
  非属主只见表单 schema/bindings/元数据)。
- POST /api/apps:创建公共应用(user_id 空),仅 admin。
- PUT /api/apps/{id}:内置一律 403;个人应用仅属主可改;公共应用(user_id 空)需 admin。
- DELETE /api/apps/{id}:同上(内置 403;个人属主可删;公共需 admin)。
- POST /api/apps/{id}/fork:复制为个人应用(user_id=本人,is_public=False)。

M2 运行器:
- POST /api/apps/{id}/run:按 params_schema 校验表单值(类型/min/max/枚举/required)
  → 按 bindings 写进 workflow_json 深拷贝的指定节点 inputs/widgets_values 叶子
  (只允许已存在的标量叶子:节点不存在/字段不存在/目标是 dict|list(拓扑连线)/
  写入复合值一律 422 —— 禁改拓扑)→ 模型依赖 _extract_required(取材于写值后的图)
  + required_nodes(空则从图自动取 class_type 集)→ pool.pick + queue_prompt
  → 建 Job(kind=submit_kind,params 存 app_id+表单快照) → usage_count+1 + 审计 app.run
  → tracker 后台追踪落库。is_nsfw 应用无 X-NSFW 头 403。
"""
from __future__ import annotations

import copy
import json
import re
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app import audit
from app.agent.tools import _extract_required
from app.comfy.client import ComfyUIError
from app.comfy.pool import WorkerPool
from app.comfy.tracker import spawn as spawn_tracker
from app.db import get_session
from app.deps import get_current_admin, get_current_user, get_pool
from app.models import App, Job, User, _now
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.routes.agents import _slugify
from app.routes.video import _raise_from_comfy_error

router = APIRouter(prefix="/apps", tags=["apps"])

_CATEGORIES = {"image", "video", "audio", "edit", "3d", "other"}
_OUTPUT_KINDS = {"image", "video", "audio"}
# 与 engine_registry params 同款表单类型;其余类型创建时拒绝,防脏 schema 进库
_PARAM_TYPES = {
    "text", "textarea", "number", "select", "switch", "slider",
    "images", "audio", "video", "loras",
}
# 绑定目标:仅允许 inputs.<name> / widgets_values.<idx> 一层叶子路径
_BINDING_FIELD_RE = re.compile(r"^(inputs|widgets_values)\.[A-Za-z0-9_]+$")
_SUBMIT_KIND_RE = re.compile(r"^[a-z0-9_]{1,64}$")


# ---------------------------------------------------------------------------
# 请求 / 响应模型
# ---------------------------------------------------------------------------
def _check_workflow(wf: dict) -> dict:
    """工作流图结构校验:非空 dict,每节点须为含 class_type 的 dict(同 raw 端点口径)。"""
    if not isinstance(wf, dict) or not wf:
        raise ValueError("workflow_json 必须是非空的 ComfyUI API 格式图")
    if len(wf) > 400:
        raise ValueError("工作流节点过多(>400)")
    bad = [k for k, v in wf.items() if not (isinstance(v, dict) and isinstance(v.get("class_type"), str))]
    if bad:
        raise ValueError(f"节点 {bad[:5]} 缺少 class_type")
    return wf


def _check_params_schema(schema: list) -> list:
    """表单 schema 校验:每项须有唯一 key + 合法 type;select 必须带 options。"""
    if not isinstance(schema, list):
        raise ValueError("params_schema 必须是数组")
    seen: set[str] = set()
    for p in schema:
        if not isinstance(p, dict):
            raise ValueError("params_schema 每项必须是对象")
        key = p.get("key")
        if not isinstance(key, str) or not key.strip():
            raise ValueError("params_schema 每项必须有非空 key")
        if key in seen:
            raise ValueError(f"参数 key 重复: {key}")
        seen.add(key)
        ptype = p.get("type", "text")
        if ptype not in _PARAM_TYPES:
            raise ValueError(f"参数 {key} 类型不支持: {ptype}")
        if ptype == "select":
            opts = p.get("options")
            if not isinstance(opts, list) or not opts:
                raise ValueError(f"select 参数 {key} 必须提供非空 options")
    return schema


def _check_bindings(bindings: dict) -> dict:
    """绑定映射校验:{表单key: {"node": 节点id, "field": "inputs.x"|"widgets_values.N"}}。"""
    if not isinstance(bindings, dict):
        raise ValueError("bindings 必须是对象")
    for key, target in bindings.items():
        if not isinstance(key, str) or not key:
            raise ValueError("bindings 的键必须是非空字符串")
        if not isinstance(target, dict):
            raise ValueError(f"绑定 {key} 必须是 {{node, field}} 对象")
        node, field = target.get("node"), target.get("field")
        if not isinstance(node, str) or not node:
            raise ValueError(f"绑定 {key} 缺少 node")
        if not isinstance(field, str) or not _BINDING_FIELD_RE.match(field):
            raise ValueError(f"绑定 {key} 的 field 必须是 inputs.<名> 或 widgets_values.<序号>")
    return bindings


def _cross_check(workflow: dict, schema: list, bindings: dict) -> None:
    """交叉校验:绑定节点须在图内、绑定表单 key 须在 schema 内(防上架即坏的应用)。"""
    node_ids = set(workflow)
    keys = {p["key"] for p in schema}
    for key, target in bindings.items():
        if target["node"] not in node_ids:
            raise ValueError(f"绑定 {key} 指向不存在的节点 {target['node']}")
        if key not in keys:
            raise ValueError(f"绑定 {key} 在 params_schema 中无对应参数")


class AppCreate(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    icon: str = Field(default="app-window", max_length=64)
    category: str = "other"
    workflow_json: dict
    params_schema: list[dict] = Field(default_factory=list)
    bindings: dict = Field(default_factory=dict)
    required_nodes: list[str] = Field(default_factory=list)
    output_kind: str = "image"
    submit_kind: str = Field(default="app_run", max_length=64)
    is_nsfw: bool = False
    is_public: bool = True
    sort: int = Field(default=100, ge=0, le=10000)

    @field_validator("category")
    @classmethod
    def _v_category(cls, v: str) -> str:
        if v not in _CATEGORIES:
            raise ValueError(f"category 须为 {sorted(_CATEGORIES)} 之一")
        return v

    @field_validator("output_kind")
    @classmethod
    def _v_output_kind(cls, v: str) -> str:
        if v not in _OUTPUT_KINDS:
            raise ValueError(f"output_kind 须为 {sorted(_OUTPUT_KINDS)} 之一")
        return v

    @field_validator("submit_kind")
    @classmethod
    def _v_submit_kind(cls, v: str) -> str:
        if not _SUBMIT_KIND_RE.match(v):
            raise ValueError("submit_kind 须为小写字母/数字/下划线(≤64)")
        return v

    @field_validator("workflow_json")
    @classmethod
    def _v_workflow(cls, v: dict) -> dict:
        return _check_workflow(v)

    @field_validator("params_schema")
    @classmethod
    def _v_schema(cls, v: list[dict]) -> list[dict]:
        return _check_params_schema(v)

    @field_validator("bindings")
    @classmethod
    def _v_bindings(cls, v: dict) -> dict:
        return _check_bindings(v)

    @field_validator("required_nodes")
    @classmethod
    def _v_required_nodes(cls, v: list[str]) -> list[str]:
        if not all(isinstance(n, str) and n for n in v):
            raise ValueError("required_nodes 每项须为非空字符串(class_type)")
        return v


class AppPatch(BaseModel):
    """部分更新;所有字段可空(空=不改)。校验规则与 AppCreate 相同,逐个非 None 校验。"""

    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    icon: str | None = Field(default=None, max_length=64)
    category: str | None = None
    workflow_json: dict | None = None
    params_schema: list[dict] | None = None
    bindings: dict | None = None
    required_nodes: list[str] | None = None
    output_kind: str | None = None
    submit_kind: str | None = Field(default=None, max_length=64)
    is_nsfw: bool | None = None
    is_public: bool | None = None
    sort: int | None = Field(default=None, ge=0, le=10000)

    @field_validator("category")
    @classmethod
    def _v_category(cls, v: str | None) -> str | None:
        if v is not None and v not in _CATEGORIES:
            raise ValueError(f"category 须为 {sorted(_CATEGORIES)} 之一")
        return v

    @field_validator("output_kind")
    @classmethod
    def _v_output_kind(cls, v: str | None) -> str | None:
        if v is not None and v not in _OUTPUT_KINDS:
            raise ValueError(f"output_kind 须为 {sorted(_OUTPUT_KINDS)} 之一")
        return v

    @field_validator("submit_kind")
    @classmethod
    def _v_submit_kind(cls, v: str | None) -> str | None:
        if v is not None and not _SUBMIT_KIND_RE.match(v):
            raise ValueError("submit_kind 须为小写字母/数字/下划线(≤64)")
        return v

    @field_validator("workflow_json")
    @classmethod
    def _v_workflow(cls, v: dict | None) -> dict | None:
        return _check_workflow(v) if v is not None else v

    @field_validator("params_schema")
    @classmethod
    def _v_schema(cls, v: list[dict] | None) -> list[dict] | None:
        return _check_params_schema(v) if v is not None else v

    @field_validator("bindings")
    @classmethod
    def _v_bindings(cls, v: dict | None) -> dict | None:
        return _check_bindings(v) if v is not None else v

    @field_validator("required_nodes")
    @classmethod
    def _v_required_nodes(cls, v: list[str] | None) -> list[str] | None:
        if v is not None and not all(isinstance(n, str) and n for n in v):
            raise ValueError("required_nodes 每项须为非空字符串(class_type)")
        return v


class AppRunRequest(BaseModel):
    values: dict = Field(default_factory=dict)  # 表单值:{参数key: 值}


class AppOut(BaseModel):
    id: str
    name: str
    description: str
    icon: str
    category: str
    params_schema: list[dict]
    bindings: dict
    required_nodes: list[str]
    output_kind: str
    submit_kind: str
    is_builtin: bool
    is_nsfw: bool
    is_public: bool
    is_mine: bool = False  # 本人应用(个人属主)
    usage_count: int
    sort: int
    # 原始工作流图:仅属主/admin 透出(详情),列表与其他人恒为 None
    workflow_json: dict | None = None


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _visible(a: App, user: User) -> bool:
    """可见性:公共(user_id 空)/ 本人 / 属主上架(is_public)的个人应用。"""
    return not a.user_id or a.user_id == user.id or a.is_public


def _get_visible(session: Session, aid: str, user: User) -> App:
    """取应用并套可见性 + NSFW 门控;不可见一律 404(不泄露存在性)。"""
    a = session.get(App, aid)
    if not a or not _visible(a, user):
        raise HTTPException(status_code=404, detail="应用不存在")
    if a.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=404, detail="应用不存在")
    return a


def _to_out(a: App, viewer: User, *, with_workflow: bool = False) -> AppOut:
    return AppOut(
        id=a.id,
        name=a.name,
        description=a.description,
        icon=a.icon,
        category=a.category,
        params_schema=a.params_schema or [],
        bindings=a.bindings or {},
        required_nodes=a.required_nodes or [],
        output_kind=a.output_kind,
        submit_kind=a.submit_kind,
        is_builtin=a.is_builtin,
        is_nsfw=a.is_nsfw,
        is_public=a.is_public,
        is_mine=bool(a.user_id) and a.user_id == viewer.id,
        usage_count=a.usage_count,
        sort=a.sort,
        workflow_json=(a.workflow_json if with_workflow else None),
    )


def _check_editable(a: App, user: User, action: str) -> None:
    """改/删权限:内置 403;个人应用仅属主;公共应用需 admin。"""
    if a.is_builtin:
        raise HTTPException(status_code=403, detail=f"内置应用不可{action}")
    if a.user_id:
        if a.user_id != user.id:
            raise HTTPException(status_code=403, detail=f"仅属主可{action}该应用")
    elif user.role != "admin":
        raise HTTPException(status_code=403, detail=f"公共应用仅管理员可{action}")


# ---------------------------------------------------------------------------
# M2 运行器:表单校验 + 写图
# ---------------------------------------------------------------------------
def _validate_params(schema: list[dict], values: dict) -> dict:
    """按 params_schema 校验/归一表单值;违规抛 422。返回含默认值补全的完整 dict。"""
    if not isinstance(values, dict):
        raise HTTPException(status_code=422, detail="values 必须是对象")
    known = {p["key"] for p in schema}
    unknown = [k for k in values if k not in known]
    if unknown:
        raise HTTPException(status_code=422, detail=f"未知参数: {unknown[:5]}")
    out: dict = {}
    for p in schema:
        key, ptype = p["key"], p.get("type", "text")
        v = values.get(key, p.get("default"))
        if p.get("required") and (v is None or v == ""):
            raise HTTPException(status_code=422, detail=f"缺少必填参数: {key}")
        if v is None:
            out[key] = None
            continue
        if ptype in ("text", "textarea"):
            if not isinstance(v, str):
                raise HTTPException(status_code=422, detail=f"参数 {key} 须为字符串")
        elif ptype in ("number", "slider"):
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise HTTPException(status_code=422, detail=f"参数 {key} 须为数字")
            mn, mx = p.get("min"), p.get("max")
            if mn is not None and v < mn:
                raise HTTPException(status_code=422, detail=f"参数 {key} 不能小于 {mn}")
            if mx is not None and v > mx:
                raise HTTPException(status_code=422, detail=f"参数 {key} 不能大于 {mx}")
        elif ptype == "select":
            opts = p.get("options") or []
            allowed = {o.get("value") if isinstance(o, dict) else o for o in opts}
            if allowed and v not in allowed:
                raise HTTPException(
                    status_code=422, detail=f"参数 {key} 须为 {sorted(allowed)} 之一"
                )
        elif ptype == "switch":
            if not isinstance(v, bool):
                raise HTTPException(status_code=422, detail=f"参数 {key} 须为布尔值")
        # images/audio/video/loras 等媒体/复合类型宽松透传(不绑图叶子,由上传链路消化)
        out[key] = v
    return out


def _write_leaf(graph: dict, key: str, target: dict, value: object) -> None:
    """把一个标量值写进图的指定叶子;任何拓扑改动企图(新键/连线/复合值)抛 422。"""
    if isinstance(value, (dict, list)):
        raise HTTPException(status_code=422, detail=f"参数 {key} 为复合值,不能写入图叶子")
    node = graph.get(target["node"])
    if not isinstance(node, dict):
        raise HTTPException(
            status_code=422, detail=f"绑定 {key} 指向不存在的节点 {target['node']}"
        )
    root, leaf = target["field"].split(".", 1)
    if root == "inputs":
        container = node.get("inputs")
        if not isinstance(container, dict) or leaf not in container:
            raise HTTPException(
                status_code=422,
                detail=f"绑定 {key} 目标 {target['node']}.inputs.{leaf} 不存在(禁新增键改拓扑)",
            )
        if isinstance(container[leaf], (dict, list)):
            raise HTTPException(
                status_code=422,
                detail=f"绑定 {key} 目标 {target['node']}.inputs.{leaf} 是连线/复合结构,禁改拓扑",
            )
        container[leaf] = value
    else:  # widgets_values
        container = node.get("widgets_values")
        if not isinstance(container, list) or not leaf.isdigit() or int(leaf) >= len(container):
            raise HTTPException(
                status_code=422, detail=f"绑定 {key} 目标 {target['node']}.widgets_values 越界"
            )
        if isinstance(container[int(leaf)], (dict, list)):
            raise HTTPException(
                status_code=422, detail=f"绑定 {key} 目标 widgets_values[{leaf}] 非叶子"
            )
        container[int(leaf)] = value


def _build_graph(workflow: dict, bindings: dict, values: dict) -> dict:
    """深拷贝工作流图并按 bindings 写入表单值(库内原件永不被改写)。"""
    graph = copy.deepcopy(workflow)
    for key, target in (bindings or {}).items():
        v = values.get(key)
        if v is None:
            continue  # 未提供且无默认:保留图内原值
        _write_leaf(graph, key, target, v)
    return graph


def _prompt_preview(a: App, values: dict) -> str:
    """Job.prompt 展示串:首个非空文本类参数值,兜底应用名。"""
    for p in a.params_schema or []:
        if p.get("type") in ("text", "textarea"):
            v = values.get(p["key"])
            if isinstance(v, str) and v.strip():
                return v[:500]
    return a.name[:500]


def _seed_of(values: dict) -> int:
    """从表单值提取 seed(文本框允许填数字字符串);取不到为 0。"""
    v = values.get("seed")
    try:
        return int(v) if v not in (None, "") else 0
    except (TypeError, ValueError):
        return 0


# ---------------------------------------------------------------------------
# 路由:M1 CRUD
# ---------------------------------------------------------------------------
@router.get("", response_model=list[AppOut])
def list_apps(
    category: str | None = Query(default=None, description="按分类过滤"),
    q: str | None = Query(default=None, max_length=120, description="名称/简介模糊搜索"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AppOut]:
    """列表:公共 + 本人(+ 属主上架的个人应用),NSFW 仅 R18 可见,按 sort/name 排序。"""
    allow_nsfw = nsfw_allowed(user)
    rows = session.exec(select(App).order_by(App.sort, App.name)).all()
    out: list[AppOut] = []
    needle = (q or "").strip().lower()
    for a in rows:
        if not _visible(a, user):
            continue
        if a.is_nsfw and not allow_nsfw:
            continue
        if category and a.category != category:
            continue
        if needle and needle not in a.name.lower() and needle not in (a.description or "").lower():
            continue
        out.append(_to_out(a, user))
    return out


@router.get("/{aid}", response_model=AppOut)
def get_app(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AppOut:
    """详情;workflow_json 仅属主/admin 透出。"""
    a = _get_visible(session, aid, user)
    privileged = a.user_id == user.id or user.role == "admin"
    return _to_out(a, user, with_workflow=privileged)


@router.post("", response_model=AppOut)
def create_app(
    body: AppCreate,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> AppOut:
    """创建公共应用(user_id 空,全员可见)。需 admin。"""
    try:
        _cross_check(body.workflow_json, body.params_schema, body.bindings)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if session.get(App, body.id):
        raise HTTPException(status_code=409, detail="应用 id 已存在")
    a = App(
        id=body.id,
        name=body.name,
        description=body.description,
        icon=body.icon,
        category=body.category,
        workflow_json=body.workflow_json,
        params_schema=body.params_schema,
        bindings=body.bindings,
        required_nodes=body.required_nodes,
        output_kind=body.output_kind,
        submit_kind=body.submit_kind,
        is_builtin=False,  # API 创建的永远是自定义(内置由代码播种)
        is_nsfw=body.is_nsfw,
        is_public=body.is_public,
        user_id="",  # 公共
        sort=body.sort,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a, admin, with_workflow=True)


@router.put("/{aid}", response_model=AppOut)
def update_app(
    aid: str,
    body: AppPatch,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AppOut:
    """改应用;内置 403;个人应用属主可改;公共应用需 admin。is_builtin/user_id 不可变。"""
    a = _get_visible(session, aid, user)
    _check_editable(a, user, "修改")
    # 图/schema/绑定任一变更时,对合并结果做交叉校验(防改出绑定悬空的应用)
    if body.workflow_json is not None or body.params_schema is not None or body.bindings is not None:
        try:
            _cross_check(
                body.workflow_json if body.workflow_json is not None else (a.workflow_json or {}),
                body.params_schema if body.params_schema is not None else (a.params_schema or []),
                body.bindings if body.bindings is not None else (a.bindings or {}),
            )
        except ValueError as e:
            raise HTTPException(status_code=422, detail=str(e)) from e
    for f in (
        "name", "description", "icon", "category", "workflow_json", "params_schema",
        "bindings", "required_nodes", "output_kind", "submit_kind",
        "is_nsfw", "is_public", "sort",
    ):
        val = getattr(body, f)
        if val is not None:
            setattr(a, f, val)
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    privileged = a.user_id == user.id or user.role == "admin"
    return _to_out(a, user, with_workflow=privileged)


@router.delete("/{aid}")
def delete_app(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """删应用;内置 403;个人应用属主可删;公共应用需 admin。"""
    a = _get_visible(session, aid, user)
    _check_editable(a, user, "删除")
    session.delete(a)
    session.commit()
    return {"ok": True, "id": aid}


@router.post("/{aid}/fork", response_model=AppOut)
def fork_app(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AppOut:
    """复制为个人应用(user_id=本人,is_public=False,is_builtin=False,usage_count 归零)。"""
    src = _get_visible(session, aid, user)
    new_id = f"{_slugify(src.id)[:40]}-{uuid.uuid4().hex[:6]}"
    while session.get(App, new_id):  # slug 撞车兜底(概率极低,循环重建)
        new_id = f"{_slugify(src.id)[:40]}-{uuid.uuid4().hex[:6]}"
    a = App(
        id=new_id,
        name=src.name,
        description=src.description,
        icon=src.icon,
        category=src.category,
        workflow_json=copy.deepcopy(src.workflow_json or {}),
        params_schema=copy.deepcopy(src.params_schema or []),
        bindings=copy.deepcopy(src.bindings or {}),
        required_nodes=list(src.required_nodes or []),
        output_kind=src.output_kind,
        submit_kind=src.submit_kind,
        is_builtin=False,
        is_nsfw=src.is_nsfw,
        is_public=False,
        user_id=user.id,
        usage_count=0,
        sort=src.sort,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a, user, with_workflow=True)


# ---------------------------------------------------------------------------
# 路由:M2 运行器
# ---------------------------------------------------------------------------
@router.post("/{aid}/run")
async def run_app(
    aid: str,
    body: AppRunRequest,
    pool: WorkerPool = Depends(get_pool),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> dict:
    """运行应用:校验表单 → 写图 → 提交 worker → 建档 Job + usage_count+1 + 审计。"""
    a = session.get(App, aid)
    if not a or not _visible(a, user):
        raise HTTPException(status_code=404, detail="应用不存在")
    # is_nsfw 应用须 R18 上下文(与详情 404 不泄露不同:run 是动作,显式 403 引导去专页)
    if a.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="该操作为 R18 内容,仅限 NSFW 专区使用")
    enforce_generation_rate_limit(user)
    values = _validate_params(a.params_schema or [], body.values)
    graph = _build_graph(a.workflow_json or {}, a.bindings or {}, values)
    if not graph:
        raise HTTPException(status_code=422, detail="应用未配置工作流图")
    # 模型依赖从写值后的图提取(绑定可能改写模型引用叶子);节点依赖空则从图自动取
    required = _extract_required(graph)
    nodes = set(a.required_nodes or []) or {
        n["class_type"] for n in graph.values() if isinstance(n, dict) and n.get("class_type")
    }
    try:
        client = await pool.pick(required=required, required_nodes=nodes)
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    client_id = uuid.uuid4().hex
    try:
        prompt_id = await client.queue_prompt(graph, client_id)
    except ComfyUIError as e:
        _raise_from_comfy_error(e)

    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker=client.base_url,
        kind=a.submit_kind or "app_run",
        status="queued",
        prompt=_prompt_preview(a, values),
        seed=_seed_of(values),
        nsfw=a.is_nsfw,
        params=json.dumps({"app_id": a.id, "values": values}, ensure_ascii=False),
    )
    a.usage_count += 1
    a.updated_at = _now()
    session.add(job)
    session.add(a)
    audit.record(
        session, user=user, action="app.run", target_type="app", target_id=a.id,
        summary=f"运行应用:{a.name}",
        detail={"app_id": a.id, "prompt_id": prompt_id, "usage_count": a.usage_count},
    )
    session.commit()

    # 服务端后台追踪结果落库,不依赖客户端 SSE(同 generate 系端点)
    spawn_tracker(client, prompt_id)

    return {
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "app_id": a.id,
        "usage_count": a.usage_count,
    }
