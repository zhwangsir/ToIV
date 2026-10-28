import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/create/creation-studio-queue-dock.css", import.meta.url)).text(),
])).join("\n");

const tasks = [
    { id: "r1", type: "video", status: "running", progress: 42, stage: "render", prompt: "雨夜天台", model: "local-wan", attempts: 1, createdAt: "2026-10-27T00:00:00Z" },
    { id: "r2", type: "video", status: "running", stage: "compose", prompt: "便利店", model: "local-wan", attempts: 1, createdAt: "2026-10-27T00:01:00Z" },
    { id: "f1", type: "image", status: "failed", error: "provider timeout", stage: "render", prompt: "末班车站", model: "qwen", attempts: 2, createdAt: "2026-10-27T00:02:00Z" },
    { id: "s1", type: "image", status: "succeeded", stage: "done", prompt: "角色定妆", model: "qwen", attempts: 1, createdAt: "2026-10-27T00:03:00Z" },
];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/queue-dock-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test", VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT: "http://127.0.0.1:8080" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\/services\/toiv\/client$/ }, () => ({ path: "stub-client", namespace: "stub-client" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /.*/, namespace: "stub-client" }, () => ({
                contents: `
                    export async function fetchJobs() { return []; }
                    export async function cancelJob() { return true; }
                    export async function rerunToivWork() { return true; }
                `,
                loader: "ts",
            }));
            builder.onLoad({ filter: /src\/services\/api\/task-center\.ts$/ }, () => ({
                contents: `
                    export async function listGenerationTasks() { return ${JSON.stringify(tasks)}; }
                    export async function listTaskLogs(id) { return [{ id: "log-1", taskId: id, level: "warn", stage: "render", provenance: "provider_observation", createdAt: "2026-10-27T00:04:00Z", summary: "provider responded after 2 attempts" }]; }
                    export async function retryGenerationTask() { throw new Error("重试被拒绝"); }
                    export async function cancelGenerationTask(id) { return { id, status: "cancelled" }; }
                    export function formatTaskLog(log) { return log.summary; }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
        : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness(light = false): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(`${server.url}${light ? "?light=1" : ""}`);
    await page.getByRole("button", { name: "生成队列（2 进行中）" }).click();
    await page.locator(".toiv-queue-panel").waitFor();
    await page.waitForTimeout(400);
    return page;
}

test("queue shows true progress, unknown progress and useful failure details", async () => {
    const page = await openHarness();
    expect(await page.locator(".toiv-queue-panel").evaluate((element) => element.getBoundingClientRect().width)).toBe(420);
    const first = page.locator('[data-task-id="canvas-task:r1"]');
    expect(await first.locator(".toiv-queue-row-prompt").textContent()).toBe("雨夜天台");
    expect(await first.locator('[role="progressbar"]').getAttribute("aria-valuenow")).toBe("42");
    expect(await first.locator(".toiv-queue-progress > span").evaluate((element) => element.style.width)).toBe("42%");
    const unknown = page.locator('[data-task-id="canvas-task:r2"]');
    expect(await unknown.locator(".toiv-queue-progress > span").evaluate((element) => element.style.width)).not.toBe("100%");
    expect(await unknown.locator('[role="progressbar"]').getAttribute("aria-valuenow")).toBeNull();
    expect(await page.locator('[data-task-id="canvas-task:f1"] .toiv-queue-row-error').textContent()).toContain("provider timeout");
    await page.screenshot({ path: "test-results/freezone-r7/queue-dark.png", fullPage: true });
    await page.close();
});

test("logs and action failures are visible instead of silently disappearing", async () => {
    const page = await openHarness(true);
    await page.locator('[data-task-id="canvas-task:f1"] [aria-label="查看日志"]').click();
    expect(await page.locator('[data-task-id="canvas-task:f1"] .toiv-queue-log').textContent()).toContain("provider responded after 2 attempts");
    await page.locator('[data-task-id="canvas-task:f1"] [aria-label="重试"]').click();
    expect(await page.locator(".toiv-queue-empty").textContent()).toContain("操作未完成");
    expect(await page.locator(".toiv-queue-empty").textContent()).toContain("重试被拒绝");
    await page.screenshot({ path: "test-results/freezone-r7/queue-light-error.png", fullPage: true });
    await page.locator('[data-task-id="canvas-task:r1"] [aria-label="取消"]').click();
    expect(await page.locator(".toiv-queue-empty").count()).toBe(0);
    await page.close();
});
