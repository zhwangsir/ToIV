// 作品库 P0 真机验证:来源筛选/重试入口/元信息角标/灯箱快捷键
import { test, expect } from "@playwright/test";

// 隧道(TS 跨省 ~37KB/s)下全局放宽:导航 60s / 动作 30s
test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

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

test("library P3: use-as-input carries work into studio slot", async ({ page }) => {
  test.setTimeout(150000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });

  // 挑一张有产物的图像卡 → hover「用作输入」→ 跳图片生成台
  const card = page
    .locator(".lib-card:not(.lib-folder-card)")
    .filter({ has: page.locator(".lib-thumb img") })
    .first();
  await card.hover();
  await card.getByRole("button", { name: /^用作输入: / }).click();
  // 生成台挂载后:文生图无图槽(暂存保留),切到「图生图」→ 自动填入 + 提示
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
  await page.getByText("图生图", { exact: true }).first().click();
  await expect(page.getByText(/已填入参考图/).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "ui-sweep/library-p3-use-as-input.png" });
});

test("remix link: open shared link imports params into studio", async ({ page }) => {
  test.setTimeout(150000);
  // 取一个真实完成的 txt2img 作业构造同款链接(与 lib 同构编码,不依赖 window)
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const res = await page.request.get("/api/jobs?limit=5&status=done&kind=txt2img", {
    headers: { Authorization: `Bearer ${token}` },
  });
  const body = await res.json();
  const jobs = (Array.isArray(body) ? body : (body.jobs ?? [])) as { id: string; kind: string; prompt: string; seed: number }[];
  const job = jobs.find((j) => (j.prompt ?? "").trim());
  if (!job) { console.log("REMIX_E2E_SKIP: no done txt2img with prompt"); return; } // 无可用作业时跳过(环境性)
  console.log("REMIX_E2E_JOB:", job.id, job.kind);
  const { buildRemixPayload, encodeRemix } = await import("../lib/remixLink");
  const payload = buildRemixPayload(job as never);
  const link = `/?view=image&remix=${encodeRemix(payload)}`;
  await page.goto(link, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });
  await expect(page.getByText(/同款参数已导入|同款提示词已导入/).first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "ui-sweep/remix-import.png" });
});

test("boards: list / detail / add work via picker", async ({ page }) => {
  test.setTimeout(150000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, { timeout: 60000 });

  // 板列表:e2e 验证板(API 预建)可见
  await page.getByRole("button", { name: "画板" }).click();
  await expect(page.locator(".lib-board-card").first()).toBeVisible({ timeout: 30000 });
  await page.screenshot({ path: "ui-sweep/library-boards.png" });

  // 打开板详情(空板提示)+ 返回
  await page.locator(".lib-board-card").first().locator(".lib-thumb-hit").click();
  await expect(page.locator(".lib-breadcrumb-current")).toBeVisible({ timeout: 15000 });
  await page.getByRole("button", { name: "全部画板" }).click();

  // 回作品库 → hover 成功卡「移入画板」→ 选择器出现
  await page.locator(".lib-breadcrumb-back").click();
  const card = page
    .locator(".lib-card:not(.lib-folder-card)")
    .filter({ has: page.locator(".lib-thumb img, .lib-thumb video") })
    .first();
  await card.hover();
  await card.getByRole("button", { name: /^移入画板: / }).click();
  await expect(page.locator(".lib-board-picker")).toBeVisible({ timeout: 20000 });
  // 选「e2e 验证板」→ toast 成功
  await page.locator(".lib-board-picker").getByRole("button", { name: /e2e 验证板/ }).click();
  await expect(page.getByText(/已移入画板|已在画板/).first()).toBeVisible({ timeout: 20000 });
});
