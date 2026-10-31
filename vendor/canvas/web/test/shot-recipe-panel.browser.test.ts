import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// C1b 配方创作台真实渲染验证:保存为配方 / 列表 / 编辑 / 克隆 / 默认唯一 / App modal 删除 /
// 导入(JSON 本地预检 + 服务端 422 透出)/ 导出 / diff 预览 / 应用(409 不覆盖)/ 抽屉互斥。
// 组件依赖 @/services/toiv/client 的真实 API 封装,由插件 stub 成可断言的内存实现。
const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-c1b");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

type RecipeCall = { kind: string; [key: string]: unknown };

async function expectVisible(locator: Locator, label: string): Promise<void> {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
    expect(await locator.isVisible(), label).toBe(true);
}

const STUB_CLIENT = `
    const calls = () => (window.__recipeCalls ?? []);
    const stub = () => (window.__recipeStub ?? {});
    let recipes = [
        {
            id: "r-1", name: "雨夜霓虹配方", description: "模板A", engine: "h3",
            render_mode: "video", pipeline: "ref2va", pick_strategy: "auto_best",
            snapshot: { prompt: "雨夜霓虹", negative: "低清", camera: "推近", num_candidates: 2, seed: 42,
                ref_images: ["/api/images?filename=neon.png&worker=comfy0&subfolder=refs&type=output&sig=PLACEHOLDER_SIG"] },
            source_revision_id: "rev-b1", source_shot_id: "shot-b", is_default: true,
            created_at: "2026-10-26T10:00:00", updated_at: "2026-10-26T10:00:00",
        },
        {
            id: "r-2", name: "巷口 daylight", description: "", engine: "ltx",
            render_mode: "video", pipeline: "c", pick_strategy: "manual",
            snapshot: { prompt: "巷口日光", negative: "", num_candidates: 3 },
            source_revision_id: "", source_shot_id: "", is_default: false,
            created_at: "2026-10-25T09:00:00", updated_at: "2026-10-25T09:00:00",
        },
    ];
    const snapshotOf = (shotId) => ({
        engine: "h3", render_mode: "video", pipeline: "ref2va", pick_strategy: "auto_best",
        prompt: "雨夜霓虹(配方快照)", negative: "低清", camera: "推近", duration_sec: 6,
        num_candidates: 2, seed: 42, ref_images: [], scene_images: [],
        ref_epoch: 0, width: 720, height: 1280, fps: 24, ckpt_name: "h3-v23",
    });
    export async function saveStudioShots(pid, payload) {
        calls().push({ kind: "save", pid, payload });
    }
    export async function fetchShotRevisions(sid) {
        calls().push({ kind: "revisions", sid });
        return { shot_id: sid, revisions: [] };
    }
    export async function fetchShotRevisionDiff(sid, rid) {
        calls().push({ kind: "shotDiff", sid, rid });
        return { revision_id: rid, version: 1, source: "manual-edit", from_version: null, from_unknown: true, fields: {} };
    }
    export async function rollbackShotRevision(sid, revisionId, expectedRevision) {
        calls().push({ kind: "rollback", sid, revisionId, expectedRevision });
        return { id: sid };
    }
    export async function pickShotCandidate(sid, cid, expectedDigest) {
        calls().push({ kind: "pick", sid, cid, expectedDigest });
        return { id: sid };
    }
    export async function estimateBatchRender() {
        throw new Error("recipe suite must not trigger batch estimate");
    }
    export async function estimateShotRender() {
        throw new Error("recipe suite must not trigger shot estimate");
    }
    export async function createRecipeFromShot(shotId, opts) {
        calls().push({ kind: "from-shot", shotId, opts });
        const recipe = {
            id: "r-new", name: opts.name || "配方·shot-b", description: opts.description || "",
            engine: "h3", render_mode: "video", pipeline: "ref2va", pick_strategy: "auto_best",
            snapshot: snapshotOf(shotId), source_revision_id: "rev-b1", source_shot_id: shotId,
            is_default: false, created_at: "2026-10-27T08:00:00", updated_at: "2026-10-27T08:00:00",
        };
        recipes = [recipe, ...recipes];
        return recipe;
    }
    export async function fetchRecipes(engine) {
        calls().push({ kind: "list", engine });
        return recipes.filter((r) => !engine || r.engine === engine);
    }
    export async function fetchRecipe(rid) {
        calls().push({ kind: "get", rid });
        return recipes.find((r) => r.id === rid);
    }
    export async function patchRecipe(rid, patch) {
        calls().push({ kind: "patch", rid, patch });
        const r = recipes.find((x) => x.id === rid);
        if (patch.name !== undefined) r.name = patch.name;
        if (patch.description !== undefined) r.description = patch.description;
        if (patch.prompt !== undefined) r.snapshot.prompt = patch.prompt;
        if (patch.negative !== undefined) r.snapshot.negative = patch.negative;
        if (patch.pick_strategy !== undefined) r.pick_strategy = patch.pick_strategy;
        return r;
    }
    export async function cloneRecipe(rid, name) {
        calls().push({ kind: "clone", rid, name });
        const src = recipes.find((x) => x.id === rid);
        const dup = { ...src, id: "r-clone-" + rid, name: name || src.name + " 副本", is_default: false,
            snapshot: { ...src.snapshot } };
        recipes = [dup, ...recipes];
        return dup;
    }
    export async function setDefaultRecipe(rid) {
        calls().push({ kind: "set-default", rid });
        const target = recipes.find((x) => x.id === rid);
        recipes = recipes.map((x) => (x.engine === target.engine ? { ...x, is_default: x.id === rid } : x));
        return recipes.find((x) => x.id === rid);
    }
    export async function deleteRecipe(rid) {
        calls().push({ kind: "delete", rid });
        recipes = recipes.filter((x) => x.id !== rid);
    }
    export async function exportRecipe(rid) {
        calls().push({ kind: "export", rid });
        const r = recipes.find((x) => x.id === rid);
        return {
            schema: "toiv_generation_recipe_v1", name: r.name, description: r.description,
            engine: r.engine, render_mode: r.render_mode, pipeline: r.pipeline,
            pick_strategy: r.pick_strategy, snapshot: r.snapshot, exported_at: "2026-10-27T08:00:00",
        };
    }
    export async function importRecipe(payload) {
        calls().push({ kind: "import", payload });
        if (stub().importMode === "invalid") {
            const err = new Error("Request failed with status code 422");
            err.response = { status: 422, data: { detail: "schema 须为 toiv_generation_recipe_v1" } };
            throw err;
        }
        const recipe = {
            id: "r-imported", name: payload.name || "导入配方", description: payload.description || "",
            engine: payload.engine || "h3", render_mode: payload.render_mode || "video",
            pipeline: payload.pipeline || "ref2va", pick_strategy: payload.pick_strategy || "auto_best",
            snapshot: payload.snapshot || {}, source_revision_id: "", source_shot_id: "",
            is_default: false, created_at: "2026-10-27T08:00:00", updated_at: "2026-10-27T08:00:00",
        };
        recipes = [recipe, ...recipes];
        return recipe;
    }
    export async function fetchRecipeDiff(rid, shotId) {
        calls().push({ kind: "recipeDiff", rid, shotId });
        return {
            recipe_id: rid, shot_id: shotId,
            fields: {
                prompt: { from: "雨夜霓虹", to: "雨夜霓虹(配方快照)" },
                negative: { from: "低清", to: "低清,过曝" },
            },
            render_params: {
                video_model: "h3", auto_pick: false, wait: true,
                pipeline: "ref2va", num_candidates: 2, seed: 42, ref_images: ["/refs/a.png"],
            },
        };
    }
    export async function applyRecipe(rid, body) {
        calls().push({ kind: "apply", rid, body });
        if (stub().applyMode === "conflict") {
            const err = new Error("Request failed with status code 409");
            err.response = { status: 409, data: { detail: "分镜已被其他修改更新(current=rev-other)" } };
            throw err;
        }
        return {
            shot: { id: body.shot_id, prompt: "雨夜霓虹(配方快照)", current_revision_id: "rev-b3" },
            render_params: {
                video_model: "h3", auto_pick: false, wait: true,
                pipeline: "ref2va", num_candidates: 2, seed: 42, ref_images: ["/refs/a.png"],
            },
            applied_fields: ["prompt", "negative", "camera", "video_model", "render_mode"],
            project_specs_changed: body.apply_project_specs ? ["width", "height"] : [],
        };
    }
`;

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
        entrypoints: [resolve(import.meta.dir, "fixtures/shot-recipe-panel-harness.tsx")],
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
                contents: STUB_CLIENT,
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

async function openPage(height = 900): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height } });
    await page.goto(server.url.href);
    await expectVisible(page.getByTestId("inspector-aside").getByRole("button", { name: "配方" }), "配方入口");
    return page;
}

async function openRecipeDrawer(page: Page): Promise<Locator> {
    await page.getByTestId("inspector-aside").getByRole("button", { name: "配方" }).click();
    const panel = page.getByTestId("shot-recipe-panel");
    await expectVisible(panel, "配方面板");
    await expectVisible(page.getByTestId("shot-recipe-list"), "配方列表");
    return panel;
}

async function calls(page: Page): Promise<RecipeCall[]> {
    return page.evaluate(() => window.__recipeCalls ?? []) as Promise<RecipeCall[]>;
}

test("配方抽屉:列表(默认徽标/引擎/策略)+ 保存当前为配方(from-shot 带名称描述)", async () => {
    const page = await openPage();
    const panel = await openRecipeDrawer(page);
    const list = page.getByTestId("shot-recipe-list");
    await expectVisible(list.getByText("雨夜霓虹配方"), "配方 r-1");
    await expectVisible(list.getByText("巷口 daylight"), "配方 r-2");
    await expectVisible(list.getByText("默认", { exact: true }), "默认徽标");
    expect(await list.getByText("默认", { exact: true }).count(), "同屏只有一个默认").toBe(1);
    // 保存当前为配方
    await panel.getByRole("button", { name: "保存当前为配方" }).click();
    const form = page.getByTestId("shot-recipe-save-form");
    await expectVisible(form, "保存表单");
    await form.getByLabel("配方名称").fill("便利店雨夜模板");
    await form.getByLabel("配方描述").fill("C1b 验收");
    await form.getByRole("button", { name: "保存配方" }).click();
    const msg = page.getByTestId("shot-recipe-message");
    await expectVisible(msg, "保存成功回执(面板消息区)");
    const created = (await calls(page)).find((c) => c.kind === "from-shot");
    expect(created).toMatchObject({ shotId: "shot-b", opts: { name: "便利店雨夜模板", description: "C1b 验收" } });
    await expectVisible(list.getByText("便利店雨夜模板"), "新配方出现在列表");
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1b/recipe-list.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("抽屉互斥:配方与修订历史同屏只开一个(配方按钮 aria-expanded)", async () => {
    const page = await openPage();
    const aside = page.getByTestId("inspector-aside");
    const recipeBtn = aside.getByRole("button", { name: "配方" });
    expect(await recipeBtn.getAttribute("aria-expanded")).toBeNull();
    await recipeBtn.click();
    expect(await recipeBtn.getAttribute("aria-expanded")).toBe("true");
    await expectVisible(page.getByTestId("shot-recipe-panel"), "配方抽屉开");
    expect(await page.getByTestId("shot-revision-history").count(), "历史抽屉未开").toBe(0);
    // 抽屉 mask 挡住背后 Inspector(真实产品行为):关抽屉再开历史
    await page.locator(".ant-drawer-close").click();
    await aside.getByRole("button", { name: "修订历史" }).click();
    await expectVisible(page.getByTestId("shot-revision-history"), "历史抽屉开");
    expect(await page.getByTestId("shot-recipe-panel").count(), "配方抽屉已关").toBe(0);
    // 再开配方 → 历史关闭
    await page.locator(".ant-drawer-close").click();
    await aside.getByRole("button", { name: "配方" }).click();
    await expectVisible(page.getByTestId("shot-recipe-panel"), "配方抽屉重开");
    expect(await page.getByTestId("shot-revision-history").count(), "历史抽屉已关").toBe(0);
    await page.close();
}, 30_000);

test("编辑:PATCH 名称/描述/prompt/negative/挑选策略一次提交", async () => {
    const page = await openPage();
    await openRecipeDrawer(page);
    const row = page.getByTestId("shot-recipe-list").locator("li").filter({ hasText: "雨夜霓虹配方" });
    await row.getByRole("button", { name: "编辑" }).click();
    const form = page.getByTestId("recipe-edit-form");
    await expectVisible(form, "编辑表单");
    await form.getByLabel("编辑提示语").fill("雨夜霓虹 · 增强版");
    await form.getByLabel("编辑负向词").fill("低清,过曝");
    await form.getByLabel("编辑挑选策略").selectOption("manual");
    await form.getByRole("button", { name: "保存", exact: true }).click();
    const patched = (await calls(page)).find((c) => c.kind === "patch");
    expect(patched?.rid).toBe("r-1");
    expect(patched?.patch).toMatchObject({
        prompt: "雨夜霓虹 · 增强版",
        negative: "低清,过曝",
        pick_strategy: "manual",
    });
    await expectVisible(row.getByText("手动挑选"), "策略更新后展示");
    await page.close();
}, 30_000);

test("克隆 + 设为默认(每引擎唯一:同引擎旧默认被清)", async () => {
    const page = await openPage();
    await openRecipeDrawer(page);
    const list = page.getByTestId("shot-recipe-list");
    await list.locator("li").filter({ hasText: "雨夜霓虹配方" }).getByRole("button", { name: "克隆" }).click();
    const cloned = (await calls(page)).find((c) => c.kind === "clone");
    expect(cloned).toMatchObject({ rid: "r-1", name: undefined });
    await expectVisible(list.getByText("雨夜霓虹配方 副本"), "克隆行");
    // r-1 是 h3 默认;把副本设为默认 → 同引擎只有一个默认徽标
    await list.locator("li").filter({ hasText: "雨夜霓虹配方 副本" }).getByRole("button", { name: "设为默认" }).click();
    const setDefault = (await calls(page)).find((c) => c.kind === "set-default");
    expect(setDefault?.rid).toBe("r-clone-r-1");
    await page.waitForFunction(() => {
        const list = document.querySelector('[data-testid="shot-recipe-list"]');
        return list && list.textContent?.includes("默认");
    });
    expect(await list.getByText("默认", { exact: true }).count(), "同引擎唯一默认").toBe(1);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1b/recipe-default.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("删除走 App 上下文 modal(非原生 confirm):确认后 DELETE", async () => {
    const page = await openPage();
    await openRecipeDrawer(page);
    const list = page.getByTestId("shot-recipe-list");
    await list.locator("li").filter({ hasText: "巷口 daylight" }).getByRole("button", { name: "删除" }).click();
    const dialog = page.locator(".ant-modal-confirm");
    await expectVisible(dialog, "App 上下文确认弹窗");
    const okBtn = dialog.getByRole("button", { name: "删 除" });
    await expectVisible(okBtn, "确认删除按钮");
    // 等弹窗进场 motion 完成(opacity=1)再截图,避免拍到运动中空白帧
    await page.waitForFunction(() => {
        const el = document.querySelector(".ant-modal-confirm");
        return el && getComputedStyle(el).opacity === "1";
    }, undefined, { timeout: 10_000 });
    expect(await dialog.textContent()).toContain("只删除配方行");
    await dialog.screenshot({ path: "test-results/production-c1b/recipe-delete-modal.png", animations: "disabled" });
    await okBtn.click();
    const deleted = (await calls(page)).find((c) => c.kind === "delete");
    expect(deleted?.rid).toBe("r-2");
    await page.waitForSelector("text=已删除", { timeout: 10_000 });
    expect(await list.getByText("巷口 daylight").count(), "已删行消失").toBe(0);
    await page.close();
}, 30_000);

test("导入:合法 JSON 成功;非 JSON 本地预检;服务端 422 detail 透出", async () => {
    const page = await openPage();
    const panel = await openRecipeDrawer(page);
    const input = page.getByTestId("recipe-import-input");
    // 1) 合法导入
    await input.setInputFiles({
        name: "recipe.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ schema: "toiv_generation_recipe_v1", name: "外部导入配方", snapshot: { prompt: "外来提示" } })),
    });
    await page.waitForFunction(() => (window.__recipeCalls ?? []).some((c) => c.kind === "import"));
    const okCall = (await calls(page)).find((c) => c.kind === "import");
    expect((okCall?.payload as { name: string }).name).toBe("外部导入配方");
    await expectVisible(page.getByTestId("shot-recipe-list").getByText("外部导入配方"), "导入行");
    // 2) 本地预检:不发请求
    const before = (await calls(page)).length;
    await input.setInputFiles({ name: "bad.json", mimeType: "application/json", buffer: Buffer.from("not json") });
    await expectVisible(panel.getByTestId("shot-recipe-message"), "本地错误提示");
    expect(await panel.getByTestId("shot-recipe-message").textContent()).toContain("不是合法 JSON");
    expect((await calls(page)).length, "本地预检不发请求").toBe(before);
    // 3) 服务端 422
    await page.evaluate(() => { (window.__recipeStub ?? {}).importMode = "invalid"; });
    await input.setInputFiles({
        name: "recipe2.json",
        mimeType: "application/json",
        buffer: Buffer.from(JSON.stringify({ schema: "toiv_generation_recipe_v1", name: "会失败" })),
    });
    await expectVisible(panel.getByTestId("shot-recipe-message"), "服务端校验错误提示");
    expect(await panel.getByTestId("shot-recipe-message").textContent()).toContain("schema 须为 toiv_generation_recipe_v1");
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1b/recipe-import-error.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("导出:真实 download 事件 → 保存 JSON → 断言 schema/字段一致 + 脱敏 + 可导入回列表", async () => {
    const page = await openPage();
    await openRecipeDrawer(page);
    const exportPromise = page.waitForEvent("download", { timeout: 15_000 });
    await page.getByTestId("shot-recipe-list").locator("li").filter({ hasText: "雨夜霓虹配方" }).getByRole("button", { name: "导出" }).click();
    const download = await exportPromise;
    const savedPath = resolve(shotsDir, "exported-recipe.json");
    await download.saveAs(savedPath);
    expect(download.suggestedFilename()).toBe("雨夜霓虹配方_recipe.json");
    // 读取实际落盘 JSON,与导出源逐项一致
    const exported = JSON.parse(await Bun.file(savedPath).text()) as {
        schema: string; name: string; pick_strategy: string; exported_at: string;
        snapshot: { prompt: string; ref_images?: string[] };
    };
    expect(exported.schema).toBe("toiv_generation_recipe_v1");
    expect(exported.name).toBe("雨夜霓虹配方");
    expect(exported.pick_strategy).toBe("auto_best");
    expect(exported.snapshot.prompt).toBe("雨夜霓虹");
    expect(exported.exported_at).toBeTruthy();
    // 参考位一致:/api/images 定位参数(filename/worker/subfolder/type)保留,占位 sig 被剥
    // (真实脱敏由后端负责,前端导出兜底同口径)
    expect(exported.snapshot.ref_images).toEqual([
        "/api/images?filename=neon.png&subfolder=refs&worker=comfy0&type=output",
    ]);
    const raw = await Bun.file(savedPath).text();
    expect(raw).not.toContain("PLACEHOLDER_SIG");
    expect(raw).not.toContain("sig=");
    // 执行面参数/敏感 query 不得进入导出文件
    for (const banned of ["worker_url", "context_latent_path", "parent_chain_job_id"]) {
        expect(raw).not.toContain(banned);
    }
    // 同一文件可直接导入回列表(跨设备回路),且定位参数在导入 payload 中保留
    await page.getByTestId("recipe-import-input").setInputFiles({ name: "exported-recipe.json", mimeType: "application/json", buffer: Buffer.from(raw) });
    await page.waitForFunction(() => (window.__recipeCalls ?? []).some((c) => c.kind === "import"));
    const imported = (await calls(page)).find((c) => c.kind === "import");
    expect((imported?.payload as { name: string }).name).toBe("雨夜霓虹配方");
    expect(((imported?.payload as { snapshot: { ref_images: string[] } }).snapshot.ref_images ?? [])).toEqual([
        "/api/images?filename=neon.png&subfolder=refs&worker=comfy0&type=output",
    ]);
    // 导入副本回到列表(与原配方同名共存,服务端生成新 id)
    expect(await page.getByTestId("shot-recipe-list").getByText("雨夜霓虹配方").count(), "导入回列表").toBe(2);
    await page.close();
}, 30_000);

test("应用:diff 预览(from/to + 渲染参数)→ 确认应用(默认不写项目规格)→ render_params 走真实渲染回调", async () => {
    const page = await openPage(560);
    await openRecipeDrawer(page);
    const list = page.getByTestId("shot-recipe-list");
    await list.locator("li").filter({ hasText: "雨夜霓虹配方" }).getByRole("button", { name: "应用", exact: true }).click();
    const diff = page.getByTestId("recipe-diff");
    await expectVisible(diff, "diff 预览");
    const diffText = await diff.textContent();
    expect(diffText).toContain("提示语");
    expect(diffText).toContain("雨夜霓虹(配方快照)");
    expect(diffText).toContain("负向词");
    expect(diffText).toContain("渲染参数");
    expect(diffText).toContain("seed 42");
    expect(diffText).toContain("手动挑选");
    // 项目规格默认 false
    expect(await page.getByTestId("recipe-apply-specs").isChecked()).toBe(false);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1b/recipe-diff.png", animations: "disabled" });
    await diff.getByRole("button", { name: "确认应用并渲染" }).click();
    await page.waitForFunction(() => (window.__recipeCalls ?? []).some((c) => c.kind === "apply"));
    const apply = (await calls(page)).find((c) => c.kind === "apply");
    expect(apply?.rid).toBe("r-1");
    expect(apply?.body).toEqual({ shot_id: "shot-b", expected_revision: "rev-b2", apply_project_specs: false });
    // 应用成功后:render_params 传给 parent 真实渲染回调(wait=false/force_direct 由 parent renderShotAsync 补)
    await page.waitForFunction(() => (window.__applyRenderCalls ?? []).length > 0);
    const applyRender = (await page.evaluate(() => window.__applyRenderCalls ?? [])) as { sid: string; params: { auto_pick?: boolean; seed?: number } }[];
    expect(applyRender[0].sid).toBe("shot-b");
    expect(applyRender[0].params).toMatchObject({ auto_pick: false, seed: 42, video_model: "h3" });
    await page.close();
}, 30_000);

test("应用勾选项目规格 → apply_project_specs=true;409 冲突 → 不覆盖、不触发渲染", async () => {
    const page = await openPage();
    await openRecipeDrawer(page);
    const list = page.getByTestId("shot-recipe-list");
    await list.locator("li").filter({ hasText: "雨夜霓虹配方" }).getByRole("button", { name: "应用", exact: true }).click();
    const diff = page.getByTestId("recipe-diff");
    await diff.getByTestId("recipe-apply-specs").check();
    await diff.getByRole("button", { name: "确认应用并渲染" }).click();
    await page.waitForFunction(() => (window.__recipeCalls ?? []).some((c) => c.kind === "apply"));
    expect((await calls(page)).find((c) => c.kind === "apply")?.body).toMatchObject({ apply_project_specs: true });
    // 409 冲突场景
    await page.evaluate(() => { (window.__recipeStub ?? {}).applyMode = "conflict"; });
    await list.locator("li").filter({ hasText: "雨夜霓虹配方" }).getByRole("button", { name: "应用", exact: true }).click();
    const diff2 = page.getByTestId("recipe-diff");
    await diff2.getByRole("button", { name: "确认应用并渲染" }).click();
    const msg = page.getByTestId("shot-recipe-message");
    await expectVisible(msg, "冲突提示");
    expect(await msg.textContent()).toContain("分镜已被其他修改更新");
    // 不触发渲染回调;但刷新真值(savedCount 增加)
    const renderCalls = (await page.evaluate(() => window.__applyRenderCalls ?? [])) as unknown[];
    expect(renderCalls.length, "409 不触发渲染").toBeLessThanOrEqual(1); // 只有上一步成功那次
    const savedCount = await page.evaluate(() => window.__savedCount ?? 0);
    expect(savedCount).toBeGreaterThanOrEqual(1);
    await page.close();
}, 30_000);
