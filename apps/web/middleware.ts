import { NextResponse, type NextRequest } from "next/server";

/**
 * 官网落地页（2026-10 ToIV 官网）。
 *
 * 登录凭证只存在浏览器 localStorage["toiv_token"]（lib/api.ts TOKEN_KEY），没有 cookie，
 * 中间件无法判断登录态。因此：
 *  1. 「裸 /」（无查询串、GET/HEAD、非 RSC/预取请求）rewrite 到静态官网 public/site/index.html；
 *     官网 <head> 内联脚本发现 toiv_token 时首帧前隐藏页面并 location.replace("/?view=home")，
 *     已登录用户不会看到官网。
 *  2. /login 原本 redirect("/") 落到首页登录表单；首页被官网接管后，为保持「/login = 登录表单」
 *     不变，这里直接跳到 /?view=home（未登录时该地址渲染原登录表单，已登录直接进产品）。
 *
 * 不受影响：任何带查询串的 /（?view=…、?t=…、?testkey=…、_rsc 客户端导航）、
 * 其他所有路径、/api（matcher 只匹配 "/" 与 "/login"）。
 */
export function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;
  if (req.method !== "GET" && req.method !== "HEAD") return NextResponse.next();
  if (req.headers.get("rsc") || req.headers.get("next-router-prefetch")) return NextResponse.next();

  if (pathname === "/login") {
    // Next 中间件的 redirect 只接受绝对 URL，而反代/端口转发后 nextUrl 的 host:port 可能是内部地址
    // （staging 实测 307 指到了 127.0.0.1:3310）。用相对地址的即时跳转页，与部署拓扑无关。
    const target = "/?view=home"; // 固定地址，不回显查询串（避免把用户输入拼进 HTML）
    const html = `<!doctype html><meta charset="utf-8"><meta http-equiv="refresh" content="0;url=${target}"><script>location.replace(${JSON.stringify(target)})</script>`;
    return new NextResponse(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
  }

  if (pathname !== "/" || search) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = "/site/index.html";
  return NextResponse.rewrite(url);
}

export const config = { matcher: ["/", "/login"] };
