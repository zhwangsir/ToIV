import { request, chromium } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * globalSetup —— 登录态测试前置
 *
 * 流程:
 * 1. GET /api/health 探活,失败则抛错
 * 2. POST /api/auth/login (admin/admin123) 拿 token
 * 3. 启动 browser → goto / → localStorage 注入 toiv_token → 保存 storageState
 *
 * 失败策略:
 * - 健康检查失败 → 抛错(后端不可用,全部测试无意义)
 * - 登录失败 → 不抛错(不中断 guest 测试),写空 storageState,console.error 报告
 *   authed 测试会因无 token 而单独失败,提供清晰错误。
 */

// 支持通过环境变量切换测试目标环境(默认本地开发,生产用 playwright.prod.config.ts 注入)
const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";
const WEB_BASE = process.env.TOIV_WEB_BASE ?? "http://localhost:3100";
const STORAGE_PATH = ".auth/admin.json";
const TOKEN_KEY = "toiv_token";

export default async function globalSetup() {
  // 确保 .auth 目录存在
  const authDir = path.dirname(STORAGE_PATH);
  if (!fs.existsSync(authDir)) {
    fs.mkdirSync(authDir, { recursive: true });
  }

  // API 请求上下文(Playwright APIRequest)
  const apiCtx = await request.newContext();
  try {
    // 1. 健康检查
    const healthRes = await apiCtx
      .get(`${API_BASE}/api/health`)
      .catch(() => null);
    if (!healthRes || !healthRes.ok()) {
      throw new Error(
        `[globalSetup] 后端健康检查失败: GET ${API_BASE}/api/health 不可达。` +
          `请确认后端已启动 (apps/api)。`,
      );
    }
    const healthBody = await healthRes.json().catch(() => ({}));
    console.log("[globalSetup] 健康检查通过:", healthBody?.status ?? "ok");

    // 2. 真实表单登录
    let token: string | null = null;
    try {
      const loginRes = await apiCtx.post(`${API_BASE}/api/auth/login`, {
        data: { email: "admin", password: "admin123" },
      });

      if (!loginRes.ok()) {
        const detail = await loginRes.json().catch(() => null);
        throw new Error(
          `[globalSetup] 登录失败: HTTP ${loginRes.status()} - ${JSON.stringify(detail ?? "(无响应体)")}`,
        );
      }

      const body = await loginRes.json();
      token = body?.token ?? null;
      if (!token) {
        throw new Error(
          `[globalSetup] 登录响应缺少 token 字段: ${JSON.stringify(body)}`,
        );
      }
      console.log(
        `[globalSetup] 登录成功: user=${body?.user?.email ?? "?"} role=${body?.user?.role ?? "?"}`,
      );
    } catch (e) {
      // 登录失败:写空 storageState,不中断 guest 测试
      console.error(
        "[globalSetup] ⚠️  登录失败,authed 测试将无法通过。原因:",
        e instanceof Error ? e.message : e,
      );
      fs.writeFileSync(
        STORAGE_PATH,
        JSON.stringify({ cookies: [], origins: [] }, null, 2),
      );
      return;
    }

    // 3. 启动 browser 注入 token 并保存 storageState
    const browser = await chromium.launch();
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(WEB_BASE, { waitUntil: "domcontentloaded" });
      await page.evaluate(
        ({ key, val }) => window.localStorage.setItem(key, val),
        { key: TOKEN_KEY, val: token as string },
      );
      await context.storageState({ path: STORAGE_PATH });
      console.log("[globalSetup] 完成,token 已保存:", STORAGE_PATH);
    } finally {
      await page.close();
      await context.close();
      await browser.close();
    }
  } finally {
    await apiCtx.dispose();
  }
}
