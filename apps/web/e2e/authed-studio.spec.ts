import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * Studio 创作工作室 (studio) 冒烟 E2E — chromium-authed project
 *
 * M4:studio 模块替代旧 短剧(dramaStudio)/漫剧(manju) 双模块。
 * 本 spec 验证入口替换契约:
 *  1. /?view=studio 工作台容器渲染(项目列表首页)
 *  2. 旧链接 /?view=dramaStudio 与 /?view=manju 重定向到 studio(URL 规整)
 *  3. 新建项目 → 四阶段工作台渲染(剧本/角色/分镜/合成)→ API 清理
 *  4. 融合聚合页「创作工作室」卡片跳转 studio
 *
 * 不触发真实 GPU 生成,仅 CRUD 与界面流转。
 */

const API = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";

/** API 登录拿 token(与 global-setup 同方式),用于数据清理。 */
async function getToken(request: APIRequestContext): Promise<string> {
  const res = await request.post(`${API}/api/auth/login`, {
    data: { email: "admin", password: "admin123" },
    timeout: 15000,
  });
  if (!res.ok()) throw new Error(`API 登录失败: HTTP ${res.status()}`);
  const token = (await res.json())?.token;
  if (!token) throw new Error("登录响应无 token");
  return token;
}

/** 按标题找到项目并删除(UI 新建项目的清理)。 */
async function apiCleanupByTitle(request: APIRequestContext, token: string, title: string): Promise<void> {
  const list = await request.get(`${API}/api/studio/projects`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
  if (!list.ok()) return;
  const hit = (await list.json()).find((p: { title: string }) => p.title === title);
  if (hit?.id) {
    await request.delete(`${API}/api/studio/projects/${hit.id}`, {
      headers: { Authorization: `Bearer ${token}` },
      timeout: 15000,
    });
  }
}

test.describe("Studio 创作工作室入口", () => {
  test.describe.configure({ timeout: 60000 });

  test("studio 首页渲染:标题/新建按钮/列表区", { tag: "@authed" }, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await page.goto("/?view=studio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // 项目列表首页容器
    await expect(page.locator(".studio-home"), "studio 首页容器应渲染").toBeVisible();
    await expect(page.locator(".studio-home-title"), "应显示创作工作室标题").toContainText("创作工作室");
    await expect(
      page.locator(".studio-home-head .btn-primary"),
      "新建项目按钮应可见",
    ).toBeVisible();

    // 列表区:有项目出列表,无项目出空态
    const list = await page.locator(".studio-project-list").count();
    const empty = await page.locator(".empty-state").count();
    expect(list + empty, "应呈现 项目列表/空态 之一").toBeGreaterThan(0);

    // 无 React 致命错误
    const fatal = consoleErrors.filter((e) => /uncaught|unhandled/i.test(e));
    expect(fatal, `控制台不应有未捕获错误: ${fatal.join("; ")}`).toHaveLength(0);
  });

  test("旧链接重定向:dramaStudio / manju → studio", { tag: "@authed" }, async ({ page }) => {
    for (const legacy of ["dramaStudio", "manju"]) {
      await page.goto(`/?view=${legacy}`, { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      // URL 规整为新 key
      await expect(page, `?view=${legacy} 应重定向到 studio`).toHaveURL(/[?&]view=studio/, {
        timeout: 10000,
      });
      // studio 首页渲染
      await expect(page.locator(".studio-home"), "重定向后 studio 首页应渲染").toBeVisible();
    }
  });

  test("新建项目:进入四阶段工作台 → API 清理", { tag: "@authed" }, async ({ page, request }) => {
    await page.goto("/?view=studio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // 新建项目(默认标题「未命名项目」)→ 直接进入工作台
    await page.locator(".studio-home-head .btn-primary").click();
    await expect(page.locator(".studio-view"), "新建后应进入工作台").toBeVisible({ timeout: 15000 });

    // 阶段导航:剧本/角色/分镜/合成 四个 tab
    const stageNav = page.locator('nav[aria-label="创作阶段"]');
    await expect(stageNav, "应有创作阶段导航").toBeVisible();
    const tabs = stageNav.locator(".studio-stage-btn");
    await expect(tabs, "应有 4 个阶段 tab").toHaveCount(4);
    await expect(tabs.nth(0)).toContainText("剧本");
    await expect(tabs.nth(1)).toContainText("角色");
    await expect(tabs.nth(2)).toContainText("分镜");
    await expect(tabs.nth(3)).toContainText("合成");

    // 逐一切换,主区域保持渲染
    for (let i = 0; i < 4; i++) {
      await tabs.nth(i).click();
      await expect(tabs.nth(i), "点击后 tab 应激活").toHaveAttribute("aria-selected", "true");
    }

    // 返回项目列表
    await page.locator(".studio-back").click();
    await expect(page.locator(".studio-home"), "应返回项目列表首页").toBeVisible();

    // API 清理(按标题兜底,避免并行测试误删)
    const token = await getToken(request);
    await apiCleanupByTitle(request, token, "未命名项目");
  });

  test("融合聚合页:创作工作室卡片跳转 studio", { tag: "@authed" }, async ({ page }) => {
    await page.goto("/?view=fusion", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // 合并后的单一入口卡,旧 短剧/漫剧 卡已移除
    const card = page.locator(".fusion-card", { hasText: "创作工作室" });
    await expect(card, "融合页应有创作工作室卡片").toBeVisible();
    await expect(card.locator(".fusion-card-desc")).toContainText("分镜");
    expect(
      await page.locator(".fusion-card", { hasText: "短剧" }).count(),
      "旧短剧卡应已移除",
    ).toBe(0);
    expect(
      await page.locator(".fusion-card", { hasText: "漫剧" }).count(),
      "旧漫剧卡应已移除",
    ).toBe(0);

    // 点击卡片 → 跳转 studio 视图
    await card.click();
    await expect(page, "点击后 URL 应为 studio").toHaveURL(/[?&]view=studio/, { timeout: 10000 });
    await expect(page.locator(".studio-home"), "应渲染 studio 首页").toBeVisible();
  });
});
