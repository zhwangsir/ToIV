import { API_BASE, apiFetch, authHeaders, apiErrorMessage } from "./api";
import type { H3AccelLevel } from "./h3Accel";
import { CACHE_KEYS, TTL, invalidatePrefix, swr } from "./swr-cache";

/**
 * 应用市场(M3)前端 API client + 类型。
 *
 * 后端契约(并行开发中,以此为准):
 *   GET  /api/apps?category=&q=   → { items: App[] }(slim:params_schema=[] bindings={} required_nodes=[])
 *   GET  /api/apps/{id}           → App(完整 params_schema/bindings/workflow_json;运行页必须走详情)
 *   GET  /api/apps/{id}/guide     → AppGuide(公开,仅 published;无/draft → 404)
 *                                   列表/详情 App 附 has_guide/guide_purpose(仅 published 透出)
 *   POST /api/apps/{id}/fork      → 个人副本(App)
 *   POST /api/apps/{id}/run       → body { values } → { job_id, prompt_id }
 *   POST /api/apps/{id}/open-in-comfy → { workflow_name, load_url, … }(画布自动 Load)
 *
 * M5 智能导入契约:
 *   POST /api/apps/import          → body { workflow } → 200 AppImportDraft
 *                                    (限流 60s/5 → 429;LLM 失败 → 503)
 *   POST /api/apps/import/confirm  → body { draft_id, overrides? } → 200 App(个人应用)
 *                                    (草稿过期/不存在 → 404)
 *
 * params_schema 与引擎注册表(engine_registry)params 同款:AppParam 是
 * EngineParam(lib/engines.ts)的子集,可直接喂给 generate/ParamField 渲染。
 *
 * 错误归一:FastAPI detail(字符串/422 数组)经 apiErrorMessage 展平为可读中文。
 */

export type AppCategory = "image" | "video" | "audio" | "edit" | "3d" | "other";
export type AppOutputKind = "image" | "video" | "audio";
/** 与 engine_registry params 同款的应用参数类型(含上传类 images/audio/video,由 ParamField 复用 Ref*Upload)。 */
export type AppParamType = "text" | "textarea" | "number" | "select" | "switch" | "images" | "audio" | "video";

export interface AppParamOption {
  value: string;
  label: string;
  nsfw?: boolean;
  /** 一句话简介(命中模型百科时由后端注入) */
  desc?: string;
}

/** 应用参数 schema 项:EngineParam 子集(default 归一后恒存在,缺省补 null)。 */
export interface AppParam {
  key: string;
  label: string;
  type: AppParamType;
  default: unknown;
  options?: AppParamOption[];
  min?: number;
  max?: number;
  step?: number;
  hint?: string;
  /** 后端 params_schema.required;未下发时仍用 default==null 作必填启发式。 */
  required?: boolean;
}

/** 工作流节点(ComfyUI API 格式,2026-09-02 工作流模式):class_type + inputs/widgets。 */
export interface AppWorkflowNode {
  class_type: string;
  /** 节点显示名(_meta.title,可空) */
  title?: string;
  /** 原始 _meta(归一时读 title;测试夹具可直接携带) */
  _meta?: { title?: string };
  inputs?: Record<string, unknown>;
  widgets_values?: unknown[];
}

/** 绑定:param.key → 节点字段(inputs.<名> / widgets_values.<序号>)。 */
export interface AppBinding {
  node: string;
  field: string;
}

/** admin 出处外链(与后端 AppSourceLink 对齐;非 admin 恒空)。 */
export interface AppSourceLink {
  label: string;
  url: string;
}

/** 用途分类枚举(2026-09-12 市场策展层;与后端 use_case id 对齐,""=未分类)。 */
export const USE_CASES = [
  { id: "drama", label: "短剧剧情" },
  { id: "avatar", label: "数字人口播" },
  { id: "face", label: "换脸人像" },
  { id: "fashion", label: "换装穿搭" },
  { id: "ecommerce", label: "电商产品" },
  { id: "anime", label: "动漫二次元" },
  { id: "art", label: "艺术创作" },
  { id: "photo", label: "写实摄影" },
  { id: "edit", label: "图片编辑" },
  { id: "motion", label: "动作迁移" },
  { id: "ad", label: "广告营销" },
  { id: "other", label: "其他" },
] as const;

const USE_CASE_IDS = new Set<string>(USE_CASES.map((u) => u.id));

/** 用途 id → 中文 label;未知/空 → 「其他」兜底由调用方决定,这里返回 null。 */
export function useCaseLabel(id: string): string | null {
  return USE_CASES.find((u) => u.id === id)?.label ?? null;
}

export interface AppItem {
  id: string;
  name: string;
  description: string;
  /** lucide 图标名(经 ui/Icon ICON_MAP 解析;未知名 Icon 自带兜底占位) */
  icon: string;
  category: AppCategory;
  params_schema: AppParam[];
  /** 参数 → 节点字段绑定(详情接口对所有可见用户透出) */
  bindings: Record<string, AppBinding>;
  /** 原始工作流图(2026-09-02 起详情对所有可见用户透出;列表恒 null) */
  workflow_json: Record<string, AppWorkflowNode> | null;
  output_kind: AppOutputKind;
  is_builtin: boolean;
  is_nsfw: boolean;
  /** 合并卡:同时含 sfw/nsfw 时封面打双标签 */
  content_modes?: string[];
  nsfw_variant_id?: string | null;
  is_public: boolean;
  is_mine: boolean;
  usage_count: number;
  sort: number;
  /** 封面图(2026-09-06 RunningHub 化,后端并行开发):可空,空则前端按 category 渐变占位。 */
  cover_url: string | null;
  /** 作者名(可空,空显示「ToIV」)。 */
  author: string | null;
  /** RunningHub webappId(仅 admin;非 admin 恒 null)。 */
  rh_webapp_id: string | null;
  /** RH 详情页外链(仅 admin)。 */
  rh_webapp_url: string | null;
  /** 出处外链列表(RH/HF/Civitai/描述 URL;仅 admin)。 */
  source_links: AppSourceLink[];
  /** 是否有已发布的使用指南(仅 published 透出)。 */
  has_guide?: boolean;
  /** 指南用途一句话(仅 published 透出;市场卡优先展示)。 */
  guide_purpose?: string | null;
  /** 用途分类(2026-09-12 市场策展层;USE_CASES 枚举 id,""=未分类)。 */
  use_case: string;
  /** 精选标记(市场精选合集位)。 */
  featured: boolean;
  /** 自愈闭环烟测(2026-09-15):pass=实测可用徽标;fail/timeout=待修。 */
  smoke_status?: string;
  smoke_cls?: string;
  /** 功能归组(2026-09-15):同指纹折叠,变体默认隐藏。 */
  fingerprint?: string;
  variant_count?: number;
  is_variant?: boolean;
}

/** 应用使用指南(2026-09-12 P1 应用说明卡):GET /api/apps/{id}/guide 回包。 */
export interface AppGuide {
  app_id: string;
  purpose: string;
  when_to_use: string;
  steps: string[];
  inputs: string[];
  outputs: string[];
  tips: string[];
  related_app_ids: string[];
  status: string;
  updated_at: string;
}

/** 运行提交回执:契约保证 job_id/prompt_id;client_id/worker 后端给则透传(SSE 用)。 */
export interface AppRunReceipt {
  job_id: string;
  prompt_id: string;
  client_id: string;
  worker: string;
  /** H3 智能加速回显(2026-09-12;旧后端无字段时 off/false)。 */
  acceleration?: H3AccelLevel;
  acceleration_applied?: boolean;
}

const CATEGORIES: readonly AppCategory[] = ["image", "video", "audio", "edit", "3d", "other"];
const PARAM_TYPES: readonly AppParamType[] = ["text", "textarea", "number", "select", "switch", "images", "audio", "video"];

function boolOf(v: unknown): boolean {
  return v === true || v === 1;
}

function numOf(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : fallback;
}

/** params_schema 单项归一:非法 type 兜底 text;default 缺省补 null(= 必填语义)。 */
function normalizeParam(raw: unknown): AppParam {
  const p = (raw ?? {}) as Record<string, unknown>;
  const type = PARAM_TYPES.includes(p.type as AppParamType)
    ? (p.type as AppParamType)
    : "text";
  const out: AppParam = {
    key: String(p.key ?? ""),
    label: String(p.label ?? p.key ?? ""),
    type,
    default: p.default === undefined ? null : p.default,
  };
  if (Array.isArray(p.options)) {
    out.options = p.options
      .map((o) => {
        const r = (o ?? {}) as Record<string, unknown>;
        return {
          value: String(r.value ?? ""),
          label: String(r.label ?? r.value ?? ""),
          ...(boolOf(r.nsfw) ? { nsfw: true } : {}),
          ...(typeof r.desc === "string" && r.desc ? { desc: r.desc } : {}),
        };
      })
      .filter((o) => o.value !== "" || o.label !== "");
  }
  for (const k of ["min", "max", "step"] as const) {
    const n = Number(p[k]);
    if (Number.isFinite(n)) out[k] = n;
  }
  if (typeof p.hint === "string" && p.hint) out.hint = p.hint;
  if (p.required === true) out.required = true;
  else if (p.required === false) out.required = false;
  return out;
}

/** 后端原始对象 → 前端 AppItem(布尔/数字宽容归一,与 agents.ts normalizeAgent 同范式)。 */
export function normalizeApp(raw: unknown): AppItem {
  const a = (raw ?? {}) as Record<string, unknown>;
  const category = CATEGORIES.includes(a.category as AppCategory)
    ? (a.category as AppCategory)
    : "other";
  const outputKind = (["image", "video", "audio"] as const).includes(
    a.output_kind as AppOutputKind,
  )
    ? (a.output_kind as AppOutputKind)
    : "image";
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    description: String(a.description ?? ""),
    icon: String(a.icon ?? "package"),
    category,
    params_schema: Array.isArray(a.params_schema) ? a.params_schema.map(normalizeParam) : [],
    bindings: normalizeBindings(a.bindings),
    workflow_json: normalizeWorkflow(a.workflow_json),
    output_kind: outputKind,
    is_builtin: boolOf(a.is_builtin),
    is_nsfw: boolOf(a.is_nsfw),
    content_modes: Array.isArray(a.content_modes)
      ? a.content_modes.map((x: unknown) => String(x))
      : undefined,
    nsfw_variant_id:
      a.nsfw_variant_id == null || a.nsfw_variant_id === ""
        ? null
        : String(a.nsfw_variant_id),
    is_public: boolOf(a.is_public),
    is_mine: boolOf(a.is_mine),
    usage_count: numOf(a.usage_count, 0),
    sort: numOf(a.sort, 100),
    cover_url: typeof a.cover_url === "string" && a.cover_url.trim() ? a.cover_url.trim() : null,
    author: typeof a.author === "string" && a.author.trim() ? a.author.trim() : null,
    rh_webapp_id:
      typeof a.rh_webapp_id === "string" && a.rh_webapp_id.trim() ? a.rh_webapp_id.trim() : null,
    rh_webapp_url:
      typeof a.rh_webapp_url === "string" && a.rh_webapp_url.trim() ? a.rh_webapp_url.trim() : null,
    source_links: normalizeSourceLinks(a.source_links),
    has_guide: boolOf(a.has_guide),
    guide_purpose:
      typeof a.guide_purpose === "string" && a.guide_purpose.trim()
        ? a.guide_purpose.trim()
        : null,
    use_case:
      typeof a.use_case === "string" && USE_CASE_IDS.has(a.use_case) ? a.use_case : "",
    featured: boolOf(a.featured),
    smoke_status: typeof a.smoke_status === "string" ? a.smoke_status : "",
    smoke_cls: typeof a.smoke_cls === "string" ? a.smoke_cls : "",
    fingerprint: typeof a.fingerprint === "string" ? a.fingerprint : "",
    variant_count: typeof a.variant_count === "number" ? a.variant_count : 0,
    is_variant: Boolean(a.is_variant),
  };
}

/** source_links 归一:仅收 {label,url} 且 url 为 http(s);非法项剔除。 */
function normalizeSourceLinks(raw: unknown): AppSourceLink[] {
  if (!Array.isArray(raw)) return [];
  const out: AppSourceLink[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const o = (item ?? {}) as Record<string, unknown>;
    const url = typeof o.url === "string" ? o.url.trim() : "";
    const label = typeof o.label === "string" ? o.label.trim() : "";
    if (!url || !/^https?:\/\//i.test(url) || seen.has(url)) continue;
    seen.add(url);
    out.push({ label: label || "来源", url });
  }
  return out;
}

/** bindings 归一:非法项(缺 node/field 或非串)剔除。 */
function normalizeBindings(raw: unknown): Record<string, AppBinding> {
  const out: Record<string, AppBinding> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
  for (const [key, v] of Object.entries(raw as Record<string, unknown>)) {
    // 列表绑定(images 扇出到 LoadImage 110-118):工作流高亮取首个合法槽
    const items = Array.isArray(v) ? v : [v];
    for (const item of items) {
      const b = (item ?? {}) as Record<string, unknown>;
      if (typeof b.node === "string" && b.node && typeof b.field === "string" && b.field) {
        out[key] = { node: b.node, field: b.field };
        break;
      }
    }
  }
  return out;
}

/** workflow_json 归一:只收 {class_type:string} 的节点;其余剔除;非对象 → null。 */
function normalizeWorkflow(raw: unknown): Record<string, AppWorkflowNode> | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: Record<string, AppWorkflowNode> = {};
  for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = (v ?? {}) as Record<string, unknown>;
    if (typeof n.class_type !== "string" || !n.class_type) continue;
    const node: AppWorkflowNode = { class_type: n.class_type };
    const meta = n._meta as Record<string, unknown> | undefined;
    if (typeof meta?.title === "string" && meta.title) node.title = meta.title;
    if (n.inputs && typeof n.inputs === "object" && !Array.isArray(n.inputs)) {
      node.inputs = n.inputs as Record<string, unknown>;
    }
    if (Array.isArray(n.widgets_values)) node.widgets_values = n.widgets_values;
    out[id] = node;
  }
  return out;
}

/** 节点拓扑排序(Kahn;inputs 内 [nodeId, idx] 连线为边;有环/异常回退原 key 序)。 */
export function orderWorkflowNodes(wf: Record<string, AppWorkflowNode>): string[] {
  const ids = Object.keys(wf);
  const idSet = new Set(ids);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));
  for (const id of ids) {
    for (const v of Object.values(wf[id].inputs ?? {})) {
      if (Array.isArray(v) && typeof v[0] === "string" && idSet.has(v[0])) {
        adj.get(v[0])!.push(id);
        indeg.set(id, (indeg.get(id) ?? 0) + 1);
      }
    }
  }
  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 1) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }
  // 有环(孤岛残留):按原 key 序补齐,保证节点不丢
  return order.length === ids.length ? order : ids;
}

/** 按节点分组绑定:nodeId → [{ key, field }](工作流模式高亮/内联编辑用)。 */
export function bindingsByNode(
  bindings: Record<string, AppBinding>,
): Map<string, { key: string; field: string }[]> {
  const out = new Map<string, { key: string; field: string }[]>();
  for (const [key, b] of Object.entries(bindings)) {
    const list = out.get(b.node) ?? [];
    list.push({ key, field: b.field });
    out.set(b.node, list);
  }
  return out;
}

async function raiseErr(res: Response, fallback: string): Promise<never> {
  const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  throw new Error(apiErrorMessage(detail?.detail, `${fallback} (${res.status})`, res.status));
}

/** 应用列表;category/q 非空才上 query(契约:?category=&q=)。非 2xx 抛错。
 *  走本机 SWR 缓存(2026-09-01 L1):市场/融合二访秒开;fork/导入/运行后显式失效。 */
export async function listApps(filter?: { category?: string; q?: string }): Promise<AppItem[]> {
  const qs = new URLSearchParams();
  if (filter?.category && filter.category !== "all") qs.set("category", filter.category);
  if (filter?.q?.trim()) qs.set("q", filter.q.trim());
  const suffix = qs.toString();
  return swr(
    suffix ? `${CACHE_KEYS.apps}:${suffix}` : CACHE_KEYS.apps,
    () => fetchAppsRaw(suffix),
    TTL.apps,
  );
}

/** 应用列表变更(fork/导入/运行)后调用:失效全部过滤档缓存。 */
export function invalidateApps(): void {
  invalidatePrefix(CACHE_KEYS.apps);
}

async function fetchAppsRaw(suffix: string): Promise<AppItem[]> {
  const res = await apiFetch(`${API_BASE}/api/apps${suffix ? `?${suffix}` : ""}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "加载应用列表失败");
  const data = (await res.json()) as unknown;
  // 契约 {items: App[]};宽容兼容裸数组(与 listAgents 同范式)
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown[] })?.items)
      ? (data as { items: unknown[] }).items
      : [];
  return list.map(normalizeApp);
}

/** 应用详情(含 params_schema;workflow_json 仅属主/admin,前端不消费)。 */
export async function getApp(id: string): Promise<AppItem> {
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "加载应用失败");
  return normalizeApp(await res.json());
}

/** guide 字段宽容归一:单串按单行收进数组,非法项剔除。 */
function guideStrList(raw: unknown): string[] {
  const items = Array.isArray(raw) ? raw : raw == null ? [] : [raw];
  return items
    .map((x) => (typeof x === "string" ? x.trim() : ""))
    .filter((x) => x !== "");
}

/** AppGuide 归一:文本字段缺省补 "",数组字段经 guideStrList。 */
export function normalizeAppGuide(raw: unknown): AppGuide {
  const g = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");
  return {
    app_id: String(g.app_id ?? ""),
    purpose: str(g.purpose),
    when_to_use: str(g.when_to_use),
    steps: guideStrList(g.steps),
    inputs: guideStrList(g.inputs),
    outputs: guideStrList(g.outputs),
    tips: guideStrList(g.tips),
    related_app_ids: guideStrList(g.related_app_ids),
    status: str(g.status),
    updated_at: str(g.updated_at),
  };
}

/** 应用使用指南(公开,仅 published;无/draft → 404,前端静默降级为 null 不抛错)。 */
export async function getAppGuide(id: string): Promise<AppGuide | null> {
  const res = await apiFetch(
    `${API_BASE}/api/apps/${encodeURIComponent(id)}/guide`,
    { headers: authHeaders() },
  );
  if (res.status === 404) return null;
  if (!res.ok) return null; // 说明卡非关键路径:任何失败都静默降级
  return normalizeAppGuide(await res.json());
}

/** Fork 公共应用为个人副本(非内置且非本人时入口可见)。 */
export async function forkApp(id: string): Promise<AppItem> {
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "Fork 失败");
  return normalizeApp(await res.json());
}

/** 提交运行:body { values } → { job_id, prompt_id };client_id/worker 缺省补 ""(轮询兜底)。
 *  acceleration:H3 智能加速档(2026-09-12,仅 H3 家族应用;缺省 off 不带字段) */
export async function runApp(
  id: string,
  values: Record<string, unknown>,
  opts?: { content_mode?: "sfw" | "nsfw"; acceleration?: H3AccelLevel },
): Promise<AppRunReceipt> {
  const body: Record<string, unknown> = { values };
  if (opts?.content_mode) body.content_mode = opts.content_mode;
  if (opts?.acceleration && opts.acceleration !== "off") body.acceleration = opts.acceleration;
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) return raiseErr(res, "运行失败");
  // usage_count 已变,失效列表缓存(排序/计数下次拉新)
  invalidateApps();
  const data = (await res.json()) as Record<string, unknown>;
  return {
    job_id: String(data.job_id ?? ""),
    prompt_id: String(data.prompt_id ?? ""),
    client_id: String(data.client_id ?? ""),
    worker: String(data.worker ?? ""),
    acceleration: typeof data.acceleration === "string" ? (data.acceleration as H3AccelLevel) : "off",
    acceleration_applied: data.acceleration_applied === true,
  };
}

// ---------- M5 智能导入(workflow JSON → LLM 包装草稿 → 确认上架为我的应用) ----------

/**
 * 智能导入草稿:POST /api/apps/import 200 回包。
 * draft_id 短时有效(confirm 凭它取服务端草稿);warnings 为包装告警(预览页黄条展示);
 * bindings 为节点→参数绑定映射(前端预览不消费,确认时后端凭 draft_id 自取)。
 */

/** 打开应用到原生 Comfy 二次编辑:后端 api_to_ui + userdata 上传,回 workflow_name 供 Canvas ?workflow=。 */
export interface OpenInComfyResult {
  workflow_name: string;
  worker_url: string;
  load_url: string;
  app_id: string;
  node_count: number;
  save_back: string;
}

export async function openAppInComfy(id: string): Promise<OpenInComfyResult> {
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}/open-in-comfy`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "打开 Comfy 编辑失败");
  const data = (await res.json()) as Record<string, unknown>;
  return {
    workflow_name: String(data.workflow_name ?? ""),
    worker_url: String(data.worker_url ?? ""),
    load_url: String(data.load_url ?? ""),
    app_id: String(data.app_id ?? id),
    node_count: Number(data.node_count ?? 0),
    save_back: String(data.save_back ?? "not_implemented"),
  };
}

/** H3 家族应用判定(2026-09-12 智能加速,与后端 422 口径一致):
 *  id 前缀 h3-,或 workflow_json 含 MiniMaxH3/HailuoH3 家族节点。 */
export function appSupportsH3Accel(app: Pick<AppItem, "id" | "workflow_json">): boolean {
  if (app.id.startsWith("h3-")) return true;
  const wf = app.workflow_json;
  if (!wf) return false;
  return Object.values(wf).some((n) => {
    const ct = n?.class_type ?? "";
    return (
      typeof ct === "string" &&
      (ct.includes("MiniMaxH3") || ct.includes("MinimaxH3") || ct.includes("HailuoH3"))
    );
  });
}

/** 调 open-in-comfy 后跳转 /?view=canvas;失败仍跳转并写入 sessionStorage 提示(导出/手动 Load 兜底)。
 *  SPA 路由认 searchParams.view,旧 #canvas hash 会被忽略(表现为「打开工作流」无响应)。
 *  返回 { ok, error? } 供调用方 toast/ErrorBar;导航在返回前触发(页面即将卸载)。 */
export async function openAppWorkflowInComfy(
  app: Pick<AppItem, "id" | "name" | "workflow_json">,
): Promise<{ ok: boolean; error?: string }> {
  const go = () => {
    const u = new URL(window.location.href);
    u.pathname = "/";
    u.search = "";
    u.searchParams.set("view", "canvas");
    u.hash = "";
    window.location.assign(u.toString());
  };
  try {
    const res = await openAppInComfy(app.id);
    try {
      sessionStorage.setItem(
        "toiv_pending_comfy_workflow",
        JSON.stringify({
          id: app.id,
          name: app.name,
          workflow_name: res.workflow_name,
          node_count: res.node_count,
          save_back: res.save_back,
          at: Date.now(),
        }),
      );
    } catch {
      /* quota / private mode */
    }
    go();
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : "打开失败";
    const wf = app.workflow_json;
    try {
      sessionStorage.setItem(
        "toiv_pending_comfy_workflow",
        JSON.stringify({
          id: app.id,
          name: app.name,
          workflow: wf && Object.keys(wf).length ? wf : undefined,
          error: msg,
          at: Date.now(),
        }),
      );
    } catch {
      /* ignore */
    }
    go();
    return { ok: false, error: msg };
  }
}

/** description 内 RH:{digits}(与后端 provenance.extract_rh_webapp_id 同口径);无则空串。 */
const RH_WEBAPP_RE = /(?:\s*[·•|]\s*)?RH:\s*(\d+)\b/i;

export function extractRhWebappId(text: string | null | undefined): string {
  const m = RH_WEBAPP_RE.exec(text || "");
  return m ? m[1] : "";
}

/** RH webappId → 官网详情 URL(与后端 provenance.rh_webapp_url 同口径)。 */
export function rhWebappDetailUrl(webappId: string | null | undefined): string {
  const id = String(webappId ?? "").trim();
  if (!id || !/^\d+$/.test(id)) return "";
  return `https://www.runninghub.ai/ai-detail/${id}`;
}

/**
 * ComfyUI 核心/官方节点白名单(primitive):未命中视为 custom node。
 * 覆盖 nodes.py / 常见 comfy_extras + 本仓库 workflow 模板里出现的原生类名;
 * 不追求穷尽 —— 详情「节点信息」用,未知一律归自定义。
 */
export const COMFY_PRIMITIVE_TYPES: ReadonlySet<string> = new Set([
  // loaders
  "CheckpointLoader", "CheckpointLoaderSimple", "unCLIPCheckpointLoader",
  "UNETLoader", "VAELoader", "CLIPLoader", "DualCLIPLoader", "TripleCLIPLoader",
  "CLIPVisionLoader", "ControlNetLoader", "DiffControlNetLoader",
  "LoraLoader", "LoraLoaderModelOnly", "StyleModelLoader", "GLIGENLoader",
  "HypernetworkLoader", "UpscaleModelLoader", "PhotoMakerLoader",
  // conditioning / clip
  "CLIPTextEncode", "CLIPTextEncodeSDXL", "CLIPTextEncodeSDXLRefiner",
  "CLIPSetLastLayer", "CLIPVisionEncode", "unCLIPConditioning",
  "ConditioningCombine", "ConditioningAverage", "ConditioningConcat",
  "ConditioningSetArea", "ConditioningSetAreaPercentage", "ConditioningSetMask",
  "ConditioningSetTimestepRange", "ConditioningZeroOut", "ConditioningSetAreaStrength",
  "ControlNetApply", "ControlNetApplyAdvanced", "ControlNetApplySD3",
  "StyleModelApply", "GLIGENTextBoxApply",
  // latent / sample
  "EmptyLatentImage", "EmptySD3LatentImage", "EmptyHueLatentImage",
  "VAEDecode", "VAEEncode", "VAEEncodeForInpaint", "VAEDecodeTiled", "VAEEncodeTiled",
  "KSampler", "KSamplerAdvanced", "SamplerCustom", "SamplerCustomAdvanced",
  "KSamplerSelect", "BasicScheduler", "BasicGuider", "CFGGuider", "DualCFGGuider",
  "RandomNoise", "DisableNoise", "FlipSigmas", "SplitSigmas",
  "LatentUpscale", "LatentUpscaleBy", "LatentComposite", "LatentCompositeMasked",
  "LatentFromBatch", "RepeatLatentBatch", "LatentBlend", "LatentRotate", "LatentFlip",
  "LatentCrop", "SetLatentNoiseMask",
  // image I/O + ops
  "LoadImage", "LoadImageMask", "LoadImageOutput", "SaveImage", "PreviewImage",
  "ImageScale", "ImageScaleBy", "ImageScaleToTotalPixels", "ImageInvert", "ImageBatch",
  "ImagePadForOutpaint", "ImageCompositeMasked", "ImageBlend", "ImageBlur", "ImageQuantize",
  "ImageSharpen", "ImageCrop", "RepeatImageBatch", "ImageFromBatch",
  "MaskToImage", "ImageToMask", "SolidMask", "FeatherMask", "GrowMask", "InvertMask",
  "CropMask", "MaskComposite", "MaskToImage",
  // audio / video core
  "LoadAudio", "SaveAudio", "SaveAudioMP3", "PreviewAudio",
  "LoadVideo", "SaveVideo", "CreateVideo", "GetVideoComponents", "GetImageSize",
  // primitives / util / notes
  "PrimitiveNode", "Note", "Reroute", "INTConstant", "FloatConstant", "StringConstant",
  "ImpactInt", "ImpactFloat", "ImpactString",
  // LTX / common extras appearing in ToIV seeds (still "official" extras, not community packs)
  "LTXVGemmaCLIPModelLoader", "LTXVConditioning", "EmptyLTXVLatentVideo",
  "LTXVImgToVideo", "LTXVAudioVAELoader", "LTXVReferenceAudio",
  "VHS_VideoCombine", "VHS_LoadVideo", "VHS_LoadAudioUpload",
]);

export interface WorkflowNodeTypeCount {
  type: string;
  count: number;
}

export interface WorkflowNodeSummary {
  totalNodes: number;
  totalTypes: number;
  primitiveCount: number;
  customCount: number;
  primitiveTypes: WorkflowNodeTypeCount[];
  customTypes: WorkflowNodeTypeCount[];
}

/** 解析 Comfy API 图:按 class_type 计数,拆分 primitive / custom。 */
export function summarizeWorkflowNodes(
  wf: Record<string, AppWorkflowNode> | null | undefined,
): WorkflowNodeSummary {
  const counts = new Map<string, number>();
  if (wf) {
    for (const node of Object.values(wf)) {
      const t = node?.class_type?.trim();
      if (!t) continue;
      counts.set(t, (counts.get(t) ?? 0) + 1);
    }
  }
  const primitiveTypes: WorkflowNodeTypeCount[] = [];
  const customTypes: WorkflowNodeTypeCount[] = [];
  let primitiveCount = 0;
  let customCount = 0;
  for (const [type, count] of [...counts.entries()].sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    const row = { type, count };
    if (COMFY_PRIMITIVE_TYPES.has(type)) {
      primitiveTypes.push(row);
      primitiveCount += count;
    } else {
      customTypes.push(row);
      customCount += count;
    }
  }
  return {
    totalNodes: primitiveCount + customCount,
    totalTypes: counts.size,
    primitiveCount,
    customCount,
    primitiveTypes,
    customTypes,
  };
}


export interface AppImportDraft {
  draft_id: string;
  name: string;
  description: string;
  icon: string;
  category: AppCategory;
  output_kind: AppOutputKind;
  params_schema: AppParam[];
  bindings: Record<string, unknown>;
  warnings: string[];
}

/** confirm 可改元数据(契约:仅名称/描述/图标/分类四个键)。 */
export interface AppImportOverrides {
  name?: string;
  description?: string;
  icon?: string;
  category?: AppCategory;
}

/** 草稿归一:params 复用 normalizeParam;category/output_kind 同 normalizeApp 兜底;warnings 只收非空字符串。 */
export function normalizeImportDraft(raw: unknown): AppImportDraft {
  const d = (raw ?? {}) as Record<string, unknown>;
  const category = CATEGORIES.includes(d.category as AppCategory)
    ? (d.category as AppCategory)
    : "other";
  const outputKind = (["image", "video", "audio"] as const).includes(
    d.output_kind as AppOutputKind,
  )
    ? (d.output_kind as AppOutputKind)
    : "image";
  return {
    draft_id: String(d.draft_id ?? ""),
    name: String(d.name ?? ""),
    description: String(d.description ?? ""),
    icon: String(d.icon ?? "package"),
    category,
    params_schema: Array.isArray(d.params_schema) ? d.params_schema.map(normalizeParam) : [],
    output_kind: outputKind,
    bindings:
      typeof d.bindings === "object" && d.bindings !== null && !Array.isArray(d.bindings)
        ? (d.bindings as Record<string, unknown>)
        : {},
    warnings: Array.isArray(d.warnings)
      ? d.warnings.filter((w): w is string => typeof w === "string" && w.trim() !== "")
      : [],
  };
}

/**
 * 智能导入第一步:提交工作流 JSON → LLM 包装草稿(限流 60s/5)。
 * LLM 调用 10-30s,走 longRequest(180s)超时档;503(AI 包装服务不可用)/429(限流)
 * 优先透出后端 detail,否则给固定中文文案(Modal 错误分支直接展示 + 重试)。
 */
export async function importWorkflow(workflow: unknown): Promise<AppImportDraft> {
  const res = await apiFetch(
    `${API_BASE}/api/apps/import`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ workflow }),
    },
    { longRequest: true },
  );
  if (res.status === 503 || res.status === 429) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    const fallback =
      res.status === 503
        ? "AI 包装服务暂不可用,请稍后重试 (503)"
        : "操作过于频繁:智能导入每分钟限 5 次,请稍后再试 (429)";
    throw new Error(apiErrorMessage(detail?.detail, fallback, res.status));
  }
  if (!res.ok) return raiseErr(res, "智能导入失败");
  return normalizeImportDraft(await res.json());
}

/**
 * 智能导入第二步:确认草稿上架 → 个人应用(AppItem,is_mine=true)。
 * 草稿过期/不存在 404;overrides 为空/无键时不上送该键(契约 overrides 可选)。
 */
export async function confirmImport(
  draftId: string,
  overrides?: AppImportOverrides,
): Promise<AppItem> {
  const body: Record<string, unknown> = { draft_id: draftId };
  if (overrides && Object.keys(overrides).length > 0) body.overrides = overrides;
  const res = await apiFetch(`${API_BASE}/api/apps/import/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(body),
  });
  if (!res.ok) return raiseErr(res, "确认上架失败");
  invalidateApps();
  return normalizeApp(await res.json());
}

/**
 * confirm overrides 构建:仅收集与草稿值不同的可改键(名称/描述/图标/分类),
 * 空白串视为未改(防手滑清空);无差异返回 undefined(confirm 不带 overrides 键)。
 */
export function buildImportOverrides(
  draft: AppImportDraft,
  edits: AppImportOverrides,
): AppImportOverrides | undefined {
  const out: Record<string, string> = {};
  for (const k of ["name", "description", "icon", "category"] as const) {
    const v = edits[k];
    if (typeof v === "string" && v.trim() !== "" && v !== draft[k]) out[k] = v;
  }
  return Object.keys(out).length > 0 ? (out as AppImportOverrides) : undefined;
}

// ---------- 纯函数 helpers(视图与单测共用) ----------

/** 上传类参数(images/audio/video):表单存句柄对象,提交抽 filename 数组。 */
const MEDIA_PARAM_TYPES: ReadonlySet<AppParamType> = new Set(["images", "audio", "video"]);

/** RH 封面/示例 CDN URL 作 images default 时的标记:仅预览,不可当 worker 文件名提交。 */
export function isRemoteDemoMedia(filename: string): boolean {
  return /^https?:\/\//i.test(String(filename || "").trim());
}

export interface MediaFilenamesOpts {
  /** 是否保留 http(s) 示例 URL;提交/必填校验应 false。默认 true 兼容旧调用。 */
  includeRemoteDemo?: boolean;
}

/**
 * 媒体表单值 → 非空文件名数组。兼容 string / string[] / {filename}[](ParamField 句柄)。
 * 复合对象不得原样进载荷(后端 _as_filenames 会 422)。
 */
export function mediaFilenames(value: unknown, opts: MediaFilenamesOpts = {}): string[] {
  const includeRemoteDemo = opts.includeRemoteDemo !== false;
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const f = item.trim();
      if (!f) continue;
      if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
      out.push(f);
    } else if (item && typeof item === "object" && "filename" in item) {
      const f = String((item as { filename: unknown }).filename ?? "").trim();
      if (!f) continue;
      if (!includeRemoteDemo && isRemoteDemoMedia(f)) continue;
      out.push(f);
    }
  }
  return out;
}

/** schema default → 可预览的媒体句柄(远程 demo URL 补 previewUrl)。 */
export function normalizeMediaDefault(raw: unknown): unknown[] {
  if (raw == null || raw === "") return [];
  const items = Array.isArray(raw) ? raw : [raw];
  const out: unknown[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      const f = item.trim();
      if (!f) continue;
      out.push({
        filename: f,
        previewUrl: isRemoteDemoMedia(f) ? f : "",
        name: isRemoteDemoMedia(f) ? "示例参考图" : f,
        worker: "",
      });
      continue;
    }
    if (item && typeof item === "object") {
      const h = item as { filename?: unknown; previewUrl?: unknown; name?: unknown; worker?: unknown };
      const f = String(h.filename ?? "").trim();
      if (!f) continue;
      const preview = String(h.previewUrl ?? "").trim() || (isRemoteDemoMedia(f) ? f : "");
      out.push({
        ...h,
        filename: f,
        previewUrl: preview,
        name: String(h.name ?? "").trim() || (isRemoteDemoMedia(f) ? "示例参考图" : f),
        worker: typeof h.worker === "string" ? h.worker : "",
      });
    }
  }
  return out;
}

/** 打开应用时的表单初值:优先 schema.default;媒体空 default → []。 */
export function schemaInitialValues(schema: AppParam[]): Record<string, unknown> {
  const v: Record<string, unknown> = {};
  for (const p of schema) {
    if (MEDIA_PARAM_TYPES.has(p.type)) {
      const norm = normalizeMediaDefault(p.default);
      v[p.key] = norm.length > 0 ? norm : [];
    } else {
      v[p.key] = p.default ?? (p.type === "switch" ? false : "");
    }
  }
  return v;
}

/**
 * 应用运行页上传 kind:与 GenerateView 同口径,走 POST /api/upload?kind=。
 * 专用引擎 kind(h3_i2v / wan_animate / wan_animate2 / avatar)由 API 直传到
 * :8195/:8197/:8199,与 /api/apps/{id}/run 同机;RH 卡仍常走 img2img,由服务端 /run 转运兜底。
 */
export function appUploadKind(appId: string): string {
  if (appId.startsWith("h3-")) return "h3_i2v";
  if (appId.startsWith("wan-animate-2")) return "wan_animate2";
  if (appId.startsWith("wan-animate")) return "wan_animate";
  if (appId === "wan-vace" || appId === "vace-edit" || appId === "wan-transition") return "wan_vace";
  if (appId.startsWith("longcat-") || appId.startsWith("phantom-") || appId.startsWith("ovi-")) return "avatar";
  if (appId.startsWith("avatar")) return "avatar";
  if (appId.startsWith("ltx")) return appId.includes("lipsync") ? "ltx_lipsync" : "ltx_i2v";
  return "img2img";
}

/** 已上传句柄里的首个非空 worker(多槽互钉)。 */
export function firstPinWorker(values: Record<string, unknown>): string | null {
  for (const v of Object.values(values)) {
    const items = Array.isArray(v) ? v : v != null ? [v] : [];
    for (const item of items) {
      if (item && typeof item === "object" && typeof (item as { worker?: unknown }).worker === "string") {
        const w = (item as { worker: string }).worker.trim();
        if (w) return w;
      }
    }
  }
  return null;
}

/**
 * 提交载荷构建:按参数类型归一 values。
 * - number:原始字符串(允许中间态)在此 parse;空串/非法 → 省略该键(后端落 default);
 * - switch:Boolean 归一;
 * - images/audio/video:抽 filename 数组原样透传(勿 String 化成 "a,b",勿把句柄对象塞进去);
 * - 其余(text/textarea/select):String 归一。
 */
export function buildRunValues(
  schema: AppParam[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of schema) {
    const v = values[p.key];
    if (p.type === "number") {
      if (typeof v === "number" && Number.isFinite(v)) {
        out[p.key] = v;
        continue;
      }
      const raw = String(v ?? "").trim();
      if (!raw) continue; // 留空 = 后端默认值
      const n = Number(raw);
      if (Number.isFinite(n)) out[p.key] = n;
      continue;
    }
    if (p.type === "switch") {
      out[p.key] = Boolean(v);
      continue;
    }
    if (MEDIA_PARAM_TYPES.has(p.type)) {
      out[p.key] = mediaFilenames(v, { includeRemoteDemo: false });
      continue;
    }
    // 其它数组(历史兼容)原样透传,勿 String 化成 "a,b"
    if (Array.isArray(v)) {
      out[p.key] = v;
      continue;
    }
    out[p.key] = String(v ?? "");
  }
  return out;
}

/**
 * 必填缺口:default 为 null/undefined 的参数视为必填(无后端默认值可落),
 * 当前值为空(null/空白串)时返回其 label(提交按钮禁用原因);无缺口返回 null。
 * switch 恒有布尔态,永不为必填缺口。
 */
export function requiredParamLabel(
  schema: AppParam[],
  values: Record<string, unknown>,
): string | null {
  for (const p of schema) {
    if (p.type === "switch") continue;
    if (p.required === false) continue; // 可选参考视频/音频
    const v = values[p.key];
    // 媒体:http(s) 示例图仅预览,不算已上传;永不因 default 跳过必填
    if (MEDIA_PARAM_TYPES.has(p.type)) {
      if (mediaFilenames(v, { includeRemoteDemo: false }).length === 0) return p.label;
      continue;
    }
    if (p.default != null) continue;
    if (v == null || String(v).trim() === "") return p.label;
  }
  return null;
}

export interface AppFilterOpts {
  /** 搜索词(名称/描述/指南用途包含,不区分大小写) */
  q?: string;
  /** 分类;"all"/空 = 不过滤 */
  category?: string;
  /** R18 模式:on 才放行 is_nsfw 应用(NSFW 客户端过滤) */
  r18?: boolean;
  /** 产物类型;"all"/空 = 不过滤(图片/视频创作页按 output_kind 收窄) */
  outputKind?: string;
  /** 用途分类(USE_CASES id);"all"/空 = 不过滤(2026-09-12 市场策展层) */
  useCase?: string;
}

/** 客户端过滤:搜索 + 分类 + 用途 + 产物类型 + NSFW(r18 off 时 is_nsfw 应用整卡隐藏)。 */
export function filterApps(apps: AppItem[], opts: AppFilterOpts = {}): AppItem[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const category = opts.category ?? "all";
  const outputKind = opts.outputKind ?? "all";
  const useCase = opts.useCase ?? "all";
  return apps.filter((a) => {
    if (a.is_nsfw && !opts.r18) return false;
    if (category !== "all" && a.category !== category) return false;
    if (outputKind !== "all" && a.output_kind !== outputKind) return false;
    if (useCase !== "all" && a.use_case !== useCase) return false;
    if (
      q &&
      !`${a.name}\n${a.description}\n${a.guide_purpose ?? ""}`.toLowerCase().includes(q)
    )
      return false;
    return true;
  });
}

export interface UseCaseSummaryItem {
  id: string;
  label: string;
  count: number;
}

/**
 * 用途分类计数(GET /api/apps/use-cases/summary,后端已按可见性+NSFW 门控统计)。
 * 市场策展层 chips 计数用;非关键路径:404/非 2xx/解析失败一律静默降级为 []。
 */
export async function fetchUseCaseSummary(): Promise<UseCaseSummaryItem[]> {
  const res = await apiFetch(`${API_BASE}/api/apps/use-cases/summary`, {
    headers: authHeaders(),
  }).catch(() => null);
  if (!res || !res.ok) return [];
  const data = (await res.json().catch(() => null)) as unknown;
  const list = Array.isArray(data)
    ? data
    : Array.isArray((data as { items?: unknown[] } | null)?.items)
      ? (data as { items: unknown[] }).items
      : [];
  const out: UseCaseSummaryItem[] = [];
  for (const item of list) {
    const o = (item ?? {}) as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id.trim() : "";
    if (!id) continue;
    out.push({
      id,
      label:
        typeof o.label === "string" && o.label.trim()
          ? o.label.trim()
          : (useCaseLabel(id) ?? id),
      count: Math.max(0, numOf(o.count, 0)),
    });
  }
  return out;
}

export interface AppSections {
  /** 内置核心(is_builtin 且非本人且 id 不以 rh- 开头) */
  builtin: AppItem[];
  /** RunningHub 社区卡(id 以 rh- 开头,非本人) */
  community: AppItem[];
  pub: AppItem[];
  mine: AppItem[];
}

export function isRhCommunityId(id: string): boolean {
  return id.startsWith("rh-");
}

/** 四区划分:核心内置 / RunningHub 社区(rh-*) / 公共 / 我的(is_mine 优先)。 */
export function splitAppSections(apps: AppItem[]): AppSections {
  const mine = apps.filter((a) => a.is_mine);
  const community = apps.filter((a) => !a.is_mine && isRhCommunityId(a.id));
  const builtin = apps.filter((a) => a.is_builtin && !a.is_mine && !isRhCommunityId(a.id));
  const pub = apps.filter((a) => a.is_public && !a.is_builtin && !a.is_mine && !isRhCommunityId(a.id));
  return { builtin, community, pub, mine };
}

/** RunningHub 社区卡 description 前缀(第一个「 · 」之前)对应的 family 铭牌。 */
export const RH_FAMILY_LABELS = [
  "场景预设",
  "全能参考",
  "首尾帧",
  "图生视频",
  "文生视频",
  "声音参考",
  "角色替换",
  "参考视频",
  "时间静止",
  "画质放大",
  "多镜头",
  "图像编辑",
  "图生加速",
  "文生加速",
] as const;

export function rhFamilyOf(app: AppItem): string {
  const desc = app.description ?? "";
  const i = desc.indexOf(" · ");
  return (i >= 0 ? desc.slice(0, i) : desc).trim();
}

/** 社区卡 family chips:正典顺序优先,未见过的前缀按字母序垫后。 */
export function rhFamilyChips(apps: AppItem[]): string[] {
  const present = new Set<string>();
  for (const a of apps) {
    const f = rhFamilyOf(a);
    if (f) present.add(f);
  }
  const canon = RH_FAMILY_LABELS.filter((l) => present.has(l));
  const extras = [...present].filter((l) => !(RH_FAMILY_LABELS as readonly string[]).includes(l)).sort();
  return [...canon, ...extras];
}

export const COMMUNITY_PAGE_SIZE = 10;
export const COMMUNITY_SEARCH_CAP = 120;

export interface CommunitySlice {
  items: AppItem[];
  matched: number;
  truncated: boolean;
  hasMore: boolean;
}

/**
 * 社区卡分页:
 * - 无搜索且无 family:先展示 shown 张(默认 10),hasMore 供无限滚动哨兵小步 +10;
 * - 有搜索或选了 family:展示匹配(上限 120),超出 truncated。
 */
export function sliceCommunityApps(
  apps: AppItem[],
  opts: { q?: string; family?: string; shown: number },
): CommunitySlice {
  const q = (opts.q ?? "").trim();
  const family = (opts.family ?? "").trim();
  const filtered = family ? apps.filter((a) => rhFamilyOf(a) === family) : apps;
  const narrowed = q !== "" || family !== "";
  if (narrowed) {
    return {
      items: filtered.slice(0, COMMUNITY_SEARCH_CAP),
      matched: filtered.length,
      truncated: filtered.length > COMMUNITY_SEARCH_CAP,
      hasMore: false,
    };
  }
  const shown = Math.max(COMMUNITY_PAGE_SIZE, opts.shown);
  return {
    items: filtered.slice(0, shown),
    matched: filtered.length,
    truncated: false,
    hasMore: shown < filtered.length,
  };
}

/** 分类中文短名(卡片徽标 / 筛选 chips 共用)。 */
export const APP_CATEGORY_LABEL: Record<AppCategory, string> = {
  image: "图片",
  video: "视频",
  audio: "音频",
  edit: "编辑",
  "3d": "3D",
  other: "其他",
};

export function appCategoryLabel(c: AppCategory): string {
  return APP_CATEGORY_LABEL[c] ?? c;
}

/** 视频创作页精选:H3 核心四件套置顶,其后 15s 加速/声音参考。
 *  R18 孪生已并入 SFW 同卡(content_modes),不再单独置顶。不含 rh-* 社区卡。 */
export const FEATURED_VIDEO_APP_IDS: readonly string[] = [
  "h3-t2v",
  "h3-i2v",
  "h3-fl2v",
  "h3-r2v",
  "h3-t2v-15s-fast",
  "h3-i2v-15s-fast",
  "h3-r2v-voice",
];

/** 创作页按产物类型取精选 id;非视频暂无精选(保持后端 sort)。 */
export function featuredAppIdsForKind(kind: AppOutputKind): readonly string[] | undefined {
  return kind === "video" ? FEATURED_VIDEO_APP_IDS : undefined;
}

/** 精选 id 按给定顺序置顶;其余保持相对顺序(稳定排序)。无 featuredIds 原样返回。 */
export function sortFeaturedApps(apps: AppItem[], featuredIds?: readonly string[]): AppItem[] {
  if (!featuredIds?.length) return apps;
  const rank = new Map(featuredIds.map((id, i) => [id, i]));
  return [...apps].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0;
  });
}

// ---------- RunningHub 化(2026-09-06):封面/作者兜底 + 参数分组 ----------

/** 作者显示名:后端 author 可空,空兜底「ToIV」。 */
export function appAuthorOf(a: Pick<AppItem, "author">): string {
  return a.author ?? "ToIV";
}

/** 作者头像首字符(圆形首字母头像):取首个非空字符,中文/字母通用。 */
export function appAuthorInitial(a: Pick<AppItem, "author">): string {
  return (appAuthorOf(a).trim()[0] ?? "T").toUpperCase();
}

export interface AppParamGroup {
  key: "media" | "prompt" | "gen";
  label: string;
  params: AppParam[];
}

/**
 * 详情页左列参数分组(schema 无 group 字段,按类型启发式归三档,固定顺序):
 * 素材上传(images/audio/video)→ 提示词(text/textarea)→ 生成参数(number/select/switch);
 * 空组不返回(视图据此不渲染空分区)。
 */
export function groupAppParams(schema: AppParam[]): AppParamGroup[] {
  const media: AppParam[] = [];
  const prompt: AppParam[] = [];
  const gen: AppParam[] = [];
  for (const p of schema) {
    if (MEDIA_PARAM_TYPES.has(p.type)) media.push(p);
    else if (p.type === "text" || p.type === "textarea") prompt.push(p);
    else gen.push(p);
  }
  const groups: AppParamGroup[] = [];
  if (media.length) groups.push({ key: "media", label: "素材上传", params: media });
  if (prompt.length) groups.push({ key: "prompt", label: "提示词", params: prompt });
  if (gen.length) groups.push({ key: "gen", label: "生成参数", params: gen });
  return groups;
}

/** 市场排序:热门 = usage_count 降序(同用量按 name 稳定),默认保持原相对序。 */
export type AppMarketSort = "default" | "hot";

export function sortAppsHot(apps: AppItem[]): AppItem[] {
  return [...apps].sort((a, b) => {
    if (b.usage_count !== a.usage_count) return b.usage_count - a.usage_count;
    return a.name.localeCompare(b.name, "zh");
  });
}

/**
 * 占位封面的瀑布流高度档(无 cover_url 时):按 id 散列取 4 档宽高比,
 * 让纯占位市场也呈现错落瀑布流,而非一刀切等高。返回 CSS aspect-ratio 值。
 */
export function placeholderAspect(id: string): string {
  const ARS = ["1 / 1", "4 / 5", "3 / 4", "5 / 4"] as const;
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) >>> 0;
  return ARS[h % ARS.length];
}
