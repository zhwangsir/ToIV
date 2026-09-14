@echo off
rem NAS self-heal
net use Z: /delete /y >nul 2>&1
net use \\192.168.71.7\NAS /user:dgmt-nas Aki.19950108 > C:\ComfyUI\nas-mount.log 2>&1
net use Z: \\192.168.71.7\NAS >> C:\ComfyUI\nas-mount.log 2>&1
rem wait for RAM disk hot models (max 15 min)
set /a waited=0
:wait_r
if exist R:\ready.flag goto r_ready
if %waited% GEQ 900 goto r_timeout
timeout /t 10 >nul
set /a waited+=10
goto wait_r
:r_timeout
echo WARN: R:\ready.flag not present after 15min, starting anyway > C:\ComfyUI\ramdisk-wait.log
:r_ready
cd /d C:\ComfyUI
set "HTTP_PROXY="
set "HTTPS_PROXY="
set "ALL_PROXY="
set "http_proxy="
set "https_proxy="
set "NO_PROXY=*"
venv\Scripts\python.exe main.py --listen 0.0.0.0 --port 8188 > C:\ComfyUI\comfyui.log 2>&1
