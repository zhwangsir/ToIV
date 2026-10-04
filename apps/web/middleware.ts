import { NextResponse, type NextRequest } from "next/server";

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
 * 其他所有路径、/api（matcher 只匹配 "/"）。
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (pathname !== "/" || search) return NextResponse.next();
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();
  if (req.headers.get("rsc") || req.headers.get("next-router-prefetch")) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/site/index.html";
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/"] };
