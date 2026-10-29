# ToIV 前端 UI 重建 · 设计 Spec

> 状态：v1（2026-10-29）· 已获用户批准进入 spec 阶段（三面原型 + 融合身份）
> 需求基线：`docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-requirements.md`
> 可交互原型：`tmp/ui-proto/`（`bun run dev` → http://127.0.0.1:5199；取证截图 `/tmp/proto-*.png`）
> 实施计划：本 spec 复审通过后由 superpowers:writing-plans 产出

---

## 1. 目标与范围

把 `apps/canvas/web` 的 UI **整体重建**（不在旧 UI 上继续修改），`apps/web` 薄壳仅换身份不重构逻辑。重建产出：

1. 一套设计系统（token / 组件 / 状态 / 动效），横切三个范式面；
2. 三个范式面：**流水线面**（主面，剧本/素材/分镜/视频阶段）、**画布面**（探索/分支/一致性）、**剪辑湾面**（成片/音画/导出，现产品缺失，本次补齐）；
3. 共享页：媒体库、任务中心、设置、插件、智能体；
4. 旧 UI 冻结 → strangler 逐页切换 → 切换完成后物理删除旧壳与旧样式。

不在范围：后端任何改动（零审查纪律不变）、业务逻辑重写、移动端编辑、`/desktop*` Cosmos 交付。

## 2. 硬约束（继承需求清单 A 节）

- 本地优先；限制只在前端；**锁文件 `content-lock.ts` 为唯一限制来源**，经 `@content-lock` 消费，删除后构建/启动/功能照常（no-op 回落）。
- 新 UI 组件内**禁止**内容判断（nsfw/敏感词/红线）；门控只经 `GateBadge / AdultVeil / HiddenNotice` 三个组件，三者只读 `@content-lock`。
- 技术栈保持 React + Vite（canvas）/ Next（web）；业务层（zustand stores、react-query、services、API 契约）**不动**，新 UI 只换视图层。
- 许可：dramaclaw / ToonFlow / BeefTV 均为参考**视觉语言与交互范式**，**不 vendor 其源码/CSS**（dramaclaw 为 Elastic-2.0）；实现全部自写；字体仅 OFL/系统字体。

## 3. 视觉身份（基准：dramaclaw SuperTale + ToonFlow/BeefTV 融合）

### 3.1 语义 token（约 60 个，取代现有 597 个 `--toiv-*`）

暗色为默认（视频工作），亮色同结构换值；oklch 语义色。

| token | dark | light | 用途 |
|---|---|---|---|
| background | `#090909` | `oklch(.9605 .0046 258.32)` | 应用底 |
| surface-1 / 2 / 3 | `.185/.225/.27` (chroma .006–.01, hue 258) | `1 / .985 / .968` | 面板/卡/抬升 |
| foreground | `oklch(.9436 .0051 228.82)` | `oklch(.2153 .0187 235.13)` | 主文字 |
| muted-fg / faint-fg | `.6637/.48` | `.5589/.72` | 次/三级文字 |
| border / border-strong | `.2456 / .34` | `.9436 / .86` | 发丝线/强线 |
| primary | `oklch(.72 .145 205)` 电光青 | `oklch(.54 .13 210)` | 主操作/选中/环 |
| primary-soft | primary @14% | 同 | 选中底/焦点环 |
| success / warning / destructive | `.72 .15 150` / `.78 .15 75` / `.68 .19 29` | 同族降亮 | 状态三色 |
| overlay | 黑 @60% | 深灰 @50% | 模态遮罩 |

尺寸/形/动效 token：`radius 16/12/9/6/pill`；`shadow-1/2/3` 柔散（dark `0 4px 12px` 起）；`space 4/8/12/16/24/32`；`type 11/12/13/14/16/20/26` + mono 标签档；`dur-1 150 / dur-2 220 / dur-3 300ms`；`ease-out = ease-tab = cubic-bezier(.22,.8,.24,1)`；`prefers-reduced-motion` 全部归零。

### 3.2 签名件（身份识别点）

1. **sliding-tabs 白药丸滑块**：激活 tab = foreground 底 + background 字；滑块 300ms `ease-tab` 滑动（流水线七段、面切换、画布/文档段控共用）。
2. **companion 小爪浮泡**：右下/左下浮泡 + 圆形吉祥物；按面换台词；可关且设置记忆；禁自动弹出频率 > 1 次/会话/面。
3. **PIKO 计时 chip**：mono + 宽字距，仅用于倒计时/时码（系统等宽模拟，不引新字体）。
4. **aurora 环境光**：仅壳层/登录/空态/加载，透明度 ≤10%，禁全局铺满。
5. **focus-visible 环** = primary-soft 3px；删除确认唯一使用 destructive。

### 3.3 反 AI-slop 纪律（验收硬指标）

禁：全局玻璃拟态、霓虹多色、渐变 logo、pill 海、等宽微标签海、均匀卡片网格、粒子/无意义循环动画。
指标：新系统 `!important` = 0；内联 style ≈ 0；硬编码色值 = 0（全走 token）；单文件 CSS ≤ 800 行。

## 4. 三面范式

### 4.1 流水线面（主面）
布局：header（lockup + 面切换 + sliding-tabs 七段 + 任务胶囊 + 主操作 + 头像）/ 左轨（场次目录，tab：场次/素材/产物 —— BeefTV 媒体池语义）/ 中（阶段视图：素材=场景多视图四联组 + 悬停动作行；分镜=镜头卡网格 + 检查器；剧本=beats 词锚编辑）/ 右检查器（设定 + 起始/结束帧 + takes + 进度）/ 全局任务抽屉。
内容语法（融合 aid-studio/巨日禄，经需求清单确认）：多视图组 + 视图锁、阶段完成勾/当前下划线、takes 一等公民。

### 4.2 画布面（ToonFlow 语法）
全屏点阵画布；节点卡 = 深色框 + 内图 + 上方 mono 标签 + 圆形端口；分组 = 主色 tint 矩形 + 标签；边 = 细灰贝塞尔，选中=主色发光，Agent 提议=主色虚线；浮动 chrome：左上面包屑胶囊、顶中"画布/文档"段控、左下工具条(选择/平移/分组/连接/取景/缩放/帮助)、右下 minimap；右 Agent 面板（消息泡 + 项目状态摘要 + 建议 chips + composer：@ 引用 + 模型选择 + 圆形发送）；**方案候选卡**（方案 N + ✓ 择一 + 生成方案，ToonFlow 导演台语法，映射我们的 takes/候选）。

### 4.3 剪辑湾面（新增，BeefTV/AIMovie/Descript 语法）
镜头条（缩略+时长+状态环）/ 中央 letterbox 预览（时码 HUD）/ transport（播放头跨轨联动）/ 多轨序列（V1 视频 clip 青、A1/A2 音频 clip 绿带波形、播放头发光）/ 左 takes 轨 / 右参数列（模型/时长/转场/响度 + Render MP4）/ fusion 能力入口（EDL 体检、剪点计划、成片自评、视觉下钻、transcript 词级检索）。

### 4.4 共享件
⌘K 命令面板、任务抽屉（三源）、toast 区（右下单列 ≤3、4s）、companion、ErrorBoundary 与 generation-failure 通知（语义不变、身份换装）。

### 4.5 表达层缺口补位（2026-10-29 能力矩阵审计结论）

| 缺口 | 优先级 | 落点 | 新增组件 |
|---|---|---|---|
| Agent 规划/审批 UI（矩阵 #1） | P1 | 画布面 Agent 面板增"规划态/工具调用/审批"三态：提议边(虚线)→审批条→执行回执；任务抽屉链 agent run 详情 | ApprovalBar ToolCallRow |
| 配方分享闭环（#2） | P1 | 流水线面"配方"tab：复用/从镜头存/导出 JSON/安装/分享链接；插件中心去 feature-gate | RecipeCard ImportDialog |
| 多视图 UI（#7） | P0 | §4.1 四联组+视图锁；多状态/360° 仅留占位入口（P2） | （ViewGroup 已列） |
| 成片交付入口（#9） | P0 | 剪辑湾顶栏"导出"菜单：Render MP4 / SRT 侧车 / packed transcript / EDL / QA 报告 | ExportMenu |
| 双轨一等公民（#12） | P0 | header 面切换即双轨入口；面间互跳保留上下文（项目/选中镜头/时间码） | FaceSwitcher |
| 创作伴侣（#14） | P1 | CompanionBubble + 设置项（人设文案/主动提示频率/关闭记忆）；nudges 来源 = art-critique、任务完成、门控变化；频率 ≤1/面/会话 | （CompanionBubble 已列） |

## 5. 组件库

- 底座：**弃 antd**。新组件自建于已装依赖：Radix / react-aria-components + shadcn 模式 + class-variance-authority + tailwind-merge + motion；图标单一来源 lucide-react。
- 约定：CVA variants + `data-state` 语义 + focus-visible + reduced-motion；组件不写内容判断；不写 RGB/px 硬编码。
- 清单（46）：Button IconButton SlidingTabs Segmented Menu Dialog Sheet Drawer Toast Tooltip Popover Select Combobox Input Textarea Slider Switch Checkbox Radio Tag Badge StatusDot Progress Skeleton EmptyState ErrorState Card MediaTile ViewGroup TakeStrip ShotStrip TrackLane NodeCard PlanCard ApprovalBar ToolCallRow RecipeCard ImportDialog ExportMenu FaceSwitcher AgentBubble CompanionBubble CommandPalette KeyValue SectionHeader FieldGroup。
- 门控三组件：GateBadge AdultVeil HiddenNotice（只读 `@content-lock`）。

## 6. 架构与迁移

- 新系统目录：`apps/canvas/web/src/studio/`（`studio/theme/tokens.css` 单一 token 源、`studio/ui/` 组件库、`studio/shell/` 壳、`studio/faces/{pipeline,canvas,edit}/`）。
- 路由对外 URL 不变；新增 `/edit`（剪辑湾）。router 按面分发；未迁移路由仍走旧 `UserLayout`。
- strangler 顺序：① token+组件库 → ② 流水线面（素材/分镜）→ ③ 剪辑湾 → ④ 画布壳 → ⑤ 库/任务/设置 → ⑥ 删旧壳与 `globals.css` 等旧样式、删 antd 依赖。
- 每步一个 commit + 四套件绿 + 真机截图；回退开关 = 构建期常量 `STUDIO_FACE_FALLBACK`（按面粒度，默认新实现），保留至旧代码删除前。
- `apps/web` 薄壳：仅换 token 与登录/落地/handoff 视觉，逻辑不动；双端 token 同步改为**单源生成**（脚本从 `studio/theme/tokens.css` 产出 web 副本，废掉人工字节同步）。

## 7. 状态与反馈规范

状态三色：done=success / running=warning(+脉冲) / queue=faint；失败=destructive 仅图标与重试按钮边框。
空态带示例动作（从图片创建 / 导入 SVML / 新建画布）；加载骨架优先于 spinner；toast 语义=结果而非过程；长作业进度=条+百分比+可取消。

## 8. 测试与验收

- 组件测试断言语义（role/label/state），**禁 RGB/像素钉值**；关键流 e2e：登录→create→渲染→任务→库→导出；锁删除演练；四套件绿为合并门禁。
- 对比度 CI（≥4.5:1）；债务指标见 §3.3；首屏 JS ≤ 现状、路由切换无白屏。
- 美观门禁：真机三方截图对照（新 vs 三家参照 vs 旧）逐面用户签字；原型 `tmp/ui-proto` 为视觉基线参照。

## 9. 不做清单

`/desktop*` 默认交付、opentalking 数字人、web 引擎台、旧 skills 入口、dev labs 进生产、`/home` 独立首页、移动端编辑、KPI/插件/eagle/workflow 测试台（P2 延后）、全局玻璃/霓虹/粒子。

## 10. Roadmap 附录（本次不做，单列立项）

| 项 | 矩阵 # | 现状 | 立项触发条件 |
|---|---|---|---|
| 3D 导演台（走位/运动/时间线/录制） | #3 | 后端 threed_ops 产物建档 + director-viewport(react-three) 在；无舞台 UI | 三面重建落地且短剧主链稳定后 |
| 导演世界（360°/3D 布景/机位/取景） | #8 | 运镜仅渲染元数据；panorama-node 仅全景 | 与 3D 导演台同立项 |
| 分支叙事（互动剧集） | #4 | chapters 在；无分支产品化 | 有真实多分支剧本需求时 |
| 团队协作（共享/角色/成本看板） | #10 | tenant+role(admin/user)+credits 挂 Tenant 在；无协作 UI | 出现第二个真实协作租户时 |
| 对外 source-available | #15 | 自托管链路完整但仓库私有 | 运营拍板，非工程问题 |
