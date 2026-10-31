import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// 与 toiv-market-b1c-fields.browser.test.ts 同一 CSS 管道与打包链：
// antd reset + Freezone tokens + tailwind(globals) + local overrides + workspace product。
const webRoot = resolve(import.meta.dir, "..");
const shots = resolve(webRoot, "test-results/production-b1c");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

// 协议目录 stub：已安装 newapi-channel-2 / chat-completion / openai-image；
// fixture 里的 future-protocol-9 故意不在目录中，用于诚实「待配置请求协议」断言。
const pluginCatalog = {
    code: 0,
    data: {
        providers: [
            { id: "newapi-channel-2", version: "1", name: "NewAPI Channel II", vendor: "APIMart", categories: ["video"], scopes: ["user.custom-channel"], create: "POST /v1/videos/generations", contentType: "multipart/form-data", enabled: true },
            { id: "chat-completion", version: "1", name: "OpenAI Chat Completions", vendor: "OpenAI", categories: ["text"], scopes: ["user.custom-channel"], create: "POST /v1/chat/completions", contentType: "application/json", enabled: true },
            { id: "openai-image", version: "1", name: "OpenAI Images", vendor: "OpenAI", categories: ["image"], scopes: ["user.custom-channel"], create: "POST /v1/images/generations", contentType: "application/json", enabled: true },
        ],
    },
    msg: "",
};

async function waitValue<T>(read: () => Promise<T>, predicate: (value: T) => boolean, label: string, timeoutMs = 8000): Promise<T> {
    const start = Date.now();
    for (;;) {
        const value = await read().catch(() => null as T);
        if (value !== null && predicate(value)) return value;
        if (Date.now() - start > timeoutMs) throw new Error(`等待超时：${label}`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

async function waitText(locator: Locator, needle: string) {
    return waitValue(async () => (await locator.textContent().catch(() => null)) ?? "", (text) => text.includes(needle), `期望包含「${needle}」`);
}

beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    const cssSources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-local-overrides.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    styles = [cssSources[0], cssSources[1], tailwindCss.css, cssSources[3], cssSources[4]].join("\n");

    const plugins: BunPlugin[] = [
        {
            name: "workspace-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
                builder.onLoad({ filter: /\.(css|svg|png|jpe?g|gif|webp|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
            },
        },
    ];
    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/channel-model-settings-harness.tsx")],
        plugins,
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({
                DEV: false,
                PROD: true,
                MODE: "production",
                BASE_URL: "/",
                VITE_CANVAS_LOCAL_MODE: "false",
                VITE_CANVAS_BACKEND_URL: "",
                VITE_APP_VERSION: "test",
                VITE_BUILD_COMMIT: "test",
                VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT: "",
            }),
        },
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => {
        const url = new URL(request.url);
        if (url.pathname === "/harness.js") return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        if (url.pathname === "/api/plugins/catalog") return Response.json(pluginCatalog);
        return new Response(`<!doctype html><html class="dark"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground)}${styles}</style></head><body><script>if (!("Bun" in globalThis)) globalThis.Bun = {};</script><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openModel(page: Page, scope: Locator, modelName: string) {
    const row = scope.locator(".space-y-2 > div").filter({ hasText: modelName }).first();
    await row.getByRole("button", { name: "配置使用" }).click();
    const modal = page.locator(".model-editor-modal").last();
    await modal.getByRole("tab", { name: "能力与参数" }).click();
    return modal;
}

// 可读性硬断言：modal 标题文字与其背景对比度 ≥ 4.5（WCAG AA），且容器不是白底。
// harness 必须挂与生产 AppProviders 一致的暗色 ConfigProvider，否则截图是白底浅字的无效证据。
async function expectReadableModal(page: Page) {
    const contrast = await page.evaluate(() => {
        const modal = document.querySelector(".ant-modal") as HTMLElement | null;
        const title = modal?.querySelector(".ant-modal-title") as HTMLElement | null;
        if (!modal || !title) return null;
        const parse = (value: string) => {
            const match = value.match(/(\d+)[,\s]+(\d+)[,\s]+(\d+)/);
            return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
        };
        const luminance = (rgb: number[]) => {
            const channel = (raw: number) => {
                const v = raw / 255;
                return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * channel(rgb[0]!) + 0.7152 * channel(rgb[1]!) + 0.0722 * channel(rgb[2]!);
        };
        const foreground = parse(getComputedStyle(title).color);
        const background = parse(getComputedStyle(modal).backgroundColor);
        if (!foreground || !background) return null;
        const lighter = Math.max(luminance(foreground), luminance(background));
        const darker = Math.min(luminance(foreground), luminance(background));
        return { ratio: (lighter + 0.05) / (darker + 0.05), background: background.join(",") };
    });
    expect(contrast).not.toBeNull();
    expect(contrast!.ratio).toBeGreaterThanOrEqual(4.5);
    expect(contrast!.background.split(",").every((value) => Number(value) < 250)).toBe(true);
}

test("系统模型设置页：服务端能力值可见、协议与能力编辑只读、onChange 不触发（真实 CSS）", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as unknown as { __changes?: unknown }).__changes !== undefined);

    const system = page.getByTestId("system-settings");
    // 模型行：显示名可见；未安装协议诚实标注「待配置请求协议」，不假装可用。
    await waitText(system, "系统视频模型");
    await waitText(system, "未来协议模型");
    await waitText(system, "待配置请求协议");

    const modal = await openModel(page, system, "系统视频模型");
    const pane = modal.locator(".ant-tabs-content").last();
    await expectReadableModal(page);

    // 服务端值可见，且与 TS 默认明显不同（默认 promptMaxChars=8000 / duration range / resolutions 480p-2160p）。
    const promptInput = pane.locator("label:has-text('提示词最大字符数') .ant-input-number-input");
    await waitValue(() => promptInput.inputValue(), (value) => value === "1234", "提示词上限=1234");
    const durationInput = pane.locator("label:has-text('固定时长（秒）') input");
    await waitValue(() => durationInput.inputValue(), (value) => value === "3,7", "固定时长=3,7");
    await waitText(pane, "540P");
    await waitText(pane, "21:9");
    await waitText(pane, "系统渠道能力由平台模型目录下发，此处为只读证据展示");

    // 能力 Segmented（antd）与协议目录 ChoiceBrowser 均真实禁用，不是可点 no-op。
    await waitValue(() => modal.locator(".ant-segmented-disabled").count(), (count) => count === 1, "能力 Segmented 禁用");
    const protocolRadios = modal.locator("input[type='radio']");
    expect(await protocolRadios.first().isDisabled()).toBe(true);
    const searchInput = modal.locator("input[aria-label='搜索调用协议']");
    expect(await searchInput.isDisabled()).toBe(true);
    // 时长 SegmentedControl 与能力数字输入禁用。
    const durationBlock = pane.locator(".admin-capability-block", { hasText: "输出时长" });
    expect(await durationBlock.locator("button[role='radio']").first().isDisabled()).toBe(true);
    expect(await promptInput.isEditable()).toBe(false);

    // 交互尝试后 onChange 不触发、界面状态不变。
    await modal.getByText("图片", { exact: true }).click({ force: true }).catch(() => undefined);
    await promptInput.click({ force: true }).catch(() => undefined);
    await page.waitForTimeout(300);
    const changes = await page.evaluate(() => (window as unknown as { __changes: { system: number; custom: number } }).__changes);
    expect(changes.system).toBe(0);
    await waitText(modal.locator(".ant-segmented-item-selected"), "视频");

    await page.screenshot({ path: `${shots}/05-system-channel-readonly.png`, fullPage: true, animations: "disabled" });
    await modal.locator(".ant-modal-close").click();

    expect(errors).toEqual([]);
    await page.close();
}, 30_000);

test("自定义渠道：可正常编辑能力参数（显式 override 路径不被 scope 误锁）", async () => {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1400 } });
    page.setDefaultTimeout(15_000);
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());
    await page.waitForFunction(() => (window as unknown as { __changes?: unknown }).__changes !== undefined);

    const custom = page.getByTestId("custom-settings");
    await waitText(custom, "自定义视频模型");

    const modal = await openModel(page, custom, "自定义视频模型");
    const pane = modal.locator(".ant-tabs-content").last();
    await expectReadableModal(page);
    await waitText(pane, "目录下发的默认值仅供参考");
    const promptInput = pane.locator("label:has-text('提示词最大字符数') .ant-input-number-input");
    await waitValue(() => promptInput.inputValue(), (value) => value === "9999", "自定义提示词上限=9999");
    expect(await promptInput.isEditable()).toBe(true);
    expect(await modal.locator(".ant-segmented-disabled").count()).toBe(0);
    expect(await modal.locator("input[type='radio']").first().isDisabled()).toBe(false);

    // 真实编辑：改提示词上限 → onChange 触发且值回写（服务端 fixture 值 9999 → 2222）。
    await promptInput.fill("2222");
    await waitValue(() => promptInput.inputValue(), (value) => value === "2222", "编辑后提示词上限=2222");
    const changes = await page.evaluate(() => (window as unknown as { __changes: { system: number; custom: number } }).__changes);
    expect(changes.custom).toBeGreaterThanOrEqual(1);

    await page.screenshot({ path: `${shots}/06-custom-channel-editable.png`, fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
    await page.close();
}, 30_000);
