import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";
import { resolve } from "node:path";

let server: ViteDevServer;
let browser: Browser;
let page: Page;
let origin: string;
let loginStatus: number;
let exchangeStatus: number;
let loginCalls: number;
let holdLogin: Promise<void> | undefined;

beforeAll(async () => {
    server = await createServer({ root: resolve(import.meta.dir, ".."), base: "/preview/", server: { host: "127.0.0.1", port: 0 } });
    await server.listen();
    const address = server.httpServer!.address();
    if (!address || typeof address === "string") throw new Error("Missing local preview address");
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({ headless: true });
}, 60_000);

afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); await server?.close(); });

beforeEach(async () => {
    loginStatus = 200;
    exchangeStatus = 200;
    loginCalls = 0;
    holdLogin = undefined;
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(2500);
    await page.route("**/api/**", route => route.fulfill({ status: 404, json: { detail: "unmocked" } }));
    await page.route("**/studio/api/**", route => route.fulfill({ status: 404, json: { detail: "unmocked" } }));
    await page.route("**/api/auth/login", async route => {
        loginCalls += 1;
        await holdLogin;
        if (loginStatus !== 200) { await route.fulfill({ status: loginStatus, json: { detail: "rejected" } }); return; }
        await route.fulfill({ json: { token: "jwt-login" } });
    });
    await page.route("**/studio/auth/exchange", async route => {
        if (exchangeStatus !== 200) { await route.fulfill({ status: exchangeStatus, json: { detail: "down" } }); return; }
        await route.fulfill({ json: { ok: true } });
    });
    await page.route("**/api/auth/me", route => route.fulfill({ json: { user: { id: "u1", role: "admin" } } }));
    await page.route("**/api/studio/projects/p1", route => route.fulfill({ json: { id: "p1", title: "测试短片", shots: [], characters: [] } }));
    await page.route("**/api/studio/projects?limit=200", route => route.fulfill({ json: { projects: [] } }));
    await page.route("**/studio/api/canvas-projects", route => route.fulfill({ json: { code: 0, data: { projects: [] }, msg: "ok" } }));
});

const credentials = async () => {
    await page.getByLabel("账号").fill("fixture@example.test");
    await page.getByLabel("口令").fill("fixture-password");
};
const storedToken = () => page.evaluate(() => localStorage.getItem("toiv_token"));

test("a protected deep link redirects to login and returns to the same project after signing in", async () => {
    await page.goto(`${origin}/preview/studio/p1`);
    await page.getByRole("heading", { name: "登录 ToIV", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/auth");
    await credentials();
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.getByRole("heading", { name: "测试短片", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/studio/p1");
    expect(await storedToken()).toBe("jwt-login");
    expect(await page.evaluate(() => localStorage.getItem("token"))).toBe("jwt-login");
    expect(loginCalls).toBe(1);
});

test("a rejected sign-in reports the failure and keeps the visitor on the login form", async () => {
    loginStatus = 401;
    await page.goto(`${origin}/preview/auth`);
    await credentials();
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.getByRole("alert").filter({ hasText: "登录失败" }).waitFor();
    expect(await storedToken()).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/preview/auth");
    loginStatus = 200;
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.getByLabel("搜索项目").waitFor();
    expect(new URL(page.url()).pathname).toBe("/preview/");
    expect(await storedToken()).toBe("jwt-login");
});

test("a failed session exchange does not persist the token", async () => {
    exchangeStatus = 500;
    await page.goto(`${origin}/preview/auth`);
    await credentials();
    await page.getByRole("button", { name: "进入工作台" }).click();
    await page.getByRole("alert").filter({ hasText: "工作台会话建立失败" }).waitFor();
    expect(await storedToken()).toBeNull();
    expect(new URL(page.url()).pathname).toBe("/preview/auth");
});

test("synchronous duplicate submits issue a single sign-in request", async () => {
    let release!: () => void;
    holdLogin = new Promise(resolve => { release = resolve; });
    await page.goto(`${origin}/preview/auth`);
    await credentials();
    await page.locator("form").evaluate(form => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(await page.getByRole("button", { name: "正在登录…" }).isDisabled()).toBe(true);
    release();
    await page.getByLabel("搜索项目").waitFor();
    expect(loginCalls).toBe(1);
});

for (const from of ["/auth", "//evil.example/steal"]) {
    test(`an unsafe return target ${from} falls back to the project library`, async () => {
        await page.goto(`${origin}/preview/auth`);
        await page.evaluate(target => history.replaceState({ usr: { from: target }, key: "k", idx: 0 }, ""), from);
        await credentials();
        await page.getByRole("button", { name: "进入工作台" }).click();
        await page.getByLabel("搜索项目").waitFor();
        expect(new URL(page.url()).pathname).toBe("/preview/");
        expect(new URL(page.url()).host).toBe(new URL(origin).host);
    });
}
