/**
 * 灵动岛(CornerNav)显示效果与位置诊断:收起态/展开态/滚动态特写
 */
import { test, expect } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';

const OUT = path.join(process.cwd(), 'e2e', 'screenshots', 'cornernav-diag');
if (!fs.existsSync(OUT)) fs.mkdirSync(OUT, { recursive: true });

test.describe('cornernav diagnosis', () => {
  test('trigger collapsed + expanded + overlap check', { tag: '@authed' }, async ({ page }) => {
    await page.goto('/?view=video', { waitUntil: 'domcontentloaded' });
    try { await page.waitForLoadState('networkidle', { timeout: 15000 }); } catch { /* dev */ }
    await expect(page.locator('.app-shell')).toBeVisible({ timeout: 10000 });
    await page.waitForTimeout(1000);

    await page.setViewportSize({ width: 1440, height: 900 });

    // 1. 收起态触发器特写
    const trigger = page.locator('.cornernav-trigger');
    await expect(trigger).toBeVisible();
    await trigger.screenshot({ path: path.join(OUT, '01-trigger-collapsed.png') });

    // 2. 触发器位置与周边元素重叠检测
    const overlap = await page.evaluate(() => {
      const t = document.querySelector('.cornernav-trigger');
      if (!t) return null;
      const r = t.getBoundingClientRect();
      const below = document.elementFromPoint(r.left + r.width / 2, r.bottom + 8);
      const style = getComputedStyle(t);
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom },
        bg: style.background,
        backdropFilter: style.backdropFilter,
        boxShadow: style.boxShadow,
        zIndex: style.zIndex,
        belowElement: below ? below.className.toString().slice(0, 80) : null,
        belowText: below?.textContent?.slice(0, 40) ?? null,
      };
    });
    console.log('Trigger info:', JSON.stringify(overlap, null, 2));

    // 3. 页面左上区域全景(含页头)
    await page.screenshot({
      path: path.join(OUT, '02-topleft-region.png'),
      clip: { x: 0, y: 0, width: 700, height: 260 },
    });

    // 4. 悬停展开面板
    await trigger.hover();
    await page.waitForTimeout(600);
    await page.screenshot({
      path: path.join(OUT, '03-panel-expanded.png'),
      clip: { x: 0, y: 0, width: 500, height: 700 },
    });

    // 5. 面板样式与位置
    const panel = await page.evaluate(() => {
      const p = document.querySelector('.cornernav-panel');
      const inner = document.querySelector('.cornernav-panel-inner');
      if (!p || !inner) return null;
      const r = inner.getBoundingClientRect();
      const style = getComputedStyle(inner);
      return {
        rect: { x: r.x, y: r.y, w: r.width, h: r.height },
        bg: style.background,
        backdropFilter: style.backdropFilter,
        itemCount: document.querySelectorAll('.cornernav-item').length,
      };
    });
    console.log('Panel info:', JSON.stringify(panel, null, 2));

    // 6. 滚动后触发器位置(检查是否遮挡滚动内容)
    await page.evaluate(() => window.scrollTo(0, 300));
    await page.waitForTimeout(400);
    await page.screenshot({
      path: path.join(OUT, '04-after-scroll.png'),
      clip: { x: 0, y: 0, width: 700, height: 260 },
    });

    // 7. 作品库视图(页头位置不同)
    await page.goto('/?view=library', { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1200);
    await page.screenshot({
      path: path.join(OUT, '05-library-topleft.png'),
      clip: { x: 0, y: 0, width: 700, height: 260 },
    });

    // 8. 暗色模式
    await page.evaluate(() => localStorage.setItem('toiv_mode', 'dark'));
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(1000);
    await page.screenshot({
      path: path.join(OUT, '06-dark-topleft.png'),
      clip: { x: 0, y: 0, width: 700, height: 260 },
    });
  });
});
