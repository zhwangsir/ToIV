/* UI 重构视觉冒烟:登录态逐视图截图 */
import { chromium } from "playwright";
import fs from "fs";

const BASE = "http://localhost:3199";
const OUT = "/tmp/toiv-ui-smoke";
fs.mkdirSync(OUT, { recursive: true });

const views = [
  ["assistant", "对话"],
  ["image", "图片"],
  ["video", "视频"],
  ["audio", "音频"],
  ["studio", "创作"],
  ["avatartalk", "数字人"],
  ["canvas", "画布"],
  ["dub", "译制"],
  ["library", "作品库"],
  ["resources", "资源"],
];

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
const page = await ctx.newPage();

// 登录
const login = await page.request.post(`${BASE}/api/auth/login`, {
  data: { email: "admin", password: "admin123" },
});
const { token } = await login.json();
await page.goto(BASE);
await page.evaluate((t) => localStorage.setItem("toiv_token", t), token);

// 登录页(未登录态)也抓一张
await page.goto(`${BASE}/?view=assistant`);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/00-home.png` });

for (const [key, label] of views) {
  await page.goto(`${BASE}/?view=${key}`);
  await page.waitForTimeout(5000);
  await page.screenshot({ path: `${OUT}/view-${key}.png` });
  console.log(`captured ${label} (${key})`);
}

// 移动档
await page.setViewportSize({ width: 390, height: 844 });
await page.goto(`${BASE}/?view=image`);
await page.waitForTimeout(4000);
await page.screenshot({ path: `${OUT}/mobile-image.png` });

await browser.close();
console.log("done ->", OUT);
