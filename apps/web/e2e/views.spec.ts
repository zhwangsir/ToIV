import { test, expect } from "@playwright/test";

/**
 * 9 视图可达性测试
 * - 未登录态下访问每个 view 参数
 * - 验证页面加载成功,无 Application error / 500
 * - 截图保存到 test-results/{viewName}.png
 * - 若重定向到登录页,记录为"重定向到登录"
 */

const VIEWS = [
  "assistant",
  "image",
  "video",
  "audio",
  "fusion",
  "library",
  "models",
  "backlot",
  "dub",
  "train",
  "canvas",
  "admin",
] as const;

type ViewName = (typeof VIEWS)[number];

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "Something went wrong",
  "TypeError",
  "ReferenceError",
  "Cannot read",
  "is not defined",
];

for (const view of VIEWS) {
  test.describe(`view: ${view}`, () => {
    test(`${view} 视图可达`, { tag: "@views" }, async ({ page }) => {
      const startTime = Date.now();
      const response = await page.goto(`/?view=${view}`, {
        waitUntil: "domcontentloaded",
      });

      // 响应必须存在
      expect(response, `${view} 响应不应为空`).not.toBeNull();
      const status = response?.status() ?? 0;

      // 等待 networkidle（15s 超时,失败也继续）
      try {
        await page.waitForLoadState("networkidle", { timeout: 15000 });
      } catch {
        // dev 模式下 networkidle 可能超时,不强制失败
      }

      const finalUrl = page.url();
      const redirectedToLogin = /\/login/.test(finalUrl);

      // 截图（即使失败也尝试保存）
      try {
        await page.screenshot({
          path: `test-results/view-${view}.png`,
          fullPage: true,
        });
      } catch {
        // 截图失败忽略
      }

      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");

      const errorFound = ERROR_PATTERNS.some((p) =>
        bodyText.toLowerCase().includes(p.toLowerCase()),
      );

      // 期望:状态码非 5xx 且无错误文案
      // 如果重定向到登录页,记录但不视为失败
      if (redirectedToLogin) {
        test.info().annotations.push({
          type: "redirect",
          description: `重定向到登录页: ${finalUrl}`,
        });
        expect(status, `${view} 重定向前状态码应非 5xx`).toBeLessThan(500);
        return;
      }

      // 状态码必须 2xx
      expect(status, `${view} 状态码应为 2xx`).toBeGreaterThanOrEqual(200);
      expect(status, `${view} 状态码应为 2xx/3xx`).toBeLessThan(400);

      // 不应包含错误文案
      expect(errorFound, `${view} 不应包含错误文案`).toBe(false);

      const duration = Date.now() - startTime;
      test.info().annotations.push({
        type: "duration",
        description: `${duration}ms`,
      });
    });
  });
}

// 兜底:确保至少一个 test 文件存在
test("view suite smoke", async () => {
  expect(VIEWS.length).toBe(12);
});
