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
];

const LANDSCAPE_MOBILE = [
  { name: "mobile-landscape", width: 926, height: 428, label: "手机横屏 (926×428)" },
];

const VIEWS = [
  { path: "/?view=assistant", name: "对话流" },
  { path: "/?view=canvas", name: "画布" },
  { path: "/?view=create", name: "创作" },
  { path: "/?view=library", name: "作品库" },
];

test.describe("ToIV UI Redesign - 响应式测试", () => {
  test.describe.configure({ timeout: 120000 });

  for (const device of [...DEVICES, ...LANDSCAPE_MOBILE]) {
    test(`布局完整性 - ${device.label}`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(`http://localhost:3101/?view=assistant`, { waitUntil: "networkidle" });
      await page.waitForTimeout(2000);

      await page.screenshot({
        path: `test-results/responsive/${device.name}-assistant.png`,
        fullPage: false,
      });

      const isMobile = device.width < 768;
      const isTablet = device.width >= 768 && device.width < 1024;
      const isLandscape = device.width > device.height;

      if (isMobile && !isLandscape) {
        await expect(page.locator(".mobile-menu-toggle")).toBeVisible();
        await expect(page.locator(".app-bottom-nav")).toBeVisible();
      } else {
        await expect(page.locator(".app-sidebar")).toBeVisible();
      }

      if (isMobile && isLandscape && device.height < 500) {
        await expect(page.locator(".app-bottom-nav")).not.toBeVisible();
        await expect(page.locator(".app-sidebar")).toBeVisible();
      }

      await expect(page.locator(".topbar")).toBeVisible();
      await expect(page.locator(".app-main")).toBeVisible();

      const topbarHeight = await page.locator(".topbar").evaluate((el) => (el as HTMLElement).offsetHeight);
      expect(topbarHeight).toBeGreaterThanOrEqual(device.width < 768 ? 44 : 36);
    });
  }

  for (const view of VIEWS) {
    test(`页面渲染 - ${view.name} @ desktop (1440×900)`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`http://localhost:3101${view.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      await page.screenshot({
        path: `test-results/responsive/desktop-${view.name.replace("/", "-")}.png`,
        fullPage: false,
      });

      await expect(page.locator(".app-sidebar")).toBeVisible();
      await expect(page.locator(".topbar")).toBeVisible();
    });

    test(`页面渲染 - ${view.name} @ mobile (390×844)`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`http://localhost:3101${view.path}`, { waitUntil: "networkidle" });
      await page.waitForTimeout(1500);

      await page.screenshot({
        path: `test-results/responsive/mobile-${view.name.replace("/", "-")}.png`,
        fullPage: false,
      });

      await expect(page.locator(".mobile-menu-toggle")).toBeVisible();
      await expect(page.locator(".app-bottom-nav")).toBeVisible();
    });
  }

  test("主题切换功能", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://localhost:3101/?view=assistant", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const themeToggle = page.locator(".theme-toggle").first();
    await expect(themeToggle).toBeVisible();

    const bgBefore = await page.locator("body").evaluate((el) => getComputedStyle(el).backgroundColor);
    await themeToggle.click();
    await page.waitForTimeout(300);
    await themeToggle.click();
    await page.waitForTimeout(300);
    await themeToggle.click();
    await page.waitForTimeout(300);
  });

  test("侧边栏抽屉 - 移动端", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost:3101/?view=assistant", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const menuBtn = page.locator(".mobile-menu-toggle");
    await expect(menuBtn).toBeVisible();

    await menuBtn.click();
    await page.waitForTimeout(300);

    await expect(page.locator(".app-sidebar")).toHaveClass(/is-open/);
    await expect(page.locator(".sidebar-overlay")).toBeVisible();

    await page.screenshot({ path: "test-results/responsive/mobile-sidebar-open.png" });

    await page.locator(".sidebar-overlay").click();
    await page.waitForTimeout(300);
    await expect(page.locator(".app-sidebar")).not.toHaveClass(/is-open/);
  });

  test("触控目标尺寸 - 移动端", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("http://localhost:3101/?view=assistant", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const navItems = page.locator(".app-bottom-nav .bottom-nav-item");
    const count = await navItems.count();
    for (let i = 0; i < count; i++) {
      const box = await navItems.nth(i).boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    const cta = page.locator(".bottom-nav-cta");
    const ctaBox = await cta.boundingBox();
    if (ctaBox) {
      expect(ctaBox.width).toBeGreaterThanOrEqual(44);
      expect(ctaBox.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("横屏模式适配", async ({ page }) => {
    await page.setViewportSize({ width: 926, height: 428 });
    await page.goto("http://localhost:3101/?view=assistant", { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: "test-results/responsive/landscape-mobile.png",
      fullPage: false,
    });

    await expect(page.locator(".app-sidebar")).toBeVisible();
    await expect(page.locator(".mobile-menu-toggle")).not.toBeVisible();
  });

  test("字体大小和间距一致性", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("http://localhost:3101/?view=assistant", { waitUntil: "networkidle" });
    await page.waitForTimeout(1000);

    const bodyStyle = await page.locator("body").evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
      };
    });

    expect(bodyStyle.fontSize).toBe("13px");
    expect(bodyStyle.fontFamily).toContain("Geist");
  });
});
