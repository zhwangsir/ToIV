# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-08-17（晚·DashBox 记忆交叉真机复核:GPU 归属大改——H3 纯 GPU2、LTX-2.5 迁 GPU3、JoyCaption 迁 GPU2、新增 CosyVoice2/3+Qwen3-TTS+FireRedASR;🚨 P0:studio04 VLM :9303 与 demucs 全集群离线而 core 生产配置仍指向死服务;EXO :52415 实跑 MiniMax-M2.7-4bit 非 GLM-5.2）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」

---

## 〇、🔒 第一硬性规则：所有后端服务都来源于 Workstation

> **所有 AI/算力后端服务（ComfyUI/LB、IndexTTS2、ASR、Embedding、LiveAct、H3、LongCat、FlashTalk、OpenTalking、JoyCaption 等）全部运行在 Workstation(192.168.71.127 / 100.68.100.90)上。**
>
> - ⚠️ **2026-08-17 晚真机复核（推翻 08-09 记录，已当场修复）**：studio04 VLM 反推 :9303 plist 被删致服务停——已重建 plist 复活（KeepAlive 常驻）；studio01 demucs-mlx :9221、studio02 whisper.cpp :9212 均已不存在（plist 全无）——demucs 已回落 Workstation `toiv-audio-sep :9220`（active+enabled），ASR 主用 Workstation `toiv-asr :9210`（active）。core .env 死指向已修：`TOIV_VLM_SERVER_URL`→spark01:8000(molmo2-8b)。生产 `/api/reverse` 实测 200。详见易错点 31。
> - core(192.168.71.47)只跑 ToIV web/api + PostgreSQL/Redis，是业务网关，不是算力来源
> - 本机 Mac 只是操作终端；任何配置里出现的 `127.0.0.1` / `localhost` 服务地址（如 `opentalking_base_url` 默认 `http://127.0.0.1:4403`）都只是本地 dev 兜底，**真机排查一律先查 Workstation**
> - 排查「服务离线/引擎不可达」时，第一反应必须是 SSH 到 Workstation 查 systemd 状态和端口监听，禁止臆断服务不存在

## 〇、🔒 第二硬性规则：文档仅供参考，必须真机验证

> **AGENTS.md、STATE.json、TEST_LOG.md、项目 wiki 等所有文档都仅供参考，不能替代真机验证。**
>
> - 凡是涉及 GPU 显存、服务状态、端口监听、文件路径、挂载状态、模型占用、硬件配置等问题，必须先 SSH/登录到目标设备，执行真实命令（如 `nvidia-smi`、`systemctl status`、`ss -tlnp`、`mountpoint`、`df -h`、`free -h`、`ps aux`、`lsof` 等）后再作答
> - 文档与真机输出冲突时，**以真机输出为准**，并应据此修正文档
> - 禁止凭记忆、文档或臆测回答容量/状态/可用性类问题；所有结论必须有当前真机命令输出作为依据

---

## 一、集群设备清单（18台）

| # | 设备 | 角色 | LAN IP | Tailscale IP | 类型 | SSH 用户 |
|---|------|------|--------|-------------|------|---------|
| 1 | studio01-04 | EXO RDMA 推理(:52415,**2026-08-17 真机实跑 MiniMax-M2.7-4bit 122.7GB**,非 GLM-5.2;studio04 VLM 反推 :9303 **已于 2026-08-17 查实离线**,launchctl 无 toiv-vlm-mlx 条目) | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | **Mac Studio M3 Ultra 32核 512GB**（⚠️ 不是 M2 Pro，已确认 2026-08-02） | dgmt-studio01-04 |
| 2 | openclaw01-04 | OpenClaw 网关 | .86/.75/.81/.85 | 100.69.0.4 / 100.76.35.7 / 100.76.140.121 / 100.91.128.30 | Mac mini M2 | dgmt-openclaw01-04 |
| 3 | spark01-02 | spark01: **Molmo2-8B** 音乐反推(双名 omni-captioner/molmo2-8b,容器 molmo2_captioner, :8000);spark02: LLM L1-L4 主力(**Qwen3.8-27B-NVFP4**,别名 qwen3.6-uncensored 仍有效, :8000) | .82/.84 | 100.81.235.124 / 100.86.42.89 | Linux GB10 | dgmt-spark |
| 4 | workstation | 算力+真机服务 | 192.168.71.127 | 100.68.100.90 | Linux 4×RTX PRO 6000 | merlin |
| 5 | pc01 | ComfyUI worker | 192.168.71.115 | 100.69.134.27 | Windows RTX 5090 | home |
| 6 | pc02 | ComfyUI worker | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| 7 | NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 8 | cloud | 网关/1Panel/frps | 43.119.32.180 | 100.83.78.114 | Linux | root |
| 9 | core | 服务器(待业务) | 192.168.71.47 | 100.77.80.100 | Ubuntu | merlin |
| 10 | beijing | 北京国内入口/frps | 8.140.222.24 | — | Linux (阿里云) | root |
| 11 | MateBook | 操作终端 | — | 100.74.15.34 | macOS | 本机 |

---

## 二、关键凭据

> ⚠️ 这些凭据已多次询问用户，**禁止再次询问**

| 服务 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| NAS SMB | dgmt-nas | Aki.19950108 | 192.168.71.7，共享名 NAS |
| Tailscale Auth Key | — | tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C | 已用于 core 设备授权 |

### NAS 挂载方式

**Linux (Workstation)**：已配置 fstab 自动挂载到 `/home/merlin/nas_mount`
```bash
# 凭据文件：/root/.smbcredentials（如不存在，内容为）
# username=dgmt-nas
# password=Aki.19950108
```

**Windows (PC01/PC02)**：用 `net use` + `cmdkey` + 计划任务自动挂载
```cmd
cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108
net use Z: \\192.168.71.7\NAS /persistent:yes
```

---

## 三、Workstation GPU 分配（🔒 硬性规则，不可随意更改）

> ⚠️ **2026-07-28 错误教训**：我曾把 IndexTTS 放到 GPU3。TTS 应在 GPU0。**每次启动服务前必须核对此表**。
> 
> ⚠️ **2026-08-05 更新**：Nemotron vLLM 已停用，GPU3 现用于 FlashTalk + OpenTalking；ComfyUI-LB 收敛为 gpu0 + pc01 + pc02。
> 
> ⚠️ **2026-08-09 更新**：下表「显存占用」为**2026-08-09 10:46 真机 `nvidia-smi` 快照**，实际会随缓存策略(`--cache-lru`)、模型加载状态、是否正在采样、进程共享/分片等因素动态变化。**禁止把表中数字当成静态真理**，做容量规划前必须重新 SSH 核查。详见第六节「易错点 19」及归档摘要 `docs归档说明.md` 第一节(原交接文档已删除)。
>
> ⚠️ **2026-08-09 18:00 更新（⚠️ 已被 2026-08-17 复核推翻）**：~~Phase 1 服务迁移已执行——GPU2 `qwen3-embed-vllm.service :1234` 已 stop+disable；`demucs` 已迁移至 **studio01 demucs-mlx :9221**；`ASR(faster-whisper)` 已迁移至 **studio02 whisper.cpp large-v3-turbo :9212**~~。2026-08-17 真机查实：studio01/02 的 plist 均已不存在、端口全不通，demucs 全集群离线，ASR 已回落 Workstation toiv-asr :9210（active）。**教训：一次性手工迁移的状态必须定期真机复核，见易错点 30。**
> 
> 🔒 **Mac Studio 格式优先级**：Apple Silicon 优先使用 **MLX** 原生格式；GGUF/llama.cpp 仅作为无 MLX 支持时的备选，且通常更慢、效果更难保证。

| GPU | 服务 | 端口 | 显存占用(2026-08-17 晚真机) | systemd 服务 | 备注 |
|-----|------|------|---------------------|-------------|------|
| GPU0 | ComfyUI #1 | :8189 | **~7.5GB** | **comfyui-gpu0.service** | 与 IndexTTS2、CosyVoice2 共卡(H3 已不在此卡);2026-08-08 起带 `--cache-lru 8` 缓存上限 |
| GPU0 | IndexTTS2 | :9200 | **~8.6GB** | **toiv-tts.service** | `CUDA_VISIBLE_DEVICES=0`;**质量优先，不迁移** |
| GPU0 | CosyVoice2 | :9201 | **~3.5GB** | (cosyvoice server.py) | 2026-08-17 复核确认在跑;/home/merlin/cosyvoice |
| GPU0(合计) | — | — | **19.6GB / 97.9GB** | — | H3 已于此前迁出(见 GPU2) |
| GPU1 | Qwen3-Embedding-4B | :9302 | **~19.9GB** | **qwen3-embedding.service** | `CUDA_VISIBLE_DEVICES=1`;生产保持 sentence-transformers;⚠️ 另有第二实例(PID 级)**误占 :9303**(1.3GB,本应是 VLM 热回退端口,2026-08-17 查实) |
| GPU1 | LiveAct batch worker | :9400 | **~59GB** | **toiv-liveact.service** | `nproc_per_node=1`，单卡 GPU1 |
| GPU1 | ComfyUI 超分专用实例 | :8261 | **~0.75GB**(空闲) | **comfyui-upscale-gpu1.service** | M6 并行超分 fleet,仅跑 4x-UltraSharp 帧超分,与 LiveAct 共卡实测无冲突;`--cache-lru 2 --disable-smart-memory` |
| GPU1(合计) | — | — | **81.1GB / 97.9GB** | — | |
| GPU2 | AI-Omni ASR (faster-whisper large-v3) | :9210 | **~4.3GB(在跑)** | **toiv-asr.service(active)** | ⚠️ **2026-08-17 复核:本服务 active 且是生产 ASR 主用**;studio02 whisper.cpp :9212 已不存在(launchctl 无条目/端口不通)——「已迁移 studio02」记录作废;core 无独立 ASR 配置项,走 workstation |
| GPU2 | FireRedASR | :8300 | **~5.4GB** | (fireredasr server.py) | 2026-08-17 复核确认;ASR 回退;/home/merlin/fireredasr |
| GPU2 | CosyVoice3 | :9202 | **~4.3GB** | **toiv-cosyvoice3.service** | 2026-08-17 新增确认;/home/merlin/cosyvoice3 |
| GPU2 | Qwen3-TTS 1.7B | :9203 | **~5.3GB** | **toiv-qwen3tts.service** | 2026-08-17 新增确认;97ms 低延迟克隆 |
| GPU2 | demucs 人声分离 | :9220 | **~1GB(2026-08-17 复活)** | **toiv-audio-sep.service(active+enabled)** | ✅ 2026-08-17 晚 `enable --now` 恢复;此前 inactive+disabled,core `TOIV_AUDIO_SEP_URL` 指向它 → 链路已修通 |
| GPU2 | SenseVoice 语音情绪/事件标注 | :9211 | **~1.7GB** | **toiv-sensevoice.service** | 反推提示词音频链路;/opt/toiv-sensevoice |
| GPU2 | MiniMax H3 (ComfyUI worker) | :8195 | **~41.3GB** | **toiv-comfyui-h3.service** | ⚠️ **2026-08-17 真机:进程仅在 GPU2**(GPU0 已无 H3 进程;此前「UNet 跨 GPU0/GPU2/CPU」描述作废) |
| GPU2 | JoyCaption Beta One(NSFW 反推专线) | :9304 | **~16.7GB** (bf16) | **toiv-joycaption.service** | ⚠️ **已从 GPU3 迁入 GPU2**(2026-08-17 复核确认,DashBox 负载均衡调整);transformers 直跑(vLLM 0.11.2 跑 LLaVA 会 device-side assert,勿用) |
| GPU2 | LongCat-Video (ComfyUI 独立实例) | :8197 | **~0.9GB**(空闲,采样时 16-30GB) | **comfyui-longcat.service** | 实例 /home/merlin/ComfyUI-longcat;含 LongCat-Avatar 链路 |
| GPU2 | ComfyUI 超分专用实例 | :8262 | **~0.75GB**(空闲) | **comfyui-upscale-gpu2.service** | M6 并行超分 fleet |
| GPU2(合计) | — | — | **80.9GB / 97.9GB** | — | ⚠️ 已接近 80GB 共卡红线,新增服务前必查 |
| GPU3 | FlashTalk WebSocket Server | :9004 | **~50.7GB** | **flashtalk.service** | ⚠️ 端口已从 :9000 迁到 **:9004**(避免 MinIO 冲突,DashBox 调整,2026-08-17 确认) |
| GPU3 | OpenTalking 数字人统一 API | — | **~1.5GB** | **opentalking.service** | + opentalking-tts-shim |
| GPU3 | ComfyUI LTX-2.5 专用实例 | :8198 | **~36GB**(常驻) | **comfyui-ltx25.service** | ⚠️ **已从 GPU0 迁入 GPU3**(2026-08-17 复核确认,DashBox 负载均衡调整);SFW 视频主力引擎(音画同出);实例 /home/merlin/ComfyUI-ltx25;core 经 `TOIV_LTX25_BASE_URL` 接入,不入 LB 池 |
| GPU3 | Qwen3-VL-8B 反推 VLM | :9303 | (停) | toiv-vlm.service(⏸ inactive+disabled) | ⚠️ 热回退端口 :9303 被 embedding 第二实例占用;主用已恢复在 studio04(见下),本回退保持停用 |
| GPU3 | ComfyUI 超分专用实例 | :8263 | **~0.75GB**(空闲) | **comfyui-upscale-gpu3.service** | M6 并行超分 fleet |
| GPU3(合计) | — | — | **88.3GB / 97.9GB** | — | ⚠️ 四卡中最满,新增服务原则禁止 |
| —(studio04) | Qwen2.5-VL-72B-Instruct-4bit 反推 VLM | :9303 | **~42GB 统一内存(2026-08-17 复活)** | launchd `com.dgmt.toiv-vlm-mlx.plist`(✅ 已重建) | ✅ 2026-08-17 晚修复:plist 曾被删致今晨 04:37 服务停;miniconda env `toiv-vlm` + 39GB 模型完好,重建 plist(RunAtLoad+KeepAlive)拉起;core `TOIV_REVERSE_VLM_BASE_URL` 指向它,生产 /api/reverse 实测 200(10.2s) |
| —(studio01) | ~~demucs-mlx 人声分离~~ | :9221 | **0(已死)** | (plist 已不存在) | 2026-08-17 查实 plist 无;人声分离已回落 Workstation toiv-audio-sep :9220(active+enabled) |
| —(studio02) | ~~whisper.cpp ASR(large-v3-turbo)~~ | :9212 | **0(已死)** | (plist 已不存在) | 2026-08-17 查实离线;ASR 主用已回落 Workstation toiv-asr :9210 |

### ComfyUI-LB 后端配置
- 本地 1 后端：:8189(GPU0)
- 远程 2 后端：pc01 :8188 / pc02 :8193
- **GPU1 不跑独立 ComfyUI 后端**（GPU1 跑 LiveAct + Embedding；:8261 为 M6 超分专用实例，不入 LB 池）
- **GPU2 例外**:2026-08-07 起跑 LongCat-Video 专用独立实例（:8197，不入 ComfyUI-LB 后端池；fp8 权重与 H3 突发 48GB 可共存）；:8262 为 M6 超分专用实例
- **GPU3 不跑通用 ComfyUI**（跑 FlashTalk + OpenTalking + JoyCaption；:8263 为 M6 超分专用实例）
- **M6 超分 fleet**(2026-08-10): GPU1/2/3 各一个 upscale-only 实例 :8261/:8262/:8263,仅跑 4x-UltraSharp 帧超分,不入 LB 池;由 scripts/video_4k_upscale_parallel.py 或 orchestrator upscale 阶段(TOIV_4K_WORKERS)调用;真机冒烟 128 帧 3 卡并行 52s(单卡预估 ~154s,≈3× 加速),温度 38-48°C

### 关键服务路径（Workstation）

| 服务 | 路径 | venv | 启动命令 |
|------|------|------|---------|
| ComfyUI | /opt/ComfyUI | /opt/ComfyUI/venv (Python 3.12, torch 2.13.0+cu130) | `CUDA_VISIBLE_DEVICES=N venv/bin/python main.py --listen 0.0.0.0 --port 818X` |
| ComfyUI-LB | /opt/ComfyUI/comfyui-lb.py | 同上 | `venv/bin/python comfyui-lb.py` |
| IndexTTS2 | /home/merlin/index-tts | /home/merlin/index-tts/.venv (Python 3.11, torch 2.8.0+cu128) | `CUDA_VISIBLE_DEVICES=0 .venv/bin/python toiv_tts_server.py --host 0.0.0.0 --port 9200` |
| Qwen3-Embedding-4B | /home/merlin/models/Qwen3-Embedding-4B | /opt/nemotron-venv | `sudo systemctl start qwen3-embedding` |
| AI-Omni ASR | /opt/ai-omni-asr | /opt/ai-omni-asr (Python 3.12, faster-whisper 1.2.1) | `sudo systemctl start toiv-asr`(2026-08-08 起 systemd 托管,弃 screen) |
| MiniMax H3 (ComfyUI worker) | /home/merlin/ComfyUI-h3-eval 或 ToIV 部署路径 | ToIV venv | `sudo systemctl start toiv-comfyui-h3` |
| LiveAct batch worker | /home/merlin/toiv | ToIV venv | `sudo systemctl start toiv-liveact` |
| FlashTalk | /home/merlin/omnirt/runtimes/flashtalk/cuda | FlashTalk venv | `sudo systemctl start flashtalk` |
| OpenTalking | /home/merlin/opentalking | OpenTalking venv | `sudo systemctl start opentalking` |
| Drt ERP | /home/merlin/drt | — | **待项目负责人迁移到 core** |
| ToIV | /home/merlin/toiv | — | **待项目负责人迁移到 core** |

---

## 四、NAS 模型路径

| 路径 | 内容 | 大小 |
|------|------|------|
| `NAS/Windows/ComfyUI/ComfyUIModel/models` | 主模型库(workstation /opt/ComfyUI/models 是指向此处的 symlink,放一处三 worker 共享;2026-08-08 新增 URPM v1.3 SD1.5 2.1GB → checkpoints/) | 524GB+ |
| `NAS/toiv/comfyui-models` | ToIV 专用模型 | ~260GB |
| `NAS/toiv/comfyui-models/LongCat-Video` | 美团 LongCat-Video 13.6B 长视频模型(diffusers 布局: dit/text_encoder/vae/lora) | 83GB(2026-08-07 下载) |

### ComfyUI extra_model_paths.yaml 配置

**Workstation**：未配置（使用本地 /opt/ComfyUI/models）

**PC01/PC02**（已配置，注意不要包含 `custom_nodes`，会导致启动报错）：
```yaml
# C:\ComfyUI\extra_model_paths.yaml
nas:
    base_path: "Z:/Windows/ComfyUI/ComfyUIModel"
    checkpoints: models/checkpoints
    clip: models/clip
    clip_vision: models/clip_vision
    configs: models/configs
    controlnet: models/controlnet
    embeddings: models/embeddings
    loras: models/loras
    upscale_models: models/upscale_models
    vae: models/vae
    text_encoders: models/text_encoders
    diffusion_models: models/diffusion_models
    unet: models/unet
```

---

## 五、Core 设备状态

> **角色变更**：core 已从 Docker 监控栈改为真机服务器，待项目负责人推送 ToIV/DRT 业务

| 项目 | 状态 |
|------|------|
| PostgreSQL 18 | ✅ 真机运行 |
| Redis | ✅ 真机运行 (127.0.0.1:6379) |
| Docker | ❌ 已禁用+全清（12个监控容器已删） |
| ToIV/DRT 代码 | 待项目负责人推送 |
| 备份文件 | 在 Workstation /tmp（drt_pg_dump.sql / drt_redis_dump.rdb / drt_env_backup） |

---

## 六、⚠️ 易错点记录（避免重复犯错）

### 1. GPU 分配搞错（2026-07-28 / 2026-08-05 更新）
- **错误**：把 IndexTTS 放到 GPU3
- **正确**：GPU3 现用于 FlashTalk + OpenTalking；TTS 在 GPU0
- **教训**：启动服务前必须核对第三节 GPU 分配表，Nemotron vLLM 已停用

### 2. /tmp tmpfs 吃内存（2026-07-28）
- **错误**：往 /tmp 写大文件（toiv_code.tar.gz 8G）导致内存被吃
- **正确**：/tmp 是 tmpfs（内存盘），大文件应写到磁盘
- **教训**：打包备份文件写到 /var/tmp 或指定磁盘目录

### 3. Windows SSH session 隔离（2026-07-28）
- **错误**：在 SSH session 中 net use 映射 Z: 盘，用户桌面看不到
- **正确**：用 cmdkey 保存凭据 + schtasks 在登录时运行 net use，或创建 .bat 启动脚本
- **教训**：Windows 的 SMB 映射是 per-session 的

### 4. ComfyUI-LB 后端数量搞错（2026-07-27）
- **错误**：曾配置 6 个后端
- **正确**：5 个后端（3 本地 GPU0/1/2 + pc01 + pc02），GPU3 不跑 ComfyUI

### 5. Windows SSH session 中启动 ComfyUI 子进程被终止（2026-07-28）
- **错误**：通过 ssh 用 `Start-Process` 或 `wscript` 启动 ComfyUI，ssh 断开后子进程被杀
- **正确**：Windows 计划任务直接执行 `start_comfyui.bat`，且 `LogonType` 用 `InteractiveToken` 在用户登录后触发
- **教训**：不要依赖 ssh 启动长期运行的 GUI/服务进程；计划任务 + bat 是最稳定的开机自启方案

### 6. 重复询问 NAS 密码（多次）
- **错误**：多次询问 NAS SMB 密码
- **正确**：密码已记录在第二节，禁止再问

### 7. ⚠️ Mac Studio 配置搞错 + 臆造内存数据（2026-08-02，硬性错误）
- **错误1**：AGENTS.md 第一节将 studio01-04 写成 "Mac Studio M2 Pro"，实际是 **M3 Ultra 32核 512GB**
- **错误2**：回答用户问题时臆造 "4台总内存只有192GB（48GB×4）"，导致错误结论 "K3 装不下"
- **实际**：4台 × 512GB = **2TB 总内存**，K3（1.45TB）完全可以装下
- **教训**：🔒 **硬性规则** —— 回答任何涉及硬件配置/容量的问题前，必须先 SSH 确认真实配置，禁止凭记忆臆造数据
- **修复**：第一节已更新为 "Mac Studio M3 Ultra 32核 512GB"

### 8. Thunderbolt 169.254 地址硬编码会失效（2026-08-02）
- **错误**：在 start_exo.sh 中硬编码 169.254.x.x 链路本地地址作为 bootstrap peers
- **原因**：macOS 的 TB 链路本地地址每次重启或 TB 重新协商都会变化
- **正确**：bootstrap peers 用以太网固定地址（192.168.71.x），让 EXO mDNS 自动发现 TB 接口建立 RDMA
- **教训**：链路本地地址（169.254/16）永远不要硬编码到配置文件中

### 9. 新专用实例接入后必须补 resolve_worker 精确匹配（2026-08-07）
- **错误**：LongCat 实例（:8197）接入 core API 后，产物 URL 经 core 代理下载返回 502
- **原因**：`deps.resolve_worker()` 对不在 pool 白名单的 worker 会按 hostname 回退，8197 与 pool worker 8189 同机（192.168.71.127），被错配到 8189——其 output 目录没有 LongCat 产物
- **正确**：仿 H3 分支，在 hostname 回退之前对专用实例 base（`longcat_base`/`h3_base`）做精确匹配（commit df1f9ef）
- **教训**：🔒 每新增一个与 pool worker 同机的专用 ComfyUI 实例，必须同步检查 `apps/api/app/deps.py` 的 resolve_worker 精确匹配分支，否则作业能跑通但产物取不回来

### 10. LongCat TI2V 的 i2v 走 WanVideoEncode→extra_latents,不是 WanVideoImageToVideoEncode(2026-08-08)
- **坑**:凭节点名直觉会用 WanVideoImageToVideoEncode 做 i2v 首帧编码
- **正确**:官方示例 `LongCat_TI2V_example_01.json`(实例 :8197 example_workflows)的连线是 LoadImage → ImageResizeKJv2 → **WanVideoEncode → WanVideoEmptyEmbeds.extra_latents**(示例 note:For T2V disconnect the extra_latents);长帧数(>241)自动开窗 = WanVideoContextOptions(81/overlap16)接 WanVideoSampler.context_options + 块交换 10→30
- **附带**:core 登录接口 `/api/auth/login` 返回字段是 `token`,不是 `access_token`

### 11. LongCat-Avatar v1.5 音频链路必须 whisper-large-v3,不是 wav2vec2(2026-08-08)
- **坑**:按官方 v1.0 示例用 wav2vec2 音频编码,采样时报 `mat1 and mat2 shapes cannot be multiplied (1x46080 and 32000x512)`
- **原因**:LongCat-Avatar-1.5 的 AudioProjModel 期望 whisper-large-v3 特征(5×5×1280=32000);wav2vec2 是 v1.0 旧路线
- **正确**:`WhisperModelLoader`(audio_encoders 类目,P0 已下载到 NAS)+ `LongCatAvatarWhisperEmbeds`(fps=25、audio_stride=1);人声分离节点在独立仓库 ComfyUI-MelBandRoFormer(需 `rotary_embedding_torch` 依赖,模型 MelBandRoformer_fp32.safetensors 913MB 放实例 models/diffusion_models/)
- **附带**:① :8197 的 extra_model_paths.yaml 需补 `audio_encoders` 映射(vocal_separator 类目 WanVideoWrapper 不用,Kim_Vocal_2.onnx 本链路不需要);② 冒烟参数参考:480×832/93帧/25fps/steps=12/shift=12/cfg=1.0/dmd LoRA 1.0/BlockSwap=25/attention=sdpa,130s 出片,GPU2 峰值 ~20GB;③ 冒烟脚本在 workstation `/tmp/longcat_avatar_smoke.py`;④ **已接入 core API**(2026-08-08,commit a132468):`POST /api/avatar/talk`,图片+音频走 `/api/upload?kind=avatar`(multipart 字段名是 `image` 不是 `file`;**两文件须落同一 pool worker**,前端已做互钉);⑤ **长音频续段已实现**(commit 270946e):ExtendEmbeds 图内链式,首段 93 帧+每续段净 80 帧(overlap 13),**每段帧数必须 (T-1)%4==0**(残段自动向上取整 4k+1,最多多 3 帧),num_frames 上限 2500(≈100s);>30min 作业曾超 tracker `_TRACK_TIMEOUT=1800s` 靠 reconcile_loop 重挂落库(2026-08-14 起超时已配置化 `TOIV_JOB_TRACK_TIMEOUT` 默认 7200s 并带 /queue 孤儿检测,见易错点 26)

### 12. civitai 下载链与 b2 对象存储连通性(2026-08-08)
- **坑1**:`deploy/.env` 里常有 `# TOIV_NAS_HOST=` 这类注释占位,追加配置前用 `grep -q TOIV_NAS_HOST` 判断会误匹配注释行导致跳过追加,配置永远没生效;判断必须锚定行首(`grep -q '^TOIV_NAS_HOST='`)
- **坑2**:core `POST /api/nas/download` 对 civitai 源可能 0 字节超时——下载链 307 重定向到 `b2.civitai.com`(Backblaze B2),**core/workstation/Mac 直连 B2 全部 connect timeout**(镜像 API 本身正常,只是对象存储不可达);能否走 core 下载器取决于当次 307 落到哪个存储节点
- **正确**:core 下载器失败时,用 **Mac 本地代理(127.0.0.1:7897,Clash)下载 + /Volumes/NAS(已常驻挂载)SMB 拷贝** 兜底;命令模板见 TEST_LOG H3ECO-2026-08-08
- **附带**:core 下载器大文件走 SFTP 回退(cifs 挂载慢/超时),workstation 直连 civitai.red CDN 也极慢,优先 core 下载器,失败再走 Mac 代理路线

### 13. NVML mismatch 会干碎 vLLM 平台探测(2026-08-08)
- **坑**:驱动已升级(595.84)但运行中内核模块还是旧版(595.71.05)时,`pynvml.nvmlInit()` 抛 `NVMLError_LibRmVersionMismatch`,**vLLM 的 cuda_platform_plugin 因此返回 None → `RuntimeError: Failed to infer device type`**,服务起不来
- **正确**:给 vLLM 打 NVML 失败回退 torch.cuda 的补丁,脚本在 workstation `/home/merlin/patch_vllm_nvml.py`(**pip 重装/升级 vllm 后必须重跑**);根治 = 安排重启窗口让内核模块与驱动对齐
- **附带**:① vLLM 默认 `--gpu-memory-utilization 0.9`(85GB+),共卡部署必须显式调低;② 往 GPU3 加服务前必须 torch 查显存;③ funasr 不声明 torch 依赖,且 torch 2.13 无配套 torchaudio,需固定 torch+torchaudio==2.11.0;④ vLLM served-model-name 默认是模型目录绝对路径,core 侧调用不要写死模型名(/api/reverse 已改 /models 自动探测,commit 4914afd)

### 14. vLLM 0.11.2 跑不了 LLaVA 架构的 JoyCaption(2026-08-08)
- **坑**:JoyCaption Beta One(LLaVA 架构)在 vLLM 0.11.2 下两次 device-side assert 崩溃,`--enforce-eager` 也崩,白费两小时
- **正确**:这类多模态小模型直接 transformers 跑 OpenAI 兼容包装即可,参考 `/opt/toiv-joycaption/server.py`(bf16,单并发反推场景吞吐足够);不要盲目迷信 vLLM
- **附带**:JoyCaption 输出被 max_tokens 截断时会带 `{"prompt": "...` JSON 骨架,core 侧 `_salvage_prompt` 兜底提取(71cc57b/6bdfa03),截断点可能在 `"negative:` 键名内部,剥离正则要兼容无闭合引号变体

### 15. mlx-vlm 的 video_url 只认本地路径(2026-08-08)
- **坑**:core 把视频 base64 data-url 发给 studio04 MLX VLM 会直接报错,图像 base64 却正常
- **正确**:视频走 NAS 中转——core SFTP 落 `/NAS/toiv/reverse_tmp/`,把 studio04 `~/nas_mnt` 挂载路径发给 MLX,完事删除(7856008);开关是 core .env `TOIV_REVERSE_VIDEO_MAC_PREFIX`(置空退回 base64)
- **附带**:studio04 NAS 挂载用 LaunchAgent `com.dgmt.nas-mount.plist` 持久化;HF 大文件在 Mac 端走 mihomo 代理零速,studio04 上 ModelScope 直下快

### 16. ComfyUI-LB 加权分发补丁(2026-08-08)
- **背景**:LB 原选后端逻辑让 gpu0 吃 71% 分发(与 TTS/H3 共卡最不该多吃)
- **正确**:`/opt/ComfyUI/comfyui-lb.py` 已打补丁:gpu0 后端加 `"weight": 1.5`,选后端改「加权队列最短」(weight 越大越少被选);备份在同目录 `.bak-20260808`,改分发逻辑前先备份

### 17. NAS「fstab 自动挂载」记录失实(2026-08-08)
- **坑**:本文件曾记录 workstation NAS「已配置 fstab 自动挂载」,实际 /etc/fstab **没有任何 cifs 条目**,/root/.smbcredentials 也不存在;Workstation 重启后 NAS 静默未挂载,ComfyUI 模型 symlink 指向空目录
- **正确**:已重建 /root/.smbcredentials 并补 fstab 条目(`_netdev,x-systemd.automount,x-systemd.idle-timeout=0`);**每次 workstation 重启后第一件事必须 `mountpoint /home/merlin/nas_mount` 核实**
- **教训**:文档里「已配置」类的记录要按现场核实,尤其涉及凭据/挂载这类一次性手工操作

### 18. eugr/spark-vllm 镜像缺 vllm[audio] 依赖(2026-08-08)
- **坑**:spark01 的 vllm-node 镜像(eugr/spark-vllm)跑 Qwen3-Omni 音频输入直接 500:`ImportError: Please install vllm[audio]`;容器内 pip 装完**不重启动照样报错**(vLLM 懒加载缓存了 ImportError)
- **正确**:启动脚本 start_omni_captioner.sh 改为 `--entrypoint bash -c 'pip install av librosa soundfile && vllm serve ...'`(容器 --rm,每次启动自动装,镜像不重构建);改完必须重建容器才生效

### 19. 文档记录不可直接作为容量/状态结论的依据(2026-08-09)
- **坑**:AGENTS.md 第三节记录 MiniMax H3 显存约 ~62GB(GPU0)+~48GB(GPU2)、ComfyUI #1 约 ~0.5GB，但 2026-08-09 真机 `nvidia-smi` 显示 GPU0 上 H3 进程仅约 ~33GB，而 ComfyUI #1 实际占用 ~51.7GB
- **原因**:文档中的显存数值是经验估算或峰值参考，实际受缓存策略(`--cache-lru`)、模型加载状态、是否正在采样、进程共享/分片等因素影响，会随运行态变化
- **正确**:做容量规划、共卡部署、新增服务或回答「还能不能装」类问题前，必须 SSH 到 Workstation 执行 `nvidia-smi`、`systemctl status`、`ss -tlnp`、`mountpoint` 等命令，拿当前真机输出说话
- **教训**:🔒 **硬性规则** —— 文档仅供参考，禁止把 AGENTS.md/TEST_LOG.md/wiki 中的静态数字直接当成当前真实状态；真机输出永远优先

### 20. H3 长视频散热是硬性瓶颈,温度熔断≠模型失败(2026-08-09)
- **坑**:MiniMax H3 192 帧高压测试触发 GPU0 88°C 熔断,误以为是模型/代码问题;实际 243/294/345/362 帧冷却后均可成功,说明长帧数可生成,但散热窗口不稳定
- **原因**:GPU0 满载功耗 ~600W,当前机箱风道/风扇曲线无法持续驱散热量;连续/并发作业会叠加温度,并发 124+141 帧峰值达 92°C
- **正确**:~~H3 长视频生产部署必须配温度熔断保护(≥85°C 中止,冷却后重试)~~【2026-08-16 用户拍板废止:取消 85°C 软件熔断,温度高属正常,GPU 自降频为保护,生产禁止以温度为由中止任务,详见易错点 27】;容量规划不能把单点成功当成可持续吞吐
- **教训**:🔒 评估 H3 生成能力时必须同时看散热可持续性;单作业最大长度通过不代表同帧数队列能稳定通过

### 21. LTXVAudioVAELoader 只认内嵌 audio_vae.* 键的 LTX 全量底模(2026-08-11)
- **坑**:LTX 对口型工作流把音频 VAE 默认设为 mmaudio gold ckpt,执行报 `VAE is invalid: None`;引擎探测却通过(探测只查文件存在,不查键布局)
- **原因**:节点源码(comfy_extras/nodes_lt_audio.py)按 `audio_vae.` 前缀从 checkpoint 抽取子状态字典;mmaudio ckpt 无此前缀 → 抽取出空 dict
- **正确**:audio_vae_name 用 `ltx-2.3-22b-distilled-1.1.safetensors`(内嵌 102 个 audio_vae 键,safetensors 真机核验;官方示例用 ltx-2.3-22b-dev);注意该 loader 只扫 **checkpoints** 类目,LTX 底模若在 diffusion_models 需同步放/软链一份到 checkpoints(toiv 库 checkpoints/ 已有副本,经 extra_model_paths 注册)
- **附带**:🔒 多卡/多机部署时「引擎探测通过 ≠ 链路可跑」,新引擎首次接入必须真机 e2e 一次再交付;JSON 占位错误(error: null)要到 worker /history/{prompt_id} 看 execution_error

### 22. 浏览器自动化测 React 页面:原生事件不触发合成事件(2026-08-11)
- **坑1**:kimi-webbridge `click <option>` 操作原生 `<select>` 下拉,React onChange 不触发,表单状态没更新,后续提交校验全部落空
- **正确**:用 `browser_evaluate` 执行 native setter 设值后手动派发事件:`const s=document.querySelector('select');const setter=Object.getOwnPropertyDescriptor(window.HTMLSelectElement.prototype,'value').set;setter.call(s,'ltx-nsfw-lipsync');s.dispatchEvent(new Event('change',{bubbles:true}))`
- **坑2**:页面有多个 textarea 时 `querySelector("textarea")` 会误中参数区反向提示词框,提示词写错位置导致「缺提示词」校验不通过
- **正确**:正向提示词固定用类选择器 `.promptbar-textarea`;任何 `querySelector` 单选前先 snapshot 数清同类元素个数
- **附带**:产物 `<video>` 不自动加载属浏览器 autoplay 策略,验证产物可访问性应对签名 URL 直接 GET 看 206 + content-type,不要依赖播放器状态

### 23. 生产卡孤儿进程/误启回退服务会挤占 H3 显存预留(2026-08-11)
- **坑**:H3 已独占 GPU2,但预检偶发报「显存不足」;真机 nvidia-smi 发现 GPU2 93°C/53GB 被占,来源是:① 手动启动的 `benchmark_longcat.py --num_segments 10` 孤儿进程(45.5GB,10 段要跑 ~6h);② `toiv-asr.service` 被拉起为 enabled+active(文档记录 stop+disable 回退,实际不符);③ `toiv-audio-sep.service` 同样被拉起
- **正确**:「H3 显存不足」第一反应不是调阈值,而是 `nvidia-smi --query-compute-apps` 查 GPU2 进程列表 + `systemctl is-enabled/is-active` 核对回退服务真实状态;已迁移服务(toiv-asr→studio02、toiv-audio-sep→studio01)在 Workstation 必须保持 stop+disable,被拉起要立即恢复;长时 benchmark 禁止跑在 H3 生产卡,需在维护窗口或空闲卡执行
- **处置**:杀 3 孤儿进程 + stop/disable 两服务后,GPU2 53681MiB/93°C → 3858MiB/63°C,空闲 91GB
- **教训**:🔒 文档写「stop+disable」不代表真机如此,一次性手工状态必须真机复核;systemd 服务 kill 进程没用,会按 Restart 策略自动重启,必须 systemctl stop+disable

### 24. 并行 SSH 会话会冲突操作导致 H3 反复掉线(2026-08-11,⚠️ 高优)
- **坑**:清理 GPU2 后 H3 反而「不可用」,真机 journalctl 发现**另一个来自 192.168.71.123 的 SSH 会话** 03:43:36 执行 `systemctl stop toiv-comfyui-h3.service toiv-asr.service` 停了 H3;同会话 03:43:58 经 `torchrun` 拉起 longcat benchmark(自动复活,PPID=1 脱离 session),04:10:48 又重启 H3+ASR。我停 ASR/杀 benchmark,它启动 ASR/拉 benchmark,形成拉锯
- **排查手法**:H3 等服务「莫名掉线」时,`sudo journalctl -u <service> --since ... --no-pager` 看停止来源,`journalctl --since ... | grep 'systemctl\|session'` 定位是哪个 SSH 会话(IP+时间戳)执行的 systemctl
- **正确**:torchrun 拉起的 benchmark 杀子进程会自动复活,必须连父进程 torchrun 一起杀;`pkill -f` 模式串含自身 ssh 命令行会自杀(exit 255),用 `[b]enchmark` 转义(同易错点 6)
- **教训**:🔒 **多操作者(用户/多个 AI 会话)同时动 workstation 时,服务状态会被反复改写**;关键服务(H3)掉线先查是否有并行会话在操作,再处置;.123 这类非清单设备的 SSH 来源要确认身份,否则状态永远无法收敛

### 25. 跨境链路性能排查:单时段 A/B 会被链路波动污染(2026-08-11,⚠️ 高优)
- **坑**:toiv.dgmt.top 首页 20-30s 超时,初次排查误判「frp kcp 模式大响应崩塌」并切 TCP——实测好转(TCP 2.7s)恰遇链路质量拐点,1h 后跨境 25% 丢包时 TCP 直接 login write timeout 502,kcp 同样挂,连 drtclaw-tyler 隧道、Mac↔cloud SSH 全断;链路自愈后 kcp 恢复,首页 2-6s、api 1.5s。**协议切换的「改善」与被归因的「崩塌」其实都是链路质量时间波动**
- **正确归因**:① 根因是 cloud(香港)↔core(国内)跨境链路晚高峰剧烈波动,任何单隧道协议都无法免疫;② 唯一干净的**同时段**对比:20:27-34 差链路下 Tailscale API 6.2s vs frp-kcp API 0.35s → openresty proxy_pass 从 Tailscale 切 frp 本地端口(127.0.0.1:18090/13100)是有效改进,保留;③ frp 协议保持 kcp(为丢包设计),7001/udp
- **正确手法**:链路 A/B 测试必须**同时段交替测**两种路径,跨时段结论无效;「服务 502/超时」先看是全局链路事件(多隧道同断、SSH 断、ping 丢包)再怀疑本地配置;隧道加固:core frpc.toml 加 `loginFailExit = false`(抖动期 frpc 内建无限重试,避免 systemd 重启风暴,20:56 靠 systemd Restart 救回过一次)
- **附带**:openresty/frps 容器均 host 网络,127.0.0.1 直通 frp 端口;1Panel 手工改 conf 可能被面板重写,留 `.bak-frp-switch-20260811` 备份;分层测试顺序:本机→隧道→反代→域名;⚠️ 用户访问路径是「国内用户→香港 cloud→国内 core」双跨境,晚高峰劣化是结构性风险,长期值得评估国内入口/CDN

### 26. /api/images 产物代理已加签名+归属校验(2026-08-14,行为变化)
- **背景**:原产物代理任何登录用户可枚举顺序文件名(ComfyUI_00001_.png)拉取他人全部产物(IDOR,含 NSFW 区)
- **现状**:tracker.image_url 生成的 URL 带 `sig`(HMAC-SHA256[:24],key 派生自 jwt_secret),有 sig 直通;无 sig 的旧 URL 走 Job 归属回退(result 含该 filename 且 user/tenant 匹配才放行);admin 直通;其余一律 404 不泄露存在性
- **坑**:① 手写/硬编码 /api/images URL(如脚本、外部书签)若无对应 Job 归属记录将 404——agent/tools.py:173 是仅剩的手写点,走归属回退兼容;② <img>/<video> 标签走 `?token=` 查询参数认证(deps.get_current_user 内置回退),不带 header;③ 测试里构造产物 URL 必须带 sig 或先建档 Job,否则 404
- **配套**:workflows deploy 端点仅 admin;test-login 限流 60s/5;production 用默认 jwt_secret 会拒绝启动(护栏)

### 27. H3 长片热管理:风扇曲线影响吞吐,熔断已按用户决定取消(2026-08-15 发现/2026-08-16 政策变更)
- **政策(用户拍板 2026-08-16)**:🔒 **取消 85°C 软件熔断**——「显卡温度高一点很正常」。RTX PRO 6000 设计工作温度上限 ~92°C,85-90°C 持续运行在规格内;到达上限时 GPU 自身降频保护,软件层不再拦截。生产任务禁止再以温度为由中止/排队等待。GPU2 功率帽已于当日恢复 600W 满血
- **保留的发现(吞吐优化而非安全熔断)**:诛仙 25 镜生产实测,GPU2 在 400W 负载时风扇仅 37%——风扇曲线懒惰导致热量积聚提前触碰降频点,**锁扇是提速手段不是安全措施**:NVML 锁扇 85%(`pynvml.nvmlDeviceSetFanSpeed_v2`,sudo -n /opt/nemotron-venv/bin/python,系统 python3 无 pynvml)可让 600W 持续输出不降频;不锁扇则 2min 冲 85°C+ 并触发硬件降频变慢
- **注意**:功率帽与 NVML 扇速均不持久(persistence mode disabled,重启/驱动重载即失);风扇值守脚本模板在 workstation /tmp/h3_fan_guard.sh(60s 重设);如观察到持续 ≥95°C(逼近关机阈值)再人工介入,不设软件自动熔断

### 28. video_4k_upscale_parallel 竖屏源必须显式 --target-w 2160 --target-h 3840(2026-08-15)
- **坑**:诛仙竖屏 576×1024 母版用默认参数(3840×2160)超分,脚本 ImageScale 节点把每帧**拉伸成横屏**,7320 帧/97min 全部报废,且脚本完成后 rmtree 删帧无法补救
- **正确**:竖屏源显式传 `--target-w 2160 --target-h 3840 --keep-frames`(保帧防白烧);已给脚本加**画幅方向护栏**(源与目标横竖不一致即报错退出,commit 前先看脚本头注释)
- **附带**:① 该脚本完成后默认删除 upscaled/ 帧目录,任何失败都无法续跑,生产一律 --keep-frames;② 吞吐实测 ~75-148 帧/min(3 卡 :8261-8263,受共卡与温度影响),7320 帧约 50-97min,规划按 100min 估;③ GPU3 与 FlashTalk/OpenTalking/JoyCaption 共卡时分片最慢,尾部效应明显

### 29. Next.js 生产构建必须 rm -rf .next 干净重建,陈旧缓存会导致 chunk 内部错位(2026-08-17)
- **坑**:部署时复用了带旧 `.next/cache` 的增量构建产物,webpack 缓存把旧 chunk 命名模板混入新构建:运行时模板生成扁平路径 `./522.js`,而 chunk 实际落位 `chunks/522.js`;`next start` 启动即 500,`Cannot find module './522.js'`(远端文件存在且 MD5 一致,不是 rsync 丢文件)
- **正确**:每次生产部署前 `rm -rf .next && npm run build`;deploy.sh 的 `8200` 防呆只查 routes-manifest,拦不住构建内部错位;干净构建是唯一可靠前置
- **教训**:远端 journalctl 看到 `Cannot find module './N.js'` 且文件实际存在时,先本地 `next start` 复现——若本地同样 500,即为构建本身坏(需 clean rebuild);若本地正常,再怀疑部署丢文件

### 30. Windows 计划任务以 SYSTEM 运行时看不到用户态驱动器映射(2026-08-17,⚠️ pc02 修复根因)
- **坑**:pc02 ComfyUI 突然「全模型不可见」(loras/unet/ckpt 枚举全空),触发 MountNAS 任务(InteractiveToken/W 用户)挂 Z: 后重启 ComfyUI 仍无效——因为 **ComfyUI 计划任务以 SYSTEM(S-1-5-18)运行**,而驱动器映射是 per-logon-session 的:W 桌面 session 的 Z: 对 SYSTEM 进程天然不可见。ps1 里那句 `net use \\host\share /user:...`(UNC 认证无盘符)也救不了 extra_model_paths 里的 `Z:/` 盘符路径
- **排查手法**:`schtasks /query /tn <任务> /xml | findstr "LogonType UserId"`——S-1-5-18=SYSTEM,S-1-5-21-...-1001=用户 W;ComfyUI 进程视角的模型枚举(object_info)才是最终裁判,SSH session 里 `dir Z:` 是假阴性(又是另一个 session)
- **正确**:start_comfyui.ps1 开头改为 **在任务自己的 session 里挂盘**:`net use Z: /delete /y` + `net use Z: \\192.168.71.7\NAS /user:dgmt-nas <pwd> /persistent:yes`(SYSTEM session 自挂,对 ComfyUI 进程可见,且不依赖任何用户登录,比 pc01 的 InteractiveToken 模式更稳)
- **附带**:① `schtasks /change /tr` 在 SSH 非交互下会挂起等密码,改用 `/create /f` 覆盖重建;② Windows SSH 里 `timeout` 命令报「不支持此接口」是无害噪音;③ 长 heredoc/超长单行命令经 Mac 终端 SSH 会被换行截断损坏,写远端文件用 PowerShell `-EncodedCommand`(UTF-16LE base64)最稳

### 31. 跨项目记忆交叉复核揪出「迁移记录全过时」+ 两个生产链路指向死服务(2026-08-17,⚠️ P0)
- **起因**:DashBox 项目记忆与本文档多处冲突(LTX-2.5/JoyCaption 卡归属、ASR 死活、EXO 模型名),按第二硬性规则全集群真机复核
- **查实(DashBox 对、本文档过时)**:① LTX-2.5 :8198 已从 GPU0 迁 **GPU3**(~36GB);② JoyCaption :9304 已从 GPU3 迁 **GPU2**;③ H3 进程已纯 GPU2(41.3GB,GPU0 无);④ 新增 CosyVoice2 :9201(GPU0)/CosyVoice3 :9202(GPU2)/Qwen3-TTS :9203(GPU2)/FireRedASR :8300(GPU2)全部 active;⑤ FlashTalk 端口 :9000→**:9004**;⑥ spark02 底模已是 **Qwen3.8-27B-NVFP4**(qwen3.6-uncensored 只是别名,core .env 别名调用仍有效);⑦ EXO :52415 实跑 **MiniMax-M2.7-4bit**(122.7GB)非 GLM-5.2;⑧ cloud :8002 caddy 已清
- **查实(两边都错/都漏)**:🚨 **P0 三连**——① studio04 VLM :9303 离线(launchctl 无 plist)且 workstation `toiv-vlm` inactive+disabled、**回退端口 :9303 被 embedding 第二实例(PID 1441928)误占**;② demucs 全集群离线(studio01 plist 消失 + ws toiv-audio-sep disabled);③ core 生产 .env `TOIV_REVERSE_VLM_BASE_URL→studio04:9303`、`TOIV_AUDIO_SEP_URL→ws:9220`、`TOIV_VLM_SERVER_URL→ws:8000` 实测全 000——**反推(SFW 图+全部视频)与人声分离链路在生产上就是坏的**;另 studio02 whisper.cpp :9212 也没了,ASR 静默回落 ws toiv-asr(幸运:它是 active 的,否则 ASR 也断)
- **根因**:一次性手工迁移/调整没有守护(plist 被谁删、何时删无人知),文档「已迁移」记录长期未复核;core .env 无启动期依赖可达性检查
- **正确手法**:① 「已迁移/已部署」类记录**每次跨项目记忆冲突时必须真机复核**;② 修复死链优先级:VLM 反推 = 恢复 studio04 mlx-vlm(需找回/重建 plist + 39GB 模型确认在盘)或改 core 指向备用反推(spark01 Molmo2 :8000 有 caption 能力);demucs = `systemctl enable --now toiv-audio-sep`(ws 回退实例)最快;③ 修完必须把 core .env 指向与真机对齐并重启 toiv-api 实测 /api/reverse
- **修复(同会话当场完成)**:① studio04 VLM 复活——服务今晨 04:37 才停(plist 被删,环境 `~/miniconda3/envs/toiv-vlm` 与 39GB 模型完好),重建 `com.dgmt.toiv-vlm-mlx.plist`(RunAtLoad+KeepAlive)拉起,模型加载 7.4s,health 200;② demucs 复活——ws `systemctl enable --now toiv-audio-sep`,active(:9220 监听);③ core `.env` `TOIV_VLM_SERVER_URL` ws:8000→**spark01:8000 + molmo2-8b**(scoring/宫格反推要 OpenAI 视觉端点,实测 chat/completions 200),`TOIV_VLM_MODEL_ID` 同步改;④ 生产实测 `/api/reverse` 200(10.2s 完整 prompt+negative)。备份 `.env.bak-20260817-vlmfix`
- **遗留风险**:ws 回退端口 :9303 被 DashBox 部署的 embedding 第二实例(PID 级,1.3GB)占用——若未来要重启 workstation `toiv-vlm` 热回退须先协调端口;station 侧 plist 谁删的仍未知(疑并行会话)

---

## 七、操作历史

### 2026-08-14 会话(M12:P0/P1/P2 全量修复 + R3 调研与 R3.1/R3.2 落地)

| 时间 | 操作 | 结果 |
|------|------|------|
| 16:00 | 接手项目,核实上轮评审 25 项问题清单(7 P0 全部代码实证) | ✅ 全部属实,组建 6 Agent 团队并行修复 |
| 16:20 | Team A 后端 P0:workflows/drama_analytics 认证+路径白名单、images IDOR 签名 URL、test-login 限流、tracker 孤儿作业终态回收(get_queue 双无连击 2 次标 error) | ✅ 39 新测试全绿 |
| 16:20 | Team B 前端 P0:useStudioProject 错误透出(StudioView 错误条)+ trackJob SSE 重连 5 次+降级轮询 /api/jobs 状态机 | ✅ node:test 10/10,tsc 零错误 |
| 16:20 | Team C 后端 P1:Job 三列索引+4 幂等 CREATE INDEX、迁移吞异常补日志、upload/reverse/nas.download/opentalking 限流接线、JWT production 护栏、toiv.access token 脱敏 | ✅ 131 测试全绿 |
| 16:20 | Team D 前端 P1:crossTab.ts 跨标签页同步(R18/主题/登录态)+ LazyVideo 作品库 60 视频卡 preload none + 全站 img lazy | ✅ tsc 通过 |
| 16:20 | Team E P2:test_video 17 例/test_jobs_events 4 例/test_generate_endpoints 11 例 + .github/workflows/ci.yml + roadmap 第八节实证补记 | ✅ 32 新测试;实证 video.py pool.pick 冒泡 500(已修 503) |
| 16:40 | Team F 调研:docs/2026-08-14-competitive-r3-r5-deep-dive.md 540 行(Mavis=Leader/Worker/Verifier 修正、LangGraph 终判、pairwise+Elo 评委、R3 落地设计) | ✅ |
| 17:20 | M12 全量回归:pytest **1433 passed**(1339+94)、web 10/10、tsc ✅、next build ✅;commit 8beaf80 | ✅ |
| 18:10 | R3.1(双团队):AgentRun/Task/Event/Approval 4 表 + agent_team 9 端点 + /agent-runs 任务卡片页(秒回/可编辑计划/双确认门/泳道双形态);回归 pytest 1444、web 32/32;commit 066be6f | ✅ |
| 18:40 | 部署 M12+R3.1 到 core(deploy.sh core-ts):双服务就绪;双域名冒烟(health 200、零认证端点已 401、/agent-runs 页 200) | ✅ 生产行为变化已生效 |
| 19:50 | R3.2:LangGraph StateGraph 化(Send fan-out/interrupt 门/Command resume)+ AsyncPostgresSaver 断点续跑 + 启动恢复 + Director Gate LLM 分级(8s 超时回退启发式);回归 pytest **1452** | ✅ API 契约零变更 |
| 20:00 | R3.2 部署:core 手工 pip install langgraph 1.2.11 三件套(**deploy.sh 不含 pip install,新增 Python 依赖必须手工装**,websockets 被约束降 15.0.1 已实测 proxy 兼容)→ deploy.sh → AsyncPostgresSaver 真机就绪(checkpoint 4 表已建)→ 生产 e2e(admin 创建 run 秒回 10 任务、cancel 200) | ✅ |

### 2026-08-13 会话(北京国内入口 toiv.wineryz.top 双活镜像落地)

| 时间 | 操作 | 结果 |
|------|------|------|
| 23:20 | 北京服务器环境核查:frps :7000/:7500 监听、OpenResty 容器运行、1Panel 管理面板可用 | ✅ 基础服务正常 |
| 23:22 | core 新增 frpc-bj.toml,注册 toiv-api-bj(:8090→:18090) + toiv-web-bj(:3100→:13100) TCP 隧道,systemd `frpc-bj.service` enable+start | ✅ login success,双 proxy start success |
| 23:24 | 北京 OpenResty 新增 `toiv.wineryz.top.conf`:HTTP 80 ACME + 301 HTTPS;HTTPS 443 反代 /api/ → :18090,其余 → :13100;IP 直连兜底 | ✅ 配置路径 `/opt/1panel/www/conf.d/`(容器挂载正确) |
| 23:26 | 修复 ACME 挑战路径:challenge 文件必须落在 OpenResty 容器挂载目录 `/opt/1panel/apps/openresty/openresty/root/`;acme.sh 成功签发 Let's Encrypt ECC 证书 | ✅ 证书路径 `~/.acme.sh/toiv.wineryz.top_ecc/` |
| 23:41 | 安装 fullchain/privkey 到容器内 SSL 路径,修正 nginx conf 证书路径为 `/usr/local/openresty/nginx/conf/ssl/toiv.wineryz.top/`,reload OpenResty | ✅ nginx -t 通过,reload 成功 |
| 23:42 | 端到端验证:HTTP 301→HTTPS、HTTPS / 200、/api/health 200、frp 远端端口 :18090/:13100 监听 | ✅ 国内入口全线打通 |

### 2026-08-11 会话(晚,toiv.dgmt.top 域名链路优化)

| 时间 | 操作 | 结果 |
|------|------|------|
| 20:30 | 域名访问劣化排查:首页 20-30s 超时。分层定位 core 本机 3ms ✅/Tailscale 链路 6-22s ❌/frp-kcp web 6-14s 但 api 0.35s | 根因为跨境链路波动(后证实),详见易错点 25 |
| 20:38 | core frpc kcp→tcp 试验(同时段对比不足,结论后被链路波动推翻,已回滚 kcp) | ⚠️ 归因教训见易错点 25 |
| 20:41 | openresty toiv.dgmt.top.conf proxy_pass Tailscale→frp 本地 127.0.0.1:18090/13100(备份 .bak-frp-switch-20260811),reload | ✅ 有效改进:同时段对比 frp-kcp API 0.35s vs Tailscale 6.2s |
| 20:53 | 跨境链路全面抖动(25% 丢包):toiv/drtclaw 双隧道断、Mac↔cloud SSH 断,域名 502 约 4min | ✅ 20:56 链路自愈,kcp login 恢复;随后 frpc 加 loginFailExit=false 加固 |
| 21:03 | 终态验证:frpc kcp+loginFailExit=false,双 proxy 注册成功,域名 200(2-7s),api 1.5s | ✅ 服务恢复;HSTS/安全头/登录/中文404/文档门控经域名全过 |

### 2026-08-09 会话(系统全面功能测试与高压测试)

| 时间 | 操作 | 结果 |
|------|------|------|
| 14:00 | Core API 17 项功能回归 + LLM 长文本 4K/16K/32K 高压 + 跨节点系统监控启动 | ✅ 16/17 通过;LLM 大海捞针 10/10、并发 5 路 0 失败;监控覆盖 workstation/core/spark02/studio04 |
| 14:03 | MiniMax H3 长视频生成高压测试启动(:8195,832×480,steps=20),含 GPU 温度熔断保护 | ✅ 13 个作业成功 12/失败 1;单作业最大 362 帧 248.5s 通过;连续 5/5 通过;并发 124+141 2/2 通过 |
| 14:09 | 修复 core `deploy/.env` `TOIV_LLM_DISPLAY_NAME` 缺引号导致 toiv-api 环境变量未加载 | ✅ 加双引号、daemon-reload、重启 toiv-api,MainPID 环境变量正确 |
| 14:20 | 修复 `/api/reverse` 502:core 代码增加 studio04 mlx-vlm 自定义 `/v1/reverse` 回退路径 | ✅ `_mlx_vlm_reverse` + `_resolve_model_id` 探测 /models 404 自动适配;反推 200(9–14s) |
| 14:38 | H3 高压测试结束,系统监控停止,结果归档 TEST_LOG.md / STATE.json / 测试报告 | ✅ GPU0 峰值 93°C,显存峰值 69065MB,无 OOM/崩溃;核心数据归档 docs归档说明.md 第二节(原报告已删除) |

### 2026-08-08 会话(晚,集群重排 S3-S6 收尾)

| 时间 | 操作 | 结果 |
|------|------|------|
| 20:40 | S3 收尾:JoyCaption 截断 JSON 骨架兜底(_salvage_prompt,71cc57b/6bdfa03)+ 反推四链路真机 e2e 全过 | ✅ 见 TEST_LOG REVERSE-S3 |
| 20:55 | S4a:llama-70b 退役——core .env L2/L3/L4 切 spark02 qwen3.6-uncensored(备份 .env.bak-20260808-llama),spark01 vllm_node 容器停 | ✅ X-NSFW 链路验证正常,模型文件+启动脚本保留可回滚 |
| 21:10 | S6a:ASR screen→toiv-asr.service;S6b:558G 死重模型归档 NAS(model-archive-2026-08-08,7 天再删) | ✅ / 用量 1.3T→807G |
| 21:35 | S4b:spark01 Omni-Captioner bf16 上线(docker omni_captioner :8000);audio_sep 加 /separate_accompaniment;core 音乐反推增强链(4ae94e9) | ✅ e2e 5.0s 人声+背景音乐合并输出 |
| 21:45 | S6c:Workstation 重启(中断 ~2min) | ✅ NVML mismatch 根治;14 服务全自启;修复 NAS 无 fstab 条目隐患(补条目+重建凭据) |

### 2026-08-07 会话

| 时间 | 操作 | 结果 |
|------|------|------|
| 17:00 | Workstation ComfyUI 安装 ComfyUI_essentials + rembg 2.0.78(onnxruntime 1.28),u2net.onnx 176MB 预置 `/home/merlin/.u2net/` | ✅ removebg 链路恢复 |
| 17:33 | core 生产链路全功能真机生成测试(12 步串行 + GPU 采样) | ✅ 12/12 通过,详见 ToIV TEST_LOG.md FULLGEN-2026-08-07 |
| 18:30 | drama studio 末帧续写模式上线 core(continue-video,含 PG 迁移+concat 尺寸对齐修复) | ✅ 真机 2 段+拼接 15.7s 成片验证通过 |
| 19:00 | GPU2 部署 LongCat-Video 独立实例(comfyui-longcat.service :8197,WanVideoWrapper+KJNodes+VideoHelperSuite) | ✅ 974→1263 节点 |
| 19:14 | LongCat 权重下载(官方 83GB hf-mirror + Kijai 单文件 fp8 26GB ModelScope)+ 冒烟 | ✅ 480×832×49 帧 73s 出片,峰值 21GB |

> ⚠️ 新易错点:① core API 上传 kind 必须下划线风格(ltx_i2v/h3_i2v/removebg),连字符会导致 capabilities 门控失效;② H3 生成前置校验 GPU0 空闲 ≥36GiB,调用前需先 `POST :8189/free {"unload_models":true}` 释放 ComfyUI 缓存;③ workstation pip 需用清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple`,github 用 ghfast.top 镜像;④ **LongCat 在 WanVideoWrapper 里必须设 `rope_function="comfy"`**,否则报 4096 vs 128 维度错(qk norm per-head);⑤ hf-mirror 对 Kijai 仓库限流严重(~0.4MB/s),大文件走 ModelScope `resolve/master` 直链(~25MB/s);⑥ pkill -f 的模式串不能出现在自身 ssh 命令行里,否则自杀(exit 255),用 `[.]` 转义。

### 2026-07-28 会话

| 时间 | 操作 | 结果 |
|------|------|------|
| 05:50 | 停止 Workstation 所有服务（Docker 4容器 + Caddy + socat代理 + dcgm-exporter + cups） | ✅ load 3.15→0.92 |
| 05:55 | 清理 /tmp 残留文件（toiv_code.tar.gz 8G 等） | ✅ 释放 8G 内存 |
| 06:00 | 全设备状态检查（15台SSH验证） | ✅ 14在线，1离线(cloud SSH超时) |
| 06:04 | Core Docker 清理（12个监控容器全删，docker禁用） | ✅ |
| 06:10 | 启动 ComfyUI 3卡 + LB | ✅ :8188-8191 全部 200 |
| 06:15 | 启动 IndexTTS（误放 GPU3） | ❌ 后修正 |
| 09:00 | 修正 GPU 分配：TTS 迁至 GPU0，启动 Nemotron vLLM on GPU3 | ✅ :8000/:9200 正常 |
| 09:10 | PC02 磁盘分析：真凶是 Steam(40G)+炉石(11G)，非模型 | ✅ |
| 09:15 | PC02 NAS 挂载（cmdkey + schtasks MountNAS） | ✅ 计划任务已注册 |
| 09:20 | 创建 AGENTS.md | ✅ 本文件 |
| 10:00 | 排查 PC01 ComfyUI 无法启动 | ✅ 原因：计划任务执行 wscript 且 ssh 触发子进程被杀 |
| 10:05 | 修正 PC01 计划任务为直接执行 start_comfyui.bat | ✅ PC01 :8188 启动并加载 NAS 模型 |
| 10:10 | 验证 PC02 :8193 加载 NAS 模型 | ✅ 805 节点，checkpoints 列表来自 NAS |
| 11:00 | 优化 Nemotron vLLM 启动参数 | ✅ 去掉 --enforce-eager，启用 chunked-prefill/prefix-caching，显存 88%→94.5%，:8000 推理正常 |
| 13:30 | 恢复 Qwen3-Embedding-4B 真机服务 | ✅ 安装 sentence-transformers，systemd 托管 :9302，输出维度 2560，OpenAI /v1/embeddings 兼容 |
| 14:00 | 更新设备清单并分发到所有项目 | ✅ 已同步到 22 个项目目录（含 ToIV 新增） |
| 14:05 | 清理 .archive/old-docs 过期文档 | ✅ 删除 8 个旧版设备说明/迁移计划/调研报告 |
| 14:10 | 补齐 AGENTS.md 设备清单 Tailscale IP | ✅ 17 台设备 IP 全部具体化 |

### 2026-08-05 会话

| 时间 | 操作 | 结果 |
|------|------|------|
| 23:00 | 排查 Mac Studio EXO GLM-5.2-fp8 下载/加载失败 | ✅ 修复 hf-mirror.com endpoint、补齐 studio04 config.json、修正 chat_template |
| 23:20 | 4 台 Mac Studio 重启 EXO，重新加载 GLM-5.2-fp8 | ✅ Tensor · MLX RDMA 加载成功， Ready to chat |
| 23:30 | API 测试 GLM-5.2-fp8 | ✅ 输出正常："I'm GLM, a large language model developed by Z.ai..." |
| 23:40 | 检查 Workstation / PC01 / PC02 服务健康 | ✅ ComfyUI-LB、IndexTTS2、Embedding、ASR、LiveAct、H3、FlashTalk、OpenTalking 均正常；Nemotron vLLM 确认停用 |
| 23:50 | 更新 AGENTS.md 并分发到所有项目 | ✅ GPU 分配表同步为当前真实状态 |

### 2026-08-07 会话

| 时间 | 操作 | 结果 |
|------|------|------|
| 全天 | core 生产链路全功能真机生成测试（12/12 通过，脚本 scripts/full_generation_test.py） | ✅ 见 TEST_LOG FULLGEN-2026-08-07 |
| 晚间 | 长视频双路线：drama 末帧续写上线 core + LongCat-Video 引擎 GPU2 部署冒烟（:8197） | ✅ 见 TEST_LOG LONGVID-2026-08-07、服务文档 docs/2026-08-07-long-video-services.md |
| 20:51 | LongCat 720p×961 帧（60s 单镜头）压测 | ✅ 65min / GPU2 峰值 29GB，60s 全程连贯（上下文窗口 81/overlap16 + 块交换 30） |
| 22:00 | LongCat 接入 core API：engine_registry 注册 longcat-t2v + `POST /api/longcat/t2v`（commit 57fd39c） | ✅ 部署 core，e2e 121 帧作业 done |
| 22:40 | 修复 resolve_worker 产物代理 502（:8197 精确匹配，commit df1f9ef） | ✅ 产物下载 200，832×480×121 帧验证通过，全量 1007 tests |

---

## 八、待办事项

- [x] PC01 ComfyUI 配置 extra_model_paths.yaml 指向 NAS（✅ 端口8188）
- [x] PC01 start_with_nas.bat 启动脚本（✅ 端口8188）
- [x] PC01 计划任务 MountNAS（✅ 用户 DESKTOP-04VJ6QG\home）
- [x] PC01 凭据保存到 Windows 凭据管理器（✅ 已保存）
- [x] PC02 ComfyUI 配置 extra_model_paths.yaml 指向 NAS（✅ 端口8193）
- [x] PC02 start_with_nas.bat 启动脚本（✅ 端口8193）
- [x] PC02 计划任务 MountNAS（✅ 用户 DESKTOP-T9JILFS\w）
- [x] PC02 凭据保存到 Windows 凭据管理器（✅ 已保存）
- [x] PC01/PC02 重启 ComfyUI 使 extra_model_paths.yaml 生效（✅ PC01 :8188 / PC02 :8193 均加载 NAS 模型）
- [x] Workstation SGLang/infinity 真机未安装（✅ 已用 Qwen3-Embedding-4B 真机 sentence-transformers 服务替代，:9302 恢复）
- [ ] Cloud SSH banner 超时排查（HTTPS 正常）
- [x] ToIV 迁移 core(✅ deploy.sh 持续部署,toiv-api/web 为唯一生产点,见 docs/2026-08-08-core-migration-status.md)
- [ ] 项目负责人推送 DRT 到 core(备份在 workstation /var/tmp)
- [x] Cloud 反代切换指向 core(✅ 2026-08-11 完成并优化:toiv.dgmt.top openresty proxy_pass 经 frp TCP 隧道 127.0.0.1:18090/13100 → core:8090/3100,弃用 Tailscale 链路;frpc 同步 kcp→tcp,见易错点 25)
- [x] 北京国内双活入口落地(✅ 2026-08-13:toiv.wineryz.top 经 frpc-bj.toml + 北京 frps + OpenResty 反代 → core:8090/3100,HTTPS 200、/api/health 正常;国内用户走北京单跨境,海外用户继续走 toiv.dgmt.top)
- [x] 清理 .archive 中过期的部署残留（backup-20260722 / deploy-residues）
- [x] Workstation nvidia-smi 报 NVML mismatch(✅ 2026-08-08 21:45 重启根治,nvidia-smi 恢复;14 个 systemd 服务全自启)
- [x] llama-70b 退役 + spark01 改 Omni-Captioner(✅ 2026-08-08,L2/L3/L4 切 spark02,最终说明见交接文档第七节;音乐反推链路 e2e 通过)
- [x] ASR screen→systemd(✅ toiv-asr.service);磁盘 558G 归档 NAS `toiv/model-archive-2026-08-08/`(7 天无误再删);NAS 挂载 fstab 补条目
- [x] core 配 `TOIV_CIVITAI_API_KEY`(✅ 2026-08-08 key 已写入 core `/home/merlin/toiv/deploy/.env` 并重启 toiv-api,下载器 e2e 验证通过:推荐清单点下载即 civitai API 解析+token 自动附加+SFTP 落 NAS;key 是 secret,deploy/.env 已 gitignored 且 deploy.sh 不同步,禁止提交)
