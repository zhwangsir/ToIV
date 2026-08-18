/**
 * optimizeWithAgent payload 透传(node:test + fetch 桩):
 * engine/loras(视频引擎方言 + Wan NSFW 触发词注入的前端入参)必须原样进 /api/optimize body;
 * 缺省不出现(向后兼容,旧调用方 payload 不变)。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";

import { optimizeWithAgent } from "../lib/agents";

let fetchCalls: { url: string; body: Record<string, unknown> }[] = [];
const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
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
      body: typeof init?.body === "string" ? JSON.parse(init.body) : {},
    });
    return new Response(JSON.stringify({ optimized: "out", negative: null }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("engine/loras 透传进 /api/optimize body", async () => {
  await optimizeWithAgent({
    prompt: "跪姿",
    kind: "video",
    engine: "wan-nsfw-i2v",
    loras: ["NSFW-22-H-e8.safetensors"],
  });
  const body = fetchCalls[0].body;
  assert.ok(fetchCalls[0].url.endsWith("/api/optimize"));
  assert.equal(body.engine, "wan-nsfw-i2v");
  assert.deepEqual(body.loras, ["NSFW-22-H-e8.safetensors"]);
});

test("缺省 engine/loras 不出现在 body(向后兼容)", async () => {
  await optimizeWithAgent({ prompt: "湖", kind: "video" });
  const body = fetchCalls[0].body;
  assert.equal("engine" in body, false);
  assert.equal("loras" in body, false);
});

test("空 loras 数组不透传(避免后端误解析为空选择语义)", async () => {
  await optimizeWithAgent({ prompt: "湖", kind: "video", engine: "h3-t2v", loras: [] });
  const body = fetchCalls[0].body;
  assert.equal(body.engine, "h3-t2v");
  assert.equal("loras" in body, false);
});

// ── 三层联动(2026-08-18):风格预设 id 透传 ─────────────────────────────

test("stylePreset 透传为 style 字段(预设→优化联动)", async () => {
  await optimizeWithAgent({ prompt: "雨夜城市", kind: "image", stylePreset: "cinematic" });
  const body = fetchCalls[0].body;
  assert.equal(body.style, "cinematic");
});

test("缺省 stylePreset 不出现在 body(向后兼容,无预设调用方 payload 不变)", async () => {
  await optimizeWithAgent({ prompt: "湖", kind: "image" });
  assert.equal("style" in fetchCalls[0].body, false);
});
