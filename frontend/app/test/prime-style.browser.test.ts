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
let scenesStatus: number;
let scenesReads: number;
let freezeCalls: number;
let freezeStatus: number;
let scenesGate: Promise<void> | undefined;
let freezeGate: Promise<void> | undefined;
let frozen: boolean;

const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
);

const scene = () => ({
    id: "s1", name: "雨夜街口", environment_prompt: "雨夜，霓虹反光",
    master_ref: "/api/studio/files/scene.png", reverse_ref: null,
    frozen_anchor: frozen ? { hash: "sha256:abc" } : null, variants: [],
});

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
        plugins: [{
            name: "prime-style-harness",
            setup(builder) {
                builder.onLoad({ filter: /prime-style\.browser\.test\.ts$/ }, () => ({
                    loader: "tsx",
                    contents: `
                import { createRoot } from "${import.meta.dir}/../node_modules/react-dom/client";
                import { MemoryRouter, Route, Routes } from "${import.meta.dir}/../node_modules/react-router-dom";
                import { I18nProvider } from "${import.meta.dir}/../src/i18n/context";
                import { TaskCenterProvider } from "${import.meta.dir}/../src/toiv/addons/TaskCenterProvider";
                import PrimeStyle from "${import.meta.dir}/../src/toiv/pages/PrimeStyle";
                createRoot(document.getElementById("root")!).render(
                    <MemoryRouter initialEntries={["/studio/p1/style"]}>
                        <I18nProvider>
                            <TaskCenterProvider>
                                <Routes>
                                    <Route path="/studio/:id/style" element={<PrimeStyle />} />
                                </Routes>
                            </TaskCenterProvider>
                        </I18nProvider>
                    </MemoryRouter>,
                );
            ` }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-style-"));
    const bundlePath = join(bundleDir, "harness.js");
    await Bun.write(bundlePath, await build.outputs[0].text());
    server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(Bun.file(bundlePath), { headers: { "Content-Type": "text/javascript" } });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors = [];
    scenesStatus = 200;
    scenesReads = 0;
    freezeCalls = 0;
    freezeStatus = 200;
    scenesGate = undefined;
    freezeGate = undefined;
    frozen = false;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/*", async route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/jobs/active") return route.fulfill({ json: { items: [], server_time: "2026-11-01T10:00:00Z" } });
        if (url.pathname === "/api/jobs/counts") return route.fulfill({ json: { count: 0, failed: 0 } });
        if (url.pathname === "/api/studio/deps-status") return route.fulfill({ json: { overall: "reachable", deps: [] } });
        if (url.pathname === "/api/drama/projects/p1/scenes") {
            scenesReads++;
            await scenesGate;
            if (scenesStatus !== 200) return route.fulfill({ status: scenesStatus, json: { detail: "场景服务不可用" } });
            return route.fulfill({ json: { scenes: [scene()] } });
        }
        if (url.pathname === "/api/drama/scenes/s1/freeze-anchor") {
            freezeCalls++;
            await freezeGate;
            if (freezeStatus !== 200) return route.fulfill({ status: freezeStatus, json: { detail: "需先有主参考图" } });
            frozen = true;
            return route.fulfill({ json: { ok: true } });
        }
        if (url.pathname.startsWith("/api/studio/files/")) return route.fulfill({ body: png, contentType: "image/png" });
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

const visit = () => page.goto(origin);

test("an in-flight scene read reports unknown, never zero scenes", async () => {
    let release!: () => void;
    scenesGate = new Promise(resolve => { release = resolve; });
    await visit();
    await page.getByText("正在载入场景…", { exact: true }).waitFor();
    expect(await page.getByText("0 场景", { exact: true }).count()).toBe(0);
    expect(await page.getByText("场景数未知", { exact: true }).count()).toBe(1);
    release();
    await page.getByText("1 场景", { exact: true }).waitFor();
    await page.getByText("雨夜街口", { exact: true }).waitFor();
    expect(await page.getByText(/^0 场景$/).count()).toBe(0);
});

test("a failed scene read is explicit, never zero, and retry recovers into cards", async () => {
    scenesStatus = 503;
    await visit();
    const failure = page.getByRole("alert");
    await failure.waitFor();
    expect(await failure.innerText()).toContain("场景载入失败");
    expect(await page.getByText("0 场景", { exact: true }).count()).toBe(0);
    expect(await page.getByText("场景数未知", { exact: true }).count()).toBe(1);
    scenesStatus = 200;
    await page.getByRole("button", { name: "重试载入场景", exact: true }).click();
    await page.getByText("雨夜街口", { exact: true }).waitFor();
    expect(await page.getByText("1 场景", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("alert").count()).toBe(0);
});

test("freeze submits once while pending and reloads the frozen anchor after success", async () => {
    let release!: () => void;
    freezeGate = new Promise(resolve => { release = resolve; });
    await visit();
    await page.getByText("雨夜街口", { exact: true }).waitFor();
    const freeze = page.getByRole("button", { name: "冻结主参考", exact: true });
    await freeze.evaluate(button => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await page.getByRole("button", { name: "冻结中…", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "冻结中…", exact: true }).isDisabled()).toBe(true);
    expect(freezeCalls).toBe(1);
    release();
    await page.getByText("已冻结 雨夜街口 主参考锚点", { exact: true }).waitFor();
    await page.getByText("已冻结", { exact: true }).waitFor();
    expect(scenesReads).toBeGreaterThanOrEqual(2);
    expect(await page.getByRole("button", { name: "冻结主参考", exact: true }).isDisabled()).toBe(true);
});

test("freeze failures explain the missing master reference and keep the action retryable", async () => {
    freezeStatus = 409;
    await visit();
    await page.getByText("雨夜街口", { exact: true }).waitFor();
    await page.getByRole("button", { name: "冻结主参考", exact: true }).click();
    const failure = page.getByRole("alert").filter({ hasText: "冻结失败" });
    await failure.waitFor();
    expect(await failure.innerText()).toContain("主参考");
    expect(await page.getByRole("button", { name: "冻结主参考", exact: true }).isEnabled()).toBe(true);
});
