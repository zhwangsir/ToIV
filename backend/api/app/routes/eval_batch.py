"""B 评测管线端点 —— best-of-n 提交 / 批次列表 / 批次排名。

POST /api/eval/best-of-n/h3  同 prompt/参数提交 n 个 H3 t2v 变体(seed 递增),
                              落批次分组;生成走既有 submit 路径(预检/hold 排队不绕过),
                              全部终态后自动评分 + 择优(winner)。
GET  /api/eval/batches       我的批次列表(新→旧)
GET  /api/eval/batches/{id}  批次详情 + 逐变体排名(他人批次 404)
POST /api/eval/dataset/export  偏好数据集手动导出(E 数据飞轮):batch_id 指定单批,
                              缺省导出所有 done 且未处理批次(幂等,不重复写)
GET  /api/eval/dataset/stats   偏好数据集累计(已处理批次/偏好对数/文件清单)
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException
from pydantic import Field
from sqlmodel import Session

from app.db import get_session
from app.deps import get_current_user
from app.models import User
from app.ratelimit import enforce_generation_rate_limit
from app.routes.h3_studio import H3T2VRequest
from app.services import bestof, pref_dataset

router = APIRouter()


class H3BestOfNRequest(H3T2VRequest):
    """best-of-n 请求:H3 t2v 参数 + 变体数 n + 评分器选择。"""

    n: int = Field(default=4, ge=2, le=8)
    scorer: str = Field(default="auto", pattern="^(auto|heuristic|vlm)$")


@router.post("/eval/best-of-n/h3")
async def submit_h3_best_of_n_endpoint(
    req: H3BestOfNRequest,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    enforce_generation_rate_limit(user)
    return await bestof.submit_h3_best_of_n(
        req, n=req.n, scorer=req.scorer, user=user, session=session
    )


@router.get("/eval/batches")
async def list_eval_batches(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
    limit: int = 50,
):
    return {"batches": bestof.list_batches(session, user, limit=min(limit, 200))}


@router.get("/eval/batches/{batch_id}")
async def get_eval_batch(
    batch_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    view = bestof.get_batch_view(session, batch_id, user)
    if view is None:
        raise HTTPException(status_code=404, detail="批次不存在")
    return view


@router.post("/eval/dataset/export")
async def export_preference_dataset(
    batch_id: str | None = None,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    """手动导出偏好数据集。batch_id 缺省 = 全量补导(done 且未处理的批次)。"""
    if batch_id is not None:
        return pref_dataset.export_batch(session, batch_id)
    return pref_dataset.export_pending(session)


@router.get("/eval/dataset/stats")
async def preference_dataset_stats(user: User = Depends(get_current_user)):
    return pref_dataset.get_stats()
