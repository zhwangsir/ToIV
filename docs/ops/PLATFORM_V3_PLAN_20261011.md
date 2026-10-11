# ToIV Studio v3 方案计划 · 从「平台统一」到「制片能力」（2026-10-11）

> 依据：2026-10-10 深度调研（13 商业产品 + 12 开源，真源 `UNIFIED_PLATFORM_PLAN_20261010.md` §2）+ S1–S14 交付盘点。
> 前提：v2 主线（S1–S14）已全部落地——单壳收敛、v2 六段工作区、异步 Job/reconcile、字幕/BGM/音效/对口型、N 候选、工作流模板、任务枢纽、桌面同版本。
> v3 主题：**调研里定了但 v2 只做了一半的四条深水线**——一致性、质检自动化、Agent 同构、真时间线；外加连续性/长片与产品化输出。

## 1. 调研启示兑现对照（已兑现的不重做）

| 调研启示（来源） | v2 兑现情况 | v3 动作 |
|---|---|---|
| 剧本→分镜自动化（小云雀/LibTV/NovelFlow） | ✅ 剧本 AI 拆解（结构化分镜+角色落库，33s 实证） | 只做增强：程序校验+失败重试口径补齐 |
| 多视角分镜扩展（可灵） | ✅ frame-variants 三景别 img2img | 并入 C1 参考体系 |
| N 候选+镜头重生成（各家） | ✅ candidates+pick+指纹缓存 | 质检门禁标准化归 C2 |
| 播放列表式汇编（TapNow） | ✅ v2 时间线（排序/时长/seam/字幕） | C4 决策真时间线 |
| 字幕对齐（各家） | ✅ whisper 词级 cue+SRT+烧制 | — |
| BGM/音效（各家） | ✅ lavfi 音效库+ducking 混音 | — |
| 断点续跑（NovelFlow/story-claw） | ✅ render_reconcile+僵尸收口 | — |
| node_mapping 工作流模板（NovelFlow） | ◐ 6 模板+激活态 | C6 产品化输出 |
| 资产先行、分镜引用（NovelFlow） | ◐ Entity 接入资产段 | C1 深化 |
| **角色三视图注册表（ViMax/小云雀/Flova）** | ❌ 锚点/变体有，无 front/side/back 规范 | **C1** |
| **参考槽位分层参数化（海螺 9-3-3/Vidu 7 主体）** | ❌ 未参数化 | **C1** |
| **阶段感知换参考（story-claw）** | ❌ 无 | **C1** |
| **VLM 质检门禁+自动重生成（story-claw/ViMax）** | ◐ 设定卡 face 门禁；镜头级未标准化 | **C2** |
| **Agent 与创作面同构（Toonflow 节点即工具/可灵 MCP）** | ◐ 30 工具但全经典域；v2 六段新能力零回灌 | **C3** |
| **虚拟剧组智能体分工（纳豆 70 智能体/team.json）** | ❌ 无 | **C3** |
| **真时间线/时间线 DSL（即梦时间轨/ShortGPT EML）** | ❌ 播放列表已够用待决策（W3.5） | **C4** |
| **机位树多镜连续性（ViMax camera tree）** | ◐ seam_to_next 四策略 | **C5** |
| **长片分集（MagicLight 50min）** | ❌ 无 | **C5** |
| **工作流一键封装 API（RunningHub）** | ❌ 无 | **C6** |
| **拍同款模板库（Vidu/MagicLight）** | ❌ 无 | **C6** |
| 四入口 Web/Agent/API/CLI（MoneyPrinterTurbo） | ◐ Web/Agent 有，API 部分 | C6 后置项 |

## 2. 六条能力主线

### C1 一致性深水区（2–3 批）
- **三视图注册表**：角色卡固定 front/side/back 三槽（front 以锚点生成，side/back 以 front 为参考 img2img——复用 frame-variants 机器）；镜头引用按机位自动选视图（ViMax `character_portraits_registry` 范式）。
- **参考槽位参数化**：镜头生成参数显式分层——`character_refs[] / style_refs[] / motion_refs[] / audio_refs[]`（命名抄海螺 9-3-3；实现落 ref2va/fl2va 的 node_mapping 槽位映射），UI 与 Agent 共用同一参数面。
- **阶段感知换参考**：story-claw 范式——服装/道具发生实质变化（换装/湿身/受伤）才切换参考图，同阶段镜头共享同一参考；数据面=Shot 上挂 `ref_epoch`，变更才换。
- **多主体合并参考**：NovelFlow `merged_character_image` 范式——双/三角色镜头先合成合并参考图再喂视频参考槽；工作流按资产组合自动选型（单/双/三参考模板，workflow_templates 已有骨架）。

### C2 质检自动化（1–2 批）
- **镜头级 VLM 门禁标准化**：每候选出片过 DSv4-VL 四问（脸一致/服装一致/场景一致/幻脸检测），分数落 candidates_json；设定卡 face 门禁机器抽公共模块复用。
- **自动重试策略**：低于阈值自动重生成（上限 2 次），落选留痕（ViMax 范式）；重试只补失败候选不重跑整镜。
- **成片级抽检**：splice2 合成前按镜抽样质检，坏镜挡在合成前。

### C3 Agent 同构（2–3 批，v3 的灵魂）
- **v2 六段操作工具化**：现有 30 工具全在经典域；把 v2 新能力回灌——`breakdown_script`（剧本拆解）、`gen_character_sheet`/`adopt_reference`、`pick_candidate`、`set_seam`、`reorder_timeline`、`gen_subtitles`、`lipsync_shot`、`frame_variants` 等，与 UI 调同一批端点（人机同构的正解=同一 API 面）。
- **画布节点即工具**（Toonflow 范式）：画布节点 getConfig/setConfig/generate 注册给 agent-host 技能，Agent 能读改画布节点并触发生成——canvas 技能面已有 canvas SKILL.md 基础。
- **虚拟剧组**（纳豆思路裁剪）：team.json 6 角色（导演/编剧/分镜师/画师/剪辑配乐/质检），各自系统提示词+可委派工具子集；对话里 `@导演` 式唤起。A2A AgentCard 结构照 Toonflow。

### C4 真时间线（1 批决策 + 1–2 批实施）
- **决策点（W3.5 到期）**：播放列表够用则后置；否则引入**时间线 DSL**（ShortGPT EML 思路：JSON 剪辑描述，LLM 可直接生成/操作时间线——与 C3 天然耦合）+ 字幕轨/双音轨/转场四件。
- 判据：现有 seam 四策略+时长调整是否已覆盖自用剪辑需求；不足才上真时间线。

### C5 连续性与长片（1–2 批）
- **机位树衔接**：seam_to_next 升格为镜头树（parent_cam 关系；子机位等父镜头首帧事件再生成——ViMax asyncio.Event 范式贴合现有异步 Job 模型）。
- **分集/长片组织**：项目内多 Episode（章节树+每集独立六段视图+跨集资产继承）；MagicLight 长片分集思想。

### C6 产品化输出（1–2 批）
- **工作流→API 封装**（RunningHub 范式）：workflow_templates 任意模板一键暴露为 `/api/studio/wf/{id}/run`（含参数 schema 自动生成）；自用=把机队能力脚本化。
- **拍同款模板库**：项目六段快照存为模板（剧本骨架+资产占位+工作流绑定），一键开新项目（Vidu 拍同款）。
- CLI/API 入口后置（MoneyPrinterTurbo 四入口最低优先级，自用价值小）。

## 3. V3-0 收敛地基（前置，沿用上轮方案不重复展开）
- M1–M4 经典视图迁移 + entry.json 网关前置（真源 `CLASSIC_WEB_RETIREMENT_PLAN_20261011.md`）；
- token 统一随视图退役 + 双样式审计终验；单部署链路四产物（含桌面版本对齐断言）；
- 卫生项：CI bun 1.3.9→1.4.x（lockfileVersion 2 已实证解不开）。
- **C3 依赖 M1 的理由**：Agent 工具面切到 v2 端点前，经典视图先退役可避免工具双写两个数据面。

## 4. 排期（每批=实现→deploy --all→LAN 实测→入账推送）

| 波次 | 内容 | 批数 |
|---|---|---|
| V3-0 | 收敛地基（M1–M4+token+部署链+CI 卫生） | 4–6 |
| V3-1 | C1 一致性（三视图→槽位参数化→阶段感知→多主体合并） | 2–3 |
| V3-2 | C2 质检自动化（门禁→自动重试→成片抽检） | 1–2 |
| V3-3 | C3 Agent 同构（六段工具化→节点即工具→虚拟剧组） | 2–3 |
| V3-4 | C4 真时间线（决策点→实施） | 1–3 |
| V3-5 | C5 连续性与长片（机位树→分集） | 1–2 |
| V3-6 | C6 产品化输出（wf→API→拍同款） | 1–2 |

总量 12–21 批；V3-1/V3-2 可与 V3-0 部分并行（不同代码域，无冲突）。

## 5. 决策点（默认值不回复则按默认走）

| 时点 | 决策 | 默认 |
|---|---|---|
| V3-0 前 | R18 维持 A / 翻案 B / C | 维持 A |
| V3-0 前 | resources（train/backlot）淘汰 | 淘汰 |
| V3-4 初 | 真时间线上不上（DSL/Remotion vs 播放列表后置） | 按判据评估后给决策记录 |
| V3-2 | 质检自动重试等级（仅标记 vs 自动重生成） | 自动重生成（上限 2） |

## 6. 明确不做（继承 v2 §3.3 并追加）
- 社区/UGC、商业积分、多租户（默认关）、c_hybrid 长视频连续生成、RH 市场扩容——均维持既定拍板；
- 自研视频模型训练/微调（一致性始终走参考路线）；
- SlotLab（调研时即无可靠公开资料，不再跟踪）。

## 7. 变更记录
- 2026-10-11 v1：初版（依据调研真源+S1–S14 盘点重定；替代收尾视角的上轮清理方案，清理内容收编为 V3-0）。
