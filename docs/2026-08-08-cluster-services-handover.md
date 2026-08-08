# 集群设备与运行服务交接文档(2026-08-08)

> **用途**:交接给项目管家。数据来自 2026-08-08 全设备实时 SSH 普查(只读),非凭记忆。
> **凭据**:见 ToIV/AGENTS.md 第二节(NAS SMB / Tailscale key),本文不重复记录。
> **第一硬性规则**:所有 AI/算力后端服务都在 Workstation(192.168.71.127),core 只是业务网关,Mac 只是操作终端。

---

## 一、设备总览(17 台,16 在线 / 1 不可达)

| 设备 | IP(LAN / Tailscale) | 角色 | 状态 | 关键服务 |
|---|---|---|---|---|
| workstation | 192.168.71.127 / 100.68.100.90 | **算力主机** 4×RTX PRO 6000(96GB/卡) | ✅ | 见第二节全表 |
| core | 192.168.71.47 / 100.77.80.100 | **业务网关**(ToIV web/api + PG/Redis) | ✅ | toiv-api :8090 / toiv-web :3100 / PG :5432 / Redis :6379 / frpc |
| NAS | 192.168.71.7 / 100.80.237.96 | SMB 存储 44T(用 4.8T,11%) | ✅ | SMB 共享名 `NAS`,管理 :5443 |
| spark01 | 192.168.71.82 / 100.81.235.124 | vLLM Ray(GB10) | ✅ | vLLM(docker):8000 / frpc / node-exporter |
| spark02 | 192.168.71.84 / 100.86.42.89 | vLLM Ray(GB10) | ✅ | vLLM(docker):8000(**LLM L1 大脑 qwen3.6-uncensored**) |
| studio01 | 192.168.71.109 / 100.67.43.40 | EXO 推理(M3 Ultra 512GB) | ✅ | EXO :52415 / deepfilternet :8301 / LM Studio :41343 |
| studio02 | 192.168.71.111 / 100.91.0.121 | EXO 推理 | ✅ | EXO :52415 |
| studio03 | 192.168.71.112 / 100.115.27.68 | EXO 推理 | ✅ | EXO :52415 |
| studio04 | 192.168.71.113 / 100.126.182.23 | EXO 推理 | ✅ | EXO :52415(无 node_exporter) |
| openclaw01-04 | .86/.75/.81/.85 | OpenClaw 网关(Mac mini) | ✅ | OpenClaw gateway :18789 ×4 |
| pc01 | 192.168.71.115 / 100.69.134.27 | ComfyUI worker(RTX 5090) | ✅ | ComfyUI :8188 |
| pc02 | 192.168.71.114 / 100.107.94.26 | ComfyUI worker(RTX 5090) | ⚠️ | **ComfyUI :8193 未运行**(OS 在线) |
| cloud | 43.119.32.180 / 100.83.78.114 | 网关/1Panel/frps | ❌ | SSH 超时(老问题,frpc 隧道端存活) |
| MateBook | — / 100.74.15.34 | 操作终端 | ✅ | — |

---

## 二、Workstation 服务全表(算力核心,全部 systemd 除注明)

| 服务 | 端口 | GPU | systemd unit | 路径/备注 |
|---|---|---|---|---|
| ComfyUI-LB(负载均衡) | :8188 | — | comfyui-lb.service | /opt/ComfyUI/comfyui-lb.py;**当前后端仅 :8189+pc01:8188**(pc02 停了) |
| ComfyUI #1 | :8189 | GPU0 | comfyui-gpu0.service | /opt/ComfyUI,`--cache-lru 8` |
| MiniMax H3 worker | :8195 | GPU0+GPU2 | toiv-comfyui-h3.service | /home/merlin/ComfyUI-h3-eval;UNet 跨 GPU0/GPU2/CPU,LoRA 走 NAS h3/loras(10 个已就位) |
| LongCat-Video 实例 | :8197 | GPU2 | comfyui-longcat.service | /home/merlin/ComfyUI-longcat,与生产 /opt/ComfyUI 隔离;含 LongCat-Avatar 链路 |
| IndexTTS2 | :9200 | GPU0 | toiv-tts.service | /home/merlin/index-tts |
| AI-Omni ASR(whisper large-v3) | :9210 | GPU2 | ⚠️ **screen 托管**(非 systemd) | /opt/ai-omni-asr,`screen -S ai-omni-asr` |
| demucs 人声分离 | :9220 | GPU2 | toiv-audio-sep.service | 契约 POST /separate |
| Qwen3-Embedding-4B | :9302 | GPU1 | qwen3-embedding.service | OpenAI /v1/embeddings 兼容 |
| LiveAct batch worker | :9400 | GPU1 | toiv-liveact.service | torch elastic :29500 |
| FlashTalk WS | :9000 | GPU3 | flashtalk.service | 数字人实时对话 |
| OpenTalking 统一 API | :4403 | GPU3 | opentalking.service | + opentalking-tts-shim |
| hunyuanimage(docker) | :8600 | ? | docker 容器 | ⚠️ AGENTS.md 未记录,`hunyuanimage:2.1-fp8`,普查时发现 |
| toiv-vlm(Qwen3-VL-8B 反推) | :9303 | GPU3 | toiv-vlm.service | **2026-08-08 新增**,见第四节 |
| toiv-sensevoice(语音情绪标注) | :9211 | GPU2 | toiv-sensevoice.service | **2026-08-08 新增**,见第四节 |

**GPU 显存快照**(torch mem_get_info;nvidia-smi NVML mismatch 未恢复,重启窗口待安排):
- GPU0:用 ~61GB(ComfyUI+H3 分片+TTS),空 40.9GB
- GPU1:用 ~83GB(LiveAct+Embedding),空 19.4GB
- GPU2:用 ~7GB(ASR+demucs 空闲态;H3 CLIP/VAE 突发 48GB / LongCat 作业 16-30GB),空 95.1GB
- GPU3:用 ~61GB(FlashTalk+OpenTalking),空 40.7GB

**磁盘**:`/` 7.3T 用 1.3T(19%);NAS 挂载 /home/merlin/nas_mount 正常(44T 用 4.8T)。

---

## 三、core 服务全表(业务网关)

| 服务 | 端口 | 备注 |
|---|---|---|
| toiv-api.service | :8090 | uvicorn /home/merlin/toiv/api;**唯一生产 API** |
| toiv-web.service | :3100 | next-server;**唯一生产前端** |
| postgresql@18-main | 127.0.0.1:5432 | 真机 |
| redis-server | 127.0.0.1:6379 | 真机 |
| frpc | — | 到 cloud 的隧道客户端 |
| AICG-DownLoader | :8100 | ⚠️ 别人的项目(/home/merlin/AICG-DownLoader-main),**不要碰**,pgrep uvicorn 会误匹配 |
| python3 -m http.server | :3501 | ⚠️ 来源待确认(pid 279949),建议管家核查去留 |

部署:`bash deploy/deploy.sh`(ToIV 仓库根);.env 在 core /home/merlin/toiv/deploy/.env(gitignored,deploy.sh 不同步)。已配关键项:TOIV_REDIS_URL、TOIV_H3_BASE_URL、TOIV_CIVITAI_API_KEY、TOIV_NAS_HOST/PASSWORD。

---

## 四、2026-08-08 新增:反推提示词链路(已真机验证)

- **功能**:用户上传图/视频/音频 → 反推出可复用提示词,回填生成表单(core `POST /api/reverse`,前端 PromptBar「反推」按钮,commit e4838db + 4914afd)。
- **toiv-vlm.service**:Qwen3-VL-8B-Instruct vLLM 0.11.2,GPU3,:9303,OpenAI 兼容,`--gpu-memory-utilization 0.35`(实测占 ~29GB,**GPU3 仅剩 ~8.6GB 空闲**)。venv /opt/toiv-vlm,模型 /home/merlin/models/Qwen3-VL-8B-Instruct(17GB,ModelScope)。⚠️ vLLM 靠 `/home/merlin/patch_vllm_nvml.py` 补丁绕 NVML mismatch,升级 vllm 后需重跑。
- **toiv-sensevoice.service**:FunASR SenseVoiceSmall,GPU2(~1.7GB),:9211,`POST /analyze` → {text, emotion, events, language}。venv /opt/toiv-sensevoice(torch+torchaudio 固定 2.11.0),模型 /home/merlin/models/SenseVoiceSmall + fsmn-vad。
- **core 配置项**:`TOIV_REVERSE_VLM_BASE_URL`(默认 http://192.168.71.127:9303/v1,模型名 /models 自动探测)、`TOIV_SENSEVOICE_URL`(默认 http://192.168.71.127:9211);上传上限 图 20MB / 视频 50MB / 音频 30MB。
- **真机 e2e(2026-08-08,经 core :8090)**:图像 1.4s(prompt+negative,画面元素/颜色/构图全对)、视频 3.6s(六段式叙事,运镜/场景/光线准确)、音频 0.2s(转写+HAPPY 情绪+Speech 事件+zh 语种)。
- **二期规划**:JoyCaption(NSFW 图像专线,⚠️ GPU3 已满需另找卡或按需加载)、Qwen3-Omni-Captioner(音乐反推,先 API 验证)、长视频混合法(场景切分+抽帧)。

---

## 五、普查发现的偏差(管家需处理/知悉)

1. **pc02 ComfyUI :8193 未运行** → ComfyUI-LB 后端只剩 2 个(8189+pc01),需重启(计划任务 start_comfyui.bat,见 AGENTS.md 易错点 5)。
2. **workstation docker 实际在跑** hunyuanimage:2.1-fp8(:8600),AGENTS 未记录,确认归属后补登记。
3. **core :3501** 有来源不明的 `python3 -m http.server`,核查去留。
4. **AI-Omni ASR 仍是 screen 托管**,重启后不会自启,建议 systemd 化。
5. cloud SSH 仍不可达(banner 超时老问题),frps 隧道本身存活。
6. spark01 有 frpc、spark02 无;studio04 缺 node_exporter(监控盲区)。
7. Workstation NVML mismatch(驱动 595.84 vs 内核 595.71.05)→ **重启即恢复**,需安排重启窗口;临时用 torch mem_get_info 观测显存。

---

## 六、运维速查

- 查服务状态(Workstation):`ssh merlin@192.168.71.127 'systemctl status toiv-tts comfyui-gpu0 ...'`
- 查显存:`torch.cuda.mem_get_info(i)`(nvidia-smi 坏)
- pip:清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`;模型下载走 ModelScope;github 用 ghfast.top 镜像
- civitai 下载:core `POST /api/nas/download` 优先;B2 对象存储直连不通时用 Mac 本地代理(127.0.0.1:7897)+ /Volumes/NAS 兜底(AGENTS 易错点 12)
- /tmp 是 tmpfs,大文件禁止写 /tmp
- pkill -f 模式串用 `[.]` 转义防自杀
