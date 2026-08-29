import { test, expect, type Page } from "@playwright/test";

/**
 * LibTV 短剧工作台真实用户链路 E2E(chromium-authed project)
 *
 * 覆盖(全部自建自删项目,测试间独立):
 * 1. R18 模式 cornernav 进短剧视图 → 新建项目 → 工作台壳 + 步进器门控
 * 2. 剧本阶段写/存剧本 → 「确认剧本 →」→ 解锁资产/分镜,工作区切资产阶段
 * 3. 检查器收叠/展开(<1600px 视口默认收起,按 aria-expanded/类名断言)
 * 4. 浅/暗区切换(.wb-root data-zone darkroom ⇄ light)
 * 5. 确认剧本后返回项目列表重进 → 步进器状态与后端 status(storyboard)一致
 *
 * 清理:每个用例 finally 删自建项目(项目项删除按钮 → Modal「确认删除」)。
 *
 * 前置:
 * - storageState: .auth/admin.json(由 global-setup.ts 写入)
 * - 本地: API http://127.0.0.1:8200 / Web http://localhost:3100
 * - 生产: playwright.prod.config.ts(core 192.168.71.47:8090/:3100)
 */

/** 测试项目统一前缀,便于识别与事后核查清理 */
const TITLE_PREFIX = "E2E短剧-";

/** 后端 API(仅用于准备数据/验证持久化;功能断言一律真实浏览器驱动 UI) */
const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";

test.describe("LibTV 短剧工作台", () => {
  test.use({ storageState: ".auth/admin.json" });

  // 前置:确认 storageState 中确实有 token(与 r18-mode.spec.ts 同款守卫)
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
      test.skip(true, "storageState 中无 token,跳过短剧工作台测试");
      return;
    }
  });

  // ─── helpers ───

  /** R18 模式进入页面(预置模式 + 年龄确认,跳过设置页开关流程) */
  async function gotoR18(page: Page, path: string) {
    await page.addInitScript(() => {
      window.localStorage.setItem("toiv_r18_mode", "1");
      window.localStorage.setItem("toiv_nsfw_age_confirmed", "1");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      /* dev 模式 networkidle 可能超时,不强制中断 */
    }
  }

  /** 真实用户链路(2026-08-29 更新):灵动岛已收「短剧」项(融合页创作工作室承载),
   *  R18 用户经直链进入短剧视图 */
  async function enterDramaViaNav(page: Page) {
    await gotoR18(page, "/?view=drama");
    await expect(page.locator(".nsfw-drama")).toBeVisible({ timeout: 10000 });
  }

  /** 直链进短剧视图(R18 门控放行;用例 2-5 的入口,省去重复导航动画) */
  async function enterDramaDirect(page: Page) {
    await gotoR18(page, "/?view=drama");
    await expect(page.locator(".nsfw-drama")).toBeVisible({ timeout: 10000 });
    // 新建表单就绪(项目列表加载完成与否不影响新建)
    await expect(page.getByPlaceholder("项目标题")).toBeVisible({
      timeout: 10000,
    });
  }

  /** 新建项目并等待工作台打开 */
  async function createProject(page: Page, title: string) {
    await page.getByPlaceholder("项目标题").fill(title);
    await page
      .locator(".nsfw-drama-create")
      .getByRole("button", { name: "新建项目" })
      .click();
    await expect(page.locator(".wb-root")).toBeVisible({ timeout: 15000 });
  }

  /** 工作台打开时经窄轨「返回项目列表」回到列表视图 */
  async function backToProjectList(page: Page) {
    await page.locator('button[title="返回项目列表"]').click();
    await expect(page.locator(".nsfw-drama-create")).toBeVisible({
      timeout: 10000,
    });
  }

  /** 删除指定标题的项目(列表视图 → 删除按钮 → Modal 确认);幂等,找不到直接返回 */
  async function deleteProject(page: Page, title: string) {
    // 若工作台仍打开,先回列表
    if (await page.locator(".wb-root").isVisible().catch(() => false)) {
      await backToProjectList(page);
    }
    const item = page
      .locator(".nsfw-drama-item", { hasText: title })
      .first();
    if (!(await item.isVisible().catch(() => false))) return;
    await item.locator(".nsfw-drama-item-del").click();
    const dlg = page.getByRole("dialog", { name: "删除项目" });
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.getByRole("button", { name: "确认删除" }).click();
    await expect(
      page.locator(".nsfw-drama-item", { hasText: title }),
    ).toHaveCount(0, { timeout: 10000 });
  }

  /** 步进器按钮(文本形如「1·剧本」) */
  function step(page: Page, label: string) {
    return page.locator(".wb-step", { hasText: label });
  }

  /** 在剧本阶段写入剧本并保存(等 PATCH 落库) */
  async function writeAndSaveScript(page: Page, script: string) {
    const ta = page.getByLabel("剧本正文编辑区");
    await expect(ta).toBeVisible({ timeout: 10000 });
    await ta.fill(script);
    const saveResp = page.waitForResponse(
      (r) =>
        /\/api\/drama\/projects\/[^/]+$/.test(r.url()) &&
        r.request().method() === "PATCH",
      { timeout: 15000 },
    );
    await page.getByRole("button", { name: "保存剧本" }).click();
    await saveResp;
  }

  /** 点「确认剧本 →」并等 status PATCH 落库(确认门回写 storyboard) */
  async function confirmScript(page: Page) {
    const confirmBtn = page.getByRole("button", { name: /^确认剧本/ });
    await expect(confirmBtn).toBeEnabled({ timeout: 10000 });
    const patchResp = page.waitForResponse(
      (r) =>
        /\/api\/drama\/projects\/[^/]+$/.test(r.url()) &&
        r.request().method() === "PATCH",
      { timeout: 15000 },
    );
    await confirmBtn.click();
    await patchResp;
  }

  const SAMPLE_SCRIPT = `第一场 镇魔古洞·夜
【场景】青云门后山,月色凄冷。
【动作】张小凡踉跄跌入洞口。
【台词】张小凡:「我一定带你出去。」`;

  // ─── 用例 1:新建项目进入工作台 ───
  test(
    "authed-drama: 新建项目进入工作台,步进器门控正确",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-A`;
      try {
        await enterDramaViaNav(page);
        await createProject(page, title);

        // 工作台壳 + 顶栏标题含项目名
        await expect(page.locator(".wb-topbar-title")).toContainText(title);

        // 当前步 = 1·剧本;其余步 disabled(双确认门初始态)
        await expect(step(page, "1·剧本")).toHaveAttribute(
          "aria-current",
          "step",
        );
        await expect(step(page, "2·资产")).toBeDisabled();
        await expect(step(page, "3·分镜")).toBeDisabled();
        await expect(step(page, "4·短片")).toBeDisabled();

        // 剧本阶段工作区标志元素
        await expect(page.locator(".wb-script")).toBeVisible();
        await expect(page.getByLabel("剧本正文编辑区")).toBeVisible();

        await page.screenshot({
          path: "test-results/drama-wb-1-create.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );

  // ─── 用例 2:确认剧本解锁资产/分镜 ───
  test(
    "authed-drama: 确认剧本解锁资产/分镜,工作区切到资产阶段",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-B`;
      try {
        await enterDramaDirect(page);
        await createProject(page, title);

        // 「确认剧本」在剧本保存前禁用
        const confirmBtn = page.getByRole("button", { name: /^确认剧本/ });
        await expect(confirmBtn).toBeDisabled();

        await writeAndSaveScript(page, SAMPLE_SCRIPT);
        await confirmScript(page);

        // 资产/分镜解锁,短片仍门控(分镜未确认)
        await expect(step(page, "2·资产")).toBeEnabled({ timeout: 10000 });
        await expect(step(page, "3·分镜")).toBeEnabled();
        await expect(step(page, "4·短片")).toBeDisabled();

        // 剧本步带完成态;当前步推进到 2·资产
        await expect(step(page, "1·剧本")).toHaveClass(/is-done/);
        await expect(step(page, "2·资产")).toHaveAttribute(
          "aria-current",
          "step",
        );

        // 工作区切到资产阶段标志元素
        await expect(page.locator(".wb-assets")).toBeVisible();
        await expect(
          page.getByRole("button", { name: "添加角色" }),
        ).toBeVisible();

        await page.screenshot({
          path: "test-results/drama-wb-2-confirm-script.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );

  // ─── 用例 3:检查器收叠/展开 ───
  test(
    "authed-drama: 检查器收叠与展开",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-C`;
      try {
        await enterDramaDirect(page);
        await createProject(page, title);

        const wbMain = page.locator(".wb-main");
        const collapseBtn = page.getByLabel("收叠检查器");
        const expandBtn = page.getByLabel("展开检查器");

        // 1280 默认视口(<1600px)检查器初始收起;先确保处于展开态再测收叠
        if (await expandBtn.isVisible().catch(() => false)) {
          await expandBtn.click();
        }
        await expect(collapseBtn).toBeVisible();
        await expect(collapseBtn).toHaveAttribute("aria-expanded", "true");
        await expect(wbMain).not.toHaveClass(/wb-main--inspector-closed/);

        // 收叠 → 类名出现 + 按钮变「展开检查器」
        await collapseBtn.click();
        await expect(wbMain).toHaveClass(/wb-main--inspector-closed/);
        await expect(expandBtn).toBeVisible();
        await expect(expandBtn).toHaveAttribute("aria-expanded", "false");

        // 再点恢复展开
        await expandBtn.click();
        await expect(wbMain).not.toHaveClass(/wb-main--inspector-closed/);
        await expect(collapseBtn).toHaveAttribute("aria-expanded", "true");

        await page.screenshot({
          path: "test-results/drama-wb-3-inspector.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );

  // ─── 用例 4:浅/暗区切换 ───
  test(
    "authed-drama: 浅色区/暗房切换",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-D`;
      try {
        await enterDramaDirect(page);
        await createProject(page, title);

        const wbRoot = page.locator(".wb-root");
        // 默认暗房
        await expect(wbRoot).toHaveAttribute("data-zone", "darkroom");

        // 切浅色区
        await page.getByLabel("切换浅色区").click();
        await expect(wbRoot).toHaveAttribute("data-zone", "light");
        await expect(page.getByLabel("切换暗房")).toBeVisible();

        // 切回暗房
        await page.getByLabel("切换暗房").click();
        await expect(wbRoot).toHaveAttribute("data-zone", "darkroom");
        await expect(page.getByLabel("切换浅色区")).toBeVisible();

        await page.screenshot({
          path: "test-results/drama-wb-4-zone.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );

  // ─── 用例 5:重进项目状态恢复(storyboard 态)───
  test(
    "authed-drama: 重进项目步进器与后端 status 一致",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-E`;
      try {
        await enterDramaDirect(page);
        await createProject(page, title);

        // 推进到 storyboard 态(保存剧本 + 确认门 PATCH 落库)
        await writeAndSaveScript(page, SAMPLE_SCRIPT);
        await confirmScript(page);
        await expect(page.locator(".wb-assets")).toBeVisible({
          timeout: 10000,
        });

        // 窄轨返回项目列表:列表项副标题应已反映后端 status=storyboard
        await backToProjectList(page);
        const item = page.locator(".nsfw-drama-item", { hasText: title });
        await expect(item).toBeVisible({ timeout: 10000 });
        await expect(item.locator(".nsfw-drama-item-sub")).toContainText(
          "storyboard",
        );

        // 重新点开项目:步进器从后端 status 重新推导
        await item.click();
        await expect(page.locator(".wb-root")).toBeVisible({
          timeout: 15000,
        });

        // storyboard 态:剧本已确认(is-done)、资产/分镜可达、短片仍门控
        await expect(step(page, "1·剧本")).toHaveClass(/is-done/);
        await expect(step(page, "2·资产")).toBeEnabled();
        await expect(step(page, "3·分镜")).toBeEnabled();
        await expect(step(page, "4·短片")).toBeDisabled();
        // 无分镜时初始阶段为资产
        await expect(step(page, "2·资产")).toHaveAttribute(
          "aria-current",
          "step",
        );
        await expect(page.locator(".wb-assets")).toBeVisible();

        await page.screenshot({
          path: "test-results/drama-wb-5-reopen.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );

  // ─── 用例 6:P1 衔接策略层 —— 接缝徽章渲染 + 行内选择器编辑落库 ───
  // 数据准备(storyboard LLM 拆解 / 首镜置 matchcut)与持久化复核走接口;
  // 功能断言(徽章渲染、选择器切换、锚点框、保存)全部真实浏览器驱动 UI。
  test(
    "authed-drama: 分镜接缝徽章渲染,行内选择器切换并落库(刷新仍在)",
    { tag: "@authed" },
    async ({ page }) => {
      const title = `${TITLE_PREFIX}${Date.now()}-F`;
      test.setTimeout(180000); // storyboard 依赖真机 LLM,留足余量
      try {
        await enterDramaDirect(page);
        await createProject(page, title);
        await writeAndSaveScript(page, SAMPLE_SCRIPT);

        // ── 数据准备(接口):LLM 拆解 2 镜 → 首镜置 matchcut+锚点 ──
        const token = await page.evaluate(() =>
          window.localStorage.getItem("toiv_token"),
        );
        const auth = { Authorization: `Bearer ${token}` };
        const listRes = await page.request.get(
          `${API_BASE}/api/drama/projects`,
          { headers: auth },
        );
        const projects = (await listRes.json()) as Array<{
          id: string;
          title: string;
        }>;
        const pid = projects.find((p) => p.title === title)?.id;
        expect(pid, "新建项目应能在列表接口查到").toBeTruthy();
        const sb = await page.request.post(
          `${API_BASE}/api/drama/projects/${pid}/storyboard`,
          { headers: auth, data: { num_shots: 2 }, timeout: 120000 },
        );
        if (!sb.ok()) {
          test.skip(true, `storyboard 依赖真机 LLM,当前不可用(${sb.status()})`);
          return;
        }
        const shots = ((await sb.json()) as { shots: Array<{ id: string }> })
          .shots;
        expect(shots.length).toBeGreaterThanOrEqual(2);
        const prep = await page.request.patch(
          `${API_BASE}/api/drama/shots/${shots[0].id}`,
          {
            headers: auth,
            data: { seam_to_next: "matchcut", seam_anchor: "太刀刀刃" },
          },
        );
        expect(prep.ok()).toBeTruthy();

        // ── UI 断言:重进项目 → 分镜阶段,首镜行出现「接缝·匹配」徽章 ──
        await backToProjectList(page);
        await page.locator(".nsfw-drama-item", { hasText: title }).first().click();
        await expect(page.locator(".wb-root")).toBeVisible({ timeout: 15000 });
        await step(page, "3·分镜").click();
        await expect(page.locator(".wb-shots")).toBeVisible({ timeout: 10000 });
        const firstRow = page.locator(".wb-shot-row").first();
        await expect(
          firstRow.locator(".wb-chip", { hasText: "接缝·匹配" }),
        ).toBeVisible({ timeout: 10000 });

        // ── UI 操作:行内编辑 → 选择器切「重叠」→ 锚点框出现并填写 → 保存 ──
        await firstRow.locator(".wb-prompt").click();
        const seamSelect = page.getByLabel("接缝策略");
        await expect(seamSelect).toBeVisible();
        await seamSelect.selectOption("overlap");
        const anchorInput = page.getByPlaceholder("如:太刀刀刃 / 圆环 / 瞳孔 / 色块");
        await expect(anchorInput).toBeVisible();
        await anchorInput.fill("圆环");
        const patchResp = page.waitForResponse(
          (r) =>
            /\/api\/drama\/shots\/[^/]+$/.test(r.url()) &&
            r.request().method() === "PATCH",
          { timeout: 15000 },
        );
        await page
          .locator(".wb-shot-edit")
          .getByRole("button", { name: "保存" })
          .click();
        await patchResp;
        await expect(
          firstRow.locator(".wb-chip", { hasText: "接缝·重叠" }),
        ).toBeVisible({ timeout: 10000 });

        // ── 持久化:刷新重进,徽章仍在(UI 断言);接口复核落库值 ──
        await page.reload({ waitUntil: "domcontentloaded" });
        await expect(page.locator(".nsfw-drama-create")).toBeVisible({
          timeout: 15000,
        });
        await page.locator(".nsfw-drama-item", { hasText: title }).first().click();
        await expect(page.locator(".wb-root")).toBeVisible({ timeout: 15000 });
        await step(page, "3·分镜").click();
        await expect(
          page
            .locator(".wb-shot-row")
            .first()
            .locator(".wb-chip", { hasText: "接缝·重叠" }),
        ).toBeVisible({ timeout: 10000 });

        const detail = await page.request.get(
          `${API_BASE}/api/drama/projects/${pid}`,
          { headers: auth },
        );
        const persisted = (
          (await detail.json()) as {
            shots: Array<{ idx: number; seam_to_next: string; seam_anchor: string }>;
          }
        ).shots.find((s) => s.idx === 0);
        expect(persisted?.seam_to_next).toBe("overlap");
        expect(persisted?.seam_anchor).toBe("圆环");

        await page.screenshot({
          path: "test-results/drama-wb-6-seam.png",
          fullPage: true,
        });
      } finally {
        await deleteProject(page, title);
      }
    },
  );
});
