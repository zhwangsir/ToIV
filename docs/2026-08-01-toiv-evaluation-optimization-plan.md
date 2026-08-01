# ToIV 全面功能与性能评估 + 系统性优化方案

> 评估日期:2026-08-01
> 评估范围:apps/api(42 个路由模块)、apps/web(全部页面与组件)、模型接入层(workflows/services/config)、部署链路(deploy/)、集群集成现状
> 评估方法:四路并行静态审计(后端完整性 / 前端 UX / 模型合理性 / 性能效率)+ pytest 基线复跑 + 生产实测记录(TEST_LOG.md)
> 测试基线:731 项 pytest 全绿(2026-08-01 复跑确认)

> **执行进度(2026-08-01 当日)**:P0 全部 ✅、P1 全部 ✅、P2-2/P2-3/P2-4/P2-5 ✅ 已部署 core(pytest 731→809,tsc/build 通过,生产配置实测生效,详见 TEST_LOG.md OPT-P0P2-2026-08-01)。剩余:P2-1 PuLID(待 FLUX.1 dev 底模)、P2-2 的 UVR5 人声分离前置(需 workstation 提供 HTTP 分离服务,当前仅 CLI venv)、P3 持续项。

---

## 第一部分:评估结果

### 1. 总体结论

ToIV 主干工程质量高于一般 AI 辅助项目:任务编排(tracker 退避 + reconcile 自愈 + GC 强引用)、路径安全(pathsafe.py 企业级)、RAG 降级、jobs_persist 终态回放、WorkerPool 熔断摘流,均为成熟设计。但存在三个层面的系统性问题:

1. **功能闭环断裂**:若干「最后一公里」缺陷让已实现的能力用户拿不到(v2 单候选不回写、autorun 进度不轮询、数字人状态不探活)。
2. **模型资产空转**:NAS 已下载的 PuLID/EVA02/FaceID Plus v2/UVR5/32 个场景 LoRA/AI-Omni ASR 全部未接入;已接入的 10 个场景 LoRA 预设因语法错误实际不生效;IPAdapter 角色一致首帧因底模传参 bug 必然失败且被静默吞掉。
3. **效率杠杆未用**:autorun 严格串行(5 个 ComfyUI worker 只用 1 个)、PG18+Redis 就位未接入、assemble 在 core 本地跑 ffmpeg 违反算力边界。

### 2. 分维度评估

#### 2.1 已开发功能完整性(评级:B+)

**后端 42 个路由模块,按域:**

| 域 | 完成度 | 关键缺口 |
|---|---|---|
| 鉴权/账户/管理 | ✅ 完整 | — |
| NAS(文件 + 模型下载) | ✅ 完整 | 无直接降级测试 |
| 任务编排(tracker/SSE/reconcile) | ✅ 成熟 | — |
| ComfyUI 生成(13+ 端点) | ✅ 完整 | — |
| 漫剧 manju / 译制 dub | ✅ 完整 | 合成与 dub 核心零测试 |
| 短剧工作室(45 端点) | ⚠️ 主体完整 | **v2 单候选分支不回写 shot**(drama_studio.py:2900-2963);6 处 create_task 无强引用;autorun 重启无 reconcile |
| 动态分镜 animatic | ✅ 双模式完整 | stitch 默认 3s/镜是用户吐槽点,但 AI 模式已是默认 |
| 数字人 | ⚠️ | Seedance/Kling 是 stub(video_generators.py:164-193);前端状态不探活 |
| RAG/智能体 | ✅ 降级完备 | 无 rerank;min_score=0.25 固定 |
| Forge/LoRA 训练 | ⚠️ 骨架 | 生产未部署、无测试 |

**前端:** 14 个视图中 12 个完整可用;`train`/`backlot` 无导航入口(死视图);`/engine` 537 行孤儿页;`components/studio/` 约 4600 行死代码;`/drama/[id]` 章节硬编码 0/20/45/70s。

#### 2.2 模型选择与应用合理性(评级:B)

**选型本身合理**(全部本地开源权重,符合极致本地原则),问题出在应用层:

| 类别 | 内容 |
|---|---|
| ✅ 已接入且合理 | L1 LLM(降级链完备)、IndexTTS2(音色克隆+情感)、Embedding+RAG、ComfyUI pool、OpenTalking、LiveAct、LTX 链路(LipDub sigma 表)、model_profiles 族采样档案、optimize 提示词方言、VLM 评分、from-image 管线 |
| ⚠️ 已接入但有 bug/风险 | ① 场景 LoRA 用 `<lora:...>` A1111 语法进 ComfyUI prompt,**不生效且污染 prompt**(style_presets.py:321-438,P0);② IPAdapter 首帧把 FLUX.2 UNET 传给 CheckpointLoaderSimple,必然失败被静默吞(drama_studio.py:1292,P0);③ Qwen-Image 默认预设 cfg=1.0 与族档案 3.5 矛盾;④ workflows/llm_router.py 硬编码四层端点全面过时(Kimi-K2.7/GLM-5.2-fp8/euryale-70b),前端模型清单与健康检查展示错误;⑤ 全部短剧视频(含 SFW)硬编码 10Eros NSFW 底模(drama_studio.py:1390);⑥ Qwen-Image 2.0 编码器可能被配给 1.0 底模 |
| 💤 已下载未接入(资产闲置) | PuLID Flux + EVA02-CLIP(角色一致性最优解,代码零引用)、IPAdapter FaceID Plus v2、Demucs/UVR5(译制参考音含 BGM 噪声)、AI-Omni ASR :9210(GPU large-v3 闲置,ToIV 走 CPU base)、32/42 个场景 LoRA |
| ❌ 缺失 | LoRA 标签解析器、PuLID 工作流构造器、译制人声分离前置、SFW/NSFW 底模分流、llm_router 与 config 单一事实源 |

**LLM 四层路由:** `agent/llm.py` 的 chat_layered 实现正确(L3→L2→L1 降级链,EXO 无实例时重试 3 次降级);但 `style_presets.py` 每个预设写的 `llm_layer` 字段无任何消费方(设计未闭环);refine/polish 共用单一 polish layer,L2/L3 无法分设;宫格拆镜端点(drama_studio.py:2344)绕过配置固定走 L1。

#### 2.3 业务流程效率(评级:C+,最大改进空间)

| 问题 | 影响 | 位置 |
|---|---|---|
| autorun 逐镜严格串行(视频→等待→下一镜;配音同样串行) | 8-16 镜短剧 40-90 分钟;5 个 worker 只用 1 个;**并发化后预计缩短 3-5 倍** | drama_studio.py:3658-3707 |
| assemble 在 api 进程机(生产=core)跑 ffmpeg,违反算力边界;libx264 无 preset/crf;clip 串行下载 | 合成慢且占用 core | assembly.py:525-550, 678-693 |
| PG18+Redis 未接入,生产单文件 SQLite + 全内存态 | 高频写锁竞争;限流/事件总线不可多进程 | config.py:71 |
| httpx.AsyncClient 现开现关(tracker 每 2-8s 轮询也新建连接) | 无谓握手消耗 | comfy/client.py:103 等 30+ 处 |
| LiveAct/TTS 产物全量内存读写 + 同步写 cifs 挂载 | 阻塞事件循环几十~几百 ms | drama_studio.py:2766/1665 等 |
| cad.py 同步 subprocess 最长 3 分钟卡事件循环 | 单点阻塞 | cad.py:124 |
| drama_studio 6 处 create_task 无强引用 | 任务可能被 GC 提前回收 | drama_studio.py:1536/1828/2858/3036/3489/3833 |
| autorun/LiveAct/批量精修重启即丢,shot 永久卡 generating | 生产可靠性 | 同上 |

#### 2.4 功能实现深度与复杂度(评级:A-)

短剧工作室 3839 行/45 端点,实现深度超预期:LLM 拆镜(四层路由)、宫格分镜、多候选生成+自动 pick、LatentSync 对口型、scene-layout 三视图、refine/polish、播放埋点、from-image 一键管线。复杂度管理良好(路由薄、services 厚)。欠债集中在:ffmpeg 合成链零测试、`_parse_json_obj` 四份拷贝、超时/轮询策略散落 20+ 处无统一。

#### 2.5 用户体验流畅性(评级:B-)

**直接造成用户抱怨的三个断点:**

1. **「动态分镜只是把图片放三秒」**:stitch 模式默认 3s/镜是表象;真断点是 AI 模式跳转短剧工作室后,**autorun 进度无任何自动轮询**(useDramaProject.ts:1072 只读一次性加载的 process_data,只有手动刷新按钮),用户看到静止页面,体感仍是"没生成"。
2. **「数字人显示未连接」**:状态 pill 只映射本地 sessionState,初始恒为「未连接」;后端免鉴权探活端点 `GET /api/opentalking/status` 已存在,前端 `otGetStatus` **已定义但全应用零调用**(AvatarTalkView.tsx:172-175)。
3. **「模型没配全」**:模型列表是后端真实数据(折叠不可用项是忠实反映),但 `otGetModels` 失败时塞假 `{id:"mock", status:"available"}`(AvatarTalkView.tsx:137-138),宕机时反而显示"可用的 mock",误导加倍;且 SetupPanel 未暴露 tts_voice/system_prompt/agent/memory/knowledge 开关。

**其他 UX 问题(P1/P2):** api.ts 69 处手写 fetch 无统一 helper、无超时、无取消、无全局 401 处理(401 后用户陷入"全报错但页面还在");轮询一律不随页面隐藏暂停(仅 CanvasAmbience 例外);轮询容错两极(DubView 全吞 vs ShotTab 一次错误即放弃);上传仅 AnimaticView 有客户端校验;作品库全量渲染无分页;全站 0 处 next/image。

#### 2.6 生成内容质量(评级:B,受模型应用 bug 拖累)

- **短剧视频**:全部走 10Eros NSFW 底模,SFW 内容画质/倾向有风险;角色一致首帧(IPAdapter)当前**从不生效**(传参 bug 被静默吞),多镜头角色一致性实际无保障;配音长于视频时无对齐处理(溢出到下一镜)。
- **图像**:场景 LoRA 预设不生效 → 42 个 LoRA 资产零贡献;默认预设 cfg 错误 → 默认出图参数即错。
- **配音/译制**:音色三级优先级设计完整,但译制参考音未做人声分离(含 BGM 噪声),克隆纯净度受损;听写走 CPU base 而非已部署的 GPU large-v3,准确率受限。
- **VLM 解析**:prompt 设计质量好(字段对齐 + LTX 铁律),但输出无字段级 schema 校验,坏字段会带进下游。
- **LiveAct**:实测 4-6 FPS(理论 12.6),瓶颈是 t5_cpu + mean_memory 保显存与 MuseTalk 共存,属有意的资源妥协,效果本身用户已认可。

---

## 第二部分:系统性优化方案

### 阶段总览

| 阶段 | 主题 | 周期 | 目标 |
|---|---|---|---|
| P0(第 1 周) | 修断点:让已有能力真正可用 | 5 个工作日 | 消除三个用户抱怨断点 + 两个生成质量 P0 bug |
| P1(第 2-3 周) | 提效率:并发化 + 状态持久化 | 10 个工作日 | autorun 端到端缩短 3-5 倍;任务重启可恢复 |
| P2(第 3-5 周) | 接资产:闲置模型全部上岗 | 10 个工作日 | PuLID/UVR5/ASR/LoRA 全接入,生成质量可量化提升 |
| P3(持续) | 强基建:PG/Redis/测试/部署 | 持续 | 生产可靠性达标 |

---

### P0:修断点(第 1 周)

#### P0-1 v2 单候选分镜不回写(后端 bug)

- **现状**:`generate-video-v2` num_candidates≤1 分支提交后未挂 `_await_shot_video_writeback`,shot 永久停 generating,前端轮询 15 分钟超时(drama_studio.py:2900-2963)。
- **步骤**:① 该分支补 `asyncio.create_task(_await_shot_video_writeback(sid, prompt_id))`;② 同时为 drama_studio 全部 6 处 create_task 加强引用集合(仿 tracker.spawn);③ 测试补回写断言(现 test_drama_studio.py:802-826 只断言提交响应)。
- **量化指标**:v2 单候选生成后 shot.video_status 在轮询超时前到达 done/error,回写率 100%。
- **验证**:pytest 新增用例 + 真机单镜 v2 生成 E2E。
- **工时**:0.5 人日。

#### P0-2 autorun 进度前端自动轮询

- **现状**:from-image 后台跑几十分钟,前端只读一次性 process_data,用户看到静止页面。
- **步骤**:① 封装统一 poll hook(带指数退避 + `document.hidden` 暂停,供本次及后续所有轮询复用);② DramaStudioView 在 autorun running 时以后端返回的 `poll_interval_sec` 轮询项目 process_data,终态自动停;③ 进度面板区分「等待/进行/完成/失败」镜级状态。
- **量化指标**:autorun 全程无需手动刷新;进度面板刷新延迟 ≤ 5s;页面隐藏期间 0 请求。
- **验证**:Playwright E2E(from-image 提交 → 进度自动推进至合成完成)。
- **工时**:1 人日。

#### P0-3 数字人页面状态探活 + 模型列表诚实化

- **步骤**:① 页面加载与每 30s 调 `GET /api/opentalking/status`(已实现零调用的 otGetStatus),pill 三态:在线/离线/未配置;② 删除 mock 假模型兜底,`otGetModels` 失败时显示「引擎不可达」而非假可用;③ SSE `es.onerror` 断线时 pill 转离线 + 重连提示;④ SetupPanel 补 tts_voice、system_prompt、agent/memory/knowledge 开关(契约已支持)。
- **量化指标**:引擎在线时 pill 显示「已连接」;引擎停服 30s 内页面反映离线;mock 假数据 0 处。
- **验证**:组件单测 + 真机停/起 opentalking 服务观察页面。
- **工时**:1 人日。

#### P0-4 场景 LoRA 预设修复(生成质量)

- **现状**:`<lora:name:weight>` 语法进 ComfyUI prompt 不解析,10 个预设零生效且污染 prompt。
- **步骤**:① generate 链路增加解析器:从 prompt_hint 提取 `<lora:...>` 标签转成 LoraSpec 链注入工作流,标签从最终 prompt 文本剔除;② 同步修正 Qwen-Image 默认预设 cfg 1.0 → 3.5(对齐 model_profiles.py:302);③ 为 42 个 LoRA 中剩余 32 个补预设或提供显式 loras 参数入口。
- **量化指标**:同一 prompt 开/关场景预设出图可感知差异(人工盲评 ≥ 4/5 可辨);默认预设出图 VLM 评分均值提升。
- **验证**:workflow builder 单测(断言 LoraSpec 节点入图)+ 真机对比出图。
- **工时**:1.5 人日。

#### P0-5 IPAdapter 角色首帧修复 + SFW/NSFW 底模分流

- **步骤**:① drama_studio.py:1292 底模传参改走 is_nextgen 分支(对齐 manju.py:264-265),失败时记 warning 而非静默吞;② 项目级 nsfw 标志决定视频底模(10Eros vs ltx-2.3-distilled),替代全局硬编码(drama_studio.py:1390、video_generators.py:127)。
- **量化指标**:SFW 项目视频 0 次调用 10Eros;IPAdapter 首帧提交成功率 > 0(当前恒为 0);多镜角色一致性人工盲评。
- **验证**:单测 mock pool 断言 ckpt 选择 + 真机双项目对比。
- **工时**:1 人日。

**P0 合计:5 人日。完成标志:三个用户抱怨断点消除,LoRA 与 IPAdapter 从「从不生效」变「生效」。**

---

### P1:提效率(第 2-3 周)

#### P1-1 autorun 并发化(最大杠杆)

- **步骤**:① 视频阶段改 `asyncio.Semaphore(3)` + gather 并发提交(pool.py:173 已具备按队列长度分发能力,自动摊到多 worker);② 配音阶段同样并发(IndexTTS2 单卡,Semaphore 2);③ 保持单镜失败不中断语义;④ 并发数进 Settings 可调。
- **资源**:无新增硬件;纯调度改动。
- **量化指标**:8 镜短剧端到端从 ~45 分钟降至 ≤ 15 分钟(≥ 3 倍);worker 利用率从 20% → ≥ 60%(生成期并发 worker 数)。
- **验证**:单测(mock submit/await 断言并发度)+ 真机 8 镜 autorun 计时对比。
- **工时**:2 人日。

#### P1-2 后台任务持久化与 reconcile

- **步骤**:① autorun/LiveAct/批量精修任务状态落 DB(复用 jobs_persist 模式);② main.py 启动时对 `video_status=generating` 的 shot、running 的 autorun 做 reconcile(重挂轮询或标 error);③ LiveAct 重启后按 task_id 重挂轮询。
- **量化指标**:api 重启后 0 个 shot 永久卡 generating;autorun 恢复或明确报错率 100%。
- **验证**:单测模拟重启 + 真机 restart 中途任务观察。
- **工时**:2 人日。

#### P1-3 assemble 效率与算力下沉

- **步骤**:① clip 下载改 asyncio.gather 并发;② `_run_ffmpeg` 加超时(参考 animatic 300s);③ 编码参数加 `-preset veryfast -crf 20`;④ 合成下沉 workstation(复用 animatic.py:98-119 的 ssh 模式)或至少迁出 core 的关键路径;⑤ assembly 合成链补测试(当前最重的 ffmpeg 逻辑零测试)。
- **量化指标**:16 镜合成耗时下降 ≥ 50%;core 上 0 次 ffmpeg 重编码进程;assembly 测试覆盖率从 0 → 核心路径 ≥ 70%。
- **验证**:pytest 新增 + 真机合成计时。
- **工时**:2.5 人日。

#### P1-4 HTTP 客户端池化 + IO 流式化

- **步骤**:① 按 base_url 模块级 AsyncClient 缓存(lifespan 关闭),ComfyUIClient/TTS/LLM 共用;② 产物落盘统一流式 + `asyncio.to_thread`(对齐 nas_models.py:181-193 正确示范);③ cad.py:124 改 to_thread;④ wait_for_jobs 改批量 IN 查询。
- **量化指标**:tracker 稳态新建连接数 ≈ 0;大文件(>20MB)写 NAS 期间事件循环延迟 < 50ms。
- **验证**:单测 + 压测观察。
- **工时**:2 人日。

#### P1-5 api.ts 统一封装

- **步骤**:① 收敛 69 处 fetch 到统一 helper(超时默认 30s、AbortSignal 支持、401 统一清 token 跳登录);② 各 lib 子文件(animatic/ltxstudio/agents/canvas/opentalking)复用;③ 长任务端点(from-image 等)显式长超时 + 可取消。
- **量化指标**:raw fetch 0 处(除 helper 内);401 后自动跳登录;任何后端挂起请求 ≤ 超时上限自动报错。
- **验证**:tsc + 组件测试 + 手动断网/拔后端验证。
- **工时**:1.5 人日。

**P1 合计:10 人日。**

---

### P2:接资产(第 3-5 周)

#### P2-1 PuLID Flux 角色一致性工作流(替代失效 IPAdapter 方案)

- **背景**:PuLID Flux v0.9.1 + EVA02-CLIP 已在 NAS 闲置,是比 IPAdapter FaceID 更强的角色一致性方案,且与默认 FLUX.2 底模配套。
- **步骤**:① 新建 workflows/pulid.py 构造器(参照既有 builder 模式);② 接入 drama_studio 首帧链路与 CreateView;③ worker 侧确认节点可用性。
- **资源**:workstation ComfyUI worker 需装 PuLID 节点(设备侧操作,需项目管家同意)。
- **量化指标**:同一角色 4 镜盲评一致性 ≥ 4/5;对比 IPAdapter 基线有提升。
- **验证**:builder 单测 + 真机 A/B。
- **工时**:3 人日。

#### P2-2 译制人声分离 + ASR 升级

- **步骤**:① dub_voice 抽参考音前接 UVR5/Demucs(workstation 已部署 audio-sep-venv),克隆前先分离干净人声;② 生产 .env 补 `TOIV_WHISPER_URL=http://192.168.71.127:9210`,听写从 CPU base 升 GPU large-v3。
- **量化指标**:听写 WER 可感知下降(抽样人工校对);克隆音色含 BGM 噪声投诉 0。
- **验证**:集成测试 + 真机译制一条对比。
- **工时**:1.5 人日。

#### P2-3 LLM 路由层统一

- **步骤**:① workflows/llm_router.py 改为读 settings(消除硬编码 Kimi-K2.7/GLM-5.2-fp8/euryale-70b),或删除并将健康检查/前端展示改接 agent/llm.py 的真实路由;② `style_presets.llm_layer` 字段接入 optimize.py 消费(设计闭环);③ refine(L2)/polish(L3)拆成两个独立 layer 配置;④ 宫格拆镜端点统一走 drama_storyboard_layer。
- **量化指标**:前端模型清单 = 实际调用配置(单一事实源);EXO 恢复后 L2/L3 可独立开关。
- **验证**:单测断言路由目标 + 前端模型页核对。
- **工时**:1.5 人日。

#### P2-4 前端体验收尾

- **步骤**:① 全部轮询迁移到 P0-2 的统一 poll hook(NsfwView 多任务合并单 interval 批量查);② 上传校验补齐(CreateView/VideoView/LtxStudio/DubView);③ 作品库分页/虚拟滚动 + `loading="lazy"`;④ 清理死代码(studio/ 4600 行、/engine 孤儿页、login.css);⑤ train/backlot 补导航入口或下线;⑥ AnimaticView 模式切换校验 + stitch 默认时长暴露为参数。
- **量化指标**:后台标签页 0 轮询请求;上传错误 100% 前端前置提示;死代码 0 行。
- **工时**:3 人日。

#### P2-5 VLM 输出 schema 校验 + 配音对齐补全

- **步骤**:① from-image VLM 输出加字段级校验(duration_sec 类型/范围、prompt 语言、LTX 禁用词复查),坏镜重试一次再兜底;② 配音长于视频时 atempo 压缩(复用 dub_voice 的贴时槽逻辑,上限 1.3)。
- **量化指标**:坏字段进入下游 LTX 的次数 ≈ 0;配音溢出镜次 0。
- **工时**:1.5 人日。

**P2 合计:10.5 人日。**

---

### P3:强基建(持续)

| 项 | 内容 | 指标 |
|---|---|---|
| PG18 接入 | `.env` 切 `TOIV_DATABASE_URL` 到 core PG18(db.py 已兼容);迁移验证 | SQLite 锁竞争消失;切换后 pytest 全绿 |
| Redis 接入 | 限流器/画布事件/worker 健康缓存换 Redis | 多进程部署可行 |
| 测试补盲 | dub 核心、nas_models、opentalking 代理、train、NAS 降级直接测试 | 测试文件 55 → 65+;高危域 0 盲区 |
| 部署加固 | deploy.sh 健康检查失败 exit 1、端口轮询等待、滚动重启、BUILD_ID 回滚 | 部署失败不再报「✅ 部署完成」;停机窗口 < 10s |
| 超时/轮询统一 | 20+ 处散落超时集中到 Settings;轮询统一退避曲线 | 硬编码超时 0 处 |
| 杂项 | `_parse_json_obj` 四合一;v2 错误码 501→502/503;paramiko 连接加 timeout;RAG 缓存移出源码目录;`_drama_root` 支持运行时回切 | — |

---

### 优先级矩阵(投入产出排序)

| 序 | 项 | 投入 | 产出 | 象限 |
|---|---|---|---|---|
| 1 | P0-1 v2 单候选回写 | 0.5d | 修复功能缺陷 | 立即做 |
| 2 | P0-4 LoRA 修复 | 1.5d | 42 个资产从 0 到生效 | 立即做 |
| 3 | P0-2 autorun 轮询 | 1d | 消除最大用户抱怨 | 立即做 |
| 4 | P0-3 数字人探活 | 1d | 消除用户抱怨 | 立即做 |
| 5 | P1-1 autorun 并发 | 2d | 端到端 3-5 倍提速 | 立即做 |
| 6 | P0-5 底模分流 | 1d | SFW 质量保障 | 立即做 |
| 7 | P1-2 任务持久化 | 2d | 生产可靠性 | 计划做 |
| 8 | P2-1 PuLID | 3d | 角色一致性上限 | 计划做 |
| 9 | P1-3 assemble | 2.5d | 合规 + 提速 | 计划做 |
| 10 | P3 PG/Redis | 持续 | 规模化底座 | 持续做 |

### 资源分配建议

- **人力**:1 名全栈(后端为主)约 4 周完成 P0-P2;前端收尾可与 P2 并行。
- **算力**:无新增需求;P1-1 只是把已有 5 个 ComfyUI worker 用起来;P2-1 需 worker 装 PuLID 节点(设备侧,需项目管家同意)。
- **风险**:EXO(L2/L3)无实例期间,精修质量上限受 L1 限制——P2-3 的配置分离应在 EXO 恢复前完成,恢复后删 .env 临时指向即可切回。

### 整体验证方案

1. **回归基线**:每阶段完成后 `cd apps/api && pytest -q`(731 全绿不得回退)+ `cd apps/web && npx tsc --noEmit && npm run build`。
2. **真机 E2E 清单**(每阶段):from-image 全链路(解析→拆镜→并发生成→配音→合成)、v2 单候选回写、数字人探活三态、autorun 计时、重启恢复。
3. **质量抽样**:每阶段抽 3 条成片人工盲评(画质/一致性/音画对齐),记录于 TEST_LOG.md。
4. **性能台账**:autorun 端到端时长、worker 并发数、合成耗时,改进前后记入 TEST_LOG.md 对比。
