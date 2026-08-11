import { test, expect, type Page } from "@playwright/test";

/**
 * NSFW 专区 E2E 测试 (登录态)
 *
 * 覆盖:
 * - NsfwView 的 image/video tab 切换 + 推荐清单折叠(壳不变)
 * - 统一生成工作台(GenerateView)内嵌:只展示 R18 引擎,不混入 SFW 引擎
 * - 图像 tab:R18 底模/采样器/调度器/风格预设参数;视频 tab:高清放大/RIFE/高级参数
 *
 * 前置:
 * - storageState: .auth/admin.json (由 global-setup.ts 写入)
 * - 后端: http://127.0.0.1:8200
 * - 前端: http://localhost:3100
 *
 * 说明:
 * 文件名为 nsfw.spec.ts(非 authed- 前缀),会被 chromium-guest project 拾取。
 * 通过 test.use({ storageState }) 在测试级注入登录态,等效于 authed project。
 */

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
  "会话已过期",
  "Something went wrong",
];

test.describe("NSFW 专区", () => {
  // 测试级注入登录态(因为文件名非 authed- 前缀,不会被 chromium-authed project 拾取)
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
      test.skip(true, "storageState 中无 token,跳过 NSFW 测试");
      return;
    }
  });

  // 辅助:导航到 /nsfw 并等待鉴权完成(banner 出现表示 auth=in)
  // 预置年龄确认记录(真实用户首访会弹 18+ 确认门,功能用例跳过)
  async function gotoNsfw(page: Page) {
    await page.addInitScript(() => {
      window.localStorage.setItem("toiv_nsfw_age_confirmed", "1");
    });
    await page.goto("/nsfw", { waitUntil: "domcontentloaded" });
    try {
      await page.waitForLoadState("networkidle", { timeout: 15000 });
    } catch {
      // dev 模式 networkidle 可能超时,不强制中断
    }
    const banner = page.locator(".nsfw-header");
    try {
      await expect(banner).toBeVisible({ timeout: 10000 });
    } catch {
      const gate = page.locator(".nsfw-gate");
      if (await gate.count()) {
        throw new Error(
          "鉴权失败:NsfwView 显示了登录门(可能 token 失效)",
        );
      }
      throw new Error("NsfwView 主视图未出现(10s 超时)");
    }
  }

  // 辅助:等待内嵌工作台引擎列表加载完成(引擎 Select 出现选项)
  async function waitEngineSelect(page: Page) {
    const sel = page.locator('select[aria-label="选择引擎"]');
    await expect(sel).toBeVisible({ timeout: 10000 });
    await expect(sel.locator("option").first()).toBeAttached({ timeout: 10000 });
    return sel;
  }

  // ─── 用例 1:页面加载并显示 R18 banner ───
  test(
    "authed-nsfw: 页面加载并显示 R18 banner",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // banner 可见
      await expect(page.locator(".nsfw-header")).toBeVisible();

      // badge 含 "18+"
      const badge = page.locator(".nsfw-badge");
      await expect(badge).toBeVisible();
      await expect(badge).toContainText("18+");

      // 无错误文案
      const bodyText = await page
        .locator("body")
        .innerText()
        .catch(() => "");
      const errorFound = ERROR_PATTERNS.some((p) =>
        bodyText.toLowerCase().includes(p.toLowerCase()),
      );
      expect(errorFound, "页面不应包含错误文案").toBe(false);

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-banner.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 2:默认图像 tab,内嵌 GenerateView 只含 R18 图像引擎 ───
  test(
    "authed-nsfw: 图像 tab 内嵌统一工作台且只含 R18 引擎",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // tab 容器可见,默认 active 是"图像"
      await expect(page.locator(".nsfw-tabs")).toBeVisible();
      const imageTab = page.getByRole("tab", { name: "图像" });
      await expect(imageTab).toHaveAttribute("aria-selected", "true");
      await expect(page.getByRole("tab", { name: "视频" })).toHaveAttribute(
        "aria-selected",
        "false",
      );

      // 统一生成工作台(剧场版 UI)渲染,旧 CreateView 不复存在
      await expect(page.locator(".generate-view")).toBeVisible({ timeout: 10000 });
      await expect(page.locator(".create-view")).toHaveCount(0);

      // 引擎 Select:只含 R18 图像引擎(文生图/图生图),无 SFW/视频引擎混入
      const sel = await waitEngineSelect(page);
      const options = sel.locator("option");
      const texts = await options.allTextContents();
      expect(texts.length).toBeGreaterThanOrEqual(1);
      for (const t of texts) {
        expect(t).toContain("R18");
      }
      expect(texts.join()).toContain("文生图");

      // 提示词条可见
      await expect(page.locator(".promptbar-textarea")).toBeVisible();

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-image-workbench.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 3:图像参数面板(R18 底模/采样器/调度器/风格预设)───
  test(
    "authed-nsfw: 图像参数面板含底模/采样/风格预设",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);
      await waitEngineSelect(page);

      const panel = page.locator(".generate-params");
      await expect(panel).toBeVisible();

      // 底模 select:R18 上下文后端动态注入,选项只含 NSFW ckpt,不含平台默认/SFW 项
      // (worker 不可达时注册表回退「平台默认底模」兜底项,此时跳过严格断言避免环境抖动)
      const ckpt = panel.locator("select").nth(1); // 第 0 个是引擎 select
      await expect(ckpt).toBeVisible();
      const ckptTexts = await ckpt.locator("option").allTextContents();
      expect(ckptTexts.length).toBeGreaterThanOrEqual(1);
      if (!ckptTexts.join().includes("平台默认底模")) {
        expect(ckptTexts.length).toBeGreaterThanOrEqual(1);
        // 动态注入成功:选项应是 R18 ckpt 文件名
        expect(ckptTexts.join()).toContain("safetensors");
      }

      // 采样器 / 调度器 / 风格预设字段在面板中
      await expect(panel.getByText("采样器", { exact: true })).toBeVisible();
      await expect(panel.getByText("调度器", { exact: true })).toBeVisible();
      await expect(panel.getByText("风格预设", { exact: true })).toBeVisible();

      // 高级参数折叠区存在(负向/步数/CFG/种子)
      await expect(panel.locator("details.adv-params summary")).toContainText(
        "高级参数",
      );
    },
  );

  // ─── 用例 4:切到视频 tab,只含 R18 视频引擎 + LTX 参数齐 ───
  test(
    "authed-nsfw: 视频 tab 只含 R18 引擎且参数齐",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);
      await page.getByRole("tab", { name: "视频" }).click();

      await expect(page.locator(".generate-view")).toBeVisible({ timeout: 10000 });
      // 旧 NsfwVideoView 不复存在
      await expect(page.locator(".nsv-view")).toHaveCount(0);

      // 文生/图生分组段控(ltx-nsfw-t2v/i2v 两组都有 → 显示)
      await expect(
        page.getByRole("tab", { name: "文生视频" }),
      ).toBeVisible({ timeout: 10000 });
      await expect(page.getByRole("tab", { name: "图生视频" })).toBeVisible();

      // 引擎 Select:只含 R18 视频引擎
      const sel = await waitEngineSelect(page);
      const texts = await sel.locator("option").allTextContents();
      expect(texts.length).toBeGreaterThanOrEqual(1);
      for (const t of texts) {
        expect(t).toContain("R18");
      }
      expect(texts.join()).toContain("文生视频");

      // LTX 视频参数:高清放大 / RIFE 开关 + 时长/帧率字段 + 高级参数
      const panel = page.locator(".generate-params");
      await expect(panel.getByText("高清放大(2 阶段)", { exact: true })).toBeVisible();
      await expect(panel.getByText("RIFE 补帧", { exact: true })).toBeVisible();
      await expect(panel.getByText("时长(帧)", { exact: true })).toBeVisible();
      await expect(panel.getByText("帧率", { exact: true })).toBeVisible();
      await expect(panel.locator("details.adv-params summary")).toContainText(
        "高级参数",
      );

      // 切到图生视频组 → 参考图上传区出现
      await page.getByRole("tab", { name: "图生视频" }).click();
      await expect(panel.getByText("参考图", { exact: true })).toBeVisible({
        timeout: 5000,
      });

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-video-workbench.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 5:首访弹 18+ 年龄确认门,确认后写 localStorage 不再弹 ───
  test(
    "authed-nsfw: 首访年龄确认门,确认后不再弹",
    { tag: "@authed" },
    async ({ page }) => {
      // 不预置 toiv_nsfw_age_confirmed:模拟首次访问
      await page.goto("/nsfw", { waitUntil: "domcontentloaded" });

      // 年龄确认门出现,专区主体不可见
      const gate = page.locator(".nsfw-age-gate");
      await expect(gate).toBeVisible({ timeout: 10000 });
      await expect(gate).toContainText("18 岁");
      await expect(page.locator(".nsfw-header")).toHaveCount(0);

      // 确认 → 门消失,专区主体出现
      await page
        .getByRole("button", { name: "我已年满 18 岁,进入专区" })
        .click();
      await expect(page.locator(".nsfw-header")).toBeVisible({ timeout: 10000 });

      // localStorage 已记录;重新导航不再弹门
      const confirmed = await page.evaluate(() =>
        window.localStorage.getItem("toiv_nsfw_age_confirmed"),
      );
      expect(confirmed).toBe("1");
      await page.goto("/nsfw", { waitUntil: "domcontentloaded" });
      await expect(page.locator(".nsfw-header")).toBeVisible({ timeout: 10000 });
      await expect(page.locator(".nsfw-age-gate")).toHaveCount(0);
    },
  );

  // ─── 用例 6:短剧 tab 可见且可切换,内嵌 drama 工作台壳 ───
  test(
    "authed-nsfw: 短剧 tab 可见并内嵌 drama 工作台",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      // 短剧 tab 存在,默认未选中,位于作品库之前
      const dramaTab = page.getByRole("tab", { name: "短剧" });
      await expect(dramaTab).toBeVisible();
      await expect(dramaTab).toHaveAttribute("aria-selected", "false");

      // 切换 → 选中态 + scoped 工作台壳渲染(项目列表侧栏 + 空态提示)
      await dramaTab.click();
      await expect(dramaTab).toHaveAttribute("aria-selected", "true");
      await expect(page.locator(".nsfw-drama")).toBeVisible({ timeout: 10000 });
      await expect(page.locator(".nsfw-drama-side")).toBeVisible();
      await expect(page.getByText("选择或新建一个短剧项目")).toBeVisible();

      // 不混入统一生成工作台 / 作品库
      await expect(page.locator(".generate-view")).toHaveCount(0);

      // 截图存档
      await page.screenshot({
        path: "test-results/nsfw-drama-tab.png",
        fullPage: true,
      });
    },
  );

  // ─── 用例 7:NSFW 推荐模型清单可折叠 ───
  test(
    "authed-nsfw: NSFW 推荐模型清单可折叠",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);

      const recsToggle = page.locator(".nsfw-recs-toggle");
      await expect(recsToggle).toBeVisible();

      // 默认折叠(aria-expanded=false)
      await expect(recsToggle).toHaveAttribute("aria-expanded", "false");

      // 点击展开
      await recsToggle.click();
      await expect(recsToggle).toHaveAttribute("aria-expanded", "true");

      // 推荐区域容器可见(可能为空 empty-state,但 grid 容器应渲染)
      await expect(page.locator(".nsfw-recs-grid")).toBeVisible();

      // 再次点击折叠
      await recsToggle.click();
      await expect(recsToggle).toHaveAttribute("aria-expanded", "false");
    },
  );

  // ─── 用例 8:短剧工作台完整面板(抽卡/任务日志/资产库/宫格/AI 润色入口存在)───
  test(
    "authed-nsfw: 短剧工作台四面板入口存在",
    { tag: "@authed" },
    async ({ page }) => {
      await gotoNsfw(page);
      await page.getByRole("tab", { name: "短剧" }).click();
      await expect(page.locator(".nsfw-drama")).toBeVisible({ timeout: 10000 });

      // 新建一个临时项目(纯 DB 操作,不触发 GPU 生成)
      const title = `E2E面板验证${Date.now() % 100000}`;
      await page.locator(".nsfw-drama-create input").fill(title);
      await page.getByRole("button", { name: "新建项目" }).click();

      // 工作台渲染:头部批量操作 + 资产库入口
      await expect(page.getByRole("button", { name: "资产库" })).toBeVisible({
        timeout: 15000,
      });
      await expect(page.getByRole("button", { name: /合成成片/ })).toBeVisible();

      // 剧本区:AI 润色 + AI 拆分镜入口
      await expect(page.getByRole("button", { name: "AI 润色" })).toBeVisible();
      await expect(page.getByRole("button", { name: /AI 拆分镜/ })).toBeVisible();

      // 分镜区:宫格分镜入口(需先有剧本;点击出现 9/25 picker)
      await page.locator(".nsfw-dd-script").fill("E2E 临时剧本:两个角色对话。");
      await page.getByRole("button", { name: /宫格分镜/ }).click();
      await expect(page.getByRole("button", { name: /9 宫格/ })).toBeVisible();
      await expect(page.getByRole("button", { name: /25 宫格/ })).toBeVisible();

      // 资产库面板:打开可见 kind 过滤,关闭
      await page.getByRole("button", { name: "资产库" }).click();
      await expect(page.locator(".nsfw-asset")).toBeVisible();
      await expect(
        page.locator(".nsfw-asset-kind", { hasText: "角色" }),
      ).toBeVisible();
      await page.locator(".nsfw-asset-close").click();
      await expect(page.locator(".nsfw-asset")).toHaveCount(0);

      // 侧栏任务日志面板
      await expect(page.locator(".nsfw-tlog")).toBeVisible();

      // 清理:删除临时项目(confirm 对话框自动接受)
      page.on("dialog", (d) => void d.accept());
      await page.locator(".nsfw-drama-item", { hasText: title }).hover();
      await page
        .locator(".nsfw-drama-item", { hasText: title })
        .locator(".nsfw-drama-item-del")
        .click();
      await expect(
        page.locator(".nsfw-drama-item", { hasText: title }),
      ).toHaveCount(0, { timeout: 10000 });
    },
  );
});
