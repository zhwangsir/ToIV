import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../src/components/canvas/canvas-workspace-overlays.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");

test("connection menu reuses the compact create menu with the supported node set", () => {
    expect(component).toContain('<CanvasCreateMenu commands={commands} layout="list"');
    expect(component).toContain('title="引用该节点生成"');
    const commands = component.match(/command\("[^"]+"/g) || [];
    const ids = commands.map((c) => c.slice('command("'.length, -1));
    for (const id of ["text", "image", "video", "audio", "smart-edit", "director", "script"]) {
        expect(ids).toContain(id);
    }
    // 新增节点类型必须显式登记进 KNOWN,否则视为无意识漂移(不硬编码总数,总数增长本身不是缺陷)
    const KNOWN = [
        "text", "image", "video", "audio", "smart-edit", "director", "script",
        "tpl-t2i", "tpl-inpaint", "tpl-lipsync", "tpl-dub",
    ];
    expect(ids.filter((id) => !KNOWN.includes(id))).toEqual([]);
});

test("add-node submenu exposes the LibTV-style compact list layout", () => {
    const menu = readFileSync(new URL("../src/components/canvas/canvas-create-menu.tsx", import.meta.url), "utf8");
    const context = readFileSync(new URL("../src/components/canvas/canvas-context-menu.tsx", import.meta.url), "utf8");
    const styles = readFileSync(new URL("../src/styles/globals.css", import.meta.url), "utf8");
    expect(menu).toContain('variant === "node" ? "grid-cols-4"');
    expect(menu).toContain("size-6 shrink-0");
    expect(context).toContain('w-[232px]');
    expect(context).toContain('layout="list"');
    expect(styles).toContain("--canvas-create-node-height: var(--space-16)");
});

test("connection menu keeps keyboard dismissal and delegates disabled states", () => {
    expect(component).toContain('event.key === "Escape"');
    expect(component).toContain("getDisabledReason(CanvasNodeType.Text)");
    expect(component).toContain('command("smart-edit"');
    expect(component).toContain('"node", "暂不可用"');
    expect(component).toContain('event.key === "Escape"');
});
