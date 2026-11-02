import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import path from "node:path";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import { Readable } from "node:stream";

// ArcReel SPA static host (root product shell via /arcreel/ prefix + iframe at /).
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const DIST = process.env.ARCREEL_DIST_DIR || "/home/merlin/toiv/apps/prime/arcreel";

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
    return new Response("arcreel dist 未部署(检查 ARCREEL_DIST_DIR 与 apps/prime/arcreel)", { status: 503 });
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
        const cache =
          rel.startsWith("assets/") || rel.startsWith("static/")
            ? "public, max-age=31536000, immutable"
            : "no-cache";
        return streamFile(file, type, cache);
      }
    } catch {
      // missing → SPA fallback
    }
  }
  return serveIndex();
}
