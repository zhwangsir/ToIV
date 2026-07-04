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
// /nsfw 专页:按请求带 R18 放行标记(后端 ContextVar 据此放行,不动账户全局开关)。
let _nsfwIntent = false;
export function setNsfwIntent(on: boolean): void {
  _nsfwIntent = on;
}

function authHeaders(): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = t ? { Authorization: `Bearer ${t}` } : {};
  if (_nsfwIntent) h["X-NSFW"] = "1";
  return h;
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
/** AI 测试通道:用密钥换 token,免登录表单。契约:POST /api/auth/test-login { key }。 */
export function testLogin(key: string): Promise<AuthResult> {
  return postAuth("/api/auth/test-login", { key });
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

/** 模型列表,走本机 SWR 缓存(几乎不变,长 TTL):二访秒开,减重复请求。
 *  /nsfw 用独立缓存键 + X-NSFW 标记,避免 R18 模型污染主页缓存。 */
export function listModels(): Promise<ModelsResponse> {
  return swr(_nsfwIntent ? `${CACHE_KEYS.models}:nsfw` : CACHE_KEYS.models, fetchModelsRaw, TTL.models);
}

// ---------- Forge 第二出图引擎 ----------

export interface ForgeStatus {
  enabled: boolean;
  online: boolean;
}

/** Forge(reForge)在线状态;前端据此显示「引擎切换」。失败优雅回落未部署。 */
export async function getForgeStatus(): Promise<ForgeStatus> {
  try {
    const res = await fetch(`${API_BASE}/api/forge/status`, { headers: authHeaders() });
    if (!res.ok) return { enabled: false, online: false };
    return (await res.json()) as ForgeStatus;
  } catch {
    return { enabled: false, online: false };
  }
}

/** Forge 可用 SD 底模标题列表(后端已过滤非 SD 权重);失败返回空。 */
export async function getForgeModels(): Promise<string[]> {
  try {
    const res = await fetch(`${API_BASE}/api/forge/models`, { headers: authHeaders() });
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: { title: string }[] };
    return (data.models ?? []).map((m) => m.title).filter(Boolean);
  } catch {
    return [];
  }
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

// ---------- 版本树:精确重生(rerun)/ 版本链(versions) ----------

/** rerun 选项:keep=锁 seed 微调 / random=换 seed 重抽;overrides 只改增量(如 positive)。 */
export interface RerunOptions {
  seed_mode: "keep" | "random";
  overrides?: Record<string, unknown>;
}

export interface RerunResponse extends GenerateResponse {
  job_id?: string;
  parent_id?: string;
  root_id?: string;
}

/** 从历史作业精确重生;寻址接受 job id 或 prompt_id。新作业自动挂进版本链。 */
export async function rerunJob(jobKey: string, opts: RerunOptions): Promise<RerunResponse> {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobKey)}/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `重新生成失败 (${res.status})`);
  }
  return res.json();
}

/** 同根版本链(时间升序);寻址接受 job id 或 prompt_id。 */
export async function jobVersions(jobKey: string): Promise<JobItem[]> {
  const res = await fetch(`${API_BASE}/api/jobs/${encodeURIComponent(jobKey)}/versions`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `加载版本历史失败 (${res.status})`);
  }
  return res.json();
}

/** 从作品库删除一件作品(按 job id);成功后失效缓存。 */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `删除失败 (${res.status})`);
  }
  invalidateJobs();
}

async function fetchLocalModelsRaw(): Promise<LocalModels> {
  const res = await fetch(`${API_BASE}/api/models/local`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载本地模型失败 (${res.status})`);
  return res.json();
}

/** 本地已装模型,走本机 SWR 缓存(中 TTL):减重复请求,偶有安装由 TTL 兜底刷新。 */
export function listLocalModels(): Promise<LocalModels> {
  return swr(_nsfwIntent ? `${CACHE_KEYS.localModels}:nsfw` : CACHE_KEYS.localModels, fetchLocalModelsRaw, TTL.localModels);
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
  allWorkers = false, // true=分发到所有 worker(角色参考图,供带参考图的分镜跨机并行出图)
): Promise<{ filename: string; worker: string; workers?: string[]; all_workers?: boolean }> {
  const fd = new FormData();
  fd.append("image", file);
  const qs = `kind=${encodeURIComponent(kind)}${allWorkers ? "&all_workers=true" : ""}`;
  const res = await fetch(`${API_BASE}/api/upload?${qs}`, {
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

export interface ControlNetParams {
  positive: string;
  image: string; // 已上传的控制图文件名
  worker: string; // 控制图所在 worker
  controlType: string; // canny | depth | lineart | openpose
  negative?: string;
  ckptName?: string;
  strength?: number;
  startPercent?: number;
  endPercent?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number | null;
}

/** ControlNet 出图。契约:POST /api/generate/controlnet。 */
export async function generateControlNet(params: ControlNetParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/controlnet`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      positive: params.positive,
      image: params.image,
      worker: params.worker,
      control_type: params.controlType,
      negative: params.negative ?? "",
      ckpt_name: params.ckptName,
      strength: params.strength,
      start_percent: params.startPercent,
      end_percent: params.endPercent,
      steps: params.steps,
      cfg: params.cfg,
      sampler: params.sampler,
      scheduler: params.scheduler,
      ...(params.seed != null ? { seed: params.seed } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `ControlNet 生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface UpscaleGenParams {
  image: string; // 已上传的源图文件名
  worker: string; // 源图所在 worker
  modelName?: string;
  scale?: number; // 目标倍数(1.5-4)
}

export async function generateUpscale(params: UpscaleGenParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      ...(params.modelName ? { model_name: params.modelName } : {}),
      ...(params.scale != null ? { scale: params.scale } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `放大请求失败 (${res.status})`);
  }
  return res.json();
}

export interface FaceFixParams {
  image: string; // 已上传的源图文件名
  worker: string;
  positive?: string;
  negative?: string;
  ckptName?: string;
  denoise?: number;
}

export async function generateFaceDetailer(params: FaceFixParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/facedetailer`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      ...(params.positive ? { positive: params.positive } : {}),
      ...(params.negative ? { negative: params.negative } : {}),
      ...(params.ckptName ? { ckpt_name: params.ckptName } : {}),
      ...(params.denoise != null ? { denoise: params.denoise } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `脸部修复请求失败 (${res.status})`);
  }
  return res.json();
}

export interface RemoveBgParams {
  image: string; // 已上传的源图文件名
  worker: string;
  mode?: string; // general | anime | human
}

export async function generateRemoveBg(params: RemoveBgParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/removebg`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      ...(params.mode ? { mode: params.mode } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `抠图请求失败 (${res.status})`);
  }
  return res.json();
}

export interface InpaintGenParams {
  image: string; // 已上传的源图文件名
  worker: string;
  target: string; // 要替换区域的文字描述
  positive: string; // 该区域重绘成什么
  negative?: string;
  ckptName?: string;
  denoise?: number;
}

export async function generateInpaint(params: InpaintGenParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/inpaint`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      target: params.target,
      positive: params.positive,
      ...(params.negative ? { negative: params.negative } : {}),
      ...(params.ckptName ? { ckpt_name: params.ckptName } : {}),
      ...(params.denoise != null ? { denoise: params.denoise } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `局部重绘请求失败 (${res.status})`);
  }
  return res.json();
}

export interface RawWorkflowParams {
  graph: Record<string, unknown>; // ComfyUI API-format prompt 图
  worker?: string;
}

export async function generateRaw(params: RawWorkflowParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/raw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      graph: params.graph,
      ...(params.worker ? { worker: params.worker } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `工作流运行请求失败 (${res.status})`);
  }
  return res.json();
}

export interface InstallModelParams {
  type: string;
  url?: string;
  source?: string; // civitai | huggingface
  id?: string;
  filename?: string;
  name?: string;
}

export interface InstallModelResult {
  accepted: boolean;
  endpoint?: string;
  worker?: string;
  message?: string;
  from_catalog?: boolean;
}

/** 把模型装到 ComfyUI 集群。契约:POST /api/marketplace/install。 */
export async function installModel(params: InstallModelParams): Promise<InstallModelResult> {
  const res = await fetch(`${API_BASE}/api/marketplace/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `模型安装请求失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 模型下载到 NAS(绕过 ComfyUI-Manager 白名单)----------

export interface NasStatus {
  enabled: boolean;
  ok?: boolean;
  model_root?: string;
  subdirs?: number;
  error?: string;
}

/** NAS 连通性(前端据此决定下载走 NAS 还是旧 ComfyUI-Manager)。契约:GET /api/nas/status。 */
export async function getNasStatus(): Promise<NasStatus> {
  const res = await fetch(`${API_BASE}/api/nas/status`, { headers: authHeaders() });
  if (!res.ok) return { enabled: false };
  return res.json();
}

/** 起模型下载→NAS(admin)。civitai/huggingface 传 source+id;直链传 source=url+url。 */
export async function nasDownload(params: {
  source: string; // url | hf | civitai | huggingface
  id?: string;
  url?: string;
  hf_repo?: string;
  hf_file?: string;
  type: string;
  filename?: string;
}): Promise<{ job_id: string; filename: string }> {
  const res = await fetch(`${API_BASE}/api/nas/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `下载请求失败 (${res.status})`);
  }
  return res.json();
}

export interface NasDownloadStatus {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  progress: number;
  downloaded_mb: number;
  remote: string | null;
  error: string | null;
  filename: string;
  type: string;
  elapsed: number;
}

/** 轮询下载进度。契约:GET /api/nas/download/{job_id}。 */
export async function getNasDownloadStatus(jobId: string): Promise<NasDownloadStatus> {
  const res = await fetch(`${API_BASE}/api/nas/download/${jobId}`, { headers: authHeaders() });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `查询进度失败 (${res.status})`);
  }
  return res.json();
}

export interface ManjuShotParams {
  positive: string;
  worker?: string; // 参考图分发全 pool 后可空 → 后端 pool.pick 跨机并行;给定则钉该机(旧行为)
  characterRef?: string; // 角色参考图文件名(IPAdapter 人物一致);缺省走普通 txt2img
  negative?: string;
  ckptName?: string;
  preset?: string;
  weight?: number;
  width?: number;
  height?: number;
  steps?: number;
  cfg?: number;
  sampler?: string;
  scheduler?: string;
  seed?: number | null;
}

/** 漫剧单镜出图(可带角色参考图走 IPAdapter)。契约:POST /api/manju/shot。 */
export async function renderManjuShot(params: ManjuShotParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/manju/shot`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      positive: params.positive,
      worker: params.worker,
      character_ref: params.characterRef,
      negative: params.negative,
      ckpt_name: params.ckptName,
      preset: params.preset,
      weight: params.weight,
      width: params.width,
      height: params.height,
      steps: params.steps,
      cfg: params.cfg,
      sampler: params.sampler,
      scheduler: params.scheduler,
      ...(params.seed != null ? { seed: params.seed } : {}),
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `漫剧出图请求失败 (${res.status})`);
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

export async function optimizePrompt(
  prompt: string,
  kind: string,
  model?: string,
): Promise<OptimizeResult> {
  const res = await fetch(`${API_BASE}/api/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ prompt, kind, ...(model ? { model } : {}) }),
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

// ---------- 漫剧工作台:项目 / 资产 / 镜头持久化(可追踪/可复用)----------
export interface ManjuProjectSummary {
  id: string;
  title: string;
  premise: string;
  style: string;
  ckpt_name: string;
  created_at: string;
  updated_at: string;
}

export interface ManjuAssetItem {
  id: string;
  kind: string;
  name: string;
  description: string;
  ref_image: string;
  ref_audio: string;
}

export interface ManjuShotItem {
  id: string;
  idx: number;
  scene: string;
  prompt: string;
  motion: string;
  characters: string[];
  camera: string;
  dialogue: string;
  duration_sec: number;
  negative: string;
  image_job_id: string;
  video_job_id: string;
  image_url: string;
  video_url: string;
  voice_url: string;
  speaker: string;
  status: string;
}

export interface ManjuProjectDetail extends ManjuProjectSummary {
  assets: ManjuAssetItem[];
  shots: ManjuShotItem[];
}

export interface ManjuProjectInput {
  title?: string;
  premise?: string;
  style?: string;
  ckpt_name?: string;
}

export interface ManjuShotInput {
  scene?: string;
  prompt?: string;
  motion?: string;
  negative?: string;
  characters?: string[];
  camera?: string;
  dialogue?: string;
  duration_sec?: number;
  image_url?: string;
  video_url?: string;
  voice_url?: string;
  speaker?: string;
}

/** 漫剧工作台统一 JSON 请求(带 auth + 错误归一)。 */
async function manjuReq<T>(path: string, method: string, body?: unknown): Promise<T> {
  const res = await fetch(`${API_BASE}/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `漫剧项目请求失败 (${res.status})`);
  }
  return res.json();
}

export const listManjuProjects = (): Promise<ManjuProjectSummary[]> =>
  manjuReq("/manju/projects", "GET");
export const createManjuProject = (body: ManjuProjectInput): Promise<ManjuProjectSummary> =>
  manjuReq("/manju/projects", "POST", body);
export const getManjuProject = (pid: string): Promise<ManjuProjectDetail> =>
  manjuReq(`/manju/projects/${pid}`, "GET");
export const updateManjuProject = (
  pid: string,
  body: ManjuProjectInput,
): Promise<ManjuProjectSummary> => manjuReq(`/manju/projects/${pid}`, "PATCH", body);
export const deleteManjuProject = (pid: string): Promise<{ ok: boolean }> =>
  manjuReq(`/manju/projects/${pid}`, "DELETE");
export const saveManjuShots = (
  pid: string,
  shots: ManjuShotInput[],
): Promise<{ shots: ManjuShotItem[] }> =>
  manjuReq(`/manju/projects/${pid}/shots`, "PUT", { shots });

export interface ManjuAssetInput {
  kind?: string;
  name: string;
  description?: string;
  ref_image?: string;
  ref_audio?: string;
}

export const saveManjuAssets = (
  pid: string,
  assets: ManjuAssetInput[],
): Promise<{ assets: ManjuAssetItem[] }> =>
  manjuReq(`/manju/projects/${pid}/assets`, "PUT", { assets });

export interface ManjuVoiceResult {
  url: string;
  name: string;
  duration_sec: number;
}

/**
 * 漫剧逐镜配音:把中文台词送到自部署 TTS(IndexTTS2)合成语音。
 * 契约:POST /api/manju/voice { text, emo_text?, emo_alpha?, ref_audio_url? }
 *   → { url: "/api/manju/voice/voice-xxx.wav", name, duration_sec }
 * ref_audio_url 传角色定妆音色(本 API 资产/白名单 worker)则克隆该音色,否则用兜底音。
 */
export const synthManjuVoice = (body: {
  text: string;
  emo_text?: string;
  emo_alpha?: number;
  ref_audio_url?: string;
}): Promise<ManjuVoiceResult> => manjuReq("/manju/voice", "POST", body);

/**
 * 上传角色定妆音色参考音(任意音频 → 后端 ffmpeg 归一为 wav 存档)。
 * 契约:POST /api/manju/voice-ref multipart(audio)→ { url, name, duration_sec }
 * 返回的 url 存为角色 refAudio,逐镜配音时作 ref_audio_url 克隆该音色。
 */
export async function uploadVoiceRef(file: File): Promise<ManjuVoiceResult> {
  const fd = new FormData();
  fd.append("audio", file);
  const res = await fetch(`${API_BASE}/api/manju/voice-ref`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type，让浏览器带 boundary
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `音色上传失败 (${res.status})`);
  }
  return res.json();
}

// ---------- CAD 工程图 → AI 设计 ----------

export interface CadGeometry {
  walls: number[][];
  racks: number[][];
  w: number;
  h: number;
}

export interface CadUploadResult {
  control_url: string;
  geometry: CadGeometry;
  width: number;
  height: number;
  n_segments: number;
}

/** 上传 DWG/DXF/图 → 服务端转换为干净线稿 + 几何。契约:POST /api/cad/upload multipart(file)。 */
export async function cadUpload(file: File): Promise<CadUploadResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/cad/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `图纸转换失败 (${res.status})`);
  }
  return res.json();
}

/** 控制图 → ControlNet/text2img 出设计图(异步 Job)。preset ∈ colored_plan/aerial_day|dusk|night/interior。 */
export const cadRender = (body: {
  control_url: string;
  preset: string;
  space: string;
  style: string;
  width: number;
  height: number;
}): Promise<GenerateResponse> => manjuReq("/cad/render", "POST", body);

/** 几何 → 服务端渲轴测/3D 体量图。契约:POST /api/cad/axon { geometry } → { url }。 */
export const cadAxon = (geometry: CadGeometry): Promise<{ url: string }> =>
  manjuReq("/cad/axon", "POST", { geometry });

/**
 * 对口型:源分镜视频 + 配音 → LatentSync 让角色嘴型对上台词。异步 Job(同转视频)。
 * 契约:POST /api/manju/shot/lipsync { video_url, voice_url, lips_expression?, inference_steps? }
 *   → { prompt_id, client_id, worker, seed, mode }。产物为口型同步的视频(回填 videoUrl)。
 */
export const lipsyncManjuShot = (params: {
  video_url: string;
  voice_url: string;
  lips_expression?: number;
  inference_steps?: number;
}): Promise<GenerateResponse> => manjuReq("/manju/shot/lipsync", "POST", params);

export type ManjuTransition = "none" | "crossfade";
export type ManjuAspect = "16:9" | "9:16" | "1:1";

export interface AssembleOptions {
  transition: ManjuTransition;
  bgm_url: string | null;
  subtitles: string[];
  fps: number;
  aspect?: ManjuAspect;
  title?: string;
  credits?: string;
  /** 专业混音(P2):对白音量(0-2)/ BGM 音量(0-1)/ BGM 对白闪避。 */
  voice_volume?: number;
  bgm_volume?: number;
  duck?: boolean;
  /** 调色滤镜(P3):none/cinematic/warm/cool/bw/vivid/vintage。 */
  grade?: string;
  /** 字幕样式(P4):字号/颜色/位置(bottom/top/center)/描边盒。 */
  sub_size?: number;
  sub_color?: string;
  sub_pos?: string;
  sub_box?: boolean;
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
  voiceUrls: string[] = [],
  clipDurations: number[] = [],
): Promise<AssembleResult> {
  const res = await fetch(`${API_BASE}/api/manju/assemble`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ clips, options, voice_urls: voiceUrls, clip_durations: clipDurations }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `合成成片失败 (${res.status})`);
  }
  return res.json();
}

export interface KenBurnsResult {
  url: string;
  name: string;
}

/** 静图 → 带运镜(推拉/平移)的动态片段(免 GPU);产物可作为某镜 videoUrl 拼进成片。 */
export async function kenburnsManju(
  imageSrc: string,
  duration: number,
  motion: string,
  width: number,
  height: number,
): Promise<KenBurnsResult> {
  const res = await fetch(`${API_BASE}/api/manju/kenburns`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ image_url: imageSrc, duration, motion, width, height }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `运镜片段生成失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 视频译制工坊(dub studio)----------

export interface DubUploadResult {
  name: string;
  url: string;
  size: number;
}

/**
 * 上传长视频源 → 流式落盘。契约:POST /api/dub/upload multipart(video)。
 * 用 XHR 以拿到真实上传进度(fetch 无法报上传进度);onProgress 回传 0-100。
 */
export function uploadDubVideo(
  file: File,
  onProgress?: (pct: number) => void,
): Promise<DubUploadResult> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", `${API_BASE}/api/dub/upload`);
    const t = getToken();
    if (t) xhr.setRequestHeader("Authorization", `Bearer ${t}`);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress?.(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(JSON.parse(xhr.responseText));
        } catch {
          reject(new Error("上传响应解析失败"));
        }
      } else {
        let msg = `视频上传失败 (${xhr.status})`;
        try {
          msg = JSON.parse(xhr.responseText)?.detail ?? msg;
        } catch {
          /* 保留默认 */
        }
        reject(new Error(msg));
      }
    };
    xhr.onerror = () => reject(new Error("上传网络错误"));
    const fd = new FormData();
    fd.append("video", file);
    xhr.send(fd);
  });
}

export interface DubSegment {
  index: number;
  start: number;
  end: number;
  duration: number;
}

export interface DubAutoCutResult {
  segments: DubSegment[];
  count: number;
  source_duration: number;
  mode: string;
}

/** 自动剪辑:场景/静音切分得到带时间轴的片段。契约:POST /api/dub/autocut。 */
export async function autocutDub(params: {
  name: string;
  mode: "scene" | "silence";
  threshold: number;
  minSeg: number;
}): Promise<DubAutoCutResult> {
  const res = await fetch(`${API_BASE}/api/dub/autocut`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      mode: params.mode,
      threshold: params.threshold,
      min_seg: params.minSeg,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `自动剪辑失败 (${res.status})`);
  }
  return res.json();
}

export interface LipsyncLongStart {
  job_id: string;
  segment_count: number;
  source_duration: number;
  segments: { index: number; start: number; end: number }[];
}

/**
 * 起真人长视频分段对口型(后台管线)。契约:POST /api/dub/lipsync-long。
 * segments 传 autocut 的片段(可选;空则后端按 segSeconds 等分)。
 */
export async function startLipsyncLong(params: {
  name: string;
  segments?: { start: number; end: number }[];
  segSeconds?: number;
  maxSegments?: number;
  lipsExpression?: number;
  inferenceSteps?: number;
  audioName?: string; // 译制配音轨(dubvoice-*.wav);空则用源视频自带音轨
}): Promise<LipsyncLongStart> {
  const res = await fetch(`${API_BASE}/api/dub/lipsync-long`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      segments: params.segments ?? [],
      seg_seconds: params.segSeconds ?? 12,
      max_segments: params.maxSegments ?? 8,
      lips_expression: params.lipsExpression ?? 1.5,
      inference_steps: params.inferenceSteps ?? 20,
      audio_name: params.audioName ?? null,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `启动对口型失败 (${res.status})`);
  }
  return res.json();
}

export interface LipsyncLongStatus {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  total: number;
  completed: number;
  fallbacks: number;
  gpu_seconds: number;
  url: string | null;
  error: string | null;
  source_duration: number;
  elapsed: number;
}

/** 轮询分段对口型进度(含 gpu_seconds 成本)。契约:GET /api/dub/lipsync-long/{job_id}。 */
export async function getLipsyncLongStatus(jobId: string): Promise<LipsyncLongStatus> {
  const res = await fetch(`${API_BASE}/api/dub/lipsync-long/${jobId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `查询进度失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 动漫对口型(本地自建 CV,非 LatentSync)----------

export interface AnimeLipsyncStatus {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  progress: number;
  frames: number;
  faces_detected: number;
  url: string | null;
  error: string | null;
  elapsed: number;
}

/**
 * 起动漫对口型(本地 CV:动漫脸检测 + 音频能量驱动嘴开合)。契约:POST /api/dub/anime-lipsync。
 * 真人走 startLipsyncLong(LatentSync);动漫走这个(LatentSync 做不了动漫脸)。
 */
export async function startAnimeLipsync(params: {
  name: string;
  audioName?: string; // 译制配音轨;空则用源视频自带音轨
  mouthGain?: number; // 张嘴幅度倍率
  smooth?: number; // 开口度时间平滑窗
}): Promise<{ job_id: string }> {
  const res = await fetch(`${API_BASE}/api/dub/anime-lipsync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      audio_name: params.audioName ?? null,
      mouth_gain: params.mouthGain ?? 1.0,
      smooth: params.smooth ?? 3,
    }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `启动动漫对口型失败 (${res.status})`);
  }
  return res.json();
}

/** 轮询动漫对口型进度。契约:GET /api/dub/anime-lipsync/{job_id}。 */
export async function getAnimeLipsyncStatus(jobId: string): Promise<AnimeLipsyncStatus> {
  const res = await fetch(`${API_BASE}/api/dub/anime-lipsync/${jobId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `查询进度失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 译制台 · 听写翻译配音 ----------

export interface DubTextSegment {
  index: number;
  start: number;
  end: number;
  text: string;
}

/** 导入 SRT/VTT 字幕 → 带时间轴片段。契约:POST /api/dub/import-srt multipart(file)。 */
export async function importSrtDub(file: File): Promise<{ segments: DubTextSegment[]; count: number }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch(`${API_BASE}/api/dub/import-srt`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `字幕导入失败 (${res.status})`);
  }
  return res.json();
}

interface TranscribeStatus {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  count: number;
  segments: DubTextSegment[];
  error: string | null;
  progress: number;
  elapsed: number;
}

/** 后台作业进度回调载荷:阶段文字 + 0-100 进度 + 已用秒(前端据此算 ETA + 画进度条)。 */
export interface JobProgress {
  stage: string;
  progress: number;
  elapsed: number;
}

/**
 * Whisper 听写源视频(后台作业,内部轮询直到完成)。契约:POST /api/dub/transcribe →
 * { job_id };GET /api/dub/transcribe/{job_id} 取进度/片段。内置 faster-whisper(CPU)。
 * onProgress 回传 {stage, progress(0-100), elapsed};长视频可能数分钟。
 */
export async function transcribeDub(
  name: string,
  onProgress?: (p: JobProgress) => void,
): Promise<{ segments: DubTextSegment[]; count: number }> {
  const startRes = await fetch(`${API_BASE}/api/dub/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!startRes.ok) {
    const detail = await startRes.json().catch(() => null);
    throw new Error(detail?.detail ?? `听写启动失败 (${startRes.status})`);
  }
  const { job_id: jobId } = (await startRes.json()) as { job_id: string };

  // 轮询至终态(2s/次,上限 ~12 分钟)
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${API_BASE}/api/dub/transcribe/${jobId}`, { headers: authHeaders() });
    if (!res.ok) continue; // 抖动,下次再试
    const s = (await res.json()) as TranscribeStatus;
    onProgress?.({ stage: s.stage, progress: s.progress, elapsed: s.elapsed });
    if (s.status === "done") return { segments: s.segments, count: s.count };
    if (s.status === "error") throw new Error(s.error ?? "听写失败");
  }
  throw new Error("听写超时");
}

/** 批量翻译到目标语(口语自然、贴近朗读时长)。契约:POST /api/dub/translate。 */
export async function translateDub(
  segments: { index: number; text: string }[],
  targetLang: string,
): Promise<{ translated: { index: number; translated: string }[]; count: number; target_lang: string }> {
  const res = await fetch(`${API_BASE}/api/dub/translate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ segments, target_lang: targetLang }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `翻译失败 (${res.status})`);
  }
  return res.json();
}

/** AI 精剪:LLM 从字幕挑高光句做集锦。契约:POST /api/dub/highlights → {title,selected[],count}。 */
export async function highlightsDub(
  segments: { index: number; text: string }[],
  targetCount = 0,
): Promise<{ title: string; selected: number[]; count: number }> {
  const res = await fetch(`${API_BASE}/api/dub/highlights`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ segments, target_count: targetCount }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `AI 精剪失败 (${res.status})`);
  }
  return res.json();
}

export interface VoiceTrackResult {
  name: string;
  url: string;
  duration: number;
  segment_count: number;
}

interface VoiceTrackStatus {
  id: string;
  status: "running" | "done" | "error";
  stage: string;
  total: number;
  completed: number;
  failed: number;
  progress: number;
  result: VoiceTrackResult | null;
  error: string | null;
  elapsed: number;
}

/**
 * 生成克隆音色配音轨(后台作业,内部轮询)。逐片段 IndexTTS2 合成(从源视频抽参考音
 * 克隆原说话人)→ 铺成整轨。契约:POST /api/dub/voice-track → {job_id};
 * GET /api/dub/voice-track-status/{job} 取进度。返回的 name 可作 startLipsyncLong 的 audioName。
 * onProgress 回传 {stage, progress(0-100), elapsed}。
 */
export async function voiceTrackDub(
  params: {
    name: string;
    segments: { start: number; end: number; text: string }[];
    refSeconds?: number;
    emoText?: string;
  },
  onProgress?: (p: JobProgress) => void,
): Promise<VoiceTrackResult> {
  const startRes = await fetch(`${API_BASE}/api/dub/voice-track`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      segments: params.segments,
      ref_seconds: params.refSeconds ?? 8,
      emo_text: params.emoText ?? null,
    }),
  });
  if (!startRes.ok) {
    const detail = await startRes.json().catch(() => null);
    throw new Error(detail?.detail ?? `配音轨启动失败 (${startRes.status})`);
  }
  const { job_id: jobId } = (await startRes.json()) as { job_id: string };

  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await fetch(`${API_BASE}/api/dub/voice-track-status/${jobId}`, {
      headers: authHeaders(),
    });
    if (!res.ok) continue;
    const s = (await res.json()) as VoiceTrackStatus;
    onProgress?.({ stage: s.stage, progress: s.progress, elapsed: s.elapsed });
    if (s.status === "done" && s.result) return s.result;
    if (s.status === "error") throw new Error(s.error ?? "配音轨生成失败");
  }
  throw new Error("配音轨生成超时");
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
