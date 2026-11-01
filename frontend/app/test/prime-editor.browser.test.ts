import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let project: any;
let calls: { path: string; method: string; body: any }[];
let detailStatus: number;
let headStatus: number;
let holdDetail: Promise<void> | undefined;
let errors: string[];

const media = (final: string) => ({
    visual_media_status: "current", audio_media_status: "current", final_media_status: final,
});
const initialShots = () => [
    { id: "s1", idx: 0, prompt: "雨夜", camera: "STATIC", duration_sec: 4, current_revision_id: "r1",
        status: "done", dialogue: "你来了", speaker: "甲", beats: [], render_mode: "video",
        final_clip_url: "/api/studio/files/s1.mp4", voice_url: "/api/studio/files/s1.mp3", ...media("current") },
    { id: "s2", idx: 1, prompt: "门开", camera: "PAN", duration_sec: 6, current_revision_id: "r2",
        status: "done", dialogue: "", speaker: "", beats: [], render_mode: "video",
        final_clip_url: "/api/studio/files/s2.mp4", voice_url: "", ...media("current") },
    { id: "s3", idx: 2, prompt: "回头", camera: "STATIC", duration_sec: 5, current_revision_id: "r3",
        status: "done", dialogue: "别回头", speaker: "乙", beats: [], render_mode: "video",
        final_clip_url: "", voice_url: "", ...media("none") },
    { id: "s4", idx: 3, prompt: "天亮", camera: "STATIC", duration_sec: 3, current_revision_id: "r4",
        status: "done", dialogue: "", speaker: "", beats: [], render_mode: "video",
        final_clip_url: "/api/studio/files/s4.mp4", voice_url: "", ...media("stale") },
];
const preview = () => ({
    fps: 24, content_mode: "narration",
    items: project.shots.map((shot: any, index: number) => ({
        shot_id: shot.id, idx: index, kind: shot.final_clip_url ? "video" : null,
        preview_url: shot.final_clip_url, media_url: shot.final_clip_url, duration_sec: shot.duration_sec,
    })),
});

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/prime-editor-harness.tsx"],
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const script = await build.outputs[0].text();
    const css = (await Promise.all(["index.css", "App.css", "styles/printfilm.css", "styles/toiv-skin.css"]
        .map(file => Bun.file(`${import.meta.dir}/../src/${file}`).text()))).join("\n");
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(request) {
        const path = new URL(request.url).pathname;
        if (path === "/harness.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
        if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
        if (path.startsWith("/api/")) return Response.json({ detail: "unmocked API" }, { status: 503 });
        return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
    } });
    browser = await chromium.launch({ headless: true, executablePath: process.env.CHROME_PATH || undefined });
}, 60_000);
beforeEach(async () => {
    project = {
        id: "p1", title: "测试剧", status: "done", shots: initialShots(),
        final_url: "/api/studio/files/final.mp4", bgm_url: "/api/studio/files/bgm.mp3",
    };
    calls = []; errors = []; detailStatus = 200; headStatus = 200; holdDetail = undefined;
    page = await browser.newPage({ acceptDownloads: true });
    page.setDefaultTimeout(4000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-token"));
    await page.route("**/api/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const body = request.postDataJSON();
        calls.push({ path, method, body });
        if (path.startsWith("/api/studio/files/")) { await route.fulfill({ status: 404 }); return; }
        if (path === "/api/studio/projects/p1" && method === "GET") {
            await holdDetail;
            if (detailStatus !== 200) { await route.fulfill({ status: detailStatus, json: { detail: "服务不可用" } }); return; }
            await route.fulfill({ json: project }); return;
        }
        if (path === "/api/studio/projects/p1/timeline-preview") { await route.fulfill({ json: preview() }); return; }
        if (path === "/api/studio/projects/p1/export/edl" && method === "HEAD") {
            await route.fulfill({
                status: headStatus,
                headers: headStatus === 200
                    ? { "X-Toiv-Missing-Assets": "1", "X-Toiv-Duration-Issues": "0", "X-Toiv-Export-Format": "cmx3600" }
                    : { "Content-Type": "application/json" },
                body: headStatus === 200 ? "" : JSON.stringify({ detail: "拒绝导出" }),
            }); return;
        }
        if (path === "/api/studio/projects/p1/export/edl" && method === "GET") {
            await route.fulfill({
                status: 200,
                headers: {
                    "Content-Type": "text/plain; charset=utf-8",
                    "Content-Disposition": "attachment; filename*=UTF-8''%E6%B5%8B%E8%AF%95%E5%89%A7.edl",
                    "X-Toiv-Export-Format": "cmx3600", "X-Toiv-Missing-Assets": "1", "X-Toiv-Duration-Issues": "0",
                },
                body: "TITLE: 测试剧\n",
            }); return;
        }
        if (path.endsWith("/shots") && method === "PUT") {
            project.shots = body.shots.map((shot: any) => {
                const old = project.shots.find((item: any) => item.id === shot.id);
                return { ...old, ...shot, current_revision_id: `rev-${shot.id}-${shot.duration_sec}` };
            });
            await route.fulfill({ json: { shots: project.shots } }); return;
        }
        if (path.endsWith("/assemble") && method === "POST") {
            project.final_url = "/api/studio/files/final2.mp4";
            await route.fulfill({ json: project }); return;
        }
        await route.fulfill({ json: [] });
    });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); server?.stop(true); });

const goto = (path: string) => page.goto(`http://127.0.0.1:${server.port}${path}`);
const clock = () => page.locator(".toiv-edit-clock").innerText();
const scrub = () => page.getByLabel("播放头").inputValue();
const waitEnabled = (name: string) => page.waitForFunction((label) => {
    const match = Array.from(document.querySelectorAll("button"))
        .find(button => button.getAttribute("aria-label") === label);
    return match instanceof HTMLButtonElement && !match.disabled;
}, name);
const durationValue = (value: string) => page.waitForFunction((expected) => {
    const input = document.querySelector('input[aria-label="选中镜时长（秒）"]') as HTMLInputElement | null;
    return Boolean(input && input.value === expected);
}, value);
const clipLabels = () => page.locator(".toiv-edit-track .toiv-edit-clip").evaluateAll(elements =>
    elements.map(element => element.getAttribute("aria-label") ?? ""));

test("bay projects four tracks and lists the missing shot before export", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    expect(await page.getByText("4 镜 · 3 进线 · 24fps", { exact: true }).count()).toBe(1);
    expect(await page.locator(".toiv-edit-lane .label").allTextContents()).toEqual(["V1 画面", "A1 配音", "S1 字幕", "A2 声床"]);
    expect(await page.getByRole("button", { name: "镜01 · 4.0s", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "镜02 · 6.0s", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "镜04 · 3.0s", exact: true }).count()).toBe(1);
    expect((await clipLabels()).some(label => label.startsWith("镜03"))).toBe(false);
    expect(await page.locator(".toiv-edit-track .toiv-edit-clip").count()).toBe(6);
    expect(await page.getByRole("button", { name: /^镜01 配音 · 4\.0s/ }).count()).toBe(1);
    expect(await page.getByRole("button", { name: /^镜01 字幕 · 4\.0s/ }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "声床 · 13.0s", exact: true }).count()).toBe(1);
    expect(await page.getByRole("button", { name: "镜03 · 缺片段", exact: true }).count()).toBe(1);
    expect(await clock()).toBe("00:00.0 / 00:13.0");
    expect(await page.getByLabel("选中镜时长（秒）").inputValue()).toBe("4");
    expect(await page.locator(".toiv-edit-inspector").getByText("你来了").count()).toBe(1);
    expect(await page.locator("video").first().getAttribute("aria-label")).toBe("镜01 预览");
    expect(await page.getByRole("link", { name: "查看成片" }).getAttribute("href")).toContain("/api/studio/files/final.mp4?token=fixture-token");
    expect(await page.locator(".toiv-edit-mobile-note").isVisible()).toBe(false);
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText("缺素材 1 · 时长异常 0", { exact: true }).waitFor();
    expect(await page.getByText("1 镜缺最终片段 · 导出会跳过这些镜头", { exact: true }).count()).toBe(1);
    expect(await page.locator(".toiv-edit-issues").getByText("镜03", { exact: true }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "导出成片" }).getAttribute("href")).toContain("final.mp4?token=fixture-token");
    for (const name of ["导出剪映草稿", "导出EDL", "导出FCPXML", "导出多轨 ZIP"]) {
        expect(await page.getByRole("button", { name, exact: true }).isEnabled()).toBe(true);
    }
    expect(calls.filter(call => call.method === "HEAD").length).toBe(1);
    expect(errors).toEqual([]);
});

test("transport plays, pauses and jumps shot by shot with buttons and keys", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.getByRole("button", { name: "下一镜", exact: true }).click();
    expect(await clock()).toBe("00:04.0 / 00:13.0");
    await page.getByRole("button", { name: "下一镜", exact: true }).click();
    expect(await clock()).toBe("00:10.0 / 00:13.0");
    await page.getByRole("button", { name: "上一镜", exact: true }).click();
    expect(await clock()).toBe("00:04.0 / 00:13.0");
    await page.getByRole("button", { name: "播放", exact: true }).click();
    await page.waitForFunction(() => {
        const text = document.querySelector(".toiv-edit-clock")?.textContent ?? "";
        return text.length > 0 && !text.startsWith("00:04.0");
    });
    await page.getByRole("button", { name: "暂停", exact: true }).click();
    await new Promise(resolve => setTimeout(resolve, 250));
    const paused = await clock();
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(await clock()).toBe(paused);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await page.keyboard.press("l");
    expect(await clock()).toBe("00:10.0 / 00:13.0");
    await page.keyboard.press("j");
    expect(await clock()).toBe("00:04.0 / 00:13.0");
    await page.keyboard.press("ArrowLeft");
    expect(await clock()).toBe("00:03.0 / 00:13.0");
    await page.keyboard.press("ArrowRight");
    expect(await clock()).toBe("00:04.0 / 00:13.0");
    await page.keyboard.press(" ");
    await page.waitForFunction(() => (document.querySelector(".toiv-edit-clock")?.textContent ?? "").startsWith("00:05"));
    await page.keyboard.press(" ");
    const stopped = await clock();
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(await clock()).toBe(stopped);
    expect(errors).toEqual([]);
});

test("ruler seeks with snap and the scrub reports the same playhead", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.locator(".toiv-edit-ruler").click({ position: { x: 4 * 48 + 4, y: 5 } });
    expect(await scrub()).toBe("4");
    expect(await clock()).toBe("00:04.0 / 00:13.0");
    await page.getByRole("button", { name: "吸附切点" }).click();
    expect(await page.getByRole("button", { name: "吸附切点" }).getAttribute("aria-pressed")).toBe("false");
    await page.locator(".toiv-edit-ruler").click({ position: { x: 9 * 48 + 38, y: 5 } });
    expect(await scrub()).toBe("9.8");
    expect(errors).toEqual([]);
});

test("duration edits stay local, block export, then persist through the shot write path", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("button", { name: "镜02 · 6.0s", exact: true }).click();
    const input = page.getByLabel("选中镜时长（秒）");
    await input.fill("8");
    await input.press("Enter");
    await page.getByText("1 镜未保存", { exact: true }).waitFor();
    expect(await page.getByText("未保存：6s → 8s", { exact: true }).count()).toBe(1);
    expect(await clock()).toBe("00:04.0 / 00:15.0");
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText("1 镜时长未保存；导出会使用服务端旧切点", { exact: true }).waitFor();
    expect(await page.getByRole("button", { name: "导出EDL", exact: true }).isDisabled()).toBe(true);
    expect(await page.getByText("先保存时长再导出，否则服务端仍用旧切点", { exact: true }).count()).toBe(1);
    expect(calls.filter(call => call.method === "PUT")).toHaveLength(0);
    await page.getByRole("button", { name: "保存时长 (1)", exact: true }).click();
    await page.getByText("已保存 1 镜时长；导出切点已同步", { exact: true }).waitFor();
    await waitEnabled("导出EDL");
    expect(await clock()).toBe("00:04.0 / 00:15.0");
    expect(await input.inputValue()).toBe("8");
    expect(await page.getByText("1 镜未保存", { exact: true }).count()).toBe(0);
    const put = calls.find(call => call.method === "PUT");
    expect(put?.path).toBe("/api/studio/projects/p1/shots");
    expect(put?.body.expected_shot_ids).toEqual(["s1", "s2", "s3", "s4"]);
    expect(put?.body.shots).toHaveLength(4);
    expect(put?.body.shots[0]).toMatchObject({ id: "s1", duration_sec: 4, expected_revision: "r1" });
    expect(put?.body.shots[1]).toMatchObject({ id: "s2", duration_sec: 8, expected_revision: "r2", prompt: "门开" });
    expect(put?.body.shots[2]).toMatchObject({ id: "s3", duration_sec: 5, expected_revision: "r3" });
    expect(put?.body.shots[3]).toMatchObject({ id: "s4", duration_sec: 3, expected_revision: "r4" });
    expect(errors).toEqual([]);
});

test("trim handles keyboard, undo, redo and pointer drag without touching the server", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("button", { name: "镜02 · 6.0s", exact: true }).click();
    const separator = page.getByRole("separator", { name: "拖动调整 镜02 时长" });
    await separator.focus();
    await page.keyboard.press("ArrowRight");
    await durationValue("7");
    expect(await clock()).toBe("00:04.0 / 00:14.0");
    expect(await page.getByText("1 镜未保存", { exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await durationValue("6");
    await page.getByRole("button", { name: "重做", exact: true }).click();
    await durationValue("7");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await durationValue("6");
    await page.getByRole("button", { name: "时长加 1 秒", exact: true }).click();
    await durationValue("7");
    await page.getByRole("button", { name: "时长减 1 秒", exact: true }).click();
    await durationValue("6");
    await separator.scrollIntoViewIfNeeded();
    const box = await separator.boundingBox();
    if (!box) throw new Error("trim handle missing");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2 + 96, box.y + box.height / 2, { steps: 8 });
    await page.mouse.up();
    await durationValue("8");
    await page.getByRole("button", { name: "撤销", exact: true }).click();
    await durationValue("6");
    expect(calls.filter(call => call.method === "PUT" || call.method === "POST")).toHaveLength(0);
    expect(errors).toEqual([]);
});

test("exports the EDL through the download path and reports the server receipt", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText("缺素材 1 · 时长异常 0", { exact: true }).waitFor();
    const pending = page.waitForEvent("download");
    await page.getByRole("button", { name: "导出EDL", exact: true }).click();
    const download = await pending;
    expect(download.suggestedFilename()).toBe("测试剧.edl");
    await page.getByText(/已导出 EDL · 测试剧\.edl · 服务端记录缺素材 1/).waitFor();
    expect(calls.filter(call => call.path.endsWith("/export/edl") && call.method === "GET")).toHaveLength(1);
    expect(errors).toEqual([]);
});

test("a rejected preflight keeps every draft export disabled with the server reason", async () => {
    headStatus = 422;
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText(/服务端拒绝导出：/).waitFor();
    expect(await page.getByText(/^导出被拒绝 · /).count()).toBe(1);
    for (const name of ["导出剪映草稿", "导出EDL", "导出FCPXML", "导出多轨 ZIP"]) {
        expect(await page.getByRole("button", { name, exact: true }).isDisabled()).toBe(true);
    }
    expect(await page.getByRole("link", { name: "导出成片" }).count()).toBe(1);
    expect(errors).toEqual([]);
});

test("missing and stale finals route the primary action to the exact storyboard shot", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.getByRole("button", { name: "补齐缺失片段", exact: true }).click();
    await page.getByText("流水线占位", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/studio/p1");
    expect(new URL(page.url()).search).toBe("?shot=s3");
    project.shots[2].final_clip_url = "/api/studio/files/s3.mp4";
    project.shots[2].final_media_status = "current";
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    await page.getByRole("button", { name: "重新渲染成片", exact: true }).click();
    await page.getByText("流水线占位", { exact: true }).waitFor();
    expect(new URL(page.url()).search).toBe("?shot=s4");
    expect(errors).toEqual([]);
});

test("assembling updates the final link and switches the primary action", async () => {
    project.shots = project.shots.map((shot: any) => ({
        ...shot, final_clip_url: shot.final_clip_url || "/api/studio/files/s3.mp4", final_media_status: "current",
    }));
    project.final_url = "";
    await goto("/studio/p1/editor");
    await page.getByRole("button", { name: "合成成片", exact: true }).click();
    await page.getByText("成片已合成，可查看或导出", { exact: true }).waitFor();
    expect(calls.filter(call => call.method === "POST" && call.path.endsWith("/assemble"))).toHaveLength(1);
    expect(await page.getByRole("link", { name: "查看成片" }).getAttribute("href")).toContain("final2.mp4?token=fixture-token");
    expect(await page.getByRole("button", { name: "重新合成成片", exact: true }).count()).toBe(1);
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText("缺素材 1 · 时长异常 0", { exact: true }).waitFor();
    expect(errors).toEqual([]);
});

test("an empty project explains the missing clips and blocks draft export", async () => {
    project.shots = [];
    await goto("/studio/p1/editor");
    await page.getByText("暂无分镜；剪辑湾只消费已归档片段。", { exact: true }).waitFor();
    await page.getByRole("button", { name: "导出", exact: true }).click();
    await page.getByText("没有可导出的画面片段", { exact: true }).first().waitFor();
    expect(await page.getByText("没有可导出的画面片段", { exact: true }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("button", { name: "导出EDL", exact: true }).isDisabled()).toBe(true);
    expect(errors).toEqual([]);
});

test("an in-flight timeline read reports loading, never zero shots or a zero clock", async () => {
    let release!: () => void;
    holdDetail = new Promise(resolve => { release = resolve; });
    await goto("/studio/p1/editor");
    await page.getByText("正在载入时间线…", { exact: true }).waitFor();
    expect(await page.getByRole("heading", { name: "载入中", exact: true }).count()).toBe(1);
    expect(await page.getByText(/0 镜/).count()).toBe(0);
    expect(await page.locator(".toiv-edit-clock").count()).toBe(0);
    release();
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    expect(await page.locator(".toiv-edit-clock").count()).toBe(1);
    expect(errors).toEqual([]);
});

test("edit bay interactive clips and missing chips use the shared button primitive", async () => {
    await goto("/studio/p1/editor");
    await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
    const classes = await page.evaluate(() => ({
        clip: document.querySelector(".toiv-edit-clip")?.className ?? "",
        chip: document.querySelector(".toiv-edit-miss-chip")?.className ?? "",
    }));
    expect(classes.clip).toContain("pf-btn");
    expect(classes.clip).toContain("pf-btn-ghost");
    expect(classes.chip).toContain("pf-btn");
    expect(classes.chip).toContain("pf-btn-ghost");
    const geometry = await page.locator(".toiv-edit-track .toiv-edit-clip").first().evaluate(element => {
        const style = getComputedStyle(element);
        return { position: style.position, display: style.display, whiteSpace: style.whiteSpace };
    });
    expect(geometry.position).toBe("absolute");
    expect(geometry.display).toBe("flex");
    expect(errors).toEqual([]);
});

test("load failures offer a retry path back to the project library", async () => {
    detailStatus = 500;
    await goto("/studio/p1/editor");
    await page.getByText("时间线载入失败 · 可重试", { exact: true }).waitFor();
    await page.getByRole("button", { name: "回项目库", exact: true }).click();
    await page.getByText("项目库占位", { exact: true }).waitFor();
    expect(new URL(page.url()).pathname).toBe("/studio");
    expect(errors).toEqual([]);
});

for (const width of [390, 768]) {
    test(`edit bay keeps a usable single column without page overflow at ${width}px`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await goto("/studio/p1/editor");
        await page.getByRole("heading", { name: "测试剧", exact: true }).waitFor();
        const layout = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth > window.innerWidth,
            noteVisible: (() => {
                const note = document.querySelector(".toiv-edit-mobile-note");
                return note ? getComputedStyle(note).display !== "none" : false;
            })(),
            stacked: (() => {
                const panel = document.querySelector(".toiv-edit-layout");
                return panel ? getComputedStyle(panel).gridTemplateColumns.split(" ").length === 1 : false;
            })(),
            timelineScrollable: (() => {
                const scroll = document.querySelector(".toiv-edit-scroll");
                return scroll ? scroll.scrollWidth > scroll.clientWidth : false;
            })(),
        }));
        expect(layout.overflow).toBe(false);
        expect(layout.stacked).toBe(true);
        if (width <= 700) expect(layout.timelineScrollable).toBe(true);
        expect(layout.noteVisible).toBe(width <= 700);
        await page.getByRole("button", { name: "镜02 · 6.0s", exact: true }).click();
        expect(await page.getByLabel("选中镜时长（秒）").isVisible()).toBe(true);
        await page.getByRole("button", { name: "导出", exact: true }).click();
        await page.getByText("缺素材 1 · 时长异常 0", { exact: true }).waitFor();
        expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
        expect(errors).toEqual([]);
    });
}
