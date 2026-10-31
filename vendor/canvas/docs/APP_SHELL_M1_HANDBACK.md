# APP SHELL · M1 Handback（DesktopShell 骨架）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**）
- **状态**：**仅工作树**（禁 commit / push / deploy / reset / clean）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **叠树**：A0–A6 + A4.1 + B1 + M1
- **配色锁**：A6 黑白壳 + accent `#4A7FC1`；App 内容区 BeefTV 密台不随皮肤变

---

## TL 口径增量（本刀已并入）

| 项 | 落点 |
|---|---|
| 旧「禁 Win98 皮」→ **多皮肤可选** | 98 可作一包，**非默认**；M1 **不画** XP/mac/98 |
| 仍禁 | 会员锁主题、玩笑广告、跳出登录墙 |
| **皮肤分层** | 皮肤只动 DesktopShell chrome（壁纸/开始/任务栏·Dock/窗框）；**App 内容区**仍 BeefTV+A6（黑白+`#4A7FC1`） |
| `DesktopPrefs.themeId` | **已预留**；默认 **`toiv-noir`** |
| 导出/导入 | `toiv.desktop.v1.prefs.themeId` 读写；导入喵咛时 **忽略** `theme` / `wallpaperCharacter`（不映射付费皮） |
| 多套皮肤包 | **排 M1.5/M2**；本波出厂只做 `toiv-noir` |

---

## 本刀做了什么

### 方案 A 根壳

- `UserLayout` 根改为 **`DesktopShell`**
- `AppWorkspaceShell` **降级为窗内 chrome**（`h-full`；密度仍 B1 `250/67/56`）
- `/` → 空 `DesktopHomePage`（桌面由壳绘制）
- `/desktop/store` → **应用商店**（id `app-store`）
- `/desktop/legacy-home` → 旧 HomeDashboard（挂账入口，非默认）

### 桌面骨架

1. 桌面图标网格（预装可见）
2. 开始菜单（打开 / 导入 / 导出 / 进商店）
3. 任务栏（钉选 + 运行中 / 最小化指示；accent 底条 ≤10%）
4. 窗管最小集：开 / 焦 / 小 / 关 / 最大化；任务栏按钮；**最大化保留任务栏**
5. 至少支持 **多窗最小化并行**（单 Outlet：前台窗吃 children，后台「挂起」占位）

### Catalog / 定名

| id | 文案 | 预装 |
|---|---|---|
| 系统 7 | 创作 / 短剧项目 / 任务中心 / **工具台** / 设置 / 媒体库 / **应用商店** | system |
| 可卸 4 | 画布库 / 新建画布 / 外部 Agent / 学习看板 | user |
| 目录可装 | 插件中心 / Eagle / 录音测试 | 非预装 |
| `wf:*` | **工作流** 分轨 | 不进 OS installed 主键 |

### 持久化 / 备份

- L0：`localStorage` key **`toiv:desktop:v1`**（zustand persist）
- 导出 schema：`toiv.desktop.v1`（installed 对象数组 + folders + placements + taskbar + **prefs.themeId**）
- 导入：宽松读 `toiv.desktop.v1` **或** 喵咛 `miorning98-desktop-backup`（`state.installed: string[]` 升格 `{id, source:"import"}`；`placements|desktopPositions` map；**勿宣称 100% 兼容**）

---

## 改动文件面

| 路径 | 作用 |
|---|---|
| `apps/canvas/web/src/lib/desktop/types.ts` | 领域类型 + `themeId` |
| `apps/canvas/web/src/lib/desktop/catalog.ts` | 11 预装 + 目录 + path→app |
| `apps/canvas/web/src/lib/desktop/backup.ts` | 导出/导入（含喵咛宽松） |
| `apps/canvas/web/src/lib/desktop/index.ts` | barrel |
| `apps/canvas/web/src/stores/use-desktop-store.ts` | L0 状态 + 窗管 |
| `apps/canvas/web/src/styles/desktop-shell.css` | `toiv-noir` chrome |
| `apps/canvas/web/src/components/desktop/*` | Shell / icons / start / taskbar / window / icon map |
| `apps/canvas/web/src/pages/desktop/desktop-home-page.tsx` | `/` 宿主 |
| `apps/canvas/web/src/pages/desktop/app-store-page.tsx` | 应用商店 |
| `apps/canvas/web/src/layouts/user-layout.tsx` | 根换 DesktopShell |
| `apps/canvas/web/src/components/layout/app-top-nav.tsx` | `h-dvh`→`h-full`（窗内） |
| `apps/canvas/web/src/router.tsx` | `/` + `/desktop/store` + legacy-home |
| `apps/canvas/docs/APP_SHELL_M1_HANDBACK.md` | 本交接 |
| `apps/canvas/docs/shots/fixture-m1-*.html` · `m1-*.png` | FIXTURE |

**未动**：B2 create 大表面；后端 NSFW；未登录门面；commit/push/deploy。

---

## 截图（FIXTURE · 非现网硬刷 · 1280）

| 页 | 路径 |
|---|---|
| 桌面 | `apps/canvas/docs/shots/m1-desktop.png` |
| 商店 | `apps/canvas/docs/shots/m1-store.png` |
| 开一窗 | `apps/canvas/docs/shots/m1-window.png` |

源 fixture：`fixture-m1-desktop.html` / `fixture-m1-store.html` / `fixture-m1-window.html`

---

## 残点 / 未做（挂账）

| 项 | 说明 |
|---|---|
| 皮肤包 XP / mac / 98 | M1.5/M2；仅 `themeId` 预留 |
| 窗拖拽/缩放 | M1 bounds 简化固定；可后补 |
| 真多实例同 App | 现单例/appId；并行靠多 App 最小化 |
| 后台窗保活真实路由树 | 现「挂起」占位；切回再 navigate |
| L1 桌面应用数据目录 / L2 账号同步 | 后波 |
| 旧 Home 仪表盘产品化 | 仅 `/desktop/legacy-home` |
| 文件夹 UI / 图标拖放落点编辑 | 模型有 folders；UI 未做 |
| 工作流 `wf:` 上架包装 | 分轨保留，商店不混名 |
| B2 create 表面 | 仍停 |
| 现网硬刷 | 等用户；本刀 FIXTURE |
| FeaturedWorks / 历史截图色差 | 旧挂账 |

---

## 自检

- [x] tip 仍 **`0a426713`**
- [x] 禁 commit / push / deploy
- [x] 方案 A DesktopShell 根
- [x] 预装 11 + 应用商店 + 导出导入 + themeId
- [x] 窗管最小集 + 任务栏在最大化时保留
- [x] 定名：应用商店 / 工具台 / 工作流
- [x] FIXTURE 三张 1280
- [x] tsc 对本刀相关文件无报错

**停手等 TL 审。**
