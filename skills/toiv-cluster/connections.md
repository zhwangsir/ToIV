# 设备清单与连接方法

> 摘自 AGENTS.md §一（最后核验 2026-10-13）；「状态」列是最近一次真机核实日期，使用前先自行验证。

## 设备总表

| 设备 | 角色 | LAN IP | Tailscale IP | SSH 用户 | 状态备注 |
|---|---|---|---|---|---|
| **workstation** | 算力 + 全部 AI 后端服务（ComfyUI 舰队/LLM 宿主/ASR 等，见 api.md 服务表） | `192.168.71.127` | `100.68.100.90` | `merlin` | 常开 |
| **core** | ToIV 生产（web :3100 + api :8090 + PG + Redis + admin :3200） | `192.168.71.47` | `100.77.80.100` | `merlin` | 常开；断电需手动开机 |
| **spark02** | 现网 LLM/VLM API（DSv4 TP2 head :8000） | `192.168.71.84` | `100.86.42.89` | `dgmt-spark` | restart=no，重启需手动 `~/dsv4-serve.sh 0` |
| **spark01** | DSv4 TP2 worker（rank1） | `192.168.71.82` | `100.81.235.124` | `dgmt-spark` | — |
| **openclaw01–04** | whisper ASR 集群 :9310 + JoyCaption :9305 | `.86 / .75 / .81 / .85` | `100.115.23.67 / 100.76.35.7 / 100.76.140.121 / 100.125.217.11` | `dgmt-openclaw01-04` | 01 SSH 拒连（服务不受影响）；四节点 9310/9305 经 TS 全 OPEN（10-05 核） |
| **beijing** | CN 入口 toiv.wineryz.top（OpenResty + frps） | `8.140.222.24` | — | `root` | — |
| **cloud** | 香港网关/frps/OpenResty（toiv.dgmt.top） | `43.119.32.180` | `100.83.78.114` | `root` | ⚠️ tailscaled 僵死待现场重启（用户面 frp 不受影响） |
| **NAS** | SMB 存储 44T（模型库 ≈6.7T） | `192.168.71.7` | `100.80.237.96` | `dgmt-nas` | — |
| **pc01** | ComfyUI worker :8188 + H3 二实例 :8198（NSSM） | `192.168.71.116` | `100.86.169.64` | `home` | ⚠️ 10-05 起持续 offline（:8188 经 TS CLOSED，LB 池剩 WS 单后端） |
| 小米路由器 | AP/有线中继 | `192.168.71.42` | — | — | 管理页 .42 |
| 光猫 | 主网关 | `192.168.71.1` | — | — | — |

（studio01-04 已退役；pc02 已下线。）

## SSH 连接示例

```bash
# workstation —— 全部 AI/算力后端
ssh merlin@192.168.71.127          # LAN（优先，同网段）
ssh merlin@100.68.100.90           # Tailscale（跨网段/外部设备优先走这个）

# core —— 生产
ssh merlin@192.168.71.47
ssh merlin@100.77.80.100

# spark02 —— LLM API（DSv4 TP2 head）
ssh dgmt-spark@192.168.71.84

# beijing（CN 入口）/ cloud（香港入口）
ssh root@8.140.222.24
ssh root@43.119.32.180

# NAS（SMB 见 credentials.md；SSH 同样可用）
ssh dgmt-nas@192.168.71.7
```

SSH 到 core 后操作用户级服务（canvas-api-pg 等）：

```bash
export XDG_RUNTIME_DIR=/run/user/$(id -u)   # 必须，否则 systemctl --user 连不上 bus
systemctl --user status canvas-api-pg
journalctl --user -u canvas-api-pg -f
```

## Web 入口

| 入口 | URL | 用途/口径 |
|---|---|---|
| **LAN 直连（优先）** | `http://192.168.71.47:3100`（web，/studio 同源）· `:8090`（api）· `:3200`（admin） | 用户在局域网时首选（10ms 级） |
| Tailscale | `http://100.77.80.100:3100` 等 | 外部设备经 TS |
| CN 外网入口 | `https://toiv.wineryz.top` | beijing OpenResty |
| 香港入口 | `https://toiv.dgmt.top` | cloud frp；跨境链路波动会污染 A/B 结论，验证优先 wineryz |

## NAS 挂载（两棵模型树）

- **主库（新下载只进这里）**：`toiv/comfyui-models` ≈5.2T —— workstation=`/home/merlin/nas_mount`；core=`/mnt/toiv-nas`
- **旧库**：`Windows/ComfyUI/ComfyUIModel/models` ≈1.5T（PC01/02 extra 指向旧树时**不得含 custom_nodes 键**）
- workstation 挂载后**必须重启 ComfyUI 实例**（否则缓存空模型列表）；重启后 `mountpoint` 核实。
- ⚠️ 盘上有 ≠ 产品在用；「两树合计会把硬链算重」。
- 下载主路：workstation 直连 `hf-mirror.com` + `aria2c -x16`。

## 连接类易错点（踩过的雷）

- **「TS 离线」≠「服务掉线」**：先 LAN ping + 端口扫；Linux 侧有 ts-health 探针（core/WS 常驻）。
- 服务必须监听 `0.0.0.0` 才经 Tailscale 可达。
- 并行 SSH 会话会互相改写状态：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源。
- `pkill -f` 模式串要转义（`[f]an_guard` 式）；大文件写 `/var/tmp`（/tmp 是 tmpfs）。
- 命令行测外网下载：workstation 上走 hf-mirror；Mac Clash(:7897) 是备份且依赖 Mac 在线。
