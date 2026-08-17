/**
 * 时长按秒选择(2026-08-16)web 侧单测(node:test + fetch 桩 + react-dom/server):
 * ① engines.ts payload:SFW(ltx25/h3)与 R18(ltx-2.3/h3)引擎时长一律直传
 *    duration_sec(秒),不再前端换算帧数(旧 _ltxNsfwLength/_H3_NSFW_DURATION_FRAMES 已删);
 * ② ParamField:number 类型小数步进(step=0.5)与 hint 渲染;
 * ③ ResultPanel:条目带 duration_notice 时渲染一行 muted 提示(stage-message)。
 */
import assert from "node:assert/strict";
import { beforeEach, test } from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { ParamField } from "../components/generate/ParamField";
import { ResultPanel, type HistoryEntry } from "../components/generate/ResultPanel";
import { submitEngineGeneration, type EngineInfo } from "../lib/engines";

const h = React.createElement;

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

function _engine(id: string, label: string): EngineInfo {
  return { id, label, kind: "video", available: true, nsfw: false, params: [] };
}

/* ── ① payload 直传秒 ── */

test("ltx25-t2v payload:duration 秒数直传 duration_sec,无 length 帧数", async () => {
  await submitEngineGeneration({
    engine: _engine("ltx25-t2v", "LTX 2.5 文生视频"),
    positive: "海边日落",
    values: { duration: "7.5", width: "960", height: "544", fps: "24", steps: "8", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  // API_BASE 在模块加载期定型(测试环境 localhost:8090),断言路径尾部(同 videoUpscale 惯例)
  assert.ok(fetchCalls[0].url.endsWith("/api/ltx25/t2v"));
  assert.equal(body.duration_sec, 7.5);
  assert.equal("length" in body, false);
});

test("h3-t2v payload:duration 秒数直传 duration_sec,无 length", async () => {
  await submitEngineGeneration({
    engine: _engine("h3-t2v", "MiniMax H3 文生视频"),
    positive: "一只猫",
    values: { duration: "20", width: "1344", height: "768", steps: "20", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/t2v"));
  assert.equal(body.duration_sec, 20);
  assert.equal("length" in body, false);
});

test("h3-nsfw-t2v payload:R18 时长预设(秒)直传 duration_sec,分辨率预设换算宽高", async () => {
  await submitEngineGeneration({
    engine: _engine("h3-nsfw-t2v", "MiniMax H3 文生视频(R18)"),
    positive: "nsfw",
    values: { duration: "8", resolution: "1280x736", steps: "20", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/h3/t2v"));
  assert.equal(body.duration_sec, 8);
  assert.equal(body.width, 1280);
  assert.equal(body.height, 736);
  assert.equal("length" in body, false);
});

test("ltx-nsfw-t2v payload:R18 时长预设(秒)直传 duration_sec,无 8k+1 前端换算", async () => {
  await submitEngineGeneration({
    engine: _engine("ltx-nsfw-t2v", "LTX 2.3 文生视频(R18)"),
    positive: "nsfw",
    values: { duration: "10", resolution: "720x1280", fps: "16", steps: "20", cfg: "1", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/generate/ltx-t2v"));
  assert.equal(body.duration_sec, 10);
  // 旧行为是 length=161(10s×16fps 吸附 8k+1);现在由后端统一策略层负责
  assert.equal("length" in body, false);
});

/* ── ①b longcat/wan 秒数化(2026-08-17 收口):duration 直传 duration_sec,无 num_frames ── */

test("longcat-t2v payload:duration 秒数直传 duration_sec,无 num_frames", async () => {
  await submitEngineGeneration({
    engine: _engine("longcat-t2v", "LongCat 文生视频"),
    positive: "城市航拍",
    values: { duration: "12.5", width: "832", height: "480", fps: "16", steps: "10", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/longcat/t2v"));
  assert.equal(body.duration_sec, 12.5);
  assert.equal("num_frames" in body, false);
});

test("longcat-continue payload:缺省 duration 回落默认 7.5s", async () => {
  await submitEngineGeneration({
    engine: _engine("longcat-continue", "LongCat 视频续写"),
    positive: "继续",
    values: { video: "/api/images?path=x.mp4", width: "832", height: "480", fps: "16", steps: "10", seed: "" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/longcat/continue"));
  assert.equal(body.duration_sec, 7.5);
  assert.equal("num_frames" in body, false);
});

test("wan-animate payload:duration 秒数直传 duration_sec,无 num_frames", async () => {
  await submitEngineGeneration({
    engine: _engine("wan-animate", "Wan2.2 动作迁移"),
    positive: "角色打拳",
    values: { duration: "10", width: "832", height: "480", fps: "16", steps: "6", seed: "" },
    refImage: { filename: "ref.png", worker: "http://w" },
    refVideo: { filename: "drive.mp4", worker: "http://w" },
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/wan/animate"));
  assert.equal(body.duration_sec, 10);
  assert.equal("num_frames" in body, false);
});

test("wan-vace payload:缺省 duration 回落默认 5s,多参考图透传", async () => {
  await submitEngineGeneration({
    engine: _engine("wan-vace", "VACE 多参考视频"),
    positive: "海边",
    values: { width: "832", height: "480", fps: "16", steps: "20", seed: "" },
    refImages: [{ filename: "r1.png", worker: "http://w" }],
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.ok(fetchCalls[0].url.endsWith("/api/wan/vace"));
  assert.equal(body.duration_sec, 5);
  assert.deepEqual(body.images, ["r1.png"]);
  assert.equal("num_frames" in body, false);
});

/* ── ② ParamField:number 小数步进 + hint ── */

test("ParamField number:step=0.5 与 hint 渲染(秒数输入允许小数)", () => {
  const html = renderToStaticMarkup(
    h(ParamField, {
      param: {
        key: "duration", label: "时长(秒)", type: "number",
        min: 0.5, max: 60, step: 0.5, default: 5,
        hint: "支持任意时长;超上限自动分段续写并精确裁切",
      },
      value: "5",
      onChange: () => undefined,
    }),
  );
  assert.match(html, /type="number"/);
  assert.match(html, /step="0.5"/);
  assert.match(html, /min="0.5"/);
  assert.match(html, /max="60"/);
  assert.match(html, /支持任意时长/);
});

/* ── ③ ResultPanel notice 显示 ── */

function _entry(notice: string | null): HistoryEntry {
  return {
    id: "e1",
    engineId: "h3-t2v",
    engineLabel: "MiniMax H3 文生视频",
    kind: "video",
    prompt: "一只猫",
    status: "running",
    paths: [],
    notice,
    createdAt: Date.now(),
  };
}

test("ResultPanel:有 duration_notice 时渲染一行 muted 提示,无则不渲染", () => {
  const withNotice = renderToStaticMarkup(
    h(ResultPanel, {
      entries: [_entry("超过单段上限(约 15 秒),已自动分 2 段续写,生成后精确裁至 20 秒")],
      selectedId: "e1",
      onSelect: () => undefined,
      liveProgress: { value: 1, max: 8 },
      onCancel: () => undefined,
    }),
  );
  assert.match(withNotice, /stage-message/);
  assert.match(withNotice, /已自动分 2 段续写/);

  const without = renderToStaticMarkup(
    h(ResultPanel, {
      entries: [_entry(null)],
      selectedId: "e1",
      onSelect: () => undefined,
      liveProgress: { value: 1, max: 8 },
      onCancel: () => undefined,
    }),
  );
  assert.equal(without.includes("stage-message"), false);
});
