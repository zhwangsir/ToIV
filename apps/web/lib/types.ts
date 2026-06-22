export interface ModelsResponse {
  checkpoints: string[];
  samplers: string[];
  schedulers: string[];
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
