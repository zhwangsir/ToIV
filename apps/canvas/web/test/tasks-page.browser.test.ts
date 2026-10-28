import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/tasks-page-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onResolve({ filter: /^actual-client$/ }, () => ({ path: Bun.resolveSync("../src/services/toiv/client.ts", import.meta.dir), namespace: "actual-client" }));
            builder.onResolve({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({ path: "stub-client", namespace: "stub-client" }));
            builder.onLoad({ filter: /.*/, namespace: "stub-client" }, () => ({
                contents: `
                    export * from "actual-client";
                    export async function fetchJobs() { return []; }
                    export async function fetchAgentRuns() { return []; }
                `,
                loader: "ts",
            }));
            builder.onLoad({ filter: /src\/services\/api\/task-center\.ts$/ }, () => ({
                contents: `
                    export async function listGenerationTasks() { return [
                        { id: "task-failed", type: "canvas_video", status: "failed", resultState: "FAILED_RETRYABLE", prompt: "雨夜镜头", error: "provider timeout", providerRequestId: "req-1", attempts: 1, createdAt: "2026-10-27T00:00:00Z", updatedAt: "2026-10-27T00:00:00Z" },
                        { id: "task-running", type: "canvas_video", status: "running", stage: "render", progress: 42, prompt: "便利店", attempts: 1, createdAt: "2026-10-27T00:01:00Z", updatedAt: "2026-10-27T00:01:00Z" }
                    ]; }
                    export async function retryGenerationTask(id) { window.__retryId = id; return { id, status: "running" }; }
                    export async function cancelGenerationTask(id) { window.__cancelId = id; return { id, status: "cancelled" }; }
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
        : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:#0a0c12;color:#e8eaf0;font-family:Inter,sans-serif}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("task center shares artifact state and performs real retry/cancel actions", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    await page.getByText("雨夜镜头", { exact: true }).waitFor();
    expect(await page.getByText("产物失败", { exact: true }).count()).toBe(1);
    expect(await page.getByText("产物待生成", { exact: true }).count()).toBe(1);
    await page.screenshot({ path: "test-results/production-b1/tasks-center.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "重试", exact: true }).click();
    await page.waitForFunction(() => (window as any).__retryId === "task-failed");
    await page.getByRole("button", { name: "取消任务", exact: true }).click();
    await page.waitForFunction(() => (window as any).__cancelId === "task-running");
    expect(errors).toEqual([]);
    await page.close();
});
