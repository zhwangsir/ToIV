import { apiFetch, authHeaders, raiseApiError } from "./http";

/** 说明书条目(admin 全量列表行;draft/published)。 */
export interface AdminGuideItem {
  app_id: string;
  purpose: string;
  when_to_use: string;
  steps: unknown[];
  inputs: unknown[];
  outputs: unknown[];
  tips: unknown[];
  related_app_ids: string[];
  status: "draft" | "published";
  updated_at: string | null;
}

/** 全部说明书(draft+published,updated_at 倒序)。 */
export async function listAdminGuides(): Promise<AdminGuideItem[]> {
  const res = await apiFetch(`/api/admin/app-guides`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "说明书列表加载失败");
  return res.json();
}

/** 批量生成说明书(单飞;started=false 且 reason 给出时无待做目标)。 */
export async function generateGuidesBatch(params: { limit?: number; only_missing?: boolean } = {}): Promise<{ started: boolean; planned: number; reason?: string }> {
  const res = await apiFetch(`/api/admin/app-guides/generate`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ limit: params.limit ?? 50, only_missing: params.only_missing ?? true }),
  });
  if (!res.ok) await raiseApiError(res, "批量生成触发失败(可能已有批次在跑)");
  return res.json();
}

/** 批量生成进行态:running + 最近一批汇总。 */
export async function fetchGuidesBatchStatus(): Promise<{
  running: boolean;
  summary: { done: number; failed: { id: string; error: string }[]; finished_at: string } | null;
}> {
  const res = await apiFetch(`/api/admin/app-guides/generate/status`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`批量生成状态加载失败 (${res.status})`);
  return res.json();
}

/** 全部 draft 说明书批量发布;返回发布条数。 */
export async function publishAllGuides(): Promise<{ published: number }> {
  const res = await apiFetch(`/api/admin/app-guides/publish-all`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "批量发布失败");
  return res.json();
}

/** 关联回填(published 卡确定性相似度写 related_app_ids);返回 done/skipped。 */
export async function backfillGuideRelations(): Promise<{ done: number; skipped: number }> {
  const res = await apiFetch(`/api/admin/app-guides/relations/backfill`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "关联回填失败");
  return res.json();
}
