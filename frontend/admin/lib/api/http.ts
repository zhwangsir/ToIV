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
export const TOKEN_KEY = "toiv_admin_token";

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

/** 当前请求上下文是否为 /nsfw 专区(缓存键分轨用,防 R18 数据污染主站缓存)。 */
export function isNsfwIntent(): boolean {
  return _nsfwIntent;
}

export function authHeaders(): Record<string, string> {
  const t = getToken();
  const h: Record<string, string> = t ? { Authorization: `Bearer ${t}` } : {};
  if (_nsfwIntent) h["X-NSFW"] = "1";
  return h;
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
export async function raiseApiError(res: Response, fallback: string): Promise<never> {
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

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await apiFetch(path, { ...init, headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) } });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError(401, "会话过期,请重新登录");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = String(body.detail);
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
};
