"""向量 RAG:精选知识库 → embedding → 余弦检索。

- embedding 走 OpenAI 兼容端点(LM Studio /v1/embeddings)。
- 纯 Python 余弦(语料仅几十块,无需 numpy);chunk 向量构建时归一化,检索即点积。
- 索引懒构建(首次用到才建),落盘缓存(按 chunk 内容 + 模型 hash),embedding 不可用时检索返回空、智能体照常工作。
"""
from __future__ import annotations

import asyncio
import hashlib
import json
import math
import os
from dataclasses import dataclass
from pathlib import Path

import httpx

from app.config import get_settings

_KNOWLEDGE_DIR = Path(__file__).parent / "knowledge"


@dataclass(frozen=True)
class Chunk:
    title: str
    text: str


def _load_chunks() -> list[Chunk]:
    """读取 knowledge/*.md,按 `## ` 小标题切块。"""
    chunks: list[Chunk] = []
    for md in sorted(_KNOWLEDGE_DIR.glob("*.md")):
        doc = md.read_text(encoding="utf-8")
        section_title = md.stem
        buf: list[str] = []
        cur = section_title

        def flush() -> None:
            body = "\n".join(buf).strip()
            if body:
                chunks.append(Chunk(title=cur, text=f"[{section_title}] {cur}\n{body}"))

        for line in doc.splitlines():
            if line.startswith("## "):
                flush()
                cur = line[3:].strip()
                buf = []
            elif line.startswith("# "):
                continue
            else:
                buf.append(line)
        flush()
    return chunks


async def _embed(texts: list[str]) -> list[list[float]] | None:
    """批量取 embedding;失败返回 None(优雅降级)。"""
    if not texts:
        return []
    settings = get_settings()
    payload = {"model": settings.embed_model, "input": texts}
    headers = {"Authorization": f"Bearer {settings.llm_api_key}"}
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0, connect=8.0)) as client:
            resp = await client.post(
                f"{settings.embed_url}/embeddings", json=payload, headers=headers
            )
            resp.raise_for_status()
            data = resp.json()["data"]
        return [item["embedding"] for item in data]
    except (httpx.HTTPError, KeyError, IndexError, TypeError):
        return None


def _normalize(v: list[float]) -> list[float]:
    n = math.sqrt(sum(x * x for x in v)) or 1.0
    return [x / n for x in v]


def _cache_path(fingerprint: str) -> Path:
    base = Path("/data") if os.path.isdir("/data") and os.access("/data", os.W_OK) else _KNOWLEDGE_DIR
    return base / f"rag_cache_{fingerprint}.json"


class KnowledgeBase:
    def __init__(self) -> None:
        self._chunks: list[Chunk] = []
        self._vectors: list[list[float]] = []  # 已归一化
        self._ready = False
        self._lock = asyncio.Lock()

    async def ensure_ready(self) -> None:
        if self._ready:
            return
        async with self._lock:
            if self._ready:
                return
            chunks = _load_chunks()
            if not chunks:
                self._ready = True
                return
            settings = get_settings()
            fp = hashlib.sha1(
                (settings.embed_model + "|" + "||".join(c.text for c in chunks)).encode("utf-8")
            ).hexdigest()[:16]
            cache = _cache_path(fp)
            if cache.exists():
                try:
                    vecs = json.loads(cache.read_text(encoding="utf-8"))
                    if len(vecs) == len(chunks):
                        self._chunks = chunks
                        self._vectors = vecs
                        self._ready = True
                        return
                except (OSError, ValueError):
                    pass
            embeddings = await _embed([c.text for c in chunks])
            if embeddings is None or len(embeddings) != len(chunks):
                # embedding 不可用:标记 ready 但索引为空 → 检索返回空
                self._ready = True
                return
            self._chunks = chunks
            self._vectors = [_normalize(e) for e in embeddings]
            try:
                cache.write_text(json.dumps(self._vectors), encoding="utf-8")
            except OSError:
                pass
            self._ready = True

    async def retrieve(self, query: str, k: int = 4, min_score: float = 0.25) -> list[Chunk]:
        await self.ensure_ready()
        if not self._vectors:
            return []
        qe = await _embed([query])
        if not qe:
            return []
        q = _normalize(qe[0])
        scored = [
            (sum(a * b for a, b in zip(q, vec)), ch)
            for vec, ch in zip(self._vectors, self._chunks)
        ]
        scored.sort(key=lambda s: s[0], reverse=True)
        return [ch for score, ch in scored[:k] if score >= min_score]


_KB = KnowledgeBase()


def get_kb() -> KnowledgeBase:
    return _KB
