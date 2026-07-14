# ToIV · 项目初始化文档

> 由项目管理中枢自动生成 | 更新日期: 2026-07-12 | 负责人: zhwangsir

## 一、项目基本信息

| 字段 | 值 |
|------|----|
| 项目名称 | ToIV |
| 当前版本 | 0.0.1（P0 阶段：网页 → 出图主链路打通） |
| 创建日期 | 2026 年（对标 Liblib / 堆友的 ComfyUI 超级平台） |
| 负责人 | zhwangsir |
| 项目路径 | /Users/wangzhenyu/Desktop/ALLProject/ToIV |
| 远程仓库 | https://github.com/zhwangsir/ToIV |
| 仓库可见性 | 公开（Public） |
| 线上地址 | （Docker 部署：API http://localhost:8090，Web http://localhost:3100）|

## 二、项目概述与核心功能

### 2.1 项目定位
以 AI 为核心驱动的 ComfyUI 超级平台（全能工作台），目标对标并超越 Liblib / 堆友，降低 ComfyUI 使用门槛，打通"模型管理 → 生成 → 训练 → 工作流编排"全链路，最终由 AI Harness 统一驱动。核心能力为 AI 生成类内容：图像 / 视频 / 语音 / lipsync / CAD / 3D。

### 2.2 核心功能列表
- **图像生成**：txt2img / img2img / inpaint / upscale / removebg / ControlNet / IPAdapter / FaceDetailer / LoRA
- **视频生成**：Wan I2V / Wan T2V / Hunyuan I2V / 帧插值
- **语音与 lipsync**：ACE-Step 音频、多语言 TTS、lipsync、配音（dub / dub_anime / dub_text / dub_voice）
- **CAD / 3D**：CAD 轴测图转换、Hunyuan3D 三维生成、CAD 设计工作流
- **AI Agent**：自带 RAG 知识库（ComfyUI 教程 / 模型目录 / 参数参考）+ LLM 工具调用
- **模型市场**：Civitai 模型市场集成（走 civitai.red 镜像）、NAS 模型库（绿联 DXP8800）
- **Manju 工作流**：分镜 / 时间线 / 故事板编排
- **训练与优化**：训练工作流、图像评分（ImageReward）、NSFW 上下文分级放行
- **画布编排**：基于 @xyflow/react 的节点画布，可视化工作流编排

### 2.3 目标用户
需要使用 ComfyUI 但不熟悉命令行与节点编排的内容创作者；对图像 / 视频 / 语音 / 3D 生成有批量与质量要求的 AI 内容生产团队。

## 三、技术架构

### 3.1 技术栈
- **后端**：Python 3.11+ / FastAPI 0.137 / uvicorn / SQLModel / httpx / websockets / sse-starlette / pyjwt / paramiko / pillow
- **前端**：Next.js 15（App Router）/ React 19 / TypeScript 5.7 / @xyflow/react 12 / framer-motion 12
- **生成引擎**：ComfyUI（多 worker 池，4 卡 RTX PRO 6000 + PC01 5090）/ Forge
- **AI 大脑**：LM Studio（qwen/qwen3.6-35b-a3b）+ 本地嵌入（text-embedding-nomic-embed-text-v1.5）
- **部署**：Docker / docker-compose / OpenResty 反代
- **包管理**：后端 uv（pyproject.toml + uv.lock）；前端 npm

### 3.2 架构说明
```
Next.js 前端(:3100)  ──HTTP/SSE──>  FastAPI 后端(:8080)  ──REST/WS──>  ComfyUI worker 池
                                      （图片由后端代理，前端不直连 ComfyUI）
```
后端按"worker 池"设计：P0 单实例；P2 起把 4 张 RTX PRO 6000 各自的 ComfyUI 进程填进 `TOIV_COMFY_WORKERS` 即可水平扩展。后端启动时引导管理员账号、重挂未终态作业的追踪（防长视频作业孤儿化）并周期性自愈。NSFW 通过请求头 `X-NSFW: 1` 经 ContextVar 放行，不动账户开关。

### 3.3 核心依赖
- fastapi>=0.115、uvicorn[standard]>=0.32、httpx>=0.27、websockets>=13、sse-starlette>=2.1
- pydantic-settings>=2.5、sqlmodel>=0.0.22、pyjwt>=2.9、python-multipart>=0.0.12
- paramiko>=3.4（NAS SSH/SFTP）、pillow>=12.3.0
- next ^15.1.0、react ^19.0.0、@xyflow/react ^12.11.1、framer-motion ^12.40.0
- 可选：image-reward（图像评分）

## 四、目录结构

```
ToIV/
├── apps/
│   ├── api/                       FastAPI 后端
│   │   ├── app/
│   │   │   ├── agent/             AI Agent（llm/rag/runner/tools + knowledge 知识库）
│   │   │   ├── cad/               CAD 转换（axon 轴测 / convert DWG）
│   │   │   ├── comfy/             ComfyUI 客户端（client/pool/tracker 作业追踪）
│   │   │   ├── forge/             Forge 引擎客户端
│   │   │   ├── routes/            29 个路由模块（auth/generate/video/cad/agent...）
│   │   │   ├── workflows/         ComfyUI 工作流构建器（txt2img/wan_i2v/lipsync/hunyuan3d...）
│   │   │   ├── main.py            FastAPI 装配入口
│   │   │   ├── config.py          配置（pydantic-settings，TOIV_ 前缀）
│   │   │   ├── db.py              SQLModel 数据库 + bootstrap_admin
│   │   │   ├── nas.py             NAS 模型存储
│   │   │   ├── security.py        鉴权 / ratelimit / nsfw_ctx / scoring / usage
│   │   │   └── capabilities.py    平台能力声明
│   │   ├── tests/                 33 个测试文件（pytest-asyncio）
│   │   ├── .env.example
│   │   ├── Dockerfile
│   │   ├── pyproject.toml / requirements.txt / uv.lock
│   ├── web/                       Next.js 前端
│   │   ├── app/                   App Router（engine/login/nsfw 页）
│   │   ├── components/            canvas/create/dub/manju/cad/threed/audio/train...
│   │   ├── lib/                   api.ts / swr-cache.ts / trackJob.ts
│   │   ├── Dockerfile / next.config.mjs / package.json
├── deploy/
│   ├── docker-compose.yml         toiv 服务编排（api+web+NAS cifs 卷）
│   ├── .env.example               部署环境变量
│   ├── deploy.sh / download-model.py / download_models.sh
│   ├── openresty-toiv.conf        反代配置
│   ├── toiv_model_paths.yaml      模型路径
│   └── start-toiv-trainer.py / start-toiv-workers.py
├── docs/
│   ├── TOIV_MASTER.md             主文档
│   ├── 平台现状报告-2026-07-04.md
│   ├── PRODUCT-DIAGNOSIS.md       产品诊断
│   └── UI-RECONSTRUCTION.md       UI 重构
├── README.md / AI-Design-System-Prompt.md
├── download_llm.py / download_lora.py / patch_llava.py / check_status.py / submit_test.py
```

### 关键文件功能说明

| 路径 | 功能 |
|------|------|
| apps/api/app/main.py | FastAPI 应用装配，注册 29 个路由 + lifespan 自愈 |
| apps/api/app/config.py | 配置读取（TOIV_ 前缀环境变量） |
| apps/api/app/comfy/pool.py | ComfyUI worker 池调度 |
| apps/api/app/comfy/tracker.py | 作业追踪 + 重启自愈 reconcile_loop |
| apps/api/app/agent/rag.py | RAG 检索（ComfyUI 知识库） |
| apps/api/app/workflows/*.py | 各类 ComfyUI 工作流构建器 |
| apps/web/components/canvas/CanvasStudio.tsx | 节点画布编排主组件 |
| apps/web/components/create/CreateStudio.tsx | 生成工作台主组件 |
| deploy/docker-compose.yml | 生产部署编排（API 8090 / Web 3100 / NAS 卷） |
| deploy/openresty-toiv.conf | OpenResty 反向代理配置 |

## 五、环境搭建

### 5.1 前置环境要求
- Python 3.11+（推荐 3.12）+ uv
- Node.js（支持 Next.js 15 / React 19）+ npm
- Docker + docker-compose（生产部署）
- 可访问的 ComfyUI 实例（默认 http://192.168.71.100:8000）
- 可选：LM Studio（AI Agent 大脑）、NAS（绿联 DXP8800，模型存储）

### 5.2 依赖安装步骤
后端：
```bash
cd apps/api
cp .env.example .env          # 按需修改 ComfyUI 地址
uv sync --extra dev
```
前端：
```bash
cd apps/web
cp .env.local.example .env.local
npm install
```

### 5.3 环境变量配置
变量名（前缀 `TOIV_`，详见 apps/api/.env.example 与 deploy/.env.example）：
- TOIV_COMFY_WORKERS
- TOIV_DEFAULT_CKPT
- TOIV_CORS_ORIGINS
- TOIV_JWT_SECRET
- TOIV_ADMIN_EMAIL
- TOIV_ADMIN_PASSWORD
- TOIV_TTS_MULTILINGUAL_URL
- TOIV_DATABASE_URL
- TOIV_LLM_BASE_URL
- TOIV_LLM_MODEL
- TOIV_EMBED_MODEL
- TOIV_TEST_KEY
- TOIV_CIVITAI_API_KEY
- TOIV_NAS_HOST
- TOIV_NAS_USER
- TOIV_NAS_PASSWORD
- TOIV_CONTENT_DIR
- NEXT_PUBLIC_API_BASE（前端）

## 六、启动与运行

### 6.1 开发模式启动
后端（默认 :8080）：
```bash
cd apps/api
uv run uvicorn app.main:app --reload --port 8080
uv run pytest                 # 跑测试
```
前端（默认 :3100）：
```bash
cd apps/web
npm run dev                   # http://localhost:3100
```
浏览器打开 http://localhost:3100，输入提示词点击「生成」。

### 6.2 生产构建
后端：Docker 镜像（apps/api/Dockerfile）
前端：`npm run build` → `npm start`（或 Docker 镜像 apps/web/Dockerfile）

### 6.3 部署方式
Docker Compose 一键部署（deploy/docker-compose.yml）：
```bash
cd deploy
cp .env.example .env          # 必填 TOIV_JWT_SECRET
docker compose up -d
```
- API 容器映射 8090:8080
- Web 容器映射 3100:3100
- toiv-data 卷挂载 /data；toiv-nas 卷（cifs）挂载绿联 NAS（按需）
- 默认 ComfyUI worker 列表：4 卡 PRO6000（8000/8002/8003/8004）+ PC01 5090（Tailscale 8188）

## 七、主要接口说明
所有路由统一前缀 `/api`，健康检查 `GET /api/health`（返回 workers 列表）。主要路由模块：
- **鉴权**：auth（登录/JWT）、account、admin（后台管理）
- **生成**：generate（图像生成 best-of-n）、images（产物代理）、video、threed、audio、voice、lipsync
- **配音**：dub、dub_anime、dub_text、dub_voice
- **CAD / 模型**：cad、forge、models、nas_models、marketplace（Civitai）
- **作业**：jobs（SSE 进度）、upload、optimize、score（ImageReward 评分）、train
- **AI Agent**：agent（RAG + 工具调用）
- **Manju**：manju、manju_project、assembly
- **系统**：system

## 八、已知问题与注意事项
- 生产务必设置高强度随机的 `TOIV_JWT_SECRET`（生成：`python3 -c "import secrets;print(secrets.token_urlsafe(48))"`）
- 不开放自助注册，其余账号由管理员在后台发放
- NAS cifs 卷仅在配置 `TOIV_NAS_*` 时挂载，未配时卷创建会失败
- NSFW 内容通过 `/nsfw` 专页 + `X-NSFW: 1` 请求头放行，不动账户开关
- 长视频作业孤儿化由 reconcile_loop 自愈
- 详细产品诊断与 UI 重构计划见 docs/PRODUCT-DIAGNOSIS.md、docs/UI-RECONSTRUCTION.md

## 九、与其他项目的关系
- **与 BIM**：BIM 是从 ToIV 拆出的独立项目，复用同一套 ComfyUI GPU 集群出图，自带鉴权 / 作业 / 图片代理；BIM 用 `BIM_` 前缀环境变量与 ToIV 的 `TOIV_` 隔离，可同机共存；BIM 聚焦房屋全生命周期的 CAD → AI 渲染。
- **与 AICG-DownLoader**：ToIV 是网页端工作台；AICG-DownLoader 是桌面端模型下载器，为 ComfyUI 用户下载模型到正确目录（ToIV 的模型管理对应网页侧，AICG 对应桌面侧）。
- **与 flipped**：flipped 是 AI 自动化开发工厂，可作为 ToIV 这类项目的自主开发工具链（给方向 → 自行拆解写码跑测修错循环）。
