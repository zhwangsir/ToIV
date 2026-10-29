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
        name: "studio-harness-alias",
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
        entrypoints: [import.meta.dir + "/fixtures/studio-pipeline-harness.tsx"],
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
            return new Response('<meta name="viewport" content="width=device-width, initial-scale=1"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
    page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.waitForSelector(".stv-shell");
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("stage tab switch moves aria-selected", async () => {
    await page.getByRole("tab", { name: "分镜设计" }).click();
    expect(await page.getByRole("tab", { name: "分镜设计" }).getAttribute("aria-selected")).toBe("true");
    await page.getByRole("tab", { name: "素材准备" }).click();
});

test("view select sets pressed and records action", async () => {
    await page.locator(".stv-view").nth(1).click();
    expect(await page.locator(".stv-view").nth(1).getAttribute("aria-pressed")).toBe("true");
    const actions = await page.evaluate(() => window.__studioActions);
    expect(actions.some((action) => action.type === "view-select" && action.viewId === "v2")).toBe(true);
});

test("take pick moves ACTIVE tag", async () => {
    await page.locator(".stv-take").nth(1).click();
    expect(await page.locator(".stv-take[aria-pressed='true'] .tag").textContent()).toBe("ACTIVE");
});

test("replace action raises toast", async () => {
    await page.locator(".stv-view").first().getByRole("button", { name: "替换" }).click();
    await page.waitForSelector(".stv-toast:has-text('action:view-replace')");
    expect(await page.locator(".stv-toast", { hasText: "action:view-replace" }).count()).toBeGreaterThan(0);
});
