/** 统一创作台:共享类型与预设常量。 */

export type Tier = "simple" | "pro";
export type Mode = "image" | "video" | "model3d" | "audio";
export type ResultKind = "image" | "video" | "model3d" | "audio";

export interface RefImage {
  previewUrl: string;
  file: File;
  uploaded?: { filename: string; worker: string };
}

export interface ResultItem {
  id: string;
  kind: ResultKind;
  url: string;
  prompt: string;
  /** 续创作里参数迭代用:沿用画幅/模型,无需重配。 */
  meta?: ResultMeta;
}

export interface ResultMeta {
  ckpt?: string;
  width?: number;
  height?: number;
  /** img2img/重绘:原图 URL,用于结果卡的拖动对比(before)。 */
  beforeUrl?: string;
}

export interface AspectPreset {
  key: string;
  label: string;
  w: number;
  h: number;
}

export interface StylePreset {
  key: string;
  label: string;
  /** 拼到正向提示词后面的风格补充。 */
  suffix: string;
}

export interface VideoLength {
  v: number;
  label: string;
}

/** 简易版风格 chip(图像/视频通用,智能拼接到提示词)。 */
export const STYLE_PRESETS: readonly StylePreset[] = [
  { key: "none", label: "无", suffix: "" },
  { key: "real", label: "写实", suffix: "photorealistic, ultra detailed, natural lighting" },
  { key: "anime", label: "动漫", suffix: "anime style, vivid colors, clean lineart" },
  { key: "cinematic", label: "电影感", suffix: "cinematic, dramatic lighting, film grain, depth of field" },
];

/** 简易版比例 chip(像素由各 Mode 在生成时映射)。 */
export const SIMPLE_RATIOS = [
  { key: "1:1", label: "1:1" },
  { key: "16:9", label: "16:9" },
  { key: "9:16", label: "9:16" },
] as const;
export type SimpleRatioKey = (typeof SIMPLE_RATIOS)[number]["key"];

/** 比例 → 图像像素。 */
export const IMG_RATIO_PX: Record<SimpleRatioKey, { w: number; h: number }> = {
  "1:1": { w: 768, h: 768 },
  "16:9": { w: 896, h: 512 },
  "9:16": { w: 512, h: 896 },
};

/** 比例 → 视频像素。 */
export const VID_RATIO_PX: Record<SimpleRatioKey, { w: number; h: number }> = {
  "1:1": { w: 480, h: 480 },
  "16:9": { w: 832, h: 480 },
  "9:16": { w: 480, h: 832 },
};

/** 专业版图像画幅预设。 */
export const IMG_ASPECTS: readonly AspectPreset[] = [
  { key: "1:1", label: "1:1", w: 768, h: 768 },
  { key: "2:3", label: "竖 2:3", w: 640, h: 960 },
  { key: "3:2", label: "横 3:2", w: 960, h: 640 },
  { key: "16:9", label: "宽 16:9", w: 896, h: 512 },
];

/** 专业版视频画幅预设。 */
export const VID_ASPECTS: readonly AspectPreset[] = [
  { key: "1:1", label: "1:1", w: 480, h: 480 },
  { key: "16:9", label: "横 16:9", w: 832, h: 480 },
  { key: "9:16", label: "竖 9:16", w: 480, h: 832 },
];

export const VID_LENGTHS: readonly VideoLength[] = [
  { v: 25, label: "~1.5s" },
  { v: 49, label: "~3s" },
  { v: 81, label: "~5s" },
  { v: 121, label: "~7.5s" },
];

export const AUDIO_DURATIONS: readonly VideoLength[] = [
  { v: 15, label: "15s" },
  { v: 30, label: "30s" },
  { v: 60, label: "60s" },
  { v: 120, label: "120s" },
];

export const SAMPLERS: readonly string[] = ["euler", "euler_ancestral", "dpmpp_2m", "dpmpp_2m_sde", "dpmpp_3m_sde", "ddim", "uni_pc"];
export const SCHEDULERS: readonly string[] = ["normal", "karras", "exponential", "sgm_uniform", "simple", "beta"];

/** 专业版工作流预设(下拉),把常用参数一键带入。 */
export interface WorkflowPreset {
  key: string;
  label: string;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
}
export const WORKFLOW_PRESETS: readonly WorkflowPreset[] = [
  { key: "balanced", label: "均衡(默认)", steps: 20, cfg: 7, sampler: "euler", scheduler: "normal" },
  { key: "quality", label: "高质量(慢)", steps: 35, cfg: 6.5, sampler: "dpmpp_2m", scheduler: "karras" },
  { key: "fast", label: "快速预览", steps: 12, cfg: 6, sampler: "euler_ancestral", scheduler: "normal" },
  { key: "crisp", label: "锐利写实", steps: 28, cfg: 8, sampler: "dpmpp_2m_sde", scheduler: "karras" },
];

export const DEFAULT_NEGATIVE = "blurry, lowres, deformed, watermark, text, extra limbs";

const MODE_LABEL: Record<Mode, string> = {
  image: "图像",
  video: "视频",
  model3d: "3D",
  audio: "音频",
};
export const modeLabel = (m: Mode): string => MODE_LABEL[m];

let _seq = 0;
export const nextId = (): string => `r-${_seq++}`;
