import { beforeEach, describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router-dom";
import { I18nProvider } from "../src/i18n/context.tsx";

const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
};

mock.module("../src/toiv/adapters/projects", () => ({
    loadPrimeProjects: async () => ({
        cards: [
            { id: "p1", title: "草船借箭", source: "studio", status: "active", shotCount: 6 },
            { id: "c1", title: "画布甲", source: "canvas", status: "canvas", shotCount: 0 },
        ],
        degraded: "none",
    }),
}));

const { default: ProjectHome } = await import("../src/toiv/addons/ProjectHome");
const { PRIME_ROUTES } = await import("../src/toiv/bootstrap");
const { RequireSession, storeToken, currentToken, clearToken } = await import("../src/toiv/auth/session");

describe("prime bootstrap routes", () => {
    test("mounts the three faces and drops billing", () => {
        expect(PRIME_ROUTES).toContain("/studio/:id/editor");
        expect(PRIME_ROUTES).toContain("/drama");
        expect(PRIME_ROUTES).toContain("/history");
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
    test("renders children with a session", () => {
        storeToken("jwt-x");
        expect(renderToStaticMarkup(<RequireSession><p>secret</p></RequireSession>)).toContain("secret");
    });
});
