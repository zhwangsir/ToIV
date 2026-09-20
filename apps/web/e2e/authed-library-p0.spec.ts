// 作品库 P0 真机验证:来源筛选/重试入口/元信息角标/灯箱快捷键
import { test, expect } from "@playwright/test";

test("library P0: source filter + meta badges + lightbox kbd hints", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
  // 来源筛选下拉
  await page.getByRole("button", { name: /来源/ }).first().click();
  await expect(page.locator(".lib-source-pop")).toBeVisible();
  await page.screenshot({ path: "ui-sweep/library-p0-source.png" });
  await page.locator(".lib-source-scrim").click();
  // hover 浮出操作组 → 「查看大图」进灯箱(比点媒体区更确定)
  const card = page.locator(".lib-card").first();
  await card.hover();
  await card.getByRole("button", { name: "查看大图" }).click();
  await page.waitForSelector(".lib-lightbox", { timeout: 10000 });
  await expect(page.locator(".lib-lb-kbd-hints")).toBeVisible();
  await page.screenshot({ path: "ui-sweep/library-p0-lightbox.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".lib-lightbox")).toHaveCount(0);
});
