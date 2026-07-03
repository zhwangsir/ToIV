"""/api/images 的 HTTP Range 返回:视频 <video> 必须拿 206+Accept-Ranges 才能播。

回归:此前代理无视 Range 一律 200 无 Accept-Ranges → 浏览器媒体元素报 error 4
(SRC_NOT_SUPPORTED),作品库所有视频加载失败。现在 range 请求返回 206 切片。
"""
from app.routes.images import _ranged_response

_DATA = bytes(range(256)) * 8  # 2048 字节


def test_no_range_returns_200_with_accept_ranges():
    r = _ranged_response(_DATA, "video/mp4", None)
    assert r.status_code == 200
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.body == _DATA


def test_range_returns_206_sliced():
    r = _ranged_response(_DATA, "video/mp4", "bytes=0-1023")
    assert r.status_code == 206
    assert r.headers["Content-Range"] == f"bytes 0-1023/{len(_DATA)}"
    assert r.headers["Accept-Ranges"] == "bytes"
    assert r.body == _DATA[:1024]


def test_open_ended_range_to_eof():
    r = _ranged_response(_DATA, "video/mp4", "bytes=2000-")
    assert r.status_code == 206
    assert r.body == _DATA[2000:]
    assert r.headers["Content-Range"] == f"bytes 2000-{len(_DATA) - 1}/{len(_DATA)}"


def test_unsatisfiable_range_416():
    r = _ranged_response(_DATA, "video/mp4", "bytes=99999-")
    assert r.status_code == 416
    assert r.headers["Content-Range"] == f"bytes */{len(_DATA)}"


def test_malformed_range_falls_back_to_full():
    r = _ranged_response(_DATA, "video/mp4", "bytes=abc-def")
    assert r.status_code == 206  # 解析失败 → 退化为 0..total-1 的 206
    assert r.body == _DATA
