import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let ledger: any;
let posts: Record<string, any>[];
let receipts: any[];
let replayActions: Set<string>;
let errors: string[];

const baseLedger = () => ({
    project_id: "p1", project_title: "第一集",
    episodes: [
        {
            project_id: "p1", title: "第一集", is_current: true, created_at: "2026-10-01T00:00:00",
            characters: [
                { id: "c1", name: "林夏", ref_count: 2, refs: ["/r/p1a.png", "/r/p1b.png"], visual_prompt: "lin xia" },
                { id: "c2", name: "阿七", ref_count: 0, refs: [], visual_prompt: "" },
            ],
        },
        {
            project_id: "p2", title: "第二集", is_current: false, created_at: "2026-10-02T00:00:00",
            characters: [{ id: "c3", name: "林夏", ref_count: 1, refs: ["/r/canon.png"], visual_prompt: "lin xia" }],
        },
    ],
    assets: [
        {
            key: "character:林夏", kind: "character", name: "林夏", status: "outdated",
            canonical_entity_id: "e1", canonical_refs: ["/r/canon.png"],
            episodes: [
                { project_id: "p1", character_id: "c1", ref_count: 2, refs: ["/r/p1a.png", "/r/p1b.png"], matches_canonical: false },
                { project_id: "p2", character_id: "c3", ref_count: 1, refs: ["/r/canon.png"], matches_canonical: true },
            ],
            used_in_shot_ids: ["s1", "s2"],
        },
        {
            key: "character:阿七", kind: "character", name: "阿七", status: "local_only",
            canonical_entity_id: null, canonical_refs: [],
            episodes: [{ project_id: "p1", character_id: "c2", ref_count: 0, refs: [], matches_canonical: null }],
            used_in_shot_ids: [],
        },
        {
            key: "scene:便利店", kind: "scene", name: "便利店", status: "synced",
            canonical_entity_id: "e2", canonical_refs: ["/r/store.png"], episodes: [], used_in_shot_ids: ["s1", "s2"],
        },
    ],
    shots: [
        {
            shot_id: "s1", project_id: "p1", episode_title: "第一集", idx: 0, scene: "便利店",
            prompt: "推门而入", render_mode: "video",
            characters: [{ name: "林夏", ref_epoch: 0, ref_count: 1 }],
            scene_anchor: { anchor_id: "a1" },
            media: { visual: "current", audio: "stale", final: "none" },
        },
    ],
    drifts: [
        { code: "ASSET_MULTI_VERSION", severity: "warning", asset_key: "character:林夏", message: "林夏在两集里有不同参考图" },
        { code: "ASSET_MISSING_REFERENCE", severity: "warning", asset_key: "character:阿七", message: "阿七没有定妆参考图" },
        {
            code: "SHOT_REF_EPOCH_SWITCH", severity: "info", asset_key: "character:林夏",
            message: "第 1 镜切换到参考版本 0", shot_id: "s1", project_id: "p1",
        },
    ],
    suggestions: [
        { asset_key: "character:林夏", action: "merge", entity_id: "e1", confidence: 1, reason: "两集同名且有正典参考图" },
        { asset_key: "character:阿七", action: "create", entity_id: null, confidence: 0.5, reason: "只在第一集出现" },
    ],
    receipts: [],
});

beforeAll(async () => {
    const plugins: BunPlugin[] = [{
        name: "prime-assets-css",
        setup(builder) {
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/prime-assets-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"].map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({
        hostname: "127.0.0.1", port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.startsWith("/api/")) return Response.json({ detail: "unmocked API" }, { status: 503 });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 60_000);

beforeEach(async () => {
    ledger = baseLedger();
    posts = [];
    receipts = [];
    replayActions = new Set();
    errors = [];
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/api/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        if (path === "/api/studio/projects/p1" && method === "GET") {
            await route.fulfill({ json: { id: "p1", title: "第一集", characters: [{ id: "c1", name: "林夏", style: "anime", reference_images_by_style: { anime: ["/r/p1a.png"] } }] } });
            return;
        }
        if (path === "/api/drama/projects/p1/scenes" && method === "GET") {
            await route.fulfill({ json: { scenes: [] } });
            return;
        }
        if (path === "/api/studio/projects/p1/asset-ledger" && method === "GET") {
            await route.fulfill({ json: ledger });
            return;
        }
        if (path === "/api/studio/projects/p1/asset-ledger/apply" && method === "POST") {
            const body = request.postDataJSON() as Record<string, any>;
            posts.push(body);
            const receipt = {
                receipt_id: body.receipt_id, action: body.action, asset_key: body.asset_key,
                entity_id: body.entity_id || "", created_at: "2026-11-01T00:00:00",
            };
            const replayed = replayActions.has(body.action);
            if (!replayed) {
                receipts.push(receipt);
                ledger.receipts = receipts;
                ledger.suggestions = ledger.suggestions.filter(
                    (item: any) => !(item.asset_key === body.asset_key && item.action === body.action),
                );
                ledger.drifts = ledger.drifts.filter((item: any) => item.asset_key !== body.asset_key);
                ledger.assets = ledger.assets.map((asset: any) => asset.key === body.asset_key
                    ? { ...asset, status: "synced" } : asset);
            }
            await route.fulfill({
                json: {
                    applied: true, replayed, receipt,
                    entity: body.entity_id ? { id: body.entity_id, name: "林夏" } : { id: "e-new", name: "阿七" },
                },
            });
            return;
        }
        await route.fulfill({ status: 404, json: { detail: "unmocked" } });
    });
});

afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
});
afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

const visit = (path = "/drama/projects/p1/assets") =>
    page.goto(`http://127.0.0.1:${server.port}/?path=${encodeURIComponent(path)}`);
const openLedger = async () => {
    await page.getByRole("heading", { name: "资产", exact: true }).waitFor();
    await page.getByRole("button", { name: "对账", exact: true }).click();
    await page.getByRole("heading", { name: "跨集资产对账" }).waitFor();
};

test("ledger tab lists both episodes, drifts and deterministic suggestions, and jumps to the drill-down shot", async () => {
    await visit();
    await openLedger();

    await page.locator(".toiv-ledger-episode").first().waitFor();
    expect(await page.locator(".toiv-ledger-episode").count()).toBe(2);
    await page.getByText("第一集", { exact: true }).first().waitFor();
    await page.getByText("第二集", { exact: true }).waitFor();
    expect(await page.locator(".toiv-ledger-episode.is-current").count()).toBe(1);
    await page.getByText("同角色多版本").waitFor();
    await page.getByText("缺定妆").waitFor();
    await page.getByText("参考版本切换").waitFor();
    await page.getByText("归并进正典").waitFor();
    await page.getByText("新建正典").waitFor();
    expect(await page.getByText("待归并").count()).toBe(2);
    expect(await page.getByText("仅本集").count()).toBe(1);

    await page.getByRole("button", { name: "查看镜头" }).click();
    await page.getByText("镜头页 /studio/p1?shot=s1").waitFor();
    expect(await page.evaluate(() => window.__loc)).toBe("/studio/p1?shot=s1");
});

test("applying one suggestion posts the exact contract and keeps the later ledger truth", async () => {
    await visit();
    await openLedger();

    await page.getByRole("button", { name: "归并", exact: true }).click();
    await page.getByText(/已应用：林夏 · 归并进正典/).waitFor();

    expect(posts).toHaveLength(1);
    const body = posts[0];
    expect(Object.keys(body).sort()).toEqual(["action", "asset_key", "entity_id", "receipt_id"]);
    expect(body.action).toBe("merge");
    expect(body.asset_key).toBe("character:林夏");
    expect(body.entity_id).toBe("e1");
    expect(body.receipt_id.startsWith("ledger-")).toBe(true);

    await page.getByText(/回执 ledger-/).waitFor();
    await page.getByText("已同步").first().waitFor();
    expect(await page.locator(".toiv-ledger-suggestions li").count()).toBe(1);
    await page.getByText("新建正典").waitFor();
});

test("bulk confirm applies every suggestion once and reports idempotent replays", async () => {
    replayActions = new Set(["create"]);
    await visit();
    await openLedger();

    await page.getByRole("button", { name: /全部确认/ }).click();
    await page.getByText(/已确认 1 条建议，1 条为幂等重放/).waitFor();

    expect(posts).toHaveLength(2);
    expect(posts[0].receipt_id.endsWith(":character:林夏:merge")).toBe(true);
    expect(posts[1].receipt_id.endsWith(":character:阿七:create")).toBe(true);
    expect(posts[0].receipt_id.split(":")[0]).toBe(posts[1].receipt_id.split(":")[0]);
    expect("entity_id" in posts[1]).toBe(false);
});

test("the ledger stays inside a 390px viewport", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await visit();
    await openLedger();
    await page.getByText("归并进正典").waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
