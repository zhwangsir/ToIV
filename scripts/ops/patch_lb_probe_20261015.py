#!/usr/bin/env python3
"""给 comfyui-lb.py 的健康探针加连续失败阈值，并把探测超时从 3s 放宽到 10s。

为什么要改：2026-10-15 实测两个后端 /system_stats 直连都是 1.9ms/200，但 LB 在
3 小时内记了 65 次 UNHEALTHY，且状态翻转间隔最长 59s（远超 5s 探测周期）——说明
探测协程本身没跑上（事件回路被媒体代理占用），单次 3s 超时+单次失败即摘除会把健康
后端误摘，池从 2 个后端塌成 1 个，战役吞吐腰斩。
"""

import shutil
import sys
from pathlib import Path

TARGET = Path("/opt/ComfyUI/comfyui-lb.py")
BACKUP = Path("/opt/ComfyUI/comfyui-lb.py.bak-20261015-probe")

CONST_OLD = 'HEALTH_CHECK_INTERVAL = 5  # 秒\nHEALTH_TIMEOUT = 3        # 秒\n'
CONST_NEW = (
    'HEALTH_CHECK_INTERVAL = 5  # 秒\n'
    'HEALTH_TIMEOUT = 10       # 秒（探测与代理共用 session，3s 会在大文件代理时误判）\n'
    'HEALTH_FAIL_THRESHOLD = 2  # 连续失败几次才摘除；单次成功即恢复\n'
)

LOOP_OLD = '''async def health_check_loop(app: web.Application):
    session = app["session"]
    while True:
        maybe_reload_backends()  # backends 文件热更新（mtime 变化才重载）
        for backend in list(BACKENDS):
            try:
                async with session.get(
                    f"{backend['url']}/system_stats",
                    timeout=ClientTimeout(total=HEALTH_TIMEOUT),
                ) as resp:
                    healthy = resp.status == 200
            except Exception:
                healthy = False

            old = backend_health.get(backend["id"])
            if old != healthy:
                logger.info(f"Backend {backend['id']} ({backend['url']}) → {'HEALTHY' if healthy else 'UNHEALTHY'}")
            backend_health[backend["id"]] = healthy

        await asyncio.sleep(HEALTH_CHECK_INTERVAL)
'''

LOOP_NEW = '''async def health_check_loop(app: web.Application):
    session = app["session"]
    fail_streak: dict[str, int] = {}
    while True:
        maybe_reload_backends()  # backends 文件热更新（mtime 变化才重载）
        for backend in list(BACKENDS):
            bid = backend["id"]
            try:
                async with session.get(
                    f"{backend['url']}/system_stats",
                    timeout=ClientTimeout(total=HEALTH_TIMEOUT),
                ) as resp:
                    probe_ok = resp.status == 200
            except Exception:
                probe_ok = False

            if probe_ok:
                fail_streak[bid] = 0
                healthy = True
            else:
                fail_streak[bid] = fail_streak.get(bid, 0) + 1
                # 未达阈值不摘除，避免探测回路被拖慢时把健康后端误判成离线
                healthy = (
                    False
                    if fail_streak[bid] >= HEALTH_FAIL_THRESHOLD
                    else backend_health.get(bid, True)
                )

            old = backend_health.get(bid)
            if old != healthy:
                logger.info(
                    f"Backend {bid} ({backend['url']}) → "
                    f"{'HEALTHY' if healthy else 'UNHEALTHY'} (fail_streak={fail_streak[bid]})"
                )
            backend_health[bid] = healthy

        await asyncio.sleep(HEALTH_CHECK_INTERVAL)
'''


def main() -> int:
    src = TARGET.read_text(encoding="utf-8")
    if "HEALTH_FAIL_THRESHOLD" in src:
        print("already patched, nothing to do")
        return 0
    for needle, name in ((CONST_OLD, "constants"), (LOOP_OLD, "health_check_loop")):
        if src.count(needle) != 1:
            print(f"ABORT: anchor '{name}' matched {src.count(needle)} times (expected 1)")
            return 1
    if not BACKUP.exists():
        shutil.copy2(TARGET, BACKUP)
        print(f"backup written: {BACKUP}")
    patched = src.replace(CONST_OLD, CONST_NEW).replace(LOOP_OLD, LOOP_NEW)
    TARGET.write_text(patched, encoding="utf-8")
    compile(patched, str(TARGET), "exec")
    print("patched + syntax OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
