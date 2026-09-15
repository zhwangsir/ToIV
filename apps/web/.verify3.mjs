import { chromium } from "@playwright/test";
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.setDefaultTimeout(30000);
await page.goto("http://100.77.80.100:3100/?view=image", { waitUntil: "domcontentloaded", timeout: 30000 });
await page.waitForTimeout(2000);
if (await page.locator('input[type="password"]').count()) {
  await page.locator('input:not([type="password"])').first().fill("admin");
  await page.locator('input[type="password"]').fill("admin123");
  await page.locator('button[type="submit"]').click();
  await page.waitForTimeout(3000);
  await page.goto("http://100.77.80.100:3100/?view=image", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
}
await page.waitForSelector(".apps-studio", { timeout: 25000 });
await page.waitForTimeout(2500);
console.log("STUDIO OK");
await page.screenshot({ path: "/Users/wangzhenyu/Desktop/ALLProject/ToIV/.regen_tmp/new_studio.png" });
await browser.close();
