# 集群资源重排方案 v2(2026-08-08)

> v1 的「LiveAct 按需化」被否决(预热 2-3min 太慢)。v2 原则:**全部服务常驻,用闲置设备承接新负载,每台设备都干活**。
> 数据基础:2026-08-08 全设备普查 + 利用率摸查(LiveAct 7d 1 次、spark01 日均 1.4 次、studio04 偏闲、GPU3 仅剩 8.6GB)。
> 已执行:pc02 ComfyUI 复归验证(18:15 LB 日志 → HEALTHY,后端恢复 3 个)。

---

## 一、现状问题(不变)

- LiveAct 常驻 GPU1 占 58GB,7 天 1 次请求 → 但用户决策:**保留常驻当热备,不折腾**
- spark01(llama-70b 日均 1.4 次)、studio04(EXO 偏闲)= 两台设备近乎空转
- GPU3 满(FlashTalk 55 + OpenTalking 1.5 + VLM 29 ≈ 90GB,剩 8.6GB),JoyCaption 二期无处安放
- LB 分发失衡:gpu0 吃 71%(还与 TTS/H3 共卡)
- 磁盘死重 ~550G;NVML mismatch 待重启;ASR 还是 screen 托管

---

## 二、v2 核心思路:一次「服务迁移链」

```
toiv-vlm(Qwen3-VL-8B): GPU3 → studio04(MLX,闲置 512GB 激活)
        ↓ GPU3 腾出 ~29GB
JoyCaption FP8(NSFW 反推专线): 新建,落 GPU3(常驻,贴近 H3 R18 链路)
        ↓
spark01: 保留 llama-70b(L4)+ 加装 Qwen3-Omni-Captioner(音乐反推,GB10 激活)
        ↓
pc01/pc02: LB 权重上调,吃下 gpu0 让出的 30% 分发(5090 利用率拉满)
```

迁移后每台设备的角色:

| 设备 | 重排后角色 | 利用率 |
|---|---|---|
| workstation GPU0 | ComfyUI+TTS+H3(不变) | 热(减负后) |
| workstation GPU1 | Embedding + LiveAct 热备(不变) | 中 |
| workstation GPU2 | ASR/demucs/SenseVoice + H3/LongCat 突发(不变) | 突发型 |
| workstation GPU3 | FlashTalk+OpenTalking+**JoyCaption**(VLM 迁出) | 高,有合理余量 |
| **studio04** | **Qwen3-VL-8B MLX 反推服务**(新角色:VLM 节点) | 闲置 → 中 |
| studio01-03 | EXO LLM L2/L3(不变,drama 路由多打过来) | 中 |
| **spark01** | llama-70b(L4)+ **Omni-Captioner**(新) | 闲置 → 中 |
| spark02 | LLM L1 主力(不变) | 高 |
| pc01/pc02 | ComfyUI 主力后端(LB 权重上调) | 低 → 中高 |

---

## 三、执行步骤(按依赖排序)

### S1. studio04 部署 MLX Qwen3-VL(替代 GPU3 的 toiv-vlm)
- studio04(192.168.71.113,dgmt-studio04)装 mlx-vlm(`pip install mlx-vlm`,Mac 走默认 PyPI 即可),拉 `mlx-community/Qwen3-VL-8B-Instruct-4bit`(~5GB,HF 直连 Mac 有 mihomo 代理 :7890)
- 起 OpenAI 兼容服务(mlx_vlm.server 或 FastAPI 包装),端口 :9303,launchd 常驻(仿 EXO 托管方式)
- 验证:同一张测试图对比 GPU3 vLLM 输出质量;图像/视频响应延迟(MLX 4bit 8B 在 M3 Ultra 预期 2-5s,可接受)
- ⚠️ 视频输入:mlx-vlm 对 video 支持需实测;若不支持,视频反推仍走 GPU3(见 S3 保留策略)

### S2. core 切换反推上游
- core .env:`TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.113:9303/v1`,重启 toiv-api
- e2e 三链路重验(图/视频/音频)
- **GPU3 的 toiv-vlm.service 停而不删**(disable),作为 studio04 故障时的秒级回退

### S3. JoyCaption 落 GPU3(NSFW 反推专线)
- GPU3 腾出 29GB 后,`toiv-joycaption.service`:JoyCaption Beta One FP8(~10GB),vLLM 复用 /opt/toiv-vlm/venv,`--gpu-memory-utilization 0.12`,端口 :9304
- core:X-NSFW 上下文的图像反推路由到 JoyCaption(Descriptive 模式),SFW 仍走 Qwen3-VL;/api/reverse 加 `joycaption_base_url` 配置与路由逻辑
- R18 e2e 验证(用已有 NSFW LoRA 测试图)

### S4. spark01 加装 Omni-Captioner(音乐反推)
- 验证 aarch64 vLLM 能否跑 Qwen3-Omni-30B-A3B-Captioner AWQ(~35GB;与 llama-70b fp8 ~70GB 共 128GB 统一内存,需实测显存配额)
- 若 vLLM 不支持 Omni 架构 → 备选:llama.cpp GGUF,或暂缓(音乐反推本来就是 API 验证优先)
- core 音频反推链路:demucs 分离背景 → 背景音乐走 Omni-Captioner(目前只有人声 SenseVoice 一路)

### S5. LB 权重修正
- 看 comfyui-lb.py 选后端逻辑,加 least-busy/权重:目标分布 gpu0 40% / pc01 30% / pc02 30%
- 灰度观察 24h(gpu0 共卡 TTS/H3,压力下降即成功)

### S6. 杂项(与 v1 相同)
- 磁盘清理 550G:先 mv NAS 归档区,7 天无误再删
- ASR screen → systemd 化;Workstation 重启窗口(30min,根治 NVML)
- drama_polish_layer L1 → L3 评估(EXO 健康,把流量引回 Mac Studio 集群)

---

## 四、风险与回退

| 步骤 | 风险 | 回退 |
|---|---|---|
| S1 MLX VLM | mlx-vlm 视频输入不支持 / 质量回退 | 视频反推继续走 GPU3;S2 不改 .env |
| S2 切换 | studio04 宕机则反推全断 | GPU3 toiv-vlm 停而不删,.env 改回秒级恢复 |
| S3 JoyCaption | GPU3 余量仅 ~19GB,FlashTalk 突发可能挤占 | util 0.12 封顶 + torch 监控;最坏 disable |
| S4 Omni | aarch64 兼容性未知 | 暂缓,音乐反推走云端 API 验证 |
| S5 LB 权重 | 分发策略改动影响生产 | 备份 comfyui-lb.py,改错即还原 |

## 五、预期终态 GPU/设备占用

- GPU3:FlashTalk 55 + OpenTalking 1.5 + JoyCaption 10 ≈ 67GB,**余 29GB**(从 8.6GB 解救)
- studio04:EXO + Qwen3-VL-4bit(MLX,~6GB 统一内存),不再是闲节点
- spark01:llama-70b + Omni-Captioner,GB10 统一内存用到 ~105/128GB
- LB:gpu0 40% / pc01 30% / pc02 30%
