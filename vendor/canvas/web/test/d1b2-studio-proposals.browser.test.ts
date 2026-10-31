import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-d1b2");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/d1b2-studio-proposals-harness.tsx")],
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
                    export async function estimateShotRender(sid) {
                        window.__d1b2Calls.push({ kind: "estimate", sid });
                        return {
                            schema: "toiv_render_estimate_v1", scope: "shot", project_id: "project-1", shot_id: sid,
                            allowed: true, blockers: [], warnings: [], input_fingerprint: "estimate-d1b2",
                            work: { shot_count: 1, candidate_upper_bound: 2, requested_duration_sec: 6, requested_frame_count: 144, pixel_frame_upper_bound: 1, image_motion_count: 0 },
                            items: [], pricing: { status: "unpriced", currency: null, total: null, rate_source: "none", unknowns: [] },
                            budget: { status: "unpriced", limit: null, currency: null },
                        };
                    }
                    export async function estimateBatchRender() { throw new Error("not used"); }
                    export async function fetchStageHistory() { return { history: [] }; }
                    export async function transitionProjectStage() { throw new Error("not used"); }
                    export async function fetchShotRevisions() { return { revisions: [] }; }
                    export async function fetchShotRevisionDiff() { return null; }
                    export async function rollbackShotRevision() { throw new Error("not used"); }
                    export async function saveStudioShots() { throw new Error("not used"); }
                    export async function pickShotCandidate() { throw new Error("not used"); }
                    export async function createRecipeFromShot() { throw new Error("not used"); }
                    export async function fetchRecipes() { return []; }
                    export async function fetchRecipe(rid) { return { id: rid }; }
                    export async function patchRecipe(rid) { return { id: rid }; }
                    export async function cloneRecipe(rid) { return { id: rid }; }
                    export async function setDefaultRecipe(rid) { return { id: rid }; }
                    export async function deleteRecipe() {}
                    export async function exportRecipe(rid) { return { id: rid }; }
                    export async function importRecipe(payload) { return payload; }
                    export async function fetchRecipeDiff(rid) { return { recipe_id: rid, fields: {}, render_params: {} }; }
                    export async function applyRecipe() { throw new Error("not used"); }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const extractedCss = (await Promise.all(build.outputs.filter((output) => output.path.endsWith(".css")).map((output) => output.text()))).join("\n");
    const sources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-local-overrides.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(sources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    const styles = [sources[0], sources[1], tailwindCss.css, sources[3], sources[4], extractedCss].join("\n");
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html class="dark"><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(path = "/"): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.on("pageerror", (error) => console.log("PAGEERROR:", error.message.slice(0, 300)));
    await page.goto(new URL(path, server.url).href);
    return page;
}

test("真实提案卡展示待人工动作、不宣称已执行；缺 shot 与 requiresHuman 守卫生效", async () => {
    const page = await openPage();
    const card = page.getByTestId("studio-proposal-studio-proposal-1");
    await card.waitFor({ state: "visible" });
    expect(await card.textContent()).toContain("雨夜巷口：请复核分镜");
    expect(await card.textContent()).toContain("两个候选尚未拍板");
    expect(await card.textContent()).toContain("待人工处理");
    expect(await card.textContent()).not.toContain("已执行");
    expect(await card.getByRole("link", { name: "不应出现的自动动作" }).count()).toBe(0);
    expect(await card.getByRole("link", { name: "缺镜头候选对比" }).count()).toBe(0);
    expect(await card.textContent()).toContain("信息不完整");
    expect(await card.getByRole("link", { name: "复核分镜" }).getAttribute("href")).toBe("/create?project=project-1&section=storyboard&stage=storyboard");
    expect(await card.getByRole("link", { name: "查看渲染预估" }).getAttribute("href")).toBe("/create?project=project-1&section=shots&shot=shot-1&panel=estimate");
    await page.screenshot({ path: "test-results/production-d1b2/studio-proposal-card-dark.png", animations: "disabled", fullPage: true });

    await card.getByRole("link", { name: "打开候选对比" }).click();
    const compare = page.getByTestId("take-compare-panel");
    await compare.waitFor({ state: "visible" });
    await page.getByTestId("take-candidate-candidate-a").waitFor({ state: "visible" });
    expect(await page.getByTestId("d1b2-url").textContent()).toContain("panel=compare");
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-d1b2/deep-link-take-compare-dark.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("initialPanel 随查询切换打开预估但不发渲染，shot 改变时重开对应候选", async () => {
    const page = await openPage("/create?project=project-1&section=shots&shot=shot-1&panel=estimate");
    const estimate = page.getByTestId("render-cost-estimate");
    await estimate.waitFor({ state: "visible" });
    await page.waitForFunction(() => document.querySelector("[data-testid=render-cost-estimate]")?.getAttribute("data-fingerprint") === "estimate-d1b2");
    expect((await page.evaluate(() => window.__d1b2Calls ?? [])).some((call) => call.kind === "render")).toBe(false);
    await page.screenshot({ path: "test-results/production-d1b2/deep-link-render-estimate-dark.png", animations: "disabled", fullPage: true });

    await page.getByRole("button", { name: "切到候选面板" }).click();
    await page.getByTestId("take-compare-panel").waitFor({ state: "visible" });
    await page.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "切到镜头 2" }).click();
    await page.getByTestId("take-candidate-candidate-c").waitFor({ state: "visible" });
    expect(await page.locator(".ant-drawer-title").textContent()).toContain("镜头 #2");
    expect((await page.evaluate(() => window.__d1b2Calls ?? [])).some((call) => call.kind === "render")).toBe(false);
    await page.close();
}, 30_000);

test("合法 stage 聚焦真实轨道，非法 stage 忽略且不伪造阶段状态", async () => {
    const valid = await openPage("/create?project=project-1&section=storyboard&stage=storyboard");
    await valid.getByTestId("creation-stage-track").waitFor({ state: "visible" });
    await valid.getByText("03 分镜", { exact: true }).waitFor({ state: "visible" });
    expect(await valid.getByRole("button", { name: /分镜/ }).getAttribute("aria-pressed")).toBe("true");
    await valid.close();

    const invalid = await openPage("/create?project=project-1&section=shots&stage=not-a-stage");
    await invalid.getByTestId("creation-stage-track").waitFor({ state: "visible" });
    await invalid.getByText("01 剧本", { exact: true }).waitFor({ state: "visible" });
    expect(await invalid.getByRole("button", { name: /剧本/ }).getAttribute("aria-pressed")).toBe("true");
    expect(await invalid.getByText("待确认", { exact: true }).count()).toBeGreaterThan(0);
    await invalid.close();
}, 30_000);
