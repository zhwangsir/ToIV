import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../node_modules/antd/dist/reset.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/pages/settings/settings-visual.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/slot-lora-feedback-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
        : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:var(--toiv-bg)}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("base mismatch and failed persistence stay explicit", async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.route("**/models/engines*", (route) => route.abort());
    await page.goto(server.url.toString());
    await page.getByTestId("slot-lora-incompatible-video-primary").waitFor();
    expect(await page.getByTestId("slot-lora-incompatible-video-primary").textContent()).toContain("生成前需调整");
    await page.getByTestId("slot-lora-manage-video-primary").click();
    await page.getByTestId("slot-lora-load-error-video-primary").waitFor();
    expect(await page.getByTestId("slot-lora-modal-incompatible-video-primary").textContent()).toContain("原选择仍保留");
    expect(await page.getByTestId("slot-lora-empty-video-primary").textContent()).toContain("暂无候选");
    await page.screenshot({ path: "test-results/freezone-r10/lora-base-mismatch.png", fullPage: true, animations: "disabled" });

    await page.evaluate(() => {
        Storage.prototype.setItem = () => { throw new DOMException("quota exceeded", "QuotaExceededError"); };
    });
    await page.getByRole("button", { name: "保存到本槽" }).click();
    expect(await page.locator(".ant-message").textContent()).toContain("本地保存失败");
    expect(await page.getByTestId("slot-lora-modal-incompatible-video-primary").count()).toBe(1);
    await page.close();
});

test("online inventory failure preserves local compatible candidates", async () => {
    const page = await browser.newPage({ viewport: { width: 1100, height: 900 } });
    await page.route("**/models/engines*", (route) => route.abort());
    await page.goto(`${server.url}?compatible=1`);
    await page.getByTestId("slot-lora-manage-video-primary").click();
    await page.getByTestId("slot-lora-load-error-video-primary").waitFor();
    expect(await page.locator('[data-testid="slot-lora-list-video-primary"] li').count()).toBeGreaterThan(0);
    await page.locator('[data-testid="slot-lora-list-video-primary"]').waitFor();
    await page.screenshot({ path: "test-results/freezone-r10/lora-local-fallback.png", fullPage: true, animations: "disabled" });
    await page.close();
});
