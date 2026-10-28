# P0 · results.find 崩页热修 Handback

- **日期**：2026-10-28（Asia/Shanghai）
- **分支**：`work/p0-fusion-20261016`
- **基线 tip**：`91510e60`（`git rev-parse --short HEAD` 确认）
- **状态**：**本地脏树 · 未 commit · 未 push · 未 deploy**
- **触发链**：WorkspaceTopBar → CreationStudioQueueDock → `fetchJobs` → `toivGenerationTask`（首页也会挂）
- **根因**：`job.results` 有时是 JSON object（如 studio `{"error":...}`），truthy 对象上 `.find` 非函数 → 白屏

---

## 做了什么（FE）

### 1. 崩点必护
| 文件 | 护栏 |
|---|---|
| `apps/canvas/web/src/lib/generation-task-display.ts` ~L154 | `Array.isArray(job.results) ? job.results.find(...) : undefined` |
| `apps/canvas/web/src/services/toiv/library-group.ts` `listJobMedia` | 入口 `const rows = Array.isArray(job?.results) ? job.results : []` 再遍历 |
| 同上 `folderCover` | `Array.isArray(m.job.results) && m.job.results.length > 0` |

### 2. 一处收口 normalize（必做）
| 文件 | 护栏 |
|---|---|
| `apps/canvas/web/src/services/toiv/client.ts` | 新增 `normalizeJobResults`；`extractWorkJobList` 映射每条 `results: Array.isArray(...) ? ... : []`（覆盖 `fetchJobs` / `fetchToivWorksPage` / `fetchToivTrashPage`） |
| 同上 `fetchJobById` | lookup 单条同样 normalize |

### 3. 扫到的其它点一并护
| 文件 | 护栏 |
|---|---|
| `apps/web/components/generate/AssetPicker.tsx` ~L136 | 本地 `const results = Array.isArray(j.results) ? j.results : []` 再 `.find` |
| `apps/web/lib/assetPick.ts` | `Array.isArray(job.results) ? job.results[0] : undefined` |
| `apps/canvas/web/src/pages/toiv/library-works.tsx` ×2 | cover 取 `[0]` 前 `Array.isArray` |

### 4. 自测
- 新增单测：`listJobMedia tolerates non-array results object without throwing`（`toiv-library-detail.test.ts`）
- `bun test test/toiv-library-detail.test.ts` → **12 pass / 0 fail**
- 直调 `generationSourceProjection({ source:"toiv-job", task: dirtyObjectResults })` → **不抛**，`previewUrl` 为空
- grep：业务路径无未护的 `job.results?.find` / `results.find`（`canvas-archive-restore` 的 `results.find` 是 `Promise.allSettled`，无关）

---

## 同机已有 BE 脏改（非本 FE 刀口，同根因）

`apps/api/app/routes/jobs.py` 已有 `_job_results_list`：loads 后非 list 一律 `[]`，`_job_dict` / duration / forge+job SSE 已改用。
`apps/api/tests/test_jobs.py` 已加 `test_job_results_list_forces_list`。

- **本 FE 刀口未改 BE**；上述 BE+测在 MateBook 脏树里与 FE 同现（同根因）。
- TL 审时请决定：本波 commit 是否**一并折入** BE+测，或先只收 FE。

---

## 没做什么

- **未**恢复 SoftGlow / 首页意图墙
- **未 commit / push / deploy**
- **未** `force` / `reset --hard` / `clean`
- 姿势库等拓展未动

---

## 改文件列表（本波 FE + 自测）

1. `apps/canvas/web/src/lib/generation-task-display.ts`
2. `apps/canvas/web/src/services/toiv/library-group.ts`
3. `apps/canvas/web/src/services/toiv/client.ts`
4. `apps/canvas/web/src/pages/toiv/library-works.tsx`
5. `apps/web/components/generate/AssetPicker.tsx`
6. `apps/web/lib/assetPick.ts`
7. `apps/canvas/web/test/toiv-library-detail.test.ts`

另见脏树：`apps/api/app/routes/jobs.py`（BE，见上）

---

## 请 TL

1. 一眼过 FE 护栏 + normalize
2. 决定 BE `jobs.py` 是否同 commit
3. **放行后再** commit + push 双远端（本波停手，**未 push**）
