# ToIV UI 规范标准 v1.0

> 本文件是全站 UI 的唯一权威规范。所有页面优化与新页面开发必须遵守。
> 设计基座：`apps/web/app/globals.css`（设计系统 v7：5 色板 × 亮/暗双维度）。
> 设计方向：**Film Atelier（暗房/剪辑台隐喻）——UI 后退，内容是主角**。

---

## 1. 设计原则

1. **内容优先**：UI 是容器，不抢戏。装饰性元素不得覆盖、遮挡、分散对内容（图/视频/文本）的注意力。
2. **克制动效**：只用 functional motion（状态反馈、引导视线）。禁止纯装饰动画。
3. **简洁优雅、视觉对称**：布局左右/上下平衡；同层级元素等宽等高；留白均匀。
4. **浅色优先**：默认 `paper` 素白浅色主题，深色为可选模式而非默认。
5. **一致性高于个性**：同一场景在所有页面必须用同一组件、同一 token，禁止页面级私造变体。

---

## 2. 色彩

### 2.1 主题机制
- `data-theme`：paper（默认）/ wood / mono / mint / apricot 共 5 套色板。
- `data-mode="dark"`：深色模式；`data-pure-black="1"` 纯黑变体。
- 持久化 key：`toiv_theme` / `toiv_mode` / `toiv_theme_custom`（localStorage）。
- **禁止**在组件内写死颜色值（hex/rgb），一律引用 token。

### 2.2 色彩 Token（必须用这些，禁止新增色系）
| 用途 | Token |
|---|---|
| 背景 | `--bg-canvas` / `--bg-surface-1~3` |
| 文字 | `--text-1`（主）/ `--text-2`（次）/ `--text-3`（弱） |
| 品牌强调 | `--accent` / `--accent-hover` / `--accent-soft` / `--accent-glow` |
| 状态 | `--ok` / `--warn` / `--err` / `--run`（及各自 `-soft` 底） |
| 玻璃材质 | `--glass-*` |
| 焦点 | `--focus-ring` |

- **单页内容配色 ≤ 5 种**；状态色仅表达状态，不做装饰。
- ❌ 禁止高饱和彩虹色、大面积闪烁、粒子爆炸、快速闪烁、粒子覆盖文字、纯白色背景无层次。

### 2.3 对比度
- 正文对比度 ≥ 4.5:1，大字 ≥ 3:1（`tests/themeContrast.test.ts` 卡控，5 色板 × 双模式全量过）。

---

## 3. 字体与排版

| 用途 | 字族 | Token |
|---|---|---|
| 正文 | Inter | 默认 |
| 数字/代码/参数 | JetBrains Mono | `--font-mono` |
| 展示标题（克制使用） | Fraunces | `--font-display` |

- 字号档位（禁止中间值）：`--text-20 / 15 / 14 / 12 / 11`；展示档 `--display-24 / 32 / 40`。
- 字重四档，**禁止 650 等中间值**。
- 行高：正文 1.6，标题 1.2–1.3。
- 数字/参数/耗时/ID 一律 mono 字体。

---

## 4. 间距 / 圆角 / 阴影

- **4px 基数**：只用 `--space-1`(4) ~ `--space-12`(48)，禁止 7px/13px 等野值。
- 圆角三档语义：`--radius-badge: 6px` / `--radius-control: 8px` / `--radius-panel: 12px`。
- 阴影：中性灰阶梯 token，禁止彩色投影、禁止重投影堆叠。
- 区块间距：`--section-gap: 16px`；页面两侧 `--page-gutter: clamp(12px, 2vw, 24px)`。

---

## 5. 布局

| 场景 | 宽度 |
|---|---|
| 表单/阅读型页面 | `--content-max: 1000px` 居中 |
| 数据/画廊型页面 | `--content-wide: 1240px` 居中 |
| 工作台型（画布/工作室） | 全宽，内部栅格 |

- 页头统一 `components/ui/PageHeader.tsx`（kicker / compact / onBack / actions 四槽）。
  - 例外：当 CornerNav/灵动岛已明确指示当前板块时（如融合门户），可省略页头，但须在组件注释中说明理由，并删除未用的 PageHeader 引用。
- z-index 语义档（禁止野值）：dropdown 50 / sticky 100 / drawer 200 / modal 300 / toast 400。
- 移动端：断点 token + `lib/useBreakpoint.ts`；触达目标 ≥ `--touch-target: 44px`。

---

## 6. 图标

- **唯一图标库：lucide-react**，经 `components/ui/Icon.tsx` 封装，`<Icon name="..." />` 调用。
- ❌ 禁止 emoji、其他图标库、自定义 SVG。
- 图标尺寸：正文内联 14–16，按钮 16，空态展示 24–32；stroke-width 默认不覆盖。

---

## 7. 动效

| 场景 | 规范 |
|---|---|
| 时长 | `--duration-fast`(120ms) / `--duration-normal`(200ms) / `--duration-slow`(320ms)，超过 320ms 需理由 |
| 缓动 | `--ease-out`（入场/反馈）/ `--ease-emphasized`（页面级）/ `--ease-spring`（弹性，克制） |
| 反馈 | hover/press/loading 必须有，且 ≤ 200ms |
| 水波纹 | 仅 Ripple 组件，中心向外扩散、慢速、大范围，不叠加 |
| 粒子 | 仅 ParticleButton 既有实现；数量 ≤ 300、速度 ≤ 1.2、细连线；❌ 禁止高饱和彩虹粒子、爆炸、覆盖文字、无景深 |
| 页面切换 | 淡入 + 8px 内位移；❌ 禁止大幅滑行、缩放弹跳 |

- 所有动画须 respect `prefers-reduced-motion`。

---

## 8. 组件使用规范（复用优先，禁止私造）

| 场景 | 必用组件 |
|---|---|
| 按钮 | `ui/Button`（variant: primary/ghost/danger） |
| 输入 | `ui/Input` / `ui/PromptWithEntities`（带 @主体） |
| 开关/页签/徽章/卡片 | `ui/Switch` / `ui/Tabs` / `ui/Badge` / `ui/Card` |
| 反馈 | `ui/Toast` / `ui/ErrorBar` / `ui/Empty` / `ui/Skeleton` / `ui/LoadingBlock` / `ui/GlobalProgress` |
| 浮层 | `ui/Modal` / `ui/Popover`（fixed 定位防截断） |
| 页头 | `ui/PageHeader` |
| 图标 | `ui/Icon` |
| 主题 | `ui/ThemePicker` |
| 图表 | `ui/charts` |
| 3D | `ui/ModelViewer` |

- 新复合组件先评估能否由上述组合；确需新建，放 `components/ui/` 并遵循同款 token。

---

## 9. 样式工程规则（硬性）

1. **无 Tailwind**。样式三层：globals.css token → `app/styles/<view>.css`（按视图 lazy import）→ 组件 `<style jsx>`。
2. **P-2b**：多组件文件必须 `<style jsx global>` + 视图前缀命名（如 `lib-`、`obs-`、`ds-`），否则子组件样式静默失效。
3. CSS Module 仅限独立路由页（现存唯一样例：`drama/[id]/DramaPlayer.module.css`）。
4. 新增样式先查 token 是否已覆盖；新增 token 须在 globals.css 对应分区并注释理由。
5. 生产构建必须 `rm -rf .next` 干净重建（P-2）。

---

## 10. 页面验收清单（每页优化完成必过）

- [ ] 零硬编码颜色/间距/字号，全部走 token
- [ ] 图标全 lucide，零 emoji
- [ ] 配色 ≤ 5 种，对比度过 `themeContrast.test.ts`
- [ ] 动效 ≤ 320ms 且有功能目的，reduced-motion 降级
- [ ] 页头用 PageHeader，层级 ≤ 2 级导航
- [ ] 空态/加载/错误三态齐全（Empty/Skeleton/ErrorBar）
- [ ] 移动端断点适配，触达 ≥ 44px
- [ ] 视觉对称：同层元素对齐，留白均匀
- [ ] `tsc --noEmit` 0 错误 + 相关 vitest 全过 + `npm run build` 成功
- [ ] 亮/暗双模式目检通过

---

## 11. 页面优化顺序（逐页推进）

按用户触达频率 × 当前体量排序，每页走完 §10 验收再进下一页：

| 序 | 页面/视图 | 主文件 | 行数 | 优化重点 |
|---|---|---|---|---|
| 1 | 融合门户（首页） | `fusion/FusionView.tsx` | 159 | 第一印象，信息架构 + 视觉定调 |
| 2 | 创作（图/视频） | `generate/GenerateView.tsx` | 1381 | 最高频，参数区密度 + 引擎选择器 |
| 3 | 作品库 | `library/LibraryView.tsx` | 2453 | 最大视图，画廊栅格 + 筛选 |
| 4 | 工作室 | `studio/StudioView.tsx` + stages/ | ~1300 | 阶段流一致性 |
| 5 | 数字人 | `avatartalk/AvatarTalkView.tsx` 等 | ~3000 | 三模式段控 + 控制台 |
| 6 | 画布 | `canvas/CanvasView.tsx` | 854 | 工具栏 + 节点视觉 |
| 7 | 助手浮层 | `assistant/AssistantView.tsx` + Overlay | 3641 | 全站最大组件，对话流 |
| 8 | 图像编辑 | `image-edit/ImageEditView.tsx` | 1856 | 编辑器布局 |
| 9 | 视频编辑 | `video-edit/VideoEditView.tsx` | 1575 | 同上 |
| 10 | 配音 | `dub/DubView.tsx` | 2072 | 段落列表 + 播放器 |
| 11 | 训练 | `train/TrainView.tsx` | 1219 | 表单流 |
| 12 | 主体库 | `entities/EntitiesView.tsx` | 859 | 卡片栅格 |
| 13 | 短剧工作台(R18) | `drama/DramaView.tsx` + workbench/ | ~3800 | 多阶段壳 |
| 14 | 其他 | skills/models/backlot/settings/observability/admin/agent-runs/animatic/audio/resources | — | 收尾批量化 |

每页产出：优化代码 + §10 验收 + STATE.json/TEST_LOG.md 条目 + commit。
