/* 临时调试:量画布布局链路实际计算高度 */
const { chromium } = require("playwright");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.goto("http://localhost:3100/?view=canvas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(1500);

  // 未登录(LandingPage 内嵌登录表单,不跳转 /login)
  const emailInput = page.getByPlaceholder("邮箱");
  if (await emailInput.isVisible().catch(() => false)) {
    await emailInput.fill("admin");
    await page.locator('input[type="password"]').first().fill("admin123");
    await page.getByRole("button", { name: "登录" }).first().click();
    await page.waitForTimeout(2500);
    await page.goto("http://localhost:3100/?view=canvas");
    await page.waitForTimeout(2500);
  }

  const state = await page.evaluate(() => ({
    url: location.href,
    title: document.title,
    bodyText: document.body.innerText.slice(0, 300),
    hasCanvasNav: !!Array.from(document.querySelectorAll("button, a")).find((b) => b.textContent?.includes("画布")),
  }));
  console.log("STATE:", JSON.stringify(state, null, 2));

  // 若在主界面但没在画布视图,点「画布」导航
  if (state.hasCanvasNav && !document.querySelector?.(".canvas-view")) {
    await page.getByText("画布", { exact: true }).first().click().catch(() => {});
    await page.waitForTimeout(2500);
  }

  const info = await page.evaluate(() => {
    const out = [];
    // 从 body 一路向下找 canvas-view 的祖先链
    let el = document.querySelector(".canvas-view");
    const chain = [];
    while (el && el !== document.body) {
      chain.push(el);
      el = el.parentElement;
    }
    chain.push(document.body, document.documentElement);
    for (const node of chain.reverse()) {
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      out.push({
        sel: node.tagName.toLowerCase() + (node.className && typeof node.className === "string" ? "." + node.className.split(" ").filter(Boolean).slice(0, 3).join(".") : ""),
        h: Math.round(r.height),
        w: Math.round(r.width),
        display: cs.display,
        position: cs.position,
        overflow: cs.overflow,
      });
    }
    const extra = [".cv-toolbar", ".cv-flow-wrap", ".react-flow", ".react-flow__viewport"];
    for (const sel of extra) {
      const n = document.querySelector(sel);
      if (!n) { out.push({ sel, exists: false }); continue; }
      const r = n.getBoundingClientRect();
      out.push({ sel, h: Math.round(r.height), w: Math.round(r.width) });
    }
    return out;
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})();
