# LongCat-Video-Avatar 评估报告(音频驱动数字人长视频引擎)

> **日期**:2026-08-08
> **范围**:评估美团 LongCat-Video-Avatar(重点 1.5 版)作为 ToIV「分钟级口播长视频」离线引擎的可行性;纯调研,未改动任何项目代码
> **结论**:**建议引入**。与 FlashTalk(实时对话)互补不替代;ComfyUI 部署路径与已落地的 LongCat-Video(:8197 实例)完全同构,增量成本只是权重下载 + 2 个插件节点;GPU2 fp8 方案常态可与 H3 突发共存

---

## 〇、TL;DR

| 问题 | 结论 |
|------|------|
| 模型是否成熟可用 | ✅ v1.5(2026-05-21 发布)是「商业级」定位的开源数字人模型,官方人评对标 HeyGen/Kling Avatar 2.0 打平或胜出 |
| 能否商用 | ✅ **MIT 协议**(权重+代码),无商用限制 |
| 能否复用已下载的 LongCat-Video 权重 | ⚠️ **DiT 不能复用**(Avatar 是带音频条件的独立微调权重,31.7GB bf16);**文本编码器(umt5-xxl)和 VAE(Wan2.1)可复用**,已在 NAS |
| ComfyUI 支持 | ✅ kijai WanVideoWrapper **main 分支已原生支持 Avatar 1.5**(专用 Whisper 嵌入节点 + 长视频段间续写节点),与现有 :8197 实例同栈 |
| 显存需求 | fp8/GGUF DiT ~14-17GB + Whisper 3GB + umt5 7GB,480p 采样峰值 ~30GB;**GPU2 96GB 可常驻,且与 H3 突发(48GB)共存** |
| 与 FlashTalk 关系 | **互补**:FlashTalk 实时流式对话(GPU3),Avatar 离线渲染分钟级口播成片;不互相替代 |
| 落地判断 | **建议引入**,按 P0 权重下载 → P1 冒烟 → P2 接 core API 三阶段走,复用 LongCat 已趟平的全部基础设施 |

---

## 一、模型本体

### 1.1 发布与仓库

| 项 | 值 | 来源 |
|---|---|---|
| 团队 | 美团 LongCat 团队(与 LongCat-Video、InfiniteTalk 同源) | [GitHub](https://github.com/meituan-longcat/LongCat-Video) |
| v1.0 发布 | 2025-12-16,wav2vec2 音频编码器 | [GitHub Latest News](https://github.com/meituan-longcat/LongCat-Video) |
| **v1.5 发布** | **2026-05-21**,Whisper-Large-v3 编码器 + 8 步蒸馏 + INT8 量化 | [GitHub](https://github.com/meituan-longcat/LongCat-Video) / [美团技术团队博客](https://tech.meituan.com/2026/05/25/LongCat-Video-Avatar-1.5.html) |
| 代码仓库 | github.com/meituan-longcat/LongCat-Video(与基座同仓库,`run_demo_avatar_*.py`) | 同上 |
| HF 权重 | [meituan-longcat/LongCat-Video-Avatar](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar)(v1.0)、[meituan-longcat/LongCat-Video-Avatar-1.5](https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5) | HF API 实测 |
| ModelScope | 官方权重与 GGUF 均有镜像(GGUF 仓库 vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI 已确认在 ModelScope,可走高速直链) | [ModelScope](https://modelscope.cn/models/vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI) |
| 技术报告 | [arXiv:2605.26486](https://arxiv.org/abs/2605.26486)(2026-05-26) | arXiv |
| **许可证** | **MIT(权重与代码同)**,可商用;个别二手文章写「学术用途」系误读,以官方模型卡为准 | [HF 模型卡 License 段](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5) |

### 1.2 权重清单(v1.5,HF API 实测文件大小)

官方 diffusers 布局(meituan-longcat/LongCat-Video-Avatar-1.5):

| 文件 | 大小 | 说明 |
|---|---|---|
| `base_model/`(DiT bf16,6 shards) | **31.7 GB** | 13.6B DiT + 音频条件投影层;**与 TI2V 底座是不同的微调权重,不能复用已下载的 15.5GB fp8 TI2V** |
| `base_model_int8/`(4 shards) | **15.9 GB** | 官方 INT8 量化 DiT,仅 v1.5 支持(`--use_int8`) |
| `lora/dmd_lora.safetensors` | 2.52 GB | DMD2 蒸馏 LoRA,8 步推理必需 |
| `whisper-large-v3/model.safetensors` | 3.09 GB | 音频编码器 |
| `vocal_separator/Kim_Vocal_2.onnx` | 0.07 GB | 人声分离(去背景音,稳唇形) |
| 文本编码器 / VAE | **不含** | 复用 LongCat-Video 基座的 umt5-xxl + Wan2.1 VAE —— **NAS 已有**(umt5 fp8 6.73GB、Wan2_1_VAE_bf16 0.25GB) |

ComfyUI 单文件路线:

| 来源 | 文件 | 大小 | 备注 |
|---|---|---|---|
| Kijai/WanVideo_comfy | `LongCat/LongCat-Avatar-15_bf16.safetensors` | 31.71 GB | 官方 bf16 的单文件封装 |
| Kijai/WanVideo_comfy | `LongCat/LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors` | **1.26 GB** | v1.5 蒸馏 LoRA(⚠️ 与 v1.0 的 LoRA 不同文件) |
| vantagewithai GGUF(社区,12.7k 下载) | Q2_K 8.3GB ~ Q8_0 19.1GB,共 12 档 | Q5_K_M 13.7GB / Q6_K 15.5GB | WanVideoWrapper 直接加载;ModelScope 有镜像 |
| ⚠️ Kijai/LongCat-Video_comfy 的 `Avatar/` 目录 | fp8 16.9GB / bf16 31.75GB | 2025-12-22 更新,**是 v1.0(wav2vec2)权重,不要下错** | HF API lastModified 实测 |

---

## 二、技术架构

| 维度 | 结论 | 来源 |
|---|---|---|
| 底座 | LongCat-Video 13.6B DiT 同一架构,但 Avatar DiT 是带音频条件(AudioProjModel)的独立微调权重,参数量略增 | [HF 模型卡](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5) |
| 音频驱动 | v1.5 = **Whisper-Large-v3**(取 5 个分组层、1280 维 hidden state),替换 v1.0 的 wav2vec2;唇形同步显著更准 | [WanVideoWrapper LongCat/nodes.py](https://github.com/kijai/ComfyUI-WanVideoWrapper/blob/main/LongCat/nodes.py) / [GitHub](https://github.com/meituan-longcat/LongCat-Video) |
| 输入形式 | AT2V(音频+文本)、ATI2V(音频+文本+参考图)、音频驱动视频续写;单流/双流音频(双人对话,`para` 混音 / `add` 拼接模式) | [HF 模型卡](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5) |
| 帧率 | **训练在 25 fps**(Whisper 嵌入节点与导出必须同 fps,否则唇形漂移) | [ROCm 实测帖](https://github.com/ROCm/TheRock/discussions/5635) |
| 分辨率 | 480P / 720P(`--resolution`) | [HF 模型卡](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5) |
| 最长时长 | 分钟级:多段滚动推理(`--num_segments`,段间以参考帧+mask 维持一致性),官方定位即「long-video stability」 | [HF 模型卡](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5) / [arXiv](https://arxiv.org/abs/2605.26486) |
| 蒸馏 | DMD2 步数蒸馏,50 步 → **8 NFE**;官方称配合「共享底座+LoRA」替代三模型并行,推理效率提升约 15 倍,10 秒视频约 1 分钟(高端卡) | [arXiv](https://arxiv.org/abs/2605.26486) / [CSDN 转载官方稿](https://tianqi.csdn.net/6a139819662f9a54cb76cd33.html) |
| 风格泛化 | RLHF + 数据治理,真人/动漫/动物、多人互动、手持物品等复杂场景 | [arXiv](https://arxiv.org/abs/2605.26486) |

**与已部署 LongCat-Video 的权重复用关系**(关键):

- ❌ DiT 不能复用:Avatar DiT(31.7GB bf16)≠ TI2V DiT(27.2GB bf16 / 15.5GB fp8),音频交叉注意力层不同
- ✅ 可复用:umt5-xxl 文本编码器(fp8 6.73GB 已在 NAS)、Wan2.1 VAE(0.25GB 已在 NAS)、WanVideoWrapper/KJNodes/VHS 插件栈、:8197 实例与 core 接入模式(engine_registry + resolve_worker 精确匹配)

---

## 三、部署路径

### 3.1 官方推理

GitHub 同仓库 torchrun 脚本(`run_demo_avatar_single_audio_to_video.py` / `run_demo_avatar_multi_audio_to_video.py`),v1.5 必须 `--use_distill --model_type avatar-v1.5`,可选 `--use_int8`;依赖 torch 2.6+cu124、flash-attn 2.7.4、librosa。官方示例多用 `--context_parallel_size=2` 双卡,单卡可跑。[来源:GitHub README](https://github.com/meituan-longcat/LongCat-Video)

### 3.2 ComfyUI 路线(推荐,与现有 :8197 实例同构)

kijai **WanVideoWrapper main 分支已原生支持 Avatar 1.5**(API 实测 main 分支文件树):

- `LongCatAvatarWhisperEmbeds`(v1.5 Whisper 嵌入,内置 -23 LUFS 响度归一化)
- `WanVideoLongCatAvatarExtendEmbeds`(v1.5 段间续写:前段解码帧经 VAE 重编码做 overlap 条件,对应官方 `use_vcond=False` 行为)
- `WanVideoSamplerv2` + `WanVideoSchedulerv2`(longcat distill 调度)
- 示例工作流:`example_workflows/LongCatAvatar_audio_image_to_video_example_01.json`
- 人声分离插件 [ComfyUI-MelBandRoFormer](https://longcat-video.org/blog/longcat-avatar-comfyui-tutorial)(去 BGM,唇形更稳)——**:8197 实例尚未安装,需补**
- KJNodes(ImageBatchExtendWithOverlap)/ VHS **已装,直接复用**

来源:[runcomfy 官方工作流拆解](https://www.runcomfy.com/comfyui-workflows/longcat-video-avatar-1-5-single-character-comfyui-audio2video-sync) / [WanVideoWrapper 仓库](https://github.com/kijai/ComfyUI-WanVideoWrapper)

### 3.3 显存需求

| 方案 | DiT 体积 | 采样峰值(参考) | 备注 |
|---|---|---|---|
| GGUF Q5_K_M | 13.7GB | **~29-30GB**(480×832×81 帧,含 Whisper/umt5/VAE,AMD APU 统一内存实测) | [ROCm 实测](https://github.com/ROCm/TheRock/discussions/5635) |
| GGUF Q8_0 | 19.1GB | ~35GB(估) | 画质最稳档 |
| bf16 | 31.7GB | 24GB+ 起步(社区口径),720p 长视频需上下文窗口 | [aifilms 指南](https://studio.aifilms.ai/blog/longcat-video-avatar-guide-2026) |
| 官方 INT8 | 15.9GB | 官方脚本路线专用 | ComfyUI 路线用 GGUF 更顺手 |

**GPU2 预算结论**:GGUF Q6_K/Q8_0 常驻 ~25-35GB,加 ASR 5.3GB 常态 ~40GB;H3 突发 48GB 时合计 ~88GB < 98GB,**480p 口播可与 H3 共存**;720p 分钟级(需上下文窗口,峰值估 50-60GB)建议与 H3 互斥,复用现有错峰策略。

### 3.4 已知坑(社区实测)

1. **帧数必须 4n+1**(77/81/93/125…),否则首步 einops 维度错([ROCm 实测](https://github.com/ROCm/TheRock/discussions/5635))
2. **fps=25 全链路一致**(Whisper 嵌入节点与 VHS 导出),模型按 25fps 训练(同上)
3. GGUF 加载时 `merge_loras` 必须为 false,wrapper 会强制报错(同上)
4. 块交换在统一内存/低显存卡上会导致采样假死;96GB 卡建议直接 main_device,少量或不交换(同上)
5. sageattention 是 CUDA-only;RTX PRO 6000 可用,但 :8197 实例未装,沿用 sdpa 即可(与 LongCat-Video 同)
6. Audio CFG 3–5 最优,调高增强唇形;`ref_img_index` 0–24 保一致性、30 抑重复动作;`mask_frame_range` 过大出伪影([HF 模型卡](https://hf-mirror.com/meituan-longcat/LongCat-Video-Avatar-1.5))
7. 序列变长注意力耗时超线性增长(81 帧 ~466s/it vs 125 帧 ~1500s/it,APU 数据仅作趋势参考)([ROCm 实测](https://github.com/ROCm/TheRock/discussions/5635))
8. ⚠️ 别下错权重:Kijai/LongCat-Video_comfy 的 Avatar fp8 是 **v1.0**;v1.5 单文件在 **Kijai/WanVideo_comfy 的 LongCat/ 子目录**或 GGUF 仓库(HF API lastModified 实测)

---

## 四、效果评估

### 4.1 官方人评(508 组图像-音频对、770 名评估者、13240 条判断)

| 指标 | LongCat-Avatar 1.5 | 对比 | 来源 |
|---|---|---|---|
| 单人场景人似度 | **3.336**(SOTA) | 高于 HeyGen、OmniHuman-1.5、Kling Avatar 2.0 | [腾讯新闻转官方稿](https://news.qq.com/rain/a/20260527A036JN00) / [arXiv](https://arxiv.org/abs/2605.26486) |
| 多人场景 | **2.730** | 大幅领先 InfiniteTalk 2.339(说/听角色区分准) | 同上 |
| 唇形同步问题率 | **29.8%**(对比模型中最低) | 全行业硬骨头,已是当前最优 | [CSDN 转官方稿](https://blog.csdn.net/SuaniCommunity/article/details/161388215) |
| 面部-身体同步问题率 | 5.1% | 最低 | 同上 |
| 主体变形 / 背景变形问题率 | 23.1% / 9.4% | 均低于所有对比模型 | 同上 |

### 4.2 社区口碑与横向定位

- 2026 年中社区共识:**开源音频驱动数字人的第一梯队**,与 InfiniteTalk(同门前作)相比动态表现力更强,官方定位「商业级」而非研究原型([knightli 评测](https://knightli.com/en/2026/05/25/longcat-video-avatar-1-5-audio-driven-avatar-video/))
- 与 SadTalker/Hallo/EchoMimic/LatentSync 不是同一量级:那些是 2D 形变/小模型唇形修复路线(轻、快、仅限脸部特写、长视频必崩);LongCat-Avatar 是 13.6B DiT 全画面生成(半身/全身、有真实肢体动作、分钟级稳定),代价是显存与耗时高一个数量级。**口播成片场景前者已被社区普遍认为过时**
- 与 FlashTalk 不在同一赛道:FlashTalk 是实时流式(对话延迟优先),Avatar 是离线渲染(画质与时长优先)
- 真实硬件实测:GGUF Q5_K_M 480×832×81 帧(3.2s@25fps)8 步出片,唇形正确、显存 ~30GB;耗时取决于算力(APU 62 分钟,RTX PRO 6000 预期分钟级)([ROCm 实测](https://github.com/ROCm/TheRock/discussions/5635))

---

## 五、与现有数字人链路的关系

| | FlashTalk(GPU3,已上线) | LongCat-Video-Avatar 1.5(拟引入) |
|---|---|---|
| 场景 | 实时对话数字人(WebSocket,低延迟) | 离线口播/教学内容成片(分钟级) |
| 驱动 | 实时音频流 | 预合成音频文件(IndexTTS2 产物直接喂) |
| 画质/时长 | 短链、牺牲画质换延迟 | 480p/720p、分钟级、全身动作 |
| 结论 | **互补不替代**。两条产品线:交互用 FlashTalk,内容生产用 Avatar | |

**OpenTalking 统一 API 接入可行性**:高。OpenTalking 已是数字人统一门面(:4403),Avatar 走「提交音频+参考图 → 异步轮询 → 取 mp4」的离线作业模式,与 core 现有 LongCat t2v 接入模式(engine_registry + 作业登记 + resolve_worker 产物代理)完全同构,可先在 core API 加 `longcat-avatar` 引擎,再由 OpenTalking 聚合。TTS 产物(IndexTTS2,:9200)即 Avatar 的音频输入,链路上「文本 → IndexTTS2 → Avatar → 口播成片」零缝隙。

---

## 六、升级建议(分阶段落地)

**总判断:建议引入。** 理由:① MIT 可商用;② 官方人评开源 SOTA;③ 与 :8197 实例同栈,基础设施零新增;④ 显存预算 GPU2 容得下且与 H3 共存;⑤ 补齐 FlashTalk 覆盖不了的分钟级口播场景。

| 阶段 | 内容 | 依赖/预算 | 风险 |
|---|---|---|---|
| **P0 权重下载**(0.5 天) | ✅ **已下载(2026-08-08,全部 sha256 校验通过)**,落位 NAS `toiv/comfyui-models/`,详见表下清单;umt5/VAE 复用 | ~24GB NAS,已有 39TB 余量 | 低;⚠️ 别下成 v1.0 权重(见 3.4-8) |

**P0 实落清单**(2026-08-08,全部走 ModelScope 直链,sha256 与远端仓库元数据一致):

| 文件 | 落位路径(NAS `toiv/comfyui-models/` 下) | 大小 | 来源(ModelScope) |
|---|---|---|---|
| GGUF Q8_0 DiT | `diffusion_models/LongCat-Avatar/LongCat-Avatar-15_comfy-Q8_0.gguf` | 19,081,405,440 B (19.1GB) | `vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI` |
| dmd 蒸馏 LoRA | `loras/LongCat-Avatar-15_dmd_distill_lora_rank128_bf16.safetensors` | 1,261,613,536 B (1.26GB) | `Kijai/WanVideo_comfy` → `LongCat/`(**v1.5 专用,非 v1.0**) |
| whisper-large-v3 | `audio_encoders/whisper-large-v3.safetensors` | 3,087,130,976 B (3.09GB) | `meituan-longcat/LongCat-Video-Avatar-1.5` → `whisper-large-v3/model.safetensors` |
| Kim_Vocal_2.onnx | `vocal_separator/Kim_Vocal_2.onnx`(附 mdx/vr_model_data.json、download_checks.json) | 66,759,214 B (0.07GB) | `meituan-longcat/LongCat-Video-Avatar-1.5` → `vocal_separator/` |

**P1 接线提示**(实测 :8197 实例代码得出):① wrapper `WhisperModelLoader` 从 `models/audio_encoders/` 取单文件 safetensors(键名 `model.*`,完整 HF  checkpoint 可直接喂,decoder 键自动忽略),config 用 wrapper 自带 `HuMo/whisper_config.json`(已确认 large-v3:1280 维/32 层/128 mel);② :8197 的 `extra_model_paths.yaml` 目前只映射 diffusion_models/text_encoders/vae/loras,**需补 `audio_encoders: audio_encoders` 一行**并重启实例;③ Kim_Vocal_2.onnx 走官方 vocal_separator 路线;若改用 Kijai ComfyUI-MelBandRoFormer 插件,其模型是 `MelBandRoformer_fp16.safetensors`(456MB,ModelScope `Kijai/MelBandRoFormer_comfy` 有镜像),P1 装插件时再定夺补下。
| **P1 实例扩展+冒烟**(1 天) | :8197 实例 git pull WanVideoWrapper(main 已含 Avatar 1.5 节点)、装 ComfyUI-MelBandRoFormer;按官方示例工作流跑 480×832×81 帧冒烟:参数写死 fps=25、4n+1 帧、merge_loras=false | GPU2 峰值 ~30-35GB,与 ASR/H3 共存 | 中;节点版本兼容需实测 |
| **P2 压测+core 接入**(2-3 天) | ① 720p×分钟级压测(上下文窗口,与 H3 互斥策略复用);② engine_registry 注册 `longcat-avatar`(复用 longcat-t2v 的 builder/路由模式);③ **resolve_worker 勿忘**:8197 已有精确匹配分支,无需改动,但新增端点回归一遍产物代理;④ OpenTalking 聚合入口 | 参照 LONGVID-2026-08-07 流程 | 中;长视频段间一致性需真机验证 |
| **P3 产品化**(后续) | drama studio「口播镜头」类型接入;文本→IndexTTS2→Avatar 一键成片 | — | 低 |

**不建议做的**:不要用 v1.0 权重(wav2vec2 唇形明显弱于 1.5);不要把 Avatar 塞进生产 ComfyUI-LB 后端池(维持 :8197 独立实例隔离惯例);不要动 GPU3 FlashTalk(实时业务不叠加)。

---

## 附:主要来源清单

- 官方仓库与 README:https://github.com/meituan-longcat/LongCat-Video
- v1.5 HF 模型卡:https://huggingface.co/meituan-longcat/LongCat-Video-Avatar-1.5(经 hf-mirror 读取)
- v1.5 技术报告:https://arxiv.org/abs/2605.26486
- 美团技术团队官方稿:https://tech.meituan.com/2026/05/25/LongCat-Video-Avatar-1.5.html
- WanVideoWrapper(main 分支节点树/示例工作流,GitHub API 实测):https://github.com/kijai/ComfyUI-WanVideoWrapper
- Kijai 权重(HF API 实测文件清单):https://huggingface.co/Kijai/WanVideo_comfy(tree: LongCat/)
- GGUF 社区权重:https://huggingface.co/vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI / https://modelscope.cn/models/vantagewithai/LongCat-Video-Avatar-1.5-GGUF-ComfyUI
- ComfyUI 工作流拆解:https://www.runcomfy.com/comfyui-workflows/longcat-video-avatar-1-5-single-character-comfyui-audio2video-sync
- 真实硬件实测(显存/坑):https://github.com/ROCm/TheRock/discussions/5635
- 官方人评数据转述:https://news.qq.com/rain/a/20260527A036JN00 / https://blog.csdn.net/SuaniCommunity/article/details/161388215
