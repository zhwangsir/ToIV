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
const posts: { path: string; body: Record<string, unknown> }[] = [];
let activePrompt = "";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

async function visit(path: string) {
    await page.goto(`http://127.0.0.1:${server.port}/?path=${encodeURIComponent(path)}`);
    await page.locator(".pf-nav").waitFor();
}

async function at(path: string) {
    await page.waitForFunction((expected) => window.__loc === expected, path);
    expect(await page.evaluate(() => window.__loc)).toBe(path);
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [{
        name: "prime-tools-alias",
        setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/prime-tools-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-tools-"));
    const bundlePath = join(bundleDir, "harness.js");
    await Bun.write(bundlePath, await build.outputs[0].text());
    const css = (await Promise.all(["index.css", "styles/printfilm.css", "App.css", "styles/toiv-skin.css"].map((file) => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            if (request.method === "POST" && (path === "/api/generate/txt2img" || path === "/api/generate/txt2video")) {
                const body = await request.json() as Record<string, unknown>;
                posts.push({ path, body });
                activePrompt = path.endsWith("txt2img") ? "job-image" : "job-video";
                return Response.json({ prompt_id: activePrompt, seed: 42 });
            }
            if (path === "/api/jobs") {
                const result = activePrompt === "job-video" ? "/api/videos/out.mp4" : "/api/images/out.png";
                return Response.json([{ prompt_id: activePrompt, status: "done", results: [result], error: "" }]);
            }
            if (path === "/api/images/out.png") {
                return new Response(PNG, { headers: { "Content-Type": "image/png" } });
            }
            if (path === "/harness.js") return new Response(Bun.file(bundlePath), { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors.length = 0;
    posts.length = 0;
    activePrompt = "";
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(4000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "test-only-session"));
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

test("the tools centre lists the two runnable tools and marks the rest as upcoming", async () => {
    await visit("/tools");
    await page.getByRole("heading", { name: "工具", exact: true }).waitFor();
    expect(await page.getByRole("link", { name: /文生图/ }).count()).toBe(1);
    expect(await page.getByRole("link", { name: /文生视频/ }).count()).toBe(1);
    expect(await page.locator("article.toiv-tool-card.is-soon").count()).toBe(4);
    expect(await page.locator("article.toiv-tool-card.is-soon").getByText("即将开放", { exact: true }).count()).toBe(4);
});

test("txt2img submits real generation fields and reveals the finished image", async () => {
    await visit("/tools/t2i");
    await page.getByRole("heading", { name: "文生图", exact: true }).waitFor();
    await page.getByLabel("提示词", { exact: true }).fill("雨夜街口，霓虹反射");
    await page.getByRole("radio", { name: "16:9 横屏" }).click();
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await page.locator(".toiv-tool-status.is-done").waitFor();
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/generate/txt2img");
    expect(posts[0].body).toMatchObject({ positive: "雨夜街口，霓虹反射", width: 1024, height: 576 });
    const image = page.getByRole("img", { name: "文生图结果 1" });
    await image.waitFor();
    const src = await image.getAttribute("src");
    expect(src).toContain("/api/images/out.png");
    expect(src).toContain("token=test-only-session");
    expect(await page.getByRole("link", { name: "打开原图", exact: true }).count()).toBe(1);
    await at("/tools/t2i");
});

test("an empty prompt is refused without calling the backend", async () => {
    await visit("/tools/t2i");
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("请先写提示词");
    expect(posts).toHaveLength(0);
});

test("txt2video maps ratio and duration before polling the job", async () => {
    await visit("/tools/t2v");
    await page.getByRole("heading", { name: "文生视频", exact: true }).waitFor();
    await page.getByLabel("提示词", { exact: true }).fill("镜头缓慢推近，雨停");
    await page.getByRole("radio", { name: "9:16 竖屏" }).click();
    await page.getByRole("radio", { name: "长 6 秒" }).click();
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await page.locator(".toiv-tool-status.is-done").waitFor();
    expect(posts[0]).toMatchObject({ path: "/api/generate/txt2video" });
    expect(posts[0].body).toMatchObject({ positive: "镜头缓慢推近，雨停", width: 576, height: 1024, length: 97, fps: 16 });
    await page.getByRole("link", { name: "打开原片", exact: true }).waitFor();
});

test("unknown tool ids fall back to the tools centre", async () => {
    await visit("/tools/nope");
    await at("/tools");
    await page.getByRole("heading", { name: "工具", exact: true }).waitFor();
});
