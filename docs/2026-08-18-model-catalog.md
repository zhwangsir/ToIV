# ToIV 模型分类目录（2026-08-18）

> 全集群已部署模型的系统性分类：功能类型、适用场景、LoRA 关联与来源。
> 真理来源：`workflows/model_wiki.py`（curated 27 卡）× `ModelCard` 富化表 × 引擎注册表 × LoRA 注册表。
> 本文是长期维护目录：模型增删/迁移时必须同步（见文末「维护机制」）。

---

## 目录

1. [图片生成底模（15）](#一图片生成底模15)
2. [视频生成引擎与底模（8 家族）](#二视频生成引擎与底模)
3. [LoRA 关联目录](#三lora-关联目录)
4. [放大 / 3D / 音频模型](#四放大--3d--音频模型)
5. [LLM 四层（对话/优化链路）](#五llm-四层)
6. [选型速查](#六选型速查)
7. [维护机制](#七维护机制长期任务)

---

## 一、图片生成底模（15）

物理位置：workstation `/opt/ComfyUI/models`（symlink → NAS `NAS/Windows/ComfyUI/ComfyUIModel/models`），三 worker 共享。

### 1.1 SFW 主力

| 模型 | 基模 | 类目 | 功能类型 | 适用场景 | 风格预设 |
|---|---|---|---|---|---|
| FLUX.2 Dev（flux2_dev_fp8mixed） | FLUX.2 | diffusion_models | 照片级写实/全能 | 产品图、概念设计、电影感照片 | photo / product / cinematic / concept_art |
| Z-Image Turbo（z_image_turbo_bf16） | Z-Image 6B | diffusion_models | 8 步极速生成 | 草稿迭代、批量探索（Apache 2.0 可商用） | 平台默认底模 |
| Qwen-Image（qwen_image_fp8_e4m3fn） | Qwen-Image | diffusion_models | 中文文字渲染 | 海报、带字商单 | chinese_text / commercial_design |
| 麦橘写实 v7（majicMIX realistic） | SDXL | checkpoints | 亚洲人像专精 | 人像写真、人物特写 | 通用写实 |
| CyberRealistic v120 | SDXL | checkpoints | 欧美写实通才 | 场景人像、生活纪实 | portrait |
| Pony Diffusion V6 XL | Pony | checkpoints | 风格化/奇幻 | 插画、奇幻题材 | fantasy |

### 1.2 二次元 / 动漫

| 模型 | 基模 | 适用场景 | 备注 |
|---|---|---|---|
| WAI-ILLUSTRIOUS v170 | Illustrious-XL | 现代二次元标准 | anime 预设；打 NSFW 标但 sfw_intent |
| Hassaku XL v34 | Illustrious-XL | 柔和插画风 | anime_soft 预设 |
| NoobAI-XL v-pred 10 | Illustrious(v-pred) | 动漫高质量/NSFW 旗舰 | v-pred 自动插 ModelSamplingDiscrete（cfg 4.5 + zsnr）；anime_high_quality 预设 |
| Nova 3DCG XL ilV90 | SDXL | 3D CG/皮克斯感 | chibi 预设；打 NSFW 标 |

### 1.3 R18 专区（仅 R18 模式可见）

| 模型 | 基模 | 适用场景 |
|---|---|---|
| URPM v1.3 | SD 1.5 | R18 文生图/图生图**默认底模**（nsfw-txt2img/nsfw-img2img 引擎） |
| Lustify Apex v8 | SDXL | 写实 NSFW（nsfw_realistic 预设） |
| CyberRealistic Pony v180 | Pony V6 XL | 写实×Pony 混血 |
| Pony Realism | Pony V6 XL | Pony 生态写实向 |
| WAI ShuffleNoob vPred04 | Illustrious(v-pred) | 二次元混血 |
| AutismMix Pony | Pony | nsfw_anime 预设 |

> 图像引擎 LoRA 走提示词标签 `<lora:名称:权重>`；底模/采样器/调度器由引擎参数运行时枚举注入。

## 二、视频生成引擎与底模

### 2.1 引擎 → 底模映射（21 引擎）

| 引擎 id | 显示名 | 底模 | 实例 | 特色 | 输出分辨率档 |
|---|---|---|---|---|---|
| ltx25-t2v / ltx25-i2v | LTX 2.5 文生/图生视频 | LTX-2.5 22B Distilled | GPU3 :8198 | 音画同出（SFW 主力），8 步蒸馏 | 原生/720P/1080P/2K/4K |
| ltx-nsfw-t2v / i2v / lipsync | LTX 2.3(R18) 文生/图生/对口型 | LTX-Video 2.3 + 10Eros v14 | pool worker | R18 视频；lipsync 支持音频驱动 + ID LoRA | 同上 |
| h3-t2v / h3-i2v | MiniMax H3 文生/图生视频 | MiniMax H3 | GPU2 :8195 | 原生 32kHz 立体声音画同发；≤1344×768、≤15s/段（超时分段续写） | 同上 |
| h3-nsfw-t2v / i2v | H3(R18) | H3 + 社区 R18 LoRA | 同上 | R18 场景 | 同上 |
| wan-nsfw-i2v | Wan2.2 图生视频(R18) | Wan2.2 I2V-A14B fp8 双专家 | pool worker | Civitai 爆款配方；甜点 832×480 | 同上（720P 起经超分） |
| longcat-t2v / i2v / continue | LongCat 文生/图生/续写 | LongCat-Video 13.6B（NAS 83GB diffusers 布局） | GPU2 :8197 | 长镜头单段 961 帧（16fps≈60s） | 同上 |
| avatar-talk | LongCat-Avatar 数字人 | LongCat-Avatar v1.5 + whisper-large-v3 音频编码 | 同上 | 人像+音频→口型同步视频 | — |
| wan-animate | Wan2.2 动作迁移 | Wan2.2-Animate-14B | 同上 | 参考图+驱动视频→动作迁移 | — |
| wan-vace | VACE 多参考视频 | Wan2.1-VACE-14B | 同上 | 多参考图(1-4)生成 | — |
| txt2img / img2img / nsfw-* | 图像引擎 | 见第一节 | pool | — | — |
| ace-music | ACE 文生音乐 | ACE-Step v1.5 3.5B | pool | tags 风格 + 歌词，≤240s | — |

> **输出分辨率档（RES-2026-08-18）**：13 个视频引擎统一支持「原生直出 / 720P / 1080P / 2K / 4K」——超出引擎原生上限的档位由 M6 超分集群（:8261-8263，4x-UltraSharp 帧级放大）在生成完成后自动二次超分完成；横竖方向自动随源画幅。

### 2.2 视频链路配套组件

| 组件 | 文件 | 用途 |
|---|---|---|
| text encoder | umt5_xxl_fp8_e4m3fn_scaled | Wan 链路文本编码 |
| VAE | wan_2.1_vae | Wan 链路 |
| 加速 LoRA | lightx2v 4step（i2v v1 / t2v v1.1 / NSFW v1030 rank64） | 4-8 步蒸馏加速 |
| LTX 音频 VAE | ltx-2.3-22b-distilled-1.1 内嵌 102 个 audio_vae 键 | LTX 对口型（checkpoints 类目副本必需，易错点 21） |
| 人声分离 | MelBand RoFormer（独立仓 ComfyUI-MelBandRoFormer） | LongCat-Avatar 音频预处理 |

## 三、LoRA 关联目录

### 3.1 Wan2.2 NSFW LoRA（WAN_I2V_NSFW_LORAS，6 个）

> HIGH 侧管构图/动作轨迹，LOW 侧管细节/质感——**挂错侧=无效/崩坏**；最多 4 个；强度甜点 0.6-0.8；触发词须写进提示词句首（确定性注入，不交 LLM）。

| LoRA | 侧别 | 默认强度 | 触发词 | 模式 | 角色 |
|---|---|---|---|---|---|
| NSFW-22-H-e8 | high | 0.8 | `nsfwsks` | all | 通用 NSFW 概念解锁 |
| wan22-m4crom4sti4-i2v-20epoc-high-k3nk | high | 0.7 | `m4crom4sti4` | all | 胸部物理 |
| WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1 | high | 0.7 | b0dyshot / pull0ut / sp0ntaneous / s3lf / p4rtner | pick_one | POV 体精/拔出 |
| Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16 | high | 0.8 | （无） | all | 加速（替代默认加速 LoRA，不叠加） |
| DR34ML4Y_I2V_14B_LOW_V2 | low | 0.8 | m15510n4ry / bl0wj0b / d0gg1e / c0wg1rl / d0ubl3_bj | pick_one | 体位五件套 |
| 56Low-noise-Cumshot-Aesthetics | low | 0.6 | （无） | all | 动漫体液美学 |

### 3.2 MiniMax H3 NSFW LoRA（services/h3.py 注册 9 个）

> 安装落 NAS `toiv/comfyui-models/h3/loras`；引擎参数最多 3 个、强度 0.5-1.0（默认 0.6）；options 运行时从 H3 实例枚举注入，已知 R18 名打 nsfw 标。

riding_pose_H3_i2v_v1.0（civitai 2446218）· H3_footjob_v0_step1000_fixed（2839680）· h3_musubi_v4-000040（2841940）· deepthroat_v1（2476698）· minimax_vag_000002500 v0.2（2835594）· SexGod-NaughtyTimes（2836176）· HMNSFW_AIO_V2（2834417，I2V/T2V 通用）· vagassist_e40 HMPussy v0.5（2846342）· stomach_bulge_H3_i2v_v1.0（1445226，I2V 专用）

推荐清单另含 4 个未入注册表（Cxy Kiss / AI Girl Series30 / Turbo 850 / lightx2v Turbo 4step）+ LongCat/H3 生态 13 项，见 `/models/nsfw-recommendations`。

### 3.3 LTX2.3 配套 LoRA

All in One 合集（2.3GB）· NSFW Motion 00750 · Sulphur Better NSFW Motion —— 均在 NAS `loras/ltx2.3/`；lipsync 的 `id_lora` 为文本参数（worker loras 目录任选文件名，强度默认 0.8）。

### 3.4 短剧场景 LoRA（42 个，SDXL 基座）

五个类别级前缀：`ancient*`（古风）/ `campus*`（校园）/ `urban*`（都市夜景）/ `luxe*`（商企奢华）/ `horror*`（惊悚悬疑）；单个文件触发词经 civitai 富化补全（ModelsView → admin「富化介绍」）。

### 3.5 图像 NSFW LoRA 推荐

Nudify XL: Better Bodies（435MB）· ExpressiveH Hentai（218MB）——`/models/nsfw-recommendations` 可一键安装。

## 四、放大 / 3D / 音频模型

| 模型 | 类目 | 用途 |
|---|---|---|
| 4x-UltraSharp.pth | upscale_models | 图像 use_upscale + **M6 视频超分 fleet 默认模型**（GPU1/2/3 实例 :8261-8263，仅此用途，--cache-lru 2） |
| hunyuan3d-dit-v2-0-fp16 | diffusion_models（硬编码只读） | 3D 模式（ImageOnlyCheckpointLoader） |
| ace_step_v1_3.5b | 硬编码只读 | ACE 文生音乐 |
| mmaudio | checkpoints（从图像下拉剔除） | LTX 音频链路 hint |

## 五、LLM 四层

| 层 | 端点 | 用途 |
|---|---|---|
| L1 | spark02 :8000（Qwen3.8-27B-NVFP4，别名 qwen3.6-uncensored） | 快速对话 |
| L2 | 同上 | 中文作答（模型百科 RAG） |
| L3 | 同上 | 剧本/分镜精修、提示词优化、Shot 扩写 |
| L4 | 同上 | 长文本/评测 |

> 反推 VLM：studio04 Qwen2.5-VL-72B-4bit（:9303，`/api/reverse`）；scoring/宫格反推走 spark01 Molmo2-8B（:8000）。ASR workstation :9210、Embedding :9302、人声分离 :9220（详见 AGENTS.md 服务表）。

## 六、选型速查

| 需求 | 首选 | 理由 |
|---|---|---|
| 写实照片/产品 | FLUX.2 Dev | 照片级全能 |
| 快速草稿 | Z-Image Turbo | 8 步出图 |
| 中文海报/带字 | Qwen-Image | 文字渲染 |
| 亚洲人像 | 麦橘写实 v7 | 专精 |
| 二次元标准 | WAI-ILLUSTRIOUS v170 | 现代风 |
| SFW 视频+音 | LTX 2.5 | 音画同出、8 步快 |
| 长镜头(≤60s) | LongCat | 961 帧单段 |
| 高质感音画 | MiniMax H3 | 32kHz 立体声 |
| R18 视频 | Wan2.2 配方 / LTX2.3+10Eros / H3+LoRA | 三线任选 |
| 口型同步(数字人) | avatar-talk / ltx-nsfw-lipsync | SFW/R18 各一 |
| 4K 输出 | 任意视频引擎选 4K 档 | 自动二次超分 |

## 七、维护机制（长期任务）

**本目录的四个事实源**（改动任一处须回写本文）：

| 事实源 | 路径 | 覆盖 |
|---|---|---|
| curated 卡片 | `apps/api/app/workflows/model_wiki.py`（27 张） | 底模/视频/LoRA 类别/放大的人话卡片 |
| 引擎注册表 | `apps/api/app/services/engine_registry.py`（21 条） | 引擎→底模映射、参数 schema |
| LoRA 注册表 | `workflows/wan_i2v.py`（WAN 6）/ `services/h3.py`（H3 9） | 触发词/侧别/强度/mode |
| 推荐清单 | `routes/models.py` NSFW_RECOMMENDATIONS（31 项） | 可一键安装项 |

**更新触发点**：
1. 新装/退役模型 → 更新 model_wiki.py curated 卡片 + 本目录对应表 + civitai 富化（admin「富化介绍」）
2. 新引擎/引擎换底模 → engine_registry + 本目录 2.1 表
3. LoRA 增删 → 对应注册表 + 本目录第三节
4. 输出分辨率/超分链路变化 → 本目录 2.1 注记

**定期复核**（建议每月）：
- `GET /models/local` 真机清单 vs 本目录 diff
- curated 卡片缺口（已知：42 场景 LoRA 仅 5 类别卡、VAE/controlnet 零卡片、10Eros 无独立前缀卡）
- 文档滞后项（已知：engine_registry docstring 写 20 实为 21；wan_t2v 默认复用 i2v UNET 待换 t2v 权重）

**已知缺口**（待补，按需排期）：分类数据分散 7 处尚无统一 tag 体系；建议后续以 model_wiki.py 的 tags 字段为单一分类轴收敛。
