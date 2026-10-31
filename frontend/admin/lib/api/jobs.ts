import { api, apiFetch, authHeaders, raiseApiError } from "./http";
import { CACHE_KEYS, invalidate } from "../swr-cache";
import type { GenerateResponse, JobItem, TrashJobItem } from "../types";

/** 中止在跑/排队中的作业(2026-08-29 任务中心「中止」按钮)。
 *  404=非本人/不存在;409=已终态;成功返回 worker_action(dequeued/interrupted/…)。 */
export async function cancelJob(jobId: string): Promise<{ ok: boolean; status: string; worker_action: string }> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) {
    let detail = `中止失败 (${res.status})`;
    try {
      const body = await res.json();
      if (typeof body?.detail === "string" && body.detail) detail = body.detail;
    } catch { /* 非 JSON 响应用默认文案 */ }
    throw new Error(detail);
  }
  return res.json();
}

/** 生成出新作品后调用:失效作品库缓存(主站 + 专区两个键),下次进作品库立即拉到最新。 */
export function invalidateJobs(): void {
  invalidate(CACHE_KEYS.jobs);
  invalidate(`${CACHE_KEYS.jobs}:nsfw`);
}

/** rerun 选项:keep=锁 seed 微调 / random=换 seed 重抽;overrides 只改增量(如 positive)。 */
export interface RerunOptions {
  seed_mode: "keep" | "random";
  overrides?: Record<string, unknown>;
}

export interface RerunResponse extends GenerateResponse {
  job_id?: string;
  parent_id?: string;
  root_id?: string;
}

/** 从历史作业精确重生;寻址接受 job id 或 prompt_id。新作业自动挂进版本链。 */
export async function rerunJob(jobKey: string, opts: RerunOptions): Promise<RerunResponse> {
  const res = await apiFetch(`/api/jobs/${encodeURIComponent(jobKey)}/rerun`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(opts),
  });
  if (!res.ok) await raiseApiError(res, "重新生成失败");
  return res.json();
}

/** deleteJob 返回:后端软删除凭据(回收站保留期 72h,期内可撤销/恢复;SAFETY 体系)。 */
export interface DeleteJobResult {
  undo_token?: string;
  undo_ttl?: number;
}

/** 从作品库删除一件作品(按 job id);成功后失效缓存,返回撤销凭据。 */
export async function deleteJob(jobId: string): Promise<DeleteJobResult> {
  const res = await apiFetch(`/api/jobs/${jobId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除失败");
  invalidateJobs();
  try {
    return (await res.json()) as DeleteJobResult;
  } catch {
    return {};
  }
}

/** 从回收站恢复一件作品(回归作品库);成功后失效缓存。 */
export async function restoreJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/restore`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "恢复失败(可能已过保留期)");
  invalidateJobs();
}

/** 彻底删除回收站中的一件作品(物理删除,不可恢复)。 */
export async function permanentDeleteJob(jobId: string): Promise<void> {
  const res = await apiFetch(`/api/jobs/${jobId}/permanent`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "彻底删除失败");
}

/** 全员作业列表(admin;kind/status 过滤+分页;行带 user_email 属主)。 */
export async function fetchAdminJobs(params: { limit?: number; offset?: number; status?: string; kind?: string } = {}): Promise<JobItem[]> {
  const q = new URLSearchParams();
  q.set("all", "1");
  q.set("limit", String(params.limit ?? 100));
  q.set("offset", String(params.offset ?? 0));
  if (params.status) q.set("status", params.status);
  if (params.kind) q.set("kind", params.kind);
  const res = await apiFetch(`/api/jobs?${q.toString()}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载全员作业失败 (${res.status})`);
  return res.json();
}

/** 全员回收站(admin;删除时间倒序;行带 user_email 属主)。 */
export async function fetchAdminTrash(offset = 0, limit = 100): Promise<TrashJobItem[]> {
  const res = await apiFetch(`/api/jobs/trash?all=1&limit=${limit}&offset=${offset}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载全员回收站失败 (${res.status})`);
  return res.json();
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

export const systemJobs = (kinds: string) =>
  api.get<SystemJob[]>(`/api/jobs?all=1&limit=100&kind=${encodeURIComponent(kinds)}`);
