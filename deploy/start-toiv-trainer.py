"""ToIV Trainer Agent 启动脚本(Windows)—— 仿 start-toiv-workers.py 风格。

用 schtasks 注册为开机自启常驻进程,监听 :9100。
训练时 API 通过 HTTP 调本 agent,同 ComfyUI/TTS/LLM 的访问模式。

用法:
  python start-toiv-trainer.py          # 注册并启动
  python start-toiv-trainer.py --stop   # 停止并注销
"""
import argparse
import subprocess
import sys

TASK_NAME = "ToIVTrainer"
PYTHON = r"F:\toiv-trainer\.venv\Scripts\python.exe"
SCRIPT = r"F:\toiv-trainer\toiv-trainer.py"
# trainer agent 也要从 deploy/ 复制到 F:\toiv-trainer\ 下


def register_and_start() -> None:
    # 先复制 trainer agent 脚本到 F:\toiv-trainer\
    # (API 仓库在 spark02 上,这里只放运行时副本)
    subprocess.run(
        ["copy", "/Y", r"F:\toiv-trainer\ai-toolkit\..\toiv-trainer.py", SCRIPT],
        shell=True,
        check=False,
    )

    # 注册 schtasks(开机自启,SYSTEM 权限,避免 UAC 弹窗)
    cmd = (
        f'schtasks /create /tn {TASK_NAME} /tr '
        f'"{PYTHON} {SCRIPT}" /sc onlogon /rl highest /f'
    )
    subprocess.run(cmd, shell=True, check=True)

    # 立即启动
    subprocess.run(f'schtasks /run /tn {TASK_NAME}', shell=True, check=True)
    print(f"[OK] {TASK_NAME} 已注册并启动,监听 :9100")


def stop_and_unregister() -> None:
    subprocess.run(f'schtasks /end /tn {TASK_NAME}', shell=True, check=False)
    subprocess.run(f'schtasks /delete /tn {TASK_NAME} /f', shell=True, check=False)
    print(f"[OK] {TASK_NAME} 已停止并注销")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ToIV Trainer Agent 启动管理")
    parser.add_argument("--stop", action="store_true", help="停止并注销")
    args = parser.parse_args()

    if args.stop:
        stop_and_unregister()
    else:
        register_and_start()
