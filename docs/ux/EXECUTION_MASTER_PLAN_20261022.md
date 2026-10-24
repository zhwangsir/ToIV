> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# ToIV 总执行方案 2026-10-22

> **日期**：2026-10-22（Asia/Shanghai）  
> **分支**：`work/p0-fusion-20261016` · tip `e5307c63`  
> **状态**：通读合成稿；**仅文档**——确认拍板前 **不开业务编码、不 commit、不 push、不部署、不下载权重、不重启服务**  
> **读者**：拍板人先读 §0 + §2；执行人再读 §3–§7  
> **合成源**：COMPETITIVE（§0 D1–D8、§9、§12–§13）· AUDIT_MASTER（N1–N10 / Dly）· ENGINEERING_CARDS · IA_INTERACTION_SPEC · DEEP_DELTA+Wave M · MODEL_FRESHNESS_BASELINE · TOIV_LOCAL_AI_CAPABILITY_MAP

---

## 0. 一页决策摘要（给拍板人）

**一句话判断：** ToIV 近窗不是换栈，而是「默认入口 / 契约 / 文档 / 权重世代」对齐——**短剧阶段轨默认 + 可选双视图投影 + 自由画布专家层**；本地算力与声画主链（H3:8264 / IndexTTS:9200 / tip 已默认 ref2va）**KEEP**，只修漂移。

**行业与审计同向：** 竞品主矩阵仍支持阶段默认成片（火宝 / Jellyfish / LingGuo / printfilm…）；全栈审计 KEEP≈71 ≫ REPLACE≈13 → 债在默认值与入口语义，不在缺能力。

**推荐拍板包（全部勾选即可开干）：**

| 包 | 推荐项 |
|----|--------|
| UX 主壳 | **D1-A** · **D2-A** · **D3-A** · **D4-C** |
| 本地 AI | **D5-A** · **D6-A** · **D7-A** · **D8-A** |

即：阶段轨默认；P3 列表↔流水线/看板投影同源；工具台与短剧拆权；P2 只做站内合成（导出放 P4）；导演=人手阶段+显式剧组开关；声画进 P2；文档承认 tip=ref2va；首页旁路「雨夜示例」。

**近窗两轨并行（冲突时壳层感知优先）：**

```
轨 A · 壳层（N / P）                    轨 B · 权重（Wave M）
N9∥N6∥N8 文档 → N1→N2 默认             M0 账本 → M1 smoke（盘上 v18）
→ P1 壳（N3∥N4∥N10 + IA P1 + 雨夜）     → 确认后 M1 下 v23 / M2 Wan
→ P2 轨（N7 + 声画/门禁/管线选择器）    → M3 真机核验（升级须维护窗）
→ P3 节点感（N5 + 双视图/检视器）       → M4 H3 实验可选（永不替生产 int8）
```

**硬纪律（本文件生效期内）：**

- **确认拍板前不开编码窗**；默认 **不 commit / 不 push / 不部署**。  
- **安全换密 / alembic 切流 / DRT 关停 / 微服务** → 暂缓（MASTER Dly1–Dly5）。  
- 大下载与换 gate **须用户明示**；IndexTTS **不停**；H3 默认指向 **:8264** 但 **不误换** 生产 pruned_int8。

**粗工期量级（拍板后）：** Doc+Default ≈1.5–3 人天；P1 ≈3–5；P2 ≈5–8；P3 ≈6–10；Wave M 运维窗另计（确认门）。合计壳层推荐包约 **14–23 人天**（与 COMPETITIVE §9.1 一致）。

---

## 1. 已交付材料地图（路径表）

| 件 | 路径 | 通读用途 |
|----|------|----------|
| **竞品 + UX 总方案** | `docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md` | §0 决策摘要；§9 P1–P4；§12 D5–D8 / L1–L6；§13 审计指针；**§14→本文** |
| **审计 MASTER** | `docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md` | N1–N10；OPTIMIZE 波次；KEEP；Dly1–12；不做 |
| **能力地图** | `docs/ux/research/TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md` | 10 维 tip 实况；与 UX 咬合依据 |
| **工程卡 N1–N10** | `docs/ux/research/ENGINEERING_CARDS_N1_N10_20261022.md` | 文件触点 / 测点 / 开工序 / 附录 C 不确定项 |
| **IA 交互规格 P1–P3** | `docs/ux/research/IA_INTERACTION_SPEC_P1_P3_20261022.md` | 逐屏文案 / 状态机 / 同源字段 / 工程切片 P1-a…P3-b |
| **竞品 Δ + Wave M** | `docs/ux/research/DEEP_DELTA_COMPETITIVE_AND_WAVE_M_20261022.md` | 5 条增量仓；M0–M4；与壳层错峰 |
| **模型保鲜基线** | `docs/ops/MODEL_FRESHNESS_BASELINE_20261022.md` | 账本 825；P0=出图 gate v11→上游 v23 |
| **本总执行方案** | `docs/ux/EXECUTION_MASTER_PLAN_20261022.md` | **通读执行入口**（本文） |

分册（按需深潜，非必通读）：`docs/ux/research/AUDIT_{A,B,C,D}_*_20261022.md`。

---

## 2. 推荐拍板包（可勾选）

| 决策 | 推荐 | 备选 | 若不选推荐的代价 |
|------|------|------|------------------|
| **D1** 默认主壳 | **A** 阶段轨默认；流水线可选；自由画布专家 | B 进门画布 / C 纯阶段无投影 | B：学习转化差、回归面大；C：丢「节点感」诉求 |
| **D2** 流水线画布时机 | **A** P3 列表↔投影同源（可含看板轻量档） | B 仅独立流程入口 / C 短剧无第二视图 | B/C：节点感只能堆在自由画布，易回 G5/G6 |
| **D3** 工具台 vs 短剧 | **A** LumenX 式 Studio / Playground 拆权 | B 市场与首页同权 | 入口镜像（G1）难消；端口易再外露 |
| **D4** 导出优先级 | **C** P2 站内合成；剪映/FCPXML→P4 | A 仅预览叙事 / B 并行剪映 | B 抢 P2 工期；拷 AGPL/GPL 风险↑ |
| **D5** 导演默认 | **A** 人手阶段；剧组=显式开关；三点人闸 | B 进门 Agent 自动 / C 暂缓入口 | B 与学习站可控冲突；C 浪费已有 agent_team |
| **D6** 声画进 P2 | **A** 配音→口型→合成进主轨 | B 整包放 P4 / C 口型可跳过 | B 与产品方案/IndexTTS KEEP 矛盾；成片无声 |
| **D7** Ref2VA 对齐 | **A** 改产品 md；生产核对 tip；UI 暴露管线 | B 另立「切默认」工程卡 | 代理按假债开工；与 tip 单测对立 |
| **D8** 学习示例 | **A** P1 首页「雨夜示例」CTA | B 仅文档/DOGFOOD | 学员无最小闭环入口 |

**一键回复模板：**「全部按推荐包 D1–D8 A/A/A/C + A/A/A/A」。

**与 MASTER 咬合（记一句即可）：** D1↔N3/N4；D2↔P3 投影；D3↔N5/N10；D4↔assemble 不抢导出；D6↔N7+IndexTTS KEEP；D7↔N6/N1；D8↔P1 雨夜。

---

## 3. 执行路线图（时间盒，人天粗估）

> 人天为 **单人等价粗估**；可并行处已标 ∥。确认拍板后才进入 3.1+ 的编码/运维窗。

### 3.0 拍板窗（0 编码）｜0 人天

| | |
|--|--|
| **目标** | 确认 §2 拍板包；冻结不做清单与 Dly |
| **入口文档** | 本文 §0–§2；COMPETITIVE §0 / §10.3 / §12.4；IA §8 |
| **主要验收** | 用户书面确认（可「全部按推荐包」）；执行人知两轨并行与确认门 |
| **不做** | 任何业务码、commit、push、部署、下载、重启 |

### 3.1 Wave Doc（N9 ∥ N6 ∥ N8）｜约 0.5–1 人天

| | |
|--|--|
| **目标** | 文档真源纠偏，禁止盲抄旧端口 / 假「切 Ref2VA」立项 |
| **入口文档** | ENGINEERING N6 / N8 / N9；MASTER §3.4 文档债专队 |
| **主要验收** | `SERVICE_INVENTORY` 文首过期横幅 + 10-15 勘误（8264 / TTS9200 / VLM9311）；`AI短剧产品方案.md` §8 承认 tip=ref2va；Drama∥Studio「新功能只加 Studio」纪律卡亮起 |
| **不做** | 拆 Drama 大包；改生产进程；部署 |

### 3.2 Wave Default（N1 → N2）｜约 1–2 人天

| | |
|--|--|
| **目标** | 新环境默认指向正确世界：H3 **:8264**；fleet 分母对齐 AGENTS §三 |
| **入口文档** | ENGINEERING N1 → N2；能力地图 §0.3 端口表 |
| **主要验收** | config / `.env.example` 禁写「生产=8195」；`fleet_registry` + `test_fleet` 同步；Admin 在线率分母可信；可留 legacy 白名单 |
| **不做** | 未真机确认前误删 CosyVoice/ASR 探针（工程卡附录 C）；换 H3 权重文件本身 |

### 3.3 Wave P1 壳（N3 ∥ N4 ∥ N10 + IA P1 + 雨夜）｜约 3–5 人天

| | |
|--|--|
| **目标** | 进门语义=短剧；任务中心只读回跳；去端口；状态中文；雨夜 CTA |
| **入口文档** | IA §2（P1-a…P1-d）；ENGINEERING N3/N4/N10；COMPETITIVE §9 P1；MASTER §3.1 |
| **主要验收** | 主 CTA「新建短剧」+ 最近短剧；侧栏一词一义（短剧→任务→工具台→画布可折→设置）；`/toiv/tasks` 深链通；Create 迁出 agent；LocalBadges 无端口；drama 状态中文；G1/G2/G4/G10 清；D8-A 雨夜可点；L5 依赖三态空态可用 |
| **不做** | 新画布；改 Comfy 端口号；关 TTS；小程序重做阶段轨；P1 塞剪映 |

### 3.4 Wave P2 轨（N7 + IA P2 声画 / 门禁 / 管线选择器）｜约 5–8 人天

| | |
|--|--|
| **目标** | 阶段轨 prepared≠generating；配音→口型→合成；定妆门禁；站内合成；无台词可越过 voice |
| **入口文档** | IA §3（P2-a…P2-d）；ENGINEERING N7；MASTER §3.2；COMPETITIVE §9 P2；§12 L3/L4 |
| **主要验收** | 纯画面项目进度可到 assemble；无定妆禁批量视频；人闸三点文案可见；UI 管线默认 ref2va（c / c_hybrid 专家）；seam=continue 标明「续写=管线 C」；主路径无「正在开发」死钮；任务可回跳 ws section；站内成片可预览（D4-C） |
| **不做** | 竖排/看板投影（留给 P3）；剪映/FCPXML；默认改回 `c`；进门自由画布；**停 :9200** |

### 3.5 Wave P3 节点感（N5 + 双视图 / 检视器；可选看板）｜约 6–10 人天

| | |
|--|--|
| **目标** | 受控节点感：列表↔流水线（或看板）同源；添加菜单创作语义；右侧检视器 |
| **入口文档** | IA §4（P3-a/b）；ENGINEERING N5；Δ §3.1/3.3；COMPETITIVE §9 P3 |
| **主要验收** | 产品面无「本地·H3/Wan…」作节点类型（模型进节点设置）；双视图业务单源、无双写；参数不盖节点（G5）；检视器可见 pipeline / refs / 音色 / 门禁；可选「看板按进度分列」作为竖排等价轻量档（AIComicBuilder） |
| **不做** | Toonflow 进门壳；xyflow 重写整个 `/toiv/ws`；GPL/AGPL 并码；把添加菜单重新变引擎目录 |

### 3.6 Wave M 并行（M0 → M1 → …；确认后才下载）｜运维窗另计

| | |
|--|--|
| **目标** | 权重世代对齐；最大收益=出图 gate 脱离过时 SFW-**v11**（上游 **v23**，盘上已有 **v18**） |
| **入口文档** | Δ §4；保鲜基线 §3–§5（扫描 2026-10-22 00:55 Asia/Shanghai；账本 825 条） |
| **步骤摘要** | **M0** 账本补录生产 H3 int8 basename（0GB）→ **M1** 盘上 v18 smoke → **用户确认后**下 v23（≈28.4GB）双轨再改 gate → **M2** Wan Mega-v11 旁路（≈24GB）→ **M3** IndexTTS 真机核验（升级仅维护窗）→ **M4** H3 实验可选（Acc-8Step 等，**永不**替 :8264 默认 int8） |
| **主要验收** | ledger 精确命中生产 basename；SFW 卡/编辑流回归；live gate 指向约定版本；:9200 抽检（若升级）；生产默认仍 pruned_int8 |
| **不做** | 无确认 aria2c / 自动改 gate；强制换 H3/VLM；全量扫 Civitai NSFW；追 blocked/provenance_lost；借 Wave M 关 IndexTTS 或重启无关服务 |

### 3.7 P4 / Dly 延后清单（指针即可）

- **P4 切片**（各约 2–6 人天，按需点菜）：关键帧默认加强、失败码人话、控片就绪灯、Agent 一键（=打开 D5 剧组模式，复用已有 graph）、剪映草稿 / FCPXML / 工程包、BGM 声床、KPI 北向看板。详见 COMPETITIVE §9 P4；导出许可红线见 Δ §3.5（AGPL/GPL **只学不拷**）。  
- **Dly1–Dly12**（MASTER §5）：生产换密+重启、git filter-repo、alembic 切流、DRT 关停、微服务拆分、SaaS 换实现、#13 假 timeout 改码、全库 IDOR fuzzer、OpenClaw 网关 LLM 替换、H3 原生音画一体换默认、Playwright 搬回 CI、legacy unit 物理清理——**明确不抢感知窗**。

---

## 4. 依赖与冲突仲裁

| 规则 | 说明 |
|------|------|
| **壳层感知优先** | 同一「验收小时」：先保 P1/P2 发版可测；大下载 / 换 gate 错峰到低峰 |
| **大下载错峰** | M1② / M2 放低峰；冲突时优先 **M0 + M1①**（零下载） |
| **IndexTTS KEEP** | P2 / N7 / D6 进行中 **禁止**停 :9200；M3 升级必须独立维护窗 + 用户明示 |
| **H3 默认 :8264** | N1 改基址文案/配置；**禁止**把 M4 实验权重写成 live 默认；生产 int8 与上游同档 → 不强制升级 |
| **文档先于假债** | N6/N9 未亮前，禁止开「切 Ref2VA 默认」代码卡 |
| **N 开工序** | Doc(N9∥N6∥N8) → Default(N1→N2) → P1(N3∥N4∥N10) → P2(N7) → P3(N5)；N8 纪律全程可亮（ENGINEERING 附录 B） |
| **双视图单源** | 业务状态只在 Studio（及兼容 Drama 读）真源；投影只读 layout metadata |
| **IA 切片依赖** | P1-a 依赖 D1-A+D8-A；P2-c 依赖 D6-A；P2-d 依赖 D7-A+D4-C；P3-a 依赖 D2-A（IA §7） |

---

## 5. 竞品范式巩固（一小节）

**范式未翻盘。** 加深轮仍支持：学习站默认 = **A 阶段轨**；节点感 = **E 投影 / 双视图**；**C 无限画布仅专家层**。推荐拍板包无需因新仓改选。

| 增量仓（Δ §2） | 可借鉴一句 |
|---------------|------------|
| LingyiChen-AI/AIComicBuilder | 分镜 **列表↔看板**（按生成进度分列）比自由 xyflow 更低成本 |
| UllrAI/CineGen-ShortDrama | **首尾帧栅格**属分镜准备页，不是画布首页；许可限制商用拷贝 |
| Sundykin/KomaBuild（Koma） | 站内多轨 + 剪映草稿可并存；Comfy 放 Provider；**GPL-3.0 禁并码** |
| EvoLinkAI/ai-short-drama | 配音+口型进主链 → 加固 D6-A / N7 |
| hyyyyyyz/dramai | 剪映 ZIP+SRT 仅作 **P4 旁路**；刷新丢任务=任务中心必须可恢复的反证 |

主矩阵 23 行与完整论证仍以 COMPETITIVE §3–§8 为准；waoowaoo 已纠偏为画布+Assistant（非工业短剧阶段台）。

---

## 6. 风险 / 不做 / 不确定待核

### 6.1 合并不做（近窗 + 推荐包）

来源合并：COMPETITIVE §10.2 / §12.6 · MASTER §6 · IA §6.1 · Δ §4.3 · 保鲜基线 §0。

- 整仓 Toonflow / TapCanvas / waoowaoo 化；ComfyUI 当学习默认 UI；第二套计费/MQ 企业后台。  
- 关 IndexTTS；把 tip 已落地的 Ref2VA 再立「P0 切默认」；默认管线改回 `c`；删 Motion Context / c_hybrid 代码。  
- 拷 AGPL / NC / GPL 代码或资源进仓；P2 做剪映/NLE；P1 上新画布；P1–P3 重做小程序原生阶段轨。  
- 近窗换密 / alembic 切流 / DRT 关停 / 微服务；盲抄 `SERVICE_INVENTORY` 09-13 端口。  
- 无确认自动下载或改 gate；强制换 H3 生产 int8 / VLM BF16；全量扫 Civitai NSFW；添加菜单继续当引擎目录。  
- 仅因改了 Tabs 就宣称「本地 AI 驱动已完成」。

### 6.2 主要风险与缓解

| 风险 | 缓解 |
|------|------|
| 首页+短剧+画布同改回归面大 | 严格 P1→P2→P3 切片发版 |
| 六段路由 vs 七阶段叙事迷路 | KEEP `section` 键；只改标签/子轨；旧链兼容 |
| 双视图双写 | 业务单源；layout 仅 metadata（IA §4） |
| 无台词 next_step 假卡 | N7 + UI「无对白已跳过」同验收 |
| 「全面画布化」诱惑 | D1-A 写死；节点感边界 IA §4.1 |
| 文档滞后诱导假开工 | Wave Doc 先行（N6/N9） |
| 大下载拖垮感知验收 | §4 错峰；确认门 |

### 6.3 不确定待核（ENGINEERING 附录 C 摘要）

1. CosyVoice 9201–9203 / ASR 9210：改 registry 前真机确认是否仍进分母。  
2. H3 默认写 LAN `192.168.71.127` 还是 TS `100.68.100.90`：与现网 core `.env` 统一。  
3. 「一键空白 Studio」是否要标题对话框（与 IA 统一）。  
4. 无台词全 `rendered` 时 next_step 用 `assemble` 还是 `done`。  
5. N5 收拢后默认视频引擎绑 H3（推荐）还是出图池。  
6. 生产进程是否已跑 tip 默认 ref2va（N6 只改文档；部署核对另窗，本纪律禁部署）。

---

## 7. 拍板后第一周建议日计划（示意 5 天，可调）

> 假设：用户已确认推荐包。示意默认 **可本地改文件**；**不 push、不部署**；是否本地 commit 另听用户当窗指示。

| 日 | 壳层轨 | 权重轨（错峰） |
|----|--------|----------------|
| **D1** | Wave Doc：N9 横幅 + N6 产品 md + N8 纪律卡 | M0 账本补录（0GB）；起草 M1① v18 smoke 清单 |
| **D2** | N1 默认 :8264 文案/配置；启动 N2 registry 改写+测 | 执行 M1① smoke（**不改** live gate） |
| **D3** | N2 测绿；开 P1-a/b（首页 CTA + 侧栏收权/改名） | 若 smoke 过 → **请示用户**是否启动 M1② 下 v23 |
| **D4** | P1-c/d（任务 Create、深链、去端口、状态中文）+ 雨夜 CTA + L5 空态 | 低峰下载或继续旁路评测；**禁止**碰 :9200 |
| **D5** | P1 验收清单勾选；N7 单测草稿；对照 IA §3 开 P2-a 状态机文案 | M3 **只读**真机核验；大包未完成则顺延；准备 P2 周一切入 |

**周成功标准（示意）：** Doc+Default 可演示或已落地；P1 主路径可 dogfood；Wave M 至少完成 M0 + M1①；无未经确认的下载 / 重启 / push。

---

## 7.1 北向成功信号（跨波次，编码后才量）

| 信号 | 说明 |
|------|------|
| 进门不落自由画布 | P1 后学习路径主 CTA→短剧；不进画布可走完最小闭环（P2） |
| 声画不断链 | 有台词：配音→口型→合成；无台词：可越过 voice（N7）且 :9200 仍在 |
| 默认世界正确 | 新环境 H3→:8264；文档/UI 承认 ref2va；出图 gate 脱离过时 v11（Wave M 确认后） |
| 节点感不翻车 | P3 投影同源；添加菜单无引擎名作类型；参数不盖画布 |

（KPI 看板本体属 P4；此处只作验收方向，不单独立项。）


## 8. 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初版合成：聚合 COMPETITIVE / MASTER / 工程卡 / IA / Δ+WaveM / 保鲜基线 / 能力地图；通读优先总执行入口；确认前 0 编码 |

---

**下一步（给用户）：** 通读本文 **§0 + §2**（必要时扫 §3.0–§3.3），回复是否采纳推荐拍板包（或逐项改选 D1–D8）。确认后从 **§3.1 Wave Doc** 开工；权重轨按 §3.6 并行且 **每步确认**。
