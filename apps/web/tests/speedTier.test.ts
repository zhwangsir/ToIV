/**
 * INTENT e:速度分档 UI/契约源码断言。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import {
  DEFAULT_SPEED_TIER,
  labelSpeedTier,
  parseSpeedTier,
  speedTierToH3Accel,
  SPEED_TIER_STORAGE_KEY,
} from "../lib/speedTier.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (rel: string) => readFileSync(join(root, rel), "utf8");

test("speedTier:默认精细 + 映射 H3 balanced/off", () => {
  assert.equal(DEFAULT_SPEED_TIER, "quality");
  assert.equal(speedTierToH3Accel("fast"), "balanced");
  assert.equal(speedTierToH3Accel("quality"), "off");
  assert.equal(labelSpeedTier("fast"), "快速");
  assert.equal(labelSpeedTier("quality"), "精细");
  assert.equal(parseSpeedTier("turbo"), "quality");
  assert.equal(parseSpeedTier("fast"), "fast");
  assert.ok(SPEED_TIER_STORAGE_KEY.includes("speed_tier"));
});

test("SpeedTierSelect:段控快速/精细", () => {
  const src = read("components/generate/SpeedTierSelect.tsx");
  assert.ok(src.includes("快速"));
  assert.ok(src.includes("精细"));
  assert.ok(src.includes('aria-label="速度"'));
});

test("AppRunnerView:挂载分档并透传 speed_tier + 排队提示 + 失败白话", () => {
  const src = read("components/apps/AppRunnerView.tsx");
  assert.ok(src.includes("SpeedTierSelect"));
  assert.ok(src.includes("speed_tier: speedTier"));
  assert.ok(src.includes("queued_behind"));
  assert.ok(src.includes("plainJobErrorReason"));
  assert.ok(src.includes("saveSpeedTier"));
});

test("EngineStudioView:挂载分档并提交 speed_tier", () => {
  const src = read("components/studio/EngineStudioView.tsx");
  assert.ok(src.includes("SpeedTierSelect"));
  assert.ok(src.includes("speed_tier: speedTier"));
});

test("apps.ts:runApp 契约含 speed_tier / queued_behind", () => {
  const src = read("lib/apps.ts");
  assert.ok(src.includes("speed_tier?:"));
  assert.ok(src.includes("queued_behind"));
  assert.ok(src.includes("body.speed_tier"));
});

test("engines.ts:submit 透传 speed_tier", () => {
  const src = read("lib/engines.ts");
  assert.ok(src.includes("speed_tier?:"));
  assert.ok(src.includes("speedTierPayload"));
});
