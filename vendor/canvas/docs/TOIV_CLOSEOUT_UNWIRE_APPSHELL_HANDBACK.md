# ToIV 收口 · 拆 App Shell 默认路径 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**；本波仅本地工作树）
- **口径**：ToIV = A0–A6 + A4.1 + B1 **工作室**；App Shell（M0–M2.1）**不进**默认交付，留给 Cosmos 新项目

## 做了什么

1. **根壳回退**：`UserLayout` 恢复 `AppWorkspaceShell` 为登录后根；去掉 `DesktopShell` / `is-desktop-host`。
2. **默认落地**：`router` `/` → `HomePage`（工作室 Home）；`/desktop`、`/desktop/store`、`/desktop/legacy-home` **保留源码路由**并标 `COSMOS_SEED`，**不作**登录后默认入口。
3. **Cosmify 回退**：开始菜单眉题 `Cosmos 创作终端` → **ToIV**；注释改钉 ToIV 根壳 / Cosmos 种子。
4. **侧栏去桌面钩**：`workspace-sidebar-nav` 恢复 HEAD（无 `useDesktopStore` / `openApp` / 静默商店跳转）；「桌面」文案回「首页」。
5. **种子保留**：`lib/desktop`、`components/desktop`、`pages/desktop`、M0–M2.1 handback/shots **未删**；见 `COSMOS_APP_SHELL_SEED.md`。
6. **锁住未动**：A6（黑白壳 + accent `#4A7FC1`）、B1 密度 `250/67/56`、dock-only、灰阶 nav + CTA 蓝。

## 文件面（本波）

| 路径 | 动作 |
|---|---|
| `web/src/layouts/user-layout.tsx` | DesktopShell → AppWorkspaceShell |
| `web/src/router.tsx` | `/`=HomePage；`/desktop*` COSMOS_SEED |
| `web/src/components/layout/workspace-sidebar-nav.tsx` | 恢复 HEAD（卸 M2 桌面钩） |
| `web/src/components/layout/app-top-nav.tsx` | 注释：ToIV 根壳 |
| `web/src/components/desktop/desktop-start-menu.tsx` | 眉题 → ToIV |
| `web/src/components/desktop/desktop-shell.tsx` | COSMOS_SEED 注释 |
| `docs/COSMOS_APP_SHELL_SEED.md` | 新增种子说明 |
| `docs/shots/fixture-toiv-closeout-home.html` | FIXTURE 源 |
| `docs/shots/toiv-closeout-home.png` | FIXTURE 1280 |

## 自检

| 项 | 结果 |
|---|---|
| tip 仍 `0a426713` | ✅ |
| 冷启动 `/` 元素 = `HomePage`（非 DesktopHomePage） | ✅ 源码 |
| `UserLayout` 子树 = `AppWorkspaceShell`（无 DesktopShell） | ✅ |
| 开始菜单若再挂种子 → 眉题 ToIV（非 Cosmos） | ✅ |
| A6 accent / B1 250·67·56 仍在 tokens | ✅ |
| `lib/desktop` + `components/desktop` 仍在 | ✅ |
| 禁 commit/push/deploy | ✅ 本波未执行 |

## FIXTURE

- `apps/canvas/docs/shots/toiv-closeout-home.png`（1280 · **非现网硬刷**）
- 画面：工作室侧栏+顶栏壳；**无**任务栏/开始/桌面图标；CTA `#4A7FC1`

## 残点 / 挂账

- `/desktop*` 路由仍可直达（种子调试）；默认导航与侧栏**不**链过去。
- `use-desktop-store` 仍存在；工作室路径不再调用 `openApp`。
- 若本地曾写过 desktop localStorage，不影响工作室壳渲染（仅种子再挂时读取）。
- 现网硬刷 / commit / Cosmos 新仓迁出 → 等用户口令。
- B2 create 表面、皮肤包、移动端 Launcher → 不在本波。

## 等审

停手。等 TL：过审 / 硬刷 / commit / Cosmos 迁出。
