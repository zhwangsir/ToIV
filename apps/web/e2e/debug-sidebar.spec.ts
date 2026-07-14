import { test, expect, type ConsoleMessage } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * 调试脚本:连续点击侧栏不同视图,定位"点击两个服务就掉了"的崩溃问题。
 *
 * 由于文件名非 `authed-*.spec.ts`(不会被 chromium-authed project 自动应用 storageState),
 * 这里手动通过 `test.use({ storageState })` 注入登录态。
 *
 * 测试流程:
 * 1. 登录态打开 /?view=assistant
 * 2. 依次点击侧栏的 10 个视图图标(不重新加载页面)
 * 3. 每次点击后:
 *    - 等待 1.5s 让视图渲染
 *    - 截图保存到 test-results/sidebar-click-{view}-{idx}.png
 *    - 记录 URL / 侧栏可见 / 登录页 / 错误文案 / 控制台错误 / 页面错误
 * 4. 输出详细调试报告(JSON + 控制台表格)
 */

// 手动注入 storageState(因文件名不匹配 authed-* 前缀)
test.use({ storageState: ".auth/admin.json" });

// 视图点击顺序(对应 Sidebar 中的 aria-label)
const VIEW_FLOW: { key: string; label: string }[] = [
  { key: "assistant", label: "AI 助手" }, // 初始视图,通过 goto 进入
  { key: "create",    label: "创作" },
  { key: "canvas",    label: "ComfyUI" },
  { key: "manju",     label: "漫剧" },
  { key: "dub",       label: "译制" },
  { key: "train",     label: "训练" },
  { key: "library",   label: "作品库" },
  { key: "backlot",   label: "看板" },
  { key: "models",    label: "模型" },
  { key: "admin",     label: "管理" },
  { key: "assistant", label: "AI 助手" }, // 回到 assistant,验证可恢复
];

const ERROR_PATTERNS = [
  "Application error",
  "Internal Server Error",
  "500",
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

interface ClickResult {
  step: number;
  viewKey: string;
  viewLabel: string;
  url: string;
  sidebarVisible: boolean;
  topbarVisible: boolean;
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

test.describe("侧栏导航调试 @authed", () => {
  test("连续点击侧栏视图,捕获崩溃", { tag: "@authed" }, async ({ page }) => {
    // 单测需要 ~30s(11 步 × 1.5s + click + capture),给 120s 余量
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

    // 监听控制台错误(全局累计)
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

    // 监听页面未捕获异常
    page.on("pageerror", (err: Error) => {
      allPageErrors.push(err.stack ?? err.message);
    });

    // 监听 dialog(alert/confirm/prompt),避免阻塞
    page.on("dialog", async (d) => {
      await d.dismiss();
    });

    // ── 步骤 1:打开默认视图 ──────────────────────────
    const stepStart = Date.now();
    await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });

    // 等待 app-shell 可见(登录态)
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
      "AI 助手",
      initialShot,
      Date.now() - stepStart,
      allConsoleErrors.slice(),
      allPageErrors.slice(),
    );
    results.push(initial);

    // ── 步骤 2~N:点击侧栏图标 ──────────────────────
    for (let i = 1; i < VIEW_FLOW.length; i++) {
      const { key, label } = VIEW_FLOW[i];
      const t0 = Date.now();

      // 记录点击前的累计错误数量
      const consoleErrorsBefore = allConsoleErrors.length;
      const pageErrorsBefore = allPageErrors.length;

      // 定位侧栏项
      const item = page.locator(`a.app-sidebar-item[aria-label="${label}"]`).first();
      let clickOk = true;
      let clickError: string | null = null;

      try {
        await item.waitFor({ state: "visible", timeout: 3000 });
      } catch {
        clickOk = false;
        clickError = `侧栏项 "${label}" 不可见`;
      }

      if (clickOk) {
        try {
          await item.click({ timeout: 5000 });
        } catch (e) {
          clickOk = false;
          clickError = e instanceof Error ? e.message : String(e);
        }
      }

      // 等待 1.5s 让视图渲染
      await page.waitForTimeout(1500);

      // 截图
      const screenshotPath = `test-results/sidebar-click-${key}-${i}.png`;
      try {
        await page.screenshot({ path: screenshotPath, fullPage: true });
      } catch {
        // 截图失败忽略
      }

      // 抓取本轮新增的错误
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
        result.crashReasons.push(`点击失败: ${clickError}`);
        result.clickError = clickError;
      }

      results.push(result);
    }

    // ── 输出报告 ──────────────────────────────────
    const crashedResults = results.filter((r) => r.crashed);
    const firstCrash = crashedResults[0] ?? null;

    console.log("\n\n========== 侧栏导航调试报告 ==========\n");
    console.log(
      [
        "步骤".padEnd(4),
        "视图key".padEnd(10),
        "标签".padEnd(10),
        "URL".padEnd(50),
        "侧栏".padEnd(4),
        "Topbar".padEnd(6),
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
          (r.sidebarVisible ? "✓" : "✗").padEnd(4),
          (r.topbarVisible ? "✓" : "✗").padEnd(6),
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
        const loc = e.url ? ` [${e.url}${e.line ? `:${e.line}:${e.column ?? ""}` : ""}]` : "";
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

    // 写入 JSON 报告
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

    // 断言:不应有任何崩溃
    expect(
      crashedResults.length,
      `侧栏连续点击不应导致崩溃,崩溃视图: ${crashedResults.map((r) => `${r.viewKey}(${r.step})`).join(", ")}`,
    ).toBe(0);
  });
});

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

  const sidebarVisible = await page.locator("aside.app-sidebar").isVisible().catch(() => false);
  const topbarVisible = await page.locator("header.topbar").isVisible().catch(() => false);
  const appShellVisible = await page.locator(".app-shell").isVisible().catch(() => false);
  const landingFormCount = await page.locator(".landing-form").count().catch(() => 0);
  const isLandingPage = landingFormCount > 0;
  const redirectedToLogin = /\/login/.test(url);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  const errorPatterns = ERROR_PATTERNS.filter((p) =>
    bodyText.toLowerCase().includes(p.toLowerCase()),
  );

  const crashReasons: string[] = [];
  if (!sidebarVisible) crashReasons.push("侧栏不可见");
  if (!appShellVisible) crashReasons.push("app-shell 消失");
  if (isLandingPage) crashReasons.push("落地页(登录表单)出现,会话已掉");
  if (redirectedToLogin) crashReasons.push(`重定向到登录页: ${url}`);
  if (errorPatterns.length > 0) crashReasons.push(`页面包含错误文案: ${errorPatterns.join(", ")}`);
  if (newPageErrors.length > 0) crashReasons.push(`页面抛出未捕获异常: ${newPageErrors.join("; ")}`);

  return {
    step,
    viewKey,
    viewLabel,
    url,
    sidebarVisible,
    topbarVisible,
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
