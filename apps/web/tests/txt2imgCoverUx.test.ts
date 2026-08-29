/**
 * txt2img 引用主体封面 → img2img(对齐 H3 t2v→i2v)。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import {
  img2imgPartnerId,
  isTxt2imgEngine,
  txt2imgHistoryPresentation,
  txt2imgPayloadWentImg2img,
} from "../lib/txt2imgCoverUx";

const webRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const readSrc = (rel: string) => readFileSync(join(webRoot, rel), "utf-8");

test("img2imgPartnerId: txt2img/nsfw 对齐,其余 null", () => {
  assert.equal(img2imgPartnerId("txt2img"), "img2img");
  assert.equal(img2imgPartnerId("nsfw-txt2img"), "nsfw-img2img");
  assert.equal(img2imgPartnerId("img2img"), null);
  assert.equal(img2imgPartnerId("h3-t2v"), null);
  assert.equal(isTxt2imgEngine("txt2img"), true);
  assert.equal(isTxt2imgEngine("img2img"), false);
});

test("txt2img cover path: history 图生图, engineId 仍 txt2img", () => {
  const engine = { id: "txt2img", label: "文生图" };
  assert.equal(txt2imgPayloadWentImg2img({ engineId: engine.id, hasRefImage: true }), true);
  assert.equal(txt2imgPayloadWentImg2img({ engineId: engine.id, submittedEngineId: "img2img" }), true);
  assert.equal(txt2imgPayloadWentImg2img({ engineId: engine.id, hasRefImage: false }), false);
  assert.equal(txt2imgPayloadWentImg2img({ engineId: "img2img", submittedEngineId: "img2img" }), false);
  const shown = txt2imgHistoryPresentation(engine, { wentImg2img: true });
  assert.equal(shown.engineId, "txt2img");
  assert.match(shown.engineLabel, /图生图/);
  assert.equal(shown.engineLabel.includes("文生图"), false);
});

test("plain txt2img without cover stays 文生图", () => {
  const shown = txt2imgHistoryPresentation(
    { id: "txt2img", label: "文生图" },
    { wentImg2img: false },
  );
  assert.equal(shown.engineId, "txt2img");
  assert.equal(shown.engineLabel, "文生图");
});

test("GenerateView: txt2img 封面切 img2img,无封面不切", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes("img2imgPartnerId"), "引用主体未接 img2img 配对");
  assert.ok(src.includes('kind: partner ? "img2img" : uploadKind'), "封面解析须走 img2img kind");
  assert.ok(src.includes('setEngineIdByKind((prev) => ({ ...prev, [mode]: partner.id }))'), "解析成功后须切到 img2img");
  assert.ok(src.includes("txt2imgHistoryPresentation"), "历史文案未接图生图");
  assert.ok(src.includes('kind: "img2img"'), "提交兜底须 resolveEntityRefs kind=img2img");
});
