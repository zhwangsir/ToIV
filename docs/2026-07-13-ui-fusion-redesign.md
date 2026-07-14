# ToIV UI 重构设计文档 v2

> **日期**: 2026-07-13
> **状态**: 设计阶段,待用户审核
> **范围**: 前端视觉与交互层重构(不改后端 API 契约)

---

## 1. 背景与目标

### 1.1 不满意的核心

当前 UI 是「Obsidian Atelier」风格(黑曜石暗底 + 翡翠绿单色 + 硬边切割 + 轻玻璃质感),存在四个核心问题:

1. **配色单调**——翡翠绿单色冷硬单一,缺乏层次
2. **布局太工具化**——侧栏+顶栏+主区像传统 SaaS 工具,缺少创作平台氛围
3. **交互太平**——按钮和卡片缺少质感和动效
4. **整体方向错**——视觉语言与主流 AI 创作平台脱节

### 1.2 设计目标

参考主流 AI 视频生成平台三大流派,融合重构:

| 流派 | 代表 | 借鉴点 |
|---|---|---|
| 工具画布派 | Runway / Hailuo / Kling | 左图标栏 + 中画布 + 右参数面板,专业工具感 |
| 对话流派 | Sora / Pika | 聊天式交互,AI 主动拆解需求并调用工具 |
| App 卡片派 | Kling / Dreamina | 能力中心网格入口,按场景分类 |
| 视觉基调 | Kling / Hailuo 工作区 | 纯黑底 + 中性灰阶 + 单一品牌色(靛蓝) |

**核心原则**: 克制不花哨,内容为主角,UI 退后。

---

## 2. 视觉系统

### 2.1 配色系统(替换当前翡翠绿)

```
背景阶梯(替代当前 oklch 黑曜石):
  --bg-0: #0a0a0c   /* 页面底:纯黑微暖 */
  --bg-1: #0e0e11   /* 一级表面:卡片底 */
  --bg-2: #16161a   /* 二级表面:抬升卡片 */
  --bg-3: #1f1f23   /* 悬停/选中底 */

描边:
  --hairline: #1f1f23
  --hairline-2: #2a2a30
  --hairline-strong: #3a3a42

文字:
  --ink: #fafafa       /* 主文字 */
  --ink-soft: #d4d4d8  /* 次文字 */
  --ink-faint: #71717a /* 弱文字 */

品牌色(靛蓝,替代翡翠绿):
  --accent: #6366f1
  --accent-hover: #818cf8
  --accent-deep: #4f46e5
  --accent-soft: #a5b4fc
  --accent-quiet: rgba(99, 102, 241, 0.12)
  --accent-wash: rgba(99, 102, 241, 0.06)
  --accent-line: rgba(99, 102, 241, 0.35)

状态色:
  --success: #34d399
  --warning: #fbbf24
  --error: #f87171
  --info: #60a5fa
```

### 2.2 图标系统(Lucide React,全局唯一图标源)

**规矩**: 所有项目统一使用 Lucide React,禁止 emoji、其他图标库或自定义 SVG。

**接入方式**:
```bash
npm install lucide-react
```

**统一封装** `apps/web/components/ui/Icon.tsx`:
```tsx
import { type LucideIcon, MessageSquare, Sparkles, ... } from "lucide-react";

const ICON_MAP = {
  // 侧栏导航(10)
  chat: MessageSquare,           // AI 助手/对话
  create: Sparkles,              // 创作
  canvas: LayoutGrid,            // ComfyUI/画布
  manju: Clapperboard,           // 漫剧/视频
  dub: Mic,                      // 译制/配音
  train: BrainCircuit,           // 训练
  library: FolderOpen,           // 作品库
  backlot: KanbanSquare,         // 看板
  models: Boxes,                 // 模型库
  admin: Settings,               // 管理
  // 通用操作(8)
  send: ArrowUp, upload: Upload, download: Download,
  delete: Trash2, close: X, menu: Menu, search: Search, refresh: RefreshCw,
  // 状态(5)
  success: CheckCircle2, error: AlertCircle, loading: Loader2,
  playing: Play, queued: Clock,
  // 内容类型(6)
  image: ImageIcon, video: Video, audio: Music,
  model3d: Box, file: FileText, link: Link,
} as const;

export function Icon({ name, size = 18, className }: {
  name: keyof typeof ICON_MAP;
  size?: number;
  className?: string;
}) {
  const Cmp = ICON_MAP[name];
  return <Cmp size={size} className={className} strokeWidth={1.75} />;
}
```

**全项目调用方式**: `<Icon name="chat" />` 或 `<Icon name="video" size={20} />`

### 2.3 字体(沿用)

- Display: Fraunces(衬线 display,杂志感)
- Body: Geist(几何 body,克制)
- Mono: JetBrains Mono(代码/参数/数值)

---

## 3. 布局架构

### 3.1 主框架(三栏结构)

```
┌──────────────────────────────────────────────────────────┐
│ Topbar(52px)  logo · 面包屑 · ··· · 模型徽章 · 头像      │
├────┬─────────────────────────────────────────────────────┤
│ S  │                                                     │
│ i  │                                                     │
│ d  │            Main View(对话/画布/能力)                │
│ e  │                                                     │
│ 64 │                                                     │
│ px │                                                     │
└────┴─────────────────────────────────────────────────────┘
```

- **Topbar**: 52px 高,左 logo + 面包屑(当前视图路径),右模型徽章(GLM-5.2 / Kimi-K2)+ 用户头像
- **Sidebar**: 64px 宽,**纯图标**(替代当前 220px 文字栏),只含 8 个导航项 + 2 个分隔
- **Main**: 自适应,根据 view 切换布局

### 3.2 视图重组(10 个并列 → 3 种模式)

当前 10 个并列视图改为 3 种"模式",每个模式内部可切换具体子视图:

| 模式 | 子视图 | 布局 |
|---|---|---|
| **对话流(默认)** | AI 助手 | 全屏对话流,顶部输入框,AI 响应在流中渲染视频/图像 |
| **工具画布** | 创作 / 漫剧 / 译制 / ComfyUI / 训练 | 左画布 + 右参数面板(280px) |
| **能力中心** | 作品库 / 看板 / 模型库 / 管理 | 卡片网格入口 |

**导航交互**:
- 侧栏点击图标 → 切换模式
- 模式内部子视图通过顶部 Tab 切换
- 对话流中 AI 调用工具时,自动跳转到对应画布(带"返回对话"按钮)

### 3.3 默认入口(从"工具栏"改为"对话流")

登录后默认进入**对话流**,而非当前的"助手"视图。用户一句话描述需求,AI 主动拆解并调用工具:

> "帮我生成一段赛博朋克城市夜景,15 秒,电影感运镜"

AI 响应:
1. 拆解需求(底图 → 关键帧 → Wan 2.2 驱动 → 15 秒)
2. 在对话中展示进度
3. 生成完毕在对话中渲染视频预览
4. 用户点击"精细调整" → 跳转到工具画布

---

## 4. 组件改造清单

### 4.1 新增组件

| 组件 | 路径 | 用途 |
|---|---|---|
| `Icon.tsx` | `components/ui/Icon.tsx` | Lucide 图标统一封装 |
| `ChatComposer.tsx` | `components/chat/ChatComposer.tsx` | 对话流顶部输入框(带工具选择器) |
| `ChatMessage.tsx` | `components/chat/ChatMessage.tsx` | 对话消息气泡(支持内嵌视频/图像/进度) |
| `ParamPanel.tsx` | `components/canvas/ParamPanel.tsx` | 通用右侧参数面板(画布模式共用) |
| `CapabilityCard.tsx` | `components/cards/CapabilityCard.tsx` | 能力中心卡片 |

### 4.2 改造组件

| 组件 | 改造内容 |
|---|---|
| `Sidebar.tsx` | 220px 文字 → 64px 图标(Lucide) |
| `Topbar.tsx` | 加面包屑、模型徽章 |
| `page.tsx` | View 类型从 10 个并列改为 3 种模式 |
| `globals.css` | 翡翠绿 → 靛蓝;移除 Glassmorphism 模糊 |
| `AssistantView.tsx` | 改造为对话流,支持内嵌媒体渲染 |
| `CreateStudio.tsx` | 改造为画布+参数面板布局 |
| `ManjuStudio.tsx` | 改造为画布+参数面板布局 |
| `DubStudio.tsx` | 改造为画布+参数面板布局 |
| `LibraryView.tsx` | 改造为卡片网格 |
| `BacklotView.tsx` | 改造为卡片网格 |
| `ModelLibrary.tsx` | 改造为卡片网格 |
| `AdminPanel.tsx` | 改造为卡片网格 |

### 4.3 删除/替换

| 项 | 处理 |
|---|---|
| 所有 emoji 图标 | 替换为 `<Icon name="..." />` |
| `NavIcon.tsx`(自定义 SVG 图标) | 删除,由 Icon.tsx 替代 |
| `--mesh-1` 到 `--mesh-4`(翡翠渐变光晕) | 删除 |
| `--glass-*` Glassmorphism 变量 | 删除(保留 --glass-panel 作纯色替代) |

---

## 5. 交互模式

### 5.1 对话流(模式 A,默认)

- **顶部**: 固定输入框(类似 ChatGPT/Sora),支持 `/` 唤起工具选择器
- **中部**: 消息流,用户消息靠右(靛蓝气泡),AI 消息靠左(深灰气泡)
- **媒体内嵌**: AI 生成的视频/图像直接在消息中渲染(带播放控件 + "精调"按钮)
- **工具调用透明**: AI 调用工具时显示 `⚙ 已调用 generate_video · 进度 42%`
- **跳转**: 点击"精调" → 自动跳转到对应画布模式

### 5.2 工具画布(模式 B)

- **左侧画布区**: 大画布预览(图像/视频/分镜网格)
- **右侧参数面板**(280px): 分组参数(底模/采样/尺寸/LoRA 等),实时同步
- **顶部**: 工具切换 Tab(文生图 / 图生图 / 文生视频 / ...)
- **底部**: 生成按钮 + 历史预览条

### 5.3 能力中心(模式 C)

- **卡片网格**: auto-fill minmax(280px, 1fr),每卡 4:3 比例
- **分类**: 创作能力(6 卡) + 资产管理(4 卡)
- **卡片内容**: Lucide 图标 + 名称 + 简短描述
- **点击**: 跳转到对应模式 A 或 B

---

## 6. 不改造范围(保留)

以下不动,避免过度改造:

- 后端 API 契约(97 个端点不动)
- ComfyUI worker 池
- LLM 双大脑路由
- 三重质量防线
- Backlot 后端
- `api.ts` / `types.ts` 数据层
- `motion.ts` 动画常量(仅调整曲线,不改结构)
- `LandingPage.tsx`(落地页,本次不动)
- 鉴权流程(`auth` 相关)

---

## 7. 实现策略

### 7.1 分阶段(避免大爆炸式重构)

**Phase A:基础层**(先做,可独立验证)
1. `npm install lucide-react`
2. 创建 `components/ui/Icon.tsx`
3. 改造 `globals.css`(翡翠绿 → 靛蓝)
4. 改造 `Sidebar.tsx`(220px 文字 → 64px 图标)

**Phase B:框架层**
5. 改造 `Topbar.tsx`(面包屑 + 模型徽章)
6. 改造 `page.tsx`(View 类型从 10 个 → 3 种模式)
7. 替换全项目 emoji/NavIcon 为 `<Icon />`

**Phase C:视图层**(逐个改,可并行)
8. `AssistantView.tsx` → 对话流
9. `CreateStudio.tsx` → 画布+参数
10. `ManjuStudio.tsx` → 画布+参数
11. `DubStudio.tsx` → 画布+参数
12. `LibraryView.tsx` → 卡片网格
13. `BacklotView.tsx` → 卡片网格
14. `ModelLibrary.tsx` → 卡片网格
15. `AdminPanel.tsx` → 卡片网格

### 7.2 验证

- 每个 Phase 完成后 `npm run build` 验证编译
- Phase B 后用浏览器打开,视觉走查侧栏/顶栏/配色
- Phase C 每个视图改完后单独走查
- 最终 `next build` 完整验证

---

## 8. 风险与回滚

| 风险 | 缓解 |
|---|---|
| 配色替换影响面大 | globals.css 变量替换,非硬编码颜色,改一处全替换 |
| 64px 侧栏在移动端太挤 | 移动端仍用抽屉式(点击汉堡展开) |
| 对话流内嵌媒体渲染复杂 | 复用现有 `imageUrl()` / `trackJob` 逻辑,仅改 UI 呈现 |
| 10 视图改 3 模式可能破坏深链 | 保留 `?view=` 参数,向后兼容 |
| framer-motion 动画曲线调整 | 仅调 spring 参数,不删除动画 |

**回滚**: 所有改动在 git 可回滚。globals.css / page.tsx 是主要改动点,单独回滚即可恢复原视觉。

---

## 9. 完成标准

1. `next build` 通过,无 TS 错误
2. 全项目无 emoji 图标(统一 Lucide)
3. 配色为靛蓝主题(无翡翠绿残留)
4. 侧栏 64px 纯图标
5. 10 视图收敛为 3 种模式
6. 默认入口为对话流
7. 浏览器走查 10 个子视图无视觉错乱
