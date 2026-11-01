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
let capabilitiesDown = false;
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");

const CAPABILITIES = {
    schema_version: 1,
    tools: {
        image: {
            id: "image", label: "文生图", engine_id: "txt2img", engine_label: "文生图",
            route: "/api/generate/txt2img", available: true, unavailable_reason: null,
            model_param: "ckpt_name",
            models: [
                { value: "", label: "平台默认底模", default: true, nsfw: false, desc: "" },
                { value: "sdxl.safetensors", label: "SDXL 写实", default: false, nsfw: false, desc: "通用写实底模" },
            ],
            sizes: [
                { value: "1:1", label: "1:1 方形", width: 1024, height: 1024, available: true, reason: null },
                { value: "16:9", label: "16:9 横屏", width: 1024, height: 576, available: true, reason: null },
                { value: "9:16", label: "9:16 竖屏", width: 576, height: 1024, available: true, reason: null },
                { value: "2:1", label: "2:1 宽幅", width: 1024, height: 512, available: true, reason: null },
            ],
            size_hint: "比例限 1:2~2:1",
            duration_param: null, duration_hint: "", durations: [],
            limits: {}, affects: ["工具中心 · 文生图"],
        },
        video: {
            id: "video", label: "文生视频", engine_id: "h3-t2v", engine_label: "MiniMax H3 文生视频",
            route: "/api/h3/t2v", available: true, unavailable_reason: null,
            model_param: null, models: [],
            sizes: [
                { value: "1:1", label: "1:1 方形", width: 1344, height: 1344, available: true, reason: null },
                { value: "16:9", label: "16:9 横屏", width: 1344, height: 768, available: true, reason: null },
                { value: "9:16", label: "9:16 竖屏", width: 768, height: 1344, available: true, reason: null },
                { value: "2:1", label: "2:1 宽幅", width: 1344, height: 672, available: false, reason: "超出引擎宽高比范围 9:16–16:9(当前 2:1)" },
            ],
            size_hint: "32 对齐,比例限 9:16~16:9",
            duration_param: "duration", duration_hint: "原生单段约 15 秒",
            durations: ["4", "5", "6", "8", "10", "15"].map((value) => ({
                value, label: `${value} 秒`, seconds: Number(value), default: value === "5",
                available: value !== "15", reason: value === "15" ? "超过单段显存上限" : null,
            })),
            limits: {}, affects: ["工具中心 · 文生视频"],
        },
    },
    slots: [],
    issues: [],
};

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
            if (path === "/api/models/capabilities") {
                if (capabilitiesDown) {
                    return Response.json({
                        ...CAPABILITIES,
                        tools: {
                            image: { ...CAPABILITIES.tools.image, available: false, unavailable_reason: "worker 不可达", sizes: [] },
                            video: { ...CAPABILITIES.tools.video, available: false, unavailable_reason: "H3 实例不可达", sizes: [] },
                        },
                        issues: [{ id: "tool-image-unavailable", title: "文生图暂不可用", reason: "worker 不可达", affects: ["工具中心 · 文生图"] }],
                    });
                }
                return Response.json(CAPABILITIES);
            }
            if (request.method === "POST" && (path === "/api/generate/txt2img" || path === "/api/h3/t2v")) {
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
    capabilitiesDown = false;
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

test("txt2img submits capability-derived size and model, then reveals the finished image", async () => {
    await visit("/tools/t2i");
    await page.getByRole("heading", { name: "文生图", exact: true }).waitFor();
    await page.getByLabel("提示词", { exact: true }).fill("雨夜街口，霓虹反射");
    await page.getByLabel("模型", { exact: true }).selectOption("sdxl.safetensors");
    await page.getByRole("radio", { name: "16:9 横屏" }).click();
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    await page.locator(".toiv-tool-status.is-done").waitFor();
    expect(posts).toHaveLength(1);
    expect(posts[0].path).toBe("/api/generate/txt2img");
    expect(posts[0].body).toMatchObject({
        positive: "雨夜街口，霓虹反射", ckpt_name: "sdxl.safetensors", width: 1024, height: 576,
    });
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
    await page.getByRole("radio", { name: "1:1 方形" }).waitFor();
    await page.getByRole("button", { name: "生成图片", exact: true }).click();
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("请先写提示词");
    expect(posts).toHaveLength(0);
});

test("txt2video uses H3 duration seconds and disables out-of-range ratios with a reason", async () => {
    await visit("/tools/t2v");
    await page.getByRole("heading", { name: "文生视频", exact: true }).waitFor();
    const wide = page.getByRole("radio", { name: /2:1 宽幅/ });
    expect(await wide.isDisabled()).toBe(true);
    await page.getByText("2:1 宽幅：超出引擎宽高比范围 9:16–16:9").waitFor();
    const tooLong = page.getByRole("radio", { name: /15 秒/ });
    expect(await tooLong.isDisabled()).toBe(true);
    await page.getByText("15 秒：超过单段显存上限").waitFor();
    await page.getByLabel("提示词", { exact: true }).fill("镜头缓慢推近，雨停");
    await page.getByRole("radio", { name: "9:16 竖屏" }).click();
    await page.getByRole("radio", { name: "6 秒" }).click();
    await page.getByRole("button", { name: "生成视频", exact: true }).click();
    await page.locator(".toiv-tool-status.is-done").waitFor();
    expect(posts[0]).toMatchObject({ path: "/api/h3/t2v" });
    expect(posts[0].body).toMatchObject({ positive: "镜头缓慢推近，雨停", width: 768, height: 1344, duration_sec: 6 });
    await page.getByRole("link", { name: "打开原片", exact: true }).waitFor();
});

test("an unavailable engine shows its reason and blocks submission", async () => {
    capabilitiesDown = true;
    await visit("/tools/t2i");
    const alert = page.getByRole("alert");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("worker 不可达");
    expect(await page.getByRole("button", { name: "生成图片", exact: true }).isDisabled()).toBe(true);
});

test("unknown tool ids fall back to the tools centre", async () => {
    await visit("/tools/nope");
    await at("/tools");
    await page.getByRole("heading", { name: "工具", exact: true }).waitFor();
});
