import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioShell } from "../src/studio/shell/StudioShell";
import { FaceSwitcher } from "../src/studio/ui/FaceSwitcher";
import { SlidingTabs } from "../src/studio/ui/SlidingTabs";
import { StatusDot, STATUS_LABEL } from "../src/studio/ui/StatusDot";
import { useStudioToast } from "../src/studio/ui/toast-store";
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

describe("FaceSwitcher", () => {
    test("renders three faces", () => {
        const html = renderToStaticMarkup(<FaceSwitcher value="canvas" onChange={() => {}} />);
        expect(html).toContain("流水线");
        expect(html).toContain("画布");
        expect(html).toContain("剪辑湾");
        expect(html).toMatch(/aria-pressed="true"[^>]*>画布/);
    });
});

describe("flags", () => {
    test("defaults to new implementation", () => {
        expect(studioFaceEnabled("pipeline")).toBe(true);
        expect(studioFaceEnabled("canvas")).toBe(true);
        expect(studioFaceEnabled("edit")).toBe(true);
    });
});

describe("SlidingTabs", () => {
    const items = [
        { key: "s1", label: "项目配置", done: true },
        { key: "s2", label: "剧本创作", done: true },
        { key: "s3", label: "素材准备" },
    ];
    const html = renderToStaticMarkup(<SlidingTabs items={items} value="s3" onChange={() => {}} />);
    test("renders tablist with selected state", () => {
        expect(html).toContain('role="tablist"');
        expect(html).toMatch(/aria-selected="true"[^>]*><span class="tick">✓<\/span>素材准备|aria-selected="true"[^>]*>素材准备/s);
    });
    test("marks done stages with tick", () => {
        expect(html).toContain('class="tick"');
    });
    test("renders slider element", () => {
        expect(html).toContain("stv-tabs-slider");
    });
});

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
        useStudioToast.setState({ toasts: [] });
        const { push } = useStudioToast.getState();
        ["a", "b", "c", "d"].forEach((text) => push(text));
        expect(useStudioToast.getState().toasts.map((t) => t.text)).toEqual(["b", "c", "d"]);
    });
});
