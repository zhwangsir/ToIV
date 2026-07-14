import { test, expect, type Page } from "@playwright/test";

/**
 * NSFW 专区 E2E 测试 (登录态)
 *
 * 覆盖:
 * - NsfwView 的 image/video tab 切换 + 推荐清单折叠
 * - NsfwVideoView 的 3 种场景渲染验证(文生视频 / 图生视频 / 口型同步)
 * - 视频参数面板(分辨率 / 时长预设)
 *
 * 前置:
 * - storageState: .auth/admin.json (由 global-setup.ts 写入)
 * - 后端: http://127.0.0.1:8200
 * - 前端: http://localhost:3100
 *
 * 说明:
 * 文件名为 nsfw.spec.ts(非 authed- 前缀),会被 chromium-guest project 拾取。
 * 通过 test.use({ storageState }) 在测试级注入登录态,等效于 authed project。
 */

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "会话已过期",
  "Something went wrong",
];

test.describe("NSFW 专区", () => {
  // 测试级注入登录态(因为文件名非 authed- 前缀,不会被 chromium-authed project 拾取)
  test.use({ storageState: ".auth/admin.json" });

  // 前置:确认 storageState 中确实有 token
  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext({
      storageState: ".auth/admin.json",
    });
    const page = await context.newPage();
    await page.goto("/");
    const token = await page.evaluate(() =>
      window.localStorage.getItem("toiv_token"),
    );
    await context.close();
    if (!token) {
      test.skip(true, "storageState 中无 token,跳过 NSFW 测试");
      return;
    }
  });

  // 辅助:导航到 /nsfw 并等待鉴权完成(banner 出现表示 auth=in)
  async function gotoNsfw(page: Page) {
    await page.goto("/nsfw", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // dev 模式 networkidle 可能超时,不强制中断
    }
    const banner = page.locator(".nsfw-banner");
    try {
      await expect(banner).toBeVisible({ timeout: 10000 });
    } catch {
      const gate = page.locator(".nsfw-gate");
      if (await gate.count()) {
        throw new Error(
          "鉴权失败:NsfwView 显示了登录门(可能 token 失效)",
        );
      }
      throw new Error("NsfwView 主视图未出现(10s 超时)");
    }
  }

  // 辅助:切到视频 tab,等待 NsfwVideoView 渲染
  async function switchToVideo(page: Page) {
    await gotoNsfw(page);
    await page.getByRole("tab", { name: "视频" }).click();
    await expect(page.locator(".nsv-view")).toBeVisible({ timeout: 5000 });
  }

  // ─── 用例 1:页面加载并显示 R18 banner ───
  test(
    "authed-nsfw: 页面加载并显示 R18 banner",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // banner 可见
      await expect(page.locator(".nsfw-banner")).toBeVisible();

      // badge 含 "18+"
      const badge = page.locator(".nsfw-badge");
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("18+");

      // 无错误文案
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const errorFound = ERROR_PATTERNS.some((p) =>
        bodyText.toLowerCase().includes(p.toLowerCase()),
      );
      expect(errorFound, "页面不应包含错误文案").toBe(false);

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-banner.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 2:默认显示图像 tab + CreateView ───
  test(
    "authed-nsfw: 默认显示图像 tab + CreateView",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // tab 容器可见
      await expect(page.locator(".nsfw-tabs")).toBeVisible();

      // 默认 active tab 是"图像"
      const imageTab = page.getByRole("tab", { name: "图像" });
      await expect(imageTab).toHaveAttribute("aria-selected", "true");

      // "视频" tab 未选中
      const videoTab = page.getByRole("tab", { name: "视频" });
      await expect(videoTab).toHaveAttribute("aria-selected", "false");

      // CreateView 容器可见(图像 tab 渲染 <CreateView nsfw />)
      await expect(page.locator(".create-view")).toBeVisible();

      // NsfwVideoView 未渲染
      await expect(page.locator(".nsv-view")).toHaveCount(0);
    },
  );

  // ─── 用例 3:切换到视频 tab 显示 NsfwVideoView ───
  test(
    "authed-nsfw: 切换到视频 tab 显示 NsfwVideoView",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // 点击"视频" tab
      await page.getByRole("tab", { name: "视频" }).click();

      // NsfwVideoView 容器可见
      await expect(page.locator(".nsv-view")).toBeVisible({ timeout: 5000 });

      // CreateView 不再渲染
      await expect(page.locator(".create-view")).toHaveCount(0);

      // 默认场景是"文生视频"
      const t2vTab = page.getByRole("tab", { name: "文生视频" });
      await expect(t2vTab).toHaveAttribute("aria-selected", "true");

      // 提示词输入框可见
      await expect(page.locator("#nsv-positive")).toBeVisible();

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-video-default.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 4:视频场景 tab 切换(3 场景渲染验证)───
  test(
    "authed-nsfw: 视频场景 tab 切换",
    { tag: "@authed" },
    async ({ page }) => {
      await switchToVideo(page);

      // 切到"图生视频" → 图片上传区可见,无音频上传区
      await page.getByRole("tab", { name: "图生视频" }).click();
      await expect(
        page.getByRole("button", { name: /上传参考图/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /上传参考音频/ }),
      ).toHaveCount(0);

      // 切到"口型同步" → 图片 + 音频上传区都可见
      await page.getByRole("tab", { name: "口型同步" }).click();
      await expect(
        page.getByRole("button", { name: /上传参考图/ }),
      ).toBeVisible();
      await expect(
        page.getByRole("button", { name: /上传参考音频/ }),
      ).toBeVisible();

      // 切回"文生视频" → 无上传区,只有提示词框
      await page.getByRole("tab", { name: "文生视频" }).click();
      await expect(
        page.getByRole("button", { name: /上传参考图/ }),
      ).toHaveCount(0);
      await expect(
        page.getByRole("button", { name: /上传参考音频/ }),
      ).toHaveCount(0);
      // 提示词框始终可见
      await expect(page.locator("#nsv-positive")).toBeVisible();
    },
  );

  // ─── 用例 5:视频参数面板(分辨率 / 时长预设)───
  test(
    "authed-nsfw: 视频参数面板",
    { tag: "@authed" },
    async ({ page }) => {
      await switchToVideo(page);

      // 分辨率预设按钮:480p / 720p / 1080p
      const res480 = page.locator(".nsv-preset-btn", { hasText: "480p" });
      const res720 = page.locator(".nsv-preset-btn", { hasText: "720p" });
      const res1080 = page.locator(".nsv-preset-btn", { hasText: "1080p" });
      await expect(res480).toBeVisible();
      await expect(res720).toBeVisible();
      await expect(res1080).toBeVisible();

      // 时长预设按钮:6s / 10s / 15s
      const dur6 = page.locator(".nsv-preset-btn", { hasText: "6s" });
      const dur10 = page.locator(".nsv-preset-btn", { hasText: "10s" });
      const dur15 = page.locator(".nsv-preset-btn", { hasText: "15s" });
      await expect(dur6).toBeVisible();
      await expect(dur10).toBeVisible();
      await expect(dur15).toBeVisible();

      // 720p 默认 active(默认 768×384 = 720p 预设)
      await expect(res720).toHaveClass(/is-active/);
      await expect(res480).not.toHaveClass(/is-active/);
      await expect(res1080).not.toHaveClass(/is-active/);

      // 点击 1080p → 切换成功
      await res1080.click();
      await expect(res1080).toHaveClass(/is-active/);
      await expect(res720).not.toHaveClass(/is-active/);

      // 高级面板默认折叠,可展开
      const advancedToggle = page.locator(".nsv-collapse-head", {
        hasText: "高级参数",
      });
      await expect(advancedToggle).toBeVisible();
      await expect(advancedToggle).toHaveAttribute("aria-expanded", "false");
      await advancedToggle.click();
      await expect(advancedToggle).toHaveAttribute("aria-expanded", "true");
    },
  );

  // ─── 用例 6:NSFW 推荐模型清单可折叠 ───
  test(
    "authed-nsfw: NSFW 推荐模型清单可折叠",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      const recsToggle = page.locator(".nsfw-recs-toggle");
      await expect(recsToggle).toBeVisible();

      // 默认折叠(aria-expanded=false)
      await expect(recsToggle).toHaveAttribute("aria-expanded", "false");

      // 点击展开
      await recsToggle.click();
      await expect(recsToggle).toHaveAttribute("aria-expanded", "true");

      // 推荐区域容器可见(可能为空 empty-state,但 grid 容器应渲染)
      await expect(page.locator(".nsfw-recs-grid")).toBeVisible();

      // 再次点击折叠
      await recsToggle.click();
      await expect(recsToggle).toHaveAttribute("aria-expanded", "false");
    },
  );
});
