# FULL SHELL TEARDOWN · A4.1 Quiet Empty + 壳残扫 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（未 commit）
- **状态**：**仅工作树**（未 commit / 未 push / 未 deploy）
- **截图性质**：**FIXTURE · 非现网硬刷**
- **结构**：A3v2 / A4 quieter+distill / A6 黑白壳+`#4A7FC1` **不回退**；本刀压空态灵感墙 + cyan 旧名语义化

---

## 做了什么

### 1) 空态安静 desk（P0）
- `CreationEmptySuggest`：图标卡网格 / Sparkles / motion hover → **灰阶文案 + 单行 CTA**（生成镜头 / 参考图 / 续写故事 / 3D 工具）
- 空态路径 **卸载** `CreationFeaturedWorks`（灵感瀑布 / Skill 墙不再挂在 create empty）
- 标题改为「创作台」+ muted 一句；浮动提示条去掉 Sparkles；demo banner 去星标
- CSS：`.creation-empty-quiet*`；空态强制隐藏残留 `.creation-featured-works` / `.creation-empty-art` / `.creation-empty-suggest`
- 资产轨「自由创作」图标 Sparkles → `Clapperboard`
- `CreationFeaturedWorks` 组件仍保留（未删功能面），但空态不渲染；内部 Sparkles 文案标记已清

### 2) 壳残扫（cyan 旧名 / 青主焦点）
- 双端 tokens：新增 `--toiv-accent-interactive*`；`--toiv-accent-cyan*` 标 **@deprecated**，运行值 = `var(--toiv-accent)`（`#4A7FC1`）
- `globals.css` `@theme`：`--color-toiv-accent-interactive`；cyan 注释 deprecated
- director 节点色：`--toiv-accent-cyan` → `--toiv-accent-interactive`
- Tailwind `accent-cyan-400/500` 滑杆 → `.toiv-accent-range`（`accent-color: var(--toiv-accent)`）
- `--product-accent-cyan` 对齐 `#4A7FC1` / `#6B96D0`（不再青绿）

### 3) 配色（不变 · A6）
accent `#4A7FC1` · success `#3D8B6E` · warning `#C4A35A` · info/锁 `#6B7280` · danger `#B85C5C`

---

## 改动文件（主面）

- `apps/canvas/web/src/pages/create/index.tsx`
- `apps/canvas/web/src/pages/create/creation-workspace.tsx`
- `apps/canvas/web/src/pages/create/creation-product.css`
- `apps/canvas/web/src/components/create/creation-studio-asset-rail.tsx`
- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`
- `apps/canvas/web/src/styles/globals.css`
- `apps/canvas/web/src/styles/toiv-local-overrides.css`
- `apps/canvas/web/src/styles/workspace-product.css`
- `apps/canvas/web/src/components/canvas/canvas-node-graph-visual.css`
- `apps/canvas/web/src/components/canvas/director/director-camera-properties.tsx`
- `apps/canvas/web/src/components/canvas/director/canvas-director-workbench.tsx`
- `apps/canvas/docs/FULL_SHELL_TEARDOWN_A41_QUIET_EMPTY_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-a41-create-empty.html` · `fixture-a41-create-filled.html`
- `apps/canvas/docs/shots/a41-create-empty.png` · `a41-create-filled.png`

## 截图绝对路径（FIXTURE · 非现网硬刷 · 1280）

- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a41-create-empty.png`
- `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/a41-create-filled.png`

验收采样：CTA = `rgb(74, 127, 193)`（`#4A7FC1`）；空态无灵感瀑布 / 无 Sparkles 图标堆。

---

## 未做 / 挂账

| 项 | 说明 |
|---|---|
| 现网硬刷 | 无本地登录会话；仅 FIXTURE |
| commit / push / deploy | **禁** |
| `CreationFeaturedWorks` 源码拆除 | 空态已卸；组件与数据文件仍在，可另刀删或 `?debug=1` 挂回 |
| 消息条 / Skill 引用 / 优化钮 `Sparkles`/`WandSparkles` | 线程内状态图标，非空态墙；可另刀 quieter |
| 内容封面图自带彩光 | 资产非 chrome；**不强制重渲** |
| 全局 `--toiv-node-*-glow` token | 画布选中通道；非本刀 |
| 历史 a0–a6 截图 | 仍含旧空态/旧色，勿当现貌 |
| `--toiv-accent-cyan*` 标识名 | 仍保留作 deprecated 别名（值已是蓝 accent） |
| product 多色 category accent（蓝/绿/橙/粉/紫） | 分类色非主 CTA；未整表收口 |

## 阻塞
- 无会话 → 无法现网肉眼验收空态

---

## 自检残点（诚实）

1. 空态主路径已安静；灵感墙组件代码仍在树内（未挂载）
2. 线程消息 mark / Skill 引用图标仍可能见 Sparkles
3. cyan **旧名**仍存在（deprecated alias），运行色正确
4. 内容封面彩光 / node-glow / 历史截图 — 挂账
5. Fixture 非源码直渲；真壳密度未硬刷

**结论：create 空态 = 安静 desk（灰阶+单线 CTA）；灵感瀑布已卸；accent 仍 `#4A7FC1`；cyan 旧名已标 deprecated。禁 commit。**

---

## 禁声明

**禁 commit / push / deploy。** tip 必须仍为 `0a426713`。仅本地工作树。
