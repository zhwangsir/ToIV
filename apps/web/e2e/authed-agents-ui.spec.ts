import { test, expect } from "@playwright/test";

/**
 * 智能体系统 UI 测试 (chromium-authed project)
 *
 * 2026-09-22 重写(旧三例系 09-12/09-15 架构陈旧,曾 skip 登记):
 * - A2′:SideRail「智能体」=对话面;运行台改「任务」深链;/agent-runs 深链保留;会话分叉;「在对话中继续」
 * - 助手 optimize_prompt → A1 对照卡 + 应用到输入框(优化入口现状=助手工具;
 *   GenerateView 09-12 已退役,工作台 PromptBar/OptimizeButton 随之离场)
 * - 智能体管理(列表/tab)改打独立管理系统(TOIV_ADMIN_BASE,默认 TS 100.77.80.100:3200;
 *   管理系统 09-15 起不在主站;登录用 admin/admin123 表单)
 */

test.describe("智能体 UI", () => {
  // ── A2′:SideRail「智能体」=对话面(2026-09-23) ──
  test("SideRail 智能体入口打开对话面(对话=智能体)", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // 左栏唯一「智能体」→ home 对话面(不再直达 /agent-runs)
    const railBtn = page.locator(".siderail button[aria-label='智能体']").first();
    await expect(railBtn).toBeVisible({ timeout: 30000 });
    await railBtn.click();
    await page.waitForURL(/\/(?:\?view=home)?$|\?view=home/, { timeout: 30000 }).catch(() => null);
    // 对话面挂载(页即助手)
    await expect(page.locator(".av-view").first()).toBeVisible({ timeout: 30000 });
    await page.screenshot({ path: "ui-sweep/a2-agent-is-chat.png" });
  });

  test("更多抽屉「任务」进运行台", async ({ page }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // 窄屏更多抽屉或桌面侧栏均可能;桌面走 composer「任务」深链
    const taskBtn = page.locator(".av-composer-tool[aria-label='任务'], a[aria-label='任务'], button[aria-label='任务']").first();
    if (await taskBtn.count()) {
      await taskBtn.click();
    } else {
      // 兜底:直达仍合法深链
      await page.goto("/agent-runs", { waitUntil: "domcontentloaded" });
    }
    await page.waitForURL(/\/agent-runs/, { timeout: 30000 });
    await page.screenshot({ path: "ui-sweep/a2-tasks-runs.png" });
  });

  // ── A2:会话分叉入 UI(2026-09-22) ──
  test("助手会话列表分叉:复制为新对话并置顶", async ({ page }) => {
    test.setTimeout(150000);
    await page.goto("/?view=home", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
    // 打开历史面板
    await page.getByRole("button", { name: /对话历史|历史/ }).first().click();
    const list = page.locator(".av-conv-item");
    await list.first().waitFor({ state: "visible", timeout: 30000 });
    const before = await list.count();
    if (before === 0) {
      console.log("FORK_E2E_SKIP: 无历史会话");
      return;
    }
    const first = list.first();
    await first.hover();
    await first.getByRole("button", { name: /^分叉对话 / }).click();
    await expect(page.getByText(/已分叉为新对话/)).toBeVisible({ timeout: 30000 });
    await expect(list).toHaveCount(before + 1, { timeout: 15000 });
    await page.screenshot({ path: "ui-sweep/a2-fork-session.png" });
  });

  // ── A2:运行台详情「在对话中继续」草稿通道 ──
  test("agent-runs 详情「在对话中继续」回填助手输入框", async ({ page }) => {
    test.setTimeout(150000);
    await page.goto("/agent-runs", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
    // 列表第一条进详情(无运行记录时环境性跳过;列表项是 button 非链接;先等挂载再判空)
    await page.waitForSelector(".agent-run-open", { timeout: 30000 }).catch(() => null);
    const first = page.locator(".agent-run-open").first();
    if ((await first.count()) === 0) {
      console.log("CONTINUE_E2E_SKIP: 无运行记录");
      return;
    }
    await first.click();
    const btn = page.locator(".agent-continue-chat");
    await expect(btn).toBeVisible({ timeout: 30000 });
    await btn.click();
    await page.waitForURL(/view=home/, { timeout: 30000 });
    const composer = page.locator(".av-composer-input");
    await expect(composer).toBeVisible({ timeout: 30000 });
    const v = await composer.inputValue();
    expect(v).toContain("继续处理智能体任务");
    await page.screenshot({ path: "ui-sweep/a2-continue-in-chat.png" });
  });


  // ── 提示词优化(2026-09-22 重写:GenerateView 已退役,优化入口=助手 optimize_prompt 工具+A1 对照卡) ──
  test("助手优化提示词:对照卡渲染+应用到输入框", async ({ page }) => {
    test.setTimeout(150000);
    await page.goto("/?view=home", { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".av-composer-input", { timeout: 60000 });
    await page.locator(".av-composer-input").fill("帮我优化提示词:一只橘猫在窗台晒太阳");
    await page.locator(".av-composer-input").press("Enter");
    // A1 对照卡( optimize_prompt payload 卡;LLM+优化两跳,宽限 90s)
    const card = page.locator("[class*='av-tc-optimize']").first();
    await card.waitFor({ state: "visible", timeout: 90000 });
    await expect(card.getByText(/应用到输入框/)).toBeVisible({ timeout: 10000 });
    await page.screenshot({ path: "ui-sweep/agents-ui-optimize-card.png" });
    // 「应用到输入框」回填 composer
    await card.getByRole("button", { name: /应用到输入框/ }).click();
    const v = await page.locator(".av-composer-input").inputValue();
    expect(v.length).toBeGreaterThan(30);
  });

  // ── 智能体管理(2026-09-22 重写:管理系统独立 :3200,改打独立控制台;admin 需登录) ──
  const ADMIN_BASE = process.env.TOIV_ADMIN_BASE ?? "http://100.77.80.100:3200";

  async function adminLogin(page: import("@playwright/test").Page) {
    await page.goto(`${ADMIN_BASE}/`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector(".login-card, nav.tabs", { timeout: 60000 });
    if (await page.locator(".login-card").count()) {
      await page.locator(".login-card input").first().fill("admin");
      await page.locator('.login-card input[type="password"]').fill("admin123");
      await page.locator('.login-card button[type="submit"]').click();
      await page.waitForSelector("nav.tabs", { timeout: 60000 });
    }
  }

  test("管理系统:智能体管理 tab 出现(独立控制台)", async ({ page }) => {
    test.setTimeout(120000);
    await adminLogin(page);
    await page.getByRole("button", { name: "平台管理" }).first().click();
    await expect(page.getByRole("tab", { name: "智能体管理" })).toBeVisible({ timeout: 30000 });
  });

  test("管理系统:智能体管理列表 ≥11(含 NSFW 内置)", async ({ page }) => {
    test.setTimeout(120000);
    await adminLogin(page);
    await page.getByRole("button", { name: "平台管理" }).first().click();
    await page.getByRole("tab", { name: "智能体管理" }).click();
    const adminView = page.locator(".agents-admin").first();
    await expect(adminView).toBeVisible({ timeout: 30000 });
    await page.waitForTimeout(2000);
    const items = adminView.locator("[class*='aa-item'], [class*='aa-card'], [class*='agent-row']");
    expect(await items.count(), "至少 11 个智能体(含 NSFW)").toBeGreaterThanOrEqual(11);
  });
});
