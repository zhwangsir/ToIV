# 凭据与密钥

> 用户拍板（2026-10-14）：本项目**仅本地自用/学习、不涉真实生产场景**，凭据全部明文入库（与 AGENTS.md §二 同口径）。
> 变更凭据后请同步更新本文件与 AGENTS.md。

## 核心凭据

| 服务 | 用户名 | 密码/密钥 | 备注 |
|---|---|---|---|
| ToIV admin（生产 core） | `admin` | `admin123` | 登录字段名是 **`email`**；响应是**扁平** `{token, user}`（没有 code/data 包裹，token 是 7 天期 JWT） |
| 生产 PostgreSQL（core 本机） | `toiv` | `68799b59242beeccfd54963902a35006` | db=`toiv`，`127.0.0.1:5432`，仅 bind 本机——只能 SSH 到 core 后查（命令见 api.md） |
| NAS SMB | `dgmt-nas` | `Aki.19950108` | `192.168.71.7`，共享名 `NAS`；Windows 侧 `cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108` |
| Tailscale Auth Key | — | `tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C` | 已用于 core 授权（2026-09）；若是单次 key 已失效，新设备入网请到 Tailscale admin 后台重新生成 |

## 生产环境变量文件位置（core，凭据落地处）

| 文件 | 内容 |
|---|---|
| `/home/merlin/beeftv-prod/canvas-api/canvas-api.env` | canvas 后端全部 env（`CANVAS_BACKEND_ADDR=127.0.0.1:8290`、`DATABASE_URL`(canvas PG)、`CANVAS_OPS_TRUSTED_ORIGINS` 等）；systemd --user 单元 `canvas-api-pg.service` 的 EnvironmentFile |
| `/home/merlin/toiv/api/`（systemd 环境） | toiv-api 的 `TOIV_LLM_*`/`TOIV_WHISPER_URL` 等；⚠️ `/home/merlin/toiv/api/.env` 不存在——env 只在 systemd 进程环境里，手跑代码用 `/proc/<pid>/environ` 取 |
| `/home/merlin/toiv/api/.env.bak-whisper-cluster-20260921` | whisper 集群切换前的 env 备份 |
| `/home/merlin/beeftv-prod/canvas-api/data/local-model-config.json` | canvas 模型渠道配置（**加密存储**，只能经 `/studio/api/workspace/model-config` API 读写，密钥返回脱敏标记） |

## 渠道凭据现状（2026-10-14 实测）

- **canvas 助手渠道 `toiv-llm`（本地·Spark对话）**：BaseURL=`http://192.168.71.84:8000/v1`（spark02 直连，**免鉴权无过期面**）。⚠️ 历史教训：曾配成 core LLM 代理 `127.0.0.1:8090/api/llm/v1` + 7 天期 ToIV JWT，gate 退役后无人续期 → 静默过期 401。改渠道走 `PUT /studio/api/workspace/model-config`（revision CAS），备份 `local-model-config.json.bak-20261014-llmchannel`。
- **core LLM 代理 `/api/llm/v1`**：需 ToIV JWT（`Authorization: Bearer <登录 token>`）；白名单 env `TOIV_LLM_PROXY_MODELS` 默认 `deepseek-v4-flash-dspark,qwen3.8-27b,qwen3.6-uncensored,glm-5.3-flash`。
- **产物 URL**：已签名 + 归属校验——测试构造 URL 必须带 sig 或先建档；媒体走 `?token=`。
- **H3 service-token**：自动刷新已 enable（exp 2026-10-17 06:20 那批），到期留意一跳。
