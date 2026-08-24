# 模型详情目录（懂行版）

> 本文件在 platform-models.md 之上逐个展开,讲清每个模型「是什么 / 擅长什么 / 适合什么场景 / 怎么选」。
> 助手回答「用哪个模型」「这俩有啥区别」时,可据此给出有依据的推荐,不要编造平台没装的模型。

## 平台默认与选型总原则
平台文生图默认 `DreamShaper_8_pruned.safetensors`(SD1.5,泛用稳妥)。绝大多数普通出图需求用默认即可。
选模型先看三件事:① 画风(写实/二次元/插画)② 是否要中文文字 ③ 速度要求。
- 要写实人像 → majicMIX realistic;要二次元/动漫 → Illustrious 系;要海报带中文字 → Qwen-Image;要极速预览 → Z-Image Turbo。
- 新架构(Qwen-Image / Flux.2 / Z-Image)与 SD1.5 的提示词写法、推荐尺寸、采样参数不同,换模型时一并调整(见 parameter-reference.md)。

## DreamShaper 8(SD1.5,平台默认)
- 是什么:基于 SD1.5 微调的通用大模型,综合素质均衡。
- 擅长:写实、半写实、插画、概念图都能画,几乎不挑题材,失败率低。
- 适合场景:不确定该选什么时的万能首选;批量出图打底;漫剧分镜的稳妥底模。
- 怎么选:英文提示词、512 系尺寸、cfg 7 / euler / normal / 20 步就有稳定效果。

## majicMIX realistic v7(SD1.5)
- 是什么:SD1.5 写实人像专精模型。
- 擅长:亚洲面孔写实人像、皮肤质感、棚拍/生活照风格。
- 适合场景:证件照风、写真、角色写实化、电商人像。
- 怎么选:写实人像第一选择;加 `photorealistic, 85mm, soft lighting, detailed skin` 类词;负面词补 `bad hands, deformed face`。

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

## Z-Image Base(新架构,质量档)
- 是什么:Z-Image 的非蒸馏底座(`z_image_bf16`),与 Turbo 是两个族。
- 擅长:更高画质上限,真 CFG 有效(cfg≈4/30 步/负向提示词有效);也是训 Z-Image LoRA 的正确底座。
- 怎么选:定稿质量图选 Base,极速草稿选 Turbo;两者采样参数互不通用,别拿 Turbo 的参数套 Base。

## Qwen-Image-Edit 2509/2511(智能编辑/3D 相机)
- 是什么:Qwen-Image 的编辑专用模型(纯编辑,不能文生图),专用实例 :8194,引擎 id `qwen-image-edit`。
- 擅长:自然语言语义编辑(改颜色/加物件/换风格,保留其余部分);多角度相机预设(旋转/俯视/特写);2511 + Multiple-Angles LoRA 做真 360° 机位(azimuth 8 方位 × elevation 4 俯仰 × distance 3 距离)。
- 怎么选:「把这张图改成…」「换个角度拍这张」选它;它吃的是**编辑指令**(改什么、改成什么、保留什么),不是画面描述,不要堆画质词;风景类主体的相机旋转效果差(LoRA 数据分布限制),人物/物品主体优秀。

## 视频模型
### MiniMax H3(平台视频主力,音画同出)
- 是什么:MiniMax 开源的新一代视频模型(海螺同系),专用实例 :8195,引擎 id `h3-t2v`/`h3-i2v`(R18 版 `h3-nsfw-*` 走同一实例)。
- 擅长:剧情连续性好的短片,**原生 32kHz 音画同出**(视频自带音轨);吃流畅自然语言长描述。
- 怎么选:对话里「做视频/做短片」默认选它;负面约束不可靠(写「不要 X」反而易出 X),一切要求改写成正向指令;固定 24fps、帧数 17n+5 网格、宽高 32 对齐(上限 1344×768);**单段约 15 分钟**,提交后把 job_id 和耗时预期告诉用户;超 15s 自动分段续写。

### LongCat-Video(长镜头)
- 是什么:美团开源长视频模型 13.6B,专用实例 :8197,引擎 id `longcat-t2v`/`longcat-i2v`/`longcat-continue`。
- 擅长:单镜头最长 ≈60 秒(961 帧@16fps),蒸馏 LoRA 低步数(默认 10)出片快;continue 可取上一段末帧续写,拼超长视频。
- 怎么选:要「长一点的一整段」选它;要音轨选 H3。

### Wan2.2 I2V 14B(平台视频兜底)
- 是什么:图生视频模型,high/low noise 双扩散 + lightx2v 4 步加速 LoRA;R18 配方走 `wan-nsfw-i2v`(Civitai 社区 LoRA 分侧叠加)。
- 擅长:让一张静态图「动起来」,连续、平滑的中小幅运动。
- 适合场景:H3 不可用时的兜底;R18 视频的另一主力(触发词必须原样置句首)。
- 实测设定:训练甜点 832×480,帧数 4n+1,单段上限 121 帧(≈7.5s@16fps),更长用末帧续写。

### Wan-Animate-2(动作迁移/视频换人)
- 是什么:Wan-AI 2026-08 开源的换代动作迁移模型,端到端 DiT 直吃驱动视频(无需 DWPose),专用实例 :8199,引擎 id `wan-animate-2`。
- 擅长:参考图角色按驱动视频的动作/表情表演,身份与表情迁移质量好;蒸馏版 10 步,数分钟出片。
- 怎么选:「让这张图里的人做这段视频的动作」选它;positive **只描述外观+背景,严禁动作/运镜词**(动作全由驱动视频决定),留空时后端自动 VLM 反推外观 caption。旧版 `wan-animate`(双轨骨骼)仍在 :8197 可用。

### Wan2.1-VACE(多参考图视频)
- 是什么:多参考图(1-4 张,+可选首尾帧)→ 一致性视频,与 LongCat 同实例(:8197),引擎 id `wan-vace`。
- 适合场景:角色/物体/场景多图参考的可控视频。

### SCoPE 运镜视频
- 是什么:腾讯 ARC 的相机运镜模型(首帧图 + 文本 + 相机轨迹预设 → 81 帧视频),独立服务 :9401,走路由 `/api/scope/generate`(未入引擎注册表,助手不可 submit)。
- 怎么选:要「镜头按固定轨迹运动」(环绕/推拉/摇移预设)选它;提示词只写画面内容+氛围+主体内运动,**严禁写运镜词**(轨迹预设负责运镜);**40 步约 19 分钟**,很慢,务必先管理用户预期。

### LTX Video
- 是什么:轻量快速的视频生成模型。SFW 的 LTX-2.5 已退役(2026-08-23);R18 保留 LTX 2.3 + 10Eros 底模(`ltx-nsfw-*`,仅 R18 上下文)。
- 适合场景:R18 短视频快速出片;SFW 视频一律走 H3/LongCat。

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
- 注意:原生 2.0 **只有几何没有纹理**(灰模);要彩色纹理需 2.1 all-in-one(未部署),先告知用户。

### IndexTTS 2.5(语音合成服务)
- 是什么:平台 TTS 服务(:9200),2026-08-24 起为 IndexTTS 2.5。
- 擅长:中/英/日/西/阿五语种语音克隆与合成;0.5–2.0 语速调节;情感文本控制(emo_text,如「开心地说」)。
- 怎么选:配音/台词走语音板块;**台词文本与情绪描述是直送引擎的内容,不要用提示词优化改写它们**。

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

