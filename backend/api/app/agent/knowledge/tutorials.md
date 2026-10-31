# 上手教程（懂行地教用户创作）

> 面向「教学/辅助」场景:用户问「怎么出好图」「文生视频和图生视频怎么选」「漫剧怎么做」时,
> 助手据此给出可操作的步骤。参数细节见 parameter-reference.md,模型选择见 model-catalog.md。

## 写好提示词（正向）
好提示词的骨架:**主体 + 细节 + 风格 + 构图/光影 + 质量词**。
- 例:`a red fox sitting on a snowy hill, fluffy fur, golden hour backlight, cinematic composition, highly detailed, 4k`。
- 把最重要的主体放最前(权重更高);用逗号分隔短语,别写大段散文。
- 风格词举例:写实 `photorealistic, 85mm, depth of field`;二次元 `anime style, cel shading`;插画 `flat illustration, concept art`;氛围 `cyberpunk, neon, dark fantasy`。
- 质量词:`high quality, detailed, sharp focus, 4k`。
- SD1.5 系英文最敏感;中文需求由助手转成结构化英文再出图。要画面里有中文字 → 改用 Qwen-Image,此时直接写出要出现的中文。

## 写好负向提示词
- 排除不想要的:`blurry, lowres, deformed, extra fingers, bad anatomy, watermark, text, jpeg artifacts`。
- 人像加:`bad hands, extra limbs, fused fingers, bad face`。
- 平台已内置一套默认负面词(`blurry, lowres, deformed, watermark`),用户不写也有兜底;有特定问题再针对性补。

## 出好图的方法（流程）
1. 先用默认模型 + 默认参数(20 步 / cfg 7 / euler / normal)出一版看构图。
2. 不满意构图 → 一次出 4 张(batch_size=4)挑一张顺眼的,记下它的 seed。
3. 固定 seed,微调提示词/负面词/cfg,逐步逼近。
4. 满意后想要更精细 → 提到 30 步,或换更对口的模型(写实换 majicMIX、二次元换 Illustrious)。
5. 要更大尺寸:别直接拉到 1024+(SD1.5 易崩),先出 512 系好图,再用 img2img(denoise 0.3–0.4)放大精修。
6. 局部有瑕疵(脸/手)→ 自定义工作流里用 Impact 的 FaceDetailer 类节点局部重绘。

## 文生视频 vs 图生视频,怎么选
平台的「文生视频」本质是 **先文生底图 → Wan 2.2 I2V 驱动运动**,所以两者底层都靠 I2V:
- **只有文字想法、还没有图** → 用 generate_video(文生视频):一步到位,平台自动先出底图再动。
- **已经有一张满意的图(或刚出的图)想让它动** → 用「图生视频」:把那张图作为首帧,运动更可控、首帧可定稿。
- 建议:对画面要求高时,先反复出图定好首帧,再图生视频;只想快速看个动态草稿时,直接文生视频。
- 运动描述要「连续、温和」:`slow pan, gentle wind, drifting, subtle motion`;4 步加速下避免剧烈/多主体复杂运动。
- 时长:对话内 1–7.5 秒;默认约 3 秒(640×480,16fps)。

## 漫剧工作流（剧本 → 分镜 → 角色一致性 → 图生视频 → 配音）
平台有「漫剧工作室」,标准流程:
1. **剧本/分镜**:把剧情(premise)+ 镜头数 + 画风 + 角色丢给分镜接口,LLM 拆成结构化分镜 shots[]:每镜含英文出图提示词、出场角色、运镜、中文台词、建议时长(2–6 秒)。镜头数 1–24。
2. **逐镜出图**:用每镜的英文提示词出图。画风统一(全用同一底模 + 同一组风格词),漫剧动漫风优先 Illustrious 系。
3. **角色一致性(关键难点)**:
   - 给每个角色固定一段外貌描述,每镜提示词都带上(发色/服装/特征)。
   - 进阶:用 IPAdapter 注入角色参考图的特征,跨镜头锁长相;用同一 seed 家族 + 固定风格词减少漂移。
   - 姿势/构图要精确 → 用 ControlNet(姿势/线稿/深度)控制每镜布局。
4. **图生视频**:把每张分镜图用 Wan I2V 变成动态镜头(按该镜运镜与时长);进阶可用 VACE 做更可控的运镜/局部编辑。
5. **配音/配乐**:旁白/台词配语音,背景用 ACE-Step 生成 BGM;给画面配环境音效用 MMAudio。
6. **合成**:按分镜顺序拼接镜头 + 台词 + 配乐成片。
要点:画风与角色锁定越早做越省事;一致性靠「固定描述 + IPAdapter/ControlNet + 固定 seed」三管齐下。

## 3D 生成（图生3D）
1. 准备/生成一张**主体居中、背景干净、单一物体**的图(背景杂乱会拖垮重建)。
2. 用 generate_3d:有上传图就直接转;没有就先按描述出底图再转。输出可旋转的 GLB。
3. 想更精细:octree_resolution 调到 384/512(更慢、面数更多);steps 提到 40–50。
4. 耗时较长(约 1–3 分钟,Hunyuan3D 偏慢),属正常。

## 音乐生成
1. 想清楚:**流派 + 主乐器 + 情绪 + BPM**,写进 tags,如 `lofi, chill, piano, 90bpm`。
2. 纯音乐留空 lyrics;要演唱就填歌词(可分主歌/副歌)。
3. 时长 seconds:片头/循环 BGM 用 15–30 秒,完整段落 60 秒+(越长越慢,上限 240 秒)。
4. 不满意:换更具体的 tags(加乐器/情绪/年代词)比反复重抽更有效。

## 自定义工作流（进阶,run_workflow）
- 当标准工具(generate_image/video/music)满足不了(要指定 seed/批量/特定模型/特殊节点组合)时,用 run_workflow 提交 ComfyUI **API 格式** 图。
- 搭图前**先 search_knowledge** 查配方与真实模型名,别编造模型/节点。模板见 workflow-recipes.md。
- 图里必须含一个 Save 类节点(SaveImage / SaveAnimatedWEBP / SaveAudioMP3 / SaveGLB),否则没产物。
- 所用模型文件名必须真实存在于某 worker(可先 list_models 查 checkpoint)。
