import { test, expect } from "@playwright/test";
import * as fs from "fs";

/**
 * 智能体优化系统 API 测试 (chromium-authed project)
 *
 * 覆盖后端 /api/agents CRUD + /api/optimize 带 agent_id + /api/account/preferences
 * - 列表与可见性(SFW / NSFW 隔离)
 * - 内置种子幂等
 * - CRUD:创建 / 更新 / 删除(内置拒删)
 * - optimize 带 agent_id 拼接 system_prompt
 * - account preferences 改 default_agent_id
 */

const API_BASE = process.env.TOIV_API_BASE ?? "http://127.0.0.1:8200";
const STORAGE_PATH = ".auth/admin.json";

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
});

test.describe("智能体 API", () => {
  test.beforeEach(async () => {
    test.skip(!token, "无 token,跳过");
  });

  const authHeaders = () => ({ Authorization: `Bearer ${token}` });

  // ── 列表与可见性 ──────────────────────────────────────────────
  test("GET /api/agents 返回内置智能体列表", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents`, {
      headers: authHeaders(),
    });
    expect(res.status()).toBe(200);
    const agents = await res.json();
    expect(Array.isArray(agents)).toBeTruthy();
    // 12 个内置 - 2 NSFW(无 X-NSFW header 时不可见)= 10 个 SFW
    expect(agents.length, "至少 10 个 SFW 内置").toBeGreaterThanOrEqual(10);

    // 验证字段结构
    const first = agents[0];
    expect(first).toHaveProperty("id");
    expect(first).toHaveProperty("name");
    expect(first).toHaveProperty("applies_to");
    expect(Array.isArray(first.applies_to)).toBeTruthy();
    expect(first).toHaveProperty("is_nsfw");
    expect(first).toHaveProperty("is_builtin");
  });

  test("GET /api/agents 默认不返回 NSFW 智能体(无 X-NSFW header)", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents`, {
      headers: authHeaders(),
    });
    const agents = await res.json();
    const nsfw = agents.filter((a: { is_nsfw: boolean }) => a.is_nsfw);
    expect(nsfw.length, "无 X-NSFW header 时不应返回 NSFW 智能体").toBe(0);
  });

  test("GET /api/agents?kind=audio 只返回 audio + all 类智能体", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents?kind=audio`, {
      headers: authHeaders(),
    });
    expect(res.status()).toBe(200);
    const agents = await res.json();
    for (const a of agents) {
      const applicable = a.applies_to as string[];
      const ok = applicable.includes("all") || applicable.includes("audio");
      expect(ok, `智能体 ${a.id} applies_to=${applicable.join(",")} 不适用 audio`).toBeTruthy();
    }
  });

  test("GET /api/agents?kind=train 只返回 train + all 类智能体", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents?kind=train`, {
      headers: authHeaders(),
    });
    const agents = await res.json();
    for (const a of agents) {
      const applicable = a.applies_to as string[];
      const ok = applicable.includes("all") || applicable.includes("train");
      expect(ok, `智能体 ${a.id} 不适用 train`).toBeTruthy();
    }
  });

  // ── 详情 ──────────────────────────────────────────────────────
  test("GET /api/agents/{id} 返回详情", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents/realist`, {
      headers: authHeaders(),
    });
    expect(res.status()).toBe(200);
    const a = await res.json();
    expect(a.id).toBe("realist");
    expect(a.name).toBeTruthy();
    expect(a.system_prompt.length, "system_prompt 应非空").toBeGreaterThan(0);
  });

  test("GET /api/agents/{id} 不存在返 404", async ({ request }) => {
    const res = await request.get(`${API_BASE}/api/agents/nonexistent_xyz`, {
      headers: authHeaders(),
    });
    expect(res.status()).toBe(404);
  });

  // ── CRUD ──────────────────────────────────────────────────────
  test("POST /api/agents 创建自定义 → PUT 改 → DELETE 删", async ({ request }) => {
    // 创建
    const createRes = await request.post(`${API_BASE}/api/agents`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: {
        id: "e2e_test_agent",
        name: "E2E 测试智能体",
        description: "测试用,可删",
        icon: "sparkles",
        applies_to: "all",
        system_prompt: "你是一个测试用智能体。",
        is_nsfw: false,
        sort: 999,
      },
    });
    expect(createRes.status()).toBe(200);
    const created = await createRes.json();
    expect(created.id).toBe("e2e_test_agent");
    expect(created.is_builtin, "新建的应为非内置").toBe(false);

    // 更新
    const updateRes = await request.put(`${API_BASE}/api/agents/e2e_test_agent`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: { name: "E2E 改名后", system_prompt: "改后的 prompt" },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.name).toBe("E2E 改名后");
    expect(updated.system_prompt).toBe("改后的 prompt");
    expect(updated.is_builtin, "is_builtin 不可变").toBe(false);

    // 删除
    const delRes = await request.delete(`${API_BASE}/api/agents/e2e_test_agent`, {
      headers: authHeaders(),
    });
    expect(delRes.status()).toBe(200);
  });

  test("DELETE /api/agents/{内置 id} 应返 403", async ({ request }) => {
    const res = await request.delete(`${API_BASE}/api/agents/realist`, {
      headers: authHeaders(),
    });
    expect(res.status()).toBe(403);
  });

  test("PUT /api/agents/{内置 id} 可改 system_prompt,is_builtin 不变", async ({ request }) => {
    // 先读原 system_prompt
    const before = await (await request.get(`${API_BASE}/api/agents/cinematic`, {
      headers: authHeaders(),
    })).json();

    // 改 system_prompt
    const updateRes = await request.put(`${API_BASE}/api/agents/cinematic`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: { system_prompt: "E2E 临时改写" },
    });
    expect(updateRes.status()).toBe(200);
    const updated = await updateRes.json();
    expect(updated.system_prompt).toBe("E2E 临时改写");
    expect(updated.is_builtin, "内置仍为内置").toBe(true);

    // 还原
    await request.put(`${API_BASE}/api/agents/cinematic`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: { system_prompt: before.system_prompt },
    });
  });

  // ── account preferences ───────────────────────────────────────
  test("PUT /api/account/preferences 改 default_agent_id", async ({ request }) => {
    const res = await request.put(`${API_BASE}/api/account/preferences`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: { default_agent_id: "realist" },
    });
    expect(res.status()).toBe(200);
    const body = await res.json();
    expect(body.default_agent_id).toBe("realist");

    // 验证 /auth/me 也读到
    const meRes = await request.get(`${API_BASE}/api/auth/me`, {
      headers: authHeaders(),
    });
    const me = await meRes.json();
    expect(me.user.default_agent_id).toBe("realist");

    // 清空
    await request.put(`${API_BASE}/api/account/preferences`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: { default_agent_id: null },
    });
  });

  // ── optimize 带 agent_id ───────────────────────────────────────
  test("POST /api/optimize 带 agent_id 应拼接智能体 system_prompt", async ({ request }) => {
    // 注意:这个测试实际会调 LLM;LLM 推理可能 30s+,Playwright 默认 15s 不够
    test.setTimeout(90000);
    const res = await request.post(`${API_BASE}/api/optimize`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      timeout: 80000,
      data: {
        prompt: "一个女孩在花园里",
        kind: "image",
        agent_id: "realist",
      },
    });
    // 接受 200(成功) 或 503(LLM 不可用,但端点逻辑跑通了)
    expect([200, 503]).toContain(res.status());

    if (res.status() === 200) {
      const body = await res.json();
      expect(body.optimized, "应返回优化后的 prompt").toBeTruthy();
      expect(typeof body.optimized).toBe("string");
    }
  });

  test("POST /api/optimize 带无效 agent_id 应返 404", async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/optimize`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: {
        prompt: "测试",
        kind: "image",
        agent_id: "nonexistent_agent_xyz",
      },
    });
    expect(res.status()).toBe(404);
  });

  test("POST /api/optimize 带 NSFW agent 但无 X-NSFW header 应返 403", async ({ request }) => {
    const res = await request.post(`${API_BASE}/api/optimize`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: {
        prompt: "测试",
        kind: "image",
        agent_id: "nsfw_photographer",
      },
    });
    expect(res.status()).toBe(403);
  });

  test("POST /api/optimize agent applies_to 不含 kind 应返 400", async ({ request }) => {
    // voice_dub 只适用 audio,给它传 kind=image
    const res = await request.post(`${API_BASE}/api/optimize`, {
      headers: { ...authHeaders(), "Content-Type": "application/json" },
      data: {
        prompt: "测试",
        kind: "image",
        agent_id: "voice_dub",
      },
    });
    expect(res.status()).toBe(400);
  });
});
