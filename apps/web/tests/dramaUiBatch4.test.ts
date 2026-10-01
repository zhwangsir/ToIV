/**
 * Batch4:配音/对口型/成片失败边界 — UI 仍接 Studio API,错误经 hook 透出。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("api.ts:Studio 配音/对口型/成片端点契约", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("/studio/shots/${sid}/voice"), "缺 voiceStudioShot 路径");
  assert.ok(src.includes("/studio/shots/${sid}/lipsync"), "缺 lipsyncStudioShot 路径");
  assert.ok(src.includes("/studio/projects/${pid}/assemble"), "缺 assembleStudio 路径");
  assert.ok(src.includes("voiceStudioShot"), "缺 voiceStudioShot export");
  assert.ok(src.includes("lipsyncStudioShot"), "缺 lipsyncStudioShot export");
  assert.ok(src.includes("assembleStudio"), "缺 assembleStudio export");
});

test("useStudioProject:配音/对口型/成片失败会透出且复位 busy", () => {
  const hook = readSrc("hooks/useStudioProject.ts");
  assert.ok(hook.includes("voiceShot"), "缺 voiceShot");
  assert.ok(hook.includes("lipsyncShot"), "缺 lipsyncShot");
  assert.ok(hook.includes("assemble"), "缺 assemble");
  assert.ok(hook.includes("withBusy"), "缺 withBusy(失败复位依赖)");
  assert.ok(hook.includes("voiceStudioShot"), "voiceShot 未接 API");
  assert.ok(hook.includes("lipsyncStudioShot"), "lipsyncShot 未接 API");
  assert.ok(hook.includes("assembleStudio"), "assemble 未接 API");
});

test("Storyboard/Assembly:工具栏仍接失败可 catch 的调用", () => {
  const board = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(board.includes("studio-voice-toolbar"), "缺配音工具栏");
  assert.ok(board.includes("studio-lipsync-toolbar"), "缺对口型工具栏");
  assert.ok(board.includes(".catch("), "批量配音/对口型未 catch 失败");
  assert.ok(board.includes("voiceShot"), "未调 voiceShot");
  assert.ok(board.includes("lipsyncShot"), "未调 lipsyncShot");
  const asm = readSrc("components/studio/stages/AssemblyStage.tsx");
  assert.ok(asm.includes("assemble()"), "成片未调 assemble");
  assert.ok(asm.includes(".catch("), "成片失败未 catch");
});
