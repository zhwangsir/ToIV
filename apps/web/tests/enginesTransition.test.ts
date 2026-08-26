/**
 * wan-transition(首尾帧转场,Wan2.1-VACE)统一工作台提交链路单测(node:test + fetch 桩):
 * ① submitEngineGeneration 路由到 POST /api/generate/transition,载荷含
 *    first_frame/last_frame/worker/cfg,顺序语义(第 1 张=首帧,第 2 张=尾帧)
 * ② 不是恰好 2 张图 → 提交前拦截报错(后端契约两帧必填)
 * ③ GenerateView 接线:canSubmit 恰好 2 张门控 + uploadKind 复用 wan_vace(同实例 :8197)
 * ④ libraryQuery:kind=transition 归视频桶,中文短名「首尾帧转场」
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  submitEngineGeneration,
  type EngineInfo,
  type EngineParam,
} from "../lib/engines";
import { kindLabel, kindToFilter } from "../lib/libraryQuery";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

/** 与后端 engine_registry._wan_transition_params() 同形。 */
const TRANSITION_PARAMS: EngineParam[] = [
  { key: "images", label: "首尾帧(首帧→尾帧)", type: "images", max: 2, default: null },
  { key: "negative", label: "负向提示词", type: "textarea", default: "" },
  { key: "width", label: "宽度", type: "number", default: 832 },
  { key: "height", label: "高度", type: "number", default: 480 },
  { key: "duration", label: "时长(秒)", type: "number", default: 5 },
  { key: "steps", label: "采样步数", type: "number", default: 20 },
  { key: "cfg", label: "CFG", type: "number", default: 5.0 },
  { key: "fps", label: "帧率", type: "number", default: 16 },
  { key: "seed", label: "随机种子", type: "text", default: "" },
];

function transitionEngine(): EngineInfo {
  return {
    id: "wan-transition",
    label: "首尾帧转场",
    kind: "video",
    available: true,
    nsfw: false,
    params: TRANSITION_PARAMS,
  };
}

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

test("① wan-transition 提交:路由 /api/generate/transition,首帧/尾帧按顺序进载荷", async () => {
  await submitEngineGeneration({
    engine: transitionEngine(),
    positive: "镜头从白天过渡到夜晚",
    values: { width: "832", height: "480", duration: "6", steps: "20", cfg: "4.5", fps: "16", seed: "" },
    refImages: [
      { filename: "first.png", worker: "http://pool1" },
      { filename: "last.png", worker: "http://pool1" },
    ],
  });
  assert.equal(fetchCalls.length, 1, "仅一次提交请求");
  assert.ok(fetchCalls[0].url.endsWith("/api/generate/transition"), "路由必须为 /api/generate/transition");
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.first_frame, "first.png", "第 1 张 = 首帧");
  assert.equal(body.last_frame, "last.png", "第 2 张 = 尾帧");
  assert.equal(body.worker, "http://pool1", "worker 取首帧落点(上传时已互钉)");
  assert.equal(body.positive, "镜头从白天过渡到夜晚");
  assert.equal(body.cfg, 4.5);
  assert.equal(body.duration_sec, 6, "时长秒数直传(后端统一策略层换算帧数)");
  assert.equal(body.steps, 20);
  assert.equal("images" in body, false, "不得携带 images(那是 vace 多参考图契约)");
});

test("② 不是恰好 2 张图:提交前拦截,不发请求", async () => {
  await assert.rejects(
    submitEngineGeneration({
      engine: transitionEngine(),
      positive: "x",
      values: {},
      refImages: [{ filename: "first.png", worker: "http://pool1" }],
    }),
    /请按顺序上传首帧与尾帧/,
  );
  await assert.rejects(
    submitEngineGeneration({ engine: transitionEngine(), positive: "x", values: {} }),
    /请先上传参考图/,
  );
  assert.equal(fetchCalls.length, 0, "拦截期不得发出提交请求");
});

test("③ GenerateView 接线:恰好 2 张门控 + uploadKind 复用 wan_vace", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(
    src.includes('engine.id !== "wan-transition" || refImages.length === 2'),
    "canSubmit 缺首尾帧恰好 2 张门控",
  );
  // uploadKind 映射:wan-transition 与 VACE 同实例(:8197),复用同一上传 kind
  const idx = src.indexOf('engine?.id === "wan-transition"');
  assert.ok(idx > 0, "uploadKind 缺 wan-transition 分支");
  assert.ok(
    src.slice(idx, idx + 200).includes('"wan_vace"'),
    "wan-transition 上传 kind 应复用 wan_vace",
  );
});

test("④ libraryQuery:kind=transition 归视频桶,短名「首尾帧转场」", () => {
  assert.equal(kindToFilter("transition"), "video");
  assert.equal(kindLabel("transition"), "首尾帧转场");
});
