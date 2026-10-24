> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# AUDIT C — 前端壳层全模块审计（KEEP / OPTIMIZE / REPLACE）

| 字段 | 值 |
| --- | --- |
| 审计路 | **C**：apps/web · apps/admin · apps/canvas · MiniProgram |
| tip | `e5307c63`（本机 ToIV） |
| 对照 | `docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` §0–§12；痛点 G1–G10 |
| 约束 | **禁止**整仓重写成 Toonflow；REPLACE 仅指模块语义/默认入口/菜单一级，须锚定阶段轨 / 双视图 / 专家画布 |
| 日期 | 2026-10-22（Asia/Shanghai） |
| 方法 | 本机源码实读（路由/侧栏/短剧六段/任务中心/工具箱/添加菜单/admin/小程序）+ UX 方案对照；未改业务代码、未 commit |

---

## 0. 执行摘要（最关键 5 条）

1. **产品主壳已在 canvas（BeefTV），web 是登录门 + `/studio` 静态托管。** 改 IA 应动 `apps/canvas/web`，不是再扩 `apps/web` 第二套 SideRail（F9/F12 已下线；`NAV_LABELS` 多为遗留）。
2. **首页默认心智仍是「新建画布」**（`home-dashboard` 主 CTA → `/canvas?mode=new`；能力卡 9 张镜像侧栏）。与方案 D1-A「短剧阶段轨默认」冲突 → **OPTIMIZE→语义 REPLACE 主 CTA**，勿重写首页框架。
3. **添加菜单 = 本地引擎目录已坐实**：`LOCAL_CREATE_PRESETS`（本地·H3/Wan/LongCat…）经 `add-node-menu-tools.tsx` 挂一级节点；工具箱 `LocalBadges` 直接展示 **`:8264/:8196/:8197/:8199`** → 对应 G6/G10，**REPLACE 一级菜单语义**（创作类型），端口/引擎进设置或节点检视器。
4. **短剧六段工作区（`/toiv/ws/:id`）是阶段轨最好的底子**（剧本→资产→分镜→镜头→时间线→成片，含配音/合成）→ **KEEP 数据与路由，OPTIMIZE 为左轨 Phase + ready≠generating**；不要换成无限画布默认。
5. **任务中心 `/toiv/tasks` 仍嵌「新建智能体任务」Create 区**；Beef 原生 `/tasks` 已 Navigate 到 `/`。对齐 Jellyfish：**OPTIMIZE 迁出 Create、加强回跳**；勿再开第二套任务创建页。

**路径 + 计数（本机 tip）：**

| 区 | 路径要点 | 计数 |
| --- | --- | --- |
| canvas ToIV 页 | `apps/canvas/web/src/pages/toiv/*.tsx` | **16** 文件；`drama-workspace.tsx` **1360** 行；`market-page.tsx` **1219**；`tasks-page.tsx` **469** |
| canvas 布局壳 | `apps/canvas/web/src/components/layout/*.tsx` | **21** |
| canvas 添加菜单 | `canvas-create-menu.tsx` 188 行；`add-node-menu-tools.tsx` 57 行；`local-capability-surface.ts` **437** 行（含 `LOCAL_CREATE_PRESETS` 8 预置） |
| web | `apps/web/app` + `components` 业务源 | 路由薄壳；`LandingPage`；`EngineStudioView` **708** 行（已标注下沉） |
| admin | `apps/admin/components/admin/*.tsx` 等 | **~7.8k** 行管理面 |
| MiniProgram | `MiniProgram/src/pages*` | **13** vue 页；`pages-sub/studio` = web-view 壳 |

---

## 1. 架构事实（改壳前必须认清）

```
浏览器登录 → apps/web (/) Landing / handoff
                ↓ 登录态整页切
            /studio/*  ← Next catch-all 托管 BeefTV dist
                ↓
         apps/canvas SPA（真正创作 IA）
                ├── /                 首页（画布主 CTA）
                ├── /toiv/drama       短剧项目列表
                ├── /toiv/ws/:id      六段工作区 ← 阶段轨候选真源
                ├── /toiv/market      工具箱（页标题已是「工具箱」）
                ├── /toiv/tasks       任务中心（含 Create）
                ├── /toiv/agent       智能体
                ├── /canvas/:id       自由画布（专家层）
                ├── /create           Beef 创作页
                └── /settings         含 local-compute（端口合理）
```

- **web `?view=*`**：大量旧 key 重定向到 `/studio/toiv/...`（`apps/web/app/page.tsx`），说明经典多视图已退役，**勿复活 SideRail**。
- **双任务路由**：`/toiv/tasks` = 真页；`/tasks` = 永久 `Navigate to "/"`（注释：暂不开放）。公网深链应对齐 **`/studio/toiv/tasks`**（方案 G4）。
- **市场双名**：侧栏与页 h1 已统一「工具箱」；副文案仍写「应用市场」——轻度 OPTIMIZE，非双路由。

---

## 2. 模块裁决总表

图例：**KEEP** = 保留实现与职责；**OPTIMIZE** = 改默认文案/入口/信息架构，少动数据模型；**REPLACE** = 替换该模块的**产品语义或一级交互**（锚定竞品范式），**不是**删仓重写。

### 2.1 apps/web（门面）

| 模块 | 路径 | 裁决 | 说明 / 竞品锚 |
| --- | --- | --- | --- |
| 登录落地页 | `components/landing/LandingPage.tsx` | **KEEP** | 品牌+登录；能力三列仅展示 |
| Studio handoff | `app/page.tsx` | **KEEP** + 轻 **OPTIMIZE** | F9 跳 `/studio`；经典回落保留逃生；勿再渲染第二导航 |
| `/studio` 静态托管 | `app/studio/[[...slug]]/route.ts` | **KEEP** | 正确边界 |
| `NAV_LABELS` / 旧 view map | `lib/navLabels.ts` + page 重定向表 | **OPTIMIZE** | 仅服务遗留深链；注释标明「非现役壳」 |
| `EngineStudioView` | `components/studio/EngineStudioView.tsx` | **KEEP（测试/配方）** | 文件头已写 `?view=image\|video`→`/studio/create`；**勿当产品主面** |
| Generate 组件族 | `components/generate/*` | **KEEP 冷藏** | 引擎台已下沉工具箱；避免与 canvas 双写 |
| ReleaseWatch / BUILD | `components/ReleaseWatch.tsx` | **KEEP** | 运维软提示，非创作者主文案 |

**勿 REPLACE web 整站。**

### 2.2 apps/canvas — 导航与首页（G1 / D1-A）

| 模块 | 路径 | 裁决 | 改法锚 |
| --- | --- | --- | --- |
| 侧栏树 | `workspace-sidebar-nav.tsx` `buildNav` | **OPTIMIZE** | 现序：新建项目(→画布) / 首页 / 短剧 / 智能体 / 项目 / 媒体库 / 工具箱 / 任务 / 模型配置。→ 稳态草图：**短剧项目默认** → 任务（只读）→ 工具台 → 自由画布(可折) → 设置（方案 §8.4） |
| 「新建项目」→`/canvas?mode=new` | 同上 | **REPLACE 语义** | 学习站主新建应进 **短剧**（火宝/printfilm 项目卡）；画布新建降为专家或「高级」 |
| 首页主 CTA | `home-dashboard.tsx` | **REPLACE 语义** | 现「新建画布创作」→ 改为「新建短剧」+ 最近短剧项目；画布降二级（LocalMiniDrama / 火宝） |
| 能力瓷砖 9 张 | `home-data.ts` `beefTVCapabilityItems` | **OPTIMIZE** | 与侧栏镜像 → P1：只留 1 主 CTA + 最近项目；能力只留侧栏（G1） |
| 意图胶囊条 | `homeIntentBarItems` ← `HOME_INTENT_ENTRIES` | **OPTIMIZE** | 收进工具箱或「更多能力」；禁止与侧栏同权 |
| ⌘K 命令盘 | `workspace-command-palette.tsx` | **OPTIMIZE** | 标题已含工具箱/任务中心；与侧栏一词一义对齐 |
| 「正在开发」渲染 | sidebar `item.disabled` | **KEEP 机制** | 主路径现网 `buildNav` **无 disabled 项**；添加菜单另有 `CANVAS_DEVELOPING_LABEL`（智能剪辑/逐帧/脚本）→ **OPTIMIZE** 藏进实验室（G9） |

### 2.3 短剧（阶段轨核心 — KEEP 底，OPTIMIZE 轨）

| 模块 | 路径 | 裁决 | 改法锚 |
| --- | --- | --- | --- |
| 短剧列表 | `pages/toiv/drama-page.tsx`（113 行） | **KEEP** | 文案已写「剧本→…→成片」；空态指向智能体也可保留为辅 |
| 六段工作区 | `drama-workspace.tsx`（1360 行）`SECTIONS` | **KEEP 实现 + OPTIMIZE IA** | 段：script/assets/storyboard/shots/timeline/final。方案 Phase：剧本→资产→分镜准备(ready)→生成→合成。建议：**合并叙事**（镜头+时间线≈生成/合成），引入 Jellyfish **prepared≠generating**；配音已在镜头段 → 对齐 §12 声画（D6-A） |
| 经典详情 | `drama-detail.tsx` | **KEEP** | 与 ws 并行零回归；可渐进引导到 ws |
| 图生短剧对话框 | `from-image-dialog.tsx` | **KEEP** | 辅入口 |
| 画布内短剧空态 | `canvas-short-drama-entry.tsx` | **OPTIMIZE** | 已有「短剧流水线 vs 自由空白」二分；专家画布内 **KEEP**，但**不要**当全站默认进门（反 Toonflow） |
| 流水线双视图 | （尚未接轨短剧列表） | **REPLACE 缺口=新增投影** | P3：列表↔竖排同源（LocalMiniDrama）；**不是**把 ws 整页换成 xyflow |

### 2.4 任务中心（G3 / Jellyfish）

| 模块 | 路径 | 裁决 | 改法锚 |
| --- | --- | --- | --- |
| ToIV 任务页 | `pages/toiv/tasks-page.tsx` | **OPTIMIZE** | **迁出** `aria-label="新建智能体任务"` 整段（约 L309+）；创建归 `/toiv/agent` 或首页。保留 jobs+canvas+agent 时间线合并与取消 |
| 状态中文化 | 同文件 `STATUS_META` / `AGENT_RUN_STATUS_TEXT` | **KEEP** | 任务侧已做人话；短剧 `STATUS_TONE` 仍键英文 → 展示层补字典（G2） |
| Beef `/tasks` | `router.tsx` → `/` | **KEEP 重定向** | 避免半成品双中心；深链文档统一 `/toiv/tasks` |
| 回跳上下文 | 任务行→项目/镜 | **OPTIMIZE（缺口）** | 现有 market `focusJob`；需 Jellyfish 式回跳 drama/ws section |

### 2.5 工具箱 / 市场 / 单工具页（D3-A）

| 模块 | 路径 | 裁决 | 改法锚 |
| --- | --- | --- | --- |
| 工具箱页 | `market-page.tsx` | **KEEP 壳** + **OPTIMIZE 露出** | h1=「工具箱」✓；`LocalBadges` 展示 `worker` 端口 → **产品面去掉端口 badge**（设置/admin 保留）（G10）；引擎名降为次级 |
| `local-capability-surface` | 精选 7+Wan | **OPTIMIZE** | 能力保留；**不要**当添加菜单一级；市场精选可用创作语义标签 |
| R18 门控 | market + `r18-mode` | **KEEP** | D-U1=B；门控清晰，勿搬回 web 引擎台 |
| image/video/audio/dub-tools | `*-tools.tsx` | **KEEP 归属工具台** | 对齐 LumenX Playground / printfilm 工具中心；侧栏不必再各占一项 |
| 烟雾徽章 | `smoke-badge.ts` | **KEEP** | 运维向；文案避免吓退学员 |

### 2.6 自由画布 / 添加菜单 / 叠盖（G5 / G6 / P3）

| 模块 | 路径 | 裁决 | 改法锚 |
| --- | --- | --- | --- |
| 画布壳 / 节点原语 | `pages/canvas/*`、`components/canvas/canvas-node*.tsx` | **KEEP** | 专家层能力；方案明确不 Toonflow 化默认壳 |
| 添加菜单 UI | `canvas-create-menu.tsx` | **KEEP 组件** | 分区（创作节点/工作流/导入）结构可留 |
| 一级命令源 | `add-node-menu-tools.tsx` + `LOCAL_CREATE_PRESETS` | **REPLACE 一级语义** | 现挂「本地·H3/Wan/…」为节点类型 → 改为 文本/图像/视频/音频/合成/分组；**模型进节点设置**（融光/printfilm/LMD） |
| 图像设置 Popover | `canvas-image-settings-popover.tsx`（fixed portal） | **OPTIMIZE→趋向 REPLACE 交互** | 大浮层盖节点（G5）→ 右侧检视器或节点内 `nodrag` 展开（LocalMiniDrama） |
| `canvas-node-prompt-panel` 等 | 多浮层 | **OPTIMIZE** | 同 G5；统一 z 与停靠策略 |
| 模型配置 / local-compute | `settings/local-compute-pane.tsx` | **KEEP** | 端口出现在**设置**合理；与产品面徽章分离 |
| `/create` 页 | `pages/create` | **OPTIMIZE** | 可作工具/专家入口；勿与短剧主 CTA 争权 |
| `/project` 媒体项目 | projects 路由簇 | **OPTIMIZE** | 与「短剧项目」一词一义；避免双「项目」 |

### 2.7 智能体 / 媒体库 / 设置

| 模块 | 裁决 | 说明 |
| --- | --- | --- |
| `/toiv/agent` + runs | **KEEP** | 人闸/对话入口；任务 Create 应并入此处而非任务中心 |
| `/library` + works | **KEEP** | R18 fail-closed 注释清晰 |
| `/settings` channels | **KEEP** | 模型进设置（方案正面教材） |
| 外部 Agent `/agents` | **KEEP**（高级分组已有） | 默认收起 ✓ |

### 2.8 apps/admin

| 模块 | 路径 | 裁决 | 说明 |
| --- | --- | --- | --- |
| AdminView Tabs | 用户/作业/模型/… | **KEEP** | 作业队列 + 模型资产 = 运维真源 |
| JobsQueue / ModelAssets / Fleet API | | **KEEP** | 端口、worker、探测属于 admin，**不要**为「干净」删掉 |
| OrchPanel / SystemJobs / Observability | | **KEEP** | 与创作者壳隔离正确（printfilm 后台分治） |
| AppsManager 等 | | **KEEP** | 市场应用运营 |

**Admin 不在 P1 创作者 IA 改造范围；无需 REPLACE。**

### 2.9 MiniProgram

| 模块 | 裁决 | 说明 |
| --- | --- | --- |
| 原生 Tab：创作/市场/作业/作品库/我的 | **KEEP（短期）** | 与桌面「工具箱」命名可后续统一为「工具」 |
| `pages-sub/studio` web-view → `/studio/` | **KEEP** | C6 正确策略：移动端不重做六段 UI |
| Agent runs 页 | **KEEP** | |
| 是否为大改对象 | **P1–P3 不动** | 桌面 IA 稳定后再：① 深链到 `/studio/toiv/drama` ② Tab 文案一词一义；**禁止**小程序内再实现一套阶段轨 |

---

## 3. 痛点 → 代码锚点 → 阶段

| 痛点 | 代码锚点 | 建议阶段 | 裁决 |
| --- | --- | --- | --- |
| G1 入口三重镜像 | `home-dashboard` + `beefTVCapabilityItems` + `homeIntentBarItems` + sidebar | P1 | OPTIMIZE |
| G2 状态中英混 | tasks 已中文；drama `STATUS_TONE` 键仍英文 | P1–P2 | OPTIMIZE |
| G3 任务中心 Create | `tasks-page.tsx` L309「新建智能体任务」 | P1–P2 | OPTIMIZE |
| G4 `/toiv/tasks` 深链 | web 托管 `/studio/toiv/tasks`；裸 `/toiv/tasks` 依赖网关 | P1 | OPTIMIZE（网关/登录回跳，非重写页） |
| G5 叠盖 | `canvas-image-settings-popover` fixed portal 等 | P3 | OPTIMIZE→交互 REPLACE |
| G6 引擎进添加菜单 | `LOCAL_CREATE_PRESETS` × `add-node-menu-tools` | P3 | **REPLACE 一级语义** |
| G7 Tabs↔画布双心智 | drama-workspace vs /canvas | P2–P3 | OPTIMIZE + 新增双视图投影 |
| G9 正在开发 | 添加菜单 developing badge；sidebar 机制保留 | P1–P2 | OPTIMIZE |
| G10 端口外露 | `LocalBadges` `label={badge.worker}`；`local-model-defaults` `:8264` 等 | P1 | OPTIMIZE（撤产品徽章；设置保留） |

---

## 4. 明确「不要做」的 REPLACE

| 反模式 | 为何禁止 |
| --- | --- |
| 把默认壳换成 Toonflow/TapCanvas/waoowaoo 进门即画布 | 方案 §0/§8.2；学习站完成率证据相反 |
| 重写 `drama-workspace` 为纯 xyflow | 六段已含配音/合成；应 Stage 化而非推倒 |
| 删掉 admin / local-compute 端口 | 本地舰队运维需要；只从**创作者默认面**撤 |
| 在 apps/web 复活 SideRail 第二壳 | F9/F12 已切 studio |
| P1 大改 MiniProgram 原生短剧 UI | web-view 已接 studio |

---

## 5. 与方案拍板包对齐（审计结论）

推荐包 **D1-A + D2-A + D3-A + D4-C**（及 §12 D5–D8）在前端的落点：

| 拍板 | 前端落点 |
| --- | --- |
| D1-A 阶段轨默认 | 改 home CTA + sidebar 权重；**KEEP** `/toiv/ws` |
| D2-A 双视图投影 | **新增**短剧内流水线视图；画布短剧空态仅专家 |
| D3-A 工具台拆权 | **KEEP** `/toiv/market`；单工具页归属工具台；侧栏一词 |
| D4-C 站内合成 | workspace「成片/时间线」已有合成 CTA → P2 强化预览，不换页 |
| D6-A 声画阶段 | workspace 镜头段配音 **KEEP**，Phase 文案显式「配音→口型」 |
| 添加菜单 | **REPLACE** presets 一级；能力仍走市场/节点设置 |

---

## 6. 建议改造优先级（仅前端壳，人天与方案 P 对齐）

1. **P1**：首页 1 CTA；侧栏重排；任务 Create 迁出；LocalBadges 去端口；主路径无 developing 死钮。  
2. **P2**：drama-workspace Phase 文案与 ready 态；任务回跳；合成预览强化。  
3. **P3**：添加菜单创作语义；参数右侧检视器；可选流水线双视图。  
4. **Admin / MP**：本审计周期 **KEEP**；MP 仅随桌面深链文档更新。

---

## 7. 产物与局限

- 本报告：**只读审计**；未改代码、未 commit、未部署。  
- 未做现网截图像素级叠盖复现（叠盖结论来自 `fixed` portal 结构与方案已验证痛点）。  
- 公网 404 需结合网关/登录回跳（web 托管路径为 `/studio/toiv/tasks`），属 P1 联调项。

**落盘：**

- 本机：`docs/ux/research/AUDIT_C_FRONTEND_SHELL_20261022.md`
- Box：`/workspace/refs/competitive-deep/AUDIT_C_FRONTEND_SHELL_20261022.md`
