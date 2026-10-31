import { beforeEach, describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../src/i18n/context.tsx";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
};

const { default: ProjectHome } = await import("../src/toiv/addons/ProjectHome");
const { PRIME_ROUTES } = await import("../src/toiv/bootstrap");
const { RequireSession, storeToken, currentToken, clearToken } = await import("../src/toiv/auth/session");

describe("prime bootstrap routes", () => {
    test("mounts the three faces and drops billing", () => {
        expect(PRIME_ROUTES).toContain("/studio/:id/editor");
        expect(PRIME_ROUTES).toContain("/drama");
        expect(PRIME_ROUTES).toContain("/history");
        expect(PRIME_ROUTES).toContain("/settings");
        expect(PRIME_ROUTES).not.toContain("/tools");
        expect(PRIME_ROUTES).not.toContain("/pricing");
    });
});

describe("prime project home", () => {
    test("renders workbar, search and create entry", () => {
        const html = renderToStaticMarkup(<MemoryRouter><I18nProvider><ProjectHome /></I18nProvider></MemoryRouter>);
        expect(html).toContain('aria-label="ToIV 工作面"');
        expect(html).toContain('aria-label="搜索项目"');
        expect(html).toContain("新建项目");
        expect(html).toContain('aria-label="打开任务中心"');
        expect(html).toMatch(/aria-pressed="true"[^>]*>流水线/);
    });
});

describe("prime workbar", () => {
    test("does not label an unknown task count as running or zero", async () => {
        const { ToivWorkbar } = await import("../src/toiv/addons/ToivWorkbar");
        const html = renderToStaticMarkup(<ToivWorkbar face="pipeline" onFaceChange={() => {}} onOpenTasks={() => {}} />);
        expect(html).toContain("任务中心");
        expect(html).not.toContain("运行中");
    });
    for (const name of ["PrimeCreate", "PrimeStoryboard", "PrimeHistory", "PrimeEditor", "PrimeCanvas", "PrimeAssets", "PrimeStyle"]) {
        test(`${name} does not invent a running count before data arrives`, async () => {
            const { default: Page } = await import(`../src/toiv/pages/${name}`);
            const html = renderToStaticMarkup(<MemoryRouter><I18nProvider><Page /></I18nProvider></MemoryRouter>);
            expect(html).not.toContain("0 运行中");
            expect(html).not.toContain("0 渲染中");
        });
    }
});

describe("prime session", () => {
    beforeEach(() => store.clear());
    test("stores the token under both keys", () => {
        storeToken("jwt-x");
        expect(store.get("toiv_token")).toBe("jwt-x");
        expect(store.get("token")).toBe("jwt-x");
        expect(currentToken()).toBe("jwt-x");
        clearToken();
        expect(currentToken()).toBeNull();
    });
    test("redirects to /auth without a session", () => {
        expect(renderToStaticMarkup(<MemoryRouter><RequireSession><p>secret</p></RequireSession></MemoryRouter>)).toBe("");
    });
    test("does not reveal protected children before the stored session is verified", () => {
        storeToken("jwt-x");
        const html = renderToStaticMarkup(<MemoryRouter><RequireSession><p>secret</p></RequireSession></MemoryRouter>);
        expect(html).not.toContain("secret");
        expect(html).toContain('role="status"');
    });
});
