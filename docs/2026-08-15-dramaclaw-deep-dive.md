# DramaClaw 深度调研 · ToIV 对照与可借鉴清单（2026-08-15）

> 调研对象：https://github.com/dramaclaw/dramaclaw（253 commits，Elastic 2.0，source-available）
> 方法：仓库克隆至 /tmp/toiv-research/dramaclaw，两路并行实读（后端管线 40+ 文件 / 前端+Agent+MCP），所有结论有真实文件依据。
> 定位：DramaClaw 是「小说→短剧成片」工业化管线，与 ToIV 的 drama studio 直接同赛道；其单机 CE（FastAPI :8780 + SQLite/文件 + in-process 任务）与 ToIV 集群形态不同，但**管线语义层几乎全部可移植**。

---

## 一、对方架构一句话

单 FastAPI 进程承载全部能力；模型全走 OpenAI 兼容网关（官方 relayclaw 或 BYO newapi，ComfyUI 作为 type=63 channel 挂工作流路由）；ports&adapters 十二端口 CE/EE 分流（`ports/registry.py` + entry_points，核心永不 import 企业版）；每项目一个 `data.db`（characters/episodes/scenes/props/beats 等表，嵌套结构 JSON 列）；任务 InlineTaskBackend 四车道（default/video/world/ffmpeg）ThreadPoolExecutor。

## 二、管线设计精髓（后端 Top 6）

1. **管线状态重算 + next_step**（api/routes/pipeline.py `_STEP_MAP`）：ingest→characters→episodes→portraits→script→sketches→coloring→first_frames→tts→video→compose 全链路**不存状态机**，状态由「DB 行 + 产物文件存在性」实时重算，`pipeline/status` 直接给出 `next_step`。断点续跑 = 从首个缺失步骤继续，零额外机制，天然免疫状态漂移。
2. **合法 ID 集合注入 LLM 结构化输出**（workflows/literal_script_writing.py）：pydantic-ai `Agent(output_type=LiteralBeatMetaOutput, validation_context={valid_identity_ids, valid_scene_ids, valid_prop_ids})`——模型编造角色/场景 ID 会被 pydantic validator 打回自动重试，从 prompt 恳求变 schema 硬约束。
3. **身份（Identity）二维建模**（models.py `CharacterIdentity`）：角色×身份（谢铮_和尚/谢铮_皇帝），每身份独立绑外观/面部 prompt/参考图/**声线 SHA256**；`identity_planner.py` LLM 规划每集身份需求且规则写明「已有身份优先复用」。
4. **颜色标记草图 → CV 可检测的在场校验**：每身份一色火柴人草图（EpisodeOptimizer.assign_sketch_colors）→ sketch_color_detector 逐 panel 颜色检测 → 回写 beats.detected_identities_json → render 阶段精确过滤参考图。角色在场从「祈祷」变「可判定事实」。
5. **任务运行时完整语义**（task_backend/）：车道制 + 项目公平交错 + 幂等入队去重（ACTIVE 直返已有句柄）+ 启动僵尸清扫（submitting/queued/running→failed，按库记忆化只跑一次）+ 协作式取消（0.5s 轮询取消标志 + 进程组整组 kill）+「Runner 产物即交付证据，任务表只是读模型」+ 三段式 credit（reserve/confirm/refund）。
6. **宫格批量出图 + 三级选片漏斗**：1/4/9/16/25 宫格一次调用摊薄成本 → grid_splitter 工程化拆分（白边阈值 220 是 JPEG 压缩教训值）→ beat 内容哈希判 stale → T1 颜色预筛/T2 LLM 事实核查/LLM 打分（top-2 分差>1.0 自动选定，<7.0 进重生成列表）；失败模式沉淀全局注册表反哺负向提示词。

## 三、前端/Agent/MCP 精髓（Top 6）

1. **SSE 客户端完整 FSM**（task-center/stream-client.ts）：退避 [1,2,4,8,16,30]s + 30s 看门狗 + 3 次失败降级轮询 + 冷启动失败预算区分「凭据无效 vs 网络抖动」+ 重连后 500ms 快照窗口防重复 toast + 会话过期显式关流。ToIV trackJob 2.0 的直接参照。
2. **SKILL.md 执行纪律**（.hermes/skills/dramaclaw/SKILL.md）：状态驱动（先查 next_step）+ **单轮最多 1 个写任务** + 错误即停原文转告 + 大任务先澄清拆解 + grounding 规则（只确认实际成功的字段）+ **重新摄入二次确认门优先级高于用户指令**。经过实战的 agent 防失控 prompt 模板。
3. **MCP 单源双桥**（chat/dramaclaw_mcp.py）：一份 TOOLS 注册表同时喂 Hermes 插件与 MCP stdio 桥（~34 工具覆盖全管线）；免 token CE 模式 = `CE_OWNER` + **强制 loopback**（非回环直接 raise）+ 独立 `ALLOW_REMOTE` 变量防顺手误开 + token 存在永远优先。
4. **候选→主线 Commit 机制**（freezone/commit/）：19 种 PushTarget kind 前后端共享一份判别联合 + legacy kind 迁移表 + commit 前 impact 预览 + 批量按溯源回源。ToIV「画布候选 promote 回主线」的完整参考答案。
5. **自动保存纯函数决策机**（freezone/canvasSyncCore.ts）：五态（not_hydrated/switching/dangerous_empty/…）无 React 依赖可单测 + base_revision 乐观锁 + localStorage 草稿 TTL 兜底。防「hydrate 中途 autosave 清空远端」标准做法。
6. **发版防御三件套**：version.json（buildId）+ 轮询比分级提示（软/硬）+ chunk 404 自动恢复 + **dom-reconciliation-guard（防浏览器翻译插件改 DOM 崩 React）**——对中文用户群尤其值得抄。

## 四、UX 亮点速记（值得抄的交互）

- 运镜模板视频预览选择器（25 个 mp4 预览网格，`public/video/camera-presets/`）+ 球面机位编辑器（MultiAngleSphere 经纬球拖拽选机位）——比文本下拉直观一个量级
- 分镜健康度导航条（beats/sketches/audio/video 四阶段完成度聚合一览）
- 任务 deep-link 回源（originDeepLink 一键跳回发起页面）
- 长任务 a11y：状态行 aria-live polite 播报、日志刻意不播报（防屏幕阅读器洪水）
- 资产库自定义 MIME 拖入画布生成节点；画布 LOD 降级 + FPS 表 + 视口书签
- ApprovalCard 确认门：琥珀卡 + 过期倒计时 + allow-once/always/deny 三态

## 五、ToIV 行动建议（按 ROI 排序）

| # | 借鉴项 | 落点 | 价值/成本 |
|---|---|---|---|
| 1 | 管线状态重算 + next_step | drama studio：StudioProject 状态从 DB 行+产物存在性重算，提供 /pipeline/status | 高/中 —— 消灭状态机漂移类 bug |
| 2 | 合法 ID 注入结构化输出 | 剧本拆解/分镜 LLM 链（valid_identity_ids 等 validator 上下文） | 高/低 —— 消灭整类「编造 ID」故障 |
| 3 | SKILL.md 执行纪律模板 | Agent 系统提示词（单轮 1 写任务/错误即停/grounding/确认门优先） | 高/低 —— 纯 prompt 工作 |
| 4 | 颜色标记草图在场校验 | 分镜链：身份配色 + CV 颜色检测反哺参考图过滤 | 中高/中 —— 不依赖特定模型 |
| 5 | SSE FSM 2.0（看门狗/快照窗口/凭据区分） | lib/trackJob.ts 升级 | 中/低 |
| 6 | 任务后端语义补齐（公平交错/幂等入队/僵尸清扫） | tracker 对照补齐（易错点 26 已做部分） | 中/中 |
| 7 | Commit 机制（PushTarget + impact 预览） | 画布/候选产物 promote 回主线 | 中/中高 |
| 8 | 运镜/机位可视化选择器 | LTX/LongCat/数字人视频表单升级 | 中/中（素材需自制） |
| 9 | 宫格批量出图 + 三级选片 | 分镜/首帧成本摊薄 + 自动选片 | 中/中高 |
| 10 | 发版防御（version.json/chunk 恢复/翻译 guard） | apps/web | 中/低 |

**不宜回抄**：① 其 ComfyUI 接入是工作流 JSON 内嵌 + NODE_MAPPING 节点 ID 硬编码，比 ToIV 的 engine_registry + 专用实例精确匹配（易错点 9）脆弱；② 前端重客户端 SPA（画布+ffmpeg wasm+konva+playcanvas 全堆前端）首屏复杂度高，ToIV 的 Next.js + lazy 视图路线保持；③ `ce-allowlist.toml` 是 lint 豁免表，与鉴权无关，勿误读。

## 六、与 ToIV 现状的能力对照（速览）

| 能力 | DramaClaw | ToIV 现状 | 差距 |
|---|---|---|---|
| 管线断点续跑 | 状态重算+next_step | drama 分阶段+超时配置化 | 状态机漂移风险 |
| LLM 输出硬约束 | validation_context 合法 ID | 质量门事件化 | 无 ID 级校验 |
| 角色一致性 | 身份二维+配色+声线 SHA | 参考图+LoRA | 缺身份实体 |
| Agent 纪律 | SKILL.md 实战模板 | R3.1 双确认门 | prompt 纪律未成文 |
| 任务推送 | SSE FSM 完整版 | trackJob 重连+降级 | 缺看门狗/快照窗 |
| 画布双轨 | 投影+promote 19 种 slot | 画布独立 | 无 promote 机制 |
| 模型接入 | 网关+别名迁移+远程目录 | engine_registry 声明式 | 各有优劣 |
