# AGENTS.md — ToIV

> 本文件为 AI 协作规范,所有 Agent 在本仓库工作时必须遵守。

---

## 一、项目概述

- **定位**: ToIV AI 工作台,NAS 文件管理 + API
- **核心原则 — 极致本地(2026-07-30 用户明确)**: 一切生成/推理负载必须本地集群完成,**禁止接入云端生成 API**(百炼/DashScope 等按量付费路线一律不用)。这是产品立身之本:只有全本地才能做 NSFW 等云端受限内容,也保证数据不出域。模型选型只考虑可下载权重的开源模型
- **版本**: 主分支持续迭代
- **技术栈**: Python 3.11+ / FastAPI / Uvicorn + Next.js 15 / TypeScript
- **部署方式**:
  - 开发:本地 uvicorn + next dev
  - 生产:真机 systemd 服务(core 192.168.71.47 为推荐目标;workstation 192.168.71.127 Docker 已全清,不再使用 Docker 部署)
- **核心能力**:
  - NAS 统一存储(成片/产出经 `/mnt/toiv-nas` 挂载读写,见第六节)+ NAS 模型下载接口(`/api/nas/*`)
  - AI 工作台 API (任务编排、文件预处理、ComfyUI 生成、TTS、RAG、短剧工作室、数字人)
  - 动态分镜双模式:快速拼接预览(`POST /api/animatic`)+ AI 解析生成完整短剧(`POST /api/drama/projects/from-image`,VLM 解析上传图片 → 自动建项目/分镜 → 后台 autorun 逐镜视频+配音+合成,进度在 project.process_data step=autorun)

---

## 二、项目结构

```
ToIV/
├── apps/
│   ├── api/                  # FastAPI 入口 (uvicorn app.main:app)
│   │   ├── app/
│   │   │   ├── main.py       # FastAPI 装配
│   │   │   ├── config.py     # Pydantic Settings
│   │   │   ├── routers/      # 路由
│   │   │   ├── services/     # 业务逻辑
│   │   │   └── ...
│   │   ├── requirements.txt
│   │   └── .venv             # 本地开发虚拟环境
│   └── web/                  # Next.js 前端
│       ├── app/              # App Router
│       ├── components/
│       ├── lib/
│       └── package.json
├── deploy/
│   ├── docker-compose.yml    # Docker 备选(Workstation 已禁用 Docker)
│   ├── bare-metal/           # 真机 systemd 部署(当前推荐)
│   │   ├── toiv-api.service
│   │   ├── toiv-web.service
│   │   ├── install.sh
│   │   └── README.md
│   ├── deploy.sh             # 真机部署脚本
│   ├── .env.example
│   └── README.md
├── docs/                     # 设计文档与变更记录
├── AGENTS.md                 # 本文件
└── STATE.json / TEST_LOG.md  # 状态与测试日志
```

---

## 三、开发命令

### 本地开发

```bash
# 后端
cd apps/api
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8090

# 前端
cd apps/web
npm install
npm run dev
```

### 生产部署(真机)

```bash
# 首次部署到 core
./deploy/deploy.sh --install

# 后续更新
./deploy/deploy.sh

# 临时部署到 workstation
./deploy/deploy.sh workstation --install
```

---

## 四、代码规范

### Python (后端)
- 类型注解必填,Pydantic v2 模型
- 路由层薄,业务逻辑入 `services/`
- NAS 操作必须处理超时与权限错误,不得吞异常
- 文件路径必须做沙箱校验,禁止路径穿越 (`..`)

### 前端
- TypeScript `strict: true`
- 图标统一 `lucide-react`
- API 调用经封装层

---

## 五、测试策略

| 层 | 工具 | 命令 | 重点 |
|---|---|---|---|
| 后端单元/接口 | pytest | `cd apps/api && pytest -q` | NAS 集成、路径校验、任务编排、RAG |
| 真机部署验证 | curl | `localhost:8090/openapi.json` / `localhost:3100` | 服务在线、环境变量生效 |
| Docker 配置(备选) | docker compose config | `docker compose config` | 仅当目标机有 Docker 时 |

- 必须测试: 路径穿越防护
- 必须测试: NAS 不可达时的降级
- 必须测试: Embedding 服务不可达时 RAG 降级

---

## 六、NAS 统一存储架构

ToIV 的所有产出与导入缓存统一放到 NAS，避免各设备本地重复存储。当前已启用短剧成片目录，其他目录预留。

### 目录规范

NAS 共享 `//192.168.71.7/NAS` 下统一目录：

```
//192.168.71.7/NAS/toiv/
├── outputs/
│   ├── drama/final/      # 短剧成片（已启用并验证）
│   ├── animatic/         # 动态分镜成片 {job_id}.mp4（已启用，ffmpeg @ workstation）
│   ├── images/           # 文生图/图生图输出（预留）
│   ├── videos/           # LiveAct 全身数字人镜头 liveact/{task_id}.mp4（已启用，worker @ workstation GPU1+2）+ liveact-samples/ 实测样片
│   └── audio/            # 配音/音频输出（预留）
├── imports/
│   └── animatic/{job_id}/ # 动态分镜上传原图（001.jpg… 按上传顺序编号）
└── (existing) comfyui-models / embeddings / tts / dub / manju / forge / reforge / funasr / hf_cache / toiv-trainer / vlm-* 保持不动
```

### core 挂载方式

core 通过 SMB 自动挂载 NAS：

| 项 | 配置 |
|---|---|
| 挂载点 | `/mnt/toiv-nas` |
| systemd unit | `mnt-toiv\x2dnas.mount`（连字符已转义） |
| 凭据文件 | `/etc/toiv/nas-credentials`（mode=600） |
| mount 选项 | `credentials=...,uid=1000,gid=1000,file_mode=0755,dir_mode=0755,soft,nounix,rsize=4194304,wsize=4194304,vers=3.0` |

要求提前安装 `cifs-utils` 并启用 unit：

```bash
sudo systemctl enable --now mnt-toiv\\x2dnas.mount
```

### 环境变量

生产环境通过 `TOIV_DRAMA_VIDEO_DIR` 指向 NAS 成片目录；NAS 不可达时代码自动降级到本地路径。

```bash
# core
TOIV_DRAMA_VIDEO_DIR=/mnt/toiv-nas/toiv/outputs/drama/final
```

### 代码降级策略

[`apps/api/app/routes/drama_analytics.py`](file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/api/app/routes/drama_analytics.py) 中 `_drama_root()` 实现以下逻辑：

1. 优先读取 `TOIV_DRAMA_VIDEO_DIR` 环境变量；
2. 若 NAS 路径因 `OSError`（网络/权限/超时）不可访问，记录 warning 并自动降级到本地候选路径；
3. 本地候选路径按 apps/api 实际布局匹配，保证开发与 Docker 回退可用。

### 新增产出迁移步骤

后续新增产出类型（图像、音频、其他视频）按同样模式迁移：

1. 在 NAS `toiv/outputs/` 下创建对应子目录；
2. 新增 `TOIV_<TYPE>_DIR` 环境变量指向 NAS 子目录；
3. 在读取函数中复用 `_drama_root()` 的降级模式（NAS → 本地回退）；
4. 更新本章节目录规范与 `deploy/.env`。

### 模型资产现状（2026-07-30）

NAS `//192.168.71.7/NAS/toiv/comfyui-models` 已完成 P0/P1 升级，所有新模型均落在对应子目录：

| 阶段 | 内容 | 路径 | 状态 |
|------|------|------|------|
| P0-1 | Qwen3-VL-8B-Instruct | `text_encoders/qwen_3_vl_8b_instruct/` | ✅ |
| P0-1 | Qwen-Image 2.0 | `diffusion_models/qwen-image/` | ✅ |
| P0-2 | PuLID Flux v0.9.0/v0.9.1 | `pulid/` | ✅ |
| P0-2 | EVA02-CLIP-L-14-336 | `clip_vision/` | ✅ |
| P0-2 | IPAdapter FaceID Plus v2 | `ipadapter/` | ✅ |
| P0-3 | ACE-Step 1.5 | `audio/Ace-Step1.5/` + `/home/merlin/toiv-scripts/ACE-Step/checkpoints` symlink | ✅ CPU 加载验证通过 |
| P1-1 | 42 场景 LoRA（古风/都市/校园/豪车/特效/恐怖/喜剧/历史战争/运镜/导演） | `loras/` | ✅ |
| P1-2 | Demucs v4 + MDX-Net ONNX + UVR5 模型 | `audio/uvr5_models/` + `/home/merlin/toiv-scripts/audio-sep-venv` | ✅ 测试通过 |

代码侧同步更新：
- `apps/api/app/workflows/model_profiles.py`：`_QWEN_IMAGE_CLIP_CANDIDATES` 已加入 `qwen_3_vl_8b_instruct` 目录候选。
- `apps/api/app/workflows/style_presets.py`：已新增 10 个短剧场景 LoRA 预设。

---

## 七、集群依赖

> 完整集群拓扑详见 `/Users/wangzhenyu/Desktop/ALLProject/ToIV/设备说明.md`（core 监控中心/设备管家维护,2026-07-28 最新版）
> AICG 四层模型接入配置详见 `/Users/wangzhenyu/Desktop/ALLProject/AICG-模型接入配置.md`

### 算力部署边界（2026-07-30 用户明确，必须遵守）

- **core 只部署应用层**：toiv-api、toiv-web，以及既有业务依赖 PG18 + Redis。**禁止**在 core 上跑 GPU 推理、批量计算任务、模型权重或大体积产出（core 仅有一张 GTX 1060 桌面卡，不承担推理）。
- **一切需要算力或大占用的负载跑 workstation**：LLM（L1 vLLM）、TTS（IndexTTS2）、Embedding、ComfyUI worker、数字人（opentalking 已迁入做实时对话,MuseTalk local 后端,GPU2）、模型训练等。
- **大体积产出落 NAS**（`//192.168.71.7/NAS`），core 通过 `/mnt/toiv-nas` 挂载读写，不在 core 本地沉淀（本地仅作 NAS 不可达时的降级回退）。
- 新功能接入算力服务时，默认指向 workstation/集群端点；如确需在 core 本地执行计算，必须先说明理由并经项目管家同意。

### AICG 四层模型流水线（2026-07-28 设备说明）

| 层 | 用途 | 设备 | 端点 | 模型 ID | 引擎 |
|----|------|------|------|---------|------|
| L1 初稿 | 实时交互(全模态) | Workstation | `http://192.168.71.127:8000/v1` | `qwen3.6-uncensored`(alias) | vLLM (Nemotron-3-Nano-Omni-30B-A3B BF16, GPU3) |
| L2 主力润色 | 关键场景 | Mac Studio EXO | `http://192.168.71.109:52415/v1` | `moonshotai/Kimi-K3` | EXO RDMA(⚠️ 无运行实例;2026-07-30 起 core .env 临时指向 spark `llama-3.3-70b-abliterated`,实例恢复后删 .env 两行回切) |
| L3 终稿精修 | 异步批量 | Mac Studio EXO | `http://192.168.71.109:52415/v1` | `mlx-community/GLM-5.2-DQ4plus-q8` | EXO RDMA(⚠️ 同上,临时走 spark) |
| L4 NSFW | 无审查 | Spark01+02 | `http://192.168.71.82:8000/v1` | `llama-3.3-70b-abliterated` | vLLM(✅ 2026-07-30 已接入 core .env 并验证) |

### ToIV 依赖服务（2026-07-28 设备说明）

| 服务 | 地址 | 用途 | 状态 |
|------|------|------|------|
| ToIV API | core:8090(待迁移) / workstation:8090(临时) | 后端 API | 待部署 |
| ToIV Web | core:3100(待迁移) / workstation:3100(临时) | 前端 | 待部署 |
| Nemotron LLM | `192.168.71.127:8000` | L1 + VLM | ✅ 真机 vLLM, GPU3 |
| IndexTTS2 | `192.168.71.127:9200` | TTS | ✅ 真机, GPU0 |
| Qwen3-Embedding-4B | `192.168.71.127:9302` | RAG 向量嵌入 | ✅ 真机, GPU1 |
| ComfyUI-LB | `192.168.71.127:8188` | 生成入口 | 5 后端 |
| ComfyUI gpu0-2 | `:8189-8191` | 本地 worker | ✅ |
| pc01 ComfyUI | `192.168.71.115:8188` | 远端 worker | ✅ |
| pc02 ComfyUI | `192.168.71.114:8193` | 远端 worker | ✅ |
| OpenTalking 数字人 | `192.168.71.127:4403` | 实时对话(LLM/STT/TTS/WebRTC),MuseTalk local 默认后端 + quicktalk 兜底,GPU2 | ✅ 2026-07-31 |
| AI-Omni ASR | `192.168.71.127:9210` | faster-whisper large-v3,ToIV 译制/语音听写已接入(2026-08-01,`TOIV_WHISPER_URL`,OpenAI 兼容端点);opentalking 默认仍用本地 SenseVoice | ✅ |
| ToIV Audio-Sep | `192.168.71.127:9220` | Demucs htdemucs 人声分离(译制参考音去 BGM,2026-08-01,`TOIV_AUDIO_SEP_URL`,POST /separate multipart→vocals wav;UVR5 MDX-Net 备选),GPU0,toiv-audio-sep.service | ✅ 2026-08-01 |
| LiveAct worker | `192.168.71.127:9400` | SoulX-LiveAct 14B 全身数字人离线生成(短剧分镜引擎,需先配音,FP4 双卡),GPU1+2 | ✅ 2026-07-31 |
| NAS SMB | `192.168.71.7:445` | 文件/模型存储 | ✅ |
| core PG18+Redis | `192.168.71.47:5432/6379` | 业务 DB/缓存 | ✅ 待 ToIV 接入 |

**关键变更(2026-07-28)**:
- Workstation Docker **全部清理**,toiv-api/web 不可再跑 Docker
- Embedding 端口从 `:1234`(原 LM Studio/Docker) 改为 `:9302`(真机 systemd `qwen3-embedding.service`, GPU1)
- TTS 在 GPU0,Nemotron 在 GPU3,ComfyUI 仅占 GPU0-2
- core 改为真机业务服务器,PG18+Redis 已就位,ToIV 生产建议迁移到 core

NAS 凭据通过环境变量注入,禁止硬编码。

---

## 八、提交规范

- **不主动提交**: 用户未明确要求时不执行 `git commit`/`git push`
- **Conventional Commits**:
  - `feat(nas): add recursive listing`
  - `fix(task): handle timeout on large upload`
  - `docs: update AGENTS.md`
- 范围优先: `nas` / `task` / `api` / `web` / `docs`

---

## 九、项目隔离纪律

- **禁止跨项目修改**: 不得修改 `AIHub/`、`DRT管理中心/` 等其他项目源码
- **共享基础设施不耦合**: 复用 Workstation Docker 与 NAS,但容器独立、网络独立
- **Docker 隔离**: 本项目 compose 独立,不复用其他项目的卷/网络
- **配置隔离**: 通过 `.env` 注入 NAS 凭据与端口

---

## 十、图标规范

- **统一使用 Lucide React** (`lucide-react`),禁止 emoji、禁止其他图标库
- 按需引入: `import { Folder, Upload, FileText } from 'lucide-react'`
- 已存在的 emoji 必须在下次重构时替换

---

## 十一、Agent 行为底线

1. 改动前先读相关文件,理解 NAS 集成逻辑
2. 不创建未要求的文件/文档
3. 测试失败不重复同一修复路径
4. 设备侧操作需先给出变更说明,经项目管家同意后方可执行
5. 完成后给出简明报告

---

## 端口配置

> 参考: /Users/wangzhenyu/Desktop/ALLProject/项目端口规划指南.md

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 dev (apps/web) | 3101 | 本地开发 |
| 前端 prod | 3100 | 真机 systemd toiv-web |
| 后端 dev (apps/api) | 3102 | 本地开发(可选) |
| 后端 prod | 8090 | 真机 systemd toiv-api |

**禁止使用 Vite 默认 5173 / Next.js 默认 3000**。端口段 31XX 专属 ToIV。
