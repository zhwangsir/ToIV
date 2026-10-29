import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/styles/globals.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/canvas/canvas-node-graph-visual.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/node-graph-harness.tsx`],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/", VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "", VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test", VITE_FRAMEFIELD_LOCAL_RUNTIME_ENDPOINT: "http://127.0.0.1:8080" }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/components\/model-logo\.tsx$/ }, () => ({ contents: "export function ModelLogo() { return null; }", loader: "tsx" }));
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

async function openHarness(light = false): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1000, height: 650 } });
    await page.goto(`${server.url}${light ? "?light=1" : ""}`);
    await page.locator('[data-node-id="video"]').waitFor();
    return page;
}

test("node selection, type colors and active edge use the creation accent", async () => {
    const page = await openHarness();
    const selected = page.locator('[data-node-id="video"] .canvas-node-shell');
    expect(await selected.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(74, 127, 193)");
    expect(await selected.evaluate((element) => getComputedStyle(element).filter)).toContain("drop-shadow");
    expect(await page.locator('[data-node-id="script"] .canvas-node-shell').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(20, 21, 26, 0.92)");
    const typeColors = await page.locator('[data-node-id="video"] .canvas-node-shell').evaluate((element) => ({
        bar: getComputedStyle(element, "::before").backgroundColor,
        type: getComputedStyle(element).getPropertyValue("--toiv-node-type-color").trim(),
    }));
    expect(typeColors.bar).toBe(typeColors.type);
    const activeEdge = page.locator('g[data-canvas-connection-id="script-video"] path').nth(3);
    expect(await activeEdge.getAttribute("stroke")).toBe("#4A7FC1");
    await page.screenshot({ path: "test-results/freezone-r5/node-graph-dark.png", fullPage: true });
    await page.close();
});

test("connection ports become visible on keyboard focus and light nodes keep their surface", async () => {
    const page = await openHarness(true);
    const port = page.locator('[data-node-id="video"] [data-canvas-connection-rail="right"]');
    await port.focus();
    expect(await port.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
    expect(await port.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    expect(await port.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(74, 127, 193)");
    expect(await page.locator('[data-node-id="script"] .canvas-node-shell').evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgb(255, 255, 255)");
    await page.screenshot({ path: "test-results/freezone-r5/node-graph-light-port-focus.png", fullPage: true });
    await page.close();
});
