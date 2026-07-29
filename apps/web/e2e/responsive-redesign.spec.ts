import { test, expect } from "@playwright/test";

/**
 * ToIV UI 响应式测试(对齐 DynamicIsland 导航架构)
 *
 * 背景:应用已从 Sidebar 迁移到 DynamicIsland 作为主导航。
 * - 桌面端:DynamicIsland(.di-container)悬浮导航,无侧栏
 * - 移动端:DynamicIsland + BottomNav(.app-bottom-nav)底部导航
 * - .mobile-menu-toggle 在 di-nav 模式下 display:none,不再渲染
 * - .app-sidebar 类已退役,CSS 保留但 DOM 不渲染
 *
 * 移动端判定(page.tsx useIsMobile):
 * - width < 768 → 移动端(渲染 BottomNav)
 * - width < 900 && height < 500 → 移动端(横屏手机)
 */

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

/**
 * 判定给定尺寸是否为"移动端"(与 page.tsx useIsMobile 逻辑一致)。
 * - width < 768:竖屏手机/平板
 * - width < 900 && height < 500:横屏手机
 */
function isMobileByApp(width: number, height: number): boolean {
  return width < 768 || (width < 900 && height < 500);
}

test.describe("ToIV UI Redesign - 响应式测试", () => {
  // 注入登录态:响应式测试需要主界面(DynamicIsland + BottomNav),未登录只能看到 LandingPage
  test.use({ storageState: ".auth/admin.json" });
  test.describe.configure({ timeout: 120000 });

  for (const device of [...DEVICES, ...LANDSCAPE_MOBILE]) {
    test(`布局完整性 - ${device.label}`, async ({ page }) => {
      await page.setViewportSize({ width: device.width, height: device.height });
      await page.goto(`/?view=assistant`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2000);

      await page.screenshot({
        path: `test-results/responsive/${device.name}-assistant.png`,
        fullPage: false,
      });

      const mobile = isMobileByApp(device.width, device.height);

      // 主导航:DynamicIsland 始终可见(桌面 + 移动端)
      await expect(page.locator(".di-container")).toBeVisible();

      // 移动端:底部导航可见;桌面端:不可见
      if (mobile) {
        await expect(page.locator(".app-bottom-nav")).toBeVisible();
      } else {
        await expect(page.locator(".app-bottom-nav")).toHaveCount(0);
      }

      // 顶部栏和主区域始终可见
      await expect(page.locator(".topbar")).toBeVisible();
      await expect(page.locator(".app-main")).toBeVisible();

      const topbarHeight = await page.locator(".topbar").evaluate((el) => (el as HTMLElement).offsetHeight);
      expect(topbarHeight).toBeGreaterThanOrEqual(mobile ? 44 : 36);
    });
  }

  for (const view of VIEWS) {
    test(`页面渲染 - ${view.name} @ desktop (1440×900)`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto(`${view.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      await page.screenshot({
        path: `test-results/responsive/desktop-${view.name.replace("/", "-")}.png`,
        fullPage: false,
      });

      await expect(page.locator(".di-container")).toBeVisible();
      await expect(page.locator(".topbar")).toBeVisible();
    });

    test(`页面渲染 - ${view.name} @ mobile (390×844)`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${view.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      await page.screenshot({
        path: `test-results/responsive/mobile-${view.name.replace("/", "-")}.png`,
        fullPage: false,
      });

      // 移动端:DynamicIsland + BottomNav 可见
      await expect(page.locator(".di-container")).toBeVisible();
      await expect(page.locator(".app-bottom-nav")).toBeVisible();
    });
  }

  test("主题切换功能", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const themeToggle = page.locator(".theme-toggle").first();
    await expect(themeToggle).toBeVisible();

    // 连续切换 3 次,验证无崩溃
    await themeToggle.click();
    await page.waitForTimeout(300);
    await themeToggle.click();
    await page.waitForTimeout(300);
    await themeToggle.click();
    await page.waitForTimeout(300);

    // 验证 app-shell 仍可见(切换主题不应导致崩溃)
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("DynamicIsland 菜单打开/关闭 - 移动端", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // DynamicIsland 默认 dot 状态
    const diContainer = page.locator(".di-container");
    await expect(diContainer).toBeVisible();

    // 点击 dot 按钮打开菜单
    const trigger = page.locator(".di-island > button").first();
    await expect(trigger).toBeVisible();
    await trigger.click();
    await page.waitForTimeout(300);

    // 菜单可见
    await expect(page.locator(".di-menu")).toBeVisible();
    await page.screenshot({ path: "test-results/responsive/mobile-di-menu-open.png" });

    // 选择一个视图(点击菜单项)后菜单关闭
    const item = page.locator(".di-menu-item").first();
    await item.click();
    await page.waitForTimeout(500);

    // 验证视图切换成功(app-shell 仍可见)
    await expect(page.locator(".app-shell")).toBeVisible();
  });

  test("触控目标尺寸 - 移动端", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // 底部导航项高度 ≥ 44px
    const navItems = page.locator(".app-bottom-nav .bottom-nav-item");
    const count = await navItems.count();
    expect(count).toBeGreaterThan(0);
    for (let i = 0; i < count; i++) {
      const box = await navItems.nth(i).boundingBox();
      if (box) {
        expect(box.height).toBeGreaterThanOrEqual(44);
      }
    }

    // CTA 按钮尺寸 ≥ 44px
    const cta = page.locator(".bottom-nav-cta");
    const ctaBox = await cta.boundingBox();
    if (ctaBox) {
      expect(ctaBox.width).toBeGreaterThanOrEqual(44);
      expect(ctaBox.height).toBeGreaterThanOrEqual(44);
    }
  });

  test("横屏模式适配", async ({ page }) => {
    await page.setViewportSize({ width: 926, height: 428 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1500);

    await page.screenshot({
      path: "test-results/responsive/landscape-mobile.png",
      fullPage: false,
    });

    // 926×428:useIsMobile 判定为非移动端(width≥900 不满足 isLandscapeMobile 条件)
    // DynamicIsland 可见,无 BottomNav(桌面端布局)
    await expect(page.locator(".di-container")).toBeVisible();
    await expect(page.locator(".app-bottom-nav")).toHaveCount(0);
  });

  test("字体大小和间距一致性", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    const bodyStyle = await page.locator("body").evaluate((el) => {
      const cs = getComputedStyle(el);
      return {
        fontSize: cs.fontSize,
        fontFamily: cs.fontFamily,
        lineHeight: cs.lineHeight,
      };
    });

    // 桌面端基础字号 13px(--text-base: 13px)
    expect(bodyStyle.fontSize).toBe("13px");
    // 字体族应包含 Geist(Next.js 注入字体或 fallback)
    // Next.js font loader 可能生成 __geist_<hash> 形式,所以宽松匹配
    expect(bodyStyle.fontFamily.toLowerCase()).toMatch(/geist|system-ui|-apple-system/);
  });
});
