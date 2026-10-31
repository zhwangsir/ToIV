// 整片级 remix(M3.5)真机验证:克隆换词→视频全复用→新台词进成片;原版不动
import { test, expect } from "@playwright/test";

test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

const MARK = `rx${Date.now() % 100000}`;

test("board remix words: clone+override, videos reused, new dialogue in film ass", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const H = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };

  let bid = "";
  let nbid = "";
  try {
    // ── ① 源板:两行各挂一个已完成引擎视频作业(复用源,零 LLM 零视频生成;
    //     只取 /api/images 产物形态——board_film 成片走站内端点,链式 remix 另行覆盖) ──
    const jobs = await (await page.request.get("/api/jobs?status=done&limit=20", { headers: H })).json();
    const vids = (jobs as { id: string; results?: string[] }[]).filter(
      (j) => (j.results ?? []).some((u) => u.startsWith("/api/images") && u.includes(".mp4")),
    );
    test.skip(vids.length < 2, "作品库可用视频作业不足,环境性跳过");
    const rb = await page.request.post("/api/boards", {
      headers: H,
      data: { name: `remix源板${MARK}` },
    });
    bid = (await rb.json()).id as string;
    const rows = [
      { prompt: "old watchman on platform, rain", duration_sec: 2, dialogue: "原版台词一", speaker: "老周" },
      { prompt: "young apprentice close-up", duration_sec: 2, dialogue: "原版台词二", speaker: "小林" },
    ];
    const pr = await page.request.put(`/api/boards/${bid}/items`, {
      headers: H,
      data: {
        items: rows.map((m, i) => ({
          job_id: vids[i].id,
          shot_text: `镜${i + 1}`,
          shot_meta: JSON.stringify(m),
        })),
      },
    });
    expect(pr.ok()).toBeTruthy();
    const items = (await (await page.request.get(`/api/boards/${bid}/items`, { headers: H })).json()) as {
      id: number;
      job: { id: string } | null;
      shot_meta: string;
    }[];
    const item0 = items[0].id;

    // ── ② remix 换词(视频全复用) ──
    const rr = await page.request.post(`/api/boards/${bid}/remix`, {
      headers: H,
      data: {
        kind: "words",
        engine: "h3-t2v",
        dialogue_overrides: { [item0]: { dialogue: `remix新词${MARK}:灯亮着,人就安全。` } },
      },
    });
    expect(rr.ok(), await rr.text()).toBeTruthy();
    const remix = (await rr.json()) as {
      board: { id: string; name: string };
      stats: { video_reset: number; voice_redo: number };
      film: { prompt_id: string } | null;
    };
    nbid = remix.board.id;
    expect(remix.board.name).toContain("remix换词");
    expect(remix.stats.video_reset).toBe(0); // words 复用语义
    const fpid = remix.film?.prompt_id ?? "";
    expect(fpid).toMatch(/^film-/);

    // ── ③ 轮询成片(全复用,快) ──
    let film: { status: string; results: string[]; film: { ass_url?: string } } | null = null;
    await expect
      .poll(
        async () => {
          const jobs2 = (await (await page.request.get(`/api/boards/${nbid}/film-jobs`, { headers: H })).json()) as {
            prompt_id: string; status: string; results: string[]; film: { ass_url?: string };
          }[];
          film = jobs2.find((j) => j.prompt_id === fpid) ?? null;
          return film?.status ?? "missing";
        },
        { timeout: 300000, intervals: [5000] },
      )
      .toBe("done");

    // 字幕侧车:剥 \k 标签后含新词语义(whisper 转写可能有出入,不断言原文逐字)
    const assUrl = film!.film?.ass_url ?? "";
    expect(assUrl).toBeTruthy();
    const ar = await page.request.get(assUrl, { headers: H });
    const ass = (await ar.text()).replace(/\{\\k\d+\}/g, "");
    expect(ass).not.toContain("原版台词一"); // 旧词已被换掉
    expect(ass).toContain("原版台词二"); // 未改写的镜保留原词
    expect(ass).toMatch(/新|词/); // 新词片段(转写容错)

    // ── ④ 原版不动 ──
    const itemsAfter = (await (await page.request.get(`/api/boards/${bid}/items`, { headers: H })).json()) as {
      job: { id: string } | null;
      shot_meta: string;
    }[];
    expect(JSON.parse(itemsAfter[0].shot_meta).dialogue).toBe("原版台词一");
    expect(itemsAfter[0].job?.id).toBe(vids[0].id);
    console.log(`REMIX_E2E_OK: film=${fpid} ass_dialogues_ok`);
  } finally {
    for (const x of [bid, nbid]) {
      if (x) await page.request.delete(`/api/boards/${x}`, { headers: H }).catch(() => {});
    }
  }
});
