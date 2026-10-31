// 一键成片(M3)真机验证:全链(拆镜→逐镜生成→配音→词锚定字幕→拼接)至成片 done
import { test, expect } from "@playwright/test";

// 隧道(TS 跨省 ~37KB/s)下全局放宽:导航 60s / 动作 30s
test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

const MARK = `e2e成片${Date.now() % 100000}`;

test("board film: assemble end-to-end to done (videos+voices+words+ffmpeg)", async ({ page }) => {
  test.setTimeout(1200000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const H = { Authorization: `Bearer ${token}` };

  let boardId = "";
  const cleanupEntityIds = new Set<string>();
  try {
    // ── ① from-script(真实 DSv4,2 镜短剧本带台词,MARK 置首) ──
    await page.getByRole("button", { name: "画板" }).click();
    await expect(page.getByRole("button", { name: "剧本拆镜" })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "剧本拆镜" }).click();
    await page
      .getByLabel("剧本文本")
      .fill(`${MARK}:深夜,守夜人老周在站台对徒弟小林说:"灯亮着,人就安全。"小林点头,把信号灯举得更高。`);
    await page.getByLabel("镜头数").fill("2");
    await page.getByRole("button", { name: "开始拆镜" }).click();
    const rowsAppear = page.locator(".lib-shot-row").first();
    const llmFailed = page.getByText(/剧本拆镜失败|拆解服务暂不可用/).first();
    const winner = await Promise.race([
      rowsAppear.waitFor({ timeout: 150000 }).then(() => "rows").catch(() => "timeout"),
      llmFailed.waitFor({ timeout: 150000 }).then(() => "failed").catch(() => "timeout"),
    ]);
    test.skip(winner !== "rows", `LLM 拆镜不可用(${winner}),环境性跳过`);

    const boards = await (await page.request.get("/api/boards", { headers: H })).json();
    boardId = (boards as { id: string; name: string }[]).find((b) => b.name.includes(MARK))?.id ?? "";
    expect(boardId).toBeTruthy();

    // 收集 entity_ids 供清理;把每镜 duration_sec 压到 2s(省 GPU),并确定性注入台词
    // (LLM 拆镜对白字段有波动——配音/字幕链必须每跑必验,不赌 LLM 输出)
    const items = (await (await page.request.get(`/api/boards/${boardId}/items`, { headers: H })).json()) as {
      id: number; note: string; shot_text: string; shot_meta: string;
    }[];
    expect(items.length).toBeGreaterThanOrEqual(2);
    const payload = items.map((it, idx) => {
      let meta: Record<string, unknown> = {};
      try { meta = JSON.parse(it.shot_meta); } catch { /* 忽略 */ }
      for (const eid of (meta.entity_ids as string[]) ?? []) cleanupEntityIds.add(eid);
      meta.duration_sec = 2;
      if (idx === 0) {
        meta.dialogue = meta.dialogue || "灯亮着,人就安全。";
        meta.speaker = meta.speaker || "老周";
      }
      return { job_id: "", note: it.note ?? "", shot_text: it.shot_text, shot_meta: JSON.stringify(meta) };
    });
    const pr = await page.request.put(`/api/boards/${boardId}/items`, {
      headers: { ...H, "Content-Type": "application/json" },
      data: { items: payload },
    });
    expect(pr.ok()).toBeTruthy();

    // ── ② 引擎探测(h3-t2v 离线则环境性跳过) ──
    const enginesRes = await (await page.request.get("/api/models/engines", { headers: H })).json();
    const list = Array.isArray(enginesRes) ? enginesRes : (enginesRes.engines ?? []);
    const h3 = (list as { id: string; available?: boolean; online?: boolean }[]).find((e) => e.id === "h3-t2v");
    const h3Online = h3 ? (h3.available ?? h3.online ?? true) : false;
    test.skip(!h3Online, "h3-t2v 引擎离线,环境性跳过真跑");

    // ── ③ 一键成片(API 提交;UI 按钮可见性顺带核) ──
    await expect(page.getByRole("button", { name: "一键成片" })).toBeVisible({ timeout: 20000 });
    const ar = await page.request.post(`/api/boards/${boardId}/assemble`, {
      headers: { ...H, "Content-Type": "application/json" },
      data: { engine: "h3-t2v" },
    });
    expect(ar.ok(), await ar.text()).toBeTruthy();
    const { prompt_id: filmPid } = (await ar.json()) as { prompt_id: string };
    expect(filmPid).toMatch(/^film-/);

    // ── ④ 轮询成片至 done(真跑:2 镜×2s h3-t2v + TTS + whisper + ffmpeg) ──
    let filmJob: {
      status: string;
      results: string[];
      error: string;
      film: { ass_url?: string; srt_url?: string };
      progress: { stage: string; done: number; total: number } | null;
    } | null = null;
    await expect
      .poll(
        async () => {
          const jobs = (await (await page.request.get(`/api/boards/${boardId}/film-jobs`, { headers: H })).json()) as {
            prompt_id: string; status: string; results: string[]; error: string;
            film: { ass_url?: string; srt_url?: string };
            progress: { stage: string; done: number; total: number } | null;
          }[];
          filmJob = jobs.find((j) => j.prompt_id === filmPid) ?? null;
          return filmJob?.status ?? "missing";
        },
        { timeout: 900000, intervals: [8000] },
      )
      .toBe("done");

    expect(filmJob!.error ?? "").toBe("");
    expect(filmJob!.results[0]).toMatch(/^\/api\/boards\/film\/board-film-[0-9a-f]{32}\.mp4$/);

    // 成片可访问 + 非空 + 字幕侧车(台词已确定性注入,ASS 必出)
    const vr = await page.request.get(filmJob!.results[0], { headers: H });
    expect(vr.ok()).toBeTruthy();
    expect((await vr.body()).length).toBeGreaterThan(50_000);
    expect(filmJob!.film?.ass_url ?? "").toBeTruthy();
    const ar2 = await page.request.get(filmJob!.film.ass_url!, { headers: H });
    expect(ar2.ok()).toBeTruthy();
    const assText = await ar2.text();
    expect(assText).toContain("Dialogue:");
    expect(assText).toContain("{\\k");
    console.log(`FILM_E2E_ASS_OK: ${assText.split("\n").filter((l) => l.startsWith("Dialogue")).length} 条字幕事件`);
    // film strip 在 UI 出现(播放卡)
    await page.screenshot({ path: "ui-sweep/board-film-strip.png" });
    console.log(`FILM_E2E_OK: ${filmJob!.results[0]}`);
  } finally {
    if (boardId) await page.request.delete(`/api/boards/${boardId}`, { headers: H }).catch(() => {});
    for (const eid of cleanupEntityIds) {
      await page.request.delete(`/api/entities/${eid}`, { headers: H }).catch(() => {});
    }
  }
});
