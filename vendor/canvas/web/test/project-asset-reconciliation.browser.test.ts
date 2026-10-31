import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const webRoot = resolve(import.meta.dir, "..");
const shots = resolve(webRoot, "test-results/production-b1b");

type Mode = { light: boolean; failApply: boolean; failGet: boolean; empty: boolean; many: boolean };
type ApplyBody = { decisions: Array<{ candidateId: string; action: string; assetId?: string }> };

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let mode: Mode = { light: false, failApply: false, failGet: false, empty: false, many: false };
let applyBodies: ApplyBody[] = [];
let applyHits = 0;
let reconciliationGets = 0;
let oversizedBatches = 0;
let applied = false;

function resetHarnessState() {
    mode = { light: false, failApply: false, failGet: false, empty: false, many: false };
    applyBodies = [];
    applyHits = 0;
    reconciliationGets = 0;
    oversizedBatches = 0;
    applied = false;
}

function envelope(data: unknown, msg = "ok", code = 0, status = 200) {
    return new Response(JSON.stringify({ code, data, msg }), { status, headers: { "Content-Type": "application/json" } });
}

const projectAssets = [
    { id: "asset-linyao", title: "林遥", mediaType: "entity", category: "character", status: "confirmed", primaryVersionId: "ver-2", versionCount: 2, usages: [], position: 0, updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "asset-tiantai", title: "天台", mediaType: "image", category: "environment", status: "confirmed", primaryVersionId: "env-1", versionCount: 1, usages: [], position: 1, updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "asset-bianlidian", title: "便利店", mediaType: "image", category: "environment", status: "confirmed", primaryVersionId: "shop-1", versionCount: 1, usages: [], position: 2, updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "asset-heisan", title: "黑伞长柄", mediaType: "image", category: "prop", status: "confirmed", primaryVersionId: "umb-1", versionCount: 1, usages: [], position: 3, updatedAt: "2026-10-27T00:00:00.000Z" },
    { id: "asset-ayao", title: "阿遥", mediaType: "entity", category: "character", status: "confirmed", primaryVersionId: "ayao-1", versionCount: 1, usages: [], position: 4, updatedAt: "2026-10-27T00:00:00.000Z" },
];

function liveIdentities() {
    // 复审场景：成功处理后重新 GET，已归并实体组直接从台账移除——回执必须靠本轮快照显示名字。
    if (applied) return [];
    return [
        {
            key: "character:linyao",
            name: "林遥",
            category: "character",
            appearances: [
                { candidateId: "c-1-1", unitId: "unit-1", shotId: "shot-1-1", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? "asset-new-linyao" : undefined },
                { candidateId: "c-2-1", unitId: "unit-2", shotId: "shot-2-1", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? "asset-new-linyao" : undefined },
                { candidateId: "c-3-1", unitId: "unit-3", shotId: "shot-3-1", status: "confirmed", resolvedAssetId: "asset-linyao" },
            ],
            suggestion: { action: "merge", assetId: "asset-linyao", assetTitle: "林遥", match: "asset_name", reason: "候选与资产《林遥》名称一致，建议合并" },
        },
        {
            key: "prop:heisan",
            name: "黑伞",
            category: "prop",
            appearances: [
                { candidateId: "c-1-2", unitId: "unit-1", shotId: "shot-1-2", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? "asset-heisan" : undefined },
                { candidateId: "c-3-2", unitId: "unit-3", shotId: "shot-3-2", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? "asset-heisan" : undefined },
            ],
            suggestion: { action: "create", match: "none", reason: "未找到同名或同别名资产，建议新建资产后归并跨集出现" },
        },
        {
            key: "environment:tiantai",
            name: "天台",
            category: "environment",
            appearances: [
                { candidateId: "c-1-3", unitId: "unit-1", shotId: "shot-1-3", status: "confirmed", resolvedAssetId: "asset-tiantai" },
                { candidateId: "c-2-3", unitId: "unit-2", shotId: "shot-2-3", status: "confirmed", resolvedAssetId: "asset-tiantai" },
            ],
            suggestion: { action: "merge", assetId: "asset-tiantai", assetTitle: "天台", match: "resolved", reason: "同一实体已有归并结果，建议并入资产《天台》" },
        },
        {
            key: "character:ayao",
            name: "阿瑶",
            category: "character",
            appearances: [
                { candidateId: "c-1-4", unitId: "unit-1", shotId: "shot-1-4", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? "asset-ayao" : undefined },
            ],
            suggestion: { action: "merge", assetId: "asset-ayao", assetTitle: "阿遥", match: "asset_alias", reason: "候选与资产《阿遥》别名一致，建议合并" },
        },
    ];
}

function emptyIdentities() {
    return [
        {
            key: "environment:tiantai",
            name: "天台",
            category: "environment",
            appearances: [{ candidateId: "c-1-3", unitId: "unit-1", shotId: "shot-1-3", status: "confirmed", resolvedAssetId: "asset-tiantai" }],
            suggestion: { action: "merge", assetId: "asset-tiantai", assetTitle: "天台", match: "resolved", reason: "同一实体已有归并结果，建议并入资产《天台》" },
        },
    ];
}

function manyIdentities() {
    return Array.from({ length: 55 }, (_, index) => {
        const number = String(index + 1).padStart(2, "0");
        return {
            key: `prop:bulk-${number}`,
            name: `批量实体 ${number}`,
            category: "prop",
            appearances: [{ candidateId: `m-${number}`, unitId: "unit-1", status: applied ? "confirmed" : "pending_confirmation", resolvedAssetId: applied ? `asset-bulk-${number}` : undefined }],
            suggestion: { action: "create", match: "none", reason: "未找到同名或同别名资产，建议新建资产后归并跨集出现" },
        };
    });
}

function reconciliationPayload() {
    if (mode.empty) {
        return { units: [], drifts: [], candidateIdentities: emptyIdentities() };
    }
    if (mode.many) {
        return { units: [], drifts: [], candidateIdentities: manyIdentities() };
    }
    return {
        units: [
            {
                unitId: "unit-1",
                unitTitle: "第 1 集",
                kind: "episode",
                entries: [
                    {
                        assetId: "asset-linyao",
                        title: "林遥",
                        category: "character",
                        primaryVersionId: "ver-2",
                        versions: [
                            { versionId: "ver-1", version: 1, isPrimary: false, shotIds: ["shot-1-1"], roles: ["reference"] },
                            { versionId: "ver-2", version: 2, isPrimary: true, shotIds: ["shot-1-2", "shot-1-4"], roles: ["reference", "start_frame"] },
                        ],
                    },
                    {
                        assetId: "asset-tiantai",
                        title: "天台",
                        category: "environment",
                        primaryVersionId: "env-1",
                        versions: [{ versionId: "env-1", version: 1, isPrimary: true, shotIds: ["shot-1-3"], roles: ["reference"] }],
                    },
                ],
            },
            {
                unitId: "unit-2",
                unitTitle: "第 2 集",
                kind: "episode",
                entries: [
                    {
                        assetId: "asset-linyao",
                        title: "林遥",
                        category: "character",
                        primaryVersionId: "ver-2",
                        versions: [{ versionId: "ver-2", version: 2, isPrimary: true, shotIds: ["shot-2-1"], roles: ["reference"] }],
                    },
                ],
            },
            {
                unitId: "unit-3",
                unitTitle: "第 3 集",
                kind: "episode",
                entries: [],
            },
        ],
        drifts: [
            { kind: "reference_version_behind_primary", reason: "镜头引用的版本落后于资产当前主版本，旧集需要按新设定重渲", unitId: "unit-1", shotId: "shot-1-1", assetId: "asset-linyao", assetTitle: "林遥", versionIds: ["ver-1"] },
            { kind: "shot_missing_reference", reason: "镜头没有任何资产版本引用，生成时缺少角色/场景/道具锚点", unitId: "unit-2", shotId: "shot-2-9" },
            { kind: "asset_multi_version_reference", reason: "同一资产在项目内被多个版本引用，跨集形象可能不一致", assetId: "asset-linyao", assetTitle: "林遥", versionIds: ["ver-1", "ver-2"] },
            { kind: "stale_artifact", reason: "分镜或资产变更后产物已标记失效，需要重新渲染", unitId: "unit-2", shotId: "shot-2-1", artifactId: "artifact-9", artifactType: "storyboard" },
            { kind: "character_reference_missing_representation", reason: "角色引用版本没有定妆表现，出图缺少视觉锚点", unitId: "unit-1", shotId: "shot-1-1", assetId: "asset-linyao", assetTitle: "林遥", versionIds: ["ver-1"] },
            { kind: "reference_asset_unlinked", reason: "镜头引用的资产版本已不在项目素材中，需要重新绑定引用", unitId: "unit-3", shotId: "shot-3-2", versionIds: ["ver-gone"] },
            { kind: "shot_missing_reference", reason: "镜头没有任何资产版本引用，生成时缺少角色/场景/道具锚点", unitId: "unit-2" },
            { kind: "stale_artifact", reason: "分镜或资产变更后产物已标记失效，需要重新渲染", shotId: "shot-9-9", artifactId: "artifact-x", artifactType: "video" },
        ],
        candidateIdentities: liveIdentities(),
    };
}

function applyResults(body: ApplyBody) {
    const results: Array<{ candidateId: string; action: string; assetId?: string; outcome: string; candidateStatus: string }> = [];
    for (const decision of body.decisions) {
        if (decision.candidateId === "c-1-1") {
            results.push({ candidateId: "c-1-1", action: "create", assetId: "asset-new-linyao", outcome: "applied", candidateStatus: "confirmed" });
            results.push({ candidateId: "c-2-1", action: "merge", assetId: "asset-new-linyao", outcome: "auto_linked", candidateStatus: "confirmed" });
        } else if (decision.candidateId === "c-1-2") {
            results.push({ candidateId: "c-1-2", action: "merge", assetId: "asset-heisan", outcome: "applied", candidateStatus: "confirmed" });
            results.push({ candidateId: "c-3-2", action: "merge", assetId: "asset-heisan", outcome: "auto_linked", candidateStatus: "confirmed" });
        } else if (decision.candidateId === "c-1-4") {
            results.push({ candidateId: "c-1-4", action: "merge", assetId: "asset-ayao", outcome: "already_confirmed", candidateStatus: "confirmed" });
        } else {
            results.push({ candidateId: decision.candidateId, action: decision.action, assetId: decision.assetId, outcome: "applied", candidateStatus: "confirmed" });
        }
    }
    return results;
}

beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const cssSources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-local-overrides.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    const styles = [cssSources[0], cssSources[1], tailwindCss.css, cssSources[3], cssSources[4]].join("\n");

    const plugins: BunPlugin[] = [
        {
            name: "workspace-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/project-asset-reconciliation-harness.tsx")],
        plugins,
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({
                DEV: false,
                PROD: true,
                MODE: "production",
                BASE_URL: "/",
                VITE_CANVAS_LOCAL_MODE: "false",
                VITE_CANVAS_BACKEND_URL: "",
                VITE_APP_VERSION: "test",
                VITE_BUILD_COMMIT: "test",
                VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT: "",
            }),
        },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();

    server = Bun.serve({
        port: 0,
        async fetch(request) {
            const url = new URL(request.url);
            const path = url.pathname;
            if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (path === "/api/__harness/state") {
                return envelope({ mode, applyBodies, applyHits, reconciliationGets, oversizedBatches, applied });
            }
            if (path === "/api/projects/proj-b1b/asset-reconciliation" && request.method === "GET") {
                reconciliationGets += 1;
                if (mode.failGet) return envelope(null, "对账台账读取失败", 1);
                return envelope(reconciliationPayload());
            }
            if (path === "/api/projects/proj-b1b/asset-reconciliation/apply" && request.method === "POST") {
                applyHits += 1;
                const body = await request.json() as ApplyBody;
                applyBodies.push(body);
                // 与后端一致：单批超过 50 条决策直接拒绝，用来证明前端不会去撞上限。
                if (body.decisions.length > 50) {
                    oversizedBatches += 1;
                    return envelope(null, "一次最多确认 50 条归并决策", 1);
                }
                if (mode.failApply) return envelope(null, "归并失败：决策写入被拒绝", 1);
                applied = true;
                return envelope({ replayed: false, results: applyResults(body) });
            }
            if (path === "/api/projects/proj-b1b/assets" && request.method === "GET") {
                return envelope({ assets: projectAssets, categoryCounts: { character: 2, environment: 2, prop: 1 }, folderCounts: {}, page: 1, pageSize: 40, total: projectAssets.length, hasMore: false });
            }
            if (path === "/api/projects/proj-b1b/asset-folders") return envelope({ folders: [] });
            if (path === "/api/projects/proj-b1b/asset-candidates") return envelope({ candidates: [], page: 1, pageSize: 100, total: 0, hasMore: false });
            if (path === "/api/tasks") return envelope([]);
            if (path === "/api/skills") return envelope({ skills: [] });
            if (path.startsWith("/api/")) return envelope({ assets: [], folders: [], candidates: [] });
            // 只有文档路由才切换 mock 模式；favicon 等自动请求拿到外壳但不重置场景。
            if (path === "/" || path === "//") {
                const pageQuery = url.searchParams;
                mode = {
                    light: pageQuery.has("light"),
                    failApply: pageQuery.has("fail"),
                    failGet: pageQuery.has("getfail"),
                    empty: pageQuery.has("empty"),
                    many: pageQuery.has("many"),
                };
            }
            return new Response(`<!doctype html><html class="${mode.light ? "" : "dark"}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><style>*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground)}${styles}</style></head><body><script>if (!("Bun" in globalThis)) globalThis.Bun = {};</script><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });

    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 120_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openReconciliation(query = "") {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => console.error("reconciliation pageerror", error.message));
    await page.goto(`${server.url}${query}`);
    await page.getByRole("tab", { name: "跨集对账" }).click();
    await page.getByTestId("project-asset-reconciliation").waitFor({ timeout: 8_000 });
    return page;
}

async function harnessState() {
    const body = await fetch(`${server.url}/api/__harness/state`).then((response) => response.json()) as { data: { mode: Mode; applyBodies: ApplyBody[]; applyHits: number; reconciliationGets: number; oversizedBatches: number; applied: boolean } };
    return body.data;
}

async function waitForApplyHits(min: number) {
    const deadline = Date.now() + 5_000;
    while (Date.now() < deadline) {
        const state = await harnessState();
        if (state.applyHits >= min) return state;
        await Bun.sleep(25);
    }
    throw new Error(`apply did not reach ${min} hits`);
}

beforeEach(() => {
    resetHarnessState();
});

test("reconciliation panel shows per-episode inventories, readable drift labels and entity aggregation on the dark page", async () => {
    const page = await openReconciliation();
    expect(await page.getByTestId("project-asset-reconciliation").count()).toBe(1);

    // 逐集资产版本清单：集名、资产、版本与角色引用。
    await page.getByRole("heading", { name: "逐集资产版本清单" }).waitFor();
    expect(await page.getByText("第 1 集", { exact: true }).count()).toBeGreaterThanOrEqual(1);
    expect(await page.getByText("第 2 集", { exact: true }).count()).toBeGreaterThanOrEqual(1);
    const inventory = page.getByTestId("reconcile-inventory");
    expect(await inventory.getByText("林遥").count()).toBeGreaterThanOrEqual(1);
    expect(await inventory.getByText("主版本").count()).toBeGreaterThanOrEqual(1);
    expect(await inventory.getByText("reference、start_frame").count()).toBe(1);

    // 机器漂移：可读标签 + 原因，不出现伪造置信度或 ref epoch。
    const drifts = page.getByTestId("reconcile-drifts");
    for (const [label, count] of [["引用版本落后主版本", 1], ["镜头缺少资产引用", 2], ["跨集多版本引用", 1], ["产物已失效待重渲", 2], ["角色缺少定妆表现", 1], ["引用资产已不在项目", 1]] as const) {
        expect(await drifts.getByText(label, { exact: true }).count()).toBe(count);
    }
    expect(await drifts.getByText("镜头引用的版本落后于资产当前主版本，旧集需要按新设定重渲").count()).toBe(1);
    const driftsText = await drifts.innerText();
    expect(driftsText).not.toContain("置信");
    expect(driftsText.toLowerCase()).not.toContain("ref_epoch");

    // 候选按实体聚合：出现次数 + 集名。
    const linYao = page.getByTestId("reconcile-group-character:linyao");
    await linYao.waitFor();
    expect(await linYao.getByText("出现 3 次").count()).toBe(1);
    expect(await linYao.getByText("第 1 集、第 2 集、第 3 集").count()).toBe(1);
    expect(await linYao.getByText("名称一致", { exact: true }).count()).toBe(1);
    expect(await linYao.getByText("候选与资产《林遥》名称一致，建议合并").count()).toBe(1);
    expect(await linYao.getByRole("button", { name: "合并到已有资产" }).getAttribute("aria-pressed")).toBe("true");
    expect(await page.getByTestId("reconcile-group-character:ayao").getByText("别名一致", { exact: true }).count()).toBe(1);

    // 全部 confirmed 的组不必显示。
    expect(await page.getByTestId("reconcile-group-environment:tiantai").count()).toBe(0);

    // 真实 CSS 证据：token 色与工具类生效，暗色页。
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true);
    const styled = await linYao.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, display: style.display, radius: style.borderRadius };
    });
    expect(styled.display).toBe("flex");
    expect(styled.background).toBe("rgba(255, 255, 255, 0.1)");
    expect(styled.radius).not.toBe("0px");

    await page.screenshot({ path: `${shots}/asset-reconciliation-dark.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

test("inline merge/create override posts one pending decision per entity and renders receipts", async () => {
    const page = await openReconciliation();
    const linYao = page.getByTestId("reconcile-group-character:linyao");
    const umbrella = page.getByTestId("reconcile-group-prop:heisan");
    const ayao = page.getByTestId("reconcile-group-character:ayao");
    await umbrella.waitFor();

    // 改判 1：merge → create（林遥，后端建议合并到已有资产）。
    await linYao.getByRole("button", { name: "新建资产" }).click();
    expect(await linYao.getByRole("button", { name: "新建资产" }).getAttribute("aria-pressed")).toBe("true");
    expect(await linYao.getByRole("combobox").count()).toBe(0);

    // 改判 2：create → merge + 目标选择（黑伞，后端建议新建）。
    await umbrella.getByRole("button", { name: "合并到已有资产" }).click();
    await umbrella.getByRole("combobox").click();
    await page.getByTitle("黑伞长柄").click();
    expect(await umbrella.getByRole("button", { name: "合并到已有资产" }).getAttribute("aria-pressed")).toBe("true");

    // 改判 3（键盘）：阿瑶 merge → create，再键盘改回 merge，验证键盘可达。
    const ayaoCreate = ayao.getByRole("button", { name: "新建资产" });
    await ayaoCreate.focus();
    await page.keyboard.press("Enter");
    expect(await ayao.getByRole("button", { name: "新建资产" }).getAttribute("aria-pressed")).toBe("true");
    await ayao.getByRole("button", { name: "合并到已有资产" }).focus();
    await page.keyboard.press("Enter");
    expect(await ayao.getByRole("button", { name: "合并到已有资产" }).getAttribute("aria-pressed")).toBe("true");

    await page.getByRole("button", { name: "全部确认" }).click();
    const state = await waitForApplyHits(1);

    // 真实 HTTP mock 调用：每个实体只提交一条 pending 决策，改判生效。
    expect(state.applyBodies).toHaveLength(1);
    const decisions = state.applyBodies[0].decisions;
    expect(decisions).toHaveLength(3);
    expect(decisions).toContainEqual({ candidateId: "c-1-1", action: "create" });
    expect(decisions).toContainEqual({ candidateId: "c-1-2", action: "merge", assetId: "asset-heisan" });
    expect(decisions).toContainEqual({ candidateId: "c-1-4", action: "merge", assetId: "asset-ayao" });
    expect(decisions.map((entry) => entry.candidateId)).not.toContain("c-2-1");
    expect(decisions.map((entry) => entry.candidateId)).not.toContain("c-3-2");
    for (const key of ["c-1-1", "c-1-2", "c-1-4"]) {
        expect(decisions.filter((entry) => entry.candidateId === key)).toHaveLength(1);
    }

    // 逐项回执：applied / auto_linked / already_confirmed 都有可读文案；
    // 组随重新 GET 移除后，名字仍来自本轮快照，candidateStatus 用中文。
    const receipts = page.getByTestId("reconcile-receipts");
    await receipts.waitFor();
    expect(await receipts.getByText("已应用").count()).toBeGreaterThanOrEqual(1);
    expect(await receipts.getByText("同实体其他集已自动归并").count()).toBe(2);
    expect(await receipts.getByText("此前已确认").count()).toBe(1);
    expect(await receipts.getByText("林遥", { exact: true }).count()).toBeGreaterThanOrEqual(1);
    expect(await receipts.getByText("黑伞", { exact: true }).count()).toBeGreaterThanOrEqual(1);
    expect(await receipts.getByText("黑伞长柄", { exact: true }).count()).toBe(2);
    expect(await receipts.getByText("阿遥", { exact: true }).count()).toBe(1);
    expect(await receipts.getByText("已确认", { exact: true }).count()).toBeGreaterThanOrEqual(1);
    const receiptsText = await receipts.innerText();
    expect(receiptsText).not.toContain("c-1-1");
    expect(receiptsText).not.toContain("c-2-1");
    expect(receiptsText).not.toContain("pending_confirmation");

    // 处理后刷新：重新 GET 后已全部确认的组不再显示。
    expect((await harnessState()).reconciliationGets).toBeGreaterThanOrEqual(2);
    await page.getByTestId("reconcile-groups-empty").waitFor();
    expect(await page.getByTestId("reconcile-group-character:linyao").count()).toBe(0);
    expect(await page.getByTestId("reconcile-group-prop:heisan").count()).toBe(0);
    expect(await receipts.getByText("已应用").count()).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: `${shots}/asset-reconciliation-receipts-dark.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 45_000);

test("apply failure keeps decisions editable and surfaces the server message", async () => {
    const page = await openReconciliation("?fail=1");
    await page.getByTestId("reconcile-group-prop:heisan").waitFor();
    await page.getByRole("button", { name: "全部确认" }).click();
    await waitForApplyHits(1);
    const error = page.getByTestId("reconcile-apply-error");
    await error.waitFor();
    expect(await error.innerText()).toContain("归并失败：决策写入被拒绝");
    expect(await page.getByTestId("reconcile-group-character:linyao").count()).toBe(1);
    expect(await page.getByTestId("reconcile-group-prop:heisan").count()).toBe(1);
    await page.screenshot({ path: `${shots}/asset-reconciliation-apply-error-dark.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

test("read failures show recovery and the empty state explains there is nothing to reconcile", async () => {
    const failed = await openReconciliation("?getfail=1");
    const loadError = failed.getByTestId("reconcile-load-error");
    await loadError.waitFor();
    expect(await loadError.innerText()).toContain("对账台账读取失败");
    expect(await failed.getByRole("button", { name: "重试" }).count()).toBe(1);
    await failed.screenshot({ path: `${shots}/asset-reconciliation-load-error-dark.png`, fullPage: true, animations: "disabled" });
    await failed.close();

    const empty = await openReconciliation("?empty=1");
    const emptyState = empty.getByTestId("reconcile-empty");
    await emptyState.waitFor();
    expect(await emptyState.innerText()).toContain("当前没有需要处理的跨集差异");
    expect(await empty.getByTestId("reconcile-group-character:linyao").count()).toBe(0);
    await empty.screenshot({ path: `${shots}/asset-reconciliation-empty-dark.png`, fullPage: true, animations: "disabled" });
    await empty.close();
}, 30_000);

test("light page keeps the same semantics on the light token palette", async () => {
    const page = await openReconciliation("?light=1");
    const linYao = page.getByTestId("reconcile-group-character:linyao");
    await linYao.waitFor();
    expect(await page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(false);
    const styled = await linYao.evaluate((element) => {
        const style = getComputedStyle(element);
        return { background: style.backgroundColor, display: style.display };
    });
    expect(styled.display).toBe("flex");
    expect(styled.background).toBe("rgba(17, 17, 17, 0.09)");
    expect(await page.getByRole("heading", { name: "跨集资产对账" }).count()).toBe(1);
    expect(await page.getByTestId("reconcile-group-character:linyao").getByText("出现 3 次").count()).toBe(1);
    await page.screenshot({ path: `${shots}/asset-reconciliation-light.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

async function openChapter(query = "") {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    page.on("pageerror", (error) => console.error("chapter pageerror", error.message));
    await page.goto(`${server.url}${query}`);
    await page.getByTestId("chapter-shot-anchor").waitFor({ timeout: 8_000 });
    return page;
}

test("merge targets only offer assets inside the entity category", async () => {
    const page = await openReconciliation();
    const umbrella = page.getByTestId("reconcile-group-prop:heisan");
    await umbrella.waitFor();
    await umbrella.getByRole("button", { name: "合并到已有资产" }).click();
    await umbrella.getByRole("combobox").click();
    const openOptions = page.locator(".ant-select-dropdown:visible .ant-select-item-option[title]");
    await openOptions.first().waitFor();
    const propTitles = (await openOptions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") || ""))).sort();
    expect(propTitles).toEqual(["黑伞长柄"]);
    await page.screenshot({ path: `${shots}/asset-reconciliation-category-filter-dark.png`, fullPage: true, animations: "disabled" });
    await page.keyboard.press("Escape");

    const linYao = page.getByTestId("reconcile-group-character:linyao");
    await linYao.getByRole("combobox").click();
    await openOptions.first().waitFor();
    const characterTitles = (await openOptions.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("title") || ""))).sort();
    expect(characterTitles).toEqual(["林遥", "阿遥"].sort());
    await page.close();
}, 30_000);

test("drift rows deep-link to the chapter workspace and the link lands on the shot", async () => {
    const page = await openReconciliation();
    const drifts = page.getByTestId("reconcile-drifts");
    await drifts.waitFor();
    // unit + shot → 章工作区 + shot query。
    expect(await drifts.locator('a[href="/projects/proj-b1b/chapters/unit-1?shot=shot-1-1"]').count()).toBeGreaterThanOrEqual(1);
    // 只有 unitId → 章工作区不带 query。
    expect(await drifts.locator('a[href="/projects/proj-b1b/chapters/unit-2"]').count()).toBe(1);
    // 没有 unitId 的漂移（仅 shotId / 资产级）不放假链接。
    expect(await drifts.locator("article", { hasText: "shot-9-9" }).locator("a").count()).toBe(0);
    expect(await drifts.locator("article", { hasText: "跨集多版本引用" }).locator("a").count()).toBe(0);
    await page.screenshot({ path: `${shots}/asset-reconciliation-drift-links-dark.png`, fullPage: true, animations: "disabled" });

    await drifts.locator('a[href="/projects/proj-b1b/chapters/unit-1?shot=shot-1-1"]').first().click();
    await page.getByTestId("chapter-shot-anchor").waitFor({ timeout: 8_000 });
    const selected = page.locator('[aria-current="true"]');
    await selected.waitFor();
    expect(await selected.innerText()).toContain("雨夜对峙");
    await page.screenshot({ path: `${shots}/asset-reconciliation-drift-link-target-dark.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 30_000);

test("chapter workspace consumes the shot query with selection and positioning", async () => {
    const page = await openChapter("?chapter=1&shot=shot-1-12");
    const selected = page.locator('[aria-current="true"]');
    await selected.waitFor();
    expect(await selected.innerText()).toContain("镜头 12");
    const geometry = await page.evaluate(() => {
        const strip = document.querySelector('[data-testid="chapter-shot-anchor"]')!;
        const chip = document.querySelector('[aria-current="true"]')!;
        const stripBox = strip.getBoundingClientRect();
        const chipBox = chip.getBoundingClientRect();
        return { stripLeft: stripBox.left, stripRight: stripBox.right, chipLeft: chipBox.left, chipRight: chipBox.right };
    });
    expect(geometry.chipLeft).toBeGreaterThanOrEqual(geometry.stripLeft - 1);
    expect(geometry.chipRight).toBeLessThanOrEqual(geometry.stripRight + 1);
    await page.screenshot({ path: `${shots}/chapter-shot-focus-dark.png`, fullPage: true, animations: "disabled" });

    await page.getByRole("button", { name: "雨夜对峙" }).click();
    await page.getByRole("button", { name: "雨夜对峙" }).waitFor();
    expect(await page.locator('[aria-current="true"]').innerText()).toContain("雨夜对峙");

    const missing = await openChapter("?chapter=1&shot=shot-gone");
    const notice = missing.getByTestId("chapter-shot-missing");
    await notice.waitFor();
    expect(await notice.innerText()).toContain("已不在本章");
    expect(await missing.locator('[aria-current="true"]').count()).toBe(0);
    await missing.screenshot({ path: `${shots}/chapter-shot-missing-dark.png`, fullPage: true, animations: "disabled" });
    await missing.close();
    await page.close();
}, 45_000);

test("over-cap entity batches split safely instead of sending one failing request", async () => {
    const page = await openReconciliation("?many=1");
    const groups = page.locator('[data-testid^="reconcile-group-"]');
    await groups.first().waitFor();
    expect(await groups.count()).toBe(55);
    const hint = page.getByTestId("reconcile-batch-hint");
    await hint.waitFor();
    expect(await hint.innerText()).toContain("分 2 批");
    await page.getByRole("button", { name: "全部确认" }).click();
    const state = await waitForApplyHits(2);
    expect(state.oversizedBatches).toBe(0);
    expect(state.applyBodies.map((body) => body.decisions.length).sort((left, right) => left - right)).toEqual([5, 50]);
    const submitted = new Set(state.applyBodies.flatMap((body) => body.decisions.map((decision) => decision.candidateId)));
    expect(submitted.size).toBe(55);
    const receipts = page.getByTestId("reconcile-receipts");
    await receipts.waitFor();
    expect(await receipts.locator("li").count()).toBe(55);
    await page.screenshot({ path: `${shots}/asset-reconciliation-batch-many-dark.png`, fullPage: true, animations: "disabled" });
    await page.close();
}, 45_000);
