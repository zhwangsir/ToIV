"""RAG embedding 缓存目录测试(P3):/data 不可写时落系统临时目录,永不写源码树。

修复前兜底路径是 agent/knowledge/(源码目录),rag_cache_*.json 会污染仓库。
"""
from __future__ import annotations

from pathlib import Path

from app.agent import rag


def test_cache_path_prefers_data(monkeypatch):
    """/data 存在且可写 → 缓存落 /data。"""
    monkeypatch.setattr(rag.os.path, "isdir", lambda p: True)
    monkeypatch.setattr(rag.os, "access", lambda p, mode: True)
    p = rag._cache_path("abc123")
    assert p == Path("/data") / "rag_cache_abc123.json"


def test_cache_path_falls_back_to_tempdir(monkeypatch, tmp_path):
    """/data 不可用 → 系统临时目录下 toiv_rag_cache/,且目录被创建。"""
    monkeypatch.setattr(rag.os.path, "isdir", lambda p: False)
    monkeypatch.setattr(rag.tempfile, "gettempdir", lambda: str(tmp_path))
    p = rag._cache_path("abc123")
    assert p == tmp_path / "toiv_rag_cache" / "rag_cache_abc123.json"
    assert p.parent.is_dir()  # 写入前目录已就绪


def test_cache_never_in_source_tree(monkeypatch, tmp_path):
    """任何情况下缓存路径都不在 agent/knowledge/(源码树)下。"""
    monkeypatch.setattr(rag.os.path, "isdir", lambda p: False)
    monkeypatch.setattr(rag.tempfile, "gettempdir", lambda: str(tmp_path))
    p = rag._cache_path("abc123")
    assert rag._KNOWLEDGE_DIR not in p.parents
    # 回归守卫:仓库 knowledge 目录不得再有 rag_cache_ 残留
    assert not list(rag._KNOWLEDGE_DIR.glob("rag_cache_*.json"))
