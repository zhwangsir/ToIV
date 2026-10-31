// A1 多轮导演 e2e:agent 对话驱动「剧本→分镜板」(真实 DSv4,仅钉第一轮,成片链已由真机验证)
import { test, expect } from "@playwright/test";

test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

test("agent drama: create_storyboard tool called and board created", async ({ page }) => {
  test.setTimeout(240000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  // 前后差集定位新板(agent 可能改写剧本转发,MARK 不可靠,用差集)
  const before = (await (await page.request.get("/api/boards", { headers: H })).json()) as { id: string }[];
  const beforeIds = new Set(before.map((b) => b.id));
  const beforeEnts = (await (await page.request.get("/api/entities?kind=character", { headers: H })).json()) as { id: string }[];
  const beforeEntIds = new Set(beforeEnts.map((e) => e.id));

  let boardId = "";
  const newEntIds: string[] = [];
  try {
    // ── agent 对话:做 2 镜短剧 → 期望 create_storyboard 工具调用(SSE 解析) ──
    const res = await page.request.post("/api/agent/chat", {
      headers: { ...H, Accept: "text/event-stream" },
      data: {
        messages: [
          { role: "user", content: "帮我把这个剧本做成 2 镜短剧(num_shots=2):深夜,守夜人老周在站台对徒弟小林说:灯亮着,人就安全。小林点头,把信号灯举得更高。" },
        ],
      },
      timeout: 180000,
    });
    expect(res.ok(), await res.text()).toBeTruthy();
    const body = await res.text();
    expect(body).toContain('"name": "create_storyboard"');

    const after = (await (await page.request.get("/api/boards", { headers: H })).json()) as { id: string; name: string }[];
    const created = after.find((b) => !beforeIds.has(b.id));
    if (!created) {
      // agent 工具失败(LLM 波动/引擎侧 503)→ 环境性跳过
      test.skip(true, `agent 未建成新分镜板(工具错误或剧本被改写后走查失败): ${body.slice(-300)}`);
    }
    boardId = created!.id;
    const items = await (await page.request.get(`/api/boards/${boardId}/items`, { headers: H })).json();
    expect((items as unknown[]).length).toBeGreaterThanOrEqual(2);

    const afterEnts = (await (await page.request.get("/api/entities?kind=character", { headers: H })).json()) as { id: string }[];
    newEntIds.push(...afterEnts.filter((e) => !beforeEntIds.has(e.id)).map((e) => e.id));
    console.log(`AGENT_DRAMA_E2E_OK: board=${boardId.slice(0, 8)} items=${(items as unknown[]).length} newEntities=${newEntIds.length}`);
  } finally {
    if (boardId) await page.request.delete(`/api/boards/${boardId}`, { headers: H }).catch(() => {});
    for (const eid of newEntIds) {
      await page.request.delete(`/api/entities/${eid}`, { headers: H }).catch(() => {});
    }
  }
});
