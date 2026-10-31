import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-d1b");
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

const STUB_CLIENT = `
    const calls = () => window.__d1bCalls;
    const stub = () => window.__d1bStub;
    export async function estimateBatchRender() { throw new Error("not used"); }
    export async function estimateShotRender() { throw new Error("not used"); }
    export async function saveStudioShots() { return undefined; }
    export async function fetchShotRevisions() { return { revisions: [] }; }
    export async function fetchShotRevisionDiff() { return null; }
    export async function rollbackShotRevision() { return null; }
    export async function createRecipeFromShot() { return null; }
    export async function fetchRecipes() { return []; }
    export async function fetchRecipe() { return null; }
    export async function patchRecipe() { return null; }
    export async function cloneRecipe() { return null; }
    export async function setDefaultRecipe() { return null; }
    export async function deleteRecipe() { return null; }
    export async function exportRecipe() { return null; }
    export async function importRecipe() { return null; }
    export async function fetchRecipeDiff() { return null; }
    export async function applyRecipe() { return null; }
    export async function pickShotCandidate(sid, cid, expectedDigest) {
        calls().push({ kind: "pick", sid, cid, expectedDigest });
        if (stub().pickMode === "pending") {
            await new Promise((resolve) => { window.__d1bPendingResolve = resolve; });
        }
        if (stub().pickMode === "conflict") {
            const error = new Error("候选列表已变化，请刷新后重试");
            error.response = { status: 409, data: { detail: "候选列表已变化，请刷新后重试" } };
            throw error;
        }
        return window.__d1bRefreshedShot ?? { id: sid, idx: 2, status: "rendered" };
    }
`;

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/d1b-take-compare-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test" }),
        },
        plugins: [{ name: "d1b-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({ contents: STUB_CLIENT, loader: "ts" }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs.find((output) => output.path.endsWith(".js"))!.text();
    const cssSources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
        Bun.file(resolve(webRoot, "src/components/toiv/take-compare-panel.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    const styles = [cssSources[0], cssSources[1], tailwindCss.css, cssSources[3], cssSources[4]].join("\n");
    const media = readFileSync(resolve(import.meta.dir, "fixtures/d1b-media/neutral.mp4"));
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
            if (path === "/media/neutral.mp4") return new Response(media, { headers: { "Content-Type": "video/mp4" } });
            return new Response(`<html class="dark"><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true, args: ["--disable-gpu"] });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await page.goto(server.url.href);
    await page.getByRole("button", { name: "候选对比" }).waitFor({ state: "visible" });
    return page;
}

async function openCompare(page: Page) {
    await page.getByRole("button", { name: "候选对比" }).click();
    const panel = page.getByTestId("take-compare-panel");
    await panel.waitFor({ state: "visible" });
    return panel;
}

test("两候选真实并排，元数据/无 URL 状态诚实，当前采用唯一", async () => {
    const page = await openPage();
    const panel = await openCompare(page);
    expect(await panel.locator("video").count()).toBe(2);
    await page.waitForFunction(() => Array.from(document.querySelectorAll("video")).every((video) => video.readyState >= 1));
    const a = panel.getByTestId("take-candidate-cand-a");
    const b = panel.getByTestId("take-candidate-cand-b");
    expect(await a.textContent()).toContain("101");
    expect(await a.textContent()).toContain("h3-neutral-a");
    expect(await a.textContent()).toContain("ref2va");
    expect(await a.textContent()).toContain("rev-a");
    expect(await a.textContent()).toContain("pass");
    expect(await b.textContent()).toContain("202");
    expect(await b.locator("dt").filter({ hasText: "revision_id" }).count()).toBe(1);
    expect(await b.locator("dd").filter({ hasText: /^无$/ }).count()).toBe(1);
    expect(await b.textContent()).toContain("warn");
    expect(await panel.getByText("当前采用", { exact: true }).count()).toBe(1);
    expect(await panel.getByTestId("take-candidate-cand-error").textContent()).toContain("本地产物缺失");
    expect(await panel.getByTestId("take-candidate-cand-queued").textContent()).toContain("queued");
    expect(await panel.getByTestId("take-pick-cand-error").isDisabled()).toBe(true);
    expect(await panel.getByTestId("take-pick-cand-queued").isDisabled()).toBe(true);
    const [aBox, bBox] = await Promise.all([a.boundingBox(), b.boundingBox()]);
    expect(aBox).not.toBeNull();
    expect(bBox).not.toBeNull();
    expect(Math.abs(aBox!.y - bBox!.y)).toBeLessThan(2);
    expect(bBox!.x).toBeGreaterThan(aBox!.x);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-d1b/candidates-side-by-side.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("全部播放/暂停操作真实 video；autoplay 拒绝可见", async () => {
    const page = await openPage();
    const panel = await openCompare(page);
    await panel.getByRole("button", { name: "全部播放" }).click();
    await page.waitForFunction(() => Array.from(document.querySelectorAll("video")).every((video) => !video.paused && video.currentTime > 0));
    await panel.getByRole("button", { name: "全部暂停" }).click();
    expect(await panel.locator("video").evaluateAll((videos) => videos.every((video) => (video as HTMLVideoElement).paused))).toBe(true);
    await page.close();

    const rejected = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await rejected.addInitScript(() => {
        HTMLMediaElement.prototype.play = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
    });
    await rejected.goto(server.url.href);
    const rejectedPanel = await openCompare(rejected);
    await rejectedPanel.getByRole("button", { name: "全部播放" }).click();
    await rejectedPanel.getByTestId("take-playback-message").waitFor({ state: "visible" });
    expect(await rejectedPanel.getByTestId("take-playback-message").textContent()).toContain("浏览器未允许自动播放");
    await rejected.close();
}, 30_000);

test("拍板只传当前 digest，pending 防重，成功后由刷新真值移动唯一采用", async () => {
    const page = await openPage();
    const panel = await openCompare(page);
    await page.evaluate(() => {
        const current = window.__d1bRefreshedShot;
        window.__d1bStub = { pickMode: "pending" };
        window.__d1bRefreshedShot = current;
    });
    await page.evaluate(() => {
        const panel = document.querySelector('[data-testid="take-compare-panel"]');
        void panel;
        const candidates = [
            { id: "cand-a", url: "/media/neutral.mp4?candidate=a", seed: 101, status: "done", is_picked: false },
            { id: "cand-b", url: "/media/neutral.mp4?candidate=b", seed: 202, status: "done", is_picked: true },
        ];
        window.__d1bRefreshedShot = { id: "shot-b", idx: 2, status: "rendered", candidates_digest: "digest-2", candidates };
    });
    const pick = panel.getByTestId("take-pick-cand-b");
    await pick.click();
    expect(await pick.isDisabled()).toBe(true);
    await pick.evaluate((button) => (button as HTMLButtonElement).click());
    expect((await page.evaluate(() => window.__d1bCalls ?? [])).filter((call) => call.kind === "pick")).toHaveLength(1);
    expect((await page.evaluate(() => window.__d1bCalls ?? []))[0]).toMatchObject({ sid: "shot-b", cid: "cand-b", expectedDigest: "digest-1" });
    await page.evaluate(() => window.__d1bPendingResolve?.());
    await page.waitForFunction(() => (window.__d1bSavedCount ?? 0) === 1);
    await panel.getByTestId("take-candidate-cand-b").getByText("当前采用", { exact: true }).waitFor({ state: "visible" });
    expect(await panel.getByText("当前采用", { exact: true }).count()).toBe(1);
    expect(await panel.getByTestId("take-candidate-cand-b").getByText("当前采用", { exact: true }).count()).toBe(1);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-d1b/picked-unique-after-refresh.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("409 显示冲突并刷新，Inspector 未保存草稿不被覆盖", async () => {
    const page = await openPage();
    const inspector = page.getByTestId("d1b-inspector");
    await inspector.getByRole("button", { name: "编辑提示语" }).click();
    await inspector.getByTestId("shot-revision-edit-textarea").fill("保留我的未保存草稿");
    await page.evaluate(() => {
        window.__d1bStub = { pickMode: "conflict" };
        window.__d1bRefreshedShot = {
            id: "shot-b", idx: 2, status: "rendered", candidates_digest: "digest-other",
            prompt: "服务端新提示",
            candidates: [
                { id: "cand-a", url: "/media/neutral.mp4?candidate=a", status: "done", is_picked: false },
                { id: "cand-b", url: "/media/neutral.mp4?candidate=b", status: "done", is_picked: true },
            ],
        };
    });
    const panel = await openCompare(page);
    await panel.getByTestId("take-pick-cand-b").click();
    const conflict = panel.getByTestId("take-compare-conflict");
    await conflict.waitFor({ state: "visible" });
    expect(await conflict.textContent()).toContain("候选列表已变化");
    expect(await page.evaluate(() => window.__d1bSavedCount ?? 0)).toBe(1);
    expect(await inspector.getByTestId("shot-revision-edit-textarea").inputValue()).toBe("保留我的未保存草稿");
    expect(await panel.getByTestId("take-candidate-cand-b").getByText("当前采用", { exact: true }).count()).toBe(1);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-d1b/conflict-refresh.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("digest 改变后，旧 pending 回包不触发成功或刷新", async () => {
    const page = await openPage();
    const panel = await openCompare(page);
    await page.evaluate(() => { window.__d1bStub = { pickMode: "pending" }; });
    await panel.getByTestId("take-pick-cand-b").click();
    await page.evaluate(() => {
        window.__d1bSetShot?.({
            id: "shot-b", idx: 2, status: "rendered", candidates_digest: "digest-new",
            candidates: [{ id: "new-candidate", url: "/media/neutral.mp4", status: "done", is_picked: true }],
        });
    });
    await page.getByTestId("take-candidate-new-candidate").waitFor({ state: "visible" });
    await page.evaluate(() => window.__d1bPendingResolve?.());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__d1bSavedCount ?? 0)).toBe(0);
    expect(await panel.getByTestId("take-compare-message").count()).toBe(0);
    await page.close();
}, 30_000);

test("shot.id 改变会关闭旧对比台，旧 pending 回包不触发刷新", async () => {
    const page = await openPage();
    const panel = await openCompare(page);
    await page.evaluate(() => { window.__d1bStub = { pickMode: "pending" }; });
    await panel.getByTestId("take-pick-cand-b").click();
    await page.evaluate(() => {
        window.__d1bSetShot?.({
            id: "shot-new", idx: 9, status: "rendered", candidates_digest: "digest-new",
            candidates: [{ id: "new-candidate", url: "/media/neutral.mp4", status: "done", is_picked: true }],
        });
    });
    await panel.waitFor({ state: "detached" });
    await page.evaluate(() => window.__d1bPendingResolve?.());
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => window.__d1bSavedCount ?? 0)).toBe(0);
    await page.close();
}, 30_000);

test("候选对比与配方、历史抽屉互斥", async () => {
    const page = await openPage();
    await openCompare(page);
    expect(await page.getByTestId("shot-recipe-panel").count()).toBe(0);
    expect(await page.getByTestId("shot-revision-history").count()).toBe(0);
    await page.locator(".ant-drawer-close").click();
    await page.getByRole("button", { name: "配方" }).click();
    await page.getByTestId("shot-recipe-panel").waitFor({ state: "visible" });
    expect(await page.getByTestId("take-compare-panel").count()).toBe(0);
    await page.close();
}, 30_000);
