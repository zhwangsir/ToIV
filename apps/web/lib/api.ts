import type {
  AdminUser,
  GenerateResponse,
  Img2ImgGenParams,
  LocalModels,
  MarketItem,
  ModelsResponse,
  Txt2ImgParams,
  Usage,
} from "./types";

const API_BASE = process.env.NEXT_PUBLIC_API_BASE ?? "http://127.0.0.1:8080";
const TOKEN_KEY = "toiv_token";

export interface AppUser {
  id: string;
  email: string;
  role: string;
}

export interface AuthResult {
  token: string;
  user: AppUser;
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
export async function fetchMe(): Promise<{ user: AppUser; usage: Usage }> {
  const res = await fetch(`${API_BASE}/api/auth/me`, { headers: authHeaders() });
  if (!res.ok) throw new Error("会话已过期");
  return res.json();
}

export async function listUsers(): Promise<AdminUser[]> {
  const res = await fetch(`${API_BASE}/api/admin/users`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载用户失败 (${res.status})`);
  return res.json();
}

export async function deleteUser(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/admin/users/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `删除失败 (${res.status})`);
  }
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

export async function listLocalModels(): Promise<LocalModels> {
  const res = await fetch(`${API_BASE}/api/models/local`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载本地模型失败 (${res.status})`);
  return res.json();
}

export async function searchMarketplace(
  source: string,
  query: string,
  type?: string,
): Promise<{ items: MarketItem[]; source: string }> {
  const qs = new URLSearchParams({ source, query });
  if (type) qs.set("type", type);
  const res = await fetch(`${API_BASE}/api/marketplace/search?${qs.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `搜索失败 (${res.status})`);
  }
  return res.json();
}

export async function uploadImage(
  file: File,
): Promise<{ filename: string; worker: string }> {
  const fd = new FormData();
  fd.append("image", file);
  const res = await fetch(`${API_BASE}/api/upload`, {
    method: "POST",
    headers: authHeaders(), // 不要手动设 Content-Type，让浏览器带 boundary
    body: fd,
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `上传失败 (${res.status})`);
  }
  return res.json();
}

export async function generateImg2img(
  params: Img2ImgGenParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/img2img`, {
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

export interface WanI2VGenParams {
  positive: string;
  image: string;
  worker: string;
  width: number;
  height: number;
  length: number;
  fps: number;
  seed?: number | null;
}

export async function generateVideo(
  params: WanI2VGenParams,
): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/video`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `视频生成请求失败 (${res.status})`);
  }
  return res.json();
}

export interface Gen3DParams {
  image: string;
  worker: string;
  steps: number;
  cfg: number;
  octree_resolution: number;
  seed?: number | null;
}

export async function generate3D(params: Gen3DParams): Promise<GenerateResponse> {
  const res = await fetch(`${API_BASE}/api/generate/3d`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `3D 生成请求失败 (${res.status})`);
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
