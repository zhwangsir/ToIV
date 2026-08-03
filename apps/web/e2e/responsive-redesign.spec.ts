import { test, expect } from "@playwright/test";

/**
 * ToIV UI 响应式测试(对齐 W0 左侧栏 + 底部导航架构)
 *
 * 背景(W0/W3 UI 重构后):主导航为左侧栏 + 底部导航,DynamicIsland 已退役。
 * - 桌面端(≥1024px):aside.app-sidebar 左侧栏(.app-sidebar-item),底部导航隐藏
 * - 窄屏(<1024px):侧栏隐藏,nav.app-bottom-nav 底部导航(.bottom-nav-item + 「更多」抽屉)
 * - 横屏(height<500 且 landscape):底部导航让位,回到折叠侧栏
 * - 全局顶栏 header.topbar 已移除(--topbar-h: 0px)
 * - W3 退役 create/video/ltxstudio 视图,?view=create 重定向到 ?view=generate
 * - .theme-toggle 已随顶栏移除,原「主题切换功能」用例 fixme 待产品确认
 *
 * 显隐判定(globals.css 断点,组件始终挂载、由 CSS 控制显隐):
 * - width < 1024 且非横屏短高 → 底部导航可见
 * - 其余 → 侧栏可见
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
  { path: "/?view=generate", name: "生成" },
  { path: "/?view=library", name: "作品库" },
];

/**
 * 判定给定尺寸下底部导航是否可见(与 globals.css 断点一致,组件始终挂载由 CSS 控制显隐)。
 * - width < 1024:窄屏,底部导航可见(侧栏隐藏)
 * - height < 500 且横屏:底部导航让位,回到折叠侧栏
 */
function showsBottomNav(width: number, height: number): boolean {
  const landscapeShort = height < 500 && width > height;
  return width < 1024 && !landscapeShort;
}

test.describe("ToIV UI Redesign - 响应式测试", () => {
  // 注入登录态:响应式测试需要主界面(侧栏/底部导航),未登录只能看到 LandingPage
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

      const bottomNav = showsBottomNav(device.width, device.height);

      // 主导航互斥:窄屏底部导航可见,其余尺寸侧栏可见
      if (bottomNav) {
        await expect(page.locator(".app-bottom-nav")).toBeVisible();
        await expect(page.locator(".app-sidebar")).not.toBeVisible();
      } else {
        await expect(page.locator(".app-sidebar")).toBeVisible();
        await expect(page.locator(".app-bottom-nav")).not.toBeVisible();
      }

      // 主区域始终可见(顶栏 header.topbar 已移除)
      await expect(page.locator(".app-main")).toBeVisible();
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

      await expect(page.locator(".app-sidebar")).toBeVisible();
      await expect(page.locator(".app-main")).toBeVisible();
    });

    test(`页面渲染 - ${view.name} @ mobile (390×844)`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`${view.path}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(1500);

      await page.screenshot({
        path: `test-results/responsive/mobile-${view.name.replace("/", "-")}.png`,
        fullPage: false,
      });

      // 窄屏:底部导航可见,侧栏隐藏
      await expect(page.locator(".app-bottom-nav")).toBeVisible();
      await expect(page.locator(".app-sidebar")).not.toBeVisible();
    });
  }

  // W3:.theme-toggle 已随顶栏移除,主题切换 UI 不存在,待产品确认是否恢复后再重写
  test.fixme("主题切换功能", async ({ page }) => {
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

  test("底部导航「更多」抽屉打开/关闭 - 移动端", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1000);

    // 底部导航可见
    const bottomNav = page.locator(".app-bottom-nav");
    await expect(bottomNav).toBeVisible();

    // 点击「更多」按钮打开抽屉
    const moreBtn = bottomNav.locator('.bottom-nav-item[aria-label="更多"]');
    await expect(moreBtn).toBeVisible();
    await moreBtn.click();
    await page.waitForTimeout(300);

    // 抽屉可见
    await expect(page.locator(".sheet.is-open")).toBeVisible();
    await page.screenshot({ path: "test-results/responsive/mobile-more-drawer-open.png" });

    // 选择一个视图(点击抽屉项)后抽屉关闭
    const item = page.locator(".more-nav-item").first();
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

    // 926×428(横屏 height<500):底部导航让位,回到折叠侧栏
    await expect(page.locator(".app-sidebar")).toBeVisible();
    await expect(page.locator(".app-bottom-nav")).not.toBeVisible();
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
