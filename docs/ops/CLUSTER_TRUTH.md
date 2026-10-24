# CLUSTER_TRUTH — ToIV 集群现行真源

> **权威顺序**：① 真机探针（LAN curl / docker inspect）→ ② 仓库代码默认（Wave N1：`config.py` / `fleet_registry.py` / `.env.example`）→ ③ 本文件 → ④ 其它文档。  
> **命名铁律**：一个磁盘权重只对应一个 weight id；对外 served 名不得伪装成另一家模型家族。  
> **探针 as-of**：**2026-10-23 20:04 Asia/Shanghai**（NAMING_N2 完成：core `.env` 已对齐；spark `/v1/models` **仅** `deepseek-v4-flash-dspark`）。
> **NAMING_N2（本轮已做）**：生产 `core:/home/merlin/toiv/deploy/.env` 热对齐 + `toiv-api` restart；双机 `~/dsv4-serve.sh` 仅 `--served-model-name deepseek-v4-flash-dspark` 并冷启。**未做**：git commit/push、全量 deploy。  
> **知识图谱页**：[ToIV 能力知识图谱与命名规范](https://cursor.com/canvas/store-2a7cb835-7fcb-4cd4-b2c8-cb0ee07b899c/b21e123b-da5f-43d9-90af-a3842894cfcc)

任何 AGENTS / DEVICE_MODELS / SERVICE_INVENTORY / skills 与本表冲突时，**以本表 + 当场再探针为准**。

---

## 1. 主机

| host id | 主机名 | LAN | Tailscale | SSH 用户 | 职责 |
|---|---|---|---|---|---|
| host.ops-matebook | MateBook | **192.168.71.118**（en0；勿再写 .9） | 100.74.15.34 | 本机 | 运维 / Cursor |
| host.core | core | 192.168.71.47 | 100.77.80.100 | merlin | 网关：web:3100 · api:8090 · admin:3200 · PG/Redis（127.0.0.1） |
| host.ws | workstation | 192.168.71.127 | 100.68.100.90 | merlin | **全部 GPU/AI 后端** |
| host.spark-a | spark01 | 192.168.71.82 | 100.81.235.124 | dgmt-spark | LLM **TP2 rank1 headless**（本机 **无 :8000**） |
| host.spark-b | spark02 | 192.168.71.84 | 100.86.42.89 | dgmt-spark | LLM **唯一对外 API** `:8000` |
| host.oc-01..04 | openclaw01–04 | .86 / .75 / .81 / .85 | 100.115.23.67 / 100.76.35.7 / 100.76.140.121 / 100.125.217.11 | dgmt-openclaw0N | Whisper `:9310` ×4；JoyCaption `:9305` |
| host.nas | DXP8800 | 192.168.71.7 | 100.80.237.96 | dgmt-nas | SMB 模型库 |
| （网关） | beijing / cloud | 8.140.222.24 / 43.119.32.180 | cloud TS 见现场 | root | `toiv.wineryz.top` / `toiv.dgmt.top` |

已退役勿再当活设备：studio01–04、EXO、pc02。pc01（.116）可选/常 offline，**不进热路径默认**。

**SSH 偏好（家里 LAN）**：`core` / `workstation-lan` / `sk01-l` / `sk02-l` / `openclaw0*-lan`。外出大流量：`core-jump`（经 WS → core LAN）。默认 Host 若走 IPv6/公网易超时。

---

## 2. 存活端点（本轮 HTTP）

| ep id | 地址 | 探针结果 | weight / served |
|---|---|---|---|
| ep.gateway.api | core:8090 | `/api/health` → ok | — |
| ep.gateway.web | core:3100 | 200 | — |
| ep.gateway.admin | core:3200 | 200 | — |
| ep.llm.primary | spark02:8000 | `/v1/models` OK | **weight** `dsv4-flash-dspark-abliterated`；**canonical served** `deepseek-v4-flash-dspark` |
| （无） | spark01:8000 | **Connection refused** | TP worker only |
| ep.vlm.primary | ws:9311 | `/v1/models` → `toiv-vlm` | root=`Qwen3-VL-8B-Instruct` |
| ep.lb.comfy-primary | ws:8188 | system_stats 200 | backends=`8196`/`8263`/`8265`（`/opt/comfyui-lb/backends.json`） |
| ep.comfy.image-gate | ws:8196 | 200 | 通用出图 / LB gpu0 |
| ep.comfy.video-longcat | ws:8197 | 200 | LongCat/Wan/VACE |
| ep.comfy.video-animate2 | ws:8199 | 200 | Wan-Animate-2 |
| ep.h3.prod | ws:8264 | 200 | H3 生产（ref2va/fl2va） |
| ep.comfy.upscale-a/b | ws:8262 / :8263 | 200 | 超分（8263 在 LB） |
| ep.comfy.image-worker-c | ws:8265 | 200 | LB 池 |
| ep.tts.primary | ws:9200 | indextts2 v2.5 loaded | IndexTTS2 |
| ep.demucs.primary | ws:9220 | demucs-htdemucs | — |
| ep.embed.primary | ws:9302 | qwen3-embedding-4b | Qwen3-Embedding-4B |
| ep.asr.whisper-cluster | oc*:9310 | `/health` 200×4 | whisper-mlx |

### 本轮明确 DOWN（勿写进默认配置）

`:8189` `:8195` `:8261` `:8200` `:8300` `:9004` `:9201` `:9202` `:9203` `:9210` `:9211` `:9304` `:9400`–`:9404`（WS）；spark01 `:8000`。

---

## 3. LLM / VLM 真相（防伪装）

| 项 | 现行事实 |
|---|---|
| 唯一 LLM 权重 | `~/models/dsv4-flash-dspark-abliterated`（双机 docker `dsv4_60`，TP=2，nnodes=2） |
| API | **仅** spark02 `:8000`（rank0）；spark01 = `--headless --node-rank 1` |
| Canonical model id | `deepseek-v4-flash-dspark` |
| **served 名（已复核）** | **仅** `deepseek-v4-flash-dspark`；旧别名 HTTP 404 |
| 仓库默认（N1） | `TOIV_LLM_MODEL=deepseek-v4-flash-dspark`；display 诚实写 DSv4 |
| VLM | **仅** workstation `:9311` served=`toiv-vlm` ← Qwen3-VL-8B-Instruct。**不是** spark01 |

---

## 4. 代码默认应对齐（Wave N1 已落仓库）

| 键 | 应指向 |
|---|---|
| `TOIV_LLM_BASE_URL` | `http://192.168.71.84:8000/v1` |
| `TOIV_LLM_MODEL` | `deepseek-v4-flash-dspark` |
| `TOIV_VLM_SERVER_URL` / model | `http://192.168.71.127:9311` / `toiv-vlm` |
| `TOIV_H3_BASE_URL` | `http://192.168.71.127:8264` |
| `TOIV_LONGCAT_BASE_URL` | `…:8197` |
| `TOIV_WAN_ANIMATE2_BASE_URL` | `…:8199` |
| Comfy workers / LB | `http://192.168.71.127:8188`（或经 registry） |
| TTS / Embed / Demucs | `:9200` / `:9302` / `:9220` |
| Whisper | openclaw 四址 `:9310`（探针 path=`/health`） |

**风险**：生产 core `/home/merlin/toiv/apps/api/.env` 可能仍写旧 `TOIV_LLM_MODEL`/DISPLAY（本轮未改）。以现场 `deploy/.env` 为准，改前先 `grep TOIV_LLM`。

---

## 5. 产品入口

| 场景 | URL |
|---|---|
| 家里 LAN | `http://192.168.71.47:3100` · api `:8090` · admin `:3200` |
| 公网 CN | `https://toiv.wineryz.top` |
| 公网 HK | `https://toiv.dgmt.top` |

core **不做 GPU**。浏览器工具可走 Tailscale；core→WS 服务调用优先 LAN `192.168.71.x`。

---

## 6. 文档治理

| 文件 | 角色 |
|---|---|
| **本文件** | 唯一运维现行清单 |
| `AGENTS.md` | 短规则 + 开发命令 + 易错点；设备表指向本文件 |
| `docs/ops/DEVICE_MODELS_IN_USE_20261022.md` | 历史盘点；文首横幅 → 本文件 |
| `docs/SERVICE_INVENTORY.md` | 09-13 迁移考古；横幅 → 本文件 |
| `docs/ux/research/*`、`docs/ops/*_202610*.md` 多数 | 历史快照；横幅「非现行」 |
| 命名页 canvas | 规范 id / 禁止清单 |

复核口令（家里）：

```bash
curl -sS http://192.168.71.47:8090/api/health
curl -sS http://192.168.71.84:8000/v1/models | head
curl -sS http://192.168.71.127:9311/v1/models | head
curl -sS -o /dev/null -w '%{http_code}\n' http://192.168.71.127:8264/system_stats
curl -sS http://192.168.71.127:9200/health
# spark01 应失败：
curl -sS -m 2 http://192.168.71.82:8000/v1/models || true
```


---

## NAMING_N2（2026-10-23 ~19:58 Asia/Shanghai）

| 项 | 结果 |
|---|---|
| core env | `/home/merlin/toiv/deploy/.env`；备份 `.env.bak.naming-n2-*`；`TOIV_LLM_MODEL/DISPLAY/L2/L3/NSFW` → `deepseek-v4-flash-dspark`；`TOIV_EVAL_VLM_*` → `ws:9311` / `toiv-vlm`；Comfy/H3/LongCat/Upscale → LAN `192.168.71.127`（`:8188` / `:8264` / `:8197` / `:8262,:8263`） |
| toiv-api | `systemctl restart toiv-api` → `/api/health` ok，workers=`http://192.168.71.127:8188` |
| spark script | 双机 `~/dsv4-serve.sh` 备份 `.bak.naming-n2-*`；served 仅 canonical |
| spark restart | rank1@19:58:49 → rank0@19:59:03 → `/v1/models` 20:04 仅 canonical；chat smoke `N2_OK`；别名 404；`PROXY_MODELS` 已缩为单名并 restart api |
| 未做 | commit / push / 全量 deploy |
