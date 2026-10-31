import { api } from "./http";

export interface Me {
  user: { email: string; role: string };
}

export interface HealthInfo {
  status: string;
  workers?: string[];
}

export const consoleLogin = async (email: string, password: string): Promise<string> => {
  const data = await api.post<{ token: string }>("/api/auth/login", { email, password });
  return data.token;
};

export const me = () => api.get<Me>("/api/auth/me");

export const health = () => api.get<HealthInfo>("/api/health");

export interface JobCounts {
  count: number;
  failed: number;
}

export const jobCounts = () => api.get<JobCounts>("/api/jobs/counts");

export const cleanupFailed = () => api.post<{ deleted: number }>("/api/jobs/cleanup-failed");

export interface DemoStatus {
  running: boolean;
  never_run?: boolean;
  done?: number;
  ok?: number;
  total?: number;
  elapsed_s?: number;
}

export const demoStatus = () => api.get<DemoStatus>("/api/admin/apps/covers/demo/status");

export const startDemoBatch = (limit: number) =>
  api.post<{ started: boolean; planned: number }>("/api/admin/apps/covers/demo", { limit });

export const smokeStatus = () => api.get<DemoStatus>("/api/admin/apps/smoke/status");

export const startSmokeBatch = (limit: number) =>
  api.post<{ started: boolean }>("/api/admin/apps/smoke/batch", { limit, include_nsfw: false });

export interface SelfhealProposal {
  id: string;
  app_id: string;
  cls: string;
  status: string;
  note: string;
  created_at: string;
}

export const listProposals = () =>
  api.get<{ proposals: SelfhealProposal[] }>("/api/admin/selfheal/proposals");

export const rejectProposal = (proposalId: string) =>
  api.post(`/api/admin/selfheal/proposals/${encodeURIComponent(proposalId)}/reject`);

export interface CloseoutSmokeCounts {
  pass: number;
  fail: number;
  timeout: number;
  running: number;
  untested: number;
}

export interface CloseoutSummary {
  apps_total: number;
  public_total: number;
  soft_hidden_builtin: number;
  smoke: CloseoutSmokeCounts;
  cover_gate: {
    autorefire_enabled: boolean;
    running: boolean;
    queue_depth: number;
    queue_guard: number;
    gated: boolean;
    pending: number;
    attempt_cap: number;
    batch_limit: number;
  };
  smoke_batch: { running: boolean; summary?: unknown };
  demo_batch?: DemoStatus;
}

export const closeoutSummary = () => api.get<CloseoutSummary>("/api/admin/closeout-summary");

export const bulkSetPublic = (ids: string[], is_public: boolean) =>
  api.post<{ done: number; missing: number; is_public: boolean }>(
    "/api/admin/apps/bulk-public",
    { ids, is_public },
  );
