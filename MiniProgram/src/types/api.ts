/**
 * API DTO 类型 —— 与 apps/api 后端契约对齐（移植自 Mobile/src/types/api.ts，逐字段一致）
 * 字段保持后端 snake_case 原样，API 层不做命名转换（少一层映射少一类错）
 * 注意：/api/auth/login 返回字段是 token（不是 access_token），见根仓库 AGENTS.md 易错点 10
 */

export interface AppUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthResult {
  token: string;
  user: AppUser;
}

/** POST /api/auth/wechat 请求体（MP31：code 来自 uni.login；nickname 可选，首登建档展示用） */
export interface WechatLoginRequest {
  code: string;
  nickname?: string;
}

/** GET /api/auth/me 响应：usage 为用量快照，结构以后端为准（暂只透传） */
export interface MeResult {
  user: AppUser;
  usage?: unknown;
}

// ── 作业（GET /api/jobs，list_jobs 原样返回数组，最新在前）──

/** 后端 Job.status：queued | running | done | error（jobs.py list_jobs docstring） */
export type JobStatus = 'queued' | 'running' | 'done' | 'error';

/** 对应 routes/jobs.py `_job_dict` 输出形状 */
export interface JobItem {
  id: string;
  prompt_id: string;
  kind: string;
  status: JobStatus;
  prompt: string;
  seed: number;
  /** ISO 时间字符串（created_at.isoformat()） */
  created_at: string;
  /** 产物相对路径数组（拼 mediaUrl 后可加载） */
  results: string[];
  /** 时长后处理标记（trim/extend）：processing 时 results 为未裁原片,
   *  结果区应显示「精确裁切中」;清零后 results 为终产物 */
  post_status?: string;
  nsfw: boolean;
  parent_id: string;
  root_id: string;
  has_params: boolean;
}

// ── 引擎注册表（GET /api/models/engines → { engines, count }）──

export type EngineKind = 'image' | 'video' | 'audio';

export type EngineParamType =
  | 'text'
  | 'textarea'
  | 'number'
  | 'select'
  | 'switch'
  | 'images'
  | 'video'
  | 'audio'
  | 'loras';

export interface EngineParamOption {
  value: string;
  label: string;
  nsfw?: boolean;
}

export interface EngineParam {
  key: string;
  label: string;
  type: EngineParamType;
  options?: EngineParamOption[];
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  hint?: string;
}

/** 引擎模型来源（后端 M9 起透传，展示用） */
export interface EngineSource {
  name: string;
  url: string;
  author: string;
  note?: string;
}

export interface EngineInfo {
  id: string;
  label: string;
  kind: EngineKind;
  available: boolean;
  unavailable_reason?: string;
  nsfw: boolean;
  description?: string;
  source?: EngineSource;
  params: EngineParam[];
}

// ── 文生图提交（POST /api/generate/txt2img → GenerateResponse）──

/** 对应 routes/generate.py Txt2ImgRequest（默认值与边界与后端一致） */
export interface Txt2ImgRequest {
  positive: string;
  negative?: string;
  ckpt_name?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number | null;
  batch_size?: number;
  style_preset?: string;
}

export interface GenerateResponse {
  prompt_id: string;
  client_id: string;
  worker: string;
  seed: number;
}

// ── 作业进度 SSE（GET /api/jobs/{prompt_id}/events，MP29，契约见 apps/api routes/jobs.py job_events）──

/** 事件类型：progress {value,max} / done {images} / error {message} / quality_warning（质量评分对象） */
export type JobSseEventType = 'progress' | 'done' | 'error' | 'quality_warning';

export interface JobSseEvent {
  type: JobSseEventType;
  data: Record<string, unknown>;
}

// ── 图生图（POST /api/upload → POST /api/generate/img2img，契约见 Mobile TEST_LOG M8）──

/** POST /api/upload 响应：上传落点 worker 必须与后续生成同机（generate.py resolve_worker） */
export interface UploadImageResult {
  filename: string;
  worker: string;
}

// ── 反推提示词（POST /api/reverse，契约见 apps/api/app/routes/reverse.py）──

/**
 * POST /api/reverse 响应：kind 由后端按 content-type/扩展名判定
 * negative 仅图像反推可能返回（视频/音频无）；meta 音频转写细节暂不透传
 */
export interface ReverseResult {
  kind: string;
  prompt: string;
  negative: string | null;
}

// ── 优化提示词（POST /api/optimize，契约见 apps/api/app/routes/optimize.py）──

/**
 * POST /api/optimize 响应：optimized 恒有值
 * negative 仅 image/image_edit/video 类返回（audio 等单段类无）；解析失败时后端启发式兜底
 */
export interface OptimizeResult {
  optimized: string;
  negative: string | null;
}

/**
 * 已上传参考图句柄：服务端 filename/worker + 本地预览
 * 作为表单 images 参数的值载体（选中即传，对齐 Web RefImageUpload 模式）
 */
export interface UploadedRefImage {
  filename: string;
  worker: string;
  /** 本地临时文件预览地址（chooseImage tempFilePath） */
  previewUri: string;
  name: string;
}

/**
 * 对应 routes/generate.py Img2ImgRequest（默认值与边界与后端一致）
 * 注意：无 width/height/batch_size —— 输出尺寸随输入参考图
 */
export interface Img2ImgRequest {
  positive: string;
  /** /api/upload 返回的文件名 */
  image: string;
  /** 图片上传到的 worker（生成必须同机） */
  worker: string;
  negative?: string;
  ckpt_name?: string;
  style_preset?: string;
  /** 重绘幅度 0.1-1.0，默认 0.6 */
  denoise?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number | null;
}

// ── 版本链（POST /api/jobs/{key}/rerun / GET /api/jobs/{key}/versions，key 兼容 id 与 prompt_id）──

/** keep=锁 seed 微调 / random=换 seed 重抽 / explicit=指定 seed（需带 seed） */
export type SeedMode = 'keep' | 'random' | 'explicit';

/** 对应 routes/jobs.py RerunRequest（overrides 仅接受该类型请求模型认识的字段） */
export interface RerunRequest {
  seed_mode?: SeedMode;
  seed?: number | null;
  overrides?: Record<string, unknown>;
}

/** rerun 响应 = 原生成端点返回 + 版本链关系（jobs.py rerun_job 补挂） */
export interface RerunResponse extends GenerateResponse {
  job_id?: string;
  parent_id?: string;
  root_id?: string;
}

// ── SFW 视频引擎（POST /api/wan/* 等，契约见 routes/wan_studio.py；LTX-2.5 已于 2026-08-23 退役）──

/**
 * 已上传驱动视频句柄：服务端 filename/worker + 本地预览
 * 作为表单 video 类型参数的值载体（wan-animate，与参考图互钉同 worker）
 */
export interface UploadedRefVideo {
  filename: string;
  worker: string;
  /** 本地临时文件预览地址（chooseVideo tempFilePath） */
  previewUri: string;
  name: string;
  /** 时长（秒，chooseVideo 返回；可能缺失） */
  duration?: number;
}

/**
 * 对应 routes/wan_studio.py WanAnimateRequest（POST /api/wan/animate）
 * image=参考图 / video=驱动视频 / worker=参考图落点（上传时已互钉）
 * width 默认 832 / height 默认 480（320-1280，step16）/ duration_sec 默认 7.5（内部 17-501 帧 4k+1）
 * steps 默认 6 / fps 默认 16（8-30）；cfg/shift/relight_lora 后端默认，不传
 */
export interface WanAnimateRequest {
  positive: string;
  image: string;
  video: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算（4k+1 网格吸附/裁切） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/wan_studio.py WanVaceRequest（POST /api/wan/vace）
 * images=1-4 张参考图文件名（全部互钉同 worker），worker=第一张图落点
 * duration_sec 默认 5（内部 17-241 帧 4k+1）/ steps 默认 20 / fps 默认 16
 * start_image/end_image 注册表未暴露，不传
 */
export interface WanVaceRequest {
  positive: string;
  images: string[];
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算 */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

// ── H3 / LongCat / ACE 引擎（POST /api/h3/*、/api/longcat/*、/api/generate/audio，契约见 routes/h3_studio.py / longcat_studio.py / audio.py）──

/**
 * H3 LoRA 叠加项（routes/h3_studio.py H3LoraInput）
 * name 为 H3 实例 LoRA 文件名（.safetensors）；strength 0.5-1.0，缺省 0.6（作者推荐）
 */
export interface LoraValue {
  name: string;
  strength: number;
}

/**
 * 对应 routes/h3_studio.py H3T2VRequest（POST /api/h3/t2v）
 * width 默认 1344 / height 默认 768（256-1344，32 对齐）
 * duration_sec 时长秒（0.5-60，内部 17k+5 网格/超 15s 自动分段续写）/ steps 默认 20（1-50）
 * 无 fps/cfg（模板内锁定 24fps）；loras 最多 3 个
 */
export interface H3T2VRequest {
  positive: string;
  negative?: string;
  loras?: LoraValue[];
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算（注册表 duration 参数映射） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  length?: number;
  steps?: number;
  seed?: number | null;
}

/** 对应 routes/h3_studio.py H3I2VRequest（POST /api/h3/i2v）：image/worker 必填（上传落 pool worker，后端转运 H3 实例） */
export interface H3I2VRequest extends H3T2VRequest {
  image: string;
  worker: string;
}

/**
 * 对应 routes/longcat_studio.py LongCatT2VRequest（POST /api/longcat/t2v）
 * width 默认 832 / height 默认 480（320-1280，16 对齐向下取整）
 * duration_sec 时长秒（默认 7.5，内部 17-961 帧；>241 帧自动上下文窗口）/ steps 默认 10 / fps 默认 16（8-30）
 * 无 cfg（蒸馏链路固定 1.0）
 */
export interface LongCatT2VRequest {
  positive: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算（注册表 duration 参数映射） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/** 对应 routes/longcat_studio.py LongCatI2VRequest（POST /api/longcat/i2v）：image/worker 必填（同 h3-i2v 转运模式） */
export interface LongCatI2VRequest extends LongCatT2VRequest {
  image: string;
  worker: string;
}

/**
 * 对应 routes/longcat_studio.py LongCatContinueRequest（POST /api/longcat/continue）
 * video = /api/images? 产物 URL 或上传视频文件名（后者需 worker，本端只支持产物 URL 路径）
 * width/height/fps 可空：缺省向源视频实测值对齐（ffprobe），本端空值省略不传
 */
export interface LongCatContinueRequest {
  video: string;
  worker?: string;
  positive: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），默认 7.5（内部 17-961 帧） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/audio.py AudioRequest（POST /api/generate/audio）
 * tags=风格标签（主提示词映射）/ lyrics 留空=纯音乐（支持 [verse]/[chorus] 结构标签）
 * seconds 默认 30（5-240）/ steps 默认 50（10-150）/ cfg 默认 5（0-20）
 */
export interface AceMusicRequest {
  tags: string;
  lyrics?: string;
  seconds?: number;
  steps?: number;
  cfg?: number;
  seed?: number | null;
}

// ── R18 视频引擎（MP12，契约已读 apps/api 源码验证：routes/video.py / engine_registry.py；仅 NSFW 上下文可见）──

/**
 * 已上传驱动音频句柄：服务端 filename/worker + 本地展示名
 * 作为表单 audio 参数的值载体（选中即传，对齐 Web RefAudioUpload / Mobile M11 模式）
 */
export interface UploadedRefAudio {
  filename: string;
  worker: string;
  name: string;
}

/**
 * 对应 routes/video.py LtxT2VRequest（POST /api/generate/ltx-t2v，R18 专区 10Eros 底模）
 * width 256-1920 默认 768；height 256-1080 默认 384
 * duration_sec 时长秒（R18 预设 4/6/8/10/15 直传，内部 8k+1 网格/裁切由后端统一策略层负责）
 * 本端 width/height 由 resolution 预设换算、duration_sec 由 duration 预设直传（对齐 Web _ltxNsfwPayload），不直接暴露数值
 */
export interface LtxNsfwT2VRequest {
  positive: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），R18 预设直传 */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  length?: number;
  fps?: number;
  steps?: number;
  cfg?: number;
  seed?: number | null;
  /** 高清放大（2 阶段），默认 false */
  use_upscale?: boolean;
  /** RIFE 补帧，默认 false */
  use_rife?: boolean;
  /** 省略=AI 选配; []=关闭; 非空=钉选 */
  loras?: LoraValue[];
}

/**
 * 对应 routes/video.py LtxI2VRequest（POST /api/generate/ltx-i2v）：t2v 全集 + 参考图落点
 * image/worker 必须来自同一次 /api/upload 响应（kind=ltx_i2v；LTX2.3 跑在 pool worker 上，生成同机无转运）
 */
export interface LtxNsfwI2VRequest extends LtxNsfwT2VRequest {
  /** /api/upload 返回的文件名 */
  image: string;
  /** 图片上传到的 worker（防 SSRF，生成同机） */
  worker: string;
}

/**
 * 对应 routes/video.py LtxLipsyncRequest（POST /api/generate/ltx-lipsync）：图生视频 + 音频驱动 + ID LoRA
 * 参考图与驱动音频须同 worker（上传时互钉，kind=ltx_lipsync）
 */
export interface LtxNsfwLipsyncRequest extends LtxNsfwI2VRequest {
  /** /api/upload 返回的音频文件名 */
  audio: string;
  /** worker loras 目录内身份保持 LoRA 文件名，留空不用 */
  id_lora?: string;
  /** ID LoRA 强度 0-2，默认 0.8 */
  id_lora_strength?: number;
}

// h3-nsfw-t2v / h3-nsfw-i2v 复用 H3T2VRequest / H3I2VRequest（与 SFW 同一 POST /api/h3/* 提交链路，
// 专区内自带 X-NSFW 头，后端据此打标进 R18 作品库并放行 R18 LoRA 门控）

// ── LongCat-Avatar 数字人（MP14，契约见 routes/avatar_studio.py AvatarTalkRequest）──

/**
 * 对应 routes/avatar_studio.py AvatarTalkRequest（POST /api/avatar/talk）
 * image=人像首帧 / audio=驱动音频 / worker=两者上传落点（同机互钉）
 * width 默认 480 / height 默认 832（320-1280，16 对齐向下取整）
 * duration_sec 时长秒（默认 3.7，内部 17-2500 帧 4k+1 网格；>93 帧自动链式续段）/ fps 默认 25（8-30）
 * steps 默认 12（1-50）/ shift 默认 12.0 / cfg 默认 1.0 / dmd_lora_strength 默认 1.0
 */
export interface AvatarTalkRequest {
  positive: string;
  image: string;
  audio: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算（注册表 duration 参数映射） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  fps?: number;
  steps?: number;
  shift?: number;
  cfg?: number;
  dmd_lora_strength?: number;
  seed?: number | null;
}

// ── 引擎补齐（qwen-image-edit / h3-multishot / wan-transition / keyframe-chain / vace-edit / wan-animate-2 / wan-nsfw-i2v）──

/**
 * 对应 routes/generate.py QwenEditRequest（POST /api/generate/qwen-edit）
 * image/worker 必填（源图落点；后端转存到 Qwen 专用实例 :8194）
 * positive 可空（纯相机操作）；camera 与 azimuth/elevation/distance 互斥
 * fast 默认 true=Lightning 8 步；false=20 步标准档
 */
export interface QwenEditRequest {
  image: string;
  worker: string;
  positive?: string;
  camera?: string;
  azimuth?: number;
  elevation?: number;
  distance?: string;
  fast?: boolean;
  seed?: number | null;
}

/**
 * 对应 routes/h3_studio.py H3ShotInput（多镜头单条）
 * duration_sec 全空时由 total_duration 均分；camera_hint/transition_hint 可选白名单
 */
export interface H3ShotInput {
  prompt: string;
  duration_sec?: number;
  camera_hint?: string;
  transition_hint?: string;
}

/**
 * 对应 routes/h3_studio.py H3MultiShotRequest（POST /api/h3/multishot）
 * shots 2-4 个；总长 ≤15s H3 单段上限；无 fps/cfg（模板内锁定 24fps）
 */
export interface H3MultiShotRequest {
  shots: H3ShotInput[];
  total_duration?: number;
  negative?: string;
  loras?: LoraValue[];
  width?: number;
  height?: number;
  steps?: number;
  seed?: number | null;
  effect_preset?: string;
  resolution_target?: string;
}

/**
 * 对应 routes/wan_studio.py TransitionRequest（POST /api/generate/transition）
 * first_frame/last_frame 为上传句柄文件名（互钉同 worker）；时长走 duration_sec
 */
export interface WanTransitionRequest {
  positive: string;
  first_frame: string;
  last_frame: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/wan_studio.py KeyframeChainRequest（POST /api/generate/keyframe-chain）
 * keyframes 2-5 张（链序，互钉同 worker）；prompts 单 string 全段共用
 * durations 缺省每段 5s；响应额外带 segments/total_duration（client_id 可能缺省）
 */
export interface KeyframeChainRequest {
  keyframes: string[];
  prompts: string | string[];
  worker: string;
  durations?: number[];
  negative?: string;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/wan_studio.py WanVaceEditRequest（POST /api/generate/video-edit）
 * source_video 源视频句柄；edit_prompt 英文编辑指令；edit_mode 五选一
 * 时长上限 10s；关键帧锚点/区域 mask 本端一期不传（Web 走专用编辑器）
 */
export interface VaceEditRequest {
  source_video: string;
  edit_prompt: string;
  edit_mode?: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  steps?: number;
  cfg?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/wan_studio.py WanAnimate2Request（POST /api/wan/animate2）
 * image=参考图 / video=驱动视频 / worker=参考图落点（上传时已互钉）
 * positive 可空：后端 VLM 自动反推外观 caption；steps 默认 10
 */
export interface WanAnimate2Request {
  positive?: string;
  image: string;
  video: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  duration_sec?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/video.py WanI2VRequest（POST /api/generate/video，R18 wan-nsfw-i2v）
 * length 为 4n+1 帧（固定 16fps：3s→49 / 5s→81 / 7.5s→121）；loras 最多 4 个
 * 满血档 full_quality 不挂加速 LoRA
 */
export interface WanNsfwI2VRequest {
  positive: string;
  image: string;
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  length?: number;
  fps?: number;
  seed?: number | null;
  loras?: LoraValue[];
  full_quality?: boolean;
  effect_preset?: string;
  resolution_target?: string;
}

// ── 参考资产库（MP13，契约见 apps/api routes/reference_assets.py）──

/** 资产类别：角色/场景/道具/风格卡（后端 AssetKind Literal） */
export type AssetKind = 'character' | 'scene' | 'prop' | 'style';

/** 资产参考图句柄：/api/upload 返回的 {filename, worker}，文件本体不重复存储 */
export interface AssetImage {
  filename: string;
  worker: string;
}

/** 对应 reference_assets.py AssetOut（created_at/updated_at 为 ISO 字符串） */
export interface AssetItem {
  id: string;
  kind: AssetKind;
  name: string;
  description: string;
  images: AssetImage[];
  nsfw: boolean;
  created_at: string;
  updated_at: string;
}

/** POST /api/assets 请求体（name 1-100 / description ≤2000 / images 1-4 张，后端 422 兜底） */
export interface AssetCreateBody {
  kind: AssetKind;
  name: string;
  description: string;
  images: AssetImage[];
  nsfw: boolean;
}

/** PATCH /api/assets/{id} 请求体：仅非空（undefined 省略）字段生效 */
export interface AssetPatchBody {
  kind?: AssetKind;
  name?: string;
  description?: string;
  images?: AssetImage[];
  nsfw?: boolean;
}

// ── 文档挂载（MP20，契约已读 apps/api 源码验证：routes/documents.py / services/docs.py）──

/**
 * 对应 routes/documents.py `_doc_dict`（POST /docs/upload 201 / GET /docs 列表项）
 * status：ready=已索引 / partial=部分索引（超长截断） / no_embed=未索引（向量服务不可用）；
 * 后端未来新增状态时原样透传，展示层 docStatusLabel 兜底
 */
export interface DocItem {
  id: string;
  filename: string;
  /** 文档类型（pdf/docx/txt/md，由扩展名判定，services/docs.py _KINDS） */
  kind: string;
  /** 字节数 */
  size: number;
  chunk_count: number;
  status: string;
  /** ISO 时间字符串（created_at.isoformat()） */
  created_at: string;
}

// ── 对话助手（MP19，契约已读 apps/api/app/routes/agent.py / agent/runner.py 源码验证）──

/** SSE msg 事件载荷（runner.py yield 形状）：text 文本段 / tool 工具调用 / image·video·audio·model3d 媒体结果 / error */
export type AgentEventType = 'text' | 'tool' | 'image' | 'video' | 'audio' | 'model3d' | 'error';

export interface AgentEvent {
  type: AgentEventType;
  /** text / error 事件的文本内容 */
  content?: string;
  /** tool 事件的工具名 */
  name?: string;
  /** 媒体事件的产物相对路径数组（拼 mediaUrl 后可加载） */
  urls?: string[];
  /** tool 事件的入参（runner JSON.parse 失败兜底 {}） */
  args?: unknown;
  /** 媒体事件的产出 worker（展示暂不用） */
  worker?: string;
}

/** POST /api/agent/chat 请求消息（ChatMessage：role + content，content ≤32768） */
export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * ChatRequest.image（MP30）：用户随消息上传的单张图片（uploadImage kind=img2img 句柄）
 * runner 注入系统提示「用户上传了一张图片」并把 attachment 传给 edit_image/generate_3d 工具
 * （从 worker input 目录读字节）；后端用户消息落库不含 attachment，回放历史气泡无图
 */
export interface AgentChatImage {
  filename: string;
  worker: string;
}

/** GET /api/agent/sessions 列表项（updated_at 倒序） */
export interface AgentSessionSummary {
  id: string;
  title: string;
  nsfw: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** 历史消息媒体挂接（tool 消息产出：{type, urls}，_message_dict 原样 JSON） */
export interface AgentSessionMedia {
  type: string;
  urls: string[];
}

/** GET /api/agent/sessions/{sid} 的消息项（id 升序即对话顺序；tool_calls 无内容时为 null） */
export interface AgentSessionMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls: unknown;
  media: AgentSessionMedia[];
  created_at: string;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

// ── Agent 团队监控（MP21 一期：只读 + 取消，契约已读 apps/api/app/routes/agent_team.py
//    + services/agent_team_exec.py / agent_team_graph.py 源码验证）──

/**
 * run 状态全集（models.py AgentRun.status；_TERMINAL = done/error/canceled）
 * planning = reject 后重规划挂起态；awaiting_confirm/awaiting_assembly = 两道人工确认门
 */
export type AgentRunStatus =
  | 'planning'
  | 'awaiting_confirm'
  | 'running'
  | 'awaiting_assembly'
  | 'done'
  | 'error'
  | 'canceled';

/** GET /api/agent-runs 列表项 task_counts（approved 计入 done，agent_team.py list_agent_runs） */
export interface AgentRunTaskCounts {
  total: number;
  done: number;
  error: number;
}

/** GET /api/agent-runs 列表项（created_at 倒序，最新在前） */
export interface AgentRunSummary {
  id: string;
  level: string;
  goal: string;
  status: string;
  /** ISO 时间字符串（created_at.isoformat()） */
  created_at: string;
  task_counts: AgentRunTaskCounts;
}

/**
 * 任务卡片详情（agent_team.py _task_detail：input/output/verdict 已解析为对象）
 * status：pending | queued | running | verifying | rejected | approved | done | error
 * （后端未来新增状态时原样透传，展示层 taskStatusMeta 兜底）
 */
export interface AgentRunTask {
  id: string;
  kind: string;
  title: string;
  depends_on: string[];
  status: string;
  attempt: number;
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  verdict: Record<string, unknown>;
  gpu_hint: string;
}

/** GET /api/agent-runs/{id} 详情（plan = 全任务卡片，非嵌套 {tasks} 包法） */
export interface AgentRunDetail {
  id: string;
  goal: string;
  level: string;
  status: string;
  error: string;
  plan: AgentRunTask[];
  created_at: string;
  updated_at: string;
}

/**
 * POST /api/agent-runs/{id}/cancel 响应（409 终态不可取消由 apiFetch 人话透传）
 */
export interface AgentRunCancelResult {
  run_id: string;
  status: string;
}

/**
 * POST /api/agent-runs/{id}/resume 请求体（agent_team.py ResumeRequest，gate/action 正则受限）
 * gate=plan：仅 awaiting_confirm/planning 可裁决；gate=assembly：仅 awaiting_assembly（否则 409 人话透传）
 * action：approve 通过 / reject 打回（feedback 可选方向性批注）/ modify 仅记录裁决
 * （run 保持挂起态；实际改动走 POST /plan 计划编辑，MP23 起由计划门编辑面板组合投递）
 */
export interface AgentResumeBody {
  gate: 'plan' | 'assembly';
  action: 'approve' | 'modify' | 'reject';
  feedback?: string;
}

/** POST /api/agent-runs/{id}/resume 响应（与 cancel 同形：{run_id, status}） */
export type AgentRunResumeResult = AgentRunCancelResult;

// ── Agent 团队三期（MP23：计划编辑 POST /plan + 成片结果 GET /result，
//    契约已读 agent_team.py edit_plan 450-503 / run_result 664-697 源码确认）──

/**
 * POST /api/agent-runs/{id}/plan 计划编辑单条操作（agent_team.py PlanEditOp，Flowith 式）
 * 仅 run.status === 'awaiting_confirm' 可投，否则 409「仅待确认状态可编辑计划」
 * - update：title 非 null 直接改；input 非空按键合并（不动未提交字段）；id 不存在 404「任务不存在:{id}」
 * - remove：按 id 删；服务端自动清理其他任务 depends_on 悬挂引用
 * - add：id 可前端预生成（保持 DAG 引用稳定）；kind/depends_on 从 input 读（默认 'video'/[]，被 pop 不存 input_json）；
 *   title 缺省「新任务」
 */
export interface AgentPlanEditOp {
  id: string;
  action: 'update' | 'remove' | 'add';
  title?: string | null;
  input?: Record<string, unknown> | null;
}

/**
 * POST /plan 响应内 tasks 项：_task_brief 简报（无 input/output/verdict/attempt/gpu_hint）
 * 调用方用 mergePlanTasks 合并进本地详情，保留已有卡片详情字段
 */
export type AgentRunTaskBrief = Pick<AgentRunTask, 'id' | 'kind' | 'title' | 'depends_on' | 'status'>;

/** POST /api/agent-runs/{id}/plan 响应（edit_plan 返回 + 推 plan SSE 事件） */
export interface AgentRunPlanResult {
  run_id: string;
  plan: { tasks: AgentRunTaskBrief[] };
}

/** GET /result 响应内 tasks 项（run_result 产物清单：仅 id/title/kind/status/output 五字段） */
export interface AgentRunResultTask {
  id: string;
  title: string;
  kind: string;
  status: string;
  output: Record<string, unknown>;
}

/**
 * GET /api/agent-runs/{id}/result 响应（run_result）
 * 仅 run.status === 'done'，否则 409「任务尚未完成」
 * final_url 取自 assemble 卡（kind='assemble' 且 status='done'）的 output.url；
 * duration_sec 为 video/image 卡 input.duration_sec 合计
 */
export interface AgentRunResult {
  final_url: string;
  duration_sec: number;
  tasks: AgentRunResultTask[];
}

/**
 * POST /api/agent-runs/{id}/tasks/{tid}/action 请求体（agent_team.py TaskActionRequest）
 * - edit：payload={input:{...}} 合并进任务 input，卡片回 pending 待重跑
 * - regenerate：payload={guidance?} 引导词拼进主文案；仅 done/error 卡片可重生（assemble 卡走合成确认门）
 * - approve：卡片置 approved（计入 done）
 * - upload：payload={url} 替换产物（仅本地产物；合成卡 400）；本地文件直传走 uploadAgentTaskAsset
 * - reprompt：反推产物提示词写回 input（仅图像/视频卡；MP33 起本端出入口）
 */
export interface AgentTaskActionBody {
  action: 'edit' | 'regenerate' | 'approve' | 'upload' | 'reprompt';
  payload?: Record<string, unknown>;
}

/**
 * SSE 业务事件（agent_team_exec.py _emit：event 名为 type，data 为 payload_json 原样）
 * 已知 type：ack{message,level} / plan{tasks:简报数组} / task_status{task_id?,status,title?,output?,gpu_hint?}
 * （cancel 时无 task_id，载荷 {run_id,status:'canceled'}）/ blocked{task_id,title,error}
 * / confirm_required{gate,message} / done{run_id,final_url} / error{message,failed?}
 * verdict / decision_required 为 Web 契约预留（后端本期未发，解析层容错透传）
 */
export interface AgentRunSseEvent {
  type: string;
  data: Record<string, unknown>;
}
