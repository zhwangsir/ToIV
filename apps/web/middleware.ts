import { NextResponse, type NextRequest } from "next/server";
import { decideStudioAccess, extractStudioToken, introspectStudioUser, isStudioGuardExempt, isStudioPath, isStudioStaticFile } from "@/lib/studioGuard";

/**
 * 官网落地页（2026-10 ToIV 官网）。
 *
 * 登录凭证只存在浏览器 localStorage["toiv_token"]（lib/api.ts TOKEN_KEY），没有 cookie，
 * 中间件无法判断登录态。因此只把「裸 /」（无查询串、GET/HEAD、非 RSC/预取请求）
 * rewrite 到静态官网 public/site/index.html；官网 <head> 内联脚本发现 toiv_token 时
 * 首帧前隐藏页面并 location.replace("/?view=home")，已登录用户不会看到官网。
 *
 * 登录表单入口统一为 "/?view=home"（/login、401、未登录守卫都跳这里），不经过本中间件。
 * 不受影响：任何带查询串的 /（?view=…、?t=…、?testkey=…、_rsc 客户端导航）、
 * 其他所有路径、/api（matcher 只匹配 "/" 与 /studio 管理员闸）。
 */
/**
 * /studio 管理员闸(2026-10-08):用户隔离落地前只放行 role=admin(详见 lib/studioGuard.ts)。
 * 中间件先于 next.config beforeFiles rewrite 执行,因此 /studio/api/* 在转发 canvas-api(:8290)
 * 之前就被拦下:无/伪造/过期 token → 401,非管理员 → 403,toiv-api 不可达 → 503(失败即关闭)。
 * SPA 页面:非管理员 → 经典界面(?classic=1),未登录 → ToIV 首页。
 */
async function guardStudio(req: NextRequest): Promise<NextResponse> {
  const { pathname } = req.nextUrl;
  if (isStudioGuardExempt(pathname) || isStudioStaticFile(pathname)) return NextResponse.next();
  const token = extractStudioToken(req.headers.get("authorization"), req.headers.get("cookie"));
  const base = process.env.INTERNAL_API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8090";
  const verdict = token ? await introspectStudioUser(token, { base }) : null;
  const d = decideStudioAccess(pathname, verdict);
  if (d.action === "pass") return NextResponse.next();
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

export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (isStudioPath(pathname)) return guardStudio(req);
  if (pathname !== "/" || search) return NextResponse.next();
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();
  if (req.headers.get("rsc") || req.headers.get("next-router-prefetch")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/site/index.html";
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/", "/studio", "/studio/:path*"] };
