/**
 * H3 多镜头单次生成(对标 Vidu Q3 / PixVerse MultiShot)前端单测(node:test + fetch 桩):
 * ① multishotTotalDuration:总时长实时计算(逐镜头求和)
 * ② reorderShots:拖拽排序(前移/后移/越界不动)
 * ③ multishotSubmittable 提交门控:镜头数/逐镜头时长/总时长/提示词/busy
 * ④ submitMultiShot:路由 /api/h3/multishot,载荷契约
 *   (shots 逐镜头 prompt/duration_sec/camera_hint/transition_hint/width/steps/seed);
 *   镜头数不足与空提示词拦截;422 展开
 * ⑤ MultiShotEditor 源码断言:镜头卡/拖拽/增删/时长滑块/运镜与转场下拉/总时长护栏/提交;
 *    GenerateView 引擎接线;libraryQuery:h3_multishot 归视频桶,短名「多镜头」
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { kindLabel, kindToFilter } from "../lib/libraryQuery";
import {
  MULTISHOT_MAX_TOTAL_SEC,
  multishotSubmittable,
  multishotTotalDuration,
  reorderShots,
  submitMultiShot,
  type ShotDraft,
} from "../lib/multishot";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

function shot(prompt: string, durationSec = 4): ShotDraft {
  return { prompt, durationSec, cameraHint: "", transitionHint: "" };
}

// ── ① 总时长计算 ──────────────────────────────────────────────────────────

test("① multishotTotalDuration:逐镜头求和(实时预览口径),两位小数稳定", () => {
  assert.equal(multishotTotalDuration([5, 5]), 10);
  assert.equal(multishotTotalDuration([2, 4.5, 8]), 14.5);
  assert.equal(multishotTotalDuration([4, 4, 4, 3]), 15);
  assert.equal(multishotTotalDuration([]), 0);
});

// ── ② 拖拽排序 ────────────────────────────────────────────────────────────

test("② reorderShots:元素从 from 移到 to,其余顺序保持;越界原样返回", () => {
  assert.deepEqual(reorderShots(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderShots(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderShots(["a", "b"], 1, 1), ["a", "b"], "原位不动");
  assert.deepEqual(reorderShots(["a", "b"], -1, 5), ["a", "b"], "越界不动");
});

// ── ③ 提交门控 ────────────────────────────────────────────────────────────

const OK_INPUT = {
  shots: [shot("镜头一内容", 5), shot("镜头二内容", 5)],
  busy: false,
};

test("③ multishotSubmittable:合法输入通过(2-4 镜头)", () => {
  assert.equal(multishotSubmittable(OK_INPUT), true);
  assert.equal(
    multishotSubmittable({ shots: [shot("a", 3), shot("b", 3), shot("c", 3), shot("d", 3)], busy: false }),
    true,
    "4 镜头可提交",
  );
});

test("③ multishotSubmittable:镜头数越界/总时长超 15s/镜头时长越界/空提示词/busy → 拦截", () => {
  assert.equal(multishotSubmittable({ shots: [shot("a", 5)], busy: false }), false, "至少 2 镜头");
  assert.equal(
    multishotSubmittable({ shots: [shot("a"), shot("b"), shot("c"), shot("d"), shot("e")], busy: false }),
    false,
    "至多 4 镜头",
  );
  assert.equal(
    multishotSubmittable({ shots: [shot("a", 8), shot("b", 8)], busy: false }),
    false,
    `总时长不得超 ${MULTISHOT_MAX_TOTAL_SEC}s`,
  );
  assert.equal(
    multishotSubmittable({ shots: [shot("a", 1.5), shot("b", 5)], busy: false }),
    false,
    "镜头时长 ≥2s",
  );
  assert.equal(
    multishotSubmittable({ shots: [shot("a", 9), shot("b", 2)], busy: false }),
    false,
    "镜头时长 ≤8s",
  );
  assert.equal(
    multishotSubmittable({ shots: [shot("  ", 5), shot("b", 5)], busy: false }),
    false,
    "空提示词不可提交",
  );
  assert.equal(multishotSubmittable({ ...OK_INPUT, busy: true }), false, "busy 态不可重复提交");
});

// ── ④ 提交链路(fetch 桩)─────────────────────────────────────────────────

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
      JSON.stringify({ prompt_id: "ms-abc123", worker: "http://h3", seed: 42 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("④ submitMultiShot:路由与载荷契约(逐镜头 prompt/时长/运镜/转场,width/steps/seed)", async () => {
  const res = await submitMultiShot({
    shots: [
      { prompt: "  深夜便利店,女人整理货架 ", durationSec: 5, cameraHint: "固定", transitionHint: "" },
      { prompt: "女人抬头看向门口", durationSec: 5, cameraHint: "推", transitionHint: "淡入淡出" },
    ],
    width: 1344,
    height: 768,
    steps: 20,
    seed: 42,
  });
  assert.equal(res.prompt_id, "ms-abc123");
  assert.equal(fetchCalls.length, 1, "仅一次提交请求");
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/multishot"), "路由必须为 /api/h3/multishot");
  const body = fetchCalls[0].body as Record<string, unknown>;
  const shots = body.shots as Record<string, unknown>[];
  assert.equal(shots.length, 2);
  assert.equal(shots[0].prompt, "深夜便利店,女人整理货架", "提示词首尾空白裁剪");
  assert.equal(shots[0].duration_sec, 5);
  assert.equal(shots[0].camera_hint, "固定");
  assert.equal("transition_hint" in shots[0], false, "空转场不随负载下发(后端默认硬切)");
  assert.equal(shots[1].transition_hint, "淡入淡出");
  assert.equal(body.width, 1344);
  assert.equal(body.steps, 20);
  assert.equal(body.seed, 42);
});

test("④ submitMultiShot:seed 未给不下发;镜头数不足/空提示词 → 提交前拦截,不发请求", async () => {
  await submitMultiShot({ shots: [shot("a", 3), shot("b", 3)] });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal("seed" in body, false, "seed 未给时不随负载下发");

  fetchCalls = [];
  await assert.rejects(submitMultiShot({ shots: [shot("a", 3)] }), /2-4 个/);
  await assert.rejects(submitMultiShot({ shots: [shot(" ", 3), shot("b", 3)] }), /不能为空/);
  assert.equal(fetchCalls.length, 0, "拦截期不得发出提交请求");
});

test("④ submitMultiShot:后端 422 文案透出", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ detail: "多镜头总时长最长 15 秒(H3 单段上限,当前 16 秒),请缩短各镜头时长" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    submitMultiShot({ shots: [shot("a", 8), shot("b", 8)] }),
    /最长 15 秒/,
  );
});

// ── ⑤ 组件与集成源码断言 ──────────────────────────────────────────────────

test("⑤ MultiShotEditor:镜头卡/拖拽排序/增删/时长滑块/运镜与转场下拉/总时长护栏/提交", () => {
  const src = readSrc("components/generate/MultiShotEditor.tsx");
  assert.ok(src.includes("MULTISHOT_MAX_SHOTS"), "缺镜头上限常量");
  assert.ok(src.includes("draggable"), "镜头卡缺拖拽排序(draggable)");
  assert.ok(src.includes("onDragStart") && src.includes("onDrop"), "缺 dragstart/drop 处理");
  assert.ok(src.includes("reorderShots"), "拖拽落点未走 reorderShots");
  assert.ok(src.includes("添加镜头"), "缺「添加镜头」按钮");
  assert.ok(src.includes("removeShot"), "缺镜头移除");
  assert.ok(src.includes('type="range"'), "镜头时长缺滑块(input[type=range])");
  assert.ok(src.includes("MULTISHOT_CAMERA_OPTIONS"), "缺运镜提示下拉");
  assert.ok(src.includes("MULTISHOT_TRANSITION_OPTIONS"), "缺转场提示下拉");
  assert.ok(src.includes("multishotTotalDuration"), "缺总时长实时计算");
  assert.ok(src.includes("multishotSubmittable"), "提交门控未走 multishotSubmittable");
  assert.ok(src.includes("submitMultiShot"), "提交未走 submitMultiShot");
  // 2026-08-29:轮询从全量 200 条过滤改为 lookupJob 精确查询(降负载)
  assert.ok(src.includes("lookupJob"), "busy 态缺作业轮询(lookupJob)");
  assert.ok(src.includes("EntityPicker"), "缺主体引用(EntityPicker)");
  assert.ok(src.includes("entity_ids"), "提交未带 entity_ids");
});

test("⑤ GenerateView 接线:h3-multishot 引擎渲染 MultiShotEditor", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('"h3-multishot"'), "GenerateView 缺 h3-multishot 引擎特判");
  assert.ok(src.includes("MultiShotEditor"), "GenerateView 未渲染 MultiShotEditor");
});

test("⑤ libraryQuery:h3_multishot 归视频桶,短名「多镜头」", () => {
  assert.equal(kindToFilter("h3_multishot"), "video");
  assert.equal(kindLabel("h3_multishot"), "多镜头");
});
