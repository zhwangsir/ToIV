# Cosmos App Shell 种子（从 ToIV 脏树保留）

- **日期**：2026-10-28（Asia/Shanghai）
- **归属**：未来 **Cosmos 创作终端** 新项目；**不是** ToIV 默认交付
- **ToIV 现状**：登录后根壳 = `AppWorkspaceShell`（工作室）；本种子**默认不挂**

## 种子目录（勿删）

| 路径 | 内容 |
|---|---|
| `web/src/lib/desktop/` | catalog / types / backup（`toiv.desktop.v1` + 喵咛宽松导入） |
| `web/src/components/desktop/` | DesktopShell、icons、start-menu、taskbar、window |
| `web/src/pages/desktop/` | DesktopHomePage、AppStorePage |
| `web/src/stores/use-desktop-store.ts` | 窗管 + installed/hidden + themeId |
| `web/src/styles/desktop-shell.css` | 桌面 chrome（皮肤只动壳，App 内容仍 BeefTV+A6） |
| `docs/APP_SHELL_M0_MAP.md` … `APP_SHELL_M2_1_HANDBACK.md` | 设计与验收记录 |
| `docs/shots/m1-*.png` / `m2-*.png` 等 | FIXTURE 截图 |

## 路由（COSMOS_SEED · W6 断默认可达）

ToIV **默认不可达**：`/desktop*` 一律 `<Navigate to="/create" replace />`（web 薄壳裸 `/desktop*` 308 → `/studio/create`）。

源码页 **保留不删**（迁出 / 本地再挂时用）：

- `pages/desktop/desktop-home-page.tsx`
- `pages/desktop/app-store-page.tsx`
- `components/desktop/*`、`lib/desktop/*`、`stores/use-desktop-store.ts`

ToIV 默认：`/` → `/create`；根壳 = `AppWorkspaceShell`。**禁**把 DesktopShell 接回默认交付。

## 如何再挂 DesktopShell（Cosmos / 实验）

1. `UserLayout`：将 `AppWorkspaceShell` 换回：
   ```tsx
   import { DesktopShell } from "@/components/desktop/desktop-shell";
   // …
   <div className={cn(..., "is-desktop-host")}>
     <DesktopShell>{children}</DesktopShell>
   </div>
   ```
2. `router.tsx`：把 `/desktop`·`/desktop/store`·`/desktop/legacy-home` 从 Navigate→`/create` 改回挂 Desktop 页；可选将 `/` 指回 `DesktopHomePage`（或 Cosmos 自有桌面页）。
3. 可选：恢复侧栏 `onDesktopLaunch` / `useDesktopStore`（见 git 历史 M2 差分，或从本种子 handback 复原）。
4. 品牌：Cosmos 新项目把开始菜单 / `document.title` 换成「Cosmos 创作终端」；**勿**回改 ToIV 默认对外名。
5. 定名勿撞：OS 商店 = `app-store`；`/toiv/market` = 工具台 `market-tools`；Comfy/RH = `wf:`。

## 与 ToIV 锁的关系

再挂时 **App 窗内**仍应遵守：

- A6：黑白壳 + accent `#4A7FC1`（CTA/选中/playhead/focus）
- B1：侧栏型 App chrome `250 / 67 / 56`
- 禁：会员锁主题、玩笑广告、跳出登录墙；皮肤只动 DesktopShell chrome

## 迁出建议

新仓可整树拷贝上表路径 + handback；ToIV 收口后由 TL 决定是否从默认树删除（删除前确认 Cosmos 已接手）。
