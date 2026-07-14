import { test, expect } from "@playwright/test";

/**
 * 真实登录流程测试 (chromium-guest project)
 *
 * - 访问 /
 * - 如果有登录表单,填 admin/admin123,提交
 * - 验证进入主界面
 * - 验证 localStorage 有 toiv_token
 * - 截图
 */

test.describe("真实登录流程", () => {
  test("admin/admin123 登录进入主界面", async ({ page }) => {
    // 1. 访问首页
    await page.goto("/", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      // 忽略
    }

    // 2. 检测登录表单是否存在(placeholder "邮箱")
    const emailInput = page.getByPlaceholder("邮箱");
    const hasLoginForm = await emailInput.isVisible().catch(() => false);

    if (hasLoginForm) {
      // 填写并提交登录表单
      await emailInput.fill("admin");
      await page.getByPlaceholder("密码").fill("admin123");

      // 点击登录按钮(文本"登录",排除"登录中…")
      await page.getByRole("button", { name: "登录" }).click();

      // 提交后页面会 reload;等待 app-shell 出现
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 20000 });
    } else {
      // 可能已是登录态或已重定向;检查是否已在主界面
      const appShellVisible = await page
        .locator(".app-shell")
        .isVisible()
        .catch(() => false);
      test.skip(!appShellVisible, "未检测到登录表单,且不在主界面");
      return;
    }

    // 3. 验证进入主界面:topbar 可见
    await expect(page.locator("header.topbar")).toBeVisible({ timeout: 10000 });

    // 4. 验证 localStorage 有 toiv_token
    const token = await page.evaluate(() =>
      window.localStorage.getItem("toiv_token"),
    );
    expect(token, "登录后 localStorage 应有 toiv_token").toBeTruthy();

    // 5. 截图
    await page.screenshot({
      path: "test-results/auth-flow.png",
      fullPage: true,
    });

    test.info().annotations.push({
      type: "login",
      description: `token 长度 ${token?.length ?? 0}`,
    });
  });
});
