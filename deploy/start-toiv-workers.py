"""在 4 卡 PRO6000 机(192.168.71.100)上启动/补齐全部 ToIV ComfyUI worker。

用法(在该机上,任意 Python 即可,只用标准库):
    set TOIV_NAS_PASS=********   &  python start-toiv-workers.py

- 每张卡一个 ComfyUI 进程:cuda 0/1/2/3 → 端口 8000/8002/8003/8004
- 幂等:端口已在监听的 worker 自动跳过,只拉起缺失的(不打扰在跑的)
- 经计划任务(schtasks ONCE)后台常驻,SSH 断开也不受影响
- ⚠️ cuda0 用 8000,请勿同时再开占用 8000 的 Comfy Desktop,否则端口冲突
- 产物输出到 NAS(\\\\100.80.237.96\\NAS,SMB):每个 worker 的 bat 先 net use 认证
  NAS(同会话内即可写 UNC),再让 ComfyUI 把 --output-directory 设到 NAS。
  NAS 密码从环境变量 TOIV_NAS_PASS 读取(不写进仓库);bat 落在本机 F:\\(非仓库)。
"""
import os
import socket
import subprocess

PY = r"F:\comfy\ComfyUI\ComfyUI\.venv\Scripts\python.exe"
MAIN = r"F:\comfy\ComfyUI\ComfyUI\main.py"
YAML = r"F:\toiv_model_paths.yaml"  # 模型根=NAS(归一);见 deploy/toiv_model_paths.yaml
INP = r"F:\ComfyUIModel\input"

# 产物归档到 NAS(SMB 共享 NAS → /volume1/NAS)
NAS_HOST = "100.80.237.96"
NAS_SHARE = r"\\100.80.237.96\NAS"
NAS_USER = "dgmt-nas"
NAS_PASS = os.environ.get("TOIV_NAS_PASS", "")
OUT = r"\\100.80.237.96\NAS\Windows\ComfyUI\ComfyUIModel\output"

# (cuda 设备号, 端口)
WORKERS = [(0, 8000), (1, 8002), (2, 8003), (3, 8004)]

if not NAS_PASS:
    raise SystemExit("请先设置环境变量 TOIV_NAS_PASS(NAS 账号 dgmt-nas 的密码)再运行。")


def alive(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=2):
            return True
    except OSError:
        return False


for dev, port in WORKERS:
    if alive(port):
        print(f"cuda{dev} :{port} 已在运行,跳过")
        continue

    bat = rf"F:\toiv_worker{dev}.bat"
    log = rf"F:\toiv_worker{dev}.log"
    tn = f"ToIV_Worker{dev}"
    content = (
        "@echo off\r\n"
        f"net use {NAS_SHARE} /user:{NAS_USER} {NAS_PASS} /persistent:no\r\n"
        f'"{PY}" "{MAIN}" --listen 0.0.0.0 --port {port} --cuda-device {dev} '
        f'--extra-model-paths-config "{YAML}" '
        f'--input-directory "{INP}" --output-directory "{OUT}" > "{log}" 2>&1\r\n'
    )
    open(bat, "w", encoding="utf-8").write(content)
    subprocess.run(["schtasks", "/delete", "/tn", tn, "/f"], capture_output=True, text=True)
    c = subprocess.run(
        ["schtasks", "/create", "/tn", tn, "/tr", bat, "/sc", "ONCE", "/st", "00:00", "/f"],
        capture_output=True, text=True,
    )
    r = subprocess.run(["schtasks", "/run", "/tn", tn], capture_output=True, text=True)
    print(f"cuda{dev} :{port} 启动 -> create={c.returncode} run={r.returncode}")

print("完成。约 30-60s 后 4 个 worker 就绪;ToIV 会自动把 8000 纳入调度。")
