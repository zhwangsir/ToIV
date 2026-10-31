import { test, expect, type Page } from "@playwright/test";

/**
 * web 薄壳深链与 R18 旧链接回归(D-U1=B 选项 A 之后)。
 *
 * 经典引擎台/设置页/作品库/模型页已撤出 web:成人上下文只由 canvas
 * (/studio)的 r18-mode 负责,web 只剩深链重定向与 /nsfw 旧链接不 404。
 * R18 开关 UI、年龄确认弹层与缓存键行为不再是 web 面,原有用例已随壳退役删除。
 */

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "会话已过期",
  "Something went wrong",
];

async function goto(page: Page, path: string) {
  await page.goto(path, { waitUntil: "domcontentloaded" });
  try {
    await page.waitForLoadState("networkidle", { timeout: 15000 });
  } catch {
    /* dev 模式 networkidle 可能超时,不强制中断 */
  }
}

async function expectNoErrorText(page: Page) {
  const bodyText = await page.locator("body").innerText().catch(() => "");
  const errorFound = ERROR_PATTERNS.some((p) =>
    bodyText.toLowerCase().includes(p.toLowerCase()),
  );
  expect(errorFound, "页面不应包含错误文案").toBe(false);
}

test.describe("web 薄壳深链", () => {
  test.use({ storageState: ".auth/admin.json" });

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ".auth/admin.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    const token = await page.evaluate(() =>
      window.localStorage.getItem("toiv_token"),
    );
    await context.close();
    if (!token) {
      test.skip(true, "storageState 中无 token,跳过深链测试");
    }
  });

  test(
    "authed-shell: 图像/视频深链重定向 canvas 创作",
    { tag: "@authed" },
    async ({ page }) => {
      await goto(page, "/?view=image");
      await expect(page).toHaveURL(/\/studio\/create/, { timeout: 15000 });
      await expectNoErrorText(page);

      await goto(page, "/?view=video");
      await expect(page).toHaveURL(/\/studio\/create/, { timeout: 15000 });
      await expectNoErrorText(page);
    },
  );

  test(
    "authed-shell: 作品库深链重定向 canvas 作品库",
    { tag: "@authed" },
    async ({ page }) => {
      await goto(page, "/?view=library");
      await expect(page).toHaveURL(/\/studio\/toiv\/library/, {
        timeout: 15000,
      });
      await expectNoErrorText(page);
    },
  );

  test(
    "authed-shell: /nsfw 旧链接重定向不 404",
    { tag: "@authed" },
    async ({ page }) => {
      await goto(page, "/nsfw");
      await page.waitForURL(/\/$|\?/, { timeout: 10000 }).catch(() => {});
      const bodyText = await page.locator("body").innerText().catch(() => "");
      expect(bodyText).not.toContain("404");
      expect(bodyText).not.toContain("This page could not be found");
    },
  );
});
