import { test, expect, type Page } from "@playwright/test";

/**
 * R18 全局内容模式 E2E 测试(M9:NSFW 整合主站,取代旧 /nsfw 专区 spec)
 *
 * 覆盖:
 * - SFW 基线:引擎/导航/作品库筛选全无 R18 痕迹
 * - 设置页首开 R18:18+ 年龄确认门 → 确认后模式生效并持久化
 * - R18 模式:图像/视频工作台混入 R18 引擎(带徽标)、引擎出处外链、重新检测按钮
 * - 作品库内容分级筛选(全部/SFW/R18)+ R18 作品徽标
 * - 短剧导航项仅 R18 模式可见;SFW 直输 ?view=drama 弹回对话
 * - 模型页 R18 推荐 tab;/nsfw 旧链接重定向不 404;关闭 R18 恢复 SFW
 *
 * 前置:
 * - storageState: .auth/admin.json (由 global-setup.ts 写入)
 * - 后端: http://127.0.0.1:8200;前端: http://localhost:3100
 */

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "会话已过期",
  "Something went wrong",
];

test.describe("R18 全局内容模式", () => {
  test.use({ storageState: ".auth/admin.json" });

  // 前置:确认 storageState 中确实有 token
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
      test.skip(true, "storageState 中无 token,跳过 R18 模式测试");
      return;
    }
  });

  // 辅助:SFW 上下文进入页面(显式清 R18 两个 localStorage 键)
  async function gotoSfw(page: Page, path: string) {
    await page.addInitScript(() => {
      window.localStorage.removeItem("toiv_r18_mode");
      window.localStorage.removeItem("toiv_nsfw_age_confirmed");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      /* dev 模式 networkidle 可能超时,不强制中断 */
    }
  }

  // 辅助:R18 模式进入页面(预置模式 + 年龄确认,跳过设置页开关流程)
  async function gotoR18(page: Page, path: string) {
    await page.addInitScript(() => {
      window.localStorage.setItem("toiv_r18_mode", "1");
      window.localStorage.setItem("toiv_nsfw_age_confirmed", "1");
    });
    await page.goto(path, { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      /* 忽略 */
    }
  }

  // 辅助:等待工作台引擎 Select 加载完成
  async function waitEngineSelect(page: Page) {
    const sel = page.locator('select[aria-label="选择引擎"]');
    await expect(sel).toBeVisible({ timeout: 10000 });
    await expect(sel.locator("option").first()).toBeAttached({ timeout: 10000 });
    return sel;
  }

  // ─── 用例 1:SFW 基线 —— 引擎无 R18、导航无短剧、作品库无 R18 chip ───
  test(
    "authed-r18: SFW 基线主站无 R18 痕迹",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoSfw(page, "/?view=image");

      // 图像工作台引擎下拉:无任何 R18 选项
      const sel = await waitEngineSelect(page);
      const texts = await sel.locator("option").allTextContents();
      expect(texts.length).toBeGreaterThanOrEqual(1);
      for (const t of texts) {
        expect(t).not.toContain("R18");
      }

      // 主导航无「短剧」项
      await page.locator(".cornernav-trigger").click();
      await expect(
        page.locator('.cornernav-items [role="tab"]', { hasText: "短剧" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");

      // 作品库内容分级筛选:只有 全部/SFW,无 R18 chip
      // (LIB-RD 重设计后语义为 button + aria-pressed,不再是 tab/aria-selected)
      await gotoSfw(page, "/?view=library");
      const contentTabs = page.locator('[aria-label="内容分级筛选"]');
      await expect(contentTabs).toBeVisible({ timeout: 10000 });
      await expect(
        contentTabs.getByRole("button", { name: "全部" }),
      ).toBeVisible();
      await expect(
        contentTabs.getByRole("button", { name: "SFW" }),
      ).toBeVisible();
      await expect(
        contentTabs.getByRole("button", { name: "R18" }),
      ).toHaveCount(0);

      // 无错误文案
      const bodyText = await page.locator("body").innerText().catch(() => "");
      const errorFound = ERROR_PATTERNS.some((p) =>
        bodyText.toLowerCase().includes(p.toLowerCase()),
      );
      expect(errorFound, "页面不应包含错误文案").toBe(false);
    },
  );

  // ─── 用例 2:设置页首开 R18 弹年龄确认门,确认后持久化 ───
  test(
    "authed-r18: 首开 R18 弹年龄确认,确认后模式生效",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoSfw(page, "/?view=settings");

      const toggle = page.getByRole("switch", { name: "R18 成人内容模式" });
      await expect(toggle).toBeVisible({ timeout: 10000 });
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      // 首开 → 年龄确认弹层出现,开关未变
      await toggle.click();
      const gate = page.getByRole("dialog", { name: "年龄确认" });
      await expect(gate).toBeVisible({ timeout: 5000 });
      await expect(gate).toContainText("18 岁");
      await expect(toggle).toHaveAttribute("aria-checked", "false");

      // 取消 → 弹层关闭,不写任何记录
      await gate.getByRole("button", { name: "取消" }).click();
      await expect(gate).toHaveCount(0);
      let stored = await page.evaluate(() => ({
        mode: window.localStorage.getItem("toiv_r18_mode"),
        age: window.localStorage.getItem("toiv_nsfw_age_confirmed"),
      }));
      expect(stored.mode).toBeNull();
      expect(stored.age).toBeNull();

      // 再开 → 确认 → 弹层关闭 + 开关 on + localStorage 双键写入
      await toggle.click();
      await expect(gate).toBeVisible({ timeout: 5000 });
      await gate
        .getByRole("button", { name: "我已年满 18 岁,开启 R18 模式" })
        .click();
      await expect(gate).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      stored = await page.evaluate(() => ({
        mode: window.localStorage.getItem("toiv_r18_mode"),
        age: window.localStorage.getItem("toiv_nsfw_age_confirmed"),
      }));
      expect(stored.mode).toBe("1");
      expect(stored.age).toBe("1");

      // 年龄已确认:关闭再开不再弹门
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      await toggle.click();
      await expect(gate).toHaveCount(0);
      await expect(toggle).toHaveAttribute("aria-checked", "true");
    },
  );

  // ─── 用例 3:R18 图像工作台混入 R18 引擎 + 出处外链 + 重新检测 ───
  test(
    "authed-r18: 图像工作台 R18 引擎混入,出处与重新检测可用",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoR18(page, "/?view=image");

      const sel = await waitEngineSelect(page);
      const texts = await sel.locator("option").allTextContents();
      // R18 引擎混入(至少一个 R18 图像引擎),SFW 引擎仍在
      const r18Options = texts.filter((t) => t.includes("R18"));
      expect(r18Options.length).toBeGreaterThanOrEqual(1);
      expect(texts.join()).toContain("文生图");

      // 选中第一个可用 R18 引擎 → 引擎状态区出现 R18 徽标
      const r18Value = await sel
        .locator("option:not([disabled])", { hasText: "R18" })
        .first()
        .getAttribute("value");
      expect(r18Value).toBeTruthy();
      await sel.selectOption(r18Value!);
      await expect(page.locator(".engine-status")).toContainText("R18");

      // 引擎说明卡(2026-08-17 T2 重构:出处自面板首屏收进 ⓘ 说明卡):点 ⓘ 展开,链接 + 出品方
      await page.locator(".engine-info-btn").click();
      const source = page.locator(".engine-info-card");
      await expect(source).toBeVisible();
      const link = source.locator("a").first();
      await expect(link).toBeVisible();
      const href = await link.getAttribute("href");
      expect(href).toMatch(/^https?:\/\//);

      // 重新检测按钮可点(点击后出现检测中文案或保持可用)
      const refreshBtn = page.locator(".engine-refresh");
      await expect(refreshBtn).toBeVisible();
      await refreshBtn.click();
      // 检测完成后引擎下拉仍有选项(不崩溃即恢复)
      await expect(sel.locator("option").first()).toBeAttached({
        timeout: 15000,
      });

      await page.screenshot({
        path: "test-results/r18-image-workbench.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 4:R18 视频工作台混入 R18 视频引擎(LTX/H3 双路线)───
  test(
    "authed-r18: 视频工作台 R18 引擎与 SFW 引擎并存",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoR18(page, "/?view=video");

      const sel = await waitEngineSelect(page);
      const texts = await sel.locator("option").allTextContents();
      const joined = texts.join();
      // SFW 视频引擎仍在
      expect(joined).toContain("文生视频");
      // R18 视频引擎混入(LTX 2.3 R18 / MiniMax H3 R18 至少其一)
      const r18Options = texts.filter((t) => t.includes("R18"));
      expect(r18Options.length).toBeGreaterThanOrEqual(1);

      await page.screenshot({
        path: "test-results/r18-video-workbench.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 5:作品库内容分级筛选 R18 chip 出现且可切换 ───
  test(
    "authed-r18: 作品库出现 R18 筛选 chip",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoR18(page, "/?view=library");

      const contentTabs = page.locator('[aria-label="内容分级筛选"]');
      await expect(contentTabs).toBeVisible({ timeout: 10000 });
      // LIB-RD 语义:button + aria-pressed(原 tab/aria-selected)
      const r18Tab = contentTabs.getByRole("button", { name: "R18" });
      await expect(r18Tab).toBeVisible();
      await expect(r18Tab).toHaveAttribute("aria-pressed", "false");

      // 切到 R18:只展示 R18 作品(无 R18 作品时空态,chip 行为本身正确即可)
      await r18Tab.click();
      await expect(r18Tab).toHaveAttribute("aria-pressed", "true");

      // 切回全部
      await contentTabs.getByRole("button", { name: "全部" }).click();
      await expect(
        contentTabs.getByRole("button", { name: "全部" }),
      ).toHaveAttribute("aria-pressed", "true");
    },
  );

  // ─── 用例 6:R18 模式短剧工作台仍可达(2026-08-29 导航项已移除,改直链进入) ───
  test(
    "authed-r18: 短剧导航项已收(融合创作工作室承载),直链仍进短剧工作台",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoR18(page, "/");

      // 灵动岛不再有「短剧」项(融合页「创作工作室」承载同职责)
      await page.locator(".cornernav-trigger").click();
      await expect(
        page.locator('.cornernav-items [role="tab"]', { hasText: "短剧" }),
      ).toHaveCount(0);
      await page.keyboard.press("Escape");

      // 直链进短剧工作台(R18 门控放行)
      await gotoR18(page, "/?view=drama");
      await expect(page.locator(".nsfw-drama")).toBeVisible({ timeout: 10000 });
      await expect(page.locator(".nsfw-drama-side")).toBeVisible();
      await expect(page.getByText("选择或新建一个短剧项目")).toBeVisible();

      await page.screenshot({
        path: "test-results/r18-drama-view.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 7:SFW 模式直输 ?view=drama 弹回融合页(2026-08-17 助手底层化,回落目标 fusion) ───
  test(
    "authed-r18: SFW 直输短剧 URL 弹回融合",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoSfw(page, "/?view=drama");
      // 门控 effect 弹回 fusion:短剧工作台不渲染,当前视图显示「融合」
      await page.waitForTimeout(1500); // 等门控 effect 执行
      await expect(page.locator(".nsfw-drama")).toHaveCount(0);
      await expect(page.locator(".cornernav-current")).toContainText("融合");
    },
  );

  // ─── 用例 8:模型页出现 R18 推荐 tab 并可切换 ───
  test(
    "authed-r18: 模型页 R18 推荐 tab 可见",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoR18(page, "/?view=models");

      const r18Tab = page.getByRole("tab", { name: /R18 推荐/ });
      await expect(r18Tab).toBeVisible({ timeout: 10000 });
      await r18Tab.click();
      await expect(r18Tab).toHaveAttribute("aria-selected", "true");

      // SFW 模式该 tab 不出现
      await gotoSfw(page, "/?view=models");
      await expect(
        page.getByRole("tab", { name: /R18 推荐/ }),
      ).toHaveCount(0);
    },
  );

  // ─── 用例 9:/nsfw 旧链接重定向首页不 404 ───
  test(
    "authed-r18: /nsfw 旧链接重定向不 404",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoSfw(page, "/nsfw");
      // redirect("/") → 落到首页(app shell 或登录落地页,均非 404)
      await page.waitForURL(/\/$|\?/, { timeout: 10000 }).catch(() => {});
      const bodyText = await page.locator("body").innerText().catch(() => "");
      expect(bodyText).not.toContain("404");
      expect(bodyText).not.toContain("This page could not be found");
    },
  );

  // ─── 用例 10:关闭 R18 后全站恢复 SFW ───
  test(
    "authed-r18: 关闭 R18 恢复 SFW 视图",
    { tag: "@authed" },
    async ({ page }) => {
      // 先以 R18 模式进设置页,关开关
      await gotoR18(page, "/?view=settings");
      const toggle = page.getByRole("switch", { name: "R18 成人内容模式" });
      await expect(toggle).toBeVisible({ timeout: 10000 });
      await expect(toggle).toHaveAttribute("aria-checked", "true");
      await toggle.click();
      await expect(toggle).toHaveAttribute("aria-checked", "false");
      const mode = await page.evaluate(() =>
        window.localStorage.getItem("toiv_r18_mode"),
      );
      expect(mode).toBeNull();

      // 图像工作台:R18 引擎消失(不硬刷,靠事件广播重拉)。
      // 注意:必须用应用内导航 —— 本用例 addInitScript 会在 page.goto 重载时
      // 把 toiv_r18_mode=1 写回去,硬刷永远测不到「关闭后」状态。
      await page.locator(".cornernav-trigger").click();
      await page
        .locator('.cornernav-items [role="tab"]', { hasText: "图片" })
        .click();
      const sel = await waitEngineSelect(page);
      // 等引擎列表按 SFW 上下文重拉完成(R18 选项消失)再断言
      await expect
        .poll(async () =>
          (await sel.locator("option").allTextContents()).some((t) =>
            t.includes("R18"),
          ),
        )
        .toBe(false);
      const texts = await sel.locator("option").allTextContents();
      for (const t of texts) {
        expect(t).not.toContain("R18");
      }

      // 导航短剧项消失(重开导航面板确认)
      await page.locator(".cornernav-trigger").click();
      await expect(
        page.locator('.cornernav-items [role="tab"]', { hasText: "短剧" }),
      ).toHaveCount(0);
    },
  );
});
