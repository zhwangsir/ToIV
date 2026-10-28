# FUSION W1+W3 Handback · 融合收口成熟化（只 FE）

**日期**：2026-10-28（Asia/Shanghai）  
**分支**：`work/p0-fusion-20261016`  
**基线 tip**：`03f5dbec`（HEAD 未动；本波 **未 commit / 未 push / 未 deploy**）  
**机器**：MateBook `/Users/wangzhenyu/Desktop/ALLProject/ToIV`

## 口径钉死

- 保留：`CreationFeaturedWorks` / 精选灵感；BF0 composer-first / `?project=` 三栏；侧栏一级五项密台
- 禁：SoftGlow / 首页意图墙回潮；DesktopShell 默认壳；姿势库 W5；W2 classic drama 大迁；redline 语义；OpenResty

---

## W1 · 默认落地 + 导航收缩（F1/F5）

| 项 | 前 | 后 |
|---|---|---|
| `/`（=`/studio/` SPA 根） | `HomePage` | `<Navigate to="/create" replace />` |
| Home | 仅 `/` | 降级 `/home`（及 `/desktop/legacy-home`） |
| 登录 handoff（`apps/web/app/page.tsx`） | `location.replace("/studio/")` | `"/studio/create"` |
| Hero | 「新建画布创作」主 CTA | 「打开创作台」；新建画布降次入口 |
| 侧栏「高级 / 更多」 | 首页 / 画布库 / 新建画布 / 媒体库 / 外部 Agent / 学习看板 | **默认仍折叠**；仅 画布库 / 新建画布 / 外部 Agent（去掉稀释五项的首页·KPI·媒体库主推） |
| Brand / 顶栏 | → `/` | → `/create` |
| ⌘K | 全站地图（home/canvas/library/agent…） | **白名单** = 侧栏五项 + 新建短剧/新对话 + 工具台锚点 + 设置段 |

### 验收（W1）

1. 硬刷 `/studio/` 或登录后 → 落 `/studio/create`（composer-first；无 `?project=`）
2. 侧栏一级仍是：创作 / 短剧项目 / 任务中心 / 工具台 / 设置
3. create 空态仍见「精选灵感 / Skill」网格（`CreationFeaturedWorks` 未动）
4. ⌘K 无「首页 / 自由画布 / 媒体库 / 外部 Agent / 新建画布（专家）」条目

---

## W3 · 清尸块（F7/F8/F10/F13/F18）

| 项 | 处置 |
|---|---|
| `pages/tasks/*` | 删死页；`task-shared` / `task-discovery` 迁 `src/lib/`（单测继续用）；现网任务仍 `/tasks`（`toiv/tasks-page`）；`/toiv/tasks` → Navigate `/tasks` |
| `pages/toiv/*-tools.tsx` | 删孤面源码；路由 Navigate → `/toiv/market` |
| `apps/web` middleware 工具深链 | `image/video/dub/audio-tools` → **`/studio/toiv/market`**（不再 create） |
| legacy `agent-page` | 卸 create `?view=agent` 挂载；删 `agent-page.tsx`；`/toiv/agent` → `/create`；浮窗/画布「发到对话」只深链 `/create` |
| router 死 lazy | 删未作 element 的 `CreatePage` / `ToivDramaWorkspacePage`；卸孤儿 `projects` loader（`pages/projects` 详情仍留） |
| `/test-voice-recording` | 移入 `devRoutes()`（仅 DEV）；生产 catalog 去掉 voice-lab |
| `apps/web/app/drama/[id]` | 强制 `redirect("/studio/toiv/drama")`；删 DramaPlayer CSS（W2 完整 `?project=` 单轨后做） |

### 验收（W3）

1. `rg` 无生产挂载 `pages/tasks` / `*-tools.tsx` / `agent-page`
2. 书签 `/toiv/image-tools` → market（canvas Navigate + web 308）
3. 生产无 `/test-voice-recording` 路由（DEV only）
4. 旧 `/drama/[id]` 不可直达播放器

---

## 改动文件列表（摘要）

**路由 / 壳**

- `apps/canvas/web/src/router.tsx`
- `apps/canvas/web/src/lib/workspace-route-modules.ts`
- `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx`
- `apps/canvas/web/src/components/layout/workspace-command-palette.tsx`
- `apps/canvas/web/src/components/layout/workspace-top-bar.tsx`
- `apps/canvas/web/src/layouts/user-layout.tsx`
- `apps/canvas/web/src/lib/desktop/catalog.ts`

**Create / Home**

- `apps/canvas/web/src/pages/create/creation-workbench.tsx`（卸 AgentPage）
- `apps/canvas/web/src/pages/home/home-dashboard.tsx` / `home-data.ts`
- `apps/canvas/web/src/pages/canvas/toiv-agent-float.tsx` / `project.tsx`
- `apps/canvas/web/src/services/toiv/agent-draft.ts`

**删 / 迁**

- 删：`pages/tasks/*`（UI）、`pages/toiv/{audio,image,video,dub}-tools.tsx`、`pages/toiv/agent-page.tsx`
- 迁：`src/lib/task-shared.tsx`、`src/lib/task-discovery.ts`
- 删测夹具：`task-discovery.browser` + TasksPage harness；`video-recovery` 去 history/TasksPage 用例

**web 薄壳**

- `apps/web/middleware.ts`、`apps/web/app/page.tsx`、`apps/web/app/drama/[id]/page.tsx`（redirect）

**测试对齐**

- `workspace-command-palette-f9`、`toiv-agent-*`、`toiv-library-assets-unify`、`f12RetiredRedirects` 等

---

## 自测

- `bun test`（canvas）：cmdk / agent float / agent chat / library unify / task-discovery / generation-failure → **全绿**（本波相关）
- `apps/web` f12 源码断言绿；真实 middleware 动态 import 受本机 `next/server` 解析环境影响（与本波无关的既有问题）

## 风险

- 书签 `/` 或 Brand 旧链会进 create（预期）
- Home 仅 `/home` 可达；高级不再挂首页入口（需从 URL 进）
- 浮窗 stash 仍写 pending session，但无 AgentPage 消费——草稿/会话需靠 create composer 路径（若有缺口留给后波）
- W2 未做：`/toiv/drama/:id` classic detail 仍在

## 明确未 commit

脏树相对 `03f5dbec`；**禁 commit/push/deploy**，等 TL 过审。
