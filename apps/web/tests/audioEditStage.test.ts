/**
 * 音频编辑 tab 舞台化(2026-09-02):旧三卡堆叠(ToolCard)退役,
 * 统一为「左参数列(工具切换+表单+钉底操作)+ 中央舞台(空态/进度/结果)」,
 * 与图像/视频工作台同一范式。
 * 断言:新骨架类名齐、三工具 hooks 驻留(切换不丢草稿)、旧卡片范式清除、空态一行提示。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("音频编辑舞台化:左参数列 + 中央舞台骨架齐", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(src.includes('className="audio-edit-body"'), "缺编辑区舞台骨架");
  assert.ok(src.includes('className="audio-edit-params"'), "缺左参数列");
  assert.ok(src.includes('className="audio-edit-stage"'), "缺中央舞台");
  assert.ok(src.includes('aria-label="编辑工具"'), "缺工具切换列表");
  assert.ok(src.includes('className="audio-edit-actions"'), "缺钉底主操作区");
});

test("音频编辑舞台化:三工具状态 hooks 驻留 AudioView 层(切换不丢草稿)", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  for (const hook of ["useTtsTool", "useAsrTool", "useSeparateTool"]) {
    assert.ok(src.includes(`function ${hook}()`), `缺 ${hook} hook`);
  }
  // hooks 在 AudioView 本体实例化(而非条件分支内),切换工具状态保留
  const viewBlock = src.slice(src.indexOf("export function AudioView"));
  for (const hook of ["useTtsTool()", "useAsrTool()", "useSeparateTool()"]) {
    assert.ok(viewBlock.includes(hook), `AudioView 未实例化 ${hook}`);
  }
});

test("音频编辑舞台化:旧三卡堆叠范式清除", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  assert.ok(!src.includes("ToolCard"), "旧 ToolCard 基座残留");
  assert.ok(!src.includes("audio-tool-card"), "旧工具卡样式残留");
  assert.ok(!src.includes("audio-tab-edit"), "旧滚动卡列容器残留");
});

test("音频编辑舞台化:舞台空态/进行中/结果三态齐全", () => {
  const src = readSrc("components/audio/AudioView.tsx");
  // 空态(2026-09-04 美化 W2A):共享三档空态的舞台档(Empty size="stage" +
  // .stage-empty 适配层,与 ResultPanel 空态同一舞台语言),三工具各一
  const empties = src.match(/<StageEmpty tool=/g) ?? [];
  assert.ok(empties.length >= 3, "三工具舞台空态提示不齐");
  assert.ok(src.includes('size="stage"'), "空态未接 Empty size=stage");
  // 进行中:TTS/分离走 StageBusy(spinner),ASR 走 ToolProgress(百分比)
  assert.ok(src.includes("StageBusy"), "缺无百分比进行中态");
  assert.ok(src.includes("ToolProgress"), "缺百分比进行中态");
  // 结果:TTS/分离走 AudioResult,ASR 走转写面板
  assert.ok(src.includes("AudioResult"), "缺音频结果区");
  assert.ok(src.includes("audio-stage-scroll"), "缺结果滚动区");
});
