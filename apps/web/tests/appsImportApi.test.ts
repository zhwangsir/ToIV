/**
 * 应用市场 M5 智能导入单测(node:test,真实 ../lib/apps + fetch 桩,同 appsApi.test.ts 范式):
 * ① importWorkflow 契约:POST /api/apps/import,body={workflow},JSON/auth 头,草稿归一
 * ② importWorkflow 错误分支:503「AI 包装服务暂不可用」/429 限流(detail 优先透出,fallback 兜底)
 * ③ confirmImport 契约:body={draft_id, overrides?}(无 overrides 不上送该键),
 *    返回归一化 AppItem;404 草稿过期 detail 透出
 * ④ 纯函数:normalizeImportDraft 兜底 / buildImportOverrides 差异收集
 * token 经假 window.localStorage 注入(API_BASE 在模块加载期已定,不影响断言)。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  buildImportOverrides,
  confirmImport,
  importWorkflow,
  normalizeImportDraft,
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

function makeDraft(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    draft_id: "draft-1",
    name: "复古海报",
    description: "一键生成复古海报",
    icon: "sparkles",
    category: "image",
    output_kind: "image",
    params_schema: [{ key: "prompt", label: "提示词", type: "textarea" }],
    bindings: { "3": { prompt: "inputs.text" } },
    warnings: ["节点 7 的采样器未识别,已按默认处理"],
    ...over,
  };
}

/* ── ① importWorkflow 契约 ── */

test("importWorkflow:POST /api/apps/import,body={workflow},JSON/auth 头,草稿归一", async () => {
  responds.push({ status: 200, body: makeDraft() });
  const workflow = { "1": { class_type: "CheckpointLoaderSimple", inputs: {} } };
  const d = await importWorkflow(workflow);
  assert.equal(fetchCalls.length, 1);
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/apps/import"), `实际 ${c.url}`);
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.equal(c.headers.Authorization, "Bearer tok-test");
  assert.deepEqual(c.body, { workflow }, "提交载荷契约 body={workflow}");
  assert.equal(d.draft_id, "draft-1");
  assert.equal(d.name, "复古海报");
  assert.equal(d.category, "image");
  assert.equal(d.output_kind, "image");
  assert.equal(d.params_schema[0].default, null, "params default 缺省补 null(必填语义)");
  assert.deepEqual(d.warnings, ["节点 7 的采样器未识别,已按默认处理"]);
  assert.deepEqual(d.bindings, { "3": { prompt: "inputs.text" } });
});

/* ── ② importWorkflow 错误分支 ── */

test("importWorkflow:503 无 detail → 「AI 包装服务暂不可用」兜底文案", async () => {
  responds.push({ status: 503, body: {} });
  await assert.rejects(importWorkflow({}), /AI 包装服务暂不可用/);
});

test("importWorkflow:503 有 detail → 后端 detail 优先透出", async () => {
  responds.push({ status: 503, body: { detail: "LLM 网关连接超时" } });
  await assert.rejects(importWorkflow({}), /LLM 网关连接超时/);
});

test("importWorkflow:429 无 detail → 限流文案(每分钟限 5 次)", async () => {
  responds.push({ status: 429, body: {} });
  await assert.rejects(importWorkflow({}), /每分钟限 5 次/);
});

test("importWorkflow:400 走通用错误归一,FastAPI detail 透出", async () => {
  responds.push({ status: 400, body: { detail: "工作流不是有效的 ComfyUI 格式" } });
  await assert.rejects(importWorkflow({}), /工作流不是有效的 ComfyUI 格式/);
});

/* ── ③ confirmImport 契约 ── */

test("confirmImport:POST /api/apps/import/confirm,body={draft_id, overrides},返回归一化 AppItem", async () => {
  responds.push({
    status: 200,
    body: {
      id: "app-9",
      name: "我的复古海报",
      description: "一键生成复古海报",
      icon: "sparkles",
      category: "image",
      params_schema: [],
      output_kind: "image",
      is_builtin: false,
      is_nsfw: 0,
      is_public: false,
      is_mine: 1,
      usage_count: 0,
      sort: 100,
    },
  });
  const app = await confirmImport("draft-1", { name: "我的复古海报" });
  const c = fetchCalls[0];
  assert.equal(c.method, "POST");
  assert.ok(c.url.endsWith("/api/apps/import/confirm"), `实际 ${c.url}`);
  assert.equal(c.headers["Content-Type"], "application/json");
  assert.equal(c.headers.Authorization, "Bearer tok-test");
  assert.deepEqual(c.body, { draft_id: "draft-1", overrides: { name: "我的复古海报" } });
  assert.equal(app.id, "app-9");
  assert.equal(app.is_mine, true, "is_mine=1 归一为布尔");
});

test("confirmImport:无 overrides 时 body 仅 {draft_id}(契约 overrides 可选)", async () => {
  responds.push({ status: 200, body: { id: "app-9" } });
  await confirmImport("draft-2");
  assert.deepEqual(fetchCalls[0].body, { draft_id: "draft-2" });
  // 空对象 overrides 同样不上送
  responds.push({ status: 200, body: { id: "app-9" } });
  await confirmImport("draft-2", {});
  assert.deepEqual(fetchCalls[1].body, { draft_id: "draft-2" });
});

test("confirmImport:404 草稿过期 → detail 透出", async () => {
  responds.push({ status: 404, body: { detail: "草稿已过期或不存在" } });
  await assert.rejects(confirmImport("draft-x"), /草稿已过期或不存在/);
});

/* ── ④ 纯函数 ── */

test("buildImportOverrides:仅收集与草稿不同的键;无差异 → undefined;空白串视为未改", () => {
  const draft = normalizeImportDraft(makeDraft());
  assert.deepEqual(
    buildImportOverrides(draft, { name: "新名", description: "一键生成复古海报", icon: "  " }),
    { name: "新名" },
    "同名 description 与空白 icon 不上送",
  );
  assert.equal(
    buildImportOverrides(draft, {
      name: "复古海报",
      description: "一键生成复古海报",
      icon: "sparkles",
    }),
    undefined,
    "全无差异 → undefined(confirm 不带 overrides 键)",
  );
  assert.deepEqual(
    buildImportOverrides(draft, { category: "video" }),
    { category: "video" },
    "category 差异也收集(契约允许)",
  );
});

test("normalizeImportDraft:warnings 过滤非字符串/空串,bindings 数组兜底 {},非法 category/output_kind 兜底", () => {
  const d = normalizeImportDraft(
    makeDraft({
      category: "weird",
      output_kind: "hologram",
      icon: undefined,
      bindings: ["not-an-object"],
      warnings: ["有效告警", "", 42, null, "  "],
    }),
  );
  assert.equal(d.category, "other");
  assert.equal(d.output_kind, "image");
  assert.equal(d.icon, "package", "icon 缺省兜底 package");
  assert.deepEqual(d.bindings, {}, "bindings 非对象兜底 {}");
  assert.deepEqual(d.warnings, ["有效告警"], "warnings 只收非空字符串");
});
