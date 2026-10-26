# Generation Queue · R7 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`4669bf52`（R6 `--toiv-media-*` 校准）  
合规：LumenX=A（任务条模式参考，**未并码**）；Runway 等公开模式重写。  
不动：光幕位置（仍顶栏最右）、三栏几何。

---

## A. 调研融合点

| 源 | 闸 | 取 | 舍 |
|----|----|----|----|
| LumenX 任务条 | A | 顶栏旁轻量入口 + 进度可读 | 未复制源码 |
| Runway 队列气质 | 公开 | 进行中计数、失败可重试 | 无像素照抄 |
| 既有 `CanvasActiveTaskPanel` / task-center API | repo | `listGenerationTasks` / `retry` / `cancel` / `listTaskLogs` | 不新开第二壳；不拆光幕 |
| redline | repo | NSFW 任务灰锁（普通） | 自造第二闸 |

**结论**：`CreationStudioQueueDock` 挂**顶栏 actions（光幕左侧）**；`/create` 另有底栏抽屉条。

---

## B. 1:1 / 钉死点

| 项 | 值 |
|----|-----|
| 挂载 | 顶栏旁（LightCurtain **之前**）+ `/create` 底栏 |
| 进度 | 真实 `%` 或 indeterminate（`--toiv-job-progress-h: 3`）；**禁假满条** |
| 失败 | 「重试」→ `retryGenerationTask` |
| 日志 | 行内抽屉 → `listTaskLogs` / `formatTaskLog` |
| 普通 NSFW | 灰化 + `NsfwLockBadge`；禁重试/取消 |
| 成人 | 可见可操作 |
| 轮询 | 4s（`--toiv-queue-poll-ms`） |
| 成人几何 | unchanged |

---

## C. 落地蓝图

| 层 | 路径 |
|----|------|
| 坞 | `components/create/creation-studio-queue-dock.tsx` + `.css` |
| 顶栏 | `components/layout/workspace-top-bar.tsx` |
| Token | `toiv-freezone-tokens.css` `--toiv-job-*` + `--toiv-queue-*` 别名（canvas↔web） |
| API | `@/services/api/task-center` |

---

## D. 双闸连贯性

| 项 | 规格 |
|----|------|
| 光幕 | 位置未改；队列在其左侧 |
| NSFW | 任务 prompt/model/type 走 `assetLooksNsfw`；普通锁操作 |
| 文案 | 普通/成人 |
| 三栏 | 未改 |

---

## E. 风险

- 底栏与顶栏共享同一列表状态（同组件双表面）；窄屏可能叠画布内容。
- NSFW 判定依赖 prompt/model 字符串兜底，无显式 `is_nsfw` 字段时可能漏标。
- **未 push**。

---

## F. R7 硬表校准（`--toiv-job-*`）

日期：2026-10-26（Asia/Shanghai）  
基 tip：`1b132535`（R7 功能 tip）  
TL：可 alias `--toiv-queue-*`；**禁假满条**；禁 push。

| 钉 | 值 |
|----|-----|
| 行 min-h | 92px |
| 缩略 | 84×60 |
| 进度条 | 3px / `#5ba0ff` / 420ms ease |
| 重试 hit | 32×32 icon |
| 抽屉宽 | 736（token 预留）；坞 popover 300 |
| 日志 max-h | 240 |
| 侧栏 / 入场 | 320 / 280ms |
| 进度规则 | `task.progress` 有限数 → 定宽；running 无 % → `is-indeterminate`；**从不写死 100%** |
| 别名 | `--toiv-queue-*` → `--toiv-job-*` |

改动文件：双端 `toiv-freezone-tokens.css`、`creation-studio-queue-dock.{tsx,css}`、本 handback、`docs/ops/VISUAL_JOB_QUEUE_R7_20261026.md`。

