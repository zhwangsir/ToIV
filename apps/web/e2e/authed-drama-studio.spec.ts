import { test, expect, type Page, type APIRequestContext } from "@playwright/test";

/**
 * AI 短剧工作室 (dramaStudio) 专项 E2E — chromium-authed project
 *
 * 覆盖 authed-views.spec.ts 未覆盖的 dramaStudio 视图(短剧工作室是平台核心功能)。
 * 策略:UI 交互验证 + API 数据准备/清理,不触发真实 GPU 生成(仅 CRUD 与界面流转)。
 *
 * 场景:
 *  1. hub 视图加载(导演控制中心/推荐Skill/最近项目)
 *  2. 新建项目全流程(UI 表单 → 真实创建 → 工作区 → API 清理)
 *  3. 工作区 tab 切换(剧本/分镜/角色/合成)
 *  4. 项目编辑(标题修改 → 保存 → 列表反映)
 *  5. 放映厅视图切换
 *  6. 项目删除(UI 卡片删除)
 *  7. 控制台错误与错误文案扫描
 */

const API = process.env.TOIV_API_BASE ?? "http://192.168.71.127:8090";

/** 通过 API 登录拿 token(与 global-setup 同方式),与页面导航状态解耦。 */
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

/** API 创建项目(数据准备),返回项目 id。 */
async function apiCreateProject(request: APIRequestContext, token: string, title: string): Promise<string> {
  const res = await request.post(`${API}/api/drama/projects`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      title,
      premise: "E2E 数据准备",
      style: "电影感",
      script: "第一幕 小明走进房间,发现桌上的信。\n第二幕 信里写着惊人的秘密。",
      width: 832,
      height: 480,
      fps: 24,
    },
    timeout: 15000,
  });
  expect(res.status(), `API 创建项目应 200,实际 ${res.status()}`).toBe(200);
  return (await res.json()).id;
}

/** API 删除项目(清理)。 */
async function apiDeleteProject(request: APIRequestContext, token: string, pid: string): Promise<void> {
  await request.delete(`${API}/api/drama/projects/${pid}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

test.describe("AI 短剧工作室 dramaStudio", () => {
  test.describe.configure({ timeout: 90000 });

  test("hub 视图加载:导演控制中心/Skill/最近项目", { tag: "@authed" }, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // hub 核心元素
    await expect(page.locator(".hub-view"), "hub 视图应渲染").toBeVisible();
    await expect(page.locator(".hero-text h1"), "应显示导演控制中心").toHaveText("导演控制中心");
    await expect(page.locator(".hero-actions .btn-primary"), "新建项目按钮应可见").toBeVisible();

    // 推荐 Skill 区(静态 chips)
    const skillChips = page.locator(".skill-chip");
    expect(await skillChips.count(), "推荐 Skill chips 应 ≥1").toBeGreaterThan(0);

    // 最近项目区:加载完成后 spinner 消失,出现 项目网格/空态/错误 之一
    await expect(page.locator(".hub-loading"), "项目加载 spinner 应消失").toBeHidden({ timeout: 15000 });
    const grid = await page.locator(".project-grid").count();
    const empty = await page.locator(".hub-empty").count();
    const error = await page.locator(".hub-error").count();
    expect(grid + empty + error, "最近项目区应呈现 网格/空态/错误 之一").toBeGreaterThan(0);
    expect(error, "最近项目加载不应出错").toBe(0);

    // 无 React 错误
    const fatal = consoleErrors.filter((e) => /error|uncaught|failed/i.test(e));
    expect(fatal, `控制台不应有错误: ${fatal.join("; ")}`).toHaveLength(0);
  });

  test("新建项目全流程:UI 表单创建 → 工作区 → API 清理", { tag: "@authed" }, async ({ page, request }) => {
    const title = `E2E新建-${Date.now()}`;
    let createdId: string | null = null;

    await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");

    // 点击新建项目 → workspace + NewProjectPanel
    await page.locator(".hero-actions .btn-primary").click();
    await expect(page.locator(".ds-new-panel"), "新建项目面板应出现").toBeVisible();

    // 取消按钮可用(返回)
    await page.locator(".ds-form-actions .btn-ghost").click();
    await expect(page.locator(".ds-new-panel"), "取消后面板应关闭").toBeHidden();

    // 重新打开并填写
    await page.locator(".hero-actions .btn-primary").click();
    await page.locator(".ds-new-panel .ds-input").first().fill(title);
    await page.locator(".ds-new-panel textarea").fill("第一幕 测试剧本内容,小明登场。");

    // 创建 → 等待面板关闭(创建成功进入项目工作区)
    await page.locator(".ds-form-actions .btn-primary").click();
    await expect(page.locator(".ds-new-panel"), "创建成功后面板应关闭").toBeHidden({ timeout: 20000 });

    // 工作区标题 = 新项目名
    await expect(page.locator(".workspace-title h2"), "工作区应显示新项目标题").toHaveText(title, { timeout: 10000 });

    // 通过 API 找到该项目 id 用于清理
    const token = await getToken(request);
    const list = await request.get(`${API}/api/drama/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    createdId = (await list.json()).find((p: { title: string }) => p.title === title)?.id ?? null;
    expect(createdId, "API 项目列表应含 UI 新建的项目").toBeTruthy();

    // API 清理
    if (createdId) await apiDeleteProject(request, token, createdId);
  });

  test("工作区 tab 切换:剧本/分镜/角色/合成", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const pid = await apiCreateProject(request, token, `E2E-tab-${Date.now()}`);

    try {
      await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");

      // 从 hub 进入项目:点击项目卡片
      await expect(page.locator(".project-grid"), "项目网格应存在").toBeVisible({ timeout: 15000 });
      await page.locator(".project-card").first().click();

      // 工作区出现
      await expect(page.locator(".workspace-view"), "应进入工作区").toBeVisible({ timeout: 10000 });

      // stage 切换导航:<nav aria-label="短剧创作阶段"> 内含 剧本/角色/分镜 等按钮
      const stageNav = page.locator('nav[aria-label="短剧创作阶段"]');
      await expect(stageNav, "工作区应有创作阶段导航").toBeVisible();
      const stageBtns = stageNav.locator("button");
      const btnCount = await stageBtns.count();
      expect(btnCount, "阶段导航应含 剧本/角色/分镜 等 ≥3 个按钮").toBeGreaterThanOrEqual(3);

      // 逐一点击切换,验证主面板保持渲染且无错误
      for (let i = 0; i < btnCount; i++) {
        await stageBtns.nth(i).click();
        await page.waitForTimeout(300);
      }

      // 主面板存在
      await expect(page.locator(".main-panel"), "主面板应渲染").toBeVisible();
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("项目编辑:标题修改保存后工作区同步", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const pid = await apiCreateProject(request, token, `E2E编辑前-${Date.now()}`);

    try {
      await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");
      await page.locator(".project-card").first().click();
      await expect(page.locator(".workspace-view")).toBeVisible({ timeout: 10000 });

      // 点击编辑 → 编辑面板
      await page.locator(".workspace-actions .btn-sm", { hasText: "编辑" }).click();
      await expect(page.locator(".edit-panel"), "编辑面板应出现").toBeVisible();

      const newTitle = `E2E编辑后-${Date.now()}`;
      const titleInput = page.locator(".edit-panel .prop-row input").first();
      await titleInput.fill(newTitle);
      await page.locator(".workspace-actions .btn-primary", { hasText: "保存" }).click();

      // 保存后工作区标题更新
      await expect(page.locator(".workspace-title h2"), "标题应更新").toHaveText(newTitle, { timeout: 10000 });
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("放映厅视图切换", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const pid = await apiCreateProject(request, token, `E2E放映-${Date.now()}`);

    try {
      await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
      await page.waitForLoadState("networkidle");
      await page.locator(".project-card").first().click();
      await expect(page.locator(".workspace-view")).toBeVisible({ timeout: 10000 });

      // 点击放映厅
      await page.locator(".workspace-actions .btn-sm", { hasText: "放映厅" }).click();
      await expect(page.locator(".cinema-view"), "应切换到放映厅视图").toBeVisible();
      await expect(page.locator(".cinema-screen"), "放映厅屏幕区应存在").toBeVisible();
      await expect(page.locator(".cinema-title"), "放映厅应显示项目标题").toBeVisible();
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("项目删除:UI 卡片删除后列表移除", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const title = `E2E删除-${Date.now()}`;
    const pid = await apiCreateProject(request, token, title);

    await page.goto("/?view=dramaStudio", { waitUntil: "domcontentloaded" });
    await page.waitForLoadState("networkidle");
    await expect(page.locator(".project-grid")).toBeVisible({ timeout: 15000 });

    // 找到目标卡片并点击删除(卡片内有 .proj-del)
    const card = page.locator(".project-card", { hasText: title });
    await expect(card, "目标项目卡片应存在").toBeVisible();

    // 删除是二次确认交互:第一次点击 → 按钮变"确认?",4s 内第二次点击才真正删除
    const delBtn = card.locator(".proj-del");
    await delBtn.click();
    await expect(delBtn, "第一次点击后应显示确认态").toContainText("确认?");
    await delBtn.click(); // 确认删除

    // 卡片应从列表消失
    await expect(card, "删除后卡片应消失").toBeHidden({ timeout: 10000 });

    // API 确认已删除
    const res = await request.get(`${API}/api/drama/projects/${pid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "API 确认项目已删除").toBe(404);
  });
});
