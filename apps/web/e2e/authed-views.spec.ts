import { readFileSync } from "node:fs";

import { test, expect } from "@playwright/test";

/**
 * 登录态视图加载测试 (chromium-authed project)
 *
 * 对 10 个视图,在登录态下:
 * - 访问 /?view={viewName}
 * - 等待 networkidle
 * - 验证无 "Application error" / "500" / "会话已过期" 文案
 * - 验证 app-shell 和灵动岛 .island 可见(2026-08-06 灵动岛重构后主导航为顶部悬浮胶囊)
 * - 验证不是登录页(无"登录"按钮)
 * - 截图保存到 test-results/authed-{viewName}.png
 */

const VIEWS = [
  "assistant",
  "image",
  "video",
  "audio",
  "library",
  "models",
  "backlot",
  "studio",
  "dub",
  "train",
  "canvas",
  "admin",
] as const;

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "会话已过期",
  "Something went wrong",
];

test.describe("登录态视图加载", () => {
  // 前置:确认 storageState 中确实有 token(globalSetup 可能登录失败)。
  // 直接读 .auth/admin.json(Node 侧):走浏览器建页检查会与 fullyParallel 下
  // 的首测试竞争,且重试 worker 冷启动时页面未就绪会误判为无 token。
  test.beforeAll(async () => {
    let token: string | null = null;
    try {
      const state = JSON.parse(readFileSync(".auth/admin.json", "utf-8")) as {
        origins?: { localStorage?: { name: string; value: string }[] }[];
      };
      token =
        state.origins
          ?.flatMap((o) => o.localStorage ?? [])
          .find((i) => i.name === "toiv_token")?.value ?? null;
    } catch {
      token = null;
    }
    if (!token) {
      test.skip(true, "globalSetup 未获取到 token,跳过登录态视图测试");
      return;
    }
  });

  for (const view of VIEWS) {
    test.describe(`authed view: ${view}`, () => {
      test(`${view} 登录态下渲染正常`, { tag: "@authed" }, async ({ page }) => {
        await page.goto(`/?view=${view}`, { waitUntil: "domcontentloaded" });

        // 等待 networkidle(失败不强制中断)
        try {
          await page.waitForLoadState("networkidle", { timeout: 15000 });
        } catch {
          // dev 模式 networkidle 可能超时
        }

        // W0 后 studio(原 dramaStudio 退役,M4 由 studio 替代)也渲染在 app-shell 内(见 page.tsx),统一走通用断言
        // 等待 app-shell 出现(登录态应进入主界面)
        const appShell = page.locator(".app-shell");
        try {
          await expect(appShell).toBeVisible({ timeout: 10000 });
        } catch {
          await page.screenshot({
            path: `test-results/authed-${view}.png`,
            fullPage: true,
          });
          throw new Error(
            `${view}: 登录态下未出现 app-shell(可能 token 失效或重定向到落地页)`,
          );
        }

        // 验证主导航侧栏可见(W0 后为左侧栏,DynamicIsland/顶栏已退役)
        const nav = page.locator(".island");
        await expect(nav, `${view} 侧栏导航应可见`).toBeVisible();

        // 验证不是登录页(无落地页登录表单;exact 避免匹配到"退出登录")
        const landingForm = page.locator(".landing-form");
        const landingFormCount = await landingForm.count();
        expect(landingFormCount, `${view} 登录态下不应有登录表单`).toBe(0);
        const loginBtn = page.getByRole("button", { name: "登录", exact: true });
        const loginBtnCount = await loginBtn.count();
        expect(loginBtnCount, `${view} 登录态下不应有登录按钮`).toBe(0);

        // 验证无错误文案
        const bodyText = await page
          .locator("body")
          .innerText()
          .catch(() => "");
        const errorFound = ERROR_PATTERNS.some((p) =>
          bodyText.toLowerCase().includes(p.toLowerCase()),
        );
        expect(errorFound, `${view} 不应包含错误文案`).toBe(false);

        // 截图
        await page.screenshot({
          path: `test-results/authed-${view}.png`,
          fullPage: true,
        });

        test.info().annotations.push({
          type: "view",
          description: view,
        });
      });
    });
  }
});
