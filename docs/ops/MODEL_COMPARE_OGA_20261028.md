# OGA × ToIV 模型对照简报（2026-10-28）

- **对照源**：Anil-matcha/Open-Generative-AI（MIT）`packages/studio/src/models.js`（主表）+ 根目录 `models_dump.json`（仅 t2i 残片，**不以 dump 为全量**）
- **ToIV SSOT**：MateBook `docs/MODEL_SOURCES.json`（`updated_at=2026-10-27T05:16:04+08:00` Asia/Shanghai）；`MODEL_SOURCES.md` 本机未找到（仅有 JSON）
- **口径**：OGA = **云端 API 路由名**；ToIV 账本 = **本地 Comfy 权重溯源**。二者不可直接一一入库；云端名进「观察/渠道能力」清单，权重进账本。标签：`[cloud-api]` / `[local-weight]`
- **网关**：**禁止**写成只能走 MuAPI。OGA 表虽同步自 MuAPI schema，ToIV 已有/可选用：**火山方舟直连、BeefAPI/NewAPI 聚合、厂商直连、HF/Civitai 本地权重** 等
- **动作约束**：只建议，**未改** `MODEL_SOURCES.json`，**未 commit/push**，未下载

---

## 1. 分类计数

### OGA（`models.js` 解析，约 585 条 / 580 unique id）

| 报告类别 | 条数 | 对应 export 数组 |
|---|---:|---|
| image | 172 | t2iModels 84 + i2iModels 88 |
| video | 372 | t2v 111 + i2v 184 + v2v 75 + motionControl 2 |
| audio | 23 | audioModels |
| lip-sync | 15 | lipsyncModels |
| 其他 | 3 | recastModels |
| **合计** | **585** | |

`models_dump.json` 仅含 `t2i: 50`（残缺），计数以 `models.js` 为准。注释称 verified vs `api.muapi.ai/openapi.json`（2026-09-09）；表内已含 Seedance 2.5 / Nano Banana 2 / Grok Imagine 等更新路由。

### ToIV 账本 SSOT（本地权重；粗分 modality，口径≠ OGA）

| totals | |
|---|---:|
| ok | 671 |
| blocked | 384 |
| total / items | 1056 |

粗分 modality（basename/notes 启发式，**非**云端 API 分类）：

| 类别 | 全部 | ok | blocked |
|---|---:|---:|---:|
| image | 607 | 307 | 300 |
| video | 362 | 287 | 74 |
| audio | 7 | 7 | 0 |
| llm | 18 | 17 | 1 |
| lip-sync | 2 | 1 | 1 |
| other | 60 | 52 | 8 |

**口径差异**：账本无「云端 image/video API」轴；Seedance/NanoBanana/Grok Imagine 等云端名 **预期不在** `MODEL_SOURCES`。产品侧云端覆盖见 Canvas（Ark / BeefAPI / NewAPI），不记入本账本 ok/blocked。

---

## 2. 优先关键词：缺 / 偏旧 / 对齐（Top 清单）

说明列「ToIV 现状」= 账本本地 + 画布云端线索（SSOT 合并为准）。

| # | 模型族 / 代表名 | 标签 | OGA 出处 | ToIV 现状 | 建议动作 | 优先级 |
|---:|---|---|---|---|---|---|
| 1 | **Seedance 2.5**（`seedance-2.5-*`，OGA ~74 路由含 spicy/omni/4k） | cloud-api | models.js t2v/i2v/v2v/motion | 账本：**无**；画布：**有** `seedance-2.5` / `seedance-2.5-official`（Ark/BeefAPI/NewAPI） | 保持多网关；对照 OGA 补能力矩阵（omni-ref / spicy / motion-control / 4K），**勿**当本地权重入库 | P0 |
| 2 | **Seedance 2.0**（`seedance-2-*` / `seedance-v2.0-*`，~57） | cloud-api | 同上 | 账本：无；画布：有 `seedance-2.0` / `seedance-2.0-official2` / mini/fast | 与 2.5 分版本约束（已有文档）；核对 OGA 细分路由是否需渠道别名 | P0 |
| 3 | **Nano Banana 2**（`nano-banana-2` / `2-1` / `2-lite` + edit） | cloud-api | t2i/i2i | 账本：无（仅 blocked `eigen-banana-*-lora`，无关）；画布：prompt 插件识别 `nano-banana`，**未见 2/2.1 显式** | 渠道目录补 NB2 系列；网关可选厂商/聚合，**非** MuAPI-only | P0 |
| 4 | **Nano Banana Pro / 1**（`nano-banana` / `pro` + edit/effects） | cloud-api | t2i/i2i | 账本：无；画布：名称启发式有 | 确认渠道是否已挂 Pro；缺则 P1 补 | P1 |
| 5 | **Grok Imagine Image 2**（`grok-imagine-image-2` + edit） | cloud-api | t2i/i2i | 账本：无；画布：有 `grok-imagine-image` / `grok-imagine-image-quality`，**未见 Image 2.0** | 评估 xAI/聚合上架 Image 2；更新能力表 | P0 |
| 6 | **Grok Imagine Video**（t2v/i2v/extend / `video-1-5-preview`） | cloud-api | t2v/i2v | 账本：无；画布：**未见** Grok 视频模型别名 | 产品要则走聚合/厂商；列入云端观察 | P1 |
| 7 | **口型 · InfiniteTalk**（image/video→video） | cloud-api | lipsyncModels | 账本：无；画布：无显式 | 云端口型 P0 候选；本地继续 MuseTalk | P0 |
| 8 | **口型 · OmniHuman 1.5** | cloud-api | lipsyncModels | 账本：无 | 短剧口型观察；多网关探测可用性 | P0 |
| 9 | **口型 · LatentSync / Sync / Creatify / Veed / Volcengine lip** | cloud-api | lipsyncModels | 账本：无 | P1 抽样；Volc 可与方舟同生态 | P1 |
| 10 | **口型 · Kling Avatar v1/v2** | cloud-api | lipsyncModels | 账本：无 | 与现有 Kling 视频渠道一并评估 | P1 |
| 11 | **口型 · LTX 2.3 / 2-19B lipsync** | cloud-api + 本地线索 | lipsyncModels | 账本：无独立 lipsync 权重名；知识库有 LTX 2.3 R18 lipsync 逻辑名 | 本地 LTX 与云端 LTX-lipsync **分表**；勿混 | P1 |
| 12 | **口型 · Wan2.2 Speech-to-Video** | cloud-api | lipsyncModels | 账本：无 wan2.2 STV；有其他 Wan 本地视频权重可能 | 云端能力观察；本地 Wan≠该 API | P2 |
| 13 | **本地口型 MuseTalk** | local-weight | （OGA 无同名） | 账本：**ok** `musetalk` | 保持；OGA 云端口型作补充而非替换 | —（已有） |
| 14 | **Seedream 5.0 / 4.5**（含 Pro/Flash/edit/layer） | cloud-api | t2i/i2i | 账本：无；方舟预设含「即梦图片」 | 核对 Ark/BeefAPI 是否已挂 5.0；缺则补渠道名 | P1 |
| 15 | **FLUX.2**（dev/flex/pro/klein 4b/9b + edit/lora） | cloud-api + local | t2i/i2i | 账本：Klein 等 **有多条**（ok+blocked）；云端 FLUX.2 API 名未进账本 | 本地 Klein 继续账本治理；云端 FLUX.2 API 另列渠道 | P1（云）/ 账本已有本地 |
| 16 | **GPT Image 2 / 2.5 Flare·Sunburst** | cloud-api | t2i/i2i | 账本：无；画布：未见显式 | 观察 OpenAI/聚合上架 | P2 |
| 17 | **Veo 3.1 / Veo 4** | cloud-api | t2v/i2v | 账本：无 | Google/聚合渠道评估 | P1 |
| 18 | **Wan 2.5 / 2.6**（t2i/t2v/i2v/edit） | cloud-api | 多数组 | 账本：无 2.5/2.6 字面（或有更早 Wan） | 云端新版观察；本地权重另溯源 | P1 |
| 19 | **Happy Horse 1**（多分辨率/ref/edit） | cloud-api | t2v/i2v/v2v | 账本：无；画布：无 | 新家族，P2 观察 | P2 |
| 20 | **Vidu Q3 / Q4** | cloud-api | t2v/i2v | 账本：无 | 相对 Q2 升级；渠道评估 | P2 |
| 21 | **Kling O1**（image/video/ref） | cloud-api | 多数组 | 账本：无 | 与现有视频渠道对照 | P1 |
| 22 | **Seedance motion-control**（`seedance-2` / `2.5` / spicy） | cloud-api | motionControlModels | 账本：无；画布：未见 motion-control 专用别名 | 2.5 能力补全时一并 | P1 |
| 23 | **MiniMax Music/Speech 2.6**（OGA audio） | cloud-api | audioModels | 账本：本地 **H3 视频权重充足**；云端 speech/music API 未进账本 | 音视频云端与本地 H3 **分表** | P2 |

---

## 3. 建议入库优先级（只建议，不改 JSON）

此处「入库」= **云端渠道/能力清单或观察表**，**不是**把 API 名写入本地权重 `MODEL_SOURCES`。

| 优先级 | 条数（族） | 建议 |
|---|---:|---|
| **P0** | 5 | Seedance 2.5 能力对齐；Seedance 2.0 别名核对；Nano Banana 2；Grok Imagine Image 2；口型 InfiniteTalk + OmniHuman |
| **P1** | 10 | Nano Banana Pro；Grok Imagine Video；其余口型（LatentSync/Sync/Kling Avatar/LTX-lipsync）；Seedream 5；云端 FLUX.2；Veo 3.1/4；Wan 2.5/2.6；Kling O1；Seedance motion-control |
| **P2** | 4+ | GPT Image 2/2.5；Happy Horse；Vidu Q3/Q4；MiniMax 云端 audio；Wan2.2 STV |

**不要做**：把 OGA/MuAPI endpoint 批量塞进 `MODEL_SOURCES.json`；把云端名当 Comfy 权重下载。

**网关原则**：同一能力可 **Ark 直连 / BeefAPI·NewAPI / 其他聚合 / 厂商** 多选；OGA 仅作命名与能力对照源。

---

## 4. 证据与路径

| 项 | 路径 |
|---|---|
| OGA models.js（raw） | `https://raw.githubusercontent.com/Anil-matcha/Open-Generative-AI/main/packages/studio/src/models.js` |
| OGA models_dump.json | 同仓根；仅 t2i×50 |
| 箱上缓存 | `/workspace/oga-compare/models.js`、`models_dump.json`、`oga_catalog_compact.json` |
| ToIV SSOT | MateBook `/Users/wangzhenyu/Desktop/ALLProject/ToIV/docs/MODEL_SOURCES.json`；箱副本 `/workspace/uploads/MODEL_SOURCES.json` |
| 本简报（箱） | `/workspace/docs/ops/MODEL_COMPARE_OGA_20261028.md` |
| 本简报（MateBook，若已写入） | `ToIV/docs/ops/MODEL_COMPARE_OGA_20261028.md` |

---

## 5. 声明

- 以 ToIV 账本为 SSOT 合并结论；OGA 仅对照  
- 云端 API 名与本地权重 **分表**  
- **未改账本、未 commit、未 push、未下载**  
- **非** MuAPI 唯一网关  
