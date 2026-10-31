/**
 * useGeneration 单测(node:test + 极简 renderHook,无 DOM):
 * ① 正常完成:done → status=done + resultPaths 写入(start resolve)
 * ② 回归:跟踪中 reset()(用户取消)→ trackJob 立即 settle,start 不再永久挂起,
 *    status 保持 idle 且不误标 error —— 此前只 close EventSource,Promise 永不
 *    落定,视图层 `await gen.start()` 卡死,submitting 无法复位(按钮永远转圈)
 * ③ 卸载兜底:unmount 中止未完成跟踪,start settle 且不触发卸载后 setState
 * EventSource 用假实现(与 trackJob.test.ts 同款);window/localStorage 供 api.ts。
 */
import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";

import { useGeneration, type UseGenerationResult } from "../lib/useGeneration";
import type { GenerateResponse } from "../lib/types";
import { flush, renderHook, type HookHandle } from "./helpers/renderHook";

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

const RES: GenerateResponse = { prompt_id: "pid-ug", client_id: "c1", worker: "w1", seed: 1 };

const realEventSource = (globalThis as { EventSource?: unknown }).EventSource;
const realWindow = (globalThis as { window?: unknown }).window;

/** 最小 window 替身:EventTarget 提供事件收发(trackJob 挂/摘 SESSION_EXPIRED_EVENT 监听);
 *  localStorage 供 api.ts 鉴权头使用。 */
class FakeWindow extends EventTarget {
  readonly localStorage = {
    getItem: (k: string): string | null => (k === "toiv_token" ? "tok-test" : null),
    setItem: (): void => undefined,
    removeItem: (): void => undefined,
  };
}

beforeEach(() => {
  FakeEventSource.instances = [];
  (globalThis as { EventSource?: unknown }).EventSource =
    FakeEventSource as unknown as typeof EventSource;
  (globalThis as { window?: unknown }).window = new FakeWindow();
});

after(() => {
  (globalThis as { EventSource?: unknown }).EventSource = realEventSource;
  (globalThis as { window?: unknown }).window = realWindow;
});

function renderGen(): HookHandle<UseGenerationResult> {
  return renderHook(() => useGeneration({}));
}

test("① 正常完成:done 事件 → start resolve,status=done 且产物写入", async () => {
  const h = renderGen();
  const p = h.result.current!.start(RES, { label: "测试" });
  await flush();
  assert.equal(h.result.current!.status, "running");

  const es = FakeEventSource.instances[0];
  es.emit("open");
  es.emit("done", JSON.stringify({ images: ["out/a.png"] }));

  await p;
  await flush();
  assert.equal(h.result.current!.status, "done");
  assert.deepEqual(h.result.current!.resultPaths, ["out/a.png"]);
  assert.equal(h.result.current!.error, null);
  h.unmount();
});

test("② 回归:跟踪中 reset() → start 立即 settle(不再卡死),status 回 idle 且不标 error", async () => {
  const h = renderGen();
  const p = h.result.current!.start(RES);
  await flush();
  assert.equal(h.result.current!.isRunning, true, "进入 running 态");

  // 用户点「取消」:此前仅 close EventSource,trackJob Promise 永不定,
  // await start 永久挂起(视图 finally 里的 setSubmitting(false) 跑不到)
  h.result.current!.reset();

  await p; // 修复前:此行永远等不到(测试会挂到超时)
  await flush();
  const cur = h.result.current!;
  assert.equal(cur.status, "idle", "reset 后回到 idle");
  assert.equal(cur.error, null, "用户主动取消不得误标 error");
  assert.equal(cur.isRunning, false);
  assert.equal(FakeEventSource.instances[0].closed, true, "EventSource 已关闭");
  h.unmount();
});

test("③ 卸载兜底:unmount 中止未完成跟踪,start settle 且不炸(卸载后 setState 被 guard)", async () => {
  const h = renderGen();
  const p = h.result.current!.start(RES);
  await flush();
  assert.equal(FakeEventSource.instances.length, 1);

  h.unmount(); // 组件卸载:cleanup 里 abort → trackJob 立即 settle
  await p; // 修复前:挂起;现在:正常返回
  assert.equal(FakeEventSource.instances[0].closed, true);
});
