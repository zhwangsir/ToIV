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
let recovered: boolean;
let errors: string[];

const fakeToken = "media-signing-fixture-token";
const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=",
    "base64",
);

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
        plugins: [{
            name: "prime-media-signing-harness",
            setup(builder) {
                builder.onLoad({ filter: /prime-media-signing\.browser\.test\.ts$/ }, () => ({
                    loader: "tsx",
                    contents: `
                import { createRoot } from "${import.meta.dir}/../node_modules/react-dom/client";
                import { MemoryRouter, Route, Routes } from "${import.meta.dir}/../node_modules/react-router-dom";
                import { I18nProvider } from "${import.meta.dir}/../src/i18n/context";
                import { TaskCenterProvider } from "${import.meta.dir}/../src/toiv/addons/TaskCenterProvider";
                import { applyStoredAppearance } from "${import.meta.dir}/../src/toiv/theme/appearance";
                import PrimeStyle from "${import.meta.dir}/../src/toiv/pages/PrimeStyle";
                import PrimeAssets from "${import.meta.dir}/../src/toiv/pages/PrimeAssets";
                import PrimeCanvas from "${import.meta.dir}/../src/toiv/pages/PrimeCanvas";

                const path = new URLSearchParams(window.location.search).get("path") || "/drama/projects/p1/assets";
                applyStoredAppearance();
                createRoot(document.getElementById("root")!).render(
                    <MemoryRouter initialEntries={[path]}>
                        <I18nProvider>
                            <TaskCenterProvider>
                                <Routes>
                                    <Route path="/studio/:id/style" element={<PrimeStyle />} />
                                    <Route path="/drama/projects/:projectId/assets" element={<PrimeAssets />} />
                                    <Route path="/drama/projects/:projectId/canvas" element={<PrimeCanvas />} />
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
    bundleDir = mkdtempSync(join(tmpdir(), "prime-media-signing-"));
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
    recovered = false;
    errors = [];
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(token => localStorage.setItem("toiv_token", token), fakeToken);
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
        if (url.hostname === "cdn.example") return route.fulfill({ body: png, contentType: "image/png" });
        if (url.pathname === "/api/jobs") return route.fulfill({ json: [] });
        if (url.pathname === "/api/studio/projects/p1") return route.fulfill({ json: {
            id: "p1", title: "测试剧", characters: [
                { id: "c1", name: "林夏", style: "anime", reference_image: "/api/studio/files/char.png" },
                { id: "c2", name: "阿七", style: "anime", reference_image: "/api/studio/files/expired.png" },
            ],
        } });
        if (url.pathname === "/api/drama/projects/p1/scenes") return route.fulfill({ json: { scenes: [{
            id: "s1", name: "雨夜街口", environment_prompt: "雨夜，霓虹反光",
            master_ref: "/api/studio/files/scene.png", reverse_ref: "https://cdn.example/ext.png", variants: [],
        }] } });
        if (url.pathname.startsWith("/api/studio/files/")) {
            if (url.searchParams.get("token") !== fakeToken) return route.fulfill({ status: 401, body: "expired" });
            if (url.pathname.endsWith("expired.png") && !recovered) return route.fulfill({ status: 401, body: "expired" });
            return route.fulfill({ body: png, contentType: "image/png" });
        }
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

const visit = (path: string) => page.goto(`${origin}/?path=${encodeURIComponent(path)}`);
const signedImage = (page: Page, name: string) => page.locator(`img[src*="${name}.png"]`);
const decoded = (page: Page, selector: string) => page.waitForFunction(
    (value) => [...document.querySelectorAll(value)].some(
        image => (image as HTMLImageElement).naturalWidth > 0,
    ), selector,
);

test("assets sign every same-origin API reference, decode it and never touch external URLs", async () => {
    await visit("/drama/projects/p1/assets");
    await decoded(page, 'img[src*="char.png"]');
    await decoded(page, 'img[src*="scene.png"]');
    await decoded(page, 'img[src*="ext.png"]');
    const character = await signedImage(page, "char").getAttribute("src");
    const scene = await signedImage(page, "scene").getAttribute("src");
    expect(new URL(character!).searchParams.getAll("token")).toEqual([fakeToken]);
    expect(new URL(scene!).searchParams.getAll("token")).toEqual([fakeToken]);
    const external = await signedImage(page, "ext").getAttribute("src");
    expect(external).toBe("https://cdn.example/ext.png");
    expect(external).not.toContain(fakeToken);
    // 空参考位保留标签，不伪造图片。
    expect(await page.locator(".toiv-card .thumbs .thumb i").allInnerTexts()).toEqual(["左立面", "右立面"]);
});

test("a failed reference explains the likely expired session and retries into a decoded image", async () => {
    await visit("/drama/projects/p1/assets");
    await decoded(page, 'img[src*="scene.png"]');
    const alert = page.getByRole("alert").filter({ hasText: "载入失败" }).first();
    await alert.waitFor();
    expect(await alert.getAttribute("title")).toContain("登录已过期");
    recovered = true;
    await page.getByRole("button", { name: "重试 阿七" }).click();
    await decoded(page, 'img[src*="expired.png"]');
    expect(await page.getByRole("alert").count()).toBe(0);
});

test("scene anchor page decodes signed references and leaves external ones unsigned", async () => {
    await visit("/studio/p1/style");
    await decoded(page, 'img[src*="scene.png"]');
    await decoded(page, 'img[src*="ext.png"]');
    const scene = await signedImage(page, "scene").getAttribute("src");
    expect(new URL(scene!).searchParams.get("token")).toBe(fakeToken);
    expect(await signedImage(page, "ext").getAttribute("src")).toBe("https://cdn.example/ext.png");
});

test("canvas nodes and the inspector decode signed references", async () => {
    await visit("/drama/projects/p1/canvas");
    await page.locator(".react-flow__node").first().waitFor();
    await decoded(page, '.react-flow__node img[src*="scene.png"]');
    await decoded(page, '.react-flow__node img[src*="ext.png"]');
    await page.getByRole("button", { name: "雨夜街口", exact: false }).click();
    const inspector = page.locator(".toiv-workspace-panel.right");
    await decoded(page, '.toiv-inspector img[src*="scene.png"]');
    expect(await inspector.textContent()).toContain("雨夜街口");
    const nodeSrc = await page.locator('.react-flow__node img[src*="scene.png"]').first().getAttribute("src");
    expect(new URL(nodeSrc!).searchParams.get("token")).toBe(fakeToken);
});
