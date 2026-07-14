import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E 配置 - ToIV 项目
 * - baseURL: http://localhost:3100
 * - 仅 chromium
 * - 复用已运行的 dev server
 * - globalSetup: 真实登录获取 token,写入 .auth/admin.json
 * - 两个 project 共存:
 *   - chromium-guest:  未登录态(无 storageState),跑原有测试 + auth-flow 真实登录流程
 *   - chromium-authed:  登录态(storageState = .auth/admin.json),跑 authed-* 测试
 */
export default defineConfig({
  testDir: "./e2e",
  globalSetup: "./e2e/global-setup.ts",
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 1,
  workers: 2,
  timeout: 30000,
  expect: {
    timeout: 5000,
  },
  reporter: [["list"], ["html", { open: "never" }]],
  use: {
    baseURL: "http://localhost:3100",
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    actionTimeout: 15000,
    navigationTimeout: 15000,
  },
  projects: [
    {
      name: "chromium-guest",
      use: { ...devices["Desktop Chrome"] },
      // 未登录态:排除登录态专属测试
      testIgnore: ["**/authed-*.spec.ts"],
    },
    {
      name: "chromium-authed",
      use: {
        ...devices["Desktop Chrome"],
        storageState: ".auth/admin.json",
      },
      // 登录态:只跑 authed-* 测试
      testMatch: ["**/authed-*.spec.ts"],
    },
  ],
  webServer: {
    command: "npm run dev",
    url: "http://localhost:3100",
    reuseExistingServer: true,
    timeout: 120000,
  },
});
