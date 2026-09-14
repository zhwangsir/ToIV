/**
 * H3 智能加速(2026-09-12)前端单测(node:test):
 * ① lib/h3Accel:档位常量/参考值兜底/选项 label 带倍率与实测|参考注明/接口失败回落
 * ② lib/apps.appSupportsH3Accel:id 前缀 h3- 或图含 MiniMaxH3/HailuoH3 家族
 * ③ runApp 契约:acceleration 非 off 才进 body;off/缺省不带字段;回显解析
 * ④ lib/engines.submitEngineGeneration:H3 引擎负载带 acceleration,其余引擎不带
 * ⑤ 视图接线(源检查):AppRunnerView/EngineStudioView 渲染 H3AccelSelect 并传入 accel
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, beforeEach, test } from "node:test";

import {
  H3_ACCEL_LEVELS,
  H3_ACCEL_REFERENCE,
  fetchH3AccelProfiles,
  h3AccelOptions,
  isH3EngineId,
} from "../lib/h3Accel";
import { appSupportsH3Accel, runApp } from "../lib/apps";
import { submitEngineGeneration } from "../lib/engines";
import { CACHE_KEYS, invalidate } from "../lib/swr-cache";

interface FetchCall {
  url: string;
  method: string;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let responds: { status: number; body: unknown }[] = [];

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
  responds = [];
  invalidate(CACHE_KEYS.h3Accel);
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
    const next = responds.shift() ?? { status: 200, body: {} };
    return new Response(JSON.stringify(next.body), {
      status: next.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
});

after(() => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

// ---------- ① lib/h3Accel 纯函数 ----------

test("H3_ACCEL_LEVELS 含四档且 off 打头", () => {
  assert.deepEqual([...H3_ACCEL_LEVELS], ["off", "lossless", "balanced", "extreme"]);
});

test("h3AccelOptions:label 带倍率与实测/参考注明", () => {
  const opts = h3AccelOptions([...H3_ACCEL_REFERENCE]);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  assert.equal(by.off.label, "关闭 · 原速");
  assert.match(by.lossless.label, /无损加速 · ~1\.4x\(参考\)/);
  assert.match(by.balanced.label, /甜点位 · ~2x\(参考\)/);
  assert.match(by.extreme.label, /极限加速 · ~3\.2x\(参考\)/);
  // 实测来源注明「实测」
  const measured = h3AccelOptions([
    { level: "balanced", label: "甜点位", speedup: 2.6, source: "measured", recommended: true },
  ]);
  assert.match(measured[0].label, /~2\.6x\(实测\)/);
});

test("h3AccelOptions:recommended=false 档位置灰「暂不可用」", () => {
  const opts = h3AccelOptions([
    { level: "off", label: "关闭", speedup: null, source: "reference", recommended: true },
    { level: "lossless", label: "近似无损加速", speedup: 1.32, source: "measured", recommended: false },
    { level: "balanced", label: "甜点位", speedup: 2.94, source: "measured", recommended: true },
  ]);
  const by = Object.fromEntries(opts.map((o) => [o.value, o]));
  assert.equal(by.lossless.unavailable, true, "下架档位标记 unavailable");
  assert.match(by.lossless.label, /暂不可用/);
  assert.match(by.lossless.hint, /按原生参数执行/);
  assert.equal(by.balanced.unavailable, undefined, "推荐档不受影响");
  assert.equal(by.off.unavailable, undefined, "off 档不受影响");
  // 归一:字段缺失时默认 recommended=true(不置灰)
  const legacy = h3AccelOptions([
    { level: "extreme", label: "极速", speedup: 3.1, source: "measured" } as never,
  ]);
  assert.equal(legacy[0].unavailable, undefined);
});

test("fetchH3AccelProfiles:走 /api/h3/acceleration/profiles 并归一", async () => {
  responds.push({
    status: 200,
    body: {
      default: "off",
      levels: [
        { level: "off", label: "关闭", speedup: null, source: "reference" },
        { level: "lossless", label: "无损加速", speedup: 1.5, source: "measured" },
        { level: "balanced", label: "甜点位", speedup: 2.3, source: "measured" },
        { level: "extreme", label: "极限加速", speedup: 3.1, source: "measured" },
      ],
    },
  });
  const profiles = await fetchH3AccelProfiles();
  assert.equal(fetchCalls[0].url.includes("/api/h3/acceleration/profiles"), true);
  const balanced = profiles.find((p) => p.level === "balanced");
  assert.equal(balanced?.speedup, 2.3);
  assert.equal(balanced?.source, "measured");
});

test("fetchH3AccelProfiles:接口失败回落社区参考值(不抛)", async () => {
  responds.push({ status: 502, body: {} });
  const profiles = await fetchH3AccelProfiles();
  assert.deepEqual(profiles, [...H3_ACCEL_REFERENCE]);
});

test("fetchH3AccelProfiles:档位缺一口径不整 → 全量参考值", async () => {
  responds.push({
    status: 200,
    body: { levels: [{ level: "balanced", label: "甜点位", speedup: 2.3, source: "measured" }] },
  });
  const profiles = await fetchH3AccelProfiles();
  assert.deepEqual(profiles, [...H3_ACCEL_REFERENCE]);
});

test("isH3EngineId:仅 h3- 前缀", () => {
  assert.equal(isH3EngineId("h3-t2v"), true);
  assert.equal(isH3EngineId("h3-nsfw-r2v"), true);
  assert.equal(isH3EngineId("longcat-t2v"), false);
  assert.equal(isH3EngineId("txt2img"), false);
});

// ---------- ② appSupportsH3Accel ----------

test("appSupportsH3Accel:id 前缀或图含 H3 家族节点", () => {
  assert.equal(appSupportsH3Accel({ id: "h3-foo", workflow_json: null }), true);
  assert.equal(
    appSupportsH3Accel({
      id: "rh-acc-1",
      workflow_json: { "104": { class_type: "MiniMaxH3ImageToVideo" } },
    }),
    true,
  );
  assert.equal(
    appSupportsH3Accel({
      id: "rh-acc-2",
      workflow_json: { "9": { class_type: "KSampler" }, "92": { class_type: "SaveVideo" } },
    }),
    false,
  );
  assert.equal(appSupportsH3Accel({ id: "rh-acc-3", workflow_json: null }), false);
});

// ---------- ③ runApp 契约 ----------

test("runApp:非 off 档进 body,off/缺省不带字段,回显解析", async () => {
  responds.push({
    status: 200,
    body: { job_id: "j1", prompt_id: "p1", acceleration: "balanced", acceleration_applied: true },
  });
  const receipt = await runApp("h3-t2v", { prompt: "x" }, { acceleration: "balanced" });
  assert.equal(fetchCalls[0].method, "POST");
  assert.equal(fetchCalls[0].url.includes("/api/apps/h3-t2v/run"), true);
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.acceleration, "balanced");
  assert.equal(receipt.acceleration, "balanced");
  assert.equal(receipt.acceleration_applied, true);

  responds.push({ status: 200, body: { job_id: "j2", prompt_id: "p2" } });
  await runApp("h3-t2v", { prompt: "x" }, { acceleration: "off" });
  assert.equal("acceleration" in (fetchCalls[1].body as Record<string, unknown>), false);
  responds.push({ status: 200, body: { job_id: "j3", prompt_id: "p3" } });
  await runApp("txt2img-basic", { prompt: "x" });
  assert.equal("acceleration" in (fetchCalls[2].body as Record<string, unknown>), false);
});

// ---------- ④ submitEngineGeneration:H3 负载带 acceleration ----------

function h3Engine(id: string) {
  return {
    id,
    label: id,
    kind: "video" as const,
    available: true,
    nsfw: false,
    params: [],
  };
}

test("submitEngineGeneration:h3-t2v 带 acceleration,h3-i2v 随负载下发", async () => {
  responds.push({ status: 200, body: { prompt_id: "ph1" } });
  await submitEngineGeneration({
    engine: h3Engine("h3-t2v"),
    positive: "x",
    values: {},
    acceleration: "lossless",
  });
  assert.equal((fetchCalls[0].body as Record<string, unknown>).acceleration, "lossless");
  assert.equal(fetchCalls[0].url.includes("/api/h3/t2v"), true);

  responds.push({ status: 200, body: { prompt_id: "ph2" } });
  await submitEngineGeneration({
    engine: h3Engine("h3-i2v"),
    positive: "x",
    values: {},
    refImage: { filename: "a.png", worker: "http://w" },
    acceleration: "extreme",
  });
  const body = fetchCalls[1].body as Record<string, unknown>;
  assert.equal(body.acceleration, "extreme");
  assert.equal(fetchCalls[1].url.includes("/api/h3/i2v"), true);
});

test("submitEngineGeneration:off/缺省不发 acceleration 字段(后端行为不变)", async () => {
  responds.push({ status: 200, body: { prompt_id: "ph3" } });
  await submitEngineGeneration({
    engine: h3Engine("h3-t2v"),
    positive: "x",
    values: {},
    acceleration: "off",
  });
  assert.equal("acceleration" in (fetchCalls[0].body as Record<string, unknown>), false);

  responds.push({ status: 200, body: { prompt_id: "ph4" } });
  await submitEngineGeneration({ engine: h3Engine("h3-t2v"), positive: "x", values: {} });
  assert.equal("acceleration" in (fetchCalls[1].body as Record<string, unknown>), false);
});

test("submitEngineGeneration:非 H3 引擎即使传了 acceleration 也不下发", async () => {
  responds.push({ status: 200, body: { prompt_id: "ph5" } });
  await submitEngineGeneration({
    engine: {
      ...h3Engine("longcat-t2v"),
      params: [
        { key: "width", label: "宽", type: "number" as const, default: 832 },
        { key: "height", label: "高", type: "number" as const, default: 480 },
        { key: "duration", label: "时长", type: "number" as const, default: 7.5 },
        { key: "steps", label: "步数", type: "number" as const, default: 10 },
        { key: "fps", label: "帧率", type: "number" as const, default: 16 },
      ],
    },
    positive: "x",
    values: {},
    acceleration: "balanced",
  });
  assert.equal("acceleration" in (fetchCalls[0].body as Record<string, unknown>), false);
});

// ---------- ⑤ 视图接线(源检查) ----------

test("AppRunnerView:H3 应用渲染选择器并随提交下发", () => {
  const src = readFileSync(new URL("../components/apps/AppRunnerView.tsx", import.meta.url), "utf8");
  assert.ok(src.includes("H3AccelSelect"), "应渲染 H3AccelSelect");
  assert.ok(src.includes("appSupportsH3Accel(app)"), "仅 H3 家族应用显示选择器");
  assert.ok(src.includes("appSupportsH3Accel(app) ? accel : \"off\""), "提交携带加速档");
});

test("EngineStudioView:h3-* 引擎卡渲染选择器并传入 submitEngineGeneration", () => {
  const src = readFileSync(
    new URL("../components/studio/EngineStudioView.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes("H3AccelSelect"), "应渲染 H3AccelSelect");
  assert.ok(src.includes("isH3EngineId(engine.id)"), "仅 h3-* 引擎显示选择器");
  assert.ok(src.includes("accelByEngine[target.id]"), "提交携带分槽加速档");
});

test("H3AccelSelect:四档选项 + tooltip 说明 + styled-jsx global 前缀", () => {
  const src = readFileSync(
    new URL("../components/generate/H3AccelSelect.tsx", import.meta.url),
    "utf8",
  );
  assert.ok(src.includes('aria-label="智能加速"'), "选择器可访问名");
  assert.ok(src.includes("<style jsx global>"), "P-2b:styled-jsx global");
  assert.ok(src.includes("h3accel-"), "样式前缀 h3accel-");
  assert.ok(src.includes("实测") && src.includes("参考"), "倍率来源注明");
  assert.ok(src.includes("极限加速最快但质量可能有可见损失"), "tooltip 质量说明");
});
