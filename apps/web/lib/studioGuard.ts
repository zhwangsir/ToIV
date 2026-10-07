/**
 * /studio 管理员闸(2026-10-08 紧急止血)。
 *
 * 背景:/studio/api/* 直连 canvas-api 单实例(:8290),后端只校验「是否有效 ToIV 登录」,
 * 所有账号共用同一工作区(画布/资产/渠道)。用户隔离落地前,/studio 只放行 role=admin。
 *
 * 本模块无 node 依赖(中间件跑 edge 运行时),只用 fetch:
 *   · extractStudioToken:Authorization: Bearer 优先,其次 /studio 路径域 cookie toiv_session
 *   · introspectStudioUser:经 toiv-api GET /api/auth/me 内省,正向结论缓存 60s(负向不缓存,
 *     吊销/过期的 token 下一次请求即被拒)
 *   · decideStudioAccess:按路径类型给出 放行 / 401 / 403 / 503 / 跳转
 */

export const STUDIO_COOKIE = "toiv_session";
export const STUDIO_CACHE_TTL_MS = 60_000;
const CACHE_LIMIT = 256;

export type StudioUser = { id: string; role: string };
export type IntrospectResult =
  | { kind: "ok"; user: StudioUser }
  | { kind: "invalid" } // 无 token / 伪造 / 过期 / 被吊销
  | { kind: "error" }; // toiv-api 不可达或 5xx:失败即关闭

type CacheEntry = { user: StudioUser; until: number };
const cache = new Map<string, CacheEntry>();

export function _resetStudioGuardCache(): void {
  cache.clear();
}

export function extractStudioToken(authorization: string | null, cookieHeader: string | null): string {
  if (authorization && authorization.startsWith("Bearer ")) {
    return authorization.slice(7).trim();
  }
  if (cookieHeader) {
    for (const part of cookieHeader.split(";")) {
      const i = part.indexOf("=");
      if (i < 0) continue;
      if (part.slice(0, i).trim() === STUDIO_COOKIE) {
        try {
          return decodeURIComponent(part.slice(i + 1).trim());
        } catch {
          return "";
        }
      }
    }
  }
  return "";
}

export async function introspectStudioUser(
  token: string,
  opts: { base: string; fetchImpl?: typeof fetch; now?: () => number; timeoutMs?: number },
): Promise<IntrospectResult> {
  if (!token || token.length > 4096) return { kind: "invalid" };
  const now = (opts.now ?? Date.now)();
  const hit = cache.get(token);
  if (hit && hit.until > now) return { kind: "ok", user: hit.user };
  if (hit) cache.delete(token);
  const doFetch = opts.fetchImpl ?? fetch;
  let r: Response;
  try {
    r = await doFetch(`${opts.base.replace(/\/+$/, "")}/api/auth/me`, {
      headers: { authorization: `Bearer ${token}` },
      cache: "no-store",
      signal: AbortSignal.timeout(opts.timeoutMs ?? 8000),
    });
  } catch {
    return { kind: "error" };
  }
  if (r.status === 401 || r.status === 403) return { kind: "invalid" };
  if (!r.ok) return { kind: "error" };
  let body: unknown;
  try {
    body = await r.json();
  } catch {
    return { kind: "error" };
  }
  const u = (body as { user?: { id?: unknown; role?: unknown } } | null)?.user;
  if (!u || typeof u.id !== "string" || !u.id) return { kind: "invalid" };
  const user: StudioUser = { id: u.id, role: typeof u.role === "string" ? u.role : "" };
  if (cache.size >= CACHE_LIMIT) cache.clear();
  cache.set(token, { user, until: now + STUDIO_CACHE_TTL_MS });
  return { kind: "ok", user };
}

/** 无需管理员闸的 /studio 路径:入口探测、会话交换/登出(交换路由自行校验 admin)、存活探针。 */
export function isStudioGuardExempt(pathname: string): boolean {
  return (
    pathname === "/studio/entry.json" ||
    pathname === "/studio/auth/exchange" ||
    pathname === "/studio/auth/logout" ||
    pathname === "/studio/api/health/live"
  );
}

/** SPA 打包的静态文件(带扩展名:/studio/assets/x.js、/studio/short-drama-styles/a.jpg)不含用户数据,放行。 */
export function isStudioStaticFile(pathname: string): boolean {
  if (pathname.startsWith("/studio/api/")) return false;
  const last = pathname.slice(pathname.lastIndexOf("/") + 1);
  return /\.[a-z0-9]{1,12}$/i.test(last) && !/\.html?$/i.test(last);
}

export function isStudioPath(pathname: string): boolean {
  return pathname === "/studio" || pathname.startsWith("/studio/");
}

export type StudioDecision =
  | { action: "pass" }
  | { action: "json"; status: 401 | 403 | 503; reason: string; msg: string }
  | { action: "redirect"; location: string };

/** 进经典界面:?classic=1 让首页不再探测 /studio 入口,避免往返跳转。 */
export const CLASSIC_HOME = "/?view=home&classic=1";
/** 未登录/会话失效:回 ToIV 首页(管理员会在首页换取会话后自动回到 /studio)。 */
export const LOGIN_HOME = "/?view=home";

export function decideStudioAccess(
  pathname: string,
  verdict: IntrospectResult | null,
  opts: { multiTenant?: boolean } = {},
): StudioDecision {
  if (!isStudioPath(pathname) || isStudioGuardExempt(pathname) || isStudioStaticFile(pathname)) {
    return { action: "pass" };
  }
  const isApi = pathname.startsWith("/studio/api/");
  const v: IntrospectResult = verdict ?? { kind: "invalid" };
  if (v.kind === "ok" && v.user.role === "admin") return { action: "pass" };
  // M7:canvas-api 按用户隔离后(STUDIO_MULTITENANT=1),任何有效 ToIV 账号都可进入自己的工作区。
  if (v.kind === "ok" && opts.multiTenant) return { action: "pass" };
  if (isApi) {
    if (v.kind === "error") {
      return { action: "json", status: 503, reason: "toiv_auth_unavailable", msg: "登录校验暂不可用,请稍后重试" };
    }
    if (v.kind === "invalid") {
      return { action: "json", status: 401, reason: "toiv_identity_required", msg: "ToIV 登录已失效" };
    }
    return { action: "json", status: 403, reason: "studio_admin_only", msg: "画布暂只对管理员开放" };
  }
  if (v.kind === "ok") return { action: "redirect", location: CLASSIC_HOME };
  return { action: "redirect", location: LOGIN_HOME };
}
