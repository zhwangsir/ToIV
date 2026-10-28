import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/toiv/toiv-empty-loading.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/create/creation-studio-media-pool.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/media-pool-feedback-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
        : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0;background:var(--toiv-bg)}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness(query = "") {
    const page = await browser.newPage({ viewport: { width: 480, height: 800 } });
    await page.goto(`${server.url}${query}`);
    await page.getByTestId("creation-studio-media-pool").waitFor();
    return page;
}

test("unmatched filters offer recovery without being mistaken for hidden adult assets", async () => {
    const page = await openHarness();
    await page.getByRole("textbox", { name: "搜索媒体池" }).fill("不存在的镜头");
    expect(await page.getByText("无匹配结果").count()).toBe(1);
    expect(await page.getByText("当前为普通").count()).toBe(0);
    await page.screenshot({ path: "test-results/freezone-r9/media-no-results.png", fullPage: true, animations: "disabled" });
    await page.getByRole("button", { name: "清空筛选" }).click();
    expect(await page.getByRole("textbox", { name: "搜索媒体池" }).inputValue()).toBe("");
    expect(await page.getByRole("button", { name: "全部", exact: true }).getAttribute("aria-pressed")).toBe("true");
    expect(await page.locator('[data-asset-id="normal"]').count()).toBe(1);
    await page.close();
});

test("empty library and content-mode hidden states explain their distinct next steps", async () => {
    const empty = await openHarness("?empty=1&light=1");
    expect(await empty.getByRole("link", { name: "上传素材" }).getAttribute("href")).toBe("/assets");
    await empty.screenshot({ path: "test-results/freezone-r9/media-empty-light.png", fullPage: true, animations: "disabled" });
    await empty.close();
    const hidden = await openHarness("?hidden=1");
    expect(await hidden.getByText("当前为普通").count()).toBe(1);
    expect(await hidden.getByRole("button", { name: "清空筛选" }).count()).toBe(0);
    expect(await hidden.locator(".toiv-empty-desc").textContent()).toContain("顶栏");
    await hidden.close();
});

test("loading remains local and reduced motion disables shimmer", async () => {
    const page = await openHarness("?loading=1");
    await page.emulateMedia({ reducedMotion: "reduce" });
    expect(await page.getByTestId("toiv-skeleton-grid").getAttribute("role")).toBe("status");
    expect(await page.locator(".toiv-skeleton").first().evaluate((element) => getComputedStyle(element, "::after").animationName)).toBe("none");
    await page.close();
});
