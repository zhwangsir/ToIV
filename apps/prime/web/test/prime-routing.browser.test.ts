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
            : path === "/studio/api/canvas-projects" ? { code: 0, data: { projects: [] }, msg: "ok" }
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

test("legacy canvas deep links have an explicit destination state instead of silently going home", async () => {
    await page.goto(`${origin}/preview/legacy/canvas/c1`);
    await page.getByRole("heading", { name: "画布编辑器", exact: true }).waitFor();
});
