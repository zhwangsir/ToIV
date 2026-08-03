import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import * as fs from "fs";
import * as path from "path";

/**
 * UI/UX 五维度量化指标采集 (chromium-authed project)
 *
 * 设计:单 test 函数串行采集全部指标,避免并行 worker 导致模块状态不共享。
 * 输出: test-results-prod/ux-metrics.json
 *
 * 维度:
 *  1. 视觉设计 —— CLS + 控制台错误
 *  2. 交互流畅度 —— 操作时延 + 成功率
 *  3. 响应速度 —— TTFB / FCP / LCP / load
 *  4. 易用性 —— 通过率 + 交互成功率
 *  5. 可访问性 —— AxeBuilder 扫描
 */

const METRICS_DIR = "test-results-prod";
const METRICS_PATH = path.join(METRICS_DIR, "ux-metrics.json");
const SHOT_DIR = path.join(METRICS_DIR, "ux-shots");

interface ViewMetrics {
  view: string; url: string; status: number; loadMs: number;
  ttfbMs: number; fcpMs: number; lcpMs: number; cls: number; inpMs: number;
  domNodes: number; consoleErrors: number; requestCount: number; totalTransferKB: number;
}
interface InteractionMetric { action: string; view: string; latencyMs: number; success: boolean; note: string; }
interface AccessibilityMetric {
  view: string; violations: number; critical: number; serious: number;
  moderate: number; minor: number;
  /** 键盘导航探测:可聚焦元素计数 + 首次 Tab 是否到达可见交互元素 */
  keyboard: { focusableCount: number; tabReachesVisible: boolean; firstTabTarget: string };
  details: { rule: string; impact: string; help: string; count: number }[];
}

const VIEWS = [
  { key: "assistant", url: "/?view=assistant", name: "对话流" },
  { key: "generate", url: "/?view=generate", name: "生成" },
  { key: "library", url: "/?view=library", name: "作品库" },
  { key: "models", url: "/?view=models", name: "模型库" },
  { key: "canvas", url: "/?view=canvas", name: "画布" },
  { key: "dramaStudio", url: "/?view=dramaStudio&mode=manju", name: "短剧工作室" },
  { key: "dub", url: "/?view=dub", name: "译制" },
  { key: "admin", url: "/?view=admin", name: "管理" },
];

async function injectVitals(page: Page) {
  await page.addInitScript(() => {
    (window as any).__vitals = { ttfb: 0, fcp: 0, lcp: 0, cls: 0, inp: 0 };
    const w = window as any;
    const nav = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
    if (nav) w.__vitals.ttfb = nav.responseStart - nav.requestStart;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.name === "first-contentful-paint") w.__vitals.fcp = e.startTime;
    }).observe({ type: "paint", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__vitals.lcp = e.startTime;
    }).observe({ type: "largest-contentful-paint", buffered: true });
    let cls = 0;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any) if (!e.hadRecentInput) cls += e.value;
      w.__vitals.cls = cls;
    }).observe({ type: "layout-shift", buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as any)
        if (e.interactionId) w.__vitals.inp = Math.max(w.__vitals.inp, e.duration);
    }).observe({ type: "event", buffered: true });
  });
}

test.describe.configure({ timeout: 300000 });

test("UI/UX 五维度指标综合采集", async ({ page }) => {
  const viewMetrics: ViewMetrics[] = [];
  const interactionMetrics: InteractionMetric[] = [];
  const a11yMetrics: AccessibilityMetric[] = [];

  if (!fs.existsSync(SHOT_DIR)) fs.mkdirSync(SHOT_DIR, { recursive: true });

  // ── 1. 响应速度 + 视觉设计指标(8 视图)──
  for (const v of VIEWS) {
    await injectVitals(page);
    const consoleErrors: string[] = [];
    const handler = (msg: any) => { if (msg.type() === "error") consoleErrors.push(msg.text()); };
    page.on("console", handler);

    let requestCount = 0;
    let totalTransfer = 0;
    const respHandler = (res: any) => {
      requestCount++;
      const len = res.headers()["content-length"];
      if (len) totalTransfer += parseInt(len, 10);
    };
    page.on("response", respHandler);

    const start = Date.now();
    let response;
    try {
      response = await page.goto(v.url, { waitUntil: "domcontentloaded", timeout: 45000 });
    } catch (e) {
      // 超时也继续,记录失败
      viewMetrics.push({
        view: v.key, url: v.url, status: 0, loadMs: Date.now() - start,
        ttfbMs: 0, fcpMs: 0, lcpMs: 0, cls: 0, inpMs: 0, domNodes: 0,
        consoleErrors: consoleErrors.length + 1, requestCount, totalTransferKB: Math.round(totalTransfer / 1024),
      });
      page.off("console", handler);
      page.off("response", respHandler);
      continue;
    }
    const loadMs = Date.now() - start;
    await page.waitForTimeout(2500);

    const vitals = await page.evaluate(() => (window as any).__vitals).catch(() => ({}));
    const domNodes = await page.evaluate(() => document.querySelectorAll("*").length).catch(() => 0);

    await page.screenshot({ path: path.join(SHOT_DIR, `${v.key}.png`), fullPage: false }).catch(() => {});

    viewMetrics.push({
      view: v.key, url: v.url, status: response?.status() ?? 0, loadMs,
      ttfbMs: Math.round(vitals?.ttfb ?? 0), fcpMs: Math.round(vitals?.fcp ?? 0),
      lcpMs: Math.round(vitals?.lcp ?? 0), cls: Math.round((vitals?.cls ?? 0) * 1000) / 1000,
      inpMs: Math.round(vitals?.inp ?? 0), domNodes, consoleErrors: consoleErrors.length,
      requestCount, totalTransferKB: Math.round(totalTransfer / 1024),
    });
    page.off("console", handler);
    page.off("response", respHandler);
  }

  // ── 2. 交互流畅度指标 ──
  // 对话流发送消息
  await page.goto("/?view=assistant", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const textarea = page.locator("textarea").first();
  if (await textarea.isVisible().catch(() => false)) {
    const t0 = Date.now();
    await textarea.fill("E2E 测试消息");
    await textarea.press("Enter");
    await page.waitForTimeout(1500);
    interactionMetrics.push({ action: "发送对话消息", view: "assistant", latencyMs: Date.now() - t0, success: true, note: "textarea+Enter" });
  } else {
    interactionMetrics.push({ action: "发送对话消息", view: "assistant", latencyMs: 0, success: false, note: "未找到 textarea" });
  }

  // 侧栏切换(通过左侧栏 .app-sidebar-item)
  // W0 后主导航为左侧栏:直接点击匹配 label 的侧栏按钮切换视图
  // 真实渲染时延 = 点击侧栏项 → 目标视图根节点挂载(替代旧固定 1200ms 等待,
  // 旧值 ≈1200ms 固定等待 + 点击动作开销,无法反映并行化/预热优化效果)。
  // 注意:models 已不在侧栏一级导航(改经 URL 访问),侧栏切换目标用 resources 替代
  const VIEW_ROOT: Record<string, string> = {
    generate: ".generate-view",
    library: ".library-view",
    resources: ".resources-view",
    canvas: ".canvas-view",
    assistant: ".av-view",
  };
  const targets = [
    { key: "generate",  label: "生成" },
    { key: "library",   label: "作品库" },
    { key: "resources", label: "资源" },
    { key: "canvas",    label: "画布" },
    { key: "assistant", label: "对话" },
  ];
  for (const tgt of targets) {
    try {
      // 点击匹配 label 的侧栏项,测量从点击到目标视图根节点挂载的时延
      const item = page.locator(".app-sidebar-item", { hasText: tgt.label }).first();
      await item.waitFor({ state: "visible", timeout: 5000 });
      const t0 = Date.now();
      await item.click({ timeout: 5000 });
      const mounted = await page
        .locator(VIEW_ROOT[tgt.key])
        .first()
        .waitFor({ state: "attached", timeout: 8000 })
        .then(() => true)
        .catch(() => false);
      const latency = Date.now() - t0;
      interactionMetrics.push({
        action: `侧栏切换→${tgt.key}`,
        view: "sidebar",
        latencyMs: latency,
        success: mounted,
        note: mounted ? "sidebar click→视图挂载" : "点击后 8s 内视图未挂载",
      });
      // 切换后留 300ms 稳定,避免下一次点击时目标视图仍在退场动画
      await page.waitForTimeout(300);
    } catch (e) {
      interactionMetrics.push({
        action: `侧栏切换→${tgt.key}`,
        view: "sidebar",
        latencyMs: 0,
        success: false,
        note: e instanceof Error ? e.message.slice(0, 80) : "侧栏切换失败",
      });
    }
  }

  // 新建画布
  await page.goto("/?view=canvas", { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2000);
  const newBtn = page.locator('button[aria-label="新建画布"]').first();
  if (await newBtn.isVisible().catch(() => false)) {
    const t0 = Date.now();
    await newBtn.click();
    await page.waitForTimeout(1000);
    interactionMetrics.push({ action: "新建画布", view: "canvas", latencyMs: Date.now() - t0, success: true, note: "click→创建" });
  } else {
    interactionMetrics.push({ action: "新建画布", view: "canvas", latencyMs: 0, success: false, note: "未找到新建画布按钮" });
  }

  // ── 3. 可访问性指标(AxeBuilder 全 8 视图 + 键盘导航/焦点探测 + WCAG 监控门禁)──
  for (const v of VIEWS) {
    try {
      await page.goto(v.url, { waitUntil: "domcontentloaded", timeout: 30000 });
      await page.waitForTimeout(2500);

      // WCAG 扫描(含焦点状态/对比度/ARIA/屏幕阅读器兼容等规则族)
      const results = await new AxeBuilder({ page }).analyze();
      const violations = results.violations || [];
      const byImpact = (imp: string) => violations.filter((x: any) => x.impact === imp).length;

      // 键盘导航探测:可聚焦元素计数 + 从 body 首次 Tab 是否到达可见交互元素
      const focusableCount = await page.evaluate(() => {
        const sel = 'a[href], button, input, textarea, select, [tabindex]:not([tabindex="-1"])';
        return Array.from(document.querySelectorAll<HTMLElement>(sel))
          .filter((el) => !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length))
          .length;
      });
      await page.evaluate(() => {
        (document.activeElement as HTMLElement | null)?.blur?.();
        document.body.setAttribute("tabindex", "-1");
        document.body.focus();
      });
      await page.keyboard.press("Tab");
      const tabInfo = await page.evaluate(() => {
        const ae = document.activeElement as HTMLElement | null;
        if (!ae || ae === document.body || ae === document.documentElement)
          return { target: "", visible: false };
        const r = ae.getBoundingClientRect();
        const label =
          ae.getAttribute("aria-label") ||
          ae.textContent?.trim().slice(0, 20) ||
          ae.tagName.toLowerCase();
        return { target: label, visible: r.width > 0 && r.height > 0 };
      });

      const critical = byImpact("critical");
      const serious = byImpact("serious");
      a11yMetrics.push({
        view: v.key, violations: violations.length,
        critical, serious,
        moderate: byImpact("moderate"), minor: byImpact("minor"),
        keyboard: {
          focusableCount,
          tabReachesVisible: tabInfo.visible,
          firstTabTarget: tabInfo.target,
        },
        details: violations.map((x: any) => ({ rule: x.id, impact: x.impact, help: x.help, count: x.nodes?.length ?? 0 })),
      });

      // 持续监控门禁:AA 级 critical/serious 零容忍;键盘 Tab 必须可达可见交互元素
      expect(critical, `[${v.name}] 不应存在 critical 级 a11y 违规`).toBe(0);
      expect(serious, `[${v.name}] 不应存在 serious 级 a11y 违规`).toBe(0);
      expect(tabInfo.visible, `[${v.name}] 键盘 Tab 应能到达可见交互元素`).toBe(true);
    } catch (e) {
      a11yMetrics.push({
        view: v.key, violations: -1, critical: 0, serious: 0, moderate: 0, minor: 0,
        keyboard: { focusableCount: 0, tabReachesVisible: false, firstTabTarget: "" },
        details: [{ rule: "scan-error", impact: "n/a", help: e instanceof Error ? e.message.slice(0, 120) : String(e), count: 1 }],
      });
      throw e; // 扫描失败视同监控告警,不放行
    }
  }

  // ── 写入汇总文件 ──
  if (!fs.existsSync(METRICS_DIR)) fs.mkdirSync(METRICS_DIR, { recursive: true });
  fs.writeFileSync(METRICS_PATH, JSON.stringify({
    generatedAt: new Date().toISOString(),
    viewMetrics, interactionMetrics, a11yMetrics,
  }, null, 2));

  console.log(`[ux-metrics] 视图:${viewMetrics.length} 交互:${interactionMetrics.length} 可访问:${a11yMetrics.length}`);
  console.log(`[ux-metrics] 已写入 ${METRICS_PATH}`);

  // 基本断言(不强制全部成功,确保采集到数据)
  expect(viewMetrics.length, "应采集到至少 6 个视图指标").toBeGreaterThanOrEqual(6);
});
