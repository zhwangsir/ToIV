/* 验收:节点连线(从 source handle 拖到 target handle) */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on("response", (r) => {
    if (r.request().method() === "POST" && r.url().includes("/edges"))
      console.log(`ADD_EDGE_RESP ${r.status()}`);
  });

  await page.goto("http://localhost:3100/?view=canvas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);
  const emailInput = page.getByPlaceholder("邮箱");
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.getByRole("button", { name: "登录" }).first().click();
    await page.waitForTimeout(2500);
    await page.goto("http://localhost:3100/?view=canvas");
    await page.waitForTimeout(3000);
  }

  await page.waitForSelector(".react-flow__node", { timeout: 10000 });
  const edgesBefore = await page.locator(".react-flow__edge").count();
  console.log("EDGES_BEFORE:", edgesBefore);

  // 列出所有 handle
  const handles = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll(".react-flow__node").forEach((n) => {
      const id = n.getAttribute("data-id");
      n.querySelectorAll(".react-flow__handle").forEach((h) => {
        const r = h.getBoundingClientRect();
        out.push({
          nodeId: id.slice(0, 8),
          cls: h.className.includes("source") ? "source" : h.className.includes("target") ? "target" : "?",
          x: Math.round(r.x + r.width / 2),
          y: Math.round(r.y + r.height / 2),
          visible: r.width > 0 && r.height > 0,
        });
      });
    });
    return out;
  });
  console.log("HANDLES:", JSON.stringify(handles, null, 1));

  const src = handles.find((h) => h.cls === "source" && h.visible);
  const tgt = handles.find((h) => h.cls === "target" && h.visible && h.nodeId !== src?.nodeId);
  if (!src || !tgt) {
    console.log("VERDICT: SKIP 找不到可用 handle");
    await browser.close();
    return;
  }
  console.log(`DRAG ${src.nodeId}(${src.x},${src.y}) -> ${tgt.nodeId}(${tgt.x},${tgt.y})`);

  await page.mouse.move(src.x, src.y);
  await page.mouse.down();
  await page.mouse.move((src.x + tgt.x) / 2, (src.y + tgt.y) / 2, { steps: 8 });
  await page.mouse.move(tgt.x, tgt.y, { steps: 8 });
  await page.mouse.up();
  await page.waitForTimeout(1200);

  const edgesAfter = await page.locator(".react-flow__edge").count();
  console.log("EDGES_AFTER:", edgesAfter);
  console.log("VERDICT:", edgesAfter === edgesBefore + 1 ? "PASS 连线成功" : "FAIL 连线未建立");
  await browser.close();
})();
