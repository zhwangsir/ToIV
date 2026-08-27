# ToIV

以 AI 驱动的 ComfyUI 超级平台：把模型管理、图像/视频/音频生成、短剧与画布编排、3D、数字人、LoRA 训练串在同一条业务链路上。生产跑在 **core**（web `:3100` + api `:8090`），算力在 **Workstation**（4×RTX PRO 6000）；core 只做业务网关，不是 GPU 来源。

面向本机与局域网使用者（Winery 集群）。竞品对照是建设方向，不是完成声明。

最后更新：2026-08-27。

## 这是什么 / 能做什么

Web 端（`apps/web`）当前真实模块（见 `app/page.tsx` 的 `VIEW_META`）：

| 模块 | 做什么 |
|------|--------|
| 对话 | AI 助手（SSE 流式、工具调用、会话管理） |
| 图片 / 视频 / 音频 | 多引擎生成（含 H3 文生/图生视频、LongCat、音乐等） |
| 融合 | 多模态融合入口 |
| 图片编辑 / 视频剪辑 | 语义编辑、Aleph 式视频编辑、Motion Brush、关键帧链式转场、多镜头协议 |
| 动态分镜 / 创作 / 短剧 / 看板 | 短剧工作室、分镜与制片看板（`drama/` 为运行时素材，勿随意挪走） |
| 数字人 | 形象库、TTS 直通对口型、直播助手、绿幕抠像；通用对口型走 workstation `:9103` |
| 画布 | ComfyUI 画布（浏览器侧优先走 Tailscale 连 Workstation） |
| 训练 | LoRA trainer（workstation `:9100`）+ i2L 风格 LoRA（`:9101`） |
| 作品库 / 主体库 | 产物管理、主体/参考资产 |
| 模型 / 资源 / Skill 市场 | 模型浏览、资源与 Skill |
| 观测 / 设置 / 管理 | 集群舰队观测、账号与后台 |

后端（`apps/api`）是 FastAPI：作业编排、ComfyUI worker 池、鉴权、PostgreSQL 18 + Redis。视频评分器灰度走 spark01 上的 **Qwen3-VL-32B**；对话/编排用的 LLM 在 **spark02**。2026-08-26 起 core 对 Mac Studio 集群**零依赖**：反推 VLM 已迁 spark01，L2/L3 不在 Studio EXO 上。Studio 集群处于离线观察/退役，**不要假定它在为 ToIV 提供推理**。pc01 / pc02 作为 ComfyUI worker 经常不在线。

数字人实时链路会调用兄弟目录的 OpenTalking 进程（默认 `http://127.0.0.1:4403`；生产在 Workstation `:4403`）。**`opentalking/` 已从本仓移出**，现位于 `ALLProject/opentalking`，禁止再 vendor 进 ToIV。

移动端与小程序是本仓内的自治子树，不是独立 git 仓：

- [`Mobile/`](Mobile/) — Expo / React Native
- [`MiniProgram/`](MiniProgram/) — uni-app 微信小程序

## 生产与访问

业务进程在 **core**（LAN `192.168.71.47`，Tailscale `100.77.80.100`）：

| 服务 | 端口 | 说明 |
|------|------|------|
| toiv-web | `:3100` | Next.js 生产，systemd `toiv-web` |
| toiv-api | `:8090` | FastAPI 生产，systemd `toiv-api` |
| PostgreSQL 18 / Redis | 本机回环 | 只 bind `127.0.0.1`，从 LAN IP 探测会误报 down |

公网入口（经 frp / OpenResty，不含凭据）：

- `toiv.dgmt.top`（香港 cloud）
- `toiv.wineryz.top`（北京）

跨地区浏览器访问优先 Tailscale，不要把 LAN 地址写进给外网用户的入口。算力与引擎（ComfyUI、H3 `:8195`、trainer `:9100`、i2L `:9101`、TTS、3D 纹理等）全部在 Workstation；**完整设备/端口/GPU 表只在 [AGENTS.md](AGENTS.md)**，本 README 不复制。

部署：在本仓根执行 `bash deploy/deploy.sh`（rsync 到 core + 重启 + 健康等待）。前端变更必须干净重建 `apps/web/.next` 后再部署，并确认 `.next/BUILD_ID` 属于当次代码，否则会静默上线旧前端（见 DEVELOPMENT.md）。

## 技术栈与仓库布局


| 层 | 技术 |
|----|------|
| 后端 | FastAPI 0.115+ / Python 3.11+ / SQLModel / uvicorn |
| 前端 | Next.js 15 / React 19 / TypeScript |
| 数据 | PostgreSQL 18、Redis 7+（生产在 core） |
| 工作流 | ComfyUI + MiniMax H3 + LongCat/VACE 等专用实例 |
| 移动 | Expo SDK 57 / RN 0.86（Mobile/） |
| 小程序 | uni-app 3 + Vue 3 + Pinia + Vite 5（MiniProgram/） |

顶层目录：apps/api、apps/web、Mobile、MiniProgram、deploy、scripts、drama，以及五件套。opentalking 在兄弟目录，不在本仓。

## 本地开发

命令以 [DEVELOPMENT.md](DEVELOPMENT.md) 第 1 节为准，2026-08-27 核验仍有效。

### 后端（本机常听 :8080，不是生产的 :8090）

在 `apps/api` 复制环境示例后同步依赖并启动（开发端口 8080）：

    uv sync --extra dev
    uv run uvicorn app.main:app --reload --port 8080
    uv run pytest

### 前端（与生产相同端口 :3100）

在 `apps/web` 复制环境示例，安装依赖后启动开发服务器。浏览器打开 http://localhost:3100。

没有本机引擎时生成会失败，这是预期。Mobile / MiniProgram 见各自 README。

## 文档五件套

- README.md：产品入口（本文件）
- AGENTS.md：集群操作记忆（设备表只放这里）
- DEVELOPMENT.md：架构、接口、部署、测试、仓库结构
- STATE.json：状态快照，不要当产品说明读
- TEST_LOG.md：测试与核验日志

工作区总索引见上级 README 与项目登记册。

## 远程

双远程与工作区规则一致：

- origin：Gitee 主远程，https://gitee.com/Winery_z/ToIV.git
- github：GitHub，https://github.com/zhwangsir/ToIV.git

两边都推。未要求不要提交。模型与产物放 NAS，不入库。
