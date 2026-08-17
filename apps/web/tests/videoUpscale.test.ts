/**
 * 视频超分(4K)前端单测(node:test):
 * ① api 函数载荷:upscaleVideo / getVideoUpscaleStatus 的 URL / 方法 / body / 鉴权头(fetch 桩)
 * ② 作品库类目:video_upscale 进视频桶 + 中文短名「视频超分」
 * ③ 操作入口源码断言:视频卡「超分到 4K」按钮 / 确认 Modal 耗时说明 / generationBus 上报
 *   (LibraryView 经 loader 映射 @/lib/api → mocks/studioApi.ts;SSR 首渲为骨架,
 *    卡片按钮走源码结构断言,与 libraryViews.test.ts ⑦ 同款)
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, beforeEach, test } from "node:test";

import { getVideoUpscaleStatus, upscaleVideo } from "../lib/api";
import { applyLibraryQuery, DEFAULT_LIBRARY_QUERY, kindLabel, kindToFilter } from "../lib/libraryQuery";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

interface FetchCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

let fetchCalls: FetchCall[] = [];
let responds: { status: number; body: unknown }[] = [];

const realFetch = globalThis.fetch;
const realWindow = (globalThis as { window?: unknown }).window;

beforeEach(() => {
  fetchCalls = [];
  responds = [];
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
      headers: (init?.headers ?? {}) as Record<string, string>,
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
  const g = globalThis as { window?: unknown };
  if (realWindow === undefined) delete g.window;
  else g.window = realWindow;
});

/* ── ① api 函数载荷 ── */

test("upscaleVideo:POST /api/video/upscale,body 带 video_url+target,auth 头正确", async () => {
  responds.push({
    status: 200,
    body: { job_id: "j1", prompt_id: "video-upscale-x", kind: "video_upscale", status: "queued", target: "4k" },
  });
  const res = await upscaleVideo({ video_url: "/api/images?filename=v.mp4&worker=http://w" });
  assert.equal(fetchCalls.length, 1);
  const call = fetchCalls[0];
  // API_BASE 在模块加载期定型(测试环境为 localhost:8090),断言路径尾部
  assert.ok(call.url.endsWith("/api/video/upscale"));
  assert.equal(call.method, "POST");
  assert.equal(call.headers["Authorization"], "Bearer tok-test");
  assert.deepEqual(call.body, {
    video_url: "/api/images?filename=v.mp4&worker=http://w",
    target: "4k", // 缺省档位自动补 4k
  });
  assert.equal(res.job_id, "j1");
  assert.equal(res.kind, "video_upscale");
});

test("upscaleVideo:后端 detail 原样透出(如 fleet 503)", async () => {
  responds.push({ status: 503, body: { detail: "超分引擎暂不可用(fleet 无在线实例)" } });
  await assert.rejects(
    () => upscaleVideo({ video_url: "/api/drama/output/drama-x.mp4" }),
    /超分引擎暂不可用/,
  );
});

test("getVideoUpscaleStatus:GET 轮询端点,jobId 编码进路径", async () => {
  responds.push({
    status: 200,
    body: {
      job_id: "j1",
      prompt_id: "video-upscale-x",
      status: "running",
      results: [],
      progress: { stage: "upscaling", done: 30, total: 100, pct: 30, detail: "" },
    },
  });
  const st = await getVideoUpscaleStatus("j1");
  assert.ok(fetchCalls[0].url.endsWith("/api/video/upscale/j1"), "jobId 编码进路径");
  assert.equal(fetchCalls[0].method, "GET");
  assert.equal(fetchCalls[0].headers["Authorization"], "Bearer tok-test");
  assert.equal(st.progress?.pct, 30);
  assert.equal(st.status, "running");
});

/* ── ② 作品库类目 ── */

function makeJob(id: string, over: Partial<JobItem> = {}): JobItem {
  return {
    id,
    prompt_id: `p-${id}`,
    kind: "video_upscale",
    status: "done",
    prompt: "",
    seed: 0,
    created_at: "2026-08-16T00:00:00Z",
    results: [`/api/video/upscale/output/upscale-${"a".repeat(32)}.mp4`],
    ...over,
  };
}

test("video_upscale 进视频筛选桶 + 中文短名「视频超分」", () => {
  assert.equal(kindToFilter("video_upscale"), "video");
  assert.equal(kindLabel("video_upscale"), "视频超分");
  const jobs = [makeJob("up"), makeJob("img", { kind: "txt2img", results: ["x.png"] })];
  const videos = applyLibraryQuery(jobs, { ...DEFAULT_LIBRARY_QUERY, filter: "video" });
  assert.deepEqual(videos.map((j) => j.id), ["up"]);
});

/* ── ③ 操作入口源码断言(LibraryView 结构锚点) ── */

test("LibraryView:视频卡操作组挂「超分到 4K」+ 确认 Modal + generationBus 上报", () => {
  const src = readFileSync(join(webRoot, "components/library/LibraryView.tsx"), "utf-8");
  // 按钮:仅视频产物卡渲染、超分产物自身排除、busy 态
  assert.match(src, /title="超分到 4K"/);
  assert.match(src, /job\.kind !== "video_upscale"/);
  assert.match(src, /upscalingId === job\.id/);
  // 确认流:Modal 说明耗时与产物去向
  assert.match(src, /超分到 4K/);
  assert.match(src, /1-2 分钟\/10 秒片/);
  assert.match(src, /handleConfirmUpscale/);
  // api 调用与轮询
  assert.match(src, /upscaleVideo\(\{ video_url: src, target: "4k" \}\)/);
  assert.match(src, /getVideoUpscaleStatus\(jobId\)/);
  // 全局进度条:开始/进度/结束三件套
  assert.match(src, /genBegin\(taskId, "视频超分到 4K"\)/);
  assert.match(src, /genProgress\(taskId, st\.progress\.pct\)/);
  assert.match(src, /genEnd\(taskId\)/);
  // 完成后刷新作品库(新产物自动收录)
  assert.match(src, /invalidateJobs\(\)/);
});

test("api.ts:超分函数挂载点存在(链接期契约)", () => {
  const src = readFileSync(join(webRoot, "lib/api.ts"), "utf-8");
  assert.match(src, /export async function upscaleVideo/);
  assert.match(src, /export async function getVideoUpscaleStatus/);
  assert.match(src, /\/api\/video\/upscale/);
});
