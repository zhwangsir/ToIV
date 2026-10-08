# ToIV

AI 短剧和画布。公网入口是 [toiv.wineryz.top](https://toiv.wineryz.top)。未登录看到的是官网静态页，登录后进 `/studio` 画布。品牌名只用 ToIV。

这份说明按 2026-10-09 的仓库和线上核对过的事实写。没在这次跑通的能力，不写成已经可用。

## 仓库

两边 main 在这次推送前都停在 `398bd88a`（2026-10-08 23:48，上海时间）。

- GitHub：https://github.com/zhwangsir/ToIV.git
- Gitee（origin）：https://gitee.com/Winery_z/ToIV.git

线上网页构建号是 `20261007-194448-7ce69c7f-dirty`。它不是 `398bd88a`，也不是官网合入记录 `a105720b`。这次只推代码，不部署。

## 这次合进来的

从 `398bd88a` 起，只合了三条相对 main 还有独有提交、并且先前核对过的线：

- H3 服务令牌刷新 `feat/h3-token-refresh-r3`，尖端 `5bc8432c`。上传只允许 `kind=h3_i2v`。服务令牌不能读 workers，也不能读加速档。`CANVAS_API` 只能是 `127.0.0.1:8290`。说明在 `apps/canvas/deploy/h3-token-refresh/README.md`。代码在仓库里，没有部署，也没有在 staging 跑过一次真实刷新。线上管理员令牌大约 2026-10-13 13:29（上海时间）到期。
- 古风色板和饰品门禁 `fix/ancient-spec-palette-fb10`，尖端 `3cc5ac63`。
- 帽兜门禁 `fix/chybrid-ref-vlm-gate`，尖端 `e3c796cc`。

## 这次没合的

- `feat/h3-token-refresh-r2`（`30386e18`）。`config.py` 曾经被截断，不要合。
- `feat/canvas-multitenant`（`8c03b366`）和 `feat/canvas-multitenant-r2`（`9e2e204f`）。它们和令牌刷新改同一批 Go 文件。GitHub 上那份用户隔离此前是坏的，这次不并。
- `fix/ancient-spec-palette`（`fdbd82d5`）。用上面的 `fb10`，不用这一条。
- `claude/jovial-fermi-d7708a`（`44561d09`，2026-06-29）。上面还有 7 个不在 main 里的旧提交（PuLID、超分、批量转视频）。和现在的 main 差了一千五百多个提交，不直接合。
- 其余远程分支相对 `398bd88a` 没有独有提交，已经在 main 里。`feat/h3-token-refresh-r4` 的指针就等于 `398bd88a`。

## 运行口径

core 是 `merlin@100.77.80.100`，ToIV 在 `/home/merlin/toiv`，API `:8090`。重启前先 `compileall`，再 `sudo -n systemctl restart toiv-api`。

H3 生产是 `:8264`。`:8195` 只做试验。生图 `:8196`，LongCat / Wan / VACE `:8197`。不要碰 `:8205`、`:8261` 和 `cuda:3`。不要拿 `toiv.wineryz.top` 做测试。

权重在 NAS 的 `toiv/comfyui-models`，不进 git。另一棵 `Windows/ComfyUI/ComfyUIModel/models` 是旧库，文件还在，不要把它的大小加进主库。

## 文档

- README.md：本文件
- AGENTS.md、DEVELOPMENT.md、STATE.json、TEST_LOG.md：五件套里的另外四份。2026-10-09 还没按这次审计回写，不要拿里面的旧部署口径当现状。
- `apps/canvas/README.md` 仍是上游画布的原文，这次没有改名。

本地开发命令以 DEVELOPMENT.md 为准。模型、成片和 `tmp/` 里的试片不要提交。
