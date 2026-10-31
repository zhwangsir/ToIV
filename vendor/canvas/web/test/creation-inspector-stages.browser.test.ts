import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type BrowserContext, type Locator, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// C1c 右栏 Inspector + slots 集成验证(真实组件链):
//   CreationStudioSlotsProvider → CreationStudioInspector(消费 slots 的 detail/load)→ CreationStageTrack。
// 覆盖:slots 注册/清理、确认→reloadProject 刷新真源、409 冲突保留说明并再刷新、
//   load 返回 null 诚实提示、中舞台批量 render 409 → 打开右栏并聚焦对应阶段可直接操作、
//   阶段导航保留 /create?project=...&section=... URL、暗色对比度。
const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-c1c");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

async function expectVisible(locator: Locator, label: string): Promise<void> {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
    expect(await locator.isVisible(), label).toBe(true);
}

async function contrastRatio(page: Page, locator: Locator): Promise<number> {
    const handle = await locator.elementHandle();
    expect(handle, "对比度目标元素存在").not.toBeNull();
    return page.evaluate((el) => {
        const parse = (raw: string): [number, number, number] | null => {
            const m = raw.match(/rgba?\(([^)]+)\)/);
            if (!m) return null;
            const parts = m[1].split(",").map((x) => Number(x.trim()));
            if (parts.length < 3 || parts.some((n) => Number.isNaN(n))) return null;
            return [parts[0], parts[1], parts[2]];
        };
        const luminance = (rgb: [number, number, number]) => {
            const f = (c: number) => {
                const s = c / 255;
                return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
            };
            return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2]);
        };
        if (!(el instanceof Element)) return 0;
        const fg = parse(getComputedStyle(el).color);
        let bg: [number, number, number] | null = null;
        let node: Element | null = el;
        while (node) {
            const c = parse(getComputedStyle(node).backgroundColor);
            if (c && (getComputedStyle(node).backgroundColor.startsWith("rgb(") || Number(getComputedStyle(node).backgroundColor.split(",")[3]) > 0)) {
                bg = c;
                break;
            }
            node = node.parentElement;
        }
        if (!fg || !bg) return 0;
        const l1 = luminance(fg);
        const l2 = luminance(bg);
        return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
    }, handle);
}

beforeAll(async () => {
    mkdirSync(shotsDir, { recursive: true });
    const cssSources = await Promise.all([
        Bun.file(resolve(webRoot, "node_modules/antd/dist/reset.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-freezone-tokens.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/globals.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/workspace-product.css")).text(),
        Bun.file(resolve(webRoot, "src/styles/toiv-local-overrides.css")).text(),
    ]);
    const tailwindCss = await postcss([tailwind]).process(cssSources[2], { from: resolve(webRoot, "src/styles/globals.css") });
    styles = [cssSources[0], cssSources[1], tailwindCss.css, cssSources[3], cssSources[4]].join("\n");

    const build = await Bun.build({
        entrypoints: [resolve(import.meta.dir, "fixtures/creation-inspector-stages-harness.tsx")],
        target: "browser",
        define: {
            "process.env.NODE_ENV": '"production"',
            "import.meta.env": JSON.stringify({
                DEV: false, PROD: true, MODE: "production", BASE_URL: "/",
                VITE_CANVAS_LOCAL_MODE: "false", VITE_CANVAS_BACKEND_URL: "",
                VITE_APP_VERSION: "test", VITE_BUILD_COMMIT: "test",
            }),
        },
        plugins: [{ name: "workspace-alias", setup(builder) {
            builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(`../src/${args.path.slice(2)}`, import.meta.dir) }));
            builder.onLoad({ filter: /src\/services\/toiv\/client\.ts$/ }, () => ({
                contents: `
                    const STATES_ORDER = ["script", "assets", "storyboard", "generate", "voice", "timeline"];
                    export async function transitionProjectStage(pid, input) {
                        window.__toivCalls.push({ kind: "transition", pid, ...input });
                        const stub = window.__toivStub ?? {};
                        if (stub.transitionMode === "conflict") {
                            const err = new Error("Request failed with status code 409");
                            err.response = { status: 409, data: { detail: "阶段已被其他操作更新(stage_revision=" + stub.revision + ")" } };
                            throw err;
                        }
                        if (input.action === "confirm") stub.states[input.stage] = "confirmed";
                        if (input.action === "skip") stub.states[input.stage] = "skipped";
                        if (input.action === "reopen") {
                            stub.states[input.stage] = stub.states[input.stage] === "needs_review" ? "pending_confirmation" : "draft";
                        }
                        stub.revision = (stub.revision ?? 0) + 1;
                        const stage_states = Object.fromEntries(STATES_ORDER.map((id) => [id, {
                            state: stub.states[id] ?? "draft",
                            ready: stub.states[id] === "confirmed",
                            blockers: [],
                        }]));
                        return { project_id: pid, stage: input.stage, stage_states, stage_revision: stub.revision };
                    }
                    export async function fetchStageHistory(pid, stage) {
                        window.__toivCalls.push({ kind: "history", pid, stage: stage ?? null });
                        return { history: [] };
                    }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    // 组件自带 CSS import(creation-studio-three-pane.css 等)会被 Bun.build 抽成独立输出,注入 <style>
    const jsOutput = build.outputs.find((o) => o.path.endsWith(".js"))!;
    const extractedCss = (
        await Promise.all(
            build.outputs.filter((o) => o.path.endsWith(".css")).map((o) => o.text()),
        )
    ).join("\n");
    const js = await jsOutput.text();
    const allStyles = `${styles}\n${extractedCss}`;
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${allStyles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function closePage(page: Page & { __ctx?: BrowserContext }): Promise<void> {
    await page.__ctx?.close().catch(() => {});
}

async function openPage(): Promise<Page> {
    // 每用例独立 context:避免用例间页面状态(焦点/悬浮层)相互干扰
    // 视口 1440:≥1400px 时真实三栏 CSS 走设计默认 320px 右栏(≤1400px 响应式降为 280px)
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
    const page = Object.assign(await context.newPage(), { __ctx: context }) as Page & { __ctx: BrowserContext };
    page.on("pageerror", (err) => console.log("PAGEERROR:", err.message.slice(0, 300)));
    await page.goto(server.url.href);
    await expectVisible(page.getByTestId("fake-middle-stage"), "中舞台");
    return page;
}

async function resetAll(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.__toivCalls = [];
        window.__workspaceReloads = 0;
        window.__openStageCalls = [];
        window.__reloadProbe = "";
        window.__wsStub = { loadMode: "ok" };
        window.__toivStub = {
            transitionMode: "ok",
            batchMode: "ok",
            revision: 3,
            states: {
                script: "pending_confirmation",
                assets: "draft",
                storyboard: "confirmed",
                generate: "needs_review",
                voice: "skipped",
                timeline: "draft",
            },
            statesP2: {
                script: "confirmed",
                assets: "confirmed",
                storyboard: "confirmed",
                generate: "pending_confirmation",
                voice: "confirmed",
                timeline: "confirmed",
            },
        };
    });
}

async function openInspector(page: Page): Promise<Locator> {
    await page.getByRole("button", { name: "打开属性" }).click();
    const aside = page.getByTestId("creation-studio-inspector");
    await expectVisible(aside, "右栏 Inspector(真实三栏)");
    return aside;
}

test("Inspector 从 slots 消费 detail 渲染六阶段;确认 → reloadProject 刷新真源(暗色对比度)", async () => {
    const page = await openPage();
    await resetAll(page);
    const aside = await openInspector(page);
    const track = aside.getByTestId("creation-stage-track");
    await expectVisible(track.getByRole("button", { name: /剧本/ }), "六阶段轨道(来自 slots detail)");
    // 确认剧本 → 只能经 slots.reloadProject(load)刷新,不得本地伪造
    await track.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForFunction(() => (window.__workspaceReloads ?? 0) >= 1, undefined, { timeout: 10_000 });
    const transition = (await page.evaluate(() => window.__toivCalls ?? []) as { kind: string; [k: string]: unknown }[]).find((c) => c.kind === "transition");
    expect(transition).toMatchObject({ pid: "p1", stage: "script", action: "confirm", expected_stage_revision: 3 });
    await expectVisible(track.getByRole("button", { name: /剧本/ }).getByText("已确认", { exact: true }), "确认后由真源重派生");
    // 阶段导航保留 /create?project=...&section=...(timeline → timeline 区段)
    await track.getByRole("button", { name: /合成/ }).click();
    await track.getByRole("button", { name: "前往", exact: true }).click();
    await page.waitForFunction(() => (document.querySelector("[data-testid=url-readout]")?.textContent ?? "").includes("section=timeline"), undefined, { timeout: 10_000 });
    const url = await page.getByTestId("url-readout").textContent();
    expect(url).toContain("/create?project=p1");
    expect(url).toContain("section=timeline");
    // 暗色对比度:轨道 chip 文字
    const chipContrast = await contrastRatio(page, track.getByRole("button", { name: /剧本/ }));
    expect(chipContrast, `chip 文字对比度 ${chipContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    await aside.screenshot({ path: "test-results/production-c1c/inspector-stages-dark.png", animations: "disabled" });
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("409 冲突:保留后端冲突说明,并再次刷新真源", async () => {
    const page = await openPage();
    await resetAll(page);
    await page.evaluate(() => {
        (window.__toivStub ?? {}).transitionMode = "conflict";
    });
    const aside = await openInspector(page);
    const track = aside.getByTestId("creation-stage-track");
    await track.getByRole("button", { name: "确认", exact: true }).click();
    const msg = track.getByTestId("stage-track-message");
    await expectVisible(msg, "409 冲突说明");
    expect(await msg.textContent()).toContain("阶段已被其他操作更新");
    // 409 后再刷新真源(重新 load,拿最新 stage_revision)
    await page.waitForFunction(() => (window.__workspaceReloads ?? 0) >= 1, undefined, { timeout: 10_000 });
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("load() 返回 null:诚实提示刷新未确认,不宣称已刷新", async () => {
    const page = await openPage();
    await resetAll(page);
    await page.evaluate(() => {
        (window.__wsStub ?? {}).loadMode = "null";
    });
    const aside = await openInspector(page);
    const track = aside.getByTestId("creation-stage-track");
    await track.getByRole("button", { name: "确认", exact: true }).click();
    const msg = track.getByTestId("stage-track-message");
    await expectVisible(msg, "刷新未确认提示");
    const text = await msg.textContent();
    expect(text).toContain("已提交");
    expect(text).toContain("未确认");
    expect(text).not.toContain("已从服务端刷新");
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("阶段阻断入口:中舞台批量 render 409 → 打开右栏 Inspector 并聚焦阻断阶段,可直接操作", async () => {
    const page = await openPage();
    await resetAll(page);
    await page.evaluate(() => {
        const stub = window.__toivStub ?? {};
        stub.batchMode = "conflict";
        // 让「分镜」成为最早阻断阶段:剧本已确认、资产已跳过、分镜待确认
        stub.states = {
            script: "confirmed",
            assets: "skipped",
            storyboard: "pending_confirmation",
            generate: "confirmed",
            voice: "skipped",
            timeline: "confirmed",
        };
    });
    // 触发批量渲染(中舞台,用户操作位置附近)
    await page.getByRole("button", { name: "批量渲染" }).click();
    // 真实三栏证据:中舞台存在、右栏 320px(真实 creation-studio-three-pane.css)
    const threePane = page.getByTestId("creation-studio-three-pane");
    await expectVisible(threePane, "真实三栏壳");
    await expectVisible(page.getByTestId("creation-studio-stage").getByTestId("fake-middle-stage"), "中舞台内容");
    // 阻断前:右栏按 workbench 逻辑隐藏(未请求打开),不预置断言
    const middle = page.getByTestId("fake-middle-stage");
    const notice = middle.getByTestId("stage-block-notice");
    await expectVisible(notice, "触发位置附近的阻断引导");
    expect(await notice.textContent()).toContain("批量渲染被阶段闸拦截");
    // 右栏未打开时点击入口 → 明确打开 Inspector 并聚焦阻断阶段
    await notice.getByRole("button", { name: /前往/ }).click();
    await page.waitForFunction(() => ((window as unknown as { __openStageCalls?: string[] }).__openStageCalls ?? []).some((c) => String(c).includes("storyboard")), undefined, { timeout: 10_000 });
    const aside = page.getByTestId("creation-studio-inspector");
    await expectVisible(aside, "右栏被明确打开");
    const track = aside.getByTestId("creation-stage-track");
    await expectVisible(track.getByText("03 分镜"), "聚焦到阻断阶段分镜");
    // 阻断后右栏仍可见且宽度保持 320px(真实三栏)
    await expectVisible(aside, "阻断后右栏可见");
    const paneWAfter = await page.evaluate(() => document.querySelector("[data-testid=creation-studio-inspector]")?.clientWidth ?? 0);

    expect(paneWAfter, "阻断后右栏 320px").toBeGreaterThanOrEqual(315);
    // 可直接操作:pending_confirmation 分镜提供确认(经 slots reload 刷新真源)
    await track.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForFunction(() => (window.__toivCalls ?? []).some((c) => c.kind === "transition" && c.stage === "storyboard"), undefined, { timeout: 10_000 });
    await page.waitForFunction(() => (window.__workspaceReloads ?? 0) >= 1, undefined, { timeout: 10_000 });
    await threePane.screenshot({ path: "test-results/production-c1c/workbench-stages-dark.png", animations: "disabled" });
    await aside.screenshot({ path: "test-results/production-c1c/inspector-stages-block-open.png", animations: "disabled" });
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("stageFocus 与 pid 关联:旧项目聚焦不污染新项目;匹配 pid 的聚焦生效", async () => {
    const page = await openPage();
    await resetAll(page);
    const aside = await openInspector(page);
    const track = aside.getByTestId("creation-stage-track");
    await expectVisible(track.getByText("01 剧本"), "p1 默认聚焦首个阻断阶段(剧本)");
    // 项目切换到 p2(URL 同步 project=p2,Inspector 消费 p2 真源)
    await page.getByRole("button", { name: "项目切换到 p2" }).click();
    await page.waitForFunction(() => (document.querySelector("[data-testid=url-readout]")?.textContent ?? "").includes("project=p2"), undefined, { timeout: 10_000 });
    await expectVisible(track.getByText("04 生成"), "p2 默认聚焦自己的首个阻断阶段(生成)");
    // 旧项目 p1 的聚焦请求不得污染 p2
    await page.getByRole("button", { name: "聚焦p1·分镜" }).click();
    await page.waitForFunction(() => ((window as unknown as { __openStageCalls?: string[] }).__openStageCalls ?? []).includes("focus:p1:storyboard"), undefined, { timeout: 10_000 });
    await page.waitForTimeout(200);
    expect(await track.getByText("03 分镜").count(), "p1 聚焦被 Inspector 忽略").toBe(0);
    await expectVisible(track.getByText("04 生成"), "p2 选中态保持自己的阻断阶段");
    // 匹配 pid 的聚焦生效
    await page.getByRole("button", { name: "聚焦p2·分镜" }).click();
    await page.waitForFunction(() => ((window as unknown as { __openStageCalls?: string[] }).__openStageCalls ?? []).includes("focus:p2:storyboard"), undefined, { timeout: 10_000 });
    await expectVisible(track.getByText("03 分镜"), "p2 自己的聚焦生效");
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("项目清理同步清 reloadRef:卸载后 reloadProject 不再返回旧项目 detail", async () => {
    const page = await openPage();
    await resetAll(page);
    // 注册期:reloadProject 走 workspace 的 load
    await page.getByRole("button", { name: "探针reloadProject" }).click();
    await page.waitForFunction(() => (window as unknown as { __reloadProbe?: string }).__reloadProbe === "p1", undefined, { timeout: 10_000 });
    // 卸载(项目切换清理):reloadRef 同步清空
    await page.getByRole("button", { name: "卸载工作区(模拟项目切换)" }).click();
    await expectVisible(page.getByTestId("ws-unmounted"), "工作区已卸载");
    await page.getByRole("button", { name: "探针reloadProject" }).click();
    await page.waitForFunction(() => (window as unknown as { __reloadProbe?: string }).__reloadProbe === "null", undefined, { timeout: 10_000 });
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);

test("工作区卸载/项目切换清理:slots 不再供 detail → Inspector 回退原四阶段", async () => {
    const page = await openPage();
    await resetAll(page);
    const aside = await openInspector(page);
    await expectVisible(aside.getByTestId("creation-stage-track").getByRole("button", { name: /剧本/ }), "注册期:六阶段");
    await page.getByRole("button", { name: "卸载工作区(模拟项目切换)" }).click();
    await expectVisible(page.getByTestId("ws-unmounted"), "工作区已卸载");
    // 清理后:Inspector 拿不到 detail → 原四阶段(Inspector 直接渲染 CreationPhaseStrip),不空白崩溃
    await expectVisible(aside.getByRole("button", { name: /关键帧/ }), "清理后回退四阶段(关键帧)");
    expect(await aside.getByText("待确认", { exact: true }).count(), "不再有六阶段徽章").toBe(0);
    await aside.screenshot({ path: "test-results/production-c1c/inspector-stages-legacy.png", animations: "disabled" });
    await closePage(page as Page & { __ctx?: BrowserContext });
}, 30_000);
