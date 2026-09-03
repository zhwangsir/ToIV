import { API_BASE, apiFetch, authHeaders, apiErrorMessage } from "./api";
import { CACHE_KEYS, TTL, invalidatePrefix, swr } from "./swr-cache";

/**
 * 应用市场(M3)前端 API client + 类型。
 *
 * 后端契约(并行开发中,以此为准):
 *   GET  /api/apps?category=&q=   → { items: App[] }(slim:params_schema=[] bindings={} required_nodes=[])
 *   GET  /api/apps/{id}           → App(完整 params_schema/bindings/workflow_json;运行页必须走详情)
 *   POST /api/apps/{id}/fork      → 个人副本(App)
 *   POST /api/apps/{id}/run       → body { values } → { job_id, prompt_id }
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
  is_public: boolean;
  is_mine: boolean;
  usage_count: number;
  sort: number;
}

/** 运行提交回执:契约保证 job_id/prompt_id;client_id/worker 后端给则透传(SSE 用)。 */
export interface AppRunReceipt {
  job_id: string;
  prompt_id: string;
  client_id: string;
  worker: string;
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
    is_public: boolOf(a.is_public),
    is_mine: boolOf(a.is_mine),
    usage_count: numOf(a.usage_count, 0),
    sort: numOf(a.sort, 100),
  };
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

/** Fork 公共应用为个人副本(非内置且非本人时入口可见)。 */
export async function forkApp(id: string): Promise<AppItem> {
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}/fork`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) return raiseErr(res, "Fork 失败");
  return normalizeApp(await res.json());
}

/** 提交运行:body { values } → { job_id, prompt_id };client_id/worker 缺省补 ""(轮询兜底)。 */
export async function runApp(
  id: string,
  values: Record<string, unknown>,
): Promise<AppRunReceipt> {
  const res = await apiFetch(`${API_BASE}/api/apps/${encodeURIComponent(id)}/run`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ values }),
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
  };
}

// ---------- M5 智能导入(workflow JSON → LLM 包装草稿 → 确认上架为我的应用) ----------

/**
 * 智能导入草稿:POST /api/apps/import 200 回包。
 * draft_id 短时有效(confirm 凭它取服务端草稿);warnings 为包装告警(预览页黄条展示);
 * bindings 为节点→参数绑定映射(前端预览不消费,确认时后端凭 draft_id 自取)。
 */
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

/**
 * 媒体表单值 → 非空文件名数组。兼容 string / string[] / {filename}[](ParamField 句柄)。
 * 复合对象不得原样进载荷(后端 _as_filenames 会 422)。
 */
export function mediaFilenames(value: unknown): string[] {
  if (value == null || value === "") return [];
  const items = Array.isArray(value) ? value : [value];
  const out: string[] = [];
  for (const item of items) {
    if (typeof item === "string") {
      if (item.trim()) out.push(item.trim());
    } else if (item && typeof item === "object" && "filename" in item) {
      const f = String((item as { filename: unknown }).filename ?? "").trim();
      if (f) out.push(f);
    }
  }
  return out;
}

/**
 * 应用运行页上传 kind:与 GenerateView 同口径,走 POST /api/upload?kind=。
 * h3 先落 pool worker(required_models 空);img2img 落到文生图机。
 */
export function appUploadKind(appId: string): string {
  if (appId.startsWith("h3-")) return "h3_i2v";
  if (appId.startsWith("wan-animate-2")) return "wan_animate2";
  if (appId.startsWith("wan-animate")) return "wan_animate";
  if (appId === "wan-vace" || appId === "vace-edit" || appId === "wan-transition") return "wan_vace";
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
      out[p.key] = mediaFilenames(v);
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
    if (p.default != null) continue;
    const v = values[p.key];
    if (MEDIA_PARAM_TYPES.has(p.type)) {
      if (mediaFilenames(v).length === 0) return p.label;
      continue;
    }
    if (v == null || String(v).trim() === "") return p.label;
  }
  return null;
}

export interface AppFilterOpts {
  /** 搜索词(名称/描述包含,不区分大小写) */
  q?: string;
  /** 分类;"all"/空 = 不过滤 */
  category?: string;
  /** R18 模式:on 才放行 is_nsfw 应用(NSFW 客户端过滤) */
  r18?: boolean;
  /** 产物类型;"all"/空 = 不过滤(图片/视频创作页按 output_kind 收窄) */
  outputKind?: string;
}

/** 客户端过滤:搜索 + 分类 + 产物类型 + NSFW(r18 off 时 is_nsfw 应用整卡隐藏)。 */
export function filterApps(apps: AppItem[], opts: AppFilterOpts = {}): AppItem[] {
  const q = (opts.q ?? "").trim().toLowerCase();
  const category = opts.category ?? "all";
  const outputKind = opts.outputKind ?? "all";
  return apps.filter((a) => {
    if (a.is_nsfw && !opts.r18) return false;
    if (category !== "all" && a.category !== category) return false;
    if (outputKind !== "all" && a.output_kind !== outputKind) return false;
    if (q && !`${a.name}\n${a.description}`.toLowerCase().includes(q)) return false;
    return true;
  });
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

export const COMMUNITY_PAGE_SIZE = 24;
export const COMMUNITY_SEARCH_CAP = 120;

export interface CommunitySlice {
  items: AppItem[];
  matched: number;
  truncated: boolean;
  hasMore: boolean;
}

/**
 * 社区卡分页:
 * - 无搜索且无 family:先展示 shown 张(默认 24),hasMore 供「显示更多」+24;
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

/** 视频创作页精选:H3 核心四件套置顶,其后 15s 加速/声音参考;NSFW 孪生在 r18 on 时由 filterApps 放行后同样置顶。
 *  不含 rh-* 社区卡(社区区单独分页,不进精选)。 */
export const FEATURED_VIDEO_APP_IDS: readonly string[] = [
  "h3-t2v",
  "h3-i2v",
  "h3-fl2v",
  "h3-r2v",
  "h3-t2v-15s-fast",
  "h3-i2v-15s-fast",
  "h3-r2v-voice",
  "h3-nsfw-t2v",
  "h3-nsfw-i2v",
  "h3-nsfw-fl2v",
  "h3-nsfw-r2v",
  "h3-nsfw-t2v-15s-fast",
  "h3-nsfw-i2v-15s-fast",
  "h3-nsfw-r2v-voice",
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
