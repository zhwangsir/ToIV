const { chromium } = require("playwright");
(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const res = await page.request.post("http://192.168.71.47:8090/api/auth/login", { data: { email: "admin", password: "admin123" } });
  const body = await res.json();
  await page.goto("http://192.168.71.47:3100");
  await page.evaluate((t) => localStorage.setItem("toiv_token", t), body.token);
  for (const v of ["fusion", "image", "assistant", "library"]) {
    await page.goto("http://192.168.71.47:3100/?view=" + v);
    await page.waitForTimeout(3000);
    await page.screenshot({ path: `/tmp/prod_${v}.png` });
  }
  await browser.close();
})();
