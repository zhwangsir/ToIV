import * as SecureStore from 'expo-secure-store';
import { fetch as expoFetch } from 'expo/fetch';

import { resolveApiBase } from './config';
import { toAgentRunEvent } from './agent-run';
import { parseSseStream } from './sse';
import type {
  AceMusicRequest,
  AgentChatImage,
  AgentChatMessage,
  AgentEvent,
  AgentPlanEditOp,
  AgentRunDetail,
  AgentRunEvent,
  AgentRunPlanUpdateResult,
  AgentRunResult,
  AgentRunSummary,
  AgentRunTask,
  AgentResumeBody,
  AgentTaskActionBody,
  AgentSessionDetail,
  AgentSessionSummary,
  AssetCreateBody,
  AssetItem,
  AssetKind,
  AssetPatchBody,
  AuthResult,
  AvatarTalkRequest,
  DocItem,
  EngineInfo,
  GenerateResponse,
  H3I2VRequest,
  H3T2VRequest,
  Img2ImgRequest,
  JobItem,
  LongCatContinueRequest,
  LongCatI2VRequest,
  LongCatT2VRequest,
  Ltx25I2VRequest,
  Ltx25T2VRequest,
  LtxNsfwI2VRequest,
  LtxNsfwLipsyncRequest,
  LtxNsfwT2VRequest,
  MeResult,
  OptimizeResult,
  RerunRequest,
  RerunResponse,
  ReverseResult,
  Txt2ImgRequest,
  UploadImageResult,
  WanAnimateRequest,
  WanVaceRequest,
} from '@/types/api';

/**
 * 统一 API 客户端（对齐 apps/web/lib/api.ts 语义）
 * - token 只存 expo-secure-store（开发规范禁令 3）
 * - NSFW 意图经 X-NSFW 头按请求注入，不动账户全局开关
 */

const TOKEN_KEY = 'toiv_token';

/** 常规 JSON/轮询请求超时 */
export const DEFAULT_TIMEOUT_MS = 30_000;
/** 长任务端点超时（VLM 解析 / LLM 长文 / ffmpeg 合成） */
export const LONG_TIMEOUT_MS = 180_000;

let nsfwIntent = false;

/**
 * token 的内存镜像：mediaUrl 拼媒体地址是同步调用（对齐 Web withToken 的 ?token= 方案），
 * 不能每次 await SecureStore。setToken/getToken 均会回填，覆盖登录/登出/冷启动恢复全链路。
 */
let cachedToken: string | null = null;

/** /nsfw 板块进入/退出时调用，按请求带 R18 放行标记 */
export function setNsfwIntent(on: boolean): void {
  nsfwIntent = on;
}

export async function getToken(): Promise<string | null> {
  cachedToken = await SecureStore.getItemAsync(TOKEN_KEY);
  return cachedToken;
}

export async function setToken(token: string | null): Promise<void> {
  cachedToken = token;
  if (token) await SecureStore.setItemAsync(TOKEN_KEY, token);
  else await SecureStore.deleteItemAsync(TOKEN_KEY);
}

/**
 * 产物相对路径 → 可加载 URL（对齐 Web imageUrl：相对路径拼 base + ?token=）
 * 媒体标签无法带请求头，后端接受 query token；无 token 时原样返回（交由 401 兜底）
 */
export function mediaUrl(path: string): string {
  if (!path) return '';
  const abs = path.startsWith('http') ? path : `${resolveApiBase()}${path.startsWith('/') ? path : `/${path}`}`;
  if (!cachedToken) return abs;
  return `${abs}${abs.includes('?') ? '&' : '?'}token=${encodeURIComponent(cachedToken)}`;
}

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/** 状态码 → 人话（对齐 Web lib/friendlyError.ts 思路，UI 直接展示） */
function friendlyMessage(status: number, fallback: string): string {
  if (status === 401) return '登录已过期，请重新登录';
  if (status === 403) return '没有权限执行此操作';
  if (status === 404) return '资源不存在或已被清理';
  if (status === 429) return '请求过于频繁，请稍后再试';
  if (status >= 500) return '服务暂时不可用，请稍后重试';
  return fallback || '请求失败，请重试';
}

/**
 * 错误体 detail 提取（apiFetch 与 agentChatStream 共用；expo/fetch 与全局 fetch 的 json() 形状一致）
 * FastAPI 422：detail 为校验错误数组，取首条 msg（对齐 Web _postLtx25/_postWan 展开规则）
 */
async function readErrorDetail(res: { json(): Promise<unknown> }): Promise<string> {
  try {
    const data = (await res.json()) as { detail?: unknown; message?: string };
    if (Array.isArray(data.detail)) {
      return (data.detail[0] as { msg?: string } | undefined)?.msg ?? '';
    }
    if (typeof data.detail === 'string') return data.detail;
    return data.message ?? '';
  } catch {
    return ''; // 非 JSON 错误体，忽略解析
  }
}

export interface ApiFetchOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  /** multipart 上传：直传 FormData，不设 Content-Type（边界由运行时生成），与 body 互斥且优先 */
  formData?: FormData;
  /** 长任务端点置 true，超时放宽到 180s */
  long?: boolean;
  /** 单次请求覆盖 NSFW 意图（默认跟随全局意图） */
  nsfw?: boolean;
  signal?: AbortSignal;
}

export async function apiFetch<T>(
  path: string,
  options: ApiFetchOptions = {},
): Promise<T> {
  const { method = 'GET', body, formData, long = false, nsfw, signal } = options;
  const base = resolveApiBase();
  const url = path.startsWith('http') ? path : `${base}${path}`;

  const headers: Record<string, string> = { Accept: 'application/json' };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (nsfw ?? nsfwIntent) headers['X-NSFW'] = '1';
  if (body !== undefined && formData === undefined) headers['Content-Type'] = 'application/json';

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    long ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS,
  );
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }

  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: formData ?? (body === undefined ? undefined : JSON.stringify(body)),
      signal: controller.signal,
    });
  } catch {
    if (controller.signal.aborted && !signal?.aborted) {
      throw new ApiError(0, '请求超时，请检查网络后重试');
    }
    throw new ApiError(0, '网络连接失败，请检查网络');
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new ApiError(res.status, friendlyMessage(res.status, await readErrorDetail(res)));
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * 登录：POST /api/auth/login
 * 🔒 响应字段是 token（不是 access_token），缺失即视为协议错误，防回归
 */
export async function login(email: string, password: string): Promise<AuthResult> {
  const data = await apiFetch<AuthResult & { access_token?: string }>(
    '/api/auth/login',
    { method: 'POST', body: { email, password } },
  );
  if (typeof data.token !== 'string' || data.token.length === 0) {
    throw new ApiError(0, '登录响应缺少 token 字段（协议不符）');
  }
  await setToken(data.token);
  return { token: data.token, user: data.user };
}

export async function logout(): Promise<void> {
  await setToken(null);
}

/**
 * 拉取当前登录用户：GET /api/auth/me
 * 用途：冷启动恢复会话时校验 token 有效性（401 即强制重登）
 */
export async function fetchMe(): Promise<MeResult> {
  return apiFetch<MeResult>('/api/auth/me');
}

// ── 生成主流程（契约已读 apps/api 源码验证，见 TEST_LOG M4）──

/**
 * 引擎注册表：GET /api/models/engines → { engines, count }
 * NSFW 引擎由后端按 X-NSFW 上下文过滤，前端不做判断
 */
export async function fetchEngines(): Promise<EngineInfo[]> {
  const data = await apiFetch<{ engines?: EngineInfo[] }>('/api/models/engines');
  return data.engines ?? [];
}

/**
 * 文生图提交：POST /api/generate/txt2img → GenerateResponse
 * 服务端 spawn_tracker 后台落库（generate.py），客户端不依赖 SSE，轮询 /api/jobs 即可
 */
export async function submitTxt2Img(params: Txt2ImgRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/txt2img', {
    method: 'POST',
    body: params,
  });
}

// ── 图生图链路（M8，契约已读 apps/api 源码验证）──

/** 本地待上传图片（expo-image-picker asset 的必要子集） */
export interface LocalImageInput {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
}

/** mime → 安全扩展名（对齐 upload.py 三重白名单的图片侧；识别不出回落 jpg） */
function extFromMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'image/png':
      return 'png';
    case 'image/webp':
      return 'webp';
    case 'image/gif':
      return 'gif';
    default:
      return 'jpg';
  }
}

/**
 * 参考图上传：POST /api/upload?kind=<kind>[&worker=<pin>]（multipart，字段名 image）
 * - 不手设 Content-Type（边界由运行时生成，对齐 Web 注释与后端 UploadFile 解析）
 * - ≤20MB / 扩展名+魔数白名单由后端兜底（415），客户端在选图处先验（ref-image-field）
 * - pinWorker：wan-vace 第 2-4 张参考图钉第一张落点 worker（多机路径一致，upload.py 指定 worker 模式）
 * - 20MB 移动网络下可能较慢，走 long 超时（180s）
 */
export async function uploadImage(
  image: LocalImageInput,
  kind: string = 'img2img',
  pinWorker?: string,
): Promise<UploadImageResult> {
  const name = image.fileName?.trim() || `upload.${extFromMime(image.mimeType)}`;
  const formData = new FormData();
  // React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob）
  formData.append('image', {
    uri: image.uri,
    name,
    type: image.mimeType ?? 'image/jpeg',
  } as unknown as Blob);
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiFetch<UploadImageResult>(`/api/upload?kind=${encodeURIComponent(kind)}${pin}`, {
    method: 'POST',
    formData,
    long: true,
  });
}

/**
 * 图生图提交：POST /api/generate/img2img → GenerateResponse
 * image/worker 必须来自同一次 uploadImage 响应（生成与参考图同机，generate.py resolve_worker）
 */
export async function submitImg2Img(params: Img2ImgRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/img2img', {
    method: 'POST',
    body: params,
  });
}

// ── SFW 视频引擎链路（M9，契约已读 apps/api 源码验证：routes/ltx25_studio.py / routes/wan_studio.py）──

/**
 * 引擎 → /api/upload kind 路由（对齐 Web GenerateView uploadKind 映射）：
 * 决定后端接收校验与落点 worker 池；wan-vace 多图互钉 / wan-animate 视频钉图落点在上传调用侧完成
 * h3-i2v → h3_i2v（capabilities.py 专用 kind：pool worker 仅存文件，后端转运 H3 实例）
 * longcat-i2v → ltx_i2v（capabilities.py 无 longcat 专用 kind，对齐 Web GenerateView 回落）
 * M11 R18：ltx-nsfw-lipsync → ltx_lipsync（要求 LTX2.3 + 音频 VAE/口型节点）；ltx-nsfw-i2v → ltx_i2v（LTX2.3 同机生成）；
 * h3-nsfw-i2v → h3_i2v（与 h3-i2v 同一转运链路；capabilities.py 无模型/节点要求仅存文件——
 * Web 三元链未单列 h3-nsfw-i2v 落 default ltx_i2v，移动端按后端设计语义对齐，避免上传不必要依赖 LTX worker 在线）
 * M14：avatar-talk → avatar（人像图与驱动音频同落 pool worker 仅存文件，提交时后端转运 LongCat :8197 实例）
 */
export function uploadKindForEngine(engineId: string): string {
  switch (engineId) {
    case 'wan-animate':
      return 'wan_animate';
    case 'wan-vace':
      return 'wan_vace';
    case 'h3-i2v':
    case 'h3-nsfw-i2v':
      return 'h3_i2v';
    case 'ltx-nsfw-lipsync':
      return 'ltx_lipsync';
    case 'avatar-talk':
      return 'avatar';
    case 'ltx25-i2v':
    case 'longcat-i2v':
    case 'ltx-nsfw-i2v':
      return 'ltx_i2v';
    default:
      return 'img2img';
  }
}

/** 本地待上传视频（expo-image-picker asset 的必要子集） */
export interface LocalVideoInput {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
}

/** 视频 mime → 安全扩展名（对齐 upload.py 三重白名单的视频侧；识别不出回落 mp4） */
function videoExtFromMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'video/quicktime':
      return 'mov';
    case 'video/webm':
      return 'webm';
    default:
      return 'mp4';
  }
}

/**
 * 驱动视频上传：POST /api/upload?kind=<kind>[&worker=<pin>]（multipart，字段名固定 image，同 upload.py）
 * - mp4/mov/webm ≤200MB（后端魔数嗅探 415/413 兜底），客户端在选视频处先验（ref-video-field）
 * - pinWorker：wan-animate 链路把驱动视频钉到参考图落点 worker（提交时后端同机转运到专用实例）
 * - 200MB 移动网络下较慢，走 long 超时（180s）
 */
export async function uploadVideo(
  video: LocalVideoInput,
  kind: string,
  pinWorker?: string,
): Promise<UploadImageResult> {
  const name = video.fileName?.trim() || `upload.${videoExtFromMime(video.mimeType)}`;
  const formData = new FormData();
  // React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob）
  formData.append('image', {
    uri: video.uri,
    name,
    type: video.mimeType ?? 'video/mp4',
  } as unknown as Blob);
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiFetch<UploadImageResult>(`/api/upload?kind=${encodeURIComponent(kind)}${pin}`, {
    method: 'POST',
    formData,
    long: true,
  });
}

/** 本地待上传音频（expo-document-picker asset 的必要子集） */
export interface LocalAudioInput {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
}

/** 音频 mime → 安全扩展名（对齐 upload.py 三重白名单的音频侧；识别不出回落 mp3） */
function audioExtFromMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'audio/wav':
    case 'audio/x-wav':
    case 'audio/wave':
      return 'wav';
    case 'audio/x-m4a':
    case 'audio/m4a':
      return 'm4a';
    case 'audio/ogg':
      return 'ogg';
    case 'audio/flac':
      return 'flac';
    default:
      return 'mp3';
  }
}

/**
 * 驱动音频上传：POST /api/upload?kind=<kind>[&worker=<pin>]（multipart，字段名固定 image，同 upload.py）
 * - wav/mp3/m4a/ogg/flac ≤20MB（后端魔数嗅探 415/413 兜底），客户端在选音频处先验（ref-audio-field）
 * - pinWorker：ltx-nsfw-lipsync 链路把驱动音频钉到参考图落点 worker（LTX2.3 口型同机生成，无转运）
 * - 20MB 移动网络下较慢，走 long 超时（180s）
 */
export async function uploadAudio(
  audio: LocalAudioInput,
  kind: string,
  pinWorker?: string,
): Promise<UploadImageResult> {
  const name = audio.fileName?.trim() || `upload.${audioExtFromMime(audio.mimeType)}`;
  const formData = new FormData();
  // React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob）
  formData.append('image', {
    uri: audio.uri,
    name,
    type: audio.mimeType ?? 'audio/mpeg',
  } as unknown as Blob);
  const pin = pinWorker ? `&worker=${encodeURIComponent(pinWorker)}` : '';
  return apiFetch<UploadImageResult>(`/api/upload?kind=${encodeURIComponent(kind)}${pin}`, {
    method: 'POST',
    formData,
    long: true,
  });
}

// ── 反推提示词（M17，契约已读 apps/api 源码验证：routes/reverse.py）──

/**
 * 反推提示词：POST /api/reverse（multipart，字段名 file——非 image，与 /api/upload 区分）
 * - 图片/视频 → VLM 反推英文 prompt（negative 仅图像可能返回，视频/音频无）
 * - X-NSFW 跟随全局意图由 apiFetch 注入（NSFW 图像走 JoyCaption 专线，reverse.py）
 * - 413 体积超限 / 502 VLM 不可达由 apiFetch 透传人话；VLM 首 token 慢，走 long 超时档（180s）
 * - negative 缺省/null 归一化为 null（调用方按有值展开负向框，对齐 Web ReverseButton 语义）
 */
export async function reversePrompt(
  file: LocalImageInput | LocalVideoInput,
): Promise<ReverseResult> {
  const isVideo = file.mimeType?.startsWith('video/') ?? false;
  const name =
    file.fileName?.trim() ||
    `reverse.${isVideo ? videoExtFromMime(file.mimeType) : extFromMime(file.mimeType)}`;
  const formData = new FormData();
  // React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob）
  formData.append('file', {
    uri: file.uri,
    name,
    type: file.mimeType ?? (isVideo ? 'video/mp4' : 'image/jpeg'),
  } as unknown as Blob);
  const data = await apiFetch<ReverseResult & { negative?: string | null }>('/api/reverse', {
    method: 'POST',
    formData,
    long: true,
  });
  return { kind: data.kind, prompt: data.prompt, negative: data.negative ?? null };
}

// ── 优化提示词（M18，契约已读 apps/api 源码验证：routes/optimize.py）──

/**
 * 优化提示词：POST /api/optimize
 * - 口语化输入 → LLM 按题材扩写专业英文 prompt（negative 仅 image/image_edit/video 类返回）
 * - kind 跟随当前选中引擎的 kind（image/video/audio 直通，后端按 kind 切系统提示）
 * - model/style/agent_id/style_hint 为 Web 高阶入参（模型族方言/智能体人格），移动端本期走默认
 * - 502 优化失败 / 503 LLM 不可达由 apiFetch 透传人话；negative 缺省归一化为 null
 */
export async function optimizePrompt(params: {
  prompt: string;
  kind: string;
}): Promise<OptimizeResult> {
  const data = await apiFetch<OptimizeResult & { negative?: string | null }>('/api/optimize', {
    method: 'POST',
    body: params,
  });
  return { optimized: data.optimized, negative: data.negative ?? null };
}

/**
 * LTX-2.5 文生视频：POST /api/ltx25/t2v → GenerateResponse
 * 视频生成分钟级长任务，走 long 超时档（180s）；422 首条 msg 由 apiFetch 统一展开
 */
export async function submitLtx25T2V(params: Ltx25T2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/ltx25/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LTX-2.5 图生视频：POST /api/ltx25/i2v → GenerateResponse
 * image/worker 必须来自同一次 uploadImage 响应（kind=ltx_i2v，后端转运到 :8198 专用实例）
 */
export async function submitLtx25I2V(params: Ltx25I2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/ltx25/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * Wan2.2-Animate 动作迁移：POST /api/wan/animate → GenerateResponse
 * image/video 互钉同 worker（上传时完成），后端从该 worker 转运到 :8197 实例
 */
export async function submitWanAnimate(params: WanAnimateRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/wan/animate', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * Wan2.1-VACE 多参考视频：POST /api/wan/vace → GenerateResponse
 * images 1-4 张全部互钉同 worker，worker 取第一张落点
 */
export async function submitWanVace(params: WanVaceRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/wan/vace', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// ── H3 / LongCat / ACE 引擎链路（M10，契约已读 apps/api 源码验证：routes/h3_studio.py / longcat_studio.py / audio.py）──

/**
 * MiniMax H3 文生视频：POST /api/h3/t2v → GenerateResponse
 * loras 数组原样透传（≤3 个；R18 LoRA 门控在后端 403）；分钟级长任务走 long 超时档（180s）
 */
export async function submitH3T2V(params: H3T2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/h3/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * MiniMax H3 图生视频：POST /api/h3/i2v → GenerateResponse
 * image/worker 必须来自同一次 uploadImage 响应（kind=h3_i2v，pool worker 仅存文件，后端转运 H3 实例）
 */
export async function submitH3I2V(params: H3I2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/h3/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LongCat 文生视频：POST /api/longcat/t2v → GenerateResponse
 * 长镜头引擎（961 帧@16fps≈60s）；无 cfg（蒸馏链路固定 1.0）；分钟级长任务走 long 超时档
 */
export async function submitLongCatT2V(params: LongCatT2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LongCat 图生视频：POST /api/longcat/i2v → GenerateResponse
 * image/worker 必须来自同一次 uploadImage 响应（kind 复用 ltx_i2v，后端转运 :8197 实例）
 */
export async function submitLongCatI2V(params: LongCatI2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LongCat 视频续写：POST /api/longcat/continue → GenerateResponse
 * video 为 /api/images? 产物 URL；width/height/fps 省略时后端 ffprobe 实测源视频对齐
 */
export async function submitLongCatContinue(
  params: LongCatContinueRequest,
): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/longcat/continue', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * ACE-Step 文生音乐：POST /api/generate/audio → GenerateResponse
 * tags=风格标签（主提示词映射）；产物 MP3 ≤240s，合成走 long 超时档（180s）
 */
export async function submitAceMusic(params: AceMusicRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/audio', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// ── R18 视频引擎链路（M11，契约已读 apps/api 源码验证：routes/video.py；仅 NSFW 上下文放行）──

/**
 * LTX-2.3 文生视频（R18）：POST /api/generate/ltx-t2v → GenerateResponse
 * 10Eros 底模，后端 _gate_ltx_nsfw 仅 /nsfw 专区（X-NSFW 头）放行，主站上下文 403；
 * 分钟级长任务走 long 超时档（180s）
 */
export async function submitLtxNsfwT2V(params: LtxNsfwT2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-t2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LTX-2.3 图生视频（R18）：POST /api/generate/ltx-i2v → GenerateResponse
 * image/worker 必须来自同一次 uploadImage 响应（kind=ltx_i2v；LTX2.3 跑 pool worker，生成同机无转运）
 */
export async function submitLtxNsfwI2V(params: LtxNsfwI2VRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-i2v', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * LTX-2.3 口型同步（R18）：POST /api/generate/ltx-lipsync → GenerateResponse
 * image/audio 互钉同 worker（kind=ltx_lipsync 上传时完成）；id_lora 留空即不用（后端默认 ''）
 */
export async function submitLtxNsfwLipsync(params: LtxNsfwLipsyncRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/generate/ltx-lipsync', {
    method: 'POST',
    body: params,
    long: true,
  });
}

// h3-nsfw-t2v / h3-nsfw-i2v 复用 submitH3T2V / submitH3I2V（与 SFW 同一 POST /api/h3/* 提交链路）

// ── LongCat-Avatar 数字人链路（M14，契约已读 apps/api 源码验证：routes/avatar_studio.py）──

/**
 * LongCat-Avatar 数字人说话视频：POST /api/avatar/talk → GenerateResponse
 * image/audio 必须来自 /api/upload?kind=avatar 响应且互钉同 worker（后端从该机转运 :8197 LongCat 实例）；
 * 分钟级长任务（>93 帧自动链式续段）走 long 超时档（180s）
 */
export async function submitAvatarTalk(params: AvatarTalkRequest): Promise<GenerateResponse> {
  return apiFetch<GenerateResponse>('/api/avatar/talk', {
    method: 'POST',
    body: params,
    long: true,
  });
}

/**
 * 作业列表：GET /api/jobs?limit&offset&status&kind → JobItem[]（原样数组，最新在前）
 * 移动端轮询载体（RN 无原生 EventSource，且后端已做服务端追踪，轮询不丢结果）
 * offset（M15，jobs.py list_jobs）：分页偏移，默认 0 不带参数；返回数===limit 即可能还有下一页
 * kind（M16）：服务端媒体类型过滤，逗号分隔多值（如 "txt2img,wan_t2v"），空=全部
 */
export async function listJobs(options: { limit?: number; offset?: number; status?: string; kind?: string } = {}): Promise<JobItem[]> {
  const { limit = 50, offset = 0, status = '', kind = '' } = options;
  const qs = `?limit=${limit}${offset > 0 ? `&offset=${offset}` : ''}${status ? `&status=${encodeURIComponent(status)}` : ''}${kind ? `&kind=${encodeURIComponent(kind)}` : ''}`;
  return apiFetch<JobItem[]>(`/api/jobs${qs}`);
}

/** 删除作业：DELETE /api/jobs/{id}（仅本人；产物文件由后端另行清理） */
export async function deleteJob(jobId: string): Promise<void> {
  await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}`, { method: 'DELETE' });
}

/**
 * 精确重生：POST /api/jobs/{key}/rerun → RerunResponse
 * has_params=false 的旧作品后端 400（无参数快照）；不支持类型 400；explicit 缺 seed 422
 */
export async function rerunJob(jobKey: string, body: RerunRequest = {}): Promise<RerunResponse> {
  return apiFetch<RerunResponse>(`/api/jobs/${encodeURIComponent(jobKey)}/rerun`, {
    method: 'POST',
    body,
  });
}

/** 同根版本链：GET /api/jobs/{key}/versions → JobItem[]（时间升序，主站过滤 R18） */
export async function fetchVersions(jobKey: string): Promise<JobItem[]> {
  return apiFetch<JobItem[]>(`/api/jobs/${encodeURIComponent(jobKey)}/versions`);
}

// ── 参考资产库（M13，契约已读 apps/api 源码验证：routes/reference_assets.py）──

/**
 * 资产列表：GET /api/assets?kind=<kind>（kind 可选过滤）
 * 仅当前用户资产；nsfw 资产由后端按 X-NSFW 上下文过滤，前端不做判断
 */
export async function listAssets(kind?: AssetKind): Promise<AssetItem[]> {
  const qs = kind ? `?kind=${encodeURIComponent(kind)}` : '';
  return apiFetch<AssetItem[]>(`/api/assets${qs}`);
}

/** 新建资产：POST /api/assets（images 1-4 张上传句柄；name 1-100 / description ≤2000 由表单先验） */
export async function createAsset(body: AssetCreateBody): Promise<AssetItem> {
  return apiFetch<AssetItem>('/api/assets', { method: 'POST', body });
}

/** 单查：GET /api/assets/{id}（他人资产 / nsfw 资产在 SFW 上下文一律 404 防枚举） */
export async function getAsset(id: string): Promise<AssetItem> {
  return apiFetch<AssetItem>(`/api/assets/${encodeURIComponent(id)}`);
}

/** 部分更新：PATCH /api/assets/{id}（仅 patch 中出现的字段生效，其余后端原样保留） */
export async function updateAsset(id: string, patch: AssetPatchBody): Promise<AssetItem> {
  return apiFetch<AssetItem>(`/api/assets/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    body: patch,
  });
}

/** 删除：DELETE /api/assets/{id} → {ok, id}（只删 DB 记录，worker 上的文件本体不动） */
export async function deleteAsset(id: string): Promise<void> {
  await apiFetch(`/api/assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

/**
 * 资产参考图 URL：GET /api/assets/{id}/images/{index}
 * 后端从落点 worker 的 input 目录代理字节（主 worker 掉线回退同机 worker）；
 * <Image> source.uri 直用，token query 由 mediaUrl 拼（媒体标签无法带请求头）
 */
export function assetImageUrl(id: string, index: number): string {
  return mediaUrl(`/api/assets/${encodeURIComponent(id)}/images/${index}`);
}

// ── 对话助手（M19，契约已读 apps/api 源码验证：routes/agent.py / agent/runner.py）──

/**
 * 对话流：POST /api/agent/chat（SSE）
 * - 走 expo/fetch（全局 fetch 在 RN 拿不到流式 body）；事件帧 `event: msg` data 为 AgentEvent JSON，
 *   `event: done` 收尾（agent.py stream()）；会话 id 经响应头 X-Agent-Session-Id 立即返回
 * - 整体不设超时：工具链（文生图/视频）分钟级长任务，sse_starlette 保活心跳兜底；
 *   中止由调用方 signal 驱动（离开屏/手动停止），中止静默返回已获 sessionId
 * - 单帧坏 JSON 跳过不中断流；HTTP 错误与 apiFetch 同一套人话
 * - 请求体仅 messages + 可选 session_id / document_ids（M20 挂载文档 ≤8 个由后端硬上限兜底）
 *   / image（M30 附图 {filename,worker}，runner 注入 system 提示并把 attachment 传给
 *   edit_image/generate_3d 工具，从该 worker input 目录读字节）
 */
export async function agentChatStream(
  params: {
    messages: AgentChatMessage[];
    sessionId?: string;
    documentIds?: string[];
    image?: AgentChatImage;
  },
  onEvent: (event: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<{ sessionId: string }> {
  const { messages, sessionId, documentIds, image } = params;
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'Content-Type': 'application/json',
  };
  const token = await getToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  if (nsfwIntent) headers['X-NSFW'] = '1';

  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(`${resolveApiBase()}/api/agent/chat`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        messages,
        ...(sessionId ? { session_id: sessionId } : {}),
        // 空数组不带字段（对齐后端 default_factory=list 语义，少传少错）
        ...(documentIds && documentIds.length > 0 ? { document_ids: documentIds } : {}),
        // M30 附图：单张 {filename,worker} 上传句柄（缺省不带字段）
        ...(image ? { image } : {}),
      }),
      signal: signal ?? null,
    });
  } catch {
    // 中止由调用方自判（其持有 aborted 状态），此处静默等价于「未开始的轮次」
    if (signal?.aborted) return { sessionId: '' };
    throw new ApiError(0, '网络连接失败，请检查网络');
  }

  if (!res.ok) {
    throw new ApiError(res.status, friendlyMessage(res.status, await readErrorDetail(res)));
  }

  const sid = res.headers.get('X-Agent-Session-Id') ?? '';
  if (!res.body) {
    // expo/fetch web 回落等环境无流式 body，视为协议不满足
    throw new ApiError(0, '当前环境不支持流式响应');
  }

  try {
    await parseSseStream(
      res.body.getReader(),
      (event, data) => {
        if (event !== 'msg') return; // done/其他帧不在一期 UI 契约内
        try {
          onEvent(JSON.parse(data) as AgentEvent);
        } catch {
          // 防御：单帧坏数据不中断整条流
        }
      },
      signal,
    );
  } catch (e) {
    if (signal?.aborted) return { sessionId: sid };
    throw e instanceof ApiError ? e : new ApiError(0, '流读取中断，请重试');
  }
  return { sessionId: sid };
}

/**
 * 会话列表：GET /api/agent/sessions → AgentSessionSummary[]（updated_at 倒序，含消息数）
 * nsfw 会话由后端按 X-NSFW 上下文过滤（对齐 Job 过滤语义），前端不做判断
 */
export async function listAgentSessions(): Promise<AgentSessionSummary[]> {
  return apiFetch<AgentSessionSummary[]>('/api/agent/sessions');
}

/**
 * 会话详情：GET /api/agent/sessions/{sid} → 全消息回放（id 升序即对话顺序）
 * 归属/R18 校验失败一律 404（后端不泄露存在性），由 apiFetch 透传人话
 */
export async function getAgentSession(sessionId: string): Promise<AgentSessionDetail> {
  return apiFetch<AgentSessionDetail>(`/api/agent/sessions/${encodeURIComponent(sessionId)}`);
}

/** 删除会话：DELETE /api/agent/sessions/{sid} → {ok}（消息随会话一并删除，agent.py） */
export async function deleteAgentSession(sessionId: string): Promise<void> {
  await apiFetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' });
}

/**
 * 分叉会话：POST /api/agent/sessions/{sid}/fork → 会话摘要（M24）
 * - atMessageId 缺省：不带 body 全量复制；有值：body {at_message_id} 截断复制到该消息（含）
 *   （agent.py ForkRequest body 可空；新会话继承源 title/nsfw）
 * - at_message_id 不在会话内 404「消息不存在」，由 apiFetch 统一透传资源人话
 */
export async function forkAgentSession(
  sessionId: string,
  atMessageId?: number,
): Promise<AgentSessionSummary> {
  return apiFetch<AgentSessionSummary>(
    `/api/agent/sessions/${encodeURIComponent(sessionId)}/fork`,
    {
      method: 'POST',
      ...(atMessageId !== undefined ? { body: { at_message_id: atMessageId } } : {}),
    },
  );
}

// ── 文档挂载（M20，契约已读 apps/api 源码验证：routes/documents.py / services/docs.py）──

/** 本地待上传文档（expo-document-picker asset 的必要子集） */
export interface LocalDocInput {
  uri: string;
  fileName?: string | null;
  mimeType?: string;
}

/** 文档 mime → 安全扩展名（对齐 services/docs.py _KINDS；识别不出回落 txt） */
function docExtFromMime(mimeType: string | undefined): string {
  switch (mimeType) {
    case 'application/pdf':
      return 'pdf';
    case 'application/vnd.openxmlformats-officedocument.wordprocessingml.document':
      return 'docx';
    case 'text/markdown':
      return 'md';
    default:
      return 'txt';
  }
}

/** 文档列表：GET /api/docs → DocItem[]（created_at 倒序由后端保证，documents.py list_docs） */
export async function listDocs(): Promise<DocItem[]> {
  return apiFetch<DocItem[]>('/api/docs');
}

/**
 * 文档上传：POST /api/docs/upload（multipart，字段名 file——与 /api/upload 的 image 区分）→ 201 DocItem
 * - 仅 pdf/docx/txt/md ≤50MB（后端 400/413/422 兜底），客户端在选文档处先验（assistant 屏 doc-sheet）
 * - 不手设 Content-Type（边界由运行时生成，与 uploadImage 同一约定）
 * - 大文件解析 CPU 密集（documents.py 线程池秒级），走 long 超时档（180s）
 */
export async function uploadDoc(doc: LocalDocInput): Promise<DocItem> {
  const name = doc.fileName?.trim() || `document.${docExtFromMime(doc.mimeType)}`;
  const formData = new FormData();
  // React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob）
  formData.append('file', {
    uri: doc.uri,
    name,
    type: doc.mimeType ?? 'text/plain',
  } as unknown as Blob);
  return apiFetch<DocItem>('/api/docs/upload', {
    method: 'POST',
    formData,
    long: true,
  });
}

/** 删除文档：DELETE /api/docs/{id} → {ok:true}（元数据 + 落盘原文/索引文件一并清理；404 不泄露存在性） */
export async function deleteDoc(docId: string): Promise<void> {
  await apiFetch(`/api/docs/${encodeURIComponent(docId)}`, { method: 'DELETE' });
}

// ── Agent 团队运行监控（M21，契约已读 apps/api 源码验证：routes/agent_team.py / services/agent_team_exec.py）──

/**
 * 运行列表：GET /api/agent-runs?limit=50&status= → AgentRunSummary[]（created_at 倒序）
 * status 空=全部；后端精确匹配（awaiting_confirm / awaiting_assembly 需分列过滤）
 */
export async function listAgentRuns(status: string = ''): Promise<AgentRunSummary[]> {
  const qs = `?limit=50${status ? `&status=${encodeURIComponent(status)}` : ''}`;
  return apiFetch<AgentRunSummary[]>(`/api/agent-runs${qs}`);
}

/** 运行详情：GET /api/agent-runs/{run_id}（他人/不存在一律 404「任务不存在」，apiFetch 透传人话） */
export async function getAgentRun(runId: string): Promise<AgentRunDetail> {
  return apiFetch<AgentRunDetail>(`/api/agent-runs/${encodeURIComponent(runId)}`);
}

/** 取消运行：POST /api/agent-runs/{run_id}/cancel（非可取消态 409 由 apiFetch 透传 detail） */
export async function cancelAgentRun(runId: string): Promise<{ run_id: string; status: string }> {
  return apiFetch<{ run_id: string; status: string }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/cancel`,
    { method: 'POST' },
  );
}

/**
 * 确认门裁决：POST /api/agent-runs/{run_id}/resume → {run_id, status}
 * - gate=plan 仅 awaiting_confirm/planning 可裁决；gate=assembly 仅 awaiting_assembly（否则 409 人话透传）
 * - approve 通过进 running（计划门启动图执行/合成门投递合成裁决）；
 *   reject 打回（计划门回 planning 重规划，feedback 记入 run.error；合成门回 running 可单卡重生成）
 * - modify 仅记录裁决（M23 起实际改动先走 updateAgentRunPlan POST /plan，成功后计划门投 modify）
 */
export async function resumeAgentRun(
  runId: string,
  body: AgentResumeBody,
): Promise<{ run_id: string; status: string }> {
  return apiFetch<{ run_id: string; status: string }>(
    `/api/agent-runs/${encodeURIComponent(runId)}/resume`,
    { method: 'POST', body },
  );
}

/**
 * 卡片级干预：POST /api/agent-runs/{run_id}/tasks/{task_id}/action → 直接返回任务详情（顶层即卡片字段，无包装）
 * - edit：payload={input:{...}} 合并进任务 input，卡片回 pending 待重跑
 * - regenerate：payload={guidance?} 引导词拼进主文案；仅 done/error 可重生（409/400 人话透传）
 * - approve：卡片置 approved
 * - upload：payload={url} 替换产物（仅本地产物 /api/studio/files/{name}；合成卡 400）
 * - reprompt：反推产物提示词写回 input（仅图像/视频卡；未产出 409/丢失 404；卡片保持 done）
 */
export async function agentTaskAction(
  runId: string,
  taskId: string,
  body: AgentTaskActionBody,
): Promise<AgentRunTask> {
  return apiFetch<AgentRunTask>(
    `/api/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/action`,
    { method: 'POST', body },
  );
}

/**
 * 卡片产物直传替换（M33）：POST /api/agent-runs/{run_id}/tasks/{task_id}/upload（multipart，字段名 file）
 * - React Native FormData 文件三段式 { uri, name, type }（运行时不读 Blob），不手设 Content-Type
 * - 三重白名单/413/415 人话由后端兜底透出；long 超时（180s，视频可达 200MB）
 * - 返回任务详情（顶层即卡片字段，与 agentTaskAction 同形，调用方局部替换）
 */
export async function uploadAgentTaskAsset(
  runId: string,
  taskId: string,
  file: LocalImageInput,
): Promise<AgentRunTask> {
  const name = file.fileName?.trim() || `upload.${extFromMime(file.mimeType)}`;
  const formData = new FormData();
  formData.append('file', {
    uri: file.uri,
    name,
    type: file.mimeType ?? 'image/jpeg',
  } as unknown as Blob);
  return apiFetch<AgentRunTask>(
    `/api/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/upload`,
    { method: 'POST', formData, long: true },
  );
}

// ── Agent 团队三期（M23，契约已读 apps/api 源码验证：routes/agent_team.py edit_plan / run_result）──

/**
 * 计划编辑：POST /api/agent-runs/{run_id}/plan → {run_id, plan:{tasks}}
 * - 仅 awaiting_confirm 可编辑（否则 409「仅待确认状态可编辑计划」人话透传）
 * - body {tasks: ops}：update 标题直改/input 按键合并（不动未提交字段）；remove 服务端清理悬挂
 *   depends_on；add 支持前端预生成 id（kind/depends_on 从 input 读，缺省 video/无依赖）
 * - 成功推 plan SSE 事件（详情屏经既有事件流就地更新），返回的 plan 简报不作本地事实源
 */
export async function updateAgentRunPlan(
  runId: string,
  ops: AgentPlanEditOp[],
): Promise<AgentRunPlanUpdateResult> {
  return apiFetch<AgentRunPlanUpdateResult>(
    `/api/agent-runs/${encodeURIComponent(runId)}/plan`,
    { method: 'POST', body: { tasks: ops } },
  );
}

/**
 * 成片结果：GET /api/agent-runs/{run_id}/result → {final_url, duration_sec, tasks}
 * - 仅 done 可取（否则 409「任务尚未完成」人话透传；调用方按状态门控，竞态 409 静默不展示）
 * - final_url 取自 assemble done 卡 output.url（空串=合成产物缺失，UI 不渲染成片卡）；
 *   duration_sec 为 video/image 卡 input.duration_sec 合计
 */
export async function getAgentRunResult(runId: string): Promise<AgentRunResult> {
  return apiFetch<AgentRunResult>(`/api/agent-runs/${encodeURIComponent(runId)}/result`);
}

/**
 * 运行事件流：GET /api/agent-runs/{run_id}/events?after=N（SSE）
 * - 走 expo/fetch（全局 fetch 在 RN 拿不到流式 body，与 agentChatStream 同一通道）
 * - 鉴权 token 走 query（`?token=`，后端 get_current_user 兼容 query token——原生 EventSource
 *   不能带请求头；同步补 Authorization 头双通道防御），after 为断点续传游标（只推 id > after）
 * - 事件帧 `event: {type}` data 为 JSON；经 toAgentRunEvent 守卫，坏帧/未知类型跳过不中断
 * - run 终态（done/error/canceled）推完残留事件后由后端关流，本函数自然 resolve；
 *   整体不设超时（执行期分钟级长任务，sse_starlette 保活心跳兜底），中止由调用方 signal 驱动并静默返回
 */
export async function watchAgentRunEvents(
  runId: string,
  after: number,
  onEvent: (event: AgentRunEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const token = await getToken();
  const qs = `?after=${Math.max(0, Math.floor(after))}${token ? `&token=${encodeURIComponent(token)}` : ''}`;
  const headers: Record<string, string> = { Accept: 'text/event-stream' };
  if (token) headers.Authorization = `Bearer ${token}`;

  let res: Awaited<ReturnType<typeof expoFetch>>;
  try {
    res = await expoFetch(
      `${resolveApiBase()}/api/agent-runs/${encodeURIComponent(runId)}/events${qs}`,
      { method: 'GET', headers, signal: signal ?? null },
    );
  } catch {
    // 中止由调用方自判（其持有 aborted 状态），此处静默等价于「未开始的监听」
    if (signal?.aborted) return;
    throw new ApiError(0, '网络连接失败，请检查网络');
  }

  if (!res.ok) {
    throw new ApiError(res.status, friendlyMessage(res.status, await readErrorDetail(res)));
  }
  if (!res.body) {
    // expo/fetch web 回落等环境无流式 body，视为协议不满足
    throw new ApiError(0, '当前环境不支持流式响应');
  }

  try {
    await parseSseStream(
      res.body.getReader(),
      (event, data) => {
        try {
          const ev = toAgentRunEvent(event, JSON.parse(data));
          if (ev) onEvent(ev);
        } catch {
          // 防御：单帧坏数据不中断整条流
        }
      },
      signal,
    );
  } catch (e) {
    if (signal?.aborted) return;
    throw e instanceof ApiError ? e : new ApiError(0, '流读取中断，请重试');
  }
}
