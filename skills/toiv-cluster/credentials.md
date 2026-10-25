# 凭据与密钥（指针 · 无明文）

> **2026-10-20 #12**：废止「凭据明文入库」。本文件只记录**落点与键名**，不写口令/Token/连接串。  
> 变更密钥后：**改 core 上的 env/secrets 文件**，不要回写本仓库文档。

## 核心落点（core）

| 用途 | 落点 |
|------|------|
| ToIV admin | `/home/merlin/toiv/deploy/.env` → `TOIV_ADMIN_EMAIL` / `TOIV_ADMIN_PASSWORD` |
| API/JWT/DB | 同上：`TOIV_JWT_SECRET`、`TOIV_DATABASE_URL`、渠道相关 `TOIV_*` |
| 进程内实际值 | `systemctl show toiv-api` → MainPID → `/proc/<pid>/environ`（P-18） |
| canvas 后端 | `/home/merlin/toiv-studio/canvas-api/canvas-api.env`（或文档记载的 canvas-api.env 路径） |
| 吊销列表等 | `/home/merlin/toiv-studio/secrets/`（目录内文件，权限应收紧） |
| 测试账号 | 例：`/home/merlin/toiv/secrets/*.env`（600） |

本地开发：复制 `apps/api/.env.example` / `deploy/.env.example` 为未跟踪的 `.env`，填入自管密钥。

## 登录 API 提醒（无口令）

- `POST /api/auth/login` 字段名是 **`email`**（即使用户名看起来像 admin）
- 响应扁平 `{token, user}`；token 勿提交进 git / issue / 聊天记录

## NAS / 主机凭据

- SMB 用户名/主机/共享名可在运维笔记中保留**非秘密**信息；**口令只存本机 keychain / cmdkey / secrets 文件**
- SSH 用密钥或本机 ssh-agent，勿把私钥或口令写入 skills

## 轮换

见仓库根相对路径：`ALLProject/.archive/toiv-docs-20261026/docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`。

## 渠道凭据

微信等：仅 `TOIV_WECHAT_APPID` / `TOIV_WECHAT_SECRET` 等键名；值只在 `deploy/.env`。空 + bypass 关 = 功能不可用（预期）。
