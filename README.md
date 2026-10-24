> ⚠️ **DOC_TRUTH_SWEEP 2026-10-23**：集群端口/模型以 `docs/ops/CLUSTER_TRUTH.md` 为准；下文「这次合进来的」等为历史合入说明。

# ToIV

AI 短剧和画布。公网入口是 [toiv.wineryz.top](https://toiv.wineryz.top)。未登录看到的是官网静态页，登录后进 `/studio` 画布。品牌名只用 ToIV。

这份说明按仓库与线上核对过的事实写。没跑通的能力，不写成已经可用。仓库结构见下文「工程结构」。

## 仓库

2026-10-09 这次推送之前，两边 main 是 `ce2aacda`。线上构建号另记，不要把当前仓库 tip 写成已经部署。

- GitHub：https://github.com/zhwangsir/ToIV.git
- Gitee（origin）：https://gitee.com/Winery_z/ToIV.git

线上网页构建号是 `20261007-194448-7ce69c7f-dirty`。它不是 `398bd88a`，也不是官网合入记录 `a105720b`。这次只推代码，不部署。

## 这次合进来的

从 `398bd88a` 起，合进来的是这些核对过的线。都没有部署。

- H3 服务令牌刷新 `feat/h3-token-refresh-r3`，尖端 `5bc8432c`。上传只允许 `kind=h3_i2v`。服务令牌不能读 workers，也不能读加速档。`CANVAS_API` 只能是 `127.0.0.1:8290`。说明在 `apps/canvas/deploy/h3-token-refresh/README.md`。没有在 staging 跑过一次真实刷新。线上管理员令牌大约 2026-10-13 13:29（上海时间）到期。
- 古风色板和饰品门禁 `fix/ancient-spec-palette-fb10`，尖端 `3cc5ac63`。
- 帽兜门禁 `fix/chybrid-ref-vlm-gate`，尖端 `e3c796cc`。
- 用户隔离 `feat/canvas-multitenant-r3`，尖端 `44e1162f`（变基前的本地提交是 `fe7618ad`）。`/studio` 用签名头 `X-ToIV-User` 把画布限在本人工作区。不设 `CANVAS_USER_IDENTITY_KEY_FILE` 和 `STUDIO_MULTITENANT=1` 时，这扇门是关的。GitHub 上的 `feat/canvas-multitenant` 和 `feat/canvas-multitenant-r2` 是坏的，不要用。
- 画布出站白名单按端口放行，`6fe5d190`。`127.0.0.1:8090` 这种条目不会放行同主机的其他端口。
- 素材筛选和项目节点排序的 JSON 查询按 SQLite / Postgres 分方言，`2858d94c`。
- 参数错误会带上上游的中文短句，`c74df3a6`。英文、空消息和疑似密钥仍然用原来的泛化文案。

## 这次没合的

- `feat/h3-token-refresh-r2`（`30386e18`）。`config.py` 曾经被截断，不要合。
- `feat/canvas-multitenant`（`8c03b366`）和 `feat/canvas-multitenant-r2`（`9e2e204f`）。用上面的 `44e1162f`，不要用这两条。
- `fix/ancient-spec-palette`（`fdbd82d5`）。用已经合入的 `fb10`，不用这一条。
- `claude/jovial-fermi-d7708a`（`44561d09`，2026-06-29）。上面还有 7 个不在 main 里的旧提交（PuLID、超分、批量转视频）。和现在的 main 差了一千五百多个提交，不直接合。
- 其余远程分支相对 `398bd88a` 没有独有提交，已经在 main 里。`feat/h3-token-refresh-r4` 的指针就等于 `398bd88a`。官网在 `a105720b` 时已经进 main，这次没有新的官网提交。

## 运行口径（现行 · 2026-10-23）

完整主机/端口/权重 → [`docs/ops/CLUSTER_TRUTH.md`](docs/ops/CLUSTER_TRUTH.md)。会话短规则 → [`AGENTS.md`](AGENTS.md)。

- **core**：`merlin@192.168.71.47`（TS `100.77.80.100`），仓库 `/home/merlin/toiv`，web `:3100` · api `:8090` · admin `:3200`。
- **LLM**：spark02 `:8000`，weight `dsv4-flash-dspark-abliterated`，canonical served `deepseek-v4-flash-dspark`（live 仍可能挂废弃别名 qwen*/glm*）。spark01 仅 TP worker。
- **VLM**：workstation `:9311` `toiv-vlm`（Qwen3-VL-8B-Instruct）。
- **H3 生产**：workstation `:8264`。出图 LB `:8188`→8196/8263/8265；LongCat `:8197`；Animate2 `:8199`。
- **勿用死口**：`:8189` `:8195` `:8261` 等（见 CLUSTER_TRUTH）。
- 权重在 NAS `toiv/comfyui-models`，不进 git。

## 工程结构（2026-10-15 清理定版）

```
apps/          api · web · admin · canvas   # 应用主体
MiniProgram/   uni-app 唯一移动端（半自治）
deploy/        部署脚本 / infra / 微服务
scripts/       e2e · eval · h3 · ops · bench
docs/          产品与 ops 文档
skills/        agent 技能
third_party/   融合源工作树(dramaclaw/toonflow/hypit/video-use;不入仓)
drama/         运行时挂载（output/ 不入仓）
```

不入仓：`tmp/` `*.tmp.mjs` `node_modules` `.next` `.venv` `*.db` `.regen_tmp/` `dogfood-output/`、`third_party/{dramaclaw,toonflow,hypit,video-use}/` 整树（LICENSE 原文在 `third_party/licenses/`）。`opentalking` 不 vendor。

## 文档

- [`docs/ops/CLUSTER_TRUTH.md`](docs/ops/CLUSTER_TRUTH.md)：**现行集群真源**（主机/端口/权重）
- [`AGENTS.md`](AGENTS.md)：会话短规则 + 开发命令
- `DEVELOPMENT.md`：开发长文（文首有 DOC_TRUTH 横幅）
- `TEST_LOG.md` / `STATE.json`：测试与状态
- `apps/canvas/AGENTS.md`：画布约定

本地开发命令以 AGENTS.md §〇b / DEVELOPMENT.md 为准。模型与 `tmp/` 试片不要提交。
