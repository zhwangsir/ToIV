/**
 * 局部重绘遮罩涂抹(2026-09-27):纯函数 + 源码断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import {
  brushDiameterPx,
  composeMaskedPixels,
  maskCoverage,
  maskFromAlpha,
  maskImageKeys,
  maskedFileName,
} from "@/lib/inpaintMask";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const src = (p: string) => readFileSync(join(root, p), "utf8");

test("maskImageKeys:LoadImage 的 MASK(slot 1) 被消费才算遮罩槽", () => {
  const wf = {
    "1": { class_type: "LoadImage", inputs: { image: "a.png" } },
    "2": { class_type: "LoadImage", inputs: { image: "b.png" } },
    "3": { class_type: "InpaintModelConditioning", inputs: { pixels: ["1", 0], mask: ["1", 1] } },
    "4": { class_type: "VAEEncode", inputs: { pixels: ["2", 0] } },
    "5": { class_type: "CLIPTextEncode", inputs: { text: "x" } },
  };
  const keys = maskImageKeys(wf, {
    image: { node: "1" },
    ref: { node: "2" },
    prompt: { node: "5" },
  });
  assert.deepEqual([...keys], ["image"]);
  assert.equal(maskImageKeys(null, { image: { node: "1" } }).size, 0);
  assert.equal(maskImageKeys(wf, null).size, 0);
});

test("maskImageKeys:数字节点 id 连线也识别", () => {
  const wf = {
    "7": { class_type: "LoadImage", inputs: {} },
    "8": { class_type: "SetLatentNoiseMask", inputs: { mask: [7, 1] } },
  };
  assert.deepEqual([...maskImageKeys(wf, { src: { node: "7" } })], ["src"]);
});

test("composeMaskedPixels:涂抹处透明,RGB 保留;羽化按覆盖度", () => {
  const rgba = new Uint8ClampedArray([10, 20, 30, 255, 40, 50, 60, 255, 70, 80, 90, 255]);
  const mask = new Uint8ClampedArray([0, 0, 0, 0, 255, 255, 255, 255, 0, 0, 0, 128]);
  const out = composeMaskedPixels(rgba, mask);
  assert.deepEqual([...out], [10, 20, 30, 255, 40, 50, 60, 0, 70, 80, 90, 127]);
  assert.throws(() => composeMaskedPixels(rgba, new Uint8ClampedArray(4)));
});

test("maskFromAlpha:已透明的上传图直接成为初始遮罩;覆盖率统计", () => {
  const rgba = new Uint8ClampedArray([1, 1, 1, 255, 2, 2, 2, 0]);
  const m = maskFromAlpha(rgba);
  assert.equal(m[3], 0);
  assert.equal(m[7], 255);
  assert.equal(maskCoverage(m), 0.5);
  assert.equal(maskCoverage(new Uint8ClampedArray(0)), 0);
});

test("brushDiameterPx / maskedFileName", () => {
  assert.equal(brushDiameterPx(1000, 4), 40);
  assert.equal(brushDiameterPx(100, 1), 4);
  assert.equal(brushDiameterPx(1000, 90), 500);
  assert.equal(maskedFileName("photo.jpg"), "photo_mask.png");
  assert.equal(maskedFileName("photo_mask.png"), "photo_mask.png");
  assert.equal(maskedFileName(".png"), "image_mask.png");
});

test("接线:运行页按工作流判定遮罩槽,图槽出涂抹入口", () => {
  const runner = src("components/apps/AppRunnerView.tsx");
  assert.match(runner, /maskImageKeys\(/);
  const field = src("components/generate/ParamField.tsx");
  assert.match(field, /maskable=/);
  const upload = src("components/generate/RefImageUpload.tsx");
  assert.match(upload, /InpaintMaskPainter/);
  const painter = src("components/generate/InpaintMaskPainter.tsx");
  assert.match(painter, /composeMaskedPixels/);
  assert.match(painter, /destination-out/);
  assert.match(painter, /prefers-reduced-motion/);
  assert.doesNotMatch(painter, /#[0-9a-fA-F]{3,8}\b/);
});
