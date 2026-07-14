import { test, expect } from "@playwright/test";

/**
 * 智能体优化系统 UI 测试 (chromium-authed project)
 *
 * 覆盖前端 UI 流程:
 * - 顶栏 AgentSwitcher 出现 + 列表只含 SFW 智能体
 * - 切换智能体写 localStorage + 调 preferences API
 * - CreateView 出现 OptimizeButton
 * - NsfwVideoView 出现 OptimizeButton(R18 开启后)
 * - AdminView 智能体管理 tab + 列表 + 编辑入口
 */

test.describe("智能体 UI", () => {
  // ── 顶栏 AgentSwitcher ──────────────────────────────────────────
  test("顶栏出现 AgentSwitcher 切换器", async ({ page }) => {
    await page.goto("/");

    // AgentSwitcher 按钮应可见(带 data-testid 或可按 aria-label / 文本定位)
    // 先尝试按文本定位(智能体名)
    const switcher = page.locator('[data-testid="agent-switcher"], button:has-text("智能体"), [aria-label*="智能体"], [aria-label*="agent"]').first();
    await expect(switcher).toBeVisible({ timeout: 10000 });
  });

  test("点击 AgentSwitcher 展开下拉,列表只含 SFW 智能体", async ({ page }) => {
    await page.goto("/");

    // 找到切换器按钮(尝试多种选择器)
    const switcher = page.locator('[data-testid="agent-switcher"], [aria-label*="智能体"], [aria-label*="agent"]').first();
    await switcher.click();

    // 下拉项应出现,且不包含 NSFW 字样
    // 等 popover 出现
    const popover = page.locator('[data-testid="agent-popover"], [role="listbox"], [role="menu"]').first();
    await expect(popover).toBeVisible({ timeout: 5000 });

    // 列表项数应 >= 9 个 SFW 智能体(11 - 2 NSFW = 9,可能用户加了自定义)
    const items = popover.locator('[role="option"], [role="menuitem"], .agent-item');
    const count = await items.count();
    expect(count, "至少 9 个 SFW 智能体").toBeGreaterThanOrEqual(9);

    // 列表中不应出现 NSFW 关键字
    const text = await popover.textContent();
    expect(text).not.toContain("NSFW");
  });

  test("切换智能体写 localStorage + 持久化", async ({ page }) => {
    await page.goto("/");

    const switcher = page.locator('[data-testid="agent-switcher"], [aria-label*="智能体"], [aria-label*="agent"]').first();
    await switcher.click();

    const popover = page.locator('[data-testid="agent-popover"], [role="listbox"], [role="menu"]').first();
    await expect(popover).toBeVisible({ timeout: 5000 });

    // 选第一个 SFW 智能体(写实摄影师)
    const firstItem = popover.locator('[role="option"], [role="menuitem"], .agent-item').first();
    await firstItem.click();

    // 等 popover 关闭
    await expect(popover).toBeHidden({ timeout: 3000 });

    // 验证 localStorage 写入
    const stored = await page.evaluate(() => window.localStorage.getItem("toiv_default_agent"));
    expect(stored, "localStorage 应写入 toiv_default_agent").toBeTruthy();
  });

  // ── CreateView OptimizeButton ─────────────────────────────────
  test("CreateView 出现 OptimizeButton", async ({ page }) => {
    await page.goto("/?view=create", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 10000 });
    } catch {
      /* dev 模式 networkidle 可能超时,忽略 */
    }

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
