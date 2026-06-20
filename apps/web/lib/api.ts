import type { GenerateResponse, ModelsResponse, Txt2ImgParams } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8080";

/** 后端返回的图片路径是相对的，统一拼成可访问 URL。 */
export function imageUrl(path: string): string {
  return path.startsWith("http") ? path : `${API_BASE}${path}`;
}

export async function listModels(): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/api/models`);
  if (!res.ok) throw new Error(`加载模型列表失败 (${res.status})`);
  return res.json();
}

export async function generateTxt2img(
  params: Txt2ImgParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `生成请求失败 (${res.status})`);
  }
  return res.json();
}

export function jobEventsUrl(
  promptId: string,
  clientId: string,
  worker: string,
): string {
  const qs = new URLSearchParams({ client_id: clientId, worker });
  return `${API_BASE}/api/jobs/${promptId}/events?${qs.toString()}`;
}
