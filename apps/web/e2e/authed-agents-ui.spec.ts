import { test, expect } from "@playwright/test";

/**
 * 智能体优化系统 UI 测试 (chromium-authed project)
 *
 * 覆盖前端 UI 流程:
 * - 主站图像工作台(GenerateView)出现 OptimizeButton
 * - AdminView 智能体管理 tab + 列表 + 编辑入口
 *
 * 说明:W0 后顶栏 AgentSwitcher 已移至侧栏底部;M4 起侧栏底部 AgentSwitcher 已移除,
 * 智能体选择收敛到各生成页 OptimizeButton 内联弹出。
 * M9 起 NSFW 专区并入主站(R18 全局模式),OptimizeButton 用例改走主站图像视图。
 */

test.describe("智能体 UI", () => {
  // ── 图像工作台 OptimizeButton ─────────────────────────────
  // 优化按钮在工作台底部提示词条(PromptBar)内,SFW/R18 视图均有。
  test("图像工作台出现 OptimizeButton", async ({ page }) => {
    // STALE(2026-09-22 登记):09-12 引擎工作台改造后 ?view=image 渲染 EngineStudioView
    // (.apps-studio,无 PromptBar/OptimizeButton),GenerateView 已无路由挂载;
    // 优化入口现状=助手 optimize_prompt 工具(A1 对照卡)。待按新架构重写,先跳过。
    test.skip(true, "stale: GenerateView 已退役(09-12 引擎工作台),待按新架构重写");
    await page.goto("/?view=image", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* dev 模式 networkidle 可能超时,忽略 */
    }

    // 统一生成工作台渲染
    await expect(page.locator(".generate-view")).toBeVisible({ timeout: 10000 });

    // 应有"优化提示词"按钮(含 sparkles 图标 + 优化文案)
    const optimizeBtn = page.locator("button").filter({ hasText: /优化提示词|优化/ }).first();
    await expect(optimizeBtn).toBeVisible({ timeout: 10000 });
  });

  // ── AdminView 智能体管理 ───────────────────────────────────────
  test("AdminView 出现智能体管理 tab", async ({ page }) => {
    // STALE(2026-09-22 登记):09-15 管理系统独立(:3200)后主站 ?view=admin 弹回对话页,
    // AdminView/智能体管理 tab 在独立控制台;admin e2e 现状保持为零(D7 重建时覆盖),先跳过。
    test.skip(true, "stale: 管理系统已独立 :3200(09-15),主站无 AdminView");
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
    // STALE(2026-09-22 登记):同上——管理系统已独立 :3200,主站无 AdminView,先跳过。
    test.skip(true, "stale: 管理系统已独立 :3200(09-15),主站无 AdminView");
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
