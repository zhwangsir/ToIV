# ToIV UI 重构 · 设计系统与信息架构定调

> 2026-08-03 定稿。大爆炸重写,一次定型,后续所有视图开发以此为准。
> 风格依据:AI-Design-System-Prompt.md 2.2 Dark Premium 演化。

## 一、风格定调:Obsidian(深曜)

**一句话**:近黑画布上的专业创作台——素材(图/视频)是唯一的高光,UI 永远退后。

- 参考:Linear(层级与排版)、Runway(创作台布局)、Raycast(密度与键盘感)
- 气质:dark premium / content-first / 工程感,不要营销页味、不要玻璃拟态花哨
- 图标:lucide-react 经 `components/ui/Icon.tsx`,线性 1.75px,不用彩色填充图标

### 色彩 token

| token | 值 | 用途 |
|---|---|---|
| `--bg-canvas` | `#0B0B0F` | 页面底色 |
| `--bg-surface-1` | `#121218` | 卡片/面板 |
| `--bg-surface-2` | `#1A1A22` | 浮起面板/悬停 |
| `--bg-surface-3` | `#22222C` | 输入框/嵌套 |
| `--border-subtle` | `rgba(255,255,255,0.07)` | 默认描边 |
| `--border-strong` | `rgba(255,255,255,0.14)` | hover/focus 描边 |
| `--text-primary` | `#F2F2F5` | 正文 |
| `--text-secondary` | `#A3A3AD` | 次要 |
| `--text-muted` | `#6B6B76` | 提示/占位 |
| `--accent` | `#7C6CFF` | 唯一强调色(CTA/激活态/进度) |
| `--accent-soft` | `rgba(124,108,255,0.14)` | 强调底色 |
| `--accent-glow` | `rgba(124,108,255,0.25)` | 强调辉光(仅 primary CTA/运行态) |
| `--ok` | `#34D399` / `--warn` `#FBBF24` / `--err` `#F87171` | 状态色(仅状态用语) |
| `--run` | `#38BDF8` | 生成中/运行态专用 |

### 字体与排版

- 字体族:`"Inter", "PingFang SC", -apple-system, sans-serif`;数字/参数用 `tabular-nums`
- 档位:页面标题 20/700、区块标题 15/600、正文 14/400、辅助 12/400、标签 11/500(大写 +0.04em)
- 行高:标题 1.3、正文 1.6

### 形状与动效

- 圆角:面板 12px、控件 8px、小徽章 6px
- 阴影:不用彩色阴影;浮层 `0 8px 24px rgba(0,0,0,0.45)`
- 动效:全部 ≤ 200ms,`ease-out`;hover 只做 surface 升一档或 border 变强;加载用 accent 细条/旋转(Icon loading + spin);**禁止**弹簧、弹跳、粒子
- 间距基数 4px,面板内边距 16/20px,区块间隔 24px

### 组件状态(所有交互组件必备)

default / hover(surface+1 或 border-strong)/ active(accent-soft + accent 文字)/ focus(1px accent 外描边)/ disabled(40% 透明,禁事件)

## 二、信息架构(IA)

### 旧问题

按"功能"切 14 个视图,引擎时代到来后"视频生成"散落四处(create/video/ltxstudio/nsfw),加引擎就要加视图,导航无限膨胀。

### 新 IA:按创作流,8 个一级入口

| # | 入口 | 承载 | 旧视图去向 |
|---|---|---|---|
| 1 | **对话** | AI 助手(agent + RAG) | assistant |
| 2 | **生成** | **统一生成工作台**(新):图像/视频统一,引擎选择器(LTX/H3/PuLID 链路/NSFW 按权限),参数区随引擎 schema 动态渲染 | create + video + ltxstudio 合并;nsfw 作为引擎分级而非独立页(/nsfw 路由保留直达) |
| 3 | **短剧** | 短剧工作室(旗舰);动态分镜入口并入短剧首页 | dramaStudio + animatic |
| 4 | **数字人** | 实时对话 + 全身生成 | avatartalk |
| 5 | **画布** | 节点编排 | canvas |
| 6 | **译制** | 配音/对口型/听写/翻译 | dub |
| 7 | **作品库** | 全部产物统一浏览 | library |
| 8 | **资源** | 模型库/训练/看板/管理(二级 tab) | models/train/backlot/admin |

### 导航形态

- **桌面:左侧固定边栏**(220px,可折叠为 56px 图标栏),顶部 logo + 主导航,底部用户区;取代动态岛(动态岛交互新奇但信息容量小、不适合 8 入口 + 二级)
- **移动/窄屏:底部导航**(沿用 BottomNav 模式换皮,≤5 个主入口 + 更多)
- 短剧工作室内部保持左中右三栏,但纳入全局 token

## 三、统一生成工作台(新视图,重构的核心载体)

目标:**接入新引擎 = 注册引擎 + 参数 schema,不再开新视图**。

- 顶部模式段控:图像 | 视频
- 左侧参数栏(320px):prompt + 负面(引擎支持时)、参考图(多图)、引擎选择器(下拉带状态点:可用/不可用原因)、动态参数区(由后端 capabilities/引擎元信息驱动:分辨率/时长/步数/cfg/LoRA/音频开关)、生成按钮(primary,运行态转 --run)
- 右侧结果区:当前任务大卡 + 历史网格(会话内),支持 SSE 进度、对比查看(A/B 两栏)
- 引擎注册表:前端从 `GET /api/models/engines`(若无则新增)拉取;NSFW 引擎仅 R18 用户可见
- 首批引擎:LTX t2v/i2v(现有)、图像 txt2img/img2img(现有)、H3(待 ComfyUI 0.30 后注册)

## 四、实施波次(大爆炸,但有序)

- **W0 地基**:globals.css token 全量替换;`components/ui/` 基座(Button/Card/Panel/Input/Select/Tabs/Badge/Switch/Modal/Empty/Skeleton 按新规范);新 app 壳(左侧栏 + 路由映射 + 视图懒加载保留);旧动态岛/底栏换皮或替换
- **W1 工作台**:统一生成工作台新视图 + 引擎注册表(后端若无 engines 元信息端点则补)
- **W2 主视图**:短剧工作室(含 animatic 并入)、对话、数字人
- **W3 其余**:画布、译制、作品库、资源四页、/nsfw、/drama/[id]
- 每波完成跑 `npx tsc --noEmit` + `npm run build`;全部完成后统一部署

## 五、验收标准(每个视图)

1. 全部走 token,无硬编码 hex(全局 grep 抽查)
2. 组件五态齐全;图标全 lucide(经 Icon.tsx),零 emoji
3. 轮询用 usePoll、请求用 apiFetch、上传有校验(既有纪律继承)
4. 桌面 1440 / 1280 与移动 390 三档可用
5. 对比度 WCAG AA(正文 ≥4.5:1)
