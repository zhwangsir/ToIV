const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const DEVICES = [
  { name: 'desktop-xl', width: 1920, height: 1080, label: '大屏桌面 (1920×1080)' },
  { name: 'desktop-lg', width: 1440, height: 900, label: '标准大屏 (1440×900)' },
  { name: 'desktop-md', width: 1280, height: 800, label: '小屏桌面 (1280×800)' },
  { name: 'tablet-landscape', width: 1024, height: 768, label: '平板横屏 (1024×768)' },
  { name: 'tablet-portrait', width: 768, height: 1024, label: '平板竖屏 (768×1024)' },
  { name: 'mobile-large', width: 428, height: 926, label: '大屏手机 (428×926, iPhone 14 Pro Max)' },
  { name: 'mobile-medium', width: 390, height: 844, label: '标准手机 (390×844, iPhone 14)' },
  { name: 'mobile-small', width: 375, height: 667, label: '小屏手机 (375×667, iPhone SE)' },
  { name: 'mobile-landscape', width: 926, height: 428, label: '手机横屏 (926×428)' },
];

const VIEWS = [
  { name: 'assistant', label: '对话流' },
  { name: 'canvas', label: '画布' },
  { name: 'create', label: '创作' },
  { name: 'library', label: '作品库' },
];

async function run() {
  const outDir = path.join(__dirname, 'test-results', 'responsive');
  fs.mkdirSync(outDir, { recursive: true });

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const results = [];

  for (const device of DEVICES) {
    console.log(`\n📱 测试设备: ${device.label}`);
    const page = await browser.newPage();
    await page.setViewportSize({ width: device.width, height: device.height });

    const deviceResults = { device: device.label, width: device.width, height: device.height, views: {} };

    for (const view of VIEWS) {
      console.log(`  → 访问 ${view.label}...`);
      try {
        await page.goto(`http://localhost:3101/?view=${view.name}`, { waitUntil: 'networkidle2', timeout: 30000 });
        await page.waitForTimeout(2000);

        const screenshotPath = path.join(outDir, `${device.name}-${view.name}.png`);
        await page.screenshot({ path: screenshotPath, fullPage: false });

        // 检查关键元素
        const checks = await page.evaluate(() => {
          const topbar = document.querySelector('.app-topbar');
          const sidebar = document.querySelector('.app-sidebar');
          const main = document.querySelector('.app-main');
          const bottomNav = document.querySelector('.app-bottom-nav');
          const modeSwitcher = document.querySelector('.mode-switcher');

          return {
            topbarVisible: !!topbar && getComputedStyle(topbar).display !== 'none',
            sidebarVisible: !!sidebar && getComputedStyle(sidebar).display !== 'none' && getComputedStyle(sidebar).transform !== 'matrix(1, 0, 0, 1, -300, 0)',
            mainVisible: !!main,
            bottomNavVisible: !!bottomNav && getComputedStyle(bottomNav).display !== 'none',
            modeSwitcherVisible: !!modeSwitcher && getComputedStyle(modeSwitcher).display !== 'none',
            bodyOverflow: getComputedStyle(document.body).overflow,
            mainHeight: main ? main.offsetHeight : 0,
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
          };
        });

        deviceResults.views[view.name] = { success: true, ...checks, screenshot: screenshotPath };
        console.log(`    ✓ ${view.label} - 顶栏:${checks.topbarVisible} 侧栏:${checks.sidebarVisible} 主内容:${checks.mainVisible} 底部导航:${checks.bottomNavVisible}`);
      } catch (err) {
        deviceResults.views[view.name] = { success: false, error: err.message };
        console.log(`    ✗ ${view.label} - 失败: ${err.message}`);
      }
    }

    results.push(deviceResults);
    await page.close();
  }

  await browser.close();

  // 生成报告
  const reportPath = path.join(outDir, 'report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ timestamp: new Date().toISOString(), results }, null, 2));

  // 生成Markdown报告
  const mdPath = path.join(outDir, 'REPORT.md');
  let md = `# ToIV UI 重构 - 响应式测试报告\n\n`;
  md += `生成时间: ${new Date().toLocaleString('zh-CN')}\n\n`;
  md += `## 测试概览\n\n`;
  md += `| 设备 | 尺寸 | 对话流 | 画布 | 创作 | 作品库 |\n`;
  md += `|------|------|--------|------|------|--------|\n`;

  for (const r of results) {
    const cells = VIEWS.map(v => {
      const view = r.views[v.name];
      return view && view.success ? '✅' : '❌';
    });
    md += `| ${r.device} | ${r.width}×${r.height} | ${cells.join(' | ')} |\n`;
  }

  md += `\n## 详细测试结果\n\n`;
  for (const r of results) {
    md += `### ${r.device} (${r.width}×${r.height})\n\n`;
    for (const view of VIEWS) {
      const v = r.views[view.name];
      md += `#### ${view.label}\n\n`;
      if (v.success) {
        md += `- 状态: ✅ 通过\n`;
        md += `- 顶栏可见: ${v.topbarVisible ? '✅' : '❌'}\n`;
        md += `- 侧栏可见: ${v.sidebarVisible ? '✅' : '❌'}\n`;
        md += `- 主内容可见: ${v.mainVisible ? '✅' : '❌'}\n`;
        md += `- 底部导航可见: ${v.bottomNavVisible ? '✅' : '❌'}\n`;
        md += `- 模式切换器可见: ${v.modeSwitcherVisible ? '✅' : '❌'}\n`;
        md += `- 截图: [${r.device}-${view.name}.png](./${r.device}-${view.name}.png)\n\n`;
      } else {
        md += `- 状态: ❌ 失败\n`;
        md += `- 错误: ${v.error}\n\n`;
      }
    }
  }

  fs.writeFileSync(mdPath, md);
  console.log(`\n📊 测试报告已生成: ${mdPath}`);
  console.log(`📸 截图保存在: ${outDir}`);
}

run().catch(console.error);
