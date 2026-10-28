# FULL SHELL TEARDOWN · B1 BeefTV Primary Shell（可逆清理）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit**）
- **状态**：**仅工作树**（禁 commit / push / deploy / reset / clean）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **范围收窄（TL）**：只做可逆清理四项；**未开 B2**；无大 IA / 窗口管理 / 可装应用架构改造
- **配色锁**：A6 黑白壳 + accent `#4A7FC1`；status success `#3D8B6E` / warning `#C4A35A` / info·锁 `#6B7280` / danger `#B85C5C`

---

## 本刀做了什么（钉死四项）

### 1. 密度一档（BeefTV）

| Token | 旧 | B1 |
|---|---|---|
| `--toiv-shell-sidebar` | 216px | **250px** |
| `--toiv-shell-sidebar-collapsed` | 56px | **67px** |
| `--toiv-shell-topbar` | 56px | **56px**（不变） |

- 双端 twin：`apps/canvas/web/.../toiv-freezone-tokens.css` ↔ `apps/web/app/.../toiv-freezone-tokens.css`
- `.app-user-workspace` 历史 **312 / 86** → `var(--toiv-shell-*)`（清回潮）
- `workspace-product` reference + 实宽同步桥到 `--toiv-shell-*`

### 2. 踢默认 Toonflow float（只留 dock）

- `use-canvas-assistant.ts`：默认 presentation 强制 **`dock`**；忽略 localStorage 里遗留的 `float`；`setPresentation("float")` 被 coerce 回 `dock`
- `canvas-assistant-sidebar.tsx`：去掉「切换为悬浮（Toonflow）」按钮；注释钉 BeefTV primary / dock only
- float 几何代码保留（lab/dev 路径），**默认 chrome 不可达**

### 3. 清 `cn-spatial-glow` / `shadow-glow` 抢 chrome

- `globals.css`：`--shadow-glow-{sm,md,lg}` → **`none`**
- `--cn-spatial-glow` / `-strong`（亮/暗）→ **`transparent`**
- token 名保留，避免大面积改消费者

### 4. Accent 分层（灰阶 chrome + CTA `#4A7FC1`）

- 侧栏 **nav active / 创作入口**：灰阶 surface-hover + 墨色边条；**禁整栏刷蓝**
- 顶栏 utility 图标 → muted（不再用 `--user-accent` 蓝）
- **保留** primary CTA / ant-btn-primary / focus / playhead = `#4A7FC1`（A6）
- Status 色保持 A6，未搬 BeefTV 霓虹绿/亮红

### 注释口径

- freezone tokens 头注释改钉：**BeefTV primary shell + A6 palette**；DramaClaw = 节点几何 only；Toonflow ≠ 默认 chrome

---

## 改动文件面（本刀主面）

| 路径 | 作用 |
|---|---|
| `apps/canvas/web/src/styles/toiv-freezone-tokens.css` | 密度 250/67/56 + BeefTV 注释 |
| `apps/web/app/styles/toiv-freezone-tokens.css` | twin 同步 |
| `apps/canvas/web/src/styles/globals.css` | 清 312/86；glow 中性化 |
| `apps/canvas/web/src/styles/workspace-product.css` | 密度桥 + nav chrome 灰阶 |
| `apps/canvas/web/src/pages/canvas/use-canvas-assistant.ts` | dock-only coerce |
| `apps/canvas/web/src/pages/canvas/canvas-assistant-sidebar.tsx` | 去 float 开关 |
| `apps/canvas/docs/FULL_SHELL_TEARDOWN_BEEFTV_B1_HANDBACK.md` | 本交接 |
| `apps/canvas/docs/shots/fixture-b1-*.html` · `b1-*.png` | FIXTURE |

---

## 截图（FIXTURE · 非现网硬刷 · 1280）

| 页 | 绝对路径 |
|---|---|
| home | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/b1-home.png` |
| create外壳 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/b1-create-shell.png` |
| 设置 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/b1-settings.png` |

验收采样：CTA ≈ **`rgb(74, 127, 193)`**（`#4A7FC1`）；无玫红主焦点；nav 灰阶。

源 fixture：

- `.../shots/fixture-b1-home.html`
- `.../shots/fixture-b1-create-shell.html`
- `.../shots/fixture-b1-settings.html`

---

## 残点 / 挂账

| 项 | 说明 |
|---|---|
| **B2 未开** | create 三栏表面/工具条/节点卡仅 DramaClaw 数字 — 留给下一刀；几何 `--toiv-create-*` 保留 |
| FeaturedWorks / 灵感墙源码 | A4.1 挂账，本刀未扫 |
| 内容封面彩光资产 | 不强制重渲 |
| story-launcher / collection 等页内 `user-accent-soft` 点缀 | 非壳 chrome；可后续压 |
| assets 搜索宽硬编码 216px | 内容控件，非壳宽 |
| 现网硬刷 | 等用户；本刀仅 FIXTURE |
| 历史截图 a0–a6 | 旧玫红/窄侧栏仍在 `docs/shots/`，勿当现态 |
| Toonflow float 代码路径 | 仍在仓库；默认 UI 已踢；彻底删除留给后刀 |
| 未登录门面 | 本波不动 |
| 后端 NSFW | 禁动 |

---

## 自检

- [x] 密度 250 / 67 / 56
- [x] 默认 dock only（无 Toonflow float 开关）
- [x] spatial/shadow glow 不再抢 chrome
- [x] nav/pill chrome 灰阶；CTA `#4A7FC1`
- [x] IA 一级未改；未开 B2；未 commit/push/deploy
- [x] tip 仍 **`0a426713`**
- [x] Handback + 三张 FIXTURE 截图

**停手等 TL 审。勿开 B2。**
