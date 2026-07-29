/**
 * 采样器 / 调度器说明与搭配建议。
 *
 * 说明：
 * - 采样器（Sampler）决定噪声如何去噪，影响收敛速度、细节质量和稳定性。
 * - 调度器（Scheduler）决定每一步噪声强度如何衰减，影响采样曲线和纹理。
 *
 * 最佳实践：
 * - 默认推荐：DPM++ 2M Karras / Euler a，兼顾质量与速度。
 * - 追求细节：DPM++ 2M SDE Karras / UniPC，步数 25-40。
 * - 快速迭代：Euler / DPM++ 2M，步数 15-25。
 * - 动漫/插画：Euler a / DPM++ 2M Karras。
 * - 写实/摄影：DPM++ 2M SDE Karras / UniPC BH2。
 * - 次世代模型（CFG≈1.0）通常使用 Euler / DPM++ 2M，调度器可选 simple。
 */

export interface SamplerInfo {
  /** 采样器名称（与后端返回一致，不区分大小写匹配） */
  name: string;
  /** 一句话说明 */
  summary: string;
  /** 速度评级：1-5，越大越快 */
  speed: number;
  /** 质量/细节收敛评级：1-5，越大越适合高细节 */
  quality: number;
  /** 是否带有祖先采样随机性（每步重新加噪） */
  ancestral: boolean;
}

export interface SchedulerInfo {
  /** 调度器名称 */
  name: string;
  /** 一句话说明 */
  summary: string;
}

export interface PairingTip {
  /** 场景标签 */
  scene: string;
  /** 推荐采样器（显示名） */
  sampler: string;
  /** 推荐调度器（显示名） */
  scheduler: string;
  /** 推荐步数范围 */
  steps: string;
  /** 说明 */
  note: string;
}

export const SAMPLER_INFOS: SamplerInfo[] = [
  {
    name: "euler",
    summary: "最基础稳定的采样器，收敛快，适合快速预览和默认出图。",
    speed: 5,
    quality: 3,
    ancestral: false,
  },
  {
    name: "euler_ancestral",
    summary: "Euler 祖先版，每步重新加噪，画面更有艺术感和随机性。",
    speed: 4,
    quality: 3,
    ancestral: true,
  },
  {
    name: "heun",
    summary: "二阶精度，细节优于 Euler，但速度慢一倍，适合高质量静帧。",
    speed: 3,
    quality: 4,
    ancestral: false,
  },
  {
    name: "dpm_2",
    summary: "DPM 二阶单步求解器，细节好但速度较慢。",
    speed: 3,
    quality: 4,
    ancestral: false,
  },
  {
    name: "dpm_2_ancestral",
    summary: "DPM-2 祖先版，创意性强但稳定性略低。",
    speed: 3,
    quality: 4,
    ancestral: true,
  },
  {
    name: "dpmpp_2m",
    summary: "当前最均衡的采样器，质量高、速度快，推荐作为日常主力。",
    speed: 5,
    quality: 4,
    ancestral: false,
  },
  {
    name: "dpmpp_2m_sde",
    summary: "DPM++ 2M 的 SDE 版本，细节更细腻，适合写实与复杂场景。",
    speed: 4,
    quality: 5,
    ancestral: false,
  },
  {
    name: "dpmpp_3m_sde",
    summary: "三阶 SDE 采样器，极高细节，但速度最慢，适合最终精修。",
    speed: 2,
    quality: 5,
    ancestral: false,
  },
  {
    name: "dpm_fast",
    summary: "DPM 快速版，步数可极低，适合草图和快速验证。",
    speed: 5,
    quality: 2,
    ancestral: false,
  },
  {
    name: "dpm_adaptive",
    summary: "自适应步数，自动调整去噪过程，适合不清楚最佳步数时使用。",
    speed: 3,
    quality: 4,
    ancestral: false,
  },
  {
    name: "lms",
    summary: "线性多步法，稳定但已被 DPM++ 系列全面超越，仅作兼容。",
    speed: 3,
    quality: 3,
    ancestral: false,
  },
  {
    name: "ddim",
    summary: "经典确定性采样器，DDIM 步数可少至 10-15，适合图生图/局部重绘。",
    speed: 4,
    quality: 3,
    ancestral: false,
  },
  {
    name: "uni_pc",
    summary: "UniPC 预测-校正器，低步数也能保持高细节，适合快速高质量出图。",
    speed: 4,
    quality: 5,
    ancestral: false,
  },
  {
    name: "uni_pc_bh2",
    summary: "UniPC BH2 变体，对复杂提示词和写实风格收敛更稳。",
    speed: 4,
    quality: 5,
    ancestral: false,
  },
  {
    name: "lcm",
    summary: "Latent Consistency Model 专用采样器，4-8 步即可出图，需配合 LCM 模型。",
    speed: 5,
    quality: 3,
    ancestral: false,
  },
  {
    name: "tcd",
    summary: "Trajectory Consistency Distillation 采样器，少步高质量，需 TCD 模型支持。",
    speed: 5,
    quality: 4,
    ancestral: false,
  },
];

export const SCHEDULER_INFOS: SchedulerInfo[] = [
  { name: "normal", summary: "标准噪声调度，平稳衰减，通用但不如 Karras 细腻。" },
  { name: "karras", summary: "Karras 推荐调度，低步数下细节更好，最常用。" },
  { name: "exponential", summary: "指数衰减，早期步数变化大，适合追求对比度和锐度。" },
  { name: "simple", summary: "线性简单调度，次世代模型（CFG≈1.0）常用。" },
  { name: "sgm_uniform", summary: "Score-based 均匀调度，EDM/SDXL 类模型表现稳定。" },
  { name: "ddim_uniform", summary: "DDIM 专用均匀调度，配合 DDIM 采样器使用。" },
  { name: "ays", summary: "Align Your Steps 调度，针对特定模型优化步数分布。" },
];

export const PAIRING_TIPS: PairingTip[] = [
  {
    scene: "日常默认",
    sampler: "DPM++ 2M",
    scheduler: "Karras",
    steps: "20-30",
    note: "速度和质量最均衡，适合大多数风格和模型。",
  },
  {
    scene: "写实/摄影",
    sampler: "DPM++ 2M SDE / UniPC BH2",
    scheduler: "Karras",
    steps: "25-40",
    note: "细节和皮肤纹理更自然，适合人像和真实场景。",
  },
  {
    scene: "动漫/插画",
    sampler: "Euler a / DPM++ 2M",
    scheduler: "Karras",
    steps: "20-30",
    note: "色彩饱和、线条清晰，祖先采样带来生动笔触。",
  },
  {
    scene: "快速迭代",
    sampler: "Euler / DPM++ 2M",
    scheduler: "normal / simple",
    steps: "15-25",
    note: "抽卡效率高，先定构图再提升步数精修。",
  },
  {
    scene: "最终精修",
    sampler: "DPM++ 3M SDE / UniPC",
    scheduler: "Karras / exponential",
    steps: "30-50",
    note: "细节最大化，适合确定提示词后输出成品。",
  },
  {
    scene: "次世代模型",
    sampler: "Euler / DPM++ 2M",
    scheduler: "simple / sgm_uniform",
    steps: "20-30",
    note: "CFG 固定约 1.0，无需复杂调度，simple 通常最稳。",
  },
];

/**
 * 按名称查找采样器信息（不区分大小写，忽略空格和下划线差异）。
 */
export function findSamplerInfo(name: string): SamplerInfo | undefined {
  const key = name.toLowerCase().replace(/[\s_-]+/g, "");
  return SAMPLER_INFOS.find((s) => s.name.toLowerCase().replace(/[\s_-]+/g, "") === key);
}

/**
 * 按名称查找调度器信息（不区分大小写）。
 */
export function findSchedulerInfo(name: string): SchedulerInfo | undefined {
  const key = name.toLowerCase();
  return SCHEDULER_INFOS.find((s) => s.name.toLowerCase() === key);
}
