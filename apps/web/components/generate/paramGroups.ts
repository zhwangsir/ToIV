import type { EngineParam } from "@/lib/engines";

/**
 * 参数面板 Inspector 化(T1,2026-08-17):把平铺字段列表改为结构化分组卡。
 * 归类规则(按 EngineParam key/type):
 * - refs     参考输入(images/audio/video 类型,由 Ref*Upload 组件独立成节,不进 ParamField 分组)
 * - model    模型与引擎(ckpt_name/style_preset/sampler/scheduler)
 * - frame    画幅与时长(width/height/resolution/duration/fps/denoise/strength)
 * - sampling 采样(steps/cfg/seed/batch_size/use_upscale/use_rife/full_quality)
 * - lora     LoRA 叠加(loras 类型,多选+强度滑杆交互不变)
 * - advanced 高级参数(其余:negative 及未知 key,收进既有折叠区)
 */

/** 浮板主区可见分组(参考输入由上传组件承载,高级参数走折叠 details,均不在此列)。 */
export type ParamPanelGroupId = "model" | "frame" | "sampling" | "lora";

/** 全量归类 id(含 refs/advanced 两个特殊去向)。 */
export type ParamGroupId = ParamPanelGroupId | "refs" | "advanced";

/** 浮板内分组展示顺序与标题(params-section-title 档位渲染,组间 hairline 由 stage.css 承担)。 */
export const PARAM_PANEL_GROUPS: ReadonlyArray<{ id: ParamPanelGroupId; label: string }> = [
  { id: "model", label: "模型与引擎" },
  { id: "frame", label: "画幅与时长" },
  { id: "sampling", label: "采样" },
  { id: "lora", label: "LoRA 叠加" },
];

/** 「模型与引擎」组参数 key。effect_preset(2026-08-26 Pikaffects 式特效预设)
 *  与 style_preset 同域:都是「选中后由后端自动改提示词/模型行为」的创作意图开关。 */
const MODEL_KEYS: ReadonlySet<string> = new Set([
  "ckpt_name",
  "style_preset",
  "effect_preset",
  "sampler",
  "scheduler",
]);

/** 「画幅与时长」组参数 key。resolution_target(RES-2026-08-18)为输出分辨率档
 *  (原生直出/720P→4K 二次超分),与画幅同域归此组。 */
const FRAME_KEYS: ReadonlySet<string> = new Set([
  "width",
  "height",
  "resolution",
  "resolution_target",
  "duration",
  "segment_extend",
  "fps",
  "denoise",
  "strength",
]);

/** 「采样」组参数 key。 */
const SAMPLING_KEYS: ReadonlySet<string> = new Set([
  "steps",
  "cfg",
  "seed",
  "batch_size",
  "use_upscale",
  "use_rife",
  "full_quality",
]);

/**
 * 单参数归类:类型优先(参考输入/LoRA),命名 key 各归其组;
 * 未识别的 key(含 negative)一律落 advanced,保证新引擎参数永远有着落。
 */
export function groupEngineParam(param: EngineParam): ParamGroupId {
  if (param.type === "images" || param.type === "audio" || param.type === "video") return "refs";
  if (param.type === "loras") return "lora";
  if (MODEL_KEYS.has(param.key)) return "model";
  if (FRAME_KEYS.has(param.key)) return "frame";
  if (SAMPLING_KEYS.has(param.key)) return "sampling";
  return "advanced";
}

/** 分组结果:四个主区组 + 高级组(negative 也在其中,由调用方特判渲染为 Textarea)。 */
export type GroupedParams = Record<ParamPanelGroupId | "advanced", EngineParam[]>;

/**
 * 引擎参数 → 浮板分组(保持注册表原顺序,不做组内重排)。
 * opts.sizeChip:width/height 已吸附到提示词条尺寸 chip 时,从「画幅与时长」剔除,
 * 避免浮板与 chip 重复渲染同一参数。
 */
export function groupEngineParams(
  params: EngineParam[],
  opts?: { sizeChip?: boolean },
): GroupedParams {
  const out: GroupedParams = { model: [], frame: [], sampling: [], lora: [], advanced: [] };
  for (const p of params) {
    const g = groupEngineParam(p);
    if (g === "refs") continue;
    if (opts?.sizeChip && (p.key === "width" || p.key === "height")) continue;
    out[g].push(p);
  }
  return out;
}
