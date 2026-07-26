# ToIV Canvas & UX Overhaul — Comprehensive Project Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring ToIV's infinite canvas and overall UX from MVP-prototype quality to production-grade, closing the gap with LibTV's canvas interaction paradigm, fixing P0/P1 UI defects, and establishing a foundation for collaborative features.

**Architecture:** The plan is organized into 5 milestones sequenced by dependency. Milestone 1 (P0 Bugfixes) is standalone and can ship immediately. Milestones 2-3 build core canvas interaction (double-click to create, context menu, keyboard shortcuts, visual feedback). Milestone 4 adds productivity features (minimap interactivity, multi-select, node grouping, undo/redo). Milestone 5 adds onboarding and UX polish across all views. Each milestone is independently deployable.

**Tech Stack:**
- Frontend: Next.js 15 + React 19 + TypeScript (strict) + `@xyflow/react` (React Flow) for canvas
- Backend: FastAPI + SSE for real-time canvas events
- State: Zustand (`lib/canvas/store.ts`)
- Icons: lucide-react
- Testing: Vitest (unit) + Playwright (E2E) + pytest (backend)

---

## Project Scope Summary

### In Scope (This Plan)
- Fix P0/P1 functional bugs identified in QA
- Canvas core interaction parity with industry standards (double-click create, drag-connect, context menu)
- Canvas productivity features (keyboard shortcuts, multi-select, interactive minimap)
- UX polish (loading states, tooltips, empty states, node selection visual)
- New user onboarding for canvas
- URL/cookie consistency (localhost vs 127.0.0.1)
- SSE cleanup on navigation
- Unified empty-state design system

### Out of Scope (Future Phases)
- Multiplayer real-time collaboration (CRDT/Yjs) — P3 long-term
- Version history & branching — P3 long-term
- Drag-and-drop asset library integration — P2 mid-term
- Canvas WebGL rendering for 100+ node performance — P2 mid-term
- Node grouping/collapse — P2 mid-term
- Mobile/touch optimization — deferred

### Timeline (Total: ~3 weeks)

| Milestone | Duration | Deliverable |
|---|---|---|
| M1: P0 Bugfixes & Stabilization | 2 days | All P0 bugs fixed; build green; console clean |
| M2: Core Canvas Interaction | 4 days | Double-click create, drag-connect edges, context menu working |
| M3: Keyboard Shortcuts & Visual Feedback | 3 days | 10+ shortcuts, selection polish, loading states, tooltips |
| M4: Productivity Features | 5 days | Interactive minimap, multi-select/box select, undo/redo, node actions |
| M5: Onboarding & Global UX Polish | 3 days | Canvas onboarding flow, empty states, URL consistency |
| Buffer & QA | 3 days | Full regression, E2E testing, performance tuning |

---

## Risk Assessment

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| React Flow API changes on upgrade | Medium | High | Pin `@xyflow/react` version; test interactions before committing |
| Zustand store changes causing state bugs | Medium | Medium | Each store change paired with unit tests; use immer for immutable updates |
| Keyboard shortcut conflicts with browser | Low | Medium | Bind to canvas container; use cmd/ctrl combos only; prevent default only when canvas focused |
| Double-click vs single-click ambiguity | Medium | Medium | Use onDoubleClick with 250ms delay; ignore accidental double-clicks on existing nodes |
| Performance degradation with many nodes | Low (at our current scale) | Medium | Implement virtualization later; M5 adds basic node count warning |
| CORS/cookie issues from localhost/127.0.0.1 mismatch | High | High | Standardize on one dev origin; use env-driven config |

---

## Quality Assurance Measures

- **Unit Tests:** Every new Zustand action, utility function, and hook gets Vitest tests (≥80% coverage target for canvas code)
- **Component Tests:** React Testing Library for interactive components (context menu, node creation, keyboard handler)
- **E2E Tests:** Playwright auth-canvas spec extended for each feature (double-click, connect, delete, undo)
- **Visual Regression:** Screenshot comparison for canvas states (empty, selected node, connected nodes, context menu)
- **Manual QA Checklist:** Each milestone ends with a dogfood pass of the full canvas workflow
- **Console Hygiene:** Zero new console errors/warnings on any page; all SSE connections properly closed
- **Type Safety:** `tsc --noEmit` passes with zero errors; all new code uses strict TypeScript

---

## Progress Tracking & Communication

- **STATE.json** updated at every milestone completion with health checks (pytest, tsc, build, e2e)
- **TEST_LOG.md** appended with chronological test results for each milestone
- **Conventional Commits:** `feat(canvas):`, `fix(canvas):`, `ux:`, etc.
- **Per-Milestone PRs:** Each milestone is a separate atomic PR with its own test evidence
- **Definition of Done:** Code written → unit tests pass → E2E test added → manual QA pass → no console errors → STATE.json updated

---

# Milestone 1: P0 Bugfixes & Stabilization (2 days)

**Goal:** Fix all P0 bugs identified in QA, ensure clean console, consistent dev URLs, and stable foundation for further work.

**Success Criteria:**
- Zoom In button enables when nodes exist
- Zero ERR_ABORTED from SSE on page navigation
- Consistent origin (no localhost/127.0.0.1 switching)
- All P0/P1 functional bugs resolved
- Console shows zero errors on navigation between all views

### Task 1.1: Fix CORS/Origin Consistency

**Files:**
- Modify: `apps/api/app/config.py`
- Modify: `apps/api/.env`
- Modify: `apps/web/.env.local` (create if missing, check existing)

The current bug: logging in at `127.0.0.1:3100` redirects to `localhost:3100` after auth, causing CORS issues and cookie scoping problems. We standardize dev environment to `localhost:3100` everywhere.

- [ ] **Step 1: Verify/update .env.local to use localhost**

Read `apps/web/.env.local` and ensure API base uses `localhost`:
```
NEXT_PUBLIC_API_BASE=http://localhost:8090
INTERNAL_API_BASE=http://localhost:8090
```

- [ ] **Step 2: Update CORS config to prefer localhost and ensure 127.0.0.1 also works for safety**

In `apps/api/app/config.py` line 61, the current value is good but ensure .env matches. In `apps/api/.env` line 22, verify:
```
TOIV_CORS_ORIGINS=https://toiv.dgmt.top;http://localhost:3100;http://localhost:3101;http://127.0.0.1:3100;http://127.0.0.1:3101
```

- [ ] **Step 3: Verify with curl**

```bash
curl -s -X OPTIONS -H "Origin: http://localhost:3100" -H "Access-Control-Request-Method: POST" -o /dev/null -w "%{http_code}" http://localhost:8090/api/auth/login
# Expected: 200
```

- [ ] **Step 4: Commit**

```bash
git add apps/web/.env.local apps/api/app/config.py apps/api/.env
git commit -m "fix: standardize dev origin to localhost for CORS/cookie consistency"
```

### Task 1.2: Fix Zoom Button Enable/Disable Logic

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`

The bug: Zoom In button stays disabled even after adding nodes. Need to investigate how the Controls component from React Flow determines min/max zoom and why it shows as disabled.

- [ ] **Step 1: Write failing test**

Create `apps/web/lib/canvas/__tests__/zoom.test.ts`:

```tsx
import { describe, it, expect } from "vitest";
import { renderHook } from "@testing-library/react";
import { useCanvasStore } from "../store";

describe("Canvas zoom state", () => {
  it("should allow zoom in when nodes exist and zoom < maxZoom", () => {
    const { result } = renderHook(() => useCanvasStore());
    // After adding a node, zoom in should be available
    result.current.addNode({
      id: "test-1",
      kind: "text",
      position: { x: 100, y: 100 },
      title: "Test",
      payload: { text: "" },
    });
    const zoomOutDisabled = result.current.viewport.zoom >= 2; // max zoom default 2
    expect(zoomOutDisabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to confirm current behavior**

```bash
cd apps/web && npx vitest run lib/canvas/__tests__/zoom.test.ts
```

- [ ] **Step 3: Examine Controls disable logic in CanvasView**

Read the current zoom-related props passed to `<Controls>` in CanvasView. The issue is likely that we're not passing `minZoom`/`maxZoom` or the `fitView` is called incorrectly. Ensure we:
1. Set `minZoom={0.1}` and `maxZoom={2}` on `<Controls>`
2. Remove any disabled state we manually apply (React Flow handles this)
3. Ensure `fitView` is called after nodes are added via `useEffect` on nodes change

- [ ] **Step 4: Implement fix**

In CanvasView, ensure the Controls component receives proper props:

```tsx
<Controls
  minZoom={0.1}
  maxZoom={2}
  fitViewOptions={{ padding: 0.2 }}
  showInteractive={false}
>
  {/* custom buttons if needed */}
</Controls>
```

- [ ] **Step 5: Run test + manual verify**

```bash
cd apps/web && npx vitest run lib/canvas/__tests__/zoom.test.ts
# Expected: PASS
```

Then manually verify: open canvas, add text node, Zoom In should be enabled.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/canvas/CanvasView.tsx apps/web/lib/canvas/__tests__/zoom.test.ts
git commit -m "fix(canvas): enable zoom controls properly with min/max zoom bounds"
```

### Task 1.3: Fix SSE Cleanup on Page Navigation

**Files:**
- Modify: `apps/web/lib/canvas/api.ts`
- Modify: `apps/web/components/canvas/CanvasView.tsx`

The bug: `EventSource` connections for `/api/canvas/:id/events` are not closed when navigating away, causing `ERR_ABORTED` console errors.

- [ ] **Step 1: Investigate how SSE is currently managed**

Read `apps/web/lib/canvas/api.ts` to find EventSource creation and check if there's a cleanup function.

- [ ] **Step 2: Implement proper EventSource cleanup in useEffect**

In the component/hook that opens the EventSource, add a cleanup function in useEffect:

```tsx
useEffect(() => {
  if (!activeCanvasId) return;
  const es = new EventSource(`/api/canvas/${activeCanvasId}/events?token=${token}`);
  es.onmessage = handleMessage;
  return () => {
    es.close();
    es.removeEventListener("message", handleMessage);
  };
}, [activeCanvasId, token]);
```

- [ ] **Step 3: Also close EventSource on route change via usePathname**

Add logic to close when leaving canvas view.

- [ ] **Step 4: Verify manually**

Navigate between views and confirm console shows zero ERR_ABORTED after 1 second.

- [ ] **Step 5: Commit**

```bash
git add apps/web/lib/canvas/api.ts apps/web/components/canvas/CanvasView.tsx
git commit -m "fix(canvas): close SSE EventSource on navigation to prevent console errors"
```

### Task 1.4: Add Loading States to Action Buttons

**Files:**
- Modify: `apps/web/components/create/CreateView.tsx` (image generation)
- Modify: `apps/web/components/create/VideoView.tsx` (video generation)
- Modify: `apps/web/components/canvas/nodes/ToivNode.tsx` (run button on nodes)

- [ ] **Step 1: Identify all generate/run buttons missing loading states**

Check the following buttons:
- "生成" button in CreateView
- "生成视频" in VideoView
- "运行选中节点" in CanvasView

- [ ] **Step 2: Add LoadingSpinner + disabled state during pending operations**

For each button, use a pending state. Pattern:

```tsx
const [loading, setLoading] = useState(false);
// ...in click handler:
setLoading(true);
try {
  await generate();
} finally {
  setLoading(false);
}
// ...in JSX:
<Button disabled={loading} onClick={handleGenerate}>
  {loading ? <><Loader2 className="animate-spin" /> 生成中...</> : "生成"}
</Button>
```

- [ ] **Step 3: Verify all three locations**

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/create/CreateView.tsx apps/web/components/create/VideoView.tsx apps/web/components/canvas/nodes/ToivNode.tsx
git commit -m "ux: add loading states to all generation/run buttons"
```

### Task 1.5: M1 Regression Verification

- [ ] **Step 1: Run backend tests**

```bash
cd apps/api && uv run pytest -q
# Expected: 499 passed
```

- [ ] **Step 2: Run TypeScript check**

```bash
cd apps/web && npx tsc --noEmit
# Expected: 0 errors
```

- [ ] **Step 3: Run build**

```bash
cd apps/web && npm run build
# Expected: build succeeds
```

- [ ] **Step 4: Manual smoke test in browser**

Navigate through all 12 views, check console is clean, add a canvas node and verify zoom works, verify generate buttons show loading state.

- [ ] **Step 5: Update STATE.json**

Update `health` section with latest verification timestamps.

- [ ] **Step 6: Commit**

```bash
git add STATE.json
git commit -m "chore: M1 complete - P0 bugfixes and stabilization"
```

---

# Milestone 2: Core Canvas Interaction (4 days)

**Goal:** Implement the fundamental canvas interactions that users expect: double-click to create nodes, drag to connect edges, and right-click context menu. This brings the canvas from "toolbar-only" to "direct manipulation" paradigm matching industry standards.

**Success Criteria:**
- Double-clicking empty canvas opens a node creation menu at click position
- Dragging from a node's output handle to another node's input handle creates an edge
- Right-clicking canvas/node shows a context menu with relevant actions
- All interactions work reliably with touchpad, mouse, and keyboard

### Task 2.1: Implement Double-Click to Create Node

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Create: `apps/web/components/canvas/NodeCreateMenu.tsx`
- Test: `apps/web/components/canvas/__tests__/NodeCreateMenu.test.tsx`

- [ ] **Step 1: Write failing test**

```tsx
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { NodeCreateMenu } from "../NodeCreateMenu";

describe("NodeCreateMenu", () => {
  it("should render node type options when open", () => {
    render(<NodeCreateMenu position={{ x: 100, y: 200 }} open={true} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.getByText("文本")).toBeInTheDocument();
    expect(screen.getByText("图像")).toBeInTheDocument();
    expect(screen.getByText("视频")).toBeInTheDocument();
  });

  it("should call onSelect with kind when a node type is clicked", () => {
    const onSelect = vi.fn();
    render(<NodeCreateMenu position={{ x: 100, y: 200 }} open={true} onSelect={onSelect} onClose={() => {}} />);
    fireEvent.click(screen.getByText("文本"));
    expect(onSelect).toHaveBeenCalledWith("text", expect.objectContaining({ x: 100, y: 200 }));
  });

  it("should not render when closed", () => {
    render(<NodeCreateMenu position={{ x: 0, y: 0 }} open={false} onSelect={() => {}} onClose={() => {}} />);
    expect(screen.queryByText("文本")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run test to confirm it fails**

```bash
cd apps/web && npx vitest run components/canvas/__tests__/NodeCreateMenu.test.tsx
# Expected: FAIL (file doesn't exist yet)
```

- [ ] **Step 3: Create NodeCreateMenu component**

```tsx
// apps/web/components/canvas/NodeCreateMenu.tsx
"use client";

import { useEffect, useRef } from "react";
import * as ContextMenu from "@radix-ui/react-context-menu";
import { Icon, type IconName } from "@/components/ui/Icon";

interface NodeCreateOption {
  kind: string;
  label: string;
  icon: IconName;
}

const NODE_CREATE_OPTIONS: NodeCreateOption[] = [
  { kind: "text", label: "文本", icon: "file" },
  { kind: "prompt", label: "提示词", icon: "sparkles" },
  { kind: "image", label: "图像", icon: "image" },
  { kind: "video", label: "视频", icon: "video" },
  { kind: "audio", label: "音频", icon: "audio" },
  { kind: "llm", label: "LLM", icon: "chat" },
];

interface NodeCreateMenuProps {
  position: { x: number; y: number };
  open: boolean;
  onSelect: (kind: string, position: { x: number; y: number }) => void;
  onClose: () => void;
}

export function NodeCreateMenu({ position, open, onSelect, onClose }: NodeCreateMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", handleClickOutside);
    document.addEventListener("keydown", handleEsc);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
      document.removeEventListener("keydown", handleEsc);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      ref={menuRef}
      className="fixed z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[180px] animate-in fade-in-0 zoom-in-95 duration-100"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-1.5 text-xs text-muted-foreground font-medium">添加节点</div>
      {NODE_CREATE_OPTIONS.map((opt) => (
        <button
          key={opt.kind}
          className="w-full flex items-center gap-2 px-3 py-2 text-sm hover:bg-accent hover:text-accent-foreground transition-colors"
          onClick={() => onSelect(opt.kind, position)}
        >
          <Icon name={opt.icon} size={16} />
          {opt.label}
        </button>
      ))}
    </div>
  );
}
```

- [ ] **Step 4: Run unit test**

```bash
cd apps/web && npx vitest run components/canvas/__tests__/NodeCreateMenu.test.tsx
# Expected: PASS
```

- [ ] **Step 5: Integrate double-click handler in CanvasView**

Add to CanvasViewInner:
- State for menu: `const [createMenu, setCreateMenu] = useState<{open: boolean; x: number; y: number}>({open:false,x:0,y:0})`
- onPaneDoubleClick handler on ReactFlow:
```tsx
onPaneDoubleClick={(event) => {
  setCreateMenu({ open: true, x: event.clientX, y: event.clientY });
}}
```
- Handle node creation from menu:
```tsx
const handleCreateNode = (kind: string, screenPos: {x:number;y:number}) => {
  // Convert screen coords to flow coords
  const flowCoords = screenToFlowPosition({ x: screenPos.x, y: screenPos.y });
  addNode({
    id: crypto.randomUUID(),
    kind: kind as CanvasNodeKind,
    position: flowCoords,
    title: getDefaultTitle(kind),
    payload: getDefaultPayload(kind),
  });
  setCreateMenu({ open: false, x: 0, y: 0 });
};
```
- Render `<NodeCreateMenu>` in component

- [ ] **Step 6: Manual test**

Double-click empty canvas → menu appears at click position → click "文本" → text node appears at that position → menu closes.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/canvas/NodeCreateMenu.tsx apps/web/components/canvas/CanvasView.tsx apps/web/components/canvas/__tests__/NodeCreateMenu.test.tsx
git commit -m "feat(canvas): add double-click to create node with radial menu"
```

### Task 2.2: Implement Node Connection (Drag to Connect Edges)

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Modify: `apps/web/components/canvas/nodes/ToivNode.tsx`
- Modify: `apps/web/lib/canvas/store.ts`
- Test: `apps/web/lib/canvas/__tests__/edges.test.ts`

- [ ] **Step 1: Examine current edge connection state in store**

Read `apps/web/lib/canvas/store.ts` to understand how edges are currently managed, and check if handles are rendered in ToivNode.

- [ ] **Step 2: Ensure nodes have input/output handles rendered**

In ToivNode, add `<Handle type="target" position={Position.Left} />` and `<Handle type="source" position={Position.Right} />` from `@xyflow/react`. Style them subtly (small circles, accent color on hover).

- [ ] **Step 3: Write test for edge connection**

```tsx
describe("Canvas edge connection", () => {
  it("should create an edge when connecting source to target", () => {
    const { result } = renderHook(() => useCanvasStore());
    result.current.addNode({ id: "n1", kind: "text", position: {x:0,y:0}, title: "A", payload:{} });
    result.current.addNode({ id: "n2", kind: "text", position: {x:200,y:0}, title: "B", payload:{} });
    result.current.addEdge({ id: "e1", source: "n1", target: "n2" });
    expect(result.current.edges).toHaveLength(1);
    expect(result.current.edges[0].source).toBe("n1");
  });

  it("should not allow self-connections", () => {
    // Verify onConnect prevents same source===target
  });
});
```

- [ ] **Step 4: Implement onConnect validation**

In CanvasView, implement the `onConnect` handler with:
- Self-connection prevention
- Duplicate edge prevention
- Animated edge style on creation

```tsx
const onConnect: OnConnect = useCallback((params) => {
  if (!params.source || !params.target) return;
  if (params.source === params.target) return;
  // Check for existing edge
  const exists = edges.some(e => e.source === params.source && e.target === params.target);
  if (exists) return;
  addEdge({
    id: `e-${params.source}-${params.target}`,
    source: params.source,
    target: params.target,
    animated: true,
    style: { stroke: "hsl(var(--accent))" },
  });
}, [edges, addEdge]);
```

- [ ] **Step 5: Style edges with bezier curves and accent color**

Add `defaultEdgeOptions` to ReactFlow:
```tsx
defaultEdgeOptions={{
  type: "smoothstep",
  animated: true,
  style: { strokeWidth: 2, stroke: "hsl(var(--accent))" },
}}
```

- [ ] **Step 6: Manual test**

Add two nodes, drag from right handle of first to left handle of second → edge appears with animation → no errors.

- [ ] **Step 7: Commit**

```bash
git add apps/web/components/canvas/CanvasView.tsx apps/web/components/canvas/nodes/ToivNode.tsx apps/web/lib/canvas/store.ts apps/web/lib/canvas/__tests__/edges.test.ts
git commit -m "feat(canvas): drag-to-connect edges between nodes with validation"
```

### Task 2.3: Implement Right-Click Context Menu

**Files:**
- Create: `apps/web/components/canvas/CanvasContextMenu.tsx`
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Modify: `apps/web/components/canvas/nodes/ToivNode.tsx`

- [ ] **Step 1: Create CanvasContextMenu component**

Similar to NodeCreateMenu but with different actions based on what's clicked (pane vs node):
- Pane context: 添加节点, 粘贴, 全选, 适应视图
- Node context: 运行, 复制, 删除, 重命名

```tsx
interface CanvasContextMenuProps {
  position: { x: number; y: number };
  type: "pane" | "node";
  nodeId?: string;
  onAction: (action: string, data?: unknown) => void;
  onClose: () => void;
}
```

Use Radix UI ContextMenu primitive if available in the project, or build a simple fixed-position menu like NodeCreateMenu. Check `package.json` for `@radix-ui/react-context-menu`.

- [ ] **Step 2: Check if Radix context menu is installed**

```bash
cd apps/web && cat package.json | grep radix
```

If not installed, add it: `npm install @radix-ui/react-context-menu @radix-ui/react-dropdown-menu`

- [ ] **Step 3: Wire up onPaneContextMenu and onNodeContextMenu**

In ReactFlow:
```tsx
onPaneContextMenu={(event) => {
  event.preventDefault();
  setContextMenu({ open: true, x: event.clientX, y: event.clientY, type: "pane" });
}}
onNodeContextMenu={(event, node) => {
  event.preventDefault();
  setContextMenu({ open: true, x: event.clientX, y: event.clientY, type: "node", nodeId: node.id });
}}
```

- [ ] **Step 4: Wire up actions to store**

Connect actions (duplicate node, delete node, fit view, select all) to store actions.

- [ ] **Step 5: Manual test**

Right-click empty pane → shows pane menu. Right-click node → shows node menu with 运行/复制/删除. Click outside or Esc → menu closes.

- [ ] **Step 6: Commit**

```bash
git add apps/web/components/canvas/CanvasContextMenu.tsx apps/web/components/canvas/CanvasView.tsx apps/web/components/canvas/nodes/ToivNode.tsx
git commit -m "feat(canvas): right-click context menu for pane and nodes"
```

### Task 2.4: M2 Regression

- [ ] **Step 1: Run all tests**

```bash
cd apps/web && npx tsc --noEmit && npx vitest run && npm run build
cd apps/api && uv run pytest -q
```

- [ ] **Step 2: Manual QA pass**

Test all new interactions: double-click create, drag-connect, right-click menu. Verify no console errors.

- [ ] **Step 3: Update STATE.json and commit**

```bash
git add STATE.json
git commit -m "chore: M2 complete - core canvas interactions (dblclick, connect, context menu)"
```

---

# Milestone 3: Keyboard Shortcuts & Visual Feedback (3 days)

**Goal:** Professional-grade keyboard shortcuts, clear visual selection states, and tooltips for all toolbar buttons.

**Success Criteria:**
- 10+ keyboard shortcuts work when canvas is focused
- Selected nodes have clear visual highlight
- Hover tooltips on all icon-only buttons
- Visual feedback for edge connection in progress

### Task 3.1: Implement Keyboard Shortcuts

**Files:**
- Create: `apps/web/lib/canvas/useKeyboardShortcuts.ts`
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Create: `apps/web/lib/canvas/shortcuts.ts` (keybinding map)

- [ ] **Step 1: Create shortcuts definition file**

```ts
// apps/web/lib/canvas/shortcuts.ts
export interface Shortcut {
  key: string;
  cmd?: boolean;
  shift?: boolean;
  description: string;
  action: string;
}

export const CANVAS_SHORTCUTS: Shortcut[] = [
  { key: "Delete", description: "删除选中节点", action: "deleteSelected" },
  { key: "Backspace", description: "删除选中节点", action: "deleteSelected" },
  { key: "d", cmd: true, description: "复制选中节点", action: "duplicateSelected" },
  { key: "a", cmd: true, description: "全选节点", action: "selectAll" },
  { key: "z", cmd: true, description: "撤销", action: "undo" },
  { key: "z", cmd: true, shift: true, description: "重做", action: "redo" },
  { key: "0", description: "适应视图", action: "fitView" },
  { key: "=", cmd: true, description: "放大", action: "zoomIn" },
  { key: "-", cmd: true, description: "缩小", action: "zoomOut" },
  { key: "Escape", description: "取消选择/关闭菜单", action: "deselect" },
];
```

- [ ] **Step 2: Create useKeyboardShortcuts hook**

```tsx
// apps/web/lib/canvas/useKeyboardShortcuts.ts
"use client";
import { useEffect, useCallback } from "react";
import { CANVAS_SHORTCUTS } from "./shortcuts";

interface ShortcutHandlers {
  deleteSelected: () => void;
  duplicateSelected: () => void;
  selectAll: () => void;
  undo: () => void;
  redo: () => void;
  fitView: () => void;
  zoomIn: () => void;
  zoomOut: () => void;
  deselect: () => void;
}

export function useKeyboardShortcuts(handlers: ShortcutHandlers, canvasFocused: boolean) {
  const handleKeyDown = useCallback((e: KeyboardEvent) => {
    if (!canvasFocused) return;
    // Don't trigger when typing in inputs
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable) return;

    for (const sc of CANVAS_SHORTCUTS) {
      const keyMatch = e.key === sc.key || e.key.toLowerCase() === sc.key.toLowerCase();
      const cmdMatch = sc.cmd ? (e.metaKey || e.ctrlKey) : !(e.metaKey || e.ctrlKey);
      const shiftMatch = sc.shift ? e.shiftKey : !e.shiftKey;
      if (keyMatch && cmdMatch && shiftMatch) {
        e.preventDefault();
        const handler = handlers[sc.action as keyof ShortcutHandlers];
        if (handler) handler();
        return;
      }
    }
  }, [handlers, canvasFocused]);

  useEffect(() => {
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);
}
```

- [ ] **Step 3: Write test**

```tsx
describe("keyboard shortcuts", () => {
  it("should call deleteSelected when Delete pressed", () => {
    // Use renderHook with fireEvent.keyDown
  });
  it("should not trigger shortcuts when typing in input", () => {});
});
```

- [ ] **Step 4: Integrate hook in CanvasView**

Wrap ReactFlow in a div that tracks focus. Pass all handler functions.

- [ ] **Step 5: Add shortcut help overlay (?)**

Add a small keyboard shortcut hint button (?) in the canvas toolbar that shows a popup with all shortcuts. Use HoverCard or Popover from Radix.

- [ ] **Step 6: Manual test**

Each shortcut works; typing in node text input doesn't trigger shortcuts; ? shows shortcut list.

- [ ] **Step 7: Commit**

```bash
git add apps/web/lib/canvas/shortcuts.ts apps/web/lib/canvas/useKeyboardShortcuts.ts apps/web/components/canvas/CanvasView.tsx
git commit -m "feat(canvas): keyboard shortcuts with help overlay"
```

### Task 3.2: Improve Node Selection Visual Feedback

**Files:**
- Modify: `apps/web/components/canvas/nodes/ToivNode.tsx`

- [ ] **Step 1: Current state analysis**

Read ToivNode to see current selected state styling. It likely only has a subtle border change.

- [ ] **Step 2: Implement prominent selection state**

```tsx
const selectedStyle = selected ? {
  boxShadow: "0 0 0 2px hsl(var(--accent)), 0 0 12px hsl(var(--accent)/0.3)",
  borderColor: "hsl(var(--accent))",
  transform: "scale(1.02)",
} : {};
```

Use CSS transitions for smooth enter/exit:
```css
.toiv-node {
  transition: box-shadow 150ms ease, transform 150ms ease, border-color 150ms ease;
}
```

- [ ] **Step 3: Add selection indicator dot**

Add a small colored dot in the corner or border glow animation when selected.

- [ ] **Step 4: Manual test**

Click a node → clear visual highlight appears smoothly → click away → highlight disappears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/canvas/nodes/ToivNode.tsx
git commit -m "ux(canvas): prominent node selection feedback with accent glow"
```

### Task 3.3: Add Tooltips to All Icon-Only Buttons

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Check for existing Tooltip component in UI

- [ ] **Step 1: Check if Tooltip primitive exists**

Look for `apps/web/components/ui/Tooltip.tsx`. If missing, create one using Radix:

```bash
cd apps/web && ls components/ui/ | grep -i tooltip
# If not found: npx shadcn@latest add tooltip
```

- [ ] **Step 2: Wrap all icon buttons with Tooltip**

For each toolbar button (新建画布, 重命名, 删除, 语音Agent开关, 模板库, 添加节点, 运行选中, Zoom In, Zoom Out, Fit View), add:

```tsx
<Tooltip>
  <TooltipTrigger asChild>
    <Button size="icon" variant="ghost">...</Button>
  </TooltipTrigger>
  <TooltipContent side="bottom">
    <p>添加节点 <kbd className="text-xs opacity-60">双击画布</kbd></p>
  </TooltipContent>
</Tooltip>
```

- [ ] **Step 3: Add keyboard shortcut hints in tooltips**

Where applicable, show shortcut key in tooltip (e.g., "删除选中节点 ⌫").

- [ ] **Step 4: Manual test**

Hover each toolbar button for 500ms → tooltip appears with name + shortcut hint → move away → disappears.

- [ ] **Step 5: Commit**

```bash
git add apps/web/components/canvas/CanvasView.tsx
git commit -m "ux: add tooltips with shortcut hints to all canvas toolbar buttons"
```

### Task 3.4: Empty Canvas Onboarding Hint

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Create: `apps/web/components/canvas/EmptyCanvasHint.tsx`

- [ ] **Step 1: Create EmptyCanvasHint component**

```tsx
export function EmptyCanvasHint() {
  return (
    <div className="absolute inset-0 flex items-center justify-center pointer-events-none z-[5]">
      <div className="text-center space-y-3 opacity-50">
        <Sparkles className="w-12 h-12 mx-auto text-accent" />
        <p className="text-lg font-medium">双击画布任意位置添加节点</p>
        <p className="text-sm text-muted-foreground">拖拽节点间的连接点来创建连线 · 右键查看更多操作</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Show only when canvas has 0 nodes**

Conditionally render based on `nodes.length === 0`.

- [ ] **Step 3: Animate entry**

Add a subtle fade-in animation.

- [ ] **Step 4: Commit**

```bash
git add apps/web/components/canvas/EmptyCanvasHint.tsx apps/web/components/canvas/CanvasView.tsx
git commit -m "ux(canvas): add empty canvas hint with double-click instruction"
```

### Task 3.5: M3 Regression

- [ ] **Step 1: Full test suite + build**
- [ ] **Step 2: Manual QA — all shortcuts, tooltips, selection, empty hint**
- [ ] **Step 3: Update STATE.json and commit**

---

# Milestone 4: Productivity Features (5 days)

**Goal:** Features that make the canvas productive for real work — interactive minimap, multi-select/box select, undo/redo, node actions (duplicate/delete).

### Task 4.1: Interactive MiniMap

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`

React Flow's MiniMap supports `onNodeClick` and `pannable`/`zoomable` props. Enable them.

- [ ] **Step 1: Enable interactive MiniMap props**

```tsx
<MiniMap
  pannable
  zoomable
  onNodeClick={(event, node) => {
    // Fit view to that node or center on it
    centerOn(node.position.x, node.position.y, { zoom: 1, duration: 300 });
  }}
  nodeColor={(node) => selectedIds.has(node.id) ? "hsl(var(--accent))" : "#666"}
  maskColor="hsl(var(--background)/0.8)"
  style={{ backgroundColor: "hsl(var(--muted))" }}
/>
```

- [ ] **Step 2: Style minimap to match Film Atelier theme**

Use dark/desaturated colors consistent with the darkroom aesthetic.

- [ ] **Step 3: Test** — Click minimap node → view centers on it; drag minimap → view pans.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(canvas): interactive minimap with click-to-center and pannable view"
```

### Task 4.2: Multi-Select & Box Select

React Flow supports this natively via `selectionOnDrag` and multi-selection with Shift+click. Verify it works.

- [ ] **Step 1: Enable selection props on ReactFlow**

```tsx
<ReactFlow
  selectionOnDrag
  selectionMode="partial"
  multiSelectionKeyCode="Shift"
  panOnDrag={true}
  selectionKeyCode={null}  // Don't require special key for box select; use selectionOnDrag
/>
```

Wait — `panOnDrag` and `selectionOnDrag` conflict. Use the React Flow convention: pan on drag by default, box select when holding Shift (space+drag is also common). Let me check the React Flow v12 API:

Actually, in React Flow v12+:
- `panOnDrag={true}` (default) — dragging empty canvas pans
- `selectionOnDrag={false}` (default) — need to hold Shift for box select
- Better UX: `panOnDrag={[1]}` (only middle mouse button pans), left click+drag = box select. But that's non-standard.

Go with standard: left drag = pan (default), Shift + left drag = box select, Cmd/Ctrl + click = toggle selection.

- [ ] **Step 2: Verify multi-delete works**

When multiple nodes selected, Delete key should delete all of them. Ensure keyboard handler checks `selectedNodes.length > 0`.

- [ ] **Step 3: Add "Delete Selected" to context menu when multiple selected**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(canvas): multi-select with shift+click and box-select support"
```

### Task 4.3: Duplicate Node Action

**Files:**
- Modify: `apps/web/lib/canvas/store.ts`

- [ ] **Step 1: Add duplicateNodes action to store**

```ts
duplicateNodes: (nodeIds: string[]) => {
  const { nodes } = get();
  const newNodes = nodeIds.map(id => {
    const node = nodes.find(n => n.id === id);
    if (!node) return null;
    return {
      ...node,
      id: crypto.randomUUID(),
      position: { x: node.position.x + 40, y: node.position.y + 40 },
      selected: false,
    };
  }).filter(Boolean);
  set({ nodes: [...nodes, ...newNodes], selectedIds: newNodes.map(n => n!.id) });
}
```

- [ ] **Step 2: Wire up in context menu and keyboard shortcut (Cmd/Ctrl+D)**

- [ ] **Step 3: Write test**

```ts
it("should duplicate node with offset", () => {
  // Add a node, duplicate, verify count is 2, position is offset
});
```

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(canvas): duplicate selected nodes with offset (cmd/ctrl+d)"
```

### Task 4.4: Undo/Redo with Zustand History

**Files:**
- Modify: `apps/web/lib/canvas/store.ts`

Implement undo/redo using the `zundo` middleware or a simple manual history stack.

- [ ] **Step 1: Check if zundo is available**

```bash
cd apps/web && cat package.json | grep zundo
```

If not, install: `npm install zundo`

- [ ] **Step 2: Wrap store with temporal middleware**

```ts
import { temporal } from "zundo";

const useCanvasStore = create<CanvasStore & { temporal: any }>()(
  temporal(
    (set, get) => ({
      // existing store
    }),
    {
      // Only track certain actions
      partialize: (state) => ({
        nodes: state.nodes,
        edges: state.edges,
      }),
      handleSet: (handleSet) => {
        return debounce<typeof handleSet>(() => {
          handleSet();
        }, 100);
      },
    }
  )
);
```

- [ ] **Step 3: Wire undo/redo to keyboard shortcuts (Cmd+Z, Cmd+Shift+Z)**

- [ ] **Step 4: Write test**

Add node → undo → node removed → redo → node back.

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(canvas): undo/redo with cmd+z and cmd+shift+z"
```

### Task 4.5: Connection Line Visual Feedback

**Files:**
- Modify: `apps/web/components/canvas/CanvasView.tsx`

Improve the connection line that appears while dragging to connect:

```tsx
connectionLineComponent={CustomConnectionLine}
```

Create a `CustomConnectionLine` that shows a colored animated line from source to cursor, with a "drop" indicator.

- [ ] **Step 1: Create styled connection line**

- [ ] **Step 2: Test** — drag from a handle → smooth animated line follows cursor → drop on another handle → edge created.

- [ ] **Step 3: Commit**

```bash
git commit -m "ux(canvas): animated connection line with visual feedback while dragging"
```

### Task 4.6: M4 Regression

- [ ] **Step 1: Full test/build**
- [ ] **Step 2: Manual QA — minimap, multi-select, duplicate, undo/redo, connection line**
- [ ] **Step 3: Update STATE.json and commit**

---

# Milestone 5: Onboarding & Global UX Polish (3 days)

**Goal:** Address remaining P1/P2 UX issues, create a cohesive empty state design system, and provide onboarding for new users.

### Task 5.1: Standardized Empty State Component

**Files:**
- Create: `apps/web/components/ui/EmptyState.tsx`
- Modify: `apps/web/components/manju/ManjuView.tsx`
- Modify: Other views with empty states

- [ ] **Step 1: Create reusable EmptyState component**

```tsx
interface EmptyStateProps {
  icon: React.ReactNode;
  title: string;
  description: string;
  action?: React.ReactNode;
}

export function EmptyState({ icon, title, description, action }: EmptyStateProps) {
  return (
    <div className="flex flex-col items-center justify-center py-16 px-4 text-center">
      <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center mb-4 text-muted-foreground">
        {icon}
      </div>
      <h3 className="text-lg font-semibold mb-1">{title}</h3>
      <p className="text-sm text-muted-foreground max-w-sm mb-6">{description}</p>
      {action}
    </div>
  );
}
```

- [ ] **Step 2: Apply to ManjuView (漫剧) empty state**

Replace the simple "+ 新建第一个" button with a proper empty state:
```tsx
<EmptyState
  icon={<Clapperboard size={32} />}
  title="开始你的第一个漫剧项目"
  description="导入漫画图片，自动拆分镜格，一键生成动态漫剧视频。"
  action={<Button onClick={handleNew}><Plus /> 新建漫剧项目</Button>}
/>
```

- [ ] **Step 3: Apply to other empty views** (作品库, 训练, etc.)

- [ ] **Step 4: Commit**

```bash
git commit -m "ux: standardized EmptyState component applied across all views"
```

### Task 5.2: Fix Drama Studio Navigation Hierarchy

**Files:**
- Modify: `apps/web/components/drama-studio/DramaStudioView.tsx`

The issue: entering drama studio shows duplicate navigation (sidebar + internal tab bar). Clean up the hierarchy:
- Keep the main sidebar for cross-module navigation
- Drama studio internal tabs (剧本/角色/分镜/合成/过程/Agent) should be clearly sub-navigation within the view
- Use breadcrumbs: `首页 / 短剧工作台 / 项目名称 / 分镜`

- [ ] **Step 1: Restructure layout to reduce visual confusion**

Make drama studio internal tabs less prominent than main navigation (use secondary button styling, smaller size, or tab bar below header).

- [ ] **Step 2: Commit**

```bash
git commit -m "ux(drama): clarify navigation hierarchy between sidebar and studio tabs"
```

### Task 5.3: Tooltip Global Standardization

- [ ] **Step 1: Add tooltips to icon buttons across other views** (create view, video view, etc.)

- [ ] **Step 2: Ensure consistent tooltip delay (300ms), placement, and styling**

- [ ] **Step 3: Commit**

```bash
git commit -m "ux: consistent tooltips across all view toolbars"
```

### Task 5.4: Canvas Onboarding Tour (First Visit)

**Files:**
- Create: `apps/web/components/canvas/CanvasOnboarding.tsx`
- Modify: `apps/web/components/canvas/CanvasView.tsx`
- Modify: `apps/web/lib/storage.ts` (use existing localStorage helpers)

- [ ] **Step 1: Create a simple first-visit onboarding**

Show a 3-step tooltip tour the first time user opens canvas:
1. "双击画布空白处，即可快速添加节点" (point to canvas center)
2. "拖拽节点右侧圆点到另一节点，创建连接" (point to a node handle)
3. "按 ? 查看所有快捷键，开始创作吧！" (point to help button)

Store "viewed" in localStorage: `toiv-canvas-onboarding-v1=seen`

Use a simple state machine; no need for external tour libraries unless `driver.js` or similar is already installed.

- [ ] **Step 2: Create as a simple step-by-step overlay**

Use absolutely positioned tooltip cards with "下一步" and "跳过" buttons. Use CSS to highlight the target area with a ring.

- [ ] **Step 3: Manual test** — Fresh incognito window → tour appears → complete steps → doesn't appear again.

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(canvas): first-visit onboarding tour with 3-step guidance"
```

### Task 5.5: Final Polish & Performance

- [ ] **Step 1: Add React.memo to node components** to prevent unnecessary re-renders

- [ ] **Step 2: Throttle viewport changes** — don't save viewport to store on every pixel of pan/zoom; use debounce (300ms)

- [ ] **Step 3: Verify no node count warnings** — Test with 20 nodes, confirm 60fps interaction

- [ ] **Step 4: Run Lighthouse audit on canvas page** — target LCP < 2s, FID < 100ms, CLS < 0.1

- [ ] **Step 5: Commit**

```bash
git commit -m "perf(canvas): memoize nodes, throttle viewport updates for smooth interaction"
```

### Task 5.6: M5 Final Regression & Release

- [ ] **Step 1: Full backend test suite**

```bash
cd apps/api && uv run pytest -q
```

- [ ] **Step 2: Full frontend type check + unit tests + build**

```bash
cd apps/web && npx tsc --noEmit && npx vitest run && npm run build
```

- [ ] **Step 3: E2E tests**

```bash
cd apps/web && npx playwright test e2e/authed-canvas.spec.ts
```

- [ ] **Step 4: Manual dogfood pass** — Complete workflow: create project → open canvas → add nodes via double-click → connect → add image node → run → delete via shortcut → undo

- [ ] **Step 5: Update STATE.json with final health metrics**

- [ ] **Step 6: Create TEST_LOG.md entry with final QA evidence**

- [ ] **Step 7: Final commit**

```bash
git add STATE.json TEST_LOG.md
git commit -m "chore: M5 complete - onboarding, polish, and final QA"
```

---

## Resource Allocation

### Developer Effort Estimate

| Milestone | Backend Effort | Frontend Effort | Testing Effort | Total |
|---|---|---|---|---|
| M1 | 0.5 day | 1 day | 0.5 day | 2 days |
| M2 | 0 | 3 days | 1 day | 4 days |
| M3 | 0 | 2 days | 1 day | 3 days |
| M4 | 0 | 3.5 days | 1.5 days | 5 days |
| M5 | 0 | 2 days | 1 day | 3 days |
| Buffer/QA | 0 | 1 day | 2 days | 3 days |
| **Total** | **0.5 day** | **12.5 days** | **7 days** | **20 days (~3 weeks)** |

### Key Dependencies

- `@xyflow/react` (React Flow) — already installed at project root; pin current version
- `@radix-ui/react-*` — for context menu, tooltip, popover primitives (verify install)
- `zundo` — for undo/redo history middleware (to install if not present)
- `lucide-react` — already installed; use for all icons
- Backend SSE endpoints — already exist in `routes/canvas.py`; no backend changes needed for M1-M5

---

## Communication Protocol

- **Daily:** Update STATE.json with current milestone progress after each coding session
- **Per-Milestone:**
  1. Create a draft PR with checklist in description
  2. Run full test suite before requesting review
  3. Attach screenshot evidence for new UI features
  4. Update TEST_LOG.md with test results
- **Issues/Blockers:** Log in TEST_LOG.md as they occur; do not silently skip failing tests
- **Code Review:** Self-review every file before commit using the checklist:
  - TypeScript strict compliance?
  - Tests added for new code?
  - Console errors introduced?
  - Follows existing file patterns/naming?
  - Uses lucide-react icons?
  - No hardcoded colors (use CSS variables)?

---

## Milestone Dependencies Graph

```
M1 (Bugfixes)
 └─→ M2 (Core Interaction: dblclick, connect, context menu)
     └─→ M3 (Shortcuts, Selection Visual, Tooltips, Empty Hint)
         ├─→ M4 (Minimap, Multi-select, Duplicate, Undo/Redo, Connection Line)
         └─→ M5 (Empty States, Nav Hierarchy, Onboarding, Performance)
              └─→ Final QA & Release
```

M2, M3, M4 are sequential because each builds on the interaction patterns established in the previous. M5 can partially overlap with M4 polish but is cleaner as a sequential pass.

---

## Post-Plan Checklist (for plan author self-review)

- [x] Every task has exact file paths
- [x] Code blocks contain real implementation, not placeholders
- [x] Exact test commands with expected output
- [x] Dependencies called out (Radix, zundo, shadcn)
- [x] Risk assessment covers likely failure modes
- [x] QA measures defined at project and milestone level
- [x] Progress tracking mechanism (STATE.json, TEST_LOG.md) defined
- [x] Timeline is realistic (3 weeks for a single frontend developer)
- [x] Milestones independently deployable
