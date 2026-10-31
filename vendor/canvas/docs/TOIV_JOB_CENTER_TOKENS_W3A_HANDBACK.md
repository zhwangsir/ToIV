# ToIV · P1-2 任务中心绑 `--toiv-job-*` Handback（W3-A）

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **tip**：`0a426713`（**未 commit / 未 push / 未 deploy**）
- **截图性质**：**FIXTURE · 非现网硬刷** · 1280×800
- **口径**：BeefTV + A6 `#4A7FC1` + B1 `250/67/56`；**未**动 DesktopShell / 后端 / MODEL_SOURCES

---

## 做了什么

1. **主列表 CSS 吃满 `--toiv-job-*`**（`globals.css`）
   - 行：`min-height` / pad / gap / cols / radius / hover → token
   - 拇指：`84×60` → `--toiv-job-thumb-w/h`
   - 进度：高 `3px`、track/fill/radius/dur/ease → token；**fill = `--toiv-job-progress-fill` → `#4A7FC1`**
   - 标题/状态/dot/重试 hit、列表 gap 对齐 create 队列（`--toiv-job-row-list-gap: 8px`）
   - 窄屏 cols → `--toiv-job-row-cols-narrow`；拇指压缩几何保留
2. **`.app-user-workspace .task-record-row`** `min-height: 88px` → `var(--toiv-job-row-min-h, 92px)`（消双源）
3. **`/toiv/tasks` 时间线进度**（原 Tailwind `h-1` + `--workspace-accent`）
   - 改绑 `.toiv-job-progress-*` → 同 3px / `#4A7FC1`
   - 新文件 `apps/canvas/web/src/pages/toiv/tasks-page.css`
4. **失败重试冷却**：未改 `taskRetryBlocked` / 重试 hit 几何语义（仍走 `--toiv-job-retry-hit`）；冷却逻辑不动

---

## Fixture / 截图

| 文件 | 绝对路径 |
|---|---|
| Fixture | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/fixture-w3a-job-center.html` |
| PNG 1280 | `/Users/wangzhenyu/Desktop/ALLProject/ToIV/apps/canvas/docs/shots/w3a-job-center.png` |

**CTA / 进度采样**：`rgb(74, 127, 193)`（`#4A7FC1`）

---

## 改动文件面

- `apps/canvas/web/src/styles/globals.css`
- `apps/canvas/web/src/pages/toiv/tasks-page.tsx`
- `apps/canvas/web/src/pages/toiv/tasks-page.css`（新）
- `apps/canvas/docs/TOIV_JOB_CENTER_TOKENS_W3A_HANDBACK.md`
- `apps/canvas/docs/shots/fixture-w3a-job-center.html`
- `apps/canvas/docs/shots/w3a-job-center.png`

---

## 验收对照

- [x] 行 min-h 92、拇指 84×60、进度 3px fill `#4A7FC1`
- [x] 与 create 队列同 `--toiv-job-*` 真源
- [x] 失败重试冷却几何未改业务逻辑
- [x] fixture 1280
- [x] tip `0a426713`；未 commit

## 残点

| 项 | 说明 |
|---|---|
| 现网硬刷 | FIXTURE 示意；未登录肉眼未刷 |
| grid 卡拇指 | grid 仍 aspect-ratio 16/9（非 84×60 列表几何）；列表行为本波主钉 |
| W3-C | cyan 旧名清扫见 `TOIV_CYAN_ALIAS_W3C_HANDBACK.md` / W3-B 附注 |
