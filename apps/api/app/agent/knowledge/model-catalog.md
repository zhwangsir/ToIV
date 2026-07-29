# 模型详情目录（懂行版）

> 本文件在 platform-models.md 之上逐个展开,讲清每个模型「是什么 / 擅长什么 / 适合什么场景 / 怎么选」。
> 助手回答「用哪个模型」「这俩有啥区别」时,可据此给出有依据的推荐,不要编造平台没装的模型。

## 平台默认与选型总原则
平台文生图默认 `DreamShaper_8_pruned.safetensors`(SD1.5,泛用稳妥)。绝大多数普通出图需求用默认即可。
选模型先看三件事:① 画风(写实/二次元/插画)② 是否要中文文字 ③ 速度要求。
- 要写实人像 → majicMIX realistic;要二次元/动漫 → Illustrious 系或 GhostMix;要海报带中文字 → Qwen-Image;要极速预览 → Z-Image Turbo。
- 新架构(Qwen-Image / Flux.2 / Z-Image)与 SD1.5 的提示词写法、推荐尺寸、采样参数不同,换模型时一并调整(见 parameter-reference.md)。

## DreamShaper 8(SD1.5,平台默认)
- 是什么:基于 SD1.5 微调的通用大模型,综合素质均衡。
- 擅长:写实、半写实、插画、概念图都能画,几乎不挑题材,失败率低。
- 适合场景:不确定该选什么时的万能首选;批量出图打底;漫剧分镜的稳妥底模。
- 怎么选:英文提示词、512 系尺寸、cfg 7 / euler / normal / 20 步就有稳定效果。

## GhostMix V2(SD1.5)
- 是什么:SD1.5 系融合模型,偏精致插画/半二次元。
- 擅长:角色立绘、唯美插画、光影通透的画面。
- 适合场景:想要比 DreamShaper 更「好看」「插画感」的人物图。
- 怎么选:与 DreamShaper 同套参数;人物题材优先,纯写实场景不如 majicMIX。

## majicMIX realistic v7(SD1.5)
- 是什么:SD1.5 写实人像专精模型。
- 擅长:亚洲面孔写实人像、皮肤质感、棚拍/生活照风格。
- 适合场景:证件照风、写真、角色写实化、电商人像。
- 怎么选:写实人像第一选择;加 `photorealistic, 85mm, soft lighting, detailed skin` 类词;负面词补 `bad hands, deformed face`。

## v1-5 基础模型(SD1.5 原版)
- 是什么:Stable Diffusion 1.5 官方原版,未做风格微调。
- 擅长:作为对照基线、做 ControlNet/LoRA 兼容性验证。
- 适合场景:一般不直接用于成品出图(风格偏「素」),更多是技术基线。
- 怎么选:除非要纯净基底,否则优先用 DreamShaper 等微调版。

## Illustrious 系(动漫/二次元)
- 是什么:面向动漫/插画的二次元大模型家族。
- 擅长:高质量动漫角色、立绘、同人风,擅长 danbooru 风格标签提示词。
- 适合场景:二次元角色、漫剧的动漫画风分镜、ACG 海报。
- 怎么选:二次元题材优先用它而非 SD1.5 写实模型;提示词倾向用标签式(`1girl, long hair, school uniform, ...`)。

## Qwen-Image(fp8,新架构)
- 是什么:阿里通义的图像生成模型,非 SD1.5 架构。
- 擅长:中文文字渲染(海报标语/招牌/书法),对中文语义理解好。
- 适合场景:带中文字的海报/封面/电商图、需要画面里出现准确中文的场合。
- 怎么选:凡是「画面里要有中文字」就选它;此时提示词可直接用中文描述要出现的文字内容。配套有 Qwen-Image InstantX Union ControlNet 做构图控制。

## Flux.2 Klein 4B(新架构)
- 是什么:Flux 系列的轻量蒸馏版(4B),新一代 DiT 架构。
- 擅长:画面结构合理、出图质量高、对自然语言长句理解好。
- 适合场景:追求构图与质感、愿意用更自然的英文长句描述时。
- 怎么选:与 SD1.5 参数不通用(Flux 通常低 cfg、少步数);要更现代的画面质感时考虑它。

## Z-Image Turbo(新架构,极速)
- 是什么:蒸馏加速的极速出图模型。
- 擅长:几步(常 4–8 步)就出图,速度极快。
- 适合场景:快速预览、批量草图、交互式反复试构图。
- 怎么选:要「快」就选它;定稿再换质量更高的模型重画。注意它步数/ cfg 取值远低于 SD1.5。

## 视频模型
### Wan 2.2 I2V 14B(平台视频主力)
- 是什么:图生视频模型,high/low noise 双扩散 + lightx2v 4 步加速 LoRA。
- 擅长:让一张静态图「动起来」,连续、平滑的中小幅运动。
- 适合场景:平台「文生视频」= 先文生底图再用 Wan 驱动其运动;漫剧把分镜图变成动态镜头。
- 实测设定:默认 640×480、49 帧、16fps(约 3 秒),输出 SaveAnimatedWEBP 动图;4 步加速下避免要求剧烈复杂运动。
- 怎么选:平台对话内生成视频走的就是它;要更长用 length(9–121 帧,须 4n+1)。

### Wan 2.2 T2V(文生视频)
- 是什么:Wan 的文本直出视频分支(不需先给图)。
- 擅长:纯文本到视频。平台当前对话链路用的是「先出图→ I2V」,T2V 作为可选能力存在。
- 怎么选:需要纯文生视频且节点装了 T2V 时用;否则走平台默认的 I2V 链路更可控(首帧可先定稿)。

### LTX Video
- 是什么:轻量快速的视频生成模型。
- 擅长:速度快、显存友好,适合短片段快速预览。
- 适合场景:对画质要求不极致、要快出动态草稿时。
- 怎么选:Wan 偏质量、LTX 偏速度;需要快迭代镜头时考虑 LTX。

### FramePack
- 是什么:面向「长视频」的帧打包/续推技术,降低长序列显存占用。
- 擅长:在有限显存下生成更长的连续视频。
- 适合场景:需要明显超过几秒的长镜头时。
- 怎么选:常规 3 秒内镜头用 Wan I2V 即可;要长镜头再考虑 FramePack 类方案。

## 音频模型
### ACE-Step v1 3.5B(文生音乐,平台主力)
- 是什么:文生音乐模型,输入风格标签 tags(可选歌词 lyrics),输出 MP3(44.1kHz 立体声)。
- 擅长:按流派/乐器/情绪/BPM 标签生成成段音乐;给歌词可生成带演唱的歌曲。
- 适合场景:BGM、片头曲、漫剧配乐、氛围音乐。
- 实测设定:默认 30 秒、50 步、cfg 5、euler/simple;时长范围 5–240 秒。
- 怎么选:平台对话内「生成音乐」就是它;纯音乐留空 lyrics,要唱就填 lyrics。

### MMAudio
- 是什么:面向「视频配音/音效」的音频生成模型(给画面配匹配的声音)。
- 擅长:根据视频内容生成同步音效/环境声。
- 适合场景:给生成的视频/漫剧镜头补环境音、拟音。
- 怎么选:要「给画面配声」用 MMAudio;要「独立成段的音乐」用 ACE-Step。

## 3D 模型
### Hunyuan3D DiT v2.0(图生3D,平台主力)
- 是什么:腾讯混元图生 3D 模型(`hunyuan3d-dit-v2-0-fp16.safetensors`),输入一张图,输出 3D 网格(GLB)。
- 擅长:把单图主体重建成可旋转查看的 3D 模型。
- 适合场景:手办/道具/物件的快速 3D 化,游戏/展示用 mesh 初稿。
- 实测设定:默认 30 步、cfg 5、octree_resolution 256;耗时较长(约 1–3 分钟)。
- 怎么选:平台 3D 走它;输入图最好是主体居中、背景干净、单一物体的图,效果最好。

## 漫剧工具链(辅助节点/模型)
这些不是「出图大模型」,而是控制与增强用的工具,常见于自定义工作流和漫剧流程:
- IPAdapter:把参考图的「风格/人物特征」注入生成,用于角色一致性(同一角色跨镜头长相稳定)。
- ControlNet(平台有 Qwen-Image InstantX Union):用线稿/姿势/深度/边缘等控制构图与姿态,做精确分镜。
- VACE(Wan 生态):视频编辑/可控生成,支持参考引导的视频生成与局部编辑,做可控运镜。
- Florence2:图像理解/打标(caption、检测),自动给参考图生成提示词、辅助分镜描述。
- Impact Pack:检测+局部重绘工具集(如脸部细化 FaceDetailer),修脸、修手、局部精修。
- 深度:lotus-depth(出深度图,喂给 ControlNet 做构图控制)。
- LoRA:lightx2v 4 步加速(给 Wan 视频提速,平台视频默认就挂了它)。

> 提示:部分 checkpoint/LoRA 含成人内容(NSFW),按需使用,默认不主动推荐。

---

## 待部署/新选型模型(P0/P1/P2)

以下模型/工具已整理进 `deploy/download_models.sh`，需项目管家按优先级下载到 worker/NAS。

### Qwen-Image 2.0(P0)
- 是什么:阿里通义新一代图像生成及编辑模型，支持长文本提示与复杂图文排版。
- 文本编码器:Qwen3-VL-7B-Instruct 满血(~14GB fp16)。
- 为何满血:Comfy-Org 尚未发布 Qwen3-VL 量化单文件，7B 满血在 RTX 5090 / Mac Studio 24GB 可跑。
- 显存策略:文本编码器与扩散模型分不同 GPU 加载，避免单卡 24GB 吃满。
- 文件:下载 `Qwen/Qwen3-VL-7B-Instruct` 到 `text_encoders/qwen_3_vl_7b_instruct/`，或转换为单文件 `qwen_3_vl_7b.safetensors`。

### PuLID Flux v0.9.0(P0)
- 是什么:比 IPAdapter FaceID 更强的角色一致性工具，保持同一演员/角色跨镜头面孔、气质稳定。
- 依赖:FLUX.2 dev 底模 + EVA02-CLIP-L 视觉编码器。
- 文件:`guozinan/PuLID` 的 `pulid_flux_v0.9.0.safetensors` 放 `pulid/`，`EVA02_CLIP_L_336_psz14_s6B.pt` 放 `clip_vision/`。
- 适合场景:短剧角色定妆、三视图一致性、跨分镜换角度不换脸。

### ACE-Step 1.5(P0)
- 是什么:ACE Studio 与阶跃星辰开源的文生音乐模型，生成 BGM/主题曲/氛围音乐。
- 文件:`ace-studio/ace-step-base`(如 1.5 有新 repo 则替换)。
- 部署:建议独立 conda/venv 服务，通过环境变量 `ACE_STEP_MODEL_DIR` 指向模型路径。
- 适合场景:短剧 BGM、片头片尾、情绪配乐。

### 短剧场景 LoRA(P1)
按题材分类，每类先下 3 个即可跑通预设系统:
- 古风:`ancient_chinese_room`、`hanfu`、`palace`、`wuxia`、`xianxia`
- 现代:`modern_office`、`luxury_apartment`、`cafe`、`city_night`、`corporate`
- 校园:`classroom`、`school_uniform`、`campus`、`playground`、`youth`
- 豪车/商战:`luxury_car`、`sports_car`、`mansion`、`banquet`、`business_meeting`
- 特效:`magic_spell`、`explosion`、`sci_fi_glow`、`ink_wash`、`lightning`
- 下载方式:Civitai 需 API token + versionId，脚本已预留 `CIVITAI_VERSION_IDS` 环境变量。

### UVR5 + Demucs(P1)
- UVR5:人声/伴奏/鼓点/贝斯分离 GUI/CLI 工具。
- Demucs:Meta 开源音乐源分离模型，`pip install -U demucs` 即可使用。
- 用途:短剧后期提取干净人声、去除背景杂音、分离 BGM 做 ducking。
- 部署:建议在 workstation 独立音频处理 conda 环境，暴露 REST API 供 ToIV 调用。

### LivePortrait(P2)
- 是什么:快手开源表情/姿态驱动肖像视频生成工具。
- 用途:让短剧角色按参考视频做表情、转头、眨眼，提升表演生动度。
- 文件:`KwaiVGI/LivePortrait`。
- 部署:独立服务，GPU 建议 RTX 4090/5090 或 Mac Studio。

### Stable Audio Open(P2)
- 是什么:Stability AI 开源音效/短音频生成模型。
- 用途:生成环境音、动作音效、转场音效，补全 MMAudio 的独立音效能力。
- 文件:`stabilityai/stable-audio-open-1.0`。
- 部署:独立 conda 服务。

### 自训 LoRA(P2)
- IC-LoRA:角色一致性 LoRA，需准备同一角色多角度图数据集。
- LTX Director LoRA:镜头运动 LoRA，需准备平移/推拉/环绕等视频片段数据集。
- 训练框架:`toiv-trainer/ai-toolkit` 或 kohya-ss。
- 用途:专属角色固定脸、专属导演镜头语言。

