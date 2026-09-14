# 产品树 Commit 批次方案（2026-09-13）

> **状态：待用户批准后执行**。当前 84 修改 + 42 未跟踪（含大量 `.regen_tmp/` 与 `.bak`，**永不入库**）。
> 原则：按功能内聚分批、每批「全量 pytest 绿 + deploy 冒烟」后打 tag；一批一 tag 可独立回滚。

## 永不入库清单（加入 .gitignore 或保持不 stage）
- `.regen_tmp/`（全部工作产物）
- `apps/api/app/data/rh_h3_presets.json.bak*`（2 个备份文件）
- `apps/api/app/data/rh_family_presets.json`（确认是种子还是生成物后决定；若是生成物不入库）
- `apps/api/app/data/h3_accel_profiles.json`（机读规格源稿之一——**建议入库**：它是 api 运行依赖（app/data 是部署内容），与 `.regen_tmp` 源稿双写）
- `.archive/AGENTS-changes-20260904-0911.md`（历史归档，建议入库进 `.archive/`）
- `STATE.json` / `AGENTS.md`（文档惯例入库）

## 批次划分（依赖顺序：前批是后批的基础）

### Batch 1 — H3 底座与多实例（最底层，先收）
- `apps/api/app/comfy/{client,pool,tracker}.py`、`services/h3.py`、`workflows/h3_video.py`、`config.py`、`deps.py`、`routes/{h3_studio,jobs,upload}.py`、`services/engine_registry.py`（多实例探测部分）、`tests/test_h3_multi_instance.py` + `test_h3_accel.py` + `h3_prod_graphs_fixture.py`
- 理由：H3 双池/加速的地基，被后续所有批引用
- 验证：test_h3_* 全绿 + `/api/h3/workers` 200

### Batch 2 — H3 智能加速功能
- `services/h3_accel.py`（新）、`app/data/h3_accel_profiles.json`（新）、`components/generate/H3AccelSelect.tsx`（web）、`lib/h3Accel.ts`（web 未列全，按 git status 补）、`routes/apps.py` + `h3_studio.py` 的 acceleration 参数部分、`tests/test_h3_accel.py`
- 注意：与 Batch 1 有文件交叠（routes/apps.py 等），**执行时 Batch 1 先合**，交叠文件按 hunk 拆分或同批处理
- 验证：加速三档生产作业回归（已有脚本）

### Batch 3 — 应用策展层（use_case/featured）
- `services/use_cases.py`、`app_use_case_gen.py`（新）、`routes/app_curation.py`（新）、`models.py`/`db.py` 的 use_case/featured 列、`lib/apps.ts` + AppMarketView + apps.css 的市场改动、`tests/test_app_curation.py`（新）+ `test_db_migrations.py`
- 验证：summary 端点 + 过滤 + web build

### Batch 4 — P1 应用说明卡
- `services/app_guide_gen.py`、`routes/app_guides.py`（新）、`AppGuide` 表（models/db）、`components/admin/AppGuidesAdminView.tsx`、`tests/test_app_guides.py`（新）
- 验证：publish-all + 详情页指南卡

### Batch 5 — 引擎工作台 + 路由修复 + 杂项产品修复
- `components/studio/EngineStudioView.tsx`、`lib/engineStudio.ts`、`_pick_app_client` 相关（routes/apps.py、services/app_content_modes.py、test_app_routing.py）、`services/provenance.py` + `knowledge_graph.py` + `tests/test_provenance_kg.py`（KG）、admin 视图（AppOpsAdminView/AppTestMatrixAdminView）、`rh_ref_defaults`（test_rh_ref_defaults.py）
- 验证：web 全量 + api 全量

### Batch 6 — 运维/文档收尾
- `AGENTS.md`、`STATE.json`、`.gitignore`、`.archive/` 归档、MiniProgram 主题改动（单独评估：小程序 dirty 是否与 web v9 对齐有关）、`app_seed.py`/`app_covers.py` 及对应测试（含 21 个预存失败中可顺带修复的用例——若某预存失败根源在代码语义变化，在本批一并修，否则改为 skip+xfail 并记 issue）
- 收尾 tag：`migration-ready-2026xxxx`

## 执行纪律
1. 每批：branch 或 main 直提（按仓库惯例确认）→ 全量 pytest（基线 3144 pass/22 已知预存，目标随批收敛预存数）→ `deploy.sh`（或 skip-web）→ 生产冒烟 → tag
2. 批间不 force-push、不 amend 已部署内容
3. 执行窗口选低峰（避开 E2E 波次与管家作业）
4. 全部完成后更新 AGENTS「产品树 dirty」口径为「已 commit，tag 列表见 releases」

## 风险
- 批间文件交叠（routes/apps.py 横跨 Batch 2/3/5）→ 执行时按 hunk 精细拆分，必要时两批合并
- 22 个预存测试失败若随 commit 暴露为新失败 → 先修代码语义再提，不修不许带红合入
- MiniProgram dirty 改动来源不明（08-30 批次遗留）→ Batch 6 前先在真机确认其用途，无用则回滚不 commit
