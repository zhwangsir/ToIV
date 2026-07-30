# 模型升级方案时效性核查与优化（2026-07-30）

> 对 `model-inventory-master-2026-07-29`（升级方案）的逐项核实与修正。
> 结论：**方案整体成立，P0 选择无需推翻**；视频/TTS/音频分离有实质新增变量，版本号需修正。

## 一、逐项核实结论

| 方案条目 | 判定 | 修正/补充 |
|---|---|---|
| Qwen-Image 2.0 + Qwen3-VL-8B | ✅ 正确 | 2.0 发布日 2026-02-10；官方架构 = 8B Qwen3-VL 编码器 + 7B DiT 解码器，8B（非 7B）命名正确 |
| Qwen-Image 3.0 权重未开源 | ✅ 仍成立 | 2026-07-21 仅预览，无权重/协议，继续等待，不作为依据 |
| PuLID Flux v0.9.0/0.9.1 | ✅ 维持 | 官方止于 2024-10，无 v2；Flux 生态人脸 ID 仅此一家。关注同团队继任框架 **DreamO** |
| IPAdapter FaceID Plus v2 | ✅ 维持 | 仍第一梯队；单主角长期角色优先训 LoRA |
| ACE-Step 1.5 (v15-turbo) | ✅ 维持 | 无 2.x；补充高音质选项 **ACE-Step 1.5 XL**（4B DiT，2026-04 发布） |
| Demucs v4 + MDX-Net + UVR5 | ✅ 维持 | 新增评估 **Meta SAM Audio**（文本/视觉/时间段提示的通用分离，定向抽人声/音效，权重已开源）；音乐 stem 分离 SOTA 为 BS/MelBand-RoFormer 系 |
| LTX 2.3 | ✅ 即最新开源 | 2026-03 发布，22B 原生音画同步，无 LTX-3 |
| ~~Wan 2.2 满血~~ | ⚠️ 修正 | 最新开源为 **Wan 2.6**（2025-12，1080p 多镜头 + 原生音频 + 参考一致性）；Wan 2.7 为 API-only 无权重，不要等 |
| HunyuanVideo | ⚠️ 修正 | 最新为 **1.5**（2025-11，8.3B，消费级可跑），无 2.0 |
| 数字人 MuseTalk/LatentSync/LivePortrait | ✅ 维持 | LatentSync 1.6 仍是本地唇形标杆；高质量离线可评估 Hallo3 / HunyuanVideo-Avatar（重、慢，非实时） |
| IndexTTS2 主力 | ✅ 维持 | seed-zh 字错率：GLM-TTS 0.89 > VoxCPM 0.93 > **IndexTTS2 1.03** > CosyVoice3 1.12。可并评 **CosyVoice3**（快 ~9 倍、省资源、自然度略逊）与 **GLM-TTS**（字错率 SOTA）；Fish S2 Pro 强但商用需单独授权 |
| 图像中文场景 Qwen 系 | ✅ 维持 | 新增关注 **GLM-Image**（智谱开源，双语文字渲染 best-in-class，海报/信息图可与 Qwen 一拼） |
| FLUX.2 dev | ⚠️ 注意 | 综合质量领先但 dev 许可证**限制商用售卖产出**；Klein 4B/9B 亚秒级可用 |

## 二、优化后的优先级矩阵（替代原第五章）

| 阶段 | 动作 | 状态/阻塞 |
|---|---|---|
| ~~P0 下载~~ | Qwen3-VL-8B / PuLID / EVA02 / FaceID v2 / ACE-Step 1.5 / 42 LoRA / 音频分离 | ✅ 已全部下载（2026-07-30 逐项核实） |
| **P0-接入（当前瓶颈）** | worker `extra_model_paths.yaml` 指向 NAS `toiv/comfyui-models` + 安装 PuLID/IPAdapter 自定义节点 + pc01/pc02 同步 + object_info 验证 | ⚠️ 未做，Qwen-Image 2.0/角色一致性不可用（代码侧已完成可用性自动降级兜底） |
| P1-接入 | 42 场景 LoRA 接入 style_presets（代码已写，待验证后提交） | 依赖 P0-接入 |
| P1-评估 | SAM Audio PoC（定向抽人声/音效，对比 Demucs） | 模型已开源，直接 pip 可测 |
| P2-视频 | Wan 2.6 权重下载接入（替代原"Wan 2.2 满血"）；HunyuanVideo 1.5 评估 | 下载 ~30-60GB，GPU 排产 |
| P2-音频 | ACE-Step 1.5 XL 高音质选项；CosyVoice3 与 IndexTTS2 AB（速度 vs 自然度） | 需 venv + 评测集 |
| P2-图像 | GLM-Image 试评（双语文字渲染 vs Qwen-Image 2.0） | 模型开源可下 |
| 观察 | Qwen-Image 3.0 权重开源、DreamO（PuLID 继任）、K3 MLX（L2/L3 替换） | 未发布，跟踪即可 |

## 三、维持不变的关键判断

1. NAS `toiv/comfyui-models` 统一目录规范不变。
2. 满血 vs 量化建议不变（Wan/LTX 继续 fp8；Qwen3-VL-8B 满血可跑）。
3. 短剧 LoRA 场景矩阵（10 类 42 个）已落地，无需追加类别。

## 四、未证实项（不纳入执行）

- GPT-SoVITS v3/v4 具体版本号无可靠出处
- Wan 3.0 / LTX-3 / ACE-Step 2.x / InstantID v2 / SD4：均无官方发布证据
- BSMamba2/SCNet 有论文 SOTA 声明但无可用 checkpoint
