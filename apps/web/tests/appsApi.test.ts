/**
 * 应用市场(M3)lib/apps 单测(node:test,真实 ../lib/apps + fetch 桩):
 * ① API 契约:listApps/getApp/forkApp/runApp 的 URL / 方法 / body / auth 头
 *    (契约:GET /api/apps?category=&q= → {items};POST fork;POST run {values} → {job_id, prompt_id})
 * ② 归一:裸数组兼容、is_nsfw=1 → true、params_schema default 缺省补 null
 * ③ 纯函数:buildRunValues 提交载荷归一 / requiredParamLabel 必填缺口 /
 *    filterApps 搜索+分类+NSFW 门控 / splitAppSections 三区划分
 * token 经假 window.localStorage 注入(API_BASE 在模块加载期已定,不影响断言)。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  buildRunValues,
  filterApps,
  forkApp,
  getApp,
  listApps,
  normalizeApp,
  requiredParamLabel,
  runApp,
  splitAppSections,
  type AppItem,
  type AppParam,
} from "../lib/apps";

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
/** 应答队列:每次 fetch 弹出一条(缺省 200 {})。 */
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
      method: init?.method ?? "GET",
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
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
    is_public: false,
    is_mine: false,
    usage_count: 7,
    sort: 100,
    ...over,
  };
}

/* ── ① API 契约 ── */

test("listApps:GET /api/apps,空筛选不带 query,auth 头正确,解析 {items}", async () => {
  responds.push({ status: 200, body: { items: [makeApp("a1")] } });
  const items = await listApps();
  assert.equal(fetchCalls.length, 1);
  const c = fetchCalls[0];
  assert.ok(c.url.endsWith("/api/apps"), `空筛选不应带 query,实际 ${c.url}`);
  assert.equal(c.method, "GET");
  assert.equal(c.headers.Authorization, "Bearer tok-test");
  assert.equal(c.body, undefined, "GET 无 body");
  assert.equal(items.length, 1);
  assert.equal(items[0].id, "a1");
  assert.equal(items[0].usage_count, 7);
});

test("listApps:category/q 非空才上 query 且编码;all 视为不筛选", async () => {
  responds.push({ status: 200, body: { items: [] } });
  await listApps({ category: "video", q: "复古 风" });
  const c = fetchCalls[0];
  assert.ok(c.url.includes("/api/apps?"), "带 query");
  assert.ok(c.url.includes("category=video"), "category 透传");
  // URLSearchParams 形态编码(空格为 +,中文 percent-encode)
  assert.ok(
    c.url.includes(new URLSearchParams({ q: "复古 风" }).toString()),
    "q 编码透传",
  );

  fetchCalls = [];
  responds.push({ status: 200, body: { items: [] } });
  await listApps({ category: "all", q: "  " });
  assert.ok(fetchCalls[0].url.endsWith("/api/apps"), "all/空白 q 不上 query");
});

test("listApps:宽容兼容裸数组响应;is_nsfw=1 归一为 true", async () => {
  responds.push({ status: 200, body: [makeApp("a2", { is_nsfw: 1, usage_count: "12" })] });
  const items = await listApps();
  assert.equal(items.length, 1);
  assert.equal(items[0].is_nsfw, true, "is_nsfw=1 归一为布尔");
  assert.equal(items[0].usage_count, 12, "usage_count 字符串归一为数字");
});

test("getApp:GET /api/apps/{id},id 编码;params_schema default 缺省补 null", async () => {
  responds.push({
    status: 200,
    body: makeApp("a 1", {
      params_schema: [
        { key: "prompt", label: "提示词", type: "textarea" },
        { key: "steps", label: "步数", type: "number", default: 20, min: 1, max: 50 },
      ],
    }),
  });
  const app = await getApp("a 1");
  assert.ok(fetchCalls[0].url.includes("/api/apps/a%201"), "id 已编码");
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(app.params_schema.length, 2);
  assert.equal(app.params_schema[0].default, null, "default 缺省补 null(必填语义)");
  assert.equal(app.params_schema[1].default, 20);
  assert.equal(app.params_schema[1].max, 50);
});

test("forkApp:POST /api/apps/{id}/fork,无 body,返回归一化副本", async () => {
  responds.push({ status: 200, body: makeApp("a1-copy", { is_mine: true }) });
  const copy = await forkApp("a1");
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/apps/a1/fork"));
  assert.equal(c.body, undefined, "fork 无 body");
  assert.equal(copy.is_mine, true);
});

test("runApp:POST /api/apps/{id}/run,body={values},返回 {job_id, prompt_id}", async () => {
  responds.push({ status: 200, body: { job_id: "j1", prompt_id: "p1" } });
  const values = { prompt: "雨夜", steps: 20 };
  const res = await runApp("a1", values);
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/apps/a1/run"));
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.deepEqual(c.body, { values }, "提交载荷契约 body={values}");
  assert.equal(res.job_id, "j1");
  assert.equal(res.prompt_id, "p1");
  assert.equal(res.client_id, "", "契约未保证的 client_id 缺省补空串");
  assert.equal(res.worker, "");
});

test("runApp:非 2xx 抛错,FastAPI detail 原样透出", async () => {
  responds.push({ status: 400, body: { detail: "参数 prompt 不能为空" } });
  await assert.rejects(runApp("a1", {}), /参数 prompt 不能为空/);
});

/* ── ② 归一 ── */

test("normalizeApp:非法 category/output_kind/type 兜底 other/image/text", () => {
  const app = normalizeApp(
    makeApp("x", {
      category: "weird",
      output_kind: "hologram",
      params_schema: [{ key: "k", label: "K", type: "magic" }],
    }),
  );
  assert.equal(app.category, "other");
  assert.equal(app.output_kind, "image");
  assert.equal(app.params_schema[0].type, "text");
});

/* ── ③ 纯函数:提交载荷 / 必填缺口 / 过滤 / 分区 ── */

const SCHEMA: AppParam[] = [
  { key: "prompt", label: "提示词", type: "textarea", default: null },
  { key: "negative", label: "负向", type: "text", default: "" },
  { key: "steps", label: "步数", type: "number", default: 20, min: 1, max: 50, step: 1 },
  { key: "cfg", label: "CFG", type: "number", default: 7 },
  { key: "fast", label: "快速档", type: "switch", default: false },
  {
    key: "ratio",
    label: "比例",
    type: "select",
    default: "1:1",
    options: [
      { value: "1:1", label: "1:1" },
      { value: "16:9", label: "16:9" },
    ],
  },
];

test("buildRunValues:number 字符串 parse、空 number 省略、switch 布尔归一、文本 String 归一", () => {
  const out = buildRunValues(SCHEMA, {
    prompt: "雨夜",
    negative: "",
    steps: "30", // ParamField 数值参数以原始字符串保存,提交时才 parse
    cfg: "  ", // 空 number → 省略(后端落 default)
    fast: 1, // 非布尔真值 → true
    ratio: "16:9",
  });
  assert.deepEqual(out, {
    prompt: "雨夜",
    negative: "",
    steps: 30,
    fast: true,
    ratio: "16:9",
  });
  assert.ok(!("cfg" in out), "空 number 不进载荷");
});

test("requiredParamLabel:default=null 且值为空 → 返回该参数 label;填齐 → null", () => {
  assert.equal(
    requiredParamLabel(SCHEMA, { prompt: "  " }),
    "提示词",
    "空白串视为未填",
  );
  assert.equal(requiredParamLabel(SCHEMA, { prompt: "雨夜" }), null);
  // switch/default 非 null 的参数永不构成缺口
  assert.equal(requiredParamLabel(SCHEMA.slice(2), { steps: "" }), null);
});

function appItem(id: string, over: Partial<AppItem> = {}): AppItem {
  return normalizeApp(makeApp(id, over));
}

test("filterApps:搜索命中名称/描述(不区分大小写),分类精确匹配", () => {
  const apps = [
    appItem("a", { name: "赛璐璐复古风", category: "image" }),
    appItem("b", { name: "口播分身", description: "口型同步", category: "video" }),
  ];
  assert.deepEqual(filterApps(apps, { q: "CYAN" }).map((a) => a.id), [], "大小写不敏感无命中");
  assert.deepEqual(filterApps(apps, { q: "复古" }).map((a) => a.id), ["a"]);
  assert.deepEqual(filterApps(apps, { q: "口型" }).map((a) => a.id), ["b"], "描述也参与搜索");
  assert.deepEqual(filterApps(apps, { category: "video" }).map((a) => a.id), ["b"]);
  assert.equal(filterApps(apps, { category: "all" }).length, 2);
});

test("filterApps:NSFW 客户端过滤——r18 off 隐藏 is_nsfw,on 放行", () => {
  const apps = [appItem("sfw"), appItem("nsfw", { is_nsfw: true })];
  assert.deepEqual(filterApps(apps, { r18: false }).map((a) => a.id), ["sfw"]);
  assert.equal(filterApps(apps, { r18: true }).length, 2);
});

test("splitAppSections:内置/公共/我的三区,is_mine 优先于 is_builtin", () => {
  const apps = [
    appItem("b1", { is_builtin: true }),
    appItem("p1", { is_public: true }),
    appItem("m1", { is_mine: true }),
    appItem("m2", { is_mine: true, is_builtin: true }), // 本人内置副本归「我的」
    appItem("hidden"), // 非公共非内置非本人:不入任何区(后端不应下发)
  ];
  const s = splitAppSections(apps);
  assert.deepEqual(s.builtin.map((a) => a.id), ["b1"]);
  assert.deepEqual(s.pub.map((a) => a.id), ["p1"]);
  assert.deepEqual(s.mine.map((a) => a.id), ["m1", "m2"]);
});
