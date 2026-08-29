/**
 * 画布公网混合内容根治(2026-08-30)前端单测:
 * ① buildCandidates:自定义优先,Tailscale → LAN 兜底顺序不变(HTTP 页直连策略保持);
 * ② planCanvasSrc:HTTPS 页面 + 全 http 候选 → 同源 /api/canvas/proxy(根治点);
 *    HTTPS 页面存在 https 候选 → 仅保留 https 直连;HTTP 页面 → 原顺序直连;
 * ③ withToken:仅同源代理路径附 ?token=(iframe/script 无法带 Authorization 头);
 * ④ CanvasView 源码断言:失败态不再渲染内网 IP/直连地址,通用「服务连接失败」+ 重试。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  buildCandidates,
  CANVAS_PROXY_PATH,
  COMFYUI_URL,
  COMFYUI_URL_LAN,
  planCanvasSrc,
  withToken,
} from "../components/canvas/canvasUrl";

const testDir = dirname(fileURLToPath(import.meta.url));

function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf-8");
}

/* ── ① 候选列表 ── */

test("buildCandidates:默认 Tailscale → LAN 顺序", () => {
  assert.deepEqual(buildCandidates(null), [COMFYUI_URL, COMFYUI_URL_LAN]);
});

test("buildCandidates:自定义地址置顶;与默认重复不重复入列", () => {
  assert.deepEqual(buildCandidates("https://comfy.example.com"), [
    "https://comfy.example.com",
    COMFYUI_URL,
    COMFYUI_URL_LAN,
  ]);
  assert.deepEqual(buildCandidates(COMFYUI_URL), [COMFYUI_URL, COMFYUI_URL_LAN]);
});

/* ── ② HTTPS 场景决策(根治点) ── */

test("planCanvasSrc:HTTP 页面 → 原顺序直连(局域网策略不变)", () => {
  const plan = planCanvasSrc("http:", [COMFYUI_URL, COMFYUI_URL_LAN]);
  assert.deepEqual(plan, { mode: "direct", candidates: [COMFYUI_URL, COMFYUI_URL_LAN] });
});

test("planCanvasSrc:HTTPS 页面 + 全 http 候选 → 同源代理", () => {
  const plan = planCanvasSrc("https:", [COMFYUI_URL, COMFYUI_URL_LAN]);
  assert.deepEqual(plan, { mode: "proxy", src: CANVAS_PROXY_PATH });
  assert.equal(CANVAS_PROXY_PATH, "/api/canvas/proxy");
});

test("planCanvasSrc:HTTPS 页面 + https 自定义候选 → 仅 https 直连,不走代理", () => {
  const plan = planCanvasSrc("https:", [
    "https://comfy.example.com",
    COMFYUI_URL,
    COMFYUI_URL_LAN,
  ]);
  assert.deepEqual(plan, { mode: "direct", candidates: ["https://comfy.example.com"] });
});

/* ── ③ 代理路径附带 token ── */

test("withToken:同源代理路径附 ?token=;直连地址不动", () => {
  assert.equal(
    withToken("/api/canvas/proxy", "jwt-1"),
    "/api/canvas/proxy?token=jwt-1",
  );
  assert.equal(
    withToken("/api/canvas/proxy?probe=1", "jwt 1"),
    "/api/canvas/proxy?probe=1&token=jwt%201",
  );
  assert.equal(withToken("http://100.68.100.90:8188", "jwt-1"), "http://100.68.100.90:8188");
  assert.equal(withToken("/api/canvas/proxy", null), "/api/canvas/proxy");
});

/* ── ④ 失败态不泄露内网地址(源码断言) ── */

test("CanvasView:失败态无内网 IP/直连地址,通用「服务连接失败」+ 重试", () => {
  const src = readSrc("components/canvas/CanvasView.tsx");
  for (const ip of ["100.68.100.90", "192.168.71.127", "100.77.80.100"]) {
    assert.ok(!src.includes(ip), `CanvasView 仍硬编码/展示内网地址 ${ip}`);
  }
  assert.ok(!src.includes("以下地址均未连通"), "失败态仍渲染直连地址清单");
  assert.ok(src.includes("画布服务连接失败"), "缺通用失败文案");
  assert.ok(src.includes("planCanvasSrc"), "未接入代理决策");
});
