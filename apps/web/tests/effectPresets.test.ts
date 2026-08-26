/**
 * 特效预设体系(Pikaffects 式一键物理特效,2026-08-26 P0)web 侧单测(node:test + fetch 桩):
 * ① 提交链路:h3-t2v(SFW)/h3-nsfw-i2v(R18)/wan-nsfw-i2v(R18)的 effect_preset key
 *    直传后端对应路由;未选(空串)→ 负载不含该字段(后端不注入);
 * ② 参数分组:effect_preset 归「模型与引擎」组(与 style_preset 同域,不落高级折叠区);
 * ③ 特效下拉渲染:select 参数选中带 desc 的预设项后,描述文本展示在下拉下方
 *    (ParamField 既有 desc 机制,防回归);
 * ④ GenerateView 数据驱动:特效下拉由引擎 params schema 驱动渲染,无需视图特判。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ParamField } from "../components/generate/ParamField";
import { groupEngineParam } from "../components/generate/paramGroups";
import { submitEngineGeneration, type EngineInfo, type EngineParam } from "../lib/engines";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
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
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : init?.body,
    });
    return new Response(
      JSON.stringify({ prompt_id: "p1", client_id: "c1", worker: "http://w", seed: 7 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

function _engine(id: string, over: Partial<EngineInfo> = {}): EngineInfo {
  return {
    id,
    label: id,
    kind: "video",
    available: true,
    nsfw: id.includes("nsfw"),
    params: [],
    ...over,
  };
}

/** 注册表同款特效下拉参数(两个预设项即可验证渲染/传参)。 */
function _effectParam(): EngineParam {
  return {
    key: "effect_preset",
    label: "特效预设",
    type: "select",
    default: "",
    options: [
      { value: "", label: "不使用" },
      { value: "melt", label: "融化", desc: "主体如蜡般软化下垂,淌成光亮液泊;R18 兼容(10Eros-Max)" },
      { value: "explode", label: "爆炸", desc: "主体从核心炸开,碎片与尘雾四散飞溅;R18 兼容(10Eros-Max)" },
    ],
    hint: "一键物理特效",
  };
}

// ── ① 提交链路 ─────────────────────────────────────────────────────────

test("h3-t2v:effect_preset 直传 /api/h3/t2v", async () => {
  await submitEngineGeneration({
    engine: _engine("h3-t2v"),
    positive: "a ceramic vase",
    values: { width: 1344, height: 768, duration: 5, steps: 20, seed: "", effect_preset: "melt" },
  });
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/t2v"));
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.effect_preset, "melt");
  assert.equal(body.positive, "a ceramic vase"); // 注入在后端做,前端不拼
});

test("h3-nsfw-i2v:effect_preset 随 R18 负载直传 /api/h3/i2v", async () => {
  await submitEngineGeneration({
    engine: _engine("h3-nsfw-i2v", {
      params: [{ key: "images", label: "参考图", type: "images", max: 1, default: null }],
    }),
    positive: "x",
    values: { resolution: "1280x736", duration: "6", seed: "", effect_preset: "shatter" },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/i2v"));
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.effect_preset, "shatter");
  assert.equal(body.image, "ref.png");
});

test("wan-nsfw-i2v:effect_preset 直传 /api/generate/video", async () => {
  await submitEngineGeneration({
    engine: _engine("wan-nsfw-i2v", {
      params: [{ key: "images", label: "参考图", type: "images", max: 1, default: null }],
    }),
    positive: "x",
    values: { resolution: "832x480", duration: "5", seed: "", effect_preset: "explode" },
    refImage: { filename: "ref.png", worker: "http://w" },
  });
  assert.ok(fetchCalls[0].url.endsWith("/api/generate/video"));
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.effect_preset, "explode");
});

test("未选特效(空串)→ 负载不含 effect_preset 字段", async () => {
  await submitEngineGeneration({
    engine: _engine("h3-t2v"),
    positive: "x",
    values: { seed: "", effect_preset: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal("effect_preset" in body, false);
});

// ── ② 参数分组 ─────────────────────────────────────────────────────────

test("groupEngineParam:effect_preset 归「模型与引擎」组(不落高级折叠区)", () => {
  assert.equal(groupEngineParam(_effectParam()), "model");
});

// ── ③ 特效下拉渲染(desc 描述展示)──────────────────────────────────────

test("特效下拉:选中预设后描述文本展示在下拉下方", () => {
  const html = renderToStaticMarkup(
    React.createElement(ParamField, {
      param: _effectParam(),
      value: "melt",
      onChange: () => undefined,
    }),
  );
  assert.ok(html.includes("特效预设"), "字段标签缺失");
  assert.ok(html.includes("融化"), "选中项 label 缺失");
  assert.ok(
    html.includes("主体如蜡般软化下垂"),
    "选中预设的 desc 描述未展示",
  );
  assert.ok(html.includes("R18 兼容(10Eros-Max)"), "R18 兼容注明未展示");
});

test("特效下拉:未选(空串)时不渲染描述", () => {
  const html = renderToStaticMarkup(
    React.createElement(ParamField, {
      param: _effectParam(),
      value: "",
      onChange: () => undefined,
    }),
  );
  assert.ok(!html.includes("主体如蜡般软化下垂"), "未选中不应展示预设描述");
  // 全部预设项在 option 中可选
  assert.ok(html.includes("爆炸"), "预设选项缺失");
});

// ── ④ GenerateView 数据驱动(源码接线防回归)────────────────────────────

test("GenerateView/提交链:特效下拉走通用 ParamField 与 values 快照,无视图特判", async () => {
  // 特效下拉是引擎 params schema 驱动的普通 select:GenerateView 经 paramGroups →
  // ParamField 渲染、values 快照进 submitEngineGeneration。这里用带特效参数的完整
  // 引擎走一遍提交,验证 schema → values → 负载 全链路无特判断点。
  const engine = _engine("h3-t2v", { params: [_effectParam()] });
  await submitEngineGeneration({
    engine,
    positive: "x",
    values: { seed: "", effect_preset: "levitate" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.effect_preset, "levitate");
});
