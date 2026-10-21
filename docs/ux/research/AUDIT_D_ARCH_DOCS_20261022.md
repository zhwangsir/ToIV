# AUDIT D — 架构 / 文档漂移 / 安全卫生（全栈 D 路）

> 日期：2026-10-22（Asia/Shanghai）  
> tip：`e5307c63` · 分支 `work/p0-fusion-20261016`  
> 执行者：Grok Bot D 路 · **禁止业务编码 / commit / push / 部署**  
> 用户优先级：功能可用 + 感知；**安全换密 / push / 上线暂缓** —— 凡 REPLACE 建议标「可延后」  
> 范围：API 模块边界与单体膨胀、alembic/迁移、jobs/IDOR、安全与凭据、deploy/BUILD_ID、文档漂移、third_party 许可与并码、DRT/遗留去留、timeout #13（仅建议）、测试/CI 缺口

---

## 0. 摘要（接棒 30 秒）

| 维度 | 结论 |
|------|------|
| API 单体 | **OPTIMIZE**：routes 83 文件 / ~42k 行；`drama_studio.py` 5708、`apps.py` 4899、`studio.py` 3388；`character_sheet` 已拆包但 `_impl.py` 仍 4992 |
| alembic | **KEEP 脚手架 + OPTIMIZE 切流叙事**：baseline noop、未接 `init_db`；生产仍双轨 `create_all`+手写幂等；**禁止 stamp/upgrade 生产（可延后）** |
| jobs/IDOR | **KEEP**：jobs 多处 `user_id` 过滤；专用 IDOR 测（studio/scope/orch/images）已有；继续按文件面补测即可 |
| 凭据卫生 | **OPTIMIZE 文档已脱敏；REPLACE 生产换密可延后**：#12 runbook 在、CI `test_cred_hygiene` 在；admin 换密需重启 api |
| BUILD_ID | **KEEP**：`deploy.sh` + `build_id_gate` + CI `release-gate` 硬闸 `-dirty` |
| 文档漂移 | **必须修 md（见 §6）**：产品方案 §8 仍写默认 `c`；`SERVICE_INVENTORY`(09-13) 与 AGENTS(10-15) 端口/IndexTTS 冲突 |
| third_party | **KEEP 现状策略**：源树 gitignore；MIT 已并码；hypit 单租户；dramaclaw Elastic **勿 SaaS 并码** |
| DRT/OpenClaw | **OPTIMIZE/决策债**：DRT 12+LiveKit 去留未拍板；OpenClaw 网关上游断但 Whisper 仍用 01 |
| #13 timeout | **OPTIMIZE 建议不实施**：假 timeout 归因改码列入「不纳入本轮」；先文档化分级口径 |
| CI | **KEEP 主闸 + OPTIMIZE 缺口**：api pytest + dogfood_ci + web tsc + canvas go/web + release-gate；web 无 unit test 脚本；canvas Playwright 未平移 |

**计数**：KEEP **11** · OPTIMIZE **14** · REPLACE **5**（其中 **4 可延后**）  
**必须修文档债**：**7** 篇（Top5 见文末报告）

---

## 1. API 模块边界与单体膨胀

### 1.1 体量事实（tip）

| 指标 | 值 |
|------|-----|
| `apps/api/app/**/*.py` | **326** 文件 / **~116k** 行（含 __pycache__ 外源） |
| `apps/api/app/routes/*.py` | **83** 文件 / **~41,958** 行 |
| Top routes | `drama_studio.py` **5708** · `apps.py` **4899** · `studio.py` **3388** · `generate.py` 1402 · `jobs.py` 1341 |
| `character_sheet/` | 包已拆（constants/gates/layout/templates/retry/ux/_impl）；合计 **9885** 行；**`_impl.py` 4992** 仍为上帝模块 |
| `db.py` / `models.py` | 892 / 1056；迁移三元组 `_SQLITE_*` 仍堆在 `db.py` |
| `main.py` | 动态 `include_router(..., prefix="/api")`；路由面大但注册模式统一 |

### 1.2 KEEP / OPTIMIZE / REPLACE

| 项 | 裁决 | 说明 | 优先级 |
|----|------|------|--------|
| routes 按域拆文件（已有 83） | **KEEP** | 域文件已在；问题是**超大单文件**而非「全塞一个 routes.py」 | — |
| `character_sheet` 包结构 + `test_character_sheet_package_split` | **KEEP** | 待办 #6 拆包烟测在；公开 re-export 契约保住 | — |
| `_impl.py` 4992 继续切（compose/gen/inpaint/queue） | **OPTIMIZE** | 不影响可用；降 CR 成本；**不挡短剧感知** | P3 |
| `drama_studio.py` 5708 按资源切（projects/shots/voice/lipsync/assemble） | **OPTIMIZE** | 纯搬迁+测绿；与 UX 阶段轨并行友好 | P2–P3 |
| `apps.py` 4899（市场/_build_graph/烟测） | **OPTIMIZE** | 与短剧主路径弱耦合；可后置 | 可延后 |
| 微服务拆分 api | **REPLACE（可延后）** | 单机网关+远程 Comfy 已是正确边界；拆服务增加运维，**不符「可用优先」** | 可延后 / 不建议近窗 |

---

## 2. Alembic / 迁移双轨

### 2.1 事实

- `alembic.ini` 自评：**脚手架（待办 #5）**；切流前 `init_db` 双轨仍是启动路径；**禁止对生产直接 `alembic upgrade`**。
- `alembic/versions/`：**仅** `20261018_0001_baseline.py`（noop 策略见 `tmp/alembic_cutover_plan_20261018.md`）。
- `apps/api/migrations/drama_analytics.sql`：旁路 SQL，非启动必跑。
- 启动：`main.py` → `init_db()` → `SQLModel.metadata.create_all` + `_SQLITE_RAW/_SQLITE_MIGRATIONS/_SQLITE_POST` 幂等吞异常。

### 2.2 表

| 项 | 裁决 | 说明 |
|----|------|------|
| Alembic 脚手架 + baseline noop + cutover 文档 | **KEEP** | 方向正确；勿删 |
| 生产继续双轨至显式批准 | **KEEP** | 与用户「不上线/不冒险」一致 |
| 新列继续堆 `_SQLITE_MIGRATIONS` | **OPTIMIZE** | 热修可；中期应只加 alembic revision（切流后） |
| 生产 `stamp head` / `upgrade` / Drama 删表 | **REPLACE（可延后）** | COMMIT 方案明文「不纳入」；需独立批准窗 |
| 把 `tmp/alembic_cutover_plan` 升格进 `docs/` | **OPTIMIZE** | 现挂 `tmp/`（ignore 风险）；升格防丢 | 

---

## 3. Jobs / IDOR / 授权

### 3.1 事实

- `routes/jobs.py`：列表/详情/删除/回收站普遍 `Job.user_id == user.id`；admin 旁路显式。
- P-1 纪律（AGENTS）：产物 URL 签名 + 归属；媒体 `?token=`。
- 测试资产厚：`test_studio_files_idor.py`、`test_scope_orch_files_idor.py`、`test_images_range.py`（IDOR）、`test_jobs_bulk_delete` ownership、`test_safety` undo other user、drama/boards/entities/agent_team 多处 `other_user_404`。
- 粗扫：无「多路由文件完全零 Depends」的可疑面（启发式）。

### 3.2 表

| 项 | 裁决 | 说明 |
|----|------|------|
| Job 属主过滤 + admin 例外 | **KEEP** | 主路径健全 |
| 文件面 IDOR 测（studio/scope/orch/images） | **KEEP** | 波次 A W3 已落 |
| 新文件路由强制「测或 sig」清单 | **OPTIMIZE** | 防回归；加进 CR checklist 即可 |
| 全库自动化 IDOR fuzzer | **REPLACE（可延后）** | 收益/成本对单租户学习站偏低 |

---

## 4. 安全与凭据卫生

### 4.1 已有能力

| 组件 | 状态 |
|------|------|
| `security.py` JWT/密码哈希 | 精简可用 |
| `deps.get_current_user` / admin | 统一入口 |
| `pathsafe.py` / `token_policy.py` | 路径与 token 策略 |
| `ratelimit.py` | 登录/生成/上传等滑动窗口；Redis 优先 |
| CORS 精确 origins + credentials | `main.py` |
| #12 文档脱敏 + `test_cred_hygiene.py` + CI release-gate | **已接线** |
| `deploy/.env` / `.auth/` | **gitignore**；示例仅 `.env.example` |
| H3 scoped service-token + 6h refresh timer | canvas deploy 侧；AGENTS 勾「exp 2026-10-17」需运维确认是否已滚 |

### 4.2 表

| 项 | 裁决 | 说明 |
|----|------|------|
| 文档去弱口令字面量 + CI 禁回归 | **KEEP** | |
| 生产 `TOIV_ADMIN_PASSWORD` 换密 | **REPLACE（可延后）** | 需 drain clear + **重启 toiv-api**；runbook 已写，**本窗不做** |
| JWT/PG/NAS 轮换 | **REPLACE（可延后）** | 同上；JWT 轮换踢全员 |
| 历史 commit 秘密扫描 / filter-repo | **REPLACE（可延后）** | 仅在批准 push 脱敏后考虑 |
| H3 token 自动刷新是否仍健康 | **OPTIMIZE** | 只读核 `status.json` / timer；不改密 |

---

## 5. Deploy / BUILD_ID

| 项 | 裁决 | 说明 |
|----|------|------|
| `build_id_gate.py` 拒 `-dirty`；`deploy.sh` sha==HEAD | **KEEP** | P-2 硬纪律 |
| CI `release-gate`（gate + drain + cred hygiene） | **KEEP** | 与路径变更无关常驻 |
| `ALLOW_STALE_WEB=1` / `ALLOW_DIRTY_WEB` | **KEEP（危险阀）** | 文档已警告；勿当日常 |
| 发版窗方案 `DEPLOY_WINDOW_ALIGN_TIP_20261021.md` | **KEEP** | 对齐 tip 指纹流程完整 |
| 本窗执行 deploy | **不做** | 用户暂缓上线 |

---

## 6. 文档漂移（产品方案 vs tip · INVENTORY vs AGENTS）

### 6.1 硬冲突（必须修）

| # | 文档 | 过时断言 | tip / AGENTS 实况 | 动作 |
|---|------|----------|-------------------|------|
| D1 | `docs/AI短剧产品方案.md` §（代码现状）+ §8 第1项 | 「默认仍是 `c`」「尚未做 Ref2VA 独立默认」 | `pipelines.py`：`DEFAULT_VIDEO_PIPELINE = INDEP_PIPELINE = "ref2va"`；`orchestrator` 用该默认；`test_ref2va_indep_pipeline.py` 断言 | **修订文档**：标明 tip 已切；待办改为「核对生产=tip + UI 暴露管线」 |
| D2 | `docs/SERVICE_INVENTORY.md`（采集 **2026-09-13**） | H3 主行仍写 **:8195**；遗留表把 indextts/vlm 当 disable 债 | AGENTS：**H3 生产 :8264**；**:8195 stop+disable**；**IndexTTS :9200 配音主路勿停**；VLM :9311 | **修订或加「2026-10-15 勘误」章**；勿删历史采集，但首页必须警告勿盲抄 |
| D3 | 同 INVENTORY §⑥ OpenClaw | 「上游已断待决策」且验收 :18789 | AGENTS：openclaw 仍承担 Whisper；01 可达、02–04 TS 问题 | **分写**：网关 LLM vs ASR 集群；对齐 EVOLUTION/BUG P2-5 |
| D4 | `docs/COMMIT_BATCH_PLAN.md`（09-13） | 旧脏树批次 | 现行以 `docs/ops/COMMIT_BATCH_PLAN_20261021.md` 为准 | **文首加废弃横幅**指向 10-21 |
| D5 | `docs/HARDBLOCKED_WHITEPAPER.md`（09-14） | 「终版」公开 550 口径 | 市场与 smoke 基数已剧变（TECH_STACK 日志万级） | **标历史档案**；活口径改指 admin/TECH_STACK 或 STATE |
| D6 | `tmp/alembic_cutover_plan_20261018.md` | 切流真源在 tmp | tmp 可被清 | **升格** `docs/ops/ALEMBIC_CUTOVER_PLAN_20261018.md` |
| D7 | AGENTS 待办 H3 token exp 10-17 | 勾选仍开 | 若 timer 已跑应核销或改「持续监控」 | **核销或改写状态**（只读确认后） |

### 6.2 次要漂移（OPTIMIZE）

- NAS 体量：INVENTORY 旧「260G」vs AGENTS「主库 ≈5.2T」——勘误章一并改。  
- DRT 在 MIGRATION_PLAYBOOK 仍进启动序 ⑤——与「去留未拍板」并列时读者会以为必拉起。  
- 能力地图 `TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md` 已正确声明「9 月表仅历史」——**总方案/INVENTORY 应交叉链接该声明**。

---

## 7. third_party 融合与许可

### 7.1 许可表（README 2026-10-15，与 licenses/ 原文一致）

| 源 | 许可 | 并码策略 | 裁决 |
|----|------|----------|------|
| video-use | MIT | 已并：`edit_*`、`media/*`、`qa/timeline_view` 等，保留版权注释 | **KEEP 继续按需并码** |
| toonflow | MIT | 设计采纳为主；`toonflow_board` 模板钩子已在 schemas | **KEEP**；三视图模板未并 → 可选 OPTIMIZE |
| hypit | 修改版 Apache（禁多租户 SaaS） | SVML / plan_build_get / project_memory；单租户自用 | **KEEP**；若未来 SaaS → **REPLACE 实现（可延后）** |
| dramaclaw | Elastic-2.0（+部分 Apache） | 设计采纳优先；NOTICE 必留；**禁止作第三方托管** | **KEEP 设计**；大块并码 **OPTIMIZE 慎用**；对外 SaaS **REPLACE（可延后）** |
| ChatCut GPL / OpenMontage AGPL | — | AGENTS 红线：只读不抄 | **KEEP 红线** |
| 源码树 `third_party/{dramaclaw,toonflow,hypit,video-use}/` | gitignore | 仅 README+licenses 入仓 | **KEEP**（防许可/体积事故） |

### 7.2 是否继续并码

- **值得继续（MIT）**：video-use 剪规/自评边角；toonflow 门控文案/三视图若服务短剧阶段轨。  
- **设计优先不强并**：dramaclaw 锚点/blocking（已有 orchestrator P4 注释钩子）。  
- **停止并码触发器**：任何「多租户公网 SaaS」产品决策 → 先剥离 Elastic/改 hypit 面。

---

## 8. DRT / 遗留服务去留

| 资产 | 现状 | 裁决 |
|------|------|------|
| core DRT 12 容器（web/api/caddy/loki/grafana/prom/minio/pg/redis…） | INVENTORY/BUG P2-6：**去留未拍板** | **决策债**；迁移手册仍备份其卷。**KEEP 运行若仍占用端口但无 ToIV 硬依赖 → OPTIMIZE 隔离文档**；关停 **REPLACE（可延后，需负责人）** |
| spark02 DRT LiveKit×3 | 同上未拍板未停 | 同左 |
| OpenClaw :18789 网关 | 上游 LLM 断 | **REPLACE 网关角色（可延后）**；**KEEP Whisper/JoyCaption 节点职能**（换入口名勿断 ASR） |
| WS 大量 disable legacy units（含旧名 indextts/vlm…） | INVENTORY 警告「可不搬」 | **KEEP 不复活**；清理 unit 文件 **OPTIMIZE 可延后**（防与**现行** `toiv-indextts` 命名混淆——文档必须区分） |
| `TOIV_OPENTALKING_ENABLED=false` | AGENTS 已落 | **KEEP** |

---

## 9. Timeout 口径（#13）— 仅调研建议，不实施

### 9.1 问题陈述

- 烟测/战役侧：900s（及部分 1800s）客户端超时，把 **SEEDVR2 等长 CPU 阶段真作业**打成 **假 timeout**（TECH_STACK #19；AGENTS W8：368 条需重估）。  
- 已有部分缓解叙事：家族升到 2400s、客户端超时后 90s 回读 PG 真值（exec log）。  
- `COMMIT_BATCH_PLAN_20261021`：**明确不纳入**「#13 假 timeout 归因改码」。

### 9.2 建议（不改码）

| 建议 | 类型 |
|------|------|
| 文档固化：timeout ≠ product fail；徽章「未验证（慢链）」已在发版窗清单 | **OPTIMIZE 文档** |
| 归因脚本离线重标 368 条（只读 PG）再决定是否改 poll | **OPTIMIZE 分析** |
| 改 `timeout_s` / 驱动分级代码 | **REPLACE 改码（可延后）** —— 遵 #13 不实施 |
| 与短剧主链关系 | 弱；**不挡** P1–P3 感知 |

---

## 10. 测试 / CI 缺口

### 10.1 现状

| 闸 | 内容 |
|----|------|
| `.github/workflows/ci.yml` | paths-filter：api pytest（最小依赖集）+ `dogfood_ci` 标记；web `tsc --noEmit`；**release-gate** 常驻 |
| `canvas.yml` | Go vet/test + web lint/typecheck/build；**Playwright 未平移** |
| 本地 api tests | **~360** 文件；基线叙事历史「4393 全绿」类（以 STATE/TEST_LOG 为准） |
| web | `tests/` ~38 + `e2e/` ~34；package.json **无 test 脚本**（CI 只 tsc） |

### 10.2 表

| 项 | 裁决 |
|----|------|
| api CI + dogfood_ci + release-gate | **KEEP** |
| canvas Go/web build 闸 | **KEEP** |
| web CI 补 `npm test` / vitest 子集 | **OPTIMIZE**（感知向组件测） |
| canvas Playwright 搬回 CI | **OPTIMIZE（可延后）** |
| 真机 nightly dogfood（审计挂账） | **OPTIMIZE** — 学习站价值高，但属运维窗 |
| CI 装全量 requirements | **REPLACE 不建议** — 有意最小集 |

---

## 11. 总表（KEEP / OPTIMIZE / REPLACE）

### KEEP（11）

1. 多文件 routes 域划分 + 统一 `/api` 挂载  
2. character_sheet **包级**拆分与公开 re-export 测  
3. Alembic 脚手架 + 生产双轨（切流前）  
4. Jobs 属主模型 + 既有 IDOR 测试资产  
5. BUILD_ID / deploy gate / CI release-gate  
6. 凭据文档脱敏 + cred hygiene 测  
7. third_party：源树 ignore + licenses 入仓 + MIT 已并码件  
8. IndexTTS :9200 / H3 :8264 现网口径（以 AGENTS 为准）  
9. video-use / toonflow MIT 并码策略  
10. OpenClaw **ASR** 职能（与网关 LLM 分离理解）  
11. #13 **暂不改码**（与批准的 commit 边界一致）

### OPTIMIZE（14）

1. 拆 `drama_studio.py` / 继续切 `_impl.py`  
2. 新文件路由 IDOR checklist  
3. INVENTORY 勘误章 + 链到能力地图  
4. 产品方案 Ref2VA 默认表述  
5. COMMIT_BATCH_PLAN 09-13 废弃横幅  
6. HARDBLOCKED 标历史  
7. alembic cutover 升格出 tmp  
8. AGENTS H3 token 待办核销  
9. timeout 假阳性离线重标 + 徽章文案统一  
10. web CI 补单元测脚本  
11. DRT 与 ToIV 启动序文档解耦叙述  
12. WS legacy unit 清单与现行 indextts **命名消歧**  
13. toonflow 三视图模板按需 MIT 并  
14. 学习站真机 nightly dogfood 包装  

### REPLACE（5，均标可延后）

1. **可延后** 生产 admin/JWT/PG 换密 + api 重启  
2. **可延后** 历史 git 秘密净化 / 强推脱敏  
3. **可延后** alembic 生产 stamp/upgrade、Drama 删表  
4. **可延后** DRT 整栈关停或迁仓（负责人拍板）  
5. **可延后** 将 api 拆成多微服务；或 hypit/dramaclaw 在多租户 SaaS 下换实现  

---

## 12. 文档债清单（必须修的 md）

| 优先级 | 路径 | 必做编辑 |
|--------|------|----------|
| P0 | `docs/AI短剧产品方案.md` | 删除/改写「默认仍是 c / 尚未做」；§8 第一项改为生产对齐+UI |
| P0 | `docs/SERVICE_INVENTORY.md` | 文首 **过期警告** + 2026-10-15 勘误（8264、IndexTTS 9200、VLM 9311、NAS 5.2T）；OpenClaw 分角色 |
| P1 | `docs/COMMIT_BATCH_PLAN.md` | 废弃横幅 → `ops/COMMIT_BATCH_PLAN_20261021.md` |
| P1 | `docs/HARDBLOCKED_WHITEPAPER.md` | 标「历史快照 2026-09-14」 |
| P1 | `tmp/alembic_cutover_plan_20261018.md` → `docs/ops/ALEMBIC_CUTOVER_PLAN_20261018.md` | 升格防丢 |
| P2 | `AGENTS.md` 待办 H3 token 行 | 核销或改为监控项 |
| P2 | `docs/MIGRATION_PLAYBOOK.md` | DRT 步骤旁注「可选/待拍板」 |

**非必须但建议**：`docs/BUG_REGISTRY.md` P2-6 链到本审计；UX 总方案 §12 链本文件。

---

## 13. 与用户优先级的对齐

- **功能可用+感知**：优先文档 P0（避免代理/同学按错误默认管线与错误端口施工）+ drama_studio 可读性拆分；**不要**拿换密/DRT/alembic 切流抢窗。  
- **安全换密/push/上线暂缓**：§4 REPLACE 与 §5 deploy 执行全部 **可延后**；CI 与门禁代码 **KEEP** 即可。  
- **#13**：遵调研-only，不实施改码。

---

## 14. 证据锚点（路径）

- tip `e5307c63`；`apps/api/app/services/studio/pipelines.py`（DEFAULT=ref2va）  
- `docs/AI短剧产品方案.md` L16 过时「pipe = c」  
- `docs/SERVICE_INVENTORY.md` L1–30 采集 2026-09-13；H3 :8195 行  
- `AGENTS.md` H3 :8264 / IndexTTS :9200  
- `third_party/README.md` + `third_party/licenses/*`  
- `tmp/alembic_cutover_plan_20261018.md`；`apps/api/alembic.ini`  
- `docs/ops/COMMIT_BATCH_PLAN_20261021.md` L245 #13 不纳入  
- `docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md`  
- `.github/workflows/ci.yml` / `canvas.yml`  
- IDOR：`apps/api/tests/test_studio_files_idor.py` 等  

---

*本文件为审计产物；不编码、不 commit、不部署。*
