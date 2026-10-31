import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let bundleDir: string;
const errors: string[] = [];

const scenes = {
    scenes: [
        { id: "s1", name: "雨夜街口", environment_prompt: "雨夜，霓虹反光", frozen_anchor: { id: "a1" }, variants: [] },
        { id: "s2", name: "天台", environment_prompt: "黄昏，逆光", variants: [{ id: "v1", master_ref: null }] },
    ],
};

async function jobs(body: unknown, wait?: Promise<void>) {
    await page.route("**/api/jobs?limit=50", async (route) => {
        await wait;
        await route.fulfill({ json: body });
    });
}

async function sources() {
    await page.route("**/api/drama/projects/p1/scenes", route => route.fulfill({ json: scenes }));
    await jobs([]);
}

async function visit() {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator(".pf-nav").waitFor();
    await page.locator(".toiv-workspace").waitFor();
}

async function at(path: string) {
    await page.waitForFunction((expected) => window.__loc === expected, path);
    expect(await page.evaluate(() => window.__loc)).toBe(path);
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [{
        name: "prime-harness-alias",
        setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/prime-canvas-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-workspace-"));
    const bundlePath = join(bundleDir, "harness.js");
    await Bun.write(bundlePath, await build.outputs[0].text());
    const css = (await Promise.all(["index.css", "styles/printfilm.css", "App.css", "styles/toiv-skin.css"].map((file) => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            // Bun 1.2.17 segfaults on a large in-memory Response body inside bun test; serve from disk.
            if (path === "/harness.js") return new Response(Bun.file(bundlePath), { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.startsWith("/api") || path.startsWith("/studio/api")) return Response.json({ detail: "unavailable" }, { status: 503 });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(2500);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-only"));
});

afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

test("the canvas workspace uses a 48px top bar, 280/right 360 columns and a bottom task bar", async () => {
    await sources();
    await visit();
    expect((await page.locator(".pf-nav").boundingBox())?.height).toBe(48);
    expect((await page.locator(".toiv-workspace-panel.left").boundingBox())?.width).toBe(280);
    expect((await page.locator(".toiv-workspace-panel.right").boundingBox())?.width).toBe(360);
    const center = await page.locator(".toiv-workspace-center").boundingBox();
    expect(center !== null && center.width >= 600).toBe(true);
    const bar = page.getByRole("region", { name: "任务条", exact: true });
    expect(await bar.isVisible()).toBe(true);
    expect(await page.getByRole("button", { name: "雨夜街口", exact: false }).isVisible()).toBe(true);
    expect(await page.getByText("选择场景查看详情").isVisible()).toBe(true);
});

test("scene selection is shared between the list, canvas and inspector", async () => {
    await sources();
    await visit();
    await page.locator(".react-flow__node").first().waitFor();
    await page.getByRole("button", { name: "雨夜街口", exact: false }).click();
    const inspector = page.locator(".toiv-workspace-panel.right");
    expect(await inspector.textContent()).toContain("雨夜街口");
    expect(await inspector.textContent()).toContain("雨夜，霓虹反光");
    expect(await inspector.textContent()).toContain("已冻结");
    expect(await page.locator(".react-flow__node.selected").count()).toBe(1);
    expect(await page.locator(".react-flow__node.selected").textContent()).toContain("雨夜街口");
});

test("both side panels collapse and reopen from the keyboard", async () => {
    await sources();
    await visit();
    const left = page.locator(".toiv-workspace-panel.left");
    const centerBefore = (await page.locator(".toiv-workspace-center").boundingBox())!.width;
    await page.getByRole("button", { name: "收起场景栏", exact: true }).click();
    expect(await left.isVisible()).toBe(false);
    const centerAfter = (await page.locator(".toiv-workspace-center").boundingBox())!.width;
    expect(centerAfter).toBeGreaterThan(centerBefore);
    const reopen = page.getByRole("button", { name: "展开场景栏", exact: true });
    expect(await reopen.getAttribute("aria-expanded")).toBe("false");
    await reopen.focus();
    await page.keyboard.press("Enter");
    expect(await left.isVisible()).toBe(true);
    await page.getByRole("button", { name: "收起检查栏", exact: true }).click();
    expect(await page.locator(".toiv-workspace-panel.right").isVisible()).toBe(false);
    await page.getByRole("button", { name: "展开检查栏", exact: true }).click();
    expect(await page.locator(".toiv-workspace-panel.right").isVisible()).toBe(true);
});

test("the NSFW switch records a local preference without unlocking content", async () => {
    await sources();
    await visit();
    const toggle = page.getByRole("button", { name: "NSFW 偏好", exact: true });
    expect(await toggle.getAttribute("aria-pressed")).toBe("false");
    expect(await toggle.getAttribute("title")).toContain("仅记录偏好");
    await toggle.click();
    expect(await toggle.getAttribute("aria-pressed")).toBe("true");
    expect(await page.evaluate(() => localStorage.getItem("toiv_nsfw_pref"))).toBe("1");
    expect(await page.evaluate(() => document.documentElement.getAttribute("data-nsfw"))).toBe(null);
    await page.reload();
    await page.locator(".pf-nav").waitFor();
    expect(await page.getByRole("button", { name: "NSFW 偏好", exact: true }).getAttribute("aria-pressed")).toBe("true");
});

test("the task bar shows live jobs and never invents a running count", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    await page.route("**/api/drama/projects/p1/scenes", route => route.fulfill({ json: scenes }));
    await jobs([
        { id: "j1", kind: "scene-render", status: "running", progress: { pct: 40 }, created_at: "2026-10-30T10:00:00Z" },
        { id: "j2", kind: "voice", status: "succeeded", created_at: "2026-10-30T09:00:00Z" },
    ], wait);
    await visit();
    const bar = page.getByRole("region", { name: "任务条", exact: true });
    expect(await bar.getByRole("status").textContent()).toContain("任务加载中");
    expect(await bar.textContent()).not.toContain("0 运行中");
    release();
    await bar.getByText("1 运行中", { exact: false }).waitFor();
    expect(await bar.textContent()).toContain("scene-render");
    expect(await bar.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("40");
    await bar.getByRole("link", { name: "全部任务", exact: true }).click();
    await at("/history");
});

test("an empty queue reads as idle without claiming zero running", async () => {
    await sources();
    await visit();
    const bar = page.getByRole("region", { name: "任务条", exact: true });
    await bar.getByText("队列空闲", { exact: false }).waitFor();
    expect(await bar.textContent()).not.toContain("0 运行中");
});

test("mobile keeps the panels closed and inside the viewport", async () => {
    await page.setViewportSize({ width: 390, height: 850 });
    await sources();
    await visit();
    expect(await page.locator(".toiv-workspace-panel.left").isVisible()).toBe(false);
    expect(await page.locator(".toiv-workspace-panel.right").isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const openLeft = page.getByRole("button", { name: "展开场景栏", exact: true });
    expect(await openLeft.isVisible()).toBe(true);
    await openLeft.focus();
    await page.keyboard.press("Enter");
    const left = page.locator(".toiv-workspace-panel.left");
    expect(await left.isVisible()).toBe(true);
    const box = (await left.boundingBox())!;
    expect(box.x >= 0 && box.x + box.width <= 390).toBe(true);
    await page.keyboard.press("Escape");
    expect(await left.isVisible()).toBe(false);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
