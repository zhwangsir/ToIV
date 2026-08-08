# 集群资源重排方案 v3(2026-08-08,全精度版)

> v1「LiveAct 按需化」被否决;v2 按用户新要求升级为 v3:**禁止任何有损量化,全部 bf16/全精度常驻**。
> 数据基础:2026-08-08 全设备普查 + 利用率摸查(LiveAct 7d 1 次、spark01 日均 1.4 次、studio04 偏闲)。
> **执行状态:S1-S6 全部完成(2026-08-08 收官),真机验证见 TEST_LOG REVERSE-S3 / REALLOC-S46。**

---

## 一、现状问题(回顾)

- LiveAct 常驻 GPU1 占 58GB,7 天 1 次请求 → 用户决策:保留常驻当热备
- spark01(llama-70b 日均 1.4 次)、studio04(EXO 偏闲)= 两台设备近乎空转
- GPU3 满(FlashTalk 55 + OpenTalking 1.5 + VLM 29 ≈ 90GB),JoyCaption 无处安放
- LB 分发失衡:gpu0 吃 71%(还与 TTS/H3 共卡)
- 磁盘死重 ~550G;NVML mismatch 待重启;ASR 还是 screen 托管

---

## 二、执行结果(按依赖排序)

### S1. studio04 部署 MLX Qwen3-VL-8B(bf16)✅ 已完成
- studio04(192.168.71.113,dgmt-studio04)mlx-vlm 0.6.10,模型 `mlx-community/Qwen3-VL-8B-Instruct-bf16`(**全精度,非 4bit**,ModelScope 下载)
- OpenAI 兼容服务 :9303,launchd `com.dgmt.toiv-vlm-mlx.plist` 常驻
- 图像热请求 0.3s;⚠️ **视频只认本地路径不认 base64** → 引出 NAS 中转方案(S2)
- NAS 已挂 `~/nas_mnt`(LaunchAgent `com.dgmt.nas-mount.plist` 持久化)

### S2. core 切换反推上游 + 视频 NAS 中转 ✅ 已完成
- core .env:`TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.113:9303/v1` + `TOIV_REVERSE_VIDEO_MAC_PREFIX=/Users/dgmt-studio04/nas_mnt`,toiv-api 已重启
- 视频链路:core SFTP 落 `/NAS/toiv/reverse_tmp/` → 传 studio04 挂载路径 → 完事清理(零残留已验证)
- 代码:commit 7856008(`_stage_video_to_nas`/`_remove_staged`)
- **GPU3 toiv-vlm.service 已 stop+disable(停而不删)**,作 studio04 故障时秒级回退;GPU3 腾出 ~29GB

### S3. JoyCaption 落 GPU3(NSFW 反推专线,bf16)✅ 已完成
- ⚠️ **vLLM 0.11.2 跑 LLaVA 架构 JoyCaption 两次 device-side assert 崩溃(enforce-eager 也崩),已弃 vLLM**
- 最终方案:transformers 直跑。venv `/opt/toiv-joycaption/venv`(torch 2.11.0+cu130,transformers 5.14.1),server `/opt/toiv-joycaption/server.py`(OpenAI 最小子集,bf16,`CUDA_VISIBLE_DEVICES=3` :9304),systemd `toiv-joycaption.service`
- 模型 /home/merlin/models/joycaption-beta-one(16GB bf16,**非 FP8**),实测占 ~17GB
- core 路由(089cb4e):X-NSFW 图像 → JoyCaption;SFW 图像+全部视频 → studio04 Qwen3-VL;音频 → SenseVoice
- 输出被 max_tokens 截断的 JSON 骨架问题已修(71cc57b + 6bdfa03,`_salvage_prompt` 兜底提取)

### S4. spark01 加装 Omni-Captioner(音乐反推)✅ 已完成
- **llama-70b 已退役**(用户拍板):L2/L3/L4 切 spark02 qwen3.6-uncensored(.env 备份 .env.bak-20260808-llama),模型文件 92GB + 启动脚本保留可回滚,最终说明见交接文档第七节
- Omni-Captioner bf16 上线:spark01 docker `omni_captioner` :8000(60GB,gpu-util 0.65;镜像需启动时装 vllm[audio] 依赖,见 AGENTS 易错点 18)
- core 音乐链路(4ae94e9):demucs /separate_accompaniment → Omni 音乐描述与 SenseVoice 人声合并;.env 已配 TOIV_OMNI_CAPTIONER_BASE_URL,e2e 5.0s 通过

### S5. LB 权重修正 ✅ 已完成
- `/opt/ComfyUI/comfyui-lb.py` 打补丁(备份 `.bak-20260808`):gpu0 加 `"weight": 1.5`,选后端改加权队列最短
- comfyui-lb 已重启 active;pc02 已复归(LB 后端恢复 3 个:8189+pc01+pc02)

### S6. 杂项 ✅ 已完成
- 磁盘 558G 已归档 NAS `toiv/model-archive-2026-08-08/`(7 天无误再删),`/` 用量 1.3T→807G
- ASR screen → toiv-asr.service(enable 自启);comfyui-longcat 补 enable
- Workstation 已于 21:45 重启(中断 ~2min):**NVML mismatch 根治,nvidia-smi 恢复**;14 个 systemd 服务全自启;修复 NAS 无 fstab 条目隐患(重建凭据+补条目,易错点 17)

---

## 三、重排后设备角色(当前真实状态)

| 设备 | 角色 | 状态 |
|---|---|---|
| workstation GPU0 | ComfyUI+TTS+H3(不变) | 热 |
| workstation GPU1 | Embedding + LiveAct 热备(不变) | 中 |
| workstation GPU2 | ASR/demucs/SenseVoice + H3/LongCat 突发(不变) | 突发型 |
| workstation GPU3 | FlashTalk+OpenTalking+**JoyCaption bf16 ~17GB**(VLM 迁出) | 高,余量恢复 |
| **studio04** | **Qwen3-VL-8B bf16 MLX 反推服务 :9303**(新角色:VLM 节点) | 闲置 → 中 |
| studio01-03 | EXO LLM L2/L3(不变) | 中 |
| spark01 | llama-70b(L4);Omni-Captioner 待定 | 偏闲 |
| spark02 | LLM L1 主力(不变) | 高 |
| pc01/pc02 | ComfyUI 主力后端(LB 加权) | 低 → 中高 |

## 四、风险与回退

| 步骤 | 风险 | 回退 |
|---|---|---|
| S1/S2 studio04 VLM | studio04 宕机则图/视频反推全断 | GPU3 toiv-vlm 停而不删,.env 改回 + systemctl start 秒级恢复 |
| S3 JoyCaption | transformers 服务无 vLLM 的连续批处理,高并发吞吐低 | 反推是低频交互接口,可接受;最坏 disable 回退 Qwen3-VL |
| S4 Omni | 与 llama-70b 内存互斥 → llama 已退役 | 回滚路径见交接文档第七节(模型文件+脚本+env 备份全保留) |
| S5 LB 权重 | 分发策略改动影响生产 | 备份 .bak-20260808,改错即还原 |

## 五、终态验证数据(2026-08-08 真机)

- 反推四链路经 core :8090:NSFW 图像(JoyCaption)2.7s 纯文本无 JSON 骨架;SFW 图像(studio04)3.3s prompt+negative 齐全;视频(NAS 中转→studio04)6.5s 六段式叙事;音频(SenseVoice)0.3s 转写+情绪+语种
- 单测:1138 passed + 2 redis 预置失败(与本次无关);commits 7856008/71cc57b/6bdfa03
