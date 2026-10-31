"""/api/docs —— 用户文件上传与管理(供智能体对话挂载做长文本/全格式理解)。

- POST /docs/upload:multipart 单文件 ≤50MB,全格式(office/pdf/文本/代码/csv/json/图片);
  按扩展名路由解析(图片走 VLM 反推描述)→ 切块 → embedding 索引,详见 services/docs.py。
- GET  /docs:当前用户文档列表(新→旧)。
- DELETE /docs/{id}:删除元数据 + 落盘的原文/索引文件。
原文与向量索引按用户隔离落盘(content_dir/docs/<user_id>/),见 services/docs.py。
"""
from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, UploadFile
from sqlmodel import Session, select

from app.db import get_session
from app.deps import get_current_user
from app.models import Document, User
from app.services import docs as docsvc

logger = logging.getLogger(__name__)

router = APIRouter()


def _doc_dict(d: Document) -> dict:
    return {
        "id": d.id,
        "filename": d.filename,
        "kind": d.kind,
        "size": d.size,
        "chunk_count": d.chunk_count,
        "status": d.status,
        "created_at": d.created_at.isoformat(),
    }


@router.post("/docs/upload", status_code=201)
async def upload_doc(
    file: UploadFile,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    filename = (file.filename or "").strip() or "document"
    kind = docsvc.kind_from_filename(filename)
    if kind is None:
        raise HTTPException(
            400,
            "不支持的文件格式(支持 pdf / docx / xlsx / pptx / txt / md / csv / json /"
            " 常见代码文件 / jpg / png / webp / gif / bmp / tiff)",
        )
    raw = await file.read(docsvc.MAX_FILE_BYTES + 1)
    if len(raw) > docsvc.MAX_FILE_BYTES:
        raise HTTPException(413, "文件超过 50MB 上限")

    # 统一解析入口:图片走 VLM 反推(网络),其余本地解析(内部 to_thread 不阻塞事件循环)
    try:
        text = await docsvc.parse_document(kind, raw, filename)
    except HTTPException:
        raise  # VLM 反推失败(502)等原码上抛,不包装成 422
    except Exception as exc:
        logger.warning("文档解析失败 %s: %s", filename, exc)
        raise HTTPException(422, "文件解析失败,请确认文件未损坏") from exc
    if not text.strip():
        raise HTTPException(422, "未能从文件中提取到文本内容")

    chunks, truncated = docsvc.split_chunks(text)
    doc = Document(
        tenant_id=user.tenant_id,
        user_id=user.id,
        filename=filename,
        kind=kind,
        size=len(raw),
        chunk_count=len(chunks),
        status="partial" if truncated else "ready",
    )
    session.add(doc)
    session.commit()
    session.refresh(doc)

    docsvc.save_raw(user.id, doc.id, kind, raw)
    if not await docsvc.build_index(user.id, doc.id, chunks):
        # embedding 不可用:文档保留,检索降级为空,状态显式标注
        doc.status = "no_embed"
        session.add(doc)
        session.commit()
    return _doc_dict(doc)


@router.get("/docs")
def list_docs(
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    rows = session.exec(
        select(Document)
        .where(Document.user_id == user.id)
        .order_by(Document.created_at.desc())  # type: ignore[attr-defined]
    ).all()
    return [_doc_dict(d) for d in rows]


@router.delete("/docs/{doc_id}")
def delete_doc(
    doc_id: str,
    user: User = Depends(get_current_user),
    session: Session = Depends(get_session),
):
    doc = session.get(Document, doc_id)
    if doc is None or doc.user_id != user.id:
        raise HTTPException(404, "文档不存在")
    docsvc.delete_files(doc.user_id, doc.id, doc.kind)
    session.delete(doc)
    session.commit()
    return {"ok": True}
