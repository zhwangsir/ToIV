/** 管理系统 API 客户端:走本服务 /api 反代到 core :8090;token 存 localStorage。 */
const TOKEN_KEY = "toiv_admin_token";

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null): void {
  if (typeof window === "undefined") return;
  if (token) window.localStorage.setItem(TOKEN_KEY, token);
  else window.localStorage.removeItem(TOKEN_KEY);
}

function auth(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...auth(), ...(init?.headers ?? {}) },
  });
  if (res.status === 401) {
    setToken(null);
    throw new ApiError(401, "会话过期,请重新登录");
  }
  if (!res.ok) {
    let detail = `HTTP ${res.status}`;
    try {
      const body = (await res.json()) as { detail?: string };
      if (body.detail) detail = String(body.detail);
    } catch {
      /* 非 JSON 错误体 */
    }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body === undefined ? undefined : JSON.stringify(body) }),
  put: <T>(path: string, body: unknown) =>
    request<T>(path, { method: "PUT", body: JSON.stringify(body) }),
};

// ── 领域接口 ──

export interface Me {
  user: { email: string; role: string };
}

export interface HealthInfo {
  status: string;
  workers?: string[];
}

export interface JobCounts {
  count: number;
  failed: number;
}

export interface DemoStatus {
  running: boolean;
  never_run?: boolean;
  done?: number;
  ok?: number;
  total?: number;
  elapsed_s?: number;
}

export interface AdminApp {
  id: string;
  name: string;
  output_kind: string;
  use_case: string;
  featured: boolean;
  is_public: boolean;
  is_nsfw: boolean;
  smoke_status: string;
  smoke_cls: string;
  usage_count: number;
  cover_url: string | null;
}

export interface SystemJob {
  id: string;
  kind: string;
  status: string;
  worker: string;
  prompt: string;
  created_at: string;
  result: string;
  params: string;
}

export interface SelfhealProposal {
  id: string;
  app_id: string;
  cls: string;
  status: string;
  note: string;
  created_at: string;
}

export const login = async (email: string, password: string): Promise<string> => {
  const data = await api.post<{ token: string }>("/api/auth/login", { email, password });
  return data.token;
};

export const me = () => api.get<Me>("/api/auth/me");
export const health = () => api.get<HealthInfo>("/api/health");
export const jobCounts = () => api.get<JobCounts>("/api/jobs/counts");
export const cleanupFailed = () => api.post<{ deleted: number }>("/api/jobs/cleanup-failed");
export const demoStatus = () => api.get<DemoStatus>("/api/admin/apps/covers/demo/status");
export const startDemoBatch = (limit: number) =>
  api.post<{ started: boolean; planned: number }>("/api/admin/apps/covers/demo", { limit });
export const smokeStatus = () => api.get<DemoStatus>("/api/admin/apps/smoke/status");
export const startSmokeBatch = (limit: number) =>
  api.post<{ started: boolean }>("/api/admin/apps/smoke/batch", { limit, include_nsfw: false });
export const listApps = (q: string) =>
  api.get<AdminApp[]>(`/api/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`);
export const smokeOne = (id: string) => api.post(`/api/admin/apps/${encodeURIComponent(id)}/smoke`);
export const retagOne = (id: string) =>
  api.post<{ use_case: string }>(`/api/admin/apps/${encodeURIComponent(id)}/use-case/generate`);
export const putCuration = (id: string, body: { use_case?: string; featured?: boolean }) =>
  api.put(`/api/admin/apps/${encodeURIComponent(id)}/curation`, body);
export const togglePublic = (id: string, isPublic: boolean) =>
  api.put<AdminApp>(`/api/apps/${encodeURIComponent(id)}`, { is_public: isPublic });
export const systemJobs = (kinds: string) =>
  api.get<SystemJob[]>(`/api/jobs?all=1&limit=100&kind=${encodeURIComponent(kinds)}`);
export const listProposals = () =>
  api.get<{ proposals: SelfhealProposal[] }>("/api/admin/selfheal/proposals");
