"""cad_upload 阻塞转换经 asyncio.to_thread 的回归测试(P1-4)。

convert 内部 subprocess.run(dwg2dxf, timeout=180) + DXF 解析,最长可达 3 分钟;
必须在事件循环外的线程执行。mock convert 记录其运行线程,断言非主线程。
"""
import asyncio
import io
import threading

from fastapi import UploadFile

import app.routes.cad as cad


class _Res:
    geometry = {"walls": []}
    width = 100
    height = 80
    n_segments = 3


def test_cad_upload_convert_runs_off_event_loop(monkeypatch):
    threads: list[threading.Thread] = []

    def fake_convert(src, out):
        threads.append(threading.current_thread())
        return _Res()

    monkeypatch.setattr(cad, "convert", fake_convert)
    assert asyncio.iscoroutinefunction(cad.cad_upload)

    upload = UploadFile(file=io.BytesIO(b"fake-dwg-bytes"), filename="x.dwg")
    out = asyncio.run(cad.cad_upload(upload, user=None))
    assert out["control_url"].startswith("/api/cad/file/cad-")
    assert out["n_segments"] == 3
    assert threads, "convert 未被调用"
    assert threads[0] is not threading.main_thread()
