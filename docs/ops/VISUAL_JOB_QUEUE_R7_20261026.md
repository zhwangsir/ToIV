# ToIV 任务队列 UI · 第7轮调研简报

- **日期**：2026-10-26（Asia/Shanghai）
- **执行**：模型调研帮手（Job Queue R7）
- **状态**：已落地校准 tip（`--toiv-job-*` + queue 别名；禁假满条）/ 禁 push
- **校准基 tip**：`1b132535` · R6校准 `4669bf52`
- **承接**：R1 DNA、R2 双闸、R3 `--toiv-create-*`、R4 `--toiv-shot-*`、R5 `--toiv-node-*`、R6 `--toiv-media-*`
- **已钉死**：accent `#5ba0ff`；成人 glow/字 `#4f8cff`；文案「普通｜成人」；创作台左 280 / 右常驻 320 / 详情 420 / 双轨 PiP；成人不改几何
- **方法**：
  - **A 优先实读**：BeefTV 任务中心（`pages/tasks/*` + `globals.css` `.task-record-*`）、LumenX（`QueuePanel` 弹层 + `storyboard-r2v/TaskQueuePanel` 右栏 + `ResultCard` 进度/失败）、Runway 公开帮助/会话文档（无源码像素，记模式）
  - **B 仓重写**（本轮重扫，不复述旧句）：Toonflow-web `taskList`（表格+分页）、AIMovieStudio `GenerationPanel`（面板内轮询文案）、ArcReel/BigBanana/printfilm/koma（多为后端队列或无独立暗色任务中心 UI）、CineGen（阶段台无 job queue）

---

## ⚡ TL / 跨端立刻可用 · 推荐默认 + 硬尺寸表

### 推荐默认（一句话）

**任务中心列表行 min-h 92、缩略 84×60、进度条高 3px（`#5ba0ff` 填充 420ms ease-out）；失败行内重试 32×32 + 冷却禁点；详情抽屉宽 ~736（日志区 max-h 240）；侧栏快览档对齐创作台右栏 320–344；成人闸只滤条目可见性，不改任何 `--toiv-job-*` 几何。**

### 硬尺寸表（跨端可抄 → `--toiv-job-*`）

| Token | 值 | 用途 / 来源对齐 |
|---|---|---|
| `--toiv-job-row-min-h` | **92px** | 列表行最小高（BeefTV `.task-record-row`） |
| `--toiv-job-row-pad` | **12px 14px** | 行内边距 |
| `--toiv-job-row-gap` | **18px** | 列 gap（thumb / main / date / actions） |
| `--toiv-job-row-cols` | **84px 1fr 120px 104px** | 桌面栅格；窄屏改 `60px 1fr 36px` |
| `--toiv-job-row-radius` | **8px** | BeefTV `--r-md`；可升 **12** 对齐 R4 卡 |
| `--toiv-job-row-list-gap` | **2px** | 行与行（密台）；产品档可用 **8px** |
| `--toiv-job-row-hover-bg` | `foreground 4%` | quiet hover；失败行 `error 4%` |
| `--toiv-job-thumb-w` | **84px** | 列表缩略宽 |
| `--toiv-job-thumb-h` | **60px** | 列表缩略高（≈16:11.4；窄屏 **60×44**） |
| `--toiv-job-thumb-compact` | **64×36** | LumenX TaskQueue 紧凑行 |
| `--toiv-job-thumb-expand` | **120×68** | LumenX 展开态 |
| `--toiv-job-title-fs` | **14px / 560** | BeefTV `--fs-body` |
| `--toiv-job-title-max` | **68ch** | 防超宽糊成一片 |
| `--toiv-job-meta-fs` | **11px** | `--fs-label` |
| `--toiv-job-status-fs` | **10px** | `--fs-tiny` |
| `--toiv-job-dot-d` | **7px**（LumenX 侧栏 **8px**） | 状态点 |
| `--toiv-job-dot-pulse` | **1.6s** ping scale→2.1 | running；`prefers-reduced-motion: none` |
| `--toiv-job-progress-h` | **3px** | BeefTV / LumenX ResultCard 同档（主推荐） |
| `--toiv-job-progress-h-toast` | **4px**（`h-1`） | 浮层合并/上传 toast |
| `--toiv-job-progress-h-segment` | **6px**（`h-1.5`） | 分步 toast 段条 |
| `--toiv-job-progress-max-w` | **420px** | 行内进度轨最大宽 |
| `--toiv-job-progress-radius` | **999px** | 全圆角轨 |
| `--toiv-job-progress-track` | `foreground 9%` | 轨底 |
| `--toiv-job-progress-fill` | **`#5ba0ff`** | 禁止抄 BeefTV 灰白 `--workspace-accent`；换 ToIV accent |
| `--toiv-job-progress-dur` | **420ms** | 填充宽过渡 |
| `--toiv-job-progress-ease` | `cubic-bezier(0.22, 1, 0.36, 1)` | 与 R1/R2 统一 |
| `--toiv-job-progress-meta-cols` | `minmax(80px,1fr) 42px` | stage 文案 + `%` |
| `--toiv-job-retry-hit` | **32×32** | 行内 IconButton / ant small（窄屏 **30×30**） |
| `--toiv-job-retry-icon` | **14px**（`size-3.5`） | RotateCcw |
| `--toiv-job-retry-chip` | `px-2.5 py-1` / **10px** 字 | LumenX FailedCard 文案钮备档 |
| `--toiv-job-retry-primary` | `w-full py-2.5 rounded-full` | 详情抽屉主 CTA（LumenX DetailPanel） |
| `--toiv-job-retry-cooldown` | **disabled + tooltip「先看原因」** | BeefTV `taskRetryBlocked`；冷却≠几何变化 |
| `--toiv-job-retry-spin-hold` | **800ms** | LumenX 重试后 spinner 最短保持 |
| `--toiv-job-cancel-hit` | **20–28px** | LumenX Queue 取消 20；侧栏取消/跳转 **28** |
| `--toiv-job-action-reveal` | opacity 0→1 / `translateX(4→0)` **220/320ms** | 桌面 hover 显操作；移动端常显 |
| `--toiv-job-drawer-w` | **~736px**（antd `size="large"`） | BeefTV 任务详情主抽屉 |
| `--toiv-job-drawer-header-h` | **~70px** | `.library-drawer` header min-height |
| `--toiv-job-drawer-pad` | **22–28 / 30** | header/body padding |
| `--toiv-job-drawer-close` | **34×34** | 关钮 |
| `--toiv-job-log-max-h` | **240px**（`max-h-60`） | 日志滚动窗 |
| `--toiv-job-log-radius` | **8–12px** | `rounded-lg` |
| `--toiv-job-log-bg` | `#020617` 级（`slate-950`） | mono 日志底；字 **12px** |
| `--toiv-job-side-w` | **340–344px** | LumenX TaskQueue 右栏（xl push / md overlay） |
| `--toiv-job-side-w-align` | **320px** | 与创作台右常驻对齐的 ToIV 推荐档 |
| `--toiv-job-side-enter` | **280ms** `translateX(24→0)` | `queuePanelIn` |
| `--toiv-job-side-backdrop` | `black/55` + blur 1px / **180ms** | <xl 遮罩 |
| `--toiv-job-popover-w` | **300px** | LumenX 工具栏 Queue 弹层 |
| `--toiv-job-popover-radius` | **16px** | 弹层圆角 |
| `--toiv-job-popover-list-max-h` | **256px**（`max-h-64`） | 排队列表 |
| `--toiv-job-tab-h` | **32px** | Active/Done/Failed 分段 |
| `--toiv-job-toast-w` | **292–320px** | 画布浮层进度 |
| `--toiv-job-toast-bar-h` | **4px** | 浮层连续进度 |
| `--toiv-job-page-size` | **20**（选项 20/50/100） | BeefTV 分页默认 |
| `--toiv-job-batch-retry` | 分组「重试失败任务」 | BeefTV `TaskGroupHeader`；不改行几何 |
| `--toiv-job-empty-pad` | 沿用 WorkspaceState | 分态文案（全部/运行中/完成/失败） |
| `--toiv-job-fail-border` | `status-failed-border` | LumenX FailedCard |
| `--toiv-job-shimmer` | 200% 扫光 + **24** spinner | ResultCard processing（无真%时） |
| `--toiv-job-adult-geometry` | **unchanged** | 成人闸禁止改上表任何几何 |

---

## ① 深度调研与像素级拆解

### BeefTV（A · 任务中心主模板）

- **结构**：全页 Workspace + 状态分段（all/active/failed/succeeded）+ 列表/网格切换 + 可选按画布分组；行 → 详情 `Drawer size="large"`；日志嵌在抽屉内 `max-h-60` mono 块。
- **行几何**：`min-height:92`；栅格 `84 | 1fr | 120 | 104`；pad `12×14`；圆角 `--r-md=8`；列表 gap 仅 **2px**（密台）。
- **进度**：stage + `%` 双列，其下 **3px** 全圆角轨；填充 `transition width 420ms ease-out`；桌面 max-w **420**。
- **失败**：行底 `is-attention` 浅红铺底；错误一行 clamp；重试 **32×32**，`taskRetryBlocked` 时 disabled+提示「先看原因」——冷却是交互态不是尺寸态。
- **批量**：`TaskGroupHeader`「重试失败任务」串行重试可重试子集；分页默认 20。
- **动效**：running 点 **1.6s** ping；操作列 hover 才显（opacity+translateX）；浮层 toast 宽 **320** / 合并条 **292**、进度 **4px**。

### LumenX（A · 双形态：弹层队列 + 右栏总览 + 卡面进度）

- **QueuePanel（playground）**：工具栏 pill → 弹出 **300×圆角16**；并发 ± 钮 **24×24**；排队行 `px-2.5 py-2`；取消 **20×20**；列表 `max-h-64`；空态居中 12px。
- **TaskQueuePanel（storyboard R2V）**：右栏 **344**（xl push）/ **340**（overlay）/ 全屏（&lt;md）；入场 `queuePanelIn` **280ms** `translateX(24→0)`；Tabs Active|Done|Failed 高 **32**；紧凑拇指 **64×36**，展开 **120×68**；行内跳转/取消 **28×28**；失败可 Retry（spinner 最短约 800ms）。
- **ResultCard**：processing 用 shimmer + **24** 环 spinner + 底边 **3px** 估计进度（60s 估满但 cap 90%）；FailedCard 边失败色，行内小 Retry chip `px-2.5 py-1 / 10px`；详情主 Retry 全宽 `py-2.5 rounded-full` + glow。

### Runway（公开文档 · 模式级，无源码钉死像素）

- **Sessions**：生成在右侧时间线流式堆叠（旧在上、新在下）；进度常见「% / 倒计时 / 模糊预览」组合；历史走 Sessions 列表（快捷约 30 条）+ Dashboard 全库。
- **对 ToIV**：可作「创作台内嵌时间线」备选模式，**不**替代任务中心列表；像素以 BeefTV/LumenX 实读为准。

### B 仓重写（本轮新扫）

| 仓 | 本轮发现 | 可抄点 |
|---|---|---|
| Toonflow-web `taskList` | TDesign 表：类目/状态筛选 + vxe 列 + 分页；标题 2rem 浅色后台感 | **只学模式**：筛选条 + 分页；不抄浅色大标题 |
| AIMovieStudio `GenerationPanel` | 面板内 `in_queue`/`Processing` 文案轮询；`text-[10–11px]` 眉题；无独立任务中心 | **只学模式**：内嵌 status 文案；进度几何仍跟 BeefTV 3px |
| ArcReel / BigBanana / printfilm / koma | 队列多在服务端/脚本；无对标暗色任务中心 UI | 不抽几何 |
| CineGen | 阶段台，无 job queue 组件 | 对照「非照抄」 |

---

## ② 照抄与融合方案

| 项 | 1:1 照抄 | 融合 / 改写 | 不抄 |
|---|---|---|---|
| 列表行骨架 | BeefTV 92 / 84×60 / 3px 进度 | 圆角可升 12 对齐 R4；填充色换 `#5ba0ff` | BeefTV 灰白 `--workspace-accent` 当进度色 |
| 失败重试 | 32×32 + 冷却禁点 | 详情用 LumenX 全宽 primary pill | 冷却时改行高/进度高 |
| 日志抽屉 | BeefTV large drawer + log `max-h-240` | ToIV 可用 **420** 常驻 Inspector 嵌日志，大屏再升 736 | 浅色 admin 表头 2rem |
| 侧栏快览 | LumenX 340–344 + 280ms slide | 钉 **320** 与创作台右栏同宽 | Runway 无源码臆造像素 |
| 卡面进度 | LumenX 3px 底边 + shimmer | 有真 progress 时优先 BeefTV stage+% | 无进度时假满 100% |
| 空态 | BeefTV 分态四文案 | 中文保留 | Toonflow 浅色空表 |
| 批量 | 分组「重试失败」 | 顶部也可放 quiet chip | 批量改几何 token |

**主路径**：任务中心页 = BeefTV 列表 DNA；创作台旁快览 = LumenX 右栏 320；生成中卡面 = 3px accent 条。Runway 仅作「会话时间线」可选视图。

---

## ③ 落地蓝图（`--toiv-job-*`）

1. **Token 落盘**：在全局 CSS 增补上表 `--toiv-job-*`；进度 fill 绑定 `#5ba0ff`，成人态不变。
2. **组件切面**：
   - `JobListRow` ← BeefTV `.task-record-row`
   - `JobProgress` ← 3px 轨 + stage/%
   - `JobRetryButton` ← 32 hit + `disabled` 冷却
   - `JobDetailDrawer` ← 736 / 或复用右栏 420 嵌日志
   - `JobQueueSide` ← 320 宽、280ms slide（对齐 LumenX）
3. **状态色**：success / warning(active) / loading(queued) / error — 用现有 palette；字色成人闸仍只动 `#4f8cff` 文案，不动进度轨高。
4. **动效统一**：ease-out `(0.22,1,0.36,1)`；dot ping 1.6s；尊重 `prefers-reduced-motion`。
5. **分页 / 批量**：默认 pageSize 20；分组批量重试不引入新几何 token。

---

## ④ 双闸与连贯性校验

- **成人模式不改队列几何**：所有 `--toiv-job-*` 尺寸、圆角、进度高、抽屉宽、行高在「普通｜成人」间必须位相等；闸只过滤 NSFW 任务/预览可见性（前端单文件过滤，后端不拦）。
- **色例外**：成人字色/glow 仍用 `#4f8cff`；进度填充保持 `#5ba0ff`（任务进度非成人标识）。
- **与前轮连贯**：侧栏快览宽优先 **320**（R3 右常驻）；详情升级档可到 **420**（R3 详情）或抽屉 **736**；行圆角默认 8，升 12 时对齐 R4/R6 卡。
- **校验清单**：切双闸前后截同行、同进度、同抽屉宽；冷却态仅 `disabled`/tooltip，无 layout shift。

---

## Blockers / 未知

1. **Runway**：无开源前端，进度像素无法源码钉死；采用文档模式 + BeefTV/LumenX 实数。
2. **antd Drawer `large`**：惯例 **736px**；若 ToIV 不用 antd，跨端应用 `--toiv-job-drawer-w: 736px` 或产品拍板改 **640/720**。
3. **真进度 vs 估计进度**：LumenX ResultCard 用耗时估计 cap 90%；有 API `progress` 时应用 BeefTV 真百分比，避免双标准抖动。
4. **Mobbin / Exa**：本轮付费墙/限流，未补截图像素；不阻塞实读结论。

---

## 落地状态（跨端校准）

- Token 主钉：`--toiv-job-*`（canvas↔web 双端同文）
- 兼容别名：`--toiv-queue-*` → job
- UI：`CreationStudioQueueDock` 行栅格 thumb 84×60 / 进度 3px / 重试 32
- 进度：**真实 % 或 indeterminate**；禁假满条
- Handback：`apps/canvas/docs/GENERATION_QUEUE_R7_HANDBACK.md` §F

