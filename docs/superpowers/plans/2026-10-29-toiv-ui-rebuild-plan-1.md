# ToIV UI 重建 · Plan 1：设计系统 + 壳 + 流水线面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `apps/canvas/web` 建立新设计系统（token/组件/壳）并交付流水线面（素材/分镜阶段），以 strangler 方式接管 `/create`，旧 UI 冻结不动。

**Architecture:** 新系统全部落在 `src/studio/`（theme/ui/shell/faces/routes），只换视图层：数据经现有 `src/services/toiv/client.ts` 读取，stores/services/API 契约不动。组件测试用 `renderToStaticMarkup` 静态契约断言（role/aria/文案），交互用 playwright Bun.serve harness；禁 RGB/像素钉值。

**Tech Stack:** React 19 + Vite 8 + bun（canvas/web 仅 bun）；class-variance-authority + clsx + tailwind-merge；lucide-react 图标；zustand（toast store）；playwright（browser harness）。

**Spec:** `docs/superpowers/specs/2026-10-29-toiv-ui-rebuild-design.md`（需求基线同目录 `-requirements.md`）。视觉基线参照抛用原型 `tmp/ui-proto/`（tokens.css/app.css 为移植源）。

**后续计划（本计划不做）：** Plan 2 剪辑湾面；Plan 3 画布面壳；Plan 4 共享页（库/任务/设置）+ apps/web 换装 + 旧壳与 globals.css 删除。

## Global Constraints

- 锁纪律：门控只经 `@content-lock`；`src/studio/**` 禁止内容判断（nsfw/敏感词/红线）；删锁后构建/启动/功能照常。
- `src/studio/**` 禁止 import antd / @ant-design/*；图标仅 lucide-react。
- 颜色只允许出现在 `src/studio/theme/tokens.css`；其余文件硬编码 hex/rgb = 0；`!important` = 0；内联 `style={{` = 0；单 CSS 文件 ≤ 800 行。
- 测试禁 RGB/像素钉值；断言 role/label/state/文案。
- 对外 URL 不变；`/create` 经 `STUDIO_FACE_FALLBACK`（env `VITE_STUDIO_FACE_FALLBACK`，逗号列表=留在旧 UI 的面，默认空=全新）回退。
- 业务层（stores/services/API）不改；不 vendor 参考仓源码（dramaclaw=ELv2）。
- canvas/web 仅 bun；每任务结束四套件门禁中至少 `bun run test && bun run lint && bun run typecheck` 绿；commit 风格 `feat(canvas): …` 中文摘要。

## File Structure

| 文件 | 职责 |
|---|---|
| `src/studio/theme/tokens.css` | 唯一 token 源（双主题 oklch 语义 + 形/动效） |
| `scripts/sync-studio-tokens.mjs` | 生成 web 副本（废人工字节同步） |
| `apps/web/app/styles/studio-tokens.css` | 生成物（byte-identical body） |
| `src/studio/flags.ts` | 面级回退开关 |
| `src/studio/studio.css` | 壳 + 流水线面样式（stv- 前缀，仅用 token） |
| `src/studio/ui/SlidingTabs.tsx` | 白药丸滑动 tab |
| `src/studio/ui/StatusDot.tsx` | 状态点 + STATUS_LABEL |
| `src/studio/ui/toast-store.ts` / `ToastHost.tsx` | toast 状态与宿主 |
| `src/studio/ui/Button.tsx` | CVA 按钮 |
| `src/studio/ui/Field.tsx` | label+control 包裹 |
| `src/studio/ui/TakeStrip.tsx` | 候选 takes 择一 |
| `src/studio/ui/MediaTile.tsx` | 视图卡（still/badge/progress/动作行） |
| `src/studio/ui/ViewGroup.tsx` | 场景多视图组 |
| `src/studio/ui/FaceSwitcher.tsx` | 三面切换 |
| `src/studio/ui/CompanionBubble.tsx` | 小爪浮泡 |
| `src/studio/shell/StudioShell.tsx` | 壳（aurora/veil/header/children/toast/buddy） |
| `src/studio/faces/pipeline/model.ts` | 视图模型类型 + loadPipelineModel 适配器 |
| `src/studio/faces/pipeline/PipelineFace.tsx` | 流水线面组合（rail/main/inspector） |
| `src/studio/routes/studio-create-route.tsx` | /create strangler 路由 |
| `src/router.tsx`（改） | /create 指向 studio-create-route |
| 测试：`test/studio-tokens.test.ts`、`test/studio-components.test.tsx`、`test/studio-pipeline-model.test.ts`、`test/studio-pipeline.browser.test.ts`、`test/studio-debt-metrics.test.ts`、`test/fixtures/studio-pipeline-harness.tsx` | 契约/交互/债务门禁 |

---

### Task 1: token 单源 + web 副本同步

**Files:**
- Create: `apps/canvas/web/src/studio/theme/tokens.css`
- Create: `apps/canvas/web/scripts/sync-studio-tokens.mjs`
- Create: `apps/canvas/web/test/studio-tokens.test.ts`
- Generate: `apps/web/app/styles/studio-tokens.css`

**Interfaces:**
- Produces: `scripts/sync-studio-tokens.mjs`（无导出，CLI：读 canvas tokens.css → 写 web 副本，body 字节一致 + 两行 banner）；token 名契约见测试清单。

- [ ] **Step 1: 写失败测试**

```ts
// test/studio-tokens.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const canvasTokens = readFileSync(resolve(import.meta.dir, "../src/studio/theme/tokens.css"), "utf8");
const webTokens = readFileSync(resolve(import.meta.dir, "../../../web/app/styles/studio-tokens.css"), "utf8");

const REQUIRED = ["--background", "--foreground", "--surface-1", "--surface-2", "--surface-3", "--muted-fg", "--faint-fg",
    "--border", "--border-strong", "--primary", "--primary-fg", "--primary-soft", "--success", "--warning", "--destructive",
    "--overlay", "--shadow-1", "--shadow-2", "--shadow-3", "--radius-xl", "--radius-lg", "--radius-md", "--radius-sm",
    "--radius-pill", "--dur-1", "--dur-2", "--dur-3", "--ease-tab", "--font-ui", "--font-mono"];

describe("studio tokens", () => {
    test("defines the semantic contract", () => {
        for (const name of REQUIRED) expect(canvasTokens).toContain(name + ":");
    });
    test("dark is default and light overrides same structure", () => {
        expect(canvasTokens).toContain(".dark {");
        const lightBlock = canvasTokens.slice(0, canvasTokens.indexOf(".dark {"));
        const darkBlock = canvasTokens.slice(canvasTokens.indexOf(".dark {"));
        for (const name of ["--background", "--primary", "--surface-1"]) {
            expect(lightBlock).toContain(name + ":");
            expect(darkBlock).toContain(name + ":");
        }
    });
    test("web copy body is byte-identical", () => {
        const body = (s: string) => s.slice(s.indexOf("/* tokens-body */"));
        expect(body(webTokens)).toBe(body(canvasTokens));
    });
    test("reduced motion zeroes durations", () => {
        expect(canvasTokens).toContain("prefers-reduced-motion");
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `cd apps/canvas/web && bun test test/studio-tokens.test.ts`
Expected: FAIL（文件不存在）

- [ ] **Step 3: 写 tokens.css（移植自原型 tmp/ui-proto/src/tokens.css，含 `/* tokens-body */` 标记行）**

```css
/* ToIV Studio tokens · 单源 · dramaclaw SuperTale 语义映射 */
:root {
    color-scheme: light;
    --background: oklch(0.9605 0.0046 258.3248);
    --foreground: oklch(0.2153 0.0187 235.1251);
    --surface-1: oklch(1 0 0);
    --surface-2: oklch(0.985 0.004 258.32);
    --surface-3: oklch(0.968 0.006 258.32);
    --muted-fg: oklch(0.5589 0.0255 233.7233);
    --faint-fg: oklch(0.72 0.02 258.32);
    --border: oklch(0.9436 0.0051 228.8204);
    --border-strong: oklch(0.86 0.008 228.82);
    --primary: oklch(0.54 0.13 210);
    --primary-fg: oklch(1 0 0);
    --primary-soft: oklch(0.54 0.13 210 / 0.14);
    --success: oklch(0.68 0.162 150);
    --warning: oklch(0.75 0.16 75);
    --destructive: oklch(0.6257 0.2058 29.0773);
    --overlay: oklch(0.2 0.02 258 / 0.5);
    --shadow-1: 0 2px 10px oklch(0 0 0 / 0.08), 0 1px 2px oklch(0 0 0 / 0.08);
    --shadow-2: 0 8px 24px oklch(0 0 0 / 0.12), 0 2px 6px oklch(0 0 0 / 0.08);
    --shadow-3: 0 18px 48px oklch(0 0 0 / 0.18);
    --aurora-a: oklch(0.54 0.13 210 / 0.10);
    --aurora-b: oklch(0.6 0.12 290 / 0.08);
}
.dark {
    color-scheme: dark;
    --background: #090909;
    --foreground: oklch(0.9436 0.0051 228.8204);
    --surface-1: oklch(0.185 0.006 258.32);
    --surface-2: oklch(0.225 0.008 258.32);
    --surface-3: oklch(0.27 0.01 258.32);
    --muted-fg: oklch(0.6637 0.0236 235.1968);
    --faint-fg: oklch(0.48 0.02 258.32);
    --border: oklch(0.2456 0.008 258.32);
    --border-strong: oklch(0.34 0.01 258.32);
    --primary: oklch(0.72 0.145 205);
    --primary-fg: oklch(0.2153 0.0187 235.1251);
    --primary-soft: oklch(0.72 0.145 205 / 0.14);
    --success: oklch(0.72 0.15 150);
    --warning: oklch(0.78 0.15 75);
    --destructive: oklch(0.68 0.19 29);
    --overlay: oklch(0 0 0 / 0.6);
    --shadow-1: 0 4px 12px oklch(0 0 0 / 0.4), 0 1px 2px oklch(0 0 0 / 0.4);
    --shadow-2: 0 10px 28px oklch(0 0 0 / 0.5), 0 2px 6px oklch(0 0 0 / 0.4);
    --shadow-3: 0 24px 64px oklch(0 0 0 / 0.6);
    --aurora-a: oklch(0.72 0.145 205 / 0.10);
    --aurora-b: oklch(0.62 0.14 290 / 0.08);
}
/* tokens-body */
:root {
    --radius-xl: 16px;
    --radius-lg: 12px;
    --radius-md: 9px;
    --radius-sm: 6px;
    --radius-pill: 999px;
    --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
    --font-ui: "PingFang SC", "Noto Sans SC", "Hiragino Sans GB", "Helvetica Neue", Arial, sans-serif;
    --font-mono: ui-monospace, "SF Mono", "JetBrains Mono", Menlo, Consolas, monospace;
    --text-xs: 11px; --text-sm: 12px; --text-md: 13px; --text-base: 14px; --text-lg: 16px; --text-xl: 20px; --text-2xl: 26px;
    --dur-1: 150ms; --dur-2: 220ms; --dur-3: 300ms;
    --ease-out: cubic-bezier(0.22, 0.8, 0.24, 1);
    --ease-tab: cubic-bezier(0.22, 0.8, 0.24, 1);
}
@media (prefers-reduced-motion: reduce) {
    :root { --dur-1: 0ms; --dur-2: 0ms; --dur-3: 0ms; }
}
```

- [ ] **Step 4: 写同步脚本并生成 web 副本**

```js
// scripts/sync-studio-tokens.mjs
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const source = readFileSync(resolve(root, "src/studio/theme/tokens.css"), "utf8");
const banner = "/* 生成物：scripts/sync-studio-tokens.mjs · 单源 apps/canvas/web/src/studio/theme/tokens.css · 勿手改 */\n";
writeFileSync(resolve(root, "../../web/app/styles/studio-tokens.css"), banner + source);
console.log("studio tokens synced");
```

Run: `cd apps/canvas/web && bun scripts/sync-studio-tokens.mjs`

- [ ] **Step 5: 运行测试确认通过**

Run: `bun test test/studio-tokens.test.ts`
Expected: PASS（4 tests）

- [ ] **Step 6: Commit**

```bash
git add apps/canvas/web/src/studio/theme/tokens.css apps/canvas/web/scripts/sync-studio-tokens.mjs apps/canvas/web/test/studio-tokens.test.ts apps/web/app/styles/studio-tokens.css
git commit -m "feat(canvas): studio token 单源与 web 副本同步"
```

---

### Task 2: 壳样式 + StudioShell + FaceSwitcher + 回退开关 + /create strangler

**Files:**
- Create: `src/studio/studio.css`、`src/studio/flags.ts`、`src/studio/ui/FaceSwitcher.tsx`、`src/studio/ui/CompanionBubble.tsx`、`src/studio/shell/StudioShell.tsx`、`src/studio/routes/studio-create-route.tsx`
- Modify: `src/router.tsx`（`/create` element 换 lazy studio-create-route）
- Test: `test/studio-components.test.tsx`（本任务先写 shell/face 断言部分）

**Interfaces:**
- Consumes: Task 1 tokens。
- Produces: `StudioShell({ face, projectLabel, runningCount, onOpenTasks, onFaceChange, buddyText, onDismissBuddy, children })`；`FaceSwitcher({ value, onChange })`；`studioFaceEnabled(face: StudioFace): boolean`；`type StudioFace = "pipeline" | "canvas" | "edit"`。

- [ ] **Step 1: 写失败测试（shell 静态契约）**

```tsx
// test/studio-components.test.tsx（Task 2 部分；Task 3-6 追加同文件）
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioShell } from "../src/studio/shell/StudioShell";
import { FaceSwitcher } from "../src/studio/ui/FaceSwitcher";
import { studioFaceEnabled } from "../src/studio/flags";

describe("StudioShell", () => {
    const html = renderToStaticMarkup(
        <StudioShell face="pipeline" projectLabel="草船借箭 / 素材准备" runningCount={2}
            onOpenTasks={() => {}} onFaceChange={() => {}} buddyText="测试台词" onDismissBuddy={() => {}}>
            <p>content</p>
        </StudioShell>,
    );
    test("renders face switcher with pressed state", () => {
        expect(html).toContain('aria-label="工作面"');
        expect(html).toMatch(/aria-pressed="true"[^>]*>流水线/);
    });
    test("renders task capsule with running count", () => {
        expect(html).toMatch(/2 运行中/);
    });
    test("renders companion bubble with dismiss", () => {
        expect(html).toContain("测试台词");
        expect(html).toContain('aria-label="关闭提示"');
    });
    test("shell carries theme class hook and content", () => {
        expect(html).toContain("stv-shell");
        expect(html).toContain("<p>content</p>");
    });
});

describe("flags", () => {
    test("defaults to new implementation", () => {
        expect(studioFaceEnabled("pipeline")).toBe(true);
    });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `bun test test/studio-components.test.tsx`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 写 flags.ts**

```ts
export type StudioFace = "pipeline" | "canvas" | "edit";

export function studioFaceEnabled(face: StudioFace): boolean {
    const raw = String(import.meta.env.VITE_STUDIO_FACE_FALLBACK ?? "");
    if (raw.trim() === "all") return false;
    return !raw.split(",").map((part) => part.trim()).includes(face);
}
```

- [ ] **Step 4: 写 FaceSwitcher.tsx 与 CompanionBubble.tsx**

```tsx
// src/studio/ui/FaceSwitcher.tsx
import type { StudioFace } from "../flags";

const FACES: { key: StudioFace; label: string }[] = [
    { key: "pipeline", label: "流水线" },
    { key: "canvas", label: "画布" },
    { key: "edit", label: "剪辑湾" },
];

export function FaceSwitcher({ value, onChange }: { value: StudioFace; onChange: (face: StudioFace) => void }) {
    return (
        <nav className="stv-faces" aria-label="工作面">
            {FACES.map((face) => (
                <button key={face.key} type="button" aria-pressed={face.key === value} onClick={() => onChange(face.key)}>
                    {face.label}
                </button>
            ))}
        </nav>
    );
}
```

```tsx
// src/studio/ui/CompanionBubble.tsx
export function CompanionBubble({ text, onDismiss }: { text: string; onDismiss: () => void }) {
    return (
        <div className="stv-buddy">
            <span className="stv-buddy-bubble">
                <b>小爪：</b>{text}
                <button type="button" className="stv-buddy-x" onClick={onDismiss} aria-label="关闭提示">×</button>
            </span>
            <span className="stv-buddy-pet" aria-hidden="true" />
        </div>
    );
}
```

- [ ] **Step 5: 写 StudioShell.tsx**

```tsx
// src/studio/shell/StudioShell.tsx
import type { ReactNode } from "react";
import type { StudioFace } from "../flags";
import { FaceSwitcher } from "../ui/FaceSwitcher";
import { CompanionBubble } from "../ui/CompanionBubble";
import { ToastHost } from "../ui/ToastHost";

export type StudioShellProps = {
    face: StudioFace;
    projectLabel: string;
    runningCount: number;
    onOpenTasks: () => void;
    onFaceChange: (face: StudioFace) => void;
    buddyText?: string;
    onDismissBuddy?: () => void;
    actions?: ReactNode;
    children: ReactNode;
};

export function StudioShell({ face, projectLabel, runningCount, onOpenTasks, onFaceChange, buddyText, onDismissBuddy, actions, children }: StudioShellProps) {
    return (
        <>
            <div className="stv-aurora" aria-hidden="true" />
            <div className="stv-veil" aria-hidden="true" />
            <div className="stv-shell">
                <header className="stv-appbar">
                    <span className="stv-lockup"><span className="stv-mark">TV</span>ToIV</span>
                    <span className="stv-proj">{projectLabel}</span>
                    <FaceSwitcher value={face} onChange={onFaceChange} />
                    <span className="stv-appbar-slot" />
                    <span className="stv-appbar-right">
                        <button type="button" className="stv-chip" onClick={onOpenTasks} aria-label="打开任务中心">
                            <span className={`stv-chip-dot${runningCount > 0 ? " run" : ""}`} />{runningCount} 运行中
                        </button>
                        {actions}
                    </span>
                </header>
                {children}
            </div>
            {buddyText && onDismissBuddy ? <CompanionBubble text={buddyText} onDismiss={onDismissBuddy} /> : null}
            <ToastHost />
        </>
    );
}
```

（`ToastHost` 在 Task 4 创建；本任务先建最小实现：`export function ToastHost() { return <div className="stv-toasts" aria-live="polite" />; }`，Task 4 替换为订阅 store 的版本。）

- [ ] **Step 6: 写 studio.css（壳 + 流水线面；stv- 前缀；仅 token 变量）**

```css
@import "./theme/tokens.css";
* { box-sizing: border-box; }
.stv-shell, .stv-shell * { margin: 0; padding: 0; }
.stv-shell { position: relative; z-index: 1; height: 100%; display: flex; flex-direction: column; color: var(--foreground); font: var(--text-base)/1.55 var(--font-ui); }
.stv-aurora { position: fixed; inset: -18%; z-index: 0; pointer-events: none; filter: blur(12px);
    background: radial-gradient(36% 28% at 20% 6%, var(--aurora-a), transparent 62%),
                radial-gradient(28% 24% at 80% 2%, var(--aurora-b), transparent 62%),
                radial-gradient(44% 32% at 50% 106%, var(--aurora-a), transparent 64%); }
.stv-veil { position: fixed; inset: 0; z-index: 0; pointer-events: none;
    background: radial-gradient(120% 92% at 50% 42%, transparent 56%, oklch(0 0 0 / 0.42) 100%); }
:root:not(.dark) .stv-veil { background: radial-gradient(120% 92% at 50% 42%, transparent 60%, oklch(0.4 0.02 258 / 0.1) 100%); }
.stv-appbar { display: flex; align-items: center; gap: var(--space-4); padding: 10px 20px; }
.stv-lockup { display: flex; align-items: center; gap: 10px; font-weight: 600; }
.stv-mark { width: 28px; height: 28px; border-radius: var(--radius-md); background: var(--surface-2); border: 1px solid var(--border); display: grid; place-items: center; color: var(--primary); font: 700 var(--text-xs) var(--font-mono); }
.stv-proj { color: var(--muted-fg); font-size: var(--text-md); }
.stv-appbar-slot { flex: 1; }
.stv-appbar-right { display: flex; align-items: center; gap: 10px; }
.stv-faces { display: flex; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 3px; }
.stv-faces button { border-radius: var(--radius-pill); padding: 6px 14px; font-size: var(--text-sm); color: var(--muted-fg); }
.stv-faces button:hover { color: var(--foreground); }
.stv-faces button[aria-pressed="true"] { background: var(--primary-soft); color: var(--primary); font-weight: 600; }
.stv-chip { display: inline-flex; align-items: center; gap: 7px; font: var(--text-sm) var(--font-mono); color: var(--muted-fg); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 6px 12px; }
.stv-chip-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--primary); }
.stv-chip-dot.run { background: var(--warning); animation: stv-pulse 1.1s infinite; }
@keyframes stv-pulse { 50% { opacity: .35; } }
.stv-btn { border-radius: var(--radius-pill); padding: 9px 18px; font-size: var(--text-md); transition: transform var(--dur-1) var(--ease-out), background-color var(--dur-2) ease; }
.stv-btn:active { transform: translateY(1px); }
.stv-btn.primary { background: var(--primary); color: var(--primary-fg); font-weight: 600; }
.stv-btn.ghost { background: var(--surface-2); border: 1px solid var(--border-strong); }
.stv-btn.ghost:hover { background: var(--surface-3); }
.stv-btn.quiet { color: var(--muted-fg); }
.stv-btn.quiet:hover { color: var(--foreground); }
.stv-tabs { position: relative; display: flex; gap: 2px; background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-pill); padding: 4px; }
.stv-tabs-slider { position: absolute; top: 4px; height: calc(100% - 8px); border-radius: var(--radius-pill); background: var(--foreground); box-shadow: var(--shadow-1); transition: transform var(--dur-3) var(--ease-tab), width var(--dur-3) var(--ease-tab); }
.stv-tabs button { position: relative; z-index: 1; min-width: 76px; border-radius: var(--radius-pill); color: var(--muted-fg); font-size: var(--text-md); line-height: 1; padding: 9px 16px; }
.stv-tabs button:hover { background: oklch(1 0 0 / 0.055); color: var(--foreground); }
:root:not(.dark) .stv-tabs button:hover { background: oklch(0 0 0 / 0.05); }
.stv-tabs button[aria-selected="true"] { color: var(--background); font-weight: 600; }
.stv-tabs .tick { color: var(--success); margin-right: 6px; font-family: var(--font-mono); font-size: var(--text-xs); }
.stv-body { flex: 1; display: grid; grid-template-columns: 224px minmax(0, 1fr) 344px; gap: var(--space-4); padding: 0 20px 18px; min-height: 0; }
.stv-rail, .stv-insp { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-1); overflow: auto; }
.stv-rail { padding: var(--space-4) var(--space-3); }
.stv-rail h4 { font: var(--text-xs) var(--font-mono); letter-spacing: .14em; text-transform: uppercase; color: var(--faint-fg); padding: 2px 10px 10px; }
.stv-rail-item { display: flex; align-items: baseline; gap: 10px; width: 100%; text-align: left; padding: 9px 10px; border-radius: var(--radius-md); color: var(--muted-fg); font-size: var(--text-md); }
.stv-rail-item:hover { background: var(--surface-2); color: var(--foreground); }
.stv-rail-item[aria-current="true"] { background: var(--primary-soft); color: var(--foreground); font-weight: 600; }
.stv-rail-item .no { font: var(--text-xs) var(--font-mono); color: var(--faint-fg); flex: 0 0 26px; }
.stv-rail-item[aria-current="true"] .no { color: var(--primary); }
.stv-rail-item .st { margin-left: auto; font-size: var(--text-xs); font-family: var(--font-mono); }
.stv-main { overflow: auto; display: flex; flex-direction: column; gap: var(--space-4); min-height: 0; }
.stv-bar { display: flex; align-items: center; gap: var(--space-3); }
.stv-bar h2 { font-size: var(--text-lg); font-weight: 600; }
.stv-bar .meta { font: var(--text-sm) var(--font-mono); color: var(--faint-fg); }
.stv-bar .piko { font: 700 var(--text-sm) var(--font-mono); letter-spacing: .14em; color: var(--primary); background: var(--primary-soft); border: 1px solid oklch(0.72 0.145 205 / 0.3); border-radius: var(--radius-sm); padding: 4px 9px; }
:root:not(.dark) .stv-bar .piko { border-color: oklch(0.54 0.13 210 / 0.3); }
.stv-bar .right { margin-left: auto; display: flex; gap: 8px; }
.stv-scene { background: var(--surface-1); border: 1px solid var(--border); border-radius: var(--radius-xl); box-shadow: var(--shadow-1); overflow: hidden; animation: stv-rise var(--dur-2) var(--ease-out) both; }
@keyframes stv-rise { from { opacity: 0; transform: translateY(6px); } }
.stv-scene > header { display: flex; align-items: center; gap: 10px; padding: 12px 16px; border-bottom: 1px solid var(--border); }
.stv-scene > header b { font-size: var(--text-base); font-weight: 600; }
.stv-scene .slug { font: var(--text-xs) var(--font-mono); color: var(--muted-fg); background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 3px 8px; }
.stv-scene .status { margin-left: auto; display: flex; align-items: center; gap: 7px; font: var(--text-sm) var(--font-mono); color: var(--muted-fg); }
.stv-scene .status i { width: 7px; height: 7px; border-radius: 50%; }
.stv-status-done i { background: var(--success); } .stv-status-run i { background: var(--warning); animation: stv-pulse 1.1s infinite; } .stv-status-wait i { background: var(--faint-fg); }
.stv-views { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--space-3); padding: 14px 16px 16px; }
.stv-view { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-lg); overflow: hidden; transition: border-color var(--dur-2) ease, transform var(--dur-2) var(--ease-out), box-shadow var(--dur-2) ease; }
.stv-view:hover { border-color: var(--border-strong); transform: translateY(-2px); box-shadow: var(--shadow-2); }
.stv-view[aria-pressed="true"] { border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.stv-view .t { display: flex; align-items: center; gap: 7px; padding: 8px 10px; font-size: var(--text-sm); color: var(--muted-fg); }
.stv-view .t .lock { margin-left: auto; color: var(--primary); font-size: var(--text-xs); }
.stv-still { position: relative; aspect-ratio: 16/9; background: var(--surface-3); background-size: cover; background-position: center; }
.stv-still::after { content: ""; position: absolute; inset: 0; background: radial-gradient(90% 60% at 50% 12%, oklch(1 0 0 / 0.18), transparent 55%), radial-gradient(120% 90% at 50% 115%, oklch(0 0 0 / 0.5), transparent 62%); }
.stv-still .badge { position: absolute; top: 8px; right: 8px; z-index: 1; font: var(--text-xs) var(--font-mono); color: var(--foreground); background: oklch(0 0 0 / 0.6); backdrop-filter: blur(6px); border-radius: var(--radius-sm); padding: 2px 8px; }
.stv-still .prog { position: absolute; left: 8px; right: 8px; bottom: 8px; z-index: 1; height: 3px; border-radius: var(--radius-pill); background: oklch(0 0 0 / 0.5); overflow: hidden; }
.stv-still .prog i { display: block; height: 100%; background: var(--warning); border-radius: var(--radius-pill); transition: width 240ms linear; }
.stv-view .acts { display: flex; border-top: 1px solid var(--border); }
.stv-view .acts button { flex: 1; border-right: 1px solid var(--border); color: var(--faint-fg); font-size: var(--text-sm); padding: 8px 0; }
.stv-view .acts button:last-child { border-right: 0; }
.stv-view .acts button:hover { color: var(--primary); background: var(--primary-soft); }
.stv-insp { padding: var(--space-4); display: flex; flex-direction: column; gap: var(--space-3); }
.stv-insp header { display: flex; align-items: center; gap: 10px; }
.stv-insp .no { width: 30px; height: 30px; border-radius: var(--radius-md); background: var(--primary-soft); color: var(--primary); display: grid; place-items: center; font: 700 var(--text-sm) var(--font-mono); }
.stv-insp header small { display: block; font: var(--text-xs) var(--font-mono); color: var(--faint-fg); letter-spacing: .08em; }
.stv-pair { display: grid; grid-template-columns: 1fr 1fr; gap: 10px; }
.stv-pair figure { background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-lg); padding: 7px; }
.stv-pair .th { aspect-ratio: 16/10; border-radius: var(--radius-md); background: var(--surface-3); background-size: cover; }
.stv-pair figcaption { display: flex; justify-content: space-between; font: var(--text-xs) var(--font-mono); color: var(--faint-fg); padding: 7px 3px 1px; }
.stv-pair figcaption button { color: var(--primary); font: var(--text-xs) var(--font-mono); }
.stv-field label { display: block; font-size: var(--text-sm); color: var(--muted-fg); margin-bottom: 6px; }
.stv-field textarea, .stv-field select, .stv-field input { width: 100%; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-md); padding: 10px 12px; font-size: var(--text-md); line-height: 1.6; }
.stv-field textarea:focus, .stv-field select:focus, .stv-field input:focus { outline: none; border-color: var(--primary); box-shadow: 0 0 0 3px var(--primary-soft); }
.stv-takes { display: grid; grid-template-columns: repeat(3, 1fr); gap: 9px; }
.stv-take { position: relative; border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; background: var(--surface-2); }
.stv-take:hover { border-color: var(--border-strong); }
.stv-take[aria-pressed="true"] { border-color: var(--primary); box-shadow: 0 0 0 2px var(--primary-soft); }
.stv-take .th { aspect-ratio: 16/10; background: var(--surface-3); background-size: cover; }
.stv-take .m { font: var(--text-xs) var(--font-mono); color: var(--faint-fg); padding: 5px 6px; }
.stv-take .tag { position: absolute; top: 5px; left: 5px; font: 700 9px var(--font-mono); color: var(--primary-fg); background: var(--primary); border-radius: 4px; padding: 1px 6px; }
.stv-progress { height: 5px; border-radius: var(--radius-pill); background: var(--surface-3); overflow: hidden; }
.stv-progress i { display: block; height: 100%; border-radius: var(--radius-pill); background: var(--primary); transition: width 240ms linear; }
.stv-progline { display: flex; justify-content: space-between; font: var(--text-xs) var(--font-mono); color: var(--faint-fg); margin-top: 7px; }
.stv-progline b { color: var(--warning); }
.stv-toasts { position: fixed; right: 20px; bottom: 20px; z-index: 60; display: flex; flex-direction: column; gap: 8px; }
.stv-toast { display: flex; align-items: center; gap: 10px; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: var(--radius-lg); padding: 11px 14px; font-size: var(--text-md); box-shadow: var(--shadow-2); animation: stv-rise var(--dur-2) var(--ease-out) both; }
.stv-toast i { width: 7px; height: 7px; border-radius: 50%; background: var(--success); }
.stv-toast.warn i { background: var(--warning); }
.stv-buddy { position: fixed; left: 248px; bottom: 22px; z-index: 30; display: flex; align-items: flex-end; gap: 10px; animation: stv-rise var(--dur-3) var(--ease-out) both; }
.stv-buddy-bubble { position: relative; background: var(--surface-2); border: 1px solid var(--border-strong); border-radius: 14px 14px 14px 4px; padding: 10px 30px 10px 14px; font-size: var(--text-md); color: var(--muted-fg); box-shadow: var(--shadow-2); max-width: 280px; }
.stv-buddy-bubble b { color: var(--foreground); }
.stv-buddy-x { position: absolute; top: 6px; right: 8px; color: var(--faint-fg); font-size: var(--text-sm); }
.stv-buddy-pet { width: 46px; height: 46px; border-radius: 50%; flex: 0 0 46px; position: relative; background: radial-gradient(circle at 34% 30%, oklch(0.8 0.12 205), oklch(0.5 0.1 210) 72%); box-shadow: 0 8px 22px oklch(0.72 0.145 205 / 0.35); }
.stv-buddy-pet::before, .stv-buddy-pet::after { content: ""; position: absolute; top: 16px; width: 7px; height: 9px; border-radius: 50%; background: oklch(0.25 0.03 235); }
.stv-buddy-pet::before { left: 12px; } .stv-buddy-pet::after { right: 12px; }
```

- [ ] **Step 7: 写 studio-create-route.tsx 并改 router.tsx**

```tsx
// src/studio/routes/studio-create-route.tsx
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { studioFaceEnabled } from "../flags";
import { StudioShell } from "../shell/StudioShell";
import { PipelineFace } from "../faces/pipeline/PipelineFace";
import { loadPipelineModel, type PipelineModel } from "../faces/pipeline/model";

const CreationWorkbenchPage = lazy(() => import("@/pages/create/creation-workbench"));

export default function StudioCreateRoute() {
    if (!studioFaceEnabled("pipeline")) return <CreationWorkbenchPage />;
    return <StudioPipelineRoute />;
}

function StudioPipelineRoute() {
    const [params] = useSearchParams();
    const projectId = params.get("project") ?? "";
    const [model, setModel] = useState<PipelineModel | null>(null);
    const [buddy, setBuddy] = useState(true);
    useEffect(() => {
        let alive = true;
        loadPipelineModel(projectId).then((next) => { if (alive) setModel(next); }).catch(() => { if (alive) setModel(null); });
        return () => { alive = false; };
    }, [projectId]);
    if (!model) return <CreationWorkbenchPage />;
    return (
        <StudioShell face="pipeline" projectLabel={`${model.projectName} / ${model.stages[model.stageIndex].label}`}
            runningCount={model.runningCount} onOpenTasks={() => {}} onFaceChange={() => {}}
            buddyText={buddy ? model.companionHint : undefined} onDismissBuddy={() => setBuddy(false)}>
            <PipelineFace model={model} onAction={() => {}} />
        </StudioShell>
    );
}
```

router.tsx 修改（把 `/create` 的 element 换成新路由，旧 lazy 保留供回退）：

```tsx
const StudioCreateRoute = lazy(() => import("@/studio/routes/studio-create-route"));
// ...
{ path: "/create", element: deferred(<StudioCreateRoute />) },
```

（`PipelineFace`/`model` 在 Task 7-8 创建；本任务提交前先用最小占位实现使路由可编译：`PipelineFace` 渲染 `<div className="stv-body" />`，`loadPipelineModel` 抛 `new Error("not implemented")`——Task 7 替换。若不愿留占位，则把 Task 7/8 提前于本任务的 Step 7 执行。）

- [ ] **Step 8: 运行测试 + lint + typecheck**

Run: `bun test test/studio-components.test.tsx && bun run lint && bun run typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add apps/canvas/web/src/studio apps/canvas/web/src/router.tsx apps/canvas/web/test/studio-components.test.tsx
git commit -m "feat(canvas): studio 壳与 /create strangler 接线"
```

---

### Task 3: SlidingTabs

**Files:** Create `src/studio/ui/SlidingTabs.tsx`；Test 追加 `test/studio-components.test.tsx`

**Interfaces:** Consumes tokens/studio.css（`.stv-tabs`）；Produces `SlidingTabs({ items: { key: string; label: string; done?: boolean }[]; value: string; onChange: (key: string) => void })`。

- [ ] **Step 1: 追加失败测试**

```tsx
import { SlidingTabs } from "../src/studio/ui/SlidingTabs";

describe("SlidingTabs", () => {
    const items = [
        { key: "s1", label: "项目配置", done: true },
        { key: "s2", label: "剧本创作", done: true },
        { key: "s3", label: "素材准备" },
    ];
    const html = renderToStaticMarkup(<SlidingTabs items={items} value="s3" onChange={() => {}} />);
    test("renders tablist with selected state", () => {
        expect(html).toContain('role="tablist"');
        expect(html).toMatch(/aria-selected="true"[^>]*>.*素材准备/s);
    });
    test("marks done stages with tick", () => {
        expect(html).toContain('class="tick"');
    });
    test("renders slider element", () => {
        expect(html).toContain("stv-tabs-slider");
    });
});
```

- [ ] **Step 2: 运行确认失败** → `bun test test/studio-components.test.tsx` FAIL（SlidingTabs 不存在）

- [ ] **Step 3: 实现**

```tsx
// src/studio/ui/SlidingTabs.tsx
import { useLayoutEffect, useRef, useState } from "react";

export type SlidingTabItem = { key: string; label: string; done?: boolean };

export function SlidingTabs({ items, value, onChange }: { items: SlidingTabItem[]; value: string; onChange: (key: string) => void }) {
    const refs = useRef<(HTMLButtonElement | null)[]>([]);
    const [box, setBox] = useState({ left: 0, width: 0 });
    const active = Math.max(0, items.findIndex((item) => item.key === value));
    useLayoutEffect(() => {
        const el = refs.current[active];
        if (el) setBox({ left: el.offsetLeft, width: el.offsetWidth });
    }, [active]);
    return (
        <nav className="stv-tabs" role="tablist" aria-label="制片流水线">
            <span className="stv-tabs-slider" style={{ left: box.left, width: box.width }} aria-hidden="true" />
            {items.map((item, index) => (
                <button key={item.key} type="button" role="tab" aria-selected={item.key === value}
                    ref={(el) => { refs.current[index] = el; }} onClick={() => onChange(item.key)}>
                    {item.done ? <span className="tick">✓</span> : null}{item.label}
                </button>
            ))}
        </nav>
    );
}
```

- [ ] **Step 4: 运行通过** → `bun test test/studio-components.test.tsx` PASS
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): SlidingTabs 白药丸滑块"`

---

### Task 4: StatusDot + toast store/ToastHost

**Files:** Create `src/studio/ui/StatusDot.tsx`、`src/studio/ui/toast-store.ts`、替换 `src/studio/ui/ToastHost.tsx`；Test 追加。

**Interfaces:** Produces `type StudioStatus = "done" | "run" | "wait"`、`STATUS_LABEL: Record<StudioStatus, string>`、`StatusDot({ status })`、`useStudioToast(): { push(text, warn?) }`、`ToastHost()`（订阅 store，4s 自动消失，最多 3 条）。

- [ ] **Step 1: 追加失败测试**

```tsx
import { StatusDot, STATUS_LABEL } from "../src/studio/ui/StatusDot";
import { useStudioToast } from "../src/studio/ui/toast-store";

describe("StatusDot", () => {
    test("labels cover all statuses", () => {
        expect(Object.keys(STATUS_LABEL).sort()).toEqual(["done", "run", "wait"]);
    });
    test("renders semantic class", () => {
        expect(renderToStaticMarkup(<StatusDot status="run" />)).toContain("stv-status-run");
    });
});

describe("toast store", () => {
    test("push keeps at most three and exposes text", () => {
        const { push, toasts } = useStudioToast.getState();
        useStudioToast.setState({ toasts: [] });
        ["a", "b", "c", "d"].forEach((text) => push(text));
        expect(useStudioToast.getState().toasts.map((t) => t.text)).toEqual(["b", "c", "d"]);
        void toasts;
    });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现三文件**

```tsx
// src/studio/ui/StatusDot.tsx
export type StudioStatus = "done" | "run" | "wait";
export const STATUS_LABEL: Record<StudioStatus, string> = { done: "完成", run: "渲染中", wait: "队列" };
export function StatusDot({ status }: { status: StudioStatus }) {
    return <i className={`stv-status-${status}`} aria-label={STATUS_LABEL[status]}><i /></i>;
}
```

```ts
// src/studio/ui/toast-store.ts
import { create } from "zustand";
export type StudioToast = { id: number; text: string; warn?: boolean };
let seq = 1;
export const useStudioToast = create<{ toasts: StudioToast[]; push: (text: string, warn?: boolean) => void; dismiss: (id: number) => void }>(
    (set) => ({
        toasts: [],
        push: (text, warn) => {
            const id = seq++;
            set((state) => ({ toasts: [...state.toasts, { id, text, warn }].slice(-3) }));
            setTimeout(() => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })), 4000);
        },
        dismiss: (id) => set((state) => ({ toasts: state.toasts.filter((t) => t.id !== id) })),
    }),
);
```

```tsx
// src/studio/ui/ToastHost.tsx
import { useStudioToast } from "./toast-store";
export function ToastHost() {
    const toasts = useStudioToast((state) => state.toasts);
    return (
        <div className="stv-toasts" aria-live="polite">
            {toasts.map((toast) => (
                <div className={`stv-toast${toast.warn ? " warn" : ""}`} key={toast.id}><i />{toast.text}</div>
            ))}
        </div>
    );
}
```

- [ ] **Step 4: 运行通过** + `bun run typecheck`
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): 状态语言与 toast 宿主"`

---

### Task 5: Button + Field + TakeStrip

**Files:** Create `src/studio/ui/Button.tsx`、`Field.tsx`、`TakeStrip.tsx`；Test 追加。

**Interfaces:** Produces `buttonVariants`（cva：variant primary/ghost/quiet）+ `Button`；`Field({ label, htmlFor, children })`；`TakeStrip({ takes: { id, label, seed, src? }[], activeId, onPick })`。

- [ ] **Step 1: 追加失败测试**

```tsx
import { Button } from "../src/studio/ui/Button";
import { Field } from "../src/studio/ui/Field";
import { TakeStrip } from "../src/studio/ui/TakeStrip";

describe("Button", () => {
    test("primary variant class", () => {
        expect(renderToStaticMarkup(<Button variant="primary" onClick={() => {}}>生成</Button>)).toContain("stv-btn primary");
    });
});

describe("Field", () => {
    test("links label to control", () => {
        const html = renderToStaticMarkup(<Field label="场景描述" htmlFor="desc"><textarea id="desc" /></Field>);
        expect(html).toContain('for="desc"');
        expect(html).toContain("场景描述");
    });
});

describe("TakeStrip", () => {
    const takes = [{ id: "a", label: "T1", seed: 1 }, { id: "b", label: "T2", seed: 2 }];
    const html = renderToStaticMarkup(<TakeStrip takes={takes} activeId="a" onPick={() => {}} />);
    test("marks active take", () => {
        expect(html).toMatch(/aria-pressed="true"[^>]*>.*ACTIVE/s);
    });
    test("renders seed meta", () => {
        expect(html).toContain("seed 1");
    });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```tsx
// src/studio/ui/Button.tsx
import { cva } from "class-variance-authority";
import type { ButtonHTMLAttributes } from "react";
export const buttonVariants = cva("stv-btn", { variants: { variant: { primary: "primary", ghost: "ghost", quiet: "quiet" } }, defaultVariants: { variant: "ghost" } });
export function Button({ variant, className, ...rest }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "quiet" }) {
    return <button type="button" className={[buttonVariants({ variant }), className].filter(Boolean).join(" ")} {...rest} />;
}
```

```tsx
// src/studio/ui/Field.tsx
import type { ReactNode } from "react";
export function Field({ label, htmlFor, children }: { label: string; htmlFor: string; children: ReactNode }) {
    return <div className="stv-field"><label htmlFor={htmlFor}>{label}</label>{children}</div>;
}
```

```tsx
// src/studio/ui/TakeStrip.tsx
export type TakeItem = { id: string; label: string; seed: number; src?: string };
export function TakeStrip({ takes, activeId, onPick }: { takes: TakeItem[]; activeId?: string; onPick: (id: string) => void }) {
    return (
        <div className="stv-takes">
            {takes.map((take) => (
                <button key={take.id} type="button" className="stv-take" aria-pressed={take.id === activeId} onClick={() => onPick(take.id)}>
                    {take.id === activeId ? <span className="tag">ACTIVE</span> : null}
                    <div className="th" style={take.src ? { backgroundImage: `url(${take.src})` } : undefined} />
                    <div className="m">{take.label} · seed {take.seed}</div>
                </button>
            ))}
        </div>
    );
}
```

- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): Button/Field/TakeStrip 基础件"`

---

### Task 6: MediaTile + ViewGroup

**Files:** Create `src/studio/ui/MediaTile.tsx`、`ViewGroup.tsx`；Test 追加。

**Interfaces:** Produces `MediaTile({ label, src?, status, progress?, badge?, locked?, selected?, onSelect?, onPreview?, onReplace?, onDownload? })`；`ViewGroup({ scene: { id, name, slug }, views: MediaTileProps-ish[], selectedViewId, onViewSelect, onPreview, onReplace, onDownload })`，header 状态由 views 推导（run > done 计数 > wait）。

- [ ] **Step 1: 追加失败测试**

```tsx
import { MediaTile } from "../src/studio/ui/MediaTile";
import { ViewGroup } from "../src/studio/ui/ViewGroup";

const view = { id: "v1", label: "主视", status: "done" as const, badge: "SEED 88213", locked: true };

describe("MediaTile", () => {
    const html = renderToStaticMarkup(<MediaTile {...view} selected onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("exposes select semantics and actions", () => {
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("预览"); expect(html).toContain("替换"); expect(html).toContain("下载");
    });
    test("shows lock marker when locked", () => {
        expect(html).toContain('class="lock"');
    });
});

describe("ViewGroup", () => {
    const views = [view, { id: "v2", label: "反打", status: "run" as const, progress: 48 }];
    const html = renderToStaticMarkup(<ViewGroup scene={{ id: "s1", name: "中军主帅营帐", slug: "INT / 日" }} views={views} selectedViewId="v1" onViewSelect={() => {}} onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("derives running header status", () => {
        expect(html).toContain("stv-status-run");
        expect(html).toContain("渲染中 48%");
    });
    test("renders slug and name", () => {
        expect(html).toContain("INT / 日");
        expect(html).toContain("中军主帅营帐");
    });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现**

```tsx
// src/studio/ui/MediaTile.tsx
import type { StudioStatus } from "./StatusDot";
export type MediaTileProps = {
    label: string; src?: string; status: StudioStatus; progress?: number; badge?: string; locked?: boolean; selected?: boolean;
    onSelect?: () => void; onPreview?: () => void; onReplace?: () => void; onDownload?: () => void;
};
export function MediaTile({ label, src, status, progress, badge, locked, selected, onSelect, onPreview, onReplace, onDownload }: MediaTileProps) {
    return (
        <div className="stv-view" role="button" tabIndex={0} aria-pressed={Boolean(selected)} onClick={onSelect} onKeyDown={(e) => { if (e.key === "Enter" && onSelect) onSelect(); }}>
            <div className="t">{label}{locked ? <span className="lock" title="视图锁">⌗</span> : null}</div>
            <div className="stv-still" style={src ? { backgroundImage: `url(${src})` } : undefined}>
                {status !== "wait" ? <span className="badge">{badge ?? (status === "run" ? `${progress ?? 0}%` : "")}</span> : null}
                {status === "run" ? <span className="prog"><i style={{ width: `${progress ?? 0}%` }} /></span> : null}
            </div>
            <div className="acts">
                <button type="button" onClick={(e) => { e.stopPropagation(); onPreview?.(); }}>预览</button>
                <button type="button" onClick={(e) => { e.stopPropagation(); onReplace?.(); }}>替换</button>
                <button type="button" onClick={(e) => { e.stopPropagation(); onDownload?.(); }}>下载</button>
            </div>
        </div>
    );
}
```

```tsx
// src/studio/ui/ViewGroup.tsx
import { MediaTile, type MediaTileProps } from "./MediaTile";
import { STATUS_LABEL, type StudioStatus } from "./StatusDot";
export type ViewGroupScene = { id: string; name: string; slug: string };
export function groupStatus(views: { status: StudioStatus; progress?: number }[]): { status: StudioStatus; text: string } {
    const running = views.find((v) => v.status === "run");
    if (running) return { status: "run", text: `渲染中 ${running.progress ?? 0}%` };
    const done = views.filter((v) => v.status === "done").length;
    if (done === views.length) return { status: "done", text: `${done}/${views.length} ${STATUS_LABEL.done}` };
    return { status: done > 0 ? "run" : "wait", text: `${done}/${views.length} ${STATUS_LABEL.done}` };
}
export function ViewGroup({ scene, views, selectedViewId, onViewSelect, onPreview, onReplace, onDownload }: {
    scene: ViewGroupScene; views: (MediaTileProps & { id: string })[]; selectedViewId?: string;
    onViewSelect: (sceneId: string, viewId: string) => void;
    onPreview: (sceneId: string, viewId: string) => void;
    onReplace: (sceneId: string, viewId: string) => void;
    onDownload: (sceneId: string, viewId: string) => void;
}) {
    const head = groupStatus(views);
    return (
        <section className="stv-scene">
            <header><b>{scene.name}</b><span className="slug">{scene.slug}</span>
                <span className={`status stv-status-${head.status}`}><i />{head.text}</span></header>
            <div className="stv-views">
                {views.map((view) => (
                    <MediaTile key={view.id} {...view} selected={view.id === selectedViewId}
                        onSelect={() => onViewSelect(scene.id, view.id)}
                        onPreview={() => onPreview(scene.id, view.id)}
                        onReplace={() => onReplace(scene.id, view.id)}
                        onDownload={() => onDownload(scene.id, view.id)} />
                ))}
            </div>
        </section>
    );
}
```

- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): MediaTile/ViewGroup 多视图组"`

---

### Task 7: 流水线数据适配器 model.ts

**Files:** Create `src/studio/faces/pipeline/model.ts`；Test `test/studio-pipeline-model.test.ts`

**Interfaces:** Consumes `fetchDramaProject`、`listToivScenes`（`src/services/toiv/client.ts:825,1153`）；Produces `loadPipelineModel(pid): Promise<PipelineModel>` 与类型 `PipelineModel/SceneGroupModel/ViewTileModel/ShotCardModel/TakeModel`。

- [ ] **Step 1: 写失败测试（mock.module 替换 client）**

```ts
// test/studio-pipeline-model.test.ts
import { describe, expect, mock, test } from "bun:test";

mock.module("@/services/toiv/client", () => ({
    fetchDramaProject: async () => ({
        id: "p1", name: "草船借箭",
        shots: [
            { id: "sh1", idx: 0, status: "done", prompt: "晨雾悬崖", camera: "STATIC", duration_sec: 4.5,
              candidates: [{ id: "c1", seed: 88213, is_picked: true, url: "/m/1.png" }, { id: "c2", seed: 88214, url: "/m/2.png" }] },
            { id: "sh2", idx: 1, status: "running", prompt: "睁眼特写", camera: "DOLLY IN", duration_sec: 3, candidates: [] },
        ],
    }),
    listToivScenes: async () => ({
        scenes: [{ id: "s1", project_id: "p1", name: "中军主帅营帐", environment_prompt: "INT", master_ref: "/m/a.png", reverse_ref: "/m/b.png", frozen_anchor: { anchor_id: "master" },
            variants: [{ id: "s1v1", name: "左", master_ref: "/m/c.png" }, { id: "s1v2", name: "右", master_ref: null }] }],
        orphans: [],
    }),
}));

const { loadPipelineModel } = await import("@/studio/faces/pipeline/model");

describe("loadPipelineModel", () => {
    test("maps scenes to four-view groups with lock and wait padding", async () => {
        const model = await loadPipelineModel("p1");
        const group = model.scenes[0];
        expect(group.views.map((v) => v.label)).toEqual(["主视", "反打", "左立面", "右立面"]);
        expect(group.views[0].locked).toBe(true);
        expect(group.views[3].status).toBe("wait");
        expect(group.views[0].src).toBe("/m/a.png");
    });
    test("maps shot candidates to takes with picked active", async () => {
        const model = await loadPipelineModel("p1");
        expect(model.shots[0].takes).toHaveLength(2);
        expect(model.shots[0].activeTakeId).toBe("c1");
        expect(model.shots[1].status).toBe("run");
    });
    test("exposes running count and companion hint", async () => {
        const model = await loadPipelineModel("p1");
        expect(model.runningCount).toBe(1);
        expect(model.companionHint.length).toBeGreaterThan(0);
    });
});
```

- [ ] **Step 2: 运行确认失败** → `bun test test/studio-pipeline-model.test.ts`
- [ ] **Step 3: 实现 model.ts**

```ts
// src/studio/faces/pipeline/model.ts
import { fetchDramaProject, listToivScenes } from "@/services/toiv/client";
import type { StudioStatus } from "@/studio/ui/StatusDot";

export type ViewTileModel = { id: string; label: string; src?: string; status: StudioStatus; progress?: number; badge?: string; locked?: boolean };
export type SceneGroupModel = { id: string; name: string; slug: string; views: ViewTileModel[] };
export type TakeModel = { id: string; label: string; seed: number; src?: string };
export type ShotCardModel = { id: string; title: string; prompt: string; camera: string; durationSec: number; status: StudioStatus; takes: TakeModel[]; activeTakeId?: string };
export type PipelineModel = {
    projectId: string; projectName: string; runningCount: number; companionHint: string;
    stages: { key: string; label: string; done: boolean }[]; stageIndex: number;
    scenes: SceneGroupModel[]; shots: ShotCardModel[];
};

export const STAGE_LABELS = ["项目配置", "剧本创作", "素材准备", "分镜设计", "视频生成", "音画同步", "成品预览"];
const VIEW_LABELS = ["主视", "反打", "左立面", "右立面"];

function viewFrom(label: string, src: string | null | undefined, locked: boolean): ViewTileModel {
    return src ? { id: `${label}-${src}`, label, src, status: "done", locked, badge: "" } : { id: `${label}-empty`, label, status: "wait", locked };
}

export async function loadPipelineModel(projectId: string): Promise<PipelineModel> {
    const [detail, scenePage] = await Promise.all([fetchDramaProject(projectId), listToivScenes(projectId)]);
    const scenes: SceneGroupModel[] = (scenePage.scenes ?? []).map((scene) => {
        const variants = scene.variants ?? [];
        const refs = [scene.master_ref ?? null, scene.reverse_ref ?? null, variants[0]?.master_ref ?? null, variants[1]?.master_ref ?? null];
        return {
            id: scene.id, name: scene.name, slug: scene.environment_prompt ? scene.environment_prompt.slice(0, 12) : "—",
            views: VIEW_LABELS.map((label, index) => viewFrom(label, refs[index], Boolean(scene.frozen_anchor))),
        };
    });
    const shots: ShotCardModel[] = (detail.shots ?? []).map((shot, index) => {
        const candidates = shot.candidates ?? [];
        return {
            id: shot.id, title: `镜${String(index + 1).padStart(2, "0")}`, prompt: shot.prompt ?? "", camera: shot.camera ?? "—",
            durationSec: shot.duration_sec ?? 0,
            status: shot.status === "done" ? "done" : shot.status === "running" || shot.status === "rendering" ? "run" : "wait",
            takes: candidates.map((candidate, ci) => ({ id: candidate.id, label: `T${ci + 1}`, seed: candidate.seed ?? 0, src: candidate.url })),
            activeTakeId: candidates.find((candidate) => candidate.is_picked)?.id ?? candidates[0]?.id,
        };
    });
    const runningCount = shots.filter((shot) => shot.status === "run").length;
    const stageIndex = 2;
    return {
        projectId, projectName: detail.name ?? projectId, runningCount,
        companionHint: runningCount > 0 ? `还有 ${runningCount} 个镜头在渲染，完成后我会提醒你择一。` : "所有镜头已就绪，可以进入分镜设计。",
        stages: STAGE_LABELS.map((label, index) => ({ key: `s${index}`, label, done: index < stageIndex })),
        stageIndex, scenes, shots,
    };
}
```

- [ ] **Step 4: 运行通过**
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): 流水线面数据适配器"`

---

### Task 8: PipelineFace 组合

**Files:** Create `src/studio/faces/pipeline/PipelineFace.tsx`；Test 追加 `test/studio-components.test.tsx`

**Interfaces:** Consumes Task 3-7 全部组件与模型；Produces `PipelineFace({ model, onAction }: { model: PipelineModel; onAction: (action: PipelineAction) => void })`，`type PipelineAction = { type: "view-select" | "view-preview" | "view-replace" | "view-download" | "take-pick" | "take-new" | "stage-change"; sceneId?: string; viewId?: string; shotId?: string; takeId?: string; stageIndex?: number }`；内部持有 selectedScene/selectedView/activeTake 本地状态。

- [ ] **Step 1: 追加失败测试**

```tsx
import { PipelineFace } from "../src/studio/faces/pipeline/PipelineFace";
import type { PipelineModel } from "../src/studio/faces/pipeline/model";

const model: PipelineModel = {
    projectId: "p1", projectName: "草船借箭", runningCount: 1, companionHint: "hint",
    stages: [{ key: "s0", label: "项目配置", done: true }, { key: "s1", label: "剧本创作", done: true }, { key: "s2", label: "素材准备", done: false }],
    stageIndex: 2,
    scenes: [{ id: "s1", name: "中军主帅营帐", slug: "INT / 日", views: [{ id: "v1", label: "主视", status: "done", badge: "SEED 1", locked: true }] }],
    shots: [{ id: "sh1", title: "镜01", prompt: "p", camera: "STATIC", durationSec: 4.5, status: "done", takes: [{ id: "c1", label: "T1", seed: 1 }], activeTakeId: "c1" }],
};

describe("PipelineFace", () => {
    const html = renderToStaticMarkup(<PipelineFace model={model} onAction={() => {}} />);
    test("renders three-column body", () => {
        expect(html).toContain('class="stv-body"');
        expect(html).toContain('aria-label="场次目录"');
        expect(html).toContain('aria-label="场景检查器"');
    });
    test("renders stage tabs and scene group", () => {
        expect(html).toContain('role="tablist"');
        expect(html).toContain("中军主帅营帐");
    });
    test("renders take strip with active", () => {
        expect(html).toContain("ACTIVE");
    });
});
```

- [ ] **Step 2: 运行确认失败**
- [ ] **Step 3: 实现 PipelineFace（rail=scenes 目录 + main=SlidingTabs+bar+ViewGroup 列表 + insp=检查器；所有回调转 onAction；take 选择写本地 state 并 onAction）**

```tsx
// src/studio/faces/pipeline/PipelineFace.tsx
import { useState } from "react";
import type { PipelineModel } from "./model";
import { SlidingTabs } from "@/studio/ui/SlidingTabs";
import { ViewGroup } from "@/studio/ui/ViewGroup";
import { TakeStrip } from "@/studio/ui/TakeStrip";
import { Field } from "@/studio/ui/Field";
import { Button } from "@/studio/ui/Button";

export type PipelineAction = {
    type: "view-select" | "view-preview" | "view-replace" | "view-download" | "take-pick" | "take-new" | "stage-change";
    sceneId?: string; viewId?: string; shotId?: string; takeId?: string; stageIndex?: number;
};

export function PipelineFace({ model, onAction }: { model: PipelineModel; onAction: (action: PipelineAction) => void }) {
    const [sceneId, setSceneId] = useState(model.scenes[0]?.id ?? "");
    const [viewId, setViewId] = useState(model.scenes[0]?.views[0]?.id ?? "");
    const [activeTake, setActiveTake] = useState<Record<string, string | undefined>>({});
    const scene = model.scenes.find((s) => s.id === sceneId) ?? model.scenes[0];
    const shot = model.shots[0];
    const currentTake = shot ? activeTake[shot.id] ?? shot.activeTakeId : undefined;
    return (
        <div className="stv-body">
            <aside className="stv-rail" aria-label="场次目录">
                <h4>场次</h4>
                {model.scenes.map((group, index) => (
                    <button key={group.id} type="button" className="stv-rail-item" aria-current={group.id === scene?.id}
                        onClick={() => { setSceneId(group.id); setViewId(group.views[0]?.id ?? ""); }}>
                        <span className="no">{String(index + 1).padStart(2, "0")}</span>{group.name}
                        <span className={`st stv-status-${group.views.some((v) => v.status === "run") ? "run" : group.views.every((v) => v.status === "done") ? "done" : "wait"}`}>
                            {group.views.some((v) => v.status === "run") ? "●" : group.views.every((v) => v.status === "done") ? "✓" : "○"}
                        </span>
                    </button>
                ))}
            </aside>
            <main className="stv-main">
                <SlidingTabs items={model.stages.map((s, i) => ({ key: s.key, label: s.label, done: i < model.stageIndex }))}
                    value={model.stages[model.stageIndex].key}
                    onChange={(key) => onAction({ type: "stage-change", stageIndex: model.stages.findIndex((s) => s.key === key) })} />
                <div className="stv-bar">
                    <h2>场景</h2><span className="meta">{model.scenes.length} 场景 · 每场景 4 视图</span>
                </div>
                {model.scenes.map((group) => (
                    <ViewGroup key={group.id} scene={group} views={group.views.map((v) => ({ ...v, id: v.id }))}
                        selectedViewId={group.id === scene?.id ? viewId : undefined}
                        onViewSelect={(sid, vid) => { setSceneId(sid); setViewId(vid); onAction({ type: "view-select", sceneId: sid, viewId: vid }); }}
                        onPreview={(sid, vid) => onAction({ type: "view-preview", sceneId: sid, viewId: vid })}
                        onReplace={(sid, vid) => onAction({ type: "view-replace", sceneId: sid, viewId: vid })}
                        onDownload={(sid, vid) => onAction({ type: "view-download", sceneId: sid, viewId: vid })} />
                ))}
            </main>
            <aside className="stv-insp" aria-label="场景检查器">
                <header><span className="no">{String(model.stageIndex + 1).padStart(2, "0")}</span>
                    <div><b>{scene?.name ?? "—"}</b><small>{scene?.slug ?? ""} · 4 VIEWS</small></div></header>
                {shot ? (
                    <>
                        <Field label="镜头提示词" htmlFor="shot-prompt"><textarea id="shot-prompt" rows={4} defaultValue={shot.prompt} /></Field>
                        <Field label="候选 Takes" htmlFor="takes"><div id="takes">
                            <TakeStrip takes={shot.takes} activeId={currentTake}
                                onPick={(takeId) => { setActiveTake((prev) => ({ ...prev, [shot.id]: takeId })); onAction({ type: "take-pick", shotId: shot.id, takeId }); }} />
                        </div></Field>
                        <Button variant="primary" onClick={() => onAction({ type: "take-new", shotId: shot.id })}>生成新 Take</Button>
                    </>
                ) : null}
            </aside>
        </div>
    );
}
```

- [ ] **Step 4: 运行通过 + typecheck**
- [ ] **Step 5: Commit** → `git commit -m "feat(canvas): PipelineFace 三面栏组合"`

---

### Task 9: 浏览器交互 harness

**Files:** Create `test/fixtures/studio-pipeline-harness.tsx`、`test/studio-pipeline.browser.test.ts`

**Interfaces:** harness 用静态 fixture 模型渲染 StudioShell+PipelineFace，动作写入 `window.__studioActions`；browser test 断言交互语义。

- [ ] **Step 1: 写 harness fixture**

```tsx
// test/fixtures/studio-pipeline-harness.tsx
import { createRoot } from "react-dom/client";
import { StudioShell } from "@/studio/shell/StudioShell";
import { PipelineFace, type PipelineAction } from "@/studio/faces/pipeline/PipelineFace";
import { useStudioToast } from "@/studio/ui/toast-store";
import type { PipelineModel } from "@/studio/faces/pipeline/model";
import "@/studio/studio.css";

declare global { interface Window { __studioActions: PipelineAction[]; } }
window.__studioActions = [];

const model: PipelineModel = {
    projectId: "p1", projectName: "草船借箭", runningCount: 1, companionHint: "还有 1 个镜头在渲染。",
    stages: [
        { key: "s0", label: "项目配置", done: true }, { key: "s1", label: "剧本创作", done: true },
        { key: "s2", label: "素材准备", done: false }, { key: "s3", label: "分镜设计", done: false },
    ],
    stageIndex: 2,
    scenes: [{
        id: "s1", name: "中军主帅营帐", slug: "INT / 日",
        views: [
            { id: "v1", label: "主视", status: "done", badge: "SEED 88213", locked: true },
            { id: "v2", label: "反打", status: "done", badge: "SEED 88214" },
            { id: "v3", label: "左立面", status: "run", progress: 48 },
            { id: "v4", label: "右立面", status: "wait" },
        ],
    }],
    shots: [{ id: "sh1", title: "镜01", prompt: "晨雾悬崖", camera: "STATIC", durationSec: 4.5, status: "done",
        takes: [{ id: "c1", label: "T1", seed: 1 }, { id: "c2", label: "T2", seed: 2 }], activeTakeId: "c1" }],
};

createRoot(document.getElementById("root")!).render(
    <StudioShell face="pipeline" projectLabel="草船借箭 / 素材准备" runningCount={model.runningCount}
        onOpenTasks={() => {}} onFaceChange={() => {}} buddyText={model.companionHint} onDismissBuddy={() => {}}>
        <PipelineFace model={model} onAction={(action) => {
            window.__studioActions.push(action);
            useStudioToast.getState().push(`action:${action.type}`);
        }} />
    </StudioShell>,
);
```

- [ ] **Step 2: 写 browser test（沿用仓内 Bun.build + Bun.serve + playwright 模式；plugin 需含 `@/` 与 `@content-lock` alias、css 空导出）**

```ts
// test/studio-pipeline.browser.test.ts（骨架：beforeAll 构建 harness 并起服务；断言见下）
test("stage tab switch moves aria-selected", async () => {
    await page.getByRole("tab", { name: "分镜设计" }).click();
    await expect(page.getByRole("tab", { name: "分镜设计" })).toHaveAttribute("aria-selected", "true");
});
test("view select sets pressed and records action", async () => {
    await page.getByRole("button", { name: /反打/ }).first().click();
    const actions = await page.evaluate(() => window.__studioActions);
    expect(actions.some((a) => a.type === "view-select" && a.viewId === "v2")).toBe(true);
});
test("take pick moves ACTIVE tag", async () => {
    await page.getByRole("button", { name: /T2 · seed 2/ }).click();
    await expect(page.locator(".stv-take[aria-pressed='true'] .tag")).toHaveText("ACTIVE");
});
test("replace action raises toast", async () => {
    await page.getByRole("button", { name: "替换" }).first().click();
    await expect(page.locator(".stv-toast").first()).toContainText("action:view-replace");
});
```

（beforeAll/afterAll 与构建插件照抄 `test/canvas-node-editor-scope.browser.test.ts` 的 plugins 定义，entrypoints 换本 fixture；serve 路由 `/harness.js` + 其余返回含 `<div id="root">` 的 html。）

- [ ] **Step 3: 运行确认失败→通过**：`bun test test/studio-pipeline.browser.test.ts`
- [ ] **Step 4: Commit** → `git commit -m "test(canvas): 流水线面交互 harness"`

---

### Task 10: 债务门禁 + 全量验证 + 截图

**Files:** Create `test/studio-debt-metrics.test.ts`

- [ ] **Step 1: 写债务门禁测试**

```ts
// test/studio-debt-metrics.test.ts
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const studioDir = resolve(import.meta.dir, "../src/studio");
function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const path = join(dir, name);
        return statSync(path).isDirectory() ? walk(path) : [path];
    });
}
const files = walk(studioDir);
const css = files.filter((f) => f.endsWith(".css"));
const tsx = files.filter((f) => f.endsWith(".tsx"));

describe("studio debt metrics", () => {
    test("no !important anywhere", () => {
        for (const file of files) expect(readFileSync(file, "utf8")).not.toContain("!important");
    });
    test("no hardcoded colors outside tokens.css", () => {
        for (const file of files.filter((f) => !f.endsWith("tokens.css"))) {
            const body = readFileSync(file, "utf8").replace(/oklch\([^)]*\)/g, "");
            expect(body).not.toMatch(/#[0-9a-fA-F]{6}/);
        }
    });
    test("no inline style objects in components except src/backgroundImage allowlist", () => {
        for (const file of tsx) {
            const body = readFileSync(file, "utf8");
            const inline = body.match(/style=\{\{/g) ?? [];
            const allowed = body.match(/backgroundImage|width: `/g) ?? [];
            expect(inline.length).toBe(allowed.length);
        }
    });
    test("each css file <= 800 lines", () => {
        for (const file of css) expect(readFileSync(file, "utf8").split("\n").length).toBeLessThanOrEqual(800);
    });
    test("no antd imports in studio", () => {
        for (const file of tsx) expect(readFileSync(file, "utf8")).not.toMatch(/from "antd"/);
    });
});
```

- [ ] **Step 2: 运行债务测试**：`bun test test/studio-debt-metrics.test.ts` → PASS
- [ ] **Step 3: 全量门禁**：`bun run test && bun run lint && bun run typecheck`（canvas/web）；再跑 `cd apps/web && npm test && npm run typecheck` 确认 web 副本无回归
- [ ] **Step 4: 真机截图**：`bun run dev` 起 canvas/web（不带 VITE_STUDIO_FACE_FALLBACK），playwright 截 `/create` 暗/亮两态存 `/tmp/studio-face-*.png`，与 `/tmp/proto-1-pipe.png` 对照
- [ ] **Step 5: Commit** → `git commit -m "test(canvas): studio 债务门禁与全量验证"`

---

## Self-Review 记录

- Spec 覆盖：§3 token→T1；§3.2 签名件→T2/T3/shell；§4.1 流水线面→T6-T8；§4.4 共享件（toast/companion/任务胶囊）→T2/T4；§4.5 双轨 FaceSwitcher→T2（审批/配方/导出菜单属 Plan 2-4）；§5 组件→T3-T6（其余组件在 Plan 2-4）；§6 架构/strangler/flags→T2；§7 反馈→T4；§8 测试/债务→T9/T10；§2 硬约束→Global Constraints + T10 门禁。
- 占位符：Task 2 Step 7 曾允许占位 PipelineFace，已改为"若不愿留占位则调换 Task 7/8 顺序"的二选一明确指令；执行者默认按 T7→T8→T2.Step7 顺序实施以避免占位。
- 类型一致：`StudioStatus`/`MediaTileProps`/`ViewGroup`/`PipelineModel`/`PipelineAction` 在 T4-T8 间签名一致；`groupStatus` 仅 ViewGroup 内部使用。
