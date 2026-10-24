> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# Deploy drain 覆盖 studio 生成窗(2026-10-20 · 待办#11)

## 旧守卫缺口

`deploy/deploy.sh` 的 `remote_restart toiv-api` 原先只:

```bash
pgrep -af 'tmp/batch[0-9]+_[^ ]*\.py'
```

**覆盖不到**:

- `studio_batch_render` / `studio_script_parse` / `studio_image_parse` / sheet/frame
- `studio_pipeline_c` / `studio_c_chain` / `board_film` / `drama_*` / Comfy `queued|running` Job
- 烟测 campaign:`App.smoke_status=running`(AGENTS: running>0 禁重启)

后果:api 重启触发 `reconcile_parse_jobs` 等把在飞作业标 error——TEST_LOG 已记「两次误杀」。

## 新 drain 覆盖面

| 信号 | 来源 |
|------|------|
| 批跑驱动 | pgrep `tmp/batch*_*.py`(保留) |
| 烟测 campaign | `SELECT count(*) FROM app WHERE smoke_status='running'` |
| studio/短剧生成窗 | Job `queued|running` 且 kind∈`studio_*`/`drama_*`/`board_film`/… |
| 其他在飞生成 | 其余 Job `queued|running`(Comfy tracker 同进程,重启同样致命) |

实现:`deploy/deploy_drain.py`(随 `deploy/` rsync 上 core)。  
DB URL:优先环境变量,否则读 `toiv-api` MainPID 的 `/proc/.../environ` 中 `TOIV_DATABASE_URL`(P-18)。  
DB 探测失败 → **fail-closed**(视为 busy)。  
**无**「跳过 studio 只放行」旁路;`FORCE_API_RESTART=1` 为唯一强制阀(危险)。

## 运维怎么用

```bash
# 部署前本机干跑(不碰生产)
python3 deploy/deploy_drain.py --dry-run --snapshot-json '{"smoke_running":0,"jobs":[]}'

# 远端实探(在 core 上;或经 deploy.sh 自动调用)
# 使用 api venv 以带上 psycopg:
/home/merlin/toiv/api/.venv/bin/python /home/merlin/toiv/deploy/deploy_drain.py --probe-local

# 可选:忙则最多等 120s 再判
DEPLOY_DRAIN_WAIT_SEC=120 deploy/deploy.sh --skip-web   # 仍会在重启 api 前 drain

# 紧急强制(会杀在飞作业 — 需明确知情)
FORCE_API_RESTART=1 deploy/deploy.sh …
```

`deploy.sh` 在每次 `remote_restart toiv-api` 前调用 `assert_api_drain`(含 rollback 路径)。

## 测试

```bash
python3 -m pytest scripts/release/test_deploy_drain.py -q
```

## 明确不做

- 不查生产、不重启 toiv-api、不部署
- 不自动 cancel 在飞 Job(只拒绝重启)

## 下一刀

- 可选 HTTP `GET /api/ops/deploy-busy`(localhost)减少读 `/proc` environ
- canvas-api 重启窗同类守卫
- CI 对 `deploy_drain` 常驻(已可并入 `release-gate`)
