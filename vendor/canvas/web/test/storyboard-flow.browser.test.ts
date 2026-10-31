import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/create/creation-studio-three-pane.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/toiv/toiv-empty-loading.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/storyboard-flow-harness.tsx`],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({ port: 0, fetch: (request) => new URL(request.url).pathname === "/harness.js"
        ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
        : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }) });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness({ light = false, width = 768, empty = false } = {}) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(`${server.url}${light || empty ? `?${new URLSearchParams({ ...(light ? { light: "1" } : {}), ...(empty ? { empty: "1" } : {}) })}` : ""}`);
    await page.getByTestId("creation-studio-storyboard-flow").waitFor();
    await page.locator("main").evaluate((main, width) => { main.style.width = `${width}px`; }, width);
    return page;
}

test("storyboard uses readable metadata and adaptive columns in both themes", async () => {
    const dark = await openHarness();
    expect(await dark.locator(".toiv-storyboard-card").count()).toBe(3);
    expect(await dark.locator(".toiv-storyboard-flow-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(3);
    expect(await dark.getByText("中景 · 缓慢推镜").count()).toBe(1);
    expect(await dark.getByText("林遥").count()).toBe(1);
    expect(await dark.getByText("SHOT 01").count()).toBe(1);
    expect(await dark.locator(".toiv-storyboard-card").first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(20, 21, 26)");
    await dark.screenshot({ path: "test-results/freezone-r4/storyboard-dark.png", fullPage: true });
    await dark.close();

    const light = await openHarness({ light: true });
    expect(await light.locator(".toiv-storyboard-card").first().evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(await light.locator(".toiv-storyboard-card").first().evaluate((element) => getComputedStyle(element).color)).toBe("rgb(18, 18, 20)");
    await light.screenshot({ path: "test-results/freezone-r4/storyboard-light.png", fullPage: true });
    await light.close();
});

test("storyboard selection is mouse and keyboard accessible and narrow grids stay readable", async () => {
    const page = await openHarness({ width: 568 });
    expect(await page.locator(".toiv-storyboard-flow-grid").evaluate((element) => getComputedStyle(element).gridTemplateColumns.split(" ").length)).toBe(2);
    const second = page.getByTestId("storyboard-card-s2");
    await second.click();
    expect(await second.getAttribute("aria-selected")).toBe("true");
    expect(await second.evaluate((element) => element.classList.contains("is-selected"))).toBe(true);
    const third = page.getByTestId("storyboard-card-s3");
    await third.focus();
    await page.keyboard.press("Enter");
    expect(await third.getAttribute("aria-selected")).toBe("true");
    await page.screenshot({ path: "test-results/freezone-r4/storyboard-selected-568.png", fullPage: true });
    await page.close();
});

test("empty storyboard provides a keyboard-accessible route back to script parsing", async () => {
    const page = await openHarness({ empty: true });
    const action = page.getByRole("button", { name: "返回剧本解析" });
    await action.focus();
    expect(await action.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    await page.screenshot({ path: "test-results/freezone-r9/storyboard-empty.png", fullPage: true, animations: "disabled" });
    await page.keyboard.press("Enter");
    expect(await page.getByRole("status").textContent()).toBe("剧本解析已打开");
    await page.close();
});
