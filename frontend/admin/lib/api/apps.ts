import { api, apiFetch, authHeaders, raiseApiError } from "./http";

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
  /** AppOut 恒下发(列表 slim 也含):删除入口按 is_builtin 隐藏(后端内置 403)。 */
  is_builtin: boolean;
  /** AppOut 恒下发:新建/导入表单的分类选项并集来源之一。 */
  category: string;
}

export const listApps = (q: string) =>
  api.get<AdminApp[]>(`/api/apps${q ? `?q=${encodeURIComponent(q)}` : ""}`);

export const smokeOne = (id: string) => api.post(`/api/admin/apps/${encodeURIComponent(id)}/smoke`);

export const retagOne = (id: string) =>
  api.post<{ use_case: string }>(`/api/admin/apps/${encodeURIComponent(id)}/use-case/generate`);

export const putCuration = (id: string, body: { use_case?: string; featured?: boolean }) =>
  api.put(`/api/admin/apps/${encodeURIComponent(id)}/curation`, body);

export const togglePublic = (id: string, isPublic: boolean) =>
  api.put<AdminApp>(`/api/apps/${encodeURIComponent(id)}`, { is_public: isPublic });

/** 应用创建请求体(与后端 AppCreate 对齐;workflow_json 必填)。 */
export interface AdminAppCreateBody {
  id: string;
  name: string;
  description?: string;
  icon?: string;
  cover_url?: string;
  author?: string;
  category?: string;
  /** 与后端 AppCreate.workflow_json(dict)对齐:传解析后的对象,不是字符串。 */
  workflow_json: Record<string, unknown>;
  params_schema?: unknown[];
  bindings?: Record<string, unknown>;
  required_nodes?: string[];
  output_kind?: string;
  submit_kind?: string;
  is_nsfw?: boolean;
  is_public?: boolean;
  sort?: number;
}

/** 创建应用(admin;id 撞车 409,图/schema 交叉校验 422)。 */
export async function createApp(body: AdminAppCreateBody): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/apps`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res, "创建应用失败");
  return res.json();
}

/** 删除应用(admin;内置 403)。 */
export async function deleteApp(appId: string): Promise<void> {
  const res = await apiFetch(`/api/apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除应用失败");
}

/** 单应用封面上传(multipart;png/jpg/webp/gif ≤8MB,后端魔数校验)。 */
export async function uploadAppCover(appId: string, file: File): Promise<Record<string, unknown>> {
  const fd = new FormData();
  fd.append("file", file);
  const res = await apiFetch(`/api/apps/${encodeURIComponent(appId)}/cover`, {
    method: "POST",
    headers: authHeaders(), // FormData 边界由浏览器自动生成,勿设 Content-Type
    body: fd,
  });
  if (!res.ok) await raiseApiError(res, "封面上传失败");
  return res.json();
}

/** 预检响应(导入前依赖检查)。 */
export interface PreflightResult {
  procurable: boolean;
  missing_models: string[];
  missing_nodes: string[];
  total_models: number;
  note?: string;
}

/** 导入前预检:workflow 的模型/节点全 fleet 可得性。 */
export async function preflightApp(workflowJson: Record<string, unknown>, requiredNodes: string[] = []): Promise<PreflightResult> {
  const res = await apiFetch(`/api/admin/apps/preflight`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ workflow_json: workflowJson, required_nodes: requiredNodes }),
  });
  if (!res.ok) await raiseApiError(res, "预检失败");
  return res.json();
}

/** 导入草稿(LLM 分析 workflow → 结构化草稿;10min TTL 不落库;LLM 失败 503)。 */
export async function importAppDraft(workflow: Record<string, unknown>): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/apps/import`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ workflow }),
  }, { longRequest: true });
  if (!res.ok) await raiseApiError(res, "导入分析失败");
  return res.json();
}

/** 导入确认(草稿落库为个人应用;admin 再经上架转公共)。 */
export async function confirmAppImport(body: { draft_id: string; overrides?: Record<string, unknown> }): Promise<Record<string, unknown>> {
  const res = await apiFetch(`/api/apps/import/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) await raiseApiError(res, "导入确认失败");
  return res.json();
}

/** L0 结构扫描行(550 公开应用;l0_status=pass|warn|fail)。 */
export interface L0ResultRow {
  id: string;
  name: string;
  output_kind: string;
  usage_count: number;
  category: string;
  l0_status: "pass" | "warn" | "fail" | string;
  reasons: string[];
  warns: string[];
  schema_keys?: string[];
  required_fields?: string[];
  orphan_bindings?: string[];
  capability_ok?: boolean | null;
}

/** L2 热路径行(24;run_http=提交 HTTP 码,run_response 含 job_id/prompt_id/worker)。 */
export interface L2ResultRow {
  id: string;
  name: string;
  family: string;
  is_builtin: boolean;
  output_kind: string;
  started_at: string;
  submit_kind: string;
  run_http: number | null;
  run_response: {
    job_id?: string | null;
    prompt_id?: string | null;
    worker?: string | null;
    detail?: string | null;
  } | null;
  /** 行顶层冗余字段(与 run_response 同源;提交失败时 run_response 为空可兜底)。 */
  job_id?: string | null;
  prompt_id?: string | null;
  worker?: string | null;
  status?: string;
  job_status?: string;
  elapsed_sec?: number | null;
}

/** L2 候选(热路径入选依据:score/why)。 */
export interface L2Candidate {
  id: string;
  name: string;
  output_kind: string;
  is_builtin: boolean;
  family: string;
  score: number;
  why: string;
  usage_count?: number;
  l0_status?: string;
}

export interface TestMatrixResponse {
  l0_summary: {
    total_public?: number;
    pass?: number;
    fail?: number;
    warn?: number;
    by_output_kind?: Record<string, Record<string, number>>;
    elapsed_sec?: number;
    generated_at?: string;
  } | null;
  l0_results: L0ResultRow[];
  l2_summary: {
    total?: number;
    counts?: { pass?: number; fail_product?: number; fail_timeout?: number };
    by_status?: Record<string, string[]>;
    pass_ids?: string[];
    generated_at?: string;
  } | null;
  l2_results: L2ResultRow[];
  l2_candidates: L2Candidate[];
}

/** 实测矩阵汇总+逐行(admin,只读静态快照;404=未部署)。 */
export async function fetchTestMatrix(): Promise<TestMatrixResponse> {
  const res = await apiFetch(`/api/admin/test-matrix`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "实测矩阵加载失败");
  return res.json();
}

/** 图谱节点:type=engine|engine_family|lora|app|rh_webapp|model|external_source;
 *  props 按类型不同(engine.source_url / app.rh_webapp_id / model.civitai_url 等,原样透出)。 */
export interface KgNode {
  id: string;
  type: string;
  label: string;
  props: Record<string, unknown>;
}

/** 图谱边:rel=compatible_with|implements|clones_base|uses_engine|provenance|enriched_from。 */
export interface KgEdge {
  from: string;
  rel: string;
  to: string;
  props?: Record<string, unknown>;
}

/** ?entity= 查询响应(邻域子图;seeds=命中种子节点 id)。 */
export interface KgQueryResponse {
  mode: "query";
  entity: string;
  depth: number;
  seeds: string[];
  nodes: KgNode[];
  edges: KgEdge[];
  counts: { nodes: number; edges: number };
}

/** 知识图谱反查(admin):entity 模糊命中 id/label/props,返回 ≤depth 跳邻域。 */
export async function fetchKnowledgeGraph(params: {
  entity: string;
  depth?: number;
}): Promise<KgQueryResponse> {
  const q = new URLSearchParams({ entity: params.entity });
  if (params.depth && params.depth !== 1) q.set("depth", String(params.depth));
  const res = await apiFetch(`/api/admin/knowledge-graph?${q.toString()}`, {
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "知识图谱查询失败");
  return res.json();
}
