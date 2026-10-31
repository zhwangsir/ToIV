import { afterAll, afterEach, beforeAll, beforeEach, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { mkdtempSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

let browser: Browser;
let page: Page;
let server: ReturnType<typeof Bun.serve>;
let bundleDir: string;
const errors: string[] = [];

const scenes = {
    scenes: [
        { id: "s1", name: "雨夜街口", environment_prompt: "雨夜，霓虹反光", frozen_anchor: { id: "a1" }, variants: [] },
        { id: "s2", name: "天台", environment_prompt: "黄昏，逆光", variants: [] },
    ],
};

const proposalGraph = {
    "1": { class_type: "CheckpointLoaderSimple", inputs: { ckpt_name: "sd_xl.safetensors" } },
    "2": { class_type: "CLIPTextEncode", inputs: { text: "rainy neon street", clip: ["1", 1] } },
    "3": { class_type: "KSampler", inputs: { model: ["1", 0], positive: ["2", 0], steps: 28 } },
};

const chatStream = [
    'event: msg\ndata: {"type":"thinking","status":"start","round":1}',
    'event: tool\ndata: {"id":"t1","name":"submit_generation","status":"start","summary":"提交生成"}',
    'event: msg\ndata: {"type":"thinking","status":"done","round":1,"duration_ms":1200}',
    'event: proposal\ndata: {"proposal_id":"p1","title":"雨夜出图流程","body":"先载入模型，再编码提示词。","estimate":"约 40 秒","kind":"canvas_graph","node_count":3,"warnings":[]}',
    'event: tool\ndata: {"id":"t1","name":"submit_generation","status":"ok","summary":"提交生成","detail":"job_id=abc"}',
    'event: msg\ndata: {"type":"text","content":"已为你准备画布提案。"}',
    "event: done\ndata: {}",
].map((frame) => `${frame}\n\n`).join("");

async function sources() {
    await page.route("**/api/drama/projects/p1/scenes", (route) => route.fulfill({ json: scenes }));
    await page.route("**/api/jobs?limit=50", (route) => route.fulfill({ json: [] }));
}

async function mockChat(status = 200) {
    await page.route("**/api/agent/chat", (route) =>
        status === 200
            ? route.fulfill({
                status: 200,
                headers: { "Content-Type": "text/event-stream", "X-Agent-Session-Id": "s1" },
                body: chatStream,
            })
            : route.fulfill({ status: 500, json: { detail: "boom" } }),
    );
}

async function mockProposal() {
    await page.route("**/api/agent/sessions/s1/canvas-proposal", (route) =>
        route.fulfill({
            json: {
                proposal_id: "p1",
                title: "雨夜出图流程",
                body: "先载入模型，再编码提示词。",
                warnings: [],
                status: "pending",
                graph: proposalGraph,
            },
        }),
    );
}

async function visit() {
    await page.goto(`http://127.0.0.1:${server.port}/`);
    await page.locator(".toiv-workspace").waitFor();
    await page.locator(".react-flow__node").first().waitFor();
}

async function openAgent() {
    await page.getByRole("tab", { name: "Agent", exact: true }).click();
    await page.getByLabel("消息", { exact: true }).waitFor();
}

beforeAll(async () => {
    const plugins: BunPlugin[] = [{
        name: "prime-harness-alias",
        setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync("../src/" + args.path.slice(2), import.meta.dir) }));
            builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
        },
    }];
    const build = await Bun.build({
        entrypoints: [import.meta.dir + "/fixtures/prime-canvas-harness.tsx"],
        plugins,
        target: "browser",
        define: { "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }) },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    bundleDir = mkdtempSync(join(tmpdir(), "prime-agent-"));
    const bundlePath = join(bundleDir, "harness.js");
    await Bun.write(bundlePath, await build.outputs[0].text());
    const css = [
        await Bun.file(`${import.meta.dir}/../node_modules/@xyflow/react/dist/style.css`).text(),
        ...(await Promise.all(["index.css", "styles/printfilm.css", "App.css", "styles/toiv-skin.css"].map((file) => Bun.file(`${import.meta.dir}/../src/${file}`).text()))),
    ].join("\n");
    server = Bun.serve({
        port: 0,
        fetch(request) {
            const path = new URL(request.url).pathname;
            if (path === "/harness.js") return new Response(Bun.file(bundlePath), { headers: { "Content-Type": "text/javascript" } });
            if (path === "/harness.css") return new Response(css, { headers: { "Content-Type": "text/css" } });
            if (path.startsWith("/api") || path.startsWith("/studio/api")) return Response.json({ detail: "unavailable" }, { status: 503 });
            return new Response('<!doctype html><html lang="zh-CN"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/harness.css"></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>', { headers: { "Content-Type": "text/html" } });
        },
    });
    browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined, headless: true });
}, 60_000);

beforeEach(async () => {
    errors.length = 0;
    page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(3000);
    page.on("pageerror", (error) => errors.push(error.message));
    await page.addInitScript(() => localStorage.setItem("toiv_token", "fixture-only"));
});

afterEach(async () => {
    await page?.close();
    expect(errors).toEqual([]);
});

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
    if (bundleDir) await rm(bundleDir, { recursive: true, force: true });
});

test("the agent panel streams answers, tool states and a canvas proposal", async () => {
    await sources();
    await mockChat();
    await mockProposal();
    await visit();
    await openAgent();

    expect(await page.getByText("选择场景查看详情").isVisible()).toBe(false);
    await page.getByLabel("消息", { exact: true }).fill("编排一个雨夜出图流程");
    await page.getByRole("button", { name: "发送", exact: true }).click();

    const log = page.getByRole("log", { name: "对话记录", exact: true });
    await log.getByText("编排一个雨夜出图流程").waitFor();
    await log.getByText("已为你准备画布提案。").waitFor();
    expect(await log.getByText("提交生成").isVisible()).toBe(true);
    expect(await log.getByText("完成").isVisible()).toBe(true);
    expect(await log.getByText("雨夜出图流程", { exact: true }).isVisible()).toBe(true);
    expect(await log.getByText("3 个节点", { exact: false }).isVisible()).toBe(true);
    expect(await page.getByLabel("消息", { exact: true }).inputValue()).toBe("");
});

test("loading a canvas proposal renders comfy nodes and keeps the scene layer", async () => {
    await sources();
    await mockChat();
    await mockProposal();
    await visit();
    await openAgent();
    await page.getByLabel("消息", { exact: true }).fill("编排一个雨夜出图流程");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("button", { name: "载入画布", exact: true }).click();

    await page.locator(".toiv-comfy-node").first().waitFor();
    expect(await page.locator(".toiv-comfy-node").count()).toBe(3);
    const canvas = page.locator(".toiv-canvas-flow");
    expect(await canvas.textContent()).toContain("CheckpointLoaderSimple");
    expect(await canvas.textContent()).toContain("KSampler");
    expect(await canvas.textContent()).toContain("rainy neon street");
    await page.waitForFunction(() => document.querySelectorAll(".react-flow__edge").length === 3);
    expect(await page.locator(".react-flow__edge").count()).toBe(3);
    const canvasBox = (await canvas.boundingBox())!;
    for (const node of await page.locator(".toiv-comfy-node").all()) {
        const box = (await node.boundingBox())!;
        expect(box.x >= canvasBox.x && box.x + box.width <= canvasBox.x + canvasBox.width).toBe(true);
        expect(box.y >= canvasBox.y && box.y + box.height <= canvasBox.y + canvasBox.height).toBe(true);
    }
    expect(await page.getByRole("button", { name: "Agent 提案", exact: true }).getAttribute("aria-pressed")).toBe("true");

    await page.locator(".toiv-comfy-node", { hasText: "KSampler" }).click();
    const inspector = page.locator(".toiv-workspace-panel.right");
    expect(await page.getByRole("tab", { name: "检查器", exact: true }).getAttribute("aria-selected")).toBe("true");
    expect(await inspector.textContent()).toContain("KSampler");
    expect(await inspector.textContent()).toContain("#3");

    await page.getByRole("button", { name: "场景", exact: true }).click();
    expect(await page.locator(".toiv-comfy-node").count()).toBe(0);
    expect(await canvas.textContent()).toContain("雨夜街口");

    await page.getByRole("button", { name: "Agent 提案", exact: true }).click();
    expect(await page.locator(".toiv-comfy-node").count()).toBe(3);
    await page.getByRole("button", { name: "关闭提案", exact: true }).click();
    expect(await page.locator(".toiv-comfy-node").count()).toBe(0);
    expect(await page.getByRole("button", { name: "Agent 提案", exact: true }).count()).toBe(0);
});

test("a failed chat reports the error and lets the user retry", async () => {
    await sources();
    await mockChat(500);
    await visit();
    await openAgent();

    await page.getByLabel("消息", { exact: true }).fill("你好");
    await page.getByRole("button", { name: "发送", exact: true }).click();
    await page.getByRole("alert").filter({ hasText: "Agent 连接失败（500）" }).waitFor();
    await page.getByLabel("消息", { exact: true }).fill("重试一次");
    const send = page.getByRole("button", { name: "发送", exact: true });
    expect(await send.isEnabled()).toBe(true);
});
