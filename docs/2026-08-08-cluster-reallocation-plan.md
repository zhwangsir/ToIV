# 集群资源重排方案(2026-08-08)

> 基于 2026-08-08 全设备普查 + 利用率深度摸查(全部为实时命令数据,非估算)。
> 配套文档:`docs/2026-08-08-cluster-services-handover.md`(服务清单)。

---

## 一、利用率真相(数据先行)

### 有真实流量的

| 资源 | 数据 | 判读 |
|---|---|---|
| spark02 qwen3.6-uncensored | 24h 220 次 / 7d 918 次 | **LLM 层唯一主力**,集群 LLM 流量全压在这台 |
| workstation GPU0 | LB 7 天 71% 分发(231/325)+ TTS + H3 分片共卡 | **最热的一张卡** |
| EXO studio01-03 | CPU 时间 1489-3199 min | 中等使用(LLM L2/L3 层) |
| toiv-vlm(反推,8/8 上线) | 首日 34 次 | 新功能有真实需求,值得常驻 |
| H3 :8195 | 7d 132 次(多为测试) | 生产引擎,突发型 |

### 闲置/浪费的(重排的核心依据)

| 资源 | 数据 | 浪费 |
|---|---|---|
| **LiveAct(GPU1)** | **7 天 1 次请求**,常驻占 ~58GB | 🔴 最大显存浪费点 |
| **spark01 llama-70b** | 日均 1.4 次 | 🔴 整台 GB10 空转 |
| FlashTalk+OpenTalking(GPU3) | 低负载常驻(日志多为健康检查) | 🟡 占卡但属产品待命,可接受 |
| SenseVoice | 上线 4 次 | 🟢 仅 1.7GB,忽略 |
| studio04(EXO) | CPU 时间仅 176 min | 🟡 偏闲(含今日重启因素) |
| **磁盘** | minimax-m3 双量化 376G + 停用 Nemotron 62G + 本地冗余 qwen3.6 120G | 🔴 ~550G 死重 |

---

## 二、重排方案

### P0 — 立即执行(低风险,纯收益)

**1. LiveAct 改按需加载,释放 GPU1 ~58GB**
- 现状:7 天 1 次请求,常驻白占 58GB。
- 方案:`systemctl stop toiv-liveact && systemctl disable toiv-liveact`;core API 提交 LiveAct 作业前经 SSH/sudoers 规则 `systemctl start toiv-liveact`(启动 ~2-3min 加载,前端提示"引擎预热中"),作业完成且空闲 30min 后自动 stop(空闲定时器脚本)。
- 收益:GPU1 常驻占用 83GB → ~8.4GB(仅 Embedding),成为集群最大的显存缓冲池,可承接:JoyCaption、Omni-Captioner、H3 突发溢出。

**2. pc02 ComfyUI 复归**
- 诊断:进程 8/8 07:26-13:06 间静默消失(无 traceback,疑似手动关闭),计划任务完好(Ready)。
- 方案:先与用户确认是否人为停机;若非人为,`schtasks /run` 拉起并观察 24h。
- 收益:LB 后端恢复 3 个,gpu0 的 71% 分发压力摊薄。

**3. 磁盘清理 ~550G(workstation / 盘)**
- 删:minimax-m3-nvfp4 233G + minimax-m3-awq 143G(无对应在跑服务;若留念先归档 NAS,44T 才用 11%)
- 删:Nemotron-3-Nano-Omni 62G(vLLM 已停用,AGENTS 已记)
- 确认后删:本地 qwen3.6-uncensored 120G(spark02 有独立副本在跑)
- 收益:/ 盘 1.4T → ~0.85T,远离磁盘水位风险。

**4. Workstation 重启窗口(30 分钟,建议凌晨)**
- 根治 NVML mismatch(驱动 595.84 vs 内核 595.71.05),顺带让 vLLM 摆脱补丁。
- 前置:AI-Omni ASR 从 screen 改 systemd(否则重启后 ASR 丢失);重启后按 GPU 分配表逐项核对服务自启(全部已 systemd 化,仅 ASR 是缺口)。

### P1 — 本周执行(资源再分配)

**5. GPU1 新定位:弹性算力池**
- 常驻:仅 Qwen3-Embedding(8.4GB)。
- 按需:LiveAct(58GB)/ JoyCaption FP8(~10GB)/ Qwen3-Omni-Captioner 量化版(~20-35GB)。
- 互斥规则:LiveAct 作业与 Omni-Captioner 错峰(58+35=93GB 接近上限,不允许同时)。

**6. spark01 再利用:轻量推理节点**
- llama-3.3-70b-abliterated(L4 NSFW 层)日均 1.4 次,但它是 NSFW LLM 门控的唯一去处,**保留**。
- 同机加装(GB10 128GB 统一内存足够共存):JoyCaption GGUF/FP8(llama.cpp 或 vLLM aarch64,需验证)→ NSFW 反推专线与 NSFW LLM 同机,流量内聚。
- 若 aarch64 vLLM 验证失败,JoyCaption 退回 GPU1 按需方案(P1-5)。

**7. GPU3 封账**
- FlashTalk(~55GB)+ OpenTalking(1.5GB)+ VLM(29GB)= ~90GB,仅剩 8.6GB。
- 规则:**GPU3 不再新增任何服务**;数字人实时链路(FlashTalk)属产品待命,保留常驻。

**8. LB 分发权重优化**
- gpu0 吃 71% 分发不合理(它还与 TTS/H3 共卡)。pc02 复归后,LB 策略改为「空闲优先 + gpu0 降权」,目标分布 gpu0 40% / pc01 30% / pc02 30%。
- 需看 comfyui-lb.py 的选后端逻辑,加权重或 least-busy 策略(小改动,收益直接)。

**9. EXO studio04 观察**
- 今日重启导致数据失真,观察 3 天;若持续偏闲,将 EXO 路由策略(drama_refine_layer L2/L3)偏向 studio04 或让它独占一个模型实例。

### P2 — 二期容量落点(预登记,避免到时候乱塞)

| 新服务 | 落点 | 方式 |
|---|---|---|
| JoyCaption(NSFW 反推) | spark01(首选)/ GPU1 按需(备选) | 常驻 / 按需 |
| Qwen3-Omni-Captioner(音乐反推) | GPU1 按需 | 与 LiveAct 互斥 |
| 5 分钟长视频(LongCat 续段) | GPU2 现状即可(峰值 30GB) | 无需调整 |
| H3 扩容(若并发上来) | GPU1 弹性池可临时挂 H3 第二实例 | 按需 |

---

## 三、重排后 GPU 分配表(目标态)

| GPU | 常驻 | 按需/突发 | 空闲(常态) |
|---|---|---|---|
| GPU0 | ComfyUI:8189 + TTS:9200 + H3 UNet 分片 | H3 采样 | ~40GB |
| GPU1 | Embedding:9302(~8.4GB) | LiveAct:9400 / JoyCaption / Omni-Captioner | **~87GB(弹性池)** |
| GPU2 | ASR:9210 + demucs:9220 + SenseVoice:9211(~7GB) | H3 CLIP/VAE 48GB / LongCat 16-30GB | ~88GB(突发预留) |
| GPU3 | FlashTalk + OpenTalking + VLM:9303(~90GB) | —(封账) | ~8.6GB |

---

## 四、执行清单与风险

| # | 动作 | 风险 | 回滚 |
|---|---|---|---|
| P0-1 | LiveAct 按需化 | 首次请求多等 2-3min 预热 | enable+start 即恢复常驻 |
| P0-2 | pc02 复归 | 若是人为停机需先确认 | stop 即可 |
| P0-3 | 磁盘清理 | 删错模型 | 先 mv 到 NAS 归档区,7 天无误再删 |
| P0-4 | 重启窗口 | 服务起不来 | 全部 systemd + 清单核对;ASR 先 systemd 化 |
| P1-6 | spark01 加装 JoyCaption | aarch64 vLLM 兼容性 | 退回 GPU1 按需 |
| P1-8 | LB 权重 | 分发策略改动影响生产 | 改前备份 comfyui-lb.py,灰度观察 |

**明确不动的**:GPU0 现状(最热但稳定)、spark02(LLM 主力)、core 业务进程、EXO studio01-03、OpenClaw 网关层。

---

## 五、待用户决策

1. pc02 是否人为停机?可否直接拉起?
2. LiveAct 按需化的预热延迟(2-3min)是否可接受?(7 天 1 次的使用频率,值得)
3. 磁盘清理清单是否批准(建议先归档 NAS 再删)?
4. Workstation 重启窗口定什么时候(需要 30min 全服务中断)?
