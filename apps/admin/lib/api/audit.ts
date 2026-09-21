import { apiFetch, authHeaders, raiseApiError } from "./http";

/** 审计日志条目(admin /api/admin/audit-logs)。 */
export interface AuditLogItem {
  id: string;
  user_id: string;
  user_email: string;
  action: string;
  target_type: string;
  target_id: string;
  summary: string;
  undone: boolean;
  created_at: string;
}

/** 管理员:关键操作审计日志(最新在前)。 */
export async function listAuditLogs(params: { limit?: number; action?: string } = {}): Promise<AuditLogItem[]> {
  const q = new URLSearchParams();
  if (params.limit) q.set("limit", String(params.limit));
  if (params.action) q.set("action", params.action);
  const res = await apiFetch(`/api/admin/audit-logs?${q.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "审计日志加载失败");
  return res.json();
}
