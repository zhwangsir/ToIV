import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 配置 - ToIV 生产环境 (Workstation Docker)
 *
 * 目标:
 *  - 前端: http://192.168.71.127:3100  (toiv-web)
 *  - 后端: http://192.168.71.127:8090  (toiv-api)
 *
 * 与 playwright.config.ts(本地开发)的差异:
 *  - baseURL 指向 Workstation 生产
 *  - 通过 process.env 注入 TOIV_API_BASE / TOIV_WEB_BASE,供 global-setup 与 api.spec 读取
 *  - 移除 webServer(不启动本地 dev server,直连远程生产)
 *  - 输出目录隔离(test-results-prod / playwright-report-prod),避免覆盖本地结果
 *
 * 运行: npx playwright test --config=playwright.prod.config.ts
 */

// 注入环境变量(在 globalSetup 之前生效)
process.env.TOIV_API_BASE = "http://192.168.71.127:8090";
process.env.TOIV_WEB_BASE = "http://192.168.71.127:3100";

const PROD_WEB = "http://192.168.71.127:3100";

export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0, // 生产环境首轮不重试,以便观察真实缺陷;回归阶段可调为 1
  workers: 2,
  timeout: 45000, // 远程网络稍宽
  expect: {
    timeout: 7000,
  },
  reporter: [
    ["list"],
    ["html", { open: "never", outputFolder: "playwright-report-prod" }],
    ["json", { outputFile: "playwright-report-prod/results.json" }],
  ],
  outputDir: "test-results-prod",
  use: {
    baseURL: PROD_WEB,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 20000,
    navigationTimeout: 20000,
  },
  projects: [
    {
      name: "chromium-guest",
      use: { ...devices["Desktop Chrome"] },
      // 排除 authed-* (由 chromium-authed 项目运行)
      // 排除 dub-flow-headed (GPU 重负载全流程 ~10min,需测试视频;URL 已环境变量化,按需单独跑:
      //   DUB_TEST_VIDEO=/path/to.mp4 npx playwright test dub-flow-headed --config=playwright.prod.config.ts --project=chromium-guest)
      testIgnore: ["**/authed-*.spec.ts", "**/dub-flow-headed.spec.ts"],
    },
    {
      name: "chromium-authed",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/admin.json",
      },
      testMatch: ["**/authed-*.spec.ts"],
    },
  ],
  // 不配置 webServer:直连 Workstation 生产容器,不启动本地 dev server
});
