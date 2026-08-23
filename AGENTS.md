# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-08-23（凌晨·大重整:同步引擎矩阵/无审查模型/内容管控三档/Tailscale 化等近期变更;易错点 32 条主题化合并;🚨 新发现:ltx25 退役时只 stop 未 disable,BIOS 重启后自动复活）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」

---

## 〇、🔒 硬性规则（每次会话必读）

### 规则一：所有后端服务都来源于 Workstation

> 所有 AI/算力后端服务（ComfyUI/LB、IndexTTS2、ASR、Embedding、LiveAct、H3、LongCat、FlashTalk、OpenTalking、JoyCaption 等）全部运行在 Workstation(192.168.71.127 / 100.68.100.90)上。
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

## 一、集群设备清单（11 组）

| 设备 | 角色 | LAN IP | Tailscale IP | 类型 | SSH 用户 |
|---|---|---|---|---|---|
| studio01-04 | EXO RDMA 推理 :52415(实跑 MiniMax-M2.7-4bit);studio04 另跑 VLM 反推 :9303(mlx-vlm 72B,plist `com.dgmt.toiv-vlm-mlx`) | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | **Mac Studio M3 Ultra 32核 512GB** | dgmt-studio01-04 |
| openclaw01-04 | OpenClaw 网关 | .86/.75/.81/.85 | 100.69.0.4 / 100.76.35.7 / 100.76.140.121 / 100.91.128.30 | Mac mini M2 | dgmt-openclaw01-04 |
| spark01 | Molmo2-8B 音乐/图像反推 VLM(容器 molmo2_captioner, :8000) | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | LLM L1-L4 主力(**Qwen3.8-27B-Uncensored-FP8 无审查版**,2026-08-23 替换;别名 qwen3.8-27b/qwen3.6-uncensored 均有效, :8000) | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | 192.168.71.115 | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | ComfyUI worker :8193 | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| cloud | 香港网关/frps/OpenResty | 43.119.32.180 | 100.83.78.114 | Linux | root |
| core | **ToIV 生产服务器**(web :3100 + api :8090 + PG + Redis) | 192.168.71.47 | **100.77.80.100** | Ubuntu | merlin |
| beijing | 北京国内入口/frps(toiv.wineryz.top) | 8.140.222.24 | — | Linux (阿里云) | root |
| MateBook | 操作终端 | — | 100.74.15.34 | macOS | 本机 |

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
| GPU0(10.9G) | ComfyUI #1 / IndexTTS2 / CosyVoice2 | :8189 / :9200 / :9201 | 共~11G | comfyui-gpu0 / toiv-tts / (cosyvoice) |
| GPU1(69.4G) | Qwen3-Embedding-4B / LiveAct / 超分实例 | :9302 / :9400 / :8261 | ~20+59+0.75G | qwen3-embedding / toiv-liveact / comfyui-upscale-gpu1 |
| GPU2(73.0G) | **MiniMax H3(主力视频引擎)** :8195(~41G) / JoyCaption :9304(~17G) / LongCat :8197 / ASR :9210 / FireRedASR :8300 / CosyVoice3 :9202 / Qwen3-TTS :9203 / demucs :9220 / SenseVoice :9211 / 超分 :8262 | — | — | toiv-comfyui-h3 等;⚠️ 接近共卡红线,新增服务前必查 |
| GPU3(54.1G) | FlashTalk :9004(~51G) / OpenTalking / 超分 :8263 | — | — | ~~LTX-2.5 :8198~~ **已彻底退役**(2026-08-23 用户授权自主决断:`disable --now` 已执行,enabled→disabled,GPU3 释放 36G、RAM 54→90G;NVFP4 模型文件留盘可回滚) |

**ComfyUI-LB 后端**（3 后端）：本地 :8189(GPU0) + pc01 :8188 + pc02 :8193。GPU1/2/3 不入 LB 池（专用实例 :8197/:8195/:8198/:8261-8263 均为专用,不入池;每新增同机专用实例必须补 `deps.resolve_worker()` 精确匹配,见 E-3）。

**超分 fleet**：:8261/:8262/:8263 三卡并行 4x-UltraSharp 帧超分,由融合超分链/`scripts/video_4k_upscale_parallel.py` 调用。

**关键服务路径**：ComfyUI=/opt/ComfyUI(venv) · IndexTTS2=/home/merlin/index-tts · H3 实例=/home/merlin/ComfyUI-h3-eval · LongCat=/home/merlin/ComfyUI-longcat · LTX2.5=/home/merlin/ComfyUI-ltx25 · JoyCaption=/opt/toiv-joycaption(transformers 直跑,勿用 vLLM) · pynvml 锁扇用 /opt/nemotron-venv/bin/python(系统 python3 无该库)

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
| **内容限制管控**(2026-08-23) | ❌ **已下线**(同日午后用户拍板自行重做,全量移除零残留);nsfw_allowed 回退为未成年硬阻断+X-NSFW 头历史语义;生产库 contentpolicy 孤儿表可手动 DROP |
| **LLM 引擎矩阵**(2026-08-23 更新) | R18=**H3 主力(10Eros-Max 嫁接版 TURBO 为 NSFW 默认 UNET,`TOIV_H3_NSFW_UNET`)+Wan2.2 生态兜底**;SFW 视频=MiniMax H3 全面替代 LTX2.5(质量优先);spark02 已换 **Qwen3.8-27B-Uncensored-FP8**(abliterated 无审查,别名保留 core .env 零改动,旧 NVFP4 在盘可回滚) |
| web_search 出站代理 | `TOIV_WEB_SEARCH_PROXY=http://192.168.71.123:7897`(MateBook Clash);⚠️ 依赖 Mac 在线,离线时自动降级不炸链路;Tailscale 备选 100.74.15.34:7897(慢 4×) |
| 域名双入口 | toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(北京,frpc-bj);openresty proxy_pass 经 frp 本地端口 127.0.0.1:18090/13100 |

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

**N-2 HF/外网下载依赖 Mac Clash 代理(2026-08-08/23)**：core/workstation 直连 HF/civitai B2 超时;路线=Mac Clash(192.168.71.123:7897 或 TS 100.74.15.34:7897)。hf-mirror 对部分仓库 403、orcarouter 原 repo gated;chimingw 镜像仓可下(29GB FP8 实证 8MB/s)。**依赖 Mac 在线,下载大模型要提前规划**。

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

**E-5 mlx-vlm(studio04)视频只认本地路径**：视频反推走 NAS 中转(core SFTP 落 NAS,发挂载路径),图像 base64 正常;开关 `TOIV_REVERSE_VIDEO_MAC_PREFIX`。

**E-6 超分竖屏源必须显式 --target-w 2160 --target-h 3840(2026-08-15)**：默认参数会把竖屏每帧拉伸成横屏全报废;生产一律 `--keep-frames`(默认删帧无法续跑);画幅方向护栏已内建。

### P. 平台机制类

**P-1 产物 URL 已签名+归属校验(2026-08-14)**：tracker 生成的 /api/images URL 带 sig(HMAC);无 sig 旧 URL 走 Job 归属回退;admin 直通;其余 404。测试构造产物 URL 必须带 sig 或先建档。<img>/<video> 标签走 `?token=` 查询参数认证。

**P-2 Next.js 生产构建必须 rm -rf .next 干净重建(2026-08-17)**：陈旧 .next/cache 会导致 chunk 内部错位,next start 即 500(`Cannot find module './N.js'` 但文件在);deploy.sh 防呆拦不住,干净构建是唯一可靠前置。

**P-3 浏览器自动化测 React(2026-08-11)**：原生事件不触发合成事件——select 要用 native setter+dispatchEvent 派发 change;多 textarea 时 querySelector 要用 `.promptbar-textarea` 类选择器精确定位。

**P-4 命令行自杀坑**：`pkill -f` 模式串含自身 ssh 命令行会自杀(exit 255),用 `[f]an_guard` 式转义;torchrun 拉起的进程杀子会复活,须连父进程一起杀;/tmp 是 tmpfs——大文件写 /var/tmp,脚本放 /tmp 重启即清(fan_guard 已实证)。

**P-5 并行 SSH 会话会互相改写状态(2026-08-11 高优)**：多操作者(用户/多 AI 会话)同时动 workstation 时服务状态被反复改写形成拉锯;关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源(哪个 IP/会话/time),再处置。

**P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top;core 登录接口返回字段是 `token` 不是 `access_token`;上传 kind 必须下划线风格(ltx_i2v 等),连字符导致 capabilities 门控失效;H3 生成前置校验显存,调用前先 free 缓存。

---

## 七、近期关键变更（决策记录,替代操作历史）

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
- **仓库脚本**：`scripts/h3_lora_dataset.py`(core EvalScore winner→媒体+caption 目录,纯 HTTP API)+`scripts/h3_lora_train.example.yaml`(保守默认:rank16/lr1e-4/adamw8bit)+`scripts/h3_lora_smoke.sh`(冒烟 runner)
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
- [x] ~~内容限制管控三档~~(2026-08-23 上线后同日下线,用户自行重做该板块)
- [x] core 配 `TOIV_CIVITAI_API_KEY`(✅ 已配置,secret 禁止提交)
