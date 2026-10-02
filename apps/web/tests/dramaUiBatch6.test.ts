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
