import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chromium, type Browser, type Page } from "playwright";

const styles = (await Promise.all([
    Bun.file(new URL("../src/styles/toiv-freezone-tokens.css", import.meta.url)).text(),
    Bun.file(new URL("../src/components/content-mode/content-mode-prototypes.css", import.meta.url)).text(),
])).join("\n");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const build = await Bun.build({
        entrypoints: [`${import.meta.dir}/fixtures/light-curtain-harness.tsx`],
        target: "browser",
        define: { "process.env.NODE_ENV": '"production"' },
        plugins: [{
            name: "workspace-alias",
            setup(builder) {
                builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            },
        }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html><head><style>*{box-sizing:border-box}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openHarness({ light = false, compact = false, adult = false, underage = false, width = 1440 } = {}) {
    const page = await browser.newPage({ viewport: { width, height: 800 } });
    await page.addInitScript(({ adult, underage }) => {
        localStorage.setItem("toiv_r18_mode", adult ? "1" : "0");
        if (underage) localStorage.setItem("toiv_birthdate", "2010-01-01");
    }, { adult, underage });
    const query = new URLSearchParams({ ...(light ? { light: "1" } : {}), ...(compact ? { compact: "1" } : {}) });
    await page.goto(`${server.url}${query.size ? `?${query}` : ""}`);
    await page.getByTestId("content-mode-light-curtain").waitFor();
    return page;
}

async function railGeometry(page: Page) {
    return page.evaluate(() => {
        const rail = document.querySelector(".cm-light-curtain-rail")!;
        const option = document.querySelector(".cm-light-curtain-opt")!;
        const railStyle = getComputedStyle(rail);
        return {
            railWidth: rail.getBoundingClientRect().width,
            railHeight: rail.getBoundingClientRect().height,
            optionHeight: option.getBoundingClientRect().height,
            background: railStyle.backgroundColor,
            shadow: railStyle.boxShadow,
        };
    });
}

test("paddle keeps AA-oriented geometry, neutral adult lock, compact and mobile states", async () => {
    const ordinary = await openHarness();
    expect(await railGeometry(ordinary)).toMatchObject({ railHeight: 28, background: "rgb(16, 17, 24)", shadow: "none" });
    expect((await railGeometry(ordinary)).optionHeight).toBeGreaterThanOrEqual(24);
    await ordinary.close();

    const adult = await openHarness({ adult: true });
    const adultGeometry = await railGeometry(adult);
    expect(adultGeometry.shadow).toContain("107, 114, 128");
    expect(await adult.locator(".cm-light-curtain-veil").evaluate((element) => getComputedStyle(element).backgroundColor)).toBe("rgba(107, 114, 128, 0.12)");
    await adult.close();

    const compact = await openHarness({ compact: true });
    expect((await railGeometry(compact)).railWidth).toBe(56);
    await compact.close();

    const mobile = await openHarness({ width: 375 });
    expect((await railGeometry(mobile)).railWidth).toBe(56);
    expect(await mobile.locator(".cm-light-curtain-opt span").first().isVisible()).toBe(false);
    await mobile.close();
});

test("keyboard focus is visible and confirmation supports focus, Escape and outside dismissal", async () => {
    const page = await openHarness();
    const adult = page.getByTestId("content-mode-a-adult");
    await adult.focus();
    expect(await adult.evaluate((element) => getComputedStyle(element).outlineStyle)).toBe("solid");
    expect(await adult.evaluate((element) => getComputedStyle(element).outlineColor)).toBe("rgb(74, 127, 193)");
    await adult.click();
    const confirm = page.getByTestId("content-mode-confirm-enable");
    expect(await confirm.evaluate((element) => element === document.activeElement)).toBe(true);
    expect(await page.getByTestId("content-mode-confirm").getAttribute("aria-describedby")).toBeTruthy();
    await page.keyboard.press("Escape");
    expect(await page.getByTestId("content-mode-confirm").count()).toBe(0);
    expect(await adult.evaluate((element) => element === document.activeElement)).toBe(true);
    await adult.click();
    await page.locator("body").click({ position: { x: 8, y: 500 } });
    expect(await page.getByTestId("content-mode-confirm").count()).toBe(0);
    await page.close();
});

test("light theme, reduced motion and underage state are explicit", async () => {
    const light = await openHarness({ light: true });
    expect((await railGeometry(light)).background).toBe("rgb(255, 255, 255)");
    await light.getByTestId("content-mode-a-adult").click();
    expect(await light.getByTestId("content-mode-confirm").evaluate((element) => getComputedStyle(element).color)).toBe("rgb(18, 18, 20)");
    await light.emulateMedia({ reducedMotion: "reduce" });
    expect(await light.locator(".cm-light-curtain-veil").evaluate((element) => getComputedStyle(element).transitionProperty)).toBe("none");
    await light.close();

    const underage = await openHarness({ underage: true });
    expect(await underage.getByTestId("content-mode-a-adult").isDisabled()).toBe(true);
    expect(await underage.getByTestId("content-mode-a-adult").getAttribute("title")).toContain("未满足");
    await underage.close();
});
