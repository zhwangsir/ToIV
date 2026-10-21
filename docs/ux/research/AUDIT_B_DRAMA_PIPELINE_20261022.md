# AUDIT B · 短剧/Studio 管线全栈审计

> 日期：2026-10-22（Asia/Shanghai）  
> tip：`e5307c63` · 分支 `work/p0-fusion-20261016`  
> 执行者：全栈审计 B 路 · **只读审计，禁止业务编码 / commit / push / 部署**  
> 本机：`docs/ux/research/AUDIT_B_DRAMA_PIPELINE_20261022.md`  
> Box：`/workspace/refs/competitive-deep/AUDIT_B_DRAMA_PIPELINE_20261022.md`

---

## 0. 审计结论（先读）

| 问题 | 结论 |
|------|------|
| 默认视频管线 | **tip 已是 `ref2va`**；产品 md §8 仍写默认 `c` → **文档债**，非代码债 |
| Motion Context `c`/`c_hybrid` | **降为可选已足够**；代码保留门禁/续写/测试；**勿删** |
| 配音是否进默认阶段 | **应进**；`compute_studio_next_step` 与 Drama 七阶段均含 voice→lipsync |
| Agent 默认开还是开关 | **开关/分流**：对话智能体默认；「用剧组」或 L1/L2 Director Gate 才走 Team；合成人闸 interrupt |
| 最大实锤缺口 | ① 产品 md 滞后 ② canvas `c-chains` 仍默认 `c_hybrid` ③ Studio `next_step` 对**无台词镜**卡在 voice ④ Drama/Studio **双域**未收束 |

组件裁决计数（下表）：**KEEP 19 · OPTIMIZE 8 · REPLACE 1 · DOC-DEBT 2**（合计 30 行组件表）。

---

## 1. 必读对照与证据源

| 源 | 用途 |
|----|------|
| `docs/AI短剧产品方案.md`（2026-10-08） | 产品主线；§8 #1 **滞后** |
| `docs/CHARACTER_ASSET_GUIDE.md` | L1/L2/L3 角色资产 |
| `docs/ux/research/TOIV_LOCAL_AI_CAPABILITY_MAP_20261022.md` | 本地 AI 能力地图 |
| `docs/ops/PROJECT_DOMAIN_MERGE_ASSESSMENT_20261011.md` | 双域合并方向（Studio 宿主） |
| `apps/api/app/services/studio/*` | orchestrator / pipelines / pick / voice / lipsync / assemble / sheet |
| `apps/api/app/services/drama_pipeline.py` | Drama 七阶段 + Studio next_step |
| `apps/api/app/services/agent_team_{graph,exec}.py` + `routes/agent_team.py` | Agent Team |
| `apps/api/app/agent/{runner,tools_*,subagent}.py` | 对话 Agent + 自愈工具 |
| 测试：`test_ref2va_indep_pipeline`、`test_drama_batch4_voice*`、`test_sheet_gate*`、chybrid*、agent_team* | 契约钉死 |

---

## 2. 状态机（事实）

### 2.1 StudioShot（主宿主，单 status 列）

```
draft → queued → rendering → rendered → voiced → (lipsynced) → done
                                                      ↘ error（任一环；有入选片时重试可恢复 prior）
```

证据：`orchestrator.py` 头注释；`models.StudioShot.status`；`_TERMINAL_SKIP = {rendered,voiced,lipsynced,done}`。

`compute_studio_next_step` 阶段序：

| step | 已达集合 | 建议动作 |
|------|----------|----------|
| render | rendered/voiced/lipsynced/done | `/studio/projects/{pid}/render` |
| voice | voiced/lipsynced/done | `/studio/shots/{sid}/voice` |
| lipsync | lipsynced/done | `/studio/shots/{sid}/lipsync` |
| assemble | done | `/studio/projects/{pid}/assemble` |
| done | — | — |

**缺口（OPTIMIZE）**：无台词镜永远到不了 `voiced`（voice API 422「该镜无台词」），但 next_step 仍把它们算进 voice pending → **进度条永久卡在「分镜配音」**。批量 step=voice 已按「有台词」过滤，**纯函数与批量路径不一致**。

### 2.2 DramaShot（兼容域，多 status 列）

七阶段重算：`ingest → characters → storyboard → video → voice → lipsync → assemble`（`continue` 仅 advisory）。

- voice/lipsync 的 `applicable` = 有 `dialogue` 的镜 → **Drama 侧已正确跳过无台词**。  
- Studio 侧应对齐同一语义。

### 2.3 AgentRun

`planning → awaiting_confirm → running → awaiting_assembly → done|error|canceled`；`assembly_gate` 用 LangGraph `interrupt()` 等人确认。

---

## 3. 组件裁决表

裁决定义：

- **KEEP**：保留现状；仅文档/露出对齐  
- **OPTIMIZE**：保留主体，改契约/默认/UX/与另一路径对齐  
- **REPLACE**：应替换或收敛到另一实现（非立刻删代码）  
- **DOC-DEBT**：代码已对、文档/注释错

| # | 组件 | 路径/符号 | 裁决 | 证据摘要 | 建议 |
|---|------|-----------|------|----------|------|
| 1 | 默认视频管线常量 | `studio/pipelines.py` `DEFAULT_VIDEO_PIPELINE=ref2va` | **KEEP** | tip 单测 `test_default_pipeline_is_indep_ref2va`；`INDEP_REFS_PER_SHOT=4` | 生产部署核对 tip；UI 显式可选 c/c_hybrid |
| 2 | `render_shot` 默认/拒续写 | `orchestrator.render_shot` | **KEEP** | `pipeline or DEFAULT_VIDEO_PIPELINE`；独立镜传 context_latent → `RenderError` | 保持 |
| 3 | seam→自动改 `c` | `seam_to_next=continue` 且未显式 pipeline | **OPTIMIZE** | W2.5：未传 pipeline 时改走 Motion Context | UI 标注「续写接缝=管线 C」；避免用户以为仍是 ref2va |
| 4 | Motion Context `c` | `C_PIPELINES` + `pipeline_c_render` + chybrid 测试族 | **KEEP**（可选） | 用户 10-07 拍板不换默认；代码/门禁全留 | **降为可选已足够，勿删** |
| 5 | `c_hybrid` | 首帧锚定 Hybrid | **KEEP**（可选） | 雨夜对比脚本 + 多测 | 专家/实验入口；非短剧默认 |
| 6 | canvas c-chains 默认 | `canvas/.../client.ts` `pipeline ?? "c_hybrid"`；`buildMakeupCChainFromDrama` 写死 `c_hybrid` | **OPTIMIZE** | 与 tip/API 默认 **ref2va** 冲突 | makeup 链默认改 ref2va，或明确标「续写实验」且不从短剧主 CTA 进入 |
| 7 | web studio API 类型 | `apps/web/lib/api.ts` pipeline 注释默认 ref2va | **KEEP** | 与 tip 一致 | — |
| 8 | 产品方案 §8 #1 | `docs/AI短剧产品方案.md` | **DOC-DEBT** | 仍写「默认仍是 c、尚未做」 | 修订：已切 ref2va + 单测；余下=生产对齐+UI 管线选择+真机一镜 |
| 9 | 选优 face_mean | `candidate_pick.py` ≥0.45；动漫 CLIP 建议 0.60 | **KEEP** | `CandidatePickError`，禁回落首候选 | 创作者面人话错误（sheet 已有 humanize，选优可复用） |
| 10 | 场景/硬切/衣物门禁 | `scene_gate` / `hard_cut` / outfit+OCR | **KEEP** | chybrid_* 测试钉规则 | 复用于 ref2va 选优路径保持 |
| 11 | VLM QA 四问 | `qa_gate.py` | **OPTIMIZE** | 无 VLM/失败一律 skip，不堵主链；verdict pass/warn/fail | 学习站可「严模式」：fail 阻止级联；默认保持 skip |
| 12 | 角色设定卡 | `character_sheet/*`（gates 88k 行级） | **KEEP** | 风格分桶 refs；`final_review`；ux humanize | 与 L2 asset 面板继续共存 |
| 13 | 角色资产 L2 | `character_asset.py` | **KEEP** | 锚点/变体/coverage-plan 已上线 | UI 变体下单仍缺（指南已写）→ OPTIMIZE 产品化 |
| 14 | 定妆→视频 refs | `shot_refs.select_indep_shot_refs` | **KEEP** | 每镜≤4 + 场景；缺角色名 `cast_missing_refs` | UI 强制「无定妆不可批量」闭环（产品原则） |
| 15 | 配音 IndexTTS | `studio/voice.py` → `tts_url`/:9200 | **KEEP** | 音色克隆降级；状态 rendered→voiced | **默认阶段必须保留** |
| 16 | INTENT c「配音 TTS」积压 | `INTENT_PLAN` / 产品方案 §8 | **OPTIMIZE** | 后端主路已通；积压偏产品露出/工具台 | 勿再立项「从零做 TTS」；清 INTENT 文案 |
| 17 | 对口型 pad | `lipsync.pad_audio_to_video_length` | **KEEP** | 防成片被台词截断；batch7 测 | — |
| 18 | 对口型引擎 | LatentSync :9103 优先 / Comfy 回退 | **KEEP** | `lipsync_via_agent` | 健康探活进任务中心（运维面） |
| 19 | 成片 assemble | `assemble.concat_parts_uniform` + 时长/音轨断言 | **KEEP** | 混规格转码归一；防哑音雷 | 无台词镜：允许「仅视频→final」跳过 lipsync |
| 20 | Studio next_step 无台词 | `compute_studio_next_step` | **OPTIMIZE** | 无 dialogue 仍进 voice pending | 对齐 Drama：无台词视为已越过 voice/lipsync，或 auto 标 done 旁路 |
| 21 | Drama 七阶段管线 | `drama_pipeline.compute_drama_pipeline_status` | **KEEP** | 产物+Job 重算；recoverable 分裂态 | Studio brief 继续暴露 |
| 22 | Drama vs Studio 双域 | `DramaProject` ∥ `StudioProject` | **REPLACE**（收敛） | 评估已定 Studio 唯一宿主；S4 已下沉 seam | 新功能只加 Studio；Drama API 只读兼容至收束 |
| 23 | Agent 对话六角色 | `agent/runner.py` 原则 20 | **KEEP**（触发式） | 「用剧组/让导演来」才拆六角色 | **默认阶段轨人手走；Agent=开关** |
| 24 | Agent Team LangGraph | `agent_team_graph` assembly_gate interrupt | **KEEP** | L0 不建 run；L1/L2 建 Team | 产品入口「剧组模式」开关，勿默认劫持短剧 CTA |
| 25 | Director Gate L0/L1/L2 | `routes/agent_team.classify_goal*` | **OPTIMIZE** | 短剧关键词→L2 | 与阶段轨产品包对齐文案，避免用户误入并行编排 |
| 26 | Agent 自愈工具 | `tools_selfheal`（烟测/应用修复） | **OPTIMIZE** | **管理员应用烟测**，非分镜自愈 | 命名隔离；分镜重试走 orchestrator 保留入选片逻辑 |
| 27 | 失败保留入选 | orchestrator prior_status 恢复 | **KEEP** | 重试失败不把 voiced 盖成 error | 废片库 UX 仍缺 |
| 28 | render_reconcile 异步候选 | S5 wait=false | **KEEP** | queued→Job 回写 | — |
| 29 | H3 原生音画一体 | PLATFORM_V5 W7 A/B | **OPTIMIZE**（后置） | 现默认 H3 画面+IndexTTS+对轴 | 保持 A/B 实验，**不换默认** |
| 30 | 设定卡「零通过=未交付」标定 | `test_sheet_gate_calibration` + gates 注释 E-3 | **DOC-DEBT** / 运维 | 阈值已钉；真机交付口径另册 | 勿把标定夹具当交付证明 |

---

## 4. 专题回答（任务必答）

### 4.1 状态机 draft→…→done 是否够用？

**够用（KEEP）**，但要修两处语义：

1. **无台词旁路**：rendered →（跳过 voice/lipsync）→ 可直接作为 assemble 素材 / 标 `done`。  
2. **prepared ≠ generating**：状态列有 `queued/rendering`，产品阶段轨应把「分镜就绪（refs+prompt 齐）」与「已提交 GPU」拆开（UX 方案 P2）；代码侧可用 `ref_images_json` + status=`draft` 表达 ready，无需新枚举也可先做。

### 4.2 配音是否应进默认阶段？

**应进（KEEP 在默认闭环）。**

证据：

- 产品主线：定妆→Ref2VA→**配音**→pad 对口型→成片。  
- `compute_studio_next_step` 与 Drama `_next_step` 均含 voice。  
- IndexTTS :9200 为现网配音主路（AGENTS）；`voice.synth_for_shot` 已生产。  

「INTENT c 配音 TTS」是**产品露出/工具台积压**，不是「没有配音能力」。阶段轨拿掉配音会砍断可看短剧闭环。

### 4.3 Agent 默认开还是开关？

**开关 / 分流（KEEP 架构，OPTIMIZE 入口文案）。**

| 层级 | 行为 |
|------|------|
| 默认短剧台 | 人走阶段轨（DRAMA_UI_PLAN / UX D1-A） |
| 对话 Agent | 常驻助手；六角色仅当用户说「用剧组…」 |
| Agent Team | Director Gate：L0→对话工具；L1/L2→建 run；合成前 **HITL interrupt** |

不建议：进门即 Agent Team 一键成片（算力贵、人闸必须）。

### 4.4 Motion Context 降为可选是否足够？

**足够（KEEP 可选）。**

- tip 默认已独立 Ref2VA；显式 `c`/`c_hybrid` 仍续写。  
- seam_to_next=continue 是「局部自动选 C」，合理。  
- **勿 REPLACE 删代码**；雨夜/门禁资产仍复用。  
- 需 OPTIMIZE：canvas makeup c-chains 默认 `c_hybrid` 不要冒充短剧主路径。

---

## 5. 与 UX / §12 的咬合

| UX/§12 项 | 本审计 |
|-----------|--------|
| P2 声画阶段位 | 后端已有；修 next_step 无台词 + UI 阶段露出 |
| D5 阶段轨默认 + 剧组开关 | 与 Agent 结论一致 |
| D6 P2 含配音→口型 | **确认必须** |
| D7 修订产品 md + 生产 tip | **DOC-DEBT #8** |
| 一致性先定妆再批量 | sheet+refs+face_mean 厚；缺强制闸 UX |
| 失败人话 | sheet ux 有；candidate_pick 可复用 humanize |

---

## 6. 优先优化清单（不编码，仅排序）

| 优先级 | 项 | 人天感 | 类型 |
|--------|-----|--------|------|
| P0 | 修订 `AI短剧产品方案.md` §8（默认已是 ref2va） | 0.5 | DOC |
| P0 | Studio `next_step` 无台词越过 voice/lipsync | 0.5–1 | OPTIMIZE |
| P1 | canvas c-chains / makeup 默认与主 CTA 脱钩或改 ref2va | 1–2 | OPTIMIZE |
| P1 | UI 管线选择器（ref2va 默认，c/c_hybrid 专家） | 1–2 | OPTIMIZE |
| P2 | 选优/QA 失败人话 + 废片不污染资产 | 2–3 | OPTIMIZE |
| P2 | 双域：新功能禁 Drama 写入；兼容层只读 | 持续 | REPLACE 收敛 |
| P3 | H3 原生音画 A/B（不换默认） | 按 V5 W7 | OPTIMIZE 后置 |
| P3 | 角色资产变体 UI 下单 | 2–3 | OPTIMIZE |

---

## 7. 测试覆盖快照（本路相关）

本机 `apps/api/tests/` 命中名：`ref2va|drama|sheet|voice|lipsync|chybrid|assemble|agent_team|pipeline` ≈ **38+** 文件（含 sheet 大量门禁测）。

关键钉：

- `test_ref2va_indep_pipeline.py`：默认 ref2va、无 body 不续写、显式 c 续写、refs 选取。  
- `test_drama_batch4_voice_assemble.py`：空对白 422、缺音视频 422、契约 mock。  
- `test_drama_batch7_lipsync_pad_duration.py`：pad 时长。  
- `test_sheet_gate_*`：设定卡门禁/失败 UX。  
- `test_agent_team*.py`：图/interrupt。  

缺口：`compute_studio_next_step` **无台词越过** 尚无单测（建议补，本路不编码）。

---

## 8. 摘要（给父代理）

1. **默认管线 tip=`ref2va` 已落地**；产品 md §8 与个别 canvas c-chains 默认仍像「世界停在 c/c_hybrid」——修文档 + 修 UI 默认，勿重做后端切换。  
2. **配音/口型必须留在默认阶段**；IndexTTS+pad+assemble 断言是闭环，不是 P4 可选项。  
3. **Agent = 开关/Director 分流**，不是进门默认；Team 合成人闸正确。  
4. **Motion Context 可选足够**；保留 c/c_hybrid 与门禁，禁止当短剧主 CTA。  
5. **最伤体验的代码债**：Studio `next_step` 对无台词镜卡在 voice；其次双域并存与 canvas `c_hybrid` 默认。

---

## 9. 变更纪律回执

- 未改业务代码、未 commit、未 push、未部署。  
- 仅新增本审计 md（本机 + Box 副本）。
