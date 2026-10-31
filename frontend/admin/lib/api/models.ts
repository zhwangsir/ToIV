import { apiFetch, authHeaders, isNsfwIntent, raiseApiError } from "./http";
import { CACHE_KEYS, TTL, invalidate, swr } from "../swr-cache";
import type { LocalModels } from "../types";

async function fetchLocalModelsRaw(): Promise<LocalModels> {
  const res = await apiFetch(`/api/models/local`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载本地模型失败 (${res.status})`);
  return res.json();
}

/** 本地已装模型,走本机 SWR 缓存(中 TTL):减重复请求,偶有安装由 TTL 兜底刷新。 */
export function listLocalModels(): Promise<LocalModels> {
  return swr(isNsfwIntent() ? `${CACHE_KEYS.localModels}:nsfw` : CACHE_KEYS.localModels, fetchLocalModelsRaw, TTL.localModels);
}

export interface ModelWikiCard {
  id: string;
  filename: string;
  model_type: string;
  label: string;
  base_model: string;
  description: string;
  usage: string;
  prompt_dialect: string;
  trigger_words: string[];
  negative_hint: string;
  tags: string[];
  creator: string;
  license: string;
  civitai_url: string;
  /** HuggingFace 模型卡 URL(仅 admin 非空;curated/引擎源)。 */
  huggingface_url?: string;
  downloads: number;
  nsfw: boolean;
  sources: string[];
  enriched: boolean;
  has_detail: boolean;
}

export async function listModelWiki(params?: { type?: string; q?: string }): Promise<ModelWikiCard[]> {
  const qs = new URLSearchParams();
  if (params?.type) qs.set("type", params.type);
  if (params?.q) qs.set("q", params.q);
  const suffix = qs.toString() ? `?${qs.toString()}` : "";
  const res = await apiFetch(`/api/models/wiki${suffix}`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "加载模型百科失败");
  const data = (await res.json()) as { cards: ModelWikiCard[] };
  return data.cards ?? [];
}

export async function enrichModelWiki(opts?: {
  force?: boolean;
  max?: number;
  targets?: [string, string][];
}): Promise<{ enriched: number; skipped: number; failed: number }> {
  // longRequest(180s):逐条查 civitai + 1.2s 限速,max=40 约 60-120s,默认 30s 必超
  const res = await apiFetch("/api/models/wiki/enrich", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      force: opts?.force ?? false,
      max: opts?.max ?? 40,
      ...(opts?.targets?.length ? { targets: opts.targets } : {}),
    }),
  }, { longRequest: true });
  if (!res.ok) await raiseApiError(res, "富化失败");
  return res.json();
}

/** 引擎注册表条目(/api/models/engines;params schema 本域不展开,原样保留)。 */
export interface EngineInfo {
  id: string;
  label: string;
  kind: string;
  available: boolean;
  unavailable_reason?: string | null;
  nsfw?: boolean;
  description?: string;
  params?: unknown[];
}

export interface EnginesResponse {
  engines: EngineInfo[];
  count: number;
}

async function fetchEnginesRaw(): Promise<EnginesResponse> {
  const res = await apiFetch(`/api/models/engines`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`加载引擎注册表失败 (${res.status})`);
  return res.json();
}

/** 引擎注册表(含实时可用性),走本机 SWR 缓存(短 TTL,探测结果 60s 刷新)。 */
export function fetchEngines(): Promise<EnginesResponse> {
  return swr(CACHE_KEYS.engines, fetchEnginesRaw, TTL.engines);
}

/** 强制重探测(清后端可用性缓存);成功后失效本地缓存让下次读取拿到新结果。 */
export async function refreshEngines(): Promise<EnginesResponse> {
  // longRequest(180s):全引擎并行重探测,worker 挂起时远超 30s 默认超时
  const res = await apiFetch(`/api/models/engines/refresh`, {
    method: "POST",
    headers: authHeaders(),
  }, { longRequest: true });
  if (!res.ok) await raiseApiError(res, "引擎重探测失败");
  invalidate(CACHE_KEYS.engines);
  return res.json();
}

/** 模型出处清单条目(MODEL_SOURCES 快照行;status null=未判定)。 */
export interface ModelSourceItem {
  basename: string;
  rel_path: string | null;
  source_kind: string;
  source_url: string | null;
  repo: string | null;
  revision: string | null;
  filename: string | null;
  license_or_gated: string | null;
  downloaded_at: string | null;
  status: "ok" | "blocked" | null;
  bytes: number | null;
  notes: string | null;
  batch: string | null;
}

export interface ModelSourcesResponse {
  updated_at: string | null;
  totals: { ok?: number; blocked?: number; total?: number } & Record<string, unknown>;
  sources_scanned: string[];
  items: ModelSourceItem[];
}

/** 模型出处清单(admin,只读静态快照;404=未部署)。 */
export async function fetchModelSources(): Promise<ModelSourcesResponse> {
  const res = await apiFetch(`/api/admin/model-sources`, { headers: authHeaders() });
  if (!res.ok) await raiseApiError(res, "模型出处清单加载失败");
  return res.json();
}
