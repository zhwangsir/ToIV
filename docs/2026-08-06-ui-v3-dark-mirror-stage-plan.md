# ToIV UI v3 调研与优化方案(2026-08-06)

> 背景:v2(Studio Slate 换肤)+ 版型改动(窄轨/工作台反转/masonry)+ 灵动岛导航之后,
> 用户反馈「现在的 UI 效果我觉得一般」。问题不在配色和导航形式,而在**视觉深度、内容主角感、
> 交互质感**三个层面。本文档基于对 2025-2026 前沿 AI 创作工具的调研给出 v3 方向。

## 一、调研对象与结论

### 1. Krea.ai —— 内容即界面,工具后退
- 实时画布(50ms 级生成)把「结果」放在绝对主角位,参数收进浮动面板,界面 chrome 退到几乎隐形
- 节点画布(Krea Nodes)50+ 模型混排,但默认视图极其干净:一个大画布 + 底部提示词条
- 来源:[Krea AI Real-Time Canvas](https://thecascadehub.com/krea-ai-real-time-canvas-fast-visual-iteration/)、[Krea vs Astorie](https://astorie.ai/vs/krea)

### 2. FLORA / Astorie —— 无限画布成为创作工具的默认形态
- Figma 式无限画布 + 非线性创作旅程可视化;「老虎机式单发提示词」被行业明确视为上一代范式
- 对 ToIV 的启示:我们的「画布」模块方向是对的,但主工作台(generate)仍是表单范式
- 来源:[TechCrunch: Flora infinite canvas](https://techcrunch.com/2025/03/02/flora-is-building-an-ai-powered-infinite-canvas-for-creative-professionals/)、[Chase Jarvis: canvas apps 横评](https://chasejarvis.com/blog/best-generative-ai-canvas-apps/)

### 3. Midjourney Web —— 提示词条是英雄控件 + 个性化风格库
- 中央大提示词条承载一切:参数以 chip(风格/比例/模型)吸附在条上,表单永不整面展开
- Moodboard/风格档案:用户从自己的图库养风格,生成时一键套用 —— 风格是一等公民资产
- 来源:[Midjourney Moodboard](https://generativeai.pub/midjourney-unveils-moodboards-feature-a-new-personalization-model-9c8ff6a7eacc)、[srefhunt 指南](https://srefhunt.com/how-to-use-midjourney-moodboard/)

### 4. Liquid Glass(玻璃拟态 2.0)—— 2026 落地的材质语言
- 从 2021 毛玻璃进化为:backdrop blur + 饱和度提升 + 折射感描边 + 分层景深;
  用途是**建立层级**——浮层明显「浮」在内容之上,而非装饰
- 来源:[UI/UX Trends 2026: Spatial UI & Glassmorphism 2.0](https://superfiles.in/ui-ux-design-trends-2026-spatial-glassmorphism.php)、[Rajesh R Nair: 2026 实际落地的趋势](https://rajeshrnair.com/blog/design/ui-ux/ui-design-trends-2026-bento-grids-glassmorphism.html)

### 5. 趋势层共识
- Bento 网格与深色模式在 2026 仍是落地主力(我们已有);增量在**微交互、空间景深、排版张力**
- 「GenUI 运行时生成界面」仍处实验期,不适合生产(一致性/a11y 风险)——不做
- 来源:[Sanjay Dey: 2026 UX/UI 数据指南](https://www.sanjaydey.com/ux-ui-design-trends-2026-biggest/)、[Blog UX: 2026 新规则](https://blog-ux.com/en/ux-ui-trends-2026-the-new-rules-of-design/)

## 二、我们的现状诊断(为什么「一般」)

| 层面 | 现状 | 差距 |
|------|------|------|
| 视觉深度 | 纯平面:surface-1/2 两档灰卡 + 1px 描边,无模糊/无景深/无光影 | Krea/MJ 的内容全出血 + 玻璃浮层,层级靠景深而非描边 |
| 内容主角感 | 结果区仍是「面板里的一栏」,空态大标题虽有编辑部感但占比保守 | 生成结果应是舞台:全出血、暗角、选中即沉浸 |
| 提示词体验 | 提示词是 inspector 表单里的一个 textarea,优化按钮是 Popover | MJ/Krea:提示词条是页面英雄控件,chips 吸附,参数渐进披露 |
| 交互质感 | 过渡只有 fast/standard 两档淡入淡出 | 弹簧缓动、stagger 入场、hover 物理感、骨架微光 |
| 风格资产 | style_hint 是一个文本输入 | MJ Moodboard:风格是可命名、可复用、有缩略图的卡片资产 |

## 三、v3 方案:「黑镜剧场」(Dark Mirror Stage)

一句话:**让作品成为舞台,让工具变成浮在内容上的玻璃。**

### P0 — 材质升级:Liquid Glass 浮层体系(全局,1-2 天)
- 新增 `--glass` 材质 token:`backdrop-filter: blur(20px) saturate(1.4)` + 半透明 surface + 1px 高光内描边(`inset 0 1px 0 rgba(255,255,255,.06)`)
- 应用点:灵动岛胶囊、参数 inspector、账户 Popover、OptimizeButton Popover、底部提示词条
- 全局叠加 2% 噪点纹理(SVG feTurbulence data-URI,一次绘制)消除纯色扁平感
- 阴影系统升级:浮层用 `0 8px 32px rgba(0,0,0,.5)` + 橙色主按钮加 `0 0 24px rgba(240,100,24,.25)` 信号光晕

### P1 — 生成工作台剧场化(generate 三视图,2-3 天)
- 结果区去卡片化:全出血暗舞台,选中作品大图 + 底部胶片条(filmstrip 缩略图横排),左右键切换
- 参数 inspector 改**玻璃浮板**浮在舞台右侧(不再占 grid 列),可一键收成右下角悬浮球
- 提示词提升为**底部中央提示词条**:大圆角玻璃条,聚焦时微微上浮 + 橙色描边呼吸;
  风格/比例/引擎以可拆卸 chips 吸附在条内;「优化」结果直接替换条内文本并高亮 diff 感
- 表单其余参数(步数/CFG/种子)收进「高级参数」抽屉,默认折叠(渐进披露)

### P2 — 风格资产卡片化(作品库 + 优化,1-2 天)
- 作品库图片可「存为风格」:生成风格卡片(缩略图 + 名称 + AI 提炼的 style_hint),
  落在新的「风格库」横条(工作台提示词条上方或作品库顶部)
- 点风格卡 = 把它的 style_hint 注入优化器(复用现有 style_hint 管线,零后端改动)
- 这是对 Midjourney Moodboard 的最小可行复刻,也是我们 style_hint 功能的自然进化

### P3 — 动效质感(全局,1 天,纯 CSS)
- 弹簧缓动:`linear()` easing 模拟 spring,用于灵动岛展开、浮层进出
- 作品库 masonry 条目 stagger 淡入(每列延迟 30ms)+ hover 1.03 缩放 + 快捷操作浮层(查看/存风格/复用提示词)
- 生成中:结果区骨架卡 shimmer(微光扫过)替代 spinner
- 页面切换:同名元素 cross-fade(View Transitions API,渐进增强,不支持则无副作用)

### 不做清单(明确排除)
- ❌ 不引入 framer-motion/任何动画库(全部 CSS 可达)
- ❌ 不做运行时 GenUI(实验性,一致性风险)
- ❌ 不改九模块 IA、不动灵动岛交互模型(只升级材质)
- ❌ 不动后端 API(P2 风格卡复用现有 assets/style_hint 管线)

## 四、验证方式
- 每 P 完成:tsc + build + axe 双尺寸扫描(玻璃材质对对比度敏感,必须重扫)+ 本地 e2e
- 全部完成:全量 e2e → 部署 core → 生产 e2e + 截图逐视图过
