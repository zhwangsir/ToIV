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
  modes?: Record<string, ModeModels>;
  /** 扁平带标签列表(向后兼容,来自 modes.image.checkpoints)。 */
  checkpoints_tagged?: CheckpointTag[];
  nsfw_models?: string[];
  vpred_models?: string[];
}

/** 叠加的单个 LoRA:文件名 + 权重(同时作用于 model 与 clip)。 */
export interface LoraInput {
  name: string;
  weight: number;
}

export interface StylePreset {
  id: string;
  label: string;
  ckpt_name: string;
  media: "image" | "video";
  width: number;
  height: number;
  description: string;
  llm_layer: string;
  commercial_safe: boolean;
  /** 三层联动(2026-08-18):回显与优化注入用字段 */
  recommended_steps?: number | null;
  recommended_cfg?: number | null;
  recommended_sampler?: string | null;
  recommended_scheduler?: string | null;
  prompt_hint?: string;
  negative_prompt?: string;
  /** 预设选中后 OptimizeButton 智能预选的内置 skill id(空=无推荐) */
  recommended_skill?: string;
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
  style_preset?: string;
  engine?: "comfyui" | "forge";
}

export interface GenerateResponse {
  prompt_id: string;
  client_id: string;
  worker: string;
  seed: number;
  /** 时长策略提示(网格裁切/分段续写时后端给的人话说明;结果区 muted 展示) */
  duration_notice?: string;
  /** QUEUE-2026-08-18:提交时实例队列前方的作业数(>0 = 已排队等待,非故障);
   *  仅 H3 等专用实例返回,pool 引擎无此字段 */
  queued_behind?: number;
  /** RES-2026-08-18:融合超分挂链提示(选了输出分辨率档时返回;
   *  生成完成后自动二次超分,结果卡先显示「超分中」) */
  upscale_notice?: string;
}

// ── LTX2.3 视频生成(NSFW 专区)──
export interface LtxT2VParams {
  positive: string;
  negative?: string;
  width: number;
  height: number;
  /** 时长(秒),优先于 length;网格/裁切由后端统一策略层负责 */
  duration_sec?: number;
  /** 兼容入参(deprecated):帧数 8k+1,9-241 */
  length?: number;
  fps: number;
  steps: number;
  cfg: number;
  seed?: number | null;
  use_upscale: boolean;
  use_rife: boolean;
  /** RES-2026-08-18:输出分辨率档(720p/1080p/2k/4k);缺省原生直出 */
  resolution_target?: string;
}

export interface LtxI2VParams extends LtxT2VParams {
  image: string;
  worker: string;
}

export interface LtxLipsyncParams extends LtxT2VParams {
  image: string;
  audio: string;
  worker: string;
  id_lora?: string;
  id_lora_strength?: number;
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
  style_preset?: string;
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
  /** R18 标记:仅 /nsfw 专区(带 X-NSFW)列表含 R18 作品,前端据此过滤专区作品库。 */
  nsfw?: boolean;
  /** 时长后处理标记:processing 时 results 为未裁原片,结果区应显示「精确裁切中」;
   *  清零后 results 为终产物(trim/extend 完成后回写)。 */
  post_status?: string;
}

/** 回收站条目(2026-08-23):作品库字段 + 删除时间/恢复截止/剩余秒数(72h 保留期)。 */
export interface TrashJobItem extends JobItem {
  /** 软删除时间(ISO)。 */
  deleted_at: string;
  /** 恢复截止时间(ISO,= deleted_at + 72h);到期由后端清理任务物理删除。 */
  restore_expires_at: string;
  /** 距彻底删除的剩余秒数(后端按当前时间算出,前端直接格式化展示)。 */
  restore_remaining_seconds: number;
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

/** NSFW 模型推荐项(后端 GET /api/models/nsfw-recommendations 静态清单)。 */
export interface NsfwRecommendation {
  name: string;
  type: string;
  base: string;
  size: string;
  civitai_url: string;
  desc: string;
  category: string;
  /** civitai 版本 id:多版本模型精确指定(空=最新版),如 H3 LoRA 避开 10Eros/LTX 版 */
  version_id?: string;
}

export type GenStatus = "idle" | "queued" | "running" | "error";

export interface Progress {
  value: number;
  max: number;
}

// ---------------------------------------------------------------------------
// LoRA 训练(D 期)
// ---------------------------------------------------------------------------

export interface TrainProgress {
  step: number;
  total: number;
  loss: number;
  recent_losses: number[];
}

export interface TrainJob {
  id: string;
  name: string;
  base_ckpt: string;
  trigger_words: string;
  status: "queued" | "captioning" | "training" | "sampling" | "done" | "error";
  progress: TrainProgress | null;
  lora_path: string;
  sample_urls: string[];
  error: string;
  created_at: string;
  lr: number;
  steps: number;
  network_dim: number;
  cuda_device: number;
}

export interface TrainStartParams {
  job_id: string;
  name: string;
  base_ckpt: string;
  trigger_words: string;
  lr: number;
  steps: number;
  network_dim: number;
  network_alpha: number;
  resolution: number;
  batch_size: number;
  cuda_device: number;
}
