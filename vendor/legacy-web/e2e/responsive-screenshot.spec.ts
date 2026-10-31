import { test, expect } from "@playwright/test";

const DEVICES = [
  { name: "desktop-xl", width: 1920, height: 1080, label: "大屏桌面 (1920×1080)" },
  { name: "desktop-lg", width: 1440, height: 900, label: "标准大屏 (1440×900)" },
  { name: "desktop-md", width: 1280, height: 800, label: "标准桌面 (1280×800)" },
  { name: "laptop", width: 1024, height: 768, label: "小屏笔记本 (1024×768)" },
  { name: "tablet-landscape", width: 1024, height: 768, label: "平板横屏 (1024×768)" },
  { name: "tablet-portrait", width: 768, height: 1024, label: "平板竖屏 (768×1024)" },
  { name: "mobile-large", width: 428, height: 926, label: "大屏手机 (428×926, iPhone 14 Pro Max)" },
  { name: "mobile-medium", width: 390, height: 844, label: "标准手机 (390×844, iPhone 14)" },
  { name: "mobile-small", width: 375, height: 667, label: "小屏手机 (375×667, iPhone SE)" },
  { name: "mobile-landscape", width: 926, height: 428, label: "手机横屏 (926×428)" },
];

test.describe("ToIV UI Redesign - 响应式截图测试", () => {
  test.describe.configure({ timeout: 180000 });

  for (const device of DEVICES) {
    test(`截图 - ${device.label} - 对话流`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      const response = await page.goto(`/?view=assistant`, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(3000);

      await page.screenshot({
        path: `test-results/responsive/${device.name}-assistant.png`,
        fullPage: false,
      });

      console.log(`✓ ${device.label}: ${response?.status() || 'unknown'}`);
    });
  }

  test("主题切换", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/responsive/theme-light.png" });

    const themeToggle = page.locator(".theme-toggle").first();
    if (await themeToggle.isVisible().catch(() => false)) {
      await themeToggle.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "test-results/responsive/theme-dark.png" });

      await themeToggle.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "test-results/responsive/theme-auto.png" });
    }
  });

  test("模式切换", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=canvas", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/responsive/mode-canvas.png" });

    // ModeSwitcher 组件已随 legacy CSS 清理移除;工作室视图直接经 URL 进入
    await page.goto("/?view=studio", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);
    await page.screenshot({ path: "test-results/responsive/mode-studio.png" });
  });

  test("移动端底部导航「更多」抽屉", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(2000);

    await page.screenshot({ path: "test-results/responsive/mobile-closed.png" });

    // W0 后主导航为底部导航:点击「更多」按钮打开抽屉后截图
    const moreBtn = page.locator('.app-bottom-nav .bottom-nav-item[aria-label="更多"]');
    if (await moreBtn.isVisible().catch(() => false)) {
      await moreBtn.click();
      await page.waitForTimeout(500);
      await page.screenshot({ path: "test-results/responsive/mobile-sidebar-open.png" });
    }
  });
});
