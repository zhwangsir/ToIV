import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// P2-9 创作台导出下拉真实组件浏览器证据:真实 StudioExportMenu + 真实 client(axios)
// 直连本地 mock API(不连真实后端/GPU)。暗色 + 完整 CSS,验证菜单展开(剪映/EDL/
// FCPXML/多轨包)、成功回执(文件名+缺素材/时长计数)、422 JSON 错误与无成片禁用。
const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-e-export");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

const EDL_BODY = "TITLE: 雨夜\nFCM: NON-DROP FRAME\n";
const FCPXML_BODY = '<?xml version="1.0"?><xmeml version="1.9"/>';
const ZIP_BYTES = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/studio-export-menu-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({
                DEV: false, PROD: true, MODE: "production", BASE_URL: "/",
                VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "",
                VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test",
            }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const extractedCss = (await Promise.all(build.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()))).join("\n");
    const sources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-local-overrides.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(sources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    const styles = [sources[0], sources[1], tailwindCss.css, sources[3], sources[4], extractedCss].join("\n");

    const json = (detail: string, status: number) =>
        new Response(JSON.stringify({ detail }), { status, headers: { "Content-Type": "application/json" } });

    server = Bun.serve({
        port: 0,
        fetch: (request) => {
            const url = new URL(request.url);
            if (url.pathname === "/harness.js") {
                return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            }
            const match = /^\/api\/studio\/projects\/([^/]+)\/export\/([^/]+)$/.exec(url.pathname);
            if (match) {
                const [, pid, kind] = match;
                if (pid === "p-err") return json("缺少成片片段，无法导出", 422);
                if (pid === "p-none") return json("缺少成片片段，无法导出", 422);
                const commonHeaders = {
                    "X-Toiv-Export-Format": "toiv_multitrack_export_v1",
                    "X-Toiv-Missing-Assets": "2",
                    "X-Toiv-Duration-Issues": "1",
                };
                if (kind === "edl") {
                    return new Response(EDL_BODY, {
                        headers: {
                            "Content-Type": "text/plain; charset=utf-8",
                            "Content-Disposition": "attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C.edl",
                            ...commonHeaders,
                        },
                    });
                }
                if (kind === "fcpxml") {
                    return new Response(FCPXML_BODY, {
                        headers: {
                            "Content-Type": "application/x-fcpxml",
                            "Content-Disposition": 'attachment; filename="p-ok.fcpxml"',
                            ...commonHeaders,
                        },
                    });
                }
                if (kind === "jianying") {
                    return new Response(ZIP_BYTES, {
                        headers: {
                            "Content-Type": "application/zip",
                            "Content-Disposition": "attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C_jianying.zip",
                            "X-Toiv-Draft-Id": "draft-1",
                            "X-Toiv-Draft-Format": "toiv_jianying_draft_v1",
                        },
                    });
                }
                return new Response(ZIP_BYTES, {
                    headers: {
                        "Content-Type": "application/zip",
                        "Content-Disposition": "attachment; filename*=UTF-8''%E9%9B%A8%E5%A4%9C_multitrack.zip",
                        ...commonHeaders,
                        "X-Toiv-Video-Clips": "3",
                    },
                });
            }
            return new Response(
                `<html class="dark"><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`,
                { headers: { "Content-Type": "text/html" } },
            );
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (error) => console.log("PAGEERROR:", error.message.slice(0, 300)));
    await page.goto(server.url.href);
    await page.getByTestId("export-ready").waitFor({ state: "visible" });
    return page;
}

test("导出下拉展开:剪映草稿/EDL 剪辑表/FCPXML 工程/多轨导出包(暗色)", async () => {
    const page = await openPage();
    const trigger = page.getByTestId("export-ready").getByRole("button", { name: "导出" });
    await trigger.click();
    for (const label of ["剪映草稿", "EDL 剪辑表", "FCPXML 工程", "多轨导出包"]) {
        await page.getByRole("menuitem", { name: label }).waitFor({ state: "visible" });
        expect(await page.getByRole("menuitem", { name: label }).isVisible(), label).toBe(true);
    }
    await page.screenshot({ path: "test-results/production-e-export/export-menu-dark.png", animations: "disabled", fullPage: true });
    await page.close();
}, 30_000);

test("多轨导出成功:显示文件名与缺素材/时长问题计数(问题不伪装成成功)", async () => {
    const page = await openPage();
    await page.getByTestId("export-ready").getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "多轨导出包" }).click();
    const panel = page.getByTestId("export-ready");
    await panel.getByText("已下载 雨夜_multitrack.zip").waitFor({ state: "visible" });
    const msg = panel.locator("p", { hasText: "已下载 雨夜_multitrack.zip" });
    expect(await msg.textContent()).toContain("2 处缺素材");
    expect(await msg.textContent()).toContain("1 处时长问题");
    expect((await msg.getAttribute("class")) ?? "").toContain("text-[var(--warning)]");
    await page.screenshot({ path: "test-results/production-e-export/export-success-issues-dark.png", animations: "disabled", fullPage: true });
    await page.close();
}, 30_000);

test("导出失败:422 JSON detail 透出为用户可读错误", async () => {
    const page = await openPage();
    await page.getByTestId("export-error").getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "EDL 剪辑表" }).click();
    const err = page.getByTestId("export-error").getByText("缺少成片片段，无法导出");
    await err.waitFor({ state: "visible" });
    expect(await err.isVisible()).toBe(true);
    await page.screenshot({ path: "test-results/production-e-export/export-error-dark.png", animations: "disabled", fullPage: true });
    await page.close();
}, 30_000);

test("无成片片段:导出禁用并提示先完成 final_clip", async () => {
    const page = await openPage();
    const empty = page.getByTestId("export-empty");
    const trigger = empty.getByRole("button", { name: "导出" });
    expect(await trigger.isDisabled()).toBe(true);
    await empty.getByText("暂无成片片段，请先完成 final_clip（或合成成片）").waitFor({ state: "visible" });
    await page.screenshot({ path: "test-results/production-e-export/export-disabled-dark.png", animations: "disabled", fullPage: true });
    await page.close();
}, 30_000);

test("剪映动作保留:导出剪映草稿 ZIP", async () => {
    const page = await openPage();
    await page.getByTestId("export-ready").getByRole("button", { name: "导出" }).click();
    await page.getByRole("menuitem", { name: "剪映草稿" }).click();
    const panel = page.getByTestId("export-ready");
    await panel.getByText("已下载 雨夜_jianying.zip").waitFor({ state: "visible" });
    expect(await panel.getByText(/toiv_jianying_draft_v1/).first().isVisible()).toBe(true);
    await page.close();
}, 30_000);
