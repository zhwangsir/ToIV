/**
 * 「服务唤醒中」UX 单测(node:test + 自制 renderHook + 源码断言):
 * ① listOrchServices / wakeService API 封装契约
 * ② parseWakeError 捕获 503「冷层服务 {name} 唤醒失败」模式
 * ③ useOrchStatus 轮询(10s,聚焦时)与 isWaking/statusOf
 * ④ ServiceWakeOverlay 源码结构(waking 态全部视觉元素)
 * ⑤ ServiceWakeOverlay 源码错误态(ErrorBar + 手动唤醒按钮)
 * ⑥ ServiceWakeOverlay props 接口与导出
 * ⑦ ServiceWakeOverlay 样式 token 零 hex(源码断言)
 * @/lib/api 经 tests/loader.mjs 映射到 mocks/studioApi 可控替身。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { after, beforeEach, test } from "node:test";

import { flush, renderHook } from "./helpers/renderHook";
import {
  isWakeError,
  listOrchServices,
  ORCH_SERVICE_LABELS,
  parseWakeError,
  useOrchStatus,
  wakeService,
} from "../lib/orch";
import { ServiceWakeOverlay } from "../components/orch/ServiceWakeOverlay";

// ── fetch 桩:apiFetch 底层 ────────────────────────────────────────
const realFetch = globalThis.fetch;
let fetchCalls: string[] = [];
let fetchResponses: Array<{ url: string; status: number; body: unknown }> = [];

function pushResponse(url: string, status: number, body: unknown) {
  fetchResponses.push({ url, status, body });
}

function installFetch() {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    fetchCalls.push(url);
    const r = fetchResponses.find((f) => url.includes(f.url));
    if (!r) return new Response("{}", { status: 404 });
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

function restoreFetch() {
  globalThis.fetch = realFetch;
}

beforeEach(() => {
  fetchCalls = [];
  fetchResponses = [];
  installFetch();
  // api.ts 的 authHeaders/getToken 读 window.localStorage,Node 环境必须补
  const g = globalThis as Record<string, unknown>;
  g.window ??= globalThis;
  (g.window as Record<string, unknown>).localStorage = {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
    clear: () => undefined,
  };
});

after(() => {
  restoreFetch();
  // 兜底清掉任何在途定时器(防测试间泄漏)
  const g = globalThis as Record<string, unknown>;
  if (typeof g._orchTimers === "object" && Array.isArray(g._orchTimers)) {
    for (const t of g._orchTimers) clearTimeout(t);
    g._orchTimers = [];
  }
});

// ── ① API 封装契约 ───────────────────────────────────────────────

test("① listOrchServices 解析 dict 与 list 两种形态;wakeService POST 契约", async () => {
  // dict 形态
  pushResponse("/api/orch/services", 200, {
    services: {
      lipsync: { name: "lipsync", status: "running", wake_count: 1 },
      trainer: { name: "trainer", status: "sleeping" },
    },
  });
  const dictRes = await listOrchServices();
  assert.equal(dictRes.lipsync.status, "running");
  assert.equal(dictRes.trainer.status, "sleeping");
  assert.equal(dictRes.trainer.name, "trainer");

  // list 形态
  fetchResponses = [];
  pushResponse("/api/orch/services", 200, {
    services: [{ name: "hy3dtex", status: "error", last_error: "timeout" }],
  });
  const listRes = await listOrchServices();
  assert.equal(listRes.hy3dtex.status, "error");
  assert.equal(listRes.hy3dtex.last_error, "timeout");

  // wake POST
  fetchResponses = [];
  pushResponse("/api/orch/services/lipsync/wake", 200, { status: "waking" });
  const wakeRes = await wakeService("lipsync");
  assert.equal(wakeRes.status, "waking");
  assert.ok(
    fetchCalls.some((c) => c.includes("/api/orch/services/lipsync/wake")),
    "POST wake 端点",
  );
});

// ── ② parseWakeError ─────────────────────────────────────────────

test("② parseWakeError 捕获 503 冷层唤醒失败模式", () => {
  assert.equal(
    parseWakeError(new Error("冷层服务 lipsync 唤醒失败:systemctl start toiv-lipsync 失败")),
    "lipsync",
  );
  assert.equal(parseWakeError(new Error("trainer 服务未就绪")), "trainer");
  assert.equal(parseWakeError(new Error("i2l 正在 waking")), "i2l");
  assert.equal(parseWakeError(new Error("not ready: hy3dtex")), "hy3dtex");
  assert.equal(parseWakeError(new Error("普通网络错误")), null);
  assert.equal(parseWakeError(null), null);
  assert.ok(isWakeError(new Error("冷层服务 lipsync 唤醒失败")));
  assert.ok(!isWakeError(new Error("503")));
});

// ── ③ useOrchStatus hook 轮询 ─────────────────────────────────────

test("③ useOrchStatus 轮询 10s;isWaking/statusOf 反映状态;403 停止轮询", async () => {
  // 提供最小 window 替身(renderHook 会跑 effect 里的 setTimeout)
  const origWindow = (globalThis as { window?: unknown }).window;
  (globalThis as { window?: unknown }).window = globalThis;
  // api.ts 顶层 API_BASE 已被其他测试固化;fetch 桩用 includes 匹配,空路径也命中
  pushResponse("orch/services", 200, {
    services: { lipsync: { name: "lipsync", status: "waking" } },
  });

  const h = renderHook(() => useOrchStatus());
  await flush();
  // 异步 fetch + setState 重渲染可能跨多个微任务,给 50ms 兜底
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h.result.current?.services?.lipsync?.status, "waking", `fetchCalls=${fetchCalls.join(",")}`);
  assert.equal(h.result.current?.isWaking("lipsync"), true);
  assert.equal(h.result.current?.isWaking("trainer"), false);
  assert.equal(h.result.current?.statusOf("lipsync"), "waking");
  assert.equal(h.result.current?.statusOf("unknown"), null);

  // 403 → canPoll=false
  fetchResponses = [];
  pushResponse("/api/orch/services", 403, { detail: "Forbidden" });
  const h2 = renderHook(() => useOrchStatus());
  await flush();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(h2.result.current?.canPoll, false);

  h.unmount();
  h2.unmount();
  (globalThis as { window?: unknown }).window = origWindow;
});

function getOverlaySrc(): string {
  return readFileSync(
    path.join(path.dirname(new URL(import.meta.url).pathname), "../components/orch/ServiceWakeOverlay.tsx"),
    "utf-8",
  );
}

// ── ④ ServiceWakeOverlay 源码结构(waking 态) ─────────────────────

test("④ ServiceWakeOverlay 源码包含 waking 态全部视觉元素", () => {
  const src = getOverlaySrc();
  assert.ok(src.includes("sw-overlay"), "遮罩层 class");
  assert.ok(src.includes("sw-card"), "卡片 class");
  assert.ok(src.includes("正在唤醒"), "唤醒文案");
  assert.ok(src.includes("首次调用可能需要 1-2 分钟"), "预计提示");
  assert.ok(src.includes("sw-progress-bar"), "进度条 class");
  assert.ok(src.includes("sw-cancel"), "取消按钮 class");
  assert.ok(src.includes("onCancel"), "onCancel prop 消费");
  assert.ok(!src.includes("手动唤醒") || src.includes('isError'), "手动唤醒仅在 error 态");
});

// ── ⑤ Overlay 错误态源码 ─────────────────────────────────────────

test("⑤ ServiceWakeOverlay 源码包含 error 态全部视觉元素", () => {
  const src = getOverlaySrc();
  assert.ok(src.includes("sw-overlay"), "遮罩层 class");
  assert.ok(src.includes("唤醒失败"), "错误文案");
  assert.ok(src.includes("手动唤醒"), "手动唤醒按钮文案");
  assert.ok(src.includes("ErrorBar"), "ErrorBar 组件引用");
  assert.ok(src.includes("ui-error-bar"), "ErrorBar 样式类");
  assert.ok(src.includes("sw-wake-btn"), "手动唤醒按钮 class");
});

// ── ⑥ Overlay props 接口与导出 ────────────────────────────────────

test("⑥ ServiceWakeOverlay 是函数组件且接受预期 props", () => {
  assert.equal(typeof ServiceWakeOverlay, "function", "导出一个函数组件");
  const src = getOverlaySrc();
  assert.ok(src.includes("serviceName"), "接受 serviceName prop");
  assert.ok(src.includes("visible"), "接受 visible prop");
  assert.ok(src.includes("onCancel"), "接受 onCancel prop");
  assert.ok(src.includes("onClose"), "接受 onClose prop");
});

// ── ⑦ 样式 token 零 hex ──────────────────────────────────────────

test("⑦ ServiceWakeOverlay 源码零 hex,全部走 token", () => {
  const overlaySrc = getOverlaySrc();
  // 零硬编码 hex(#rrggbb / #rgb 形式;token 引用 var(--*) 不含 #)
  const hexMatches = overlaySrc.match(/#[0-9a-fA-F]{3,8}/g) ?? [];
  assert.equal(hexMatches.length, 0, `零 hex 要求:${hexMatches.join(",")}`);
  // 关键 token 引用
  assert.ok(overlaySrc.includes("var(--overlay-light)"), "遮罩用 --overlay-light");
  assert.ok(overlaySrc.includes("var(--bg-surface-1)"), "卡片背景用 --bg-surface-1");
  assert.ok(overlaySrc.includes("var(--accent-soft)"), "图标背景用 --accent-soft");
  assert.ok(overlaySrc.includes("var(--radius-panel)"), "圆角用 --radius-panel");
  assert.ok(overlaySrc.includes("var(--shadow-float)"), "阴影用 --shadow-float");
  assert.ok(overlaySrc.includes("var(--z-modal)"), "z-index 用 --z-modal");
  assert.ok(overlaySrc.includes("var(--ease-standard)"), "缓动用 --ease-standard");
  assert.ok(overlaySrc.includes("300ms"), "动画时长 300ms(≤320ms)");
});
