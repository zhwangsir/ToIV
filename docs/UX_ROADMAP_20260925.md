# ToIV 体验优化并行计划（2026-09-25 起，与公开卡收尾同步推进）

> 用户口径（2026-09-25）：测试与修复的同时持续推进项目优化与便利，UI/UX 是常驻工作线，不等收尾结束。
> 纪律：遵守 `docs/UI_STANDARD.md` 与 `docs/UI-整改方案-20260907.md` 裁决链（单色极简 + RunningHub 市场 + 主题系统），不走回头路。
> 节奏：每个 2 小时自动巡检周期，收尾分诊之后若有余量，推进下表中**一项**小步（改动 → 测试 → 部署 → 真机核 → 入账）。

## 0. 与收尾共存的硬约束

- **不打断烟测**：重启 `toiv-api` 会杀掉正在跑的烟测。前端改动走「仅 web」部署（本地干净构建 → 同步 `.next` → 只重启 `toiv-web`），不跑全量 `deploy.sh`。后端改动尽量攒批，一次重启，随后复测被打断的卡。
- 验证只走 Tailscale（core 100.77.80.100），不走公网隧道。
- 每项：web jest / api pytest 全绿 + 真机截图 + `TEST_LOG.md` 条目 + 双推 main。

## 1. 已完成（本次核对确认，不再排）

- 对话＝智能体：侧栏合并单入口（`b65cef4`）；P0 生成留在对话、门户技能 chips、任务回会话（`cf2c10d`）；空态 greeting + 动效（`cdac9e4`）。
- 移动端底部「对话」CTA 已跳真对话；助手移动端底部 sheet（A4）；会话分叉 `forkAgentSession` 已接 UI。
- 工具结果卡注册表已建（optimize_prompt / search_knowledge / list_apps / list_models / create_storyboard / 自愈两件）。
- 作品库：文件夹「删除整组」、无缩略图类型占位（破图兜底）。
- 市场：「已验证可用」筛选与 PASS 徽标（读 `smoke_status`）。
- Admin wave6：收尾快照 + 批量 soft-hide。

## 2. 待推进（按用户价值排序）

| # | 项 | 内容 | 来源 |
|---|---|---|---|
| U1 | 失败时用户侧自愈 ✅ | 应用跑失败时给用户看大白话原因 + 「一键重试 / 换一张同类卡」；自愈从运维工具升为用户可见卡（2026-09-26 06:30） | 对标调研 P1-5 |
| U2 | 多步计划步骤条 ✅ | 对话中多步任务显示「计划 / 进行中 / 完成」步骤条（`propose_plan.steps` + body 推断；提案卡 `AvPlanSteps`）（2026-09-26 14:16） | 对标调研 P1-6 |
| U3 | 活知识 ✅ | `search_knowledge` 接入公开 PASS 市场卡说明/可用状态；`list_apps`/`get_app` 标注实测可用性并优先推荐 PASS（2026-09-26 16:14） | 对标调研 P1-4 |
| U4 | 生成作业卡入注册表 ✅ | submit_generation / run_app / generate_image 结果统一走工具卡注册表（复用 av-job 样式；与消息级 AvJobCards 同 job_id 去重）（2026-09-26 20:14） | 助手重设计 A1 |
| U5 | 市场可用性透明 ✅ | 卡片「实测可用 · 相对时间」；未测卡沉底（`sortAppsVerifiedFirst`）；随收尾自动变好看（2026-09-25 18:14） | 收尾衍生 |
| U6 | 主题全站走查 ✅ | 补卡控 paper×dark / paper×dark×pure-black（text/accent/status/chart）；cinema/graphite 源码断言 ok/warn/err+soft；token 无需改动；themeContrast 92/92（2026-09-26 22:25） | UI 整改 P1 |
| U7 | Admin 作业与队列域 ✅ | 全员作业列表 + 行内取消/重跑/删除/恢复 + 回收站视图（`JobsQueueAdminView` 已上线；2026-09-27 00:14 巡检入账） | Admin 重规划 P1 |
| U8 | Admin 实测矩阵实装 ✅ | `GET /api/admin/test-matrix` + 矩阵页「实时收尾进度」接 `closeout-summary`（公开 PASS/未测/超时一眼可见；L0/L2 历史快照保留）（2026-09-27 00:14） | Admin 重规划 P2 |
| U9 | Admin 模型资产域 | 本地模型浏览 + `MODEL_SOURCES` 只读视图 | Admin 重规划 P2 |
| U10 | 小程序同步 | MiniProgram 对齐市场瀑布流/详情/主题（独立工作量，收尾后） | UI 整改 P4 |

## 3. 运维便利（同线推进）

| # | 项 | 内容 |
|---|---|---|
| O1 | 仅 web 部署脚本 ✅ | `deploy/deploy.sh --web-only`：不重启 API，保护正在跑的烟测（2026-09-25 10:14 巡检落地） |
| O2 | 烟测可续跑 ✅ | API 重启后自动把被打断的 `running` 卡放回待测队列，不再手工复测（2026-09-26 00:14，`reconcile_interrupted_smokes`） |
| O3 | 超时分级 ✅ | 重图/插帧/大模型图升到视频档 1800s；`timeout_s` 可覆盖；超时取消 worker job（2026-09-25 22:14，`0e2fdba`） |

## 4. 进度入账

每完成一项在本表标记 ✅ + commit，并在 `TEST_LOG.md` 记一条；项目管家同步到五件套。
