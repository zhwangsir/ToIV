/**
 * UI 优化后关键视图截图(登录态):用于前后对比报告
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.join(process.cwd(), 'e2e', 'screenshots', 'ui-after-final');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

const VIEWS = ['image', 'video', 'library', 'settings', 'models', 'agent-runs'] as const;

test.describe('post-optimization captures', () => {
  for (const view of VIEWS) {
    test(`${view} desktop+mobile`, { tag: '@authed' }, async ({ page }) => {
      await page.goto(`/?view=${view}`, { waitUntil: 'domcontentloaded' });
      try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* dev */ }
      const appShell = page.locator('.app-shell');
      await expect(appShell).toBeVisible({ timeout: 10000 });
      await page.waitForTimeout(1200);

      // Desktop light
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.waitForTimeout(300);
      await page.screenshot({ path: path.join(OUT, `${view}-desktop-light.png`) });

      // Mobile light
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(OUT, `${view}-mobile-light.png`) });

      // Desktop dark
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.evaluate(() => localStorage.setItem('toiv_mode', 'dark'));
      await page.reload({ waitUntil: 'domcontentloaded' });
      try { await page.waitForLoadState('networkidle', { timeout: 10000 }); } catch { /* dev */ }
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(OUT, `${view}-desktop-dark.png`) });
      await page.evaluate(() => localStorage.setItem('toiv_mode', 'light'));
    });
  }
});
