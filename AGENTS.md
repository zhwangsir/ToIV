# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-22（**全文压缩**：第七节 09-16~09-21 详叙 39k 字移入 `.archive/AGENTS-focus-20260916-0921.md`，主文件留活口径；新增易错点 P-8 池楔死/P-9 agent 工具纪律/N-5 TS≠掉线/E-8 图字节双形态/P-2b CSS 三约束。当前状态：api 3315/web 988/e2e 11/11 全绿；应用目录 6773（公开 5061）全量 use_case 打标；whisper 四节点集群 LIVE；**下一步=四域方案批 1**（`docs/EVOLUTION_PLAN_20260922.md`+三份深度专篇：文件夹整组删除/助手 UI 重设计/Admin 重规划）。09-21 交付：漫剧线 M1-M3+A1-A3+remix 全收口、RH SCALE3 8747 全 drain 新种 4524、P0 池楔死根修、openclaw 诊断翻案。基线与方案细节见第七节）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」「🔒 硬性规则」和「八、未完成任务总表」
> **历史归档**：2026-09-16~09-21 逐条叙事 `.archive/AGENTS-focus-20260916-0921.md`；09-04~09-11 `.archive/AGENTS-changes-20260904-0911.md`；08-21~09-03 `.archive/AGENTS-full-20260903.md`

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
| openclaw01-04 | **whisper ASR 集群 :9310（2026-09-21 四节点故障转移 LIVE，core env 四址）**+ JoyCaption :9305 + OpenClaw 网关 :18789（上游已断）；⚠️ 02-04 tailscaled 僵死（2026-09-21：**机活服务活 LAN 全通**，仅 TS 离线，SSH 无远程通道，恢复需现场 `tailscale down && up`） | .86/.75/.81/.85 | **100.115.23.67** / ~~100.76.35.7~~ / ~~100.76.140.121~~ / ~~100.125.217.11~~（02-04 TS 暂不可用；01/04 以 TS 2026-08-27 为准，旧 100.69.0.4 / 100.91.128.30 作废） | Mac mini M4 16GB (hw.model=Mac16,10) | dgmt-openclaw01-04 |
| spark01 | **DeepSeek-V4-Flash 无审查 TP2 worker（rank1）**：`dsv4_60` 容器，与 spark02 组 200GbE RAIL 集群（192.168.200.13；RAIL 密钥已修，spark02→本机 RAIL SSH 免密 ✓）。旧 `vllm_glm53`（GLM-5.3-Flash，回滚用）/qwen38sg/Qwen3-VL/molmo2 容器 stop 留存。 | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | **现网 LLM/VLM API**（2026-09-12 切换）：`dsv4_60` @ :8000 — **DeepSeek-V4-Flash DSpark Abliterated Uncensored v1.0**（无审查版，284B/13B MoE，drowzeys 定制 vLLM 镜像 `vllm-dspark-nvfp4-stage-c:gb10`，TP2 跨双 Spark 200GbE RAIL，DSpark k=5 推测解码，KV=nvfp4_ds_mla），served `deepseek-v4-flash-dspark` + 别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash`（core .env 零改动），max_model_len **1048576（1M）**；实测 **70.5 tok/s**（500tok 精确，热身后；冷启动前轮 ~34），无审查验证 ✓，core 路径 ✓。旧 `vllm_glm53`（GLM-5.3-Flash）已 stop 保留回滚。LiveKit 栈仍在。启动方式：`~/dsv4-serve.sh 1`(spark01 worker)→`~/dsv4-serve.sh 0`(spark02 head)，重启后需手动拉起（restart=no）。 | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | **192.168.71.116**(08-25 DHCP 漂移,MAC 指纹实证) | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | **2026-09-13 下线**（:8193/:8194 全停）：LB 池已移除（剩 gpu0+pc01）；QwenEdit 路由改 **pc01:8188**（core env `TOIV_QWEN_EDIT_BASE_URL`，EditUtils+权重齐但 **缺 lrzjason Advance 包**，QwenEdit 应用暂不可用→设备包待装）；TS≠LAN | ~~192.168.71.114~~ | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 小米路由器 | BE10000 Pro,**AP/有线中继模式**(08-26 切换),管理页 192.168.71.42 | 192.168.71.42 | — | — | — |
| 光猫 | 主网关/拨号(MAC 7c:c9:26:ef:01:93) | 192.168.71.1 | — | — | — |
| cloud | 香港网关/frps/OpenResty | 43.119.32.180 | 100.83.78.114 | Linux | root |
| core | **ToIV 生产服务器**(web :3100 + api :8090 + PG + Redis)；:8100/:3501 未监听（AIGCPannel 在 MateBook Colima :8080/:8100） | 192.168.71.47 | **100.77.80.100** | Ubuntu | merlin |
| beijing | **CN 入口** toiv.wineryz.top（OpenResty+ACME）；hostname `iZ2ze325an97cwlbt1wxfdZ`；Docker `1Panel-openresty` + `1Panel-frps`（frps 0.68.1）听 7000/7500/13100/18090，另有 `1panel-core` :1722；1.6Gi RAM 无 swap；40G 盘约用 15% | 8.140.222.24 | — | Ubuntu 24.04.4 LTS（阿里云） | root |
| MateBook | 操作终端 | **192.168.71.9**（2026-08-28；~/NAS 已挂） | 100.74.15.34 | macOS | 本机 |

> 🔒 跨地区访问原则(2026-08-23):**浏览器侧直连一律 Tailscale 优先**(画布 iframe 100.68.100.90:8188、工作流 :8189,LAN 地址仅回退候选);core→workstation 服务间调用保留 LAN(共址直连快)。

> 🔴 **2026-09-12 服务重构**：上表各设备的「角色/现网服务」为**下线前快照**——workstation 全部 ComfyUI/AI 常驻、pc01/02 ComfyUI worker 均已下线（disable/stop），待新算力规划拍板后按需恢复；快照+恢复命令 `.regen_tmp/service-restructure-20260912.md`。**spark 已率先恢复：DeepSeek-V4-Flash 无审查 TP2 已 LIVE（见第五节）**。保留未动：core 业务网关、frp/openresty 网络通道、DRT 栈、OpenClaw 网关（上游已断）。

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

> 🔴 **2026-09-12 服务重构：本节全部常驻服务（含 LB/gpu0-alt/longcat/H3/animate2/超分 fleet/qwen3-embedding/toiv-audio-sep/toiv-comfy-mcp/fan_guard 共 12 units + hunyuanimage docker）已 `disable --now` / `docker stop`**，下表为下线前部署快照；恢复命令见 `.regen_tmp/service-restructure-20260912.md`。下线后真机：G0–G2=23MiB、G3≈1.1G（gnome 残）、RAM used 10Gi、AI 端口全关。

| GPU | 服务 | 端口 | systemd |
|-----|------|------|---------|
| GPU0 | **现网常驻** ComfyUI gpu0-alt(cache-lru 8) / LongCat(cache-lru 3) ；~~JoyCaption / IndexTTS2 / CosyVoice2 / hy3dtex~~ 等非生图非视频常驻已停 disable（2026-09-07） | :8196 / :8197 （停用端口见归档） | comfyui-gpu0-alt / comfyui-longcat（joycaption/tts/hy3dtex 等已停） |
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

**模型/内容下载来源清单（稳定路径；2026-09-08）**：
- 仓内正式清单：`docs/MODEL_SOURCES.md`（人读）+ `docs/MODEL_SOURCES.json`（机读）。**根目录五件套不变**，勿在仓库根新增 `MODEL_SOURCES*`。
- 用途：每次模型/内容下载维护带来源的条目（HF / Civitai / RH / 本地），供更新核对与查文档。
- 维护：ToIV 模型下载；项目管家五件套只引用本路径。WIP 草稿放 `.regen_tmp/`，就绪再落入 `docs/`。
- **不**替代 `engine_registry` / `model_wiki` / admin knowledge-graph / `model_profiles`；清单指向 NAS 落盘路径 + 出处 URL。
- 最新计数（2026-09-11 wave2，STATE `model_sources_wave2_public_e2e_2026_09_11`）：**ok 468 / blocked 335 / total 803**；清单在 docs，持续追加。

---

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 systemd 常驻,`deploy/deploy.sh` 部署;PostgreSQL 18 / Redis 真机运行（仅 bind 127.0.0.1，探测用回环地址）。
- **域名双入口**：toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(**beijing CN 入口** OpenResty+ACME；Docker `1Panel-openresty` + `1Panel-frps` 0.68.1 听 7000/7500/13100/18090，另有 `1panel-core` :1722);openresty → frp 本地 127.0.0.1:18090/13100。
- **引擎矩阵拍板(08-21)**：R18=Wan2.2+LTX2.3;H3 全面替代 LTX2.5;RAM OOM 根治(MemoryMax/排队误杀修复)。
- **LLM/VLM（2026-09-12 LIVE：DeepSeek-V4-Flash 无审查版上位，GLM-5.3-Flash 退役保留回滚）**：`TOIV_LLM_*` / VLM 等仍指向 spark02 `http://192.168.71.84:8000`（`/v1`），**core .env 零改动**——DSv4 以 served 别名 `qwen3.8-27b`/`qwen3.6-uncensored`/`glm-5.3-flash` 兼容承接。容器 `dsv4_60`（`drowzeys/DeepSeek-V4-Flash-DSpark-Abliterated-Uncensored` v1.0 无审查，284B/13B MoE，FP4+FP8 QAT 155.4GiB 双机各 ~79GiB，定制镜像 `ghcr.io/drowzeys/vllm-dspark-nvfp4-stage-c:gb10`——stock vLLM 在 GB10 跑不了此模型），TP2 跨 spark01+02 200GbE RAIL，DSpark k=5 推测解码（k 必须 ≥5），KV=nvfp4_ds_mla，max_model_len **1048576（1M）**（旧 GLM 524288 的 2 倍）。实测（2026-09-12）：500tok 精确 **70.5 tok/s**（热身后；冷启动前轮 ~34，NVMe fault-in 属正常）、四别名 ✓、无审查验证 ✓（官方版典型拒答问题正常作答）、core 别名路径 200 ✓。用途含官方版拒答内容写作（用户拍板）。旧容器 `vllm_glm53`（GLM-5.3-Flash）双机 stop 留存，回滚：`docker stop dsv4_60`（双机）→ `~/launch-glm53-vllm-tp2.sh 1`(spark01)→`0`(spark02)。**启动方式：`~/dsv4-serve.sh 1`(spark01 worker)→`~/dsv4-serve.sh 0`(spark02 head)，容器 restart=no 重启后需手动拉起；权重 `~/models/dsv4-flash-dspark-abliterated`（双机同路径）**。历史：2026-09-10 GLM 上线、2026-09-07 曾切 qwen3.8-27b；备份 `.env.bak-qwen27b-20260907` 仍有效。
- **Embedding（2026-09-12 恢复 LIVE，真机核）**：Qwen3-Embedding-4B 实际运行在 **workstation :9302**（`qwen3-embedding.service`，/opt/qwen3-embedding-server.py）；服务重构中已 disable、算力恢复时重新拉起（active/enabled），**实测 /v1/embeddings 真实出向量 ✓**；core `TOIV_EMBED_BASE_URL=http://192.168.71.127:9302/v1`（真机核 deploy/.env 已修正指向 WS）——旧口径「已迁 spark01 :9302」**作废**（spark01 :9302 无服务、连接拒绝）。
- **视频评分器灰度**：`TOIV_VIDEO_SCORER_ENABLED=true`(阈值 0.65,timeout 120s);⚠️ 迁移 DDL BOOLEAN 默认值必须 TRUE/FALSE,PG 不认 DEFAULT 0。
- **whisper ASR 集群（2026-09-21 LIVE）**：`TOIV_WHISPER_URL` = openclaw01-04 四址逗号分隔（`192.168.71.86/.75/.81/.85:9310`，OpenAI 兼容契约，bak-whisper-cluster-20260921 留档）；`Settings.whisper_endpoint_list` 解析+dub_text/board_film 故障转移（5xx/连接错换节点，4xx/中止不转移）；任一节点掉线不阻断听写/逐词配音。
- **Admin 控制台（toiv-admin :3200）**：Next.js 单页五 tab；部署=core 本机 `npm install && npm run build && sudo systemctl restart toiv-admin`（生产 node_modules 是 --omit=dev，缺 typescript 会报 `@/components` 解析假线索；deploy-admin.sh 旧 Mac 构建口径待固化，见 ADMIN_REPLAN D7）。
- **web_search 代理**：`TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`(MateBook Clash;依赖 Mac 在线,离线自动降级)。
- **workstation 常驻 ToIV 服务（真机核 2026-09-12）**：systemd running 中**已无** trainer / lipsync / 3dops / scope / sysmetrics（旧口径「仍在清单」漂移）；重构前实际在跑的 AI 服务 = comfyui-lb / gpu0-alt / longcat / h3 / animate2 / upscale-gpu1-3 / qwen3-embedding / toiv-audio-sep / toiv-comfy-mcp / fan_guard + hunyuanimage docker——**2026-09-12 已全部 disable --now / docker stop**（见第三节🔴条与 `.regen_tmp/service-restructure-20260912.md`）。
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
- **N-5 「TS 离线」≠「服务掉线」(09-21 openclaw02-04 翻案)**：先 LAN ping+端口扫再下结论——机活服务活但 tailscaled 僵死是常态;处置:Mac=`tailscale down && up`,Linux=ts-health 自愈探针(每 5min,已常驻 core/WS);服务间调用一律 LAN 直连不吃 TS。

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
- **E-8 读用户参考图一律 input→output 双形态**：作品库产物/主体库三视图 URL 是 `type=output`,硬编码 `type=input` 必 404→502;统一走 `get_image_bytes_any`(comfy/client.py,六处已收编)。

### P. 平台机制类

- **P-1 产物 URL 已签名+归属校验**：测试构造产物 URL 必须带 sig 或先建档;<img>/<video> 走 `?token=` 认证。
- **P-2 Next.js 生产构建必须 `rm -rf .next` 干净重建;deploy.sh 只 rsync 不重建**——部署前必须确认本地 .next BUILD_ID 是当次新构建,验证前端变更必须截图/查 BUILD_ID,不能只看 API。
- **P-2b styled-jsx 作用域坑**：多组件文件一律 `<style jsx global>`+前缀命名;UI 改动必须真机截图验证。**CSS 三约束**：①appsRh 全文件懒惰正则——`object-fit: cover` 规则必须位于 `.rh-preview-cover`/`.rh-detail-cover` 断言区**之前**;②engineStudio 零 hex——自 `.apps-studio {` 起扫到文件尾,新增样式段禁 hex（fallback 也不行）,且**勿臆造 token**（用前先 grep globals.css 有定义）;③新增 lib/api 导出必补 `tests/mocks/studioApi.ts` 替身（链接期即炸）。
- **P-3 浏览器自动化测 React**：原生事件不触发合成事件(select 用 native setter+dispatchEvent);多 textarea 用 `.promptbar-textarea` 精确定位。
- **P-4 命令行自杀坑**：`pkill -f` 模式串用 `[f]an_guard` 式转义;torchrun 须连父进程一起杀;/tmp 是 tmpfs(大文件写 /var/tmp)。
- **P-5 并行 SSH 会话会互相改写状态(高优)**：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源再处置。**当前实况:AIGCPannel 项目会话也在操作 workstation(见 H-7),动服务前留意**。
- **P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top(uv 装 git+ 依赖会被重定向失败,先手 clone 改本地路径);core 登录返回字段是 `token`;上传 kind 必须下划线风格;H3 生成前先 free 缓存。
- **P-7 新 Python 服务环境三坑**(sm_120 Blackwell)：torch 必须 cu128+/cu130;老牌 CV 包 `--no-build-isolation --no-deps`+torchvision 补丁;**库主版本升级后旧调用约定必须逐处核对,能跑≠语义对**(trimesh/diffusers 实证)。
- **P-8 DB 会话纪律(09-21 池楔死 P0 事故)**：FastAPI yield 依赖**响应流完才 teardown**——大响应慢流(frp 37KB/s)会把会话挂到流完,命中路径 auth 查询同样开事务;大 payload 端点必须内存拼好字节后**显式 session.close() 再返回 Response**;**异步长任务(demo/smoke 批)禁持 DB 会话跨 await**(有界钉持也要限量);PG 池已显式 20+20/pre_ping/recycle(db.py);诊断=pg_stat_activity 看 idle in transaction+core venv py-spy。
- **P-9 agent 工具开发纪律**：加工具必须同步四处断言(BUILTIN_ORDER/schemas 并集/LEGACY_SYSTEM/test_agent_gen_tools 尾部窗口);服务抽出 import 必须别名防遮蔽;**成功文案首 60 字禁 hint 词**("失败/超时/不可用/仅 R18/过于频繁/未知工具/不存在"——runner 按此粗判终态,错误路径反而要含)。

---

## 七、当前焦点（活口径摘要；逐条叙事见归档）

### 当前基线（2026-09-22 核）
- **测试**：api **3315** / web **988** / e2e 六 spec **11/11**；分支 `feat/app-guides-admin-cms`（本地，勿 push、勿 stage `.regen_tmp`/`dogfood-output`）。
- **生产**：api 已部署（whisper 四址+池修复）；web BUILD_ID `20260921-052336-nogit`（core 本机 pnpm build）；admin :3200（core 本机 npm build）；入口一律 CN `https://toiv.wineryz.top`。
- **目录规模**：应用 **6773 总/5061 公开/5558 rh-acc**，use_case 打标全覆盖（edit1351/other1021/art869/photo374 等）；作品库 72 件（44 件折 18 变体文件夹）；说明卡 550/550。

### 下一步工作（四域方案批 1）
- 总方案 `docs/EVOLUTION_PLAN_20260922.md` + 三份深度专篇：`docs/LIBRARY_FOLDER_DELETE_PLAN_20260922.md`、`docs/ASSISTANT_UI_REDESIGN_PLAN_20260922.md`、`docs/ADMIN_REPLAN_20260922.md`。
- **批 1**：①作品库文件夹整组删除 P0（文件夹卡删除入口+确认 Modal+复用 deleteJobsBatch/撤销；三处「不做整组删除」注释与 libraryBatch 测试同步改）②助手 A0 快赢（移动端 CTA `ctaAction` 跳 fusion→改 home；popup 提示分端；AgentRunStyles 空文件/模型设置残留清理）③Admin 审计筛选键点号化（AuditLogView 下划线→点号，2932 条存量立即可查）。
- 后续批：助手 A1 工具卡片（toolRenderers 六族）→ Admin P0 设备域（假活识别+whisper 集群卡）+说明书批量 → 文件夹 P1 bulk 端点+Admin P1 作业队列 → 余量按方案。

### 09-16~09-21 交付摘要（一行一条；逐条叙事 `.archive/AGENTS-focus-20260916-0921.md`）
- **09-21 RH SCALE3+打标+三回归修（`1b4c577`）**：RH 目录 8747/8747 全 drain、新种 4524、errors 0；use_case 4568/4568；css token/mock 替身/object-fit 位置三修。
- **09-21 P0 池楔死根修（`fb7a69d`）**：目录 7MB 列表慢流+yield 依赖流完才 teardown→DB 会话挂流完，默认池 15 条全楔死；三层=池 20+20+pre_ping/list_apps 三路径显式 session.close()/缓存重建单飞。
- **09-21 whisper 四节点集群（`ffd4939`）**：openclaw02-04 仅 tailscaled 僵死（机活服务活）；`whisper_url` 多址故障转移（5xx/连接错换节点，4xx/中止不转移）；core env 四址 :9310。
- **09-21 漫剧线全收口（`5062968`~`ba46140`）**：分镜板 M1/角色一致性 M2/一键成片 M3（词锚定卡拉 OK+IndexTTS）/多轮导演 A1/画布编排 A2/自愈延伸 A3/整片 remix/说明书知识图谱 P2/管理台 P3 驳回钮。
- **09-20~21 作品库五批+画板 v1（`3e68f7e`~`e841547`）**：重试/来源筛选/收藏/时间分组/变体组/Saved Views/资产即输入/同款/续写链/跨端同步/闭门同款/画板 CRUD。
- **09-19 全功能测试+封面洪峰 P0 修（`287d875`）**：autorefire 尝试落档+3 上限+深度闸 12；Mac↔core bulk 黑洞绕行 core-jump。
- **09-18 引擎矩阵 18/24 真 PASS 收口（`0f8d2d0`）**：ltx25 退役、flux1-nunchaku=SM120 上游登记；动态 COMBO 双兼容（`45905f0`）。
- **09-12~14**：服务重构算力全恢复（DSv4 TP2 70.5 tok/s）/上线冲刺 497=90.4% 收口/策展层 12 类/说明卡 550/H3 加速三档（balanced 2.94×甜点）/全资源利用/产品树六批入库（详见归档与 STATE.json）。

### 关键拍板（长期有效）
- **ToIV 仅本地自用/学习，不公开运营**（09-21）——社区广场/UGC 合规搁置备档；hypit 平台级集成否决（可个人本地玩）。
- 部署：web/admin 一律 **core 本机构建**（Mac 外地 TS 37KB/s）；api 走 `deploy/deploy.sh --skip-web core-jump`；admin 构建前 core 须全量 `npm install`（生产装无 typescript）。
- 封面 autorefire：尝试上限 3+深度闸 12+批限 120，勿手动乱调；demo 批失败多为已知硬阻塞类，勿误读回归。

---

> 归档：2026-09-16~09-21 逐条叙事 `.archive/AGENTS-focus-20260916-0921.md`；09-04~09-11 `.archive/AGENTS-changes-20260904-0911.md`；更早（08-21~09-03）`.archive/AGENTS-full-20260903.md`。机读状态：`STATE.json`。


---

## 八、未完成任务总表（按责任方分组；每次推进后更新）

> 已完成/已核销的历史待办（workstation 重启窗口、spark 集群修复、8189 退役、FE 齐套 1.52.7、同图去重、渐变封面、InfiniteTalk resolve_worker 等）见 `.archive/AGENTS-changes-20260904-0911.md` 与 `.archive/AGENTS-full-20260903.md`。

### F. 服务重构（2026-09-12 起，最高优先；项目管家+用户拍板）

- [x] 全设备真机服务清单 + 全部算力/AI 服务下线 + 核验（2026-09-12 完成；快照 `.regen_tmp/service-restructure-20260912.md`）
- [x] **新规划已拍板（2026-09-12 用户拍板）**：WS + PC01/02 全量跑 ToIV 所需模型服务（ComfyUI 池/H3/LongCat/Animate2/超分/Embedding/辅助），双 Spark 提供底层 LLM 算力（DSv4 无审查 TP2）
- [x] **双 Spark 部署 DeepSeek-V4-Flash（2026-09-12 LIVE ✓）**：`drowzeys/DeepSeek-V4-Flash-DSpark-Abliterated-Uncensored` v1.0（无审查）+ 镜像 `ghcr.io/drowzeys/vllm-dspark-nvfp4-stage-c:gb10`，TP2 跨双 Spark RAIL，DSpark k=5，KV=nvfp4_ds_mla，1M ctx。实测 **70.5 tok/s**（500tok 精确，热身后；冷启动前轮 ~34）；四别名承接 core 零改动 ✓；无审查验证 ✓。启动 `~/dsv4-serve.sh 1`(spark01)→`0`(spark02)；回滚=`vllm_glm53` stop 留存。运维要点：stock vLLM 在 GB10 跑不了（block_size 冲突）必须用定制镜像；`--max-num-seqs` 勿调低（用 12）；V4.1-Flash（552B）装不下勿选
- [x] **按新规划恢复服务（2026-09-12 完成，5 阶段全 PASS）**：WS 12 units enable+active、pc01:8188/pc02:8193/8194 计划任务恢复、LB 3 后端 healthy、core health 三后端齐、txt2img 冒烟真实出图；**core `TOIV_EMBED_BASE_URL` 已修正为 workstation :9302**（真机核 deploy/.env=192.168.71.127:9302，WS :9302 实测出向量 ✓；旧 spark01:9302 口径作废）
- [x] 决策点：DRT 栈去留 — **已核销（2026-09-14 用户拍板）**：DRT 是用户另一独立项目，与 ToIV 无功能耦合（真机核：ToIV 用 core 原生 PG/Redis 127.0.0.1:5432/6379，DRT 的 drt-postgres/redis 容器未发布宿主端口；ToIV 入口走 frp toiv-api/toiv-web，不经 drt-caddy 的 80/443；ToIV 代码零引用 livekit/coturn）。保留现状不算 ToIV 待办；core 上 13 容器 ~1.44GiB 内存、80/443 被 drt-caddy 占用是唯一共置事实，未来 ToIV 若要在 core 直挂 TLS 需另议端口。
- [ ] 决策点：cloud 遗留 aigc-auth / deploy-flask / exo-proxy 是否清理
- [ ] 决策点：OpenClaw ×4 网关去留（上游 LLM 恢复前不可用）

> ✅ 算力已于 2026-09-12 全量恢复——A/B/C 组（E2E 矩阵/设备分流/模型下载）**解除暂停**，可按优先级重排。

### A. 主线：公开 E2E 真跑矩阵（ToIV 开发）

- [x] ~~剩余 34/550 wave15~~ → **550 全覆盖已完，终局 497/90.4%（2026-09-14，wave21/22/23 三轮收口，见第七节主线条）**；残差 53 全分类，硬阻塞证据 `.regen_tmp/lane_b_whitepaper_20260914.md` + `.regen_tmp/FINAL_SETTLEMENT_20260914.md`
- [x] :8195/:8197 节点缺口批量安装 — **done（:8195 3829 类 / :8197 3618 类含 SDPose/GIMM/Jjk/art-venture）**
- [x] 模型权重下载包 — **done（MODEL_SOURCES 811 条；SeedVR2/flux2 对/depth-ctl/SeC/Uni3C/Florence/VACE-Fun-A14B×2/fp4-r128 全落盘）**
- [x] `426919` 跟到底：不再挂起（终局 census 已按最新状态计入）
- [x] `294829` 重测：终局 census 口径已覆盖
- [ ] wave23 后空闲窗口补刀（可选，非阻塞）：超时/排队 12 例再复测 + 封面余量 1128 续跑 + QwenEdit fp4 权重
- [ ] **:8195 节点缺口批量安装** → **独立任务包已备**：`.regen_tmp/e2e_closeout_20260913/DEVICE_STEWARD_PACKAGE.md`（21 个缺节点 display name + app id 清单 + RH MiniMax-H3 模型目录修法 + 验收口径，wave5–12 聚合；wave13 结果出来后追加）——装完通知开发按包内 app id 重测
- [ ] **模型权重下载包** → `.regen_tmp/e2e_closeout_20260913/DOWNLOAD_STEWARD_PACKAGE.md`（sd3/t5xxl_fp16、Qwen3-VL-8B/4B-FP8、SeedVR2 gguf 手动放置、HF 超时一批；含 worker 侧 `HF_ENDPOINT=hf-mirror.com` systemd drop-in 治本建议）
- [ ] `426919`：仍 running，跟到底出结论
- [ ] `294829`：字段已清但 `queued_timeout` @ `:8194` → 重测
- [ ] wave4 可重试组：熔断 / 503 / 上传若干 → 择机重跑
- [ ] 产品候选修复收尾：LayerMask abs-path / Qwen3_VQA HF / LoadImage toivref（beta57→beta 已 dirty 回填，随复测验证）

### B. 设备管家

- [ ] `145828` SeedVR2：Comfy 目录可见但仍 Failed to download（节点自有路径）
- [ ] `387721`：新缺 `SeCVideoSegmentation`
- [ ] wave4 设备组：Anything Everywhere3 / SAM3 Get Object Mask / 全局输入 / H3 文本节点 / IPAdapter FaceID LoRA
- [ ] LayerMask：worker 需 `models/segformer_b3_clothes` + `models/segformer_b2_clothes`
- [ ] Qwen3_VQA：`LLM/Qwen3-VL-4B-Instruct` → `models/prompt_generator/`
- [x] GPU0 reset — **done 2026-09-21 真机核销**：09-13 断电重启已清（uptime 8 天）；nvidia-smi 无 requires reset 标志、四卡全枚举正常在位（G0 37.4G/G1 39.2G/G2 41G 钉卡✓/G3 27.3G）、无僵尸 compute app；H-6 数字索引偏移坑作为历史教训保留（UUID 钉卡纪律不变）

### C. 模型下载

- [ ] `142022`：缺 `darkBeastMar0326` / `flux2-vae` / `qwen_3_8b`（Flux2 节点部分属设备）
- [ ] H3：`minimax_h3_ref2va_pruned_bf16` 仍缺（写 `h3/`）
- [ ] ltx spatial 1.1/1.0 folder mount 或仍另轨（通用池 extrapaths 未完全覆盖）
- [ ] MODEL_SOURCES 持续追加（当前 ok468/blocked335/total803）

### D. 产品（ToIV 开发）

- [x] **产品 dirty 树处置 — done 2026-09-14**：按 COMMIT_BATCH_PLAN 六批次收编入库（见第七节详条；未 push，push 待拍板；`.regen_tmp`/`dogfood-output`/`*.bak` 已进 .gitignore 永不入库）
- [x] P1 应用说明卡（用法/作用）— **done 2026-09-12**（550/550 LIVE，见第八节主线区详条）
- [x] **市场策展层 — done 2026-09-12**（12 用途分类落库+550/550 打标抽检 95%+分类导航/精选热门合集/搜索强化 LIVE，见第七节详条）
- [x] **21 个 api 预存测试失败已全数收清 — done 2026-09-14~17**（test_rh_h3_presets/engine_registry/app_seed/app_covers/r18 等语义漂移重断言 + 1 真回归修复；当前基线 api 3231 pass / 0 fail、web 963 pass / 0 fail）
- [x] 引擎真跑 e2e 验证挂算力恢复后 — **done 2026-09-18~19**（24 引擎矩阵终局：18 真 PASS、ltx25 退役、flux1-nunchaku=SM120 上游已登记、txt2img/img2img 瞬时态已证健康；见第七节 09-18 晚条目）
- [x] P3 万能管理台（扩展现有 Admin）— **done 2026-09-21**（盘点=Admin 已近全+提案驳回按钮，commit `ba46140`，见第七节）
- [x] P2 说明书知识图谱 — **done 2026-09-21**（确定性相似度回填 550/550+关联端点+指南卡 chips，commit `e032427`，见第七节）
- [x] RH 准确重入库续扫 — **done 2026-09-21 SCALE3 全量 drain**：webappId **8747/8747(100%)**，本轮新种 **4524**（主批 4445+create_401 挽回 79），ckpt 累计 seeded 5768/skipped 2979（null_workflowId 2978+export_code_810 1）/**errors 0**，两批 post-spot 均 12/12；DB 存量 6773 总/5061 公开/5558 rh-acc；`no_template_reseed` 纪律保持（零模板克隆）；报告 `.regen_tmp/rh-accurate-reseed-scale3-20260921.md`
- [x] SFW/NSFW 合并残留 — **done 2026-09-21 核销**（运营层已并：前端 STUDIO_MODES 同槽；注册表去重=装饰性，撞探测矩阵风险跳过入册）
- [ ] Comfy 二次编辑 save-back 未做（open-in-comfy 已通）
- [x] 约 18 个无 RH 映射 builtin 封面待真出图 — **done 2026-09-21 核销**（真核：公开非 R18 应用无封面数=0；无封面 builtin 全部为非公开/R18，demo 管线按设计不覆盖，`planned=0` 不是 bug）

### E. 运维/独立事项

- [x] ~~DRT 部署到 core~~ — **已过时核销（2026-09-12 真机核）**：DRT 全套 12 容器已在 core 运行 2 周（drt-web/api/caddy/backup/loki/grafana/promtail/prometheus/alertmanager/postgres/redis）；去留见 F 组决策点
- [ ] Cloud 公网 :22 跨境疑似 QoS：**SSH 一律走 Tailscale 100.83.78.114**（GSSAPI=no 已修，TS 路径 5.4s）
- [ ] spark 重启后需手动拉起 DSv4：`~/dsv4-serve.sh 1`(spark01)→`~/dsv4-serve.sh 0`(spark02)（restart=no；冷启动 10–45 分钟属正常）
- [ ] workstation 重启后例行：`mountpoint /home/merlin/nas_mount` 核实；**NAS 挂载后必须重启 ComfyUI 实例**（启动早于挂载会缓存空模型列表 object_info=0，2026-09-13 断电实证 gpu0-alt/pc01 双双中招）；**fan_guard 实际脚本在 `/opt/fan_guard.py`**（2026-09-12 更正：非 /tmp，unit Environment 已配好，重启后 enable 即可，勿再按旧口径重传 /tmp）
- [ ] core 疑似无来电自启（2026-09-13 断电最后恢复）——建议 BIOS 设 AC Power On，或断电后人工确认
- [ ] 断电恢复 SOP 与实证：STATE `power_outage_recovery_2026_09_13`（含 wave runner STOP/CONT 保护姿势、DSv4 手工重启 20 分钟冷启动）
