/**
 * 关键帧链式转场(对标 Pika 2.5 Pikaframes)前端单测(node:test + fetch 桩):
 * ① chainTotalDuration:总时长实时计算(均分/自定义)
 * ② reorderSlots:拖拽排序(上移/下移/越界不动)
 * ③ buildChainPrompts:段提示词全空 → 单 string 共用;有覆盖 → 逐段(空回退共享)
 * ④ chainSubmittable 提交门控:帧数/时长/提示词/busy
 * ⑤ submitKeyframeChain:路由 /api/generate/keyframe-chain,载荷契约
 *   (keyframes 链序文件名/prompts/durations/worker/seed);异 worker 与帧数不足拦截;422 展开
 * ⑥ chainProgress:段进度计数/合并 done 出片/error 透出/held 排队
 * ⑦ KeyframeChainEditor 源码断言:槽位/拖拽/作品库/总时长预览;GenerateView 引擎接线;
 *    libraryQuery:keyframe_chain 归视频桶,短名「关键帧链」
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  CHAIN_MAX_TOTAL_SEC,
  buildChainPrompts,
  chainProgress,
  chainSubmittable,
  chainTotalDuration,
  reorderSlots,
  submitKeyframeChain,
} from "../lib/keyframeChain";
import { kindLabel, kindToFilter } from "../lib/libraryQuery";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

// ── ① 总时长计算 ──────────────────────────────────────────────────────────

test("① chainTotalDuration:逐段求和(实时预览口径),两位小数稳定", () => {
  assert.equal(chainTotalDuration([5, 5]), 10);
  assert.equal(chainTotalDuration([2, 4.5, 8]), 14.5);
  assert.equal(chainTotalDuration([10, 10, 5]), 25);
  assert.equal(chainTotalDuration([]), 0);
});

// ── ② 拖拽排序 ────────────────────────────────────────────────────────────

test("② reorderSlots:元素从 from 移到 to,其余顺序保持", () => {
  assert.deepEqual(reorderSlots(["a", "b", "c", "d"], 0, 2), ["b", "c", "a", "d"]);
  assert.deepEqual(reorderSlots(["a", "b", "c", "d"], 3, 1), ["a", "d", "b", "c"]);
  assert.deepEqual(reorderSlots(["a", "b"], 1, 1), ["a", "b"], "原位不动");
  // 越界索引:原样返回(防御,不抛错)
  assert.deepEqual(reorderSlots(["a", "b"], -1, 5), ["a", "b"]);
});

// ── ③ 段提示词组装 ────────────────────────────────────────────────────────

test("③ buildChainPrompts:全空 → 单 string 共用;有覆盖 → 逐段,空回退共享", () => {
  assert.equal(buildChainPrompts("  同一提示词  ", ["", "  "]), "同一提示词");
  assert.deepEqual(buildChainPrompts("共享", ["段一", ""]), ["段一", "共享"]);
  assert.deepEqual(buildChainPrompts("共享", ["段一", "段二"]), ["段一", "段二"]);
});

// ── ④ 提交门控 ────────────────────────────────────────────────────────────

const OK_INPUT = {
  frames: 3,
  sharedPrompt: "平滑过渡",
  segPrompts: ["", ""],
  durations: [5, 5],
  busy: false,
};

test("④ chainSubmittable:合法输入通过", () => {
  assert.equal(chainSubmittable(OK_INPUT), true);
  // 共享提示词为空但每段都有提示词也可提交
  assert.equal(
    chainSubmittable({ ...OK_INPUT, sharedPrompt: "", segPrompts: ["段一", "段二"] }),
    true,
  );
});

test("④ chainSubmittable:帧数越界/总时长超 25s/段时长越界/提示词缺/busy → 拦截", () => {
  assert.equal(chainSubmittable({ ...OK_INPUT, frames: 1 }), false, "至少 2 帧");
  assert.equal(chainSubmittable({ ...OK_INPUT, frames: 6 }), false, "至多 5 帧");
  assert.equal(
    chainSubmittable({ ...OK_INPUT, frames: 4, durations: [10, 10, 10] }),
    false,
    `总时长不得超 ${CHAIN_MAX_TOTAL_SEC}s`,
  );
  assert.equal(chainSubmittable({ ...OK_INPUT, durations: [0.5, 5] }), false, "段时长 ≥1s");
  assert.equal(chainSubmittable({ ...OK_INPUT, durations: [11, 5] }), false, "段时长 ≤10s");
  assert.equal(
    chainSubmittable({ ...OK_INPUT, sharedPrompt: " ", segPrompts: ["", ""] }),
    false,
    "共享与逐段提示词全空不可提交",
  );
  assert.equal(chainSubmittable({ ...OK_INPUT, busy: true }), false, "busy 态不可重复提交");
});

// ── ⑤ 提交链路(fetch 桩)─────────────────────────────────────────────────

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
      JSON.stringify({
        prompt_id: "chain-abc123",
        segments: ["prompt-seg-1", "prompt-seg-2"],
        total_duration: 9,
        worker: "http://wan",
        seed: 42,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

function chainFrames(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    filename: `k${i + 1}.png`,
    worker: "http://pool1",
  }));
}

test("⑤ submitKeyframeChain:路由与载荷契约(链序文件名/共用提示词/逐段时长/worker)", async () => {
  const res = await submitKeyframeChain({
    keyframes: chainFrames(3),
    prompts: "平滑过渡",
    durations: [3, 6],
    width: 832,
    height: 480,
    steps: 20,
    cfg: 4.5,
    seed: 42,
  });
  assert.equal(res.prompt_id, "chain-abc123");
  assert.deepEqual(res.segments, ["prompt-seg-1", "prompt-seg-2"]);
  assert.equal(fetchCalls.length, 1, "仅一次提交请求");
  assert.ok(
    fetchCalls[0].url.endsWith("/api/generate/keyframe-chain"),
    "路由必须为 /api/generate/keyframe-chain",
  );
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.deepEqual(body.keyframes, ["k1.png", "k2.png", "k3.png"], "按链序上传文件名");
  assert.equal(body.prompts, "平滑过渡");
  assert.deepEqual(body.durations, [3, 6]);
  assert.equal(body.worker, "http://pool1", "worker 取首帧落点(上传时已互钉)");
  assert.equal(body.cfg, 4.5);
  assert.equal(body.seed, 42);
});

test("⑤ submitKeyframeChain:逐段提示词 list 直传;durations 缺省不传(后端均分)", async () => {
  await submitKeyframeChain({
    keyframes: chainFrames(3),
    prompts: ["段一", "段二"],
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.deepEqual(body.prompts, ["段一", "段二"]);
  assert.equal("durations" in body, false, "durations 未给时不随负载下发(后端默认 5s 均分)");
  assert.equal("seed" in body, false, "seed 未给时不随负载下发");
});

test("⑤ submitKeyframeChain:不足 2 帧/异 worker → 提交前拦截,不发请求", async () => {
  await assert.rejects(
    submitKeyframeChain({ keyframes: chainFrames(1), prompts: "x" }),
    /2-5/,
  );
  await assert.rejects(
    submitKeyframeChain({
      keyframes: [
        { filename: "a.png", worker: "http://pool1" },
        { filename: "b.png", worker: "http://pool2" },
      ],
      prompts: "x",
    }),
    /同一 worker/,
  );
  assert.equal(fetchCalls.length, 0, "拦截期不得发出提交请求");
});

test("⑤ submitKeyframeChain:后端 422 文案透出", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ detail: "链式转场总时长最长 25 秒(当前 30 秒),请缩短各段时长" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    submitKeyframeChain({ keyframes: chainFrames(2), prompts: "x", durations: [10] }),
    /总时长最长 25 秒/,
  );
});

// ── ⑥ 段进度与成片解析 ────────────────────────────────────────────────────

function job(promptId: string, kind: string, status: string, results: string[] = []): JobItem {
  return {
    id: `j-${promptId}`,
    prompt_id: promptId,
    kind,
    status,
    prompt: "",
    seed: 1,
    created_at: "",
    results,
  };
}

test("⑥ chainProgress:段 done 计数;合并 done → 成片 URL;held → 排队态", () => {
  const ids = ["p1", "p2", "p3"];
  const running = chainProgress(
    [job("p1", "transition", "done", ["/api/images?a"]), job("p2", "transition", "running"), job("p3", "transition", "queued"), job("chain-x", "keyframe_chain", "queued")],
    ids,
    "chain-x",
  );
  assert.deepEqual(
    { segDone: running.segDone, segTotal: running.segTotal, status: running.status },
    { segDone: 1, segTotal: 3, status: "running" },
  );

  const held = chainProgress([job("p1", "transition", "held")], ["p1"], "chain-x");
  assert.equal(held.status, "held");

  const done = chainProgress(
    [
      ...ids.map((p) => job(p, "transition", "done", ["/api/images?seg"])),
      job("chain-x", "keyframe_chain", "done", ["/api/images?filename=final.mp4&sig=s"]),
    ],
    ids,
    "chain-x",
  );
  assert.equal(done.status, "done");
  assert.equal(done.resultUrl, "/api/images?filename=final.mp4&sig=s");
  assert.equal(done.segDone, 3);

  const failed = chainProgress(
    [job("p1", "transition", "done"), job("p2", "transition", "error")],
    ["p1", "p2"],
    "chain-x",
  );
  assert.equal(failed.status, "error");
});

// ── ⑦ 组件与集成源码断言 ──────────────────────────────────────────────────

test("⑦ KeyframeChainEditor:槽位/拖拽排序/作品库/总时长预览/提交进度", () => {
  const src = readSrc("components/generate/KeyframeChainEditor.tsx");
  assert.ok(src.includes("CHAIN_MAX_FRAMES"), "缺槽位上限常量");
  assert.ok(src.includes("draggable"), "槽位缺拖拽排序(draggable)");
  assert.ok(src.includes("onDragStart") && src.includes("onDrop"), "缺 dragstart/drop 处理");
  assert.ok(src.includes("reorderSlots"), "拖拽落点未走 reorderSlots");
  assert.ok(src.includes("AssetPicker"), "缺「从作品库选择」入口");
  assert.ok(src.includes("chainTotalDuration"), "缺总时长实时预览");
  assert.ok(src.includes("type=\"range\""), "段时长缺滑块(input[type=range])");
  assert.ok(src.includes("chainProgress"), "busy 态段进度未走 chainProgress 轮询");
});

test("⑦ KeyframeChainEditor:P0-4 锁死根治(allSettled / canceled 终态 / 404 连击 / 总超时 / 停止跟踪)", () => {
  const src = readSrc("components/generate/KeyframeChainEditor.tsx");
  assert.ok(src.includes("Promise.allSettled"), "段查询须 allSettled(单点失败不吞整轮)");
  assert.ok(!src.includes("await Promise.all(ids.map"), "Promise.all 单点静默残留");
  assert.ok(src.includes('progress?.status !== "canceled"'), "busy 门控缺 canceled 终态");
  assert.ok(src.includes("RUN_MISS_LIMIT"), "缺 404 连击判消失");
  assert.ok(src.includes("RUN_TIMEOUT_MS"), "缺轮询总超时兜底");
  assert.ok(src.includes("stopTracking"), "缺「停止跟踪」逃生口");
  assert.ok(src.includes("已停止跟踪"), "停止跟踪缺提示");
});

test("⑦ KeyframeChainEditor:伪 token var(--danger) 已清剿(2026-08-30)", () => {
  const src = readSrc("components/generate/KeyframeChainEditor.tsx");
  assert.ok(!src.includes("--danger"), "伪 token --danger 残留");
  assert.ok(!src.includes("#e5484d"), "硬编码 hex #e5484d 残留");
});

test("⑦ GenerateView 接线:keyframe-chain 引擎渲染 KeyframeChainEditor", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(
    src.includes('"keyframe-chain"'),
    "GenerateView 缺 keyframe-chain 引擎特判",
  );
  assert.ok(
    src.includes("KeyframeChainEditor"),
    "GenerateView 未渲染 KeyframeChainEditor",
  );
});

test("⑦ libraryQuery:keyframe_chain 归视频桶,短名「关键帧链」", () => {
  assert.equal(kindToFilter("keyframe_chain"), "video");
  assert.equal(kindLabel("keyframe_chain"), "关键帧链");
});
