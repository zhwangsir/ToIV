/**
 * 音频编辑 TTS/ASR/分离:停止必须 abort 请求;ASR 另走 cancelJob。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("AudioView TTS:合成中露出中止,走 AbortSignal,不是死 loading", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(src.includes("onStopSynth"), "缺 TTS 中止");
  assert.ok(src.includes("{ signal: ac.signal }"), "TTS 未传 AbortSignal");
  assert.ok(src.includes("中止合成"), "busy 态不是「中止合成」");
  assert.ok(src.includes("断开到 IndexTTS"), "未标明会断开 IndexTTS 连接");
  assert.ok(!src.includes('loading={synthing}'), "TTS 主按钮仍 loading=死控件");
});

test("AudioView ASR:中止走 transcribeDub signal → cancelJob", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(src.includes("onStopAsr"), "缺 ASR 中止");
  assert.ok(src.includes("transcribeDub(up.name"), "听写未走 transcribeDub");
  assert.ok(src.includes("ac.signal"), "听写未传 signal");
  assert.ok(src.includes("中止听写"), "busy 态不是「中止听写」");
  const api = readSrc("lib/api.ts");
  const fn = api.slice(api.indexOf("export async function transcribeDub"));
  assert.ok(fn.includes("cancelJob(jobId)"), "transcribeDub abort 未 cancelJob");
  assert.ok(fn.includes("signal?: AbortSignal"), "transcribeDub 未接 signal");
});

test("AudioView 人声分离:中止 abort fetch,不是死 loading", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(src.includes("onStopSeparate"), "缺分离中止");
  assert.ok(src.includes("separateAudio(file, { signal: ac.signal })"), "分离未传 signal");
  assert.ok(src.includes("中止分离"), "busy 态不是「中止分离」");
  assert.ok(src.includes("断开到 Demucs"), "未标明会断开 Demucs 连接");
  assert.ok(!src.includes("loading={busy}"), "分离/听写主按钮仍 loading=死控件");
});
