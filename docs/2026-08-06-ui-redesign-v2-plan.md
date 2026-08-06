# ToIV UI 重构 v2 · Studio Slate(影棚岩板)

> 2026-08-06 定稿。起因:业主不满意 08-03「Obsidian 深曜」的成品观感。
> 调研结论:问题不在深色本身,而在「黑底 + 紫渐变」是 2023-2024 最泛滥的 AI 视觉陈词
> (AI slop aesthetic);且布局密度、弹层/空态不统一、三套样式范式并存削弱了专业感。
> 本文档取代 2026-08-03-ui-redesign-plan.md 的视觉层,IA 沿用 2026-08-04 九入口不动。

## 一、风格方向:Studio Slate(影棚岩板)

**一句话**:DaVinci Resolve 式的专业影棚——中性深灰骨架 + 信号橙单点强调,
生成的图/视频/数字人是唯一色彩来源,UI 退后为精密仪器。

- 参考:DaVinci Resolve(深灰 + 橙的专业剪辑台)、Runway(内容全出血、UI 退隐)、
  Linear(密度与层级)
- 交互性格(借 Krea/Suno):实时感——生成中给模糊预览/进度演化,结果卡可一键回填再创作,
  加载态一律功能性(表达进度与状态),禁止装饰性动效
- 明确避免:紫蓝渐变/发光粒子/神经线条(AI slop)、全屏 glassmorphism、
  滚动视差剧场、角落 bolted-on chatbot

### 色彩 token(替换 08-03 紫色系)

| token | 旧值(紫) | 新值 | 用途 |
|---|---|---|---|
| `--bg-canvas` | `#0B0B0F` | `#0E0E11` | 页面底色(中性,去紫味) |
| `--bg-surface-1` | `#121218` | `#15151A` | 卡片/面板 |
| `--bg-surface-2` | `#1A1A22` | `#1C1C23` | 浮起/悬停 |
| `--bg-surface-3` | `#22222C` | `#24242D` | 输入框/嵌套 |
| `--border-subtle` | `rgba(255,255,255,0.07)` | 不变 | 默认描边 |
| `--border-strong` | `rgba(255,255,255,0.14)` | 不变 | hover/focus |
| `--text-primary` | `#F2F2F5` | `#EDEDEF` | 正文 |
| `--text-secondary` | `#A3A3AD` | `#9CA0AA` | 次要 |
| `--text-muted` | `#6B6B76` | `#666B76` | 提示 |
| `--accent` | `#7C6CFF`(紫) | **`#F06418`** | 信号橙:CTA/激活/选中 |
| `--accent-soft` | 紫 14% | `rgba(240,100,24,0.13)` | 强调底 |
| `--accent-glow` | 紫 25% | `rgba(240,100,24,0.28)` | 辉光(仅 CTA/运行态) |
| `--run` | `#38BDF8` | `#F06418` | 运行态收敛进 accent(pulse 区分) |
| `--ok/--warn/--err` | 不变 | 不变 | 状态色,仅状态用语 |

- 橙色在深色上的对比:#F06418 on #0E0E11 ≈ 5.9:1,过 WCAG AA(大文本/图标/边框);
  橙底按钮文字用 `#14100C`(近黑),对比 ≈ 8.6:1
- 排版/形状/动效规范沿用 08-03(≤200ms ease-out、无弹簧粒子);Fraunces 衬线仅 Manju 用,
  影棚风主字族 Inter + 数字 tabular-nums

## 二、结构现状与重构靶点(08-06 盘点结论)

视觉 token 层其实已收敛(hex 零泄漏),真正的靶点是:

1. **三套样式范式并存**:globals.css 全局类 / styled-jsx 局部 / `<style jsx global>` 组件注全局,
   同一视图混用 → 新代码一律 styled-jsx 局部 + token,禁新增 global 注入
2. **弹层手写定位 ×3 处**、Modal/Empty/Skeleton 渗透率 1/3/1 → 统一 Popover(portal)基座,
   空态/加载态强制走 Empty/Skeleton
3. **px 字面量普遍**(DramaStudio 304 处)→ 新/改代码间距走 `--space-*`
4. **壳层样板**:18 视图在 page.tsx 手工三处同步 → 收敛为单张视图注册表
5. **死代码**:framer-motion(死依赖)、ModelPicker/AgentSwitcher(735 行)、
   useTheme/useReducedMotion/useFauxProgress/useScrollParallax(4 死 hook)、
   light 主题死路径(layout 脚本 vs 单套 dark token)

## 三、实施波次

- **W0 换血**:globals.css token 全量替换(色板/运行色收敛);删死代码五项;
  壳层(Sidebar/折叠栏/用户区/登录 LandingPage)按 Studio Slate 重做
- **W1 基座**:Button/Input/Select/Badge/Tabs/Card/Modal/Empty/Skeleton/Switch 新视觉;
  统一 Popover portal 基座,OptimizeButton/FusionView/ShotCard 三处手写定位迁入
- **W2 主视图**:生成工作台(图片/视频/音频,结果区内容全出血 + 进度预览)、
  作品库(杂志式网格 + Remix 回填入口)、融合聚合页(bento 卡)、对话首屏
- **W3 其余**:数字人/译制/Studio/训练/看板/模型/管理逐个过;FROZEN(DramaStudio/Manju)
  只做 token 映射续命,不重写
- 每波:`npx tsc --noEmit` + `npm run build` + e2e authed-views + 1440/390 截图对比,全绿进下一波

## 四、验收标准(每视图,继承 08-03 并加严)

1. 全部走 token,无硬编码 hex;间距优先 `--space-*`
2. 组件五态齐全;图标全 lucide(经 Icon.tsx),零 emoji
3. 空态/加载态走 Empty/Skeleton;弹层走统一 Popover;禁新增 `<style jsx global>`
4. 桌面 1440/1280 与移动 390 三档可用;对比度 WCAG AA
5. 动效全部功能性(状态/进度),≤200ms,遵守 prefers-reduced-motion
