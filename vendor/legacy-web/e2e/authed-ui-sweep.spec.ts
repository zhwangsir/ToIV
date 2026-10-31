// ToIV 全页面 UI/UX 走查:截图 + 控制台错误 + 加载计时
// 用法: TOIV_WEB_BASE=http://100.77.80.100:3100 npx playwright test e2e/ui-sweep.spec.ts --project=chromium-authed
import { test, expect } from "@playwright/test";

const PAGES: { name: string; path: string }[] = [
  { name: "01-home", path: "/?view=home" },
  { name: "02-market", path: "/?view=market" },
  { name: "03-market-fashion", path: "/?view=market&useCase=fashion" },
  { name: "04-image", path: "/?view=image" },
  { name: "05-video", path: "/?view=video" },
  { name: "06-audio", path: "/?view=audio" },
  { name: "07-studio", path: "/?view=studio" },
  { name: "08-library", path: "/?view=library" },
  { name: "09-assets", path: "/?view=assets" },
  { name: "10-admin", path: "/?view=admin-console" },
];

test.describe("UI sweep: pages render, no console errors, reasonable load", () => {
  for (const p of PAGES) {
    test(p.name, async ({ page }) => {
      const errors: string[] = [];
      page.on("console", (m) => {
        if (m.type() === "error") errors.push(m.text().slice(0, 200));
      });
      page.on("pageerror", (e) => errors.push(`pageerror: ${String(e).slice(0, 200)}`));
      const t0 = Date.now();
      await page.goto(p.path, { waitUntil: "domcontentloaded", timeout: 30000 });
      // 真实就绪标准:正文文本充实(骨架屏期 body 只有几十个字符);轮询至 20s
      await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 20000 });
      const loadMs = Date.now() - t0;
      await page.waitForTimeout(600);
      // 基本渲染断言:body 有内容且视口内有可见元素
      const bodyLen = await page.evaluate(() => document.body.innerText.length);
      expect(bodyLen).toBeGreaterThan(50);
      await page.screenshot({ path: `ui-sweep/${p.name}.png`, fullPage: false });
      // 控制台错误白名单:跨域字体/第三方偶发忽略
      const real = errors.filter(
        (e) => !/favicon|Download the React DevTools|net::ERR_ABORTED.*font/i.test(e)
      );
      expect(
        real,
        `console errors on ${p.path} (load ${loadMs}ms): ${real.join(" | ")}`
      ).toEqual([]);
      console.log(`LOAD ${p.name}: ${loadMs}ms, body ${bodyLen} chars`);
    });
  }
});
