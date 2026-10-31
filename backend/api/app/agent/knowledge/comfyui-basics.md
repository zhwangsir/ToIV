# ComfyUI 基础

## ComfyUI 是什么
ComfyUI 是一个基于节点(node)图的 AI 生成引擎。每个节点完成一步操作(加载模型、编码提示词、采样、解码、保存),节点之间用连线传递数据,组成一张工作流图(graph)。ToIV 平台底层就是由一个 ComfyUI 集群(4× RTX PRO 6000 + 5090)驱动的,用户无需懂节点,用自然语言即可生成。

## 工作流的 API 格式(prompt graph)
向 ComfyUI 提交任务用的是 "API 格式" JSON:一个对象,键是节点 id(字符串),值含 `class_type`(节点类型)和 `inputs`(该节点的输入)。`inputs` 里引用其它节点输出用 `["节点id", 输出序号]`。例如 `"positive": ["6", 0]` 表示取 6 号节点的第 0 个输出。提交后返回 `prompt_id`,产物在 history 的 outputs 里。

## 核心节点类型
- `CheckpointLoaderSimple`:加载大模型(checkpoint),输出 MODEL/CLIP/VAE。
- `CLIPTextEncode`:把文字提示词编码成条件(conditioning),需要 CLIP 输入。
- `EmptyLatentImage`:创建空白潜空间画布,定义宽高与批量。
- `KSampler`:核心采样器,输入 model/正负条件/latent,输出去噪后的 latent;参数 steps/cfg/sampler_name/scheduler/denoise/seed。
- `VAEDecode`:把 latent 解码成像素图。
- `SaveImage` / `SaveAnimatedWEBP` / `SaveAudioMP3`:保存图片/动图/音频。
- `LoadImage`:从 worker 的 input 目录读图(img2img、图生视频、图生3D 的输入)。
- `LoraLoaderModelOnly`:给模型叠加 LoRA。
- `VAEEncode`:把像素图编码回 latent(img2img 重绘用)。

## 多机异构调度
ToIV 的 worker 不一定都装了同样的模型。提交任务前,平台用 `pool.pick(required={模型文件名...})` 只挑选具备所需全部模型的 worker,避免任务路由到缺模型的机器。Wan 视频、Hunyuan3D 等大模型只在装了它们的节点上跑。
