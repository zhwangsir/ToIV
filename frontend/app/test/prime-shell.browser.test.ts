import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
const errors: string[] = [];
const studioProjects = [{ id: "s1", title: "Moon Story", status: "draft", shots_count: 12 }, { id: "s2", title: "无镜头数据", status: "draft" }];
const canvasProjects = [{ id: "c1", title: "画布草稿" }];
type SourceReply = { status?: number; body?: unknown; wait?: Promise<void> };

async function sources(studio: SourceReply = {}, canvas: SourceReply = {}) {
    await page.route("**/api/studio/projects?limit=200", async (route) => {
        await studio.wait;
        await route.fulfill({ status: studio.status ?? 200, json: studio.body ?? { projects: studioProjects } });
    });
    await page.route("**/studio/api/canvas-projects", async (route) => {
        await canvas.wait;
        await route.fulfill({ status: canvas.status ?? 200, json: canvas.body ?? { code: 0, data: { projects: canvasProjects }, msg: "ok" } });
    });
}

async function visit(path = "/") {
    await page.goto(`http://127.0.0.1:${server.port}/?path=${encodeURIComponent(path)}`);
    await page.locator(".pf-nav").waitFor();
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
        entrypoints: [import.meta.dir + "/fixtures/prime-home-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"].map((file) => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.startsWith("/api") || path.startsWith("/studio/api")) return Response.json({ detail: "unavailable" }, { status: 503 });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1440, height: 950 } });
    page.setDefaultTimeout(2000);
    page.on("pageerror", (error) => errors.push(error.message));
});

afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("pending requests show loading, never an empty library or fabricated counts", async () => {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => { release = resolve; });
    await sources({ wait }, { wait });
    try {
        await visit();
        expect(await page.getByRole("status").textContent()).toContain("加载");
        expect(await page.locator(".pf-history-main").getAttribute("aria-busy")).toBe("true");
        expect(await page.getByText("还没有项目", { exact: false }).count()).toBe(0);
        expect(await page.getByText(/0 运行中|0 个项目|0 镜/).count()).toBe(0);
    } finally { release(); }
    await page.locator(".pf-project-card").first().waitFor();
});

test("both source failures show a retryable error instead of an empty library", async () => {
    await sources({ status: 503 }, { status: 503 });
    await visit();
    expect(await page.getByRole("alert").textContent()).toContain("项目加载失败");
    expect(await page.getByText("还没有项目", { exact: false }).count()).toBe(0);
    expect(await page.locator(".pf-project-card").count()).toBe(0);
    await sources();
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.locator(".pf-project-card").first().waitFor();
    expect(await page.locator(".pf-project-card").count()).toBe(3);
    expect(await page.getByRole("alert").count()).toBe(0);
});

for (const failedSource of ["studio", "canvas"] as const) {
    test(`${failedSource} failure retains the other source and recovers on retry`, async () => {
        await sources(failedSource === "studio" ? { status: 503 } : {}, failedSource === "canvas" ? { status: 503 } : {});
        await visit();
        expect(await page.getByRole("alert").textContent()).toContain(failedSource === "studio" ? "Studio 项目源" : "画布项目源");
        expect(await page.locator(".pf-project-card").count()).toBe(failedSource === "studio" ? 1 : 2);
        await sources();
        await page.getByRole("button", { name: "重试", exact: true }).click();
        await page.waitForFunction(() => document.querySelectorAll(".pf-project-card").length === 3);
        expect(await page.getByRole("alert").count()).toBe(0);
    });
}

test("a failed source with an empty surviving source does not claim there are no projects", async () => {
    await sources({ status: 503 }, { body: { code: 0, data: { projects: [] }, msg: "ok" } });
    await visit();
    await page.getByRole("alert").waitFor();
    expect(await page.getByText("还没有项目", { exact: false }).count()).toBe(0);
    expect(await page.getByText("可用来源中暂无项目", { exact: false }).count()).toBe(1);
});

test("an empty successful library offers creation", async () => {
    await sources({ body: { projects: [] } }, { body: { code: 0, data: { projects: [] }, msg: "ok" } });
    await visit();
    const empty = page.locator(".pf-history-empty");
    expect(await empty.textContent()).toContain("还没有项目");
    expect(await page.getByRole("alert").count()).toBe(0);
    await empty.getByRole("link", { name: "新建项目" }).click();
    await at("/studio/new");
});

test("native project rows expose keyboard entry without fabricated shot counts", async () => {
    await sources();
    await visit();
    const rows = page.locator(".pf-project-list > .pf-project-card");
    await rows.first().waitFor();
    expect(await rows.count()).toBe(3);
    expect(await rows.first().locator(":scope > .pf-project-thumb").count()).toBe(1);
    expect(await rows.first().locator(":scope > .pf-project-info h3").textContent()).toBe("Moon Story");
    expect(await rows.first().locator(":scope > .pf-project-actions").count()).toBe(1);
    expect(await rows.first().textContent()).toContain("12 镜头");
    expect(await rows.nth(1).textContent()).not.toMatch(/0 镜/);
    expect(await rows.nth(2).textContent()).not.toMatch(/0 镜/);
    await rows.first().getByRole("button", { name: "打开项目 Moon Story" }).focus();
    await page.keyboard.press("Enter");
    await at("/studio/s1");
});

test("source tabs and normalized title search distinguish no results from no data", async () => {
    await sources();
    await visit();
    await page.locator(".pf-project-card").first().waitFor();
    await page.getByRole("tab", { name: "画布项目", exact: true }).click();
    expect(await page.locator(".pf-project-card").count()).toBe(1);
    await page.getByRole("tab", { name: "全部项目", exact: true }).click();
    await page.getByLabel("搜索项目").fill("  moon  ");
    expect(await page.locator(".pf-project-card").count()).toBe(1);
    await page.getByLabel("搜索项目").fill("missing-project");
    expect(await page.locator(".pf-history-empty").textContent()).toContain("没有匹配的项目");
    expect(await page.getByText("还没有项目", { exact: false }).count()).toBe(0);
    await page.getByRole("button", { name: "清除筛选" }).click();
    expect(await page.locator(".pf-project-card").count()).toBe(3);
});

for (const entry of [
    { path: "/", title: "画布草稿", target: "/legacy/canvas/c1" },
    { path: "/edit-library", title: "Moon Story", target: "/studio/s1/editor" },
    { path: "/studio?face=edit", title: "Moon Story", target: "/studio/s1/editor" },
    { path: "/drama/assets", title: "Moon Story", target: "/drama/projects/s1/assets" },
    { path: "/drama/assets", title: "画布草稿", target: "/legacy/canvas/c1" },
]) {
    test(`project entry ${entry.path} preserves target ${entry.target}`, async () => {
        await sources();
        await visit(entry.path);
        await page.getByRole("button", { name: `打开项目 ${entry.title}` }).click();
        await at(entry.target);
    });
}

test("the work-face edit entry retains project editing context", async () => {
    await sources();
    await visit();
    await page.getByRole("button", { name: "剪辑湾", exact: true }).click();
    await page.getByRole("button", { name: "打开项目 Moon Story" }).click();
    await at("/studio/s1/editor");
});

test("face switch still routes to the canvas group", async () => {
    await sources();
    await visit();
    await page.getByRole("group", { name: "工作面", exact: true }).getByRole("button", { name: "画布", exact: true }).click();
    await at("/drama");
});

for (const [path, current] of [
    ["/", "项目"], ["/studio/s1", "项目"], ["/studio/s1/editor", "项目"],
    ["/drama", "画布"], ["/drama/projects/s1/canvas", "画布"],
    ["/drama/assets", "资产"], ["/drama/projects/s1/assets", "资产"],
    ["/history", "作品与任务"], ["/tools/image", "工具"], ["/settings", "设置"],
]) {
    test(`navigation marks only ${current} active at ${path}`, async () => {
        await sources();
        await visit(path);
        const nav = page.getByRole("navigation", { name: "主导航", exact: true });
        expect(await nav.locator(".active").allTextContents()).toEqual([current]);
        expect(await nav.locator('[aria-current="page"]').allTextContents()).toEqual([current]);
        expect(await nav.innerText()).toContain("作品与任务");
        expect(await nav.innerText()).toContain("资产");
    });
}

for (const width of [390, 768, 1100]) {
    test(`mobile navigation is keyboard operable at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 850 });
        await sources();
        await visit();
        const burger = page.getByRole("button", { name: "打开菜单", exact: true });
        expect(await burger.isVisible()).toBe(true);
        await burger.focus();
        await page.keyboard.press("Enter");
        const mobile = page.getByRole("navigation", { name: "移动导航", exact: true });
        await mobile.waitFor();
        expect(await page.getByRole("button", { name: "关闭菜单" }).getAttribute("aria-expanded")).toBe("true");
        await page.keyboard.press("Escape");
        expect(await mobile.count()).toBe(0);
        expect(await burger.evaluate((element) => element === document.activeElement)).toBe(true);
        await page.keyboard.press("Enter");
        const assets = mobile.getByRole("link", { name: "资产", exact: true });
        await assets.focus();
        await page.keyboard.press("Enter");
        await at("/drama/assets");
        expect(await mobile.count()).toBe(0);
        expect(await page.getByRole("button", { name: "打开菜单" }).getAttribute("aria-expanded")).toBe("false");
    });
}

test("the shell restores vendor accent and keeps mobile cards within the viewport", async () => {
    await sources();
    await visit();
    expect(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--pf-lime").trim())).toBe("#b6ff00");
    expect(await page.locator(".pf-nav-right").isVisible()).toBe(true);
    await page.setViewportSize({ width: 390, height: 850 });
    await page.locator(".pf-project-card").first().waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    for (const node of await page.locator(".pf-project-card, .pf-project-info, .pf-project-actions, .pf-search-field").all()) {
        const box = await node.boundingBox();
        expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    }
});

test("the task entry opens the existing task panel without inventing a running count", async () => {
    await sources();
    await visit();
    await page.getByRole("button", { name: "打开任务中心", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "任务中心", exact: true });
    await dialog.waitFor();
    expect(await page.evaluate(() => window.__loc)).toBe("/");
    expect(await page.getByText("0 运行中", { exact: false }).count()).toBe(0);
});

test("the brand mark remains readable on the restored vendor accent", async () => {
    await sources();
    await visit();
    const contrast = await page.locator(".toiv-lockup .mark").evaluate((element) => {
        const style = getComputedStyle(element);
        const luminance = (color: string) => {
            const channels = color.match(/[\d.]+/g)!.slice(0, 3).map(Number).map((channel) => {
                const value = channel / 255;
                return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
            });
            return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
        };
        const ink = luminance(style.color);
        const background = luminance(style.backgroundColor);
        return (Math.max(ink, background) + 0.05) / (Math.min(ink, background) + 0.05);
    });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
});

test("navigation has no vendor session request or token mutation", async () => {
    const apiRequests: string[] = [];
    await page.addInitScript(() => {
        localStorage.setItem("token", "fixture-vendor-token");
        localStorage.setItem("toiv_token", "fixture-toiv-token");
    });
    page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/studio/api/")) apiRequests.push(url.pathname);
    });
    await sources();
    await visit();
    await page.locator(".pf-project-card").first().waitFor();
    expect(apiRequests.sort()).toEqual(["/api/studio/projects", "/studio/api/canvas-projects"]);
    expect(await page.evaluate(() => localStorage.getItem("token"))).toBe("fixture-vendor-token");
    expect(await page.evaluate(() => localStorage.getItem("toiv_token"))).toBe("fixture-toiv-token");
});
