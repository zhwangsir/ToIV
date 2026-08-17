# 全站 UI 审计报告与「Film Atelier」设计系统实施方案(2026-08-15)

> 起因:作品库 v2(放映厅)验证通过后,用户要求全站 UI 系统性重构 ——
> 「对所有用户界面元素进行全面审查,识别并记录所有 UI 问题,制定并实施完整的 UI 修改方案,
> 确保整体视觉风格、交互体验和功能呈现的一致性与专业性」。
> 审计方式:13 个视图 Puppeteer 真机截图(1280×850,素白主题)+ 19 视图代码盘点 + 共享组件依赖分析。

## 一、视图清单与共享层现状

| 视图 | 组件 | 用 PageHeader | 独立 CSS | 审计方式 |
|------|------|---------------|----------|----------|
| 对话 | AssistantView | ✗(自定义头) | assistant 内联 | 截图 |
| 图片/视频 | GenerateView(共用) | ✓ | stage.css | 截图 |
| 音频 | AudioView | ✓+内嵌 GenerateView(双标题) | stage.css | 截图 |
| 融合 | FusionView | ✗(手写类) | fusion.css | 截图 |
| 画布 | CanvasView | ✓ | canvas 内联 | 截图 |
| 作品库 | LibraryView | ✗(手写,已 v2) | library.css | ✅ v2 完成 |
| 资源 | ResourcesView | ✓ | models 内联 | 截图 |
| 设置 | SettingsView | ✓ | settings.css | 截图 |
| Agent 团队 | /agent-runs 页 | ✗ | agent-runs.css | 截图 |
| 数字人 | AvatarTalkView | ✓ | avatartalk.css | 截图 |
| 译制 | DubView | ✓ | 内联 | 截图 |
| 动态分镜 | AnimaticView | ✓ | animatic.css | 截图 |
| 创作工作室 | StudioView(列表) | ✓ | studio.css | 截图 |
| 图片编辑/视频剪辑 | Image/VideoEditView | ✓ | 内联 | 代码 |
| 训练/模型/backlot/admin/短剧 | Train/Models/Backlot/Admin/Drama | 部分 | 内联 | 代码 |

**共享资产**:ui/PageHeader(14 视图在用)、ui/Button、ui/Card、ui/Badge、ui/Tabs、ui/Ripple;
设计 token(globals.css v6,五主题);library.css v2 已验证的 Atelier 语言(墨丸/玻璃命令条/错落入场/水波纹/masthead)。

## 二、问题清单(按严重度)

### P0 结构性缺陷

| # | 问题 | 实证 | 影响面 |
|---|------|------|--------|
| P0-1 | **页头体系崩坏**:PageHeader 仅 20px 常规字重,无层级;音频/画布/资源页头贴左边缘溢出(x=0,容器失效);音频页「音频工坊」与内嵌 GenerateView 的「AI音频」双标题叠印 | audit_audio/canvas/resources 截图 | 全部 14 个 PageHeader 视图 |
| P0-2 | **Agent 团队页全站最糙**:整页贴边无容器;「历史任务」为纯文字 bullet 流(状态/进度/日期挤成一行);输入区全宽灰条;无卡片无排版 | audit_agentruns 截图 | /agent-runs |
| P0-3 | **空态无设计**:GenerateView「你的作品将在这里呈现」、AssistantView「今天想创作什么?」——超大系统黑体无字体性格,点阵背景平庸,空态无引导氛围 | audit_image/assistant 截图 | Generate/Assistant |

### P1 设计语言三代同堂

| # | 问题 | 实证 |
|---|------|------|
| P1-1 | **段控/chip 三套并存**:library v2 墨丸 vs 资源「本地模型/在线市场」灰框段控 vs 数字人「实时对话/视频生成」更旧样式 vs GenerateView 引擎选择器 | audit_resources/avatartalk/image |
| P1-2 | **徽章/状态语言不统一**:设置「可用」绿底徽章、资源 SAFETENSORS 描边徽章、融合 tag 灰胶囊、library 状态点 —— 四套 | audit_settings/resources/fusion |
| P1-3 | **按钮层级混乱**:「进入应用」「选择文件」「解析并生成短剧」「新建项目」各长各样,主次不分 | audit_fusion/animatic/dub/studio |

### P2 质感与布局

| # | 问题 | 实证 |
|---|------|------|
| P2-1 | **卡片千卡一面**:圆角白卡 + 灰 icon 色块(设置/融合/译制/分镜),无发夹线无呼吸 | audit_settings/fusion/dub |
| P2-2 | **布局失衡**:融合旗舰卡右半全空;数字人左舞台大面积空白只有线框 icon;译制页下半屏空白 | audit_fusion/avatartalk/dub |
| P2-3 | **容器嵌套**:资源页内容被包进不必要的第二层白面板 | audit_resources |
| P2-4 | **步骤条简陋**:译制 4 步向导 = 黑圆点数字 + 灰锁 icon | audit_dub |
| P2-5 | **项目列表行信息排版稀疏**:创作工作室「未命名项目/草稿/日期」一行裸排,删除 icon 裸露 | audit_studio |

## 三、设计系统方案(Atelier v6.1 扩展)

### 原则(锚定用户偏好)

暗房/剪辑台隐喻:UI 退后、作品为主角;浅色编辑排版;克制的物理动效;
零 hex(全 token 五主题)、字重/时长全 token、prefers-reduced-motion 全覆盖、
z-index 语义档、测试断言类名不动。

### 分层实施

```
L0 共享层(globals.css + ui/PageHeader.tsx)
   ├─ PageHeader masthead 化:kicker(可选 prop)+ Fraunces 展示标题 + 编辑双线
   ├─ 修页头容器溢出(音频/画布/资源贴边)
   └─ 新共享类:.at-chip(墨丸) .at-seg(墨丸段控) .at-badge(编辑徽章)
       .at-card(发夹线+软阴影+hover 呼吸) .at-empty(Fraunces 空态)
       .at-btn-primary(墨丸) .at-btn-ghost(发夹线次钮) .at-card-in(错落入场)
L1 视图适配(小 DOM 改动,换共享类)
   ├─ 核心创作:GenerateView(引擎段控/空态/参数面板)、AssistantView(空态/建议卡/顶栏)
   ├─ 工作室:Fusion(旗舰卡/tag)、AvatarTalk(页头/舞台/形象卡)、Dub(步骤条/上传)、
   │   Animatic(上传/参数)、Image/VideoEdit
   └─ 系统:Settings(卡片/徽章)、Resources(段控/列表/去嵌套)、Studio(项目行)、
       Admin/Models/Train/Backlot/Canvas(页头)
L2 重点页重塑
   └─ /agent-runs:任务卡片化(标题/进度条/状态点/时间分行),输入区玻璃命令条化
```

### 验收

- web 132+ 测试全绿(类名不动,新增类纯附加);tsc 零错误;ui_lint 0 FAIL
- 每视图 Puppeteer 截图核验(素白+浅木双主题抽查)
- 性能:50 卡作品库渲染不低于 v2 基线(764ms)
