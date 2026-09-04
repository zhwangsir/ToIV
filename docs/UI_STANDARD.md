# ToIV UI 规范标准 v2.0（2026-09-04 美化第 0 波重写）

> 本文件是全站 UI 的唯一权威规范。所有页面优化与新页面开发必须遵守。
> 设计基座：`apps/web/app/globals.css`（设计系统 v8：单一中性系 × 亮/暗双模式）。
> 设计方向：**精修控制台（Studio Console）——UI 后退，内容是主角；版型（layout）优先于装饰**。

---

## 1. 设计原则

1. **内容优先**：UI 是容器，不抢戏。装饰性元素不得覆盖、遮挡、分散对内容（图/视频/文本）的注意力。
2. **版型先行**：先定版心、节奏、对齐，再谈色彩与装饰。任何新视图先回答「走哪档容器宽度」。
3. **克制动效**：只用 functional motion（状态反馈、引导视线）。禁止纯装饰动画。
4. **单中性系**：全站一套中性色板，亮/暗双模式；深色不是另一套设计，只是同一设计的暗档。
5. **一致性高于个性**：同一场景在所有页面必须用同一组件、同一 token，禁止页面级私造变体。

---

## 2. 色彩

### 2.1 主题机制（v8 现实）
- 五色板（wood/mono/mint/apricot）与自定义色板已全部退役，只剩 `:root`（亮）与 `[data-mode="dark"]`（暗）双模式。
- `[data-pure-black="1"]`：暗色子档，画布压纯黑。
- 持久化只剩 `toiv_mode` / `toiv_theme_custom`（pureBlack）；`layout.tsx` 内联脚本首帧前写 `data-mode` 防 FOUC。
- **禁止**在组件内写死颜色值（hex/rgb），一律引用 token。

### 2.2 色彩 Token（必须用这些，禁止新增色系）
| 用途 | Token |
|---|---|
| 背景 | `--bg-canvas` / `--bg-surface-1~3` |
| 文字 | `--text-primary`（主）/ `--text-secondary`（次）/ `--text-muted`（弱）/ `--text-3`（第三级弱化，secondary 别名） |
| 强调（中性） | `--accent`（近黑 CTA）/ `--accent-hover` / `--accent-soft` / `--accent-halo`（中性光晕，聚焦环光晕/浮层淡边） |
| 点睛（琥珀，克制） | `--accent-glow`（亮 `#b07d2a` / 暗 `#d4a94e`）/ `--accent-glow-soft` / `--accent-glow-deep` |
| 状态 | `--ok` / `--warn` / `--err` / `--run`（及各自 `-soft` 底） |
| 图表系列 | `--chart-1~5`（数据可视化专用，与状态色分轨） |
| 玻璃材质 | `--glass-*` |
| 焦点 | `--focus-ring`（1px `--accent-glow` 琥珀） |

**琥珀点睛红线**：`--accent-glow` 只允许出现在最小触点——`:focus-visible` 聚焦环、无类名文本链接 hover、`.at-seg` 激活指示、assistant 启动序列。禁止用于按钮填充、大面积背景、正文着色。主按钮保持近黑 accent 不变。

- **单页内容配色 ≤ 5 种**；状态色仅表达状态，不做装饰。
- ❌ 禁止高饱和彩虹色、大面积闪烁、粒子爆炸、快速闪烁、粒子覆盖文字、纯白色背景无层次。

### 2.3 对比度
- 正文对比度 ≥ 4.5:1，大字/非文本图形 ≥ 3:1（`tests/themeContrast.test.ts` 卡控，亮/暗/纯黑全量过）。

---

## 3. 字体与排版

| 用途 | 字族 | Token |
|---|---|---|
| 正文 | Inter | 默认 |
| 数字/代码/参数 | JetBrains Mono | `--font-mono` |
| 展示标题（克制使用） | Fraunces | `--font-display` |

### 3.1 语义字阶（唯一档位，禁止中间值，禁止裸 px）
| 档位 | 值 | 用途 |
|---|---|---|
| `--text-title` | 20px | 页面标题 |
| `--text-section` | 15px | 区块/小节标题 |
| `--text-body` | 13px | 正文、控件、列表 |
| `--text-aux` | 11px | 辅助说明（移动端 12px） |
| `--text-label` | 11px | 标签/徽章（常配大写+字距） |
| `--text-display-sm/md/lg` | 24/32/40px | 落地页/空态展示位专用 |

> 旧数字档 `--text-xs~2xl` 已于 2026-09-04 删除，映射：xs→aux · sm→body · base→body · md→section · lg→title · xl→display-sm · 2xl→display-md。新代码出现旧档名即为错误。
> 例外：移动端 `.input` 钉 16px（iOS <16px 聚焦自动缩放的硬约束，不参与字阶）。

- 字重四档（`--font-regular/medium/semibold/bold`），**禁止 650 等中间值**。
- 行高：紧凑 1.4（标签/单行控件）· 正文 `--leading-base: 22px` · 长文 `--leading-loose: 1.7`；标题 `--leading-xl: 26px`。
- 数字/参数/耗时/ID 一律 tabular-nums（`.tnum`），代码/ID 用 mono 字体。

---

## 4. 版型（Layout）系统 —— 全站最重要的一节

所有版型决策只允许消费本节令牌（globals.css「版型(Layout)令牌」区，亮暗通用），禁止再写裸 px max-width / 裸 gutter。

### 4.1 容器宽度语义档
| 档位 | 值 | 适用 |
|---|---|---|
| `--layout-measure` | 680px | 阅读档：表单/文档流/长文设置页，行长收敛保可读 |
| `--layout-content` | 1000px | 标准档：常规视图（详情/设置/列表）默认版心 |
| `--layout-wide` | 1240px | 宽档：宽列表（项目库/作品网格/agent-runs）；基座壳 `.single-view`/`.view-shell` 默认消费 |
| 满档 | 无令牌 | 工作台（generate/canvas/studio 等）不吃 max-width，视口内自排版 |

- `--content-max` / `--content-wide` 是历史别名（分别指向 content / wide 档），既有引用不断裂；**新代码直接用 `--layout-*`**。
- 视图需要窄版心时在自有容器覆盖（如 `max-width: var(--layout-measure)`），禁止写裸值。

### 4.2 节奏档
| 令牌 | 值 | 用途 |
|---|---|---|
| `--page-gutter` | clamp(12px, 2vw, 24px) | 页面左右内边距唯一来源 |
| `--layout-header-gap` | 16px（`--space-4`） | 页头下间距（`.page-header` 已消费） |
| `--layout-toolbar-gap` | 12px（`--space-3`） | 工具条与内容区间距 |
| `--section-gap` | 16px | 区块（卡/区段）间距基准档 |
| `--section-gap-lg` | 24px | 宽松区块档：首屏英雄区/大区块之间 |
| `--grid-gutter` / `--grid-gutter-lg` | 16 / 20px | 栅格 gutter；宽松陈列（作品网格/市场卡）用 lg |

### 4.3 媒体卡宽高比（aspect-ratio 值）
| 令牌 | 值 | 用途 |
|---|---|---|
| `--media-ar-video` | 16 / 9 | 视频卡 |
| `--media-ar-image` | 1 / 1 | 图片卡 |
| `--media-ar-thumb` | 4 / 3 | 缩略图/混合列表 |

### 4.4 基线对齐规则
- 页头标题按 `--leading-xl` 基线与右侧操作区底对齐（`.page-header` 为 `align-items: flex-end`）。
- 工具条行高统一 36px（chips/段控/输入条同一视觉行）。
- 卡内 padding 统一 `--space-4`，不随卡片用途增减。

---

## 5. 间距 / 圆角 / 阴影

- **4px 基数**：只用 `--space-1`(4) ~ `--space-12`(48)，禁止 7px/13px 等野值（≤575px 小屏全局压缩档除外，已内建于令牌）。
- **圆角语义三档**：`--radius-badge: 6px` / `--radius-control: 8px` / `--radius-panel: 12px`，外加 `--radius-full`。数字档 `--radius-xs~xl` 已于 2026-09-04 删除（映射 xs/sm→badge · md→control · lg/xl→panel），新代码禁用旧名。
- **阴影**：平卡（`.at-card`/`.card`）不用阴影，靠 hairline 描边分层；浮层（Modal/Popover/Toast/CommandPalette）统一 `--shadow-pop`（柔和大半径投影 + 近距描边影双层）；抬升/悬浮场景 `--shadow-lift` / `--shadow-float`；控件纸感微浮 `--shadow-xs`。禁止彩色投影。

---

## 6. 装饰层规则（2026-09-04 裁决）

- **噪点**：全局 `body::before` 胶片颗粒保留，透明度 0.02（亮/暗同档，暗色反相为亮颗粒）。这是全局唯一允许的常驻装饰。
- **暗角**：全局 `body::after` 暗角已删除。暗角只属舞台语义，仅在舞台类容器内生效：`.stage-main::after`（stage.css）/ `.at-stage::after`（avatartalk.css），配方统一（canvas 混色径向轻压四角）。
- **assistant 启动序列**：琥珀单色系（`--accent-glow` → `--accent-glow-deep`），cyan/violet 品牌双色已退役；动画时序逻辑不改。
- 其余装饰一律先问「它帮助看清内容了吗」，答不上就删。

---

## 7. 布局壳与导航

- 壳：`.app-shell` = 52px 左栏图标轨（siderail.css）+ 主区；<1024px 回退单列 + 底部导航。
- 内容壳：`.single-view` / `.view-shell` 统一消费 `--page-gutter` 与 wide 版心。
- 页头统一 `components/ui/PageHeader.tsx`（compact / onBack / actions 槽），样式唯一来源是 globals.css 的 `.page-header` 单块（双定义已合并）。
  - 例外：工作台类视图用 `.page-header.is-compact`（单行 标题+操作，无分隔线）；导航已明确指示当前板块时可省略页头，但须在组件注释中说明理由。
- z-index 语义档（禁止野值）：dropdown 50 / sticky 100 / drawer 200 / modal 300 / toast 400；舞台局部层叠 0–30 档见 stage.css 文首映射。
- 移动端：断点 token（`--bp-sm/md/lg/xl`，媒体查询用 值-1：575/767/1023）+ `lib/useBreakpoint.ts`；触达目标 ≥ `--touch-target: 44px`。

---

## 8. 图标

- **唯一图标库：lucide-react**，经 `components/ui/Icon.tsx` 封装，`<Icon name="..." />` 调用。
- ❌ 禁止 emoji、其他图标库、自定义 SVG。
- 图标尺寸：正文内联 14–16，按钮 16，空态展示 24–32；stroke-width 默认不覆盖。

---

## 9. 动效

| 场景 | 规范 |
|---|---|
| 时长 | `--duration-fast`(150ms) / `--duration-base`(200ms) / `--duration-slow`(320ms)，超过 320ms 需理由 |
| 缓动 | `--ease-standard`（ease-out，入场/反馈）/ `--ease-emphasized`（页面级）/ `--ease-spring`（弹性，克制） |
| 反馈 | hover/press/loading 必须有，且 ≤ 200ms |
| 水波纹 | 仅 Ripple 组件，中心向外扩散、慢速、大范围，不叠加 |
| 粒子 | 仅 ParticleButton 既有实现；❌ 禁止高饱和彩虹粒子、爆炸、覆盖文字 |
| 页面切换 | 淡入 + 8px 内位移；❌ 禁止大幅滑行、缩放弹跳 |

- 所有动画须 respect `prefers-reduced-motion`。

---

## 10. 组件使用规范（at 系为唯一范式）

**at 系共享类（globals.css 尾部）是新代码的唯一组件范式**：`.at-btn`（墨丸主钮/发夹线次钮）/ `.at-chip` / `.at-seg` / `.at-card`（可交互卡叠加 `.at-card--interactive`：hover 边框转 `--border-strong` + translateY(-1px) + 细影）/ `.at-badge` / `.at-empty`（三档：`.at-empty--stage` 舞台大卡 / `--section` 段落 / `--inline` 列表单行）/ `.at-card-in`（错落入场）。

| 场景 | 必用 |
|---|---|
| 按钮 | `.at-btn--primary` / `.at-btn--ghost` / `.at-btn--danger`（旧 `.btn` 系为**兼容别名，新代码禁用**） |
| 卡片 | `.at-card`（旧 `.card` 同上，兼容别名） |
| chip/段控/徽章 | `.at-chip` / `.at-seg` / `.at-badge` |
| 空态 | `ui/Empty`（size 三档：stage/section/inline，默认 inline 兼容旧调用）/ `.at-empty` |
| 输入 | `ui/Input` / `ui/PromptWithEntities`（带 @主体） |
| 开关/页签 | `ui/Switch` / `ui/Tabs` |
| 反馈 | `ui/Toast` / `ui/ErrorBar` / `ui/Skeleton` / `ui/LoadingBlock` / `ui/GlobalProgress` |
| 浮层 | `ui/Modal` / `ui/Popover`（fixed 定位防截断；阴影走 `--shadow-pop`） |
| 页头 | `ui/PageHeader` |
| 图标 | `ui/Icon` |
| 主题 | `ui/ThemePicker`（只剩模式段控 + 暗色纯黑开关） |
| 图表 | `ui/charts`（`--chart-1~5`） |
| 3D | `ui/ModelViewer` |

- 新复合组件先评估能否由上述组合；确需新建，放 `components/ui/` 并遵循同款 token。

---

## 11. 样式工程规则（硬性）

1. **无 Tailwind**。样式三层：globals.css token + 共享类 → `app/styles/*.css`（玻璃/导航/舞台/动效/效果全局 eager，视图 css lazy import）→ 组件 `<style jsx>`。
2. **P-2b**：多组件文件必须 `<style jsx global>` + 视图前缀命名（如 `lib-`、`obs-`、`ie-`），否则子组件样式静默失效；UI 改动必须真机截图验证。
3. CSS Module 仅限独立路由页（现存唯一样例：`drama/[id]/DramaPlayer.module.css`）。
4. 新增样式先查 token 是否已覆盖；新增 token 须在 globals.css 对应分区并注释理由。
5. **P-2**：生产构建必须 `rm -rf .next` 干净重建；deploy.sh 只 rsync 不重建，部署前确认 BUILD_ID 是当次新构建。
6. 浏览器自动化测 React：原生事件不触发合成事件（select 用 native setter + dispatchEvent；P-3）。

---

## 12. 页面验收清单（每页优化完成必过）

- [ ] 零硬编码颜色/间距/字号/圆角，全部走 token
- [ ] 版型：容器宽度选对语义档（§4.1），区块节奏走 §4.2 令牌，媒体卡走 §4.3 宽高比
- [ ] 图标全 lucide，零 emoji
- [ ] 配色 ≤ 5 种；琥珀点睛不越红线（§2.2）；对比度过 `themeContrast.test.ts`
- [ ] 动效 ≤ 320ms 且有功能目的，reduced-motion 降级
- [ ] 组件走 at 系（§10），未新增 `.btn`/`.card` 兼容别名调用
- [ ] 空态/加载/错误三态齐全（Empty/Skeleton/ErrorBar）
- [ ] 移动端断点适配，触达 ≥ 44px
- [ ] `tsc --noEmit` 0 错误 + `npm test` 全过 + `rm -rf .next && npm run build` 成功
- [ ] 亮/暗双模式截图目检通过

---

## 13. 视图职责表（逐视图推进时按此对齐，不写会过时的行数）

| 视图 | 版型档 | 职责与优化重点 |
|---|---|---|
| 首页（home，对话式） | 满档居中列 | 第一印象；助手对话流 + 极简空态 |
| 创作（图片/视频，应用目录 + GenerateView） | 满档工作台 | 最高频；舞台 + 参数列 + 提示词条三件套 |
| 音频 | 满档工作台 | 多工具段控 + 结果舞台 |
| 作品库（library） | 宽档 | 画廊栅格 + 筛选 + 批量操作 |
| 工作室（studio） | 满档工作台 | 阶段流一致性 |
| 数字人（avatartalk） | 满档工作台 | 三模式段控 + `.at-stage` 舞台 |
| 画布（canvas） | 满档 | 工具栏 + 节点视觉 |
| 助手浮层（assistant） | 浮层 640px 列 | 对话流；启动序列琥珀单色 |
| 图像/视频编辑 | 满档工作台 | 编辑器布局 |
| 配音（dub） | 满档工作台 | 段落列表 + 播放器 |
| 训练（train） | 标准档表单 | 表单流（候选 measure 档） |
| 主体库（entities） | 宽档 | 卡片栅格 |
| 资源中心（resources：models/train/backlot 容器） | 宽档 | 双轨收编 + tab |
| 市场（market：skills/apps） | 宽档 | 卡片陈列 + 检索 |
| 设置/观测/管理 | 标准档 | 表单/面板密度 |
| agent-runs / animatic / fusion 等 | 视内容选档 | 收尾批量化 |

每页产出：优化代码 + §12 验收 + STATE.json/TEST_LOG.md 条目 + commit（由主会话执行）。
