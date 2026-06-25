import { CACHE_KEYS, TTL, invalidate, swr } from "./swr-cache";
import type {
  AdminUser,
  GenerateResponse,
  Img2ImgGenParams,
  JobItem,
  LocalModels,
  MarketItem,
  ModelsResponse,
  Txt2ImgParams,
  Usage,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8080";
const TOKEN_KEY = "toiv_token";

export interface AppUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthResult {
  token: string;
  user: AppUser;
}

// ---------- 令牌存储 ----------
export function getToken(): string | null {
  return typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
}
export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/** 后端图片路径是相对的，拼成可访问 URL 并附带令牌（<img> 无法带请求头）。 */
export function imageUrl(path: string): string {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;
  return withToken(base);
}

// ---------- 鉴权 ----------
async function postAuth(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `请求失败 (${res.status})`);
  }
  return res.json();
}
export function login(email: string, password: string): Promise<AuthResult> {
  return postAuth("/api/auth/login", { email, password });
}
export async function fetchMe(): Promise<{ user: AppUser; usage: Usage }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("会话已过期");
  return res.json();
}

/**
 * 当前账户(含 R18 软开关状态)。契约:GET /api/auth/me 响应增补 `nsfw_enabled: boolean`。
 * 字段由另一车道实现,暂缺时优雅降级为 false(默认关)。类型放宽以兼容字段缺失。
 */
export interface MeResponse {
  user: AppUser;
  usage: Usage;
  /** R18 软开关;后端字段暂缺时此处归一化为 false。 */
  nsfw_enabled: boolean;
}

async function fetchMeRaw(): Promise<MeResponse> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("会话已过期");
  const data = (await res.json()) as Partial<MeResponse> & { user: AppUser; usage: Usage };
  return { ...data, nsfw_enabled: data.nsfw_enabled === true } as MeResponse;
}

/** 账户(含 R18 态 / 用量),走本机 SWR 缓存:二访秒开,后台静默刷新。 */
export function getMe(): Promise<MeResponse> {
  return swr(CACHE_KEYS.me, fetchMeRaw, TTL.me);
}

/**
 * 切换 R18 软开关(需登录)。契约:POST /api/account/nsfw body {enabled} → {nsfw_enabled}。
 * 返回服务端确认后的真实状态;字段暂缺时回落到请求值(乐观降级)。
 */
export async function setNsfwEnabled(enabled: boolean): Promise<boolean> {
  const res = await fetch(`${API_BASE}/api/account/nsfw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ enabled }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `保存设置失败 (${res.status})`);
  }
  // R18 切换改变后端服务端过滤:失效受其影响的所有缓存,下次重拉。
  invalidate(CACHE_KEYS.me);
  invalidate(CACHE_KEYS.models);
  invalidate(CACHE_KEYS.localModels);
  invalidate(CACHE_KEYS.jobs);
  const data = (await res.json().catch(() => null)) as { nsfw_enabled?: boolean } | null;
  if (data?.nsfw_enabled === true) return true;
  if (data?.nsfw_enabled === false) return false;
  return enabled;
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await fetch(`${API_BASE}/api/admin/users`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载用户失败 (${res.status})`);
  return res.json();
}

export async function createUser(
  email: string,
  password: string,
  role: string,
): Promise<AdminUser> {
  const res = await fetch(`${API_BASE}/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email, password, role }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `创建账号失败 (${res.status})`);
  }
  return res.json();
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `删除失败 (${res.status})`);
  }
}

// ---------- 生成 ----------
async function fetchModelsRaw(): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/api/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载模型列表失败 (${res.status})`);
  return res.json();
}

/** 模型列表,走本机 SWR 缓存(几乎不变,长 TTL):二访秒开,减重复请求。 */
export function listModels(): Promise<ModelsResponse> {
  return swr(CACHE_KEYS.models, fetchModelsRaw, TTL.models);
}

export async function generateTxt2img(
  params: Txt2ImgParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `生成请求失败 (${res.status})`);
  }
  return res.json();
}

async function fetchJobsRaw(): Promise<JobItem[]> {
  const res = await fetch(`${API_BASE}/api/jobs`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载作品失败 (${res.status})`);
  return res.json();
}

/** 作品库,走本机 SWR 缓存(短 TTL):作品库二访秒开,后台刷新补新作品。 */
export function listJobs(): Promise<JobItem[]> {
  return swr(CACHE_KEYS.jobs, fetchJobsRaw, TTL.jobs);
}

/** 生成出新作品后调用:失效作品库缓存,下次进作品库立即拉到最新。 */
export function invalidateJobs(): void {
  invalidate(CACHE_KEYS.jobs);
}

async function fetchLocalModelsRaw(): Promise<LocalModels> {
  const res = await fetch(`${API_BASE}/api/models/local`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载本地模型失败 (${res.status})`);
  return res.json();
}

/** 本地已装模型,走本机 SWR 缓存(中 TTL):减重复请求,偶有安装由 TTL 兜底刷新。 */
export function listLocalModels(): Promise<LocalModels> {
  return swr(CACHE_KEYS.localModels, fetchLocalModelsRaw, TTL.localModels);
}

export async function searchMarketplace(
  source: string,
  query: string,
  type?: string,
): Promise<{ items: MarketItem[]; source: string }> {
  const qs = new URLSearchParams({ source, query });
  if (type) qs.set("type", type);
  const res = await fetch(`${API_BASE}/api/marketplace/search?${qs.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `搜索失败 (${res.status})`);
  }
  return res.json();
}

export async function uploadImage(
  file: File,
  kind: string = "img2img",
): Promise<{ filename: string; worker: string }> {
  const fd = new FormData();
  fd.append("image", file);
  const res = await fetch(`${API_BASE}/api/upload?kind=${encodeURIComponent(kind)}`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type，让浏览器带 boundary
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `上传失败 (${res.status})`);
  }
  return res.json();
}

export async function generateImg2img(
  params: Img2ImgGenParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/img2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface WanI2VGenParams {
  positive: string;
  image: string;
  worker: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  seed?: number | null;
}

export async function generateVideo(
  params: WanI2VGenParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `视频生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface Txt2VideoParams {
  positive: string;
  negative?: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  seed?: number | null;
}

/**
 * 文生视频(text → video)。契约:POST /api/generate/txt2video
 * 请求体 { positive, negative?, width, height, length, fps, seed? }。
 * 后端端点由另一 agent 并行实现。
 */
export async function generateTxt2video(
  params: Txt2VideoParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/txt2video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `文生视频请求失败 (${res.status})`);
  }
  return res.json();
}

export interface Gen3DParams {
  image: string;
  worker: string;
  steps: number;
  cfg: number;
  octree_resolution: number;
  seed?: number | null;
}

export async function generate3D(params: Gen3DParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/3d`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `3D 生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface AudioGenParams {
  tags: string;
  lyrics: string;
  seconds: number;
  seed?: number | null;
}

export async function generateAudio(params: AudioGenParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `音频生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface AgentEvent {
  type: string;
  content?: string;
  name?: string;
  urls?: string[];
  args?: Record<string, unknown>;
}

export interface AgentImageRef {
  filename: string;
  worker: string;
}

export async function agentChat(
  messages: { role: string; content: string }[],
  onEvent: (ev: AgentEvent) => void,
  image?: AgentImageRef | null,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(image ? { messages, image } : { messages }),
    signal,
  });
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `对话失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // 事件以空行分隔;兼容 \r\n\r\n(sse-starlette/反代)与 \n\n
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "done") return;
      if (data) {
        try {
          onEvent(JSON.parse(data) as AgentEvent);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}

export interface OptimizeResult {
  optimized: string;
  negative?: string | null;
}

export async function optimizePrompt(prompt: string, kind: string): Promise<OptimizeResult> {
  const res = await fetch(`${API_BASE}/api/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt, kind }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `优化失败 (${res.status})`);
  }
  const data = await res.json();
  return { optimized: (data.optimized as string) ?? prompt, negative: data.negative ?? null };
}

export function jobEventsUrl(
  promptId: string,
  clientId: string,
  worker: string,
): string {
  const qs = new URLSearchParams({ client_id: clientId, worker });
  return withToken(`${API_BASE}/api/jobs/${promptId}/events?${qs.toString()}`);
}

// ---------- 漫剧工作室 ----------
export interface ManjuCharacter {
  name: string;
  desc?: string;
}

export interface StoryboardParams {
  premise: string;
  num_shots?: number;
  style?: string;
  characters?: ManjuCharacter[];
}

export interface StoryboardShot {
  id: string;
  scene: string;
  description: string;
  characters: string[];
  camera: string;
  dialogue: string;
  duration_sec: number;
}

export async function generateStoryboard(
  params: StoryboardParams,
): Promise<{ shots: StoryboardShot[] }> {
  const res = await fetch(`${API_BASE}/api/manju/storyboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `分镜生成失败 (${res.status})`);
  }
  return res.json();
}

export type ManjuTransition = "none" | "crossfade";

export interface AssembleOptions {
  transition: ManjuTransition;
  bgm_url: string | null;
  subtitles: string[];
  fps: number;
}

export interface AssembleResult {
  url: string;
  name: string;
}

/**
 * 漫剧自动剪辑:把各镜视频片段(按镜序)拼成成片。
 * 契约:POST /api/manju/assemble
 *   body { clips: string[](1..48), options: { transition, bgm_url, subtitles, fps } }
 *   → { url: "/api/manju/output/manju-xxx.mp4", name }
 * clips 传后端存的路径形态(相对 "/..." 或 worker host),后端走来源白名单。
 */
export async function assembleManju(
  clips: string[],
  options: AssembleOptions,
): Promise<AssembleResult> {
  const res = await fetch(`${API_BASE}/api/manju/assemble`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ clips, options }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `合成成片失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 创作引擎 HUD:实时遥测 ----------

export interface LiveGpuStat {
  id: string;
  load: number;
  vram?: number;
}

export interface LiveTelemetry {
  gpus: LiveGpuStat[];
  queueDepth: number;
  outputCount: number;
}

/** 拉取 4 卡实时遥测(显存负载/队列);失败返回 null → 前端回落 MOCK。 */
export async function getGpuStats(signal?: AbortSignal): Promise<LiveTelemetry | null> {
  try {
    const res = await fetch(`${API_BASE}/api/system/gpu`, { signal });
    if (!res.ok) return null;
    return (await res.json()) as LiveTelemetry;
  } catch {
    return null;
  }
}

// ---------- 创作画布:产物归档(客户端作品库标记) ----------
//   画布产物经 /api/generate/* 已自动落库进 /api/jobs 作品库;
//   归档是用户在画布上主动「收藏」的客户端标记,优先客户端实现,
//   不依赖新后端端点。键与 components/canvas/storage.ts 共用,
//   此处提供 lib 层最小读接口供作品库等域按需合并展示。

const CANVAS_ARCHIVE_KEY = "toiv_canvas_archive_v1";

export interface CanvasArchivedAsset {
  url: string;
  kind: string;
  prompt: string;
  archivedAt: number;
}

/** 读取画布主动归档的产物清单;无 / 损坏返回空数组(优雅降级)。 */
export function listCanvasArchive(): CanvasArchivedAsset[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(CANVAS_ARCHIVE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { version?: number; items?: unknown };
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) return [];
    return (parsed.items as CanvasArchivedAsset[]).filter(
      (a) => typeof a?.url === "string",
    );
  } catch {
    return [];
  }
}
