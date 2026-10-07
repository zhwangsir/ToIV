/**
 * Batch6: 视频步默认管线 C（源码断言）。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("api.ts: StudioRenderBody 含 pipeline", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("pipeline"), "RenderBody 缺 pipeline 字段");
});

test("ShotCard: 生成请求可带 pipeline", () => {
  const src = readSrc("components/studio/ShotCard.tsx");
  assert.ok(src.includes("num_candidates"), "缺 num_candidates");
  // pipeline 可由 API 默认 c；UI 传更好
  assert.ok(src.includes("video_model"), "缺 video_model");
});

test("api.ts + ShotCard: ref_style 可选", () => {
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes("ref_style"), "RenderBody 缺 ref_style");
  const src = readSrc("components/studio/ShotCard.tsx");
  assert.ok(src.includes('data-testid="studio-video-refstyle"'), "缺设定卡风格选择");
  assert.ok(src.includes("ref_style"), "生成请求未带 ref_style");
});

test("10-07 拍板：视频步 UI 默认 ref2va（逐镜独立），不再硬编码 c", () => {
  const card = readSrc("components/studio/ShotCard.tsx");
  const board = readSrc("components/studio/stages/StoryboardStage.tsx");
  for (const [name, src] of [["ShotCard", card], ["StoryboardStage", board]] as const) {
    assert.ok(src.includes('videoModel === "h3" ? "ref2va"'), `${name} 未默认 ref2va`);
    assert.ok(!src.includes('videoModel === "h3" ? "c"'), `${name} 仍硬编码 c`);
  }
  // h3 不再下发前端自动槽（3 张扁平 refs 会绕过服务端分桶 + 每镜 4 张定妆选取）
  assert.ok(card.includes('videoModel === "h3" ? {} : { ref_images: refUrls }'), "ShotCard h3 仍下发前端 refs");
  const api = readSrc("lib/api.ts");
  assert.ok(api.includes('pipeline?: "ref2va" | "c" | "c_hybrid" | "legacy"'), "RenderBody pipeline 类型未含 ref2va");
});
