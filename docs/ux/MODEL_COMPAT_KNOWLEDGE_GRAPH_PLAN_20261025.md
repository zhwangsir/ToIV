# ToIV 模型搭配知识图谱方案（底模 ↔ LoRA）

> **状态 2026-10-26**：P1.5 已落地（Civitai trainedWords→图谱；设置视觉整理）。下一优先：出图 loras 接线 / P2 实测回写。未 commit。

> **日期**：2026-10-25（Asia/Shanghai）  
> **状态**：**P0+P1 已落地（本机）** · 未 commit  
> **P1（2026-10-25）**：trigger/强度 · 钉选生成校验 · 配方图谱边 · Qwen-image A/B≈54；P1b/P2 仍待  
> **已拍板 2026-10-25（全部按推荐 D1–D4）**：D1 灰显可强制 · D2 H3/出图严格分族 · D3 JSON 账本 · D4 与 inventory 并列 basename join  
> **触发**：设置库存（351 条 A+B×P-A/P-B）已接上后，用户要求继续前必须把「哪些 LoRA 可用在哪个底模、怎么用」做成完整、可识别内容，并最好用知识图谱串联（人与 AI 都能用）。  
> **关联**：[`MODEL_MIX_CONTROL_PLAN_20261025.md`](./MODEL_MIX_CONTROL_PLAN_20261025.md) · [`SETTINGS_REDESIGN_PLAN_20261025.md`](./SETTINGS_REDESIGN_PLAN_20261025.md) · [`../ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md`](../ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md) · [`../ops/PURPOSE_UNKNOWN_QUARANTINE_20261025.md`](../ops/PURPOSE_UNKNOWN_QUARANTINE_20261025.md) · `lora_catalog.py` · `generated/lora-inventory.json`

---

## 0. 一句话

**在现有「用途库存」之上，补一层「兼容与用法」图谱**：节点=底模族/底模实例/LoRA/槽位/触发词；边=兼容、推荐强度、触发、冲突、来源。  
产品按当前底模过滤 LoRA；Agent 查 JSON 契约拿「可用 + 怎么用」，不再靠 `slots_for(path, cluster)` 启发式猜。

---

## 1. 关联性缺口审计（现状事实）

### 1.1 已有资产（勿推倒）

| 资产 | 事实 | 能回答的问题 |
|------|------|--------------|
| `generated/lora-inventory.json`（351） | 字段：`id/label/purposeZh/purposeGrade/sourceGrade/typeTag/cluster/pathRoot/sourceUrl/slots/nsfw` | 「有什么用途、挂哪个设置槽、来源链」 |
| `gen-lora-inventory-json.py` → `slots_for` | **启发式**：`path_root` + `cluster` 关键字 → `image` / `video-primary` / `video-motion` | 「粗略槽位亲和」 |
| `docs/MODEL_SOURCES.json` | 溯源：`basename/repo/source_url/status/notes…`；**无** purpose / base_family / trigger | 「文件从哪来」 |
| purpose CSVs | `purpose_zh` + P-A/P-B/P-C + cluster；**无** baseModel / trigger / weight | 「大概干什么」 |
| `_card_cache_20261025` | Civitai 摘要含 `baseModels[]`（57 张）；**无** `trainedWords` / 推荐 weight | 「卡页声明过的底模族（部分）」 |
| `lora_catalog.py`（≈21 卡） | `engines` / `default_strength` / `trigger_words` / `conflicts` / `role` | 「策划卡怎么挂、互斥、触发」——**仅策划子集** |
| 设置 UI | 按槽列库存；**不**按当前底模过滤；钉选未注入生成（P1） | 「浏览库存」 |

### 1.2 缺口清单（本方案要补）

| # | 缺口 | 后果 | 证据 |
|---|------|------|------|
| G1 | **无 BaseFamily / baseModel 字段** | 用户选 Qwen-Rapid 仍看到 Flux/Wan/H3 LoRA 混排 | inventory 11 字段无 base；CSVs 无 baseModel |
| G2 | **槽位亲和 ≠ 底模兼容** | `slots_for` 把大量 Wan 标成 `image`、Flux 标成 `video-motion`（交叉污染） | 统计：wan\* 带 image≈45；flux 带 video-motion≈13；h3 带 image≈3 |
| G3 | **无 TriggerPhrase** | 人不知道提示词怎么写；Agent 易漏触发词导致「挂了没用」 | inventory 无；catalog 仅 5 张有 `trigger_words`；civ 缓存无 trainedWords |
| G4 | **无推荐强度 / 强度区间** | 挂件默认 0.6 一刀切；与 catalog `default_strength` 脱节 | `slot-lora.ts` clamp 默认 0.6 |
| G5 | **无冲突 / 互斥边** | 加速叠加速、体位叠体位无产品提示 | 仅 catalog `conflicts`（role 级）；库存层无 |
| G6 | **无「当前底模实例 → 可用 LoRA」查询** | 设置页与生成台无法「选完基座再滤 LoRA」；Agent 只能猜 | 基座下拉尚未接 NAS 全量；无 join key |
| G7 | **证据未结构化** | 兼容性若写进 notes 字符串，人/AI 都难机读 | MODEL_SOURCES / purpose 证据在自由文本 |
| G8 | **P-C 隔离正确，但兼容层也不得回灌** | 实现时易误把隔离项当「未知兼容可灰显」 | quarantine 文档；方案默认 **永不入可用查询** |

### 1.3 卡页已有、尚未入库的线索

Civitai 缓存 `baseModels` 已见族（节选）：`Flux.1 D`、`MiniMax H3`、`LTXV 2.3`、`Wan Video 2.2 I2V/T2V-A14B`、`SDXL 1.0`、`Illustrious`、`Pony`、`ZImageTurbo`、`Qwen`…  
→ **P0 可自动抽「LoRA → BaseFamily」边（证据 B：卡页声明）**；trigger/weight 需加深抓版本页或人工钉选（P1）。

---

## 2. A. 目标与双读者

### 2.1 人（设置页 / 生成台）

1. 选定**当前底模**（或槽位默认底模）后，LoRA 列表**默认只展示兼容项**；不兼容可按策略隐藏或灰显（见 §H）。  
2. 每张 LoRA 卡可见：**用途、类型、trigger、推荐强度、来源链、兼容置信度、注意/冲突**。  
3. 配方快捷引用的是图谱边（带强度/触发），不是裸文件名。

### 2.2 AI / Agent

1. 给定 `base_id | family + slot`，返回结构化列表：`[{lora_id, strength, triggers[], purpose, confidence, notes}]`。  
2. **禁止**在无边或 `confidence=heuristic` 且产品策略不允许时，把不兼容 LoRA 写进提交参数。  
3. 与 `lora_catalog` 策划卡对齐：catalog 边升为证据 **A**；图谱是超集，catalog 是「产品点名子集」。

### 2.3 非目标（本方案不做）

- 不上线 Neo4j / 图数据库（P0–P1）。  
- 不自动「实测跑遍」所有 LoRA×底模组合。  
- 不把 P-C / blocked / 来源 C|D 拉回可用库存。  
- 方案正文曾冻结实现；**2026-10-25 拍板后开干 P0**（仍不 commit，直至另有指令）。

---

## 3. B. 图谱本体（节点与边）

### 3.1 节点类型

| 类型 | id 约定 | 说明 | 示例 |
|------|---------|------|------|
| **BaseFamily** | `family:<slug>` | 架构/训练族；兼容的主锚点 | `family:qwen-image`、`family:flux.1-d`、`family:sdxl`、`family:illustrious`、`family:pony`、`family:wan2.2-i2v-a14b`、`family:ltx-2.3`、`family:minimax-h3`、`family:hunyuan-video`、`family:z-image-turbo` |
| **BaseModel** | `base:<basename>` | 盘上/产品 checkpoint 或 diffusion 实例 | `base:Qwen-Rapid-AIO-SFW-v23.safetensors`、`base:minimax_h3_fl2va_pruned_int8_convrot.safetensors` |
| **LoRA** | `lora:<basename>` | 与 inventory `id` 对齐 | `lora:Anime_Style_Flux1D.safetensors` |
| **EngineSlot** | `slot:image` / `slot:video-primary` / `slot:video-motion` | 设置角色槽（可扩） | — |
| **PurposeTag** | `purpose:<cluster或role>` | 复用现有 cluster / catalog role | `purpose:accel_distill`、`purpose:pose` |
| **SourceCard** | `source:civitai:<id>` / `source:hf:<repo>` | 卡页/账本溯源 | — |
| **TriggerPhrase** | `trigger:<normalized>` | 触发词节点（可多 LoRA 共享） | `trigger:nsfwsks` |
| **VAE** / **HardwareProfile** | 可选 P2 | 仅当某 LoRA 强依赖特定 VAE/显存档时 | — |

**族归一建议（P0 字典，可迭代）**

| 卡页/命名原文 | → BaseFamily slug |
|---------------|-------------------|
| Qwen / Qwen 2.1 / Qwen-Image* | `qwen-image` |
| Flux.1 D / FLUX.1-dev | `flux.1-d` |
| Flux.2 Klein* | `flux.2-klein` |
| SD 1.5 | `sd15` |
| SDXL 1.0 | `sdxl` |
| Illustrious / NoobAI（近 Illustrious 生态） | `illustrious`（NoobAI 可先 `noobai` 再决定是否合并） |
| Pony | `pony` |
| Wan Video 2.2 I2V-A14B / … | `wan2.2-i2v-a14b`（T2V/TI2V 分子族，勿混用） |
| LTXV 2.3 / LTXV2 / LTXV | `ltx-2.3`（旧 LTXV 标 `ltx-legacy`） |
| MiniMax H3 | `minimax-h3` |
| Hunyuan Video | `hunyuan-video` |
| ZImageTurbo | `z-image-turbo` |
| Krea 2 | `krea-2` |

### 3.2 边类型

| 边 | 方向 | 必备属性 | 含义 |
|----|------|----------|------|
| `instance_of` | BaseModel → BaseFamily | — | 底模实例属于某族 |
| `compatible_with` | LoRA → BaseFamily **或** LoRA → BaseModel | `confidence`, `evidence`, `strength_range?`, `notes?` | 可用 |
| `used_in_slot` | LoRA → EngineSlot | `confidence`, `evidence` | 设置槽展示/生成槽校验（**次于**族兼容） |
| `requires_trigger` | LoRA → TriggerPhrase | `mode`: `all` \| `pick_one` \| `optional` | 怎么用 |
| `recommended_strength` | LoRA → (字面量或挂在 compatible_with 上) | `default`, `min`, `max`, `evidence` | 推荐强度 |
| `conflicts_with` | LoRA → LoRA **或** LoRA → PurposeTag | `scope`: `role` \| `file`, `notes` | 互斥 |
| `substitutes` | LoRA → LoRA | `notes` | 可替换（同作用） |
| `sourced_from` | LoRA → SourceCard | — | 溯源 |
| `purpose` | LoRA → PurposeTag | `grade`: P-A/P-B | 用途（已有 inventory 可投影） |

### 3.3 `compatible_with` 证据级（与来源 A/B/C 对齐但语义不同）

| confidence | 含义 | 典型 evidence |
|------------|------|----------------|
| **A** | 产品点名或本仓实测/策划卡 | `lora_catalog.engines`；gate 默认配方；人工钉选「实测 OK」 |
| **B** | 卡页/官方声明 | Civitai `baseModels`；HF README「for Flux.1-D」；官方包目录 |
| **C** | 命名/路径启发式 | `*_H3*`、`h3/loras/`、`flux`/`wan2.2` 文件名；**不得单独当「已确认兼容」展示为绿灯** |
| **D** | 未知 | 无边；UI 按策略隐藏或「未知」灰显 |

> 注意：来源溯源 A/B（MODEL_SOURCES）≠ 兼容 confidence A/B。一条 LoRA 可以「来源 B + 兼容 C」。

---

## 4. C. 数据从哪来（流水线 · 只设计不实现）

```
┌─────────────────────────────────────────────────────────────┐
│ 输入（只读复用）                                              │
│  · PURPOSE csv（P-A/P-B only for available）                 │
│  · MODEL_SOURCES（repo/url/status）                         │
│  · _card_cache civ/hf（baseModels…）                        │
│  · lora_catalog.py（engines/strength/trigger/conflicts）    │
│  · 路径约定：h3/loras → minimax-h3；toiv/loras 需再判族      │
│  · （P1+）版本卡页 trainedWords / 推荐 weight                 │
│  · （P1+）人工钉选 / 雨夜实测回写                             │
└───────────────────────────┬─────────────────────────────────┘
                            ▼
              scripts/ops/build-model-compat-graph.py（待做）
                            ▼
┌─────────────────────────────────────────────────────────────┐
│ 输出                                                         │
│  · apps/canvas/web/src/generated/model-compat-graph.json    │
│  · docs/ops/MODEL_COMPAT_HUMAN_20261025.md（人读摘要）       │
│  · （可选）docs/ops/MODEL_COMPAT_EDGES.csv 便于 diff         │
└─────────────────────────────────────────────────────────────┘
```

**硬规则**

1. **不回灌** `availability≠available`、P-C、quarantine、来源 C|D、`non_lora`。  
2. catalog 边 → confidence **A**；civ `baseModels` → **B**；仅文件名/目录 → **C**。  
3. 多证据取最高 confidence；冲突证据写入 `notes` + 可选 `conflicts_with` 审查队列。  
4. H3 专属树默认只连 `family:minimax-h3` + `slot:video-primary`（严格分族，见 §H）。  
5. Wan I2V / T2V / TI2V **分子族**；不确定时标 C 并 `notes=side_uncertain`，勿假装 A。

### 4.1 字段映射（join key = basename）

| 目标图谱字段 | 来源 |
|--------------|------|
| `lora.id` | inventory `id` = PURPOSE `basename` |
| `purpose` / grade | PURPOSE `purpose_zh` / `purpose_evidence` |
| `sourced_from` | MODEL_SOURCES `source_url`/`repo`；inventory `sourceUrl` |
| `compatible_with` (B) | civ cache `baseModels` → 族字典 |
| `compatible_with` (A) | catalog `engines` → family/slot 映射表（wan→wan 族+video-motion；h3→minimax-h3+video-primary；…） |
| `compatible_with` (C) | cluster / pathRoot / 文件名正则（现 `slots_for` 逻辑迁到「边生成器」，**不再直接当 UI 过滤真源**） |
| `requires_trigger` / strength | catalog 优先；P1 再补版本卡页 |
| `conflicts_with` | catalog `conflicts`（role）投影为 purpose 互斥；P2 文件级互斥 |
| BaseModel `instance_of` | 产品默认 + NAS 扫描账本（可先手写种子：Qwen-Rapid→qwen-image；H3 fl2va/ref2va→minimax-h3） |

---

## 5. D. 存储形态（务实）

### 5.1 推荐：**并列图谱 JSON + basename join**（不要把 351 库存揉成大杂烩）

| 文件 | 职责 |
|------|------|
| `generated/lora-inventory.json` | **保持**用途/来源/类型/nsfw（设置浏览主表） |
| `generated/model-compat-graph.json` | **新增**节点+边（兼容与用法） |
| 运行时 | `join(inventory.id, graph.lora:<id>)`；UI/Agent 只读合并视图 |

**理由**：库存已接入 UI/单测；兼容边会频繁修订证据级；分文件可独立再生、独立 review；避免 inventory 膨胀和生成脚本职责混杂。

**不推荐 P0**：Neo4j / SQLite 图库（运维重、与 git 账本文化不一致）。  
**可选 P2**：由 JSON 导出 Graphviz/Mermaid 或轻量浏览页。

### 5.2 Schema 示例（缩略）

```json
{
  "generatedAt": "2026-10-25",
  "timezone": "Asia/Shanghai",
  "schemaVersion": 1,
  "joinKey": "basename",
  "inventoryRef": "apps/canvas/web/src/generated/lora-inventory.json",
  "nodes": [
    {"id": "family:qwen-image", "type": "BaseFamily", "label": "Qwen-Image"},
    {"id": "base:Qwen-Rapid-AIO-SFW-v23.safetensors", "type": "BaseModel", "label": "Qwen Rapid AIO SFW v23"},
    {"id": "lora:lightx2v_Qwen-Image-Lightning.safetensors", "type": "LoRA"},
    {"id": "slot:image", "type": "EngineSlot"},
    {"id": "trigger:nsfwsks", "type": "TriggerPhrase", "text": "nsfwsks"}
  ],
  "edges": [
    {
      "type": "instance_of",
      "from": "base:Qwen-Rapid-AIO-SFW-v23.safetensors",
      "to": "family:qwen-image"
    },
    {
      "type": "compatible_with",
      "from": "lora:Anime_Style_Flux1D.safetensors",
      "to": "family:flux.1-d",
      "confidence": "B",
      "evidence": "civitai.baseModels",
      "strength_range": {"default": 0.8, "min": 0.5, "max": 1.0},
      "notes": "卡页声明 Flux.1 D"
    },
    {
      "type": "compatible_with",
      "from": "lora:HMNSFW_AIO_V2.safetensors",
      "to": "family:minimax-h3",
      "confidence": "A",
      "evidence": "lora_catalog.engines=h3",
      "strength_range": {"default": 0.6, "min": 0.4, "max": 0.85}
    },
    {
      "type": "used_in_slot",
      "from": "lora:HMNSFW_AIO_V2.safetensors",
      "to": "slot:video-primary",
      "confidence": "A",
      "evidence": "lora_catalog"
    },
    {
      "type": "requires_trigger",
      "from": "lora:NSFW-22-H-e8.safetensors",
      "to": "trigger:nsfwsks",
      "mode": "all"
    },
    {
      "type": "conflicts_with",
      "from": "lora:NSFW-22-H-e8.safetensors",
      "to": "purpose:concept",
      "scope": "role",
      "notes": "同 role=concept 至多一张"
    }
  ]
}
```

### 5.3 人读视图

`docs/ops/MODEL_COMPAT_HUMAN_*.md`：按 BaseFamily 分组列出「推荐 LoRA（A/B）+ 强度 + 触发 + 槽」；附录「仅 C 启发式、勿当确认」。

---

## 6. E. 产品面怎么用

### 6.1 设置页（常用 · 出图/视频主/运动）

1. 用户选定槽位底模（或显示当前绑定名）→ 解析 `BaseModel` → `BaseFamily`。  
2. LoRA 弹层数据源：`inventory ∩ compatible_with(family|base)`。  
3. **排序**：`confidence A` → `B` →（若策略允许）`C`；同级内 P-A 用途优先，再按 typeTag。  
4. **卡片字段**：用途文案、typeTag、trigger 芯片、推荐强度（可一键填入挂件）、来源链、兼容徽章（A/B/C）、不兼容原因（若灰显）。  
5. 挂件仍 ≤3 + 强度；强度默认取边上 `strength_range.default`，否则 0.6。

### 6.2 过滤策略（与 §H 决策联动）

| 关系 | 默认推荐行为 |
|------|----------------|
| 有 A/B 兼容边 | 展示 |
| 仅 C | **灰显 +「命名推断，未确认」**（推荐）或隐藏（若用户选严格） |
| 无边 / D | 隐藏（严格）或灰显不可点 |
| 明确 `compatible_with` 指向**其他族**且与当前族无边 | 不展示；强制添加需专家开关 |

### 6.3 配方快捷

配方 JSON 存边引用，例如：

```json
{
  "slot": "image",
  "base": "Qwen-Rapid-AIO-SFW-v23.safetensors",
  "loras": [
    {"id": "….safetensors", "strength": 0.7, "triggers": ["…"], "edgeEvidence": "A"}
  ]
}
```

点配方 = 预填槽位；手改后取消「配方高亮」（已有 MODEL_MIX 心智）。

### 6.4 生成接线（P1）

钉选注入前：`assert compatible(current_base, lora)`；失败则阻断或降级提示，**不静默提交**。  
Wan 侧别（high/low）继续尊重 catalog `wan_side`。

---

## 7. F. AI 消费契约

### 7.1 查询约定（P0 可读 JSON；P1 可包一层 TS/Python helper）

```text
query_compat({
  base_id?: string,       # basename of checkpoint/diffusion
  family?: string,        # slug without family: prefix
  slot?: "image"|"video-primary"|"video-motion",
  min_confidence?: "A"|"B"|"C",  # default "B"
  include_triggers?: boolean,
  exclude_nsfw?: boolean
}) → {
  base_family: string,
  items: Array<{
    lora_id: string,
    label: string,
    purpose_zh: string,
    purpose_grade: "P-A"|"P-B",
    confidence: "A"|"B"|"C",
    strength: {default: number, min?: number, max?: number},
    triggers: string[],
    trigger_mode?: "all"|"pick_one"|"optional",
    conflicts: string[],
    source_url?: string,
    notes?: string
  }>
}
```

实现：先 `instance_of` 解析 family；筛 `compatible_with`；再与 inventory 内连接；按 slot 的 `used_in_slot` 二次过滤（无 slot 边时：A/B 族兼容仍可出，C 则保守丢弃）。

### 7.2 Agent 提示词约束（摘要）

- 只使用 `query_compat` 返回的 `lora_id`；禁止凭文件名猜测跨族搭配。  
- 必须带上返回的 `triggers`（按 `trigger_mode`）。  
- `confidence=C` 仅当用户/工具显式 `min_confidence=C` 且 UI 已警告。  
- 提交前检查 `conflicts` 与已选列表。

### 7.3 与策划卡关系

| | lora_catalog | 图谱 |
|--|--------------|------|
| 范围 | ~21 产品点名 | 351+ 可用库存 |
| 权威 | 提交链路文件名/强度的**硬来源**之一 | 浏览/过滤/Agent 发现的**真源** |
| 同步 | 构建图谱时 ingest catalog → A 边 | 不反向自动改 catalog |

---

## 8. G. 分阶段落地（只方案）

### P0 — 本体 + 可自动边 + 过滤接线准备

- 定 schemaVersion=1；族字典；种子 BaseModel（产品默认 Qwen-Rapid、H3 fl2va/ref2va 等）。  
- 从 civ `baseModels` + catalog.engines + 路径约定生成 `compatible_with` / `used_in_slot`。  
- 产出 `model-compat-graph.json` + 人读 md。  
- 设置页：**按当前底模族过滤**（替换「仅 slots 启发式」为「族边优先，slots 降级」）。  
- **仍不** commit / push / 部署（P0 实现另见代码与 TEST_LOG）。

### P1 — 用法进 UI + 钉选校验

- 加深抓 trainedWords / 推荐 weight（版本页）；catalog 触发/强度进卡片。  
- 钉选注入生成前兼容校验；配方引用边。  
- 基座下拉接 NAS 全量时，每项带 `family` 供过滤。

### P2 — 实测与冲突深化

- 人工/雨夜实测回写 confidence A；`conflicts_with` 文件级；`substitutes`。  
- 可选：简易图谱可视化；HardwareProfile。  
- 仍可保持 JSON 账本，不必上图数据库。

### 明确边界

- 文档阶段已结束；P0 实现中，**仍不 commit/push/部署**。  
- P-C 隔离维持；图谱构建输入白名单 = 当前 inventory 规则。

---

## 9. H. 决策点（**已拍板 2026-10-25：全部按推荐**）

| # | 分叉 | 选项 | **拍板** |
|---|------|------|----------|
| D1 | **兼容未知（无边 / 仅 C）** | (a) 隐藏 (b) 灰显可强制 (c) 与兼容项混排但标警告 | **(b) 灰显可强制**：仅 C 灰显 +「命名推断，未确认」，仍可选；默认排序沉底 |
| D2 | **H3 LoRA 与出图 LoRA** | (a) 严格分族、禁止跨槽 (b) 允许专家跨挂 | **(a) 严格分族**：`h3/loras` / `catalog:h3` / `h3_family` / `minimax-h3` 只进 `video-primary`；出图/运动不展示 H3 专属；H3 槽不展示出图族 |
| D3 | **图谱存储** | (a) JSON 账本 (b) 上 Neo4j/图 DB | **(a) JSON**：`generated/model-compat-graph.json` |
| D4 | **inventory vs 图谱** | (a) 合并进 inventory (b) 并列 + basename join | **(b) 并列**：basename join，勿揉进 inventory |

---

## 10. 成功标准（实现后验收，现仅作契约）

1. 选定 `Qwen-Rapid-AIO-SFW-v23` 时，列表中 **A/B 兼容**项均属 `qwen-image`（或文档声明的兼容族），无 H3/Wan 视频专属 LoRA 混入绿灯区。  
2. 选定 H3 默认权重时，仅见 `minimax-h3` 兼容项。  
3. Agent `query_compat(base=…, min_confidence=B)` 不返回仅 C 边。  
4. 任一张 catalog LoRA 在图谱中有 confidence=A 的兼容边与强度/冲突投影。  
5. P-C / quarantine basename **零出现**于 query 默认结果。

---

## 11. 附录：与现启发式的迁移

| 现逻辑 | 迁移后 |
|--------|--------|
| `slots_for(path, cluster)` 直接写入 inventory.slots | 生成 **C 级** `used_in_slot` + 可能的 C 级 `compatible_with`；UI **不以** inventory.slots 为唯一过滤 |
| `mergeLoraCandidates` 按槽拉全量库存 | 增加 `filterByCompat(family)` |
| 默认 strength 0.6 | 边上 default → 回退 0.6 → catalog 覆盖 |

---

## 12. 文档与代码锚点（实现时）

| 路径 | 角色 |
|------|------|
| 本文件 | 方案真源 |
| `scripts/ops/gen-lora-inventory-json.py` | 用途库存；保持 |
| `scripts/ops/build-model-compat-graph.py` | **待建** |
| `apps/canvas/web/src/lib/lora-inventory.ts` | 库存 API |
| `apps/canvas/web/src/lib/slot-lora.ts` | 挂件；P0 接过滤 |
| `apps/api/app/services/lora_catalog.py` | A 级边输入 |
| `docs/ops/_card_cache_20261025/` | B 级 baseModels |
| `docs/MODEL_SOURCES.json` | 溯源；可选回写 `base_family` 摘要到 notes（非必须） |

---

**结语**：先把「用途库存」升级为「用途 + 兼容 + 用法」双表知识图谱；人看过滤后的卡片，AI 走 `query_compat`。P0 用卡页 baseModels + catalog 就能消掉最大误挂面；trigger/强度与生成校验放 P1。§H 已于 2026-10-25 全部按推荐拍板并进入 P0 实现。
