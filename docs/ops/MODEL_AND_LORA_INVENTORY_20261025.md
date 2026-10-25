# MODEL + LoRA 库存清单（真机扫描）

> **2026-10-25 隔离更新（Asia/Shanghai）**：用途 **P-C** 共 53 basename / 58 文件实例已 `mv` 至 `_quarantine_purpose_unknown_20261025/`（未 rm）。可用库存约：主库 loras **239**、H3 **30**、Windows **102**。详见 [`PURPOSE_UNKNOWN_QUARANTINE_20261025.md`](PURPOSE_UNKNOWN_QUARANTINE_20261025.md)。下文 §5 全表仍为隔离前快照，勿当现网可用数。

> **生成时间**：2026-10-25 09:16 Asia/Shanghai  
> **方法**：MateBook SSH → `workstation-lan` / `sk01-l` / `sk02-l` / `openclaw01-lan` / `core`；NAS 经 WS CIFS `/home/merlin/nas_mount`。  
> **范围**：只读；未改服务、未 commit、未部署。  
> **权威顺序**：真机 > 本文件 > `MODEL_SOURCES` / `CLUSTER_TRUTH`（账本冲突以真机为准）。
> **来源/用途调研（续）**：[`MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md`](MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md) · LoRA 全表 CSV [`MODEL_SOURCE_PURPOSE_LORA_20261025.csv`](MODEL_SOURCE_PURPOSE_LORA_20261025.csv)

## 0. 数量摘要

| 类型 | 数量 | 主位置 | 备注 |
|---|---:|---|---|
| LLM 权重目录（双 Spark） | 7+ 有效 | `~/models` on .84/.82 | 在跑 Mia；dsv4 仅库存 |
| VLM / Embed / TTS / ASR 在跑 | 5 类服务 | WS + openclaw×4 | 见 §2 |
| NAS `toiv/comfyui-models` checkpoints | 38 | NAS toiv | 产品默认 Qwen-Rapid-AIO-SFW-v23 |
| NAS diffusion_models | 177 | NAS toiv | ~2.5T |
| NAS **loras**（主库） | **264** | `toiv/comfyui-models/loras/` | 全量见 §5 |
| H3 专属 loras | 38 | `…/h3/loras/` | 另计 |
| Windows 树 loras（Comfy 主 symlink） | 129 | `Windows/ComfyUI/…/loras` | 与 toiv 库部分重叠 |
| LoRA 去重 basename（三源合计） | **404** | — | 三源并集 |
| H3 权重文件（diffusion/vae/te/lora…） | 63 | `…/h3/` | 含 lora 38 |
| NAS LLM 目录文件 | 69 | `…/LLM/` | 辅助/TE 等 |
| unet / vae / text_encoders / clip_vision / controlnet / upscale | 7 / 29 / 30 / 8 / 13 / 15 | NAS toiv | |
| Windows checkpoints / diffusion | 32 / 52 | Windows 树 | Comfy 主库 |

**LoRA 一句话**：主库 `toiv/…/loras` **264** 个文件；H3 专属 **38**；旧 Windows Comfy 树 **129**；去重 basename 约 **404**。全表在本文 §5，聊天勿贴全量。

---

## 1. 总表（在跑 / 仅库存）

| 类型 | 名称 | 位置 | 状态 | 备注 |
|---|---|---|---|---|
| LLM | `DeepSeek-V4.1-Flash-1017`（Mia EAQ2.9+Keys ablit+Engram） | spark02 `.84:8888`；权重 `~/models/mia-eaq-29-ablit` ~197G；Engram cache HF | **在跑**（容器 `dsv41-1017-exl3-tf` TP2） | 生产 ToIV 已切此入口（proxy 别名） |
| LLM | `dsv4-flash-dspark-abliterated` / served 曾用 `deepseek-v4-flash-dspark` | 双 Spark `~/models/dsv4-flash-dspark-abliterated` ~156G | **仅库存** | 同卡互斥；`dsv4_60` 容器本轮 docker ps 未见（权重仍在） |
| LLM | `glm53-exl3` | 双 Spark `~/models/glm53-exl3` ~172G | 仅库存 | |
| LLM | `glm53-dflash2-mxfp8` | ~1.2G | 仅库存 | |
| LLM | `qwen3.6-35b-a3b-awq` | ~24G | 仅库存 | |
| LLM | spark02 `qwen3-vl-8b` | ~17G | 仅库存 | 非生产 VLM |
| LLM | spark01 `Qwen3-Embedding-4B` | ~7.6G | 仅库存（本机） | 生产 Embed 在 WS |
| LLM | 断链 symlink `euryale-70b` / `rocinante-12b` / `skyfall-31b` | → `../spark-models/…` | **断链/0 字节** | 目标未挂或不在 |
| LLM 旧容器 | `qwen38sg` / `qwen38vl` / `vllm_node*` | spark docker | Exited 数周 | 勿当活服务 |
| VLM | `toiv-vlm` ← `Qwen3-VL-8B-Instruct` | WS `:9311`；`/home/merlin/models/Qwen3-VL-8B-Instruct` ~17G | **在跑** | |
| Embed | `qwen3-embedding-4b` ← `Qwen3-Embedding-4B` | WS `:9302`；同路径 ~7.6G | **在跑** | |
| TTS | IndexTTS **2.5** | WS `:9200`；`~/index-tts/checkpoints/gpt.pth` 3.1G | **在跑** | |
| Audio sep | demucs-htdemucs | WS `:9220` | **在跑** | |
| 出图 Comfy | LB `:8188` → `:8196/:8263/:8265` | WS | **在跑** | 模型按作业从 NAS/Windows 树加载 |
| 出图默认 | `Qwen-Rapid-AIO-SFW-v23.safetensors` | gate `model-config.template.json`；NAS checkpoints | **产品默认** | |
| 视频 LongCat/Wan | `:8197` | WS | **在跑** | 权重按作业；盘上有 LongCat-Video 等 |
| 视频 Animate2 | `:8199` | WS | **在跑** | |
| 视频 H3 | `:8264` | WS | **在跑** | 默认 fl2va/ref2va pruned_int8_convrot |
| 超分 | `:8262/:8263` | WS | **在跑** | |
| ASR | `mlx-community/whisper-large-v3-mlx` | openclaw×4 `:9310` | **在跑** | 01 源码核实；02–04 同构推断 |
| Caption | `n-Arno/joycaption-mlx-mxfp4` | openclaw×4 `:9305` | **在跑** | health 确认 |
| WS 本地库存（未作默认服务） | CosyVoice2/3、Qwen3-TTS、Qwen3-VL-32B-FP8、LongCat-Video-ms、ltx25、musetalk、SoulX、FireRedASR、SenseVoice、joycaption-beta-one、qwen38-flash-next-nvfp4 等 | `/home/merlin/models` | 仅库存 | 部分对应已 DOWN 端口 |

### 1.1 H3 生产默认权重（gate）

- fl2va: `minimax_h3_fl2va_pruned_int8_convrot.safetensors`
- ref2va: `minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- 路径前缀：`h3/diffusion_models/`（NAS）

### 1.2 Engines API

`GET /api/models/engines`（需登录）返回 **24** 个引擎能力描述（txt2img / h3-* / longcat-* / wan-* …），**不枚举磁盘权重文件名**；权重以下方 NAS/Windows 扫描为准。

---

## 2. 双 Spark LLM 磁盘明细

| 主机 | 目录 | 大小 | 状态 |
|---|---|---:|---|
| spark02+01 | `mia-eaq-29-ablit` | 197G | 在跑挂载（TensorFold） |
| spark02+01 | `dsv4-flash-dspark-abliterated` | 156G | 仅库存 |
| spark02+01 | `glm53-exl3` | 172G | 仅库存 |
| spark02+01 | `glm53-dflash2-mxfp8` | 1.2G | 仅库存 |
| spark02+01 | `qwen3.6-35b-a3b-awq` | 24G | 仅库存 |
| spark02 | `qwen3-vl-8b` | 17G | 仅库存 |
| spark01 | `Qwen3-Embedding-4B` | 7.6G | 仅库存 |
| spark02 HF hub cache | `models--deepseek-ai--DeepSeek-V4.1-Flash-1017` 等 | 元数据级 ~7.4M listed | 辅助 |
| 双机 | `euryale-70b` / `rocinante-12b` / `skyfall-31b` symlink | 0 | **断链** |

API：`http://192.168.71.84:8888/v1` → model `DeepSeek-V4.1-Flash-1017`。旧 `:8000` 本轮无监听。

---

## 3. Workstation 本地 `/home/merlin/models`（在跑标粗）

| 目录 | 大小 | 备注 |
|---|---:|---|
| **Qwen3-VL-8B-Instruct** | 17G | **VLM :9311** |
| **Qwen3-Embedding-4B** | 7.6G | **Embed :9302** |
| qwen38-flash-next-nvfp4 | 126G | 库存 |
| LongCat-Video-ms | 78G | 库存/视频相关 |
| liveact | 53G | 库存 |
| SoulX-FlashTalk-14B | 51G | 库存 |
| ltx25 | 36G | 库存 |
| Qwen3-VL-32B-Instruct-FP8 | 34G | 库存 |
| joycaption-beta-one | 16G | 库存（生产 JoyCaption 在 openclaw） |
| Qwen2.5-VL-7B-Instruct | 16G | 库存 |
| Fun-CosyVoice3-0.5B / CosyVoice2-0.5B / Qwen3-TTS-1.7B-Base | 9.1/4.6/4.3G | 库存（旧 TTS 口 DOWN） |
| musetalk / FireRedASR / SenseVoice / nomic-embed / quicktalk 等 | 较小 | 库存 |
| IndexTTS checkpoints | gpt.pth 3.1G 等 | **TTS :9200** |

---

## 4. NAS `toiv/comfyui-models` 分类

挂载：WS `//192.168.71.7/NAS` → `/home/merlin/nas_mount`；主库 `toiv/comfyui-models`。  
Comfy 另有旧主库 symlink：`/opt/ComfyUI/models` → `Windows/ComfyUI/ComfyUIModel/models`；`extra_model_paths.yaml` 同时挂 toiv + h3_nas。

| 子目录 | 权重文件数 | 体积约 |
|---|---:|---:|
| checkpoints | 38 | 676G |
| diffusion_models | 177 | 2.5T |
| loras | 264 | 240G |
| h3/（含子目录） | 63 | 521G |
| LLM | 69 | 355G |
| text_encoders | 30 | 265G |
| unet | 7 | 90G |
| vae | 29 | 16G |
| clip_vision | 8 | 18G |
| controlnet | 13 | 25G |
| upscale_models | 15 | 1.2G |
| wan2.2-animate-2-14b / SEEDVR2 / LongCat-Video / unet_gguf / scope | 9 / 13 / 14 / 4 / 14 | 157G / 86G / 78G / 62G / 67G |

### 4.1 checkpoints 全表（NAS toiv）

| 文件 | 大小 |
|---|---:|
| `depth_anything_v2_vitl.pth` | 1.2G |
| `DreamShaper_8_pruned.safetensors` | 2.0G |
| `FlashVSR-v1.1/diffusion_pytorch_model_streaming_dmd.safetensors` | 5.3G |
| `FlashVSR-v1.1/LQ_proj_in.ckpt` | 549.0M |
| `FlashVSR-v1.1/TCDecoder.ckpt` | 180.3M |
| `FlashVSR-v1.1/Wan2.1_VAE.pth` | 484.1M |
| `flux1-dev-fp8.safetensors` | 16.1G |
| `ltx-2.3-22b-dev-fp8mixed.safetensors` | 27.1G |
| `ltx-2.3-22b-dev-fp8.safetensors` | 27.1G |
| `ltx-2.3-22b-dev.safetensors` | 43.0G |
| `ltx-2.3-22b-distilled-1.1.safetensors` | 43.0G |
| `ltx-2.3-22b-distilled-fp8.safetensors` | 27.5G |
| `ltxv-2b-0.9.6-dev-04-25.safetensors` | 5.9G |
| `ltxv-2b-0.9.6-dev-04-25-v1.safetensors` | 5.9G |
| `majicmixRealistic_v7.safetensors` | 2.0G |
| `moodyRealMix_zitV5DPO.safetensors` | 11.5G |
| `new_Qwen-Rapid-AIO-NSFW-v19.safetensors` | 26.5G |
| `new_Qwen-Rapid-AIO-NSFW-v23.safetensors` | 26.5G |
| `Qwen-AIO-SFW-v18.safetensors` | 26.5G |
| `Qwen-Rapid-AIO-NSFW-v20.safetensors` | 26.5G |
| `Qwen-Rapid-AIO-NSFW-v7.safetensors` | 27.0G |
| `Qwen-Rapid-AIO-SFW-v11.safetensors` | 26.5G |
| `Qwen-Rapid-AIO-SFW-v23.safetensors` | 26.5G |
| `Qwen-Rapid-AIO-SFW-v5.safetensors` | 27.0G |
| `Qwen-Rapid-AIO-SFW-v7.safetensors` | 27.0G |
| `Qwen-Rapid-AIO-v4.safetensors` | 27.0G |
| `realvisxlV50_v50Bakedvae.safetensors` | 6.5G |
| `realvisxlV50_v50LightningBakedvae   .safetensors` | 6.5G |
| `sulphur_dev_fp8mixed.safetensors` | 27.2G |
| `SUPIR-v0F_fp16.safetensors` | 2.5G |
| `SUPIR-v0Q_fp16.safetensors` | 2.5G |
| `wan2114BFusionx_fusionxImage2video.safetensors` | 15.3G |
| `wan2.2-i2v-rapid-aio-nsfw-v7.safetensors` | 21.8G |
| `wan2.2-i2v-rapid-aio-v10-nsfw.safetensors` | 21.8G |
| `wan2.2-i2v-rapid-aio-v10.safetensors` | 21.8G |
| `wan2.2-rapid-mega-aio-v11.safetensors` | 22.7G |
| `wan2.2-rapid-mega-aio-v1.safetensors` | 22.7G |
| `z-image-turbo-bf16-aio.safetensors` | 19.1G |

### 4.2 Windows 树 checkpoints（Comfy 主 symlink，32）

| 文件 | 大小 |
|---|---:|
| `10eros_v14.safetensors` | 27.2G |
| `ace_step_1.5_turbo_aio.safetensors` | 9.3G |
| `ace_step_v1_3.5b.safetensors` | 7.2G |
| `animagineXL40.safetensors` | 6.5G |
| `autismmixSDXL_autismmixPony.safetensors` | 6.5G |
| `cyberrealisticPony_v180Coreshift.safetensors` | 6.5G |
| `cyberrealistic_v120.safetensors` | 6.5G |
| `FlashVSR-v1.1/diffusion_pytorch_model_streaming_dmd.safetensors` | 5.3G |
| `FlashVSR-v1.1/LQ_proj_in.ckpt` | 549.0M |
| `FlashVSR-v1.1/TCDecoder.ckpt` | 180.3M |
| `FlashVSR-v1.1/Wan2.1_VAE.pth` | 484.1M |
| `flux1-dev-fp8.safetensors` | 16.1G |
| `flux2_dev_fp8mixed.safetensors` | 33.0G |
| `hassakuXLIllustrious_v34.safetensors` | 6.5G |
| `hunyuan3d-dit-v2-0-fp16.safetensors` | 4.6G |
| `krea2TurboFP8_krea2TURBO.safetensors` | 12.0G |
| `ltx-2.3-22b-dev-fp8.safetensors` | 27.1G |
| `ltx-video-2b-v0.9.5.safetensors` | 5.9G |
| `lustifySDXLNSFW_apexV8.safetensors` | 6.5G |
| `majicMIX realistic 麦橘写实_v7.safetensors` | 2.0G |
| `mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors` | 1.9G |
| `noobaiXL_vpred10.safetensors` | 6.6G |
| `nova3DCGXL_ilV90.safetensors` | 6.5G |
| `novaAnimeXL_ilV190.safetensors` | 6.5G |
| `ponyDiffusionV6XL_v6.safetensors` | 6.5G |
| `ponyRealism_V22.safetensors` | 6.6G |
| `pornmaster_proSDXLV8.safetensors` | 6.6G |
| `prefectIllustriousXL_40.safetensors` | 6.5G |
| `uberRealisticPornMerge_urpmv13.safetensors` | 2.0G |
| `waiIllustriousSDXL_v170.safetensors` | 6.5G |
| `waiREALCN_v150.safetensors` | 6.5G |
| `waiSHUFFLENOOB_vPred04.safetensors` | 6.5G |

### 4.3 diffusion_models（NAS toiv，177）

<details><summary>展开全表</summary>

| 文件 | 大小 |
|---|---:|
| `Bernini_HIGH_fp8_e4m3fn_scaled.safetensors` | 14.5G |
| `Bernini_LOW_fp8_e4m3fn_scaled.safetensors` | 14.5G |
| `BEYOND REALITY SUPER Z IMAGE 3.0 淡妆浓抹 BF16.safetensors` | 11.5G |
| `DarkBeast-Klein9b-V2-BFS-BF16-ComfyUI.safetensors` | 16.9G |
| `darkBeastMar0326Latest_dbkleinv2BFS.safetensors` | 8.5G |
| `ernie-image-turbo.safetensors` | 15.0G |
| `F.1-Fill-fp16_Inpaint_Outpaint_1.0.safetensors` | 22.2G |
| `FireRed-Image-Edit-1.0_bf16.safetensors` | 38.1G |
| `FireRed-Image-Edit-1.0_fp8mixed_comfy.safetensors` | 19.9G |
| `FireRed-Image-Edit-1.1_bf16.safetensors` | 38.1G |
| `FireRed-Image-Edit-1.1_fp8mixed_comfy.safetensors` | 20.0G |
| `flux1-dev-fp8-Kijai.safetensors` | 11.1G |
| `flux1-dev-kontext_fp8_scaled.safetensors` | 11.1G |
| `flux1-dev.sft` | 22.2G |
| `flux1-fill-dev.safetensors` | 22.2G |
| `flux1-kontext-dev_fp8_scaled.safetensors` | 11.1G |
| `flux2_dev_fp8mixed.safetensors` | 33.0G |
| `flux-2-klein-9b-fp8.safetensors` | 8.8G |
| `flux-2-klein-9b.safetensors` | 16.9G |
| `Flux2-Klein-9B-True-bf16.safetensors` | 16.9G |
| `Flux2-Klein-9B-True-v2-bf16.safetensors` | 16.9G |
| `Flux2-Klein-9B-True-v2-mxfp8mixed.safetensors` | 9.0G |
| `flux-2-klein-base-4b.safetensors` | 7.2G |
| `fluxFillFP8_v10.safetensors` | 11.1G |
| `hunyuan_video_I2V_720_fixed_fp8_e4m3fn.safetensors` | 12.3G |
| `krea2_turbo_fp8.safetensors` | 12.2G |
| `krea2_turbo_fp8_scaled.safetensors` | 12.2G |
| `krea2/turbo.safetensors` | 24.5G |
| `LongCat-Avatar/LongCat-Avatar-15_comfy-Q8_0.gguf` | 17.8G |
| `LongCat/LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors` | 14.4G |
| `ltx-2.3-22b-dev-fp8.safetensors` | 9.8G |
| `ltx-2.3-22b-dev.safetensors` | 43.0G |
| `ltx-2.3-22b-dev_transformer_only_bf16.safetensors` | 39.1G |
| `ltx-2.3-22b-distilled-1.1.safetensors` | 43.0G |
| `ltx-2.3-22b-distilled-1.1_transformer_only_fp8_scaled.safetensors` | 23.5G |
| `ltx-2.3-22b-distilled-1.1_transformer_only_mxfp8_block32.safetensors` | 22.4G |
| `ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled.safetensors` | 21.9G |
| `ltx-2.3-22b-distilled_transformer_only_fp8_input_scaled_v3.safetensors` | 23.3G |
| `ltx-2.5-22b-distilled-transformer-nvfp4.safetensors` | 17.4G |
| `lynx_lite_resampler_fp32.safetensors` | 312.7M |
| `minimax_h3_hybrid_fl2va_ref2va_b25-49-int8.safetensors` | 19.5G |
| `Phantom-Wan-1_3B_fp32.safetensors` | 5.3G |
| `Phantom-Wan-14B_fp8_e4m3fn.safetensors` | 14.0G |
| `qwen_image_2512_bf16.safetensors` | 38.1G |
| `qwen_image_2512_fp8_e4m3fn.safetensors` | 19.0G |
| `Qwen-Image_2512.safetensors` | 19.0G |
| `qwen_image_bf16.safetensors` | 38.1G |
| `qwen_image_distill_full_fp8_e4m3fn.safetensors` | 19.0G |
| `qwen_image_edit_2509_bf16.safetensors` | 38.1G |
| `qwen_image_edit_2509_fp8_e4m3fn.safetensors` | 19.0G |
| `Qwen-Image-Edit-2509_fp8_e4m3fn.safetensors` | 19.0G |
| `qwen_image_edit_2511_bf16.safetensors` | 38.1G |
| `qwen_image_edit_2511_fp8mixed.safetensors` | 19.1G |
| `qwen_image_edit_bf16.safetensors` | 38.1G |
| `qwen_image_edit_fp8_e4m3fn.safetensors` | 19.0G |
| `qwen_image_fp8_e4m3fn.safetensors` | 19.0G |
| `qwen_image_layered_bf16.safetensors` | 38.1G |
| `qwen_image_layered_fp8mixed.safetensors` | 19.1G |
| `Qwen-Image/text_encoder/model-00001-of-00004.safetensors` | 4.6G |
| `Qwen-Image/text_encoder/model-00002-of-00004.safetensors` | 4.6G |
| `Qwen-Image/text_encoder/model-00003-of-00004.safetensors` | 4.6G |
| `Qwen-Image/text_encoder/model-00004-of-00004.safetensors` | 1.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00001-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00002-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00003-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00004-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00005-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00006-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00007-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00008-of-00009.safetensors` | 4.6G |
| `Qwen-Image/transformer/diffusion_pytorch_model-00009-of-00009.safetensors` | 1.1G |
| `Qwen-Image/vae/diffusion_pytorch_model.safetensors` | 242.0M |
| `smoothMixWan22I2V14B_i2vHigh.safetensors` | 19.8G |
| `smoothMixWan22I2V14B_i2vLow.safetensors` | 19.8G |
| `svdq-fp4_r128-qwen-image-edit-2509-lightningv2.0-8steps.safetensors` | 12.2G |
| `svdq-fp4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors` | 12.2G |
| `svdq-fp4_r128-qwen-image-lightningv1.1-8steps.safetensors` | 12.2G |
| `svdq-fp4_r32-qwen-image-edit-lightningv1.0-4steps.safetensors` | 11.1G |
| `svdq-fp4_r32-qwen-image-lightningv1.1-8steps.safetensors` | 11.1G |
| `svdq-int4-flux.1-dev/transformer_blocks.safetensors` | 6.2G |
| `svdq-int4-flux.1-dev/unquantized_layers.safetensors` | 122.3M |
| `svdq-int4-flux.1-fill-dev/transformer_blocks.safetensors` | 6.2G |
| `svdq-int4-flux.1-fill-dev/unquantized_layers.safetensors` | 124.2M |
| `svdq-int4_r128-qwen-image-edit-2509-lightning-4steps-251115.safetensors` | 11.8G |
| `svdq-int4_r128-qwen-image-edit-2509-lightningv2.0-8steps.safetensors` | 11.8G |
| `svdq-int4_r128-qwen-image-edit-lightningv1.0-4steps.safetensors` | 11.8G |
| `svdq-int4_r128-qwen-image-lightningv1.1-8steps.safetensors` | 11.8G |
| `svdq-int4_r32-qwen-image-lightningv1.1-8steps.safetensors` | 10.7G |
| `VACE-Wan2.1-1.3B-Preview.safetensors` | 6.7G |
| `VACE/Wan2_2_Fun_VACE_module_A14B_HIGH_bf16.safetensors` | 5.7G |
| `VACE/Wan2_2_Fun_VACE_module_A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | 2.8G |
| `VACE/Wan2_2_Fun_VACE_module_A14B_LOW_bf16.safetensors` | 5.7G |
| `VACE/Wan2_2_Fun_VACE_module_A14B_LOW_fp8_e4m3fn_scaled_KJ.safetensors` | 2.8G |
| `VACE/Wan2.2-VACE-Fun-A14B-high-alibaba-pai.safetensors` | 32.3G |
| `VACE/Wan2.2-VACE-Fun-A14B-low-alibaba-pai.safetensors` | 32.3G |
| `Wan14BT2VFusioniX_fp16_.safetensors` | 26.6G |
| `Wan2_1-14B-I2V_ChronoEdit_fp8_scaled_KJ.safetensors` | 16.0G |
| `Wan21-14B-SCAIL-preview_fp8_e4m3fn_scaled_KJ.safetensors` | 15.3G |
| `Wan2_1-AccVideo-T2V-14B_fp8_e4m3fn.safetensors` | 14.0G |
| `Wan2_1-I2V-14B-480P_fp8_e4m3fn.safetensors` | 15.8G |
| `Wan2_1-I2V-14B-720p_fp8_e4m3fn_scaled_KJ.safetensors` | 15.5G |
| `Wan2_1-InfiniteTalk-Single_fp8_e4m3fn_scaled_KJ.safetensors` | 2.5G |
| `Wan2_1-MoviiGen1_1_fp8_e4m3fn.safetensors` | 14.0G |
| `Wan21_SteadyDancer_fp8_e4m3fn_scaled_KJ.safetensors` | 15.3G |
| `Wan2_1-T2V-1-3B-EchoShot_fp16.safetensors` | 2.6G |
| `wan2.1_t2v_14B_bf16.safetensors` | 26.6G |
| `Wan2_1-T2V-14B_fp8_e4m3fn.safetensors` | 13.8G |
| `Wan2_1-T2V-14B_fp8_e4m3fn_scaled_KJ.safetensors` | 13.5G |
| `Wan2.1_T2V_14B_FusionX_VACE-FP8_e4m3fn.safetensors` | 16.2G |
| `Wan2.1_T2V_14B_FusionX_VACE-FP8.safetensors` | 19.0G |
| `Wan2_1-T2V-14B-Lynx_full_ip_layers_fp16.safetensors` | 3.9G |
| `Wan2_1-T2V-14B-Lynx_full_ref_layers_fp16.safetensors` | 3.9G |
| `Wan2_1-T2V-14B-Lynx_lite_ip_layers_fp16.safetensors` | 800.0M |
| `Wan2_1-VACE_1_3B_bf16.safetensors` | 4.0G |
| `wan2.1_vace_1.3B_fp16.safetensors` | 4.0G |
| `wan2.1_vace_14B_fp16.safetensors` | 32.3G |
| `Wan2_1-VACE_module_1_3B_bf16.safetensors` | 1.4G |
| `Wan2_1-VACE_module_14B_bf16.safetensors` | 5.7G |
| `Wan2_1-VACE_module_14B_fp8_e4m3fn.safetensors` | 2.8G |
| `Wan2_1-Wan-I2V-MAGREF-14B_fp8_e4m3fn.safetensors` | 16.0G |
| `Wan2_2-5B-Ovi_960x960_10s_fp8_e4m3fn_scaled_KJ.safetensors` | 11.5G |
| `wan2.2_animate_14B_bf16.safetensors` | 32.2G |
| `wan2.2-animate-14b/diffusion_pytorch_model-00001-of-00004.safetensors` | 9.2G |
| `wan2.2-animate-14b/diffusion_pytorch_model-00002-of-00004.safetensors` | 9.3G |
| `wan2.2-animate-14b/diffusion_pytorch_model-00003-of-00004.safetensors` | 9.3G |
| `wan2.2-animate-14b/diffusion_pytorch_model-00004-of-00004.safetensors` | 4.4G |
| `Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors` | 17.1G |
| `Wan2_2-Animate-14B_fp8_scaled_e5m2_KJ_v2.safetensors` | 16.1G |
| `wan2.2-animate-14b/models_clip_open-clip-xlm-roberta-large-vit-huge-14.pth` | 4.4G |
| `wan2.2-animate-14b/models_t5_umt5-xxl-enc-bf16.pth` | 10.6G |
| `Wan2.2-Animate-14B-Q4_K_S.gguf` | 9.9G |
| `wan2.2-animate-14b/relighting_lora/adapter_model.safetensors` | 2.7G |
| `wan2.2-animate-14b/relighting_lora.ckpt` | 2.7G |
| `wan2.2-animate-14b/Wan2.1_VAE.pth` | 484.1M |
| `Wan22Animate/Wan2_2-Animate-14B_fp8_e4m3fn_scaled_KJ.safetensors` | 17.1G |
| `wan2.2_fun_vace_low_noise_14B_fp8_scaled.safetensors` | 16.2G |
| `Wan2_2_Fun_VACE_module_A14B_HIGH_bf16.safetensors` | 5.7G |
| `Wan2_2_Fun_VACE_module_A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | 2.8G |
| `Wan2_2_Fun_VACE_module_A14B_LOW_bf16.safetensors` | 5.7G |
| `Wan2_2_Fun_VACE_module_A14B_LOW_fp8_e4m3fn_scaled_KJ.safetensors` | 2.8G |
| `Wan2_2-I2V-A14B-HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | 14.0G |
| `wan2.2_i2v_A14b_high_noise_scaled_fp8_e4m3_lightx2v_4step_comfyui.safetensors` | 14.0G |
| `Wan2_2-I2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors` | 14.0G |
| `wan2.2_i2v_A14b_low_noise_scaled_fp8_e4m3_lightx2v_4step_comfyui.safetensors` | 14.0G |
| `wan2.2_i2v_high_noise_14B_fp16.safetensors` | 26.6G |
| `wan2.2_i2v_low_noise_14B_fp16.safetensors` | 26.6G |
| `Wan2.2_Remix_NSFW_i2v_14b_high_lighting_fp8_e4m3fn_v2.1.safetensors` | 13.3G |
| `Wan2.2_Remix_NSFW_i2v_14b_high_lighting_v2.0.safetensors` | 13.3G |
| `Wan2.2_Remix_NSFW_i2v_14b_low_lighting_fp8_e4m3fn_v2.1.safetensors` | 13.3G |
| `Wan2.2_Remix_NSFW_i2v_14b_low_lighting_v2.0.safetensors` | 13.3G |
| `Wan2.2_Remix_t2v_14b_high_lighting_v0.9_dyno.safetensors` | 13.3G |
| `Wan2.2_Remix_t2v_14b_low_lighting_v0.9.safetensors` | 13.3G |
| `Wan2_2-T2V-A14B_HIGH_fp8_e4m3fn_scaled_KJ.safetensors` | 14.0G |
| `Wan2_2-T2V-A14B-LOW_fp8_e4m3fn_scaled_KJ.safetensors` | 14.0G |
| `wan2.2_t2v_high_noise_14B_fp16.safetensors` | 26.6G |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | 13.3G |
| `wan2.2_t2v_low_noise_14B_fp16.safetensors` | 26.6G |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | 13.3G |
| `Wan2.2-VACE-Fun-A14B-high-alibaba-pai.safetensors` | 32.3G |
| `Wan2.2-VACE-Fun-A14B-low-alibaba-pai.safetensors` | 32.3G |
| `WAN22.XX_Palingenesis_low_t2v.safetensors` | 14.0G |
| `Wan-AI_Wan2.1-VACE-1.3B.safetensors` | 4.0G |
| `WanVideo_2_1_Multitalk_14B_fp8_e4m3fn.safetensors` | 2.5G |
| `z_image_base_bf16_official.safetensors` | 11.5G |
| `z_image_base-bf16.safetensors` | 11.5G |
| `Z-Image-base.safetensors` | 11.5G |
| `z_image_bf16.safetensors` | 11.5G |
| `z_image_bf16_ttcosta.safetensors` | 11.5G |
| `z_image_turbo_bf16_20260513.safetensors` | 11.5G |
| `z_image_turbo_bf16.safetensors` | 11.5G |
| `Z-Image-Turbo fp16.safetensors` | 11.5G |
| `Z-Image-Turbo_fp16.safetensors` | 11.5G |
| `z-image-turbo-fp8-e4m3fn.safetensors` | 5.7G |
| `z_image_turbo_fp8_e4m3fn_unscaled.safetensors` | 5.7G |
| `z-image-turbo_fp8_scaled_e4m3fn_KJ.safetensors` | 5.7G |
| `z-image-turbo_fp8_scaled_KJ.safetensors` | 5.7G |
| `z_image_turbo_nvfp4.safetensors` | 4.2G |

</details>

### 4.4 H3 目录要点

diffusion（节选生产相关）：

- `diffusion_models/10Eros_Max_h3_fl2va_beta2_pruned_int8_convrot.safetensors` (18.8G)
- `diffusion_models/10Eros_Max_h3_ref2va_beta2_pruned_int8_convrot.safetensors` (19.5G)
- `diffusion_models/10Eros_Max_h3_TURBO-hybrid_beta3_int8_convrot.safetensors` (19.5G)
- `diffusion_models/10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors` (19.5G)
- `diffusion_models/minimax_h3_fl2va_bf16.safetensors` (61.7G)
- `diffusion_models/minimax_h3_fl2va_fp8_e4m3fn.safetensors` (43.8G)
- `diffusion_models/minimax_h3_fl2va_pruned_fp8_scaled.safetensors` (19.5G)
- `diffusion_models/minimax_h3_fl2va_pruned_int8_convrot.safetensors` (19.5G)
- `diffusion_models/minimax_h3_ref2va_bf16.safetensors` (61.7G)
- `diffusion_models/minimax_h3_ref2va_int8_convrot.safetensors` (31.7G)
- `diffusion_models/minimax_h3_ref2va_pruned_bf16.safetensors` (37.5G)
- `diffusion_models/minimax_h3_ref2va_pruned_fp8_scaled.safetensors` (19.5G)
- `diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors` (19.5G)

H3 LoRA 全表见 §5.2（38）。

---

## 5. LoRA 专章（全量）

### 5.0 三源关系

| 源 | 路径 | 文件数 | basename 数 |
|---|---|---:|---:|
| A 主库 toiv | `/home/merlin/nas_mount/toiv/comfyui-models/loras` | 264 | 262 |
| B H3 专属 | `…/h3/loras` | 38 | 38 |
| C Windows 旧树 | `…/Windows/ComfyUI/ComfyUIModel/models/loras` | 129 | 129 |
| A∩C | — | — | 18 |
| 仅 A | — | — | 244 |
| 仅 C | — | — | 111 |
| 并集 A∪B∪C | — | — | **404** |

子目录分组（主库 A）：

| 子目录 | 数量 |
|---|---:|
| `(root)` | 212 |
| `ltx2.3` | 9 |
| `camera_movement` | 5 |
| `special_effects` | 5 |
| `ancient_chinese` | 4 |
| `campus` | 4 |
| `comedy_romantic` | 4 |
| `director_style` | 4 |
| `history_war` | 4 |
| `horror_thriller` | 4 |
| `luxury_business` | 4 |
| `modern_urban` | 4 |
| `klein` | 1 |

### 5.1 主库 `toiv/comfyui-models/loras/` 全量（264）

| 相对路径 | 大小 |
|---|---:|
| `2511-AnyPose-base-000006250.safetensors` | 281.5M |
| `2511-AnyPose-helper-00006000.safetensors` | 281.5M |
| `30-360-high.safetensors` | 292.6M |
| `ancient_chinese/hanfu_chinese_girl_flux.safetensors` | 584.4M |
| `ancient_chinese/hanfu_flux_v2.safetensors` | 18.9M |
| `ancient_chinese/krea_crimson_dark_victorian.safetensors` | 223.8M |
| `ancient_chinese/krea_foggy_gothic_fairytale.safetensors` | 223.8M |
| `AnythingtoRealCharacters2511_20.safetensors` | 337.7M |
| `bfs_head_v1_flux-klein_9b_step3500_rank128.safetensors` | 632.0M |
| `bounce_test_HighNoise-000005.safetensors` | 292.6M |
| `camera_movement/hyper_sdxl_1step_lora.safetensors` | 750.9M |
| `camera_movement/ntc_cinematic_lighting.safetensors` | 8.4M |
| `camera_movement/ostris_face_helper_sdxl.safetensors` | 213.4M |
| `camera_movement/wan22_orbit_high_noise.safetensors` | 146.3M |
| `camera_movement/wan22_orbit_low_noise.safetensors` | 146.3M |
| `campus/linaqruf_anime_detailer.safetensors` | 41.2M |
| `campus/linaqruf_pastel_anime.safetensors` | 188.0M |
| `campus/linaqruf_sketch_style.safetensors` | 45.0M |
| `campus/linaqruf_style_enhancer.safetensors` | 44.9M |
| `chronoedit_distill_lora.safetensors` | 358.5M |
| `comedy_romantic/eternal_oath_wedding_flux.safetensors` | 146.2M |
| `comedy_romantic/flux_romanticism.safetensors` | 327.9M |
| `comedy_romantic/krea_foggy_gothic_fairytale_rom.safetensors` | 223.8M |
| `comedy_romantic/wedding_photo_slider.safetensors` | 8.4M |
| `comfyui_subject_lora16.safetensors` | 146.2M |
| `Consistance_Lora_QwenEdit_2511.safetensors` | 585.2M |
| `consistence_edit_v1.safetensors` | 292.7M |
| `consistence_edit_v2.safetensors` | 585.2M |
| `DarkKlein9b_v2BFS_extracted_lora_r256.safetensors` | 1.2G |
| `DetailedEyes_V3.safetensors` | 88.8M |
| `director_style/krea2_turbo_training_adapter.safetensors` | 218.0M |
| `director_style/ltx_cinematic_sci_fi_dir.safetensors` | 336.3M |
| `director_style/ltx_post_apocalyptic_dir.safetensors` | 336.3M |
| `director_style/zimage_turbo_training_adapter_v2.safetensors` | 324.4M |
| `DR34ML4Y_I2V_14B_HIGH_V2.safetensors` | 292.6M |
| `Dramatic Lighting Slider_.safetensors` | 7.7M |
| `edit_0928_lora_step40000.safetensors` | 450.2M |
| `Edit-Multiple-angles.safetensors` | 281.5M |
| `extract-outfit_v3.safetensors` | 281.5M |
| `f2k_9B_lcs_consist_20260415.safetensors` | 332.0M |
| `f2k_consis.safetensors` | 272.0M |
| `FastWan_T2V_14B_480p_lora_rank_128_bf16.safetensors` | 1.2G |
| `FastWan_T2V_14B_480p_lora_rank_64_bf16.safetensors` | 601.5M |
| `FLUX.1-Turbo-Alpha-8-step .safetensors` | 661.9M |
| `Flux2-Klein-9B-一致性V2.safetensors` | 316.0M |
| `Flux2 Klein动漫转写实真人 AnythingtoRealCharacters.safetensors` | 158.0M |
| `FullDynamic_Ultimate_Fusion_Elite.safetensors` | 942.0M |
| `gemma-3-12b-it-abliterated_lora_rank64_bf16.safetensors` | 599.1M |
| `history_war/krea_crimson_dark_victorian_war.safetensors` | 223.8M |
| `history_war/medieval_knight_sdxl.safetensors` | 107.6M |
| `history_war/military_artillery_k9_flux.safetensors` | 164.0M |
| `history_war/samurai_jack.safetensors` | 562.7M |
| `horror_thriller/1980s_horror_krea2.safetensors` | 438.5M |
| `horror_thriller/ghost_glitter_v1_flux.safetensors` | 37.9M |
| `horror_thriller/ghost_glitter_v1_illustrious.safetensors` | 23.8M |
| `horror_thriller/vampire_slider.safetensors` | 8.4M |
| `hunyuan_video_accvid_5_steps_lora_rank16_fp8_e4m3fn.safetensors` | 166.0M |
| `Hyper-FLUX.1-dev-16steps-lora.safetensors` | 1.3G |
| `hyvideo_FastVideo_LoRA-fp8.safetensors` | 166.0M |
| `i2l_smoke_20260827.safetensors` | 19.0M |
| `ICEdit-MoE-LoRA-1.safetensors` | 409.2M |
| `ICEdit-MoE-LoRA.safetensors` | 409.2M |
| `IcEdit-normal-lora.safetensors` | 221.2M |
| `ip-adapter-faceid-plusv2_sd15_lora.safetensors` | 48.7M |
| `ip-adapter-faceid-plusv2_sdxl_lora.safetensors` | 354.6M |
| `klein_9B_Turbo_r128.safetensors` | 1.3G |
| `Klein 一致性增强.safetensors` | 316.0M |
| `klein/Flux2-Klein-9B-一致性V2.safetensors` | 316.0M |
| `Kook_Qwen_V3极致真实.safetensors` | 225.2M |
| `Kook_Zimage_如梦似幻.safetensors` | 151.5M |
| `Kook_Zimage_瑶光.safetensors` | 302.9M |
| `Kook_Zimage_真实幻想_Turbo.safetensors` | 162.2M |
| `lightx2v_14B_T2V_cfg_step_distill_lora_adaptive_rank_quantile_0.15_bf16.safetensors` | 2.4G |
| `lightx2v_elite_it2v_animate_face.safetensors` | 3.0G |
| `lightx2v_I2V_14B_480p_cfg_step_distill_rank128_bf16.safetensors` | 1.4G |
| `lightx2v_I2V_14B_480p_cfg_step_distill_rank256_bf16.safetensors` | 2.7G |
| `lightx2v_I2V_14B_480p_cfg_step_distill_rank64_bf16.safetensors` | 703.8M |
| `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank128_bf16.safetensors` | 1.2G |
| `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors` | 601.5M |
| `LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors` | 1.2G |
| `LongCat_distill_lora_alpha64_bf16.safetensors` | 1.2G |
| `LongCat_refinement_lora_rank128_bf16.safetensors` | 2.3G |
| `ltx-2-19b-ic-lora-detailer.safetensors` | 2.4G |
| `ltx-2-19b-lora-camera-control-dolly-in.safetensors` | 312.1M |
| `ltx-2-19b-lora-camera-control-dolly-out.safetensors` | 312.1M |
| `ltx-2-19b-lora-camera-control-dolly-right.safetensors` | 312.1M |
| `ltx-2-19b-lora-camera-control-jib-down.safetensors` | 2.1G |
| `ltx-2-19b-lora-camera-control-jib-up.safetensors` | 2.1G |
| `ltx-2-19b-lora-camera-control-static.safetensors` | 2.1G |
| `ltx-2.3-22b-distilled-1.1_lora-dynamic_fro09_avg_rank_111_bf16.safetensors` | 2.6G |
| `ltx-2.3-22b-distilled-lora-384-1.1-7.08G.safetensors` | 7.1G |
| `ltx-2.3-22b-distilled-lora-384_1.1.safetensors` | 7.1G |
| `ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | 7.1G |
| `ltx-2.3-22b-distilled-lora-384.safetensors` | 7.1G |
| `ltx-2.3-22b-distilled-lora-dynamic_fro09_avg_rank_105_bf16.safetensors` | 2.4G |
| `ltx-2.3-22b-distilled-lora-fro90_ceil72.safetensors` | 1.3G |
| `ltx2.3韩立触发词hanli.safetensors` | 96.1M |
| `LTX2.3人像美学-Aesthetic of Asian Portraits.safetensors` | 384.1M |
| `ltx2.3宋玉触发词songyu.safetensors` | 96.1M |
| `ltx2.3紫灵触发词ziling.safetensors` | 96.1M |
| `LTX2.3_Crisp_Enhance.safetensors` | 672.5M |
| `ltx2.3/distill_loras/ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors` | 631.4M |
| `LTX-2.3-Guofeng-V0.1.safetensors` | 408.3M |
| `LTX2.3-IC-LORA-Dual-Character.safetensors` | 312.1M |
| `LTX2.3-IC-LORA-Dual-Character-Shot.safetensors` | 312.1M |
| `ltx2.3-ic-subtitles-remove-general-lora.safetensors` | 312.1M |
| `ltx2.3-ic-watermark-remove-general-lora.safetensors` | 312.1M |
| `LTX-2.3-Licon-MSR-V1.safetensors` | 624.1M |
| `Ltx2.3-Licon-VBVR-I2V-240K-R32.safetensors` | 528.3M |
| `Ltx2.3-Licon-VBVR-I2V-390K-R32-LoRA.safetensors` | 528.3M |
| `Ltx2.3-Licon-VBVR-I2V-390K-R32.safetensors` | 528.3M |
| `Ltx2.3-Licon-VBVR-I2V-96000-R32.safetensors` | 528.3M |
| `Ltx2.3-Licon-VBVR-I2V-LoRA-96000-R32.safetensors` | 528.3M |
| `ltx2.3/ltx-2.3-22b-distilled-lora-384-1.1.safetensors` | 7.1G |
| `ltx2.3/LTX2.3-22B_IC-LoRA-Cameraman_v2_14000.safetensors` | 624.1M |
| `ltx2.3/ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors` | 2.3G |
| `ltx2.3/ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors` | 312.1M |
| `ltx2.3/ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors` | 624.1M |
| `ltx2.3/ltx-2.3-22b-lora-foley-v2a-1.0.safetensors` | 216.2M |
| `ltx2.3/LTX2.3-NSFWMOTION_00750.safetensors` | 1.0G |
| `LTX-2.3-OmniNFT-Lora.safetensors` | 1.1G |
| `LTX-2.3-OmniNFT-RL-Lora_bf16_KJ.safetensors` | 588.4M |
| `LTX-2.3-OmniNFT-RL-Lora_bf16.safetensors` | 588.4M |
| `ltx2.3/Sulphur_LTX2.3_better_NSFW_motion.safetensors` | 624.1M |
| `ltx2.3-transition.safetensors` | 372.2M |
| `ltx2.3-video-restoration-general-lora.safetensors` | 96.1M |
| `LTX-2-Image2Vid-Adapter.safetensors` | 4.6G |
| `luxury_business/hyper_flux_8step_lora.safetensors` | 1.3G |
| `luxury_business/hyper_sdxl_8step_lora.safetensors` | 750.9M |
| `luxury_business/lightning_sdxl_2step_lora.safetensors` | 375.6M |
| `luxury_business/lightning_sdxl_4step_lora.safetensors` | 375.6M |
| `MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors` | 1.6G |
| `MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors` | 1.6G |
| `modern_urban/city_streets_at_night_flux.safetensors` | 666.9M |
| `modern_urban/krea_neon_drip.safetensors` | 447.6M |
| `modern_urban/krea_rainy_window.safetensors` | 447.6M |
| `modern_urban/ltx_post_apocalyptic.safetensors` | 336.3M |
| `new_qwen-image-edit-2511-multiple-angles-lora.safetensors` | 281.5M |
| `next-scene_lora_v1-3000.safetensors` | 281.5M |
| `next-scene_lora-v2-3000.safetensors` | 281.5M |
| `qe2511_consis_alpha_patched.safetensors` | 585.2M |
| `QIE-2511-Extract-Outfit-4200.safetensors` | 225.2M |
| `qinglong_detailedeye_z-image.safetensors` | 363.9M |
| `Qwen 2511-Unblur-Anything.safetensors` | 225.2M |
| `Qwen-Edit-2509-Multiple-angles.safetensors` | 225.2M |
| `qwen_edit_2509_ObjectRemovalAlpha.safetensors` | 585.2M |
| `Qwen-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-edit-2511-multiple-angles.safetensors` | 281.5M |
| `qwen-edit-remover.safetensors` | 450.2M |
| `Qwen-Image-2512-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-2512-Lightning-4steps-V1.0-fp32.safetensors` | 1.6G |
| `Qwen-Image-2512-Lightning-8steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2509-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-fp32.safetensors` | 1.6G |
| `Qwen_Image_Edit_2511_Lightning_4步加速Lora_fp32.safetensors` | 1.6G |
| `Qwen-Image-Edit-2511-Lightning-4steps_bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-fp32.safetensors` | 1.6G |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1-fp32.safetensors` | 1.6G |
| `Qwen-Image-Edit-2511-Lightning-8steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2511-Lightning-8steps_V1.safetensors` | 810.2M |
| `qwen-image-edit-2511-multiple-angles-lora.safetensors` | 281.5M |
| `Qwen-Image-Edit-2512-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-image Edit Anything to Real Characters动漫转真人.safetensors` | 337.7M |
| `Qwen-Image-Edit-F2P.safetensors` | 450.2M |
| `Qwen-Image-Edit-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-Lightning-4steps-V1.0.safetensors` | 1.6G |
| `Qwen-Image-Edit-Lightning-8steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-Lightning-8steps-V1.0.safetensors` | 1.6G |
| `Qwen-Image-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Lightning-4steps-V1.0.safetensors` | 1.6G |
| `Qwen-Image-Lightning-4steps-V2.0.safetensors` | 1.6G |
| `Qwen-Image-Lightning-8steps-V1.0.safetensors` | 1.6G |
| `Qwen-Image-Lightning-8steps-V1.1-bf16.safetensors` | 810.2M |
| `Qwen-Image-Lightning-8steps-V1.1.safetensors` | 1.6G |
| `Qwen-Image-Lightning-8steps-V2.0 bf16.safetensors` | 810.2M |
| `Qwen-Image-Lightning-8steps-V2.0.safetensors` | 1.6G |
| `QwenRebalanceV10_v10LoraR64.safetensors` | 2.2G |
| `refcontrol_pose_V1.safetensors` | 327.9M |
| `SESELAORUYAO.safetensors` | 342.6M |
| `Singularity_LTX-2.3_OmniCine_Preview0.1.safetensors` | 2.5G |
| `Singularity LTX-2.3  OmniCine Preview v0.1.safetensors` | 2.5G |
| `Singularity-LTX-2.3_OmniCine_V1.safetensors` | 2.5G |
| `Skintastic_Flux_v1.safetensors` | 302.4M |
| `SmoothXXXAnimation_High.safetensors` | 292.6M |
| `SmoothXXXAnimation_Low.safetensors` | 292.6M |
| `special_effects/cyberpunk_edgerunners_ltx.safetensors` | 672.5M |
| `special_effects/hyper_sdxl_2step_lora.safetensors` | 750.9M |
| `special_effects/hyper_sdxl_4step_lora.safetensors` | 750.9M |
| `special_effects/krea_hazy_desert_dreamscape.safetensors` | 447.5M |
| `special_effects/ltx_cinematic_sci_fi_cyberpunk.safetensors` | 336.3M |
| `Stand-In_wan2.1_T2V_14B_ver1.0.ckpt` | 600.1M |
| `Stand-In_wan2.1_T2V_14B_ver1.0_fp16.safetensors` | 300.0M |
| `Stand-In_wan2.2_T2V_A14B_HIGH_fp16.safetensors` | 300.0M |
| `Stand-In_wan2.2_T2V_A14B_LOW_fp16.safetensors` | 300.0M |
| `sulphur_lora_rank_768.safetensors` | 9.6G |
| `SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_(128)_fp16.safetensors` | 1.1G |
| `SVI_v2_PRO_Wan2.2-I2V-A14B_HIGH_lora_rank_128_fp16.safetensors` | 1.1G |
| `SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_(128)_fp16.safetensors` | 1.1G |
| `SVI_v2_PRO_Wan2.2-I2V-A14B_LOW_lora_rank_128_fp16.safetensors` | 1.1G |
| `Wan21_AccVid_T2V_14B_lora_rank32_fp16.safetensors` | 302.1M |
| `Wan21_CausVid_14B_T2V_lora_rank32.safetensors` | 304.3M |
| `Wan21_CausVid_bidirect2_T2V_1_3B_lora_rank32.safetensors` | 87.0M |
| `Wan2.1-Fun-1.3B-InP-MPS_reward_lora_comfy.safetensors` | 386.5M |
| `Wan2.1-Fun-14B-InP-HPS2.1_reward_lora_comfy.safetensors` | 1.4G |
| `Wan2.1-Fun-14B-InP-MPS.safetensors` | 1.4G |
| `Wan2.1_I2V_14B_FusionX_LoRA.safetensors` | 353.9M |
| `Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64_official.safetensors` | 705.2M |
| `Wan21_I2V_14B_lightx2v_cfg_step_distill_lora_rank64.safetensors` | 705.2M |
| `Wan21_PusaV1_LoRA_14B_rank512_bf16.safetensors` | 4.6G |
| `Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors` | 87.0M |
| `Wan2_1_Skyreels-v2-I2V-720P_LoRA_rank_adaptive_quantile_0.20_fp16.safetensors` | 1.6G |
| `WAN2.1_SmartphoneSnapshotPhotoReality_v1_by-AI_Characters.safetensors` | 292.6M |
| `Wan_2_1_T2V_14B_720p_rCM_lora_average_rank_94_bf16.safetensors` | 853.5M |
| `Wan2.1_T2V_14B_CineScale_ntk20_lora_rank16_fp16.safetensors` | 146.3M |
| `Wan2.1_T2V_14B_FusionX_LoRA.safetensors` | 302.1M |
| `Wan21_T2V_14B_lightx2v_cfg_step_distill_lora_rank32.safetensors` | 302.1M |
| `wan2.2_animate_14B_relight_lora_bf16.safetensors` | 1.3G |
| `wan2.2_face_complete_distilled.safetensors` | 1.6G |
| `Wan2.2-Fun-A14B-InP-Fusion-Elite.safetensors` | 818.7M |
| `Wan2.2-Fun-A14B-InP-HIGH-MPS_resized_dynamic_avg_rank_21_bf16.safetensors` | 134.4M |
| `Wan2.2-Fun-A14B-InP-high-noise-HPS2.1.safetensors` | 818.7M |
| `Wan2.2-Fun-A14B-InP-high-noise-MPS.safetensors` | 818.7M |
| `Wan2.2-Fun-A14B-InP-LOW-HPS2.1_resized_dynamic_avg_rank_15_bf16.safetensors` | 97.0M |
| `Wan2.2-Fun-A14B-InP-LOW-MPS_resized_dynamic_avg_rank_22_bf16.safetensors` | 143.4M |
| `Wan2.2-Fun-A14B-InP-low-noise-HPS2.1.safetensors` | 818.7M |
| `Wan2.2-Fun-A14B-InP-low-noise-MPS.safetensors` | 818.7M |
| `Wan2.2-I2V-A14B-4steps-lora-rank64-Seko-V1-low_noise_model.safetensors` | 1.1G |
| `Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16(1).safetensors` | 601.5M |
| `wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors` | 605.2M |
| `Wan_2_2_I2V_A14B_LOW_lightx2v_4step_lora_260412_rank_256_fp16.safetensors` | 2.3G |
| `wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022_modified.safetensors` | 705.2M |
| `wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022.safetensors` | 705.2M |
| `wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step.safetensors` | 705.2M |
| `Wan2.2-Lightning_I2V-A14B-4steps-lora_HIGH_fp16.safetensors` | 585.1M |
| `Wan2.2-Lightning_I2V-A14B-4steps-lora_LOW_fp16.safetensors` | 585.1M |
| `Wan2.2-Lightning_T2V-v1.1-A14B-4steps-lora_HIGH_fp16.safetensors` | 585.1M |
| `Wan2.2-Lightning_T2V-v1.1-A14B-4steps-lora_LOW_fp16.safetensors` | 585.1M |
| `WAN22_MoCap_fullbodyCOPY_ED.safetensors` | 2.0G |
| `Wan22_PusaV1_lora_HIGH_resized_dynamic_avg_rank_98_bf16.safetensors` | 911.8M |
| `Wan22_PusaV1_lora_LOW_resized_dynamic_avg_rank_98_bf16.safetensors` | 923.4M |
| `Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1-high_noise_model.safetensors` | 1.1G |
| `Wan2.2-T2V-A14B-4steps-lora-rank64-Seko-V1.1-low_noise_model.safetensors` | 1.1G |
| `wan2.2_t2v_A14b_high_noise_lora_rank64_lightx2v_4step_v1217.safetensors` | 1.1G |
| `wan2.2_t2v_A14b_low_noise_lora_rank64_lightx2v_4step_v1217.safetensors` | 1.1G |
| `Wan22_T2V_UnifiedReward-Flex_LoRA_HIGH_rank64_bf16.safetensors` | 400.1M |
| `Wan22_T2V_UnifiedReward-Flex_LoRA_LOW_rank64_bf16.safetensors` | 400.1M |
| `Wan-AIWan2.2-Animate-14B-relighting_lora-adapter_model.safetensors` | 2.7G |
| `WanAnimate_relight_lora.ckpt` | 2.7G |
| `WanAnimate_relight_lora_fp16_comfy_weight.safetensors` | 1.3G |
| `WanAnimate_relight_lora_fp16-new.safetensors` | 1.3G |
| `WanAnimate_relight_lora_fp16.safetensors` | 1.3G |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-2steps-V1.0-bf16.safetensors` | 2.2G |
| `Wuli-Qwen-Image-2512-Turbo-LoRA-4steps-V2.0-bf16(1).safetensors` | 1.1G |
| `xlab_flux_Realism2_lora.safetensors` | 21.4M |
| `z-image-detailer.safetensors` | 162.2M |
| `Z-Image-Fun-Lora-Distill-4-Steps-2602-ComfyUI.safetensors` | 541.9M |
| `Z-Image-Fun-Lora-Distill-4-Steps-2603-ComfyUI.safetensors` | 541.9M |
| `Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors` | 541.9M |
| `Z-Image-Fun-Lora-Distill-8-Steps-2603.safetensors` | 541.9M |
| `z_image_turbo_distill_patch_lora_bf16.safetensors` | 151.5M |
| `ZIT_Midjourney_Luneva_Cinematic_v1_r128.safetensors` | 648.8M |

### 5.2 H3 `…/h3/loras/` 全量（38）

| 相对路径 | 大小 |
|---|---:|
| `AI_Girl_Fictional_Women_Series30_H3.safetensors` | 284.4M |
| `AI_Girl_Fictional_Women_Series31_H3.safetensors` | 284.4M |
| `cxy_kiss_lora_h3_v01_step1500.safetensors` | 591.1M |
| `deepthroat_v1.safetensors` | 1.1G |
| `epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | 147.9M |
| `h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827/h3_flywheel_smoke6_20260827.safetensors` | 295.6M |
| `H3_footjob_v0_step1000_fixed.safetensors` | 125.2M |
| `h3_musubi_v4-000040.safetensors` | 284.4M |
| `HMNSFW_AIO_V2.safetensors` | 295.8M |
| `hmpussy_v6_epoch30.safetensors` | 597.3M |
| `MiniMax_H3_Combat_LoRA.safetensors` | 147.9M |
| `minimax-h3-digicam.safetensors` | 147.9M |
| `MiniMax-H3-FL2VA-Acc-8Step_pruned_comfy.safetensors` | 1.6G |
| `minimax_h3_fl2v_lightx2v_turbo_4step_v0.1_comfy.safetensors` | 1.8G |
| `minimax_h3_fl2v_turbo_4step_v1.0_768p_comfyui_bf16.safetensors` | 1.8G |
| `minimax_h3_fl2v_turbo_8step_v1.0_10ErosMax_beta1_pruned_compat_v001_T8.safetensors` | 1.8G |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | 1.8G |
| `MiniMax-H3_Futa_Transformations_LoRA_V5.1.safetensors` | 147.9M |
| `MiniMax-H3-Ref2VA-Acc-8Step_pruned_comfy.safetensors` | 1.6G |
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | 1.8G |
| `MiniMax-H3_RemoteOrgasm_v1.safetensors` | 147.9M |
| `minimax_h3_turbo_4步加速_comfyui.safetensors` | 743.7M |
| `minimax_h3_turbo_4step_10ErosMax_test4_pruned_curveproj1025_exp_v001-T8.safetensors` | 758.1M |
| `minimax_h3_turbo_4step_ckpt500.safetensors` | 743.7M |
| `minimax_h3_turbo_4step_ema_ckpt850_pruned_comfyui.safetensors` | 591.6M |
| `MiniMax-H3-Turbo-4step-Lora_ema_comfy.safetensors` | 591.6M |
| `minimax_h3_turbo_v4_step600_ema_pruned_comfyui.safetensors` | 591.6M |
| `minimax_h3_turbo_v4_step600_ema.safetensors` | 743.7M |
| `minimax_vag_000002500.safetensors` | 147.9M |
| `PlagueKind-tiddies-realismslider.safetensors` | 74.0M |
| `riding_pose_H3_i2v_v1.0.safetensors` | 194.4M |
| `SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors` | 2.3G |
| `stomach_bulge_H3_i2v_v1.0.safetensors` | 193.4M |
| `toiv_h3_smoke_v1_30steps.safetensors` | 295.6M |
| `tutu-t8-minimax-h3-av-20to8-nfe-lora-step000300-bf16-comfyui.safetensors` | 737.9M |
| `tutu_t8_minimax_h3_av_20to8_nfe_step300_comfyui.safetensors` | 737.9M |
| `vagassist_e40.safetensors` | 295.8M |
| `VBVR_H3_attn_only.safetensors` | 31.3M |

### 5.3 Windows 树 loras 全量（129）

| 相对路径 | 大小 |
|---|---:|
| `30-360-high.safetensors` | 292.6M |
| `56Low-noise-Cumshot-Aesthetics.safetensors` | 292.6M |
| `AddMicroDetails_Illustrious_v6.safetensors` | 217.9M |
| `Anime_Style_Flux1D.safetensors` | 18.4M |
| `Black_White_Documentary_Photo.safetensors` | 2.3M |
| `BounceHighWan2_2.safetensors` | 292.6M |
| `bounceV03-000084.safetensors` | 568.8M |
| `Breast Size Slider - Illustrious - V2_alpha1.0_rank4_noxattn_last.safetensors` | 8.4M |
| `Bright_Colorful_Photos.safetensors` | 18.4M |
| `c0wg1rl.2_wan22-5b-ti2v - e280.safetensors` | 307.6M |
| `c0wg1rl.3_wan22-5b-ti2v - e380.safetensors` | 153.8M |
| `chasing_blowjob_wan22_v1.0_000001500_high_noise.safetensors` | 292.6M |
| `Chinese_Cultural_Styles_Animation.safetensors` | 292.2M |
| `Cinematic_Action_Film_Style.safetensors` | 327.9M |
| `Cinematic_Photography_style_v1.safetensors` | 292.5M |
| `cknb02_stabilizer_v0.304a_fp16.safetensors` | 81.5M |
| `Claymation_Flux.safetensors` | 18.4M |
| `CloseUpFacialCum-v10_High.safetensors` | 292.6M |
| `consistence_edit_v1.safetensors` | 292.7M |
| `consistence_edit_v2.safetensors` | 585.2M |
| `cutifier_krea2.safetensors` | 218.0M |
| `Cyberpunk_Anime_Style_CPA.safetensors` | 18.4M |
| `cyberpunk-horror-anime-style-flux-lora.safetensors` | 37.9M |
| `deepthroat_v02.safetensors` | 284.4M |
| `DL_3D_Cartoon_Style.safetensors` | 292.2M |
| `DR34MJOB_I2V_14b_HighNoise.safetensors` | 292.6M |
| `DR34MJOB_I2V_14b_LowNoise.safetensors` | 292.6M |
| `DR34ML4Y_I2V_14B_LOW_V2.safetensors` | 292.6M |
| `elie-xl-nvwls-v1.safetensors` | 54.8M |
| `epic_cumshots-MiniMaxH3-ALPHA-CUMSH0T.safetensors` | 147.9M |
| `f2k_9B_lcs_consist_20260415.safetensors` | 332.0M |
| `f2k_consis.safetensors` | 272.0M |
| `Fantasy_Medieval_Street.safetensors` | 302.4M |
| `Film_Noir_1940s_Style.safetensors` | 292.2M |
| `flux_realism_xlabs.safetensors` | 21.4M |
| `hmpussy_v6_epoch30.safetensors` | 597.3M |
| `Hong_Kong_Action_Cinema_Style.safetensors` | 292.3M |
| `Kook_Zimage_如梦似幻.safetensors` | 151.5M |
| `Kook_Zimage_瑶光.safetensors` | 302.9M |
| `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | 312.1M |
| `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` | 2.6G |
| `minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors` | 1.8G |
| `minimax_h3_ref2v_turbo_4step_v0.1_comfyui_bf16.safetensors` | 1.8G |
| `Mystic-XXX-ZIT-V5.safetensors` | 211.9M |
| `NaughtyTimes_pruned_r128_v2.safetensors` | 1.0G |
| `nicegirls_Zimage.safetensors` | 162.2M |
| `NSFW-22-H-e8.safetensors` | 585.1M |
| `pixel_art_style_z_image_turbo.safetensors` | 162.2M |
| `qe2511_consis_alpha_patched.safetensors` | 585.2M |
| `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Edit-2509-Lightning-8steps-V1.0-fp32.safetensors` | 1.6G |
| `Qwen-Image-Edit-2511-Lightning-4steps-V1.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Lightning-4steps-V2.0-bf16.safetensors` | 810.2M |
| `Qwen-Image-Lightning-8steps-V2.0-bf16.safetensors` | 810.2M |
| `realism_engine_krea2_v3.1.safetensors` | 1.5G |
| `RealisticSnapshotKrea2.safetensors` | 218.0M |
| `RealSkin_xxXL_v1.safetensors` | 5.2M |
| `reverse_suspended_congress_I2V_high.safetensors` | 292.6M |
| `reverse_suspended_congress_I2V_low.safetensors` | 292.6M |
| `reverse_suspended_congress_T2V_High.safetensors` | 292.6M |
| `reverse_suspended_congress_T2V_Low.safetensors` | 292.6M |
| `SciFi_Interior_Space.safetensors` | 584.4M |
| `sht_sunian_v1.safetensors` | 81.5M |
| `sht_suxue_v1.safetensors` | 81.5M |
| `sht_xiaoyan_v1.safetensors` | 81.5M |
| `Silent_Hill_Horror_Style.safetensors` | 292.3M |
| `slop_twerk_HighNoise_merged3_7_v2.safetensors` | 292.6M |
| `suspense_poster_flux.safetensors` | 146.2M |
| `Tangfeng_Netidol_Face_Hanfu.safetensors` | 146.2M |
| `Vaporwave_Graphic.safetensors` | 18.4M |
| `Vast_Post_Apocalyptic_Wasteland.safetensors` | 292.2M |
| `VBVR_H3_attn_only.safetensors` | 31.3M |
| `W22_NSFW_Posing_Nude_i2v_HN_v1.safetensors` | 292.6M |
| `W22_NSFW_Posing_Nude_i2v_HN_v2.safetensors` | 292.6M |
| `W22_NSFW_Posing_Nude_i2v_LN_v1.safetensors` | 292.6M |
| `W22_NSFW_Posing_Nude_i2v_LN_v2.safetensors` | 292.6M |
| `Wan2.1-Fun-1.3B-InP-MPS_reward_lora_comfy.safetensors` | 386.5M |
| `Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors` | 87.0M |
| `Wan_2_1_T2V_14B_720p_rCM_lora_average_rank_94_bf16.safetensors` | 853.5M |
| `Wan22_CumV3_High.safetensors` | 585.1M |
| `Wan22_CumV3_Low.safetensors` | 585.1M |
| `wan22-f4c3spl4sh-100epoc-high-k3nk.safetensors` | 304.3M |
| `wan22-f4c3spl4sh-154epoc-low-k3nk.safetensors` | 292.6M |
| `Wan22_I2V_A14B_FutaTF_lora_v1-2_high_noise.safetensors` | 585.1M |
| `Wan22_I2V_A14B_FutaTF_lora_v1-2_low_noise.safetensors` | 585.1M |
| `Wan22_I2V_A14B_FutaTF_lora_v1_high_noise.safetensors` | 292.6M |
| `Wan22_I2V_A14B_FutaTF_lora_v1_low_noise.safetensors` | 292.6M |
| `Wan_2_2_I2V_A14B_HIGH_lightx2v_4step_lora_v1030_rank_64_bf16.safetensors` | 601.5M |
| `wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors` | 605.2M |
| `Wan_2_2_I2V_A14B_LOW_lightx2v_4step_lora_260412_rank_256_fp16.safetensors` | 2.3G |
| `wan22_i2v_anal_v1_high_noise.safetensors` | 292.6M |
| `wan22_i2v_anal_v1_low_noise.safetensors` | 292.6M |
| `WAN-2.2-I2V-Double-Blowjob-HIGH-v1.safetensors` | 585.1M |
| `WAN-2.2-I2V-Double-Blowjob-LOW-v1.safetensors` | 585.1M |
| `WAN-2.2-I2V-HandjobBlowjobCombo-HIGH-v1.safetensors` | 585.1M |
| `WAN-2.2-I2V-HandjobBlowjobCombo-LOW-v1.safetensors` | 585.1M |
| `Wan22-I2V-HIGH-Hip_Slammin_Assertive_Cowgirl.safetensors` | 292.6M |
| `wan2.2_i2v_highnoise_pov_missionary_v1.0.safetensors` | 292.6M |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 1.1G |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 1.1G |
| `Wan22-I2V-LOW-Hip_Slammin_Assertive_Cowgirl.safetensors` | 292.6M |
| `wan2.2_i2v_lownoise_pov_missionary_v1.0.safetensors` | 292.6M |
| `WAN-2.2-I2V-POV-Body-Cumshot-Pullout-HIGH-v1.safetensors` | 585.1M |
| `WAN-2.2-I2V-POV-Cowgirl-HIGH-v0.1.safetensors` | 292.6M |
| `WAN-2.2-I2V-POV-Cowgirl-HIGH-v0.2.safetensors` | 585.1M |
| `WAN-2.2-I2V-POV-Cowgirl-HIGH-v1.0-fixed.safetensors` | 585.1M |
| `WAN-2.2-I2V-POV-Cowgirl-LOW-v0.1.safetensors` | 292.6M |
| `WAN-2.2-I2V-POV-Cowgirl-LOW-v0.2.safetensors` | 585.1M |
| `WAN-2.2-I2V-POV-Cowgirl-LOW-v1.0-fixed.safetensors` | 585.1M |
| `wan2.2_i2v_seko_v1_high_noise.safetensors` | 1.1G |
| `wan2.2_i2v_seko_v1_low_noise.safetensors` | 1.1G |
| `Wan2.2-Lightning_T2V-v1.1-A14B-4steps-lora_LOW_fp16.safetensors` | 585.1M |
| `wan22-m4crom4sti4-i2v-20epoc-high-k3nk.safetensors` | 292.6M |
| `wan22.r3v3rs3_c0wg1rl-14b-High-i2v_e70.safetensors` | 585.1M |
| `wan22.r3v3rs3_c0wg1rl-14b-High-t2v_e120.safetensors` | 585.1M |
| `wan22.r3v3rs3_c0wg1rl-14b-Low-i2v_e70.safetensors` | 585.1M |
| `wan22.r3v3rs3_c0wg1rl-14b-Low-t2v_e120.safetensors` | 585.1M |
| `wan2.2_t2v_highnoise_pov_missionary_v1.0.safetensors` | 292.6M |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` | 1.1G |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` | 1.1G |
| `wan2.2_t2v_lownoise_pov_missionary_v1.0.safetensors` | 292.6M |
| `wan2.2_t2v_seko_v20_high_noise.safetensors` | 1.1G |
| `wan2.2_t2v_seko_v20_low_noise.safetensors` | 1.1G |
| `wan_fingering_pussy_i2v2.2hi_v10.safetensors` | 292.6M |
| `wan_fingering_pussy_i2v2.2lo_v10.safetensors` | 292.6M |
| `xianxia_ancient_chinese.safetensors` | 17.4M |
| `Youthful_Campus_Style.safetensors` | 292.2M |
| `Z-Image-Fun-Lora-Distill-8-Steps-2603-ComfyUI.safetensors` | 541.9M |
| `zimage_i2l_flatvector_smoke.safetensors` | 19.0M |

---

## 6. 与 MODEL_SOURCES 账本对照

- 账本：`docs/MODEL_SOURCES.json` updated `2026-10-22T03:50:00+08:00`；totals ok=493 blocked=337 total=831
- 账本 ok 且 rel 在 loras/ 的 basename：**173**
- 账本有、主库 A 磁盘无（可能在 H3/Windows/别名/已挪）：**0**

- 主库 A 有、账本完全无此 basename：**88**

<details><summary>磁盘有但账本无（样例/全量）</summary>

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
- `Wan2_1_self_forcing_dmd_1_3B_lora_rank_32_fp16.safetensors`
- `WanAnimate_relight_lora.ckpt`
- `Wan_2_1_T2V_14B_720p_rCM_lora_average_rank_94_bf16.safetensors`
- `Wan_2_2_I2V_A14B_LOW_lightx2v_4step_lora_260412_rank_256_fp16.safetensors`
- `ZIT_Midjourney_Luneva_Cinematic_v1_r128.safetensors`
- `chronoedit_distill_lora.safetensors`
- `city_streets_at_night_flux.safetensors`
- `cyberpunk_edgerunners_ltx.safetensors`
- `eternal_oath_wedding_flux.safetensors`
- `flux_romanticism.safetensors`
- `ghost_glitter_v1_flux.safetensors`
- `ghost_glitter_v1_illustrious.safetensors`
- `hanfu_chinese_girl_flux.safetensors`
- `hanfu_flux_v2.safetensors`
- `hunyuan_video_accvid_5_steps_lora_rank16_fp8_e4m3fn.safetensors`
- `hyper_flux_8step_lora.safetensors`
- `hyper_sdxl_1step_lora.safetensors`
- `hyper_sdxl_2step_lora.safetensors`
- `hyper_sdxl_4step_lora.safetensors`
- `hyper_sdxl_8step_lora.safetensors`
- `hyvideo_FastVideo_LoRA-fp8.safetensors`
- `i2l_smoke_20260827.safetensors`
- `ip-adapter-faceid-plusv2_sd15_lora.safetensors`
- `ip-adapter-faceid-plusv2_sdxl_lora.safetensors`
- `krea2_turbo_training_adapter.safetensors`
- `krea_crimson_dark_victorian.safetensors`
- `krea_crimson_dark_victorian_war.safetensors`
- `krea_foggy_gothic_fairytale.safetensors`
- `krea_foggy_gothic_fairytale_rom.safetensors`
- `krea_hazy_desert_dreamscape.safetensors`
- `krea_neon_drip.safetensors`
- `krea_rainy_window.safetensors`
- `lightning_sdxl_2step_lora.safetensors`
- `lightning_sdxl_4step_lora.safetensors`
- `lightx2v_T2V_14B_cfg_step_distill_v2_lora_rank64_bf16.safetensors`
- `linaqruf_anime_detailer.safetensors`
- `linaqruf_pastel_anime.safetensors`
- `linaqruf_sketch_style.safetensors`
- `linaqruf_style_enhancer.safetensors`
- `ltx-2.3-22b-distilled-lora-1.1_fro90_ceil72_condsafe.safetensors`
- `ltx-2.3-22b-distilled-lora-384-1.1.safetensors`
- `ltx-2.3-22b-ic-lora-lipdub-0.9.safetensors`
- `ltx-2.3-22b-ic-lora-motion-track-control-ref0.5.safetensors`
- `ltx-2.3-22b-ic-lora-union-control-ref0.5.safetensors`
- `ltx-2.3-22b-lora-foley-v2a-1.0.safetensors`
- `ltx_cinematic_sci_fi_cyberpunk.safetensors`
- `ltx_cinematic_sci_fi_dir.safetensors`
- `ltx_post_apocalyptic.safetensors`
- `ltx_post_apocalyptic_dir.safetensors`
- `medieval_knight_sdxl.safetensors`
- `military_artillery_k9_flux.safetensors`
- `ntc_cinematic_lighting.safetensors`
- `ostris_face_helper_sdxl.safetensors`
- `qwen-image-edit-2511-multiple-angles-lora.safetensors`
- `samurai_jack.safetensors`
- `vampire_slider.safetensors`
- `wan2.2_animate_14B_relight_lora_bf16.safetensors`
- `wan2.2_i2v_A14b_high_noise_lora_rank64_lightx2v_4step_1022.safetensors`
- `wan2.2_i2v_A14b_low_noise_lora_rank64_lightx2v_4step_1022_modified.safetensors`
- `wan22_orbit_high_noise.safetensors`
- `wan22_orbit_low_noise.safetensors`
- `wedding_photo_slider.safetensors`
- `zimage_turbo_training_adapter_v2.safetensors`

</details>

说明：账本是溯源/下载台账，不是「当前在跑」清单；本文件以真机文件为准。

---

## 7. 扫描失败 / 未深查

| 项 | 结果 |
|---|---|
| NAS SSH `dgmt-nas@.7` | 历史常 publickey 拒；本轮**未直连**，经 WS CIFS 扫成功 |
| `/home/merlin/nas_mount/comfyui-models`（非 toiv） | 仅 ~5.3G（FlashVSR-v1.1 等），非主库 |
| spark `../spark-models/*` symlink | 断链，目标未解析 |
| openclaw02–04 模型字符串 | 未逐机读源码；health 同构，按 01 推断 |
| engines API 文件枚举 | 只返回引擎 schema，无权重列表 |
| 改服务 / commit / 部署 | **未做** |

---

## 8. 原始扫描落盘（本机临时）

- `/tmp/toiv_model_inventory_20261025/*.tsv`（分类文件列表）
- `/tmp/engines.json`（24 engines schema）

如需复扫：SSH `workstation-lan` 对 `nas_mount/toiv/comfyui-models` 再 `find`。

---

## 9. 用途速查（诚实边界 · 2026-10-25）

> 全量来源/用途分级调研 → [`MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md`](MODEL_SOURCE_PURPOSE_RESEARCH_20261025.md)

> **问**：「库存里那些模型和 LoRA，作用你都知道吗？」  
> **答**：**不都知道。** 下面按证据分层；不能假装对 400+ LoRA 逐个有实验结论。

### 9.1 我确定知道作用的（产品链路 / 在跑服务 / 代码点名）

| 能力 | 代表 | 一句话用途 | 证据 |
|---|---|---|---|
| 对话 LLM | Mia `DeepSeek-V4.1-Flash-1017` @ spark02 `:8888` | 剧本/对话主脑（当前生产入口） | 真机容器 + ToIV proxy |
| 对话 LLM（库存） | `dsv4-flash-dspark-abliterated` | 旧主脑权重；与 Mia **同卡互斥** | 磁盘在、`:8000` 已停 |
| VLM | `Qwen3-VL-8B-Instruct` @ WS `:9311` | 看图理解 / 镜头描述 | 在跑服务 |
| Embed | `Qwen3-Embedding-4B` @ `:9302` | 向量检索/语义嵌入 | 在跑服务 |
| TTS | IndexTTS 2.5 @ `:9200` | 配音合成 | 在跑服务 |
| ASR | Whisper large-v3-mlx @ openclaw `:9310` | 语音转文字 | 在跑服务 |
| Caption | JoyCaption @ `:9305` | 图生字幕/描述 | 在跑服务 |
| 出图基座（产品默认） | `Qwen-Rapid-AIO-SFW-v23` | 文生图默认 checkpoint | gate `model-config` |
| 出图/视频引擎 | Comfy LB `:8188`、LongCat `:8197`、Animate2 `:8199` | 按作业加载 NAS/Windows 权重 | 在跑端口 |
| 视频 H3 | `minimax_h3_*_pruned_int8_convrot` @ `:8264` | 图/参考→视频主链 | gate + 在跑 |
| 超分 | `:8262/:8263` | 画质放大 | 在跑 |
| 分轨 | demucs @ `:9220` | 人声/伴奏分离 | 在跑 |
| 辅助资产 | VAE / text_encoders / controlnet / upscale / clip_vision | 管线零件（非「一键出片模型」） | 目录角色固定 |
| **策划过的 LoRA** | `lora_catalog.py` **21** 张卡；`WAN_I2V_NSFW_LORAS` 6；`H3_NSFW_LORAS` 9 | 有 role/强度/触发词/中文标签；产品视频提交只认这批 | 代码 |

### 9.2 只能从命名 / 账本 / 子目录推断的（未逐个实测）

主库 LoRA **264**（命名启发式，可多标，**非**实验室结论）：

| 大类（从文件名/路径猜） | 数量级（主库命中） | 例子方向（不列全表） |
|---|---:|---|
| 视频底座适配（Wan / LTX / LongCat…） | ~130 命中 | `Wan2.2-*`、`ltx2.3/*` |
| 加速/蒸馏/少步 | ~90+ | lightx2v、Hyper、distill、4/8step |
| 画风/题材（含子目录 campus、horror…） | ~35 | 汉服、校园、恐怖、婚礼题材 |
| 姿态/运镜 | ~20 | AnyPose、orbit、camera |
| 人物一致/换脸/subject | ~18 | Consistance、BFS Face Swap |
| 编辑/局部/IC-LoRA | ~40+ 命中 | Qwen-Edit、Inpaint、multiple-angles |
| 成人动作/NSFW（文件名明示；另有大量 leetspeak 未穷尽） | 明示 ~9；H3 名单 9；盘上还更多体位向 | 见 `H3_NSFW_LORAS` / Wan 六件套 |
| 命名含糊（启发式也难归类） | ~20 | 缩写、slider、fusion 名 |

`MODEL_SOURCES.json`：**没有** `purpose` / `tags` / `capability` 字段；`notes` 主要是溯源/下载痕迹，**不是用途说明书**。偶有一句用途（如 BFS Face Swap），属少数。

### 9.3 我不知道 / 不确定的（不能装懂）

- **主库有、账本无 basename：88 个** — 磁盘在，账本未收录；多数能从名字猜大类，但无官方 README、无产品标签、无本仓实测记录。
- **账本 blocked / provenance_lost** — 例如部分 H3 R18 上游下架：文件还能用，但**不可再溯源**。
- **断链 symlink**（euryale / rocinante / skyfall）— 目标不在，谈不上作用。
- **仅库存未挂服务的大模型**（glm53、qwen3.6-awq、CosyVoice、SoulX、ltx25 本地树等）— 知道「一般是什么族」，**不知道你买来准备接哪条产品链、是否还能跑通当前 Comfy/依赖**。
- **404 去重 LoRA 并集** — 除上述 ~21 张策划卡外，**不能**声称「每张都知道最佳强度/触发词/和哪套基座冲突」。

### 9.4 若要补「用途标签」（最小做法 · 未自动开干）

1. 在 `MODEL_SOURCES` 或旁路 `lora_purpose.json` 加：`basename → {role, engines[], nsfw, one_liner, evidence}`。  
2. 先标：**产品默认基座 + `lora_catalog` 已有 21 + 设置页槽位候选**；其余批量用「命名启发式 + 待人工确认」灰标。  
3. 设置页库存只展示「已标签 / 灰标」，禁止把 NAS 全目录当无说明混搭池（与 `lora_catalog` 注释一致）。

本轮：**只追加本节**；未改服务、未 commit。
