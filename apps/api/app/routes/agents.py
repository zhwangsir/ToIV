"""智能体 CRUD —— 提示词优化系统的人格预设管理。

- GET /api/agents?kind=image:列表,按 applies_to 过滤(含 'all' 也返回),
  NSFW 智能体仅 R18 鉴权用户可见(/nsfw 专页带 X-NSFW header),按 sort 排序。
- GET /api/agents/{id}:详情;NSFW 智能体需 R18。
- POST /api/agents:创建自定义(is_builtin=False),需 admin。
- PUT /api/agents/{id}:改;内置的 is_builtin 不变;system_prompt 可改;需 admin。
- DELETE /api/agents/{id}:删;内置(is_builtin=True)返 403;需 admin。

NSFW 可见性复用 nsfw_ctx.nsfw_allowed()(按请求级 X-NSFW header,非账户开关)。
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_admin, get_current_user
from app.models import Agent, User, _now
from app.nsfw_ctx import nsfw_allowed

router = APIRouter()


# ---------------------------------------------------------------------------
# 响应 / 请求模型
# ---------------------------------------------------------------------------
class AgentOut(BaseModel):
    id: str
    name: str
    description: str
    icon: str
    applies_to: list[str]  # 序列化时拆分逗号串
    system_prompt: str
    is_nsfw: bool
    is_builtin: bool
    llm_model_override: str | None
    sort: int


class AgentCreate(BaseModel):
    id: str = Field(min_length=1, max_length=64)
    name: str = Field(min_length=1, max_length=120)
    description: str = Field(default="", max_length=500)
    icon: str = Field(default="sparkles", max_length=64)
    applies_to: str = Field(default="all", max_length=120)
    system_prompt: str = Field(min_length=1, max_length=20000)
    is_nsfw: bool = False
    llm_model_override: str | None = Field(default=None, max_length=120)
    sort: int = Field(default=100, ge=0, le=10000)


class AgentPatch(BaseModel):
    name: str | None = Field(default=None, min_length=1, max_length=120)
    description: str | None = Field(default=None, max_length=500)
    icon: str | None = Field(default=None, max_length=64)
    applies_to: str | None = Field(default=None, max_length=120)
    system_prompt: str | None = Field(default=None, min_length=1, max_length=20000)
    is_nsfw: bool | None = None
    llm_model_override: str | None = Field(default=None, max_length=120)
    sort: int | None = Field(default=None, ge=0, le=10000)


# ---------------------------------------------------------------------------
# 辅助
# ---------------------------------------------------------------------------
def _applies_list(applies_to: str) -> list[str]:
    """逗号串 → list(去空白、保序、去空)。"""
    return [s.strip() for s in (applies_to or "").split(",") if s.strip()]


def _to_out(a: Agent) -> AgentOut:
    return AgentOut(
        id=a.id,
        name=a.name,
        description=a.description,
        icon=a.icon,
        applies_to=_applies_list(a.applies_to),
        system_prompt=a.system_prompt,
        is_nsfw=a.is_nsfw,
        is_builtin=a.is_builtin,
        llm_model_override=a.llm_model_override,
        sort=a.sort,
    )


# ---------------------------------------------------------------------------
# 路由
# ---------------------------------------------------------------------------
@router.get("/agents", response_model=list[AgentOut])
def list_agents(
    kind: str | None = Query(default=None, description="按 applies_to 过滤;含 'all' 的也返回"),
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> list[AgentOut]:
    """列表:按 applies_to 过滤(含 'all' 也返回),NSFW 仅 R18 可见,按 sort 排序。"""
    allow_nsfw = nsfw_allowed(user)
    rows = session.exec(select(Agent).order_by(Agent.sort, Agent.name)).all()
    out: list[AgentOut] = []
    for a in rows:
        # NSFW 智能体对未授权用户不可见(不泄露存在性,直接跳过)
        if a.is_nsfw and not allow_nsfw:
            continue
        if kind is not None:
            applies = _applies_list(a.applies_to)
            if kind not in applies and "all" not in applies:
                continue
        out.append(_to_out(a))
    return out


@router.get("/agents/{aid}", response_model=AgentOut)
def get_agent(
    aid: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
) -> AgentOut:
    """详情;NSFW 智能体需 R18 鉴权(否则 404 不泄露存在性)。"""
    a = session.get(Agent, aid)
    if not a:
        raise HTTPException(status_code=404, detail="智能体不存在")
    if a.is_nsfw and not nsfw_allowed(user):
        # 与列表一致:对未授权用户不泄露 NSFW 智能体存在性
        raise HTTPException(status_code=404, detail="智能体不存在")
    return _to_out(a)


@router.post("/agents", response_model=AgentOut)
def create_agent(
    body: AgentCreate,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> AgentOut:
    """创建自定义智能体(is_builtin=False)。需 admin。"""
    if session.get(Agent, body.id):
        raise HTTPException(status_code=409, detail="智能体 id 已存在")
    a = Agent(
        id=body.id,
        name=body.name,
        description=body.description,
        icon=body.icon,
        applies_to=body.applies_to,
        system_prompt=body.system_prompt,
        is_nsfw=body.is_nsfw,
        is_builtin=False,  # API 创建的永远是自定义
        llm_model_override=body.llm_model_override,
        sort=body.sort,
    )
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a)


@router.put("/agents/{aid}", response_model=AgentOut)
def update_agent(
    aid: str,
    body: AgentPatch,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> AgentOut:
    """改智能体;内置的 is_builtin 不变(永远 True);system_prompt 可改。需 admin。"""
    a = session.get(Agent, aid)
    if not a:
        raise HTTPException(status_code=404, detail="智能体不存在")
    for field in (
        "name",
        "description",
        "icon",
        "applies_to",
        "system_prompt",
        "is_nsfw",
        "llm_model_override",
        "sort",
    ):
        val = getattr(body, field)
        if val is not None:
            setattr(a, field, val)
    # is_builtin 不接受外部修改:内置永为内置,自定义永为自定义
    a.updated_at = _now()
    session.add(a)
    session.commit()
    session.refresh(a)
    return _to_out(a)


@router.delete("/agents/{aid}")
def delete_agent(
    aid: str,
    admin: User = Depends(get_current_admin),
    session: Session = Depends(get_session),
) -> dict:
    """删智能体;内置(is_builtin=True)拒删返 403。需 admin。"""
    a = session.get(Agent, aid)
    if not a:
        raise HTTPException(status_code=404, detail="智能体不存在")
    if a.is_builtin:
        raise HTTPException(status_code=403, detail="内置智能体不可删除")
    session.delete(a)
    session.commit()
    return {"ok": True, "id": aid}
