/**
 * Batch3 短剧 UI:场景图绑定 + 一键定妆 + 配音/对口型/成片验收(源码断言)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("CastStage:场景绑定 + 定妆入口 + look banner", () => {
  const src = readSrc("components/studio/stages/CastStage.tsx");
  assert.ok(src.includes("studio-scene-bind"), "缺场景绑定区");
  assert.ok(src.includes("patchStudioProject"), "未持久化 scene_images");
  assert.ok(src.includes("scene_images"), "未写 scene_images");
  assert.ok(src.includes("studio-look-actions"), "缺定妆操作区");
  assert.ok(src.includes("fillThreeViewSlots"), "未用三视图填充");
  assert.ok(src.includes("AssetPicker"), "定妆未接作品库选择器");
  assert.ok(src.includes("studio-look-banner") || src.includes("peekLookPick"), "缺出图定妆桥");
  assert.ok(src.includes("studio-look-state"), "缺定妆就绪态");
});

test("studioLookPick + studioVideoRefs:定妆桥与场景合并", () => {
  const look = readSrc("lib/studioLookPick.ts");
  assert.ok(look.includes("saveLookPick"), "缺 saveLookPick");
  assert.ok(look.includes("fillThreeViewSlots"), "缺 fillThreeViewSlots");
  assert.ok(look.includes("LOOK_PICK_KEY"), "缺 LOOK_PICK_KEY");
  const refs = readSrc("lib/studioVideoRefs.ts");
  assert.ok(refs.includes("mergeSceneImages"), "缺 mergeSceneImages");
  assert.ok(refs.includes("sceneImagesForShot"), "缺 sceneImagesForShot 每镜场景");
  assert.ok(refs.includes("scene"), "未支持场景图");
});

test("ShotCard/Storyboard:项目场景图自动进多参考;配音对口型工具栏", () => {
  const card = readSrc("components/studio/ShotCard.tsx");
  assert.ok(card.includes("projectSceneImages"), "ShotCard 未接项目场景图");
  assert.ok(card.includes("sceneImagesForShot"), "未按镜取场景图");
  assert.ok(card.includes("studio-shot-error"), "缺失败标红区");
  const board = readSrc("components/studio/stages/StoryboardStage.tsx");
  assert.ok(board.includes("projectSceneImages={d.scene_images"), "未透传 scene_images");
  assert.ok(board.includes("studio-voice-toolbar"), "缺一键配音工具栏");
  assert.ok(board.includes("studio-lipsync-toolbar"), "缺一键对口型工具栏");
  assert.ok(board.includes("一键配音"), "缺一键配音文案");
  assert.ok(board.includes("一键对口型"), "缺一键对口型文案");
});

test("AssemblyStage:成片验收条", () => {
  const src = readSrc("components/studio/stages/AssemblyStage.tsx");
  assert.ok(src.includes("studio-accept-bar"), "缺验收条");
  assert.ok(src.includes("duration_sec") || src.includes("totalSec"), "缺耗时");
  assert.ok(src.includes("scene_images"), "验收条未提示场景绑定");
});

test("api.ts:patchStudioProject 接受 scene_images", () => {
  const src = readSrc("lib/api.ts");
  assert.ok(src.includes("scene_images?: string[]") || src.includes("scene_images: string[]"), "缺 scene_images 类型");
  assert.ok(/patchStudioProject[\s\S]*scene_images/.test(src), "patchStudioProject 未列 scene_images");
});

test("ResultPanel/EngineStudio:出图卡定妆", () => {
  const panel = readSrc("components/generate/ResultPanel.tsx");
  assert.ok(panel.includes("onApplyLook"), "ResultPanel 缺 onApplyLook");
  assert.ok(panel.includes("result-apply-look") || panel.includes("定妆"), "缺定妆按钮");
  const eng = readSrc("components/studio/EngineStudioView.tsx");
  assert.ok(eng.includes("saveLookPick"), "EngineStudio 未暂存定妆");
  assert.ok(eng.includes("onApplyLook"), "EngineStudio 未接线");
});

test("studio.css:Batch3 场景/定妆/验收样式", () => {
  const css = readSrc("app/styles/studio.css");
  assert.ok(css.includes(".studio-scene-bind"), "缺场景绑定样式");
  assert.ok(css.includes(".studio-look-actions"), "缺定妆操作样式");
  assert.ok(css.includes(".studio-accept-bar"), "缺验收条样式");
  assert.ok(css.includes(".studio-voice-toolbar"), "缺配音工具栏样式");
  assert.ok(css.includes('[data-status="error"]'), "缺分镜 error 标红");
});
