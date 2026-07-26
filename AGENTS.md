# AGENTS.md — ToIV

> 本文件为 AI 协作规范,所有 Agent 在本仓库工作时必须遵守。

---

## 一、项目概述

- **定位**: ToIV AI 工作台,NAS 文件管理 + API
- **版本**: 主分支持续迭代
- **技术栈**: Python 3.11+ / FastAPI / Uvicorn + Docker
- **核心能力**:
  - NAS 文件浏览/上传/下载
  - AI 工作台 API (任务编排、文件预处理)
- **部署位置**: Workstation Docker (`toiv-api :8090`, `toiv-web :3100`)

---

## 二、项目结构

```
ToIV/
├── backend/
│   ├── app.py               # FastAPI 入口 (uvicorn app:app)
│   ├── routers/             # 文件/任务/AI 路由
│   ├── services/
│   │   ├── nas_service.py    # NAS SMB/API 集成
│   │   └── task_service.py   # 任务编排
│   ├── models/              # Pydantic 模型
│   └── requirements.txt
├── web/                     # 前端 (若存在,统一 lucide-react)
├── docker/
│   ├── Dockerfile.api
│   └── Dockerfile.web
├── docker-compose.yml       # toiv-api :8090, toiv-web :3100
└── AGENTS.md
```

---

## 三、开发命令

### 本地开发

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
uvicorn app:app --reload --port 8090
```

### Docker 部署 (Workstation)

```bash
docker compose up -d --build
# toiv-api: http://192.168.71.127:8090
# toiv-web: http://192.168.71.127:3100
```

---

## 四、代码规范

### Python (后端)
- 类型注解必填,Pydantic v2 模型
- 路由层薄,业务逻辑入 `services/`
- NAS 操作必须处理超时与权限错误,不得吞异常
- 文件路径必须做沙箱校验,禁止路径穿越 (`..`)

### 前端 (若存在)
- TypeScript `strict: true`
- 图标统一 `lucide-react`
- API 调用经封装层

---

## 五、测试策略

| 层 | 工具 | 命令 | 重点 |
|---|---|---|---|
| 后端单元/接口 | pytest | `cd backend && pytest -v` | NAS 集成、路径校验、任务编排 |
| Docker | docker compose config | `docker compose config` | 配置有效性 |

- 必须测试: 路径穿越防护
- 必须测试: NAS 不可达时的降级

---

## 六、集群依赖

> 完整集群拓扑详见 `/Users/wangzhenyu/Desktop/ALLProject/ToIV/设备说明.md`（core 监控中心维护，2026-07-27 最新版，626 行）
> AICG 四层模型接入配置详见 `/Users/wangzhenyu/Desktop/ALLProject/AICG-模型接入配置.md`

### AICG 四层模型流水线（2026-07-24 项目管家确认）

ToIV 是 AICG 短剧平台的实现项目，应接入四层模型流水线：

| 层 | 用途 | 端点 | 模型 ID | 引擎 |
|----|------|------|---------|------|
| L1 初稿 | 实时交互（已接入） | `http://192.168.71.127:8000/v1` | `qwen3.6-uncensored` | vLLM (Nemotron-3-Nano-Omni) |
| L2 主力润色 | 关键场景（待接入） | `http://192.168.71.109:52415/v1` | `mlx-community/Kimi-K2.7-Code-4bit` | EXO |
| L3 终稿精修 | 异步批量（待接入） | `http://192.168.71.109:52415/v1` | `mlx-community/GLM-5.2-fp8` | EXO |
| L4 NSFW | 无审查（已接入） | `http://192.168.71.82:8000/v1` | `euryale-70b` | vLLM TP=2 |

**L2/L3 接入要点**（ToIV 待办）：
- EXO 两个模型默认开启 thinking，reasoning token 占 80%+，需测试 `chat_template_kwargs.enable_thinking: false` 是否生效
- 若 EXO 不支持 API 参数关闭，用 prompt 抑制："直接输出最终内容，不要输出思考过程"
- L2 timeout 120s，L3 timeout 300s（GLM-5.2-fp8 实测 115s/句）

### 集群设备状态（2026-07-24 核实）

- **NAS SMB**: `192.168.71.7:445`,挂载点 `/home/merlin/nas_mount` (Workstation)
- **Workstation**: LAN `192.168.71.127`（主网卡 DOWN，副网卡在用）/ Tailscale `100.68.100.90`（注意：旧 IP `100.99.181.103` 已失效）
- **Workstation Docker**: `toiv-api :8090` / `toiv-web :3100` 已运行
- **ComfyUI-LB**: `http://192.168.71.127:8188`，5 后端（本地 :8189-8191 + pc01:8188 + pc02:8193；GPU3 :8192 已让给 Nemotron LLM）
- **pc01 ComfyUI**: 已启动（v0.28.0，HTTP 200，开机自启）
- **Mac Studio EXO**: `http://192.168.71.109:52415`（4 台 M3 Ultra 512GB RDMA 集群，L2/L3 模型源）
- **Mac Studio OpenClaw**: 已清理（2026-07-24），Mac Studio 专职 EXO RDMA 内存池
- **Mac Mini OpenClaw**: 4 台（openclaw01-04）是 OpenClaw 唯一正式部署设备，与 ToIV 无直接依赖
- **Spark01 Euryale 70B**: `http://192.168.71.82:8000`（vLLM TP=2 跨 spark01+02，spark02 是 Ray worker 无独立端口）

NAS 凭据通过环境变量注入,禁止硬编码。

---

## 七、提交规范

- **不主动提交**: 用户未明确要求时不执行 `git commit`/`git push`
- **Conventional Commits**:
  - `feat(nas): add recursive listing`
  - `fix(task): handle timeout on large upload`
  - `docs: update AGENTS.md`
- 范围优先: `nas` / `task` / `api` / `web` / `docs`

---

## 八、项目隔离纪律

- **禁止跨项目修改**: 不得修改 `AIHub/`、`DRT管理中心/` 等其他项目源码
- **共享基础设施不耦合**: 复用 Workstation Docker 与 NAS,但容器独立、网络独立
- **Docker 隔离**: 本项目 compose 独立,不复用其他项目的卷/网络
- **配置隔离**: 通过 `.env` 注入 NAS 凭据与端口

---

## 九、图标规范

- **统一使用 Lucide React** (`lucide-react`),禁止 emoji、禁止其他图标库
- 按需引入: `import { Folder, Upload, FileText } from 'lucide-react'`
- 已存在的 emoji 必须在下次重构时替换

---

## 十、Agent 行为底线

1. 改动前先读相关文件,理解 NAS 集成逻辑
2. 不创建未要求的文件/文档
3. 测试失败不重复同一修复路径
4. 完成后给出简明报告

---

## 端口配置

> 参考: /Users/wangzhenyu/Desktop/ALLProject/项目端口规划指南.md

| 服务 | 端口 | 说明 |
|------|------|------|
| 前端 dev (apps/web) | 3101 | 本地开发 |
| 前端 prod (Docker) | 3100 | Workstation Docker toiv-web |
| 后端 dev (apps/api) | 3102 | 本地开发 |
| 后端 prod (Docker) | 8090 | Workstation Docker toiv-api |

**禁止使用 Vite 默认 5173 / Next.js 默认 3000**。端口段 31XX 专属 ToIV。
