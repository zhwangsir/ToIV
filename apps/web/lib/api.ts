import { CACHE_KEYS, TTL, invalidate, swr } from "./swr-cache";
import type {
  AdminUser,
  GenerateResponse,
  Img2ImgGenParams,
  JobItem,
  LocalModels,
  LtxI2VParams,
  LtxLipsyncParams,
  LtxT2VParams,
  MarketItem,
  ModelsResponse,
  NsfwRecommendation,
  StylePreset,
  TrainProgress,
  TrainStartParams,
  TrainJob,
  Txt2ImgParams,
  Usage,
} from "./types";

/**
 * API 基址。
 * - 浏览器端优先使用相对路径 ""，让请求走当前 origin，再由 Next.js rewrite / 反代到后端，
 *   避免构建产物把 localhost:8090 写死导致线上 CORS/ host 不可达。
 * - SSR/非浏览器环境回退到 NEXT_PUBLIC_API_BASE 或 localhost:8090。
 * - 浏览器端固定用相对路径,绝不读 NEXT_PUBLIC_API_BASE:该变量在构建期被内联,
 *   若构建机上带着 localhost:8090 之类的值,会把不可达地址烧进产物(2026-07-30 实测踩坑)。
 */
export const API_BASE =
  typeof window === "undefined"
    ? (process.env.NEXT_PUBLIC_API_BASE ?? "http://localhost:8090")
    : "";
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

export function authHeaders(): Record<string, string> {
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

// ---------- 统一请求封装 ----------
/** 默认超时:常规 JSON/轮询请求。 */
const DEFAULT_TIMEOUT_MS = 30_000;
/** 长任务端点统一超时(VLM 解析 / LLM 长文同步生成 / ffmpeg 合成这类 1-3 分钟请求)。 */
const LONG_TIMEOUT_MS = 180_000;

interface ApiFetchOptions {
  /** 显式超时(毫秒),覆盖默认与 longRequest;传 0 表示不超时(仅流式端点用,由调用方 signal 控制)。 */
  timeoutMs?: number;
  /** 长任务端点 → 180s。 */
  longRequest?: boolean;
  /** 跳过 401 自动跳转(仅登录/会话探测接口:401 是正常业务结果,由调用方处理)。 */
  skipAuthRedirect?: boolean;
}

/** 幂等标记:同次页面生命周期内,多个并发 401 只触发一次清理 + 跳转。 */
let authRedirectPending = false;

/**
 * 401 统一处理:清除本地 token(复用 setToken 清理路径)并跳转登录入口
 * (登录态在 "/",app/login 只是 redirect("/"))。仅浏览器环境执行,且幂等。
 */
function handleUnauthorized(): void {
  if (typeof window === "undefined") return;
  if (authRedirectPending) return;
  authRedirectPending = true;
  setToken(null);
  window.location.assign("/");
}

/**
 * apiFetch:全站统一 fetch 入口。
 * - 默认 30s 超时(AbortController + setTimeout),超时抛「请求超时」Error;
 *   调用方 init.signal 与内部超时 signal 联动,任一触发都会取消请求。
 * - 401 统一清 token + 跳 "/"(opts.skipAuthRedirect 除外)。
 * - 不做 res.ok 检查与错误归一:由各调用点配合 raiseApiError 保留各自中文文案。
 */
export async function apiFetch(
  path: string,
  init?: RequestInit,
  opts?: ApiFetchOptions,
): Promise<Response> {
  const timeoutMs =
    opts?.timeoutMs ?? (opts?.longRequest ? LONG_TIMEOUT_MS : DEFAULT_TIMEOUT_MS);
  const controller = new AbortController();
  const callerSignal = init?.signal ?? undefined;
  let timedOut = false;
  const onCallerAbort = (): void => controller.abort();
  if (callerSignal) {
    if (callerSignal.aborted) controller.abort();
    else callerSignal.addEventListener("abort", onCallerAbort, { once: true });
  }
  const timer =
    timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          controller.abort();
        }, timeoutMs)
      : null;
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, { ...init, signal: controller.signal });
  } catch (err) {
    if (timedOut) {
      throw new Error(`请求超时 (${Math.round(timeoutMs / 1000)}s),请稍后重试`);
    }
    throw err;
  } finally {
    if (timer) clearTimeout(timer);
    if (callerSignal) callerSignal.removeEventListener("abort", onCallerAbort);
  }
  if (res.status === 401 && !opts?.skipAuthRedirect) handleUnauthorized();
  return res;
}

/** 统一错误归一:优先后端 detail,否则「中文兜底 (status)」,与历史 message 风格一致。 */
async function raiseApiError(res: Response, fallback: string): Promise<never> {
  const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  throw new Error(
    typeof detail?.detail === "string" ? detail.detail : `${fallback} (${res.status})`,
  );
}

/** 后端图片路径是相对的，拼成可访问 URL 并附带令牌（<img> 无法带请求头）。
 * 兼容：绝对 http(s) URL、以 / 开头的相对路径、缺少 / 的相对路径、空路径。
 */
export function imageUrl(path: string): string {
  if (!path) return "";
  if (path.startsWith("http")) return withToken(path);
  const normalized = path.startsWith("/") ? path : `/${path}`;
  return withToken(`${API_BASE}${normalized}`);
}

// ---------- 鉴权 ----------
async function postAuth(path: string, body: object): Promise<AuthResult> {
  // skipAuthRedirect:登录接口 401 是凭证错误(正常业务结果),由登录页展示,不触发全局跳转。
  const res = await apiFetch(
    `${path}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
    { skipAuthRedirect: true },
  );
  if (!res.ok) await raiseApiError(res, "请求失败");
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
  // skipAuthRedirect:会话探测接口,401 → 「会话已过期」由调用方(首页登录态)处理,不全局跳转。
  const res = await apiFetch(
    `/api/auth/me`,
    { headers: authHeaders() },
    { skipAuthRedirect: true },
  );
  if (!res.ok) throw new Error("会话已过期");
  return res.json();
}

/**
 * 当前账户(含用量)。契约:GET /api/auth/me。
 * 注:R18 放行仅由 /nsfw 专页的 X-NSFW 请求头控制(后端 ContextVar),不再有账户级开关。
 */
export interface MeResponse {
  user: AppUser;
  usage: Usage;
}

async function fetchMeRaw(): Promise<MeResponse> {
  // skipAuthRedirect:同 fetchMe,401 → 「会话已过期」语义不变。
  const res = await apiFetch(
    `/api/auth/me`,
    { headers: authHeaders() },
    { skipAuthRedirect: true },
  );
  if (!res.ok) throw new Error("会话已过期");
  const data = (await res.json()) as Partial<MeResponse> & { user: AppUser; usage: Usage };
  return { user: data.user, usage: data.usage };
}

/** 账户(含用量),走本机 SWR 缓存:二访秒开,后台静默刷新。 */
export function getMe(): Promise<MeResponse> {
  return swr(CACHE_KEYS.me, fetchMeRaw, TTL.me);
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await apiFetch(`/api/admin/users`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载用户失败 (${res.status})`);
  return res.json();
}

export async function createUser(
  email: string,
  password: string,
  role: string,
): Promise<AdminUser> {
  const res = await apiFetch(`/api/admin/users`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ email, password, role }),
  });
  if (!res.ok) await raiseApiError(res, "创建账号失败");
  return res.json();
}

export async function deleteUser(id: string): Promise<void> {
  const res = await apiFetch(`/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除失败");
}

// ---------- 生成 ----------
async function fetchModelsRaw(): Promise<ModelsResponse> {
  const res = await apiFetch(`/api/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载模型列表失败 (${res.status})`);
  return res.json();
}

/** 模型列表,走本机 SWR 缓存(几乎不变,长 TTL):二访秒开,减重复请求。
 *  /nsfw 用独立缓存键 + X-NSFW 标记,避免 R18 模型污染主页缓存。 */
export function listModels(): Promise<ModelsResponse> {
  return swr(_nsfwIntent ? `${CACHE_KEYS.models}:nsfw` : CACHE_KEYS.models, fetchModelsRaw, TTL.models);
}

/** 风格预设列表,走长 TTL 缓存(预设由后端代码决定,重启才变)。 */
async function fetchPresetsRaw(): Promise<StylePreset[]> {
  const res = await apiFetch(`/api/models/presets?media=image`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载风格预设失败 (${res.status})`);
  const data = await res.json();
  return (data.presets ?? []) as StylePreset[];
}
export function listStylePresets(): Promise<StylePreset[]> {
  return swr("style-presets:image", fetchPresetsRaw, TTL.models);
}

// ---------- Forge 第二出图引擎 ----------

export interface ForgeStatus {
  enabled: boolean;
  online: boolean;
}

/** Forge(reForge)在线状态;前端据此显示「引擎切换」。失败优雅回落未部署。 */
export async function getForgeStatus(): Promise<ForgeStatus> {
  try {
    const res = await apiFetch(`/api/forge/status`, { headers: authHeaders() });
    if (!res.ok) return { enabled: false, online: false };
    return (await res.json()) as ForgeStatus;
  } catch {
    return { enabled: false, online: false };
  }
}

/** Forge 可用 SD 底模标题列表(后端已过滤非 SD 权重);失败返回空。 */
export async function getForgeModels(): Promise<string[]> {
  try {
    const res = await apiFetch(`/api/forge/models`, { headers: authHeaders() });
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
  const res = await apiFetch(`/api/generate/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "生成请求失败");
  return res.json();
}

async function fetchJobsRaw(): Promise<JobItem[]> {
  const res = await apiFetch(`/api/jobs`, { headers: authHeaders() });
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
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobKey)}/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(opts),
  });
  if (!res.ok) await raiseApiError(res, "重新生成失败");
  return res.json();
}

/** 同根版本链(时间升序);寻址接受 job id 或 prompt_id。 */
export async function jobVersions(jobKey: string): Promise<JobItem[]> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobKey)}/versions`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "加载版本历史失败");
  return res.json();
}

/** 从作品库删除一件作品(按 job id);成功后失效缓存。 */
export async function deleteJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除失败");
  invalidateJobs();
}

async function fetchLocalModelsRaw(): Promise<LocalModels> {
  const res = await apiFetch(`/api/models/local`, { headers: authHeaders() });
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
  const res = await apiFetch(`/api/marketplace/search?${qs.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "搜索失败");
  return res.json();
}

/**
 * NSFW 模型推荐清单(静态,后端 civitai 调研写死)。契约:GET /api/models/nsfw-recommendations。
 * 供 /nsfw 专区「NSFW 推荐」tab 展示;需登录认证。失败抛错(调用方 catch 后显示空态)。
 */
export async function getNsfwRecommendations(): Promise<NsfwRecommendation[]> {
  const res = await apiFetch(`/api/models/nsfw-recommendations`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "加载 NSFW 推荐失败");
  const data = (await res.json()) as { items: NsfwRecommendation[]; count: number };
  return data.items;
}

export async function uploadImage(
  file: File,
  kind: string = "img2img",
  allWorkers = false, // true=分发到所有 worker(角色参考图,供带参考图的分镜跨机并行出图)
  worker?: string, // 指定目标 worker,确保音频/参考图与后续生成同机
): Promise<{ filename: string; worker: string; workers?: string[]; all_workers?: boolean }> {
  const fd = new FormData();
  fd.append("image", file);
  let qs = `kind=${encodeURIComponent(kind)}${allWorkers ? "&all_workers=true" : ""}`;
  if (worker) qs += `&worker=${encodeURIComponent(worker)}`;
  const res = await apiFetch(`/api/upload?${qs}`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type，让浏览器带 boundary
    body: fd,
  });
  if (!res.ok) await raiseApiError(res, "上传失败");
  return res.json();
}

export async function generateImg2img(
  params: Img2ImgGenParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/img2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "生成请求失败");
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
  const res = await apiFetch(`/api/generate/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "视频生成请求失败");
  return res.json();
}

// ── LTX2.3 视频生成(NSFW 专区)──
export async function generateLtxT2V(
  params: LtxT2VParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/ltx-t2v`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LTX 文生视频请求失败");
  return res.json();
}

export async function generateLtxI2V(
  params: LtxI2VParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/ltx-i2v`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LTX 图生视频请求失败");
  return res.json();
}

export async function generateLtxLipsync(
  params: LtxLipsyncParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/ltx-lipsync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LTX 口型同步请求失败");
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
  const res = await apiFetch(`/api/generate/txt2video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "文生视频请求失败");
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
  const res = await apiFetch(`/api/generate/controlnet`, {
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
  if (!res.ok) await raiseApiError(res, "ControlNet 生成请求失败");
  return res.json();
}

export interface UpscaleGenParams {
  image: string; // 已上传的源图文件名
  worker: string; // 源图所在 worker
  modelName?: string;
  scale?: number; // 目标倍数(1.5-4)
}

export async function generateUpscale(params: UpscaleGenParams): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      ...(params.modelName ? { model_name: params.modelName } : {}),
      ...(params.scale != null ? { scale: params.scale } : {}),
    }),
  });
  if (!res.ok) await raiseApiError(res, "放大请求失败");
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
  const res = await apiFetch(`/api/generate/facedetailer`, {
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
  if (!res.ok) await raiseApiError(res, "脸部修复请求失败");
  return res.json();
}

export interface RemoveBgParams {
  image: string; // 已上传的源图文件名
  worker: string;
  mode?: string; // general | anime | human
}

export async function generateRemoveBg(params: RemoveBgParams): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/removebg`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      ...(params.mode ? { mode: params.mode } : {}),
    }),
  });
  if (!res.ok) await raiseApiError(res, "抠图请求失败");
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
  const res = await apiFetch(`/api/generate/inpaint`, {
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
  if (!res.ok) await raiseApiError(res, "局部重绘请求失败");
  return res.json();
}

export interface RawWorkflowParams {
  graph: Record<string, unknown>; // ComfyUI API-format prompt 图
  worker?: string;
}

export async function generateRaw(params: RawWorkflowParams): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/raw`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      graph: params.graph,
      ...(params.worker ? { worker: params.worker } : {}),
    }),
  });
  if (!res.ok) await raiseApiError(res, "工作流运行请求失败");
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
  const res = await apiFetch(`/api/marketplace/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "模型安装请求失败");
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
  const res = await apiFetch(`/api/nas/status`, { headers: authHeaders() });
  if (!res.ok) return { enabled: false };
  return res.json();
}

/** 起模型下载→NAS(admin)。civitai/huggingface 传 source+id;直链传 source=url+url。 */
export async function nasDownload(params: {
  source: string; // url | hf | civitai | huggingface
  id?: string;
  name?: string; // civitai: 显示名(404 时按名搜索回退)
  url?: string;
  hf_repo?: string;
  hf_file?: string;
  type: string;
  filename?: string;
}): Promise<{ job_id: string; filename: string }> {
  const res = await apiFetch(`/api/nas/download`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "下载请求失败");
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
  const res = await apiFetch(`/api/nas/download/${jobId}`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "查询进度失败");
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
  const res = await apiFetch(`/api/manju/shot`, {
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
  if (!res.ok) await raiseApiError(res, "漫剧出图请求失败");
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
  const res = await apiFetch(`/api/generate/3d`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "3D 生成请求失败");
  return res.json();
}

export interface AudioGenParams {
  tags: string;
  lyrics: string;
  seconds: number;
  seed?: number | null;
}

export async function generateAudio(params: AudioGenParams): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/audio`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "音频生成请求失败");
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
  const res = await apiFetch(`/api/agent/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(image ? { messages, image } : { messages }),
    signal,
    // SSE 流式响应:不设超时(timeoutMs: 0),取消由调用方 signal 控制。
  }, { timeoutMs: 0 });
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
  // LLM 提示词润色,偶发超过 30s → 放宽到 60s。
  const res = await apiFetch(
    `/api/optimize`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ prompt, kind, ...(model ? { model } : {}) }),
    },
    { timeoutMs: 60_000 },
  );
  if (!res.ok) await raiseApiError(res, "优化失败");
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
  // LLM 剧本→分镜拆解(整段剧本一次生成)→ 放宽到 120s。
  const res = await apiFetch(
    `/api/manju/storyboard`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(params),
    },
    { timeoutMs: 120_000 },
  );
  if (!res.ok) await raiseApiError(res, "分镜生成失败");
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
  // 当回写单个已持久化镜头的某个字段(如 voice_url/video_url)时,
  // 必须携带 shot_id 让后端定位目标镜头;新建镜头时省略。
  shot_id?: string;
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
async function manjuReq<T>(
  path: string,
  method: string,
  body?: unknown,
  opts?: ApiFetchOptions,
): Promise<T> {
  const res = await apiFetch(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    opts,
  );
  if (!res.ok) await raiseApiError(res, "漫剧项目请求失败");
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
  // 关联到具体镜头(可选);后端可据此把资产挂回原 shot。
  shot_id?: string;
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
  const res = await apiFetch(`/api/manju/voice-ref`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type，让浏览器带 boundary
    body: fd,
  });
  if (!res.ok) await raiseApiError(res, "音色上传失败");
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
  const res = await apiFetch(`/api/cad/upload`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) await raiseApiError(res, "图纸转换失败");
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
  // ffmpeg 多片段合成(转场/字幕/混音),长片可能超 1 分钟 → 放宽到 180s。
  const res = await apiFetch(
    `/api/manju/assemble`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ clips, options, voice_urls: voiceUrls, clip_durations: clipDurations }),
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "合成成片失败");
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
  // ffmpeg 渲染运镜片段(时长越长越慢)→ 放宽到 120s。
  const res = await apiFetch(
    `/api/manju/kenburns`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ image_url: imageSrc, duration, motion, width, height }),
    },
    { timeoutMs: 120_000 },
  );
  if (!res.ok) await raiseApiError(res, "运镜片段生成失败");
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
    xhr.timeout = 600_000; // 长视频上传:10 分钟超时(原为无限挂起)
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
    xhr.ontimeout = () => reject(new Error("上传请求超时"));
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
  // ffmpeg 场景/静音检测,长视频全片扫描 → 放宽到 180s。
  const res = await apiFetch(
    `/api/dub/autocut`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({
        name: params.name,
        mode: params.mode,
        threshold: params.threshold,
        min_seg: params.minSeg,
      }),
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "自动剪辑失败");
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
  const res = await apiFetch(`/api/dub/lipsync-long`, {
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
  if (!res.ok) await raiseApiError(res, "启动对口型失败");
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
  const res = await apiFetch(`/api/dub/lipsync-long/${jobId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "查询进度失败");
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
  const res = await apiFetch(`/api/dub/anime-lipsync`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      audio_name: params.audioName ?? null,
      mouth_gain: params.mouthGain ?? 1.0,
      smooth: params.smooth ?? 3,
    }),
  });
  if (!res.ok) await raiseApiError(res, "启动动漫对口型失败");
  return res.json();
}

/** 轮询动漫对口型进度。契约:GET /api/dub/anime-lipsync/{job_id}。 */
export async function getAnimeLipsyncStatus(jobId: string): Promise<AnimeLipsyncStatus> {
  const res = await apiFetch(`/api/dub/anime-lipsync/${jobId}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "查询进度失败");
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
  const res = await apiFetch(`/api/dub/import-srt`, {
    method: "POST",
    headers: authHeaders(),
    body: fd,
  });
  if (!res.ok) await raiseApiError(res, "字幕导入失败");
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
  const startRes = await apiFetch(`/api/dub/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
  });
  if (!startRes.ok) await raiseApiError(startRes, "听写启动失败");
  const { job_id: jobId } = (await startRes.json()) as { job_id: string };

  // 轮询至终态(2s/次,上限 ~12 分钟)
  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await apiFetch(`/api/dub/transcribe/${jobId}`, { headers: authHeaders() });
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
  // LLM 批量翻译整段字幕(段数多耗时长)→ 放宽到 180s。
  const res = await apiFetch(
    `/api/dub/translate`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ segments, target_lang: targetLang }),
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "翻译失败");
  return res.json();
}

/** AI 精剪:LLM 从字幕挑高光句做集锦。契约:POST /api/dub/highlights → {title,selected[],count}。 */
export async function highlightsDub(
  segments: { index: number; text: string }[],
  targetCount = 0,
): Promise<{ title: string; selected: number[]; count: number }> {
  // LLM 读全部字幕挑高光句 → 放宽到 120s。
  const res = await apiFetch(
    `/api/dub/highlights`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ segments, target_count: targetCount }),
    },
    { timeoutMs: 120_000 },
  );
  if (!res.ok) await raiseApiError(res, "AI 精剪失败");
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
  const startRes = await apiFetch(`/api/dub/voice-track`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      name: params.name,
      segments: params.segments,
      ref_seconds: params.refSeconds ?? 8,
      emo_text: params.emoText ?? null,
    }),
  });
  if (!startRes.ok) await raiseApiError(startRes, "配音轨启动失败");
  const { job_id: jobId } = (await startRes.json()) as { job_id: string };

  for (let i = 0; i < 360; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    const res = await apiFetch(`/api/dub/voice-track-status/${jobId}`, {
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

export interface LlmModelInfo {
  model: string;
  display_model?: string;
  fallback_model: string | null;
  nsfw_model: string | null;
  l2_model: string | null;
  l3_model: string | null;
}

/** 当前默认 LLM 大脑名称;失败返回 null → 前端隐藏 badge。 */
export async function getLlmModel(signal?: AbortSignal): Promise<LlmModelInfo | null> {
  try {
    const res = await apiFetch(`/api/system/llm`, {
      headers: authHeaders(),
      signal,
    });
    if (!res.ok) return null;
    return (await res.json()) as LlmModelInfo;
  } catch {
    return null;
  }
}

/** 拉取 4 卡实时遥测(显存负载/队列);失败返回 null → 前端回落 MOCK。 */
export async function getGpuStats(signal?: AbortSignal): Promise<LiveTelemetry | null> {
  try {
    const res = await apiFetch(`/api/system/gpu`, { signal });
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

// ===========================================================================
// LoRA 训练(D 期)—— 上传数据集 → Florence2 打标 → AI-Toolkit 训练 → 注册
// ===========================================================================

export async function uploadDataset(
  files: File[],
): Promise<{ job_id: string; count: number; dataset_dir: string }> {
  const form = new FormData();
  for (const f of files) form.append("files", f);
  // 数据集多文件批量上传 → 放宽到 120s。
  const res = await apiFetch(
    `/api/train/dataset`,
    {
      method: "POST",
      headers: authHeaders(), // multipart 不设 Content-Type,让浏览器带 boundary
      body: form,
    },
    { timeoutMs: 120_000 },
  );
  if (!res.ok) await raiseApiError(res, "上传失败");
  return res.json();
}

export async function captionDataset(
  job_id: string,
  cuda_device = 0,
): Promise<{ job_id: string; count: number; captions: { filename: string; caption: string }[] }> {
  // Florence2 逐张打标整个数据集(同步返回,几十张图可达数分钟)→ 放宽到 300s。
  const res = await apiFetch(
    `/api/train/caption`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ job_id, cuda_device }),
    },
    { timeoutMs: 300_000 },
  );
  if (!res.ok) await raiseApiError(res, "打标失败");
  return res.json();
}

export async function startTraining(
  params: TrainStartParams,
): Promise<{ job_id: string; trainer_job_id: string; worker: string }> {
  const res = await apiFetch(`/api/train/start`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "启动训练失败");
  return res.json();
}

/** SSE 追踪训练进度。resolve 时训练完成(lora_path 在 TrainJob 里),reject 时失败。 */
export function trackTrainJob(
  jobId: string,
  opts: { onProgress?: (p: TrainProgress) => void; register?: (es: EventSource | null) => void },
): Promise<void> {
  const token = getToken();
  const url = `${API_BASE}/api/train/${jobId}/events${token ? `?token=${token}` : ""}`;
  const es = new EventSource(url);
  opts.register?.(es);
  let done = false;

  return new Promise<void>((resolve, reject) => {
    es.addEventListener("message", (e) => {
      try {
        const data = JSON.parse(e.data);
        const evt = data.event ?? "progress";
        if (evt === "progress") {
          opts.onProgress?.({
            step: data.step ?? 0,
            total: data.total ?? 0,
            loss: data.loss ?? 0,
            recent_losses: data.recent_losses ?? [],
          });
        } else if (evt === "done") {
          done = true;
          es.close();
          opts.register?.(null);
          resolve();
        } else if (evt === "error") {
          done = true;
          es.close();
          opts.register?.(null);
          reject(new Error(data.message ?? "训练失败"));
        }
      } catch {
        // 忽略解析错误
      }
    });
    es.onerror = () => {
      if (!done) {
        es.close();
        opts.register?.(null);
        reject(new Error("训练连接中断"));
      }
    };
  });
}

export async function registerLora(jobId: string): Promise<{
  ok: boolean;
  lora_name: string;
  trigger_words: string;
  base_ckpt: string;
  family: string;
}> {
  const res = await apiFetch(`/api/train/${jobId}/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
  });
  if (!res.ok) await raiseApiError(res, "注册失败");
  return res.json();
}

export async function listTrainJobs(): Promise<TrainJob[]> {
  return swr(CACHE_KEYS.trainJobs ?? "train-jobs", async () => {
    const res = await apiFetch(`/api/train/jobs`, { headers: authHeaders() });
    if (!res.ok) throw new Error("获取训练作业列表失败");
    return res.json();
  }, TTL.trainJobs);
}

// ---------- Backlot 看板(OpenMontage 风格项目仪表盘) ----------

export type BacklotStage = "drafting" | "imaging" | "filming" | "voicing" | "done";

export interface BacklotProgress {
  total: number;
  image_done: number;
  video_done: number;
  voiced: number;
}

export interface BacklotCard {
  id: string;
  title: string;
  premise: string;
  style: string;
  ckpt: string;
  stage: BacklotStage;
  progress: BacklotProgress;
  thumbnail: string;
  shot_count: number;
  updated_at: string;
  created_at: string;
}

export interface BacklotShot {
  id: string;
  idx: number;
  scene: string;
  camera: string;
  dialogue: string;
  status: string;
  image_url: string;
  video_url: string;
  voice_url: string;
  speaker: string;
  duration_sec: number;
}

export interface BacklotDetail {
  project: {
    id: string;
    title: string;
    premise: string;
    style: string;
    ckpt: string;
    created_at: string;
    updated_at: string;
  };
  stage: BacklotStage;
  progress: BacklotProgress;
  shots: BacklotShot[];
}

/** 看板视图:当前用户所有项目卡片。 */
export async function listBacklot(): Promise<BacklotCard[]> {
  const res = await apiFetch(`/api/backlot`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载看板失败 (${res.status})`);
  return res.json();
}

/** 项目看板详情:基础信息 + 所有 shot + 阶段/进度。signal 用于取消请求。 */
export async function fetchBacklotDetail(
  projectId: string,
  signal?: AbortSignal,
): Promise<BacklotDetail> {
  const res = await apiFetch(`/api/backlot/${encodeURIComponent(projectId)}`, {
    headers: authHeaders(),
    ...(signal ? { signal } : {}),
  });
  if (!res.ok) throw new Error(`加载项目详情失败 (${res.status})`);
  return res.json();
}

// ---------- AI 短剧工作室:剧本→分镜→视频→配音→成片 一站式 MVP ----------
export interface DramaProjectSummary {
  id: string;
  title: string;
  premise: string;
  style: string;
  script: string;
  status: string;            // draft / storyboard / ready
  video_url: string;         // 成片 URL(已合成)
  duration_sec: number;
  width: number;
  height: number;
  fps: number;
  created_at: string;
  updated_at: string;
}

export interface DramaCharacterItem {
  id: string;
  project_id: string;
  // M2:关联跨项目资产库(空=独立角色)
  asset_id: string;
  name: string;
  description: string;
  visual_prompt: string;     // 视觉 token(注入分镜 prompt 保一致性)
  ref_image: string;
  ref_audio: string;         // 角色定妆音色(配音克隆用)
  voice_name: string;
  // M1:角色三视图(后端 generate-reference 回写,缺省为空)
  reference_front: string;
  reference_side: string;
  reference_back: string;
}

export interface DramaShotCandidate {
  id: string;
  shot_id: string;
  project_id: string;
  url: string;
  seed: number;
  video_model: string;
  status: string;            // pending / generating / done / error
  is_picked: boolean;
  error: string;
  created_at: string;
}

export interface DramaShotItem {
  id: string;
  project_id: string;
  idx: number;
  scene: string;
  prompt: string;            // 英文视频提示词
  negative: string;
  characters: string[];
  dialogue: string;          // 中文台词
  speaker: string;           // 说话角色 / narrator / 空
  duration_sec: number;
  start_sec: number;
  keyframe_url?: string;     // 关键帧缩略图
  video_status: string;      // draft / generating / done / error
  video_url: string;
  voice_status: string;      // draft / generating / done / error
  voice_url: string;
  // M3:对口型
  lipsync_status?: string;   // draft / generating / done / error
  lipsync_video_url?: string;
  seed: number;
  error: string;
  updated_at: string;
  // M2:宫格分镜回写(场景布局 / 视频模型)
  scene_layout: string;
  video_model: string;
  // M1:单镜多候选生成
  candidates?: DramaShotCandidate[];
}

// M4:创作过程单步记录(后端 process_data 数组元素)
export interface DramaProcessStep {
  step: string;       // storyboard / generate_video / assemble / generate_reference / grid_storyboard / autorun ...
  ts: string;         // ISO 时间戳
  detail?: string;
  // ── 任务型步骤(autorun / 批量精修)附加字段,普通步骤无 ──
  task_id?: string;
  status?: string;    // pending / running / assembling / done / error
  total?: number;
  done?: number;
  current?: string;   // 当前进行中的子任务描述(如「分镜 #2 视频生成中」)
  error?: string;
}

export interface DramaProjectDetail extends DramaProjectSummary {
  characters: DramaCharacterItem[];
  shots: DramaShotItem[];
  // M2/M4:最新宫格图 + 创作过程回放记录(后端已返回)
  grid_image: string;
  process_data: DramaProcessStep[];
  // 后端建议的轮询间隔(秒);未返回时前端按默认 5s 轮询
  poll_interval_sec?: number;
}

export interface DramaProjectInput {
  title: string;
  premise?: string;
  style?: string;
  script?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface DramaProjectPatch {
  title?: string;
  premise?: string;
  style?: string;
  script?: string;
  status?: string;
  width?: number;
  height?: number;
  fps?: number;
}

export interface DramaCharacterInput {
  name: string;
  description?: string;
  visual_prompt?: string;
  ref_image?: string;
  ref_audio?: string;
  voice_name?: string;
}

export interface DramaCharacterPatch {
  name?: string;
  description?: string;
  visual_prompt?: string;
  ref_image?: string;
  ref_audio?: string;
  voice_name?: string;
}

// ---------- M2:跨项目角色/场景/道具/风格资产库 ----------
export type DramaAssetKind = "character" | "scene" | "prop" | "style";

export interface DramaAsset {
  id: string;
  kind: DramaAssetKind;
  name: string;
  description: string;
  visual_prompt: string;
  ref_image: string;
  ref_audio: string;
  voice_name: string;
  // 角色三视图
  reference_front: string;
  reference_side: string;
  reference_back: string;
  tags: string[];
  created_at: string;
  updated_at: string;
}

export interface DramaAssetInput {
  kind: DramaAssetKind;
  name: string;
  description?: string;
  visual_prompt?: string;
  ref_image?: string;
  ref_audio?: string;
  voice_name?: string;
  reference_front?: string;
  reference_side?: string;
  reference_back?: string;
  tags?: string[];
}

export interface DramaAssetPatch {
  kind?: DramaAssetKind;
  name?: string;
  description?: string;
  visual_prompt?: string;
  ref_image?: string;
  ref_audio?: string;
  voice_name?: string;
  reference_front?: string;
  reference_side?: string;
  reference_back?: string;
  tags?: string[];
}

export interface DramaAssetListResponse {
  assets: DramaAsset[];
}

export interface DramaAssetApplyResponse extends DramaCharacterItem {}

export interface DramaStoryboardRequest {
  num_shots?: number;
  style?: string;
  script?: string;
}

export interface DramaShotPatch {
  scene?: string;
  prompt?: string;
  negative?: string;
  characters?: string[];
  dialogue?: string;
  speaker?: string;
  duration_sec?: number;
  seed?: number;
}

export interface DramaGenerateVideoRequest {
  worker?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  use_upscale?: boolean;
  use_rife?: boolean;
  prompt_override?: string;
}

export interface DramaGenerateVoiceRequest {
  text_override?: string;
  ref_audio_url?: string;
}

// M3:单分镜对口型请求
export interface DramaLipsyncRequest {
  lips_expression?: number;
  inference_steps?: number;
}

export interface DramaAssembleOptions {
  transition?: string;
  bgm_url?: string | null;
  title?: string;
  credits?: string;
  aspect?: string;
  fps?: number;
  grade?: string;
  sub_size?: number;
  sub_color?: string;
  sub_pos?: string;
  sub_box?: boolean;
  voice_volume?: number;
  bgm_volume?: number;
  duck?: boolean;
  // M3:显式指定合成片段,优先使用 lipsync_video_url;空则后端按 shot.video_url 兜底
  clips?: string[];
}

export interface DramaGenerateVideoResult {
  prompt_id: string;
  client_id: string;
  worker: string;
  seed: number;
  shot_id: string;
}

export interface DramaVoiceResult {
  url: string;
  name: string;
  duration_sec: number;
  shot_id: string;
}

export interface DramaAssembleResult {
  url: string;
  name: string;
  duration_sec: number;
}

/** 短剧工作室统一 JSON 请求(带 auth + 错误归一)。 */
async function dramaReq<T>(
  path: string,
  method: string,
  body?: unknown,
  opts?: ApiFetchOptions,
): Promise<T> {
  const res = await apiFetch(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    },
    opts,
  );
  if (!res.ok) await raiseApiError(res, "短剧项目请求失败");
  return res.json();
}

export const listDramaProjects = (): Promise<DramaProjectSummary[]> =>
  dramaReq("/drama/projects", "GET");
export const createDramaProject = (body: DramaProjectInput): Promise<DramaProjectSummary> =>
  dramaReq("/drama/projects", "POST", body);
export const getDramaProject = (pid: string): Promise<DramaProjectDetail> =>
  dramaReq(`/drama/projects/${pid}`, "GET");
export const patchDramaProject = (
  pid: string,
  body: DramaProjectPatch,
): Promise<DramaProjectSummary> => dramaReq(`/drama/projects/${pid}`, "PATCH", body);
export const deleteDramaProject = (pid: string): Promise<{ ok: boolean }> =>
  dramaReq(`/drama/projects/${pid}`, "DELETE");

/** 剧本 → 分镜 LLM 拆解,落库并返回分镜列表(会清掉旧分镜)。 */
export const storyboardDrama = (
  pid: string,
  body: DramaStoryboardRequest,
): Promise<{ shots: DramaShotItem[] }> =>
  // LLM 剧本→分镜拆解(整段剧本一次生成)→ 放宽到 120s。
  dramaReq(`/drama/projects/${pid}/storyboard`, "POST", body, { timeoutMs: 120_000 });

/**
 * L2 主力润色:把剧本送到 L2 模型做关键场景润色。
 * 契约:POST /api/drama/projects/{pid}/refine body { text, instruction? }
 *   → { layer, model, original, refined }。
 */
export const refineDramaScript = (
  pid: string,
  text: string,
  instruction?: string,
): Promise<{ layer: string; model: string; original: string; refined: string }> =>
  // L2 润色同步返回(长剧本 LLM 生成)→ 放宽到 120s。
  dramaReq(
    `/drama/projects/${pid}/refine`,
    "POST",
    {
      text,
      ...(instruction ? { instruction } : {}),
    },
    { timeoutMs: 120_000 },
  );

/**
 * L3 终稿精修:把剧本送到 L3 模型做异步批量精修(耗时较长,2-5 分钟)。
 * 契约:POST /api/drama/projects/{pid}/polish body { text, instruction? }
 *   → { layer, model, original, polished }。
 */
export const polishDramaScript = (
  pid: string,
  text: string,
  instruction?: string,
): Promise<{ layer: string; model: string; original: string; polished: string }> =>
  // L3 终稿精修同步返回,文档注明耗时 2-5 分钟 → 放宽到 300s。
  dramaReq(
    `/drama/projects/${pid}/polish`,
    "POST",
    {
      text,
      ...(instruction ? { instruction } : {}),
    },
    { timeoutMs: 300_000 },
  );

/** L3 批量精修任务结果条目。 */
export interface DramaPolishResult {
  shot_id: string | null;
  original: string;
  polished: string;
  status: "done" | "error";
  error: string;
}

/** L3 批量精修任务状态(单个)。 */
export interface DramaPolishTask {
  task_id: string;
  status: "pending" | "running" | "done";
  source: string;
  total: number;
  done: number;
  results: DramaPolishResult[];
  started_at?: string;
  updated_at?: string;
  model: string;
}

/** L3 批量精修任务列表项(精简版)。 */
export interface DramaPolishTaskListItem {
  task_id: string;
  status: string;
  source: string;
  total: number;
  done: number;
  ts?: string;
}

/**
 * L3 异步批量精修:并发处理多个分镜/文本,立即返回 task_id。
 * 契约:POST /api/drama/projects/{pid}/polish/batch
 *   body { shot_ids?: string[], texts?: string[], instruction?, temperature?, concurrency? }
 *   → { task_id, total, status: "pending", poll_url, poll_interval_sec, note }。
 *
 * GLM-5.2-fp8 单镜 ~115s,4 并发下 N 镜约 N*115/4 秒。
 */
export const polishDramaBatch = (
  pid: string,
  body: {
    shot_ids?: string[];
    texts?: string[];
    instruction?: string;
    temperature?: number;
    concurrency?: number;
  },
): Promise<{
  task_id: string;
  total: number;
  status: string;
  poll_url: string;
  poll_interval_sec: number;
  note: string;
}> => dramaReq(`/drama/projects/${pid}/polish/batch`, "POST", body);

/** 查询 L3 批量精修任务进度(含已完成分镜的精修结果)。 */
export const getDramaPolishTask = (
  pid: string,
  taskId: string,
): Promise<DramaPolishTask> =>
  dramaReq(`/drama/projects/${pid}/polish-tasks/${taskId}`, "GET");

/** 列出项目最近的所有批量精修任务(精简版)。 */
export const listDramaPolishTasks = (
  pid: string,
): Promise<DramaPolishTaskListItem[]> =>
  dramaReq(`/drama/projects/${pid}/polish-tasks`, "GET");

export const createDramaCharacter = (
  pid: string,
  body: DramaCharacterInput,
): Promise<DramaCharacterItem> =>
  dramaReq(`/drama/projects/${pid}/characters`, "POST", body);
export const listDramaCharacters = (pid: string): Promise<DramaCharacterItem[]> =>
  dramaReq(`/drama/projects/${pid}/characters`, "GET");
export const patchDramaCharacter = (
  cid: string,
  body: DramaCharacterPatch,
): Promise<DramaCharacterItem> => dramaReq(`/drama/characters/${cid}`, "PATCH", body);
export const deleteDramaCharacter = (cid: string): Promise<{ ok: boolean }> =>
  dramaReq(`/drama/characters/${cid}`, "DELETE");

/** 单分镜视频生成(LTX t2v,异步,完成回写 shot.video_url)。 */
export const generateDramaShotVideo = (
  sid: string,
  body: DramaGenerateVideoRequest,
): Promise<DramaGenerateVideoResult> =>
  dramaReq(`/drama/shots/${sid}/generate-video`, "POST", body);

/** 单分镜配音(IndexTTS2,同步返回 wav url)。 */
export const generateDramaShotVoice = (
  sid: string,
  body: DramaGenerateVoiceRequest,
): Promise<DramaVoiceResult> =>
  dramaReq(`/drama/shots/${sid}/generate-voice`, "POST", body);

/** 单分镜对口型(源视频 + 配音 → 口型同步视频,异步,完成回写 shot.lipsync_video_url)。 */
export const generateDramaShotLipsync = (
  sid: string,
  body: DramaLipsyncRequest,
): Promise<{ url: string }> => dramaReq(`/drama/shots/${sid}/lipsync`, "POST", body);

/** 改单分镜(手动改提示词 / 台词 / seed)。 */
export const patchDramaShot = (
  sid: string,
  body: DramaShotPatch,
): Promise<DramaShotItem> => dramaReq(`/drama/shots/${sid}`, "PATCH", body);

/**
 * 一键合成成片(把已完成分镜视频按序拼接 + 配音 + 字幕)。
 * M3:可在 body.clips 显式指定合成片段,优先使用 lipsync_video_url;空则后端按 shot.video_url 兜底。
 */
export const assembleDrama = (
  pid: string,
  body: DramaAssembleOptions,
): Promise<DramaAssembleResult> =>
  // ffmpeg 多片段合成成片(配音/字幕/混音)→ 放宽到 180s。
  dramaReq(`/drama/projects/${pid}/assemble`, "POST", body, { longRequest: true });

// ---------- M1:角色三视图生成 ----------
export interface DramaGenerateReferenceBody {
  visual_prompt_override?: string;
  worker?: string;
  seed?: number;
}

/**
 * 角色三视图(正/侧/背)生成。契约:POST /api/drama/characters/{cid}/generate-reference
 * body { visual_prompt_override?, worker?, seed? } → DramaCharacterItem(含 reference_front/side/back)。
 */
export const dramaGenerateCharacterReference = (
  cid: string,
  body?: DramaGenerateReferenceBody,
): Promise<DramaCharacterItem> =>
  // 同步生成角色三视图(正/侧/背 3 张图)→ 放宽到 180s。
  dramaReq(`/drama/characters/${cid}/generate-reference`, "POST", body ?? {}, { longRequest: true });

// ---------- M2:9/25 宫格分镜 ----------
export interface DramaGridStoryboardBody {
  num_shots: number; // 9 | 25
  style?: string;
  script?: string;
}

export interface DramaGridStoryboardResponse {
  project: DramaProjectSummary;
  shots: DramaShotItem[];
  grid_image: string;
}

/**
 * 9/25 宫格分镜:一次性产出 num_shots 张分镜并拼成 3x3 / 5x5 宫格图。
 * 契约:POST /api/drama/projects/{pid}/grid-storyboard
 *   body { num_shots: 9|25, style?, script? } → { project, shots, grid_image }。
 */
export const dramaGridStoryboard = (
  pid: string,
  body: DramaGridStoryboardBody,
): Promise<DramaGridStoryboardResponse> =>
  // 一次性产出 9/25 张分镜并拼宫格图 → 放宽到 180s。
  dramaReq(`/drama/projects/${pid}/grid-storyboard`, "POST", body, { longRequest: true });

// ---------- M3:导演台(2D 场景布局)----------
export interface DramaSceneLayoutActor {
  name: string;
  x: number; // 0-100 百分比
  y: number; // 0-100 百分比
  facing: string; // left / right / front / back
  scale: number; // 0.5 - 2.0
}
export interface DramaSceneLayoutProp {
  name: string;
  x: number;
  y: number;
  scale: number;
}
export interface DramaSceneLayout {
  actors: DramaSceneLayoutActor[];
  props: DramaSceneLayoutProp[];
  camera: { angle: number; distance: number };
  notes: string;
}

export interface DramaSceneLayoutResponse {
  shot_id: string;
  scene_layout: DramaSceneLayout | null;
  raw: string;
}

/** 读取分镜场景布局。契约:GET /api/drama/shots/{sid}/scene-layout。 */
export const dramaGetSceneLayout = (sid: string): Promise<DramaSceneLayoutResponse> =>
  dramaReq(`/drama/shots/${sid}/scene-layout`, "GET");

export interface DramaUpdateSceneLayoutBody {
  layout: DramaSceneLayout;
  generate_reference: boolean;
  worker?: string;
  seed?: number;
}

/** 保存/更新分镜场景布局,可选生成构图参考图。契约:PUT /api/drama/shots/{sid}/scene-layout。 */
export const dramaUpdateSceneLayout = (
  sid: string,
  body: DramaUpdateSceneLayoutBody,
): Promise<DramaShotItem> =>
  dramaReq(`/drama/shots/${sid}/scene-layout`, "PUT", body);

// ---------- M5:Skill 市场 ----------
export interface DramaSkillCharacterTemplate {
  name: string;
  description: string;
  visual_prompt: string;
}
export interface DramaSkill {
  id: string;
  name: string;
  category: string; // action / romance / scifi / comedy
  description: string;
  style_hint: string;
  default_num_shots: number;
  width: number;
  height: number;
  fps: number;
  character_templates: DramaSkillCharacterTemplate[];
  script_template: string;
  tags: string[];
}

/** Skill 列表(可按 category 过滤)。契约:GET /api/drama/skills[?category=]。 */
export const dramaListSkills = (category?: string): Promise<{ skills: DramaSkill[] }> => {
  const q = category ? `?category=${encodeURIComponent(category)}` : "";
  return dramaReq(`/drama/skills${q}`, "GET");
};

/** 单个 Skill 详情。契约:GET /api/drama/skills/{skill_id}。 */
export const dramaGetSkill = (skillId: string): Promise<DramaSkill> =>
  dramaReq(`/drama/skills/${skillId}`, "GET");

/** 应用 Skill 创建新项目。契约:POST /api/drama/skills/{skill_id}/apply → DramaProjectDetail。 */
export const dramaApplySkill = (skillId: string): Promise<DramaProjectDetail> =>
  dramaReq(`/drama/skills/${skillId}/apply`, "POST");

// ---------- M6:模型聚合 ----------
export interface VideoGeneratorInfo {
  name: string;
  display_name: string;
  description?: string;
  supports_image2video: boolean;
  supports_text2video: boolean;
  // 前端独有:后端不返回此字段,由前端按 AVAILABLE_VIDEO_GENERATORS 白名单附加。
  // stub 模型(seedance/kling)在 generate() 时返回固定错误,元信息层不可见,故前端维护白名单。
  available?: boolean;
}

/**
 * M2.2:前端可用视频生成器白名单(单一真相源)。
 * 后端真正接入新模型时,在此 Set 加一个名字即可让选择器显示。
 * 当前 ltx 与 liveact 实际可用,seedance/kling 为 stub。
 */
export const AVAILABLE_VIDEO_GENERATORS = new Set<string>(["ltx", "liveact"]);

/** 可用视频生成模型列表。契约:GET /api/drama/video-generators。 */
export const dramaListVideoGenerators = (): Promise<{ generators: VideoGeneratorInfo[] }> =>
  dramaReq(`/drama/video-generators`, "GET");

export interface GenerateVideoV2Body {
  model: string;
  worker?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  use_upscale?: boolean;
  use_rife?: boolean;
  prompt_override?: string;
  // M1:单镜多候选生成
  num_candidates?: number;
}

/** 单分镜视频生成 v2(支持模型选择)。契约:POST /api/drama/shots/{sid}/generate-video-v2。 */
export const dramaGenerateVideoV2 = (
  sid: string,
  body: GenerateVideoV2Body,
): Promise<DramaGenerateVideoResult> =>
  dramaReq(`/drama/shots/${sid}/generate-video-v2`, "POST", body);

/** 列单镜候选视频。契约:GET /api/drama/shots/{sid}/candidates。 */
export const listDramaShotCandidates = (
  sid: string,
): Promise<{ candidates: DramaShotCandidate[] }> =>
  dramaReq(`/drama/shots/${sid}/candidates`, "GET");

/** 选择某个候选为当前分镜视频。契约:POST /api/drama/shots/{sid}/candidates/{cid}/pick。 */
export const pickDramaShotCandidate = (
  sid: string,
  cid: string,
): Promise<DramaShotItem> =>
  dramaReq(`/drama/shots/${sid}/candidates/${cid}/pick`, "POST");

/** 删除某个候选视频。契约:DELETE /api/drama/shots/{sid}/candidates/{cid}。 */
export const deleteDramaShotCandidate = (
  sid: string,
  cid: string,
): Promise<{ ok: boolean }> =>
  dramaReq(`/drama/shots/${sid}/candidates/${cid}`, "DELETE");

// ---------- M2:跨项目资产库 API ----------

/** 创建资产。契约:POST /api/drama/assets。 */
export const createDramaAsset = (body: DramaAssetInput): Promise<DramaAsset> =>
  dramaReq("/drama/assets", "POST", body);

/** 列出资产(可按 kind 过滤)。契约:GET /api/drama/assets[?kind=]。 */
export const listDramaAssets = (kind?: DramaAssetKind): Promise<DramaAssetListResponse> => {
  const q = kind ? `?kind=${encodeURIComponent(kind)}` : "";
  return dramaReq(`/drama/assets${q}`, "GET");
};

/** 更新资产。契约:PATCH /api/drama/assets/{aid}。 */
export const patchDramaAsset = (
  aid: string,
  body: DramaAssetPatch,
): Promise<DramaAsset> => dramaReq(`/drama/assets/${aid}`, "PATCH", body);

/** 删除资产。契约:DELETE /api/drama/assets/{aid}。 */
export const deleteDramaAsset = (aid: string): Promise<{ ok: boolean }> =>
  dramaReq(`/drama/assets/${aid}`, "DELETE");

/** 将资产应用为当前项目的角色。契约:POST /api/drama/assets/{aid}/apply-to-project?pid={pid}。 */
export const applyDramaAssetToProject = (
  aid: string,
  pid: string,
): Promise<DramaAssetApplyResponse> =>
  dramaReq(`/drama/assets/${aid}/apply-to-project?pid=${encodeURIComponent(pid)}`, "POST");

// ---------- M5:播放数据反哺创作 ----------

export interface ProjectPlaybackInsight {
  sessions: number;
  plays: number;
  completed: number;
  completion_rate: number;
  avg_watch_sec: number;
  engagement_rate: number;
}

export interface ShotPlaybackInsight {
  shot_id: string;
  idx: number;
  scene: string;
  start_sec: number;
  duration_sec: number;
  enters: number;
  drop_offs: number;
  avg_watch_sec: number;
  completion_rate: number;
  retention: number;
  replay_count: number;
  like_count: number;
  mark_good_count: number;
  mark_boring_count: number;
  share_count: number;
  heat_score: number;
  suggestions: string[];
}

export interface PlaybackInsightsResponse {
  project: ProjectPlaybackInsight;
  shots: ShotPlaybackInsight[];
  generated_at: string;
}

/** 获取项目播放洞察(分镜热度 + 创作建议)。契约:GET /api/drama/projects/{pid}/playback-insights。 */
export const getDramaPlaybackInsights = (
  pid: string,
): Promise<PlaybackInsightsResponse> =>
  dramaReq(`/drama/projects/${pid}/playback-insights`, "GET");

// ---------- 图片解析生成短剧(动态分镜页 AI 模式) ----------

/** POST /api/drama/projects/from-image 的响应(精简类型,字段以后端契约为准)。 */
export type DramaFromImageResult = {
  project: { id: string; title: string; premise: string };
  shots: Array<{ id: string; idx: number; scene: string }>;
  autorun_task_id: string | null;
};

/**
 * 上传 1-9 张分镜图,VLM 解析后自动建项目 + 拆分镜,auto=true 时后台跑完整管线。
 * 契约:POST /api/drama/projects/from-image  multipart
 *   images[] + hint? + style? + num_shots(4-16,默认8) + width/height/fps + auto
 *   → { project, shots, autorun_task_id };422 参数错误 / 502 VLM 解析失败。
 */
export async function createDramaProjectFromImage(params: {
  images: File[];
  hint?: string;
  style?: string;
  num_shots?: number;
  width?: number;
  height?: number;
  fps?: number;
  auto?: boolean;
}): Promise<DramaFromImageResult> {
  const fd = new FormData();
  for (const f of params.images) fd.append("images", f);
  if (params.hint) fd.append("hint", params.hint);
  if (params.style) fd.append("style", params.style);
  fd.append("num_shots", String(params.num_shots ?? 8));
  fd.append("width", String(params.width ?? 1920));
  fd.append("height", String(params.height ?? 1080));
  fd.append("fps", String(params.fps ?? 16));
  fd.append("auto", String(params.auto ?? true));
  // VLM 解析 1-9 张分镜图,实测 1-2 分钟 → 放宽到 180s。
  const res = await apiFetch(
    `/api/drama/projects/from-image`,
    {
      method: "POST",
      headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary
      body: fd,
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "解析生成失败");
  return res.json();
}

