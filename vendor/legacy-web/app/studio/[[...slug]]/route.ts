import { NextRequest } from "next/server";

/**
 * /studio 与 /studio/* 退役主叙事：308 → /（ArcReel 根主壳）。
 * 精确路由优先：/studio/entry.json、/studio/auth/* 不进本 catch-all。
 * /studio/api/* 由 next.config beforeFiles 直连 canvas-api，亦不进此处。
 * query 串保留；hash 不达服务端无法保留。
 */
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(req: NextRequest) {
  const url = new URL("/", req.url);
  url.search = new URL(req.url).search;
  return Response.redirect(url, 308);
}

export async function HEAD(req: NextRequest) {
  return GET(req);
}
