> ⚠️ **历史快照 · 非现行事实**（DOC_TRUTH_SWEEP 2026-10-23 Asia/Shanghai）。
> 现行主机 / 端口 / 权重 / DOWN 口 → [`docs/ops/CLUSTER_TRUTH.md`](CLUSTER_TRUTH.md)。正文仅作考古，禁止盲抄配置。

# 发版自动化脚手架 · P-2 BUILD_ID `-dirty` 硬闸(2026-10-20)

## 背景

`apps/web/next.config.mjs` 在 `git status --porcelain` 非空时给 BUILD_ID 追加 `-dirty`。
历史多次把 `…-dirty` 推上 core(见 TEST_LOG / STATE)。**P-2**:前端变更须干净重建并查 BUILD_ID;含 `-dirty` 的指纹**不得发版**。

## BUILD_ID 现状

| 位置 | 作用 |
|------|------|
| `apps/web/next.config.mjs` `resolveBuildFingerprint` | 生成 `YYYYMMDD-HHmmss-<sha>[-dirty]` → `.next/BUILD_ID` + `NEXT_PUBLIC_BUILD_ID` |
| `apps/web/app/version.json/route.ts` | 运行时读磁盘 BUILD_ID(发版侦测) |
| `deploy/deploy.sh` `assert_web_build_matches_head` | 推 web 前:先拒 `-dirty`,再校验 sha==HEAD(`ALLOW_STALE_WEB=1` 只绕过旧 sha,**不绕过 dirty**) |
| `scripts/release/build_id_gate.py` | 可单测的硬闸(CI + deploy + 预检共用) |

canvas `VERSION` 文件(当前 `v1.7.8`)与 web BUILD_ID 是两条线;本刀闸的是 **web BUILD_ID dirty**。

## 门禁落点

1. **CI** — `.github/workflows/ci.yml` job `release-gate`(每次 CI 跑门禁单测 + CLI 拒 dirty)
2. **deploy** — `deploy/deploy.sh` 推前端前调用 `build_id_gate.py --id …`(无 `ALLOW_DIRTY_WEB`)
3. **预检脚本** — `scripts/release/preflight.sh`(干净树 + 若有 `.next/BUILD_ID` 则校验)

## 发版路径(手工,本刀不打 tag)

```bash
# 1) 工作区干净
git status   # 应无未提交改动

# 2) 预检
./scripts/release/preflight.sh

# 3) 干净重建 web(必须在干净树上)
cd apps/web && rm -rf .next && npm run build
# 查指纹:不应含 -dirty
cat .next/BUILD_ID

# 4) 再预检一次(会校验 BUILD_ID sha==HEAD)
cd ../.. && ./scripts/release/preflight.sh

# 5) 按需部署(本说明不代替生产审批)
# deploy/deploy.sh --web-only    # 或 --all
# 勿在本机未干净时强推;不要设置不存在的 ALLOW_DIRTY_WEB

# 6) 版本号 / tag(人工;本刀不执行)
# - 改 apps/canvas/VERSION、CHANGELOG
# - git tag vX.Y.Z && 双推 — 需用户明确授权
```

## 测试

```bash
python -m pytest scripts/release/test_build_id_gate.py -q
python3 scripts/release/build_id_gate.py --id '20261020-000000-deadbee-dirty'  # 期望 exit 1
python3 scripts/release/build_id_gate.py --id '20261020-000000-deadbee'         # 期望 exit 0
```

## 明确不做

- 不自动 bump 版本、不自动打 tag、不 push、不生产部署
- 不删除 `-dirty` 生成逻辑(本地脏构建仍可区分;闸在发版路径)

## 下一刀建议

- canvas 构建指纹同样打上 sha[-dirty] 并纳入同一 gate
- `preflight` 接入 CHANGELOG/VERSION 一致性检查
- 发版 job(需人工 approve)一键:预检 → build → deploy --web-only
