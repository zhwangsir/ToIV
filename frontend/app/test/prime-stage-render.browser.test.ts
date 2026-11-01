import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let states: Record<string, { state: string; ready: boolean; blockers: string[] }>;
let revision: number;
let omitRevision: boolean;
let calls: { path: string; method: string; body: any }[];
let errors: string[];

const baseStates = () => ({
    script: { state: "confirmed", ready: true, blockers: [] },
    assets: { state: "skipped", ready: false, blockers: [] },
    storyboard: { state: "pending_confirmation", ready: true, blockers: [] },
    generate: { state: "draft", ready: false, blockers: ["镜01 视觉产物未就绪"] },
    voice: { state: "draft", ready: false, blockers: [] },
    timeline: { state: "draft", ready: false, blockers: [] },
});
const shots = () => [
    { id: "s1", prompt: "晨雾", camera: "STATIC", duration_sec: 6, status: "error", current_revision_id: "r1", beats: [], candidates: [] },
    { id: "s2", prompt: "睁眼", camera: "DOLLY IN", duration_sec: 4, status: "draft", current_revision_id: "r2", beats: [], candidates: [] },
];
const work = (scope: string) => ({
    shot_count: scope === "batch" ? 2 : 1,
    candidate_upper_bound: scope === "batch" ? 4 : 3,
    requested_duration_sec: 10, requested_frame_count: 240,
    pixel_frame_upper_bound: 100_000, image_motion_count: 0,
});
const estimate = (scope: "batch" | "shot", allowed = true) => ({
    schema: "toiv_render_estimate_v1", scope, project_id: "p1",
    ...(scope === "shot" ? { shot_id: "s1" } : {}),
    allowed,
    blockers: allowed ? [] : [{ code: "STORYBOARD_NOT_CONFIRMED", message: "分镜尚未确认", stage: "storyboard" }],
    warnings: allowed ? [] : ["确认故事板后可提交整批渲染"],
    input_fingerprint: allowed ? `${scope}-fingerprint-0001` : "blocked-fingerprint-0000",
    work: work(scope),
    items: scope === "batch" ? [
        { shot_id: "s1", idx: 0, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 6, frames: 144, pixel_frame_upper_bound: 50_000 },
        { shot_id: "s2", idx: 1, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 2, duration_sec: 4, frames: 96, pixel_frame_upper_bound: 50_000 },
    ] : [
        { shot_id: "s1", idx: 0, engine: "h3", pipeline: "ref2va", render_mode: "video", candidates: 3, duration_sec: 6, frames: 144, pixel_frame_upper_bound: 50_000 },
    ],
    pricing: { status: "estimated", currency: "CNY", total: "12.5000", unknowns: [] },
    budget: { status: "disabled", limit: null, currency: null },
});

beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/prime-editing-harness.tsx"], target: "browser", define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, BASE_URL: "/" }) } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"].map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (new URL(request.url).pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (new URL(request.url).pathname.startsWith("/api/")) return Response.json({ detail: "unmocked API" }, { status: 503 });
        return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 60_000);
beforeEach(async () => {
    states = baseStates(); revision = 7; omitRevision = false; calls = []; errors = [];
    page = await browser.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/api/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const body = request.postDataJSON();
        calls.push({ path, method, body });
        if (path === "/api/studio/projects/p1" && method === "GET") {
            await route.fulfill({ json: { id: "p1", title: "测试剧", shots: shots(), stage_states: states, ...(omitRevision ? {} : { stage_revision: revision }) } }); return;
        }
        if (path === "/api/studio/projects/p1/stage-transition" && method === "POST") {
            states[body.stage] = { ...states[body.stage], state: body.action === "confirm" ? "confirmed" : body.action === "skip" ? "skipped" : "needs_review" };
            revision += 1;
            await route.fulfill({ json: { project_id: "p1", stage: body.stage, stage_states: states, stage_revision: revision } }); return;
        }
        if (path === "/api/studio/projects/p1/render-estimate" && method === "POST") {
            await route.fulfill({ json: estimate("batch", states.storyboard.state === "confirmed") }); return;
        }
        if (path === "/api/studio/shots/s1/render-estimate" && method === "POST") {
            await route.fulfill({ json: estimate("shot") }); return;
        }
        if (path === "/api/studio/projects/p1/render" && method === "POST") {
            await route.fulfill({ status: 202, json: { job_id: "job-batch-abcdef123456", status: "queued", project_id: "p1", acceleration: "off", pipeline: "ref2va" } }); return;
        }
        if (path === "/api/studio/shots/s1/render" && method === "POST") {
            await route.fulfill({ json: { job_id: "job-shot-abcdef123456", prompt_id: "pr1", status: "queued", shot_id: "s1", acceleration: "off", pipeline: "ref2va" } }); return;
        }
        await route.fulfill({ status: 503, json: { detail: "unmocked API" } });
    });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); server?.stop(true); });
const goto = () => page.goto(`http://127.0.0.1:${server.port}/studio/p1`);
const notice = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });

test("blocked batch quote routes to the stage rail, then confirm and skip submit CAS baselines before an allowed render", async () => {
    await goto();
    await page.getByRole("button", { name: "分镜阶段 · 待确认" }).waitFor();
    await page.getByRole("button", { name: "整批渲染" }).click();
    const blocked = page.getByRole("dialog", { name: "渲染报价 · 整批" });
    await blocked.getByText("分镜尚未确认").waitFor();
    expect(await blocked.getByText(/STORYBOARD_NOT_CONFIRMED · 阶段 分镜/).count()).toBe(1);
    expect(await blocked.getByRole("button", { name: "确认并提交渲染" }).isDisabled()).toBe(true);
    expect(calls.filter(c => c.path === "/api/studio/projects/p1/render").length).toBe(0);

    await blocked.getByRole("button", { name: "去确认故事板" }).click();
    await blocked.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "确认阶段" }).click();
    await notice("阶段已确认").waitFor();
    expect(calls.filter(c => c.path.endsWith("/stage-transition")).map(c => c.body)).toEqual([
        { stage: "storyboard", action: "confirm", expected_stage_revision: 7 },
    ]);
    await page.getByRole("button", { name: "分镜阶段 · 已确认" }).waitFor();

    await page.getByRole("button", { name: "生成阶段 · 未开始" }).click();
    await page.getByRole("button", { name: "跳过…" }).click();
    const skip = page.getByRole("dialog", { name: "跳过生成阶段" });
    const confirmSkip = skip.getByRole("button", { name: "确认跳过" });
    expect(await confirmSkip.isDisabled()).toBe(true);
    await skip.getByLabel("跳过说明").fill("x");
    expect(await confirmSkip.isDisabled()).toBe(true);
    await skip.getByLabel("跳过说明").fill("本剧不做生成");
    await confirmSkip.click();
    await notice(/阶段已跳过/).waitFor();
    expect(calls.filter(c => c.path.endsWith("/stage-transition")).map(c => c.body)).toEqual([
        { stage: "storyboard", action: "confirm", expected_stage_revision: 7 },
        { stage: "generate", action: "skip", note: "本剧不做生成", expected_stage_revision: 8 },
    ]);
    await page.getByRole("button", { name: "生成阶段 · 已跳过" }).waitFor();

    await page.getByRole("button", { name: "整批渲染" }).click();
    const allowed = page.getByRole("dialog", { name: "渲染报价 · 整批" });
    await allowed.getByText("预估 12.5000 CNY").waitFor();
    expect(await allowed.getByText("2", { exact: true }).count()).toBeGreaterThan(0);
    expect(calls.filter(c => c.path === "/api/studio/projects/p1/render-estimate").map(c => c.body)).toEqual([
        { accel: "off", pipeline: "ref2va" },
        { accel: "off", pipeline: "ref2va" },
    ]);
    await allowed.getByRole("button", { name: "确认并提交渲染" }).click();
    await notice(/整批渲染已入后台 · 作业 job-batc/).waitFor();
    await allowed.waitFor({ state: "detached" });
    expect(calls.filter(c => c.path === "/api/studio/projects/p1/render").map(c => c.body)).toEqual([
        { accel: "off", pipeline: "ref2va", wait: false },
    ]);
    expect(errors).toEqual([]);
});

test("per-shot render quotes the chosen candidate count, submits asynchronously, and keeps the 30s re-confirm guard", async () => {
    await goto();
    const first = page.locator(".toiv-shot").nth(0);
    await first.getByLabel("镜01 候选数").selectOption("3");
    await first.getByRole("button", { name: "重试渲染" }).click();
    const dialog = page.getByRole("dialog", { name: "渲染报价 · 镜01" });
    await dialog.getByText("6s · 3 候选 · h3/ref2va").waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/render-estimate").map(c => c.body)).toEqual([
        { pipeline: "ref2va", accel: "off", num_candidates: 3, auto_pick: false },
    ]);
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/render").length).toBe(0);
    await dialog.getByRole("button", { name: "确认并提交渲染" }).click();
    await notice(/镜01 渲染已入后台 · 作业 job-shot/).waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/render").map(c => c.body)).toEqual([
        { pipeline: "ref2va", accel: "off", num_candidates: 3, auto_pick: false, wait: false },
    ]);

    await first.getByRole("button", { name: "重试渲染" }).click();
    await page.getByRole("dialog", { name: "渲染报价 · 镜01" }).waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/render").length).toBe(1);
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/render-estimate").length).toBe(2);
    await page.getByRole("dialog", { name: "渲染报价 · 镜01" }).getByRole("button", { name: "取消" }).click();
    expect(errors).toEqual([]);
});

test("a projection without a CAS revision keeps stages read-only instead of guessing a baseline", async () => {
    omitRevision = true;
    await goto();
    await page.getByText("阶段操作已停用").waitFor();
    await page.getByRole("button", { name: "分镜阶段 · 待确认" }).click();
    expect(await page.getByRole("button", { name: "确认阶段" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "跳过…" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "重开" }).isDisabled()).toBe(true);
    expect(calls.filter(c => c.path.endsWith("/stage-transition")).length).toBe(0);
    expect(errors).toEqual([]);
});

for (const width of [390, 320]) {
    test(`stage rail and quote dialog stay usable at ${width}px without horizontal overflow`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await goto();
        await page.getByRole("button", { name: "分镜阶段 · 待确认" }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        await page.getByRole("button", { name: "整批渲染" }).click();
        const dialog = page.getByRole("dialog", { name: "渲染报价 · 整批" });
        await dialog.getByText("分镜尚未确认").waitFor();
        await dialog.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const layout = await dialog.evaluate(element => {
            const box = element.getBoundingClientRect();
            const footer = element.querySelector(".pf-modal-foot") as HTMLElement;
            const blocked = footer.querySelector(".toiv-quote-blocked")!.getBoundingClientRect();
            const buttons = [...footer.querySelectorAll(".pf-btn")].map(button => button.getBoundingClientRect());
            const footBox = footer.getBoundingClientRect();
            return {
                left: box.left, right: box.right, viewport: window.innerWidth,
                wrap: getComputedStyle(footer).flexWrap,
                blockedWidth: blocked.width,
                footerInner: footer.clientWidth - parseFloat(getComputedStyle(footer).paddingLeft) - parseFloat(getComputedStyle(footer).paddingRight),
                stacked: blocked.bottom <= Math.min(...buttons.map(button => button.top)) + 1,
                buttonsInside: buttons.every(button => button.left >= footBox.left - 1 && button.right <= footBox.right + 1),
            };
        });
        expect(layout.left).toBeGreaterThanOrEqual(0);
        expect(layout.right).toBeLessThanOrEqual(layout.viewport);
        expect(layout.wrap).toBe("wrap");
        expect(layout.blockedWidth).toBeGreaterThanOrEqual(layout.footerInner - 1);
        expect(layout.stacked).toBe(true);
        expect(layout.buttonsInside).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        expect(errors).toEqual([]);
    });
}
