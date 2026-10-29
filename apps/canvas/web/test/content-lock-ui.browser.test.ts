import { afterAll, beforeAll, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, type Browser, type Page } from "playwright";

const webDir = resolve(import.meta.dir, "..");
const scripts = new Map<string, string>();
let browser: Browser;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
    const directory = mkdtempSync(join(tmpdir(), "toiv-policy-ui-"));
    try {
        for (const name of ["content-policy.ts", "content-lock.ts"]) {
            copyFileSync(join(webDir, "src", name), join(directory, name));
        }
        const originalLock = readFileSync(join(directory, "content-lock.ts"));
        for (const state of ["installed", "missing", "replacement", "reinstalled"]) {
            if (state === "missing") rmSync(join(directory, "content-lock.ts"));
            if (state === "replacement") writeFileSync(join(directory, "content-lock.ts"), 'export { contentPolicy } from "./content-policy";');
            if (state === "reinstalled") writeFileSync(join(directory, "content-lock.ts"), originalLock);
            const policyFile = existsSync(join(directory, "content-lock.ts")) ? "content-lock.ts" : "content-policy.ts";
            const build = await Bun.build({
                entrypoints: [join(import.meta.dir, "fixtures/content-lock-ui-harness.tsx")],
                target: "browser",
                define: {
                    "process.env.NODE_ENV": '"production"',
                    "import.meta.env": JSON.stringify({ DEV: false, PROD: true, MODE: "production", BASE_URL: "/" }),
                },
                plugins: [{
                    name: "physical-policy-copy",
                    setup(builder) {
                        builder.onLoad({ filter: /model-logo\.tsx$/ }, async (args) => ({
                            contents: (await Bun.file(args.path).text()).replace(/import\.meta\.glob\([^;]+\)/, "{}"),
                            loader: "tsx",
                        }));
                        builder.onResolve({ filter: /^@content-lock$/ }, () => ({ path: join(directory, policyFile) }));
                        builder.onResolve({ filter: /^@\// }, (args) => ({ path: Bun.resolveSync(join(webDir, "src", args.path.slice(2)), webDir) }));
                        builder.onLoad({ filter: /\.(css|svg|png|jpe?g|woff2?)$/ }, () => ({ contents: "export default ''", loader: "js" }));
                    },
                }],
            });
            if (!build.success) throw new Error(build.logs.join("\n"));
            scripts.set(`/${state}.js`, await build.outputs[0].text());
        }
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
    server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
            const url = new URL(request.url);
            const script = scripts.get(url.pathname);
            if (script) return new Response(script, { headers: { "Content-Type": "text/javascript" } });
            if (url.pathname === "/api/apps") return Response.json([
                { id: "fixture-ordinary", name: "Ordinary workflow", category: "image", output_kind: "image", is_nsfw: false, content_modes: ["sfw"], params_schema: [] },
                { id: "fixture-classified", name: "Classified workflow", category: "image", output_kind: "image", is_nsfw: true, content_modes: ["nsfw"], params_schema: [] },
            ]);
            if (url.pathname === "/api/apps/fixture-ordinary") return Response.json({
                id: "fixture-ordinary", name: "Ordinary workflow", category: "image", output_kind: "image",
                is_nsfw: false, content_modes: ["sfw", "nsfw"], params_schema: [],
            });
            if (url.pathname === "/api/apps/fixture-classified") return Response.json({
                id: "fixture-classified", name: "Classified workflow", category: "image", output_kind: "image",
                is_nsfw: true, content_modes: ["nsfw"], params_schema: [],
            });
            if (url.pathname.startsWith("/api/")) return Response.json({ code: 0, data: [], msg: "ok" });
            const state = scripts.has(`/${url.searchParams.get("state")}.js`) ? url.searchParams.get("state") : "installed";
            return new Response(`<div id="root"></div><script type="module" src="/${state}.js"></script>`, { headers: { "Content-Type": "text/html" } });
        },
    });
    const executablePath = [process.env.CHROME_PATH, "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"].find((path): path is string => Boolean(path && existsSync(path)));
    browser = await chromium.launch({ executablePath, headless: true });
}, 60_000);

afterAll(async () => {
    await browser?.close();
    server?.stop(true);
});

async function withPage(state: string, run: (page: Page) => Promise<void>) {
    const page = await browser.newPage();
    const errors: string[] = [];
    page.setDefaultTimeout(2_000);
    page.on("pageerror", (error) => errors.push(error.message));
    try {
        await page.goto(`${server.url}?state=${state}`);
        await page.getByTestId("ws-creation-dock").waitFor().catch((error) => {
            throw new Error(`${error.message}\nPage errors: ${errors.join("\n")}`);
        });
        await run(page);
        expect(errors).toEqual([]);
    } finally {
        await page.close();
    }
}

for (const state of ["missing", "replacement"]) {
    test(`${state}: surviving mode settings links retain their destinations`, async () => {
        await withPage(state, async (page) => {
            expect(await page.getByRole("link", { name: "模式说明", exact: true }).getAttribute("href")).toBe("/settings?section=general&focus=r18");
            expect(await page.getByTitle("切换普通/成人", { exact: true }).getAttribute("href")).toBe("/settings?section=general&focus=r18");
        });
    });

    test(`${state}: ordinary dock does not claim adult mode or show restriction guidance`, async () => {
        await withPage(state, async (page) => {
            const dock = page.getByTestId("ws-creation-dock");
            expect(await dock.innerText()).toContain("内容模式 普通");
            expect(await dock.innerText()).not.toContain("成人模式：");
            expect(await page.getByTestId("generation-failure-enable-r18").count()).toBe(0);
        });
    });

    test(`${state}: mode switch works immediately without a policy confirmation`, async () => {
        await withPage(state, async (page) => {
            const adult = page.getByTestId("content-mode-a-adult");
            await adult.click();
            expect(await page.getByTestId("content-mode-confirm").count()).toBe(0);
            expect(await adult.getAttribute("aria-pressed")).toBe("true");
            await page.getByTestId("content-mode-a-ordinary").click();
            expect(await adult.getAttribute("aria-pressed")).toBe("false");
        });
    });
}

for (const state of ["missing", "replacement", "installed", "reinstalled"]) {
    const restricted = state === "installed" || state === "reinstalled";

    for (const code of ["moderation_input", "moderation_reference", "moderation_output", "r18_context_required", "route_guard_adult"]) {
        test(`${state}: ${code} retry follows the physical policy without changing account mode`, async () => {
            await withPage(state, async (page) => {
                await page.getByRole("link", { name: "Open retry", exact: true }).click();
                await page.getByLabel("Failure code", { exact: true }).selectOption(code);
                const guards = JSON.parse(await page.getByTestId("retry-guards").innerText());
                expect({
                    blocked: guards.blocked, bulkBlocked: guards.bulkBlocked, taskBlocked: guards.taskBlocked,
                    fingerprintBlocked: guards.fingerprintBlocked, missingInputBlocked: guards.missingInputBlocked,
                    unchangedBlocked: guards.unchangedBlocked, category: guards.category,
                    retryable: guards.retryable, automaticBlocked: guards.automaticBlocked,
                }).toEqual({
                    blocked: restricted, bulkBlocked: restricted, taskBlocked: restricted,
                    fingerprintBlocked: restricted, missingInputBlocked: restricted, unchangedBlocked: restricted,
                    category: code, retryable: false, automaticBlocked: restricted,
                });
                const notice = page.locator(".generation-failure-notice");
                expect(await notice.getByTestId("generation-failure-retry-blocked").count()).toBe(restricted ? 1 : 0);
                if (restricted) {
                    expect(await notice.getByTestId("generation-failure-retry-blocked").isDisabled()).toBe(true);
                    await page.getByLabel("Prompt", { exact: true }).fill("edited prompt");
                    expect(JSON.parse(await page.getByTestId("retry-guards").innerText()).blocked).toBe(false);
                } else {
                    expect(await notice.innerText()).not.toContain("请先修改提示词或参考");
                    expect(await notice.innerText()).not.toContain("切换到成人模式");
                    expect(await notice.innerText()).not.toContain("需成人");
                }
                await notice.getByRole("button", { name: restricted ? "新建尝试" : "重新生成", exact: true }).click();
                expect(await page.getByTestId("retry-attempts").innerText()).toBe("1");
                await page.getByLabel("Prompt", { exact: true }).fill("original prompt");
                await page.getByLabel("Reference", { exact: true }).fill("resource:replacement");
                expect(JSON.parse(await page.getByTestId("retry-guards").innerText()).blocked).toBe(false);
                await notice.getByRole("button", { name: restricted ? "新建尝试" : "重新生成", exact: true }).click();
                expect(await page.getByTestId("retry-attempts").innerText()).toBe("2");
                expect(await page.getByTestId("content-mode-a-ordinary").getAttribute("aria-pressed")).toBe("true");
            });
        });
    }

    test(`${state}: changed content never bypasses unconfirmed submission protection`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open retry", exact: true }).click();
            await page.getByLabel("Unconfirmed submission", { exact: true }).check();
            await page.getByLabel("Prompt", { exact: true }).fill("edited prompt");
            const guards = JSON.parse(await page.getByTestId("retry-guards").innerText());
            expect({ stage: guards.stage, metadataStage: guards.metadataStage, blocked: guards.blocked, bulkBlocked: guards.bulkBlocked, taskBlocked: guards.taskBlocked })
                .toEqual({ stage: "submission_unknown", metadataStage: "submission_unknown", blocked: true, bulkBlocked: true, taskBlocked: true });
            const notice = page.locator(".generation-failure-notice");
            expect(await notice.getByRole("button", { name: /重新生成|新建尝试/ }).count()).toBe(0);
            await notice.getByRole("button", { name: "查看原任务", exact: true }).click();
            expect(await page.getByTestId("retry-details").innerText()).toBe("1");
            expect(await page.getByTestId("retry-attempts").innerText()).toBe("0");
        });
    });

    test(`${state}: technical failures and explicit disabled state keep their retry semantics`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open retry", exact: true }).click();
            const notice = page.locator(".generation-failure-notice");
            for (const code of ["auth", "quota_user", "invalid_params", "submission_uncertain", "timeout", "download_failed", "canvas_conflict"]) {
                await page.getByLabel("Failure code", { exact: true }).selectOption(code);
                const guards = JSON.parse(await page.getByTestId("retry-guards").innerText());
                expect(guards.taskBlocked).toBe(true);
                expect(guards.automaticBlocked).toBe(true);
                expect(await notice.getByRole("button", { name: /重新生成|新建尝试/ }).count()).toBe(0);
                expect(await notice.getByTestId("generation-failure-enable-r18").count()).toBe(0);
            }
            await page.getByLabel("Failure code", { exact: true }).selectOption("throttled");
            await page.getByLabel("Disable retry", { exact: true }).check();
            expect(await notice.getByRole("button", { name: "重新生成", exact: true }).count()).toBe(0);
            await page.getByLabel("Disable retry", { exact: true }).uncheck();
            await notice.getByRole("button", { name: "重新生成", exact: true }).click();
            expect(await page.getByTestId("retry-attempts").innerText()).toBe("1");
        });
    });

    test(`${state}: settings deep link respects confirmation policy without changing the account`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "模式说明", exact: true }).click();
            const pane = page.getByTestId("r18-settings-pane");
            await pane.waitFor();
            expect(await page.getByTestId("r18-settings-status").innerText()).toBe("普通");
            expect(await page.getByTestId("r18-settings-confirm").count()).toBe(restricted ? 1 : 0);
            if (restricted) {
                await page.getByTestId("r18-settings-confirm-enable").click();
                expect(await page.getByTestId("r18-settings-status").innerText()).toBe("成人");
            } else {
                expect(await pane.innerText()).not.toContain("确认闸");
            }
            expect(await pane.getByRole("link", { name: "应用市场", exact: true }).count()).toBe(1);
        });
    });

    test(`${state}: catalog category follows policy and responds to same-tab mode changes`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open catalog", exact: true }).click();
            await page.getByText("Ordinary workflow", { exact: true }).waitFor();
            const filter = page.getByRole("button", { name: "成人 1", exact: true });
            expect(await filter.count()).toBe(restricted ? 0 : 1);
            expect(await page.getByText("Classified workflow", { exact: true }).count()).toBe(restricted ? 0 : 1);
            await page.getByTestId("content-mode-a-adult").click();
            if (restricted) await page.getByTestId("content-mode-confirm-enable").click();
            await filter.click();
            expect(await page.getByText("Classified workflow", { exact: true }).count()).toBe(1);
            expect(await page.getByText("Ordinary workflow", { exact: true }).count()).toBe(0);
            await page.getByTestId("content-mode-a-ordinary").click();
            if (restricted) await page.getByText("Ordinary workflow", { exact: true }).waitFor();
            expect(await filter.count()).toBe(restricted ? 0 : 1);
            expect(await page.getByText("Classified workflow", { exact: true }).count()).toBe(restricted ? 0 : 1);
            expect(await page.getByText("Ordinary workflow", { exact: true }).count()).toBe(restricted ? 1 : 0);
        });
    });

    test(`${state}: media reference availability agrees with its status and opens when allowed`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open gallery", exact: true }).click();
            const pool = page.getByTestId("creation-studio-media-pool");
            const card = pool.getByRole("listitem");
            await card.waitFor();
            expect(await card.getAttribute("data-locked")).toBe(restricted ? "1" : "0");
            expect((await pool.innerText()).includes("成人内容已锁定")).toBe(restricted);
            if (!restricted) {
                await card.click();
                expect(await page.getByTestId("asset-destination").innerText()).toBe("?focus=classified-reference");
                expect(await page.getByTestId("content-mode-a-ordinary").getAttribute("aria-pressed")).toBe("true");
            }
        });
    });

    test(`${state}: unmatched pose search has neutral recovery guidance`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open gallery", exact: true }).click();
            const gallery = page.getByTestId("pose-gallery-surface");
            await gallery.getByRole("searchbox", { name: "检索姿势" }).fill("no-such-pose-fixture");
            await gallery.getByText(/当前筛选下没有/).waitFor();
            expect(await gallery.innerText()).not.toContain("成人体系需切换成人模式");
            await gallery.getByRole("searchbox", { name: "检索姿势" }).fill("");
            await gallery.getByRole("listitem").first().waitFor();
        });
    });

    test(`${state}: dual-mode details explain selection without promising content restrictions`, async () => {
        await withPage(state, async (page) => {
            if (restricted) {
                await page.getByTestId("content-mode-a-adult").click();
                await page.getByTestId("content-mode-confirm-enable").click();
            }
            await page.getByRole("link", { name: "Open catalog", exact: true }).click();
            await page.getByText("Ordinary workflow", { exact: true }).click();
            const mode = page.getByRole("group", { name: "内容模式", exact: true });
            await mode.waitFor();
            expect(await mode.innerText()).not.toContain("软隐藏");
            expect(await mode.innerText()).toContain("本次生成");
            await mode.getByRole("button", { name: "成人", exact: true }).click();
            expect(await page.getByTestId("content-mode-a-adult").getAttribute("aria-pressed")).toBe(String(restricted));
            await mode.getByRole("button", { name: "普通", exact: true }).click();
        });
    });

    test(`${state}: classified details do not claim a required account mode`, async () => {
        await withPage(state, async (page) => {
            await page.getByTestId("content-mode-a-adult").click();
            if (restricted) await page.getByTestId("content-mode-confirm-enable").click();
            await page.getByRole("link", { name: "Open catalog", exact: true }).click();
            await page.getByText("Classified workflow", { exact: true }).click();
            await page.getByRole("button", { name: "运行此应用", exact: true }).waitFor();
            expect(await page.locator(".toiv-app-drawer").innerText()).not.toContain("须保持成人模式开启才能运行");
        });
    });

    test(`${state}: pose availability agrees with its status`, async () => {
        await withPage(state, async (page) => {
            await page.getByRole("link", { name: "Open gallery", exact: true }).click();
            const gallery = page.getByTestId("pose-gallery-surface");
            await gallery.waitFor();
            const system = gallery.getByRole("tab", { name: "双人缠绵", exact: true });
            expect(await system.count()).toBe(restricted ? 0 : 1);
            expect((await gallery.innerText()).includes("成人体系已隐藏")).toBe(restricted);
            if (!restricted) {
                await system.click();
                expect(await system.getAttribute("aria-selected")).toBe("true");
                expect(await page.getByTestId("content-mode-a-ordinary").getAttribute("aria-pressed")).toBe("true");
            }
        });
    });
}

for (const state of ["installed", "reinstalled"]) {
    test(`${state}: policy confirmation is named and switching remains usable`, async () => {
        await withPage(state, async (page) => {
            const adult = page.getByTestId("content-mode-a-adult");
            await adult.click();
            const dialog = page.getByRole("alertdialog", { name: /确认切换/ });
            await dialog.waitFor();
            await dialog.getByTestId("content-mode-confirm-enable").click();
            expect(await adult.getAttribute("aria-pressed")).toBe("true");
            await page.getByTestId("content-mode-a-ordinary").click();
            expect(await adult.getAttribute("aria-pressed")).toBe("false");
        });
    });
}
