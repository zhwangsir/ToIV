# 四域整改方案（2026-09-22）

> 来源：2026-09-21 用户四点反馈——①作品库文件夹无法直接删除；②部分服务仍掉线；③AI 助手 UI 需重设计；④Admin 体量太小功能太少需重规划。
> 本文全部结论已经真机扫描（2026-09-21 16:00 fleet 实况）与三路代码勘察核实，行号引用截至 commit `15df9b4`。
> 定位约束：ToIV 仅本地自用/学习，不公开运营——方案不做多租户/合规向设计。

---

## A. 作品库：文件夹整组删除（及删除面补齐）

### 现状事实

- 「文件夹」四种成因：360° 环绕序列（`Job.params` 内 `batch_id`，服务端 `_batch_id_of` 逐行解析，无 DB 列）、同参数变体组（**纯前端派生** `variantKeyOf`=kind+seed+prompt）、画板 Board（服务端表）、Saved Views（筛选条件组合，localStorage+跨端同步）。
- 文件夹卡无删除入口是**拍板过的设计**（`LibraryView.tsx:1695/895/2413` 三处注释「不做整组删除，防误删」，`tests/libraryBatch.test.ts` 钉死）；删除一个组目前只能下钻后**逐成员**点删除。
- 已有基础：单件软删+撤销 token+72h 回收站体系完整（`jobs.py:481-514`）；前端 `deleteJobsBatch` 已是顺序循环单删+失败不中断+逐 token 撤销；批量管理模式/Shift 连选/全选本页均已存在；Board 删除前后端已通（仅详情页有入口，无审计记录）。

### 方案

**A1 文件夹整组删除（核心，纯前端可成）**
- 文件夹卡加 hover 操作组（与普通卡同视觉族）：「打开」「删除整组」；批量管理模式下文件夹卡可选中（选中=整组成员入删单）。
- 删除流：强确认 Modal（明示成员数 N、产物类型分布、R18 混入警示）→ 复用 `deleteJobsBatch(members)` → toast 聚合「已删除 N 个作品·全部撤销」（撤销通道现成）。
- Saved Views 的删除语义=删视图定义（不删作品），chips 行加 × 小钮，与作品删除严格分离，文案区分。
- 同步更新三处「不做整组删除」注释与 `libraryBatch.test.ts` 形态断言（保留「成员删到 <2 回落普通卡」不变式）。

**A2 删除面补齐（小件）**
- 灯箱加 Delete/Backspace 快捷键删除（带同样的确认/撤销流）；文件夹下钻内加「全选本组」。
- 板列表卡补「删除画板」入口（现仅详情页可删）；`boards.py:208` 删除补 `audit.record`（与 Job 删除审计范式对齐；Board 保持硬删语义，文案已明示成员保留在作品库）。

**A3 服务端批量端点（可选增强，规模化顺直）**
- `POST /api/jobs/bulk-delete`（body=ids≤200，归属逐条校验，循环软删，返回 done/failed+聚合 undo_token）——把 N 次 HTTP 收为 1 次；**不做**按 batch_id 的服务端过滤删除（params 无列需全表扫，不值；组边界本来就是前端语义）。
- 路由顺序坑注意：`DELETE /jobs/{job_id}` 会吞静态段（`jobs.py:724` 注释），新端点一律 `POST /jobs/bulk-*` 形态。

**测试**：web jest（文件夹卡删除入口/确认流/组选中/视图删除分离）+ api（bulk-delete 归属/软删/审计/undo）+ e2e 补一例（authed-library-p0.spec.ts 模式：建组→整组删→撤销）。

---

## B. 掉线服务：实况、处置与防复发

### 2026-09-21 16:00 真机实况

| 服务 | 状态 | 结论 |
|---|---|---|
| 引擎矩阵（/api/models/engines） | **23/24 在线** | 唯一 flux1-nunchaku=上游 SM120 内核已登记，非故障 |
| ComfyUI-LB 池 | gpu0+pc01 双后端 healthy | pc02 09-13 已下线（拍板） |
| 专用实例 :8195/:8196/:8197/:8199 | 全 OPEN | H3 双 worker（:8195+pc01:8198）✓ |
| 超分 fleet :8261/:8262/:8263 | 8263 进程在但不监听（09-13 起异常） | **已修复**：restart 后 8263 OPEN（本次顺手处置） |
| IndexTTS :9200 | LIVE（当日 TTS 200 日志） | 端口是 9200 非 9880 |
| Embedding :9302 / 音频分离 :9220 / comfy-mcp :9100 / fan_guard | 全 active | — |
| DSv4 LLM（spark TP2） | Up 8 天，/v1/models ✓，guard cron 双侧在 | 健康 |
| **openclaw02/03/04** | **Tailscale 全不可达** | 需现场处置（见下） |
| openclaw01 | 可达 | whisper :9310 在其上正常（/api/dub/transcribe 链路可用） |

### 方案

**B1 openclaw02-04 掉线（唯一实质项，需用户现场）**
- 远程不可强制唤醒（未配 WOL）。现场检查清单：①电源/是否睡眠（系统设置→节能→防止自动睡眠）；②网线/Wi-Fi；③开机后 `tailscaled` 是否自启（`sudo tailscaled` + `tailscale up`）；④确认后 whisper(:9310)/JoyCaption(:9305) launchd 服务自检。
- 若长期不启用：从舰队清单标注退役，whisper 保持 01 单点并在 AGENTS.md 登记单点风险。

**B2 单点/韧性**
- whisper 当前单点（01:9310）——`TOIV_WHISPER_URL` 支持逗号多址后做故障转移（代码确认后补；短期不动，01 稳定）。
- upscale-gpu3 类「进程在但不监听」加入巡检：Admin 观测页加端口监听核对（见 D1），不再只靠 systemd active。

**B3 防复发**
- ts-health 自愈探针已常驻 core/WS（每 5min）；openclaw 恢复可达后补同款（launchd 版）。
- Mac 侧换网僵死判别法（`tailscale down && up`）已在册。

---

## C. AI 助手 UI 重设计

### 现状关键事实

- 单一巨型组件 `AssistantView.tsx`（3502 行）+ 组件内 styled-jsx ~1150 行；样式另散在 `assistant.css`(600)/`agent-runs.css`(954)/`cmdk.css`/`docs.css`。
- **33 个注册工具的结果全部坍缩成一条文字小条 `av-tool-chip`**（转圈/绿勾/红叉）——应用推荐、分镜创建、自愈执行等无结构化卡片、无跳转按钮，这是表达力最大短板。
- 对话（单 agent SSE）与 agent-runs（DAG 运行台）两套系统完全独立，仅列表页一条横幅互链；能力重叠（drama 五工具 vs 分镜 DAG）。
- 疑似 bug：移动端底部 CTA 标「对话」实际跳 fusion 页（`page.tsx:806` ctaAction 遗留）；`forkAgentSession` 前后端就绪但零 UI 消费；popup 唤起仅 Shift+Enter，移动端不可达。

### 方案（四阶段）

**C0 先清障（小修快赢，随最近一批带）**
- 移动端 CTA `ctaAction` 改跳 `home`（真对话）；popup 空态「Shift+Enter」提示按断点隐藏；清理「模型设置」残留注释/空 `AgentRunStyles.tsx`。
- `AuditLogView` 动作筛选键漂移修复（下划线→点号，见 D5，同批带）。

**C1 工具结果结构化卡片（核心价值，协议零改动）**
- 前端建 `toolRenderers` 注册表：按 `tool.name` 渲染专用卡，未注册回退现有小条（向后兼容）。
- 首批五族卡片：应用推荐卡（封面+名称+用途+「打开应用」深链 `/?view=market&app=`）、画板/分镜卡（成员缩略+「打开画板」）、自愈执行卡（修复器/目标/结果徽标）、画布提案卡（已有，保留）、作业卡（已有，保留）。
- tool 事件 payload 已含 name+summary+结构化结果（后端 33 工具契约不变，前端只消费）。

**C2 信息架构统一**
- 对话内嵌 agent-runs 入口：消息中涉及 DAG 场景时出「运行台」深链卡；agent-runs 详情页加「在对话中继续」（带 run 上下文 prefill）。
- SideRail 补「智能体」入口（现仅底部「更多」抽屉），与对话并存不合并（两套系统定位不同：对话=轻交互，运行台=重编排）。

**C3 组件工程化拆分（跟随 C1/C2 落地，不单独先行）**
- `AssistantView.tsx` 拆为 MessageList/Composer/Portal/ToolCards/SessionDrawer 五模块；styled-jsx 外迁 `assistant-view.css`（P-2b 纪律：文件级 CSS+`av-` 前缀；现有测试对 styled-jsx 形态的断言同步改）。
- 拆分红线：`tests/assistant*` 十组不变式（onEvent 三分支/提案卡/回放归并/popup 互斥/霓虹参数）必须全绿，逐模块迁移逐组验证。

**C4 移动端适配**
- 助手全屏 sheet 形态（替代 popup）；composer placeholder/工具行按断点特化（已有基础）；⌘K 在移动端入口可见化。

**不做**：不合并对话与 agent-runs 数据模型；不引入新依赖（无组件库）；不改 SSE 协议。

---

## D. Admin 重规划：从「运营台」到「集群+内容运营中心」

### 现状关键事实

- 5 主 tab（概览/应用管理/系统任务/观测/平台管理含 6 子页），后端 26 个 /api/admin 端点+更多 admin 门控端点中**大量无 UI**：说明书批量生成/发布/关联回填、封面单发上传+旧管线、preflight 预检、gpu-smoke、harness 自省、知识图谱、模型 wiki/enrich/引擎刷新、全员作业操作（cancel/rerun/restore/purge）、应用创建/删除/导入、workflow deploy。
- 工程债：admin **零测试**（仅 typecheck）；`AuditLogView` 筛选键下划线 vs 后端点号漂移（下拉基本筛不到数据）；`AppTestMatrixAdminView` 是占位页；`deploy-admin.sh` 仍是 Mac 构建+rsync 旧口径（实际已改 core 本机构建）；`lib/api.ts` 4923 行全量搬移（admin 实际只用尾部 ~100 行）。

### 方案（新六域信息架构）

**D1 设备与服务（新域，最高优先——与 B 联动）**
- fleet 网格强化：掉线服务聚合卡（systemd active 但端口不监听的「假活」识别——upscale-gpu3 类）、openclaw 节点状态、LB 后端健康、超分池。
- 操作：orch 唤醒（已有 API）+ 服务重启申请（新增 orch 端点，白名单 unit+审计+二次确认；**不开放任意 systemctl**）。
- GPU 冒烟触发+最近报告（`/api/system/gpu-smoke` 系）、harness 自省只读视图（停用引擎/插件清单）。

**D2 模型资产（新域）**
- 本地模型浏览（`/api/models/local`）、model wiki 查看+civitai 富化触发、引擎注册表只读+手动探测刷新；MODEL_SOURCES 只读视图（新端点读 `docs/MODEL_SOURCES.json`，ok/blocked 统计+检索）。

**D3 内容运营（强化）**
- 说明书：全量列表（草稿/发布态筛选）+ 批量生成/发布/关联回填入口（端点全有）。
- 应用：创建/导入两阶段/删除 UI；单应用封面上传；preflight 预检面板（导入前依赖核对）。
- 策展：保留现有，补批量 featured。

**D4 作业与队列（强化）**
- 全员作业列表（kind/status/user/时间筛选+分页）+ 行内操作 cancel/rerun/delete/restore/purge（端点全有，admin 门控）。
- 回收站管理视图（全用户软删条目/到期倒计时/手动 purge）。

**D5 观测与知识图谱（强化）**
- 审计日志筛选键修复（点号对齐后端 action）+ user/action 组合筛选。
- 知识图谱查询 UI（RH webappId/引擎/模型出处反查，≤3 跳）。
- 观测页并入 D1 的「假活服务」核对与队列深度闸状态。

**D6 实测矩阵实装**
- L2 矩阵结果接 API（历史 jsonl 入端点或 DB 表），替换占位页；提供按引擎/应用重跑入口（接既有 runner 服务体系）。

**D7 工程化（贯穿）**
- admin 引入轻量测试：先 0→1 建 jest（或 node:test 同 web 模式）覆盖 lib 封装+关键交互不变式；保留 typecheck 门。
- `lib/api.ts` 瘦身：删未用搬移函数（按引用静态核），4900→~800 行；后续按域分包。
- `deploy-admin.sh` 固化现行口径：源码 rsync→core 本机 `npm install && npm run build`→restart（删 Mac 构建前置校验）。

**分期**：P0=D1（掉线聚合+假活识别）+D5 审计修复+D3 说明书批量（支撑当前最大痛点）；P1=D2+D4；P2=D6+D7 测试/瘦身。

---

## 实施顺序与验证纪律

| 批 | 内容 | 验证 |
|---|---|---|
| 立即（已办） | upscale-gpu3 重启恢复 ✓（:8263 OPEN） | 真机端口+日志 |
| 批1（痛点优先） | A1 文件夹整组删除 + C0 CTA/残留清理 + D5 审计键修复 | web/api jest + e2e 补例 + 真机截图 |
| 批2 | C1 工具结构化卡片（五族）+ A2 删除面补齐 | jest 不变式全绿 + e2e authed-agent-drama |
| 批3 | D1 设备与服务域（含 B2 假活巡检）+ D3 内容运营强化 | api 测试 + admin typecheck + 真机 |
| 批4 | C2 IA 统一 + C3 拆分 + D2/D4 | 全量回归（api/web/e2e） |
| 批5（余量） | A3 bulk 端点 + D6 + D7（测试/瘦身/deploy 固化） | 全量回归 |

每批纪律不变：实现→测试补齐（按既有 spec 模式）→真机验证（CN 入口+截图）→AGENTS.md/STATE 入账→commit（勿 push、勿 stage `.regen_tmp`）。

**待用户现场**：openclaw02-04 电源/网络/TS 检查（B1）。
