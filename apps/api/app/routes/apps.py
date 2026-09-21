"""应用市场(App Market)—— 把 ComfyUI API 工作流图包装成表单应用(对标 RunningHub)。

M1 CRUD(可见性三区同 routes/agents 范式):
- GET /api/apps?category=&q=&use_case=&featured=:列表,公共(user_id 空)+ 本人 + 属主上架(is_public)的
  个人应用;NSFW 应用仅 R18 上下文可见(nsfw_ctx.nsfw_allowed 门控);按 sort/name 排序。
  use_case/featured 为市场策展层过滤(2026-09-12,见 routes/app_curation)。
  列表 slim:params_schema=[] / bindings={} / required_nodes=[] / workflow_json=None
  (1166 张 rh-* H3 社区卡的图 schema 否则会撑成数 MB)。运行页走详情拿完整 schema。
- GET /api/apps/{id}:详情;workflow_json+params_schema+bindings 对所有可见用户透出
  (2026-09-02 产品决策:运行页「工作流」模式把流程图展现给用户,最可控;可见性/NSFW 门控不变)。
- POST /api/apps:创建公共应用(user_id 空),仅 admin。
- PUT /api/apps/{id}:内置一律 403;个人应用仅属主可改;公共应用(user_id 空)需 admin。
- DELETE /api/apps/{id}:同上(内置 403;个人属主可删;公共需 admin)。
- POST /api/apps/{id}/fork:复制为个人应用(user_id=本人,is_public=False)。

M6 封面(RunningHub 化,2026-09-06):
- POST /api/apps/{id}/cover:上传封面图(multipart file,仅 admin;png/jpg/webp/gif
  ≤8MB,魔数校验),落 content_subdir("app-covers"),cover_url 写库;替换时删旧文件。
- GET /api/apps/covers/file/{name}:封面回读(登录用户;<img> 走 ?token= 回退)。
- POST /api/apps/covers/generate:admin 触发批量生成(services/app_covers;
  execute=false 干跑只回待生成清单;expand_top>0 对 usage_count 头部 rh-* 家族外扩;
  单飞,运行中重复触发 409)。

- POST /api/apps/{id}/open-in-comfy:把 workflow_json 转为 UI 图并上传到画布
  worker userdata,返回 workflow_name 供 Canvas iframe ?workflow= 自动加载。

M2 运行器:
- POST /api/apps/{id}/run:按 params_schema 校验表单值(类型/min/max/枚举/required)
  → 按 bindings 写进 workflow_json 深拷贝的指定节点 inputs/widgets_values 叶子
  (只允许已存在的标量叶子:节点不存在/字段不存在/目标是 dict|list(拓扑连线)/
  写入复合值一律 422 —— 禁改拓扑。images/audio/video 文件名数组可绑列表:
  按序写入 N 个叶子,未占用的预置 Load* 节点从提交图省略)→ 模型依赖
  _extract_required(取材于写值后的图)
  + required_nodes(空则从图自动取 class_type 集)→ pool.pick + queue_prompt
  → 建 Job(kind=submit_kind,params 存 app_id+表单快照) + 审计 app.run
  → tracker 后台追踪落库;usage_count 只在 Job 到 done 时 +1
  (tracker.mark_done 检测 params.app_id,失败/取消不计)。is_nsfw 应用无 X-NSFW 头 403。
"""
from __future__ import annotations

import copy

import httpx
import json
import logging
import re
import time
import uuid
from urllib.parse import urlsplit

from fastapi import APIRouter, Depends, HTTPException, Query, Request, UploadFile
from fastapi.encoders import jsonable_encoder
from fastapi.responses import Response

from app.services import apps_list_cache
from pydantic import BaseModel, Field, field_validator
from sqlmodel import Session, select

from app import audit
from app.agent.llm import LLMError
from app.agent.tools import _extract_required
from app.comfy.client import ComfyUIClient, ComfyUIError, get_image_bytes_any
from app.comfy.pool import WorkerPool
from app.comfy.tracker import _SAVE_OR_COMBINE_TYPES, spawn as spawn_tracker
from app.config import get_settings
from app.db import get_session
from app.deps import get_current_admin, get_current_user, get_pool
from app.models import App, AppGuide, Job, User, _now
from app.workflows.h3_video import normalize_h3_r2v_autogrow_inputs
from app.services.provenance import (
    build_app_source_links,
    extract_rh_webapp_id,
    is_admin_user,
    public_app_description,
    rh_webapp_url,
)
from app.nsfw_ctx import nsfw_allowed
from app.ratelimit import enforce_generation_rate_limit
from app.routes.agents import _slugify
from app.routes.images import _ranged_response
from app.routes.upload import _sniff_media
from app.routes.video import _raise_from_comfy_error
from app.services import app_covers as covers_svc
from app.services.app_fingerprint import fingerprint as graph_fingerprint
from app.services import h3_accel
from app.services.app_content_modes import (
    SFW_NSFW_TWINS,
    content_modes_for,
    nsfw_variant_id_for,
)
from app.services.app_packager import ICON_WHITELIST, package_with_llm
from app.services.workflow_analyzer import analyze_workflow
from app.services.workflow_convert import api_to_ui, is_api_format, is_ui_format
from app.storage import content_subdir

logger = logging.getLogger(__name__)

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


def _check_one_binding(key: str, target: object) -> dict:
    """单个 {node, field} 绑定校验。"""
    if not isinstance(target, dict):
        raise ValueError(f"绑定 {key} 必须是 {{node, field}} 对象")
    node, field = target.get("node"), target.get("field")
    if not isinstance(node, str) or not node:
        raise ValueError(f"绑定 {key} 缺少 node")
    if not isinstance(field, str) or not _BINDING_FIELD_RE.match(field):
        raise ValueError(f"绑定 {key} 的 field 必须是 inputs.<名> 或 widgets_values.<序号>")
    return target


def _binding_targets(target: object) -> list[dict]:
    """绑定值归一成 [{node, field}, ...];单对象视为长度 1 的列表。"""
    if isinstance(target, list):
        return [t for t in target if isinstance(t, dict)]
    if isinstance(target, dict):
        return [target]
    return []


def _check_bindings(bindings: dict) -> dict:
    """绑定映射校验:{表单key: {node,field} 或 [{node,field}, ...]}。

    列表形态给 images/audio/video 多文件扇出(按序写入预置 Load* 叶子)。
    """
    if not isinstance(bindings, dict):
        raise ValueError("bindings 必须是对象")
    for key, target in bindings.items():
        if not isinstance(key, str) or not key:
            raise ValueError("bindings 的键必须是非空字符串")
        if isinstance(target, list):
            if not target:
                raise ValueError(f"绑定 {key} 的列表不能为空")
            for i, t in enumerate(target):
                _check_one_binding(f"{key}[{i}]", t)
        else:
            _check_one_binding(key, target)
    return bindings


def _cross_check(workflow: dict, schema: list, bindings: dict) -> None:
    """交叉校验:绑定节点须在图内、绑定表单 key 须在 schema 内(防上架即坏的应用)。"""
    node_ids = set(workflow)
    keys = {p["key"] for p in schema}
    for key, target in bindings.items():
        if key not in keys:
            raise ValueError(f"绑定 {key} 在 params_schema 中无对应参数")
        for t in _binding_targets(target):
            if t.get("node") not in node_ids:
                raise ValueError(f"绑定 {key} 指向不存在的节点 {t.get('node')}")


class AppCreate(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    icon: str = Field(default="app-window", max_length=64)
    cover_url: str = Field(default="", max_length=500)  # 封面 URL(可用 /api/apps/{id}/cover 上传)
    author: str = Field(default="", max_length=120)
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
    cover_url: str | None = Field(default=None, max_length=500)
    author: str | None = Field(default=None, max_length=120)
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
    # sfw|nsfw — 合并卡在 runner 内切换;缺省按应用 is_nsfw
    content_mode: str | None = Field(default=None, max_length=8)
    # H3 智能加速档(2026-09-12):off|lossless|balanced|extreme;仅 H3 家族应用可非 off
    acceleration: str = Field(default="off", max_length=16)

    @field_validator("acceleration")
    @classmethod
    def _v_acceleration(cls, v: str) -> str:
        return h3_accel.validate_acceleration(v)


class AppSourceLink(BaseModel):
    """admin 出处外链(RH / HF / Civitai / 描述内 URL)。"""
    label: str
    url: str


class AppOut(BaseModel):
    id: str
    name: str
    description: str
    icon: str
    cover_url: str = ""  # 封面图 URL(空 = 前端回退图标);slim 列表也下发
    author: str = ""  # 作者(内置="ToIV 官方";rh-* 社区卡=原作者)
    category: str
    params_schema: list[dict]
    bindings: dict
    required_nodes: list[str]
    output_kind: str
    submit_kind: str
    is_builtin: bool
    is_nsfw: bool
    is_public: bool
    # 合并 SFW+R18:市场封面同时打 SFW/R18 标签;runner 可切换
    content_modes: list[str] = Field(default_factory=list)  # ["sfw"] | ["nsfw"] | ["sfw","nsfw"]
    nsfw_variant_id: str | None = None  # SFW 父卡指向软隐藏的 R18 twin
    is_mine: bool = False  # 本人应用(个人属主)
    usage_count: int
    sort: int
    # 原始工作流图:仅属主/admin 透出(详情),列表与其他人恒为 None
    workflow_json: dict | None = None
    # RunningHub webappId:仅 admin(普通用户 description 已剥离 RH:{id})
    rh_webapp_id: str | None = None
    # RH 详情外链 + 引擎/描述源链:仅 admin;非 admin 恒 None/[]
    rh_webapp_url: str | None = None
    source_links: list[AppSourceLink] = Field(default_factory=list)
    # 说明卡摘要:仅透已发布(published)说明书;draft 视同无
    has_guide: bool = False
    guide_purpose: str | None = None
    # 市场策展层(2026-09-12):用途分类(空=未打标)+ 精选合集位
    use_case: str = ""
    featured: bool = False
    # 自愈闭环(2026-09-15):导入即测烟测结果(市场可展示可用性徽标)
    smoke_status: str = ""
    smoke_cls: str = ""
    smoke_at: str | None = None
    # 功能归组(2026-09-15):同指纹变体折叠
    fingerprint: str = ""
    variant_count: int = 0
    is_variant: bool = False


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _visible(a: App, user: User) -> bool:
    """可见性:目录应用(user_id 空)须 is_public;个人应用=本人或属主上架。

    2026-09-08:目录应用也尊重 is_public,便于下架无法本机跑通的 RH/死卡,
    而不必物理删除(内置仍不可删,但可隐藏)。
    管理员可看见已 soft-hide 的目录应用(user_id 空),以便再上架;不因此窥视他人私有应用。
    """
    if a.user_id:
        return a.user_id == user.id or a.is_public
    if getattr(user, "role", None) == "admin":
        return True
    return bool(a.is_public)


def _get_visible(session: Session, aid: str, user: User) -> App:
    """取应用并套可见性 + NSFW 门控;不可见一律 404(不泄露存在性)。"""
    a = session.get(App, aid)
    if not a or not _visible(a, user):
        raise HTTPException(status_code=404, detail="应用不存在")
    if a.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=404, detail="应用不存在")
    return a


def _to_out(a: App, viewer: User, *, with_workflow: bool = False, slim: bool = False,
            guide: AppGuide | None = None) -> AppOut:
    """slim=True 给列表:不下发 params_schema/bindings/required_nodes(H3 社区卡 1000+ 份图 schema 会撑爆 payload)。
    运行页走 GET /api/apps/{id}(with_workflow=True)拿完整 schema。
    出处门控:普通用户 description 剥离 RH:{webappId};rh_webapp_id/url/source_links 仅 admin。
    guide:调用方预取的说明书(列表一次性 map 传入防 N+1);仅 published 透出摘要。"""
    admin = is_admin_user(viewer)
    wid = extract_rh_webapp_id(a.description) if admin else ""
    links = build_app_source_links(
        app_id=a.id,
        description=a.description,
        rh_webapp_id=wid or None,
        is_admin=admin,
    )
    guide_published = guide is not None and guide.status == "published"
    return AppOut(
        id=a.id,
        name=a.name,
        description=public_app_description(a.description, is_admin=admin),
        icon=a.icon,
        cover_url=a.cover_url or "",
        author=a.author or "",
        category=a.category,
        params_schema=[] if slim else (a.params_schema or []),
        bindings={} if slim else (a.bindings or {}),
        required_nodes=[] if slim else (a.required_nodes or []),
        output_kind=a.output_kind,
        submit_kind=a.submit_kind,
        is_builtin=a.is_builtin,
        is_nsfw=a.is_nsfw,
        is_public=a.is_public,
        content_modes=content_modes_for(
            a.id,
            is_nsfw=bool(a.is_nsfw),
            has_twin=bool(nsfw_variant_id_for(a.id)),
        ),
        nsfw_variant_id=nsfw_variant_id_for(a.id),
        is_mine=bool(a.user_id) and a.user_id == viewer.id,
        usage_count=a.usage_count,
        sort=a.sort,
        workflow_json=(a.workflow_json if with_workflow else None),
        rh_webapp_id=(wid or None) if admin else None,
        rh_webapp_url=(rh_webapp_url(wid) or None) if admin else None,
        source_links=[AppSourceLink(**x) for x in links] if admin else [],
        has_guide=guide_published,
        guide_purpose=(guide.purpose or "") if guide_published else None,
        use_case=a.use_case or "",
        featured=bool(a.featured),
        smoke_status=a.smoke_status or "",
        smoke_cls=a.smoke_cls or "",
        smoke_at=(a.smoke_at.isoformat(timespec="seconds") if a.smoke_at else None),
        fingerprint=a.fingerprint or "",
    )


def _check_editable(a: App, user: User, action: str) -> None:
    """改/删权限:内置默认 403(管理员隐藏/上架 is_public 除外);个人应用仅属主;公共应用需 admin。"""
    if a.is_builtin:
        if action == "修改" and user.role == "admin":
            return  # admin 可改内置(实际 PUT 白名单仍收窄到 is_public/sort 等)
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
        if p.get("required") and _is_missing_value(v):
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
        elif ptype in ("images", "audio", "video"):
            files = _as_filenames(key, v)
            mx = p.get("max")
            if mx is not None:
                try:
                    cap = int(mx)
                except (TypeError, ValueError):
                    cap = None
                else:
                    if len(files) > cap:
                        raise HTTPException(
                            status_code=422, detail=f"参数 {key} 最多 {cap} 个文件"
                        )
        # loras 等其余复合类型宽松透传
        out[key] = v
    return out


def _is_missing_value(v: object) -> bool:
    """必填缺口:None/空串/全空媒体数组都算没填。"""
    if v is None or v == "":
        return True
    if isinstance(v, list):
        return not any(isinstance(x, str) and x.strip() for x in v)
    return False


def _as_filenames(key: str, value: object) -> list[str]:
    """images/audio/video 表单值 → 非空文件名列表(空串槽位跳过,紧凑填)。"""
    if value is None or value == "":
        return []
    if isinstance(value, str):
        return [value] if value.strip() else []
    if isinstance(value, dict):
        raise HTTPException(status_code=422, detail=f"参数 {key} 为复合值,不能写入图叶子")
    if not isinstance(value, list):
        raise HTTPException(status_code=422, detail=f"参数 {key} 须为文件名或文件名数组")
    out: list[str] = []
    for i, item in enumerate(value):
        if item is None or item == "":
            continue
        if not isinstance(item, str):
            raise HTTPException(
                status_code=422, detail=f"参数 {key}[{i}] 须为文件名字符串"
            )
        if item.strip():
            out.append(item)
    return out


def _coerce_for_leaf(key: str, existing: object, value: object) -> object | None:
    """按目标叶子的既有类型窄化表单值;返回 None 表示「不写,保留图内原值」。

    背景:seed 等 text 参数允许填数字字符串(engine_registry._seed 同款表单习惯),
    而 ComfyUI 对 INT/FLOAT 输入做 isinstance 校验,文本直写会被 worker 拒绝:
    - 空串 → 不写(语义=留空用模板默认,与 `v is None` 的跳过一致);
    - int 叶子 ← 数字串 / 整值 float → int(非整值/不可解析 422);
    - float 叶子 ← 数字串 → float;
    - 其他组合原样透传(同类型直写;文本叶子的值 _validate_params 已保 str)。
    """
    if isinstance(existing, bool) or not isinstance(existing, (int, float)):
        # ComfyLiterals Int.Number 等 STRING 叶子:表单 number 常是 int/float,需落成字符串
        if isinstance(existing, str) and isinstance(value, (int, float)) and not isinstance(value, bool):
            # 整值 float → 不带小数的数字串,避免 "24.0" 再被下游 int() 挑剔
            if isinstance(value, float) and value == int(value):
                return str(int(value))
            return str(value)
        return value
    if isinstance(value, str):
        if not value.strip():
            return None
        try:
            num = float(value.strip())
        except ValueError:
            raise HTTPException(
                status_code=422, detail=f"参数 {key} 须为数字(绑定目标是数值叶子)"
            ) from None
        if isinstance(existing, int):
            if num != int(num):
                raise HTTPException(status_code=422, detail=f"参数 {key} 须为整数")
            return int(num)
        return num
    if isinstance(value, bool):
        raise HTTPException(status_code=422, detail=f"参数 {key} 须为数字")
    if isinstance(existing, int) and isinstance(value, float):
        if value != int(value):
            raise HTTPException(status_code=422, detail=f"参数 {key} 须为整数")
        return int(value)
    return value


def _write_leaf(graph: dict, key: str, target: dict, value: object) -> None:
    """把一个标量值写进图的指定叶子;任何拓扑改动企图(新键/连线/复合值)抛 422。"""
    # 单绑定 + 单元素媒体数组:窄化为字符串再写叶子。多文件扇出走 _build_graph。
    if isinstance(value, list):
        if len(value) == 1 and isinstance(value[0], str):
            value = value[0]
        else:
            raise HTTPException(
                status_code=422,
                detail=f"参数 {key} 为复合值,不能写入图叶子(多文件请用列表绑定扇出)",
            )
    if isinstance(value, dict):
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
        coerced = _coerce_for_leaf(key, container[leaf], value)
        if coerced is None:
            return  # 空串写数值叶子 = 留空,保留图内模板值
        container[leaf] = coerced
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
        coerced = _coerce_for_leaf(key, container[int(leaf)], value)
        if coerced is None:
            return
        container[int(leaf)] = coerced


def _omit_media_slot(graph: dict, node_id: object) -> None:
    """去掉未使用的媒体加载节点及其连线(含 LoadVideo 配对的 GetVideoComponents)。

    内置 r2v 图预置 9 图 + 3 视频对 + 3 音频槽;提交时只保留有文件名的槽,
    避免 dummy 文件名被 worker 当真去加载。
    """
    nid = str(node_id or "")
    if not nid or nid not in graph:
        return
    drop = {nid}
    for other_id, node in graph.items():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") != "GetVideoComponents":
            continue
        video = (node.get("inputs") or {}).get("video")
        if isinstance(video, list) and video and str(video[0]) == nid:
            drop.add(str(other_id))
    for _oid, node in list(graph.items()):
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for k, v in list(inputs.items()):
            if isinstance(v, list) and v and str(v[0]) in drop:
                del inputs[k]
    for d in drop:
        graph.pop(d, None)


# RH 导入残留的「原站用户媒体」Load* 节点:文件名为内容哈希(sha256,或 pasted/<hash>),
# 未绑定任何表单槽——文件只存在于 RH 原站,任何 worker 都没有,提交必 502(转运)
# 或 422(校验 Invalid image file → 主保存节点判死)。2026-09-13 wave10-16 实证 11 例。
# 剥离规则(保守,只处理已实证形态):
#   - 无下游引用的死节点:直接剥;
#   - 下游是 MiniMaxH3* 的 ref_images./ref_audios./ref_videos./ref_video_audios. 槽
#     或 first_frame/last_frame(均 optional):删键即安全;
#   - 经媒体预处理节点(ImageResizeKJv2/AudioCrop/TrimAudioDuration/GetVideoComponents)
#     转一手再到上述槽位:级联剥掉预处理节点;
#   - 其他任何下游形态(绑定缺失的必需输入等)不剥,维持原失败行为。
# toivref-<32hex>:ToIV 导入期生成的引用图,源媒体已不在 ToIV 存储,
# 任何 worker 都转运不到(wave4/16 实证 4 例,LoadImage Invalid image file)。
_STALE_RH_HASH_RE = re.compile(r"^[0-9a-f]{64}$")
_STALE_TOIVREF_RE = re.compile(r"^toivref-[0-9a-f]{32}$")
_H3_REF_SLOT_PREFIXES = ("ref_images.", "ref_audios.", "ref_videos.", "ref_video_audios.")
_H3_FRAME_INPUTS = {"first_frame", "last_frame"}
_RH_MEDIA_PREPROCESSORS = {
    "ImageResizeKJv2",
    "AudioCrop",
    "TrimAudioDuration",
    "GetVideoComponents",
}


def _stale_rh_media_filename(node: dict) -> str | None:
    """节点媒体文件名输入;非 Load* / 无媒体文件名返回 None。"""
    ct = node.get("class_type")
    if not isinstance(ct, str):
        return None
    keys = _MEDIA_LOADER_KEYS.get(ct)
    if keys is None and "Load" in ct:
        keys = ("image", "video", "audio", "file")
    if not keys:
        return None
    inputs = node.get("inputs") or {}
    if not isinstance(inputs, dict):
        return None
    for k in keys:
        v = inputs.get(k)
        if isinstance(v, str) and v.strip():
            return v.strip()
    return None


def _normalize_stale_rh_media(graph: dict, bindings: dict) -> None:
    """剥离未绑定且带内容哈希文件名的 Load* 节点(RH 原站残留媒体)。"""
    if not isinstance(graph, dict) or not graph:
        return
    bound: set[str] = set()
    for target in (bindings or {}).values():
        slots = target if isinstance(target, list) else [target]
        for slot in slots:
            if isinstance(slot, dict) and slot.get("node"):
                bound.add(str(slot["node"]))
    drop: set[str] = set()
    keep: set[str] = set()

    def _refs_to(nid: str) -> list[tuple[str, dict, str]]:
        out = []
        for cid, cnode in graph.items():
            if cid == nid or cid in drop or not isinstance(cnode, dict):
                continue
            inputs = cnode.get("inputs")
            if not isinstance(inputs, dict):
                continue
            for key, v in inputs.items():
                if isinstance(v, list) and len(v) >= 2 and str(v[0]) == nid:
                    out.append((cid, cnode, key))
        return out

    def _strip(nid: str) -> bool:
        if nid in drop:
            return True
        if nid in keep or nid not in graph:
            return False
        detach: list[tuple[str, str]] = []  # (consumer_id, key) 直接删键
        cascade: list[str] = []  # 需级联剥离的预处理节点
        for cid, cnode, key in _refs_to(nid):
            cct = cnode.get("class_type") or ""
            if cct.startswith(("MiniMaxH3", "MinimaxH3")) and (
                key.startswith(_H3_REF_SLOT_PREFIXES) or key in _H3_FRAME_INPUTS
            ):
                detach.append((cid, key))
            elif cct in _RH_MEDIA_PREPROCESSORS and key in ("image", "audio", "video"):
                cascade.append(cid)
            else:
                keep.add(nid)
                return False
        for cid in cascade:
            if cid in keep or not _strip(cid):
                keep.add(nid)
                return False
        for cid, key in detach:
            inputs = graph[cid].get("inputs")
            if isinstance(inputs, dict) and key in inputs:
                del inputs[key]
        drop.add(nid)
        return True

    for nid, node in list(graph.items()):
        if not isinstance(node, dict) or str(nid) in bound:
            continue
        fname = _stale_rh_media_filename(node)
        if not fname:
            continue
        # 仅内容哈希名才可能是 RH 原站残留;普通文件名 Load 节点不动
        stem = fname.rsplit("/", 1)[-1].rsplit(".", 1)[0]
        if _STALE_RH_HASH_RE.match(stem) or _STALE_TOIVREF_RE.match(stem):
            _strip(str(nid))
    for d in drop:
        graph.pop(d, None)




# ethanfel MelBandRoFormer: registry 同 basename 的本地文件不进 combo(有意去重),
# RH 图却写 FS 相对路径 → value_not_in_list → Comfy 部分执行只跑 Preview*。
# basename → registry 显示名(同权重;download_hf_model 命中本地根文件不重下)。
_MELBAND_BASENAME_TO_REGISTRY: dict[str, str] = {
    "MelBandRoformer_fp16.safetensors": "Vocals · Kim fp16 ⭐ [Kijai]",
    "MelBandRoformer_fp32.safetensors": "Vocals · Kim fp32 [Kijai]",
    "MelBandRoformer.ckpt": "Vocals · Kim original [KimberleyJSN]",
}

# ethanfel MelBandRoFormerSampler 新版 required 带默认;RH/旧图常只有 model+audio。
_MELBAND_SAMPLER_DEFAULTS: dict[str, float | int] = {
    "chunk_size": 8.0,
    "overlap": 2,
    "fade_size": 0.1,
    "batch_size": 1,
    "intensity": 1.0,
}


def _normalize_melband_roformer(graph: dict) -> None:
    """MelBandRoFormerModelLoader/Sampler:RH FS 路径 + 缺 sampler 新字段 → Preview-only。

    Loader:把 MelBandRoFormer_comfy/MelBandRoformer_fp16.safetensors 等 remap 到
    ethanfel registry 显示名(「Vocals · Kim fp16 ⭐ [Kijai]」),避免 value_not_in_list
    剪掉 VHS 依赖链。Sampler:回填 chunk_size/overlap/fade_size/batch_size/intensity
    缺省(已有键不覆盖)。kijai 旧版 diffusion_models 路径若已是 registry 名则不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if ct in ("MelBandRoFormerModelLoader", "MelBandRoFormerModelLoaderLatest"):
            name = inputs.get("model_name")
            if not isinstance(name, str) or not name.strip():
                continue
            if " · " in name:  # 已是 registry 显示名
                continue
            base = name.rsplit("/", 1)[-1]
            mapped = _MELBAND_BASENAME_TO_REGISTRY.get(base)
            if mapped:
                inputs["model_name"] = mapped
            continue
        if ct == "MelBandRoFormerSampler":
            for key, default in _MELBAND_SAMPLER_DEFAULTS.items():
                if key not in inputs:
                    inputs[key] = default


def _normalize_wan_video_quantization(graph: dict) -> None:
    """WanVideoModelLoader: *_scaled 量化只匹配 scaled 权重。

    RH 图常把 fp16/bf16 底模配成 fp8_e4m3fn_scaled → worker 报
    "The model is not a scaled fp8 model, please disable '_scaled' in quantization"。
    提交前:量化含 `_scaled` 且 model 文件名不含 scaled 时,剥掉 `_scaled`/`_scaled_fast`
    (fp8_e4m3fn_scaled → fp8_e4m3fn; …_scaled_fast → …_fast);剥完非法则回落 disabled。
    已与权重匹配的 scaled 组合、以及非 scaled 量化不动。
    """
    if not isinstance(graph, dict):
        return
    valid = {
        "disabled",
        "fp8_e4m3fn",
        "fp8_e4m3fn_fast",
        "fp8_e4m3fn_scaled",
        "fp8_e4m3fn_scaled_fast",
        "fp8_e5m2",
        "fp8_e5m2_fast",
        "fp8_e5m2_scaled",
        "fp8_e5m2_scaled_fast",
    }
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoModelLoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        quant = inputs.get("quantization")
        model = inputs.get("model")
        if not isinstance(quant, str) or "_scaled" not in quant:
            continue
        model_s = model.lower() if isinstance(model, str) else ""
        if "scaled" in model_s:
            continue  # 权重自带 scale,保留 scaled 量化
        fixed = quant.replace("_scaled_fast", "_fast").replace("_scaled", "")
        inputs["quantization"] = fixed if fixed in valid else "disabled"


def _normalize_text_multiline_dynamic_prompts(graph: dict) -> None:
    """WAS Text Multiline 新版 schema 要求 dynamic_prompts;RH/旧图常只有 text。

    真机 object_info:required=['text','dynamic_prompts'],BOOLEAN default True。
    缺省时回填 False(关随机花括号改写,保留字面量/JSON 友好;与「false/empty」策略一致)。
    已有键不覆盖(表单/库内显式值优先)。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "Text Multiline":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "dynamic_prompts" not in inputs:
            inputs["dynamic_prompts"] = False


def _normalize_comfy_literals_int(graph: dict, bindings: dict | None) -> dict | None:
    """ComfyLiterals `Int`/`Float` 要的是 STRING 叶子 `Number`,RH/旧包装常落成 value。

    Comfy 对缺 Number 的 Int/Float 会让依赖它的 VHS_VideoCombine/Save*/LatentUpscale*
    进 node_errors,但仍可能只跑 PreviewAny 等无依赖链输出 →「success 但无产物」。
    在写表单值前把图内 Int/Float 的 value→Number(str),并同步改 bindings 的 field,
    避免 _write_leaf 因旧路径 inputs.value 不存在而 422。
    """
    if not isinstance(graph, dict):
        return bindings
    touched: set[str] = set()
    for nid, node in graph.items():
        if not isinstance(node, dict) or node.get("class_type") not in ("Int", "Float"):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "Number" in inputs and "value" not in inputs:
            continue
        if "value" in inputs:
            raw = inputs.pop("value")
            if "Number" not in inputs:
                if isinstance(raw, list):
                    # 连线不能 str():str 化后 ComfyLiterals 运行期 int("['59', 0]") 必炸
                    # (wave23 烟测实证 5262675969)。原样保留为 Number 槽上的连线。
                    inputs["Number"] = raw
                else:
                    inputs["Number"] = "" if raw is None else str(raw)
            touched.add(str(nid))
        elif "Number" in inputs and not isinstance(inputs["Number"], str):
            inputs["Number"] = str(inputs["Number"])
            touched.add(str(nid))
    if not touched or not isinstance(bindings, dict):
        return bindings
    out: dict = {}
    for key, target in bindings.items():
        if isinstance(target, list):
            out[key] = [
                (
                    {**slot, "field": "inputs.Number"}
                    if isinstance(slot, dict)
                    and str(slot.get("node") or "") in touched
                    and slot.get("field") == "inputs.value"
                    else slot
                )
                for slot in target
            ]
            continue
        if (
            isinstance(target, dict)
            and str(target.get("node") or "") in touched
            and target.get("field") == "inputs.value"
        ):
            out[key] = {**target, "field": "inputs.Number"}
        else:
            out[key] = target
    return out



# AILab_QwenVL_Advanced 新版 required 带 video_frame_size;RH/旧图常只有 frame_count。
# 缺省 → node_errors 剪掉依赖 VHS/Save 链 → Preview-only / 主保存未产出,或整图 400。
_AILAB_QWENVL_ADVANCED_DEFAULTS: dict[str, str | int | float | bool] = {
    "video_frame_size": "auto",
}


def _normalize_ailab_qwen_vl(graph: dict) -> None:
    """AILab_QwenVL_Advanced:缺 video_frame_size 等新 required → Preview-only / 400。

    真机 object_info:required 含 video_frame_size combo default "auto"
    (控制视频抽帧最大边;auto 防 OOM)。RH/旧图常只有 frame_count。
    缺键回填默认(已有键不覆盖);非 Advanced 的 AILab_QwenVL 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "AILab_QwenVL_Advanced":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, default in _AILAB_QWENVL_ADVANCED_DEFAULTS.items():
            if key not in inputs:
                inputs[key] = default


def _normalize_image_scale_resolution_steps(graph: dict) -> None:
    """ImageScaleToTotalPixels 新版 required 含 resolution_steps;RH/旧图常缺。

    真机 object_info:required 含 resolution_steps INT default 1(advanced)。
    缺省回填 1(与 Comfy 默认一致);已有键不覆盖。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "ImageScaleToTotalPixels":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "resolution_steps" not in inputs:
            inputs["resolution_steps"] = 1



# LTX V3 DYNAMICCOMBO: API 子输入须 `<combo>.<name>`;RH 常落裸 image_1 等
# → TypeError unexpected keyword(同 H3 AUTOGROW / ResizeImageMaskNode.resize_type.*)。
_LTXV_DYNAMICCOMBO_NODES: dict[str, tuple[str, tuple[str, ...]]] = {
    # class_type → (combo_field, bare_prefixes)
    "LTXVImgToVideoInplaceKJ": ("num_images", ("image_", "strength_", "index_")),
    "LTXVAddGuideMulti": ("num_guides", ("image_", "strength_", "frame_idx_")),
}


def _normalize_ltxv_dynamiccombo(graph: dict) -> None:
    """LTXV* DYNAMICCOMBO_V3:裸 image_1 改写为 num_images.image_1 / num_guides.image_1。

    真机:LTXVImgToVideoInplaceKJ.num_images、LTXVAddGuideMulti.num_guides 为
    COMFY_DYNAMICCOMBO_V3;子输入在 option 内。API 须父键=\"1\".. + 点号子键。
    RH/旧图裸 image_1/strength_N/index_N|frame_idx_N → execute() unexpected keyword。
    已是点号键不动。父键按 **image_N 最大序号** 回填(勿用 strength/index 最大 —
    RH 常预置 strength_1..5 但只有 image_1/2,否则会 required image_3..缺失)。
    超出 image 最大序号的 strength/index/frame_idx 裸键直接丢弃。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        spec = _LTXV_DYNAMICCOMBO_NODES.get(node.get("class_type") or "")
        if not spec:
            continue
        combo, prefixes = spec
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        max_image = 0
        for key in list(inputs.keys()):
            if not isinstance(key, str):
                continue
            if "." not in key:
                if key.startswith("image_") and key[6:].isdigit():
                    max_image = max(max_image, int(key[6:]))
                continue
            # 已是点号键但父键缺失(wave10 实证 execute() missing num_images):
            # 从 num_images.image_N 的最大序号回填父键
            head, _, tail = key.partition(".")
            if head == combo and tail.startswith("image_") and tail[6:].isdigit():
                max_image = max(max_image, int(tail[6:]))
        remaps: list[tuple[str, str]] = []
        drop: list[str] = []
        for key in list(inputs.keys()):
            if not isinstance(key, str) or "." in key:
                continue
            for prefix in prefixes:
                if not key.startswith(prefix):
                    continue
                suffix = key[len(prefix):]
                if not suffix.isdigit():
                    continue
                n = int(suffix)
                if n < 1:
                    continue
                if max_image and n > max_image:
                    drop.append(key)
                    break
                remaps.append((key, f"{combo}.{key}"))
                break
        for key in drop:
            inputs.pop(key, None)
        for old_key, new_key in remaps:
            if new_key in inputs and old_key != new_key:
                inputs.pop(old_key, None)
            else:
                inputs[new_key] = inputs.pop(old_key)
        if max_image < 1:
            continue
        cur = inputs.get(combo)
        if cur is None or cur == "":
            inputs[combo] = str(max_image)



def _normalize_wan_video_sampler_teacache(graph: dict) -> None:
    """WanVideoSampler:RH 旧键 teacache_args → 现行 cache_args。

    真机 object_info optional 仅 cache_args(接 WanVideoTeaCache);RH/旧图常写
    teacache_args → 校验/执行期剪掉 Sampler→Decode→VHS 链,只剩 Preview*
    → 主保存未产出。已是 cache_args 或无 teacache_args 不动;两者并存时保留
    cache_args、丢弃旧键。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoSampler":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or "teacache_args" not in inputs:
            continue
        if "cache_args" in inputs:
            inputs.pop("teacache_args", None)
        else:
            inputs["cache_args"] = inputs.pop("teacache_args")



# WanVideoExperimentalArgs 新版 required 扩字段;RH/旧图常缺 → 剪掉 Sampler 链 → Preview-only。
_WAN_EXPERIMENTAL_ARGS_DEFAULTS: dict[str, bool | float | int | str] = {
    # 注:video_attention_split_steps 不回填(object_info 默认空串,INT 校验会炸);
    # wave22 实证缺的是 fresca 组(1152197633)
    "cfg_zero_star": False,
    "use_zero_init": False,
    "zero_star_steps": 0,
    "use_fresca": False,
    "fresca_scale_low": 1.0,
    "fresca_scale_high": 1.25,
    "fresca_freq_cutoff": 20,
    "use_tcfg": False,
    "raag_alpha": 0.0,
    "bidirectional_sampling": False,
    "temporal_score_rescaling": False,
    "tsr_k": 0.95,
    "tsr_sigma": 1.0,
}

# WanVideoVAELoader:RH 旧文件名 → 本地枚举(同权重大致可互换)。
_WAN_VAE_BASENAME_TO_LOCAL: dict[str, str] = {
    "wan_2.1_vae.safetensors": "Wan2.1_VAE.pth",
}


def _normalize_wan_video_experimental_args(graph: dict) -> None:
    """WanVideoExperimentalArgs:回填新 required(use_tcfg/raag_*/tsr_*)。

    真机 object_info 扩了 use_tcfg/raag_alpha/bidirectional_sampling/
    temporal_score_rescaling/tsr_k/tsr_sigma;RH 旧图常缺 → node_errors 剪掉
    WanVideoSampler→Decode→VHS,只剩 PreviewImage → 主保存未产出。
    缺键回填默认(已有键不覆盖)。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoExperimentalArgs":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, default in _WAN_EXPERIMENTAL_ARGS_DEFAULTS.items():
            if key not in inputs:
                inputs[key] = default


def _normalize_wan_video_vae_loader(graph: dict) -> None:
    """WanVideoVAELoader:RH wan_2.1_vae.safetensors → 本地 Wan2.1_VAE.pth。

    value_not_in_list 会剪掉 VAE→VACE/Decode→VHS 链 → Preview-only。
    已是枚举内文件名不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoVAELoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        name = inputs.get("model_name")
        if not isinstance(name, str) or not name.strip():
            continue
        base = name.rsplit("/", 1)[-1]
        mapped = _WAN_VAE_BASENAME_TO_LOCAL.get(base) or _WAN_VAE_BASENAME_TO_LOCAL.get(name)
        if mapped:
            inputs["model_name"] = mapped


# LatentUpscaleModelLoader:RH/旧图 ltx-2.3-spatial-upscaler-x2-1.0 在部分 worker
# 上是残缺 alias(MODEL_SOURCES: cp_from_1.1 但体积 442MB≠1.1 的 995MB) →
# load_safetensors view 报 shape '[1024,1024,3,3,3]' invalid。上游已用 1.1 取代。
_LATENT_UPSCALE_BASENAME_TO_LOCAL: dict[str, str] = {
    "ltx-2.3-spatial-upscaler-x2-1.0.safetensors": "ltx-2.3-spatial-upscaler-x2-1.1.safetensors",
}


def _normalize_latent_upscale_model_loader(graph: dict) -> None:
    """LatentUpscaleModelLoader:残缺 x2-1.0 → 现行 x2-1.1。

    真机枚举同时有 1.0/1.1;RH 常写 1.0。部分 worker 上 1.0 文件损坏/截断 →
    RuntimeError shape '[1024,1024,3,3,3]' invalid。已是 1.1 或其它名不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "LatentUpscaleModelLoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        name = inputs.get("model_name")
        if not isinstance(name, str) or not name.strip():
            continue
        base = name.rsplit("/", 1)[-1]
        mapped = _LATENT_UPSCALE_BASENAME_TO_LOCAL.get(base) or _LATENT_UPSCALE_BASENAME_TO_LOCAL.get(name)
        if mapped:
            inputs["model_name"] = mapped



# WanVideoModelLoader:RH Animate 权重名(…fp8_scaled_e4m3fn…_v2)在 LongCat 枚举里
# 常写作 …fp8_e4m3fn_scaled…(无 _v2)。value_not_in_list → 剪掉 Sampler→Decode→VHS
# → 只剩 MathExpression/showAnything → success 但无媒体。
_WAN_MODEL_NAME_TO_LOCAL: dict[str, str] = {
    "Wan22Animate/Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors":
        "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
    "Wan2_2-Animate-14B_fp8_scaled_e4m3fn_KJ_v2.safetensors":
        "Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors",
}


def _normalize_wan_video_model_loader(graph: dict) -> None:
    """WanVideoModelLoader:RH Animate 缺失文件名 → 本地枚举等价权重。

    真机 :8197 有 Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors,
    RH 常写 …fp8_scaled_e4m3fn…_KJ_v2 → value_not_in_list 剪掉整条
    WanVideoSampler→Decode→VHS,只剩 Preview/Math/showAnything → 主保存未产出。
    已是枚举内或未登记名不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoModelLoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        name = inputs.get("model")
        if not isinstance(name, str) or not name.strip():
            continue
        base = name.rsplit("/", 1)[-1]
        mapped = _WAN_MODEL_NAME_TO_LOCAL.get(name) or _WAN_MODEL_NAME_TO_LOCAL.get(base)
        if mapped:
            inputs["model"] = mapped


# easy imageRemBg:本地 RMBG-2.0 包缺 config.model_type,新 transformers 加载报
# AttributeError → 整图失败。同节点 RMBG-1.4 可用,提交前 remap。
_EASY_IMAGE_REMBG_MODE_TO_LOCAL: dict[str, str] = {
    "RMBG-2.0": "RMBG-1.4",
}


def _normalize_easy_image_rembg(graph: dict) -> None:
    """easy imageRemBg:RMBG-2.0 → RMBG-1.4(本地 2.0 config 缺 model_type)。

    Easy-Use 走 AutoModelForImageSegmentation.from_pretrained;本地 RMBG-2.0
    的 config 无 model_type 时新 transformers 抛
    ``'Config' object has no attribute 'model_type'``。同节点 RMBG-1.4 /
    Inspyrenet 可跑。已是 1.4 或其它 mode 不动。设备侧修好 2.0 包后可删此表。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "easy imageRemBg":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        mode = inputs.get("rem_mode")
        if not isinstance(mode, str) or not mode.strip():
            continue
        mapped = _EASY_IMAGE_REMBG_MODE_TO_LOCAL.get(mode)
        if mapped:
            inputs["rem_mode"] = mapped



# KSampler 等:RH 偶发 beta57 / bong_tangent 等非标 scheduler → value_not_in_list。
# 真机枚举(:8196 KSampler object_info 2026-09-14)含 beta / simple / karras…;
# beta57 最接近 beta;bong_tangent 无对应项,取质量默认 karras。
_SCHEDULER_ALIAS_TO_LOCAL: dict[str, str] = {
    "beta57": "beta",
    "bong_tangent": "karras",
}

# RH 图偶发 res_2s / res_2m 采样器名(wave18 实证 4 例):真机 44 项枚举里
# "2s" 系只有 dpmpp_2s_ancestral、"2m" 系有 dpmpp_2m,按最接近项映射。
_SAMPLER_ALIAS_TO_LOCAL: dict[str, str] = {
    "res_2s": "dpmpp_2s_ancestral",
    "res_2m": "dpmpp_2m",
}


def _normalize_scheduler_aliases(graph: dict) -> None:
    """任意节点 scheduler / sampler_name 字符串:RH 别名 → 本地枚举。

    Qwen-Image-Edit 等 RH 图写 beta57,worker KSampler 列表无此项 →
    prompt_outputs_failed_validation。已是枚举内或未登记别名不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        sched = inputs.get("scheduler")
        if isinstance(sched, str) and sched.strip():
            mapped = _SCHEDULER_ALIAS_TO_LOCAL.get(sched)
            if mapped:
                inputs["scheduler"] = mapped
        sampler = inputs.get("sampler_name")
        if isinstance(sampler, str) and sampler.strip():
            mapped = _SAMPLER_ALIAS_TO_LOCAL.get(sampler)
            if mapped:
                inputs["sampler_name"] = mapped


# H3 UNETLoader 权重别名:⚠️ 已清空(2026-09-14)。精确 int8_convrot 三件
# (fl2va/ref2va/官方命名)已全量落盘 :8195(含 models/MiniMax-H3 官方树),
# 旧表把 int8 改写到 pruned 变体反而制造 mat1/mat2 运行时错
# (pruned DiT 与 int8_convrot 编码器不成对;对照实验 A/B 双 PASS 实证)。
# 保留函数骨架:未来再出现"引用名≠现网名且语义等价"时,先真机核 combo 再加映射。
_H3_UNET_NAME_ALIASES: dict[str, str] = {}


def _normalize_h3_weight_aliases(graph: dict) -> None:
    """UNETLoader.unet_name:RH 旧命名 H3 权重 → 现网同量化文件名。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "UNETLoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        unet = inputs.get("unet_name")
        if isinstance(unet, str):
            mapped = _H3_UNET_NAME_ALIASES.get(unet)
            if mapped:
                inputs["unet_name"] = mapped


# 2026-09-17 P1-13:RH 应用引用名 → 已落盘等价文件(官方源下载后登记)。
# 语义等价才映射;无对应下载的原值保留,走缺模型报错转下载包。
_MODEL_FILE_ALIASES: dict[str, str] = {
    # Comfy-Org/Qwen-Image-Layered_ComfyUI(fp8mixed=RH 的 fp8_e4m3fn 同物)
    "qwen_image_layered_fp8_e4m3fn.safetensors": "qwen_image_layered_fp8mixed.safetensors",
    # Comfy-Org/z_image_turbo(RH 改名副本)
    "new_Z-Image_Turbo-diffusion.safetensors": "z_image_turbo_bf16.safetensors",
}

_LOADER_MODEL_INPUT_KEYS: dict[str, tuple[str, ...]] = {
    "UNETLoader": ("unet_name",),
    "UnetLoaderGGUF": ("unet_name",),
    "CheckpointLoaderSimple": ("ckpt_name",),
    "VAELoader": ("vae_name",),
    "UpscaleModelLoader": ("model_name",),
    "CLIPLoader": ("clip_name",),
}

# 缺失字体 → fleet 在列替代(ComfyRoll fonts 目录,:8196/:8197 object_info 实证)。
# 2026-09-19 02Takibi-Light-2.otf(焚火体,FontGraphic 商用免费):fonts.net.cn/mostfont
# 等源站均登录墙无法直下,NAS/workstation 全盘无副本;rh-acc-7206923264 只用英文
# 对比标签(front/after),Roboto-Regular 语义无损。未来拿到真字体落盘 ComfyRoll
# fonts 目录后删表项即可恢复原值。
_FONT_ALIASES: dict[str, str] = {
    "02Takibi-Light-2.otf": "Roboto-Regular.ttf",
}


def _normalize_font_aliases(graph: dict) -> None:
    """font_name 缺失字体 → 在列替代(见 _FONT_ALIASES;任意节点类型通用)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        v = inputs.get("font_name")
        if isinstance(v, str):
            mapped = _FONT_ALIASES.get(v)
            if mapped:
                inputs["font_name"] = mapped


def _normalize_model_file_aliases(graph: dict) -> None:
    """通用模型文件名映射:RH 引用名 → 已落盘等价文件(见 _MODEL_FILE_ALIASES)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        keys = _LOADER_MODEL_INPUT_KEYS.get(node.get("class_type", ""))
        if not keys:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for k in keys:
            v = inputs.get(k)
            if isinstance(v, str):
                mapped = _MODEL_FILE_ALIASES.get(v)
                if mapped:
                    inputs[k] = mapped


def _normalize_image_rembg_model(graph: dict) -> None:
    """Image Rembg(Remove Background) 旧版入参 `model` → 现网 required `rembg_model`。

    :8196 object_info 2026-09-14 实证:required 含 rembg_model(REMBG_MODEL combo),
    RH 旧图落旧字段名 model → required_input_missing 判死保存链。值(u2net 等)
    为 rembg 模型名,combo 动态取自已装 rembg 包,原值合法即保留。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "Image Rembg (Remove Background)":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "rembg_model" not in inputs and "model" in inputs:
            inputs["rembg_model"] = inputs.pop("model")


def _normalize_compress_images(graph: dict) -> None:
    """CompressImages 旧版入参 `images or video_path` → 现网 required `images`;
    并给同图无连线的 SaveImage.images 接上同一 IMAGE 源(孤儿保存节点判死整图)。

    现网节点(:8196 object_info 2026-09-14 实证):required images IMAGE,
    输出 STRING(落盘副作用,不产 IMAGE)。RH 旧图字段名是 'images or video_path';
    且此类图常另挂一个没接线的 SaveImage → 两保存节点全判死 fail-fast。
    仅当图中存在已连线的 CompressImages 时才补线,源指向同一解码输出。
    """
    if not isinstance(graph, dict):
        return
    ci_src = None
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "CompressImages":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "images" not in inputs and "images or video_path" in inputs:
            inputs["images"] = inputs.pop("images or video_path")
        src = inputs.get("images")
        if isinstance(src, list) and len(src) == 2:
            ci_src = list(src)
    if not ci_src:
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "SaveImage":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if not inputs.get("images"):
            inputs["images"] = list(ci_src)


def _normalize_double_extension(graph: dict) -> None:
    """RH 导出的模型名偶发双扩展('X.safe.safetensors'/'X.ckpt.safetensors')→ 单扩展。

    wave23 验收实证(Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safe.safetensors),
    正确文件在 fleet 有单扩展版;对所有 loader 字段的字符串值做收尾修复。
    """
    if not isinstance(graph, dict):
        return
    pat = re.compile(r"\.(safe|ckpt|pt|pth|sft|st)\.safetensors$", re.IGNORECASE)
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for k, v in inputs.items():
            if isinstance(v, str) and pat.search(v):
                inputs[k] = pat.sub(".safetensors", v)


def _bypass_comfy_literals_link_nodes(graph: dict, bindings: dict | None = None) -> None:
    """ComfyLiterals Int/Float 的 Number 是 STRING 槽:吃 INT/FLOAT 连线必被类型校验拒
    (received_type(INT) mismatch input_type(STRING),wave23 烟测实证 5262675969)。
    这类「连线喂 Number」的节点是冗余换算层:消费方直连其上游输出,摘除本节点。

    仅处理 value/Number 为连线(list)的节点;字面量场景走 _normalize_comfy_literals_int。
    bindings 命中的节点跳过(表单还要写值,摘了会 422)。
    """
    if not isinstance(graph, dict):
        return
    bound: set[str] = set()
    if isinstance(bindings, dict):
        for t in bindings.values():
            if isinstance(t, dict) and t.get("node") is not None:
                bound.add(str(t["node"]))
    rewires: dict[str, list] = {}
    for nid, node in graph.items():
        if not isinstance(node, dict) or node.get("class_type") not in ("Int", "Float"):
            continue
        if nid in bound or str(nid) in bound:
            continue
        inputs = node.get("inputs") or {}
        link = inputs.get("Number") if isinstance(inputs.get("Number"), list) else inputs.get("value")
        if isinstance(link, list) and len(link) == 2:
            rewires[str(nid)] = link
    if not rewires:
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        for k, v in (node.get("inputs") or {}).items():
            if isinstance(v, list) and len(v) == 2 and str(v[0]) in rewires and v[1] == 0:
                node["inputs"][k] = list(rewires[str(v[0])])
    for nid in rewires:
        graph.pop(nid, None)


def _normalize_comfy_literals_number_str(graph: dict) -> None:
    """绑定写值后再过一遍 ComfyLiterals Number 叶子,保证 int()/float() 可解析。

    绑定/required 回填可能把 JSON 浮点(5.0)或浮点格式串('5.0')写进 Number
    (STRING 槽);ComfyLiterals `int('5.0')` 抛 'Invalid value provided for INT'
    (:8196 ComfyLiterals/nodes.py 2026-09-14 实证)。整值浮点压成整数串。
    连线(list)与非数值串(表达式)不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") not in ("Int", "Float"):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict) or "Number" not in inputs:
            continue
        raw = inputs["Number"]
        if isinstance(raw, (list, dict)):
            continue
        try:
            if node.get("class_type") == "Int":
                f = float(raw)
                inputs["Number"] = str(int(round(f)))
            else:
                inputs["Number"] = str(float(raw))
        except (TypeError, ValueError):
            pass


def _normalize_rmbg_background(graph: dict) -> None:
    """RMBG(danielgatis)background:RH 图写颜色名 'white' → 合法枚举 'Color'。

    节点 combo 仅 ['Alpha','Color'](:8197 object_info 2026-09-14 实证),
    'white' 直接 value_not_in_list。转 Color 时补 background_color
    '#FFFFFF' 保持原意(白底);已有 background_color 不覆盖。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "RMBG":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        bg = inputs.get("background")
        if isinstance(bg, str) and bg.strip().lower() in ("white", "#ffffff"):
            inputs["background"] = "Color"
            if "background_color" not in inputs:
                inputs["background_color"] = "#FFFFFF"


# 节点包升级后新增 required 入参,RH/旧图未带 → required_input_missing 判死主保存
# 节点。默认值全部取自真机 object_info(2026-09-14 :8196/:8197 实测),已有键不覆盖。
_MISSING_REQUIRED_DEFAULTS: dict[str, dict[str, object]] = {
    "LTXDirector": {
        "start_second": 0.0,
        "end_second": 5.0,
        "duration_seconds": 5.0,
        "start_frame": 0,
        "end_frame": 120,
        "duration_frames": 120,
        "timeline_data": "",
        "local_prompts": "",
        "segment_lengths": "",
        "epsilon": 0.001,
        "guide_strength": "",
    },
    "PainterFluxImageEdit": {"mode": "1_image", "batch_size": 1},
    "AILab_QwenVL": {"attention_mode": "auto"},
    "UltimateSDUpscale": {"batch_size": 1},
    "Flux2Scheduler": {"width": 1024, "height": 1024},
    "NunchakuQwenImageDiTLoader": {"cpu_offload": "auto"},
    "WanVideoVACEEncode": {"vace_start_percent": 0.0, "vace_end_percent": 1.0},
    # ComfyUI_Qwen3-VL-Instruct 包换代后新增的 attention(旧 Qwen2_VQA 图不带,
    # required_input_missing 判死保存链;2026-09-18 rh-acc-9515387905 实证)
    "Qwen2_VQA": {"attention": "eager"},
    "Qwen3_VQA": {"attention": "eager"},
    # SeC 换装遮罩链:RH 图 SeCModelLoader.model_file 常带 null(2026-09-21
    # rh-acc-3877213185 实证);:8195/:8196 object_info 在列值 SeC-4B-fp16/bf16,取 fp16
    "SeCModelLoader": {"model_file": "SeC-4B-fp16.safetensors"},
}


def _normalize_required_backfill(graph: dict) -> None:
    """上表节点缺失的 required 入参按 object_info 默认值回填(已有键不覆盖;null 视同缺失)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        defaults = _MISSING_REQUIRED_DEFAULTS.get(node.get("class_type") or "")
        if not defaults:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for key, default in defaults.items():
            if key not in inputs or inputs.get(key) is None:
                inputs[key] = default


def _normalize_sec_empty_bbox(graph: dict) -> None:
    """SeCVideoSegmentation.bbox 空串 → None。

    SecNodes parse_bbox 对 None 早退(跳过 bbox),但对 "" 会误入 dict 分支炸
    「string indices must be integers」(2026-09-21 rh-acc-3877213185 实证);
    input_mask/点提示已有时空 bbox 语义即 None。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        if (node.get("class_type") or "") != "SeCVideoSegmentation":
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict) and inputs.get("bbox") == "":
            inputs["bbox"] = None


def _normalize_sec_flash_attn_blackwell(graph: dict) -> None:
    """SeCModelLoader.use_flash_attn=True → False(sm_120 全 fleet,flash-attn 内核实证不兼容)。

    SeC 模型注意力在 Blackwell(sm_120)走 flash-attn 路径炸 einops reshape
    (2026-09-21 rh-acc-3877213185 @ :8197 实证);False 走 eager 注意力,语义一致仅减速。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        if (node.get("class_type") or "") != "SeCModelLoader":
            continue
        inputs = node.get("inputs")
        if isinstance(inputs, dict) and inputs.get("use_flash_attn") is True:
            inputs["use_flash_attn"] = False


def _normalize_qwen_edit_prompt_string_link(graph: dict) -> None:
    """TextEncodeQwenImageEdit* .prompt:easy promptLine 的 COMBO 输出槽改接 STRING 槽。

    easy promptLine 输出序列为 [STRING, COMBO](pc01 :8188 object_info 实证);
    RH 图常把 slot 1(COMBO)接进 prompt(STRING 输入)→ return_type_mismatch
    判死保存链(wave5/9 实证 3 例)。仅处理源节点确为 easy promptLine 的链接;
    裸字符串值不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if not isinstance(ct, str) or not ct.startswith("TextEncodeQwenImageEdit"):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        prompt = inputs.get("prompt")
        if not (isinstance(prompt, list) and len(prompt) >= 2):
            continue
        src = graph.get(str(prompt[0]))
        if not isinstance(src, dict) or src.get("class_type") != "easy promptLine":
            continue
        if int(prompt[1]) >= 1:
            inputs["prompt"] = [prompt[0], 0]


# ModelPreviewOverrideKJ.tiny_vae:H3 实例(:8195)vae 目录未挂 tae 系列,
# combo 仅 ['none'](wave18 实证 rh-acc-5158893569)。覆写关闭只影响实时预览
# 速度,不影响主产物;主 VAE 由图上独立加载器提供。
_TINY_VAE_ALIAS_TO_LOCAL: dict[str, str] = {
    "taeh3.safetensors": "none",
}


def _normalize_tiny_vae_alias(graph: dict) -> None:
    """ModelPreviewOverrideKJ.tiny_vae:未落盘别名 → 'none'(关闭预览覆写)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "ModelPreviewOverrideKJ":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        tiny = inputs.get("tiny_vae")
        if isinstance(tiny, str):
            mapped = _TINY_VAE_ALIAS_TO_LOCAL.get(tiny)
            if mapped:
                inputs["tiny_vae"] = mapped


# DualCLIPLoader 等:RH 图写 'sd3/xxx.safetensors' 子路径,而目标 worker 的
# clip 目录无 sd3 子目录(wave9/18 实证 3 例,t5xxl_fp16/fp8 + clip_l 均
# 已在 fleet 落盘但位于根目录)。剥子路径取 basename;目标确实没有时维持原报错。
_CLIP_LOADER_TYPES = ("DualCLIPLoader", "DualCLIPLoaderGGUF", "CLIPLoader")
_CLIP_NAME_FIELDS = ("clip_name", "clip_name1", "clip_name2", "clip_name3")


def _parse_timecode(value: object) -> float | None:
    """TrimAudioDuration 时间值:数字秒或 "M:SS" → 秒;无法解析返回 None。"""
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    if ":" in s:
        parts = s.split(":")
        try:
            secs = 0.0
            for p in parts:
                secs = secs * 60 + float(p)
            return secs
        except ValueError:
            return None
    try:
        return float(s)
    except ValueError:
        return None


def _normalize_trim_audio_duration(graph: dict) -> None:
    """TrimAudioDuration:start_time >= end_time 时交换(RH 烘焙值倒置)。

    节点要求 start < end 且在音频长度内(wave10/11 实证 2 例);离线不知音频
    长度,仅修复确定非法的倒置。已有 start<end 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "TrimAudioDuration":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        start = _parse_timecode(inputs.get("start_time"))
        end = _parse_timecode(inputs.get("end_time"))
        if start is None or end is None or start < end:
            continue
        inputs["start_time"], inputs["end_time"] = inputs.get("end_time"), inputs.get("start_time")


def _normalize_sd3_clip_basename(graph: dict) -> None:
    """CLIP 加载器 clip_name*:带子路径的模型名 → basename。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        if node.get("class_type") not in _CLIP_LOADER_TYPES:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        for field in _CLIP_NAME_FIELDS:
            raw = inputs.get(field)
            if not isinstance(raw, str) or "/" not in raw:
                continue
            base = raw.replace(chr(92), "/").rstrip("/").rsplit("/", 1)[-1]
            if base and base != raw:
                inputs[field] = base


def _normalize_vhs_load_video(graph: dict) -> None:
    """VHS_LoadVideo:RH 烘焙 skip_first_frames 过大 → No frames generated。

    短 fixture / 替换视频帧数常 < RH 原片;当 frame_load_cap>0 且
    skip_first_frames >= frame_load_cap 时回零(保留 cap)。已合理的 skip 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "VHS_LoadVideo":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        skip = inputs.get("skip_first_frames")
        cap = inputs.get("frame_load_cap")
        if not isinstance(skip, int) or not isinstance(cap, int):
            continue
        if cap > 0 and skip >= cap:
            inputs["skip_first_frames"] = 0


def _normalize_vhs_video_combine(graph: dict) -> None:
    """VHS_VideoCombine:补 frame_rate;去无 images 孤儿;全 False 时开一路保存。

    新版 required 含 frame_rate;RH 预览路常缺 → 剪枝。RH 偶发留下
    无 images 连线却 save_output=True 的孤儿 Combine → required_input_missing。
    另 RH 只留 Preview + 全部 save_output=False → success 无产物;无
    SaveImage/SaveAnimated* 且存活 Combine 均 False 时把第一个改为 True。
    """
    if not isinstance(graph, dict):
        return
    combines: list[dict] = []
    has_saver = False
    orphan_ids: list[str] = []
    for nid, node in list(graph.items()):
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if ct in (
            "SaveImage",
            "SaveAnimatedWEBP",
            "SaveAnimatedPNG",
            "SaveVideo",
            "VHS_VideoCombine",
        ):
            if ct != "VHS_VideoCombine":
                has_saver = True
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if ct == "VHS_VideoCombine":
            if "images" not in inputs:
                orphan_ids.append(str(nid))
                continue
            combines.append(inputs)
            if "frame_rate" not in inputs:
                inputs["frame_rate"] = 16
            if inputs.get("save_output") is True:
                has_saver = True
    for oid in orphan_ids:
        graph.pop(oid, None)
    if has_saver or not combines:
        return
    # 全 False / 缺省:打开第一路
    first = combines[0]
    first["save_output"] = True


# LayerMask:RH/跨机图偶发把 models 绝对路径写进 combo;节点再拼 models_dir
# 或直接 from_pretrained(abs) → HF 校验 repo_id 失败。统一剥成 basename。
_LAYERMASK_PATH_FIELDS: dict[str, str] = {
    "LayerMask: SegformerClothesPipelineLoader": "model",
    "LayerMask: SegformerFashionPipelineLoader": "model",
    "LayerMask: SegformerUltraV2": "model_name",
    "LayerMask: LoadBiRefNetModelV2": "version",
    "LayerMask: LoadBiRefNetModel": "model",
}


def _normalize_layermask_model_paths(graph: dict) -> None:
    """LayerMask Segformer/BiRefNet:绝对/多级路径 → basename(registry 名)。

    真机 combo 为 segformer_b3_clothes / BiRefNet-General;RH 或错误包装
    写成 /home/.../models/segformer_b3_clothes 时,节点 from_pretrained 把
    本地目录当 HF repo_id → OSError。已是 basename 不动。缺权重仍须设备下载。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        field = _LAYERMASK_PATH_FIELDS.get(node.get("class_type") or "")
        if not field:
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        raw = inputs.get(field)
        if not isinstance(raw, str) or not raw.strip():
            continue
        s = raw.strip().replace(chr(92), "/")
        if "/" not in s:
            continue
        base = s.rstrip("/").rsplit("/", 1)[-1]
        if base and base != raw:
            inputs[field] = base



def _normalize_easy_prompt_line(graph: dict) -> None:
    """easy promptLine:缺 remove_empty_lines → True(worker 默认)。

    Easy-Use 新版 required 含 BOOLEAN remove_empty_lines;RH 旧图常缺 →
    required_input_missing 剪枝。已有字段不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "easy promptLine":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "remove_empty_lines" not in inputs:
            inputs["remove_empty_lines"] = True


def _normalize_inpaint_expand_mask(graph: dict) -> None:
    """INPAINT_ExpandMask:缺 blur_type → gaussian(worker 默认)。

    comfyui-inpaint-nodes 新版 required 含 blur_type combo;RH 旧图只有
    grow/blur → required_input_missing。已有 blur_type 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "INPAINT_ExpandMask":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "blur_type" not in inputs:
            inputs["blur_type"] = "gaussian"


def _normalize_inpaint_crop_improved(graph: dict) -> None:
    """InpaintCropImproved:缺 device_mode → cpu (compatible)(worker 默认)。

    新版 required 含 device_mode;RH 旧图常缺 → 与 ExpandMask 同批校验失败。
    已有字段不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "InpaintCropImproved":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "device_mode" not in inputs:
            inputs["device_mode"] = "cpu (compatible)"


def _normalize_wan_vace_start_end_frame(graph: dict) -> None:
    """WanVideoVACEStartToEndFrame:缺 num_frames → 81(worker 默认)。

    RH 偶发只留 start_image/empty_frame_level(num_frames 原挂 Crystools
    Primitive 且转换丢失) → required_input_missing,连带 VACEEncode 剪枝。
    已有 num_frames(字面量或连线)不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoVACEStartToEndFrame":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "num_frames" not in inputs:
            inputs["num_frames"] = 81


def _normalize_wan_sampler_empty_bools(graph: dict) -> None:
    """WanVideoSampler:RH 空串 add_noise_to_samples → False。

    BOOLEAN 位写成 "" 时部分 worker 校验/执行异常,剪掉 Sampler→Decode→VHS。
    已是 bool 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoSampler":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        v = inputs.get("add_noise_to_samples")
        if v == "" or v is None:
            inputs["add_noise_to_samples"] = False


def _normalize_vae_decode_tiled_vae(graph: dict) -> None:
    """VAEDecodeTiled:缺 vae 时借同图 CheckpointLoaderSimple 输出 2 或其它 Decode 的 vae。

    RH 偶发留下无 vae 连线的 VAEDecodeTiled;若它在输出链上会 required 缺失剪枝。
    优先复制已有 VAEDecode/VAEDecodeTiled 的 vae 引用,否则用 CheckpointLoaderSimple 的 [id,2]。
    已有 vae 不动。
    """
    if not isinstance(graph, dict):
        return
    vae_ref = None
    ckpt_id = None
    for nid, node in graph.items():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if ct in ("VAEDecode", "VAEDecodeTiled") and isinstance(inputs.get("vae"), list):
            vae_ref = inputs["vae"]
        if ct == "CheckpointLoaderSimple" and ckpt_id is None:
            ckpt_id = str(nid)
    if vae_ref is None and ckpt_id is not None:
        vae_ref = [ckpt_id, 2]
    if vae_ref is None:
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "VAEDecodeTiled":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "vae" not in inputs:
            inputs["vae"] = list(vae_ref)



# nunchaku SVDQ int4 → fp4 同名对应表(SM120/Blackwell 只支持 fp4,nunchaku
# is_compatible 直接 raise「Please use fp4 quantization for Blackwell GPUs」,
# wave20 实证 2 例)。fp4 对应文件已落 NAS toiv diffusion_models;
# 表外名称不动(避免 remap 到未落盘文件)。
_NUNCHAKU_INT4_TO_FP4: dict[str, str] = {
    "svdq-int4_r32-qwen-image-edit-lightningv1.0-4steps.safetensors": "svdq-fp4_r32-qwen-image-edit-lightningv1.0-4steps.safetensors",
    "svdq-int4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors": "svdq-fp4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors",
    "svdq-int4_r32-qwen-image-lightningv1.1-8steps.safetensors": "svdq-fp4_r32-qwen-image-lightningv1.1-8steps.safetensors",
    "svdq-int4_r128-qwen-image-lightningv1.1-8steps.safetensors": "svdq-fp4_r128-qwen-image-lightningv1.1-8steps.safetensors",
}


def _normalize_nunchaku_sm120_fp4(graph: dict) -> None:
    """Nunchaku*Loader.model_name:SVDQ int4 → 同构 fp4(SM120 唯一可跑量化)。

    只命中上表登记名(对应 fp4 文件已落盘);已有 fp4/int8 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type") or ""
        if not str(ct).startswith("Nunchaku"):
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        name = inputs.get("model_name")
        if isinstance(name, str):
            mapped = _NUNCHAKU_INT4_TO_FP4.get(name)
            if mapped:
                inputs["model_name"] = mapped


# RH 导出图偶尔带 ComfyUI 显示名/旧包节点名,fleet 现网是下述 class_name
# (wave20 实证:DB 重导入后已本地化,此表防 RH 再导入复发)。
_NODE_CLASS_ALIASES: dict[str, str] = {
    "GIMM-VFI Interpolate": "GIMMVFI_interpolate",
    "String to Int": "StringToInt",
    "Depth Anything V2": "DepthAnything_V2",
}


def _normalize_node_class_aliases(graph: dict) -> None:
    """class_type:RH 显示名/旧名 → fleet 现网节点类名(输入签名兼容,仅改名)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if isinstance(ct, str):
            mapped = _NODE_CLASS_ALIASES.get(ct)
            if mapped:
                node["class_type"] = mapped


_UPSCALE_MODEL_ALIASES: dict[str, str] = {
    # HF 只有 safetensors 发行(Phips/2xNomosUni_span_multijpg_ldl,8.9MB 已落盘);
    # RH 图写 .pth → combo 不命中(wave20 实证 rh-acc-6186996738)。
    "2xNomosUni_span_multijpg_ldl.pth": "2xNomosUni_span_multijpg_ldl.safetensors",
}


def _normalize_upscale_model_aliases(graph: dict) -> None:
    """UpscaleModelLoader.model_name:RH 名 → 本地已落盘同名权重(异扩展名)。"""
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "UpscaleModelLoader":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        name = inputs.get("model_name")
        if isinstance(name, str):
            mapped = _UPSCALE_MODEL_ALIASES.get(name)
            if mapped:
                inputs["model_name"] = mapped


def _normalize_ltxv_img2video_num_images(graph: dict) -> None:
    """LTXVImgToVideoInplaceKJ:缺 num_images 选择器时按 strength_N/index_N 回填。

    RH 图带齐 strength_1..N/index_1..N 却丢 num_images(wave20 实证
    rh-acc-7810908162:execute() missing num_images)。已有 num_images 不动。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "LTXVImgToVideoInplaceKJ":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if "num_images" in inputs:
            continue
        idxs = [
            k
            for k in inputs
            if isinstance(k, str)
            and (k.rsplit("_", 1)[-1].isdigit() and ("." in k or k.startswith(("strength_", "index_"))))
        ]
        if not idxs:
            continue
        n = max(int(k.rsplit("_", 1)[-1]) for k in idxs)
        if n >= 1:
            inputs["num_images"] = str(n)


def _normalize_wan_video_decode_tiles(graph: dict) -> None:
    """WanVideoDecode:tile_stride_* 不得大于 tile_*(custom validation)。

    RH 图写 tile_y=272/tile_stride_y=400 → 「Tile height must be larger than
    the tile stride height」判死(wave20 实证 rh-acc-5219795969)。越界时把
    stride 压到 tile 尺寸;未开 enable_vae_tiling 时语义无损。
    """
    if not isinstance(graph, dict):
        return
    for node in graph.values():
        if not isinstance(node, dict) or node.get("class_type") != "WanVideoDecode":
            continue
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        try:
            tx = inputs.get("tile_x")
            ty = inputs.get("tile_y")
            sx = inputs.get("tile_stride_x")
            sy = inputs.get("tile_stride_y")
            if isinstance(tx, int) and isinstance(sx, int) and sx > tx:
                inputs["tile_stride_x"] = tx
            if isinstance(ty, int) and isinstance(sy, int) and sy > ty:
                inputs["tile_stride_y"] = ty
        except (TypeError, ValueError):
            continue


def _build_graph(workflow: dict, bindings: dict, values: dict) -> dict:
    """深拷贝工作流图并按 bindings 写入表单值(库内原件永不被改写)。

    列表绑定:images/audio/video 文件名数组按序写入各叶子;多出的文件 422;
    未占用的预置 Load* 槽从提交图省略(连同指向它们的 ref_* 连线)。
    """
    graph = copy.deepcopy(workflow)
    bindings = _normalize_comfy_literals_int(graph, bindings)
    _bypass_comfy_literals_link_nodes(graph, bindings)
    _normalize_node_class_aliases(graph)
    _normalize_text_multiline_dynamic_prompts(graph)
    _normalize_wan_video_quantization(graph)
    _normalize_melband_roformer(graph)
    _normalize_ailab_qwen_vl(graph)
    _normalize_wan_video_sampler_teacache(graph)
    _normalize_wan_video_experimental_args(graph)
    _normalize_wan_video_vae_loader(graph)
    _normalize_wan_video_model_loader(graph)
    _normalize_latent_upscale_model_loader(graph)
    _normalize_image_scale_resolution_steps(graph)
    _normalize_easy_image_rembg(graph)
    _normalize_scheduler_aliases(graph)
    _normalize_h3_weight_aliases(graph)
    _normalize_model_file_aliases(graph)
    _normalize_font_aliases(graph)
    _normalize_rmbg_background(graph)
    _normalize_image_rembg_model(graph)
    _normalize_compress_images(graph)
    _normalize_required_backfill(graph)
    _normalize_sec_empty_bbox(graph)
    _normalize_sec_flash_attn_blackwell(graph)
    _normalize_qwen_edit_prompt_string_link(graph)
    _normalize_tiny_vae_alias(graph)
    _normalize_sd3_clip_basename(graph)
    _normalize_trim_audio_duration(graph)
    _normalize_vhs_load_video(graph)
    _normalize_vhs_video_combine(graph)
    _normalize_layermask_model_paths(graph)
    _normalize_easy_prompt_line(graph)
    _normalize_inpaint_expand_mask(graph)
    _normalize_inpaint_crop_improved(graph)
    _normalize_wan_vace_start_end_frame(graph)
    _normalize_wan_sampler_empty_bools(graph)
    _normalize_vae_decode_tiled_vae(graph)
    _normalize_nunchaku_sm120_fp4(graph)
    _normalize_wan_video_decode_tiles(graph)
    _normalize_upscale_model_aliases(graph)
    _normalize_double_extension(graph)
    for key, target in (bindings or {}).items():
        if isinstance(target, list):
            files = _as_filenames(key, values.get(key))
            if len(files) > len(target):
                raise HTTPException(
                    status_code=422,
                    detail=f"参数 {key} 最多 {len(target)} 个文件",
                )
            for i, slot in enumerate(target):
                if i < len(files):
                    _write_leaf(graph, key, slot, files[i])
                else:
                    _omit_media_slot(graph, slot.get("node") if isinstance(slot, dict) else None)
            continue
        v = values.get(key)
        if v is None:
            continue  # 未提供且无默认:保留图内原值
        _write_leaf(graph, key, target, v)
    # 值类 remap 须在绑定写值之后再过一遍:scheduler/unet 等常为表单 select,
    # 表单提交的非法枚举(beta57/旧 H3 权重名)会在上方覆写图内原值
    # (wave19b 实证 rh-acc-3472811009)。全部幂等,只命中登记的非法值。
    _normalize_scheduler_aliases(graph)
    _normalize_h3_weight_aliases(graph)
    _normalize_model_file_aliases(graph)
    _normalize_melband_roformer(graph)
    _normalize_rmbg_background(graph)
    _normalize_tiny_vae_alias(graph)
    _normalize_sd3_clip_basename(graph)
    _normalize_trim_audio_duration(graph)
    _normalize_qwen_edit_prompt_string_link(graph)
    _normalize_nunchaku_sm120_fp4(graph)
    _normalize_comfy_literals_number_str(graph)
    normalize_h3_r2v_autogrow_inputs(graph)
    _normalize_ltxv_dynamiccombo(graph)
    _normalize_ltxv_img2video_num_images(graph)
    _normalize_stale_rh_media(graph, bindings)
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


def _app_job_kind(a: App) -> str:
    """应用运行作业的 Job.kind 派生(2026-09-15 作品库×应用搭配)。

    语义 kind(app_video/app_image/app_audio/app_3d)让作品库类型筛选/计数
    直接生效(前端 FILTERS 按这些别名归桶);submit_kind 是历史遗留的笼统
    "app_run"(550 导入全默认值),视作未定制 → 按应用真实产物类型派生;
    用户显式配置过的其它 submit_kind 照旧尊重。
    """
    submit_kind = (a.submit_kind or "").strip()
    if submit_kind and submit_kind != "app_run":
        return submit_kind
    output = (a.output_kind or "image").strip()
    return f"app_{output}" if output in ("image", "video", "audio", "3d") else "app_image"


# ---------------------------------------------------------------------------
# 路由:M1 CRUD
# ---------------------------------------------------------------------------
@router.get("", response_model=list[AppOut])
def list_apps(
    category: str | None = Query(default=None, description="按分类过滤"),
    q: str | None = Query(default=None, max_length=120, description="名称/简介模糊搜索"),
    use_case: str | None = Query(default=None, description="按用途分类过滤(见 /apps/use-cases/summary)"),
    featured: bool = Query(default=False, description="只看精选合集位"),
    fingerprint: str | None = Query(default=None, max_length=32, description="按功能指纹取同功能变体"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """列表:公共 + 本人(+ 属主上架的个人应用),NSFW 仅 R18 可见,按 sort/name 排序。
    每行 slim(_to_out slim=True):params_schema/bindings/required_nodes 清空,workflow_json 已是 None。
    运行器必须 GET /api/apps/{id} 拿完整 schema。

    2026-09-17 性能:响应走 45s TTL 缓存(写操作 bump 失效)——热路径每请求
    全表查询+2195 行构造+序列化实测 4-14s,缓存命中直接回字节。"""
    allow_nsfw = nsfw_allowed(user)
    params = dict(
        category=category or "", q=q or "", use_case=use_case or "",
        featured=featured, fingerprint=fingerprint or "",
    )
    key = apps_list_cache.make_key(user.id, allow_nsfw, params)
    cached = apps_list_cache.get(key)
    if cached is not None:
        # 早释会话(2026-09-21 事故):FastAPI yield 依赖要等响应流完才 teardown,
        # 7MB 慢流(frp 37KB/s)会把会话(连接)挂住几分钟——缓存命中路径同样
        # 已因 auth 查询开了事务(pg 侧 idle in transaction 实证)。返回前显式关。
        session.close()
        return Response(content=cached, media_type="application/json")
    # 冷路径单飞:缓存失效瞬间 N 并发各自全表重建(10-30s/条)会占满连接池;
    # 锁内二次检查,后来者直接吃首个重建的成果。
    with apps_list_cache.rebuild_lock():
        cached = apps_list_cache.get(key)
        if cached is not None:
            session.close()
            return Response(content=cached, media_type="application/json")
        rows = session.exec(select(App).order_by(App.sort, App.name)).all()
        # 已发布说明书一次性取 map(app_id → AppGuide),防 550 行逐行查(N+1)
        guide_map: dict[str, AppGuide] = {
            g.app_id: g
            for g in session.exec(select(AppGuide).where(AppGuide.status == "published")).all()
        }
        # 功能归组(2026-09-15):同指纹变体计数与代表选定(代表=烟测 pass 优先,其次 usage 最高)
        fp_groups: dict[str, list[App]] = {}
        for a in rows:
            if a.fingerprint:
                fp_groups.setdefault(a.fingerprint, []).append(a)
        fp_representative: set[str] = set()
        fp_variant_count: dict[str, int] = {}
        for fp, group in fp_groups.items():
            if len(group) < 2:
                continue
            rep = max(group, key=lambda x: (x.smoke_status == "pass", x.usage_count, x.id))
            fp_representative.add(rep.id)
            fp_variant_count[rep.id] = len(group)
            fp_variant_count.update({x.id: len(group) for x in group if x.id != rep.id})
        out: list[AppOut] = []
        needle = (q or "").strip().lower()
        for a in rows:
            if not _visible(a, user):
                continue
            if a.is_nsfw and not allow_nsfw:
                continue
            if category and a.category != category:
                continue
            if use_case and (a.use_case or "") != use_case:
                continue
            if fingerprint and (a.fingerprint or "") != fingerprint:
                continue
            if featured and not a.featured:
                continue
            if needle and needle not in a.name.lower() and needle not in (a.description or "").lower():
                continue
            row = _to_out(a, user, slim=True, guide=guide_map.get(a.id))
            row.fingerprint = a.fingerprint or ""
            row.variant_count = fp_variant_count.get(a.id, 0)
            row.is_variant = bool(a.fingerprint) and a.id not in fp_representative and a.id in fp_variant_count
            out.append(row)
        payload = json.dumps(jsonable_encoder(out), ensure_ascii=False).encode()
        apps_list_cache.put(key, payload)
        # 同命中路径:返回前显式早释会话,勿把连接挂到 7MB 慢流结束
        session.close()
        return Response(content=payload, media_type="application/json")


@router.get("/{aid}", response_model=AppOut)
def get_app(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AppOut:
    """详情;workflow_json 对所有可见用户透出(2026-09-02 产品决策:运行页「工作流」
    模式把流程图展现给用户,最可控;可见性/NSFW 门控仍由 _get_visible 卡死)。"""
    a = _get_visible(session, aid, user)
    return _to_out(a, user, with_workflow=True, guide=session.get(AppGuide, aid))


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
        cover_url=body.cover_url,
        author=body.author,
        category=body.category,
        workflow_json=body.workflow_json,
        fingerprint=graph_fingerprint(body.workflow_json),
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
    apps_list_cache.bump()
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
    # 内置仅允许 admin 调整上架状态/排序(下架无法本机跑通的死卡),禁止改图与文案。
    if a.is_builtin:
        allowed = {"is_public", "sort"}
        patch_fields = {
            f for f in (
                "name", "description", "icon", "cover_url", "author", "category",
                "workflow_json", "params_schema", "bindings", "required_nodes",
                "output_kind", "submit_kind", "is_nsfw", "is_public", "sort",
            )
            if getattr(body, f) is not None
        }
        bad = sorted(patch_fields - allowed)
        if bad:
            raise HTTPException(status_code=403, detail=f"内置应用仅可调整上架/排序,不可改: {', '.join(bad)}")
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
        "name", "description", "icon", "cover_url", "author", "category",
        "workflow_json", "params_schema",
        "bindings", "required_nodes", "output_kind", "submit_kind",
        "is_nsfw", "is_public", "sort",
    ):
        val = getattr(body, f)
        if val is not None:
            setattr(a, f, val)
    if body.workflow_json is not None:
        a.fingerprint = graph_fingerprint(a.workflow_json)
    a.updated_at = _now()
    session.add(a)
    session.commit()
    apps_list_cache.bump()
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
    _remove_cover_file(a.cover_url)  # 本服务托管的封面随应用删除(外链不动)
    session.delete(a)
    session.commit()
    apps_list_cache.bump()
    return {"ok": True, "id": aid}





async def _comfy_userdata_targets(canvas_url: str) -> list[str]:
    """画布 userdata 写入目标:LB 本身 + 注册表 backends(localhost 改写为画布主机)。

    Comfy-LB 的 /api/userdata 常按后端轮询落盘,?workflow= 读到另一台会 404;
    因此 fan-out 到所有健康后端,保证 iframe 无论打到哪台都能 Load。
    """
    base = canvas_url.rstrip("/")
    targets = [base]
    canvas_host = urlsplit(base).hostname or ""
    try:
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            resp = await client.get(f"{base}/admin/backends")
            if resp.status_code == 200:
                data = resp.json() if resp.content else {}
                for b in (data.get("backends") or []) if isinstance(data, dict) else []:
                    if not isinstance(b, dict) or b.get("healthy") is False:
                        continue
                    raw = str(b.get("url") or "").strip().rstrip("/")
                    if not raw:
                        continue
                    parts = urlsplit(raw)
                    if parts.hostname in ("127.0.0.1", "localhost") and canvas_host:
                        raw = f"{parts.scheme}://{canvas_host}:{parts.port or 80}"
                    if raw not in targets:
                        targets.append(raw)
    except Exception as exc:
        logger.info("open-in-comfy 拉取 backends 失败,仅写画布地址: %s", type(exc).__name__)
    if canvas_host:
        alt = f"{urlsplit(base).scheme}://{canvas_host}:8196"
        if alt not in targets:
            targets.append(alt)
    return targets


class OpenInComfyOut(BaseModel):
    """应用 → 原生 Comfy 二次编辑:已上传 UI 图到画布 worker,前端拼 ?workflow=。"""

    workflow_name: str
    worker_url: str
    load_url: str
    app_id: str
    node_count: int
    save_back: str = "not_implemented"  # 回写 App.workflow_json 尚未做;编辑仅在 Comfy 会话内


@router.post("/{aid}/open-in-comfy", response_model=OpenInComfyOut)
async def open_app_in_comfy(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> OpenInComfyOut:
    """把可见应用的 API/UI 工作流落到画布 Comfy worker,供原生二次编辑。

    1) 取可见 workflow_json;
    2) API → UI(api_to_ui;已是 UI 则原样);
    3) POST 到 settings.canvas_comfy_url 的 /api/userdata/workflows%2F…;
    4) 返回 workflow_name;前端 Canvas iframe 加 ?workflow= 即可自动 Load。

    不写回应用(save_back=not_implemented):用户在 Comfy 内另存/导出即可。
    """
    a = _get_visible(session, aid, user)
    wf = a.workflow_json or {}
    if not isinstance(wf, dict) or not wf:
        raise HTTPException(status_code=422, detail="应用无工作流图")

    try:
        if is_ui_format(wf):
            ui = wf
        elif is_api_format(wf):
            ui = api_to_ui(wf)
        else:
            raise ValueError("工作流既非 UI 也非 API 格式")
    except ValueError as e:
        raise HTTPException(status_code=422, detail=f"工作流转换失败: {e}") from e

    safe = re.sub(r"[^A-Za-z0-9_-]", "_", aid)[:64] or "app"
    workflow_name = f"toiv_app_{safe}.json"
    settings = get_settings()
    worker_url = (settings.canvas_comfy_url or "").strip().rstrip("/")
    if not worker_url:
        raise HTTPException(status_code=503, detail="未配置画布 Comfy 地址(TOIV_CANVAS_COMFY_URL)")

    targets = await _comfy_userdata_targets(worker_url)
    encoded_path = f"workflows%2F{workflow_name}"
    ok_hosts: list[str] = []
    last_err = ""
    try:
        async with httpx.AsyncClient(timeout=30.0, trust_env=False) as client:
            for base in targets:
                upload_url = f"{base}/api/userdata/{encoded_path}"
                try:
                    resp = await client.post(upload_url, json=ui)
                    if resp.status_code in (200, 201):
                        ok_hosts.append(base)
                    else:
                        last_err = f"HTTP {resp.status_code} @ {base}"
                        logger.warning("open-in-comfy 上传失败: %s", last_err)
                except httpx.RequestError as exc:
                    last_err = f"{type(exc).__name__} @ {base}"
                    logger.warning("open-in-comfy 连接失败: %s", last_err)
    except httpx.RequestError as exc:
        logger.warning("open-in-comfy 客户端异常: %s", type(exc).__name__)
        raise HTTPException(status_code=502, detail="连接画布 Comfy worker 失败") from exc

    if not ok_hosts:
        raise HTTPException(
            status_code=502,
            detail=f"上传到 ComfyUI 失败: {last_err or '无可用 worker'}",
        )

    load_url = f"{worker_url}/?workflow={workflow_name}"
    audit.record(
        session,
        user=user,
        action="app.open_in_comfy",
        target_type="app",
        target_id=aid,
        summary=f"打开应用到 Comfy 二次编辑:{a.name}",
        detail={
            "workflow_name": workflow_name,
            "node_count": len(ui.get("nodes") or []),
            "uploaded_to": ok_hosts,
        },
    )
    session.commit()
    return OpenInComfyOut(
        workflow_name=workflow_name,
        worker_url=worker_url,
        load_url=load_url,
        app_id=aid,
        node_count=len(ui.get("nodes") or []),
    )


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
        cover_url=src.cover_url or "",
        author=src.author or "",
        category=src.category,
        workflow_json=copy.deepcopy(src.workflow_json or {}),
        fingerprint=src.fingerprint or graph_fingerprint(src.workflow_json or {}),
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



# 专用实例节点(不在 WorkerPool / ComfyUI-LB)。市场应用图若含这些 class_type,
# 必须走对应 client,否则 pool.pick 会在通用池里找不到模型/节点 → 503
# 「没有具备所需模型且可用的 worker」。
_H3_NODES = {
    "MiniMaxH3ImageToVideo",
    "MiniMaxH3ReferenceToVideo",
    "MiniMaxH3AddGuide",
    "MiniMaxH3TurboSampler",
    "MiniMaxH3TurboLoRA",
}
_QWEN_EDIT_NODES = {
    "TextEncodeQwenImageEdit",
    "TextEncodeQwenImageEditPlus",
    "TextEncodeQwenImageEditPlus_lrzjason",
    "TextEncodeQwenImageEditPlusAdvance_lrzjason",
    "TextEncodeQwenImageEditPlusCustom_lrzjason",
    "QwenEditConfigPreparer",
    "QwenEditConfigJsonParser",
    "QwenEditOutputExtractor",
    "QwenEditListExtractor",
    "QwenEditTextEncode_EditUtils",
    "QwenEditOutputExtractor_EditUtils",
    "QwenImageEditApply_EditUtils",
    "QwenModelConfig_EditUtils",
    "QwenConfigPreparer_EditUtils",
}
# LongCat / WanVideoWrapper 家族(GPU0 :8197)。注意:wan-animate / longcat-i2v /
# VACE / Phantom / Ovi 的真实 class_type 是 WanVideo* KJ 节点,不是 WanAnimateToVideo。
_LONGCAT_NODES = {
    "LongCatVideoSampler",
    "LongCatImageToVideo",
    "LongCatTextToVideo",
    "WanVideoModelLoader",
    "WanVideoAnimateEmbeds",
    "WanVideoVACEEncode",
    "WanVideoPhantomEmbeds",
    "WanAnimateToVideo",
    "WanPhantomSubjectToVideo",
    "WanVaceToVideo",
    "OviMMAudioVAELoader",
}
_ANIMATE2_NODES = {
    "WanAnimate2ToVideo",
    "WanAnimate2Cache",
}
# 媒体加载节点 → 需要与专用实例同机的 input 文件名键
_MEDIA_LOADER_KEYS: dict[str, tuple[str, ...]] = {
    "LoadImage": ("image",),
    "LoadVideo": ("file", "video"),
    "LoadAudio": ("audio",),
    "VHS_LoadVideo": ("video",),
    "VHS_LoadAudioUpload": ("audio",),
    "VHS_LoadVideoPath": ("video",),
}
_MEDIA_EXTS = (
    ".png", ".jpg", ".jpeg", ".webp", ".gif",
    ".mp4", ".mov", ".webm",
    ".wav", ".mp3", ".m4a", ".ogg", ".flac",
)


def _looks_like_media_filename(name: str) -> bool:
    lower = name.lower()
    return any(lower.endswith(ext) for ext in _MEDIA_EXTS)


def _iter_graph_media_filenames(graph: dict) -> list[str]:
    """从图中 Load* / VHS_Load* 节点收集用户上传文件名(跳过节点连线 list)。"""
    out: list[str] = []
    seen: set[str] = set()
    for node in graph.values():
        if not isinstance(node, dict):
            continue
        ct = node.get("class_type")
        if not isinstance(ct, str):
            continue
        keys = _MEDIA_LOADER_KEYS.get(ct)
        if keys is None and "Load" in ct:
            keys = ("image", "video", "audio", "file")
        if not keys:
            continue
        inputs = node.get("inputs") or {}
        if not isinstance(inputs, dict):
            continue
        for k in keys:
            v = inputs.get(k)
            if not isinstance(v, str):
                continue
            name = v.strip()
            if not name or name in seen or not _looks_like_media_filename(name):
                continue
            seen.add(name)
            out.append(name)
    return out


def _is_pool_client(pool, client) -> bool:
    """client 是否属于通用 WorkerPool(专用实例不在 clients 里)。"""
    base = getattr(client, "base_url", "") or ""
    want = base.rstrip("/")
    for c in getattr(pool, "clients", []) or []:
        if (getattr(c, "base_url", "") or "").rstrip("/") == want:
            return True
    return False


def _media_transfer_source_clients(pool, target_client) -> list:
    """媒体转运候选源 = 通用池 + 专用实例(H3 池全部 / LongCat / Animate2 / QwenEdit)。

    上传 kind 钉传(h3_i2v 等)可把媒体落在任一专用实例,而 H3 双池提交会按
    least-loaded 改选另一实例——只查 pool.clients 读源会 404/连接失败
    (2026-09-13 wave16 实证 :8195 上传 → :8198 提交转运失败)。
    各专用实例不可达/未配置时静默跳过(读源循环本就按失败逐个尝试)。
    """
    settings = get_settings()
    sources: list = list(getattr(pool, "clients", []) or [])
    seen = {(getattr(c, "base_url", "") or "").rstrip("/") for c in sources}
    target_base = (getattr(target_client, "base_url", "") or "").rstrip("/")

    def _add(client) -> None:
        base = (getattr(client, "base_url", "") or "").rstrip("/")
        if base and base != target_base and base not in seen:
            seen.add(base)
            sources.append(client)

    try:
        from app.services.h3 import h3_instances
        for url in h3_instances():
            if url.rstrip("/") not in seen and url.rstrip("/") != target_base:
                _add(ComfyUIClient(url, timeout=settings.request_timeout))
    except Exception:  # noqa: BLE001 — 配置缺失/导入失败 → 仅少一个候选源
        pass
    import importlib

    for getter_name, module in (
        ("get_longcat_client", "app.services.longcat"),
        ("get_animate2_client", "app.services.wan_animate2"),
        ("get_qwen_edit_client", "app.services.qwen_edit"),
    ):
        try:
            getter = getattr(importlib.import_module(module), getter_name)
            _add(getter())
        except Exception:  # noqa: BLE001 — 同上
            pass
    return sources


async def _ensure_graph_media_on_client(client, pool, graph: dict) -> None:
    """市场 /run 同机兜底:专用实例不在 all_workers / pool.pick 上传落点时,
    把图上媒体从任意已知 worker(池 + 专用实例)转运到目标实例。

    若文件已在目标实例(客户端 pin worker= 到专用机),直接跳过。
    通用池任务无需转运。
    """
    if _is_pool_client(pool, client):
        return
    names = _iter_graph_media_filenames(graph)
    if not names:
        return
    sources = _media_transfer_source_clients(pool, client)
    for name in names:
        # 已在目标机 → 跳过(L2/前端 pin worker= 到专用实例的路径)
        try:
            await client.get_image_bytes(name, "", "input")
            continue
        except ComfyUIError:
            pass
        transferred = False
        last_err: Exception | None = None
        for src in sources:
            try:
                content, _ = await get_image_bytes_any(src, name)
            except ComfyUIError as e:
                last_err = e
                continue
            try:
                await client.upload_image(content, name)
                transferred = True
                break
            except ComfyUIError as e:
                last_err = e
        if not transferred:
            # 点名引用该文件的加载节点:hash 名多为 RH 导入残留的原始用户媒体引用
            # (未绑定表单槽,任何 worker 都不可能有),点名后分流/修数据不再靠猜。
            refs = [
                f"{nid}({node.get('class_type')})"
                for nid, node in graph.items()
                if isinstance(node, dict)
                and any(
                    v == name
                    for v in (node.get("inputs") or {}).values()
                    if isinstance(v, str)
                )
            ]
            detail = f"媒体文件无法转运到运行实例({getattr(client, 'base_url', '')}): {name}"
            if refs:
                detail = f"{detail}(图内引用节点: {', '.join(refs[:5])})"
            if last_err is not None:
                detail = f"{detail}; 原因: {last_err}"
            raise HTTPException(status_code=502, detail=detail)


def _doomed_save_nodes(graph: dict, node_errors: dict) -> tuple[set[str], list[str]]:
    """ComfyUI 部分校验失败(/prompt 200 + node_errors)时,算出「必不执行」的保存节点。

    每个失效节点携带 dependent_outputs = 依赖它的输出节点;保存节点落在任一
    dependent_outputs(或自身失效)即被判死,作业会「success」但主保存节点
    零产出(tracker 事后才报错,用户体验为白跑一轮 GPU)。
    返回 (被判死的保存节点 id 集, 可读原因列表);无保存节点/无校验失败返回空。
    """
    if not node_errors:
        return set(), []
    save_ids = {
        str(nid)
        for nid, node in graph.items()
        if isinstance(node, dict) and node.get("class_type") in _SAVE_OR_COMBINE_TYPES
    }
    if not save_ids:
        return set(), []
    broken: set[str] = set()
    reasons: list[str] = []
    for nid, info in node_errors.items():
        if not isinstance(info, dict):
            continue
        ct = info.get("class_type") or ""
        if not ct:
            node = graph.get(str(nid)) or {}
            ct = node.get("class_type") if isinstance(node, dict) else ""
        for err in info.get("errors") or []:
            if isinstance(err, dict):
                msg = str(err.get("message") or "")
                det = str(err.get("details") or "")
                reasons.append(f"{ct or nid}: {msg} {det}".strip())
        broken.update(str(d) for d in (info.get("dependent_outputs") or []))
        broken.add(str(nid))
    return save_ids & broken, reasons


async def _queue_with_validation(client, graph: dict, client_id: str) -> tuple[str, dict]:
    """校验感知提交;测试替身等无 queue_prompt_validated 的 client 回退普通提交。"""
    validated = getattr(client, "queue_prompt_validated", None)
    if validated is None:
        return await client.queue_prompt(graph, client_id), {}
    return await validated(graph, client_id)


async def _pick_app_client(pool, nodes: set[str], required: set[str]):
    """按图上的 class_type 把应用派到专用实例,其余仍走 WorkerPool。"""
    # 含 Turbo/T8 等变体:凡 MiniMaxH3* 都走 H3 专用实例,避免 pool.pick 在通用池 503。
    h3_like = {
        n for n in nodes
        if isinstance(n, str) and (
            n.startswith(("MiniMaxH3", "MinimaxH3", "RHMiniMaxH3", "RHMinimaxH3", "RH_MinimaxHailuoH3", "HailuoH3"))
            or "MiniMaxH3" in n
            or "MinimaxH3" in n
            or "HailuoH3" in n
        )
    }
    if nodes & _H3_NODES or h3_like:
        from app.services.h3 import ensure_h3_enabled, ensure_h3_ready, ensure_h3_vram, pick_h3_client
        ensure_h3_enabled()
        client = await pick_h3_client()
        probe = "MiniMaxH3ReferenceToVideo" if "MiniMaxH3ReferenceToVideo" in nodes else "MiniMaxH3ImageToVideo"
        # 变体图可能没有标准 I2V/R2V;有则严格探测,无则探测基础 I2V 节点是否在线。
        if probe in nodes or probe in h3_like:
            await ensure_h3_ready(client, node=probe)
        else:
            await ensure_h3_ready(client)
        await ensure_h3_vram(client)
        return client
    qwen_edit_like = {
        n for n in nodes
        if isinstance(n, str) and (
            n in _QWEN_EDIT_NODES
            or n.startswith("TextEncodeQwenImageEdit")
            or n.startswith("QwenEdit")
            or ("_lrzjason" in n and ("Qwen" in n or "Edit" in n))
        )
    }
    # 排除通用池 VL/对话节点,避免误打 Qwen-Edit 专用实例
    qwen_edit_like = {
        n for n in qwen_edit_like
        if not n.startswith(("AILab_QwenVL", "Qwen3_VQA", "QwenLoader", "TextImageEncodeQwenVL"))
    }
    if nodes & _QWEN_EDIT_NODES or qwen_edit_like:
        from app.services.qwen_edit import get_qwen_edit_client
        return get_qwen_edit_client()
    # Wan-Animate-2 原生节点在 :8199(先于 LongCat,避免被 Wan* 宽匹配误伤)
    if nodes & _ANIMATE2_NODES or any(
        isinstance(n, str) and n.startswith("WanAnimate2") for n in nodes
    ):
        from app.services.wan_animate2 import get_animate2_client
        return get_animate2_client()
    # LongCat / Animate1 / VACE / Phantom / Ovi:WanVideo* KJ 包装器家族在 :8197
    longcat_like = bool(nodes & _LONGCAT_NODES) or any(
        isinstance(n, str) and (
            n.startswith("LongCat")
            or n.startswith("WanVideo")
            or n in {"WanAnimateToVideo", "WanPhantomSubjectToVideo", "WanVaceToVideo"}
        )
        for n in nodes
    )
    if longcat_like:
        from app.services import longcat as longcat_svc
        getter = getattr(longcat_svc, "get_longcat_client", None) or getattr(longcat_svc, "pick_longcat_client", None)
        if getter is None:
            raise ComfyUIError("LongCat 专用实例未配置")
        client = getter()
        if hasattr(client, "__await__"):
            client = await client
        return client
    return await pool.pick(required=required, required_nodes=nodes)


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
    """运行应用:校验表单 → 写图 → 提交 worker → 建档 Job + 审计。

    usage_count 不在提交时 +1(失败/取消也计数是误计,2026-08-30 P2):
    只在 Job 到 done 时由 tracker.mark_done 按 params.app_id +1。
    """
    a = session.get(App, aid)
    if not a or not _visible(a, user):
        raise HTTPException(status_code=404, detail="应用不存在")
    # is_nsfw 应用须 R18 上下文(与详情 404 不泄露不同:run 是动作,显式 403 引导去专页)
    if a.is_nsfw and not nsfw_allowed(user):
        raise HTTPException(status_code=403, detail="该操作为 R18 内容,仅限 NSFW 专区使用")
    mode = (body.content_mode or ("nsfw" if a.is_nsfw else "sfw")).strip().lower()
    if mode not in ("sfw", "nsfw"):
        raise HTTPException(status_code=422, detail="content_mode 须为 sfw 或 nsfw")
    run_app = a
    run_nsfw = bool(a.is_nsfw)
    if mode == "nsfw":
        twin_id = nsfw_variant_id_for(a.id)
        if twin_id:
            twin = session.get(App, twin_id)
            if not twin:
                raise HTTPException(status_code=422, detail=f"R18 变体不存在: {twin_id}")
            if not nsfw_allowed(user):
                raise HTTPException(status_code=403, detail="该操作为 R18 内容,仅限 NSFW 专区使用")
            run_app = twin
            run_nsfw = True
        elif not a.is_nsfw:
            raise HTTPException(status_code=422, detail="该应用无 R18 内容模式")
        else:
            run_nsfw = True
    enforce_generation_rate_limit(user)
    # 表单仍按父卡 schema 校验(与 twin 对齐);图/绑定取实际运行卡
    values = _validate_params(a.params_schema or [], body.values)
    graph = _build_graph(run_app.workflow_json or {}, run_app.bindings or {}, values)
    if not graph:
        raise HTTPException(status_code=422, detail="应用未配置工作流图")
    # 模型依赖从写值后的图提取(绑定可能改写模型引用叶子);节点依赖空则从图自动取
    required = _extract_required(graph)
    nodes = set(run_app.required_nodes or a.required_nodes or []) or {
        n["class_type"] for n in graph.values() if isinstance(n, dict) and n.get("class_type")
    }
    # H3 智能加速(2026-09-12):非 H3 家族应用拒收非 off 档(口径与 _pick_app_client 一致);
    # 规格文件缺失时 apply 内部降级为原生提交(applied=False + warning 日志),不报错。
    if body.acceleration != "off" and not h3_accel.is_h3_family(a.id, nodes):
        raise HTTPException(status_code=422, detail="智能加速(acceleration)仅支持 H3 家族应用")
    if body.acceleration != "off":
        graph, accel_applied = h3_accel.apply_acceleration(graph, body.acceleration)
    else:
        accel_applied = False
    try:
        client = await _pick_app_client(pool, nodes, required)
    except ComfyUIError as e:
        raise HTTPException(status_code=503, detail=str(e)) from e
    except HTTPException:
        raise
    # 专用实例(H3/LongCat/animate2/qwen-edit)不在 WorkerPool:市场上传常落 pool
    # (all_workers / kind 空要求),studio 会显式 transfer;市场 /run 在此同机兜底。
    await _ensure_graph_media_on_client(client, pool, graph)
    client_id = uuid.uuid4().hex
    try:
        prompt_id, node_errors = await _queue_with_validation(client, graph, client_id)
    except ComfyUIError as e:
        _raise_from_comfy_error(e)
    # ComfyUI ≥0.3x 部分校验失败不拒绝整单:失效节点及其依赖输出被跳过仍 200。
    # 主保存节点全部被判死时立即 422 透出真因(缺模型/缺必填入参),并尽力撤销
    # 已入队作业,避免烧一轮 GPU 后 tracker 才报「主保存节点未产出」(wave16 实证)。
    doomed, reasons = _doomed_save_nodes(graph, node_errors)
    if doomed:
        cancel = getattr(client, "cancel_prompt", None)
        if cancel is not None:
            try:
                await cancel(prompt_id)
            except Exception as exc:  # noqa: BLE001 — 撤销失败不遮蔽主错误
                logger.warning("撤销校验失败作业 %s 未成功: %s", prompt_id, exc)
        raise HTTPException(
            status_code=422,
            detail="工作流校验未通过,主保存节点不会执行: " + "; ".join(reasons or sorted(doomed)),
        )

    job = Job(
        tenant_id=user.tenant_id,
        user_id=user.id,
        prompt_id=prompt_id,
        worker=client.base_url,
        kind=_app_job_kind(a),
        status="queued",
        prompt=_prompt_preview(a, values),
        seed=_seed_of(values),
        nsfw=run_nsfw,
        params=json.dumps(
            {
                "app_id": a.id, "run_app_id": run_app.id, "content_mode": mode, "values": values,
                "acceleration": body.acceleration, "acceleration_applied": accel_applied,
            },
            ensure_ascii=False,
        ),
    )
    session.add(job)
    audit.record(
        session, user=user, action="app.run", target_type="app", target_id=a.id,
        summary=f"运行应用:{a.name}",
        detail={"app_id": a.id, "prompt_id": prompt_id, "content_mode": mode},
    )
    session.commit()
    session.refresh(job)

    # 服务端后台追踪结果落库,不依赖客户端 SSE(同 generate 系端点)
    spawn_tracker(client, prompt_id)

    return {
        "job_id": job.id,
        "prompt_id": prompt_id,
        "client_id": client_id,
        "worker": client.base_url,
        "app_id": a.id,
        "content_mode": mode,
        "usage_count": a.usage_count,
        "acceleration": body.acceleration,
        "acceleration_applied": accel_applied,
    }


# ---------------------------------------------------------------------------
# 路由:M5 智能导入(分析 → LLM 包装 → 草稿 → 确认落库)
# ---------------------------------------------------------------------------
# 草稿暂存:进程内存 dict,TTL 10min,不落库(确认才落 App 行)。
# 单进程语义:api 重启草稿全丢(前端提示重新导入即可),多进程部署需各自会话内完成。
_IMPORT_DRAFT_TTL_SEC = 600.0
_IMPORT_DRAFTS: dict[str, dict] = {}

_LLM_503_DETAIL = "智能包装服务暂不可用,请稍后重试;也可以手动创建应用"


def _purge_drafts() -> None:
    """顺手清理过期草稿(每次 stash/take 调用,免后台任务)。"""
    now = time.monotonic()
    stale = [k for k, d in _IMPORT_DRAFTS.items() if now - d["created_at"] > _IMPORT_DRAFT_TTL_SEC]
    for k in stale:
        _IMPORT_DRAFTS.pop(k, None)


def _stash_draft(user_id: str, analysis_graph: dict, packaged: object, warnings: list[str]) -> str:
    _purge_drafts()
    draft_id = uuid.uuid4().hex
    _IMPORT_DRAFTS[draft_id] = {
        "created_at": time.monotonic(),
        "user_id": user_id,
        "workflow": copy.deepcopy(analysis_graph),
        "packaged": packaged,
        "warnings": list(warnings),
    }
    return draft_id


def _peek_draft(draft_id: str, user_id: str) -> dict | None:
    """窥视草稿(不消费);不存在/过期/非本人一律 None(404 不泄露)。"""
    _purge_drafts()
    draft = _IMPORT_DRAFTS.get(draft_id)
    if not draft or draft["user_id"] != user_id:
        return None
    if time.monotonic() - draft["created_at"] > _IMPORT_DRAFT_TTL_SEC:
        _IMPORT_DRAFTS.pop(draft_id, None)
        return None
    return draft


class AppImportRequest(BaseModel):
    workflow: dict


class AppImportConfirmRequest(BaseModel):
    draft_id: str = Field(min_length=1, max_length=64)
    # 确认前可覆盖的展示字段(图/schema/bindings 不可在 confirm 改,保持草稿=落库一致)
    overrides: dict = Field(default_factory=dict)


class AppImportDraftOut(BaseModel):
    draft_id: str
    name: str
    description: str
    icon: str
    category: str
    output_kind: str
    is_nsfw_guess: bool
    params_schema: list[dict]
    bindings: dict
    warnings: list[str]


@router.post("/import", response_model=AppImportDraftOut)
async def import_app(
    body: AppImportRequest,
    user: User = Depends(get_current_user),
) -> AppImportDraftOut:
    """智能导入第一步:工作流 JSON → 结构分析 + LLM 包装 → 草稿(10min 有效,不落库)。"""
    enforce_generation_rate_limit(user)
    try:
        analysis = analyze_workflow(body.workflow)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e)) from e
    if len(analysis.graph) > 400:
        raise HTTPException(status_code=422, detail="工作流节点过多(>400)")
    try:
        packaged, warnings = await package_with_llm(analysis)
    except LLMError as e:
        logger.warning("智能导入 LLM 包装失败: %s", e)
        raise HTTPException(status_code=503, detail=_LLM_503_DETAIL) from e
    draft_id = _stash_draft(user.id, analysis.graph, packaged, warnings)
    return AppImportDraftOut(
        draft_id=draft_id,
        name=packaged.name,
        description=packaged.description,
        icon=packaged.icon,
        category=packaged.category,
        output_kind=packaged.output_kind,
        is_nsfw_guess=packaged.is_nsfw_guess,
        params_schema=packaged.params_schema,
        bindings=packaged.bindings,
        warnings=warnings,
    )


def _apply_confirm_overrides(packaged: object, overrides: dict) -> None:
    """confirm 的覆盖字段逐个校验;非法一律 422(不给脏数据落库)。"""
    if not isinstance(overrides, dict):
        raise HTTPException(status_code=422, detail="overrides 必须是对象")
    allowed = {"name", "description", "icon", "category", "output_kind", "is_nsfw"}
    unknown = set(overrides) - allowed
    if unknown:
        raise HTTPException(status_code=422, detail=f"不支持的覆盖字段: {sorted(unknown)}")
    if "name" in overrides:
        v = overrides["name"]
        if not isinstance(v, str) or not v.strip() or len(v) > 120:
            raise HTTPException(status_code=422, detail="name 须为 1-120 字符")
        packaged.name = v.strip()
    if "description" in overrides:
        v = overrides["description"]
        if not isinstance(v, str) or len(v) > 500:
            raise HTTPException(status_code=422, detail="description 须为 ≤500 字符")
        packaged.description = v
    if "icon" in overrides:
        v = overrides["icon"]
        if not isinstance(v, str) or v not in ICON_WHITELIST:
            raise HTTPException(status_code=422, detail=f"icon 须为白名单之一(收到 {v!r})")
        packaged.icon = v
    if "category" in overrides:
        v = overrides["category"]
        if v not in _CATEGORIES:
            raise HTTPException(status_code=422, detail=f"category 须为 {sorted(_CATEGORIES)} 之一")
        packaged.category = v
    if "output_kind" in overrides:
        v = overrides["output_kind"]
        if v not in _OUTPUT_KINDS:
            raise HTTPException(status_code=422, detail=f"output_kind 须为 {sorted(_OUTPUT_KINDS)} 之一")
        packaged.output_kind = v
    if "is_nsfw" in overrides:
        v = overrides["is_nsfw"]
        if not isinstance(v, bool):
            raise HTTPException(status_code=422, detail="is_nsfw 须为布尔值")
        packaged.is_nsfw_guess = v


@router.post("/import/confirm", response_model=AppOut)
def confirm_import_app(
    body: AppImportConfirmRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AppOut:
    """智能导入第二步:确认草稿(可覆盖展示字段)→ 落库为个人应用(is_public=False)。"""
    draft = _peek_draft(body.draft_id, user.id)
    if draft is None:
        raise HTTPException(status_code=404, detail="草稿不存在或已过期,请重新导入")
    # 先在校验副本上应用覆盖:非法覆盖 422 不吞草稿,用户改完可重提
    packaged = copy.deepcopy(draft["packaged"])
    _apply_confirm_overrides(packaged, body.overrides)
    _IMPORT_DRAFTS.pop(body.draft_id, None)  # 校验通过才消费(一次性)
    new_id = f"{_slugify(packaged.name)[:40]}-{uuid.uuid4().hex[:6]}"
    while session.get(App, new_id):  # slug 撞车兜底(同 fork)
        new_id = f"{_slugify(packaged.name)[:40]}-{uuid.uuid4().hex[:6]}"
    a = App(
        id=new_id,
        name=packaged.name,
        description=packaged.description,
        icon=packaged.icon,
        category=packaged.category,
        workflow_json=copy.deepcopy(draft["workflow"]),
        fingerprint=graph_fingerprint(draft["workflow"]),
        params_schema=copy.deepcopy(packaged.params_schema),
        bindings=copy.deepcopy(packaged.bindings),
        required_nodes=[],  # 运行时从图自动取
        output_kind=packaged.output_kind,
        submit_kind="app_run",
        is_builtin=False,
        is_nsfw=packaged.is_nsfw_guess,
        is_public=False,
        user_id=user.id,
        usage_count=0,
        sort=100,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a, user, with_workflow=True)



# ---------------------------------------------------------------------------
# 路由:M6 封面(RunningHub 化,2026-09-06)
# ---------------------------------------------------------------------------
_COVER_NAME_RE = re.compile(r"^appcover(?:-demo)?-[0-9a-f]{32}\.(png|jpg|webp|gif)$")
_COVER_URL_PREFIX = "/api/apps/covers/file/"
_COVER_MAX_BYTES = 8 * 1024 * 1024  # 8MB(卡片封面足够;防内存撑爆同 upload 纪律)
_COVER_IMAGE_KINDS = {"png", "jpg", "webp", "gif"}  # _sniff_media 魔数口径
_COVER_MIME = {
    "png": "image/png",
    "jpg": "image/jpeg",
    "webp": "image/webp",
    "gif": "image/gif",
}


def _remove_cover_file(url: str) -> None:
    """删除本服务托管的封面文件(替换/删应用时);外链与非法名一律不动,失败只告警。"""
    if not url or not url.startswith(_COVER_URL_PREFIX):
        return
    name = url[len(_COVER_URL_PREFIX):]
    if not _COVER_NAME_RE.fullmatch(name):
        return
    try:
        (content_subdir("app-covers") / name).unlink(missing_ok=True)
    except OSError as e:
        logger.warning("封面文件删除失败 %s: %s", name, e)


@router.post("/{aid}/cover", response_model=AppOut)
async def upload_app_cover(
    aid: str,
    file: UploadFile,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> AppOut:
    """上传应用封面(仅 admin;内置/公共/个人应用均可,运营维护操作)。

    三重校验:Content-Type 须 image/* + 魔数白名单(png/jpg/webp/gif)+ ≤8MB;
    落 content_subdir("app-covers") 并把 /api/apps/covers/file/{name} 写进
    App.cover_url;替换时旧文件(本服务托管的)一并删除。
    """
    a = session.get(App, aid)
    if not a:
        raise HTTPException(status_code=404, detail="应用不存在")
    if file.content_type and not file.content_type.startswith("image/"):
        raise HTTPException(status_code=415, detail="仅接受图片文件(png/jpg/webp/gif)")
    content = await file.read(_COVER_MAX_BYTES + 1)
    if len(content) > _COVER_MAX_BYTES:
        raise HTTPException(status_code=413, detail="封面图过大(上限 8MB)")
    kind = _sniff_media(content)
    if kind not in _COVER_IMAGE_KINDS:
        raise HTTPException(status_code=415, detail="不是有效图片文件(魔数校验失败)")
    name = f"appcover-{uuid.uuid4().hex}.{kind}"
    try:
        (content_subdir("app-covers") / name).write_bytes(content)
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"封面目录不可写:{e}") from e
    old_url = a.cover_url or ""
    a.cover_url = f"{_COVER_URL_PREFIX}{name}"
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    _remove_cover_file(old_url)
    return _to_out(a, admin, with_workflow=True)


@router.get("/covers/file/{name}")
async def app_cover_file(
    name: str,
    request: Request,
    user: User = Depends(get_current_user),  # <img> 走 ?token= 查询参数(deps 内置回退)
) -> Response:
    """封面回读(手动 Range,同 chromakey 产物服务口径)。"""
    if not _COVER_NAME_RE.fullmatch(name):
        raise HTTPException(status_code=400, detail="非法文件名")
    path = content_subdir("app-covers") / name
    if not path.is_file():
        raise HTTPException(status_code=404, detail="封面不存在")
    ext = name.rsplit(".", 1)[1]
    return _ranged_response(path.read_bytes(), _COVER_MIME[ext], request.headers.get("range"))


class CoversGenerateRequest(BaseModel):
    limit: int = Field(default=20, ge=1, le=200)  # 本批最多生成多少个目标(缺口+外扩合计)
    batch_size: int = Field(default=2, ge=1, le=8)  # 批内并发(限速)
    execute: bool = True  # false = 干跑,只回待生成清单不烧 GPU
    # P3:对仍共享家族封面的 rh-* 卡,按 usage_count 取头部单独生成(force 覆盖该卡 URL)
    expand_top: int = Field(default=0, ge=0, le=100)


@router.post("/covers/generate")
async def generate_app_covers(
    body: CoversGenerateRequest,
    admin: User = Depends(get_current_admin),
    pool: WorkerPool = Depends(get_pool),
    session: Session = Depends(get_session),
) -> dict:
    """触发应用封面批量生成(仅 admin,异步任务式,单飞)。

    目标 = cover_url 为空的内置应用 + rh-* 家族缺口(按 base_id 去重,同族共享封面)
    + 可选 expand_top 头部外扩(usage_count 高的共享封面卡拆独立图);
    见 services/app_covers.plan_cover_targets / plan_expand_top_targets。
    执行链 txt2img 提交 → 轮询 → 下载落本地 → 回写 cover_url,分批限速。
    execute=false 干跑只回清单。缺口优先于外扩,再按 limit 截断。
    """
    gap_targets = covers_svc.plan_cover_targets(session)
    expand_targets = (
        covers_svc.plan_expand_top_targets(session, body.expand_top)
        if body.expand_top > 0
        else []
    )
    targets = gap_targets + expand_targets
    planned = targets[: body.limit]
    payload = {
        "total_pending": len(targets),
        "gap_pending": len(gap_targets),
        "expand_pending": len(expand_targets),
        "planned": len(planned),
        "items": [t.to_dict() for t in planned],
    }
    if not body.execute or not planned:
        return {"started": False, **payload}
    if covers_svc.spawn_generation(pool, planned, batch_size=body.batch_size) is None:
        raise HTTPException(status_code=409, detail="封面生成任务已在运行中")
    audit.record(
        session, user=admin, action="app.covers_generate", target_type="app",
        target_id="", summary=f"触发应用封面批量生成:{len(planned)} 个目标",
        detail={
            "limit": body.limit,
            "batch_size": body.batch_size,
            "expand_top": body.expand_top,
            "gap_pending": len(gap_targets),
            "expand_pending": len(expand_targets),
        },
    )
    session.commit()
    return {"started": True, **payload}


@router.get("/covers/generate/status")
def app_covers_generate_status(
    admin: User = Depends(get_current_admin),
) -> dict:
    """最近一次封面生成批次状态(运行中/汇总);从未运行返回 never_run。"""
    return covers_svc.last_generation_summary() or {"running": False, "never_run": True}
