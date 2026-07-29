import { test, expect } from "@playwright/test";

/**
 * API 接口测试
 * - 直接访问后端 API（baseURL 用 http://127.0.0.1:8200）
 * - 未登录态期望 401/403/404
 */
const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";

test.describe("API 接口（未登录）", () => {
  test("GET /api/auth/me 应返回 401", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/auth/me`);
    expect(response.status(), "未登录访问 /api/auth/me 应 401").toBe(401);
  });

  test("GET /api/models 应返回 401 或 403", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/models`);
    const status = response.status();
    expect(
      status === 401 || status === 403,
      `未登录访问 /api/models 应 401/403,实际 ${status}`,
    ).toBe(true);
  });

  test("GET /api/jobs 应返回 401 或 403", async ({ request }) => {
    const response = await request.get(`${API_BASE}/api/jobs`);
    const status = response.status();
    expect(
      status === 401 || status === 403,
      `未登录访问 /api/jobs 应 401/403,实际 ${status}`,
    ).toBe(true);
  });

  test("GET / 应返回 200 或重定向到登录", async ({ request }) => {
    const response = await request.get(`${API_BASE}/`, {
      maxRedirects: 0,
    });
    const status = response.status();
    expect(
      status === 200 || status === 301 || status === 302 || status === 404,
      `访问根路径状态码 ${status}`,
    ).toBe(true);
  });

  test("GET /nonexistent 应返回 404", async ({ request }) => {
    const response = await request.get(`${API_BASE}/nonexistent`);
    expect(response.status(), "访问不存在的路径应 404").toBe(404);
  });
});
