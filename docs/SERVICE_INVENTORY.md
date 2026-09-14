# SERVICE_INVENTORY — ToIV 全服务清单（迁移资产清单）

> **用途**：`docs/MIGRATION_PLAYBOOK.md` 阶段 0 配套清单。每服务一行 = 名称/主机/托管方式/unit 位置/端口/配置位置/数据位置/依赖/启动顺序号（按手册③的 ①~⑦ 编排）/验收方法。
> **采集时间**：2026-09-13（全量真机 SSH/HTTP 采集，非文档转抄）
> **维护规则**：服务增删/端口/路径变更后必须同步本表；裸 IP 渐进替换为主机名（手册原则 2）

---

## 一、总表

### ① NAS / 网络底座（最先拉起）

| 名称 | 主机 | 托管方式 | unit/任务位置 | 端口 | 配置位置 | 数据/产物位置 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| NAS SMB 模型库 | NAS 192.168.71.7 | Samba 常驻 | —（设备自带） | 445 | NAS 自身管理 | `Windows/ComfyUI/ComfyUIModel`（524G+ 主模型库）+ `toiv/comfyui-models`（~260G） | 无 | ① | 各主机 `mountpoint`/net use Z: 通；模型文件抽样存在 |
| NAS→workstation 挂载 | workstation | fstab | `/etc/fstab`（凭据 `/root/.smbcredentials`） | — | fstab | `/home/merlin/nas_mount` | NAS 445 | ① | `mountpoint /home/merlin/nas_mount`；**挂载后须重启各 ComfyUI 实例**（防 object_info 缓存空列表） |
| frp server（香港 cloud） | cloud 43.119.32.180 | frps 常驻 | — | 7001(kcp)/7500/13100/18090 | cloud 上 frps 配置 | 无状态 | 无 | ⑦ | core `frpc` active；双域名通 |
| frp server + OpenResty（beijing） | beijing 8.140.222.24 | Docker `1Panel-frps` + `1Panel-openresty` | — | 7000/7500/13100/18090/1722 | beijing 1Panel | ACME 证书 | 无 | ⑦ | `https://toiv.wineryz.top` 200；证书有效 |

### ② workstation 算力（12 units，全部 systemd）

| 名称 | 主机 | 托管方式 | unit 位置 | 端口 | 配置位置 | 数据/产物位置 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| ComfyUI-LB 负载均衡 | workstation | systemd `comfyui-lb.service` | `/etc/systemd/system/` | **8188** | `/opt/comfyui-lb/backends.json`（5s mtime 热重载） | `/opt/ComfyUI`（工作目录） | gpu0-alt :8196、pc01 :8188 | ② | `GET :8188/admin/backends` 返回后端清单全 healthy |
| ComfyUI gpu0-alt（池成员） | workstation | systemd `comfyui-gpu0-alt.service` | 同上 | **8196** | unit 内嵌参数；`/opt/ComfyUI/extra_model_paths.yaml` | `/opt/ComfyUI/instances/gpu0/{output,temp,input}`；模型库 = NAS symlink | NAS 挂载、GPU0 | ② | txt2img 冒烟真实出图 |
| ComfyUI H3 worker（MiniMax） | workstation | systemd `toiv-comfyui-h3.service` + `.d/`（UUID 钉卡 + MemoryMax 160G） | 同上 | **8195** | `/home/merlin/ComfyUI-h3-eval/extra_model_paths.yaml` | 同安装目录；产物至 ToIV 数据目录 | NAS、GPU2（UUID `GPU-0e6e9149…`） | ② | `POST :8195/free` 200；H3 生成一发成功 |
| ComfyUI LongCat worker | workstation | systemd `comfyui-longcat.service` + `.d/gpu0.conf` | 同上 | **8197** | `/home/merlin/ComfyUI-longcat/extra_model_paths.yaml` | 同安装目录 | NAS、GPU0（⚠️ drop-in 实际钉 GPU0，主文件写 GPU2） | ② | object_info 200；LongCat 工作流一发 |
| ComfyUI Wan-Animate-2 | workstation | systemd `comfyui-animate2.service` | 同上 | **8199** | `/home/merlin/ComfyUI-animate2/extra_model_paths.yaml`（独立 venv） | 同安装目录 | NAS、GPU3 | ② | object_info 200 |
| ComfyUI 超分 gpu1 | workstation | systemd `comfyui-upscale-gpu1.service` | 同上 | **8261** | unit 内嵌（cache-lru 2、disable-smart-memory） | `/opt/ComfyUI/instances/gpu1/{output,temp,input}` | NAS、GPU1 | ② | 超分任务调用成功 |
| ComfyUI 超分 gpu2 | workstation | systemd `comfyui-upscale-gpu2.service` | 同上 | **8262** | 同上 | `/opt/ComfyUI/instances/gpu2/…` | NAS、GPU0（⚠️ 已挪 GPU0，unit 描述仍写 GPU2） | ② | 同上 |
| ComfyUI 超分 gpu3 | workstation | systemd `comfyui-upscale-gpu3.service` | 同上 | **8263** | 同上 | `/opt/ComfyUI/instances/gpu3/…` | NAS、GPU3 | ② | 同上 |
| Qwen3-Embedding-4B | workstation | systemd `qwen3-embedding.service` | 同上 | **9302** | unit 内嵌（MODEL_PATH/DEVICE/PORT） | `/home/merlin/models/Qwen3-Embedding-4B`（NAS 权重） | NAS、GPU1 | ② | `POST :9302/v1/embeddings` 真实出向量 |
| ToIV 音频分离（Demucs） | workstation | systemd `toiv-audio-sep.service` | 同上 | **9220** | unit 内嵌 | `/home/merlin/toiv-scripts` | GPU2、独立 venv | ② | 分离接口 200 |
| ToIV ComfyUI MCP Bridge | workstation | systemd `toiv-comfy-mcp.service` | 同上 | **9100** | unit 内嵌（⚠️ `COMFYUI_URL=127.0.0.1:8189` 已退役端口，见漂移清单） | 无状态 | node `/usr/bin/comfyui-mcp` | ② | `:9100` HTTP 200 |
| fan_guard 锁扇 | workstation | systemd `fan_guard.service` | 同上 | 无 | unit 指向 `/opt/fan_guard.py`（⚠️ 非 /tmp） | 无状态 | nemotron-venv（pynvml） | ② | `nvidia-smi -q -d FAN` 风扇 100% |

### ③ pc01 Windows 算力（计划任务）

| 名称 | 主机 | 托管方式 | 任务位置 | 端口 | 配置位置 | 数据/产物位置 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| ComfyUI 主 worker | pc01 192.168.71.116 | schtasks `\StartComfyUI`（登录时，InteractiveToken，用户 home） | 任务命令 `C:\ComfyUI\start_comfyui.bat` | **8188** | `C:\ComfyUI\extra_model_paths.yaml`（R: RAM 盘热模型 + NAS + local） | `C:\ComfyUI\output`；NAS 经 Z: | NAS SMB（bat 自挂 + 明文密码 ⚠️）、R: ready.flag 门 | ③ | `:8188/system_stats` 200 + object_info 模型数对上 |
| ComfyUI H3 int8 实例 | pc01 | schtasks `\StartComfyUI-H3`（登录时） | `C:\ComfyUI-h3\start_comfyui_h3.bat` | **8198** | `C:\ComfyUI-h3\extra_model_paths.yaml` | `C:\ComfyUI-h3\output` | NAS、Z:、--lowvram | ③ | `:8198/system_stats` 200 |
| RAM Disk 热模型同步 | pc01 | schtasks `\RamDiskHotSync`（系统启动时，SYSTEM） | `C:\ComfyUI\sync_hotmodels.ps1` | 无 | ps1 内嵌（64G R:、4 组热模型清单） | R:\models（SoftPerfect RAM Disk，试用授权待换） | NAS、SoftPerfect | ③ | `R:\ready.flag` 存在 |
| ~~pc02~~ | pc02 | **2026-09-13 已下线**（:8193/:8194 全停，LB 池已移除） | — | — | — | — | — | — | 不再验收 |

### ④ Spark LLM 算力（手工脚本，TP2 跨双机）

| 名称 | 主机 | 托管方式 | unit/任务位置 | 端口 | 配置位置 | 数据/产物位置 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| DSv4-Flash 无审查 TP2（rank1 worker） | spark01 192.168.71.82 | **手工脚本** `~/dsv4-serve.sh 1`（docker run，`--restart=no`，重启不自动拉起 ⚠️） | `/home/dgmt-spark/dsv4-serve.sh` | —（headless） | 脚本内嵌（RAIL 192.168.200.x、RoCE GID 自动推导、KVD/MTP 等 env 可覆写） | `~/models/dsv4-flash-dspark-abliterated`（双机同路径，~155GiB） | spark02 RAIL 200GbE、容器镜像 `ghcr.io/drowzeys/vllm-dspark-nvfp4-stage-c:gb10` | ④（先 rank1 后 rank0） | `docker ps` 见 dsv4_60；NVMe fault-in 冷启动 10–45min 属正常 |
| DSv4-Flash 无审查 TP2（rank0 head/API） | spark02 192.168.71.84 | 手工脚本 `~/dsv4-serve.sh 0` | 同上 | **8000**（/v1，别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`/`deepseek-v4-flash-dspark`） | 同上 | 同上 | spark01 rank1 | ④ | `:8000/health` 200 + 出文冒烟（70.5 tok/s 基准） |
| DRT LiveKit 栈（3 容器） | spark02 | docker compose（遗留，去留未拍板 ⚠️） | — | livekit 默认 | — | 无状态 | — | ④ 后 | 决策后处置 |

### ⑤ core 业务网关（systemd + docker）

| 名称 | 主机 | 托管方式 | unit/任务位置 | 端口 | 配置位置 | 数据/产物位置 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| toiv-api（FastAPI/Uvicorn） | core 192.168.71.47 | systemd `toiv-api.service` | `/etc/systemd/system/` | **8090** | `/home/merlin/toiv/deploy/.env`（EnvironmentFile，全量密钥） | PG 18（本机）、Redis、作品/封面上传目录、`/mnt/toiv-nas`（NAS 挂载：drama/audio 产物） | PG/Redis、WS/PC/Spark 全部上游 | ⑤ | `/api/health` 200（workers 齐）+ 登录 + 一条端到端生成 |
| toiv-web（Next.js） | core | systemd `toiv-web.service` | 同上 | **3100** | 同上 `.env`；构建产物 `/home/merlin/toiv/web/.next` | 无状态 | toiv-api | ⑤ | 双域名 web 200；查 BUILD_ID 为新构建 |
| PostgreSQL 18 | core | 系统自带/裸装 | — | 5432（127.0.0.1） | — | PG 数据目录（**业务全量，最大有状态项之一**） | 无 | ⑤（最先于 api） | api health 通即隐含 |
| Redis | core | 系统自带/裸装 | — | 6379（127.0.0.1） | — | RDB | 无 | ⑤ | 同上 |
| frpc（cloud 隧道） | core | systemd `frpc.service` | `/etc/systemd/system/` | 无（出向 kcp :7001） | `/etc/frp/frpc.toml`（⚠️ 含 token，已入仓 deploy/infra/frp/） | 无状态 | cloud frps | ⑦ | frps 端见连接 |
| frpc-bj（beijing 隧道） | core | systemd `frpc-bj.service` | 同上 | 无（出向 tcp :7000） | `/etc/frp/frpc-bj.toml`（⚠️ 含 token） | 无状态 | beijing frps | ⑦ | 同上 |
| DRT 全套（12 容器） | core | docker（compose 目录 `/home/merlin/drt/infrastructure/docker`） | — | web:3000/api:3001/caddy:80,443/loki:3110/grafana:3002/prometheus:9090/alertmanager:9093 | compose 文件 + Caddyfile（同目录） | drt-postgres-prod（pgvector pg16）、drt-redis-prod、**drt-minio-prod、备份卷** | 去留待 DRT 负责人拍板 ⚠️ | ⑤ 后 | drt-web/api 容器 Up；**若迁移需用 drt-bundle 六件套导出卷** |

DRT 12 容器名×镜像（2026-09-13 采集）：`drt-web-prod`(docker-web) `drt-api-prod`(docker-api) `drt-caddy`(caddy:2-alpine，:80/:443) `drt-backup`(postgres:16-alpine) `drt-backup-minio`(alpine:3.20) `drt-loki`(grafana/loki:3.1.1，127.0.0.1:3110) `drt-grafana`(grafana/grafana:11.2.0，:3002) `drt-promtail`(grafana/promtail:3.1.1) `drt-prometheus`(prom/prometheus:v2.54.1，:9090) `drt-alertmanager`(prom/alertmanager:v0.27.0，:9093) `drt-minio-prod`(minio/minio:latest) `drt-postgres-prod`(pgvector/pgvector:pg16) `drt-redis-prod`(redis:7-alpine)。

### ⑥ OpenClaw 辅助网关 ×4

| 名称 | 主机 | 托管方式 | 位置 | 端口 | 配置位置 | 数据 | 依赖 | 顺序 | 验收方法 |
|---|---|---|---|---|---|---|---|---|---|
| OpenClaw 01–04 | openclaw01-04（TS 100.115.23.67 / 100.76.35.7 / 100.76.140.121 / 100.125.217.11） | launchd（Mac mini M4） | 各机 `~`（未采集，⚠️ 上游已断待决策） | **18789** | 各机本地 | 无状态 | 上游 LLM（已断） | ⑥ | `curl :18789/` = 200（2026-09-13 四台全 200 ✓） |

---

## 二、启动顺序速查（手册③编排）

```
① NAS + hosts/DNS        → mountpoint / net use Z: 通
② workstation 12 units   → 逐 unit active + :8188/admin/backends healthy + txt2img 出图
③ pc01 计划任务           → :8188/:8198 system_stats 200 + R:\ready.flag
④ spark DSv4（先 spark01 rank1 → spark02 rank0）→ :8000/health + 出文（冷启动提前拉起）
⑤ core 业务栈（PG/Redis → api → web → DRT）→ /api/health + web 200 + 端到端生成
⑥ OpenClaw               → :18789 ×4 = 200
⑦ frp/域名切换            → 双域名各跑一条生成（唯一不可逆点）
```

**同序号内并行无依赖**；② 各 ComfyUI 实例要求 NAS 挂载在其启动**之前**完成（object_info 缓存坑）。

## 三、环境漂移清单（采集发现，与 AGENTS.md/手册口径的差异）

1. **comfyui-longcat**：drop-in `comfyui-longcat.service.d/gpu0.conf` 生效 `CUDA_VISIBLE_DEVICES=0`（主 unit 写 GPU2）——LongCat 实际与 gpu0-alt 共 GPU0。
2. **comfyui-upscale-gpu2**：`CUDA_VISIBLE_DEVICES=0`（描述仍写 GPU2）——2026-09-13 全资源利用时挪到 GPU0，实例目录名 instances/gpu2 未改。
3. **toiv-comfy-mcp**：`COMFYUI_URL=http://127.0.0.1:8189`，8189 已退役且无监听——环境变量漂移（ExecStart 未引用该变量，实际影响有限）。
4. **LB backends.json 现网 2 后端**（gpu0:8196 + pc01:8188）；AGENTS/手册口径「3 后端含 pc02:8193」已过时（pc02 下线时移除，属预期但文档未同步）。
5. **workstation 遗留大量已 disable 的 legacy unit**（comfyui-gpu0:8189 / ltx25 / hunyuan3d / infinitetalk / toiv-asr / cosyvoice×2 / fireredasr / fishs2 / hy3dtex / indextts / liveact / lipsync / qwen3tts / sensevoice / scope / sysmetrics / 3dops / trainer / vlm / i2l / qwen3-embed-vllm 等，含 .bak 文件）——不会复活但是配置债，迁移时可不搬。
6. **pc01 计划任务三残留**：`\ComfyUI`、`\ComfyUI_Headless`、`\ComfyUI_Start`（2026/7 一次性旧任务）仍在，现行仅 `\StartComfyUI` + `\StartComfyUI-H3` + `\RamDiskHotSync`。
7. **pc01 ps1/bat 双轨**：`start_comfyui.ps1` 是旧模板（无 RAM disk 等待门），计划任务实际执行 `start_comfyui.bat`——迁移以 bat 为准。
8. **spark02 仍有 DRT LiveKit 3 容器在跑**（drt-livekit/egress/meeting-redis）——服务重构 F 组「DRT 去留」决策未拍板但未停。
9. **toiv-comfyui-h3**：主 unit `CUDA_VISIBLE_DEVICES=2` 与 drop-in UUID 钉卡（GPU-0e6e9149…）并存，最终生效 UUID（PCI 总线序漂移防护，H-6）。
10. **敏感信息明文**（入仓文件已标 SENSITIVE）：pc01 bat/ps1/sync_hotmodels.ps1 内含 NAS SMB 明文密码；core frpc.toml `token=token123456`（弱口令）；core `.env` 全量密钥未入仓（按手册阶段 0-6 走加密保管）。
11. **core `.env` 十几个裸 IP**（WS/PC/Spark/NAS/MateBook 代理）——手册已知痛点 1，渐进替换中。
12. **别名漂移**：本机 ssh 别名 `sk02-l`（非任务书所写 sk02-lan）；`pc01` 别名可用但偶发经 127.0.0.1:7897 代理被拒（重试即通）。

## 四、配套入仓位置

| 内容 | 位置 |
|---|---|
| workstation 12 unit + 2 组 drop-in + backends.json + 2 个 extra_model_paths.yaml | `deploy/infra/workstation-units/` |
| pc01 bat/ps1/sync_hotmodels/extra_model_paths ×2 | `deploy/infra/pc01/` |
| core frpc/frpc-bj toml | `deploy/infra/frp/`（⚠️ 含 token，勿外传） |
| 7 份 pip freeze（WS 6 venv + core api venv） | `deploy/infra/pip-freezes/` |

未入仓（有意）：core `deploy/.env`（密钥，走加密备份）；spark `dsv4-serve.sh`（脚本含 RAIL 拓扑推导，建议在 spark 侧 `git init` 或复制入 `deploy/infra/spark/` 补做）；DRT compose 目录（归 DRT 仓库）；OpenClaw 各机配置（上游已断，随决策处置）。
