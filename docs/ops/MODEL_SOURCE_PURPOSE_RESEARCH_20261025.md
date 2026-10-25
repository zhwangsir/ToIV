# 模型来源与用途调研（全量 · 证据分级）

> **生成时间**：2026-10-25 Asia/Shanghai  
> **加深核实轮**：同日；主库 88→B64/C22/D2；合计 D58→53；`MODEL_SOURCES` +64。  
> **Civitai+HF 定点轮**：同日；LoRA C/D 检索后 A21/B355/C19/D9；主库 88 残留 C22→B（现 B86/D2）；非 LoRA 表内 C/D 多数升 B；`MODEL_SOURCES` 再追加/回填（items≈1018）。  
> **用途确定度轮**：同日；对 A/B 来源抓卡页 → LoRA 用途 P-A94 / P-B257 / P-C53 / P-D0；产物 `MODEL_PURPOSE_FROM_CARDS_20261025.csv`。  
> **范围**：只读调研；未改服务、未 commit/push/部署、未起停容器。  
> **库存底表**：[`MODEL_AND_LORA_INVENTORY_20261025.md`](MODEL_AND_LORA_INVENTORY_20261025.md)  
> **LoRA 全量行表**：[`MODEL_SOURCE_PURPOSE_LORA_20261025.csv`](MODEL_SOURCE_PURPOSE_LORA_20261025.csv)（404 basename）  
> **账本**：`docs/MODEL_SOURCES.json`（ok=493 / blocked=337 / total=831）  
> **策划卡**：`apps/api/app/services/lora_catalog.py`（21）

## 1. 方法与证据等级

| 级 | 含义 | 本调研判定规则 |
|---|---|---|
| **A** | 产品/代码默认，或官方卡页+本仓点名 | 在跑服务 / gate 默认权重 / `lora_catalog` 策划卡 |
| **B** | 账本有可靠溯源 | `MODEL_SOURCES` status=ok 且含 `repo` 或 `source_url`（HF/Civitai/ModelScope/镜像） |
| **C** | 文件名/子目录启发式 | 能归入命名簇（Wan/LTX/加速/题材子目录等），**非**实测结论 |
| **D** | 未知 | 无账本、命名含糊、断链、或 blocked+provenance_lost |

**禁止**：把 C/D 写成「已确认用途」。用途栏对 C 一律带「命名启发式/候选」措辞。

数据来源：
1. 真机库存文档（2026-10-25 扫描）
2. `MODEL_SOURCES.json` 溯源字段（`repo` / `source_url` / `source_kind` / `notes`）
3. `lora_catalog.py` role/label/engines/strength
4. 命名与 NAS 子目录（`ancient_chinese/`、`camera_movement/`…）
5. 上游卡页：本轮 Exa 限流；A/B 链接以账本 URL 与已知官方包名为准（如 `Comfy-Org/MiniMax-H3`、`deepseek-ai/DeepSeek-V4.1-Flash-1017`）。未对 400+ LoRA 逐条打开卡页。

## 1.1 本轮核实的官方/主流卡页（抽查）

| 资产 | 用途（卡页级） | 上游 | 证据 |
|---|---|---|---|
| `minimax_h3_*_pruned_int8_convrot` | FL2VA=文/首末帧→视频；Ref2VA=参考图/视频/音频→视频；Comfy 模板默认 pruned int8 | [Comfy-Org/MiniMax-H3](https://huggingface.co/Comfy-Org/MiniMax-H3)；原模型 [MiniMaxAI/MiniMax-H3](https://huggingface.co/MiniMaxAI/MiniMax-H3)；[Comfy 教程](https://docs.comfy.org/tutorials/video/minimax/minimax-h3) | A（产品默认+官方包） |
| `Qwen-Rapid-AIO-SFW-v23` | Qwen-Image Rapid AIO 一体出图/编辑包 SFW v23 | [Phr00t/Qwen-Image-Edit-Rapid-AIO](https://huggingface.co/Phr00t/Qwen-Image-Edit-Rapid-AIO/blob/main/v23/Qwen-Rapid-AIO-SFW-v23.safetensors) | A（产品默认+HF 文件） |
| `DeepSeek-V4.1-Flash-1017`（Mia 变体） | 对话/剧本主脑；盘上为 EAQ+ablit+Engram 改装 | 基座 deepseek-ai；本仓在跑 TensorFold `:8888` | A（在跑）；基座卡页 B |
| VLM/Embed/ASR/Caption | 见 §3.1 | Qwen3-VL-8B / Qwen3-Embedding-4B / whisper-large-v3-mlx / joycaption-mlx | A |

其余数百条 **未**逐条打开卡页；B 级依赖 `MODEL_SOURCES` 已存 URL/repo。

## 2. 总览统计

### 2.1 覆盖行数

| 集合 | 行数 | A | B | C | D |
|---|---:|---:|---:|---:|---:|
| 非 LoRA（LLM/服务/ckpt/diffusion） | 280 | 12 | 160 | 82 | 26 |
| LoRA 去重 basename（三源并集） | 404 | 21 | 355 | 19 | 9 |
| **合计（Civitai+HF 定点轮后）** | **684** | **33** | **515** | **101** | **35** |

> 首轮：A33 / B322 / C271 / D58。加深轮：B390 / C208 / D53。本定点轮：主要把 **仍 C/D 的 LoRA** 与 **研究表内非 LoRA C/D** 对着 Civitai+HF 公开 API/卡页再升一档。

说明：checkpoint 在 NAS+Windows 各有一份时可能重复计行（同 basename 不同 path）；LoRA CSV 已按 basename 去重并合并 `path_root`。

### 2.2 覆盖率解读（诚实）

- **用途 A 级**：33 / 684 ≈ 4.8% —— 主要是在跑服务、产品默认、21 张策划卡（本轮未把 B 强行升 A）。
- **来源可达 B 级**：合计 **515**（LoRA B=355；非 LoRA B≈160，含研究表 C/D 升档）。
- **仅命名猜测 C 级**：合计 **101**（LoRA 19 + 非 LoRA≈82）。
- **完全未知/两站无命中 D 级**：合计 **35**（LoRA 9 + 非 LoRA≈26）。
- 主库 88 缺口：加深 64B + 本轮再消化原 C22→B；**仍 D 仅 2**（`30-360-high`、`i2l_smoke_20260827`）。

## 3. 非 LoRA：服务 / LLM / Checkpoint / Diffusion

### 3.1 在跑服务与产品默认（A）

| 名称 | 位置 | 来源候选 | 用途 | 证据 | URL |
|---|---|---|---|---|---|
| `DeepSeek-V4.1-Flash-1017` | spark02:8888 | product/running | 对话 LLM 生产入口（Mia EAQ+ablit+Engram） | A | https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017 |
| `mia-eaq-29-ablit` | spark ~/models | product/running | 同上权重目录 | A | — |
| `Qwen3-VL-8B-Instruct` | WS:9311 | product/running | 看图理解 / VLM | A | https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct |
| `Qwen3-Embedding-4B` | WS:9302 | product/running | 文本嵌入 | A | https://huggingface.co/Qwen/Qwen3-Embedding-4B |
| `IndexTTS-2.5` | WS:9200 | product/running | 配音 TTS | A | — |
| `whisper-large-v3-mlx` | openclaw:9310 | product/running | ASR 语音转写 | A | https://huggingface.co/mlx-community/whisper-large-v3-mlx |
| `joycaption-mlx-mxfp4` | openclaw:9305 | product/running | 图生描述 Caption | A | https://huggingface.co/n-Arno/joycaption-mlx-mxfp4 |
| `demucs-htdemucs` | WS:9220 | product/running | 人声伴奏分离 | A | — |
| `Qwen-Rapid-AIO-SFW-v23.safetensors` | NAS checkpoints | product/running | 出图产品默认 checkpoint | A | — |
| `minimax_h3_fl2va_pruned_int8_convrot.safetensors` | NAS h3/diffusion | product/running | H3 图→视频生产默认 | A | — |
| `minimax_h3_ref2va_pruned_int8_convrot.safetensors` | NAS h3/diffusion | product/running | H3 参考→视频生产默认 | A | — |
| `Qwen-Rapid-AIO-SFW-v23.safetensors` | NAS/checkpoints/Qwen-Rapid-AIO-SFW-v23.safetensors | Phr00t/Qwen-Image-Edit-Rapid-AIO | 出图产品默认 checkpoint | A | https://hf-mirror.com/Phr00t/Qwen-Image-Edit-Rapid-AIO/resolve/main/v23/Qwen-Rapid-AIO-SFW-v23.safetensors |

### 3.2 LLM / WS 库存（摘录）

| 名称 | 位置 | 来源/用途候选 | 证据 |
|---|---|---|---|
| `dsv4-flash-dspark-abliterated` | spark ~/models | 旧对话主脑权重（与 Mia 同卡互斥）；source=社区 abliterated DeepSeek-V4-Flash 变体 | B |
| `glm53-exl3` | spark ~/models | 候选对话 LLM（EXL3 量化库存）；source=GLM-5.3 族命名推断 | C |
| `glm53-dflash2-mxfp8` | spark ~/models | 候选对话草稿/小权重；source=命名推断 | C |
| `qwen3.6-35b-a3b-awq` | spark ~/models | 候选对话 LLM（AWQ）；source=Qwen3.6 MoE 命名推断 | C |
| `qwen3-vl-8b` | spark02 | VLM 权重库存（非生产口）；source=同族于生产 VLM | C |
| `euryale-70b` | spark | 断链 symlink，不可用；source=目标缺失 | D |
| `rocinante-12b` | spark | 断链 symlink，不可用；source=目标缺失 | D |
| `skyfall-31b` | spark | 断链 symlink，不可用；source=目标缺失 | D |
| `qwen38-flash-next-nvfp4` | WS ~/models | 大参数对话候选（库存）；source= | C |
| `LongCat-Video-ms` | WS ~/models | LongCat 视频相关权重树；source=ModelScope 命名 | C |
| `liveact` | WS ~/models | 库存目录，具体用途未核；source= | D |
| `SoulX-FlashTalk-14B` | WS ~/models | 口型/说话视频候选；source=FlashTalk 命名 | C |
| `ltx25` | WS ~/models | LTX 2.5 本地树；source= | C |
| `Qwen3-VL-32B-Instruct-FP8` | WS ~/models | 更大 VLM 库存；source=https://huggingface.co/Qwen/Qwen3-VL-32B-Instruct | B |
| `joycaption-beta-one` | WS ~/models | JoyCaption 权重库存（生产在 openclaw）；source=https://huggingface.co/fancyfeast/llama-joycaption | B |
| `Qwen2.5-VL-7B-Instruct` | WS ~/models | 旧 VLM 库存；source=https://huggingface.co/Qwen/Qwen2.5-VL-7B-Instruct | B |
| `Fun-CosyVoice3-0.5B` | WS ~/models | TTS 库存（旧口 DOWN）；source= | B |
| `CosyVoice2-0.5B` | WS ~/models | TTS 库存；source= | B |
| `Qwen3-TTS-1.7B-Base` | WS ~/models | TTS 库存；source= | C |
| `musetalk` | WS ~/models | 口型同步候选；source= | C |
| `FireRedASR` | WS ~/models | ASR 库存；source= | C |
| `SenseVoice` | WS ~/models | ASR/语音理解库存；source= | C |

### 3.3 Checkpoints（NAS 38 + Windows 32）

按命名簇汇总（逐文件见库存 §4.1/§4.2；账本有 repo 升为 B）：

| 用途簇（候选） | 约计数 |
|---|---:|
| 二次元/Pony/Illustrious 系 SDXL | 33 |
| Lightricks LTX 视频基座/蒸馏包 | 9 |
| Qwen-Image Rapid AIO 一体出图包 | 9 |
| SDXL/SD 写实出图 checkpoint | 6 |
| Wan2.2 Rapid/Mega AIO 视频一体包 | 5 |
| FLUX 文生图/填充基座 | 3 |
| SUPIR 图像超分/修复 | 2 |
| Depth Anything V2 深度估计 | 1 |
| 出图产品默认 checkpoint | 1 |
| Wan FusionX 视频相关 | 1 |

Checkpoint 证据分布：{'B': 23, 'C': 46, 'A': 1}

**产品默认（A）**：`Qwen-Rapid-AIO-SFW-v23.safetensors` —— 出图默认；同源 NSFW/旧版本线在盘上并存（B/C）。

代表性 B 级来源（账本）：

| basename | repo / url | 用途候选 |
|---|---|---|
| `depth_anything_v2_vitl.pth` | depth-anything/Depth-Anything-V2-Large | Depth Anything V2 深度估计 |
| `ltx-2.3-22b-dev-fp8mixed.safetensors` | Lightricks/LTX-2.3-fp8 | Lightricks LTX 视频基座/蒸馏包 |
| `ltx-2.3-22b-dev-fp8.safetensors` | local-alias | Lightricks LTX 视频基座/蒸馏包 |
| `ltx-2.3-22b-distilled-fp8.safetensors` | Lightricks/LTX-2.3-fp8 | Lightricks LTX 视频基座/蒸馏包 |
| `ltxv-2b-0.9.6-dev-04-25.safetensors` | Lightricks/LTX-Video | Lightricks LTX 视频基座/蒸馏包 |
| `ltxv-2b-0.9.6-dev-04-25-v1.safetensors` | Lightricks/LTX-Video | Lightricks LTX 视频基座/蒸馏包 |
| `majicmixRealistic_v7.safetensors` | marcy1111/majicmixRealistic_v7 | SDXL/SD 写实出图 checkpoint |
| `moodyRealMix_zitV5DPO.safetensors` | LoneWolfVPS/TIZ_TESTING | SDXL/SD 写实出图 checkpoint |
| `new_Qwen-Rapid-AIO-NSFW-v19.safetensors` | Phr00t/Qwen-Image-Edit-Rapid-AIO | Qwen-Image Rapid AIO 一体出图包（SFW/NSFW 版本线） |
| `new_Qwen-Rapid-AIO-NSFW-v23.safetensors` | Phr00t/Qwen-Image-Edit-Rapid-AIO | Qwen-Image Rapid AIO 一体出图包（SFW/NSFW 版本线） |
| `Qwen-AIO-SFW-v18.safetensors` | Phr00t/Qwen-Image-Edit-Rapid-AIO | Qwen-Image Rapid AIO 一体出图包（SFW/NSFW 版本线） |
| `Qwen-Rapid-AIO-NSFW-v7.safetensors` | Phr00t/Qwen-Image-Edit-Rapid-AIO | Qwen-Image Rapid AIO 一体出图包（SFW/NSFW 版本线） |

### 3.4 Diffusion_models（NAS 177）

| 用途簇（候选） | 计数 |
|---|---:|
| Wan 2.1/2.2 视频 diffusion（T2V/I2V/Animate/VACE 等） | 69 |
| diffusion 权重（命名未细拆） | 29 |
| Qwen-Image / Edit 文生图·编辑 diffusion | 25 |
| FLUX / Flux2 Klein 文生图 diffusion | 15 |
| Z-Image 文生图 | 14 |
| LTX 2.x 视频 transformer/蒸馏 | 9 |
| FireRed Image Edit | 4 |
| Wan22 Bernini HIGH/LOW 社区包 | 2 |
| Krea-2 Turbo | 2 |
| LongCat 视频 | 2 |
| Phantom-Wan 变体 | 2 |
| Z-Image 社区美化包 | 1 |
| ERNIE Image Turbo | 1 |
| 混元视频 | 1 |
| MiniMax H3 / 社区微调 图·参考→视频 diffusion | 1 |

Diffusion 证据分布：{'B': 116, 'C': 35, 'D': 26}

**H3 生产默认（A）**：
- `minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- 上游包装线索：账本可见 `Comfy-Org/MiniMax-H3`（部分 turbo LoRA）；社区还有 10Eros Max H3 变体（B）。

**Wan 系（多数 B/C）**：T2V/I2V HIGH·LOW、Animate-14B、VACE、FusionX、Remix NSFW、lightx2v 融合权重等 —— 用途是「视频 diffusion 不同任务头」，具体哪条工作流吃哪个文件以 engines/workflow 为准。

**Qwen-Image / Edit / Layered / Lightning·SVDQ**：文生图与编辑主干及量化加速包。

**FLUX / Flux2 Klein / DarkBeast / Krea / Z-Image / LTX / LongCat / FireRed Edit**：见上表簇；有 `MODEL_SOURCES.repo` 者为 B。

## 4. LoRA：簇说明 + 全量 CSV

去重 **404** basename。全量逐行：[`MODEL_SOURCE_PURPOSE_LORA_20261025.csv`](MODEL_SOURCE_PURPOSE_LORA_20261025.csv)。

### 4.1 策划卡 A 级（21）—— 产品视频提交唯一认名字来源

| basename | 用途（策划） | engines |
|---|---|---|
| `56Low-noise-Cumshot-Aesthetics.safetensors` | [策划卡] 体液美学·LOW · role=aesthetics · engines=wan · nsfw=True | 见 catalog |
| `AI_Girl_Fictional_Women_Series30_H3.safetensors` | [策划卡] 架空女性角色 · role=aesthetics · engines=h3 · nsfw=False | 见 catalog |
| `DR34ML4Y_I2V_14B_LOW_V2.safetensors` | [策划卡] 体位五件套·LOW · role=pose · engines=wan · nsfw=True | 见 catalog |
| `H3_footjob_v0_step1000_fixed.safetensors` | [策划卡] 足交 · role=pose · engines=h3 · nsfw=True | 见 catalog |
| `HMNSFW_AIO_V2.safetensors` | [策划卡] HMNSFW AIO 综合 · role=concept · engines=h3 · nsfw=True | 见 catalog |
| `NSFW-22-H-e8.safetensors` | [策划卡] 通用 NSFW 概念·HIGH · role=concept · engines=wan · nsfw=True | 见 catalog |
| `SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors` | [策划卡] NaughtyTimes 综合动作 · role=concept · engines=h3 · nsfw=True | 见 catalog |
| `WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors` | [策划卡] POV 体精/拔出·HIGH · role=cumshot · engines=wan · nsfw=True | 见 catalog |
| `Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors` | [策划卡] 加速 v1030·HIGH · role=accel · engines=wan · nsfw=True | 见 catalog |
| `cxy_kiss_lora_h3_v01_step1500.safetensors` | [策划卡] 亲吻(SFW) · role=pose · engines=h3 · nsfw=False | 见 catalog |
| `deepthroat_v1.safetensors` | [策划卡] 深喉 · role=pose · engines=h3 · nsfw=True | 见 catalog |
| `h3_musubi_v4-000040.safetensors` | [策划卡] Innie Pussy · role=anatomy · engines=h3 · nsfw=True | 见 catalog |
| `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | [策划卡] 运镜 Dolly Left · role=camera · engines=ltx · nsfw=False | 见 catalog |
| `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` | [策划卡] LTX 动态增强 · role=motion · engines=ltx · nsfw=False | 见 catalog |
| `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors` | [策划卡] H3 lightx2v Turbo · role=accel · engines=h3 · nsfw=False | 见 catalog |
| `minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors` | [策划卡] H3 Turbo 850 剪枝 · role=accel · engines=h3 · nsfw=False | 见 catalog |
| `minimax_vag_000002500.safetensors` | [策划卡] H3 Vagina · role=anatomy · engines=h3 · nsfw=True | 见 catalog |
| `riding_pose_H3_i2v_v1.0.safetensors` | [策划卡] 骑乘位 POV · role=pose · engines=h3 · nsfw=True | 见 catalog |
| `stomach_bulge_H3_i2v_v1.0.safetensors` | [策划卡] 腹部隆起 · role=physics · engines=h3 · nsfw=True | 见 catalog |
| `vagassist_e40.safetensors` | [策划卡] HMPussy · role=anatomy · engines=h3 · nsfw=True | 见 catalog |
| `wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors` | [策划卡] 胸部物理·HIGH · role=physics · engines=wan · nsfw=True | 见 catalog |

### 4.2 命名簇总表（每条 basename 在 CSV；此处只写簇）

| 簇 ID | 条数 | 用途候选（C 除非另有 A/B） |
|---|---:|---|
| `accel_distill` | 77 | 加速/蒸馏/少步采样（命名启发式） |
| `wan_family` | 49 | Wan 视频系 LoRA（I2V/T2V/Animate 适配，命名启发式） |
| `opaque` | 40 | 命名含糊，用途未知 |
| `nsfw_action` | 37 | 成人动作/NSFW 概念或体位（命名明示/leet；用途候选） |
| `ltx_family` | 23 | LTX 视频系 LoRA（底座/运镜/蒸馏/题材，命名启发式） |
| `edit_control` | 16 | 图像编辑/局部控制/IC-LoRA（命名启发式） |
| `accel_generic` | 16 | 加速/少步 LoRA（命名启发式） |
| `identity` | 15 | 人物一致/换脸/角色迁移（命名启发式） |
| `slider_style` | 13 | 滑条/细节/光影/风格增强（命名启发式） |
| `flux_family` | 13 | FLUX / Flux2 Klein 系 LoRA（命名启发式） |
| `catalog:h3` | 13 | 架空女性角色 · role=aesthetics · engines=h3 · nsfw=False |
| `h3_family` | 13 | MiniMax H3 视频 LoRA（命名启发式） |
| `camera_pose` | 11 | 运镜/姿态控制（命名启发式） |
| `theme_path:ltx2.3` | 8 | LTX-2.3 视频适配 LoRA |
| `zimage` | 6 | Z-Image 系 LoRA（命名启发式） |
| `catalog:wan` | 6 | 体液美学·LOW · role=aesthetics · engines=wan · nsfw=True |
| `theme_path:camera_movement` | 5 | 运镜/镜头运动（子目录） |
| `theme_path:special_effects` | 5 | 特效风格（子目录） |
| `theme_path:ancient_chinese` | 4 | 题材：古风/汉服（子目录） |
| `theme_path:campus` | 4 | 题材：校园/二次元细节（子目录） |
| `theme_path:comedy_romantic` | 4 | 题材：喜剧/浪漫/婚礼（子目录） |
| `theme_path:director_style` | 4 | 题材：导演/影调风格（子目录） |
| `theme_path:history_war` | 4 | 题材：历史/战争（子目录） |
| `theme_path:horror_thriller` | 4 | 题材：恐怖/惊悚（子目录） |
| `theme_path:luxury_business` | 4 | 题材：奢华/商务（子目录） |
| `theme_path:modern_urban` | 4 | 题材：现代都市（子目录） |
| `qwen_img` | 3 | Qwen-Image / Edit 系（命名启发式） |
| `catalog:ltx` | 2 | 运镜 Dolly Left · role=camera · engines=ltx · nsfw=False |
| `longcat` | 1 | LongCat 视频适配/蒸馏（命名启发式） |

### 4.3 簇解读（给设置页/混搭用）

1. **`accel_distill` / `accel_generic`（~93）**：少步/蒸馏加速（lightx2v、Lightning、Hyper、FastWan…）。挂视频或出图基座上缩短步数；强度与基座强相关，除策划卡外未测最优。
2. **`wan_family` + NSFW 动作（~86）**：Wan2.1/2.2 I2V·T2V 适配与成人动作。产品只应优先暴露 catalog 六件套；其余当库存专家项。
3. **`ltx_family` + `theme_path:ltx2.3`（~31）**：LTX 蒸馏、运镜、IC-LoRA、题材。运镜类与 catalog dolly-left 同类。
4. **`h3_family` + catalog:h3（~26）**：MiniMax H3；其中 13 张策划卡 A，其余多为 Civitai 溯源 B 或命名 C。`h3_musubi_v4` 账本 **blocked/provenance_lost**（上游下架）但仍在盘且在 catalog。
5. **`edit_control` / `identity` / `flux_family` / `qwen_img`**：编辑、一致、换脸、FLUX/Qwen 画风。
6. **题材子目录（campus/horror/…）**：历史为短剧题材包归档；**不等于**当前产品默认推荐。
7. **`opaque`（40）**：命名含糊 → 多数 D 或弱 C；优先补查队列见 §5。

## 5. 仍未知清单（优先补查队列）

### 5.1 D 级 LoRA 样例（完整见 CSV `evidence=D`）

- `30-360-high.safetensors`
- `hyvideo_FastVideo_LoRA-fp8.safetensors`
- `i2l_smoke_20260827.safetensors`
- `Black_White_Documentary_Photo.safetensors`
- `bounceV03-000084.safetensors`
- `Bright_Colorful_Photos.safetensors`
- `cknb02_stabilizer_v0.304a_fp16.safetensors`
- `CloseUpFacialCum-v10_High.safetensors`
- `cutifier_krea2.safetensors`
- `elie-xl-nvwls-v1.safetensors`
- `Fantasy_Medieval_Street.safetensors`
- `Mystic-XXX-ZIT-V5.safetensors`
- `NaughtyTimes_pruned_r128_v2.safetensors`
- `realism_engine_krea2_v3.1.safetensors`
- `RealisticSnapshotKrea2.safetensors`
- `RealSkin_xxXL_v1.safetensors`
- `reverse_suspended_congress_I2V_high.safetensors`
- `reverse_suspended_congress_I2V_low.safetensors`
- `reverse_suspended_congress_T2V_High.safetensors`
- `reverse_suspended_congress_T2V_Low.safetensors`
- … 共 **28** 个 LoRA D 级

### 5.2 主库有、账本无（88）—— 加深轮已处理（见 §7）

> 加深后：B64 已入账；仍 C22+D2。完整逐条见 `MODEL_SOURCE_PURPOSE_DEEPEN_88_20261025.csv`。原名单见库存 §6；典型（历史）：

- `1980s_horror_krea2.safetensors`
- `30-360-high.safetensors`
- `LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors`
- `LTX2.3-NSFWMOTION_00750.safetensors`
- `LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors`
- `LongCat_distill_lora_alpha64_bf16.safetensors`
- `LongCat_refinement_lora_rank128_bf16.safetensors`
- `Qwen-Edit-2509-Multiple-angles.safetensors`
- `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors`
- `SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors`
- `SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors`
- `Sulphur_LTX2.3_better_NSFW_motion.safetensors`
- `Wan2.1-Fun-1.3B-InP-MPS_reward_lora_comfy.safetensors`
- `Wan2.1-Fun-14B-InP-MPS.safetensors`
- `Wan2.1_I2V_14B_FusionX_LoRA.safetensors`
- `Wan2.1_T2V_14B_CineScale_ntk20_lora_rank16_fp16.safetensors`
- `Wan2.1_T2V_14B_FusionX_LoRA.safetensors`
- `Wan2.2-Fun-A14B-InP-HIGH-MPS_resized_dynamic_avg_rank_21_bf16.safetensors`
- `Wan2.2-Fun-A14B-InP-LOW-MPS_resized_dynamic_avg_rank_22_bf16.safetensors`
- `Wan2.2-Fun-A14B-InP-high-noise-HPS2.1.safetensors`
- `Wan2.2-Lightning_T2V-v1.1-A14B-4steps-lora_HIGH_fp16.safetensors`
- `Wan21_AccVid_T2V_14B_lora_rank32_fp16.safetensors`
- `Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors`
- `Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors`
- `Wan2_1_Skyreels-v2-I2V-720P_LoRA_rank_adaptive_quantile_0.20_fp16.safetensors`
- …（共 88）

### 5.3 非 LoRA D / 断链

- spark symlink：`euryale-70b` / `rocinante-12b` / `skyfall-31b`
- WS：`liveact` 等目录用途未核
- checkpoint/diffusion 中命名无法归簇且无账本 repo 者（见上表 D 计数）

### 5.4 账本 blocked（337）

多为 untraceable / 社区改名 / 本地导出。**文件可能仍可用**，但不能再可靠补下载。H3 例：`h3_musubi_v4-000040.safetensors`（civitai 原模型页已下架）。

## 6. 与 MODEL_SOURCES / lora_catalog 的差异与字段建议

| 现状 | 问题 | 建议 |
|---|---|---|
| `MODEL_SOURCES` 无 `purpose`/`tags`/`engines`/`nsfw` | 只能溯源不能解释用途 | 增加可选字段：`purpose_one_liner`, `capability_tags[]`, `base_family`, `evidence` |
| ok 条目 notes 偏下载痕迹 | 偶有用途句（如 BFS） | 把用途句提升为正式字段，避免埋在 notes |
| 主库 88 + Windows 大量未入账 | 设置页无法标注来源 | 批量：磁盘 basename ∉ 账本 → `status=present_untracked` + 启发式 tags |
| `lora_catalog` 仅 21 | 与 NAS 264 落差大 | **保持窄策划集**；库存浏览用灰标，勿把全目录当混搭池 |
| blocked+仍在 catalog | 产品能选但不可再溯源 | UI 标注「本地可用 · 上游失效」 |

### 6.1 建议下一步（给产品）

1. **只把 A+B 进设置库存标签**（来源链接 + 一句话用途）；C 灰标「命名推断·待确认」；D 默认折叠。
2. 补账本：先 88 主库缺口，再 Windows-only。
3. 对 `opaque`/D 做抽查（Civitai by-hash / HF 搜索），能升 B 再升，升不了保持 D。
4. **不要**为了「看起来全知道」把 C 写成 A。

## 7. 附录：证据合计公式

- 非 LoRA行 = 在跑/LLM库存摘录 + checkpoints(70) + diffusion(177)
- LoRA行 = 三源 basename 去重 404
- 全表合计 **684** = A33 + B322 + C271 + D58

本轮产出文件：
- 本文件
- `MODEL_SOURCE_PURPOSE_LORA_20261025.csv`
- 库存文档已加指针（见该文件文首）

未改服务 / 未 commit。


## 7. 加深核实轮（2026-10-25 Asia/Shanghai）

> **目标**：证明「产品相关」能推进到 A/B；不假装 100%。只读真机/网页；已追加有证据的 `MODEL_SOURCES` 条目；**未** commit/push/部署/改运行中模型。

### 7.1 一句话结论（给用户）

**能查清、且对本产品有意义的部分，主要是在跑默认、官方/主流加速蒸馏包、以及主库里文件名还能对上卡页的那一批——本轮已把主库 88 缺口中的 64 条升到 B 并写入账本；**  
**做不到假装全清的，是 leetspeak/私训日期戳/上游下架/仅有哈希镜像/断链大模型，以及大量「画风文件名像 Civitai 但哈希对不上」的社区款——这些会长期停在 C 灰标或 D。**

### 7.2 统计对比

| 集合 | 上轮 A/B/C/D | 本轮 A/B/C/D |
|---|---|---|
| LoRA 404 | 21 / 177 / 178 / 28 | **21 / 245 / 115 / 23** |
| 合计 684 | 33 / 322 / 271 / 58 | **33 / 390 / 208 / 53** |

- LoRA **B +68**（主库缺口补链为主；另 D→B：`hyvideo_FastVideo` + `reverse_suspended_congress_*`×4）。
- LoRA **D −5**；合计 **D −5**。
- `MODEL_SOURCES`：追加 **64** 条 `status=ok`（batch=`deepen_20261025`）；totals ok **493→557** / total **831→895**。备份：`docs/MODEL_SOURCES.json.bak.deepen-20261025`。草稿副本：`docs/ops/MODEL_SOURCES_APPEND_DRAFT_20261025_deepen.json`。

### 7.3 主库 88 缺口结果

逐条表：[`MODEL_SOURCE_PURPOSE_DEEPEN_88_20261025.csv`](MODEL_SOURCE_PURPOSE_DEEPEN_88_20261025.csv)

| 结果 | 条数 | 说明 |
|---|---:|---|
| 升 **B**（有 upstream URL） | **64** | 已追加进 `MODEL_SOURCES` |
| 仍 **C**（命名簇，无精确卡页） | **22** | 多为 Flux/LTX/Krea 画风本地改名 |
| 仍 **D** | **2** | `30-360-high`（仅哈希镜像）、`i2l_smoke_20260827`（私训日期戳） |

**升 B 的高价值簇（模板）**：

| 簇 | 代表 basename | 上游 | 用途一句话 |
|---|---|---|---|
| 加速·Hyper-SD / Lightning | `hyper_sdxl_*` / `lightning_sdxl_*` / `hyper_flux_8step_*` | ByteDance/Hyper-SD、ByteDance/SDXL-Lightning | 少步数出图加速 |
| 加速·Wan lightx2v / Lightning | `Wan21_*lightx2v*` / `Wan2.2-Lightning_*` / `Wan_2_2_*lightx2v*` | lightx2v/* 、Kijai/WanVideo_comfy | Wan 约 4 步蒸馏 |
| 加速·FusionX / AccVid / CausVid / rCM / Self-Forcing | `*_FusionX_*` / `Wan21_AccVid_*` / `*_rCM_*` / `*_self_forcing_*` | vrgamedevgirl84、Kijai | Wan 加速/蒸馏变体 |
| 奖励·Wan-Fun MPS/HPS | `Wan2.*-Fun-*MPS*` / `*HPS2.1*` | alibaba-pai/*Fun-Reward-LoRAs*、Kijai 压缩口 | 观感/偏好奖励 LoRA |
| 长视频·SVI | `SVI_v2_PRO_*` | Kijai …/Stable-Video-Infinity | Wan2.2 长视频高/低噪声对 |
| LTX IC / 蒸馏 / Foley | `ltx-2.3-22b-ic-*` / `*distilled-lora*` / `*foley*` / `*Cameraman*` | Lightricks/* 、Cseti/Cameraman | 口型/运镜/控制/加速 |
| 编辑·Qwen / ChronoEdit | `Qwen-*-Lightning*` / `*Multiple-angles*` / `chronoedit_distill_*` | lightx2v、fal、Comfy-Org、nvidia | 编辑加速与多机位 |
| 人脸 | `ip-adapter-faceid-plusv2_*` / `ostris_face_helper_*` | h94、ostris | FaceID 配套 / 近景脸 |
| 画风·可对卡 | `1980s_horror_krea2` / `ghost_glitter_*` / `krea_rainy_window` / `Sulphur_LTX2.3_*` | Civitai / krea / ilkerzgi | 题材画风（family 匹配） |

**仍 D（88 内）永久/近永久原因**：

| basename | 原因 |
|---|---|
| `30-360-high.safetensors` | 仅 CivArchive 文件哈希，无作者卡页/触发词/基座说明 |
| `i2l_smoke_20260827.safetensors` | 本地日期戳，像私训导出；公网无同名卡 |

### 7.4 原 D≈28 LoRA 再攻

| 动作 | 条数 | 例子 |
|---|---:|---|
| D→B | 5 | `hyvideo_FastVideo_LoRA-fp8`；`reverse_suspended_congress_{I2V,T2V}_{high,low,High,Low}` |
| 仍 D | 23 | `cutifier_krea2`、`sht_sunian/suxue/xiaoyan`、`elie-xl-nvwls-v1`、`cknb02_stabilizer_*`、多数 Windows 题材短名 |

**永久未知典型原因**（可复用标签）：

1. **opaque/leetspeak 短名**：无 upstream 可检索（`sht_*`、`elie-xl-nvwls`）。
2. **上游下架 / blocked**：账本已标 blocked，卡页 404（参见原 §5.4）。
3. **仅哈希镜像**：CivArchive sha 页无模型元数据。
4. **断链大模型**：spark `euryale-70b` / `rocinante-12b` / `skyfall-31b` symlink（非 LoRA，仍 D）。
5. **本地私训日期戳**：`i2l_smoke_20260827`。

### 7.5 C 簇模板（已各核实代表款→B，同簇其余可跟读）

1. **加速/蒸馏（出图）**：以 ByteDance Hyper-SD / SDXL-Lightning 为模板 → 本地 `hyper_*` / `lightning_sdxl_*` 按步数映射官方文件名。  
2. **Wan 适配加速**：以 lightx2v + Kijai/WanVideo_comfy 为模板 → `*lightx2v*` / `*Lightning*` / `*FusionX*` / `*AccVid*` / `*rCM*`。  
3. **画风文件夹代表**：以可命中卡页者为模板（`1980s_horror_krea2`、`ghost_glitter_*`、`krea_rainy_window`）→ 同目录未命中者保持 **C 灰标**，不要自动升 B。

### 7.6 可查清边界（产品建议）

| 层级 | 策略 |
|---|---|
| 设置库存标签 | **只亮 A+B**（来源链接 + 一句话用途） |
| C | 灰标「命名推断·待确认」；允许高级用户自选，不假装官方 |
| D | 默认折叠；展示永久原因标签 |
| 继续补账 | Windows-only 与剩余 C22 可按「用户点名」再开一轮，不必全量扫 |

### 7.7 产物路径

- 本调研（含本章）：`docs/ops/MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md`
- LoRA CSV（已更新证据级）：`docs/ops/MODEL_SOURCE_PURPOSE_LORA_20261025.csv`
- 88 逐条加深表：`docs/ops/MODEL_SOURCE_PURPOSE_DEEPEN_88_20261025.csv`
- 账本：`docs/MODEL_SOURCES.json`（+64）；备份 `.bak.deepen-20261025`；追加草稿 `docs/ops/MODEL_SOURCES_APPEND_DRAFT_20261025_deepen.json`


## 8. Civitai + Hugging Face 定点轮（2026-10-25 Asia/Shanghai）

> **起因**：用户判断「所有模型来源都是 Civitai 和 HuggingFace，应该能查清楚」。本轮只对 **仍为 C/D** 的条目做两站定点检索（公开 API + 必要时 WebSearch），有 URL 证据才升 B；两站都找不到则标 `civ+hf:no-hit`，**不假装查清**。  
> **冻结**：只读服务；可写文档/CSV/`MODEL_SOURCES`；**未** commit / push / 部署 / 起停容器。

### 8.1 方法

1. 输入：LoRA CSV 中 `evidence∈{C,D}`（加深后 115C+23D），优先主库加深残留 22C+2D；并扫研究文档 §3.2 表内非 LoRA C/D。  
2. 对 basename 规范化（去扩展名、版本/`_r128`/`_flux` 等后缀、空格化、少量 leetspeak 还原）后查询：
   - Hugging Face `GET /api/models?search=`
   - Civitai `GET /api/v1/models?query=`（先 `types=LORA`，无命中再全类型）
3. 命中评分：精确文件名 > id/name 强重叠 > 子串；**score≥60** 升 B，并记 `source_url` / `repo` / 一句话用途；弱命中不升。  
4. 无命中：`notes=civ+hf:no-hit` + 原因猜测（私训日期戳 / leetspeak·NSFW 改名 / 已删卡 / 本地蒸馏导出 / 断链）。  
5. 账本：仅当具备 URL 证据时追加或回填 `MODEL_SOURCES`（batch=`civhf-20261025`）；备份 `docs/MODEL_SOURCES.json.bak.civhf-20261025`。

### 8.2 结果统计

| 集合 | 定点轮前 A/B/C/D | 定点轮后 A/B/C/D |
|---|---|---|
| LoRA 404 | 21 / 245 / 115 / 23 | **21 / 355 / 19 / 9** |
| 非 LoRA 280（研究表 C/D 子集已检索；ckpt/diffusion 全量未再逐文件扫） | 12 / 145 / 93 / 30 | **12 / ~160 / ~82 / ~26** |
| **合计 684** | 33 / 390 / 208 / 53 | **33 / ~515 / ~101 / ~35** |
| 主库加深 88 | B64 / C22 / D2 | **B86 / C0 / D2** |

- LoRA **升 B：+110**（C→B 为主；含 alias/官方卡补强如 `lightx2v/Wan2.2-Lightning`、`GoSilla/WAN2.2-I2V-POV-Cowgirl`、Luneva/Stabilizer/Xianxia 等）。  
- LoRA **两站无命中：28**（见下）。  
- 非 LoRA 研究表 **17 升 B / 1 无命中**（`glm53-dflash2-mxfp8`）；断链三件套找到上游卡页但**本地 symlink 仍坏**（来源 B、可用性仍废）。  
- `MODEL_SOURCES` items 约 **895→1018**（含追加与缺 URL 回填）。

### 8.3 是否支持「主源就是两站、应该能查清」

**基本支持，但要改边界表述：**

| 判断 | 结论 |
|---|---|
| 公网社区权重的主发布面是不是 Civitai + Hugging Face？ | **是**。本轮升 B 的命中几乎全落在这两站（偶发 GitHub 官方页如 Demucs）。 |
| 对着两站能不能把「还在盘上的公开款」查到来源？ | **大多能**。LoRA 原 C/D 里约 **80%**（110/138）升到 B。 |
| 能不能 100% 查清到用途 A？ | **不能**。A 仍要求产品默认/在跑/策划卡；本轮**故意不把 B 吹成 A**。 |
| 两站都找不到时说明什么？ | 常见是：**本地私训/冒烟导出**、**leetspeak·NSFW 改名**、**卡页删除**、**仅哈希镜像**、**蒸馏中间步本地改名**——不是「还有第三大源没搜」。 |

一句话给用户：**主源判断成立；公开可检索的已经大部分能查清到 B；剩下那一小撮在两站也没有稳定卡页，应标「两站无命中」而不是继续空转。**

### 8.4 两站无命中典型（LoRA 28）

| 类型 | 例子 | 原因标签 |
|---|---|---|
| 本地/私训冒烟 | `toiv_h3_smoke_v1_30steps`、`h3_flywheel_smoke6_20260827`、`i2l_smoke_20260827`、`zimage_i2l_flatvector_smoke` | private/smoke |
| 仅哈希/无名卡 | `30-360-high` | hash-only / civ+hf:no-hit |
| leetspeak·NSFW 改名 | `wan22-f4c3spl4sh-*`、`sht_sunian/suxue/xiaoyan`、`epic_cumshots-…CUMSH0T` | rename/leetspeak |
| 本地蒸馏/导出文件名 | `tutu*_minimax_h3_av_20to8*`、`NaughtyTimes_pruned_r128_v2` | local-export |
| 社区短名对不上卡 | `cutifier_krea2`、`bounceV03-000084`、`slop_twerk_*`、`Wan22_CumV3_*`、`Hip_Slammin_*`、`FutaTF_*` 等 | deleted-or-renamed |
| 非 LoRA | `glm53-dflash2-mxfp8` | 本地草稿量化目录，两站无同名 |

完整检索行表：[`MODEL_SOURCE_PURPOSE_CIVHF_20261025.csv`](MODEL_SOURCE_PURPOSE_CIVHF_20261025.csv)  
非 LoRA 子集：[`MODEL_SOURCE_PURPOSE_CIVHF_NONLORA_20261025.csv`](MODEL_SOURCE_PURPOSE_CIVHF_NONLORA_20261025.csv)

### 8.5 产物与账本

- 本调研 §8（本章）
- LoRA CSV 已更新证据：`MODEL_SOURCE_PURPOSE_LORA_20261025.csv`（B355/C19/D9）
- 定点检索明细：`MODEL_SOURCE_PURPOSE_CIVHF_20261025.csv`
- 非 LoRA 定点：`MODEL_SOURCE_PURPOSE_CIVHF_NONLORA_20261025.csv`
- 加深 88 表：残留 C22 已在本轮升 B → **B86 / D2**
- 账本：`docs/MODEL_SOURCES.json`（bak `.bak.civhf-20261025`）
- 统计快照：`docs/ops/_civhf_stats_20261025.json`

### 8.6 产品建议（更新）

设置库存继续 **只亮 A+B**；C 灰标；D / `civ+hf:no-hit` 默认折叠并显示原因标签。不必再为「全盘变 A」开轮次——边际收益已低。


## 9. 用途确定度（卡页抽取 · 2026-10-25 Asia/Shanghai）

> **用户问**：「他们的作用能确定吗？」  
> **本轮**：对已有 Civitai/HF URL（来源 A/B）的条目抓卡页元数据，单独标 **用途确定度** P-A/B/C/D（与来源证据 A/B/C/D **正交**）。  
> **冻结**：只读服务；可写文档/CSV/`MODEL_SOURCES.notes`；**未** commit / push / 部署。

### 9.1 用途等级定义

| 级 | 含义 | 判定 |
|---|---|---|
| **P-A** | 用途写死 | `lora_catalog` 策划卡；在跑/产品默认服务；或 **官方技术卡页** 明确功能（Hyper-SD / Lightning / FaceID / LTX IC / ChronoEdit / Wan-Animate 等） |
| **P-B** | 可稳定归类 | Civitai 标题+tags+基座，或 HF tags/pipeline/包说明，能归入：加速蒸馏 / 画风 / 角色人脸 / 运镜姿态 / 编辑控制 / NSFW 概念 等 |
| **P-C** | 仅模糊/文件名 | 无可靠 URL、HF 仅通用 tags、命名启发式、簇模板无卡页 |
| **P-D** | 无用途信息 | 本轮 LoRA 去重后 **0**（残口已并入 P-C 或有弱标签） |

### 9.2 数量（LoRA 去重 404）

| P-A | P-B | P-C | P-D |
|---:|---:|---:|---:|
| **94** | **257** | **53** | **0** |

另附在跑/产品默认非 LoRA **10** 条 → 合计表内 **P-A=104**（见 CSV `cluster=non_lora_running`）。

解读：

- **能确定（P-A）≈ 23% LoRA**：策划 21 + 官方技术卡页命中文件（多文件映射同一官方包，如 Hyper/Lightning/LTX Camera/IC）。
- **能归类（P-B）≈ 64%**：有卡页标题/标签，作用类型清楚，但不是「产品已钉死默认」。
- **不能当真确定（P-C）≈ 13%**：弱 HF 页、无 URL、私货改名、仅文件名。
- **来源 B ≠ 用途 P-A**：来源能钉到两站，不等于用途已产品确认；本轮 **故意不把社区画风卡抬成 P-A**。

### 9.3 方法摘要

1. 缓存抓取：Civitai `GET /api/v1/models/{id}`（57）+ HF `GET /api/models/{repo}`（141）→ `docs/ops/_card_cache_20261025/`。  
2. 分类器：标题/tags/README 关键词 → 加速、运镜、编辑、角色、画风、NSFW、滑条。  
3. P-A 白名单：官方技术仓 + `lora_catalog` + 在跑服务；社区 Civitai **最高 P-B**。  
4. 无 URL 的簇模板 → **P-C**（不因簇名升 B）。  
5. 有卡页依据的 P-A/P-B 回写 `MODEL_SOURCES.notes`（`purpose_zh` / `purpose_evidence` / `purpose_method`）；备份 `.bak.purpose-20261025`。

### 9.4 一句话回答用户

**作用大部分能「归类清楚」，一小部分能「产品级确定」；不能假装 400 张 LoRA 每张都实测过。**  
有卡页的约 **87%（P-A+P-B）** 可写清用途类型；真正写死到策划/官方/在跑的约 **四分之一弱（P-A≈23%）**；其余靠文件名的不要进设置默认推荐。

### 9.5 产物

- 用途表：[`MODEL_PURPOSE_FROM_CARDS_20261025.csv`](MODEL_PURPOSE_FROM_CARDS_20261025.csv)（`basename, purpose_zh, purpose_evidence, source_url, …`）
- 统计：`docs/ops/_purpose_card_stats_20261025.json`
- 卡页缓存：`docs/ops/_card_cache_20261025/`
- 账本 notes：`docs/MODEL_SOURCES.json`（bak `.bak.purpose-20261025`）

### 9.6 产品建议（用途层）

| 展示 | 策略 |
|---|---|
| 设置默认/推荐 | 只推 **P-A**（策划卡 + 官方加速/控制 + 在跑） |
| 库存可选 | **P-A+P-B**，标签写用途类型 + 链到卡页 |
| P-C | 灰标「用途未核实」；高级自选 |
| 与来源交叉 | 来源 D / `civ+hf:no-hit` 即使有文件名猜测也不进推荐 |


## 10. 用途 P-C 隔离（2026-10-25，Asia/Shanghai）

用户确认：用途实在不能确定的移出可用库存。

| 项 | 值 |
|---|---|
| 依据 | `MODEL_PURPOSE_FROM_CARDS_20261025.csv` purpose_evidence=**P-C**（P-D=0） |
| basename | **53** |
| 磁盘实例 `mv` | **58**（toiv 23 + h3 8 + Windows 27） |
| 跳过 / 失败 | 0 / 0 |
| 方式 | 同卷隔离，**未 rm** |
| 隔离根 | `toiv/comfyui-models/_quarantine_purpose_unknown_20261025/`；`Windows/.../models/_quarantine_purpose_unknown_20261025/` |
| 保护 | P-A/P-B 未动；`lora_catalog` 21 ∩ P-C = ∅；无产品默认硬引用跳过 |
| 账本 | `MODEL_SOURCES` 对应行 `status=blocked` + notes（未删行） |

详情与回滚：[`PURPOSE_UNKNOWN_QUARANTINE_20261025.md`](PURPOSE_UNKNOWN_QUARANTINE_20261025.md)

可用 LoRA 口径：仅 **P-A + P-B**（及未标 quarantined 的行）。P-C 已从可用叙述剔除。
