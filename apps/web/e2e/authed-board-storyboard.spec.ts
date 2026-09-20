// 分镜板 v2(M1)真机验证:LLM 剧本拆镜/分镜行编辑持久/挂作品+灯箱/单镜重生成/导出 drama_studio
import { test, expect } from "@playwright/test";

// 隧道(TS 跨省 ~37KB/s)下全局放宽:导航 60s / 动作 30s
test.beforeEach(({ page }) => {
  page.setDefaultNavigationTimeout(60000);
  page.setDefaultTimeout(30000);
});

const SCRIPT_MARK = `e2e拆镜${Date.now() % 100000}`;

test("board storyboard: script split / edit / attach+lightbox / regen / export", async ({ page }) => {
  test.setTimeout(420000);
  await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
  const token = await page.evaluate(() => localStorage.getItem("toiv_token") ?? "");
  const H = { Authorization: `Bearer ${token}` };

  let boardId = "";
  try {
    // ── ① LLM 剧本拆镜(真实 DSv4,20-30s;离线则环境性跳过并走 API 兜底) ──
    await page.getByRole("button", { name: "画板" }).click();
    // 入口可见即列表已加载(不要求已有板:账号可能零板)
    await expect(page.getByRole("button", { name: "剧本拆镜" })).toBeVisible({ timeout: 30000 });
    await page.getByRole("button", { name: "剧本拆镜" }).click();
    await page.getByLabel("剧本文本").fill(`${SCRIPT_MARK}:雨夜,少年进破庙避雨,遇见烤火的少女,两人相对无言。`);
    await page.getByLabel("镜头数").fill("3");
    await page.getByRole("button", { name: "开始拆镜" }).click();
    const rowsAppear = page.locator(".lib-shot-row").first();
    const llmFailed = page.getByText(/剧本拆镜失败|拆解服务暂不可用/).first();
    const winner = await Promise.race([
      rowsAppear.waitFor({ timeout: 150000 }).then(() => "rows").catch(() => "timeout"),
      llmFailed.waitFor({ timeout: 150000 }).then(() => "failed").catch(() => "timeout"),
    ]);
    if (winner !== "rows") {
      console.log(`SCRIPT_E2E_SKIP: LLM 拆镜不可用(${winner}),走 API 兜底建板`);
      // 失败时拆镜 Modal 不会自动关(成功才关)——先等请求收尾再点取消关闭
      const cancelBtn = page.getByRole("button", { name: "取消" });
      await expect(cancelBtn).toBeEnabled({ timeout: 60000 }).catch(() => {});
      await cancelBtn.click().catch(() => {});
      // API 兜底:建板 + 占位行,继续验证分镜视图交互
      const rb = await page.request.post("/api/boards", {
        headers: { ...H, "Content-Type": "application/json" },
        data: { name: `${SCRIPT_MARK} 兜底板` },
      });
      boardId = (await rb.json()).id as string;
      await page.request.put(`/api/boards/${boardId}/items`, {
        headers: { ...H, "Content-Type": "application/json" },
        data: { items: [{ job_id: "", shot_text: "镜一占位" }, { job_id: "", shot_text: "镜二占位" }] },
      });
      const fbCard = page.locator(".lib-board-card", { hasText: SCRIPT_MARK }).first();
      await expect(fbCard).toBeVisible({ timeout: 60000 });
      await fbCard.locator(".lib-thumb-hit").click();
      await page.getByRole("button", { name: "分镜", exact: true }).click();
    } else {
      // 拆镜成功:自动进入分镜模式
      const n = await page.locator(".lib-shot-row").count();
      expect(n).toBeGreaterThanOrEqual(2);
      await page.screenshot({ path: "ui-sweep/board-story-split.png" });
    }

    // 板 id(API 按名查,导出/清理用)
    const boards = await (await page.request.get("/api/boards", { headers: H })).json();
    boardId = (boards as { id: string; name: string }[]).find((b) => b.name.includes(SCRIPT_MARK))?.id ?? boardId;
    expect(boardId).toBeTruthy();

    // ── ② 分镜文本编辑 → 失焦保存 → API 核实持久 ──
    const editor = page.getByLabel("分镜文本: 第 1 镜");
    await editor.fill(`e2e 改写文本 ${SCRIPT_MARK}`);
    await page.locator(".lib-shot-idx").first().click(); // 失焦触发保存
    await expect
      .poll(
        async () => {
          const items = await (await page.request.get(`/api/boards/${boardId}/items`, { headers: H })).json();
          return (items as { shot_text: string }[])[0]?.shot_text ?? "";
        },
        { timeout: 20000, intervals: [800] },
      )
      .toContain("e2e 改写文本");

    // ── ③ 挂作品 → 行显缩略图 → 点开灯箱(覆盖 showBoards 早退 bug 路径) ──
    await page.getByRole("button", { name: "挂作品: 第 1 镜" }).click();
    await expect(page.locator(".lib-shot-picker")).toBeVisible({ timeout: 20000 });
    const firstWork = page.locator(".lib-shot-picker-item").first();
    await expect(firstWork).toBeVisible({ timeout: 30000 });
    await firstWork.click();
    const thumb = page.locator(".lib-shot-row").first().locator(".lib-shot-thumb-hit");
    await expect(thumb).toBeVisible({ timeout: 20000 });
    await page.screenshot({ path: "ui-sweep/board-story-attached.png" });
    await thumb.click();
    await page.waitForSelector(".lib-lightbox", { timeout: 15000 });
    await page.screenshot({ path: "ui-sweep/board-story-lightbox.png" });
    await page.keyboard.press("Escape");
    await expect(page.locator(".lib-lightbox")).toHaveCount(0);

    // ── ④ 单镜重生成(作业类型支持时;遮罩/换卡任一流转即算提交成功,照 P1 模式) ──
    const regenBtn = page.getByRole("button", { name: "重生成: 第 1 镜" });
    if (await regenBtn.isEnabled()) {
      await regenBtn.click();
      await expect
        .poll(
          async () => {
            const chip = await page.locator(".lib-shot-row").first().locator(".lib-shot-status").innerText();
            return chip.includes("重生成中") || chip.includes("已完成") || chip.includes("排队") || chip.includes("生成中");
          },
          { timeout: 45000, intervals: [1000] },
        )
        .toBe(true);
    } else {
      console.log("REGEN_E2E_SKIP: 第 1 镜作业类型不在 rerun 白名单");
    }

    // ── ⑤ 刷新重进:分镜模式 + 改写文本仍在(UI 持久闭环) ──
    await page.goto("/?view=library", { waitUntil: "domcontentloaded" });
    await page.waitForFunction(() => document.body.innerText.length > 100, undefined, { timeout: 60000 });
    await page.getByRole("button", { name: "画板" }).click();
    const cardAgain = page.locator(".lib-board-card", { hasText: SCRIPT_MARK }).first();
    await expect(cardAgain).toBeVisible({ timeout: 60000 });
    await cardAgain.locator(".lib-thumb-hit").click();
    await page.getByRole("button", { name: "分镜", exact: true }).click();
    await expect(page.locator(".lib-shot-row").first()).toBeVisible({ timeout: 30000 });
    await expect(page.getByLabel("分镜文本: 第 1 镜")).toHaveValue(/e2e 改写文本/, { timeout: 20000 });

    // ── ⑥ 导出 drama_studio 格式(API 验形状,不走 UI 下载避 flake) ──
    const er = await page.request.get(`/api/boards/${boardId}/export`, { headers: H });
    expect(er.ok()).toBeTruthy();
    expect(er.headers()["content-disposition"] ?? "").toContain("attachment");
    const doc = (await er.json()) as {
      title: string;
      characters: { name: string }[];
      shots: { idx: number; scene: string; image_url: string; video_url: string }[];
      narration: unknown[];
    };
    expect(doc.title).toContain(SCRIPT_MARK.slice(0, 8));
    expect(doc.shots.length).toBeGreaterThanOrEqual(2);
    expect(doc.shots.map((s) => s.idx)).toEqual(doc.shots.map((_, i) => i + 1)); // idx 连续
    expect(doc.shots[0].scene).toContain("e2e 改写文本");
    expect(doc.shots[0].image_url || doc.shots[0].video_url).toBeTruthy(); // 已挂作品行有媒体
    console.log(`BOARD_STORY_E2E_OK: shots=${doc.shots.length} narration=${doc.narration.length}`);
  } finally {
    if (boardId) await page.request.delete(`/api/boards/${boardId}`, { headers: H }).catch(() => {});
  }
});
