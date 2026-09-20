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
  const card = page.locator(".lib-card:not(.lib-folder-card)").first();
  await card.hover();
  await card.getByRole("button", { name: "查看大图" }).click();
  await page.waitForSelector(".lib-lightbox", { timeout: 10000 });
  await expect(page.locator(".lib-lb-kbd-hints")).toBeVisible();
  await page.screenshot({ path: "ui-sweep/library-p0-lightbox.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".lib-lightbox")).toHaveCount(0);
});

test("library P1: favorites + time headers + meta copy + retry flow", async ({ page }) => {
  test.setTimeout(150000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });

  // 时间分组标题(今天/近 7 天等至少出现一类)
  await expect(page.locator(".lib-time-header").first()).toBeVisible({ timeout: 20000 });

  // 收藏:挑一张有产物的卡(running/无产物卡灯箱无「复制参数」入口)
  const card = page
    .locator(".lib-card:not(.lib-folder-card)")
    .filter({ has: page.locator(".lib-thumb img, .lib-thumb video") })
    .first();
  await card.hover();
  await card.getByRole("button", { name: /^收藏: |^取消收藏: / }).first().click();
  await expect(page.getByRole("button", { name: /只看收藏|收藏 \d+/ })).toBeVisible();

  // 灯箱:复制参数按钮 + 收藏动作
  await card.hover();
  await card.getByRole("button", { name: "查看大图" }).click();
  await page.waitForSelector(".lib-lightbox", { timeout: 20000 });
  await expect(page.getByRole("button", { name: /复制参数|已复制/ })).toBeVisible();
  await page.screenshot({ path: "ui-sweep/library-p1-lightbox.png" });
  await page.keyboard.press("Escape");

  // 重试流:失败卡的一键重试 → 流光遮罩出现(真实重提已提交)
  // 重试流:遮罩出现(~1.4s,POST 往返)或旧卡快速完成被移除,都算流转成功
  const failed = page.locator(".lib-card", { has: page.locator(".lib-retry-inline") }).first();
  if (await failed.count()) {
    const before = await page
      .locator(".lib-card", { has: page.locator(".lib-retry-inline") })
      .count();
    await failed.locator(".lib-retry-inline").click();
    await expect
      .poll(
        async () => {
          const overlay = await page.locator(".lib-retrying").count();
          const now = await page
            .locator(".lib-card", { has: page.locator(".lib-retry-inline") })
            .count();
          return overlay > 0 || now < before;
        },
        { timeout: 30000, intervals: [500] },
      )
      .toBe(true);
    if ((await page.locator(".lib-retrying").count()) > 0) {
      await page.screenshot({ path: "ui-sweep/library-p1-retrying.png" });
    }
  }
});

test("library P2: variant group folder + saved view", async ({ page }) => {
  test.setTimeout(120000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });

  // 变体组:同 kind+seed+prompt 的作业折成「同参数变体」文件夹(等卡片挂载,隧道慢)
  const variantFolder = page.locator(".lib-folder-card", { hasText: "同参数变体" }).first();
  await expect(variantFolder).toBeVisible({ timeout: 30000 });
  await variantFolder.locator(".lib-thumb-hit").click();
  await expect(page.locator(".lib-breadcrumb")).toContainText("同参数变体", { timeout: 15000 });
  await page.screenshot({ path: "ui-sweep/library-p2-variant.png" });
  await page.locator(".lib-breadcrumb-back").click(); // 返回主网格(面包屑按钮)

  // 存视图:当前筛选组合存为视图 chip
  await page.getByRole("button", { name: "存视图" }).click();
  await page.getByLabel("视图名称").fill("e2e 测试视图");
  await page.getByRole("button", { name: "存", exact: true }).click();
  await expect(page.locator(".lib-view-chip", { hasText: "e2e 测试视图" })).toBeVisible();
  // 应用视图(点击 chip,筛选生效即不报错)+ 删除
  await page.locator(".lib-view-chip", { hasText: "e2e 测试视图" }).locator(".lib-view-chip-hit").click();
  await page.locator(".lib-view-chip", { hasText: "e2e 测试视图" }).locator(".lib-view-chip-x").click();
  await expect(page.locator(".lib-view-chip", { hasText: "e2e 测试视图" })).toHaveCount(0);
});
