import { afterAll, beforeAll, expect, test } from "bun:test";
import type { BunPlugin } from "bun";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

const webRoot = resolve(import.meta.dir, "..");
const shots = resolve(webRoot, "test-results/production-b1c");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

async function waitForText(locator: Locator, needle: string, timeoutMs = 5000) {
    const start = Date.now();
    for (;;) {
        const text = (await locator.textContent().catch(() => null)) ?? "";
        if (text.includes(needle)) return text;
        if (Date.now() - start > timeoutMs) throw new Error(`等待文本超时：期望包含「${needle}」，实际「${text}」`);
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
}

beforeAll(async () => {
    mkdirSync(shots, { recursive: true });
    // 与 project-asset-reconciliation.browser.test.ts 同一 CSS 管道：
    // antd reset + Freezone tokens + tailwind(globals) + local overrides + workspace product
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
        entrypoints: [resolve(import.meta.dir, "fixtures/market-params-harness.tsx")],
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
        if (url.pathname === "/harness.js") {
            return new Response(js, { headers: { "Content-Type": "application/javascript" } });
        }
        if (url.pathname === "/api/upload") {
            // 未声明 max_bytes 时前端应放行到上传层；非 JSON 500 → 前端报「上传失败 (500)」，
            // 用于证明「不是字节闸拦截」
            return new Response("stub upload unavailable", { status: 500 });
        }
        return new Response(`<!doctype html><html class="dark"><head><meta charset="utf-8"><style>*{box-sizing:border-box}body{margin:0;background:var(--background);color:var(--foreground)}${styles}</style></head><body><script>if (!("Bun" in globalThis)) globalThis.Bun = {};</script><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } });
    } });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

test("B1c：文本 max_chars 计数反馈 + 未声明无计数（真实 CSS）", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());

    const declared = page.getByTestId("text-declared");
    await declared.locator("textarea").fill("一二三四五六七八九十");
    expect(await waitForText(declared.locator("[data-testid='mkt-char-count-prompt']"), "10/10")).toBe("10/10");
    const normalColor = await declared
        .locator("[data-testid='mkt-char-count-prompt']")
        .evaluate((el) => getComputedStyle(el).color);
    await declared.locator("textarea").fill("一二三四五六七八九十1");
    await waitForText(declared.locator("[data-testid='mkt-char-count-prompt']"), "11/10");
    const overColor = await declared
        .locator("[data-testid='mkt-char-count-prompt']")
        .evaluate((el) => getComputedStyle(el).color);
    // 真实 CSS：超限计数器与正常计数器计算颜色不同（destructive token 生效）
    expect(overColor).not.toBe(normalColor);

    const fallback = page.getByTestId("text-fallback");
    await fallback.locator("textarea").fill("任意长度文本没有计数器");
    expect(await fallback.locator("[data-testid]").count()).toBe(0); // 内部无计数器 testid

    await page.screenshot({ path: `${shots}/01-text-max-chars.png`, fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
    await page.close();
}, 30_000);

test("B1c：媒体 max_bytes 声明拦截大文件，未声明回退旧上限放行（真实 CSS）", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1200 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());

    // 2MB mp4：声明 1MB → 前端字节闸拒绝，且不触发上传
    const buffer = Buffer.alloc(2 * 1024 * 1024, 1);
    const declared = page.getByTestId("media-declared");
    await declared.locator("input[type=file]").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer });
    await waitForText(declared.locator("p.text-\\[var\\(--destructive\\)\\]"), "超过 1MB 上限");

    // 同一文件：未声明 → 兼容回退 200MB，放行到上传层（stub 500 证明走到了上传）
    const fallback = page.getByTestId("media-fallback");
    await fallback.locator("input[type=file]").setInputFiles({ name: "clip.mp4", mimeType: "video/mp4", buffer });
    await waitForText(fallback.locator("p.text-\\[var\\(--destructive\\)\\]"), "上传失败");

    await page.screenshot({ path: `${shots}/02-media-max-bytes.png`, fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
    await page.close();
}, 30_000);

test("B1c：LoRA max_items 改变可选数量，min/max 仍管强度（真实 CSS）", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());

    // 声明 max_items=5：5 个全可选
    const declared = page.getByTestId("loras-declared");
    for (const label of ["LoRA A", "LoRA B", "LoRA C", "LoRA D", "LoRA E"]) {
        await declared.locator(`label:has-text("${label}") input[type=checkbox]`).check();
    }
    const declaredValue = await page.getByTestId("loras-declared-value").textContent();
    expect(JSON.parse(declaredValue ?? "[]")).toHaveLength(5);

    // 未声明：回退 cap=3，第 4 个被禁
    const fallback = page.getByTestId("loras-fallback");
    for (const label of ["LoRA A", "LoRA B", "LoRA C"]) {
        await fallback.locator(`label:has-text("${label}") input[type=checkbox]`).check();
    }
    const dBox = fallback.locator('label:has-text("LoRA D") input[type=checkbox]');
    expect(await dBox.isDisabled()).toBe(true);

    // max_items=2 + min/max 声明：第 3 个被禁，强度 slider 用声明的 0.2~0.9
    const strength = page.getByTestId("loras-strength");
    await strength.locator('label:has-text("LoRA A") input[type=checkbox]').check();
    const slider = strength.locator('input[type=range]');
    expect(await slider.getAttribute("min")).toBe("0.2");
    expect(await slider.getAttribute("max")).toBe("0.9");
    await strength.locator('label:has-text("LoRA B") input[type=checkbox]').check();
    const cBox = strength.locator('label:has-text("LoRA C") input[type=checkbox]');
    expect(await cBox.isDisabled()).toBe(true);

    await page.screenshot({ path: `${shots}/03-loras-max-items.png`, fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
    await page.close();
}, 30_000);

test("B1c：提交校验——max_chars 超限阻断，正常边界 + max_items=5 全量提交", async () => {
    const page = await browser.newPage({ viewport: { width: 900, height: 1400 } });
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(server.url.toString());

    const run = page.getByTestId("submit-run");
    const result = page.getByTestId("submit-result");
    const error = page.getByTestId("submit-error");

    // 缺必填：阻断
    expect(await run.isDisabled()).toBe(true);
    expect(await error.textContent()).toContain("还差必填项");

    // 超限 1 字：阻断 + 明确报错
    await page.getByTestId("submit-harness").locator("textarea").fill("一二三四五六七八九十1");
    await waitForText(error, "超出字数上限 10");
    expect(await run.isDisabled()).toBe(true);
    expect((await result.textContent()) ?? "").toBe("");

    // 恰好 10 字（边界）：放行；选满 5 个 LoRA（max_items=5）提交，第 4/5 项不丢
    await page.getByTestId("submit-harness").locator("textarea").fill("一二三四五六七八九十");
    for (const label of ["LoRA A", "LoRA B", "LoRA C", "LoRA D", "LoRA E"]) {
        await page.getByTestId("submit-harness").locator(`label:has-text("${label}") input[type=checkbox]`).check();
    }
    await page.waitForFunction(() => !(document.querySelector("[data-testid='submit-run']") as HTMLButtonElement)?.disabled);
    await run.click();
    const payload = JSON.parse((await waitForText(result, "lora-e")) ?? "{}");
    expect(payload.prompt).toBe("一二三四五六七八九十");
    expect(payload.loras).toHaveLength(5);
    expect(payload.loras.map((l: { name: string }) => l.name)).toContain("lora-e.safetensors");

    await page.screenshot({ path: `${shots}/04-submit-validation.png`, fullPage: true, animations: "disabled" });
    expect(errors).toEqual([]);
    await page.close();
}, 30_000);
