import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
const errors: string[] = [];

beforeAll(async () => {
    server = await createServer({ root: resolve(import.meta.dir, ".."), base: "/preview/", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing local preview address");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(2500);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "test-only-session"));
    await page.route("**/api/**", async route => {
        const path = new URL(route.request().url()).pathname;
        const body = path === "/api/auth/me" ? { user: { id: "test-user", role: "admin" } }
            : path === "/api/studio/projects/p1" ? { id: "p1", title: "测试短片", shots: [], characters: [] }
            : path === "/api/jobs" ? []
            : path === "/api/jobs/active" ? { items: [], server_time: "2026-10-30T10:00:00Z" }
            : path === "/api/jobs/counts" ? { count: 0, failed: 0 }
            : path === "/api/studio/deps-status" ? { overall: "reachable", deps: [] }
            : path === "/studio/api/canvas-projects" ? { code: 0, data: { projects: [] }, msg: "ok" }
            : path === "/studio/api/canvas-projects/c1" ? {
                code: 0, msg: "ok", data: {
                    project: {
                        id: "c1", canvasTitle: "旧画布甲", updatedAt: "2026-10-30T10:00:00Z",
                        nodes: [{ id: "n1", type: "text", title: "台词", position: { x: 0, y: 0 }, width: 240, height: 120, metadata: { content: "别回头。" } }],
                        connections: [],
                    },
                },
            }
            : [];
        await route.fulfill({ json: body });
    });
    await page.route("**/studio/auth/exchange", route => route.fulfill({ json: { ok: true } }));
}, 60_000);

afterAll(async () => { await browser?.close(); await server?.close(); });

test("deep links under a non-root mount retain the project after reload", async () => {
    await page.goto(`${origin}/preview/studio/p1`);
    await page.getByRole("heading", { name: "测试短片", exact: true }).waitFor();
    await page.reload();
    await page.getByRole("heading", { name: "测试短片", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/studio/p1");
    expect(errors).toEqual([]);
}, 30_000);

test("unavailable legacy pages do not redirect into the same SPA", async () => {
    await page.goto(`${origin}/preview/settings`);
    await page.getByRole("heading", { name: "设置", exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "打开旧版设置", exact: true }).isEnabled()).toBe(false);
}, 30_000);

test("tool routes open the native tools centre instead of falling home", async () => {
    for (const [path, heading] of [["/preview/tools", "工具"], ["/preview/tools/image", "文生图"], ["/preview/tools/t2v", "文生视频"]]) {
        await page.goto(`${origin}${path}`);
        await page.getByRole("heading", { name: heading, exact: true }).waitFor();
        expect(new URL(page.url()).pathname).toBe(path);
    }
}, 30_000);

test("the task centre and works library keep distinct routes with a legacy redirect", async () => {
    await page.goto(`${origin}/preview/tasks`);
    await page.getByRole("heading", { name: "任务中心", exact: true }).waitFor();
    await page.getByText(/队列空闲/).waitFor();
    const nav = page.getByRole("navigation", { name: "主导航", exact: true });
    expect(await nav.locator(".active").allTextContents()).toEqual(["任务"]);
    await page.goto(`${origin}/preview/library`);
    await page.getByRole("heading", { name: /^作品/ }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/library");
    expect(await nav.locator(".active").allTextContents()).toEqual(["任务"]);
    await page.goto(`${origin}/preview/history`);
    await page.getByRole("heading", { name: "任务中心", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/tasks");
}, 30_000);

test("an expired stored session cannot render a protected project", async () => {
    await page.route("**/api/auth/me", route => route.fulfill({ status: 401, json: { detail: "expired" } }));
    await page.goto(`${origin}/preview/studio/p1`);
    await page.getByRole("heading", { name: "登录 ToIV", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/auth");
    expect(await page.getByRole("heading", { name: "测试短片", exact: true }).count()).toBe(0);
    await page.unroute("**/api/auth/me");
});

test("an auth outage allows retry without treating the session as invalid", async () => {
    await page.route("**/api/auth/me", route => route.fulfill({ status: 503, json: { detail: "unavailable" } }));
    await page.goto(`${origin}/preview/studio/p1`);
    await page.getByRole("button", { name: "重试验证", exact: true }).waitFor();
    await page.unroute("**/api/auth/me");
    await page.getByRole("button", { name: "重试验证", exact: true }).click();
    await page.getByRole("heading", { name: "测试短片", exact: true }).waitFor();
});

test("embedded entry consumes its credential before loading the project and keeps other URL state", async () => {
    let embeddedSessionUsed = false;
    await page.route("**/api/auth/me", async route => {
        embeddedSessionUsed = route.request().headers().authorization === "Bearer test-only-embedded-session";
        await route.fulfill({ json: { user: { id: "test-user", role: "admin" } } });
    });
    await page.goto(`${origin}/preview/studio/p1?miniapp_token=test-only-embedded-session&view=shots#focus`);
    await page.getByRole("heading", { name: "测试短片", exact: true }).waitFor();
    expect(embeddedSessionUsed).toBe(true);
    expect(new URL(page.url()).search).toBe("?view=shots");
    expect(new URL(page.url()).hash).toBe("#focus");
    await page.unroute("**/api/auth/me");
});

test("project home does not eagerly fetch the canvas editor module", async () => {
    const requests: string[] = [];
    const collect = (request: { url(): string }) => requests.push(new URL(request.url()).pathname);
    page.on("request", collect);
    await page.goto(`${origin}/preview/studio`);
    await page.getByLabel("搜索项目").waitFor();
    page.off("request", collect);
    expect(requests.some(path => path.endsWith("/pages/PrimeCanvas.tsx"))).toBe(false);
});

test("legacy canvas deep links render the read-only snapshot instead of silently going home", async () => {
    await page.goto(`${origin}/preview/legacy/canvas/c1`);
    await page.getByRole("heading", { name: "旧画布甲", exact: true }).waitFor();
    expect(await page.getByText("只读", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByText("1 个节点", { exact: true }).count()).toBeGreaterThan(0);
    await page.getByText("别回头。", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/legacy/canvas/c1");
});
