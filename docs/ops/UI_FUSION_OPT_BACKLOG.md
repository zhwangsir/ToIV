# UI 融合优化 backlog（feat/canvas-m2-ux-opt）

> 与 `UI_FUSION_PLAN` 附录 A / `UI_BEEFTV_RESKIN` 对齐。本档只记**未做完**的加强点，已合入项见分支 commit。

## 本分支已做
- 画布壳：首页能力卡外跳→`/toiv/*`；补市场/作品库/任务卡；侧栏 `/toiv/*` 高亮；市场运行/短剧完整编辑去主 CTA 外跳；顶栏任务 chip↔`/toiv/tasks`。
- Next web：缺省主题 `cinema`→`minimal`；卸 Fraunces；PWA/global-error/studio token 对齐 BeefTV；`themeContrast` 92 绿。

## 仍保留的外链（有意）
- 短剧详情「完整编辑（迁移中）」→ `/drama/:id?classic=1`（M3 前完整分镜编辑仍在 Next）。
- 登出回 `/?view=home`（账号菜单，非创作主路径）。

## 下一刀 backlog（不在本 PR 强塞）
1. **M2 市场运行闭环**：`POST` 创建 job → 引导 `/toiv/tasks`（现仅占位文案）。
2. **M2 智能体**：`feat/canvas-m2-agent` 组件移植（本分支不碰 agent 逻辑）。
3. **M2 作品库详情加强**：变体分组/回收站交互深化（详情页已有骨架）。
4. **统一时间线**：画布 GenerationTask + ToIV jobs 一屏（chip 已双向入口）。
5. **Next 视图 CSS**：apps/library/assistant 等仍有局部硬编码色/圆角，按视图分批换 token。
6. **ui-v3 紫强调**：与 BeefTV 中性 accent 仍两套；开 v3 开关才生效，暂不动。
