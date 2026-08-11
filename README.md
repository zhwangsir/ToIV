# ToIV

以 AI 为核心驱动的 ComfyUI 超级平台（建设中）。目标:对标并超越 Liblib / 堆友 /running hub,降低 ComfyUI 使用门槛,打通"模型管理 → 生成 → 训练 → 工作流编排"全链路,最终由 AI Harness 统一驱动。

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
