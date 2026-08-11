import { test, expect } from "@playwright/test";
import * as fs from "fs";
import * as path from "path";

/**
 * 对称性验证(一次性,LAYOUT-SYM-2026-08-09):
 * ≥1440 视口下,浮板展开时空态/词条应相对舞台居中(不移除避让);
 * 页头标题左缘与内容左缘对齐;1440 以下保持避让(可用区居中)。
 * 输出 test-results-prod/symmetry/*.png + 控制台测量数据。
 */

const OUT = path.join("test-results-prod", "symmetry");

async function measure(page: import("@playwright/test").Page) {
  return page.evaluate(() => {
    const vw = window.innerWidth;
    const m = (sel: string) => {
      const el = document.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { left: Math.round(r.left), right: Math.round(r.right), w: Math.round(r.width), cx: Math.round(r.left + r.width / 2) };
    };
    return {
      vw, viewportCx: vw / 2,
      headerTitle: m(".generate-header .page-header-main"),
      results: m(".generate-results"),
      empty: m(".empty-editorial"),
      promptbar: m(".promptbar"),
      params: m(".generate-params"),
      paramsOpen: !!document.querySelector(".generate-view.is-params-open"),
    };
  });
}

test.describe("对称性验证", () => {
  for (const vw of [1440, 1512, 1318]) {
    test(`image 视图 @${vw}px`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: vw, height: 900 },
        storageState: ".auth/admin.json",
      });
      const page = await ctx.newPage();
      await page.goto("/?view=image", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      const d = await measure(page);
      console.log(`[sym@${vw}]`, JSON.stringify(d));
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `image-${vw}.png`) });

      // 页头标题左缘 = 舞台左缘(对齐)
      if (d.headerTitle && d.results) {
        expect(Math.abs(d.headerTitle.left - d.results.left), "页头标题左缘应与舞台左缘对齐").toBeLessThanOrEqual(2);
      }
      if (vw >= 1440 && d.empty && d.results) {
        // ≥1440:空态相对舞台居中(中心偏差 ≤4px),且不探入浮板
        const stageCx = d.results.left + d.results.w / 2;
        expect(Math.abs(d.empty.cx - stageCx), "空态应与舞台同中心").toBeLessThanOrEqual(4);
        if (d.params) expect(d.empty.right, "空态右缘不探入浮板").toBeLessThanOrEqual(d.params.left);
        if (d.promptbar && d.params) expect(d.promptbar.right, "词条右缘不探入浮板").toBeLessThanOrEqual(d.params.left);
      }
      await ctx.close();
    });
  }

  // 其他视图页头左缘对齐抽查(1512 视口):页头标题/首个内容块左缘应与视图内容容器左缘一致
  const OTHER_VIEWS = [
    { key: "library", url: "/?view=library", header: ".library-view .page-header", body: ".library-view" },
    { key: "assistant", url: "/?view=assistant", header: ".av-header", body: ".av-view" },
    { key: "studio", url: "/?view=studio", header: ".studio-home .page-header", body: ".studio-home" },
    { key: "dub", url: "/?view=dub", header: ".dub-header", body: ".dub-view" },
    { key: "resources", url: "/?view=resources", header: ".resources-head", body: ".resources-view", wait: ".resources-head" },
    { key: "avatartalk", url: "/?view=avatartalk", header: ".at-view > .page-header", body: ".at-view" },
  ];
  for (const v of OTHER_VIEWS) {
    test(`${v.key} 页头对齐 @1512px`, async ({ browser }) => {
      const ctx = await browser.newContext({
        viewport: { width: 1512, height: 900 },
        storageState: ".auth/admin.json",
      });
      const page = await ctx.newPage();
      await page.goto(v.url, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      await page.waitForSelector(v.header, { timeout: 8000 }).catch(() => {});
      const d = await page.evaluate(({ header, body }) => {
        const m = (sel: string) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const r = el.getBoundingClientRect();
          const cs = getComputedStyle(el);
          return { left: Math.round(r.left), pl: Math.round(parseFloat(cs.paddingLeft)), w: Math.round(r.width) };
        };
        return { header: m(header), body: m(body), vw: window.innerWidth };
      }, { header: v.header, body: v.body });
      console.log(`[align:${v.key}]`, JSON.stringify(d));
      fs.mkdirSync(OUT, { recursive: true });
      await page.screenshot({ path: path.join(OUT, `${v.key}-1512.png`) });
      // 选择器必须命中,否则视为视图结构变更导致的测试失效(不允许静默跳过)
      expect(d.header, `页头选择器应命中: ${v.header}`).not.toBeNull();
      expect(d.body, `容器选择器应命中: ${v.body}`).not.toBeNull();
      // 页头内容左缘(含其 padding)不应出现 200px 级右移:页头左缘 - 容器左缘 ≤ 40(正常内边距)
      const delta = d.header!.left - d.body!.left;
      expect(delta, `页头左缘偏移应 ≤40px(实际 ${delta})`).toBeLessThanOrEqual(40);
      if (d.header!.pl !== null) expect(d.header!.pl, "页头 padding-left 不应 ≥150").toBeLessThan(150);
      await ctx.close();
    });
  }
});
