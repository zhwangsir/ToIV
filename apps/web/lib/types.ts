/** 图像底模的分类标(后端 /api/models 的 modes.image.checkpoints)。 */
export interface CheckpointTag {
  name: string;
  nsfw: boolean;
  vpred: boolean;
  /** 模型族:flux2/qwen_image/z_image/pony/sdxl_anime/sdxl/sd15 等。 */
  family?: string;
  /** 是否次世代(UNET 图,服务端强制采样)。 */
  nextgen?: boolean;
  /** 该模型负向提示词是否有效(false = 次世代蒸馏档,前端隐藏负向框)。 */
  neg?: boolean;
}

/** 单个模式下可用模型 + 是否可选(false = 后端硬编码,只读展示)。 */
export interface ModeModels {
  models: string[];
  editable: boolean;
  /** 仅 image 模式:每个底模的族/次世代/负向标,供前端按族自适应 UI。 */
  checkpoints?: CheckpointTag[];
  /** 仅 image 模式:平台默认底模(settings.default_ckpt);前端初始选中对齐它。 */
  default?: string | null;
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
  /** 出图引擎:comfyui(默认,异步工作流)| forge(reForge sdapi 同步出图)。 */
  engine?: "comfyui" | "forge";
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
  /** 版本树:父版本 job id(空=根)。 */
  parent_id?: string;
  /** 版本树根 job id(后端已归一,同链同根;前端按它分组)。 */
  root_id?: string;
  /** 有参数快照才能精确重生(旧数据无)。 */
  has_params?: boolean;
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
