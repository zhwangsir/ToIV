/**
 * API DTO 类型 —— 与 apps/api 后端契约对齐（已读源码验证，见 TEST_LOG M4）
 * 字段保持后端 snake_case 原样，移动端 API 层不做命名转换（少一层映射少一类错）
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

/** GET /api/auth/me 响应：usage 为用量快照，结构以后端为准（移动端暂只透传） */
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
  | 'audio'
  | 'video'
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

/** 引擎模型出处（M9 起由后端注册表透传，对齐 Web EngineSource） */
export interface EngineSource {
  /** 模型官方名 */
  name: string;
  /** 出处链接（官方仓库/模型页） */
  url: string;
  /** 出品方 */
  author: string;
  /** 一句话定位（可选） */
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
  params: EngineParam[];
  /** 模型介绍与出处（注册表可选透传） */
  source?: EngineSource;
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

// ── 图生图（POST /api/upload → POST /api/generate/img2img，契约见 TEST_LOG M8）──

/** POST /api/upload 响应：上传落点 worker 必须与后续生成同机（generate.py resolve_worker） */
export interface UploadImageResult {
  filename: string;
  worker: string;
}

/**
 * 已上传参考图句柄：服务端 filename/worker + 本地预览
 * 作为表单 images 参数的值载体（选中即传，对齐 Web RefImageUpload 模式）
 */
export interface UploadedRefImage {
  filename: string;
  worker: string;
  /** 本地 file:// 预览地址 */
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

// ── SFW 视频引擎（M9，契约已读 apps/api 源码验证：routes/ltx25_studio.py / routes/wan_studio.py）──

/**
 * 对应 routes/ltx25_studio.py Ltx25T2VRequest（默认值与边界与后端一致）
 * width 256-1920 step32 默认 960；height 256-1088 默认 544
 * duration_sec 时长秒（0.5-60，内部 8k+1 网格/超 25s 自动分段续写）；length 为 deprecated 兼容入参
 */
export interface Ltx25T2VRequest {
  positive: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），直传由后端统一策略层换算（注册表 duration 参数映射） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  length?: number;
  fps?: number;
  steps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/ltx25_studio.py Ltx25I2VRequest：t2v 全集 + 参考图落点
 * image/worker 必须来自同一次 /api/upload 响应（生成与参考图同机）
 */
export interface Ltx25I2VRequest extends Ltx25T2VRequest {
  /** /api/upload 返回的文件名 */
  image: string;
  /** 图片上传到的 worker（生成必须同机，后端转运到 :8198 专用实例） */
  worker: string;
  /** 首帧强度 0-1 step0.05，默认 0.7 */
  strength?: number;
}

/**
 * 对应 routes/wan_studio.py WanAnimateRequest：参考图角色 + 驱动视频 → 动作迁移
 * cfg/shift/relight_lora 后端有默认，对齐 Web 不传
 */
export interface WanAnimateRequest {
  positive: string;
  /** 参考图文件名（/api/upload?kind=wan_animate 落点） */
  image: string;
  /** 驱动视频文件名（上传时钉参考图同 worker） */
  video: string;
  /** 参考图落点 worker（生成同机转运） */
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），默认 7.5（内部 17-501 帧 4k+1 网格吸附，秒差大时生成后精确裁切） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 对应 routes/wan_studio.py WanVaceRequest：多参考图（1-4 张）→ 一致性视频
 * start_image/end_image 注册表未暴露，对齐 Web 不传
 */
export interface WanVaceRequest {
  positive: string;
  /** 参考图文件名数组（1-4 张，全部互钉同 worker） */
  images: string[];
  /** 第一张参考图落点 worker */
  worker: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），默认 5（内部 17-241 帧 4k+1 网格吸附） */
  duration_sec?: number;
  /** deprecated：兼容入参，请改用 duration_sec */
  num_frames?: number;
  steps?: number;
  fps?: number;
  seed?: number | null;
}

/**
 * 已上传驱动视频句柄：服务端 filename/worker + 本地展示信息
 * 作为表单 video 参数的值载体（选中即传，对齐 Web RefVideoUpload 模式）
 */
export interface UploadedRefVideo {
  filename: string;
  worker: string;
  name: string;
  /** 视频时长（毫秒，取自 image-picker asset.duration；不可得为 null） */
  durationMs: number | null;
}

// ── H3 / LongCat / ACE 引擎（M10，契约已读 apps/api 源码验证：routes/h3_studio.py / longcat_studio.py / audio.py）──

/**
 * H3 LoRA 叠加项（routes/h3_studio.py H3LoraInput）
 * name 为 H3 实例 loras 目录内 .safetensors 文件名；strength 0.5-1.0，缺省 0.6（作者推荐）
 */
export interface LoraValue {
  name: string;
  strength: number;
}

/**
 * 对应 routes/h3_studio.py H3T2VRequest（POST /api/h3/t2v）
 * width 默认 1344 / height 默认 768（256-1344，32 对齐）
 * duration_sec 时长秒（0.5-60，内部 17k+5 网格/超 15s 自动分段续写）；length 为 deprecated 兼容入参
 * steps 默认 20（1-50）；无 fps/cfg（模板内锁定 24fps）；loras 最多 3 个
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
  /** /api/upload?kind=h3_i2v 返回的文件名 */
  image: string;
  /** 图片上传到的 pool worker（后端从该机转运 H3 实例） */
  worker: string;
}

/**
 * 对应 routes/longcat_studio.py LongCatT2VRequest（POST /api/longcat/t2v）
 * width 默认 832 / height 默认 480（320-1280，16 对齐向下取整）
 * duration_sec 时长秒（默认 7.5，内部 17-961 帧；>241 帧自动上下文窗口）
 * steps 默认 10 / fps 默认 16（8-30）；无 cfg（蒸馏链路固定 1.0）
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
  /** /api/upload 返回的文件名（kind 复用 ltx_i2v，对齐 Web GenerateView 回落） */
  image: string;
  /** 图片上传到的 pool worker（后端从该机转运 LongCat 实例） */
  worker: string;
}

/**
 * 对应 routes/longcat_studio.py LongCatContinueRequest（POST /api/longcat/continue）
 * video = /api/images? 产物 URL 或上传视频文件名（后者需 worker；本端注册表 text 参数走产物 URL 路径）
 * width/height/fps 可空：缺省向源视频实测值对齐（ffprobe），客户端空值省略不传
 */
export interface LongCatContinueRequest {
  /** 源视频产物 URL（如上一段 LongCat 产物链接） */
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

// ── R18 视频引擎（M11，契约已读 apps/api 源码验证：routes/video.py / engine_registry.py；仅 NSFW 上下文可见）──

/**
 * 已上传驱动音频句柄：服务端 filename/worker + 本地展示名
 * 作为表单 audio 参数的值载体（选中即传，对齐 Web RefAudioUpload 模式）
 */
export interface UploadedRefAudio {
  filename: string;
  worker: string;
  name: string;
}

/**
 * 对应 routes/video.py LtxT2VRequest（POST /api/generate/ltx-t2v，R18 专区 10Eros 底模）
 * width 256-1920 默认 768；height 256-1080 默认 384；length 9-241（8k+1 网格）默认 97
 * 移动端 width/height/length 由 resolution/duration 预设换算（对齐 Web _ltxNsfwPayload），不直接暴露数值
 */
export interface LtxNsfwT2VRequest {
  positive: string;
  negative?: string;
  width?: number;
  height?: number;
  /** 时长（秒），R18 预设直传由后端统一策略层换算（8k+1 网格/裁切） */
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

// ── LongCat-Avatar 数字人（M14，契约已读 apps/api 源码验证：routes/avatar_studio.py）──

/**
 * 对应 routes/avatar_studio.py AvatarTalkRequest（POST /api/avatar/talk）
 * image/audio 为 /api/upload?kind=avatar 上传句柄文件名，与 worker 同机（后端转运 LongCat :8197 实例）
 * width/height 320-1280 默认 480×832（16 对齐，非对齐后端向下取整，构建期同语义 snap）
 * duration_sec 时长秒（默认 3.7，内部 17-2500 帧 4k+1 网格；>93 帧自动链式续段）
 * fps 8-30 默认 25 / steps 1-50 默认 12；shift/cfg/dmd_lora_strength 注册表未暴露，
 * 对齐 Web AvatarGenPanel 高级参数缺省不传的语义，移动端省略由后端默认（12.0/1.0/1.0）
 */
export interface AvatarTalkRequest {
  positive: string;
  /** 人像首帧文件名（/api/upload?kind=avatar 落点） */
  image: string;
  /** 驱动音频文件名（上传时钉人像落点 worker） */
  audio: string;
  /** 人像图落点 worker（生成同机，后端转运 LongCat 实例） */
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

// ── 参考资产库（M13，契约已读 apps/api 源码验证：routes/reference_assets.py）──

/** 资产类别：角色/场景/道具/风格卡（reference_assets.py AssetKind Literal） */
export type AssetKind = 'character' | 'scene' | 'prop' | 'style';

/** 资产参考图句柄：/api/upload 返回的 filename + worker 落点（资产本体只持久化句柄，不重复存文件） */
export interface AssetImage {
  filename: string;
  worker: string;
}

/** 对应 reference_assets.py AssetOut（GET /api/assets 列表/单查响应；created_at/updated_at 为 ISO 串） */
export interface AssetItem {
  id: string;
  kind: AssetKind;
  name: string;
  description: string;
  /** 1-4 张（后端硬上限：≤4 是参考一致性质量拐点） */
  images: AssetImage[];
  nsfw: boolean;
  created_at: string;
  updated_at: string;
}

/** POST /api/assets 请求体（name 1-100 字符 / description ≤2000 / images 1-4 张） */
export interface AssetCreateBody {
  kind: AssetKind;
  name: string;
  description?: string;
  images: AssetImage[];
  nsfw?: boolean;
}

/** PATCH /api/assets/{id} 请求体：部分更新，仅出现的字段生效（对齐后端非 None 才落库） */
export interface AssetPatchBody {
  kind?: AssetKind;
  name?: string;
  description?: string;
  images?: AssetImage[];
  nsfw?: boolean;
}

// ── 反推提示词（POST /api/reverse，契约已读 apps/api 源码验证：routes/reverse.py）──

/**
 * POST /api/reverse 响应：kind 由后端按 content-type/扩展名判定（image/video/audio）
 * negative 仅图像反推可能返回（视频/音频无）；meta 音频转写细节暂不透传
 */
export interface ReverseResult {
  kind: string;
  prompt: string;
  negative: string | null;
}

// ── 优化提示词（POST /api/optimize，契约已读 apps/api 源码验证：routes/optimize.py）──

/**
 * POST /api/optimize 响应：optimized 恒有值
 * negative 仅 image/image_edit/video 类返回（audio 等单段类无）；解析失败时后端启发式兜底
 */
export interface OptimizeResult {
  optimized: string;
  negative: string | null;
}

// ── 对话助手（POST /api/agent/chat SSE + /api/agent/sessions CRUD，契约已读 apps/api 源码验证：routes/agent.py / agent/runner.py）──

/**
 * SSE msg 事件载荷（agent.py stream() 逐条 yield runner 事件，event 名恒为 "msg"，data 为 JSON 串）：
 * - text：assistant 文本（content）
 * - tool：工具调用开始（name/args）
 * - image/video/audio/model3d：工具产物（urls）
 * - error：LLM/工具异常（content）；error 事件不落库（runner docstring）
 */
export interface AgentEvent {
  type: 'text' | 'tool' | 'image' | 'video' | 'audio' | 'model3d' | 'error';
  content?: string;
  name?: string;
  urls?: string[];
  args?: Record<string, unknown>;
  worker?: string;
}

/** 对话请求消息（routes/agent.py ChatMessage：content ≤8000；请求 messages 1-40 条） */
export interface AgentChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

/**
 * POST /api/agent/chat 附图引用（M30，ChatRequest.image）
 * /api/upload 返回的 {filename,worker} 句柄；runner 注入 system 提示并把 attachment
 * 传给 edit_image/generate_3d 工具（从该 worker input 目录读字节，上传与工具同机）
 */
export interface AgentChatImage {
  filename: string;
  worker: string;
}

/** GET /api/agent/sessions 列表项（agent.py _session_dict：updated_at 倒序，含消息数） */
export interface AgentSessionSummary {
  id: string;
  title: string;
  nsfw: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

/** 会话消息（agent.py _message_dict：tool_calls 无值时为 null；media 无值时为 []） */
export interface AgentSessionMessage {
  id: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  tool_calls?: unknown;
  media: { type: string; urls: string[] }[];
  created_at: string;
}

/** GET /api/agent/sessions/{sid} 详情：summary 字段 + 全消息回放（id 升序即对话顺序） */
export interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

// ── 文档挂载（M20，契约已读 apps/api 源码验证：routes/documents.py / services/docs.py）──

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

// ── Agent 团队运行监控（M21，契约已读 apps/api 源码验证：routes/agent_team.py / services/agent_team_exec.py）──

/**
 * GET /api/agent-runs 列表项（created_at 倒序，status 空=全部）
 * task_counts 由后端按任务表现算：done 含 approved（人工通过视为完成态）
 */
export interface AgentRunSummary {
  id: string;
  level: string;
  goal: string;
  status: string;
  /** ISO 时间字符串 */
  created_at: string;
  task_counts: { total: number; done: number; error: number };
}

/**
 * 任务卡片详情（agent_team.py `_task_detail`：input/output/verdict 已解析为对象）
 * status：pending|queued|running|verifying|rejected|approved|done|error（后端未来新增原样透传）
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

/** GET /api/agent-runs/{run_id} 详情（他人/不存在一律 404「任务不存在」不泄露存在性） */
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

/** plan 事件/编辑计划广播的任务简报（agent_team.py `_task_brief`） */
export interface AgentRunTaskBrief {
  id: string;
  kind: string;
  title: string;
  depends_on: string[];
  status: string;
}

/**
 * GET /api/agent-runs/{run_id}/events SSE 事件载荷联合（event 帧名 = type）
 * - ack：创建回执（agent_team.py create_agent_run）
 * - plan：计划广播（创建/编辑计划后）
 * - task_status：任务级带 task_id（running 带 gpu_hint/attempt；done 带 output）；
 *   run 级无 task_id（cancel 端点推 {run_id, status:'canceled'}）
 * - blocked：单任务失败（不中断其他分支）
 * - confirm_required：确认门挂起（gate=plan|assembly）
 * - error：run 级失败收尾
 */
export type AgentRunEvent =
  | { type: 'ack'; message: string; level: string }
  | { type: 'plan'; tasks: AgentRunTaskBrief[] }
  | {
      type: 'task_status';
      task_id?: string;
      run_id?: string;
      status: string;
      title?: string;
      output?: Record<string, unknown>;
      gpu_hint?: string;
      attempt?: number;
    }
  | { type: 'blocked'; task_id: string; title: string; error: string }
  | { type: 'confirm_required'; gate: string; message: string }
  | { type: 'error'; message: string };

/**
 * POST /api/agent-runs/{run_id}/resume 请求体（agent_team.py ResumeRequest，gate/action 正则受限）
 * gate=plan：仅 awaiting_confirm/planning 可裁决；gate=assembly：仅 awaiting_assembly（否则 409 人话透传）
 * action：approve 通过 / reject 打回（feedback 可选方向性批注）/ modify 仅记录裁决
 * （M23 起实际改动先走 POST /plan 计划编辑，成功后计划门裁决投 modify；无改动投 approve）
 */
export interface AgentResumeBody {
  gate: 'plan' | 'assembly';
  action: 'approve' | 'modify' | 'reject';
  feedback?: string;
}

/**
 * POST /api/agent-runs/{run_id}/tasks/{task_id}/action 请求体（agent_team.py TaskActionRequest）
 * - edit：payload={input:{...}} 合并进任务 input，卡片回 pending 待重跑
 * - regenerate：payload={guidance?} 引导词拼进主文案；仅 done/error 卡片可重生（assemble 卡走合成确认门）
 * - approve：卡片置 approved（计入 done）
 * - upload：payload={url} 替换产物（仅本地产物；合成卡 400）；本地文件直传走 uploadAgentTaskAsset
 * - reprompt：反推产物提示词写回 input（仅图像/视频卡；M33 起本端出入口）
 */
export interface AgentTaskActionBody {
  action: 'edit' | 'regenerate' | 'approve' | 'upload' | 'reprompt';
  payload?: Record<string, unknown>;
}

// ── Agent 团队三期（M23，契约已读 apps/api 源码验证：routes/agent_team.py edit_plan / run_result）──

/**
 * POST /api/agent-runs/{run_id}/plan 单条编辑操作（agent_team.py PlanEditOp）
 * - update：title 非 null 直改；input 按键合并（不动未提交字段）；id 不存在 404「任务不存在:{id}」
 * - remove：按 id 删 + 服务端清理其他任务 depends_on 里的悬挂引用
 * - add：id 可前端预生成（保持 DAG 引用稳定，服务端缺省生成）；kind 从 input.kind 读（默认 video）、
 *   depends_on 从 input.depends_on 读；title 缺省「新任务」
 */
export interface AgentPlanEditOp {
  id: string;
  action: 'update' | 'remove' | 'add';
  title?: string | null;
  input?: Record<string, unknown> | null;
}

/** POST /plan 响应：plan.tasks 为 _task_brief 简报（与 SSE plan 事件同形状；编辑后推 plan 事件） */
export interface AgentRunPlanUpdateResult {
  run_id: string;
  plan: { tasks: AgentRunTaskBrief[] };
}

/** GET /result 产物清单项（agent_team.py run_result：id/title/kind/status/output 五字段） */
export interface AgentRunResultTask {
  id: string;
  title: string;
  kind: string;
  status: string;
  output: Record<string, unknown>;
}

/**
 * GET /api/agent-runs/{run_id}/result 响应（仅 done，否则 409「任务尚未完成」）
 * final_url 取自 assemble done 卡 output.url（合成产物缺失为空串）；
 * duration_sec 为 video/image 卡 input.duration_sec 合计
 */
export interface AgentRunResult {
  final_url: string;
  duration_sec: number;
  tasks: AgentRunResultTask[];
}
