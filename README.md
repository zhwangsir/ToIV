# ToIV

AI 短剧和画布。公网入口是 [toiv.wineryz.top](https://toiv.wineryz.top)。未登录看到的是官网静态页，登录后进 `/studio` 画布。品牌名只用 ToIV。

这份说明按仓库与线上核对过的事实写。没跑通的能力，不写成已经可用。

## 仓库

- GitHub：https://github.com/zhwangsir/ToIV.git
- Gitee（origin）：https://gitee.com/Winery_z/ToIV.git

线上构建号与本地 tip 分记；不要把当前仓库 tip 写成已经部署。双远程：每次 push 须 `git push origin HEAD && git push github HEAD`（本波未 push）。

## 运行口径（现行 · 2026-10-26）

完整主机/端口/权重 → [`AGENTS.md`](AGENTS.md)（集群真源）。

- **core**：`merlin@192.168.71.47`，web `:3100` · api `:8090` · admin `:3200`。
- **LLM**：spark02 **`:8888`** Mia，served `DeepSeek-V4.1-Flash-1017`（客户端兼容别名 `deepseek-v4-flash-dspark`）。
- **VLM**：workstation `:9311` `toiv-vlm`。
- **H3 生产**：workstation `:8264`。出图 LB `:8188`→8196/8263/8265；LongCat `:8197`；Animate2 `:8199`。
- **勿用死口**：`:8189` `:8195` `:8261` 等（见 AGENTS）。
- 权重在 NAS `toiv/comfyui-models`，不进 git。

## 工程结构

```
frontend/      app（Prime 创作壳）· admin（管理台）
backend/       api（FastAPI）
vendor/        canvas（画布冻结件）· legacy-web（旧 Next 主站）· mobile（uni-app 唯一移动端）
deploy/        部署脚本 / infra / 微服务
scripts/       e2e · eval · h3 · ops · bench
docs/          仅 README 索引 + 非 md 数据账本
skills/        agent 技能
third_party/   融合源工作树（不入仓业务）
```

不入仓：`tmp/` `node_modules` `.next` `.venv` `*.db`、模型权重等。

## 文档（五件套）

| 文件 | 用途 |
|---|---|
| [`README.md`](README.md) | 入口（本文件） |
| [`AGENTS.md`](AGENTS.md) | 会话规则 + **集群真源** |
| [`DEVELOPMENT.md`](DEVELOPMENT.md) | 开发与部署 + 现行设置/模型摘要 |
| [`TEST_LOG.md`](TEST_LOG.md) | 测试近窗 |
| [`STATE.json`](STATE.json) | 机读状态 |
| [`docs/README.md`](docs/README.md) | docs 唯一 md：归档索引与数据清单 |

历史方案文已迁：`/Users/wangzhenyu/Desktop/ALLProject/.archive/toiv-docs-20261026/`。  
`vendor/canvas/AGENTS.md`：画布约定（vendored 冻结子树，不计入根五件套）。

本地开发命令以 AGENTS.md §〇b / DEVELOPMENT.md 为准。模型与 `tmp/` 试片不要提交。
