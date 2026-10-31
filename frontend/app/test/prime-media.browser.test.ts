import { afterAll, beforeAll, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let server: ReturnType<typeof Bun.serve>;
let browser: Browser;
let origin: string;
const fakeToken = "media-test-only-not-a-credential";

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.path], target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, BASE_URL: "/" }) },
        plugins: [{ name: "isolated-media-harness", setup(builder) {
            builder.onLoad({ filter: /prime-media\.browser\.test\.ts$/ }, () => ({ loader: "tsx", contents: `
                import { useState } from "${import.meta.dir}/../node_modules/react";
                import { createRoot } from "${import.meta.dir}/../node_modules/react-dom/client";
                import { MemoryRouter } from "${import.meta.dir}/../node_modules/react-router-dom";
                import { I18nProvider } from "${import.meta.dir}/../src/i18n/context";
                import PrimeHistory from "${import.meta.dir}/../src/toiv/pages/PrimeHistory";
                import { TaskDrawerPrime } from "${import.meta.dir}/../src/toiv/addons/TaskDrawerPrime";
                function App() {
                    const [open, setOpen] = useState(false);
                    const [mounted, setMounted] = useState(true);
                    return <MemoryRouter><I18nProvider>
                        <button onClick={() => setMounted(false)}>卸载测试视图</button>
                        {mounted && (location.pathname === "/drawer"
                            ? <><button onClick={() => setOpen(true)}>打开任务</button><TaskDrawerPrime open={open} onClose={() => setOpen(false)} /></>
                            : <PrimeHistory />)}
                    </I18nProvider></MemoryRouter>;
                }
                createRoot(document.getElementById("root")).render(<App />);
            ` }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path.startsWith("/api/")) return Response.json({ detail: "unmocked test request" }, { status: 503 });
        return new Response('<div id="root"></div><script type="module" src="/harness.js"></script>', { headers: { "Content-Type": "text/html" } });
    } });
    origin = `http://127.0.0.1:${server.port}`;
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);
afterAll(async () => { await browser?.close(); server?.stop(true); });

function job(id: string, results: string[] = [], status = "done") {
    return { id, prompt_id: id, kind: id, prompt: id, status, results, progress: { pct: 37 },
        created_at: "2026-10-29T10:00:00Z", error: "", hold_reason: "", post_status: "" };
}
async function withPage(run: (page: Page, errors: string[]) => Promise<void>) {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1600 } });
    page.setDefaultTimeout(2500);
    const errors: string[] = [];
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(token => localStorage.setItem("toiv_token", token), fakeToken);
    // No request, even a malformed external media URL, can reach a real service.
    await page.route("**/*", route => new URL(route.request().url()).origin === origin
        ? route.continue() : route.fulfill({ status: 404, body: "test-only external stub" }));
    try { await run(page, errors); } finally { await page.close(); }
}
const card = (page: Page, title: string) => page.locator("article").filter({ has: page.locator("b", { hasText: title }) });

// Old code's object[] assumption / unconditional img must fail this test.
test("history renders media-specific elements and signs only same-origin API requests", () => withPage(async page => {
    const mediaRequests: string[] = [];
    await page.route("**/api/jobs?*", route => route.fulfill({ json: [
        job("video", ["/api/images?filename=movie.MP4&type=output"]),
        job("audio", ["/api/studio/files/speech.wav"]),
        job("image", ["/api/images?filename=cover.webp"]),
        job("external", ["https://cdn.example.test/api/images?filename=external.png"]),
        job("unsafe", ["javascript:alert(1)", "data:text/html,<h1>unsafe</h1>"]),
        job("no-output"), job("failed-output", [], "error"),
    ] }));
    await page.route(/\/api\/(images|studio\/files)/, async route => {
        mediaRequests.push(route.request().url());
        await route.fulfill({ status: 404, body: "missing fixture" });
    });
    await page.goto(`${origin}/history`);
    await card(page, "video").locator("video").waitFor({ state: "attached" });
    expect(await card(page, "video").locator("video").getAttribute("controls")).not.toBeNull();
    expect(await card(page, "video").locator("video").getAttribute("preload")).toBe("metadata");
    expect(await card(page, "audio").locator("audio").getAttribute("controls")).not.toBeNull();
    expect(await card(page, "image").locator("img").getAttribute("loading")).toBe("lazy");
    expect(await card(page, "image").locator("img").getAttribute("alt")).toContain("image");
    expect(await card(page, "unsafe").locator("img, video, audio, a").count()).toBe(0);
    expect(await card(page, "no-output").innerText()).toContain("无");
    expect(await card(page, "failed-output").innerText()).toContain("失败");
    await page.waitForFunction(() => document.querySelectorAll('[role="alert"]').length >= 4);
    expect(mediaRequests.length).toBeGreaterThanOrEqual(4);
    for (const value of mediaRequests) {
        const url = new URL(value);
        expect(url.searchParams.get("token")).toBe(url.origin === origin ? fakeToken : null);
    }
    expect(await page.locator(`a[href*="${fakeToken}"]`).count()).toBe(0);
    await card(page, "video").getByRole("button", { name: /重试/ }).click();
    await page.waitForFunction(() => document.querySelector('article video')?.getAttribute('preload') === 'metadata');
    await page.waitForFunction(() => document.querySelectorAll('[role="alert"]').length >= 4);
    expect(mediaRequests.filter(url => url.includes("movie.MP4")).length).toBeGreaterThanOrEqual(2);
}), 15_000);

test("image and audio retries recover from HTTP errors into decoded local fixtures", () => withPage(async page => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a3ioAAAAASUVORK5CYII=", "base64");
    const wav = Buffer.alloc(44 + 1600);
    wav.write("RIFF", 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write("WAVEfmt ", 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(8000, 24); wav.writeUInt32LE(16000, 28);
    wav.writeUInt16LE(2, 32); wav.writeUInt16LE(16, 34); wav.write("data", 36); wav.writeUInt32LE(1600, 40);
    let fail = true;
    await page.route("**/api/jobs?*", route => route.fulfill({ json: [
        job("recover-image", ["/api/studio/files/frame.png"]), job("recover-audio", ["/api/studio/files/voice.wav"]),
    ] }));
    await page.route("**/api/studio/files/**", route => route.fulfill(fail ? { status: 403, body: "expired test session" }
        : route.request().url().includes("frame.png") ? { body: png, contentType: "image/png" }
            : { body: wav, contentType: "audio/wav" }));
    await page.goto(`${origin}/history`);
    await card(page, "recover-image").getByRole("alert").waitFor();
    await card(page, "recover-audio").getByRole("alert").waitFor();
    fail = false;
    await card(page, "recover-image").getByRole("button", { name: "重试媒体" }).click();
    await card(page, "recover-audio").getByRole("button", { name: "重试媒体" }).click();
    await page.waitForFunction(() => {
        const image = document.querySelector("article img") as HTMLImageElement;
        const audio = document.querySelector("article audio") as HTMLAudioElement;
        return image?.naturalWidth > 0 && audio?.readyState >= 1 && audio.duration > 0;
    });
    expect(await page.getByRole("alert").count()).toBe(0);
}), 15_000);

test("history distinguishes loading, request failure and true empty, with retry", () => withPage(async page => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let fail = true;
    await page.route("**/api/jobs?*", async route => {
        await gate;
        await route.fulfill(fail ? { status: 503, json: { detail: "unavailable" } } : { json: [] });
    });
    await page.goto(`${origin}/history`);
    expect(await page.getByText(/还没有产物|队列空闲/).count()).toBe(0);
    expect(await page.getByRole("status").count()).toBeGreaterThan(0);
    // An in-flight read is unknown, not zero.
    expect((await page.locator(".toiv-assets-col h3").first().innerText()).trim()).toBe("作品");
    expect((await page.locator(".toiv-assets-col h3").last().innerText()).trim()).toBe("任务");
    release();
    await page.getByText("作品库载入失败", { exact: true }).waitFor();
    expect(await page.getByText(/队列空闲/).count()).toBe(0);
    fail = false;
    await page.getByRole("button", { name: "重试载入作品" }).click();
    await page.getByText(/还没有产物/).waitFor();
    await page.getByRole("button", { name: "重试载入任务" }).click();
    await page.getByText(/队列空闲/).waitFor();
    expect((await page.locator(".toiv-assets-col h3").first().innerText()).trim()).toBe("作品 0");
    expect((await page.locator(".toiv-assets-col h3").last().innerText()).trim()).toBe("任务 0");
}), 15_000);

for (const surface of ["history", "drawer"]) {
    test(`${surface}: cancellation failure recovers, duplicate pending action is disabled, success refreshes`, () => withPage(async (page, errors) => {
        let canceled = false;
        let attempts = 0;
        let release!: () => void;
        const gate = new Promise<void>(resolve => { release = resolve; });
        await page.route("**/api/jobs?*", route => route.fulfill({ json: [job("running-task", [], canceled ? "canceled" : "running")] }));
        await page.route("**/api/jobs/running-task/cancel", async route => {
            attempts++;
            if (attempts === 1) { await gate; await route.fulfill({ status: 409, json: { detail: "cancel rejected" } }); }
            else { canceled = true; await route.fulfill({ json: { ok: true, status: "canceled" } }); }
        });
        await page.goto(`${origin}/${surface}`);
        if (surface === "drawer") await page.getByRole("button", { name: "打开任务", exact: true }).click();
        await page.getByRole("button", { name: "取消", exact: true }).click();
        expect(await page.getByRole("button", { name: "取消中…", exact: true }).isDisabled()).toBe(true);
        expect(attempts).toBe(1);
        release();
        await page.getByText(/取消失败/).waitFor();
        await page.getByRole("button", { name: "重试取消", exact: true }).click();
        await page.getByText(/已取消/).first().waitFor();
        expect(await page.getByRole("button", { name: /^(取消|取消中…|重试取消)$/ }).count()).toBe(0);
        expect(canceled).toBe(true);
        expect(errors).toEqual([]);
    }), 15_000);
}

test("successful cancellation remains acknowledged when the follow-up refresh fails", () => withPage(async page => {
    let canceled = false;
    let failRefresh = true;
    await page.route("**/api/jobs?*", route => route.fulfill(canceled && failRefresh
        ? { status: 503, json: {} } : { json: [job("refresh-task", [], canceled ? "canceled" : "running")] }));
    await page.route("**/api/jobs/refresh-task/cancel", route => {
        canceled = true;
        return route.fulfill({ json: { ok: true, status: "canceled" } });
    });
    await page.goto(`${origin}/drawer`);
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.getByText("任务载入失败", { exact: true }).waitFor();
    expect(await page.getByText("任务已取消", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^(取消|取消中…|重试取消)$/ }).count()).toBe(0);
    failRefresh = false;
    await page.getByRole("button", { name: "重试载入任务" }).click();
    await page.getByText("任务载入失败", { exact: true }).waitFor({ state: "detached" });
    expect(await page.getByText("已取消", { exact: true }).count()).toBe(1);
}), 15_000);

test("a late cancellation response cannot update a reopened drawer or an unmounted history", () => withPage(async (page, errors) => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let reads = 0;
    await page.route("**/api/jobs?*", route => {
        reads++;
        return route.fulfill({ json: [job(reads === 1 ? "old-task" : "new-task", [], "running")] });
    });
    await page.route("**/api/jobs/old-task/cancel", async route => {
        await gate;
        await route.fulfill({ json: { ok: true, status: "canceled" } }).catch(() => {});
    });
    await page.goto(`${origin}/drawer`);
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByRole("button", { name: "取消", exact: true }).click();
    await page.keyboard.press("Escape");
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByText("new-task", { exact: true }).waitFor();
    release();
    await page.evaluate(() => fetch("/harness.js").then(response => response.text()));
    expect(await page.getByText("任务已取消", { exact: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: "取消", exact: true }).isEnabled()).toBe(true);

    let finishReads!: () => void;
    const historyGate = new Promise<void>(resolve => { finishReads = resolve; });
    await page.route("**/api/jobs?*", async route => {
        await historyGate;
        await route.fulfill({ json: [job("late-history")] }).catch(() => {});
    });
    await page.goto(`${origin}/history`);
    await page.getByRole("button", { name: "卸载测试视图" }).click();
    finishReads();
    await page.evaluate(() => fetch("/harness.js").then(response => response.text()));
    expect(await page.locator("article").count()).toBe(0);
    expect(errors).toEqual([]);
}), 15_000);

test("drawer errors are explicit and retryable; closed controls leave the DOM", () => withPage(async page => {
    let fail = true;
    await page.route("**/api/jobs?*", route => route.fulfill(fail ? { status: 503, json: {} } : { json: [] }));
    await page.goto(`${origin}/drawer`);
    expect(await page.getByRole("button", { name: /取消|关闭/ , includeHidden: true }).count()).toBe(0);
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByText("任务载入失败", { exact: true }).waitFor();
    expect(await page.getByText(/队列空闲/).count()).toBe(0);
    fail = false;
    await page.getByRole("button", { name: "重试载入任务" }).click();
    await page.getByText(/队列空闲/).waitFor();
    await page.keyboard.press("Escape");
    expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(0);
    expect(await page.getByRole("button", { name: /取消|关闭/, includeHidden: true }).count()).toBe(0);
}), 15_000);

test("drawer polls again after completion, then stops when unmounted while open", () => withPage(async page => {
    await page.clock.install();
    let reads = 0;
    await page.route("**/api/jobs?*", route => {
        reads++;
        return route.fulfill({ json: [job("polled-task", [], reads === 1 ? "running" : "done")] });
    });
    await page.goto(`${origin}/drawer`);
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await page.getByText("生成中", { exact: true }).waitFor();
    await page.clock.runFor(5001);
    await page.getByText("完成", { exact: true }).waitFor();
    expect(reads).toBe(2);
    await page.getByRole("button", { name: "卸载测试视图" }).click();
    await page.clock.runFor(20_000);
    expect(reads).toBe(2);
    expect(await page.getByRole("dialog", { includeHidden: true }).count()).toBe(0);
}), 15_000);

test("drawer polling does not overlap slow requests and stops on close/unmount", () => withPage(async (page, errors) => {
    await page.clock.install();
    let requests = 0;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    await page.route("**/api/jobs?*", async route => {
        requests++;
        await gate;
        await route.fulfill({ json: [job("late-task", [], "running")] }).catch(() => {});
    });
    await page.goto(`${origin}/drawer`);
    const firstRead = page.waitForRequest("**/api/jobs?*");
    await page.getByRole("button", { name: "打开任务", exact: true }).click();
    await firstRead;
    await page.clock.runFor(16_000);
    // Drain browser/network messages, rather than assuming timer advancement flushes requests.
    await page.evaluate(() => fetch("/harness.js").then(response => response.text()));
    expect(requests).toBe(1);
    await page.keyboard.press("Escape");
    release();
    await page.clock.runFor(16_000);
    expect(await page.getByText("late-task").count()).toBe(0);
    expect(requests).toBe(1);
    await page.getByRole("button", { name: "卸载测试视图" }).click();
    await page.clock.runFor(16_000);
    expect(requests).toBe(1);
    expect(errors).toEqual([]);
}), 15_000);
