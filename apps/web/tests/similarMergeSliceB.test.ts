/**
 * Similar-merge P1 Slice B — 文案/导航轻量刀单测。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { NAV_LABELS } from "../lib/navLabels";
import {
  ENGINE_APP_DISPLAY_ALIASES,
  resolveEngineAppDisplayName,
  resolveMarketAppIdForEngine,
} from "../lib/engineAppAliases";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("Slice B #13/#25: NAV_LABELS 引擎台下沉 + 工具箱对齐", () => {
  assert.equal(NAV_LABELS.market, "工具箱");
  assert.equal(NAV_LABELS.image, "工具箱·图片引擎");
  assert.equal(NAV_LABELS.video, "工具箱·视频引擎");
  assert.equal(NAV_LABELS.audio, "工具箱·音频");
  assert.equal(NAV_LABELS.studio, "做短剧");
  assert.equal(NAV_LABELS.library, "作品库");
  assert.equal(NAV_LABELS.libraryRail, "作品库");
  assert.equal(NAV_LABELS.resources, "资源中心");
  // page + cmdk 引用单源
  const page = readSrc("app/page.tsx");
  const cmdk = readSrc("components/nav/CommandPalette.tsx");
  assert.ok(page.includes("NAV_LABELS"), "page 应引用 NAV_LABELS");
  assert.ok(cmdk.includes("NAV_LABELS"), "CommandPalette 应引用 NAV_LABELS");
  assert.ok(page.includes("NAV_LABELS.image"), "page VIEW_META image 应走单源");
  assert.ok(cmdk.includes("NAV_LABELS.image"), "⌘K image 应走单源");
});

test("Slice B #20: txt2img↔txt2img-basic / img2img↔img2img-basic 展示别名（不改引擎 id）", () => {
  assert.equal(resolveEngineAppDisplayName("txt2img"), "Flux2 文生图");
  assert.equal(resolveEngineAppDisplayName("txt2img-basic"), "Flux2 文生图");
  assert.equal(resolveEngineAppDisplayName("img2img"), "Flux2 图生图");
  assert.equal(resolveEngineAppDisplayName("img2img-basic"), "Flux2 图生图");
  assert.equal(resolveMarketAppIdForEngine("txt2img"), "txt2img-basic");
  assert.equal(resolveMarketAppIdForEngine("img2img"), "img2img-basic");
  assert.equal(ENGINE_APP_DISPLAY_ALIASES.txt2img.engineId, "txt2img");
  assert.equal(ENGINE_APP_DISPLAY_ALIASES["txt2img-basic"].engineId, "txt2img");
  // 禁止硬改引擎 id：engineStudio 仍挂 txt2img/img2img
  const studio = readSrc("lib/engineStudio.ts");
  assert.ok(studio.includes('"txt2img"'), "engineStudio 引擎 id 不可改");
  assert.ok(studio.includes('"img2img"'), "engineStudio 引擎 id 不可改");
  assert.ok(!studio.includes("txt2img-basic"), "engineStudio 不应硬改成 market id");
});

test("Slice B #16: StudioView 仅说明文案指向 /toiv/drama，无强 redirect", () => {
  const src = readSrc("components/studio/StudioView.tsx");
  assert.ok(src.includes("/toiv/drama"), "应说明融合主路径 /toiv/drama");
  assert.ok(src.includes("短剧工作台"), "应点名画布短剧工作台");
  assert.ok(!src.includes('location.replace("/toiv/drama")'), "勿强 redirect");
  assert.ok(!src.includes('router.push("/toiv/drama")'), "勿强 redirect");
});
