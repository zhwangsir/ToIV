# Motion / Empty · R9补校准 Handback

日期：2026-10-26（Asia/Shanghai）  
分支：`work/p0-fusion-20261016`  
基 tip：`d7274c16`（R10）  
合规：只改硬表偏差；canvas↔web token 双同步；**未 push**。

---

## A. 改了什么

| 项 | 旧 → 新 |
|----|---------|
| `--toiv-motion-fast/base/slow` | 补钉 **150 / 220 / 320**（`--toiv-duration-*` 已同值） |
| ease | 钉 `cubic-bezier(0.22, 1, 0.36, 1)` |
| skeleton radius / shimmer | **10→8** / **1.4s→1.6s**；shine 改暗色 `rgba(255,255,255,0.10)` |
| spinner | 新增 `--toiv-spinner-sm/md/lg` = 16 / **24** / 32 |
| toast | `--toiv-motion-toast-ms` **2200**；`App` message/notification `duration: 2.2`、`maxCount: 1`（禁 5000） |
| glow blur | `--toiv-glow-blur: 24px`（与既有 `--toiv-glow-accent` 24 同族） |
| reduced-motion | 空态/骨架/CTA/spinner 压平；骨架去扫光留底 |

挂载：`toiv-empty-loading.css`；create / 资产 / 队列继续消费既有 ToivEmpty/Skeleton。

---

## B. Token

双端：
- `apps/canvas/web/src/styles/toiv-freezone-tokens.css`
- `apps/web/app/styles/toiv-freezone-tokens.css`

关键：`--toiv-motion-*` / `--toiv-skeleton-*` / `--toiv-spinner-*` / `--toiv-glow-blur` / `--toiv-motion-toast-ms`。

---

## C. 自检

- [x] fast/base/slow = 150/220/320
- [x] toast ≠ 5000
- [x] skeleton r8 / 1.6s / line-h 12
- [x] prefers-reduced-motion 块存在
- [x] canvas↔web diff 一致
- [x] R1 DNA：accent `#5ba0ff` / cyan `#00bdcf`；文案普通/成人未改几何

---

## D. 风险

- antd toast 全局改 2.2s，长文错误可能读不完（产品密台取短；错误可单次覆盖 duration）。
- SoftGlow 仍用大半径 ambient；选中/NSFW 盒影继续 24 blur。
- **未 push**。
