"""安全加固测试(QA-FULL-2026-08-11 P2)。

覆盖:
  · 安全响应头中间件:六项头在 200/404 响应上均存在;HSTS 仅 https 下发
  · API 文档门控:TOIV_EXPOSE_API_DOCS=false(默认) /docs /redoc /openapi.json 404;
    true 时三者 200
"""
from __future__ import annotations

from fastapi.testclient import TestClient

from app import main
from app.config import Settings


def _build_app(monkeypatch, expose_docs: bool):
    settings = Settings(expose_api_docs=expose_docs)
    monkeypatch.setattr(main, "get_settings", lambda: settings)
    return main.create_app()


def test_security_headers_on_health():
    client = TestClient(main.app)
    r = client.get("/api/health")
    assert r.status_code == 200
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"
    assert r.headers["Referrer-Policy"] == "no-referrer"
    assert "camera=()" in r.headers["Permissions-Policy"]
    assert "microphone=()" in r.headers["Permissions-Policy"]
    assert "default-src 'none'" in r.headers["Content-Security-Policy"]
    assert "frame-ancestors 'none'" in r.headers["Content-Security-Policy"]
    # 纯 http 请求不下发 HSTS(避免污染本地开发浏览器缓存)
    assert "Strict-Transport-Security" not in r.headers


def test_security_headers_on_404():
    """错误响应同样带头(中间件在 call_next 之后统一补)。"""
    client = TestClient(main.app)
    r = client.get("/api/definitely-not-exists")
    assert r.status_code == 404
    assert r.headers["X-Content-Type-Options"] == "nosniff"
    assert r.headers["X-Frame-Options"] == "DENY"


def test_hsts_only_over_https():
    client = TestClient(main.app)
    r = client.get("/api/health", headers={"X-Forwarded-Proto": "https"})
    assert r.headers["Strict-Transport-Security"].startswith("max-age=31536000")


def test_docs_hidden_by_default(monkeypatch):
    client = TestClient(_build_app(monkeypatch, False))
    for path in ("/docs", "/redoc", "/openapi.json"):
        assert client.get(path).status_code == 404, f"{path} 应 404"


def test_docs_exposed_when_enabled(monkeypatch):
    client = TestClient(_build_app(monkeypatch, True))
    assert client.get("/openapi.json").status_code == 200
    assert client.get("/docs").status_code == 200
    assert client.get("/redoc").status_code == 200


def test_cors_exposes_agent_session_header():
    """M19/MP19: X-Agent-Session-Id 须入 expose_headers。

    智能体对话会话 id 走响应头(agent.py EventSourceResponse);浏览器跨域 fetch
    只放行 CORS 安全清单头,不暴露则 H5 端读不到 → 续聊每次新建会话。
    """
    client = TestClient(main.app)
    r = client.get("/api/health", headers={"Origin": "https://toiv.dgmt.top"})
    assert r.headers["Access-Control-Allow-Origin"] == "https://toiv.dgmt.top"
    assert "X-Agent-Session-Id" in r.headers["Access-Control-Expose-Headers"]
