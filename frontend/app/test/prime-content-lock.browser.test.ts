import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { cpSync, existsSync, mkdirSync, mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import { resolvePolicyModule } from "../vite.config";

// 内容锁删除演练：@content-lock 是 Prime 唯一的内容策略来源。
// 共享锁被删除时应当降级为放行策略，页面照常渲染、功能不缺失。
// Prime 当前没有门控式入口（仅 NSFW 偏好开关与信息徽标），后续新增的
// 门控 / 隐藏 / 徽标必须经 @content-lock，不能再自造一份判断。
const repo = join(import.meta.dir, "..");
const temps: string[] = [];

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let page: Page;
let errors: string[];
let sharedPolicyPath: string;
let deletedLayoutPath: string;
const sharedPolicy = await import(resolvePolicyModule(repo));

const capabilities = {
    schema_version: 1,
    tools: {},
    slots: [{
        id: "image", label: "画面生成", available: true, affects: ["分镜画面"],
        engines: [{ id: "comfy", label: "ComfyUI", kind: "image", available: true, nsfw: false, params: [] }],
    }],
    issues: [],
};

function harnessEntry(): string {
    return `
        import { createRoot } from "${import.meta.dir}/../node_modules/react-dom/client";
        import { MemoryRouter, Route, Routes } from "${import.meta.dir}/../node_modules/react-router-dom";
        import { I18nProvider } from "${import.meta.dir}/../src/i18n/context";
        import PrimeSettings from "${import.meta.dir}/../src/toiv/pages/PrimeSettings";
        import { contentPolicy } from "@content-lock";
        function PolicyDrill() {
            const gated = contentPolicy.isGatedLocation({ pathname: "/nsfw" }, []);
            return (
                <dl data-testid="policy-drill">
                    <dd data-testid="policy-id">{contentPolicy.id}</dd>
                    <dd data-testid="policy-gated">{String(gated)}</dd>
                    <dd data-testid="policy-allows">{String(contentPolicy.allowsContent(false))}</dd>
                </dl>
            );
        }
        createRoot(document.getElementById("root")!).render(
            <MemoryRouter initialEntries={["/settings"]}>
                <I18nProvider>
                    <Routes>
                        <Route path="/settings" element={<PrimeSettings />} />
                    </Routes>
                    <PolicyDrill />
                </I18nProvider>
            </MemoryRouter>,
        );
    `;
}

async function bundle(policyPath: string): Promise<string> {
    const plugins: BunPlugin[] = [{
        name: "prime-content-lock-harness",
        setup(builder) {
            builder.onResolve({ filter: /^@content-lock$/ }, () => ({ path: policyPath }));
            builder.onLoad({ filter: /prime-content-lock\.browser\.test\.ts$/ }, () => ({
                loader: "tsx",
                contents: harnessEntry(),
            }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
        plugins,
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    return build.outputs[0].text();
}

beforeAll(async () => {
    const deleted = mkdtempSync(join(tmpdir(), "prime-lock-deleted-"));
    temps.push(deleted);
    const deletedApp = join(deleted, "frontend/app");
    mkdirSync(join(deletedApp, "src/toiv/policy"), { recursive: true });
    cpSync(join(repo, "src/toiv/policy/noop-content-lock.ts"), join(deletedApp, "src/toiv/policy/noop-content-lock.ts"));
    // 该布局既没有共享锁也没有共享放行策略，等同「锁文件被删除且未部署回落件」。
    deletedLayoutPath = resolvePolicyModule(deletedApp);
    sharedPolicyPath = resolvePolicyModule(repo);

    const [sharedBundle, deletedBundle] = await Promise.all([bundle(sharedPolicyPath), bundle(deletedLayoutPath)]);
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"]
        .map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/shared.js") return new Response(sharedBundle, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/deleted.js") return new Response(deletedBundle, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            const script = path === "/deleted" ? "/deleted.js" : "/shared.js";
            return new Response(`<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="${script}"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors = [];
    page = await browser.newPage({ viewport: { width: 390, height: 850 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/*", route => {
        const url = new URL(route.request().url());
        if (url.origin === origin && !url.pathname.startsWith("/api/")) return route.continue();
        if (url.pathname === "/api/models/capabilities") return route.fulfill({ json: capabilities });
        return route.fulfill({ status: 404, body: "unmocked" });
    });
});

afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    await Promise.all(temps.map(root => rm(root, { recursive: true, force: true })));
});

async function open(mode: "shared" | "deleted") {
    await page.goto(`${origin}/${mode === "deleted" ? "deleted" : ""}`);
    await page.getByTestId("policy-drill").waitFor();
    return {
        id: await page.getByTestId("policy-id").textContent(),
        gated: await page.getByTestId("policy-gated").textContent(),
        allows: await page.getByTestId("policy-allows").textContent(),
    };
}

test("the shared lock drives every policy decision without breaking the settings page", async () => {
    const drill = await open("shared");
    expect(drill.id).toBe(sharedPolicy.contentPolicy.id);
    expect(drill.gated).toBe(String(sharedPolicy.contentPolicy.isGatedLocation({ pathname: "/nsfw" }, [])));
    expect(drill.allows).toBe(String(sharedPolicy.contentPolicy.allowsContent(false)));
    // 锁文件存在时，别名必须真的指向锁而不是任何放行副本；删除演练时该分支自动跳过。
    if (existsSync(join(repo, "../../vendor/canvas/web/src/content-lock.ts"))) {
        expect(drill.id).not.toBe("unrestricted");
        expect(drill.gated).toBe("true");
    }
    expect(await page.getByRole("heading", { name: "设置", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("navigation", { name: "设置分区" }).count()).toBe(1);
});

test("deleting the shared lock degrades to the neutral policy and keeps the app usable", async () => {
    const drill = await open("deleted");
    expect(deletedLayoutPath.endsWith("src/toiv/policy/noop-content-lock.ts")).toBe(true);
    expect(drill.id).toBe("unrestricted");
    expect(drill.gated).toBe("false");
    expect(drill.allows).toBe("true");
    expect(await page.getByRole("heading", { name: "设置", exact: true }).isVisible()).toBe(true);
    expect(await page.getByRole("navigation", { name: "设置分区" }).count()).toBe(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
