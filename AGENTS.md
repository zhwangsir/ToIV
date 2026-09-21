# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-15 晚（项目管家：**市场分类重设计 + 真实 demo 封面管线 LIVE**（用户拍板「封面必须由对应应用真跑产出，尽量美女」）——①前端 12 use_case → **8 场景组导航**（`USE_CASE_GROUPS` 展示层映射不动库：写真人像/图片编辑/时尚换装/剧情运镜/风格艺术/数字人口播/电商广告/工具其他；chips 计数=**指纹去重功能入口数**与折叠网格一致，选中组显示 blurb）；②**`app_cover_demo` 服务**：应用自工作流真跑（复用 run_app_smoke 新加 `values_override`/`collect_result`，LLM 自愈试提交同透传）+ 美女素材包 `beauty01-12.png`（majicMIX 麦橘写实自产 SFW 写真已人工审，`smoke_` 前缀命名零改动吃 `_upload_fixtures`）+ 提示词注入（纯生成=场景模板/i2v/视频=动作模板/编辑类保默认/超长视频长度压 73）+ 视频 ffmpeg 抽中帧；**成功才覆盖 cover_url**，Job(kind=app_cover_demo) 存档溯源；`POST /api/admin/apps/covers/demo` 单飞 + `/status`；③重打标 225 个 other/空分类（empty 56→34 余全 R18 够不到属预期；other 202 为真通用工具，靠场景组消化）；④守护 `.regen_tmp/demo_cover_watch_20260914.py` 自动续发至全量（~490 目标视频占 65%，十几小时）+ JoyCaption 后审 `.regen_tmp/cover_review_20260914.py`（首批 3/3 合格）；⑤**顺手修真回归：agent list_apps 直调缺 `fingerprint=None`（Query 默认对象 truthy，09-13 同坑复发=对话选应用全空）**；封面回读白名单放行 `appcover-demo-*`；demo 端点 sync def 无 loop 500 教训。api 3223/0、web 990/0；BUILD_ID `20260915-102311-9f1a091`）——**同日续：作品库×应用搭配 LIVE（用户拍板「不同应用内容在作品库的显示/预览要做好」）**：①Job.kind 语义化——`_app_job_kind` 把遗留默认 submit_kind=app_run 视作未定制、按应用 output_kind 派生 `app_video/app_image/app_audio/app_3d`（定制 submit_kind 尊重）；db.py post-migration 幂等回填历史 done app_run（按 result 扩展名；失败/无产物保持 app_run；生产回填 app_video 421/app_image 317/app_audio 4）；②前端 FILTERS 收编四桶（类型筛选/计数罩住应用产物）+ kindLabel 中文短名；③灯箱「打开应用」按钮（job.app_id）→ `/?view=market&app=<id>` 深链直开运行台（AppMarketView 挂载读参、关闭清参）；灯箱类型行显示短名。封面全量批 561 目标由守护续跑中）——此前：2026-09-15 早（进化 Phase1 自愈闭环基座交付+用户反馈首轮修复。烟测/归因/确定性修复器/LLM 修复器/预检闸门/市场徽标全上线；随机 RH 导入实测 36% 可达→预检闸门；用户测试 400=未传图提交双保险已修；市场功能归组+作品库性能+pc01 三启动坑根治；烟测批次 500+封面续跑中）——更早：2026-09-14 完整上线冲刺收口 497/90.4%；H3 智能加速全栈 LIVE；SGLang 否决；市场策展层 LIVE
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」「🔒 硬性规则」和「八、未完成任务总表」
> **历史归档**：2026-09-04~09-11 全部变更叙事见 `.archive/AGENTS-changes-20260904-0911.md`；2026-08-21~09-03 见 `.archive/AGENTS-full-20260903.md`

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
- **P-5 并行 SSH 会话会互相改写状态(高优)**：关键服务「莫名掉线」先 `journalctl -u <svc>` 查停止来源再处置。**当前实况:AIGCPannel 项目会话也在操作 workstation(见 H-7),动服务前留意**。
- **P-6 杂项**：workstation pip 用清华镜像、github 用 ghfast.top(uv 装 git+ 依赖会被重定向失败,先手 clone 改本地路径);core 登录返回字段是 `token`;上传 kind 必须下划线风格;H3 生成前先 free 缓存。
- **P-7 新 Python 服务环境三坑**(sm_120 Blackwell)：torch 必须 cu128+/cu130;老牌 CV 包 `--no-build-isolation --no-deps`+torchvision 补丁;**库主版本升级后旧调用约定必须逐处核对,能跑≠语义对**(trimesh/diffusers 实证)。

---

## 七、当前焦点（活口径摘要；逐条叙事见归档）
- **🟢 09-21 A2 画布编排 LIVE（主线 2 收官，commit `b948997`，api 3295/web 988 全绿，真机+真跑双实证，生产 BUILD_ID `20260921-031849-nogit`）**：agent 可拖拽搭建工作流图节点、人审一键执行——①**静态校验器**（`services/canvas_graph.py validate_api_graph`）：对照 object_info——未知 class/连线端点不存在或超界=error；**required 语义与 ComfyUI 对齐**（连线型缺失=error，widget 型缺失=warning 用节点默认，白名单 `_WIDGET_SCALARS={INT,FLOAT,STRING,BOOLEAN,COMBO,NUMBER}`——**勿把 "STRING" 当引用类型**，第一版曾把 widget 缺失全判 error 误杀 LLM 图）；**widget 2-list 值（[name，强度]）不得误判为连线**（spec 引用类型或 [str,int] 形态双重判定）；COMBO 出界=warning+最近变体（小写 Levenshtein）；②**工具** `propose_canvas_graph`（全 33 工具）：校验过才落 `pending_proposal(type=canvas_graph)`（复用 propose_plan 确认门），图本体只落会话不进 SSE；object_info 复用 `routes/canvas.canvas_object_info`（10min TTL 单飞）——⚠️ **勿用 `app_smoke._union_objinfo`**：那只是 combo loader 值并集非全量目录，会全类误杀（真机实证 9 连拒）；③**前端**：提案卡 `kind=canvas_graph` 出「在画布中打开」主按钮（`fetchAgentCanvasProposal` 取图→`toiv_canvas_proposal` 手off→跳画布）；CanvasView 首载消费手off+提案横幅（warnings 透出），运行=既有 `/api/generate/raw` 零新设施；④**真机**：DSv4 自主 search_knowledge→list_models→一次提案成功（7 节点带真实底模名 `DreamShaper_8_pruned.safetensors`）；**最后一英里**：提案图经 `/api/generate/raw` 真跑 done 出图（`txt2img_output_00002_`）。**进化计划三大主线全部收官**（主线 1 M1-M3/主线 2 A1-A3/主线 3 四件）；余底盘欠账（GPU0 reset/cloud tailscaled/TS 在家复测）均需物理在场。
- **🟢 09-21 整片级 remix LIVE（主线 3 收官件，commit `1a0eb1e`，api 3288/web 987 全绿，e2e+真机双实证，生产 BUILD_ID `20260921-023735-nogit`）**：hypit 借鉴的整片级结构变体——①**做法=克隆板+按类改写+一键成片（复用语义天然生效）**：`services/board_remix.py` 三类——**换主角**（character_map 旧名→新主体 id：entity_ids 按位换绑+prompt/scene/dialogue/speaker 换名+新外观 hint 前缀，命中行 job_id 清空强制重出；旧外观 token 残留=v1 已知边界）/**换词**（行级 dialogue 覆盖，job_id 全保留=**最省变体，实证 12s 成片**）/**换背景**（prompt_suffix 全局/逐镜，强制重出）；克隆保原版（命名「原名 · remix换主角/换词/换背景」）；②**agent 工具** `remix_storyboard`（tools_drama 第六件，全 32 工具）——「把这版短剧换个主角」直达；③**前端**：分镜工具行「remix」弹窗三 tab（换主角=角色→主体下拉/换词=逐镜台词/换背景=全局场景词），成功后打开新板；④**真 bug 根修**：`_download_clip` 对站内鉴权端点（`/api/boards/film`、`/api/drama/output`、`/api/studio/files`、`/api/drama/voice`）**服务端自调无 token 必 401**——改本地文件直读，**remix 链式引用成片打通**（成片可当源再 remix）；⑤**真机**：words remix 全链——卡拉 OK 字幕含新词（`{\k30}Rem{\k48}ix{\k30}新{\k48}词…` 真逐词）、未改写镜保留原词、原版分毫未动；e2e `authed-board-remix.spec.ts`（零 LLM 确定性：双视频挂行→换词→复用 12s→ass 三断言）14.1s 过。⚠️ 易错点：**e2e 选复用源作业要限定 /api/images 产物形态**（board_film 成片是站内端点形态，选中会踩到服务端自调 401——此坑已成本轮根修）。**主线 3 全部收官**（词锚定字幕/QwenEdit/:8198/整片级 remix）；主线 2 余 A2 画布编排（大件）。
- **🟢 09-21 A3 自愈闭环延伸 LIVE（commit `f15c357`，api 3281 全绿，真机 agent 验证 ALL PASS）**：烟测失败归因与修复建议 agent 化——①**四工具**（`agent/tools_selfheal.py`）：`list_smoke_failures`（失败清单+归因类中文建议，映射对齐 BUG_REGISTRY 分类法）/`explain_app_failure`（单应用详解+已有 LLM 提案）/`run_app_smoke`（委托 `app_smoke.run_app_smoke`，管线内自动归因+确定性修复重试+LLM 修复）/`reject_app_fix`（委托 `selfheal_llm.reject_proposal` 回滚坏补丁）；admin 门禁与 routes/admin 同语义；tool_seam 注册（**全 31 工具**）。②**真机**：DSv4 对「有哪些应用烟测失败？」自主连发 list+explain 呈现完整归因链。③**踩坑入册**：`runner._looks_like_error` **按首 60 字 hint 词粗判工具终态**（"失败/超时/不可用/仅 R18/过于频繁/未知工具/不存在"）——成功文案「烟测失败/超时应用 N 个」被误判 error，已改并加**不变式测试（成功文案首 60 字禁 hint 词）**；**agent 工具成功路径文案一律避开 hints，错误路径反而要含**。④断言四处同步机制复用（同 A1）。**主线 2 余 A2 画布编排；主线 3 余整片级 remix**。
- **🟢 09-21 主线 3 设备小件双收 + get_image_bytes_any 根修（commit `0c889ed`，api 3276 全绿）**：①**QwenEdit 全线恢复 LIVE**——pc01 :8188 ComfyUI 进程曾死（机器在、进程挂;schtasks `/run /tn StartComfyUI` 拉起，4307 节点加载），LB 双后端 healthy;**lrzjason Advance 包实证在位**（41 Qwen 节点含 `TextEncodeQwenImageEditPlusAdvance_lrzjason`——pc02 条目「缺 Advance 包」残旧证伪）;`qwen-image-edit available=True`;**真跑 104s done 出图**（`ToIV_qwen_edit_00005_.png`）。②**:8198 NSSM 根治 LIVE**——`ComfyUI-H3` 服务化（NSSM 2.24 win64 `C:\nssm.exe`，AppRestartDelay 5s，SERVICE_AUTO_START LocalSystem，日志 nssm-out/err.log）;**kill 实证 ~12s 复活 200**;`\StartComfyUI-H3`/`\Watchdog-ComfyUI-H3` 已 Disabled 留档（回退=enable+`nssm remove`）;定义入仓 `deploy/infra/pc01/README.md`（安装序列全录）。⚠️ **pc01 Tailscale 无 peer（tailscaled 停）但 LAN 在线**——SSH 走 `-J merlin@100.77.80.100 home@192.168.71.116` 跳板;Windows 长命令仍 `-EncodedCommand`(N-4)。③**产品根修 `get_image_bytes_any`**（`comfy/client.py`）——qwen-edit 引擎路径读源图硬编码 `type=input`,作品库产物（type=output）必 404（M2 longcat/h3 transfer 同坑的未修面）;统一 helper 后应用六处（qwen-edit/apps 媒体转运/agent 3D 附件/wan caption/motion_brush 探测/imagedims）;entities/reference_assets 展示端点核后**确认无需动**（URL 串本就 302 正确处理;apps.py:2808 存在性探测保留 input——LoadImage 只认 input 目录,output 文件仍需转运）。**真机逼出的规律:凡是「读用户参考图」的代码路径,一律 input→output 双形态**。
- **🟢 09-21 A1 多轮导演 LIVE（主线 2 试水，commit `b25a6b5`，api 3275 全绿，真机 agent 验证 ALL PASS）**：漫剧线管线 agent 化——用户自然语言「把剧本做成 N 镜短剧」→ DSv4 自主编排 create_storyboard（拆镜建板+角色落库）→ 同会话续聊 assemble_storyboard（一键成片）→ **545s 真成片 `board-film-4be031c7….mp4`**。①**服务抽出**（route↔tool 共用零行为变更）：`create_board_from_script_svc`/`prepare_shot_meta`/`start_board_film`（⚠️ **import 必须别名**——路由函数与导入同名会递归遮蔽，TypeError 六参打三参）；②**五工具**（`agent/tools_drama.py`）：create_storyboard/get_storyboard/generate_shot/assemble_storyboard/check_film，全部委托服务层不复制逻辑，归属/限流与路由同语义，tool_seam 注册（全 27 工具；⚠️ **加工具必同步四处断言**——BUILTIN_ORDER/schemas 并集/LEGACY_SYSTEM/test_agent_gen_tools 尾部窗口，五处缺一即红）；③**测试**：test_tools_drama 5 项；e2e `authed-agent-drama.spec.ts`（首轮钉 create_storyboard——**前后差集定位新板，勿赌 agent 原样转发剧本/MARK**；newEntities=0 属幂等预期）；④真机要点：会话头=`X-Agent-Session-Id`（续聊续不上→agent 幻觉 board_id「不存在」全链崩）；DSv4 对「num_shots=2」指令遵循准确。**A2 画布编排/A3 自愈延伸待排**；主线 3 余：整片级 remix、QwenEdit 恢复（pc01 lrzjason Advance 包）、:8198 NSSM 根治。
- **🟢 09-21 一键成片（M3）LIVE（漫剧线三阶段全收口，commit `dd7cec3`，api 3270/web 987 全绿，e2e 四 spec 全过，生产 BUILD_ID `20260920-231836-nogit`，真机全链+审片循环+真词锚定三实证）**：分镜板→成片全链——①**编排骨架**（`services/board_film.py`）：合成 Job `kind=board_film, worker=""`（tracker 跳过）+**params 快照推进即回填**（重启续跑唯一事实源；时间轴 start/end 也落 params）+spawn 幂等+`reconcile_board_films()` 注册 main.py lifespan（与 video_upscale/keyframe_chain 同区）；四阶段 videos(Semaphore2，单镜失败不中断标 params)→voices(Semaphore1，IndexTTS 单卡)→words→assemble；E-7 多轮等待（`wait_for_jobs`+预算循环，held 换名透明）；视频就绪行服务端换挂（`_attach_job_to_row`）；②**审片=幂等重拼**：`reuse_existing` 行已挂 done 视频作业（产物含 .mp4）直接复用——**实证首跑 589s vs 审片二跑 8s**；无视频镜跳过不进片，≥1 镜即拼；③**配音**：speaker 严格按名命中 `Entity.ref_audio` 下载→`studio voice.synth`（**M2 死字段激活**；下载失败降级默认音色不阻塞）；`_fit_voice_to_slot` atempo≤1.3 对齐镜时槽（drama 链复用）；④**词锚定字幕**：三级链——外部 whisper（`verbose_json+timestamp_granularities[]=word`）/内置 faster-whisper `word_timestamps=True`/段内均分；**词时间必须 clamp 镜时槽**（mlx 30s 窗 padding 尾段虚高 ~3s 对策）；新 `build_karaoke_ass`（`\k` 逐词+【speaker】前缀+PlayRes）+SRT 侧车；**openclaw01 whisper server 已打逐词补丁**（57 行 FastAPI 加 `timestamp_granularities[]` alias 转发 `word_timestamps=True`，向后兼容，版本化 `deploy/whisper-service/server.py`，bak-20260921 留档）——真词锚定实证 `{\k30}灯{\k20}亮{\k32}着,{\k58}人…`（非均匀真对齐）；⑤**拼接**：core 本机 ffmpeg（trim/tpad/scale/pad/fps/setsar 归一→concat→adelay+amix→`ass=` 烧字，libass 探测缓存；**300s 硬上限，长板拆解留后续**）；产物 `drama_output_root()/board-film-{hex}.mp4(+.ass/.srt)`，`GET /api/boards/film/{name}` 白名单端点，`rewrite_job_result` 式落库进作品库（kindLabel「漫剧成片」）；⑥**前端**：分镜工具行「一键成片」+确认 Modal+film strip（阶段/进度条/错误/完成后内嵌播放器+mp4/ass/srt 下载；active 4s 轮询；终态 `invalidateJobs`+`onRefreshItems`）。**设备变更两条**：**IndexTTS 2.5 恢复 LIVE**（`/etc/systemd/system/toiv-indextts.service` 自 `bak-20260827` 归档还原，enable+active，/health model_loaded cuda:0——**配音主路，勿再停**）；openclaw whisper 补丁见④。⚠️ 易错点新增：**验证脚本 req() 勿对非 JSON 产物（ass/srt）json.loads**（误判网络错误）；**LLM 拆镜对白字段有波动，配音/字幕验证必须确定性注入 dialogue**；**e2e 冷启动并发拉 chunk 会饿死 frp 链路**（workers=1 串行稳）。**漫剧线 M1/M2/M3 全部 LIVE**；下一步主线 2（Agent 导演 A1 多轮导演）或主线 3（词锚定字幕已并入 M3 提前兑现、整片级 remix、QwenEdit/:8198 设备小件）。
- **🟢 09-21 分镜板 M2 角色一致性 LIVE（commit `ded82e0`，api 3254/web 986 全绿，e2e 三 spec 8/8 过，生产 BUILD_ID `20260920-214506-nogit`，真机验证 ALL PASS）**：角色库卡（定妆照+音色）→ 分镜自动带参考图——①**角色落库**：from-script 把曾被丢弃的 CharacterDraft `upsert_script_characters` 进 `Entity(kind=character)`（user+kind+name 幂等取最旧、description/prompt_hint **只补空不覆盖**用户策展数据），shot_meta 写 **`entity_ids`（与 characters 同序，rename-safe）**；②**单镜生成端点** `POST /api/boards/{id}/items/{item_id}/generate`（engine∈phantom-s2v/h3-r2v/h3-t2v）：按行 shot_meta+角色实体**直调引擎路由函数**（rerun 同范式）——phantom 预过滤无图主体（路由 `_entity_ref_handles` 对无句柄 422）、`num_frames=duration×fps`；r2v 先 resolve-refs 出句柄（池内通用 worker 中转，**勿钉 H3 实例**——其模型门控不含通用 img2img）、entity_ids 过滤为 refs 子集保序保 `@图片N` 对齐；t2v 透传兜底；③**两个引擎层根修（真机逼出）**：phantom `_entity_ref_handles` 只吃句柄 JSON → `image_handle_for_injection` 统一双形态（**Entity 图片四列本就承诺句柄 JSON/站内 URL 双形态，phantom 违约**）；`longcat/h3 transfer_ref_image` 硬编码 `type=input` → **input→output 兜底**（主体库 AI 三视图/作品库产物 URL 是 type=output，此前作参考图必 404→502）；④**前端**：分镜工具行（引擎三选一 localStorage 记忆 `toiv_board_gen_engine`）+角色条（`collectBoardCharacters` 聚合，定妆照缩略图/无定妆照徽标/跳主体库）；行按钮双路径（canRerun→rerun，其余→generate 同一轮询换挂）；作品库补 `h3_r2v/phantom_s2v` 筛桶+短名；EntitiesView ref_audio 对 character 放开（**死字段边界：仅存/露/导出，TTS 消费归 M3，voice_name 同理**）；⑤**导出角色升维**：characters 带 entity_id/visual_prompt/ref_audio/reference_front（导出 scene/prompt 媒体沿用 M1）。**真机**：生产 from-script 19.5s 落两角色 → 灌 URL 形态定妆照 → **phantom 真跑出片**（ToIV_phantom_00014.mp4 @ :8197）→ 换挂 → 导出升维 ALL PASS；无照 422 指引文案实测。⚠️ 易错点新增：**e2e 板名查找别把标记放剧本中段**（板名只取剧本前 12 字，标记须置开头）；**LLM 会规范化角色名**（剥离标记/敬称——实体断言走 shot_meta.entity_ids 确定性链，勿赌名字）；**验证脚本 PUT 载荷勿忘 `{"items": ...}` 包裹**（M1/M2 两脚本同坑，422 `model_attributes_type` 误导成隧道抖动）。**下一步 M3**：一键成片（分镜图→关键帧链/H3 单镜视频→配音(whisper+IndexTTS,音色=Entity.ref_audio)→词锚定字幕→ffmpeg 拼接+审片台）。
- **🟢 09-21 分镜板 v2（M1）LIVE（进化计划漫剧线首阶段，commit `5062968`，api 3247/web 984 全绿，e2e 新旧 spec 7/7 过，生产 BUILD_ID `20260920-200200-nogit` core 本机构建）**：画板 `shot_text`/`shot_meta` 激活——①**数据模型**：`BoardItem.shot_meta` 列（LLM 拆镜 ShotDraft 结构化草稿 JSON，`_SQLITE_MIGRATIONS` 一元组迁移）；**`job_id=""`=占位分镜行**（put 非空才去重/归属 422、list 占位行 `job=null` 透出、封面回退跳空）；⚠️ **shot_meta 必须全链 round-trip**（任何 PUT 漏带即丢草稿，前端 `lib/storyboard.ts rowsToPutPayload` 统一收口）；②**LLM 剧本拆镜（巨日禄模式验证）**：`POST /api/boards/from-script` 一步建板+占位行——**复用现役 studio 链 `services/studio/storyboard.py parse_script`**（L3 精修层+指代消解后处理，生产实测 **19.2s** 出 3 镜，不自造 prompt）；shot_text 人读合成（scene+台词(speaker)+运镜，`services/board_storyboard.py compose_shot_text`）；StoryboardError/LLMError→503；③**分镜视图**：板详情网格/分镜段控——行=镜号+缩略图（点开灯箱）+分镜文本（失焦保存，乐观更新+回滚）+状态 chip+操作（挂作品选择器/**单镜重生成**（rerun random→轮询 done→整组 PUT 换挂，`canRerun` 白名单与作品库同口径，`app_*` 不支持置灰）/用作参考/上移下移/移出）+添加行；④**整板导出 drama_studio 格式**：`GET /api/boards/{id}/export` 附件 JSON（字段对齐 `_shot_dict`：idx 连续/scene=shot_text/prompt=shot_meta‖job.prompt/characters 聚合去重/narration 按全镜时长累计/seam 无草稿除末镜 hardcut 末镜空；⚠️ **产物 URL 扩展名在 query 不在路径**（`/api/images?filename=a.png`），媒体分流须整串正则匹配不能只看 path）；⑤**顺带修真 bug**：LibraryView `showBoards` 早退曾致**板详情点成员不开灯箱+lightboxIdx 残留**（返回作品库后灯箱突弹）——灯箱 portal 提升为早退前 `lightboxPortal` 变量、条件视图分支同挂载，e2e 覆盖此路径；顺带修 **waitForFunction options 第三参 latent bug**（`waitForFunction(fn, {timeout})` 实为 arg 30s 生效，P0 spec 8 处+新 spec 2 处同修，P1 两次失败真凶）。**真机验证**：from-script 真实 DSv4/导出媒体分流/rerun 提交→done→换挂全通；验证期间 frp dgmt 入口两次 SSL/超时抖动复核均为链路非产品（N-1），**CN 入口 toiv.wineryz.top 稳定（e2e 走此，7/7 仅 28s）**。新 spec `apps/web/e2e/authed-board-storyboard.spec.ts`（真实 DSv4 拆镜→编辑持久→挂作品+灯箱→重生成→导出形状，finally 清理板）。**下一步 M2**：角色一致性（角色库卡定妆照+音色→分镜自动带 phantom/h3-r2v 参考图，复用 entities 体系）。
- **🟢 09-20 作品库 P0 LIVE（用户拍板方案后实施，commit `3e68f7e`+`1f39968`，api 3240/web 967 全绿，生产 BUILD_ID `20260920-120934-nogit`）**：①**失败一键重试**——接线既有 rerun 端点（seed keep/random/explicit+版本链早已存在，前端从未接）+白名单扩引擎自包含 t2v 族（h3_t2v/h3_multishot/longcat_t2v/ovi_t2v/ltx_t2v）；失败卡内联品牌色「一键重试」+hover 操作+灯箱按钮，重试中 conic 流光遮罩原位轮询，成功旧卡移除新卡浮顶；②**来源筛选**——工具条下拉（引擎/应用分组+计数，纯前端，app_name 后端批量 IN 查防 N+1）；③**元信息角标**——卡面玻璃芯片 256×256/时长（meta 快照派生零 IO）；lookup 端点 duration（ffprobe 走 worker /view 懒探测+Redis 缓存，实证 0.92s 回读）；④**灯箱快捷键**——D 下载/R 重试+底部 kbd 提示条（Esc/←→ 原有）。⚠️ 部署变通：Mac 外地网络 TS 大流量 ~37KB/s，.next 不可传——**改 core 本机 pnpm 构建**（core 有 node22+pnpm store+残留 node_modules；BUILD_ID 远端现构天然新鲜，P-2 意图不违背）；源码 rsync 走 core-jump + 重试循环 + 产物排除。真机走查 spec：`apps/web/e2e/authed-library-p0.spec.ts`。**P1 同日续 LIVE（commit `ea867b6`，web 971 绿+e2e 2 passed，BUILD_ID `20260920-133450-nogit`）**：收藏（☆卡/hover+灯箱+F 键+「收藏 N」只看开关，localStorage 持久容错）；时间分组粘性标题（timeSlotKeyOf 五槽纯函数，品牌色左边线+渐变 hairline，文件夹按最新成员归槽）；元数据桥（buildMetaBlock 一键复制参数块+pngHasWorkflow 客户端解析 PNG tEXt 反显「已内嵌 ComfyUI 工作流」徽标）；Shift+Click 锚点连选（跳过文件夹）。重试流 e2e 实证：遮罩 1.4s 出现、DB 侧 rerun 新作业全 done。**P2 同日续 LIVE（commit `367712b`，web 974 绿+e2e 3 passed）**：变体组折叠（同 kind+seed+prompt ≥2 自动成组，复用 folder 机制；batch_id 优先、孤品回落；文件夹卡/面包屑区分「同参数变体」vs「360° 环绕序列」，下钻组内横向对比——实测 8 组自然成形，rerun 刷库问题解决）；Saved Views 动态文件夹（工具条「存视图」内联命名→chips 行应用/删除，localStorage 容错）。虚拟化核查：MAX_MOUNTED=180 DOM 窗口化既有代码已覆盖，不另做。**P3 续 LIVE（09-21，commit `0889295`，web 976 绿+e2e 4 passed）**：资产即输入（lib/assetPick 作品 URL→{filename,worker} 句柄暂存；EngineStudioView 引擎切换直填 images/audio/video 槽，免二次上传、天然同 worker 互钉；无匹配槽保留待换引擎；e2e 实拍图生图槽直填+toast）；一键同款（rerun random 换 seed 重抽，与重试共用状态机）。**作品库优化五批全部收官**（P0 重试/来源/元信息/键盘 → P1 收藏/时间分组/元数据桥/连选 → P2 变体组/Saved Views → P3 资产即输入/同款）。**P3.5 续 LIVE（09-21 四项调研后实施，commit `9766028`，api 3240/web 979 绿，e2e 5 passed）**：续写父子链（Job.continued_from 新字段——**勿与 parent_id 版本链混用**；longcat-continue 的 source_job_id 归属校验落库；卡/灯箱「续写于」跳父作；视频 pick 经 `__source_job_id` 隐藏值自动挂链）；跨端同步（user_preferences 表四字段，**PUT** /account/preferences——既有端点是 PUT 非 POST；pull 覆盖+空串不动+2s 写穿）；闭门同款（lib/remixLink base64url 携带 prompt+seed+引擎+标量参数，媒体键剥离；分享链接打开即导入运行台，纯前端无广场零合规负担）。**用户定位拍板（2026-09-21）：ToIV 仅本地自用/学习用途，不公开运营**——社区公开广场（B 阶段）与 UGC 合规清单整体搁置（已调研备档，未来若要公开再捡）；hypit 结论相应修正：其改良 Apache 2.0 **明文允许组织内部自用**（含单租户部署），多租户禁令只封杀「嵌进 ToIV 给全体用户用」——个人本地跑 hypit 做复刻视频完全合规，想玩可直接 `npx skills add hypit-ai/hypit -g` 试用（仅调托管 API，与自托管算力无关，注意别把工作流文件提交进仓库）。**画板 v1 LIVE（09-21 晚，commit `e841547`）**：Board/BoardItem 表+`/api/boards` CRUD+`PUT {id}/items` 整组替换（越权 422/归属隔离）；工具条入口+板列表+板详情（成员复用全功能灯箱+用作参考直喂引擎）+卡 hover「移入画板」选择器；e2e 全流过；`shot_text` 列为 v2 分镜板（漫剧线对接）预留。至此作品库扩展可选项全部清零（社区公开分发已按本地自用定位不做）。
**hypit 平台级集成结论：不值得**（改良 Apache 2.0 禁多租户+本地 CLI 无服务端形态+全仓 ComfyUI 零命中三重否决；可借鉴三设计：词锚定字幕时间轴/整片级 remix 变体流/编辑写回源——留作漫剧线自研参考）。社区公开广场（B 阶段）前置合规清单已调研备档（标识办法 2025-09 施行+2026-04 即梦被罚实证；机审 ~1000-1500 元/月；ICP/EDI 触发条件；LiblibAI 授权条款范式），待用户拍板量级后立项。
- **🟡 09-20 Tailscale 全舰队体检**：16 节点（14 在线+2 Windows 离线=闲置机非故障）。**已处置**：①workstation tailscaled 数据面僵死（Mac↔WS 全走 DERP）→重启恢复直连 40ms；②core+WS 部署 **ts-health 自愈探针**（每 5min `tailscale ping` 互指×2 失败即重启 tailscaled，systemd timer 常驻，防 09-19 以来三连僵死复发）；③密钥到期全核查（spark02 2026-11-22、NAS 2026-12-16 两个最近，其余 2027+，用户拍板到期再说）。**唯一遗留：cloud（100.83.78.114）数据面僵死**——控制面 checkin 正常但全节点 ping/ssh 无响应（公网 :22 跨境 QoS 也不通、无跳板 key）；**用户面 frp（toiv.dgmt.top）不受影响**（frps 走公网 IP 独立通路），但远程运维入口缺失，**待一次 `systemctl restart tailscaled`（cloud 本机或 1Panel 终端执行即可）**。另发现 **Mac 当前不在家庭网络**（netcheck：gw=192.168.31.1/出口 42.236.253.181 河南联通 vs 家 114.86.82.224）——Mac↔家 bulk 吞吐 ~37KB/s 是跨省链路质量所致，非设备配置问题；在家时若复测仍慢才需查 NAT hairpin。**tailscaled 僵死判别法补充（Mac 侧）**：Mac 换网后多节点打洞失败 → `tailscale down && tailscale up` 可复活；Linux 节点由 ts-health 探针自愈。
- **🟢 09-19 全功能自主测试（大目标轮，commit `287d875`）**：api 3238 绿 / web jest 全绿 / Playwright guest 110 过+2 跳 / authed 28 过 / **UI 走查 10 视图全过零控制台错误**（截图+就绪计时在 apps/web/ui-sweep/）；API 功能 E2E（e2e_prod_check）实质 10/10——txt2img 1.9MB 真 PNG/upload/img2img(DB done)/ltx2_t2v 真 mp4/h3_t2v/h3_i2v(0.9s 合法 mp4,脚本人为 30KB 阈值误杀)/登录限流 429 齐。**测出并已修一个 P0 级生产事故**：封面 autorefire 无限重试（失败不落档）+ 无队列深度闸 → :8196 积压 383 单饿杀用户生成（txt2img E2E 首跑 FAIL 实证）；修复=尝试落档+3 次上限+深度闸 12+批限 120，重启 :8196 清洪峰后队列稳在 ≤5。⚠️ 设备坑新增：**Mac↔core TS 直连大流量黑洞**（ssh 交互通/bulk rsync stall 10min 34KB）——绕行=双跳 `core-jump`（WS 跳板，WS key 已授权 core，ssh config 已配）；Mac 侧 tailscale down/up 可临时复活隧道（tailscaled 僵死判别法 Mac 侧版）。作品库视图名=`library`（非 gallery）。
- **🟢 09-18 晚 接手会话（移交详情见 `.regen_tmp/HANDOFF_20260918.md`，当日增量如下）**：①**引擎真跑矩阵 v3→v3.1 收口**——v3 24 行实证 16 条 submit_fail **全是 runner 载荷 bug 非产品问题**（worker 未透传/images 串非 list/tags 串形态/缺 edit_prompt·first_frame·video·total_duration）；对照路由 pydantic+前端契约裁定产品 schema 全对。v3.1（runner 修正版 `.regen_tmp/engine_matrix_20260918_v31.py`）中间结果 **9 引擎真 PASS**（h3 五件套全过/longcat 三件/wan-animate），submit_fail 清零；txt2img/img2img/wan-vace 为 :8196/:8197 封面洪峰排队 POLL_TIMEOUT（DB 里仍 queued，非产品失败）；avatar-talk 余 runner drive_text 冲突（v3.2 已备）；②**txt2img flux2 mat1/mat2 之谜 = 瞬时态**（17:43 高负载失败/18:43 同图空闲复现 PASS；UNET+TE 双文件 sha256 与 HF 官方逐字节一致）；③**NomosUni fail-fast 之谜破解**：族钉实例（:8197 longcat/:8199 animate2）extra_model_paths 缺 upscale_models 映射 → UpscaleModelLoader 选项=[] → `not in []` 误判缺模型；已补映射+重启（:8199 另补 nas_toiv 源，.pth 15 项在列）；④**动态 COMBO 双兼容修复 LIVE**（commit 45905f0：ComfyUI 0.34 object_info 槽位变 `["COMBO",{"options":[...]}]`，旧代码取 [0] 得字符串逐字符污染并集/误报缺失——`_combo_opts` helper 统一 app_smoke 三处+selfheal_llm+tools+model_health；api 全量 3233 pass +1 flaky）；⑤**Qwen2_VQA 复活**（ComfyUI_Qwen3-VL-Instruct 加 `qwen2_compat.py` 垫片：Qwen2 模型走 Qwen2VLForConditionalGeneration monkeypatch+模型选项扩充；Qwen2-VL-7B 16GB 落盘 prompt_generator（HF Xet 401 → `HF_HUB_DISABLE_XET=1` 走 hf-mirror）；`_MISSING_REQUIRED_DEFAULTS` 补 Qwen2/3_VQA `attention=eager` 回填 commit 53bacb9；两 commit 已部署 core）；⑥**Krea-2-Turbo 26GB 落盘**（HF gated:auto 致 hf-mirror 403 → ModelScope 官方镜像 aria2 500MB/s；sha256=78bbf8f4… 与 HF X-Linked-Etag 一致；`diffusion_models/krea2/turbo.safetensors`；MODEL_SOURCES ok469/total804）；⑦:8196/:8197/:8199 打包重启（垫片+映射生效+清封面洪峰）；⑧**矩阵 v3.1 终局 22:08 DONE（24 行归档 `.regen_tmp/engine_matrix_20260918_v31_results.jsonl`）**：真 PASS **15/24**（13 done + ovi_i2v/wan_vace 超时后实际 done——1200s 轮询帽太短）；6 个 POLL_TIMEOUT 经 DB 交叉核实全部环境性（我重启 :8196 杀掉的作业被 reconcile 正确回收/排队超时后完成），**零产品失败**；4 个 submit_fail=runner 载荷余隙（avatar-talk drive_text/keyframe-chain 缺 prompts/phantom-s2v images 要对象——v3.2 runner 已备 `.regen_tmp/engine_matrix_20260918_v32.py`，且均属前端契约正确仅测试载荷错）；ltx25-multishot=LTX-2.5 已退役该引擎应从注册表移除；flux1-nunchaku=SM120 上游 integer overflow（已登记）。**NomosUni 应用 rh-acc-6186996738-9aed3a 烟测终验 PASS**（combo_repair .safetensors→.pth 自动改写后 :8197 真跑产出）；**Qwen2VQA 应用 rh-acc-9515387905-6c1b38 烟测终验 PASS 零修复**（垫片+权重+attention 回填全链路真跑）；⑨**09-19 凌晨待办清零**（commit `0f8d2d0`，api 全量 3236 绿）：Takibi 字体 `_FONT_ALIASES` remap（源站全登录墙→Roboto 替代，该 app 仅英文标签语义无损，拿到真字体落盘删表项即恢复）；ltx25-multishot 引擎退役（注册卡/probe/分发/知识库全移除，SFW 24/R18 34，`/api/ltx/multishot` 路由保留）；**矩阵补测暴露并修复一个真产品 bug**——avatar-talk 驱动音频参数 type 误标 text 致前端不渲染音频上传（前端 engineNeedsAudio 按 type 找槽），改 type=audio 并新增「hint 含 /api/upload ⇒ type 必为 upload 类」不变式测试；三引擎定向补测（v3.3 runner）**全 PASS**：avatar-talk 640s/keyframe-chain 911s/phantom-s2v 160s。**至此 24 引擎矩阵终局：18 真 PASS、ltx25 退役、flux1-nunchaku=SM120 上游 integer overflow（已登记）、txt2img/img2img=瞬时态已证健康**；遗留仅 Takibi 真字体获取（可选）与 flux1-nunchaku 上游内核。
- **🟢 09-16~18 会话增量（移交详情见 `.regen_tmp/HANDOFF_20260918.md`）**：①**画布原生化 LIVE**（React Flow 自研节点图替代 iframe，工作流列表/参数编辑/一键运行入作品库，`/api/canvas/object_info`+`/api/canvas/workflow` 服务端缓存编码，iframe 退役为「ComfyUI 原版」逃生门；测试 web 963 绿）；②**市场 B+D 改版 LIVE**（类型分段器即分类 图片603/视频492/音频5 + 实测可用能力筛选 + 全宽瀑布；分类入口卡/精选横排退役；分类卡 401 空盒修复）；③**/api/apps 性能修复**（45s TTL 缓存+GZip，2MB/4-14s→246KB）；④**封面撞车根修**（随机 seed + id_salt 素材选取，重复组 9→0；覆盖 468/570=82%）；⑤**封面 autorefire 内建 api**（5min 巡检自动续发，取代外部 Mac watcher）；⑥**设备包收口**（:8195 补 SeC/SDPose/GIMM-VFI/LayerStyle 导入依赖，10 抽样 class_type 缺失=0；SeC 权重 NAS 软链接通；Qwen-Image-Layered/Z-Image-Turbo 33GB 落盘 + `_MODEL_FILE_ALIASES` 别名层）；⑦**猎错扫描**（N1-N5 入册当日收口：/api/apps 性能、8198 看门狗 Watchdog-ComfyUI-H3、3389 关闭、tailscaled 僵死判别法）；⑧**进行中**：引擎真跑矩阵 v3（core /tmp/engine_matrix_20260918.py，结果 jsonl 待收→描述符修复批）；pc01:8198 静默退出看门狗兜底中。用户拍板：TS 续期到期再说/BIOS 搁置/DRT 不动/commit 自决（树 clean，tag migration-complete-20260914 + snapshot-20260917）。


> 2026-09-04~09-11 全部变更叙事：`.archive/AGENTS-changes-20260904-0911.md`；更早（08-21~09-03）：`.archive/AGENTS-full-20260903.md`。机读状态：`STATE.json`。

- **🟢 服务重构已收口 = 算力全量恢复 LIVE（2026-09-12，5 阶段全 PASS）**：新规划=用户拍板「WS+PC01/02 全量跑 ToIV 所需模型服务，Spark 提供底层 AI 算力」。WS 12 units 全部 enable+active（LB:8188 / gpu0-alt:8196 / longcat:8197 / **H3:8195 钉卡 GPU-0e6e9149 复核✓** / animate2:8199 / 超分 :8261-8263 / qwen3-embedding:9302 实测出向量 / toiv-audio-sep:9220 / toiv-comfy-mcp:9100 / fan_guard）；pc01:8188 + pc02:8193/8194 计划任务全恢复；LB `/admin/backends` 3 后端 healthy；core `/api/health` workers 三后端齐；**txt2img 冒烟真实出图**（512×512 PNG 落 :8196）。终态 GPU MiB used：G0=3499/G1=16883/G2=1277/G3=2350，RAM available 160Gi。Spark 侧 **DeepSeek-V4-Flash 无审查 TP2 LIVE（70.5 tok/s，1M ctx，见第五节）**，`vllm_glm53` stop 留存回滚。保留：core 业务网关、frp/openresty、DRT 栈、OpenClaw×4、监控 agent。快照：`.regen_tmp/service-restructure-20260912.md`。
  - ⚠️ fan_guard 实际脚本路径是 **`/opt/fan_guard.py`**（非 /tmp，unit 内 Environment 已配好，勿再按旧口径重传 /tmp）；冒烟产物 `toiv_smoke_00001_.png` 留在 /opt/ComfyUI/output 可随手清。
- **🔒 主线收口 = 完整上线冲刺终局（2026-09-14）**：**497/550 = 90.4%**（今晨 470→+27）。构成：wave22（70 失败全量耐心复测，+8）→ 部署四修 → wave23（62 复测，face-first fixture）→ 终局 census。四修=①`_H3_UNET_NAME_ALIASES` 清空（**mat1/mat2 真凶**：精确 int8 落盘后旧映射强改 pruned 致 DiT/编码器不成对；直提 A/B 对照双 PASS 实证）②调度对称（`_MODEL_LOADERS` 补 CLIPVisionLoader/WanVideoModelLoader + `_extract_required` 同步，治「文件在位报缺模型 503」）③WanVideoExperimentalArgs fresca 组回填 ④img fixture face-first（InsightFace 族）。设备侧：**:8197 补 SDPose-OOD/GIMM-VFI/Jjk/art-venture 四包** + wan_2.1_vae/sam3.pt/Florence-2-large-PromptGen-v2.0/GIMM 四模型（3618 类全绿）；:8196 重启激活 kernels 0.15.2+DepthAnythingV2（4477 类，flux2/fp4-r128/depth-ctl/SeC/Uni3C combo 实测在位）；toiv NAS 补 Uni3C+wan2.2 fp8 对；模型下载 MODEL_SOURCES **811 条**。引擎冒烟：25 引擎全 available（35→25=R18 孪生并入 SFW）+ txt2img/img2img/H3-t2v 三路由真跑 PASS。封面缺口 1166、已批生成 60（单飞可续）。**残差 53 全分类**：超时 12（空闲窗口可再收）/校验绑定 13/其他产品 14/CUDA 内核 5（nunchaku SM120 上游）/缺模型 2/缺节点 4/转运 1/资源 1/下载 1；硬阻塞（RH 媒体真缺失/上游内核/坏源视频）证据在 whitepaper。决算报告 `.regen_tmp/FINAL_SETTLEMENT_20260914.md`。**产品新修已部署 core 未 commit**（别名表清空/调度对称/fresca/rembg/CompressImages/INT coerce/pc01 SYSTEM 任务/infra README/BUG_REGISTRY/EVOLUTION_PLAN/MODEL_SOURCES 811）——严禁 stage `.regen_tmp`。**下一步：用户测试 → 整改；进化计划 docs/EVOLUTION_PLAN.md 已批（自愈闭环→漫剧制片线→Agent 导演）**。
  - 波次 PASS 轨迹 23→11→19→6→12→17→20→24→18→14→22→36→36→36→32；大量残差修复后单卡复测 PASS（明细见归档）。
  - 大量残差修复后单卡复测 PASS（107403/214347/417975/451079/144483/221805/315353/466169 等，明细见归档）。
- **最新数据 tip（2026-09-11 `bab16b3`，本地无 push）**：`rh-acc-4661695490` LTX distilled-lora **PASS** @ `:8196`；`rh-acc-1458284545` SeedVR2 **FAIL→设备管家**（Comfy 目录可见但仍 Failed to download，节点自有路径）。STATE `public_e2e_retest_466169_145828_2026_09_11`。
- **路线图（2026-09-11 用户拍板全序）**：**P0** 分级实测（L0 550/550 **done**；L2=公开 E2E 矩阵进行中）→ **P1** 应用说明卡（**2026-09-12 done/LIVE**，见下条）→ **P3** 万能管理台（**扩展现有 Admin**，非另起后台，planned）→ **P2** 说明书知识图谱（planned）。
- **P1 应用说明卡 LIVE（2026-09-12，dirty 部署）**：550/550 公开应用说明卡由 DSv4 批量生成（33min、0 失败、7.6s/张）并 publish；抽检 20 张五字段全完整、不合格率 5%（≤10% 阈值通过）。架构：`AppGuide` 表（models.py:337）+ `services/app_guide_gen.py`（照 app_packager 契约）+ `POST /api/admin/apps/{id}/guide/generate` / `POST /api/admin/app-guides/publish-all`；AppOut 挂 `has_guide`/`guide_purpose`（列表无 N+1）；前端详情页「使用指南」卡 + 运行台应用详情 tab + 市场卡片用途摘要（apps.css `apps-guide-` 前缀）。脚本：`scripts/ops/generate_app_guides.py` / `spotcheck_app_guides.py`；日志 `.regen_tmp/app_guide_gen_20260912.jsonl`（勿 stage）。
- **产品形态重构：引擎工作台 LIVE（2026-09-12，dirty 部署）**：image/video 视图改挂 `components/studio/EngineStudioView.tsx`（模式段控 × 引擎卡条 × ParamField 参数 × ResultPanel 结果），零新后端——复用 `GET /api/models/engines`（25 引擎含在线探测）+ `submitEngineGeneration` + trackJob；模式→引擎映射 `lib/engineStudio.ts`（图：文生图/图生图/编辑；视：t2v/i2v/fl2v/r2v）。**KindCreateView 退役挂载**（文件保留），应用全归「应用市场」。导航：Rail=对话/应用市场/图片生成/视频生成/音频/工作室/作品库/资源；底部主项=应用市场/图片/视频/对话CTA/作品，audio 下沉抽屉。引擎离线 UX：卡片置灰+原因行+运行钮禁用+30s 轮询自动恢复（当前算力下线全部置灰属预期）。h3-* upload kind 修正为 `h3_i2v` 直传 :8195（少一跳转运）。web 919 测试绿（2 个 featured 排序预存失败除外）；api 3101 绿 + **21 个 dirty 树预存失败**（rh_h3_presets 已清空所致 4 + engine_registry 4 + app_seed 7 + app_covers 4 + r18 2，均为 09-08~11 dirty 波次遗留，待收）。BUILD_ID `20260911-225227-bab16b3-dirty`（本地=core）。
- **市场策展层 LIVE（2026-09-12，dirty 部署）**：①`App.use_case`/`featured` 落库（models.py:327；db.py `_SQLITE_POST_MIGRATIONS` 放 `idx_app_use_case` 索引——索引不能放 `_SQLITE_RAW_MIGRATIONS`，既有库列未建时索引会失败）；12 枚举 `services/use_cases.py`（drama 短剧剧情/avatar 数字人口播/face 换脸人像/fashion 换装穿搭/ecommerce 电商产品/anime 动漫二次元/art 艺术创作/photo 写实摄影/edit 图片编辑/motion 动作迁移/ad 广告营销/other 其他）；打标服务 `services/app_use_case_gen.py`（非枚举回退 other+fallback）；端点 `routes/app_curation.py`（`POST /api/admin/apps/{id}/use-case/generate` / `PUT /api/admin/apps/{id}/curation` / `GET /api/apps/use-cases/summary`）。②打标：DSv4 两轮 550/550 ok、0 fallback（第一轮 motion=136 滥用为通用视频桶、准确率仅 ~82% → prompt 加 12 类边界规则重跑；脚本 `scripts/ops/tag_app_use_cases.py`，**登录字段是 `email`** 非 username；日志 `.regen_tmp/app_use_case_tag_20260912.jsonl` 勿 stage）。**抽检 20 张准确率 ≥19/20=95% 通过**（上轮 4 边界样本全改判 other；generic t2v/i2v 归 other 正确）。分布：other 203 / edit 89 / fashion 43 / drama 41 / avatar 37 / art 36 / motion 32 / face 30 / photo 25 / ecommerce 7 / anime 4 / ad 3。③前端：市场用途 chips 行（summary 计数+客户端兜底）+精选（featured 横滚，空不渲染）/热门（usage_count top10 排除精选）合集位（仅未搜索且 useCase=all 显示）+「找到 N 个应用」提示；搜索扩 name+description+guide_purpose 全文 + `use_case=`/`featured=` 列表过滤；`lib/apps.ts` USE_CASES 常量 + `fetchUseCaseSummary()`；apps.css `apps-mkt-` 段（⚠️ `.apps-mkt-mini-cover .rh-card-img` object-fit 规则在 ~line 1056 非文末，受 appsRh.test 懒惰正则限制）。测试：test_app_curation 10 绿 + test_db_migrations 断言已补；web 968 绿（2 个 featured 排序预存失败除外）。BUILD_ID `20260912-084335-bab16b3-dirty`（本地=core，bundle 含 apps-mkt- 标记）；真机验证：summary 12 类计数齐、use_case=fashion 过滤 43 条全对。
- **H3 智能加速全栈 LIVE（2026-09-12，dirty 部署，用户可选三档实测加速）**：api `POST /api/apps/{id}/run` + h3_studio 全线接受 `acceleration: off/lossless/balanced/extreme`（仅 h3 家族，其余 422；响应+Job 双回显 `acceleration_applied`）；档位机读规格 `apps/api/app/data/h3_accel_profiles.json`（core env `TOIV_H3_ACCEL_PROFILES_PATH` 指向；`.regen_tmp` 版本是源稿勿直接当生产路径）；转换器 `services/h3_accel.py` **2026-09-12 晚图形状感知重写**（教训：盲合并 sampler_params 曾把 `"sampler":"euler"` 字符串写进 SamplerCustomAdvanced.sampler 对象槽 → 执行期 `'str' has no sample`，balanced/extreme/lossless 三档生产作业全挂 b83767b2/61d2e389）：现行为 = 占位符 `<X>`/`<X_node>` 词集解析（SagePatch→SageAttentionPatch，id 无关）+ model 链自动改接（BasicGuider/BasicScheduler/KSampler 的 inputs.model → 追加链尾）+ sampler_params 定向落点（steps→BasicScheduler/KSampler、sampler→KSamplerSelect.sampler_name、flow_shift_*→H3 节点，未知 key 跳过）+ 改写后连线校验（悬空引用/占位符无解 → 整体降级 native）+ **recommended=false 安全门**（基准方下架档原生提交）。两图形状均支持：生产 SamplerCustomAdvanced 三元组链 + 直连 KSampler。生产三档复测全 PASS（779fe807 balanced/cb137b2f extreme/026a9949 lossless，均 success 出片）。前端 `H3AccelSelect` 选择器挂 AppRunnerView + EngineStudioView h3 卡（label 带实测倍率）。**本机实测三档（1344×768×124f/50 步基线 515s 去噪，RTX PRO 6000 SM120）**：lossless=SageAttention Patch 1.32×（SSIM 0.8856）；**balanced=BlockCache T8+SageAttn 2.94×（SSIM 0.8194，人工抽检近原生=甜点位）**；extreme=Turbo LoRA 4 步 12.9×（SSIM 0.7494，人工抽检=预览级画质，用户知情选择）。**SGLang 路线实测否决**：单卡无损 0.90× 反慢、SubBlock 锁 SM90/SM100（SM120 全 fleet 不可行）、Cache-DiT 与 sglang 0.5.19 零命中；社区 8×H200 的 1.95×/6.24× 不可复现（基线差异+SM12x 内核回退+单卡 RPC）。workstation 留有 4 处已验证本地改动（sglang UUID 补丁/cuda-home.conf/ninja 等，明细 `.regen_tmp/h3_sglang_bench_20260912/bench.md`）。⚠️ ComfyUI 提交带默认值 widget 必须显式给出否则 400。测试：api test_h3_accel 27 绿（全量 3138 pass/22 已知预存）；web 982 pass/2 预存。BUILD_ID `20260912-102826-bab16b3-dirty`（本地=core；端点 `GET /api/h3/acceleration/profiles` 实测值 200 验证）。
- **全资源利用计划 LIVE（2026-09-13 完成，用户拍板）**：①**H3 双 worker 池**——`TOIV_H3_BASE_URLS=:8195,PC01:8198`（core .env，bak-h3pool-20260913），least-loaded 调度（resolve_worker/upload/engine_probe 全链路适配，:8198 未就绪自动降级），2 连提交实测分散落卡双 done，`GET /api/h3/workers` 可查队列；②**PC01 128G RAM 全利用**——H3 int8 第二实例 :8198（`C:\ComfyUI-h3` 复制安装 0.33.0 原生 H3 节点，--lowvram offload，计划任务 StartComfyUI-H3 AtLogOn，首个真实出片 冷388s/热146.5s）+ **R: 64G RAM disk 热模型缓存（冷启动 171.6s→16.3s = 10.5×**，SoftPerfect，试用 ~10-13 到期需 license/换 ImDisk；RamDiskHotSync AtStartup 自动重建）；③**WS GPU2 独占**——超分 :8262 挪 GPU0（UUID 核卡✓），H3 权重常驻冷加载消除；④**QwenEdit 恢复**——PC01 :8188 补 `lrzjason/Comfyui-QwenEditUtils`（ghfast.top 克隆），rh-acc-4402626562-6b4a8d 重测 PASS。api 3144 pass/22 已知预存；BUILD_ID 不变 20260912-102826。验收报告 `.regen_tmp/fleet_utilization_20260913/FLEET_UTILIZATION_REPORT.md`。
- **自主任务清单批次（2026-09-13 用户授权自主完成，大部分 done）**：①**MacMini 全接入**——openclaw01-04 四台 ASR :9310（mlx-whisper large-v3，中文 ~4.3× 实时率，kill -9 自愈 12s）+ JoyCaption :9305 LIVE（报告 `.regen_tmp/fleet_utilization_20260913/macmini_pilot_report.md`）；`TOIV_WHISPER_URL` 改指 openclaw01:9310（原 WS :9210 已死）→ **`/api/dub/transcribe` 端到端复活**（上传→听写 3.2s 准确出段）；②**产品 bug 批**：媒体转运真 gap（上传落点≠提交实例）已修（3125723138 验证）；新增提交前 fail-fast 校验（`queue_prompt_validated`+`_doomed_save_nodes`，保存节点全判死→422 透传真因+尽力 cancel，不再白烧 GPU）；**:8198 显存预检回归修复**（阈值按卡总显存×50% 缩放，96G 卡 36G 不变、32G 卡 16G，3 测试）；api 3155 pass/22 已知预存。诚实数字：翻 PASS 3（转运 1 + 瞬态 2）——wave10/11 大量「转运失败」实为 **stale RH 媒体引用（11 例，应用数据类，错误已点名节点转内容 backlog）**；QwenEdit 12 例=排队耐心问题（放宽 stall 复测可再收）。③**迁移准备**：`docs/SERVICE_INVENTORY.md`（6 表按启动序）+ `deploy/infra/pip-freezes/`（7 venv 锁定）+ `deploy/infra/`（34 文件：WS 12 unit+drop-in/backends/extra_model_paths、pc01 bat/ps1、frp.toml[SENSITIVE 标注]）+ 12 项环境漂移清单；④:8198 补 T8/BlockCache（328 节点）；⑤`docs/COMMIT_BATCH_PLAN.md`（6 批次方案待用户批准）。
- **全面测试找 bug 首轮完成（2026-09-13，用户拍板）**：api **3176 pass / 0 fail**（22 预存清零：1 真回归=**助手 list_apps 返回空**（09-12 策展层加参后 tools_gen 未传参，对话 agent 选应用路径全坏）已修部署；21 组测试过期重断言）；web **984/984 全绿**；生产 e2e 扫描 35 步 31 过（4 个 FAIL 复核均为脚本误报）、**无 P0、核心链路全通**；新修 P1=**引擎工作台探测误报**（object_info 2s 硬超时斩掉 22-30 引擎恒置灰；改两级探测：liveness 0.8s 快探+节点集合单飞缓存 TTL10min，engines 5/35→**35/35**，热路径 0.048s，单飞设计防自家并发风暴——同实例 6+ 并发 object_info 会饿死 ComfyUI loop 连 /queue 都排不进）。**总登记册 `docs/BUG_REGISTRY.md`**（P0 清零；P1 剩 9 项主力=管家包执行；P2 含 featured 恒空/use_case 扩面 2 项待产品决策）。e2e 产物 `.regen_tmp/e2e_sweep_20260913.jsonl`。
- **全面修复第二轮完成（2026-09-13，用户拍板「继续全面修复」）**：三包自执行——**设备**：:8195 按 52 app 真实 class_type 装 27 包（1925→**3829 节点缺失 0**，原生作业回归 PASS）、RH MiniMax-H3 目录（**官方 Gluttony10 权重+release 配置树缺一不可**，88GB 实体）、toiv-comfy-mcp→:8196、longcat UUID 统一、37 legacy units 归档、pc01 旧任务清、pc02 专属节点补 :8188；**:8198 补 RH 包**（双池对 RH 打通；遗留 VAE sm_120 CUDA 兼容+高性能档看门狗）。**下载**：sd3/t5xxl_fp16、Qwen3-VL-4B-FP8、SeedVR2（根因=旧文件 sha 损坏）、DepthAnythingV2 落盘 + **hf-mirror drop-in×4**（pc01 ps1 插 hf_env.bat 待重启生效）；blocked Qwen3-VL-8B；MODEL_SOURCES 810 条。**产品**：stale RH 规范化器（5/11 翻）、QwenEdit 11/12（真凶=19.5G 模型逐作业重载 5min）、use_case 1622（抽检 10/10+9/10）、featured 26、前端 recommended 灰度（BUILD_ID `20260913-062011-bab16b3-dirty`）。**关键 P0**：**:8195 主机内存膨胀**（无缓存上限 RSS 94G/峰值 113.8G→RAM 门大面积拒单）修复=unit `--cache-lru 5`（RSS 上限 ~70G，作业间回落 ~1G）。**回归**：wave17+18 复测 70 app **PASS 32（46%）**（wave17 被内存门压到 5.7%→修复后 47%）；残差 32=缺模型值 20（P1-13 内容缺口）+其他。api **3181/0**、web **985/0**。终态健康：core ok/LB 双后端 healthy/四实例 200/WS avail 134Gi。
- **产品树已收编入库（2026-09-14，用户授权管家自决执行）**：dirty 树按 `docs/COMMIT_BATCH_PLAN.md` 六批次全部 commit 于 `feat/app-guides-admin-cms`（tag `product-batch1-h3-base` ~ `product-batch6-ops-closeout-20260914` + 收尾 `migration-ready-20260914`）。提交前基线：api **3198 pass/0 fail**、web 985/0（09-14 晨口径）、MiniProgram **607/607**（顺手修一处 HEAD 预存红：build-request.test.ts H3NsfwT2V 期望补 `nsfw: true`，随 fb78872 有意变更）。`.regen_tmp/`、`dogfood-output/`、`rh_h3_presets.json.bak*` 已进 .gitignore。⚠️ **本地未 push**（push 需用户另行拍板）；仓库本就含凭据惯例（AGENTS.md/NAS 密码、frp 弱 token 已标 SENSITIVE+轮换建议），若未来推远端必须先清凭据。交叠文件按文件级归最早相关批，commit message 已注明携带范围。
- **MODEL_SOURCES**：`docs/MODEL_SOURCES.md/.json`；最新 wave2（2026-09-11）ok **468** / blocked **335** / total **803**，持续追加。
- **Lane B 围剿（2026-09-14，时间盒收尾）**：lane_b 103+校验/绑定 25 聚类后产品侧修复一批（全部 `_build_graph` 值类 normalizer，api **3190 pass/0 fail**，已部署 core）：①scheduler/sampler 别名扩展（bong_tangent→karras、res_2s/res_2m→dpmpp_*）+ **关键机制修正：值类 remap 须在 binding 写值后二跑**（scheduler/unet 常为表单 select，表单值在绑定阶段覆写图内原值，wave19b 实证）；②H3 UNETLoader 旧命名 int8 → 现网 pruned_int8 文件名（8 app）；③RMBG background 'white'→'Color'+#FFFFFF（Lane A 交接项）；④节点包新增 required 按 object_info 默认值回填（LTXDirector/PainterFluxImageEdit/AILab_QwenVL/UltimateSDUpscale/Flux2Scheduler/NunchakuQwenImageDiTLoader）；⑤TextEncodeQwenImageEdit*.prompt 接 easy promptLine COMBO 槽→STRING 槽；⑥stale 规则扩 toivref-<32hex>；⑦ModelPreviewOverrideKJ taeh3→none；⑧CLIP 加载器 sd3/ 子路径→basename；⑨LTXV dynamiccombo 纯点号图缺父键回填；⑩TrimAudioDuration 起止倒置交换。wave19b 复测 runner `.regen_tmp/app_test_matrix_p0/lane_b_wave19b_retest_20260914_runner.py`——**终局 21/35 PASS**（required_backfill 6/7、toivref_stale 4/4、scheduler_sampler 别名 3/3 提交层全通、h3_unet_alias 3/8、qwenedit_link 1/3、sd3_clip 2/2、tiny_vae 1/1）；残差 14=排队耐心/生成超时 6（设备慢，非修复失败）+**H3 精确权重未落盘 4**（pruned_int8 remap 过校验但 mat1/mat2 shape 不匹配，需下原 `minimax_h3_fl2va_int8_convrot`）+Preview-only 深层 2+结果下载超时 1+旧图类型不匹配 1。残留分类=whitepaper 素材 `.regen_tmp/lane_b_whitepaper_20260914.md`（缺模型权重/设备环境/应用数据顽固/产品深层四组）。**Lane A2 交接项（2026-09-14 收尾）**：MelBand FS 路径 remap 补 binding 后二跑（`_normalize_melband_roformer` 加入 post-binding  pass，幂等）+ 新测试 `test_build_graph_melband_alias_after_binding_write`；**rh-acc-0394349569（LTX2.3 口型）生产复测 PASS**（542s 真实出片 `r-ltx23-org_*.mp4` @ :8196；复测 runner 须钉上传 :8196+kind=avatar——`kind=ltx_i2v` 门是 LtxT2V 参数集，与口型链图不符会 503 误杀，记产品候选：upload kind 门应按图内真实 loader 判定）。api **3192 pass/0 fail**。

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
- [ ] GPU0 reset 未修（独立事项，挂 workstation 重启窗口）

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
- [ ] 引擎真跑 e2e 验证挂算力恢复后：引擎工作台提交链路已通（离线置灰 UX 已验），待 WS/PC 服务恢复后每引擎真跑一发验收
- [ ] P3 万能管理台（扩展现有 Admin）— planned
- [ ] P2 说明书知识图谱 — planned
- [ ] RH 准确重入库续扫：已处理 webappId **2260/8747**，约 6487 未处理（多数会跳过；`no_template_reseed=true`）
- [ ] SFW/NSFW 合并残留：LTX / wan-nsfw 等未并（9 对已并）
- [ ] Comfy 二次编辑 save-back 未做（open-in-comfy 已通）
- [ ] 约 18 个无 RH 映射 builtin 封面待真出图（禁 NSFW 渐变生成）

### E. 运维/独立事项

- [x] ~~DRT 部署到 core~~ — **已过时核销（2026-09-12 真机核）**：DRT 全套 12 容器已在 core 运行 2 周（drt-web/api/caddy/backup/loki/grafana/promtail/prometheus/alertmanager/postgres/redis）；去留见 F 组决策点
- [ ] Cloud 公网 :22 跨境疑似 QoS：**SSH 一律走 Tailscale 100.83.78.114**（GSSAPI=no 已修，TS 路径 5.4s）
- [ ] spark 重启后需手动拉起 DSv4：`~/dsv4-serve.sh 1`(spark01)→`~/dsv4-serve.sh 0`(spark02)（restart=no；冷启动 10–45 分钟属正常）
- [ ] workstation 重启后例行：`mountpoint /home/merlin/nas_mount` 核实；**NAS 挂载后必须重启 ComfyUI 实例**（启动早于挂载会缓存空模型列表 object_info=0，2026-09-13 断电实证 gpu0-alt/pc01 双双中招）；**fan_guard 实际脚本在 `/opt/fan_guard.py`**（2026-09-12 更正：非 /tmp，unit Environment 已配好，重启后 enable 即可，勿再按旧口径重传 /tmp）
- [ ] core 疑似无来电自启（2026-09-13 断电最后恢复）——建议 BIOS 设 AC Power On，或断电后人工确认
- [ ] 断电恢复 SOP 与实证：STATE `power_outage_recovery_2026_09_13`（含 wave runner STOP/CONT 保护姿势、DSv4 手工重启 20 分钟冷启动）
