/**
 * W7.1：高级/专家面自由画布单入口 + 库页新建 CTA + 侧栏 pill 裁切。
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf-8");

describe("W7.1 advanced free-canvas nav + pill clip", () => {
    test("侧栏高级只留自由画布库；无新建自由画布", () => {
        const nav = read("src/components/layout/workspace-sidebar-nav.tsx");
        expect(nav).toContain('heading: "高级 / 专家面"');
        expect(nav).toContain('title: "自由画布库"');
        expect(nav).toContain('"/project"');
        expect(nav).not.toContain('title: "新建自由画布"');
        expect(nav).not.toContain("canvas:new");
        expect(nav).not.toContain('"/canvas?mode=new"');
        const primary = nav.slice(nav.indexOf("const groups"), nav.indexOf("高级 / 专家面"));
        for (const title of ["创作", "短剧项目", "任务中心", "工具台", "设置"]) {
            expect(primary).toContain(`title: "${title}"`);
        }
        expect(primary).not.toContain('"/project"');
        expect(primary).not.toContain('"/canvas');
    });

    test("库页头有新建自由画布主按钮；空态 CTA 仍在", () => {
        const page = read("src/pages/canvas/index.tsx");
        expect(page).toContain("自由画布库");
        expect(page).toContain('Button type="primary" icon={<Plus />} disabled={!hydrated} onClick={createAndEnter}>新建自由画布</Button>');
        expect(page).toMatch(/WorkspaceState[\s\S]*新建自由画布/);
        expect(page).toContain("libtv-create-project-card");
    });

    test("侧栏 active pill overflow 裁切对齐圆角", () => {
        const css = read("src/styles/workspace-product.css");
        expect(css).toContain(".app-workspace-nav-active-pill");
        const linkBlock = css.slice(css.indexOf(".app-user-workspace .app-workspace-nav-link {"), css.indexOf(".app-user-workspace .app-workspace-nav-active-pill {"));
        expect(linkBlock).toContain("overflow: hidden");
        expect(linkBlock).toContain("border-radius: var(--r-md)");
        const pillBlock = css.slice(css.indexOf(".app-user-workspace .app-workspace-nav-active-pill {"), css.indexOf(".app-user-workspace .app-workspace-nav-link > :not(.app-workspace-nav-active-pill)"));
        expect(pillBlock).toContain("border-radius: var(--r-md)");
        expect(pillBlock).toContain("overflow: hidden");
    });
});
