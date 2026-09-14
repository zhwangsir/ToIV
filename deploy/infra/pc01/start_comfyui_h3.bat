@echo off
net use Z: /delete /y >nul 2>&1
net use \\192.168.71.7\NAS /user:dgmt-nas Aki.19950108 > C:\ComfyUI-h3\nas-mount.log 2>&1
net use Z: \\192.168.71.7\NAS >> C:\ComfyUI-h3\nas-mount.log 2>&1
cd /d C:\ComfyUI-h3
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "NO_PROXY=*"
venv\Scripts\python.exe main.py --listen 0.0.0.0 --port 8198 --lowvram > C:\ComfyUI-h3\comfyui.log 2>&1
