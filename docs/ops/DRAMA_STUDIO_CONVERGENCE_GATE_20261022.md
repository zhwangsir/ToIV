# Drama∥Studio 收敛门禁（Wave Doc N8 · 2026-10-22）

> **性质**：研发纪律卡（零运行时）。近窗**不**拆 `drama_studio.py`、**不** alembic 大搬迁、**不**删 Drama 表。  
> **拍板真源**：`docs/ops/PROJECT_DOMAIN_MERGE_ASSESSMENT_20261011.md`（Studio 唯一宿主；Drama 冻结新功能）。  
> **工程卡**：`docs/ux/research/ENGINEERING_CARDS_N1_N10_20261022.md` → N8；总计划 `docs/ux/EXECUTION_MASTER_PLAN_20261022.md`；MASTER N8。

## 1. 硬规则

1. **新功能只加 Studio**：路由/服务/前端一律走 `apps/api/app/routes/studio.py`、`apps/api/app/services/studio/*`、canvas ToIV 页（`/studio/projects` 契约）。
2. **Drama API 只读兼容至收束**：`drama_studio.py` / `/drama/*` = **bugfix only**；禁止新增写能力 endpoint、禁止新业务写入 Drama 域表。
3. **工程卡禁 Drama 域新业务写入**：评审拒绝「只加 Drama 域」的功能 PR；下一功能需求的文件触点不得以「写入 drama_studio 新业务」为主路径。
4. **近窗不做**：拆分 5708 行 `drama_studio.py`、alembic 合并表、删除 Drama 表、历史项目强制数据大搬迁（属 OPTIMIZE/P4 另卡）。

## 2. 宿主与兼容日历

| 阶段 | Drama 域 | Studio 域 |
|------|----------|-----------|
| 近窗（P1–P3 / Wave Doc–Default） | 只读兼容 + bugfix | 唯一新功能宿主 |
| P4 经典视图 | 改只读（数据可查） | 继续为主 |
| P4 前决策点 | 是否一次性导出历史 Drama→Studio（量少可不做） | — |

保留至收束（按评估 KEEP）：Drama 七阶段 `compute_drama_pipeline_status`、DramaAsset 跨项目资产库（Studio 侧只读引用另卡）、既有只读播放/查询。

## 3. PR / 工程卡检查清单（勾选）

- [ ] 新能力路径在 Studio（routes/studio + services/studio + canvas），不在 drama_studio 新写业务
- [ ] 若必须动 `/drama/*`：仅 bugfix / 契约兼容，说明为何不能先落 Studio
- [ ] 无 alembic 大搬迁、无删 Drama 表、无「整仓 Toonflow 化」夹带
- [ ] 声画/定妆门禁/管线选择器/阶段轨等 UX 一律 Studio（见 IA P2）

## 4. 互链

- 评估结论：`docs/ops/PROJECT_DOMAIN_MERGE_ASSESSMENT_20261011.md`
- 工程卡 N8：`docs/ux/research/ENGINEERING_CARDS_N1_N10_20261022.md`
- 审计 MASTER N8：`docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md`
- 总执行方案：`docs/ux/EXECUTION_MASTER_PLAN_20261022.md`

## 5. 变更记录

- 2026-10-22：Wave Doc N8 初版门禁发布（文档 only；无业务码）。
