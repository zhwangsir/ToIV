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

## 路由（COSMOS_SEED）

当前仍注册（便于迁出前本地验种子），**不作** ToIV 登录落地：

- `/desktop` → DesktopHomePage
- `/desktop/store` → 应用商店
- `/desktop/legacy-home` → 旧工作室 Home（兼容）

ToIV 默认：`/` → `HomePage` + `AppWorkspaceShell`。

## 如何再挂 DesktopShell（Cosmos / 实验）

1. `UserLayout`：将 `AppWorkspaceShell` 换回：
   ```tsx
   import { DesktopShell } from "@/components/desktop/desktop-shell";
   // …
   <div className={cn(..., "is-desktop-host")}>
     <DesktopShell>{children}</DesktopShell>
   </div>
   ```
2. `router.tsx`：将 `/` 指回 `DesktopHomePage`（或 Cosmos 自有桌面页）；工作室 Home 可挂 `/desktop/legacy-home` 或 App 内。
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
