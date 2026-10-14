---
name: toiv-cluster
description: |
  ToIV 集群远程连接与 API 速查手册：所有设备（workstation/core/spark/beijing/NAS/openclaw 等）的 SSH 连接方法（LAN + Tailscale）、凭据密钥（NAS SMB、Tailscale、PG、admin）、各服务 API 端点与鉴权口径（ToIV api、LLM/VLM/ASR、canvas /studio/api、ComfyUI）、以及部署与运维配方。当用户要连接/登录/排查集群任何设备、查询服务状态、调用平台 API、查密码密钥、部署发版或操作生产数据库时使用本 skill。引用文件按需读取：connections.md（设备与连接）、credentials.md（密钥）、api.md（API 与运维配方）。
---

# ToIV 集群访问手册

单仓真源：本 skill 内容摘自 `AGENTS.md`（每节标注核验日期）。**文档可能滞后，凡服务状态/端口/显存/挂载必须真机验证后再作答**（SSH 执行真实命令，冲突以真机为准）。

## 使用纪律（先读，都是踩过的雷）

1. **算力后端全在 Workstation**（192.168.71.127 / TS 100.68.100.90）；core(192.168.71.47) 只跑 web/api/PG/Redis 业务网关；Mac/其他设备只是操作终端。排查「服务离线」第一反应=SSH 到真机查 systemd/端口，禁止臆断。
2. **浏览器/跨设备访问一律 Tailscale 优先**（TS IP 见 connections.md）；「TS 离线」≠「服务掉线」——先 LAN ping + 端口扫再下结论。
3. **core 上的 `systemctl --user` 经 SSH 必须先 `export XDG_RUNTIME_DIR=/run/user/$(id -u)`**，否则报错连不上 bus。
4. **Windows（pc01）长命令经 SSH 会被换行截断**：用 PowerShell `-EncodedCommand`；SSH 起的进程断连即死，长期服务走计划任务/NSSM。
5. 生产 PG 直查与部署命令见 api.md §运维配方；**手跑 `app.*` Python 代码必须显式带 `TOIV_DATABASE_URL`**（否则静默回落废弃 SQLite）。
6. 凭据全在 `credentials.md`（含敏感信息，只在本机/可信环境读取，不要外传到第三方服务）。

## 30 秒速查

| 要做什么 | 怎么做 |
|---|---|
| SSH workstation（全部 AI 后端） | `ssh merlin@192.168.71.127`（TS: `ssh merlin@100.68.100.90`） |
| SSH core（生产 web/api/PG） | `ssh merlin@192.168.71.47`（TS: `ssh merlin@100.77.80.100`） |
| 打开 ToIV（局域网，10ms 级） | `http://192.168.71.47:3100`（web）/ `:8090`（api）/ `:3200`（admin） |
| 打开 ToIV（外网） | `https://toiv.wineryz.top`（CN 入口）或 `https://toiv.dgmt.top`（香港 frp） |
| ToIV 登录 | `admin / admin123`（登录字段名是 **`email`**；全量凭据见 [credentials.md](credentials.md)） |
| LLM 直连 | `http://192.168.71.84:8000/v1`（spark02，served `deepseek-v4-flash-dspark`+3 别名；经 core 代理 `:8090/api/llm/v1` 需 ToIV JWT） |
| 生产 PG 直查 | 见 api.md §运维配方（只能 SSH 到 core 本机执行） |
| 查 GPU/服务 | `ssh merlin@192.168.71.127 'nvidia-smi; systemctl status comfyui-lb'` |

## 引用文件

- **[connections.md](connections.md)** — 全部设备的角色/LAN IP/Tailscale IP/SSH 用户/当前状态，NAS 挂载，入口域名与端口全景。
- **[credentials.md](credentials.md)** — NAS SMB、Tailscale Auth Key、ToIV admin、生产 PG、渠道凭据现状与轮换注意。
- **[api.md](api.md)** — API 文档：鉴权口径与实测可用的 curl 例（登录/LLM/whisper/embedding/canvas 助手链/ComfyUI 探测坑），部署与运维配方。

## 在新设备上启用本 skill

```bash
# 仓库内在任何设备 clone 后执行：
bash skills/toiv-cluster/install.sh
# 装到 ~/.agents/skills/toiv-cluster（符号链接，git pull 即自动更新）
```
