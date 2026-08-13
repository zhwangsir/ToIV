# docs 归档说明

> **由来**：原 `docs/` 目录 6 份文档（2026-08-09 ~ 2026-08-12）已删除，其中有持久参考价值的内容汇总于此。
> **注意**：本文是历史归档；涉及容量/状态/路径的结论以真机当前输出与 AGENTS.md / 设备说明.md / STATE.json / TEST_LOG.md 为准。
> **归档时间**：2026-08-12

---

## 一、服务选型结论（源自 2026-08-09-service-replacement-research.md）

> 该调研的 Phase 1 迁移已执行完毕（demucs→studio01、ASR→studio02、vLLM embed 测试实例停用），以下为「为什么不换」的选型依据，后续评估替代品时参考。

| 服务 | 结论 | 关键依据 |
|------|------|---------|
| IndexTTS2 (TTS) | **不替换** | 中文韵律、12 情感控制、token 级时长控制在开源方案中难替代；Qwen3-TTS MLX 仅可作非情感场景补充 |
| ASR | **已迁 whisper.cpp large-v3-turbo**（studio02 :9212） | Core ML/Metal 比 mlx-whisper 快；large-v3-turbo 为官方蒸馏，WER/CER 对比=0 后切流 |
| demucs 人声分离 | **已迁 demucs-mlx**（studio01 :9221） | 与 PyTorch bit-exact，速度快数十倍 |
| SenseVoice | **留 Workstation GPU2** | 唯一把 ASR+情绪+事件+LID 合一的小模型，Mac 无功能等效替代；1.5GB 占用迁出收益低 |
| JoyCaption Beta One | **留 GPU3 bf16，不迁 Mac** | 无原生 MLX 支持；GGUF 量化损失 NSFW 反推细节且更慢；⚠️ vLLM 0.11.2 跑 LLaVA 架构会 device-side assert，只能 transformers 直跑 |
| Qwen3-Embedding-4B | **生产保持 sentence-transformers**（GPU1 :9302） | vLLM 版更慢且有精度 discrepancy 风险；如需升质可考虑 8B 独立部署；高并发再评估 infinity（须严格召回对比） |
| VLM 反推 | **已落定 studio04 Qwen2.5-VL-72B-4bit**（:9303） | mlx-vlm；视频只认本地路径→NAS 中转（TOIV_REVERSE_VIDEO_MAC_PREFIX） |

**迁移原则（仍然有效）**：质量不下降须 A/B 验证后切流；Mac Studio 优先 MLX，GGUF 仅备选；一切结论真机验证优先。

---

## 二、H3 压测核心数据（源自 2026-08-09-comprehensive-stress-test-report.md）

> 散热约束已进入 AGENTS.md 易错点 20；此处保留详细数据备查。

- **H3 长视频实测**（832×480, steps=20, 2026-08-09）：13 作业 12 成功；单作业最大 362 帧 248.5s 通过；连续 5/5、并发 124+141 帧 2/2 通过；192 帧偶发 88°C 熔断（冷却后通过）。
- **散热瓶颈**：GPU 满载 ~600W，38°C→88°C 约 2 分钟；并发峰值 92-93°C。≥85°C 熔断、冷却 <60°C 恢复是生产硬策略。
- **LLM（spark02 qwen3.6-uncensored, 32K 窗口）**：大海捞针 10/10=100%；并发 5 路 0 失败；TTFT <600ms；吞吐 21-23 tokens/s（并发时）。
- **Core API 回归**：16/17 通过（upload_audio 偶发 503 为 ACE-Step worker 池瞬态）。
- **当时修复**：`/api/reverse` 502 = .env 缺引号 + studio04 mlx-vlm 自定义 `/v1/reverse` 端点 → reverse.py 增加 OpenAI/MLX 自动适配回退。

---

## 三、H3 R18 LoRA 资产清单（源自 2026-08-12-h3-nsfw-dual-engine.md）

> 已下载至 NAS `toiv/comfyui-models/h3/loras/`，经 extra_model_paths 注册；门控名单在 `apps/api/app/services/h3.py H3_NSFW_LORAS`。后续扩充 LoRA 时对照此表避免重复。

| LoRA 文件 | civitai ID | 用途 |
|---|---|---|
| HMNSFW_AIO_V2.safetensors | 2834417 | AIO 综合（I2V/T2V） |
| stomach_bulge_H3_i2v_v1.0.safetensors | 1445226 | Stomach Bulge（I2V） |
| riding_pose_H3_i2v_v1.0.safetensors | 2446218 | Riding POV（I2V） |
| deepthroat_v1.safetensors | 2476698 | Deepthroat |
| SexGod-NaughtyTimes-lora-MINIMAXH3.safetensors | 2836176 | NaughtyTimes |
| h3_musubi_v4-000040.safetensors | 2841940 | Innie Pussy |
| minimax_vag_000002500.safetensors | 2835594 | Vagina v0.2 |
| vagassist_e40.safetensors | 2846342 | HMPussy v0.5 |
| H3_footjob_v0_step1000_fixed.safetensors | 2839680 | Footjob |

**排除项**（勿误入 R18 名单）：`AI_Girl_Fictional_Women_Series30`（官方 nsfw:false）、`cxy_kiss_lora`（浪漫向 SFW）、`minimax_h3_turbo_*`/`tutu_t8_*`（加速蒸馏）。
**技术要点**：musubi 系 LoRA 只含 DiT 权重，走 `LoraLoaderModelOnly` 链；自训可用 Ostris AI Toolkit。
**NSFW 双引擎分工**：LTX2.3+10Eros 走快出片；H3+R18 LoRA 走高质量音画同发成片；共用 :8195 实例与既有温度熔断，不新增机制。

---

## 四、4K 链路决策（源自 2026-08-09-ai-short-drama-4k-plan.md）

> 该计划已实施为 M6 超分 fleet（AGENTS.md 有记录）：GPU1/2/3 各一 upscale-only 实例 :8261/:8262/:8263，仅跑 4x-UltraSharp 帧超分，不入 LB 池；真机冒烟 128 帧 3 卡并行 52s（≈3× 加速）。

**核心决策（仍然有效）**：
- 本地引擎均不支持原生 4K → 4K 走「低分辨率生成 + 帧级超分（Real-ESRGAN/4x-UltraSharp）」路线。
- 超分后缩放目标 3840×2160（lanczos）；若帧级超分时序闪烁严重，再调研 BasicVSR++/VideoSR 时序一致方案。
- 短剧角色一致性方案：FLUX 关键帧 + i2v 首帧锁死（不依赖未训练 LoRA）；可选 IPAdapter 加固（权重 0.6-0.8）。

---

## 五、音频链路修复要点（源自 2026-08-10-audio-fix-and-layout-redesign.md）

> 代码已合入并全量测试通过，此处留修复模式备查。

- `/api/audio/files/{name}` 支持 Range（206）：复用 `routes/images.py` 的 `_ranged_response`，整读上限 50MB。
- ACE 音乐产物 Content-Type 按扩展名修正（ComfyUI `/view` 对非图片默认回落 image/png 会导致浏览器拒播）：`.mp3→audio/mpeg`、`.wav→audio/wav`、`.flac→audio/flac`、`.ogg→audio/ogg`。

---

## 六、NSFW 主站整合（M9）要点（源自 2026-08-12-nsfw-main-integration.md）

> 已全量实施（M9 里程碑，pytest 1189 + e2e 通过），规则已进 project_memory.md。此处留架构判断备查。

- 后端门控与路由解耦：全站 81 处统一走 `nsfw_ctx.nsfw_allowed(user)`（X-NSFW 头 + 未成年硬阻断）；整合时后端零改动。
- R18 为全局内容模式而非独立页面：开关在设置页，localStorage 持久化 + `setNsfwIntent` + SWR 双键缓存失效 + `toiv:r18-changed` 事件广播。
- 不做账户级开关（与后端 header-only 设计冲突）；/nsfw 旧链接 redirect("/") 保留路由不 404。
- 引擎注册表每引擎含 `source`（名称/出处 URL/出品方）+ probe 可用性探测 + 「重新检测」端点 `POST /api/models/engines/refresh`。
