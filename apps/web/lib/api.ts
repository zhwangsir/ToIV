import type { GenerateResponse, ModelsResponse, Txt2ImgParams } from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8080";
const TOKEN_KEY = "toiv_token";

export interface AuthResult {
  token: string;
  user: { id: string; email: string };
  credits: number;
}

// ---------- 令牌存储 ----------
export function getToken(): string | null {
  return typeof window !== "undefined" ? window.localStorage.getItem(TOKEN_KEY) : null;
}
export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}
function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}
function withToken(url: string): string {
  const t = getToken();
  if (!t) return url;
  return url + (url.includes("?") ? "&" : "?") + "token=" + encodeURIComponent(t);
}

/** 后端图片路径是相对的，拼成可访问 URL 并附带令牌（<img> 无法带请求头）。 */
export function imageUrl(path: string): string {
  const base = path.startsWith("http") ? path : `${API_BASE}${path}`;
  return withToken(base);
}

// ---------- 鉴权 ----------
async function postAuth(path: string, body: object): Promise<AuthResult> {
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `请求失败 (${res.status})`);
  }
  return res.json();
}
export function register(email: string, password: string): Promise<AuthResult> {
  return postAuth("/api/auth/register", { email, password });
}
export function login(email: string, password: string): Promise<AuthResult> {
  return postAuth("/api/auth/login", { email, password });
}
export async function fetchMe(): Promise<{ user: { id: string; email: string }; credits: number }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("会话已过期");
  return res.json();
}

// ---------- 生成 ----------
export async function listModels(): Promise<ModelsResponse> {
  const res = await fetch(`${API_BASE}/api/models`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载模型列表失败 (${res.status})`);
  return res.json();
}

export async function generateTxt2img(
  params: Txt2ImgParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/txt2img`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
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
  return withToken(`${API_BASE}/api/jobs/${promptId}/events?${qs.toString()}`);
}
