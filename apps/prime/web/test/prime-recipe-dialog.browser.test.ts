import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let succeed = false;
const errors: string[] = [];

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/prime-recipe-harness.tsx"], target: "browser" });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "content-type": "text/javascript" } });
        if (path === "/install") return new Response("{}", { status: succeed ? 200 : 503 });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "content-type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(2000);
    page.on("pageerror", error => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.port}`);
});
afterAll(async () => { await browser?.close(); server?.stop(true); });

test("failed recipe installation preserves the payload and can retry successfully", async () => {
    const payload = '{"schema":"toiv_generation_recipe_v1","recipe":{"name":"测试配方"}}';
    await page.getByRole("button", { name: "打开安装", exact: true }).click();
    await page.getByLabel("配方 JSON").fill(payload);
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await page.getByRole("alert").waitFor();
    expect(await page.getByLabel("配方 JSON").inputValue()).toBe(payload);
    expect(await page.getByRole("dialog").isVisible()).toBe(true);
    succeed = true;
    await page.getByRole("button", { name: "安装", exact: true }).click();
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(errors).toEqual([]);
});

test("modal focus is contained and returns to the opener after Escape", async () => {
    await page.getByRole("button", { name: "打开安装", exact: true }).click();
    await page.getByLabel("配方 JSON").waitFor();
    for (let index = 0; index < 6; index++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "hidden" });
    expect(await page.getByRole("button", { name: "打开安装", exact: true }).evaluate(element => element === document.activeElement)).toBe(true);
});
