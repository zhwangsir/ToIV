/**
 * 市场策展层(2026-09-12)单测(node:test,真实 ../lib/apps + fetch 桩):
 * ① 归一:normalizeApp 的 use_case(未知 id → "")/featured 宽容布尔
 * ② filterApps:q 命中 guide_purpose;useCase 过滤;q+useCase 叠加
 * ③ fetchUseCaseSummary:契约 URL/auth;404/非 2xx/解析失败静默降级 []
 * ④ AppMarketView 策展层接线(源码断言):chips 行/合集位/搜索提示
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  fetchUseCaseSummary,
  filterApps,
  normalizeApp,
  USE_CASES,
  USE_CASE_GROUPS,
  useCaseGroup,
  useCaseLabel,
} from "../lib/apps";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

let fetchCalls: { url: string; headers: Record<string, string> }[] = [];
let responds: { status: number; body: unknown }[] = [];

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
  responds = [];
  (globalThis as { window?: unknown }).window = {
    localStorage: {
      getItem: (k: string) => (k === "toiv_token" ? "tok-test" : null),
      setItem: () => undefined,
      removeItem: () => undefined,
    },
  };
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    fetchCalls.push({
      url: String(input),
      headers: (init?.headers ?? {}) as Record<string, string>,
    });
    const next = responds.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  const g = globalThis as { window?: unknown };
  if (realWindow === undefined) delete g.window;
  else g.window = realWindow;
});

function makeApp(id: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    name: `应用${id}`,
    description: "一句话描述",
    icon: "sparkles",
    category: "image",
    params_schema: [],
    output_kind: "image",
    is_builtin: false,
    is_nsfw: false,
    is_public: true,
    is_mine: false,
    usage_count: 7,
    sort: 100,
    ...over,
  };
}

/* ── ① 归一 ── */

test("normalizeApp:use_case 合法枚举透传,未知/缺失归一为 \"\"", () => {
  assert.equal(normalizeApp(makeApp("a", { use_case: "drama" })).use_case, "drama");
  assert.equal(normalizeApp(makeApp("b", { use_case: "not-a-case" })).use_case, "");
  assert.equal(normalizeApp(makeApp("c")).use_case, "", "缺省 = 未分类空串");
  assert.equal(normalizeApp(makeApp("d", { use_case: "" })).use_case, "");
});

test("normalizeApp:featured 宽容布尔归一(1/true 真,缺省 false)", () => {
  assert.equal(normalizeApp(makeApp("a", { featured: true })).featured, true);
  assert.equal(normalizeApp(makeApp("b", { featured: 1 })).featured, true);
  assert.equal(normalizeApp(makeApp("c")).featured, false);
});

test("useCaseLabel:枚举 id 命中中文 label,未知返回 null", () => {
  assert.equal(useCaseLabel("drama"), "短剧剧情");
  assert.equal(useCaseLabel("motion"), "动作迁移");
  assert.equal(useCaseLabel("zzz"), null);
  assert.equal(useCaseLabel(""), null);
  assert.equal(USE_CASES.length, 12, "枚举与后端契约 12 类对齐");
});

/* ── ② filterApps ── */

test("filterApps:q 命中 guide_purpose(名称/描述之外的第三搜索域)", () => {
  const apps = [
    normalizeApp(makeApp("a", { name: "复古写真", guide_purpose: "一键生成电商主图" })),
    normalizeApp(makeApp("b", { name: "口播助手", guide_purpose: null })),
    normalizeApp(makeApp("c", { name: "无指南" })),
  ];
  assert.deepEqual(filterApps(apps, { q: "电商" }).map((a) => a.id), ["a"], "guide_purpose 参与搜索");
  assert.deepEqual(filterApps(apps, { q: "口播" }).map((a) => a.id), ["b"], "名称搜索不回退");
  assert.deepEqual(filterApps(apps, { q: "不存在" }).map((a) => a.id), []);
});

test("filterApps:useCase 过滤;all/缺省不过滤;空 use_case 不算 other", () => {
  const apps = [
    normalizeApp(makeApp("a", { use_case: "drama" })),
    normalizeApp(makeApp("b", { use_case: "avatar" })),
    normalizeApp(makeApp("c")),
  ];
  assert.deepEqual(filterApps(apps, { useCase: "drama" }).map((a) => a.id), ["a"]);
  assert.deepEqual(filterApps(apps, { useCase: "all" }).map((a) => a.id), ["a", "b", "c"]);
  assert.equal(filterApps(apps).length, 3, "缺省 useCase 不过滤(签名兼容)");
});

test("filterApps:q + useCase 叠加(交集),且与 r18 门控共存", () => {
  const apps = [
    normalizeApp(makeApp("a", { use_case: "drama", name: "雨夜短剧" })),
    normalizeApp(makeApp("b", { use_case: "drama", name: "晴天头像" })),
    normalizeApp(makeApp("c", { use_case: "avatar", name: "雨夜口播" })),
    normalizeApp(makeApp("d", { use_case: "drama", name: "雨夜限制级", is_nsfw: true })),
  ];
  assert.deepEqual(
    filterApps(apps, { q: "雨夜", useCase: "drama", r18: false }).map((a) => a.id),
    ["a"],
    "q∩useCase∩SFW",
  );
  assert.deepEqual(
    filterApps(apps, { q: "雨夜", useCase: "drama", r18: true }).map((a) => a.id),
    ["a", "d"],
    "r18 on 放行 nsfw",
  );
});

/* ── ③ fetchUseCaseSummary ── */

test("fetchUseCaseSummary:GET /api/apps/use-cases/summary,auth 头,解析数组契约", async () => {
  responds.push({
    status: 200,
    body: [
      { id: "drama", label: "短剧剧情", count: 42 },
      { id: "other", label: "其他", count: "8" },
      { id: "", label: "坏行", count: 1 },
    ],
  });
  const list = await fetchUseCaseSummary();
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith("/api/apps/use-cases/summary"));
  assert.equal(fetchCalls[0].headers.Authorization, "Bearer tok-test");
  assert.deepEqual(list, [
    { id: "drama", label: "短剧剧情", count: 42 },
    { id: "other", label: "其他", count: 8 },
  ]);
});

test("fetchUseCaseSummary:404/非 2xx/异常一律静默降级 [],不抛错", async () => {
  responds.push({ status: 404, body: { detail: "Not Found" } });
  assert.deepEqual(await fetchUseCaseSummary(), []);
  responds.push({ status: 500, body: {} });
  assert.deepEqual(await fetchUseCaseSummary(), []);
  responds.push({ status: 200, body: { unexpected: true } });
  assert.deepEqual(await fetchUseCaseSummary(), [], "非数组契约 → []");
});

/* ── ④ 视图接线(源码断言) ── */

test("AppMarketView 策展层接线:chips/合集位/搜索提示(源码)", () => {
  const src = readFileSync(join(webRoot, "components/apps/AppMarketView.tsx"), "utf-8");
  assert.ok(src.includes("USE_CASE_GROUPS"), "chips 应走 8 场景组(2026-09-14 分类重设计)");
  assert.ok(src.includes("groupChips"), "场景组计数 memo 缺失(指纹去重=功能入口数)");
  assert.ok(src.includes("apps-mkt-chips"), "缺用途 chips 行");
  assert.ok(src.includes("useCase"), "filterApps 应接 useCase");
  assert.ok(src.includes("apps-mkt-section"), "缺合集位区块");
  assert.ok(src.includes("curatedRails.featured"), "缺精选横滚条");
  assert.ok(src.includes("curatedRails.hot"), "缺热门横滚条");
  assert.ok(src.includes("MiniAppCard"), "合集位应走紧凑小卡");
  assert.ok(src.includes("找到"), "缺搜索结果计数提示");
  assert.ok(
    src.includes('cat === "" && !searching && heroCats.length > 0'),
    "一级分类入口卡仅在市场首页显示",
  );
  assert.ok(src.includes("catPage &&"), "二级功能页应挂 catPage");
});

test("apps.css 含 apps-mkt- 段(chips/合集位/小卡)", () => {
  const css = readFileSync(join(webRoot, "app/styles/apps.css"), "utf-8");
  for (const cls of [
    ".apps-mkt-chips",
    ".apps-mkt-chip",
    ".apps-mkt-chip.is-on",
    ".apps-mkt-section",
    ".apps-mkt-rail",
    ".apps-mkt-mini",
    ".apps-mkt-search-hint",
    ".apps-mkt-blurb",
  ]) {
    assert.ok(css.includes(cls), `apps.css 缺 ${cls}`);
  }
});

/* ── ④ 场景组(2026-09-14 分类重设计:12 枚举 → 8 场景组,展示层映射) ── */

test("USE_CASE_GROUPS:8 组全覆盖 12 枚举,blurb 非空,id 唯一", () => {
  assert.equal(USE_CASE_GROUPS.length, 8);
  const ids = new Set(USE_CASE_GROUPS.map((g) => g.id));
  assert.equal(ids.size, 8, "组 id 不得重复");
  const covered = new Set(USE_CASE_GROUPS.flatMap((g) => g.useCases as readonly string[]));
  for (const u of USE_CASES) {
    assert.ok(covered.has(u.id), `枚举 ${u.id} 未落入任何场景组`);
  }
  for (const g of USE_CASE_GROUPS) {
    assert.ok(g.blurb.length > 0, `${g.id} 缺 blurb`);
  }
});

test("useCaseGroup:id 命中组定义,未知/空返回 null", () => {
  assert.equal(useCaseGroup("portrait")?.label, "写真·人像");
  assert.deepEqual([...(useCaseGroup("tools")?.useCases ?? [])], ["other"]);
  assert.equal(useCaseGroup("zzz"), null);
  assert.equal(useCaseGroup(""), null);
});
