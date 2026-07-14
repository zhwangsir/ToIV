import { test, expect } from "@playwright/test";

/**
 * 首页基础测试
 * - 200 状态码
 * - title 非空
 * - 首屏加载时间 < 5s（dev 模式宽松）
 * - 截图
 */
test.describe("首页基础", () => {
  test("首页返回 200 并有非空 title", async ({ page }) => {
    const startTime = Date.now();
    const response = await page.goto("/", { waitUntil: "domcontentloaded" });

    expect(response, "首页响应不应为空").not.toBeNull();
    expect(response?.status(), "首页状态码应为 200").toBe(200);

    const duration = Date.now() - startTime;
    expect(duration, "首屏加载时间应 < 5s").toBeLessThan(5000);

    await expect(page).toHaveTitle(/\S+/, { timeout: 10000 });

    // 截图
    await page.screenshot({
      path: "test-results/home.png",
      fullPage: true,
    });

    test.info().annotations.push({
      type: "duration",
      description: `${duration}ms`,
    });
  });

  test("首页 HTML 结构基本完整", async ({ page }) => {
    const response = await page.goto("/");
    expect(response?.status()).toBe(200);

    // 应有 body
    await expect(page.locator("body")).toBeVisible();

    // 应有至少一个根容器
    const rootDivs = await page.locator("#__next, #root, [id]").count();
    expect(rootDivs, "应至少有一个根容器").toBeGreaterThan(0);
  });
});
