import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const cssSources = await Promise.all([
    "../node_modules/antd/dist/reset.css",
    "../src/styles/toiv-freezone-tokens.css",
    "../src/styles/globals.css",
    "../src/styles/toiv-local-overrides.css",
    "../src/styles/toiv-mobile.css",
    "../src/styles/workspace-product.css",
    "../src/styles/toiv-freezone-desk.css",
    "../src/components/create/creation-studio-queue-dock.css",
].map((path) => Bun.file(new URL(path, import.meta.url)).text()));
const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: new URL("../src/styles/globals.css", import.meta.url).pathname });
const styles = [cssSources[0], cssSources[1], tailwindCss.css, ...cssSources.slice(3)].join("\n");

const canvasTasks = [{
    id: "shared-id",
    projectId: "p1",
    type: "canvas_video",
    status: "running",
    progress: 42,
    stage: "render",
    prompt: "Canvas 雨夜镜头",
    attempts: 1,
    createdAt: "2026-10-28T00:00:00Z",
    updatedAt: "2026-10-28T00:01:00Z",
}];

const toivJobs = [
    {
        id: "shared-id", project_id: "p1", kind: "studio_batch_render", status: "running", prompt: "FastAPI 雨夜镜头", created_at: "2026-10-28T00:00:00Z",
        progress: { pct: 63, step: 5, total: 8, updated_at: 1793148060, phase_label: "批量渲染" },
        runtime: { state: "stalled", label: "进度待核查", reason: "进度快照 120 秒未更新", last_evidence_at: 1793148060, age_seconds: 120, evidence: "progress_snapshot" },
    },
    {
        id: "batch-held", project_id: "p1", kind: "studio_batch_render", status: "held", prompt: "批量等待资源", hold_reason: "等待批量渲染资源", created_at: "2026-10-28T00:02:00Z",
        progress: { pct: null, queue_pos: 2, updated_at: 1793148080 },
        runtime: { state: "waiting", label: "等待资源", reason: "GPU 资源占用", last_evidence_at: 1793148080, age_seconds: 20, evidence: "created_at" },
    },
    {
        id: "job-failed", project_id: "p1", kind: "image", status: "error", prompt: "失败作业可重试", error: "provider unavailable", created_at: "2026-10-28T00:03:00Z",
        runtime: { state: "terminal", label: "终态", reason: "作业失败", last_evidence_at: 1793148100, age_seconds: 0, evidence: "terminal" },
    },
    {
        id: "job-done", project_id: "p1", kind: "image", status: "done", prompt: "真实产物", created_at: "2026-10-28T00:04:00Z", results: ["/api/results/demo.png"],
        runtime: { state: "terminal", label: "终态", reason: "作业已完成", last_evidence_at: 1793148120, age_seconds: 0, evidence: "terminal" },
    },
    { id: "other-project", project_id: "p2", status: "running", prompt: "不应出现在 p1", created_at: "2026-10-28T00:05:00Z" },
];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/d1a-task-sources-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "" }),
        },
        plugins: [{ name: "d1a-stubs", setup(builder) {
            builder.onResolve({ filter: /^@\/services\/toiv\/client$/ }, () => ({ path: "stub-client", namespace: "stub-client" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onResolve({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({ path: "stub-client", namespace: "stub-client" }));
            builder.onLoad({ filter: /.*/, namespace: "stub-client" }, () => ({
                contents: `
                    export async function fetchJobs() {
                        if (new URLSearchParams(window.location.search).has("race")) {
                            return new Promise((resolve, reject) => {
                                window.__d1aRequests.push({ source: "toiv", project: window.__d1aProject || "p1", resolve, reject });
                            });
                        }
                        if (new URLSearchParams(window.location.search).get("sourceError") === "toiv") throw new Error("FastAPI 作业读取失败");
                        return ${JSON.stringify(toivJobs)};
                    }
                    export async function fetchAgentRuns() { return []; }
                    export async function cancelJob(id) { window.__d1aCancelId = id; return false; }
                    export async function rerunToivWork(id) { window.__d1aRetryId = id; return false; }
                `,
                loader: "ts",
            }));
            builder.onLoad({ filter: /src\/services\/api\/task-center\.ts$/ }, () => ({
                contents: `
                    export async function listGenerationTasks(_limit, options) {
                        if (new URLSearchParams(window.location.search).has("race")) {
                            return new Promise((resolve, reject) => {
                                window.__d1aRequests.push({ source: "canvas", project: options?.projectId || "p1", resolve, reject });
                            });
                        }
                        return ${JSON.stringify(canvasTasks)};
                    }
                    export async function listTaskLogs(id) { return [{ id: "log-1", taskId: id, level: "info", stage: "render", provenance: "provider_observation", createdAt: "2026-10-28T00:04:00Z", summary: "Canvas provider log" }]; }
                    export async function retryGenerationTask() { throw new Error("Canvas 重试失败"); }
                    export async function cancelGenerationTask(id) { return { id, status: "cancelled" }; }
                    export function formatTaskLog(log) { return log.summary; }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (url.pathname === "/api/results/demo.png") return new Response(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"), { headers: { "Content-Type": "image/png" } });
            return new Response(`<!doctype html><html class="dark"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness(view: "dock" | "tasks", sourceError = false): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${server.url}?view=${view}${sourceError ? "&sourceError=toiv" : ""}`);
    if (view === "dock") {
        await page.locator(".toiv-queue-trigger").click();
        await page.locator(".toiv-queue-panel").waitFor();
    }
    await page.locator('[data-source-id="toiv-job:shared-id"], [data-source-id="canvas-task:shared-id"]').first().waitFor();
    await page.waitForTimeout(300);
    return page;
}

test("dock merges both sources with isolated IDs, real progress/media and shared health", async () => {
    const page = await openHarness("dock");
    expect(await page.locator('[data-source-id="canvas-task:shared-id"]').count()).toBe(1);
    expect(await page.locator('[data-source-id="toiv-job:shared-id"]').count()).toBe(1);
    expect(await page.locator('[data-task-id="canvas-task:shared-id"]').count()).toBe(1);
    expect(await page.locator('[data-task-id="toiv-job:shared-id"]').count()).toBe(1);
    expect(await page.locator('[data-task-id="shared-id"]').count()).toBe(0);
    expect(await page.locator('[data-source-id="toiv-job:other-project"]').count()).toBe(0);
    const toiv = page.locator('[data-source-id="toiv-job:shared-id"]');
    expect(await toiv.locator('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("63");
    expect(await toiv.getAttribute("data-health-label")).toBe("进度待核查");
    expect(await toiv.getAttribute("data-health-reason")).toBe("进度快照 120 秒未更新");
    expect(await page.locator('[data-source-id="toiv-job:job-done"] img').getAttribute("src")).toBe("/api/results/demo.png");
    expect(await page.locator('[data-source-id="toiv-job:job-done"] img').evaluate((image) => (image as HTMLImageElement).naturalWidth)).toBe(1);
    await toiv.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await page.screenshot({ path: "test-results/production-d1a/dock-dual-source-health.png", fullPage: true, animations: "disabled" });
    await page.close();
});

test("tasks uses the same runtime label/reason and keeps held/stalled active", async () => {
    const page = await openHarness("tasks");
    const toiv = page.locator('[data-source-id="toiv-job:shared-id"]');
    expect(await toiv.getAttribute("data-health-label")).toBe("进度待核查");
    expect(await toiv.getAttribute("data-health-reason")).toBe("进度快照 120 秒未更新");
    expect(await toiv.getAttribute("data-active")).toBe("true");
    expect(await page.locator('[data-source-id="toiv-job:batch-held"]').getAttribute("data-active")).toBe("true");
    await toiv.scrollIntoViewIfNeeded();
    await page.waitForTimeout(100);
    await page.screenshot({ path: "test-results/production-d1a/tasks-shared-health.png", fullPage: true, animations: "disabled" });
    await page.close();
});

test("one failed source remains visible without disguising the queue as empty", async () => {
    const page = await openHarness("dock", true);
    expect(await page.locator(".toiv-queue-source-error").textContent()).toContain("FastAPI 作业读取失败");
    expect(await page.locator('[data-source-id="canvas-task:shared-id"]').count()).toBe(1);
    expect(await page.getByText("暂无生成任务", { exact: true }).count()).toBe(0);
    await page.screenshot({ path: "test-results/production-d1a/dock-source-error.png", fullPage: true, animations: "disabled" });
    await page.close();
});

test("cancel false and retry false are visible and Toiv logs deep-link to tasks", async () => {
    const page = await openHarness("dock");
    await page.locator('[data-source-id="toiv-job:shared-id"] [aria-label="取消"]').click();
    expect(await page.locator(".toiv-queue-action-error").textContent()).toContain("取消失败");
    const retry = page.locator('[data-source-id="toiv-job:job-failed"] [aria-label="重试"]');
    await retry.scrollIntoViewIfNeeded();
    await page.waitForTimeout(200);
    await retry.click();
    expect(await page.locator(".toiv-queue-action-error").textContent()).toContain("重试失败");
    expect(await page.locator('[data-source-id="toiv-job:shared-id"] a[aria-label="查看日志"]').getAttribute("href")).toBe("/tasks?job=shared-id");
    await page.screenshot({ path: "test-results/production-d1a/dock-action-errors.png", fullPage: true, animations: "disabled" });
    await page.close();
});

test("tasks also surfaces Toiv cancel false and retry false", async () => {
    const page = await openHarness("tasks");
    await page.locator('[data-source-id="toiv-job:shared-id"] button').filter({ hasText: "取消" }).click();
    expect(await page.locator(".d1a-task-action-error").textContent()).toContain("取消失败");
    await page.locator('[data-source-id="toiv-job:job-failed"] button').filter({ hasText: "重试" }).click();
    expect(await page.locator(".d1a-task-action-error").textContent()).toContain("重试失败");
    await page.close();
});

async function openRaceHarness(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    await page.goto(`${server.url}?view=dock&race=1`);
    await page.waitForFunction(() => (window as any).__d1aRequests.length === 2);
    await page.locator(".toiv-queue-trigger").click();
    return page;
}

async function settleRaceRequest(page: Page, index: number, action: "resolve" | "reject", payload: unknown): Promise<void> {
    await page.evaluate(({ index, action, payload }) => {
        const request = (window as any).__d1aRequests[index];
        if (!request) throw new Error(`missing delayed request ${index}`);
        if (action === "reject") request.reject(new Error(String(payload)));
        else request.resolve(payload);
    }, { index, action, payload });
}

function raceCanvasTask(projectId: string, version: string) {
    return [{ id: `${projectId}-${version}`, projectId, type: "canvas_video", status: "running", progress: 42, stage: "render", prompt: `${projectId} ${version}`, attempts: 1, createdAt: "2026-10-28T00:00:00Z", updatedAt: "2026-10-28T00:01:00Z" }];
}

function raceToivJobs(projectId: string, version: string) {
    return [{ id: `${projectId}-${version}`, project_id: projectId, kind: "image", status: "running", prompt: `${projectId} ${version}`, created_at: "2026-10-28T00:00:00Z" }];
}

test("AB delayed old errors cannot overwrite the latest project round", async () => {
    const page = await openRaceHarness();
    await page.getByTestId("race-p2").click();
    await page.waitForFunction(() => (window as any).__d1aRequests.length === 4);
    await page.locator(".toiv-queue-trigger").click();
    await settleRaceRequest(page, 2, "resolve", raceCanvasTask("p2", "new"));
    await settleRaceRequest(page, 3, "resolve", raceToivJobs("p2", "new"));
    await page.locator('[data-source-id="canvas-task:p2-new"]').waitFor();
    await settleRaceRequest(page, 0, "reject", "old Canvas error");
    await settleRaceRequest(page, 1, "reject", "old FastAPI error");
    await page.waitForTimeout(100);
    expect(await page.locator(".toiv-queue-source-error").count()).toBe(0);
    expect(await page.locator('[data-source-id="canvas-task:p2-new"]').count()).toBe(1);
    expect(await page.locator('[data-source-id="toiv-job:p2-new"]').count()).toBe(1);
    await page.close();
});

test("ABA delayed first round cannot replace the newest same-project data", async () => {
    const page = await openRaceHarness();
    await page.getByTestId("race-p2").click();
    await page.waitForFunction(() => (window as any).__d1aRequests.length === 4);
    await page.getByTestId("race-p1").click();
    await page.waitForFunction(() => (window as any).__d1aRequests.length === 6);
    await page.locator(".toiv-queue-trigger").click();
    await settleRaceRequest(page, 4, "resolve", raceCanvasTask("p1", "newest"));
    await settleRaceRequest(page, 5, "resolve", raceToivJobs("p1", "newest"));
    await page.locator('[data-source-id="canvas-task:p1-newest"]').waitFor();
    await settleRaceRequest(page, 0, "resolve", raceCanvasTask("p1", "stale"));
    await settleRaceRequest(page, 1, "resolve", raceToivJobs("p1", "stale"));
    await page.waitForTimeout(100);
    expect(await page.locator('[data-source-id="canvas-task:p1-stale"]').count()).toBe(0);
    expect(await page.locator('[data-source-id="toiv-job:p1-stale"]').count()).toBe(0);
    expect(await page.locator('[data-source-id="canvas-task:p1-newest"]').count()).toBe(1);
    expect(await page.locator('[data-source-id="toiv-job:p1-newest"]').count()).toBe(1);
    await page.screenshot({ path: "test-results/production-d1a/dock-aba-latest.png", fullPage: true, animations: "disabled" });
    await page.close();
});
