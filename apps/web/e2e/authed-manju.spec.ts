import { test, expect, type APIRequestContext } from "@playwright/test";

/**
 * 漫剧工作室 (manju) 专项 E2E — chromium-authed project
 *
 * 覆盖 authed-views.spec.ts 未深入的 manju 视图核心交互。
 * 策略:UI 交互验证 + API 数据准备/清理,不触发真实 GPU/LLM 生成(仅 CRUD、面板开合与空态)。
 *
 * 场景:
 *  1. 视图加载(头部/侧边栏/项目计数/无控制台错误)
 *  2. 新建项目全流程(UI 表单 → 真实创建 → 自动进入详情 → API 清理)
 *  3. 新建表单校验(空标题 → 错误提示)
 *  4. 项目选择与详情(分镜空态)
 *  5. 项目编辑(标题修改 → 保存 → 详情与列表同步)
 *  6. 生成分镜面板(开合/字段渲染,不触发 LLM)
 *  7. 项目删除(二次确认 → 列表移除 → API 404)
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

/** API 创建漫剧项目(数据准备),返回项目 id。 */
async function apiCreateProject(request: APIRequestContext, token: string, title: string): Promise<string> {
  const res = await request.post(`${API}/api/manju/projects`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    data: {
      title,
      premise: "E2E 数据准备:少年在雨夜捡到会说话的黑猫。",
      style: "电影感",
    },
    timeout: 15000,
  });
  expect(res.status(), `API 创建项目应 200,实际 ${res.status()}`).toBe(200);
  return (await res.json()).id;
}

/** API 删除项目(清理)。 */
async function apiDeleteProject(request: APIRequestContext, token: string, pid: string): Promise<void> {
  await request.delete(`${API}/api/manju/projects/${pid}`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 15000,
  });
}

/** 进入短剧工作室的漫剧模式并等待项目列表加载完成(spinner 消失)。 */
async function gotoManju(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/?view=dramaStudio&mode=manju", { waitUntil: "domcontentloaded" });
  await expect(page.locator(".manju-view"), "漫剧视图应渲染").toBeVisible();
  await expect(page.locator(".mj-side-loading"), "项目加载 spinner 应消失").toBeHidden({ timeout: 15000 });
}

test.describe("漫剧工作室 manju", () => {
  test.describe.configure({ timeout: 90000 });

  test("视图加载:头部/侧边栏/项目计数/无控制台错误", { tag: "@authed" }, async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") consoleErrors.push(m.text());
    });

    await gotoManju(page);

    // 头部
    await expect(page.locator(".mj-title"), "应显示漫剧工作室标题").toContainText("漫剧工作室");
    await expect(page.locator(".mj-count"), "项目计数应渲染").toBeVisible();
    await expect(page.locator(".mj-count"), "计数应为「N 个项目」或错误占位").toContainText(/个项目|—/);

    // 侧边栏:新建按钮 + (项目列表 / 空态 / 错误 之一)
    await expect(page.locator(".mj-new-btn"), "新建项目按钮应可见").toBeVisible();
    const list = await page.locator(".mj-proj-ul").count();
    const empty = await page.locator(".mj-side-empty").count();
    const error = await page.locator(".mj-side-error").count();
    expect(list + empty + error, "侧边栏应呈现 列表/空态/错误 之一").toBeGreaterThan(0);
    expect(error, "项目列表加载不应出错").toBe(0);

    // 无 React 致命错误
    const fatal = consoleErrors.filter((e) => /error|uncaught|failed/i.test(e));
    expect(fatal, `控制台不应有错误: ${fatal.join("; ")}`).toHaveLength(0);
  });

  test("新建项目全流程:UI 表单创建 → 自动进入详情 → API 清理", { tag: "@authed" }, async ({ page, request }) => {
    const title = `E2E漫剧-${Date.now()}`;
    let createdId: string | null = null;

    await gotoManju(page);

    // 打开新建表单 → 取消关闭
    await page.locator(".mj-new-btn").click();
    await expect(page.locator(".mj-new-form"), "新建表单应出现").toBeVisible();
    await page.locator(".mj-new-form .mj-form-actions .btn-ghost").click();
    await expect(page.locator(".mj-new-form"), "取消后表单应关闭").toBeHidden();

    // 重新打开并填写
    await page.locator(".mj-new-btn").click();
    await page.locator(".mj-new-form .mj-field input").first().fill(title);
    await page.locator(".mj-new-form .mj-field textarea").fill("雨夜、黑猫与神秘邀请函。");
    await page.locator(".mj-new-form .mj-field-row .mj-field input").first().fill("水彩");

    // 创建 → 表单关闭,自动进入详情
    await page.locator(".mj-new-form .mj-form-actions .btn-primary").click();
    await expect(page.locator(".mj-new-form"), "创建成功后表单应关闭").toBeHidden({ timeout: 20000 });
    await expect(page.locator(".mj-detail-title"), "详情应显示新项目标题").toHaveText(title, { timeout: 10000 });

    // 列表中出现该项且为激活态
    const item = page.locator(".mj-proj-item", { hasText: title });
    await expect(item, "列表应包含新项目").toBeVisible();
    await expect(item, "新项目应为激活态").toHaveAttribute("data-active", "1");

    // 通过 API 找到该项目 id 用于清理
    const token = await getToken(request);
    const list = await request.get(`${API}/api/manju/projects`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    createdId = (await list.json()).find((p: { title: string }) => p.title === title)?.id ?? null;
    expect(createdId, "API 项目列表应含 UI 新建的项目").toBeTruthy();

    if (createdId) await apiDeleteProject(request, token, createdId);
  });

  test("新建表单校验:空标题提示错误", { tag: "@authed" }, async ({ page }) => {
    await gotoManju(page);

    await page.locator(".mj-new-btn").click();
    await expect(page.locator(".mj-new-form")).toBeVisible();

    // 不填标题直接创建
    await page.locator(".mj-new-form .mj-form-actions .btn-primary").click();
    await expect(page.locator(".mj-new-form .mj-error-inline"), "应显示标题校验错误").toContainText("请填写标题");

    // 表单仍保持打开(未发起创建)
    await expect(page.locator(".mj-new-form")).toBeVisible();
  });

  test("项目选择与详情:分镜空态", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const title = `E2E详情-${Date.now()}`;
    const pid = await apiCreateProject(request, token, title);

    try {
      await gotoManju(page);

      // 点击目标项目
      const item = page.locator(".mj-proj-item", { hasText: title });
      await expect(item, "目标项目应在列表中").toBeVisible({ timeout: 15000 });
      await item.click();

      // 详情渲染:标题/大纲/操作按钮
      await expect(page.locator(".mj-detail-title"), "详情标题应匹配").toHaveText(title, { timeout: 10000 });
      await expect(page.locator(".mj-detail-head-actions"), "详情操作区应渲染").toBeVisible();

      // 新项目无分镜 → 空态
      await expect(page.locator(".mj-shots-empty .empty-state-title"), "应显示分镜空态").toHaveText("暂无分镜");
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("项目编辑:标题修改保存后详情与列表同步", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const pid = await apiCreateProject(request, token, `E2E编辑前-${Date.now()}`);

    try {
      await gotoManju(page);
      await page.locator(".mj-proj-item").first().click();
      await expect(page.locator(".mj-detail-title")).toBeVisible({ timeout: 10000 });

      // 点击编辑 → 编辑表单
      await page.locator(".mj-detail-head-actions .btn-ghost", { hasText: "编辑" }).click();
      await expect(page.locator(".mj-edit-form"), "编辑表单应出现").toBeVisible();

      const newTitle = `E2E编辑后-${Date.now()}`;
      const titleInput = page.locator(".mj-edit-form .mj-field input").first();
      await titleInput.fill(newTitle);
      await page.locator(".mj-edit-form .mj-form-actions .btn-primary").click();

      // 保存后详情标题更新,列表同步
      await expect(page.locator(".mj-detail-title"), "详情标题应更新").toHaveText(newTitle, { timeout: 10000 });
      await expect(
        page.locator(".mj-proj-item", { hasText: newTitle }),
        "列表应显示新标题",
      ).toBeVisible();
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("生成分镜面板:开合与字段渲染(不触发 LLM)", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const pid = await apiCreateProject(request, token, `E2E分镜-${Date.now()}`);

    try {
      await gotoManju(page);
      await page.locator(".mj-proj-item").first().click();
      await expect(page.locator(".mj-detail-title")).toBeVisible({ timeout: 10000 });

      // 打开生成分镜面板
      const genToggle = page.locator(".mj-detail-head-actions button", { hasText: "生成分镜" });
      await genToggle.click();
      await expect(page.locator(".mj-gen-panel"), "生成面板应出现").toBeVisible();

      // 字段:故事文本 textarea / 镜头数 number / 风格 input / 生成按钮
      await expect(page.locator(".mj-gen-textarea"), "故事文本框应可见").toBeVisible();
      await expect(page.locator('.mj-gen-row input[type="number"]'), "镜头数输入应可见").toBeVisible();
      await expect(page.locator(".mj-gen-actions .btn-primary"), "生成按钮应可见").toBeVisible();

      // 故事文本应预填项目大纲(openDetail 时 setGenPremise(d.premise))
      await expect(page.locator(".mj-gen-textarea"), "故事文本应预填项目大纲").toHaveValue(/雨夜/);

      // 收起面板
      await page.locator(".mj-detail-head-actions button", { hasText: "收起" }).click();
      await expect(page.locator(".mj-gen-panel"), "收起后面板应关闭").toBeHidden();
    } finally {
      await apiDeleteProject(request, token, pid);
    }
  });

  test("项目删除:二次确认后列表移除且 API 404", { tag: "@authed" }, async ({ page, request }) => {
    const token = await getToken(request);
    const title = `E2E删除-${Date.now()}`;
    const pid = await apiCreateProject(request, token, title);

    await gotoManju(page);

    const li = page.locator(".mj-proj-li", { hasText: title });
    await expect(li, "目标项目应在列表中").toBeVisible({ timeout: 15000 });

    // 删除是二次确认:第一次点击 → "确认?",第二次点击才真正删除
    const delBtn = li.locator(".mj-proj-del");
    await li.hover(); // 删除按钮 hover 才显示
    await delBtn.click();
    await expect(delBtn, "第一次点击后应显示确认态").toContainText("确认?");
    await delBtn.click();

    // 列表项应消失
    await expect(li, "删除后列表项应消失").toBeHidden({ timeout: 10000 });

    // API 确认已删除
    const res = await request.get(`${API}/api/manju/projects/${pid}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "API 确认项目已删除").toBe(404);
  });
});
