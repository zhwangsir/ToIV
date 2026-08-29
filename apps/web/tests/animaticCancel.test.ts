/**
 * 动态分镜 stitch/AI:busy 态必须可中止(abort fetch + 后端杀 ffmpeg / 断 VLM)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("AnimaticView stitch:生成中可中止,createAnimatic 接 signal", () => {
  const src = readSrc("components/animatic/AnimaticView.tsx");
  assert.ok(src.includes("abortRun"), "缺 abortRun");
  assert.ok(src.includes("signal: ac.signal"), "请求未传 AbortSignal");
  assert.ok(src.includes("中止生成"), "stitch busy 不是「中止生成」");
  assert.ok(src.includes("杀掉远端 ffmpeg"), "未标明会杀 ffmpeg");
  assert.ok(!src.includes("上传并生成中…"), "stitch 仍是不可点的「生成中」");
  const api = readSrc("lib/animatic.ts");
  assert.ok(api.includes("signal?: AbortSignal"), "createAnimatic 未接 signal");
});

test("AnimaticView AI:解析中可中止,from-image 接 signal", () => {
  const src = readSrc("components/animatic/AnimaticView.tsx");
  assert.ok(src.includes("中止解析"), "AI busy 不是「中止解析」");
  assert.ok(!src.includes("VLM 解析图片中…"), "AI 仍是不可点的「解析中」");
  const api = readSrc("lib/api.ts");
  const fn = api.slice(api.indexOf("export async function createDramaProjectFromImage"));
  assert.ok(fn.includes("signal?: AbortSignal"), "from-image 未接 signal");
  assert.ok(fn.includes("signal: params.signal"), "from-image 未把 signal 传给 apiFetch");
});
