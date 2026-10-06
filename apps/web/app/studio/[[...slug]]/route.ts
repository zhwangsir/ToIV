import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";

// M4-4 Phase C(2026-10-07):/studio 静态托管从登录网关(gate :8281)移交 Next。
// 本 catch-all 路由服务 BeefTV SPA 的 dist(与 gate 同一目录,deploy.sh --canvas-only 不变):
//   · /studio 与深链(/studio/canvas/xxx 等)→ index.html(SPA fallback,no-cache)
//   · /studio/assets/*、/studio/static/* 等真实文件按内容类型直出(immutable 缓存)
//   · /studio/api/* 不进这里——next.config beforeFiles 已先一步直连 canvas-api(:8290)
//   · /studio/entry.json、/studio/auth/* 有各自精确路由,优先于本 catch-all
// 路径穿越防护:resolve 后必须仍在 dist 根内。
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DIST = process.env.STUDIO_DIST_DIR || "/home/merlin/beeftv-prod/dist";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".wasm": "application/wasm",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".webmanifest": "application/manifest+json",
  ".glb": "model/gltf-binary",
  ".task": "application/octet-stream",
};

function streamFile(file: string, type: string, cache: string): Response {
  const stream = Readable.toWeb(createReadStream(file)) as WebReadableStream<Uint8Array>;
  return new Response(stream as unknown as ReadableStream, {
    headers: { "content-type": type, "cache-control": cache, "referrer-policy": "no-referrer" },
  });
}

async function serveIndex(): Promise<Response> {
  const index = path.join(DIST, "index.html");
  try {
    await stat(index);
  } catch {
    return new Response("studio dist 未部署(检查 STUDIO_DIST_DIR 与 deploy.sh --canvas-only)", { status: 503 });
  }
  return streamFile(index, TYPES[".html"], "no-cache");
}

export async function GET(_req: Request, ctx: { params: Promise<{ slug?: string[] }> }) {
  const { slug } = await ctx.params;
  if (!slug || slug.length === 0) return serveIndex();
  const rel = slug.map((s) => decodeURIComponent(s)).join("/");
  const file = path.resolve(DIST, rel);
  if (file.startsWith(DIST + path.sep)) {
    try {
      const st = await stat(file);
      if (st.isFile() && path.basename(file) !== "index.html") {
        const ext = path.extname(file).toLowerCase();
        const type = TYPES[ext] || "application/octet-stream";
        const cache = rel.startsWith("assets/") || rel.startsWith("static/") ? "public, max-age=31536000, immutable" : "no-cache";
        return streamFile(file, type, cache);
      }
    } catch {
      // 文件不存在或读失败:落到 SPA fallback
    }
  }
  return serveIndex();
}
