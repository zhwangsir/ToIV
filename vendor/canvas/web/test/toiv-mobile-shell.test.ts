/** ToIV 移动壳契约:窄屏 CSS + 市场/任务挂载类(非整页 RTL)。 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../src");

describe("toiv-mobile shell contracts", () => {
    const css = readFileSync(join(root, "styles/toiv-mobile.css"), "utf8");
    const app = readFileSync(join(root, "application.tsx"), "utf8");
    const market = readFileSync(join(root, "pages/toiv/market-page.tsx"), "utf8");
    const tasks = readFileSync(join(root, "pages/toiv/tasks-page.tsx"), "utf8");

    test("application imports toiv-mobile.css", () => {
        expect(app).toContain('import "./styles/toiv-mobile.css"');
    });

    test("toiv-mobile.css covers phone width and product shell", () => {
        expect(css).toContain("@media (max-width: 640px)");
        expect(css).toContain(".toiv-market-page");
        expect(css).toContain(".toiv-tasks-page");
        expect(css).toContain(".toiv-app-drawer");
        expect(css).toContain("safe-area-inset-bottom");
        expect(css).toContain("min-height: 44px");
    });

    test("market page mounts mobile hooks", () => {
        expect(market).toContain("toiv-market-page");
        expect(market).toContain("toiv-market-filters");
        expect(market).toContain("toiv-market-search");
        expect(market).toContain("toiv-market-grid");
        expect(market).toContain('rootClassName="toiv-app-drawer"');
    });

    test("tasks page mounts toiv-tasks-page", () => {
        expect(tasks).toContain("toiv-tasks-page");
    });

    test("index.html has mobile viewport meta", () => {
        const html = readFileSync(join(import.meta.dir, "../index.html"), "utf8");
        expect(html).toMatch(/name="viewport"/);
        expect(html).toContain("width=device-width");
        expect(html).toContain("viewport-fit=cover");
    });
});
