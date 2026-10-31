/**
 * 全局生成进度条单测(node:test,无需 DOM;组件走 renderToStaticMarkup):
 * ① bus:begin 登记(默认 indeterminate)/ determinate 选项 pct=0
 * ② bus:同 id 重复 begin 幂等(label 更新、startedAt 不重置、同 label 不重复通知)
 * ③ bus:progress 取整 + 夹取 0-100 / 未知 id 与不变值静默
 * ④ bus:end 移除并通知 / 未知 id 静默;退订后不再通知
 * ⑤ bus:getSnapshot 稳定引用 + 多任务插入序
 * ⑥ GlobalProgressView:无任务零渲染;indeterminate 类与胶囊省略号;
 *    determinate 宽度/aria-valuenow/胶囊百分比;多任务聚合成「N 项生成中」
 * ⑦ trackJob 接线:begin(默认/自定义 label)→ progress 事件 → done/error 终态清除
 * ⑧ effects.css:.global-progress 系列样式存在且新增区零 hex
 * trackJob 的 EventSource/apiFetch 用与 trackJob.test.ts 同款假实现。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  begin,
  end,
  getSnapshot,
  progress,
  subscribe,
  type GenTask,
} from "../lib/generationBus";
import {
  GlobalProgress,
  GlobalProgressView,
  summarizeTasks,
} from "../components/ui/GlobalProgress";
import { trackJob } from "../lib/trackJob";
import type { GenerateResponse } from "../lib/types";

const h = React.createElement;

/** 每个用例前清空总线(模块级 Map 跨用例存续)。 */
function resetBus(): void {
  for (const t of getSnapshot()) end(t.id);
}
beforeEach(resetBus);

function task(id: string, label: string, pct: number | null): GenTask {
  return { id, label, pct, startedAt: 1 };
}

/* ── ① begin ── */
test("bus:begin 登记任务,默认 pct=null(indeterminate)", () => {
  begin("a", "任务A");
  const snap = getSnapshot();
  assert.equal(snap.length, 1);
  assert.equal(snap[0].id, "a");
  assert.equal(snap[0].label, "任务A");
  assert.equal(snap[0].pct, null);
  assert.ok(typeof snap[0].startedAt === "number" && snap[0].startedAt > 0);
});

test("bus:begin determinate 选项初始 pct=0", () => {
  begin("a", "任务A", { determinate: true });
  assert.equal(getSnapshot()[0].pct, 0);
});

/* ── ② 幂等 begin ── */
test("bus:同 id 重复 begin 幂等(label 更新,startedAt/pct 不重置)", () => {
  begin("a", "旧名");
  progress("a", 30);
  const first = getSnapshot()[0];
  begin("a", "新名");
  const snap = getSnapshot();
  assert.equal(snap.length, 1, "不产生重复任务");
  assert.equal(snap[0].label, "新名");
  assert.equal(snap[0].startedAt, first.startedAt, "startedAt 不重置");
  assert.equal(snap[0].pct, 30, "已累计进度不重置");
});

test("bus:同 id 同 label 的 begin 不重复通知", () => {
  let calls = 0;
  const off = subscribe(() => calls++);
  begin("a", "任务A");
  begin("a", "任务A");
  assert.equal(calls, 1);
  off();
});

/* ── ③ progress ── */
test("bus:progress 取整并夹取 0-100;未知 id 静默忽略", () => {
  begin("a", "任务A");
  progress("a", 42.6);
  assert.equal(getSnapshot()[0].pct, 43, "四舍五入");
  progress("a", 150);
  assert.equal(getSnapshot()[0].pct, 100, "上限夹取");
  progress("a", -5);
  assert.equal(getSnapshot()[0].pct, 0, "下限夹取");
  progress("ghost", 10); // 不抛错即通过
  assert.equal(getSnapshot().length, 1);
});

test("bus:progress 值不变不重复通知", () => {
  begin("a", "任务A");
  progress("a", 50);
  let calls = 0;
  const off = subscribe(() => calls++);
  progress("a", 50);
  assert.equal(calls, 0);
  progress("a", 51);
  assert.equal(calls, 1);
  off();
});

/* ── ④ end / 退订 ── */
test("bus:end 移除任务并通知;未知 id 静默", () => {
  begin("a", "任务A");
  let calls = 0;
  const off = subscribe(() => calls++);
  end("a");
  assert.equal(getSnapshot().length, 0);
  assert.equal(calls, 1);
  end("a");
  assert.equal(calls, 1, "重复 end 不再通知");
  off();
});

test("bus:退订后不再接收通知", () => {
  let calls = 0;
  const off = subscribe(() => calls++);
  begin("a", "任务A");
  assert.equal(calls, 1);
  off();
  begin("b", "任务B");
  assert.equal(calls, 1);
});

/* ── ⑤ 快照契约 ── */
test("bus:getSnapshot 无变更返回稳定引用,变更后重建", () => {
  begin("a", "任务A");
  const s1 = getSnapshot();
  assert.equal(getSnapshot(), s1, "稳定引用");
  progress("a", 10);
  assert.notEqual(getSnapshot(), s1, "变更后重建");
});

test("bus:多任务按登记序排列,end 中间项保序", () => {
  begin("a", "A");
  begin("b", "B");
  begin("c", "C");
  assert.deepEqual(getSnapshot().map((t) => t.id), ["a", "b", "c"]);
  end("b");
  assert.deepEqual(getSnapshot().map((t) => t.id), ["a", "c"]);
});

/* ── ⑥ GlobalProgress 渲染 ── */
test("GlobalProgressView:无任务零渲染", () => {
  assert.equal(renderToStaticMarkup(h(GlobalProgressView, { tasks: [] })), "");
});

test("GlobalProgressView:全 indeterminate → 滑动类 + 胶囊省略号,无 aria-valuenow", () => {
  const html = renderToStaticMarkup(
    h(GlobalProgressView, { tasks: [task("a", "智能去背景", null)] }),
  );
  assert.match(html, /role="progressbar"/);
  assert.match(html, /aria-valuemin="0"/);
  assert.match(html, /aria-valuemax="100"/);
  assert.ok(!html.includes("aria-valuenow"), "不确定态不出具 valuenow");
  assert.match(html, /global-progress-fill is-indeterminate/);
  assert.match(html, /global-progress-pill/);
  assert.match(html, /智能去背景…/);
});

test("GlobalProgressView:determinate → 宽度 style + aria-valuenow + 胶囊百分比", () => {
  const html = renderToStaticMarkup(
    h(GlobalProgressView, { tasks: [task("a", "智能去背景", 42)] }),
  );
  assert.match(html, /aria-valuenow="42"/);
  assert.match(html, /style="width:42%"/);
  assert.ok(!html.includes("is-indeterminate"));
  assert.match(html, /智能去背景 42%/);
});

test("GlobalProgressView:多任务聚合「N 项生成中」,确定任务取均值", () => {
  const tasks = [task("a", "A", 40), task("b", "B", null), task("c", "C", 80)];
  const summary = summarizeTasks(tasks);
  assert.equal(summary.determinate, true);
  assert.equal(summary.avg, 60, "均值只计确定任务");
  assert.equal(summary.pillText, "3 项生成中");
  const html = renderToStaticMarkup(h(GlobalProgressView, { tasks }));
  assert.match(html, /aria-valuenow="60"/);
  assert.match(html, /3 项生成中/);
});

test("GlobalProgress(订阅容器):SSR 快照为空时零渲染", () => {
  assert.equal(renderToStaticMarkup(h(GlobalProgress)), "");
});

/* ── ⑦ trackJob 接线(行为测,FakeEventSource 同款) ── */
interface FakeEvent {
  data?: string;
}
class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  closed = false;
  private listeners = new Map<string, Set<(e: FakeEvent) => void>>();
  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }
  addEventListener(type: string, fn: (e: FakeEvent) => void): void {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)?.add(fn);
  }
  close(): void {
    this.closed = true;
  }
  emit(type: string, data?: string): void {
    for (const fn of this.listeners.get(type) ?? []) fn({ data });
  }
}

class FakeWindow extends EventTarget {
  readonly localStorage = {
    getItem: (_key: string): string | null => null,
    setItem: (_key: string, _value: string): void => undefined,
    removeItem: (_key: string): void => undefined,
  };
  readonly location = { assign: (_url: string): void => undefined };
}

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const realWindow = (globalThis as { window?: unknown }).window;

function installFakes(): void {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
  (globalThis as { window?: unknown }).window = new FakeWindow();
}

function restoreFakes(): void {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  (globalThis as { window?: unknown }).window = realWindow;
}

test("trackJob:登记自定义 label → progress 事件驱动百分比 → done 终态清除", async () => {
  installFakes();
  try {
    const res: GenerateResponse = { prompt_id: "bus-ok", client_id: "c1", worker: "w1", seed: 1 };
    const p = trackJob(res, {
      label: "测试引擎",
      timeoutMs: 5_000,
      onProgress: () => undefined,
    });
    let snap = getSnapshot();
    assert.equal(snap.length, 1, "进入即登记");
    assert.equal(snap[0].id, "bus-ok");
    assert.equal(snap[0].label, "测试引擎");
    assert.equal(snap[0].pct, null, "排队期 indeterminate");

    const es = FakeEventSource.instances[0];
    es.emit("open");
    es.emit("progress", JSON.stringify({ value: 0, max: 0 }));
    assert.equal(getSnapshot()[0].pct, null, "max=0 排队态保持 indeterminate");
    es.emit("progress", JSON.stringify({ value: 5, max: 10 }));
    assert.equal(getSnapshot()[0].pct, 50, "真进度透传");

    es.emit("done", JSON.stringify({ images: ["out/x.png"] }));
    assert.deepEqual(await p, ["out/x.png"]);
    assert.equal(getSnapshot().length, 0, "done 后任务清除");
  } finally {
    restoreFakes();
  }
});

test("trackJob:缺省 label「生成」;业务 error 终态清除任务", async () => {
  installFakes();
  try {
    const res: GenerateResponse = { prompt_id: "bus-err", client_id: "c1", worker: "w1", seed: 1 };
    const p = trackJob(res, { timeoutMs: 5_000 });
    assert.equal(getSnapshot()[0]?.label, "生成");
    const rejection = assert.rejects(p, /显存不足/);
    FakeEventSource.instances[0].emit("error", JSON.stringify({ message: "显存不足" }));
    await rejection;
    assert.equal(getSnapshot().length, 0, "error 后任务清除");
  } finally {
    restoreFakes();
  }
});

test("trackJob:不传 onProgress 也广播真实进度到总线(二期遗留清零)", async () => {
  installFakes();
  try {
    const res: GenerateResponse = { prompt_id: "bus-nocallback", client_id: "c1", worker: "w1", seed: 1 };
    // 不传 onProgress:此前 progress 事件整体 return,总线永远 indeterminate
    const p = trackJob(res, { label: "无回调引擎", timeoutMs: 5_000 });
    const es = FakeEventSource.instances[0];
    es.emit("open");
    es.emit("progress", JSON.stringify({ value: 3, max: 10 }));
    assert.equal(getSnapshot()[0]?.pct, 30, "无 onProgress 回调总线仍显真实进度");
    es.emit("done", JSON.stringify({ images: ["out/y.png"] }));
    assert.deepEqual(await p, ["out/y.png"]);
    assert.equal(getSnapshot().length, 0);
  } finally {
    restoreFakes();
  }
});

/* ── ⑧ effects.css 源码断言 ── */
test("effects.css:global-progress 样式存在且新增区零 hex", () => {
  const cssPath = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../app/styles/effects.css",
  );
  const css = readFileSync(cssPath, "utf8");
  assert.ok(css.includes(".global-progress {"), "轨道类存在");
  assert.ok(css.includes(".global-progress-fill.is-indeterminate"), "不确定态类存在");
  assert.ok(css.includes(".global-progress-pill {"), "胶囊类存在");
  assert.ok(css.includes("@keyframes global-progress-slide"), "滑动关键帧存在");
  // 新增区(标记注释至文末)零 hex 颜色字面值
  const sectionStart = css.indexOf("全局生成进度条");
  assert.ok(sectionStart > 0, "新增区标记注释存在");
  const section = css.slice(sectionStart);
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(section), "新增区不允许 hex 字面值");
  // 动效时长走 token
  assert.ok(
    section.includes("animation: global-progress-slide var(--duration-loop)"),
    "滑动动画时长走 --duration-loop token",
  );
});
