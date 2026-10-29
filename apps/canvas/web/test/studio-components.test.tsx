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
