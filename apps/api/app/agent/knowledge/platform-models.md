# ToIV 平台已装模型

> 与 AICG 项目共用同一 NAS 模型库（`~/NAS/Windows/ComfyUI/ComfyUIModel/models`），物理层面自动同步。本文档按当前 NAS 实际清单整理，供 ToIV Agent 选择模型时参考。

## 图像大模型（Checkpoints）

| 模型 | 说明 |
|------|------|
| `DreamShaper_8_pruned.safetensors` | SD1.5 通用，平台默认出图模型，泛用、稳。 |
| `GhostMix鬼混_V2.0.safetensors` | SD1.5，风格化。 |
| `majicMIX realistic 麦橘写实_v7.safetensors` | SD1.5，偏写实人像。 |
| `v1-5-pruned-emaonly-fp16.safetensors` | SD1.5 原版。 |
| `基础算法 V1.5_v 1.5.safetensors` | SD1.5。 |
| `Qwen-Image(fp8)` (`qwen_image_fp8_e4m3fn.safetensors`) | 新架构，中文文字渲染能力强，适合带中文字的海报。 |
| `Flux.2 Klein 4B` (`flux-2-klein-4b.safetensors`) | 新架构，轻量高质量。 |
| `Z-Image Turbo` (`zImageTurbo_turbo.safetensors` / `z_image_turbo_bf16.safetensors`) | 新架构，出图极快。 |
| `ponyRealism_V22.safetensors` | Pony Realism。 |
| `ponyDiffusionV6XL_v6.safetensors` | Pony Diffusion V6。 |
| `waiIllustriousSDXL_v170.safetensors` | WAI Illustrious。 |
| `waiSHUFFLENOOB_vPred04.safetensors` | WAI SHUFFLE NOOB vpred。 |
| `noobaiXL_vpred10.safetensors` | NoobAI XL vpred。 |
| `hassakuXLIllustrious_v34.safetensors` | Hassaku XL Illustrious。 |
| `autismmixSDXL_autismmixPony.safetensors` | AutismMix Pony。 |
| `cyberrealistic_v120.safetensors` | CyberRealistic。 |
| `cyberrealisticPony_v180Coreshift.safetensors` | CyberRealistic Pony Coreshift。 |
| `lustifySDXLNSFW_apexV8.safetensors` | LUSTIFY SDXL NSFW。 |
| `nova3DCGXL_ilV90.safetensors` | Nova 3DCG XL。 |
| `animagineXL40.safetensors` | Animagine XL 4.0。 |
| `sd_xl_base_1.0.safetensors` | SDXL Base。 |
| `my_checkpoint_v1.safetensors` | 自定义 checkpoint。 |
| `elie-xl-nvwls-v1.safetensors` | 写实 NSFW。 |

## 视频模型（Checkpoints / Diffusion Models）

| 模型 | 说明 |
|------|------|
| `10eros_v14.safetensors` | LTX 视频 NSFW 变体。 |
| `ltx-2.3-distilled.safetensors` | LTX 2.3 视频 distilled。 |
| `ltx-2.3-22b-distilled_transformer_only_fp8_scaled.safetensors` | LTX 2.3 22B fp8。 |
| `ltx-video-2b-v0.9.5.safetensors` | LTX Video 2B。 |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 文生视频 low noise 14B。 |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 文生视频 high noise 14B。 |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 图生视频 low noise 14B。 |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 图生视频 high noise 14B。 |

ToIV 的“文生视频”一般先文生底图，再用 Wan 驱动其运动；Wan i2v 支持 high/low noise 双扩散 + lightx2v 4 步加速 LoRA，640×480、约 3 秒/49 帧、16fps，输出 animated webp。

## 3D 模型

| 模型 | 说明 |
|------|------|
| `hunyuan3d-dit-v2-0-fp16.safetensors` | 图生 3D，输入一张图，输出 3D 网格（glb）。 |

## 音频模型

| 模型 | 说明 |
|------|------|
| `ace_step_v1_3.5b.safetensors` | 文生音乐，输入风格标签（可选歌词），输出 mp3（44.1kHz 立体声）。 |
| `mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors` | MMAudio 音频生成。 |

## Diffusion Models / UNET

| 模型 | 说明 |
|------|------|
| `10eros_v14.safetensors` | LTX 视频 NSFW 变体（Diffusion Model）。 |
| `flux2_dev_fp8mixed.safetensors` | Flux.2 Dev。 |
| `flux-2-klein-4b.safetensors` | Flux.2 Klein 4B。 |
| `z_image_turbo_bf16.safetensors` | Z-Image Turbo。 |
| `qwen_image_fp8_e4m3fn.safetensors` | Qwen-Image。 |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 t2v low noise。 |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 t2v high noise。 |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 i2v low noise。 |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 i2v high noise。 |
| `smoothMixWan2214BI2V_i2vV20Low.safetensors` | SmoothMix Wan 2.2 i2v low。 |
| `smoothMixWan2214BI2V_i2vV20High.safetensors` | SmoothMix Wan 2.2 i2v high。 |
| `wan2.1_vace_14B_fp16.safetensors` | Wan 2.1 VACE 14B。 |
| `ltx-2.3-distilled.safetensors` | LTX 2.3 distilled。 |
| `ltx-2.3-22b-distilled_transformer_only_fp8_scaled.safetensors` | LTX 2.3 22B fp8。 |
| `ltx-video-2b-v0.9.5.safetensors` | LTX Video 2B。 |
| `lotus-depth-d-v1-1.safetensors` | Lotus 深度模型。 |

## LoRAs

### Flux.1 D 风格 LoRAs（本次新增，RAG 推荐用）

| 模型 | 说明 |
|------|------|
| `Cinematic_Photography_style_v1.safetensors` | 写实电影感 |
| `suspense_poster_flux.safetensors` | 悬疑海报 |
| `Cyberpunk_Anime_Style_CPA.safetensors` | 赛博朋克动漫 |
| `xianxia_ancient_chinese.safetensors` | 古风仙侠 |
| `Chinese_Cultural_Styles_Animation.safetensors` | 国风动漫 |
| `Anime_Style_Flux1D.safetensors` | 日漫 |
| `DL_3D_Cartoon_Style.safetensors` | 3D 卡通 |
| `Silent_Hill_Horror_Style.safetensors` | 恐怖惊悚 |
| `SciFi_Interior_Space.safetensors` | 科幻太空 |
| `Vast_Post_Apocalyptic_Wasteland.safetensors` | 末日废土 |
| `Film_Noir_1940s_Style.safetensors` | 黑色电影 |
| `Hong_Kong_Action_Cinema_Style.safetensors` | 复古港风 |
| `Tangfeng_Netidol_Face_Hanfu.safetensors` | 宫廷汉服 |
| `Youthful_Campus_Style.safetensors` | 校园青春 |
| `Bright_Colorful_Photos.safetensors` | 喜剧明快 |
| `Black_White_Documentary_Photo.safetensors` | 纪录片纪实 |
| `Cinematic_Action_Film_Style.safetensors` | 现代动作 |
| `Fantasy_Medieval_Street.safetensors` | 西方奇幻 |
| `Vaporwave_Graphic.safetensors` | 蒸汽波 |
| `Claymation_Flux.safetensors` | 定格动画黏土 |

### 其他 LoRAs

| 模型 | 说明 |
|------|------|
| `pixel_art_style_z_image_turbo.safetensors` | 像素艺术 |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | Wan i2v 4 步加速 low noise |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | Wan i2v 4 步加速 high noise |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` | Wan t2v 4 步加速 low noise |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` | Wan t2v 4 步加速 high noise |
| `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | LTX 运镜控制 |
| `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` | LTX 2.3 22B 动态 LoRA |
| `AddMicroDetails_Illustrious_v6.safetensors` | Illustrious 微细节增强 |
| `RealSkin_xxXL_v1.safetensors` | 真实皮肤 |
| `Breast Size Slider - Illustrious.safetensors` | 体型调整 |
| `cknb02_stabilizer_v0.304a_fp16.safetensors` | 稳定化 |
| `moodyPornMix_zitV7.safetensors` | NSFW 风格 |
| `prefectIllustriousXL_40.safetensors` | Illustrious 优化 |
| `Mystic-XXX-ZIT-V5.safetensors` | NSFW 风格 |
| `nicegirls_Zimage.safetensors` | Z-Image 风格 |

## VAE

| 模型 | 说明 |
|------|------|
| `taeltx2_3.safetensors` | LTX 2.3 相关 VAE |
| `LTX23_audio_vae_bf16.safetensors` | LTX 2.3 音频 VAE |
| `LTX23_video_vae_bf16.safetensors` | LTX 2.3 视频 VAE |
| `mmaudio_vae_44k_fp16.safetensors` | MMAudio VAE |
| `wan_2.1_vae.safetensors` | Wan 2.1 VAE |
| `vae-ft-mse-840000-ema-pruned.safetensors` | SD1.5 通用 VAE |
| `qwen_image_vae.safetensors` | Qwen-Image VAE |
| `flux2-vae.safetensors` | Flux.2 VAE |
| `ae.safetensors` | Flux 默认 VAE |

## Text Encoders

| 模型 | 说明 |
|------|------|
| `gemma3_12b_it_bf16/model.safetensors` | Gemma 3 12B IT |
| `mistral_3_small_flux2_fp8.safetensors` | Mistral 3 Small Flux.2 |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Qwen 2.5 VL 7B |
| `gemma_3_12B_it_fp8_scaled.safetensors` | Gemma 3 12B IT fp8 |
| `ltx-2.3_text_projection_bf16.safetensors` | LTX 2.3 文本投影 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | UMT5 XXL |
| `qwen_3_4b.safetensors` | Qwen 3 4B |

## CLIP / CLIP Vision

| 模型 | 说明 |
|------|------|
| `apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors` | Apple DFN5B CLIP ViT-H-14-384 |
| `CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors` | CLIP ViT-bigG-14 |
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | CLIP ViT-H-14 |
| `model.safetensors` | CLIP Vision 默认模型 |

## ControlNet

| 模型 | 说明 |
|------|------|
| `controlnet-union-sdxl-1.0-promax.safetensors` | SDXL ControlNet Union |
| `Qwen-Image-InstantX-ControlNet-Union.safetensors` | Qwen-Image 构图控制 |
| `control_v11p_sd15_lineart_fp16.safetensors` | SD1.5 lineart |
| `control_v11p_sd15_openpose_fp16.safetensors` | SD1.5 openpose |
| `control_v11p_sd15_depth_fp16.safetensors` | SD1.5 depth |
| `control_v11p_sd15_canny_fp16.safetensors` | SD1.5 canny |

## 深度 / 辅助

| 模型 | 说明 |
|------|------|
| `lotus-depth-d-v1-1.safetensors` | Lotus 深度估计。 |

## 模型族采样提示

- `flux` 族（Flux.2 / Z-Image / Qwen-Image 等）：`cfg=1`、无需负向提示词、`model_sampling` 需对应调整；`model_profiles.py` 中 `detect_model_family` 已覆盖。
- `sd1.5` / `sdxl` 族：常规 CFG 与负向提示词可用。
- `wan` 视频：`high_noise` / `low_noise` 决定运动强度，配合 `lightx2v` 4 步 LoRA 可显著提速。
- `ltx` 视频：支持蒸馏版与 22B 版，可用 camera-control LoRA 控制运镜。

## 同步说明

- ToIV 与 AICG 共用同一 NAS 模型目录，物理文件已自动保持一致。
- 本知识文档需随 NAS 模型增减同步维护；新增 Flux.1 D 风格 LoRA 已加入，LoRA 适配由 `model_profiles.py` 统一处理，无需额外代码改动。
- 部分 checkpoint / LoRA 为成人内容（NSFW），按需使用。
