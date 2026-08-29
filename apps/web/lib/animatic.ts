"use client";

import { API_BASE, apiFetch, authHeaders, getToken } from "./api";

// 动态分镜(animatic):N 张分镜图 + 每张时长 → 后端 ssh workstation 跑 ffmpeg 串成 MP4。
// 契约:
//   POST /api/animatic  multipart(images[] + durations JSON + fps/width/height)
//     → { job_id, url, count, duration, fps, width, height }
//   GET  /api/animatic/output/{job_id}.mp4  成片(<video> 走 ?token= 查询参数鉴权)

export type AnimaticResult = {
  job_id: string;
  url: string;
  count: number;
  duration: number;
  fps: number;
  width: number;
  height: number;
};

export async function createAnimatic(params: {
  images: File[];
  durations: number[];
  fps: number;
  width: number;
  height: number;
  signal?: AbortSignal;
}): Promise<AnimaticResult> {
  const fd = new FormData();
  for (const f of params.images) fd.append("images", f);
  fd.append("durations", JSON.stringify(params.durations));
  fd.append("fps", String(params.fps));
  fd.append("width", String(params.width));
  fd.append("height", String(params.height));
  const res = await apiFetch(
    `/api/animatic`,
    {
      method: "POST",
      headers: authHeaders(), // 不要手动设 Content-Type,让浏览器带 boundary
      body: fd,
      signal: params.signal,
    },
    { timeoutMs: 300_000 },
  );
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `生成失败 (${res.status})`);
  }
  return res.json();
}

/** 成片 URL 拼接:<video> 无法带 Authorization header,复用后端支持的 ?token= 查询参数。 */
export function animaticVideoUrl(url: string): string {
  const full = url.startsWith("http") ? url : `${API_BASE}${url}`;
  const t = getToken();
  return t ? `${full}${full.includes("?") ? "&" : "?"}token=${encodeURIComponent(t)}` : full;
}
