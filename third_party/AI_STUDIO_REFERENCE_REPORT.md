# ToIV 参考项目调研报告——13 个 AI 影视 / 短剧 / 创作平台的机制与 UI 设计参考

- **调研日期**：2026-10-27
- **调研对象**：13 个第三方参考项目（详见 §1 总表与 §8 路径索引）＋ ToIV 现状只读审查
- **报告目的**：为 ToIV（短剧 / AI 影视创作平台）提炼可借鉴的产品机制、生成链设计与 UI 信息架构，并给出可执行的优先级路线；所有结论以各项目调研笔记中固定 commit 的源码 / 文档 / 实测证据为准，不臆测、不补齐。
- **读者**：ToIV 产品与前后端团队；本报告可直接用于评审与拆任务。

---

## 1. 调研范围、证据分级与 13 仓总表

### 1.1 范围

**调研范围**：每个参考项目均在其独立 git clone（`third_party/reference-repos/<org>--<repo>`）内做静态源码审查 + 尽可能的隔离实机运行（本地端口、无真实密钥、无付费上游、不连生产）。**不改 ToIV 产品文件，不执行 git commit**。正文只引用各 clone 内可复核的文件路径作为证据；临时笔记与临时截图不作为正文证据（截图仅在 §7 验证范围中说明）。

### 1.2 证据分级

| 标注 | 含义 |
| --- | --- |
| 【源码】 | 仓库内代码 / 配置 / 数据模型事实，可在固定 commit 复核 |
| 【文档】 | README / docs / AGENTS.md 等声明，未逐条复现实测 |
| 【实测】 | 本次在隔离环境实际运行验证（启动、页面渲染、API 回包、UI 操作） |
| 【判断】 | 调研者基于以上证据的推断 / 评价，非事实陈述 |

**通用边界**：① 生成链（真实模型出图 / 出片）绝大多数未接真实密钥，"生成成功"类结论只有源码 + 文档证据，不得当作真实生成链通过；② UI fixture / mock 模式跑通 ≠ 真实链路跑通（详见 §7）；③ 许可结论仅为文件事实罗列，**不构成法律意见**；④ 思路借鉴 ≠ 复制源码 / 截图 / 品牌 / 交互皮肤。

---

### 1.3 13 仓来源总表

（commit 为完整 SHA；默认分支已逐一核实（Toonflow-app/Toonflow-web 为 `master`，其余 11 仓为 `main`）；运行验证范围指本次隔离实测能做到的边界。）

| # | 项目 | 仓库（clone 目录名） | 来源 | 默认分支 | 完整 commit | 许可（笔记概括） | 运行验证范围 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | BeefTV | `glanderness--BeefTV` | github.com/glanderness/BeefTV | `main` | `70aa2a3d5aaac6cb817f73f759f740d9a55dfc27`（merge，2026-10-27 01:33:46 +0800；VERSION v2.0.4） | 分范围双段：Part A Source Available 1.0（商用转售/对外托管需书面授权）+ Part B 历史 MIT；捆绑 `@ffmpeg/core` GPL-2.0-or-later | web bun dev + Go 后端跑通，Playwright 9 路由截图 + 真实创建画布/短剧项目 API；未实测真实生成、桌面打包、MCP |
| 2 | ArcReel | `ArcReel--ArcReel` | github.com/ArcReel/ArcReel | `main` | `82a5b8bfec09e53f9dcc6ef97de466ccfad5b037`（2026-10-27 06:25 +0800；pyproject 0.34.0） | AGPL-3.0 + NOTICE 附加署名/商标除外；FFmpeg(GPL)/思源黑体(OFL) 随包 | 前端 typecheck + 3950 单测全过 + 105 个 Playwright 页面区域用例（含官方截图基线）；后端 pytest/真实生成/Docker 未做 |
| 3 | DramaClaw | `dramaclaw--dramaclaw` | github.com/dramaclaw/dramaclaw | `main` | `2aac1c2d74e537c77e3c99b0c84bc980c97d5151`（2026-10-26 17:44 +0800；包 supertale-ce v2.0.6） | Elastic License 2.0（禁转售托管 SaaS）+ 品牌归因「Powered by DramaClaw」；LGPL/MPL 组件见清单 | 前端 build + 556 文件 4877 用例全过 + preview 打开 /download；后端 uv sync 失败（git 依赖超时）→ 产品界面未实测 |
| 4 | AID Studio | `gzxx-2025--aid-studio` | github.com/gzxx-2025/aid-studio（同步 Gitee） | `main` | `7e0ed1512b295e558e9c0accd9c12689076b3547`（2026-10-22 21:25 +0800；产品 v2.2.4） | MIT（光子讯息(杭州)）+ NOTICE 含 RuoYi-Vue(MIT)；官方素材包不在许可内 | web npm ci + typecheck 过 + **vitest 405 用例中 4 失败** + Next build 22 路由 + next start 截图 3 张；后端/admin/真实模型未做 |
| 5 | printfilm | `yi1108--printfilm` | github.com/yi1108/printfilm | `main` | `62f8d95d7ee6a5af9543351040e6183e9dcbbe65`（2026-10-22 13:51 +0800；README 0.2.0） | MIT（PRINTFILM 2026） | **全栈 mock 实测**：PG+Redis+FastAPI+用户端+管理端；pytest 862 过 1 失败 1 跳过；mock 边界（LLM 无 mock、合成失败）已记录；真实生成/OSS/支付未做 |
| 6 | LumenX | `alibaba--lumenx` | github.com/alibaba/lumenx（StarLotus · Alibaba） | `main` | `f2a02e23171447c939e7d8e1386b24d17049bbf1`（2026-08-11 15:00:33 +0800） | MIT（Copyright (c) 2026 Alibaba） | 后端 pytest 209 全过 + catalog 校验/构建幂等 + uvicorn API 冒烟 + next dev Playwright 实测 5 页 + 项目五步（lockfile 内网 registry 踩坑已记录）；真实生成未做 |
| 7 | KŌMA Studio | `klaus-2--koma-studio` | github.com/klaus-2/koma-studio | `main` | `250f6151a7fcb8efb28f73d4d0bbfa6952838764`（2026-10-26 18:43 -0300；v1.2.0） | MIT + THIRD-PARTY-NOTICES（GPL-3.0 权重不入库、Pororo NC 权重） | interface vitest 523 全过 + tauri dev 走查 7 路由 + 390px；Python mini-backend 测试被依赖阻塞；**扫译工具非影视产品** |
| 8 | BigBanana AI Director | `shuyu-labs--BigBanana-AI-Director` | github.com/shuyu-labs/BigBanana-AI-Director | `main` | HEAD `ead7a5ca0513d7c225f72197ac78712a825a9ae9`（2026-10-06，**纯文档仓**）；历史源码快照 `556824c4207c4582325f01e6c6546a3df22b403f`（2026-03-15） | BigBanana Community License 1.0（禁商用）与 README 所称 CC BY-NC-SA 4.0 口径冲突，均禁商用 | 历史版 SPA vite+Playwright 走查（无后端可跑、阶段门禁/空态/MobileWarning 实见）+ 官方截图 7 张目视 + 其余 OCR；现行版 3.4.2 与生成链未实测 |
| 9 | AI Movie Studio 2 | `Heroesjouney--AIMovieStudiov2` | github.com/Heroesjouney/AIMovieStudiov2 | `main` | `eb52643b62429ee1a3f94e94ef06f38fc13dfcbb`（2026-09-15 22:27:38 -0400） | GNU AGPLv3（README 另售商业授权） | next build 过 + 后端 /health + Playwright 14 张截图 0 JS error + API 冒烟全 200；生成链/Previs 渲染/时间轴渲染未实测；全仓零测试 |
| 10 | AI Story | `xhongc--ai_story` | github.com/xhongc/ai_story | `main` | `e859bf39eb1e9669153888cc78c3f57a81c771cd`（2026-10-13 13:10 +0800） | 根无 LICENSE；根 README CC BY-NC-SA 4.0 与子目录 README「MIT」**冲突**；agent/mcp/workflows 标记闭源（源码「泄漏」状态） | Django 全栈起服 + Playwright 17 张截图 0 console error + API 实测（JWT/建项目/run_pipeline）；主链路 mock 半通（storyboard 失败属 mock 桩缺陷）；真实 LLM 未做 |
| 11 | CineGen ShortDrama | `UllrAI--CineGen-ShortDrama` | github.com/UllrAI/CineGen-ShortDrama | `main`（无 tag） | `f823501fc9c9f0daace80c8018db39b1acef94c3`（2026-09-25） | AniKuku Community License (ACL) v1.0（非商业 + 强制双链接署名） | build + dev + Playwright 13 状态走查（假项目注入走通 UI 全流程）；真实 Gemini/Veo 成功路径未跑（仅入口与失败路径）；动效失效实测 |
| 12 | Toonflow-app | `HBAI-Ltd--Toonflow-app` | github.com/HBAI-Ltd/Toonflow-app | `master` | `30139c931e80476caa718b31684b86383c6e83ce`（2026-10-21 00:12 +0800；app 2.0.0） | MIT（HBAI-Ltd 2026）+ 不追溯条款；商标不在授权内 | bun 1.3.14 构建 + 服务器 :3457 + Chrome 实测 hello/home/workspace 画布与文档面板；真实生成/MCP/桌面/Android 未做；**零测试属项目政策** |
| 13 | Toonflow-web（**归档旧前端**） | `HBAI-Ltd--Toonflow-web` | github.com/HBAI-Ltd/Toonflow-web | `master` | `f270e0352b0148ddb3983357ce3e289cda7d7aa1`（2026-09-24，归档提交；879 commits） | Apache-2.0 + 补充商业协议（≥2 独立第三方分发需书面授权）；README 徽章 AGPL 为历史遗留 | yarn install + **`yarn build` 失败（死文件）** + build-only 成功（单文件 26.6MB）+ dev :50188 实测 login/project/novel/script；production 等未选项目抛错实测；全链路需其后端未做；零测试 |

---

## 2. 执行摘要

### 2.1 先厘清三个「非同类」对象（避免误比）

13 个对象并非同一品类。**KŌMA Studio 是漫画扫译（scanlation）桌面工具链**（检测→OCR→翻译→去字→嵌字→导出），没有剧本/分镜/镜头概念，只能借工程机制（快照溯源/模型注册表/回退链/状态底栏）；**BigBanana HEAD 是纯文档仓**，源码只在历史快照 `556824c4207c4582325f01e6c6546a3df22b403f`（现行版 3.4.2 的世界观/小说导入/CutOS 无源码可查）；**Toonflow-web 是已归档旧前端**（879 commits 后迁入 Toonflow-app monorepo），且其许可（Apache-2.0+补充商业协议）与 Toonflow-app（MIT）不同。把这三个写成「同类 AI 短剧产品」会误导路线判断。其余 10 个才是短剧/漫剧/影视生产类对照物，其中与 ToIV 定位最同构的是 **AID Studio**（自托管 AI 漫剧/短剧工厂）、**DramaClaw**（画布+流水线双轨短剧生产线）、**ArcReel**（自托管 AI 视频生产工作台）、**LumenX**（pipeline-first 漫剧座舱）。

### 2.2 最值得 ToIV 学的跨项目机制（按主题归并）

| 主题 | 跨项目证据 | ToIV 现状（audit 判定） | 结论 |
| --- | --- | --- | --- |
| **产物/状态三轴治理**（步骤进度 × 产物时效 × 任务收单分离；清单即真相源） | ArcReel（artifact_manifest + current/stale/missing/blocked + 服务端权威制作状态）、BeefTV（shot_artifacts selected/stale）、ai_story（DAG stale/幂等键）、KŌMA（阶段快照 + 逐区域模型溯源） | **部分**（Go 有 stale；FastAPI 线无；无三轴投影） | P0 统一任务中心读模型 + P1 stale 联动 |
| **渲染前准入与成本预估**（报价单/逐单元去向/档位锁定/预冻结） | ArcReel（batch_admission 三态 + `video_quote`）、AID Studio（报价与提交同口径 + 三阶段计费）、printfilm（tokens_estimated 诚实标记）、DramaClaw（节点价显示）、Toonflow（mediaPrice 徽标） | **未见**（仅用量计数） | P1 渲染前资源/成本预估 |
| **提示词/配方资产化**（版本历史 + diff/回滚 + 用户可存配方 + 契约化落库） | BigBanana（promptVersion 30 条 + 提示词管理页）、ai_story（模板集/Jinja2/调试台）、AIMS2（GenerationRecipe 随 shot）、BeefTV（prompt_templates + 用户创作层）、Toonflow-app（v118workflow 技能化方法论） | **部分**（三套预设非用户可存；Studio 线 prompt 无修订史） | P1 用户配方库 + Studio 提示词修订 |
| **跨集资产对账**（抽取→匹配→合并/新建决策 + 版本 syncStatus + 漂移台账） | LumenX（ReconcileModal 置信阈值默认 + 行内改 + 全部确认）、BigBanana（characterSync synced/outdated/local-only + 导入预期管理三卡）、DramaClaw（Identity 多身份 + 依赖门）、ai_story（资产模糊匹配 + 绑定） | **部分**（ProjectAssetCandidate/presence-check 有，无对账面） | **P0 跨集资产对账**（最贴短剧刚需） |
| **多候选/take 品控链**（×N 抽卡→星标短名单→对比→拍板→pin 防覆盖） | LumenX（T2I 历史 FIFO + CompareModal + final_take_id + pin）、AIMS2（video_takes + Continuity Chain）、printfilm（单镜重做/尾帧衔接） | **已有**（多候选 pick + 自动选优） | **不重做数据侧**；P2 只补并排对比/拍板台 UI |
| **模型能力单源**（catalog as code + 能力声明驱动 UI + 调用前强校验 + 证据台账） | LumenX（family YAML→生成 JSON→CI 校验）、AID Studio（能力位 + capability_json + 「不猜上限」台账）、AIMS2（DriverInfo 徽章/显隐）、KŌMA（注册表 SHA256/需求/安装策略）、Toonflow-app（ProviderDefinition） | **部分**（双源互不同步） | P2 模型能力元数据单源 |
| **任务可靠性语义**（幂等/租约/取消边界/重启不重提/诊断字段） | ArcReel（取消仅限排队、原域名续跑）、BeefTV（clientOperationID + 报价签名）、AID Studio（三时刻 + 补偿对账）、AIMS2（进程内字典反例）、printfilm（TaskRun 四表） | **已有**（多层幂等/自愈） | **不重做**；仅把「下一步」投影与诊断字段并入统一任务中心 |
| **导出/交付**（多轨时间线→成片/剪映/NLE） | ArcReel（时间线多修订 + 成片/剪映双出口）、BigBanana（CutOS AI 剪辑 + NLE 模板）、AIMS2（CMX3600 EDL/Premiere XML）、printfilm（mp4cat 无损拼接）、Toonflow-web（@webav 浏览器剪辑） | **已有剪映**（jianying_draft v1）；EDL 仅 transcript 链 | **不重做剪映**；P2 只补创作台全量多轨导出（EDL/FCPXML） |
| **Agent 编排交互**（工序行/深链/结构化标签直写画布/确认关口） | ArcReel（编排 skill + 子智能体 + 深链）、Toonflow-app（14 阶段技能 + 确认关口 + 画布留痕）、Toonflow-web（XML 标签流直写 DAG + 反向 RPC）、DramaClaw（虾导草稿/确认/恢复） | **部分** | P1 阶段确认 + P2 结构化标签通道 |

### 2.3 不建议重复造的已有能力（对照 toiv-current-audit，明确排除）

- **多 take/多候选选优**：`StudioShot.candidates_json` + `pick` + `candidate_pick.py`（裁脸相似度/OCR 乱码降权/连贯分）+ `bestof.py` 评测管线已在——只缺对比 UI（P2 第 7 项），不要重做候选数据侧。
- **任务幂等与恢复**：Go `client_operation_id` 唯一键 + FastAPI `jobs_persist`/`render_reconcile`/`HeldJob`/`drama_pipeline` 断点续跑 + 章级应用回执幂等重放——竞品的租约/去重/取消语义只做文案级吸收。
- **剪映导出**：`jianying_draft.py`（`toiv_jianying_draft_v1` ZIP）+ `export/jianying` + 前端按钮已在——不要按 ArcReel/ai_story 重写剪映链；P2 只补 EDL/FCPXML 全量多轨与分轨草稿增量。
- **场景锚点/变体冻结**：`drama_scenes.py` freeze-anchor/attach/scene-ref + `anchor_sha256` 已有，DramaClaw/BigBanana 的「资产先行」只补对账与展示层。
- **角色设定卡三视图族**：character-sheet 三视图/panels/keep-rejected/recompose 已有，补「身份/服装变体」层级即可，勿重建四视图。

### 2.4 关键结论（判断）

1. **ToIV 的短板不在「有没有生成」而在「生产可治理」**：把工程做深的项目（ArcReel/BeefTV/AID Studio）共同点是产物清单、成本预估、状态投影、提示词版本——恰是 ToIV audit 标「部分/未见」的项。
2. **跨集资产对账是短剧刚需且竞品已有成熟交互范本**（LumenX ReconcileModal + BigBanana syncStatus/预期管理三卡），应作为 P0 第一项。
3. **能力声明驱动 UI + 调用前强校验**是 5 个项目共同收敛的形态；ToIV 双源能力元数据应尽快单源化，否则「渲染前预估」也做不准。
4. **方法论技能化**（Toonflow-app v118workflow 的 14 阶段 + 确认关口 + 画布留痕 + 上游改动只标下游待复核）是把 Agent 从「聊天玩具」变成「生产协作者」的关键结构，ToIV 可先以 Skill 文档形式沉淀 SVML→分镜→渲染链。
5. **UI 横切**：空载错文案、阶段门禁、预期管理面板、状态底栏、保存/离开拦截、容器化响应式与 axe 级 a11y 是 ArcReel/DramaClaw/Toonflow-app 的公共高分项；AIMS2/CineGen 的零 aria、占位按钮、原生 alert 是公共反面教材。
6. **许可上只有 AID Studio、printfilm、LumenX、KŌMA、Toonflow-app（MIT 系）可讨论有限并码**（且各有依赖/素材/商标/权重边界）；ArcReel(AGPL)、AIMS2(AGPL)、BigBanana(禁商用)、CineGen(非商业+署名)、Toonflow-web(Apache+商业补充)、DramaClaw(ELv2)、ai_story(许可冲突) **一律只借思路**。

---

## 3. 分项目详析（按用户指定顺序）

### 3.1 BeefTV（glanderness/BeefTV）——本地优先 AI 影视创作工作台

**定位与核心思路**【文档+源码】：本地优先、单用户、免注册的桌面应用（Wails 壳 + 本地 Go 后端 + SQLite），定位「AI 时代的视频创作工作台，在一个自由画布中连接创意、模型与素材」（`README.md`；`QUICKSTART.md` 明言「登录、云存储、团队同步和计费不属于 BeefTV 本地版」）。三条产品主线：**Agent**（聊天推进创作）、**Skills**（把创作方法沉淀为技能）、**工作流**（把生成处理串成可复用流程）；核心命题是「AI 影视创作 = 可编辑、可积累、可复用的工程」，分镜 / 素材 / 过程都留在画布上可持续编辑。

**架构与生成/工作链**【源码】：`web/`（Vite + React 19 + AntD 6 + Zustand + TanStack Query + Excalidraw + three.js + ffmpeg.wasm）、`backend/`（Go + Gin + GORM + SQLite；`cmd/desktop` Wails、`cmd/server`、`cmd/beeftv` CLI/MCP）、`agent-host/`（Bun，钉选 pi SDK）、`docs/`（Fumadocs）。调用链约定 `HTTP → handler → localapp/domain → repository/model`，上游进入 `generation/provider/protocol/outbound`（`AGENTS.md` §3）。生成链：admission（配额/幂等/授权）→ worker 租约领取 → `generation` 统一输入与引用预处理（Seedance 参考素材换短期 HTTPS 链接）→ 协议 payload → 交付物化本地资源并绑回画布节点（多图按 `outputNodeIds` 核对）→ 远端产物断点续传下载。模型协议适配器极全：文本 `chat-completion/openai-response/claude-api`；图片 `openai-image/volcengine-ark-image/jimeng-image/gemini-image/Seedream/Midjourney/runninghub-workflow-image` 等；视频 `newapi/xai-video/ark-video/jimeng-video/gemini-veo/novita-video/minimax-video/agnes-video/runninghub-workflow-video` 等；音频 `openai-audio/async-audio` + Topaz 超分（`backend/internal/protocol/builtin.go`）。短剧工作流 v2 顺序「剧情、资产、分镜、动作预演、视频、交付」（`workflow_template_versions` 等表）。

**最突出的优势**：

1. **付费任务工程化做到底**【源码+文档】：`clientOperationID + 请求哈希` 唯一索引（重放回读、异参 409）、`creation_submissions` 报价签名 + 用户确认后同键提交、图片提交幂等键恢复（12 次/轮、23 小时窗口、重启不重置）、供应商取消状态机、脱敏 `failure_diagnostics`；`docs/architecture/generation-task-state.md` 甚至自曝「一个接口三种走法」并给出 Stripe PaymentIntent 式 `status + next_action` 重构方向。
2. **分镜领域模型完整且版本化**【源码】：`shots`（稳定身份 + `currentRevisionId`）+ `shot_revisions`（不可覆盖：景别/机位/运镜/动作节拍/双提示词/连续性备注）+ `shot_artifacts`（`selected/stale`）+ `shot_asset_references`（镜头绑定 `assetVersionId`，改引用只使本镜头下游过期）。
3. **画布为中心的可积累资产闭环**【源码+文档】：Agent 写回画布（官方案例《最后一瓶水》25 节点 48 连线，文档声明未复现）→ 框选沉淀为可复用工作流（不可变模板版本 + 加密配方 + 实例升级确认）→ Skills 固定版本安装 / 回退 / 私人改写。
4. **本地数据安全语义**【源码】：画布 revision CAS + 5 分钟采样快照（每画布留 20 份）+ 恢复前强制备份、素材→资源所有权与删除引用检查、凭据 AES-GCM 加密、诊断包默认排除密钥/URL。

**UI 信息架构与逐页/逐区域设计参考**【源码+实测】：全局壳 `AppWorkspaceShell` + 左侧栏（新建项目 / 首页 / 项目 / 资产 / 技能 / 模型配置 / 存储设置 / BeefTV MCP，底部账号卡 + 容量条 + 主题切换）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| 首页 `/` | 顶部 hero 卡（点阵波纹动画 + 居中「新建画布创作」大按钮，白底圆角 16px 图标盒 + 投影）→ 7 能力磁贴（自由画布/视频/图片/音频/3D 导演台/Agent/项目库）→「最近项目」卡片网格（缩略图=画布节点预览） | 加载骨架 4 卡；错误态「画布读取失败，点击重试」；空态 CTA「创建第一个画布 / 让灵感有一个开始的地方」 | 中性单色语义 token；卡片圆角 12px 细边框、标题 16px/500、正文 14px；820px 窄视口侧栏收为图标轨、磁贴改排【实测】 |
| 创作页 `/create`（约 1300 行） | 空态 launchpad：标题 + 模式 Tab（视频/图片/文本，胶囊滑块指示器 44px 高圆角 18px）+ 空 composer（提示词、模型选择器、16:9·720P、6s、数量）+ 4 张起步建议卡 +「精选灵感」22 条（含「开源改编 · CC0」标注）；工作台形态：消息线程 + 底部 composer + 工具条 | 历史抽屉（改名/删除）；会话冲突对话框「用云端保存/用本地草稿」二选一；素材选择弹窗（含 Eagle 外部源）；demo 数据横幅「模拟对话流 · 不会调用真实生成接口」；失败消息可重试/做变体/编辑重发 | 图片预览复用画布全屏查看器（缩放 0.5–12、步进 0.25） |
| 画布编辑器 `/canvas/:id`（`project.tsx` 3556 行） | 顶栏：画布菜单 + 标题单击编辑 + 铅笔按钮 + 画布切换 +「工作流」「Agent」+ 保存状态 + 面包屑；主体无限画布（节点：图片/视频/音频/文本/分镜/工作流/超分/深度/多角度 3D/宫格切分/HTML/Markdown/SVG/调色/对比…）；底部工具坞（抓手/区域选择胶囊、连线显隐、资产管理、缩放、自动整理、画布外观面板）；右侧 Agent 侧栏（技能入口 + 方案卡 + 会话流 + 「@ 引用素材」输入框） | 空态「双击画布 · 自由生成节点 / 或让助手搭个草案 ⌘J」；起始框 + 号添加菜单；多选悬浮栏（对齐/等距/创建分镜组/批量连接/保存为工作流）；右键「自适应整理画布」；版本记录浮层（日期树 → 只读预览 → 恢复）；Agent 无模型时「还没有可用的助手模型 / 去模型配置」可恢复错误态 | 画布节点与浮层分 token（`lib/canvas-theme.ts`）；主操作黑/选中浅灰/开关绿三色角色分离（`lib/app-theme.ts`）；`aria-pressed` 表持久切换；`prefers-reduced-motion` 尊重 |
| 资产库 `/assets`（2116 行） | 页头「个人资产库」+ 容量用量（70% 警告/90% 危险色）；类型 Tab（全部/文本/图片/视频/音频，带计数）；分类筛选（character/environment/prop/material/other + 自定义目录）；网格/列表视图、排序、搜索、多选批处理、「生成历史」tab | 空态「当前暂无资产 / 上传资产」计数全 0；删除先查项目/画布/任务引用，有引用保留并返回来源 | 与侧栏容量条同源查询 |
| 技能 `/skills` | 三 Tab（技能市场/我的技能/我的投稿）+ 顶栏「创建技能/导入文件」；市场行：名称+版本+作者+许可+验证徽章（「有实测记录」/「效果尚未验证」）+兼容性警告+「查看与安装」 | 我的技能：查看文件、启用/停用、检查更新、回退历史版本、复制为私人改写；投稿「准备（本机）→ 上传私有草稿 → 公开送审」分步确认 | 实测 3 个官方技能均标「效果尚未验证」（诚实但说明验证体系早期） |
| 设置 `/settings` | 分区 `channels/models/storage/diagnostics`；channels：本地模型渠道 +「拉取全部渠道模型/添加模型服务」+ 官方渠道卡（「一键连接 / 未连接 / 连接 / 拉取模型 / 编辑」）；默认模型网格：生图/视频/文本/助手/多模态/音频 | 诊断面板：脱敏诊断包导出、环境自检、预览缓存清理；提示词偏好（跟随/追加/改写创作层） | 桌面原生才有 storage 分区 |
| 任务中心 `/tasks`（817 行，路由被关） | 列表/网格、状态筛选、任务分组、日志查看、失败诊断导出、扣费重试确认、视频上游查询取回 | 路由显式关闭（注释「避免旧链接进入半成品界面」）→ 重定向 `/`；运行中任务进度走全局 `WorkspaceOperationProgress` + 画布节点状态 | — |

视觉体系：三层 token（Primitive→Semantic→Component，禁裸 px/十六进制，`web/src/components/ui/README.md`）；字阶 `--fs-nano 7 … display 36`；阴影 `--shadow-xs…2xl` + 蓝辉光仅强调；a11y：图标按钮均有 `aria-label/title`、`focus-visible` 描边、跳转链接「跳转到画布主内容」、减弱动态下悬停预览不自动播。

**局限与反模式**【源码+文档+判断】：① 复杂度债自认：前端约 30 文件 + 后端约 18 文件各自推断任务结果，前后端按错误文案重复分类（`lib/generation-error.ts` 1180 行 vs `generation/provider_error.go` 1607 行），`/retry`、`/cancel` 一口两用（「前端猜后台」反模式）；② 托管时代遗留（`shortDramaEnabled/taskCenterEnabled/creditsEnabled` 开关、admin、账号容量）与本地形态互相让位，`/projects/:id/*`、`/tasks` 当前不可达（`isLocalWorkspaceMode()` 硬编码 true 重定向画布）；③ macOS 未签名公证；④ 生成质量检查依赖多模态模型且自述需人工核对；⑤ 前端重量级（three.js + Excalidraw + ffmpeg.wasm + MediaPipe 同包）；⑥ 单用户本地形态无协同。

**ToIV 借鉴映射**（对照 toiv-current-audit 判定）：

| 借鉴点 | BeefTV 证据 | ToIV 现状 | 建议落点 |
| --- | --- | --- | --- |
| 任务「下一步」投影（phase + regenerate + reason）+ 免费取回/扣费重试分接口 | `docs/architecture/generation-task-state.md`、`models_task.go` | **部分**（已有任务幂等/自愈，但前端仍消费轮询列表） | 并入 §5 P0「统一任务中心」读模型，不重做幂等 |
| 分镜版本化四件套（shot/revision/artifact selected-stale/资产版本绑定） | `backend/internal/model/models_project.go` | **已有**（Go 域 `Shot/ShotRevision/ShotArtifact/ShotAssetReference` 齐全；FastAPI Studio 线缺 stale） | 不重做；仅在 FastAPI 线补 stale 联动（并入 §5 P1 提示词修订项） |
| 平台提示词模板 + 用户创作层改写 + 服务端注入契约 | `prompt_templates`、`backend/internal/prompts/` | **部分**（Go 有 `PromptTemplate/UserPromptCustomization`；Studio 线 `StudioShot.prompt` 无修订史） | §5 P1「Studio 提示词修订」 |
| 框选→可复用工作流（不可变版本/加密配方/实例升级确认） | `canvas_workflows*`、`reusable-workflow*.ts` | **部分**（有 `WorkflowTemplateVersion` 阶段门控模板，无用户可存参数配方） | §5 P1「用户配方库」 |
| 技能市场语义（固定版本/回退/私人改写/投稿分步/验证徽章） | `skills/*` 表 + `/skills` 页 | **未见** | P2 以后，ToIV 可先做「方法沉淀」内部版 |
| 素材删除引用检查 + 回收站 + 容量计量（70/90% 变色） | resources 域 + 资产页 | **部分**（有媒体池/资产库，无容量条与删除引用检查的统一文案） | P2 媒体库治理 |
| 空态/错误态文案区分「本地缓存成功 ≠ 服务端持久化成功」 | 项目库错误态实测文案 | **未见**统一规范 | 并入 §4「空载错」横切建议 |

**许可边界**【源码文件事实，非法律意见】：`LICENSE` 分范围双段——Part A「BeefTV Source Available License 1.0」覆盖新原创内容，允许个人/研究/组织内部使用（含商业创作产出）与私有修改，**商业转售/套壳白标/收费代部署/任何对外托管（External Service）需事先书面授权**（lucas@bf-labs.cn）；Part B 历史与上游 MIT 材料（含 `a96baf08…`、`2327ee2d…` 点名提交）继续适用 MIT。`NOTICE` 记上游 Infinite Canvas（`basketikun/infinite-canvas` base v0.5.0，`568f0f18…`，上游 `890ba958…` 改 MIT）。`THIRD_PARTY_NOTICES.md`：**`@ffmpeg/core` GPL-2.0-or-later**（Part A/B 均不覆盖）。**结论**：不能视为标准 MIT/OSI 开源；ToIV 产品代码不得直接并入其受 Part A 覆盖的代码，GPL 组件另有传染性；只借设计与接口语义，自行实现。

**运行验证边界**【实测】：web（bun install + dev :13100）与 Go 后端（:18099，`GOPROXY=goproxy.cn`）跑通，`/api/health` → `code:0` schema ready；Playwright 1440×900 与 820×900 覆盖 `/`、`/create`、`/project`、`/assets`、`/skills`、`/settings?section=channels`、`/agents`、`/plugins`、`/canvas/:id`，并真实创建画布 2 个、短剧项目 1 个（API `/core`、`/overview` 成功）。**未实测**：真实模型生成链（无密钥）、桌面打包/公证、`/projects/:id/*` 短剧工作台（路由被重定向）、`/tasks` 页、MCP（`/agents` 显示错误态）、短剧流水线空态引导。随仓截图 `assets/readme/*` 未解码查看，不作视觉证据。临时截图在 `/tmp/beeftv-research-shots/`（仅验证记录用）。

**关键源码证据路径**（`glanderness--BeefTV:` 前缀）：`README.md`、`QUICKSTART.md`、`AGENTS.md`、`LICENSE`、`NOTICE`、`THIRD_PARTY_NOTICES.md`、`docs/architecture/generation-task-state.md`、`docs/content/docs/backend/backend-database.mdx`、`backend/internal/model/models_project.go`、`backend/internal/model/models_task.go`、`backend/internal/protocol/builtin.go`、`web/src/router.tsx`、`web/src/pages/canvas/project.tsx`、`web/src/pages/create/index.tsx`、`web/src/pages/assets/index.tsx`、`web/src/pages/skills/marketplace.tsx`、`web/src/pages/settings/index.tsx`、`web/src/pages/tasks/index.tsx`、`web/src/lib/app-theme.ts`、`web/src/components/ui/README.md`。


### 3.2 ArcReel（ArcReel/ArcReel）——自托管 AI 视频生产工作台（状态治理与成本纪律标杆）

**定位与核心思路**【文档】：开源、自托管的 AI 视频生产工作台（Docker 镜像默认端口 1241），把小说 / 成品剧本 / 商品素材转化为「角色一致、过程可控、成本可追踪、可继续编辑的短视频」。主用户是自托管个人创作者，不提供多人协作与角色权限（`PRODUCT.md`）。三条差异化：① Agent 贯穿全流程；② 供应商自由接入；③ 开源自托管 + 剪映交付。产品原则四条——**审核优先于自动、代价先于执行、服务端判定即状态、单人可完成全链路**；成功判据是一名创作者独立走完源文件→成片/剪映草稿，且每阶段能确认进展、修改产出、查看实际花费。

**架构与生成/工作链**【源码+文档】：前端 React 19 + Vite 8 + Tailwind 4/shadcn + wouter + zustand + i18next（zh/en/vi 全量）；服务端 FastAPI + SQLAlchemy 2.0 异步 + Alembic（默认 SQLite WAL，可切 PostgreSQL）；核心库 `lib/` 由 import-linter 强制「server→lib 单向、lib 不依赖 fastapi」。两条正交轴：创作类型 `content_mode`（narration 旁白/drama 剧情/ad 广告）× 生成模式 `generation_mode`（storyboard 分镜图生视频 / reference_video 参考生视频，创建后锁定）；storyboard 可选**多宫格分镜**（多分镜联合图统一生成→审阅→切分落格）。端到端：源文件→内容分析与项目规划（Agent 分集/识别资产）→资产（角色/场景/道具/商品 sheet）→分集结构化剧本→分镜图或参考生视频→视频片段+旁白音轨→剪辑时间线→成片（ffmpeg）或剪映草稿。项目即目录（`project.json` schema v19 + scripts/assets/edit_timelines/renders…），全局资产库跨项目复用。生成队列：图像/视频/音频独立并发通道 + render 车道（并发 1、不产生用量）；任务持久化 + `provider_job_id` + `submitted_base_url` 原域名轮询续跑 + 活动任务部分唯一索引去重；**用户取消只作用于排队中任务**；重启后仅「供应商支持续查 + 已记录任务号」的视频任务自动接续，其余标失败等人工重试（防二次计费，`docs/adr/0006`）。供应商预置 gemini/ark/grok/openai/vidu/dashscope/minimax/kling/agnes/anthropic/openrouter/newapi + 自定义 provider/端点（含 ComfyUI workflow 端点）+ GitHub 索引端点市场。Agent 运行时基于 Claude Agent SDK：「编排 skill + 聚焦子智能体」（`video-workflow` 及 generate-script/assets/storyboard/grid/video/narration/edit 等 skill；只读审图/审片子智能体），确定性工具单点声明双投影（进程内 MCP + 远程 MCP），两层沙箱（内核 sandbox-exec/bwrap + PreToolUse hook）。

**最突出的优势**：

1. **状态与产物治理同类最完整**【源码+文档】：产物清单 `artifact_manifest` 单一真相源（「是否存在/一致一律问清单，不扫目录」）+ 生成依据 basis（提示词/画风/比例/参考图集指纹，不含供应商参数）+ 时效四态 `current/stale/missing/blocked`（stale 仍可查看参与成片）+ 服务端权威「制作状态/制作计划」；三轴在类型层分离：步骤进度 × 产物时效 × 任务收单状态，界面不得折成一个状态（`frontend/src/types/workflow.ts:12-22`）。
2. **成本纪律贯穿提交链路**：批量视频准入三态（放行/待确认/受阻，整批 all-or-nothing）+ `preview:true` 报价单 `video_quote`（逐单元去向/编排时长/档位/预计费用，确认后带 `confirmed_request_durations` 锁档）+ 用量契约计量 + 多币种 + 「查不到单价记未定价、不猜测」（`docs/adr/0100`）+ 费用调用完成时冻结。
3. **可中断恢复与幂等工程细节**（同上任务编排），以及**后期可编辑交付**：剪辑时间线为正式内容（不可变修订序列 + 乐观并发 `base_revision` 冲突判定 + 回滚=追加新修订），成片与剪映草稿（5.x `draft_content.json` / 6+ `draft_info.json` 双格式）双出口，浏览器预览与导出共享「成片读取模型」。
4. **工程成熟度**：783 个后端测试文件、前端 297 文件 3950 用例、41 区域 e2e × 5 视口 + 484 张截图基线 + axe WCAG 2.2AA + 溢出探针、107 篇 ADR、GLOSSARY 术语治理、`scripts/gate.py` 全闸门。

**UI 信息架构与逐页/逐区域设计参考**【源码+运行】：

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| 项目大厅 `/app/projects`（铺满档、无侧栏） | 顶栏：品牌、搜索、资产库、外部 Agent、已删除项目、「新建项目」分体按钮、设置；主体：问候区（打字机效果）+ 吸顶筛选工具栏 + 海报卡网格 | 项目卡：`aspect-2/1` 封面（无缩略图用渐变 + 衬线大标题叠底）、标题 + 进度圆点行 +「待修复」琥珀胶囊 + 失败原因 `line-clamp-2` + 活动时间；更多操作菜单 hover/焦点显现；改名对话框注明「项目 ID 不变」；删除确认、导出 zip 范围对话框、导入冲突/报告确认、已删除项目（30 天恢复/彻底删除）；改名/删除后静默重载不闪加载态 | 空态 `Empty` 组件族；加载失败 toast；【运行】24 项目 + 超长标题/40 集压力下首屏信息完整、筛选吸顶不遮挡、长错误可键盘滚动且按钮可达 |
| 新建项目向导 | 固定高度 Dialog、三步共用一个滚动区、底部按钮不随步骤移动：Basics（必填缺失项列出）→ Generation（生成模式 + 各通道模型，多时可滚；广告自定义总时长校验）→ 风格（模版网格 + 自定义参考图） | 顶部 `WizardStepper`；「展开宫格分镜」开关；往返步骤预览仍有效 | — |
| 工作区外壳 `StudioLayout`（三栏） | 顶栏全宽：项目切换器、返回、**制作状态条**（集进度弹层逐集清单 + 项目层「下一步」弹层 + 数据升级失败重试）、通知抽屉、导出归档、资产库、设置（配置不完整红点）；三栏：侧栏（概览/分集/角色/场景/道具/商品/文件，56↔256px）\| 画布（min 480px）\| Agent 面板（420 默认/640 max） | 栏间手柄拖动/方向键调宽（16px/步、双击恢复）；标准档 ≥1280 Agent 挤压画布，紧凑档 <1280 Agent 覆盖画布右侧（非模态）、面板内 Esc 收起；离开拦截 `LeaveGuardProvider`（继续编辑/放弃修改/保存并离开，截浏览器前进后退） | 尺寸常量 e2e 断言一致（`workspace-layout.ts`） |
| Agent 面板 `AgentCopilot` | 消息流（流式 Markdown、滚动跟随/「跳到最新」、图片放大、原地编辑）+ 工序行（工具名/摘要、失败/运行收起、长结果「显示全部」、子智能体子时间线）+ 输入区（图片附件、斜杠命令菜单、排队消息托盘、Agent 问问卷、待办进度、会话历史） | 会话投影：「上下文已压缩」分隔线、Agent 失败一句话结论卡片；回复内「跳到这里看」深链（`/app/projects/{p}/episodes/{e}?view=edit&tl=&t=`）应用内跳转；面板收起内容保持挂载、输入不丢 | — |
| 项目概览画布 | 单列限宽：页头元信息 → 资产完成度行（各类型资产图可用/过期计数）+ **费用行**（多币种、历史支出弹层两列、缺价时列未定价模型 + 链接到设置）→ 故事设定（梗概/类型/主题/世界观，字段随内容撑高） | 有修改时下方未保存提示条；从原文重新生成有确认框说明修改丢失；空项目 `WelcomeCanvas`（拖放上传区）；阶段交接提示 `HandoffTip` | — |
| 分集视图 | 三栏：集目录（可键盘排序）+ 原文（切自整本源文的码位偏移范围展示）+ 方案栏（AI 分集方案、重规划候选、新旧对比标记、影响确认对话框、补缺按钮） | 手动切分工具条、删除/移动集、外部变更提示、未登记文件管理、上传/新建弹层；长原文/多集分栏各自滚动 | — |
| 集页（核心创作面） | 页头：可编辑集名 + 制作进度入口；视图 tab + 当前视图批量动作一行（脚本规划/分镜或视频单元/多宫格/剪辑/故事设定）；分镜视图 `ShotSplitView`：左 `ShotList`（可收起为序号列）+ 右 `ShotDetail`（引用区→结构化提示词字段网格→台词/画外音编辑器→对应原文高亮；媒体栏：分镜图+视频卡、生成按钮、版本历史、尾帧选图器、时长弹层、备注抽屉） | 未保存时生成按钮变「保存并生成」；J/K 切换分镜（有未保存先询问）；键盘排序分镜（500 镜压力流畅）；批量出图对话框、生成路线卡；多宫格视图按章节切分点分组、超 9 格自动拆多张、「未切分」状态可见；版本时间机器（预览旧版本/回滚） | — |
| 剪辑视图 `EditTimelineView` | **播放器在左、详情栏在右、轨道横跨底部**；整视图不滚动只有详情栏滚；多条剪辑时间线切换 | 出片对话框（成片渲染/剪映草稿选项，TTS 项目选项最多；成片过时以「重新渲染」为主动作）；问题列表（压力 40+ 条）、未使用视频单元统计、BGM 轨上传；旁白/BGM 对齐全局时钟 | — |
| 资产画廊 + 详情 Sheet | 工具栏（筛选、批量生成资产图、新增）+ 卡片网格（按画布宽度加列）；右侧详情 Sheet 四类共用：头部改名 + 上一个/下一个，正文按类型字段区块 | 底部未保存内联提示条；角色衍生区块（逐条行内保存外观变化）；删除被多集引用的资产：影响清单滚动、按钮留视野；大图查看 ←/→ 仅在有资产图间切换；版本条横向滚动；全局资产库滚动到底自动加载、「从资产库导入/加入资产库」预览对话框 | — |
| 全局设置 `/app/settings`（12 分区） | `PageShell` + 分区导航；返回按钮回进入前位置；配置问题按分区归属显示（侧栏分区标记 + 就地提示，**不做全局横幅**） | providers 全出血主从（预置\|自定义 Tab、能力覆盖、模型 Sheet 价格/参数/时长档）；default-models 覆盖来源徽标；endpoints 含端点测试；访问令牌**一次性展示**；usage（KPI/趋势/构成/需要关注/记录表/详情弹窗）；prompt-templates（按创作类型筛选、片段被哪些模版引用） | 通用分区主题浅/深/跟随系统、无保存栏（e2e 断言） |
| 工作流面板 `WorkflowPanel` | 制作计划步骤视图：每步现状/可执行操作/涉及产物/问题 + 问题清单（阻断/警告）+ 批量准入摘要 + 过期产物列表 + 任务 chips | 动作闭集 33 个 `WORKFLOW_ACTION_TYPES`（与后端同步，缺译文测试红） | — |
| 全局反馈件 | `ToastOverlay`（z 层：弹层 50 < toast 60 < 引导 10000）、`LoadingState`（`role=status aria-live=polite`）、`InlineWarning`（`role=alert`，只说明后果+一条修正路径）、任务失败监听、迁移报告通知、chunk 加载失败整页提示 | 空/错状态：`Empty` 族；长错误可滚动、按钮留视口；「费用拿不到完整数字」解释型空态（列原因+行动链接） | — |

视觉体系【源码】：shadcn 语义 token 全 oklch，品牌紫只留 primary 一个基色（浅/深两值），浅底/描边用透明度修饰；语义色 destructive 红 / warn 琥珀（警告/过期）/ good 绿；文字三档对比度 >5:1；输入描边 ≥3:1（WCAG 1.4.11 注释）；媒体类型色（image 蓝/video 紫/text 绿/audio 琥珀）、资产类型色、每集身份色（固定明度 0.52 保 4.5:1）；弹层「不透明 surface + 一条 border + 一个 overlay 阴影，不用模糊与渐变」；动效一律 <300ms（fast 150/base 200）；主题防闪烁内联脚本；Inter Variable + JetBrains Mono（API Key/URL/数值强制 mono）+ Instrument Serif（海报装饰标题）；响应式唯一断点 xl=1280 + 容器查询，业务组件视口断点被 ESLint 拦截；e2e 视口矩阵 1024×600…2560×1440 + 溢出探针；a11y 跑 axe-core WCAG 2.2 AA（含 target-size）。

**局限与反模式**【判断+文档】：① 单管理员无协作/权限，不适合直接当多人 SaaS 底座；② AGPL-3.0 + NOTICE 附加署名条款对闭源商业产品是强 copyleft 风险；③ Agent 运行时绑定 Claude Agent SDK，替代运行时明确 out-of-scope（`.out-of-scope/` 11 篇「有意不做」清单）；④ 生成模式创建后锁定、剪映导出仅中国大陆版（CapCut 未验证）、Windows 沙箱降级；⑤ Docker 部署需特权（seccomp/apparmor unconfined + NET_ADMIN）；⑥ schema v19 + 100+ ADR 复杂度高、恢复语义保守（非续跑任务一律人工重试）带来操作负担。未发现反模式级坏味道，纪律性过强本身是门槛。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | ArcReel 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 产物清单 + 生成依据 + 时效四态 + 服务端权威制作状态 | `GLOSSARY.md`、`docs/adr/0062`、`lib/workflow/workflow_state.py` | **部分**（Go 有 artifact selected/stale；FastAPI Studio 线无 stale；无「制作状态三轴分离」投影） | §5 P0 统一任务中心的读模型 + §5 P1 提示词修订的 stale 联动 |
| 生成前准入 + 报价单（逐单元去向/档位/预计费用） | `lib/generation/batch_admission.py`、`server/routers/cost_estimation.py` | **未见**（仅用量统计，无报价/预估） | §5 P1 渲染前资源/成本预估（P0 级参考源） |
| 任务幂等与恢复 | `lib/db/models/task.py`、`lib/generation/video_resume.py` | **已有**（Go `client_operation_id`、FastAPI `jobs_persist`/`render_reconcile`/`HeldJob` 多层） | **不重做**；仅借鉴「取消仅限排队」「重启不擅自重提」的语义表述进统一任务中心文案 |
| 剪辑时间线多修订 + 成片/剪映双出口 | `lib/edit_timeline/`、`lib/jianying_draft/` | **已有剪映导出**（`jianying_draft.py` toiv_jianying_draft_v1）；EDL 仅 transcript 链 | **不重做剪映**；§5 P2 只补「时间线→EDL/FCPXML 全量多轨」 |
| 供应商任务类型桶（t2i/i2i/i2v/r2v 分层 + 项目级覆盖 + 价目倍率） | `types/project.ts`、`lib/catalog/`、`lib/billing/` | **部分**（模型能力元数据双源并存；无价目/倍率） | 并入 §5 P2 模型能力单源；价目后置 |
| UI 骨架：PageShell 三档 + 容器查询 + 断点守卫；保存栏/离开拦截；顶栏状态条 +「下一步」弹层 | `architecture.md` §3.1/3.5、`ProjectStatusBar` | **部分**（三栏工作台已有；无全局保存栏/离开拦截/「下一步」投影） | §4 横切建议 + §5 P0 |
| Agent 面板交互范式（工序行/子时间线/排队消息/问卷/深链） | `components/copilot/` | **部分**（canvas 有 Agent 入口；无工序行投影） | P2 |
| 多宫格分镜联合图→切分落格 | `lib/script/grid/` | **未见** | P2 一致性管线参考 |
| e2e 工程（录制 fixtures 含 SSE + 截图基线 + axe + 溢出探针） | `frontend/e2e/` | **部分**（`scripts/e2e` 存在） | P2 吸收 fixtures 思路 |

**许可边界**【源码文件事实，非法律意见】：主许可 **GNU AGPL-3.0**（`LICENSE`）；NOTICE 附加条款（AGPLv3 §7(b)）：修改版本须在 UI 显著位置保留 `Powered by ArcReel — https://github.com/ArcReel/ArcReel` 并保留原仓库可见链接、不得歪曲来源；**商标不在授权范围**。第三方：`imageio-ffmpeg` 再分发的 FFmpeg 含 GPL 组件（Linux/Windows 构建 GPL-3.0-or-later）；思源黑体 CN Bold SIL OFL 1.1。商业双轨：`support@arc-reel.com` 谈商业部署/白标。**结论**：ToIV 若对外提供网络服务不应直接复制其代码（AGPL 网络条款 + 附加署名会被触发）；可借鉴领域概念、状态机、交互模式、API 形状，实现须独立编写。

**运行验证边界**【运行】：`pnpm install` 成功；`pnpm typecheck` 通过；**`pnpm test` 3950 用例全部通过**（297 文件）；Playwright 页面区域 e2e **105 用例通过**（1440×900，两批 41+64，含 `toHaveScreenshot` 官方基线比对，覆盖大厅/概览/分镜详情/工作区外壳/剪辑视图/全局设置/资产画廊/使用记录/分集/Agent 消息/新建向导）。**未实机验证**：后端 pytest/uv（避免重型依赖与 DB 初始化）、真实模型生成、Docker 部署；e2e 全部走录制 API fixtures 不发真实请求；随仓 `docs/assets/screenshots/*.webp` 与 484 张基线未做人工像素审阅（无图片查看工具），但截图比对通过可证渲染与官方基线一致。前端 e2e 无需私有后端即可验证 UI（`support/recorded.ts` + fixtures + SSE 回放）是值得 ToIV 学的验证设计。

**关键源码证据路径**（`ArcReel--ArcReel:` 前缀）：`PRODUCT.md`、`GLOSSARY.md`、`pyproject.toml`、`LICENSE`、`NOTICE`、`website/docs/dev/architecture.md`、`docs/adr/`（0006/0062/0072/0100 等 107 篇）、`lib/project/project_schema.py`、`lib/db/models/task.py`、`lib/generation/batch_admission.py`、`lib/billing/`、`lib/edit_timeline/`、`lib/jianying_draft/`、`lib/final_cut/`、`frontend/src/types/workflow.ts`、`frontend/src/app-routes.ts`、`frontend/src/components/layout/StudioLayout.tsx`、`frontend/src/components/pages/ProjectsPage.tsx`、`frontend/src/pages/lobby/ProjectCard.tsx`、`frontend/src/canvas/timeline/ShotDetail.tsx`、`frontend/src/canvas/edit/EditTimelineView.tsx`、`frontend/src/components/workflow/WorkflowPanel.tsx`、`frontend/src/components/copilot/AgentCopilot.tsx`、`frontend/src/index.css`、`frontend/e2e/support/recorded.ts`、`agent_runtime_profile/`、`.out-of-scope/`。


### 3.3 DramaClaw（dramaclaw/dramaclaw，SuperTale CE「虾导」）——短剧生产领域建模最深的双轨工作台

**定位与核心思路**【文档+源码】：source-available 的 AI 短剧/视觉故事生产线，双面一体：**XiaHua 虾画**（无限节点画布，自由生成/编辑/连接图、视频、音频、3D、脚本）+ **Series 虾集**（流水线：导入小说→规划剧集→写脚本→画分镜/首帧→配音→成片），内置 agent **虾导**跨两者工作（`README.md`）。目标用户：个人创作者、独立工作室、创意工程师，自托管「戏剧工厂」、不锁模型供应商。产品口号级设计决策：**「Canvas and pipeline, not canvas or pipeline」**——画布与流水线共用同一批资产库，画布结果可 commit 回主线（提交到资产库/剧集/导演合成），主线也可 project 投影回画布。

**架构与生成/工作链**【源码】：后端 Python 3.11 + FastAPI（路由前缀 `/api/v1`）+ SQLite + 本地文件（每项目 `state/<user>/<project>/data.db`），无 PG/Redis/Celery（CE）；Docker Compose 三服务 `api/newapi(模型网关)/web`。**Ports & Adapters 六边形架构**：`src/novelvideo/ports/` 定义 auth/tasks/credit_quote/usage/canvas_mutex/media_model_catalog 等 Protocol，CE/EE 双发行同接口注入，核心代码禁 import EE（`scripts/lint_ce_imports.py` 零豁免）。模型全部经 **OpenAI 兼容网关**（官方 RelayClaw 或自带 dramaclaw-gateway = New API fork，实现 DC-Media 契约：媒体角色/参考图/首尾帧→各家原生 API），适配 ComfyUI/MiniMax/Seedance/fal/Kling/即梦/Vertex/Gemini/OpenAI/Suno 等；业务模型按**功能槽位**映射（CHARACTER_BUILD、CONTENT_REWRITER、EPISODE_*_PLANNER、IDENTITY_PLANNER_*、SCREENPLAY_NORMALIZER、SEEDANCE2_PROMPT_COMPOSER、STYLE_ANALYZER、HERMES 等 20+ 槽位）+ 媒体模型能力目录（参考图/视频/音频上限、时长/分辨率/档位）。生成链十步（虾料导入 → 虾镜规划 → 脚本（literal/adaptive/staged + 评审-修复循环）→ Beat 拆分 → 草图计划（beats→grids）→ 多版本宫格草图 → 图片池选图 → 渲染网格首帧 → 视频生成（`video_mode`/首尾帧/镜头运动模板）→ 音频（旁白/对白分离、IndexTTS2 情绪 TTS）→ 合成导出（就绪门禁→拼接→MP4/SRT/ZIP））。**Beat（镜头节拍）是生产原子单元**，带 `source_text_sha256`（防止把用户改过的镜头误当 AI 原始结果重新对齐）。质量体系 24+ 文件：VLM 一致性校验、连续性校验、草图视觉门/评分/对比、失败模式库 + 收敛轮次、渲染身份守护。

**最突出的优势**：

1. **画布 + 流水线双轨同资产库**：commit/projection 双向搬运 + 影响预览；`FreezoneCanvasHost` 常驻保活（跨路由不重建画布，350 节点画布重建耗时实测 3148ms→1547ms）。
2. **短剧领域深度建模**：一角色多**身份（Identity）**（面部提示词/外观关键词/服装参考图/年龄变体/每集变体，身份图 + 面部特写分离生成）+ 场景基底-变体 + 道具归属 + 草图宫格/图片池/渲染计划 + 质检门。这是把「生成」变成「生产」的关键。
3. **模型中立 + 自带网关 + 单机自托管**：`docker compose up` 即起，数据全落本地；计费以服务端 ffprobe 实测时长为准（`video_billing.py`），不信任浏览器上报。
4. **Agent 与工作台一体化且可外接**：虾导可规划并执行画布工作流（草稿/确认/失败恢复）；Skill/Recipe 可导入导出分享（README 声明 11 skill + 60 recipe）；`agent-kit/` + stdio MCP 让 Codex/Claude Code 复用同套能力。
5. **工程与设计治理**：后端 452 测试文件（含契约测试 M01-M09）+ 前端 556 文件 4877 用例实测全绿；CI 守栏（ee-terms/ce-import-lint/gitleaks）；SBOM/REUSE/license-inventory；`DESIGN.md` 为 `index.css` 机读镜像 + lint 准入。

**UI 信息架构与逐页/逐区域设计参考**【源码 JSX + i18n 全量键值交叉核对；标注实测者为浏览器所见】：全局壳 `_app.tsx`：顶部 Header（项目切换 + SlidingTabs 分区导航 + 设置/通知/账户/积分徽章/区域徽章），**底部常驻 TaskStatusBar + TaskPanel**；项目内两模式导航 `xiaji`（虾料/虾塘/虾镜/虾导/虾格）与 `xiahua`（虾画）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| `/login`、`/download`【实测 download】 | 登录：cinematic 落地（海报墙 + 光线 + 登录卡 + 区域选择）；下载页：暗色海报式 hero「开启你的创作宇宙 / MAKE YOUR OWN DC」+ 一句话流程图 + macOS/Windows 平台卡 | macOS 卡检测当前系统打「你的系统」锈橙标签；SHA512 校验和行、GitHub star 徽章、更新日志 | 登录/下载页是 `DESIGN.md` 唯一允许脱离产品 token 的例外区（Geist 字体、营销渐变、700ms 进场），仍锁暗色、WCAG AA、禁横向滚动 |
| `/` 项目管理中心 | hero 卡 +「新建项目」；项目卡为**文件夹样式**（名称首字母渐变封面） | 操作：打开、打开虾画、归档/取消、删除/恢复/彻底删除、分享；状态筛选 active/archived/deleted；`editedAgo` 相对时间、集数徽标、归属标签 | 空态「开启你的第一个故事 / 创建项目以开始撰写剧本、生成分镜、制作视频」；背景光效仅首页 |
| 虾料 ingest（2429 行） | 双输入 Tab（上传 .txt/.md/.docx 拖放 / 粘贴文本）；「小说结构预览」章节表 + 分场正文 + 场景头校验三态；统计条（文件名/总字数/计费字数/检测章节/预计集数）；项目设置面板（项目类型导入后锁定、风格、解说风格、节奏、TTS/视频后端、分辨率） | 场景头三态：缺失→编写示例指引；可修复→补齐提示；正常→「共 N 场」；上传进度屏「上传完成前请勿离开本页面」；导入日志可停止；重新导入确认（警示重建图谱）；图谱加载失败降级文案「图谱数据仍然保留，可以稍后重试」 | — |
| 虾塘 characters（3439 行） | 资产 Tab：角色/场景/道具/旁白音；搜索 + 主角/配角/反派筛选 + 批量生成头像 + 统计条；角色详情抽屉：基础信息（含**面部提示词**）→ 身份列表（身份图、面部特写、服装参考图、沿用角色设置、生成身份图） | 连续生成确认防滥用（第 3 次确认、第 5 次需密码）；资产历史任一图可回看/恢复；删除分层确认；声线样本面板；一键「在虾画编辑角色资产」 | 空态「先导入小说，然后点击『自动提取』从图谱中获取角色」 |
| 虾镜 episodes（1147 行） | 顶部统计（总集数/已完成/角色/身份/场景/道具/关键事件）+ 主操作「规划剧集/重新规划」；集卡片摘要「N 行原文 · N 身份 · N 场景 · N 道具」 | 脚本就绪/待生成徽标；身份/场景/道具规划状态与「规划/重规划」按钮；依赖门提示（「请先到角色页从知识图谱构建角色」）；重规划有破坏性确认 | 空态「还没有剧集——先上传小说并导入，再点击『规划剧集』」 |
| 脚本 script（852 行） | 左：原文（只读）+ 行切分预览（行数、最少/最多字校验）；右：beat 预览卡（旁白/对白/画面描述/说话人） | 「生成脚本 / AI 改写 / 停止」；模式标签（literal=一行一个 Beat）；顶部资产规划条（规划、重规划、完成回执「已规划 N 个…」）；保存状态指示器（保存中/已保存/保存失败） | — |
| **Beat 工作台**（949 行 + 30+ 文件） | 可拖拽分栏（「拖动调节左右宽度占比」）；beat 卡网格 + 单 beat 详情面板 + 视图切换；子页签 `?sub=`：文本/草图/渲染/音频/视频（旧路由重定向至此） | 草图计划确认弹窗（「N beats → M 个网格…确认后直接发配草图任务」）；渲染计划弹窗；批量条（「已发配 N 个 beat → 模式」、部分失败反馈、同组运行中去重）；质检 chip、图片池重建索引、手动镜头插入、草图姿态编辑、画幅切换确认（「切换画幅不会拉伸已生成资产…要重新生成」） | 空态「还没有节拍，先生成剧本」 |
| 合成 compose（615 行） | **就绪门禁**：未就绪镜头清单（「还有 N 个镜头未就绪 / 缺失：…」）；参数区（镜头数/预估时长/分辨率/字幕开关） | 补齐前不允许合成；「合成剧集」确认弹窗带预估拼接耗时；完成后下载视频/导出 SRT/导出 ZIP/重新合成 | 空态「没有视频片段可供合成→先完成本集镜头的视频生成」 |
| 任务中心（虾条 + 全局） | 底部 **TaskStatusBar**（当前任务进度、相对时间、**流健康色点** connected 绿/reconnecting 黄/failed 红/connecting 灰、区域徽章、版本号）+ **TaskPanel** 抽屉（列表/详情/日志/批量进度/取消全部） | SSE 订阅 + 轮询降级；lane 三层并发限流（项目/用户/全局 × default/video/world/ffmpeg）；队列满 8 级文案；错误分类：内容策略拦截/限流/额度不足/计费未配置（「需配置」徽标）/provider 未配置（→去设置）；生成失败带 requestId 可复制报障、「已等待 N 分钟还没有结果」 | 【判断】全站信息密度与状态反馈最完整的范本 |
| 虾导 assistant | `superchat-panel.tsx`（16907 行）：会话侧栏 + 聊天时间线（文本+媒体卡+任务状态条）+ Director 运行模式 + **工作流草稿续接**（变更摘要/参考图/确认执行/确认并运行/取消） | 画布命令校验与执行旁白、节点建议菜单、连接态（connected/connecting/reconnecting/disconnected）、格式检查、清空/删除会话确认 | — |
| 虾画 freezone | `FreezoneShell.tsx`（3805 行）：画布 Tab 栏（多画布）、大纲、小地图+视图书签、快捷条、快捷键面板、LOD 渲染、吸附对齐、多选/分组、修订历史恢复、单画布锁定、素材库面板、生成历史、FPS 计 | 节点工具条（AI 编辑/全景/导演世界/打光/高清化/扩图/重绘/擦除/抠图/旋转…）；**提交/投影双轨**（提交到资产库/剧集/导演合成 + 影响预览回执；主线投影同步/移除）；保存冲突弹窗（「画布已被其他窗口或用户修改：刷新会丢弃本地未保存修改，另存为副本会保留」，可下载本地 JSON 快照）；云端备份状态条（「云端备份中/失败，本地修改已保存」） | — |
| 设置（全局对话框 6449 行） | 分区：通用/外观（明暗/色温/强调色/圆角档位）/实验/**密钥**（「已保存 · ••••」占位防泄漏）/**模型与渠道**（官方/自定义/混合；业务模型 20+ 槽位表；媒体模型目录；Embedding 维度绑定；ComfyUI Workflow JSON 管理；推荐配置一键应用）/图床/价格（节点价显示、币种、汇率）/Skills/Recipes/Codex 桥接/关于 | **「未配置影响提示」**：媒体存储未配置则明确列出哪些功能会失败 | 【判断】运维 UX 范本 |

视觉系统【源码 `DESIGN.md`】：定位「仪表盘，不是海报」；暗色优先、信息密集（12px 主力字号、4–8px 间距）、一屏一个高饱和元素；双色板并存（画布色板 bg `#0a0c12`/accent 蓝 `#5ba0ff` 与 shadcn 语义色 primary 电光青 `#00bdcf`）——自述为历史遗留；状态色 destructive `#ea4335`/success `#51bf6f`/warning `#efa831`；Inter + Noto Sans SC 回退、CJK 禁负字距；形状签名：胶囊 `rounded-full`（安静按钮/chip/筛选器）+ 柔和矩形容器（字段 12px/节点 14px/面板 16px/抽屉 20px）；近黑底半透明玻璃 4 级；焦点发光 ring 不用阴影；动效 150/220/320ms `ease-out-quint` 禁 bounce/elastic；a11y 目标 WCAG AA，**4 处对比度欠账被写成「债务不是先例」**（chip 3.83:1 等）；治理：`npx @google/design.md lint DESIGN.md` 0 errors 准入，CSS 变量改动必须同 commit 更新 DESIGN.md。响应式：桌面优先（h-dvh、可拖拽面板、右键菜单、快捷键面板），`sm:` 断点适配；移动端另有桌面壳形态（二进制经 GitHub Releases 分发）。

**局限与反模式**：① 许可限制（ELv2，见下）；② 巨型单体文件（16907/6449/3805/3196 行）可维护性差；③ 前端包体大（主 chunk 2.9MB gzip 854KB、画布 2.48MB，构建警告实测）；④ 设计债自认（双强调色 + 4 处对比度欠账）；⑤ CE=单机单用户，多租户/RBAC/计费在闭源 EE，UI 中积分/支付界面靠 product-surfaces 开关；⑥ Agent 沙箱有 AGENTS.md 自认未闭合项（Linux 默认不启用、peer-read 隔离、出网白名单）；⑦ 配置门槛高（20+ 槽位 + 媒体目录 + Embedding 绑定）；⑧ README 宣传口径需打折（竞品表单方声明、部分特性 closed beta）。

**ToIV 借鉴映射**（对照 toiv-current-audit；注意 third_party/README 记载 dramaclaw 设计已被 ToIV 部分采纳：scene_asset/character_asset「设计采纳，变体/锚点深融合未完」）：

| 借鉴点 | DramaClaw 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 身份（Identity）数据模型（面部提示词/服装参考/年龄与每集变体） | `models.CharacterIdentity`、`characters` 表 `identities_json` | **部分**（character-sheet 三视图族、场景锚点/变体已采纳；「身份/服装变体」层级未深融合） | 继续推进变体/锚点深融合（P1），映射到角色设定卡与跨集对账 |
| 合成前就绪门禁（缺素材镜头清单→补齐→才合成） | `episode/compose-gate.tsx` | **部分**（assemble 无统一门禁面） | §5 P1 渲染前资源/成本预估同页合并门禁 |
| 服务端权威计费（ffprobe 实测时长） | `video_billing.py` | **部分**（仅用量计数） | 计费后置；预估先行（§5 P1） |
| Beat 工作台交互（卡网格+宫格+批量条+质检 chip） | `components/episode/beat-workbench/*` | **部分**（drama-shot-board 三投影已有列表/看板/流水线） | 不重做布局骨架；补质检 chip 与批量部分失败反馈 |
| 任务中心范式（lane 限流三层、SSE+轮询降级、状态栏、错误分类文案） | `task_backend/limits.py`、`task-center/*` | **部分**（队列 dock 4s 轮询；无 lane 限流暴露） | §5 P0 统一任务中心（错误分类文案可直接吸收） |
| 画布↔主线 commit/projection 双向 + 影响预览 | `freezone/commit/`、`projections.ts` | **部分**（canvas 与 Studio 双壳并存，无 commit/projection 语义） | P1/P2 Studio↔Canvas 资产往返 |
| DESIGN.md 治理（token 机读镜像 + lint + 欠账清单 + 例外区白名单） | `DESIGN.md` | **未见**统一设计治理文档 | P2 设计系统文档化 |
| 导入结构校验 UX（场景头三态 + 修复示例） | `ingest.sceneHeaders.*` | **部分**（SVML 导入已有 parse job） | 并入 §5 P0 跨集对账与导入诊断提示 |
| 媒体模型能力目录（能力 JSON/参考上限/档位） | `ports/media_model_catalog.py` | **部分**（双源能力元数据） | §5 P2 模型能力单源 |
| 「未配置影响提示」设置 UX | `settings.mediaStorage.notConfiguredImpact` | **未见** | §4 空载错横切 |

**许可边界**【源码文件事实，非法律意见】：**Elastic License 2.0（ELv2）**，全文 `LICENSES/Elastic-2.0.txt`（根目录无 `LICENSE`，`NOTICE` 的 "See LICENSE" 为悬空引用）；`REUSE.toml` 聚合标注 `Elastic-2.0 / 2026 SuperTale contributors`。ELv2 核心限制：可自托管/修改/构建交付客户，**不得将软件本身作为 hosted/managed service 提供给第三方**（转售 SaaS 需商业授权）；不得移除许可/版权/品牌声明。品牌：README 要求 UI 角落保留「Powered by DramaClaw」，NOTICE 明确商标不随许可授予。第三方：edge-tts **LGPL-3.0-only**、certifi MPL-2.0、sharp（CE 镜像不得捆绑 Apple 模型权重）等（`license-inventory.csv`、`sbom.spdx.json`）。**结论**：ToIV 的 SaaS 形态（toiv.wineryz.top 对外服务）与 ELv2「不得托管服务」条款直接张力 + 品牌归因义务 → **默认不复制源码**，只做架构/交互思路借鉴并独立实现；如确需片段须逐文件核对许可清单并走法务。

**运行验证边界**【实测】：前端 `pnpm install --frozen-lockfile` 成功；`pnpm build`（tsc + vite）31.3s 通过（0 TS 错误；Rollup 警告 chunk 过大）；**`pnpm test` 556 文件 / 4877 用例全部通过**（61s）；`pnpm preview :5310` + Chrome 实机打开 `/download` 落地页渲染正常（与 DESIGN.md 例外区描述一致）。**未实机验证**：后端（`uv sync` 两次失败——`openai-codex` git 依赖访问 github.com 超时），因此后端 API、后端 pytest、登录后的虾画/虾塘/虾镜工作台均只有静态审查 + i18n 全量键值 + 官方截图图注为证据；随仓截图未逐像素查看；竞品对比表未独立核对。

**关键源码证据路径**（`dramaclaw--dramaclaw:` 前缀）：`README.md`、`AGENTS.md`、`DESIGN.md`、`docs/en/concepts/architecture.md`、`docs/en/concepts/features.md`、`docs/episode-asset-planning.md`、`docs/long-novel-import.md`、`src/novelvideo/sqlite_store.py`、`src/novelvideo/models.py`、`src/novelvideo/task_state.py`、`src/novelvideo/task_backend/limits.py`、`src/novelvideo/video_billing.py`、`src/novelvideo/verification/`、`src/novelvideo/chat/`、`frontend/src/routeTree.gen.ts`、`frontend/src/routes/_app.tsx`、`frontend/src/components/episode/beat-workbench/`、`frontend/src/features/freezone/FreezoneShell.tsx`、`frontend/src/features/superchat/superchat-panel.tsx`、`frontend/src/components/settings/settings-dialog.tsx`、`frontend/public/locales/zh/translation.json`、`LICENSES/Elastic-2.0.txt`、`NOTICE`、`license-inventory.csv`、`docker-compose.yml`。


### 3.4 AID Studio（gzxx-2025/aid-studio）——自托管 AI 漫剧/短剧工厂（模型能力与计费编排标杆）

**定位与核心思路**【文档】：开源自托管的 **AI 动态漫/短剧/电影/静态漫画** 创作平台，端到端「剧本 → 分镜 → 图 → 视频 → 配音 → 成片」；三大创作方向（漫剧/短剧、电影/短片、漫画）。用户端首页是免登录公开案例广场，作品/资产/账单/邀请为登录区；自带模型 Key、可换供应商、带计费/充值/审核/在线升级的完整 SaaS 底座。与 ToIV「短剧创作平台」定位高度同构（判断）。赞助商为秘塔科技，个人/小团队开源运营痕迹明显。

**架构与生成/工作链**【源码】：后端 Java 17 + Spring Boot 3.5 + MyBatis-Plus + MySQL 5.7 + Redis/Redisson + Quartz（RocketMQ 可选），Maven 模块 aid-admin / aid-common / aid-business-{framework,system,main,quartz} / aid-interface-{core,system,main} / aid-consumer / deploy/updater（Go 升级器）；用户端 Next.js 16 + React 19 + AntD 6 + Tailwind 4 + @xyflow/react 画布；管理端 Vite + React 18 + AntD 5（RuoYi 式）。调用链 `Controller → Service → Mapper → MySQL`，媒体生成经统一编排（`MediaGenerationServiceImpl` → `TaskDispatchServiceImpl`）。数据模型（`sql/aid-init.sql` 约 1.1 万行 100+ 表）：项目（`aid_comic_project`，含七步 current_step、审核状态机、发布/复制位）→ 剧集 → 剧本版本 → 资产（角色/道具/场景 × 形态 × 图，`aid_role_prop_scene*`，含 `expected_appearances` 子形象、`available_slots` 站位）→ 音色绑定 → 场次（时空坐标）→ 分镜（`aid_storyboard`：script_params 景别/运镜/构图/氛围 JSON、image_prompt 分镜画师输出、video_prompt 视觉导演输出、grid_type、final_image/video/audio_id 四选一）→ 批次/镜头组计划 → 媒体任务（`aid_media_task`：dispatch_mode、request_hash/idempotency_key、计费三态快照、上游三时刻）→ 成片时间线 → 发布不可变快照（SHA-256 content_hash）+ 幂等复制 fork。生成思路：**智能体提示词契约化**——27 个 agent 落 DB（`aid_agent.prompt_content`），输入 `{xxx}` 占位符注入、输出 JSON 契约「一个字符不能改」、解析失败判「模型格式异常」作废；分镜脚本「剧本文本直驱 + 场景资产归组」（shot 标准版 21 字段）；批量视频提示词以 `--- 镜头 SB-分镜ID ---` 切段回传 `shotKey` 双射校验；跨镜连续性 `video_prompt_continuity_v1`（ROOT/EXTERNAL_PREVIOUS/BATCH_PREVIOUS，只继承「持续可见状态」，previousPrompt 视为不可信文本防注入）；参考图私有标记 `@图片N[名称]` 由 Provider 层装配，禁止模型输出 URL/Base64。Provider 40+ 厂商实现（OpenAI 兼容/DeepSeek/Gemini/百炼/即梦/Kling/MiniMax/Vidu/火山/阿里 IMS/腾讯 CI·MPS·ASR/Topaz/万相/WaveSpeed…）+ **可配置异步协议**（免写新类接入「提交返回 task_id + 查询」型）。计费三阶段 prepareBilling（预冻结）/settleBilling/refundBilling，`billing_snapshot_json` 不可变；报价接口与正式提交共用解析口径（只读报价不建任务不冻结）。

**最突出的优势**：

1. **统一任务 + 计费 + 调度编排层**：`aid_media_task` 一张表 + 三态调度（DIRECT/CALLBACK_FIRST/POLL_ONLY）+ 回调/轮询双通道 + 补偿对账（5/10/20/30s 退避、排队拉起、OSS 落盘 `oss_pending`、计费中间态重试）+「查询异常 ≠ 生成失败」+ 停止后迟到结果不回写。新增供应商只写协议适配器（文档明确禁止平行任务表）。
2. **模型能力显式声明 + 调用前强校验**：`supports_*` 能力位 + `capability_json` 白名单 + `param_mapping_json` 请求映射 + 能力位防覆盖哨兵；用户端所有分辨率/时长/比例/参考图数量选项由能力驱动，**超限在报价前拒绝、不提交厂商**；能力证据文化「官方目录没有的能力不要靠猜测补上」（每协议 PR 附官方文档 URL 与「已表达/部分表达/待核验」台账）。
3. **智能体提示词契约化**（上述 27 agent + Skill 版本化（`aid_skill` 不可变版本 + config_hash + 思考预算 reasoning_budget_tokens）+ 人机输入请求/响应事件流）。
4. **产品级自托管交付**：一键安装（Docker/systemd）、12 位随机 admin 入口码、HTTPS、备份/回滚/在线源码升级（Ed25519 签名清单 + 失败自动回滚 + `sudo aid progress` 实时日志）。
5. **创作域建模完整**：一致性（项目风格快照、角色形态多图含四视图/白底/多机位九宫格、跨镜连续性）+ 成本治理（供应商成本台账与余额告警）+ 发布快照 fork 闭环。

**UI 信息架构与逐页/逐区域设计参考**【源码 + next build 22 路由清单 + HTML 抓取；截图未像素核对】：

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| 全局基线 | 全站暗色 antd `darkAlgorithm`；主色/信息青 `#00abd8`、链接 `#4ae7fd`、页面底 `#060a12`、容器 `#191a1d`、描边青色半透明 | Message/Notification zIndex 20000（高于视频预览 Portal） | px→rem（rootValue 16）；`≤1600×900` 降根字号 14px（多套断点 CSS，文件名即断点）；UA 判定强制跳 `/mobile` 提示页（SSR 重定向）；导航带 `aria-label`、装饰网格 `aria-hidden`；未见系统性 focus-trap（依赖 antd 默认） |
| `/` 首页 = 案例广场 | 左侧边栏 HomeNewShell + 内容区：搜索框（防抖 250ms）、筛选 Tab（全部/电影·短片/电视剧集）、公开作品卡片列表（pageSize 24） | loading/error 态（无后端「案例列表加载失败，请稍后重试」）；未登录点「创作」弹登录弹窗（`requireLogin`） | 空态专用插画 + 引导按钮 |
| 七步创作流程条（`/create/*` 主入口） | `CreateFlowShell`：椭圆节点+连接线 SVG 步骤条（`global-setting → story-script → scene-character → storyboard-script → storyboard-video → dubbing → preview`），每步 nor/sel 双态图 + completed/pending/disabled/active、生成中转圈；工具栏：返回、作品标题内联编辑（自适应测量宽度）、剧集分集列表、**全局任务浮层**（任务停止/重启/续生 + **重启前费用报价**）、项目生成配置、保存草稿、预览步导出下拉 | 步骤点击带门禁 `isPillDisabled`；剧集流程先上传整部→解析分集→逐集进七步（此二页隐藏步骤条） | — |
| 剧本步 story-script | 左右分栏：Quill 富文本剧本（电影/剧集不同字数上限）+ **AI 剧本助手会话面板**（对话流、思考过程展示、停止分隔线、SkillPicker、模型选择器、输入请求卡片） | 选区引用改写（替换区间校验）；本地快照冲突恢复弹窗（「发现未同步的剧本…」）；自动保存 + 版本另存 + 正文哈希基线 | — |
| 素材步 scene-character（528 行 + 20+ hook） | 三 Tab 场景/角色/道具；资产卡片含形态管理（多形象）、多图（生成/上传/官方图、is_use 主图、拆分图） | 智能提取走 SSE（scene→character→prop 联动 Tab）可停止；ExtractAgentModal 单列提取；图片编辑弹窗；音色绑定（音色选择/参考音频）；任务进度/恢复 hook | 空态插画 +「自动提取」引导 |
| 分镜设计 storyboard-script（806 行） | 列表/卡片双视图切换；分镜卡片（分镜剧本、台词、脚本参数、分镜图 image_prompt） | 批量生成弹窗、单镜生成面板、九宫格生成面板、脚本修改弹窗、参数设置弹窗、生成 SSE 实时文本、任务停止/续生+费用、引导 tooltip「修改分镜脚本」 | 空态 empty-fj.svg |
| 视频生成 storyboard-video（799 行） | 分镜视频面板（选片 final_video_id、多参数生成 modal——分辨率/时长/比例受模型能力约束）、右侧生成可选参考素材、批量生成、超分 Popover、截帧取参考（胶片条 filmstrip） | i2v/首尾帧/多参（creation_mode）；跳回分镜脚本 | — |
| 音画同步 dubbing（586 行） | 逐镜配音卡片（台词→TTS、音色选择、语速/音调/情感覆盖、参考音频）、批量重配、BGM 选曲、对口型、左右面板 | — | — |
| 成品预览 preview | **多轨时间线**（TimelineTracks：视频轨/配音轨/BGM/字幕轨，播放/循环、画布渲染、联动编辑） | 分辨率导出（FHD 等、随导出提交 timelineJson）、分段导出/ZIP、跨域媒体代理下载 | — |
| `/create/studio` 工作流画布（第二入口） | @xyflow/react 无限画布：节点卡（kind: text/image/video/voice，媒体填充、状态徽章、能量边）、左栏（资产画廊/系列拆分向导/交付面板）、右栏（任务列表/充值）、顶栏；节点内 Composer 对话坞（模型选择、参数 Popover、**计费发送按钮**）、右键菜单、自动管线横幅 | 无 projectId 时空态警示 +「返回我的作品」 | — |
| 管理端 admin（亮色 RuoYi 式） | 侧栏菜单+顶栏+标签页，路由动态下发；看板图表、AI 模型与供应商（ModelTable/ProviderPanel/**能力编辑** CapabilityEditor/ParamMappingEditor/SKU 编辑/计费路由/模型池绑定/迁移/TokenDance OAuth/NewApi 账号/供应商余额）、编排（模型池/智能体/策略矩阵）、Skill 管理、创作内容管理、运营（审核/发布/模型健康/错误规则+规则测试器/支付/音色工作台）、平台配置（分区式长表单）、在线升级（发布说明/回滚/Nginx）、监控、系统管理 | 登录页特性卡片动效 + 验证码；入口受 12 位随机 access_code 保护 | antd5 亮色 `defaultAlgorithm`（底 `#f5f7fb`），与用户端暗色青不同源 |

空态/错误：无后端时案例区显示加载失败文案；空态有专用插画 + 引导按钮（如素材页「自动提取」）。

**局限与反模式**：① **HEAD 单测有 4 条失败**（`optionalReferenceGeneration.test.ts`，ctx 方法缺失），提交前未跑绿；后端 0 单测（CONTRIBUTING 明确「打包本身不构成行为证据」，社区靠 PR 复现验证）；② 超大组件与超大 SQL（拆分前 1.2 万行组件自述、`aid-init.sql` 1.1 万行单文件、`deploy/aid.sh` 9580 行）；③ RuoYi 遗留与漂移（README 架构图含不存在的 business-generator、ruoyi.scss 遗留、历史兼容字段）；④ 计费/支付/充值/实名/邀请返佣使其像商用 SaaS 底座，合规责任在部署方，计价倍率机制有商业争议风险（判断）；⑤ 移动端仅提示页，创作体验桌面-only；⑥ 官方素材包不在源码仓、部分能力依赖腾讯/阿里云专有服务。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | AID 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 模型能力声明 + 报价前强校验（能力位/capability_json/param_mapping/能力台账「不猜上限」） | `sql/aid-init.sql`、`doc/公开Provider接入指南.md` | **部分**（双源能力元数据并存，无调用前强校验统一面） | §5 P2 模型能力单源 + §5 P1 预估页的能力校验 |
| 统一媒体任务表 + 三态调度 + 补偿对账（上游三时刻 upstream_accept/last_progress/terminal） | `aid_media_task` 表、`TaskDispatchServiceImpl` | **部分**（任务幂等/自愈已有；无统一任务读模型） | §5 P0 统一任务中心（P-18b 孤儿问题可参考三时刻设计）**不重做幂等** |
| 生成产物四选一 final_* + 批次/镜头组幂等（biz_seq、retry_round、shotKey 双射） | `aid_storyboard`、`aid_storyboard_batch` | **已有**（多候选 pick、任务幂等） | **不重做**；仅借鉴 shotKey 双射的批量回写校验思路 |
| 智能体/提示词契约化（prompt 落库、JSON 契约、Skill 版本、思考预算） | `aid_agent`/`aid_skill` 表、`doc/提示词开发指南.md` | **部分**（prompt 模板/版本树分散） | §5 P1 用户配方库 + Studio 提示词修订（契约化落库可参考） |
| 跨镜连续性协议（只继承可见状态、防提示词注入） | `doc/提示词开发指南.md` 连续性节 | **部分**（有 keyframe_chain/outfit_state/shot_leak 治理） | 参考其「只继承可见状态/禁止继承台词口型」规则完善 shot_leak 治理 |
| 发布不可变快照 + 幂等复制 fork | `aid_project_publish_snapshot` | **未见**（有 boards export） | P2 作品发布/模板 fork |
| 每步费用报价前置 + 预冻结/结算/退款快照 | `IMediaBillingService` 三阶段 | **未见**（仅用量） | §5 P1 渲染前成本预估（报价与提交同口径防超扣） |
| 随机 admin 入口码 + 配置确认后才初始化 | `deploy/README.md` | **未见** | P3 运维加固 |

**许可边界**【源码文件事实，非法律意见】：**MIT License**（`LICENSE`，`Copyright (c) 2026 光子讯息(杭州)科技有限公司`），可免费使用/修改/合并/发布/再销售，须保留版权与许可声明。`NOTICE` 含 **RuoYi-Vue（MIT）** 归属（管理框架基于它）。并码注意：① MIT 允许并入 ToIV，但交付物须保留 LICENSE 与 NOTICE（含 RuoYi 版权行）；② npm/maven 依赖各自许可需合规扫描；③ **官方素材包（`aid-official-assets_*`）不在 MIT 源码许可范围**（未随仓声明许可），不得随代码复用；④ 品牌「AID Studio / 视觉·AID」与赞赏码/赞助链接不属许可授予范围，复用 UI 应去品牌素材；⑤ `aid_agent.prompt_content` 初始化数据随 MIT SQL 发布，运营侧提示词需自行核对。**这是 13 个项目里对 ToIV 并码限制最少的一个**（但仍须做依赖与素材合规）。

**运行验证边界**【实测】：`frontend/web` `npm ci` 成功（npm 10.9.4）；`npm run check` = typecheck 通过 + **vitest 90 文件 405 用例中 4 条失败（401 过）**——该 commit 自带单测是红的；`npm run build`（Next 16）成功，22 条 App Router 路由全部静态预渲染；`next start :39217` + Playwright 截图 3 张（桌面首页、/works、iPhone 13 移动首页）HTTP 200（截图未像素核对）；抓预渲染 HTML 验证信息架构（站点标题「视觉·AID」）。**未实机验证**：后端 Java 编译/启动（需 MySQL 5.7 + Redis）、admin 前端、真实模型调用、支付/登录链路；`references/` 官方截图未目视核对。

**关键源码证据路径**（`gzxx-2025--aid-studio:` 前缀）：`README.md`、`LICENSE`、`NOTICE`、`CONTRIBUTING.md`、`sql/aid-init.sql`、`sql/v*.sql`、`doc/提示词开发指南.md`、`doc/公开Provider接入指南.md`、`deliverables/official-model-capability-evidence.md`、`aid-interface/aid-interface-main/src/main/java/com/aid/media/provider/`、`.../media/service/impl/MediaGenerationServiceImpl.java`、`TaskDispatchServiceImpl.java`、`frontend/web/app/`、`frontend/web/utils/createFlowRoutes.ts`、`frontend/web/components/steps/`、`frontend/web/components/studio/`、`frontend/web/config/antdTheme.ts`、`frontend/admin/src/views/`、`deploy/README.md`、`deploy/aid.sh`、`deploy/updater/`、`release/latest.json`。


### 3.5 printfilm（yi1108/printfilm）——模板驱动的 AI 漫剧 + 科普短视频平台（任务运行时与制作脚本规范标杆）

**定位与核心思路**【文档】：「把故事做成能播的片子」——模板驱动的 AI 漫剧 + AI 科普/获客短视频创作平台，从文案到成片（FFmpeg 合成），自托管开源 SaaS。目标用户：短剧/漫剧制作者、获客/科普短视频运营、自托管团队。两条产品线（drama 漫剧 / kepu 科普短视频）共用一套生成能力（同一上游、同一任务平台、同一计费）。设计思路【判断】：以「模板 + 分阶段验收」降低 AI 出片不确定性；把可控性（单镜重做、尾帧衔接、资产锁定）放在生成质量之前。

**架构与生成/工作链**【源码】：后端 Python 3.12 + FastAPI + SQLAlchemy async + PostgreSQL + Redis；用户端 React 19 + Vite 8 + @xyflow/react（自研 `pf-*` CSS 体系不用 Tailwind）；管理端 React 19 + Tailwind 4；**任务运行时进程内三件套** scheduler/executor/poller（+watchdog），无 Celery。漫剧链：项目 → 剧本摘要（LLM）→ 分集正文 → 确认单集 → 规则化拆镜 + 资产抽取 → 分镜编辑（@ 引用资产/时长）→ 逐镜生成（Seedance 图生视频，一镜一 TaskRun）→ 合成下载（服务端 FFmpeg 或浏览器端 mp4cat 无损拼接）。层级 `DramaProject → DramaEpisode → DramaEpisodeFragment`（一次 Seedance 调用，自动拆分硬上限 15s）→ `Beat`（@duration 3-12s 段：画面/对白/旁白）；拆镜规则文档化（`docs/EPISODE_RULES.md`、`docs/SHOT_SPLITTING.md`）：对白按 3 字/秒拆段、空镜不口播、规则化拆镜产物自带制作块（`【字幕：底部居中…】【BGM：…】【对白·慢速清晰·同步字幕】`，实测）。科普链状态机 `DRAFT→SCRIPTING→SCRIPT_READY→IMAGING→IMAGE_READY→VIDEOING→VIDEO_READY→AUDIOING→COMPOSING→AUDITING→DONE`，每阶段可单镜重绘/重生视频/重配音。任务平台四表 `task_runs/task_steps/task_targets/task_events`：租约（lease_token/lease_until）、dedupe_key/batch_key/client_request_id、取消、预算、尝试次数、孤儿回收、看门狗心跳软重启、全站与单用户双并发槽位、handler 注册表（drama 7/kepu 6/api 3/studio 2/tools 1 类）。一致性：项目级 `character_bible` + 漫剧资产库（角色三视图设定板 prompt 前缀「纯白背景…正面/左侧面/背面三视图 + 面部特写 + 半身像」）+ 尾帧衔接（`kepu_continuity.py`）+ 镜↔资产引用表 + 资产/镜版本激活。计费：预扣 freeze → `usage_events` → 结算退冻结；优先取上游真实 quota，取不到用保守估价并标 `tokens_estimated`（诚实标记）；钱包与费用看板解耦。上游**锁定 TokenFree 单渠道**（OpenAI 兼容，渠道不可改——对 ToIV 是硬伤反模式）。

**最突出的优势**：

1. **统一任务平台 + 一镜一任务可恢复编排**【源码+实测】：租约/去重/取消/预算/孤儿回收/看门狗全在进程内完成，管理端任务中心可视化运行时健康（「调度器 running · 轮询器 running · 看门狗 running · 最近成功调度：1秒前 · 连续失败 0」）——无需 Celery 就有生产级队列语义。
2. **「下一阶段」单一真相源**：`services/kepu_stages.resolve_kepu_billing_phase()` 同时服务计费预扣与流水线恢复，实测按阶段推进且可中断续跑、单镜重做——计费与恢复两套逻辑不漂移。
3. **分镜/段两层制作脚本模型**：@duration Beat、拆镜硬上限与计费/排队挂钩；**prompt 工程被文档化为产品规范**（EPISODE_RULES 自称单一真相源），产品、prompt、校验三者同源，可迁移性强。
4. **资产库驱动的角色一致性**：角色/场景/道具/音色四类、三视图设定板、镜↔资产引用、资产↔集多对多、版本激活——一致性是数据模型问题而不只是 prompt 问题。
5. **模板驱动产品化 + 计费闭环**：27 个模板（style_prefix/负向词/模型/音频/字幕 config 落库、管理端可改、Premium 标记）；预扣→用量→结算 + 里程碑告警 + 管理端日财务/毛利。

**UI 信息架构与逐页/逐区域设计参考**【实测 + 源码】：全局壳三栏 sticky 顶栏、**无左侧边栏**：左 Logo + PRINTFILM 字标；中「工作台 · 漫剧 · 科普 · 工具 · 资产 · 定价」；右 语言中/EN · GitHub · 帮助 · 头像 · 主 CTA「开始创作」（未登录跳 `/auth?next=`，已登录弹漫剧/科普二选一）。全局浮层：DialogHost、BillingAlertHost（消费里程碑弹窗）、**DramaGenQueuePanel 生成队列（离开页面任务继续）**、微信群 FAB。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| `/` 首页 | 营销+工作台合一：Hero（大标题 + 双 CTA + GitHub 链）→ 双产品大入口卡（漫剧/科普，带步骤 chips）→ 工具入口 → 流程说明 | 实测英文文案完整、无 JS 错误 | 视觉 token（`index.css:1-21`）：主色石灰绿 `--pf-lime:#b6ff00`、墨色 `#111318`、页底 `#f7f8fa`、发丝线 `rgba(17,19,24,0.1)`、圆角 14/10px、顶栏高 64px；Noto Sans SC + Space Grotesk（品牌字标）；**浅色主题 only**；活跃导航 3px 绿色下划线 |
| `/templates` 模板库 | 分类 chips（开源/知识科普/获客/纪录片/写实感/人物故事/电影解说/情感治愈/动漫/国风/科幻/奇幻/悬疑/商业营销/复古/图文）+ 模板卡（名称+结构描述+标签） | 实测 27 个模板 | — |
| `/studio/new` 新建 | 6 步 Stepper（选题→风格→确认分镜→画面与配音→镜头视频→合成预览）+ 模板选择（分类+画幅角标）+ 主题/文案输入 | — | — |
| `/studio/:id/style` 风格配置 | 项目信息（模板锁定画风说明）+ 画幅/风格提示词覆盖 + 音色列表（9+ 预设、性别、**试听**）+ 成片方式（AI 视频=图→视频→配音→合成 / 静图成片=静图+叠字+配音）+ 图像模型选择（Seedream 系列「推荐」角标与计费说明） | — | — |
| `/studio/:id` 分镜工作台（1639 行） | 顶栏（拼接成片/批量调整/推倒重做/打开编辑器）+ Stepper 勾选态 + 素材就绪提示 + 分镜表（时长/旁白/图视频状态） | 单镜重绘/重生视频/重配音；合成/预览/发布；实测合成失败时错误区直接倾倒 ffmpeg 全日志 | — |
| `/studio/:id/editor` 成片编辑器 | 左场景列表（缩略+文案摘要+上下移）+ 中预览播放/导出 + 右 Tab（文案/画面/配音/转场） | 「AI 帮我优化这一镜」「样式设置」「保存文案应用到全部同类镜头」均为 ComingSoon 占位 | — |
| `/drama` 漫剧列表 | 顶部 Tab（我的漫剧项目/资产库/自由画布）+「新建项目」+ 状态筛选 + 搜索 | 空态「还没有项目，用 AI 生剧本或自由画布，创建你的第一部漫剧」 | — |
| `/drama/projects/:id` 项目工作区 | 项目头（标题 + **用量统计「¥1.06 · 生图 0 · 生视频 0 · 调用 1」**）+ 错误横幅（LLM 未配 Key 时显示于页顶）+ 资产库入口 + 分集目录 + 本集面板（本集梗概→拍摄剧本→创作备注三段编辑器、字数统计、时长「2 镜 · 合计 25s」、对白/动作计数、重新生成整集/进入分镜） | — | — |
| `/drama/projects/:id/episodes/:epId` 分集编辑（1931 行） | 顶栏（9:16·480p、视频风格/后期字幕/无介绍叠字/Seedance 2.5/尾帧衔接/AI 重新分镜、完成 n/m 计数）+ 左分集目录 + 左资产面板（本集/全集、角色/场景/道具、新建/导入）+ 中分镜卡 | **@ 提及引用资产/插入时长标签**、每段 3s/5s 时长 chip、【字幕/BGM/对白/旁白】制作块展示、编辑/生成/预览/画布；下「全片合成下载 / 视频待生成 00:00/00:25 / 打开分镜画布 / 字幕板（后期拼接 6 条、导出SRT）」 | — |
| `/drama/.../canvas` 分镜画布/自由画布 | React Flow（EpisodeFragmentNode/EpisodeAssetNode）；自由画布：资产节点 + 缩放 + CanvasTopBar/LeftToolbar/BottomControls/AddMenu + 撤销重做 + 自动保存 | — | — |
| `/settings` / `/pricing` / `/help` | 设置左目录（Profile/Drama/AI Short Video/Tool runs/Assets/Plan & balance/Team(ComingSoon)/API/Notifications(ComingSoon)/Security）+ 右表单卡；定价页按量计费 + 余额卡（可用/本次消耗/冻结/更新时间）+ 支付方式 | 删除账号 ComingSoon | — |
| 管理端（实测登录后） | 左深色侧栏（概览/业务/漫剧/资源/系统）+ 右内容；仪表盘（用户/已付/本月 AI 扣费/上游成本 + 近 7 日卡 + 能力/领域分布图 + 多维筛选）；`/queues` 任务中心（自动刷新 15s、本节点并发 0/4、运行时健康、分领域计数、任务列表）；`/settings`（TokenFree 渠道「上游已锁定」只读、配置就绪状态灯）；`/finance`（按日财务：本地扣费/成本/TOKEN/实际成本/利润） | 「已创建项目需在分镜页恢复模板后才会跟随」等运营提示 | — |

空态/错态实测样本：资产库「该分类暂无资产」、生成失败横幅、合成失败含原始 ffmpeg 日志——三态总体齐全（符合其 `docs/STANDARDS.md`：中文文案、三态 UI、危险操作确认、服务端分页、单文件≤500 行），但**中英混排**与**错误信息粒度失控**是瑕疵【实测+判断】。响应式断点 520/640/700/800/860/1024/1100px，SiteNav 移动抽屉，390px 可渲染；a11y 部分 `aria-label`/`prefers-reduced-motion` 降级，无系统性 focus 工程。i18n 半成品：默认英文下模板库/新建/资产库/空态仍中文【实测】。

**局限与反模式**：① 上游锁定 TokenFree（无法接自有集群）；② 无迁移工具（`create_all` + 手写 schema patch + 要求单 worker）；③ mock/错误面粗糙（`ARK_MOCK` 不 mock LLM，剧本链路照旧失败并把错误直接显示在项目页顶部；compose 失败回传整段 ffmpeg 日志，违反自家 STANDARDS）；④ i18n 半成品；⑤ 测试覆盖不均（后端 860+ vs 前端 8 例 vs 管理端 0 例；HEAD 有 1 个失败用例：旁白改动后期望项目回退 `SCRIPT_READY` 实际 `VIDEO_READY`）；⑥ 占位入口多（`docs/PLACEHOLDER_BACKLOG.md` 台账：文档导入/BGM 曲库/字幕样式/素材库/通知/团队）；⑦ 计费多口径（quota/USD/CNY/分）易抄错；⑧ 大文件（`pipeline.py` 约 2000 行、分集编辑 1931 行）与自定「≤500 行」规范相悖。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | printfilm 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| TaskRun 四表 + 租约调度/去重/取消/孤儿回收/看门狗 + 任务中心运行时健康视图 | `models_tasks.py`、`services/tasks/`、admin `/queues` | **已有**（幂等/自愈多层）；**部分**（无运行时健康可视化） | §5 P0 统一任务中心补「运行时健康」视图**不重做幂等** |
| 「下一阶段」单一真相源同时驱动计费预扣与断点续跑 | `services/kepu_stages.py` | **部分**（渲染有状态机；预估/计费缺失） | §5 P1 预估与阶段判定收敛同一函数 |
| 资产库 + 镜↔资产引用 + 版本激活 + character_bible + 三视图设定板 | `models_drama.py`、`seed_asset_params.py` | **部分**（character-sheet 三视图族已有；镜↔资产版本绑定 Go 域已有，FastAPI 线部分） | 继续变体/锚点深融合；映射 §5 P0 跨集对账的引用底表 |
| 分镜=一次视频任务、Beat(@duration) 制作脚本 + 拆镜规范文档化 | `docs/EPISODE_RULES.md`、`docs/SHOT_SPLITTING.md` | **部分**（词锚拍/reflow-beats 已有；拆镜规范未成文） | 吸收「制作约束块结构化进每镜脚本、生成前可见可编辑可 diff」（§4 分镜卡建议） |
| 模板体系（style_prefix + 模型/音频/字幕 config 落库、管理端可改） | `models.py Template` | **部分**（style_presets/effect_presets/community_recipes 三套并存，均非用户可存） | §5 P1 用户配方库 |
| @ 提及引用资产/时长标签的分镜编辑器交互 + 分集顶栏生成参数 | `EpisodeEditPage.tsx` | **部分** | §4 分镜/镜头卡建议 |
| 浏览器端 mp4cat 无损拼接 + 服务端 FFmpeg 回退 | `lib/composeEpisodeVideoClient.ts` | **未见**（合成走服务端） | P2 快速预览路径省 GPU |
| 计费「预扣→用量→结算」+ `tokens_estimated` 诚实标记 + 钱包与看板解耦 | `services/billing/`、`docs/BILLING.md` | **部分**（仅用量计数） | §5 P1 预估（诚实标记值得抄） |
| DB overlay 配置（后台改模型/Key 即时生效）+ 逻辑模型→渠道 priority/weight/failover | `model_settings.py`、`logical_model_router.py` | **部分**（引擎注册已有多机调度） | §5 P2 模型能力单源时统一路由口径 |
| ComingSoon 台账化治理 | `docs/PLACEHOLDER_BACKLOG.md` | **未见** | P3 工程规范 |

**许可边界**【源码文件事实，非法律意见】：根 `LICENSE` 为 **MIT**（`Copyright (c) 2026 PRINTFILM`，标准 21 行文本），无其它许可文件。允许复制/修改/合并/分发/销售，须保留版权与许可声明。注意：第三方依赖（React/FFmpeg 等）各有许可；上游模型（Seedance/Seedream/Kimi）输出权属与商用条款不在仓库许可覆盖内；`docs/images` 截图与微信社群信息不等于可随意商用。**与 AID Studio 同属对 ToIV 并码限制最少的一档**（仅须保留声明 + 依赖合规）。

**运行验证边界**【实测，本次做得最全的全栈验证之一】：PG16 + Redis7（docker-compose 本地端口）healthy；后端 FastAPI（uv，Python 3.12，**需手动补 `greenlet` 否则 SQLAlchemy async 启动即崩**）+ `ARK_MOCK=true` 启动，`/api/health` ok、task_runtime scheduler/poller/watchdog 全 running；用户端 Vite 200 + 多页 Playwright 截图无 JS 报错；管理端 7 个主页面登录后全部渲染（vite proxy 写死 :8000，用路由改写转 18000）；**后端 pytest 862 passed / 1 failed / 1 skipped**（失败为 HEAD 真实断言漂移：旁白编辑失效状态回退用例）；前端 node:test 8 pass；oxlint 两端 0 errors。**mock 边界（关键产品事实）**：`ARK_MOCK` 只 mock 图/视频/音频（SVG/占位文件），**文字 LLM 无 mock**——剧本/摘要链路无 key 时 TaskRun 失败并把错误文案显示在项目页顶部；科普流水线 mock 下可推进到 VIDEO_READY 但**合成失败**（FFmpeg 无法解码 mock SVG），真实 Key 下回 JPEG/MP4 无此坑。**未实机验证**：Docker 公开镜像拉取、真实 TokenFree 生成质量、OSS/易支付回调/发布脚本/nginx 拓扑；`docs/images` 10 张官方截图未像素核对。

**关键源码证据路径**（`yi1108--printfilm:` 前缀）：`README.md`、`LICENSE`、`CLAUDE.md`、`docs/EPISODE_RULES.md`、`docs/SHOT_SPLITTING.md`、`docs/BILLING.md`、`docs/STANDARDS.md`、`docs/PLACEHOLDER_BACKLOG.md`、`backend/app/models.py`、`backend/app/models_drama.py`、`backend/app/models_tasks.py`、`backend/app/services/tasks/`、`backend/app/services/kepu_stages.py`、`backend/app/services/drama/`、`backend/app/services/tokenfree_gateway.py`、`backend/app/services/billing/`、`frontend/src/App.tsx`、`frontend/src/index.css`、`frontend/src/styles/printfilm.css`、`frontend/src/pages/studio/StoryboardPage.tsx`、`frontend/src/pages/drama/EpisodeEditPage.tsx`、`frontend/src/lib/composeEpisodeVideoClient.ts`、`admin/src/App.tsx`、`docker-compose.yml`、`deploy/README.md`。


### 3.6 LumenX（alibaba/lumenx）——pipeline-first 漫剧创作座舱（模型目录与候选品控标杆）

**定位与核心思路**【文档】：「AI 原生的短漫剧 & 视频创作平台」，口号 "Render Noise into Narrative"；两模块 **LumenX Studio**（pipeline-first 漫剧/视频生产）+ **LumenX Playground**（独立生成工具台）。主用户为独立创作者（自媒体/短视频作者），把文本剧本快速变成漫剧视频；次级为把工具当 pre-production 的专业团队【判断】形态是「单机/桌面优先的创作者座舱」（本地文件库 + 可选 OSS 镜像 + PyInstaller/Tauri 桌面打包），不是多人协作 SaaS。注：AGENTS.md 描述的 **Atelier**（graph-first 无限画布，"Seed → Plan → Draft → Generation → Takes → Judgment → Branches → Sequence → Export"）代码在独立分支**未合入 main**——本 commit 无任何 `/atelier` 路由，`page.tsx` 里的 "atelier-*" 只是主题 CSS 类名前缀（勿当已有功能）。

**架构与生成/工作链**【源码】：前端 Next.js 14 单 entry `page.tsx`（1114 行）内 **hash 路由** + Zustand + next-intl（zh/en）+ TipTap；后端 FastAPI 单 app（约 150 端点）；**存储是 JSON 文件无数据库**（`output/projects.json` 等）；任务用 FastAPI BackgroundTasks + 前端 2s 轮询，启动时 `_recover_orphan_tasks()` 把孤儿 `pending/processing` 视频任务标 failed（防「排队中」永久转圈）。Studio 两套步骤轨：**R2V unified 5 步**（默认新项目）`Script → Art Direction → Cast → Storyboard R2V → Assembly`；**i2v_legacy 6 步**（老项目兼容，含 ConsistencyVault 资产金库）；freeform 内容模式跳过 Script 步。步骤轨状态模型 `ready/warn/idle/gated`（gated=上游未完成锁图标但可点）——不是 wizard 强制完成。系列结构：`Series`（共享角色/场景/道具池 + 系列级美术/模型/提示词/音色池）→ 多个 `Script`(Episode)。数据模型亮点：`Character.reference_sheet`（R2V v2 统一设定图）+ `AssetUnit` 图/视频变体池（`MAX_VARIANTS_PER_ASSET = 10`，收藏不自动删）；`StoryboardFrame` **Schema v2 结构化镜头**（视觉原子三字段 visual_atmosphere/character_acting/key_action_physics + 相机 + `blocking` 站位 + `lighting` 光影 + `audio_note` + `transition_hint` + **只读 `assembled_prompt`** 由结构化字段自动拼装）；台词音频 `dialogue_text_hash` **stale 检测**；`selected_video_id + is_video_pinned`（人工钉选防被「最新完成」覆盖）+ **`final_take_id`**（Assembly 阶段拍板）；`VideoTask` 带 **provider 诊断三字段** `provider_name/provider_task_id/provider_request_id`（注释明说供用户贴进百炼/Kling 控制台排障）。

**最突出的优势**：

1. **模型目录工程化（catalog as code）**【源码+实测】：`config/model_catalog/` family YAML → `scripts/build_model_catalog.py` 生成前后端同源 JSON + Schema → `validate_model_catalog.py` CI 强制。实测 39 模型条目/8 family/28 model lines；每模型声明 capabilities、params（size/duration/quality/seed/negativePrompt/watermark 逐项）、`ui.visible_in`/`ui.selection_group`、`routing_prefixes`、`credential_sources`、`transport.*_input_mode`；新模型接入有固定 workflow。**全仓最值得抄的工程资产**（判断）。
2. **「抽卡 → 短名单 → 拍板」生成品控链**：per-shot ×N 批量（×1/×2/×4/×6）、候选星标 + ≤20 字标签、T2I 首帧历史 FIFO 10、pin 防覆盖、Assembly `final_take_id` 终选、失败重试 + provider 三字段贴回供应商控制台排障。
3. **结构化镜头 Schema v2 + 只读 assembled_prompt**：对「可控性 vs LLM 自由度」给出可落地折中——结构化字段可编辑、最终 prompt 实时拼装可预览（duration 不进 prompt）。
4. **R2V 双模工作台**：`direct_r2v`（节奏优先，直出参考生视频）vs `t2i_i2v`（画面优先，先生首帧图再生视频）——把 i2v 与 r2v 从「流程分裂」降为「单镜头输入形态切换」，默认值系列/项目级继承、per-shot 可覆盖。
5. **剧集级一致性体系**：系列共享池 + 全局池三层解析（Episode > Series > Global，只补充不覆盖）+ **跨集 Reconcile AI 对账**（见下）+ 上集摘要/下集 Hook 缓存（含 revision）。
6. **任务层韧性与音频链**：孤儿恢复、异常落盘、取消、批量 SSE、workbench 状态后端持久化（修「只存 React state 刷新即丢」）；系统音色/克隆/设计三源、dub 预览与偏移、demucs 背景音缓存、BGM+三轨混音。

**UI 信息架构与逐页/逐区域设计参考**【实测 + 源码】：全局 5 项导航（桌面竖栏 ↔ 移动 BottomTabBar 同一数据源）：workspace / library / editor / playground / settings（固定底部 + 版本号）；进入项目后切 `PipelineSidebar`（面包屑 + 可选 EpisodeMiniList 切集 + 步骤轨 + 底部项目卡）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| Workspace `#/`【实测】 | 页头（mono eyebrow `WORKSPACE · 画廊` + Fraunces 大标题 + Sync/导入文件/「新建」下拉）→ 工具条（状态 pill-tab 全部/已完成/处理中/草稿 + 计数、搜索框、画廊/列表切换 localStorage 持久）→ 系列分组（系列标题 + `SERIES · N` mono 计数 + 细分隔线）+ ProjectCard 网格 + 虚线「新建剧集」tile | 搜索按项目标题+系列标题命中整组保留；无匹配专门空态 + 清除筛选；空库品牌空态卡（slogan + 引言文案 + 创建系列/项目/同步后端）；离线时 Sync/新建禁用 + OfflineBanner | dark 暖石墨底、玻璃卡、mono uppercase eyebrow、Fraunces 标题、入场错峰动画（delay 60ms 上限 300ms）；pill-tab `role=tablist` + roving tabindex 方向键 |
| 首跑门禁【实测】 | 后端不可达弹「加载配置失败。后端是否正在运行？」；未配 key 强制模态 EnvConfigDialog（「在必填字段有效之前，此对话框不能关闭」）挡住所有路由 | 填假 key 放行 | 【判断】onboarding 强势但阻断「只想看界面」场景，ToIV 借鉴时应可跳过/试用模式 |
| Script 步 | 大文本域 +「提取实体」CTA + 创建实体对话框；右栏「Previously on...」上集摘要/next_hook | 提取成功 toast 后**自动弹 ReconcileModal**；失败 toast 可复制详情 | — |
| **ReconcileModal 跨集资产对账**【源码】 | 剧本提取实体 vs 系列共享库 AI 匹配建议表：置信度 ≥75 默认 `merge_into_series`、<75 默认 `create_new_in_series`，行内下拉可改 | 「全部确认」一键；应用后可跳 Cast；后端 `GET /projects/{id}/reconcile/suggestions` + `POST .../reconcile/apply` | **ToIV P0 跨集对账的直接 UI 参考** |
| Art Direction【实测】 | 预设分类网格（全部/真人电影级/日式动漫/美式动画·图像小说/风格实验室，15 个具名预设各带三词气质描述）+ AI 分析剧本推荐 + 自定义风格 + 与系列基线对比 | 选中修改有「与原预设差异」追踪；`SELECT A STYLE →` +「应用并继续」 | — |
| Cast【实测】 | 统计（角色数/已绑音色数）+ tab 全部/角色/场景/道具（计数徽标）+ 卡片网格 → CastWorkbenchModal（图像变体生成/上传/锁定/星标、动作参考视频、属性编辑） | VoicePicker 三 tab（系统音色/我的复刻/我的设计）、VoiceClone（上传参考音频）、VoiceDesign（文本描述生成 + translate + preview/accept）；角色卡 hover 露出音色绑定 + 试听 | — |
| **Storyboard R2V**（2281 行，核心页）【实测】 | 页头：mono eyebrow + pills（画风/当前模型）+ **TaskQueueButton**（在飞任务数，展开右侧地板到天花板队列侧栏，**挤压主列而非覆盖**）+ 主 CTA「生成分镜」；工具条（shot 计数 + 在飞计数 + 加镜头 + Expand/Collapse All）；GenerationBanner（批量阶段字幕 + refine/音频进度 +「生成全部台词音频」入口）；ShotCard 垂直长列表 | 每卡：**tab「多参考R2V / 首帧生图+I2V」双模** + AssetChipBar（@ 引用 → `[characterN:...]` 标记转 reference_image）+ prompt 区（textarea + LLM 润色面板 + 结构化字段 chip + PromptExpandModal + 只读 assembled_prompt）+ ShotPanel 下挂（虚线连接分段可折叠：Params 按模型 catalog 动态显隐 / T2I 首帧抽卡历史选中索引决定喂给 I2V / CandidatesSection 视频候选 + CompareModal 对比 + 星标 shortlist）+ DialogueAudioRow（STALE 标记=文本/音色/指令 hash 变化，dub 预览/应用/删除/偏移 ms）+ 卡操作（上移/下移/复制/删除/Pin/Unpin/Star/Play/上集帧参考轨） | 空态插画式空卡（Wand2 图标 + 双 CTA）；workbench 状态（tabMode、T2I 历史、批量数）防抖写回后端，刷新/跨设备不丢 |
| Assembly【实测】 | 三相 pill tab：**Takes**（逐帧 take 管理 + 右侧变体侧栏 + `final_take_id` 拍板）/ **Mix**（BGM picker + dialogue/bgm/sfx 三滑杆 + 诚实横幅「preset 音频文件尚未随仓库附带」）/ **Export**（合并按钮 + 合并预览 + 强制 blob 下载；mergeFailedAlert 可复制错误详情） | 【源码注】`modules/Timeline.tsx` 是**静态假时间轴死代码**（全仓无引用），勿当真实功能 | — |
| Playground【实测】 | 两级模式（图像\|视频大类 + T2V/I2V/R2V/V2V pill；T2I 传图自动变 I2I）→ ModelSelector（family 分组 GroupedModelGrid）→ MediaInput → PromptInput（含 negative，计数 `0 / 2000`）→ ParameterBar（每模型动态参数）→ 批量 ×1/×2/×4 | **QueuePanel 并发上限 1-8 可调**、排队项可见；结果区网格/画廊切换 + DetailPanel（左图右信息 ←→ 导航）+ Session 时间分割线（30 分钟分组）；失败重试/删除/复制报错全文；收藏入资产库；PromptHistoryDrawer（去重/搜索/复制/存为模板）+ PromptTemplateModal | — |
| Library【实测】 | 类型 tab + 来源轴（type/source 跨 Series/项目/全局池聚合）+ 星标过滤 + 排序 + 搜索 + 网格 2-4 列 | 选中右侧 AssetInspector（变体管理、promote 到全局池、fork 到项目） | 空态引言「每一个角色，都在等待属于自己的那一格画面。」 |
| Settings【实测】 | 六 tab 通用/模型/默认 Prompt/API 密钥/存储/关于；**5 主题预设**（atelier-dark 暖石墨 teal / bridge / brand-dark 冷黑品牌蓝 / atelier-light 暖陶白 / brand-light，色板 swatch）；apikeys（DashScope/Kling AK-SK/Vidu/MuleRun 一键 OAuth） | 通用有动画开关（「关闭后将降低过渡动画，并尊重系统的减少动态偏好」）；存储保存不被生成类必填项阻挡；关于=系统检查（FFmpeg/依赖，进 tab 自愈式自动跑）+ UpdateChecker | — |
| ScriptEditor | TipTap + FormatToolbar；视图 `edit/storyboard/focus`；左栏 大纲/场景导航/搜索；右栏 角色/镜头/管线/地点/道具/笔记/AI 补全 | FDX/Fountain/TXT 导入、PDF/DOCX 导出（库缺失 HTML 兜底）；`document.json` + `history/` 快照恢复；离线本地缓存 +「有较新本地版本可恢复」；连戏检查指示器；粘贴解析提示；快捷键帮助；L3 兜底补全（停输 2s 后按 confidence 调 `/derive_gaps`，5 分钟缓存，失败不阻塞）；StoryboardView 从 shotBlock 节点抽取分镜卡可点击回跳正文 | 布局硬编码 `bg-[#050508]` 未完全接入主题 token（遗留） |

视觉系统【源码】：5 预设主题 token 三层（seed → semantic → component）；默认 atelier-dark：底 `#0c0b0e`、surface `#131116`、主色 teal `#34d8c4`、强调 amber `#ffa94d`；字体 Fraunces（display 衬线）+ Space Grotesk（正文）+ JetBrains Mono（chrome 元数据）+ Noto Serif SC/JP；组件语言 `glass-panel`（5% 白 + blur）、`atelier-card`（去框浮起 + halation 光晕）、`atelier-pill-tabs`；氛围层 `--glow-primary/--halation/--bloom/--grain-op`（页面级 bloom + 颗粒）；三级字号 chrome/body/display + 动效 fast 150/base 250/slow 400 `ease-out-quart|expo` 无回弹；**状态色语义 token**（pending 冷蓝/processing 琥珀/completed teal/failed 暖红/starred 暖金，oklch）替代 30+ 散落任意色。响应式：GlobalSidebar `hidden md:flex` ↔ BottomTabBar `md:hidden`；卡片网格 auto-fill；Tauri 内嵌窗口根字号 81.25%。a11y：全仓 `aria-*|role` 约 368 处、`focus-visible` 约 172 处；pill tab roving tabindex；`aria-current` 导航；禁用按钮配 title（离线 tooltip）；动效靠开关收敛（CSS 内无 `prefers-reduced-motion` 媒体查询，依赖开关）。

**局限与反模式**：① 单机 JSON 存储（无事务/无并发锁/无多用户）；② 无应用层认证（API 全开放，0.0.0.0 时局域网裸奔）；③ **假实现残留**：`export.py` mock 导出（sleep + `dummy video content`，分辨率/字幕参数「accepted but not yet applied」，官方设计文档自认）、`Timeline.tsx` 死代码假时间轴、BGM preset 音频未附带（UI 有诚实提示）；④ Character 多层 LEGACY 字段并存、Schema 演进靠 fallback 无迁移脚本；⑤ 供应商耦合 DashScope 中心 + MuleRun CLI 本机登录态；⑥ 文档漂移（Atelier 文档超前代码、LLM 默认模型 qwen3.6/3.7 说法不一、APP_VERSION v0.2.0 vs tauri 1.2.1）；⑦ 单文件巨石前端（page.tsx 1114 行、StoryboardR2V 2281 行、api.py 4863 行）；⑧ **无成本核算**（只有三处防重复扣费的工程处理）；⑨ **lockfile 绑定内网 registry（实测踩坑）**：186 处 `resolved=registry.anpm.alibaba-inc.com`，外网 `npm install` 卡死，需改写前缀才能装上——README 快速开始对外部用户不可直接复现；⑩ 首跑强制模态阻断无 key 浏览。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | LumenX 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 模型 catalog as code（family YAML→生成 JSON→前后端同源 + 校验 + onboarding workflow） | `config/model_catalog/`、`scripts/*_model_catalog.py` | **部分**（双源能力元数据互不同步） | §5 P2 模型能力单源（对齐 AGENTS H-6 weight id/served 别名/参数能力收敛单一真源） |
| 任务诊断三字段 + 孤儿启动恢复 + 失败原因落盘 | `models.py:206-218`、`pipeline.py:111-140`、`tests/test_video_task_recovery.py` | **已有**（jobs_persist/render_reconcile 自愈）；**部分**（无 provider 三字段贴回排障） | §5 P0 统一任务中心补诊断字段**不重做恢复** |
| 抽卡→星标短名单→Assembly 拍板 final_take + pin 防覆盖 + CompareModal | `CandidatesSection.tsx`、`models.py` final_take_id/is_video_pinned | **已有**（多候选 pick + 自动选优 candidate_pick）；**部分**（无并排对比/拍板台 UI） | §5 P2 take 对比选优台（数据已有，补 UI） |
| 镜头结构化 Schema + 只读 assembled_prompt | `models.py:352-388`、`buildAssembledPrompt.ts` | **部分**（prompt 单列无结构化拼装预览） | §4 分镜卡建议 + §5 P1 提示词修订的字段化底座 |
| **跨集资产对账 ReconcileModal**（AI 建议 + 置信阈值默认 + 行内可改 + 全部确认） | `ReconcileModal.tsx`、`api.py:1451-1590` | **部分**（有 ProjectAssetCandidate 按名归并、presence-check；无对账面） | **§5 P0 跨集资产对账的主参考** |
| 台词音频 stale hash（文本/音色/指令变化→STALE） | `models.py:406-411`、`DialogueAudioRow.tsx` | **部分**（Go 域 artifact stale 有；FastAPI 配音无 stale） | §5 P1 stale 联动扩到配音 |
| R2V 双模 per-shot 覆盖 + 项目/系列默认继承 | `ProjectClient.tsx:51-55` | **部分**（有 num_candidates 等参数默认） | §4 生成面板默认值继承体系 |
| 设计 token 三层 + 状态语义色 + 三级字号/动效 token | `globals.css`、`tailwind.config.ts` | **未见**统一 token 治理 | §4 横切 |
| ScriptEditor：FDX/Fountain 导入、快照恢复、离线缓存、L3 兜底补全 | `api.py:4059-4400`、`ScriptEditor/hooks/*` | **部分**（SVML 导入已有） | P2 剧本编辑增强参考 |

**许可边界**【源码文件事实，非法律意见】：根 `LICENSE` = **MIT**（`Copyright (c) 2026 Alibaba`），标准文本，无附加 NOTICE。引用/复制须保留版权声明与许可文本；依赖（Next/Tailwind/dashscope/oss2 等）与第三方模型服务条款（DashScope/Kling/Vidu/MuleRun 的 API 使用条款与生成内容权利）不在 LICENSE 覆盖范围；品牌素材（Logo/Banner）可能受商标/著作权约束。**对 ToIV 并码限制少**（保留声明 + 依赖/品牌合规）。

**运行验证边界**【实测】：后端 `.venv-research`（Python 3.14.7，requirements-docker 子集）安装成功；**`pytest -q` 209 passed**（2.49s，覆盖 pipeline 五步冒烟、provider 媒体传参、video task 恢复三条真实回归、PolishError、FFmpeg 路径安全、model catalog 等）；`validate_model_catalog.py` 通过、`build_model_catalog.py` 幂等重建一致（39 模型）；uvicorn 启动：`/health` ok、`/projects/` `[]`、`/docs` 200、`/system/check` 检出 ffmpeg 9.0.1、无 key 时 `POST /projects` 干净失败（「LLM API Key 未配置…」）；前端 npm install（**须先改写 lockfile 内网 registry 前缀**，clone 内 `frontend/package-lock.json` 因此 dirty 未提交）+ `next dev :3008` 成功；Playwright 1440×900 与 390×844 实测 Workspace/Library/Playground/Settings/ScriptEditor + Project 五步（合成项目 `probeui01` 注入 `output/projects.json` 后访问，验完即删），首跑门禁行为已记录；控制台 0 error。**未实机验证**：真实生成链（T2I/I2V/R2V/TTS 全依赖云端 key）、官方截图像素核对；前端无 CI。

**关键源码证据路径**（`alibaba--lumenx:` 前缀）：`AGENTS.md`、`README.md`、`LICENSE`、`docs/design/r2v-workflow-v3-unified.md`、`docs/2-model-catalog-design/`、`config/model_catalog/`、`scripts/build_model_catalog.py`、`scripts/validate_model_catalog.py`、`src/apps/comic_gen/models.py`、`src/apps/comic_gen/api.py`、`src/apps/comic_gen/pipeline.py`、`src/apps/comic_gen/export.py`、`src/utils/provider_registry.py`、`frontend/src/app/page.tsx`、`frontend/src/app/globals.css`、`frontend/src/components/project/ProjectClient.tsx`、`frontend/src/components/modules/StoryboardR2V.tsx`、`frontend/src/components/modules/ReconcileModal.tsx`、`frontend/src/components/modules/VideoAssembly.tsx`、`frontend/src/components/modules/playground/`、`frontend/src/components/settings/SettingsPage.tsx`、`tests/test_video_task_recovery.py`、`src-tauri/tauri.conf.json`。


### 3.7 KŌMA Studio（klaus-2/koma-studio）——**注意：这不是影视/分镜产品**，是漫画扫译桌面工具链（工程机制参考）

**定位与核心思路**【文档+源码】：**漫画/条漫（manga/manhwa/manhua）扫译（scanlation）桌面工具链**——检测→OCR→翻译→去字（inpainting）→嵌字（typeset）→导出，域与 ToIV「短剧创作平台」**不同**，不能当同类产品对照；但其「本地 AI 侧车 + 六段可回溯流水线 + 模型注册表 + 桌面工作区」工程模式高度可借鉴。承诺 100% 免费无套餐/配额/积分、local first（本地 Python 侧车）、无遥测、MIT。目标用户是扫译组与个人汉化者（内建社区招募板 Scanlation Feed、Discord webhook、Blogger/Imgur 发布）。设计思路【判断】：「工作区即文件」（`.koma` zip = manifest + 资产，隐私+离线，服务端只做账号/社区/内容目录）、「侧车即服务」（AI 全在 127.0.0.1 FastAPI，壳负责启动/健康/崩溃重启）、「目录先行」（所有模型能力先注册再被引用）。

**架构与生成/工作链**【源码】：Bun workspaces + Turborepo monorepo：`apps/electron`（v1 壳维护模式）、`apps/tauri`（v2 主线 WIP）、`packages/interface`（两壳共享 UI）、`packages/mini-backend`（Python FastAPI + ONNX/PyTorch 侧车）、`packages/types`（契约）、`packages/ui`（tokens + classic/noir 双主题 registry）、`apps/auth-server`（Express + Better Auth + Postgres/Redis，账号/社区/模型评价/指南）。六段流水线 AIO：Detect（文本/气泡框）→ OCR → Translate → Segment（几何细化为可排版行）→ Clean（LaMa/AOT inpaint 去字）→ Render（译文回绘/嵌字）；两种跑法 AIO automatic（一键批跑）与 **AIO manual（逐段 rewind / re-run / skip / 框选调整后再继续）**。流水线下挂独立工具：Cleaner & Redrawer、Typesetter、Translator、Raw Provider、Proofreader & QC、Stitch、Split、Watermark、Enhance（超分 2x/4x）、Chapter Optimizer（锐化/降噪/灰度/自动色阶）、Blogger/Imgur、Guides/Resources。导出 PSD 分层（带元数据）、zip/cbz/cb7/pdf。数据模型是「图片集合 + 文本区域 + 流水线快照」（无项目/分镜概念）：`AioTextRegion`（bbox + 识别文本/译文 + mask + renderMode + SFX 字段）；每条阶段结果带 **`source: "model"|"manual"` 与 `detector_model_key/ocr_model_key/translator_model_key/segment_model_key` 逐区域模型溯源**；`AioPipelineSnapshot` + `AioManualImageProgress`（按图逐段 `locked|pending|done|skipped`、可 rewind/forward）。

**最突出的优势**：

1. **本地优先完整 AI 流水线 + 全程可回溯**：每段可开关/重跑/跳过，「谁在何时用哪个模型改了哪个框」全程可审计——对生成式工作流的可复现性是范本。
2. **模型注册表 + 供给侧治理**：本地/云端模型统一目录（SHA256、显存/磁盘需求、速度评级、安装策略 direct_download|backend_managed|manual_import、runtime 家族、推荐标记），下载任务队列状态机（QUEUED/DOWNLOADING/VERIFYING → READY/ERROR/CANCELLED，断点 + 磁盘不足 + 限速归类）；36 家免费 LLM 供应商目录带 rateLimitSummary/setupSummary；**翻译回退链**（最多 4 键、仅传输级失败降级、`model_used` 如实回报、不可达供应商按本地日历日 `QuotaBlocklist` 熔断）。
3. **双壳共享 UI + 双主题皮肤单缝切换**：classic/noir 经 `createFamilyComponent`（每组件一对 `XxxClassic`/`XxxNoir`），换肤不污染业务组件。
4. **工程质量基建**：路径过滤 CI、Playwright 视觉回归/性能探针、运行时分片签名分发（Ed25519 + sha512 + Range 断点续传 + 原子替换）、证书钉扎、本地 API fail-closed（`x-koma-local-session` 头）、THIRD-PARTY-NOTICES 许可清单化。
5. **嵌字细节**：字体样式检测匹配原稿风格、文字特效/形状检测、SFX 分类与重绘标记、翻译备注 overlay、PSD 分层导出——「翻译正确」之外还管「排版像原版」。

**UI 信息架构与逐页/逐区域设计参考**【源码+运行】：hash 路由（手写 `parseHashRoute`）：`#/dashboard`（默认）/login/register/forgot/reset/verify/confirm/banned/scanlation-feed/model-rankings/settings/legal 族。Dashboard 四区布局【运行 1600×950】：**左 aside（图片集，280px）+ 顶栏（56px）+ 中央舞台 + 右侧工具面板 + 底栏状态（36px）**，均 `radius 0`、半透明纸色底 + 细描边。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| 顶栏 `KomaTopbar` | 品牌字 + 版本徽标 + 导航分组：Main(AIO) / Production(Cleaner/RD、Typesetter、Translator、Raw、Proofreader) / Utilities(Stitch、Split、Watermark、Enhance、Optimizer、Blogger、Imgur) / Information(Guides、Resources) + 下载菜单（含 PSD 导出区）+ 用户菜单 + 开始按钮 | — | 小标签惯用 `// FILES (0)`、`// CONTROL ROOM · 設定` 注释化前缀 + 全大写微字 + mono |
| 左栏图片集 | 拖拽/点击上传（JPG/PNG/WEBP/ZIP/PDF/CBZ/CB7/PSD）、缩略图列表、**每图 rewind/forward 快照步进**、删除（撤销 ObjectURL）、本地处理量统计卡（TODAY/WEEK/MONTH + 自动重置倒计时「Resets in 16h 34m」） | 空态 `// FILES (0) No images / DRAG OR CLICK` | — |
| 中央舞台 | 当前模式画布/分镜格；长条模式虚拟滚动长图（`ViewMode: paginated\|long_strip`） | 空态「SELECT OR LOAD IMAGES…」+ **每 15 秒轮播的有用提示**（`// USEFUL TIP … — Cycling every 15 seconds`） | — |
| 右栏 AIO 面板 | 分节可折叠：**Pipeline**（6 段 tab `role=tablist`+`aria-selected` + Prev/Next/Run/Skip 步进行 + `Pipeline 6/6` 徽标 + AIO automatic/manual 子模式）/ Languages（源 11 种、目标 24 种）/ Presets（模型预设 save/new/edit/delete）/ Models & Config（按段选模型、Custom AI profiles、HD 策略 original\|resize\|crop、mask 膨胀、批线程数）/ GPU Usage per Stage（按段锁 GPU） | 手动工具坞（select/brush/eraser、paint/healing brush/magic wand） | — |
| 底栏 `DashboardFooter` | 状态条 + 彩色 tone（info/success/warning/error/debug）+ 进度条 + 最后保存时间 + **本地 runtime 生命周期**（resolving/checking/downloading %/verifying/extracting/fallback/error、TensorRT 提示） | 【运行】「Ready to process images.」/「PENDING」 | — |
| Settings `#/settings` | 返回按钮 + 头部（`CONTROL ROOM · 設定`，用户卡）+ 四个大编号 tab：01 GENERAL/アカウント、02 PRESETS/プリセット（模型预设、排版预设）、03 INTEGRATIONS/連携（Discord webhook 测试按钮 testing→ok/failed、Blogger CDN、Imgur）、04 APPLICATION/アプリ（主题族、界面语言 14 种） | Legal center 入口 | 纸色玻璃卡 `glass panel-cut`，tab 编号大字 + 日文副标 |
| Model Rankings `#/model-rankings` | 头部统计（Models/Reviews/Best overall/Cost-benefit）+ 排序 tab（Overall/Quality/Speed/Cost-effectiveness/Ease of use）+ 筛选 + Leaderboard（「Sorted by weighted overall score.」）+ 详情/评价面板 | 空态文案完整（「Be the first to review…」）+「Session expired. Please sign in again.」（未登录读评价受限）；**实测缺陷**：模型卡片直接渲染 `{model.description}` 而 description 是 i18n key，页面显示原始 key（注册表字段当展示文案用、缺 i18n 管道） | — |
| Scanlation Feed `#/scanlation-feed` | 社区招募板：tab RECRUITMENT 募集 / SHOWCASE 発表；Composer 模块化（Basic/Social/Media/Recruitment/Roles）；发帖规则勾选（「Malicious links result in a permanent ban.」）；举报/版务面板；右侧 AUTHOR PROFILE + Discord 通知开关；INTERNAL INBOX（申请发出/收到计数） | 空态「NO RECRUITMENT POSTS FOUND / BE THE FIRST TO POST RECRUITMENT!」 | — |
| 认证页族 | 暗色霓虹风（与工作台纸墨风**刻意不同**：bg `#060810`、紫/青/玫红、卡片圆角 16/24px）；auth-alert 三态 `role=alert`；强制更新提示；**auth-travel-gate**（桌面旅行令牌跨设备登录） | guest 模式下登录页被重定向进 dashboard | — |

视觉语言【源码】：双主题族 classic/noir 默认 noir（实测落 noir 亮色变体：纸色 `#f2ede3` + 墨色）；ink/paper 反相双色板 + 强调色 crimson `#ff2e63`/gold/azure/mint；**非圆角**形状语言（`panel-cut` 切角面板、`border-radius: 0px`、阴影多 none）；字体 Manrope（正文）/Cabin（标题）/Instrument Serif（展示）/JetBrains Mono（等宽）/Archivo（noir 展示）；字号微缩（徽标 8px、chip 10px、tab 12px）。响应式：`isCompactViewport` 移动端抽屉 + 遮罩、侧栏拖拽缩放；【运行】390×844 窄屏侧栏折叠为抽屉（未逐像素验收，谨慎引用）。a11y：tablist/aria-selected/aria-label 齐全、axe-core 为 devDep，但自扫 **298 项可访问性诊断未清零**。i18n 14 语言（zh 完整 4238 行）。状态反馈体系完整：status-store 文案+tone、footer 进度、每阶段/每图执行状态、runtime 下载进度、ErrorBoundary + 空态、执行通知 `RuntimeExecutionNotice{tone: legacy|fallback|cpu|cuda}`。

**局限与反模式**：① **域不匹配**：无剧本/分镜/镜头/角色概念，不能直接映射影视生产；社区 feed/招募属扫译圈特有；② 巨型组件与性能债**自认最大痛点**（README roadmap；`refactor-queue.md` React Doctor 全扫 **704 项诊断**：58 error/646 warning、132 文件——性能 127/bug 221/a11y 298/可维护性 56/安全 2；最大文件仍有 2816/2621/2534 行）；③ classic/noir 双份实现维护面 ×2；④ Model Rankings i18n key 直渲染缺陷（实测）；⑤ 纯 Web dev 模式大量预期性报错靠 UI 容错消化，**依赖桌面壳才算完整体验**（字体安装/PSD/旅行令牌/更新器仅壳内）；⑥ mini-backend 测试文档口径与实况不符（纯 Python 声明 vs 全量收集需 onnxruntime；本机 51 个 ImportError 未跑）；Python 侧依赖极重（torch/llama-cpp/ctranslate2）；⑦ v2 Tauri 未完（breaking changes 预警）。

**ToIV 借鉴映射**（对照 toiv-current-audit；注意借的是机制层，不是域模型）：

| 借鉴点 | KŌMA 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 阶段快照 + per-entity rewind/forward + 逐段模型溯源 | `AioPipelineSnapshot`、`*_model_key` 溯源字段 | **部分**（Job.params 有版本树；无「哪一步哪个模型改了哪个对象」的步进快照） | §5 P0 统一任务中心的步进溯源 + §5 P1 prompt diff 回滚 |
| 统一模型注册表（键/需求/校验/速度/安装策略/推荐） | `translation-*-registry-data.ts`、`model-assets.json`（sha256） | **部分**（双源能力元数据） | §5 P2 模型能力单源（对齐 AGENTS 命名铁律「一个磁盘权重一个 weight id」） |
| 生成回退链 + 按日熔断 + `model_used` 如实回报 | `models/translation/fallback.py`、`QuotaBlocklist` | **部分**（引擎故障转移有；无熔断/如实回报 UI） | P1 引擎不可达降级链（LLM/VLM/Comfy 故障转移） |
| 服务监督模式（启动/健康/重启/关停 + 本地会话头 + fail-closed）+ 底栏 runtime 生命周期可视化 | `mini-backend/README.md`、`DashboardFooterClassic.tsx` | **部分**（集群服务靠 systemd；无统一底栏状态机） | §4 生成队列与成本横切建议 |
| 模型预设（每段选型存档/切换） | `AioModelPresetStateV2` | **部分**（三套预设并存非用户可存） | §5 P1 用户配方库 |
| 双主题皮肤单缝切换 | `themes/family-skins.ts` | **未见** | P2 主题系统（只抽 token/皮肤层，勿学双份组件） |
| 工作区文件化（zip manifest + 资产引用 + 版本号） | `workspace-package.ts` | **部分**（有导出 ZIP） | P2 项目导出/迁移包标准化 |
| 许可清单化（GPL 权重不入库规避传染） | `docs/THIRD-PARTY-NOTICES.md` | **部分**（docs/MODEL_SOURCES.json） | P1 模型版权台账升级为 obligations 级 |

**许可边界**【源码文件事实，非法律意见】：`LICENSE` = **MIT**（Copyright (c) 2026 Klaus），各 app 亦 MIT。`docs/THIRD-PARTY-NOTICES.md`（明言 "not legal advice"）：**GPL-3.0** 的 Comic Text Detector（适配器 + 运行时下载 ONNX 权重）——**权重不入库、安装包不携带**，这是项目保持 MIT 的理由；若打包权重/上游代码则承担 GPL-3.0 义务；LGPL-2.1+（py7zr）、GPL-2.0+bootloader exception（PyInstaller 仅构建工具）、MPL-2.0（axe-core/lightningcss dev 期）；vendored Pororo/brainOCR（Apache-2.0）但部分 Pororo checkpoint 为 **CC-BY-NC-SA-4.0**（非商用，需逐模型核对）。**并码注意**：ToIV 可引用其代码（MIT 保留声明即可）；**不要**把 GPL-3.0 权重或 Pororo NC 权重打包进 ToIV 分发物；其「运行时下载不随包」的合规策略是经验而非法律保证。

**运行验证边界**【运行】：`bun install` 成功（注：需 bun ≥1.4 才能读原 lockfile，本次曾重新生成后已还原）；`apps/tauri` vite dev（:5487）+ Playwright 访问 7 个路由 + 390px 窄屏；**`packages/interface` vitest 73 文件 / 523 用例全部通过**（4.17s）；guest/local 模式 UI 完整渲染（auth/侧车缺失报错被容错消化，空态正常）。**未实机验证**：Python mini-backend 测试（系统 Python 3.14 缺 cv2/onnxruntime，收集期 51 个 ImportError；完整依赖含 torch/ctranslate2/llama-cpp 重量级未装——README 称纯 Python 测试可独立跑与实况有出入）；turbo build/electron-builder/tauri build 打包链；官方媒体（promo gif/mp4、清字前后对比 webp）未读图。实测产物：8 张截图 + DOM/样式 JSON 在 `/tmp/koma-ui-verify/`（供目视复核，正文不依赖）。

**关键源码证据路径**（`klaus-2--koma-studio:` 前缀）：`README.md`、`CHANGELOG.md`、`LICENSE`、`docs/THIRD-PARTY-NOTICES.md`、`refactor-queue.md`、`packages/interface/src/app-router.tsx`、`packages/interface/src/types/dashboard.types.ts`、`packages/interface/src/pages/dashboard/sections/AioRightPanel.tsx`、`packages/interface/src/pages/dashboard/sections/ImageCollectionSidebar.tsx`、`packages/interface/src/components/dashboard/DashboardFooterClassic.tsx`、`packages/interface/src/pages/KomaTopbarClassic.tsx`、`packages/interface/src/pages/ModelRankingsClassic.tsx`、`packages/interface/src/pages/scanlation-feed/`、`packages/types/src/workspace-package.ts`、`packages/types/src/desktop-api.ts`、`packages/ui/src/themes/registry.ts`、`packages/interface/src/themes/noir/noir.css`、`packages/mini-backend/app.py`、`packages/mini-backend/models/translation/factory.py`、`packages/mini-backend/models/translation/fallback.py`、`packages/mini-backend/models/manifests/model-assets.json`、`packages/mini-backend/core/download_jobs.py`、`apps/auth-server/src/db/schema.ts`。


### 3.8 BigBanana AI Director（shuyu-labs/BigBanana-AI-Director，大香蕉 AI 漫剧工场）——**注意：HEAD 是文档仓，源码只在历史快照**

**版本形态声明**（引用本章证据前必读）【源码】：调研时 HEAD `ead7a5ca0513d7c225f72197ac78712a825a9ae9`（2026-10-06）**是纯文档仓库**——仅 README×3、LICENSE×2、`docker-compose.yaml`、`docs/schema-org.json`、`images/`（16 张官方 UI 截图 + 6 张分镜参考图），无任何源码。**完整前端源码存在于 git 历史**：最后一个含 `package.json` 的 commit 为 **`556824c4207c4582325f01e6c6546a3df22b403f`（2026-03-15，约 260 文件，自称 v1.0.0）**，其后逐步删源收敛为文档仓（README 自述因抄袭搬运「后续版本仅通过官方 Docker 镜像发布，不再继续公开同步源码…对商业版用户提供完整源码交付」）。本章凡标「历史源码」均指 `556824c4207c4582325f01e6c6546a3df22b403f` 快照（可用 `git show 556824c4207c4582325f01e6c6546a3df22b403f:<path>` 复核）；凡标「现行版」均指 HEAD `images/` 官方截图（产品镜像 `*-3.4.2`）与 README 声明——**二者同源不同代，存在版本断层**，世界观/小说导入/CutOS 等现行能力无源码可查。

**定位与核心思路**【文档】：「AI 一站式短剧／漫剧生成平台 · 工业化工作台」；反对「抽卡式」生成，主张 **Script-to-Asset-to-Keyframe**：先锁资产（角色定妆照/场景概念图），再用首尾关键帧控制镜头。目标用户：角色长期一致的连载创作者、网文 IP 改编团队、愿意做分镜/台词微调的内容工作室；明确「不适合只想一键出爆款的人」。核心差异化命题是**角色一致性**与**镜头可控性**。设计思路【判断】：先建「片场」（资产/世界观/美术指导）再「开机」（镜头）；一致性当作数据建模问题（版本号、syncStatus、参考图引用）而非提示词技巧；每个 AI 环节都是「生成→人工确认/改写→再生成」双拍循环；长任务可中断可续跑、成本可观测。

**架构与生成/工作链**【历史源码】：前端单体 SPA（Vite 6 + React 19 + TS 5.8 + react-router-dom 7；**Tailwind 走 CDN**）+ 语义令牌 CSS 双主题；**无自建后端业务 API**——AI 浏览器直连模型网关（默认 AntSK），媒体走 media-proxy（白名单 volces.com），账号/充值走 new-api-proxy；持久化 = IndexedDB（`series_projects/series/episodes/assets`）+ localStorage（API Key/模型注册表/主题）+ **OPFS 存视频**（导出时 `materializeProjectVideosForExport` 回填）。任务状态机内嵌资源字段（`pending|generating|completed|failed`，九宫格另有 `generating_panels|panels_ready`），**加载状态持久化**（刷新后把卡死的 generating 置 failed）；脚本生成可断点续跑（`ScriptGenerationCheckpoint` + 三个输入指纹键 structureKey/visualsKey/shotsKey 避免无效重算）。组织层级：`SeriesProject`（含 `artDirection` + characterLibrary/sceneLibrary/propLibrary）→ `Series` → `Episode`（stage: script|assets|director|export|prompts）；资产 `Character`（含 `turnaround` 九宫格造型、`variations[]` 衣橱变体、libraryId+version）/`Scene`/`Prop`，均带 `promptVersions[]`；镜头 `Shot`（characters + `characterVariations:{charId:variationId}` + keyframes[] + `interval`（startKeyframeId/endKeyframeId/duration/motionStrength）+ `nineGrid` + `videoInputMode:'keyframes'|'storyboard-grid'` + `videoModel`（**硬编码联合枚举**）+ dubbing + qualityAssessment）；全局 `ArtDirection`（色板/人体画法规则/光影/材质/关键词/一致性锚点——**所有视觉提示词生成前先产出该文档再注入**）。生成链：Phase 01 剧本（三段式：结构化拆解→视觉化→分镜表，checkpoint 续跑，「建议单集 ≤8000 字符」超限阻断）→ Phase 02 资产（先 ArtDirection，再批量定妆/场景/道具 + 衣橱 + 九宫格 + 资产库跨集复用 + `assetMatchService` 中文 bigram 模糊匹配 + `characterSyncService` 处理 synced/outdated/local-only）→ Phase 03 镜头（Start/End Frame 生成/上传/**续接**（上一镜头 End 直接当本镜头 Start）；九宫格分镜「先 AI 出 9 格描述→用户改→再出整图→可裁切单格作首帧」；27 种运镜构图指南注入；上下文注入场景图+服装图+道具图）→ Phase 04 交付（渲染日志、序列时间线时码条、母版拼接 MediaRecorder WEBM（不支持降级 ZIP）/分镜 ZIP/源素材 ZIP/整库备份）→ Phase 05 提示词管理（集中检索编辑 + 30 条版本回滚）。质量闸门两段式：`promptLintService` 生成前 preflight（字段缺失/画幅/参考图数量/负向词，error/warning 阻断）+ `qualityAssessmentService/V2`（LLM 打分，5 维权重：prompt-readiness 30 / asset-coverage 20 / keyframe-execution 30 / video-execution 20 / continuity-risk 10 + 自动修复坏点）。

**最突出的优势**：

1. **「资产先行 + 关键帧驱动」一致性体系完整落地**（非口号）：定妆照/衣橱变体/九宫格造型/场景概念图/ArtDirection 文本锚点/镜头上下文注入/End→Start 续接/资产库复用+模糊匹配——每环都有独立数据结构与 UI。
2. **可恢复、可审计的生成工程化**：资源级状态机持久化 + 脚本 checkpoint 与输入指纹 + 提示词版本历史回滚（source 标注 ai-generated/manual-edit/rollback/imported/system）+ `RenderLog`（模型/token/耗时/成败）+ 质量评估 V2。
3. **本地优先零后端可跑**【实机】：无后端无 Key 可完整启动渲染（Vite dev，数据落 IndexedDB），整库/整项目/单集三级备份导入导出。
4. **双视频链路 + 九宫格预演的镜头控制面**：首尾帧插值 vs 网格分镜驱动互斥可选；九宫格可裁切单格作首帧；27 种运镜指南；镜头级配音。
5. **信息架构与预期管理**：Phase 01–04 + Advanced 阶段门禁；新项目 3 步引导；缺 API Key 弹引导而非裸报错（`App.tsx` 全局 error 监听自动弹模型配置）。

**UI 信息架构与逐页/逐区域设计参考**【历史源码 + 实机走查（历史版 SPA）+ 现行版官方截图目视/OCR】：路由（`App.tsx:338-366`）：`/` Dashboard、`/project/:id` ProjectOverview、`/project/:id/characters` 项目资产库、`/project/:id/episode/:epId` 工作台（5 阶段 tab）、`/account` 账号中心。全局层：Onboarding 多步引导（Welcome→Workflow→ApiKey→Highlight→Action + ProgressDots）、ModelConfigModal、GlobalAlert、Sidebar 阶段导航、ThemeContext、**MobileWarning（<1024px 或移动 UA 整页拦截「为了获得最佳体验，请使用 PC 端浏览器访问」）**。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| Dashboard 项目库（647 行）【实机】 | 页头「项目库 / PROJECTS DATABASE」+ 工具组（交流群/帮助/系统设置/主题切换/新建项目/账号中心）；项目卡片（标题、多剧集标识、角色数、日期）+ 虚线大卡「CREATE NEW PROJECT」 | 新建自动建「第一季」+「第 1 集」并跳转；删除确认弹窗；系统设置 4 项（模型配置/资产库/导出数据/导入数据）；空态「暂无项目可用」 | 现行版截图：亮色主题项目卡带封面/标签/简介/日期/进入箭头 |
| Onboarding【实机】 | 全屏遮罩多步向导 + 进度点；第二步演示工作流，第三步录入 API Key | 首屏「嗨，创作者 / 把你的故事，变成会动的短剧 / 只需一段剧本，AI帮你搞定剩下的一切」，可「稍后了解，直接开始」跳过；`resetOnboarding()` 可重看 | 缺 Key 错误转成引导动作而非裸报错 |
| ProjectOverview（425 行）【实机】 | 项目标题内联改名 + 统计条（剧集/总集数/角色/场景/道具）+「新项目引导」三步卡（STEP1 创建剧集→STEP2 创建集→STEP3 点第一集开始创作，含直达按钮）+ 剧集管理手风琴列表（集行=序号方块+标题+阶段徽标+日期+悬浮删除） | 空态「暂无剧集 / 点击『新建剧集』开始创作」 | **现行版增量**（截图核验）：项目头「项目角色/场景/道具/世界观/导入整篇小说/导出整项目」按钮组；**世界观概览卡**（世界观文案、区域/地点/已锚定计数、地图缩略、「当前锚点」chips、音乐方向、管理世界观按钮）——历史源码无此页，闭源后新增 |
| **导入整篇小说模态**（现行版截图）【判断：本次调研最好的「预期管理」UX 范例】 | 左列：剧集名称（预填「第 2 季」）、目标集数（「留空自动拆分」）、单集目标时长（30s/60s/2min/5min/自定义）、导入文件（.txt/.md + 「如果文本编码异常，建议直接粘贴正文」）、正文 textarea（字数统计）；右列三张说明卡 | 「导入后会发生什么」（识别片段与主线→规划分集；每集生成可编辑草稿；**不会直接生成分镜/角色图/视频**）、「当前导入策略」（输出语言/时长/沿用项目视觉风格/拆分策略）、「建议文本形态」（章节标题更稳、纯长文可处理、超长先剧情提炼）；底部「取消 / 开始拆分并生成分集草稿」 | 把 AI 拆集的不确定性写进面板，明确「导入≠自动出片」 |
| Phase 01 剧本与故事 | 左配置列（项目标题、输出语言中/英/日/法/西、目标时长档、分镜生成模型下拉带每模型一句卖点 + `ID:` + 「在模型配置中可添加更多模型」、视觉风格 chips 含 emoji/「点击放大」/**「上传图片反推风格」**、质量控制开关「启用分镜质量校验与自动修复（推荐）」）+ 右剧本编辑器（「+ AI续写」「AI改写」、MARKDOWN SUPPORTED 角标、选段改写/撤回改写、底部「N 字符 / N 行 / 已自动保存」） | 选段改写需先选段落（空态「请先在下方选择段落」）；字数上限「建议单集长度 ≤ 8000 字符」超限阻断并建议拆分多集 | 现行版「剧本创作」截图另有角色视觉描述卡（Core Identity/Facial Features/Hairstyle/Clothing/Pose & Expression/Technical Quality 六段式英文提示词结构） |
| Phase 02 角色与场景 | 页头 assets & casting + 计数（5 CHARS / 8 SCENES）+ 当前模型徽标；资产卡（参考图位生成/上传、PromptEditor 内联编辑、负向提示词、批量生成、`WardrobeModal` 衣橱多造型 + Base Look、`TurnaroundModal` 九宫格造型、形体参考图） | 批量生成 3s 间隔限速 +「正在批量生成资源...」进度层；`CharacterSyncBanner`/`AssetSyncBanner`「库资产已更新，是否同步到各集」；空态「请先完成 Phase 01 剧本分析」（阶段门禁） | 场景卡维度 Environment / Lighting（色温 5200K/3200K）/ Composition（焦段 24mm） |
| Phase 03 导演工作台（2048 行 + 11 模块） | 页头「导演工作台 DIRECTOR WORKBENCH」+「AI增强提示词」开关 + 进度「2 / 32 完成」+ 主按钮「批量生成首帧」（全部完成后变「重新生成所有首帧」）；主体镜头卡网格（SHOT 001…，卡头左编号右运镜名 DOLLY/OTSHOULDER/CANTED/CIRCULAR/组合运镜，大图预览 + 绿色「▶ VIDEO」徽标 + 卡底叙事动作摘要） | 右侧「镜头详情」抽屉：编号+运镜名、上一/下一切换、角色 chips（造型下拉「基础造型」+ 添加角色）、「叙事动作」可编辑 + AI ✨、「视觉制作」+ AI 增强开关、「起始帧」大图 + 重新生成/上传、End Frame 对称区块 + 绿色「← 续接」按钮（继承上一镜头 End）、视频区（模型/时长/生成/重试/内嵌播放器）、九宫格入口（4/6/9 格、描述翻译/按指令改写、裁切单格作首帧）、配音面板（旁白/对话、音色、wav/mp3） | 空态「暂无镜头数据，请先返回阶段 1 生成分镜表。」 |
| Phase 04 成片与导出 | 状态卡（「渲染与导出 / 状态：进行中」、镜头数、预估时长、目标时长、渲染进度%）+「序列总览」时码条 `SEQUENCE MAP TC 00:00:00:00` +「预览校验」（「快速检查镜头顺序与生成完整度，避免导出后再返工」）+ 导出设置（母版拼接 vs 分镜 ZIP、质量档位省流/均衡/高画质）+ 剪辑工程（「导出 NLE 工程模板（PR/FCP/达芬奇）用于协同制作」）+ 源素材 + 数据备份 + 渲染日志 | 导出报错降级路径（浏览器不支持拼接→提示改用 ZIP） | — |
| Phase 05 提示词管理（453 行 + 8 模块）【判断：把「生成不稳→回溯上游提示词」做成一等公民页面】 | 标题「集中查看、检索并编辑角色/场景/道具/关键帧的提示词」；顶部计数条（总条目/当前结果 + 分节计数）；CollapsibleSection 折叠分节（Template/Character/Scene/Prop/Keyframe） | 每条 PromptEditor 编辑/保存/**History 抽屉回滚**（30 条上限、source 标签）；StatusBadge | — |
| 模型配置弹窗【现行版截图目视】 | 标题「模型配置 MODEL CONFIGURATION」；tab 全局配置/对话/图片/视频模型；置顶推广卡（推荐 API + 立即购买/使用教程）；全局 API KEY 掩码输入 + 绿色「API Key 已配置」+「清除 KEY」「验证并保存」；「配置说明」四条含**「所有配置仅保存在本地浏览器，不会上传到服务器」** | 历史版另有每供应商独立 Key（`getApiKeyForModel` 优先 provider.apiKey） | — |
| 账号中心 `/account`【实机】 | 「账号中心 / ACCOUNT CENTER」+ 刷新数据；未登录空态「登录账号 — 先完成登录，再进入充值、令牌管理和使用日志。」 | 对接 new-api 协议（额度/令牌/充值/订阅）——AntSK 商业账号体系内嵌 | — |
| **CutOS 剪辑**（现行版独有，闭源后新增；截图目视） | 顶栏「← 返回 / 第 1 集 / 1920×1080 · 24 fps / 已保存」；左面板 tabs 媒体/效果 + 添加本地媒体/从当前项目资产添加 + 缩略图网格（时长角标）；中央监视器（3×3 镜头联络表 + 时间码 00:00:00→00:00:38 + 走带）；右面板「**AI 剪辑助手**」聊天（欢迎语「我可以帮你分割、裁剪、删除、移动片段，也可以应用效果。直接告诉我你想怎么剪就行。」+ 麦克风输入）；底部多轨时间线（4 轨，静音/锁定/显示，片段「镜头1…镜头4」，工具条剪刀/删除/撤销/重做/复制/粘贴/另存为 + 缩放适配/100%） | 历史源码无 CutOS 代码；HEAD `docker-compose.yaml` 的 `cutos-api`（8789，`DASHSCOPE_API_KEY`）与之对应 | 【判断】AI 指令驱动粗剪时间线是该产品线最新差异化点，也是与 ToIV 时间轴最直接的对照物 |

视觉【源码+实机】：双主题语义令牌（暗色底 `#050505`/边 `#27272a`/强调靛紫 `#818cf8`/状态色四枚/主按钮白底黑字；亮色自称「Claude 风格」暖米底 `#F7F5F0` + 暖棕 `#B5936B`）；字体 Inter + JetBrains Mono（数字/ID/时码 mono 小号大写字距如「SHOT 001」）；圆角 `rounded-lg/xl/full` 统计 + 玻璃层 `glass-panel` blur 12px；lucide 线性图标；标题「中文标题 + 小号英文副标」双语层级；右下「已保存/已自动保存」。响应式：**非响应式桌面应用**（<1024px 整页 MobileWarning），官方截图均 1920/2560 宽。a11y【源码】：全 components 仅 4 处 `aria-*`，无系统性键盘导航/焦点管理/对比度专项。空错态完整（空项目库/暂无资产/阶段门禁/暂无镜头/请先选择段落/0/0 计数/账号未登录引导/导出降级 ZIP/刷新残留 generating→failed 清理）。

**局限与反模式**：① **源码闭源断层**（见版本形态声明）；② 许可证自相矛盾（README/schema-org 写 CC BY-NC-SA 4.0，LICENSE 文件是自定义 BigBanana Community License 1.0——均禁商用但口径混乱）；③ 技术债：Tailwind CDN（离线/被墙即裸奔）、`index.html` 残留 aistudiocdn importmap、`videoModel` 硬编码枚举、API Key 存 localStorage（XSS 可窃）、图片 base64 进 IndexedDB（仅视频走 OPFS）、**零自动化测试**（仅有构建前 UTF-8 校验；质保靠手测清单文档）；④ 隐私叙事张力：宣称数据全本地但内嵌百度统计（`hm.baidu.com`），账号中心绑定 AntSK 商业体系；⑤ 单机单人（协作仅文件级导入导出）；⑥ 移动端直接拒绝服务；⑦ 强依赖单一聚合网关（AntSK）语义（sora/veo 分支、媒体域名白名单）；⑧「全自动一句话出片」与「可控工业化」宣传话术并存（README 两种都有），实际交互以人工微调为主。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | BigBanana 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 生成状态机 + 断点续跑（资源级 status 持久化、checkpoint + 输入指纹） | `types.ts`、`App.tsx:29-78` | **已有**（任务幂等/自愈多层） | **不重做**；可借鉴「输入指纹避免无效重算」进 SVML 导入→分镜拆解 |
| **提示词版本历史与回滚**（source 标注 + 30 条上限 + 集中提示词管理页） | `promptVersionService.ts`、`StagePrompts/` | **部分**（Go 有 ShotRevision 存 prompt；Studio 线无修订史、无 diff UI） | **§5 P1 Studio 提示词修订的主参考**（含「提示词台账」排查页） |
| RenderLog 成本审计（每次调用记模型/token/耗时/成败，UI 可查） | `renderLogService.ts`、StageExport 渲染日志 | **部分**（有 usage 计数与 Job 日志） | §5 P1 渲染前成本预估 + §5 P0 任务中心成本面板 |
| ArtDirection 全局美术指导文档（先生成再注入所有视觉提示词） | `types.ts:304-334`、`visualService` | **部分**（style_presets/effect_presets） | P1 项目级「视觉风格锚点」与场景锚点互补 |
| 镜头续接 End→Start + 衣橱变体按镜头选择 | `docs/shot-continuity-feature.md`、`Shot.characterVariations` | **部分**（keyframe_chain/outfit_state 有） | P1 帧继承与多服装参考、连戏检查 |
| 质量闸门两段式（生成前 lint 阻断 + 生成后加权评分与自动修复） | `promptLintService.ts`、`qualityAssessmentV2Service.ts` | **部分**（qa_gate/scene_gate/sheet_gate 有） | 补「关键帧执行/资产覆盖/连戏风险」维度 |
| 九宫格/多视角双用（分格描述→整图→裁切单格作首帧，4/6/9 可配） | `NineGridPreview.tsx`、`TurnaroundModal.tsx` | **部分**（toonflow_board 四视图模板；无裁切单格作首帧） | P2 参考板/分镜预演交互 |
| **小说导入预期管理面板**（「导入后会发生什么/当前策略/建议文本形态」三卡） | 现行版 `images/导入整篇小说.png` | **未见**统一预期管理 | **§5 P0 跨集对账与 §4 空载错的直接文案参考** |
| 交付物矩阵（母版/分镜 ZIP/源素材 ZIP/**NLE 工程模板 PR/FCP/达芬奇**） | `exportService.ts`、StageExport | **部分**（剪映导出已有；EDL 仅 transcript 链） | §5 P2 创作台全量多轨导出（NLE 模板方向）**不重做剪映** |
| 项目/剧集/集三级 + 库资产版本 syncStatus（synced/outdated/local-only） | `characterSyncService` | **部分**（ProjectUnit chapter/episode 有；无 syncStatus 台账） | §5 P0 跨集资产对账的同步状态轴 |
| 模型注册表（供应商/模型/独立 Key/默认） | `modelRegistry.ts` | **部分**（双源） | §5 P2 模型能力单源（只取 UI/结构） |

**许可边界**【源码文件事实，非法律意见】：根 `LICENSE` = **BigBanana Community License 1.0**（自称 source-available、**非 OSI**）：允许个人/教育/研究/测试等**非商业**用途、修改与非商业分享；**禁止**商业活动/付费服务/出售/商业分发/**作为 SaaS/托管/白标对外提供**/**企业内部生产经营性使用**；商业权利（私有化部署、OEM、生产支持）需另行书面授权（antskpro@qq.com）。商标/品牌（BigBanana、AntSK、logo、域名）不授权。**注意不一致**：README 与 `docs/schema-org.json` 声称 CC BY-NC-SA 4.0；无论按哪份**均禁止商业使用**。**并码注意**：不得将本仓库（**含 git 历史中的源码**）复制/改造进 ToIV 产品代码或对外交付物；内部研究/评估属许可允许范围，产出应为独立实现；截图、logo、品牌名、文案不得直接使用。若确需源码级复用或部署其镜像须先取得商业授权。

**运行验证边界**【实机，注意均为**历史版（`556824c4207c4582325f01e6c6546a3df22b403f`）SPA**】：`npm ci` + `vite :5199` + Playwright 走查（屏蔽 hm.baidu.com）：无后端无 Key 完整启动渲染（IndexedDB 零后端依赖成立）；Onboarding 引导实见（可跳过）；空态与阶段门禁文案真实存在（「请先完成 Phase 01 剧本分析」「暂无镜头数据，请先返回阶段 1 生成分镜表。」）；390px 触发 MobileWarning 整页拦截（与源码一致）；全站中文、暗色背景像素 `#050505` 与令牌一致、右下「已保存」可见；内嵌百度统计确认。官方截图 16 张：macOS 预览目视 7 张关键图 + 其余 OCR（chi_sim+eng）。**未实机验证**：在线版、官方 Docker 镜像 `*-3.4.2`、Electron 桌面端、AI 生成链（需外部 Key）；现行版能力（世界观/小说导入/CutOS）只有截图/README 证据。历史 docs 51 篇功能文档已读。实测产物在 `/tmp/bb-verify/`（截图与走查脚本，正文不依赖）。

**关键源码证据路径**：HEAD（文档仓）`shuyu-labs--BigBanana-AI-Director:` `README.md`、`README_EN.md`、`README_JA.md`、`docker-compose.yaml`、`LICENSE`、`LICENSE.zh-CN.md`、`docs/schema-org.json`、`images/*.png`、`images/reference/{4,6,9}-{l,p}.png`；历史快照 `556824c4207c4582325f01e6c6546a3df22b403f:`（`git show 556824c4207c4582325f01e6c6546a3df22b403f:<path>`）`package.json`、`index.html`、`App.tsx`、`types.ts`、`types/model.ts`、`services/storageService.ts`、`services/videoStorageService.ts`、`services/ai/`、`services/{modelRegistry,promptTemplateService,promptVersionService,promptLintService,qualityAssessmentV2Service,assetMatchService,characterSyncService,exportService,renderLogService}.ts`、`components/{Dashboard,ProjectOverview,StageScript,StageAssets,StageDirector,StageExport,StagePrompts,ModelConfig,NewApiConsole,Onboarding}/`、`components/StageDirector/{cameraMovementGuides,NineGridPreview,ShotWorkbench,KeyframeEditor,VideoGenerator,DubbingPanel}.tsx`、`public/styles/theme-dark.css`、`docs/shot-continuity-feature.md`、`docs/loading状态持久化修复.md`。


### 3.9 AI Movie Studio 2（Heroesjouney/AIMovieStudiov2）——电影工艺语义 + 3D 机位 + 可复现配方的工作站

**定位与核心思路**【文档】：浏览器端、**模型无关（model-agnostic）**的 AI 电影制作工作站——设计场景→3D 空间摆机位→AI 生成分镜帧→转视频→配音/音效→时间轴导出；本地 **ComfyUI** 或云 **Fal.ai / Replicate** 双引擎。作者 Nathan McConnell（25 年剧组/虚拟制片背景），目标用户独立电影人/单人创作者。【判断】定位不是「文生短剧一键出片」，而是**把传统剧组分镜/机位/场记语言翻译成 AI 工作流**的专业工具（术语密度高：establishing shot、180° rule、FLF2V、foley、CMX3600）。项目史：v1 功能堆叠导致界面混乱，v2 从零重写为「干净 UI + 顺滑创作流」——这解释了其 UI 一致性明显好于功能清单式项目。设计思路【判断】：「把剧组工序数字化」——Scene=场（带 recipe/定场帧）→ Shot=镜头（带机位+配方）→ take=条 → Timeline=剪辑 → EDL/XML 回传统 NLE；AI 只是执行器，**结构与可复现性优先于一次成片**；prompt 层做模型感知的双格式编译（flat vs H3 结构化），把「模型差异」收敛在编译层而非 UI 层。

**架构与生成/工作链**【源码】：前端 Next.js 14（仅 3 条路由：落地 / 项目列表 / `/project/[id]` 单页工作台）+ React 18 + Zustand 单店（847 行：资产/镜头/场景/驱动/时间轴/undo-redo/markers/track lock/多 job 跟踪）+ three.js/R3F（3D 相机小部件、Previs 舞台）+ Tailwind studio 色板；后端 FastAPI 单体（`app.py` 108 行装配 12 router，CORS `allow_origins=["*"]`）分层 `api/ → core/logic/（prompt_builder 模型感知编译、screenplay_parser）→ core/schemas/ → core/drivers/ + core/workflows/`（20 个 ComfyUI workflow JSON 模板）。**数据持久化 = 文件 Vault 无数据库**（`backend/assets/{project_id}/` 下 project/assets/shots/scenes/timeline/previs.json）；**任务无队列**：生成「请求驱动 + 前端轮询」，视频/音频/渲染 job 用进程内字典 `_video_jobs/_audio_jobs/_render_jobs`（重启即丢），前端 `useGenerationPolling.ts` 用顺序 setTimeout 链 + job_id 级定时器 Map + store 多 job 跟踪实现跨 tab/重挂载续查（CHANGELOG 对竞态修复有长篇记录）。端到端：建 Project → 建 Scene + 挂参考资产「配方」（characters/locations/props + retention 等级）→ 可选导入剧本（Fountain/.txt/.spmd/.fdx，解析场景/日夜/情绪/灯光存为 script breakdown）→ 建 Shot（首镜自动 establishing，后续用 **3D 相机小部件**摆机位或选电影预设）→ 生成分镜帧（自动注入场景上下文 + 多参考图 + `<sks>` 角度标签）→ Shot 详情精修（多角度/prompt 变体/重拍/LoRA/Model override/Steps/CFG）→ Camera Director 出视频（t2v/i2v/ia2v/r2v 四模式 + 23 种相机运动预设 + **续接**（自动抽上一 take 末帧作首帧）+ **Long Take** 多关键帧 FLF2V 拼接）→ Audio（TTS/克隆、音乐、foley）→ 时间轴多轨剪辑 → 渲染 MP4 或导出 **CMX3600 EDL / Premiere XML**。

**最突出的优势**：

1. **电影工艺语义的深度建模**【源码】：11 种镜头类型、15 角度预设、23 运动预设、12 灯光、8 情绪、构图/镜头/灯光 prompt 预设全部以真实摄影术语组织（如 "anamorphic lens, 2.39:1 squeeze, oval bokeh"）；3D 机位小部件内建 **180° 越轴警告**（越轴 ±20° 触发「180°」徽章）——其他 AI 短剧仓库罕见的导演语言层。
2. **可复现、可接续的生成链**：每 shot 持久化 **`GenerationRecipe`**（resolved_prompt/negative/seed/model_id/params/workflow_hash/reference_paths/denoise）——重拍/变体不丢 LoRA 与参数；多 take 管理（`video_takes` 各带 id/path/seed/prompt/模型/相机运动/selected）+ 末帧续接（`last_frame_path`→FLF2V）+ Long Take 关键帧链 + 场景定场帧自动锚定与 `skip_continuity` 逃生口；**retention 四级语义**（fully_preserved/partially/attribute_transfer/weak）直接翻译进 prompt（`RETAINED_DETAIL` 映射）。
3. **模型无关 Driver 架构 + 零代码扩展**：`DriverInfo` 能力元数据（supported_features/max_duration/max_reference_*/supports_loras）驱动 UI 自适应（能力徽章「Max Xs / Neg Prompt / Camera Ctrl / Ref Video…」、参考槽/LoRA 区显隐）；**自定义 ComfyUI workflow 粘 JSON 即注册** + 自动依赖模型体检（`workflows/analyze` → `check-models` 标「In ComfyUI」→ 缺的直接上传对应子目录），新模型即刻出现在所有下拉。
4. **单页专业工作台信息架构**：资产库-检查器-分镜-底部 Timeline/Previs dock，全面板可折叠、dock 可拖高（20–80%）、打开 dock 时分镜自动收成 16×9 缩略图条——在 1440×900 内塞下 NLE + 3D previs + 生成器而不崩（实测）。
5. **工程细节口碑**：顺序轮询防竞态、job 跨 tab 续查、slash-redirect 跨机修复、Docker 默认只绑 127.0.0.1 + 密钥不进镜像（`.dockerignore`）。

**UI 信息架构与逐页/逐区域设计参考**【源码 + 实测】：设计系统（`tailwind.config.ts` + `globals.css`）：暗色 studio 色板——背景 `#0a0a0f`、面板 `#13131a`、边框 `#1e1e2e`、文字 `#e4e4e7`、主强调 **indigo `#6366f1`**；圆角统一 8–12px；动效 fade-in/slide-in/pulse-glow + shimmer 骨架 + glass-panel（头部 `backdrop-blur-md`）；渐变标题 indigo→violet；自定义 range 滑杆/select/滚动条。【判断】典型「AI 工具站」暗色仪表盘风，视觉克制、层级靠边框与透明度而非阴影，密度高（正文 10–12px、`text-[10px] uppercase tracking-wider` 分区标签）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| `/` 落地页 | 居中 hero（16×16 圆角 Film 图标 + 5xl 渐变标题 + muted 两行描述 + indigo 光晕背景）+ 右上登录区 + CTA 双按钮 + 六格 feature 卡（Asset Generation / Storyboard Builder / 3D Camera Director / Video Generation / Audio & TTS / Timeline & Export） | 已登录自动跳 `/projects`；AuthModal 双模态；动画逐级 fade-in + animationDelay | 六卡与真实功能一一对应（无虚标） |
| `/projects` 项目列表【实测】 | max-w-5xl 居中；页头（Film 图标块 + 标题 + UserMenu + New Project）；创建表单为页头下插卡（Name/Description，Enter 提交）；卡片网格 1/2/3 列 | 悬停显现右上箭头；卡底删除（Trash2 + `window.confirm`）；加载「Loading projects...」；空态 FolderOpen 大图标 +「No projects yet」；错误红条；创建中「Creating...」 | — |
| `/project/[id]` 工作台（448 行骨架）【实测】 | 三栏 + 底部 dock，全面板可折叠为 10px 图标条：Header（h-14 玻璃：logo+项目 id \| 连接状态点（绿 pulse=Connected/红=Offline，来自 4 个初始 fetch 成败）→ Timeline/Previs 切换 → Screenplay 导入 → Settings → UserMenu）；左栏 Assets（w-56，MediaLibrary 1230 行：上传/搜索/类型 chips/五分区 Assets·Uploaded 视频·Storyboard Frames·Images·Audio（Voice/Music/Foley/SFX/Other 按文件名正则归类））；左二栏 Inspector（w-420）四 tab；中央 Storyboard；底部 Dock | 资产详情面板：**Design Sheet 生成**（按资产类型模板）+ **Turnaround Pro**（角色五视图，逐视图进度回报）+ **Analyze**（VLM 描述回填）；Uploaded 视频区 take 管理（Select as active/Preview/**Send to timeline**/Delete take） | 窄屏 480px 不破版（`hidden sm:inline` 只留图标）【实测】 |
| Inspector · Generate tab | 资产生成器（812 行）：资产类型 6 类 + **按类型提示词预设**（Hero/Villain/Civilian/Child、City/Interior/Nature/Sci-Fi、Weapon/Artifact、Car/Spaceship、Color Palette/Mood Board、Fire/Magic）+ 画幅 5 档 + Prompt/名称 + 参考资产 + Advanced（LoRA/Model override） | 批量生成（多图逐张 save）+ Ctrl+Enter + 轮询进度 +「Save to asset」 | — |
| Inspector · Shot tab | 选中镜头详情（425 行）：prev/next 导航、帧图、prompt 编辑、Regenerate、Advanced 折叠（Steps/CFG/Megapixels/LoRA/CheckpointOverride）+ 三子面板 MultiAnglePanel（一键 3-4 侧/俯视角变体）/VariationPanel（prompt 变体成新 shot）/RetakePanel（重拍视频 take） | 未选镜头居中空态「Select a shot from the storyboard」 | — |
| Inspector · Camera tab（2810 行） | 视频生成器：头部 shot 缩略 + take 计数（「3 takes」/「No takes yet」）或 Freestyle 横幅；**Continuity Chain 可视化**（上一镜末帧缩略 +「→ anchors first frame」状态文字 + 定场帧「scene identity lock」，`chainWillApply` 着色）；四模式 tab（Text/Image/Image+Audio/Reference）；模型下拉 + **能力徽章**；参考槽（First/Last Frame、参考图/视频/音频）；23 种相机运动预设（带 hint）、画幅 5 档、分辨率档（Draft 0.2MP/Standard 0.4/High 0.6 带「~480p · Fastest」说明）、Style/Framing/Lens/Lighting/Composition 五大下拉（每项值是一段摄影术语 prompt 片段）、Long Take 模式（关键帧卡片 + establishing-frame 自动注入提示 + Skip Continuity） | 生成按钮 + 轮询/耗时器、结果「Continue(↪)」按钮 | — |
| Inspector · Audio tab | 三子页 Speech（TTS + 克隆参考上传 + 20+ 声线）/ Music（风格/情绪/乐器预设 + 歌词 + 时长）/ Foley（15 个音效预设 + 视频选择/上传） | — | — |
| 中央 Storyboard | 场景区 + 镜头条带网格：ScenePanel（708 行，场景列表 + TIME OF DAY/MOOD/LIGHTING 三组 chip + **RECIPE ASSETS**（拖资产入配方，每个资产带 retention 下拉）+ **Screenplay Breakdown**（一键复制台词/动作到剪贴板）+「Sync recipe to shots」+ 删除两段式确认 + Delete all）；Shot 卡（帧缩略 + 重生成 + 拖拽排序 + Duplicate/Delete） | 新建镜头抽屉 ShotCreatePanel（637 行）：描述 + 镜头类型 8 预设 + Style/画幅 + **CAMERA POSITION**（Horiz/Vert/Zoom 三滑杆 + 3D 小部件联动）+ 负面词 + seed（随机钮）+ denoise +「Create & Generate」（Ctrl+Enter）；**3D 相机小部件**（613 行 R3F）：主体 + 相机点 + FOV 锥 + 罗盘 + 前镜角度记忆 + **180° 动作轴线越轴警告** + WebGL 失败自动降级滑杆模式 | 空态「No shots yet → Create your first shot」；**先选场景后「Create new shot」才可用**（未选时 `title="Select a scene first"` 禁用）【实测】 |
| 底部 Dock：Timeline（4964 行 NLE） | SMPTE 时码、走带、Undo/Redo、Split/Copy/Paste/Snap、**转场库拖拽**（Fade Black/White、Cross Dissolve、Wipe，带色点与描述）、画幅预设（16:9/9:16/1:1/4:3/2.39:1 各自分辨率）、缩放、全屏预览、快捷键帮助、质量预设 + **Render to MP4** + 下载、多视频轨 + 多音频轨（音量/lock/solo/mute、ripple delete、unlink A/V group、rename）、markers、clip 波形/缩略、吸附与 junction 拖转场 | — | — |
| 底部 Dock：Previs（11 组件 + 661 行 store） | 左 Outliner（代理对象树）｜中 EditorScene（R3F 3D 舞台：proxy 人形/立方/球/圆柱/锥/平面/环 + transform gizmo）+ 画中画「Through the Lens」实时取景｜右 Shot View（按画幅取景框）+ Inspector（Transform 彩标轴、Shot Camera：Focal Length 可打关键帧标「(animated)」、Aspect、Render Resolution、**Action Axis (180° Line)**）｜底部 Transport（播放/关键帧菱形/保存，多轨相机+对象轨道，AE/Unreal Sequencer 风） | C 键进相机模式、RMB+WASD 飞行、K 打关键帧；渲染 MP4 存项目库并可作为 r2v 运动参考（store `pendingRefVideoPath` 交接） | — |
| 全局弹窗 | SettingsPanel（1039 行全屏模态）：ComfyUI Server（URL/Auth/Models Directory（auto-detected 标注）/LoRAs 目录/Remote 开关）→ Cloud API Keys（Fal/Replicate 掩码）→ Models 列表+上传 → LoRAs 列表+上传+strength → **Custom ComfyUI Workflows**（粘 JSON→分析所需模型→「In ComfyUI」绿徽章/缺则上传）；ScreenplayImportModal（拖拽/粘贴，`.fountain/.txt/.spmd/.fdx` 校验，Preview→Import 两步）；Lightbox（Esc/方向键） | — | — |

空态覆盖全、文案具体（项目/资产分区/无镜头/未选镜头/无 take/场景 recipe「Drag assets here to build the recipe」）；错态：后端不可达时工作台中央大 ⚠「Cannot connect to backend server / Make sure the FastAPI server is running on port 8001」+ 头部红点「Offline」+ 各面板红条 + 轮询 maxErrors 保护【实测】。响应式：项目卡 1/2/3 列、header/tab `hidden sm:inline`、CameraDirector 模式 tab 窄屏只留首词；480px 实测不破版，但整体 `h-screen w-screen overflow-hidden` 桌面工具布局，无移动专用布局。**a11y 弱（反面教材）**：`grep aria-|role=` 前端**零命中**，`.focus-ring:focus-visible` 定义了但组件未用，tooltip 靠 `title`；键盘快捷键丰富（Ctrl+Enter、时间轴全套、Lightbox 键控）。

**局限与反模式**：① **无测试**（pytest 在依赖里但零测试文件，回归全靠人肉 + CHANGELOG 文字）；② 无认证 + CORS 全开 + localStorage 假登录（`AUTH_ENABLED=false` 旁路，密码哈希为自制 JS hash，`docs/AUTH_TODO.md` 自认非加密）——部署到网络等于裸奔；③ 任务状态进程内字典（重启丢任务，无并发上限/队列/成本核算）；④ JSON 文件库无锁（并发写有损坏风险），Roadmap 才列 PostgreSQL 迁移；⑤ 前端体量（工作台首载 458 kB；TimelineEditor 4964 行、CameraDirector 2810 行单组件）；⑥ a11y 缺位 + 小字号高密度；⑦ 配置面复杂（LoRA/模型目录/远程 ComfyUI/自定义 workflow/密钥），与「会用浏览器就会用」宣称有落差；⑧ 外部依赖重（强依赖 ComfyUI + custom nodes + 指定文件名模型权重，复现成本高）；⑨ 依赖清单冗余（moviepy 未被引用）。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | AIMS2 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| **生成配方（GenerationRecipe）随 shot 持久化**（seed/model/params/refs/denoise，重拍变体不丢） | `core/schemas/shot.py`、`routes_shots.py` | **部分**（Job.params 快照有；镜头级 recipe 不持久） | §5 P1 用户配方库 + Studio 提示词修订的底座（P0 级参考源） |
| 场景一致性三件套：定场帧锚点 + 场景上下文前缀（日夜/情绪/灯光→摄影术语映射）+ retention 四级语义→prompt 翻译 | `routes_shots.py:generate_shot_frame`、`prompt_builder.py` | **部分**（场景锚点/冻结快照已有；无定场帧与 retention 翻译层） | P1 补「定场帧」与 retention→prompt 映射 |
| Driver/能力元数据驱动 UI（徽章/参考槽/LoRA 显隐） | `core/drivers/base.py:DriverInfo`、`CameraDirector.tsx` | **部分**（model-capabilities 双源） | §5 P2 模型能力单源的 UI 自适应目标 |
| 末帧续接 + 续接链可视化（「→ anchors first frame」） | `shot.last_frame_path`、CameraDirector Continuity Chain | **部分**（H3 ref2va/fl2va 链路有） | §4 分镜卡「锚来源」明示（P1） |
| 相机语言层（运动/角度/灯光/构图预设即 prompt 片段 + 180° 轴线提示） | `lib/cinematicPresets.ts`、`camera.py`、`CameraAngleWidget.tsx` | **部分**（分镜字段有景别/运镜） | §4 分镜卡运镜/景别选择器（预设词表思路，术语需翻译） |
| 多 take 管理（takes[] 带参数、selected、送时间轴） | `shot.video_takes`、`MediaLibrary.tsx` | **已有**（多候选 pick）；**部分**（无 take 参数对比/送时间轴） | §5 P2 take 对比选优台**不重做多候选** |
| 时间轴导出 EDL/Premiere XML | `routes_export.py` | **部分**（剪映已有；EDL 仅 transcript 链） | §5 P2 创作台全量多轨导出 |
| 自定义 ComfyUI workflow 零代码注册 + 依赖模型体检/补传 | `routes_settings.py:workflows/analyze/check-models` | **部分**（workflow_templates 注入点声明有） | P2 新模型接入自动化（对齐 NAS 模型库） |
| 轮询工程化（顺序链 + job_id 定时器 Map + 跨挂载续查） | `useGenerationPolling.ts` | **部分**（队列 dock 4s 轮询） | §5 P0 统一任务中心 |
| Previs 3D 预演→运动参考闭环 | `previs/`、`pendingRefVideoPath` | **未见** | P3 远期（Camera trajectory→AI conditioning） |

**许可边界**【源码文件事实，非法律意见】：根 `LICENSE` 为 **GNU AGPLv3 全文**（无自定义附加条款；无其它许可文件）。README「Licensing & Commercial Use」：个人/开源开发者可自由使用修改分发，但衍生作品或托管服务须以 AGPLv3 开源；商业闭源集成需购买商业授权（nathan.mcconnell@sandboxentmt.com）。**并码注意**：AGPLv3 对「通过网络提供服务」也触发源码提供义务（第 13 节）——把本仓库代码复制进 ToIV（闭源/内部产品）存在合规风险；**只借鉴设计与交互、重写实现**。随仓第三方（ComfyUI workflow JSON、模型权重引用、Fal/Replicate/Fish Speech）各自许可另计。

**运行验证边界**【运行，本次实测较全】：`frontend/` npm install 成功；`npx next build` **通过**（lint + 类型检查 + 6 静态页；工作台页 358 kB/首载 458 kB）；后端 uv venv + uvicorn :8001，`GET /health` → `{"status":"healthy","version":"2.0.0"}`；前端 `next start :3199` + rewrite 代理正常；**Playwright UI 巡检 14 张截图、控制台 0 条 JS error**：落地页、`/projects` 空态→UI 表单创建项目→跳转、工作台三栏 + 连接状态点 Connected、Inspector 四 tab 逐个渲染、ScenePanel 新建场景、先选场景后「Create new shot」可用（未选禁用）、Timeline/Previs dock/Settings/Screenplay 弹窗均可开、480px 窄屏不破版；后端 API 冒烟（scenes/shots/timeline/screenplay preview/generate drivers）全部 200（Fountain 片段解析 "INT. WAREHOUSE - NIGHT" → `time_of_day=night, lighting=moonlight`）。**未实机验证**：生成链（无本地 ComfyUI、未配 FAL_KEY/REPLICATE_API_TOKEN——Driver 目录运行时只列出本地 ComfyUI 驱动 + 部分音频云驱动：image 7 种/video 3 种/audio 10 种，README 列的 Fal/Replicate 图/视频驱动需 key 才出现）；3D Previs 渲染 MP4 与时间轴 MP4 渲染（依赖 imageio_ffmpeg）；随仓截图未读图。清理：巡检项目已删、`git status` 干净。

**关键源码证据路径**（`Heroesjouney--AIMovieStudiov2:` 前缀）：`LICENSE`、`README.md`、`CHANGELOG.md`、`docs/AUTH_TODO.md`、`DOCKER.md`、`backend/app.py`、`backend/api/routes_{projects,scenes,shots,generate,settings,screenplay,audio,timeline,export,previs}.py`、`backend/core/schemas/{project,scene,shot,asset,camera,style_bible}.py`、`backend/core/drivers/`（base/comfy_*/fal_*/replicate_*/fish_speech）、`backend/core/logic/{prompt_builder,screenplay_parser}.py`、`backend/core/workflows/`、`frontend/src/app/project/[id]/page.tsx`、`frontend/src/lib/{store,useGenerationPolling,cinematicPresets,useAuth}.ts`、`frontend/src/components/camera/CameraDirector.tsx`、`frontend/src/components/shots/{ShotComposer,ShotCreatePanel,ScenePanel,CameraAngleWidget}.tsx`、`frontend/src/components/timeline/{TimelineEditor,DialoguePanel}.tsx`、`frontend/src/components/library/{MediaLibrary,AssetDetailPanel}.tsx`、`frontend/src/components/previs/`、`frontend/src/components/shared/SettingsPanel.tsx`。


### 3.10 AI Story（xhongc/ai_story）——提示词资产化 + 多宫格一致性的故事视频中台

**定位与核心思路**【文档】：「AI 驱动的故事视频自动化生成平台」，输入故事主题→自动完成文案创作、分镜设计、图片生成、运镜规划、视频制作；面向短视频/知识科普/儿童故事/视频原型，从「场景灵感」文案（睡前故事、绘本、宠物宫斗、微短剧、恋爱礼物、梦境）看目标用户是 **C 端内容创作者/家长/自媒体**，而非专业影视团队。工作流（README）：`输入主题 → 文案改写 → 分镜生成 → 图片生成 → 运镜规划 → 视频生成`，全程可暂停/恢复/重试任意阶段。

**架构与生成/工作链**【源码】：后端 Python 3.11 + Django 3.2 + DRF + SimpleJWT + Celery（5.5.0b2 beta 钉版）+ Redis（broker/结果/缓存/pubsub 分库）+ daphne（真 SSE）；开发 SQLite、生产 MySQL（compose）——**文档写 PostgreSQL 与 compose 不一致**。前端双轨：**LinkNow**（用户端画布/生成台，Vite SPA，**仅 `linknow/dist` 预构建产物入库、源码不在本仓**）+ **管理端**（Vue 2.7 + Vuex + webpack 5 + Tailwind/daisyUI）。数据层级：**Series（作品）→ Project（分集）→ ProjectStage（8 类阶段状态机）→ Storyboard → GeneratedImage / MultiGridTile / EditedImage / CameraMovement / GeneratedVideo**；阶段 `rewrite/asset_extraction/storyboard/image_generation/multi_grid_image/image_edit/camera_movement/video_generation`，各带 `retry_count/max_retries=3/error_message`。任务：Celery 按阶段处理器分发 + **`EpisodeTaskQueue` 同作品分集串行队列**（防同剧集并发打爆模型）+ Redis Pub/Sub 频道 + SSE 端点 + 前端订阅组件。特色机制：① **提示词工程化**——每阶段一个 Jinja2 `PromptTemplate`（变量 + `GlobalVariable` 资产注入 + 版本 + 启停 + 模板集克隆/默认），提示词调试工作台（流式跑 LLM 看渲染结果/对比，调试会话落库）；② **强结构化中间产物**——storyboard 要求 LLM 输出 JSON（scenes[] 含 scene_number/narration/visual_prompt/shot_type），运镜独立结构（9 种类型+参数+描述），图生视频显式消费「源图片 + 运镜」两上游并校验依赖阶段完成；③ **多宫格一致性（该仓最独特思路）**——文生图节点一次生成 N 宫格图（2×2 同一角色多姿态/表情）→ 后台按格切片 → `image_edit` 逐张高清还原，**用单图内部一致性保证跨镜头角色一致性**；配套资产抽取（LLM 从剧本抽角色/场景条目并**模糊匹配已有 GlobalVariable 资产**，返回候选+置信度+selected_asset_id）→ `ProjectAssetBinding` 绑定，文生图时资产图转 data URI 注入多模态 prompt；④ **模型供给侧**——执行器白名单 + 动态工厂（OpenAI 兼容/Images/ChatCompletions 图片/ComfyUI/火山图生视频/Mock），内置 15+ 厂商目录（DeepSeek/火山/DashScope/ModelScope/New API/OpenAI/Gemini/xAI/MiniMax/SiliconFlow/OpenRouter/智谱/月之暗面…），支持「按厂商+能力+API Key 批量发现并导入模型」，rpm/rpd 限流、优先级、`ModelUsageLog` 用量（tokens/latency）；⑤ **任务编排**——阶段依赖校验 + 回滚（`rollback_to_stage`）+ 重试/暂停/恢复 + 工作流画布 DAG 引擎（拓扑排序、下游阻断、**结果过期 stale 标记**、幂等键、外部回调去重）；⑥ 导出真实实现是**剪映草稿生成**（pyJianYingDraft：video/audio/text 三轨 + 字幕段 + BGM），`export` 合成端点是 **TODO 空壳**；⑦ 节点级 AI 对话改写节点输出；⑧ MCP 服务暴露「图片生成/产物保存」工具组；⑨ 迁移后自动播种 Mock 供应商与默认提示词集（开发闭环好）。

**最突出的优势**：

1. **提示词资产化 + 版本化 + 调试台**：集/模板/变量/片段/调试会话全链数据化，画布内还能就地改模板并回流节点——同类开源少见的「提示词工程后台」。
2. **一致性方案独特（多宫格 + 资产库匹配绑定）**：低成本角色跨镜头一致性思路。
3. **编排完备**：分集串行队列、阶段回滚/重试/暂停、Pub/Sub+SSE 实时进度、DAG stale/幂等键/回调去重。
4. **模型供给侧成熟**：批量发现导入、每用户厂商凭据、限流、用量日志。
5. **管理端 UI 一致性与质感**【实测】：统一设计语言（胶囊按钮/18px 卡片/三段式/玻璃顶栏/teal 强调/深浅双主题），空错加载态齐备，0 console error，窄屏可用；`AGENTS.md:18-25` 甚至把 UI 一致性写成硬性规范（现成规范文本）。

**UI 信息架构与逐页/逐区域设计参考**【源码 + 实测】：管理端路由权限门（`/models`、`/prompts`、`/assets` **仅 superuser**，否则弹回 `/series`）。全局壳 `Layout.vue`（1004 行）：顶部悬浮 topbar（品牌 chip + 面包屑 + 收起顶栏/主题切换/刷新/用户）+ **左侧浮动胶囊导航 rail**（桌面 5 项：作品/剧本/提示词/资产/模型管理，可折叠为图标+tooltip）+ 移动端 daisyUI drawer（`lg:hidden` 汉堡）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| 全局壳【实测计算样式】 | 玻璃拟态悬浮顶栏（`bg rgba(255,255,255,.9)`、圆角 18px、阴影 `0 18px 40px rgba(15,23,42,.12)`）；`data-card` 18px 圆角 + `rgba(255,255,255,.92)` + 阴影 + padding 24px + 卡间距 20px；主操作 `.primary-action` 胶囊 999px 白底细边 | `sidebarCollapsed/topbarCollapsed/isDark` 存 Vuex 持久化；主题 class `theme-dark`；rail hover 展开 | 标题 `Space Grotesk/Noto Sans SC` 35.2px/600；激活强调 **teal**（`rgba(20,184,166,.16)` 底 + `.5` 边）；间距节奏 16/20/24px；信息结构强制三段式 `card-top/card-meta/card-footer`（AGENTS.md 规定）；`lg`(1024px) 断点 rail↔drawer，390px 窄屏可渲染；图标按钮均有 `aria-label`+`title`、列表卡 `tabindex=0` |
| 登录/注册 | 表单卡片居中，用户名/密码/邮箱 | 提交换 JWT 存 Vuex；错误路径提示；登录跳 `/series` | — |
| 作品 SeriesList（559 行） | 页头（标题+副标题+「新建作品」）+ 筛选卡（搜索+状态筛选胶囊）+ 卡片网格（`data-card`：标题/描述/状态 pill/分集数/时间/操作下拉）+ 空状态 + 分页器 | — | — |
| 分集创建 ProjectCreate（1272 行） | 单集/批量双模式切换；三段式卡片：①归属（必选作品、可选关联剧本→展开剧本分集列表（集数/标题/字数，点选「应用/添加」，批量可导入多集+起始集数））②主题/文案输入 ③提示词集必选、自动命名、分集序号/标题校验 | `field-error`/`error-text` 行内错误 | — |
| **分集详情 = 无限画布节点流**（ProjectCanvas 3394 行，「导演模式」落地形态）【实测】 | 顶部 project-info-node 浮动信息条（分集切换器下拉+搜索+状态、项目状态徽章、更新时间、提示词模板 chip、「资产绑定」抽屉钮、「剪映草稿已生成」提示、流水线操作（运行/暂停/重试，带 loading 态））；两个侧抽屉卡（**模板抽屉**：按阶段 tab 可编辑模板，保存后「刷新画布，流程节点复用最新模板」；**资产抽屉**：勾选 GlobalVariable 资产绑定到项目，图/文缩略预览）；节点组件族（RewriteNodeExpanded 993 行/StoryboardNode 640/ImageGenNode/MultiGridImageNode/CameraNode/VideoGenNode/ImageEditNode/AssetExtractionNode 1345（抽取结果候选资产匹配/确认/生成形象图）/BaseNode 节点壳：状态徽章/标题/端口/操作）；`NodeChatDrawer`（698 行，节点级 LLM 对话改内容）；`FlowCanvas`（缩放/平移控制条 + 缩放百分比） | 节点可拖拽定位（position/width/height 持久化）；SSE 订阅阶段事件节点实时变色 | — |
| 提示词管理（全站视觉基准） | PromptList（971 行）：top-tabs（提示词集/节点结构定义）、搜索、启用+默认双排筛选胶囊、`primary-action` 胶囊按钮、卡片网格（三段式 + 下拉操作「编辑/设为默认/克隆/删除(红色)」）、空状态（empty-hero+hint+副按钮）、分页器 | 深色主题同布局换深底浅字【实测】；PromptSetDetail 按阶段分组模板列表（启用开关、版本、绑定模型）；PromptDebugWorkbench（983 行）：选模板→填变量→流式跑 LLM→渲染结果/对比，调试会话落库；NodeSchemaManager 定义画布节点 schema_config/ui_config/system_prompt | — |
| 资产（Asset）【判断：该项目的「角色/场景设定卡」】 | AssetList（1053 行）：搜索 + 类型（文本/图片）/分组筛选 + 卡片网格（缩略、悬浮删除、类型/分组/作用域徽章）；AssetForm（1222 行）：key/分组/描述/变量类型/作用域（system\|user）/图片上传预览 | 资产可被抽取阶段匹配、被文生图阶段注入为参考图 token | — |
| 模型管理（superuser） | ModelList（960 行）按能力分类（对话/文生图/图生视频/图片编辑）+ 启用开关 + 优先级/限流；ModelCreate（1894 行）双模式向导：「内置厂商导入」（选厂商→能力→API Key→自动发现模型批量导入）/「自定义厂商」三步（来源→默认参数→优先级/限流/启用）；VendorBatchForm 批量导入页 | — | — |

空载/错状态：列表页统一 empty-state（图标+标题+说明+副按钮）；表单行内错误；请求失败 toast + console.error；加载 LoadingContainer/按钮 loading；**SSE 断线无重连提示（弱点）**【判断】。

**局限与反模式**：① **文档与实现漂移**：README 称「项目导出（视频合成、字幕）」实为 **export TODO 空壳**；称 4 种负载均衡实为仅字段、执行处注释「简化版: 使用第一个提供商 / TODO」；AGENTS.md 引用的 `frontend/test_sse.sh` 不存在；CLAUDE.md 写 PostgreSQL 而 compose/依赖是 MySQL；② **许可混乱**（见下）；③ 安全：API Key 明文入库（注释「后续加密」）、部分流式端点 `AllowAny`（靠 query token 校验）、开发配置 `ALLOWED_HOSTS=['*']`+CORS 全开；④ 技术债：Vue2+webpack（EOL）、Django 3.2 EOL、`djangorestframework-jwt` 停维护、Celery beta 钉版、无前端测试、`JIANYING_DRAFT_FOLDER` 硬编码 Windows 路径；⑤ 双前端割裂（LinkNow 源码不在仓内，可审查性差）；⑥ Mock 桩脆弱（按关键词顺序路由响应，storyboard 误回 rewrite 散文导致 JSON 解析失败——实测；也暴露**对 LLM 输出 JSON 解析缺容错/重试修复链**，parse 失败即阶段失败）；⑦ Node/chat、page-agent 与 opencode 强耦合（页面助手在 Layout 中已注释停用）。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | ai_story 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 提示词集/模板版本化 + Jinja2 变量 + 调试工作台（逐阶段启停、克隆、默认集） | `prompts/models.py`、`PromptDebugWorkbench.vue` | **部分**（三套预设并存；Studio 线无修订史） | **§5 P1 Studio 提示词修订 + 用户配方库的主参考之一**（PromptList 三段式视觉可参考） |
| 模型供应商注册表（执行器白名单 + 厂商目录批量导入 + 每用户凭据 + 限流 + 用量日志） | `models/models.py`、`vendor_catalog.py`、`ModelUsageLog` | **部分**（engine_registry 有多机调度） | §5 P2 模型能力单源（ToIV 是自有集群，目录映射内部服务而非外部厂商） |
| 多宫格一致性 + 资产库匹配绑定（抽取→匹配→绑定→注入参考） | `multi_grid_image_*`、`asset_extraction_stage.py`、`ProjectAssetBinding` | **部分**（character-sheet 三视图、apply-to-project 有） | P1 吸收「抽取-匹配-绑定」交互与多宫格切片手法 |
| 分集串行队列 + 阶段回滚/重试/暂停 + **stale 标记/幂等键** | `EpisodeTaskQueue`、`workflows/models.py:489-599` | **已有**（任务幂等）；**部分**（FastAPI 线无 stale） | §5 P0/P1 stale 联动**不重做幂等** |
| 节点画布：节点 10 态、input_mapping/output_schema/latest_output、节点级 AI 对话 | `workflows/models.py`、`NodeChatDrawer.vue` | **部分**（canvas 存在） | P1 apps/canvas 交互语义参考（勿照搬 Vue2 实现） |
| 剪映草稿导出（pyJianYingDraft 三轨 + BGM + 字幕样式） | `core/services/jianying_draft_service.py` | **已有**（`jianying_draft.py` 自写 toiv_jianying_draft_v1） | **不重做**；pyjianyingdraft 库如评估复用须单独核许可 |
| UI 设计语言（胶囊主按钮、18px 卡片/24px 内距、玻璃顶栏、teal 强调、三段式、空态组合、深浅双主题、superuser-only 管理区） | `AGENTS.md:18-25`（现成规范文本）、`Layout.vue` | **未见**统一规范 | §4 横切参考 |
| dev 闭环（迁移自动播种 mock 供应商 + mock API + eager celery） | `projects/signals.py`、`mock_api/` | **部分**（有冒测） | P2 测试夹具设计参考 |

**许可边界**【源码文件事实，非法律意见】：**根目录无 `LICENSE`/`NOTICE`/`COPYING` 文件**；根 README 与 README_EN 声明 **CC BY-NC-SA 4.0**（允许个人学习/非商业、修改与二次创作须同许可、**禁止商业用途**，商业授权联系 408737515@qq.com）；但 `backend/README.md` 写「MIT License」、`frontend/README.md` 写「License: MIT」——**仓库内部声明互相冲突**。【判断】根 README 项目级声明 + 商业授权渠道更像作者本意，子目录 MIT 更像脚手架残留；**冲突未解决前不得按 MIT 使用**。另有 `scripts/check_closed_source_apps.sh` 声明 `backend/apps/{agent,mcp,workflows}` 为「closed-source apps」（发布应仅含 `.so`），本次运行 **exit=1** 即当前 GitHub 树中三者源码是「泄漏」状态——即便整体按 CC BY-NC-SA 计，**闭源标记部分再利用风险更高**。**结论**：该仓**不能视为可自由复制的开源代码**；对 ToIV 只做架构/交互层面独立实现借鉴；若确需复用任何代码，先向作者澄清许可证冲突与闭源范围。

**运行验证边界**【实测】：`frontend` npm ci 成功（680 包）；后端 `uv sync --no-install-package mysqlclient`（**mysqlclient 原生编译失败**，因开发用 SQLite 跳过）；Redis **意外复用了既有 Docker 容器 `ai-movie-redis:16379`**（该端口已被占，隔离意图被偏离，特此声明；仅测试性 queue/cache 键）；`manage.py migrate` 成功（迁移后自动播种 3 个 Mock 提供商 + 默认提示词模板集）+ createsuperuser；Django `runserver :8010` + webpack-dev-server `:18090`；**Playwright 17 张截图（桌面 + 390px 窄屏），所有页面 0 console error / 0 pageerror**，登录（JWT）与路由跳转全部正常；API 实测：登录返回 JWT、创建 Series/Project 成功、`run_pipeline/` 返回 task_id + queue_status=running + pub/sub channel。**主链路 mock 半通**：`rewrite`、`asset_extraction` 阶段被自动跳过（「提示词模板未开启」，默认模板集这两阶段 `is_active=False`）；`storyboard` 阶段失败（Mock LLM 按关键词路由把 storyboard 请求误回 rewrite 散文样本导致 JSON 解析失败）——**属内置 mock 测试桩缺陷，不能据此判定真实 LLM 链路坏**；测试子集 6 tests OK（全仓 21 个 test 文件）。**未实机验证**：真实 LLM/文生图/图生视频供应商链路、MySQL 生产配置、Docker 镜像构建、LinkNow 前端（仅预构建产物）、剪映草稿实际写入（开发配置硬编码 Windows 路径）。官方截图未逐张目视。运行状态总评：「可运行、UI 全面可用、主链路 mock 半通」——**生成链未实机走通**。

**关键源码证据路径**（`xhongc--ai_story:` 前缀）：`AGENTS.md`、`CLAUDE.md`、`README.md`、`backend/apps/projects/{models,tasks,views,services,signals,utils}.py`、`backend/apps/content/processors/`（llm_stage/text2image_stage/multi_grid_image_stage/image_edit_stage/image2video_stage/asset_extraction_stage）、`backend/apps/prompts/models.py`、`backend/apps/models/{models,vendor_catalog,services}.py`、`backend/apps/workflows/{models,services}.py`、`backend/core/services/{jianying_draft_service,multi_grid_image_service}.py`、`backend/core/ai_client/factory.py`、`backend/apps/mock_api/views.py`、`docs/PROMPT_MANAGEMENT_DESIGN.md`、`backend/docs/MULTI_GRID_IMAGE_WORKFLOW_PLAN.md`、`frontend/src/router/index.js`、`frontend/src/views/Layout.vue`、`frontend/src/views/prompts/PromptList.vue`、`frontend/src/views/projects/ProjectCreate.vue`、`frontend/src/components/canvas/ProjectCanvas.vue`、`frontend/src/components/canvas/NodeChatDrawer.vue`、`scripts/check_closed_source_apps.sh`、`docker/frontend.Dockerfile`、`linknow/dist/`。


### 3.11 CineGen ShortDrama（UllrAI/CineGen-ShortDrama，CineGen AI Director）——首尾关键帧驱动的浏览器导演台（演示级样本）

**定位与核心思路**【文档】：「在浏览器中运行的 AI 漫剧、动态漫画、解说漫、影视分镜与短剧制作工具」，流程「剧本 → 角色与场景资产 → 镜头关键帧 → 视频片段」，用 Google Gemini 做剧本/图像、Veo 做视频片段。【判断】目标用户是个人创作者/小团队（单机、自带 Google API Key、浏览器即全部运行时），定位「AI 导演工作台」型创作工具而非多人协作生产管理平台；README 提及商业托管平台 AniKuku（同一团队 SaaS 变现出口），带 Star History 与折扣码 `CINEGEN50OFF`——是 AniKuku 的开源引流件。**演进线索**【git】：代码主体 2025-11-27 一次性上传，此后多为 README 编辑；两次实质修复之一 `e0f620b`（2026-07-08）修了「`generateShotList` 不初始化 `interval` 导致**导演台永远无法触发视频生成、导出进度恒为 0**」等真实缺陷——**早期核心链路是断的，2026-07 之后才可用**；`metadata.json` 与 `index.html` 的 aistudiocdn importmap 是 Google AI Studio 应用清单遗留（大概率由 AI Studio 起步生成后转普通 Vite 仓库）。

**架构与生成/工作链**【源码】：React 19 + TS + Vite 6，UI 仅 lucide-react + **Tailwind Play CDN** + Google Fonts；AI SDK `@google/genai` 浏览器直连 Google，**无后端/无 API/无数据库/无登录**；持久化 IndexedDB（`CineGenDB`）+ API Key 存 `localStorage`；任务纯前端 async + `setTimeout` 轮询，无队列。四阶段流水线（无 URL 路由，React state 切换）：Phase 01 剧本（粘贴大纲→选语言（中/英/日/法/西）与时长（30s/60s/120s/300s/自定义）→「生成分镜脚本」一键连跑两个 LLM：`parseScriptToData` 结构化 → `generateShotList` 逐场景出镜头表）→ Phase 02 角色与场景（生成参考图；角色「基础形象 + 多造型变体（Wardrobe）」；批量串行 3s）→ Phase 03 导演工作台（镜头网格 + 480px 详情抽屉；每镜起始帧（必选）/结束帧（可选）；按镜头选造型变体；Veo 从「起始帧」或「起始帧+结束帧」生成视频；批量生成首帧）→ Phase 04 成片与导出（进度 + 时间轴可视化 + 导出按钮——**按钮均为无实现占位**）。数据模型（`types.ts` 全集）：`ProjectState → ScriptData（characters/scenes/storyParagraphs 段落↔场景关联）→ Shot（sceneId/actionSummary/dialogue/cameraMovement/shotSize/characters/`characterVariations`（镜头级造型映射）/`keyframes[]`（start\|end）/`interval`）`；**首尾关键帧是一等公民**（`VideoInterval` 把「首帧→尾帧→时长/运动强度→成片」绑在同一镜头）。模型编排【源码】：剧本结构化/分镜/视觉提示词用 `gemini-2.5-flash`（JSON responseSchema 全字段约束、输入截 30000 字符、输出 8192 token）；分镜**逐场景串行**（BATCH_SIZE=1、场景间 1.5s）、每场景限 **6-8 镜**防 JSON 截断、`visualPrompt` 要求英文 ≤40 词省 token、**强制覆盖 `sceneId` 防模型幻觉**、收尾统一重排镜头 id/归一化关键帧 id/初始化 interval；图像 `gemini-2.5-flash-image`（「Nano Banana」）**多参考图内联**（约定「第一张=场景/环境参考，其后=角色参考」）；视频 `veo-3.1-fast-generate-preview`（首帧→i2v 或首尾帧模式；硬编码 720p/16:9；长轮询每 5s **无超时无取消**；返回视频 URI 并**拼 `?key=API_KEY`**）；重试 `retryOperation`：429/quota 指数退避 2s·2^i 最多 3 次。**单一供应商全托管（Google），模型名硬编码**，无多供应商路由、无成本换算。

**最突出的优势**：

1. **首尾关键帧驱动的镜头控制模型**：起始帧必选/结束帧可选、**无尾帧自动降级 i2v**（UI 明示「* 未检测到结束帧，将使用单图生成模式 (Image-to-Video)」）——把构图/转场控制从提示词层提升为数据结构与 UI 一等对象。【判断】这是该仓库最值得研究的设计。
2. **角色一致性最小完整闭环**：资产参考图 → 出图时「场景图优先 + 角色图按镜头变体注入」（`getRefImagesForShot`）→「基础形象 + 造型变体 + 镜头级变体选择」三层；变体生成自带「Keep facial features consistent with reference」提示。
3. **结构化生成链防崩坏设计**【判断：教训驱动的务实工程细节，比多数同类 demo 扎实】：JSON schema 约束、输入/输出截断、每场景 6-8 镜上限、幻觉字段强制覆盖、失败显式抛错、429 退避 + 串行节流。
4. **单页四阶段 IA 清晰、桌面 UI 完成度高**：阶段侧栏 + 统一工具条（标题 + 英文副标 + 计数 chip）+ 镜头网格⇄480px 详情抽屉（上下镜头切换）+ 批量遮罩 + 自动保存指示器。

**UI 信息架构与逐页/逐区域设计参考**【源码 + 实测】：应用三态（无路由/深链/后退）：API Key 门 → Dashboard 项目库 → 工作区（固定 288px 侧栏 + 阶段主区）。侧栏四项 `剧本与故事 Phase 01 / 角色与场景 Phase 02 / 导演工作台 Phase 03 / 成片与导出 Phase 04`（激活态左侧 2px 白边 + `bg-zinc-900/50`）+ 底部「系统设置」**纯装饰无 onClick**。视觉体系【实测计算样式】：近黑工业风 `#050505`/`#0A0A0A`/`#121212` 层级、边框 zinc-800、强调 indigo-500/600、**主 CTA 反白**（白底黑字 8px 圆角）；字体 Inter + JetBrains Mono（数据/标签 mono）；大量 `text-[9px]/[10px] uppercase tracking-widest` mono 小标签 + 中文标题配英文副标（「导演工作台 / Director Workbench」）双语混排；卡片圆角 12px、按钮/输入 8px；自定义 6px 方形滚动条；**动效大面积失效**（`animate-in fade-in zoom-in-95` 等在 Tailwind CDN 下无对应 CSS 规则，`animation-name: none`——源码动画实际是 no-op【实测】）。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| API Key 门【实测】 | 全屏 `#050505` + indigo/zinc 模糊光斑；居中卡片（`#0A0A0A`、rounded-xl、shadow-2xl）：白方块 Key 图标 + 标题 + mono「AUTHENTICATION REQUIRED」→「GOOGLE GEMINI API KEY」password 输入 → 中文计费提示（「需要 Gemini 2.5 Flash 及 Veo 权限…已开通结算…」）→ 白色主 CTA「Confirm Access →」（空值 disabled）→ 盾形「Key is stored locally in your browser」；底部悬浮 HomeLinks 药丸（GitHub \| anikuku.com） | **无 Key 格式校验**（任意假 Key 直接进入）【实测】；无错误态 | — |
| Dashboard 项目库【实测】 | 页头「项目库 / PROJECTS DATABASE」+ 白色「新建项目」；卡片网格 1→4 列：`Create New Project` 虚位卡（中央加号方框）+ 项目卡（高 240px：Folder 图标 → 标题 line-clamp-1 → 阶段徽章（剧本阶段/资产生成/导演工作台/导出阶段）→ logline 引文（line-clamp-2 + 左边线）→ 底条（日历图标 + zh-CN 日期 + chevron）） | hover 边框变亮 + 右上浮现删除按钮；删除点击 Trash → **卡内全屏确认覆盖层**（红色 AlertTriangle 圆徽、「确认删除？/此操作无法撤销。」/取消/删除）；加载 spinner；空库仅剩新建卡；失败 `alert` | 右上另有「Sign Out」（清 Key 回门） |
| Phase 01 剧本（story 视图，双栏） | 左配置栏 384px：项目配置（标题、输出语言 select、目标时长 2 列按钮组 30秒(广告)/60秒(预告)/2分钟(片花)/5分钟(短片)/自定义 + 自定义时长输入「如: 90s, 3m」）+ 白色 CTA「生成分镜脚本」（处理中变灰 + BrainCircuit spinner +「智能分析中...」）；右编辑栏：顶条「剧本编辑器」+「MARKDOWN SUPPORTED」标注（**实为普通 textarea，无 markdown 渲染**）+ 衬线体大 textarea（`font-serif text-lg leading-loose`，预填示例剧本）+ 底部状态栏（`N 字符` / `N 行` / 圆点灯 emerald「已自动保存」/amber「待保存」，1s debounce） | 空剧本/空自定义时长→错误红条 | — |
| 拍摄清单视图（分析产物**只读**） | 顶条「拍摄清单 / Script Manifest」+ 返回编辑；左索引栏 288px（故事梗概斜体衬线、「演员表」、场景列表）；主区按场景分组：sticky 场景头条（超大半透明序号 `01`、地点大写、右 时间\|氛围 mono 标签）→ 镜头行：左列 `SHOT 000` + shotSize/cameraMovement 双徽章；中列 actionSummary + 对白引文（左竖线 + 衬线斜体）+ 角色 pill；右列（仅 xl）「画面提示词 (AI Prompt)」**只读**预览（line-clamp-4 hover 展开） | **整个清单不可编辑**（不能改台词/顺序/提示词）；重生成只能回 story 重跑，而重跑**整体覆盖** `scriptData/shots` → 已生成图/视频资产随之丢失【重要反模式】 | — |
| Phase 02 角色与场景【实测】 | 顶条 + `N CHARS / N SCENES` mono chip；角色定妆区（3:4 图位卡片 2-5 列：无图中央 User 图标 +「生成」；有图右上 indigo Check 徽章、hover「重新生成」、右下 Shirt 圆钮 Manage Wardrobe、底条名字 + 性别 chip + 变体计数 `+N`）+ 场景概念区（16:9 卡：location + time chip + atmosphere） | 「一键生成所有角色/场景」（全部有图后变「重新生成所有…」+ `window.confirm`）；**Wardrobe & Variations 弹窗**（rounded-2xl max-w-4xl max-h-90vh）：左「Base Appearance」（3:4 基础图 + Default 徽章 + visualPrompt 只读）+ 右「Variations / Outfits」列表（80×96 缩略（生成中黑遮罩 spinner）、名称、prompt 2 行、「Generate Look/Regenerate」、删除 X）+ 虚线新增表单（「Variation Name (e.g. Tactical Gear)」+「Visual description of outfit/state...」+「Add Variation」，必填校验 disabled）；批量遮罩（indigo spinner +「正在批量生成资源...」+ 进度条 + `进度: n / total`，串行 3s）；空态「请先完成 Phase 01 剧本分析」 | 变体生成用基础形象作参考 + 面部一致提示；单个失败 `alert`，批量失败静默继续 |
| **Phase 03 导演工作台**（核心页）【实测】 | 顶条 + 完成计数 `x / y 完成`（以 `interval.videoUrl` 计）+「批量生成首帧」（全就绪后变「重新生成所有首帧」+ confirm）；左镜头网格 2-5 列（选中后收窄 2 列）：卡片（`SHOT 01` + cameraMovement 徽章 → 16:9 缩略（默认起始帧，hover scale-105；无图 ImageIcon 水印 + hover「点击生成」胶囊）→ 右上视频完成绿色 Video 徽章 → 底部 actionSummary 2 行）；选中卡 indigo 描边 + ring + `scale-[0.98]` | 右侧详情抽屉 **480px**（实测）四分区：①场景环境（场景缩略 + 地点/时间 pill + 氛围 + **出场角色行：头像 + 名字 + 造型下拉**（Default Look/各变体名，选中写入 `shot.characterVariations[charId]`））②叙事动作（actionSummary 卡 + 对白块衬线斜体靛蓝引文）③视觉制作（并排两格 16:9：「起始帧 (Start)」（生成/重新生成）与「结束帧 (End)」（空态标注 **"Optional"**）；点图开原图）④视频生成 (Veo)（完成时绿色 `● READY`；有片 `<video controls>`，无片虚线框「PREVIEW AREA」；靛蓝主 CTA「开始生成视频/重新生成视频」（**无起始帧时 disabled + 提示「请先生成起始帧！」**）；底部小字「* 未检测到结束帧，将使用单图生成模式 (Image-to-Video)」） | 空态「暂无镜头数据，请先返回阶段 1 生成分镜表。」；失败 `alert`/批量仅 console |
| Phase 04 成片与导出 | 顶条「成片与导出 / Rendering & Export」+ `Status: READY\|IN PROGRESS` chip；主状态面板（项目标题 +「Master Sequence」徽章 + 统计三格 Shots/Est. Duration/Target + 超大进度数字 `N%` + Render Status（完成率 = 有 videoUrl 的镜头占比））；**Sequence Map 时间轴条（装饰性）**：每镜一段 14 高细条（完成=靛蓝），hover「Shot n」tooltip，时间码 `TC 00:00:00:00` 写死 | **`Download Master (.mp4)` 与 `Export EDL / XML` 均无 onClick 纯占位**；`Source Assets`/`Share Project`/`Render Logs` 三张二级卡**同样无任何交互实现** | 【判断】该页是「产品愿景展示页」而非功能页，引用时务必标注「占位未实现」 |

响应式/可访问性：Dashboard 网格 1→4 列、导演网格 2→5 列（选中收窄）；**`<lg`（<1024px）全屏遮罩封锁**「为了获得最佳体验，请使用桌面浏览器访问」（800px 实测触发）——伪响应式。a11y 偏弱：图标按钮多无 aria-label、9-11px 灰字对比度低、无 focus 可见性定制、无 aria-live 异步播报、破坏性操作用原生 `window.confirm/alert`。

**局限与反模式**：① **假能力/占位 UI**（导出页 5 个入口全空、侧栏系统设置无实现、时间轴不可编辑）——演示型界面与真实能力错位，**最需要点名的反模式**；② **核心控制变量不可编辑**（提示词/台词/顺序只读，只能「重跑整段 AI」，重跑覆盖资产）——与 ToIV「改词重排」能力相反属倒退；③ 安全模型脆弱（API Key 明文 localStorage、**视频 URL 拼 `?key=API_KEY` 并随项目存入 IndexedDB**、vite define 可把 Key 编进 bundle、假 Key 可进门）；④ 任务状态机残缺（`generating/failed` 不落盘、失败静默或原生 alert、视频轮询无超时/无取消/刷新即丢、`interval.duration/motionStrength` 死参数）；⑤ 单机存储无协作（IndexedDB 清站点数据即丢，无导入导出）；⑥ 工程成熟度低（无测试/CI/lint、build 不跑 tsc、Tailwind/Google Fonts CDN 运行时外依、610KB 单包、动效类大面积失效）；⑦ 交互细节（原生弹窗、伪响应式、「MARKDOWN SUPPORTED」名不副实）。

**ToIV 借鉴映射**（对照 toiv-current-audit；定位为**前端交互参考样本，非架构参考**）：

| 借鉴点 | CineGen 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| 首尾关键帧数据模型 +「起始帧必选/结束帧可选、无尾帧自动降级 i2v」语义 | `types.ts:28-44`、`StageDirector.tsx` 双格 + 降级提示 | **部分**（H3 ref2va/fl2va、keyframe_chain 有；无「双格关键帧 + 模式提示」UI 一等对象） | **P0 设计参考**：Studio 分镜卡引入「镜头双关键帧 + 参考图上下文条 + 造型下拉」交互件；渲染入参参考 `Shot{keyframes, characterVariations, interval}` 但**删除死参数、补齐状态机与超时** |
| 角色一致性三层（基础形象→造型变体→镜头级变体选择；场景参考优先 + 角色按变体注入） | `types.ts` variations、`getRefImagesForShot` | **部分**（character-sheet、outfit_state 有） | P1 角色设定卡扩「造型/服装状态」维度 + 渲染入参带有序参考图列表 |
| 生成编排防崩坏套件（schema 约束、6-8 镜/场景、幻觉字段强制覆盖、429 退避 2s·2^i×3、批量 3s 串行、40 词视觉提示词） | `geminiService.ts` | **部分**（有失败重试） | P1 编排参数经验值可直接抄；「强制覆盖幻觉 sceneId」类收尾校验值得吸收 |
| IA：Phase 侧栏 +「镜头网格 ⇄ 右侧详情抽屉（上下镜头切换）」+ 完成计数/状态徽章 | `Sidebar.tsx`、`StageDirector.tsx` | **部分**（drama-shot-board 三投影有） | §4 分镜/镜头卡参考；勿照抄无路由设计 |
| 自动保存指示器（保存中/已保存/待保存，1s debounce）+ 编辑器底部字符/行数状态栏 | `App.tsx`、`StageScript.tsx` | **部分** | §4 创作工作台细节 |

**许可边界**【源码文件事实，非法律意见】：唯一许可文件 `license.md` = **AniKuku Community License (ACL) v1.0**（`Copyright (c) 2026 AniKuku.com`）。要点：① 个人/教育/研究/**非商业**目的使用/复制/修改/分发；② **署名义务**：任何公开使用/再分发/修改/衍生/部署（**含 SaaS 或托管服务**）必须在合理可见位置放两个**公开可访问、不得 nofollow、不得藏于登录墙**的超链接（`https://AniKuku.com` 与源仓库）；③ 修改/衍生须随附许可并保留署名；④ 商业使用且不带署名/去署名/嵌入专有产品不显示出处**须另购商业授权**（CineGen@ullrai.com）；⑤ 禁止移除许可、冒充来源、超范围使用 AniKuku 商标。性质：自定义「源码可见 + 非商业 + 强制署名」许可，**非 OSI**。**并码注意**：ToIV 产品若直接复制其源码/衍生代码（尤其商业产品），默认落入第 2/4 条（要么保留双链接要么商业授权）；「阅读源码、总结设计、独立实现」通常不构成复制，但不提供法律保证，引入前走法务。

**运行验证边界**【实测，非纯静态】：`npm install` + `npm run build` 成功（Vite 6.4.5，产物 610KB 单包有 chunk 警告）；`npm run dev :3499` 启动；**Playwright 1600×950 + 800×900 走查 13 个关键状态留截图**（向 IndexedDB 注入含 2 角色/2 场景/3 镜头的假项目走通全流程，全程未调用任何真实 API、未用真实密钥）：假 Key 可进门（无校验）、自动保存「已保存」、导演台 3 镜头卡 + `0 / 3 完成`、详情抽屉实测宽 480px 四分区、**生成提示词无任何 textarea（promptEditability=false 不可编辑）**、`2 CHARS / 2 SCENES` 计数与 Check 徽章正确、Wardrobe 弹窗占位符一致、导出页 `Status: IN PROGRESS`、进度 `0%`、时间轴 3 段、`Download Master` 置灰、窄屏 800px 全屏遮罩、错误态红色横幅「错误: Failed to fetch」（拦截 Google 域名后点生成）；**实测确认动效缺陷**（animation-name: none）。**未实机验证**：真实 Gemini/Veo 生成链路（成功路径未跑通，仅验证调用入口与失败路径）；随仓 `UI.png` 与外链截图未逐像素目验（视觉描述以源码 Tailwind 类 + 运行时计算样式为据）。外部网络请求仅 Tailwind CDN、Google Fonts、以及点击生成时的 `generativelanguage.googleapis.com`（被主动拦截）。

**关键源码证据路径**（`UllrAI--CineGen-ShortDrama:` 前缀）：`types.ts`、`App.tsx`、`components/Sidebar.tsx`、`components/Dashboard.tsx`、`components/StageScript.tsx`、`components/StageAssets.tsx`、`components/StageDirector.tsx`、`components/StageExport.tsx`、`services/geminiService.ts`、`services/storageService.ts`、`index.html`、`vite.config.ts`、`metadata.json`、`package.json`、`README_ZH.md`、`license.md`、git `e0f620b`（核心链路修复史）。运行截图 13 张存于调研验证产物（`UllrAI--CineGen-ShortDrama-shots/`，验证记录用，正文不依赖）。


### 3.12 Toonflow-app（HBAI-Ltd/Toonflow-app）——无限画布短剧漫剧工具（技能化方法论 + 供应商抽象标杆）

**定位与核心思路**【文档+源码】：「Toonflow 是一款 AI 短剧漫剧工具，能够利用 AI 技术将小说自动转化为剧本，并结合 AI 生成的图片和视频，实现高效的短剧创作」——面向短剧/漫剧/短视频创作者的开源 AI 创作工具：无限画布编写剧本与分镜、管理角色场景素材、生成图片与视频，本地部署、自由接模型、Agent/MCP/插件扩展。端到端流：①文本节点写剧本/人物设定/镜头描述（LLM 辅助）→ ②导入参考图或图片生成节点制作角色/场景/分镜图 → ③连接文本与图片参考、选视频模型与生成模式按镜头生成视频 → ④画布预览/整理/下载。【实测】首页把「一句话灵感 + 附件 + 工作目录 + 模型」直接作为建项目入口（空目录写 `画布1.json`，有 prompt 时挂 `pendingAgentMessage` 进工作区由 Agent 继续）——**「灵感→Agent→画布」是第一入口**。商业化/生态：官方模型中转 TF-Router（api.toonflow.net）、插件市场、赞助商（秘塔 MiniMax H3 等）；README 含成本案例（约 2 小时出 2 分钟成片，约 ¥130）。

**架构与生成/工作链**【源码】：Bun 1.3.14 workspaces monorepo（apps/web|server|desktop|mobile + packages/nodes|tools|ext|teams|providers|skills|mcp）；前端 Vue 3 + Vite + Element Plus + `@vue-flow/core`（无限画布）+ TipTap 3（文档）+ dockview-vue（IDE 分栏）；后端 Bun + Express + Zod（**一个接口一个文件**、路由自动生成、统一 `{code,data,message}`）；桌面 Electrobun、Android（WebView/GeckoView 双内核内置 Bun）；Agent 运行时基于 pi-agent-core/pi-coding-agent（会话 JSONL 落 `.agent/sessions/`、子 Agent 委派、多 Agent 团队）。**数据模型**：非数据库——「项目 = 工作区目录」（Pinia 持久化列表）；**画布 = 工作区内 JSON 文件**（根标记 `"toonflowCanvas": true` + nodes/edges/viewport，`isCanvasFile()` 读 4KB 头探测）；节点输出值模型 `NodeValueMap = {STRING,INT,FLOAT,BOOLEAN,IMAGE,MASK,VIDEO,AUDIO,FILE}`，媒体值 `{url,mimeType}`；节点资产目录 `assets/<nodeId>` 一一对应、删节点按保留集合清理；内置 9 节点（text/image（局部重绘/打光/多角度/全景/变体）/video/audio/生成三件套/**director3dNode 3D 导演台**（three 场景/人偶/运镜/光照/分镜动画/导出/Agent 工具）/**frameAnalysisNode 逐帧拉片**（场景切分/视频分析/AI 分析/产出节点/报告））。**无「角色表/场景表/分镜表」一等实体**——角色一致性靠「资产画布 + 参考图 + 提示词锚点」方法论（技能约定而非数据结构）；分镜由 textNode + 生成节点 + 连线表达（storyboardTeam 提供 director/writer/reviewer 文字分镜协作）。**供应商抽象层**（`packages/providers/types.d.ts` 264 行，值得精读）：`ProviderDefinition` 统一文/图/视/音生成 + `getPrice` 估价 + `getBalance` 余额 + `processMedia` + 更新检查；`protocol ∈ openai-completions|openai-responses|anthropic-messages`；模型自带能力声明（`VideoMode = singleImage|startEndRequired|endFrameOptional|startFrameOptional|text|混合参考`、durationResolutionMap、imageSizes/voices）驱动 UI 收窄；`generateMedia` 统一返回 `MediaAsset[]`「不能返回任务 ID 或原始平台响应」；`ProviderTools` 注入 fetch/hash/image.resize/ffmpeg 等。内置供应商：tfRouter/deepSeek（文本）+ tfRouter/apiMart/metaso(MiniMax H3)/compshare（媒体）；自定义供应商文件可热插拔。任务编排：媒体任务双通道——带 `taskId` 异步（前端共享短轮询批量查 status，每批≤100 uuid）或 SSE 流式（心跳/中断清理）+ 取消；生成结果落盘 `assets/<nodeId>/`，全局素材库与项目工作区分离；FFmpeg 后处理走 tools/ffmpeg（SSE events/progress/cancel）。一致性手段：参考素材多模态输入（firstFrame/lastFrame）、连线传值、引用清单与 @提及、skills 资产锚点方法论、3D 预演锁机位/运镜/光照再生成。成本：节点内价格组件 + 画布右上供应商余额卡（TF-Router 可充值）。

**最突出的优势**：

1. **「无限画布 = 工作区文件」开放数据模型**【源码+实测】：画布/文档/素材全落用户目录普通 JSON/文件（`toonflowCanvas` 标记 + `assets/<nodeId>`），配统一 `useWorkspaceFiles` 入口 + 原子写入——可移植、可版本管理、可被外部 Agent（MCP）读写，「本地部署、数据自有」落到实处。
2. **供应商/模型能力抽象层质量高**：一个接口统一四媒体 + 估价/余额/预处理，模型能力声明驱动 UI 选项收窄——「自由接入模型」不是口号。
3. **Agent × 画布 × 技能闭环（最独特的流程 IP）**【判断】：`packages/skills/v118workflow/SKILL.md` 是**完整的短剧分集制作流水线**（14 步 + 三个确认关口：0 项目初始化→1 来源与章节事件→2 故事骨架→3 改编策略→4 逐集剧本→5 基础资产提取→6 资产图片→7 导演规划→8 衍生资产分析→9 衍生资产图片→10 分镜表→11 分镜面板落点→12 分镜图片→13 视频与交付）；画布约定 `画布/剧本.json`（项目配置/事件表/骨架/分集大纲/剧本）+ `画布/资产.json`（基础/衍生资产、父子关系、视觉设定、提示词、选用图片）+ `画布/分集/第N集.json`（本集剧本快照/导演规划/分镜表/参考素材/分镜图/视频/交付记录）；知识库分层 `references/knowledge/`（scriptCraft/narrativeGenres 12 类叙事技法/visualStyles 11 种美术风格/assetDesign 角色识别锚点/shotCraft/imagePromptCraft/videoPromptCraft），原则：叙事类型与美术风格独立选择、「知识不是额外剧情授权」、**每步必须写回画布并由用户确认**（状态机：草稿/待确认/已确认/生成中/失败/待复核/已跳过）、失败不自动扩大重做范围、**上游改动只标记下游「待复核」**。这套「阶段产出契约 + 确认关口 + 画布留痕」比其 UI 更值得借鉴。
4. **节点即插件的工程边界**：节点/工具/扩展均为独立 UMD 包（脚手架 nodeScaffold/toolScaffold/extScaffold），构建到 `build/*`、安装到 `data/*`、插件市场可装卸；`nodeShared` 提取共用 UI（promptInput/referenceItem/mediaHistory/mediaPrice）。生成节点的「参考素材 + 提示词 + 能力联动参数 + 价格 + 生成/停止 + 历史 + 后处理」交互范式完整可复用。
5. **UI 完成度**【实测】：空/错/加载/禁用态齐备、a11y 标注与 reduced-motion 处理普遍、21 语种 i18n。

**UI 信息架构与逐页/逐区域设计参考**【源码 + 实测】：全局视觉（`main.scss`）：CSS 变量挂 Element Plus + TDesign；`--ui-radius: 8px`（large 12/small 4，设置可覆盖 0-16）；深色默认；卡片/浮层毛玻璃 `color-mix(...) + blur(6px)`；滚动条 6px 圆角；4/8 网格间距；全局组件 messageMarkdown（流式）/videoPlayer/modelPopover（模型+思考强度）/languageSelect/updateBox。路由仅 `/#/hello`、`/#/home`、`/#/workspace`。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| `/#/hello` 引导（449 行）【实测】 | 左右分栏：左「快速开始」卡片 + 右装饰面板（动态背景 + 品牌 logo，深色胶片+奔马逐格动画意象） | 三选一：「登录 TF-Router 自动配置」（内嵌 iframe postMessage 回传 key 自动配置，origin 校验）/「添加私有提供商」/「稍后配置」；设备互联按钮 + 语言切换；登录失败 el-alert + 重试；配置中 loading | 不登录也能「稍后配置」进首页 |
| `/#/home` 首页（1016 行）【实测】 | 可折叠左栏（240↔72px，900px 以下自动收窄）+ 右整页滚动（分区滚动高亮）；顶部创作区：logo +「今天要做点什么？」+ 创作输入卡（大圆角 focus 发光边框；附件拖拽/粘贴、20 个上限/单个 100MB/纯文本 400KB 校验；placeholder 打字机轮播 10 条文案；工作目录选择器 + 模型与思考强度 + 发送） | 项目区 `repeat(auto-fill, minmax(220px,1fr))` 网格：首卡「新建项目/或打开已有项目」（loading 旋转）+ 项目卡（封面取画布预览、名称、最近打开时间）；hover/触屏浮出「重命名/从列表移除（不删文件）」；目录丢失弹「重新选择文件夹」并支持迁移；探索区（行虚拟化作品流 + 分类/搜索/点赞收藏 + 详情/制作过程页）；「发布作品」disabled；未登录错误态「用户信息错误 + 重试」；素材库全屏对话框（树 + 缩略 + 预览 + 右键 + 拖拽 + 保存到素材库表单） | — |
| `/#/workspace` 工作区（651 行）【实测】 | 全屏（100dvh）画布为底；左上「退出项目/设置」卡；顶部居中分段控件「画布/文档」（keep-alive 保留文档实例，`onBeforeRouteLeave` 强制 flush 保存，失败弹「仍然退出/留在项目」）；底部居中工具条；右侧 AI 对话悬浮窗（可停靠） | 画布引擎：缩放 0.2–8、点阵背景、连线严格模式、框选 Partial、自定义快照/撤销、吸附 16px 网格、侧键导航拦截防误退 | 空态**【实测】**「双击画布 自由生成节点」+ 图片/视频/音频生成三快捷按钮 |
| 画布面板组件族 | 左上 `canvasMenu`（项目名内联编辑 + 画布切换树：搜索/新建文件夹/新增画布/重命名/删除/右键 + 右上**供应商余额卡**可展开充值/明细）；左下 `canvasControls`（素材库、整理画布（dagre 自动布局）、小地图开关、网格吸附、连线显示、适应视图、缩放菜单）；底部工具条（添加节点、抓手/移动切换 V/H、搜索节点 Cmd+F、帮助）；节点菜单（441 行多级右键：添加节点→分类；选区操作：副本/整理（水平/垂直/宫格）/删除 N 个；`selectionHandle` 从选区拖出连线松手开菜单）；选区工具条 + 组节点（成组/合并/解组快捷键）+ 剪贴板 + 拖文件建节点 | — | — |
| **生成节点 UI**（videoGenerationNode 523 行为代表，图片/音频同构） | 顶部动作条：提取音轨/分离音视频/截取片段/**逐帧拉片**（创建 frameAnalysis 节点）/媒体历史切换/替换视频；右上「截取当前帧/首帧/尾帧」；主体 videoPlayer 预览（无输出空态相机图标）；底部提示卡（660px）：参考素材列表（首尾帧模式有顺序提示文案）→ 提示词输入（@引用节点输出）→ 模型选择（按供应商分组，无模型提示「请先在设置中添加视频模型」）→ 生成设置 popover（**生成模式**（文生/单图/首尾帧必填/尾帧可选/首帧可选/混合参考）、时长、分辨率（随 duration 联动 durationResolutionMap）、比例按钮组（带比例形状图标）、生成音频开关）→ **价格徽标** → 发送/停止（生成中变停止，AbortController 取消） | 状态归一化：参数在节点内对齐模型能力，Agent 不打开面板也能生成；生成中 `v-loading` + `aria-busy` | — |
| 文档面板 | dockview 多标签 IDE 布局（按工作区持久化）；左侧文件树（新建/刷新/多选/右键）；快速打开、全文搜索替换、「打开方式」对话框（ext 扩展渲染 md/txt/image/media/canvasNode）；**可把画布文本节点当文档编辑并回写**（readNode/saveNode/observeNode 桥接，脏/错误/删除状态同步） | 空态**【实测】**「尚未打开文档 从左侧文件树选择文件或画布节点」 | — |
| AI 对话（floatingAgent 263 行）【实测】 | 悬浮窗可拖动/三向缩放（键盘方向键 16px 步进、ARIA separator）/停靠右侧（挤占画布宽度）；菜单：新建对话、历史对话、媒体生成控制（任务面板）、停靠切换、关闭；子 Agent 会话面包屑 | 空态「你好，我是 Toonflow 助手 / 从一个想法开始」+ 3 建议卡（搭建创作画布/梳理故事分镜/生成图片素材）；输入区：多行 textarea（可拖高）、placeholder「输入消息，长按语音输入，@ 提及节点输出或全局素材…」、模型与思考强度、附件、@提及（可引用画布节点输出与全局素材）、技能选择、**长按语音输入**、上下文用量（进度环 + compacting「正在压缩上下文…」）、发送/停止；消息流 SSE + 工具调用卡片（running/error）+ Markdown 渲染 + 复制/编辑/删除 | — |
| 设置（1080px 对话框，左 160px 分组侧栏） | 10 面板：界面（主题/语言/主色/字体缩放/移动端缩放/圆角/启动动画）、常规（画布快捷键/节点菜单/连线颜色）、文本模型（供应商列表+自定义）、媒体模型（供应商卡（图标/版本/模型数/获取模型/编辑/删除）+ TF-Router 账户卡+充值）、插件市场（1145 行：节点/工具/技能/扩展/Agent 安装管理、MCP 导入/服务器、A2A 设置、FFmpeg 安装、技能编辑器、插件配置表单）、MCP（开关/端口/凭证/复制客户端配置）、设备互联（523 行：二维码/12 位配对码/共享目录/HTTPS 反代说明）、个性化、隐私（匿名统计开关）、开发者选项（供应商调试/系统提示词）、关于 | — | — |

响应式/a11y【源码】：`@media (max-width: 900px/700px/560px)` 侧栏收窄与弹窗收缩；移动端 50–100% 缩放（75% 默认）；大量 `aria-label/aria-pressed/aria-expanded/aria-busy/role=status/alert`、`prefers-reduced-motion` 降级、焦点可见 outline——【判断】可访问性意识在同类创作工具中属上游水平，但仍以桌面宽屏为主（画布操作对触屏是 `isMobile` 分支而非完整触控产品化）。

**局限与反模式**：① **无鉴权**（README 明说 3000 端口无登录，MCP 凭证只保护 MCP 入口，远程部署全靠反代）；② **单进程单例**（conf/mediaTasks/文件占用锁均为进程内，「不支持多进程并发写入同一工作区」，不支持横向扩展/多人实时协作）；③ **零自动化测试（项目政策）**——`AGENTS.md:220-226` 明文「软件测试由软测人员负责，项目代码中不新增测试模块」，CI 只有构建/签名/补丁；④ 纯文件 JSON 无 schema 版本迁移框架（画布节点 data 自由对象），大画布/并发编辑可靠性存疑，assets 清理是启发式；⑤ 构建链对 Bun 版本敏感（**实测 1.2.17 构建失败**，必须 1.3.14）；web 产物 chunk 偏大（5–6MB 级）；⑥ 生态绑定（默认引导强推 TF-Router 登录 iframe、余额/充值内嵌、插件市场需 TF API Key——开源内核 + 商业中转，二开需剥离）；⑦ 「角色/场景/分镜」没有一等数据模型，工具本身不校验一致性——对不读技能文档的用户产出质量方差大【判断】。

**ToIV 借鉴映射**（对照 toiv-current-audit）：

| 借鉴点 | Toonflow-app 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| **生成节点交互范式**：参考素材清单 + @引用提示词 + 模型能力联动参数（mode/时长/分辨率/比例）+ 估价 + 生成/停止 + 历史输出 + 后处理 | `videoGenerationNode/src/index.vue`、`nodeShared/{promptInput,referenceItem,mediaHistory,mediaPrice}` | **部分**（生成面板有；无价格徽标/历史输出切换/能力联动收窄） | **P0**：Studio 出图/出视频面板复刻此范式，参数下拉由模型能力声明驱动；与 §5 P1 成本预估联动 |
| **供应商抽象 `ProviderDefinition`**（文/图/视/音 + getPrice/getBalance + 能力声明 + 协议兼容） | `packages/providers/types.d.ts:194-232` | **部分**（engine_registry；无统一估价/余额契约） | §5 P2 模型能力单源的契约参照（对齐 TOIV_LLM_*/Comfy worker 解析） |
| 画布 JSON 契约（根标记 + nodes/edges/viewport + `assets/<nodeId>` 目录归属与保留清理） | 实测 `画布1.json`、`canvasFile.ts` | **部分**（canvas 存在） | P1 知识图谱画布与分镜画布统一文件格式约定 |
| 任务状态双通道（taskId 异步 + 短轮询批量 status ≤100/批 + SSE + cancel） | `routes/ai/media/{generate,tasks/status}.ts` | **部分**（队列 dock 4s 轮询） | §5 P0 统一任务中心查询/取消口径 |
| **创作方法论技能化**：14 阶段流水线 + 阶段记录节点 + 状态机（待确认/已确认/待复核…）+ 确认关口 + 上游改动只标下游待复核 | `packages/skills/v118workflow/SKILL.md`、`references/knowledge/` | **部分**（workflow 模板有阶段门控；无「阶段产出契约 + 确认关口 + 画布留痕」成文方法论） | **P1**：ToIV SVML→分镜→渲染链沉淀为 Skill 文档供 Agent 执行 + 「阶段确认」交互；状态机（待复核）映射 §5 P0/P1 stale 联动 |
| Agent 工具面 + 画布双向控制 + @提及节点输出 + 会话/子 Agent 持久化 | `packages/tools/*`、`apps/server/src/agent/`、mention 组件 | **部分** | P2 |
| 插件化节点/工具（UMD + 脚手架 + 市场装卸 + 配置表单） | `packages/{nodeScaffold,toolScaffold,extScaffold}` | **未见** | P2（勿照搬「不写测试」政策） |
| 工作区文件 API 与边界校验（统一入口 + 原子写 + 路径授权） | `workspaceFiles.ts`、`utils/workspace/files.ts` | **部分** | P2 项目资产读写层 |

**许可边界**【源码文件事实，非法律意见】：根 `LICENSE` = **MIT**（`Copyright (c) 2026 HBAI-Ltd`，21 行全文），`package.json` 同。README 附**不追溯条款**（v1.0.8 前 AGPL-3.0 用户、v1.0.8~v1.1.8 按 Apache-2.0+附加协议的用户不受本次协议变更约束）——只约束其历史版本用户，对新采用 MIT 版本的使用者无额外义务；如混合使用旧版本代码需另查旧许可。第三方：`apps/mobile/thirdParty.md` 记录 jsQR（Apache-2.0）与内置 Bun 运行时（MIT）。**并码注意**：MIT 允许商用/修改/分发，条件是保留版权声明与许可文本（NOTICE/致谢保留 `Copyright (c) 2026 HBAI-Ltd` 与 MIT 全文）；品牌名/商标（Toonflow、TF-Router）不在 MIT 授权范围，产品化避免冒用。

**运行验证边界**【实测】：`bun install --frozen-lockfile` 成功（949 包；**注意 Bun 版本敏感**：系统 bun 1.2.17 构建 `packages/nodes/*` 失败，须官方 bun 1.3.14 二进制）；`bun run build:server` 成功（构建 nodes/tools/ext → web → server，产物 `build/*`；Vite 有 chunk 过大警告 5.36MB/6.32MB）；启动服务器 `:3457`：根路由 200、`/api/workspaces/list` 返回 `myProject`、`POST /api/providers/models` 参数校验正常、`GET /api/settings/get` 返回 **403「Only Toonflow pages may access the control connection」**（控制类接口有来源/连接守卫）；**UI 实机验证**（隔离 Chrome + 无障碍树/截图 1440×900）：`/#/hello` 引导页（TF-Router/设备互联/私有提供商/稍后配置 + 胶片装饰）、`/#/home` 首页（创作输入卡 + 项目区 + 探索区未登录错误态）、「选择服务器工作目录」弹窗（面包屑/新建文件夹/行内重命名删除）→ 发送自动创建 `data/workspaces/myProject/画布1.json`（内容 `{"toonflowCanvas":true,"nodes":[],"edges":[],"viewport":...}`）→ `/#/workspace` 画布面板（空态 + 快捷按钮 + 画布控制 + AI 对话悬浮面板）→ 「文档」面板（文件树 + 空态）；`data/` 生成 `settings.json`（0600 权限）与目录结构。**未实机验证**：真实模型生成链路（未配任何 Key，媒体生成/Agent 对话/语音/拉片未跑端到端）、桌面 Electrobun 打包、Android APK、设备互联配对、MCP 外部客户端连接、TF-Router 登录/计费；窄屏仅静态审查；随仓官方截图 10 张未逐张打开。**测试**：全仓无 `*.test.ts`/`*.spec.ts`（find 验证为 0）——零自动化测试属项目政策。

**关键源码证据路径**（`HBAI-Ltd--Toonflow-app:` 前缀）：`LICENSE`、`README.md`、`AGENTS.md`、`package.json`、`electrobun.config.ts`、`apps/web/src/router/index.ts`、`apps/web/src/pages/hello/index.vue`、`apps/web/src/pages/home/index.vue`、`apps/web/src/pages/workspace/index.vue`、`apps/web/src/pages/workspace/canvasFile.ts`、`apps/web/src/pages/workspace/panels/{canvas,document}/`、`apps/web/src/components/agent/{index,conversation}.vue`、`apps/web/src/components/floatingAgent.vue`、`apps/web/src/components/settings/index.vue`、`apps/web/src/assets/main.scss`、`packages/providers/types.d.ts`、`packages/providers/index.ts`、`packages/nodes/videoGenerationNode/src/index.vue`、`packages/nodes/{director3dNode,frameAnalysisNode}/`、`packages/nodeScaffold/src/{nodeAi,values}.ts`、`packages/skills/v118workflow/SKILL.md`、`packages/skills/*/references/knowledge/`、`packages/tools/`、`packages/mcp/README.md`、`apps/server/src/{index,app,core}.ts`、`apps/server/src/routes/ai/media/{generate,tasks/status}.ts`、`apps/server/src/agent/runtime/`、`apps/server/src/utils/workspace/files.ts`、`Dockerfile`、`compose.yaml`。


### 3.13 Toonflow-web（HBAI-Ltd/Toonflow-web）——**注意：这是已归档的旧前端**（Toonflow 系历史样本）

**版本形态声明**【实测+文档】：仓库 **已归档**——README 顶部声明「本仓库已归档，不再维护」，前端代码已迁入 monorepo `HBAI-Ltd/Toonflow-app` 的 `apps/web`（即上一章对象）。固定版本 `f270e0352b0148ddb3983357ce3e289cda7d7aa1`（2026-09-24，"docs: 添加仓库归档及 monorepo 迁移说明"），879 commits / 约 8 个月密集开发（2026-01-30 → 2026-09-24）。本仓库**只含前端**（后端与桌面壳在 Toonflow-app），凡涉及后端行为均为「前端推断」。作为历史样本，它的价值在「Agent×画布融合的生成链」与「供应商插件化」两处交互/协议设计，**不代表 Toonflow 现行产品形态**。

**定位与核心思路**【文档+源码】：「AI 短剧工厂的用户操作端」——从小说/剧本原文到成片的一站式创作工作台（登录 slogan「智能短剧创作平台」）。目标用户【判断】：短剧/漫画内容团队与个人创作者（项目类型「基于小说原文 / 基于剧本」二选一）；桌面端打包分发（Electron 壳在 Toonflow-app），带「默认账号 admin/admin123」，偏本地/私有化单机使用。注意命名漂移：hello 欢迎语是「AI 驱动的漫画创作工作流平台」而 README/登录说短剧——产品叙事不统一。

**架构与生成/工作链**【源码】：Vue 3.5 + TS 5.6 + Vite 5.4 + Pinia（持久化）+ Vue Router 4（**hash 路由**）；UI 库 **TDesign**（README 声称 Ant Design Vue/Element Plus/VXE Table 与依赖清单**不符**——README 过期）；关键专用库 `@vue-flow/core`（节点画布）、`@dagrejs/dagre`、`vue-clip-track`（剪辑时间轴）、`@webav/av-canvas`+`av-cliper`（浏览器内视频合成导出 MP4）、monaco-editor、md-editor-v3、mammoth（Word）、socket.io-client。构建为**单文件 HTML**（vite-plugin-singlefile，供桌面壳内嵌）；postcss-px-to-viewport 把 px 全量换算为 rem（设计稿宽 1600）——**等比缩放式伪响应式**。Electron 感知（`fetch("toonflow://getAppUrl")` 探测壳）。后端独立服务（默认 `localhost:10588/api`，登录页可改）；鉴权 `POST /login/login` → token 存 localStorage，路由守卫只查 token 存在与否。实时通道 socket.io 两命名空间 `/socket/scriptAgent`、`/socket/productionAgent`，聊天协议为增量事件 + **XML 标签流式解析**——Agent 输出流中的 `<script>` `<scriptPlan>` `<storyboardTable>` `<storyboardItem>` 被截获**直接写入画布数据**；且有**反向 RPC**（socket 上后端调前端 `getFlowData/addDeriveAsset/delDeriveAsset/generateDeriveAsset/generateStoryboard/addStoryboard`）——LLM Agent 能直接驱动 UI 数据增改与批量生成。生成任务状态机（前端四态）「未生成 | 生成中 | 已完成 | 生成失败」+ 5s 轮询（in-flight 防重与自动启停）+ 全局任务表。端到端流：建项目（类型/图片视频模型/画幅/清晰度/**视觉手册+导演手册**）→ 小说导入（Word/粘贴 → 正则切章 → 事件分析 LLM 抽事件线）→ 剧本（批量导入/提取资产（LLM 抽 role/scene/tool，extractState 状态机））→ 剧本 Agent（30/70 分栏对话式改写计划，含「强制生成」兜底卡、记忆管理、思考等级）→ 塑角造景（批量提示词 polish → 批量出图 1K-4K → 批量绑定音色）→ 视频生产（VueFlow 固定 DAG `script → scriptPlan → storyboardTable → storyboard → workbench`，旁挂 `script → assets`；Agent 通过 XML 流填充各节点；分镜节点批量出图 + **帧间「插入补帧」**（相邻两帧作参考生成中间帧）+ 生成式图像编辑画布（upload/generated 节点连线做参考编辑））→ 工作台弹层三 tab（**快速预览**动态故事板播放器（按分镜时长逐格播放、分段进度条）/ **视频生成**（参考图优先级 assets>storyboard>无图 + 模型模式菜单 + 提示词卡 contenteditable `@` 引用素材 + 多轨道）/ **视频剪辑**（媒体库 20% | 预览 60% | 属性 20% + 时间轴 40%：vue-clip-track 多轨、吸附、转场、滤镜、trim/split、撤销重做；@webav 浏览器内导出 MP4））。**供应商插件体系（最大特色之一）**：`lib/vendorTemplate.ts` 可脚本化 VendorConfig——id/版本/作者/inputs/models[]（TextModel(think)/ImageModel(mode: text|singleImage|multiReference)/VideoModel(mode: 单图|首尾帧|多参考图/视频/音频, durationResolutionMap, audio)/TTSModel(voices)）+ 适配器函数（textRequest/imageRequest/videoRequest/ttsRequest）+ 工厂（createOpenAI/createDeepSeek/createZhipu/createAnthropic…）+ 运行时工具（zipImage/mergeImages/pollTask）；设置页可添加/启停/**测试供应商**（文字/图片/视频三类测试台）——**不改前端代码即可接任意 OpenAI 兼容或自定义 API**。一致性四件套：项目级「视觉手册/导演手册」（风格参考图+Markdown 文档+提示词，随项目下发）+ 资产（role/tool/scene/clip）+衍生图（derive 多视图）+ 分镜↔资产绑定（associateAssetsIds）+ 相邻帧补帧 + 角色绑定音色。

**最突出的优势**：

1. **Agent×画布融合的生成链**：socket 流式 XML 标签把 LLM 输出直接落进 DAG 画布数据 + Agent 反向 RPC 增删分镜/触发批量生成——「对话即编排」而非纯表单。
2. **供应商插件化（vendorTemplate）**：声明式模型能力矩阵 + 适配器函数 + 测试台，换模型/换厂商不动业务代码。
3. **全链路一致性资产设计**：视觉手册/导演手册项目级风格锚、资产+衍生图、分镜-资产绑定、相邻帧补帧、角色-音色绑定——把「人物/风格一致性」拆成可操作的产品对象。
4. **浏览器内视频剪辑与导出**（@webav + vue-clip-track）：多轨、转场、滤镜、trim/split、撤销重做，成片不离本地。
5. **任务/状态反馈细**：统一四态 + 轮询 + 失败原因 tooltip + 可取消 + 全局任务中心；网络异常给可执行排障文案（「以管理员身份运行/检查后端/装 VC++ 运行库」）。

**UI 信息架构与逐页/逐区域设计参考**【源码 + 实测】：全局壳（`pages/workbench/index.vue`）：左侧 64px 图标竖栏（logo + 我的项目 + 任务中心；底部反馈/设置(更新红点)/GitHub，选中态黑色圆角块）+ 顶部条（选中项目后出现：项目名 + 上下文导航 小说原文/剧本Agent/剧本管理/塑角造景/视频生产 | 资产中心）；项目类型 script 时隐藏小说/剧本Agent 两项。间距 16/32px、圆角 16px、TDesign 令牌（`var(--td-*)`）、自定义滚动条 4px；品牌色默认 `#0052D9` 可换（主色生成 10 级色阶）；暗色 auto/light/dark。

| 页面/区域 | 布局与组件 | 交互与状态 | 视觉 / 响应式 / a11y |
| --- | --- | --- | --- |
| `/login`【实测】 | 居中卡片（380px、圆角 20px、`--td-shadow-3`）：logo +「ToonFlow」字标 + slogan「智能短剧创作平台」+ 用户名/密码/登录 + 灰字「默认账号：admin / admin123」；右下悬浮圆钮：语言切换（7 语）+ 设置（改后端请求地址） | 空值校验 toast；登录失败 toast `e.message` | — |
| `/project`【实测】 | 「我的项目/管理您的所有短剧项目」+ 新建；卡片网格（t-card hoverShadow：项目名 + 类型 tag（小说/剧本）+ 风格 tag + 简介 + 创建时间 + 编辑/删除）；新建/编辑对话框（1214 行）：类型、名称、题材、清晰度 1K/2K/4K、视频模型、画幅、简介 + **视觉手册/导演手册管理器**（列表选择、新建：名称/Markdown 文档/多图封面/提示词多 tab） | 打开项目前校验模型配置可用（不可用弹编辑框 + toast）；空态仅标题+按钮（无专门空态插画） | 【判断】字段偏多但分组清晰，「手册」资产化是差异化设计 |
| `/novel`【实测】 | 工具条「导入原文 \| 批量删除(计数) \| 事件分析(计数) \| 搜索」+ 表格（多选/序号/卷/章节名称/章节内容/事件/操作）；章节与事件列超长截断 + 「查看详情」900px 预览 dialog | 事件列内联状态（生成中 loading / 失败红色按钮带原因 / 预览）；行操作编辑/删除（生成中禁用）；分页 + lazy-load；导入弹窗支持 Word 与粘贴、章节正则可编辑；空态「暂无数据」 | — |
| `/script`【实测】 | 工具条「搜索 \| 新建剧本 \| 批量上传 \| 全选 \| 导出剧本(n) \| 提取资产(n) \| 删除(n)」+ 卡片流（400px 卡：标题+checkbox+正文预览+资产 tag 或提取状态（提取中/待提取/失败红 tag 带 tooltip 原因）+ 右下删除） | 批量上传（粘贴文本+集数正则解析预览表）；空态 `<t-empty>` | 【判断】状态可视化 + 失败原因 tooltip 是良好实践 |
| `/scriptAgent`（817 行） | Splitpanes 30/70：左 t-design chat（消息流+输入框，footer：设置弹出（重连/清消息记忆/清摘要记忆/清全部）、思考等级 4 档、连接状态绿/红点、「强制生成」遮罩卡）；右 计划/大纲编辑区（getPlanData/setPlanData 双向同步 socket） | 消息支持 regenerate/stop、内容分段渲染 | — |
| `/cornerScape` 塑角造景（1268 行）【实测】 | 左列批量设置卡：快捷选择（全选/选无提示词/未生成/已生成/失败/反选/清空/批量预览）、资产类型过滤、生成模型、分辨率 1K/2K/4K、文本提示词、[批量生成提示词][批量绑定音频][开始批量生成]；右列卡片墙（图卡=checkbox+状态+图片 lazy+overlay ImageTools（复制/预览/下载）+取消生成 + 信息区（名称、已/未生成提示词 tag、类型/模型/音色 tag）） | 点卡开编辑抽屉；轮询更新音频绑定状态 | 无数据时右列为空白（无空态引导） |
| `/production` 视频生产 | VueFlow + 点状 Background + Controls；固定 6 节点 DAG（script/scriptPlan/storyboardTable/storyboard/workbench/assets），节点可拖、边粗 4px；空格+拖拽平移、滚轮行为可配、拖拽期降级渲染（`is-interacting` 去 hover/禁指针）、FPS 角标、`t-guide` 首次引导 4 步（localStorage 记进度）；浮动条：集数选择+刷新+自动布局（LR 手排/TB dagre）+右侧可收起 Agent 聊天抽屉 | 分镜节点（681 行）：宫格、S01 彩色编号 tag、缩放滑杆、卡片悬停左右「补帧 +」圆钮（取相邻帧作参考生成中间帧）、编辑/删除悬浮钮、多选批量生成/删除、失败原因 tooltip、未生成 empty；assets 节点：衍生资产增删/批量生成；script/plan/storyboardTable 节点：Markdown 预览/编辑；生成式图像编辑弹层（VueFlow 小画布：upload/generated 节点连线=参考编辑，可「保留」节点） | 未选集时画布空；**未选项目时整页空白+运行时报错 `No project selected`（实测确认的健壮性缺口）** |
| 工作台弹层三 tab | preview：动态故事板播放器（按 shot 时长推进、分段进度条可点跳、播放/暂停/上下帧、时间标签）；generate（593 行）：参考图列（优先级 assets>storyboard>无图）+ 模型模式菜单（单图/首尾帧/多参考/文生，分辨率/时长/音频开关）+ 提示词卡（contenteditable + `@` 引用图片/视频/音频素材弹层）+ 视频结果卡 + 底部多轨道；editVideo（534 行）：splitpanes 三栏 + 时间轴 40% | — | 画布尺寸随项目画幅（1920×1080 / 1080×1920） |
| 设置（全局弹窗，左菜单 16 项） | ui（主题/字号/画布滚轮）\| language \| **vendorConfig**（供应商列表+启停+输入项+Markdown 描述+模型表+三类测试台+上传盒）\| requestConfig \| loginConfig \| agentConfog（温度/maxTokens/手动自动）\| promptManage \| otherConfig（批量并发、章节正则、剧本长度）\| dbConfig（库信息/导出/导入/清表）\| memoryConfig \| fileManagement \| skillManagement（技能扫描/编辑）\| devConfig \| modelMap（模型↔提示词绑定）\| about \| logout | 更新检查每 2 分钟轮询 | — |

响应式/a11y：设计稿宽 1600、px→rem 全量换算——本质是等比缩放而非断点布局（【实测】820×700 登录页不破、项目页可用，但工作台为桌面布局）；**a11y 基本未做**（全仓 `aria-|role=` 仅 1 处）。

**局限与反模式**：① 强依赖自家后端与 Electron 壳（`toonflow://` 协议、无后端功能全不可用），本仓库不可独立成产品；② **构建红线**：HEAD 上 `yarn build` 因死文件 `generate copy.vue`（1961 行含语法错误）**失败**，`yarn build-only` 跳过类型检查才成功（单文件 26.6MB gzip 11MB + Monaco worker）——归档前 CI/发布链路要么未跑 type-check 要么已破损；③ 大量 `* copy` 死代码、README 技术栈/结构与实际不符（antd/element/vxe、sider.vue 等）；④ 无任何测试、无 CI；路由守卫只查 token 存在；默认账号 admin/admin123 明文提示在登录页；⑤ 未选项目时 `/production` 等路由直接抛错渲染空白（无空态引导）；无 a11y；⑥ 多 UI 组件/图标库混用、i18n 键结构扁平混乱；⑦ 部分实现粗放（`App.vue` 全局 F8 触发 `debugger`；axios 错误处理可再抛；新旧 API 代际并存）；⑧ 许可证附加商业限制（见下）并非纯 OSS。

**ToIV 借鉴映射**（对照 toiv-current-audit；历史样本，借鉴交互/协议设计）：

| 借鉴点 | Toonflow-web 证据 | ToIV 现状 | 建议 |
| --- | --- | --- | --- |
| DAG 创作流画布（固定节点 + 自动布局 + 空格平移 + 拖拽降级渲染 + 页内分步引导） | `production/utils/flowBuilder.ts`、`production/index.vue` | **部分**（canvas 有；Studio 是六段 rail 非 DAG） | P1 Studio 分镜/生产页「流程可视化」可选视图 |
| **Agent 流式 XML 标签直写画布数据 + Agent 反向 RPC**（增删分镜/触发生成） | `useChat.ts` XML 解析、`productionAgent.ts:51-213` | **部分**（LLM 编排有；无「结构化标签通道直写画布」协议） | **P1 高**：ToIV LLM(:8888) 驱动的编剧/分镜 Agent 输出协议引入结构化标签通道 |
| 供应商插件模板（声明式能力矩阵 + 适配器函数 + 测试台） | `lib/vendorTemplate.ts`、`vendorTest/` | **部分** | §5 P2 模型能力单源（能力声明方式减少 served 硬编码） |
| 一致性四件套（视觉手册/导演手册、资产+衍生图、分镜-资产绑定、相邻帧补帧、角色-音色绑定） | `projectDialog.vue:59-275`、`flowBuilder.ts`、`storyboard.vue:20-33` | **部分**（场景锚点/角色卡/定妆已有） | P1 补「导演手册」与「分镜补帧」两个对象 |
| 统一生成任务四态 + 5s 轮询 + 失败原因 tooltip + 可取消 + 全局任务中心 | `productionAgent.ts:318-441`、`task/index.vue` | **部分** | §5 P0 统一任务中心反馈粒度 |
| 首次三步配置向导 + 页内 t-guide 分步引导 | `hello.vue`、`t-guide` | **未见**统一 | P2 Studio 新功能引导 |
| 浏览器内剪辑/导出（@webav） | `editVideo/` | **已有剪映/合成导出**；浏览器内剪辑未见 | P3 评估 vs 现有渲染管线（成本高） |

**许可边界**【源码文件事实，非法律意见】：`LICENSE`（259 行）= **Apache License 2.0 全文 + 追加「补充协议 | Supplementary Agreement」**：将本软件或衍生版本以产品形式分发/销售/提供给 **≥2 个独立第三方**须取得 HBAI-Ltd **书面商业授权**；≤5 个法人联合运营内部使用视为内部使用免授权；不得删除/修改 Toonflow 标识或版权信息。另附「永久免费场景」（用其制作内容分账、内部二开、≤5 法人内用、个人学习非商业）与「商业授权定价表」（年销 <¥10 万免费申请 → >¥500 万面议）及 AGPL 不追溯条款（v1.0.8 前按 AGPL-3.0 使用者继续按 AGPL 执行）。README 徽章仍写 `License-AGPL` 与 LICENSE 实际内容不一致（历史遗留）。`NOTICES.txt`：第三方依赖许可清单（`scripts/license.ts` 生成）。**并码注意**：该许可证是「Apache-2.0 + 额外商业限制」的**源码可用但非 OSI 纯开源**条款（附加限制与 Apache-2.0 第 4 条精神有张力）；ToIV 若分发给 ≥2 个独立第三方或产品化集成，**复制其代码前应取得书面授权或走法务**；「未声明/宽松感知 ≠ 可自由复制」。Copyright © 北京爱阿科技有限公司。**注意与 Toonflow-app（MIT）不同仓不同许可**——旧前端代码不可因 app 仓是 MIT 而按 MIT 处理。

**运行验证边界**【实测】：`npx yarn@1.22.22 install --frozen-lockfile` 成功（yarn 4 会改写锁文件故用 yarn 1.22 严格模式）；**`yarn build`（vue-tsc + vite build）失败**（死文件 `generate copy.vue` TS1109）；`yarn build-only` 成功（11096 modules，单文件 26.6MB）；vite dev `:50188` + Playwright：`/login` 正常（默认账号提示、后端地址设置弹窗、右下语言/设置悬浮钮）；注入假 token 后 `/project` 渲染（首次引导弹窗「欢迎使用 ToonFlow…开始配置/跳过引导」；无后端时按设计弹 Network Error 排障提示卡）；`/novel`、`/script` 正常（表格/空态）；**`/production`、`/assets`、`/task`、`/scriptAgent`、`/cornerScape` 在未选中项目时渲染空白**（控制台抛 `No project selected`）；窄屏 820×700 登录/项目页可用。**未实机验证**：登录→建项目→小说/剧本→Agent 对话→分镜→视频生成→剪辑导出全链路（需要 Toonflow 后端 `localhost:10588`，不在本仓库；也未连其远程服务）；生产图（production 画布、生成工作台、剪辑时间轴）只能静态审查 + 截图存档。**测试**：完全没有（无 test 脚本/测试目录/CI）；i18n 7 语言（zh-CN 约 1591 叶子键）+ 自研未用键清理工具；a11y 全仓仅 1 处 aria。运行截图在 `/tmp/toonflow-ui-check/`（验证记录用，正文不依赖）。

**关键源码证据路径**（`HBAI-Ltd--Toonflow-web:` 前缀）：`README.md`、`LICENSE`、`NOTICES.txt`、`package.json`、`vite.config.ts`、`src/router/index.ts`、`src/pages/workbench/index.vue`、`src/pages/login/index.vue`、`src/App.vue`、`src/stores/{setting,project,productionAgent,scriptAgent,video}.ts`、`src/views/project/{index.vue,components/projectDialog.vue}`、`src/views/novel/`、`src/views/script/index.vue`、`src/views/scriptAgent/index.vue`、`src/views/cornerScape/index.vue`、`src/views/production/{index.vue,utils/flowBuilder.ts}`、`src/views/production/node/storyboard.vue`、`src/views/production/components/{workbench,editImage,rightChatBox}/`、`src/views/task/index.vue`、`src/lib/vendorTemplate.ts`、`src/components/setting/`、`src/components/promptEditor.vue`、`src/utils/{useChat,useSocket,axios,parseNovel}.ts`、`src/locales/language/zh-CN.json`。


---

## 4. 横向 UI 设计参考（按界面域归并，给 ToIV 可执行的组件行为建议）

> 每条建议都标注参考来源（项目 + clone 内证据路径），行为描述可直接转成组件验收项。与 §5 路线互补：这里是「怎么画/怎么交互」，那里是「做什么/落在哪」。

### 4.1 项目库与建项

| 行为建议（ToIV） | 参考来源 |
| --- | --- |
| 项目卡 = 封面（缩略/渐变+衬线标题兜底）+ 标题（truncate）+ **进度轴**（集数圆点行 / 阶段徽章）+「待修复」琥珀胶囊（line-clamp 失败原因）+ 相对时间；hover/焦点才浮现「更多」菜单；改名对话框注明「项目 ID 不变」；删除分层（回收站保留期 → 彻底删除）；改名/删除/导入后**静默重载不闪骨架** | ArcReel `pages/lobby/ProjectCard.tsx`、DramaClaw 项目文件夹卡、LumenX ProjectCard/系列分组 |
| 状态 pill 筛选（全部/已完成/进行中/草稿）+ 计数、画廊/列表视图切换（localStorage 持久）、搜索命中系列时整组保留；空库用**品牌空态卡**（slogan + 引言 + 双 CTA），空筛选用「无匹配 + 清除筛选」 | LumenX Workspace、BeefTV 首页空态 |
| 新建向导：固定高度 Dialog、三步共用一个滚动区、底部按钮不随步骤移动；缺必填时**列出缺少项**而非仅标红；步骤可往返且预览保持 | ArcReel `pages/create-project/` |
| **导入/拆集预期管理三卡**：「导入后会发生什么 / 当前导入策略 / 建议文本形态」，并明确「导入 ≠ 自动出片」 | BigBanana 现行版 `images/导入整篇小说.png`（§3.8 表） |
| 打开项目前校验所选模型/配置可用，不可用就地弹编辑框并 toast | Toonflow-web `project/index.vue` |

### 4.2 创作工作台（三栏/阶段壳）

| 行为建议 | 参考来源 |
| --- | --- |
| 顶栏常驻**制作状态条**：集进度弹层（逐集清单）+ 项目层「下一步」弹层（可执行操作 + 原因 + 建议）+ 通知抽屉（导出失败等）+ 配置不完整红点；离开拦截（继续编辑/放弃修改/保存并离开，截浏览器前进后退） | ArcReel `StudioLayout/GlobalHeader/ProjectStatusBar`、`LeaveGuardProvider` |
| 三栏手柄可拖动/方向键调宽（16px/步、双击恢复）；标准档 ≥1280 Agent 挤压画布，紧凑档 <1280 Agent 非模态覆盖、面板内 Esc 收起；**面板收起时内容保持挂载、输入不丢** | ArcReel `workspace-layout.ts` |
| 阶段 rail 带状态模型（ready/warn/idle/gated——gated 锁图标但可点进查看），**不是 wizard 强制完成**；阶段门禁空态直接写「请先完成 Phase 01 剧本分析」类引导 | LumenX `PipelineSidebar.tsx:15-26`、BigBanana/CineGen 阶段门禁 |
| 每步「生成→人工确认/改写→再生成」双拍循环；上游改动只把下游标「待复核」，不自动扩大重做范围；每步产出写回可留痕 | Toonflow-app `packages/skills/v118workflow/SKILL.md` |
| 编辑器底部状态栏（字符/行数 + 保存灯「保存中/已保存/待保存」1s debounce） | CineGen `StageScript.tsx`、DramaClaw `save-status.tsx`、LumenX |

### 4.3 资产一致性

| 行为建议 | 参考来源 |
| --- | --- |
| 资产卡：参考图位（生成/上传）+ 内联 PromptEditor + 负向词 + 锁定/星标 + 变体计数；批量生成带间隔限速 + 进度层 +「重新生成全部」二次确认（第 3 次确认、第 5 次需密码级防滥用可选） | DramaClaw 虾塘、BigBanana StageAssets、LumenX CastWorkbenchModal |
| 角色「基础形象 + 衣橱/造型变体（Casual/Tactical…）」+ **镜头级变体下拉**（写入 `characterVariations`）；面部特写与身份图分离；变体生成带「Keep facial features consistent」提示 | CineGen Wardrobe 弹窗、DramaClaw Identity、BigBanana TurnaroundModal |
| 资产库跨集复用时显示 **syncStatus（synced/outdated/local-only）** 同步横幅：「库资产已更新，是否同步到各集」；对账页用 ReconcileModal 范式（AI 建议 + 置信度阈值默认合并/新建 + 行内下拉可改 + 全部确认） | BigBanana `characterSyncService`、LumenX `ReconcileModal.tsx` |
| 场景卡维度写成摄影语言（Environment / Lighting 色温 / Composition 焦段）；定场帧/场景锚点作为一致性锚明示 | BigBanana 场景卡 OCR、AIMS2 Scene.establishing_frame_path |
| 参考图有序语义写进 UI（「第一张=场景/环境参考，其后=角色参考」），@引用转 `[characterN:...]` 标记并在 prompt 预览中剥离 | CineGen `geminiService.ts`、LumenX `buildAssembledPrompt.ts` |

### 4.4 分镜 / 镜头卡

| 行为建议 | 参考来源 |
| --- | --- |
| 镜头卡纵向长列表：卡头编号 + 运镜徽章 + 16:9 缩略 + 状态徽章 + 叙事摘要；选中后右侧详情抽屉 420–480px（上下镜切换、关闭）；未选中禁用「创建镜头」并 `title="Select a scene first"` | CineGen StageDirector、AIMS2 ShotComposer/ShotDetail、ToIV 现有 inspector 420px 扩展 |
| 镜头详情四分区：**场景环境**（场景缩略 + 时空 pill + 出场角色行（头像+造型下拉））→ **叙事动作**（可编辑 + AI ✨）→ **视觉制作**（起始帧/结束帧双格，End 标 "Optional"，无尾帧提示自动降级 i2v）→ **视频生成**（模型+能力徽章、时长、生成/重试、内嵌播放器） | CineGen 四分区、AIMS2 CameraDirector |
| **Continuity Chain 可视化**：上一镜末帧缩略 +「→ anchors first frame」+ 定场帧「scene identity lock」；「← 续接」一键继承上一镜 End | AIMS2 CameraDirector/`shot-continuity-feature.md` |
| 提示词区 = 结构化字段（景别/机位/运镜（主+副+速度）/站位/光影/转场）+ 自然语言描述 + **只读 assembled_prompt 实时拼装预览**（duration 不进 prompt）+ LLM 润色（失败给 reason 码）+ 收起式高级参数（negative/seed/cfg 按模型能力显隐） | LumenX StoryboardR2V/`buildAssembledPrompt.ts`、AIMS2 |
| 台词/配音行：文本 hash 变化 → **STALE 标记** + dub 预览/应用/删除/偏移 ms | LumenX `DialogueAudioRow.tsx` |
| 批量条：「已发配 N 个镜头 → 模式」+ 同组运行中去重 + 部分失败反馈（「ok 成功, fail 失败」）+ 质检 chip | DramaClaw beat-workbench |
| 键盘：J/K 切镜（未保存先询问）、方向键排序（500 镜压力流畅）；批量出图/展开折叠全部 | ArcReel `useShotShortcuts` |

### 4.5 生成队列与成本

| 行为建议 | 参考来源 |
| --- | --- |
| 队列入口显示在飞任务数，展开右侧**地板到天花板侧栏（挤压主列而非覆盖）**；全局状态底栏：当前任务进度 + 相对时间 + **流健康色点**（connected 绿/reconnecting 黄/failed 红）+ 版本号 | LumenX TaskQueueButton、DramaClaw TaskStatusBar |
| 提交前**准入三态**（放行/待确认/受阻）+ 报价单（逐镜头去向：生成/复用/受阻、时长、档位、预计费用）；确认后带 `confirmed_*` 锁档防二次确认 | ArcReel `batch_admission`/`video_quote` |
| 节点/镜头卡带**价格徽标**（`mediaPrice`/`showNodePrice`）；缺价时解释型空态（列原因 + 链接到设置价格） | Toonflow-app、DramaClaw、ArcReel CostLine |
| 错误分类文案成体系：队列满分级、内容策略拦截、限流、额度不足、计费未配置（「需配置」徽标）、provider 未配置（→去设置）；生成失败带 **requestId/provider_task_id 可复制报障** | DramaClaw i18n、LumenX VideoTask 诊断三字段 |
| 运行时健康视图：调度器/轮询器/看门狗状态、最近成功调度、连续失败、最老待调度等待、本节点并发 n/m | printfilm admin `/queues` |

### 4.6 候选对比与时间轴

| 行为建议 | 参考来源 |
| --- | --- |
| 候选区：×N 批量（×1/×2/×4/×6）+ T2I 首帧抽卡历史（FIFO 10，选中索引决定喂给 I2V）+ 视频候选卡（星标 shortlist + ≤20 字标签）+ **CompareModal 并排对比** + Pin/Unpin 防覆盖 + 「拍板」唯一化 `final_take_id` | LumenX CandidatesSection/VideoAssembly Takes |
| 剪辑视图布局：**播放器在左、详情栏在右、轨道横跨底部**；整视图不滚动只有详情栏滚；出片对话框（成片/剪映选项 + 成片过时以「重新渲染」为主动作）；问题列表 + 未使用素材统计 | ArcReel `EditTimelineView` |
| 时间线基础行为：多轨（视频/台词/BGM/字幕）、播放头/缩放/transport、吸附、trim/split、撤销重做、BGM 响度统一提示 | ArcReel edit_timeline、BigBanana CutOS、Toonflow-web editVideo |
| 动态故事板预览：按镜头时长逐格播放 + 分段进度条可点跳（低成本预览，省 GPU） | Toonflow-web `workbench/preview.vue`、printfilm mp4cat |

### 4.7 设置 / 模型

| 行为建议 | 参考来源 |
| --- | --- |
| 设置分区导航 + **配置问题按分区归属显示**（侧栏分区标记 + 就地提示，不做全局横幅）；返回按钮回进入前位置；部分分区无保存栏（通用类即改即存） | ArcReel SystemConfigPage |
| 模型配置：预置\|自定义供应商二级栏 + 模型 Sheet（价格/参数/时长档/能力覆盖）+ 端点测试按钮 + 「已配置 N 个密钥」行；默认模型网格（生图/视频/文本/助手/音频）+ 覆盖来源徽标 | ArcReel providers/default-models、LumenX Settings models |
| 业务模型按**功能槽位**分组展示（编剧/分镜/出图/视频/配音/Agent…）+ 媒体能力目录（参考上限/时长/分辨率/档位）+ 推荐配置一键应用 | DramaClaw settings 模型与渠道、AID Studio 编排 |
| **「未配置影响提示」**：某项未配置时列出哪些功能会失败；API Key 显示「已保存 · ••••」掩码；一键 OAuth 登录 + 测试连接（诊断码 + 建议动作） | DramaClaw、LumenX apikeys |
| 模型目录工程：family 配置 → 生成前后端同源 JSON + 校验脚本 + onboarding workflow；「官方没有的能力不要靠猜测补上」证据台账 | LumenX `config/model_catalog/`、AID Studio 能力证据文化 |

### 4.8 空载错（横切文案规范）

| 行为建议 | 参考来源 |
| --- | --- |
| 三态齐备且文案具体：空态（图标 + 标题 + 说明 + 主/副按钮）、加载骨架、错误态（一句话原因 + 一条修正路径 + 可复制详情）；长错误正文可滚动、**操作按钮留在视口内** | ArcReel `Empty` 族/`InlineWarning`、DramaClaw i18n、printfilm STANDARDS |
| 区分「本地缓存成功 ≠ 服务端持久化成功」；「X 拿不到完整数字」解释型空态（列原因 + 行动链接）；「Session expired. Please sign in again.」类会话态 | BeefTV 项目库错误文案、ArcReel CostLine、KŌMA ModelRankings |
| 合成/渲染失败**不要倾倒原始 ffmpeg 日志**到主 UI——给短句 + 「展开日志」折叠 | printfilm 反例（error_msg 塞全日志） |
| 占位入口要么落地要么标「规划中」并进台账；禁止「假能力」按钮（无 onClick 的 Download/Export） | CineGen 导出页反例、printfilm `PLACEHOLDER_BACKLOG.md` 正例 |
| 资产/项目删除：影响清单滚动区 + 按钮留视野；分层确认（回收站 → 彻底删除） | ArcReel DeleteAssetDialog、DramaClaw 项目卡 |

### 4.9 响应式与无障碍

| 行为建议 | 参考来源 |
| --- | --- |
| 唯一档位切换点（xl=1280）+ 区段内容器查询；ESLint 拦截业务组件视口断点；e2e 视口矩阵 1024/1280/1440/1920/2560 + **溢出探针**（内容溢出够不到 / 未声明横向滚动自动报缺陷） | ArcReel `page-shell`/`layout-probe` |
| 窄屏：侧栏收图标轨/抽屉 + 底部 Tab（同一数据源防漂移）；**拒绝移动端时给明确整页说明**（BigBanana/CineGen MobileWarning）优于破版 | BeefTV、LumenX GlobalSidebar/BottomTabBar |
| a11y 基线：图标按钮 `aria-label`/`title`、`focus-visible` 描边、持久切换 `aria-pressed`、tablist roving tabindex + 方向键、`role=status/alert`、跳转链接「跳到主内容」、`prefers-reduced-motion`（减弱动态下不自动播悬停预览）；目标 axe WCAG 2.2 AA | ArcReel（e2e 内 axe wcag22aa）、BeefTV、Toonflow-app |
| 主题：浅/深/跟随系统 + 首屏防闪烁内联脚本；弹层「不透明 surface + 一条 border + 一个 overlay 阴影」；动效一律 <300ms | ArcReel index.css 注释 |
| mono 字段强制等宽（API Key/URL/数值）；媒体/资产/状态色语义 token 化（pending 冷蓝/processing 琥珀/completed teal/failed 红/starred 金） | ArcReel、LumenX 状态色 token |
| 反面教材（禁止）：零 aria（AIMS2 全仓 0 命中）、原生 `alert/confirm` 破坏风格（CineGen/Toonflow-web）、px→rem 全量等比缩放冒充响应式（Toonflow-web）、动画类大面积失效（CineGen Tailwind CDN 缺插件） | 各章局限节 |

---

## 5. ToIV 优先级路线 P0 / P1 / P2

> 范围以本报告对 ToIV 当前源码的只读审查为准：只提「新增而非重复」。**已排除**重做多候选、任务幂等、剪映导出（见 §2.3）。每项含：参考来源 → 目标页面/后端落点 → 交互/数据要求 → 验收标准。

### P0（短剧生产刚需，先做）

**P0-1 跨集资产对账台账**（现状：部分——分散基础、无对账面）

- 参考来源：LumenX `alibaba--lumenx:frontend/src/components/modules/ReconcileModal.tsx` 与 `api.py` reconcile/suggestions·apply；BigBanana `characterSyncService`（synced/outdated/local-only）与「导入预期管理三卡」；DramaClaw Identity 层级；ai_story 资产模糊匹配。
- 落点：Go `apps/canvas/backend` 只读查询（`project_workbench_read.go` 旁）+ canvas web `pages/projects/detail/` 新阶段或 assets 段新页签「对账」；数据底：`ProjectUnit(chapter|episode)` × `Entity/ProjectAssetCandidate.ResolvedAssetID` × `ShotAssetReference.AssetVersionID` × `ref_epoch`。
- 交互/数据要求：① 逐集清单（角色/场景/道具 × 用到的资产版本）；② 漂移点列表（同角色多版本参考、缺定妆、锚点变更未重渲、`ref_epoch` 不一致）；③ 抽取实体 vs 全局库 AI 匹配建议（置信度阈值默认「合并进正典/新建」，行内可改、「全部确认」一键，应用走幂等回执）；④ 并入 `presence-check`/`qa_gate` 结果；⑤ 状态轴 synced/outdated/local-only。
- 验收标准：任一 ≥2 集项目可在该页看到「每集资产版本清单 + 漂移点 + 一键归并/新建」；确认动作可回放（幂等，重放不覆盖后来编辑）；P-18b 同类问题（改资产后旧集未重渲）能被台账列出并跳转到对应镜头。

**P0-2 统一任务中心（重开放 `/tasks`，队列 dock 共用数据层）**（现状：部分——`tasks-page` 已合并双源但路由被关）

- 参考来源：ArcReel「制作状态三轴 + 下一步投影」（`docs/adr/0062`、`workflow_state.py`）；printfilm admin `/queues` 运行时健康；DramaClaw TaskStatusBar/TaskPanel + 错误分类文案；AID Studio 任务三时刻；LumenX 诊断三字段。
- 落点：前端 `pages/toiv/tasks-page.tsx` 重新开放（`router.tsx:138-142` 移除重定向）+ `CreationStudioQueueDock` 共用数据层（消 4s 轮询双份逻辑）；后端合成读模型（Go `GenerationTask` + FastAPI `ToivJob`/`Job`）。
- 交互/数据要求：① 单一读模型暴露「步骤进度 × 产物时效 × 任务收单」三轴（不折成一个状态）；② 每任务「下一步」投影（phase + 可执行 regenerate + 原因）；③ 诊断字段（provider_name/provider_task_id/provider_request_id 或集群等价物）+ 失败脱敏摘要 + 复制报障；④ 运行时健康条（调度/轮询/看门狗或集群等价、最近成功、连续失败、并发 n/m）；⑤ 错误分类文案（队列满/限流/额度/未配置→去设置）；⑥ cancel/retry/看日志/R18 门控沿用现有能力。
- 验收标准：`/tasks` 可达且与队列 dock 数据一致（同一数据层）；重启后任务视图自愈（依赖现有 jobs_persist/render_reconcile，不新做幂等）；任一失败任务可从卡片直达日志/诊断并复制报障信息。

### P1（生产治理与成本）

**P1-3 用户生成配方库**（现状：部分——三套预设并存，均非用户可存）

- 参考来源：BigBanana `promptVersionService`/提示词管理页；ai_story 提示词集/模板/调试台；AIMS2 `GenerationRecipe`；BeefTV `prompt_templates` + 用户创作层 + 工作流模板封装；Toonflow-app 技能化方法论。
- 落点：FastAPI `apps/api`（在 `community_recipes.py`/`workflow_templates.py` 之上加「用户配方」）+ Studio 生成面板「存为配方/套用配方」入口。
- 交互/数据要求：配方 = 模型 + 参数 + prompt 骨架 + 参考位 + 选优策略；可从任一成功镜头一键保存；可命名/编辑/克隆/设默认/删除；套用时逐字段展示覆盖差异。
- 验收标准：从一个成功镜头保存配方后，新镜头可一键套用并生成成功；配方可导出/分享（JSON）；与社区配方/风格预设共存不互相覆盖。

**P1-4 Studio 线提示词/参数修订历史 + stale 联动**（现状：部分——`StudioShot.prompt` 单列无修订史、无 diff UI）

- 参考来源：BigBanana promptVersion（source 标注 + 30 条 + History 抽屉回滚）；ArcReel 产物 stale 语义；LumenX 台词 hash STALE；printfilm「下一阶段单一真相源」。
- 落点：`apps/api` `StudioShot` 增修订语义（复用 Go `ShotRevision` 语义或 `Job.params`+`parent_id/root_id` 版本树）+ 前端镜头卡「prompt diff + 回滚」。
- 交互/数据要求：① 每次生成/编辑留修订（source: ai-generated/manual-edit/rollback/imported）；② 镜头卡内 diff 视图 + 一键回滚；③ **回滚/改词后下游产物标 stale 并提示重渲**（与 P0-2 三轴联动）；④ 配音行文本 hash 变化 → STALE。
- 验收标准：改 prompt → 生成 → 改回 → 可看到两版 diff 并回滚；回滚后旧产物状态为 stale 而非静默可用；stale 徽标在任务中心与镜头卡同时可见。

**P1-5 渲染前资源/成本预估 + 就绪门禁**（现状：未见——仅用量计数）

- 参考来源：ArcReel `batch_admission` + `video_quote`（逐单元去向/档位/预计费用，确认锁档）；AID Studio 报价与提交同口径 + 三阶段计费快照；printfilm `tokens_estimated` 诚实标记；DramaClaw 合成前就绪门禁；Toonflow-app `mediaPrice` 徽标。
- 落点：`apps/api`（`usage.py` 扩展预估 + `studio.py` render/assemble 前置准入）+ Studio 批量渲染确认弹窗 + 镜头卡价格徽标。
- 交互/数据要求：① 提交前准入三态（放行/待确认/受阻）+ 逐镜头报价单（去向：生成/复用/受阻、时长、`num_candidates`、预计 GPU 分钟/费用）；② 确认后锁档（`confirmed_*` 防二次确认）；③ 缺素材镜头清单（合成/批量前就绪门禁，列出缺失项）；④ 预估口径与实际用量并列展示，取不到单价标「未定价」不猜。
- 验收标准：批量渲染前必须看到报价单并确认；受阻项（缺参考/超能力上限）在提交前被拒绝而不是失败在生成后；用量报表能对比「预估 vs 实际」。

**P1-6 阶段确认关口与「待复核」联动（方法论技能化起步）**（现状：部分）

- 参考来源：Toonflow-app `packages/skills/v118workflow/SKILL.md`（14 阶段 + 三确认关口 + 状态机 + 上游改动只标下游待复核）；DramaClaw 依赖门提示；ArcReel「审核优先于自动」。
- 落点：canvas web `pages/toiv/drama-workspace.tsx` 六段 rail 加阶段确认态；SVML→分镜→渲染链沉淀为 Skill 文档（`skills/` 或 `docs/`）。
- 交互/数据要求：阶段产出状态机（草稿/待确认/已确认/生成中/失败/待复核/已跳过）；每步「确认」显式动作；上游改动只把下游标「待复核」；确认记录可回看。
- 验收标准：未确认阶段不允许批量渲染下一阶段（gated 可查看）；改剧本后分镜/镜头自动进入「待复核」而非静默过期。

### P2（体验与工程化）

**P2-7 take 对比选优台**（现状：部分——数据与自动评分已有，缺 UI）

- 参考来源：LumenX CompareModal + 星标 short名单 + `final_take_id` + pin 防覆盖；AIMS2 `video_takes` + Continuity Chain。
- 落点：`components/create/` 新 `CreationStudioTakeCompare`（或扩展现有候选区）；消费 `candidates_json`（已含 seed/is_picked）+ `candidate_pick.py`/`bestof.py` 评分。
- 交互/数据要求：并排对比（同屏 2–4 个 take，同步播放/逐帧）、评分解释（裁脸相似度/OCR/连贯分分列）、星标 shortlist + 标签、拍板唯一化（沿用 pick 接口）、pin 防覆盖。
- 验收标准：任一有 ≥2 候选的镜头可进入对比台；拍板后 `is_picked` 唯一且时间线/成片消费拍板结果；评分解释与自动选优结果一致可复核。

**P2-8 模型能力元数据单源**（现状：部分——`lib/model-capabilities.ts` 与后端 model_profiles/model_wiki/capabilities.py 互不同步）

- 参考来源：LumenX catalog as code（family YAML→生成 JSON→CI 校验 + onboarding workflow）；AID Studio 能力位 + capability_json + 「不猜上限」台账；AIMS2 `DriverInfo` 驱动 UI 显隐；KŌMA 注册表（SHA256/需求/安装策略）；Toonflow-app `ProviderDefinition`。
- 落点：`apps/api` `GET /api/models/*` 下发规范化 capability（含 refs 上限、promptMaxChars、时长/分辨率档、首尾帧/参考视频支持）；删除前端手工 `model-capability-editor` 双轨；对齐 AGENTS 命名铁律（一个磁盘权重一个 weight id）。
- 交互/数据要求：能力声明驱动生成面板选项收窄（不可用项禁用并给原因）；调用前强校验（超限在报价前拒绝）；能力变更走校验脚本/CI；证据台账（能力来源 URL + 已表达/部分表达/待核验）。
- 验收标准：新增一个模型只改一处配置即可在前后端同时生效；UI 上超出能力的参数不可选；预估（P1-5）读同一能力源。

**P2-9 创作台全量多轨导出（EDL/FCPXML + 分轨草稿）**（现状：部分——剪映已有、EDL 仅 transcript 链）

- 参考来源：AIMS2 `routes_export.py`（CMX3600 EDL / Premiere XML）；ArcReel 剪辑时间线→成片/剪映双出口与预览共享读取模型；BigBanana NLE 工程模板（PR/FCP/达芬奇）+ 源素材 ZIP。
- 落点：`apps/api` `services/media/edl.py` 扩展 + `studio.py` 新导出端点；`jianying_draft.py` 增量（视频+台词+BGM 分轨）；前端导出下拉（成片/剪映/EDL/FCPXML/源素材包）。
- 交互/数据要求：时间线（视频+台词+BGM+字幕分轨）→ EDL/FCPXML 直出（复用 `EdlItem` 校验语义）；剪映草稿补分轨；导出前校验（缺素材/时长超限列清单）。
- 验收标准：同一时间线可导出剪映草稿与 EDL 且片段切点一致；EDL 在达芬奇/Premiere 至少一侧导入抽检通过；**不改动现有剪映主链**（增量交付）。


---

## 6. 许可证矩阵（仅按笔记准确概括；**不构成法律意见**）

**总原则**：思路借鉴 ≠ 复制源码 / 截图 / 品牌 / 交互皮肤。以下每格均为各仓 LICENSE/NOTICE/README 的文件事实摘要；「并码倾向」是工程判断而非法律结论，落地前须走 ToIV 法务/合规流程。第三方依赖（FFmpeg/字体/SDK）与上游模型服务条款另计。

| # | 项目 | 许可（文件事实） | 关键限制 | 商标/品牌 | ToIV 并码倾向（判断） |
| --- | --- | --- | --- | --- | --- |
| 1 | BeefTV | 分范围双段：Part A **BeefTV Source Available License 1.0**（新原创）+ Part B 历史 **MIT**（点名提交）；捆绑 `@ffmpeg/core` **GPL-2.0-or-later** | Part A：商用转售/套壳白标/收费代部署/**任何对外托管（External Service）**需事先书面授权；GPL 组件另有传染与对应源码义务 | 品牌归因随许可 | **不并码**（Part A/GPL 混合风险高）；只借设计；若复用须逐文件审计 + 书面授权 |
| 2 | ArcReel | **AGPL-3.0** + NOTICE 附加条款（AGPLv3 §7(b)）；FFmpeg(GPL-3.0-or-later)/思源黑体(SIL OFL 1.1) 随包 | 网络服务触发源码提供义务；修改版 UI 须保留 `Powered by ArcReel` 链接并标明修改 | 名称与标识**不在** AGPL 授权范围 | **不并码**；机制/状态机/API 形状可独立实现；商业授权双轨（support@arc-reel.com） |
| 3 | DramaClaw | **Elastic License 2.0**（`LICENSES/Elastic-2.0.txt`；根无 LICENSE，NOTICE 引用悬空）；edge-tts **LGPL-3.0-only**、certifi MPL-2.0 等 | **不得将软件本身作为 hosted/managed service 提供给第三方**（与 ToIV SaaS 形态直接张力）；不得移除许可/品牌声明 | README 要求 UI 保留「Powered by DramaClaw」；商标不随许可授予 | **不并码**；思路借鉴并独立实现；如需片段须逐文件核 `license-inventory.csv` + 法务 |
| 4 | AID Studio | **MIT**（光子讯息(杭州)科技有限公司 2026）；NOTICE 含 **RuoYi-Vue(MIT)** 归属 | 须保留 LICENSE 与 NOTICE（含 RuoYi 版权行）；官方素材包（`aid-official-assets_*`）**不在 MIT 范围**；依赖各自合规 | 品牌「AID Studio/视觉·AID」、赞赏码不属许可授予 | **可有限并码**（保留声明 + 依赖/素材/品牌合规后）；提示词初始化数据随 SQL 需自行核对 |
| 5 | printfilm | **MIT**（PRINTFILM 2026），无其它许可文件 | 保留版权与许可声明；上游模型输出权属/商用条款不在覆盖内；截图≠可商用 | — | **可有限并码**（最宽松档） |
| 6 | LumenX | **MIT**（Copyright (c) 2026 Alibaba），无附加 NOTICE | 保留声明；第三方模型服务条款与生成内容权利不在覆盖内；品牌素材另行判断 | Logo/Banner 可能受商标/著作权约束 | **可有限并码**（保留声明 + 品牌/依赖合规） |
| 7 | KŌMA Studio | **MIT**（Klaus 2026）；`docs/THIRD-PARTY-NOTICES.md`：**GPL-3.0** Comic Text Detector 权重（不入库不随包）、LGPL/MPL 组件、Pororo 部分 checkpoint **CC-BY-NC-SA-4.0** | 若打包 GPL 权重/上游代码则承担 GPL-3.0 义务；NC 权重不可商用 | — | **可有限并码代码**（保留声明）；**严禁**把 GPL/NC 权重打进 ToIV 分发物 |
| 8 | BigBanana | **BigBanana Community License 1.0**（非 OSI）；README/schema-org 称 CC BY-NC-SA 4.0（**口径冲突，均禁商用**） | 禁商业活动/付费服务/出售/商业分发/**SaaS/托管/白标**/**企业内部生产经营性使用**；商业权利需书面授权 | 商标/品牌不授权 | **禁止并码（含 git 历史源码）**；仅阅读总结 + 独立实现；截图/logo/文案不得使用 |
| 9 | AI Movie Studio 2 | **GNU AGPLv3**（无附加条款）；README 另售商业授权 | 网络服务触发第 13 节源码义务 | — | **不并码**；设计/交互借鉴 + 重写 |
| 10 | AI Story | **根无 LICENSE 文件**；根 README **CC BY-NC-SA 4.0**（禁商用）vs 子目录 README「MIT」**冲突**；`agent/mcp/workflows` 标记闭源（源码「泄漏」状态） | 冲突未解决前**不得按 MIT 使用**；闭源标记部分再利用风险更高 | — | **不并码**；如确需复用须先向作者澄清许可冲突与闭源范围 |
| 11 | CineGen ShortDrama | **AniKuku Community License (ACL) v1.0**（非 OSI） | 非商业；公开使用/再分发/部署（含 SaaS）须放两个公开可访问、不得 nofollow、不得藏登录墙的链接（AniKuku.com + 源仓库）；商业且不带署名须购授权 | AniKuku 商标不得超范围使用 | **不并码**（商业产品落入署名/商业授权条款）；独立实现 |
| 12 | Toonflow-app | **MIT**（HBAI-Ltd 2026）+ 不追溯条款（历史 AGPL/Apache+附加协议版本用户） | 保留版权与许可文本 | Toonflow/TF-Router 商标不在授权内 | **可有限并码**（NOTICE 保留 `Copyright (c) 2026 HBAI-Ltd`） |
| 13 | Toonflow-web | **Apache-2.0 + 补充商业协议**（259 行 LICENSE）：产品形式分发/销售/提供给 **≥2 个独立第三方**须 HBAI-Ltd 书面商业授权；≤5 法人内用免授权；永久免费场景 + 商业授权价目 | 附加限制与 Apache-2.0 第 4 条精神有张力；README 徽章 AGPL 为历史遗留 | 不得删除/修改 Toonflow 标识 | **不并码**（需书面授权或法务意见）；注意与 Toonflow-app(MIT) 不同仓不同许可 |

---

## 7. 验证总结（哪些是真验证、哪些不是）

**总口径**：本调研的「实测」绝大多数是 **UI fixture / mock / 静态渲染级验证**；除 printfilm 与 LumenX/AID 的后端单测外，**没有任何项目的真实模型生成链被端到端跑通**。UI fixture 通过 ≠ 真实生成链通过；单测通过 ≠ 产品链路通过。

| 项目 | 测试/构建实况 | 明确失败/问题 | 未实测真实模型/链路 |
| --- | --- | --- | --- |
| BeefTV | web 584 测试文件 / backend 717 `*_test.go`（体量事实，本次未全跑）；web bun dev + Go 后端跑通 | `/projects/:id`、`/tasks` 当前构建不可达（路由重定向）；`/agents` MCP 错误态 | 真实生成链（无密钥）、桌面打包/公证、MCP |
| ArcReel | 前端 3950 用例全过 + 105 个 Playwright 区域用例（含官方截图基线比对）+ typecheck 过 | 后端 pytest 未跑（重型依赖/DB 初始化被跳过） | 真实模型生成、Docker 部署、后端测试；e2e 全走录制 fixtures |
| DramaClaw | 前端 build 过（TS 0 错）+ **4877 用例全过**；preview 打开 /download | **后端 `uv sync` 两次失败**（`openai-codex` git 依赖访问 github.com 超时）→ 产品工作台未实测；Rollup 警告 chunk 过大（2.9MB/2.48MB） | 后端 API、登录后工作台、真实生成 |
| AID Studio | web typecheck 过 + Next build 22 路由静态预渲染 + next start 截图 | **HEAD 自带单测是红的**：vitest 405 用例中 **4 条失败**（`optionalReferenceGeneration.test.ts`，`ctx.activeVideoPromptMaxLength is not a function`）；后端 0 单测；lockfile 186 处内网 registry（外网 npm 卡死，本次改写后才装上） | 后端 Java 启动（需 MySQL/Redis）、admin、真实模型、支付/登录 |
| printfilm | **全栈 mock 实测**（PG/Redis/后端/用户端/管理端）；**pytest 862 过 / 1 失败 / 1 跳过**；前端 node:test 8 过 | **HEAD 真实失败用例**：`test_narration_edit_invalidates_continuous_audio`（期望 `SCRIPT_READY` 实得 `VIDEO_READY`，断言漂移）；mock 不 mock LLM（剧本链失败）；mock 合成失败（FFmpeg 不能解码 mock SVG） | 真实 TokenFree 生图/生视频/配音质量、OSS/支付回调、Docker 镜像 |
| LumenX | **pytest 209 全过**；catalog 校验过、构建幂等；uvicorn API 冒烟正常；next dev + Playwright 实测 5 页 + 项目五步 | lockfile 内网 registry 踩坑（已改写未提交）；export.py 是 mock、Timeline.tsx 死代码、BGM preset 音频缺失 | 真实生成链（T2I/I2V/R2V/TTS 全依赖云端 key）；前端无 CI |
| KŌMA | interface vitest **523 全过**；tauri dev 走查 7 路由 + 390px | **Python mini-backend 测试阻塞**（缺 cv2/onnxruntime，收集期 51 ImportError；文档称纯 Python 可跑与实况有出入）；Model Rankings 渲染 i18n key 的实测缺陷 | 六段扫译流水线（检测/OCR/翻译/inpaint）真实模型；打包链 |
| BigBanana | 历史版 SPA 无后端可跑 + Playwright 走查（引导/门禁/空态/MobileWarning/暗色像素） | **零自动化测试**（仅 UTF-8 构建校验）；源码闭源断层（现行版无源码）；Tailwind CDN；动效/假实现类问题若干 | 现行版 3.4.2（世界观/小说导入/CutOS）、真实 AI 链路（需外部 Key）、Docker 镜像 |
| AI Movie Studio 2 | next build 过；后端 /health ok；Playwright 14 张截图 **0 JS error**；API 冒烟全 200 | **全仓零测试文件**（pytest 在依赖里但无 tests/）；无认证 + CORS 全开；任务状态进程内字典重启即丢 | 生成链（无 ComfyUI/无云 key，Driver 目录只列本地驱动）、Previs/时间轴 MP4 渲染 |
| AI Story | Django 全栈起服 + migrate 自动播种 + Playwright 17 张截图 **0 console error**；子集 6 tests OK | **主链路 mock 半通**：rewrite/asset_extraction 被跳过（模板未开启）、storyboard 失败（**mock 桩按关键词误路由**，不判定真实 LLM 坏）；文档-实现漂移（export 空壳/负载均衡 TODO）；Redis 意外复用既有容器（隔离声明在案） | 真实 LLM/文生图/图生视频、MySQL 生产、Docker、LinkNow 前端、剪映草稿写入 |
| CineGen | build 成功；dev + Playwright 13 状态走查（假项目注入走通 UI） | **无测试/CI/lint**；核心链路 2026-07 才修通（历史断裂）；**导出 5 个入口全是无 onClick 占位**；动效类大面积失效（animation-name:none）；mock 不适用（纯前端） | 真实 Gemini/Veo 成功路径（仅验证调用入口与失败路径） |
| Toonflow-app | bun 1.3.14 构建 + 服务器起 + Chrome 实测 hello/home/workspace | **零自动化测试属项目政策**（AGENTS.md 明文不新增测试）；**Bun 版本敏感**（1.2.17 构建失败）；chunk 5–6MB | 真实媒体生成/Agent 对话/语音/拉片、MCP 客户端、桌面/Android 打包、TF-Router |
| Toonflow-web | yarn install 过；**`yarn build` 失败**（死文件 `generate copy.vue` 语法错误）；build-only 成功（单文件 26.6MB）；dev 实测 login/project/novel/script | 零测试零 CI；未选项目路由抛 `No project selected` 空白；a11y 仅 1 处 aria；README 技术栈过期 | 全链路（需其后端 10588，不在本仓）；production 画布/剪辑仅静态审查 |

**通用未验证项**：① 所有项目的「真实模型出图/出片质量」均未验证（无真实密钥，符合调研边界）；② 随仓官方截图多数未逐像素目视（工具限制），视觉结论以源码 token/类名/计算样式为据；③ 各仓竞品对比表/营销口径（DramaClaw 竞品表、BigBanana「一句话出片」、AID 赞助口径）均为单方声明未独立核对；④ 临时截图与运行残留的位置已在各章「运行验证边界」注明（如 `/tmp/beeftv-research-shots/`、`tmp/reference-research/screenshots-lumenx/`、`/tmp/koma-ui-verify/`、`/tmp/bb-verify/`、`/tmp/aims2_shots/`、`tmp/reference-research/screenshots/xhongc--ai_story/`、`UllrAI--CineGen-ShortDrama-shots/`、`/tmp/toonflow-ui-check/`、`/tmp/printfilm_shots/`），正文不依赖这些截图。

---

## 8. 附录

### 8.1 13 仓路径索引（clone 目录 = `third_party/reference-repos/<名>`）

| 章节 | clone 目录名 | 本章关键证据速查（相对 clone 根） |
| --- | --- | --- |
| 3.1 BeefTV | `glanderness--BeefTV` | `backend/internal/model/models_project.go`、`models_task.go`、`docs/architecture/generation-task-state.md`、`web/src/pages/canvas/project.tsx`、`web/src/lib/app-theme.ts` |
| 3.2 ArcReel | `ArcReel--ArcReel` | `GLOSSARY.md`、`docs/adr/0062`、`lib/generation/batch_admission.py`、`lib/edit_timeline/`、`frontend/src/components/layout/StudioLayout.tsx`、`frontend/e2e/support/recorded.ts` |
| 3.3 DramaClaw | `dramaclaw--dramaclaw` | `DESIGN.md`、`src/novelvideo/sqlite_store.py`、`src/novelvideo/models.py`、`src/novelvideo/task_backend/limits.py`、`frontend/src/components/episode/beat-workbench/`、`frontend/src/public/locales/zh/translation.json`、`LICENSES/Elastic-2.0.txt` |
| 3.4 AID Studio | `gzxx-2025--aid-studio` | `sql/aid-init.sql`、`doc/提示词开发指南.md`、`doc/公开Provider接入指南.md`、`frontend/web/utils/createFlowRoutes.ts`、`frontend/web/components/steps/`、`frontend/admin/src/views/`、`deploy/README.md` |
| 3.5 printfilm | `yi1108--printfilm` | `docs/EPISODE_RULES.md`、`docs/SHOT_SPLITTING.md`、`backend/app/models_tasks.py`、`backend/app/services/tasks/`、`backend/app/services/kepu_stages.py`、`frontend/src/pages/drama/EpisodeEditPage.tsx` |
| 3.6 LumenX | `alibaba--lumenx` | `config/model_catalog/`、`scripts/build_model_catalog.py`、`src/apps/comic_gen/models.py`、`frontend/src/components/modules/StoryboardR2V.tsx`、`ReconcileModal.tsx`、`frontend/src/app/globals.css` |
| 3.7 KŌMA Studio | `klaus-2--koma-studio` | `packages/interface/src/types/dashboard.types.ts`、`packages/mini-backend/models/translation/factory.py`、`packages/interface/src/pages/dashboard/sections/AioRightPanel.tsx`、`docs/THIRD-PARTY-NOTICES.md`、`refactor-queue.md` |
| 3.8 BigBanana | `shuyu-labs--BigBanana-AI-Director` | HEAD：`README.md`、`docker-compose.yaml`、`images/`、`LICENSE`；历史 `556824c4207c4582325f01e6c6546a3df22b403f`：`types.ts`、`services/promptVersionService.ts`、`components/StageDirector/`、`docs/shot-continuity-feature.md` |
| 3.9 AI Movie Studio 2 | `Heroesjouney--AIMovieStudiov2` | `backend/core/schemas/shot.py`、`core/drivers/base.py`、`core/logic/prompt_builder.py`、`frontend/src/components/camera/CameraDirector.tsx`、`components/shots/CameraAngleWidget.tsx`、`LICENSE` |
| 3.10 AI Story | `xhongc--ai_story` | `backend/apps/prompts/models.py`、`backend/apps/content/processors/multi_grid_image_stage.py`、`frontend/src/views/prompts/PromptList.vue`、`frontend/src/components/canvas/ProjectCanvas.vue`、`scripts/check_closed_source_apps.sh` |
| 3.11 CineGen | `UllrAI--CineGen-ShortDrama` | `types.ts`、`components/StageDirector.tsx`、`components/StageExport.tsx`、`services/geminiService.ts`、`license.md` |
| 3.12 Toonflow-app | `HBAI-Ltd--Toonflow-app` | `packages/providers/types.d.ts`、`packages/skills/v118workflow/SKILL.md`、`packages/nodes/videoGenerationNode/src/index.vue`、`apps/server/src/routes/ai/media/`、`apps/web/src/pages/workspace/`、`LICENSE` |
| 3.13 Toonflow-web | `HBAI-Ltd--Toonflow-web` | `src/lib/vendorTemplate.ts`、`src/stores/productionAgent.ts`、`src/views/production/utils/flowBuilder.ts`、`src/views/production/components/workbench/`、`LICENSE`（Apache+补充协议）、`README.md`（归档声明） |

### 8.2 术语小表

| 术语 | 含义（本报告用法） |
| --- | --- |
| Beat / 镜头节拍 | DramaClaw 的生产原子单元（旁白/对白/画面描述/说话人 + 时长），带来源文本哈希 |
| take | 同一镜头的一次视频生成结果（多 take = 多候选）；ToIV 对应 `candidates_json` |
| stale / 过期产物 | 上游（prompt/资产/锚点）变更后旧产物不再匹配但仍可查看的状态（ArcReel 四态之一） |
| artifact_manifest / 产物清单 | 登记产物身份、位置、生成依据的单一真相源（ArcReel） |
| GenerationRecipe | 随镜头持久化的可复现生成配方（prompt/seed/model/params/参考/denoise，AIMS2） |
| R2V / I2V / T2I | reference-to-video 参考生视频 / image-to-video 图生视频 / text-to-image 文生图；LumenX「节奏优先/画面优先」双模即 r2v vs t2i_i2v |
| FLF2V / 首尾帧 | first-last-frame to video：起始帧+结束帧约束生成（AIMS2/CineGen） |
| 定场帧 establishing frame | 场景第一帧锚点，后续镜头与长镜头的一致性参照（AIMS2） |
| Identity / 身份 | DramaClaw 一角色多身份（服装/年龄段变体），含面部提示词与服装参考图 |
| 衣橱 Wardrobe / 衍生 | 角色造型变体（Casual/Tactical…），镜头级选用（CineGen/BigBanana/ArcReel derivative） |
| Reconcile / 对账 | 剧本抽取实体与资产库 AI 匹配 → 合并/新建决策（LumenX） |
| 阶段门禁 gated | 上游未完成时下游可查看但不可执行的状态（LumenX 步骤轨；Toonflow-app 确认关口） |
| 参考槽 ref slot | 生成入参中有序的参考图/视频/音频位（「第一张=场景参考，其后=角色参考」） |
| catalog as code | 模型能力写成可校验配置并生成前后端同源产物（LumenX） |
| 报价单 video_quote | 提交前逐单元去向/档位/预计费用的确认单（ArcReel） |
| 租约 lease / 幂等键 | 任务被 worker 领取的独占凭证 / 防重复提交的唯一键（ArcReel/BeefTV/AID） |
| EDL / FCPXML | 剪辑决策交换格式（CMX3600 EDL、Final Cut Pro XML），供 NLE 继续精修 |
| 扫译 scanlation | 漫画翻译嵌字流程（检测→OCR→翻译→去字→嵌字），KŌMA 的域（非影视） |
| SVML / 词锚 | ToIV 自有脚本锚定格式与词锚拍时间轴（见 ToIV 现状笔记） |

### 8.3 使用说明

本报告可直接用于评审与任务拆分：§1 总表可作评审材料；§3 各章可按需分发给对应子域；§4 可转为 UX/前端验收清单；§5 可直接拆任务（每项已带落点与验收标准）；§6/§7 用于合规与验证口径对齐。所有 commit 与证据路径均可在 `third_party/reference-repos/` 下复核；正文不引用临时调研笔记本身作为证据。