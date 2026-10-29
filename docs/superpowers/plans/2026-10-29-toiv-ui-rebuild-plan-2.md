# ToIV UI 重建 · Plan 2：剪辑湾面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development 或 superpowers:executing-plans，逐任务实施。

**Goal:** 交付剪辑湾面（镜头条 + 预览 + 多轨序列 + takes 轨 + 导出菜单），接 `/edit` 路由并让 FaceSwitcher 三面互通。

**Architecture:** 复用 Plan 1 设计系统与 `studio.css` 既有剪辑湾样式类；数据经 `fetchDramaProject` + `studioExportMenuModel` + `exportStudioTimeline*`；ExportMenu 调真实导出器（EDL/FCPXML/multitrack/jianying）。

**Tech Stack:** 同 Plan 1（React 19 + bun + playwright harness）。

**Spec:** `docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-design.md` §4.3；需求基线 §C3。

## Global Constraints

同 Plan 1（锁纪律 / 无 antd / 无硬编码色 / !important=0 / 语义测试 / URL 兼容 / 业务层不动 / ELv2 不 vendor / bun-only / 四套件门禁）。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/studio/faces/edit/model.ts` | 时间线模型：shots→V1 clips、对白→A1 clips、BGM→A2（可选）、总时长 |
| `src/studio/ui/ShotStrip.tsx` | 镜头条 |
| `src/studio/ui/Timeline.tsx` | 标尺 + 多轨 + 播放头 |
| `src/studio/ui/ExportMenu.tsx` | 导出菜单（真实导出器 + 问题计数） |
| `src/studio/faces/edit/EditFace.tsx` | 剪辑湾面组合 |
| `src/studio/routes/studio-edit-route.tsx` | `/edit` 路由 |
| `src/router.tsx`（改） | 增 `/edit` |
| `src/studio/shell/StudioShell.tsx`（改） | FaceSwitcher onChange 改为路由导航 |
| 测试：`test/studio-edit-model.test.ts`、`test/studio-components.test.tsx`（追加）、`test/studio-edit.browser.test.ts` + fixture | 契约/交互 |

---

### Task 1: 时间线模型适配器

**Files:** Create `src/studio/faces/edit/model.ts`；Test `test/studio-edit-model.test.ts`

**Interfaces:** Consumes `fetchDramaProject`（client.ts:825）；Produces `loadEditModel(pid): Promise<EditModel>`，`type EditClip = { id, label, track: "v1"|"a1"|"a2", startSec, durationSec, kind: "video"|"dialogue"|"bgm", status }`，`type EditModel = { projectId, projectName, clips: EditClip[], totalSec, shots: { id, title, durationSec, status, stillSeed }[] }`。

- [ ] **Step 1: 失败测试**（mock.module client：两镜，duration 4.5/3.0，第一镜 dialogue 非空、audio done；第二镜无对白）

```ts
mock.module("@/services/toiv/client", () => ({
    fetchDramaProject: async () => ({ id: "p1", title: "草船借箭", shots: [
        { id: "sh1", idx: 0, status: "done", duration_sec: 4.5, dialogue: "或许我真不适合修仙", audio_media_status: "done", candidates: [{ id: "c1", is_picked: true }] },
        { id: "sh2", idx: 1, status: "done", duration_sec: 3, dialogue: "", candidates: [{ id: "c2", is_picked: true }] },
    ] }),
}));
const { loadEditModel } = await import("@/studio/faces/edit/model");
test("builds v1 clips sequentially from shots", async () => {
    const model = await loadEditModel("p1");
    const v1 = model.clips.filter((c) => c.track === "v1");
    expect(v1.map((c) => c.startSec)).toEqual([0, 4.5]);
    expect(model.totalSec).toBe(7.5);
});
test("dialogue becomes a1 clip aligned to its shot", async () => {
    const model = await loadEditModel("p1");
    const a1 = model.clips.filter((c) => c.track === "a1");
    expect(a1).toHaveLength(1);
    expect(a1[0].startSec).toBe(0);
});
```

- [ ] **Step 2: 红** → `bun test test/studio-edit-model.test.ts`
- [ ] **Step 3: 实现**（顺序累加 startSec；dialogue 非空且 audio done → a1 clip 同 start/duration；bgm 仅当 `detail.bgm_url` 存在时单条 a2 覆盖全程，否则空轨由 UI 提示）
- [ ] **Step 4: 绿** + typecheck
- [ ] **Step 5: Commit** `feat(canvas): 剪辑湾时间线模型适配器`

### Task 2: ShotStrip / Timeline / ExportMenu 组件

**Files:** Create 三组件；Test 追加 `test/studio-components.test.tsx`

**Interfaces:** Produces `ShotStrip({ shots, activeId, onPick })`；`Timeline({ clips, totalSec, playheadSec, onClipPick, activeClipId })`（标尺每 10s 一格、clip 左/宽按秒比、播放头左按秒比）；`ExportMenu({ projectId, ready, onResult })`（Popover 列出 `studioExportMenuModel({ready})`，点击调对应导出器，成功/失败都 `onResult(text, warn)` 并显示 `parseExportIssueCounts` 的问题数）。

- [ ] **Step 1: 失败测试**：Timeline 渲染 clip 的 left/width 百分比（4.5/7.5=60%）；ExportMenu 打开列出 4 项（剪映/EDL/FCPXML/multitrack）。
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**（Timeline 用 `.seq/.ruler/.track/.lane/.clip/.playhead` 类；ExportMenu 用本地 popover state + `studioExportMenuModel` + `exportStudioTimelineEdl/Fcpxml/MultitrackBundle`，jianying 项调 `src/services/toiv/jianying-draft.ts` 的导出函数（实施时 grep 其导出名））
- [ ] **Step 4: 绿** + typecheck
- [ ] **Step 5: Commit** `feat(canvas): 镜头条/多轨时间线/导出菜单组件`

### Task 3: EditFace 组合 + /edit 路由 + 面切换导航

**Files:** Create `EditFace.tsx`、`studio-edit-route.tsx`；Modify `router.tsx`（增 `/edit`）、`StudioShell.tsx`（FaceSwitcher onChange 收 `onFaceChange` 由路由层传 navigate）

**Interfaces:** EditFace 消费 `EditModel` + Task 2 组件 + takes 轨（复用 TakeStrip）+ 参数列；播放状态本地（interval 推进 playheadSec，到 totalSec 停）。

- [ ] **Step 1: 失败测试**：EditFace 静态契约（镜头条/序列/导出菜单按钮/播放按钮 aria-label）
- [ ] **Step 2: 红**
- [ ] **Step 3: 实现**（route 同 studio-create-route 模式：无 project 参数或加载失败回落旧 creation-workbench；FaceSwitcher 三按钮 navigate(`/create?project=`|`/canvas/:id`|`/edit?project=`)）
- [ ] **Step 4: 绿** + lint + typecheck
- [ ] **Step 5: Commit** `feat(canvas): 剪辑湾面与 /edit 路由、三面导航`

### Task 4: 剪辑湾浏览器交互 harness

**Files:** Create `test/fixtures/studio-edit-harness.tsx`、`test/studio-edit.browser.test.ts`

- [ ] **Step 1: 写 harness**（fixture EditModel；播放按钮切换播放头前进；clip 点选 aria-pressed；导出菜单打开列出四项；点 EDL 触发 fetch 失败 → 错误 toast 出现，验证失败路径语义）
- [ ] **Step 2: 红→绿**（沿用 Plan 1 harness 插件与内联 CSS 方式）
- [ ] **Step 3: Commit** `test(canvas): 剪辑湾交互 harness`

### Task 5: 门禁 + 全量 + 截图

- [ ] **Step 1:** `bun test test/studio-debt-metrics.test.ts`（studio 目录新增文件自动纳入）
- [ ] **Step 2:** canvas 全量 + lint + typecheck；web npm test + typecheck
- [ ] **Step 3:** 截图 `/tmp/studio-edit-{dark,light}.png`（harness 内联 CSS）
- [ ] **Step 4: Commit** `test(canvas): 剪辑湾门禁与取证`

## Self-Review

- Spec §4.3 全覆盖：镜头条(ShotStrip)/预览+transport(EditFace)/多轨(Timeline)/takes 轨(TakeStrip 复用)/参数列/导出(ExportMenu)/fusion 入口（EDL 体检等经 ExportMenu 的 EDL 项与后续 QA 面板在 Plan 4 设置面暴露，本计划不含 QA 面板——记录为 Plan 4 项）。
- 无占位符；jianying 导出函数名在 Task 2 Step 3 由实施者 grep 确定（给出文件路径与动作，非 TBD）。
- 类型一致：EditClip/EditModel 在 Task 1 定义，Task 2/3 消费同名。
