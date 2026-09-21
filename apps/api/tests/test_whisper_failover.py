"""whisper 多址故障转移(2026-09-21 openclaw 集群化)回归测试。

背景:whisper 服务分布在 openclaw01-04 四台(:9310,LAN 契约 OpenAI 兼容),
单机 tailscaled 僵死/掉线不应再拖垮听写链——whisper_url 支持逗号/空格
分隔多址,按序故障转移:连接类错误/5xx 换节点,4xx 与用户中止不转移。
"""
from __future__ import annotations

import asyncio
from pathlib import Path

import httpx
import pytest

from app.config import Settings
from app.routes import dub_text
from app.services import board_film


def _settings(url: str) -> Settings:
    return Settings(whisper_url=url)


def test_endpoint_list_single_multi_space_comma():
    assert _settings("http://a:9310").whisper_endpoint_list == ["http://a:9310"]
    assert _settings("http://a:9310,http://b:9310").whisper_endpoint_list == ["http://a:9310", "http://b:9310"]
    assert _settings("http://a:9310 http://b:9310").whisper_endpoint_list == ["http://a:9310", "http://b:9310"]
    assert _settings(" http://a:9310/ , http://b:9310/ ").whisper_endpoint_list == ["http://a:9310", "http://b:9310"]
    assert _settings("").whisper_endpoint_list == []
    assert _settings("  ").whisper_endpoint_list == []


def test_transcribe_failover_first_ok(monkeypatch, tmp_path):
    calls: list[str] = []

    async def fake(base, src_path, name, job_id=""):
        calls.append(base)
        return [{"start": 0.0, "end": 1.0, "text": "hi"}]

    monkeypatch.setattr(dub_text, "_transcribe_external", fake)
    segs = asyncio.run(dub_text._transcribe_external_failover(["http://a", "http://b"], tmp_path / "x.wav", "x.wav"))
    assert segs and calls == ["http://a"], "首节点成功不得再试次节点"


def test_transcribe_failover_connect_error_then_ok(monkeypatch, tmp_path):
    calls: list[str] = []

    async def fake(base, src_path, name, job_id=""):
        calls.append(base)
        if "a" in base:
            raise httpx.ConnectError("refused")
        return [{"start": 0.0, "end": 1.0, "text": "hi"}]

    monkeypatch.setattr(dub_text, "_transcribe_external", fake)
    segs = asyncio.run(dub_text._transcribe_external_failover(["http://a", "http://b"], tmp_path / "x.wav", "x.wav"))
    assert segs and calls == ["http://a", "http://b"], "连接错误必须换下一节点"


def _status_exc(code: int) -> httpx.HTTPStatusError:
    req = httpx.Request("POST", "http://x/asr")
    return httpx.HTTPStatusError("err", request=req, response=httpx.Response(code, request=req))


def test_transcribe_failover_4xx_no_failover(monkeypatch, tmp_path):
    calls: list[str] = []

    async def fake(base, src_path, name, job_id=""):
        calls.append(base)
        raise _status_exc(422)

    monkeypatch.setattr(dub_text, "_transcribe_external", fake)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(dub_text._transcribe_external_failover(["http://a", "http://b"], tmp_path / "x.wav", "x.wav"))
    assert calls == ["http://a"], "4xx 属音频/参数本身问题,不得换节点"


def test_transcribe_failover_5xx_then_all_fail_raises_last(monkeypatch, tmp_path):
    async def fake(base, src_path, name, job_id=""):
        raise _status_exc(502)

    monkeypatch.setattr(dub_text, "_transcribe_external", fake)
    with pytest.raises(httpx.HTTPStatusError):
        asyncio.run(dub_text._transcribe_external_failover(["http://a", "http://b"], tmp_path / "x.wav", "x.wav"))


def test_transcribe_failover_cancel_propagates(monkeypatch, tmp_path):
    calls: list[str] = []

    async def fake(base, src_path, name, job_id=""):
        calls.append(base)
        raise asyncio.CancelledError

    monkeypatch.setattr(dub_text, "_transcribe_external", fake)
    with pytest.raises(asyncio.CancelledError):
        asyncio.run(dub_text._transcribe_external_failover(["http://a", "http://b"], tmp_path / "x.wav", "x.wav"))
    assert calls == ["http://a"], "用户中止不得换节点重试"


def test_words_external_first_non_none_wins(monkeypatch, tmp_path):
    calls: list[str] = []

    async def fake_one(base, path):
        calls.append(base)
        return None if "a" in base else [{"start": 0.0, "end": 0.5, "text": "字"}]

    monkeypatch.setattr(board_film, "_words_external_one", fake_one)
    monkeypatch.setattr(board_film, "get_settings", lambda: _settings("http://a,http://b,http://c"))
    out = asyncio.run(board_film._words_external(Path("x.wav")))
    assert out and calls == ["http://a", "http://b"], "首成功节点返回,不再试后续节点"


def test_words_external_all_fail_returns_none(monkeypatch, tmp_path):
    async def fake_one(base, path):
        return None

    monkeypatch.setattr(board_film, "_words_external_one", fake_one)
    monkeypatch.setattr(board_film, "get_settings", lambda: _settings("http://a,http://b"))
    assert asyncio.run(board_film._words_external(Path("x.wav"))) is None


def test_words_external_empty_endpoints_returns_none(monkeypatch, tmp_path):
    monkeypatch.setattr(board_film, "get_settings", lambda: _settings(""))
    assert asyncio.run(board_film._words_external(Path("x.wav"))) is None
