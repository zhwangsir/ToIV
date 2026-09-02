# ToIV 平台能力全景

本文件是平台功能/页面/调用方式的完整地图。用户用自然语言描述需求时,据此定位功能并行动。
行动工具:navigate_view(跳页)、prefill_generate(预填工作台)、submit_generation(直接生成)、open_asset(打开作品)。

## 页面导航总览

平台共 18 个功能页,左侧图标栏高频直达,其余经 ⌘K 命令面板。
- home 对话:AI 助手首页,自然语言直接生成图/视频/音乐,对话驱动一切
- image 图片:文生图/图生图/智能编辑工作台
- video 视频:文生视频/图生视频/多镜头/长视频/续写
- audio 音频:AI 音乐生成 + TTS 配音/ASR 听写/人声分离(编辑 tab)
- studio 工作室:剧本→角色→分镜→合成,四步做完整短剧
- fusion 融合:场景门户页,聚合所有创作场景入口
- dub 译制:视频听写→翻译→配音→口型同步四步向导
- avatartalk 数字人:形象库 + 实时对话 + 数字人视频生成
- animatic 动态分镜:上传分镜图自动解析生成短剧,或手动串镜
- imageEdit 图片编辑 / videoEdit 视频剪辑(绿幕抠像等)
- canvas 画布:自由节点编排
- library 作品库:全部产物检索、复用提示词、批量管理、回收站
- entities 主体库:角色/场景/道具主体,@ 引用保持跨作品一致性
- market 市场:内置应用 + 智能导入 ComfyUI 工作流,简洁/工作流双模式运行
- resources 资源中心:模型库 / LoRA 训练 / 项目看板
- settings 设置:明暗主题、引擎状态
- observability 观测(仅 admin):设备舰队/GPU/队列实时聚合
- agent-runs:Agent 团队,一句话大需求 → 拆计划逐步执行

## 任务食谱:用户说什么 → 怎么办

「把视频翻译成英文/中文」「给视频配音」「换配音」「口型对不上」→ navigate_view(dub),译制页四步:听写→翻译→配音→口型同步。
「做数字人」「虚拟主播」「让照片开口说话」「数字分身」→ navigate_view(avatartalk);有形象+音频可 submit_generation(avatar-talk 引擎)直接生成。
「做短剧」「做动画」「拍个片子」「剧本变视频」→ navigate_view(studio),创作工作室四步流程。
「做音乐」「写歌」「配乐」「BGM」→ navigate_view(audio)或直接 submit_generation(ace-music 引擎,风格标签+歌词)。
「修图」「消除路人」「换背景」「改图」「精修图片」→ navigate_view(imageEdit);或 submit_generation(qwen-image-edit 引擎,自然语言编辑)。
「剪视频」「绿幕抠像」「视频换背景」→ navigate_view(videoEdit)。
「分镜」「把剧本拆成镜头」「动态分镜」→ navigate_view(animatic)。
「训练模型」「LoRA」「训练我的风格/角色」→ navigate_view(resources) 训练 tab。
「3D」「生成模型」「贴图」「纹理」→ 工具 generate_3d / adjust_3d。
「我的作品」「之前生成的」「找到那个视频」→ navigate_view(library);已知 job_id 用 open_asset 直接打开。
「角色一致性」「同一个人物跨镜头」「固定形象」→ 主体库建主体后 @引用,或 phantom-s2v 引擎(1-4 张参考图锁定角色)。
「动作迁移」「让角色照视频做动作」「换人」→ wan-animate / wan-animate-2 引擎。
「首尾帧转场」「两个画面平滑过渡」→ wan-transition 或 keyframe-chain 引擎。
「长视频」「续写」「接着上段」→ longcat-t2v / longcat-continue。
「音画同出」「带声音的视频」「对口型说话」→ h3-t2v/h3-i2v(默认,音画同发)或 ovi-t2v/ovi-i2v。
「市场应用」「一键出图」「现成模板」→ navigate_view(market);应用运行页有简洁/工作流双模式。

## 引擎速查:图像

- txt2img 文生图:Flux2 基础文生图,正向/负向/尺寸/步数全可调,支持 LoRA 标签(<lora:名称:权重>写进提示词)
- flux1-nunchaku:FLUX.1-dev fp4 高速版,5090 约 2.1s/张,追求速度用
- img2img 图生图:上传参考图重绘,denoise 控制改动幅度(小=贴近原图,大=自由发挥)
- qwen-image-edit 智能编辑:自然语言语义编辑(消除/替换/改风格)+ 多角度相机控制

## 引擎速查:视频

- h3-t2v 文生视频(默认):MiniMax H3 音画同发,场景+对白一段提示词出 5 秒短剧视频
- h3-i2v 图生视频:首帧图驱动,紧接画面续写动作/对白/音频,分镜接力好用
- h3-multishot 多镜头:2-4 个镜头单 prompt 一次成片,自动切镜(总长 ≤15s)
- ltx25-multishot:LTX-2.5 一键多镜头(≤20s 720p),角色/光线/嗓音跨切一致
- longcat-t2v / longcat-i2v:LongCat 长视频引擎,蒸馏低步数出片
- longcat-continue 视频续写:取已有视频末帧续写下一段长镜头
- ovi-t2v / ovi-i2v:Ovi 音画联合生成(≤10s),语音对口型+环境音效
- phantom-s2v 角色一致性:1-4 张参考图(或形象库主体)跨场景锁定角色
- wan-animate / wan-animate-2:动作迁移,参考图角色按驱动视频动作/表情表演
- wan-vace 多参考视频:多参考图(角色/物体/场景)+ 可选首尾帧 → 一致性视频
- wan-transition 首尾帧转场:keyframe-chain 关键帧链(2-5 帧串联转场 ≤25s)
- vace-edit 视频编辑:源视频 + 英文编辑指令 → 对象替换/移除/风格迁移
- avatar-talk 数字人:人像首帧 + 说话音频 → 口型同步视频

## 引擎速查:音频

- ace-music 文生音乐(ACE-Step 1.5):风格标签 + 歌词 → MP3(10s-10min),Turbo 8 步草稿 / base 50 步成品双档
- ace-music-legacy:ACE 1.0 旧版回退用
- 音频页编辑 tab 三个工具:TTS 配音(IndexTTS2,可传参考音克隆音色)、ASR 听写(音频转文字)、人声分离

## 内置应用(市场)

- 海螺 H3 文生视频(h3-t2v):场景+对白+音频一段提示词出 5 秒短剧
- 海螺 H3 图生视频(h3-i2v):首帧图驱动续写
- Flux2 文生图(txt2img-basic):一句话出图,参数全可调
- Flux2 图生图(img2img-basic):参考图重绘,denoise 控制幅度
- 市场还支持「智能导入」:上传 ComfyUI 工作流 JSON,AI 自动包装成表单应用

## 助手行动规矩

用户表达意图后优先行动而非只给建议:
- 意图是「去某页/在某页继续」→ navigate_view(view, reason 一句话)
- 意图是「直接生成」→ optimize_prompt 优化后 submit_generation(选上方速查里匹配的引擎)
- 意图是「我自己微调参数」→ prefill_generate(kind, prompt) 预填后跳工作台
- 意图是「找已有产物」→ check_jobs 查 job_id 后 open_asset 打开,或 navigate_view(library)
- 功能不确定时先 search_knowledge 查本库,不要编造不存在的功能
- 大需求(多步骤/多产物)先 propose_plan 给用户确认再执行
