# ToIV 云端模型能力矩阵 · P0（2026-10-28）

- **性质**：云端观察表 / 渠道能力对齐清单（**不是**本地权重账本）
- **明确不写进** `docs/MODEL_SOURCES.json`（权重溯源 SSOT 保持不动）
- **对照源**：OGA `packages/studio/src/models.js`（箱缓存 `/workspace/oga-compare/`）；ToIV 画布代码只读（MateBook `ALLProject/ToIV/apps/canvas`）
- **账本对照 SSOT**：`docs/ops/MODEL_COMPARE_OGA_20261028.md`
- **网关原则**：**非** MuAPI-only。同一能力可观察 Ark 直连 / BeefAPI·NewAPI 聚合 / 厂商直连（xAI 等）/ 本地 Comfy 替代
- **「渠道可调」口径**：代码与文档中已有模型别名 + 能力叠加/任务模式，且有 BeefAPI 企业渠道验证记录者 → **已静默上架**；仅出现在 OGA SKU 表、ToIV 无别名/无操作面 → **缺口** 或 **仅 OGA 有**
- **本轮未做**：付费实调渠道目录、改代码、改账本、commit/push、动 tip/前端壳
- **动作约束**：只观察建议；**未改** `MODEL_SOURCES.json`，**未 commit/push**，未改前端

---

## 0. 读表约定

| 列 | 含义 |
|---|---|
| OGA 有无 | Open-Generative-AI `models.js` 是否有对应路由/族 |
| 渠道可调 | ToIV 画布/渠道层是否已有可选用的模型别名或等价操作面 |
| 网关 | Ark=火山方舟；BeefAPI·NewAPI=企业聚合 `/v1/videos` 等；厂商=xAI 等；本地=Comfy/引擎；未知=OGA/MuAPI 命名线索，未钉 ToIV 网关 |
| 状态 | **已上架**=已静默可走；**缺口**=产品需要但渠道未挂；**仅 OGA**=对照源有、ToIV 无且暂不要求等价 SKU 爆炸 |

OGA Seedance 2.5 共 **74** 条路由（std / intl / spicy × 模式 × 分辨率 SKU）。ToIV 采用 **家族→版本→任务模式**（单模型别名 + operation/task_type），**不应**把 74 条当 74 个产品入库。

---

## 1. Seedance 2.5 能力对齐（相对画布已有 2.0 / 2.5）

### 1.1 已挂别名（渠道侧）

| 别名（代表） | 网关线索 | 证据摘要 |
|---|---|---|
| `seedance-2.5` | BeefAPI·NewAPI、openai-videos、Ark 兼容 | `video_contracts.json`；`model-provider-validation.md` BeefAPI 实任务完成；能力叠加 `isSeedance25Model` |
| `seedance-2.5-official` | BeefAPI / WhatsToken 线路 | 约束测试与 `seedance-channel-warning`；首帧 adaptive 特殊合同 |
| `seedance-2.5-self-developed` | 聚合/渠道目录别名 | 参考时长测试认 30s 上限 |
| `doubao-seedance-2-5*` / `doubao-seedance-2.5*` | **Ark 直连** | `volcengine-ark-video` 协议；`channel_models` 映射 `seedance-2-5-480p`→`doubao-seedance-2-5` |
| `seedance-2.0` / `-fast` / `-mini` / `-official2` | BeefAPI·NewAPI、Ark | 验证文档与警告名单；与 2.5 **分版本约束** |

### 1.2 能力矩阵

| 模型族 | 能力/变体 | OGA 有无 | 渠道可调 | 网关 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| Seedance 2.5 | **t2v**（文生视频） | 有（含 480p/1080p/4k SKU） | **是**（同别名 + 文生） | Ark / BeefAPI·NewAPI | **已上架** | OGA 拆分辨率 SKU；ToIV 用分辨率参数，非独立 id |
| Seedance 2.5 | **i2v**（图生 / 参考图） | 有 | **是** | Ark / BeefAPI·NewAPI | **已上架** | `image_to_video` / 参考图角色 |
| Seedance 2.5 | **首尾帧** first/last frame | 有（`first-last-frame*`） | **是** | Ark / BeefAPI·NewAPI | **已上架** | role=`first_frame`/`last_frame`；比例 adaptive |
| Seedance 2.5 | **omni-ref** 全能参考 | 有（`omni-reference*`） | **是** | Ark / BeefAPI·NewAPI | **已上架** | `reference_to_video`；wire `omni_reference_task_type=reference`；2.5 参考上限图30/视10/音10 |
| Seedance 2.5 | **v2v edit** 视频编辑 | 有（`video-edit*`） | **是** | Ark / BeefAPI·NewAPI | **已上架** | task_type=`edit`；时长随原视频 |
| Seedance 2.5 | **v2v extend** 延长 | 有（`video-extend*`） | **是** | Ark / BeefAPI·NewAPI | **已上架** | task_type=`extend` |
| Seedance 2.5 | **audio_to_video** | OGA 多并入 omni/参考族 | **是**（2.5 叠加） | Ark / BeefAPI·NewAPI | **已上架** | 能力层显式追加 `audio_to_video` |
| Seedance 2.5 | **4K** 输出/SKU | 有（`*-4k` 多条） | **部分** | BeefAPI·NewAPI / Ark（参数层） | **已上架（参数）/ SKU 缺口** | 通用分辨率有 `4k`→`2160p` 映射；**无** `seedance-2.5-*-4k` 独立别名。是否某渠道目录静默返回 4k 档需实目录复核 |
| Seedance 2.5 | **spicy** 全模式矩阵 | 有（~24 条 spicy） | **否** | 未知（OGA/MuAPI 命名） | **仅 OGA / 缺口（政策）** | 代码库 **零** `spicy` 命中；需 NSFW 政策决策，禁止静默抄路由 |
| Seedance 2.5 | **intl** 国际线矩阵 | 有（~24 条 intl） | **否**（无独立别名） | 未知；或被官方/聚合吞并为同一上游 | **仅 OGA** | ToIV 用 `*-official` / Ark 原生名，不拆 intl SKU |
| Seedance 2.5 | **motion-control** | 有（`intl`/`spicy`×2） | **否** | 未知 | **缺口** | 画布无 motion-control 一等操作/别名；勿与 omni-ref 混称 |
| Seedance 2.0 | 标准/fast/mini/official2 | 有（~57 路由族） | **是** | Ark / BeefAPI·NewAPI | **已上架** | 与 2.5 分约束；勿套 2.5 edit/extend 规则 |

### 1.3 Seedance 对齐结论

- **主干能力（t2v / i2v / omni-ref / 首尾帧 / edit / extend / 参考音）已在渠道静默上架**，走「单别名 + 任务模式」，对齐火山 2.5 指南，而非 OGA 74 SKU。
- **真正缺口**：motion-control 一等能力；spicy（政策）；独立 4K/480p SKU 是否要在 picker 暴露（产品可选，非账本项）。
- **网关**：已证实多通道（Ark 插件 `volcengine-ark-seedance*`、BeefAPI enterprise、NewAPI videos contract），**禁止**写成只能 MuAPI。

---

## 2. Nano Banana 2

| 模型族 | 能力/变体 | OGA 有无 | 渠道可调 | 网关 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| Nano Banana 2 | `nano-banana-2` t2i | 有 | **否** | 未知（厂商/聚合；OGA 来自 MuAPI schema） | **缺口** | 画布无显式模型 id |
| Nano Banana 2 | `nano-banana-2-1` | 有 | **否** | 未知 | **缺口** | |
| Nano Banana 2 | `nano-banana-2-lite` | 有 | **否** | 未知 | **缺口** | |
| Nano Banana 2 | `*-edit`（2 / 2-1 / 2-lite） | 有 | **否** | 未知 | **缺口** | |
| Nano Banana 1 / Pro | `nano-banana` / `nano-banana-pro` / `pro-4k` | 有（Pro/1 族） | **部分启发式** | Gemini 图像路径启发式；聚合目录若返回则可挂 | **偏旧 / 未钉 2.x** | `prompt-optimizer` / 配置启发式含 `nano-banana`；**未见** `nano-banana-2*` 字面 |

**结论**：NB2 全系列为 **P0 缺口**。上架时应走多网关探测（聚合目录 / 厂商），**非** MuAPI-only；不要写入 `MODEL_SOURCES`。

---

## 3. Grok Imagine Image 2

| 模型族 | 能力/变体 | OGA 有无 | 渠道可调 | 网关 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| Grok Imagine Image | `grok-imagine-image`（≈ OGA text-to-image） | 有（旧路由名） | **是** | **xAI** `grok-image` / 聚合 NewAPI | **已上架** | 能力层认 `grok-imagine-image*` 前缀 |
| Grok Imagine Image | `grok-imagine-image-quality` | 有（quality） | **是** | xAI / 聚合 | **已上架** | 专用提示词字节上限校验 |
| Grok Imagine Image 2 | `grok-imagine-image-2` | 有 | **否** | 未知（xAI/聚合待探） | **缺口** | 代码库 **零** `grok-imagine-image-2` |
| Grok Imagine Image 2 | `grok-imagine-image-2-edit` | 有 | **否** | 未知 | **缺口** | |
| Grok Imagine（参考）Image→Image | `grok-imagine-image-to-image` | 有 | **未钉专用别名** | xAI 插件能力范围待目录复核 | **观察** | 非本轮 P0 强制，但与 edit 相关 |
| Grok Imagine Video 1.5 | `grok-imagine-video-1.5` 等 | 有 | **是**（验证文档） | BeefAPI·NewAPI | **已上架（视频，P1 观察）** | 本矩阵 P0 聚焦 Image 2；视频已有渠道证据 |

**结论**：Image / quality **已上架**；**Image 2 + edit 为缺口**。优先在 xAI / BeefAPI 目录核对是否已静默出现 2.0 id，再决定别名映射。

---

## 4. 云端口型 · InfiniteTalk + OmniHuman

| 模型族 | 能力/变体 | OGA 有无 | 渠道可调 | 网关 | 状态 | 备注 |
|---|---|---|---|---|---|---|
| InfiniteTalk | `infinitetalk-image-to-video`（云） | 有 | **否（云）** | 未知（OGA/MuAPI） | **云端缺口** | 画布无云端 InfiniteTalk 别名 |
| InfiniteTalk | `infinitetalk-video-to-video`（云） | 有 | **否（云）** | 未知 | **云端缺口** | |
| InfiniteTalk | **本地** Comfy 实例 / 权重 | OGA 无同名本地项 | **是（本地）** | **本地** `infinitetalk_base_url`（API config）；inventory 有 Wan2.1-InfiniteTalk 权重名 | **本地已有替代** | ≠ OGA 云端路由；产品可继续本地，云端作补充 |
| OmniHuman | `omnihuman-1-5` | 有 | **否** | 未知 | **缺口** | 全树检索无云端别名 |
| 同能力本地口型 | MuseTalk / LTX lipsync / avatar-talk | OGA 另有 LTX-lipsync 云 SKU | **是（本地）** | 本地引擎：`musetalk`（账本 ok）、`ltx-nsfw-lipsync`、`avatar-talk` | **本地已上架（非云）** | 与云端 InfiniteTalk/OmniHuman **分表**；勿把本地当 OGA SKU 已覆盖 |

**结论**：云端 InfiniteTalk + OmniHuman 均为 **P0 缺口**。本地已有对口型/数字人能力，云端上架需多网关探测可用性与短剧链路集成点，仍 **非** MuAPI-only。

---

## 5. 总表（P0 压缩）

| 模型族 | 能力/变体 | OGA | 渠道可调 | 网关 | 状态 |
|---|---|---|---|---|---|
| Seedance 2.5 | t2v / i2v / omni-ref / 首尾帧 / edit / extend / a2v | ✓ | ✓ | Ark / BeefAPI·NewAPI | 已上架 |
| Seedance 2.5 | 4K（参数） | ✓ SKU | 部分 | Ark / BeefAPI·NewAPI | 参数已上架；独立 SKU 可选 |
| Seedance 2.5 | spicy 矩阵 | ✓ | ✗ | 未知 | 仅 OGA / 政策缺口 |
| Seedance 2.5 | intl 矩阵 | ✓ | ✗ 独立别名 | 或并入官方线 | 仅 OGA |
| Seedance 2.5 | motion-control | ✓ | ✗ | 未知 | **缺口** |
| Seedance 2.0 | 标准/fast/mini/official2 | ✓ | ✓ | Ark / BeefAPI·NewAPI | 已上架 |
| Nano Banana 2 | 2 / 2-1 / 2-lite ± edit | ✓ | ✗ | 未知 | **缺口** |
| Nano Banana Pro/1 | pro / pro-4k 启发式 | ✓ | 部分 | Gemini/聚合启发式 | 偏旧 |
| Grok Imagine Image | image / image-quality | ✓ | ✓ | xAI / 聚合 | 已上架 |
| Grok Imagine Image 2 | image-2 ± edit | ✓ | ✗ | 未知 | **缺口** |
| InfiniteTalk | 云 I2V / V2V | ✓ | ✗ | 未知 | **云端缺口** |
| InfiniteTalk | 本地 Comfy | — | ✓ 本地 | 本地 | 本地已有 |
| OmniHuman 1.5 | 云口型 | ✓ | ✗ | 未知 | **缺口** |

---

## 6. P0 缺口列表（仅缺口，可执行）

1. **Seedance 2.5 motion-control**：在 Ark / BeefAPI·NewAPI 目录探测是否已有等价能力；有则加一等操作/别名，无则记观察；**勿**与 omni-ref 混名。
2. **Seedance spicy（政策）**：产品确认是否允许 NSFW 向 spicy 路由；允许再谈多网关别名，默认不静默上架。
3. **Seedance 4K SKU 复核**（可选）：对 BeefAPI/Ark 实目录确认 2.5 是否暴露 2160p/4k；仅参数够用则保持现状。
4. **Nano Banana 2 / 2-1 / 2-lite + edit**：聚合与厂商目录探测；挂渠道名与图像协议，**不**进 `MODEL_SOURCES`。
5. **Grok Imagine Image 2 + edit**：在 xAI / BeefAPI 目录核对；相对已有 `grok-imagine-image` / `-quality` 做版本别名。
6. **云端 InfiniteTalk**（I2V+V2V）：多网关可用性探测；与本地 InfiniteTalk/MuseTalk **分表**，决定短剧是否切云。
7. **云端 OmniHuman 1.5**：同上；短剧口型候选，与 Kling Avatar（P1）一并评估。

---

## 7. 已上架摘要（短）

- **Seedance 2.5**：`seedance-2.5` / `-official` / `-self-developed` / `doubao-seedance-2-5*`；omni-ref、首尾帧、edit、extend、参考音；网关 Ark + BeefAPI·NewAPI（有验证任务）。
- **Seedance 2.0**：`seedance-2.0` / `-fast` / `-mini` / `-official2`。
- **Grok Imagine Image**：`grok-imagine-image`、`grok-imagine-image-quality`（xAI/聚合）；视频 1.5 另有 BeefAPI 验证（非本 P0 缺口）。
- **口型本地**：InfiniteTalk Comfy 实例 + 权重名、MuseTalk（账本）、LTX lipsync、avatar-talk —— **非** OGA 云端 SKU。

---

## 8. 证据路径

| 项 | 路径 |
|---|---|
| 本矩阵（箱） | `/workspace/docs/ops/CLOUD_MODEL_MATRIX_P0_20261028.md` |
| 本矩阵（MateBook） | `ToIV/docs/ops/CLOUD_MODEL_MATRIX_P0_20261028.md` |
| OGA×ToIV 对照 SSOT | `docs/ops/MODEL_COMPARE_OGA_20261028.md` |
| OGA 缓存 | `/workspace/oga-compare/models.js`、`oga_catalog_compact.json` |
| Seedance 能力叠加 | `apps/canvas/backend/internal/modelcatalog/seedance.go`、`capability.go`；`web/src/lib/model-capabilities.ts` |
| Seedance 任务模式 | `protocol/seedance_constraints.go`；`docs/.../seedance-task-constraints.mdx` |
| BeefAPI 视频合同 | `providerpreset/video_contracts.json`；`docs/model-provider-validation.md` |
| Grok 图像 | `grok-image-prompt-limit.ts`；plugin `xai-grok-images` |
| 本地 InfiniteTalk | `apps/api/app/config.py` `infinitetalk_base_url` |

---

## 9. 声明

- 云端观察表口径；**不**写入 `MODEL_SOURCES.json`
- **未改**账本、**未** commit/push、**未**改 tip/前端壳
- **非** MuAPI 唯一网关
- 「渠道可调」以代码别名 + 已有验证文档为准；**未**本轮付费拉取企业实时目录——缺口项执行时需实目录复核
