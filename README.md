# ToIV

以 AI 为核心驱动的 ComfyUI 超级平台（建设中）。目标:对标并超越 Liblib / 堆友 /running hub,降低 ComfyUI 使用门槛,打通"模型管理 → 生成 → 训练 → 工作流编排"全链路,最终由 AI Harness 统一驱动。

## 核心文档

- [AGENTS.md](AGENTS.md) - 集群操作记忆与决策记录(每次会话必读)
- [STATE.json](STATE.json) - 项目状态快照
- [TEST_LOG.md](TEST_LOG.md) - 测试日志
- [DEVELOPMENT.md](DEVELOPMENT.md) - 开发指南(架构/接口/部署/测试/排查)
- [README.md](README.md) - 项目入口(本文档)

## 快速开始

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

## 子项目

- **Mobile/** - 移动端(Expo/React Native),独立文档见 Mobile/docs/
- **MiniProgram/** - 小程序(uni-app),独立文档见 MiniProgram/docs/
- **opentalking/** - 第三方数字人项目,独立文档见 opentalking/docs/
