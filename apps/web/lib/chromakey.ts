/**
 * 绿幕抠像合成(数字人 M6)API 封装 + 载荷构建 —— 契约 routes/chromakey.py。
 *
 * POST /api/video/chromakey {foreground_url, background_type:"color"|"image",
 * background_url?, background_color?, key_color?, similarity?, blend?}
 *   → {job_id, url, kind};产物 GET /api/video/chromakey/output/{name}(<video> 走 ?token=)。
 *
 * - foreground_url:作品库产物相对路径(/api/images?… 签名 URL),后端 resolve_source_ownership
 *   白名单 + 归属校验;勿传 imageUrl() 拼过的绝对地址(白名单不认)。
 * - 背景二选一互斥由 buildChromakeyPayload 保证:color 模式只带 background_color,
 *   image 模式只带 background_url(上传图 → worker /view 直链,后端白名单认 worker host)。
 */
import { apiFetch, authHeaders } from "./api";

export const KEY_COLOR_DEFAULT = "0x00FF00";
export const SIMILARITY_DEFAULT = 0.18;
export const BLEND_DEFAULT = 0.08;

export interface ChromakeyResult {
  job_id: string | null;
  url: string;
  kind: string;
}

/** 背景二选一:纯色(颜色名 black/white 或 0xRRGGBB)| 图片 URL(worker /view 直链)。 */
export type ChromakeyBackground =
  | { mode: "color"; color: string }
  | { mode: "image"; url: string };

export interface ChromakeyPayloadArgs {
  foreground_url: string;
  background: ChromakeyBackground;
  key_color?: string;
  similarity?: number;
  blend?: number;
}

/** 0-1 滑块夹取;非法值回退给定默认。 */
export function clamp01(n: number, fallback: number): number {
  if (!Number.isFinite(n)) return fallback;
  return Math.min(1, Math.max(0, Math.round(n * 100) / 100));
}

/** 上传句柄 → 背景图 URL:worker /view 直链(后端 _allowed_source 白名单认 worker host)。 */
export function workerViewUrl(handle: { filename: string; worker: string }): string {
  const qs = `filename=${encodeURIComponent(handle.filename)}&type=input`;
  return `${handle.worker.replace(/\/+$/, "")}/view?${qs}`;
}

/** 组装提交载荷:背景字段按模式互斥(color 无 background_url / image 无 background_color)。 */
export function buildChromakeyPayload(args: ChromakeyPayloadArgs): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    foreground_url: args.foreground_url,
    key_color: args.key_color?.trim() || KEY_COLOR_DEFAULT,
    similarity: clamp01(args.similarity ?? SIMILARITY_DEFAULT, SIMILARITY_DEFAULT),
    blend: clamp01(args.blend ?? BLEND_DEFAULT, BLEND_DEFAULT),
  };
  if (args.background.mode === "image") {
    payload.background_type = "image";
    payload.background_url = args.background.url;
  } else {
    payload.background_type = "color";
    payload.background_color = args.background.color.trim() || "black";
  }
  return payload;
}

/** 提交绿幕合成(同步,秒级~分钟级;走长任务超时档)。 */
export async function chromakeyCompose(args: ChromakeyPayloadArgs): Promise<ChromakeyResult> {
  const res = await apiFetch("/api/video/chromakey", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(buildChromakeyPayload(args)),
  }, { longRequest: true });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof detail?.detail === "string" ? detail.detail : `绿幕合成失败 (${res.status})`);
  }
  return res.json();
}
