import { test, expect } from "@playwright/test";
import * as fs from "fs";

/**
 * 已授权 API 测试 (chromium-authed project)
 *
 * 从 .auth/admin.json 读取 globalSetup 保存的 token,带 Authorization 头访问后端 API:
 * - GET /api/auth/me     → 200 + user 对象
 * - GET /api/models      → 200
 * - GET /api/jobs        → 200
 * - GET /api/models/local → 200
 */

const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";
const STORAGE_PATH = ".auth/admin.json";

/** 从 storageState 文件中提取 toiv_token。 */
function readToken(): string | null {
  try {
    const raw = fs.readFileSync(STORAGE_PATH, "utf-8");
    const state = JSON.parse(raw) as {
      origins?: { localStorage?: { name: string; value: string }[] }[];
    };
    for (const origin of state.origins ?? []) {
      const found = origin.localStorage?.find((e) => e.name === "toiv_token");
      if (found?.value) return found.value;
    }
    return null;
  } catch {
    return null;
  }
}

let token: string | null;

test.beforeAll(async () => {
  token = readToken();
  if (!token) {
    console.error(
      "[authed-api] 未从 .auth/admin.json 读到 token,globalSetup 可能登录失败",
    );
  }
});

test.describe("已授权 API 测试", () => {
  test.beforeEach(async () => {
    test.skip(!token, "无 token,跳过已授权 API 测试");
  });

  test("GET /api/auth/me 带 token 应返回 200 + user 对象", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/auth/me`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "/api/auth/me 应 200").toBe(200);
    const body = await res.json();
    expect(body.user, "响应应含 user 对象").toBeDefined();
    expect(body.user.email, "user.email 应非空").toBeTruthy();
    expect(body.user.role, "user.role 应非空").toBeTruthy();
  });

  test("GET /api/models 带 token 应返回 200", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/models`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "/api/models 应 200").toBe(200);
  });

  test("GET /api/jobs 带 token 应返回 200", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/jobs`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "/api/jobs 应 200").toBe(200);
  });

  test("GET /api/models/local 带 token 应返回 200", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/models/local`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status(), "/api/models/local 应 200").toBe(200);
  });
});
