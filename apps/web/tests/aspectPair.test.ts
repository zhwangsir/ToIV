/**
 * 宽高联动比例纠正(node:test):
 * 视频 9:16~16:9、SD 图像 1:2~2:1 的 ar 安全域联动——防极端比例导致生成内容
 * 主体被裁/文字溢出。与后端 clamp_aspect_ratio 同规则(保长边抬短边)。
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { applyAspectPair } from "../lib/aspectPair";
import type { EngineParam } from "../lib/engines";

const VIDEO = [9 / 16, 16 / 9] as [number, number];
const IMAGE = [0.5, 2.0] as [number, number];

const videoParams: EngineParam[] = [
  { key: "width", label: "宽", type: "number", min: 256, max: 1920, step: 32, default: 960, ar: VIDEO },
  { key: "height", label: "高", type: "number", min: 256, max: 1088, step: 32, default: 544 },
];
const imageParams: EngineParam[] = [
  { key: "width", label: "宽", type: "number", min: 64, max: 2048, step: 8, default: 1024, ar: IMAGE },
  { key: "height", label: "高", type: "number", min: 64, max: 2048, step: 8, default: 1024 },
];

test("LTX 宽度过宽:1920×256 → 高联动抬到 1088", () => {
  const r = applyAspectPair("width", "1920", { width: "960", height: "256" }, videoParams);
  assert.ok(r);
  assert.equal(r.value, 1920);
  assert.equal(r.otherKey, "height");
  assert.equal(r.otherValue, 1088);
});

test("LTX 高度过高:256×1088 → 宽联动抬到 640", () => {
  const r = applyAspectPair("height", "1088", { width: "256", height: "544" }, videoParams);
  assert.ok(r);
  assert.equal(r.value, 1088);
  assert.equal(r.otherKey, "width");
  assert.equal(r.otherValue, 640);
});

test("比例合规时不动另一维度", () => {
  // 1280/736 = 1.739 ∈ [0.5625, 1.7778] 且 736 已 32 对齐 → 原样保留
  const r = applyAspectPair("width", "1280", { width: "960", height: "736" }, videoParams);
  assert.ok(r);
  assert.equal(r.value, 1280);
  assert.equal(r.otherValue, 736);
});

test("图像 1:2~2:1:2048×64 → 高抬到 1024", () => {
  const r = applyAspectPair("width", "2048", { width: "1024", height: "64" }, imageParams);
  assert.ok(r);
  assert.equal(r.value, 2048);
  assert.equal(r.otherValue, 1024);
});

test("图像纵向 64×2048 → 宽抬到 1024", () => {
  const r = applyAspectPair("height", "2048", { width: "64", height: "1024" }, imageParams);
  assert.ok(r);
  assert.equal(r.value, 2048);
  assert.equal(r.otherKey, "width");
  assert.equal(r.otherValue, 1024);
});

test("中间输入态(空串/带尾点)不干预", () => {
  assert.equal(applyAspectPair("width", "", { width: "960", height: "544" }, videoParams), null);
  assert.equal(applyAspectPair("width", "10.", { width: "960", height: "544" }, videoParams), null);
});

test("非宽高键/无 ar 元数据不干预", () => {
  assert.equal(applyAspectPair("steps", "20", {}, videoParams), null);
  const noAr = videoParams.map((p) => ({ ...p, ar: undefined }));
  assert.equal(applyAspectPair("width", "1920", { width: "960", height: "256" }, noAr), null);
});

test("输入越界钳回 min/max:width 9999 → 1920", () => {
  const r = applyAspectPair("width", "9999", { width: "960", height: "544" }, videoParams);
  assert.ok(r);
  assert.equal(r.value, 1920);
  // 1920/544=3.53 越界 → 高抬到 1088
  assert.equal(r.otherValue, 1088);
});
