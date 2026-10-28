# ToIV · T1 红线单锁 Handback（W1-A）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **口径**：BeefTV + A6 `#4A7FC1` + B1 `250/67/56`；**未**动 `apps/api/**` / DesktopShell / 后端 NSFW 闸

---

## 做了什么

1. **`apps/canvas/web/src/redline.ts` = 唯一 UX 决策面**
   - 迁入：`CLASSIC_NSFW_TO_MARKET`、`ContentMode` / `ContentModeApp`、`normalizeContentModes` / `normalizeContentModeFields`
   - 迁入判据：`canShowContentModeToggle`、`resolveSubmitContentMode`、`appShowsR18Badge`、`appIsPureNsfw`、`appVisibleForContentMode`
   - 去掉对 `@/services/toiv/content-mode` 的 import（断环）
2. **`services/toiv/content-mode.ts`** → 薄 re-export → `@/redline`（禁止回填逻辑；对齐 `r18-mode.ts`）
3. **`r18-mode.ts`** 仍为薄 re-export，未回填
4. 消费方：
   - `pages/toiv/market-page.tsx`：可见性/提交/徽标/切换判据 **只从** `@/redline`
   - `pages/settings/r18-settings-pane.tsx`：`CLASSIC_NSFW_TO_MARKET` → `@/redline`
   - `services/toiv/client.ts`：同名符号 re-export 改从 `@/redline`（兼容旧 `from client`）
5. 单测：`test/content-mode.test.ts` 增补 pure/visibility + **源码落点在 redline** 契约

---

## 改动文件面

- `apps/canvas/web/src/redline.ts`
- `apps/canvas/web/src/services/toiv/content-mode.ts`
- `apps/canvas/web/src/services/toiv/client.ts`
- `apps/canvas/web/src/pages/toiv/market-page.tsx`
- `apps/canvas/web/src/pages/settings/r18-settings-pane.tsx`
- `apps/canvas/web/test/content-mode.test.ts`
- `apps/canvas/docs/TOIV_REDLINE_SINGLE_LOCK_T1_HANDBACK.md`

---

## rg 自检（落点）

```text
$ rg -n "export function (resolveSubmitContentMode|appVisibleForContentMode|appIsPureNsfw)" apps/canvas/web/src
apps/canvas/web/src/redline.ts:…:export function resolveSubmitContentMode
apps/canvas/web/src/redline.ts:…:export function appIsPureNsfw
apps/canvas/web/src/redline.ts:…:export function appVisibleForContentMode
```

`content-mode.ts` 仅 `export { … } from "@/redline"`，无第二真源函数体。

---

## 解 / 去锁冒烟（文档 + 已跑纯判据）

### A. 纯判据（已跑 · 不改树）

在 `apps/canvas/web` 用 bun 直接 import `@/redline` 谓词：

| 检查 | 结果 |
|---|---|
| `appIsPureNsfw(pure)` | PASS |
| ordinary 隐藏纯 NSFW / adult 显示 | PASS |
| `resolveSubmitContentMode` R18 关 fail-closed → `sfw` | PASS |
| `nsfwAllowed() === isR18Mode()` | PASS（当前环境均为 false） |

`bun test test/content-mode.test.ts`：**全绿**（含 W1-A source 契约）。

### B. 临时强制解锁（人工 / 勿提交）

1. **推荐（产品路径）**：登录后于设置打开成人模式（`setR18Mode(true)` / 灯帘确认）→ `nsfwAllowed()` 随账号态变 true → 市场纯 NSFW 卡可见、锁标可点、提交可选 nsfw。
2. **开发 shim（仅本地）**：临时将 `redline.ts` 内 `nsfwAllowed()` 改为 `return true;` → 刷新 → 确认灰化/锁标/守卫路径放开 → **立刻复原**为 `return isR18Mode();`。**禁止 commit 带 shim 的树。**
3. **去锁复原**：还原 `nsfwAllowed` / 切回普通 → 纯 NSFW 隐藏、已知 NSFW 资产灰化+锁、gated 深链仍拦到设置闸。

本波**未**留下任何恒 true shim；tip 仍 `0a426713`。

---

## 验收对照

- [x] 判据无第二真源（落点 redline）
- [x] 普通↔成人：谓词 fail-closed / 可见性仍按 r18On（单测 + 冒烟）
- [x] 解/去锁步骤已文档化；纯判据冒烟 PASS；未留 shim
- [x] tip `0a426713`；未 commit

## 残点 / 风险

| 项 | 说明 |
|---|---|
| 现网 UI 肉眼切换 | 无本机登录会话；未硬刷市场页截图 |
| `client` 仍 re-export 判据 | 兼容旧 import；真源在 redline |
| `content-mode` / `r18-mode` 薄路径 | 旧路径仍可用；新代码应直引 `@/redline` |
| 后端 NSFW 闸 | **未动**（等 TL） |

**禁 commit / push / deploy。停手等审。**
