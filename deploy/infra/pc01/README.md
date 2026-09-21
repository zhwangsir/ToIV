# pc01

> **来源主机**：pc01（192.168.71.116，Windows / RTX 5090 / 用户 home）
> **采集时间**：2026-09-13（`schtasks /query /fo csv /v` + scp）；**2026-09-14 更新**：RAM disk 迁移 ImDisk + 任务转 SYSTEM；**2026-09-21 更新**：**:8198 改 NSSM 服务化**（见下「现行服务化」）
> **用途**：迁移手册阶段 0 配置入仓（只复制不启用）。对应清单 `docs/SERVICE_INVENTORY.md` ③组。

## 现行服务化（2026-09-21 起，:8198 NSSM 根治）

| 项 | 值 |
|---|---|
| 服务 | `ComfyUI-H3`（NSSM 2.24 win64,`C:\nssm.exe`） |
| 命令 | `C:\ComfyUI-h3\start_comfyui_h3.bat`（AppDirectory=`C:\ComfyUI-h3`） |
| 启动 | `SERVICE_AUTO_START`（LocalSystem;bat 自挂 Z: NAS 已在脚本内） |
| 复活 | `AppRestartDelay 5000`（进程退出 5s 后自动重启,kill 实证 ~12s 恢复 200） |
| 日志 | `C:\ComfyUI-h3\nssm-out.log` / `nssm-err.log` |
| 退役 | `\StartComfyUI-H3` 与 `\Watchdog-ComfyUI-H3` 两计划任务已 **Disabled 留档**（勿删,回退时 enable 并 `nssm stop/remove ComfyUI-H3`） |

安装序列（迁移复现用）：`nssm install ComfyUI-H3 C:\ComfyUI-h3\start_comfyui_h3.bat` → `set AppDirectory` → `set AppRestartDelay 5000` → `set AppStdout/AppStderr` → `set Start SERVICE_AUTO_START` → `nssm start ComfyUI-H3`。

## 现行计划任务（3 个）

| 任务 | 触发 | 身份 | 命令 | 端口 |
|---|---|---|---|---|
| `\StartComfyUI` | 系统启动（延迟 2min） | **SYSTEM / HIGHEST**（2026-09-14 从 InteractiveToken 改，修复重启后无人登录不起实例） | `C:\ComfyUI\start_comfyui.bat` | :8188 |
| ~~`\StartComfyUI-H3`~~ | ~~系统启动~~ | **已 Disabled（2026-09-21，见上 NSSM）** | ~~`C:\ComfyUI-h3\start_comfyui_h3.bat`~~ | ~~:8198~~ |
| `\RamDiskHotSync` | 系统启动时 | SYSTEM | `C:\ComfyUI\sync_hotmodels.ps1`（NAS→R: 60G RAM 盘热模型） | — |

残留旧任务（未入仓，迁移时勿建）：`\ComfyUI`、`\ComfyUI_Headless`、`\ComfyUI_Start`（2026/7 一次性）。

## 文件清单

| 文件 | 来源路径（pc01 上） | 说明 |
|---|---|---|
| `start_comfyui.bat` | `C:\ComfyUI\start_comfyui.bat` | ⚠️ **SENSITIVE：内含 NAS SMB 明文密码**（dgmt-nas），勿外传。含 R:\ready.flag 等待门（最长 15min） |
| `start_comfyui_h3.bat` | `C:\ComfyUI-h3\start_comfyui_h3.bat` | ⚠️ 同上含明文密码。:8198 --lowvram |
| `start_comfyui.ps1` | `C:\ComfyUI\start_comfyui.ps1` | ⚠️ 同上含明文密码。**旧模板**（无 RAM disk 门），现行走 bat，此文件仅存档 |
| `sync_hotmodels.ps1` | `C:\ComfyUI\sync_hotmodels.ps1` | ⚠️ 同上含明文密码。**ImDisk** 60G（`-t vm` 预分配，2026-09-14 从 SoftPerfect 试用版迁移），4 组热模型 robocopy，写完 R:\ready.flag |
| `extra_model_paths_CComfyUI.yaml` | `C:\ComfyUI\extra_model_paths.yaml` | 主实例：R: ramdisk 优先 + NAS + local |
| `extra_model_paths_CComfyUI-h3.yaml` | `C:\ComfyUI-h3\extra_model_paths.yaml` | H3 实例：仅 h3_nas + local |

## Windows 迁移三坑（AGENTS W-1/W-2）

1. SSH 会话隔离：`net use` 盘符只在本会话可见，长期服务必须计划任务（SYSTEM 任务 + bat 内自挂）。
2. SYSTEM 任务自挂：ps1 开头在任务自己 session 里 `net use Z:`（两个 bat 均已内嵌）。
3. `cmdkey` NAS 凭据需重打；模型可见性裁判是 ComfyUI 进程 object_info，不是 SSH 里 `dir Z:`。
4. **InteractiveToken 任务在重启后无人登录时不会启动**（2026-09-14 实证）——两 ComfyUI 任务已转 SYSTEM 修复。

## RAM disk 迁移记录（2026-09-14）

SoftPerfect RAM Disk 26.7 试用版（09-13 装，30 天试用）→ **ImDisk Toolkit 20250206**（免费）：
- 驱动：`imdisk` 服务 Running；创建命令 `imdisk.exe -a -t vm -s 60G -m R: -p "/FS:NTFS /Q /V:HotModels /Y"`（60G 而非 64G：`-t vm` 预分配内存，热集 55.2G + 余量）
- SoftPerfect 已卸载（unins000.exe /VERYSILENT）
- 重启测试 PASS：断电场景无人登录 → RamDiskHotSync(SYSTEM) 建 R:+同步 → StartComfyUI×2(SYSTEM) 起 :8188/:8198
- 验收：:8188 object_info 4306 类含 flux1-dev-fp8/flux2_dev_fp8mixed（R: 优先），flux txt2img 冒烟真实出图

编码：bat/ps1 为 GBK/GB18030 + CRLF（ps1 带 BOM），编辑后保持原编码。
