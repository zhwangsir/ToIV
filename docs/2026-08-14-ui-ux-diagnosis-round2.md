# ToIV UI/UX 二轮诊断报告 · 优化方案 · 量化目标（2026-08-14）

> **方法**：3 路并行静态审计（视觉一致性 / 交互可用性 / 性能），覆盖 apps/web 全部 80 个 tsx、15 个 css、22 个视图级组件、6 个路由。所有数字来自真实 grep/文件实测，非估算。
> **前提**：一轮 UI-A~D（commit 1900c96）已建立 token 基座（102 个 :root 变量、4 套主题）、动效原语（Ripple/MagnetFollow/ParticleButton）、共享件（ErrorBar/LoadingBlock/PageHeader）。本轮是二轮深度诊断，目标从「建体系」转为「收编残余 + 补结构短板」。

---

## 一、总体结论

| 结论 | 说明 |
|---|---|
| 视觉基座 | **优**。token 单一来源、硬编码色 ≈15 处且均有理由、旧紫色清零、圆角/阴影收编彻底 |
| 交互主干 | **良**。SSE 重连+降级+熔断是全站最强维度；登录表单是 a11y 范本；零 alert、静默吞错仅 3 处 |
| 三大结构短板 | ① **品牌资产/PWA 从零缺失**（无 favicon/manifest，themeColor 写死）② **CSS 210KB 全量全局注入**，与视图级 JS 分包成果不对等 ③ **共享组件采用率分裂**（PageHeader 1/22、LoadingBlock 6/22、ErrorBar 13/22），各视图自写一派 |

---

## 二、问题诊断（按严重度分级）

### P0 — 用户可感知 / 品牌 / 反馈正确性

| # | 问题 | 证据 | 影响 |
|---|---|---|---|
| P0-1 | **品牌资产完全缺失**：app 目录 0 个 icon/manifest 文件，public/ 仅 .gitkeep；`themeColor` 硬编码 `#FFFFFF` 不随 5 套主题切换 | layout.tsx:40-51；glob icon\* 0 命中 | 浏览器标签页无图标、无法安装为 PWA、移动端主题色错误 |
| P0-2 | **3 处不可逆删除无二次确认**：助手删会话（AssistantView.tsx:252-267）、助手删文档（:457）、风格卡删除（LibraryView.tsx:507-514） | 均为直接 delete + toast，无确认 | 误触即丢数据，作品/会话不可恢复 |
| P0-3 | **自动保存/上传成功静默**：ShotCard 失焦即保存无任何成功/失败持续指示；参考素材上传成功静默入列 | useStudioProject、RefImageUpload:45 | 用户无法确认「已存上」，弱网下焦虑重复操作 |
| P0-4 | **CSS 210.9KB 源码全量全局注入**：14 个样式文件在 layout.tsx 静态 import，agent-runs(19.1KB)/avatartalk(21.1KB)/stage(32.2KB)/library(28KB) 等视图专用样式未随 lazy chunk 分割；构建后 CSS 165KB 任何路由首屏全量加载 | layout.tsx:3-15；.next/static/css 实测 | 首屏 CSS 负担 ≈3 倍于必要量，与 JS 分包成果不对等 |

### P1 — 一致性 / 可用性明显缺口

| # | 问题 | 基线 | 证据 |
|---|---|---|---|
| P1-1 | 确认载体双轨：原生 `window.confirm` 6 处 vs Modal 确认（Library/Admin 已迁） | 6 处 | AgentRunView:33、StudioView:67、ScriptStage:61、CastStage:47、DramaView:94/2106 |
| P1-2 | 共享组件三分裂：ErrorBar 13/22、LoadingBlock 6/22、PageHeader **1/22**；自写错误块/骨架/纯文字「加载中」并存 | 13/6/1 | LibraryView:574 自写 lib-error、StudioView:91 自写 studio-error、AgentRunView:147 自写 agent-error-text |
| P1-3 | `<button>` 无 `type=` 属性 197/227（86.8%） | 197 处 | 全站 grep； LandingPage:144 有 submit、Modal 系有 button，规范不统一 |
| P1-4 | `font-weight` 数字硬编码 69 处/8 css（值与 token 同但未走 var），`var(--font-*)` 仅 27 处 | 69 处 | agent-runs.css 16 处最多、globals.css 11 处 |
| P1-5 | 错误文案「中文壳 + 英文后端 message」直拼普遍 | 多处 | AvatarTalkView:280、AgentRunView:147、useAgentRun.ts:379 |
| P1-6 | 全站 20 张 `<img>` **0 张有 width/height**，CLS 防护全押 CSS；next/image 使用 0 | 0/20 | LibraryView:237、ShotCard:81、ResultPanel:65、TaskCardList:127 |
| P1-7 | StoryboardStage 5s `setInterval` 轮询不走 usePoll，页面隐藏仍发请求 | 1 处 | StoryboardStage.tsx:40 |
| P1-8 | Admin 删除确认弹窗自写 overlay：有 Esc 无 focus trap（ui/Modal 已有 useFocusTrap 未复用） | 1 处 | AdminView.tsx:449 起 |

### P2 — 收编残余 / 增强项

| # | 问题 | 基线 |
|---|---|---|
| P2-1 | z-index 裸值：tsx 内嵌 style ~13 处（AssistantView 9 处、BacklotView:816 的 90 超全站档）+ avatartalk.css 10/11、library.css 1/2/3 | ~29 处 |
| P2-2 | 循环/骨架动画字面时长 ~20 处未走 `--duration-loop/pulse`（splash 2s、settings-skeleton 1.4s、promptbar-breathe 2.4s 等） | ~20 处 |
| P2-3 | useBreakpoint 仅 2/22 视图消费（Assistant/Generate），其余响应式全靠 css | 2/22 |
| P2-4 | 数值进度仅 3 条链路（ImageEdit/ResultPanel/Train）；Dub 长任务、Storyboard 批量生成仅状态文字 | 3 条 |
| P2-5 | 视图私有按钮类（av-*/lib-* 等 ~100 处）与 .btn 双轨并存 | ~100 处 |
| P2-6 | 无暗色模式：prefers-color-scheme 0 命中，5 套主题全浅色 | 0 |
| P2-7 | 大列表无虚拟化：作品库「加载更多」追加至数百卡后 DOM 线性增长；VideoEdit map 16 处全站最密 | 0 库 |
| P2-8 | polyfills 110KB（现代浏览器可裁剪）；声明式资源提示（preload/preconnect）0 处 | 110KB |
| P2-9 | 内联 style={{ 47 处/25 文件（9 处为错误页有意内联，其余多为动态值，可接受但可再收） | 47 处 |

---

## 三、优化方案

### 阶段 V1 — 品牌与反馈正确性（P0-1/2/3）

1. **品牌资产从零补齐**：生成 icon.svg（源）→ icon-192/512.png + apple-icon.png；新增 `app/manifest.ts`（name/short_name/theme_color 用 var 对应值/standalone）；`metadata.icons` 接线；themeColor 改为主题跟随（按 data-theme 读 --bg 计算值，注入脚本同步）。
2. **删除确认补齐**：助手会话/文档、风格卡 3 处接入 ui/Modal danger 模式（复用 Library 删除弹窗样式）；统一文案「确认删除」。
3. **保存/上传反馈**：ShotCard 失焦保存加轻量指示（字段旁 · 保存中/已保存 HH:mm/失败红条三态）；上传成功 toast.success 统一。

### 阶段 V2 — CSS 按视图分割（P0-4）

- layout.tsx 仅保留 globals.css + 壳层 cornernav.css；stage/library/avatartalk/agent-runs/studio/settings/animatic/docs 等 12 个视图样式移到对应 lazy 视图入口 import（Next 自动按 chunk 分割 CSS）。
- **风险**：类名冲突（各视图 css 无前缀隔离）需先 grep 交叉引用；迁移后全路由截图回归（复用 e2e/symmetry-check.spec.ts 思路）。

### 阶段 V3 — 一致性收编（P1-1/2/3/4/5）

1. window.confirm 6 处 → ui/Modal 统一；Admin 自写弹窗改走 ui/Modal（顺带获得 focus trap，消 P1-8）。
2. 共享件推广：Library/Studio/AgentRun/Settings/Canvas/Generate 自写错误块 → ErrorBar；骨架/纯文字加载 → LoadingBlock；PageHeader 推广到全部主视图（统一标题层级+副文案+操作区插槽）。豁免项写入组件 docstring（Fusion/Pipeline 等结构性豁免）。
3. 按钮 type 批量补齐 197 处（脚本化：form 内默认 submit、其余 button）。
4. font-weight 69 处 → var(--font-medium/semibold/bold) 机械替换。
5. 错误文案规范化：lib/api.ts 统一 message 出口（后端英文 message 映射/包裹中文壳），消灭直拼。

### 阶段 V4 — 性能与健壮性（P1-6/7、P2-7/8）

1. 20 张 img 补 width/height（或 css aspect-ratio 强制），Library/ResultPanel 产物图优先；评估 next/image 启用成本（需配 remotePatterns 对 /api/images 代理 + 签名 URL 兼容，易错点 26）——签名 URL 每请求变化会使 next/image 优化缓存失效，**建议保持原生 img + 尺寸属性 + lazy，不迁 next/image**。
2. StoryboardStage 5s setInterval → usePoll（页面隐藏暂停 + 退避）。
3. 作品库列表评估轻量虚拟化（react-virtuoso 或自写 IO 占位回收），阈值 >200 卡启用；VideoEdit 轨道区 keep。
4. next.config 加 `compiler.removeConsole`（生产）与现代浏览器 targets 裁剪 polyfills；对 /api 源加 preconnect（LAN 直连场景）。

### 阶段 V5 — 体验增强（P2 余项，可选）

- 数值进度推广：Dub 长任务、Storyboard 批量（x/N 计数即可）。
- z-index/动画时长/内联样式收尾收编；useBreakpoint 推广到 Library/Admin/Settings。
- 暗色主题设计（第六套 data-theme=dark，token 覆盖块已有成熟模式，成本主要在视觉走查）。
- 视图私有按钮类向 .btn 归并（大工程，建议随各视图迭代渐进，不设硬目标）。

---

## 四、实施建议

| 团队 | 范围 | 依赖/冲突 | 建议顺序 |
|---|---|---|---|
| Team V1 | P0-1/2/3 品牌+确认+保存反馈 | 无冲突，文件独立 | 第一波（小、快、用户可感知） |
| Team V2 | CSS 按视图分割 | **与 V3 共享件推广有文件级冲突**（同改视图文件），必须串行：先 V3 后 V2 | 第三波 |
| Team V3 | P1 一致性收编（confirm/共享件/type/font-weight/文案） | 触及几乎全部视图 tsx | 第二波 |
| Team V4 | 性能（img 尺寸/usePoll/虚拟化/polyfill） | 与 V3 在 LibraryView 冲突，协调或串行 | 第二波（错开文件） |
| Team V5 | P2 增强 | 全部串行于前四者之后 | 按余量 |

**硬性要求**：
- 每波完成后跑 `npm run test`（web 78 例）+ `tsc` + `next build`，全绿才进下一波。
- 视觉变更波次必须过 e2e 截图对比（symmetry-check 基线）。
- CSS 分割波次先在本地 build 验证 chunk 拆分生效（.next/static/css 数量与体积变化），再部署。

---

## 五、可量化目标与评估标准

### 5.1 目标表（基线 → 目标）

| 指标 | 基线（2026-08-14 实测） | 目标 | 测量方式 |
|---|---|---|---|
| favicon/manifest | 0 文件 | icon+apple-icon+manifest 全配，themeColor 随主题 | 文件存在性 + 浏览器标签页/安装横幅实测 |
| 无确认不可逆删除 | 3 处 | **0** | grep 删除调用点逐一核对 |
| 自动保存状态指示 | 0 | ShotCard 等自动保存链路 100% 有三态指示 | 代码审查 + 手测弱网 |
| 首屏 CSS（构建产物） | 165KB 全量 | 主路由首屏 **≤ 60KB**，视图 css 随 chunk 分割 | .next/static/css 实测 + 路由级覆盖分析 |
| window.confirm | 6 处 | **0**（全走 ui/Modal） | grep |
| ErrorBar 采用 | 13/22 | 20/22（2 结构性豁免） | grep import |
| LoadingBlock 采用 | 6/22 | 18/22 | grep import |
| PageHeader 采用 | 1/22 | 18/22 | grep import |
| button 无 type | 197 处 | **≤ 5 处**（均须有注释理由） | grep 脚本入 CI |
| font-weight 硬编码 | 69 处 | **0**（全走 --font-*） | grep 脚本入 CI |
| 中英混拼错误文案 | 普遍 | api 出口统一，直拼 **0** | grep `: ${.*message}` 模式 |
| img 无尺寸属性 | 20/20 | **0/20**（width/height 或 aspect-ratio） | grep + axe |
| 失控轮询 | StoryboardStage 5s 常跑 | 0（全走 usePoll/可见性暂停） | 代码审查 |
| z-index 裸值 | ~29 处 | ≤ 5 处（极大值护栏除外） | grep 脚本入 CI |
| 动画字面时长 | ~20 处 | 0（全走 --duration-*） | grep 脚本入 CI |
| 数值进度链路 | 3 条 | ≥ 5 条（+Dub、+Storyboard 批量） | 手测 |
| axe-core 严重违规 | 未持续测（e2e 有基础设施） | **0 critical / 0 serious**，全主路由纳入 e2e | playwright + axe-core CI |
| Lighthouse（移动档，北京入口实测） | 未测（本轮补基线） | Performance ≥ 85、Accessibility ≥ 95、Best Practices ≥ 95 | Lighthouse CI |
| Core Web Vitals | 未测（本轮补基线） | LCP ≤ 2.5s、INP ≤ 200ms、CLS ≤ 0.05（作品库/生成页） | Lighthouse + web-vitals 上报 |
| 回归门禁 | pytest 1531 / web 78 | 全绿 + 新增 grep 门禁脚本入 CI | CI |

### 5.2 评估方法

1. **CI grep 门禁**（新增 `scripts/ui_lint.sh` 或 eslint 自定义规则）：font-weight 数字、z-index 裸值、button 无 type、window.confirm、动画字面时长 —— 命中即 fail，防止回潮。
2. **axe-core e2e 扩展**：在现有 playwright+axe 设施上把主路由（生成/作品库/Studio/助手/模型/设置/登录）全纳入，critical/serious 为 0 才放行。
3. **Lighthouse CI**：对 toiv.wineryz.top（国内入口，链路最快最稳）跑移动档，分数入 TEST_LOG。
4. **构建预算**：next build 产物中主 chunk ≤ 300KB、首屏 CSS ≤ 60KB，超限告警。
5. **人工启发式走查**：每波结束后对 22 视图做 10 分钟/视图的 Nielsen 启发式走查，记录问题入库。

---

## 六、不在本轮范围

- 后端/算力侧优化（H3 散热、跨境链路等，见 STATE.json P1 基础设施清单）。
- 视图级信息架构重设计（如 Studio 工作流重构）——本轮只做一致性与反馈层。
