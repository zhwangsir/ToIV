/**
 * 参数浮板分节修复验证(登录态):截视频生成工作台参数面板
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.join(process.cwd(), 'e2e', 'screenshots', 'params-section-fix');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

test.describe('params panel fix (authed)', () => {
  test('video workbench params sections have spacing', { tag: '@authed' }, async ({ page }) => {
    await page.goto('/?view=video', { waitUntil: 'domcontentloaded' });
    try {
      await page.waitForLoadState('networkidle', { timeout: 15000 });
    } catch { /* dev mode */ }

    // Wait for app shell
    const appShell = page.locator('.app-shell');
    await expect(appShell).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    await page.setViewportSize({ width: 1440, height: 900 });

    // Open params panel if not already open
    const paramsPanel = page.locator('.generate-params');
    const isParamsVisible = await paramsPanel.isVisible().catch(() => false);
    if (!isParamsVisible) {
      const fab = page.locator('.generate-params-fab-btn').first();
      if (await fab.isVisible()) {
        await fab.click();
        await page.waitForTimeout(500);
      }
    }

    // Check params-section styles applied
    const sectionInfo = await page.evaluate(() => {
      const sections = document.querySelectorAll('.params-section');
      const titles = document.querySelectorAll('.params-section-title');
      const fields = document.querySelectorAll('.params-section .ui-field');
      return {
        sectionCount: sections.length,
        titleCount: titles.length,
        fieldCount: fields.length,
        firstSectionGap: sections[0] ? getComputedStyle(sections[0]).gap : null,
        firstSectionDisplay: sections[0] ? getComputedStyle(sections[0]).display : null,
        titleFontSize: titles[0] ? getComputedStyle(titles[0]).fontSize : null,
        titleMargin: titles[0] ? getComputedStyle(titles[0]).margin : null,
        secondSectionBorder: sections[1] ? getComputedStyle(sections[1]).borderTopWidth : null,
        secondSectionPadding: sections[1] ? getComputedStyle(sections[1]).paddingTop : null,
      };
    });
    console.log('Section info:', JSON.stringify(sectionInfo, null, 2));

    // Verify styles are applied
    expect(sectionInfo.sectionCount).toBeGreaterThan(0);
    expect(sectionInfo.firstSectionDisplay).toBe('flex');
    expect(sectionInfo.firstSectionGap).toBe('12px'); // --space-3

    // Full page screenshot
    await page.screenshot({ path: path.join(OUT, 'authed-video-workbench.png') });

    // Close-up of params panel
    if (await paramsPanel.isVisible()) {
      await paramsPanel.screenshot({ path: path.join(OUT, 'authed-params-panel.png') });
    }

    // Mobile viewport
    await page.setViewportSize({ width: 390, height: 844 });
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(OUT, 'authed-video-mobile.png') });
  });
});
