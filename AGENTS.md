# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-08-08（🔒 新增硬性规则：所有后端服务都来源于 Workstation）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」

---

## 〇、🔒 第一硬性规则：所有后端服务都来源于 Workstation

> **所有 AI/算力后端服务（ComfyUI/LB、IndexTTS2、ASR、Embedding、LiveAct、H3、LongCat、FlashTalk、OpenTalking、JoyCaption 等）全部运行在 Workstation(192.168.71.127 / 100.68.100.90)上。**
>
> - ⚠️ **2026-08-08 起唯一例外**：反推提示词的视觉链路 Qwen3-VL-8B(bf16 MLX, :9303)运行在 **studio04(192.168.71.113)**,workstation GPU3 的 toiv-vlm 停而不删作回退；排查反推故障先查 studio04 launchd(`com.dgmt.toiv-vlm-mlx`)
> - core(192.168.71.47)只跑 ToIV web/api + PostgreSQL/Redis，是业务网关，不是算力来源
> - 本机 Mac 只是操作终端；任何配置里出现的 `127.0.0.1` / `localhost` 服务地址（如 `opentalking_base_url` 默认 `http://127.0.0.1:4403`）都只是本地 dev 兜底，**真机排查一律先查 Workstation**
> - 排查「服务离线/引擎不可达」时，第一反应必须是 SSH 到 Workstation 查 systemd 状态和端口监听，禁止臆断服务不存在

---

## 一、集群设备清单（17台）

| # | 设备 | 角色 | LAN IP | Tailscale IP | 类型 | SSH 用户 |
|---|------|------|--------|-------------|------|---------|
| 1 | studio01-04 | EXO RDMA 推理(studio04 兼任 VLM 反推节点 :9303) | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | **Mac Studio M3 Ultra 32核 512GB**（⚠️ 不是 M2 Pro，已确认 2026-08-02） | dgmt-studio01-04 |
| 2 | openclaw01-04 | OpenClaw 网关 | .86/.75/.81/.85 | 100.69.0.4 / 100.76.35.7 / 100.76.140.121 / 100.91.128.30 | Mac mini M2 | dgmt-openclaw01-04 |
| 3 | spark01-02 | vLLM Ray (Euryale 70B) | .82/.84 | 100.81.235.124 / 100.86.42.89 | Linux GB10 | dgmt-spark |
| 4 | workstation | 算力+真机服务 | 192.168.71.127 | 100.68.100.90 | Linux 4×RTX PRO 6000 | merlin |
| 5 | pc01 | ComfyUI worker | 192.168.71.115 | 100.69.134.27 | Windows RTX 5090 | home |
| 6 | pc02 | ComfyUI worker | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| 7 | NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 8 | cloud | 网关/1Panel/frps | 43.119.32.180 | 100.83.78.114 | Linux | root |
| 9 | core | 服务器(待业务) | 192.168.71.47 | 100.77.80.100 | Ubuntu | merlin |
| 10 | MateBook | 操作终端 | — | 100.74.15.34 | macOS | 本机 |

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

| GPU | 服务 | 端口 | 显存占用 | systemd 服务 | 备注 |
|-----|------|------|---------|-------------|------|
| GPU0 | ComfyUI #1 | :8189 | ~0.5GB | **comfyui-gpu0.service** | 与 IndexTTS2、H3 共卡;2026-08-08 起带 `--cache-lru 8` 缓存上限 |
| GPU0 | IndexTTS2 | :9200 | ~7.6GB | **toiv-tts.service** | `CUDA_VISIBLE_DEVICES=0` |
| GPU0 | MiniMax H3 (ComfyUI worker) | :8195 | ~62GB (UNet bf16 分片) | **toiv-comfyui-h3.service** | UNet 跨 GPU0/GPU2/CPU，CLIP/VAE 在 GPU2;2026-08-08 extra_model_paths 补 `loras` 映射(NAS toiv/comfyui-models/h3/loras/),LoRA 走 LoraLoaderModelOnly 链(musubi 系只含 DiT 权重),NSFW LoRA 门控在 services/h3.py H3_NSFW_LORAS 名单 |
| GPU1 | Qwen3-Embedding-4B | :9302 | ~8.4GB | **qwen3-embedding.service** | `CUDA_VISIBLE_DEVICES=1` |
| GPU1 | LiveAct batch worker | :9400 | ~58GB | **toiv-liveact.service** | `nproc_per_node=1`，单卡 GPU1 |
| GPU2 | AI-Omni ASR (faster-whisper large-v3) | :9210 | ~4.9GB | 手动 screen | `device_index=2` |
| GPU2 | demucs 人声分离 | :9220 | ~1-8GB(分离时) | **toiv-audio-sep.service** | 2026-08-08 从 GPU0 迁入,GPU1 留给 LiveAct 专职 |
| GPU2 | SenseVoice 语音情绪/事件标注 | :9211 | ~1.7GB | **toiv-sensevoice.service** | 2026-08-08 新增,反推提示词音频链路;/opt/toiv-sensevoice,FunASR+torch 2.11,与 /opt/ai-omni-asr 隔离 |
| GPU2 | MiniMax H3 (ComfyUI worker) | :8195 | ~48GB (CLIP bf16 + VAE) | **toiv-comfyui-h3.service** | 与 GPU0 共享 H3 工作进程 |
| GPU2 | LongCat-Video (ComfyUI 独立实例) | :8197 | ~16-30GB (fp8 + Block Swap) | **comfyui-longcat.service** | 2026-08-07 新增;实例在 /home/merlin/ComfyUI-longcat,与生产 /opt/ComfyUI 隔离;2026-08-08 起含 LongCat-Avatar 链路(GGUF Q8_0 + whisper-large-v3 + MelBandRoFormer 节点,冒烟峰值 ~20GB 可与 ASR/demucs 共存) |
| GPU3 | FlashTalk WebSocket Server | — | ~55GB | **flashtalk.service** | 数字人实时对话 |
| GPU3 | OpenTalking 数字人统一 API | — | ~1.5GB | **opentalking.service** | + opentalking-tts-shim |
| GPU3 | JoyCaption Beta One(NSFW 反推专线) | :9304 | ~17GB (bf16) | **toiv-joycaption.service** | 2026-08-08 新增;transformers 直跑(⚠️ vLLM 0.11.2 跑 LLaVA 架构 device-side assert,勿用);/opt/toiv-joycaption,模型 /home/merlin/models/joycaption-beta-one |
| GPU3 | Qwen3-VL-8B 反推 VLM | :9303 | (停) | toiv-vlm.service(⏸ stop+disable) | 2026-08-08 已迁移 studio04 MLX,**停而不删作秒级回退**;/opt/toiv-vlm,vLLM 0.11.2;启动前需 torch 查 GPU3 余量 |
| —(studio04) | Qwen3-VL-8B 反推 VLM(现役) | :9303 | bf16 ~17GB 统一内存 | launchd `com.dgmt.toiv-vlm-mlx.plist` | 192.168.71.113,mlx-vlm 0.6.10,mlx-community/Qwen3-VL-8B-Instruct-bf16;SFW 图+全部视频走此;⚠️ 视频只认本地路径→core NAS 中转(TOIV_REVERSE_VIDEO_MAC_PREFIX) |

### ComfyUI-LB 后端配置
- 本地 1 后端：:8189(GPU0)
- 远程 2 后端：pc01 :8188 / pc02 :8193
- **GPU1 不跑独立 ComfyUI 后端**（GPU1 跑 LiveAct + Embedding）
- **GPU2 例外**:2026-08-07 起跑 LongCat-Video 专用独立实例（:8197，不入 ComfyUI-LB 后端池；fp8 权重与 H3 突发 48GB 可共存）
- **GPU3 不跑 ComfyUI**（跑 FlashTalk + OpenTalking + JoyCaption）

### 关键服务路径（Workstation）

| 服务 | 路径 | venv | 启动命令 |
|------|------|------|---------|
| ComfyUI | /opt/ComfyUI | /opt/ComfyUI/venv (Python 3.12, torch 2.13.0+cu130) | `CUDA_VISIBLE_DEVICES=N venv/bin/python main.py --listen 0.0.0.0 --port 818X` |
| ComfyUI-LB | /opt/ComfyUI/comfyui-lb.py | 同上 | `venv/bin/python comfyui-lb.py` |
| IndexTTS2 | /home/merlin/index-tts | /home/merlin/index-tts/.venv (Python 3.11, torch 2.8.0+cu128) | `CUDA_VISIBLE_DEVICES=0 .venv/bin/python toiv_tts_server.py --host 0.0.0.0 --port 9200` |
| Qwen3-Embedding-4B | /home/merlin/models/Qwen3-Embedding-4B | /opt/nemotron-venv | `sudo systemctl start qwen3-embedding` |
| AI-Omni ASR | /opt/ai-omni-asr | /opt/ai-omni-asr (Python 3.12, faster-whisper 1.2.1) | `screen -S ai-omni-asr -L -Logfile /opt/ai-omni-asr/logs/screen.log bash -c 'cd /opt/ai-omni-asr && source bin/activate && python asr_server.py'` |
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
- **附带**:① :8197 的 extra_model_paths.yaml 需补 `audio_encoders` 映射(vocal_separator 类目 WanVideoWrapper 不用,Kim_Vocal_2.onnx 本链路不需要);② 冒烟参数参考:480×832/93帧/25fps/steps=12/shift=12/cfg=1.0/dmd LoRA 1.0/BlockSwap=25/attention=sdpa,130s 出片,GPU2 峰值 ~20GB;③ 冒烟脚本在 workstation `/tmp/longcat_avatar_smoke.py`;④ **已接入 core API**(2026-08-08,commit a132468):`POST /api/avatar/talk`,图片+音频走 `/api/upload?kind=avatar`(multipart 字段名是 `image` 不是 `file`;**两文件须落同一 pool worker**,前端已做互钉);⑤ **长音频续段已实现**(commit 270946e):ExtendEmbeds 图内链式,首段 93 帧+每续段净 80 帧(overlap 13),**每段帧数必须 (T-1)%4==0**(残段自动向上取整 4k+1,最多多 3 帧),num_frames 上限 2500(≈100s);>30min 作业超 tracker `_TRACK_TIMEOUT=1800s`,靠 reconcile_loop 重挂落库,状态更新有间断

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

---

## 七、操作历史

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
- [ ] Cloud 反代切换指向 core（待 core 业务就绪后）
- [x] 清理 .archive 中过期的部署残留（backup-20260722 / deploy-residues）
- [ ] Workstation nvidia-smi 报 NVML mismatch(2026-08-08 诊断:已装驱动 595.84(modinfo 确认),运行中内核模块仍 595.71.05——**重启即恢复**,需安排重启窗口;临时可用 torch mem_get_info 观测显存)
- [x] core 配 `TOIV_CIVITAI_API_KEY`(✅ 2026-08-08 key 已写入 core `/home/merlin/toiv/deploy/.env` 并重启 toiv-api,下载器 e2e 验证通过:推荐清单点下载即 civitai API 解析+token 自动附加+SFTP 落 NAS;key 是 secret,deploy/.env 已 gitignored 且 deploy.sh 不同步,禁止提交)
