# ToIV 平台演进 · Claude Code 完整开发指令（含模型选型目录）

> **用法**：把本文件放进仓库（建议 `docs/TOIV_MASTER.md`），对 Claude Code 说
> "读 `docs/TOIV_MASTER.md`，按协议从 A 期开始"。
> Claude Code 会在**每一期内自主开发**（改代码 / 写测试 / 提交），**期末暂停**，等你在真机验证后再进入下一期。
>
> **本文件含三部分**：
> ① **第一部分 · 开发指令**（怎么做：角色、协议、五期路线、护栏）
> ② **第二部分 · 模型选型目录**（用什么：A 期换底模、D 期微调直接消费这一部分）
> ③ **附录 · 下载脚本**（A 期拉取模型时按此生成 `download_models.sh`）

---
---

# 第一部分 · 开发指令

## 0 · 角色与总目标

你是 ToIV 平台的资深全栈工程师。ToIV 是一个多租户 AIGC SaaS 平台（意图驱动创作）。

**总目标**：按下方五期路线图，把平台从"能生成"升级为"**稳定产出好结果、并能自我改进的闭环系统**"。

当前最痛的两个问题：① 默认底模过时（SD1.5）导致出图质量差；② 缺少"评估"和"学习"两个闭环环节，导致效果不稳、无法持续变好。

---

## 1 · 项目背景（先读懂，再动手）

技术栈与服务拓扑（**以仓库实际为准**，下面是参考）：

- 前端 **Next.js 15**（toiv-web，:3100）；后端 **FastAPI**（toiv-api，:8090，**纯 CPU，只做编排**）
- GPU 机 **.100**（Windows，4× RTX PRO 6000，每张 96GB）跑：
  - **ComfyUI ×4**（:8000/8002/8003/8004）出图/视频/对口型
  - **IndexTTS2**（:9000）中文克隆配音
  - **LM Studio**（:1234，`qwen3.6-35b-a3b`）作 LLM 大脑
  - **reForge**（:7860）第二出图引擎
- 中枢抽象 **`model_profiles.py`**：一组纯函数，按 checkpoint 文件名自动决定采样修正 / 分辨率 / 提示词方言（`is_vpred` / `fit_resolution` / `detect_model_family` / `is_nsfw`）
- 向量：`nomic-embed-text v1.5`；听写：`faster-whisper`；对口型：`LatentSync 1.6`
- 部署：spark02 上 `~/ToIV` **非 git**，rsync + `docker compose up --build`（`deploy/deploy.sh`）

**第一步（必做）**：探索仓库，读 `model_profiles.py`、后端端点结构、前端模块结构、ComfyUI 工作流模板的组织方式；**输出你对现状的理解，再开始改任何代码**。不要假设文件路径，以实际为准。

---

## 2 · 核心开发思想（所有改动都服务这条主线）

平台的本质是一个**自我改进闭环**，不是一堆孤立功能：

```
   ┌──────────────────── 学习 (Learn) ────────────────────┐
   │                                                      │
① 意图 → ② 理解+检索 → ③ 提示词合成 → ④ 生成 → ⑤ 评估 → ⑥ 采纳/回炉
        (LLM+RAG+搜索)  (model_profiles) (ComfyUI) (自动评审)
              ↑                                        │
              └────────── 知识库 / 高分样本回流 ──────────┘
```

- ①②③ 已有雏形（意图编译器 + 润色器 + 提示词方言）→ B 期升级成 **LLM + 检索驱动**
- ⑤ **评估层现在完全没有** → 是画质稳定的关键（B 期）
- ⑥→① 的**学习回流 = 微调功能的归宿**（D / E 期）
- 同一套闭环也适用于**音频 / 译制**（理解脚本 → 选 TTS/VC → 生成 → 评估时长对齐/音色相似度 → 回炉）

**判断任何改动是否正确的标准**：它是否让这条闭环更完整，或让 `model_profiles` 这层"按底模自动配齐"的抽象更强。

---

## 3 · 工作协议（决定你怎么干活）

1. **探索优先**：动手前先读懂相关代码，**复用既有模式**，不要另起炉灶。
2. **一次一期，期末暂停**：在一期内自主完成全部改动、写测试、增量提交；一期结束时输出「**改动摘要 + 人工验证清单**」，**停下等我在真机验证后再进入下一期**。
3. **遵循既有抽象**：任何"按模型不同而不同"的逻辑，一律加进 `model_profiles.py`，**禁止在端点里硬编码 per-model 分支**。
4. **不破坏既有功能**：SD1.5/SDXL、现有 `/dub/*` 端点、漫剧链路必须保持可用（注：SD1.5 底模将在 A 期退役，但兼容代码路径不要一次性删死，先切默认、留回退）。
5. **明确验证边界**：你能验证**机械链路**（接口通、参数正确、服务集成）；你**不能验证模型输出的主观质量**（你没有 GPU、素材是合成的）。凡涉及"像不像 / 好不好看 / 嘴型准不准"，写好代码 + 列出让我在 .100 上验证的**具体步骤**，并标注「**待人工主观复核**」。
6. **增量提交**：每个逻辑单元一个 commit，信息清晰、可回滚。
7. **破坏性操作先问**：数据库 schema 变更、删数据、动 `deploy.sh` 部署到生产（`toiv.dgmt.top`）——**先停下问我**；你只准备改动，由我执行部署。
8. **选型默认商用安全**：默认偏向可商用的模型（Qwen-Image、CosyVoice 3.0、Seed-VC）；Flux dev 这类禁售出图的只作**可选项**并注明授权（详见第二部分）。

---

## 4 · 五期路线图（按序执行）

### A 期 · 底模升级（先止血，投入产出比最高）

**目标**：把默认出图从 SD1.5 换成新一代，画质立刻上台阶（连带拉高漫剧/译制质量）。

**任务**
- **严格按【第二部分 · 模型选型目录】执行**：
  - 默认 t2i 底模从 DreamShaper_8(SD1.5) 换成 **Qwen-Image**（商用优先）或 **FLUX.2**（见 §1）。
  - 给 `model_profiles.py` 增加 `flux2` / `qwen_image` / `z_image` 家族的识别与档案——**注册模板直接用 §10**。
  - 生成 `download_models.sh`（**内容见附录**），用于在 NAS 拉取新家族权重并归位。
- **关键正确性（务必按 §10 实现，否则出图直接崩）**：Flux/Qwen/Z-Image 系 **真实 CFG=1.0 + guidance/FluxGuidance 节点**、采样器 **Euler/res_multistep + simple**、**严禁 Karras**；这几族**负向提示词失效**，合成器不发负向（要负向改挂 PAG）。
- 在 ComfyUI 侧准备 / 确认这三个家族对应的工作流模板（专用 VAE、双 CLIP / t5xxl / qwen 文本编码器等组件齐全，见 §6）。
- 按 §8 把 SD1.5 全系从默认与推荐中退役（代码路径留回退，见协议第 4 条）。

**验收**：新家族底模能出正常图且参数正确；SD1.5/SDXL 路径行为不变（仍可显式调用）。
**人工复核点**：新默认底模的实际出图质量（我在真机看图）。

---

### B 期 · 评估层 + 提示词流水线（让"效果"从看运气变稳定）

**B1 · 评估与选优**
- 新增「**Best-of-N**」生成模式：一次在 4 个 ComfyUI 实例**并行**出 N 张，自动打分排序，只回最优（+ 可选返回全部供挑选）。
- 打分服务：**美学评分** + **图文对齐**（CLIP/SigLIP）+ 复用 `face_yolov8` 查脸崩 + 可选 **VLM 文字点评**。
- 自动修复钩子：检测到脸崩自动过现有 `FaceDetailer`，再评分。

**B2 · 提示词流水线升级**（扩展现有润色器，别推倒重来）
- 新模块：意图 → **RAG 检索**（用 `nomic-embed` 建"提示词模板 / 风格 token"内部向量库）→ **LLM 合成**（LM Studio qwen）→ **输出结构化 JSON**（positive / negative / 推荐参数，参数取自 `model_profiles`）→ 进 B1 生成 → 评审不达标则回传意见改提示词重生成（**限 2–3 次**）。
- **联网搜索作为按需 / 异步增强**：仅覆盖内部库没有的新概念（如具体游戏 / 影视风格参考），**不进默认主链路**（避免延迟与不可控）。

**验收**：一句意图即可自动产出"该模型母语的提示词 + 正确参数"；Best-of-N 返回排序最优；回炉有次数上限。
**人工复核点**：选优后的图是否确实更好、提示词方言是否贴切。

---

### C 期 · 音频升级（补全译制的日韩缺口）

**任务**（选型见 §7）
- 在 .100 部署 **CosyVoice 3.0**（Apache 2.0，跨语言克隆）；`/dub/translate` 已支持 ja/ko，把 `voice-track` 的日韩分支指向 CosyVoice。
- **TTS 引擎按语言路由**：zh 可保留 IndexTTS2（用其时长控制卡嘴型），ja/ko 走 CosyVoice 3.0（也可统一到 CosyVoice 以简化授权）。
- 新增 **Seed-VC** 服务与端点（如 `/audio/voice-convert`）：零样本变声 + **歌声转换**（漫剧唱段用）。VC 作为译制的**精修层 / 歌声专用**，不进默认主链路。

**验收**：日韩配音端到端跑通；变声端点可用（逐段进度沿用现有反馈组件）。
**人工复核点**：日韩配音自然度、音色相似度（真机 + 真素材）。

---

### D 期 · 微调功能（增长型差异化卖点）

**任务**
- 做「**训练你的专属风格 / 角色 / 产品模型**」向导：上传 10–30 张 → 自动打标（复用 Florence2 或换更强 caption 模型）→ 训练 → 出验证样本 → **自动注册进 `model_profiles`（新 LoRA 自动获得档案，格式见 §10）** → 在创作 / 画布 / 漫剧可用。
- 训练后端**按家族路由**（家族划分见第二部分）：**AI-Toolkit** 训 flux2 / qwen / z-image，**Kohya sd-scripts** 训 SDXL（Illustrious/Pony/写实）。
- GPU 上做训练**作业队列**：**划一张卡专做训练，另三张继续出图**。
- 前端训练向导 + 作业进度（复用现有进度 / ETA / 预览模式）。

**验收**：用户能训一个 LoRA 并立刻在生成里用上；训练不影响出图服务。
**人工复核点**：训出的 LoRA 效果、训练时长与显存占用。

---

### E 期 · 数据飞轮（终局，数据够了再做）

**任务**
- 全链路埋点，记录「**意图 → 合成提示词 → 参数 → 评分 → 用户采纳**」三元组。
- 待数据充足后，用高分三元组**微调提示词合成 LLM**（**注意：这是 LLM 工具链 Unsloth/PEFT，与图像 LoRA 完全不同**）。

**验收**：数据管道在稳定记录；LLM 微调延后至数据足够再启动。

---

## 5 · 硬性护栏（绝不违反）

- 不破坏 SD1.5/SDXL 与现有 `/dub/*`、漫剧链路（SD1.5 只退默认、留回退，不删死）。
- 所有 per-model 差异进 `model_profiles.py`，**端点里不写模型分支**。
- API 容器保持 **CPU 纯编排**，模型推理**全在 .100**。
- **不自动部署生产**（`toiv.dgmt.top`）；`deploy.sh` 由人工执行。
- 模型**主观质量你不自行判定**——写代码 + 给人工验证步骤 + 标注待复核。
- 数据库 / 删数据 / 动配置等**破坏性操作先问**。
- 选型默认**商用安全**（Qwen-Image / CosyVoice 3.0 / Seed-VC）。
- **未成年内容防护默认开启、不可被前端关闭**（见 §9，平台存续硬线）。

---

## 6 · 现在开始

先做「1 · 项目背景」的**仓库探索**，**输出你对现状的理解 + A 期的详细执行计划**（含要改的具体文件、ComfyUI 工作流改动、要下载的模型清单），**等我确认后再动手改代码**。

---
---

# 第二部分 · 模型选型目录（2026 年中·跨风格最优）

> 目标硬件：4× RTX PRO 6000（96GB×4），显存管够 → 一律上全精度/大模型，不为省显存牺牲画质。
> **A 期换底模、D 期微调直接消费本部分。** 下载脚本见附录。

## §0 · NAS 上的 ComfyUI 文件夹结构

把 NAS 挂到 GPU 机后，所有权重按下面归位（`$NAS_ROOT` = 你的 ComfyUI `models` 目录）：

```
$NAS_ROOT/
├── checkpoints/        # 全参 SDXL/Pony/Illustrious 底模 (.safetensors)
├── diffusion_models/   # Flux.2 / Qwen-Image / Z-Image / 视频 DiT 权重
├── text_encoders/      # t5xxl / clip_l / qwen / umt5 等文本编码器
├── vae/                # ae.safetensors(Flux/Z-Image共用) / qwen vae / sdxl vae / wan vae
├── loras/              # 风格/角色/加速 LoRA
├── controlnet/         # SDXL union / Flux controlnet（SD1.5 的全删）
├── upscale_models/     # 4x-UltraSharp / NMKD-Siax / RealESRGAN / Remacri
├── ipadapter/          # IPAdapter 权重
└── clip_vision/        # CLIP-ViT-H / bigG（IPAdapter 用）
```

## §1 · 新一代通用 / 写实天花板（优先默认）

| 模型 | 用途 | 来源（HF repo / 文件） | 授权 | 放置 |
|---|---|---|---|---|
| **FLUX.2 [dev]** | 综合画质+提示词遵循天花板；产品图/写实/设计 | `Comfy-Org/flux2-dev`（ComfyUI 量化版）或 `black-forest-labs/FLUX.2-dev`（原版，需在页面接受协议） | ⚠️ 禁售出图（除非买 BFL 商用授权） | diffusion_models |
| **Qwen-Image** | 文字/中文渲染最强；**可商用**，建议做商用默认 | `Qwen/Qwen-Image`（官方 v1.0）+ ComfyUI 文件：`qwen_image_fp8_e4m3fn` / `qwen_2.5_vl_7b_fp8_scaled`（v1.0 编码器，worker 已存在）/ `qwen_image_vae` | ✅ Apache 2.0 | diffusion_models / text_encoders / vae |
| **Z-Image Turbo** | 6B，8 步极速出图；批量/预览首选 | `Comfy-Org/z_image_turbo`（`split_files/diffusion_models/z_image_turbo_bf16` + `text_encoders/qwen_3_4b`） | ✅ Apache 2.0 | diffusion_models / text_encoders |

> Flux.2 与 Z-Image **共用** Flux 的 `ae.safetensors` VAE。三者都吃自然语言长句，**忌堆质量标签**；CFG≈1（详见 §10）。

## §2 · 写实 SDXL（生态最全 / 本地无审查 / R18-capable）

| 模型 | 用途 | Civitai 页 | 备注 |
|---|---|---|---|
| **Juggernaut XL Ragnarok (v13)** | 全能写实首选（人像/全身/场景/电影感） | civitai.com/models/133005 | 2026-02，手部/解剖较 v11 明显改善 |
| **RealVisXL V5.0** | 人像/面部细节/肤质最锐；带 Lightning 变体 | civitai.com/models/139562 | 纯写实优于 Juggernaut，泛用性略弱 |
| **LEOSAM's HelloWorld XL 7.0** | 专门对抗坏解剖，**SDXL 里手部最好** | Civitai 搜 "HelloWorld XL"（抓最新版本号） | 肤质写实略逊前两者 |

> 可选「真实系无审查次世代」：**Chroma**（Flux 的去审查 + 解剖增强分支）、**HunyuanImage**（腾讯，开箱无审查、中英双语）。按需再加。

## §3 · 二次元 / 插画（Illustrious / NoobAI / Pony 三系）

| 模型 | 用途 | 来源 | 备注 |
|---|---|---|---|
| **Illustrious XL v2.0** | 现代二次元基座，干净线条/更好解剖 | Civitai 搜 "Illustrious XL"（v2.0-stable） | Illustrious 系 LoRA 生态的地基 |
| **NoobAI-XL（V-Pred 1.0）** | 基于 Illustrious 微调，vpred 画质更高 | Civitai "NoobAI-XL" V-Pred 版 | **必须插 `ModelSamplingDiscrete`(v_prediction, zsnr)**，你已有此逻辑 |
| **NoobAI-XL（Epsilon 1.1）** | 常规 CFG 曲线，迁移友好 | 同上 Epsilon 版 | 不吃 vpred 修正 |
| **WAI-Illustrious-SDXL** | 海量动漫/游戏角色知识，安全起点 | Civitai "WAI-Illustrious" | Illustrious LoRA 兼容性好 |
| **Nova Anime XL (IL v19)** | 2.5D/3D 向动漫 | civitai.com/models/376130 | NoobAI EPS + Illustrious v2.0 融合 |
| **Pony Diffusion V6 XL** | 风格化/NSFW-by-default，score 标签体系 | civitai.com/models/257749 | 思维是 booru 标签而非句子；写实提示词无效 |

> **Pony V7** 已宣布转 AuraFlow/Flux 基座补自然语言短板，但尚未完全成熟 → **先用 V6，V7 观望**。
> Illustrious 系与 Pony 系的 LoRA **不通用**，注册档案时按族区分。

## §4 · 风格化 / 概念 / 奇幻

| 模型 | 用途 | 来源 |
|---|---|---|
| **DreamShaper XL** | 通用艺术/概念/插画多面手（带 Lightning） | Civitai "DreamShaper XL" |
| **ZavyChromaXL** | 奇幻/概念设计 | Civitai "ZavyChromaXL" |

> 更细的画风走 LoRA 叠加，而非再囤一堆底模。

## §5 · 视频（本地，ComfyUI）

| 模型 | 用途 | 来源 | 备注 |
|---|---|---|---|
| **Wan 2.2**（I2V/T2V A14B + 5B TI2V） | 真人画质天花板（你已用） | `Wan-AI/Wan2.2-I2V-A14B` / `Wan-AI/Wan2.2-T2V-A14B`；ComfyUI 用 fp8 rehost + `umt5_xxl` + `wan_2.1_vae` | 叠 lightx2v 4 步加速 LoRA；**成品建议另出一档不加速的高步数「质量模式」** |
| **HunyuanVideo 1.5** | 运动/物理最自然，电影感 | `tencent/HunyuanVideo` + Kijai wrapper `Kijai/HunyuanVideo_comfy` | ComfyUI 装 `ComfyUI-HunyuanVideoWrapper`（Kijai） |
| **LTX-2** | 速度最快、12G 能跑、音画同步 | Lightricks 官方 repo | 做草稿/快速迭代档 |

## §6 · 必备组件

**VAE**：Flux `ae.safetensors`（Flux.2/Z-Image 共用）、`qwen_image_vae`、SDXL `sdxl_vae`（fp16-fix）、`wan_2.1_vae`（你已有）。
**文本编码器**：`t5xxl_fp16`(+`clip_l`) 给 Flux.1/SD3.5；`qwen_2.5_vl_7b_fp8_scaled` 给 Qwen-Image 1.0（worker 已存在；v2.0 升级 Qwen3-VL 待 Comfy-Org 量化包）；`qwen_3_4b` 给 Z-Image/FLUX.2 Klein；`mistral_3_small_flux2_fp8` 给 FLUX.2 dev；`umt5_xxl` 给 Wan。
**ControlNet**：SDXL **union**（xinsir/promax，一个顶多个）+ Illustrious/NoobAI 专用 controlnet + Flux controlnet（canny/depth/union）。**SD1.5 的 control_v11 全部退役。**
**放大**：`4x-UltraSharp`、`4x-NMKD-Siax`（你已有）、`RealESRGAN_x4plus`、`4x-Remacri`；再加 **SUPIR**（AI 修复式超分，出细节最猛，吃显存但你显存够）。
**IPAdapter**：SDXL `ip-adapter-plus-face_sdxl_vit-h` + `CLIP-ViT-H` / `bigG`（你已有）；Flux 若用角色一致性可加 `XLabs-AI/flux-ip-adapter`。
**细节/加速 LoRA**：`Detail Tweaker XL`（细节增强）、`DMD2`（少步高质，Pony/Illustrious/NoobAI 通用）、`SDXL Lightning` / `Hyper-SDXL`（草稿提速）、`XLabs flux-RealismLora`（给 Flux 补最后 5% 肤质）。

## §7 · 音频（承接结论）

| 能力 | 模型 | 备注 |
|---|---|---|
| TTS 主力（跨语言克隆） | **CosyVoice 3.0** | Apache 2.0，日/韩/英/中全覆盖，**直接解决阶段3b 日韩缺口**，授权比 IndexTTS2 干净 |
| TTS 中文 | **IndexTTS2**（保留） | 用它的时长控制卡对口型时间轴 |
| TTS 日语加强（可选） | **Qwen3-TTS** | Apache 2.0，日语质量好、带情感控制 |
| 语音转换/变声/歌声 | **Seed-VC** | 零样本，无需逐音色训练；漫剧唱段必须靠它（TTS 唱不了歌） |
| 高保真专属声线 | **RVC v2** | 想训练一个反复用的声线时用，正好并入 D 期「训练功能」 |

## §8 · 直接退役（从 NAS 删除，别再注册；代码路径留回退）

- **SD1.5 全系**：DreamShaper_8、Realistic Vision，以及所有 SD1.5 checkpoint / LoRA / ControlNet。代差，96GB 卡上零理由保留。
- **SDXL base 原版**：已被 Juggernaut/RealVis/Illustrious 全面超越（除非留一份做 ControlNet 兼容测试）。
- **旧 SD1.5 ControlNet（control_v11 系）**：全换 SDXL union / Flux controlnet。

## §9 · R18 与未成年内容防护（多租户平台的生死线）

1. **R18 能力来自底模**：Pony / Illustrious / NoobAI 原生产出成人二次元（靠 danbooru/score 标签）；写实走 SDXL 写实 merge / Chroma / HunyuanImage，本地推理无云端过滤。**不需要额外露骨 LoRA**——具体露骨内容按平台内容政策自取。
2. **一条不可逾越的硬线**：这些二次元底模在被诱导时可能产出**未成年外观的性化内容**。对多租户商用平台，这在任何支付渠道（Visa/MC）、云厂商、应用商店都是**即时封号 + 刑事责任**。这不是道德说教，是平台存续前提。
3. **落地**：把现有 `is_nsfw` 扩成两层——
   - **成人内容年龄门**（你已有：用成人底模且未开 R18 → 403）；
   - **未成年性化内容硬阻断**（新增：提示词黑名单 + 输出侧未成年检测，命中直接拒绝并留证日志）。
   这一层设为**默认开启、不可被前端关闭**（见护栏）。

## §10 · 接入 model_profiles.py（注册模板 · A/D 期直接用）

新家族的识别与「采样/分辨率/CFG/负向」档案模板。**这是模板，具体贴合真实代码由你（Claude Code）在 A 期精确接线。**

```python
# —— 家族识别（扩展 detect_model_family，按文件名关键字）——
FAMILY_RULES = {
    "flux2":       ["flux.2", "flux2"],
    "qwen_image":  ["qwen-image", "qwen_image"],
    "z_image":     ["z-image", "z_image", "zimage"],
    "sdxl_real":   ["juggernaut", "realvis", "helloworld"],
    "illustrious": ["illustrious", "noobai", "nova-anime", "wai-illustrious"],
    "pony":        ["pony"],
}

# —— 每族的关键正确性档案 ——
PROFILES = {
    # 次世代：CFG=1 + guidance 节点，Euler+simple，禁 Karras，负向失效
    "flux2":      dict(sampler="euler", scheduler="simple", cfg=1.0, guidance=3.5,
                       megapixels=1.0, neg_prompt=False),
    "qwen_image": dict(sampler="euler", scheduler="simple", cfg=1.0,
                       megapixels=1.0, neg_prompt=False),
    "z_image":    dict(sampler="res_multistep", scheduler="simple", cfg=1.0, steps=8,
                       megapixels=1.0, neg_prompt=False),   # turbo 8 步；base 用 28–50/CFG3–5
    # SDXL 系：常规 CFG + 负向有效
    "sdxl_real":  dict(sampler="dpmpp_2m_sde", scheduler="karras", cfg=6.0,
                       megapixels=1.0, neg_prompt=True),
    "illustrious":dict(sampler="euler_ancestral", scheduler="normal", cfg=5.0,
                       megapixels=1.0, neg_prompt=True, vpred_autodetect=True),  # 保留你的 is_vpred→ModelSamplingDiscrete
    "pony":       dict(sampler="euler_ancestral", scheduler="normal", cfg=6.0,
                       megapixels=1.0, neg_prompt=True, score_tags=True),        # 自动补 score_9, score_8_up...
}
```

**要点**：
- Flux/Qwen/Z-Image 是 **CFG≈1 + guidance/FluxGuidance 节点**，采样器 **Euler/res_multistep + simple**，**严禁 Karras**；这几族**负向提示词失效**，合成器别发负向（要负向改挂 PAG）。
- NoobAI vpred → 继续走现有的 `ModelSamplingDiscrete(v_prediction, zsnr)` 逻辑。
- Pony → 自动补 score 标签；Illustrious/NoobAI → danbooru 标签方言；次世代 → 自然语言长句、忌堆质量词。
- 新训练出的 LoRA 落地后**自动生成一条 profile**（对应 D 期）。

---
---

# 附录 · 模型下载脚本（A 期按此生成 `download_models.sh`）

在 NAS 或 GPU 机上运行（Linux / macOS / Windows 的 WSL 或 Git-Bash 均可）。
**HuggingFace 部分**已填确切仓库并自动归位；**Civitai 部分**需填 `versionId` + token（版本号会随更新变动，打开模型页取最新）。

```bash
#!/usr/bin/env bash
# ToIV 模型批量下载（配合第二部分选型目录）
# 运行前：
#   1) pip install -U "huggingface_hub[cli]" aria2
#   2) huggingface-cli login            # 拉 gated 模型需 HF token
#   3) FLUX.2 原版需先到 huggingface.co/black-forest-labs/FLUX.2-dev 接受协议
#   4) Civitai：账号设置生成 API Token 填入 CIVITAI_TOKEN
# 用法：
#   export NAS_ROOT=/mnt/nas/ComfyUI/models
#   export CIVITAI_TOKEN=xxxxxxxx
#   bash download_models.sh [hf|civitai|all]
set -uo pipefail

NAS_ROOT="${NAS_ROOT:?请先 export NAS_ROOT=你的ComfyUI/models目录}"
CIVITAI_TOKEN="${CIVITAI_TOKEN:-}"
STAGE="${STAGE:-$NAS_ROOT/.staging}"
mkdir -p "$STAGE" \
  "$NAS_ROOT"/{checkpoints,diffusion_models,text_encoders,vae,loras,controlnet,upscale_models,ipadapter,clip_vision}

hf () { huggingface-cli download "$@"; }

pull_bundle () {   # $1=repo  $2=include_glob(默认 split_files/*)
  local repo="$1" glob="${2:-split_files/*}" out="$STAGE/${1//\//_}"
  echo ">>> [HF] $repo"
  hf "$repo" --include "$glob" --local-dir "$out" \
    || { echo "!!! 失败: $repo （确认 repo 名 / 是否需接受协议或登录）"; return; }
  for sub in diffusion_models text_encoders vae loras clip_vision controlnet; do
    [ -d "$out/split_files/$sub" ] && rsync -a "$out/split_files/$sub/" "$NAS_ROOT/$sub/"
  done
}

getf () {   # $1=repo  $2=file_in_repo  $3=dest_subdir
  local repo="$1" file="$2" dest="$NAS_ROOT/$3" out="$STAGE/${1//\//_}"
  echo ">>> [HF] $repo :: $file"
  hf "$repo" "$file" --local-dir "$out" || { echo "!!! 失败: $repo :: $file"; return; }
  mkdir -p "$dest"; cp -f "$out/$file" "$dest/$(basename "$file")"
}

civ () {   # $1=modelVersionId  $2=dest_subdir  $3=可读文件名
  [ -z "$CIVITAI_TOKEN" ] && { echo "!!! 跳过 Civitai（未设 CIVITAI_TOKEN）: $3"; return; }
  local vid="$1" dest="$NAS_ROOT/$2" name="$3"
  echo ">>> [Civitai] $name (version $vid)"
  mkdir -p "$dest"
  aria2c -x8 -s8 --content-disposition -d "$dest" \
    "https://civitai.com/api/download/models/${vid}?token=${CIVITAI_TOKEN}" || echo "!!! 失败: $name"
}

download_hf () {
  echo "==================== HuggingFace ===================="
  # 共用文本编码器 & VAE
  getf comfyanonymous/flux_text_encoders  t5xxl_fp16.safetensors  text_encoders
  getf comfyanonymous/flux_text_encoders  clip_l.safetensors      text_encoders
  getf black-forest-labs/FLUX.1-dev       ae.safetensors          vae   # Flux/Z-Image 共用（需接受协议）
  # 次世代通用/写实
  pull_bundle Comfy-Org/flux2-dev "*.safetensors"       # 多量化档，挑一个 fp8/bf16 放进 diffusion_models
  pull_bundle Comfy-Org/Qwen-Image_ComfyUI              # ← 确认该 repo 名；不对则用官方 Qwen/Qwen-Image 手动放置
  getf Comfy-Org/z_image_turbo  split_files/diffusion_models/z_image_turbo_bf16.safetensors  diffusion_models
  getf Comfy-Org/z_image_turbo  split_files/text_encoders/qwen_3_4b.safetensors              text_encoders
  # 视频（你已在用 Wan2.2；按需取消注释）
  # pull_bundle Comfy-Org/Wan_2.2_ComfyUI_Repackaged    # ← 确认 ComfyUI 打包 repo 名
  # pull_bundle Kijai/HunyuanVideo_comfy                # 配 ComfyUI-HunyuanVideoWrapper
  echo "HF 部分完成（失败项多为需接受协议/登录/确认文件名）"
}

download_civitai () {
  echo "==================== Civitai ===================="
  echo "打开每个模型页 → 选最新版本 → 从 Download 链接取 modelVersionId 替换 <VID>"
  # 写实 SDXL
  civ <VID> checkpoints "Juggernaut-XL-Ragnarok.safetensors"   # civitai.com/models/133005
  civ <VID> checkpoints "RealVisXL_V5.safetensors"             # civitai.com/models/139562
  civ <VID> checkpoints "HelloWorldXL_7.safetensors"           # 搜 HelloWorld XL
  # 二次元
  civ <VID> checkpoints "IllustriousXL_v2.safetensors"         # 搜 Illustrious XL
  civ <VID> checkpoints "NoobAI-XL_vpred_v1.safetensors"       # 搜 NoobAI-XL (V-Pred)
  civ <VID> checkpoints "NoobAI-XL_eps_v11.safetensors"        # 搜 NoobAI-XL (Epsilon)
  civ <VID> checkpoints "WAI-Illustrious-SDXL.safetensors"     # 搜 WAI-Illustrious
  civ <VID> checkpoints "NovaAnimeXL_IL_v19.safetensors"       # civitai.com/models/376130
  civ <VID> checkpoints "PonyDiffusion_V6XL.safetensors"       # civitai.com/models/257749
  # 风格化/概念
  civ <VID> checkpoints "DreamShaperXL.safetensors"            # 搜 DreamShaper XL
  civ <VID> checkpoints "ZavyChromaXL.safetensors"             # 搜 ZavyChromaXL
  # 放大 / 细节·加速 LoRA（示例）
  # civ <VID> upscale_models "4x-UltraSharp.pth"
  # civ <VID> loras "DetailTweakerXL.safetensors"
  echo "Civitai 部分完成（<VID> 未替换的会跳过，属正常）"
}

case "${1:-all}" in
  hf) download_hf ;;
  civitai) download_civitai ;;
  all) download_hf; download_civitai ;;
  *) echo "用法: bash download_models.sh [hf|civitai|all]"; exit 1 ;;
esac
echo "结束。临时区 $STAGE 确认无误后可删。接着按 §10 注册进 model_profiles.py。"
```
