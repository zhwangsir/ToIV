const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');

const DEVICES = [
  { name: "desktop-xl", width: 1920, height: 1080, label: "大屏桌面 1920×1080" },
  { name: "desktop-lg", width: 1440, height: 900, label: "标准大屏 1440×900" },
  { name: "desktop-md", width: 1280, height: 800, label: "标准桌面 1280×800" },
  { name: "laptop", width: 1024, height: 768, label: "小屏笔记本 1024×768" },
  { name: "tablet-landscape", width: 1024, height: 768, label: "平板横屏 1024×768" },
  { name: "tablet-portrait", width: 768, height: 1024, label: "平板竖屏 768×1024" },
  { name: "mobile-large", width: 428, height: 926, label: "大屏手机 iPhone 14 Pro Max" },
  { name: "mobile-medium", width: 390, height: 844, label: "标准手机 iPhone 14" },
  { name: "mobile-small", width: 375, height: 667, label: "小屏手机 iPhone SE" },
  { name: "mobile-landscape", width: 926, height: 428, label: "手机横屏 926×428" },
];

const RESULTS_DIR = path.join(__dirname, '..', 'test-results', 'responsive');

async function main() {
  fs.mkdirSync(RESULTS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  console.log('🔍 导航到首页...');
  await page.goto('http://localhost:3101/?view=assistant', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);

  const report = [];

  for (const device of DEVICES) {
    console.log(`\n📱 测试 ${device.label}...`);
    await page.setViewportSize({ width: device.width, height: device.height });
    await page.waitForTimeout(800);

    const screenshotPath = path.join(RESULTS_DIR, `${device.name}.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    const metrics = await page.evaluate(() => {
      const sidebar = document.querySelector('.app-sidebar');
      const topbar = document.querySelector('.topbar');
      const bottomNav = document.querySelector('.app-bottom-nav');
      const menuToggle = document.querySelector('.mobile-menu-toggle');
      const modeSwitcher = document.querySelector('.mode-switcher');
      const body = document.body;

      const sidebarStyle = sidebar ? getComputedStyle(sidebar) : null;
      const bottomNavStyle = bottomNav ? getComputedStyle(bottomNav) : null;
      const menuToggleStyle = menuToggle ? getComputedStyle(menuToggle) : null;

      return {
        windowWidth: window.innerWidth,
        windowHeight: window.innerHeight,
        hasSidebar: !!sidebar,
        sidebarVisible: sidebarStyle ? sidebarStyle.display !== 'none' && sidebarStyle.transform !== 'translateX(-100%)' && getComputedStyle(sidebar).getPropertyValue('width') !== '0px' : false,
        sidebarWidth: sidebarStyle ? sidebarStyle.width : '0px',
        hasTopbar: !!topbar,
        topbarHeight: topbar ? topbar.offsetHeight : 0,
        bottomNavVisible: bottomNavStyle ? bottomNavStyle.display !== 'none' : false,
        menuToggleVisible: menuToggleStyle ? menuToggleStyle.display !== 'none' : false,
        bodyBg: getComputedStyle(body).backgroundColor,
        bodyFontSize: getComputedStyle(body).fontSize,
        overflowX: getComputedStyle(body).overflowX,
        modeSwitcherVisible: modeSwitcher ? getComputedStyle(modeSwitcher).display !== 'none' : false,
      };
    });

    const issues = [];

    const isMobile = device.width < 768;
    const isLandscape = device.width > device.height && device.height < 500;

    if (isMobile && !isLandscape) {
      if (!metrics.bottomNavVisible) issues.push('❌ 移动端未显示底部导航');
      if (!metrics.menuToggleVisible) issues.push('❌ 移动端未显示汉堡菜单');
      if (metrics.sidebarVisible) issues.push('❌ 移动端侧边栏应默认隐藏');
    } else {
      if (!metrics.sidebarVisible && device.width >= 768) issues.push('⚠️ 桌面/平板端侧边栏未正常显示');
      if (metrics.bottomNavVisible && !isLandscape) issues.push('⚠️ 非移动端显示了底部导航');
      if (metrics.menuToggleVisible && device.width >= 768) issues.push('⚠️ 非移动端显示了汉堡菜单');
    }

    if (isLandscape) {
      if (metrics.bottomNavVisible) issues.push('❌ 横屏模式应隐藏底部导航');
      if (!metrics.sidebarVisible) issues.push('❌ 横屏模式应显示侧边栏');
    }

    if (metrics.topbarHeight < 36) issues.push(`⚠️ 顶栏高度过小: ${metrics.topbarHeight}px`);

    const passed = issues.filter(i => i.startsWith('❌')).length === 0;
    report.push({
      device: device.label,
      name: device.name,
      metrics,
      issues,
      passed,
      screenshot: screenshotPath,
    });

    console.log(`   ${passed ? '✅' : '❌'} ${passed ? '通过' : '有问题'}`);
    issues.forEach(i => console.log(`      ${i}`));
  }

  await browser.close();

  console.log('\n' + '='.repeat(60));
  console.log('📊 响应式测试报告');
  console.log('='.repeat(60));

  let passed = 0, failed = 0;
  report.forEach(r => {
    console.log(`\n${r.device}:`);
    console.log(`   视口: ${r.metrics.windowWidth}×${r.metrics.windowHeight}`);
    console.log(`   侧边栏: ${r.metrics.sidebarVisible ? '显示' : '隐藏'} (${r.metrics.sidebarWidth})`);
    console.log(`   顶栏高度: ${r.metrics.topbarHeight}px`);
    console.log(`   底部导航: ${r.metrics.bottomNavVisible ? '显示' : '隐藏'}`);
    console.log(`   汉堡菜单: ${r.metrics.menuToggleVisible ? '显示' : '隐藏'}`);
    console.log(`   状态: ${r.passed ? '✅ PASS' : '❌ FAIL'}`);
    if (r.passed) passed++; else failed++;
    r.issues.forEach(i => console.log(`      ${i}`));
  });

  console.log('\n' + '-'.repeat(60));
  console.log(`总计: ${passed} 通过, ${failed} 失败`);
  console.log(`截图保存在: ${RESULTS_DIR}`);

  const reportPath = path.join(RESULTS_DIR, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`报告保存到: ${reportPath}`);
}

main().catch(console.error);
