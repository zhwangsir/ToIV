"""公共 Job 持久化工具:把内存 Job 终态写回 DB Job。

复用模式(已在 dub lipsync-long 验证):
1. 端点开头建 DB Job(prompt_id=job_id, kind="xxx", params=请求快照, result=初始内存 job dict)
2. 后台任务用 try/finally 包装,finally 调 persist_job_to_db 写终态
3. 状态查询:DB 优先 → 运行中且内存还在用内存 → 否则回放 DB result → 内存 fallback → 404

why:内存 Job 在 api 重启后丢失,DB Job 保终态供前端恢复查询。后台任务脱离请求
session 生命周期,用独立 Session(engine);写失败仅记日志不抛异常——内存 Job 已是
终态,下次查状态仍能从内存返回(只是重启后丢)。
"""
from __future__ import annotations

import json
import logging
from typing import Any

from sqlmodel import Session, select

from app.db import engine
from app.models import Job

logger = logging.getLogger(__name__)


def persist_job_to_db(
    prompt_id: str,
    kind: str,
    status: str,
    result: dict[str, Any],
    params: dict[str, Any] | None = None,
) -> None:
    """把内存 Job 终态写回 DB Job(后台任务用独立 session)。

    prompt_id: 内存 Job 的 id(建 DB Job 时用作 prompt_id,作主键查找)。
    kind:      作业类型(仅用于日志,定位来源;查找只靠 prompt_id)。
    status:    终态("done" / "error")。
    result:    全量内存 Job dict 快照(状态查询端点回放用)。
    params:    可选,运行中若参数变更才传(通常 None——建 DB 时已写 params 快照)。
    """
    try:
        with Session(engine) as s:
            db_job = s.exec(select(Job).where(Job.prompt_id == prompt_id)).first()
            if not db_job:
                return  # 迁移前老作业无 DB 记录,跳过
            db_job.status = status
            db_job.result = json.dumps(result, ensure_ascii=False)
            if params is not None:
                db_job.params = json.dumps(params, ensure_ascii=False)
            s.add(db_job)
            s.commit()
    except Exception as e:  # noqa: BLE001 — DB 写失败不毁内存终态
        logger.warning("%s DB 持久化失败:%s", kind, e)
