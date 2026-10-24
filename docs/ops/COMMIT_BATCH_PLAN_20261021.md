> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# 分批 Commit 方案（2026-10-21）

> **本文仅方案；未经用户批准不得 commit / push。**  
> 基于分支 `work/p0-fusion-20261016` 当前脏工作区（约 100+ 路径，含审计 #1–#12 与波次 A W3）。  
> **勿沿用** 旧稿 `COMMIT_BATCH_PLAN.md`（09-13）或其它历史清单。

## 快照口径（起草时）

- 分支：`work/p0-fusion-20261016`（无 upstream；勿切走）
- 相对 `github/main`：约 66 commits ahead（本方案只整理工作区，不 rebase）
- 禁止：push、部署、重启 toiv-api、碰生产 secrets、`git commit` 除非用户逐批批准

## 总顺序与依赖

```
批1 release+安全  →  批2 api 域（含 W3）  →  批3 canvas/web 产品  →  批4 ops 文档+STATE
```

- 批1 先落：dirty gate / drain / 凭据文档与后续发版纪律相关，宜单独可回滚。
- 批2 依赖批1 仅在「同一发版窗」叙事上；代码无硬依赖，可独立审。
- 批3 产品壳与 api 契约弱耦合；建议 api 归属测绿后再合产品。
- 批4 最后：TEST_LOG / AGENTS / STATE / 本方案自身，引用前三批 SHA。

每批建议：`git add` 显式路径 → `git status` 自检无越界 → 用户批 message → 再 commit。仍默认 **不 push**。

---

## 批 1 — release + 安全 / 部署纪律

**意图**：发版闸、drain、凭据卫生文档与示例 env；不进业务路由。

**拟纳入路径**

```
scripts/release/build_id_gate.py
scripts/release/preflight.sh
scripts/release/test_build_id_gate.py
scripts/release/test_cred_hygiene.py
scripts/release/test_deploy_drain.py
deploy/deploy_drain.py
deploy/deploy.sh
deploy/.env.example
apps/api/.env.example
.github/workflows/ci.yml
docs/ops/CREDENTIAL_HYGIENE_ROTATE_20261020.md
docs/ops/DEPLOY_DRAIN_STUDIO_20261020.md
docs/ops/RELEASE_AUTOMATION_P2_20261020.md
scripts/ops/fleet_activate_missing_nodes.sh
```

**建议 message**

```
chore(release): dirty-build gate + deploy drain + credential hygiene docs

发版预检/BUILD_ID 闸、Studio drain 脚本与 CI release-gate 接线；
凭据脱敏轮换文档与 .env.example 对齐。不含业务路由、不碰生产 secrets。
```

**依赖 / 顺序**：首批。无代码依赖。  
**风险**：`deploy.sh` / CI 改动若误合到会跑生产的流水线，审 diff 确认仅闸与文档；本批仍不部署。

---

## 批 2 — api 域（IDOR / async / 域收敛 / alembic / R18 / sheet 拆包）

**意图**：审计落地的后端契约 + **波次 A W3**（scope/orch 文件 IDOR）。

**拟纳入路径**

```
# W3 文件 IDOR（本波次）
apps/api/app/services/studio_file_access.py
apps/api/app/routes/scope.py
apps/api/app/routes/audio_orchestrate.py
apps/api/tests/test_scope_orch_files_idor.py
apps/api/tests/test_scope.py
apps/api/tests/test_studio_files_idor.py

# 既有 IDOR / fusion / studio
apps/api/app/routes/studio.py
apps/api/app/routes/fusion_tools.py
apps/api/app/routes/drama_scenes.py
apps/api/app/routes/h3_studio.py
apps/api/app/routes/video.py
apps/api/app/routes/apps.py
apps/api/app/comfy/tracker.py
apps/api/app/db.py
apps/api/app/main.py
apps/api/app/nsfw_ctx.py
apps/api/app/r18_policy.py
apps/api/app/services/domain_events.py
apps/api/app/services/project_host.py
apps/api/app/services/studio/orchestrator.py

# character_sheet 拆包（删单体 + 新包）
apps/api/app/services/studio/character_sheet.py
apps/api/app/services/studio/character_sheet/

# alembic 脚手架
apps/api/alembic.ini
apps/api/alembic/

# 依赖与测
apps/api/pyproject.toml
apps/api/uv.lock
apps/api/tests/test_alembic_scaffold.py
apps/api/tests/test_character_sheet_package_split.py
apps/api/tests/test_db_migrations.py
apps/api/tests/test_dogfood_full_chain_ci.py
apps/api/tests/test_domain_convergence_slice.py
apps/api/tests/test_drama_continue.py
apps/api/tests/test_drama_studio.py
apps/api/tests/test_fusion_tools_api.py
apps/api/tests/test_r18_policy_d_u1b.py
apps/api/tests/test_ref2va_indep_pipeline.py
apps/api/tests/test_sheet_gate_calibration.py
apps/api/tests/test_studio_batch_render_async.py
apps/api/tests/test_studio_projects.py
docs/ops/R18_POLICY_D_U1B_20261020.md
docs/ops/DOGFOOD_CI_SLICE_20261019.md
```

**建议 message**

```
fix(api): P-1 IDOR for scope/orch files + audit #1–#12 api slice

复用 studio_file_access：/api/scope/files 与 /api/audio/orch/files
改为 sig|Job 属主|admin；跨用户 404。并纳入 async render、domain_events、
alembic 脚手架、r18_policy、character_sheet 拆包及对应测。
```

若体量过大，可拆 **2a IDOR+安全测** / **2b 其余 api**（2a 先合）：

- **2a**：`studio_file_access.py`、`scope.py`、`audio_orchestrate.py`、`studio.py`、`fusion_tools.py`、`test_studio_files_idor.py`、`test_scope_orch_files_idor.py`、`test_scope.py`、`test_fusion_tools_api.py`
- **2b**：其余批 2 路径

**依赖 / 顺序**：建议在批 1 之后；合前跑：

```bash
cd apps/api && uv run pytest -q \
  tests/test_scope_orch_files_idor.py \
  tests/test_studio_files_idor.py \
  tests/test_scope.py::test_generate_happy_path_job_done_and_file_served \
  tests/test_audio_orchestrate.py
```

**风险**：归属 fail-closed 可能挡「盘上有文件但 Job 未建档」的运维取证（admin 仍直通）；前端若曾裸链分享 scope/orch URL 需改挂 `?sig=` 或经作品库属主会话。

---

## 批 3 — canvas / web 产品

**意图**：R18 content-mode、市场/工具页、web handoff、移动端壳。

**拟纳入路径**

```
apps/canvas/web/src/services/toiv/content-mode.ts
apps/canvas/web/src/services/toiv/client.ts
apps/canvas/web/src/pages/settings/r18-settings-pane.tsx
apps/canvas/web/src/pages/toiv/audio-tools.tsx
apps/canvas/web/src/pages/toiv/dub-tools.tsx
apps/canvas/web/src/pages/toiv/image-tools.tsx
apps/canvas/web/src/pages/toiv/library-page.tsx
apps/canvas/web/src/pages/toiv/library-works.tsx
apps/canvas/web/src/pages/toiv/market-page.tsx
apps/canvas/web/src/pages/toiv/tasks-page.tsx
apps/canvas/web/src/pages/toiv/video-tools.tsx
apps/canvas/web/src/styles/toiv-mobile.css
apps/canvas/web/src/components/layout/workspace-command-palette.tsx
apps/canvas/web/test/content-mode.test.ts
apps/canvas/web/test/toiv-mobile-shell.test.ts
apps/canvas/web/test/assistant-history-failure.test.ts
apps/canvas/web/test/assistant-model-picker.browser.test.ts
apps/canvas/web/test/canvas-lifecycle-restart.browser.test.ts
apps/canvas/web/test/canvas-node-editor-scope.browser.test.ts
apps/canvas/web/test/canvas-upload-settings-scope.browser.test.ts
apps/canvas/web/test/editor-asset-ingest.browser.test.ts
apps/canvas/web/test/fixtures/assistant-model-picker-harness.tsx
apps/canvas/web/test/project-settings-view.browser.test.ts
apps/canvas/backend/internal/bootstrap/runtime_test.go
apps/canvas/backend/internal/editing/native_ffmpeg_test.go
apps/canvas/backend/internal/project/chapter_apply_test.go
apps/web/app/page.tsx
apps/web/components/studio/EngineStudioView.tsx
apps/web/e2e/r18-mode.spec.ts
apps/web/tests/f9HomeHandoff.test.ts
docs/ops/MOBILE_ADAPTATION_GAP_20261020.md
```

**建议 message**

```
feat(canvas/web): R18 content-mode + market shell + mobile padding

内容模式接线、市场/任务/工具窄屏壳（toiv-mobile.css）、web handoff/e2e；
不含画布多指触控与小程序提审。
```

**依赖 / 顺序**：批 2 后更稳（若 client 依赖新 api 字段）。  
**风险**：移动壳仅 CSS/布局；勿在 message 中宣称触控战役完成。

---

## 批 4 — ops 文档 + TEST_LOG / AGENTS / STATE / skills

**意图**：接棒真源与集群 skill 脱敏叙述；收口本方案。

**拟纳入路径**

```
TEST_LOG.md
AGENTS.md
STATE.json
docs/ops/COMMIT_BATCH_PLAN_20261021.md
docs/ops/DRAMA_UI_PLAN.md
docs/HANDOFF_PROMPT_20260922.md
docs/2026-08-30-ux-research-report.md
skills/toiv-cluster/PROMPT.md
skills/toiv-cluster/SKILL.md
skills/toiv-cluster/api.md
skills/toiv-cluster/credentials.md
skills/toiv-platform/SKILL.md
```

**建议 message**

```
docs(ops): weak-spot sniff + commit batch plan 20261021 + handoff sync

弱项嗅探与波次 A 留痕；分批 commit 清单；skills/AGENTS/STATE 对齐。
仍不 push、不部署。
```

**依赖 / 顺序**：最后一批，便于在正文写前三批 commit SHA。  
**风险**：`credentials.md` 仅文档口径，审 diff 确认无实密；`STATE.json` 与 TEST_LOG 时间戳用 Asia/Shanghai。

---

## 明确不纳入本轮四批（除非用户另批）

- 生产换密 / 重启 toiv-api / drain 真机 probe（W2 / 波次 B）
- #13 假 timeout 归因改码
- Drama 删表、alembic 生产 stamp
- 画布多指触控、小程序提审
- 任何 `git push` / tag / 生产 deploy

## 用户批准方式（建议）

回复例如：「批 1 GO」或「批 2a GO」——执行者再 `git add` 列路径并 commit；默认仍不 push。  
若工作区在审期间又增文件：以当时 `git status --porcelain` 为准微调本清单，勿盲目全加。
