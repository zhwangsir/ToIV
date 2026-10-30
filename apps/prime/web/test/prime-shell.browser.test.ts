import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

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
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path.startsWith("/api") || path.startsWith("/studio/api")) {
                return new Response(JSON.stringify({ detail: "unavailable" }), { status: 503, headers: { "Content-Type": "application/json" } });
            }
            return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector(".toiv-workbar");
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("both sources failing degrades to empty library with alert", async () => {
    await page.waitForSelector(".toiv-degraded");
    expect(await page.locator(".toiv-card").count()).toBe(0);
    expect(await page.getByLabel("搜索项目").count()).toBe(1);
});

test("face switch routes to the canvas group", async () => {
    await page.getByRole("button", { name: "画布" }).click();
    await page.waitForFunction(() => window.__loc === "/drama");
    expect(await page.evaluate(() => window.__loc)).toBe("/drama");
});
