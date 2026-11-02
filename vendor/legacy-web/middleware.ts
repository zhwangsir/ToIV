import { NextResponse, type NextRequest } from "next/server";
import { decideStudioAccess, extractStudioToken, introspectStudioUser, isStudioGuardExempt, isStudioPath, isStudioStaticFile } from "@/lib/studioGuard";
import { buildCanvasRequestHeaders, STUDIO_INTERNAL_HEADERS, studioMultiTenantEnabled } from "@/lib/studioIdentity";

/**
 * ArcReel 根主壳（2026-11）：裸 / 由 app/page.tsx iframe→/arcreel/，不再 rewrite 旧官网。
 * /studio*（非 auth/entry/api/static）308→/；旧孤面 RETIRED_FACE_REDIRECTS→/。
 * skipTrailingSlashRedirect：中间件接管尾斜杠——保留 `/arcreel/`（及 `/freezone/`），
 * 其余路径维持 Next 默认「去尾斜杠」；裸 `/arcreel` 308→`/arcreel/`。
 */
/**
 * /studio 管理员闸(2026-10-08):用户隔离落地前只放行 role=admin(详见 lib/studioGuard.ts)。
 * 中间件先于 next.config beforeFiles rewrite 执行,因此 /studio/api/* 在转发 canvas-api(:8290)
 * 之前就被拦下:无/伪造/过期 token → 401,非管理员 → 403,toiv-api 不可达 → 503(失败即关闭)。
 * SPA 页面:无会话放行壳(localStorage 登录);已识别非管理员且未开多租户 → 经典(?classic=1)。
 */
/** 豁免路径也不允许浏览器把内部身份头带进 canvas-api。 */
function passStripped(req: NextRequest): NextResponse {
  if (!STUDIO_INTERNAL_HEADERS.some((h) => req.headers.has(h))) return NextResponse.next();
  const headers = new Headers(req.headers);
  for (const h of STUDIO_INTERNAL_HEADERS) headers.delete(h);
  return NextResponse.next({ request: { headers } });
}

/**
 * M7 用户隔离:放行的 /studio/api/* 请求在转发 canvas-api 前注入签名身份头 X-ToIV-User
 * (lib/studioIdentity.ts),canvas-api 据此把请求限定在该用户自己的工作区;
 * STUDIO_MULTITENANT=1 时非管理员也放行(未开启时维持管理员止血闸)。
 */
async function guardStudio(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isStudioGuardExempt(pathname) || isStudioStaticFile(pathname)) return passStripped(req);
  const token = extractStudioToken(req.headers.get("authorization"), req.headers.get("cookie"));
  const base = process.env.INTERNAL_API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8090";
  const verdict = token ? await introspectStudioUser(token, { base }) : null;
  const env = { STUDIO_MULTITENANT: process.env.STUDIO_MULTITENANT, CANVAS_USER_IDENTITY_KEY: process.env.CANVAS_USER_IDENTITY_KEY };
  const d = decideStudioAccess(pathname, verdict, { multiTenant: studioMultiTenantEnabled(env) });
  if (d.action === "pass") {
    if (!pathname.startsWith("/studio/api/") || verdict?.kind !== "ok") return passStripped(req);
    const headers = await buildCanvasRequestHeaders(req.headers, verdict.user, { method: req.method, pathname }, env);
    if (!headers) {
      return NextResponse.json(
        { code: 403, data: null, msg: "账号标识不受支持", reason: "studio_identity_invalid" },
        { status: 403, headers: { "cache-control": "no-store" } },
      );
    }
    return NextResponse.next({ request: { headers } });
  }
  if (d.action === "json") {
    return NextResponse.json(
      { code: d.status, data: null, msg: d.msg, reason: d.reason },
      { status: d.status, headers: { "cache-control": "no-store" } },
    );
  }
  // 中间件响应的 Location 必须是绝对 URL(相对路径会 Invalid URL → 500)。基于 req.nextUrl 克隆,
  // 同源跳转由 Next 适配层回写为相对路径,反代后 host 为 127.0.0.1:3100 也不会泄到浏览器。
  const target = new URL(d.location, "http://studio.invalid");
  const url = req.nextUrl.clone();
  url.pathname = target.pathname;
  url.search = target.search;
  const res = NextResponse.redirect(url, 302);
  res.headers.set("cache-control", "no-store");
  return res;
}

/** ArcReel 根主壳：退役面/孤面深链 308 → /（不再以 /studio 为产品入口）。
 *  /studio 本身由下方 studio 308 处理；此处把旧孤面一并收到根。
 *  /drama/assets 语义本波不删（不在此表）。hash 不达服务端无法保留。 */
const RETIRED_FACE_REDIRECTS: ReadonlyArray<[RegExp, string]> = [
  [/^\/create(?:\/.*)?$/, "/"],
  [/^\/toiv\/ws(?:\/([^/]+))?(?:\/([^/]+))?\/?$/, "/"],
  [/^\/toiv\/agent(?:\/.*)?$/, "/"],
  [/^\/toiv\/library(\/.*)?$/, "/"],
  [/^\/toiv\/tasks(\/.*)?$/, "/"],
  [/^\/toiv\/market(\/.*)?$/, "/"],
  [/^\/toiv\/audio(?:\/.*)?$/, "/"],
  [/^\/toiv\/image-tools(?:\/.*)?$/, "/"],
  [/^\/toiv\/video-tools(?:\/.*)?$/, "/"],
  [/^\/toiv\/dub-tools(?:\/.*)?$/, "/"],
  [/^\/toiv\/runs\/([^/]+)(?:\/.*)?$/, "/"],
  [/^\/toiv\/runs\/?$/, "/"],
  [/^\/desktop(?:\/.*)?$/, "/"],
  [/^\/library(\/.*)?$/, "/"],
  [/^\/market(\/.*)?$/, "/"],
  [/^\/tasks(\/.*)?$/, "/"],
  [/^\/toiv(\/.*)?$/, "/"],
  // CanvasHub 主入口退役；深链 /drama/projects/*/freezone 与 /drama/assets 不匹配此条
  [/^\/drama\/?$/, "/"],
];

function applyRetiredRedirect(url: URL, target: string, match: RegExpExecArray, inboundSearch: string) {
  let resolved = target.replace(/\$(\d+)/g, (_, n: string) => match[Number(n)] ?? "");
  const q = resolved.indexOf("?");
  let path = resolved;
  let inject = "";
  if (q >= 0) {
    path = resolved.slice(0, q);
    inject = resolved.slice(q + 1);
  }
  url.pathname = path;
  const merged = new URLSearchParams(inboundSearch.startsWith("?") ? inboundSearch.slice(1) : inboundSearch);
  if (inject) {
    new URLSearchParams(inject).forEach((v, k) => {
      if (v) merged.set(k, v);
    });
  }
  const qs = merged.toString();
  url.search = qs ? `?${qs}` : "";
}

function redirectPreserveSearch(req: NextRequest, pathname: string): NextResponse {
  // NextURL.href → formatPathname() strips trailing slash when trailingSlash:false.
  // That turned `/arcreel/` into `/arcreel` and caused a 308 self-loop. Use URL.
  const dest = new URL(req.url);
  dest.pathname = pathname;
  const res = NextResponse.redirect(dest, 308);
  res.headers.set("cache-control", "no-store");
  return res;
}

function isStudioInfraPath(pathname: string): boolean {
  // 保留 auth / entry / api / 静态资源；其余 /studio* 308→/
  if (pathname === "/studio/entry.json") return true;
  if (pathname.startsWith("/studio/auth/")) return true;
  if (pathname.startsWith("/studio/api/")) return true;
  if (isStudioStaticFile(pathname)) return true;
  return false;
}

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  // Safety net: SPA must keep login under /arcreel/login. If a stale bundle
  // still hard-navs to host /login with an arcreel from/referer, fold it back.
  // Do NOT fold plain /login (Prime host login page → /?view=home).
  if (pathname === "/login") {
    const from = req.nextUrl.searchParams.get("from") ?? "";
    const referer = req.headers.get("referer") ?? "";
    if (from.startsWith("/arcreel") || /\/arcreel(\/|\?|#|$)/.test(referer)) {
      return redirectPreserveSearch(req, "/arcreel/login");
    }
  }

  // 尾斜杠策略（配合 next.config skipTrailingSlashRedirect）：
  // · 挂载根必须带尾斜杠，供 Vite base=/arcreel/ 与 iframe src 对齐
  // · 裸 /arcreel、/freezone → 308 补斜杠；其它路径仍去尾斜杠（旧默认）
  if (pathname === "/arcreel") {
    return redirectPreserveSearch(req, "/arcreel/");
  }
  if (pathname === "/freezone") {
    return redirectPreserveSearch(req, "/freezone/");
  }
  if (pathname.length > 1 && pathname.endsWith("/")) {
    if (pathname !== "/arcreel/" && pathname !== "/freezone/") {
      return redirectPreserveSearch(req, pathname.replace(/\/+$/, "") || "/");
    }
  }

  // ArcReel 根主壳：/studio 与 SPA 深链 308→/（保留 query）；基础设施路径豁免
  if (isStudioPath(pathname) && !isStudioInfraPath(pathname)) {
    return redirectPreserveSearch(req, "/");
  }

  for (const [re, target] of RETIRED_FACE_REDIRECTS) {
    const m = re.exec(pathname);
    if (m) {
      const url = req.nextUrl.clone();
      applyRetiredRedirect(url, target, m, search);
      const res = NextResponse.redirect(url, 308);
      res.headers.set("cache-control", "no-store");
      return res;
    }
  }

  // 豁免的 /studio/auth|entry|api|static 仍走原管理员闸（api 身份头）
  if (isStudioPath(pathname)) return guardStudio(req);

  // 根路径改由 app/page.tsx（ToivArcReelRootMount iframe→/arcreel/），不再 rewrite 旧官网
  return NextResponse.next();
}

export const config = {
  // 覆盖全站 HTML 路由以接管尾斜杠；静态资源（带扩展名）与 _next 排除。
  matcher: ["/((?!_next/static|_next/image|.*\\..*).*)"],
};
