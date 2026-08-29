import { CACHE_KEYS, TTL, invalidate, swr } from "./swr-cache";
import { isParseAbortError, studioParsePollDecision, STUDIO_PARSE_POLL_MS } from "./studioParseUx";
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
  TrashJobItem,
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
// 导出供跨标签页同步(lib/crossTab.ts)订阅:他页登录/退出时本页感知
export const TOKEN_KEY = "toiv_token";

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
 * 会话失效全局事件:401 统一处理 / trackJob 冷启动探针确认凭据无效时派发。
 * 长连接(SSE trackJob)订阅此事件立即关流终止,避免持失效凭据空转重连。
 * 与跨标签页同步(lib/crossTab.ts 的 storage 事件)互补:本事件管同页内即时广播。
 */
export const SESSION_EXPIRED_EVENT = "toiv:session-expired";

/** 广播会话失效(仅浏览器环境);轻量 Event 即可,无需 detail。 */
export function emitSessionExpired(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new Event(SESSION_EXPIRED_EVENT));
}

/**
 * 401 统一处理:清除本地 token(复用 setToken 清理路径)、广播会话失效事件
 * (供 SSE 长连接关流)并跳转登录入口(登录态在 "/",app/login 只是 redirect("/"))。
 * 仅浏览器环境执行,且幂等。
 */
function handleUnauthorized(): void {
  if (typeof window === "undefined") return;
  if (authRedirectPending) return;
  authRedirectPending = true;
  setToken(null);
  emitSessionExpired();
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

/**
 * FastAPI 错误 detail 归一为可读字符串:字符串原样;422 形态数组([{loc,msg,type}])
 * 逐项「字段路径: 消息」拼接——直接 new Error(数组) 只会得到 [object Object]
 * (2026-08-27 助手「回复失败:[object Object]」根因之一)。
 */
export function apiErrorMessage(detail: unknown, fallback: string, status: number): string {
  if (typeof detail === "string" && detail) return detail;
  if (Array.isArray(detail) && detail.length > 0) {
    const parts = detail
      .map((d) => {
        if (d && typeof d === "object") {
          const rec = d as { loc?: unknown; msg?: unknown };
          const loc = Array.isArray(rec.loc)
            ? rec.loc.filter((p) => p !== "body").join(".")
            : "";
          const msg = typeof rec.msg === "string" ? rec.msg : "";
          return loc ? `${loc}: ${msg}` : msg;
        }
        return String(d);
      })
      .filter(Boolean);
    if (parts.length > 0) return parts.join("；");
  }
  return `${fallback} (${status})`;
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
  // 仅 401/403 算会话失效;5xx/网络抖动是瞬时故障,调用方据此决定重试而非踢回登录页
  if (res.status === 401 || res.status === 403) throw new Error("会话已过期");
  if (!res.ok) throw new Error(`服务暂不可用(${res.status})`);
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

/** 单页拉取(作品库服务端分页,2026-08-16):limit ≤200(后端上限),offset 位置偏移。
    首页走 swr 缓存(fetchJobsRaw),后续页直连网络不进缓存(防 localStorage 膨胀)。 */
export async function fetchJobsPage(offset: number, limit = 200, kind = ""): Promise<JobItem[]> {
  const kindQ = kind ? `&kind=${encodeURIComponent(kind)}` : "";
  const res = await apiFetch(`/api/jobs?limit=${limit}&offset=${offset}${kindQ}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载作品失败 (${res.status})`);
  return res.json();
}

/** 按 prompt_id 精确查单条作业(2026-08-29 性能:编辑器轮询专用,替代全量 200 条过滤)。
 *  404(不存在/他人/回收站)→ 返回 null,调用方保持当前状态下轮再试。 */
export async function lookupJob(promptId: string): Promise<JobItem | null> {
  const res = await apiFetch(`/api/jobs/lookup?prompt_id=${encodeURIComponent(promptId)}`, {
    headers: authHeaders(),
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`查询作业失败 (${res.status})`);
  return res.json();
}

/** 首页大小:与后端单页上限一致;返回满页即可能还有下一页。 */
export const JOBS_PAGE_LIMIT = 200;

// ---------- 任务中心(全量进度体系,2026-08-29):在跑作业轮询 ----------

/** 单个在跑作业的进度快照。 */
export interface ActiveJobProgress {
  pct: number | null;       // 0-100;null=无 step 进度(排队/无观众)
  step: number | null;
  total: number | null;
  queue_pos: number | null; // 0=生成中;N=排队第 N 位;null=未知
  updated_at: number | null;
}

/** 在跑作业条目(任务中心面板消费)。 */
export interface ActiveJobItem {
  id: string;
  prompt_id: string;
  kind: string;
  status: string;           // queued / running / held
  prompt: string;           // 后端已截 200 字
  worker: string;
  created_at: string;
  wait_sec: number;         // 已等待秒数
  eta_sec: number | null;   // ETA 粗估;held 为 null
  progress: ActiveJobProgress;
  hold_reason: string;
  nsfw: boolean;
}

export interface ActiveJobsResponse {
  items: ActiveJobItem[];
  server_time: string;
}

/** 拉取当前租户全部非终态作业(任务中心 5s 轮询;不走 SWR,进度强时效)。 */
export async function fetchActiveJobs(): Promise<ActiveJobsResponse> {
  const res = await apiFetch(`/api/jobs/active`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载在跑任务失败 (${res.status})`);
  return res.json();
}

/** 中止在跑/排队中的作业(2026-08-29 任务中心「中止」按钮)。
 *  404=非本人/不存在;409=已终态;成功返回 worker_action(dequeued/interrupted/…)。 */
export async function cancelJob(jobId: string): Promise<{ ok: boolean; status: string; worker_action: string }> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    let detail = `中止失败 (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string" && body.detail) detail = body.detail;
    } catch { /* 非 JSON 响应用默认文案 */ }
    throw new Error(detail);
  }
  return res.json();
}


async function fetchJobsRaw(): Promise<JobItem[]> {
  return fetchJobsPage(0, JOBS_PAGE_LIMIT);
}

/** 作品库,走本机 SWR 缓存(短 TTL):作品库二访秒开,后台刷新补新作品。
    R18 上下文(X-NSFW)用独立缓存键(同 models/localModels),防主站/专区互相污染。 */
export function listJobs(): Promise<JobItem[]> {
  return swr(_nsfwIntent ? `${CACHE_KEYS.jobs}:nsfw` : CACHE_KEYS.jobs, fetchJobsRaw, TTL.jobs);
}

/** 生成出新作品后调用:失效作品库缓存(主站 + 专区两个键),下次进作品库立即拉到最新。 */
export function invalidateJobs(): void {
  invalidate(CACHE_KEYS.jobs);
  invalidate(`${CACHE_KEYS.jobs}:nsfw`);
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

/** deleteJob 返回:后端软删除凭据(回收站保留期 72h,期内可撤销/恢复;SAFETY 体系)。 */
export interface DeleteJobResult {
  undo_token?: string;
  undo_ttl?: number;
}

/** 从作品库删除一件作品(按 job id);成功后失效缓存,返回撤销凭据。 */
export async function deleteJob(jobId: string): Promise<DeleteJobResult> {
  const res = await apiFetch(`/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除失败");
  invalidateJobs();
  try {
    return (await res.json()) as DeleteJobResult;
  } catch {
    return {};
  }
}

/** 撤销一次作品删除(回收站保留期 72h 内);成功后失效缓存让作品回归列表。 */
export async function undoDelete(undoToken: string): Promise<void> {
  const res = await apiFetch(`/api/undo/${undoToken}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "撤销失败(可能已过期)");
  invalidateJobs();
}

// ---------- 回收站(2026-08-23):软删作品 72h 保留期内可恢复/彻底删除 ----------

/** 回收站列表(删除时间倒序;offset/limit 分页,与 fetchJobsPage 同范式)。
    不进 swr 缓存:回收站低频访问,且恢复/删除后必须立即反映。 */
export async function fetchTrash(offset = 0, limit = 200): Promise<TrashJobItem[]> {
  const res = await apiFetch(`/api/jobs/trash?limit=${limit}&offset=${offset}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载回收站失败 (${res.status})`);
  return res.json();
}

/** 从回收站恢复一件作品(回归作品库);成功后失效缓存。 */
export async function restoreJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/restore`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "恢复失败(可能已过保留期)");
  invalidateJobs();
}

/** 彻底删除回收站中的一件作品(物理删除,不可恢复)。 */
export async function permanentDeleteJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/permanent`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "彻底删除失败");
}

/** 一键清空回收站:保留期内的软删作品全部物理删除(不可恢复);返回删除件数。 */
export async function purgeTrash(): Promise<number> {
  const res = await apiFetch(`/api/jobs/trash/purge`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "清空回收站失败");
  const data = (await res.json()) as { purged?: number };
  return data.purged ?? 0;
}

/** 审计日志条目(admin /api/admin/audit-logs)。 */
export interface AuditLogItem {
  id: string;
  user_id: string;
  user_email: string;
  action: string;
  target_type: string;
  target_id: string;
  summary: string;
  undone: boolean;
  created_at: string;
}

/** 管理员:关键操作审计日志(最新在前)。 */
export async function listAuditLogs(params: { limit?: number; action?: string } = {}): Promise<AuditLogItem[]> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.action) q.set("action", params.action);
  const res = await apiFetch(`/api/admin/audit-logs?${q.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "审计日志加载失败");
  return res.json();
}

/** 社区精选配方(CivitAI 作品逆向;R18 配方仅 /nsfw 上下文返回)。 */
export interface CommunityRecipe {
  id: string;
  label: string;
  engine_id: string;
  nsfw: boolean;
  source: string;
  description: string;
  prompt_template: string;
  negative_template: string;
  loras: { name: string; strength: number }[];
  params: Record<string, number>;
}

export async function listRecipes(engineId = ""): Promise<CommunityRecipe[]> {
  const q = engineId ? `?engine=${encodeURIComponent(engineId)}` : "";
  const res = await apiFetch(`/api/models/recipes${q}`, { headers: authHeaders() });
  if (!res.ok) return [];
  try {
    const data = (await res.json()) as { recipes: CommunityRecipe[] };
    return data.recipes ?? [];
  } catch {
    return [];
  }
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

// ---------- 模型百科 + RAG 问答(WIKI-2026-08-18) ----------

export interface ModelWikiCard {
  id: string;
  filename: string;
  model_type: string;
  label: string;
  base_model: string;
  description: string;
  usage: string;
  prompt_dialect: string;
  trigger_words: string[];
  negative_hint: string;
  tags: string[];
  creator: string;
  license: string;
  civitai_url: string;
  downloads: number;
  nsfw: boolean;
  sources: string[];
  enriched: boolean;
  has_detail: boolean;
}

export async function listModelWiki(params?: { type?: string; q?: string }): Promise<ModelWikiCard[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.q) qs.set("q", params.q);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await apiFetch(`/api/models/wiki${suffix}`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "加载模型百科失败");
  const data = (await res.json()) as { cards: ModelWikiCard[] };
  return data.cards ?? [];
}

export async function askModelWiki(question: string): Promise<{ answer: string; matched: ModelWikiCard[] }> {
  const res = await apiFetch("/api/models/ask", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ question }),
  });
  if (!res.ok) await raiseApiError(res, "模型问答失败");
  return res.json();
}

export async function enrichModelWiki(opts?: {
  force?: boolean;
  max?: number;
}): Promise<{ enriched: number; skipped: number; failed: number }> {
  const res = await apiFetch("/api/models/wiki/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ force: opts?.force ?? false, max: opts?.max ?? 40 }),
  });
  if (!res.ok) await raiseApiError(res, "富化失败");
  return res.json();
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

// ---------------------------------------------------------------------------
// P1 全局主体库(2026-08-26):角色/场景/道具三类主体跨项目复用
// ---------------------------------------------------------------------------

export type EntityKind = "character" | "scene" | "prop" | "avatar";

/** 上传句柄形态的图片引用(/api/upload 或 /api/assets/from-job 返回)。 */
export interface EntityImageHandle {
  filename: string;
  worker: string;
}

export interface EntityItem {
  id: string;
  kind: EntityKind;
  name: string;
  description: string;
  prompt_hint: string;
  ref_image: string;
  reference_front: string;
  reference_side: string;
  reference_back: string;
  /** avatar 扩展(2026-08-29 双轨归并):绿幕标记 / 默认音色 / R18 标记 */
  green_screen?: boolean;
  ref_audio?: string;
  nsfw?: boolean;
  /** 三视图生成状态:""/generating/done/error(AI 补图轮询用) */
  reference_status?: string;
  reference_error?: string;
  /** @主体引用前台化契约:最优图预览(无图空串)/ 非空图槽数(后端恒返回) */
  thumbUrl?: string;
  imageCount?: number;
  /** 已解析的上传句柄(注入参考图链直接用;URL 形态或空则无该槽) */
  handles: Partial<Record<"ref" | "front" | "side" | "back", EntityImageHandle>>;
  /** 预览 URL(/api/entities/{id}/images/{slot},过 imageUrl 带 token) */
  image_urls: Partial<Record<"ref" | "front" | "side" | "back", string>>;
  created_at: string;
  updated_at: string;
}

/** 图片字段输入:句柄对象 / URL 字符串 / 空串(清除)。 */
export type EntityImageInput = EntityImageHandle | string | undefined;

export interface EntityInput {
  kind?: EntityKind;
  name: string;
  description?: string;
  prompt_hint?: string;
  ref_image?: EntityImageInput;
  reference_front?: EntityImageInput;
  reference_side?: EntityImageInput;
  reference_back?: EntityImageInput;
  green_screen?: boolean;
  ref_audio?: string;
  nsfw?: boolean;
}

/** AI 生成三视图(2026-08-29 主体库补图):提交即返回(reference_status=generating),
 *  后台回写 reference_front/side/back(+空 ref_image 回填正面);前端轮询 listEntities。 */
export async function generateEntityReference(id: string): Promise<EntityItem> {
  const res = await apiFetch(`/api/entities/${id}/generate-reference`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: "{}",
  });
  if (!res.ok) await raiseApiError(res, "生成三视图失败");
  return res.json();
}

export async function listEntities(kind?: EntityKind): Promise<EntityItem[]> {
  const qs = kind ? `?kind=${kind}` : "";
  const res = await apiFetch(`/api/entities${qs}`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "加载主体库失败");
  return res.json();
}

export async function createEntity(body: EntityInput): Promise<EntityItem> {
  const res = await apiFetch(`/api/entities`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res, "创建主体失败");
  return res.json();
}

export async function updateEntity(id: string, body: Partial<EntityInput>): Promise<EntityItem> {
  const res = await apiFetch(`/api/entities/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res, "更新主体失败");
  return res.json();
}

export async function deleteEntity(id: string): Promise<void> {
  const res = await apiFetch(`/api/entities/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除主体失败");
}

/** 主体参考图句柄(resolve-refs 返回,已钉到目标 worker,可直接灌入引擎参考图)。 */
export interface EntityRefHandle {
  entity_id: string;
  name: string;
  prompt_hint: string;
  filename: string;
  worker: string;
}

/** entity_ids → 钉定 worker 的参考图句柄(生成页「引用主体」注入参考图链)。 */
export async function resolveEntityRefs(params: {
  entity_ids: string[];
  kind: string;
  worker?: string;
}): Promise<{ refs: EntityRefHandle[]; skipped: { entity_id: string; reason: string }[]; worker: string }> {
  const res = await apiFetch(`/api/entities/resolve-refs`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "解析主体参考图失败");
  return res.json();
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

/**
 * 反推提示词(POST /api/reverse):上传图/视频/音频 → 后端 VLM/SenseVoice 反推 →
 * { kind, prompt, negative?, meta }。供 PromptBar「反推」按钮使用;
 * 结果经 onOptimized 通道回填(与 optimize 同路,negative 自动填入机制复用)。
 * VLM 推理较慢,显式 300s 超时(与后端 _VLM_TIMEOUT 对齐)。
 */
export async function reversePrompt(
  file: File,
): Promise<{ kind: string; prompt: string; negative: string | null }> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/reverse`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary;X-NSFW 由 authHeaders 注入
    body: fd,
  }, { timeoutMs: 300_000 });
  if (!res.ok) await raiseApiError(res, "反推失败");
  const data = (await res.json()) as {
    kind: string;
    prompt: string;
    negative?: string | null;
  };
  return { kind: data.kind, prompt: data.prompt, negative: data.negative ?? null };
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
  negative?: string;
  seed?: number | null;
  // NSFW LoRA 叠加链(仅 R18 上下文生效;名字须在后端 WAN_I2V_NSFW_LORAS 注册表内)
  loras?: { name: string; strength: number }[];
  // 满血档:不挂加速 LoRA,20 步 + cfg 3.5/3.0(慢 ~4 倍换质量);缺省 false 加速档
  full_quality?: boolean;
  // RES-2026-08-18:输出分辨率档(720p/1080p/2k/4k,生成后自动二次超分);缺省原生直出
  resolution_target?: string;
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

// ── LongCat-Video 长视频文生视频(专用实例,GPU2 :8197)──
export interface LongcatT2VParams {
  positive: string;
  negative?: string;
  width?: number;      // 320-1280,16 对齐(非对齐后端自动向下取整),默认 832
  height?: number;     // 同上,默认 480
  duration_sec?: number; // 时长(秒),默认 7.5;内部 17-961 帧(16fps≈60s 单镜头),>241 帧自动上下文窗口
  num_frames?: number; // deprecated:兼容入参,请改用 duration_sec;同给时后端忽略
  steps?: number;      // 1-50,默认 10(蒸馏 LoRA 低步数)
  fps?: number;        // 8-30,默认 16(仅影响成片打包帧率)
  seed?: number | null;
  // RES-2026-08-18:输出分辨率档(720p/1080p/2k/4k,生成后自动二次超分);缺省原生直出
  resolution_target?: string;
}

export async function generateLongcatT2V(
  params: LongcatT2VParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/longcat/t2v`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LongCat 文生视频请求失败");
  return res.json();
}

export interface LongcatI2VParams extends LongcatT2VParams {
  image: string;  // 已上传的首帧参考图文件名
  worker: string; // 参考图落点的 pool worker(后端会转运到 LongCat 实例)
}

export async function generateLongcatI2V(
  params: LongcatI2VParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/longcat/i2v`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LongCat 图生视频请求失败");
  return res.json();
}

export interface LongcatContinueParams extends LongcatT2VParams {
  video: string;   // /api/images?... 产物 URL 或上传视频文件名(后者需 worker)
  worker?: string; // 上传视频所在 worker(video 为文件名时必填)
}

export async function generateLongcatContinue(
  params: LongcatContinueParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/longcat/continue`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "LongCat 视频续写请求失败");
  return res.json();
}

// ── LongCat-Avatar 数字人说话视频(与 longcat 同一专用实例 :8197)──
// 输入链路:人像图与驱动音频先经 /api/upload(kind=avatar,字段名 image,
// 音频同字段)落到同一 pool worker(上传时用 worker 参数钉住),提交时后端转运到实例。
export interface AvatarTalkParams {
  image: string;   // 已上传的人像首帧文件名
  audio?: string;  // 已上传的驱动音频文件名(wav/mp3 ≤20MB);与 drive_text 互斥(都给/都不给后端 400)
  worker: string;  // image/audio 落点的 pool worker(两者须一致)
  positive: string;
  // TTS 直通(与 audio 互斥):文本 → IndexTTS → 驱动音频
  drive_text?: string; // ≤2000 字
  voice?: string;      // 音色参考音 URL,空=引擎默认音色
  speed?: number;      // 0.5-2.0,默认 1.0(透传 IndexTTS duration_factor)
  negative?: string;
  width?: number;      // 320-1280,16 对齐(非对齐后端自动向下取整),默认 480
  height?: number;     // 同上,默认 832
  duration_sec?: number; // 时长(秒),默认 3.7;内部 17-2500 帧(25fps,>93 帧自动链式续段)
  num_frames?: number; // deprecated:兼容入参,请改用 duration_sec;同给时后端忽略
  fps?: number;        // 8-30,默认 25(Whisper 特征帧率与打包帧率同源)
  steps?: number;      // 1-50,默认 12(dmd 蒸馏 LoRA 低步数)
  shift?: number;      // 1-30,默认 12
  cfg?: number;        // 0-10,默认 1.0(蒸馏链路)
  dmd_lora_strength?: number; // 0-2,默认 1.0
  seed?: number | null;
}

export async function generateAvatarTalk(
  params: AvatarTalkParams,
): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/avatar/talk`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) await raiseApiError(res, "数字人视频生成请求失败");
  return res.json();
}

// ── 形象模板(参考资产库 kind=avatar,契约 routes/reference_assets.py)──
// images 只持久化 /api/upload 返回的 {filename, worker} 句柄;列表仅当前用户资产。
export interface AvatarAssetImage {
  filename: string;
  worker: string;
}

export interface AvatarAsset {
  id: string;
  kind: string;
  name: string;
  description: string;
  images: AvatarAssetImage[];
  nsfw: boolean;
  green_screen: boolean;
  ref_audio: string;
  created_at: string;
  updated_at: string;
}

/** 形象模板列表。契约:GET /api/assets?kind=avatar(直接返回数组)。 */
export async function listAvatarAssets(): Promise<AvatarAsset[]> {
  const res = await apiFetch(`/api/assets?kind=avatar`, {
    headers: { ...authHeaders() },
  });
  if (!res.ok) await raiseApiError(res, "形象模板加载失败");
  return res.json();
}

/** 存为形象模板(默认非绿幕)。契约:POST /api/assets {kind:"avatar",...}。 */
export async function createAvatarAsset(body: {
  name: string;
  images: AvatarAssetImage[];
  green_screen?: boolean;
  ref_audio?: string;
}): Promise<AvatarAsset> {
  const res = await apiFetch(`/api/assets`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ kind: "avatar", green_screen: false, ...body }),
  });
  if (!res.ok) await raiseApiError(res, "形象模板保存失败");
  return res.json();
}

/** 模板缩略图 URL(资产图回显端点 + ?token= 鉴权,<img> 标签可用)。 */
export function avatarAssetImageUrl(assetId: string, index = 0): string {
  return withToken(`${API_BASE}/api/assets/${encodeURIComponent(assetId)}/images/${index}`);
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

// ---------- 视频超分(4K,M6 fleet 帧级管线;后端长任务,提交秒回 + 状态轮询) ----------

export interface VideoUpscaleParams {
  /** 作品库产物 URL(/api/images?… 签名 URL 或短剧成片/工作室文件相对路径)。 */
  video_url: string;
  /** 档位(当前仅 4k;目标分辨率由服务端按画幅方向推导,禁手填宽高)。 */
  target?: "4k";
}

export interface VideoUpscaleResponse {
  job_id: string;
  prompt_id: string;
  kind: string;
  status: string;
  target: string;
}

export interface VideoUpscaleProgress {
  stage: string;
  done: number;
  total: number;
  /** 0-100;null = 不确定态(排队/api 重启后进度注册表丢失)。 */
  pct: number | null;
  detail: string;
}

export interface VideoUpscaleStatus {
  job_id: string;
  prompt_id: string;
  status: string;
  results: string[];
  progress: VideoUpscaleProgress | null;
}

/** 提交视频超分(秒回 Job);完成后产物自动收录作品库(kind=video_upscale)。 */
export async function upscaleVideo(
  params: VideoUpscaleParams,
): Promise<VideoUpscaleResponse> {
  const res = await apiFetch(`/api/video/upscale`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ video_url: params.video_url, target: params.target ?? "4k" }),
  });
  if (!res.ok) await raiseApiError(res, "超分请求失败");
  return res.json();
}

/** 轮询超分作业状态 + 帧级进度(progress 为 null 时前端按 indeterminate 展示)。 */
export async function getVideoUpscaleStatus(jobId: string): Promise<VideoUpscaleStatus> {
  const res = await apiFetch(`/api/video/upscale/${encodeURIComponent(jobId)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "查询超分状态失败");
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

export interface QwenEditParams {
  image: string; // 已上传的源图文件名
  worker: string;
  positive: string; // 编辑指令(如「把衣服换成红色」)
  camera?: string; // 相机角度预设 key(workflows/qwen_edit.CAMERA_PRESETS);不传 = 仅语义编辑
  // 3D 相机(2511 底模,96 机位):三项同时给出才生效,与 camera 互斥
  azimuth?: number; // 0/45/90/135/180/225/270/315(0=正面,顺时针)
  elevation?: number; // -30/0/30/60
  distance?: string; // closeup/medium/wide
  fast?: boolean; // 默认 true=Lightning 加速档;false=20 步标准档
  seed?: number;
  batchId?: string; // 内容分组 id(360° 环绕序列同批 8 张归组,作品库折叠为文件夹)
  /** @主体引用(2026-08-26):编辑指令内 @实体名 解析出的主体库 id(提及首现序);空/未给不携带 */
  entityIds?: string[];
}

export async function generateQwenEdit(params: QwenEditParams): Promise<GenerateResponse> {
  const res = await apiFetch(`/api/generate/qwen-edit`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      image: params.image,
      worker: params.worker,
      positive: params.positive,
      ...(params.camera ? { camera: params.camera } : {}),
      ...(params.azimuth != null ? { azimuth: params.azimuth } : {}),
      ...(params.elevation != null ? { elevation: params.elevation } : {}),
      ...(params.distance ? { distance: params.distance } : {}),
      ...(params.fast != null ? { fast: params.fast } : {}),
      ...(params.seed != null ? { seed: params.seed } : {}),
      ...(params.batchId ? { batch_id: params.batchId } : {}),
      ...(params.entityIds?.length ? { entity_ids: params.entityIds } : {}),
    }),
  });
  if (!res.ok) await raiseApiError(res, "智能编辑请求失败");
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
  /** NAS 下载作业 id;进度轮询 getNasDownloadStatus(job_id)。 */
  job_id: string;
  filename: string;
  message?: string;
}

/** 把市场模型下载到 NAS 模型库(admin,全集群 worker 共享)。契约:POST /api/marketplace/install。 */
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
  version_id?: string; // civitai: 指定版本(空=最新)
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
  status: "running" | "done" | "error" | "canceled";
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

/** 3D 产物调整(/api/3d/ops):job_id 或 source 句柄二选一;render=材质预设渲染
 * (out=glb 默认:材质烘焙回模型出新 GLB;png/mp4 为快照/旋转视频),material=PBR 改写。 */
export interface ThreeDOpsParams {
  op: "render" | "material";
  job_id?: string;
  source?: { filename: string; worker: string };
  out?: "glb" | "png" | "mp4";
  material?: "clay" | "matte" | "metal" | "glossy" | "wireframe" | "normal";
  lighting?: "environment" | "studio" | "rim";
  background?: "transparent" | "white" | "dark";
  format?: "png" | "mp4";
  azimuth?: number;
  frames?: 24 | 36;
  base_color?: string;
  metallic?: number;
  roughness?: number;
  prompt?: string;
}

export interface ThreeDOpsResult {
  kind: "threed_render" | "threed_material";
  url: string;
  job_id: string | null;
  op: string;
  format: string;
}

export async function threeDOps(params: ThreeDOpsParams): Promise<ThreeDOpsResult> {
  const res = await apiFetch(`/api/3d/ops`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  }, { longRequest: true });
  if (!res.ok) await raiseApiError(res, "3D 调整请求失败");
  return res.json();
}

/** 3D 纹理(/api/3d/texture):Hunyuan3D 2.1 多视图扩散生成真 PBR 贴图烘焙回模型,
 * 分钟级耗时(服务端上限 900s,客户端 960s 超时覆盖);产物新 GLB 进作品库 3D 桶。
 * 图生3D 作业的原始参考图由服务端自动回填,无需前端传。 */
export interface ThreeDTextureParams {
  job_id?: string;
  source?: { filename: string; worker: string };
  /** 风格/材质文本(可选),如「青铜锈蚀质感」;空则默认 high quality */
  prompt?: string;
  texture_size?: 1024 | 2048 | 4096;
}

export interface ThreeDTextureResult {
  kind: "threed_texture";
  url: string;
  job_id: string | null;
  op: string;
  format: string;
}

export async function threeDTexture(params: ThreeDTextureParams): Promise<ThreeDTextureResult> {
  const res = await apiFetch(`/api/3d/texture`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  }, { timeoutMs: 960_000 });
  if (!res.ok) await raiseApiError(res, "3D 纹理生成失败");
  return res.json();
}

export interface AudioGenParams {
  tags: string;
  lyrics: string;
  seconds: number;
  /** ACE-Step 档位:turbo=1.5 草稿(8 步) / quality=1.5 成品(50 步) / legacy=1.0 旧版 */
  quality?: "turbo" | "quality" | "legacy";
  steps: number;
  cfg: number;
  bpm?: number;
  language?: string;
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
  /** tool 事件:工具调用 id / 状态(start|ok|error) / 一句话摘要 / 失败详情 */
  id?: string;
  status?: string;
  summary?: string;
  detail?: string;
  /** job 事件:生成作业卡(results 为完整签名 URL,可直接渲染) */
  job_id?: string;
  kind?: string;
  label?: string;
  hold_reason?: string;
  results?: string[];
  /** proposal 事件:方案确认卡(markdown 正文 + 预计耗时) */
  proposal_id?: string;
  title?: string;
  body?: string;
  estimate?: string;
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
    throw new Error(apiErrorMessage(detail?.detail, "对话失败", res.status));
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

export function jobEventsUrl(
  promptId: string,
  clientId: string,
  worker: string,
): string {
  const qs = new URLSearchParams({ client_id: clientId, worker });
  return withToken(`${API_BASE}/api/jobs/${promptId}/events?${qs.toString()}`);
}

// ---------- 智能体会话(H2 会话日志:服务端持久化;前端 localStorage 仅离线兜底) ----------

export interface AgentSessionSummary {
  id: string;
  title: string;
  nsfw: boolean;
  created_at: string;
  updated_at: string;
  message_count: number;
}

export interface AgentSessionMessage {
  id: number;
  role: string; // user | assistant | tool
  content: string;
  tool_calls: unknown | null;
  media: { type: string; urls: string[] }[];
  created_at: string;
}

export interface AgentSessionDetail extends AgentSessionSummary {
  messages: AgentSessionMessage[];
}

export interface AgentChatStreamBody {
  messages: { role: string; content: string }[];
  image?: AgentImageRef | null;
  document_ids?: string[];
  /** 续聊会话 id;空=新会话(服务端创建,id 经响应头返回) */
  session_id?: string | null;
  /** @主体引用(2026-08-26):@实体名 解析出的主体库 id(提及首现序);空/未给不携带 */
  entity_ids?: string[];
}

/**
 * 智能体 SSE 事件流消费(agentChatStream / agentChatResume 共用):
 * 逐块解析 event/data,done 事件终止;命名事件(tool/job/proposal)的 data 不带
 * type 字段,以 event 名回填为事件类型。
 * onActivity:收到任何字节(含后端保活 comment 行 `: ping`)即回调,
 * 供调用方重置不活跃计时——后端活着就不误杀,真断连走 fetch 报错路径。
 */
async function consumeAgentSse(
  body: ReadableStream<Uint8Array>,
  onEvent: (ev: AgentEvent) => void,
  onActivity?: () => void,
): Promise<void> {
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    onActivity?.();
    // 事件以空行分隔;兼容 \r\n\r\n(sse-starlette/反代)与 \n\n
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    let finished = false;
    for (const block of parts) {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "done") {
        finished = true;
        break;
      }
      if (data) {
        try {
          const parsed = JSON.parse(data) as AgentEvent;
          // 命名 SSE 事件(tool/job/proposal)的 data 不带 type:以 event 名为类型
          if (!parsed.type && event !== "message") parsed.type = event;
          onEvent(parsed);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
    if (finished) break;
  }
}

/**
 * 统一对话流(SSE):与 agentChat 同一事件契约(text/tool/媒体/error + done),
 * body 支持文档挂载与会话续聊;返回响应头 X-Agent-Session-Id 携带的会话 id。
 */
export async function agentChatStream(
  body: AgentChatStreamBody,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
  onActivity?: () => void,
): Promise<{ sessionId: string | null }> {
  const res = await apiFetch(
    `/api/agent/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal,
      // SSE 流式响应:不设超时(timeoutMs: 0),取消由调用方 signal 控制。
    },
    { timeoutMs: 0 },
  );
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    // 附带 HTTP status:前端据此区分「会话不存在(404,可降级新会话重试)」与真断连
    const err = new Error(apiErrorMessage(detail?.detail, "对话失败", res.status)) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const sessionId = res.headers.get("X-Agent-Session-Id");
  try {
    await consumeAgentSse(res.body, onEvent, onActivity);
  } catch (err) {
    if (sessionId && err && typeof err === "object") {
      (err as { sessionId?: string }).sessionId = sessionId;
    }
    throw err;
  }
  return { sessionId };
}

export interface AgentChatResumeBody {
  conversation_id: string;
  proposal_id: string;
  action: "approve" | "modify" | "reject";
  /** modify 时用户填写的修改意见 */
  note?: string;
}

/**
 * 提案确认回执(2026-08-24 助手升级协议):响应仍是与 chat 同构的 SSE 流,
 * 调用方把它当一次新的发送接进现有流处理;同样返回 X-Agent-Session-Id。
 */
export async function agentChatResume(
  body: AgentChatResumeBody,
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
  onActivity?: () => void,
): Promise<{ sessionId: string | null }> {
  const res = await apiFetch(
    `/api/agent/chat/resume`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify(body),
      signal,
      // SSE 流式响应:不设超时(timeoutMs: 0),取消由调用方 signal 控制。
    },
    { timeoutMs: 0 },
  );
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    const err = new Error(apiErrorMessage(detail?.detail, "提案回执失败", res.status)) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  const sessionId = res.headers.get("X-Agent-Session-Id");
  try {
    await consumeAgentSse(res.body, onEvent, onActivity);
  } catch (err) {
    if (sessionId && err && typeof err === "object") {
      (err as { sessionId?: string }).sessionId = sessionId;
    }
    throw err;
  }
  return { sessionId };
}

/** 当前用户的会话列表(updated_at 倒序,含消息数;R18 会话由后端按上下文过滤)。 */
export async function listAgentSessions(
  signal?: AbortSignal,
): Promise<AgentSessionSummary[]> {
  const res = await apiFetch(`/api/agent/sessions`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "获取会话列表失败");
  return res.json();
}

/** 会话详情:全消息回放(id 升序即对话顺序)。 */
export async function getAgentSession(
  id: string,
  signal?: AbortSignal,
): Promise<AgentSessionDetail> {
  const res = await apiFetch(`/api/agent/sessions/${id}`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "获取会话失败");
  return res.json();
}

/** 分叉:复制源会话消息(可选截断到 atMessageId,含)生成新会话。 */
export async function forkAgentSession(
  id: string,
  atMessageId?: number,
): Promise<AgentSessionSummary> {
  const res = await apiFetch(`/api/agent/sessions/${id}/fork`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(atMessageId != null ? { at_message_id: atMessageId } : {}),
  });
  if (!res.ok) await raiseApiError(res, "分叉会话失败");
  return res.json();
}

export async function deleteAgentSession(id: string): Promise<void> {
  const res = await apiFetch(`/api/agent/sessions/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除会话失败");
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
  opts?: ApiFetchOptions & { signal?: AbortSignal },
): Promise<T> {
  const res = await apiFetch(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
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
export const synthManjuVoice = (
  body: {
    text: string;
    emo_text?: string;
    emo_alpha?: number;
    ref_audio_url?: string;
  },
  opts?: { signal?: AbortSignal },
): Promise<ManjuVoiceResult> =>
  manjuReq("/manju/voice", "POST", body, { longRequest: true, signal: opts?.signal });

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
  status: "running" | "done" | "error" | "canceled";
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
  signal?: AbortSignal,
): Promise<{ segments: DubTextSegment[]; count: number }> {
  const startRes = await apiFetch(`/api/dub/transcribe`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name }),
    signal,
  });
  if (!startRes.ok) await raiseApiError(startRes, "听写启动失败");
  const { job_id: jobId } = (await startRes.json()) as { job_id: string };

  const cancelOnce = async (): Promise<void> => {
    try {
      await cancelJob(jobId);
    } catch {
      /* 409 已终态 / 网络失败:本地已停 */
    }
  };

  try {
    // 轮询至终态(2s/次,上限 ~12 分钟)
    for (let i = 0; i < 360; i++) {
      if (signal?.aborted) {
        await cancelOnce();
        throw new DOMException("已中止", "AbortError");
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new DOMException("已中止", "AbortError"));
        };
        const timer = setTimeout(() => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        }, 2000);
        if (!signal) return;
        if (signal.aborted) onAbort();
        else signal.addEventListener("abort", onAbort);
      });
      const res = await apiFetch(`/api/dub/transcribe/${jobId}`, {
        headers: authHeaders(),
        signal,
      });
      if (!res.ok) continue; // 抖动,下次再试
      const s = (await res.json()) as TranscribeStatus;
      onProgress?.({ stage: s.stage, progress: s.progress, elapsed: s.elapsed });
      if (s.status === "done") return { segments: s.segments, count: s.count };
      if (s.status === "canceled") {
        await cancelOnce();
        throw new DOMException("已中止", "AbortError");
      }
      if (s.status === "error") throw new Error(s.error ?? "听写失败");
    }
    throw new Error("听写超时");
  } catch (e) {
    if (signal?.aborted || isParseAbortError(e)) {
      await cancelOnce();
      if (isParseAbortError(e)) throw e;
      throw new DOMException("已中止", "AbortError");
    }
    throw e;
  }
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

// ---------- 观测面板(2026-08-23):GET /api/observability 聚合快照 ----------

export interface ObservabilityInstance {
  name: string;
  url: string;
  online: boolean;
  vram_total_gb: number | null;
  vram_used_gb: number | null;
  vram_used_pct: number | null;
  queue_running: number;
  queue_pending: number;
}

export interface ObservabilityGpu {
  id: string;
  host: string;
  online: boolean;
  vram_total_gb: number | null;
  vram_used_gb: number | null;
  vram_used_pct: number | null;
  queue_running: number;
  queue_pending: number;
  instances: ObservabilityInstance[];
}

/** 队列/VRAM 时序(进程内环形缓冲,重启清零;各数组与 timestamps 等长对齐)。 */
export interface ObservabilitySeries {
  timestamps: string[];
  queued: number[];
  held: number[];
  running: number[];
  /** 每卡 VRAM 占用百分比历史;离线卡该次采样为 null */
  vram_pct: Record<string, (number | null)[]>;
}

/** 24h 逐小时成功/失败桶(hour = 整点 ISO,升序零填充)。 */
export interface ObservabilityHourlyBucket {
  hour: string;
  done: number;
  error: number;
}

export interface ObservabilitySnapshot {
  generated_at: string;
  cache_ttl_sec: number;
  queue: { queued: number; held: number; running: number; other: number };
  success_24h: {
    window_hours: number;
    done: number;
    error: number;
    total: number;
    rate: number | null;
  };
  held: { total: number; reasons: { reason: string; count: number }[] };
  gpus: ObservabilityGpu[];
  series: ObservabilitySeries;
  hourly: ObservabilityHourlyBucket[];
}

/** 观测面板聚合快照(队列分桶/24h 成功率/GPU VRAM)。仅管理员;非 2xx 抛错由视图展示。 */
export async function fetchObservability(
  signal?: AbortSignal,
): Promise<ObservabilitySnapshot> {
  const res = await apiFetch(`/api/observability`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载观测数据失败");
  return res.json();
}

// ===========================================================================
// 设备舰队(fleet)—— /api/fleet 全设备摘要 + /api/fleet/{id} 详情(仅管理员)
// ===========================================================================

/** 服务探测状态:up / down / unknown(声明式占位,探测路径不明)。 */
export type FleetServiceStatus = "up" | "down" | "unknown";

export interface FleetService {
  name: string;
  port: number;
  status: FleetServiceStatus;
  latency_ms: number | null;
  note?: string;
  extra: Record<string, unknown>;
}

export interface FleetDeviceSummary {
  id: string;
  name: string;
  role: string;
  /** true 在线 / false 离线 / null 未知(灰点) */
  online: boolean | null;
  services_up: number;
  services_total: number;
  headline: string;
}

export interface FleetSummary {
  generated_at: string;
  cache_ttl_sec: number;
  devices: FleetDeviceSummary[];
}

/** workstation sysmetrics(:9403)全量指标;NAS 详情只含 nas 段。 */
export interface FleetSysmetrics {
  cpu?: {
    percent: number | null;
    load1: number | null;
    load5: number | null;
    load15: number | null;
    cores: number | null;
  } | null;
  memory?: {
    total_gb: number;
    used_gb: number;
    available_gb: number;
    used_pct: number | null;
  } | null;
  disk_root?: {
    total_gb: number;
    used_gb: number;
    free_gb: number;
    used_pct: number | null;
  } | null;
  nas?: {
    mountpoint: string;
    mounted: boolean;
    total_gb: number | null;
    used_gb: number | null;
    free_gb: number | null;
  } | null;
  gpus?: {
    index: number;
    name: string;
    vram_used_mb: number;
    vram_total_mb: number;
    vram_used_pct: number | null;
    temp_c: number;
  }[] | null;
}

export interface FleetDeviceDetail extends FleetDeviceSummary {
  meta: { lan_ip: string | null; ts_ip: string | null; hardware: string | null };
  services: FleetService[];
  sys: FleetSysmetrics | null;
  generated_at: string;
  series: {
    timestamps: string[];
    online: (number | null)[];
    latency: Record<string, (number | null)[]>;
  };
}

/** 设备舰队摘要(仅管理员)。 */
export async function fetchFleet(signal?: AbortSignal): Promise<FleetSummary> {
  const res = await apiFetch(`/api/fleet`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载设备舰队失败");
  return res.json();
}

/** 单设备详情(服务清单 + sysmetrics + 时序)。 */
export async function fetchFleetDevice(
  deviceId: string,
  signal?: AbortSignal,
): Promise<FleetDeviceDetail> {
  const res = await apiFetch(`/api/fleet/${encodeURIComponent(deviceId)}`, {
    headers: authHeaders(),
    signal,
  });
  if (!res.ok) await raiseApiError(res, "加载设备详情失败");
  return res.json();
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

/** SSE 追踪训练进度。resolve 时训练完成(lora_path 在 TrainJob 里),reject 时失败。
 *  opts.signal:外部中止(组件卸载等)——abort 后立即关流并以 name=AbortError 的
 *  Error reject;只 close EventSource 不会让 Promise 落定,调用方 await 会永久挂起。 */
export function trackTrainJob(
  jobId: string,
  opts: {
    onProgress?: (p: TrainProgress) => void;
    register?: (es: EventSource | null) => void;
    signal?: AbortSignal;
  },
): Promise<void> {
  const token = getToken();
  const url = `${API_BASE}/api/train/${jobId}/events${token ? `?token=${token}` : ""}`;
  const es = new EventSource(url);
  opts.register?.(es);
  let done = false;

  return new Promise<void>((resolve, reject) => {
    /** 终态收尾:关流、交还句柄、摘 abort 监听。 */
    const settle = (fn: () => void): void => {
      done = true;
      es.close();
      opts.register?.(null);
      opts.signal?.removeEventListener("abort", onAbort);
      fn();
    };
    /** 外部中止(组件卸载):显式关流并 reject(AbortError),调用方静默吞掉即可。 */
    const onAbort = (): void => {
      if (done) return;
      settle(() => {
        const err = new Error("已停止跟踪该训练作业(后端仍继续)");
        err.name = "AbortError";
        reject(err);
      });
    };
    if (opts.signal) {
      if (opts.signal.aborted) {
        onAbort();
        return;
      }
      opts.signal.addEventListener("abort", onAbort);
    }
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
          settle(resolve);
        } else if (evt === "error") {
          settle(() => reject(new Error(data.message ?? "训练失败")));
        }
      } catch {
        // 忽略解析错误
      }
    });
    es.onerror = () => {
      if (!done) {
        settle(() => reject(new Error("训练连接中断")));
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
  // 三视图生成状态(异步回写):""=未生成 / generating / done / error
  reference_status?: string;
  reference_error?: string;
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
  // 末帧续写(continue-video)
  continue_status?: string;      // "" / continuing / done / error
  continue_urls?: string[];      // 续写段视频 URL 列表(/api/drama/output/)
  continue_concat_url?: string;  // auto_concat 拼接成片 URL
  continue_error?: string;
  seed: number;
  error: string;
  updated_at: string;
  // M2:宫格分镜回写(场景布局 / 视频模型)
  scene_layout: string;
  video_model: string;
  // LibTV 工作台:情绪标签 + 节拍注记(2026-08-16 后端 DramaShot 加列)
  mood: string;
  beat: string;
  // P1 衔接策略层:与下一镜的接缝策略 + 衔接锚点(空=未规划,按硬切处理)
  seam_to_next: string;    // "" / continue(续写) / overlap(重叠) / matchcut(匹配) / hardcut(硬切)
  seam_anchor: string;     // matchcut/overlap 时的共享锚体描述
  // M1:单镜多候选生成
  candidates?: DramaShotCandidate[];
  // P2:宫格阶段B grounding 状态 + color_mark 元数据(后端 detected_colors JSON)
  detected_colors?: {
    grounding_status?: string; // grounded(已按实图改写) / fallback(VLM 不可用回落原稿)
    color_map?: Record<string, string>;
    expected?: string[];
    source?: string;
  } | null;
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
  // LibTV 工作台:情绪标签 + 节拍注记(后端 ShotPatch 已支持,2026-08-16)
  mood?: string;
  beat?: string;
  // P1 衔接策略层:接缝策略("" / continue / overlap / matchcut / hardcut)+ 衔接锚点
  seam_to_next?: string;
  seam_anchor?: string;
}

export interface DramaGenerateVideoRequest {
  worker?: string;
  seed?: number;
  steps?: number;
  cfg?: number;
  use_upscale?: boolean;
  use_rife?: boolean;
  prompt_override?: string;
  // R18 上下文:/nsfw 专区传 true,后端走 _gate_ltx_nsfw(无 X-NSFW 头 403),
  // LTX 自动切 10Eros 底模并将 Job 打标 nsfw 隔离进专区作品库;缺省 false 主站行为不变。
  nsfw?: boolean;
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

// 末帧续写请求:engine 空 = 沿用分镜引擎;length/fps 空 = 沿用分镜时长换算并自动对齐帧数网格
export interface DramaContinueVideoRequest {
  segments?: number;         // 续写段数,默认 1,上限 5
  engine?: "" | "ltx" | "h3";
  auto_concat?: boolean;     // true = 完成后顺带拼接 源视频+各段 成一条完整视频
  length?: number;           // 每段帧数(LTX 8k+1 @9-241;H3 17k+5 @22-362)
  fps?: number;              // 仅 LTX 生效(H3 固定 24fps)
  steps?: number;
  cfg?: number;
  seed?: number;
  prompt_override?: string;
  // R18 上下文:同 DramaGenerateVideoRequest.nsfw,缺省 false 主站行为不变。
  nsfw?: boolean;
}

export interface DramaContinueVideoResult {
  shot_id: string;
  segments: number;
  engine: string;
  length: number;
  fps: number;
  auto_concat: boolean;
  status: string;            // "continuing"(fire-and-forget,轮询分镜详情看 continue_*)
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

/** 末帧续写(抽当前视频末帧作 i2v 首帧逐段延续,异步,轮询 shot.continue_* 字段)。 */
export const continueDramaShotVideo = (
  sid: string,
  body: DramaContinueVideoRequest,
): Promise<DramaContinueVideoResult> =>
  dramaReq(`/drama/shots/${sid}/continue-video`, "POST", body);

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
  // 提交角色三视图(正/侧/背 3 张图)生成任务;异步回写 reference_*,前端轮询。
  // LLM 翻译(空 visual_prompt 时)+ 提交 3 作业仍需数秒 → 放宽到 180s。
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
  // QA-FULL-2026-08-11 P3:available/unavailable_reason 由后端下发,数据源与
  // /api/models/engines 相同(engine_registry 探测);前端不再维护白名单。
  available?: boolean;
  unavailable_reason?: string;
}

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
  // R18 上下文:/nsfw 专区传 true,同 generate-video 的 nsfw 语义;缺省 false 主站行为不变。
  nsfw?: boolean;
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
  signal?: AbortSignal;
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
      signal: params.signal,
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "解析生成失败");
  return res.json();
}

// ---------- 音频工具(音频板块 M2)----------

export interface AudioSeparateResult {
  /** 产物回读 URL(/api/audio/files/{name}),经 imageUrl 拼 token 后播放/下载 */
  url: string;
  duration_sec: number | null;
}

/**
 * 人声分离:上传音频(mp3/wav/flac/ogg/m4a,≤50MB)→ Demucs → vocals wav。
 * 契约:POST /api/audio/separate multipart(file) → { url, duration_sec }。
 * 分离服务未配置/不可达时后端返回 503/502 带清晰原因,detail 原样抛出展示。
 * 同步管线:大文件分离耗时长 → 放宽到 180s。
 */
export async function separateAudio(
  file: File,
  opts?: { signal?: AbortSignal },
): Promise<AudioSeparateResult> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(
    `/api/audio/separate`,
    {
      method: "POST",
      headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary
      body: fd,
      signal: opts?.signal,
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "人声分离失败");
  return res.json();
}

// ---------- 视频编辑(OpenCut 风格时间线剪辑 → ffmpeg 渲染) ----------

export interface VideoEditClip {
  file: number; // media[] 数组下标(0 起)
  in: number; // 入点(秒)
  duration: number; // 时长(秒)
  volume: number; // 0-1,0=丢弃原声
}

export interface VideoEditAudio {
  file: number;
  in: number;
  duration: number;
  start: number; // 时间线起点(秒)
  volume: number;
}

export interface VideoEditText {
  text: string;
  start: number;
  end: number;
  position: string; // top | center | bottom
  fontSize: number; // 12-200
  color: string; // #rrggbb
}

export interface VideoEditPlan {
  width: number;
  height: number;
  fps: number;
  clips: VideoEditClip[];
  audios: VideoEditAudio[];
  texts: VideoEditText[];
}

export interface VideoEditResult {
  job_id: string;
  url: string;
  clips: number;
  audios: number;
  texts: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
}

/**
 * 时间线剪辑渲染:剪辑计划 + 媒体文件 → ffmpeg 串接/混音/文字叠加成片。
 * 契约:POST /api/video-edit/render multipart(plan JSON + media[])
 *   → { job_id, url, clips, audios, texts, duration, fps, width, height }。
 * 同步管线:重编码耗时长(分钟级)→ 放宽到 180s。
 */
export async function renderVideoEdit(
  plan: VideoEditPlan,
  media: File[],
): Promise<VideoEditResult> {
  const fd = new FormData();
  fd.append("plan", JSON.stringify(plan));
  for (const f of media) fd.append("media", f);
  const res = await apiFetch(
    `/api/video-edit/render`,
    {
      method: "POST",
      headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary
      body: fd,
    },
    { longRequest: true },
  );
  if (!res.ok) await raiseApiError(res, "视频渲染失败");
  return res.json();
}

/** 成片相对路径拼成可访问 URL 并附带令牌(<video>/<a> 无法带请求头)。 */
export function videoEditOutputUrl(url: string): string {
  return imageUrl(url);
}

// ---------- Studio 创作工作室(剧本 → 角色 → 分镜级混合生成 → 合成)----------
// 替代旧 短剧(drama)/漫剧(manju) 双模块;每镜独立选择 视频链 | 图像运镜链。

export type StudioRenderMode = "video" | "image_motion";

export interface StudioProjectSummary {
  id: string;
  title: string;
  premise: string;
  style: string;
  ckpt_name: string;
  render_mode_default: StudioRenderMode;
  /** 产出规格:视频/图像运镜两链共用(8 对齐;预设均为 32 对齐) */
  width: number;
  height: number;
  fps: number;
  status: string; // draft | storyboard | generating | ready | error
  final_url: string;
  error?: string;
  created_at: string;
  updated_at: string;
}

export interface StudioCharacter {
  id: string;
  project_id: string;
  name: string;
  description: string;
  visual_prompt: string;
  reference_images: string[];
  voice_ref_url: string;
  created_at?: string;
}

export interface StudioShot {
  id: string;
  project_id: string;
  idx: number;
  scene: string;
  prompt: string;
  negative: string;
  camera: string;
  dialogue: string;
  speaker: string;
  duration_sec: number;
  characters: string[];
  render_mode: StudioRenderMode;
  status: string; // draft|queued|rendering|rendered|voiced|lipsynced|done|error
  image_url: string;
  video_url: string;
  voice_url: string;
  final_clip_url: string;
  error: string;
  created_at?: string;
  updated_at?: string;
}

export interface StudioProjectDetail extends StudioProjectSummary {
  characters: StudioCharacter[];
  shots: StudioShot[];
}

export interface StudioShotInput {
  id?: string;
  scene?: string;
  prompt?: string;
  negative?: string | null;
  camera?: string;
  dialogue?: string;
  speaker?: string;
  duration_sec?: number;
  characters?: string[];
  render_mode?: StudioRenderMode;
}

export interface StudioCharacterInput {
  name: string;
  description?: string;
  visual_prompt?: string;
}

export interface StudioParseResult {
  characters: { name: string; description: string; visual_prompt: string }[];
  shots: StudioShotInput[];
}

/** Studio 统一 JSON 请求(带 auth + 错误归一),风格对齐 dramaReq/manjuReq。 */
async function studioReq<T>(
  path: string,
  method: string,
  body?: unknown,
  opts?: ApiFetchOptions & { signal?: AbortSignal },
  fallback = "创作工作室请求失败",
): Promise<T> {
  const res = await apiFetch(
    `/api${path}`,
    {
      method,
      headers: { "Content-Type": "application/json", ...authHeaders() },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    },
    opts,
  );
  if (!res.ok) await raiseApiError(res, fallback);
  return res.json();
}

export const listStudioProjects = (): Promise<StudioProjectSummary[]> =>
  studioReq("/studio/projects", "GET");
export const createStudioProject = (body: {
  title?: string;
  premise?: string;
  style?: string;
  ckpt_name?: string;
  render_mode_default?: StudioRenderMode;
  width?: number;
  height?: number;
  fps?: number;
}): Promise<StudioProjectSummary> => studioReq("/studio/projects", "POST", body);
export const getStudioProject = (pid: string): Promise<StudioProjectDetail> =>
  studioReq(`/studio/projects/${pid}`, "GET");
export const patchStudioProject = (
  pid: string,
  body: Partial<{
    title: string;
    premise: string;
    style: string;
    ckpt_name: string;
    render_mode_default: StudioRenderMode;
    status: string;
    width: number;
    height: number;
    fps: number;
  }>,
): Promise<StudioProjectSummary> => studioReq(`/studio/projects/${pid}`, "PATCH", body);
export const deleteStudioProject = (pid: string): Promise<{ ok: boolean }> =>
  studioReq(`/studio/projects/${pid}`, "DELETE");

/** LLM 剧本拆解(2026-08-29 异步化:提交→Job→2s 轮询,根治长文本撞 120s fetch 墙);
 *  拆解结果不落库,前端确认后走 CRUD 保存;轮询上限 8 分钟(覆盖 L3 长输出)。
 *  2026-08-30:超时/用户中止都 cancelJob,避免「前端报超时、后台还在跑」。 */
export const parseStudioScript = async (
  pid: string,
  body: { premise: string; num_shots?: number; style?: string },
  opts?: { signal?: AbortSignal },
): Promise<StudioParseResult> => {
  const submitted = await studioReq<{ job_id: string; status: string }>(
    `/studio/projects/${pid}/script/parse`,
    "POST",
    body,
    { signal: opts?.signal },
  );
  const started = Date.now();
  let canceled = false;
  const cancelOnce = async (): Promise<void> => {
    if (canceled) return;
    canceled = true;
    try {
      await cancelJob(submitted.job_id);
    } catch {
      /* 409 已终态 / 网络失败:本地已停,任务中心可再中止 */
    }
  };
  try {
    for (;;) {
      if (opts?.signal?.aborted) {
        await cancelOnce();
        throw new DOMException("已中止", "AbortError");
      }
      const st = await studioReq<{
        status: string;
        characters?: StudioParseResult["characters"];
        shots?: StudioParseResult["shots"];
        error?: string;
      }>(`/studio/projects/${pid}/script/parse/${submitted.job_id}`, "GET", undefined, {
        signal: opts?.signal,
      });
      const decision = studioParsePollDecision(st.status, Date.now() - started);
      if (decision === "done") {
        return { characters: st.characters ?? [], shots: st.shots ?? [] };
      }
      if (decision === "fail") {
        throw new Error(st.error || "拆解失败,请重试");
      }
      if (decision === "timeout") {
        await cancelOnce();
        throw new Error("拆解超时(8 分钟),作业已中止,请缩短剧本后重试");
      }
      await new Promise<void>((resolve, reject) => {
        const onAbort = (): void => {
          clearTimeout(timer);
          reject(new DOMException("已中止", "AbortError"));
        };
        const timer = setTimeout(() => {
          opts?.signal?.removeEventListener("abort", onAbort);
          resolve();
        }, STUDIO_PARSE_POLL_MS);
        if (!opts?.signal) return;
        if (opts.signal.aborted) onAbort();
        else opts.signal.addEventListener("abort", onAbort);
      });
    }
  } catch (e) {
    if (opts?.signal?.aborted || isParseAbortError(e)) {
      await cancelOnce();
      if (isParseAbortError(e)) throw e;
      throw new DOMException("已中止", "AbortError");
    }
    throw e;
  }
};

export const addStudioCharacter = (
  pid: string,
  body: StudioCharacterInput,
): Promise<StudioCharacter> =>
  studioReq(`/studio/projects/${pid}/characters`, "POST", body);
export const patchStudioCharacter = (
  cid: string,
  body: Partial<StudioCharacterInput & { voice_ref_url: string }>,
): Promise<StudioCharacter> => studioReq(`/studio/characters/${cid}`, "PATCH", body);
export const deleteStudioCharacter = (cid: string): Promise<{ ok: boolean }> =>
  studioReq(`/studio/characters/${cid}`, "DELETE");

/** 分镜批量保存(无 id=新增,有 id=更新;生成方式变化会重置该镜媒体与状态)。 */
export const saveStudioShots = (
  pid: string,
  shots: StudioShotInput[],
): Promise<{ shots: StudioShot[] }> =>
  studioReq(`/studio/projects/${pid}/shots`, "PUT", { shots });

/** 渲染单镜(同步等待 ComfyUI 产出,视频链可达数分钟)→ 放宽到 600s。 */
export const renderStudioShot = (
  sid: string,
  opts?: { signal?: AbortSignal },
): Promise<StudioShot> =>
  studioReq(`/studio/shots/${sid}/render`, "POST", undefined, {
    timeoutMs: 600_000,
    signal: opts?.signal,
  });

/** 批量渲染(逐镜同步,跳过终态;N 镜可达数十分钟)→ 放宽到 1800s。 */
export const renderStudioAll = (
  pid: string,
  opts?: { signal?: AbortSignal },
): Promise<{ rendered: number; failed: number }> =>
  studioReq(`/studio/projects/${pid}/render`, "POST", undefined, {
    timeoutMs: 1_800_000,
    signal: opts?.signal,
  });

/** 聚合状态(轮询用):各状态计数。 */
export const studioStatus = (
  pid: string,
): Promise<{ total: number; by_status: Record<string, number> }> =>
  studioReq(`/studio/projects/${pid}/status`, "GET");

/** 单镜配音(IndexTTS2,说话人命中角色卡带参考音则克隆)→ 放宽到 180s。 */
export const voiceStudioShot = (sid: string): Promise<StudioShot> =>
  studioReq(`/studio/shots/${sid}/voice`, "POST", undefined, { longRequest: true });

/** 对口型(仅视频镜,LatentSync 同步等待)→ 放宽到 600s。 */
export const lipsyncStudioShot = (sid: string): Promise<StudioShot> =>
  studioReq(`/studio/shots/${sid}/lipsync`, "POST", undefined, {
    timeoutMs: 600_000,
  });

/** 合成成片(ffmpeg 拼接全部就绪分镜)→ 返回完整项目详情;放宽到 180s。 */
export const assembleStudio = (pid: string): Promise<StudioProjectDetail> =>
  studioReq(`/studio/projects/${pid}/assemble`, "POST", undefined, {
    longRequest: true,
  });

/** 分镜 AI 扩写结果:简短中文描述 → 结构化分镜(不落库,前端回填表单)。 */
export interface StudioShotOptimizeResult {
  scene: string;
  camera: string;
  prompt: string;
  negative: string;
  characters: string[];
}

/** AI 扩写分镜(2026-08-18):一句简短描述 → {scene,camera,prompt,negative,characters}。
 *  shot_id 可选(带出该镜现有内容作上下文);style_hint 可选(风格方向);
 *  skill_id 可选(Skill 市场技能,人格拼在分镜系统提示前);LLM L3,放宽到 120s。 */
export const optimizeStudioShot = (
  pid: string,
  body: { brief: string; shot_id?: string; style_hint?: string; skill_id?: string },
): Promise<StudioShotOptimizeResult> =>
  studioReq(`/studio/projects/${pid}/optimize-shot`, "POST", body, {
    timeoutMs: 120_000,
  });

// ---------- 资产互通(2026-08-18):作品库产物 → 参考输入 ----------

/** 产物转运句柄:与 uploadImage 返回同构,直接灌入引擎表单 refImage/refAudio/refVideo。 */
export interface AssetFromJobHandle {
  filename: string;
  worker: string;
}

/** 把作品库 Job 产物(output 目录)搬运为参考输入(input 目录)。
 *  归属校验在后端(本人/同租户 + filename ∈ result);worker 省略按 kind 自动选目标。 */
export async function assetFromJob(body: {
  job_id: string;
  filename: string;
  kind: string;
  worker?: string;
}): Promise<AssetFromJobHandle> {
  const res = await apiFetch(`/api/assets/from-job`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res, "产物转运失败");
  return res.json();
}

// ===========================================================================
// Agent Team 统一入口(R3.1)—— 一句话目标 → Leader 拆解 → DAG 任务卡片流
// 前后端按同一契约实现;
// 前端四要素:秒回横幅 / 计划确认门 / 任务卡片流 / 事件汇报流。
// ===========================================================================

/** run 状态机:planning/awaiting_confirm/running/awaiting_assembly/done/error/canceled。 */
export type AgentRunStatus =
  | "planning"
  | "awaiting_confirm"
  | "running"
  | "awaiting_assembly"
  | "done"
  | "error"
  | "canceled";

/** task 状态机:pending/queued/running/verifying/rejected/approved/done/error
 *  (verifying/rejected 本期不出现,枚举预留)。 */
export type AgentTaskStatus =
  | "pending"
  | "queued"
  | "running"
  | "verifying"
  | "rejected"
  | "approved"
  | "done"
  | "error";

/** 计划任务(创建秒回 plan.tasks 元素)。 */
export interface AgentPlanTask {
  id: string;
  kind: string; // script/storyboard/image/video/audio/subtitle/verify/assemble
  title: string;
  depends_on: string[];
  status: AgentTaskStatus;
}

/** 详情任务卡片(GET detail 的 plan 数组元素);input/output 为后端已解析的 JSON 对象。 */
export interface AgentRunTask extends AgentPlanTask {
  attempt: number;      // 第 N 次尝试(Verifier 打回/手动重生成 +1)
  input: Record<string, unknown>;
  output: Record<string, unknown>;
  verdict: string;      // Verifier 评语/打回原因(失败透明化)
  gpu_hint: string;     // GPU 排队提示(队列位置/预计等待)
}

/** 创建秒回:L0 直链现有工作台(run_id 为 null);L1/L2 秒回 run_id 进详情页,
 *  计划由后台规划完成后经 SSE plan/confirm_required 事件到达(故 plan 可空)。 */
export interface AgentRunAckL0 {
  level: "L0";
  ack: string;
  run_id: null;
}
export interface AgentRunAckPlanned {
  level: "L1" | "L2";
  ack: string;
  run_id: string;
  /** 后台规划模式下创建响应不带计划;保留仅为兼容旧端,消费方不得依赖。 */
  plan?: { tasks: AgentPlanTask[] };
}
export type AgentRunCreateResult = AgentRunAckL0 | AgentRunAckPlanned;

export interface AgentRunSummary {
  id: string;
  level: string;
  goal: string;
  status: AgentRunStatus;
  created_at: string;
  task_counts: { total: number; done: number; error: number };
}

export interface AgentRunDetail {
  id: string;
  goal: string;
  level: string;
  status: AgentRunStatus;
  error: string;
  plan: AgentRunTask[];
  created_at: string;
  updated_at: string;
}

/** 计划编辑操作(Flowith 式):update 改标题/input;remove 删节点;add 加节点(id 由前端临时生成,后端落库时可替换)。 */
export interface AgentPlanEditOp {
  id: string;
  action: "update" | "remove" | "add";
  title?: string;
  input?: Record<string, unknown>;
}

export interface AgentResumeBody {
  gate: "plan" | "assembly";
  action: "approve" | "modify" | "reject";
  feedback?: string;
}

/** 卡片级干预;upload 携带 payload={url}(直传文件走 uploadAgentTaskAsset),
 *  reprompt 反推产物提示词写回 input。 */
export interface AgentTaskActionBody {
  action: "edit" | "regenerate" | "approve" | "upload" | "reprompt";
  payload?: Record<string, unknown>;
}

export interface AgentRunResult {
  final_url: string;
  duration_sec: number;
  tasks: AgentRunTask[];
}

/** Agent Team 统一 JSON 请求(带 auth + 错误归一),风格对齐 studioReq/dramaReq。 */
async function agentRunReq<T>(
  path: string,
  method: string,
  body?: unknown,
  fallback = "Agent 团队请求失败",
): Promise<T> {
  const res = await apiFetch(`/api${path}`, {
    method,
    headers: { "Content-Type": "application/json", ...authHeaders() },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!res.ok) await raiseApiError(res, fallback);
  return res.json();
}

/** 创建 Agent 任务(秒回):L0 → 直链;L1/L2 → run_id,计划经后台规划异步到达。 */
export const createAgentRun = (body: {
  goal: string;
  level?: string;
  opts?: Record<string, unknown>;
}): Promise<AgentRunCreateResult> => agentRunReq("/agent-runs", "POST", body, "创建任务失败");

/** 历史 run 列表(按状态/时间过滤)。 */
export const listAgentRuns = (params?: {
  limit?: number;
  status?: string;
}): Promise<AgentRunSummary[]> => {
  const qs = new URLSearchParams();
  if (params?.limit != null) qs.set("limit", String(params.limit));
  if (params?.status) qs.set("status", params.status);
  const suffix = qs.toString();
  return agentRunReq(
    `/agent-runs${suffix ? `?${suffix}` : ""}`,
    "GET",
    undefined,
    "加载任务列表失败",
  );
};

export const getAgentRun = (runId: string): Promise<AgentRunDetail> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}`,
    "GET",
    undefined,
    "加载任务详情失败",
  );

/** 编辑计划(确认门前):增/删/改 DAG 节点。 */
export const updateAgentRunPlan = (
  runId: string,
  ops: AgentPlanEditOp[],
): Promise<{ ok: boolean }> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}/plan`,
    "POST",
    { tasks: ops },
    "保存计划失败",
  );

/** 确认门裁决:approve 通过 / modify 带修改继续 / reject 打回(可带方向性批注)。 */
export const resumeAgentRun = (
  runId: string,
  body: AgentResumeBody,
): Promise<{ ok: boolean }> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}/resume`,
    "POST",
    body,
    "提交裁决失败",
  );

/** 卡片级干预:edit 改文案 / regenerate 带引导词重生 / approve 通过 /
 *  upload 替换产物(payload={url}) / reprompt 反推提示词写回 input。
 *  后端直接返回任务详情(顶层即卡片字段,无包装)。 */
export const agentTaskAction = (
  runId: string,
  taskId: string,
  body: AgentTaskActionBody,
): Promise<AgentRunTask> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/action`,
    "POST",
    body,
    "任务操作失败",
  );

/** 卡片产物直传替换(POST multipart):本地文件 → Studio 输出目录 → 卡片回 done;
 *  返回任务详情(顶层即卡片字段,与 agentTaskAction 同形)。 */
export async function uploadAgentTaskAsset(
  runId: string,
  taskId: string,
  file: File,
): Promise<AgentRunTask> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(
    `/api/agent-runs/${encodeURIComponent(runId)}/tasks/${encodeURIComponent(taskId)}/upload`,
    {
      method: "POST",
      headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary
      body: fd,
    },
  );
  if (!res.ok) await raiseApiError(res, "替换上传失败");
  return res.json();
}

export const cancelAgentRun = (runId: string): Promise<{ ok: boolean }> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}/cancel`,
    "POST",
    undefined,
    "取消任务失败",
  );

/** 成片与产物清单(合成后)。 */
export const getAgentRunResult = (runId: string): Promise<AgentRunResult> =>
  agentRunReq(
    `/agent-runs/${encodeURIComponent(runId)}/result`,
    "GET",
    undefined,
    "加载成片失败",
  );

/** SSE 事件流地址(EventSource 无法带请求头,token 走 query,同 jobEventsUrl 模式);
 *  after 为断线重连时的断点续传游标(服务端按事件 id 重放)。 */
export function agentRunEventsUrl(runId: string, after = 0): string {
  const qs = new URLSearchParams({ after: String(after) });
  return withToken(
    `${API_BASE}/api/agent-runs/${encodeURIComponent(runId)}/events?${qs.toString()}`,
  );
}

