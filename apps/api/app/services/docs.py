"""用户文档:解析(pdf/docx/txt/md)→ 切块 → embedding 索引 → 余弦检索。

- 原文与索引(chunk+归一化向量 JSON)落盘 content_dir/docs/<user_id>/,不入库、不入 git。
- embedding 复用 agent.rag._embed(OpenAI 兼容端点,生产 Qwen3-Embedding-4B);
  不可用时文档仍保存,状态标注 no_embed,检索降级为空(与知识库 RAG 同一套优雅降级)。
- 长文档保护:chunk 上限 MAX_CHUNKS,超限截断并标注 status=partial,
  防止 500 页 PDF 的块数量爆炸拖垮 embedding。
"""
from __future__ import annotations

import io
import json
import logging
import re
from dataclasses import dataclass
from pathlib import Path

from app.agent import rag
from app.models import Document
from app.storage import content_subdir

logger = logging.getLogger(__name__)

MAX_FILE_BYTES = 50 * 1024 * 1024  # 单文件 ≤50MB
MAX_CHUNKS = 512  # 单文档 chunk 上限(防长文档块爆炸)
CHUNK_CHARS = 900  # 单块目标长度(字符)
CHUNK_OVERLAP = 120  # 超长段落硬切时的重叠

_KINDS = {"pdf", "docx", "txt", "md"}


def kind_from_filename(filename: str) -> str | None:
    """按扩展名判定文档类型;不支持返回 None。"""
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    return suffix if suffix in _KINDS else None


def docs_root() -> Path:
    """文档存储根(content_dir/docs;不可写时 content_subdir 已降级临时目录)。"""
    return content_subdir("docs")


def _raw_path(user_id: str, doc_id: str, kind: str) -> Path:
    return docs_root() / user_id / f"{doc_id}.{kind}"


def _index_path(user_id: str, doc_id: str) -> Path:
    return docs_root() / user_id / f"{doc_id}.json"


def parse_text(kind: str, raw: bytes) -> str:
    """从原始字节解析纯文本。pdf/docx 惰性导入,缺依赖只影响对应格式。"""
    if kind in ("txt", "md"):
        return raw.decode("utf-8", errors="replace")
    if kind == "pdf":
        from pypdf import PdfReader

        reader = PdfReader(io.BytesIO(raw))
        return "\n".join((page.extract_text() or "") for page in reader.pages)
    if kind == "docx":
        import docx

        document = docx.Document(io.BytesIO(raw))
        return "\n".join(p.text for p in document.paragraphs)
    raise ValueError(f"unsupported kind: {kind}")


def split_chunks(text: str) -> tuple[list[str], bool]:
    """按段落聚合切块(≤CHUNK_CHARS),超长段落带重叠硬切。

    返回 (chunks, truncated):truncated=True 表示原文块数超 MAX_CHUNKS 被截断。
    """
    paras = [p.strip() for p in re.split(r"\n+", text) if p.strip()]
    chunks: list[str] = []
    buf = ""

    def flush() -> None:
        nonlocal buf
        if buf.strip():
            chunks.append(buf.strip())
        buf = ""

    for para in paras:
        while len(para) > CHUNK_CHARS:  # 超长段落(如无换行的 OCR 文本)硬切
            flush()
            chunks.append(para[:CHUNK_CHARS])
            para = para[CHUNK_CHARS - CHUNK_OVERLAP :]
        if buf and len(buf) + len(para) + 1 > CHUNK_CHARS:
            flush()
        buf = f"{buf}\n{para}" if buf else para
    flush()
    truncated = len(chunks) > MAX_CHUNKS
    return chunks[:MAX_CHUNKS], truncated


def save_raw(user_id: str, doc_id: str, kind: str, raw: bytes) -> None:
    """原文落盘(按用户分目录)。"""
    path = _raw_path(user_id, doc_id, kind)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(raw)


async def build_index(user_id: str, doc_id: str, chunks: list[str]) -> bool:
    """embedding 全部 chunk 并落盘 JSON 索引;embedding 不可用返回 False(不写索引)。"""
    vectors = await rag._embed(chunks)
    if vectors is None or len(vectors) != len(chunks):
        return False
    data = {
        "chunks": chunks,
        "vectors": [rag._normalize(v) for v in vectors],
    }
    path = _index_path(user_id, doc_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data), encoding="utf-8")
    return True


def delete_files(user_id: str, doc_id: str, kind: str) -> None:
    """删除原文与索引文件(不存在静默跳过)。"""
    for path in (_raw_path(user_id, doc_id, kind), _index_path(user_id, doc_id)):
        try:
            path.unlink(missing_ok=True)
        except OSError:
            logger.warning("删除文档文件失败: %s", path)


@dataclass(frozen=True)
class DocHit:
    filename: str
    text: str
    score: float


async def retrieve(
    docs: list[Document], query: str, k: int = 6, min_score: float = 0.25
) -> list[DocHit]:
    """对挂载文档做多文档余弦 top-k;无索引/embedding 不可用返回空(降级)。"""
    indexed = [d for d in docs if _index_path(d.user_id, d.id).is_file()]
    if not indexed or not query.strip():
        return []
    qe = await rag._embed([query])
    if not qe:
        return []
    q = rag._normalize(qe[0])
    hits: list[DocHit] = []
    for d in indexed:
        try:
            data = json.loads(_index_path(d.user_id, d.id).read_text(encoding="utf-8"))
        except (OSError, ValueError):
            continue
        chunks = data.get("chunks") or []
        vectors = data.get("vectors") or []
        for vec, text in zip(vectors, chunks):
            score = sum(a * b for a, b in zip(q, vec))
            if score >= min_score:
                hits.append(DocHit(filename=d.filename, text=text, score=score))
    hits.sort(key=lambda h: h.score, reverse=True)
    return hits[:k]
