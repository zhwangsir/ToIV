import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const paths = [
    "../src/styles/toiv-freezone-tokens.css",
    "../src/styles/globals.css",
    "../src/styles/toiv-local-overrides.css",
    "../src/styles/workspace-product.css",
    "../src/styles/toiv-freezone-desk.css",
    "../src/components/create/creation-studio-three-pane.css",
    "../src/components/create/creation-studio-preview-timeline.css",
] as const;
const styles = `* { box-sizing: border-box; }\n.app-workspace-main-row { display: flex; flex: 1; min-width: 0; width: 100%; }\n.app-workspace-stage { flex: 1; min-width: 0; }\n${(await Promise.all(paths.map((path) => Bun.file(new URL(path, import.meta.url)).text()))).join("\n")}`;

let browser: Browser;
let page: Page;

beforeAll(async () => {
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
    page = await browser.newPage();
}, 30_000);

afterAll(async () => {
    await browser?.close();
}, 30_000);

test("Freezone shell preserves the content stage with compact, readable chrome", async () => {
    for (const width of [1280, 1600]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.setContent(`<html class="dark"><head><style>${styles}</style></head><body><div class="app-user-workspace app-product-workspace"><div class="app-workspace-shell"><div class="app-workspace-main-row"><aside class="app-workspace-sidebar"><div class="app-workspace-sidebar-nav"><a class="app-workspace-nav-link is-active">创作</a><a class="app-workspace-nav-link" data-nav-id="new">新建</a></div></aside><div class="app-workspace-stage"><header class="app-workspace-topbar"></header><div class="toiv-creation-workbench"><div class="toiv-create-studio"><aside class="toiv-create-rail"><span class="toiv-create-rail-meta">普通</span></aside><div class="toiv-create-splitter"></div><main class="toiv-create-stage"></main><div class="toiv-create-splitter"></div><aside class="toiv-create-inspector"></aside></div></div></div></div></div></div></body></html>`);
        const actual = await page.evaluate(() => {
            const read = (selector: string) => {
                const element = document.querySelector(selector)!;
                const style = getComputedStyle(element);
                const rect = element.getBoundingClientRect();
                return { width: rect.width, height: rect.height, background: style.backgroundColor, color: style.color };
            };
            return {
                sidebar: read(".app-workspace-sidebar"),
                topbar: read(".app-workspace-topbar"),
                stage: read(".toiv-create-stage"),
                muted: read(".toiv-create-rail-meta"),
                action: read('[data-nav-id="new"]'),
            };
        });
        expect(actual.sidebar.width).toBe(250);
        expect(actual.sidebar.background).toBe("rgb(16, 17, 22)");
        expect(actual.topbar.height).toBe(56);
        expect(actual.stage.width).toBe(width === 1280 ? 534 : 774);
        expect(actual.muted.color).toBe("rgb(139, 142, 152)");
        expect(actual.action.background).toBe("rgb(26, 27, 33)");
        expect(actual.action.color).toBe("rgb(244, 246, 247)");
    }
});

test("Freezone creation panels and timeline follow the light semantic palette", async () => {
    await page.setContent(`<html><head><style>${styles}</style></head><body><div class="app-user-workspace app-product-workspace"><div class="toiv-create-studio"><aside class="toiv-create-rail"><span class="toiv-create-rail-meta">普通</span></aside><main class="toiv-create-stage"></main><aside class="toiv-create-inspector"></aside></div><div class="toiv-timeline-dock"></div></div></body></html>`);
    const actual = await page.evaluate(() => {
        const read = (selector: string) => {
            const style = getComputedStyle(document.querySelector(selector)!);
            return { background: style.backgroundColor, color: style.color };
        };
        return {
            rail: read(".toiv-create-rail"),
            stage: read(".toiv-create-stage"),
            inspector: read(".toiv-create-inspector"),
            timeline: read(".toiv-timeline-dock"),
            muted: read(".toiv-create-rail-meta"),
        };
    });
    expect(actual.rail).toMatchObject({ background: "rgb(255, 255, 255)", color: "rgb(18, 18, 20)" });
    expect(actual.inspector).toMatchObject({ background: "rgb(255, 255, 255)", color: "rgb(18, 18, 20)" });
    expect(actual.stage.background).toBe("rgb(247, 247, 245)");
    expect(actual.timeline).toMatchObject({ background: "rgb(255, 255, 255)", color: "rgb(18, 18, 20)" });
    expect(actual.muted.color).toBe("rgb(107, 110, 118)");
});

test("selected shot expands the inspector in flow without a stage overlay", async () => {
    await page.setViewportSize({ width: 1600, height: 1000 });
    await page.setContent(`<html class="dark"><head><style>${styles}</style></head><body><div class="toiv-create-studio is-shot-selected"><aside class="toiv-create-rail"></aside><div class="toiv-create-splitter"></div><main class="toiv-create-stage"></main><div class="toiv-create-splitter"></div><aside class="toiv-create-inspector"></aside></div></body></html>`);
    const actual = await page.evaluate(() => {
        const inspector = document.querySelector(".toiv-create-inspector")!;
        const stage = document.querySelector(".toiv-create-stage")!;
        return {
            inspectorWidth: inspector.getBoundingClientRect().width,
            inspectorPosition: getComputedStyle(inspector).position,
            stagePosition: getComputedStyle(stage).position,
        };
    });
    expect(actual.inspectorWidth).toBe(420);
    expect(actual.inspectorPosition).toBe("static");
    expect(actual.stagePosition).not.toBe("fixed");
});
