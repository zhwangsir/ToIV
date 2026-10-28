import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/create/creation-studio-three-pane.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/create/creation-studio-preview-timeline.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/toiv/toiv-empty-loading.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/director-layout-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test", VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT: "http://127.0.0.1:8080" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/services\/toiv\/agent-chat\.ts$/ }, () => ({
                contents: `
                    export async function fetchAgentSessions() { return []; }
                    export async function fetchAgentHistory(id) { return [{ role: "assistant", content: "会话 " + id + " 已恢复" }]; }
                    export async function forkAgentSession(id) { return { id }; }
                    export async function deleteAgentSession() {}
                    export async function fetchAgentCanvasProposal() { return {}; }
                    export function stashCanvasProposal() {}
                    export function streamAgentChat() { return { abort() {}, done: Promise.resolve() }; }
                `,
                loader: "ts",
            }));
            builder.onLoad({ filter: /src\/services\/toiv\/timeline-preview\.ts$/ }, () => ({
                contents: `let failPreview = new URLSearchParams(window.location.search).has("fail");
                export async function fetchTimelinePreview() {
                    if (failPreview) { failPreview = false; throw new Error("preview unavailable"); }
                    return { fps: 24, items: [
                    { shot_id: "shot-1", idx: 0, kind: "video", preview_url: "", media_url: "/sequence.mp4", duration_sec: 4.5, nsfw: false },
                    { shot_id: "shot-2", idx: 1, kind: "audio", preview_url: "", duration_sec: 2, nsfw: false },
                    { shot_id: "shot-3", idx: 2, kind: "video", preview_url: "", media_url: "/sequence.mp4", duration_sec: 2, nsfw: false }
                ] }; }`,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, async fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/sequence.mp4") {
            const file = Bun.file(`${import.meta.dir}/../public/welcome/charge/sequence.mp4`);
            const range = request.headers.get("range")?.match(/^bytes=(\d+)-(\d*)$/);
            if (range) {
                const start = Number(range[1]);
                const end = Math.min(file.size - 1, range[2] ? Number(range[2]) : file.size - 1);
                return new Response(file.slice(start, end + 1), { status: 206, headers: {
                    "Accept-Ranges": "bytes",
                    "Content-Type": "video/mp4",
                    "Content-Range": `bytes ${start}-${end}/${file.size}`,
                } });
            }
            return new Response(file, { headers: { "Accept-Ranges": "bytes", "Content-Type": "video/mp4" } });
        }
        if (path === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        return new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness(query = ""): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.goto(`${server.url}${query}`);
    await page.getByTestId("creation-studio-three-pane").waitFor();
    return page;
}

test("director layout releases stage by default and restores inspector on demand", async () => {
    const page = await openHarness();
    const stage = page.getByTestId("creation-studio-stage");
    expect(await stage.evaluate((element) => element.getBoundingClientRect().width)).toBe(1352);
    expect(await page.getByTestId("creation-studio-inspector").count()).toBe(0);
    expect(await page.getByTestId("creation-studio-preview-timeline").evaluate((element) => element.getBoundingClientRect().height)).toBe(40);
    await page.screenshot({ path: "test-results/freezone-r6/director-default.png", fullPage: true });

    await page.getByRole("button", { name: "打开属性" }).click();
    expect(await stage.evaluate((element) => element.getBoundingClientRect().width)).toBe(1024);
    expect(await page.getByTestId("creation-studio-inspector").count()).toBe(1);
    await page.screenshot({ path: "test-results/freezone-r6/director-inspector-open.png", fullPage: true });
    await page.getByRole("button", { name: "收起属性" }).click();
    expect(await stage.evaluate((element) => element.getBoundingClientRect().width)).toBe(1352);
    await page.close();
});

test("timeline expands and collapses without losing its toolbar", async () => {
    const page = await openHarness();
    const timeline = page.getByTestId("creation-studio-preview-timeline");
    await page.getByRole("button", { name: "展开时间线" }).click();
    expect(await timeline.evaluate((element) => element.getBoundingClientRect().height)).toBe(260);
    expect(await timeline.locator(".toiv-timeline-body").isVisible()).toBe(true);
    await page.getByRole("button", { name: "收起时间线" }).click();
    expect(await timeline.evaluate((element) => element.getBoundingClientRect().height)).toBe(40);
    expect(await timeline.locator(".toiv-timeline-toolbar").isVisible()).toBe(true);
    await page.close();
});

test("preview monitor plays real media, steps frames and switches clips", async () => {
    const page = await openHarness();
    await page.getByRole("button", { name: "展开时间线" }).click();
    const video = page.locator(".toiv-timeline-preview-media video");
    await video.waitFor();
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector(".toiv-timeline-preview-media video") as HTMLVideoElement).currentTime > 0.1);
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    const beforeStep = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    await page.getByRole("button", { name: "下一帧" }).click();
    await page.waitForFunction((before) => (document.querySelector(".toiv-timeline-preview-media video") as HTMLVideoElement).currentTime > before + 0.03, beforeStep);
    const afterStep = await video.evaluate((element) => (element as HTMLVideoElement).currentTime);
    expect(afterStep).toBeGreaterThan(beforeStep);
    await page.screenshot({ path: "test-results/freezone-r8/timeline-preview.png", fullPage: true });
    await page.locator('[data-kind="audio"].toiv-timeline-clip').click();
    expect(await page.locator(".toiv-timeline-preview-empty").textContent()).toContain("暂无可预览媒体");
    await page.close();
});

test("monitor follows seeks across clips and transport respects clip boundaries", async () => {
    const page = await openHarness();
    await page.getByRole("button", { name: "展开时间线" }).click();
    await page.locator(".toiv-timeline-preview-media video").waitFor();
    expect(await page.getByRole("button", { name: "上一帧" }).isDisabled()).toBe(true);
    expect(await page.getByRole("button", { name: "跳到开头" }).isDisabled()).toBe(true);
    await page.locator(".toiv-timeline-canvas").click({ position: { x: 480, y: 4 } });
    expect(await page.locator('[title="shot-3"]').getAttribute("class")).toContain("is-selected");
    expect(await page.locator(".toiv-timeline-preview-monitor header").textContent()).toContain("镜头 3");
    expect(await page.locator(".toiv-timeline-timecode").textContent()).toContain("00:00:05:00");
    await page.screenshot({ path: "test-results/freezone-r12/timeline-second-clip.png", fullPage: true, animations: "disabled" });
    await page.locator('[title="shot-1"]').click();
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.locator(".toiv-timeline-preview-media video").evaluate((element) => {
        const video = element as HTMLVideoElement;
        video.currentTime = 4.5;
        video.dispatchEvent(new Event("timeupdate"));
    });
    await page.waitForFunction(() => document.querySelector(".toiv-timeline-timecode")?.textContent?.startsWith("00:00:04:12"));
    expect(await page.getByRole("button", { name: "播放", exact: true }).count()).toBe(1);
    expect(await page.locator(".toiv-timeline-preview-monitor header").textContent()).toContain("镜头 1");
    await page.close();
});

test("timeline load failure is explicit and retry restores real preview", async () => {
    const page = await openHarness("?fail=1");
    await page.getByRole("button", { name: "展开时间线" }).click();
    expect(await page.getByText("预览暂时不可用").count()).toBe(1);
    await page.screenshot({ path: "test-results/freezone-r12/timeline-load-error.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "重新加载" }).click();
    await page.locator(".toiv-timeline-preview-media video").waitFor();
    expect(await page.getByText("预览暂时不可用").count()).toBe(0);
    await page.close();
});

test("W7: create composer consumes canvas drafts and pending sessions", async () => {
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    await page.addInitScript(() => {
        localStorage.setItem("toiv_agent_draft", JSON.stringify({ text: "雨夜镜头续写", source: "canvas-node", nodeTitle: "SHOT 01" }));
        localStorage.setItem("toiv_agent_pending_session", "session-1");
    });
    // W7：view=agent 已无独立面；harness 仍挂 /create workbench，composer 消费 stash
    await page.goto(`${server.url}?view=agent`);
    const composer = page.getByLabel(/创作提示词/);
    await composer.waitFor({ timeout: 15_000 });
    await page.waitForFunction(() => {
        const el = document.querySelector('[aria-label*="创作提示词"]') as HTMLElement | null;
        const text = (el as HTMLTextAreaElement | HTMLInputElement | null)?.value
            ?? el?.textContent
            ?? "";
        return text.includes("雨夜镜头续写");
    }, { timeout: 15_000 });
    expect(await page.getByText("会话 session-1 已恢复").count()).toBe(1);
    expect(await page.evaluate(() => localStorage.getItem("toiv_agent_draft"))).toBeNull();
    expect(await page.evaluate(() => localStorage.getItem("toiv_agent_pending_session"))).toBeNull();
    expect(await page.getByTestId("creation-workbench").count()).toBe(1);
    await page.screenshot({ path: "test-results/freezone-r15/agent-view-consumed.png", fullPage: true, animations: "disabled" });
    await page.close();
});
