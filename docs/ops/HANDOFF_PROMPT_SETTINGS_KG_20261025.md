# ToIV 换机续作提示词（设置 / 模型搭配 / 知识图谱）

> **状态 2026-10-26**：P1.5 已落地（Civitai trainedWords→图谱；设置视觉整理）。下一优先：出图 loras 接线 / P2 实测回写。未 commit。

> 生成时间：2026-10-25 23:29 Asia/Shanghai  
> 用途：复制下方「提示词正文」到另一台设备上的 Agent / Cursor，继续未完成工作。  
> **重要**：下列改动绝大部分仍在 MateBook 工作区、**未 commit / 未 push**。换机前必须先把工作区带走（commit、bundle、rsync 或 U 盘同步整个 ToIV 目录），否则新设备只有旧 tip `e641dda4`，看不到设置/图谱代码。

> **P1b+Forge+edit 已落地（2026-10-26 04:44 Asia/Shanghai）**：基座库存 `base-inventory.json`（非实时 NAS 种子）接入设置槽下拉；Forge `<lora:>`；`qwen-image-edit` 市场 loras；图谱 P2 仍有效。
> **未做**：Remix/Mega（保鲜员）· 永久删隔离 · push/部署 · Acc/安全 · 雨夜实测升 A

---

## 提示词正文（从下一行复制到文末）

你是 **ToIV 接棒工程师**。用户换设备续作，请先对齐下列真源再动手；默认 **不 commit / 不 push / 不部署生产**，除非用户明示。结论写入 `TEST_LOG.md`。用中文沟通。

### 身份与仓库
- 工作目录：`/Users/wangzhenyu/Desktop/ALLProject/ToIV`（或用户本机等价路径；GitHub `zhwangsir/ToIV`）
- 分支：**`work/p0-fusion-20261016`**（勿切走）
- 上次已知 tip（已 commit）：`e641dda4`；其后再大量本地改动 **未入库**
- 产品原则：功能可用 + 用户感知优先；安全/换密/Acc/push/生产部署 **冻结**，除非用户明示
- AI 测试账号：`admin` / `admin123`（仅本地测）
- 用户：CN_Winery；语言：中文

### 现网相关（续作设置/模型时别踩）
- 生产 LLM 已切 **Mia**：API `http://192.168.71.84:8888/v1`，model `DeepSeek-V4.1-Flash-1017`（TensorFold TP2）；同 GPU 互斥，`dsv4_60/:8000` 曾临时 stop；core `deploy/.env` + `llm_proxy` 有 bak `.bak.mia-8888-20261025`
- 出图默认：`Qwen-Rapid-AIO-SFW-v23`；H3 视频默认：`minimax_h3` pruned_int8；视频主路多为 ref2va
- 硬件：双 Spark TP2；本地无审查刚需已满足（Mia 双轨 R18 探针曾 PASS）
- 预览设置页常用：`http://127.0.0.1:3001/settings`（:3000 常被占）

### 已拍板决策（必须遵守）
**知识图谱 D1–D4（2026-10-25「全部按推荐」）**
- D1：兼容未知 / 仅 C → **灰显可强制**（标「命名推断，未确认」），排序沉底
- D2：H3 与出图 **严格分族**（H3 LoRA 只进 video-primary；出图/运动不展示 H3 专属，反之亦然）
- D3：图谱存 **JSON 账本**（不上 Neo4j）
- D4：`lora-inventory.json` 与 `model-compat-graph.json` **并列**，basename join（勿合并）

**搭配主控**
- 每槽用户自选底模/渠道；配方 = 可改·非最优折叠快捷，不能固定死搭配
- LoRA = 挂在出图/视频槽的挂件（多选 ≤3 + 强度）；优先 engines.loras，空则库存兜底
- 用途不能确定的（P-C）已隔离，**不进可用库**；不确定用途的模型留着也不会有人用

**库存准入**
- 可用 = 来源 **A+B** 且 用途 **P-A / P-B**
- P-C / quarantine / blocked / 来源 C|D → 默认不出现在可选列表

### 方案与账本真源（先读这些）
1. `docs/ux/MODEL_COMPAT_KNOWLEDGE_GRAPH_PLAN_20261025.md` — 图谱方案（已标拍板）；P0 已实现，P1/P2 待做
2. `docs/ux/SETTINGS_REDESIGN_PLAN_20261025.md` — 设置三区「常用 / 模型与算力 / 高级」；产品面去端口
3. `docs/ux/MODEL_MIX_CONTROL_PLAN_20261025.md` — 槽位表 + 配方芯片 + Mia↔dsv4 互斥提示
4. `docs/ops/MODEL_COMPAT_GRAPH_20261025.md` — 图谱人读短表
5. `docs/ops/MODEL_AND_LORA_INVENTORY_20261025.md` — 真机库存
6. `docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md` + purpose/source CSVs — 来源·用途调研
7. `docs/ops/PURPOSE_UNKNOWN_QUARANTINE_20261025.md` — P-C 隔离（同卷 mv，非 rm）
8. `TEST_LOG.md` 顶部「知识图谱 P0」条目 + 2026-10-25 相关段

### 已落地（工作区，多数未 commit）
**设置 / 搭配**
- 三区导航；角色槽位表；配方快捷；LLM 互斥 banner（不自动起停）
- LoRA 挂件 UI：`slot-lora-row` / `model-slot-table` / `slot-lora.ts`
- 库存：`scripts/ops/gen-lora-inventory-json.py` → `apps/canvas/web/src/generated/lora-inventory.json`（**351** = P-A94 + P-B257）
- `src/lib/lora-inventory.ts`

**知识图谱 P0**
- `scripts/ops/build-model-compat-graph.py` → `generated/model-compat-graph.json`（~543 节点 / ~1580 边；compatible_with A≈21 / B≈108 / C≈194）
- `src/lib/model-compat.ts`：`familyOfBase` / `queryCompat` / `compatStatus`
- 设置页 LoRA 管理：按当前槽底模族过滤；仅 C 灰显；H3 严格分族
- 单测：`bun test test/model-compat.test.ts test/slot-lora.test.ts` → 曾 12 pass
- 已知弱项：出图 Qwen 下 A/B 兼容边很少（~3），多数为 C 灰显——证据不足，不是过滤逻辑坏了

**调研 / 隔离**
- MODEL_SOURCES 已扩；多份 `.bak.*-20261025`
- P-C：53 basename → 58 实例隔离到 `_quarantine_purpose_unknown_20261025/`；status=blocked

**LLM 切 Mia**（可能已在 core；本机也有 `llm_proxy` / `.env` 相关改动）

### 未完成 / 建议续作顺序（用户未再拍板前可先核对预览，再按下列推进）
**P1 — 图谱用法完整化（优先，接上用户「关联性+怎么用」诉求）**
1. 从 Civitai/HF 版本页加深抓 **trainedWords（trigger）** 与推荐 weight，写入图谱边 / TriggerPhrase
2. 设置 LoRA 卡片展示：trigger、推荐强度区间、冲突提示（不只用途/类型/来源）
3. **钉选 LoRA 注入生成管线**前做 `compatible_with` 校验（失败阻断或明确提示，不静默）
4. 配方快捷改为引用图谱边（带 strength/triggers），非裸文件名
5. 尽量补强 Qwen-image 族 A/B 边（卡页声明或人工钉选），减少「几乎全灰显」

**P1b — 基座可控（已落地）**
6. ~~基座下拉接 NAS 全量枚举~~ → `generated/base-inventory.json` + 设置槽合并；MateBook 无挂载 = 非实时种子
7. 解析不到族 →「族未解析」

**P2 — 图谱深化（可后）**
8. 实测 / 雨夜回写 confidence A；文件级 `conflicts_with` / `substitutes`
9. 可选简易图谱可视化；仍可保持 JSON，不必上图 DB

**其它挂账（设置线之外，勿擅自开干除非用户点名）**
- 隔离目录是否 **永久 rm**（现仅 quarantine）— 需用户明示
- 本批大改是否 **commit**（用户历史默认不 commit；换机强烈建议先 commit 或整树同步，但仍听用户口令）
- Acc / 安全 Dly / push / 生产部署 — 仍冻结
- Wave 更早的 P4 等（关键帧/失败码/剧组一键/BGM+KPI/剪映等）— 不在本提示词主线，除非用户拉回

### Agent 消费契约（已设计，P1 可包 helper）
```
query_compat({ base_id?, family?, slot?, min_confidence?="B", include_triggers?, exclude_nsfw? })
→ { base_family, items:[{ lora_id, label, purpose_zh, purpose_grade, confidence, strength, triggers, conflicts, source_url, notes }] }
```
规则：只使用返回的 lora_id；必须带 triggers；禁止凭文件名跨族瞎配；P-C 永不入默认结果。

### 换机检查清单（动手前）
1. `git status` / `git log -1`：确认能看到 untracked 的 `generated/`、`model-compat.ts`、三份 `docs/ux/*20261025*` 等；若只有干净 tip，说明工作区没带走 → **先同步再改**
2. 读方案 §H 与 TEST_LOG「知识图谱 P0」段，确认 D1–D4
3. 本地起 web，打开 settings → 常用 → 管理 LoRA，确认过滤/灰显仍在
4. 再问用户：先做 P1（trigger+强度+生成校验）还是先 commit/同步；**不要默认 commit**

### 成功标准（续作时对照）
- 选 Qwen-Rapid 时，绿灯区无 H3/Wan 视频专属 LoRA；选 H3 时仅 minimax-h3 兼容项
- Agent `query_compat(..., min_confidence=B)` 不返回仅 C；卡片能看到怎么用（trigger/强度）后才算「关联性完整」
- quarantine/P-C 零出现在默认可用查询

开始时：先汇报你看到的 git 状态（是否含未提交图谱/设置改动），再提议下一步（默认推荐 **P1：trigger+强度进卡 + 钉选生成校验**），等用户一句开干再写代码。
