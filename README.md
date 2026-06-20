# ToIV

以 AI 为核心驱动的 ComfyUI 超级平台（建设中）。目标:对标并超越 Liblib / 堆友,降低 ComfyUI 使用门槛,打通"模型管理 → 生成 → 训练 → 工作流编排"全链路,最终由 AI Harness 统一驱动。

> 当前阶段:**P0 — 网页 → 出图 主链路打通**。后续阶段见 `~/.claude/plans/`。

## 架构(P0)

```
Next.js 前端  ──HTTP/SSE──>  FastAPI 后端  ──REST/WS──>  ComfyUI(192.168.71.100:8000)
                              （图片由后端代理，前端不直连 ComfyUI）
```

后端按 "worker 池" 设计,P0 单实例;P2 起把 4 张 RTX PRO 6000 各自的 ComfyUI 进程填进 `TOIV_COMFY_WORKERS` 即可水平扩展。

## 目录

- `apps/api` — FastAPI 后端(Python 3.12 + uv)
- `apps/web` — Next.js 前端(App Router + TS)

## 本地启动

### 后端

```bash
cd apps/api
cp .env.example .env          # 按需修改 ComfyUI 地址
uv sync --extra dev
uv run uvicorn app.main:app --reload --port 8080
uv run pytest                 # 跑测试
```

### 前端

```bash
cd apps/web
cp .env.local.example .env.local
npm install
npm run dev                   # http://localhost:3100
```

浏览器打开 http://localhost:3100,输入提示词点击「生成」。
