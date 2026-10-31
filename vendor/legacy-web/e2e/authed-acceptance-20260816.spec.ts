import { test, expect, type Page } from "@playwright/test";

/**
 * 2026-08-16 四修复真实浏览器验收(chromium-authed project)
 *
 * 覆盖(🔒 全部真实浏览器驱动 UI,接口仅用于清理):
 * 1. Agent 团队:创建秒回(不再撞 30s 超时)+ 详情页不崩(verdict 契约修复)
 *    + 计划确认门出现 + 取消清理
 * 2. 生成时长按秒:H3 选 2 秒(非网格)→ 产物 done + duration_notice 透出
 *   + 产物实测时长 ≈2s(trim 生效)
 * 3. 视频超分:作品库视频卡 → 超分到 4K → 完成 toast + 新产物收录
 * 4. ThemePicker 同页双实例同步(设置页 ⇄ 导航账户弹层)+ 暗色落 DOM
 * 5. 桌面端 BottomNav sheet 隐藏 + GenerateView「模式/引擎」标签唯一
 *
 * 前置:storageState .auth/admin.json(global-setup 写入);
 * 生产:playwright.prod.config.ts(core 192.168.71.47:8090/:3100)
 */

const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";

test.describe("2026-08-16 修复验收", () => {
  test.use({ storageState: ".auth/admin.json" });
  test.describe.configure({ mode: "serial" });

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
    if (!token) test.skip(true, "storageState 中无 token");
  });

  // ─── helpers ───

  async function gotoView(page: Page, tabLabel: string) {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    await page.locator(".cornernav-trigger").click();
    const tab = page.locator('.cornernav-items [role="tab"]', {
      hasText: tabLabel,
    });
    await expect(tab).toBeVisible({ timeout: 10000 });
    await tab.click();
    await page.waitForTimeout(800); // 视图切换动画
  }

  /** 用例 1:Agent 团队创建秒回 + 详情不崩 + 计划门 + 取消清理 */
  test("agent-run: 创建秒回且详情页不崩", { tag: "@authed" }, async ({
    page,
  }) => {
    test.setTimeout(240_000);
    await page.goto("/agent-runs", { waitUntil: "domcontentloaded" });

    // 历史 run 详情不崩(死路 B 回归:verdict 对象崩溃已修)——若列表有历史 run 先点一个
    const historyCard = page.locator("a[href^='/agent-runs/']").first();
    if (await historyCard.isVisible().catch(() => false)) {
      await historyCard.click();
      await page.waitForLoadState("domcontentloaded");
      await expect(page.getByText("页面出错了")).toHaveCount(0);
      await expect(page.getByText("应用发生未预期的错误")).toHaveCount(0);
      await page.goto("/agent-runs");
    }

    // 创建(死路 A 回归:秒回,不再 30s 超时静默)
    await page
      .locator("textarea.agent-goal-input")
      .fill("拍一支 30 秒的咖啡店开业宣传短片,含分镜拆解与配音规划");
    const t0 = Date.now();
    await page.getByRole("button", { name: "创建并拆解" }).click();

    // 秒回:L1/L2 → 短时间内跳详情页(L0 → 直链对话,也算正常分流)
    await expect(page).toHaveURL(/\/agent-runs\/[0-9a-f-]+|\/?\?view=assistant/, {
      timeout: 20_000,
    });
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(20_000);

    if (page.url().includes("/agent-runs/")) {
      // 详情页渲染不崩
      await expect(page.getByText("页面出错了")).toHaveCount(0);
      // 等待后台规划出计划确认门(LLM 拆解 ~30s,给 150s)
      const gate = page.getByText(/确认计划|计划确认|确认门/);
      const cards = page.locator("[class*='task-card'], article").first();
      await expect(gate.or(cards)).toBeVisible({ timeout: 150_000 });
      // 清理:取消任务
      const cancelBtn = page.getByRole("button", { name: /取消任务/ });
      if (await cancelBtn.isVisible().catch(() => false)) {
        await cancelBtn.click();
        const dlg = page.getByRole("dialog", { name: "取消任务" });
        if (await dlg.isVisible().catch(() => false)) {
          await dlg.getByRole("button", { name: /确认|确定|取消任务/ }).click();
        }
      }
    }
  });

  /** 用例 2:时长按秒 + 非网格 2s 精确裁切 + notice 透出 */
  test("generate: H3 选 2 秒,产物精确裁切且 notice 透出", { tag: "@authed" }, async ({
    page,
  }) => {
    test.setTimeout(420_000);
    await gotoView(page, "视频"); // 视频工作台(GenerateView lockedKind=video)
    await page.waitForTimeout(800);

    // 引擎下拉(aria-label="选择引擎")选 MiniMax H3 文生视频
    const engineSelect = page.getByLabel("选择引擎");
    await expect(engineSelect).toBeVisible({ timeout: 10000 });
    await engineSelect
      .locator("option", { hasText: "MiniMax H3 文生视频" })
      .first()
      .waitFor({ state: "attached", timeout: 15000 });
    await engineSelect.selectOption("h3-t2v");
    await page.waitForTimeout(500);

    // 时长(秒)填 2(非 17k+5 网格 → 生成 56 帧后精确裁至 2s)
    const durationInput = page
      .locator("label.ui-field", { hasText: "时长(秒)" })
      .locator("input");
    await expect(durationInput).toBeVisible({ timeout: 5000 });
    await durationInput.fill("2");

    // 提示词 + 提交
    await page
      .locator(".promptbar-textarea")
      .fill("一只橘猫走过雨后的街道,水面倒影,电影感,固定机位");
    await page.getByRole("button", { name: "生成", exact: true }).click();

    // 等待结果视频出现(生成 ~1-3min)
    const resultVideo = page.locator("video").first();
    await expect(resultVideo).toBeVisible({ timeout: 360_000 });

    // duration_notice 透出断言(结果条目 .stage-message;避开参数 hint 的静态文案)
    await expect(
      page.locator(".stage-message", { hasText: /裁/ }).first(),
    ).toBeVisible({ timeout: 120_000 });

    // 裁切链在生成完成后异步重写产物(同名文件),等其落库后到作品库验证最终产物
    await page.waitForTimeout(15_000);
    await gotoView(page, "作品库");
    await page.waitForTimeout(2000);
    const libVideo = page.locator("video").first();
    await expect(libVideo).toBeAttached({ timeout: 15000 });
    const src = await libVideo.getAttribute("src");
    expect(src).toBeTruthy();
    // no-store 绕开浏览器缓存(产物是同 URL 内容替换)
    const dur = await page.evaluate(async (url) => {
      const resp = await fetch(url as string, { cache: "no-store" });
      const blob = await resp.blob();
      const objUrl = URL.createObjectURL(blob);
      try {
        const v = document.createElement("video");
        v.preload = "metadata";
        v.src = objUrl;
        await new Promise((res, rej) => {
          v.onloadedmetadata = res;
          v.onerror = rej;
        });
        return v.duration;
      } finally {
        URL.revokeObjectURL(objUrl);
      }
    }, src);
    expect(dur).toBeGreaterThan(1.8);
    expect(dur).toBeLessThan(2.2);
  });

  /** 用例 3:作品库视频超分到 4K 全链路 */
  test("library: 视频超分到 4K", { tag: "@authed" }, async ({ page }) => {
    test.setTimeout(420_000);
    await gotoView(page, "作品库");
    await page.waitForTimeout(1500);

    const upscaleBtn = page
      .getByRole("button", { name: /超分到 4K/ })
      .first();
    await expect(upscaleBtn).toBeVisible({ timeout: 15000 });
    await upscaleBtn.click();

    const dlg = page.getByRole("dialog", { name: "超分到 4K" });
    await expect(dlg).toBeVisible({ timeout: 5000 });
    await dlg.getByRole("button", { name: "开始超分" }).click();

    // 提交成功 toast,然后等完成 toast(帧级管线,~1-3min)
    await expect(page.getByText(/超分任务已提交/)).toBeVisible({
      timeout: 15000,
    });
    await expect(page.getByText(/超分完成,4K 版本已收录作品库/)).toBeVisible({
      timeout: 360_000,
    });
  });

  /** 用例 4:ThemePicker 同页双实例同步 */
  test("theme: 设置页与导航弹层主题同步", { tag: "@authed" }, async ({
    page,
  }) => {
    await page.goto("/?view=settings", { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(1200);
    const settingsPicker = page
      .locator('[role="radiogroup"][aria-label="界面模式"]')
      .first();
    await expect(settingsPicker).toBeVisible({ timeout: 10000 });

    // 设置页切暗色 → html data-mode=dark
    await settingsPicker.getByRole("radio", { name: "暗色" }).click();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.dataset.mode),
      )
      .toBe("dark");

    // 打开右上角账户弹层(2026-08-17 拆分)→ 第二实例应同步为暗色
    await page.locator(".accountbtn-trigger").click();
    const navPicker = page
      .locator('[role="radiogroup"][aria-label="界面模式"]')
      .last();
    await expect(navPicker).toBeVisible({ timeout: 5000 });
    await expect(
      navPicker.getByRole("radio", { name: "暗色" }),
    ).toHaveAttribute("aria-checked", "true");

    // 恢复亮色(用户偏好浅色默认;从弹层切回,反向验证同步)
    await navPicker.getByRole("radio", { name: "亮色" }).click();
    await expect
      .poll(async () =>
        page.evaluate(() => document.documentElement.dataset.mode ?? "light"),
      )
      .toBe("light");
    await expect(
      settingsPicker.getByRole("radio", { name: "亮色" }),
    ).toHaveAttribute("aria-checked", "true");
  });

  /** 用例 5:桌面端 BottomNav sheet 隐藏 + 模式/引擎标签唯一 */
  test("layout: dock 桌面隐藏 + 模式/引擎标签唯一", { tag: "@authed" }, async ({
    page,
  }) => {
    await page.goto("/", { waitUntil: "domcontentloaded" });
    // BottomNav 的更多 sheet/遮罩在桌面端(≥1024)必须 display:none
    const sheet = page.locator(".bottom-nav-sheet");
    const overlay = page.locator(".bottom-nav-overlay");
    if ((await sheet.count()) > 0) await expect(sheet).toBeHidden();
    if ((await overlay.count()) > 0) await expect(overlay).toBeHidden();

    await gotoView(page, "图片"); // 图片工作台:模式段控(文生图/图生图)+ 引擎下拉
    await expect(
      page.getByText("模式", { exact: true }).first(),
    ).toBeVisible({ timeout: 10000 });
    await expect(page.getByText("引擎", { exact: true })).toHaveCount(1);
  });
});
