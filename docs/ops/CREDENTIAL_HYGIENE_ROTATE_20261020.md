# 凭据卫生与生产换密 Runbook（2026-10-20 · 待办#12）

**本文件不含任何口令/Token/连接串。** 只写步骤与键名。

## 已做（工作树文档）

- 从 `AGENTS.md` §二、`skills/toiv-cluster/*`、相关 handoff/报告、`.env.example` 中移除明文弱口令与内联 DB/NAS 口令
- 改为「落点 + 键名」指针；真值只留在 core 未跟踪文件（`deploy/.env`、`secrets/`）
- 回归：`scripts/release/test_cred_hygiene.py` 禁止跟踪文档再出现已知弱默认字面量

## 生产换密（admin）— 本刀未执行

**原因**：`bootstrap_admin()` 在 **toiv-api 启动时**用 `TOIV_ADMIN_PASSWORD` 重哈希管理员密码。改密 = 改 env + **重启 toiv-api**。  
生成窗 / 烟测 `running>0` 时禁重启（AGENTS §〇、P-25、`deploy/deploy_drain.py`）。本刀不探测生产库、不重启。

### 安全窗口内操作步骤（运维在 core 上执行）

1. `deploy/deploy_drain.py --probe-local` 须 clear（或业务确认无在飞作业）
2. 在 **core** 编辑未跟踪文件 `/home/merlin/toiv/deploy/.env`：
   - 设置强随机 `TOIV_ADMIN_PASSWORD=…`（用本机密码器生成；**不要**贴进聊天/git）
   - 可选：备份旧文件为同目录 `deploy/.env.bak-YYYYMMDD`（权限 600；**不要** rsync 进公开仓）
3. 仅当 drain clear：`sudo systemctl restart toiv-api`（或经 `deploy/deploy.sh` 且勿设 `FORCE_API_RESTART` 绕过）
4. 验证：`POST /api/auth/login`，body 字段 **`email`** + 新口令；确认旧口令失败
5. 更新本机 ssh/ops 笔记或 password manager——**仍不写回 AGENTS/skills**
6. 若曾把旧口令发给过他人：视作已泄露，换密后检查异常登录（audit 日志）

### PG / NAS / JWT

| 密钥 | 换密注意 |
|------|----------|
| PG（`TOIV_DATABASE_URL`） | 改角色口令 + 同步 env + 重启 api；先确认无长事务 |
| NAS SMB | 改 NAS 侧口令 + 更新 fstab/cmdkey/secrets；**勿**写回 md |
| `TOIV_JWT_SECRET` | 轮换会使既有 JWT 全部失效（全员重新登录） |

## 公开 GitHub 暴露面

历史 commit / 已推送的 `AGENTS.md`、`skills/toiv-cluster/credentials.md` 可能仍含旧明文。  
**本刀不 push**。需用户批准后：推送脱敏提交；必要时另开「历史脱敏 / secret scanning」项（`git filter-repo` 或 GitHub secret scanning 失效流程）。

## 相关代码锚点

- `apps/api/app/db.py` → `bootstrap_admin()`（env 密码在每次启动写回哈希）
- `apps/api/app/config.py` → `admin_email` / `admin_password`
- `deploy/deploy_drain.py` → api 重启前排水
