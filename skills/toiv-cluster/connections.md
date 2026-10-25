# 设备清单与连接方法

> **DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai** · 与 [`AGENTS.md`](../../AGENTS.md) 对齐。冲突以 AGENTS.md + 真机为准。

## 设备总表

| 设备 | 角色 | LAN | Tailscale | SSH |
|---|---|---|---|---|
| MateBook | 运维本机 | **192.168.71.118** | 100.74.15.34 | 本机 |
| workstation | 全部 AI/GPU 后端 | 192.168.71.127 | 100.68.100.90 | merlin |
| core | web:3100 api:8090 admin:3200 | 192.168.71.47 | 100.77.80.100 | merlin |
| spark02 | **唯一 LLM API** :8000（DSv4） | 192.168.71.84 | 100.86.42.89 | dgmt-spark |
| spark01 | DSv4 TP2 headless worker（无 :8000） | 192.168.71.82 | 100.81.235.124 | dgmt-spark |
| openclaw01–04 | whisper :9310 + JoyCaption :9305 | .86/.75/.81/.85 | 见 CLUSTER_TRUTH | dgmt-openclaw0N |
| NAS | SMB 模型库 | 192.168.71.7 | 100.80.237.96 | dgmt-nas |
| beijing / cloud | 公网入口 | 8.140.222.24 / 43.119.32.180 | cloud 见现场 | root |

studio01–04 / EXO / pc02 已退役。pc01 可选、常 offline，勿作默认。

## SSH（家里优先 LAN 别名）

```bash
ssh workstation-lan    # 或 merlin@192.168.71.127
ssh core
ssh sk02-l             # spark02
ssh sk01-l             # spark01（worker）
# 外出大流量进 core：
ssh -J merlin@100.68.100.90 merlin@192.168.71.47   # = core-jump
```

## Web

| 场景 | URL |
|---|---|
| LAN | http://192.168.71.47:3100 · :8090 · :3200 |
| CN | https://toiv.wineryz.top |
| HK | https://toiv.dgmt.top |

## 关键服务口（WS）

`:8188` LB · `:8196` 出图 · `:8197` LongCat · `:8199` Animate2 · **`:8264` H3** · `:9311` VLM · `:9200` TTS · `:9302` embed · `:9220` demucs。  
**不要用**：`:8189` `:8195` `:8261` 及 CosyVoice 旧口。

## 易错

- spark02 = LLM；**VLM 在 workstation :9311**，不在 spark。  
- 「TS 离线 ≠ 服务掉」→ 先 LAN ping/端口。  
- 服务须听 `0.0.0.0` 才经 Tailscale 可达。
