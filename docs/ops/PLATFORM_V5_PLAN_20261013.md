# ToIV v5 方案计划 · 从「能力齐了」到「真能出片、真能看见」（2026-10-13）

> **依据**：本轮三路调研（真源见 §1）+ `main @ f8633401` 代码级盘点 + `docs/ops/DRAMA_UI_PLAN.md` 2026-10-08 实弹日志。
> **前提**：v4 六波次全部完成（STATE `v4_6_arch_close_2026_10_13`）；F1–F7 融合已收口；经典 web 收缩为 7 视图 R18 壳。
> **定位**：本计划替代 `PLATFORM_V4_PLAN_20261012.md` 的排期部分。v3 六条能力主线（C1–C6）**目标不变**，本轮按「调研差距 + 代码实测欠账」重排优先级。
> **状态**：**2026-10-13 用户已授权自主推进**（「后续无需询问我你自主往下进行吧」），并追加 W8/W9 两条指令。执行时守 §17 的六条自约束；三类事仍主动上报（新活雷 / 需推翻既有拍板 / 不可逆或高影响操作）。

---

## 1. 本轮调研真源（三份报告 + 一个新语料池）

| 产物 | 路径 | 内容 |
|---|---|---|
| 商业产品拆解 | `tmp/research-commercial-20261013/REPORT.md`（515 行） | 13 家 × 8 问 + 横向矩阵 + 差距 Top15，逐条挂 URL 与证据强度（官/媒/测/推） |
| 开源参照再挖掘 | `tmp/research-oss-20261013/REPORT.md`（1347 行） | 语料再筛分级 + 8 份源码级深读 + 缺口判断 + 借鉴 Top12（含许可红线） |
| 代码级现状盘点 | `tmp/research-toiv-current-20261013/REPORT.md`（231 行） | 七节，逐条 `文件:行号`；含本机实跑测试/类型检查结果 |
| 新增语料池 | `../AI-OSS-Reference/repos-v5/`（39 仓 / 3.4GB） | H3 生态 19 + 短剧创作台/skill 13 + 剪映时间线 5 + 质检一致性 2 |

**本轮最重要的三个调研发现**：

1. **语料库有致命盲区**：既有 4640 条登记里几乎没有 MiniMax H3 生态（仅 4 条、1 条克隆），而 H3 是现网出片主力（`:8264` 生产口）。2026-08 以来 GitHub 围绕 H3 长出 ≥25 仓生态，其中 ≥8 个 Apache/MIT 可并码。已补 19 仓。
2. **三个互不相关的团队（ArcReel / zenstory / TFboy1）在同一个半年独立收敛到同一套设计**：「自动推断只是候选，用户确认才算绑定」+「未绑定 ≠ 不支持 ≠ 从未推断（三态必须分开）」+「绑节点语义 class_type 而不是绑节点 ID」。三方独立收敛 = 这类问题的正解，我们的 `node_mapping` 契约该照此改。
3. **ToIV 的质检能力在 13 家商业产品里属领先**（只有 Flova 做了失败原因透出+重试），但**缺了「零成本前置闸」**：OpenMontage 用纯 Python 在烧 GPU 之前跑结构质检；我们现在全部质检发生在花钱生成之后。

---

## 2. 调研启示兑现对照（承接 v3 §1 的口径，已兑现的不重做）

### 2.1 v3/v4 已兑现（本轮不重做，只补欠账）

| 启示（来源） | 兑现情况 |
|---|---|
| 剧本→分镜自动化（小云雀/LibTV/NovelFlow） | ✅ `breakdown_script` + 分镜 JSON 契约 |
| N 候选 + 镜头重生成（各家） | ✅ `candidates_json` + pick + 指纹缓存 |
| 角色三视图注册表（ViMax/小云雀/Flova） | ✅ V4-2a 景别→视图优先级重排（`shot_refs.py:108`） |
| 阶段感知换参考（story-claw） | ◐ **只有字段与日志，未真消费**（见 §2.2 第 3 行） |
| VLM 质检门禁 + 自动重生成（story-claw/ViMax） | ◐ 门禁在（`qa_gate.py`），**UI 零透出、多候选路径不重试** |
| Agent 与创作面同构（Toonflow/可灵 MCP） | ✅ V4-1 58 工具（`BUILTIN_ORDER` 程序化数过） |
| 虚拟剧组（纳豆 70 智能体/team.json） | ◐ **只是 `runner.py:67` 提示词第 20 条，team.json 全仓不存在** |
| 真时间线 / 时间线 DSL（即梦/ShortGPT EML） | ❌ V4-4 显式后置 —— **本轮找到成本更低的落地路径（§5 Wave 4）** |
| 播放列表式汇编（TapNow） | ✅ v2 时间线 + `assemble.py` |
| 字幕对齐/BGM/音效/断点续跑 | ✅（sfx 仍 501 占位，`audio_orchestrate.py:15,402`） |

### 2.2 本轮新识别的差距（按「用户可感知价值 ÷ 实现成本」排序，双源确认优先）

| # | 差距 | 商业侧证据 | 开源侧证据 | 代码侧实测 | 落波 |
|---|---|---|---|---|---|
| 1 | **质检结果黑盒**：四问判定与自动重试对用户不可见 | Flova 受限原因透出+重试（13 家唯一） | OpenMontage `character_qa_report` 形状（status/checks/issues/recommended_action） | `candidates_json[i].qa` 已全程透出 API，canvas 侧 grep 零消费 | W1 |
| 2 | **质检全在烧 GPU 之后**，无前置结构闸 | — | OpenMontage `slideshow_risk.py` 6 维 + VBench 16 维词表（Apache） | `qa_gate.py` 三触发点全在 `render_shot` 内 | W1 |
| 3 | **ref_epoch 名不副实**：换装不自动切参考 | LibTV 主体库/三视图锁设定 | zenstory SHT-22/23/25 三态绑定+用途闭集（MIT） | `orchestrator.py:255-268` 仅 `logger.info`，参考组仍由 `shot_refs.collect_cast_ref_images` 决定 | W2 |
| 4 | **拼接是纯流拷贝且无规格断言**（活雷） | — | Motion-Context `level_step.py`（逐段打印采样率并标记不一致） | `concat_parts` = `-f concat -c copy`（`ffmpeg_ops.py:41-56`）；合成前只断言时长+有音轨（`assemble.py:58-122`）；docstring 自认 16fps/25fps 混规格 | **W0** |
| 5 | **新项目/技能模板默认横屏低清** | 短剧标准竖屏 | — | `test_drama_skills.py:113-115` 断言 `768×384@16`；引擎上限 `1344×768`（`engine_registry.py:674`） | **W0** |
| 6 | **无双速出片**（预演档/成片档），试错成本单条 223s+ | Vidu Q3 闪电/大片两档、小云雀智能预演 | TFboy1 参数确认表 + 批量断点监控（MIT） | 无 | W3 |
| 7 | **无宫格选卡**，构图靠一次一张抽卡 | LibTV 多机位 9/25 宫格、剧情推演 4 宫格 | — | `frame-variants` 有三景别 img2img 机器可复用 | W3 |
| 8 | **分镜级局部修改会牵动整链** | Flova 故事板并行局部修改、小云雀分步编辑 | Jellyfish 三状态分离（Apache） | 无级联依赖图 | W3 |
| 9 | **缺剧级聚合层**（剧本/分镜/资产各自为表） | 小云雀故事蓝图 | Jellyfish 数据模型范本（Apache，6.7K★） | `StudioProject/Character/Shot` 三表 + 文件态 `char_asset_*.json` 不入库 | W3 |
| 10 | **真时间线剪辑无出口** | 即梦时间轨 | pyJianYingDraft(Apache)+video-use(MIT)+JyDraft(Apache) EDL 中间表示 | V4-4 后置；`/api/video-edit/render` 生产零使用 | W4 |
| 11 | **H3 原生音画一体没吃透** | 海螺 H3 / Vidu Q3 / Seedance 2.0 音画直出成旗舰标配 | H3 生态 19 仓（AIMixer/tritant Apache） | 对白镜头仍走「H3 画面 + IndexTTS 配音 + 对轴」三段式；10-08 实测 H3 原生音频会呓语 | W7（A/B，需拍板） |
| 12 | **多镜头连续生成已被否，但否决依据的实现有正解** | 可灵 3.0 智能分镜 / Vidu Q3 一镜到底 | Motion-Context latent 级链接 + 反向音频窗口（GPL 抄原理）；Extender/Director（Apache 可并码） | c_hybrid 10-07 用户目检否决；失败根因=像素往返+音频当 reference | W7（A/B，需拍板） |
| 13 | **Agent 无长记忆**（不记得用户画风/画幅/禁忌） | Updream 长记忆助手 | zenstory `project.md` 逐次追加当记忆（MIT） | 无 `user_prefs` 持久化 | W5 |
| 14 | **无拉片分析**（爆款拆解→分镜模板） | LibTV 一键拉片、小云雀 3D 导演台 | — | 本地件全齐：Qwen3-VL(:9311)+whisper 四节点+DSv4 | W5 |
| 15 | **工具(58)与应用(6773)之间缺方法论封装层** | Updream Skills 库、Flova 自建工作流 | video-use SKILL.md 12 Hard Rules（MIT）、agentskills 规范（Apache） | `skill-packages` 仅桌面插件包形态 | W5 |
| 16 | **无对外 CLI/程序化入口** | 纳逗Pro CLI、LibTV Agent Skill 双入口 | — | `toiv-comfy-mcp:9100` 有雏形，无官方 CLI | W5 |
| 17 | **门禁散写三处，回执靠解析文案** | Flova 消息排队+结构化 reason | ArcReel 准入单一缝 + 闭集 `Action` 枚举（AGPL 抄结构） | 封面 autorefire 深度闸 / qa_gate / 批量提交校验各自为政；P-9「成功文案首 60 字禁 hint 词」纪律因此存在 | W1→W6 |
| 18 | **模型信息散在 ≥6 处** | — | lumenx 三层 catalog（MIT） | `TOIV_LLM_PROXY_MODELS` / vLLM 别名 / `model_registry_draft.json`（挂账未落地）/ MODEL_SOURCES 双份 / admin 四 tab / `backends.json` | W6 |
| 19 | **`node_mapping` 绑节点 ID**，工作流重排即静默错位 | RunningHub 工作流封装 | TFboy1 `set_widget(class_type,…)`（MIT）+ ArcReel 三态 | `PLATFORM_V2_CONTRACT.md` §3 `"prompt": "186"` 形态；对应 E-1 与 10-11 三处泄名补丁 | W6 |
| 20 | **经典 web 剩 5 项退役全卡在一个开关上** | — | — | `entry.json` 探测未迁（`apps/web/app/page.tsx:507`）+ R18=A 未拍板 | W5 |

---

## 3. v5 波次总览

| 波次 | 主题 | 内容摘要 | 验收 | 批数 |
|---|---|---|---|---|
| **W0** | 收尾与地基（前置） | 测试红灯收口 / 导航三变更处置 / 拼接规格归一 / 默认竖屏 / 入账与文档回写 / 仓库卫生 | 三端测试全绿可信基线；混规格拼接实弹不出哑音；新建项目默认 768×1344@24 | 2–3 |
| **W1** | 质检闭环（最高性价比） | qa 徽标 UI + 结构前置闸 + VBench 维度字典 + 失败模式注册表 | 分镜卡可见四问逐问判定与 VLM 原话；平庸分镜在提交前被挡；同类失败不再重犯 | 2–3 |
| **W2** | 一致性补课 | ref_bindings 三态+用途闭集 / ref_epoch 真消费 / 角色三视图标准件 / 多主体合并 / 资产入库 | 换装镜自动切参考（断言级）；双角色镜 A/B 一致性数值可比 | 2–3 |
| **W3** | 一键成片自动化 | 双速出片 / 宫格选卡 / 剧级蓝图聚合 / 分镜级局部修改+级联 / 分镜契约升级 / Delivery Promise | 「一句话→全片草稿」预演档实弹；改一镜只级联下游 | 3–5 |
| **W4** | 剪辑与后期出口 | EDL 中间表示 + 剪映草稿出口 + Shrink/ExtendMode + 影调归一 + 词锚定对齐 | 导出草稿在剪映可打开续编；成片影调 A/B 目检 | 2–3 |
| **W5** | Agent 深化与产品收敛 | team.json 物理化 / user_prefs 长记忆 / 拉片分析 / Skills 封装层 / CLI+MCP / 消息排队 / 12 视图终局 | 剧组可唤起且配置可改；外部 agent 一条命令跑全链；经典 web 退役到终态 | 3–5 |
| **W6** | 工程化与防事故 | 准入单一缝+闭集 Action / model catalog 三层 / contract 自检 / node_mapping class_type 化 / DESIGN.md token 契约 | P-9 文案纪律可删；E-1/E-3/D-2 类事故有代码级守卫 | 2–4 |
| **W7** | 机会窗（**均需用户拍板才开**） | H3 音画一体 A/B / 多镜头续接翻案 A/B | 互相关数值 + 盲评量表，不以目检定论 | 2–4 |
| **W8** | RunningHub 全量本地可部署化（**用户 10-13 新增，并行轨 B**） | 只读盘点 → 四类可部署性分类 → 分批 smoke 真跑 → 缺件补权重到 NAS → 批量上架（含说明卡/封面/use_case） | ②可修复类首批转①并公开；缺件清单入账 MODEL_SOURCES；不可本地化者登记不上架 | 3–6 |
| **W9** | Civitai.red R18 参照线（**用户 10-13 新增，并行轨 B**） | 站点与 API 探明 → 与 ToIV R18 栈交叉 → blocked 336 条缺口对照 → 资产与工作流参照补强 | 参照报告 + 可下载缺口清单 + R18 线动作项（仅元数据层，守未成年硬红线） | 1–3 |

**总量约 22–39 批**，比 v4（11–19 批）大得多。**W0–W7 与 W8–W9 是两条可并行的轨**（代码域 vs 数据/运营域，交叉点只有 `app_smoke.py` 与队列闸，见 §17）。

**并行度**：W1（前端为主）与 W2（api 契约为主）可并行；W6 的准入缝最好紧随 W1（同一批数据形状）；W7 独立，随时可插入或永久搁置。

---

## 4. W0 收尾与地基（功能条目级）

### W0-1 测试红灯收口，恢复「全绿」可信基线

**为什么第一刀是这个**：AGENTS 记的基线（api 4132/0、web 1031 全绿）与实测（api 4136/1、web 1158/4、canvas 2679/4）已经对不上两个维度。**基线不可信时，后续每一波的「无新增失败」判据都失效。**

| 项 | 落点 | 动作 |
|---|---|---|
| canvas 治理违规 ×2 | `apps/canvas/web/src/services/toiv/client.ts:1,34`（自己 `import axios` + `axios.create`）、`services/api/nas-models.ts:1,51-69`（`request(apiClient.…)`） | 二选一：改走共享 `http`（符合 canvas AGENTS §4），或进 `test/http-ownership.test.ts:21-27` 白名单并写明豁免理由。**推荐前者**——ToIV 融合新增的 `services/toiv/*` 整体游离在治理外，是 P-2b 第③条在 canvas 域的漏网形态 |
| canvas 陈旧断言 | `test/canvas-connection-create-menu.test.ts:11`（`toHaveLength(7)` 实际 11） | 组件加了节点类型、测试没跟上；更新断言并改为「包含必需项」而非硬编码总数，防再次漂移 |
| canvas 环境性失败 | `test/canvas-document.test.ts:46` / `src/lib/canvas/canvas-document.ts:44` | bun 1.2.17 的 `TextDecoder` 无 gb18030（浏览器有）。加运行时能力探测 + skip 标注原因，**不要为了让它绿而改解码逻辑** |
| 经典 web ×4 | `tests/h3Accel.test.ts`、`tests/studioRenderCancel.test.ts`、`tests/useStudioProject.test.ts`（文件级崩）、`tests/uxBatchC.test.ts:107` | 多指向 studio 视图退役后断言过期。**决策点**：随 W5 经典 web 终局一并删除这些测试，还是现在修？默认=现在标注 `skip(reason="studio 视图已退役，随 W5 清理")`，不投入修复 |
| api 顺序污染 ×1 | `tests/test_studio_consistency_v42.py:196-198` 用弃用 `asyncio.get_event_loop()` | 改 `asyncio.run(...)`；`9e445443` 的 caplog→logger spy 改造没根治，这次根治 |

**验收**：`cd apps/canvas/web && bun run test` 与 `./.venv/bin/python -m pytest tests -q` 与 `cd apps/web && npm test` 三条命令的实际输出贴进 STATE；AGENTS 基线数字同步更正（含「web 1031」→实测值）。

### W0-2 导航卡死修复的三变更处置（含**纠正我上次的错误说法**）

**事实纠正**：我上次报告说「f8633401 含 react-router 8.4.0 升级」——**错**。实际是**从 `^8.2.0` 降级并钉死到 `7.9.5`**（`apps/canvas/web/package.json:74` 精确钉版无 caret；`bun.lock:2210` 与 `node_modules` 实装均已核；全仓无 8.4.0，lock 里的 8.4.0 命中是 eslint-scope）。提交信息自证「已证与 router 版本无关」。

| 变更 | 位置 | 处置 | 依据 |
|---|---|---|---|
| ①根修：FromImageDialog 条件挂载 | `src/pages/toiv/drama-page.tsx:76-84` | **保留** | 10 轮侧栏全路由巡游 10/10 PASS |
| ②react-router `^8.2.0`→`7.9.5` 钉版 | `package.json:74` + `bun.lock` | **保留钉版** | 55 个源文件用 `react-router`，未发现 v8 独有 API；卡死已证与 router 无关，升回 8.x 零功能收益；要升应作独立批带全量回归 |
| ③pathname-key Suspense | `src/router.tsx:50-53` | **短期保留，W0 内补回归后摘除** | 代价比上次说的大：WorkspaceLayout 下**全部路由**（含 `/canvas/:id`）每次导航整树重挂；且内外两个 `key` 有一处冗余（外层已强制子树重建，内层 `UserLayout key` 可省）。缺「去 key 后的回归证据」，所以先补证据再摘 |

**W0-2 动作**：①摘除内层冗余 `key`（1 行）；②跑「去外层 key + drama↔library↔market↔tasks 往返导航 ×10 轮」真机回归；PASS 则摘外层 key，FAIL 则保留并在注释里写明「防御性保留 + 回归日期」；③**修正注释里「react-router 8.2」的措辞**（当前实装 7.9.5，注释与依赖不符会误导下次排障）；④根因最后一层（弹窗内具体哪行副作用卡死 transition）——**建议不再投入**：组件级绕过已验证有效，深挖 React 19.2 + router 内部 transition 语义的边际收益低于同批其它项。若你要求挖到底，单列一批。

### W0-3 拼接规格归一（活雷，优先级高于任何新功能）

**已核实的风险结构**：
- `concat_parts` = `ffmpeg -f concat -safe 0 -i list -c copy`（`ffmpeg_ops.py:41-56`），**纯流拷贝**；
- 合成前只有两条断言：时长 ≈ 源（`assemble.py:58-101`，误差 <0.5s）、每镜有音轨（`:105-122`）；**没有任何采样率/fps/分辨率/编码一致性断言**；
- `assemble.py:3-4` docstring 自己承认「视频链/图像运镜链出 16fps mp4，对口型链出 25fps h264」混规格是常态，并写「规格不一的观众端兼容问题留给后续转码增强」；
- 流拷贝 concat 遇到不一致的音频采样率时，输出沿用首片流头参数，后续片可能变速/静默/播放器 desync，**而 `probe_duration` 照样返回完整时长** → 所有时长检查通过，尾部哑音无人发现。

**待实测确认**（本机不能闭环，需上 core/workstation）：H3 实际输出音频采样率是否 32kHz（开源侧证据：Motion-Context `level_step.py` 专为此写了逐段采样率打印）。

**动作（条目级）**：
1. `assemble.py` 新增 `assert_clip_specs_uniform(shots)`：对每镜 `final_clip` 用 ffprobe 取 `sample_rate / channels / r_frame_rate / width / height / codec_name`，与首镜比对；不一致 → 不静默拼接，走 2；
2. `ffmpeg_ops.py` 新增 `normalize_clip()`（统一 `-ar 48000 -ac 2 -r {fps} -vf scale=… -c:v libx264 -c:a aac`）与 `concat_parts_transcode()`；`concat_parts`（copy 版）保留给「已验证同规格」快路径；
3. `assemble_project` 逻辑：规格一致 → copy 快路径；不一致 → 归一后转码拼接，并把「发生了转码归一」写进 `project.error`/日志（**不静默**，呼应 OpenMontage「大声的失败胜过一个你没注意到的坏渲染」）；
4. 顺带核 `mux_audio_into_video` 的 `-ar 48000`（`ffmpeg_ops.py:140`）与 `assembly.py:432` 的 `aresample=44100` —— **平台内两条链用了两个不同目标采样率**，应统一到单一常量；
5. AGENTS §六 E 类补一条易错点：「H3 音频采样率 ≠ 48000；流拷贝 concat 不能中途改采样率，混规格必须转码」。

**验收**：造一个混规格项目（16fps 无口型镜 + 25fps 对口型镜 + 不同采样率音轨）实弹拼接，逐段 `ffprobe` + `volumedetect` 证明尾部有声；`window_mean_volume_db`（`ffmpeg_ops.py:151`）现成可用。

### W0-4 新建项目默认规格改竖屏

`test_drama_skills.py:113-115` 在断言 `width==768 / height==384 / fps==16`（横屏、低于短剧标准）。10-08 实弹日志已点名这是「一句话到成片新项目会全部低分辨率」的缺陷，当时列为「下一步①」但至今未修。

**动作**：技能模板与新建项目默认改 `768×1344@24`（引擎上限 `1344×768`，`engine_registry.py:674` 的比例限 9:16~16:9 已支持）；同步改断言；核 `engine_registry` 各视频档预设是否都 32 对齐且 ≤1344（`test_engine_registry.py:763` 已有该守卫，复用）。

### W0-5 入账与文档回写（含纠正）

1. STATE + AGENTS 补导航卡死专条，**并写明 react-router 实际是降级钉版 7.9.5**（纠正上一条入账口径）；
2. AGENTS 基线数字更正：api 4136/1/38skip、canvas 2679/4、web 1158/4（W0-1 做完后再更新为全绿值）；
3. AGENTS 第八节划掉已核销项：canvas `tsc --noEmit` 预存失败（实测 exit 0，`b1b13e78` 已修）；Slice C 两处「真缺口」——「经典 view 正文未渲染工具箱分组」已不成立（`MarketView.tsx:27,58,97-102` 自 10-01 Batch3 已在），「0.3 非管理员可见性」代码中不存在该等级实体（可见性=`is_public` + soft-hide + NSFW 门控），**本质是线上验证项而非代码缺口**；
4. `CLASSIC_WEB_RETIREMENT_PLAN_20261011.md` 回写 F1–F7：14 行迁移清单**已完成 9 行**（studio/entities/resources/agent-runs/animatic/audio/imageEdit/videoEdit/dub 全退役成 redirect），剩 5 项（home 探测、image/video、library、market、`/drama/[id]`）；
5. `app/agent/subagent.py:18` docstring「原型状态:未接路由」过期（实际已接 `routes/agent.py:514-527`，202）；
6. `router.tsx` 注释与依赖版本不符（见 W0-2）；
7. 三份调研报告与 `repos-v5/` 语料入账（`AI-OSS-Reference/SURVEY.md` 增补 V5 批次口径——**该文件不在 ToIV git 内，单独提交**）。

### W0-6 仓库卫生（需你给处置意见，我不擅自动）

- `opentalking/` **2.6GB 未跟踪**，含 `.env` 与 `.env.bak.*`，目录结构与 ToIV 同构（`apps/ configs/ AGENTS.md STATE.json`）——疑为某次并行会话/数字人线的整仓副本。**风险**：`.env` 可能含凭据；2.6GB 在仓库根会污染 glob/检索。**选项**：A 移出仓库到 `../` 保留；B 确认无用后删除；C 保留但在 `.gitignore` 显式登记 + 说明来源。**默认 A（可逆）**。
- `drama/output/` 57MB 未跟踪：疑为本地实弹产物，同上处理。
- `f3-verify.tmp.mjs`、`toiv.db`（AGENTS 已记「core 的 toiv.db 是废弃 SQLite 勿用」，本地这份同理）：确认后清理。

### W0-7 执行记录（2026-10-13 本轮已做，含两处自我修正）

**已完成并实测验证**：

| 项 | 动作 | 实测结果 |
|---|---|---|
| api 顺序污染 | `tests/test_studio_consistency_v42.py` 弃用 API `asyncio.get_event_loop().run_until_complete(...)` → `asyncio.run(...)` | **4137 passed / 0 failed / 38 skipped**（259s，原 4136/1）✅ 根治 |
| 经典 web 4 红 | ①`tests/mocks/studioApi.ts` 补两个漏掉的替身导出 `pickStudioCandidate` / `rerunStudioStep`（含 `calls`/`defaultImpl`/`makeStepRerunResult`）——**真 `lib/api.ts:5064/5146` 一直有导出，纯属 mock 漂移（P-2b ③ 漏网），不是生产缺陷**；②`h3Accel.test.ts`「提交携带加速档」脆断言改语义断言（组件已演进为 `effectiveAccel`：H3 家族手动档优先、未选则 `speedTierToH3Accel(speedTier)` 映射、非 H3 回落 `"off"`，`AppRunnerView.tsx:323-334`，**行为正确**）；③`studioRenderCancel.test.ts`「单镜未传 signal」同为脆断言（hook `useStudioProject.ts:113` 实际是 `renderStudioShot(sid, { signal: ac.signal, body })`，加了 `body` 后字面量就不匹配了，**signal 一直在传**）；④`uxBatchC.test.ts`「引导文案未指路分镜阶段」同为脆断言（`AssemblyStage.tsx:79` 现文案 `先到「剧本」拆解或「分镜」新增`，语义达标） | **1166 tests / 1166 pass / 0 fail**（原 1158/1162；总数+4 因 `useStudioProject.test.ts` 从文件级崩恢复为可运行）✅ |
| canvas 2 红（陈旧断言 + 环境性） | ①`canvas-connection-create-menu.test.ts` 硬编码 `toHaveLength(7)` → 改为「必需 7 项 + 新增节点须显式登记进 KNOWN 白名单」（实际 11 项：原 7 + `tpl-t2i/tpl-inpaint/tpl-lipsync/tpl-dub`）；②`canvas-document.test.ts` gb18030 用例加能力探测 `test.skipIf`（bun 1.2.17 的 `TextDecoder` 无 gb18030，浏览器有；**不改解码逻辑**） | 定向 6 pass / 1 skip ✅ |
| canvas 2 红（治理违规） | ①`services/api/nas-models.ts` 从旧写法 `request(apiClient.*)` 迁到 `http.get/post`（4 处；**平面判断已核实**：它打的是 Go 后端 `backend/internal/handler/nas_models.go:34,48,51,68`，信封一致，迁移安全；消费方 `pages/settings/local-compute-pane.tsx:45`）；②`services/toiv/client.ts` **不迁** —— 修正本报告 W0-1 原判：该文件 docstring 明写它是**刻意的第二数据平面**（同源 `/api` 直连 ToIV FastAPI、裸 JSON、ToIV JWT），共享 `http` 会解 `{code,data,msg,reason}` 信封，并过去必然破功。改为把它登记为「第二个 axios 实例根」，`http-ownership.test.ts` 新增 `axiosInstanceRoots` 集合并把用例改名为 `axios.create stays in the two data-plane roots` | 主批 **2682 pass / 2 skip / 0 fail**（原 2679/4fail）✅；`tsc --noEmit` exit 0 ✅ |
| W0-2 导航三变更 | 摘除 `router.tsx:50` 内层冗余 `key={pathname}`（外层 Suspense key 已强制子树重建，内层是 no-op）；注释里「react-router 8.2」措辞修正为「当时环境是 8.2，已证与版本无关，当前实装钉版 7.9.5」，并写明「摘除外层 key 前须补 drama↔library 往返回归」 | 已改；**外层 key 保留**（回归证据未补，见下） |

**W0-3 已实现（代码 + 单测，生产混规格实弹验收待做）**：

- `ffmpeg_ops.py` 新增：`TARGET_AUDIO_SAMPLE_RATE=48000` / `TARGET_AUDIO_CHANNELS=2` 单一常量（历史上 mux 用 48000、`routes/assembly.py:432` 用 44100，两个目标采样率并存）；`probe_media_spec()`（ffprobe 取 video 的 codec/width/height/r_frame_rate 与 audio 的 codec/sample_rate/channels，失败抛错不静默猜测）；`spec_diff_fields()`（含「有的片有音轨有的没有」这种 `audio.presence` 不一致）；`normalize_clip()`（等比缩放 + 补边到首片几何、`fps` 对齐、`aresample` + `aformat=stereo`、libx264 crf18、`+faststart`）；`concat_parts_uniform()`（全一致 → 流拷贝快路径零画质损失；有差异 → 只重编码不一致的那几片，参照片原样保留，临时件用完即删；返回 `{mode, normalized, diff, specs}`）。
- `assemble.py`：改调 `concat_parts_uniform`；`mode == "transcode"` 时 **`logger.warning` 显式记录**归一片数与差异字段（不静默）；模块 docstring 重写——原文自相矛盾（先说「同规格」又列出 16fps/25fps 两种）且把兼容问题「留给后续转码增强」，现已兑现并写明「为什么不能无条件流拷贝」。
- 新增 `tests/test_studio_assemble_spec_uniform.py` **15 例全绿**（纯单元，monkeypatch probe/concat/normalize，不依赖真媒体与 ffmpeg）：视频四字段与音频三字段逐项差异检测、`sample_rate="32000"` 专列一例（H3 侧实测口径）、音轨有无不一致、全一致走 copy 且不重编码、混规格只归一 2/3 片且参照片不动、临时件清理、空片段抛错、平台音频目标单一真源。
- 连带修复：`tests/test_studio_assemble.py` 两用例原先 monkeypatch `assemble.concat_parts`（已随本次改动移除该导入）→ 改 patch `concat_parts_uniform` 并让桩返回报告字典。`test_studio_assemble.py` + 新测 + `test_drama_assemble.py` 合计 **35 passed**；api 全量 **4150 passed / 0 failed / 38 skipped**（含新增 15 例）。
- **仍待做**：生产混规格实弹（16fps 无口型镜 + 25fps 对口型镜 + 不同采样率音轨 → 拼接后逐段 `ffprobe` + `volumedetect` 证明尾部有声）；以及核 H3 实际输出采样率是否 32kHz（需上 workstation 取一条真产物探测）。`routes/assembly.py` 的 `aresample=44100` 是否统一到 48000 **本次未动**（属另一条链，改动面需单独评估）。

**两处自我修正（原判有误，按证据改口）**：

1. **W0-4「默认横屏低清」不是活路径缺陷**。`apps/api/app/models.py:655-657` 实证 v2 Studio 域默认**已经是竖屏 `STUDIO_DEFAULT_WIDTH=768 / HEIGHT=1344 / FPS=24`**，且 `services/studio/schemas.py:157-159` 注释明写「宽高上限对称 1920:竖屏短剧(如 720×1280)需要 height > 1080」——10-08 日志里那条缺陷在活路径上早已修好。残留 `768×384@16` 的只在**旧 Drama 域**（`routes/drama_skills.py:35-36,60,85-86,105-106,180`、`routes/drama_studio.py:193` 且 `height` 上限 `le=1080`），而 `applySkill` 在前端**已无调用方**（仅 `apps/web/lib/api.ts:4284` 客户端函数 + `test_drama_skills.py` 断言）。→ **W0-4 降级并改挂 W5-7**：随经典 web 退役一并删除旧 Drama 域的建项目路径与其测试，不单独改默认值（改死代码的默认值没有用户价值）。
2. **W0-1 对 `services/toiv/client.ts` 的处置判断反了**（原写「推荐改走共享 http」）。见上表，已按第二数据平面处理。

**新发现的既有红灯（此前无人报告，AGENTS 基线称全绿）**：

- **W0-1b `apps/canvas/web/test/asset-view-scope.browser.test.ts` 5 例全红**。证据链：①**clean HEAD 同样 0 pass / 5 fail**（定向 `git stash push` 我的 5 个 canvas 文件后重跑，已 `stash pop` 复原，工作树完好）→ 与本轮改动无关；②其它 browser 套件正常（`home-dark-palette` 2/2、`reference-links` 4/4）→ playwright/Chromium 脚手架没坏，是该文件单独坏；③首个失败点是 `page.reload()` 后 `getByRole("dialog")` 永不出现（`:160`，15s 超时），其余 4 例是浏览器关闭后的级联（有用例耗时 4258071123ms，计时器已崩）；④该测试用 Bun plugin 自注入 `__assetViewHarness`，而 `src/` 里**搜不到** `__assetViewHarness` → 疑为夹具与被测应用脱节。
- **口径修正**：盘点报告里 canvas「2679 pass / 4 fail（2684 tests / 408 文件 / 9.4s）」只是 `run-test-suite.mjs` 的 **shared 批**；该脚本随后会**逐个** isolated 跑 20 个 `.browser.test.ts`（每个启一次 Chromium），这一段此前未被计入基线。故「canvas 全绿」的判据必须写明是 shared 批还是含 browser 批。
- **处置**：不并入本轮（需按系统化调试单独立项：先读 `beforeAll` 的 plugin 注入与 `page.reload()` 后期望出现的 dialog 是哪个），登记为 **W0-1b**，与 W5-7 媒体库/资产面改造同批处理更划算。



---

## 5. W1 质检闭环（最高性价比，双源确认）

### W1-1 qa 徽标 UI（纯前端，数据已就位）

- **后端现状**：`qa_gate.py` 四问（人物/服装/场景/画面健康）0–10 分（`_QA_PROMPT:42-47`），阈值 `PASS_MIN=6.0 / ITEM_MIN=4.0` / 抽 3 帧（`:36-38`），`verdict ∈ pass|warn|fail`（`:169-173`），结果落 `candidates_json[i].qa`（`:9`）；toiv-vlm 未配置一律 skip 不阻塞（`:50-53`）。
- **前端现状**：`apps/canvas/web/src/pages/toiv/*` 对 qa/verdict **零消费**（grep 仅命中无关的 art-critique 与 agent-run）。
- **动作**：分镜卡（`drama-workspace.tsx` 镜头段）与任务中心加徽标——`pass/warn/fail/skip` 四态色点 + hover 展开四问逐问分数 + VLM 原话理由 + 「按建议修改并重试」按钮（绑 W1-4 的 `recommended_action` 闭集）。**形状抄 OpenMontage `character_qa_report`**（AGPL，只抄结构：`status` + `checks`(bool 集，`additionalProperties:false`) + `issues[]` + `recommended_action`(5 值闭集)）。
- **约束**：P-2b——engineStudio 零 hex，先 grep `globals.css` 取 token；多组件文件用 `<style jsx global>` + 前缀命名；新增 `lib/api` 导出必补替身（canvas 侧对应治理是 `test/http-ownership.test.ts`，W0-1 已收口）。
- **验收**：生产实弹一个项目，截图证明徽标与 VLM 原话可见；`qa=skip`（VLM 未配置）时必须显示「未质检」而不是伪装成 pass。

### W1-2 生成前零成本结构闸（省 GPU，开源侧最强借鉴）

- **动作**：新增 `apps/api/app/services/studio/structural_gate.py`，跑在分镜 JSON 上、**提交生成之前**，纯 Python 零 GPU：
  - (a) **slideshow 风险 6 维打分**：`repetition / decorative_visuals / weak_motion / weak_shot_intent / typography_overreliance / unsupported_cinematic_claims`，每维 0–5（越低越好），返回 `{average, verdict, dimensions:{name:{score,reason}}}`；判决 `<2.0 strong / <3.0 acceptable / <4.0 revise / >=4.0 fail`，**fail 不许进 compose**；
  - (b) **场景变化检查**：某一种 `shot_size` 在 ≥4 镜里占比 >50% → violation 并给百分比；
  - (c) **通用词检测**：22 词 `GENERIC_PHRASES` 词表（"a person"/"modern"/"stunning"/"seamless"…）标记懒惰描述；
  - 自我定位照抄其纪律：「**这是结构性检查，不是创作判断**——只标记那些可靠地产出平庸结果的具体模式」。
- **输入依赖**：需要 W3-1 的镜头语言闭集字段才能算准（`shot_size`/`camera_movement`/`shot_intent`）。**排序建议**：W1-2 先用现有 4 值 `shot_size` + 自由文本 `camera` 做 (b)(c) 两维（已能挡掉大部分平庸），(a) 的完整 6 维等 W3-1 契约升级后补齐。
- **失败回喂**：violations 走现有「错误清单 + `previous_failed_attempts` 回喂 LLM 重试 ≤3 次」通道（`PLATFORM_V2_CONTRACT.md` §4）。violations 是**问题码 + 具体数字**而非自然语言，因此不踩 P-9「成功文案首 60 字禁 hint 词」的坑。
- **许可红线**：OpenMontage **AGPL-3.0，严禁并码**——6 维名称/阈值/定位属思路，`slideshow_risk.py` 代码必须自写。
- **验收**：拿 10-08 雨夜整集与《两小时的注定》v7 的真实分镜 JSON 回测，证明结构闸能标记出当时人肉审片发现的问题（s8 场景断裂成灰棚、s2 乱码招牌、s5 潜水艇生成成老爷车）中的结构性部分。

### W1-3 VBench 16 维作为质检维度字典（不跑其模型）

把「四问」扩成按维度打分的结构化裁决：`subject_consistency / background_consistency / temporal_flickering / motion_smoothness / dynamic_degree / aesthetic_quality / imaging_quality / overall_consistency / object_class / multiple_objects / color / spatial_relationship / scene / temporal_style / appearance_style / human_action`（`Vchitect/VBench` **Apache-2.0**，维度词表与定义可引用，跑其模型才需引入代码）。

**关键补强**：现有四问是**单帧**判定，而 10-08 人肉审片（12 帧×12 镜=144 帧）发现的四类典型缺陷——镜内场景跳变/人物瞬移、镜内人物切换硬切、服装饰品时有时无、AI 文字招牌——**三类是时序缺陷，单帧看不出来**。动作：`qa_gate` 抽帧从 3 帧升到「首/中/尾 + 均匀 12 帧」两档（快/严），提示词增加时序四问（镜内是否场景跳变/是否人物切换/服装饰品是否全程稳定/是否出现文字招牌）。

### W1-4 失败模式注册表 + 逐轮收敛史（质检闭环的后半环）

- **现状缺口**：「VLM 四问 → 失败补候选 ≤2 轮」，失败**原因没有结构化沉淀**，同类失败反复发生。
- **动作**（**用 PG 实现，抄结构不抄码**；来源 dramaclaw **ELv2 source-available，严禁并码**）：
  - `failure_mode_defs`（全局）：`code / layer / description / negative_prompt_clause / registry_version`；
  - `failure_mode_hits(project_id, code, episode, evidence)`（项目内，不跨项目共享）；
  - `convergence_rounds(project_id, episode, phase, round_num, passed, metrics)`：逐集/逐阶段通过史；
  - 门面 `build_negative_prompt_clause(layer)` 与 `load_negative_clause_for_project(project_id, layer)`（可安全从同步管线代码调用）；
  - `registry_version` **只哈希规范定义**（迁移合并进来的遗留行不贡献版本）。
- **直接收益**：①2026-10-05「设定卡 1224 局 fallback 根因=编辑底图缺陷（`base_expr_2` 嘴微张小 O / `base_expr_3` 底部灰带 + 构图 top=0 vs 锁定格 0.117），换 seed 无效」——这正该是一条带 `layer` 的失败模式定义，而「1224 局」本身就是 `convergence_rounds` 该记的通过史；②封面 autorefire 的「深度闸 12 + 尝试上限 3 + 批限 120」有了数据依据（AGENTS 写「勿手动乱调」，那就让它按收敛趋势自动调）；③`qa=fail` 自动重试目前**只在同步单候选路径**（`routes/studio.py:2148-2193`，`MAX_ATTEMPTS=2`，`qa_gate.py:221-226`），多候选/异步路径明确不重试（`:2148-2149` 注释）——注册表落地后把重试策略统一到异步路径。

### W1-5 成片级抽检（v3 C2 遗留未做）

`splice2`/`assemble` 合成前按镜抽样质检，坏镜挡在合成前。落点：`assemble_project` 在两条断言之后、`concat_parts` 之前插入 `qa_sampling_gate`（抽样比例可配，`fail` 镜阻断并回报镜号）。与 W0-3 的规格断言同批做，同一个函数入口。

---

## 6. W2 一致性补课（功能条目级）

### W2-1 参考图三态绑定 + 用途闭集（取代「按主体类型分槽」）

- **现状**：`PLATFORM_V2_CONTRACT.md` §3 `ref_slots` = `character{max:4,required:1} / scene{max:2} / motion{max:1}` —— 按**主体类型**分槽，无法表达「这张锁身份、那张锁构图」，也无法区分「没绑」的三种原因。
- **改为**：`ref_bindings: [{slot, purpose, state, asset_id?, note?}]`
  - `purpose` 闭集：`身份 / 造型状态 / 地理 / 构图 / 尺度 / 效果 / 起始帧 / 结束帧 / 风格`；每镜**至多一个「起始帧」和一个「结束帧」，且「结束帧」必须有「起始帧」**；
  - `state` 四选一：`bound`(已绑真实图) / `planned`(声明创作者自备槽位，指向已有 `IMG-`/`SHOT-`，**永不声称拥有图片**) / `missing`(部分绑定+点名仍缺的：起始/身份/地理/道具) / `declined_t2v`(创作者**明确**选择文生视频)；
  - **核心纪律**：「**省略参考选择 ≠ 同意文生视频**」；「提示词条目、看似合理的文件名、文字描述都不算真实图片」；
  - 每镜新增必填 `visual_basis`（视觉依据，逐项解析到 `character_asset` 既有实体）。
- **与既有能力衔接**：`character_asset.py` 已有锚点/色板/**覆盖缺口 chip**/补拍计划——「覆盖缺口」正是 `visual_basis` 的未解析项；`get_image_bytes_any`（E-8 input→output 双形态）正是「文件名像但内容未核对」的防线。
- **生成前校验**：有 `missing` 就不许提交 t2v（走 W1 结构闸同一入口，报 problem code 而非文案）。
- **来源/许可**：zenstory `skills/short-drama-storyboard/references/stage-contract.md` SHT-22/23/24/25（**MIT，可并码**，保留 LICENSE/NOTICE）；ArcReel `GLOSSARY.md` 三态（**AGPL，只抄语义**）；`bytedance/UNO` 多主体（Apache，仅模型侧对照，不引权重）。
- **命中弱项**：参考槽位分层/多主体合并（v3 C1 遗留）。

### W2-2 ref_epoch 从「日志」变「真消费」

- **现状**：`StudioShot.ref_epoch/ref_epoch_note` 列在（`models.py:730-731`，启动迁移 `app/db.py:129-130`），PUT 可写（`routes/studio.py:1476-1479`，schema `services/studio/schemas.py:217-218`），但**渲染路径只 `logger.info("…阶段感知参考组")`**（`orchestrator.py:255-268`），参考组仍由 `shot_refs.collect_cast_ref_images` + `infer_view_priority`（`shot_refs.py:108`）决定。测试 `test_studio_consistency_v42.py:119-158` 只断言持久化与 PUT，**不断言参考组切换**。
- **动作**：①`character_asset` 增加 `epoch` 维度（服装/道具实质变化=换装/湿身/受伤才切），同 epoch 镜头共享同一参考组；②`collect_cast_ref_images` 接受 `ref_epoch` 参数并按 epoch 选参考版本；③补断言级测试：造 epoch=1/2 两镜，断言取到的参考图 URL 集合不同；④`ref_epoch` 变更时联动 W2-1 的 `ref_bindings.state`（旧绑定自动降为 `missing`，逼迫显式重绑而不是静默沿用旧装）。

### W2-3 角色三视图标准产物 + 资产等级递进

- **现状（已核实，比预想更弱）**：设定卡/展示卡有了（`render_character_card`，`character_asset.py:856`），但 **v2 主线角色卡 `StudioCharacter`（`models.py:685-696`）没有三视图列**——只有扁平 `reference_images`（JSON 数组，注释写明「视频默认读此列」）+ `reference_images_by_style`（`{anime:[…], ancient_realistic:[…]}`）+ `voice_ref_url`。`reference_front/side/back` 三列只存在于**旧域** `DramaCharacter`（`models.py:498`）。V4-2a 的「三视图注册表」实际是**对扁平参考图列表按镜次景别做视图优先级重排**（`shot_refs.py:108` `infer_view_priority`），不是独立的三视图槽位。
- **因此本条有两条路，需你选（决策点已列入 §14）**：
  - **路 A（推荐，与 W2-1 合流）**：**不加 front/side/back 列**，改为给每张参考图挂 `purpose` + `view_angle` 元数据（正是 W2-1 的 `ref_bindings`），三视图成为「`view_angle ∈ FRONT/LEFT/RIGHT/BACK/THREE_QUARTER/TOP/DETAIL` 的三张必备图」。优点：不动 schema、与用途闭集统一、扁平列表兼容不破；缺点：查询要走 JSON。
  - **路 B**：给 `StudioCharacter` 补 `reference_front/side/back` 三列对齐旧域字段名（`PLATFORM_V2_CONTRACT.md` §1.2 当初给 `DramaAsset` 定的就是这个口径：「对齐 DramaCharacter 既有字段名」）。优点：直白、SQL 可查；缺点：与 W2-1 的多槽位模型重复表达，且要写启动迁移（`app/db.py`）。
- **共同动作**：①固定工作流：角色定妆图 → 三视图 → 入资产版本链（`record_regeneration`，`character_asset.py:352`）；②三视图直接作为后续 i2v 参考输入（接 W2-1 的 `purpose=身份`）；③引入 `AssetQualityLevel LOW→MEDIUM→HIGH→ULTRA`（由低到高逐步补齐更多角度/细节图），把现有「覆盖缺口 chip / 补拍计划 / coverage-plan 3 job」改成按等级递进（来源 Jellyfish **Apache-2.0，可并码**；与 TFboy1「人物四视图=三张不同视角全身+一张脸部特写，锁定脸/年龄/体型/发型/服装/饰品/惯用手」互相印证）。

### W2-4 角色资产入库（架构债，为 W3 剧级蓝图铺路）

- **现状**：`char_asset_{cid8}_{style}.json` / `char_card_*.png` 写磁盘不落库（`character_asset.py:538-543`，`asset_json_path`=`drama_output_root()/studio/…`，NAS 优先降本地 `app/storage.py:81-90`；原子替换写 `:557-571`；422 校验闸 `:558-561`）；5 个 REST 端点 `routes/studio.py:1311/1325/1360/1388/1413`。**无 CharacterAsset 表**。
- **代价**：无法做剧级检索/聚合（W3-3 需要）、无法用 SQL 保证一致性、并行会话互踩只能靠 mtime 佐证（10-06「D4 编辑底图重做=并行会话持有，`base_expr_*` mtime 佐证，本线不碰防 P-5」）。
- **动作**：新增 `CharacterAsset` 表（`project_id / character_id / style / epoch / anchors JSON / palette JSON / overrides JSON / lipsync_series JSON / version / provenance JSON / locked / file_url / fingerprint8`），文件态保留为**产物**、DB 为**索引与真相**；内容寻址工件库口径照 `artifacts/<sha256_prefix>/<sha256>.<ext>`（「调用点只见到解析后的路径加哈希，**从不自己挑文件名**」；「**只有本模块拥有布局，调用方不得自创子目录**」——dramaclaw `artifact_store.py`，ELv2 只抄思路）。
- **迁移**：一次性脚本扫存量 `char_asset_*.json` 灌库，双写一个批次后切读，旧文件保留为回滚快照（照 M4-3 typed-import 迁移的成功口径）。

### W2-5 多主体合并参考 + 视频参考锁主体

- **多主体合并**（NovelFlow `merged_character_image` 范式 + `bytedance/UNO` Apache 对照）：双/三角色镜头先合成合并参考图再喂视频参考槽；工作流按资产组合自动选型（单/双/三参考模板，`workflow_templates` 已有骨架）。
- **视频参考**（可灵 Elements 3.0 / Vidu 参考生 / Seedance 2.5 五十素材混参）：`character_asset` 加「标准动态参考」字段（5s 定妆动态视频），生成链传入 H3 参考模式；顺带把参考包（图+视频+音色样本）绑定角色。**依赖 W7 的 H3 生态核实结果**（AIMixer 9图/3音/3视频槽位协议，Apache）。

---

## 7. W3 一键成片自动化（功能条目级）

### W3-1 分镜 JSON 契约升级（本波地基）

- **现状**：`PLATFORM_V2_CONTRACT.md` §4 —— `shot_size`（4 值）+ `camera`（**自由文本** `"low_angle_dolly_in"`）+ `beat`（自由文本 `"铺垫"`）。
- **改为三层**：
  - **(a) 镜头语言闭集**（两套独立收敛取并集）：`shot_size`(ECU/CU/MCU/MS/MLS/LS/ELS + over_shoulder/insert/establishing) · `camera_angle`(EYE_LEVEL/HIGH_ANGLE/LOW_ANGLE/BIRD_EYE/DUTCH/OVER_SHOULDER) · `camera_movement`(STATIC/PAN/TILT/DOLLY_IN/DOLLY_OUT/TRACK/CRANE/HANDHELD/STEADICAM/ZOOM_IN/ZOOM_OUT + whip_pan/orbital/rack_focus…) · `lens_mm`∈[14,24,35,50,85,135,200] · `lighting_key` · `depth_of_field` · `color_temperature` · `transition`(CUT/DISSOLVE/WIPE/FADE_IN/FADE_OUT/MATCH_CUT/J_CUT/L_CUT) · `vfx_type`(13 值) · `dialogue_line_mode`(DIALOGUE/VOICE_OVER/OFF_SCREEN/PHONE)；
  - **(b) 规则四分类**：每条契约规则标 `structural_invariant`（机器可校验，进 pydantic 校验器）/ `reviewed_invariant`（必须 agent 或人审，进 Qwen3-VL 提示词）/ `craft_default`（默认可覆盖）/ `taste_option`（不设门禁）；
  - **(c) 意图字段**：`shot_intent`（这一镜为何存在）· `narrative_role`（10 值闭集，取代自由文本 `beat`）· `information_role`（观众学到/感受到什么）· `hero_moment`（bool，全片视觉峰值）。
- **连带收益**：`hero_moment` 让「哪几镜值得多抽卡/多轮重试」有据可依（现在封面 autorefire 与补候选是**均匀用力**）；`narrative_role` 让「挑高光」（`dub_text.py:529`，V4-5 已上线）从启发式变成字段查询。
- **补一条**（TFboy1 MIT「八条生命通道」）：`seam_to_next`(continue/overlap/matchcut/hardcut) 现有字段（`models.py:724-727`）补一个必填 `seam_anchor`——「上下镜头必须至少传递一个锚点（同一动作方向/同一视线目标/同一道光/同一个道具/同一种轮廓/同一段声音/同一股受力），禁止无理由跳切」。契约里 `seam_anchor` 字段已存在但为空串，本条是把它变成必填 + 校验。与 W7 的「气闸」规则同源。
- **许可**：Jellyfish **Apache-2.0 可并码**（枚举与中英映射表 `SHOT_TYPE_ZH`/`CAMERA_ANGLE_ZH` 可直接移植，保留 NOTICE）；zenstory **MIT 可并码**；OpenMontage **AGPL —— 电影词汇本身是行业事实不受版权保护，但 `scene_plan.schema.json` 的具体 JSON 结构是表达，必须自己重写 schema，不可复制文件**。

### W3-2 双速出片（预演档 / 成片档）

- **动机**：单条满配 223s+（10-11 烟测）/ 360–552s（10-08 雨夜 12 镜，总 ~75 分钟）。所有镜头都跑满配 → 试错成本高到不敢迭代节奏。
- **动作**：`StudioProject` 加 `render_tier ∈ preview|final`；preview 档 = 低分辨率 + 少步数 + 单候选 + 跳过 qa 严档（走 W1-3 快档）；分镜表加「本镜预演通过」勾选，勾选后批量升 final 档重跑。`workflow_template` 增 `preview_variant`（同 engine/mode 的低配 node_mapping，`acceleration.default_steps` 下调）。
- **本地优势放大**：商业产品受积分制约束不敢做（Vidu 靠「闪电出片」当卖点收费），我们边际成本≈电费。
- **验收**：雨夜整集 12 镜预演档全片时长与总耗时实测，对比 10-08 的 ~75 分钟基线。

### W3-3 剧级「故事蓝图」聚合层

- **现状**：剧本/分镜/角色资产各自为表（`StudioProject:660` / `StudioCharacter:685` / `StudioShot:699` + 文件态资产），缺全剧级索引与全局改写入口。
- **动作**：①聚合读端点 `GET /api/studio/projects/{id}/blueprint`：角色×场景×镜头关系 + 节拍结构（`narrative_role` 序列）+ 每镜 `ref_bindings` 覆盖状态 + qa 状态；②canvas 加蓝图视图（关系图 + 缺口 chip）；③**全剧级指令**：「所有镜头换成冬装」→ 定位受影响镜头（`ref_bindings.purpose=造型状态` 命中的）→ 自动 bump `ref_epoch`（W2-2）→ 生成补拍计划（`coverage-plan` 已有）。
- **依赖**：W2-1（ref_bindings）、W2-2（epoch 真消费）、W2-4（资产入库）、W3-1（narrative_role）。**这是本波最重的一条，建议放最后**。
- **数据模型参照**：Jellyfish（Apache-2.0，6.7K★）——短剧端到端生产工作区的范本；其「**三状态分离**（信息确认 / 运行时任务 / 生成准备度），并明确废弃 `generating` 作为 shot.status」可结构性消灭 **H-4「DB 标 error ≠ 生成失败」**。落点：`PLATFORM_V2_CONTRACT.md` §5 状态机按此重写（现状 `StudioShot.status: draft|queued|rendering|rendered|voiced|lipsynced|done|error` 把三件事混在一根轴上）。

### W3-4 分镜级局部修改 + 级联

- **动作**：对话/UI 里「第 N 镜改成 X」→ 定位分镜 → 只重跑该镜 → **仅级联受影响下游**（拼接/字幕/音轨），不动其它镜。需要一张显式依赖图（镜→候选→成片片段→字幕 cue→音轨段），落 `AgentTask.depends_on`（`models.py:788` 已有 DAG + `attempt≤2` + `idempotency_key`，可直接复用）。
- **契约纪律**（Jellyfish/ArcReel 共同点）：「**不兼容的显式 Take/Retry 请求不会被替换成另一个 Take**」——用户点名要重跑第 5 镜，系统不许拿第 4 镜的结果顶上。

### W3-5 Delivery Promise（防「静默降级」）

- **动机**：我们已付过两次学费，共同结构都是「**一个环节静默替换了另一个环节承诺的东西**」——①`ea1d4914` H3 FL2VA 反向别名把 RH 合规名改写成 NAS pruned 名被命名守卫拒（E-3 三连实证，六轮排查才 PASS）；②`907f5f85`/`h3_missing_trusted_identity`——audit 判「功能等价」的 pruned 权重实际不可替换（曲线表变体与 release config 不配、NAS VAE 多两键）。
- **动作**：`Job` 表（`models.py:97-142`）加 `promise` JSONB：`{engine, mode, weights_identity, min_motion_ratio, still_fallback_allowed, native_duration_s, audio_sample_rate, workflow_template_version, jianying_draft_version?}`；在 `POST /api/studio/c-chains`（`routes/studio.py:2272-2306`）与批量提交入口写入并**锁定**；`deps.resolve_worker()`（E-1）与命名守卫校验失败时**抛准入问题码**（W6-1）而不是换后端；compose 阶段兑现不了就**停下来问**，不静默替换。
- **把 H3 工程事实钉进 promise**：`audio_sample_rate`（W0-3 实测值，不是想当然的 48000）、`native_duration: 5–15s`、`context_length: 22` 造成的 0.92s 头部裁剪、`acceleration.lora: lightx2v_turbo_8step`（**Turbo LoRA 与 Spectrum 加速都牺牲音频**，配音质量需单独核）。
- **许可**：OpenMontage **AGPL，只抄概念**；`PromiseType` 取值与 `min_motion_ratio` 阈值可作设计参考，实现自写。

---

## 8. W4 剪辑与后期出口（V4-4 后置项的低成本翻案）

> V4-4 决策（`V4_4_TIMELINE_DECISION_20261013.md`）后置的是「**自研拖拽时间线编辑器 / Remotion / 时间线 DSL**」，理由是 2-3 批级前端工程 + 长期维护面与「本地自用」不匹配。**本轮找到的路径不违反该决策**：不自研 NLE，而是「EDL 中间表示 + 导出到用户已有的剪映」。其重新评估触发条件之一「Agent 代操发现 plan JSON 表达力不足」也已部分成立（Shrink/ExtendMode 的 8 个枚举解决的正是「计划时长 ≠ 实际时长」，这是 plan JSON 表达不了的）。

### W4-1 EDL 中间表示（第一步，小）

- 新增 `apps/api/app/services/studio/edl.py`：`edl.json` = 源 / 入点 / 出点 / 转场 / 轨道 / 时间轴偏移；时间基用**微秒** + `Timerange`。
- 现有 `assemble.py`（concat）与 `routes/audio_orchestrate.py`（tts/separate/concat/mix/variant）改为「**先出 EDL，再按 EDL 渲染**」，一份 EDL 同时导出 ffmpeg concat / 剪映草稿 / canvas 只读时间线。

### W4-2 剪映草稿出口（第一步，小；**唯一直接命中且许可干净的一条**）

- `POST /api/studio/projects/{id}/export/jianying-draft` → 用 `pyJianYingDraft`（**Apache-2.0，PyPI 包，直接依赖比复制代码更干净**）产出草稿 zip；
- 暴露 `ShrinkMode`（新素材比槽位短）：`cut_head / cut_tail / cut_tail_align`（裁尾并消除间隙，后续片段依次前移）`/ shrink`（保持中点，两端向中间靠拢）；`ExtendMode`（新素材比槽位长）：`cut_material_tail`（**总是成功**）`/ extend_head`（与前续重合时失败）`/ extend_tail`（与后续重合时失败）`/ push_tail`（必要时依次后移，**总是成功**）；`maintrack_adsorb` 作草稿级开关；
- **模板模式**：加载已有草稿当模板、按名替换片段素材与文本；**导入的轨道与新建的轨道分离**以最大限度兼容模板中的复杂特性（文本特效/复合片段）；`_track_ref_owner_id` 校验 TrackRef 归属。
- **平台限制（必须写进 UI 与文档）**：pyJianYingDraft README 诚实记录——**Linux/macOS 支持草稿生成与模板模式，但不支持自动导出，生成的草稿仍需在 Windows 版剪映下导出**。core 是 Linux → 我们只产草稿，导出在用户 Windows 侧（pc01 若能修好正好是导出节点，见 AGENTS 第八节设备项）。
- **格式风险（非许可风险）**：剪映/CapCut 草稿是**逆向得来的私有格式**，新版 `draft_content.json` 常非明文（需 `fallback_loader`）。动作：把「草稿格式版本」纳入 W3-5 的 `promise`，版本升降级失败时报准入问题码（`jy-draftc` NOASSERTION，只抄「结构版本升降级」思路）。

### W4-3 canvas 只读时间线（第二步，中）

读同一份 EDL，提供「在剪映里继续精修」的下载入口。**不做拖拽编辑**（守 V4-4 决策）。

### W4-4 影调归一（成片层）

- **动机**：多镜头亮度/色温漂移是 c_hybrid 被否的直接原因之一（10-07 用户目检「亮度/实拍感不及拼接路线」）；10-08 也记「Peter 大衣色偶漂」。商业侧 TapNow 有画布级全局亮度/色温/主光/轮廓光调节。
- **动作**：拼接前插入「影调归一」工序（色彩匹配/直方图对齐/统一 LUT），落 `ffmpeg_ops.py`；先在漫剧成片链试点 A/B。

### W4-5 词锚定时间轴（译制/字幕/口型共用底座）

- **现状疑问**：whisper 四节点（`.86/.75/.81/.85:9310`）产出是否词级？若不是，Rule 8 说的「亚秒级间隙数据」与「编辑信号」都在丢失。动漫口型（`dub_anime.py:1-11`）自认是**音频能量驱动嘴区张合，非音素级**，且 `lbpcascade_animeface` 检测不稳则帧不动——词级对齐能直接改善它。
- **动作**：**(A)** 统一 ASR 产出为 `AlignedTranscriptEvidence`（**精确 16kHz 采样点坐标** + word/char/score/speech-activity，**缺失保持缺失，不推断为静音**），并按源缓存（重复转录是白烧 GPU）；**(B)** 实现 M:N 有界单调 DP 对齐器（六种组：`exact/split/merge/replacement/source-omission/evidence-insertion`），**纯确定性**：不调 LLM、不读音频、不推断说话人、**不保留多条候选路径**；缺失 token 段得到「介于已测邻居之间的连续加权窗口，而不是被发明出来的点时间戳」。
- **配套 Hard Rules**（video-use **MIT，12 条可直接移植**进音频/字幕链与 skill 规范）：主 SRT 用输出时间轴偏移 `output_time = word.start - segment_start + segment_offset`；绝不在词中间切；每个切点加 30–200ms 填充吸收 50–100ms 时间戳漂移；只用词级逐字 ASR，绝不用 SRT/短语模式，绝不归一化填充词。
- **一条架构原则值得单独抄**（hypit `region-evidence`）：**VLM 只产证据（帧级归一化 box 序列 + null），身份判定与放置发现留在确定性代码里** —— 这样 VLM 换版本或缺位（08-05 那次锁死 from-image AI 模式）不会污染下游逻辑。直接适用于 W1 的 qa_gate 改造。
- **许可红线（重要）**：hypit 是 **Apache-2.0 附加条件**——(a) **不得运营多租户环境或作为托管/SaaS 向第三方提供**；(b) 不得商业再分发；(c) 不得移除 CLI/run report/manifest 的名称与版权信息。**ToIV「仅本地自用/学习，不公开运营」属明确允许范围**；但 AGENTS §五 的 `STUDIO_MULTITENANT=1`（默认关，需密钥）**一旦对外开启即触发条件 (a)，届时禁引其代码**。`narrative-speech-alignment` 算法描述可作设计参考，实现建议自写（Python + DP，量级不大）。

---

## 9. W5 Agent 深化与产品收敛（功能条目级）

### W5-1 team.json 物理化 = pipeline YAML

- **现状**：虚拟剧组六角色（导演/编剧/分镜师/画师/剪辑配乐/质检）**写死在 `runner.py:67` 提示词第 20 条文本里**，无配置文件；`team.json` 全仓不存在（只在 3 份 PLAN 文档里被提及）。persona 持久化只有 `Agent` 表（`models.py:311-335`，Skill 市场技能卡语义），无「剧组成员」表。
- **动作**（抄 OpenMontage **AGPL 字段集**，实现自写）：`pipeline.yaml` 含 `stability / default_checkpoint_policy / orchestration{budget_default, max_revisions_per_stage, max_send_backs, max_wall_time_minutes} / extensions{custom_*} / required_skills / compatible_playbooks`，每 stage 带 `tools_available` 白名单 + `checkpoint_required` + `human_approval_default` + `review_focus` + `success_criteria` + `sub_stages[].condition`。
- **连带收益（很大）**：把 P-9「加工具同步四处断言（`BUILTIN_ORDER` / schemas / `LEGACY_SYSTEM` / `test_agent_gen_tools`）」变成**一份 YAML + 一个 loader**；封面 autorefire 的三个常量（深度闸 12/上限 3/批限 120）收进 `orchestration`；每角色的工具子集从提示词文本变成可校验的白名单。
- **注意**：另有两条真实多任务编排线不要混淆——**Agent Team（LangGraph）**：`agent_team_graph.py`（StateGraph + interrupt 合成门 + PostgresSaver）+ `agent_team_exec.py` + `routes/agent_team.py`（998 行），任务 kind 是**确定性枚举**（script/storyboard/image/video/audio/assemble，`models.py:791`），非 persona 分工；**subagent 原型**：`subagent.py`（LLM 拆 DAG + persona + 工具子集），已接 `routes/agent.py:514-527`（202）。team.json 应与这两条线的关系在设计时说清（建议：team.json 是**声明层**，Agent Team 是**执行层**，subagent 是**规划层**）。

### W5-2 user_prefs 长记忆

`user_prefs` 持久化（画风/画幅/节奏/禁忌/常用音色）+ system prompt 注入 + 显式「记住/忘记」工具（走 P-9 四处同步）。本地单人场景体感提升极大、成本低。注意与 auto-memory 类机制区分：这是**产品内的用户偏好**，不是 agent 会话记忆。

### W5-3 拉片分析（爆款拆解 → 分镜模板）

- **本地件全齐**：Qwen3-VL-8B(:9311) + whisper 四节点 + DSv4。
- **动作**：新 agent 工具 `analyze_reference_film`：抽帧 + VLM 描述景别/运镜/色调 + ASR 台词 + 镜头切分 → 输出**符合 W3-1 闭集的分镜模板** → 入私人模板库（不是公开市场，守「不做社区/UGC」拍板）。
- **配套**：机位模板库（景别+角度+运镜结构化预设注入 prompt）+ 分镜模板跨剧复用。商业侧对标 LibTV 一键拉片 / 小云雀 3D 导演台。

### W5-4 Skills 方法论封装层

- **缺口**：工具（58 个）与应用（6773 个）之间缺「编排 + 提示词方法论 + 验收标准」的打包复用单元。
- **动作**：定义私人 skill 格式（工具序列 + prompt 模板 + 质检项 + Hard Rules），支持 agent 把跑通的流程自动沉淀为 skill、一句话复用；对齐 `agentskills` 规范（Apache-2.0）+ `.well-known/agent-skills/` 发现形态；SKILL.md 写法抄 video-use（**MIT**）：「12 条 Hard Rules vs 艺术自由分层」+「`project.md` 逐次追加当记忆」+「**在把输出给用户看之前先自己验证**」。
- **落点**：`skill-packages`（canvas 数据目录）；桌面端已把 toiv-h3 插件包入 `Resources/plugin-packages`，可对齐同一规范。
- **顺带**：`PromptTemplate` 表（Jellyfish Apache）——`category`(22 类) + `variables[]` + `is_default` 同类别应用层唯一 + `is_system` 禁改；22 类目可直接对照（frame_head/tail/key_image + _prompt、video_prompt、storyboard_prompt、bgm、sfx、character/actor/prop/scene/costume_image_front+_other、combined）。ToIV 现在提示词散在各处。

### W5-5 对外 CLI + Agent 接入文档

官方 `toiv` CLI（登录/建项目/提剧本/查任务/取片）+「Agent 接入」文档页；让 Qoder/OpenClaw 类 Agent 一句话调用 ToIV 全链。基础：`toiv-comfy-mcp:9100` + FastAPI 全量端点 + 桌面 `agent-host`。对标纳逗Pro CLI / LibTV Agent Skill 双入口。**注意**：v3 §C6 曾把「四入口 CLI/API」判为最低优先级（自用价值小）——本轮商业调研发现它是「让外部 Agent 驱动 ToIV」的唯一通路，价值重估上调；若你认为仍不值，本条可永久搁置。

### W5-6 消息排队 + 结构化 reason_code

- runner 层加指令 FIFO 队列（执行中新消息入队而不是互相打断）；
- 拒绝路径统一带结构化 `reason_code`（依赖 W6-1 的 problem code）；
- **原始异常文本只落服务端日志、不进浏览器响应体**（可能带出连接串或内部拓扑）——这条同时是安全项。

### W5-7 经典 web 终局（12 视图迁移收尾）

- **已完成 9/14**（文档滞后，W0-5 回写）；剩 5 项**全部卡在两件事**：
  1. `entry.json` 探测跳转逻辑未迁（`apps/web/app/page.tsx:507` fetch `/studio/entry.json`，路由在 `apps/web/app/studio/entry.json/route.ts:1`）——**退役前必须迁到网关或 canvas 自身，否则失去 cutover 开关**；
  2. R18 经典流去向未拍板（A 保留只读壳 / B canvas 增 R18 模式 / C 退役）。
- **拍板后一次性退役**：image/video、library、market、`/drama/[id]` 播放器（含 analytics 埋点 `DramaSession:436`/`DramaEvent:454` 的迁移或归档）+ `settings` 拆分（主题/引擎状态只读→退役；R18 开关唯一入口→随决策安置）+ `avatartalk`（数字人唯一实现，canvas 无对应，R18 决策后定去留）。
- **顺带**：canvas `drama-workspace.tsx`（1058 行）页头仍自述「骨架·各段能力按批次迁入·数据与经典端同源只读」（`:556`）并保留「经典详情」回跳按钮（`:561`）——经典 web 退役后这两处必须清掉，否则用户点到死链。

### W5-8 桌面端

W4/W5 的 canvas 变更需要重跑 `apps/canvas/scripts/build-toiv-desktop.sh` + 无头冒烟 `--toiv-smoke=`（判据 ok=true：backend/agentHost/assistantWarm/loginPage）。**环境钉子**（AGENTS 已记）：wails CLI v2.16.0 在 `~/go/bin`；agent-host 打包需 **bun≥1.4**（全局 1.2.17 解不了 `bun.lock` lockfileVersion 2）+ `BEEFTV_NODE_RUNTIME`=Node 24.15.0；临时件 `/var/tmp/bun143`、`/var/tmp/node-v24.15.0-darwin-arm64`（tmp 三日清，重建按来源再拉）。**注意本机 bun 是 1.2.17**（W0-1 实测），桌面构建前需确认临时件是否还在。

---

## 10. W6 工程化与防事故（功能条目级）

### W6-1 准入裁决单一缝 + 闭集 Action 枚举

- **现状**：门禁散写三处——①封面 autorefire 深度闸（12+3+120）②VLM 四问质检 ③批量生成提交前校验；agent 工具回执靠**解析自然语言**，因此有 P-9「成功文案首 60 字禁 hint 词（失败/超时/不可用/仅 R18/过于频繁/未知工具/不存在）」这条纪律。
- **动作**（ArcReel **AGPL-3.0，严禁并码**；用 pydantic + StrEnum 自写）：
  1. **准入 vs 执行结果彻底分离**：准入核是纯决策——**不读文件系统、不读数据库、不读队列**；采集项目/TTS/供应商/队列状态是适配器的事；「这个决定是请求前门禁，**对执行结果不作任何断言**」；
  2. **三值裁决** `ADMITTED / CONFIRMATION_REQUIRED / BLOCKED`，其中**只有一个**阻塞码（档位与费用确认）可由用户同意清除（`confirmation_only` = 「唯一障碍是用户的同意」）；
  3. **携带全部理由而不是第一个**：`problems: tuple[...]`，为空 ⇔ 该单元可独立请求；每单元附 `request_duration_seconds / request_cost / projection`（已序列化的当前状态事实，调用方不必从 problem params 反推）；
  4. **全有或全无**：批次里一个不过整批报 `BATCH_ADMISSION_WITHHELD`，不半提交；顺序入队中断时已建任务是「完整、已准入、已付费」的单位继续跑，只有携带 `ENQUEUE_INTERRUPTED` 的目标仍需排队，一次「missing-only sweep」正好捡起那些；
  5. **闭集动作枚举** `GenerationAction`：`RETRY / FIX_INPUT / GENERATE_DEPENDENCY / WAIT_FOR_TASK / REPLAN_UNIT / CONFIRM_REQUEST_DURATION / CONFIGURE_PROVIDER / REPAIR_ARTIFACT_STATE / RETRY_ARTIFACT_DOWNLOAD / RETRY_PROJECT_MIGRATION / NONE`，消费方**无需读散文即可派发**；
  6. **覆盖率测试当漂移守卫**：每个已注册失败码都必须映射到一个 action；未注册的码会静默降级为 `RETRY`——「而对一个被拒绝的请求来说，RETRY 意味着为同一个拒绝再付一次钱」；
  7. **本地化只在边缘加句子**：code/action/tier/cost 保持共享缝产出原样，「Web 与 Agent 永远不会对『发生了什么』产生分歧——只会对『用哪种语言读』产生分歧」。
- **两条直接兑现既有纪律**：
  - `RETRY_ARTIFACT_DOWNLOAD` = 把 **H-4**「DB 标 error ≠ 生成失败；批量失败先查 ComfyUI `/history/{pid}`，产物在就回写，禁止盲目重提」从人工纪律变成代码枚举；
  - `DEPENDENCY_FAILED`（同批成员未成功 → 本单元**从未提交给供应商、nothing was billed**，`params.dependency` 点名那个成员）用于分镜依赖链（关键帧→视频→拼接）。
- **可删的债**：problem code 落地后，**P-9「成功文案首 60 字禁 hint 词」整条纪律可删**（它存在的唯一原因是消费方在解析自然语言）。

### W6-2 model catalog 三层体系

- **现状**：模型信息散在 **≥6 处**——`TOIV_LLM_PROXY_MODELS` 白名单（core env）· served-model-name 别名（spark02 vLLM：`deepseek-v4-flash-dspark` + `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`）· `model_registry_draft.json`（`5a8fa423`，**挂账至今未落地**）· `docs/MODEL_SOURCES.md/.json`（ok479/blocked336/total816）+ core 快照 `apps/api/app/data/model_sources.json` · admin「模型资产」四 tab（`GET /api/admin/model-sources`、`/api/admin/knowledge-graph`）· `deps.resolve_worker()` + 工作站 `/opt/comfyui-lb/backends.json`。
- **症状与 lumenx 改造前逐字相同**：「你不知道自己是不是已经把所有地方都改全了」。已发生事故：10-10 MODEL_SOURCES backfill `SenseVoiceSmall`——**审计/TEST_LOG 曾记 ok479 但实际从未提交**（`git log -S SenseVoice` 全史为零）。
- **动作**（lumenx **MIT，可并码**，保留 LICENSE）：把 `model_registry_draft.json` 按三层做实——**文档证据层**（厂商文档归档）→ **可执行清单层** `catalog/families/{h3,wan,longcat,comfy-lb,llm-dsv4,tts-indextts,asr-whisper,embedding-qwen3,vlm-qwen3vl}.yaml` + `schema/model-catalog.schema.json` → **消费层** `generated/`（喂 admin 四 tab、喂 `deps.resolve_worker()`、喂 `TOIV_LLM_PROXY_MODELS` 默认值）+ `build_model_catalog.py` / `validate_model_catalog.py`（validate 检查 artifact 一致性 / 默认值可见性 / **文档链路** = MODEL_SOURCES 与 core 快照 md5 是否一致）。
- **核心判断（照抄其口径）**：「**不是所有模型变更都需要改运行时代码**」——新增 model ID / 改默认模型 / 调 UI 可见性 / 更新支持参数与文档链路，都只改 catalog；但**新认证方式 / 新 endpoint / 新媒体输入方式 / 新请求或响应字段 / 新 provider family** 必须改 adapter。
- **「模式 B」口径**：docs 快照与 core `app/data/` 双份的现实（AGENTS §四已记「后续若本地改 docs 快照仍需同步重拷」）→ 从口头纪律变成 PR 模板里的一行注明「外部待补同步，不影响代码开发和验证，但不代表所有文档仓库都已同步完成」。

### W6-3 contract 自检与版本化（E-3 的通用化实现）

- **动机**：E-3「引擎探测通过 ≠ 链路可跑，新引擎必须真机 e2e 后交付」现在靠人工纪律 + 六轮实弹排查（10-11 FL2VA 烟测）。D-2「一次性手工迁移没有守护会静默失效」的教科书案例就在手上：**10-11 打的三个 RH resolve 泄名补丁（`components/_impl.py`×2 + `api/_shared.py`）不在仓库、是工作站侧文件**。
- **动作**：给每个专用链路加一份 `*_contract.py`，在首次真跑之前**证明依赖的语义性质仍成立**；不成立就**拒跑并说出什么东西移动了**（「一个大声的失败胜过一个你没注意到的坏渲染」）：
  - **RH 节点 contract**：断言工作站侧三处 resolve 不泄名（把不在仓库的补丁纳入守护）；
  - **H3 layout contract**：断言 `FRAME_RESCALE` 与关键帧定位算式仍允许 `fractional`/`negative`（上游自己的节点在到达 layout 前就把 `frame_idx` 校验为非负整数，所以**上游没有任何测试覆盖这两个属性**，日后加一个 int cast 不会自己大声失败，只会悄悄移动被钉住的音频）；
  - **workflow template contract**：模板版本纳入作业复用判定，模板变了则已缓存/已提交作业不可复用；
  - **版本探测读代码而不是读版本号**（「那是从 layout 代码本身读出来的，所以 nightly 或 fork 也能得到正确答案」）。
- **配套**：把「预期失败」与「未验证项」显式写进 `TEST_LOG.md`（现有 38 skip 的原因应逐条可查）；验证证据分文件落盘（`MANIFEST.sha256` / `PACKAGE_VALIDATION.txt` / `PROJECT_STATE.md` / `WORKLOG.md`）。
- **许可**：Motion-Context **GPL-3.0，只抄政策**；H3-Continuum **MIT，可并码**（`compatibility.py`/`hardening.py` 模式可直接参考）；dramaclaw **ELv2，只抄思路**。

### W6-4 `node_mapping` 从节点 ID 改为 class_type 绑定

- **现状**：`PLATFORM_V2_CONTRACT.md` §3 `"prompt": "186", "first_image": "52", "seed": "80"` —— **绑节点 ID**，工作流被重新布局/增删节点后映射错位且**不报错**。
- **改为**：`{semantic: {class_type, field, state, node_id_hint?}}`，`node_id_hint` 只作加速缓存、以 `class_type` 复核；找不到就抛「模板缺少节点 `<class_type>`，无法设置 `<field>`」，**绝不静默跳过**；**推断只是候选，保存才算绑定**；未绑定 = 平台不驱动该维度、对应值以 workflow 字面值为准；**提示词与产物两项必有**。
- **用户工作流优先（铁律）**：构建前必须先扫描用户已有工作流并让用户确认选择，**禁止自行创建新工作流**；每个候选标注格式（API/UI）、模式（ref2va/i2v/t2v/batch）、**参考图槽位数**、Turbo 标记、模型文件与输出前缀；`workflow_map` 键可以是模式名（整批统一）或段号字符串（按段指定），`segments[].template` 优先级最高；**UI 格式必须先显式转换，构建脚本遇到 UI 格式报错提示，不会自动改写用户文件**（与 `save-from-comfy` 的指纹闸 409 同口径，可合并）。
- **存量回填**：6773 应用市场的模板需回填 `class_type`，可写脚本从现有 `node_mapping` 反查。
- **直接对应三起既有事故/纪律**：E-1（新专用实例必须补 `deps.resolve_worker()` 精确匹配，否则作业成功但产物 502 = 「产物绑定缺失」）、10-11 三处泄名补丁（本质是绑定层改写了名字）、`save-from-comfy` 指纹闸。
- **顺带**（AIMixer Apache）：`cache_name` 命名卫生——`output/<cache>/<名字>_<节点id>/`，自动过滤 `/ \ : * ? " < > |` 与 Windows 保留名（CON/NUL…），最长 64 字符；同名不同节点 id 分开；复制工作流后节点 id 通常不变、名字也相同就会继续共用一个目录。落在 P-4「/tmp 是 tmpfs」与 W-2「SYSTEM 任务看不到用户盘符」旁边。
- **许可**：TFboy1 **MIT，可并码**（`build_workflows.py` 的 `set_widget` 模式可移植）；ArcReel **AGPL，只抄三态语义**。

### W6-5 DESIGN.md 作为 token 真源契约

把 P-2b 三约束（appsRh 懒惰正则顺序 / engineStudio 零 hex / mocks 替身）从**防御性检查**升级为**声明性契约**：`DESIGN.md` YAML front matter 逐值对齐 `index.css`，暗色为准、亮色用 `light-*` 前缀并行，分段注释标明每组的 CSS 来源块；检查可由 DESIGN.md 生成。来源：dramaclaw（ELv2，抄形态）+ `google-labs-code/design.md`（语料 A 批）。

### W6-6 市场三表拆分 + 术语典

- **三表**（ArcReel AGPL 抄形态）：source / installation / submission 分离——同时物理化 AGENTS §四两个口径：「盘上有 ≠ 产品在用」、「来源清单 ok479/blocked336 不是盘上文件总数」。
- **术语典 + `_Avoid_` 反同义词表**：防 H3 FL2VA 命名事故复发；词条至少覆盖引擎/实例/工作流/模板/端点/节点绑定/权重身份/别名/合规名/NAS 名。

---

## 11. W7 机会窗（**均需用户拍板才开，默认不做**）

### W7-1 H3 原生音画一体 A/B

- **商业侧**：音画一体直出（Seedance 2.0/2.5、Vidu Q3、Kling 2.6+、海螺 H3）已是 2026 旗舰标配，「后期配音对齐」路线正被替代。**我们手里就有 H3 却没吃透。**
- **但我们踩过坑（不可忽略）**：10-08 实锤——v2 直接用 H3 原生音频，whisper 转写出「我看她一下母下妆微笑…」，**H3 音频联合生成不可控，prompt 不写对白也会呓语人声**（爱情片场景先验）；当时定位的三条平台设计缺陷之一是「**正式管线音频必须走平台编排**」，且「H3 prompt 写『音频：…』仅是生成先验提示，**不构成人声开关**」。
- **所以做成 A/B，不换默认**：对白驱动镜头走 H3 音画一体（口型天然对齐，可砍掉整段 TTS 对轴工序）vs 现有「H3 画面 + IndexTTS 配音」；**验收必须用 whisper 转写回归**（10-08 v3 的有效方法论：「六段旁白完整转写还原、零呓语」）+ 逐字正确率量化，不以目检定论。译制/改词场景仍走后配音。
- **附带**：情感配音已全链透传（`routes/voice.py:141-143`、`routes/dub_voice.py:104-106`、`agent/tools_tools.py:317`），A/B 时 IndexTTS 侧可用 `emo_text/emo_alpha` 拉满做对照。

### W7-2 多镜头连续生成翻案 A/B

- **10-07 拍板有效**：用户目检四镜拼片后结论「作为长视频效果一般，短视频生成+首尾帧拼接效果更好」→ c_hybrid 不换默认。**本条不改这个默认。**
- **但否决依据的实现有正解**（开源侧本轮最大发现之一）：当时失败建立在**像素往返 + 音频当 reference** 两点上——
  1. **画面走 latent 不走像素**：把上一段尾部**直接从它的 latent 里切出来**，被钉住的帧逐 bit 相同（像素往返每接缝付一次解码+缩放+重编码，正是长链色偏与发软的来源）；
  2. **音频窗口反向覆盖**：被钉住的音频窗口必须**在接缝处结束**并向已播放的声音**回溯**；仍搭 reference 机制，但**时间坐标被改写到新段自己的时间轴上**。差别是「模型在续接你的音轨」vs「模型写了一段听起来像它的东西」（**互相关 0.45 → 0.95+，偏移不随链累积**）；
  3. **三个常量**：`context_length = 22`（5/22/39/56 里选，56 每次浪费 2.3s）· `audio_context_length = 24`（**3 的倍数才落在 40Hz 音频栅格**，一帧 = 5/3 音频步）· `match_tail` 常开（H3 音频栅格向上取整，每段多约 8ms，逐接缝累积）；
  4. **Trim**：被钉住的头部回到新段开头，concat 前必须裁掉；`head` 模式下成片比采样短 `context_length` 帧（22 帧 = **0.92s**），**提示词时间码要按采样版本算**；
  5. **跨 run 传递**：`SaveLatent`/`LoadLatent` 带 `clip_index`，文件命名 `clip_00002.safetensors` = 第 2 段；自动保存的带尾下划线，索引加载刻意跳过；**禁止用 queue「run on change」走链**（每次索引变化是独立图编辑，会排两次队并跳槽）；
  6. **四条提示词规则**：模型把矛盾渲染成**并集**（不是替换）· **气闸**（第 N+1 段开场保持第 N 段收尾构图、无对白、约两秒，再切新设置）· **给保持一点事做**（一次呼吸/重心转移/视线变化，否则渲染成冻结）· **把被钉住的头部算进时间码**。
- **验收标准必须是数值**：`seam_probe`（互相关量化接缝是「真续接」还是「模仿」）+ `freeze_detect`（找「保持」段里的字面冻结）+ `level_step`（逐段采样率不一致标记），**而不是目检**。这是 10-07 那次拍板方法论的升级：目检结论仍有效，但翻案需要可复现证据。
- **许可**：Motion-Context **GPL-3.0，严禁并码**（只抄原理与常量）；`AIMixer/ComfyUI_MiniMaxH3_Director`（**Apache-2.0**，2.3K★）与 `tritant/ComfyUI_MiniMax_H3_Extender`（**Apache-2.0**）可并码；`H3-Continuum`（MIT）可并码；`TimelineDirector`/`ALLinONE`/`Guide`/`Spectrum` 均 GPL-3.0 只读；`TE_MAN` 自定义「仅供学习和阅读」只读；`MiniMax-AI/MiniMax-H3` 官方仓与两份 awesome 索引**仓内无 LICENSE → 视为未澄清，只读**。
- **前置条件**：工作站侧 ComfyUI ≥ 0.34.0（H3 任意关键帧锚点）；必须先跑 W6-3 的 contract 自检；六 `task_type` → UNET 映射铁律（`t2v/i2v/fl2v → fl2va`，`r2v/v2v/rv2v → ref2va`，CLIP Loader type 必须 `minimax`/Qwen3-VL）与 ToIV 的 `minimax-h3-r2v`/`minimax-h3-pipeline-c` 拆分（`f454bf12`）逐条核对，并把 UNET 身份纳入 `deps.resolve_worker()` 精确匹配（E-1）。

### W7-3 盲评量表（让拍板可复现）

zenstory `evaluations/`（**MIT**）：8 维加权 100 分 + 五档锚点 + 盲评纪律 + `OVERFIT_FLAGS` 五项 + `MIN_CASES=12`/`MIN_GENRES=10` + development-holdout 双 split + sha256 证据绑定；明确「**不评文件数量、Schema 完整度、提示词或工作流便利性**」。把「用户目检四镜拼片对比」这类拍板升级为可复现证据；也可用于 12 视图迁移前后的体验对照。**W7-1/W7-2 的验收都该用它。**

---

## 12. W8 RunningHub 全量本地可部署化（**2026-10-13 用户新增指令，推翻原「RH 市场扩容」不做项**）

> **用户原话**：「去 RunningHub 的**所有能够本地部署的应用**都拉取下来放到我们的项目中使用」。
> 这条**显式推翻**了 v3 §6 / v4 §4 / 本计划 §15 继承的「RH 市场扩容」不做项，也构成了 `rh_market_reset.py` docstring 所要求的「bulk-public / 现网 reseed **须用户另令**」中那个「另令」。
> **执行原则**：先只读盘点 → dry-run 批次计划 → 分批执行 + 每批实弹验收。不一次性 reseed（6773 条量级 + GPU 时长约束 + 封面闸约束）。

### W8-0 已实测的通路事实（2026-10-13）

| 项 | 实测结果 |
|---|---|
| `https://www.runninghub.cn/` | **直连 200 / 0.54s**（本机 Mac 无需代理） |
| `https://civitai.com/` | 超时不通（DNS 污染，与既有记录一致） |
| `https://civitai.red/` | **直连 200 / 1.25s**（用户所指域，可达） |
| core SSH | `merlin@192.168.71.47` BatchMode 可用；`toiv-api`/`toiv-web` 均 active |

### W8-1 只读盘点（进行中，本轮已派工）

产出 `tmp/research-rh-local-20261013/REPORT.md`。要回答的四组问题：

- **A 现状真相**（PG 实测，不信文档）：`App` 表实际行数与 schema、`is_public` × smoke 状态交叉分布、「rh-acc」如何标识、RH 来源应用实际条数、当前公开可用条数（AGENTS 记 83，需核实）、与 6773 的差额去向、`app_test_matrix/` 与 DB smoke 字段是否一致。
- **B RH 目录获取通路**（**关键未知**）：当初 6773 条怎么进来的（导入脚本/端点/一次性 dump？`rh_family_presets.json` 20745 行的来源）；RH 是否有可用 API 列出**当前全量**、是否需认证；`docs/ops/rh_basename_nas_audit_20261010.md` 记的 deferred 原因「无精确 basename」是否仍成立。
- **C 本地可部署性四分类**（核心交付）：①已验证可跑（smoke pass）②可修复（归因是模型名/节点类名漂移，即 `_combo_repair` 那类，或只缺一个可下载权重）③缺模型（NAS 两棵树没有；给出缺哪些、能否 hf-mirror 下载、体积）④缺节点/缺引擎（需未装自定义节点，或依赖 RH 云端专有节点/云端模型 API 无法本地化）。
- **D 执行计划**：分批方案与顺序（建议先②可修复类，ROI 最高）、每批验收判据、GPU 时长预估、与封面 autorefire 深度闸（12+3+120，`sum_queue_depth(force=)`）的错峰关系、上架动作确切调用形状（`POST /api/admin/apps/bulk-public` 请求体 + `rh_market_reset` 计划如何喂入 + 说明卡/封面/use_case 打标是否同批补）、风险与回滚（soft-hide 可逆性、误上架回滚动作）。

### W8-2 既有机器（不要重造）

| 能力 | 落点 | 用途 |
|---|---|---|
| 应用烟测 + 自愈归因 | `app/services/app_smoke.py`（`classify_failure` / `run_app_smoke` / `_combo_repair`：拉目标实例 `object_info`，把不在列的模型文件名/节点类名改写到最接近的在列变体后重提一次） | **这就是「本地可部署性」的裁判**：能真跑通 = 可部署 |
| soft-hide 计划器 | `app/services/rh_market_reset.py`（dry-run 优先、只 soft-hide 不硬删、`KEEP_WHITELIST` 保 intent 本地 alt/核心引擎/longcat/avatar、「未测 ≠ 挂」） | 批量上下架的计划产出 |
| RH 溯源 | `app/services/provenance.py`（`extract_rh_webapp_id` / `rh_webapp_url`） | 每条应用的 RH 来源可回溯 |
| 预设族种子 | `rh_family_preset_seed.py` / `rh_h3_preset_seed.py` + `app/data/rh_family_presets.json` / `rh_h3_presets.json` | 既有 RH 族预设 |
| admin 批量面 | `POST /api/admin/apps/bulk-public`、`GET /api/admin/closeout-summary`、`GET /api/admin/test-matrix`、`GET /api/admin/model-sources`；说明书批量面板（550 全量 + 单飞批量生成 + 发布 + 回填） | 上架/说明卡/封面 |
| 模型来源账 | `docs/MODEL_SOURCES.md/.json` + core 快照 `app/data/model_sources.json`（ok479/blocked336/total816） | ③缺模型类的判定依据与下载清单 |

### W8-3 执行阶段（W8-1 报告回来后细化，此处先定纪律）

1. **顺序**：②可修复类 → ③缺模型但可下载类（先补权重到 NAS 再 smoke）→ ①已 pass 但未公开的 → ④明确不可本地化的**登记为「云端专属」并不上架**（诚实标注，不伪装可用）。
2. **每批规模**受两个闸约束：封面 autorefire 深度闸（queue_depth > 12 即 gated）与 GPU 实际空闲窗；沿用「空闲窗口补刀」的既有做法，不与用户创作任务抢队列。
3. **H-4 纪律**：批量失败先查 ComfyUI `/history/{pid}`，产物在就回写，**禁止盲目重提**。
4. **E-1 纪律**：若某类应用需要新专用实例，必须同步补 `deps.resolve_worker()` 精确匹配，否则作业成功但产物 502。
5. **验收**：每批给出 smoke pass 数 / 新公开数 / 说明卡与封面补齐数 / 缺件清单增量；实弹抽 3 条真跑真出图。
6. **回滚**：只 soft-hide 不硬删（既有纪律），误上架回滚 = 反向 bulk-public。

### W8-4 执行记录（2026-10-13）

**批 0 已执行完毕并 PG 实证**（`tmp/research-rh-local-20261013/w8_batch0_revive.py`，日志 `batch0_revive_log.jsonl`）：

| 项 | 结果 |
|---|---|
| 动作 | 复活「已 `smoke=pass` 但被隐藏」的 RH 应用，`POST /api/admin/apps/bulk-public` 分 9 片（每片 ≤200，端点上限 `app_smoke_admin.py:245`） |
| 规模 | 目标 1727 条（CSV 1756 条 − **主动排除 29 条 `is_nsfw=t`**，留给 W9 的 R18 线，守 R18=A 物理隔离）；`done=1727 / missing=0` |
| PG 实证 | `is_public` **83 → 1810**（=83+1727，分毫不差）；近 30 分钟 `app.bulk_public` 审计 **1727 行**（逐条留痕） |
| 完整性 | 1810 条公开中：`is_nsfw` **1**（既有那张，排除生效）· `smoke_status=pass` **1809**（唯一例外=`longcat-continue`，`rh_market_reset` pass1「未测≠挂」保留卡）· `workflow_json` 缺失 **0** · 无 `cover_url` **2** · 无 `use_case` **1**；`output_kind` = image 1090 / video 719 / audio 1 |
| 可逆性 | 仅改 `is_public`，未删行、未动 `workflow_json`/`smoke_*`/`cover_url`；回滚 = 反向 `bulk-public {"is_public": false}` |
| 判定口径 | 45 条 `scan_block_kind` 非空（models_only 21 / both 15 / nodes_only 8 / unlocalizable 1）但 `smoke=pass` —— **静态扫描与实际真跑冲突时以真跑为准**（且已证 `RHHiddenNodes` 扫描有误判，见 W8-1 §C） |

**验证指标的一个坑（记下来防再犯）**：`GET /api/apps` 的 `X-Total-Count` 在 **admin 视角不受 `is_public` 过滤**（实测上架前后恒为 6731），**不能**用来验证上架效果；必须走 PG `count(*) FILTER (WHERE is_public)`。这也顺带说明 AGENTS 里「6773 总/5061 公开」这类数字的口径需要注明是 admin 还是 user 视角。

**批 A 进行中**：`w8_batchA_enumerate.py` 枚举 RH 全量目录（`POST /api/webapp/list`，`current`+`size=500`+`search`，约 142 页 / total≈70507），含**分页陷阱自检**（第 1/2 页 id 必须零重叠，否则说明分页参数被静默忽略、立即中止）——这正是 2026-09 只能靠 14+8 个关键词凑到 8747 条的根因。产物 `rh_catalog_full.jsonl`，**纯只读、不写 ToIV 库**。

**下一步（按 W8-3 顺序）**：批 3 重扫（零 GPU，约 82s；修 `RHHiddenNodes` 误判 + 纳入 `:8264`/`:8197`/`:8199`，可解锁 231 条误判并给批 5/6 准确缺口清单）→ 批 1（②a image 子集 200 条 smoke，约 18.3 GPU·h，先导 50 条 pass 率 ≥60% 才继续）→ 说明卡批量生成（走 LLM @spark02，不占 ComfyUI 队列，可与 smoke 并行）→ 全量目录的静态可部署性分类与导入。
**执行期纪律**：保持 `TOIV_COVER_AUTOREFIRE=false`（现为 false、`gated=false`、`queue_depth=0`，不构成约束，但批量 smoke 自己会顶高 depth）；`POST /api/admin/apps/smoke/batch` **打不到隐藏卡**（`_pick_batch` 过滤 `is_public==True`），必须逐条走 `POST /api/admin/apps/{id}/smoke`。

---



### W8-5 批 E 实弹结论与三次判断反转（2026-10-13，必须留档）

**批 E 已实现并部署，实弹 PASS**：`rh-acc-0001608704-ef70d6`（Z-Image+seedvr2.5.1 直生 4K）此前判「缺节点 Text」，部署后 `POST /api/admin/apps/{id}/smoke` → **status=pass，真跑 159s，outputs=['11','16']**。

实现分两处（第一版不完整，被实弹与既有测试各打回一次）：
1. `_normalize_primitive_literal_nodes`（`routes/apps.py`）：构图阶段内联/重指；
2. `resolve_required_nodes`（同文件，`app_smoke.py` 共用）：**worker 选择读的是库内 `App.required_nodes` 快照**（`routes/apps.py:4346`、`app_smoke.py:415` 两处同模式），快照仍含已被内联摘除的 `Text` → 归一部署后 smoke 仍报「缺节点 Text」。抽出共享 helper 两处统一。
   - 第一版用「快照 ∩ 图」泛化交集，被既有 `test_apps_run.py::test_run_explicit_required_nodes_used` 打回——那条守的是**有意逃生门**（应用可声明图里没有的节点：运行时包装节点/钉专用 worker）。收窄为「只剔除本会被归一内联掉的字面量原语」，逃生门保住；原语若因「binding 落点 + 多消费方」被保留在图里，也照样保留（它确实还要 worker 执行）。

**反转一：`UNLOCALIZABLE_NODES` 清零是错的，但一刀切恢复也是错的。**
- 批 3 重扫把 `unlocalizable` 从 283 清到 0，理由是「三台 worker 的 `object_info` 都装了 `RHHiddenNodes` shim」。**实弹推翻**：shim 签名是 `image_1`(IMAGE,required) + `image_2/3/4/pwd`(optional) → 输出 IMAGE（一个手写图像多路器），而 RH 原图里该节点入参是 **`images_1`（复数）/ `num_frames_2`**，甚至有只给 `pwd` 的（实证 `rh-acc-8847936513-e3edd5` 节点 294/295/296）→ smoke 报 `RHHiddenNodes: Required input is missing image_1`（validation）。清零导致 **78/283 条被误判 ok**（其中 `is_public=true` 为 **0**，未污染市场）。
- 但**一刀切排除同样错**：PG 实测生产 424 个用 `RHHiddenNodes` 的应用里，**有 6 个 `is_public=true` 且 `smoke_status=pass`** —— 它不是普遍致命，只在图用 `images_1`/`num_frames_2` 这类入参时炸。
- **最终口径**：静态扫描只做**风险标注**（新增 `KNOWN_RISKY_NODES` + 输出字段 `risk_nodes`，不参与 `ok|blocked` 判定），**可跑与否的裁判是 smoke 真跑**（仓库既有纪律「盘上有 ≠ 产品在用」）。需要硬排除时用 `TOIV_UNLOCALIZABLE_NODES` 显式声明。

**反转二：重扫「解锁 231 条」不成立。** 新旧迁移矩阵 **零翻转**（`blocked→blocked 3351`、`ok→ok 3380`）。原因：`:8196` 挂两棵 NAS 树、节点集最广（4940 nodes / 972 models），专用实例 `:8264`(4380/84)、`:8197`(4667/790)、`:8199`(893/84) 更窄，不可能满足 `:8196` 满足不了的。扩池的真实价值只是让 `block_kind` 分类更准。附带核实扩池**没有**实质污染 ok 判定：全量 ok 记录中「通用池可跑」**4272** vs「仅专用实例」**32**（0.74%）。

**反转三：模型侧第一版结论作废。** 第一版报「hf_only 39」是假的——hf-mirror 间歇 `SSL: UNEXPECTED_EOF_WHILE_READING` 被 `except` 吞成 `not_found`；且「仓库 id」与「文件名」两类缺件混判（`TencentGameMate/chinese-wav2vec2-base` 是 repo id 不是文件，实测该仓 6 个文件含 `pytorch_model.bin`）、HF 重传改名使精确 basename 全灭（递归核树后仍 0/12 命中）。修正后 Top150 真实分布：**civitai 命中 6 / not_found 105 / unresolved_transport 39（待重试）**；旧输出留档 `model_resolution_v1_flawed.jsonl`。**结论：「缺模型」这个桶远比预期难恢复**（RH 图里多是社区私有上传或改名件），不该按乐观口径排期。

**先导批的一个方法错误（已修）**：第一次 smoke 先导批用 `--kind image --status untested` 筛选，把**库里既有的未测老应用**也捞了进来（`满血版图片编辑-6d4088`、`Flux-文生图-96c82d` 等 `wid=None`），7 条里 1 pass/6 fail —— 那**不是**对 1717 条新导入的判决。改为 `--ids-file` 严格限定新导入 id。附带发现：老应用未测池 pass 率仅 ~14%，印证「4258 条未测」多半是**因为跑不通才一直没测**。

**自愈链缺陷（本轮发现并修）**：`rh-acc-0052555778-19dac9` smoke 报 `422: 绑定 text_text 指向不存在的节点 144`、`cls=app_data`。真因是 **LLM 修补后的图删掉了 Text 节点 144，而试跑仍用库内 `app.bindings`**（`app_smoke.py:501` `workflow_override=patched_raw` + `app.bindings`）→ `_write_leaf` 422，且这条 422 **把首跑的真实失败原因盖掉**、归因成 `app_data` 误导处置。修法：新增 `_missing_binding_targets()`，补丁若删掉绑定目标节点则**拒绝该补丁并保留原错误**，`record_proposal` 记 `rejected_drops_binding_targets`。5 例新测 + 既有 app_smoke 27 例 = 32 passed。

---

## 13. W9 Civitai.red R18 参照线（**2026-10-13 用户新增指令**）

> **用户原话**：「Civitai.red 上面有关 R18 的内容都可以学习参考上面的进行」。
> 与既有拍板的关系：R18 经典流维持 **A（保留经典 web 只读壳）**；`X-NSFW` 机制 + AgeGate + R18 引擎集（如 `h3-nsfw-fl2v`）是仓库既有事实；「内容限制管控已下线（未成年硬阻断 + X-NSFW 语义保留）」是 AGENTS §五 记录的现网口径。本波**不改 R18 的 A/B/C 决策**，只做资产与工作流层面的参照补强。

### W9-0 工作层面与红线（写死，避免越界）

- **只做技术元数据层**：模型/LoRA/工作流的名称、类型、基础模型家族（SD1.5/SDXL/Flux/Pony/Illustrious/Wan/Hunyuan…）、体积、下载可得性、触发词、推荐参数、依赖节点、许可与署名要求、是否需登录/付费。
- **不抓取、不转述、不生成露骨内容本身**；不下载权重（本轮不需要）；不注册账号；不绕过任何登录墙/付费墙（遇阻记录「需登录，未获取」）。
- **涉未成年内容一律不碰、不记录、不检索——硬红线，无例外**（与 AGENTS「未成年硬阻断」口径一致）。

### W9-1 调研问题（进行中，本轮已派工）

产出 `tmp/research-civitai-20261013/REPORT.md`：

- **A civitai.red 是什么**：civitai.com 的镜像/反代还是独立站；数据是否同源；有无站点自述与稳定性说明；**有无可用 API**（civitai 官方 REST v1 `/api/v1/models`、`/api/v1/model-versions/{id}` 等，镜像是否透传）；无 token 时的可见范围与限流；NSFW 过滤的控制机制（**只记录机制，不用来批量拉露骨内容**）；该把它当「可依赖数据源」还是「一次性参照」。
- **B 与 ToIV 栈交叉**（重点，不做泛泛榜单）：我们 R18 线**实际依赖哪些模型/引擎**（从 `engine_registry.py` / `workflows/community_recipes.py` / `rh_*_presets.json` 读出，挂 `文件:行号`）；civitai.red 上**兼容且可本地部署**的资产按 checkpoint/LoRA/LyCORIS/VAE/Embedding/ControlNet/工作流 JSON 分类的数量级与代表条目；**缺口对照**——MODEL_SOURCES 里 `blocked` 的 336 条有多少能在 civitai.red 找到可得来源、有多少是 civitai 独有（hf-mirror 没有）；工作流 JSON 能否直接进我们应用市场、需要哪些改造（节点依赖 + 模型名改写，复用 `_combo_repair`）。
- **C 落地建议**：按 ROI 排序的可执行动作清单（含前置：token？工作站磁盘？节点安装？）；许可与合规（CC/自定义/禁商用/需署名/禁再分发 对「本地自用不公开运营」意味着什么，哪些即使本地自用也有风险）；若要**长期化**该怎么设计（`civitai_catalog` 只读快照 + 定期增量 + 与 MODEL_SOURCES 对账）及其成本收益。

### W9-2 与 W8 的协同

两波共用同一套判定机器与同一本账：
- **可下载性**统一走 AGENTS §四 口径：主路 = workstation 直连 `hf-mirror.com` + `aria2c -x16`；civitai 直链为备选（需核工作站侧可达性与限速）。
- **入账**统一进 `docs/MODEL_SOURCES.md/.json`（勿在仓库根新增 MODEL_SOURCES*），并同步 core 快照 `apps/api/app/data/model_sources.json`（AGENTS 已记「后续若本地改 docs 快照仍需同步重拷」，W6-2 的 catalog `validate` 会把这条从口头纪律变成机器校验）。
- **可部署性**统一由 `app_smoke.py` 真跑裁判，不以「盘上有」为准（AGENTS §四：「盘上有 ≠ 产品在用」）。
- R18 资产落位需与 R18=A 决策一致：**只进经典 web 的 R18 引擎集/市场面，不进 `/studio`（canvas 全程无 R18 代码，纯 SFW）**——这是 `CLASSIC_WEB_RETIREMENT_PLAN_20261011.md` 已确立的物理隔离，W5-7 经典 web 退役时必须保住这条边界。

---

### W8-6 批D-3 RH 云节点 shim：按实证签名重写（`23216a69`，已提交未部署）

**为什么重写**：09-15 版 `deploy/comfy-extensions/toiv_rh_shims` 只有 `RHHiddenNodes` 一个类，且把 `image_1` 声明为 required。对生产库 **8142 张 rh-acc 图**做 jsonb 聚合后实测：真实图从不传 `image_1`，传的是 `images_1`/`face_images_5`/`var_4_4`/`string_1_1`/`clip_0` 一类**随图而变**的名字（全为连线）。后果有两层：①smoke 一律报 `Required input is missing image_1`；②更糟的是它让 `object_info` 里出现 `RHHiddenNodes`，能力扫描据此把 **78/283** 个应用误判为 `ok`（0 条 public）。

**新增六类**（签名=输入键出现次数与 jsonb 类型 + 「输出槽 0 被哪些下游节点的哪个字段消费」双证据定 RETURN_TYPES）：

| 类名 | 实证图数 | 本地后端 |
|---|---|---|
| `RH_Captioner` | 195 | Qwen3-VL（served id `toiv-vlm`，:9311） |
| `RH_Translator` | 119 | DSv4（`deepseek-v4-flash-dspark`@spark02:8000） |
| `RunningHub Deepcleaner` | 92 | DSv4 |
| `RH_LLMAPI_Pro_Node` | 49 | 有图走 VLM、无图走 DSv4 |
| `RH_Prompter` | 31 | DSv4 |
| `RH_GetAudioDuration` | 9 | 纯本地 `frames/sample_rate` |

`RH_Captioner` 输出槽 0 全部流向 `CLIPTextEncode.text`/`ShowText.text`/`Text Concatenate.text_b` → 确定为单 STRING 输出，不是猜的。RH 图里的 `model` 字段是 RH 云端模型名（gpt-4o 一类），本地没有 → 一律改写成 served id，**换后端不换图**就是 shim 的核心语义。

**`RHHiddenNodes` 判定为不可通用 shim**：输入名随图而变已如上；输出槽 0 在不同图里分别喂给 **INT**（`easy mathInt.a`，52 次）、STRING、IMAGE——静态 `INPUT_TYPES` 与 `RETURN_TYPES` 无法同时满足。改为全输入 optional（至少让「只有 pwd」那类图过校验）+ 运行时抛明确错误「此应用不可本地部署，请勿上架」，**不再用假签名骗过能力扫描**；可部署性仍由 `KNOWN_RISKY_NODES` 标注 + smoke 裁判。

**失败语义**：`RH_Translator` 无 `skip_error` 字段 → 失败必须抛，否则 smoke 会 pass 但产出的是原文，用户拿到「翻译没生效」的图却看不到任何错误；`RH_LLMAPI_Pro_Node` 尊重图里的 `skip_error`。空 prompt 短路返回不白花 LLM 调用。采样参数只在显式给了才写进请求体——RH 图里的 `temperature=0` 直透会把本地模型压成贪心解码，而两端 0 的语义并不等价。

**测试**：torch/PIL 延迟导入到 `image_to_data_url` 内部，故纯 stdlib 环境也能导入做单测——新增 **47 例**（注册表与实证类名逐字一致 / ComfyUI 契约完整 / 默认值指向实测 served id / 请求体拼装 / 响应解析含分块 content / **4xx 不重试而 5xx 重试** / 降级语义 / 音频时长 / 图像编码往返取像素校验）。

**部署**：stage2 脚本装在 3 处目录（`/opt/ComfyUI`、`ComfyUI-h3-eval`、`ComfyUI-longcat`），但**只重启 `:8196`（comfyui-gpu0-alt）**。`:8195`/`:8264`/`:8197` 装了文件不重启——RH 云节点应用走通用池不需要 H3，而 H3 链路是 W2.0 六轮实弹才通的，不值得为边缘组合在无人值守时段冒险。重启前后各取一次 `object_info` 节点数，**下降即回滚**（备份 `toiv_rh_shims.bak-<stamp>`）。

**配套**：分类器加 `--recheck-status`（`910dc2fa`）——分类按 webapp_id 断点续跑与状态无关，装完 shim 重跑会跳过全部 64831 行、27029 条 blocked 永不重评，shim 收益拿不到；该选项把 blocked 剔出「已完成」重分类并写入独立产物 `classified_recheck.jsonl`（不污染原文件，导入驱动用既有 `TOIV_RH_CLASSIFIED` 指过去）。实测识别出 27114 行待复检。

**刻意不做**：160 个社区节点包（`INSTALL_PLAN.md`）**不在无人值守时段自动安装**——那是把第三方代码引入生产实例，供应链风险与自研 shim 不同级；计划已按可解锁应用次排序备好，等用户挑窗口。

### W8-7 🔴 新雷（landmine 级，生产在受影响）：`WanVideo*` 前缀把应用硬路由到 :8197，且**绕过模型可用性检查**

**症状**：先导烟测 25 条里 3 条（12%）失败于同一形态——`cls=product`，detail 是一串 `[fixes: node 24: WanVideoModelLoader.model wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors → …fp16…]` 后接 `The model is not a scaled fp8 model, please disable '_scaled' in quantization`。

**逐层查证**（每一步都实测，没有推测）：

1. 该模型**在舰队上是存在的**：`:8196` 与 `:8188` 的 `/models/diffusion_models` 都精确含 `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors`（各 197 条）。**不是缺权重。**
2. `:8197`（LongCat）**只有 fp16 变体、没有 fp8_scaled**（188 条里 `fp8_scaled=False / fp16=True`）——与 repair 做出的替换完全吻合，说明**这一跑被路由到了 :8197**。
3. `_extract_required`（`app/agent/tools.py:188`）**没有字段盲区**：它对 `WanVideoModelLoader` 显式取 `.model` 泛型字段（193-197 行）。所以 `required` 里**确实含**那个 fp8_scaled 文件名。（我先猜是字段盲区，查证后推翻。）
4. `app_smoke.py:431` 是 `required = _extract_required(graph)`——图导出，**不存在存量快照覆盖**（与批E 的 nodes 病灶不同形，这条排除）。（第二个猜测也推翻。）
5. **真因在 `routes/apps.py:4294` 的 `_pick_app_client`**：`n.startswith("WanVideo")` → `longcat_like=True` → 直接 `return get_longcat_client()`。而 `required` 只在函数**最后一行** `return await pool.pick(required=required, required_nodes=nodes)` 才被消费——**专用实例分支在模型检查之前就返回了**。
6. 该应用的 `required_nodes` 实测全是 KJNodes WanVideoWrapper 家族（`WanVideoModelLoader`/`WanVideoSampler`/`WanVideoDecode`/`WanVideoLoraSelect`/`WanVideoTextEncode`…18 个），必然命中 `WanVideo` 前缀。

**为什么错误信息会骗人**：路由落到 :8197 后，`combo_repair(graph, objinfo_all)`（`app_smoke.py:489`）拿**被选中那台**的 object_info 做「就近变体」替换，把 fp8_scaled 权重换成 fp16——但图里与它**耦合的 `quantization` 部件仍是 `fp8_scaled`**，于是报「模型不是 scaled fp8，请在 quantization 里关掉 `_scaled`」。repair 只改耦合对的一半，把「路由错」伪装成「权重不兼容」。（与批E 修的 LLM 补丁 422 遮蔽同型：**修复动作覆盖了原始归因**。）

**影响面**：`_pick_app_client` 同时是**生产生成路径**的 picker（`routes/apps.py:4393`），不只是烟测。WanVideoWrapper 是 RH 图里 Wan2.2 视频最主流的通路，故凡是「模型只在 :8196/:8188 而不在 :8197」的 WanVideo* 应用都会被误路由 + 静默换权重 + 报误导性错误。

**建议修法（窄且与 E-1 同纪律，只是把纪律用到模型轴）**：`longcat_like` 分支在 `return` 前先问一句专用实例能否满足 `required`；不能就**穿透**到 `pool.pick(required=required, required_nodes=nodes)`。同理需复查 `h3_like`/`qwen_edit_like`/`animate2` 三个分支——它们同样在模型检查前返回。

**为什么本轮不直接改**：这是所有 WanVideo* 应用的生产路由热路径，而 stage1 延后流水线会在导入结束后**自动部署工作树里的 api**——未经测试的热路径改动会被无人值守推上生产。故本轮只记录 + 停掉流水线做查证，改法留待带测试的独立提交。

### W9-3 P1-3 配方扩充：实测**不可执行**（两条独立原因，均已证伪原方案）

调研报告 C-9 P1-3 规定用 `GET /api/v1/images?withMeta=true&baseModel=…` 拉 LTXV 2.3 高热度作品元数据结构化成配方。实弹两条都不通：

**① `baseModel` 过滤在 `/api/v1/images` 上完全失效。** `baseModel=Flux.1%20D`、`baseModel=Pony`、`baseModel=LTXV%202.3` 与**完全不传**四者返回同一批：首条 id 均 `12097475`，分布均 `Flux.1 D 37 / Illustrious 16 / Pony 14 / SDXL 1.0 13`，LTXV 字样 **0 条**。传 `LTXV 2.3` 拿回来的其实是 Pony/SDXL 图（meta 里还带 `ponyDiffusionV6XL_v6StartWithThisOne Version` 键）。**若照报告写配方，会把 Pony/Flux 的提示词当成 LTXV 2.3 配方上架。** 这与 RunningHub `page`/`pageSize`/`searchValue` 被静默忽略是同一病，也是 AGENTS 新增 **P-12「派生指标不能自证」** 的第三个实例。

**② 换成可用的 `modelId=` 路由后，SFW 集里没有 prompt 元数据可提。** `modelId=2445735`（Lightricks LTXV 2.3，Checkpoint）返回 100 条且**全部自报 `baseModel: "LTXV 2.3"`**、首条 id `145480486` 与无过滤时不同 → 证明 `modelId` 真生效、`baseModel` 才是坏的那个。但 100 条里**带 prompt 的 = 0 条**；`modelId=2339823`（LTXV2.3 GGUF I2V/T2V/FFLF，Workflows 类）35 条同样 **0 条**。没有 prompt 就没有配方可提。

**结论**：P1-3 按原方案作废。三条备选（**需拍板**）：
- (a) 改用 LTXV LoRA 的 `trainedWords` + Checkpoint 版本元数据，拼「触发词 / 采样参数」型配方——不含图像提示词、不越红线，但信息量低于原设想；
- (b) 从 Workflows 类条目的描述与附带工作流 JSON 提参数——须先逐条查 `allowDerivatives`，且报告 P3 已测得抽样 **70% gated**，可入库池比看起来小得多；
- (c) 放弃 LTXV 2.3 配方，把 P1-3 的预算转给 W8——shim + 装包解锁的应用数量级（430 + 1513 应用次）远大于一个配方族的产品增益。**建议 (c)**。

**另需纠正**：`/api/v1/model-versions?modelId=` 返回 404 是我探错了路径（正确形式是 `/api/v1/model-versions/{id}`），**不是能力缺失**，别记成缺口。

**红线复核**：本轮全程 `nsfw=false`，未抓取、未复述、未生成任何露骨内容；未注册账号、未绕登录墙或付费墙；`by-hash` 溯源只取 id/名称/许可旗标/creator/下载数等结构化字段。

## 14. 决策点（默认值不回复则按默认走）

| 时点 | 决策 | 选项 | 默认 |
|---|---|---|---|
| W0 前 | `opentalking/`（2.6GB 未跟踪含 `.env`）与 `drama/output/` 处置 | A 移出仓库保留 / B 删除 / C 保留+`.gitignore` 登记 | **A（可逆）** |
| W0 前 | 经典 web 4 个陈旧测试 | 现在修 / 标 skip 随 W5 清理 / 直接删 | **标 skip 随 W5 清理** |
| W0-2 | pathname-key Suspense 摘除 | 补回归后摘 / 永久保留为防御 | **补回归后摘**（回归 FAIL 则保留并注明日期） |
| W0-2 | 导航卡死根因最后一层 | 深挖到行 / 组件级绕过即止 | **即止**（要求挖到底则单列一批） |
| W1 | qa 严档抽帧数 | 3 帧（现状）/ 首中尾 3 帧 / 均匀 12 帧 | **快档 3 帧 + 严档 12 帧双档** |
| W2 | 角色资产入库迁移方式 | 双写一批次后切读 / 直接切 | **双写一批次**（照 M4-3 成功口径） |
| W2 | 三视图落法（W2-3） | 路 A：`ref_bindings` 挂 `view_angle` 元数据（不动 schema）/ 路 B：`StudioCharacter` 补 `reference_front/side/back` 三列 | **路 A**（与 W2-1 用途闭集统一，避免两套表达） |
| W3 | `StudioShot.status` 是否按「三状态分离」重写 | 重写（结构性消灭 H-4）/ 维持现状加字段 | **重写**（但需契约升版 + 全量回归，代价最大，可延到 W6） |
| W4 | 剪映草稿出口 | 做 / 不做（守 V4-4 后置） | **做**（不违反 V4-4：不自研 NLE，且其触发条件之一已成立） |
| W5 | 对外 CLI | 做 / 永久搁置 | **做**（v3 判为最低优先级，本轮价值重估上调；你认为不值则搁置） |
| W5 | R18 经典流去向 | A 保留只读壳 / B canvas 增 R18 模式 / C 退役 | **维持 A**（继承 v3/v4 拍板，可逆） |
| W7 | H3 音画一体 A/B | 开 / 不开 | **不开**（需你明确点头；有 10-08 呓语实锤在前） |
| W7 | 多镜头续接翻案 A/B | 开 / 不开 | **不开**（需你明确点头；默认路线不变） |
| 全程 | `STUDIO_MULTITENANT` | 保持默认关 | **保持关**（一旦对外开启即触发 hypit Apache 附加条件 (a)，届时禁引其代码） |
| W8 | RH 不可本地化的应用（④类）怎么处理 | 登记为「云端专属」不上架 / 强行上架 / 直接删行 | **登记不上架**（诚实标注，不伪装可用；守「只 soft-hide 不硬删」纪律） |
| W8 | 首批执行范围 | 只做②可修复类 / ②+①未公开类 / 全量 reseed | **只做②可修复类**（ROI 最高，且能在小批量里验证整条流水线与闸的互动） |
| W9 | civitai 数据源定位 | 一次性参照 / 长期化 `civitai_catalog` 快照 | **先一次性参照**（镜像站稳定性未知；长期化等 W9-1 报告判断） |
| W9 | R18 资产落位 | 只进经典 web R18 面 / 也给 canvas | **只进经典 web R18 面**（canvas 全程无 R18 代码，纯 SFW，这条物理隔离不能破） |

---

## 15. 明确不做（继承 v3 §6 / v4 §4 并追加）

**继承**：社区/UGC、商业积分、多租户（默认关）、自研模型训练/微调（一致性始终走参考路线）、c_hybrid 长视频连续生成**换默认**（W7-2 只做 A/B，不动默认）。

> **2026-10-13 移除项**：原「**RH 市场扩容**」不做项被用户新指令**显式推翻**，改为 W8 主线（见 §12）。v3 §6 / v4 §4 里的同一条目应以本计划为准。

**本轮追加**：
- **节点级多人实时协作**（Shotlab 5 人同画布 + 节点编辑锁）与**团队席位**（Flova 100 席 / 纳逗百人协作）——ToIV 定位本地自用，明确不抄；
- **自研 NLE / 拖拽时间线编辑器 / Remotion**——守 V4-4 决策，W4 只做 EDL + 剪映出口；
- **跑 VBench 模型做客观评分**——只借 16 维词表，不引入其推理栈（本地 GPU 优先级更高）；
- **积分/水印/时长上限**等商业限制机制——不适用；
- **SlotLab 跟踪**——本轮再次确认查无此物（按新片场 Shotlab 处理），维持 v3 「不再跟踪」；
- **Gitee 原生项目补搜**——本轮 Gitee API v5 `search/repositories` 实测返空数组（疑需登录 token），`so.gitee.com` 是 SPA 无法直取；改用 `site:gitee.com` 只找到 GitHub 项目的镜像。**判断：中文 AI 短剧/漫剧项目的发布主场仍是 GitHub**（本轮 62 个新候选里中文项目全部在 GitHub）。若后续拿到 Gitee token，可用 `_tools/discover-d.mjs` 同结构补一路。

---

## 16. 风险与回滚

| 风险 | 触发信号 | 缓解 / 回滚 |
|---|---|---|
| **所有借鉴点均未做 E-3 真机验证** | 任何一条落地前 | 照 E-3 纪律：新引擎/新链路必须真机 e2e 后交付；语料 1614 仓**均未安装依赖/实跑**，本轮结论是「读文档+读源码」级 |
| 剪映草稿私有格式不稳定 | 新版剪映 `draft_content.json` 非明文 / 打不开 | 草稿格式版本纳入 `promise`；升降级失败报准入问题码；`fallback_loader` 兜底；最坏情况退回 EDL + ffmpeg concat |
| W2-4 资产入库迁移踩雷 | 双写不一致 | 照 M4-3 口径：双写一批次 → 校验 → 切读；旧 `char_asset_*.json` 保留为回滚快照 |
| W3-3 状态机重写波及全链 | 大面积测试红 | 决策点已标「可延到 W6」；重写需契约升版（`PLATFORM_V2_CONTRACT.md` 记变更）+ 全量回归 |
| AGPL/GPL/ELv2 误并码 | code review | 每条借鉴点已标许可；AGPL（OpenMontage/ArcReel/Kinema）、GPL（Motion-Context 等 5 个 H3 件）、ELv2（dramaclaw）、无 LICENSE（MiniMax-H3 官方仓/Storyboard-Copilot 等 6 个）→ **全部只抄思路，代码自写**；可并码白名单：Jellyfish(Apache)、zenstory(MIT)、pyJianYingDraft(Apache)、video-use(MIT)、lumenx(MIT)、AIMixer/tritant(Apache)、VBench/UNO(Apache)、TFboy1(MIT)、H3-Continuum(MIT) |
| 生产部署踩并行会话 | 关键服务莫名掉线 | 守 P-5（并行 SSH 会互相改写状态，先 `journalctl -u <svc>`）；web/admin 一律 core 本机构建；api 走 `deploy/deploy.sh --skip-web core-jump` |
| W0-3 转码拼接引入画质损失 | 目检对比 | 同规格仍走 copy 快路径；只有检测到不一致才转码，且**显式记录发生了归一**（不静默） |

---

## 17. 执行顺序（2026-10-13 用户已授权自主推进，不再逐波请示）

```
并行轨 A（代码/产品）：W0（2–3 批）→ W1（2–3 批）→ [W2 与 W6-1 并行] → W3 → W4 → W5 → W6 余项 → (W7 视拍板)
并行轨 B（资产/运营）：W8-1 只读盘点 → W8-3 分批执行（②可修复类起）→ 与 W9-1 调研合流 → W9-2 资产补强
```

**两轨可并行的理由**：轨 A 改的是 `apps/api/app/services/studio/*` + `apps/canvas/web/*`（代码域）；轨 B 改的是 DB 行状态（`is_public`/smoke 字段）+ NAS 权重文件 + MODEL_SOURCES 账（数据/运营域）。**唯一交叉点是 `app_smoke.py` 与队列闸**——轨 B 跑 smoke 会占 GPU 与队列深度，因此轨 B 的批量真跑必须避开轨 A 的生产实弹验收窗口（守 P-5：并行会话会互相改写状态）。

**每批的固定动作**（沿用 v4 口径）：实现 → 测试（三端全绿基线）→ `deploy --all` → **LAN 直连实弹**（`http://192.168.71.47:3100` / `:8090` / `:3200`，用户在局域网时优先 LAN，外网/发布回归才走 wineryz）→ 入账（STATE + AGENTS + docs）→ 推送双远端。

**自主执行的自约束**（授权不等于无纪律，以下每条仍然守）：
1. **生产写操作分批 + 每批可回滚**：W8 不做一次性全量 reseed；只 soft-hide/上架，不硬删行（`rh_market_reset.py` 既有纪律）。
2. **不碰不在场的东西**：`opentalking/`（2.6GB 含 `.env`）按默认 A 移出仓库保留、不删除；工作站侧不在仓库的补丁文件（10-11 三处 RH resolve 补丁）只做守护、不回滚。
3. **GPU 与队列错峰**：批量 smoke 前查 `sum_queue_depth`，封面闸 gated（depth>12）时不硬闯；H-4 纪律——失败先查 `/history/{pid}`，产物在就回写，禁止盲目重提。
4. **诚实标注**：不可本地化的应用登记为「云端专属」不上架；`qa=skip` 显示「未质检」不伪装 pass；拿不到的数据写「未能核实」不编造。
5. **每波收口即入账**：STATE + AGENTS + docs 三处同批更新，含数字更正（当前 AGENTS 基线 api「4132/0」/web「1031 全绿」均已过期）。
6. **仍会主动上报的三类事**：①发现新的活雷级缺陷（如 W0-3）②需要推翻既有用户拍板（如 R18 A/B/C、c_hybrid 默认路线）③不可逆或高影响操作（删数据、删目录、force push、动生产 PG schema）。授权覆盖执行，不覆盖这三类的知情权。

**建议先落地的仍是 W0 + W1**（约 4–6 批）：W0 是地基（基线不可信时后续判据全失效）+ 两条真缺陷；W1 是双源确认的最高性价比项。轨 B 的 W8-1/W9-1 盘点本轮已并行派工，报告回来即可开 W8-3 首批。

---

## 18. 变更记录

- 2026-10-13 v1：初版。依据三份调研（商业 13 家 / 开源语料再挖 + 39 仓新克隆 / 代码级盘点）+ 2026-10-08 实弹日志重排 v3 六主线；**纠正上一批入账口径**（react-router 实为降级钉版 7.9.5，非升级 8.4.0）；新增 W0 拼接规格归一（活雷）与默认竖屏两条真缺陷；V4-4 后置项找到不违反原决策的低成本落地路径（EDL + 剪映出口）。
- 2026-10-13 v2：用户追加两条指令并授权自主推进——**新增 W8（RunningHub 全量本地可部署化）与 W9（Civitai.red R18 参照线）**；**显式推翻 v3 §6 / v4 §4 / 本计划原 §13 继承的「RH 市场扩容」不做项**；补 §12 W8-0 通路实测（runninghub.cn 直连 200、civitai.com 不通、**civitai.red 直连 200**、core SSH 与 toiv-api/web active）；§14 增 4 条决策点（默认值已给，按默认走）；§17 改为双轨并行 + 自主执行六条自约束（含「仍会主动上报的三类事」）；章节重编号（原 12–16 → 14–18）。
- 2026-10-13 v3：W8-6 批D-3 RH 云节点 shim 按**生产图实证签名**重写（6 类新增 / `RHHiddenNodes` 判为不可通用 shim / 47 例单测 / stage2 只重启 :8196 且节点数下降即回滚）+ 分类器 `--recheck-status`；**W9-3 证伪 P1-3 配方方案**（`baseModel` 过滤在 `/api/v1/images` 上完全失效——四个变体返回同一批首条 id 12097475；换 `modelId=` 真生效后 SFW 集带 prompt 的仍为 0 条），建议把 P1-3 预算转给 W8；明确 160 个社区节点包**不无人值守自动安装**（第三方代码供应链风险）。
- 2026-10-13 v4：**W8-7 记录一枚 landmine 级新雷**——`_pick_app_client` 的 `WanVideo*` 前缀把应用硬路由到 :8197 并在 `pool.pick(required=…)` 之前返回，导致模型可用性从不被检查；随后 `combo_repair` 用被选中那台的清单把 fp8_scaled 权重静默换成 fp16、却不动与之耦合的 `quantization` 部件，把「路由错」伪装成「权重不兼容」。查证过程连带推翻两个先验猜测（`_extract_required` 字段盲区、存量快照覆盖），六步证据见 W8-7。**生产路径同受影响**；本轮只记录不改（stage1 会无人值守自动部署工作树）。


---

## W8-11 `tuple index out of range` 簇根因定性（2026-10-13，自造雷，无线上损害）

**结论先行**：这不是第三方包版本漂移，也不是我方剪枝造悬空连线，而是**我方 RHHiddenNodes shim 的输出元数不够宽**。

### 机制（逐字定位，非推测）
ComfyUI `execution.py:925-927`：
```python
o_id = val[0]
o_class_type = prompt[o_id]['class_type']
r = nodes.NODE_CLASS_MAPPINGS[o_class_type].RETURN_TYPES
received_type = r[val[1]]          # ← socket 越界 = IndexError: tuple index out of range
```
异常被 `validate_inputs` 的 inner 分支捕获（`execution.py:961` → `"Exception when validating inner node"`），**错误挂在下游消费者身上，真凶不出现在信息里**。

### 排除的两个假设（都是先猜后证伪）
1. *object_info 空 spec 假设*：四个受害类逐一取 `object_info`，required/optional/hidden 无一项为空或非 list → 排除。
2. *我方剪枝造悬空连线假设*：`rh-acc-6319519745-e513fc` 存量原图与 `_build_graph` 之后，悬空/畸形连线均为 **0** → 排除。

### 定案证据
`rh-acc-6551162881-57c57b`（28 节点）越界连线恰 1 条：
```
目标 327 (TextEncodeQwenImageEditPlus) 字段 'prompt' ← 连线 ['382', 1]
源类 RHHiddenNodes 实际 outputs(1) = ['IMAGE']
```
存量原图同样 1 条 → 不是 `_build_graph` 引入，是云端原图本就引用 socket 1，而我的 shim 只给了 1 个输出。

### 规模校正（对自己上一轮结论的纠正）
先前在 17 条抽样里看到 4 例，据此称其为「新的最大失败簇」——**全库实查只有 7 条**：

| 口径 | 数 |
|---|---|
| app 总数 | 13582 |
| 含 RHHiddenNodes | 760（未测 680 / fail 72 / pass 7 / 已上架 6） |
| fail 报 `tuple index out of range` | 7 |
| 其中含 RHHiddenNodes | 6 |
| fail 报 `Return type mismatch` | 20 |
| smoke pass / fail 合计 | 1868 / 544 |

抽样外推的簇规模必须回全库核（AGENTS P-14 同型；已另记 E-10）。

### 损害评估
**无线上损害**：7 条全部 `smoke=fail`，故未上架。已上架的 6 条 RHHidden 应用来自 pass 集——即 socket 0 图像直通路径确实能工作（此前对 RHHiddenNodes 的第三次判断翻转，正向结论仍然成立）。

### 处置决策
**不采用「加宽 RETURN_TYPES 骗过校验」**：过校验后节点返回值个数与声明不符，只会在执行期换一个更难懂的错，属于典型的假承诺（P-13 同族）。不可通用 shim 的正确终态是**清晰的归因失败**。

待办（需更多轮次，纯函数可离线单测，不占 GPU）：把 socket 越界检测并入 `preflight_check` 的 advisory 桶，让 `smoke_error` 直接点名 `RHHiddenNodes` 而不是报下游节点名。

---

## W8-12 cusolver「已修已验证」结论撤回（2026-10-13）

先前 STATE 记 `cusolver_root_cause_fixed` + `cusolver_fix_verified_in_production`,依据是打了
`apply_wanvideo_unipc_cpu_solve.py`(把 `fm_solvers_unipc.py:497/:643` 的 `torch.linalg.solve`
移到 CPU)后单实例烟测通过。**该结论撤回**。

P-15 核验(进程启动时间 vs 文件 mtime):

| 实例 | 端口 | 启动时间 | 补丁 mtime | 已加载 |
|---|---|---|---|---|
| comfyui-gpu0-alt | :8196 | 2026-10-13 10:04:22 | 08:34:09 | ✅ |
| comfyui-longcat | :8197 | 2026-10-13 10:04:25 | 08:34:09 | ✅ |
| toiv-comfyui-h3 | :8195 | 2026-10-06 14:09:41 | 08:34:09 | ❌ 从未加载 |
| toiv-comfyui-h3-gpu1 | :8264 | 2026-10-11 02:14:52 | 08:34:09 | ❌ 从未加载 |

三处目录 md5 同为 `938168a3`、`R.cpu(), b.cpu()` 各 1 处 → 文件面没问题。

**关键反证**:stage5 日志里 cusolver 报错时间戳 `10:26:27` 与 `10:30:38`,均**晚于** :8197 的
10:04:25 重启 → 补丁确已加载仍复发。说明单调用点补丁不充分:`cusolverDnCreate` 是库/上下文级
失败,任意 `torch.linalg.solve`/SVD/QR 调用点都能触发,堵一处不等于堵住全部。

**campaign 处置**:stage5 与 `rh_smoke_batch` 已停(可逆,98 条数据留档)。pass 31 / fail 63 /
timeout 4 = **pass 率 32%**,低于先导批 60% 放量判据;按纪律先归因再放量,不继续烧 GPU。
失败归因:其他 31、`Required input is missing` 11、`Return type mismatch` 9、精度耦合拒绝 6、
`tuple index out of range` 5、cusolver 5。

**下一步(需人工窗口)**:①查 GPU 是否 requires reset(`nvidia-smi -q`)+ dmesg Xid;
②评估把 `torch.backends.cuda.preferred_linalg_library` 全局设 `default`/`magma` 替代逐点 `.cpu()`;
③核 libcusolver 与 torch 2.12.1+cu130 / sm_120 匹配性(P-7);④重启 :8195/:8264 加载已就位补丁。

沉淀 AGENTS **E-11**:写「已验证」前必查两件事——补丁是否真被加载(进程启动时间 > 文件 mtime)、
同一故障是否还有其他调用点。

---

## W8-13 上架通道打通：增量发布 + H3 口 shim 补装（2026-10-13）

### 1. `:8195`/`:8264` 从未加载 RH shim（P-15 第四次命中）
127 条「缺节点」fail 里出现 `RH_Captioner`(6)/`RH_LLMAPI_NODE`(3)/`RH_Translator`(1)——**全是我自己写的 shim**。
逐口 `object_info` 实测：

| 实例 | shim 类 | 节点总数 | 处置 |
|---|---|---|---|
| :8196 | 8/8 | 5269 | 10:04 已重启 |
| :8197 | 8/8 | 4674 | 10:04 已重启 |
| :8195 | **2/8** | 4380→**4387** | 本轮重启后 8/8 ✅ |
| :8264 | **2/8** | 4380→**4387** | 本轮重启后 8/8 ✅ |

盘上三处 md5 同为 `11d573838e`、mtime `10:00:49`，但 `:8195` 启动于 10-06、`:8264` 于 10-11 → **文件在盘上≠已加载**。
重启前核过：core 活跃用户作业 0，`:8264` 队列里 1 running + 2 pending 全是本次烟测自己的作业，不打断真实用户。
顺带：这两口也才第一次加载 UniPC CPU-solve 补丁。
**属边界内**：装的是本仓自己的 shim + 重启自家实例；第三方包安装仍按约定等用户确认。

推论：此前凡被路由到 H3 专用口且用到 RH 云节点的应用都会假性报 `missing_node`，
说明舰队能力扫描对这一路存在**系统性低估**（见记忆 fleet-scan-restart-caveat）。

### 2. 增量上架（`--publish-every`，默认 25）
一条 600 项战役要跑数小时，原先只在**收尾**才批量上架 → 已逐条验证可用的应用长时间闲着。
改为每攒够 N 条 pass 即发一批，收尾冲残余。判据仍是「该应用自己 smoke pass」，与先导批 60% 群体判据是两回事。

### 3. R18 边界二次实测（发布前后都核）
上架 4 条 H3 NSFW 应用后：PG `count(*) FILTER` 显示 public 1873→**1877**、四条均 `is_public=true`；
同时不带 `X-NSFW` 的市场查询拉到 1000 条，其中这四条出现 **0** 条、`is_nsfw` **0** 条。
即 R18 只在经典 web 的 R18 面可见，**没有漏进 `/studio`**（canvas 从不发送该头）。

### 4. 大小写错配：测到了，但不足以立闸
路由用 `required ⊆ available` 精确成员判断，故 `Flux-2-Klein-9b-fp8.safetensors`（应用索求）
对 `flux-2-klein-9b-fp8.safetensors`（盘上/舰队可见）会判「缺模型」并在 pick 阶段直接拒。
全量核（非抽样）：**154 个缺失权重名里只有 1 个属此类 = 0.6%**。
收益太小，**本轮不改代码**（不为 1 例造通用机制）；仅记为已知低计数缺陷。

### 5. 缺模型桶的真实边界（重要）
154 个清洗后的权重名：**逐字已在舰队可见 9**（属陈旧测量）/ **仅大小写 1** / **完全不可见 144（94%）**。
获取通路核查：hf-mirror 的 API 能列文件但 `resolve/` 对这些社区仓 **404**（未缓存）；
`huggingface.co` 从工作站解析进 Facebook 地址段（DNS 污染）→ 不可达。
→ **94% 的缺模型 fail 是硬阻塞**，需用户 civitai token 或人工择源，不属我可自主推进的范围。
（附带收获：Mac 侧本轮 `huggingface.co` API 可达，与旧记忆「本机被污染」不完全一致，按现测为准。）

---

## W8-14 已装 pack 因 config.ini 脏行整体导入失败：+42 节点（2026-10-13）

### 发现路径（关键是别信状态码）
逐实例翻启动日志找 `IMPORT FAILED`，:8196 上有两个：`ComfyUI_tinyterraNodes` 与 `ComfyUI_IndexTTS`。
先按 `curl -w %{http_code}` 探 `ttN text3` 得 **200**，据此几乎判定「ttN 没问题」；
改用 **body 键名** 复核才发现 `200` 的 body 是 `{}`，连 `totally-made-up-node` 也返回 200 ——
**状态码在这类接口上完全没有信息量**（已沉淀 AGENTS **P-16**）。

### 根因
`ComfyUI_tinyterraNodes/config.ini` 第 9 行是一个孤儿续行 `.0`（前一行 `advplot range = 1.1.0` 已被截断），
`configparser` 抛 `ParsingError` → 该 pack 的 `__init__.py:110 update_config()` 崩溃 → **整个 pack 不注册**。
不是缺包、不是缺依赖、不是版本漂移，**一个数据文件的脏行让 42 个节点消失**。

### 处置（只动数据文件，零安装）
1. `cp -n config.ini config.ini.bak-20261013-1509`（可回滚）；
2. 程序化只摘「以空白开头且不含 `=` 的孤儿续行」，保留段头与全部 `key = value`；
3. 修复后解析 OK，6 条版本记录完好：pipeedit 1.1.1 / pipe2basic 1.1.0 / tinyconditioning 1.0.2 / pipeksampler_v2 2.3.1 / pipeksampleradvanced_v2 2.3.0 / advplot range 1.1.0；
4. 只有 `/opt/ComfyUI`(:8196) 装有该 pack（longcat / h3-eval 无此目录），故只重启 :8196；
5. **重启前先停烟测战役**，避免打断在跑作业污染 pass 率测量。

### 验证（P-15 守卫）
:8196 节点总数 **5269 → 5311（+42）**，未下降；ttN 族注册 42 个。
再查「这 56 个应用实际引用哪些 ttN 类」：**6 种（`ttN concat/float/int/seed/text/text7BOX_concat`），修复后仍缺 0 种**。

### ⚠️ 收益口径自我纠正（别把「少一个拦路项」说成「解锁 56 个」）
修好 ttN 只是**移除了这 56 个应用的一类拦路项**;每个应用能否真跑还取决于它其余的缺节点/缺模型。
首批 10 条实测 **pass 0**,归因:transport 4(我自己重启触发熔断的**测量污染**,非应用缺陷)、
missing_node 4(`FL_ColorPicker`/`VRAMReserver`/本地化类名 `TTN浮点`/`帧率`)、missing_model 2。
所以本条的**确定收益只有「:8196 节点数 +42、ttN 族 6 类由不可用变可用」**;
「解锁 56 应用」的说法作废,实际净增 pass 待 56 条跑完再报。
另外熔断污染是我这次操作引入的:重启 :8196 会把在跑的烟测打成 `transport` 并写入 fail,
**下次重启前必须停战役并等熔断冷却**(本轮已停,但头 4 条已写成 fail,需在恢复后重测覆盖)。

### 复发风险（必须记账）
`update_config()` 是**该 pack 自己在启动时写这个文件**的，脏行可能再次产生；
而它的失败是静默的（ComfyUI 只打一行 IMPORT FAILED，节点数悄悄少 42）。
**守法**：每次重启 :8196 后取一次 `/object_info` 键数并与 5311 基线比，掉 40+ 就查 `config.ini`。
（对应 AGENTS D-2「一次性手工迁移没有守护会静默失效」。）

### 其余 IMPORT FAILED 的现状（未动，避免无收益改动）
- `ComfyUI_IndexTTS`：`cannot import name 'OffloadedCache' from transformers.cache_utils`（库版本面，5 个应用引用）；
- `LayerStyle`：`cv2.ximgproc.guidedFilter` 缺（需重装 opencv-contrib-python，属依赖变更）；但 `LayerUtility: PurgeVRAM V2` 实测**已注册**，5141 引用面未受影响；
- H3 两口：`ComfyUI-LTXVideo`/`dlib`/`wget` 缺模块（分别影响 VRGDG_LTXLoopingSampler、人脸自动矫正、LG_Tools inspynet）。
按纪律这些都属依赖/包变更，**不在我自主边界内**，等用户确认再动。

---

## W8-15 吞吐上限与一条被核实为「假增量」的扩容路径（2026-10-13）

剩余工作量已是确定的数:**7,364 条** per-worker 判定可本地部署但尚未烟测的应用。
当前 ~40–50 条/小时 → 150–180 小时连续运行。瓶颈是 `:8196` 与 `:8197` **同处 GPU0**,
所以并发不能再抬(抬了就触发池探针超时→熔断→把健康应用写成 transport 假 fail,已实测)。

### 想加第三台:先量,结论是「现在不能直接加」
| 实例 | 卡 | 类名 | 模型选项 | ttN | RH shim |
|---|---|---|---|---|---|
| :8196 通用池 | GPU0 | 5311 | 26,621 | **42** | **8/8** |
| :8262 超分 fleet | **GPU0** | 4938 | 38,513 | 0 | 2/8 |
| :8263 超分 fleet | GPU3 | 4938 | 36,369 | 0 | 2/8 |
| :8199 Wan-Animate-2 | GPU3 | 893 | 212 | 0 | 0 |
| :8264 H3 生产口 | GPU1 | 4387 | 4,512 | 0 | 8/8 |

两点必须写下来免得下轮再误判:
1. **`:8262` 也在 GPU0** —— 把它加进池**不增加任何物理算力**,只多一个抢同一张卡的进程;
2. `:8263` 确实在 GPU3(GPU3 尚有约 51GB 空闲),但它**没有今天的两项修复**:ttN 类名 **0** 个、
   RH shim 只 **2/8**。直接 `backends.json` 加它,会把「刚被解锁的那 56 + 1,475 个应用」
   路由到一台跑不了它们的机器上 —— 与 :8195/:8264 当时的 shim 未加载是同一型问题(P-15)。

### 若要真扩容,前置动作顺序(不可颠倒)
① 把 `toiv_rh_shims` 与 tinyterraNodes 的 `config.ini` 修复同步到 :8263 所用目录并**重启该机**,
逐个 `object_info` 核验 ttN 与 8 个 shim 类都在(按 body 键名,不看状态码 P-16);
② 确认 :8263 的模型目录可见性(它模型选项 36,369 反而比 :8196 多,说明 extra_model_paths 配置不同,
需核对是否同一 NAS 树,别让 pick 以为有而实际读不到);
③ 再改 `/opt/comfyui-lb/backends.json`(5s 热重载,零重启,AGENTS 🔒 唯一正道),
并在烟测停跑的窗口做,避免污染 pass 率测量。

### 交接要点（剩余轮次内做不完,勿重复劳动）
- 已完成并可核对:导入 14,304;市场可见 1,903;已验证 pass 1,900;
  RH 可及上限 7,450(ok 5,975 + 重评解锁 1,475),其余 57,544 条已实测排除(发布者关导出 / 缺件无源)。
- 自动链路:`scripts/ops/rh_smoke_supervise.sh`(按 `priority_perworker.txt`,并发 2,
  每 10 条 pass 增量上架,轮间 `publish_pass_but_hidden.py` 收割,连续两轮零 pass 自动止损)。
- 等用户:装包(两个包覆盖真实缺失节点类的 53%)、civitai token(96% 缺权重唯一通路)。
- 别再做:从 civitai 抓 prompt 扩配方库(180 图 / 0 meta 已证伪);重测旧 fail(救回率 13.3%,结构性缺件)。

## W8-16 两处口径纠正：running 卡的测量本身是错的 + civitai token 前提被证伪（2026-10-13）

### ① 撤回「pkill 留下 3 条 running 孤儿已修」（`c2fb1bca`/`47c01add`）
两次结论都建立在同一个**错的测量**上。我在 core 手跑 `reconcile_interrupted_smokes()` 打印 `0`,
同刻 PG 里却有 2 行 `smoke_status='running'`——我先据此写「孤儿已修」,又据此写「reconcile 失效」,
**两条都错**。真因:`TOIV_DATABASE_URL` 只存在于 systemd 进程环境(core 上没有 `.env` 文件),
手跑时缺这个 env,`app.db` 静默回落到 §五 早已判废的 SQLite `toiv.db`。
从 `/proc/<api pid>/environ` 取出真实 URL 重跑同一函数:**`reconcile returned: 2`,PG 里 running 归零**。
函数一直是对的,错的是我的测量。

- 那 2 条卡确实是**卡死态**（不在活跃 id 清单、无任何进程持有），现已清回未测、会随下一轮清单被重测；
- **但「谁把它们打成 running」仍未定**——不能从行本身判定:`smoke_at` 只在完成时写,
  `updated_at` 定义无 `onupdate`(`models.py:387`),所以 `updated_at == created_at` 不证明这行没被 UPDATE 过。
  要判定只能靠外部证据(API `ActiveEnterTimestamp` 15:40:49 / 活跃 id 清单 / `:8196 /queue` 现况)。
- 根治要加 `smoke_started_at` 列 = 生产 PG schema 变更,**未擅动**,列为待拍板项。
- 已入账 AGENTS **P-18 / P-18b**。

### ② 「25 条缺件唯一通路是用户注册 + token」——token 这半边前提已不成立
实测生产 api 进程环境里**早就有** `TOIV_CIVITAI_API_KEY`（32 字符,`marketplace.py:35`/`model_wiki.py:58`/
`nas_models.py:38` 在读）。拿 blocked 且带 civitai id 的 3 条(2717298 / 2027766 / 2270257)做前后对照:

| id | anon | auth | 差异 |
|---|---|---|---|
| 2717298 | 200 / 1 version / 1 file / downloadUrl 有 | 同左 | **无** |
| 2027766 | 200 / 20 versions / 2 files / downloadUrl 有 | 同左 | **无** |
| 2270257 | 200 / 1 version / 1 file / downloadUrl 有 | 同左 | **无** |

即**元数据层根本不需要 token**，匿名已能拿到 `downloadUrl`；「全部需要登录才能拿」的旧结论至少对这三条是假的。
但这不等于「能下载」:对真实 `downloadUrl` 做 1 字节 Range GET(`-r 0-0 -L`)从 core 出发 **>100s 无返回**,
测试挂住未出结果 → **25 条可下载仍未证**，按 P-12「字段存在 ≠ 通路可达」处理。

**修正后的待拍板口径**：卡点不是「等用户给 token」（生产已有），而是「等一条能从 core/WS 跑通的
civitai 文件下载通路 + 用户放行把权重下载到 NAS」。缺件线（任务 #17/#24）在拿到这条通路前不要再记收益。

## W8-17 两条卡死卡的真实结局 + civitai 文件通路的真因是域名可达性（2026-10-13）

### ① 清回未测后立刻被真跑，两条都是**真坏**（不是被状态卡住的好卡）
`reconcile` 于 17:47:06 把 `rh-acc-0018549761-0fedd3` / `rh-acc-0029976577-97f43a` 清回未测；
同一轮在跑 `smoke_all_173429.jsonl` 随即给出终态：
- `0018549761` → `fail / cls=product`，`llm-repair trial fail`，sec=875.4
- `0029976577` → `timeout / poll exceeded 900s`，sec=905.7

即这两条**不缺机会，缺的是能跑**。⚠️ 未解开的机制问题（**故意不写成结论**，P-18 的教训）：
`--ids-file` 在进程启动时一次性读入（`rh_smoke_batch.py:102`），而 17:34 那份清单**不含**这两个 id
（现文件里它们只出现在我 17:54 追加的第 7360/7361 行）——所以「谁把它们提交进本轮」还没查清。
`sec` 字段与 17:47 之后才开始跑也对不齐。**下轮先查这条提交路径**（候选:批量脚本的 DB 补足分支、
api 侧 untested runner、admin 手动触发），别在机制不明时再写「孤儿/排除」类结论。

### ② 今日主力清单的真实 pass 率（用于校准剩余工作量）
`smoke_all_*.jsonl` 合计 185 条结果:**pass 53 / fail 121 / timeout 10 / http_404 1**，去重后 131 个应用。
按「本轮新增 pass」口径 53 条,与 PG 累计 pass=1904 一致增长中。

### ③ civitai 权重拿不到的真因:**文件域名 civitai.com 在本集群不可达**，与 token 无关
- 元数据走 `civitai.red` 完全可用（anon 即含 `files[].downloadUrl`）；
- 但 `downloadUrl` 的 host 是 **civitai.com**；从 workstation 直连 `-r 0-0 -L` → `000`（30s 超时）×3 条；
  经 Mac Clash 代理 `192.168.71.9:7897` 同样 → `000`（25s 超时）。
- 结论:**25 条 blocked 缺件的卡点是域名可达性**（civitai.com 在本机被 DNS 污染/阻断，见网络记忆），
  不是账号权限。要解需要提供一条能拉 `civitai.com` 文件的通路（可用镜像/代理，或用户手工下载入 NAS），
  在拿到通路之前，MODEL_SOURCES 的 96% 不可得结论**依然成立，但理由要换成这一条**。

## W8-18 机制定案:那两条根本不是孤儿——它们是**在跑**（10-13 结案，含对我自己两次结论的再纠正）

判据来自一条被忽略的反向核验:本轮第一条 pass `rh-acc-0015360002-575f6a`
（17:39:03，274.3s→17:34:29 起）**同样不在当前磁盘清单里**(`grep -n` 零命中)。
既然连 pass 的那条都不在,就不是「两条孤儿被神秘提交」,而是
**17:34:29 那个进程读到的清单内容 ≠ 现在磁盘上的清单**——清单在轮间被重建过,
重建时按 `smoke_status` 空值筛,于是当时正处 `running` 的这两条(连同若干条)从新清单里消失。

三条结论据此改写:
1. **W8-16/17 里「两条卡死卡/谁提交进本轮未解」的问题不存在**——它们一直在被真跑,
   `smoke_status='running' + smoke_at IS NULL` 是**在跑**的正常形态,不是孤儿态。
2. **我 17:47 手跑的 `reconcile_interrupted_smokes()` 是对在跑烟测的干预**（把它们打回 ''），
   只是客户端侧仍在轮询、终态照样落库(fail/timeout),所以没造成假象。**纪律:战役在跑时不得手调该函数**,
   它的设计口径是「API 启动时收口一次」(docstring 自述),不是运维随手清卡的工具。
3. **`a5cddfba` 提交说明的理由写错了**:补进清单不是「必须显式补录才会被重测」,
   而是「重建后的清单本来就不含它们」;这两条终态为 fail/timeout,补不补都不改变它们不能跑的事实。

为让这类判定今后一次到位,`rh_smoke_batch.py` 读 `--ids-file` 时现在把
`n=<条数> sha256=<前16位>` 打进日志——**清单是被轮间重建的可变量,没有当时的指纹就无法事后自证输入**。

## W8-19 交接：续跑指令与当前真实计数器（10-13 18:02 CST，战役仍在跑）

盘面（PG 为准，非派生计数）：`total 14,304 / public 1,905 / pass 1,906 / running 2 / untested 11,583`。
今日战役累计终态：190 条 = `pass 55 / fail 124 / timeout 10 / http_404 1`。
⚠️ **`pass(1,906) > public(1,905)`**：至少一条 pass 卡尚未上架。两种正常解释——增量上架缓冲（每攒 10 条发一批）
或落在 `MERGE_HIDE_IDS` 启动期不变量里（P-17，故意不发）。**下一轮先跑 `scripts/ops/publish_pass_but_hidden.py`
收割并核对差集**，别把它当成漏发，也别当成缺陷。

在跑链路（父进程 PPID=1，已脱离会话，不会随终端退出而死）：
- `bash scripts/ops/rh_smoke_supervise.sh`（8 轮，轮间收割 pass-but-hidden，连续两轮零 pass 自动止损）
- `apps/api/.venv/bin/python scripts/ops/rh_smoke_batch.py --ids-file tmp/rh_smoke_20261013/priority_perworker.txt --limit 7400 --concurrency 2 --timeout-s 900 --sleep 1.2 --publish-passes --publish-every 10`
- 看进度：`tail -f tmp/rh_smoke_20261013/supervisor.log`；逐条终态：`tmp/rh_smoke_20261013/smoke_all_*.jsonl`

剩余工作的确定量级与上限：可本地部署但未真跑 ≈ **5,450 条**，~40–50 条/小时 → **还需 110–135 GPU-小时**。
物理上限是 `:8196` 与 `:8197` 同处 GPU0（并发抬到 3+ 会触发池探针超时→熔断→把健康应用写成 transport 假 fail，已实测）。

下一轮该做的三件（按价值排序，均不需要新决策）：
1. 继续收割上架 + 每轮末用 PG 口径复核 `pass/public/untested` 三数（勿用接口 done 数，P-12/P-17）；
2. 清单重建会按 `smoke_status` 空值筛掉**在跑**的卡（W8-18 定案），故 `--ids-file` 读取已打 `n+sha256` 指纹；
   复盘任何「这条为什么没跑/跑了」先看这条日志，别再拿磁盘现值倒推输入；
3. `handoff` 之后仍开着的两处真缺件：TTN 浮点/帧率等 21 条 class_type 归因（任务 #26，先证伪再决定建不建别名表）、
   以及需用户放行的第三方装包（覆盖缺失类名 53%）与 civitai 权重字节通路（卡在 civitai.com 域名不可达，与 token 无关）。

## W8-20 真吞吐上限找到了：池里只有**一个**成员（10-14 11:50 CST，已扩容并纠正 W8-15）

### 实测速率远低于先前估计
把今天所有 `smoke_all_*.jsonl` 汇总：387 条结果跨 21.1 小时 → **18.4 条/小时**
（`pass 168 / fail 189 / timeout 29 / http_404 1`），延迟 `p50=205s / p90=696s / max=1012s`。
`3600 / 205 ≈ 17.5/h` 与实测吻合 → **等价于并发 1**。`--concurrency 2` 没换来并行，
因为 `backends.json` 里当时**只有一个成员**：
```json
[{"id":"gpu0","url":"http://127.0.0.1:8196","gpu":0,"weight":1.5}]
```
两个提交都排在同一个 ComfyUI 进程的队列里（实测 `:8196 /queue` = running 1 + pending 1，`:8263` = 0/0）。
单实例饱和的旁证：`:8196 /object_info` 耗时 **116.9s**（18MB）而 `/queue` 只要 **1ms**；
这也解释了先前「抬并发就出 transport 假 fail」——探针 TTL 只有 10s，打的是同一台被打满的机器。

### 纠正 W8-15：`:8263` 不需要装任何东西，只需要**重启**
W8-15 记的「`:8263` 缺 ttN(0)、RH shim 只 2/8，直接加会把刚解锁的应用路由到跑不了它们的机器上」
——**前提错了**。`:8263` 与 `:8196` 是**同一棵 `/opt/ComfyUI` 树**（`WorkingDirectory=/opt/ComfyUI`，
只差 `--port/--output-directory/--cache-lru 2/--disable-smart-memory`），盘上文件本来就齐；
它报 2/8 与 ttN=0 是**进程陈旧**（P-15「装了文件 ≠ 生效」的又一实例，这次反过来：文件在、进程没加载）。
`systemctl restart comfyui-upscale-gpu3` 之后实测：

| 指标 | :8196 | :8263（重启后） |
|---|---|---|
| 类名总数 | 5,311 | **5,309** |
| RH shim 类 | 9（含 `Runninghub Captioner`） | **9（同一组）** |
| ttN | 42 | **42** |
| 五类 loader 模型选项合计 | 711 | **711（ratio 1.000）** |
| 独有类名 | `GuHai_FaceAlignment` / `GuHai_IDPhotoCrop` | 无 |

即除 `Goohaitools-comfyui/nodes/面部对齐.py` 那 2 个类外**能力等价**（该包在 :8263 这次启动没导入成功，
待查；两个类都很冷门）。共享的导入失败（`ComfyUI_IndexTTS` 撞 transformers `OffloadedCache`、
`dzNodes LayerStyle` 撞 `cv2.ximgproc.guidedFilter`）两边一致，不构成差异。
GPU3 显存 46.4/97.9GB 已用（**51GB 空闲**），且 `core → 100.68.100.90:8263/system_stats` = 200 / 6ms。

### 已执行（可回滚）
1. `cp /opt/comfyui-lb/backends.json backends.json.bak-20261014-gpu3`；
2. 加入 `{"id":"gpu3","url":"http://127.0.0.1:8263","gpu":3,"weight":1.0}`（gpu0 权重保持 1.5）；
3. LB `/admin/backends` 两成员均 `healthy: true`；
4. **api 侧已确认生效**（不是靠推断）：`journalctl -u toiv-api` 03:50:23 UTC
   `ComfyUI worker 池注册表刷新:新增 ['http://100.68.100.90:8263'],移除 [],当前成员 ['…:8196','…:8263']`
   （`_REGISTRY_TTL=60s`；`pool.py:147` 会把 127.0.0.1 改写成注册表 host，故走 TS，实测 6ms）。
- 回滚 = 恢复 `backends.json.bak-20261014-gpu3`（5s 热重载，零重启）。
- 注意 `:8263` 同时是生产**超分** worker（`comfyui-upscale-gpu3.service`），入池后与出图任务共享该进程；
  本次重启时它空闲（GPU 利用率 0%），影响窗口只有重启的 ~2 分钟。

### 待测（本轮结束后必须回填，别当成已生效的收益）
- 两台都忙时的实际速率（预期 ~35/h；判据：`:8263 /history` 计数增长 **且** 汇总速率上升）；
- `pass` 率是否因新成员而下降（若下降 → 说明 :8263 的 `--cache-lru 2` 换模型代价过高，调低其 weight 或撤出）；
- transport/熔断类假 fail 是否回升（若回升 → 探针 TTL 10s 对饱和实例仍太短，应调 `TOIV_WORKER_PROBE_TTL_S`
  而不是降并发）。

## W8-21 机制定案（改写 W8-18 的「轮间重建」说法）+ 一个会静默浪费机时的行为（10-14 03:56 CST）

### ① W8-18 的**结论对、机制错**
W8-18 说「清单在轮间被重建，所以在跑的卡从新清单里消失」——**supervisor 不会重建清单**：
它每轮都用同一个固定文件（`rh_smoke_supervise.sh:24` `IDS=${ROUND_IDS:-…priority_complete.txt}`，
第 40-44 行只是把它拼进 `--ids-file`）。真相是**我自己在轮中手工重跑了一次生成器**：
- 17:34:29 batch 启动时，`priority_perworker.txt` 还含 `rh-acc-0015360002`（当时未测）→ 17:39:03 它 pass；
- 生成器 `rh_build_priority_list.py:79` 有 `if st: continue`（已测的不再占机时），
  所以我随后重跑生成器时它被剔除；两条 `running` 卡同理（清回空值后被重新纳入，我又手工追加了 2 行）；
- 于是**当前磁盘清单 ≠ 17:34 那个进程读到的清单**，`git log --follow` 只有「创建 + 我追加 2 行」两个提交，
  中间那次重生成**没有提交**，所以从版本历史里看不出来——这才是当时无法归因的真因。
结论不变：**那两条是在跑（in-flight），不是孤儿**；`reconcile_interrupted_smokes()` 战役期间不得手调（W8-18 的纪律仍然成立）。

### ② 会静默浪费机时的行为：清单不随进度收缩，且 batch 不看 smoke_status
`rh_smoke_batch.py` 走 `--ids-file` 时**不过滤已测状态**（只有走 `--kind/--status` 那条分支才过滤），
supervisor 又每轮复用同一个文件 → **一轮跑完再跑下一轮会把已测过的重跑一遍**。
本次实测规模：旧清单 7,361 条中已有 **213** 条测过（重生成后剩 **7,148**，sha256 前缀 `20de4539`）。
处置（已做）：重生成 untested-only 清单 + 重启 supervisor 指向它；
长期处置（未做，留给下轮）：给 batch 的 `--ids-file` 分支也加状态过滤，或让 supervisor 每轮先重生成清单。

### ③ 扩容后把并发从 2 抬到 3（两台实例后才有意义）
单实例时并发 2 只是排队（W8-20 实测等价并发 1）；现在池里有 `:8196`(GPU0) + `:8263`(GPU3) 两台，
supervisor 已按 `MAX_ROUNDS=12 ROUND_LIMIT=7200 ROUND_CONC=3 ROUND_IDS=<新清单>` 重启（PPID=1 脱离会话）。
当前在跑的那轮（并发 2、旧清单）不打断，自然结束后由新 supervisor 接手。
⚠️ **并发 3 的收益与副作用都还没实测**：要盯 `transport` 类假 fail 是否回升（探针 TTL 10s），
以及 `:8263` 的 `--cache-lru 2` 是否让它单条更慢（若是，把它的 weight 从 1.0 调低而不是撤出）。

## W8-22 一个静默打死 7 个应用的污染文件（已修）+ GPU3 扩容已在生产验证（10-14 04:10 CST）

### ① WD14 tagger 的模型文件是 HF 限流错误页（317 字节），不是模型
- 现象:7 条应用报 `[ONNXRuntimeError] : 7 : INVALID_PROTOBUF : Load model from /opt/ComfyUI/custom_nodes/ComfyUI-WD14-Tagger/models/wd-eva02-large-tagger-v3`，
  时间跨度 22:42→02:03，**与文件 mtime `Oct 13 22:42` 完全对齐** → 因果关系确凿。
- 真因:`wd-eva02-large-tagger-v3.onnx` 与 `.csv` 都是 **317 字节**，内容是
  `We had to rate limit you, you hit the quota of 100000 resolvers requests per 5 minutes period.`；
  即 `download_model()`（`wd14tagger.py:103-130`）把 HTTP 错误响应体当模型写盘且不校验。
  错误信息只指向 onnx 解析失败,**不指向限流**,按字面查会去怀疑 onnxruntime 版本/opset（错方向）。
- 修复:从 hf-mirror 重下（`SmilingWolf/wd-eva02-large-tagger-v3` 的 `model.onnx` 1,260,435,999B +
  `selected_tags.csv` 308,468B，12s 下完）→ **用舰队自己的 venv 验证可加载**（ort 1.28.0，
  `input ['batch_size',448,448,3]`，csv 10,862 行）→ 坏文件备份为 `*.bak-ratelimit-317B` → 就地替换。
  该包每次调用现建 `InferenceSession`（`wd14tagger.py:50-51`）、无全局缓存 → **不需要重启实例**（重要:
  烟测战役在跑，重启会污染测量，见 P-15/W8-20）。
- 复查同类污染:全 `/opt/ComfyUI` 扫 <20KB 的 `.onnx/.safetensors/.ckpt/.pth/.bin` 只有 3 个命中，
  另 2 个是真数据（`lpips/vgg.pth` 7,289B 真 pickle stub、`marigold_empty_prompt.safetensors`/`empty_embedding.safetensors` 本就是空提示嵌入）；
  NAS 两棵树（`toiv/comfyui-models`、旧 Windows 树）**零命中**。已入账 AGENTS **E-12**。
- 验证状态:7 条的定向重跑已起（`tmp/rh_smoke_20261013/onnx_fix_retest.txt`，`sha256=e3104e22`），
  **结果尚未落盘，本节不记收益**（P-12）。

### ② GPU3 扩容不是"理论上生效"，是**生产实证生效**
W8-20 把 `:8263` 加进池后，我一度按瞬时快照误判"没在分流"（`:8196 run=1 pend=6`、`:8263 run=0 pend=0`、GPU3 利用率 0%）。
拉长窗口后证据反转:`:8263 /history` 从 1 条涨到 **4 条，全部 `status=success`**，
且这些图里含 **`RH_LLMAPI_NODE` / `RH_Translator` / `CR SDXL Aspect Ratio` / `FluxKontextImageScale`** →
说明**我们的 RH shim 在 GPU3 上真的执行成功**（不只是 `object_info` 里有类名，P-16 的进阶版:执行期证据）。
- 能力对齐复核（全量 combo 名集合，不只计数）:模型名 `8196=3,850 / 8263=3,848`，
  差异只有 `1_txt2img.bin`、`1_txt2img (1).bin` 两个无关文件；类名差异只有 2 个 GuHai 类（W8-20）。
- 探针不是瓶颈:从 core 实测 `object_info` 8196=13.9s / 8263=15.4s，均 < `request_timeout=30s`；
  客户端侧 `_MODELS_TTL=120s`、`_QUEUE_TTL=2s`、`_NODES_TTL=600s`，故能力探测有缓存、不会每 pick 拉 30MB。
  （Redis 共享探测键 `toiv:worker-health:*` TTL 仅 20s，两边都查不到属正常，不是排障线索。）
- **教训（对我自己）**:判断"分流有没有生效"不能用一次 `queue`/`nvidia-smi` 快照——单条烟测 100~600s，
  两台机器各自的空闲窗口比采样间隔长得多。判据要用**累计量**（`/history` 条数增长）而不是瞬时量。

## W8-23 扩容后的真实速率（**实测翻倍**）+ 一个会把健康应用打成假 fail 的探测窗口（10-14 04:20 CST）

### ① 吞吐实测：18.3/h → **37.3/h**（不是推算，是同一口径前后对比）
| 区间 | 结果数 | 跨度 | 速率 | pass |
|---|---|---|---|---|
| 扩容前（单实例 :8196） | 389 | 21.22h | **18.3/h** | 170（44%） |
| 扩容后（:8196 + :8263） | 11 | 0.29h | **37.3/h** | 6（55%） |

后段样本只有 11 条、17 分钟，**pass 率差异不具统计意义**，速率翻倍与「两台各自跑一条重作业」的观测一致
（`:8263` 日志里在跑 QwenImage + QwenImageControlNet 的 RH 应用）。按 37.3/h 计，剩余 7,148 条 ≈ **192h**；
这只是把上限从 ~390h 砍半，**不是终点**——下一轮 supervisor 会用 `ROUND_CONC=3`，需再实测。

### ② 我自己的操作失误：把两个定向重测叠在战役上，一度让两台实例同时探测超时
`onnx_fix_retest`（7 条，conc 2）+ `seedvr_retest`（2 条，conc 2）叠在战役（conc 2）上 = **6 条并发打 2 台实例**，
结果两台的 `/queue` 都 20s 无响应（`http=000`）。**已把两个重测 kill 掉**（战役与 supervisor 未受影响，
`pgrep` 复核 batch=1 / supervisor=1），把机时还给主线。教训:**定向重测要排队等战役轮次边界，不能叠加**——
叠加不只是慢，它会触发下面的探测窗口，把健康应用写成 transport 假 fail，污染的正是我要测的东西。

### ③ 探测窗口:19.5GB 模型 staging 期间 `/queue` 会无响应 → 熔断/假 fail 的真机制
两台实例日志显示它们在干的是**装载巨模型**（不是卡死、不是 CPU 打满:GPU 利用率 0~2%、进程 CPU 10~38%）:
```
[INFO] Model QwenImage prepared for dynamic VRAM loading. 19483MB Staged. 720 patches attached.
[INFO] Model ZImageTEModel_ prepared for dynamic VRAM loading. 7671MB Staged.
```
ComfyUI 的 HTTP 服务与执行共用一个事件循环 → **staging 的几十秒内任何轻量端点都不响应**。
而 api 侧 `request_timeout=30s`、`_PROBE_TTL=10s`、熔断阈值 5 次失败 →
一次 19.5GB 的装载就足以让探测失败并累积到熔断，于是「所有 worker 均不可达(熔断中)」
（今日去重后 **4 个应用**）与「没有具备所需模型且可用的 worker」（**6 个应用**）里，
**至少一部分不是应用的问题，是探测窗口的问题**。这解释了先前「抬并发就出 transport 假 fail」的真机制:
不是并发本身，而是并发→更多 staging→更多探测落在无响应窗口。
- **建议（未执行，因为要重启 api，会打断战役）**：把探测改打更轻的端点或给 staging 期加宽限，
  或把 `TOIV_WORKER_PROBE_TTL_S` 抬高以减少探测次数；任何一项都要**单独改、单独测**，别和并发一起动（否则又是混杂变量）。

### ④ 两个失败簇的**去重**规模（先前按结果行数报的数偏大，已按应用去重）
今日 347 个去重应用里 187 个非 pass。Top 簇（按应用数）:
`poll exceeded 900s` **18** | 裸 `prompt_outputs_failed_validation` **15** | SeedVR 补默认值后仍失败 **10** |
`missing_node_type` **9** | WanVideo 权重拒换 **8** | llm-repair trial fail(空) **7** | ONNX 污染 **7**(已修待验) |
无可用 worker **6** | cusolver **5** | 熔断 **4**。
- SeedVR 簇的真因已定位:`input_noise_scale`/`latent_noise_scale` 在已装 SeedVR2 里是
  `["FLOAT",{"default":0.0,…}]`（**能补**，`_spec_default` 对 0.0 也没有 falsy 陷阱），
  而 `_union_objinfo` **只并 `_COMBO_LOADERS` 那几类**（`app_smoke.py:494-504`），
  所以 pick 之前那次 `combo_repair` 补不了非 loader 类的 widget；真正能补的是 `attempt==1` 分支里
  按类逐个 `client.object_info(ct)` 拼出来的 `objinfo_all`（`app_smoke.py:625-633`），
  而它**每个类的抓取失败都被 `except Exception: pass` 吞掉**（P-11 同型）——
  一次 staging 窗口里的探测超时就会让该类规格缺失，于是「补不上」被记成应用自己的 validation 失败。
  这是**下一个该修的点**（把抓取失败与"类不存在"区分开，失败时重试一次并在 detail 里标注 repair_incomplete，
  别让它伪装成应用缺陷）。本轮未改代码:改它要重启 api，且需要真机重测取证，不在本轮窗口内。
- WanVideo 簇（8 个应用）缺的是 `Wan22Animate/wan2.2_animate_14B_bf16.safetensors`：
  hf-mirror 上**没有这个单文件**（官方 `Wan-AI/Wan2.2-Animate-14B` 只有 4 分片 diffusers 权重；
  `Kijai/WanVideo_comfy` 只有 relight LoRA；NAS 里只有 18.4GB 的 fp8_e4m3fn_scaled_KJ）。
  所以要么做分片→单文件转换，要么让 `combo_repair` 在**同时改写耦合的 quantization 部件**的前提下允许精度替换
  （E-9 的正解，但错配会产出静默错误结果，按 E-10 原则宁可清晰失败）→ **列为待拍板**，不擅自改。

## W8-24 修掉「探测失败被吞成应用缺陷」并已部署验证（10-14 04:26 CST）

### 缺陷与实测证据
`run_app_smoke` 在两处（首跑失败后的确定性修复、LLM 修复阶段）都用同一形状拼 `objinfo_all`：
```python
for ct in {…class_type…}:
    try: objinfo_all.update(await client.object_info(ct) or {})
    except Exception: pass        # ← 抓取失败与"没这个类"不可区分
```
而 ComfyUI 的 HTTP 服务与执行**共用一个事件循环**，装载 19.5GB 级模型期间连轻量端点都不响应。
实测同一条 `/object_info/SeedVR2` 在 :8196 上连续三次：**35s 无响应(http=000) → 8.7s → 6ms**。
`request_timeout=30s` → 装载窗口内的抓取必然失败并被吞掉 → `combo_repair` 拿不到该类 required 规格 →
`SeedVR2.input_noise_scale`（已装版声明为 `["FLOAT",{"default":0.0,…}]`，**本来能补**）补不上 →
应用被记成自己的 `validation` 失败。这是 P-11「查询失败不得当成『没有』」的又一实例，
也解释了 W8-23 里 SeedVR 簇（去重 10 个应用）与部分裸 validation 簇（15 个）的来源。

### 修复（`1434ac26`）
- 新增 `_fetch_class_specs(client, graph, tries=2)`：逐类抓取，失败**重试一次**（跨过装载窗口），
  仍失败则把类名收集进 `failed` 返回，不再静默；
- 新增 `_spec_incomplete_note()`：把「哪些类的规格没取到」写进 `fixes`（会随 `[fixes: …]` 落进 smoke_error），
  措辞**刻意避开** `classify_failure` 的关键词（缺模型/缺节点/超时/required input is missing…），
  并有单测锁住「加上这条标注不得改变 cls」——否则标注自己就成了新的误判源；
- 两处调用点改用该 helper；`_union_objinfo` 未动（它只并 `_COMBO_LOADERS`，职责不同）。
- 测试：新增 `tests/test_spec_fetch_retry.py` 5 例（瞬时失败重试后规格存活 / 永久失败如实上报且不无限打实例 /
  重试后 `combo_repair` 真能把 falsy 默认值 0.0 补上 / 无规格时不许瞎补但要有标注 / 标注不改变分类）；
  smoke·combo·repair·pool·preflight·signature 全套 **168 passed**，零回归。

### 部署与「已加载」验证（不靠推断）
- `deploy/deploy.sh --skip-web core-jump` → `✅ 部署完成`，`/api/health` 200 / 60ms；
- **生产文件 md5 `df416ca7b71b` == 本地 md5**（逐字节一致）；`toiv-api ActiveEnterTimestamp=04:24:43`
  **晚于** rsync → 运行中的进程确实加载了修复（E-11/P-15 的两道必查）；
- 重启后池成员仍是两台且 healthy：`[('gpu0','http://127.0.0.1:8196',True), ('gpu3','http://127.0.0.1:8263',True)]`；
- 重启前在跑的 3 条卡（`rh-acc-0515276802-c50c75`/`0517640193-e367dd`/`9118878722-f9197e`）
  被**启动期** reconcile 清回未测（这是它的设计用途；与 W8-18「战役在跑时手调」是两回事）；
- 新轮 04:25:13 起，命令行实测 `--ids-file priority_perworker.txt --limit 7200 --concurrency 3`，
  日志首行即本次新加的指纹：`n=7148 sha256=20de453916c82951`（W8-18 当时缺的正是这一行）。

### 待观察（不预记收益）
- `repair_incomplete` 标注在真实结果里的出现频率（高 = 装载窗口确实是主要假 fail 源）；
- conc 3 + 双实例的条/h 与 pass 率（对照 W8-23 的 37.3/h）；
- SeedVR 簇 10 个应用需在**战役轮次边界**单独重测（不要叠加，见 W8-23 的失误），
  ids 可由 `grep 'SeedVR' smoke_all_*.jsonl` 取；ONNX 簇 7 个同理（`tmp/rh_smoke_20261013/onnx_fix_retest.txt`）。

## W8-25 「重测已验证应用」的两笔实证损害 + 清单过期过滤（10-14 04:40 CST）

W8-21 ② 只是推断"会浪费机时"，现在有了**数据**，而且损害比浪费更严重:

1. **pass 被覆盖成 timeout，且留下矛盾态**:`rh-acc-9223577602-cac65a` 现在 `is_public=true` 而
   `smoke_status=timeout`（另有 `rh-acc-1140571137-020af3`、`rh-acc-9794049026-917e92` 同样 pass→timeout）。
   即"重测一次失败"会把一条已验证可用、且已挂在市场上的应用打成 timeout——**市场质量被自己的重测拉低**。
2. **刚 pass 的应用立刻被下一轮重测**:今日 jsonl 里 163 个去重 pass 中，有 3 个
   （`0503191553`/`0512444416`/`0514882562`）此刻 PG 状态是 `running`——因为新清单是 03:56 生成的，
   而它们在 04:08~04:21 才 pass，**清单快照比库内状态旧**，于是新轮把它们又跑了一遍
   （每条 300~800s 机时白烧，且若期间 api 重启就会卡在 `running`）。

### 修复:`rh_smoke_batch.py` 走 `--ids-file` 时也按**当前库内状态**过滤（默认开启）
- 新增 `_status_map(tok)`:分页拉 `/api/apps?limit=1000&offset=`，**任何一页失败即 raise**（P-11:
  分页失败绝不能当成"库里没有"，否则过滤形同失效）；
- 新增 `--allow-retest`:确实要重测时显式打开；
- 生产实测（不是纸面）:库内已测 **2,930**（pass 2026 / timeout 239 / fail 662 / running 3，与 PG 一致），
  当前 7,148 条清单里命中已测 **6** 条 → 过滤后 **7,142**，样例含上面那 3 条 `running`。
- 已知口径缺口（**方向安全**）:`/api/apps` 即便 admin token 也只返回 **14,181/14,304**（123 条不可见，
  疑为内容形态过滤）。这 123 条不会被过滤掉 → 最多"多测几条"，不会"漏测"，故不改判据。

### 仍待办（未做，需在轮次边界做，别叠加——W8-23 的教训）
- SeedVR 簇 10 条、ONNX 簇 7 条（`tmp/rh_smoke_20261013/onnx_fix_retest.txt`）的定向重测:
  这两簇的根因（规格抓取被吞 / 模型文件是限流错误页）都已修，**但修复效果尚未用真跑取证**，不预记收益；
- `rh-acc-9223577602-cac65a` 的矛盾态（public 且 timeout）:重测一次即可归位，属上面那批一起做。
