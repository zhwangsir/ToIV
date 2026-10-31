# APP SHELL · M2 Handback（首批 App 真封装）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**）
- **状态**：**仅工作树**（禁 commit / push / deploy / reset / clean）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **叠树**：A0–A6 + A4.1 + B1 + M1 + **M2**
- **配色锁**：A6 黑白壳 + accent `#4A7FC1`；themeId 默认 `toiv-noir`
- **TL 增量并入**：工程/路由/`--toiv-*` **本波不改名**；对外新字符串可用占位「工作台 / Desktop」；移动端本波不实现（见后波）

---

## 本刀做了什么

### 1. 首批 App 真封装（单例进窗）

| id | 名 | 入口 | chrome |
|---|---|---|---|
| `create` | 创作 | `/create` | creation（窗内 AppWorkspaceShell） |
| `drama` | 短剧项目 | `/toiv/drama` | sidebar |
| `tasks` | 任务中心 | `/tasks` · `/toiv/tasks` | sidebar |
| `market-tools` | 工具台 | `/toiv/market` | sidebar |
| `settings` | 设置 | `/settings` | sidebar |
| `library` | 媒体库 | `/library` | sidebar |

- 打开路径：桌面图标 / 开始 / 任务栏钉选 / 应用商店「打开」/ **窗内侧栏** → `openApp` + `navigate(entry)`
- 单例：同 `appId` 只一窗；再开 = 聚焦 + 更新 `entry`
- Catalog 常量：`M2_ENCAPSULATED_APP_IDS`

### 2. AppWorkspaceShell 仅窗内 · 无双壳

- 根壳仍是 `DesktopShell`（方案 A）
- `AppWorkspaceShell` 只在**前台窗** `wrapWithAppChrome`；桌面 `/` 不套侧栏
- 标注 `data-window-chrome="1"`；`h-full`（非根 `h-dvh`）
- B1 密度 `250/67/56` 只进窗内 chrome

### 3. 深链 URL ↔ 窗态

- `syncDesktopRoute`：路径 → 单例聚焦 / 还原最小化 / 更新 `entry`
- Shell 改为 **`useLayoutEffect`**，减轻首帧无窗
- 侧栏 App 链 `preventDefault` + `onDesktopLaunch`（先 `openApp` 再 `navigate`）
- 「首页」文案占位改为 **「桌面」**（对外可用「工作台 / Desktop」；等用户钉名再统一）

### 4. 卸载语义

- **可卸预装 4**（画布库 / 新建画布 / 外部 Agent / 学习看板）：卸载 = 从 `installed` 删除 + 摘 placements/taskbar/folders + 关窗 → **桌面图标消失**
- **system**：卸载 = `hidden: true`（仅隐藏）
- 任务栏钉选只显示 `installed && !hidden`
- 侧栏「高级」可卸项随卸载从列表消失；一级系统五项始终保留

### 5. 明确不做（本波）

皮肤包、窗拖缩放、L2、文件夹 UI、`wf:` 上架、B2 create 大改、移动端 Launcher、仓/CSS `--toiv-*` 改名。

---

## 改动文件面

| 路径 | 作用 |
|---|---|
| `apps/canvas/web/src/lib/desktop/catalog.ts` | `M2_ENCAPSULATED_APP_IDS`；canvas-lib match 收紧 |
| `apps/canvas/web/src/stores/use-desktop-store.ts` | 深链同步优化；卸载焦点落到下一可见窗；`isDesktopAppVisible` |
| `apps/canvas/web/src/components/desktop/desktop-shell.tsx` | M2 注释；`useLayoutEffect` 深链；`data-desktop-shell="m2"` |
| `apps/canvas/web/src/components/desktop/desktop-taskbar.tsx` | 钉选过滤已装可见 |
| `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx` | 桌面启动；可卸过滤；「桌面」占位文案 |
| `apps/canvas/web/src/components/layout/app-top-nav.tsx` | 窗内 chrome 标注 |
| `apps/canvas/web/src/pages/desktop/app-store-page.tsx` | 卸载文案澄清 |
| `apps/canvas/docs/APP_SHELL_M2_HANDBACK.md` | 本交接 |
| `apps/canvas/docs/shots/fixture-m2-*.html` · `m2-*.png` | FIXTURE |

**继承 M1（未回退）**：DesktopShell 根、预装 11、商店、toiv.desktop.v1、themeId、窗管最小集。

**未动**：B2 create；后端 NSFW；未登录门面；commit/push/deploy；`--toiv-*` / 路由改名。

---

## 截图（FIXTURE · 非现网硬刷 · 1280）

| 场景 | 路径 |
|---|---|
| 桌面开创作 | `apps/canvas/docs/shots/m2-create-open.png` |
| 任务最小化并行 | `apps/canvas/docs/shots/m2-task-minimized.png` |
| 卸载一可卸 App | `apps/canvas/docs/shots/m2-uninstall.png` |

源 fixture：`fixture-m2-create-open.html` / `fixture-m2-task-minimized.html` / `fixture-m2-uninstall.html`

---

## 残点 / 挂账

| 项 | 说明 |
|---|---|
| 后台窗保活真实路由树 | 仍「挂起」占位；切回再 navigate |
| 深链自动 ensure-install | 访问已卸可卸 App 路由仍可能经 `openApp` 装回；桌面以 installed 为准 |
| 窗拖拽/缩放 | bounds 固定；后波 |
| 皮肤包 XP/mac/98 | 仅 `themeId` 预留 |
| 文件夹 UI / 图标拖放 | 模型有 folders；UI 未做 |
| `wf:` 上架包装 | 分轨保留 |
| B2 create 表面 | 仍停 |
| L1/L2 持久化 | M1 L0 only |
| 现网硬刷 | 等用户；本刀 FIXTURE |
| 对外品牌钉名 | 占位「工作台 / Desktop」；仓/`--toiv-*` 另波需口令 |
| **移动端（后波）** | 手机 ≠ 缩小 DesktopShell；= **Launcher**（已装网格）+ **单 App 全屏**；共享账号 / content_mode / catalog；多窗 z 栈与皮肤像素级**不进**手机。口径：`/workspace/beeftv-primary/TL_REBRAND_AND_MOBILE.md`（P-mobile-0/1） |
| M1 挂账 | FeaturedWorks / 历史截图色差 / director-sequencer 蓝边 等仍挂 |

---

## 自检

- [x] tip 仍 **`0a426713`**
- [x] 禁 commit / push / deploy
- [x] 首批 6 App 真封装 + 单例
- [x] AppWorkspaceShell 仅窗内；桌面无双壳
- [x] 深链 URL↔窗态；侧栏经桌面启动
- [x] 可卸卸载后桌面消失；system 仅隐藏
- [x] 未做皮肤/拖缩放/L2/文件夹/wf/B2/移动端
- [x] FIXTURE 三张 1280
- [x] 工程/路由/`--toiv-*` 未改名

**停手等 TL 审。**
