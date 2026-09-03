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
  appUploadKind,
  buildRunValues,
  COMMUNITY_PAGE_SIZE,
  COMMUNITY_SEARCH_CAP,
  FEATURED_VIDEO_APP_IDS,
  featuredAppIdsForKind,
  filterApps,
  firstPinWorker,
  forkApp,
  getApp,
  listApps,
  mediaFilenames,
  normalizeApp,
  requiredParamLabel,
  rhFamilyChips,
  rhFamilyOf,
  runApp,
  sliceCommunityApps,
  sortFeaturedApps,
  splitAppSections,
  type AppItem,
  type AppParam,
} from "../lib/apps";
import { CACHE_KEYS, invalidatePrefix } from "../lib/swr-cache";

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
  // listApps 走 swr 缓存(2026-09-01 L1):用例间须失效,防上一用例缓存污染断言
  invalidatePrefix(CACHE_KEYS.apps);
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

test("buildRunValues:images 文件名数组原样透传,不 String 化", () => {
  const schema: AppParam[] = [
    ...SCHEMA,
    { key: "images", label: "参考图", type: "images", default: null, max: 9 },
  ];
  const out = buildRunValues(schema, {
    prompt: "x",
    images: ["a.png", "b.png"],
  });
  assert.deepEqual(out.images, ["a.png", "b.png"]);
  assert.equal(Array.isArray(out.images), true);
});

test("buildRunValues:images 句柄对象抽 filename,不把复合对象塞进载荷", () => {
  const schema: AppParam[] = [
    { key: "images", label: "参考图", type: "images", default: null, max: 9 },
    { key: "last_frame", label: "尾帧图", type: "images", default: null, max: 1 },
    { key: "video", label: "参考视频", type: "video", default: null, max: 3, required: false },
  ];
  const out = buildRunValues(schema, {
    images: [
      { filename: "a.png", worker: "http://w", previewUrl: "blob:1", name: "a.png" },
      { filename: "b.png", worker: "http://w", previewUrl: "blob:2", name: "b.png" },
    ],
    last_frame: [{ filename: "tail.png", worker: "http://w", name: "tail.png" }],
    video: [],
  });
  assert.deepEqual(out.images, ["a.png", "b.png"]);
  assert.deepEqual(out.last_frame, ["tail.png"]);
  assert.deepEqual(out.video, []);
});

test("normalizeApp:images/audio/video 类型保留,不再兜底成 text", () => {
  const app = normalizeApp(
    makeApp("h3-r2v", {
      params_schema: [
        { key: "images", label: "参考图", type: "images", max: 9, required: true },
        { key: "video", label: "参考视频", type: "video", max: 3, required: false },
        { key: "audio", label: "参考音频", type: "audio", max: 3, required: false },
        { key: "last_frame", label: "尾帧图", type: "images", max: 1 },
      ],
    }),
  );
  assert.equal(app.params_schema[0].type, "images");
  assert.equal(app.params_schema[0].max, 9);
  assert.equal(app.params_schema[0].required, true);
  assert.equal(app.params_schema[1].type, "video");
  assert.equal(app.params_schema[1].required, false);
  assert.equal(app.params_schema[2].type, "audio");
  assert.equal(app.params_schema[3].type, "images");
  assert.equal(app.params_schema[3].max, 1);
});

test("requiredParamLabel:必填 images 空数组卡住;可选 video 空不卡", () => {
  const schema: AppParam[] = [
    { key: "images", label: "参考图", type: "images", default: null, max: 9, required: true },
    { key: "video", label: "参考视频", type: "video", default: null, max: 3, required: false },
  ];
  assert.equal(requiredParamLabel(schema, { images: [], video: [] }), "参考图");
  assert.equal(
    requiredParamLabel(schema, { images: [{ filename: "a.png" }], video: [] }),
    null,
  );
});

test("mediaFilenames / appUploadKind / firstPinWorker 辅助", () => {
  assert.deepEqual(mediaFilenames([" a.png ", { filename: "b.png" }, ""]), ["a.png", "b.png"]);
  assert.equal(appUploadKind("h3-r2v"), "h3_i2v");
  assert.equal(appUploadKind("h3-fl2v"), "h3_i2v");
  assert.equal(appUploadKind("img2img-basic"), "img2img");
  assert.equal(appUploadKind("wan-animate"), "wan_animate");
  assert.equal(
    firstPinWorker({ images: [{ filename: "a.png", worker: "http://w:8189" }] }),
    "http://w:8189",
  );
  assert.equal(firstPinWorker({ images: [] }), null);
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
  assert.deepEqual(s.community.map((a) => a.id), []);
});

test("splitAppSections:rh-* 进社区,核心 H3 仍在内置", () => {
  const apps = [
    appItem("h3-t2v", { is_builtin: true }),
    appItem("h3-i2v", { is_builtin: true }),
    appItem("rh-scene-1", { is_builtin: true, description: "场景预设 · 作者A · 填写提示词即可" }),
    appItem("rh-i2v-2", { is_builtin: true, description: "图生视频 · 作者B · 上传首帧图" }),
    appItem("p1", { is_public: true }),
    appItem("rh-mine", { is_mine: true, is_builtin: true }),
  ];
  const s = splitAppSections(apps);
  assert.deepEqual(s.builtin.map((a) => a.id), ["h3-t2v", "h3-i2v"]);
  assert.deepEqual(s.community.map((a) => a.id), ["rh-scene-1", "rh-i2v-2"]);
  assert.deepEqual(s.mine.map((a) => a.id), ["rh-mine"]);
  assert.deepEqual(s.pub.map((a) => a.id), ["p1"]);
});

test("rhFamilyOf/rhFamilyChips:取 description 第一个「 · 」前缀,正典序", () => {
  const apps = [
    appItem("rh-1", { description: "图生视频 · 作者 · 上传首帧图" }),
    appItem("rh-2", { description: "场景预设 · 作者 · 填写提示词即可" }),
    appItem("rh-3", { description: "图生视频 · 另一作者 · 上传首帧图" }),
    appItem("rh-4", { description: "未知门类 · 作者" }),
  ];
  assert.equal(rhFamilyOf(apps[0]), "图生视频");
  assert.deepEqual(rhFamilyChips(apps), ["场景预设", "图生视频", "未知门类"]);
});

test("sliceCommunityApps:空查询先 24 张+hasMore;搜索/family 上限 120", () => {
  const many = Array.from({ length: 50 }, (_, i) =>
    appItem(`rh-${i}`, { is_builtin: true, description: `${i < 30 ? "文生视频" : "图生视频"} · a · x` }),
  );
  const idle = sliceCommunityApps(many, { q: "", shown: COMMUNITY_PAGE_SIZE });
  assert.equal(idle.items.length, 24);
  assert.equal(idle.hasMore, true);
  assert.equal(idle.truncated, false);
  const more = sliceCommunityApps(many, { q: "", shown: 48 });
  assert.equal(more.items.length, 48);
  assert.equal(more.hasMore, true);
  const fam = sliceCommunityApps(many, { q: "", family: "文生视频", shown: 24 });
  assert.equal(fam.items.length, 30);
  assert.equal(fam.hasMore, false);
  const huge = Array.from({ length: 130 }, (_, i) => appItem(`rh-x-${i}`, { description: "场景预设 · a" }));
  const capped = sliceCommunityApps(huge, { q: "场景", shown: 24 });
  assert.equal(capped.items.length, COMMUNITY_SEARCH_CAP);
  assert.equal(capped.truncated, true);
  assert.equal(capped.hasMore, false);
});

test("filterApps:outputKind 按产物类型收窄(编辑类视频仍入视频页)", () => {
  const apps = [
    appItem("v", { output_kind: "video", category: "video" }),
    appItem("i", { output_kind: "image", category: "image" }),
    appItem("e", { output_kind: "video", category: "edit" }),
  ];
  assert.deepEqual(filterApps(apps, { outputKind: "video" }).map((a) => a.id), ["v", "e"]);
  assert.deepEqual(filterApps(apps, { outputKind: "image" }).map((a) => a.id), ["i"]);
  assert.equal(filterApps(apps, { outputKind: "all" }).length, 3);
});

test("filterApps:outputKind + NSFW 同时生效(r18 off 仍藏 is_nsfw)", () => {
  const apps = [
    appItem("h3-t2v", { output_kind: "video" }),
    appItem("h3-nsfw-t2v", { output_kind: "video", is_nsfw: true }),
  ];
  assert.deepEqual(filterApps(apps, { outputKind: "video", r18: false }).map((a) => a.id), ["h3-t2v"]);
  assert.deepEqual(filterApps(apps, { outputKind: "video", r18: true }).map((a) => a.id), ["h3-t2v", "h3-nsfw-t2v"]);
});

test("FEATURED_VIDEO_APP_IDS:核心模式先于 15s/声音,NSFW 孪生同序", () => {
  assert.ok(FEATURED_VIDEO_APP_IDS.every((id) => !id.startsWith("rh-")), "精选不得含 rh-* 社区卡");
  assert.deepEqual([...FEATURED_VIDEO_APP_IDS], [
    "h3-t2v",
    "h3-i2v",
    "h3-fl2v",
    "h3-r2v",
    "h3-t2v-15s-fast",
    "h3-i2v-15s-fast",
    "h3-r2v-voice",
    "h3-nsfw-t2v",
    "h3-nsfw-i2v",
    "h3-nsfw-fl2v",
    "h3-nsfw-r2v",
    "h3-nsfw-t2v-15s-fast",
    "h3-nsfw-i2v-15s-fast",
    "h3-nsfw-r2v-voice",
  ]);
});

test("sortFeaturedApps:H3 四件套(+ NSFW 孪生)置顶,其余保序", () => {
  const apps = [
    appItem("other-video", { sort: 1 }),
    appItem("h3-i2v", { sort: 20 }),
    appItem("h3-t2v", { sort: 10 }),
    appItem("h3-nsfw-t2v", { is_nsfw: true, sort: 26 }),
    appItem("h3-fl2v", { sort: 21 }),
    appItem("h3-r2v-voice", { sort: 5 }),
    appItem("h3-t2v-15s-fast", { sort: 6 }),
  ];
  assert.deepEqual(
    sortFeaturedApps(apps, FEATURED_VIDEO_APP_IDS).map((a) => a.id),
    ["h3-t2v", "h3-i2v", "h3-fl2v", "h3-t2v-15s-fast", "h3-r2v-voice", "h3-nsfw-t2v", "other-video"],
  );
  assert.deepEqual(
    sortFeaturedApps(apps).map((a) => a.id),
    apps.map((a) => a.id),
    "无 featuredIds 应原样返回",
  );
});

test("featuredAppIdsForKind:仅视频有 H3 精选", () => {
  assert.equal(featuredAppIdsForKind("video"), FEATURED_VIDEO_APP_IDS);
  assert.equal(featuredAppIdsForKind("image"), undefined);
  assert.equal(featuredAppIdsForKind("audio"), undefined);
});
