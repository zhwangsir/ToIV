# APP SHELL · M0 Map（只读对照）

- **日期**：2026-10-28（Asia/Shanghai）
- **范围**：**仅 M0 只读**；**未改**产品 TS/CSS；禁 commit / push / deploy / reset / clean；**未开 M1**
- **tip**：`0a426713`（分支 `work/p0-fusion-20261016`，脏树叠 A0–A6+A4.1+B1）
- **主体改钉**：登录后 Home = **喵咛式系统桌面 + 应用市场**；能力封装为可装「软件」；App 窗口内表面 = **BeefTV 密台 + A6**（黑白 + accent `#4A7FC1`）；B1 密度 `250/67/56` 可作侧栏型 App 内部 chrome
- **禁**：Win98 皮、玩笑广告、会员锁主题、应用跳出外链登录墙；B2 create 大改暂停；后端 NSFW 不动；未登录门面本波不动

---

## 0. 证据源与假设

| 源 | 路径 / 说明 |
|---|---|
| 路由表 | `apps/canvas/web/src/router.tsx` |
| 侧栏 IA | `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx`（一级死令五项） |
| 根壳 | `layouts/user-layout.tsx` → `AppWorkspaceShell`（`components/layout/app-top-nav.tsx`） |
| Home 现态 | `pages/home/` = **工作台仪表盘**（短剧列表 + 能力轨），**不是** OS 桌面 |
| B0/B1 | `FULL_SHELL_TEARDOWN_BEEFTV_B0_MAP.md` / `…_B1_HANDBACK.md` |
| TL brief（box） | `/workspace/beeftv-primary/TL_APP_SHELL_BRIEF.md` |
| 既有「应用」API | `apps/api/.../apps.py` = **Comfy/RunningHub 工作流应用市场**（≠ 本波 OS App Catalog） |
| 既有插件安装态 | `stores/use-plugin-store.ts`（localForage `installations[]`）可作 **安装态持久化参照**，勿与 OS App 混名 |
| **喵咛参考仓/截图** | MateBook / box / Desktop / ALLProject **未找到**名为「喵咛」的仓或 backup 样例；公开检索亦未落到可引用的 `installed/folders/placements` schema |

> **假设（标 `ASSUME`）**：喵咛 backup 至少含 `installed` / `folders` / `placements`（及可选 `taskbar` / `wallpaper`）；M0 按此三字段 + TL 口径建模。M1 若拿到真实 backup JSON，以实样校正字段名，不改产品能力语义。

---

## 1. 现有路由 → 候选 App 清单

### 1.1 命名约定

- `id`：稳定、kebab；安装/布局 JSON 主键
- `entry`：现 SPA 路由（M1 窗内仍用同一路由树，避免双实现）
- `chrome`：窗口内是否带 BeefTV 侧栏型 chrome（250/67/56）
- `preinstall`：出厂钉在桌面 / 开始菜单（用户可卸载非系统级；系统级标 `system: true` 仅可隐藏）

### 1.2 默认预装（系统级 · 建议 7）

| id | 名 | 入口路由 | chrome | 默认预装 | 备注 |
|---|---|---|---|---|---|
| `create` | 创作 | `/create` | 可选侧栏（现 `is-creation-workspace` 特例） | ✅ system | 一级；窗可最大化；B2 表面仍停 |
| `drama` | 短剧项目 | `/toiv/drama` | 侧栏型 | ✅ system | 子路由 `/toiv/drama/:id`、workspace 同 App 内导航 |
| `tasks` | 任务中心 | `/tasks`（别名 `/toiv/tasks`） | 侧栏型 | ✅ system | |
| `market-tools` | 工具台 | `/toiv/market` | 侧栏型 | ✅ system | **产品工具箱**；≠ OS「应用商店」 |
| `settings` | 设置 | `/settings` | 侧栏型 | ✅ system | |
| `library` | 媒体库 / 作品 | `/library` | 侧栏型 | ✅ system | 含 `/library/works/:id` |
| `app-store` | 应用商店 | `/desktop/store`（**新建 · M1**） | 桌面浮层或独立窗 | ✅ system | 安装→桌面 / 卸载 / 已安装；**非** `/api/apps` |

### 1.3 默认预装（用户可卸 · 建议 4）

| id | 名 | 入口路由 | chrome | 默认预装 | 备注 |
|---|---|---|---|---|---|
| `canvas-lib` | 画布库 | `/project`（=`/canvas` 列表） | 侧栏型 | ✅ | 高级导航现有项 |
| `canvas-new` | 新建画布 | `/canvas?mode=new` | 无侧栏（进编辑器后 hideChrome） | ✅ | 打开后常进 `/canvas/:id` 全屏编辑 |
| `agents` | 外部 Agent | `/agents` | 侧栏型 | ✅ | |
| `kpi` | 学习看板 | `/toiv/kpi` | 侧栏型 | ✅ | 现「高级」 |

### 1.4 目录可装（非默认预装 · 建议 6+）

| id | 名 | 入口路由 | chrome | 默认预装 | 备注 |
|---|---|---|---|---|---|
| `plugins` | 插件中心 | `/plugins` | 侧栏型 | ❌ | feature `pluginCenterEnabled` |
| `plugins-eagle` | Eagle 素材库 | `/plugins/eagle` | 侧栏型 | ❌ | 依赖插件 |
| `home-legacy` | 经典工作台 | `/` 旧仪表盘视图或 `/desktop/legacy-home` | — | ❌ | Home 改桌面后，旧仪表盘可作可选 App（挂账） |
| `voice-lab` | 录音测试 | `/test-voice-recording` | 侧栏型 | ❌ | 偏实验室 |
| `dev-*` | DEV 实验室 | `/dev/*` | 全屏 | ❌ | 仅 DEV 构建；勿进生产商店 |
| `workflow-apps` | 工作流应用（RH/Comfy） | 现 market 内 runner / 未来深链 | 窗内嵌 | ❌ **catalog 分轨** | 继续走 `/api/apps`；商店 UI 可「推荐」但 **id 空间隔离**（前缀 `wf:`） |

### 1.5 路由处理策略（非独立 App）

| 路由 | 策略 |
|---|---|
| `/` | **变为桌面**（Desktop Host）；不再渲染现 HomeDashboard 为默认 |
| `/create/*`、`/toiv/ws/*`、`/toiv/runs/:id`、工具别名重定向 | 保持 redirect → 已有 App |
| `/assets`、`/toiv/library*`、`/skills*` | 已有 Navigate；不单列 App |
| `/canvas/:id` | **全屏编辑器**：`AppWorkspaceShell.hideChrome` 已成立；窗管层「最大化」即此态 |
| `/admin*` | 运营后台；**不进**用户桌面商店 |
| `/login` `/register` | 未登录门面；本波不动 |

**计数摘要**：候选 **17** 条（系统预装 7 + 可卸预装 4 + 目录可装 6）；其中 **默认预装合计 11**（7 system + 4 user）。工作流 `wf:*` 另轨，不计入 OS App 主键数。

---

## 2. 桌面状态模型草案（local → 可升账号同步）

### 2.1 顶层文档（导出/导入 JSON）

```ts
// ASSUME · 学喵咛 backup；字段名可在拿到实样后别名映射
type DesktopBackupV1 = {
  version: 1;
  exportedAt: string;           // ISO
  schema: "toiv.desktop.v1";
  installed: InstalledApp[];    // 已安装（含预装）
  folders: DesktopFolder[];     // 桌面文件夹（图标分组）
  placements: Placement[];      // 图标/文件夹在桌面网格上的位置
  taskbar?: TaskbarState;       // 可选：钉选顺序
  prefs?: DesktopPrefs;         // 壁纸/主题跟随 A6；禁会员锁主题
};
```

### 2.2 核心类型

```ts
type InstalledApp = {
  id: string;                   // = catalog id
  installedAt: string;
  source: "preinstall" | "store" | "import";
  hidden?: boolean;             // system App 卸载=隐藏
  pinnedToTaskbar?: boolean;
};

type DesktopFolder = {
  id: string;
  name: string;
  appIds: string[];             // 文件夹内图标
};

type Placement = {
  targetId: string;             // app id 或 folder id
  kind: "app" | "folder";
  col: number;
  row: number;
  monitor?: 0;                  // M1 单屏；预留
};

type TaskbarState = {
  order: string[];              // app ids
  showStore: true;
  showStart: true;
};

type DesktopPrefs = {
  iconSize: "sm" | "md" | "lg";
  // wallpaper: 仅本地资源或纯色；禁付费主题包
};
```

### 2.3 运行时窗态（**不进** backup 默认导出）

```ts
type WindowInstance = {
  instanceId: string;           // 同 App 可多窗时用
  appId: string;
  entry: string;                // 当前路由/深链
  state: "normal" | "minimized" | "maximized";
  bounds?: { x: number; y: number; w: number; h: number };
  z: number;
  title?: string;
};

type SessionWindows = {
  stack: WindowInstance[];
  focusedId: string | null;
};
```

> 导出可选开关「包含打开窗口」；默认 **仅** installed/folders/placements/taskbar，避免机器相关坐标污染迁移。

### 2.4 持久化分层

| 层 | 存哪 | 内容 | 同步 |
|---|---|---|---|
| L0 本机立即 | scoped localForage / `localStorage` key `toiv:desktop:v1` | backup 文档 + session windows | 默认 |
| L1 桌面应用数据目录 | Go `system_settings` 或旁路 JSON（对齐 local-model-config 模式） | 同 L0 快照 | 桌面 profile |
| L2 账号同步（后波） | 用户云端 prefs API（**未建**） | installed/folders/placements | 需登录；冲突= LWW + 导出兜底 |

**安装/卸载语义**：商店「安装」= `installed` 追加 + 默认 `placements` 空位；「卸载」= 非 system 删除，system 改 `hidden`；同时从 taskbar/folders 摘除。

**与现有系统边界**：

| 现有 | 关系 |
|---|---|
| `use-plugin-store` installations | **并行**；插件 ≠ 桌面 App（可后续「包装为 App」深链） |
| `/api/apps` 工作流市场 | **分轨** `wf:`；不可覆盖 OS `installed` |
| HomeDashboard / beefTVCapabilityItems | M1 退役为桌面图标数据源之一或迁入 catalog |

---

## 3. 窗管最小集

| 动作 | 行为 | UI |
|---|---|---|
| **打开** | 若已有同 `appId` 单例窗 → 聚焦；否则 `stack.push`（`state=normal` 或 `maximized` 按 App 清单）并导航 `entry` | 桌面双击 / 开始菜单 / 商店「打开」/ 深链 |
| **聚焦** | `focusedId=`；`z = maxZ+1` | 点窗口标题栏 / 任务栏按钮 |
| **最小化** | `state=minimized`；焦点落到下一可见窗或桌面 | 窗控件 / 任务栏再点可还原 |
| **关闭** | 移出 `stack`；可选确认（脏编辑挂账 create/canvas） | 窗控件 |
| **最大化** | `state=maximized`；占满 Desktop Host 客户区（可保留 任务栏） | 窗控件；`/canvas/:id` 等价全屏无侧栏 |
| **任务栏按钮** | 每个可见/最小化实例一钮；点击=聚焦或还原；中键/右键关闭（M1 可只左键） | 底栏 |

**非目标（M0/M1 不做）**：真 OS 多桌面、窗口吸附分屏、Win98 标题栏皮肤、跨浏览器原生多窗。

**与路由关系（建议）**：窗内用 **同一 React Router**；`WindowHost` 渲染 `Outlet` 或按 `instance.entry` 挂页面组件。M1 可先 **单前台窗 + 后台挂起**（简化），再演进多实例；最小集 API 仍按上表留口。

---

## 4. 与现 `AppWorkspaceShell` 关系

### 方案对比

| 方案 | 做法 | 利 | 弊 |
|---|---|---|---|
| **A. 壳外层改桌面（推荐）** | 新 `DesktopShell` 取代 `AppWorkspaceShell` 为 `UserLayout` 根：底=桌面+任务栏+开始+商店；**App 在 Desktop 客户区开窗**；`AppWorkspaceShell` **降级**为「侧栏型 App 窗口内 chrome」（密度沿用 B1 250/67/56） | 一眼系统桌面；无「侧栏透出桌面下」；与喵咛 IA 一致；BeefTV 密台仍在 App 内 | 改动面中等；路由 `/` 语义变；需迁 hideChrome / creation 特例 |
| **B. 桌面盖在 home 上** | 保留 `AppWorkspaceShell`；仅 `/` 的 stage 换成桌面组件 | 改动最小；B1 壳可暂留 | 侧栏+顶栏仍在 → **双壳**；不像系统桌面；与「停多仓拼壳 / 主体改钉」冲突 |
| **C. 并行双根** | `/desktop` 新根，`/` 旧工作台 | 可 A/B 测试 | 两套入口；用户困惑；不推荐默认 |

### 推荐（一句话）

**采用方案 A：登录后根壳改为 DesktopShell；AppWorkspaceShell 只作侧栏型 App 的窗内 chrome，不再包住桌面。**

### 与 B0/B1 关系

- B0/B1 钉死的 **BeefTV 密台 + A6 色 + 密度 250/67/56 + dock-only + 灰阶 nav** → **继承为 App 窗口内**，不回退。
- 桌面本身：近黑底 + 灰阶图标标签；**accent `#4A7FC1` 仅** 商店主 CTA / 焦点环 / 运行中指示（≤10%），禁整桌刷蓝、禁 cyan 霓虹。
- B2 create 仍停；create 作为 App 打开时沿用现三栏几何。

---

## 5. 喵咛 backup 字段对照（ASSUME）

| 喵咛（口径/假设） | ToIV `toiv.desktop.v1` | 说明 |
|---|---|---|
| `installed` | `installed[]` | id + 元数据 |
| `folders` | `folders[]` | 桌面分组 |
| `placements` | `placements[]` | 网格坐标 |
| （常见）taskbar pins | `taskbar.order` | 可选 |
| （常见）wallpaper | `prefs` | 禁会员锁主题包 |

无实样前 **不宣称**字段名 100% 兼容；导入器做宽松映射 + version gate。

---

## 6. 风险 / 开放问题（卡点给 TL）

1. **喵咛实样缺失**：本机无仓/截图；backup schema 为 ASSUME——若用户有导出 JSON，请丢进箱再校正 M1。
2. **`/api/apps` 品牌碰撞**：「应用市场」文案 vs 工作流应用市场——建议 OS 侧称「应用商店 / 桌面应用」，工作流保留「工具台 / 工作流」。
3. **旧 Home 仪表盘去留**：改桌面后短剧列表入口是否做成预装 App 或桌面小部件？（建议：桌面「短剧」图标进 `drama`，列表在 App 内；不设小部件 M1。）
4. **多窗 vs 单前台**：M1 先单前台是否够用？（创作+任务并行是刚需 → 建议 M1 至少支持 2–3 窗最小化。）
5. **canvas 全屏与窗管**：`/canvas/:id` 已 hideChrome；最大化是否隐藏任务栏？（建议：**保留任务栏**，避免困在编辑器。）
6. **账号同步 API**：L2 未建；M1 只做 L0/L1 + 导出/导入。
7. **与「影视飓风」未登录门面**：本波不动；避免 DesktopShell 泄漏到登录前。

---

## 7. 建议波次（等 TL 放行 M1）

| 波 | 内容 |
|---|---|
| **M0** | 本对照表（✅） |
| **M1** | DesktopShell 骨架：桌面网格 + 开始 + 任务栏 + 应用商店；状态 L0；窗管最小集；预装图标；导出/导入 JSON；**禁** Win98/广告/会员锁 |
| **M2** | 首批 App 封装（创作/短剧/任务/工具/设置/媒体库）；AppWorkspaceShell 窗内化；深链与单例策略 |
| 后 | L2 同步、文件夹、多实例、工作流 `wf:` 上架包装 |

---

## 交付自检

- [x] 路径：`apps/canvas/docs/APP_SHELL_M0_MAP.md`
- [x] 含：路由→App 清单 / 状态模型 / 窗管最小集 / AppWorkspaceShell 关系（推荐 A）
- [x] 附：喵咛字段 ASSUME 对照、B0/B1 关系、风险开放问题
- [x] **未改**产品码；未开 M1；未 commit/push/deploy
- [x] tip 仍 **`0a426713`**

**停手等 TL 放行 M1。**
