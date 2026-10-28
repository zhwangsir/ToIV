# APP SHELL · M2.1 Handback（禁已卸静默装回）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**）
- **状态**：**仅工作树**（禁 commit / push / deploy / reset / clean）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **叠树**：A0–A6 + A4.1 + B1 + M1 + M2 + **M2.1**
- **配色锁**：A6 黑白壳 + accent `#4A7FC1`；themeId 默认 `toiv-noir`
- **品牌钉名（TL）**：**Cosmos 创作终端**（简称 Cosmos）
  - 本波仅替换碰到的占位/眉题（开始菜单头）
  - **仍禁**：改仓名、路由前缀、`--toiv-*`、域名、全站改名扫

---

## 本刀做了什么

### 1. 可卸未装：深链 / 侧栏 / openApp **不得**静默装回

| 入口 | 行为 |
|---|---|
| `openApp` | `!def.system && !installed` → **return null**；设 `notice` toast「「{名}」未安装」；**不**调用 `installApp` |
| `syncDesktopRoute` | 无现窗时调 `openApp`；失败 → `{ status: "denied", reason: "not_installed" }` |
| `DesktopShell` | denied → `navigate(/desktop/store?app=<id>, { replace: true })` + 顶部 toast |
| 侧栏 `onDesktopLaunch` | `openApp` 失败 → 跳商店 `?app=`，不 `navigate` 到已卸路由 |
| 桌面 `launch` | 同上 |

桌面图标 / 任务栏钉选仍以 `installed && !hidden` 为准 → **已卸可卸不会因深链回潮**。

### 2. system + hidden：选定 **A**

- **A（本波）**：取消 `hidden` 再开（走既有 `installApp` unhide）
- 未选 B（保持隐藏须商店「显示」）——因 M2 `installApp`/`openApp` 已是 A 路径，与推荐一致

### 3. 应用商店

- 支持 `?app=<id>` 高亮对应卡片（`is-focus` +「未安装（深链未装回）」文案）
- 开始菜单眉题：`Cosmos 创作终端`（仅 chrome 文案；工程 id 仍 `toiv-*`）

### 4. 明确不做

后台窗真保活、拖缩放、皮肤包、文件夹、wf:、L2、B2、移动端、全站改名、commit。

---

## 改动文件面

| 路径 | 作用 |
|---|---|
| `apps/canvas/web/src/stores/use-desktop-store.ts` | openApp 拒装回；notice；sync 返回 denied；system hidden→A |
| `apps/canvas/web/src/components/desktop/desktop-shell.tsx` | denied→商店；toast；`data-desktop-shell="m2.1"` |
| `apps/canvas/web/src/components/layout/workspace-sidebar-nav.tsx` | 侧栏启动拒装回 |
| `apps/canvas/web/src/pages/desktop/app-store-page.tsx` | `?app=` 高亮 |
| `apps/canvas/web/src/components/desktop/desktop-start-menu.tsx` | 眉题 Cosmos 创作终端 |
| `apps/canvas/web/src/styles/desktop-shell.css` | toast + focus card |
| `apps/canvas/docs/APP_SHELL_M2_1_HANDBACK.md` | 本交接 |
| `apps/canvas/docs/shots/fixture-m2_1-uninstalled-deeplink.html` · `m2_1-uninstalled-deeplink.png` | FIXTURE |

**未动**：B2 create；后端 NSFW；仓/路由/`--toiv-*`；appearance 默认 brandName（全站改名另波）；commit/push/deploy。

---

## 截图（FIXTURE · 非现网硬刷 · 1280）

| 场景 | 路径 |
|---|---|
| 已卸可卸深链不回桌面图标 | `apps/canvas/docs/shots/m2_1-uninstalled-deeplink.png` |

源 fixture：`fixture-m2_1-uninstalled-deeplink.html`

示意：桌面无「学习看板」；toast「未安装」；商店 `kpi` 卡片高亮「安装」；URL 文案标明 `/toiv/kpi` → `/desktop/store?app=kpi`。

---

## 残点 / 挂账

| 项 | 说明 |
|---|---|
| 后台窗保活真实路由树 | 仍「挂起」占位 |
| 窗拖拽/缩放 | bounds 固定 |
| 皮肤包 XP/mac/98 | 仅 `themeId` 预留 |
| 文件夹 UI / 图标拖放 | 模型有；UI 未做 |
| `wf:` 上架包装 | 分轨 |
| B2 create 表面 | 仍停 |
| 移动端 Launcher | 后波 |
| 全站 Cosmos 改名 | appearance/`document.title`/未登录门等另开改名波；本波仅开始菜单眉题 |
| 现网硬刷 | 未做 |

---

## 自检

- [x] tip 仍 `0a426713`
- [x] 可卸不在 installed → openApp/深链/侧栏不装回、不建窗
- [x] system+hidden 选定 **A**
- [x] 桌面图标不因深链回潮（FIXTURE）
- [x] 禁 commit/push/deploy
