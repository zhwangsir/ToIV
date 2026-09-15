import { chromium } from "@playwright/test";
import http from "node:http";
import { readFileSync } from "node:fs";
const TOKEN = readFileSync("/tmp/toiv_admin_token", "utf8").trim();
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
let n = 0;
await page.route("**/api/apps/covers/file/**", (route) => {
  const url = new URL(route.request().url());
  url.searchParams.set("token", TOKEN);
  const target = "http://100.77.80.100:8090" + url.pathname + "?" + url.searchParams.toString();
  n++;
  new Promise((resolve, reject) => {
    http.get(target, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve(Buffer.concat(chunks)));
    }).on("error", reject);
  }).then((data) => route.fulfill({ status: 200, contentType: "image/jpeg", body: data }))
    .catch(() => route.fulfill({ status: 404, body: "" }));
});
await page.goto("file:///Users/wangzhenyu/Desktop/ALLProject/ToIV/.regen_tmp/ui_mockup.html");
await page.waitForTimeout(2500);
await page.screenshot({ path: "/Users/wangzhenyu/Desktop/ALLProject/ToIV/.regen_tmp/ui_mockup_full.png", fullPage: true });
console.log("shots ok, images fetched:", n);
await browser.close();
