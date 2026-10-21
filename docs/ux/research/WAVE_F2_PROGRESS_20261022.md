# Wave F2 进度（剧组一键成片 · 复用 agent_team_graph）

> 时间：2026-10-22 Asia/Shanghai · tip 起点 `e76b8e18` · **无 push / 无 deploy / 无 restart**

## 范围（已完成）

1. **专家入口挂在剧组协助下**
   - `crew-one-click.ts`：`startCrewOneClick` 仅当 `isCrewAssistMode(projectId)` 为真才调 `createAgentRun`
   - 强制 `level=L2` + `opts.auto_approve=false` + `human_gates=[plan,assembly,makeup]`
   - **不**调用确认门放行 API；跳转既有 `/toiv/runs/:id`（计划确认 + assembly interrupt 仍在详情页）

2. **短剧工作区接线**
   - `drama-workspace`：`crewAssist &&` 面板 `crew-one-click-panel` + 按钮「一键成片」
   - 专家文案：`CREW_ONE_CLICK_EXPERT_HINT` / `CREW_ONE_CLICK_TITLE`

3. **人闸纪律**
   - D5 开关本身仍不自动建 run
   - 一键只建 planning→awaiting_confirm 的 Agent Team；合成门仍走 graph interrupt

## 测试

- bun：`crew-one-click` · `crew-assist-mode`（13 pass）

## OUT（本波未做）

F3 BGM/KPI · F4 剪映 · F0b 部署 · Acc · 安全 Dly · 真机雨夜一镜
