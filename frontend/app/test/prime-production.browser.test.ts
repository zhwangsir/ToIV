import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let calls: { path: string; method: string; body: any }[];
let errors: string[];
let states: Record<string, { state: string; ready: boolean; blockers: string[] }>;
let revision: number;
let ready: boolean;
let shotRows: any[];

const baseStates = () => ({
    script: { state: "confirmed", ready: true, blockers: [] },
    assets: { state: "skipped", ready: false, blockers: [] },
    storyboard: { state: "confirmed", ready: true, blockers: [] },
    generate: { state: "confirmed", ready: true, blockers: [] },
    voice: { state: "pending_confirmation", ready: true, blockers: [] },
    timeline: { state: "draft", ready: false, blockers: [] },
});
const takeRows = () => [
    { id: "c1", seed: 11, is_picked: false, url: "/api/media/t1.mp4", status: "done", video_model: "h3", pipeline: "ref2va", revision_id: "r6", qa: { verdict: "pass" } },
    { id: "c2", seed: 22, is_picked: true, url: "/api/media/t2.mp4", status: "done", video_model: "h3", pipeline: "ref2va", revision_id: "r6", qa: { verdict: "review" } },
    { id: "c3", seed: 33, is_picked: false, url: "/api/media/t3.mp4", status: "running", video_model: "h3", pipeline: "ref2va", revision_id: "r7" },
];
const baseShots = () => [
    {
        id: "s1", idx: 0, scene: "卧室", prompt: "晨雾里的窗", negative: null, camera: "DOLLY IN", dialogue: "你在等谁？", speaker: "林深",
        duration_sec: 6, characters: [], render_mode: "video", seam_to_next: null, seam_anchor: null, ref_epoch: null, ref_epoch_note: null, beats: [],
        status: "done", current_revision_id: "r6", candidates_digest: "digest-1", candidates: takeRows(),
        video_url: "/api/media/s1.mp4", voice_url: "/api/media/s1.wav", final_clip_url: "/api/media/s1-final.mp4",
        visual_media_status: "current", audio_media_status: "stale", final_media_status: "stale",
    },
    {
        id: "s2", idx: 1, scene: "走廊", prompt: "走廊尽头", negative: null, camera: "STATIC", dialogue: "", speaker: "",
        duration_sec: 4, characters: [], render_mode: "image_motion", seam_to_next: null, seam_anchor: null, ref_epoch: null, ref_epoch_note: null, beats: [],
        status: "wait", current_revision_id: "r7", candidates_digest: "digest-2", candidates: [],
        video_url: "", voice_url: "", final_clip_url: "",
        visual_media_status: "current", audio_media_status: "none", final_media_status: "none",
    },
];
const projectShots = () => ready
    ? shotRows.map(shot => ({ ...shot, audio_media_status: shot.audio_media_status === "stale" ? "current" : shot.audio_media_status,
        final_clip_url: shot.final_clip_url || "/api/media/final-shot.mp4", final_media_status: "current" }))
    : shotRows;
const revisionRows = () => [
    { id: "r6", version: 6, source: "manual-edit", parent_id: "r5", visual_fingerprint: "vf6", audio_fingerprint: "af6", created_by: "fixture", created_at: "2026-11-01T08:00:00Z" },
    { id: "r5", version: 5, source: "rollback", parent_id: "r4", visual_fingerprint: "vf5", audio_fingerprint: "af5", created_by: "fixture", created_at: "2026-10-31T08:00:00Z" },
];
const projectDetail = (patch: Record<string, unknown> = {}) => ({
    id: "p1", title: "测试剧", shots: projectShots(),
    stage_states: states, stage_revision: revision, ...patch,
});

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
    states = baseStates(); revision = 7; ready = false; shotRows = baseShots(); calls = []; errors = [];
    page = await browser.newPage();
    page.setDefaultTimeout(3000);
    page.on("pageerror", error => errors.push(error.message));
    await page.addInitScript(() => {
        localStorage.setItem("toiv_token", "fixture-token");
        ((window as any).__media ??= { plays: 0, pauses: 0 });
        HTMLMediaElement.prototype.play = function () { (window as any).__media.plays += 1; return Promise.resolve(); };
        HTMLMediaElement.prototype.pause = function () { (window as any).__media.pauses += 1; };
    });
    await page.route("**/api/**", async route => {
        const request = route.request();
        const path = new URL(request.url()).pathname;
        const method = request.method();
        const body = request.postDataJSON();
        calls.push({ path, method, body });
        if (path === "/api/studio/projects/p1" && method === "GET") {
            await route.fulfill({ json: projectDetail(ready ? { final_url: "/api/media/final.mp4", status: "done" } : {}) }); return;
        }
        if (path === "/api/studio/projects/p1/stage-transition" && method === "POST") {
            states[body.stage] = { ...states[body.stage], state: body.action === "confirm" ? "confirmed" : "skipped" };
            revision += 1;
            await route.fulfill({ json: { project_id: "p1", stage: body.stage, stage_states: states, stage_revision: revision } }); return;
        }
        if (path === "/api/studio/projects/p1/assemble" && method === "POST") {
            const missing = projectShots().filter(shot => !shot.final_clip_url);
            const stale = projectShots().filter(shot => shot.final_media_status === "stale");
            const voiceOpen = !["confirmed", "skipped"].includes(states.voice.state);
            if (voiceOpen) {
                await route.fulfill({ status: 409, json: { detail: { code: "VOICE_STAGE_NOT_CONFIRMED", message: "配音阶段未确认或跳过" } } }); return;
            }
            if (stale.length) {
                await route.fulfill({ status: 409, json: { detail: { code: "STALE_FINAL_CLIPS", message: `最终片段已过期,请重渲染/重对口型后再合成: ${stale.map(shot => shot.id).join(", ")}` } } }); return;
            }
            if (missing.length) {
                await route.fulfill({ status: 422, json: { detail: `缺少最终片段: ${missing.map(shot => shot.id).join(", ")}` } }); return;
            }
            await route.fulfill({ json: projectDetail({ final_url: "/api/media/final.mp4", status: "done" }) }); return;
        }
        if (path === "/api/studio/shots/s1/revisions" && method === "GET") {
            await route.fulfill({ json: { shot_id: "s1", revisions: revisionRows() } }); return;
        }
        if (path === "/api/studio/shots/s1/revisions/r5/diff" && method === "GET") {
            await route.fulfill({ json: { revision_id: "r5", version: 5, source: "rollback", from_version: 4, from_unknown: false,
                fields: { prompt: { from: "旧提示", to: "晨雾里的窗" }, dialogue: { from: "等待", to: "你在等谁？" } } } }); return;
        }
        if (path === "/api/studio/shots/s1/rollback" && method === "POST") {
            shotRows[0] = { ...shotRows[0], prompt: "旧提示", dialogue: "等待", current_revision_id: "r8",
                visual_media_status: "stale", audio_media_status: "stale", final_media_status: "stale" };
            await route.fulfill({ json: shotRows[0] }); return;
        }
        if (path === "/api/studio/shots/s1/voice" && method === "POST") {
            shotRows[0] = { ...shotRows[0], voice_url: "/api/media/s1-v2.wav", audio_media_status: "current" };
            await route.fulfill({ json: shotRows[0] }); return;
        }
        if (path === "/api/studio/shots/s1/lipsync" && method === "POST") {
            shotRows[0] = { ...shotRows[0], final_media_status: "current", lipsync_skipped: false };
            await route.fulfill({ json: shotRows[0] }); return;
        }
        if (path === "/api/studio/shots/s1/lipsync/skip" && method === "POST") {
            shotRows[0] = { ...shotRows[0], final_media_status: "current", lipsync_skipped: true };
            await route.fulfill({ json: shotRows[0] }); return;
        }
        if (path === "/api/studio/shots/s1/candidates/c1/pick" && method === "POST") {
            shotRows[0] = { ...shotRows[0], candidates: takeRows().map(take => ({ ...take, is_picked: take.id === "c1" })) };
            await route.fulfill({ json: shotRows[0] }); return;
        }
        await route.fulfill({ status: 503, json: { detail: "unmocked API" } });
    });
});
afterEach(async () => { await page?.close(); });
afterAll(async () => { await browser?.close(); server?.stop(true); });
const goto = () => page.goto(`http://127.0.0.1:${server.port}/studio/p1`);
const notice = (text: string | RegExp) => page.getByRole("status").filter({ hasText: text });
const firstShot = () => page.locator(".toiv-shot").nth(0);

test("revision drawer lists history, shows field diff, and appends a rollback that marks media stale", async () => {
    await goto();
    await firstShot().getByRole("button", { name: "修订历史" }).click();
    const drawer = page.getByRole("dialog", { name: "修订历史 · 镜01" });
    await drawer.getByText("v6").waitFor();
    expect(await drawer.getByText("当前").count()).toBe(1);
    expect(await drawer.getByText("手工编辑").count()).toBe(1);

    await drawer.getByRole("button", { name: "查看差异" }).nth(1).click();
    const diff = drawer.getByRole("region", { name: "v5 修订差异" });
    await diff.getByText("提示词").waitFor();
    expect(await diff.getByText("旧提示").count()).toBe(1);
    expect(await diff.getByText("晨雾里的窗").count()).toBe(1);
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/revisions/r5/diff").length).toBe(1);

    await drawer.getByRole("button", { name: "回滚到此版" }).nth(1).click();
    const confirm = drawer.getByRole("group", { name: "回滚到 v5 确认" });
    await confirm.getByRole("button", { name: "确认回滚到 v5" }).click();
    await notice(/已回滚到 v5/).waitFor();
    await drawer.waitFor({ state: "detached" });
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/rollback").map(c => c.body)).toEqual([
        { revision_id: "r5", expected_revision: "r6" },
    ]);
    await firstShot().getByText("视觉 · 已过期").waitFor();
    await firstShot().getByText("配音 · 已过期").waitFor();
    await firstShot().getByText("成片 · 已过期").waitFor();
    await firstShot().getByText("台词已变 · 配音过期").waitFor();
    await firstShot().getByText("视觉输入已变更，当前画面/视频已过期；重渲染后恢复同步。").waitFor();
    expect(errors).toEqual([]);
});

test("shortlist compares 2–4 takes with synchronized playback and picks the chosen take", async () => {
    await goto();
    const compare = firstShot().getByRole("button", { name: /对比已选/ });
    expect(await compare.isDisabled()).toBe(true);
    expect(await firstShot().getByRole("button", { name: "加入对比 T3" }).isDisabled()).toBe(true);
    await firstShot().getByRole("button", { name: "加入对比 T1" }).click();
    await firstShot().getByRole("button", { name: "加入对比 T2" }).click();
    expect(await compare.textContent()).toContain("对比已选 (2)");
    await firstShot().getByRole("button", { name: "移出对比 T2" }).click();
    expect(await compare.isDisabled()).toBe(true);
    await firstShot().getByRole("button", { name: "加入对比 T2" }).click();
    await compare.click();

    const dialog = page.getByRole("dialog", { name: "候选对比 · 镜01" });
    await dialog.getByRole("region", { name: "T1 对比" }).waitFor();
    await dialog.getByRole("region", { name: "T2 对比" }).waitFor();
    expect(await dialog.getByRole("region", { name: "T3 对比" }).count()).toBe(0);

    await dialog.getByRole("button", { name: "从头同步播放" }).click();
    await page.waitForFunction(() => (window as any).__media.plays >= 2);
    await dialog.getByRole("button", { name: "暂停全部" }).click();
    expect(await page.evaluate(() => (window as any).__media.pauses)).toBeGreaterThanOrEqual(2);

    await dialog.getByRole("region", { name: "T1 对比" }).getByRole("button", { name: "采用 T1" }).click();
    await notice(/已采用 镜01 T1/).waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/candidates/c1/pick").map(c => c.body)).toEqual([
        { expected_candidates_digest: "digest-1" },
    ]);
    await dialog.getByRole("region", { name: "T1 对比" }).getByText("当前采用").waitFor();
    expect(errors).toEqual([]);
});

test("voice, lipsync and skip-lipsync update per-shot media status; image_motion shots stay out of lipsync", async () => {
    await goto();
    const shot = firstShot();
    await shot.getByText("配音 · 已过期").waitFor();
    await shot.getByRole("button", { name: "重新配音" }).click();
    await notice("镜01 配音完成").waitFor();
    await shot.getByText("配音 · 已同步").waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/voice").map(c => c.method)).toEqual(["POST"]);

    await shot.getByRole("button", { name: "重新对口型" }).click();
    await notice("镜01 对口型完成").waitFor();
    await shot.getByText("成片 · 已同步").waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/lipsync").length).toBe(1);

    await shot.getByRole("button", { name: "跳过口型…" }).click();
    const skip = page.getByRole("dialog", { name: "跳过对口型 · 镜01" });
    await skip.getByText("保留当前最终片段并标注「未对口型」").waitFor();
    await skip.getByRole("button", { name: "确认跳过" }).click();
    await notice(/镜01 已跳过对口型/).waitFor();
    await shot.getByText("未对口型", { exact: true }).waitFor();
    expect(calls.filter(c => c.path === "/api/studio/shots/s1/lipsync/skip").length).toBe(1);

    const second = page.locator(".toiv-shot").nth(1);
    await second.getByText("图像运镜镜无需对口型").waitFor();
    expect(await second.getByRole("button", { name: "对口型" }).count()).toBe(0);
    expect(await second.getByRole("button", { name: "配音" }).isDisabled()).toBe(true);
    expect(await second.getByRole("button", { name: /跳过口型/ }).count()).toBe(0);
    expect(errors).toEqual([]);
});

test("assemble lists its gates, routes to the voice stage, then succeeds once clips are current", async () => {
    await goto();
    await page.getByRole("button", { name: "合成成片" }).click();
    const dialog = page.getByRole("dialog", { name: "合成成片" });
    await dialog.getByText("尚未确认或跳过 · 待确认").waitFor();
    await dialog.getByText(/1 镜缺失 · 镜02/).waitFor();
    await dialog.getByText(/1 镜过期 · 镜01/).waitFor();
    const submit = dialog.getByRole("button", { name: "开始合成" });
    expect(await submit.isDisabled()).toBe(true);
    expect(calls.filter(c => c.path === "/api/studio/projects/p1/assemble").length).toBe(0);

    await dialog.getByRole("button", { name: "去确认配音阶段" }).click();
    await dialog.waitFor({ state: "detached" });
    await page.getByRole("button", { name: "确认阶段" }).click();
    await notice("阶段已确认").waitFor();
    expect(calls.filter(c => c.path.endsWith("/stage-transition")).map(c => c.body)).toEqual([
        { stage: "voice", action: "confirm", expected_stage_revision: 7 },
    ]);
    await page.getByRole("button", { name: "配音阶段 · 已确认" }).waitFor();

    ready = true;
    await page.getByRole("button", { name: "刷新分镜" }).click();
    await notice("已刷新分镜").waitFor();
    await page.getByRole("button", { name: "合成成片" }).click();
    const readyDialog = page.getByRole("dialog", { name: "合成成片" });
    await readyDialog.getByText("全部到位").waitFor();
    await readyDialog.getByText("无过期片段").waitFor();
    await readyDialog.getByRole("button", { name: "开始合成" }).click();
    await notice("成片已合成，可在顶部查看").waitFor();
    await readyDialog.waitFor({ state: "detached" });
    const link = page.getByRole("group", { name: "项目成片" }).getByRole("link", { name: "查看成片" });
    expect(await link.getAttribute("href")).toContain("/api/media/final.mp4");
    expect(calls.filter(c => c.path === "/api/studio/projects/p1/assemble").length).toBe(1);
    expect(errors).toEqual([]);
});

for (const width of [390, 320]) {
    test(`revision drawer and compare dialog stay usable at ${width}px without horizontal overflow`, async () => {
        await page.setViewportSize({ width, height: 844 });
        await goto();
        await firstShot().getByRole("button", { name: "修订历史" }).click();
        const drawer = page.getByRole("dialog", { name: "修订历史 · 镜01" });
        await drawer.getByText("v6").waitFor();
        await drawer.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const drawerBox = await drawer.evaluate(element => {
            const box = element.getBoundingClientRect();
            return { left: box.left, right: box.right, viewport: window.innerWidth, scroll: document.documentElement.scrollWidth };
        });
        expect(drawerBox.left).toBeGreaterThanOrEqual(0);
        expect(drawerBox.right).toBeLessThanOrEqual(drawerBox.viewport);
        expect(drawerBox.scroll).toBeLessThanOrEqual(drawerBox.viewport);
        await drawer.getByRole("button", { name: "回滚到此版" }).nth(1).click();
        await drawer.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await drawer.getByRole("button", { name: "取消" }).click();
        await drawer.locator(".pf-modal-close").click();
        await drawer.waitFor({ state: "detached" });

        await firstShot().getByRole("button", { name: "加入对比 T1" }).click();
        await firstShot().getByRole("button", { name: "加入对比 T2" }).click();
        await firstShot().getByRole("button", { name: /对比已选 \(2\)/ }).click();
        const compare = page.getByRole("dialog", { name: "候选对比 · 镜01" });
        await compare.getByRole("region", { name: "T1 对比" }).waitFor();
        await compare.evaluate(element => Promise.all(element.getAnimations({ subtree: true }).map(animation => animation.finished)));
        const compareBox = await compare.evaluate(element => {
            const box = element.getBoundingClientRect();
            const video = element.querySelector("video")!.getBoundingClientRect();
            return { left: box.left, right: box.right, viewport: window.innerWidth, video: video.width, tiles: element.querySelectorAll(".toiv-compare-tile").length };
        });
        expect(compareBox.left).toBeGreaterThanOrEqual(0);
        expect(compareBox.right).toBeLessThanOrEqual(compareBox.viewport);
        expect(compareBox.tiles).toBe(2);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        expect(errors).toEqual([]);
    });
}
