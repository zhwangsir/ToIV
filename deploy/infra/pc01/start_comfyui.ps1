$ErrorActionPreference = "Continue"
# 1) Auth NAS (model library over SMB) - credentials: dgmt-nas
net use \\192.168.71.7\NAS /user:dgmt-nas Aki.19950108 2>$null
net use Z: \\192.168.71.7\NAS /persistent:yes 2>$null
# 2) Launch ComfyUI, listen on all interfaces
Set-Location C:\ComfyUI
& C:\ComfyUI\venv\Scripts\python.exe main.py --listen 0.0.0.0 --port 8188 *>> C:\ComfyUI\comfyui.log

