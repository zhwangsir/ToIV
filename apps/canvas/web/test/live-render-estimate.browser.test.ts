import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const webRoot = resolve(import.meta.dir, "..");
const apiTests = resolve(webRoot, "../../api/tests");
const screenshots = resolve(webRoot, "test-results/production-d0");
let browser: Browser;
let staticServer: ReturnType<typeof Bun.serve>;
let apiProcess: ChildProcess;
let apiUrl = "";
let testToken = "";
let apiLog = "";
let apiTempDir = "";

async function startApi(): Promise<void> {
    const pythonExecutable = process.env.TOIV_TEST_PYTHON ?? resolve(apiTests, "../.venv/bin/python");
    apiTempDir = mkdtempSync(join(tmpdir(), "toiv-d0-live-parent-"));
    apiProcess = spawn(pythonExecutable, ["live_estimate_server.py"], {
        cwd: apiTests,
        env: { ...process.env, PYTHONPATH: "..", TOIV_D0_TEST_TEMP_DIR: apiTempDir },
        stdio: ["ignore", "pipe", "pipe"],
    });
    apiProcess.stderr?.on("data", (chunk) => { apiLog += String(chunk); });
    apiProcess.stdout?.on("data", (chunk) => { apiLog += String(chunk); });
    await new Promise<void>((resolveReady, rejectReady) => {
        const timeout = setTimeout(() => rejectReady(new Error(`D0 FastAPI 启动超时\n${apiLog}`)), 60_000);
        apiProcess.once("error", (error) => {
            clearTimeout(timeout);
            rejectReady(new Error(`D0 FastAPI 无法启动: ${error.message}\n${apiLog}`));
        });
        let stdout = "";
        apiProcess.stdout?.on("data", (chunk) => {
            stdout += String(chunk);
            const line = stdout.split("\n").find((value) => value.trim().startsWith("{"));
            if (!line) return;
            try {
                const ready = JSON.parse(line) as { url: string; token: string };
                apiUrl = ready.url;
                testToken = ready.token;
                clearTimeout(timeout);
                resolveReady();
            } catch {
                return;
            }
        });
        apiProcess.once("exit", (code) => {
            clearTimeout(timeout);
            rejectReady(new Error(`D0 FastAPI 提前退出 (${code})\n${apiLog}`));
        });
    });
}

beforeAll(async () => {
    mkdirSync(screenshots, { recursive: true });
    await startApi();
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/live-render-estimate-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test" }),
        },
        plugins: [{ name: "live-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const sources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
        Bun.file(resolve(webRoot, "src/components/toiv/render-cost-estimate.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(sources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    const styles = [sources[0], sources[1], tailwindCss.css, sources[3], sources[4]].join("\n");
    const js = await build.outputs[0].text();
    staticServer = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            if (url.pathname.startsWith("/api/")) {
                const headers = new Headers(request.headers);
                headers.delete("host");
                headers.delete("content-length");
                headers.set("connection", "close");
                try {
                    const upstream = await fetch(`${apiUrl}${url.pathname}${url.search}`, {
                        method: request.method,
                        headers,
                        body: request.method === "GET" || request.method === "HEAD" ? undefined : await request.arrayBuffer(),
                    });
                    const responseHeaders = new Headers(upstream.headers);
                    responseHeaders.delete("content-encoding");
                    responseHeaders.delete("content-length");
                    responseHeaders.delete("transfer-encoding");
                    return new Response(upstream.body, {
                        status: upstream.status,
                        statusText: upstream.statusText,
                        headers: responseHeaders,
                    });
                } catch (error) {
                    console.error(`[live proxy] ${request.method} ${url.pathname}`, error);
                    return Response.json({ detail: "D0 test proxy upstream failure" }, { status: 502 });
                }
            }
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            return new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    staticServer?.stop(true);
    if (apiProcess && apiProcess.exitCode === null) {
        const exited = new Promise<void>((resolveExit) => apiProcess.once("exit", () => resolveExit()));
        apiProcess.kill("SIGTERM");
        await Promise.race([exited, new Promise<void>((resolveExit) => setTimeout(resolveExit, 5_000))]);
        if (apiProcess.exitCode === null) apiProcess.kill("SIGKILL");
    }
    if (apiTempDir) rmSync(apiTempDir, { recursive: true, force: true });
});

async function openLive(mode: "direct" | "keyframe"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    page.on("pageerror", (error) => console.error(`[live ${mode} pageerror]`, error.message));
    page.on("requestfailed", (request) => console.error(`[live ${mode} requestfailed]`, request.method(), new URL(request.url()).pathname, request.failure()));
    page.on("response", (response) => {
        const path = new URL(response.url()).pathname;
        if (response.status() >= 400 && !(mode === "keyframe" && path.endsWith("/render"))) {
            console.error(`[live ${mode}] ${response.request().method()} ${path} → ${response.status()}`);
        }
    });
    await page.addInitScript((token) => window.localStorage.setItem("toiv_token", token), testToken);
    await page.goto(`${staticServer.url.href}?mode=${mode}`);
    try {
        await page.getByTestId("live-ready").waitFor({ state: "visible", timeout: 20_000 });
    } catch (error) {
        console.error(`[live ${mode} main]`, await page.locator("main").textContent());
        throw error;
    }
    return page;
}

test("真实 FastAPI：storyboard 阻断→真实阶段流转→未定价放行→job_id→detail rendered", async () => {
    const page = await openLive("direct");
    const confirm = page.getByRole("button", { name: "确认并开始整批渲染" });
    await page.locator(".render-cost-estimate__blocker").first().waitFor({ state: "visible" });
    expect(await confirm.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "真实确认 script / 跳过 assets / 确认 storyboard" }).click();
    await page.waitForFunction(() => {
        const button = [...document.querySelectorAll("button")].find((node) => node.textContent?.includes("确认并开始整批渲染"));
        return button instanceof HTMLButtonElement && !button.disabled;
    }, undefined, { timeout: 15_000 });
    await page.getByText("未配置费率，不代表免费", { exact: false }).waitFor({ state: "visible" });
    await page.getByText("未启用预算", { exact: false }).waitFor({ state: "visible" });
    expect(await page.locator(".render-cost-estimate__work").textContent()).toContain("待渲染 1 镜");
    await page.screenshot({ path: "test-results/production-d0/live-batch-estimate.png", fullPage: true, animations: "disabled" });
    await confirm.click();
    await page.getByTestId("live-job-id").waitFor({ state: "visible", timeout: 10_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="live-job-status"]')?.textContent === "done", undefined, { timeout: 15_000 });
    await page.waitForFunction(() => document.querySelector('[data-testid="live-shot-status"]')?.textContent === "rendered", undefined, { timeout: 15_000 });
    expect(await page.getByTestId("live-job-id").textContent()).not.toBe("");
    await page.screenshot({ path: "test-results/production-d0/live-batch-confirmed.png", fullPage: true, animations: "disabled" });
    await page.close();
}, 45_000);

test("真实 FastAPI：keyframe 缺图预估与真实提交均阻断，且不创建任务", async () => {
    const page = await openLive("keyframe");
    const confirm = page.getByRole("button", { name: "确认并开始整批渲染" });
    await page.locator(".render-cost-estimate__blocker").first().waitFor({ state: "visible" });
    await page.getByText("关键帧", { exact: false }).first().waitFor({ state: "visible" });
    expect(await confirm.isDisabled()).toBe(true);
    await page.getByRole("button", { name: "验证真实提交阻断" }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="live-submit-status"]')?.textContent === "422", undefined, { timeout: 10_000 });
    expect(await page.getByTestId("live-job-delta").textContent()).toBe("0");
    await page.screenshot({ path: "test-results/production-d0/live-keyframe-blocked.png", fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);
