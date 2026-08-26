/**
 * VACE 视频到视频编辑(Runway Aleph 式 in-context)前端单测(node:test + fetch 桩):
 * ① timeToFrameIndex:播放时刻 → 输出帧索引(fps 帧空间,0 基)
 * ② toggleKeyframe:锚点切换(添加升序/移除/超上限不动)
 * ③ parseKeyframeIndices:手工输入解析(排序去重/非法抛错/超上限抛错)
 * ④ editSubmittable 提交门控:源视频/指令/时长/关键帧上限/busy
 * ⑤ submitVideoEdit:路由 /api/generate/video-edit,载荷契约(source_video/edit_prompt/
 *   edit_mode/keyframe_indices/preserve_mask/worker/seed);mask 异 worker 拦截;422 展开
 * ⑥ editJobProgress:作业状态推导(done 出片/error/held/pending)
 * ⑦ AiVideoEditView 源码断言:模式下拉/标记当前帧/作品库/并排对比;
 *    GenerateView 引擎接线;libraryQuery:video_edit 归视频桶,短名「视频编辑」
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { beforeEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  EDIT_MAX_DURATION_SEC,
  EDIT_MAX_KEYFRAMES,
  EDIT_MODES,
  editJobProgress,
  editSubmittable,
  isEditMode,
  parseKeyframeIndices,
  submitVideoEdit,
  timeToFrameIndex,
  toggleKeyframe,
} from "../lib/videoEdit";
import { kindLabel, kindToFilter } from "../lib/libraryQuery";
import type { JobItem } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

// ── ① 播放时刻 → 帧索引 ────────────────────────────────────────────────────

test("① timeToFrameIndex:floor(秒×fps),0 基;非法输入归 0", () => {
  assert.equal(timeToFrameIndex(0, 16), 0);
  assert.equal(timeToFrameIndex(2.5, 16), 40);
  assert.equal(timeToFrameIndex(4.99, 16), 79);
  assert.equal(timeToFrameIndex(-1, 16), 0);
  assert.equal(timeToFrameIndex(2.5, 0), 0);
  assert.equal(timeToFrameIndex(Number.NaN, 16), 0);
});

// ── ② 锚点切换 ────────────────────────────────────────────────────────────

test("② toggleKeyframe:添加升序插入;重复则移除;超上限原样返回", () => {
  assert.deepEqual(toggleKeyframe([], 40), [40]);
  assert.deepEqual(toggleKeyframe([40, 80], 0), [0, 40, 80]);
  assert.deepEqual(toggleKeyframe([0, 40], 40), [0], "重复索引=取消锚点");
  const full = [0, 10, 20, 30, 40];
  assert.deepEqual(toggleKeyframe(full, 50), full, `满 ${EDIT_MAX_KEYFRAMES} 个不加新`);
  assert.deepEqual(toggleKeyframe(full, 20), [0, 10, 30, 40], "满员仍可移除");
});

// ── ③ 手工输入解析 ──────────────────────────────────────────────────────────

test("③ parseKeyframeIndices:逗号/空格分隔,排序去重;空串 → 空数组", () => {
  assert.deepEqual(parseKeyframeIndices(""), []);
  assert.deepEqual(parseKeyframeIndices("  "), []);
  assert.deepEqual(parseKeyframeIndices("80, 0, 40"), [0, 40, 80]);
  assert.deepEqual(parseKeyframeIndices("0, 40 80"), [0, 40, 80]);
  assert.deepEqual(parseKeyframeIndices("40,40,40"), [40]);
});

test("③ parseKeyframeIndices:负数/非整数/超上限 → 抛错", () => {
  assert.throws(() => parseKeyframeIndices("-1"), /非负整数/);
  assert.throws(() => parseKeyframeIndices("1.5"), /非负整数/);
  assert.throws(() => parseKeyframeIndices("abc"), /非负整数/);
  assert.throws(
    () => parseKeyframeIndices("0,1,2,3,4,5"),
    new RegExp(`最多 ${EDIT_MAX_KEYFRAMES}`),
  );
});

// ── ④ 提交门控 ────────────────────────────────────────────────────────────

const OK_INPUT = {
  hasVideo: true,
  editPrompt: "replace the car with a bicycle",
  durationSec: 5,
  keyframes: [0, 40],
  busy: false,
};

test("④ editSubmittable:合法输入通过", () => {
  assert.equal(editSubmittable(OK_INPUT), true);
  assert.equal(editSubmittable({ ...OK_INPUT, keyframes: [] }), true, "无锚点也可提交");
});

test("④ editSubmittable:缺视频/空指令/时长越界/锚点超上限/busy → 拦截", () => {
  assert.equal(editSubmittable({ ...OK_INPUT, hasVideo: false }), false, "缺源视频");
  assert.equal(editSubmittable({ ...OK_INPUT, editPrompt: "  " }), false, "空指令");
  assert.equal(editSubmittable({ ...OK_INPUT, durationSec: 0 }), false, "时长须 >0");
  assert.equal(
    editSubmittable({ ...OK_INPUT, durationSec: EDIT_MAX_DURATION_SEC + 0.5 }),
    false,
    `时长 ≤${EDIT_MAX_DURATION_SEC}s`,
  );
  assert.equal(
    editSubmittable({ ...OK_INPUT, keyframes: [0, 1, 2, 3, 4, 5] }),
    false,
    "锚点超上限",
  );
  assert.equal(editSubmittable({ ...OK_INPUT, busy: true }), false, "busy 态不可重复提交");
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
      JSON.stringify({ prompt_id: "edit-abc123", worker: "http://wan", seed: 42 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }) as typeof fetch;
});

process.on("exit", () => {
  globalThis.fetch = realFetch;
  (globalThis as { window?: unknown }).window = realWindow;
});

test("⑤ submitVideoEdit:路由与载荷契约(源视频/指令/模式/锚点/mask/worker/seed)", async () => {
  const res = await submitVideoEdit({
    sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
    editPrompt: "  make it anime style  ",
    editMode: "style_transfer",
    keyframeIndices: [0, 40],
    preserveMask: { filename: "keep.png", worker: "http://pool1" },
    width: 832,
    height: 480,
    durationSec: 5,
    steps: 20,
    cfg: 5,
    seed: 42,
  });
  assert.equal(res.prompt_id, "edit-abc123");
  assert.equal(fetchCalls.length, 1, "仅一次提交请求");
  assert.ok(
    fetchCalls[0].url.endsWith("/api/generate/video-edit"),
    "路由必须为 /api/generate/video-edit",
  );
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal(body.source_video, "src.mp4");
  assert.equal(body.edit_prompt, "make it anime style", "指令 trim 后下发");
  assert.equal(body.edit_mode, "style_transfer");
  assert.deepEqual(body.keyframe_indices, [0, 40]);
  assert.equal(body.preserve_mask, "keep.png");
  assert.equal(body.worker, "http://pool1");
  assert.equal(body.duration_sec, 5);
  assert.equal(body.seed, 42);
});

test("⑤ submitVideoEdit:缺省项不随负载下发(锚点/mask/时长/seed)", async () => {
  await submitVideoEdit({
    sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
    editPrompt: "relight to dusk",
    editMode: "relight",
  });
  const body = fetchCalls[0].body as Record<string, unknown>;
  assert.equal("keyframe_indices" in body, false, "无锚点不下发 keyframe_indices");
  assert.equal("preserve_mask" in body, false, "无 mask 不下发 preserve_mask");
  assert.equal("duration_sec" in body, false, "未给时长不下发(后端默认)");
  assert.equal("seed" in body, false, "未给 seed 不下发");
});

test("⑤ submitVideoEdit:缺视频/空指令/未知模式/mask 异 worker → 提交前拦截,不发请求", async () => {
  await assert.rejects(
    submitVideoEdit({
      sourceVideo: { filename: "", worker: "http://pool1" },
      editPrompt: "x",
      editMode: "relight",
    }),
    /源视频/,
  );
  await assert.rejects(
    submitVideoEdit({
      sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
      editPrompt: "   ",
      editMode: "relight",
    }),
    /编辑指令/,
  );
  await assert.rejects(
    submitVideoEdit({
      sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
      editPrompt: "x",
      editMode: "teleport" as never,
    }),
    /未知编辑模式/,
  );
  await assert.rejects(
    submitVideoEdit({
      sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
      editPrompt: "x",
      editMode: "object_remove",
      preserveMask: { filename: "keep.png", worker: "http://pool2" },
    }),
    /同一 worker/,
  );
  assert.equal(fetchCalls.length, 0, "拦截期不得发出提交请求");
});

test("⑤ submitVideoEdit:后端 422 文案透出", async () => {
  globalThis.fetch = (async () =>
    new Response(
      JSON.stringify({ detail: "关键帧索引越界(输出共 17 帧,索引须 ≤ 16)" }),
      { status: 422, headers: { "Content-Type": "application/json" } },
    )) as typeof fetch;
  await assert.rejects(
    submitVideoEdit({
      sourceVideo: { filename: "src.mp4", worker: "http://pool1" },
      editPrompt: "x",
      editMode: "object_replace",
      keyframeIndices: [20],
    }),
    /关键帧索引越界/,
  );
});

// ── ⑥ 作业进度解析 ──────────────────────────────────────────────────────────

function job(promptId: string, status: string, results: string[] = []): JobItem {
  return {
    id: `j-${promptId}`,
    prompt_id: promptId,
    kind: "video_edit",
    status,
    prompt: "",
    seed: 1,
    created_at: "",
    results,
  };
}

test("⑥ editJobProgress:done 出片/error/held/running/pending", () => {
  const done = editJobProgress([job("p1", "done", ["/api/images?filename=e.mp4&sig=s"])], "p1");
  assert.equal(done.status, "done");
  assert.equal(done.resultUrl, "/api/images?filename=e.mp4&sig=s");
  assert.equal(editJobProgress([job("p1", "error")], "p1").status, "error");
  assert.equal(editJobProgress([job("p1", "held")], "p1").status, "held");
  assert.equal(editJobProgress([job("p1", "running")], "p1").status, "running");
  assert.equal(editJobProgress([], "p1").status, "pending", "作业未入列表");
});

// ── ⑦ 组件与集成源码断言 ──────────────────────────────────────────────────

test("⑦ AiVideoEditView:模式下拉/标记当前帧/作品库/区域 mask/并排对比", () => {
  const src = readSrc("components/video-edit/AiVideoEditView.tsx");
  assert.ok(src.includes("EDIT_MODES"), "缺编辑模式枚举驱动");
  assert.ok(src.includes("编辑模式"), "缺编辑模式下拉");
  assert.ok(src.includes("标记当前帧"), "缺播放器打点标记按钮");
  assert.ok(src.includes("timeToFrameIndex"), "打点未走 timeToFrameIndex");
  assert.ok(src.includes("toggleKeyframe"), "锚点切换未走 toggleKeyframe");
  assert.ok(src.includes("parseKeyframeIndices"), "手工帧索引未走 parseKeyframeIndices");
  assert.ok(src.includes("AssetPicker"), "缺「从作品库选择」入口");
  assert.ok(src.includes("preserve_mask") === false, "mask 文件名应在 lib 层组装,组件不直拼载荷");
  assert.ok(src.includes("veai-compare"), "缺源视频 vs 编辑后并排对比区");
  assert.ok(src.includes("editJobProgress"), "busy 态进度未走 editJobProgress 轮询");
  assert.ok(src.includes("submitVideoEdit"), "提交未走 submitVideoEdit");
});

test("⑦ GenerateView 接线:vace-edit 引擎渲染 AiVideoEditView 并让位标准链路", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('"vace-edit"'), "GenerateView 缺 vace-edit 引擎特判");
  assert.ok(src.includes("AiVideoEditView"), "GenerateView 未渲染 AiVideoEditView");
  assert.ok(
    src.includes('engine.id !== "vace-edit"'),
    "canSubmit 未豁免 vace-edit(标准链路会误触发)",
  );
});

test("⑦ libraryQuery:video_edit 归视频桶,短名「视频编辑」", () => {
  assert.equal(kindToFilter("video_edit"), "video");
  assert.equal(kindLabel("video_edit"), "视频编辑");
});

test("⑦ 编辑模式枚举与后端一致(五模式)", () => {
  assert.deepEqual(
    EDIT_MODES.map((m) => m.value),
    ["object_replace", "object_remove", "style_transfer", "relight", "camera_change"],
  );
  for (const m of EDIT_MODES) {
    assert.ok(isEditMode(m.value), `${m.value} 应通过 isEditMode`);
    assert.ok(m.placeholder.length > 0, `${m.value} 缺英文示例指令`);
  }
  assert.equal(isEditMode("teleport"), false);
});
