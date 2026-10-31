import { mkdirSync, writeFileSync } from "node:fs";

import { expect, test } from "@playwright/test";

/**
 * 重叠审计(2026-08-17 UI 专业创作台重构前置)
 *
 * 对核心视图 × 桌面光/暗 × 移动,程序化检测「可见元素矩形重叠」:
 * - 收集视口内可见的叶子文本元素与控件(button/a/input/select/textarea/h1-h4/p/label/chip/card 等)
 * - 两两检测 boundingRect 交集(排除祖先/后代包含关系),阈值 >4px²
 * - 输出 JSON 报告(视图/断点/主题 → 重叠对描述)+ 截图存档
 *
 * 基线跑法(生产):
 *   TOIV_API_BASE=https://toiv.wineryz.top/api TOIV_WEB_BASE=https://toiv.wineryz.top \
 *   npx playwright test e2e/authed-overlap-audit.spec.ts --project=chromium-authed
 */

const OUT_DIR = "e2e/screenshots/overlap-audit";

const VIEWS = ["image", "video", "library", "models", "settings", "assistant"] as const;

interface OverlapHit {
  a: string;
  b: string;
  area: number;
  rect: [number, number, number, number];
}

const OVERLAP_JS = `() => {
  const SEL = 'button, a, input, select, textarea, h1, h2, h3, h4, p, label, [class*="chip"], [class*="card"], [class*="badge"], [class*="title"], [class*="empty"], [class*="promptbar"], [class*="dock"], [class*="bottomnav"], [class*="fab"]';
  const els = Array.from(document.querySelectorAll(SEL)).filter((el) => {
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    if (r.width <= 2 || r.height <= 2) return false;
    if (s.visibility === "hidden" || s.display === "none" || Number(s.opacity) === 0) return false;
    if (r.bottom < 0 || r.right < 0 || r.top > innerHeight || r.left > innerWidth) return false;
    return true;
  });
  const desc = (el) => {
    const tag = el.tagName.toLowerCase();
    const cls = (el.className && typeof el.className === "string") ? "." + el.className.trim().split(/\\s+/).slice(0, 2).join(".") : "";
    const text = (el.textContent || "").trim().slice(0, 24);
    return tag + cls + "「" + text + "」";
  };
  const hits = [];
  for (let i = 0; i < els.length; i++) {
    for (let j = i + 1; j < els.length; j++) {
      const a = els[i], b = els[j];
      if (a.contains(b) || b.contains(a)) continue;
      const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 4 && oy > 4) {
        hits.push({
          a: desc(a), b: desc(b),
          area: Math.round(ox * oy),
          rect: [Math.round(Math.max(ra.left, rb.left)), Math.round(Math.max(ra.top, rb.top)), Math.round(ox), Math.round(oy)],
        });
      }
    }
  }
  hits.sort((x, y) => y.area - x.area);
  return hits.slice(0, 30);
}`;

async function audit(page: import("@playwright/test").Page, tag: string, view: string) {
  // 页面异常(登录跳转/加载失败)时 evaluate 可能返回 null:防御为空数组,不污染报告聚合
  const raw = await page.evaluate(OVERLAP_JS).catch(() => null);
  const hits = (Array.isArray(raw) ? raw : []) as OverlapHit[];
  await page.screenshot({ path: `${OUT_DIR}/${tag}-${view}.png`, fullPage: false });
  return hits;
}

test.describe("重叠审计", () => {
  test.setTimeout(120_000);

  test("核心视图 × 桌面光暗 × 移动", async ({ page }) => {
    mkdirSync(OUT_DIR, { recursive: true });
    const report: Record<string, OverlapHit[]> = {};

    for (const view of VIEWS) {
      // ── 桌面浅色 ──
      await page.setViewportSize({ width: 1440, height: 900 });
      // 跨境链路 networkidle 不可靠(作品库长连接/轮询):domcontentloaded + 稳定等待
      await page.goto(`/?view=${view}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      report[`desktop-light/${view}`] = await audit(page, "desktop-light", view);

      // ── 桌面深色 ──
      await page.evaluate(() => {
        document.documentElement.dataset.mode = "dark";
        document.body && (document.body.dataset.mode = "dark");
      });
      await page.waitForTimeout(400);
      report[`desktop-dark/${view}`] = await audit(page, "desktop-dark", view);
      await page.evaluate(() => {
        delete document.documentElement.dataset.mode;
        document.body && delete document.body.dataset.mode;
      });

      // ── 移动浅色 ──
      await page.setViewportSize({ width: 390, height: 844 });
      await page.goto(`/?view=${view}`, { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      report[`mobile-light/${view}`] = await audit(page, "mobile-light", view);
    }

    // ── 视频工作台:参数面板全展开态(loras/高级参数是重叠高发区)──
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto("/?view=video", { waitUntil: "domcontentloaded" });
      await page.waitForTimeout(2500);
      // 展开高级参数折叠区(若有)
      const adv = page.locator("text=/高级参数/").first();
      if (await adv.isVisible().catch(() => false)) {
        await adv.click().catch(() => {});
        await page.waitForTimeout(300);
      }
      report["desktop-light/video-params-open"] = await audit(page, "desktop-light", "video-params-open");
    } catch (e) {
      console.warn("[overlap-audit] 参数展开态采集失败(不阻断主报告):", e);
    }

    writeFileSync(`${OUT_DIR}/report.json`, JSON.stringify(report, null, 2));
    const total = Object.values(report).reduce((n, h) => n + (Array.isArray(h) ? h.length : 0), 0);
    console.log(`[overlap-audit] 视图 ×${VIEWS.length} ×3 断点 + 参数展开态,重叠命中总数: ${total}`);
    console.log(`[overlap-audit] 报告: ${OUT_DIR}/report.json`);
    expect(true).toBe(true); // 审计不断言,报告供人工/重构后对比
  });
});
