import { test, expect } from "@playwright/test";

/**
 * 智能体优化系统 UI 测试 (chromium-authed project)
 *
 * 覆盖前端 UI 流程:
 * - CreateView 出现 OptimizeButton(/nsfw 图像 tab,M1 后 ?view=create 已重定向到 image)
 * - NsfwVideoView 出现 OptimizeButton(R18 开启后)
 * - AdminView 智能体管理 tab + 列表 + 编辑入口
 *
 * 说明:W0 后顶栏 AgentSwitcher 已移至侧栏底部;M4 起侧栏底部 AgentSwitcher 已移除,
 * 智能体选择收敛到各生成页 OptimizeButton 内联弹出。
 */

test.describe("智能体 UI", () => {
  // ── CreateView OptimizeButton ─────────────────────────────────
  // M1:CreateView 已从主导航退役,?view=create 重定向到 ?view=image;
  // CreateView 现在只在 /nsfw 路由内被 NsfwView 内嵌(图像 tab,需 R18 token,admin 具备)
  test("CreateView 出现 OptimizeButton", async ({ page }) => {
    await page.goto("/nsfw", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* dev 模式 networkidle 可能超时,忽略 */
    }

    // 等待 NsfwView 鉴权完成 + 默认图像 tab 渲染 CreateView
    await expect(page.locator(".nsfw-banner")).toBeVisible({ timeout: 10000 });
    await expect(page.locator(".create-view")).toBeVisible({ timeout: 10000 });

    // 应有"优化提示词"按钮(含 sparkles 图标 + 优化文案)
    const optimizeBtn = page.locator("button").filter({ hasText: /优化提示词|优化/ }).first();
    await expect(optimizeBtn).toBeVisible({ timeout: 10000 });
  });

  // ── AdminView 智能体管理 ───────────────────────────────────────
  test("AdminView 出现智能体管理 tab", async ({ page }) => {
    await page.goto("/?view=admin", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* 忽略 */
    }

    // 应出现"智能体管理"tab(role=tab,避免匹配顶栏 AgentSwitcher)
    const agentTab = page.getByRole("tab", { name: /智能体/ }).first();
    await expect(agentTab).toBeVisible({ timeout: 10000 });
  });

  test("AdminView 切到智能体管理 tab 应展示列表", async ({ page }) => {
    await page.goto("/?view=admin", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* 忽略 */
    }

    // 点智能体管理 tab(role=tab,精确匹配 AdminView 内的 tab 按钮)
    const agentTab = page.getByRole("tab", { name: /智能体/ }).first();
    await agentTab.click();

    // 等列表渲染(数据请求 + 渲染)
    await page.waitForTimeout(2000);

    // 应出现智能体列表(AgentsAdminView 根元素 class=agents-admin)
    const adminView = page.locator(".agents-admin").first();
    await expect(adminView).toBeVisible({ timeout: 8000 });

    // 列表项数 >= 11(管理页可见含 NSFW 的全部内置)
    const items = adminView.locator("[class*='aa-item'], [class*='aa-card'], [class*='agent-row']");
    const count = await items.count();
    expect(count, "至少 11 个智能体(含 NSFW)").toBeGreaterThanOrEqual(11);
  });
});
