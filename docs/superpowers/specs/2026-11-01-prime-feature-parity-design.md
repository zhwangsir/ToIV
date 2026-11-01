# ToIV Prime 功能 / UI 对等优化 · 设计与审计基线

> 状态：实施基线 v1（2026-11-01）
> 触发：用户要求「每个对应的功能和 UI 去参考其他人的项目进行比对优化」，并选择「全面追平功能」。
> 范围：Prime 创作壳（`frontend/app`）的全部页面与功能；后端只在核对后确实缺口的点做增量。
> 关联：`third_party/AI_STUDIO_REFERENCE_REPORT.md`（参考行为与路线）、
> `docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-requirements.md`（功能不丢失基线）、
> `docs/WAVE2_ABSORB_LEDGER.md`（许可证纪律）。

---

## 0. 结论摘要

1. **参考报告已过时一半**：其 §5 把配方库、修订历史、渲染报价、阶段确认、多轨导出列为「缺失/部分」，
   但按 2026-11-01 源码核对，这些能力在 `backend/api/app/routes/studio.py`、
   `studio_recipes.py`、`jobs.py` 已有完整接口与测试。**真正的缺口在 Prime 前端没有接线**。
2. **唯一明确的后端缺口是 P0-1 跨集资产对账台账**：没有只读聚合端点，也没有漂移点/合并建议的读模型。
   其余批次以「前端消费既有契约」为主，避免重复造后端。
3. **执行顺序**：B1 任务中心 → B2 分镜台阶段壳 + 生成闭环 → B3 资产对账（唯一后端增量）→
   B4 剪辑湾 → B5 项目库/设置/模型能力 → B6 全量验收与发布。
4. **不掀后端契约**：所有既有路由、字段、鉴权、幂等语义保持不变；新增字段只做纯增量。
5. **不 vendor 参考仓代码**：dramaclaw（Elastic-2.0）、BeefTV（SAL 1.0）、ArcReel（AGPL-3.0）、
   BigBanana/CineGen（NC）只借鉴行为与视觉语言；LumenX/Toonflow-app/printfilm（MIT）可参考实现但重写。

---

## 1. 参考口径与许可证

| 参考项目 | 许可 | 可借鉴 | 不可做 |
|---|---|---|---|
| dramaclaw | Elastic-2.0 | 视觉语言、三面壳、任务条、资产卡交互 | 复制源码/CSS/品牌 |
| BeefTV | SAL 1.0 | 信息架构、项目库空态、响应式 | 复制源码/皮肤 |
| ArcReel | AGPL-3.0 | 制作状态三轴、阶段 rail、剪辑湾布局、报价单行为 | 复制源码；衍生分发需合规评估 |
| LumenX | MIT | 任务诊断、资产对账、候选对比、模型设置 | 直接复制需保留版权声明；本项目选择重写 |
| Toonflow-app | MIT | 阶段方法论、ProviderDefinition、成本徽标 | 保留版权声明后可复用代码 |
| Toonflow-web | Apache-2.0 + 补充条款 | 时间线/预览交互 | 遵守补充条款，不复制素材 |
| printfilm | MIT | 运行时健康视图、空态/错误态规范 | 保留版权声明 |
| BigBanana / CineGen / AIMS2 | NC / NC / AGPL | 场景卡、镜头四分区、Continuity Chain 行为 | 只读参考，不并码 |

**统一纪律**：行为可以逐条对齐，代码一律自写；视觉走 ToIV 现有 token（`#090909` 深底 + 电光青），
不引入参考仓的字体、图标包、CSS 变量或截图资产。

---

## 2. 逐面 parity 矩阵（核对到源码）

图例：✅ 已有且 Prime 已用；◐ 后端已有、Prime 未接/半接；✗ 后端也缺。

### 2.1 全局壳 / 项目库

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 顶栏常驻制作状态条（集进度 / 下一步 / 通知 / 配置红点） | ArcReel `ProjectStatusBar` | ◐ `ToivWorkbar` 只有三面切换 + 运行数 | 下一步投影、通知抽屉、配置红点、离开拦截 | B1/B2 |
| 项目卡：封面 + 进度轴 + 待修复胶囊 + 相对时间 + hover 菜单 | ArcReel/LumenX/BeefTV | ◐ `ProjectHome` 有标题/来源/镜头数 | 封面、进度、待修复、相对时间、筛选/视图切换 | B5 |
| 新建向导：固定高度、三步共用滚动区、缺项清单 | ArcReel | ◐ `PrimeCreate` 单页表单 | 分步、缺项清单、导入预期三卡 | B5 |
| 空态/加载/错误三态齐备 | ArcReel/LumenX | ◐ 多数页面有，但文案不统一 | 统一 EmptyState 组件与文案规范 | B1/B5 |

### 2.2 流水线 / 分镜台

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 阶段 rail（script/assets/storyboard/generate/voice/timeline）带 ready/blockers/needs_review | ArcReel/LumenX/Toonflow | ✗ 后端 `stage_states` 已下发；Prime 无 rail | 六段 rail + confirm/skip/reopen + gated 查看 | B2 |
| 每步「生成→人工确认→再生成」，上游改动只标下游待复核 | Toonflow-app v118workflow | ✅ 后端 `invalidate_stages` 已实现 | 前端展示 needs_review + 确认动作 | B2 |
| 镜头卡纵向列表 + 右侧 420–480px inspector | ArcReel/AIMS2 | ◐ 单列内联编辑，无 inspector | 列表 + inspector 双栏；四分区 | B2 |
| 四分区：场景环境 / 叙事动作 / 视觉制作（首尾帧）/ 视频生成 | CineGen/AIMS2 | ◐ 只有 prompt/beats/takes | 场景、角色造型、首尾帧、模型/时长/生成 | B2 |
| 结构化 prompt + 只读 assembled 预览 + LLM 润色 | LumenX | ◐ 有派生 prompt 只读 | 结构化字段 + 拼装预览 + 润色入口 | B2 |
| 渲染前报价单（准入三态 + 逐镜去向 + 费用/工时） | ArcReel/LumenX | ✗ 后端 `render-estimate` 已有 | 报价弹窗 + 确认锁档 + 受阻原因 | B2 |
| 批量渲染 + 就绪门禁 + 部分失败反馈 | ArcReel/printfilm | ◐ 后端 `render`/`render-estimate` 已有 | 批量条 + 门禁 + 失败重试 | B2 |
| 修订历史 + diff + 回滚 + stale 联动 | BigBanana/LumenX | ✗ 后端 `revisions/diff/rollback` 已有 | 修订抽屉 + diff + 回滚 + stale 徽标 | B2 |
| 候选 take 对比（×N / 星标 / CompareModal / pin / final take） | LumenX/AIMS2 | ◐ 有内联 take 列表 + pick | 对比台、shortlist、pin、拍板唯一化 | B2 |
| 台词 STALE（文本 hash 变化） | LumenX | ◐ 后端 `audio_media_status` 已现算 | 台词行 stale 徽标 + 重新配音 | B2 |
| J/K 切镜、方向键排序、批量展开折叠 | ArcReel | ✗ | 键盘快捷键 + 虚拟列表阈值 | B2 |

### 2.3 资产

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 角色卡：基础形象 + 衣橱/造型变体 + 镜头级变体 | CineGen/DramaClaw | ◐ `PrimeAssets` 只有名字/风格/参考图 | 变体、锁定、参考图位、变体计数 | B3 |
| 场景卡：环境 / 光照色温 / 构图焦段 + 定场帧 | BigBanana/AIMS2 | ◐ 场景节点只有 label/env/frozen/views | 摄影语言字段、定场帧、锚点状态 | B3 |
| 跨集资产对账：逐集版本清单 + 漂移点 + AI 合并建议 | LumenX ReconcileModal / BigBanana characterSync | ✗ 无端点、无页面 | 只读聚合端点 + 台账页 + 幂等归并 | B3 |
| 同步状态 synced/outdated/local-only 横幅 | BigBanana | ✗ | 资产库与项目内同时展示 | B3 |
| 参考图有序语义（第一张=场景，其后=角色） | CineGen/LumenX | ✗ | 上传位提示 + prompt 预览剥离 | B3 |

### 2.4 任务中心

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 统一任务中心（`/tasks`）三轴：步骤进度 × 产物时效 × 任务收单 | ArcReel/DramaClaw | ◐ `/history` 两列；`TaskDrawerPrime` 只有状态/进度/取消 | 三轴读模型、下一步、诊断、运行健康、错误分类 | B1 |
| 在飞任务数 + 地板到天花板侧栏（挤压主列） | LumenX/DramaClaw | ◐ 顶栏胶囊 + drawer | 右侧 dock 与页面共用数据层 | B1 |
| 失败诊断：provider task id / request id / 复制报障 | LumenX/DramaClaw | ✗ 只有 error 文本 | 诊断字段 + 脱敏摘要 + 一键复制 | B1 |
| 运行时健康：调度器/轮询器/看门狗/最近成功/并发 | printfilm | ✗ 只有 deps-status | 依赖三态 + 每作业证据新鲜度 | B1 |
| 错误分类文案：队列满/限流/额度/未配置/内容策略 | DramaClaw | ✗ 原始错误直出 | 分类器 + 修正路径 CTA | B1 |
| 取消 / 重试 / 看日志 / R18 门控 | 既有 | ◐ 取消已有，重试无 UI | rerun + events 入口 + 门控徽标 | B1 |

### 2.5 剪辑湾 / 导出

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 播放器在左、详情在右、轨道横跨底部；整视图不滚动 | ArcReel `EditTimelineView` | ◐ `PrimeEditor` 只有只读双轨 | 播放器 + 详情 + 多轨 + transport | B4 |
| 多轨：视频 / 对白 / BGM / 字幕；trim/split/吸附/撤销 | ArcReel/Toonflow-web | ✗ 只读 v1/a1 | 四轨模型、播放头、编辑命令 | B4 |
| 导出菜单：成片 / 剪映 / EDL / FCPXML / 多轨 ZIP | AIMS2/ArcReel/BigBanana | ◐ 后端四条导出已有 | 导出菜单 + 缺素材/时长清单 | B4 |
| 出片就绪门禁 + 过时提示 | DramaClaw/ArcReel | ✗ | assemble 前检查 + 「重新渲染」主动作 | B4 |
| 动态故事板预览（低成本逐格播放） | Toonflow-web | ◐ `timeline-preview` 已有 | 预览播放器 + 分段进度条 | B4 |

### 2.6 设置 / 模型

| 能力 | 参考 | 现状 | 缺口 | 批次 |
|---|---|---|---|---|
| 设置分区导航 + 配置问题按分区显示 | ArcReel | ◐ 单页长滚动 | 左侧分区 + 就地问题标记 | B5 |
| 模型配置：预置/自定义供应商 + 模型 Sheet + 端点测试 | ArcReel/LumenX | ◐ 只有一个「模型与渠道」块 | 模型目录、能力位、测试连接 | B5 |
| 业务模型按功能槽位分组 + 未配置影响提示 | DramaClaw | ✗ | 槽位表 + 影响清单 | B5 |
| 能力声明驱动生成面板（超限禁用并给原因） | LumenX/AID Studio | ✗ 前端硬编码比例/时长 | capability 单源 + 表单收窄 | B5 |
| 模型目录工程（family YAML → JSON → CI） | LumenX/AID Studio | ◐ 后端有 models/wiki/capabilities | 前端统一读 `/api/models`，删除手工双轨 | B5 |

---

## 3. 批次与验收

### B1 任务中心与全局运行态（P0-2 / 既有 #68）

**目标**：把 `/tasks` 做成 Prime 唯一的任务真相面，并与顶栏胶囊、drawer 共用同一数据层。

**落点**
- 新增 `frontend/app/src/toiv/adapters/tasks.ts`：三轴读模型 + 错误分类 + 诊断复制文本。
- 新增 `frontend/app/src/toiv/addons/TaskCenterProvider.tsx`：单一轮询器（页面/抽屉可见时才轮询），
  暴露 `snapshot / refresh / cancel / rerun / health`。
- 改造 `TaskDrawerPrime`、`ToivWorkbar`、新增 `PrimeTasks` 页面；`/tasks` 为 canonical，`/history` 重定向。
- 顶栏导航「任务」指向 `/tasks`；`FACE_HREF.edit` 同步。

**三轴定义（不折叠）**
1. **步骤轴**：`progress.step/total` + `runtime.state`（fresh/watch/stalled/unknown）。
2. **产物轴**：`results` 是否存在、`post_status=processing`（精确裁切中）、`project_id` 关联的
   Studio 项目 `media_status`（点开项目时懒加载，不在列表里 N+1）。
3. **收单轴**：`queued/held/running/done/error/canceled` + `error` 分类 + `has_params`（能否精确重生）。

**下一步投影**
- 作业带 `project_id` → 调 `/api/studio/projects/{pid}/status` 取 `next_step`（label/action/todo/shot_ids），
  展示「继续：{label} · 还有 {todo} 镜」并深链到分镜/剪辑湾。
- 无项目作业 → 按收单轴给「重试 / 查看日志 / 回到工具」。
- 取不到 → 明确「项目下一步不可用」而不是假按钮。

**诊断与错误分类**
- 诊断块：`job.id`、`prompt_id`、`kind`、`worker`（展示只显示 host，复制含全量）、`created_at`、
  `error`、`project_id`、`seed`。一键复制 Markdown 报障文本。
- 分类：`队列/资源`、`限流`、`额度/计费`、`未配置`、`引擎不可达`、`内容策略`、`超时/中断`、`未知`；
  每类给一句原因 + 一条修正路径；原始错误折叠在「展开原始错误」。
- 不倾倒 ffmpeg/堆栈日志到主 UI。

**运行健康**
- `/api/studio/deps-status`（api/tts/h3）三色点 + 文案；`/api/models/health` 只在设置页深链，不阻塞任务页。
- 每作业 `runtime` 证据新鲜度徽标；stalled 只提示核查，不自动重试。

**验收**
- `/tasks` 可达；顶栏胶囊数字、drawer、页面三处同源同值。
- 在飞/排队/失败/完成各有明确分组与计数；取消后三处同步；重试走 `rerun` 且新作业挂版本链。
- 任一失败任务可展开诊断并复制报障；原始错误默认折叠。
- 空态/加载/错误三态齐备；键盘可达；`role=status/alert`；390px 无横向溢出。
- `bun test test/`、`bun run lint`、`bun run build` 全绿；浏览器走查 0 pageerror / 0 failed request。

### B2 分镜台阶段壳与生成闭环（P0-2 + P1-4/5/6 + P2-7 / 既有 #66）

拆两小批：
- **B2a 阶段 + 报价 + 渲染**：六段 rail（state/ready/blockers）、confirm/skip/reopen（`expected_stage_revision`）、
  gated 查看、批量渲染前 `render-estimate` 报价单与确认锁档、单镜生成 ×N、失败重试。
- **B2b 修订 + 候选 + 配音 + 成片**：修订抽屉（list/diff/rollback）、stale 徽标、CompareModal（2–4 take 同步播放）、
  shortlist/pin/拍板、台词 STALE、配音/对口型、assemble 与 timeline 门禁。

**验收**
- 未确认 `storyboard` 时批量渲染被 `STORYBOARD_NOT_CONFIRMED` 拒绝并给「去确认」；确认后可渲染。
- 报价单列出逐镜去向/工时/费用/受阻原因；确认后锁档，二次提交不重复确认。
- 改 prompt → 生成 → 回滚，可看到 diff；回滚后旧产物标 stale 而非静默可用。
- 候选拍板后 `is_picked` 唯一，时间线与成片消费拍板结果。

### B3 跨集资产对账（P0-1 / 唯一后端增量）

**后端**：新增只读端点 `GET /api/studio/projects/{pid}/asset-ledger`（Go/FastAPI 侧按现有模型聚合）：
- 逐集/逐镜头：角色 / 场景 / 道具 × 使用的资产版本（`ref_epoch`、`StudioShot.ref_images`、角色 `reference_images`）。
- 漂移点：同角色多版本、缺定妆、锚点变更未重渲、`ref_epoch` 不一致、`media_status=stale`。
- 建议：基于名称/别名/引用 URL 的确定性匹配（不接 LLM 也能用）；置信度与「合并进正典 / 新建」。
- 应用动作：`POST .../asset-ledger/apply` 幂等回执；重放不覆盖后来编辑。
**前端**：`PrimeAssets` 增加「对账」页签；逐集清单、漂移列表、建议行内改、全部确认、跳转镜头。

**验收**：≥2 集项目能看到逐集资产版本清单 + 漂移点 + 一键归并/新建；重放幂等；漂移可跳到对应镜头。

### B4 剪辑湾（P2-9 / 既有 #67）

**后端**：已有 `timeline-preview`、`export/jianying|edl|fcpxml|multitrack`、`assemble`。
**前端**：播放器左 / 详情右 / 四轨底部；transport、播放头、缩放、吸附、trim/split、撤销重做；
导出下拉（成片/剪映/EDL/FCPXML/多轨 ZIP）+ 缺素材/时长清单；出片过时以「重新渲染」为主动作。

**验收**：同一时间线导出剪映与 EDL 切点一致；缺素材在导出前列出；播放/暂停/逐镜跳转可用。

### B5 项目库 / 设置 / 模型能力

- 项目卡：封面、进度轴、待修复胶囊、相对时间、状态筛选 + 计数、画廊/列表切换（localStorage）、品牌空态。
- 设置：左侧分区导航 + 分区问题标记；模型 Sheet（价格/参数/时长档/能力覆盖）+ 端点测试 + 未配置影响；
  业务槽位分组（编剧/分镜/出图/视频/配音/Agent）。
- 模型能力单源：前端只读 `/api/models` 的规范化 capability，生成面板超限项禁用并给原因；删除手工比例/时长硬编码。

**验收**：新增模型只改一处配置前后端同时生效；超限参数不可选；未配置项列出会失败的功能。

### B6 全量验收与发布

- 四套件：api pytest / Prime bun test+build / legacy-web npm test+typecheck / canvas go vet+test。
- 浏览器矩阵：1280 / 1440 / 1920 / 390；关键流：登录→项目→分镜→报价→渲染→候选→配音→成片→导出→任务。
- 稳定态观察 + 回滚快照；部署与推送需单独授权。

---

## 4. 交互与视觉规范（参考行为，自写实现）

1. **三态齐备**：每个数据面都有空态（图标 + 标题 + 说明 + 主/副 CTA）、加载骨架、错误态
   （一句原因 + 一条修正路径 + 可复制详情）。错误正文折叠，操作按钮留在视口内。
2. **状态语言**：`done=success 绿`、`running=warning 琥珀`、`queue=muted 灰`、`failed=destructive 红`、
   `held=amber`、`stale=amber 描边`；颜色只走 token。
3. **数字诚实**：没有真值就显示「—」或「未定价」，不猜；预估与实际并列；缺价给解释型空态。
4. **禁用要给原因**：按钮 disabled 时必须有 `title`/说明，不允许「假能力」按钮。
5. **键盘**：J/K 切镜、Esc 关抽屉、方向键调宽、focus-visible 环、skip-link。
6. **响应式**：≥1280 全三栏；1024–1279 inspector 变抽屉；<1024 只读浏览 + 明确说明，不破版。
7. **动效**：150–220ms ease-out；列表 stagger ≤40ms；禁粒子/无意义循环；尊重 `prefers-reduced-motion`。
8. **文案**：中文短句，先说结果再说原因；不出现「AI 感」的营销词；不把内部日志当用户文案。

---

## 5. 数据契约（本次核对到的事实）

| 端点 | 形状要点 | 用途 |
|---|---|---|
| `GET /api/jobs/active` | `{items:[{id,prompt_id,kind,status,progress:{pct,step,total,queue_pos,phase,phase_label,updated_at},runtime:{state,label,reason,age_seconds,evidence},eta_sec,wait_sec,hold_reason,worker,created_at,project_id?}],server_time}` | 在飞任务三轴 |
| `GET /api/jobs?limit=&offset=&status=&kind=` | `Job[]`；含 `error/results/meta/parent_id/root_id/project_id/has_params/post_status/seed/created_at` | 历史与作品 |
| `GET /api/jobs/counts` | `{count,failed}` | 计数真值 |
| `POST /api/jobs/{id}/cancel` | `{ok,status,canceled_segments,worker_action}` | 取消 |
| `POST /api/jobs/{key}/rerun` | body `{seed_mode,seed?,overrides?}` → 新作业挂版本链 | 精确重生 |
| `GET /api/jobs/{prompt_id}/events` | SSE 事件流 | 日志/诊断 |
| `GET /api/studio/deps-status` | `{overall,deps:[{id,label,state,summary,block_cta,blocked_hint}]}` | 运行健康 |
| `GET /api/studio/projects/{pid}` | 含 `shots[]`、`stage_states{stage:{state,ready,blockers}}`、`stage_revision`、角色 | 分镜/阶段 |
| `GET /api/studio/projects/{pid}/status` | `{total,by_status,next_step:{step,label,action,todo,shot_ids}}` | 下一步投影 |
| `POST /api/studio/projects/{pid}/stage-transition` | `{stage,action,note?,expected_stage_revision?}` → `{stage_states,stage_revision}` | 阶段确认 |
| `GET /api/studio/projects/{pid}/stages/history` | `{history:[...]}` | 确认审计 |
| `POST /api/studio/shots/{sid}/render-estimate` | `{allowed,blockers,warnings,work,items,pricing,budget,input_fingerprint}` | 单镜报价 |
| `POST /api/studio/projects/{pid}/render-estimate` | 同上，`scope=batch` | 批量报价 |
| `POST /api/studio/shots/{sid}/render` | body 可含 `num_candidates/video_model/pipeline/wait` | 单镜生成 |
| `POST /api/studio/shots/{sid}/candidates/{cid}/pick` | `{expected_candidates_digest}` | 拍板 |
| `GET /api/studio/shots/{sid}/revisions` | `{revisions:[...]}` | 修订历史 |
| `GET /api/studio/shots/{sid}/revisions/{rid}/diff` | 逐字段 diff | diff 视图 |
| `POST /api/studio/shots/{sid}/rollback` | `{revision_id,expected_revision?}` | 回滚 |
| `POST /api/studio/shots/{sid}/voice` / `lipsync` | 配音 / 对口型 | 声音 |
| `POST /api/studio/projects/{pid}/assemble` | 成片 | 剪辑湾 |
| `GET /api/studio/projects/{pid}/timeline-preview` | `{fps,content_mode,items:[{shot_id,idx,kind,preview_url,media_url?,duration_sec,nsfw}]}` | 预览 |
| `GET /api/studio/projects/{pid}/export/{jianying,edl,fcpxml,multitrack}` | 文件流 + `X-Toiv-*` 回执 | 导出 |
| `GET/POST/PATCH/DELETE /api/studio/recipes/*` | 用户配方 CRUD + diff/apply/import/export | 配方库 |

**结论**：B1/B2/B4/B5 不需要新增后端端点；B3 需要一个只读台账端点 + 一个幂等 apply 端点。

---

## 6. 测试与验收

- **纯函数**：任务分类、错误分类、诊断文本、阶段投影、报价摘要、时间线切点 → bun 单测。
- **组件/页面**：语义查询（role/label/state），不断言 RGB/像素；浏览器测试覆盖三态、键盘、390px。
- **接口契约**：adapter 单测用真实响应形状 fixture；对 404/409/422/空体分别有断言。
- **回归门禁**：四套件全绿；`tsc -b`；`bun run build`；`git diff --check`。
- **真机取证**：生产或本地起服务，真实登录，走关键流，收集 pageerror/failed request；
  稳定态观察后再报告完成。
- **不做**：为通过测试放宽断言、mock 掉真实写路径、把后端 409 当成功。

---

## 7. 边界与风险

- **不改后端既有契约**：B3 新增字段/端点只做增量；不改 `Job`、`StudioShot` 既有语义。
- **不接第三方云推理**：所有生成仍走本地/自有集群端点。
- **内容锁**：新增门控/隐藏/徽标一律经 `@content-lock`；缺失即中性 no-op。
- **许可**：参考仓代码不进入 ToIV；仅在 `third_party/reference-repos/` 只读。
- **风险**：B2 的报价/阶段/候选依赖真实项目数据，fixture 不足时先做只读展示 + 明确空态；
  B3 的 AI 匹配置信度先做确定性版本，LLM 建议后置，避免不可复核。
- **性能**：任务轮询只在页面/抽屉可见时开启；长列表 >100 项上虚拟滚动；避免每作业 N+1 项目请求。

---

## 8. 交付顺序（本轮起）

1. B1 任务中心（可独立上线，风险最低，立刻改善「运行数真值」）。
2. B2a 阶段 + 报价 + 渲染（P0 创作闭环）。
3. B2b 修订 + 候选 + 配音 + 成片。
4. B3 资产对账（后端 + 前端）。
5. B4 剪辑湾。
6. B5 项目库/设置/模型能力。
7. B6 全量验收 + 发布（需单独授权）。
