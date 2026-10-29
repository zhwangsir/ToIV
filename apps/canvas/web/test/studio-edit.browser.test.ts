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
        name: "studio-edit-harness-alias",
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
        entrypoints: [import.meta.dir + "/fixtures/studio-edit-harness.tsx"],
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
            if (path.startsWith("/api")) return new Response(JSON.stringify({ code: 503, msg: "harness offline" }), { status: 503, headers: { "Content-Type": "application/json" } });
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><html class="dark"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector(".seq");
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("play advances the playhead", async () => {
    const before = await page.locator(".playhead").first().getAttribute("style");
    await page.getByRole("button", { name: "播放" }).click();
    await page.waitForTimeout(900);
    const after = await page.locator(".playhead").first().getAttribute("style");
    expect(after).not.toBe(before);
    await page.getByRole("button", { name: "暂停" }).click();
});

test("clip pick sets pressed state", async () => {
    await page.locator(".clip").nth(1).click();
    expect(await page.locator(".clip").nth(1).getAttribute("aria-pressed")).toBe("true");
});

test("export menu lists four actions", async () => {
    await page.getByRole("button", { name: "导出" }).click();
    expect(await page.getByRole("menuitem").count()).toBe(4);
});

test("edl export failure surfaces a warn toast", async () => {
    await page.getByRole("menuitem", { name: /EDL/ }).click();
    await page.waitForSelector(".stv-toast.warn");
    expect(await page.locator(".stv-toast.warn").first().textContent()).toContain("失败");
});
