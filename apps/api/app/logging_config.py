"""统一日志配置 —— 生产 journald 采集的前提。

背景(2026-08-12 真机核查):root logger 此前无任何配置,35 个模块的
``getLogger(__name__)`` INFO 日志被 lastResort(WARNING 级)静默丢弃,
ERROR/WARNING 以裸消息落 journal(无模块名/级别前缀,无法按模块过滤)。
真机证据:journalctl -u toiv-api 近 1000 行里 978 条全是 uvicorn.access
访问行,应用模块 INFO 一条不剩。

``setup_logging()`` 在 create_app 时调用:
- root 级别 INFO(TOIV_LOG_LEVEL 可调),StreamHandler 写 stdout → systemd journal;
- 统一格式带 asctime/level/name,journal 里可直接 grep 模块名(如 [app.comfy.tracker]);
- httpx/httpcore/websockets 降噪到 WARNING(轮询 worker 每 1.5s 一条请求行,
  生产无监控价值,连接异常仍可见);
- 幂等:重复调用不叠加 handler(pytest 多次 create_app / 热重载安全)。

uvicorn 自带日志(uvicorn/uvicorn.access,propagate=False)不受影响,访问行原样保留。
"""
from __future__ import annotations

import logging
import sys

_FORMAT = "%(asctime)s %(levelname)s [%(name)s] %(message)s"
# 第三方降噪名单:这些库在 INFO 级会高频输出(worker 轮询/WS 连接事件),
# 异常仍经 WARNING+ 落 journal。
_QUIET_LOGGERS = ("httpx", "httpcore", "websockets")


def setup_logging(level: str = "INFO") -> None:
    """配置 root logger;幂等(重复调用仅更新级别,不叠加 handler)。"""
    root = logging.getLogger()
    root.setLevel(level.upper())
    if not any(getattr(h, "_toiv_handler", False) for h in root.handlers):
        handler = logging.StreamHandler(sys.stdout)
        handler.setFormatter(logging.Formatter(_FORMAT))
        handler._toiv_handler = True  # type: ignore[attr-defined]
        root.addHandler(handler)
    for name in _QUIET_LOGGERS:
        logging.getLogger(name).setLevel(logging.WARNING)
