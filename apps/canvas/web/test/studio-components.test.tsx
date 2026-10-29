import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StudioShell } from "../src/studio/shell/StudioShell";
import { FaceSwitcher } from "../src/studio/ui/FaceSwitcher";
import { SlidingTabs } from "../src/studio/ui/SlidingTabs";
import { StatusDot, STATUS_LABEL } from "../src/studio/ui/StatusDot";
import { useStudioToast } from "../src/studio/ui/toast-store";
import { studioFaceEnabled } from "../src/studio/flags";
import { Button } from "../src/studio/ui/Button";
import { Field } from "../src/studio/ui/Field";
import { TakeStrip } from "../src/studio/ui/TakeStrip";
import { MediaTile } from "../src/studio/ui/MediaTile";
import { ViewGroup } from "../src/studio/ui/ViewGroup";

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

describe("MediaTile", () => {
    const html = renderToStaticMarkup(<MediaTile label="主视" status="done" badge="SEED 88213" locked selected
        onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("exposes select semantics and actions", () => {
        expect(html).toContain('aria-pressed="true"');
        expect(html).toContain("预览");
        expect(html).toContain("替换");
        expect(html).toContain("下载");
    });
    test("shows lock marker when locked", () => {
        expect(html).toContain('class="lock"');
    });
    test("omits empty badge", () => {
        const bare = renderToStaticMarkup(<MediaTile label="右立面" status="wait" />);
        expect(bare).not.toContain('class="badge"');
    });
});

describe("ViewGroup", () => {
    const views = [
        { id: "v1", label: "主视", status: "done" as const, badge: "SEED 1", locked: true },
        { id: "v2", label: "反打", status: "run" as const, progress: 48 },
    ];
    const html = renderToStaticMarkup(<ViewGroup scene={{ id: "s1", name: "中军主帅营帐", slug: "INT / 日" }} views={views}
        selectedViewId="v1" onViewSelect={() => {}} onPreview={() => {}} onReplace={() => {}} onDownload={() => {}} />);
    test("derives running header status", () => {
        expect(html).toContain("stv-status-run");
        expect(html).toContain("渲染中 48%");
    });
    test("renders slug and name", () => {
        expect(html).toContain("INT / 日");
        expect(html).toContain("中军主帅营帐");
    });
});
