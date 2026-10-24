# ToIV 集群「各设备实际在用模型」盘点

> **更新（2026-10-22 接棒）**：产品默认出图 gate 已切 **`Qwen-Rapid-AIO-SFW-v23.safetensors`**（仓库 `model-config.template*` + Core live `/home/merlin/beeftv-prod/gate/`）。下文 01:09 盘点表仍保留当时现场快照（含 v11）；**以本节更新条与 `WAVE_M_PROGRESS` Gate 验收为「当前」**。旧 v11 权重未删。附录 C 默认裁决：**LAN IP**。

- **时间**：2026-10-22 01:09–01:12 Asia/Shanghai（CST）
- **范围**：只读；未改配置、未重启、未下载
- **接入**：MateBook `machineId=43fb3826-537c-4bd2-93e2-ebcb07818e95` → SSH **LAN 别名**（`workstation-lan` / `sk01-l` / `sk02-l` / `openclaw0*-lan` / `core`）
- **失败通道**：默认 `Host workstation|spark0*|openclaw0*`（IPv6/公网）超时；`*-pub`（lab.wineryz.top）超时；`nas` SSH `Permission denied (publickey)`（主库路径仅按文档注明）

证据类型约定：
- **产品默认写死**：gate `model-config.template.json` / core `deploy/.env` / AGENTS
- **服务加载中**：systemctl/launchd + nvidia-smi/进程 cmdline + 健康接口
- **文档宣称但未核实**：文中单独标注

---

## 总表

| 设备 | 服务/端口 | 状态(真机) | 在用模型(文件名或 served-name) | 证据来源 |
|---|---|---|---|---|
| **workstation** | comfyui-lb `:8188` | active/enabled | LB 池后端：`:8196` / `:8263` / `:8265`（无独立权重） | `systemctl`；`/opt/comfyui-lb/backends.json` |
| workstation | comfyui-gpu0-alt `:8196` | active；GPU0 常驻 ~56.7 GiB | **产品默认写死（盘点当时）**：`Qwen-Rapid-AIO-SFW-v11.safetensors` → **现已切 SFW-v23**；引擎按作业加载（近期 history 见 `10eros_v14` / `majicMIX…` / `gemma3_12b…` 等，≠默认） | gate 当时 `…SFW-v11…`；**现** `…SFW-v23.safetensors`；`nvidia-smi`+cmdline；`/history?max_items=5` |
| workstation | comfyui-longcat `:8197` | active；GPU0 ~24.3 GiB | **产品通道**：Wan / LongCat / VACE（gate engine=`wan`/`longcat`/`vace`/`continue`/`avatar`，**未写死单一权重文件名**）；盘上可见例：`LongCat/LongCat_TI2V_comfy_fp8_e4m3fn_scaled_KJ.safetensors`、各类 Wan2.2/VACE | gate wan channel；`object_info` WanVideoModelLoader；进程 `--port 8197` |
| workstation | toiv-comfyui-h3-gpu1 `:8264` | active；GPU1 ~40.2 GiB | **产品默认写死**：`minimax_h3_fl2va_pruned_int8_convrot.safetensors`（fl2va）/ `minimax_h3_ref2va_pruned_int8_convrot.safetensors`（ref2va）；NAS 主库有同名文件 | gate H3 profiles；`object_info` UNET；`ls` NAS `h3/diffusion_models/` |
| workstation | toiv-vlm `:9311` | active；GPU3 VLLM::EngineCore ~44.6 GiB | served **`toiv-vlm`** ← `/home/merlin/models/Qwen3-VL-8B-Instruct`（~17 G） | `systemctl cat`；`curl /v1/models` |
| workstation | comfyui-upscale-gpu2 `:8262` | active；GPU0 ~0.9 GiB | 超分 worker；盘上 **`4x-UltraSharp.pth`**（`/opt/ComfyUI/models/upscale_models/` + NAS 同名）。**unit 未写死模型名**（作业图指定） | `systemctl`+cmdline；`ls`；AGENTS 宣称 UltraSharp |
| workstation | comfyui-upscale-gpu3 `:8263` | active；GPU3 ~1.4 GiB；**在 LB 池** | 同上，UltraSharp 路径可见、unit 未钉名 | 同上；`backends.json` |
| workstation | comfyui-gpu2-gen `:8265` | active；GPU2 ~1.9 GiB；**在 LB 池** | 通用 Comfy worker（无单一写死 checkpoint） | `systemctl`；`backends.json` |
| workstation | comfyui-animate2 `:8199` | active；GPU3 ~0.5 GiB | **产品通道**：Wan Animate2（gate `local-wan-animate` → `:8199`）；权重按作业从 NAS/extra 加载 | `systemctl is-active`；gate；cmdline |
| workstation | qwen3-embedding `:9302` | active；GPU1 ~17.7 GiB | **`Qwen3-Embedding-4B`**（`MODEL_PATH=/home/merlin/models/Qwen3-Embedding-4B`）；health=`qwen3-embedding-4b` | unit env；`curl /health`；core `TOIV_EMBED_MODEL` |
| workstation | toiv-indextts `:9200` | active；GPU0 ~8.1 GiB | **IndexTTS 2.5**；`checkpoints/gpt.pth` size=**3259599833**（匹配 2.5）；health `engine=indextts2 version=2.5 model_loaded=true` | unit；`ls`+size；`curl /health` |
| workstation | toiv-audio-sep `:9220` | active | **demucs-htdemucs**（本地 `demucs-models`）；health `engine=demucs-htdemucs` | 源码注释+`/health` |
| **spark02** | dsv4_60 → `:8000` | docker Up 5 weeks；`/v1/models` OK | served：**`deepseek-v4-flash-dspark`** + 别名 **`qwen3.8-27b` / `qwen3.6-uncensored` / `glm-5.3-flash`**；权重目录 `~/models/dsv4-flash-dspark-abliterated`（~156 G） | `curl /v1/models`；`dsv4-serve.sh`；`docker ps` |
| **spark01** | dsv4_60 TP2 rank1 | docker Up；**本机 :8000 不监听** | 同权重 TP2 **worker（headless, node-rank 1）**；不对外单独 serve 模型名 | `docker inspect` Cmd `--headless --node-rank 1`；curl :8000 失败 |
| **openclaw01** | whisper `:9310` | launchd `com.toiv.whisper` 监听 | **`mlx-community/whisper-large-v3-mlx`**（mlx-whisper）；health `whisper-mlx` | `server.py`；`/health`；`lsof` |
| openclaw01 | JoyCaption `:9305` | launchd `com.toiv.joycaption` | **`n-Arno/joycaption-mlx-mxfp4`**；health `model_loaded=true` | `server.py`；`/health` |
| **openclaw02** | `:9310` / `:9305` | 同上均在听 | 与 01 同栈（同端口/同服务名）；**模型字符串未在 02 再读源码**（结构一致，按同部署） | launchd+listen；**模型名=01 核实、02–04 推断同构** |
| **openclaw03** | `:9310` / `:9305` | 同上 | 同上 | 同上 |
| **openclaw04** | `:9310` / `:9305` | 同上 | 同上 | 同上 |
| **core** | toiv-api/web/admin | running | **无本地大模型**；指针见下节 | `systemctl`；`deploy/.env`（值已脱敏） |
| **NAS** | SMB 主库 | SSH 本轮失败 | 主库路径（文档）：`toiv/comfyui-models`；WS 挂载 `/home/merlin/nas_mount`；core `/mnt/toiv-nas` | AGENTS §四；**未做全盘扫描** |

---

## 分设备摘要

### workstation（192.168.71.127 / TS 100.68.100.90）

| systemd | 真机 |
|---|---|
| comfyui-lb, comfyui-gpu0-alt, comfyui-longcat, toiv-comfyui-h3-gpu1, toiv-vlm, comfyui-upscale-gpu2/3, comfyui-gpu2-gen, qwen3-embedding, toiv-indextts, toiv-audio-sep | **全部 active + enabled** |
| comfyui-animate2 `:8199` | **active**（任务单未列但真机在跑） |

**GPU 快照（nvidia-smi）**

| idx | UUID 前缀 | 显存 used | 主要进程 |
|---|---|---|---|
| 0 | c2193dfe… | ~90 GiB | `:8196` Comfy ~57G；`:8197` LongCat ~24G；IndexTTS ~8G；`:8262` upscale ~0.9G |
| 1 | 8a63d89c… | ~58 GiB | H3 `:8264` ~40G；Embedding ~18G |
| 2 | 0e6e9149… | ~2 GiB | `:8265` gpu2-gen |
| 3 | 91a1da03… | ~47 GiB | VLM EngineCore ~45G；`:8263` upscale；`:8199` animate2 |

**产品默认写死（gate）**

- 出图：**现** `Qwen-Rapid-AIO-SFW-v23.safetensors`（`:8196` / LB `:8188`；盘点当时为 v11）
- H3：`minimax_h3_*_pruned_int8_convrot.safetensors`（fl2va / ref2va）→ `:8264`
- 文本/助手（canvas）：`deepseek-v4-flash-dspark`（经 Spark `:8000`）
- Wan 通道：engine 名，不钉单一文件

**盘上相关文件（抽查，非全库）**

- IndexTTS `checkpoints/gpt.pth` = 2.5 标准大小 ✔
- VLM / Embedding 本地目录存在
- `4x-UltraSharp.pth` 在 Comfy 与 NAS 均有
- Qwen：`Qwen-Rapid-AIO-SFW-v23` **= 当前 gate 默认**；v11/v18 仍在盘；另有 NSFW-v23 等（非 SFW 默认）

### spark02 / spark01

- **对外模型名（spark02 `:8000`）**：`deepseek-v4-flash-dspark` + 三别名（上表）
- **权重**：`dsv4-flash-dspark-abliterated`（同一 `/model`）
- **spark01**：TP2 rank1 headless worker，不单独暴露 `:8000`

### openclaw01–04

- Whisper：`mlx-community/whisper-large-v3-mlx`
- JoyCaption：`n-Arno/joycaption-mlx-mxfp4`
- 四机 LAN SSH **均可连**（与 AGENTS「01 拒连」旧记不符——至少本轮 LAN OK）

### core（指针，无密钥）

| 键 | 指向（脱敏） |
|---|---|
| `TOIV_LLM_BASE_URL` | `http://192.168.71.84:8000/v1`（spark02） |
| `TOIV_LLM_MODEL` | `qwen3.8-27b`（**别名**；与 gate 默认名 `deepseek-v4-flash-dspark` 不同键、同后端权重） |
| `TOIV_LLM_DISPLAY_NAME` | 仍写「Qwen3.8-27B-NVFP4…」——**文案过时**（真机已是 DSv4 flash dspark） |
| `TOIV_LLM_PROXY_MODELS` | 含四 served 名 |
| `TOIV_WHISPER_URL` | `http://192.168.71.86:9310`（openclaw01） |
| `TOIV_VLM_*` | workstation `:9311` / `toiv-vlm` |
| `TOIV_EMBED_*` | workstation `:9302` / `Qwen3-Embedding-4B` |
| `TOIV_TTS_URL` | workstation `:9200` |
| `TOIV_H3_BASE_URL` | workstation TS `:8264` |
| `TOIV_LONGCAT_BASE_URL` | `:8197` |
| `TOIV_QWEN_EDIT_BASE_URL` / `TOIV_COMFY_WORKERS` | `:8196` |
| `TOIV_COMFY_WORKERS_REGISTRY_URL` | LB `:8188/admin/backends` |

### NAS

- 未 SSH 进 nas；主库口径：`toiv/comfyui-models`（WS=`/home/merlin/nas_mount/...`，core=`/mnt/toiv-nas/...`）
- 本轮经 WS 挂载抽查了 H3 / Qwen / UltraSharp 若干文件

---

## 口径区分（给拍板用）

| 类别 | 内容 |
|---|---|
| **产品默认写死** | 出图 **SFW-v23**（盘点当时 v11）；H3 int8 pruned fl2va/ref2va；canvas LLM 名 `deepseek-v4-flash-dspark`；core 实际请求名常为别名 `qwen3.8-27b` |
| **服务加载中（已核实）** | IndexTTS 2.5；VLM Qwen3-VL-8B→`toiv-vlm`；Embedding 4B；DSv4 四名；Whisper large-v3-mlx；JoyCaption mxfp4；Demucs htdemucs；各 Comfy/LB 端口 active |
| **按作业动态 / 未钉死单文件** | `:8196/:8197/:8199` 与超分——权重来自工作流；UltraSharp 为文档+盘上文件，unit 未写死 |
| **文档宣称需留意** | core `TOIV_LLM_DISPLAY_NAME` 与真机 DSv4 不一致；AGENTS「openclaw01 SSH 拒连」本轮 LAN 可连 |

---

## SSH 失败记录

| 目标 | 结果 |
|---|---|
| `workstation` / `spark01` / `spark02` / `openclaw0*`（默认 Host） | connect timeout（IPv6/公网） |
| `*-pub`（lab.wineryz.top） | connect timeout |
| `nas` | Permission denied (publickey) |
| `*-lan` / `sk0*-l` / `core` / `core-ts` | **成功**（本报告真机数据来源） |
