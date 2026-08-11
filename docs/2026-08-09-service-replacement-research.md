# ToIV 服务替代方案调研与交接文档

> **文档性质**：调研结论 + 交接说明
> **调研日期**：2026-08-09
> **调研依据**：Workstation 真机核查 + Mac Studio 真机核查 + 公开仓库/论文/基准测试
> **核心原则**：**质量不能下降；Mac Studio 优先使用 MLX 格式；所有结论必须经真机验证**
> **维护者**：设备管家（AI Assistant）

---

## 一、调研背景与目标

### 1.1 背景

Workstation 四张 RTX PRO 6000 显存压力较大，特别是：

- **GPU0**：ComfyUI #1 + IndexTTS2 + MiniMax H3 共卡
- **GPU1**：Qwen3-Embedding-4B + LiveAct 共卡
- **GPU2**：ASR + demucs + SenseVoice + LongCat-Video + MiniMax H3(CLIP/VAE) + 一个 vLLM Embedding 测试实例共卡
- **GPU3**：FlashTalk + OpenTalking + JoyCaption 共卡

用户已将 Mac Studio 的 EXO 清理，希望重新规划 Mac Studio 以分担 Workstation 压力，并优先保障 MiniMax H3 的稳定运行。

### 1.2 调研目标

1. 评估当前各服务是否有更高质量或更高效的替代方案。
2. 判断哪些服务可以迁移到 Mac Studio（M3 Ultra 512GB 统一内存）。
3. 明确迁移原则：**质量不下降；Mac 优先 MLX 格式**。
4. 输出可执行的迁移路线图与交接说明。

---

## 二、真机状态基线（2026-08-09）

### 2.1 Workstation GPU 占用

```text
Sun Aug  9 10:46:42 2026
+-----------------------------------------------------------------------------------------+
| NVIDIA-SMI 595.84                 Driver Version: 595.84         CUDA Version: 13.2     |
+-----------------------------------------+------------------------+----------------------+
| GPU  Name                 Persistence-M | Bus-Id          Disp.A | Volatile Uncorr. ECC |
| Fan  Temp   Perf          Pwr:Usage/Cap |           Memory-Usage | GPU-Util  Compute M. |
|                                         |                        |               MIG M. |
|=========================================+========================+======================+
|   0  NVIDIA RTX PRO 6000 Blac...    Off |   00000000:01:00.0 Off |                  Off |
| 30%   33C    P8              5W /  600W |   40325MiB /  97887MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+
|   1  NVIDIA RTX PRO 6000 Blac...    Off |   00000000:21:00.0 Off |                    0 |
| 30%   28C    P8              6W /  600W |   67547MiB /  97887MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+
|   2  NVIDIA RTX PRO 6000 Blac...    Off |   00000000:C1:00.0 Off |                  Off |
| 30%   34C    P1             81W /  600W |   22589MiB /  97887MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+
|   3  NVIDIA RTX PRO 6000 Blac...    Off |   00000000:F1:00.0  On |                    0 |
| 30%   37C    P8             14W /  600W |   68566MiB /  97887MiB |      0%      Default |
|                                         |                        |                  N/A |
+-----------------------------------------+------------------------+----------------------+
```

| GPU | 已用 | 主要进程 |
|-----|------|----------|
| GPU0 | 40.3 GB | ComfyUI #1 830 MB + IndexTTS2 7.0 GB + MiniMax H3 32.3 GB |
| GPU1 | 67.5 GB | Qwen3-Embedding-4B 9.6 GB + LiveAct 59.1 GB |
| GPU2 | 22.6 GB | ComfyUI 550 MB + SenseVoice 1.5 GB + ASR 4.3 GB + MiniMax H3 550 MB + **vLLM 测试实例 15.5 GB** |
| GPU3 | 68.6 GB | JoyCaption 16.7 GB + FlashTalk 50.7 GB + GNOME/Xwayland |

### 2.2 关键进程明细

| 服务 | PID / 进程 | 端口 | 显存 | 说明 |
|------|------------|------|------|------|
| ComfyUI #1 | 8947 | :8189 | 830 MB | GPU0，带 `--cache-lru 8` |
| IndexTTS2 | 9155 | :9200 | 7.0 GB | GPU0，与 H3/ComfyUI 共卡 |
| MiniMax H3 | 15405 | :8195 | GPU0 32.3 GB / GPU2 550 MB | UNet 分片跨 GPU0/GPU2 |
| Qwen3-Embedding | 8981 | :9302 | 9.6 GB | GPU1，sentence-transformers |
| LiveAct | 10778 | :9400 | 59.1 GB | GPU1 |
| AI-Omni ASR | 9007 | :9210 | 4.3 GB | GPU2，faster-whisper large-v3 |
| SenseVoice | 8992 | :9211 | 1.5 GB | GPU2，FunASR |
| demucs | 8986 | :9220 | 休眠 ~33 MB，分离时 1–8 GB | GPU2 |
| LongCat-Video | （独立 ComfyUI 实例） | :8197 | 未在当前采样中满载 | GPU2 |
| **vLLM Embedding 测试** | **16776 / 19559** | **:1234** | **15.5 GB** | **GPU2，qwen3-embed-vllm.service** |
| JoyCaption | 8989 | :9304 | 16.7 GB | GPU3，bf16 transformers |
| FlashTalk | 850177 | （内部） | 50.7 GB | GPU3 |

### 2.3 Mac Studio 状态

- **studio04（192.168.71.113）**：Apple M3 Ultra，32 核 CPU / 80 核 GPU，512 GB 统一内存，10GbE。
- **Qwen3-VL-8B 迁移状态**：AGENTS.md 记录为「已迁移 studio04 mlx-vlm 0.6.10」，但真机核查发现 `~/toiv-vlm-mlx` 目录仅含空日志，无 venv、无 plist、无进程。**实际未部署成功**。
- 其余 studio01-03 当前状态需进一步核查（EXO 已清理）。

---

## 三、调研原则

### 3.1 质量不下降

- 任何替代方案必须在下游任务效果上至少持平， preferably 提升。
- 必须做 A/B 验证后才能切流。
- 不允许为省显存而牺牲核心效果。

### 3.2 Mac Studio 优先 MLX

- MLX 是 Apple Silicon 原生框架，能充分利用统一内存和内存带宽。
- GGUF + llama.cpp 在 Mac 上可运行，但通常比 MLX 慢，尤其是 VLM 和高并发场景。
- 若某服务没有 MLX 原生支持，则优先考虑留在 Workstation，而非强行迁移到 Mac 跑 GGUF。

### 3.3 真机验证优先

- AGENTS.md、STATE.json、TEST_LOG.md 等所有文档仅供参考。
- 涉及显存、服务状态、模型占用、迁移效果的问题，必须先 SSH 到目标设备执行真实命令验证。

---

## 四、各服务替代方案结论

### 4.1 Qwen3-Embedding-4B

#### 当前状态

- 服务：`qwen3-embedding.service`
- 端口：`:9302`
- 位置：GPU1
- 框架：sentence-transformers
- 显存：9.6 GB
- 同时存在一个 vLLM 测试实例：`qwen3-embed-vllm.service`，端口 `:1234`，GPU2，显存 15.5 GB

#### 方案对比

| 方案 | 显存 | 速度 | 质量 | 推荐度 | 说明 |
|------|------|------|------|--------|------|
| sentence-transformers（生产） | 9.6 GB | 14 ms / 573 doc/s | 基准 | ★★★★☆ | 稳定，OpenAI 兼容 |
| vLLM（测试 :1234） | 15.5 GB | 25 ms / 315 doc/s | 存在精度 discrepancy 风险 | ★★☆☆☆ | 配置保守，未经验证 |
| infinity (torch) | 9–12 GB | 与 ST 接近或更优 | 需验证 | ★★★☆☆ | 动态批处理好，但 Qwen3 支持需 transformers>=4.51.0 |
| Mac mlx-embeddings 4bit | ~2.7 GB | 单请求 1–3 ms | 略降 | ★★☆☆☆ | 不适合生产主链路 |
| Qwen3-Embedding-8B | ~15 GB | 慢 30–50% | 更高 | ★★★★☆ | 若需升级质量，部署到独立 GPU |

#### 结论

- **生产链路保持 sentence-transformers 不变**。
- **立即停止或重构 GPU2 的 vLLM 测试实例**（质量未验证，且效果不如当前生产）。
- 若未来需要更高并发，优先评估 infinity，但必须做严格召回对比。
- 若需要提升质量，可考虑升级到 Qwen3-Embedding-8B，部署到 GPU2 或独立 GPU。

---

### 4.2 IndexTTS2

#### 当前状态

- 服务：`toiv-tts.service`
- 端口：`:9200`
- 位置：GPU0
- 显存：7.0 GB

#### 方案对比

| 方案 | 显存 | 中文 | 零样本克隆 | 情感/时长控制 | Mac MLX | 推荐度 |
|------|------|------|------------|---------------|---------|--------|
| IndexTTS2 | 7.0 GB | 优秀 | 支持 | **12 情感 + token 级时长** | 否 | ★★★★★ |
| Qwen3-TTS 0.6B MLX | ~2.5 GB | 优秀 | 3s 零样本 | 中等 | 是 | ★★★★☆ |
| Kokoro-82M ONNX | ~0.3 GB | 中等 | 不支持 | 弱 | 是（MPS/CPU） | ★★★☆☆ |
| CosyVoice 3 0.5B | ~3–4 GB | 优秀 | 支持 | 强 | 中 | ★★★★☆ |
| Fish Speech v1.5 | ~4 GB | 中等 | 支持 | 中等 | 中（非商业许可） | ★★★☆☆ |
| XTTS v2 | ~4–6 GB | 中等 | 6s 参考 | 中等 | 中 | ★★★☆☆ |

#### 结论

- **IndexTTS2 在中文韵律、12 情感控制、token 级精确时长控制方面是开源方案中难以替代的**。
- **不替换 IndexTTS2**。
- 可在 Mac Studio 部署 Qwen3-TTS MLX 作为**非情感、非精确时长场景**的补充，但不可降级替代 IndexTTS2。

---

### 4.3 ASR（AI-Omni ASR）

#### 当前状态

- 服务：`toiv-asr.service`
- 端口：`:9210`
- 位置：GPU2
- 模型：faster-whisper large-v3
- 显存：4.3 GB

#### 方案对比

| 方案 | 占用 | 速度 | 质量 | Mac 格式 | 推荐度 |
|------|------|------|------|----------|--------|
| faster-whisper large-v3 | GPU 4.3 GB | 中等 | 基准 | 否 | ★★★★☆ |
| **whisper.cpp large-v3-turbo** | 统一内存 ~1.6 GB | M3 Ultra RTF ~0.070（14×实时） | 接近 large-v3 | Core ML / Metal | ★★★★★ |
| mlx-whisper large-v3-turbo | 统一内存 ~1.6 GB | M3 Ultra RTF ~0.139（7×实时） | 与 whisper 一致 | MLX | ★★★★☆ |
| distil-large-v3 | ~1.5 GB | 6× large-v3 | 英语好，多语言弱 | 可 | ★★☆☆☆ |

#### 结论

- **推荐迁移到 Mac Studio 的 whisper.cpp large-v3-turbo**。
- large-v3-turbo 是 OpenAI 官方蒸馏版本，质量接近 large-v3，速度大幅提升。
- 迁移前必须跑相同测试集做 WER/CER 对比，确认不升高再切流。
- whisper.cpp 使用 Core ML/Metal，在 Mac 上比 mlx-whisper 更快，是 ASR 的最优格式。

---

### 4.4 demucs 人声分离

#### 当前状态

- 服务：`toiv-audio-sep.service`
- 端口：`:9220`
- 位置：GPU2
- 模型：htdemucs
- 显存：1–8 GB（分离时）

#### 方案对比

| 方案 | 占用 | 速度 | 质量（SDR） | Mac 格式 | 推荐度 |
|------|------|------|-------------|----------|--------|
| demucs htdemucs（现状） | GPU 1–8 GB | GPU ~3× 实时 | ~9.0 dB | 否 | ★★★★☆ |
| **demucs-mlx（Python）** | 统一内存 ~3 GB | ~73× 实时 | 与 PyTorch bit-exact | MLX | ★★★★★ |
| demucs-mlx-swift | 统一内存 ~3 GB | M3 Ultra 更高 | SDR 差 ±0.11 dB | MLX-Swift | ★★★★☆ |
| Spleeter | ~2 GB | CPU 2× / GPU 24× | ~5.9 dB | TensorFlow | ★★☆☆☆ |
| UVR5 / MDX-Net / BS-RoFormer | 4–12 GB | 较慢 | Ensemble 11.93 dB | Python/ONNX | ★★★☆☆ |

#### 结论

- **强烈推荐迁移到 Mac Studio 的 demucs-mlx**。
- 与 PyTorch 原版 bit-exact 一致，质量无损失，速度提升数十倍。

---

### 4.5 SenseVoice

#### 当前状态

- 服务：`toiv-sensevoice.service`
- 端口：`:9211`
- 位置：GPU2
- 模型：SenseVoiceSmall
- 显存：1.5 GB

#### 方案对比

| 方案 | 功能 | 占用 | Mac 支持 | 推荐度 |
|------|------|------|----------|--------|
| SenseVoice-Small（现状） | ASR + 情绪 + 事件 + LID | 1.5 GB | 无原生 MLX | ★★★★☆ |
| SenseVoice GGUF | ASR + 情绪 + 事件 | q8 ~254 MB | llama.cpp | ★★★☆☆ |
| Emotion2Vec+ MLX-Swift | 仅情绪 | ~1.2 GB | MLX-Swift | ★★★☆☆ |
| C²SER | 情绪识别 | ~5 GB | 无 MLX | ★★☆☆☆ |

#### 结论

- **短期保留在 Workstation**。
- 它是少数把 ASR + 情绪 + 事件 + 语言识别做在一个小模型里的方案，Mac 没有功能等效替代。
- 1.5 GB 占用最小，迁出收益低、替换风险高。

---

### 4.6 JoyCaption Beta One（NSFW 反推）

#### 当前状态

- 服务：`toiv-joycaption.service`
- 端口：`:9304`
- 位置：GPU3
- 模型：JoyCaption Beta One bf16
- 显存：16.7 GB

#### 方案对比

| 方案 | 统一内存/显存 | 速度 | NSFW 质量 | Mac 格式 | 推荐度 |
|------|---------------|------|-----------|----------|--------|
| JoyCaption bf16（现状） | 16.7 GB 显存 | 中 | 最高 | — | ★★★★★ |
| JoyCaption GGUF Q8_0 | ~10 GB | 较慢 | 接近原版 | GGUF | ★★★☆☆ |
| JoyCaption GGUF Q5_K_M | ~8 GB | 更慢 | 良好 | GGUF | ★★☆☆☆ |
| 通用 VLM（Qwen-VL/Moondream） | ~6 GB | 快 | NSFW 细节弱 | MLX | ★★☆☆☆ |

#### 结论

- **JoyCaption 不迁移到 Mac Studio**。
- 无原生 MLX 支持，GGUF 在 Mac 上速度慢，且量化会降低 NSFW 反推细节。
- **留在 Workstation GPU3 是当前最优解**。
- 等待社区发布 JoyCaption 的 MLX 量化版后再评估迁移。

---

### 4.7 Qwen3-VL-8B（SFW/视频反推）

#### 当前状态

- Workstation `toiv-vlm.service`：已 stop + disable
- AGENTS.md 记录「已迁移 studio04 mlx-vlm 0.6.10」
- **真机核查：studio04 未实际部署成功**

#### 方案对比

| 方案 | 统一内存 | 速度 | 质量 | Mac 格式 | 推荐度 |
|------|----------|------|------|----------|--------|
| Qwen3-VL-8B bf16 | ~17 GB | 慢 | 最高 | — | ★★★☆☆ |
| **Qwen3-VL-8B 8bit** | ~8 GB | 中 | 接近 bf16 | MLX | ★★★★★ |
| Qwen3-VL-8B 4bit | ~6 GB | 快 | 可接受 | MLX | ★★★★☆ |
| Qwen2.5-VL-7B 4bit | ~5 GB | 更快 | 高，输出更可控 | MLX | ★★★★☆ |

#### 结论

- **在 studio04 真正落地 Qwen3-VL-8B 8bit（mlx-vlm）**。
- 8bit 优先保证质量，4bit 可作为速度优先备选。
- Qwen2.5-VL-7B 4bit 也可并行部署做 A/B。

---

## 五、最终推荐矩阵

| 服务 | 当前位置 | 推荐去向 | 推荐格式 | 质量影响 | 可释放显存 | 优先级 |
|------|----------|----------|----------|----------|------------|--------|
| **demucs** | GPU2 | Mac Studio | demucs-mlx | 无损 | 1–8 GB | P0 |
| **ASR** | GPU2 | Mac Studio（验证后） | whisper.cpp large-v3-turbo | 验证后无损 | ~4.9 GB | P0 |
| **vLLM Embedding 测试** | GPU2 | 停止/重构 | — | 避免潜在精度问题 | 15.5 GB | P0 |
| **Qwen3-VL-8B** | GPU3（已停） | Mac Studio studio04 | mlx-vlm 8bit | 接近 bf16 | 完全释放 GPU3 | P1 |
| **IndexTTS2** | GPU0 | 保持 Workstation | 现状 | 质量最高 | — | 保持 |
| **SenseVoice** | GPU2 | 保持 Workstation | 现状 | 无等效替代 | — | 保持 |
| **Qwen3-Embedding** | GPU1 | 保持 Workstation | sentence-transformers | 质量基线 | — | 保持 |
| **JoyCaption** | GPU3 | 保持 Workstation | bf16 | 质量最高 | — | 保持 |

---

## 六、迁移路线图

### Phase 1：零风险迁移（立即执行）

1. **停止 Workstation GPU2 上的 vLLM Embedding 测试实例**
   ```bash
   ssh merlin@192.168.71.127
   sudo systemctl stop qwen3-embed-vllm.service
   sudo systemctl disable qwen3-embed-vllm.service
   ```

2. **在 Mac Studio 部署 demucs-mlx**
   - 选择节点：studio01 或 studio02（避免 studio04 先承担 VLM 任务）
   - 安装：`pip install demucs-mlx`
   - 部署 FastAPI 服务，端口 `:9221`
   - launchd 持久化
   - core API 路由 `/api/audio/separate` 做 A/B

3. **在 Mac Studio 部署 whisper.cpp large-v3-turbo**
   - 安装：`brew install whisper-cpp`
   - 下载模型：`ggml-large-v3-turbo.bin`
   - 启动 whisper-server，端口 `:9212`
   - 跑 WER/CER 对比验证
   - 验证通过后切流

### Phase 2：Mac VLM 落地（1–2 天）

1. **在 studio04 真正部署 Qwen3-VL-8B-8bit**
   ```bash
   pip install mlx-vlm
   # 下载 mlx-community/Qwen3-VL-8B-Instruct-8bit
   python server.py --model ... --port 9303
   ```
2. 编写/复用 FastAPI/uvicorn 服务，兼容 core 现有调用协议。
3. 创建 `com.dgmt.toiv-vlm-mlx.plist` LaunchAgent。
4. A/B 验证单图/视频反推质量。

### Phase 3：架构收敛（1 周内）

1. core `deps.resolve_worker` 增加 Mac 视觉反推节点精确匹配。
2. 区分 `reverse_vlm_base`（SFW/视频）与 `reverse_nsfw_base`（JoyCaption）。
3. 更新 AGENTS.md GPU 分配表与服务状态。
4. 全链路压测与回归。

---

## 七、对 AGENTS.md 的修正项

基于本次真机核查，AGENTS.md 第三节及以下记录需要更新：

1. **GPU 分配表显存数字**：
   - MiniMax H3 在 GPU0 当前 32.3 GB，GPU2 当前 550 MB（非 ~62 GB / ~48 GB）。
   - ComfyUI #1 当前 830 MB（非 ~0.5 GB）。
   - 应增加备注：显存随缓存策略、模型加载状态、采样状态动态变化。

2. **Qwen3-VL-8B 迁移状态**：
   - 当前写「已迁移 studio04 mlx-vlm 0.6.10」。
   - 实际 studio04 未部署成功，应改为「计划中，待 studio04 真正落地」。

3. **GPU2 vLLM 测试实例**：
   - 当前文档未提及 `qwen3-embed-vllm.service` 占用 GPU2 15.5 GB，应补充说明。

4. **JoyCaption 状态**：
   - 当前在 GPU3 实际运行，峰值系统内存 16.9 GB，需确认是显存还是系统内存。

5. **Mac 格式优先原则**：
   - 新增备注：Mac Studio 优先使用 MLX 格式；GGUF 仅作为无 MLX 支持时的备选，且通常更慢。

---

## 八、风险提示

1. **vLLM Embedding 测试实例**：当前配置效果不如 sentence-transformers，且有精度风险，建议立即处理。
2. **Qwen3-VL-8B 部署状态**：AGENTS.md 记录与真机不符，需要真正落地后才能切流。
3. **JoyCaption 迁移限制**：无原生 MLX 支持，强行迁移到 Mac 跑 GGUF 会导致速度下降和质量损失。
4. **ASR 迁移前提**：必须做 WER/CER 对比，确认质量不下降再切流。
5. **显存数字动态性**：所有显存数字均为某一时刻快照，实际会随运行态变化，决策前需再次真机核查。

---

## 九、参考来源

- vLLM Qwen3 Embedding 精度问题：https://github.com/vllm-project/vllm/issues/25333
- infinity：https://github.com/michaelfeil/infinity
- whisper.cpp M3 Ultra 基准：https://github.com/mundwerk-app/whisper-metal-benchmark
- demucs-mlx：https://github.com/ssmall256/demucs-mlx
- JoyCaption GGUF：https://1038lab.github.io/ComfyUI-JoyCaption/
- mlx-vlm 支持模型：https://mintlify.wiki/yocxy2/mlx-vlm/models/supported-models
- Qwen3-TTS MLX：https://huggingface.co/mlx-community/Qwen3-TTS-12Hz-0.6B-MLX
- Kokoro-82M：https://huggingface.co/hexgrad/Kokoro-82M
- SenseVoice：https://github.com/FunAudioLLM/SenseVoice
- Emotion2Vec MLX-Swift：https://github.com/xocialize/emotion2vec-mlx-swift

---

## 十、交接说明

- 本文档是 2026-08-09 服务替代方案调研的最终结论。
- 此前关于「vLLM Embedding 可替代 sentence-transformers」、「JoyCaption 可迁移到 Mac GGUF」、「Qwen3-VL-8B 已迁移 studio04」等非正式/临时记录，**以本文档为准**。
- 执行迁移前，必须重新真机核查目标设备状态。
- 文档维护者：设备管家（AI Assistant），下次更新需在执行 Phase 1/2/3 后同步修订。
