# ToIV 模型/LoRA/工具全量清单与补全建议

> 本文件汇总 **NAS 现有模型**、**代码中已引用但未确认存在的模型**、**缺失需下载的模型**以及**调研后建议补充的更优模型**。后续所有新增模型统一放到 NAS `//192.168.71.7/NAS/toiv/comfyui-models` 下对应子目录。

---

## 一、NAS 统一目录规范（建议）

所有生成类模型统一放到 NAS 共享，worker 通过 SMB/NFS 或本地缓存读取：

```
//192.168.71.7/NAS/toiv/comfyui-models/
├── checkpoints/          # 图像/视频大模型整包 checkpoint
├── diffusion_models/     # 分离的 diffusion model / UNET
├── text_encoders/        # CLIP / T5 / Qwen-VL / Gemma / UMT5 等
├── vae/                  # VAE
├── loras/                # LoRA（风格、场景、角色、特效、运镜）
├── controlnet/           # ControlNet
├── ipadapter/            # IPAdapter 系列
├── pulid/                # PuLID 系列
├── clip_vision/          # CLIP Vision / EVA-CLIP
├── upscale_models/       # RealESRGAN、4x-UltraSharp 等
├── embeddings/           # Textual Inversion / 嵌入
├── unet/                 # 独立 UNET
├── audio/                # 音频模型（TTS、音乐、音效、分离）
├── video_aux/            # 视频辅助模型（RIFE、 lipsync、LivePortrait）
└── 3d/                   # Hunyuan3D 等
```

---

## 二、现有模型清单（已在代码/文档中引用）

### 2.1 图像大模型（Checkpoints / Diffusion Models）

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `DreamShaper_8_pruned.safetensors` | SD1.5 | 已引用 | 平台默认出图模型 |
| `GhostMix鬼混_V2.0.safetensors` | SD1.5 | 已引用 | 风格化 |
| `majicMIX realistic 麦橘写实_v7.safetensors` | SD1.5 | 已引用 | 写实人像 |
| `v1-5-pruned-emaonly-fp16.safetensors` | SD1.5 | 已引用 | SD1.5 原版 |
| `基础算法 V1.5_v 1.5.safetensors` | SD1.5 | 已引用 | 国产 SD1.5 |
| `qwen_image_fp8_e4m3fn.safetensors` | Qwen-Image 1.0 | 已引用 | 中文文字渲染强 |
| `flux2_dev_fp8mixed.safetensors` | FLUX.2 Dev | 已引用 | 当前次世代主力 |
| `flux-2-klein-4b.safetensors` | FLUX.2 Klein 4B | 已引用 | 轻量高质量 |
| `z_image_turbo_bf16.safetensors` | Z-Image Turbo | 已引用 | 极速出图 |
| `ponyRealism_V22.safetensors` | Pony XL | 已引用 | 写实 Pony |
| `ponyDiffusionV6XL_v6.safetensors` | Pony XL | 已引用 | Pony Diffusion |
| `waiIllustriousSDXL_v170.safetensors` | Illustrious XL | 已引用 | WAI Illustrious |
| `waiSHUFFLENOOB_vPred04.safetensors` | Illustrious XL | 已引用 | WAI SHUFFLE NOOB |
| `noobaiXL_vpred10.safetensors` | NoobAI XL | 已引用 | NoobAI vpred |
| `hassakuXLIllustrious_v34.safetensors` | Illustrious XL | 已引用 | Hassaku |
| `autismmixSDXL_autismmixPony.safetensors` | Pony XL | 已引用 | AutismMix |
| `cyberrealistic_v120.safetensors` | SD1.5/SDXL | 已引用 | CyberRealistic |
| `cyberrealisticPony_v180Coreshift.safetensors` | Pony XL | 已引用 | CyberRealistic Pony |
| `lustifySDXLNSFW_apexV8.safetensors` | SDXL | 已引用 | NSFW 专用 |
| `nova3DCGXL_ilV90.safetensors` | SDXL | 已引用 | 3D CG 风格 |
| `animagineXL40.safetensors` | SDXL | 已引用 | 动漫 |
| `sd_xl_base_1.0.safetensors` | SDXL | 已引用 | SDXL Base |
| `elie-xl-nvwls-v1.safetensors` | SDXL | 已引用 | 写实 NSFW |

### 2.2 视频模型

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `10eros_v14.safetensors` | LTX NSFW | 已引用 | LTX 视频 NSFW 变体 |
| `ltx-2.3-distilled.safetensors` | LTX 2.3 | 已引用 | LTX 2.3 distilled |
| `ltx-2.3-22b-distilled_transformer_only_fp8_scaled.safetensors` | LTX 2.3 | 已引用 | LTX 2.3 22B fp8 |
| `ltx-video-2b-v0.9.5.safetensors` | LTX | 已引用 | LTX Video 2B |
| `wan2.2_t2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 | 已引用 | Wan 2.2 文生视频 low noise |
| `wan2.2_t2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 | 已引用 | Wan 2.2 文生视频 high noise |
| `wan2.2_i2v_low_noise_14B_fp8_scaled.safetensors` | Wan 2.2 | 已引用 | Wan 2.2 图生视频 low noise |
| `wan2.2_i2v_high_noise_14B_fp8_scaled.safetensors` | Wan 2.2 | 已引用 | Wan 2.2 图生视频 high noise |
| `smoothMixWan2214BI2V_i2vV20Low.safetensors` | Wan 2.2 | 已引用 | SmoothMix i2v low |
| `smoothMixWan2214BI2V_i2vV20High.safetensors` | Wan 2.2 | 已引用 | SmoothMix i2v high |
| `wan2.1_vace_14B_fp16.safetensors` | Wan 2.1 VACE | 已引用 | VACE 统一编辑 |

### 2.3 3D 模型

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `hunyuan3d-dit-v2-0-fp16.safetensors` | Hunyuan3D | 已引用 | 图生 3D |

### 2.4 音频模型

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `ace_step_v1_3.5b.safetensors` | ACE-Step | 已引用 | 文生音乐 v1 |
| `mmaudio_large_44k_nsfw_gold_8.5k_final_fp16.safetensors` | MMAudio | 已引用 | 视频/文本到音频 |

### 2.5 Text Encoders

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `gemma3_12b_it_bf16/model.safetensors` | Gemma 3 | 已引用 | LTX 文本编码 |
| `mistral_3_small_flux2_fp8.safetensors` | Mistral 3 Small | 已引用 | FLUX.2 文本编码 |
| `qwen_2.5_vl_7b_fp8_scaled.safetensors` | Qwen 2.5 VL | 已引用 | Qwen-Image 1.0 编码器 |
| `qwen_3_4b.safetensors` | Qwen 3 4B | 已引用 | FLUX.2 Klein 编码 |
| `umt5_xxl_fp8_e4m3fn_scaled.safetensors` | UMT5 XXL | 已引用 | Wan 视频编码 |

### 2.6 CLIP / CLIP Vision

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `apple_DFN5B-CLIP-ViT-H-14-384_fp16.safetensors` | CLIP | 已引用 | Apple DFN5B |
| `CLIP-ViT-bigG-14-laion2B-39B-b160k.safetensors` | CLIP | 已引用 | bigG |
| `CLIP-ViT-H-14-laion2B-s32B-b79K.safetensors` | CLIP | 已引用 | H-14 |

### 2.7 ControlNet / 深度 / 辅助

| 模型文件名 | 架构 | 当前状态 | 说明 |
|---|---|---|---|
| `controlnet-union-sdxl-1.0-promax.safetensors` | SDXL ControlNet | 已引用 | Union Promax |
| `Qwen-Image-InstantX-ControlNet-Union.safetensors` | Qwen-Image ControlNet | 已引用 | 构图控制 |
| `control_v11p_sd15_lineart/openpose/depth/canny_fp16.safetensors` | SD1.5 ControlNet | 已引用 | 经典 ControlNet |
| `lotus-depth-d-v1-1.safetensors` | Lotus | 已引用 | 深度估计 |

### 2.8 LoRAs（已有）

| 模型文件名 | 类型 | 说明 |
|---|---|---|
| `Cinematic_Photography_style_v1.safetensors` | 风格 | 写实电影感 |
| `suspense_poster_flux.safetensors` | 风格 | 悬疑海报 |
| `Cyberpunk_Anime_Style_CPA.safetensors` | 风格 | 赛博朋克动漫 |
| `xianxia_ancient_chinese.safetensors` | 风格 | 古风仙侠 |
| `Chinese_Cultural_Styles_Animation.safetensors` | 风格 | 国风动漫 |
| `Anime_Style_Flux1D.safetensors` | 风格 | 日漫 |
| `DL_3D_Cartoon_Style.safetensors` | 风格 | 3D 卡通 |
| `Silent_Hill_Horror_Style.safetensors` | 风格 | 恐怖惊悚 |
| `SciFi_Interior_Space.safetensors` | 风格 | 科幻太空 |
| `Vast_Post_Apocalyptic_Wasteland.safetensors` | 风格 | 末日废土 |
| `Film_Noir_1940s_Style.safetensors` | 风格 | 黑色电影 |
| `Hong_Kong_Action_Cinema_Style.safetensors` | 风格 | 复古港风 |
| `Tangfeng_Netidol_Face_Hanfu.safetensors` | 风格 | 宫廷汉服 |
| `Youthful_Campus_Style.safetensors` | 风格 | 校园青春 |
| `Bright_Colorful_Photos.safetensors` | 风格 | 喜剧明快 |
| `Black_White_Documentary_Photo.safetensors` | 风格 | 纪录片纪实 |
| `Cinematic_Action_Film_Style.safetensors` | 风格 | 现代动作 |
| `Fantasy_Medieval_Street.safetensors` | 风格 | 西方奇幻 |
| `Vaporwave_Graphic.safetensors` | 风格 | 蒸汽波 |
| `Claymation_Flux.safetensors` | 风格 | 定格动画黏土 |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_low_noise.safetensors` | 视频加速 | Wan i2v 4 步 low |
| `wan2.2_i2v_lightx2v_4steps_lora_v1_high_noise.safetensors` | 视频加速 | Wan i2v 4 步 high |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_low_noise.safetensors` | 视频加速 | Wan t2v 4 步 low |
| `wan2.2_t2v_lightx2v_4steps_lora_v1.1_high_noise.safetensors` | 视频加速 | Wan t2v 4 步 high |
| `ltx-2-19b-lora-camera-control-dolly-left.safetensors` | 运镜 | LTX 运镜控制 |
| `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors` | 视频动态 | LTX 2.3 22B 动态 |
| `AddMicroDetails_Illustrious_v6.safetensors` | 画质增强 | Illustrious 微细节 |
| `RealSkin_xxXL_v1.safetensors` | 画质增强 | 真实皮肤 |
| `Breast Size Slider - Illustrious.safetensors` | 调整 | 体型调整 |
| `cknb02_stabilizer_v0.304a_fp16.safetensors` | 稳定化 | 视频稳定 |
| `moodyPornMix_zitV7.safetensors` | NSFW 风格 | - |
| `prefectIllustriousXL_40.safetensors` | 画质增强 | Illustrious 优化 |
| `Mystic-XXX-ZIT-V5.safetensors` | NSFW 风格 | - |
| `nicegirls_Zimage.safetensors` | Z-Image 风格 | - |

---

## 三、缺失模型清单（按优先级）

### P0：质量提升最明显

| # | 模型/工具 | 用途 | 推荐下载源 | 预计大小 | 存放目录 | 备注 |
|---|---|---|---|---|---|---|
| 1 | Qwen3-VL-7B-Instruct 满血 | Qwen-Image 2.0 文本编码器 | `Qwen/Qwen3-VL-7B-Instruct` | ~14GB fp16 | `text_encoders/` | 无量化包时跑满血；需转换或 ComfyUI 原生节点支持 |
| 2 | Qwen-Image 2.0 扩散模型 | 图像生成/编辑 | `Qwen/Qwen-Image` | 待确认 | `diffusion_models/` | 2k 分辨率、1k token 超长指令、中文文字渲染 |
| 3 | PuLID Flux v0.9.0/v1.0 | 角色一致性 | `guozinan/PuLID` | ~1GB | `pulid/` | 比 IPAdapter FaceID 更强 |
| 4 | EVA02-CLIP-L-14-336 | PuLID 依赖 | `QuanSun/EVA-CLIP` | ~1GB | `clip_vision/` | PuLID 必需 |
| 5 | ACE-Step 1.5 | BGM/音乐生成 | `ace-studio/ace-step-base` 或新版 repo | ~7GB | `audio/` / 独立服务 | v1 3.5B 已存在，1.5 提升明显 |
| 6 | IPAdapter FaceID Plus v2 / Unified | 角色一致性备选 | `h94/IP-Adapter` | ~500MB | `ipadapter/` | 与 PuLID 互补 |

### P1：短剧全场景

| # | 类别 | 推荐 LoRA/模型 | 来源 | 数量 | 存放目录 |
|---|---|---|---|---|---|
| 1 | 古风场景 | ancient_chinese_room / hanfu / palace / wuxia / xianxia / tang_song_ming_qing | Civitai/HF | 5-8 | `loras/` |
| 2 | 现代都市 | modern_office / luxury_apartment / cafe / city_night / hospital / police_station / courtroom | Civitai/HF | 5-8 | `loras/` |
| 3 | 校园 | classroom / school_uniform / campus / playground / dorm / library | Civitai/HF | 5-8 | `loras/` |
| 4 | 豪车/商战 | luxury_car / sports_car / mansion / banquet / boardroom / private_jet / yacht | Civitai/HF | 5-8 | `loras/` |
| 5 | 特效 | magic_spell / explosion / sci_fi_glow / cyberpunk / mecha / martial_arts_qi / water_fire | Civitai/HF | 5-8 | `loras/` |
| 6 | 恐怖/惊悚 | horror / thriller / ghost / zombie / dark_fantasy | Civitai/HF | 3-5 | `loras/` |
| 7 | 喜剧/浪漫 | romcom / romantic / bright_comedy / wedding | Civitai/HF | 3-5 | `loras/` |
| 8 | 历史/战争 | ancient_war / military / wuxia_battle / medieval | Civitai/HF | 3-5 | `loras/` |
| 9 | 运镜 LoRA | dolly / pan / tilt / zoom / orbit / handheld / drone / static | Civitai/HF | 5-10 | `loras/` |
| 10 | 导演风格 LoRA | 特定导演色调/构图 | Civitai/HF | 3-5 | `loras/` |
| 11 | UVR5 | 人声/伴奏分离 | GitHub Release | ~5GB | 独立音频环境 | GUI/CLI 工具 |
| 12 | Demucs v4 | 音乐源分离 | `pip install demucs` | 首次自动下载 | 独立音频环境 | 代码分离 |
| 13 | MDX-Net | 人声分离备选 | `pip install mdx-net` | 首次自动下载 | 独立音频环境 | 与 UVR5/Demucs 互补 |

### P2：体验增强

| # | 模型/工具 | 用途 | 推荐下载源 | 预计大小 | 存放目录 |
|---|---|---|---|---|---|
| 1 | LivePortrait | 表情/姿态驱动肖像 | `KwaiVGI/LivePortrait` | ~1GB | `video_aux/` / 独立服务 |
| 2 | AnimateAnyone / MimicMotion | 全身姿态驱动 | `HumanAIGC/AnimateAnyone` / `tencent/MimicMotion` | ~1-2GB | `video_aux/` / 独立服务 |
| 3 | MuseTalk | 实时/高质量对口型 | `TMElyralab/MuseTalk` | ~1GB | `video_aux/` / 独立服务 |
| 4 | LatentSync | 口型同步 | `bytedance/LatentSync` | ~1GB | `video_aux/` / 独立服务 |
| 5 | Stable Audio Open 1.0 | 音效/短音频生成 | `stabilityai/stable-audio-open-1.0` | ~1GB | `audio/` / 独立服务 |
| 6 | AudioLDM 2 / FoleyCrafter | 音效生成 | `cvssp/audioldm2` / `foley-crafter` | ~1-2GB | `audio/` / 独立服务 |
| 7 | HunyuanVideo-Foley | AI 视频自动配音 | Tencent HunyuanVideo-Foley | 待确认 | `audio/` / 独立服务 |
| 8 | Apollo / ReSpeecher | 语音增强/降噪 | `apolloresearch/apollo` / ReSpeecher SDK | 待确认 | `audio/` / 独立服务 |
| 9 | IC-LoRA 训练数据集+基线 | 角色一致性训练 | 自定义 + `toiv-trainer/ai-toolkit` | - | `loras/` | 需自训 |
| 10 | LTX Director LoRA 训练 | 镜头语言训练 | 自定义 + `ai-toolkit` | - | `loras/` | 需自训 |

---

## 四、调研后建议补充的更优模型/新方向

### 4.1 图像生成：建议补充

| 模型 | 优势 | 推荐场景 | 备注 |
|---|---|---|---|
| **Qwen-Image 2.0** | 中文文字渲染、2k、1k token 长指令、编辑能力 | 海报/封面/带字图片/分镜首帧 | P0 必补，满血 7B 可跑 |
| **FLUX.1 [dev/schnell] + FLUX Tools** | Fill（局部重绘）、Redux（风格迁移）、Canny/Depth（Control） | 产品图、局部修复、风格迁移 | 与 FLUX.2 互补 |
| **Stable Diffusion 3.5 / 4** | 多比例、文字渲染提升 | 通用出图 | 需验证与现有生态兼容性 |
| **Kolors** | 中文理解、亚洲人像 | 中文海报、亚洲写实 | 字节开源 |
| **PixArt Sigma/Σ** | 高质量 2K、DiT 架构 | 高质量插画 | 与 FLUX 互补 |
| **Playground v3** | 美学质量高 | 艺术图、社交内容 | 需确认授权 |
| **NoobAI / Illustrious 新 Checkpoint** | 动漫/写实质量持续提升 | 二次元、NSFW | 保持跟进社区最新版 |

### 4.2 视频生成：建议补充

| 模型 | 优势 | 推荐场景 | 备注 |
|---|---|---|---|
| **LTX Video 2.0 / 2.3 22B 满血** | 更长视频、更高一致性 | 短剧主力 | 当前有 fp8，建议补满血 bf16 |
| **Wan 2.2 14B/21B 满血** | 运动幅度大、画质好 | 动作戏、大场面 | 当前 fp8，满血可进一步提升 |
| **HunyuanVideo-I2V** | 腾讯开源，图生视频质量高 | 写实短剧 | 已支持 I2V，建议补 |
| **HunyuanVideo-Foley** | 自动为视频配音效 | 后期自动配音 | 新方向 |
| **CogVideoX-5B/I2V** | 智谱开源，中文友好 | 中文短剧 | 可测试 |
| **Mochi 1** | Genmo 开源，画质电影感 | 高质量片段 | 显存要求高 |
| **Vchitect-2.0 / Open-Sora 2.0** | 开源长视频 | 长镜头 | 跟进社区 |
| **RIFE v4.26** | 插帧 | 25/30fps 补帧 | 当前已引用，确认存在即可 |

### 4.3 角色一致性：建议补充

| 工具 | 优势 | 推荐场景 | 备注 |
|---|---|---|---|
| **PuLID Flux** | 脸部特征保持最强 | 角色定妆、跨镜一致性 | P0 必补 |
| **IPAdapter FaceID Plus v2** | 成熟稳定、速度快 | 与 PuLID 组合使用 | 已有部分，补全 |
| **InstantID** | 单图换脸/角色固定 | 快速角色一致性 | 适合临时用 |
| **PhotoMaker v2** | 多张参考图堆叠角色 | 角色库构建 | 适合资产库 |
| **IC-LoRA** | 自训专属角色 LoRA | 核心角色长期复用 | 需训练 |
| **Consistory / StoryMaker** | 多图角色一致性 | 漫画/漫剧/连续分镜 | 新方向 |

### 4.4 音频：建议补充

| 模型 | 优势 | 推荐场景 | 备注 |
|---|---|---|---|
| **IndexTTS2** | 当前在用，WER 低 | 中文配音 | 已部署 |
| **F5-TTS** | 开源、速度快、音色克隆好 | 多语言配音 | 可替代/补充 IndexTTS2 |
| **CosyVoice 2** | 阿里开源，中文自然度高 | 中文旁白/对白 | 建议测试 |
| **Fish Speech 1.5** | 多语言、实时 | 轻量配音 | 可替代 edge-tts |
| **GPT-SoVITS v3** | 音色克隆强、社区生态大 | 角色音色克隆 | 建议部署 |
| **ACE-Step 1.5** | 音乐生成 S 级 | BGM/主题曲 | P0 必补 |
| **Stable Audio Open** | 音效/短音频 | 动作音效/环境音 | P2 补充 |
| **MMAudio** | 视频自动配乐 | 已有，继续用 | 已存在 |
| **UVR5 + Demucs + MDX-Net** | 人声/伴奏/音效分离 | 后期混音 | P1 必补 |
| **Apollo / ClearerVoice** | 降噪/增强 | 提升配音质量 | P2 |

---

## 五、给项目管家的执行矩阵

| 阶段 | 动作 | 预计耗时 | 阻塞项 |
|---|---|---|---|
| P0-1 | 下载 Qwen3-VL-7B-Instruct 满血 + Qwen-Image 2.0 | 2-4h | 网络、磁盘空间（约 30-50GB） |
| P0-2 | 下载 PuLID + EVA02-CLIP-L | 30min | - |
| P0-3 | 下载 ACE-Step 1.5 并部署独立服务 | 1-2h | 需要 conda/venv |
| P1-1 | 每类场景 LoRA 下载 3-5 个 | 2-4h | 需要 Civitai API token + versionId |
| P1-2 | 部署 UVR5 + Demucs 音频处理环境 | 1-2h | 需要 ffmpeg、conda |
| P2-1 | 部署 LivePortrait / MuseTalk / LatentSync 服务 | 2-4h | GPU 分配 |
| P2-2 | 部署 Stable Audio Open / AudioLDM 2 音效服务 | 1-2h | GPU/CPU 均可 |
| P2-3 | 准备 IC-LoRA / LTX Director LoRA 训练数据 | 数天 | 数据集质量决定效果 |

---

## 六、满血 vs 量化建议

| 模型 | 量化状态 | 建议 |
|---|---|---|
| Qwen3-VL 7B | 无量化单文件 | **跑满血 fp16**（~14GB），RTX 5090 / Mac Studio 24GB 可承受 |
| Qwen3-VL 30B/72B | 有量化也重 | 除非用 Spark 128GB HBM2e，否则不建议 |
| Qwen-Image 2.0 扩散模型 | 待确认 | 优先 7B/20B 版本，30B 以上需多卡 |
| FLUX.2 Dev | fp8 已可用 | 当前够用；如需极限质量可补 bf16 |
| Wan 2.2 14B | fp8 已可用 | 满血 bf16 在 RTX 5090 单卡可能吃紧，建议 fp8 继续 |
| LTX 2.3 22B | fp8 已可用 | 满血 bf16 约 44GB，需多卡或 HBM |
| PuLID | 通常 fp16 | 直接 fp16，不大 |

---

## 七、后续代码侧待完成

1. 模型下载完成后，更新 `model_profiles.py` 默认模型名与候选列表
2. 新增 Qwen-Image 2.0 工作流（nextgen.py 或独立文件）
3. 新增 PuLID 角色一致性工作流，扩展 `apps/api/app/workflows/ipadapter.py`
4. 新增 ACE-Step 1.5 音乐生成端点
5. 新增场景 LoRA 到 `style_presets.py`，并接入前端风格预设系统
6. 新增音频分离/增强/音效服务的路由
7. 集成 LivePortrait / MuseTalk / LatentSync 到短剧后期管线
8. 训练 IC-LoRA / LTX Director LoRA 并接入资产库
