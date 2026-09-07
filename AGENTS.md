# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-08（ToIV 开发：生图池 Comfy FE 齐套 **1.52.7** — WS/pc01/pc02/LB:8188；哈希去重 soft-hide**243**/kept85/del0，市场 2163→**1920**，rh-acc 949→**706**；渐变假封面 UX **114→0**；H3 未动；三项用户决策均完成；~~pc01 待升 1.52.7~~ SUPERSEDED；~~1.45.x 分裂~~ SUPERSEDED for gen-pool FE）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」
> **历史归档**：2026-08-21~09-03 全部变更叙事（含回归数据/生产实证细节）见 `.archive/AGENTS-full-20260903.md`，本文件只留活口径

---

## 〇、🔒 硬性规则（每次会话必读）

### 规则一：所有后端服务都来源于 Workstation

> 所有 AI/算力后端服务（ComfyUI/LB、H3、LongCat、Animate2 等生图/视频主路，以及历史上的 IndexTTS2.5、ASR、Embedding、LiveAct、FlashTalk、OpenTalking、JoyCaption 等）来源均在 Workstation(192.168.71.127 / 100.68.100.90)上（**2026-09-07 起数字人/口播等非生图非视频常驻已停 disable，现网保留见第三节**）。
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
| ~~studio01-04~~ | **2026-08-29 全线下线退役**（EXO :52415 全超时，fleet_registry 已移除；L2/L3 LLM 收拢 spark02） | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | Mac Studio M3 Ultra 512GB | dgmt-studio01-04 |
| openclaw01-04 | OpenClaw 网关 :18789 均 200（2026-08-28） | .86/.75/.81/.85 | **100.115.23.67** / 100.76.35.7 / 100.76.140.121 / **100.125.217.11**（01/04 以 TS 2026-08-27 为准，旧 100.69.0.4 / 100.91.128.30 作废） | Mac mini M4 16GB (hw.model=Mac16,10) | dgmt-openclaw01-04 |
| spark01 | Flash-Next/qwen38sg TP2 集群 **已停 Exited**；**:8000 不再提供 LLM API**（2026-09-07）。勿再写双机入口。旧 Qwen3-VL-32B/molmo2/Flash-Next 栈已下线。**LIVE Embedding**：Qwen3-Embedding-4B @ :9302（GPU）；core `TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；用户级 systemd Linger=no。 | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | **现网 LLM/VLM API** `vllm_node` @ :8000 — Qwen3.8-27B-NVFP4，served `qwen3.8-27b`（别名 `qwen3.6-uncensored`），max_model_len 32768；设备冒烟 ~15.4 tok/s、core 路径冒烟 ~27 tok/s；MemAvailable ~2.7Gi（Embedding 已迁 spark01，不再压本机 free）。LiveKit 栈仍在（drt-livekit/egress/redis:6380）。双机 qwen38sg Flash-Next **已停 Exited**。 | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | **192.168.71.116**(08-25 DHCP 漂移,MAC 指纹实证) | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | ComfyUI worker :8193 + 编辑实例 :8194；**TS≠LAN**：LAN 均 200（08-28），⚠️ Tailscale 08-27 离线 21d | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 小米路由器 | BE10000 Pro,**AP/有线中继模式**(08-26 切换),管理页 192.168.71.42 | 192.168.71.42 | — | — | — |
| 光猫 | 主网关/拨号(MAC 7c:c9:26:ef:01:93) | 192.168.71.1 | — | — | — |
| cloud | 香港网关/frps/OpenResty | 43.119.32.180 | 100.83.78.114 | Linux | root |
| core | **ToIV 生产服务器**(web :3100 + api :8090 + PG + Redis)；:8100/:3501 未监听（AIGCPannel 在 MateBook Colima :8080/:8100） | 192.168.71.47 | **100.77.80.100** | Ubuntu | merlin |
| beijing | **CN 入口** toiv.wineryz.top（OpenResty+ACME）；hostname `iZ2ze325an97cwlbt1wxfdZ`；Docker `1Panel-openresty` + `1Panel-frps`（frps 0.68.1）听 7000/7500/13100/18090，另有 `1panel-core` :1722；1.6Gi RAM 无 swap；40G 盘约用 15% | 8.140.222.24 | — | Ubuntu 24.04.4 LTS（阿里云） | root |
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

> 显存数字为快照,**动态变化,容量规划前必须重新 `nvidia-smi`**(H-2)。RAM 总量 183G:多引擎并跑前必须 `free -h` 查 available(H-3)。

| GPU | 服务 | 端口 | systemd |
|-----|------|------|---------|
| GPU0 | **现网常驻** ComfyUI gpu0-alt(cache-lru 8) / LongCat(cache-lru 3) ；~~JoyCaption / IndexTTS2 / CosyVoice2 / hy3dtex~~ 等非生图非视频常驻已停 disable（2026-09-07） | :8196 / :8197 （停用端口见近期变更） | comfyui-gpu0-alt / comfyui-longcat（joycaption/tts/hy3dtex 等已停） |
| GPU1 | ~~LiveAct / embedding / 超分 / Hunyuan3D~~ 等非生图非视频常驻已停 disable（2026-09-07）；现网无生图视频常驻 | — | units disabled |
| GPU2 | **现网常驻 MiniMax H3**（UUID 钉卡）；~~ASR/音频/InfiniteTalk/Fish S2~~ 等已停 disable（2026-09-07） | :8195 | toiv-comfyui-h3 |
| GPU3 | **现网常驻 Wan-Animate-2**；~~FlashTalk / OpenTalking / 超分 / i2L~~ 等已停 disable（2026-09-07）；LTX-2.5 仍退役 | :8199 | comfyui-wan-animate-2（Wan-Animate-2 :8199） |

**ComfyUI-LB 后端**（3 后端）：本地 **:8196**(GPU0,`comfyui-gpu0-alt` 已转正;:8189 退役,见 H-7) + pc01 :8188 + pc02 :8193。GPU1/2/3 不入 LB 池（专用实例 :8197/:8195/:8199/:8201/:8261-8263 均专用;每新增同机专用实例必须补 `deps.resolve_worker()` 精确匹配,见 E-1）。

**2026-09-07 现网保留集合**：H3:8195 / gpu0-alt:8196 / LB:8188 / longcat:8197 / animate2:8199。空闲约 G0 94G / G1 97G / G2 57G / G3 95G（设备管家核对；停服后 GPU0/1/3 ≈ empty 94–97G，G2 仍挂 H3 故 ~57G free）。

**🔒 池后端变更操作口径(2026-09-03 起,动态化已上线)**：改 ComfyUI 池后端**只编辑 workstation `/opt/comfyui-lb/backends.json`**——LB 每 5s 查 mtime 热重载(零重启、不丢 prompt_map),`GET :8188/admin/backends` 返回清单+健康;ToIV api 池按 `TOIV_COMFY_WORKERS_REGISTRY_URL`(core env 已配)60s TTL 自动跟随(回环地址自动改写到注册表主机);`TOIV_COMFY_WORKERS` env 静态列表仅作 LB 挂掉时的兜底。**禁止再直接改 core env 切池成员、禁止改 LB 源码切后端**(源码内置列表仅为文件缺失时的兜底)。AIGCPannel local_gateway 上传扇出同样惰性拉取 /admin/backends。

**超分 fleet**：:8261/:8262/:8263 三卡并行 4x-UltraSharp 帧超分,由融合超分链/`scripts/ops/video_4k_upscale_parallel.py` 调用。

**关键服务路径**：ComfyUI=/opt/ComfyUI(venv) · IndexTTS2=/home/merlin/index-tts · H3 实例=/home/merlin/ComfyUI-h3-eval（09-03 ComfyUI 0.34.0 git a87667f，含 #15439 MiniMaxH3AddGuide；ImageToVideo/ReferenceToVideo 仍在；INT8/Turbo 未重下） · LongCat=/home/merlin/ComfyUI-longcat · LTX2.5=/home/merlin/ComfyUI-ltx25 · JoyCaption=/opt/toiv-joycaption(transformers 直跑,勿用 vLLM) · pynvml 锁扇用 /opt/nemotron-venv/bin/python · hy3dtex=/home/merlin/toiv-hy3dtex(torch 2.13+cu130) · Hunyuan3D=/home/merlin/ComfyUI-hunyuan3d

**散热政策(2026-08-16 用户拍板)**：🔒 **无软件温度熔断**——GPU 自降频即保护,生产禁止以温度为由中止任务;锁扇(fan_guard.py 常驻 /tmp,⚠️ tmpfs 重启即清须重传)是吞吐优化;仅持续 ≥95°C 才人工介入。BIOS 机箱风扇已满速(08-23)。

---

## 四、NAS 模型路径

| 路径 | 内容 | 大小 |
|------|------|------|
| `NAS/Windows/ComfyUI/ComfyUIModel/models` | 主模型库(workstation /opt/ComfyUI/models 指向此处的 symlink) | 524GB+ |
| `NAS/toiv/comfyui-models` | ToIV 专用模型 | ~260GB |

PC01/02 的 `extra_model_paths.yaml` 指向 `Z:/Windows/ComfyUI/ComfyUIModel`（**不得含 custom_nodes 键**,会启动报错）。

**H3 Ref2VA 权重（2026-09-07 MateBook NAS 核实）**：
- bf16 LIVE：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`（66280487368 bytes ≈62GiB；MateBook `/Users/wangzhenyu/NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`；workstation 通常 `/home/merlin/nas_mount/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`）
- 同目录 INT8 已有：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_pruned_int8_convrot.safetensors`
- **仍缺**：`minimax_h3_ref2va_pruned_bf16`（勿把 NAS/#recycle 未完成 aria2 副本当 live）
- 设备管家：已完整落盘；H3 无需为下载重启

---

**模型/内容下载来源清单（稳定路径；2026-09-08）**：
- 仓内正式清单：`docs/MODEL_SOURCES.md`（人读）+ `docs/MODEL_SOURCES.json`（机读）。**根目录五件套不变**，勿在仓库根新增 `MODEL_SOURCES*`。
- 用途：每次模型/内容下载维护带来源的条目（HF / Civitai / RH / 本地），供更新核对与查文档。
- 维护：ToIV 模型下载；项目管家五件套只引用本路径。WIP 草稿放 `.regen_tmp/`，就绪再落入 `docs/`。
- **不**替代 `engine_registry` / `model_wiki` / admin knowledge-graph / `model_profiles`；清单指向 NAS 落盘路径 + 出处 URL。
- STATE `model_sources_inventory_convention_2026_09_08` → `model_sources_inventory_2026_09_08`：**ok 239 / blocked 120 / total 359**（updated `2026-09-08T04:59:25+08:00`）；清单已落入 docs。

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 systemd 常驻,`deploy/deploy.sh` 部署;PostgreSQL 18 / Redis 真机运行（仅 bind 127.0.0.1，探测用回环地址）。
- **域名双入口**：toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(**beijing CN 入口** OpenResty+ACME；Docker `1Panel-openresty` + `1Panel-frps` 0.68.1 听 7000/7500/13100/18090，另有 `1panel-core` :1722);openresty → frp 本地 127.0.0.1:18090/13100。
- **引擎矩阵(08-28 对照仓拍板)**：SFW 视频主路 **H3=海螺 3.0**（不是 Hailuo 2.3）;R18=Wan2.2+LTX-2.3+10Eros;Wan2.1-VACE 仅编辑/转场;LTX-2.5 已退役;图像默认 FLUX.2+Qwen-Image/Z-Image;混元视频/SkyReels 未挂。⚠️ 2026-09-07 现网 LLM/VLM 已切 spark02 Qwen3.8-27B（旧 spark01 Flash-Next/qwen38sg TP2 **已停 Exited**；勿再写双机入口）。
- **LLM/VLM（2026-09-07 LIVE：设备侧+core 均已切 spark02）**：`TOIV_LLM_*` / VLM 等均指向 spark02 `http://192.168.71.84:8000`（`/v1`），model `qwen3.8-27b`（别名 `qwen3.6-uncensored`）；容器 `vllm_node`，权重 Qwen3.8-27B-NVFP4，max_model_len 32768。设备冒烟 ~15.4 tok/s；core 路径冒烟 ~27 tok/s；toiv-api 已重启，LAN health 200；备份 `.env.bak-qwen27b-20260907`。MemAvailable ~2.7Gi（Embedding 已迁 spark01，不再压本机 free）。双机 qwen38sg Flash-Next 已停 Exited；spark01 :8000 不再提供该 API。历史：此前 VLM model_id 曾写 `qwen3-vl-32b` / 后 core env 改 `qwen3.8-flash-next`；旧 spark01 :8000 / flash-next 栈已不可用。
- **Embedding（2026-09-07 LIVE @ spark01 :9302）**：Qwen3-Embedding-4B（GPU）@ `192.168.71.82:9302`；core `TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；toiv-api 已重启；备份 `.env.bak-embed-20260907`；用户级 systemd Linger=no。设备管家确认 LIVE（cuda）；**现网 Embedding 非 workstation :9302**。此前「下一步 Embedding→spark01 intent」**已完成**。
- **视频评分器灰度**：`TOIV_VIDEO_SCORER_ENABLED=true`(阈值 0.65,timeout 120s);⚠️ 迁移 DDL BOOLEAN 默认值必须 TRUE/FALSE,PG 不认 DEFAULT 0。
- **web_search 代理**：`TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`(MateBook Clash;依赖 Mac 在线,离线自动降级)。
- **workstation 常驻 ToIV 服务**：trainer :9100 / lipsync :9103 / 3dops :9402 / scope :9401 / sysmetrics :9403 等仍在清单；**2026-09-07 数字人/口播及一批非生图非视频常驻已停 disable**（FlashTalk / OpenTalking / LiveAct / FishS2 / JoyCaption 等 inactive，含 joycaption :9304 / liveact :9400 / embedding :9302 / hy3dtex :9404 / i2l :9101 等）。WS embedding :9302 已于 09-07 停；**现网 Embedding 已迁 spark01 :9302**（非 WS）。现网生图/视频保留见第三节（H3/gpu0-alt/LB/longcat/animate2）。勿再声称 joycaption/liveact 仍常驻。
- **数字人 M1–M6 已上线**（形象库/TTS 直通/ASR→SRT/LatentSync 对口型/直播助手/绿幕抠像）;**音频编排** tts/separate/concat/mix/variant 可用,sfx 仍 501(选型 MOSS-SoundEffect v2.0)。
- **内容限制管控已下线零残留**(08-23 用户拍板自行重做;未成年硬阻断+X-NSFW 头语义保留)。
- **trainer 五坑**(08-27 四连败实证,细节见归档):①YAML device 恒 cuda:0 ②GPU2 训练前先 `POST :8195/free` ③training_folder 每作业独立 ④产物双嵌套目录 ⑤可选参数全量默认值。

---

## 六、⚠️ 易错点（按主题归并,保留教训精华）

### H. 硬件/容量类

- **H-1 禁止臆造硬件数据**：任何硬件配置/容量问题必须先 SSH 真机确认（曾臆造 Mac Studio 内存翻车）。
- **H-2 显存数字是快照不是真理**：容量规划/共卡部署必须现场 `nvidia-smi`;vLLM 默认 `--gpu-memory-utilization 0.9`,共卡必须显式调低。
- **H-3 多引擎并跑先算 RAM**：183G 曾被多引擎同驻耗尽致 OOM 杀 H3;上架大 RAM 模型前 `free -h`;H3 已加 `MemoryMax=160G`。
- **H-4 「DB 标 error」≠「生成失败」**：批量失败先查 ComfyUI `/history/{pid}`,产物在就回写,禁止盲目重提浪费 GPU(排队≠丢失,tracker 已修)。
- **H-5 温度政策**：无软件熔断(见第三节);风扇曲线懒惰时锁扇 100% 是提速手段。
- **H-6 CUDA_VISIBLE_DEVICES 数字索引≠nvidia-smi 索引(09-03 实证)**：GPU0("requires reset")不进 CUDA 数字枚举,数字序号偏移(CVD=1→物理 GPU2,CVD=2→物理 GPU3)。🔒 新服务锁卡一律用 **GPU UUID**(`Environment=CUDA_VISIBLE_DEVICES=GPU-xxxx`),起服后 `nvidia-smi --query-compute-apps=pid,gpu_uuid` 复核。toiv-comfyui-h3 已用 drop-in gpu-pin.conf 钉 GPU-0e6e9149…(物理 GPU2)。**GPU0 reset 仍未修(独立事项)**。
- **H-7 comfyui-gpu0 :8189 已退役（2026-09-06 收口）**：占用者查明=unit 内僵尸进程 3233 的失控线程（R 态,SIGKILL 无效,与 GPU0 requires reset 同源,只能重启清）;unit 已 `disable`（防重启复活/双开）。**:8196 gpu0-alt 转正为正式本地池后端**（enabled,backends.json/core env 均是 8196）。8189 端口与 GPU0 枚举恢复都挂 workstation 重启窗口（见待办）。AIGCPannel 侧 `start-aigcpannel.py` 与文档漂移已在 09-03~06 修正（:8196）,其 `.env` 旧 COMFYUI_LB_BACKEND_URLS 已注释停用。

### D. 退役/迁移记录类

- **D-1 stop≠disable,重启会复活**(08-23 ltx25 实证)：退役服务必须 `systemctl disable`(或 mask);「已迁移/已停用」记录跨项目冲突时必须真机复核。
- **D-2 一次性手工迁移没有守护会静默失效**：生产依赖变更后必须实测业务链路,不能只看服务 active。

### N. 网络/代理类

- **N-1 跨境链路波动会污染 A/B 结论**：A/B 必须同时段交替测;「502/超时」先排除全局链路事件;frpc 加 `loginFailExit=false`。
- **N-2 HF/外网下载**：core/workstation 直连 HF/civitai 超时;**hf-mirror.com 从 workstation 直连 + aria2c -x16 实测 67MB/s 是主路**(aria2 稀疏文件看日志 DL 行;重定向落地哈希文件名按大小改名;ModelScope resolve URL 同可);Mac Clash(192.168.71.9:7897 / TS 100.74.15.34:7897)为备。**依赖 Mac 在线,大模型下载提前规划**。
- **N-3 Tailscale 跨地区访问**：浏览器侧 TS 优先;workstation 服务须监听 0.0.0.0 才经 TS 可达。
- **N-4 Windows 长命令经 SSH 会被换行截断**：写远端文件用 PowerShell `-EncodedCommand`;`schtasks /change` 非交互挂起,用 `/create /f` 覆盖重建。

### W. Windows 类

- **W-1 SSH session 隔离**：SSH 里 net use 盘符桌面看不到、Start-Process 启的进程断连即被杀;长期服务用计划任务+bat(pc01 InteractiveToken)。
- **W-2 SYSTEM 计划任务看不到用户盘符映射**：ps1 开头在任务自己 session 里 `net use Z:` 重挂;模型可见性最终裁判是 ComfyUI 进程的 object_info,SSH 里 `dir Z:` 是假阴性。

### E. 引擎/工作流类

- **E-1 新专用 ComfyUI 实例必须补 `deps.resolve_worker()` 精确匹配**：否则同机实例被 hostname 回退错配,作业成功但产物 502。InfiniteTalk :8201 已补(09-03 `3446b75`,已部署 core)。
- **E-2 LongCat 链路坑**：TI2V i2v 用 WanVideoEncode→extra_latents;Avatar v1.5 音频必须 whisper-large-v3;WanVideoWrapper 必须 `rope_function="comfy"`。
- **E-3 引擎探测通过≠链路可跑**：新引擎必须真机 e2e 后交付(LTX 音画链实证)。
- **E-4 vLLM 坑**：NVML mismatch 炸平台探测(补丁 /home/merlin/patch_vllm_nvml.py);跑不了 LLaVA 架构 JoyCaption(用 transformers);vllm-node 镜像缺 vllm[audio];**served-model-name 别名机制——换模型保别名=core 零改动**。
- **E-5 mlx-vlm(studio04)视频只认本地路径**（该依赖已退役,此坑只在回滚 studio04 时复活:恢复 .env 两行+重启）。
- **E-6 超分竖屏源必须显式 --target-w/--target-h**,生产一律 `--keep-frames`(默认删帧无法续跑)。
- **E-7 回写协程生命周期不得超过 tracker 作业生命周期**(08-29 三视图卡死实证)：worker 停机可超 2h,一次性等待必死;所有「等待作业完成再落库」的后台任务按**多轮等待+启动 reconcile** 双保险写。

### P. 平台机制类

- **P-1 产物 URL 已签名+归属校验**：测试构造产物 URL 必须带 sig 或先建档;<img>/<video> 走 `?token=` 认证。
- **P-2 Next.js 生产构建必须 `rm -rf .next` 干净重建;deploy.sh 只 rsync 不重建**——部署前必须确认本地 .next BUILD_ID 是当次新构建,验证前端变更必须截图/查 BUILD_ID,不能只看 API。
- **P-2b styled-jsx 作用域坑**：多组件文件一律 `<style jsx global>`+前缀命名;UI 改动必须真机截图验证。
- **P-3 浏览器自动化测 React**：原生事件不触发合成事件(select 用 native setter+dispatchEvent);多 textarea 用 `.promptbar-textarea` 精确定位。
- **P-4 命令行自杀坑**：`pkill -f` 模式串用 `[f]an_guard` 式转义;torchrun 须连父进程一起杀;/tmp 是 tmpfs(大文件写 /var/tmp)。
- **P-5 并行 SSH 会话会互相改写状态(高优)**：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源再处置。**当前实况:AIGCPannel 项目会话也在操作 workstation(见 H-7/七),动服务前留意**。
- **P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top(uv 装 git+ 依赖会被重定向失败,先手 clone 改本地路径);core 登录返回字段是 `token`;上传 kind 必须下划线风格;H3 生成前先 free 缓存。
- **P-7 新 Python 服务环境三坑**(sm_120 Blackwell)：torch 必须 cu128+/cu130;老牌 CV 包 `--no-build-isolation --no-deps`+torchvision 补丁;**库主版本升级后旧调用约定必须逐处核对,能跑≠语义对**(trimesh/diffusers 实证)。

---

## 七、近期关键变更（只留活口径;全史见 `.archive/AGENTS-full-20260903.md`）

### 2026-09-08（ToIV 模型下载：LIVE — MODEL_SOURCES 清单已落入 docs）
- **路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（根目录无 `MODEL_SOURCES*`）。
- **计数**：ok **239** / blocked **120** / total **359**；updated `2026-09-08T04:59:25+08:00`。
- **维护**：后续每批下载追加这两份；WIP 仍可镜像 `.regen_tmp/`；NAS 短索引 `toiv/comfyui-models/SOURCES.md`。
- **口径**：URL 不发明，仅从下载日志复制；覆盖 NAS 落盘路径 + HF/Civitai/RH/本地出处。
- Status：`inventory_landed`；STATE `model_sources_inventory_2026_09_08`；`updated_at` 2026-09-08T05:00:00+08:00。

### 2026-09-08（项目管家：CONV — 模型/内容下载来源清单稳定路径）
- **用户要求**：模型/内容下载须维护带来源的清单（供更新与查文档）。ToIV 模型下载正在撰写。
- **稳定路径**：`docs/MODEL_SOURCES.md` + `docs/MODEL_SOURCES.json`（仓内；就绪后提交）。**根目录仍只留五件套**。
- **维护**：ToIV 模型下载；项目管家五件套只引用此路径。WIP → `.regen_tmp/`。
- **边界**：不替代 `engine_registry` / `model_wiki` / admin KG / `model_profiles`。
- Status：~~`convention_set_awaiting_inventory`~~ → **`inventory_landed`**（见上条）；原 STATE `model_sources_inventory_convention_2026_09_08`；`updated_at` 2026-09-08T04:56:00+08:00。本 commit 只定路径，清单正文另由下载 bot 落入 `docs/`。

### 2026-09-08（ToIV 开发：LIVE — 市场左侧空白已修上 core）
- **LIVE**：市场左侧空白已修上 core；BUILD_ID `20260907-203017-6417f2a-dirty`；产品树 dirty 无独立 SHA。
- **根因**：空 `.rh-col` 仍 flex 占宽（**非** IO/刷新问题）。
- **修复**：容器 `ResizeObserver` + 跳过空列 + 重置 placement。
- 叠在市场瀑布流无感追加之上（further of `market_waterfall_seamless_append`）。
- Status：`live_on_core_dirty`；STATE `market_left_blank_fix_2026_09_08`；`updated_at` 2026-09-08T04:32:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 表单媒体/HF/封面/presets 收口；市场≈1083）
- **表单媒体**：Animate V8 **15→16**（视频+图）；127 双输入 rh-acc gap **0**；demo 本地 **182**，defaults **127/127**。
- **功能封面**：+**15**（非 NSFW `/covers/generate`）。
- **HF**：应用侧清完（藏 `Flux-文生图-96c82d`）；模型库未动。
- **presets**：MateBook+core `rh_h3_presets.json`=`[]`；`presets_anti_resurrect=cleared_empty_array`；误种 soft-hide **959**；市场可见≈**1083**，rh-acc **837**，rh-h3/minimax listed **0**。
- **SFW/R18**：9 dual-mode parents；twin soft-hide（见 `r18_merge`）。
- Status：`done`；STATE `rh_form_media_hf_covers_2026_09_08`；报告 `.regen_tmp/rh-form-media-hf-covers-20260908.md`（勿提交）；`updated_at` 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。勿 stage product/`.regen_tmp`/`rh_h3_presets.json`。

### 2026-09-08（ToIV 开发：LIVE — SFW/NSFW 合并已上 core dirty partial）
- **LIVE**：SFW/NSFW 合并已上 core dirty（partial）；BUILD_ID `20260907-195752-2a1c833-dirty`；**9** 对合并；封面双标（SFW+NSFW）；应用内切换；twin soft-hide。
- **残留**：LTX / wan-nsfw 等未并。
- **watch / presets**：MateBook+core 已 `[]`；`presets_anti_resurrect=cleared_empty_array`；误种 soft-hide **959**（**勿 stage** 产品文件 / `.regen_tmp` / `rh_h3_presets.json`）。
- Status：`live_on_core_dirty_partial`；STATE `r18_merge_into_sfw_2026_09_08`；features={dual_tags, in_app_toggle, twin_soft_hide}；merged_pairs=9；residual=[ltx_nsfw, wan_nsfw,…]；watch=`presets_anti_resurrect_cleared_empty_array`；presets_anti_resurrect=`cleared_empty_array`；soft_hide_mistaken_reseed=959；`updated_at` 2026-09-08T04:04:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 家族模板 wipe1166 + 准确重入131 COMPLETE；rh-acc≈837）
- **Wipe**：删 **1166** 家族模板克隆（`rh-h3` / `rh-minimax*`）；Postgres DELETE（admin API 对 builtin 403）；**防复活**已清空 `apps/api/app/data/rh_h3_presets.json`（bak 保留；路径仅记文档，**勿提交**）。
- **准确重入**：+**131**；跳过 **360**（`detail_code_901`×289 + `null_workflowId`×71）；错误 **0**；直播 rh-acc ≈ **837**；抽检 **12/12**。
- **KEEP**：原 rh-acc + 产品 h3-* builtins；家族克隆 **0**。
- **新 131 表单 repair**：updated **91** / unchanged **40** / with_select **83**。
- Status：`wipe_reseed_done`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:21:00+08:00。产品树 dirty 未 commit 产品码；远程未推。

### 2026-09-08（ToIV 开发：LIVE — 封面效果对齐完成；修35；剩18待真出图）
- **封面效果对齐**：rh-acc **全 RH CDN**；修 **35**（5 rh-acc mp4→still CDN + 30 builtin 上传 RH 图）；剩约 **18** 无 RH 映射 builtin 待真出图（**禁** NSFW `/covers/generate` 渐变）。
- 可见 apps ≈ **811**；rh-acc 期间 sibling reseed **706→763**；市场家族 `rh-h3` 克隆当前 **0**；家族 wipe/reseed **已完成**（见上条 wipe1166+重入131；rh-acc≈837）。
- Status：`done_18_pending_real_art`；STATE `cover_effect_align_2026_09_08`；报告 `.regen_tmp/cover-effect-align-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:12:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — RH 表单封面保真调研完成；拍板 wipe→准确重入库；~~执行中~~ → COMPLETE 见上条）
- **rh-acc 保真修复**：扫描 **706**；修 **168** / 已齐 **529** / skip `code_901` **9** / errors **0**；封面多为 RH CDN（**706/706**）；封面改写仅 **2**。LIST→select 修复；去 graph fallback 多余字段。
- **真正错位主因**：约 **1166** 家族模板克隆（`rh-h3` / `rh-minimax*`，无 `webappId`，本地海报封面）——非 rh-acc 丢 UI 元数据。
- **用户拍板（~~执行中~~ → COMPLETE）**：wipe 家族 `rh-h3` / `rh-minimax*` 模板克隆 → 按 RH 准确图+原表单重入库；**保留** `rh-acc` 与产品 builtin。**已完成**：删 **1166** / 重入 **131** / 跳过 **360** / rh-acc≈**837** / 抽检 **12/12** / 家族克隆 **0**（详见上条 wipe+reseed LIVE）。
- 仍待后续：非 ASCII binding / 缺导出节点 / 图槽 demo / `code_901`。
- Status：~~`decided_executing`~~ → **`wipe_reseed_done`**；decision=`wipe_family_clones_accurate_reseed`；keep=`rh-acc + product builtins`；STATE `rh_form_cover_fidelity_2026_09_08` + `rh_family_wipe_accurate_reseed_2026_09_08`；报告 `.regen_tmp/rh-form-cover-fidelity-20260908.md` / `.regen_tmp/rh-family-wipe-accurate-reseed-20260908.md`（勿提交）；`updated_at` 2026-09-08T03:21:00+08:00。


### 2026-09-08（ToIV 开发：生图池 Comfy FE 齐套 1.52.7 + 去重/封面三项完成）
- **生图池 Comfy FE 齐套**：WS / pc01 / pc02 / LB:8188 均为 frontend **1.52.7**；`fe_gate=met`；`fe_homogenized=true`；`homogenize_pending=false`。**H3 未动**。~~pc01=1.49.6→1.52.7 进行中~~ **SUPERSEDED**。~~WS 1.45.20 / pc02 1.45.21 / pc01 1.49.6~~ **SUPERSEDED**（gen-pool FE versions）。
- **同图哈希去重（执行完）**：85 组；kept **85**；soft-hide **243**；deleted **0**；市场可见 **2163→1920**；rh-acc **949→706**。日志 `.regen_tmp/dedupe-hash-20260908.json`（勿提交）。
- **渐变假封面（执行完）**：用户可见 **114→0**。日志 `.regen_tmp/gradient-cover-fix-20260908.json`（勿提交）。
- Status：`fe_homogenized_dedupe_covers_done`（三项用户决策均完成）；STATE `rh_comfy_covers_dupes_audit_2026_09_08`；`updated_at` 2026-09-08T02:21:00+08:00。

### 2026-09-08（ToIV 开发：用户已拍板三项；~~执行中 / fe_partial~~ → 见上条齐套结果）
- 用户已拍板（via ToIV 开发）：① Comfy LB FE **≥1.49.6** 统一；② 同图哈希去重（type-hash / same-image hash）；③ 渐变假封面全量重生。
- ~~Status：执行中 / fe_partial_dedupe_covers_done（pc01 同版进行中）~~ **SUPERSEDED by** 上条 `fe_homogenized_dedupe_covers_done`。原 `updated_at` 2026-09-08T02:15:00+08:00 / 02:16:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — RH Comfy版本分裂+封面UX+重复调研；等用户拍板）
- **打开失败主因（调研时）**：Comfy LB FE 版本分裂 — ~~WS **1.45.20** / pc02 **1.45.21** / pc01 **1.49.6**~~ **SUPERSEDED for gen-pool FE**（现 WS/pc01/pc02/LB:8188=**1.52.7** 齐套；~~pc01=1.49.6~~ SUPERSEDED）；userdata 正确；load abort 后残留旧图；rh-acc Subgraph **0%**（当时 0/949）。FireRed：banner 新名、canvas 留 Z-Image。
- **RH 效果主路径**：打开应用 runner（`app_run`）；开工作流需 FE≥1.49.6 或钉 canvas 到 pc01。`toiv_workflow_query` **现已在** WS/pc01/pc02 `/extensions` 列出（先前「待重启」可能已过时）。
- **封面**：DB empty=**0**；UX 渐变=抽象 cover 文件（~68 R18 rh-h3 `appcover-7ae2fc…`）；已给 **7** 个 H3 R18 builtin 盖 SFW 海报；CDN rh-acc **949** OK。
- **重复**：name-stem **60组/236**；type-hash **85组/328**。等用户拍板：去重规则 / FE 统一或钉 pc01 / R18 家族封面 regen。
- STATE `rh_comfy_covers_dupes_audit_2026_09_08`（+ 滚动 `open_workflow_comfy145_query_2026_09_08` / `cover_gen_coverless_2026_09_08`）；报告 `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — Comfy 打开工作流加固；WS LIVE；扩展已列出）
- 加固：`toiv_workflow_query` 等 canvas/graph ready、backoff `getCanvas:null`、禁误 `app.clean()`（改 `graph.clear`）、postMessage `toiv-load-workflow`、afterConfigureGraph retry；CanvasView parent→iframe postMessage after load（+800ms/+2500ms）；保留 userdata `?workflow=`。
- WS `/opt/ComfyUI/custom_nodes/toiv_workflow_query/` LIVE（8196 + LB :8188）；web BUILD `20260907-174430-c309d02-dirty`（chunk 含 toiv-load-workflow）；probe open-in-comfy `h3-nsfw-t2v` OK。
- **更新**：`toiv_workflow_query` 现已在 WS/pc01/pc02 `/extensions` 列出（先前「待重启」可能已过时）。打开失败主因已滚动为 **Comfy LB FE 版本分裂**（见上条调研）。status=`hardened_live_version_skew_blocker`。
- STATE `open_workflow_comfy145_query_2026_09_08` + `comfy_load_harden_covers_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — worker `_pick_app_client` 扩 H3/LongCat/Wan*）
- `_pick_app_client` 扩 H3/LongCat/Wan*；503 列缺模型/节点；API 已上 core（`live_on_core`）。
- STATE `worker_pick_app_client_expand_2026_09_08`；`updated_at` 2026-09-08T01:20:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — 市场 prune 付费云端专用 −263）
- 付费云端专用删 **263**；保留可本地化；市场 **2426→2163**。
- STATE `market_prune_paid_cloud_2026_09_08`；`updated_at` 2026-09-08T01:20:00+08:00。

### 2026-09-08（ToIV 开发：LIVE — 封面 coverless/gap_pending→0；UX 真理已滚动）
- coverless/gap_pending → **0**（清 68 坏本地封面文件后 regenerate）；local apps **1214**；CDN **949** 故意保留；bad_files **0**。
- **UX 真理**：DB empty=0 正确；用户可见「无封面」= CSS 分类渐变 **或** 抽象紫/红渐变图当 `cover_url`（~68 R18 rh-h3 `appcover-7ae2fc…`）；已给 **7** H3 R18 builtin 盖 SFW 海报。
- STATE `cover_gen_coverless_2026_09_08` + `comfy_load_harden_covers_2026_09_08` + `rh_comfy_covers_dupes_audit_2026_09_08`；报告 `.regen_tmp/fix-comfy-load-covers-20260908.md` / `.regen_tmp/rh-comfy-covers-dupes-audit-20260908.md`（勿提交）；`updated_at` 2026-09-08T02:10:00+08:00。

### 2026-09-07（ToIV 开发：LIVE — 市场瀑布流无感追加已上 core；进一步片→左侧空白已修）
- 市场瀑布流无感追加已上 core LAN（真机）；BUILD_ID `20260907-164531-9ec0144-dirty`；产品树 dirty 无独立 SHA。
- 去掉 CSS `column-count`；`.rh-grid` → N 列 `.rh-col`；placement Map 保列位；续载只往最短列底追加；resize 才整表重分。
- 叠在市场小步续载 / 无限滚动 / 市场 UX / UI P4 瀑布流之上（further of market_small_step_load）。
- STATE `market_waterfall_seamless_append_2026_09_07`：`status=live_on_core_dirty`，`updated_at` 2026-09-07T16:45:31+08:00；further → `market_left_blank_fix_2026_09_08`。
- **进一步片**：市场左侧空白已修（见上条 2026-09-08；BUILD `20260907-203017-6417f2a-dirty`；空 `.rh-col` flex 占宽 → ResizeObserver + 跳过空列 + 重置 placement）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库第二轮扩种 SCALE2 累计1212）
- **准确 RH 第二轮扩种完成（Phase C）**：本轮新种 **500**；累计 `rh-acc-*` = **1212**（RH id 去重；scale2 前约 700，中途 aborted partial ~12 → baseline 712 before this +500）。
- **累计跳过 1048**（`null_workflowId` 1047 + `export_code_810` 1）；**累计 create 错误 0**（先前 2 个 `create_422` 已重试成功：webapps 1976578710449033218、2042457691490099202）。
- **抽检 12/12**：节点 + 封面 + RH id 一致。已处理 webappId **2260**；池未耗尽（catalog 8747，约 6487 未处理，多数会跳过）。
- **脚本加固**：POST 前丢掉非 ASCII binding leaf（对齐 Core `_BINDING_FIELD_RE`）。无新 BUILD（HTTP 种库）。无模板克隆。
- **族累计**：other **375** / flux **231** / ltx **210** / qwen **205** / wan **197** / h3 **7**。
- STATE `rh_accurate_reseed_scale2_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：`new_seeded=500`，`cumulative_seeded=1212`，`cumulative_skipped=1048`，`cumulative_errors=0`，`prior_create_422_recovered=true`，`spot_check=12/12`，`processed=2260`，`remaining_unprocessed≈6487`，`pool_exhausted=false`，`binding_harden=drop_non_ascii_leaves`，`build_id=null`，`no_template=true`，`status=reseed_scale2_done_pool_remaining`；`updated_at` 2026-09-07T20:55:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-scale2-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库扩种完成 累计700）
- **准确 RH 扩种完成（Phase C）**：本轮新种 **500**；累计 `rh-acc-*` = **700**（RH id 去重 700）。
- **累计跳过 752**（皆 `null_workflowId`）；**累计 create 错误 2**（`create_422`；bindings 非 `inputs.*`/`widgets_values.*`）。
- **抽检 12/12**：节点 + 封面 + RH id 一致。无新 BUILD（HTTP 种库）。无模板克隆。
- **族累计**：other **224** / flux **135** / ltx **118** / qwen **115** / wan **110** / h3 **6**；processed ids **1454**。
- ToIV **仍在扫可导出库存**——勿标全量 reseed done。`no_template_reseed=true`。
- STATE `rh_accurate_reseed_scale_2026_09_07` + `rh_clone_purge_reimport_2026_09_07`：`new_seeded=500`，`cumulative_seeded=700`，`cumulative_skipped=752`，`cumulative_errors=2`，`spot_check=12/12`，`build_id=null`，`no_template=true`，`status=reseed_scale_done_scanning_more`；`updated_at` 2026-09-07T20:20:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-scale-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 准确重入库第一批完成 200）
- **准确 RH 重入库第一批完成**：种入 **200**（无模板克隆；exported Comfy API graph）；跳过 **294**（null_workflowId/未开放）；错误 **0**。
- **族分布**：flux **50** / qwen **42** / ltx **36** / wan **32** / h3 **6** / other **39**。
- **抽检 8/8**：节点 + 封面 + RH id 一致；ids prefix `rh-acc-*`。
- **无新 BUILD**（HTTP 种库；API 码未改）。`no_template_reseed=true`。更多批次仍 **pending**——勿标全量 reseed done。
- STATE `rh_clone_purge_reimport_2026_09_07` + `rh_accurate_reseed_batch1_2026_09_07`：`reseed_pilot_batch1=done`，`seeded=200`，`skipped=294`，`errors=0`，`spot_check=8/8`，`build_id=null`，`no_template=true`，`status=reseed_batch1_done_more_pending`；`updated_at` 2026-09-07T20:00:00+08:00；报告 `.regen_tmp/rh-accurate-reseed-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — 10Eros 模型出处补全 64/64）
- **模型出处**覆盖 **62/64 → 64/64（100%）**；flagged apps **10 → 0**。
- wiki + `engine_registry` 已写 civitai/HF：H3 `10Eros_Max_h3_TURBO_ref2va_beta2_int8_convrot`（HF cicalooo/10Eros-Max-h3-int8-convrot + Civitai 2851079）；LTX `10eros_v14`（civitai.red 2447875 + HF TenStrip/LTX2.3-10Eros）。
- 顺带：`hunyuan_video` wiki family HF；`flux1-dev` `huggingface_url` → FLUX.1-dev。Curated wiki cards **43**（was 40）。
- BUILD_ID 仍 `20260907-103808-6e94327-dirty`（本轮主要改 api；API restarted；health OK）。
- 准确重入库 **PILOT 仍进行中**——**勿标 reseed done**；`no_template_reseed=true`。
- STATE `model_provenance_10eros_2026_09_07`；`rh_clone_purge_reimport_2026_09_07` provenance→**64/64**；`updated_at` 2026-09-07T19:50:00+08:00；报告 `.regen_tmp/10eros-provenance-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 真工作流导出已打通；准确重入库 PILOT 进行中）
- **Export METHOD FOUND**：`POST /api/webapp/detail` → `workflowId`；`POST /api/openapi/getJsonApiFormat`（apiKey+Bearer）→ `data.prompt` = Comfy API JSON。
- **Verified samples**：Flux2-klein **17** nodes、H3 Lip Sync **22**、H3 T2AV **33** 等（3+）。
- **Limits**：`workflowState=0` 或 author ACL → fail（1913 / WORKFLOW_NOT_EXISTS）；勿模板伪造。
- Prior BLOCKER `TOKEN_MISSION` / wrong path → **SUPERSEDED** for apps with `workflowId`+`workflowState=1`。
- **Wipe 已完成**（rh-*=0；累计≈8611；删数已报）。准确重入库为 **PILOT in progress**（非全量）；`reseed_started=true`；**reseed_count TBD 勿发明**。
- 完成后报告：reseed count、skip-reason stats、spot-check results、BUILD_ID if deployed。未部署，**无 BUILD_ID**。`no_template_reseed=true`。
- STATE `rh_clone_purge_reimport_2026_09_07`：`status=reseed_in_progress_export_ok`，export_method as above，prior_blocker superseded，`reseed_started=true`，`reseed_pilot=true`，`reseed_count=null`，`build_id=null`，`deployed=false`；报告 `.regen_tmp/rh-graph-export-path-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：LIVE — RH 清库完成 rh-*=0；重入库被 RH 导出挡住）
- **LIVE wipe**：`rh-*` 已清 **0**；本轮删除 **3392**（API 1149 + SQL 2243）；相对 wipe_before 累计约 **8611**。admin API 对 is_builtin `rh-*` 403，故用 core Postgres SQL 清剩余。
- **保留应用 48**（47 builtins + `Flux-文生图-96c82d`）；未删产品内置。
- **模型出处**覆盖 **96.9%（62/64）**；未证主因：`10Eros_Max_h3_*` / `10eros_v14`（约 10 个 H3/LTX NSFW 应用）；另曾标 hunyuan_video I2V + flux1-dev-fp8（pulid，family HF 后纳入覆盖）。
- **准确 RH 重入库 0**；**BLOCKER**：RH 无可用工作流图导出（detail 仅元数据；export 403 `TOKEN_MISSION`）。未部署，**无 BUILD_ID**。`no_template_reseed=true` 仍有效——**勿声称重入库已完成**。
- STATE `rh_clone_purge_reimport_2026_09_07`：`status=wipe_done_reseed_blocked`，`rh_remaining=0`，`deleted_this_run=3392`，`cumulative≈8611`，`retained_apps=48`，`model_provenance=62/64`，`reseed=0`，`blocker=RH_workflow_export_TOKEN_MISSION`，`build_id=null`，`deployed=false`；报告 `.regen_tmp/rh-wipe-resume-20260907.md` / `builtin-provenance-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：PROGRESS / IN PROGRESS — RH 清库进度：rh-* 约剩 3392，已续删）
- 清库中途 executor 基础设施 unauthenticated 中断；当前 core 约剩 `rh-*` **≈3392**（原先近万已删大半）；admin token 仍可用。
- 已重启续删 + 内置/模型出处审计；**禁止模板重种**（`no_template_reseed=true`）。
- 仍 `in_progress_on_core` / not done；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。
- STATE `rh_clone_purge_reimport_2026_09_07`：`rh_star_remaining≈3392`，`interrupted_unauthenticated` then resumed。
- **勿写已完成**；**勿发明精确已删数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：SCOPE UPGRADE / IN PROGRESS — RH 清库重入库口径升级：含内置 + 全量严格出处）
- 用户 ADDENDUM：内置应用也要动（~~内置保留~~ → **SUPERSEDED**）；所有内容与所有模型来源必须可核对（HF / Civitai / RH / 本地）；口径升级为全量严格出处。
- 仍 `in_progress` / not done；完成后报告：删除数、重入库数、内置变更、模型出处覆盖、BUILD_ID。
- STATE `rh_clone_purge_reimport_2026_09_07`：`builtin_also=true`，`strict_provenance_all_sources=[HF,Civitai,RH,local]`，`status=in_progress_on_core`。
- **勿写已完成**；**勿发明已删/重入库数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：INTENT / IN PROGRESS — RH 错挂克隆清库 + 准确重入库；历史口径 ~~内置保留~~ SUPERSEDED）
- 用户下令：删掉所有错挂 RH 克隆卡并重新准确入库；封面/名称/工作流必须一致，不许再模板克隆；~~内置应用保留~~（已作废，见上条 SCOPE UPGRADE）。
- 先前 `rh-*` 家族模板种子正在清库，以便按 RH 真工作流准确导入；ToIV 已在 core 开始清 `rh-*` 并研究导入。
- Status：`in_progress` / not done；**勿写已完成**；**勿发明已删数量**；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：打开工作流导航已修已上 core）
- 打开工作流导航已修并上 core LAN（真机）；BUILD_ID `20260907-103808-6e94327-dirty`；产品树 dirty 无独立 SHA。
- 根因：`#canvas` 无效（SPA 只认 `/?view=canvas`）；API `POST /api/apps/{id}/open-in-comfy` itself was fine。
- 打开应用去掉简洁/工作流，仅 RH 运行台 +「在画布中编辑」。
- tests appsWorkflow+appsRh **37** pass；报告 `.regen_tmp/fix-open-workflow-nav-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：RH 参考图/提示词默认值已上 core）
- 打开应用参考图/提示词默认值已上 core LAN（真机）；BUILD_ID `20260907-095758-c383011-dirty`；产品树 dirty 无独立 SHA。
- UI：media `default` + 远程封面预览（提交仍要真上传）；seed `inject_rh_ref_defaults`。
- 回填 **8626** 个应用（top300 RH detail 提示词 **287/300**，其余家族默认+封面 CDN）；Errors **0**。
- 关闭此前 RH UX Tab gap「参考图/提示词默认值仍缺」。报告 `.regen_tmp/rh-ref-defaults-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：RH 图生新入库封面回填）
- RH 图生新入库封面回填完成（数据侧已上 core LAN `http://192.168.71.47:8090`）。
- 空 `cover_url` **13→0**；**6387** 保持 RH CDN；**13** 无 coverUrl 用同族 CDN+admin 上传补齐。
- 有效缺封面 **0**；scope **6400** new image RH apps；total market **8646**。
- 报告 `.regen_tmp/cover-backfill-image-rh-20260907.md`（勿提交）；无产品 SHA；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：RH UX Tab+封面 contain+管理员出处已上 core）
- RH UX Tab+封面 contain+管理员出处链接已上 core LAN（真机）；BUILD_ID `20260907-092308-9db9030-dirty`；产品树 dirty 无独立 SHA。
- 应用详情 | 我的生成 Tab；封面 object-fit contain。
- admin `rh_webapp_url` + `source_links`（引擎 HF/Civitai）；模型页 admin Civitai+HF。
- ~~仍缺参考图/提示词默认值~~ → **已关闭**（见上条 RH 参考图/提示词默认值已上 core）。

### 2026-09-07（ToIV 开发：RH 图生全量入库完成）
- RH 图生全量入库已完成（数据侧已上 core LAN `http://192.168.71.47:8090`）；认证 search 字段分页（`search` 非 `searchValue`）。
- 去重 **6511** → 分类 **6408** → 种入 core **6400**（错误 0）；base：`qwen-image-edit` 2040 / `img2img-basic` 2419 / `txt2img-basic` 1941。
- leftover 69 + video_skipped 34；already on core skipped 8；core apps ≈**9846**。
- 报告 `.regen_tmp/rh-image-ingest-20260907.md`（勿提交）；无产品 SHA；未发明集群/GPU 变更。

### 2026-09-07（ToIV 开发：应用封面回填完成）
- core 有效缺封面 **547→0**（空 `cover_url` 4→0；本地 cover 404×543 靠恢复 `/data/app-covers/` 下 **10** 个共享家族 PNG；另上传 4 张空应用封面）。
- 根因：10 共享家族封面文件缺失，543 `rh-*` 仍指向它们（疑似 admin 上传 `_remove_cover_file` 删共享 URL）。
- 未跑 GPU generate；家族仍共享封面（by design）；`expand_top` 可选后续。报告 `.regen_tmp/cover-backfill-20260907.md`（勿提交）。

### 2026-09-07（ToIV 开发：作品库选封面叠层已修已上 core）
- 作品库选封面叠层已修并上 core LAN（真机）；BUILD_ID `20260907-082025-be7d5c7-dirty`；产品树 dirty 无独立 SHA。
- 原因：sticky `.rh-params` 困住 fixed Modal；改为 portal 到 `document.body`。

### 2026-09-07（ToIV 开发：市场小步续载已上 core；进一步片→市场瀑布流无感追加）
- 市场小步续载已上 core LAN（真机）；BUILD_ID `20260907-080948-7b6f9e7-dirty`；产品树 dirty 无独立 SHA。
- 每页 10；细条 loading；rootMargin 150；新卡 fade-in。
- 叠在市场无限滚动 / 市场 UX 之上（further of market_infinite_scroll / market_ux）。进一步片见上条市场瀑布流无感追加 LIVE。

### 2026-09-07（ToIV 开发：市场无限滚动已上 core；进一步片→市场小步续载）
- 市场无限滚动已上 core LAN（真机）；BUILD_ID `20260907-075325-693aa19-dirty`；产品树 dirty 无独立 SHA。
- 去掉「显示更多」；IO sentinel 续载。
- 叠在市场 UX / UI P4 瀑布流之上（further of market_ux / ui_p4_market_waterfall）。

### 2026-09-07（ToIV 开发+设备管家：H3 Ref2VA bf16 已入库 NAS）
- bf16 LIVE：`NAS/toiv/comfyui-models/h3/diffusion_models/minimax_h3_ref2va_bf16.safetensors`（66280487368 bytes ≈62GiB；MateBook ls 核实）。
- 同目录 INT8 已有：`minimax_h3_ref2va_pruned_int8_convrot.safetensors`；**仍缺** `minimax_h3_ref2va_pruned_bf16`。
- workstation 通常同相对路径于 `/home/merlin/nas_mount/toiv/comfyui-models/...`；H3 无需为下载重启。
- 勿列 NAS/#recycle 未完成 aria2 副本为 live。

### 2026-09-07（ToIV 开发：应用详情 RH 布局已上 core）
- 应用详情 RH 布局已上 core LAN（真机）；BUILD_ID `20260907-072931-ea942fc-dirty`；产品树 dirty 无独立 SHA。
- 左封面 / 右打开应用 + 打开工作流 / 节点信息；admin 出处；封面 expand×40 已重踢。
- supersedes comfy_open_edit 中「详情页 RH 布局仍推进中」。

### 2026-09-07（ToIV 开发：Comfy 二次编辑通路已上 core）
- Comfy 二次编辑通路已上 core LAN（真机）；BUILD_ID `20260907-070508-718d466-dirty`；产品树 dirty 无独立 SHA。
- `POST /api/apps/{id}/open-in-comfy` → 画布自动加载；save-back 未做。
- 封面 expand 已重踢；详情页 RH 布局仍推进中→SUPERSEDED（见上条应用详情 RH 布局 LIVE）。
- 叠在市场 UX Comfy 导出/打开之上（further of market_ux）。

### 2026-09-07（ToIV 开发：市场 UX 已上 core LAN；进一步片→Comfy 二次编辑）
- 市场 UX 已上 core LAN（真机）；BUILD_ID `20260907-064811-db3fa3e-dirty`；产品树 dirty 无独立 SHA。
- 去分类；瀑布流 + Skeleton + 懒加载；高级引擎 → 更多引擎；封面 expand_top=40 生成中；Comfy 导出/打开已落地（完整二次编辑仍推进）。
- 进一步市场 UX 片（叠在 UI P4 市场瀑布流/详情之上）。

### 2026-09-07（ToIV 开发：UI P4 市场瀑布流/详情已上 core LAN）
- UI P4 市场瀑布流/详情已上 core LAN（真机）；BUILD_ID `20260906-231138-69957d0-dirty`；产品树 dirty 无独立 SHA；进一步片见上条市场 UX。
- 此前 UI P4 小程序主题对齐 web v9 intent（local_uncommitted_core_build_unchanged）**SUPERSEDED**→本条；小程序主题对齐仍可能在本地 dirty 树中单独未 commit。

### 2026-09-07（ToIV 开发：UI P3 封面 expand_top 已上 core LAN）
- UI P3 封面 expand_top 已上 core LAN（真机）；BUILD_ID `20260906-225725-b22d0af-dirty`；主改 api；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：UI P2 库占位已上 core LAN）
- UI P2 库占位已上 core LAN（真机）；BUILD_ID `20260906-225725-b22d0af-dirty`；ThumbPlaceholder 按类型；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：UI P1 主题对比度已上 core LAN）
- UI P1 主题对比度已上 core LAN（真机）；BUILD_ID `20260906-225049-7588708-dirty`；cinema/graphite 暗色轨对比度修复；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：provenance+KG 已上 core LAN）
- provenance 剥离 + Admin knowledge-graph 已上 core LAN（真机）；BUILD_ID `20260906-224852-921256b-dirty`；admin `GET /api/admin/knowledge-graph` 200（~1295 nodes / 608 edges；可选 `?entity=` neighborhood）；普通用户去 RH:{id}/civitai_url，管理员保留；产品树 dirty 无独立 SHA。

### 2026-09-07（ToIV 开发：市场合并首片已上 core LAN）
- 市场合并首片已上 core LAN（真机）；BUILD_ID `20260906-224447-8e33d9e-dirty`；api :8090 / web :3100 200；nsfw-recommendations 无 X-NSFW→403；资源区 R18 推荐仅 admin+R18；ModelsView Civitai|HF；产品树 dirty 无独立 SHA。

### 2026-09-07（设备管家+ToIV 开发：Embedding → spark01 :9302 LIVE）
- **设备侧 LIVE**：spark01 Qwen3-Embedding-4B @ `192.168.71.82:9302`（GPU / cuda）；用户级 systemd Linger=no。
- **core LIVE**：`TOIV_EMBED_BASE_URL=http://192.168.71.82:9302/v1`；toiv-api 已重启；备份 `.env.bak-embed-20260907`；无产品 SHA。
- **非 WS**：workstation embedding :9302 已停（09-07）；**现网 Embedding 已迁 spark01 :9302**（设备管家确认）。
- 此前「下一步 Embedding→spark01 intent」**DONE**。

### 2026-09-07（设备管家+ToIV 开发：Spark LLM/VLM 真机切 27B @ spark02；core 已切 LIVE）
- **设备侧 LIVE（SSH 核实）**：spark02 `vllm_node` @ `192.168.71.84:8000` — Qwen3.8-27B-NVFP4，served `qwen3.8-27b`（别名 `qwen3.6-uncensored`），max_model_len 32768；设备冒烟 ~15.4 tok/s；加载后 MemAvailable ~2.7Gi。
- **core LIVE**：`TOIV_LLM_*` / VLM 等 → `http://192.168.71.84:8000` + model `qwen3.8-27b`；toiv-api 已重启，LAN health 200；备份 `.env.bak-qwen27b-20260907`；core 路径冒烟 ~27 tok/s。
- **双机 qwen38sg Flash-Next 已停 Exited**（spark01/02）；spark01 :8000 **不再提供 LLM API**。勿再写双机入口。
- LiveKit 栈仍在 spark02（drt-livekit/egress/redis:6380）。
- ~~**下一步**：Embedding 放空闲 **spark01**（intent，未做）~~ → **DONE**：见上条 Embedding LIVE @ spark01 :9302。
- **SUPERSEDED**：此前「Spark 保留 Flash-Next」架构锁定、`intent_only_awaiting_cutover_plan`（0ce5aed）、以及「core 路由改中」中间态，均被本条真机+core 双切替代。

### 2026-09-07（设备管家：workstation 停服快照；ToIV 开发执行）
- 已停并 disable：数字人/口播及一批非生图非视频常驻（FlashTalk / OpenTalking / LiveAct / FishS2 / JoyCaption 等 inactive）
- 现网保留：H3:8195、生图 gpu0-alt:8196、LongCat:8197、Animate2:8199、LB:8188（pc workers 仍在池）
- 核对时空闲约：G0 94G / G1 97G / G2 57G / G3 95G（停服后 GPU0/1/3 ≈ empty 94–97G；G2 仍 H3 故 ~57G free）
- **口径更正（2026-09-07）**：ToIV 开发已停 WS 迁脑；**取消**「Flash-Next 迁 WS GPU0+3」全部计划。旧「WS GPU0+3 拟迁 Flash-Next / 切 core 后拆 spark Qwen / Spark 仅 LiveKit+空内存」作废（SUPERSEDED）。
- ~~架构意图（2026-09-07 更正）：Spark **保留** Flash-Next……~~ **SUPERSEDED by 2026-09-07 Spark LLM/VLM 真机+core 双切 27B@spark02**。日产=WS+5090 仍成立；Embedding→spark01 **DONE**（见上条 LIVE）。
- spark02 LiveKit 仍保留（现网事实，非「Flash-Next 拆走后的唯一用途」）。

### 2026-09-06（ToIV 会话：workstation 重启窗口 + spark 集群重建）

- **workstation 重启窗口完成**：GPU0 恢复 CUDA 枚举（index 0,UUID GPU-c2193dfe）,8189 卡死进程随重启清除;数字 CVD 服务落卡全部符合设计（gpu0-alt/joycaption/longcat→GPU0,四音频→GPU2,UUID 钉卡服务不动）;NAS 挂载/LB 三后端/core 全链验证,txt2img 冒烟 success。
- **spark 双机集群重建（spark01 死机物理重启后）**：①容器 `qwen38sg` 两个 /tmp bind-mount 随 reboot 丢失（tmpfs,docker 误建 root 空目录致启动失败）→ 容器重建,**挂载源改到家目录**（`/home/dgmt-spark/`）根治;②decode 崩溃链：镜像 stock `flash_fwd_sm120.py` 在 SM120 误开 TMA（上游 flash-attn #2671）+ pack_gqa 半成品（#2656/#2671）+ **head_dim=256 在 GB10 99KB smem 上 FA4 cute 不可用**（#2750 同类,tile 常数不感知 hdim）→ 处置：整包升级 **flash-attn-4 4.0.0b29**（目录级挂载 `/home/dgmt-spark/fa4pkg/flash_attn`）+ qwen_sparse_attn_backend 补丁（SM12x 且 hdim>128 的 decode 走 **SDPA 块对角 mask 路径,GPU 构图禁 host 同步**;文件在 spark01/02 家目录,无免密 sudo）。LLM 出文冒烟通过,core→spark 提示词优化链路验证通过。
- **同批收口**：6 例预存测试修复（`55c3902`,全量 3035 绿）;8189 退役/8196 转正;cloud sshd GSSAPI=no（SSH 走 TS 100.83.78.114）;DRT 包 staging 到 core。

### 2026-09-06（设备管家：beijing SSH 公钥已通）
- MateBook 已装 id_ed25519 公钥；~/.ssh/config 有 `Host beijing` → 8.140.222.24 User root IdentityFile ~/.ssh/id_ed25519；BatchMode 免密已通。密码勿写。

### 2026-09-06（设备管家：beijing 真机只读登入）
- hostname iZ2ze325an97cwlbt1wxfdZ；Ubuntu 24.04.4 LTS；1.6Gi RAM 无 swap；40G 盘约用 15%
- 角色确认：CN 入口 toiv.wineryz.top（OpenResty + ACME）
- Docker：1Panel-openresty + 1Panel-frps（frps 0.68.1）听 7000/7500/13100/18090；另有 1panel-core :1722
- SSH：当时公钥未通；现 MateBook 已装 id_ed25519 公钥，~/.ssh/config 有 `Host beijing` → 8.140.222.24 User root IdentityFile ~/.ssh/id_ed25519，BatchMode 免密已通。密码勿写。
- 未改服务；密码不入文档

### 2026-09-04

- **全站美化方向A「精修控制台」五波收官（`33c045c`/`2393957`/`79bd123`/`2988b9c`,均已部署 core,生产截图验证）**：版型令牌系统（`--layout-measure/content/wide`、节奏/栅格/媒体 AR 档）+字阶圆角旧档删除+琥珀点睛（`--accent-glow`,聚焦环/激活指示/链接 hover 三触点）+浮层 `--shadow-pop` 弹簧入场+空态三档（stage/section/inline,Fraunces 斜体+琥珀图标）+19 视图全量版型对齐;UI_STANDARD v2.0 成文。方向C（Film Atelier 复兴）demo 被否,留档 `.regen_tmp/film-atelier-demo.html`。细节见 TEST_LOG。

### 2026-09-03（本周）

- **端点统一+动态切换上线（ToIV `3446b75`+`7edabc5`,已部署 core）**：①LB（AIGCPannel 仓 `platform/deploy/comfyui-lb/comfyui-lb.py`,已部署 workstation）后端列表外置 `/opt/comfyui-lb/backends.json` mtime 热重载 + `GET /admin/backends`;②ToIV api 池 `TOIV_COMFY_WORKERS_REGISTRY_URL` 60s TTL 跟随注册表（失败沿用现状,回环地址改写到注册表主机——生产实证抓获：LB 报 127.0.0.1:8196 对 core 不可达）;③AIGCPannel 三处漂移清单收口（local_gateway 惰性拉取/start 脚本/model_library,KREA2 直连 :8189→:8196）。真机 e2e：改 JSON 加假后端 5s 内出现且 UNHEALTHY、删除即消失、零重启;txt2img 冒烟落 :8196 执行。操作口径见第三节。**⚠️ AIGCPannel 仓改动未提交**（其规则:未要求不 commit;另其 `platform/backend/.env` 含旧 `COMFYUI_LB_BACKEND_URLS` 需其会话手动改 :8196,否则 env 显式值压过动态拉取）。⚠️ ToIV 后端全量 pytest 有 **6 个预存失败**（test_agent_gen_tools/test_app_seed H3 用例,干净树复现,与本次无关,疑 09-03 应用市场批次引入,待查）。
- **操作方查明=AIGCPannel**：workstation 上的并行操作（gpu0-alt 顶班 :8196、:8195 ComfyUI 升 0.34.0、8189 反复重启）均为 **AIGCPannel 项目会话**所为（证据:`start-aigcpannel.py:112` 硬连 :8189 池、gpu0-alt unit 建于 08-31 03:21、AIGCPannel/AGENTS.md 自述 09-03 :8195 升级与其 P0–P6 短剧 H3 改造同期）。**LoRelay 无集群操作证据**（GPU 租赁产品,仅文档提及）。ToIV 侧只记录不动其服务。
- **LB 本地后端 :8189→:8196**（H-7）;core health 200;GPU 快照(MiB used/97887):0=27275/1=94125/2=38159/3=84997。
- **RunningHub H3 应用市场（ToIV 开发,已双推已上 core）**：`262bb5a`(市场+1166 社区预制 rh-* 播种)+ `133f15a`(H3 市场应用走专用 :8195 非通用池);core BUILD_ID `20260903-020621-262bb5a-dirty`。
- **Studio Console W1–W4 收官（ToIV 开发,已部署+实测）**：W3 六视图套版(92a8bba/892fa95/3a27ca7)+W4 drama 全链退役 -9329 行(4922bca)。
- **H3 GPU 钉卡**（gpu-pin.conf UUID→物理 GPU2,见 H-6;GPU0 reset 未修）。
- **:8195 ComfyUI 0.30.0→0.34.0**（含原生 MiniMaxH3AddGuide;INT8/Turbo 未重下）。
- **算力补装**：Wan2.2 Remix v3.0(NSFW I2V)入库 NAS;comfyui-infinitetalk :8201(GPU2,e2e 已冒烟,⚠️ 未补 resolve_worker 见 E-1);toiv-fishs2 :9212(Fish S2 Pro TTS,GPU2 常驻~20G,情感标记实测生效)。模型清单与坑见归档。

### 2026-08-29（三视图根治 + 体验治理,均已部署 core）

- **三视图卡死根治(e4bb0b3)**：回写协程多轮等待+api 启动 reconcile(教训=E-7);同批上线全量进度体系+任务中心+主体库重做。
- **R18 LTX t2v 路径锁(42dba0c)**：无首帧一律 422 引导 i2v;H3 标 ordinary_default,LTX/Wan R18 标 advanced 沉底;B3 多主体 entity_ids 透修。
- **七项体验治理**：studio01-04 舰队移除+L2/L3 收拢 spark02(86a94e8);导航收口+五页「‹ 返回融合」(6c69b6f);剧本拆解异步化提交制(fae48dc);14 个非 H3 视频引擎标 advanced、H3 entity_ids 上限 9(05f7703);资产双源 Tab+jobs/lookup(aefea45)。
- **任务中心中止(35b8b87)**：`POST /api/jobs/{id}/cancel`;**ltx-nsfw-t2v 标 hidden(60d6168)**。⚠️ `deploy/.env` 第 9 行裸 URL 是历史遗留,不影响运行。

### 2026-08-28~30（ToIV 开发批次,细节/推送状态以 git 与归档为准）

- UX 体验包 `eb51c86`、Job.nsfw 合同 `fb78872`(X-NSFW 只作门禁,nsfw 仅显式意图);助手可靠性三修复(a5e04ea 长会话折叠/e833f33 上下文溢出/58cf643 SSE 超时回放);LoRA 策划卡 93c275e/e1f856e、LTX 竖版 859b60f(本地批次)。
- 设备侧:OpenClaw 01-04 实锤 M4 非 M2;`TOIV_WEB_SEARCH_PROXY` 改 LAN `.9`;08-27 全设备真机复核(GPU/服务清单见归档)。

### 2026-08-21~26（底座性变更,摘要）

- **引擎矩阵拍板(08-21)**：R18=Wan2.2+LTX2.3;H3 全面替代 LTX2.5;RAM OOM 根治(MemoryMax/排队误杀修复)。
- **ltx25 退役根治(08-23)**：`disable --now` 已执行,注册表零残留;同批:hold 排队(FIFO 自动放行)、10Eros-Max H3 R18 能力、作品库回收站 72h、资源预算预检、H3 LoRA 管线(ai-toolkit minimax_h3,⚠️ 帧网格 17n+5、训练别设 HF_HUB_OFFLINE=1)。
- **08-24 大批上线**：观测面板 fleet+sysmetrics :9403、3dops :9402、助手异步工具+提案确认门、提示词优化方言体系、Wan-Animate-2 :8199(GPU3,必须 Comfy-Org 转换版权重)、SCoPE :9401、Z-Image base 族、i2L 管线、360° 相机(Qwen-Edit-2511+Multiple-Angles-LoRA)、Qwen-Image-Edit :8194(pc02)、IndexTTS 2.0→2.5(emo_text 默认 true)、模型目录治理(剔除清单唯一事实源 model_profiles)。
- **08-25**：GPU 三方换卡均衡(JoyCaption/LongCat→GPU0,四音频→GPU2);hy3dtex :9404 上线;spark01 molmo2→Qwen3-VL-32B(注:09-03 又被 qwen3.8-flash-next 取代)。
- **08-26**：小米路由器切 AP 模式根治网络孤岛(教训:「设备离线」先查二层拓扑/网关一致性)。

---

## 八、待办事项

- [x] RH 同图哈希去重完成（same_image_hash；85组 kept85 soft-hide243 del0；市场2163→1920；rh-acc949→706）— STATE `rh_comfy_covers_dupes_audit_2026_09_08`
- [x] Comfy LB FE 同版齐套 **1.52.7**（WS/pc01/pc02/LB:8188；gate met；fe_homogenized=true）— STATE `rh_comfy_covers_dupes_audit_2026_09_08`
- [x] 渐变假封面全量重生完成（用户可见 114→0）

- [x] workstation 重启窗口（09-06 完成:GPU0 枚举恢复、8189 清除、落卡全复核、全链冒烟）
- [x] spark 集群修复（09-06:spark01 死机物理重启+容器家目录挂载重建+FA4 b29+QSA hdim256 SDPA 补丁,LLM 冒烟通过）
- [ ] DRT 部署到 core（包已备妥 `/home/merlin/drt-bundle/` 六件:source-v2/images/config/pg dump/redis dump/minio data,2026-09-06 由 ToIV 会话中转;执行归 DRT 负责人,compose.prod+Caddyfile,注意 core 的 PG/Redis 是 ToIV 生产共用勿冲突）
- [ ] Cloud 公网 :22 跨境疑似 QoS（握手挂 2min 被 sshd LoginGraceTime 切断）;已修 GSSAPIAuthentication=no（TS 路径 21s→5.4s）;**SSH 一律走 Tailscale 100.83.78.114**
- [x] comfyui-gpu0 :8189（09-06 收拢:占用者=unit 内僵尸进程 3233 的失控线程,杀不掉;unit 已 **disable**（防重启复活/防重启后双开）,8189 退役,**:8196 gpu0-alt 转正为正式本地池后端**,backends.json 已是 8196 无需动;随 workstation 重启窗口一并清算）
- [x] GPU0 reset 尝试（09-06:--gpu-reset Not Supported,只能重启,并入上条重启窗口）
- [x] 6 个预存测试失败（09-06 `55c3902`:133f15a H3 走专用实例后旧打桩 miss,测试曾真实触达生产 :8195;补四处 H3 接缝 stub,全量 3035 绿）
- [x] InfiniteTalk :8201 补 `deps.resolve_worker()` 精确匹配（E-1,09-03 `3446b75` 已部署 core）
- [x] 已核销：ltx25 处置 / trackJob abort / test_duration flaky / ToIV 迁移 core / 域名双入口 / spark02 无审查替换 / `TOIV_CIVITAI_API_KEY`
