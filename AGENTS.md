# AGENTS.md — 集群操作记忆与决策记录

> **目的**：避免 AI 助手反复犯同样的错误，每次会话必须先读本文件
> **维护者**：设备管家（AI Assistant）
> **最后更新**：2026-09-03（精简重构：全史归档 `.archive/AGENTS-full-20260903.md`；LB :8189→:8196；操作方查明=AIGCPannel）
> **读取规则**：每次会话开始时必须完整阅读本文件，尤其注意「⚠️ 易错点」和「🔒 硬性规则」
> **历史归档**：2026-08-21~09-03 全部变更叙事（含回归数据/生产实证细节）见 `.archive/AGENTS-full-20260903.md`，本文件只留活口径

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
| ~~studio01-04~~ | **2026-08-29 全线下线退役**（EXO :52415 全超时，fleet_registry 已移除；L2/L3 LLM 收拢 spark02） | .109/.111/.112/.113 | 100.67.43.40 / 100.91.0.121 / 100.115.27.68 / 100.126.182.23 | Mac Studio M3 Ultra 512GB | dgmt-studio01-04 |
| openclaw01-04 | OpenClaw 网关 :18789 均 200（2026-08-28） | .86/.75/.81/.85 | **100.115.23.67** / 100.76.35.7 / 100.76.140.121 / **100.125.217.11**（01/04 以 TS 2026-08-27 为准，旧 100.69.0.4 / 100.91.128.30 作废） | Mac mini M4 16GB (hw.model=Mac16,10) | dgmt-openclaw01-04 |
| spark01 | **SGLang 双机集群入口**：qwen3.8-flash-next（NVFP4，:8000 OpenAI 兼容，max_model_len 262144，支持视觉，无审查；2026-09-03 实测通过。旧 Qwen3-VL-32B/molmo2 已下线） | .82 | 100.81.235.124 | Linux GB10 | dgmt-spark |
| spark02 | 同集群 node-rank 1 计算节点（`--tp 2 --nnodes 2`；**API 入口在 spark01，本机 :8000 无监听**）。另跑 LiveKit 栈（drt-livekit/egress/redis:6380）。旧 Qwen3.8-27B-Uncensored 已下线 | .84 | 100.86.42.89 | Linux GB10 | dgmt-spark |
| workstation | 算力+全部后端服务 | 192.168.71.127 | **100.68.100.90** | Linux 4×RTX PRO 6000 | merlin |
| pc01 | ComfyUI worker :8188 | **192.168.71.116**(08-25 DHCP 漂移,MAC 指纹实证) | 100.69.134.27 | Windows RTX 5090 | home |
| pc02 | ComfyUI worker :8193 + 编辑实例 :8194；**TS≠LAN**：LAN 均 200（08-28），⚠️ Tailscale 08-27 离线 21d | 192.168.71.114 | 100.107.94.26 | Windows RTX 5090 | w |
| NAS | SMB 存储 44T | 192.168.71.7 | 100.80.237.96 | Linux | dgmt-nas |
| 小米路由器 | BE10000 Pro,**AP/有线中继模式**(08-26 切换),管理页 192.168.71.42 | 192.168.71.42 | — | — | — |
| 光猫 | 主网关/拨号(MAC 7c:c9:26:ef:01:93) | 192.168.71.1 | — | — | — |
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

> 显存数字为快照,**动态变化,容量规划前必须重新 `nvidia-smi`**(H-2)。RAM 总量 183G:多引擎并跑前必须 `free -h` 查 available(H-3)。

| GPU | 服务 | 端口 | systemd |
|-----|------|------|---------|
| GPU0 | ComfyUI #1(cache-lru 8) / IndexTTS2 / CosyVoice2 / hy3dtex 纹理 / JoyCaption(~17G) / LongCat(cache-lru 3,作业完自动驱逐) | :8196(09-03 起;原 :8189 端口被占卡死,alt 顶班,见 H-7) / :9200 / :9201 / :9404 / :9304 / :8197 | comfyui-gpu0-alt / toiv-tts / (cosyvoice) / toiv-hy3dtex / toiv-joycaption / comfyui-longcat |
| GPU1 | Qwen3-Embedding-4B / LiveAct / 超分 / Hunyuan3D Kijai | :9302 / :9400 / :8261 / :8200 | qwen3-embedding / toiv-liveact / comfyui-upscale-gpu1 / comfyui-hunyuan3d |
| GPU2 | **MiniMax H3(主力视频引擎,~41G;gpu-pin.conf UUID 钉物理 GPU2,非数字 CVD=2)** / ASR / FireRedASR / CosyVoice3 / Qwen3-TTS / demucs / SenseVoice / 超分 / InfiniteTalk / Fish S2(常驻~20G) | :8195 / :9210 / :8300 / :9202 / :9203 / :9220 / :9211 / :8262 / :8201 / :9212 | toiv-comfyui-h3(UUID 钉卡,见 H-6) / comfyui-infinitetalk / toiv-fishs2 等;H3 峰值~78G 安全,新增常驻服务前必查 |
| GPU3 | FlashTalk(~51G) / OpenTalking / 超分 / Wan-Animate-2 / i2L | :9004 / :4403 / :8263 / :8199 / :9101 | ~~LTX-2.5 :8198~~ **已彻底退役**(08-23 `disable --now`,模型留盘可回滚) |

**ComfyUI-LB 后端**（3 后端）：本地 **:8196**(GPU0,`comfyui-gpu0-alt`——:8189 端口被占卡死后顶班,见 H-7) + pc01 :8188 + pc02 :8193。GPU1/2/3 不入 LB 池（专用实例 :8197/:8195/:8199/:8201/:8261-8263 均专用;每新增同机专用实例必须补 `deps.resolve_worker()` 精确匹配,见 E-1）。

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

---

## 五、Core 生产状态（活口径）

- **服务**：toiv-api :8090 / toiv-web :3100 systemd 常驻,`deploy/deploy.sh` 部署;PostgreSQL 18 / Redis 真机运行（仅 bind 127.0.0.1，探测用回环地址）。
- **域名双入口**：toiv.dgmt.top(香港 cloud,frp-kcp) + toiv.wineryz.top(北京,frpc-bj);openresty → frp 本地 127.0.0.1:18090/13100。
- **引擎矩阵(08-28 对照仓拍板)**：SFW 视频主路 **H3=海螺 3.0**（不是 Hailuo 2.3）;R18=Wan2.2+LTX-2.3+10Eros;Wan2.1-VACE 仅编辑/转场;LTX-2.5 已退役;图像默认 FLUX.2+Qwen-Image/Z-Image;混元视频/SkyReels 未挂。⚠️ spark01 09-03 已换 qwen3.8-flash-next（旧 Qwen3-VL-32B 下线）。
- **LLM/VLM（09-03 core env 实况）**：L1/L2/L3/NSFW 全部 `TOIV_LLM_*`=spark01 `http://192.168.71.82:8000/v1` 模型 `qwen3.8-flash-next`（SGLang 双机集群，API 入口 spark01；spark02 为计算节点本机无监听，旧 spark02 qwen3.8-27b 口径已作废）；VLM `TOIV_VLM_SERVER_URL=http://192.168.71.82:8000` model_id `qwen3-vl-32b`（⚠️ 该 model_id 是否仍被 spark01 新栈接受,使用前真机 curl 一次）；反推 VLM `TOIV_REVERSE_VLM_BASE_URL=http://192.168.71.82:8000/v1`。
- **视频评分器灰度**：`TOIV_VIDEO_SCORER_ENABLED=true`(阈值 0.65,timeout 120s);⚠️ 迁移 DDL BOOLEAN 默认值必须 TRUE/FALSE,PG 不认 DEFAULT 0。
- **web_search 代理**：`TOIV_WEB_SEARCH_PROXY=http://192.168.71.9:7897`(MateBook Clash;依赖 Mac 在线,离线自动降级)。
- **workstation 常驻 ToIV 服务**：trainer :9100 / i2l :9101 / lipsync :9103 / 3dops :9402 / scope :9401 / sysmetrics :9403 / hy3dtex :9404 / joycaption :9304 / embedding :9302 / liveact :9400。core 对应 env 均已配。
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
- **H-7 comfyui-gpu0 :8189 端口被占卡死**：unit 反复 `Port 8189 is already in use`（8189 LISTEN 残留,归属进程对 merlin 不可见,无免密 sudo 未查实）。**2026-08-31 03:21 由 AIGCPannel 会话建 `comfyui-gpu0-alt.service`(:8196,同 GPU0/cache-lru 8,active+enabled)顶班**,core `TOIV_COMFY_WORKERS` 已切 :8196。⚠️ 占用者清理与回切 :8189 由 AIGCPannel 处置方收口(P-5),第三方勿擅动;⚠️ AIGCPannel 侧 `start-aigcpannel.py` 仍硬连 :8189(其文档自称「禁止直连单卡 8189」却如此,属其内部漂移)。

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

- [ ] 项目负责人推送 DRT 到 core（备份在 workstation /var/tmp）
- [ ] Cloud SSH banner 超时排查（HTTPS 正常）
- [ ] comfyui-gpu0 :8189 占用者清理与回切评估（:8196 alt 顶班中;AIGCPannel 处置方收口,见 H-7）
- [x] InfiniteTalk :8201 补 `deps.resolve_worker()` 精确匹配（E-1,09-03 `3446b75` 已部署 core）
- [ ] GPU0 reset（独立未修事项,勿写成已修）
- [x] 已核销：ltx25 处置 / trackJob abort / test_duration flaky / ToIV 迁移 core / 域名双入口 / spark02 无审查替换 / `TOIV_CIVITAI_API_KEY`
