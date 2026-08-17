/**
 * 生成请求构建器（语义对齐 Mobile generate-screen / buildImg2ImgRequest）
 * - 引擎 params 的 key 即后端请求字段名，白名单透传防脏字段
 * - img2img 无 width/height/batch_size（输出尺寸随参考图，后端契约）
 * - 视频引擎（ltx25-t2v/ltx25-i2v/wan-animate/wan-vace）按引擎 id 显式路由，
 *   其余未接入引擎在 UI 层禁用（SUPPORTED_ENGINE_IDS），杜绝错误路由 txt2img
 * - MP11 接入 h3-t2v/h3-i2v（含 loras 叠加）/longcat-t2v/longcat-i2v/longcat-continue/ace-music
 * - MP12 接入 5 个 R18 引擎（ltx-nsfw-t2v/ltx-nsfw-i2v/ltx-nsfw-lipsync/h3-nsfw-t2v/h3-nsfw-i2v），
 *   与主站工作台引擎全景对齐
 * - MP14 接入 avatar-talk（LongCat-Avatar 数字人）：注册表 audio 为 text 占位（Web 走独立面板），
 *   本端按引擎 id 特判渲染上传字段，抽屉内剔除该键（engineSheetParams）
 */
import type {
  AceMusicRequest,
  AvatarTalkRequest,
  EngineInfo,
  EngineParam,
  H3I2VRequest,
  H3T2VRequest,
  Img2ImgRequest,
  LongCatContinueRequest,
  LongCatI2VRequest,
  LongCatT2VRequest,
  LoraValue,
  Ltx25I2VRequest,
  Ltx25T2VRequest,
  LtxNsfwI2VRequest,
  LtxNsfwLipsyncRequest,
  LtxNsfwT2VRequest,
  Txt2ImgRequest,
  UploadedRefAudio,
  UploadedRefImage,
  UploadedRefVideo,
  WanAnimateRequest,
  WanVaceRequest,
} from '@/types/api';

/**
 * 已接入提交链路的引擎 id 白名单（创作页只放行这些，其余显示「即将支持」禁用态）
 * 图像四件套与后端注册表 id 一致；nsfw-* 图像引擎与 SFW 同一提交链路（隐式既有支持，不破坏）
 * MP11 新增 H3（含 LoRA 叠加）/ LongCat 三件套 / ACE 音乐；MP12 接入 5 个 R18 引擎
 * （R18 可见性由后端按 X-NSFW 头过滤，前端不做门控）；MP14 接入 avatar-talk 数字人，全引擎在册
 */
export const SUPPORTED_ENGINE_IDS: readonly string[] = [
  'txt2img',
  'img2img',
  'nsfw-txt2img',
  'nsfw-img2img',
  'ltx25-t2v',
  'ltx25-i2v',
  'wan-animate',
  'wan-vace',
  'h3-t2v',
  'h3-i2v',
  'longcat-t2v',
  'longcat-i2v',
  'longcat-continue',
  'ace-music',
  'ltx-nsfw-t2v',
  'ltx-nsfw-i2v',
  'ltx-nsfw-lipsync',
  'h3-nsfw-t2v',
  'h3-nsfw-i2v',
  'avatar-talk',
];

export function isEngineSupported(engine: EngineInfo | null | undefined): boolean {
  return !!engine && SUPPORTED_ENGINE_IDS.includes(engine.id);
}

/** 引擎是否要求参考图（含 images 类型参数） */
export function engineNeedsRefImage(engine: EngineInfo | null | undefined): boolean {
  return !!engine?.params?.some((p) => p.type === 'images');
}

/** 引擎是否要求驱动视频（含 video 类型参数，如 wan-animate） */
export function engineNeedsVideo(engine: EngineInfo | null | undefined): boolean {
  return !!engine?.params?.some((p) => p.type === 'video');
}

/** 引擎是否要求驱动音频（含 audio 类型参数，如 ltx-nsfw-lipsync；或 avatar-talk 的 text 占位 audio 键） */
export function engineNeedsAudio(engine: EngineInfo | null | undefined): boolean {
  if (!engine) return false;
  if (engine.params?.some((p) => p.type === 'audio')) return true;
  // avatar-talk 注册表 audio 为 text 占位（Web 走独立面板），本端渲染为上传字段
  return engine.id === 'avatar-talk' && !!engine.params?.some((p) => p.key === 'audio');
}

/**
 * 参数抽屉可见参数：媒体类型（images/video/audio）本就不进抽屉；
 * avatar-talk 的 text 占位 audio 键由创作页音频上传字段承担，剔除避免误渲为文本框
 */
export function engineSheetParams(engine: EngineInfo | null | undefined): EngineParam[] {
  const params = engine?.params ?? [];
  if (engine?.id !== 'avatar-talk') return params;
  return params.filter((p) => p.key !== 'audio');
}

/** images 参数的数量上限（无 images 参数返回 0；缺省 max 按 1） */
export function engineImagesMax(engine: EngineInfo | null | undefined): number {
  const param = engine?.params?.find((p) => p.type === 'images');
  if (!param) return 0;
  return typeof param.max === 'number' && param.max > 0 ? param.max : 1;
}

/** 引擎是否要求多参考图（images max>1，如 wan-vace 1-4 张） */
export function engineNeedsMultiImage(engine: EngineInfo | null | undefined): boolean {
  return engineImagesMax(engine) > 1;
}

/**
 * 引擎 → /api/upload kind 映射（对齐 Web GenerateView；未映射的图像引擎回落 img2img）
 * h3-i2v → h3_i2v（capabilities.py 专用 kind：pool worker 仅存文件，后端转运 H3 实例）
 * longcat-i2v → ltx_i2v（capabilities.py 无 longcat 专用 kind，对齐 Web GenerateView fallback）
 * MP12：ltx-nsfw-i2v → ltx_i2v（LTX2.3 同机生成无转运）；ltx-nsfw-lipsync → ltx_lipsync
 * （图/音同 kind 互钉，要求 worker 持有口型同步模型）；h3-nsfw-i2v → h3_i2v（与 SFW 同链路）
 * MP14：avatar-talk → avatar（人像/音频同 kind 落 pool worker，提交时后端转运 LongCat :8197 实例）
 */
const UPLOAD_KIND_BY_ENGINE: Record<string, string> = {
  img2img: 'img2img',
  'nsfw-img2img': 'img2img',
  'ltx25-i2v': 'ltx_i2v',
  'wan-animate': 'wan_animate',
  'wan-vace': 'wan_vace',
  'h3-i2v': 'h3_i2v',
  'longcat-i2v': 'ltx_i2v',
  'ltx-nsfw-i2v': 'ltx_i2v',
  'ltx-nsfw-lipsync': 'ltx_lipsync',
  'h3-nsfw-i2v': 'h3_i2v',
  'avatar-talk': 'avatar',
};

export function uploadKindForEngine(engineId: string): string {
  return UPLOAD_KIND_BY_ENGINE[engineId] ?? 'img2img';
}

/** 引擎参数默认值表：{ [param.key]: param.default } */
export function defaultParamValues(engine: EngineInfo | null | undefined): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const p of engine?.params ?? []) {
    if (p.type === 'images' || p.type === 'video' || p.type === 'audio') continue; // 媒体参数由字段组件单独管理
    values[p.key] = p.default;
  }
  return values;
}

const TXT2IMG_NUMBER_KEYS = ['width', 'height', 'steps', 'cfg', 'batch_size'] as const;
const TXT2IMG_STRING_KEYS = ['negative', 'ckpt_name', 'sampler', 'scheduler', 'style_preset'] as const;

const IMG2IMG_NUMBER_KEYS = ['denoise', 'steps', 'cfg'] as const;
const IMG2IMG_STRING_KEYS = ['negative', 'ckpt_name', 'sampler', 'scheduler', 'style_preset'] as const;

function pickNumbers(
  values: Record<string, unknown>,
  keys: readonly string[],
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of keys) {
    const raw = values[key];
    if (raw === undefined || raw === null || raw === '') continue;
    const num = Number(raw);
    if (Number.isFinite(num)) out[key] = num;
  }
  return out;
}

function pickStrings(
  values: Record<string, unknown>,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const raw = values[key];
    if (typeof raw === 'string' && raw.trim().length > 0) out[key] = raw.trim();
  }
  return out;
}

function pickSeed(values: Record<string, unknown>): { seed?: number | null } {
  const raw = values.seed;
  if (raw === null) return { seed: null };
  if (raw === undefined || raw === '') return {};
  const num = Number(raw);
  return Number.isFinite(num) ? { seed: num } : {};
}

/**
 * 注册表 duration（秒）→ 路由契约 duration_sec（h3/ltx25/longcat/wan/avatar 统一）。
 * 键名直抄 length/num_frames 会被后端 pydantic 静默忽略（未知字段），
 * 用户时长落默认值（2026-08-17 断链修复）；网格/裁切/续写由后端统一策略层负责。
 */
function pickDurationSec(values: Record<string, unknown>): { duration_sec?: number } {
  const raw = values.duration;
  if (raw === undefined || raw === null || raw === '') return {};
  const num = Number(raw);
  return Number.isFinite(num) && num > 0 ? { duration_sec: num } : {};
}

export function buildTxt2ImgRequest(
  positive: string,
  values: Record<string, unknown>,
): Txt2ImgRequest {
  return {
    positive: positive.trim(),
    ...pickStrings(values, TXT2IMG_STRING_KEYS),
    ...pickNumbers(values, TXT2IMG_NUMBER_KEYS),
    ...pickSeed(values),
  };
}

export function buildImg2ImgRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): Img2ImgRequest {
  return {
    positive: positive.trim(),
    image: ref.filename,
    worker: ref.worker,
    ...pickStrings(values, IMG2IMG_STRING_KEYS),
    ...pickNumbers(values, IMG2IMG_NUMBER_KEYS),
    ...pickSeed(values),
  };
}

/** 参考图客户端先验（后端 ≤20MB / 扩展名白名单兜底 415） */
export const REF_IMAGE_MAX_BYTES = 20 * 1024 * 1024;
const REF_IMAGE_EXTS = ['jpg', 'jpeg', 'png', 'webp', 'gif'];

export function validateRefImage(filePath: string, sizeBytes?: number): string | null {
  // H5 chooseImage 返回 blob: 对象 URL（无扩展名）：MIME 由 input accept="image/*" 约束，
  // 类型安全最终由后端魔数嗅探兜底（415）；此处跳过扩展名校验，大小上限仍生效
  if (!filePath.startsWith('blob:')) {
    const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
    if (!REF_IMAGE_EXTS.includes(ext)) {
      return '仅支持 JPG/PNG/WebP/GIF 图片';
    }
  }
  if (sizeBytes !== undefined && sizeBytes > REF_IMAGE_MAX_BYTES) {
    return '图片不能超过 20MB';
  }
  return null;
}

/** 驱动视频客户端先验（后端 mp4/mov/webm 魔数嗅探 ≤200MB 兜底 413/415） */
export const REF_VIDEO_MAX_BYTES = 200 * 1024 * 1024;
const REF_VIDEO_EXTS = ['mp4', 'webm', 'mov'];

export function validateRefVideo(filePath: string, sizeBytes?: number): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!REF_VIDEO_EXTS.includes(ext)) {
    return '仅支持 MP4/WebM/MOV 视频';
  }
  if (sizeBytes !== undefined && sizeBytes > REF_VIDEO_MAX_BYTES) {
    return '视频不能超过 200MB';
  }
  return null;
}

// ── SFW 视频引擎请求构建（白名单键透传，与 routes/ltx25_studio.py / wan_studio.py 同范围）──
// 时长统一走 pickDurationSec（注册表 duration 秒 → duration_sec）

const LTX25_NUMBER_KEYS = ['width', 'height', 'fps', 'steps'] as const;
const WAN_NUMBER_KEYS = ['width', 'height', 'steps', 'fps'] as const;
const VIDEO_STRING_KEYS = ['negative'] as const;

/** ltx25-t2v：纯参数文生视频，无参考媒体 */
export function buildLtx25T2VRequest(
  positive: string,
  values: Record<string, unknown>,
): Ltx25T2VRequest {
  return {
    positive: positive.trim(),
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, LTX25_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/** ltx25-i2v：参考图首帧 + strength 重绘强度 */
export function buildLtx25I2VRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): Ltx25I2VRequest {
  return {
    positive: positive.trim(),
    image: ref.filename,
    worker: ref.worker,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, [...LTX25_NUMBER_KEYS, 'strength']),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/** wan-animate：参考图 + 驱动视频（上传时已互钉同 worker，worker 取参考图落点） */
export function buildWanAnimateRequest(
  positive: string,
  refImage: UploadedRefImage,
  refVideo: UploadedRefVideo,
  values: Record<string, unknown>,
): WanAnimateRequest {
  return {
    positive: positive.trim(),
    image: refImage.filename,
    video: refVideo.filename,
    worker: refImage.worker,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, WAN_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/** wan-vace：多参考图 1-4 张（全部互钉，worker 取第一张落点） */
export function buildWanVaceRequest(
  positive: string,
  refs: UploadedRefImage[],
  values: Record<string, unknown>,
): WanVaceRequest {
  return {
    positive: positive.trim(),
    images: refs.map((r) => r.filename),
    worker: refs[0]?.worker ?? '',
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, WAN_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

// ── MP11：H3 / LongCat / ACE 引擎请求构建（与 routes/h3_studio.py / longcat_studio.py / audio.py 同范围）──

const H3_NUMBER_KEYS = ['width', 'height', 'steps'] as const;
const LONGCAT_NUMBER_KEYS = ['width', 'height', 'steps', 'fps'] as const;
const ACE_NUMBER_KEYS = ['seconds', 'steps', 'cfg'] as const;

/** LoRA 强度缺省值（H3 作者推荐，与 routes/h3_studio.py H3LoraInput 默认一致） */
export const LORA_DEFAULT_STRENGTH = 0.6;
/** LoRA 强度合法区间（h3_studio.py ge=0.5 le=1.0） */
export const LORA_STRENGTH_MIN = 0.5;
export const LORA_STRENGTH_MAX = 1.0;

/**
 * loras 参数值解析（对齐 Web engines.ts _loras，另加强度钳区间）
 * 非数组 → []；项缺 string name 跳过；strength 非有限数 → 0.6，再钳 0.5-1.0
 */
export function parseLoraValues(raw: unknown): LoraValue[] {
  if (!Array.isArray(raw)) return [];
  const out: LoraValue[] = [];
  for (const item of raw) {
    if (!item || typeof (item as LoraValue).name !== 'string') continue;
    const strength = (item as LoraValue).strength;
    const num =
      typeof strength === 'number' && Number.isFinite(strength)
        ? strength
        : LORA_DEFAULT_STRENGTH;
    out.push({
      name: (item as LoraValue).name,
      strength: Math.min(LORA_STRENGTH_MAX, Math.max(LORA_STRENGTH_MIN, num)),
    });
  }
  return out;
}

/** h3-t2v：纯参数文生视频 + loras 叠加（无 fps/cfg，模板内锁定 24fps） */
export function buildH3T2VRequest(
  positive: string,
  values: Record<string, unknown>,
): H3T2VRequest {
  return {
    positive: positive.trim(),
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, H3_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
    loras: parseLoraValues(values.loras),
  };
}

/** h3-i2v：参考图首帧（上传落 pool worker，后端转运 H3 实例）+ loras 叠加 */
export function buildH3I2VRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): H3I2VRequest {
  return {
    positive: positive.trim(),
    image: ref.filename,
    worker: ref.worker,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, H3_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
    loras: parseLoraValues(values.loras),
  };
}

/** longcat-t2v：长视频文生视频（无 cfg，蒸馏链路固定 1.0） */
export function buildLongCatT2VRequest(
  positive: string,
  values: Record<string, unknown>,
): LongCatT2VRequest {
  return {
    positive: positive.trim(),
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, LONGCAT_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/** longcat-i2v：参考图首帧（同 h3-i2v 转运模式） */
export function buildLongCatI2VRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): LongCatI2VRequest {
  return {
    positive: positive.trim(),
    image: ref.filename,
    worker: ref.worker,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, LONGCAT_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/**
 * longcat-continue：视频续写（video=源视频产物 URL，注册表 text 参数在 values 内）
 * width/height/fps 空值省略不传 → 后端 ffprobe 实测源视频对齐
 */
export function buildLongCatContinueRequest(
  positive: string,
  values: Record<string, unknown>,
): LongCatContinueRequest {
  const video = typeof values.video === 'string' ? values.video.trim() : '';
  return {
    positive: positive.trim(),
    video,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, LONGCAT_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}

/** ace-music：文生音乐（positive 主提示词 → tags 风格标签映射；lyrics 留空=纯音乐省略不传） */
export function buildAceMusicRequest(
  positive: string,
  values: Record<string, unknown>,
): AceMusicRequest {
  return {
    tags: positive.trim(),
    ...pickStrings(values, ['lyrics']),
    ...pickNumbers(values, ACE_NUMBER_KEYS),
    ...pickSeed(values),
  };
}

// ── MP12：R18 视频引擎请求构建（与 routes/video.py / Web lib/engines.ts _ltxNsfwPayload / _h3NsfwPayload 对齐）──

/** 音频文件客户端先验（后端 ≤20MB / 扩展名+魔数白名单兜底 415） */
export const REF_AUDIO_MAX_BYTES = 20 * 1024 * 1024;
const REF_AUDIO_EXTS = ['wav', 'mp3', 'm4a', 'ogg', 'flac'];

export function validateRefAudio(filePath: string, sizeBytes?: number): string | null {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (!REF_AUDIO_EXTS.includes(ext)) {
    return '仅支持 wav / mp3 / m4a / ogg / flac 音频';
  }
  if (sizeBytes !== undefined && sizeBytes > REF_AUDIO_MAX_BYTES) {
    return '音频不能超过 20MB';
  }
  return null;
}

/** R18 分辨率预设换算：select 值 "WxH" → {width, height}；非法/缺失 → fallback 预设（对齐 Web _resolution） */
export function parseResolution(resolution: string, fallback: string): { width: number; height: number } {
  const m = /^(\d+)x(\d+)$/.exec(resolution);
  const [w, h] = (m ? [m[1], m[2]] : fallback.split('x')).map(Number);
  return { width: w, height: h };
}

/** R18 时长预设解析：select 值即秒数，直传 duration_sec（网格/裁切由后端统一策略层负责，对齐 Web _durationSec） */
export function nsfwDurationSec(raw: unknown, fallback = 6): number {
  const s = typeof raw === 'string' ? raw : String(fallback);
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

const LTX_NSFW_NUMBER_KEYS = ['fps', 'steps', 'cfg'] as const;
const H3_NSFW_NUMBER_KEYS = ['steps'] as const;

/** ltx-nsfw-t2v：10Eros 底模文生视频；resolution 预设换算 width/height，duration 预设直传 duration_sec */
export function buildLtxNsfwT2VRequest(
  positive: string,
  values: Record<string, unknown>,
): LtxNsfwT2VRequest {
  const resolution = typeof values.resolution === 'string' ? values.resolution : '1280x720';
  const { width, height } = parseResolution(resolution, '1280x720');
  return {
    positive: positive.trim(),
    width,
    height,
    duration_sec: nsfwDurationSec(values.duration),
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, LTX_NSFW_NUMBER_KEYS),
    ...pickSeed(values),
    use_upscale: values.use_upscale === true,
    use_rife: values.use_rife === true,
  };
}

/** ltx-nsfw-i2v：图生视频（t2v 全集 + 参考图落点；kind=ltx_i2v 上传） */
export function buildLtxNsfwI2VRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): LtxNsfwI2VRequest {
  return {
    ...buildLtxNsfwT2VRequest(positive, values),
    image: ref.filename,
    worker: ref.worker,
  };
}

/** ltx-nsfw-lipsync：口型同步（图生视频 + 音频驱动 + ID LoRA；参考图与音频须同 worker） */
export function buildLtxNsfwLipsyncRequest(
  positive: string,
  refImage: UploadedRefImage,
  refAudio: UploadedRefAudio,
  values: Record<string, unknown>,
): LtxNsfwLipsyncRequest {
  const id_lora = typeof values.id_lora === 'string' ? values.id_lora.trim() : '';
  const strength = pickNumbers(values, ['id_lora_strength']).id_lora_strength;
  return {
    ...buildLtxNsfwT2VRequest(positive, values),
    image: refImage.filename,
    worker: refImage.worker,
    audio: refAudio.filename,
    // id_lora 留空即不用（后端默认 ''）；强度缺省由后端补 0.8（注册表 default 已注入 values）
    ...(id_lora ? { id_lora } : {}),
    ...(strength !== undefined ? { id_lora_strength: strength } : {}),
  };
}

/** h3-nsfw-t2v：与 SFW H3 同 POST /api/h3/t2v；resolution 预设换算 width/height，duration 预设直传 duration_sec（含 4s/8s 档） */
export function buildH3NsfwT2VRequest(
  positive: string,
  values: Record<string, unknown>,
): H3T2VRequest {
  const resolution = typeof values.resolution === 'string' ? values.resolution : '1280x736';
  const { width, height } = parseResolution(resolution, '1280x736');
  return {
    positive: positive.trim(),
    width,
    height,
    duration_sec: nsfwDurationSec(values.duration),
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, H3_NSFW_NUMBER_KEYS),
    ...pickSeed(values),
    loras: parseLoraValues(values.loras),
  };
}

/** h3-nsfw-i2v：t2v 全集 + 参考图落点（kind=h3_i2v，pool 存文件后端转运 H3 实例） */
export function buildH3NsfwI2VRequest(
  positive: string,
  ref: UploadedRefImage,
  values: Record<string, unknown>,
): H3I2VRequest {
  return {
    ...buildH3NsfwT2VRequest(positive, values),
    image: ref.filename,
    worker: ref.worker,
  };
}

// ── MP14：LongCat-Avatar 数字人请求构建（与 routes/avatar_studio.py AvatarTalkRequest 同范围）──

/** avatar-talk 数值键全集（shift/cfg/dmd_lora_strength 注册表未外露，出现即透传，缺省后端补默认） */
const AVATAR_TALK_NUMBER_KEYS = [
  'width',
  'height',
  'fps',
  'steps',
  'shift',
  'cfg',
  'dmd_lora_strength',
] as const;

/**
 * avatar-talk：人像首帧 + 驱动音频（上传时已互钉同 worker，worker 取人像落点）
 * 时长走 pickDurationSec（注册表 duration 秒 → duration_sec；>3.7s 后端自动续段）
 */
export function buildAvatarTalkRequest(
  positive: string,
  refImage: UploadedRefImage,
  refAudio: UploadedRefAudio,
  values: Record<string, unknown>,
): AvatarTalkRequest {
  return {
    positive: positive.trim(),
    image: refImage.filename,
    audio: refAudio.filename,
    worker: refImage.worker,
    ...pickStrings(values, VIDEO_STRING_KEYS),
    ...pickNumbers(values, AVATAR_TALK_NUMBER_KEYS),
    ...pickDurationSec(values),
    ...pickSeed(values),
  };
}
