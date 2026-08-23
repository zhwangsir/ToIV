/**
 * TTS 配音产物作品库登记(前端半)单测(node:test,无 DOM):
 * ① libraryQuery:manju_voice 归「音频」筛选桶,短名「配音」(不再只出现在「全部」)
 * ② AudioView TtsCard:合成成功后失效作品库缓存(invalidateJobs),
 *    与图像/视频生成同口径(后端 Job 建档落地即作品库可见)
 * 注:建档本体在后端 POST /api/manju/voice(voice.py 同步落盘 wav,此前不建 Job),
 *    前端无可用的产物登记端点,只能保证「建档后即刻可见 + 正确归类」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { kindLabel, kindToFilter } from "../lib/libraryQuery";

const testDir = dirname(fileURLToPath(import.meta.url));
function readSrc(rel: string): string {
  return readFileSync(join(testDir, "..", rel), "utf8");
}

test("① libraryQuery:manju_voice → 音频桶 + 短名「配音」", () => {
  assert.equal(kindToFilter("manju_voice"), "audio", "manju_voice 应归音频筛选桶");
  assert.equal(kindLabel("manju_voice"), "配音");
  // 既有音频类 kind 不受影响
  assert.equal(kindToFilter("voice_track"), "audio");
  assert.equal(kindToFilter("ace_audio"), "audio");
});

test("② AudioView TTS 卡:合成成功后 invalidateJobs(源码断言)", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(/import \{[^}]*invalidateJobs[^}]*\} from "@\/lib\/api"/.test(src), "未引入 invalidateJobs");
  const synthBlock = src.slice(src.indexOf("async function onSynth"));
  assert.ok(synthBlock.includes("synthManjuVoice("), "未找到 TTS 合成调用");
  assert.ok(
    synthBlock.indexOf("invalidateJobs()") > synthBlock.indexOf("setResult(r)"),
    "合成成功后未失效作品库缓存",
  );
});
