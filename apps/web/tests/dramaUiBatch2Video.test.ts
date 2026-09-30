/**
 * Batch2 视频步残余:H3 默认 + 每镜多候选 + 多参考槽(源码断言)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("StoryboardStage:视频工具栏默认 H3 + 候选 2", () => {
  const src = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(src.includes('studio-video-toolbar'), "缺视频工具栏");
  assert.ok(src.includes('useState<"h3" | "ltx">("h3")') || src.includes('useState("h3")'), "引擎默认非 H3");
  assert.ok(src.includes("useState(2)") || src.includes("numCandidates"), "缺候选数状态");
  assert.ok(src.includes('option value="h3"'), "缺 H3 option");
  assert.ok(src.includes("defaultNumCandidates"), "未透传默认候选数");
  assert.ok(src.includes("videoFocus={focus === \"video\"}"), "未透传 videoFocus");
  assert.ok(src.includes("pickCandidate"), "未接线 pickCandidate");
});

test("ShotCard:多参考槽 + 多候选行 + 生成带 video_model/num_candidates", () => {
  const src = readSrc("components/studio/ShotCard.tsx");
  assert.ok(src.includes("studio-video-opts"), "缺视频选项区");
  assert.ok(src.includes("studio-shot-refs"), "缺多参考槽");
  assert.ok(src.includes("studio-cand-row"), "缺候选行");
  assert.ok(src.includes("collectAutoRefSlots"), "未自动收集角色参考图");
  assert.ok(src.includes("video_model"), "生成未带 video_model");
  assert.ok(src.includes("num_candidates"), "生成未带 num_candidates");
  assert.ok(src.includes("onPickCandidate"), "缺选用候选回调");
});

test("studioVideoRefs:从三视图收集正/侧/全身", () => {
  const src = readSrc("lib/studioVideoRefs.ts");
  assert.ok(src.includes('"正"'), "缺正");
  assert.ok(src.includes('"侧"'), "缺侧");
  assert.ok(src.includes('"全身"'), "缺全身");
  assert.ok(src.includes("reference_images"), "未读 reference_images");
  assert.ok(src.includes("scene"), "未支持场景图");
});

test("api.ts:renderStudioShot 接受 body;pickStudioCandidate 存在", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("StudioRenderBody"), "缺 StudioRenderBody");
  assert.ok(src.includes("pickStudioCandidate"), "缺 pickStudioCandidate");
  assert.ok(src.includes("num_candidates"), "RenderBody 缺 num_candidates");
  assert.ok(src.includes("StudioShotCandidate"), "缺 StudioShotCandidate");
});

test("studio.css:视频工具栏/候选/参考样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-video-toolbar"), "缺工具栏样式");
  assert.ok(css.includes(".studio-cand"), "缺候选样式");
  assert.ok(css.includes(".studio-shot-ref-thumb"), "缺参考缩略图样式");
});
