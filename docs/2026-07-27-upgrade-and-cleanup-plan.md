# ToIV 升级与清理总计划（2026-H2）

> 创建：2026-07-27
> 来源：① 当前项目问题排查；② LLM / 语音 / 视觉三轮模型替代调研
> 目的：把"当前已知问题"和"模型/服务升级机会"合并成一份按优先级排序的可执行清单，后续集中处理
> 调研依据：设备说明.md（2026-07-27 最新版，core 监控中心维护）

---

## TL;DR 关键结论

- **3 个 P0 必修问题**（配置失效导致功能不可用）：VLM 旧 IP、ComfyUI 含停用 worker、本地缺 faster-whisper
- **3 个 P0 高价值升级**（成本低收益大）：
  - **L4 NSFW**：Euryale 70B → `Qwen3.6-35B-A3B-Uncensored-HauhauCS`（中文 2/5→5/5，释放一整台 DGX Spark，速度 3 倍）
  - **TTS**：edge-tts 封装 → IndexTTS2 完整版（契约 1:1 兼容，业务代码零改动）
  - **Embedding**：nomic v1.5（2024 落后）→ Qwen3-Embedding-4B + Reranker
- **3 个 P1 升级**：L1 LLM（Nemotron→Qwen4.1）、ASR（base→SenseVoice）、VLM 增配（Qwen3-VL-8B 时序评分）
- **保留不动的**：Nemotron-3-Omni（VLM，2026-04 最新）、LTX-2.3 视频（2026-03 最新）、10eros v1.4 NSFW 视频

---

## 第一部分：当前项目问题清单（2026-07-27 排查）

### P0 — 功能阻断（配置失效）

| # | 问题 | 文件 | 影响 |
|---|------|------|------|
| 1 | VLM 评分地址硬编码旧 Tailscale IP `100.99.181.103:8200`（已废弃） | [config.py:128](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/config.py#L128)、[scoring.py:238](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/scoring.py#L238) | 视频评分功能完全不可用 → 应改 `http://192.168.71.127:8000`（Nemotron 全模态） |
| 2 | `TOIV_COMFY_WORKERS` 含已停用的 `:8192`（GPU3 让给 Nemotron） | [.env](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/.env) | 请求路由到无效 worker → 应移除 :8192，保留 5 后端 |
| 3 | [system.py:50](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/routes/system.py#L50) 硬编码 `192.168.71.100` 过滤逻辑 | system.py | 过滤永远落空回退全量 |
| 4 | 本地 venv 缺 `faster-whisper`（Dockerfile 装了，requirements.txt 没导出） | [Dockerfile:31](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/Dockerfile#L31) | 本地开发跑听写 ModuleNotFoundError |

### P1 — 文档/默认值过时

| # | 问题 | 文件 |
|---|------|------|
| 5 | [AGENTS.md](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/AGENTS.md) 三处过时：L1 引擎标 SGLang（实际 vLLM+Nemotron）、ComfyUI-LB 标 6 后端（实际 5）、pc01 标 v0.25.0（实际 v0.28.0） | AGENTS.md |
| 6 | config.py 默认值仍用旧 IP `192.168.71.100`（实际 .127）：comfy_workers / forge_url / tts_url | [config.py:15,32,34](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/config.py) |
| 7 | [workflows.ts:46](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/web/lib/workflows.ts#L46) 前端 `DEFAULT_COMFYUI_URL` 硬编码 `192.168.71.100:8000` | workflows.ts |
| 8 | [.env.example](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/.env.example) 多处旧 IP | .env.example |

### P2 — 仓库卫生

| # | 问题 | 体积 |
|---|------|------|
| 9 | 根目录 `models/` 未入仓也未 gitignore | **33GB** |
| 10 | 根目录 `opentalking/` 是嵌套 git 仓库（独立项目），违反项目隔离纪律 | **2.7GB** |
| 11 | 根目录 `drama/` 未入仓（生成内容） | 46MB |
| 12 | 5 个 `preview-*.html` + 2 个 `test_*.py` 根目录调试脚本未清理 | ~150KB |
| 13 | 58 个文件 7190 行修改未提交，本地领先 origin/main 2 个 commit | — |

### 好消息（无需动）

- ✅ 后端 566 个测试全部通过（8.18s）
- ✅ [deploy/docker-compose.yml](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/deploy/docker-compose.yml) 已更新到 .127 + 接入 L2/L3
- ✅ 路径安全、限流、熔断器、SSE 背压等加固已完成

---

## 第二部分：模型/服务升级调研结论

### 2.1 LLM 四层流水线

| 层 | 当前 | 推荐替代 | 优先级 | 核心理由 |
|----|------|---------|--------|---------|
| **L4 NSFW** | euryale-70b（BF16 TP=2 跨 spark01+02，英文为主，90s/300tok） | **`Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive`** | **P0** | 中文 2/5→5/5；显存 2×128GB→1×24GB（释放 spark02）；速度 3 倍；多模态视觉原生支持；Apache 2.0；HF 下载 211 万+ |
| L1 实时交互 | Nemotron-3-Nano-Omni-30B-A3R（全模态，2026-04） | **Qwen 4.1 32B-A3B**（并行部署 HauhauCS 越狱版作无审查副本） | P1 | SWE-Verified 73.4→80；1M 原生上下文；自动推理切换；Apache 2.0；同架构迁移成本极低 |
| L2 主力润色 | Kimi-K2.7-Code-4bit（6.6s/句） | ① **DeepSeek V4 Flash**（284B/A13B，立即上，单台 M3 Ultra 可跑）<br>② Kimi K3 Max（2026-07-27 权重开源，等 MLX 量化 8 月） | P2 | V4 Flash 1M 上下文 + MIT + 中文 SOTA；K3 前端代码竞技场 1679 分第一 |
| L3 终稿精修 | GLM-5.2-fp8（115s/句，1024K ctx） | **GLM-6-4bit**（等 mlx-community 量化，预计 8 月） | P3 | 同系列代际升级，迁移成本几乎为零；如无瓶颈可延后到 Q4 评估 GLM-6 vs DeepSeek V4 Pro |

**关键风险**：EXO 集群 4×M3 Ultra 512GB = 2TB 总池，K3 Q3 (~1TB) + V4 Flash Q4 + GLM-6 Q4 同时部署会紧张，需容量规划；EXO 默认开启 thinking，reasoning token 占 80%+，需测 `chat_template_kwargs.enable_thinking: false`。

### 2.2 语音（TTS + ASR）

#### TTS

| 候选 | 类型 | 中文 | 离线 | ToIV 契约兼容 | 接入难度 |
|------|------|------|------|--------------|---------|
| **IndexTTS2 完整版**（B站） | 声音克隆 | 4.5 | ✅ | **1:1 兼容** `/tts` multipart | **低** |
| CosyVoice 2（阿里） | 声音克隆 | 4.7（MOS 最高） | ✅ | 需适配器 | 中 |
| Kokoro-82M v1.1-zh | 预设音色 | 4.0（旁白级） | ✅ | 不兼容（无克隆） | 低 |
| edge-tts（当前） | 假克隆（预设） | 2.5 | ❌ 联网 | — | — |

**结论**：短剧选**声音克隆派**（角色差异化 + 情感丰富 + 长文本稳定）。预设音色无法覆盖任意角色声线。

- **首选**：IndexTTS2 完整版替换 edge-tts 封装底层 → 契约 1:1 兼容，业务代码零改动，仅换 systemd 单元底层进程。预期质量 2.5→4.5，解锁情感解耦 + 时长控制（口型对齐）
- **次选**：CosyVoice 2 作为方言/译制配音专用路由（粤/川/沪/津/武汉）
- **备选**：Kokoro-82M v1.1-zh 跑 Mac Studio EXO，承载旁白/解说轻量任务

#### ASR

| 候选 | 中文 CER | 速度 | 部署 | 接入难度 |
|------|---------|------|------|---------|
| **SenseVoice-Small**（阿里，234M） | **3%** | CPU 17×实时，GPU 170× | `pip install funasr`，OpenAI 兼容 | 低 |
| Qwen3-ASR-0.6B | 顶尖 | 1.7B 5GB / 0.6B 2GB | Docker | 中 |
| faster-whisper large-v3-turbo | ~5% | 4× 官方 | 一行模型名升级 | 极低 |
| faster-whisper base（当前） | 5.8% | CPU int8 慢 | 已内置 | — |

**结论**：
- **首选**：SenseVoice-Small（CER 5.8%→3% 翻倍，速度 17×，自带 VAD/标点/说话人分离/情感标签 → 情感标签可直接联动 TTS 情感控制，形成"听写→情感提取→配音克隆"闭环）
- **保底**：先一行升级到 faster-whisper large-v3-turbo 立竿见影

### 2.3 视觉 / 嵌入 / 图像

#### VLM

| 当前 | 推荐替代 | 优先级 |
|------|---------|--------|
| Nemotron-3-Nano-Omni-30B-A3R（2026-04，全模态视频最强） | **保留** + 增配 **Qwen3-VL-8B-Instruct**（FP8 ~8GB，单卡可跑） | P1 |

**理由**：Nemotron 已是开源视频理解效率标杆（Conv3D 时序压缩 + C-RADIOv4-H），不换；但 Qwen3-VL 的 Interleaved-MRoPE + 文本-时间戳对齐对**短剧秒级时序评分**是质变，8B 单卡可跑，与 ComfyUI 同卡共存。重型方案 Qwen3-VL-235B 上 EXO RDMA 留作 P4 评估。

#### Embedding（必换）

| 当前 | 推荐替代 | 优先级 |
|------|---------|--------|
| text-embedding-nomic-embed-text-v1.5（137M，768 维，8K ctx，2024 落后，中文弱） | **Qwen3-Embedding-4B + Qwen3-Reranker-4B**（32K ctx，CMTEB 68.09，GGUF-Q4 仅 3GB，Apache 2.0） | **P0** |

**理由**：当前 nomic v1.5 是 2024 年模型，中文弱、维度低、无 reranker。Qwen3-Embedding-4B 32K 长上下文可一次性嵌入整集短剧对白，MRL 支持动态维度，配套 Reranker 形成"召回+精排"两阶段。
**部署**：vLLM `--task embed --port 1234`，替代 LM Studio :1234。备选 BAAI/bge-m3（与 OpenClaw 4 台 Mac Mini 的 BGE 系列统一）。

#### 图像生成

| 用途 | 当前 | 推荐 | 优先级 |
|------|------|------|--------|
| 默认底模 | FLUX.2 dev fp8mixed（33GB） | **保留** + 增配 **HiDream-O1-Image-Dev-2604**（8B，Apache 2.0，开源竞技场第一） | P2 |
| 中文海报 | — | **Qwen-Image-2512 GGUF Q4_K_M**（中文文字 95%+ 可读率，6-8GB） | P3 |
| NSFW 视频 | 10eros v1.4（LTX2.3） | **保留**（已是最新） | — |
| SFW 视频 | LTX-2.3 distilled（2026-03） | **保留**（已是最新）；监控 FLUX.3 Video 开源 | P5 监控 |
| NSFW 图像备选 | — | flux2-klein-9b-uncensored-text-encoder（数学正交化解锁） | P6 备选 |

**理由**：FLUX.2 dev 仍是主力，但 HiDream-O1-Image 在 Artificial Analysis 开源榜已超越 FLUX.2（UiT 架构无需 VAE，工作流简化）；Qwen-Image-2512 中文文字渲染 95%+ 可读率，专攻短剧宣发海报。

---

## 第三部分：统一任务清单（按优先级合并）

### P0 — 立即处理（功能恢复 + 高价值低成本升级）

#### P0-A 配置修复（半天，恢复已有功能）

- [ ] 修 [config.py:128](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/config.py#L128) `vlm_server_url` → `http://192.168.71.127:8000`
- [ ] 修 [scoring.py:238](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/scoring.py#L238) `vlm_url` → `http://192.168.71.127:8000`
- [ ] 修 [.env](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/.env) `TOIV_COMFY_WORKERS` 移除 `:8192`，保留 5 后端
- [ ] 修 [system.py:50](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/routes/system.py#L50) 移除 `192.168.71.100` 硬编码过滤
- [ ] 把 `faster-whisper==1.1.1` 加进 `requirements.txt`（uv 导出漏了）

#### P0-B L4 NSFW 模型替换（1-2 天，收益最大）

- [ ] spark01 部署 `HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive-Q4_K_P.gguf`（vLLM 或 llama.cpp-server）
- [ ] `served-model-name` 保持 `euryale-70b` 向后兼容，业务代码零改动
- [ ] 验证中文 NSFW 输出质量 + 拒绝率测试（预期 0/465）
- [ ] 释放 spark02（可作 ComfyUI 扩容或 L1 副本）
- [ ] 更新 [AGENTS.md](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/AGENTS.md) L4 模型条目

#### P0-C TTS 引擎替换（1-2 天，配音质量翻倍）

- [ ] Workstation GPU0 部署 IndexTTS2 完整版（替换 edge-tts 封装底层），端口仍 :9200
- [ ] 验证 `/tts` multipart 契约 1:1 兼容（参考音 + 文本 → wav）
- [ ] 测试情感解耦 + 时长控制（口型对齐）
- [ ] 业务代码零改动验证

#### P0-D Embedding 模型替换（半天，RAG 质量翻倍）

- [ ] Workstation 部署 `Qwen3-Embedding-4B`（vLLM `--task embed --port 1234`，替代 LM Studio）
- [ ] 部署 `Qwen3-Reranker-4B`（:1235）
- [ ] 修 [config.py:110](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/config.py#L110) `embed_model` → `Qwen3-Embedding-4B`
- [ ] 重建 RAG 索引（向量维度从 768 → 2560，需重建库）

### P1 — 1-2 周内处理

- [ ] **L1 LLM 升级**：Workstation 部署 `Qwen 4.1 32B-A3B`（替换或并行 Nemotron），并行部署 HauhauCS 越狱版作无审查副本
- [ ] **ASR 升级**：faster-whisper base → SenseVoice-Small（`pip install funasr`），或保底先升 large-v3-turbo
- [ ] **VLM 增配**：Workstation 部署 `Qwen3-VL-8B-Instruct`（FP8 ~8GB，:8001），用于短剧时序评分，Nemotron 保留作全模态主力
- [ ] **文档清理**：修 [AGENTS.md](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/AGENTS.md) 三处过时（L1 引擎、ComfyUI 后端数、pc01 版本）
- [ ] **默认值清理**：修 config.py / workflows.ts / .env.example 中所有 `192.168.71.100` 旧 IP

### P2 — 2-4 周内处理

- [ ] **L2 LLM 升级**：EXO 单台部署 `DeepSeek V4 Flash`（284B/A13B，1M ctx），替换或并行 Kimi-K2.7
- [ ] **图像底模增配**：ComfyUI-LB 部署 `HiDream-O1-Image-Dev-2604`（8B，Apache 2.0）
- [ ] **TTS 方言扩展**：部署 CosyVoice 2 作为方言/译制配音专用路由（粤/川）
- [ ] **仓库卫生**：清理 `models/`（33GB）、`opentalking/`（2.7GB 嵌套 git）、`drama/`、根目录调试脚本 → 移出仓库或加 .gitignore
- [ ] **提交积压**：58 个文件 7190 行改动需评审后分批提交

### P3 — 4-8 周内处理

- [ ] **L3 LLM 升级**：等 `mlx-community/GLM-6-4bit` 量化版发布，替换 GLM-5.2-fp8
- [ ] **中文海报模型**：ComfyUI 部署 `Qwen-Image-2512 GGUF Q4_K_M`（中文文字 95%+ 可读率）
- [ ] **Kimi K3 Max 评估**：等 MLX 量化版（预计 8 月中），EXO 4 台集群 PoC，容量规划（K3 Q3 ~1TB + V4 Flash + GLM-6 同时部署需 2TB 池）
- [ ] **TTS 旁白分流**：Mac Studio EXO 部署 Kokoro-82M v1.1-zh，承载旁白/解说轻量任务，分流 Workstation GPU

### P4 — 监控/评估（不立即动）

- [ ] **VLM 重型方案**：评估 `Qwen3-VL-235B-A22B-Thinking` 上 EXO RDMA（秒级时序定位 + 1M 上下文整集短剧）
- [ ] **FLUX.3 Video**：监控开源权重发布，作为 LTX-2.3 的最强继任
- [ ] **DeepSeek V4 Pro**：评估 1.6T/49B active 是否可上 EXO（Q4 ~900GB）
- [ ] **NSFW 图像备选**：试 `flux2-klein-9b-uncensored-text-encoder`

---

## 执行原则

1. **P0 全部做完再启动 P1**：P0-A 是功能恢复，P0-B/C/D 是高价值低成本升级，应集中一周内完成
2. **每一步都要跑回归**：566 个后端测试必须全绿；改 TTS/VLM/Embedding 后跑端到端验证
3. **向后兼容**：所有模型替换用 `served-model-name` 保持旧 ID，业务代码零改动优先
4. **不抢资源**：Workstation 4× PRO 6000 显存充裕（Q4 量化后 P0 总占用 < 60GB），但 EXO 集群 2TB 池需容量规划
5. **更新单一真相源**：每完成一项升级，同步更新 [设备说明.md](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/设备说明.md) 和 [AGENTS.md](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/AGENTS.md)

---

## 风险与不确定性

1. ~~**HauhauCS 是社区微调版**：虽 Apache 2.0，ToIV 商用前建议法务过一遍微调数据来源~~ **已解除**：ToIV 仅作学习用途，非商用，HauhauCS 可直接使用
2. **Kimi K3 全量权重 2.8T**：即使 Q3 也 ~1TB，EXO 集群同时部署 K3 + V4 Flash + GLM-6 会紧张
3. **EXO 默认开启 thinking**：K3 / GLM-6 / V4 reasoning token 占 80%+，需测 `chat_template_kwargs.enable_thinking: false`；若不生效用 prompt 抑制
4. **GLM-6 旗舰参数未公开**：等智谱官方技术报告 + HF 权重落地后再做最终决策
5. ~~**IndexTTS2 商用授权**：Apache-2.0，但部分版本商用需确认~~ **已解除**（学习用途）；自回归架构长文本仍需分块（技术约束不变）
6. **RAG 索引重建**：换 Embedding 模型后维度从 768 → 2560，必须重建向量库，不能热切换

---

## 附录：调研信息源

### LLM
- [Kimi K3 官方博客](https://www.kimi.com/blog/kimi-k3)（权重 2026-07-27 开源）
- [Qwen 4.1 评测](https://llmcheck.net/blog/qwen-4-release-whats-new-mac/)
- [DeepSeek V4 技术报告](https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro/blob/main/DeepSeek_V4.pdf)
- [GLM-6 简报](https://presenc.ai/research/glm-6-release-brief)
- [Qwen3.6-Uncensored HauhauCS](https://huggingface.co/HauhauCS/Qwen3.6-35B-A3B-Uncensored-HauhauCS-Aggressive)
- [2026 无审查模型排行](https://www.atlascloud.ai/zh/blog/guides/best-uncensored-ai-models)

### 语音
- [Kokoro-82M v1.1-zh 实测](https://blog.csdn.net/u010522887/article/details/146720024)
- [CosyVoice 2 论文](https://funaudiollm.github.io/pdf/CosyVoice_2.pdf)
- [IndexTTS2 FastAPI 封装](https://github.com/andykcheng/index-tts2-fastapi)
- [FunASR SenseVoice 评测](https://andrew.ooo/posts/funasr-modelscope-whisper-alternative-review/)
- [Qwen3-TTS/ASR GitHub](https://github.com/QwenLM/Qwen3-TTS)

### 视觉/嵌入/图像
- [NVIDIA Nemotron 3 Nano Omni 技术报告](https://research.nvidia.com/labs/nemotron/files/NVIDIA-Nemotron-3-Omni-report.pdf)
- [Qwen3-VL 旗舰发布](https://github.com/Quriosity-agent/articles/blob/main/2026-02-26/qwen3-vl-vision-language-model-en.md)
- [Qwen3-Embedding GitHub](https://github.com/QwenLM/Qwen3-Embedding)
- [HiDream-O1-Image](https://modelscope.cn/HiDream-ai/HiDream-O1-Image)
- [LTX-2.3 模型卡](https://aihub.caict.ac.cn/models/Lightricks/LTX-2.3)
- [FLUX.3 发布](https://bfl.ai/blog/flux-3)
