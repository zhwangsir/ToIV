# ToIV 模型保鲜扫描基线报告

> **现状补记（2026-10-22 接棒）**：本基线扫描时 gate 仍钉 **SFW-v11**。同日 Wave M1② 已拉 **SFW-v23** 并完成 smoke；**03:50 起 live gate / 仓库模板已切 `Qwen-Rapid-AIO-SFW-v23.safetensors`**（见 `docs/ops/WAVE_M_PROGRESS_20261022.md` Gate 切换验收）。下文保留扫描当时结论作历史；「可升级 / 钉死 v11」条目对 **gate 指针** 已过时，对盘面双轨叙事仍有效。

- **扫描时间**：2026-10-22 00:55 Asia/Shanghai
- **执行器**：ToIV 模型保鲜扫描（只读；不下载、不改账本、不删文件、不重启服务）
- **账本**：`MODEL_SOURCES.json`（updated_at=2026-10-13T08:08:41+08:00）
- **盘扫选模**：`NAS_MODEL_PICKER.json`（updated_at=2026-10-09 22:22 Asia/Shanghai）
- **权重校准**：`AGENTS.md` §三（Workstation 服务与端口）+ §四（NAS）+ `NAS_MODEL_PICKER.md` 画布协议
- **上游核查手段**：HuggingFace REST `api/models` + `tree/main?recursive=1`（2026-10-22 实查）；禁止凭记忆编造版本

---

## 0. 纪律与假设

### 假设（交叉「在用 / 账本有盘上无 / 盘上有账本无」）

本任务 **未挂载 NAS、未 SSH 真机列目录**。推断口径：

| 标签 | 推断规则 |
|------|----------|
| **在用** | 出现在 `NAS_MODEL_PICKER`（盘扫刷新）且/或 `AGENTS`/`PICKER.md` 写死的产品默认文件名 |
| **账本有·盘上倾向有** | `MODEL_SOURCES.status=ok` 且 basename ∈ picker |
| **盘上有·账本无** | basename ∈ picker 且 ∉ ledger items |
| **账本有·盘上倾向无** | `status=ok` 且 basename ∉ picker（可能路径/别名不一致，或盘扫未收录目录型条目） |
| **provenance 缺口** | picker 有、ledger 无精确 basename（尤其 H3 生产 int8） |

### 本任务明确不做

- 不下载、不 aria2c、不改 `MODEL_SOURCES*` / picker、不 commit/push
- 不删模型、不重启 worker / systemd

---

## 1. 盘点

### 1.1 MODEL_SOURCES 统计

| 字段 | 值 |
|------|----|
| **total** | **825** |
| **ok** | **487** |
| **blocked** | **337** |
| 其它 status | 1（`minimax_h3_ref2va_pruned_bf16.safetensors` status=null） |
| ok_missing_source_url | 9 |
| ok_local_alias_without_http_url | 5 |
| ok 有 url/repo | 482 |
| 唯一 upstream repo | 251 |

**ok 按 rel_path 顶目录（Top）**

| 顶目录 | 条数 |
|--------|------|
| loras | 171 |
| diffusion_models | 110 |
| LLM | 35 |
| checkpoints | 22 |
| text_encoders | 21 |
| h3 | 19 |
| detection | 16 |
| vae | 15 |
| controlnet | 13 |
| SEEDVR2 | 13 |

**blocked.resolution_state（Top）**：not_found 266 · n/a 43 · traceable_login_required 25 · local_output_artifact 3

### 1.2 NAS_MODEL_PICKER 统计

| 字段 | 值 |
|------|----|
| h3_entries | 61 |
| main_entries | 788 |
| 唯一 basename | 782（h3/main 有少量 basename 重复如 ema_vae） |

**by_category**：H3 61 · LoRA 262 · 工具/其它 232 · 出视频/兼用 195 · 出图 44 · Comfy-LLM 41 · 音频/工具 14

**picker.gaps**：SenseVoice 盘面缺；matrix_pending：SkyReels / HunyuanVideo(新矩阵) / FLUX.2

### 1.3 交叉对照（basename）

| 集合 | 条数 | 说明 |
|------|------|------|
| ok ∩ picker（账本有且盘扫有） | **475** | 主交集 |
| picker − ledger（盘上有账本无） | **298** | 含大量 insightface/birefnet/H3 社区包/系统依赖；**含生产 H3 pruned_int8 两件** |
| picker ∩ blocked | **8** | 见下 |
| ok − picker（账本有盘扫无） | **10** | 目录型/别名/新装未进盘扫等 |

**picker ∩ blocked（8）**：含 `h3_musubi_v4-000040`（civitai provenance_lost）、若干 H3 turbo 中文/近名、Wan Lightning 重命名、`model.pt` 歧义等 → 建议 **跳过追下载**，保留盘面即可。

**ok − picker（10）示例**：FlashVSR-v1.1、SenseVoiceSmall、segformer_b2/b3_clothes、svdq-int4-flux*、`wan_animate_2_distill_int8_convrot` 等（目录型或盘扫口径差）。

---

## 2. 主路径在用权重清单（校准后）

来源：`AGENTS.md` §三/§四 + `NAS_MODEL_PICKER.md` 默认写死名。

| 主路径 | 端口 / 服务 | 产品默认 / 在用权重 | 账本 | 盘扫 picker | 备注 |
|--------|-------------|---------------------|------|-------------|------|
| **H3 Ref2VA / FL2VA** | **:8264** `toiv-comfyui-h3-gpu1`（:8195 已停用） | `minimax_h3_ref2va_pruned_int8_convrot.safetensors` · `minimax_h3_fl2va_pruned_int8_convrot.safetensors`（各 ≈20.97GB） | **无精确 basename** | **有**（H3主模型） | 上游 Comfy-Org 同名同字节仍在 |
| **出图** | **:8196**（LB :8188 池成员） | gate **现** **`Qwen-Rapid-AIO-SFW-v23.safetensors`**（扫描当时钉 v11） | ok | 有 | 盘上另有 SFW-v11/v18、NSFW-v23 等；**gate 已切 SFW-v23** |
| **Wan / LongCat** | **:8197** | Wan/LongCat/VACE/Continue/Avatar；非单一 ckpt | 多条 ok | 多条 | Rapid 本地最高约 i2v-v10 / mega-v1 |
| **Wan Animate** | **:8199** | Animate2 系 | 有 fp8/GGUF/distill | 有 | |
| **IndexTTS** | **:9200** `toiv-indextts` | AGENTS：**IndexTTS 2.5**；路径 `/home/merlin/index-tts`（**不在** Comfy NAS picker） | 账本无 IndexTTS 权重条 | 无 | 须真机核验是否已对齐官方 2.5 |
| **VLM** | **:9311** `toiv-vlm` | AGENTS：**Qwen3-VL-8B BF16**（~44.6G） | `Qwen3-VL-8B-Instruct` **blocked**；有 FP8/abliterated GGUF ok | 有 FP8/GGUF，无清晰 BF16 全量目录条 | 服务目录可能在实例本地，非 picker |
| **对话 LLM** | spark **:8000** | `deepseek-v4-flash-dspark` | 不在本 Comfy 账本范围 | 不扫 LLM 对话主模型 | 本次不评级 |

---

## 3. 上游实查结论（可核验链接）

### 3.1 出图 · Phr00t Rapid AIO（P0）

- 仓库：https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO  
- API sha=`691024f43864…` lastModified=`2026-02-03T02:10:35Z`（树内版本目录已至 **v23**）
- **现网 gate（更新后）**：`v23/Qwen-Rapid-AIO-SFW-v23.safetensors` size=**28431840023**（扫描当时为 v11）  
  链接：https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/resolve/main/v23/Qwen-Rapid-AIO-SFW-v23.safetensors
- **上游最新 SFW**：`v23/Qwen-Rapid-AIO-SFW-v23.safetensors` size=**28431840023**  
  链接：https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/resolve/main/v23/Qwen-Rapid-AIO-SFW-v23.safetensors
- **盘上已有（非 gate）**：`Qwen-AIO-SFW-v18`（对应上游 v18 SFW，28431844111）；`new_Qwen-Rapid-AIO-NSFW-v23`（NSFW v23）
- **缺口**：标准名 **SFW-v23 未在 ledger/picker 见到**（仅 NSFW-v23 / SFW-v18）

### 3.2 H3 · Comfy-Org / Kijai（生产未过时；实验档可选）

- 生产同名文件仍在：https://huggingface.co/Comfy-Org/MiniMax-H3  
  - `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` **20970379616**  
  - `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` **20970379616**  
  - repo lastModified=`2026-09-29T11:11:09Z`
- 实验继任（**非**生产默认替换）：https://huggingface.co/Kijai/MiniMax-H3-experimental lastModified=`2026-10-15T10:41:15Z`  
  - 例：`loras/MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors`（1725921392）  
  - `minimax_h3_ref2va_pruned_w4a8_mixed.safetensors`（11770657048）  
  - `minimax_h3_fastvideo_vsa_datafree_1300step_4step_int8_convrot.safetensors`（22898594920）  
- 本地 ledger **未见** Acc-8Step / w4a8 / fastvideo_vsa 条目 → 可选双轨评测

### 3.3 IndexTTS（需真机核验）

- 官方 2.5：https://huggingface.co/IndexTeam/IndexTTS-2.5 sha=`c39ce5ba9815…` lastModified=`2026-08-12T07:23:44Z`  
  - 主权重：`gpt.pth` **3259599833** · `codec.pth` **607290935** · `s2mel.pth` **414908601**
- 官方 2.0：https://huggingface.co/IndexTeam/IndexTTS-2 lastModified=`2026-01-20T13:41:51Z`（`gpt.pth` 3484663079，文件集与 2.5 不同）
- AGENTS 写「IndexTTS 2.5」；**本扫描无法核验** `/home/merlin/index-tts` 实际文件 → 标「未核实本地 revision」

### 3.4 VLM

- https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct lastModified=`2025-10-15T16:16:59Z`（官方 8B Instruct 仍为现档；分片合计权重约 **17.5GB** BF16 权重文件，服务侧 ~44.6G 含运行时）
- 未发现官方「Qwen3-VL-8B-Instruct」更大继任版需强制替换；社区 GGUF/abliterated 活跃但 **非** :9311 生产路径推荐
- ledger 中 `Qwen3-VL-8B-Instruct` 为 **blocked**（与现网服务可能用实例本地目录并存）

### 3.5 Wan Rapid / Lightning / LTX（抽样）

| 系列 | 本地（ledger/picker） | 上游实查 | 链接 |
|------|----------------------|----------|------|
| Wan Rapid AIO | picker 有 i2v-v10、mega-v1；ledger ok 见 nsfw-v7 | **Mega-v11** `Mega-v11/wan2.2-rapid-mega-aio-v11.safetensors` 24334498767 | https://huggingface.co/Phr00t/WAN2.2-14B-Rapid-AllInOne |
| Wan2.2 Lightning | 已有 Seko/V1.1 lora 等 | 另有 `Wan2.2-T2V-A14B-4steps-250928-dyno/…` 目录 | https://huggingface.co/lightx2v/Wan2.2-Lightning |
| LTX-2.3 distilled 1.1 | picker 已有 `ltx-2.3-22b-distilled-1.1.safetensors` 46149345334；ledger 有 1.1 fp8/mxfp8 transformer | 官方 1.1 仍为当前档；**无 LTX-2.4 正式继任**（search 无官方 2.4） | https://huggingface.co/Lightricks/LTX-2.3 |
| Qwen-Image Lightning | 本地已有 2511/2512 与 V2.0 多档 | `lightx2v/Qwen-Image-Lightning` lastModified=`2026-10-19T11:44:49Z`（与本地集合基本重叠） | https://huggingface.co/lightx2v/Qwen-Image-Lightning |

### 3.6 未核实 / 不可达

- IndexTTS **本地**文件与 2.5 是否一致：未 SSH → **未核实**
- VLM :9311 实例目录是否等于 `Qwen/Qwen3-VL-8B-Instruct`：未核实
- Civitai 大量 NSFW LoRA：本次未逐条 REST（主路径以外）；`h3_musubi_v4` 账本已记上游下架
- `IndexTeam/IndexTTS`（无后缀）API 401 → 忽略

---

## 4. 分级候选

### 发现可升级数（有上游证据）

- **明确可升级 / 可晋升 gate**：**3**（出图 SFW-v23 下载或至少 gate→v18；Wan Mega-v11；H3 Kijai 实验档双轨）
- **需真机核验后可能升级**：**1**（IndexTTS 2.5）
- **当前与上游同档、无需动**：H3 pruned_int8 生产对、LTX-2.3-1.1 主文件、Qwen Lightning 主干

### P0（主路径在用且明显过时 / 配置滞后）

| # | 项 | 现文件 | 上游新文件 | 体积 | 兼容 | 建议 | 破坏风险 |
|---|----|--------|------------|------|------|------|----------|
| 1 | **出图 gate 钉死 SFW-v11** | `Qwen-Rapid-AIO-SFW-v11.safetensors` | `v23/Qwen-Rapid-AIO-SFW-v23.safetensors`（或先晋 `Qwen-AIO-SFW-v18` 已在盘） | ≈28.43GB | worker **:8196**；Rapid AIO 大版本可能改默认步数/节点 | **双轨**：先 smoke v18（已在盘）→ 再下载 SFW-v23 双轨 → 改 `model-config.template` / gate | 中：工作流采样步数/提示词习惯可能变 |

*H3 生产 int8：上游同名同字节 → **不列入 P0 过时**。*

### P1（常用 / 高价值）

| # | 项 | 现况 | 上游 | 建议 |
|---|----|------|------|------|
| 1 | Wan Rapid Mega | 盘上 mega-v1 / i2v-v10 | Mega-**v11**（Phr00t） | **双轨下载**评测后 :8197 选用；勿直接替换写死名 |
| 2 | H3 Kijai Acc-8Step / w4a8 | 本地无 | Kijai/MiniMax-H3-experimental（2026-10-15） | **可选双轨**；仅评测，不替换 :8264 默认 int8 |
| 3 | IndexTTS 本地 vs 2.5 | AGENTS 称 2.5；未核实文件 | IndexTeam/IndexTTS-2.5 | **真机核验** `gpt.pth` 大小/hash；若仍为 2.0 再升级（可能动 :9200，需维护窗） |
| 4 | H3 账本补录 | 生产 int8 在 picker、不在 ledger | Comfy-Org 同名 | **补账本 provenance**（非下载） |

### P2（可选）

| # | 项 | 说明 |
|---|----|------|
| 1 | Wan2.2 Lightning dyno 包 | lightx2v 新目录；与现有 Seko 并存评测 |
| 2 | LTX bf16 transformer-only 1.1 | 本地已有 1.1 全量+fp8；bf16 only 按显存策略可选 |
| 3 | SenseVoiceSmall | picker.gaps 已记缺；非主路径 |
| 4 | Qwen3-VL 社区 GGUF 新量化 | 勿扰 :9311 BF16 生产 |

### 跳过

| 原因 | 例 |
|------|----|
| 已被继任 / 旧 Rapid 小版本 | SFW-v5/v7 保留归档即可 |
| provenance_lost / 上游下架 | `h3_musubi_v4-000040` |
| 磁盘不值 / 近名歧义 | blocked 中文 turbo 名、`model.pt` |
| 非主路径 NSFW 海量 LoRA | 本次不扫 Civitai 全量 |
| 无官方 LTX-2.4 / Wan2.3 | search 无可信官方继任 |

---

## 5. 建议操作（仅建议，不执行）

1. **出图 :8196（优先）**  
   - 短期：**双轨**用已在盘的 `Qwen-AIO-SFW-v18` 做 gate 候选 smoke（对照 v11）  
   - 随后：hf-mirror + aria2c 拉 `v23/Qwen-Rapid-AIO-SFW-v23.safetensors` → 再双轨 → 通过后改 live gate 模板  
   - 不建议不经 smoke 直接改生产写死名

2. **H3 :8264**  
   - **跳过替换**生产 pruned_int8（与上游同档）  
   - 可选：下载 Kijai Acc-8Step LoRA 做旁路评测  
   - 运维：把两件生产 int8 **补进 MODEL_SOURCES**（status=ok, repo=Comfy-Org/MiniMax-H3）

3. **Wan/LongCat :8197**  
   - 可选下载 Mega-v11 **双轨**；Animate :8199 维持现 fp8/distill

4. **IndexTTS :9200**  
   - 先 `ls/sha256sum` 对照 IndexTTS-2.5 的 `gpt.pth`（3259599833）等；不一致再计划升级（可能需服务窗，非 Comfy 热切换）

5. **VLM :9311**  
   - **跳过**强制换模；官方 8B Instruct 无更新继任。可另开任务核验实例目录与 blocked 账本条目

6. **全局**  
   - 继续主路 hf-mirror + aria2c；旧树 `Windows/ComfyUI/ComfyUIModel` 勿重复加算  
   - 本报告 **不触发**任何下载/重启

---

## 6. 对主路径影响说明

| 路径 | 影响 |
|------|------|
| **H3 Ref2VA :8264** | 生产权重与上游同名同字节，**无强制升级**。实验蒸馏为可选；误替换 int8 会破坏现网 Ref2VA/FL2VA 工作流。账本缺条不影响盘上加载，但妨碍下次保鲜。 |
| **出图 :8196** | **已收口**：gate 已切 SFW-v23（本基线扫描时仍 v11）。旧 v11 保留；进程 reload 窗另约。 |
| **IndexTTS :9200** | 文档已称 2.5；若真机已是 2.5 则无动作。若仍是 2.0，升级有质量收益但属独立服务，需维护窗，**本次未执行**。 |
| **VLM :9311** | 无官方强制继任；保持 BF16。社区量化勿直接替换生产。 |

---

## 7. 成功标准核对

| 项 | 本报告 |
|----|--------|
| 扫描时间（Asia/Shanghai） | 2026-10-22 00:55 Asia/Shanghai |
| 覆盖条数 | ledger **825**（ok 487 / blocked 337）；picker 唯一 basename **782**；上游实查优先仓库 **30** |
| 发现可升级数 | **明确 3** + **待核验 1**（见 §4） |
| P0 清单 | **1 条**（出图 Rapid SFW gate）；H3 无 P0 过时 |
| 建议操作 | 仅建议：下载/双轨/跳过/补账本（§5） |
| 主路径影响 | §6 |
| 不下载不删不重启 | **遵守** |

---

## 附录 A · 实查仓库清单（本次）

Phr00t/Qwen-Image-Edit-Rapid-AIO · Comfy-Org/MiniMax-H3 · Kijai/MiniMax-H3-experimental · Gluttony10/MiniMax-H3-INT8-CONVROT · smhfacct/Minimax-H3-fl2va-ref2va-hybrid-models · Qwen/Qwen3-VL-8B-Instruct · Qwen/Qwen3-VL-4B-Instruct · Qwen/Qwen2.5-VL-7B-Instruct · Comfy-Org/Wan_2.2_ComfyUI_Repackaged · Wan-AI/Wan2.2-Animate-14B · lightx2v/Wan2.2-Lightning · lightx2v/Qwen-Image-Lightning · lightx2v/Qwen-Image-2512-Lightning · lightx2v/Qwen-Image-Edit-2511-Lightning · lightx2v/Qwen-Image-Edit-2512-Lightning · Lightricks/LTX-2.3 · Kijai/LTX2.3_comfy · Comfy-Org/z_image_turbo · FunAudioLLM/SenseVoiceSmall · Phr00t/WAN2.2-14B-Rapid-AllInOne · Comfy-Org/Qwen-Image_ComfyUI · Kijai/WanVideo_comfy · Kijai/WanVideo_comfy_fp8_scaled · IndexTeam/IndexTTS-2 · IndexTeam/IndexTTS-2.5 · 以及若干辅助 repo（rzgar/larryvrh/ltx-2/Z-Image/FLUX.2-klein 等）

## 附录 B · 原始 totals 摘录

```json
{"ok": 487, "blocked": 337, "total": 825, "ok_missing_source_url": 9, "ok_true_gaps_no_url_no_repo_not_alias": 0, "ok_local_alias_without_http_url": 5}
```
