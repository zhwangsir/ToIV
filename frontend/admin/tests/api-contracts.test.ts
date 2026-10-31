/** 关键封装 URL/方法契约:fetch 替身断言,不发真实请求。 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  fetchAdminJobs,
  fetchKnowledgeGraph,
  generateGuidesBatch,
  uploadAppCover,
} from "../lib/api";

type FetchCall = { url: string; init: RequestInit };

/** 打桩 globalThis.fetch,返回捕获列表与恢复函数。 */
function stubFetch(jsonBody: unknown = {}): { calls: FetchCall[]; restore: () => void } {
  const calls: FetchCall[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    return {
      ok: true,
      status: 200,
      json: async () => jsonBody,
    } as Response;
  }) as typeof fetch;
  return { calls, restore: () => void (globalThis.fetch = original) };
}

test("fetchAdminJobs 带 all=1 与 status/kind/limit/offset 查询串", async () => {
  const { calls, restore } = stubFetch([]);
  try {
    await fetchAdminJobs({ status: "error", kind: "app.smoke", limit: 20, offset: 40 });
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.pathname, "/api/jobs");
  assert.equal(url.searchParams.get("all"), "1");
  assert.equal(url.searchParams.get("status"), "error");
  assert.equal(url.searchParams.get("kind"), "app.smoke");
  assert.equal(url.searchParams.get("limit"), "20");
  assert.equal(url.searchParams.get("offset"), "40");
});

test("fetchAdminJobs 缺省 status/kind 不进查询串", async () => {
  const { calls, restore } = stubFetch([]);
  try {
    await fetchAdminJobs();
  } finally {
    restore();
  }
  const url = new URL(calls[0].url);
  assert.equal(url.searchParams.get("all"), "1");
  assert.equal(url.searchParams.get("limit"), "100");
  assert.equal(url.searchParams.has("status"), false);
  assert.equal(url.searchParams.has("kind"), false);
});

test("generateGuidesBatch POST 体默认值与自定义值", async () => {
  const { calls, restore } = stubFetch({ started: true, planned: 50 });
  try {
    await generateGuidesBatch();
    await generateGuidesBatch({ limit: 10, only_missing: false });
  } finally {
    restore();
  }
  assert.equal(calls.length, 2);
  for (const c of calls) {
    const url = new URL(c.url);
    assert.equal(url.pathname, "/api/admin/app-guides/generate");
    assert.equal(c.init.method, "POST");
    const headers = c.init.headers as Record<string, string>;
    assert.equal(headers["Content-Type"], "application/json");
  }
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), { limit: 50, only_missing: true });
  assert.deepEqual(JSON.parse(String(calls[1].init.body)), { limit: 10, only_missing: false });
});

test("fetchKnowledgeGraph 查询串:entity 必带,depth=1 省略、非 1 透出", async () => {
  const { calls, restore } = stubFetch({ nodes: [], edges: [] });
  try {
    await fetchKnowledgeGraph({ entity: "rh-123" });
    await fetchKnowledgeGraph({ entity: "rh-123", depth: 3 });
  } finally {
    restore();
  }
  const u1 = new URL(calls[0].url);
  assert.equal(u1.pathname, "/api/admin/knowledge-graph");
  assert.equal(u1.searchParams.get("entity"), "rh-123");
  assert.equal(u1.searchParams.has("depth"), false);
  const u2 = new URL(calls[1].url);
  assert.equal(u2.searchParams.get("depth"), "3");
});

test("uploadAppCover 用 FormData 且不设 Content-Type(边界由浏览器/undici 生成)", async () => {
  const { calls, restore } = stubFetch({ id: "app-x" });
  try {
    const file = new File([new Uint8Array([1, 2, 3])], "cover.png", { type: "image/png" });
    await uploadAppCover("app-x", file);
  } finally {
    restore();
  }
  assert.equal(calls.length, 1);
  const c = calls[0];
  const url = new URL(c.url);
  assert.equal(url.pathname, "/api/apps/app-x/cover");
  assert.equal(c.init.method, "POST");
  assert.ok(c.init.body instanceof FormData, "body 须为 FormData");
  const headers = (c.init.headers ?? {}) as Record<string, string>;
  const ctKeys = Object.keys(headers).filter((k) => k.toLowerCase() === "content-type");
  assert.deepEqual(ctKeys, [], "禁止显式 Content-Type 头");
});
