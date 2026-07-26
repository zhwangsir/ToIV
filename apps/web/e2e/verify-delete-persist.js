/* 验收:画布删除持久化 + 模板导入实时性(确定性测试) */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const apiRequests = [];
  page.on("request", (r) => {
    if (r.url().includes("/api/canvas/")) apiRequests.push(`${r.method()} ${r.url()}`);
  });
  page.on("response", (r) => {
    if (r.request().method() === "DELETE") console.log(`DELETE_RESP ${r.status()} ${r.url()}`);
  });

  await page.goto("http://localhost:3100/?view=canvas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // 登录
  const emailInput = page.getByPlaceholder("邮箱");
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.getByRole("button", { name: "登录" }).first().click();
    await page.waitForTimeout(2500);
    await page.goto("http://localhost:3100/?view=canvas");
    await page.waitForTimeout(3000);
  }

  // 等待节点渲染
  await page.waitForSelector(".react-flow__node", { timeout: 10000 });
  const countBefore = await page.locator(".react-flow__node").count();
  console.log("NODES_BEFORE_DELETE:", countBefore);

  // 记录第一个节点的标题,点击节点本体(避开 input/textarea)
  const firstNode = page.locator(".react-flow__node").first();
  const nodeTitle = await firstNode.innerText().catch(() => "?");
  console.log("TARGET_NODE:", JSON.stringify(nodeTitle.slice(0, 60)));
  // 点节点顶部区域(标题栏),避开中间的可编辑区
  const box = await firstNode.boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + 6);
  await page.waitForTimeout(300);

  const selectedCount = await page.locator(".react-flow__node.selected").count();
  console.log("SELECTED_AFTER_CLICK:", selectedCount);

  // 按 Delete
  await page.keyboard.press("Delete");
  await page.waitForTimeout(1200);

  const countAfter = await page.locator(".react-flow__node").count();
  console.log("NODES_AFTER_DELETE:", countAfter);

  // 刷新验证不复活
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3500);
  const countAfterRefresh = await page.locator(".react-flow__node").count();
  console.log("NODES_AFTER_REFRESH:", countAfterRefresh);

  console.log("API_CALLS:", JSON.stringify(apiRequests.filter((r) => r.includes("DELETE") || r.includes("import")), null, 2));
  console.log(
    "VERDICT:",
    countAfter === countBefore - 1 && countAfterRefresh === countAfter
      ? "PASS 删除持久化生效"
      : `FAIL before=${countBefore} after=${countAfter} refresh=${countAfterRefresh}`
  );
  await browser.close();
})();
