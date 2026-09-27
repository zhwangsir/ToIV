"""SSE 响应带 Cache-Control: no-transform(2026-09-28):防 Next 代理 gzip 攒流。"""
from fastapi.testclient import TestClient
from sse_starlette.sse import EventSourceResponse

from app.main import app


@app.get("/__test_sse_nt")
async def _sse_probe():
    async def gen():
        yield {"event": "msg", "data": "{}"}
    return EventSourceResponse(gen())


def test_sse_response_has_no_transform():
    with TestClient(app) as c:
        r = c.get("/__test_sse_nt")
    assert r.headers["content-type"].startswith("text/event-stream")
    assert "no-transform" in r.headers["cache-control"]


def test_json_response_untouched():
    with TestClient(app) as c:
        r = c.get("/api/health")
    assert "no-transform" not in (r.headers.get("cache-control") or "")
