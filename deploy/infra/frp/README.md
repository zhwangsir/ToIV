# frp

> **来源主机**：core（192.168.71.47，merlin）
> **采集时间**：2026-09-13
> **用途**：迁移手册阶段 0 配置入仓（只复制不启用）。对应清单 `docs/SERVICE_INVENTORY.md` ⑦组（域名/frp 通道）。
>
> ⚠️ **SENSITIVE**：两个 toml 均含 frps auth token（`frpc.toml` 为弱口令 `token123456`）。**勿外传、勿贴到任何外部系统**；入仓仅为迁移复现，正式迁移时建议顺带轮换 token。

## 文件清单

| 文件 | 来源路径（core 上） | 服务 | server |
|---|---|---|---|
| `frpc.toml` | `/etc/frp/frpc.toml` | systemd `frpc.service` → `/usr/local/bin/frpc -c /etc/frp/frpc.toml` | cloud 43.119.32.180:7001 **kcp**（toiv.dgmt.top） |
| `frpc-bj.toml` | `/etc/frp/frpc-bj.toml` | systemd `frpc-bj.service` | beijing 8.140.222.24:7000 tcp（toiv.wineryz.top） |

两个 client 均 `loginFailExit=false`（N-1），各转两条 tcp：toiv-api 127.0.0.1:8090→remote 18090、toiv-web 127.0.0.1:3100→remote 13100。

core 上另有历史备份未入仓：`frpc.toml.bak-20260804`、`frpc.toml.bak-20260811-kcp`。
服务端配置（cloud / beijing 1Panel-frps）不在本仓，迁移阶段 1 才需要动，届时从 frps 主机采集。
