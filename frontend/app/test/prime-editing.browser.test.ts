import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let project: any;
let calls: { path: string; method: string; body: any }[];
let putStatus: number;
let pickStatus: number;
let holdCreate: Promise<void> | undefined;
let holdPick: Promise<void> | undefined;
let errors: string[];
const initialShots = () => [
    { id: "s1", prompt: "原提示词", camera: "STATIC", duration_sec: 6, current_revision_id: "r1", status: "error", error: "engine failed", beats: [], candidates_digest: "d1", candidates: [
        { id: "c1", status: "done", is_picked: true, seed: 1, url: "/api/studio/files/a.mp4", video_model: "h3", pipeline: "ref2va", revision_id: "r0", qa: { verdict: "pass" } },
        { id: "c2", status: "done", is_picked: false, seed: 2, url: "https://cdn.example/b.mp4", video_model: "ltx", pipeline: "fl2va", revision_id: "r1", qa: { verdict: "warn" } },
        { id: "c3", status: "queued", is_picked: false, url: "" },
        { id: "c4", status: "error", is_picked: false, url: "", error: "GPU unavailable" },
    ] },
    { id: "s2", prompt: "画面", dialogue: "旧台词", duration_sec: 6, current_revision_id: "r2", status: "draft", beats: [
        { text: "画面", kind: "v", cues: ["灯"], anchor_words: "面", block: 0 },
        { text: "旧台词", kind: "d", cues: [], anchor_words: "词", block: 0 },
    ], candidates: [] },
];
beforeAll(async () => {
    const build = await Bun.build({ entrypoints: [import.meta.dir + "/fixtures/prime-editing-harness.tsx"], target: "browser", define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, BASE_URL: "/" }) } });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"].map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        if (new URL(request.url).pathname === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (new URL(request.url).pathname === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (new URL(request.url).pathname.startsWith("/api/")) return Response.json({ detail: "unmocked API" }, { status: 503 });
        return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 60_000);
beforeEach(async () => {
    project = { id: "p1", title: "测试剧", characters: [], shots: initialShots() };
    calls = []; errors = []; putStatus = 200; pickStatus = 200; holdCreate = undefined; holdPick = undefined;
    page = await browser.newPage();
    page.setDefaultTimeout(2500);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    // No external network, and every API call terminates in this fixture.
    await page.route("https://cdn.example/**", route => route.abort());
    await page.route("**/api/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const body = request.postDataJSON();
        calls.push({ path, method, body });
        if (path.startsWith("/api/studio/files/")) { await route.fulfill({ status: 404 }); return; }
        if (path === "/api/studio/projects" && method === "POST") {
            await holdCreate;
            project.shots = [];
            await route.fulfill({ json: { id: "p1", title: "测试剧" } }); return;
        }
        if (path.endsWith("/import-svml")) {
            await route.fulfill({ json: { shots: [{ prompt: "导入镜头", duration_sec: 6, characters: ["甲"], beats: [] }], characters: ["甲"], count: 1 } }); return;
        }
        if (path.endsWith("/characters") && method === "POST") {
            project.characters.push({ id: "char1", name: body.name });
            await route.fulfill({ json: project.characters.at(-1) }); return;
        }
        if (path.endsWith("/shots") && method === "PUT") {
            if (putStatus !== 200) { await route.fulfill({ status: putStatus, json: { detail: "save rejected" } }); return; }
            project.shots = body.shots.map((s: any, index: number) => ({ ...project.shots.find((old: any) => old.id === s.id), ...s, id: s.id || `import${index}`, current_revision_id: `saved${index}` }));
            await route.fulfill({ json: { shots: project.shots } }); return;
        }
        if (path.endsWith("/reflow-beats")) {
            const shot = project.shots[1];
            shot.beats = shot.beats.map((beat: any, i: number) => ({ ...beat, text: body.texts[i] }));
            shot.prompt = body.texts[0]; shot.dialogue = body.texts[1]; shot.duration_sec = body.total_sec; shot.current_revision_id = "reflowed";
            await route.fulfill({ json: shot }); return;
        }
        if (path.endsWith("/pick")) {
            await holdPick;
            if (pickStatus !== 200) { await route.fulfill({ status: pickStatus, json: { detail: "candidate changed" } }); return; }
            const shot = project.shots[0];
            shot.candidates.forEach((c: any) => { c.is_picked = path.includes(`/${c.id}/pick`); });
            shot.candidates_digest = "d2";
            await route.fulfill({ json: shot }); return;
        }
        await route.fulfill({ json: path === "/api/studio/projects/p1" ? project : [] });
    });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); server?.stop(true); });
const goto = (path: string) => page.goto(`http://127.0.0.1:${server.port}${path}`);
const shot = (index: number) => page.locator(".toiv-shot").nth(index);
const writes = () => calls.filter(c => c.method === "PUT" || c.method === "POST");

test("create blocks synchronous duplicate submits and retries failed import within the same project", async () => {
    putStatus = 503;
    let release!: () => void;
    holdCreate = new Promise(resolve => { release = resolve; });
    await goto("/create");
    await page.getByLabel("标题", { exact: true }).fill("测试剧");
    await page.getByLabel("SVML 词锚脚本（可选）").fill("原脚本");
    await page.locator("form").evaluate(form => {
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(await page.getByRole("button", { name: /创建/ }).isDisabled()).toBe(true);
    release();
    await page.getByRole("button", { name: "重试导入到当前项目" }).waitFor();
    expect(calls.filter(c => c.path === "/api/studio/projects" && c.method === "POST")).toHaveLength(1);
    expect(await page.getByLabel("SVML 词锚脚本（可选）").inputValue()).toBe("原脚本");
    expect(await page.getByText(/p1/).count()).toBeGreaterThan(0);
    putStatus = 200;
    await page.getByRole("button", { name: "重试导入到当前项目" }).click();
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/studio/p1");
    expect(calls.filter(c => c.path === "/api/studio/projects" && c.method === "POST")).toHaveLength(1);
    expect(project.characters).toHaveLength(1);
    expect(project.shots[0].prompt).toBe("导入镜头");
});

test("recovery does not replace existing edited shots and can open the created project", async () => {
    putStatus = 503;
    await goto("/create");
    await page.getByLabel("标题", { exact: true }).fill("测试剧");
    await page.getByLabel("SVML 词锚脚本（可选）").fill("词");
    await page.getByRole("button", { name: "创建并进入流水线" }).click();
    await page.getByRole("button", { name: "重试导入到当前项目" }).waitFor();
    project.shots = initialShots();
    const previousWrites = writes().length;
    await page.getByRole("button", { name: "重试导入到当前项目" }).click();
    await page.getByText(/已有.*镜头.*保留/).waitFor();
    expect(writes().length).toBe(previousWrites);
    await page.getByRole("button", { name: "打开已建项目" }).click();
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("原提示词");
});

test("prompt edits are dirty until explicit save and survive panel switches and reload after save", async () => {
    await goto("/studio/p1");
    await shot(0).getByRole("textbox").fill("已编辑提示词");
    await page.getByRole("button", { name: "配方", exact: true }).click();
    expect(errors).toEqual([]);
    expect(writes()).toHaveLength(0);
    await page.getByRole("button", { name: "分镜", exact: true }).click();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("已编辑提示词");
    await shot(0).getByRole("button", { name: "保存提示词" }).click();
    await page.getByRole("status").filter({ hasText: /已保存/ }).waitFor();
    expect(await shot(0).getByRole("button", { name: "保存提示词" }).isDisabled()).toBe(true);
    await page.getByRole("button", { name: "配方", exact: true }).click();
    await page.getByRole("button", { name: "分镜", exact: true }).click();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("已编辑提示词");
    await page.reload();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("已编辑提示词");
    expect(errors).toEqual([]);
});

test("save conflict preserves the local draft and offers refresh without silently overwriting it", async () => {
    putStatus = 409;
    await goto("/studio/p1");
    await shot(0).getByRole("textbox").fill("本地草稿");
    await shot(0).getByRole("button", { name: "保存提示词" }).click();
    await page.getByRole("status").filter({ hasText: /刷新/ }).waitFor();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("本地草稿");
    await page.getByRole("button", { name: "刷新分镜" }).click();
    expect(await shot(0).getByRole("textbox").inputValue()).toBe("本地草稿");
    expect(writes().filter(c => c.method === "PUT")).toHaveLength(1);
});

test("beat edits use ordered text controls, readonly derived prompt and reflow persistence", async () => {
    await goto("/studio/p1");
    expect(await shot(1).getByLabel("派生提示词").getAttribute("readonly")).not.toBeNull();
    await shot(1).getByLabel("第 2 拍文本").fill("新台词");
    await shot(1).getByLabel("总时长（秒）").fill("9");
    await shot(1).getByRole("button", { name: "保存并重排" }).click();
    await page.getByRole("status").filter({ hasText: /已保存/ }).waitFor();
    expect(writes().find(c => c.path.endsWith("reflow-beats"))?.body).toEqual({ texts: ["画面", "新台词"], total_sec: 9, persist: true });
    await page.reload();
    expect(await shot(1).getByLabel("第 2 拍文本").inputValue()).toBe("新台词");
});

test("takes expose metadata and signed previews; pending and 409 never change selection", async () => {
    pickStatus = 409;
    let release!: () => void;
    holdPick = new Promise(resolve => { release = resolve; });
    await goto("/studio/p1");
    await shot(0).waitFor();
    expect(await shot(0).getByText("失败", { exact: true }).count()).toBe(1);
    expect(await shot(0).getByText(/GPU unavailable/).count()).toBe(1);
    expect(await shot(0).getByText("ref2va", { exact: true }).count()).toBe(1);
    expect(await shot(0).locator("video").nth(0).getAttribute("src")).toContain("token=fixture-token");
    expect(await shot(0).locator("video").nth(1).getAttribute("src")).toBe("https://cdn.example/b.mp4");
    const c1 = shot(0).getByRole("button", { name: "采用 T1", exact: true });
    const c2 = shot(0).getByRole("button", { name: "采用 T2", exact: true });
    expect(await shot(0).getByRole("button", { name: "采用 T3", exact: true }).isDisabled()).toBe(true);
    await c2.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });
    expect(await c2.isDisabled()).toBe(true);
    expect(await c1.getAttribute("aria-pressed")).toBe("true");
    expect(await c2.getAttribute("aria-pressed")).toBe("false");
    release();
    await page.getByRole("status").filter({ hasText: /刷新/ }).waitFor();
    expect(calls.filter(c => c.path.endsWith("/pick"))).toHaveLength(1);
    expect(await c1.getAttribute("aria-pressed")).toBe("true");
    pickStatus = 200; holdPick = undefined;
    await page.getByRole("button", { name: "刷新分镜" }).click();
    await c2.click();
    await page.waitForFunction(() => document.querySelector('[aria-label="采用 T2"]')?.getAttribute("aria-pressed") === "true");
    expect(calls.filter(c => c.path.endsWith("/pick")).at(-1)?.body).toEqual({ expected_candidates_digest: "d1" });
    await page.reload();
    expect(await c2.getAttribute("aria-pressed")).toBe("true");
});

for (const width of [320, 390]) {
    test(`storyboard controls and long candidate metadata remain usable at ${width}px`, async () => {
        project.shots[0].candidates[0].id = "candidate-" + "abcdef0123456789".repeat(6);
        await page.setViewportSize({ width, height: 844 });
        await goto("/studio/p1");
        const beat = shot(1).getByLabel("第 1 拍文本");
        await beat.waitFor();
        expect(await page.getByText(/0 渲染中/).count()).toBe(0);
        const layout = await shot(1).evaluate(card => {
            const textarea = card.querySelector("textarea")!;
            const input = card.querySelector("input")!;
            const style = getComputedStyle(card);
            return {
                usable: card.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
                beatWidth: textarea.getBoundingClientRect().width,
                inputHeight: input.getBoundingClientRect().height,
                overflow: document.documentElement.scrollWidth > window.innerWidth,
            };
        });
        expect(layout.beatWidth).toBeGreaterThanOrEqual(layout.usable - 2);
        expect(layout.inputHeight).toBeGreaterThanOrEqual(40);
        expect(layout.overflow).toBe(false);
        await beat.focus();
        expect(await beat.evaluate(element => {
            const style = getComputedStyle(element);
            return style.outlineStyle !== "none" || style.boxShadow !== "none";
        })).toBe(true);
        await beat.fill("移动端编辑");
        await shot(1).getByRole("button", { name: "保存并重排" }).click();
        await page.getByRole("status").filter({ hasText: /已保存/ }).waitFor();
        expect(await beat.inputValue()).toBe("移动端编辑");
        expect(errors).toEqual([]);
    });
}
