import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { mapUrlStrings, publicAsset, toCanonicalUrl, toClientUrl, urlMappingActive } from "../src/lib/app-base";

const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

describe("/studio 子路径部署", () => {
    test("默认构建（base 为空、/api）不改写任何地址", () => {
        expect(urlMappingActive("/api", "")).toBe(false);
        expect(toClientUrl("/api/resources/a/file", "/api", "")).toBe("/api/resources/a/file");
        expect(publicAsset("/short-drama-styles/x.jpg", "")).toBe("/short-drama-styles/x.jpg");
        const payload = { a: "/api/resources/a/file" };
        expect(mapUrlStrings(payload, (v) => toClientUrl(v, "/api", ""))).toBe(payload);
    });

    test("后端返回的 /api 绝对地址改写到 /studio/api，提交时还原", () => {
        expect(toClientUrl("/api/resources/7780/file", "/studio/api", "/studio")).toBe("/studio/api/resources/7780/file");
        expect(toClientUrl("/api/public/appearance/assets/logo?v=2", "/studio/api", "/studio")).toBe("/studio/api/public/appearance/assets/logo?v=2");
        expect(toCanonicalUrl("/studio/api/resources/7780/file", "/studio/api", "/studio")).toBe("/api/resources/7780/file");
        // 非根相对地址、协议相对地址、普通文本不动
        for (const value of ["https://x.test/api/a", "//cdn.test/api/a", "api/a", "一只橘猫", "/canvas/abc"]) {
            expect(toClientUrl(value, "/studio/api", "/studio")).toBe(value);
            expect(toCanonicalUrl(value, "/studio/api", "/studio")).toBe(value);
        }
    });

    test("公共文件加前缀，往返不变", () => {
        expect(publicAsset("/short-drama-styles/x.jpg", "/studio")).toBe("/studio/short-drama-styles/x.jpg");
        expect(publicAsset("/studio/short-drama-styles/x.jpg", "/studio")).toBe("/studio/short-drama-styles/x.jpg");
        expect(toClientUrl("/lighting-presets/a.png", "/studio/api", "/studio")).toBe("/studio/lighting-presets/a.png");
        expect(toCanonicalUrl("/studio/lighting-presets/a.png", "/studio/api", "/studio")).toBe("/lighting-presets/a.png");
        expect(toCanonicalUrl("/studio/canvas/abc", "/studio/api", "/studio")).toBe("/studio/canvas/abc");
    });

    test("深层映射不改原对象，跳过 Blob 等非普通对象", () => {
        const blob = new Blob(["x"]);
        const input = { nodes: [{ metadata: { content: "/api/resources/r/file", prompt: "猫" } }], blob };
        const out = mapUrlStrings(input, (v) => toClientUrl(v, "/studio/api", "/studio"));
        expect(out).not.toBe(input);
        expect(out.nodes[0].metadata.content).toBe("/studio/api/resources/r/file");
        expect(input.nodes[0].metadata.content).toBe("/api/resources/r/file");
        expect(out.blob).toBe(blob);
        expect(out.nodes[0].metadata.prompt).toBe("猫");
    });

    test("路由、请求层、退出登录都接上前缀", () => {
        expect(read("src/lib/app-routing.ts")).toContain("createBrowserRouter(routes, APP_BASE ? { basename: APP_BASE } : undefined)");
        const request = read("src/services/api/request.ts");
        expect(request).toContain("toCanonicalUrl(value, apiBaseURL)");
        expect(request).toContain("toClientUrl(value, apiBaseURL)");
        const account = read("src/components/layout/workspace-sidebar-account.tsx");
        expect(account).toContain('gatePath("/auth/logout")');
        expect(account).toContain('localStorage.removeItem("toiv_token")');
        expect(read("vite.config.ts")).toContain("base: publicBase");
    });

    test("源码里不再有裸的公共文件地址（防回归）", () => {
        for (const file of ["src/components/canvas/canvas-style-picker-modal.tsx", "src/components/canvas/canvas-node-lighting-dialog.tsx", "src/lib/canvas/canvas-style-system.ts", "src/pages/create/creation-inspirations.ts"]) {
            expect(read(file)).not.toMatch(/:\s*"\/(short-drama-styles|lighting-presets)\//);
        }
    });
});

describe("网关会话失效", () => {
    function withWindow(run: (calls: string[], storage: Map<string, string>) => void) {
        const calls: string[] = [];
        const storage = new Map<string, string>();
        const original = globalThis.window;
        (globalThis as { window?: unknown }).window = {
            location: { pathname: "/canvas/x", search: "?a=1", replace: (url: string) => calls.push(url) },
            sessionStorage: { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => storage.set(k, v) },
        };
        try { run(calls, storage); } finally { (globalThis as { window?: unknown }).window = original; }
    }

    test("staging（根路径）：只有网关的 401 unauthenticated 才跳网关登录页，且只跳一次", async () => {
        const { redirectToGateLogin } = await import("../src/lib/app-base?staging");
        withWindow((calls) => {
            expect(redirectToGateLogin(401, { code: 401, reason: "gate_identity_required" }, "")).toBe(false);
            expect(redirectToGateLogin(403, { error: "unauthenticated" }, "")).toBe(false);
            expect(redirectToGateLogin(401, { error: "unauthenticated" }, "")).toBe(true);
            expect(redirectToGateLogin(401, { error: "unauthenticated" }, "")).toBe(false);
            expect(calls).toEqual(["/login?next=%2Fcanvas%2Fx%3Fa%3D1"]);
        });
    });

    test("/studio（网关已退役）：canvas-api 的身份 401 跳 ToIV 登录入口；60 秒内不重复跳", async () => {
        const { redirectToGateLogin } = await import("../src/lib/app-base?studio");
        withWindow((calls, storage) => {
            expect(redirectToGateLogin(401, { code: 401, reason: "other" }, "/studio")).toBe(false);
            expect(redirectToGateLogin(401, { code: 401, reason: "gate_identity_required" }, "/studio")).toBe(true);
            expect(calls).toEqual(["/?view=home&next=%2Fcanvas%2Fx%3Fa%3D1"]);
            expect(storage.has("toiv_studio_login_redirect_at")).toBe(true);
        });
        const again = await import("../src/lib/app-base?studio2");
        withWindow((calls, storage) => {
            storage.set("toiv_studio_login_redirect_at", String(Date.now()));
            expect(again.redirectToGateLogin(401, { reason: "toiv_identity_required" }, "/studio")).toBe(false);
            expect(calls).toEqual([]);
        });
    });
});
