import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const plugins: BunPlugin[] = [{
        name: "studio-canvas-harness-alias",
        setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onResolve({ filter: /^@content-lock$/ }, () => ({
                path: ["../src/content-lock.ts", "../src/content-policy.ts"]
                    .map((candidate) => resolve(import.meta.dir, candidate))
                    .find((candidate) => existsSync(candidate))!,
            }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/studio-canvas-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_STUDIO_FACE_FALLBACK: "" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><html class="dark"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector(".pgrid");
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("face switcher marks canvas active", async () => {
    expect(await page.locator(".stv-faces button[aria-pressed='true']").textContent()).toBe("画布");
});

test("search filters cards and empty state offers create", async () => {
    await page.getByLabel("搜索项目").fill("草船");
    expect(await page.locator(".pcard").count()).toBe(1);
    await page.getByLabel("搜索项目").fill("zzz");
    expect(await page.getByRole("button", { name: "新建项目" }).count()).toBeGreaterThan(0);
    await page.getByLabel("搜索项目").fill("");
    expect(await page.locator(".pcard").count()).toBe(2);
});

test("card click records open id", async () => {
    await page.getByRole("button", { name: "打开项目 小蝌蚪找妈妈" }).click();
    const ids = await page.evaluate(() => window.__openIds);
    expect(ids).toContain("p2");
});

test("create action raises warn toast", async () => {
    await page.getByRole("button", { name: "新建项目" }).first().click();
    await page.waitForSelector(".stv-toast.warn");
    expect(await page.locator(".stv-toast.warn").first().textContent()).toContain("新建项目");
});
