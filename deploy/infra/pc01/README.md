# pc01

> **来源主机**：pc01（192.168.71.116，Windows / RTX 5090 / 用户 home）
> **采集时间**：2026-09-13（`schtasks /query /fo csv /v` + scp）
> **用途**：迁移手册阶段 0 配置入仓（只复制不启用）。对应清单 `docs/SERVICE_INVENTORY.md` ③组。

## 现行计划任务（3 个）

| 任务 | 触发 | 命令 | 端口 |
|---|---|---|---|
| `\StartComfyUI` | 登录时（InteractiveToken，home） | `C:\ComfyUI\start_comfyui.bat` | :8188 |
| `\StartComfyUI-H3` | 登录时（home） | `C:\ComfyUI-h3\start_comfyui_h3.bat` | :8198（--lowvram） |
| `\RamDiskHotSync` | 系统启动时（SYSTEM） | `C:\ComfyUI\sync_hotmodels.ps1`（NAS→R: 64G RAM 盘热模型） | — |

残留旧任务（未入仓，迁移时勿建）：`\ComfyUI`、`\ComfyUI_Headless`、`\ComfyUI_Start`（2026/7 一次性）。

## 文件清单

| 文件 | 来源路径（pc01 上） | 说明 |
|---|---|---|
| `start_comfyui.bat` | `C:\ComfyUI\start_comfyui.bat` | ⚠️ **SENSITIVE：内含 NAS SMB 明文密码**（dgmt-nas），勿外传。含 R:\ready.flag 等待门（最长 15min） |
| `start_comfyui_h3.bat` | `C:\ComfyUI-h3\start_comfyui_h3.bat` | ⚠️ 同上含明文密码。:8198 --lowvram |
| `start_comfyui.ps1` | `C:\ComfyUI\start_comfyui.ps1` | ⚠️ 同上含明文密码。**旧模板**（无 RAM disk 门），现行走 bat，此文件仅存档 |
| `sync_hotmodels.ps1` | `C:\ComfyUI\sync_hotmodels.ps1` | ⚠️ 同上含明文密码。SoftPerfect RAM Disk 64G，4 组热模型 robocopy，写完 R:\ready.flag |
| `extra_model_paths_CComfyUI.yaml` | `C:\ComfyUI\extra_model_paths.yaml` | 主实例：R: ramdisk 优先 + NAS + local |
| `extra_model_paths_CComfyUI-h3.yaml` | `C:\ComfyUI-h3\extra_model_paths.yaml` | H3 实例：仅 h3_nas + local |

## Windows 迁移三坑（AGENTS W-1/W-2）

1. SSH 会话隔离：`net use` 盘符只在本会话可见，长期服务必须计划任务（InteractiveToken）自己挂。
2. SYSTEM 任务自挂：ps1 开头在任务自己 session 里 `net use Z:`（两个 bat 均已内嵌）。
3. `cmdkey` NAS 凭据需重打；模型可见性裁判是 ComfyUI 进程 object_info，不是 SSH 里 `dir Z:`。

编码：bat/ps1 为 GBK/GB18030 + CRLF（ps1 带 BOM），编辑后保持原编码。
