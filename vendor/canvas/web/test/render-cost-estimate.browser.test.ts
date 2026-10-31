import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

import { batchEstimate, shotEstimate } from "./fixtures/render-estimate-fixtures";

const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-d0");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

async function visible(page: Page, text: string): Promise<void> {
    await page.getByText(text, { exact: false }).first().waitFor({ state: "visible", timeout: 10_000 });
}

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/render-cost-estimate-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test" }),
        },
        plugins: [{ name: "d0-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({
                contents: `
                    const take = async (call, fallback) => {
                        window.__d0Calls.push(call);
                        const item = window.__d0Queue.length ? window.__d0Queue.shift() : fallback;
                        if (item === "pending") return new Promise((resolve) => window.__d0Pending.push({
                            call,
                            resolve: (value) => {
                                window.__d0Calls.push({ kind: "estimate-resolved", sid: call.sid, pid: call.pid });
                                resolve(value);
                            },
                        }));
                        if (item && item.__error) {
                            const error = new Error("estimate failed");
                            error.response = { status: item.__error.status, data: { detail: item.__error.detail } };
                            throw error;
                        }
                        return item;
                    };
                    export async function estimateBatchRender(pid, body) {
                        return take({ kind: "estimate-batch", pid, body }, {
                            schema: "toiv_render_estimate_v1", scope: "batch", project_id: pid, allowed: true,
                            blockers: [], warnings: [], input_fingerprint: "default-batch",
                            work: { shot_count: 1, candidate_upper_bound: 2, requested_duration_sec: 6, requested_frame_count: 144, pixel_frame_upper_bound: 149299200, image_motion_count: 0 },
                            items: [{ shot_id: "shot-1", idx: 1, engine: "h3", pipeline: body.pipeline, render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frames_upper_bound: 149299200 }],
                            pricing: { status: "unpriced", currency: null, total: null, rate_source: "none", unknowns: [] },
                            budget: { status: "unpriced", limit: null, currency: null },
                        });
                    }
                    export async function estimateShotRender(sid, body) {
                        return take({ kind: "estimate-shot", sid, body }, {
                            schema: "toiv_render_estimate_v1", scope: "shot", project_id: "p1", shot_id: sid, allowed: true,
                            blockers: [], warnings: [], input_fingerprint: "default-shot",
                            work: { shot_count: 1, candidate_upper_bound: 2, requested_duration_sec: 6, requested_frame_count: 144, pixel_frame_upper_bound: 149299200, image_motion_count: 0 },
                            items: [{ shot_id: sid, idx: 1, engine: "h3", pipeline: body.pipeline, render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frames_upper_bound: 149299200 }],
                            pricing: { status: "unpriced", currency: null, total: null, rate_source: "none", unknowns: [] },
                            budget: { status: "unpriced", limit: null, currency: null },
                        });
                    }
                    export async function saveStudioShots() { return undefined; }
                    export async function fetchShotRevisions() { return { revisions: [] }; }
                    export async function fetchShotRevisionDiff() { return null; }
                    export async function rollbackShotRevision() { return null; }
                    export async function pickShotCandidate(sid) { return { id: sid }; }
                    export async function createRecipeFromShot() { return null; }
                    export async function fetchRecipes() { return []; }
                    export async function fetchRecipe() { return null; }
                    export async function patchRecipe() { return null; }
                    export async function cloneRecipe() { return null; }
                    export async function setDefaultRecipe() { return null; }
                    export async function deleteRecipe() { return null; }
                    export async function exportRecipe() { return null; }
                    export async function importRecipe() { return null; }
                    export async function fetchRecipeDiff() { return null; }
                    export async function applyRecipe() { return null; }
                `,
                loader: "ts",
            }));
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
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(mode: "batch" | "single" = "batch"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1000, height: 900 } });
    await page.goto(`${server.url.href}?mode=${mode}`);
    await page.locator("main").waitFor({ state: "visible" });
    return page;
}

async function queue(page: Page, items: unknown[]): Promise<void> {
    await page.evaluate((next) => { window.__d0Queue = next; }, items);
}

async function calls(page: Page): Promise<{ kind: string; [key: string]: unknown }[]> {
    return page.evaluate(() => window.__d0Calls ?? []);
}

test("批量未定价可确认：工作量、少量逐镜摘要、金额说明与真实确认回调", async () => {
    const page = await openPage();
    await queue(page, [batchEstimate()]);
    await page.getByRole("button", { name: "打开整批确认" }).click();
    await visible(page, "待渲染 3 镜");
    await visible(page, "候选上限 6");
    await visible(page, "18 秒 / 432 帧");
    await visible(page, "未配置费率，不代表免费");
    await visible(page, "h3.rate");
    expect(await page.locator(".render-cost-estimate__price strong").textContent()).toBe("未配置费率");
    const confirm = page.getByRole("button", { name: "确认并开始整批渲染" });
    expect(await confirm.isEnabled()).toBe(true);
    await page.screenshot({ path: "test-results/production-d0/batch-unpriced-allowed.png", fullPage: true, animations: "disabled" });
    await confirm.click();
    expect((await calls(page)).some((call) => call.kind === "confirm")).toBe(true);
    await page.close();
}, 30_000);

test("批量定价与预算超限：Decimal 原样、allowed=false 禁止提交", async () => {
    const page = await openPage();
    await queue(page, [batchEstimate({
        allowed: false,
        blockers: [{ code: "BUDGET_EXCEEDED", message: "项目预算不足" }],
        pricing: { status: "estimated", currency: "CNY", total: "00012.340090", rate_source: "studio", unknowns: [] },
        budget: { status: "exceeded", limit: "10.000000", currency: "CNY" },
    })]);
    await page.getByRole("button", { name: "打开整批确认" }).click();
    await visible(page, "00012.340090 CNY");
    await visible(page, "预算超限");
    await visible(page, "10.000000 CNY");
    await visible(page, "项目预算不足");
    expect(await page.getByRole("button", { name: "确认并开始整批渲染" }).isDisabled()).toBe(true);
    await page.screenshot({ path: "test-results/production-d0/batch-priced-budget-exceeded.png", fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

test("配置与 detail 变更重新请求，慢响应和项目切换不覆盖新结果", async () => {
    const page = await openPage();
    await queue(page, [batchEstimate(), batchEstimate({ input_fingerprint: "turbo-fp" }), batchEstimate({ input_fingerprint: "detail-fp" })]);
    await page.getByRole("button", { name: "打开整批确认" }).click();
    await visible(page, "batch-fp-1");
    await page.getByLabel("加速").selectOption("turbo");
    await visible(page, "turbo-fp");
    await page.getByRole("button", { name: "修改分镜" }).click();
    await visible(page, "detail-fp");
    const estimateCalls = (await calls(page)).filter((call) => call.kind === "estimate-batch");
    expect(estimateCalls).toHaveLength(3);
    expect(estimateCalls[1].body).toMatchObject({ accel: "turbo" });
    await page.close();

    const slow = await openPage();
    await queue(slow, ["pending", "pending"]);
    await slow.getByRole("button", { name: "打开整批确认" }).click();
    await slow.getByLabel("项目").selectOption("p2");
    await slow.waitForFunction(() => (window.__d0Pending?.length ?? 0) === 2);
    await slow.evaluate((response) => { window.__d0Pending?.[1].resolve(response); }, batchEstimate({ project_id: "p2", input_fingerprint: "new-p2" }));
    await visible(slow, "new-p2");
    await slow.evaluate((response) => { window.__d0Pending?.[0].resolve(response); }, batchEstimate({ project_id: "p1", input_fingerprint: "old-p1" }));
    await visible(slow, "new-p2");
    expect(await slow.getByText("old-p1", { exact: false }).count()).toBe(0);
    expect(await slow.getByTestId("render-cost-estimate").getAttribute("data-project-id")).toBe("p2");
    await slow.close();
}, 30_000);

test("失败不可当免费放行，可重试；409 提供阶段定位入口", async () => {
    const page = await openPage();
    await queue(page, [
        { __error: { status: 503, detail: "PRICING_REQUIRED: 报价暂不可用" } },
        batchEstimate({ input_fingerprint: "retry-ok" }),
    ]);
    await page.getByRole("button", { name: "打开整批确认" }).click();
    await visible(page, "PRICING_REQUIRED: 报价暂不可用");
    expect(await page.getByRole("button", { name: "确认并开始整批渲染" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "重试" }).click();
    await visible(page, "retry-ok");
    expect(await page.getByRole("button", { name: "确认并开始整批渲染" }).isEnabled()).toBe(true);
    await page.close();

    const conflict = await openPage();
    await queue(conflict, [{ __error: { status: 409, detail: "STAGE_REQUIRED: storyboard 未确认" } }]);
    await conflict.getByRole("button", { name: "打开整批确认" }).click();
    await visible(conflict, "STAGE_REQUIRED: storyboard 未确认");
    await conflict.getByRole("button", { name: "处理阶段阻断" }).click();
    expect(await conflict.evaluate(() => window.__d0Stage)).toBe("storyboard");
    await conflict.close();
}, 30_000);

test("单镜按需预估 keyframe 阻断：不调用 onRender，提供分镜定位并截图", async () => {
    const page = await openPage("single");
    expect((await calls(page)).filter((call) => call.kind === "estimate-shot")).toHaveLength(0);
    const blocked = shotEstimate({ allowed: false, blockers: [{ code: "KEYFRAME_REQUIRED", message: "请先采用关键帧" }] });
    await queue(page, [blocked, blocked]);
    await page.getByRole("button", { name: "成本预估" }).click();
    await visible(page, "请先采用关键帧");
    await visible(page, "未配置费率，不代表免费");
    await page.getByRole("button", { name: "渲染", exact: true }).click();
    expect((await calls(page)).some((call) => call.kind === "render")).toBe(false);
    await page.getByRole("button", { name: "前往分镜准备" }).click();
    expect(await page.evaluate(() => window.__d0Keyframe)).toBe(true);
    await page.screenshot({ path: "test-results/production-d0/shot-keyframe-blocked.png", fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

test("单镜 allowed 后走原 onRender，真实 shot 参数进入预估；未保存编辑须先保存", async () => {
    const page = await openPage("single");
    await queue(page, [shotEstimate()]);
    await page.getByRole("button", { name: "渲染", exact: true }).click();
    await page.waitForFunction(() => (window.__d0Calls ?? []).some((call) => call.kind === "render"));
    const current = await calls(page);
    const estimate = current.find((call) => call.kind === "estimate-shot");
    expect(estimate?.body).toMatchObject({ video_model: "h3-shot", num_candidates: 3, ref_images: ["/character.png"], scene_images: ["/scene.png"] });
    expect(current.some((call) => call.kind === "render")).toBe(true);
    await page.getByRole("button", { name: "编辑提示语" }).click();
    await page.getByTestId("shot-revision-edit-textarea").fill("未保存的新提示");
    await page.getByRole("button", { name: "成本预估" }).click();
    await visible(page, "有未保存修改，请先保存再预估");
    expect((await calls(page)).filter((call) => call.kind === "estimate-shot")).toHaveLength(1);
    await page.close();
}, 30_000);

test("启用预算但未定价必须 allowed=false 且禁止确认", async () => {
    const page = await openPage();
    await queue(page, [batchEstimate({
        allowed: false,
        blockers: [{ code: "COST_UNPRICED", message: "启用预算前必须配置费率" }],
        budget: { status: "unpriced", limit: "20.00", currency: "CNY" },
    })]);
    await page.getByRole("button", { name: "打开整批确认" }).click();
    await visible(page, "启用预算前必须配置费率");
    await visible(page, "未配置费率，不代表免费");
    expect(await page.getByRole("button", { name: "确认并开始整批渲染" }).isDisabled()).toBe(true);
    await page.close();
}, 30_000);

test("首次成功后再次渲染仍重新 estimate，不凭旧 allowed 直接提交", async () => {
    const page = await openPage("single");
    await queue(page, [shotEstimate({ input_fingerprint: "render-1" }), shotEstimate({ input_fingerprint: "render-2" })]);
    const renderButton = page.getByRole("button", { name: "渲染", exact: true });
    await renderButton.click();
    await page.waitForFunction(() => (window.__d0Calls ?? []).filter((call) => call.kind === "render").length === 1);
    await renderButton.click();
    await page.waitForFunction(() => (window.__d0Calls ?? []).filter((call) => call.kind === "estimate-shot").length === 2, undefined, { timeout: 2_000 });
    await page.waitForFunction(() => (window.__d0Calls ?? []).filter((call) => call.kind === "render").length === 2);
    const estimateCalls = (await calls(page)).filter((call) => call.kind === "estimate-shot");
    expect(estimateCalls).toHaveLength(2);
    await page.close();
}, 30_000);

for (const upstreamButton of ["更换修订", "更换关键帧"]) {
    test(`单镜预估在途时${upstreamButton}使旧请求失效且不触发 onRender`, async () => {
        const page = await openPage("single");
        await queue(page, ["pending", "pending"]);
        await page.getByRole("button", { name: "渲染", exact: true }).click();
        await page.waitForFunction(() => (window.__d0Pending?.length ?? 0) === 1);
        await page.getByRole("button", { name: upstreamButton }).click();
        await page.waitForFunction(() => (window.__d0Pending?.length ?? 0) === 2, undefined, { timeout: 2_000 });
        await page.evaluate((response) => {
            window.__d0Pending?.[0].resolve(response);
            window.__d0Pending?.[1].resolve(response);
        }, shotEstimate());
        await page.waitForFunction(() => (window.__d0Calls ?? []).filter((call) => call.kind === "estimate-resolved").length === 2);
        expect((await calls(page)).some((call) => call.kind === "render")).toBe(false);
        await page.close();
    }, 30_000);
}

test("单镜预估在途开始未保存编辑，旧响应不得触发 onRender", async () => {
    const page = await openPage("single");
    await queue(page, ["pending"]);
    await page.getByRole("button", { name: "渲染", exact: true }).click();
    await page.waitForFunction(() => (window.__d0Pending?.length ?? 0) === 1);
    await page.getByRole("button", { name: "编辑提示语" }).click();
    await page.getByTestId("shot-revision-edit-textarea").fill("在途时发生的新编辑");
    await page.evaluate((response) => { window.__d0Pending?.[0].resolve(response); }, shotEstimate());
    await page.waitForFunction(() => (window.__d0Calls ?? []).some((call) => call.kind === "estimate-resolved"));
    expect((await calls(page)).some((call) => call.kind === "render")).toBe(false);
    await page.close();
}, 30_000);

test("单镜预估在途连点只发一次请求，成功后只提交一次渲染", async () => {
    const page = await openPage("single");
    await queue(page, ["pending", "pending"]);
    await page.getByRole("button", { name: "渲染", exact: true }).dblclick();
    await page.waitForFunction(() => (window.__d0Pending?.length ?? 0) >= 1);
    expect((await calls(page)).filter((call) => call.kind === "estimate-shot")).toHaveLength(1);
    await page.evaluate((response) => {
        const pending = window.__d0Pending?.splice(0) ?? [];
        for (const item of pending) item.resolve(response);
    }, shotEstimate());
    await page.waitForFunction(() => (window.__d0Calls ?? []).some((call) => call.kind === "render"));
    expect((await calls(page)).filter((call) => call.kind === "render")).toHaveLength(1);
    await page.close();
}, 30_000);
