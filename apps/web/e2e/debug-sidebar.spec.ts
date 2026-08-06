import { test, expect, type ConsoleMessage } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * 调试脚本:连续通过左侧栏切换视图,验证导航稳定性。
 *
 * 背景(W0/W3 UI 重构后):主导航已从 DynamicIsland 迁移为左侧栏 + 底部导航。
 * - 桌面端:顶部灵动岛 nav.island,视图按钮为 .island-item(直接点击切换)
 * - 移动端:nav.app-bottom-nav(.bottom-nav-item + 「更多」抽屉 .more-nav-item)
 * - 全局顶栏 header.topbar 已移除(--topbar-h: 0px)
 * - M1 退役 create/generate/ltxstudio 视图,?view=generate 会前端重定向到 ?view=image
 *
 * 测试流程:
 * 1. 登录态打开 /?view=assistant
 * 2. 通过灵动岛 .island-item 依次切换视图(不重新加载页面)
 * 3. 每次切换后:
 *    - 等待 1.2s 让视图渲染
 *    - 截图保存到 test-results/sidebar-click-{view}-{idx}.png
 *    - 记录 URL / app-shell 可见 / 登录页 / 错误文案 / 控制台错误 / 页面错误
 * 4. 输出详细调试报告(JSON + 控制台表格)
 */

// 手动注入 storageState(因文件名不匹配 authed-* 前缀)
test.use({ storageState: ".auth/admin.json" });

// 侧栏中实际存在的视图(page.tsx 的 SIDEBAR_ITEMS 列表)
// 注意:models/train/backlot/admin/animatic/studio 不在侧栏一级导航中,只能通过 URL 直接访问
// (studio 经融合页/底部「更多」进入;旧 dramaStudio/manju 已重定向到 studio)
const VIEW_FLOW: { key: string; label: string }[] = [
  { key: "assistant",   label: "对话" },       // 初始视图,通过 goto 进入
  { key: "image",       label: "图片" },
  { key: "video",       label: "视频" },
  { key: "audio",       label: "音频" },
  { key: "fusion",      label: "融合" },
  { key: "canvas",      label: "画布" },
  { key: "library",     label: "作品库" },
  { key: "resources",   label: "资源" },
  { key: "assistant",   label: "对话" },       // 回到 assistant,验证可恢复
];

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "会话已过期",
  "Something went wrong",
  "未授权",
  "Unauthorized",
  "Forbidden",
  "TypeError",
  "ReferenceError",
  "Cannot read",
  "is not defined",
  "is not a function",
];

/** HTTP 500 文案检测:必须独立出现(前后非数字),避免作品库 seed 长数字(如 ...775000)误报。 */
const HTTP_500_RE = /(?<!\d)500(?!\d)/;

interface ClickResult {
  step: number;
  viewKey: string;
  viewLabel: string;
  url: string;
  islandVisible: boolean;
  appShellVisible: boolean;
  isLandingPage: boolean;
  redirectedToLogin: boolean;
  errorPatterns: string[];
  newConsoleErrors: { type: string; text: string; url?: string }[];
  newPageErrors: string[];
  screenshotPath: string;
  durationMs: number;
  crashed: boolean;
  crashReasons: string[];
  clickError?: string | null;
}

test.describe("灵动岛导航调试 @authed", () => {
  test("连续切换灵动岛视图,捕获崩溃", { tag: "@authed" }, async ({ page }) => {
    test.setTimeout(120000);

    const resultsDir = "test-results/sidebar-debug";
    if (!fs.existsSync(resultsDir)) {
      fs.mkdirSync(resultsDir, { recursive: true });
    }
    if (!fs.existsSync("test-results")) {
      fs.mkdirSync("test-results", { recursive: true });
    }

    const allConsoleErrors: { type: string; text: string; url?: string; line?: number; column?: number }[] = [];
    const allPageErrors: string[] = [];
    const results: ClickResult[] = [];

    page.on("console", (msg: ConsoleMessage) => {
      if (msg.type() === "error") {
        const loc = msg.location();
        allConsoleErrors.push({
          type: msg.type(),
          text: msg.text(),
          url: loc?.url,
          line: loc?.lineNumber,
          column: loc?.columnNumber,
        });
      }
    });

    page.on("pageerror", (err: Error) => {
      const text = err.stack ?? err.message;
      // 跨域 iframe(ComfyUI 画布)的异常透传为空消息/"Script error.",不计入本应用崩溃
      if (!text || /^script error/i.test(text)) return;
      allPageErrors.push(text);
    });

    page.on("dialog", async (d) => {
      await d.dismiss();
    });

    // ── 步骤 1:打开默认视图 ──────────────────────────
    const stepStart = Date.now();
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });

    try {
      await expect(page.locator(".app-shell")).toBeVisible({ timeout: 15000 });
    } catch {
      // 即使 app-shell 未出现也继续走完流程,记录崩溃
    }
    await page.waitForTimeout(1500);

    const initialShot = "test-results/sidebar-click-assistant-0.png";
    await page.screenshot({ path: initialShot, fullPage: true });

    const initial = await captureState(
      page,
      1,
      "assistant",
      "对话",
      initialShot,
      Date.now() - stepStart,
      allConsoleErrors.slice(),
      allPageErrors.slice(),
    );
    results.push(initial);

    // ── 步骤 2~N:通过侧栏切换视图 ────────────────────
    for (let i = 1; i < VIEW_FLOW.length; i++) {
      const { key, label } = VIEW_FLOW[i];
      const t0 = Date.now();

      const consoleErrorsBefore = allConsoleErrors.length;
      const pageErrorsBefore = allPageErrors.length;

      let clickOk = true;
      let clickError: string | null = null;

      try {
        await selectViewViaIsland(page, label);
      } catch (e) {
        clickOk = false;
        clickError = e instanceof Error ? e.message : String(e);
      }

      // 等待 1.2s 让视图渲染
      await page.waitForTimeout(1200);

      // 截图
      const screenshotPath = `test-results/sidebar-click-${key}-${i}.png`;
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // 截图失败忽略
      }

      const newConsoleErrors = allConsoleErrors.slice(consoleErrorsBefore);
      const newPageErrors = allPageErrors.slice(pageErrorsBefore);

      const result = await captureState(
        page,
        i + 1,
        key,
        label,
        screenshotPath,
        Date.now() - t0,
        newConsoleErrors,
        newPageErrors,
      );

      if (!clickOk) {
        result.crashed = true;
        result.crashReasons.push(`侧栏切换失败: ${clickError}`);
        result.clickError = clickError;
      }

      results.push(result);
    }

    // ── 输出报告 ──────────────────────────────────
    const crashedResults = results.filter((r) => r.crashed);
    const firstCrash = crashedResults[0] ?? null;

    console.log("\n\n========== 灵动岛导航调试报告 ==========\n");
    console.log(
      [
        "步骤".padEnd(4),
        "视图key".padEnd(10),
        "标签".padEnd(10),
        "URL".padEnd(50),
        "侧栏".padEnd(4),
        "登录页".padEnd(6),
        "错误文案".padEnd(20),
        "Console".padEnd(7),
        "PageErr".padEnd(7),
        "状态".padEnd(6),
      ].join(" | "),
    );
    console.log("-".repeat(140));
    for (const r of results) {
      console.log(
        [
          String(r.step).padEnd(4),
          r.viewKey.padEnd(10),
          r.viewLabel.padEnd(10),
          (r.url.length > 50 ? r.url.slice(0, 47) + "..." : r.url).padEnd(50),
          (r.islandVisible ? "✓" : "✗").padEnd(4),
          (r.isLandingPage ? "是" : "否").padEnd(6),
          (r.errorPatterns.join(",") || "—").padEnd(20),
          String(r.newConsoleErrors.length).padEnd(7),
          String(r.newPageErrors.length).padEnd(7),
          (r.crashed ? "💥" : "OK").padEnd(6),
        ].join(" | "),
      );
    }

    console.log("\n========== 全部控制台错误日志 ==========");
    if (allConsoleErrors.length === 0) {
      console.log("(无)");
    } else {
      allConsoleErrors.forEach((e, i) => {
        const loc = e.url ? ` [${e.url}${e.line ? `:${e.line}:${e.column ?? ""}` : ""}` : "";
        console.log(`[${i + 1}] ${e.type}: ${e.text}${loc}`);
      });
    }

    console.log("\n========== 全部页面错误日志 ==========");
    if (allPageErrors.length === 0) {
      console.log("(无)");
    } else {
      allPageErrors.forEach((e, i) => {
        console.log(`[${i + 1}] ${e}`);
      });
    }

    console.log("\n========== 截图路径 ==========");
    for (const r of results) {
      console.log(`步骤 ${r.step} (${r.viewKey}): ${r.screenshotPath}`);
    }

    if (firstCrash) {
      console.log("\n========== 💥 崩溃定位 ==========");
      console.log(`第一个崩溃的视图: "${firstCrash.viewKey}"(${firstCrash.viewLabel})`);
      console.log(`步骤: ${firstCrash.step}`);
      console.log(`URL: ${firstCrash.url}`);
      console.log(`崩溃原因:`);
      for (const reason of firstCrash.crashReasons) {
        console.log(`  - ${reason}`);
      }
      console.log(`截图: ${firstCrash.screenshotPath}`);
    }

    console.log("\n============================\n");

    const reportPath = path.join(resultsDir, "report.json");
    fs.writeFileSync(
      reportPath,
      JSON.stringify(
        {
          generatedAt: new Date().toISOString(),
          viewFlow: VIEW_FLOW,
          results,
          allConsoleErrors,
          allPageErrors,
          summary: {
            totalSteps: results.length,
            crashedSteps: crashedResults.map((r) => ({
              step: r.step,
              viewKey: r.viewKey,
              viewLabel: r.viewLabel,
              reasons: r.crashReasons,
            })),
            firstCrashView: firstCrash?.viewKey ?? null,
          },
        },
        null,
        2,
      ),
    );
    console.log(`\n[report] JSON 报告已写入: ${reportPath}`);

    expect(
      crashedResults.length,
      `侧栏连续切换不应导致崩溃,崩溃视图: ${crashedResults.map((r) => `${r.viewKey}(${r.step})`).join(", ")}`,
    ).toBe(0);
  });
});

/**
 * 通过灵动岛切换到指定视图。
 * 1. 等待 nav.island 可见
 * 2. 点击匹配 label 的 .island-item(紧凑态图标可见即可点,无需悬停展开)
 */
async function selectViewViaIsland(
  page: import("@playwright/test").Page,
  label: string,
): Promise<void> {
  await page.locator(".island").waitFor({ state: "visible", timeout: 5000 });

  // 点击匹配 label 的灵动岛项
  const item = page.locator(".island-item", { hasText: label }).first();
  await item.waitFor({ state: "visible", timeout: 3000 });
  await item.click({ timeout: 5000 });

  // 等待 URL 变化(视图切换)
  await page.waitForURL("**/?view=**", { timeout: 5000 }).catch(() => {
    // URL 可能不立即变化,继续
  });
}

async function captureState(
  page: import("@playwright/test").Page,
  step: number,
  viewKey: string,
  viewLabel: string,
  screenshotPath: string,
  durationMs: number,
  newConsoleErrors: { type: string; text: string; url?: string }[],
  newPageErrors: string[],
): Promise<ClickResult> {
  const url = page.url();

  const islandVisible = await page.locator(".island").isVisible().catch(() => false);
  const appShellVisible = await page.locator(".app-shell").isVisible().catch(() => false);
  const landingFormCount = await page.locator(".landing-form").count().catch(() => 0);
  const isLandingPage = landingFormCount > 0;
  const redirectedToLogin = /\/login/.test(url);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const errorPatterns = ERROR_PATTERNS.filter((p) =>
    bodyText.toLowerCase().includes(p.toLowerCase()),
  );
  if (HTTP_500_RE.test(bodyText)) errorPatterns.push("500");

  const crashReasons: string[] = [];
  if (!appShellVisible) crashReasons.push("app-shell 消失");
  if (!islandVisible) crashReasons.push("灵动岛不可见");
  if (isLandingPage) crashReasons.push("落地页(登录表单)出现,会话已掉");
  if (redirectedToLogin) crashReasons.push(`重定向到登录页: ${url}`);
  if (errorPatterns.length > 0) crashReasons.push(`页面包含错误文案: ${errorPatterns.join(", ")}`);
  if (newPageErrors.length > 0) crashReasons.push(`页面抛出未捕获异常: ${newPageErrors.join("; ")}`);

  return {
    step,
    viewKey,
    viewLabel,
    url,
    islandVisible,
    appShellVisible,
    isLandingPage,
    redirectedToLogin,
    errorPatterns,
    newConsoleErrors,
    newPageErrors,
    screenshotPath,
    durationMs,
    crashed: crashReasons.length > 0,
    crashReasons,
  };
}
