import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { chromium, type Browser, type Locator, type Page } from "playwright";
import postcss from "postcss";
import tailwind from "@tailwindcss/postcss";

// C1c 六阶段轨道真实渲染验证:确认/跳过(说明必填)/重开/needs_review 重开再确认/409 冲突/历史抽屉筛选/
// 旧服务端四阶段回退/无项目不崩溃/批量 409 阻断引导入口/暗色对比度。
// 组件依赖 @/services/toiv/client 的真实 API 封装,由插件 stub 成可断言的内存实现(与 C1a harness 同风格)。
const webRoot = resolve(import.meta.dir, "..");
const shotsDir = resolve(webRoot, "test-results/production-c1c");

let browser: Browser;
let server: ReturnType<typeof Bun.serve>;
let styles = "";

type ToivCall = { kind: string; [key: string]: unknown };

async function expectVisible(locator: Locator, label: string): Promise<void> {
    await locator.waitFor({ state: "visible", timeout: 10_000 });
    expect(await locator.isVisible(), label).toBe(true);
}

/** 文本色与其有效背景(向上找第一个非透明背景)的 WCAG 对比度 */
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
        entrypoints: [resolve(import.meta.dir, "fixtures/creation-stage-track-harness.tsx")],
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
                        if (stub.transitionMode === "slow") {
                            await new Promise((r) => setTimeout(r, 800));
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
                            blockers: (stub.blockers ?? {})[id] ?? [],
                        }]));
                        return { project_id: pid, stage: input.stage, stage_states, stage_revision: stub.revision };
                    }
                    export async function fetchStageHistory(pid, stage) {
                        window.__toivCalls.push({ kind: "history", pid, stage: stage ?? null });
                        if ((window.__toivStub ?? {}).historyMode === "slow") {
                            await new Promise((r) => setTimeout(r, 600));
                        }
                        if (pid === "p2") {
                            // p2 专属历史:与 p1 完全不同的条目,用于证明旧 pid 慢响应不会串写
                            return { history: [
                                { id: "h9", stage: "voice", from_state: "draft", to_state: "pending_confirmation", source: "agent", note: "p2 专属历史", created_by: "agent-9", created_at: "2026-10-28T08:00:00" },
                            ] };
                        }
                        const all = [
                            { id: "h4", stage: "generate", from_state: "pending_confirmation", to_state: "needs_review", source: "agent", note: "质检未过:角色一致性", created_by: "agent-1", created_at: "2026-10-27T10:20:00" },
                            { id: "h3", stage: "script", from_state: "draft", to_state: "pending_confirmation", source: "agent", note: null, created_by: "agent-1", created_at: "2026-10-27T09:12:00" },
                            { id: "h2", stage: "script", from_state: "confirmed", to_state: "draft", source: "manual", note: "台词还要改", created_by: "u1", created_at: "2026-10-27T08:40:00" },
                            { id: "h1", stage: "assets", from_state: "draft", to_state: "skipped", source: "manual", note: "复用旧项目资产", created_by: "u1", created_at: "2026-10-26T18:02:00" },
                        ];
                        return { history: stage ? all.filter((h) => h.stage === stage) : all };
                    }
                `,
                loader: "ts",
            }));
        } }],
    });
    if (!build.success) throw new Error(build.logs.join("\n"));
    const js = await build.outputs[0].text();
    server = Bun.serve({
        port: 0,
        fetch: (request) => new URL(request.url).pathname === "/harness.js"
            ? new Response(js, { headers: { "Content-Type": "application/javascript" } })
            : new Response(`<html><head><style>*{box-sizing:border-box}body{margin:0}${styles}</style></head><body><div id="root"></div><script type="module" src="/harness.js"></script></body></html>`, { headers: { "Content-Type": "text/html" } }),
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 90_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function openPage(light = false): Promise<Page> {
    const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
    await page.goto(light ? `${server.url.href}?light=1` : server.url.href);
    await expectVisible(page.getByTestId("stage-track"), "六阶段轨道");
    return page;
}

async function calls(page: Page): Promise<ToivCall[]> {
    return page.evaluate(() => window.__toivCalls ?? []) as Promise<ToivCall[]>;
}

/** 重置 stub 到初始状态(每用例前调用,避免用例间串扰) */
async function resetStub(page: Page): Promise<void> {
    await page.evaluate(() => {
        window.__toivCalls = [];
        window.__reloadCount = 0;
        window.__navCalls = [];
        window.__toivStub = {
            transitionMode: "ok",
            historyMode: "fast",
            revision: 3,
            states: {
                script: "pending_confirmation",
                assets: "draft",
                storyboard: "confirmed",
                generate: "needs_review",
                voice: "skipped",
                timeline: "draft",
            },
            blockers: { assets: ["角色定妆未完成"] },
        };
    });
}

test("六阶段渲染:状态徽章 + blockers + 导航映射(voice/timeline 定位 generate 区段)", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await expectVisible(track.getByText("待确认", { exact: true }), "script 待确认徽章");
    await expectVisible(track.getByText("需复核", { exact: true }), "generate 需复核徽章");
    await expectVisible(track.getByText("已跳过", { exact: true }), "voice 已跳过徽章");
    await expectVisible(track.getByText("已确认", { exact: true }), "storyboard 已确认徽章");
    // blockers 透出(选中资产阶段后显示其阻断说明)
    await track.getByRole("button", { name: /资产/ }).click();
    await expectVisible(track.getByText("角色定妆未完成"), "assets blocker 文案");
    // 阶段导航:voice→shots(生成区段),timeline→timeline 区段(不得错导航) —— 选中后点「前往」
    await track.getByRole("button", { name: /配音/ }).click();
    await track.getByRole("button", { name: "前往", exact: true }).click();
    await track.getByRole("button", { name: /合成/ }).click();
    await track.getByRole("button", { name: "前往", exact: true }).click();
    expect(await page.evaluate(() => window.__navCalls ?? [])).toEqual(["shots", "timeline"]);
    await track.screenshot({ path: "test-results/production-c1c/stage-track-dark.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("确认:POST confirm(带 expected_stage_revision)→ 调用 load() 从真源重派生,不本地伪造", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /剧本/ }).click();
    await track.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    const transition = (await calls(page)).find((c) => c.kind === "transition");
    expect(transition).toMatchObject({ pid: "p1", stage: "script", action: "confirm", expected_stage_revision: 3 });
    // 成功后由 load() 从 stub 真值重派生:剧本徽章变为已确认(定位到剧本 chip,避免与分镜徽章歧义)
    const scriptChip = track.getByRole("button", { name: /剧本/ });
    await expectVisible(scriptChip.getByText("已确认", { exact: true }), "确认后剧本已确认(刷新真源派生)");
    await page.close();
}, 30_000);

test("跳过:说明必填 —— 空说明不可提交,填说明后 POST skip 成功", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /资产/ }).click();
    await track.getByRole("button", { name: "跳过", exact: true }).click();
    const modal = page.locator(".ant-modal");
    await expectVisible(modal, "跳过说明弹窗");
    const submit = modal.getByRole("button", { name: "确认跳过" });
    expect(await submit.isDisabled(), "空说明时确认跳过禁用").toBe(true);
    await modal.locator("textarea").fill("复用旧项目资产");
    expect(await submit.isEnabled(), "填说明后可提交").toBe(true);
    await submit.click();
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    const transition = (await calls(page)).find((c) => c.kind === "transition");
    expect(transition).toMatchObject({ stage: "assets", action: "skip", note: "复用旧项目资产", expected_stage_revision: 3 });
    await expectVisible(track.getByRole("button", { name: /资产/ }).getByText("已跳过", { exact: true }), "资产已跳过");
    await page.close();
}, 30_000);

test("needs_review:重开再确认 —— reopen 回到待确认,确认后变已确认", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /生成/ }).click();
    await expectVisible(track.getByRole("button", { name: /重开/ }), "needs_review 重开入口");
    await track.getByRole("button", { name: /重开/ }).click();
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    let transition = (await calls(page)).find((c) => c.kind === "transition");
    expect(transition).toMatchObject({ stage: "generate", action: "reopen" });
    // 重开后服务端真值 = pending_confirmation → 出现「确认」
    await expectVisible(track.getByRole("button", { name: "确认", exact: true }), "重开后可再确认");
    await track.getByRole("button", { name: "确认", exact: true }).click();
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 2, undefined, { timeout: 10_000 });
    transition = (await calls(page)).filter((c) => c.kind === "transition").at(-1);
    expect(transition).toMatchObject({ stage: "generate", action: "confirm" });
    await expectVisible(track.getByRole("button", { name: /生成/ }).getByText("已确认", { exact: true }), "生成已确认");
    await page.close();
}, 30_000);

test("已确认阶段可重开(confirmed → draft)", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /分镜/ }).click();
    await track.getByRole("button", { name: /重开/ }).click();
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    const transition = (await calls(page)).find((c) => c.kind === "transition");
    expect(transition).toMatchObject({ stage: "storyboard", action: "reopen" });
    await expectVisible(track.getByRole("button", { name: /分镜/ }).getByText("未开始", { exact: true }), "分镜重开后回草稿");
    await page.close();
}, 30_000);

test("409 CAS 冲突:显示后端 detail 原因并刷新真源(不只 toast 无下文)", async () => {
    const page = await openPage();
    await resetStub(page);
    await page.evaluate(() => {
        (window.__toivStub ?? {}).transitionMode = "conflict";
    });
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /剧本/ }).click();
    await track.getByRole("button", { name: "确认", exact: true }).click();
    const msg = track.getByTestId("stage-track-message");
    await expectVisible(msg, "409 冲突提示");
    expect(await msg.textContent()).toContain("阶段已被其他操作更新");
    // 冲突后必须刷新真源(重新 load),而不是只弹 toast
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    await track.screenshot({ path: "test-results/production-c1c/stage-track-conflict.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("历史抽屉:按阶段筛选,显示时间/来源/说明(暗色对比度)", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: "阶段历史" }).click();
    const drawer = page.getByTestId("stage-history-drawer");
    await expectVisible(drawer, "历史抽屉");
    // 默认全部:四条
    expect(await drawer.locator("ol li").count()).toBe(4);
    await expectVisible(drawer.getByText("质检未过:角色一致性"), "note 说明透出");
    await expectVisible(drawer.getByText("台词还要改"), "script note 透出");
    // 时间显示
    const drawerText = await drawer.textContent();
    expect(drawerText).toContain("2026/10/27");
    // 筛选 script → 只剩两条
    await drawer.getByRole("radio", { name: "剧本" }).click();
    await page.waitForFunction(() => (window.__toivCalls ?? []).some((c) => c.kind === "history" && c.stage === "script"), undefined, { timeout: 10_000 });
    expect(await drawer.locator("ol li").count()).toBe(2);
    const historyCall = (await calls(page)).filter((c) => c.kind === "history").at(-1);
    expect(historyCall).toMatchObject({ pid: "p1", stage: "script" });
    // 暗色验收:抽屉标题与条目文字对比度 >= 4.5(挂真实 ConfigProvider 主题后必达)
    const titleContrast = await contrastRatio(page, page.locator(".ant-drawer-title"));
    expect(titleContrast, `抽屉标题对比度 ${titleContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    const itemContrast = await contrastRatio(page, drawer.locator("ol li").first());
    expect(itemContrast, `历史条目对比度 ${itemContrast.toFixed(2)}`).toBeGreaterThanOrEqual(4.5);
    await page.locator(".ant-drawer-content-wrapper").screenshot({ path: "test-results/production-c1c/stage-history-drawer.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("批量 render/assemble 409 阻断引导:显示原因 + 打开右栏阶段入口的可执行操作(stage 级回调)", async () => {
    const page = await openPage();
    await resetStub(page);
    const notice = page.getByTestId("stage-block-notice");
    await expectVisible(notice, "阻断引导条");
    expect(await notice.textContent()).toContain("批量渲染被阶段闸拦截");
    await notice.getByRole("button", { name: /前往/ }).click();
    // stage 级入口:由调用方决定如何让用户直达该阶段(如 slots 请求打开 Inspector 并聚焦),不是无下文跳转
    expect(await page.evaluate(() => window.__openStageCalls ?? [])).toEqual(["storyboard"]);
    await notice.screenshot({ path: "test-results/production-c1c/stage-block-notice.png", animations: "disabled" });
    await page.close();
}, 30_000);

test("诚实刷新:父 load() 返回 null 时,不得宣称已刷新", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track-nullreload");
    await track.getByRole("button", { name: /剧本/ }).click();
    await track.getByRole("button", { name: "确认", exact: true }).click();
    const msg = track.getByTestId("stage-track-message");
    await expectVisible(msg, "刷新未确认提示");
    const text = await msg.textContent();
    expect(text).toContain("已提交");
    expect(text).toContain("未确认");
    // 诚实:不得出现「已从服务端刷新」类断言
    expect(text).not.toContain("已从服务端刷新");
    await page.close();
}, 30_000);

test("服务端未提供 stage_revision:明确不兼容提示,不发 undefined CAS,动作不可用", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track-norev");
    const warn = track.getByTestId("stage-track-cas-missing");
    await expectVisible(warn, "stage_revision 缺失不兼容提示");
    expect(await warn.textContent()).toContain("stage_revision");
    // 动作区不提供确认/跳过/重开(不发 undefined CAS 冒充旧服务兼容)
    expect(await track.getByRole("button", { name: "确认", exact: true }).count()).toBe(0);
    expect(await track.getByRole("button", { name: "跳过", exact: true }).count()).toBe(0);
    expect(await track.getByRole("button", { name: /重开/ }).count()).toBe(0);
    expect((await calls(page)).filter((c) => c.kind === "transition")).toHaveLength(0);
    await page.close();
}, 30_000);

test("busy 期间禁止重复写:转场进行中动作按钮全部禁用,连点只提交一次", async () => {
    const page = await openPage();
    await resetStub(page);
    await page.evaluate(() => {
        (window.__toivStub ?? {}).transitionMode = "slow";
    });
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: /剧本/ }).click();
    const confirmBtn = track.getByRole("button", { name: "确认", exact: true });
    await confirmBtn.click();
    // 慢转场(800ms)期间:确认/跳过均禁用,重复点击不重复写
    await expectVisible(track.getByRole("button", { name: "提交中…" }), "busy 状态反馈");
    expect(await track.getByRole("button", { name: "跳过", exact: true }).isDisabled()).toBe(true);
    expect(await track.getByRole("button", { name: "提交中…" }).isDisabled()).toBe(true);
    await track.getByRole("button", { name: "提交中…" }).click({ force: true }).catch(() => {});
    await page.waitForFunction(() => (window.__reloadCount ?? 0) >= 1, undefined, { timeout: 10_000 });
    const transitions = (await calls(page)).filter((c) => c.kind === "transition");
    expect(transitions).toHaveLength(1);
    await page.close();
}, 30_000);

test("pid 切换重置:selectedStage/消息/弹窗全部复位,旧投影不串号", async () => {
    const page = await openPage();
    await resetStub(page);
    const track = page.getByTestId("stage-track-switch");
    // 选中资产并打开跳过弹窗
    await track.getByRole("button", { name: /资产/ }).click();
    await track.getByRole("button", { name: "跳过", exact: true }).click();
    await expectVisible(page.locator(".ant-modal"), "跳过弹窗已打开");
    // 弹窗遮罩会拦截页面点击(与生产一致),这里用 DOM 派发模拟「项目切换信号到达」
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("切到 p2"));
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expectVisible(track.getByRole("button", { name: /关键帧/ }), "p2 回退四阶段");
    expect(await page.locator(".ant-modal").count(), "pid 切换后弹窗复位").toBe(0);
    // 切回 p1 → 选中态复位到首个阻断阶段(剧本),动作栏不是资产的
    await track.getByRole("button", { name: "切到 p1(六阶段)" }).click();
    await expectVisible(track.getByText("01 剧本"), "选中态复位到剧本");
    expect(await track.getByText("02 资产").count(), "动作栏不是资产").toBe(0);
    await page.close();
}, 30_000);

test("历史请求不串扰:慢响应的旧筛选结果不得覆盖新筛选(序号闸)", async () => {
    const page = await openPage();
    await resetStub(page);
    await page.evaluate(() => {
        (window.__toivStub ?? {}).historyMode = "slow";
    });
    const track = page.getByTestId("stage-track");
    await track.getByRole("button", { name: "阶段历史" }).click();
    const drawer = page.getByTestId("stage-history-drawer");
    await expectVisible(drawer, "历史抽屉");
    // 先发「全部」请求,立刻改筛「剧本」:后者晚到,最终只应剩剧本 2 条
    await drawer.getByRole("radio", { name: "剧本" }).click();
    await page.waitForFunction(() => (window.__toivCalls ?? []).filter((c) => c.kind === "history").length >= 2, undefined, { timeout: 10_000 });
    await page.waitForTimeout(900);
    expect(await drawer.locator("ol li").count(), "慢「全部」响应不得覆盖新筛选").toBe(2);
    await page.close();
}, 30_000);

test("pid 切换(p1→p2 同为六阶段)使在途历史请求失效:旧 pid 慢响应不得写入,historyLoading 复位", async () => {
    const page = await openPage();
    await resetStub(page);
    await page.evaluate(() => {
        (window.__toivStub ?? {}).historyMode = "slow";
    });
    const track = page.getByTestId("stage-track-switch-six");
    // p1:打开历史抽屉(慢请求在途)
    await track.getByRole("button", { name: "阶段历史" }).click();
    await expectVisible(page.getByTestId("stage-history-drawer"), "p1 历史抽屉打开");
    // 切到同为完整六阶段的 p2(不是回退四阶段重挂载):徽章仍在即六阶段轨道
    // 抽屉遮罩会拦截页面点击(与生产一致):DOM 派发模拟「项目切换信号到达」,在途历史请求仍在飞
    await page.evaluate(() => {
        const btn = [...document.querySelectorAll("[data-testid=stage-track-switch-six] button")].find((b) => b.textContent?.includes("切到 p2"));
        btn?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await expectVisible(track.getByRole("button", { name: /剧本/ }).getByText("待确认", { exact: true }), "p2 仍为六阶段轨道");
    // 等旧 p1 的慢响应落地:若未在 pid 切换时失效,此刻会写入 p1 条目
    await page.waitForTimeout(1000);
    // 在 p2 重新打开历史:不得立刻闪现 p1 的条目
    await track.getByRole("button", { name: "阶段历史" }).click();
    const drawer = page.getByTestId("stage-history-drawer");
    await expectVisible(drawer, "p2 历史抽屉打开");
    expect(await drawer.getByText("质检未过:角色一致性").count(), "旧 pid 慢响应不得写入新 pid 状态").toBe(0);
    // historyLoading 复位:p2 自己的响应到达后显示 p2 专属条目(不会永远卡在加载)
    await page.waitForFunction(() => (window.__toivCalls ?? []).filter((c) => c.kind === "history" && c.pid === "p2").length >= 1, undefined, { timeout: 10_000 });
    await page.waitForTimeout(900);
    await expectVisible(drawer.getByText("p2 专属历史"), "p2 自己的历史");
    await page.close();
}, 30_000);

test("旧服务端/无项目回退:保留原四阶段视觉与老 API,不空白崩溃", async () => {
    const page = await openPage();
    await resetStub(page);
    const legacy = page.getByTestId("stage-track-legacy");
    // 旧四阶段标签(与 creation-phase-strip 完全一致)
    for (const label of ["剧本", "资产", "关键帧", "生成"]) {
        await expectVisible(legacy.getByRole("button", { name: new RegExp(label) }), `legacy 四阶段:${label}`);
    }
    // 无 stage_states 不出现六阶段动作/徽章
    expect(await legacy.getByText("待确认", { exact: true }).count()).toBe(0);
    // 老 API 视觉:section=storyboard → 关键帧激活
    expect(await legacy.getByRole("button", { name: /关键帧/ }).getAttribute("aria-current")).toBe("step");
    // 老 onSelect 映射:关键帧 → storyboard 区段
    await legacy.getByRole("button", { name: /关键帧/ }).click();
    expect(await page.evaluate(() => (window.__navCalls ?? []).at(-1))).toBe("storyboard");
    // 无项目:null detail 不崩溃,四阶段默认可渲染
    const noproject = page.getByTestId("stage-track-noproject");
    await expectVisible(noproject.getByRole("button", { name: /生成/ }), "无项目四阶段");
    await noproject.screenshot({ path: "test-results/production-c1c/stage-track-legacy.png", animations: "disabled" });
    await page.close();
}, 30_000);
