"""GPU 生成链路每日冒烟测试 —— 小尺寸 txt2img + LTX 短视频。

目标:覆盖当前测试缺口(GPU 真实出图/出视频链路),每日自动执行、结果自动校验、
异常自动报警,确保 GPU 生成功能每日可用。

设计:
- 走 ComfyUI-LB(8188)提交真实工作流,复用生产构造器(build_txt2img_graph /
  build_ltx_t2v_graph),冒烟路径与线上出图路径同码同源。
- txt2img_small: SD1.5 底模 512×512 / 8 steps,秒级完成,验证图像链路。
- ltx_t2v_short:  LTX2.3 文生视频 33 帧(~2s)/ 8 steps,关 upscale/RIFE,验证视频链路。
- 校验: history 产物非空 + 首个产物字节数 > 0(防 0 字节假成功)。
- 报告: {content_dir}/smoke/gpu_smoke_latest.json + gpu_smoke_history.jsonl 逐行追加。
- 报警: overall 失败时 POST 完整报告到 TOIV_SMOKE_ALERT_WEBHOOK(空则只记日志)。
- 调度: API lifespan 内 daily_smoke_loop 每日定点执行(默认 04:00),管理员也可
  POST /api/system/gpu-smoke 手动触发。

CLI: python -m app.services.gpu_smoke  (手动跑一次,退出码 0=通过 1=失败)
"""
from __future__ import annotations

import asyncio
import json
import logging
import time
import uuid
from collections.abc import Awaitable, Callable
from dataclasses import asdict, dataclass, field
from pathlib import Path

from app.comfy.client import ComfyUIClient
from app.workflows.ltx_video import LtxT2VParams, build_ltx_t2v_graph
from app.workflows.txt2img import Txt2ImgParams, build_txt2img_graph

log = logging.getLogger("toiv.gpu_smoke")

# txt2img 冒烟用 SD1.5 底模:512×512 / 8 steps 秒级出图,不挤占生产算力
_TXT2IMG_CKPT = "majicMIX realistic 麦橘写实_v7.safetensors"
_TXT2IMG_STEPS = 8
# LTX 冒烟:33 帧(~2s@16fps)/ 8 steps,关 upscale/RIFE 保链路最短
_LTX_FRAMES = 33
_LTX_STEPS = 8

DEFAULT_TXT2IMG_TIMEOUT = 300.0  # 首次载 ckpt 可能 ~2.5min
DEFAULT_VIDEO_TIMEOUT = 900.0  # LTX 载 Gemma 12B + 采样,留足余量


@dataclass
class SmokeCaseResult:
    name: str
    ok: bool
    duration_ms: int = 0
    prompt_id: str = ""
    files: list[dict] = field(default_factory=list)
    error: str | None = None


@dataclass
class SmokeReport:
    ts: float
    ok: bool
    cases: list[SmokeCaseResult]
    duration_ms: int

    def to_dict(self) -> dict:
        return {
            "ts": self.ts,
            "ok": self.ok,
            "duration_ms": self.duration_ms,
            "cases": [asdict(c) for c in self.cases],
        }


async def _wait_files(
    client: ComfyUIClient, prompt_id: str, timeout_s: float, poll_s: float
) -> list[dict]:
    """轮询 history 直到产物就绪或超时。超时抛 TimeoutError。"""
    deadline = time.monotonic() + timeout_s
    while time.monotonic() < deadline:
        files = await client.get_result_files(prompt_id)
        if files:
            return files
        await asyncio.sleep(poll_s)
    raise TimeoutError(f"超时 {timeout_s:.0f}s 无产物")


async def _run_case(
    name: str,
    graph: dict,
    client: ComfyUIClient,
    timeout_s: float,
    poll_s: float,
) -> SmokeCaseResult:
    """提交单个冒烟工作流并校验产物。任何失败收敛为 case.error,不外抛。"""
    start = time.monotonic()
    result = SmokeCaseResult(name=name, ok=False)
    try:
        prompt_id = await client.queue_prompt(graph, client_id=f"smoke-{uuid.uuid4().hex[:8]}")
        result.prompt_id = prompt_id
        files = await _wait_files(client, prompt_id, timeout_s, poll_s)
        # 字节级校验:首个产物必须可读且非空(防 0 字节假成功)
        first = files[0]
        content, _ = await client.get_image_bytes(
            first["filename"], first.get("subfolder", ""), first.get("type", "output")
        )
        if not content:
            raise RuntimeError(f"产物 {first['filename']} 字节为空(0 字节假成功)")
        result.files = files
        result.ok = True
    except TimeoutError as e:
        result.error = str(e)
    except Exception as e:  # ComfyUIError / 网络错误等统一收敛
        result.error = str(e)[:300]
    result.duration_ms = int((time.monotonic() - start) * 1000)
    return result


def _txt2img_graph() -> dict:
    return build_txt2img_graph(
        Txt2ImgParams(
            positive="a red apple on a wooden table, studio light",
            negative="blurry, low quality",
            ckpt_name=_TXT2IMG_CKPT,
            width=512,
            height=512,
            steps=_TXT2IMG_STEPS,
            filename_prefix="ToIV_smoke",
        )
    )


def _ltx_graph() -> dict:
    return build_ltx_t2v_graph(
        LtxT2VParams(
            positive="gentle waves on a calm beach at dawn",
            negative="worst quality, inconsistent motion",
            width=768,
            height=384,
            length=_LTX_FRAMES,
            steps=_LTX_STEPS,
            use_upscale=False,
            use_rife=False,
            filename_prefix="ToIV_smoke",
        )
    )


def _persist(report: SmokeReport, report_dir: Path) -> None:
    report_dir.mkdir(parents=True, exist_ok=True)
    payload = report.to_dict()
    (report_dir / "gpu_smoke_latest.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=2)
    )
    with (report_dir / "gpu_smoke_history.jsonl").open("a") as f:
        f.write(json.dumps(payload, ensure_ascii=False) + "\n")


async def _default_webhook(url: str, payload: dict) -> None:
    import httpx

    async with httpx.AsyncClient(timeout=10.0, trust_env=False) as client:
        await client.post(url, json=payload)


WebhookSender = Callable[[str, dict], Awaitable[None]]


async def run_gpu_smoke(
    client: ComfyUIClient,
    *,
    report_dir: Path,
    webhook_url: str = "",
    webhook_sender: WebhookSender | None = None,
    poll_interval_s: float = 3.0,
    txt2img_timeout_s: float = DEFAULT_TXT2IMG_TIMEOUT,
    video_timeout_s: float = DEFAULT_VIDEO_TIMEOUT,
) -> SmokeReport:
    """执行一次完整冒烟:txt2img + LTX 视频,校验、落盘、失败报警。"""
    start = time.monotonic()
    # 两路串行:避免与生产任务抢显存(冒烟求稳不求快)
    cases = [
        await _run_case("txt2img_small", _txt2img_graph(), client, txt2img_timeout_s, poll_interval_s),
        await _run_case("ltx_t2v_short", _ltx_graph(), client, video_timeout_s, poll_interval_s),
    ]
    report = SmokeReport(
        ts=time.time(),
        ok=all(c.ok for c in cases),
        cases=cases,
        duration_ms=int((time.monotonic() - start) * 1000),
    )
    _persist(report, report_dir)

    if report.ok:
        log.info("GPU 冒烟通过 (%dms)", report.duration_ms)
    else:
        failed = [c.name for c in cases if not c.ok]
        log.error("GPU 冒烟失败: %s", ", ".join(failed))
        if webhook_url:
            try:
                sender = webhook_sender or _default_webhook
                await sender(webhook_url, report.to_dict())
            except Exception:
                log.exception("冒烟报警 webhook 发送失败(不影响报告落盘)")
    return report


# ─────────────────────────────────────────────────────────────────────────────
# 每日调度
# ─────────────────────────────────────────────────────────────────────────────


def lb_client() -> ComfyUIClient:
    """ComfyUI-LB 入口(5 后端负载均衡)。冒烟走 LB 与生产同路径。"""
    return ComfyUIClient("http://192.168.71.127:8188", timeout=60.0)


async def daily_smoke_loop(
    *,
    hour: int,
    report_dir: Path,
    webhook_url: str = "",
    client_factory: Callable[[], ComfyUIClient] = lb_client,
) -> None:
    """每日定点冒烟循环。到点执行一次,异常吞掉记日志(调度器永不退出)。"""
    while True:
        now = time.localtime()
        # 距下一个定点小时的秒数
        target = time.mktime(
            (now.tm_year, now.tm_mon, now.tm_mday, hour, 0, 0, 0, 0, -1)
        )
        delay = target - time.time()
        if delay <= 0:
            delay += 86400
        await asyncio.sleep(delay)
        try:
            await run_gpu_smoke(client_factory(), report_dir=report_dir, webhook_url=webhook_url)
        except Exception:
            log.exception("每日 GPU 冒烟执行异常")


def smoke_report_dir() -> Path:
    from app.config import get_settings

    return Path(get_settings().content_dir) / "smoke"


async def main() -> int:
    """CLI:手动跑一次冒烟。退出码 0=通过,1=失败。"""
    from app.config import get_settings

    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    settings = get_settings()
    report = await run_gpu_smoke(
        lb_client(),
        report_dir=smoke_report_dir(),
        webhook_url=settings.smoke_alert_webhook,
    )
    print(json.dumps(report.to_dict(), ensure_ascii=False, indent=2))
    return 0 if report.ok else 1


if __name__ == "__main__":
    raise SystemExit(asyncio.run(main()))
