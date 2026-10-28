import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": "{}", "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "fu1-harness", setup(builder) {
            builder.onLoad({ filter: /word-anchor-timeline\.browser\.test\.ts$/ }, () => ({
                loader: "tsx", resolveDir: resolve(import.meta.dir, ".."), contents: `
                    import { createRoot } from 'react-dom/client';
                    import { MemoryRouter, Routes, Route } from 'react-router';
                    import Workspace from '@/pages/toiv/drama-workspace';
                    createRoot(document.getElementById('root')).render(
                        <MemoryRouter initialEntries={['/toiv/ws/project?section=timeline']}>
                            <Routes><Route path='/toiv/ws/:id' element={<Workspace />} /></Routes>
                        </MemoryRouter>);
                `,
            }));
            // Vite owns icon glob expansion（import.meta.glob 是编译期 API）；Bun.build harness 用 stub 隔离，
            // 与 assistant-model-picker.browser.test.ts 同款处理。
            builder.onResolve({ filter: /^@\/components\/model-logo$/ }, () => ({ path: "model-logo", namespace: "test-icons" }));
            builder.onLoad({ filter: /.*/, namespace: "test-icons" }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "js" }));
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(resolve(import.meta.dir, "../src", args.path.slice(2)), import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(script, { headers: { "Content-Type": "text/javascript" } })
        : new Response('<!doctype html><meta charset="UTF-8"><div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ headless: true, executablePath });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

function shot(id: string) {
    return { id, idx: id === "A" ? 0 : 1, status: "draft", scene: id, duration_sec: 60, render_mode: "video",
        prompt: "visual", dialogue: `${id}原词`, characters: [],
        beats: [{ text: `${id}原词`, cues: ["回头"], anchor_words: "原词", kind: "d", block: 0, start_sec: 0, end_sec: 60, est_sec: 60 }] };
}
async function open(page: Page) {
    const detail = { id: "project", title: "FU1", status: "draft", characters: [], shots: [shot("A"), shot("B")] };
    await page.route("**/api/**", (route) => {
        if (route.request().url().endsWith("/studio/projects/project")) return route.fulfill({ json: detail });
        return route.fulfill({ json: [] });
    });
    await page.goto(server.url.toString());
    await page.getByRole("textbox", { name: "第 1 拍台词" }).first().waitFor();
}

test("workspace uses server projection", async () => {
    const page = await browser.newPage();
    try {
        await open(page);
        expect(await page.getByText("0.0–60.0s", { exact: true }).count()).toBe(2);
    } finally { await page.close(); }
}, 20_000);

test("workspace keeps draft attached to shot after reorder", async () => {
    const page = await browser.newPage();
    try {
        await open(page);
        const inputs = page.getByRole("textbox", { name: "第 1 拍台词" });
        await inputs.first().fill("A未保存草稿");
        await page.getByRole("button", { name: "下移 A", exact: true }).click();
        expect(await inputs.nth(0).inputValue()).toBe("B原词");
        expect(await inputs.nth(1).inputValue()).toBe("A未保存草稿");
    } finally { await page.close(); }
}, 20_000);

test("pending reflow locks editing, failure keeps draft, retry patches generation text", async () => {
    const page = await browser.newPage();
    try {
        await open(page);
        let finish: (() => Promise<void>) | undefined;
        let markStarted!: () => void;
        const started = new Promise<void>((resolve) => { markStarted = resolve; });
        let attempts = 0;
        await page.route("**/api/studio/shots/A/reflow-beats", async (route) => {
            attempts++;
            const request = route.request().postDataJSON();
            if (attempts === 1) {
                await new Promise<void>((resolve) => {
                    finish = async () => { await route.fulfill({ status: 500, json: { detail: "重排失败" } }); resolve(); };
                    markStarted();
                });
            } else {
                expect(request).toEqual({ texts: ["新对白"], total_sec: 60, persist: true });
                await route.fulfill({ json: { ...shot("A"), dialogue: "新对白", beats: [{ ...shot("A").beats[0], text: "新对白" }] } });
            }
        });
        const input = page.getByRole("textbox", { name: "第 1 拍台词" }).first();
        await input.fill("新对白");
        await page.getByRole("button", { name: "应用改词重排", exact: true }).click();
        await page.getByRole("button", { name: "重排中…", exact: true }).waitFor();
        expect(await input.isDisabled()).toBe(true);
        expect(await page.getByRole("button", { name: /保存排序/ }).isDisabled()).toBe(true);
        await started;
        await finish!();
        await page.getByText(/Request failed/).waitFor();
        expect(await input.inputValue()).toBe("新对白");
        expect(await input.isEnabled()).toBe(true);
        await page.getByRole("button", { name: "应用改词重排", exact: true }).click();
        await page.getByRole("button", { name: "改词后点此重排", exact: true }).first().waitFor();
        expect(await input.inputValue()).toBe("新对白");
        let saved: Record<string, any> | undefined;
        await page.route("**/api/studio/projects/project/shots", async (route) => {
            saved = route.request().postDataJSON();
            await route.fulfill({ json: { shots: saved!.shots } });
        });
        await page.getByRole("button", { name: /保存排序/ }).click();
        await page.getByText(/排序与时长已保存/).waitFor();
        expect(saved!.shots.find((s: any) => s.id === "A").dialogue).toBe("新对白");
    } finally { await page.close(); }
}, 20_000);
