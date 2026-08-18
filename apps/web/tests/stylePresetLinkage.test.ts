/**
 * 三层联动(2026-08-18)前端防回归(node:test):
 * ① presetParamPatch:预设选中 → 回显补丁(推荐采样/画幅全量;负向仅空时回填)
 * ② GenerateView 源码接线:style_preset 特判走 presetParamPatch;PromptBar 透传
 *    stylePreset/recommendedSkill;OptimizeButton Popover 推荐标存在
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { presetParamPatch } from "../lib/presetApply";
import type { StylePreset } from "../lib/types";

const testDir = dirname(fileURLToPath(import.meta.url));
const webRoot = join(testDir, "..");

function readSrc(rel: string): string {
  return readFileSync(join(webRoot, rel), "utf-8");
}

const CINEMATIC: StylePreset = {
  id: "cinematic",
  label: "电影感",
  ckpt_name: "flux2_dev_fp8mixed.safetensors",
  media: "image",
  width: 1280,
  height: 720,
  description: "FLUX.2 电影感画面",
  llm_layer: "L3",
  commercial_safe: false,
  recommended_steps: 28,
  recommended_cfg: 1.0,
  recommended_sampler: "euler",
  recommended_scheduler: "simple",
  prompt_hint: ", cinematic lighting, film grain",
  negative_prompt: "",
  recommended_skill: "cinematic",
};

// ── ① presetParamPatch 纯函数 ───────────────────────────────────────────

test("完整预设 → 补丁含推荐采样/画幅与预设 id", () => {
  const patch = presetParamPatch(CINEMATIC, {});
  assert.equal(patch.style_preset, "cinematic");
  assert.equal(patch.steps, 28);
  assert.equal(patch.cfg, 1.0);
  assert.equal(patch.sampler, "euler");
  assert.equal(patch.scheduler, "simple");
  assert.equal(patch.width, 1280);
  assert.equal(patch.height, 720);
});

test("负向回填仅当用户未填写(不覆盖手写)", () => {
  const p = { ...CINEMATIC, negative_prompt: "ugly, blurry" };
  // 空/未填 → 回填
  assert.equal(presetParamPatch(p, {}).negative, "ugly, blurry");
  assert.equal(presetParamPatch(p, { negative: "  " }).negative, "ugly, blurry");
  // 已有手写 → 不覆盖
  assert.equal("negative" in presetParamPatch(p, { negative: "my own" }), false);
});

test("无推荐字段的预设(turbo 类)补丁只含 id 与画幅", () => {
  const turbo: StylePreset = {
    ...CINEMATIC,
    id: "turbo",
    recommended_steps: null,
    recommended_cfg: null,
    recommended_sampler: null,
    recommended_scheduler: null,
  };
  const patch = presetParamPatch(turbo, {});
  assert.equal(patch.style_preset, "turbo");
  assert.equal("steps" in patch, false);
  assert.equal("cfg" in patch, false);
  assert.equal("sampler" in patch, false);
});

// ── ② 源码接线断言(轻量,防联动链路被误删) ────────────────────────────

test("GenerateView:style_preset 选中走 presetParamPatch 回显", () => {
  const src = readSrc("components/generate/GenerateView.tsx");
  assert.ok(src.includes('key === "style_preset"'));
  assert.ok(src.includes("presetParamPatch(preset"));
  // PromptBar 透传两层联动参数
  assert.ok(src.includes("stylePreset={currentStylePreset}"));
  assert.ok(src.includes("recommendedSkill={currentRecommendedSkill}"));
});

test("PromptBar:stylePreset/recommendedSkill 透传 OptimizeButton", () => {
  const src = readSrc("components/generate/PromptBar.tsx");
  assert.ok(src.includes("stylePreset={stylePreset}"));
  assert.ok(src.includes("recommendedSkill={recommendedSkill}"));
});

test("OptimizeButton:stylePreset 进 optimize 载荷;推荐 skill 预选逻辑存在", () => {
  const src = readSrc("components/ui/OptimizeButton.tsx");
  assert.ok(src.includes("...(stylePreset ? { stylePreset } : {})"));
  // 推荐预选:无全局默认时置顶 + 推荐 chip;有默认时尊重用户选择
  assert.ok(src.includes("!localAgent && recommendedSkill"));
  assert.ok(src.includes('ob-option-rec">推荐'));
});

test("types.ts:StylePreset 联动字段(编译契约 + 回显数据源)", () => {
  const src = readSrc("lib/types.ts");
  for (const f of [
    "recommended_steps",
    "recommended_cfg",
    "recommended_sampler",
    "recommended_scheduler",
    "prompt_hint",
    "negative_prompt",
    "recommended_skill",
  ]) {
    assert.ok(src.includes(f), `types.ts 缺 ${f}`);
  }
});
