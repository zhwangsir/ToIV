# 融合 W2 · 短剧单轨 Handback

**日期**：2026-10-28（Asia/Shanghai）  
**执行**：跨端设计 + 前端开发  
**基线 tip**：`ff619b1c`（脏改未 commit）  
**分支**：`work/p0-fusion-20261016`  
**范围**：只 FE；禁 SoftGlow / 首页意图墙 / DesktopShell 默认 / redline / 精选灵感；禁 commit/push/deploy

## 目标（F2）

短剧唯一工作面 = 列表 `/toiv/drama` → `/create?project=`（drama-workspace 三栏密台 / BeefTV）。

## 盘点：classic `drama-detail` 相对 workspace 的独有能力

| 能力 | classic detail | workspace（W2 前） | W2 处置 |
|---|---|---|---|
| 启动管线C `createCChain` | ✅ | ✅（shots 工具条） | 保留宿主按钮；提交后刷新链尾面板 |
| 管线C 链尾候选改选 `pickCChainSegment` | ✅ | ❌ | **迁入** `CChainTailPanel` |
| 管线C 续段 `appendCChainSegments` | ✅ | ❌ | **迁入** `CChainTailPanel` |
| 管线C 取消 `cancelJob` + 轮询 | ✅ | ❌（只 fire-and-forget） | **迁入** `CChainTailPanel` |
| 整批渲染 / 单镜渲染·配音·对口型 | ✅（简） | ✅（更强：闸门/strict/skip） | 已有，不迁 |
| 设定卡 regen / 采用参考图 | ✅ | ✅（+ soft-keep / 变体） | 已有 |
| 设定卡分格 `triggerPanelReplace` | ✅ | ❌ | **迁入** 设定卡抽屉 hover 替换 |
| 「v2 工作区」↔「经典详情」互跳 | ✅ | ✅（经典详情 Link） | **删除** |
| 角色/分镜只读陈列壳 | ✅ | 三栏密台 | 随页删除 |

## 改动文件

| 文件 | 动作 |
|---|---|
| `apps/canvas/web/src/components/toiv/c-chain-tail-panel.tsx` | **新增** · BeefTV 表面：链尾候选 / 选用 / 续段 / 取消 / 轮询 |
| `apps/canvas/web/src/pages/toiv/drama-workspace.tsx` | 挂面板；设定卡分格替换；去掉「经典详情」互跳；文案去 classic |
| `apps/canvas/web/src/router.tsx` | `/toiv/drama/:id` → `ToivDramaDetailToCreateRedirect`（`/create?project=:id`，保留 query，丢弃 `classic`） |
| `apps/canvas/web/src/pages/toiv/drama-detail.tsx` | **删除** |
| `apps/web/app/drama/[id]/page.tsx` | redirect → `/studio/create?project=:id`（W1 仅到列表，本波补齐单轨） |
| `apps/canvas/web/test/p20-subpath-anchor.test.ts` | 断言改盯 router 单轨 redirect；列表 Link key=`proj.id` |
| `apps/canvas/web/test/toiv-scroll-unlock.test.ts` | 名单去掉已删 `drama-detail.tsx` |

## 路由 / 导航 diff

**前**

- `/toiv/drama` → 列表（打开已进 create）
- `/toiv/drama/:id` → classic `DramaDetailPage`（含「v2 工作区」「完整编辑 ?classic=1」）
- `/drama/:id`（web）→ `/studio/toiv/drama` 列表

**后**

- `/toiv/drama` → 列表（不变；卡/新建仍 `/create?project=`）
- `/toiv/drama/:id` → Navigate replace → `/create?project=:id`（+ 原 query，无 classic）
- `/drama/:id`（web）→ `/studio/create?project=:id`
- workspace 头栏仅「项目列表」，无「经典详情」

列表页本身 W1 已单轨，本波未改打开逻辑。

## 验收步骤

1. 硬刷登录后仍落 `/create`（W1 不回潮）；精选灵感仍在无 project 空态。
2. 打开 `/toiv/drama` → 点已有项目 → URL 为 `/create?project=<id>`，三栏密台（`data-surface=beeftv-drama`），**无** classic 详情壳。
3. 直访 `/toiv/drama/<id>`（可带无关 query）→ 应 replace 到 `/create?project=<id>…`；`?classic=1` 被丢弃且仍进 create。
4. 直访 web `/drama/<id>` → `/studio/create?project=<id>`。
5. 在 create 工作区 shots 段：可「启动管线C」；有链时出现「管线C · 链尾候选」面板（选用 / 续段 / 作业中可取消）。
6. 资产段打开设定卡：有 `panel_urls` 时 hover 可替换分格。
7. rg：无 `pages/toiv/drama-detail`；router 无 `ToivDramaDetailPage` lazy。

本地已跑：`bun test test/p20-subpath-anchor.test.ts test/toiv-scroll-unlock.test.ts` → 6 pass。

## 风险

- **fetchCChain(projectId)**：与旧 detail 同契约（用项目 id 拉链）。若后端只认 chain_id，面板会空态但不白屏；启动仍走任务中心文案。
- **C-Chain 作业中**：取消走顶层 `cancelJob(job_id)`；与任务中心取消同源。
- **设定卡替换**：沿用旧 API 吞错 boolean；失败仅结束 loading，需用户再开抽屉确认。
- **未做视觉截图 fixture**（本机脏树；等 TL 过审后再补 shot 如需）。
- tsc 仓内仍有既有噪声（`project-bible-panel` / `library-group`），与本波文件无关。

## 明确未做

- W4 / W5 / W6 / W7；姿势库；SoftGlow / 首页意图墙回潮
- commit / push / deploy（**未 commit**，tip 仍 `ff619b1c`）
- classic 页内「角色网格只读陈列」未原样搬（workspace 资产段已覆盖操作面）

## 请 TL 过审后

放行再 commit+push；建议 message：

```
feat(fusion-w2): drama single-track — retire classic detail

Route /toiv/drama/:id → /create?project=; migrate C-Chain
pick/append/cancel + sheet panel-replace into BeefTV workspace;
web /drama/:id → /studio/create?project=.
```
