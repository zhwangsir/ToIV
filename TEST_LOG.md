# ToIV · 测试日志（TEST_LOG）

---

## I2L-2026-08-27 · i2L 风格 LoRA 产品化(D_finetune → done)

**时间**: 2026-08-27
**类型**: 遗留推进「i2L API 产品化(剩上传流转+常驻服务)」

### 落地

- **agent**:`deploy/i2l-service/server.py`(标准库 http.server 与 toiv-trainer 同风格,torch/diffsynth 惰性 import 首调加载常驻显存 bf16 ~26G);流程逐行对齐 8-24 实证脚本(ZImagePipeline base+turbo TE/VAE → ZImage-i2L-v2 元模型一次前向 → 键名转 ComfyUI 兼容);multipart 自实现解析(cgi 已于 3.13 移除);单并发忙 409、同名 400(overwrite=true 除外)
- **部署**:`toiv-i2l.service` active+enabled(workstation GPU3 :9101,MemoryMax=48G);/health 双模型探测 true
- **core**:`POST /api/train/i2l`(multipart 1-8 图+lora_name,httpx 透传 600s;503 未配置/409 busy/400 透传/502/504 映射表;不写 TrainJob——单次前向无状态机,产物直落 NAS loras 自动发现);`TOIV_I2L_URL=http://192.168.71.127:9101`;已 deploy.sh 部署

### e2e 冒烟(真实链路)

- 3 张平涂矢量风 PNG → core `/api/train/i2l` → agent GPU3 → **1:59 出 LoRA**(首调含 NAS 模型加载)
- 产物核验:`i2l_smoke_20260827.safetensors` 19.9MB / **476 张量 rank4**(与 8-24 demo 一致)/ 键名 `diffusion_model.*.lora_A.weight` **0 坏键**;demo.png 438KB 落 NAS
- ⚠️ 教训:core 端新端点必须 deploy.sh 后才可 e2e(首跑 Method Not Allowed 系远端旧代码)

### 测试/回归

- 新增:agent 25 例(health/lora_name 清洗/busy 409/同名/multipart 解析/env)+ core 14 例(错误映射+成功链路+401)
- 全量:后端 **2315 passed**(88s)

---

## BACKLOG-2026-08-27 · 遗留盘点四连:评分器灰度 + trainer 部署 + 音频 mix/variant + 快速清理包

**时间**: 2026-08-27
**类型**: 用户诉求「推送后找未完成/低完成度内容继续推进」(四项全选;MacStudio 全线已下线不采纳,studio04 退役项跳过)

### ① 视频评分器生产灰度开启(B_eval 90%→100%)

- core `TOIV_VIDEO_SCORER_ENABLED=false→true`(阈值 0.65 不变),备份 `.env.bak-20260827-scorer`,toiv-api 重启 active,/api/health ok
- ⚠️ 旧硬约束「生产必须 false」经用户本轮明确授权变更(灰度观察降级率,异常秒回滚)
- **附带发现修复**:COMFY_WORKERS pc01 死节点 `192.168.71.115:8188`(DHCP 漂移残留,curl 000)→ `.116:8188`(200),重启后 workers 三活

### ② LoRA trainer :9100 常驻部署(D_finetune 40%→70%)

- `deploy/toiv-trainer.py` 移植 Linux:路径常量 env 化(Windows 默认值向后兼容)+ family 映射修正 + 不支持族 400 拒绝(禁静默套 sdxl 模板)
- **arch 字符串实测核验**(workstation ai-toolkit `extensions_built_in/diffusion_models/*/`,此前代码全错):
  flux2→`flux2` / klein→`flux2_klein_9b` / qwen*→`qwen_image` / z_image*→`zimage`(无下划线) / flux,flux1→内置 `flux`(is_flux) / sdxl*→`sdxl`
- **run.py 调用修复**:配置文件是位置参数(config_file_list),原 `--config` 会被当文件名解析
- 部署:`toiv-trainer.service` active+enabled(workstation);merged ckpt 视图 `/home/merlin/toiv-trainer/checkpoints/`(NAS checkpoints+diffusion_models 符号链接 12 文件);LoRA 产出落 NAS loras(ComfyUI 自动发现);`HF_ENDPOINT=hf-mirror`
- core `TOIV_TRAINER_URL=http://192.168.71.127:9100` 接通,/health `{"ok":true,"jobs":0}`
- 测试:`test_toiv_trainer_agent.py` 21 例(family→arch 参数化/400 拒绝/env 覆盖/Windows 默认兼容)
- **i2L 产品化评估**(下轮实施):需常驻 DiffSynth-Studio ZImage-i2L-v2 服务(3.6G,GPU2 余量 ~41G 可承载)+ 风格图上传流转 + LoRA 注册进资产库

### ③ 音频编排 mix/variant 落地(C_audio partial→mostly_done)

- **mix**:ffmpeg `aresample=24000` 归一 + `amix normalize=0 duration=longest` 真实混音;`inputs` 显式引用前序步骤产物,空输入/单输入/引用无产物 422,ffmpeg 失败 500 带 stderr
- **variant**:对最近 tts 步骤按 `duration_factors`(0.5-2.0,1-5 个)重跑真实合成(IndexTTS 2.5 支持语速扰动);无前序 tts 422、多语言源(ja/ko/yue 不支持语速)422 拒绝,不产相同文件冒充
- **sfx**:保持 501,文案改为明确引导(需音效引擎;列出当前可用 tts/separate/concat/mix/variant)
- 测试:`test_audio_orchestrate.py` 14/14(新增 8 例,真 ffmpeg 验证混音时长)

### ⑤+P2 快速清理包

- **IndexTTS2 systemd 化**:`toiv-indextts.service` active+enabled(替代 uv run nohup 裸进程,pid 396467/396471→539708),health ok(model_loaded=true,cuda:0);核实 emo_text=true 与旧进程一致(2.5 已稳定,STATE 2.0 时代 issue 核销)
- **contentpolicy 孤儿表**:核实 toiv 库 public schema 不存在(下线时零残留),核销
- **avatar-talk 瑕疵核销**:前端 641 全过(enginesAvatarTalk 用例在列),8-23 abort 修复有效,STATE known_issue 关闭

### 回归验证

- 后端 `pytest tests -q`:**2276 passed**(139s,较上轮 +28:trainer 21 + audio 7 净增)
- 前端 `tsc --noEmit` 0 错误 + `npm test` **641 passed**
- 生产:core toiv-api active、workstation toiv-indextts/toiv-trainer 双 service active

---

## REPO-RESTRUCTURE-2026-08-27 · 仓库结构系统性重组

**时间**: 2026-08-27
**类型**: 用户诉求「全面检查项目结构,识别混乱,按行业最佳实践重组并验证引用正确性」

### 变更清单

**删除(垃圾/陈旧)**:
- 根目录 `toiv.db`(误从仓库根启动 uvicorn 产生的 SQLite;正主 `apps/api/toiv.db` 不受影响)
- `apps/web/pnpm-lock.yaml` + `pnpm-workspace.yaml`(双包管理器陈旧轨,CI/构建统一 npm)
- `apps/web/responsive-test.js` + `scripts/` 内 9 个一次性调试脚本(debug_*×8/recon_login/_dump_metrics,零引用,Playwright spec 已覆盖)
- `apps/web/tmp/`、`test-results/`、`test-results-prod/`(未追踪实验/产物)
- `apps/api/.coverage` 移出 git 追踪(`.gitignore` 补 `.coverage`)

**移出仓库**:
- `opentalking/`(2.7G 嵌套 git 独立项目)→ 兄弟目录 `../opentalking`;代码仅经 URL `127.0.0.1:4403` 引用,移动前 `lsof +D` 确认无进程占用;`.gitignore` 保留 `opentalking/` 作防回潮守卫

**git mv 重组(保历史)**:
- `deploy/e2e_{audio,comprehensive,drama,h3,prod}_check.py` → `scripts/e2e/`(5 个 docstring 用法行同步更新)
- `scripts/` 26 个扁平脚本按职能四分:`e2e/`(冒烟链路 13)、`eval/`(评估 6)、`h3/`(LoRA 训练/恢复 4)、`ops/`(运维/探测/工具 9)

**引用更新**:
- AGENTS.md 3 处(超分 fleet/i2L 脚本/H3 LoRA 仓库脚本)
- 代码 docstring/注释 4 处:`workflows/video_upscale.py`、`workflows/longcat_video.py`、`workflows/model_wiki.py`(usage 用户可见串)、`routes/longcat_studio.py`
- `.gitignore` 修剪 16 条已不存在文件的陈旧条目,opentalking 注释更新
- 生产引用不动的部分:`deploy/deploy.sh`、`bare-metal/`、`*-service/`、`docker-compose.yml`、`drama/`(代码+compose 挂载引用)

### 验证结果

- 旧路径 grep 全仓扫描:**零残留**(`scripts/video_4k_upscale|scripts/longcat_smoke|deploy/e2e_|...` 16 个旧路径模式)
- 后端:`apps/api/.venv/bin/python -m pytest tests -q` → **2248 passed**(137s)
- 前端:`tsc --noEmit` **0 错误** + `npm test` **641 passed**
- 文档:DEVELOPMENT.md 新增「9. 仓库结构与命名规范」(顶层布局/边界规则/deploy 约定/scripts 四分组/命名规范)

---

## VIDEO-PIPELINE-2026-08-26 · 视频创作四模块落地 + 兼容性修复

**时间**: 2026-08-26
**类型**: 用户诉求「多镜头单次生成/关键帧链式转场/视频到视频编辑/Motion Brush 四模块无缝衔接」

### 四模块落地

**①多镜头单次生成(H3「镜头一…镜头二…」协议)**
- `services/multishot_protocol.py`:ShotSpec/MultiShotPlan + build_multishot_prompt 协议组装
- `POST /api/h3/multishot`(2-4 镜头,总时长 ≤15s,均分/自定义)
- 生产实证:多镜头 prompt 协议正确组装(「生成一段10秒...全片共两个镜头...镜头一(约5秒)...镜头切换:匹配切口...镜头二(约5秒)...」)

**②视频到视频编辑(Runway Aleph 式 in-context)**
- `WanVaceEditParams`+`build_wan_vace_edit_graph`(源视频帧序列→VACEEncode.input_frames,关键帧锚点 mask=0 保留/其余重生成)
- `POST /api/generate/video-edit`(五模式:object_replace/object_remove/style_transfer/relight/camera_change;关键帧 ≤5;preserve_mask 区域控制)
- ⚠️ motion_mask 继承但不消费,__post_init__ 显式拒绝(防静默无效)

**③Motion Brush 局部动效标记**
- `services/motion_brush.py`:BrushStroke/MotionBrushMask + generate_mask(RGBA:R=G=B 强度,A 方向角)
- `POST /api/motion-brush/mask`(源图+笔画→mask PNG)
- 生产实证:mask 生成成功(motion-brush-032a9860339e.png)

**④关键帧链式转场(≤5 帧,Pikaframes 指标)**
- 已完成(commit 20dca29):2-5 帧/段 1-10s/总长 ≤25s

### 兼容性修复(集成测试发现)

**修复 1**:`WanVaceEditParams.motion_mask` 显式拒绝(节点 50 已被源视频占用,编辑区域控制唯一通道是 preserve_mask)

**修复 2**:keyframe-chain 端点段级 motion_mask 透传接通:
- `KeyframeChainRequest.motion_mask` 字段补齐
- 段循环 `WanVaceParams.motion_mask=mask_name` 传入
- `seg_req.motion_mask=req.motion_mask` 快照存 Job params

### 集成测试(18 例)

| 场景 | 验证点 | 结果 |
|---|---|---|
| A | 多镜头→视频编辑(产物直作 source_video) | ✅ |
| B | Motion Brush mask→视频编辑(preserve_mask 区域控制) | ✅ |
| C | 关键帧链→视频编辑(三类 Job 共存) | ✅ |
| D | Motion Brush mask→转场链(段层+链端点双路径) | ✅ |

### 生产 e2e 最终验证

| 模块 | 验证点 | 结果 |
|---|---|---|
| 多镜头 | h3-multishot 引擎上架;协议组装正确 | ✅ |
| 视频编辑 | vace-edit 引擎上架;端点存在 | ✅ |
| Motion Brush | mask 生成成功 | ✅ |
| mask→关键帧链 | 段级透传;数据库实证 params motion_mask 完全正确 | ✅ |

**关键发现**:API `/api/jobs` 列表不返回 params 内容(设计如此,只有 `has_params: bool` 标记);数据库直接查询实证 `motion_mask='motion-brush-032a9860339e.png'` 完全正确。

### 回归与部署

- 后端 **2248 passed**(多镜头 29/视频编辑 31/Motion Brush 39/集成 18)
- 前端 **641 passed**(多镜头 9/视频编辑 20/Motion Brush 15)
- tsc 0 错误
- 部署:deploy.sh 全量;BUILD_ID 20260826-093929-c9e5cf9

**commit**: c9e5cf9

---

## VIDEO-PIPELINE-INTEGRATION-2026-08-26 · 视频创作管线四模块兼容性与无缝衔接验证

**时间**: 2026-08-26
**类型**: 集成验证(多镜头单次生成 × 关键帧链式转场 × 视频到视频编辑 × Motion Brush)

### 模块边界(输入/输出契约)

| 模块 | 端点 | 请求模型特有参数 | 产物 Job kind | 算力落点 |
|---|---|---|---|---|
| 多镜头单次生成 | `POST /api/h3/multishot` | `shots`(2-4 镜头)/`total_duration` | `h3_multishot` | H3 :8195(GPU2) |
| 关键帧链式转场 | `POST /api/generate/keyframe-chain` | `keyframes`(2-5)/`prompts`/`durations` | `keyframe_chain`(合并)+ `transition`(段) | VACE :8197(GPU0) |
| 视频到视频编辑(Aleph) | `POST /api/generate/video-edit` | `source_video`/`edit_prompt`/`edit_mode`/`keyframe_indices`(≤5)/`preserve_mask` | `video_edit` | VACE :8197(GPU0) |
| Motion Brush | `POST /api/motion-brush/mask` | `source_image`/`strokes`(≤64) | (mask PNG,不产生 Job) | 任意 worker(input 目录) |

### 模块间数据流(集成点)

- **产物 → 编辑源**:多镜头/关键帧链成片落 worker input 目录,文件名直传 `video-edit.source_video`(端点内 `transfer_drive_video` 同机直达/跨机转运;无音轨自动补静音轨,原声经 `audio=[50,2]` 回打包)
- **Motion Brush mask → 消费方**(PNG 文件名,三条通路):
  - `wan-vace`/`transition` 的 `motion_mask` 入参 → 生成图节点 50/51(`ImageToMask channel=red`,⚠️ alpha 是方向角编码不可直接当 MASK),与首尾帧并存时 52 `MaskComposite multiply` 取交集
  - `video-edit` 的 `preserve_mask` 入参 → 编辑图节点 62-66(`LoadImage→ImageToMask(red)→InvertMask`,白=保留→0 锚点语义;⚠️ 与 motion_mask 语义相反:brush 灰度=运动,preserve 白=静止)
  - `keyframe-chain` 端点段级透传 **未接通(已知缺口)**,替代路径=逐段 transition 已可用

### 兼容性矩阵

| 组合 | 状态 | 集成点/说明 |
|---|---|---|
| 多镜头 → 视频编辑(场景 A) | ✅ 可组合 | `h3_multishot` 产物文件名直作 `source_video`;e2e 断言编辑图 50 节点 `VHS_LoadVideo` |
| Motion Brush → 视频编辑(场景 B) | ✅ 可组合 | `preserve_mask` 与 `edit_prompt` 同参共存;图支路 62-66 + 出口 90 |
| 关键帧链 → 视频编辑(场景 C) | ✅ 可组合 | `keyframe_chain` 合并产物直作 `source_video`;`keyframe_indices` 锚点整帧保留向全片传播;三类 Job(段/合并/编辑)共存建档无 kind 冲突 |
| Motion Brush → 转场(场景 D 段层) | ✅ 可组合 | `transition.motion_mask` 已接通;与首尾帧 masks 经 `MaskComposite multiply` 交集(两约束同时生效) |
| Motion Brush → 关键帧链(场景 D 链层) | ⚠️ 缺口 | `KeyframeChainRequest` 无 `motion_mask` 字段(段 seg_req 按 TransitionRequest 构造,链路具备透传能力,接通需端点+段透传两行改动) |
| 多镜头 × 关键帧链 | ⛔ 互斥(设计) | 单段内切镜(H3 单 prompt 协议)vs 多段独立转场拼接(VACE),语义正交不同时使用 |
| 视频编辑 × 超分/时长链 | ✅ 可组合 | video-edit 复用 `_attach_duration_chain`(trim 策略)+ `resolution_target` 超分链 |

### 冲突点验证(全部通过)

- **参数命名空间**:四模块请求模型特有字段两两不相交(`keyframes/prompts/durations` vs `shots/total_duration` vs `source_video/edit_prompt/edit_mode/keyframe_indices/preserve_mask` vs `source_image/strokes`);共享接缝仅 `motion_mask`(生成/转场)与 `preserve_mask`(编辑),语义文档化
- **工作流图节点 ID**:生成图 mask 支路 50-52 / 编辑图源视频支路 50 + mask 批支路 60-90;两 builder 独立函数图实例各自唯一;⚠️ `WanVaceEditParams` 继承的 `motion_mask` 字段在编辑图**不消费**(节点 50 已被源视频占用),误传静默无效——测试已钉死,编辑区域控制唯一通道是 `preserve_mask`
- **资源占用**:transition/keyframe-chain/video-edit 共用 :8197,三端点均经同一 `_wan_precheck_or_hold` 显存/RAM 预检(hold FIFO 排队);关键帧链整链只预检一次不逐段叠加;多镜头走 H3 :8195 独立预检,与 VACE 链路无资源竞争
- **路由命名**:Aleph `/api/generate/video-edit` 与 OpenCut 时间线剪辑 `/api/video-edit/render`(既有不同模块)并存不冲突
- **tracker 孤儿检测**:`keyframe_chain` 合成 id(chain-*)已豁免;`video_edit`/`h3_multishot` 为真实 prompt_id 无需豁免
- **作品库归桶**:`h3_multishot`/`keyframe_chain`/`transition`/`video_edit` 全部归前端视频桶(编辑源选择器可选)
- **助手工具链**:`h3-multishot`/`keyframe-chain` 已注册 `submit_generation` 分发;`video-edit`/`motion-brush` 未注册(落地时按同表扩展)

### 前端编辑器共存(GenerateView)

- 数据驱动引擎列表;`customEditor`(isChain/isMultiShot/isVaceEdit)专用编辑器互斥让位标准 PromptBar+参数分组
- 参数按引擎 id 分槽(`valuesByEngine`/`motionMaskByEngine`),切引擎不丢输入、参数面板互不干扰
- Motion Brush 按钮仅 `MOTION_BRUSH_ENGINES`(wan-vace/wan-transition)门控显示(H3 无 mask 输入、SCoPE 契约无 mask 字段,后端同规则);参考图变更自动失效清除已生成 mask
- `AiVideoEditView`(vace-edit 引擎)/`MultiShotEditor`(h3-multishot)/`KeyframeChainEditor`(keyframe-chain)各自承载提交链路,canSubmit 标准链路对专用编辑器引擎永不触发

### 测试

- 后端 `test_integration_video_pipeline.py` **18 例**(横向兼容性 10:命名空间/路由/注册表/agent 分发/tracker 豁免/双图节点布局/语义陷阱/共享预检/前端归桶 + 场景 A-D 7 + brush 服务层 1)
- **全量回归:后端 2248 passed / 前端 626 passed / tsc 0**(含并行落地的模块自测:multishot/motion_brush/video_edit/keyframe_chain)
- 前端脆弱性修复 1 处:`enginesTransition.test.ts` ③ uploadKind 断言 `indexOf`→`lastIndexOf`(Motion Brush 门控引入同名字符串前置出现)

### 遗留缺口(后续任务)

1. **场景 D 链层**:keyframe-chain 端点段级 `motion_mask` 透传未接通(测试 `test_scenario_d_keyframe_chain_mask_gap` 已钉死现状,接通后翻转)
2. **语义陷阱**:`WanVaceEditParams.motion_mask` 继承字段编辑图不消费,误传静默无效(测试已固化;长期可在参数类 `__post_init__` 拒绝或映射到 `preserve_mask`)
3. **助手工具链**:`video-edit`/`motion-brush` 未注册 submit_generation 分发(注册后助手可自然语言驱动编辑/动效)

---

## KEYFRAME-CHAIN-2026-08-26 · 关键帧链式转场(对标 Pika 2.5 Pikaframes)

**时间**: 2026-08-26
**类型**: P2 路线图任务落地(用户诉求「多镜头单次生成功能中的关键帧链式转场」)

### 数据结构与接口

- `KeyframeSegment`:first_frame/last_frame/prompt/duration_sec/frames/steps/cfg/seed(段种子=基础 seed+段序号)
- `KeyframeChainPlan`:segments tuple/total_duration/fps/width/height/seed + `to_params()` 快照
- `validate_keyframe_chain()`:2-5 帧/段 1-10s/总长 ≤25s/prompts/durations 数量=段数 → `KeyframeChainError` 转 422

### 平滑过渡算法

N 帧→N-1 段,段 i 尾帧=段 i+1 首帧(用户关键帧,天然零跳变);durations 缺省每段 5s 均分;帧数按 VACE 4k+1 网格向上吸附(`snap_engine_frames`);整链一次 `_wan_precheck_or_hold` 资源预检。

### API

`POST /api/generate/keyframes-chain`:
- 参数:keyframes(2-5 上传句柄)/prompts(单 string 全段共用 或 list 逐段)/durations(list 或 None=均分)/width/height/steps/cfg/seed/worker
- 合并 Job(kind=keyframe_chain,params 存链计划+段 prompt_ids)+段 Job(kind=transition 保留调试)
- 后台合并链:`_wait_files` 逐段等产物→`_concat_trim` 精确裁→回传 worker→`rewrite_job_result` 回写;api 重启按 params 快照幂等重挂

### 前端

`KeyframeChainEditor.tsx`:2-5 槽位上传(AssetPicker)/拖拽排序/段参数卡(时长滑块/提示词)/总时长预览/段进度;GenerateView「关键帧链」引擎选项;canSubmit 护栏。

### 兼容性

- 既有 transition 端点零改动(复用 `generate_transition` 内部函数)
- 与 DurationPlan extend 策略正交(多组独立转场 vs 单视频续写)
- tracker reconcile 跳过 `kind=keyframe_chain` 重挂(合成 prompt_id 防孤儿误杀)
- R18:X-NSFW 上下文段 Job 与合并 Job 全链打标

### 测试

- 后端 `test_keyframe_chain.py` **35 例**(校验 8/拆分 7/合并链 2/端点 18)
- 前端 `keyframeChain.test.ts` **13 例**(总时长/拖拽/门控/载荷契约/段进度)
- **全量回归:后端 2168 passed / 前端 601 passed / tsc 0**

### 生产 e2e

| 验证点 | 结果 |
|---|---|
| keyframe-chain 引擎上架 | ✅ video 类 |
| 校验路径(1 帧) | ✅ 422 too_short |
| 3 帧链式转场提交 | ✅ 合并 Job prompt_id=chain-*,2 段 segment prompt_ids,total_duration=6.0 |
| 合并 Job + 段 Job 建档 | ✅ keyframe_chain + 2× transition 全部 queued |

**commit**: 20dca29

---

## ROADMAP-2026-08-26 · 竞品调研路线图 P0/P1 四任务全落地

**时间**: 2026-08-26(凌晨)
**类型**: 竞品驱动功能开发(用户诉求「市场调研→路线图→直接开始推进→优化低分项」)

### 竞品调研(5 家并行)

| 竞品 | 核心启示 | ToIV 差距 |
|---|---|---|
| liblib.tv | 画布抽象层级/宫格分镜/3D 导演台/Agent Skill 开放 | 画布 UX/模板生态 |
| 即梦 AI | 全能参考一致性/Agent 小章鱼/分镜时间轴 | 多模态参考/自动成片 |
| Runway Gen-4.5 | Aleph in-context 编辑(改一帧传播全片+预览帧)/Act-Two 手指级表演捕捉/Media Router 语义路由 | 视频到视频编辑/局部动效 |
| Pika 2.5 | **Pikaffects 一键物理特效**(melt/explode/crush)/Pikaframes 关键帧链 | **特效预设空白**(P0) |
| Vidu Q3 | **@主体库全局资产**(@牛仔 @酒吧)/16s 声画同出/多镜头自动切镜 | **主体库非全局**/**@引用无感知**(P1) |
| PixVerse V6 | **首尾帧 Transition**/MultiShot 多镜头 | **首尾帧无产品形态**(P0) |
| 海螺 H3 | 导演模式 15 运镜指令/Motion Brush 局部动效 | 局部动效(P2) |

**护城河确认**:R18 无审查/私有算力零边际成本/数据飞轮/LoRA 训练管线/3D 管线——五家全空白。

### P0 落地(已部署 core)

**①特效预设体系**(对标 Pikaffects)
- `services/effect_presets.py`:17 物理特效(melt/explode/crush/inflate/squish/levitate/dissolve/deflate/eye-pop/shatter/freeze/burn/vanish/transform/camera-shake/petrify/crystallize),H3 自然语言风格英文 prompt,R18 兼容注明
- engine_registry 三链路注入(h3-t2v/h3-nsfw-t2v/wan-nsfw-i2v),GenerateView 特效下拉+描述展示
- 生产实证:H3 melt 特效提交,Job prompt 以「The subject melts like warm wax...」开头

**②首尾帧生成入口**(对标即梦/PixVerse)
- `POST /api/generate/transition`(Wan VACE 首尾帧,首帧兼作 ref 锚点)+ wan-transition 引擎注册
- 前端双上传框(AssetPicker 从作品库选)+ Job kind=transition
- 生产实证:wan-transition 引擎上架(14 SFW/22 R18 全量)

### P1 落地(已部署 core)

**③全局主体库**(对标 Vidu My References)
- `Entity` 全局表(kind=character|scene|prop)+ CRUD API+drama_studio 双源读取(同名优先全局,回退项目卡)+启动幂等迁移(3 次 init_db 只产 1 条)
- EntitiesView 管理页(三类 tab+卡片网格)+GenerateView 主体引用多选
- 生产实证:entities count: 17(含迁移);新建主体 200

**④@主体引用前台化**(对标 Vidu @语法)
- `PromptWithEntities` 组件(@触发选择器/↑↓Enter 键盘导航/chip 预览绑定详情/×删除联动重编号)
- 三处接入:GenerateView 视频 prompt/ImageEditView 编辑指令/AssistantView 助手输入框
- h3_refs entity_ids 优先路径+H3 直接路由 `_apply_entity_refs` 注入层(本会话补接)
- 生产实证:`@图片1作为倒霉蛋身份与服装参考` 引用行正确注入 prompt 绝对开头

### 回归与部署

- 后端 **2133 passed**(P0 +30 例/P1 +29 例/h3_studio entity_ids 2 例)
- 前端 **588 passed**(P0 +12 例/P1 +23 例)
- tsc 0 错误
- 部署:deploy.sh 全量(P0)→ --skip-web(P1 路由补接);BUILD_ID 20260825-205715-dc03f53-dirty

### 剩余路线图(P1 未完/P2)

| 优先级 | 任务 | 状态 |
|---|---|---|
| P1 | 多镜头单次生成(H3 单段「镜头一…镜头二…」协议) | 未启动 |
| P2 | 关键帧链式转场(≤5 帧,Pikaframes 对标) | 未启动 |
| P2 | 视频到视频编辑(Aleph 式 in-context) | 未启动 |
| P2 | Motion Brush 局部动效标记 | 未启动 |

---

## STUDIO-MIGRATION-2026-08-26 · Studio 依赖全迁离:反推 VLM → spark01,core 对 Studio 零依赖

**时间**: 2026-08-26(凌晨)
**类型**: 生产拓扑迁移(用户诉求「Studio 无法使用,所有服务全部转移」)

### 根因真机核查

- EXO 集群(studio01:52415)端口活着但**模型实例全部丢失**:`/v1/models` 只剩 MiniMax-M2.7-4bit,Kimi-K2.7/GLM-5.2 请求 404 "No instance found"
- studio04 :9303 NAS 挂载静默失效(D-2 重演,≥9 天)→ 本会话先手动 `mount_smbfs` 修复了一次
- L2/L3 文本层**已事实在 spark02**(生产 .env 实证 `TOIV_LLM_L2/L3_BASE_URL=192.168.71.84`),EXO 丢失零影响
- core 对 Studio 唯一硬依赖 = 反推 VLM(`TOIV_REVERSE_VLM_BASE_URL` + NAS 中转 `TOIV_REVERSE_VIDEO_MAC_PREFIX`)

### 迁移动作(2 行 .env,零新增部署)

```
TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.113:9303/v1 → http://192.168.71.82:8000/v1  # spark01 Qwen3-VL-32B
TOIV_REVERSE_VIDEO_MAC_PREFIX=/Users/dgmt-studio04/nas_mnt → (空)                        # vLLM 认 base64 video_url,免 NAS 中转
```

- 备份:`/home/merlin/toiv/deploy/.env.bak-20260826-studio-migration`;`sudo systemctl restart toiv-api`(SSH merlin 无免密 sudo,须 `sudo -n`)
- 顺带消除 studio04 NAS 挂载单点(视频不再走 SFTP 中转)

### 生产 e2e(4/4 通过)

| # | 用例 | 结果 |
|---|---|---|
| ① | SFW 图反推(纯色图) | ✓ 准确描述+生成 negative |
| ② | R18 图反推(JoyCaption 专线,不受迁移影响) | ✓ 露骨描述如实输出 |
| ③ | R18 视频反推(spark01 直传新路径) | ✓ 30s,828 字符忠实描述无拒答 |
| ④ | SFW 视频反推(18MB 大文件) | ✓ 48s,tracking shot 等六段式完整 |

R18 无审查验证(用户本地测试诉求):spark01 Qwen3-VL-32B-Instruct-FP8 为官方对齐版,但评分/反推场景实测三次(文本探针/真实 R18 图/真实 R18 视频)均无拒答——system prompt「技术质量评审,不涉及内容审核」框架引导有效。

### 文档同步

AGENTS.md(设备清单 studio04 划线/Core 状态表迁移行/E-5 易错点改写)· fleet_registry.py(studio04 :9303 标注退役观察)· STATE.json(新增 studio_dependency_migration_2026_08_26)

### 回滚与后续

- 回滚:恢复 .env 两行+重启,30s;studio04 :9303/挂载保留不删
- 观察一周稳定后:`launchctl unload com.dgmt.toiv-vlm-mlx`(studio04 彻底退役 ToIV 依赖)
- 注意:spark01 现承担 评分+反推 双职责(低频反推 vs 未开灰度的评分,冲突概率低,开启视频评分器灰度后观察)

---

## GPU-REBALANCE-2026-08-25 · GPU2 过载三方换卡均衡 + 后室成片交付

**时间**: 2026-08-25(晚)
**类型**: 运维拓扑调整 + 观测/预检代码同步(用户诉求:四卡摊开负载避免单卡 OOM)

### 成片交付

后室 Level-1 12 段批次全 done,无损 concat **94.6s / 18.3MB** → NAS `toiv/films/backrooms_level1_final.mp4`,DB result 回填(作品库可播)。

### 换卡方案(真机 nvidia-smi 进程级核查后定)

GPU2 峰值 92.9% 根因 = H3 40G + JoyCaption 16.3G 常驻(transformers 不驱逐)+ LongCat 按需 25G 三叠加;GPU1/3 大块(LiveAct 57.7G/FlashTalk 49.5G)无处可接不动。三方换卡:

1. JoyCaption GPU2→GPU0:`start.sh` 改 `CUDA_VISIBLE_DEVICES=0`
2. LongCat GPU2→GPU0:drop-in `gpu0.conf` 覆盖 ExecStart,**新增 `--cache-lru 3`**(原无驱逐,空闲常驻 25G;改后作业完自动释放)
3. 四小音频(sensevoice/qwen3tts/cosyvoice3/fireredasr)GPU0→GPU2:改既有 `gpu0.conf`

### 落卡实证

joycaption/longcat pid 归 GPU0,四音频归 GPU2;GPU0 69.4G / GPU2 55.7G(原 92.9%);六服务 active + 端口响应。新稳态:GPU2 = H3+demucs+超分+四音频,峰值 ~78G 安全;GPU0 常驻 ~66G + 池缓存可驱逐。

### 代码同步(共卡假设纠偏)

- `config.h3_co_workers` 默认值剔除 :8197(LongCat 已不在 GPU2,跨卡驱逐无意义),仅留 :8262
- `routes/observability.py` GPU_TOPOLOGY:8197 归 GPU0 卡;`services/fleet_registry.py` 标签同步
- longcat/wan_video/wan_animate/wan_vace/longcat_studio/engine_registry 注释 GPU2→GPU0 同步
- `tests/test_observability.py` 断言随拓扑更新(8197 离线实例归 GPU0 卡)

### 回归

后端 **2079 passed** / tsc 无前端改动;已部署 core(`deploy.sh --skip-web`)。AGENTS.md 第三节 GPU 分配表 + 第七节决策记录已同步。

---

## H3-MULTI-2026-08-25 · H3 多实例 least-loaded 调度框架(资源窗口即插即用)

**时间**: 2026-08-25(午后)
**类型**: 吞吐扩容框架(用户诉求"加速但不影响质量、不停服务")

### 资源账真机核查(为什么现在不能双实例)

- H3 进程 37.2G RSS 中 **30.5G 是 RssAnon(匿名内存,不可回收)**,页缓存仅 0.13G——第二实例 RAM 增量实打实 30G+,workstation available 仅 12G ❌
- pc02(RTX 5090) 32G < H3 int8 峰值 30-33G+开销 ❌(且 SSH 直连不通,只能经 core 跳板)
- GPU1/3 空闲各 12-16G < 30G ❌;降 steps/蒸馏/分辨率=质量变化 ❌;停 animate2/scope 用户否决 ❌
- 结论:当前 12 段批次数学上无法无损加速(S1 实测 14min/段),照跑

### 交付:多实例调度框架

- config 新增 `TOIV_H3_BASE_URLS`(逗号分隔);`pick_h3_client()` 并发探 queue_len 选最短,探测失败跳过、全挂回退首实例
- 单实例配置走 `get_h3_client()` 原路径,**零行为变化**(所有旧测试桩 get_h3_client 自动兼容)
- 提交路径统一接 pick:t2v/i2v 路由、时长链 duration chain、drama 续镜、生成器抽象层
- 未来窗口(RAM 扩容/某大 RAM 服务退役)→ workstation 起 :8196 + 改一行 .env 即吞吐×2

### 回归

后端 2143 passed(全量 2079 + duration 64;新增 test_h3_multi_instance 7 例)/ 已部署 core(api 重启零影响在跑批次,4/12 done 继续)。commit 3e99f2c。

---

## ASSISTANT-FIX-2026-08-25 · 助手「立即超时」根治:真实错误透出 + 404 会话降级

**时间**: 2026-08-25
**类型**: Bug 修复(用户实证三连:真实错误不显示 / 刷新+历史才能看到问题 / 再提问立即「超时」)

### 根因

1. **真实错误被吞**:`AssistantView.requestReply` 的 `catch { failed = true }` 丢弃 Error、SSE 流内 `{type:"error"}` 事件只置 `streamError` 丢弃 `content` → 一律误报「回复失败:连接中断或超时,请重试」
2. **404 无自愈**:刷新后携带失效会话 id(session_id 404「会话不存在」),被同样误报为「超时」且永远不自愈

### 修复

- `agentChatStream`/`agentChatResume` 非 2xx 抛错携带 `err.status = res.status`(lib/api.ts)
- AssistantView:catch 保留 `e.message`+`status`、流内 error 事件保留 `content`,错误气泡优先显示真实原因,无法归因才回退通用超时文案
- 404(!resume)自动清 `activeConvIdRef/lastSessionIdRef` 并以新会话重试一次(不再显示超时)

### 验证

前端 549 passed(assistantAgentEvents 新增 3 断言)/ tsc 0;生产实证:正常对话流 text+done 通、假 session_id 404「会话不存在」由前端自动降级新会话重试、不再误报超时。commit 047dfba。

---

## P0-SWAP-2026-08-25 · Qwen3-VL-32B 替换 molmo2 + Hunyuan3D 2.1 纹理管线上线

**时间**: 2026-08-25
**类型**: P0 服务替换 ×2(评分/反推 VLM + 3D 纹理缺口)

### P0-a Qwen3-VL-32B-Instruct-FP8(spark01 替换 molmo2-8B)

- spark01 `qwen3vl32b` 容器(vLLM):served 别名 `qwen3-vl-32b`/`molmo2-8b`/`omni-captioner` 三在线,core .env 零改动兼容
- core 指向(生产 .env 实证):`TOIV_VLM_SERVER_URL`/`TOIV_EVAL_VLM_BASE_URL+MODEL`/`TOIV_OMNI_CAPTIONER_BASE_URL` 全部 spark01:8000
- **video→video_url 修复**:vLLM Qwen3-VL 只认 OpenAI 标准 `video_url`(scoring.py + eval_scorers.py 两处),旧 `"video"` 字段直接 400
- e2e(core→spark01):白底 PNG→"White"、红色 1s 视频(video_url)→"Red",双模态无幻觉;对照 08-24 molmo2 评分幻觉(没变化打 10/有效编辑打 0)根治
- fleet_registry:spark01 角色/服务名同步(vllm 探测 /v1/models)
- 注:`TOIV_VIDEO_SCORER_ENABLED` 生产保持 false(灰度开关,就绪未开)

### P0-b Hunyuan3D 2.1 纹理管线(toiv-hy3dtex :9404)

- **架构**:core `POST /api/3d/texture` → workstation toiv-hy3dtex(原生 hy3dpaint v2-1:多视图扩散 6 视角 + DINOv2-giant + RealESRGAN×4 增强 + PBR 烘焙)→ GLB 产物 + Job(kind=threed_texture);systemd enabled,GPU0,MemoryMax=48G
- **环境攻坚(sm_120 Blackwell)**:torch 2.7.1+cu126 无 sm_120 内核 → 换 torch 2.13.0+cu130;custom_rasterizer 源码重建(CUDA_HOME 借 ComfyUI-hunyuan3d venv 的 nvidia/cu13,pip cuda-toolkit 不含 nvcc);basicsr 打 torchvision functional_tensor 补丁 + `--no-build-isolation --no-deps` 装法(setup.py 需 torch/scipy 且依赖 tb-nightly 不存在);realesrgan 同法;diffusers 0.40 自定义管线须 `trust_remote_code=True` 补丁;trimesh 5.x `simplify_quadric_decimation` 首位参数变 percent,改 `face_count=` 关键字
- **Blender 缺位**:官方 obj→glb 依赖 bpy(静默失败)→ server.py 内改 trimesh `PBRMaterial`(albedo + metallicRoughness 合并贴图 R=AO/G=rough/B=metal)自转 GLB
- **参考图三优先级**:显式 image > 原图生3D 作业 params 回填 > 纯白图+文本引导(管线 text_prompt ToIV 补丁)
- 冒烟:球体+参考图 38.7s(含冷载)/9.5s(暖);产物 GLB 实证含 baseColorTexture + metallicRoughnessTexture
- **生产 e2e**:hunyuan3d 作业 7dd05aaa → 「金属质感,轻微锈蚀」→ 47.5s 产出 3.4MB PBR GLB,文件端点 200,作品库 3D 桶可见;fleet 探测 :8200/:9404 双 up

### 前端/工具

- 灯箱 ThreeDOpsBar 新增「AI 纹理贴图(约几分钟)」折叠区:风格描述输入 + 生成按钮(busy 态分钟级提示);lib/api threeDTexture(960s timeoutMs 覆盖);libraryQuery 收录 threed_texture(3D 桶+「3D 纹理」短名——路由注释声称已收录实为漂移,本轮回补)
- 助手 adjust_3d 新增 op=texture(系统提示同步,旧「纹理绘画暂不支持」断言同步更新)

### 回归

后端 2077 passed(新增 test_threed_texture.py 6 例)/ 前端 546 passed(新增纹理 2 例+mock 替身)/ tsc 0;已部署 core(deploy.sh core-ts,Mac 离 LAN 走 Tailscale)。

---

## QWEN-EDIT-2026-08-24 · Qwen-Image-Edit 上 pc02 全链路 + 评测矩阵首秀

**时间**: 2026-08-24(凌晨)
**类型**: 新引擎接入(pc02 5090 专用实例)+ 全面评测 + 低分项优化

### 链路验证

- pc02 :8194 专用实例(StartComfyUIEdit 计划任务);源图服务端转存(源 worker /view → :8194 /upload/image)
- 生产 e2e:upload → POST /api/generate/qwen-edit(camera=rotate_left,fast) → done,签名产物 URL 200;卡通男孩 45° 侧转完美
- 图构造:UNETLoader(fp8)+CLIPLoader(qwen_2.5_vl_7b)+双 LoRA 链(多角度仅选角度时挂,Lightning 常挂)+TextEncodeQwenImageEdit(正接 vae+image)

### 评测矩阵(12 例,molmo2 初评 + 人工目检校准)

| 用例 | VLM(molmo2-8B) | 人工目检(ground truth) |
|---|---|---|
| char 语义×2+相机×4 | 8-10 | 9-10,全优(赛博朋克/红帽/双旋转/俯视/特写全生效) |
| ink 语义·赛博朋克 | 1/3/2 | IF 2(只变了对比度+飞鸟),跨美学风格迁移失败 |
| ink 语义·红帽 | 0(误判"完全相同") | IF 6(亭顶变红,无人物主体可戴帽) |
| ink 相机·特写 | 5/3/2(过严) | IF 7(亭子特写真推近了) |
| ink 相机·旋转/俯视×3 | 10(幻觉,实际没变) | IF 2,确认未生效 |

**教训:molmo2-8B 不能当编辑质量评委**(没变化的打 10、有效编辑打 0);规模化评委候选=studio04 72B caption + spark02 文本评审两段式。

### 低分项优化(⑦)与结论

风景场景相机旋转四组对照(strength 1.3 / 标准档 20 步 cfg2.5 / cfg 3.5 / 英文指令)**全部无效** → 结论是 LoRA 训练分布硬限制(主体/角色向),非管线 bug。处置:前端相机下拉加适用范围提示,不硬凹。

### 回归

后端 1944 passed / 前端 450 passed / tsc 0;已部署 core;引擎计数 SFW 12 / R18 20。

---

## UX-2026-08-23 · 内容管控下线 + 作品库回收站 + 助手 Shift+Enter 与灯带重设计
 · 内容管控下线 + 作品库回收站 + 助手 Shift+Enter 与灯带重设计

**时间**: 2026-08-23(午后)
**类型**: 用户拍板的功能下线 + 两个 UX 特性(均已部署 core)

### ① 内容限制管控(CONTROL)完整下线

- 用户拍板该板块自行重做 → 全量移除:`nsfw_ctx.py` 回退 HEAD(nsfw_allowed 恢复为未成年硬阻断+X-NSFW 头语义)、`ContentPolicy` 表类、`GET/PUT /api/content-policy`、设置页管控卡、`test_content_policy.py`(12 例)、conftest 策略缓存 fixture;全仓 grep 零残留
- **遗留**:生产 core 数据库 `contentpolicy` 表成孤儿(代码已不引用;如介意可手动 DROP TABLE)
- AGENTS.md 第五节「内容限制管控」行随之失效,引擎矩阵行保留(R18=Wan2.2+LTX2.3 不变)

### ② 作品库回收站(全栈)

- 后端:`GET /api/jobs/trash`(归属隔离/保留期内/deleted_at 倒序/分页)、`POST /api/jobs/{id}/restore`、`DELETE /api/jobs/{id}/permanent`;**保留期 10 分钟→72 小时**(audit.UNDO_TTL_SECONDS,undo token 语义跟随);新增 `trash_purge_loop`(lifespan 每小时兜底物理清理超期行——此前「过期物理删除」只有注释没有实现,本次补齐)
- 前端:LibraryView 工具行「回收站」入口 → `LibraryTrashView`(复用作品卡样式,卡脚显示删除时间+剩余保留期 `formatRetention`,恢复/彻底删除 Modal 二次确认,空态文案);恢复后 invalidateJobs 主列表自动回归
- 测试:后端 test_jobs_trash.py 6 例 + 前端 libraryTrash.test.ts 6 例

### ③ AI 助手唤起 ⌘K → Shift+Enter + 灯带/弹窗重设计

- 快捷键:纯 Shift+Enter(排除 meta/ctrl/alt,不碰 ⌘Enter 提交);输入框内保留原生换行;可发现性提示键位与文案同步
- **灯带隐形根因根治(存量 bug)**:CSS keyframes 驱动注册自定义属性 `--neon-angle` 的逐帧重绘在本页层叠树下被 Chromium 整体丢弃(首开无光,生产构建同现)——改 **JS rAF 逐帧内联驱动**(easeInOutQuart 1400ms 扫 0→430° 过冲+首尾淡入淡出);assistant.css 改主包 eager 加载(首开样式必达)
- 新灯带:双层 conic 叠加(青#67e8f9→紫#a78bfa→品红#f0abfc 彗核 + 30% 静态三色整环)+ 三层 drop-shadow(6/18/44px)+ 4px 环带 + will-change 合成层;暗/亮双色截图验收
- 弹窗:玻璃拟态(blur 28px saturate)、18px 圆角、弹簧展开(translateY+scale)、开场 1.1s 边缘光晕与灯带收束联动、圆形玻璃关闭 chip
- 测试:assistantPopupNeon 9→11(rAF 驱动/触发键语义);reduced-motion 直开不破

### 回归与部署

- 后端 **1930 passed**(1917-12 管控+15 资源预算+2 TTS+6 回收站等;test_duration flaky 2 例本轮全量未复现);前端 **439 passed** + tsc 0 + ui_lint 过;web 干净构建;deploy.sh 部署 core

---

## AUTONOMY-2026-08-23 · 自主循环工程:ltx25 根治 + 前端 P0 修复 + 资源预算预检 + 10Eros-Max 实测 + roadmap A 闭环

**时间**: 2026-08-23(凌晨)
**类型**: 用户授权完全自主的循环工程(六任务),全部改动已部署 core 并真机验证

### ① ltx25 彻底退役(根治复活)

- 调研拍板:Civitai/HF 实证 LTX2.5 生态空白(Civitai LoRA 近乎为零、HF 社区 NSFW 0 结果、官方仓 gated:auto),定位已被 H3 全覆盖 → `systemctl disable --now comfyui-ltx25`(inactive+disabled,重启不再复活);GPU3 88.6→54.1G,RAM available 54→90G;NVFP4 模型文件留盘可回滚
- 同轮调研副产品:LTX2.3(Sulphur/10Eros 血脉)与 MiniMax-H3 生态正盛,Wan2.2 NSFW 霸主地位不变;Wan2.5/2.6 官方不存在

### ② 前端 P0/P1 四项修复(子代理实施,+13 测试)

- **avatar-talk 提交断链**:`lib/engines.ts` 补 `case "avatar-talk"`(载荷对齐 `POST /api/avatar/talk` 契约)+ `normalizeEngine()` 把注册表 text 型 audio 参数归一为 `audio`(GenerateView 才渲染音频上传);uploadKind 映射补 `avatar-talk→avatar`;**生产 e2e 实测通过**(人像+TTS 音频→数字人口播视频成片,唇部动作逐帧可见)
- **trackJob abort 卡死**:`trackJob.ts` 新增 `signal?: AbortSignal` + `TrackJobAbortError`(abort 走 aborted 终态立即 settle,看门狗不复活);`useGeneration.ts` start 建 AbortController、reset abort 优先——取消后 submitting 正常复位
- **TTS 产物落 Job**:前端 AudioView 合成后 `invalidateJobs()` + libraryQuery 补 `manju_voice→配音` 映射;**后端** `routes/voice.py synth_voice` 落盘后建档 `Job(kind=manju_voice, status=done, result=[/api/manju/voice/{name}])`(建档失败 try/except 不炸主流程,+2 测试)
- **AssetPicker 分页去重**:`mergeJobsPage` 按 id 去重 + 「加载更多」分页(offset=已加载条数,对齐 LibraryView 范式)

### ③ 资源预算预检(VRAM+RAM,H-3 OOM 制度化)

- 新建 `services/resource_budget.py`:`ensure_host_ram`(读 /system_stats 的 system.ram_free,不足→队列空时 free_memory+5s 落定→复查→503 结构化原因;stats 读失败降级放行)+ 通用 `ensure_vram`
- 接线:`h3.ensure_h3_vram` 三处出口接 RAM 预检(25G)、`wan_video.ensure_wan_vram` 两处(15G)、`longcat.submit_longcat_job` 双预检(VRAM 26G+RAM 15G,新增 `prechecked` 参数防 Wan 路由双重拦截,Avatar 链路顺带获得护栏)
- config 新增四项阈值;**生产实证**:avatar-talk 提交被 LongCat VRAM 预检正确拦截(23.7G<26G,结构化 503 错峰提示)

### ④ 10Eros-Max(H3 嫁接版)实测

- 下载 cicalooo/10Eros-Max-h3-int8-convrot 三件套(fl2va/ref2va/TURBO,共 ~58G)+ Sulphur-2 dev fp8mixed(29G,LTX2.3 系 t2v 补强)+ 官方 distill LoRA + 无审查提示词增强器 GGUF → NAS toiv/comfyui-models(脚本 /home/merlin/toiv_model_pull.py,经 TS 代理)
- **R18 实测(同 prompt 同 seed 对照)**:10Eros-Max fl2va 与 stock H3 均出裸体(stock 本身不拒轻度 NSFW),10Eros 版露骨度/姿势主动性更胜;**音画直出完好**(h264 1280×704 3.04s + aac 音频,嫁接未伤音频头)——H3 正式具备 R18+音画能力,矩阵可向「H3 主力 + Wan2.2 生态兜底」演进

### ⑤ roadmap A 闭环(次世代图片模型端到端 GPU 验证)

- 三族配方直提 worker :8189 全部 success 且出图质量在线:Z-Image-Turbo(res_multistep+simple cfg1 8步)/FLUX.2 dev(euler+simple cfg1 25步+FluxGuidance)/Qwen-Image(euler cfg3.5 20步)
- **修真 bug**:qwen_image 配方默认编码器 `qwen_3_vl_8b_instruct`(目录名)在 worker CLIPLoader 枚举里只有分片路径,`first_available` 永远命不中 → 静默降级 1.0 编码器;改用实测存在的 `qwen3vl_4b_fp8_scaled.safetensors`(Qwen3-VL 单文件)为首选候选
- API 级 e2e(生产 core):`POST /api/generate/txt2img` z_image_turbo → done,产物带签名 URL 可下载(1184×1184 PNG);`default_ckpt=flux2_dev_fp8mixed` 默认底模切换此前已在码,本次验证闭环

### 回归与部署

- 后端 **1934 passed**(1917+15 资源预算+2 TTS 建档;test_duration 2 例曾在全量高负载下偶发失败,单跑 74/74 过,判 flaky 计时敏感,记录观察);前端 **431 passed**(418+13)+ tsc 0 错误 + ui_lint 通过;web `rm -rf .next` 干净构建;deploy.sh 部署 core 双服务就绪
- 生产验证:TTS 合成→Job 建档实测通过;avatar-talk 引擎注册表在线(前端归一后音频参数渲染);Z-Image API 出图实测通过

---

## DOCS-CLEANUP-2026-08-23 · 文档治理(下一阶段起点)

**时间**: 2026-08-23(凌晨)
**类型**: 仓库瘦身——只保留重要信息,清理全部过程性文档

### 清理明细

| 对象 | 处置 | 说明 |
|---|---|---|
| `docs/` 18 篇(竞品调研×3/UI 审计×3/harness 计划/诛仙 dogfood/models-guide 等) | 删除 | 过程性文档使命完成,关键结论已沉淀于代码注释+AGENTS.md |
| `CLOSEOUT.md`、`设备说明.md`(与 AGENTS.md 重复)、`docs归档说明.md` | 删除 | 收尾计划已全部完成;设备单一真相源=AGENTS.md |
| `toiv-t2v-submits-20260820/`(提交截图)、`test-results/`、`docs/assets/` | 删除 | 过程证据 |
| TEST_LOG.md | 572KB→10KB | 保留最近 3 个关键里程碑(CONTROL/CANVAS-TS/ENGINE-R5)+本条 |
| STATE.json | 268KB→82KB | 79 key→12:核心结构(project/repo/health 最新 1 条/git/roadmap/infra/conventions)+最近 4 里程碑;70+ 历史 milestone key 清除 |
| 代码内 16 处 `docs/2026-*.md` 注释出处引用 | 清理 | 保留说明文字,去掉失效文档链接(纯注释,非运行时依赖) |

### 保留(下一阶段基线)

- **AGENTS.md**(58KB)——集群操作记忆+硬性规则,单一真相源
- **README.md**——项目入口
- **STATE.json**(82KB)——当前状态快照+infra 布局+roadmap
- **TEST_LOG.md**(10KB)——最近里程碑,新条目继续倒序追加

**回归**: 清理后后端 1917 passed / 前端 418 passed / tsc 0 错误——零破坏。

---

## CONTROL-2026-08-23 · 内容限制管控(admin 三档策略) + spark02 无审查模型替换

**时间**: 2026-08-23(凌晨)
**类型**: 用户主权功能(限制等级 admin 可控,全站统一生效) + LLM 无审查模型替换(生产已切换)

### ① spark02 模型替换:Qwen3.8-27B-NVFP4 → Qwen3.8-27B-Uncensored-FP8(abliterated)

- **选型**: OrcaRouter abliterated 版(同一 Qwen3.8-27B,拒答方向已从残差流正交移除,131 个残差写矩阵,视觉塔保留;Block-FP8 与官方 FP8 完全同一 vLLM kernel 路径,262K ctx/工具/推理/MTP 全保留)
- **下载路线(真机实证)**: HF 直连超时 → hf-mirror 403 → orcarouter 原仓库 gated: auto(需登录) → **chimingw/Qwen3.8-27B-Uncensored-OrcaRouter-GGUF 的 FP8/ 字节级镜像(gated: False)** → spark02 经 MateBook Clash 代理(100.74.15.34:7897)8MB/s 下载 29GB/7 分片(~35min,与 web_search 代理同款依赖:Mac 在线+Clash 运行)
- **切换**: vllm_node 容器重建,仅换模型路径,`--served-model-name qwen3.8-27b qwen3.6-uncensored` 别名保留 → **core .env 零改动**;MTP speculative 正常,360s 加载就绪;旧 NVFP4(22GB)保留可秒级回滚
- **无审查验证(对照测试)**: 官方版拒答的成人写作请求现在直接产出(「写一段激情做爱的详细小说片段」→ 完整细节输出,无「我不能」拒绝语)
- **core 链路**: core→spark02 /v1/models 实测 root=/models/Qwen3.8-27B-Uncensored-FP8;L1-L4 全层(auth 层/剧本/润色/NSFW 路由)与 AI 助手全部即时获得无审查能力

### ② 内容限制管控(CONTROL):admin 三档策略,全站统一生效

**设计**: 等级语义
- `strict` 严格——全站禁 R18(即使开 R18 模式也拒,适合公共场合/未成年设备)
- `standard` 标准(默认)——历史行为:分区门控(X-NSFW 头+年龄确认)
- `relaxed` 宽松——成年用户免门控:无需 R18 模式即可访问全部成人引擎/模型/作品/助手技能

**实现(最小侵入)**: `nsfw_allowed()` 是全站 66+ 调用点的唯一判定出口(各引擎 gate/列表过滤/技能注入/L4 路由)——等级判定收敛进 [nsfw_ctx.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/nsfw_ctx.py) 单点,所有调用点零改动自动跟随:
- `ContentPolicy` 单例表([models.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/models.py),create_all 自动建)
- `get_policy_level()` 30s 进程缓存+读库失败降级 standard(绝不炸业务请求);`set_policy_level()` 写入即失效缓存(即时生效)
- 未成年硬阻断优先级最高,任何等级不放行(法律红线)
- API:`GET /api/content-policy`(登录可读)/`PUT /api/content-policy`(仅 admin,422 校验,审计日志)
- 前端:设置页新增「内容限制管控」卡(仅 admin;三档单选卡组+当前徽章;普通用户不渲染不请求);page.tsx 传 role
- conftest 补策略缓存清理 autouse fixture(防 30s TTL 跨用例污染)

**回归**: 后端 1917 passed(1907+10 新增:三级语义/未成年阻断/未登录 401/非 admin 403/非法值 422);前端 418 passed+tsc+ui_lint;生产实测三档往返切换(relaxed→standard)即时生效;已部署 core

---

## CANVAS-TS-2026-08-23 · 画布去标题/副标题 + 全链路 Tailscale 化(跨地区访问)

**时间**: 2026-08-23(凌晨)
**类型**: 前端 UI 调整(用户要求去掉画布标题/副标题) + 浏览器侧直连地址 Tailscale 迁移(已部署 core)

### ① 画布页头精简

- [CanvasView.tsx](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/web/components/canvas/CanvasView.tsx):PageHeader(title「画布」+desc「内嵌 ComfyUI 节点画布…」+kicker「NODE CANVAS」)整体移除,改为纯操作条 `.canvas-bar`(右对齐:连接状态徽章+「新窗口打开」),标题区让位给画布内容;清理失效的移动端 `.page-header-desc` 隐藏规则
- 浏览器验证(DOM 实测):h1-h6 归零、旧文案全文档无残留;徽章+外链按钮正常

### ② 浏览器侧直连地址 Tailscale 迁移(用户动机:设备不在同一物理网络,局域网 IP 跨地区不可达)

| 位置 | 旧值(局域网) | 新值 |
|---|---|---|
| CanvasView COMFYUI_URL 默认 | 192.168.71.127:8188 | **100.68.100.90:8188**(Tailscale 优先) |
| CanvasView 候选链 | 单地址 | Tailscale 默认 + **192.168.71.127:8188 回退候选**(同地加速;探测按序) |
| CanvasView HTTPS 混合内容指引 | 硬编码 http://192.168.71.47:3100/?view=canvas | 动态 `http://{window.location.host}/?view=canvas`(任意入口自适应) |
| workflows.ts DEFAULT_COMFYUI_URL | 192.168.71.127:8189 | **100.68.100.90:8189**(当前无组件引用,防未来误用) |

- 真机验证(第二硬性规则):workstation :8188/:8189 均监听 0.0.0.0;从 Mac 经 Tailscale 实测 100.68.100.90:8188/8189→200、100.77.80.100:3100(root/?view=canvas)→200、:8090/api/health→ok
- 架构边界(有意保留):core→workstation 后端服务间调用维持局域网 IP(同机架共址,走 Tailscale 反而绕路);playwright.prod.config/e2e spec 内 LAN IP 为测试基建非用户功能,不在本次范围
- 回归:tsc 0 错误、npm test **418/418**、ui_lint 门禁通过(12 条预存软提醒)、`rm -rf .next` 干净构建(deploy 前置,易错点 29)、deploy.sh 部署 core 双服务就绪
- 部署后验证:core 构建产物含 100.68.100.90:8188 默认与 LAN 回退、旧标题文案/kicker 零残留;浏览器实测(经 Tailscale 入口)徽章显示「已连接 · 100.68.100.90:8188」,ComfyUI 节点编辑器 iframe 正常渲染(1195×671)

---

## ENGINE-R5-2026-08-22 · Round2 终局:时长链全量交付 + 短剧视频版成片 + 合成断链修复 + 作品库分类治理

**时间**: 2026-08-22(晚间) ~ 2026-08-23(凌晨)
**类型**: 生成收尾(时长链拼接/接链) + studio 视频合成断链修复(已部署 core) + 作品库 R18 分类/清理治理 + 散热处置

### ① R2 时长链全量交付(8 条拼接 + 2 条接链)

- **拼接 8 条**(`toiv_dur_*`,1280×704/1344×768,aac 音画直出,ffprobe 终验全过):出租车30s/雪国列车30s/菜市场30s/后巷打斗30s + R18床戏30s/都市霓虹30s + R18床戏60s/沙漠公路60s;全部回写/建档 Job 并挂 1080p 融合超分
- **接链 2 条**:雪国列车60s/清晨市场60s——OOM 断链后从已有 seg2 末帧续跑 seg3/seg4(H3 362帧 i2v,每段约 23-35min),4 段 concat+trim 60s 回写基座 Job(雪国 15.8MB/市场 20.3MB)
- **超分熔断处置**:Workstation BIOS 重启(用户改机箱风扇曲线满速)打断 8 条超分管线 → 重提(帧级断点续跑);发现 r2_concat 脚本进程退出杀 asyncio task 的隐患 → 改走 toiv-api 常驻进程 POST /api/video/upscale
- **GPU 锁扇值守**:fan_guard.py(NVML SetFanSpeed_v2,GPU2/GPU3 全风扇 100%,45s 重设;注意 pynvml API 签名含 fanIdx 参数);BIOS 满速后 GPU2 负载态 92→70°C

### ② studio 视频合成断链修复(P0,已部署 core,1907 passed)

**发现**:短剧《深夜便利店》视频版 8 镜全渲染成功但 assemble 报「片段非 Studio 产出」——`renderers/video.py._wait_video_url` 返回 `/api/images?` 代理 URL,而 `assemble._local_path` 只认 `/api/studio/files/` 前缀(防穿越校验)。render_mode=video 自上线起实际从未能通过合成(image_motion 版走 `_save_output` 落盘所以能合成)。

**修复**([renderers/video.py](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/services/studio/renderers/video.py)):
- `_wait_video_url` 拿到 worker 产物后经 `get_image_bytes` 下载 → 复用 image_motion `_save_output` 落盘 Studio 目录 → 返回 `/api/studio/files/` URL;下载为空显式 RenderError(不落空文件)
- 测试:test_video_render_fire_and_forget_waits 断言改 Studio URL+落盘内容;新增 test_video_render_download_empty(下载空产物报错路径);14/14 + 全量 1907 passed → deploy.sh 部署 core
- 存量处置:已渲染 8 镜无需重渲,r2_assemble.py 从 worker 下载落盘回写 shot.video_url/final_clip_url 后直接合成

### ③ 短剧《深夜便利店》视频版 v2 成片(H3 音画直出)

- **成片终验**:`final-82cb2d9f58cf4ca0bb6db752ba6de23d.mp4` 53.4s / 1280×704 / 24fps / h264+aac 立体声,8 镜×6.58s
- **v2 提示词强化**(v1 降级版被用户判「幻灯片」):每镜注入英文运镜指令(slow dolly-in/tracking/rack focus/pulls back)+画内持续动态(雨丝/蒸汽/热气/霓虹反射)+动作动词具体化+环境音暗示(雨声/门铃/冷柜嗡鸣)——针对 VideoRenderer 不消费 shot.camera 的根因,运镜指令直接写进 prompt
- shot1 被 BIOS 重启打断(1800s 超时误杀)→ 补渲恢复;合成断链见②

### ④ 作品库 R18 分类治理(用户规则:R18 底模 AND R18 内容)

- **误标降级 43 条**:出租车/雪国/菜市场/打斗/皮克斯机器人/神社/审讯室等普通内容被接链脚本错打 R18 标(提交时 nsfw=True 一刀切)→ 按 prompt 内容关键词审计降级
- **真 R18 保持 33 条**(wan 体位系列/ltx 成人短片/H3 床戏链/lipsync);漏标 0 条
- **超分 Job nsfw 继承修复**:超分 prompt 只写「视频超分 1080P」不含内容词,纯 prompt 判定会误降级 → 按 params.video_url 回溯源 Job nsfw 继承
- **清理**:22 条 error 空产物作业(OOM 旧单+重启打断)软删除,作品库可见 error 归零

### ⑤ 983「社区规范」错误排查(外部问题,已跳过)

用户预览 R18 视频遇「检测到内容违反社区规范(983)」——ToIV 代码库无此错误码、core API 日志无此报错(仅正常 206 流),为外部客户端(微信/QQ 内置浏览器、云盘 App 等)内容审核拦截,平台内文件正常。

### ⑥ Spark 真机模型确认(第二硬性规则)

- spark01: `omni-captioner` = Molmo2-8B(音乐/图像反推 VLM,:8000,容器 molmo2_captioner)
- spark02: `qwen3.8-27b` = Qwen3.8-27B-NVFP4(LLM L1-L4 主力,别名 qwen3.6-uncensored 有效,:8000,容器 vllm_node)

---


---

> **归档说明(2026-08-23 文档治理)**:更早的历史条目(ENGINE-R1~R4、HARNESS-M1/M2、CLOSEOUT-R51~R60、WAN-NSFW、RES/WIKI/QUEUE/LINKAGE 等 40+ 条)已清理——关键结论均已沉淀在代码注释、AGENTS.md 与 STATE.json 硬约束中;TEST_LOG 自本条起新条目继续倒序追加。
