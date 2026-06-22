/** 单个模式下可用模型 + 是否可选(false = 后端硬编码,只读展示)。 */
export interface ModeModels {
  models: string[];
  editable: boolean;
}

export interface ModelsResponse {
  checkpoints: string[];
  samplers: string[];
  schedulers: string[];
  /** 模式感知模型源:image/video/model3d/audio → {models, editable}。 */
  modes?: Record<string, ModeModels>;
}

/** 叠加的单个 LoRA:文件名 + 权重(同时作用于 model 与 clip)。 */
export interface LoraInput {
  name: string;
  weight: number;
}

export interface Txt2ImgParams {
  positive: string;
  negative: string;
  ckpt_name: string;
  width: number;
  height: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed?: number | null;
  batch_size?: number;
  loras?: LoraInput[];
}

export interface GenerateResponse {
  prompt_id: string;
  client_id: string;
  worker: string;
  seed: number;
}

export interface GenResult {
  id: string;
  url: string;
  prompt: string;
  seed: number;
  ckpt: string;
}

export type GenMode = "txt2img" | "img2img";

export interface Img2ImgGenParams {
  positive: string;
  negative: string;
  ckpt_name: string;
  image: string;
  worker: string;
  denoise: number;
  steps: number;
  cfg: number;
  sampler: string;
  scheduler: string;
  seed?: number | null;
  loras?: LoraInput[];
}

export interface Usage {
  total: number;
  by_kind: Record<string, number>;
}

export interface AdminUser {
  id: string;
  email: string;
  role: string;
  created_at: string;
  usage: Usage;
}

export interface JobItem {
  id: string;
  prompt_id: string;
  kind: string;
  status: string;
  prompt: string;
  seed: number;
  created_at: string;
  results: string[];
}

export type LocalModels = Record<string, string[]>;

export interface MarketItem {
  id: string;
  name: string;
  type: string | null;
  creator: string | null;
  thumbnail: string | null;
  downloads: number | null;
  url: string;
  source: string;
}

export type GenStatus = "idle" | "queued" | "running" | "error";

export interface Progress {
  value: number;
  max: number;
}
