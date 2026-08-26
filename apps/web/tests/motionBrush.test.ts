/**
 * Motion Brush 局部动效标记 前端单测(node:test + fetch 桩 + 源码断言):
 * ① normalizeDirection / dragDirection(阈值)/ clampRadius / dabInCanvas
 * ② undoLastGesture 按手势整体撤销 / groupByGesture / gestureDirectionDeg
 * ③ motionBrushSubmittable 提交门控(空/超上限/busy)
 * ④ submitMotionBrushMask:路由 /api/motion-brush/mask,载荷契约
 *   (source_image/worker/width/height/strokes 字段映射),空笔画与超上限拦截,422 展开
 * ⑤ MotionBrushEditor 源码断言:画布/涂抹(pointer capture)/画笔 5-100/强度滑块/
 *   撤销/清空/半透明红预览/方向箭头/生成 mask 按钮
 * ⑥ GenerateView 接线:Motion Brush 按钮(wan-vace/wan-transition 门控)/编辑器挂载/
 *   参考图变更清除 mask/提交透传 motionMask;engines.ts 契约 motion_mask 字段
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  BRUSH_MAX_STROKES,
  clampRadius,
  dabInCanvas,
  dragDirection,
  gestureDirectionDeg,
  groupByGesture,
  motionBrushSubmittable,
  normalizeDirection,
  submitMotionBrushMask,
  undoLastGesture,
  type BrushDab,
} from "../lib/motionBrush";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

function dab(gesture: number, over: Partial<BrushDab> = {}): BrushDab {
  return { cx: 10, cy: 10, radius: 20, dx: 0, dy: 0, strength: 1, gesture, ...over };
}

/* ── ① 方向/半径/画布 ─────────────────────────────────────────────────── */

test("① normalizeDirection:模长 >1 归一,零向量保持无方向", () => {
  const [dx, dy] = normalizeDirection(3, 4);
  assert.ok(Math.abs(Math.hypot(dx, dy) - 1) < 1e-6);
  assert.ok(Math.abs(dx - 0.6) < 1e-6 && Math.abs(dy - 0.8) < 1e-6);
  assert.deepEqual(normalizeDirection(0, 0), [0, 0]);
  // 模长 ≤1 原样保留(已是单位圆内)
  assert.deepEqual(normalizeDirection(0.5, 0), [0.5, 0]);
});

test("① dragDirection:短于阈值 = 只标区域不定向;达到阈值归一化", () => {
  assert.deepEqual(dragDirection(0, 0, 3, 3), [0, 0], "短拖拽不定方向");
  const [dx, dy] = dragDirection(0, 0, 100, 0);
  assert.ok(Math.abs(dx - 1) < 1e-6 && Math.abs(dy) < 1e-6, "向右拖拽 → (1,0)");
});

test("① clampRadius:钳制 5-100px", () => {
  assert.equal(clampRadius(1), 5);
  assert.equal(clampRadius(200), 100);
  assert.equal(clampRadius(24), 24);
});

test("① dabInCanvas:圆心须在画布内", () => {
  assert.equal(dabInCanvas(dab(1, { cx: 50, cy: 50 }), 100, 100), true);
  assert.equal(dabInCanvas(dab(1, { cx: -1 }), 100, 100), false);
  assert.equal(dabInCanvas(dab(1, { cy: 100 }), 100, 100), false);
});

/* ── ② 手势分组/撤销/方向角 ───────────────────────────────────────────── */

test("② undoLastGesture:按手势整体撤销(同手势多 dab 一次移除)", () => {
  const dabs = [dab(1), dab(1, { cx: 30 }), dab(2), dab(2, { cx: 40 })];
  const out = undoLastGesture(dabs);
  assert.equal(out.length, 2);
  assert.ok(out.every((d) => d.gesture === 1), "最后手势(2)的全部 dab 被移除");
  assert.deepEqual(undoLastGesture([]), [], "空数组原样返回");
});

test("② groupByGesture:保持首现序分组", () => {
  const groups = groupByGesture([dab(1), dab(2), dab(1)]);
  assert.equal(groups.length, 2);
  assert.deepEqual(groups[0].map((d) => d.gesture), [1, 1]);
  assert.deepEqual(groups[1].map((d) => d.gesture), [2]);
});

test("② gestureDirectionDeg:取首个有向 dab 的角度;全无向 → null", () => {
  assert.equal(gestureDirectionDeg([dab(1), dab(1)]), null);
  assert.equal(gestureDirectionDeg([dab(1, { dx: 1, dy: 0 })]), 0);
  assert.equal(gestureDirectionDeg([dab(1, { dx: 0, dy: 1 })]), 90);
});

/* ── ③ 提交门控 ───────────────────────────────────────────────────────── */

test("③ motionBrushSubmittable:空/超上限/busy 拦截", () => {
  assert.equal(motionBrushSubmittable({ dabs: 3, busy: false }), true);
  assert.equal(motionBrushSubmittable({ dabs: 0, busy: false }), false, "空笔画不可提交");
  assert.equal(
    motionBrushSubmittable({ dabs: BRUSH_MAX_STROKES + 1, busy: false }),
    false,
    "超上限不可提交",
  );
  assert.equal(motionBrushSubmittable({ dabs: 3, busy: true }), false, "busy 不可重复提交");
});

/* ── ④ submitMotionBrushMask 契约 ─────────────────────────────────────── */

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
        mask: "motion-brush-abc123.png",
        width: 832,
        height: 480,
        strokes: 1,
        url: "/api/images?filename=motion-brush-abc123.png&type=input&worker=http%3A%2F%2Fpool1",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("④ submitMotionBrushMask:路由 /api/motion-brush/mask,字段映射后端契约", async () => {
  const r = await submitMotionBrushMask({
    sourceImage: "first.png",
    worker: "http://pool1",
    dabs: [dab(1, { cx: 100.123, cy: 50, radius: 24, dx: 1, dy: 0, strength: 0.8 })],
    width: 832,
    height: 480,
  });
  assert.equal(r.mask, "motion-brush-abc123.png");
  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].url.endsWith("/api/motion-brush/mask"), "路由必须为 /api/motion-brush/mask");
  assert.equal(fetchCalls[0].method, "POST");
  const body = fetchCalls[0].body as {
    source_image: string;
    worker: string;
    width: number;
    height: number;
    strokes: Array<Record<string, number>>;
  };
  assert.equal(body.source_image, "first.png");
  assert.equal(body.worker, "http://pool1");
  assert.equal(body.width, 832);
  assert.equal(body.height, 480);
  assert.equal(body.strokes.length, 1);
  const s = body.strokes[0];
  assert.equal(s.center_x, 100.12, "cx → center_x(两位小数)");
  assert.equal(s.center_y, 50, "cy → center_y");
  assert.equal(s.radius, 24);
  assert.equal(s.direction_x, 1, "dx → direction_x");
  assert.equal(s.direction_y, 0, "dy → direction_y");
  assert.equal(s.strength, 0.8);
});

test("④ submitMotionBrushMask:空笔画与超上限拦截,不发请求", async () => {
  await assert.rejects(
    submitMotionBrushMask({
      sourceImage: "a.png", worker: "http://pool1", dabs: [], width: 832, height: 480,
    }),
    /涂抹/,
  );
  const tooMany = Array.from({ length: BRUSH_MAX_STROKES + 1 }, () => dab(1));
  await assert.rejects(
    submitMotionBrushMask({
      sourceImage: "a.png", worker: "http://pool1", dabs: tooMany, width: 832, height: 480,
    }),
    /最多/,
  );
  assert.equal(fetchCalls.length, 0, "拦截期不得发出请求");
});

test("④ submitMotionBrushMask:后端 422 展开 detail", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ detail: "strokes[0] 半径 3 越界(须 5-100px)" }), {
      status: 422,
      headers: { "Content-Type": "application/json" },
    })) as typeof fetch;
  await assert.rejects(
    submitMotionBrushMask({
      sourceImage: "a.png", worker: "http://pool1", dabs: [dab(1)], width: 832, height: 480,
    }),
    /半径/,
  );
});

/* ── ⑤ MotionBrushEditor 源码断言 ─────────────────────────────────────── */

test("⑤ MotionBrushEditor:画布涂抹(pointer capture)+ 画笔 5-100 + 强度滑块", () => {
  const src = readSrc("components/motion-brush/MotionBrushEditor.tsx");
  assert.ok(src.includes("mb-canvas"), "缺涂抹画布");
  assert.ok(src.includes("setPointerCapture"), "涂抹缺 pointer capture");
  assert.ok(src.includes("onPointerDown") && src.includes("onPointerMove"), "缺 pointer 事件");
  assert.ok(src.includes("BRUSH_MIN_RADIUS") && src.includes("BRUSH_MAX_RADIUS"), "画笔范围未用共享常量");
  assert.ok(src.includes('aria-label="画笔大小"'), "缺画笔大小滑块");
  assert.ok(src.includes('aria-label="运动强度"'), "缺运动强度滑块");
});

test("⑤ MotionBrushEditor:撤销/清空/半透明红预览/方向箭头/生成 mask", () => {
  const src = readSrc("components/motion-brush/MotionBrushEditor.tsx");
  assert.ok(src.includes("undoLastGesture"), "缺撤销(按手势)");
  assert.ok(src.includes("清空"), "缺清空按钮");
  assert.ok(src.includes("rgba(235, 60, 60"), "缺半透明红色叠加预览");
  assert.ok(src.includes("gestureDirectionDeg"), "缺方向箭头绘制");
  assert.ok(src.includes("dragDirection"), "拖拽定方向未接");
  assert.ok(src.includes("生成 mask"), "缺生成 mask 按钮");
  assert.ok(src.includes("submitMotionBrushMask"), "未调提交链路");
  assert.ok(src.includes("motionBrushSubmittable"), "提交未过门控");
});

/* ── ⑥ GenerateView / engines.ts 接线 ─────────────────────────────────── */

test("⑥ GenerateView:Motion Brush 按钮(wan-vace/wan-transition 门控)+ 编辑器挂载", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("MotionBrushEditor"), "未引入 MotionBrushEditor");
  assert.ok(src.includes("Motion Brush"), "缺 Motion Brush 按钮");
  assert.ok(
    src.includes('MOTION_BRUSH_ENGINES: ReadonlySet<string> = new Set(["wan-vace", "wan-transition"])'),
    "门控应仅 VACE 链路引擎",
  );
  assert.ok(src.includes("MOTION_BRUSH_ENGINES.has(engine.id)"), "门控判定未走引擎集合");
  assert.ok(src.includes("motionBrushOpen"), "缺编辑器开关状态");
  assert.ok(src.includes("setMotionMaskByEngine"), "缺 mask 回填");
  // 参考图变更 → mask 失效清除
  assert.ok(
    src.includes("参考图变更 → 已生成的 Motion Brush mask 失效"),
    "参考图变更未清除 mask",
  );
});

test("⑥ GenerateView:提交透传 motionMask;engines.ts 携带 motion_mask", () => {
  const gv = readSrc("components/generate/GenerateView.tsx");
  assert.ok(gv.includes("motionMask: motionMaskByEngine[target.id] || undefined"), "提交未透传 motionMask");
  const eng = readSrc("lib/engines.ts");
  assert.ok(eng.includes("motionMask?: string"), "EngineSubmitInput 缺 motionMask");
  const vaceCase = eng.slice(eng.indexOf('case "wan-vace"'));
  assert.ok(vaceCase.includes("motion_mask: motionMask"), "wan-vace 未携带 motion_mask");
  const transCase = eng.slice(eng.indexOf('case "wan-transition"'));
  assert.ok(transCase.includes("motion_mask: motionMask"), "wan-transition 未携带 motion_mask");
});
