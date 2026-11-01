import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let bundleDir: string;
let origin: string;
let page: Page;
let errors: string[];

const capabilities = {
    schema_version: 1,
    tools: {},
    slots: [{
        id: "image", label: "画面生成", available: true, affects: ["分镜画面"],
        engines: [{ id: "comfy", label: "ComfyUI", kind: "image", available: true, nsfw: false, params: [] }],
    }],
    issues: [],
};

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
        plugins: [{
            name: "prime-settings-sheet-harness",
            setup(builder) {
                builder.onLoad({ filter: /prime-settings-sheet\.browser\.test\.ts$/ }, () => ({
                    loader: "tsx",
                    contents: `
                import { createRoot } from "${import.meta.dir}/../node_modules/react-dom/client";
                import { MemoryRouter, Route, Routes } from "${import.meta.dir}/../node_modules/react-router-dom";
                import { I18nProvider } from "${import.meta.dir}/../src/i18n/context";
                import PrimeSettings from "${import.meta.dir}/../src/toiv/pages/PrimeSettings";
                createRoot(document.getElementById("root")!).render(
                    <MemoryRouter initialEntries={["/settings"]}>
                        <I18nProvider>
                            <Routes>
                                <Route path="/settings" element={<PrimeSettings />} />
                            </Routes>
                        </I18nProvider>
                    </MemoryRouter>,
                );
            ` }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-settings-sheet-"));
    const bundlePath = join(bundleDir, "harness.js");
    await Bun.write(bundlePath, await build.outputs[0].text());
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"]
        .map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(Bun.file(bundlePath), { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors = [];
    page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/models/capabilities") return route.fulfill({ json: capabilities });
        return route.fulfill({ status: 404, body: "unmocked" });
    });
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

const openSheet = async () => {
    await page.goto(origin);
    const trigger = page.getByRole("button", { name: "打开模型能力", exact: true });
    await trigger.click();
    const dialog = page.getByRole("dialog", { name: "模型能力", exact: true });
    await dialog.waitFor();
    return { trigger, dialog };
};

test("the model capability sheet traps focus and returns it to the opener", async () => {
    const { trigger, dialog } = await openSheet();
    expect(await dialog.getAttribute("aria-modal")).toBe("true");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    for (let index = 0; index < 40; index++) {
        await page.keyboard.press("Tab");
        expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    }
    await page.keyboard.press("Shift+Tab");
    expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
    await page.keyboard.press("Escape");
    await dialog.waitFor({ state: "hidden" });
    expect(await trigger.evaluate(element => element === document.activeElement)).toBe(true);
});

test("the sheet keeps its content inside a 390px viewport", async () => {
    const { dialog } = await openSheet();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const box = await dialog.boundingBox();
    expect(box !== null && box.x >= 0 && box.x + box.width <= 390).toBe(true);
    const controls = await page.locator(".toiv-sheet-tabs").boundingBox();
    expect(controls !== null && controls.x >= 0 && controls.x + controls.width <= 390).toBe(true);
    expect(await page.evaluate(() => {
        const backdrop = document.querySelector(".toiv-sheet-backdrop");
        const token = getComputedStyle(document.documentElement).getPropertyValue("--toiv-scrim").trim();
        return Boolean(token) && backdrop !== null && getComputedStyle(backdrop).backgroundColor === token;
    })).toBe(true);
});
