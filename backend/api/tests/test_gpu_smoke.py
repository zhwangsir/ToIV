"""GPU 生成链路每日冒烟测试 —— txt2img 小图 + LTX 短视频。

不连真 ComfyUI:注入假 client 控制 queue_prompt/get_result_files 行为。
异步函数用 asyncio.run() 在同步测试里跑(与 test_tracker.py 同模式)。
"""
import asyncio
import json

import pytest

from app.comfy.client import ComfyUIError
from app.services import gpu_smoke
from app.services.gpu_smoke import run_gpu_smoke


class _FakeClient:
    """按用例分别控制:提交成功/失败、产物就绪/永不就绪。"""

    base_url = "http://lb:8188"

    def __init__(self, *, fail_submit: set[str] | None = None, ready: set[str] | None = None):
        self._fail_submit = fail_submit or set()
        self._ready = ready if ready is not None else {"txt2img_small", "ltx_t2v_short"}
        self.submitted: list[str] = []

    async def queue_prompt(self, graph: dict, client_id: str) -> str:
        # 通过图内容判断用例:LTX 链含 LTXVConditioning
        case = "ltx_t2v_short" if any(
            n.get("class_type") == "LTXVConditioning" for n in graph.values()
        ) else "txt2img_small"
        self.submitted.append(case)
        if case in self._fail_submit:
            raise ComfyUIError(f"{case} 提交被拒")
        return f"pid-{case}"

    async def get_result_files(self, prompt_id: str) -> list[dict]:
        case = prompt_id.removeprefix("pid-")
        if case not in self._ready:
            return []
        ext = "mp4" if case == "ltx_t2v_short" else "png"
        return [{"filename": f"smoke.{ext}", "subfolder": "", "type": "output"}]

    async def get_image_bytes(self, filename: str, subfolder: str, type_: str) -> tuple[bytes, str]:
        return b"\x89PNG fake-bytes", "image/png"


@pytest.fixture
def report_dir(tmp_path):
    return tmp_path / "smoke"


def _run(client, report_dir, **kw):
    return asyncio.run(
        run_gpu_smoke(
            client,
            report_dir=report_dir,
            poll_interval_s=0.01,
            txt2img_timeout_s=2.0,
            video_timeout_s=2.0,
            **kw,
        )
    )


def test_smoke_all_pass(report_dir):
    """双链路就绪 → overall ok,产物经字节级校验,报告落盘,不触发报警。"""
    webhook_calls: list[dict] = []

    async def fake_webhook(url: str, payload: dict) -> None:
        webhook_calls.append(payload)

    report = _run(
        _FakeClient(), report_dir,
        webhook_url="http://hook", webhook_sender=fake_webhook,
    )
    assert report.ok is True
    assert {c.name for c in report.cases} == {"txt2img_small", "ltx_t2v_short"}
    for c in report.cases:
        assert c.ok is True, c.error
        assert c.files, f"{c.name} 应记录产物文件"
        assert c.duration_ms >= 0  # 假 client 瞬时返回可能截断为 0,真机 >0
    # 报告落盘:latest + history
    latest = json.loads((report_dir / "gpu_smoke_latest.json").read_text())
    assert latest["ok"] is True
    history = (report_dir / "gpu_smoke_history.jsonl").read_text().strip().splitlines()
    assert len(history) == 1
    # 全部通过 → 不报警
    assert webhook_calls == []


def test_smoke_txt2img_timeout_fails_and_alerts(report_dir):
    """txt2img 超时无产物 → 该用例失败,overall 失败,触发 webhook 报警。"""
    webhook_calls: list[dict] = []

    async def fake_webhook(url: str, payload: dict) -> None:
        webhook_calls.append(payload)

    client = _FakeClient(ready={"ltx_t2v_short"})  # txt2img 永不就绪
    report = _run(
        client, report_dir,
        webhook_url="http://hook", webhook_sender=fake_webhook,
    )
    assert report.ok is False
    by_name = {c.name: c for c in report.cases}
    assert by_name["txt2img_small"].ok is False
    assert "超时" in by_name["txt2img_small"].error
    assert by_name["ltx_t2v_short"].ok is True
    # 触发报警,负载含失败用例名
    assert len(webhook_calls) == 1
    assert "txt2img_small" in json.dumps(webhook_calls[0], ensure_ascii=False)


def test_smoke_video_submit_rejected(report_dir):
    """LTX 提交被 ComfyUI 拒绝 → 视频用例失败,不阻断 txt2img 用例。"""
    client = _FakeClient(fail_submit={"ltx_t2v_short"})
    report = _run(client, report_dir)
    assert report.ok is False
    by_name = {c.name: c for c in report.cases}
    assert by_name["ltx_t2v_short"].ok is False
    assert "提交被拒" in by_name["ltx_t2v_short"].error
    assert by_name["txt2img_small"].ok is True


def test_smoke_empty_file_bytes_fails(report_dir):
    """产物文件可读但字节为空 → 校验失败(防 0 字节假成功)。"""

    class _EmptyBytes(_FakeClient):
        async def get_image_bytes(self, filename, subfolder, type_):
            return b"", "image/png"

    report = _run(_EmptyBytes(), report_dir)
    assert report.ok is False
    assert any("空" in (c.error or "") or "0" in (c.error or "") for c in report.cases if not c.ok)


def test_history_appends_across_runs(report_dir):
    """多次运行 → history.jsonl 逐行追加,latest 始终为最近一次。"""
    _run(_FakeClient(), report_dir)
    _run(_FakeClient(ready={"txt2img_small"}), report_dir)  # 第二次视频失败
    lines = (report_dir / "gpu_smoke_history.jsonl").read_text().strip().splitlines()
    assert len(lines) == 2
    latest = json.loads((report_dir / "gpu_smoke_latest.json").read_text())
    assert latest["ok"] is False


def test_lb_client_reads_worker_urls_first(monkeypatch):
    """P1-23:lb_client 不再写死 LB :8188,改读 settings.worker_urls[0]。"""
    from types import SimpleNamespace

    monkeypatch.setattr(
        "app.config.get_settings",
        lambda: SimpleNamespace(
            worker_urls=["http://fake-worker-0:8189", "http://fake-worker-1:8188"]
        ),
    )
    client = gpu_smoke.lb_client()
    assert client.base_url == "http://fake-worker-0:8189"
