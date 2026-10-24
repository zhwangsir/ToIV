> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行集群真源 → [`docs/ops/CLUSTER_TRUTH.md`](../../ops/CLUSTER_TRUTH.md)。命名铁律：一个权重一个 id；served 不得伪装异家族。

# ToIV 加深稿 · 竞品补洞 Δ + Wave M（模型保鲜）

> **日期**：2026-10-22（Asia/Shanghai）  
> **状态**：只读调研 + 方案文档；**禁止**编码 / commit / push / 下载权重 / 重启服务  
> **上游**：`docs/ux/COMPETITIVE_RESEARCH_AND_UX_PLAN_20261022.md`（以下简称 COMPETITIVE）  
> **保鲜基线**：`docs/ops/MODEL_FRESHNESS_BASELINE_20261022.md`（扫描 00:55 Asia/Shanghai）  
> **执行咬合**：`docs/ux/research/AUDIT_MASTER_KEEP_OPTIMIZE_REPLACE_20261022.md`（N1–N10 / P1–P3 / Dly）  
> **方法**：GitHub `search_repositories` + README/API 实读；Exa `web_search_exa` 本轮 **HTTP 429**，已降级 WebSearch / raw README / GitHub API。Stars/活跃以 2026-10-22 实查为准。

---

## 0. 一页结论（通读优先）

### A · 竞品补洞

| 判断 | 说明 |
|------|------|
| **范式结论未翻盘** | 仍推荐：默认 **A 阶段轨** + 可选 **E 双视图投影** + **C 仅专家层**。本轮无证据支持「进门即无限画布」改作学习站默认。 |
| **主矩阵遗漏（产品级）** | **5 条**须记入加深档（见 §2）：AIComicBuilder、CineGen、Koma Studio、AIDrama Studio、dramai。 |
| **无增量区** | hongguo 播放器、纯 Skill 包、inkos 小说 Agent、Books 噪声仓 → **不进主 UX 权重**（与 COMPETITIVE §2.2 / 附录纪律一致）。 |
| **可借鉴加深点** | ① 分镜 **列表↔看板**（非自由图）；② **首尾帧栅格导演台**；③ **站内多轨+剪映**一体；④ **配音外置剪映**的轻交付；⑤ 角色 **四视图**门禁。 |

### B · Wave M（模型保鲜）

| 判断 | 说明 |
|------|------|
| **与 UX 近窗并行、不抢壳** | Wave M = 算力/权重轨；**不改**首页 CTA、添加菜单、阶段轨产品语义（那些仍是 N3–N5 / P1–P3）。 |
| **最大收益** | 出图 gate 仍钉 SFW-**v11**，上游已至 **v23**，盘上已有 **v18** → **M1 优先**。 |
| **纪律** | 每步须 **用户确认** 才下载/改 gate/动 :9200；本文件只给触发条件与顺序。 |
| **H3 生产** | pruned_int8 与上游同名同字节 → **不进强制升级**；M0 只补账本；M4 仅实验双轨。 |

### 与 MASTER 咬合（一句话）

```
N1–N10 / P1–P3          Wave M
壳层默认指向正确世界  ‖  权重默认指向正确世代
（前端/文档/registry） ‖  （ledger / 双轨 / 服务窗）
二者并行；冲突时 壳层感知窗优先，权重仅在维护窗换 gate。
```

---

## 1. 本轮检索范围与「无增量」声明

### 1.1 已覆盖（COMPETITIVE 主表 1–23，本轮不重贴档案）

Toonflow · 火宝 · waoowaoo（已纠偏）· Jellyfish · dramaclaw · printfilm · ArcReel · BigBanana · LocalMiniDrama · ai_story · director_ai · 融光 · LingGuo · LumenX · AID · TypeTale · wind-comic · TapCanvas · AI-Canvas-tauri · Openframe · Dralo · 剧流 Studio · comfyui-auto-drama。

### 1.2 本轮查询（摘要）

- GitHub：`AI短剧|AI漫剧|short-drama|micro-drama`、`短剧 stars:>100`、剪映/CapCut/novel-to-video 等。  
- WebSearch：LocalMiniDrama 替代、双视图+剪映导出。  
- Exa：429 → 未用结果。

### 1.3 明确「无增量 / 不进主矩阵」

| 类 | 例 | 理由 |
|----|----|------|
| 播放器/客户端 | hongguo-*、fqapp、guoapp | COMPETITIVE 已排除 |
| Skill / 提示词包 | shuohao-skills、drama-skills、manju-laoli-skill、0xsline/short-drama、awesome-short-drama-skills、Seedance2-Storyboard-Generator | 附录级；非产品壳 |
| 小说/IP Agent | Narcooo/inkos（~10k★） | 故事创作 Agent，非短剧阶段台/双视图工作台 |
| 噪声高星 | Some-Many-Books 等 | 与短剧 UX 无关 |
| 已有仓 fork | soitun/LocalMiniDrama 等 | 同源，不重复计 |

**结论：** 主范式与推荐拍板包（D1-A+D2-A+D3-A+D4-C）**无重大新证据推翻**；增量集中在 **5 条产品仓 + 模式加深**，而非新范式 F。

---

## 2. 竞品增量档案（仅补洞，5 条）

> 维度对齐 COMPETITIVE §2.3，但只写「相对主档案的新信息 / 可抄模式」，避免整段复述已有结论。

### 2.1 LingyiChen-AI/AIComicBuilder — ★≈1923 · Apache-2.0 · pushed 2026-04（星仍活跃更新于 2026-10-21）

| 维 | 要点 |
|----|------|
| 定位 | 漫剧生成器：剧本→四视图→分镜→首尾帧→视频→合成字幕 |
| 主路径 | **阶段流水线**；每阶段可单触/批量；分镜版本可对比 |
| IA **增量** | 分镜页 **列表视图 + 看板视图**（按生成进度分列）+ 编辑抽屉；**非** xyflow 自由图 |
| 资产 | 角色四视图（正/¾/侧/背）；跨集复用 |
| 声画 | Dialogue 模型有对白/音频字段；合成支持字幕烧录 |
| 导出 | 成片下载 + 素材打包；未见剪映草稿主推 |
| 栈 | Next.js 16 · SQLite/Drizzle · FFmpeg · 多供应商（含 Seedance） |
| **对 ToIV** | ✅ **看板=阶段进度投影**（可并入 P3「流水线视图」的轻量形态，比竖排节点更低成本）；✅ 四视图与 ToIV 设定卡门禁同向；❌ 勿抄「进门即全自动漫剧」掩盖就绪确认 |

### 2.2 UllrAI/CineGen-ShortDrama — ★≈558 · ACL v1.0（自定义，商用有条件）· pushed 2026-09-25

| 维 | 要点 |
|----|------|
| 定位 | 浏览器漫剧/动态漫/短剧导演台；Gemini + Veo |
| 主路径 | 剧本/分镜 → 角色场景参考 → **导演工作台（镜头栅格 + 首尾关键帧）** → 预览与完成态 |
| IA **增量** | **Shot grid + start/end keyframe** 为默认导演面；本地 IndexedDB；Phase 01 起项 |
| 节点 | 无无限画布叙事；控制感来自关键帧而非节点库 |
| 许可 | **AniKuku Community License** → 学习可看 UX，**禁止未审商用拷贝** |
| **对 ToIV** | ✅ 强化 COMPETITIVE「关键帧默认」与 BigBanana/LMD：P2 分镜准备应露出首/尾帧栅格；✅ 完成态预览与 Jellyfish ready 同族；❌ 许可与 Gemini 绑定勿当默认栈 |

### 2.3 Sundykin/KomaBuild（Koma Studio）— ★≈28；活跃 fork M-JYuan/Koma ★≈99 · **GPL-3.0** · Electron 桌面

| 维 | 要点 |
|----|------|
| 定位 | 本地桌面：剧本/资产/分镜/图视频/TTS/**多轨时间轴**/导出一体 |
| 导出 **增量** | FFmpeg（MP4/WebM/GIF）+ **一键剪映草稿**；另有灵绘节点台、3D 导演台（专家层） |
| Provider | LLM/TTI/TTS/ITV；**含 ComfyUI** — 与 ToIV 本地舰队心智接近 |
| 任务 | `TaskStatusBar` / TaskManager — 轻量任务条模式 |
| **对 ToIV** | ✅ P4 导出：剪映草稿应与站内合成并列（ArcReel 已提，Koma 证明桌面+多轨也可做）；✅ ComfyUI Provider 说明「模型在设置、创作面不挂引擎名」；❌ **GPL-3.0 禁并码**；多轨 NLE 勿抢 P2 工期（MASTER D4-C = 站内合成先） |

### 2.4 EvoLinkAI/ai-short-drama（AIDrama Studio）— ★≈60 · 自述 MIT（API license=Other 须再核）· Docker

| 维 | 要点 |
|----|------|
| 定位 | 小说→短剧视频全自动：分析→角色一致图→分镜→视频→**配音→口型**→成片 |
| 声画 **增量** | README 明确 **voiceover + lip-sync** 进主链（与 ToIV IndexTTS+pad lipsync 同构） |
| IA | 阶段自动化台；云 API 聚合（Kling/Seedance/FLUX/Veo…） |
| **对 ToIV** | ✅ 印证 D6-A / P2「配音必须进主路径」；✅ Docker 一键适合对照「学习站最小闭环」；❌ 云 Key 聚合非本地算力路线；许可 SPDX 未干净 → 只学产品叙事 |

### 2.5 hyyyyyyz/dramai — ★≈39 · Apache-2.0 · 纯前端 / GitHub Pages

| 维 | 要点 |
|----|------|
| 定位 | 浏览器零后端：素材→分镜→图→视频→合成 → **剪映 ZIP + SRT** |
| 声画 **增量** | **站内不生成旁白**；交付 SRT，在剪映用「文本朗读」对齐 — 轻交付反模式 |
| 任务 | v0.4 **刷新会丢进行中任务**（v0.5 才规划恢复）→ 反面教材：任务中心必须可恢复 |
| Pipeline | 显式参考 ai_story 责任链，浏览器内重写 |
| **对 ToIV** | ✅ P4 可提供「剪映 ZIP+SRT」作为**可选旁路**（用户无 TTS 窗时）；❌ **不可**把「配音甩给剪映」当学习站默认（ToIV 已有 IndexTTS，MASTER 明确 KEEP）；✅ 任务不可恢复 = G3/P2 回跳与 cancel/recovery 的反证 |

### 2.6 增量条数汇总

| 口径 | 数 |
|------|----|
| **产品级新仓（须记入加深）** | **5** |
| 其中高相关度（直接影响 P2–P4 模式） | 5（上表全部） |
| 附录/噪声新发现但不进主 UX | ≥6（skills、inkos、hongguo 等） |
| **推翻 COMPETITIVE §0 范式？** | **否** |

---

## 3. 五模式加深（相对 COMPETITIVE §6，只写增量）

> 不重复粘贴「左轨 / prepared≠generating / 双视图同源」原文；下列是本轮新证据如何**加厚**落地规格。

### 3.1 阶段轨（Phase / 左轨 / Tabs）

| 加深 | 证据 | ToIV 落点 |
|------|------|-----------|
| 导演台可做成 **镜头栅格+关键帧**，仍属阶段「分镜准备」，不是画布首页 | CineGen | P2.1：分镜准备页默认栅格；自由画布仍专家 |
| 看板按 **生成进度分列** = 阶段态的第二种投影 | AIComicBuilder | P3 可选「看板视图」与竖排流水线二选一或并存，数据同源 |
| 全自动小说台也保留「逐步可控」话术 | AIDrama | 与 Jellyfish ready 一致：自动≠跳过确认 |

### 3.2 任务中心

| 加深 | 证据 | ToIV 落点 |
|------|------|-----------|
| 纯前端无任务恢复 = 刷新即断 | dramai v0.4 | N10/P2：任务中心必须追踪+回跳+可恢复；禁当创作表单 |
| 桌面 TaskStatusBar 轻量条 | Koma | 创作台顶栏可只读摘要，详情进任务中心（对标 L1 忙闲） |

### 3.3 双视图

| 加深 | 证据 | ToIV 落点 |
|------|------|-----------|
| 「列表 ↔ 看板」比「列表 ↔ 自由 xyflow」更低风险 | AIComicBuilder | D2-A 可分两档：P3a 看板/竖排投影；P3b 才考虑 vue-flow 竖排 |
| LocalMiniDrama 仍是竖排流水线标杆（主档案已有） | — | 本轮无更强双视图替代 LMD |

### 3.4 声画

| 加深 | 证据 | ToIV 落点 |
|------|------|-----------|
| 主链含配音+口型是成熟叙事 | AIDrama | 加固 D6-A；N7 无台词越过 voice 仍必须做 |
| 「配音外置剪映」仅适合零 TTS 产品 | dramai | ToIV **默认站内 IndexTTS**；剪映朗读仅作 P4 旁路文档 |
| Koma TTS Provider 可插 | Koma | 设置里配 TTS；创作面不挂引擎名（同 N5） |

### 3.5 导出

| 加深 | 证据 | ToIV 落点 |
|------|------|-----------|
| 剪映草稿 + 站内 FFmpeg 可并存 | Koma、ArcReel（已有）、dramai ZIP | P4：优先站内预览（P2.6）；剪映草稿/FCPXML 按需；**GPL/AGPL 只学协议不拷码** |
| 素材打包下载 | AIComicBuilder | 合成阶段附「工程包」可选 |

### 3.6 对拍板包的影响

**无变更。** 仍推荐 D1-A + D2-A + D3-A + D4-C。可选微调：D2-A 验收可增加「看板投影」作为竖排流水线的等价物。

---

## 4. Wave M · 模型保鲜执行计划

> 源：`MODEL_FRESHNESS_BASELINE_20261022.md`。  
> **本 Wave 不编码业务壳**；账本 JSON / gate 模板 / 下载脚本属运维窗，且 **每步确认后才执行**。

### 4.1 总原则

1. **双轨优于热替换**：新权重旁路评测 → smoke → 再改 live gate / 服务默认。  
2. **确认门**：下载、改 `model-config`/gate、改 :9200 目录、任何 systemd 重启 → 必须用户明示。  
3. **与壳层错峰**：大下载 / 换 gate 避开 P1 首页语义发布的同一「感知验收小时」；可与 **文档债专队**、**N1/N2 registry** 同周不同窗。  
4. **主路径保留**：H3 :8264 生产 int8、IndexTTS 服务进程、VLM :9311 BF16 — MASTER §4 KEEP。

### 4.2 步骤表（M0–M4）

| ID | 名称 | 动作（确认后） | 触发条件 | 预估体积/窗 | 与 N/P 冲突规避 | 验收 |
|----|------|----------------|----------|-------------|-----------------|------|
| **M0** | 账本补录 | 将生产 `minimax_h3_ref2va_pruned_int8_convrot` / `…_fl2va_…` **写入 MODEL_SOURCES**（status=ok，repo=`Comfy-Org/MiniMax-H3`，size=20970379616）；可选清理 picker∩blocked 的「勿追下载」备注 | 保鲜基线已出；**无需下载** | 0 GB；文档/JSON 运维 | **不碰** N3–N5/P1 UI；可与 **N1/N2**（8264 文案）同周，先 M0 再改 registry 叙述更顺 | ledger 能精确 basename 命中；下次保鲜可 diff |
| **M1** | 出图 v18 smoke → v23 双轨 | ① **已在盘** `Qwen-AIO-SFW-v18` 对 :8196 做对照 smoke（vs gate v11）；② 通过后确认下载 `v23/Qwen-Rapid-AIO-SFW-v23.safetensors`（≈28.43GB，hf-mirror+aria2c）；③ 双轨评测后再改 live gate / `model-config.template` | P0：gate=v11 而上游 SFW=v23；盘上已有 v18 | ≈28GB（仅 v23 步）；**worker 热切换门禁**，尽量不整机重启 | **避开** P1 首页发版验收小时；与 N5（添加菜单去引擎名）无争 —— gate 名变仍藏在节点设置；**勿**与「改默认管线回 c」混淆 | SFW 卡/编辑流/默认步数回归通过；gate 指向约定版本；旧 v11 可归档不删 |
| **M2** | Wan Mega-v11 双轨 | 下载 `Mega-v11/wan2.2-rapid-mega-aio-v11.safetensors`（≈24.3GB）至 NAS 主库旁路；:8197 **选用评测**，不写死替换现 i2v-v10/mega-v1 | P1：本地 mega 明显落后上游 Mega-v11；出图 M1 ① 已开始或并行磁盘允许 | ≈24GB；:8197 评测任务 | 不挡 P2 声画（H3/IndexTTS 主链）；与 Animate :8199 无关 | 旁路可跑通样片；未改生产写死名则算「双轨就绪」 |
| **M3** | IndexTTS 真机核验 | SSH/真机 `ls`+size/hash 对照 `IndexTeam/IndexTTS-2.5`（`gpt.pth`=3259599833 等）；**仅当仍为 2.0 或缺失** 才计划升级与 **:9200 维护窗** | AGENTS 称 2.5 但基线「未核实」；P2 声画依赖此服务 | 核验 0GB；若升级则按官方包（数 GB 级）+ **服务窗** | **硬约束**：P2 / D6 / N7 进行中 **禁止**停 :9200；升级窗与壳层发版错开；MASTER KEEP IndexTTS | 文档与磁盘 revision 一致；若升级：synth_for_shot 抽检通过 |
| **M4** | H3 实验可选 | 可选拉 Kijai `MiniMax-H3-experimental`（如 Acc-8Step LoRA / w4a8 / fastvideo_vsa）做 **旁路评测**；**禁止**替换 :8264 默认 pruned_int8 | 有空闲盘与评测人力；生产 int8 无过时证据 | 视条目 1–20GB+ | 与 N1（默认 :8264）同向：实验永不改默认基址；Dly10「原生音画一体」仍延后 | 评测记录入库；live 默认仍为 pruned_int8 |

### 4.3 明确不做（Wave M）

| 项 | 理由 |
|----|------|
| 强制换 H3 生产 int8 | 与上游同档（基线 §3.2 / §6） |
| 强制换 VLM :9311 / 灌社区 GGUF | 无官方继任；KEEP BF16 |
| 全量扫 Civitai NSFW LoRA | 非主路径；成本高 |
| 追 blocked/provenance_lost | 如 `h3_musubi_v4` → 跳过 |
| 无确认自动 aria2c / 自动改 gate | 保鲜员纪律 |
| 借 Wave M 重启无关服务或关 IndexTTS | MASTER §6 反模式 |

### 4.4 建议时序（与近窗并行示意）

```
周序（示意，非排期承诺）
├─ 近窗壳层：N1–N10 文档+语义 → P1 IA → P2 阶段/声画
└─ Wave M：  M0（随时）→ M1① smoke（随时）→ M1② 下载（确认）→ M2（磁盘闲）
              M3 核验（随时只读）→ M3 升级（仅维护窗）
              M4（可选，M1/M2 后）
```

**冲突裁判：** 若同一维护窗只能做一件 —— **优先 M1 smoke（已在盘，零下载）与 M0（零下载）**；大包下载让给低峰。

---

## 5. 与 MASTER / COMPETITIVE 咬合点清单

| 咬合点 | 来源 | 本加深稿动作 |
|--------|------|--------------|
| D1-A 阶段轨默认 | COMPETITIVE §0 / MASTER | 竞品增量 **未反对**；CineGen/AIComicBuilder 加厚「分镜准备≠画布」 |
| D2-A 双视图投影 | 同上 | 增加 **看板投影** 作为 P3 低成本选项 |
| D3-A 工具台拆权 / N5 创作语义 | MASTER N5 | Koma Provider 在设置 → 印证「模型不进添加菜单」 |
| D4-C 站内合成优先 | MASTER | Koma/dramai 剪映能力进 **P4**，不抢 P2.6 |
| D6-A / N7 声画 | MASTER | AIDrama 印证主链配音；dramai 外置配音 **仅旁路** |
| N1/N2 :8264 + registry | MASTER | M0 补 H3 账本；M4 不改默认；与 N1 文案同向 |
| P1 任务中心 | COMPETITIVE P1 / N10 | dramai 反证任务恢复；Jellyfish 仍是正标杆 |
| P2 声画 + 就绪态 | COMPETITIVE P2 | M3 核验服务健康；壳层 N7 与权重 M3 升级错峰 |
| P3 流水线视图 | COMPETITIVE P3 | AIComicBuilder 看板 / LMD 竖排 — 二选一或并存，同源 |
| P4 导出 | COMPETITIVE P4 | Koma+ArcReel+dramai+Openframe 组成导出菜单选项集 |
| KEEP 舰队/IndexTTS/账本 | MASTER §4 | Wave M 遵守；VLM/H3 生产不强制 |
| Dly10 音画一体换默认 | MASTER §5 | 仍延后；≠ M4 实验 |

---

## 6. 成功标准（本文件）

| 项 | 状态 |
|----|------|
| 竞品：在 COMPETITIVE 之上补洞，不整段重贴主档案 | ✅ §1–§3 |
| 新竞品产品级条数写清 | ✅ **5** |
| 五模式（阶段轨/任务中心/双视图/声画/导出）有加深 | ✅ §3 |
| 无重大新仓时声明「无增量」 | ✅ 范式无翻盘；噪声区无增量 |
| Wave M0–M4 含触发条件、冲突规避、确认门 | ✅ §4 |
| 与 N1–N10 / P 波咬合 | ✅ §5 |
| 未下载、未改账本、未重启、未编码提交 | ✅ 遵守 |

---

## 7. 建议父代理下一步（仍不编码）

1. 将 §2 五条 **摘要一行** 回写进 COMPETITIVE 矩阵附录（可选，另开文档窗）。  
2. 用户拍板后：保鲜员执行 **M0 + M1①**（零/低风险）；下载类等书面确认。  
3. UX 工程卡继续按 MASTER N1–N10 → P1→P2；P3 验收加「看板或竖排投影二选一」。  
4. Exa 限流解除后可选再扫一轮日韩/英文 micro-drama desktop，预期边际收益低。

---

## 附录 A · 本轮实查链接

- https://github.com/LingyiChen-AI/AIComicBuilder  
- https://github.com/UllrAI/CineGen-ShortDrama  
- https://github.com/Sundykin/KomaBuild · https://github.com/M-JYuan/Koma  
- https://github.com/EvoLinkAI/ai-short-drama  
- https://github.com/hyyyyyyz/dramai  
- 保鲜：`docs/ops/MODEL_FRESHNESS_BASELINE_20261022.md`  
- 上游（基线已录）：Phr00t Rapid AIO v23 · Phr00t Wan Mega-v11 · IndexTTS-2.5 · Comfy-Org/MiniMax-H3 · Kijai/MiniMax-H3-experimental  

## 附录 B · 修订记录

| 时间 (Asia/Shanghai) | 说明 |
|----------------------|------|
| 2026-10-22 | 初版：竞品 Δ5 + 模式加深 + Wave M0–M4；Exa 429 已降级；未编码未下载 |
