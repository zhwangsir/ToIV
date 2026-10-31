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

async function visit() {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
}

async function setColor(label: string, value: string) {
    await page.getByLabel(label, { exact: true }).evaluate((element, next) => {
        const input = element as HTMLInputElement;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
        setter?.call(input, next);
        input.dispatchEvent(new Event("input", { bubbles: true }));
        input.dispatchEvent(new Event("change", { bubbles: true }));
    }, value);
}

async function cssVar(name: string) {
    return page.evaluate((token) => getComputedStyle(document.documentElement).getPropertyValue(token).trim(), name);
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
        entrypoints: [import.meta.dir + "/fixtures/prime-theme-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-theme-"));
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
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(2500);
    page.on("pageerror", (error) => errors.push(error.message));
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

test("defaults to the light theme and offers four theme choices", async () => {
    await visit();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("light");
    const group = page.getByRole("radiogroup", { name: "主题", exact: true });
    expect(await group.getByRole("radio").count()).toBe(4);
    expect(await group.getByRole("radio", { name: /浅色清爽/ }).getAttribute("aria-checked")).toBe("true");
    expect(await group.getByRole("radio", { name: /极光深色/ }).getAttribute("aria-checked")).toBe("false");
    expect(await page.getByText("次要文字对比度", { exact: false }).textContent()).toContain("AA 通过");
});

test("switches palettes and keeps the choice across reloads", async () => {
    await visit();
    await page.getByRole("radio", { name: /极光深色/ }).click();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("aurora");
    expect(await cssVar("--pf-bg")).toBe("#0b1020");
    await page.reload();
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.dataset.theme)).toBe("aurora");
    expect(await page.getByRole("radio", { name: /极光深色/ }).getAttribute("aria-checked")).toBe("true");
});

test("edits a colour, warns on low contrast and resets to the palette", async () => {
    await visit();
    await setColor("次要文字", "#dddddd");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("低于 AA");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--text-secondary").trim())).toBe("#dddddd");
    await page.reload();
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--text-secondary").trim())).toBe("#dddddd");
    await page.getByRole("button", { name: "恢复当前主题默认", exact: true }).click();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--text-secondary"))).toBe("");
    expect(await page.getByRole("alert").count()).toBe(0);
    expect(await page.getByLabel("次要文字", { exact: true }).inputValue()).toBe("#4b5563");
});

test("custom colours stay scoped to their theme across switches", async () => {
    await visit();
    await setColor("主色", "#00ffcc");
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--pf-lime").trim())).toBe("#00ffcc");
    await page.getByRole("radio", { name: /赛博霓虹/ }).click();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--pf-lime"))).toBe("");
    expect(await cssVar("--pf-lime")).toBe("#21f3ff");
    await page.getByRole("radio", { name: /浅色清爽/ }).click();
    expect(await page.evaluate(() => document.documentElement.style.getPropertyValue("--pf-lime").trim())).toBe("#00ffcc");
});

test("canvas background, grid and selected-node tokens follow the theme", async () => {
    await visit();
    await page.getByRole("radio", { name: /赛博霓虹/ }).click();
    await page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue("--bg-canvas").trim() === "#05010d");
    expect(await cssVar("--grid-color")).toContain("33, 243, 255");
    expect(await cssVar("--node-border-selected")).toBe("#ff2bd6");
    const probe = page.getByTestId("canvas-probe");
    expect(await probe.evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(5, 1, 13)");
    expect(await page.locator(".react-flow__node.selected .toiv-node").evaluate((element) => getComputedStyle(element).borderTopColor)).toBe("rgb(255, 43, 214)");
});
