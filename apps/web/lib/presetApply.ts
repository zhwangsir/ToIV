/**
 * 三层联动(2026-08-18):风格预设选中 → 参数面板即时回显。
 *
 * 预设(模型层)携带推荐采样/画幅参数;选中时由 GenerateView 调 presetParamPatch
 * 生成回填补丁——所见即所得,用户此后仍可自由微调(补丁只写一次,不持续锁定)。
 * 负向提示词仅在用户未填写时回填(预设负向是风格建议,不覆盖用户手写)。
 */
import type { StylePreset } from "./types";

export function presetParamPatch(
  preset: StylePreset,
  currentValues: Record<string, unknown>,
): Record<string, unknown> {
  const patch: Record<string, unknown> = { style_preset: preset.id };
  if (preset.recommended_steps != null) patch.steps = preset.recommended_steps;
  if (preset.recommended_cfg != null) patch.cfg = preset.recommended_cfg;
  if (preset.recommended_sampler) patch.sampler = preset.recommended_sampler;
  if (preset.recommended_scheduler) patch.scheduler = preset.recommended_scheduler;
  if (preset.width && preset.height) {
    patch.width = preset.width;
    patch.height = preset.height;
  }
  if (preset.negative_prompt && !String(currentValues.negative ?? "").trim()) {
    patch.negative = preset.negative_prompt;
  }
  return patch;
}
