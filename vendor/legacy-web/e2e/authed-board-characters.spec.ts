// 分镜板 M2 角色一致性真机验证:角色落库/角色条/单镜生成(引擎在线)/导出角色升维
import { test, expect } from "@playwright/test";

// 隧道(TS 跨省 ~37KB/s)下全局放宽:导航 60s / 动作 30s
test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

const MARK = `e2e角色${Date.now() % 100000}`;

test("board characters: entity upsert / cast strip / shot generate / export enriched", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const H = { Authorization: `Bearer ${token}` };

  let boardId = "";
  const cleanupEntityIds = new Set<string>();
  try {
    // ── ① from-script(真实 DSv4;MARK 置剧本开头保板名含标记,角色名保持自然不掺标记) ──
    await page.getByRole("button", { name: "画板" }).click();
    await expect(page.getByRole("button", { name: "剧本拆镜" })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "剧本拆镜" }).click();
    await page
      .getByLabel("剧本文本")
      .fill(`${MARK}:雨夜,冷静的女侦探艾可带着话多的机器人助手布布进废弃车站查案,在铁轨旁发现一枚发光的怀表。`);
    await page.getByLabel("镜头数").fill("3");
    await page.getByRole("button", { name: "开始拆镜" }).click();
    const rowsAppear = page.locator(".lib-shot-row").first();
    const llmFailed = page.getByText(/剧本拆镜失败|拆解服务暂不可用/).first();
    const winner = await Promise.race([
      rowsAppear.waitFor({ timeout: 150000 }).then(() => "rows").catch(() => "timeout"),
      llmFailed.waitFor({ timeout: 150000 }).then(() => "failed").catch(() => "timeout"),
    ]);
    test.skip(winner !== "rows", `LLM 拆镜不可用(${winner}),环境性跳过`);

    // 板 id(API 按名查;MARK 在剧本开头 → 板名前 12 字含完整标记)
    const boards = await (await page.request.get("/api/boards", { headers: H })).json();
    boardId = (boards as { id: string; name: string }[]).find((b) => b.name.includes(MARK))?.id ?? "";
    expect(boardId).toBeTruthy();

    // ── ② 角色落库:走 shot_meta.entity_ids 确定性链(不赌 LLM 是否规范化角色名) ──
    const items = (await (await page.request.get(`/api/boards/${boardId}/items`, { headers: H })).json()) as {
      id: number;
      shot_text: string;
      shot_meta: string;
    }[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    for (const it of items) {
      try {
        const meta = JSON.parse(it.shot_meta) as { entity_ids?: string[] };
        for (const eid of meta.entity_ids ?? []) cleanupEntityIds.add(eid);
      } catch { /* 忽略坏 meta */ }
    }
    expect(cleanupEntityIds.size).toBeGreaterThanOrEqual(1);
    let hintCount = 0;
    for (const eid of cleanupEntityIds) {
      const er = await page.request.get(`/api/entities/${eid}`, { headers: H });
      expect(er.ok()).toBeTruthy();
      const ent = (await er.json()) as { name: string; prompt_hint: string };
      if (ent.prompt_hint?.trim()) hintCount += 1;
    }
    expect(hintCount).toBeGreaterThanOrEqual(1); // visual_prompt → prompt_hint 落库
    console.log(`CAST_E2E_ENTITIES: ${cleanupEntityIds.size} entities, prompt_hint x${hintCount}`);

    // ── ③ 角色条 UI:strip + chip 可见(新建主体尚无定妆照,徽标属预期) ──
    await expect(page.locator(".lib-cast-strip")).toBeVisible({ timeout: 20000 });
    await expect(page.locator(".lib-cast-chip").first()).toBeVisible();
    await page.screenshot({ path: "ui-sweep/board-cast-strip.png" });

    // ── ④ 单镜生成:新建主体无定妆照,直选「H3 快速」(引擎离线则环境性跳过) ──
    await page.getByRole("button", { name: "H3 快速" }).click();
    const enginesRes = await (
      await page.request.get("/api/models/engines", { headers: H })
    ).json();
    const list = Array.isArray(enginesRes) ? enginesRes : (enginesRes.engines ?? []);
    const h3 = (list as { id: string; available?: boolean; online?: boolean }[]).find((e) => e.id === "h3-t2v");
    const h3Online = h3 ? (h3.available ?? h3.online ?? true) : false;
    test.skip(!h3Online, "h3-t2v 引擎离线,环境性跳过真跑提交");
    await page.getByRole("button", { name: "生成分镜: 第 1 镜" }).click();
    // 状态流转:重生成中/排队/生成中/已完成/挂起 任一出现即提交链通(照 P1 流转即过)
    await expect
      .poll(
        async () => {
          const chip = await page.locator(".lib-shot-row").first().locator(".lib-shot-status").innerText();
          return /重生成中|排队|生成中|已完成|挂起/.test(chip);
        },
        { timeout: 90000, intervals: [1500] },
      )
      .toBe(true);
    await page.screenshot({ path: "ui-sweep/board-cast-generating.png" });
    console.log("GEN_E2E_SUBMIT_OK: h3-t2v 单镜提交成功,状态流转确认");

    // ── ⑤ 导出角色升维:至少一个角色带 entity_id + visual_prompt ──
    const er = await page.request.get(`/api/boards/${boardId}/export`, { headers: H });
    expect(er.ok()).toBeTruthy();
    const doc = (await er.json()) as {
      characters: { name: string; entity_id?: string; visual_prompt?: string; ref_audio?: string }[];
    };
    expect(doc.characters.length).toBeGreaterThanOrEqual(1);
    expect(doc.characters.some((c) => (c.entity_id ?? "").length > 0)).toBe(true);
    expect(doc.characters.some((c) => (c.visual_prompt ?? "").length > 0)).toBe(true);
    console.log(`CAST_E2E_EXPORT_OK: characters=${doc.characters.length} enriched`);
  } finally {
    if (boardId) await page.request.delete(`/api/boards/${boardId}`, { headers: H }).catch(() => {});
    // 只删 entity_ids 链上的主体(精确,不动用户既有主体库)
    for (const eid of cleanupEntityIds) {
      await page.request.delete(`/api/entities/${eid}`, { headers: H }).catch(() => {});
    }
  }
});
