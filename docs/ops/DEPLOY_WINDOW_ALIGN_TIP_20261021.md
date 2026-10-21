# 部署窗方案：本机 tip 对齐 toiv.wineryz.top / core

> # 本文仅方案；未经用户批准不得执行任何部署/重启
>
> 起草日：2026-10-21（Asia/Shanghai）  
> 分支：`work/p0-fusion-20261016`  
> 本机 tip：`75da6dee`（完整：`75da6dee80d18bdfc04f1f09b45abc8f3daffcb6`）  
> 线上约：`44043682-dirty`（约 2026-10-17；相对 tip 落后 ~29 commits）  
> 本窗目标优先级：**感知/功能可用**；安全换密见文末「可选附录」，**不进主路径**。

---

## 1. 目标

把本机 tip（审计 #1–#12 四批 + 感知波：超时仍在跑 / 设定卡失败态 / 市场高级·更深参数 / 烟测徽章未验证·慢链）以**干净、无 `-dirty`** 的方式对齐到：

| 面 | 目标 |
|----|------|
| 公网入口 | `https://toiv.wineryz.top`（beijing → core） |
| 业务机 | core（`192.168.71.47` / TS `100.77.80.100`）上 `toiv-api` / `toiv-web` /（可选）`toiv-admin` / canvas（`canvas-api-pg` + `/studio` dist） |
| 指纹 | 线上 web `BUILD_ID` 短 sha == tip 短 sha，**不含 `-dirty`** |

**成功画面**：用户打开 wineryz 能用到本机已 commit 的感知修复；`BUSY=0` 窗内完成；可一键 `--rollback`。

---

## 2. 现状快照（起草时口径；执行前须重核）

| 项 | 值 |
|----|-----|
| 本机分支 | `work/p0-fusion-20261016`（无 upstream；相对 `github/main` 仍超前） |
| 本机 tip | `75da6dee`（工作区起草前应干净；执行前再 `git status`） |
| 线上 BUILD | 约 `44043682-dirty`（10-17 dirty 构建习惯；与 tip 差 ~29 commits） |
| 核验时 BUSY | `BUSY=0`（**执行前必须再 probe**；非零禁重启 api） |
| remotes | `origin`=Gitee；`github`=GitHub；**deploy 主路径是本机 rsync，不依赖先 push** |
| 涉及单元 | `toiv-api`(:8090)、`toiv-web`(:3100)、`toiv-admin`(:3200，可选)、`canvas-api-pg`(:8290) + `/studio` SPA |
| 算力 | workstation 不随本窗换码；仅保证池可达 |
| 感知依赖面 | **api + canvas/web 必动**；`apps/web` 含 `friendlyError`/`trackJob` 超时文案，建议同窗；admin 与感知弱相关，默认可后置 |

相对 `44043682..75da6dee` 主要产品面：`apps/api`（设定卡失败 UX、徽章文案、市场 deep knobs、drain 相关）、`apps/canvas/web`（超时/市场/移动壳/R18）、`apps/web`（超时文案）、`deploy/deploy_drain.py` + `scripts/release/*`（发版闸）。

---

## 3. 前置条件（GO 前 checklist）

1. **工作区干净**：`git status` 无未提交改动（含本方案文档：要么先 commit 进 tip，要么 `git stash` / 暂不入库——**脏树会让 web BUILD_ID 带 `-dirty`，deploy 硬拒**）。
2. **本机 tip 仍是要对齐的 tip**：`git rev-parse --short HEAD` → 期望 `75da6dee`（若已有新 commit，以新 tip 为准并改本窗验收串）。
3. **预检通过**：
   ```bash
   ./scripts/release/preflight.sh
   # 内部：build_id_gate --assert-clean-tree；若已有 .next/BUILD_ID 则校验无 dirty 且 sha==HEAD
   ```
4. **干净重建 web**（推前端时强制）：
   ```bash
   cd apps/web && rm -rf .next && npm run build
   cat .next/BUILD_ID   # 必须形如 YYYYMMDD-HHmmss-<短sha>，禁止 -dirty
   cd ../.. && ./scripts/release/preflight.sh
   ```
   - 禁止：`ALLOW_DIRTY_WEB`（脚本无此旁路）、脏树强推。
   - `ALLOW_STALE_WEB=1` **只**绕过「sha≠HEAD 的旧包」，**绝不**绕过 dirty。
5. **drain clear**（重启 `toiv-api` 前）：
   ```bash
   # 在 core 上（或经 ssh core / core-ts / core-jump）：
   /home/merlin/toiv/api/.venv/bin/python /home/merlin/toiv/deploy/deploy_drain.py --probe-local
   # 期望：OK: deploy drain clear …
   ```
   - 首次把新 `deploy_drain.py` 送上 core 之前，远端可能仍只有旧 pgrep；**本窗第一次完整 rsync `deploy/` 后**以新 drain 为准。
   - **禁止**默认使用 `FORCE_API_RESTART=1`（会跳过 drain、误杀在飞 Job）。
6. **SSH 目标选定**（执行前拍板，见 §决策点）：
   - 家宽 LAN：`core` 或 `core-lan`
   - 外地 TS：`core-ts` 或 AGENTS 口径 `core-jump`（经 workstation 双跳）
7. **传码方式拍板**（见 §决策点 A）：默认 **本机 rsync（`deploy/deploy.sh`）**，**不要求**先 push Gitee/GitHub。

### 3.1 传码选项（部署前需你批准其一）

| 选项 | 做法 | 适用 | 注意 |
|------|------|------|------|
| **A. 本机 rsync（推荐）** | Mac tip 直接 `deploy/deploy.sh …` → rsync `apps/api`/`web`/`deploy`（及 canvas）到 `/home/merlin/toiv` | 与现行脚本一致；用户「仍不 push」时可对齐线上 | 不更新 remote 历史；core 工作树 ≠ git pull 结果 |
| **B. 先 push 再在 core pull** | 批准后 `git push origin` 和/或 `github`，core `git pull` 再重启 | 要双远程审计史时 | **当前 core 部署树 historically 靠 rsync**；改 pull 须另验路径/忽略规则；本窗不默认 |
| **C. 混合** | 感知相关先 A；事后另窗批准 push 备份 tip | 学习站先可用、史后补 | push 仍须单独一句话批准 |

> ALLProject 口径：双远程（Gitee `origin` + GitHub `github`）。**本窗「对齐线上体验」与「推远程备份」解耦**——对齐用 A 即可。

---

## 4. 推荐步骤（编号；批准 GO 后才执行）

### 阶段 0 — 预检（本机，可逆）

1. `git status -sb` && `git rev-parse HEAD` → 记录 tip。
2. `./scripts/release/preflight.sh`。
3. `cd apps/web && rm -rf .next && npm run build && cat .next/BUILD_ID` → 确认无 `-dirty`、短 sha==HEAD。
4. 再跑一次 `./scripts/release/preflight.sh`。
5. （可选）本机单测快烟：  
   `python3 -m pytest scripts/release/test_build_id_gate.py scripts/release/test_deploy_drain.py -q`

### 阶段 1 — 部署窗核验（远端只读）

6. 公网：`curl -sS -o /dev/null -w '%{http_code}\n' https://toiv.wineryz.top/` 期望 200。
7. core 健康：  
   `ssh <REMOTE> 'curl -sS http://127.0.0.1:8090/api/health; curl -sS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3100/'`
8. **drain probe**（busy → **停**，改约窗或等 running=0）：  
   `ssh <REMOTE> '/home/merlin/toiv/api/.venv/bin/python /home/merlin/toiv/deploy/deploy_drain.py --probe-local'`  
   - 若远端尚无新脚本：可先只读 `systemctl is-active toiv-api toiv-web` + 人工确认无生成窗，或先用「仅 rsync deploy/」小步（仍不重启）再 probe；**绝不**用 FORCE 开路。
9. 记录当前线上 BUILD（回滚对照）：  
   `ssh <REMOTE> 'cat /home/merlin/toiv/web/.next/BUILD_ID 2>/dev/null; systemctl show -p ActiveEnterTimestamp toiv-api toiv-web'`

### 阶段 2 — 构建与切换顺序（推荐「感知一次齐」）

> 原则：先快照（`deploy.sh` 自动写 `.rollback-previous`）→ 再换码 → api 重启前再 drain → 先 api 健康再 web → canvas 换装。

**推荐命令（选项 A + 含 canvas + 含 web）**：

10. 选定范围（三选一，**GO 时写死**）：
    - **R1 感知全齐（推荐）**：`deploy/deploy.sh --all <REMOTE>`  
      ≡ api + web(.next) + canvas；一次对齐市场/设定卡/超时/徽章。
    - **R2 先保 api 烟测、前端分刀**：  
      ① `DEPLOY_DRAIN_WAIT_SEC=120 deploy/deploy.sh --skip-web <REMOTE>`（只 api+deploy，不碰 web）  
      ② `deploy/deploy.sh --canvas-only <REMOTE>`  
      ③ `deploy/deploy.sh --web-only <REMOTE>`（需本地已有干净 `.next`）
    - **R3 只动前端壳（不推荐本窗）**：`--web-only` —— **拿不到**设定卡失败回传 / 市场 deep knobs / 徽章后端文案，感知残缺。

11. 执行时环境纪律：
    - **不要**设 `FORCE_API_RESTART=1`
    - 忙时可设 `DEPLOY_DRAIN_WAIT_SEC=120`（busy 则轮询最多 120s，仍 busy 则 exit 3）
    - **不要**改 `deploy/.env`（rsync 本就排除 `.env*`）
    - web 构建勿带本地 `INTERNAL_API_BASE=…:8200`（脚本会扫 `routes-manifest.json` 拦 8200 误推）

12. `deploy.sh` 内实际顺序（R1/`--all` 时，摘自脚本）：
    1. `assert_web_build_matches_head`（拒 dirty / sha≠HEAD）
    2. 远端 `cp -al` → `.rollback-previous/{api-app,web-next,…}`
    3. rsync `apps/api/`、`apps/web/`、`deploy/`（及 `--with-canvas` 时 `apps/canvas/`）
    4. rsync 本地 `apps/web/.next/`（排除 cache）
    5. `remote_restart toiv-api` → **先 `assert_api_drain`** → `systemctl restart` → 等 `http://localhost:8090/api/health`
    6. `remote_restart toiv-web` → 等 `http://localhost:3100`
    7. canvas：core 本机 Go 构建 `canvas-api-pg` 换装 + vite `/studio` dist → 等 `:8290/api/health/live`

13. **admin（默认本窗不做）**：若批准，另跑 `bash deploy/deploy-admin.sh <REMOTE>`（core 本机 `npm install` + `npm run build` + restart `toiv-admin`）。与感知主路径无关。

### 阶段 3 — 冒烟清单（公网 + LAN）

14. **指纹**：`ssh <REMOTE> 'cat /home/merlin/toiv/web/.next/BUILD_ID'` → 短 sha == tip，无 `-dirty`。  
    浏览器：硬刷新（Cmd/Ctrl+Shift+R）避免 Server Action / 旧 chunk 对不上。
15. **health**：`/api/health` 200；wineryz `/` 200；登录壳可开。
16. **超时感知**：任一代答/生成入口人为缩短等待或断网模拟客户端超时 → 文案含「仍在后台跑」+「任务中心」链路（`/toiv/tasks`），**不**整页红失败当作业已死。
17. **市场徽章**：打开市场卡列表 → 原 timeout 烟测卡显示 **「未验证（慢链）」或「慢链」**，不再裸英文 `timeout`；真 fail 仍为失败色。
18. **市场抽屉**：任选 H3/LTX 类卡 →「常用高级」可折叠；更深参数区可见 LoRA/超分（视 schema）；跑一次短参数确认 `/run` 仍 2xx（不必出片）。
19. **设定卡失败态**（有角色项目时）：触达门禁失败或用已知会警告的图 → 抽屉见人话原因 + 拒图预览 +「再生成」；可选点「仍保留此图（仅警告）」→ 工作区有琥珀警告态。
20. **回归底线**：未登录访问 `/studio/*` 仍回登录/首页（预期）；`toiv-api`/`toiv-web` active；drain 再 probe 一次应为 clear（若刚跑完作业则等结束）。

### 阶段 4 — 回滚

21. 若冒烟失败且快照仍在：
    ```bash
    deploy/deploy.sh --rollback <REMOTE>
    ```
    恢复 `.rollback-previous` 的 `api-app`、`web-next`、以及 canvas 的 bin/dist/plugins/env（若本窗动过 canvas），并再次走 drain + 健康等待。
22. 回滚后核验 BUILD_ID 回到旧值、health 200。  
23. **注意**：回滚**不会**自动撤销 DB 数据变更；本窗主路径无 alembic upgrade / 删表，风险低。若有人在窗内手工改了 DB，回滚码≠回滚数据。

---

## 5. 风险与回滚

| 风险 | 表现 | 缓解 |
|------|------|------|
| **Server Action / chunk mismatch** | web 今日日志曾现；换 BUILD 后旧标签页报错 | 冒烟强制硬刷新；必要时只重启 `toiv-web` 再验 |
| **`-dirty` 构建误推** | 历史线上已是 dirty；新闸会拒 | 干净树 + `preflight` + `assert_web_build_matches_head`；无 dirty 旁路 |
| **误杀在飞作业** | 旧事故：api 重启标 error | `deploy_drain.py`；`running>0` / busy → 停；禁默认 FORCE |
| **drain 脚本尚未上远端** | 第一次完整部署前只有旧 pgrep | 本窗 rsync `deploy/` 后以新 drain 为准；busy 时 fail-closed |
| **本地 8200 验证包误推** | `/api` 全 500 | 脚本扫 routes-manifest；务必用生产默认 build |
| **canvas 换装 Text file busy** | 运行中覆盖二进制失败 | 脚本已 stop → mv → start；失败走 `--rollback` |
| **外地 TS 传 .next 极慢** | AGENTS：Mac 外地不宜传 .next | 在家 LAN 用本机 `.next`；外地改：源码 rsync + **core 本机** `pnpm/npm build`（须在 GO 时改步骤 3/10） |
| **只更 web 不更 api** | 感知半残（徽章/设定卡回传仍旧） | 本窗默认 R1/R2，避免 R3 |
| **workspace 有未提交方案 md** | 一 build 即 dirty | GO 前先处理本文件：commit / stash / 移出树 |

---

## 6. 明确不在本窗

| 不做 | 说明 |
|------|------|
| 生产换密 / 改 `deploy/.env` | 见可选附录；主路径零碰 secrets |
| Drama 删表、alembic stamp / upgrade 生产 | 另战役 |
| 修复 `toiv.dgmt.top` / 香港 frp | 另窗 |
| JWT / PG / NAS 凭据轮换 | 另窗 |
| `FORCE_API_RESTART=1` 开路 | 除非你书面批准且知情会杀作业 |
| 默认 `git push` origin/github | 除非决策点 A 选 B/C 并另批一句 |
| 打 tag / 改 `apps/canvas/VERSION` | 现 `v1.7.8`；本窗不对齐版本号叙事 |
| workstation 算力栈升级、Comfy 舰队重启 | 本窗只 core 业务面 |
| 移动触控战役 / 小程序提审 | 非本窗 |

---

## 7. 验收标准

- [ ] 线上 `web/.next/BUILD_ID` 短 sha == 本窗 tip 短 sha，**无 `-dirty`**
- [ ] `toiv-api` / `toiv-web`（及若部署则 `canvas-api-pg`）active；`/api/health` 与 wineryz `/` 可用
- [ ] 冒烟 §阶段 3：超时文案、市场徽章、市场高级/更深参数、设定卡失败抽屉（条件允许时）至少抽测通过
- [ ] 部署过程未使用 `FORCE_API_RESTART`；若曾 busy 则已等待至 clear 而非强行
- [ ] 失败时可 `deploy/deploy.sh --rollback <REMOTE>` 回到窗前快照并恢复 health

---

## 8. 你需要拍板的决策点（GO 前回复即可）

1. **传码方式**：A 本机 rsync（推荐，仍可不 push） / B 先 push 双远程再 pull / C 先 A 后另窗 push？  
2. **范围**：R1 `--all`（api+web+canvas，推荐） / R2 分刀 skip-web → canvas-only → web-only / R3 仅 web-only（不推荐）？  
3. **SSH 目标与 admin**：`core` / `core-ts` / `core-jump`？本窗是否附带 `deploy-admin.sh`（默认否）？

**示例批准句**：  
「GO 部署：决策 A + R1 + REMOTE=core；不 push；不换密；不 FORCE。」

---

## 附录 A — 可选：换密（非主路径）

仅当你改口要做安全底线时参考；**默认跳过**。

- 真源：`docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`
- 顺序建议：drain clear → 改 core `deploy/.env` 中 admin 口令 → `systemctl restart toiv-api`（再经 drain）→ 验旧口令失败、新口令可登录  
- **不要**与感知对齐绑在同一 GO 句里，除非你显式写上。

## 附录 B — 关键脚本速查

| 脚本/文件 | 用途 |
|-----------|------|
| `./scripts/release/preflight.sh` | 干净树 + BUILD_ID 预检 |
| `scripts/release/build_id_gate.py` | 拒 `-dirty`；可选 `--require-head` |
| `deploy/deploy_drain.py --probe-local` | api 重启前忙因（exit 3=busy） |
| `deploy/deploy.sh` | rsync + 快照 + drain + 重启 |
| `deploy/deploy.sh --web-only` / `--skip-web` / `--canvas-only` / `--all` / `--rollback` | 范围与回滚 |
| `DEPLOY_DRAIN_WAIT_SEC` / `FORCE_API_RESTART` / `ALLOW_STALE_WEB` | 等待 / 危险强启 / 仅旧 sha |
| `deploy/deploy-admin.sh` | admin 本机构建（可选） |
| `docs/ops/DEPLOY_DRAIN_STUDIO_20261020.md` | drain 覆盖说明 |
| `docs/ops/RELEASE_AUTOMATION_P2_20261020.md` | dirty 闸与发版手工路径 |

## 附录 C — 本窗相关 tip 提交（便于对照）

| hash | 摘要 |
|------|------|
| `9b186967` | dirty-build 闸 + deploy drain |
| `e0ad0a7e` | api 审计切片（含文件 IDOR 等） |
| `68662984` | R18 + 市场壳 + mobile |
| `31110f0b` | 超时仍在跑 + 徽章未验证/慢链 |
| `df685f0b` | 设定卡失败态 |
| `cf9178d2` | 市场常用高级 + LoRA/超分 |
| `75da6dee` | TEST_LOG 感知波收口（当前 tip） |

---

*起草完成。等待用户按 §8 拍板后再执行；在此之前禁止 deploy / restart / push / 改生产 .env。*
