# 凭据获取方式（不含明文，隐私内容不入库）

> 按用户口径（2026-10-14）：**涉及隐私的凭据不上传仓库**。本文件只登记"有哪些凭据、在哪拿"，不写明文值。

## 凭据清单与获取途径

| 凭据 | 用途 | 获取途径（按优先级） |
|---|---|---|
| ToIV admin 账号密码 | 登录 web/admin/api（生产 core） | ① 向用户索取 ② 本机 `AGENTS.md` §二（若该文件仍保留凭据表） |
| 生产 PostgreSQL 密码（user=toiv, db=toiv） | core 本机 `psql` 直查（仅 127.0.0.1） | 同上；或 SSH core 后从 canvas-api 的 systemd 环境/`canvas-api.env` 里读 `DATABASE_URL` |
| NAS SMB（user=dgmt-nas，共享名 NAS） | 挂载模型库 | 同上；或 SSH NAS 后本机核对 |
| Tailscale Auth Key | 新设备入网 | 向用户索取（单次 key 可能已用，建议直接在 Tailscale admin 后台新生成） |
| spark02 vLLM | LLM API | 当前直连免鉴权，无需凭据 |
| core LLM 代理 /api/llm/v1 | 经代理调 LLM | 用 ToIV 登录 token（7 天期 JWT）即可 |

## 生产环境变量文件位置（core，凭据落地处，SSH 后可查）

| 文件 | 内容 |
|---|---|
| `/home/merlin/beeftv-prod/canvas-api/canvas-api.env` | canvas 后端全部 env（`DATABASE_URL`、`CANVAS_OPS_TRUSTED_ORIGINS` 等）；systemd --user 单元 `canvas-api-pg.service` 的 EnvironmentFile |
| toiv-api 的 systemd 进程环境 | `TOIV_LLM_*`/`TOIV_WHISPER_URL` 等；⚠️ `/home/merlin/toiv/api/.env` 不存在——只能 `/proc/<api pid>/environ` 取 |
| `/home/merlin/toiv/api/.env.bak-whisper-cluster-20260921` | whisper 集群切换前的 env 备份 |
| `/home/merlin/beeftv-prod/canvas-api/data/local-model-config.json` | canvas 模型渠道配置（**加密存储**，只能经 `/studio/api/workspace/model-config` API 读写，密钥返回脱敏标记） |

## 渠道凭据现状（2026-10-14 实测）

- **canvas 助手渠道 `toiv-llm`（本地·Spark对话）**：BaseURL=`http://192.168.71.84:8000/v1`（spark02 直连，**免鉴权无过期面**）。⚠️ 历史教训：曾配成 core LLM 代理 `127.0.0.1:8090/api/llm/v1` + 7 天期 ToIV JWT，gate 退役后无人续期 → 静默过期 401。改渠道走 `PUT /studio/api/workspace/model-config`（revision CAS）。
- **产物 URL**：已签名 + 归属校验——测试构造 URL 必须带 sig 或先建档；媒体走 `?token=`。
- **H3 service-token**：自动刷新已 enable，到期留意一跳。
