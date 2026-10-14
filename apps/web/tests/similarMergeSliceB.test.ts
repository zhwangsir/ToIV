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

