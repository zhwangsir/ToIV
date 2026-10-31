# ToIV prime 切换（cutover）检查清单

> 基座：printfilm（MIT, `62f8d95d`）→ `apps/prime/web`；状态：代码与本地/生产真数据取证完成（2026-10-30），**生产默认仍为旧 canvas web**（`--prime` 关）。

## 1. prime 已原生覆盖面
项目库（studio+canvas 双源）/ 新建向导（SVML 导入）/ 分镜页（beats+takes+提示词全量替换保存）/ 配方闭环（存/导出/安装/复用）/ 场景锚点页（冻结 master）/ 剪辑湾时间线（v1/a1 秒比）/ 画布（xyflow 场景节点四视图）/ 资产库（角色+场景）/ 作品库+任务（jobs 可取消）/ 登录（ToIV 会话）。

## 2. 仍走 handoff（旧工作台）的面
设置、工具中心/市场、插件中心、KPI、作品详情、旧画布引擎 `/canvas/:id`。
handoff 目标基址 = `VITE_LEGACY_BASE`（默认 `/studio`，切换期可指向遗留基）。

## 3. 翻转前置（全满足才允许 `--prime` 默认开）
1. §2 各面二选一：原生化，或落地遗留基基础设施（旧 dist 挂 `/studio-legacy/`，需 toiv-web/反代改动）并把 `VITE_LEGACY_BASE` 指过去。
2. 用户当次显式授权（部署+灰度）。
3. 生产 running=0 窗（deploy drain 自动校验）。
4. 推送双远端完成（当前待口令）。

## 4. 翻转与回退
- 翻转：`deploy/deploy.sh --canvas-only --prime` → 跑 `tmp/ui-proto/verify-prime-*.mjs` 全组 → 观察 ≥24h。
- 回退：`deploy/deploy.sh --canvas-only`（不带 `--prime`），快照自动可 `--rollback`。

## 5. 翻转后退役（W6）
删 `vendor/canvas/web/src/studio` 三面与 router 顶层 studio 块、legacy-host 路由、`StudioCreateHomeRoute` 桥；达成 UserLayout/globals.css/antd 删除入口；旧 dist 下线。

## 6. 取证脚本
`tmp/ui-proto/`：verify-prime-w1/w2/recipes/editor/canvas/assets/create（本地 dev 代理生产 API）+ verify-studio-5b（旧壳回归对照）。
