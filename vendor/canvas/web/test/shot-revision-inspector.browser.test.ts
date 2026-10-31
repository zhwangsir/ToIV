import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// C1a 修订 Inspector 真实渲染验证:编辑保存 / 409 冲突 / 修订历史 diff / 回滚 / stale 徽章与重渲按钮。
// 组件依赖 @/services/toiv/client 的四个真实 API 封装,由插件 stub 成可断言的内存实现。
const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-c1a");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

type ToivCall = { kind: string; [key: string]: unknown };

async function expectVisible(locator: Locator, label: string): Promise<void> {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
    expect(await locator.isVisible(), label).toBe(true);
}

/** 文本色与其有效背景(向上找第一个非透明背景)的 WCAG 对比度 */
async function contrastRatio(page: Page, locator: Locator): Promise<number> {
    const handle = await locator.elementHandle();
    expect(handle, "对比度目标元素存在").not.toBeNull();
    return page.evaluate((el) => {
        const parse = (raw: string): [number, number, number] | null => {
            const m = raw.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const parts = m[1].split(",").map((x) => Number(x.trim()));
            if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
            return [parts[0], parts[1], parts[2]];
        };
        const luminance = (rgb: [number, number, number]) => {
            const f = (c: number) => {
                const s = c / 255;
                return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        if (!(el instanceof Element)) return 0;
        const fg = parse(getComputedStyle(el).color);
        let bg: [number, number, number] | null = null;
        let node: Element | null = el;
        while (node) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c && (getComputedStyle(node).backgroundColor.startsWith("rgb(") || Number(getComputedStyle(node).backgroundColor.split(",")[3]) > 0)) {
                bg = c;
                break;
            }
            node = node.parentElement;
        }
        if (!fg || !bg) return 0;
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }, handle);
}

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const cssSources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    styles = [cssSources[0], cssSources[1], tailwindCss.css, cssSources[3]].join("\n");

    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/shot-revision-inspector-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({
                DEV: false, PROD: true, MODE: "production", BASE_URL: "/",
                VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "",
                VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test",
            }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({
                contents: `
                    export async function estimateBatchRender() { throw new Error("batch estimate not used in C1a harness"); }
                    export async function estimateShotRender(sid) {
                        return {
                            schema: "toiv_render_estimate_v1", scope: "shot", project_id: "p1", shot_id: sid,
                            allowed: true, blockers: [], warnings: [], input_fingerprint: "c1a-stub",
                            work: { shot_count: 1, candidate_upper_bound: 2, requested_duration_sec: 6, requested_frame_count: 144, pixel_frame_upper_bound: 1, image_motion_count: 0 },
                            items: [], pricing: { status: "unpriced", currency: null, total: null, rate_source: "none", unknowns: [] },
                            budget: { status: "unpriced", limit: null, currency: null },
                        };
                    }
                    export async function saveStudioShots(pid, payload) {
                        window.__toivCalls.push({ kind: "save", pid, payload });
                        const stub = window.__toivStub ?? {};
                        if (stub.saveMode === "conflict") {
                            const err = new Error("Request failed with status code 409");
                            err.response = { status: 409, data: { detail: "分镜已被其他修改更新(current=rev-other)" } };
                            throw err;
                        }
                    }
                    export async function fetchShotRevisions(sid) {
                        window.__toivCalls.push({ kind: "revisions", sid });
                        return { shot_id: sid, revisions: (window.__toivStub ?? {}).revisions ?? [] };
                    }
                    export async function fetchShotRevisionDiff(sid, rid) {
                        window.__toivCalls.push({ kind: "diff", sid, rid });
                        return (window.__toivStub ?? {}).diff ?? null;
                    }
                    export async function rollbackShotRevision(sid, revisionId, expectedRevision) {
                        window.__toivCalls.push({ kind: "rollback", sid, revisionId, expectedRevision });
                        return { id: sid };
                    }
                    export async function pickShotCandidate(sid, cid, expectedDigest) {
                        window.__toivCalls.push({ kind: "pick", sid, cid, expectedDigest });
                        return { id: sid };
                    }
                    // C1b:ShotRevisionInspector 引入 ShotRecipePanel,需同名导出(内存桩)
                    export async function createRecipeFromShot(shotId, opts) {
                        window.__toivCalls.push({ kind: "from-shot", shotId, opts });
                        return { id: "r-x", name: opts?.name || "配方", description: opts?.description || "", engine: "h3", render_mode: "video", pipeline: "ref2va", pick_strategy: "auto_best", snapshot: {}, source_revision_id: "", source_shot_id: shotId, is_default: false, created_at: "", updated_at: "" };
                    }
                    export async function fetchRecipes() { return []; }
                    export async function fetchRecipe(rid) { return { id: rid }; }
                    export async function patchRecipe(rid, patch) { window.__toivCalls.push({ kind: "patch-recipe", rid, patch }); return { id: rid }; }
                    export async function cloneRecipe(rid, name) { window.__toivCalls.push({ kind: "clone-recipe", rid, name }); return { id: "r-clone" }; }
                    export async function setDefaultRecipe(rid) { window.__toivCalls.push({ kind: "set-default", rid }); return { id: rid, is_default: true }; }
                    export async function deleteRecipe(rid) { window.__toivCalls.push({ kind: "delete-recipe", rid }); }
                    export async function exportRecipe(rid) { window.__toivCalls.push({ kind: "export-recipe", rid }); return { schema: "toiv_generation_recipe_v1", name: "x", description: "", engine: "h3", render_mode: "video", pipeline: "ref2va", pick_strategy: "auto_best", snapshot: {}, exported_at: "" }; }
                    export async function importRecipe(payload) { window.__toivCalls.push({ kind: "import-recipe", payload }); return { id: "r-i" }; }
                    export async function fetchRecipeDiff(rid, shotId) { window.__toivCalls.push({ kind: "recipe-diff", rid, shotId }); return { recipe_id: rid, shot_id: shotId, fields: {}, render_params: {} }; }
                    export async function applyRecipe(rid, body) { window.__toivCalls.push({ kind: "apply-recipe", rid, body }); return { shot: { id: body.shot_id }, render_params: {}, applied_fields: [], project_specs_changed: [] }; }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(light = false, height = 900): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height } });
    await page.goto(light ? `${server.url.href}?light=1` : server.url.href);
    await expectVisible(page.getByTestId("inspector-aside").getByRole("button", { name: "修订历史" }), "修订历史入口");
    return page;
}

async function calls(page: Page): Promise<ToivCall[]> {
    return page.evaluate(() => window.__toivCalls ?? []) as Promise<ToivCall[]>;
}

test("stale 徽章(视觉待重渲/配音待重录)与重渲/重配音按钮", async () => {
    const page = await openPage();
    const aside = page.getByTestId("inspector-aside");
    const badges = aside.getByTestId("shot-media-badges");
    await expectVisible(badges.getByText("视觉待重渲"), "视觉待重渲徽章");
    await expectVisible(badges.getByText("配音待重录"), "配音待重录徽章");
    await aside.getByRole("button", { name: "重渲染" }).click();
    await aside.getByRole("button", { name: "重配音" }).click();
    const kinds = (await calls(page)).map((c) => `${c.kind}:${c.sid}`);
    expect(kinds).toContain("render:shot-b");
    expect(kinds).toContain("voice:shot-b");
    await page.getByTestId("inspector-aside").screenshot({ path: "test-results/production-c1a/inspector-stale.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("编辑提示语 → 全量 PUT 每镜 expected_revision + 成功回执", async () => {
    const page = await openPage();
    const aside = page.getByTestId("inspector-aside");
    await aside.getByRole("button", { name: "编辑提示语" }).click();
    const box = aside.getByTestId("shot-revision-edit-textarea");
    await box.fill("霓虹雨夜 · 新提示语");
    await aside.getByRole("button", { name: "保存" }).click();
    const msg = page.getByTestId("shot-revision-message");
    await expectVisible(msg, "保存成功回执");
    expect(await msg.textContent()).toContain("已保存并建立新修订");
    const saved = (await calls(page)).find((c) => c.kind === "save");
    expect(saved?.pid).toBe("p1");
    const payload = saved?.payload as { id: string; prompt: string; expected_revision?: string }[];
    expect(payload.map((x) => x.id)).toEqual(["shot-a", "shot-b", "shot-d", "shot-c"]);
    expect(payload[1].prompt).toBe("霓虹雨夜 · 新提示语");
    expect(payload[0].prompt).toBe("a 提示语");
    // 每镜 expected_revision = current_revision_id(旧行空串)
    expect(payload[0].expected_revision).toBe("rev-a1");
    expect(payload[1].expected_revision).toBe("rev-b2");
    expect(payload[2].expected_revision).toBe("rev-d1");
    expect(payload[3].expected_revision).toBe("");
    const savedCount = await page.evaluate(() => window.__savedCount ?? 0);
    expect(savedCount).toBeGreaterThanOrEqual(1);
    await page.getByTestId("inspector-aside").screenshot({ path: "test-results/production-c1a/inspector-saved.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("409 冲突 → 显示冲突且本地草稿不覆盖服务端", async () => {
    const page = await openPage();
    await page.evaluate(() => {
        (window.__toivStub ?? {}).saveMode = "conflict";
    });
    const aside = page.getByTestId("inspector-aside");
    await aside.getByRole("button", { name: "编辑台词" }).click();
    await aside.getByTestId("shot-revision-edit-textarea").fill("新台词(会被 409 拒绝)");
    await aside.getByRole("button", { name: "保存" }).click();
    const msg = page.getByTestId("shot-revision-message");
    await expectVisible(msg, "冲突提示");
    expect(await msg.textContent()).toContain("分镜已被其他修改更新");
    // 草稿被丢弃(编辑框关闭),服务端值不被覆盖
    expect(await aside.getByTestId("shot-revision-edit-textarea").count()).toBe(0);
    await expectVisible(aside.getByText("别跟着我"), "服务端原台词仍在");
    await page.getByTestId("inspector-aside").screenshot({ path: "test-results/production-c1a/inspector-conflict.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("final stale:成片待重合成徽章 + 重对口型入口(success 成片段不伪装)", async () => {
    const page = await openPage();
    const badges = page.getByTestId("shot-media-badges");
    await expectVisible(badges.getByText("成片待重合成"), "成片待重合成徽章");
    // final stale 时 success 态「成片段」不得出现(不伪装最新)
    expect(await badges.getByText("成片段", { exact: true }).count()).toBe(0);
    await page.getByRole("button", { name: "重对口型" }).click();
    const kinds = (await calls(page)).map((c) => `${c.kind}:${c.sid}`);
    expect(kinds).toContain("lipsync:shot-b");
    await page.getByTestId("inspector-aside").screenshot({ path: "test-results/production-c1a/inspector-final-stale.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("口型操作统一:同屏只有一个口型主操作,跳过口型仍可用(真实 parent 路径)", async () => {
    const page = await openPage();
    const stale = page.getByTestId("inspector-aside");
    // final stale 镜:唯一主操作为「重对口型」,不得同屏出现 legacy「对口型」
    await expectVisible(stale.getByRole("button", { name: "重对口型" }), "final stale 重对口型");
    expect(await stale.getByRole("button", { name: "对口型", exact: true }).count()).toBe(0);
    // 跳过口型仍可用,走 parent runSkipLipsync 真实回调
    await stale.getByRole("button", { name: "跳过口型" }).click();
    // 普通已配音镜(非 final stale):唯一主操作为「对口型」,无「重对口型」
    const normal = page.getByTestId("inspector-aside-normal");
    await expectVisible(normal.getByRole("button", { name: "对口型", exact: true }), "普通镜对口型");
    expect(await normal.getByRole("button", { name: "重对口型" }).count()).toBe(0);
    const kinds = (await calls(page)).map((c) => `${c.kind}:${c.sid}`);
    expect(kinds).toContain("skip:shot-b");
    await page.close();
}, 30_000);

test("修订历史:列表版本/source/时间 → diff before/after → 回滚 POST(暗色对比度)", async () => {
    const page = await openPage(false, 460);
    await page.getByTestId("inspector-aside").getByRole("button", { name: "修订历史" }).click();
    const drawer = page.getByTestId("shot-revision-history");
    await expectVisible(drawer.getByText("v2 · 手工编辑"), "v2 手工编辑条目");
    await expectVisible(drawer.getByText("v1 · 导入"), "v1 导入条目");
    // 暗色验收:抽屉标题/正文文字对抽屉背景对比度 >= 4.5(挂真实 ConfigProvider 主题后必达)
    const titleContrast = await contrastRatio(page, page.locator(".ant-drawer-title"));
    expect(titleContrast, `抽屉标题对比度 ${titleContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    const itemContrast = await contrastRatio(page, drawer.getByText("v2 · 手工编辑"));
    expect(itemContrast, `修订条目文字对比度 ${itemContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1a/history-drawer.png", animations: "disabled" });
    // 选中 v2 → diff 拉取并展示 before/after
    await drawer.getByText("v2 · 手工编辑").click();
    const diff = page.getByTestId("revision-diff");
    await expectVisible(diff, "diff 面板");
    const diffText = await diff.textContent();
    expect(diffText).toContain("提示语");
    expect(diffText).toContain("雨夜霓虹旧稿");
    expect(diffText).toContain("雨夜霓虹");
    const diffLabelContrast = await contrastRatio(page, diff.locator("p.font-medium").first());
    expect(diffLabelContrast, `diff 字段标签对比度 ${diffLabelContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1a/history-diff.png", animations: "disabled" });
    // 回滚:真实 POST /rollback,刷新回调触发
    await drawer.locator("button").filter({ hasText: "回滚到此版本" }).first().click();
    await page.waitForFunction(() => (window.__toivCalls ?? []).some((c) => c.kind === "rollback"), undefined, { timeout: 10_000 });
    const rollback = (await calls(page)).find((c) => c.kind === "rollback");
    expect(rollback).toMatchObject({ sid: "shot-b", revisionId: "rev-b2", expectedRevision: "rev-b2" });
    const savedCount = await page.evaluate(() => window.__savedCount ?? 0);
    expect(savedCount).toBeGreaterThanOrEqual(1);
    await page.close();
}, 30_000);
