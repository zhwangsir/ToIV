# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-08-30（UX 包 `eb51c86` 已上线 core，远程仍未推）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」

---

## 〇、🔒 硬性规则（每次会话必读）

### 规则一：所有后端服务都来源于 Workstation

> 所有 AI/算力后端服务（ComfyUI/LB、IndexTTS2.5、ASR、Embedding、LiveAct、H3、LongCat、FlashTalk、OpenTalking、JoyCaption 等）全部运行在 Workstation(192.168.71.127 / 100.68.100.90)上。
>
> - core(192.168.71.47)只跑 ToIV web/api + PostgreSQL/Redis，是业务网关，不是算力来源
> - 本机 Mac 只是操作终端；配置里的 `127.0.0.1`/`localhost` 地址只是本地 dev 兜底，**真机排查一律先查 Workstation**
> - 排查「服务离线/引擎不可达」时，第一反应必须是 SSH 到 Workstation 查 systemd 状态和端口监听，禁止臆断服务不存在

### 规则二：文档仅供参考，必须真机验证

> AGENTS.md、STATE.json、TEST_LOG.md 等所有文档都仅供参考，不能替代真机验证。
>
> - 凡涉及 GPU 显存、服务状态、端口监听、文件路径、挂载状态、模型占用、硬件配置等问题，必须先 SSH 执行真实命令（`nvidia-smi`、`systemctl status`、`ss -tlnp`、`mountpoint`、`df -h`、`free -h` 等）后再作答
> - 文档与真机输出冲突时，**以真机输出为准**，并据此修正文档
> - 禁止凭记忆、文档或臆测回答容量/状态/可用性类问题
> - **「已停用/已退役」类记录尤其要复核：stop 不等于 disable，主机重启后 enabled 的服务会自动复活（2026-08-23 ltx25 实证）**

---

## 一、集群设备清单（13 组）

| 设备 | 角色 | LAN IP | Tailscale IP | 类型 | SSH 用户 |
|---|---|---|---|---|---|
| ~~studio01-04~~ | **2026-08-29 全线下线退役**：EXO RDMA :52415 四台真机 curl 全超时，已从 fleet_registry 移除；原承担的 L2/L3 LLM 层（Kimi-K3/GLM-5.2）收拢 spark02 | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | **Mac Studio M3 Ultra 32核 512GB** | dgmt-studio01-04 |
| openclaw01-04 | OpenClaw 网关 :18789 均 200（2026-08-28） | .86/.75/.81/.85 | **100.115.23.67** / 100.76.35.7 / 100.76.140.121 / **100.125.217.11**（01/04 以 Tailscale 2026-08-27 为准，旧 100.69.0.4 / 100.91.128.30 作废） | **Mac mini M4 16GB (hw.model=Mac16,10)**；01 已 profiler 实锤，02-04 同 hw.model | dgmt-openclaw01-04 |
| spark01 | **Qwen3-VL-32B-Instruct-FP8** 评分/反推 VLM(容器 qwen3vl32b, :8000;2026-08-25 替换 molmo2-8B,幻觉实测根治;**2026-08-26 起接管图像/视频反推+宫格 grounding**,别名 molmo2-8b/omni-captioner 保留) | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | LLM L1-L4 主力(**Qwen3.8-27B-Uncensored-FP8 无审查版**,2026-08-23 替换;别名 qwen3.8-27b/qwen3.6-uncensored 均有效, :8000) | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | **192.168.71.116**(2026-08-25 DHCP 由 .115 漂移,MAC 指纹实证;LB/SSH/代码已同步) | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | ComfyUI worker :8193 + 编辑实例 :8194；**TS≠LAN**：LAN :8193/:8194 HTTP 200（2026-08-28 curl 17ms/15ms），⚠️ Tailscale 2026-08-27 离线 21d（这轮没测 TS） | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 小米路由器 | BE10000 Pro(DRT_MI),**AP/有线中继模式**(2026-08-26 由二级路由切换,原 192.168.31.1→.42),管理页 192.168.71.42 | 192.168.71.42 | — | — | — |
| 光猫 | 主网关/拨号(192.168.71.1,MAC 7c:c9:26:ef:01:93) | 192.168.71.1 | — | — | — |
| cloud | 香港网关/frps/OpenResty | 43.119.32.180 | 100.83.78.114 | Linux | root |
| core | **ToIV 生产服务器**(web :3100 + api :8090 + PG + Redis)；:8100/:3501 未监听（AIGCPannel 在 MateBook Colima :8080/:8100） | 192.168.71.47 | **100.77.80.100** | Ubuntu | merlin |
| beijing | 北京国内入口/frps(toiv.wineryz.top) | 8.140.222.24 | — | Linux (阿里云) | root |
| MateBook | 操作终端 | **192.168.71.9**（2026-08-28；~/NAS 已挂） | 100.74.15.34 | macOS | 本机 |

> 🔒 跨地区访问原则(2026-08-23):**浏览器侧直连一律 Tailscale 优先**(画布 iframe 100.68.100.90:8188、工作流 :8189,LAN 地址仅回退候选);core→workstation 服务间调用保留 LAN(共址直连快)。

---

## 二、关键凭据（禁止再次询问）

| 服务 | 用户名 | 密码 | 备注 |
|------|--------|------|------|
| NAS SMB | dgmt-nas | Aki.19950108 | 192.168.71.7，共享名 NAS |
| Tailscale Auth Key | — | tskey-auth-kPM5hHvNGY11CNTRL-UTn8rtRjK8Pfw3riNoGB8Pru71VhdRR9C | 已用于 core 授权 |
| ToIV admin | admin | admin123 | 生产 core |

**NAS 挂载**：
- Linux(Workstation)：fstab 自动挂载 `/home/merlin/nas_mount`，凭据 `/root/.smbcredentials`；**每次 workstation 重启后必须 `mountpoint /home/merlin/nas_mount` 核实**
- Windows(PC01/02)：`cmdkey /add:192.168.71.7 /user:dgmt-nas /pass:Aki.19950108` + SYSTEM session 自挂 Z:（见易错点 W-2）

---

## 三、Workstation GPU 分配（🔒 启动服务前必须核对）

> 显存数字为 2026-08-23 凌晨真机快照,**动态变化,容量规划前必须重新 `nvidia-smi`**(易错点 H-2)。
> RAM 总量 183G:多引擎并跑前必须 `free -h` 查 available(H-5)。

| GPU | 服务 | 端口 | 显存(08-23) | systemd |
|-----|------|------|------|---------|
| GPU0(~69G) | ComfyUI #1(cache-lru 8) / IndexTTS2 / CosyVoice2 / **hy3dtex 纹理管线** / **JoyCaption :9304(~17G)** / **LongCat :8197(cache-lru 3,作业完自动驱逐)** | :8189 / :9200 / :9201 / :9404 / :9304 / :8197 | 08-25 换卡后快照 | comfyui-gpu0 / toiv-tts / (cosyvoice) / toiv-hy3dtex / toiv-joycaption / comfyui-longcat |
| GPU1(69.4G) | Qwen3-Embedding-4B / LiveAct / 超分实例 | :9302 / :9400 / :8261 | ~20+59+0.75G | qwen3-embedding / toiv-liveact / comfyui-upscale-gpu1 |
| GPU2(~56G) | **MiniMax H3(主力视频引擎)** :8195(~41G) / ASR :9210 / FireRedASR :8300 / CosyVoice3 :9202 / Qwen3-TTS :9203 / demucs :9220 / SenseVoice :9211 / 超分 :8262(四小音频服务 08-25 自 GPU0 迁入) | — | — | toiv-comfyui-h3 等;H3 峰值~78G 安全,新增常驻服务前必查 |
| GPU3(54.1G) | FlashTalk :9004(~51G) / OpenTalking / 超分 :8263 | — | — | ~~LTX-2.5 :8198~~ **已彻底退役**(2026-08-23 用户授权自主决断:`disable --now` 已执行,enabled→disabled,GPU3 释放 36G、RAM 54→90G;NVFP4 模型文件留盘可回滚) |

**ComfyUI-LB 后端**（3 后端）：本地 :8189(GPU0) + pc01 :8188 + pc02 :8193。GPU1/2/3 不入 LB 池（专用实例 :8197/:8195/:8198/:8261-8263 均为专用,不入池;每新增同机专用实例必须补 `deps.resolve_worker()` 精确匹配,见 E-3）。

**超分 fleet**：:8261/:8262/:8263 三卡并行 4x-UltraSharp 帧超分,由融合超分链/`scripts/ops/video_4k_upscale_parallel.py` 调用。

**关键服务路径**：ComfyUI=/opt/ComfyUI(venv) · IndexTTS2=/home/merlin/index-tts · H3 实例=/home/merlin/ComfyUI-h3-eval · LongCat=/home/merlin/ComfyUI-longcat · LTX2.5=/home/merlin/ComfyUI-ltx25 · JoyCaption=/opt/toiv-joycaption(transformers 直跑,勿用 vLLM) · pynvml 锁扇用 /opt/nemotron-venv/bin/python(系统 python3 无该库) · **hy3dtex 纹理=/home/merlin/toiv-hy3dtex(原生 hy3dpaint v2-1,torch 2.13+cu130)** · Hunyuan3D Kijai 实例=/home/merlin/ComfyUI-hunyuan3d(:8200 GPU1)

**散热政策(2026-08-16 用户拍板)**：🔒 **无软件温度熔断**——温度高属正常,GPU 自降频即保护,生产禁止以温度为由中止任务;锁扇(NVML SetFanSpeed_v2,fan_guard.py 常驻 /tmp,⚠️ /tmp 是 tmpfs 重启即清,须重传)是吞吐优化;仅持续 ≥95°C 才人工介入。BIOS 机箱风扇曲线已由用户调满速(2026-08-23)。

---

## 四、NAS 模型路径

| 路径 | 内容 | 大小 |
|------|------|------|
| `NAS/Windows/ComfyUI/ComfyUIModel/models` | 主模型库(workstation /opt/ComfyUI/models 指向此处的 symlink) | 524GB+ |
| `NAS/toiv/comfyui-models` | ToIV 专用模型 | ~260GB |

PC01/02 的 `extra_model_paths.yaml` 指向 `Z:/Windows/ComfyUI/ComfyUIModel`（**不得含 custom_nodes 键**,会启动报错）。

---

## 五、Core 生产状态

| 项目 | 状态 |
|------|------|
| toiv-api :8090 / toiv-web :3100 | ✅ systemd 常驻,deploy/deploy.sh 部署 |
| PostgreSQL 18 / Redis | ✅ 真机运行 |
| **内容限制管控**(2026-08-23) | ❌ **已下线**(同日午后用户拍板自行重做,全量移除零残留);nsfw_allowed 回退为未成年硬阻断+X-NSFW 头历史语义;contentpolicy 表 2026-08-27 核实不存在(零残留核销) |
| **视频评分器灰度**(2026-08-27) | ✅ `TOIV_VIDEO_SCORER_ENABLED=true`(用户授权,阈值 0.65);评委 spark01 Qwen3-VL-32B;`TOIV_VIDEO_SCORER_TIMEOUT` 默认 120s(30s 旧值对长视频系统性降级);每次点火 `quality_eval` 结构化日志 + job 表 quality_total/quality_degraded/quality_issues 落库(降级率 SQL 可统计);⚠️ **迁移 DDL BOOLEAN 默认值必须 TRUE/FALSE,PG 不认 DEFAULT 0**(2026-08-27 部署启动失败实证,守卫测试防回归) |
| **sfx 引擎选型**(2026-08-27) | 首选 **MOSS-SoundEffect v2.0**(Apache 2.0/中英双语/48kHz/1.3B);备选 Stable Audio 3.0 Small-SFX(CPU 零 GPU 争用);落地 toiv-sfx.service :9102 → audio_orchestrate sfx 步 501 解除(下轮) |
| **数字人 M1-M3**(2026-08-27) | ✅ 形象库(ReferenceAsset kind=avatar+green_screen+ref_audio)+ avatar/talk **TTS 直通**(drive_text/voice/speed 与 audio 互斥,TTS 失败 502 零半成品)+ ASR→SRT(`GET /api/dub/transcribe/{id}?format=srt`);借鉴 aigcpanel(形象模板/双驱动/字幕导出) |
| **数字人 M4-M6**(2026-08-27 深度完善) | ✅ **M4 通用对口型**:`toiv-lipsync.service`(GPU0 :9103,LatentSync 裸机复活 torch 2.8+cu128 sm_120)+ `POST /api/video/lipsync`(degraded→error 不造假,submit 字段 video/audio);**M5 直播助手**:LiveKB/违禁词/互动事件+OpenTalking 播报(ingest 流水线,AvatarTalkView 第三模式);**M6 绿幕抠像**:`POST /api/video/chromakey`(ffmpeg chromakey+overlay);⚠️ LatentSync 推理峰值 ~6G;root Docker latentsync :8600 遗留未处置 |
| **LoRA trainer :9100**(2026-08-27) | ✅ `toiv-trainer.service` active+enabled(workstation);core `TOIV_TRAINER_URL=http://192.168.71.127:9100`;⚠️ arch 字符串以 workstation ai-toolkit 实测为准(zimage 无下划线/qwen_image/flux2/内置 flux),run.py 配置为**位置参数**;不支持族(10eros/ltx/pony/sd15)400 拒绝;**h3 族已支持**(arch=minimax_h3,num_frames 17n+5 吸附,真训练 310MB rank16 实证) |
| **trainer 易错点**(2026-08-27 四连败实证) | ①YAML `device` 恒 `cuda:0`(物理卡由 subprocess `CUDA_VISIBLE_DEVICES` 单卡视图指定,写 cuda:2 回退物理 GPU0 OOM)②GPU2 多租户训练前必须 `POST :8195/free` 驱逐 H3 推理缓存(39G→17G,自动重载)+ h3 `low_vram` 默认 true ③`training_folder` 必须每作业独立(共享 loras 根被 ai-toolkit resume 误捡其他 LoRA optimizer.pt 致 torch.load 崩)④产物在 training_folder/\<name\>/\<name\>.safetensors(双嵌套),`_find_lora_file` 递归发现 ⑤可选参数全量默认值(缺 batch_size 曾 KeyError 断连) |
| **H3 数据飞轮**(2026-08-27) | ✅ 接线完成:`scripts/h3/h3_flywheel.py`(winner 数据集导出→软链→free-h3→train→`GET /train/{id}` 轮询);⚠️ 生产真实飞轮待 eval 数据(evalbatch/evalscore 0 行,需先跑 best-of-n 批次) |
| **IndexTTS2 守护**(2026-08-27) | ✅ `toiv-indextts.service` 替代 nohup 裸进程(active+enabled,health cuda:0);emo_text=true 为 2.5 正常默认(2.0 卡死 issue 已核销) |
| **音频编排**(2026-08-27) | mix(ffmpeg amix)/variant(duration_factor 语速变体)落地;sfx 仍 501(需音效引擎);可用步骤 tts/separate/concat/mix/variant |
| **i2L 风格 LoRA**(2026-08-27) | ✅ `toiv-i2l.service`(workstation GPU3 :9101,惰性加载常驻显存 ~26G)+ core `POST /api/train/i2l`(1-8 风格图→LoRA 落 NAS loras 自动发现);e2e 1:59 出 476 张量 rank4 19.9MB 键名 0 坏键;⚠️ core 新端点须 deploy.sh 后才可 e2e |
| **LLM 引擎矩阵**(2026-08-28 对照仓) | SFW 视频主路 **H3=海螺 3.0**（不是 Hailuo 2.3）。**不要**把 Wan2.2 写成 SFW/AIGCPannel 空镜。Wan2.2 I2V 与 LTX-2.3+10Eros 主要在 **R18**；AIGCPannel 空镜/预览=LTX-2.5（`:8198` 起来再开）。Wan2.1-VACE 仅编辑/转场；图像默认 FLUX.2 + Qwen-Image/Z-Image。混元视频/SkyReels 未挂。spark02 **Qwen3.8-27B-Uncensored-FP8**。文案对齐见 `0f6e723`/`f2885ee`。 |
| web_search 出站代理 | `TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`(MateBook Clash LAN；2026-08-28 20:46 core `/home/merlin/toiv/deploy/.env` 已改、`toiv-api` 已重启)。旧 `.123` 从 core 连不上。Clash `:7897` 本机和 Tailscale `100.74.15.34` 都能通，但 websearch 只收一个 proxy，TS 备选未写入 env。⚠️ 依赖 Mac 在线,离线时自动降级不炸链路 |
| 域名双入口 | toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(北京,frpc-bj);openresty proxy_pass 经 frp 本地端口 127.0.0.1:18090/13100 |
| **Studio 依赖迁移**(2026-08-26) | ✅ 反推 VLM studio04:9303 → **spark01 Qwen3-VL-32B**(`TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.82:8000/v1`,`TOIV_REVERSE_VIDEO_MAC_PREFIX` 清空,base64 video_url 直传无 NAS 中转);L2/L3 此前已在 spark02;core 对 Studio 集群零依赖;备份 `.env.bak-20260826-studio-migration`;studio04 :9303/NAS 挂载保留观察;**2026-08-27 用户确认 MacStudio 全线已下线**,退役 unload 待设备回线执行 |

---

## 六、⚠️ 易错点（按主题归并,保留教训精华）

### H. 硬件/容量类

**H-1 禁止臆造硬件数据(2026-08-02 硬性错误)**：曾把 Mac Studio 写成 M2 Pro 并臆造「4 台共 192GB」(实际 M3 Ultra 512GB×4=2TB)。🔒 任何硬件配置/容量问题必须先 SSH 真机确认。

**H-2 文档显存数字是快照不是真理(2026-08-09/19)**：显存随 `--cache-lru`、模型加载状态、采样中动态变化;容量规划/共卡部署/「还能不能装」必须现场 `nvidia-smi`。vLLM 默认 `--gpu-memory-utilization 0.9`(85G+),共卡必须显式调低。

**H-3 多引擎并跑先算 RAM 预算(2026-08-21 P0)**：ComfyUI#1 39.7G+ltx25 37.8G+LiveAct 13.3G+H3 同驻曾致 183G RAM 耗尽,OOM killer 杀 H3,14 作业 error。上架大 RAM 模型前 `free -h` 查 available;H3 已加 drop-in `MemoryMax=160G`。

**H-4 「DB 标 error」≠「生成失败」(2026-08-21 P0)**：tracker 曾把「仍在 /queue 排队」误标超时 error,真机 ComfyUI history 显示实际全部 success、产物在盘。批量失败第一反应查 `/history/{pid}`,产物在就回写,禁止盲目重提浪费 GPU。超时/回收逻辑必须区分「排队等待」与「丢失」(tracker 已修复:在 /queue 时重置超时窗口)。

**H-5 温度政策(2026-08-16 用户拍板)**：无软件熔断(详见第三节散热政策);但注意风扇曲线懒惰会让 400W 负载时风扇仅 37%——锁扇 100% 是提速手段。

### D. 退役/迁移记录类

**D-1 stop≠disable,重启会复活(2026-08-23 实证)**：ltx25 08-21 拍板退役时只 stop 未 disable,BIOS 重启后 systemd 自动拉回(GPU3 又占 36G+RAM 37.8G)。🔒 退役服务必须 `systemctl disable`(或 mask);同理「已迁移/已停用」记录每次跨项目记忆冲突时必须真机复核(2026-08-17 曾因此揪出 3 个生产死链:VLM 反推/demucs/ASR,均已修复)。

**D-2 一次性手工迁移没有守护会静默失效(2026-08-17/09)**：studio01/02 的 demucs/whisper.plist 被删无人知,文档「已迁移」长期失真。生产依赖变更后必须实测业务链路(/api/reverse 等),不能只看服务 active。

### N. 网络/代理类

**N-1 跨境链路波动会污染 A/B 结论(2026-08-11)**：cloud(香港)↔core 跨境晚高峰剧烈波动,单时段切换协议的「改善」可能是链路自愈假象。A/B 测试必须**同时段交替测**;「502/超时」先看是否全局链路事件(多隧道同断/SSH 断)再怀疑本地配置。frpc 加 `loginFailExit=false` 抗抖动。

**N-2 HF/外网下载依赖 Mac Clash 代理(2026-08-08/23)**：core/workstation 直连 HF/civitai B2 超时;路线=Mac Clash(192.168.71.9:7897 LAN；TS 100.74.15.34:7897 也能通，下载可走 TS；websearch env 只写了 LAN `.9`)。hf-mirror 对部分仓库 403、orcarouter 原 repo gated;chimingw 镜像仓可下(29GB FP8 实证 8MB/s)。**依赖 Mac 在线,下载大模型要提前规划**。

**N-3 Tailscale 跨地区访问(2026-08-23)**：浏览器侧直连一律 Tailscale 优先(画布已改 100.68.100.90 默认+LAN 回退);workstation 服务须监听 0.0.0.0 才经 TS 可达。

**N-4 Windows 长命令经 SSH 会被换行截断**：写远端文件用 PowerShell `-EncodedCommand`(UTF-16LE base64)最稳;`schtasks /change /tr` 非交互会挂起,用 `/create /f` 覆盖重建。

### W. Windows 类

**W-1 SSH session 隔离**：SSH 里 net use 映射的盘符用户桌面看不到;SSH 用 Start-Process/wscript 启动的进程断连即被杀。长期服务用**计划任务+bat**(pc01 InteractiveToken 模式)。

**W-2 SYSTEM 计划任务看不到用户盘符映射(2026-08-17 pc02 根因)**：驱动器映射 per-logon-session,SYSTEM(S-1-5-18)进程看不到 W 桌面 session 的 Z:。正确:ps1 开头在任务自己 session 里 `net use Z: /delete /y` + `net use Z: \\192.168.71.7\NAS /user:dgmt-nas <pwd>`。模型可见性的最终裁判是 ComfyUI 进程视角的 object_info,SSH 里 `dir Z:` 是假阴性。

### E. 引擎/工作流类

**E-1 新专用 ComfyUI 实例必须补 resolve_worker 精确匹配(2026-08-07)**：同机非池实例(如 :8197)会被 hostname 回退错配到池 worker,作业成功但产物 502。每新增一个同机实例,同步检查 `apps/api/app/deps.py`。

**E-2 LongCat 两个链路坑(2026-08-08)**：① TI2V 的 i2v 用 WanVideoEncode→extra_latents(**不是** WanVideoImageToVideoEncode);② Avatar v1.5 音频必须 whisper-large-v3(不是 wav2vec2,维度对不上);③ WanVideoWrapper 里必须 `rope_function="comfy"`,否则 4096 vs 128 维度错。

**E-3 LTX 音画链(2026-08-11)**：LTXVAudioVAELoader 只认内嵌 `audio_vae.*` 键的全量底模(ltx-2.3-22b-distilled-1.1),mmaudio ckpt 报 `VAE is invalid: None`;loader 只扫 checkpoints 类目。🔒 引擎探测通过≠链路可跑,新引擎必须真机 e2e 后交付。

**E-4 vLLM 相关(2026-08-08)**：① NVML mismatch 会炸 vLLM 平台探测(补丁 /home/merlin/patch_vllm_nvml.py,pip 重装后重跑);② vLLM 0.11.2 跑不了 LLaVA 架构 JoyCaption(device-side assert),transformers 直跑即可;③ spark 的 vllm-node 镜像缺 vllm[audio],启动脚本须 entrypoint 里 pip install;④ served-model-name 别名机制——换模型保别名=core 零改动(2026-08-23 无审查模型替换实证)。

**E-5 mlx-vlm(studio04)视频只认本地路径**(2026-08-26 已退役该依赖):反推 VLM 已迁 spark01 Qwen3-VL-32B(base64 video_url 直传,无 NAS 中转),`TOIV_REVERSE_VIDEO_MAC_PREFIX` 已清空;这条坑只在回滚到 studio04 时复活(回滚=恢复 .env 两行+重启)。studio04 挂载 08-26 又静默失效一次(D-2 教训),迁移后此单点已消除。

**E-6 超分竖屏源必须显式 --target-w 2160 --target-h 3840(2026-08-15)**：默认参数会把竖屏每帧拉伸成横屏全报废;生产一律 `--keep-frames`(默认删帧无法续跑);画幅方向护栏已内建。

### P. 平台机制类

**P-1 产物 URL 已签名+归属校验(2026-08-14)**：tracker 生成的 /api/images URL 带 sig(HMAC);无 sig 旧 URL 走 Job 归属回退;admin 直通;其余 404。测试构造产物 URL 必须带 sig 或先建档。<img>/<video> 标签走 `?token=` 查询参数认证。

**P-2 Next.js 生产构建必须 rm -rf .next 干净重建(2026-08-17)**：陈旧 .next/cache 会导致 chunk 内部错位,next start 即 500(`Cannot find module './N.js'` 但文件在);deploy.sh 防呆拦不住,干净构建是唯一可靠前置。**补(2026-08-24 实证):deploy.sh 只 rsync 不重建——部署前必须确认本地 .next BUILD_ID 是当次代码的新构建,否则静默上线陈旧前端(观测面板/助手 P1 曾因此白部署两轮,API 验证全过但 UI 是旧的;验证前端变更必须截图/查 BUILD_ID,不能只看 API)**。

**P-2b styled-jsx 作用域坑(2026-08-24 生产实证)**:`<style jsx>` 的 jsxId 只打在**主组件自身**的 JSX 上;同文件子组件(如 KpiStrip/各 Card)的元素拿不到作用域类,整段样式静默失效且测试全绿(单测不查计算样式)。多组件文件一律 `<style jsx global>` + 前缀命名(obs-/uichart- 已是惯例);UI 改动必须真机截图验证,别信组件渲染测试。

**P-3 浏览器自动化测 React(2026-08-11)**：原生事件不触发合成事件——select 要用 native setter+dispatchEvent 派发 change;多 textarea 时 querySelector 要用 `.promptbar-textarea` 类选择器精确定位。

**P-4 命令行自杀坑**：`pkill -f` 模式串含自身 ssh 命令行会自杀(exit 255),用 `[f]an_guard` 式转义;torchrun 拉起的进程杀子会复活,须连父进程一起杀;/tmp 是 tmpfs——大文件写 /var/tmp,脚本放 /tmp 重启即清(fan_guard 已实证)。

**P-5 并行 SSH 会话会互相改写状态(2026-08-11 高优)**：多操作者(用户/多 AI 会话)同时动 workstation 时服务状态被反复改写形成拉锯;关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源(哪个 IP/会话/time),再处置。

**P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top;core 登录接口返回字段是 `token` 不是 `access_token`;上传 kind 必须下划线风格(ltx_i2v 等),连字符导致 capabilities 门控失效;H3 生成前置校验显存,调用前先 free 缓存。

**P-7 新 Python 服务环境三坑(2026-08-25 hy3dtex 实证)**：①RTX PRO 6000 是 sm_120(Blackwell),torch cu126 及以下**无内核**(报 `no kernel image`),必须 cu128+/cu130;pip `cuda-toolkit` 包不含 nvcc,编译 CUDA 扩展借现存 venv 的 `nvidia/cu13`(CUDA_HOME 指过去即可)。②老牌 CV 包(basicsr/realesrgan)sdist setup.py 需 torch/scipy 且钉死不存在依赖(tb-nightly)——`--no-build-isolation --no-deps` 安装 + torchvision `functional_tensor`→`functional` 补丁。③三方库主版本升级静默改语义:trimesh 5.x `simplify_quadric_decimation` 首位参数从 face_count 变 percent(关键字传参保命);diffusers 0.40 自定义管线强制 trust_remote_code;**库升级后旧调用约定必须逐处核对,能跑≠语义对**。

---

## 七、近期关键变更（决策记录,替代操作历史）


### 2026-08-29（三视图卡死根治 + 任务中心进度体系,已部署 core）

- **事故**:worker(ComfyUI :8189)驱动级挂死整机重启 ~2h,主体库/短剧角色三视图的回写协程一次性超时退出,主体永久卡 generating(生产实证:主体「补图冒烟0829」3 作业 error、状态无人收口)。
- **根治(e4bb0b3)**:①回写任务改**多轮等待**(单轮 900s,超时但作业 alive 不标 error,小睡 30s 进下一轮,总预算 7200s);②Job params 快照注入 entity_id/character_id,api 启动 reconcile 按此反查作业——作业齐且 alive/全 done 重挂回写,有 error/找不回(旧数据无快照)标 error 允许重试;③main.py 启动序列接入 `entities.reconcile_entity_references`。
- **同批上线**:全量进度体系(Job.progress 列+tracker 排队位置+SSE 节流)+ GET /api/jobs/active(引擎均耗 ETA)+ 前端任务中心(导航栏面板轮询+完成通知);主体库重做(Entity 扩 avatar 字段+ReferenceAsset 双轨归并迁移+异步 generate-reference);h3 negative 折进 prompt「Avoid:」。
- **生产实证**:部署后启动 reconcile 自动把「补图冒烟0829」标 error → 重提 → 3 作业 done → 四图槽回写 done(2MB 正面图可访问);任务中心 running/queue_pos/ETA 透出正常。
- ⚠️ 教训(E 类新增):**回写协程生命周期不得超过 tracker 作业生命周期**——worker 停机维护可超 2h,一次性等待必死;所有「等待作业完成再落库」的后台任务都要按多轮等待+启动 reconcile 双保险写。

### 2026-08-29 下午（视频路径锁 + B3 多主体注入,已部署 core）

- **路径锁(42dba0c)**:R18 LTX-2.3 t2v 无首帧即 10Eros 也塌色块(生产事故)——`/api/generate/ltx-t2v` 与 `/api/ltx2/t2v`(选 10eros)一律 422 引导改 i2v 上传首帧;`LtxVideoGenerator` NSFW 支路无 image_url 直接拒绝;SFW LTX t2v(distilled/dev)不受锁。注册表 H3 t2v 标 `ordinary_default`,LTX/Wan R18 全系标 `advanced`;web/小程序进阶沉底+「进阶」徽标,默认引擎不落 LTX/Wan。
- **B3 多主体注入(同 commit)**:agent `submit_generation` 对 H3 透传 `entity_ids`(此前丢弃,@图片N 对助手完全失效);`h3-multishot` 补 `entity_ids` 字段并与 t2v 同层同序注入引用行;前端 `engines.ts` 补 phantom-s2v 提交分支+entity_ids 透传。
- **生产实证**:SFW 列表 h3-t2v `ordinary_default=true`;R18 列表 h3-nsfw-t2v 默认、ltx-nsfw-*/wan-nsfw-i2v 全 `advanced=true`;R18 `/api/generate/ltx-t2v` 实测 422 文案含「请上传一张首帧」。

### 2026-08-29 晚二（七项体验治理包,已部署 core）

- **背景**:用户报 7 项体验问题(功能臃肿/导航冗余/拆解超时/资产割裂/引擎混乱/卡顿/观测失真),五项 commit 一次部署。
- **#7 观测与 LLM(86a94e8)**:Studio01-04(EXO :52415)真机全超时 → fleet_registry 移除,观测面板不再显示;L2/L3 LLM 默认收拢 spark02 qwen3.6-uncensored(生产 .env 已是此口径)。
- **#2 导航(6c69b6f)**:灵动岛/底部抽屉收「短剧」(融合页创作工作室承载);PageHeader 加 onBack,创作工作室/数字人/译制/图片编辑/视频编辑五页统一「‹ 返回融合」;drama 视图本体与 R18 门控保留。
- **#3 拆解异步化(fae48dc)**:`POST /studio/projects/{pid}/script/parse` 改提交制(Job studio_script_parse + 进程内后台 LLM),`GET …/parse/{job_id}` 轮询;前端 120s 墙 → 8min 轮询;api 启动 reconcile_parse_jobs 收口重启中断;任务中心可见可中止。**生产实证:真实剧本 4 镜拆解 done(2 角色),无超时**。
- **#5 H3 主路收敛(05f7703)**:14 个非 H3 视频引擎(LongCat/Ovi/Phantom/LTX2.5 多镜头/Wan 系/keyframe-chain/vace-edit/avatar-talk)标 advanced 沉底,API 全保留;SFW 视频选择器只剩 H3 三件套。H3 entity_ids 上限 16→9(对齐官方 Ref2VA 全能参考上限;调研确认 4-15s/24fps/32kHz 立体声/9 图+3 视频+3 音频)。
- **#4+#6 资产合并与性能(aefea45)**:AssetPicker 图片类加「作品库|主体库」双源 Tab(主体图经 resolve-refs 钉定转运);MultiShotEditor 补主体引用(≤9);三处编辑器轮询 fetchJobsPage(0,200) → 新增 `GET /api/jobs/lookup` 单条精确查;AssistantView 长会话渲染窗口 80 条 +「加载更早」。
- ⚠️ 过程教训:用户 IDE 缓冲区多次覆盖本会话编辑(page.tsx/tracker.py/cornernav.css/multishot.ts 等被部分回滚),**改动后必须立即 tsc+测试+commit 锁定**,commit 前 git diff 全量复核。
- 回归:后端 pytest 2777 全过(+5),web 694 全过,tsc 0;deploy.sh 双服务健康通过。

### 2026-08-29 晚（任务中心中止按钮 + hidden 引擎,已部署 core）

- **中止(35b8b87)**:`POST /api/jobs/{id}/cancel`——仅本人(404 防枚举)、终态 409、审计 `job.cancel`;DB 先落 `canceled` 再尽力清场 worker(ComfyUI pending→`POST /queue {"delete":[...]}`、running→`POST /interrupt`;`hold-*`/`chain-*` 占位跳过;worker 不可达不阻塞,DB 终态不回滚)。tracker 视 `canceled` 为终态:`mark_status`/`write_progress` 跳过、`_track` 每轮自检早退;`wait_for_jobs` 抛「已被用户取消」→ 三视图回写标 error 允许重试。`ComfyUIClient` 新增 `delete_from_queue`/`interrupt`/`cancel_prompt`(/interrupt 无定向,先查 `queue_running` 防误中断同实例他人)。
- **hidden 引擎(60d6168)**:`ltx-nsfw-t2v` 标 `hidden`(API 422 仍在,选择器不再展示);`GenerateView`/小程序 hidden 不进列表;R18 上下文默认优先 `ordinary_default + nsfw` 的 H3(带 R18 LoRA 预设)。
- **前端**:任务中心每条目「中止」按钮(confirm 确认 + 中止中防连点 + toast + 即时刷新,样式挂 `--err` 令牌)。
- **生产实证**:core 上提交 txt2img → 任务中心可见 queued → cancel 返回 `worker_action=interrupted` → 列表消失、DB `status=canceled`、不进回收站。
- ⚠️ 注意:`deploy/.env` 第 9 行是裸 URL(`http://localhost:3101`),`source` 时会报「没有那个文件或目录」但不中断后续行加载;systemd EnvironmentFile 也能容错。属历史遗留,不影响运行。

### 2026-08-30 UX 体验包（ToIV 开发，`eb51c86` 已上线 core，远程未推，不改设备清单）

- 本地 `eb51c86`（远程未推，已上线 core）：`fix(ux): stop actually cancels, identity uses covers, library filters honestly`。停止会 `cancelJob`/中止请求；主体封面走 i2v/img2img；时长 4–15s 加分段续写开关；作品库含 `h3_extend_i2v` 和 `cad_`/`drama_char_reference_` 前缀。
- 远程仍未推 Gitee/GitHub。core `toiv-api`/`toiv-web` 均为 active。公网/LAN health 200。前端 BUILD_ID `20260829-213739-72a9c0f-dirty`（编网页时 HEAD 已是 docs `72a9c0f`；UX 代码仍是 `eb51c86`）。

### 2026-08-30 Job.nsfw 合同（ToIV 开发，`fb78872` 已上线 core，远程未推，不改设备清单）

- 本地 `fb78872`（远程未推，已上线 core）：`fix(nsfw): Job.nsfw follows explicit intent, not the X-NSFW header`。`X-NSFW` 只作成人页查看/创建门禁，不再给每条作品盖 18+。`Job.nsfw` / H3 换 10Eros 仅当请求体显式 `nsfw:true`（`h3-nsfw-*` / `wan-nsfw-*`）或用户钉选 R18 LoRA。网页 `engines.ts` 已带 `nsfw:true`。
- `is_nsfw(ckpt)` 收成明确成人词（nsfw/r18/hentai/uncensored/porn/xxx、10eros、hassaku、lustify、shufflenoob、autismmix、pornmaster、urpm、yiffy、biglove、stoiqo）。pony / wai / illustrious / realisticvision / animagine / noobai / cyberrealistic / lazymix / nova3dcg 不再整锅 18+。
- 生产库 3 条误标已改回 `nsfw=false`：4K 超分 `d79ca9cf…`、试穿 `t2v_00183_`/`t2v_00184_`（`e07b0cb4` / `71cf52cc`）。库数据修正已落地；代码 `fb78872` 已部署 core。
- 远程仍未推 Gitee/GitHub。core `toiv-api`/`toiv-web` 均为 active。公网 `https://toiv.wineryz.top/api/health` 与 LAN `:8090`/`:3100` 200。前端 BUILD_ID `20260829-185858-fb78872-dirty`。

### 2026-08-28 长会话自动折叠（ToIV 开发，未推，不改设备清单）

- 本地 `a5e04ea`（未推）：长会话自动折叠，不再要求新开。续聊只上传本轮 user；runner 从 `AgentMessage` 重建再折叠。错误文案改为「这一条太长，请缩短本轮输入」。32k GPU 硬顶仍在。生产还没有。

### 2026-08-28 助手上下文溢出（ToIV 开发，未推，不改设备清单）

- 本地 `e833f33`（未推）：助手上下文溢出（用户贴的 NSFW LLM 主备均不可用 / 32768 token / 0 output tokens）。工作副本 tool 正文上限 1800 字；`chat()` 不再每轮塞 17 个 `mcp__` schema；超长 400 再压一半预算重试一次，仍失败中文提示「这一条太长，请缩短本轮输入」（`a5e04ea` 起不再要求新开会话）NSFW 与主模型同一端点时不再双打。落库 `AgentMessage` 仍全量。生产还没有这版。

### 2026-08-28 助手 SSE 超时回放（ToIV 开发，未推，不改设备清单）

- 本地 `58cf643`（未推）：助手「答复时显示超时、刷新才有内容」——前端把还在跑的 SSE 掐了，后端已把 `AgentMessage` 落库。小程序 SSE 超时 180s→10min；Web/小程序超时后 GET 会话，若已有助手回复就展示，不再弹「回复失败:连接中断或超时」/「请求超时」。4xx/5xx、空会话、用户停止仍走旧错误。生产还没有这版。

### 2026-08-28 晚（ToIV 开发对照仓，不换模）

- ToIV 开发对照仓：**不换视频/图像主路**。SFW 主路 **H3=海螺 3.0**（不是 Hailuo 2.3）。**不要**写 AIGCPannel 空镜走 Wan2.2；短剧空镜/预览=LTX-2.5（`:8198` 起来再开）。Wan2.2 I2V 与 LTX-2.3+10Eros 价值主要在 NSFW，留 ToIV R18。Wan2.1-VACE 仅编辑/转场；图像默认 FLUX.2 + Qwen-Image/Z-Image。`f2885ee` 已把 VACE 注释改成「SFW 主路 H3；Wan2.2/LTX-2.3 主要在 R18」。混元视频/SkyReels 未挂。AIGCPannel 不改 ToIV。
- 项目管家只记五件套，不改 ToIV 业务代码，不推本地 Phase4 功能叠。
- LTX 竖版 `859b60f`（本地未推）：`LtxT2VRequest.height` 上限 1080→1920，对齐 `_LTX_NSFW_RESOLUTIONS` 竖版 720×1280；之前预设会 Pydantic 422。回归 `test_ltx_t2v_accepts_vertical_720p_preset`。只动 `video.py` + `test_video.py`。生产仍是旧 `le=1080`。空 `positive` 也会 422；缺 `X-NSFW` 是 403 不是 422。Ovi/MCP 未带上。
- LoRA 策划卡 `93c275e`（本地未推）：本地 `93c275e`（未推）：海螺/LTX/Wan 提交时 AI 从策划卡选 LoRA，禁止 NAS 自由混。协议：`loras` 省略/null = auto；显式 `[]` = off；非空 = pin（必须是策划卡文件名，否则 422）。前端空控件省略字段，故空白=auto。目录规模：Wan 6（全 NSFW，保留 HIGH/LOW）；H3 13（R18 + 部分 SFW；turbo 加速不自动选）；LTX 2（motion + dolly）。R18 空提示会插入引擎通用概念卡（H3 `HMNSFW_AIO_V2`，Wan `NSFW-22-H-e8`）。Wan auto 会按原 `pick_trigger_words` 前置触发词。LTX 无通用概念卡时可能 0 条（10Eros UNET 已承担 NSFW）。生产仍无此能力。Ovi/MCP 未带上。
- LTX R18 LoRA `e1f856e`（本地未推）：本地 `e1f856e`（未推）：`lora_picker` 在引擎没有 concept 卡时（LTX），R18 auto 回退第一张 motion 卡。提示词 `a` 会挂 `ltx_2.3_22b_distilled_1.1_lora_dynamic_fro09_avg_rank_111_bf16.safetensors`（0.8，`r18-default-motion`）。H3/Wan 仍优先概念卡。生产仍无此能力。Ovi/MCP 未带上。

### 2026-08-28 20:46（设备管家：Clash 代理 LAN `.9`，core env 已改）

- `TOIV_WEB_SEARCH_PROXY` 真机：core `/home/merlin/toiv/deploy/.env` 已改为 `http://192.168.71.9:7897`，`toiv-api` 已重启。旧 `192.168.71.123:7897` 从 core 连不上。MateBook 当前 LAN 是 `.9`。Clash `:7897` 本机和 Tailscale `100.74.15.34` 都能通；TS URL 没写进 env（websearch 只收一个 proxy）。

### 2026-08-28 16:45（设备管家 LAN SSH 核验，只读，未改配置）

- **OpenClaw 01-04**：全部 `hw.model=Mac16,10`（M4 Mac mini），**不是 M2**。`:18789` 均 HTTP 200。 16:47 对 **openclaw01** profiler：Chip Apple M4、10 核(4P+6E)、Memory 16 GB（未抄序列号）。02-04 这轮只确认过 hw.model。`fleet_registry.py` 已与 SoT 对齐：`cf79e39` hardware=Mac mini M4 16GB（未抄序列号，未推）。
- **pc02** `192.168.71.114`：**TS≠LAN**。LAN curl `--noproxy '*'` `:8193` HTTP 200（17ms）、`:8194` HTTP 200（15ms）。 Tailscale 这轮没测（08-27 离线 21d 记录仍在）。
- **studio01-04**：仍 SSH timeout，维持全离线。
- **LTX**：`comfyui-ltx25` 仍 inactive+disabled，无 `:8198`。
- **MateBook**：当前 LAN `192.168.71.9`；`~/NAS` 已挂。
- **core**：ToIV 仍是 `:3100` / `:8090`。`:8100` / `:3501` 未监听（AIGCPannel 在 MateBook Colima `:8080` / `:8100`）。
- **记账、先不改服务**：workstation swap 8Gi 100% 用满；`toiv-tts` NRestarts=6363（当时已 active，但不稳）。spark / core / 四卡 GPU 该亮的都在。

### 2026-08-27（项目管家真机复核，MateBook LAN + Tailscale）

- **core**：`toiv-api :8090` / `toiv-web :3100` / PostgreSQL / Redis 均为 active。env：`TOIV_VIDEO_SCORER_ENABLED=true`，`TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.82:8000/v1`，`TOIV_REVERSE_VIDEO_MAC_PREFIX` 空，`TOIV_TRAINER_URL=http://192.168.71.127:9100`
- **workstation**：NAS `/home/merlin/nas_mount` 已挂载。`comfyui-ltx25` inactive。active：comfyui-gpu0 / toiv-comfyui-h3 / toiv-tts / toiv-indextts / toiv-trainer / toiv-joycaption / comfyui-longcat / qwen3-embedding / toiv-liveact / toiv-hy3dtex / toiv-scope
- **GPU 显存快照**（idle）：0=55172 / 1=75285 / 2=56312 / 3=64459 MiB（总量各 97887）。RAM available ≈19Gi（偏紧，低于 ltx25 退役后那次 ~90Gi）
- **spark01** `192.168.71.82`：Qwen3-VL-32B-Instruct-FP8，别名 `qwen3-vl-32b` / `molmo2-8b` / `omni-captioner`
- **spark02** `192.168.71.84`：Qwen3.8-27B-Uncensored-FP8，别名 `qwen3.8-27b` / `qwen3.6-uncensored`
- **Tailscale**：studio01-04 离线（与 08-26/27 退役记录相符）；pc01 在线；pc02 离线 21d
- **文档**：集群真相只留本文件。ALLProject 各项目根目录统一 5 件套，旧副本进 `.archive/docs-legacy-20260827/`

### 2026-08-26（网络拓扑根治:小米路由器切 AP 模式,孤岛消除）
- **故障现象**:NAS(.7)与 core(.47)互相可达但都到不了网关 .1,workstation 的 `/home/merlin/nas_mount` 挂载断开;观测面板显示设备离线
- **根因**:小米 BE10000 Pro(DRT_MI)作为**二级路由**挂在光猫 71 段下(WAN=192.168.71.42 DHCP,LAN=192.168.31.1),NAS/core 物理接在小米 LAN 后,但静态网关仍指 .1(光猫),二层广播域隔离导致 .1 ARP 永远 INCOMPLETE
- **诊断关键**:NAS/core ARP 表 `.1=INCOMPLETE` 但存在 IPv6 RA 路由器(MAC d4:53:2a:49:0a:b8 广播公网前缀 240e:);从 core 加临时地址 192.168.31.200 打通小米管理页
- **修复**:经 `api/xqnetwork/set_lan_ap` 切**有线中继(AP)模式**,小米停二级路由,所有口变交换口,并入 71 段(现 192.168.71.42);WiFi 名/密不变
- **实证**:ws/core→.7/.47/.42/.82/.114/.116 全通;NAS 挂载自动恢复;16/17 设备在线(仅本机 .123 离线正常)
- **教训**:「设备离线」先查**二层拓扑/网关一致性**,别急着归因物理断线;多路由级联时静态 IP 设备的网关必须与其所在广播域的路由器一致

### 2026-08-25（晚·GPU2 过载三方换卡均衡）
- **背景**:GPU2 峰值 92.9%(H3+JoyCaption 常驻+LongCat 按需 25G 三叠加),GPU0 相对宽松;GPU1/3 大块(LiveAct/FlashTalk 50-58G)无处可接不动
- **三方换卡**(端口/core 零改动,仅改 GPU 绑定):①JoyCaption GPU2→GPU0(start.sh 改 CUDA_VISIBLE_DEVICES=0);②LongCat GPU2→GPU0 且**新增 `--cache-lru 3`**(此前无驱逐,空闲也占 25G 常驻,改后作业完自动释放);③四小音频服务(sensevoice/qwen3tts/cosyvoice3/fireredasr)GPU0→GPU2(吸收小碎块)
- **落卡实证**:joycaption/longcat pid 在 GPU0,四音频在 GPU2(fireredasr 懒加载,env 已 =2);GPU0 69.4G / GPU2 55.7G(原 92.9%)
- **新稳态**:GPU0 常驻~66G+池缓存可驱逐(28G 余量);GPU2 = H3+demucs+超分+四音频,峰值~78G 安全;绑定方式:longcat 用 drop-in gpu0.conf(ExecStart 覆盖加 cache-lru),音频服务改既有 gpu0.conf
- 后室 Level-1 成片同日交付:12 段无损 concat 94.6s/18.3MB,NAS toiv/films/backrooms_level1_final.mp4,DB 回填

### 2026-08-25（P0 服务替换双落地:Qwen3-VL-32B + Hunyuan3D 2.1 纹理管线）
- **P0-a spark01 molmo2→Qwen3-VL-32B-Instruct-FP8**:容器 qwen3vl32b(vLLM),别名 qwen3-vl-32b/molmo2-8b/omni-captioner 三在线 core 零改动;scoring.py/eval_scorers.py `video`→`video_url` 修复(vLLM Qwen3-VL 只认 OpenAI 标准);core→spark01 双模态 e2e(白图→White、红视频→Red)无幻觉;`TOIV_VIDEO_SCORER_ENABLED` ~~生产仍 false~~ **2026-08-27 已开灰度**(用户明确授权,阈值 0.65,观察降级率,备份 .env.bak-20260827-scorer)
- **P0-b toiv-hy3dtex :9404(workstation GPU0,systemd enabled)**:原生 hy3dpaint v2-1(多视图扩散+DINOv2-giant+RealESRGAN+PBR 烘焙)补「3D 无贴图」缺口;core `POST /api/3d/texture`(job_id|source,参考图三优先级:显式>原作业回填>纯白+文本引导)产物建 Job(kind=threed_texture);adjust_3d op=texture + 灯箱「AI 纹理贴图」折叠区(960s 超时);生产 e2e 47.5s 出 3.4MB PBR GLB 实证
- **环境攻坚(sm_120 Blackwell)**:torch 2.7.1+cu126 无 sm_120 内核→2.13.0+cu130;custom_rasterizer 源码重建(CUDA_HOME 借 ComfyUI-hunyuan3d venv nvidia/cu13);basicsr/realesrgan 须 `--no-build-isolation --no-deps`(tb-nightly 不存在)+torchvision functional_tensor 补丁;diffusers 0.40 自定义管线须 trust_remote_code 补丁;trimesh 5.x `simplify_quadric_decimation` 首位参数变 percent 须 `face_count=` 关键字;官方 obj→glb 依赖 Blender(bpy) 静默失败→server 内 trimesh PBRMaterial 自转
- 回归:后端 2077 / 前端 546 / tsc 0;已部署 core(deploy.sh core-ts,Mac 离 LAN 走 Tailscale)

### 2026-08-24（傍晚·助手可靠性 + 3D 渲染纠偏 + 全局排版压缩）
- **助手「服务暂时不可用」根治**:前端一次性 30s 首块超时是元凶(LLM 大上下文首 token 慢于 30s 即被前端 abort);改为后端 SSE 每 10s 空闲注入 `: ping` 保活帧(生产者 task+Queue,异常暂存重抛),前端「任意字节活动续命 120s」;llm 瞬时错误日志 str→repr(httpx 部分异常 str 为空串,无法诊断)
- **3D「渲染」语义纠偏**:render 默认 out=glb——材质预设(clay/matte/metal/glossy)烘焙 PBR 回新 3D 模型,不是出图/视频;快照/旋转视频保留为可选查看产物;wireframe/normal 是纯查看模式,glb 下 422
- **全局排版**:`--page-gutter: clamp(12px,2vw,24px)` + `--section-gap: 16px` 令牌统一页面槽,卡片/网格/表单间距系统收紧约 25%,网格最小 12px;图像编辑 DropZone 大 padding 刻意保留(拖拽命中区)
- 回归:后端 2065 / 前端 543 / tsc 0;已部署 core 并生产实证(保活帧 7 连、GLB 烘焙 PBR 写入、排版截图)

### 2026-08-24（傍晚·观测面板升级集群舰队）
- **GET /api/fleet + /api/fleet/{id}**(仅 admin):fleet_registry.py 纯数据注册表(17 设备全量,源自第一节清单)+ fleet.py 并发探测(HTTP 2s/TCP 1.5s,任何 HTTP 响应含 404 即 up;ComfyUI 带 /system_stats VRAM、vLLM 带模型列表;15s 缓存单飞+延迟时序环形缓冲)
- **sysmetrics :9403**(workstation,systemd enabled):CPU/RAM/磁盘/NAS 挂载与余量/四卡 VRAM 温度;坑:systemd 空 PATH 下 nvidia-smi 须绝对路径、CSV 列数守卫
- **事实修正**:OpenTalking 实际端口 :4403(非文档旧记);core 的 PG/Redis 只 bind 127.0.0.1——探测这类本机服务 probe_host 要用回环,用 LAN IP 会误报 down
- **前端**:观测面板顶部设备舰队卡(在线点/x/y/headline)→ 点击进视图内二级页(服务清单+延迟折线+workstation 系统 Donut);charts.tsx 网格线/十字线改 CSS 变量适配浅色主题
- 回归:后端 2057 / 前端 540 / tsc 0;已部署 core 并生产截图实证(15/17 在线,pc01 关机+studio02 离线为真机态)

### 2026-08-24（午后·3D 调整服务 + 助手会话管理 + 格式预览）
- **toiv-3dops :9402**(workstation,systemd enabled):trimesh+pyrender(PYOPENGL_PLATFORM=egl 真机可用);6 材质预设(clay/matte/metal/glossy/wireframe/normal)×3 灯光×3 背景,快照 PNG/turntable MP4 + GLB 材质改写(染色/金属度/粗糙度,trimesh 写回 PBR);坑:EGL 下 glPolygonMode 线框不生效(改手工 LINES 图元+quadric 简化)、normal 顶点色须 material=None
- **core /api/3d/ops**:GLB 经签名 URL 取回上传 3dops,产物落 core 存储建 Job(threed_render/threed_material,libraryQuery 已归 3D 桶),文件端点带 Range;助手新工具 adjust_3d(自然语言→材质/渲染,自动选最近 GLB 作业);纹理绘画(真贴图)未做——需 Hunyuan3D 2.1 纹理管线或 Kijai wrapper 编译,助手系统提示已要求如实说明
- **格式预览**:@google/model-viewer 4.3.1(async chunk 不进主包)封装 ui/ModelViewer;lib/mediaKind.ts 扩展名优先统一识别;灯箱/助手/图生3D 结果卡三处内联 3D 查看器;网格卡 GLB 走图标占位+3D 角标
- **助手弹窗会话管理**:输入框左侧时钟按钮开抽屉(新建/切换/删除二次确认,复用页形态同一 renderConvList,零复制);Esc 分层(overlay capture 让位给抽屉)
- **环绕序列文件夹+OrbitViewer**:batch_id 分组(Job.params 快照+列表透出,不加 DB 列);libraryQuery.groupLibraryEntries 折叠 ≥2 成员为文件夹卡,下钻成员网格;OrbitViewer 32px/帧拖拽+自动播放,reduced-motion 默认停
- 回归:后端 2047 / 前端 533 / tsc 0;全部已部署 core 并生产截图/链路实证

### 2026-08-24（深夜·AI 助手深度接管 P1:异步工具+提案确认门）
- **异步作业模型**(结构性修复):旧生成工具同步阻塞 200-400s(H3 单段 15min 必炸)且够不着专用实例;新 `tools_gen.py` 四工具——submit_generation(21 引擎全覆盖,直接委托路由端点函数零复制,held/tracker/资源预检全继承,R18 按引擎逐条门控)、check_jobs(用户隔离)、optimize_prompt(复用 routes/optimize 单一事实源)、propose_plan(提案卡)
- **提案-确认门**:SSE 新增顶层事件 tool/job/proposal(命名事件,data 无 type 字段,前端按 event 名分流);POST /api/agent/chat/resume(approve/modify/reject,404/409/422);AgentSession.pending_proposal 列(_SQLITE_MIGRATIONS 幂等补列);⚠️ resume 重建历史只带 user/assistant 原文,对决消息内嵌方案要点回顾
- **前端 AssistantView**:tool 小条(同 id upsert)/job 卡(8s 轮询 fetchJobsPage 按 id 过滤,done 自动渲染媒体;⚠️ 不能用 SWR 缓存的 listJobs 轮询会读陈旧快照)/提案卡三按钮(resume 流豁免零内容失败规则)
- **生产实证两金链**:①中文→优化→submit→job 卡→签名产物(旧 generate_image 工具 400 翻车,助手用新工具链自救成功——旧工具 bug 留待治理:agent_workflow 作业 done 但 results 空)②大需求→提案卡→modify 带意见→重新提案
- **已知 LLM 行为瑕疵**(下轮治):推理过程英文泄漏进 text 流;长对话里题材漂移(都市悬疑→自创新题材),需系统提示强调忠实用户题材
- 回归:后端 2026 / 前端 472 / tsc 0;已部署 core

### 2026-08-24（深夜·提示词优化全功能覆盖）
- **方案定论**:全走既有 /api/optimize(L1=spark02 Qwen3.8-27B,英文产出已在 system prompt 强制),按模型族/引擎切「方言」;不新建 LLM 通路
- **新增三条方言**:qwen_edit(编辑指令:保留约束/引号文字/禁画质词,与 image_edit 的 SD 重绘方言分流)、wan-animate-2(纯外观 caption 严禁动作词)、scope(内容+氛围严禁运镜词)
- **前端补口**:ImageEditView 智能编辑/3D相机附加指令、AvatarGenPanel 正向提示词接 OptimizeButton;⚠️ 反向修正:AudioView 台词文本、DubView 情绪提示上误接的优化按钮已摘除(朗读文本/情绪描述是要直送引擎的内容,优化=损毁;TTS 类输入永不接优化)
- **边界记录**:AnimaticView 故事方向(给 VLM 拆镜的中文叙事)刻意不接;drama/studio 有独立 optimize-shot 体系不动
- llm_display_name 修正 Qwen3.8-27B-Uncensored;回归 2009+462 绿,已部署 core 并真机验证三方言

### 2026-08-24（深夜·五模型集成批量上线:Hunyuan3D 修复/Wan-Animate-2/SCoPE/Z-Image base/i2L）
- **Hunyuan3D 图生3D 修复上线**:threed.py 从未 spawn_tracker(作业永远 queued)+ /api/images 缺 .glb content-type(model/gltf-binary)+ capabilities 上传 kind=hunyuan3d 落空集——三处修复;前端图像编辑第 7 工具「图生3D(Hunyuan3D)」(步数/octree/seed,GLB 结果卡+下载);真机实证 :8193 出 ToIV_3d_00001_.glb;⚠️ 原生 2.0 只有几何无纹理,要纹理上 2.1 all-in-one(未装)
- **Wan-Animate-2 上线(v1 不动)**:🚨 Wan-AI 官方 safetensors ComfyUI 加载不了(嵌套键+无 metadata),必须用 **Comfy-Org 转换版**(NAS wan2.2-animate-2-14b/wan_animate_2/comfyui/,int8_convrot 16.6G 默认);新专用实例 **:8199 GPU3**(ComfyUI 0.33.0 原生 WanAnimate2ToVideo/WanAnimate2Cache,systemd comfyui-animate2 **enabled**);引擎 wan-animate-2(蒸馏 10 步 cfg1,自动外观 caption 走 VLM,显存预检阈值定 30G 别设 34——GPU3 驱逐缓存后实测只有 33.7G);⚠️ NAS toiv 的 umt5 fp8 是 kijai 键名 CLIPLoader 不认,要用 Windows 库 umt5_xxl_fp8_e4m3fn_scaled;真机+hold 放行+core 链路 e2e 全过(身份/表情迁移优秀)
- **SCoPE 视频运镜上线**(腾讯 ARC,首帧+文本+相机轨迹→81 帧视频):权重 67G 落 NAS scope/(双专家,与 Wan2.2 不复用);独立 venv(/home/merlin/scope-src/.venv,torch 必须 2.9.1+cu128,换版本改变数值输出);服务 :9401(systemd toiv-scope enabled,112 个轨迹预设=100 官方示例+12 参数化);core 端点 routes/scope.py(图经 NAS 中转);⚠️ 40 步 18 分钟,慢,UI 要管理预期
- **Z-Image 非蒸馏底座接入**:z_image_bf16(12.3G,Comfy-Org 单文件)落 NAS diffusion_models;新族 **z_image_base**(cfg4/30步/负向有效/euler+simple,与 turbo 蒸馏档分流——detect_model_family 按 turbo/lightning/distill 字样判);⚠️ routes/train.py 把族名发 trainer(:9100),新族名 trainer 不识别,用 base 训 LoRA 前需 trainer 同步
- **i2L 风格 LoRA 管线实证可用**(DiffSynth-Studio ZImage-i2L-v2,3.6G):风格图 1-8 张→一次前向→LoRA;脚本 scripts/ops/zimage_i2l_export.py(键转换内置:加 diffusion_model. 前缀+去 .default,DiffSynth 原生键 ComfyUI 不认);需 diffusers 格式基座(NAS toiv/zimage_diffusers/ 20G);demo LoRA(zimage_i2l_flatvector_smoke)ComfyUI LoraLoaderModelOnly 实证出图;⚠️ API 产品化未做(剩上传流转+常驻服务)
- **下载路径再实证**:hf-mirror 直连+aria2c -x16,50G 约 4 分钟;⚠️ aria2c 经重定向落地是 CDN 哈希文件名需按大小重命名;ModelScope resolve URL 同样可直连
- **回归**:后端 2004 passed / 前端 460 passed / tsc 0;test_probes_run_parallel_and_cached 有计时类 flaky(非本轮引入)

### 2026-08-24（晚间·IndexTTS 2.0→2.5 升级）
- **toiv-tts(:9200)升级 IndexTTS 2.5**：同仓库 git pull(经 ghfast.top,GitHub 直连不通)+`uv sync`(⚠️ 会清掉 ad-hoc 装的 fastapi/uvicorn/python-multipart/soundfile,须补 `uv pip install`;`--all-extras` 会因 flash-attn 需 CUDA_HOME 失败,accel 不需要,用默认 extras)
- **权重布局**:2.5 落 `checkpoints/`(gpt.pth 3.26G/s2mel.pth 415M/codec.pth 607M/多语种 tiktoken/config.yaml,ModelScope 直连+sha256 全核对),2.0 挪 `checkpoints_2/` 硬链接保留可回滚;feat1/feat2/wav2vec2bert_stats/qwen0.6bemo4-merge/hf_cache 辅助模型复用(sha256 与 ModelScope 一致)
- **wrapper 接口适配**:infer_v2_5/use_bf16/use_qwen_emo;infer 新增必选 `lang`(请求 language 字段规范化 ZH/EN/JA/ES/AR,缺省按文本启发式)与可选 `duration_factor`(0.5-2.0 语速);对 core 的 HTTP 契约不变
- **🚨 行为变更**:`TOIV_TTS_ENABLE_EMO_TEXT` 默认 false→**true**(2.5 已修 2.0 的 Qwen3 情感推理卡死问题;生产实证 emo_text 经 QwenEmotion 出情感向量 happy=0.95);回退设环境变量 false 即可
- **验证**:加载 11.9s(bf16);中文 6.19s/情感 3.23s/英文 4.75s(多语种新能力)/dur1.5 慢速 5.03s;core 生产链路 /api/manju/voice 带 emo_text 全通
- **备份**:旧 wrapper `~/toiv_tts_server.py.pre25.bak`;仓库 `deploy/tts-service/indextts_server.py` 已同步为 2.5 版

### 2026-08-24（晚间·模型目录治理+底模选择器简介）
- **底模选择器人话化**：底模下拉命中模型百科 curated 卡片后 label 变「人话名 · 文件名」并附 desc 一句话简介(ParamField 选中项下方展示);新增/修复 14 张卡(qwen_image 族三件套最长前缀分流、flux-2-klein/flux1-dev/DreamShaper/novaAnimeXL/animagine/autismmix/pornmaster/prefectIllustrious/waiREALCN,修 waiSHUFFLENOOB 下划线不匹配)
- **🚨 剔除清单漂移事故根治**:routes/models.py 与 engine_registry.py 各自维护 _NON_IMAGE_CKPT_HINTS 已漂移——08-23 审计剔除的 10eros/SUPIR/krea2/ltx/sulphur 仍混在生成页底模下拉;唯一事实源收编为 `model_profiles.NON_IMAGE_CKPT_HINTS` + `is_image_ckpt()`,两处共用,新增剔除项只改那里
- **编辑专用 DiT 剔出生成下拉**:qwen_image_edit_2509/2511 是纯编辑模型(无参考图文生图必败),从 txt2img/img2img 底模下拉剔除(`_EDIT_ONLY_UNET_HINTS`),编辑走 qwen-image-edit 引擎不受影响
- **elie-xl-nvwls-v1 实为角色 LoRA**:safetensors 头实证(architecture=lora,触发词 elie macdowell,碧之轨迹角色,作者 NVWLS),误放 NAS checkpoints/ 已归位 loras/;SFW 下拉 11→8 全实证可出图,NSFW 16 全卡片覆盖
- **回归**:后端 1957 passed(新增 6 例:卡片前缀/选择器富化/编辑 DiT 剔除/非图像剔除)/ 前端 456 / tsc 0;已部署 core

### 2026-08-24（凌晨·3D 相机 360° + 两处 UX 修复）
- **真·360° 相机上线(对标 ModelScope AMD 工作室)**：底层是 **Qwen-Image-Edit-2511 + fal Multiple-Angles-LoRA**(96 机位=8 方位×4 俯仰×3 距离,3DGS 渲染训练,触发词 `<sks> {azimuth} {elevation} {distance}`)+ 2511-Lightning-4 步加速;权重全落 NAS(2511 fp8mixed 20G 走 hf-mirror 直连 aria2c 67MB/s)。端点复用 /api/generate/qwen-edit(新增 azimuth/elevation/distance,与 legacy camera 互斥,422 校验);前端图像编辑第 6 工具「3D 相机(360°)」:方位罗盘 8 键+俯仰 4 档+距离 3 档+附加指令+**360° 环绕序列**(8 方位逐个生成,胶片条逐张落地、点击切主图、可 abort)。真机+生产 e2e:180° 背面完美、315° 高机位特写优秀。⚠️ 2511 倾向重绘背景(「保持纯白背景」附加指令只能部分约束);2509 路径不动
- **导航「观测」×7 bug 根治**:page.tsx admin 分支 `islandItems.push()` 突变了模块级常量 ISLAND_ITEMS(非 R18 分支同一引用),每次渲染追加一次→改复制后追加+源码断言防回归
- **上传点接作品库(二次创作)**：图像编辑 DropZone 加「从作品库选择」+avatar-talk 人像/音频双入口(AssetPicker 转运句柄直接灌,钉住对方 worker 防跨机);blob: revoke 守卫防误清签名 URL
- **回归**:后端 1950 passed / 前端 456 passed / tsc 0;已部署 core

### 2026-08-24（凌晨·Qwen-Image-Edit 上 pc02 + 评测体系首秀）- **pc02(5090)复活+专用实例**:OS 在线但 ComfyUI/Tailscale 停 → `schtasks /run StartComfyUI` 拉起 :8193(LB 池);新建 :8194 专用编辑实例(bat+计划任务 StartComfyUIEdit,onstart,W 交互态)。pc01 仍关机待用户开机。⚠️ pc02 Tailscale 服务 1068 依赖失败未修,core 走 LAN 不受影响
- **Qwen-Image-Edit-2509 全链路上线**:权重 fp8(19G)+多角度 LoRA(226M)+Lightning 8步加速 LoRA(850M)落 NAS;端点 POST /api/generate/qwen-edit(源图服务端转存 :8194,resolve_worker 精确匹配防错配);前端图像编辑第 5 工具「智能编辑(Qwen)」:指令+10 相机角度+快速/标准档;引擎注册 qwen-image-edit(SFW 12/R18 20 条)
- **生产 e2e 实证**:相机左旋转 45° 出片完美(卡通男孩侧脸,白底保持);语义编辑(竹→红枫/赛博朋克/加帽子)全部生效
- **大文件下载新路径(重要)**：HF 经 Mac Clash 代理大文件会被压到 144KB/s;**hf-mirror.com 从 workstation 直连**(不走代理)+ aria2c -x16 实测 67MB/s,20G 文件 5 分钟。aria2 稀疏文件表观大小≠真实进度,看日志 DL 行
- **评测体系首秀+评分器教训**：12 例矩阵(2 主体×语义 2+相机 4)经生产 API 生成;**molmo2-8B 当评委被实证不可信**(没变化的旋转打 10 分、有效编辑打 0 分,幻觉严重);人工目检为 ground truth:char 主体全项 9-10 分,ink 风景旋转/俯视全败(IF 2)。规模化评分器候选:studio04 72B caption(:9303 只有 /reverse 自定义端点)+spark02 文本评审两段式,未接线
- **优化结论(诚实记录)**:风景场景相机旋转是 LoRA 数据分布硬限制——strength 1.3/标准档 20 步/cfg 3.5/英文指令四组对照全部无效,非管线 bug;前端相机下拉已加适用范围提示。人物/物品主体的旋转/俯视/特写全部优秀
- **回归**:后端 1944 passed / 前端 450 passed / tsc 0;test_engine_plugins 计数断言随新引擎 11→12/19→20

### 2026-08-23（午后·自主循环第二波,全部已部署 core 并生产验证）
- **H3 矩阵收敛落地**：`TOIV_H3_NSFW_UNET`(默认 10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot.safetensors)接入 submit_h3_job 收口,NSFW 场景默认 10Eros-Max,SFW 不动;生产 2 条 R18 回归 done(h264+aac),本地同图直提验证 unet 确为 10Eros-Max;矩阵正式「H3 主力+Wan2.2 兜底」
- **生成观测面板**：GET /api/observability(仅 admin,10s 缓存单飞,单实例 2s 超时降级)——队列分桶/24h 成功率/held 原因/四卡 VRAM(ComfyUI /system_stats 聚合,GPU 拓扑写死带注释);前端 ObservabilityView(admin 专属,12s 轮询)。生产实测四卡在线,24h 成功率 86.5%。⚠️ PC01/PC02 从 core 不可达(000,机器离线非 bug)
- **B 评测管线**：best-of-n(EvalBatch/EvalScore 两表,job_ids 存 Job.id 非 prompt_id——hold 换名不丢);评分器抽象 HeuristicScorer(ffprobe 实测,维度探测不到跳过不打 0)+VLMScorer(OpenAI 兼容,TOIV_EVAL_VLM_BASE_URL 配置化,失败降级启发式标 degraded,绝不静默出假分);端点 POST /api/eval/best-of-n/h3 + GET /api/eval/batches[/{id}]。watcher 是进程内任务,api 重启 generating 批次由 `bestof.reconcile_interrupted()`(挂 lifespan)自动重挂,已补)
- **E 数据飞轮**：偏好对导出(DPO JSONL:chosen/rejected/score_gap/scorer/nsfw),阈值 TOIV_PREF_PAIR_MIN_GAP=0.15,degraded/error/空产物排除,nsfw 分文件,EvalDatasetExport 表幂等;finalize 自动导出(TOIV_PREF_EXPORT_AUTO)+手动 POST /api/eval/dataset/export + GET stats;默认目录 data/preference_dataset
- **C 音频编排层**：POST /api/audio/orchestrate(steps 判别联合:tts 多角色 voices 映射/separate 复用 demucs 白名单防 SSRF/concat 走 ffmpeg,core 已有 /usr/bin/ffmpeg;mix/sfx/variant 501 占位不造假),产物建 Job(kind=audio_orchestrate),GET /api/audio/orch/files/{name} 带 Range;失败即中断原码上抛
- **前端工程债**：trackJob abort 接全(ImageEditView/TrainView);hydration mismatch 修两处(useState 恒值+挂载 effect 校正);ltx25 前端 11 文件零残留(QuickStartGrid 视频区 3→2 卡,H3 升首卡)
- **回归基线**：后端 1927 passed / 前端 445 passed / tsc 0
- **图像底模清单审计(2026-08-23 傍晚)**：/api/models 图像列表是 worker object_info 实时枚举,混入非生成模型;按 safetensors 头实证剔除三个——sulphur(LTX-2 系视频 DiT,8411 键含音视交叉注意力)、SUPIR(修复模型,非生成底模)、krea2TurboFP8(Krea-2 Turbo 是纯 DiT 432 键无 TE/VAE,CheckpointLoaderSimple 加载不了,待按 flux2 图模式接线后再开放);SFW 列表 12→9 全实证可出图。顺带修正 core `TOIV_DEFAULT_CKPT` 残留旧值(DreamShaper→flux2_dev_fp8mixed,对齐 roadmap A 拍板)。NSFW 列表 16 个全 SDXL/SD15 架构抽验无误(cyberrealistic_v120/waiREALCN 实为 SDXL 2515 键,族标 sdxl_anime 系架构标签非内容标签,不误导)

### 2026-08-23（晚间·H3 LoRA 训练管线上线）
- **musubi-tuner 不支持 H3**：上游 kohya-ss/musubi-tuner 无 MiniMax 架构(issue #1017 仍 open);H3 原生 LoRA 训练改走 **ostris/ai-toolkit 的 `minimax_h3` 扩展**(2026-08-03 入库,arch=`minimax_h3`,T2V/I2V 均可训)
- **管线落位(workstation)**：`/home/merlin/ai-toolkit`(venv `.venv`,torch 2.13.0+cu130);权重直读 NAS `toiv/comfyui-models/h3`(MODELS_PATH 指过去即可,DiT int8/TE nvfp4/VAE 全在);tokenizer 小文件已进 HF cache(MiniMaxAI/MiniMax-H3)
- **仓库脚本**：`scripts/h3/h3_lora_dataset.py`(core EvalScore winner→媒体+caption 目录,纯 HTTP API)+`scripts/h3/h3_lora_train.example.yaml`(保守默认:rank16/lr1e-4/adamw8bit)+`scripts/h3/h3_lora_smoke.sh`(冒烟 runner)
- **冒烟实证(GPU2,30 步/25s)**：产出 516 张量 rank16 LoRA(310MB),已留档 NAS `h3/loras/toiv_h3_smoke_v1_30steps.safetensors`(md5 校验一致)
- **⚠️ 两个坑**：①H3 视频 VAE 帧网格是 **17n+5**(合法值 5/22/39/56),num_frames 填其他值会被静默裁短;②训练环境**别设 HF_HUB_OFFLINE=1**——AutoTokenizer 会探子目录不存在的 config.json,离线时缓存缺失直接 OSError,用 `HF_ENDPOINT=https://hf-mirror.com` 让小文件 404 正常回落(大权重全本地不会触发下载)
- **依赖**：uv pip 装 git+ 依赖会被 ghfast.top 重定向回 github 失败——先手动 clone 再改 requirements 指本地路径(/home/merlin/diffusers-hf)

### 2026-08-23（凌晨）
- **spark02 无审查模型替换**：Qwen3.8-27B-NVFP4 → **Qwen3.8-27B-Uncensored-FP8**(OrcaRouter abliterated,同架构拒答方向移除;别名保留,core .env 零改动;360s 就绪;成人写作请求直接产出验证通过;旧模型在盘可回滚;L1-L4+AI 助手全链路即时生效)
- **内容限制管控上线→同日下线**：三档策略上线后,用户拍板该板块自行重做 → 全量移除(nsfw_ctx 回退 HEAD/ContentPolicy 表/双端点/设置页卡/12 测试,零残留);未成年硬阻断保留
- **作品库回收站上线**：保留期 10min→72h(UNDO_TTL);trash/restore/permanent 三端点+trash_purge_loop 兜底清理(此前「过期物理删除」只有注释,本次补齐实现);LibraryTrashView 前端
- **助手唤起 ⌘K→Shift+Enter + 灯带重设计**：根治灯带首开隐形存量 bug(CSS keyframes 驱动注册自定义属性被 Chromium 丢帧 → 改 JS rAF 内联驱动);assistant.css 转主包 eager;新双层 conic 极光带+玻璃拟态弹窗
- **画布 Tailscale 化**：CanvasView 默认 100.68.100.90:8188+LAN 回退;标题/副标题移除
- **文档治理**：仓库收敛为 AGENTS/README/STATE/TEST_LOG 四文件;docs/ 18 篇+CLOSEOUT/设备说明清除;代码内 16 处失效文档引用清理
- **🚨 ltx25 复活→已根治**：退役时未 disable,BIOS 重启后自动拉回;08-23 凌晨经调研拍板(Civitai/HF 生态实证 LTX2.5 生态空白、定位被 H3 覆盖)执行 `disable --now`,GPU3 释放 36G、RAM available 54→90G;模型文件留盘(HF gated:auto 难再下)
- **自主循环工程(用户授权完全自主)**：①前端 P0/P1 四项修复(avatar-talk 断链接入+生产 e2e 成片/trackJob abort 卡死/TTS 产物建档 voice.py/AssetPicker 分页去重) ②资源预算预检上线(services/resource_budget.py,RAM+VRAM 双预检接入 H3/Wan/LongCat,生产实证拦截 LongCat 23.7<26G 错峰) ③10Eros-Max H3 嫁接版实测:R18+音画直出完好(H3 正式具备 R18 能力,矩阵可向「H3 主力+Wan2.2 兜底」演进;模型在 NAS h3/diffusion_models) ④roadmap A 闭环:次世代三族 GPU 冒烟+API e2e 全过,修 qwen_image 编码器目录名命不中静默降级 bug(→qwen3vl_4b_fp8_scaled);1934+431 测试全绿,已部署 core
- **模型资产新增(NAS toiv/comfyui-models)**:10Eros-Max H3 三件套(fl2va/ref2va/TURBO,~58G)、Sulphur-2 dev fp8mixed(29G,LTX2.3 系 t2v 补强)+distill LoRA、Sulphur 无审查提示词增强器 GGUF(sulphur_prompt_enhancer/);下载脚本 /home/merlin/toiv_model_pull.py(经 TS 代理)
- **资源预算二期:hold 排队上线(2026-08-23)**：预检(RAM/VRAM)不足不再直接 503,作业置 `held` 入库(Job.hold_reason + HeldJob 票:graph/原因/所需资源快照,api 重启不丢),`services/hold_queue.hold_scheduler_loop` 周期复查,资源够按票 created_at **严格 FIFO** 自动放行(换真实 prompt_id→queued→挂 tracker;队首不够即停不插队,单轮上限防雪崩);超 `TOIV_HOLD_TIMEOUT_SEC`(默认 3600s)标 error;软删除(回收站)即取消 held。配置:`TOIV_HOLD_QUEUE_ENABLED/CHECK_INTERVAL_SEC(30)/RELEASE_MAX_PER_ROUND(2)/TIMEOUT_SEC(3600)`。接入点:h3.submit_h3_job、longcat.submit_longcat_job(含 wan 路由 hold_exc)。下游等待方(wait_for_jobs/_wait_files/超分链/SSE)均按 job.id 跟随放行后的 prompt_id 换名。⚠️ held 作业的 SSE 不连 WS,推 `held` 事件;H3VideoGenerator(生成器抽象层)未接 hold,仍返回错峰错误串

### 2026-08-22（晚间）
- **R2 视频样本全量交付**：时长矩阵(5/15/30/60s)×赛道(动漫/真人/3D)×音画直出×参考链(i2v/VACE/Avatar/Animate/LongCat 续写)×R18 系列×真人专项(打斗/微表情/对白)全部完成并挂 1080p 超分
- **studio 视频合成断链修复(P0)**：VideoRenderer 产物落盘 Studio 目录(video 模式自上线首次可合成);短剧《深夜便利店》视频版成片 53.4s
- **作品库 R18 分类治理**：误标降级 43 条/真 R18 保持 33/22 条 error 空产物清理
- **散热**：用户进 BIOS 调满机箱风扇曲线+NVML 锁扇值守常驻;GPU2 负载态 92→70°C

### 2026-08-21（凌晨）
- **引擎矩阵拍板**：R18=Wan2.2+LTX2.3;LTX2.5 由 MiniMax H3 全面替代(质量优先);studio 视频链默认引擎 ltx→h3(修断链)
- **RAM OOM 根治**：ltx25 停机(当时)+H3 MemoryMax=160G+tracker 排队误杀修复

---

## 八、待办事项

- [x] **ltx25 处置(✅ 2026-08-23 已根治)**：`systemctl disable --now comfyui-ltx25` 已执行(inactive+disabled),GPU3 释放 36G、RAM 54→90G;模型文件留盘可回滚;注册表条目移除专项 ✅ 同日完成(engine_registry 双条目/probe、services+ltx25.py、routes+ltx25_studio.py、workflows+ltx25_video.py 删除,capabilities/config/deps/main/duration/optimize/model_wiki/community_recipes/harness profile/drama_studio 同步清理;LtxVideoGenerator 仅余 R18 链路,SFW 返回退役提示;测试 1811 全绿,test_duration.py 由并行 agent 处理)
- [x] ~~ImageEditView trackJob 泄漏~~(✅ 2026-08-23 abort 已接,TrainView trackTrainJob 同类隐患同修;顺带修 resetSource 复活已重置 proc 的连带 bug)
- [x] ~~test_duration flaky~~(✅ 2026-08-23 根治:根因是 gather 进程级全局 _post_tasks 被跨事件循环残留任务牵连→改前后差集精确等待;5 连跑全绿。ltx25 段同步删除,74→64 例)
- [ ] 项目负责人推送 DRT 到 core（备份在 workstation /var/tmp）
- [ ] Cloud SSH banner 超时排查（HTTPS 正常）
- [x] ToIV 迁移 core(✅ deploy.sh 持续部署,唯一生产点)
- [x] 域名双入口(✅ toiv.dgmt.top 香港 + toiv.wineryz.top 北京)
- [x] spark02 无审查模型替换(✅ 2026-08-23,别名兼容零改动)
- [x] core 配 `TOIV_CIVITAI_API_KEY`(✅ 已配置,secret 禁止提交)
