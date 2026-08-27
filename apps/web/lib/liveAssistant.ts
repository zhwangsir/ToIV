/**
 * 直播助手(数字人 M5)API 封装 —— 契约 routes/live_assistant.py(全部 Bearer 鉴权)。
 *
 * - 知识库 CRUD:GET/POST /api/live/kb、PATCH/DELETE /api/live/kb/{id}
 * - 违禁词:GET/POST /api/live/banned、DELETE /api/live/banned/{id}
 * - 互动摄入:POST /api/live/ingest → 事件(违禁词拦截 → KB 匹配 → LLM 兜底 → 播报)
 * - 会话管理:POST /api/live/session/start|stop、GET /api/live/session/status(用户级单例)
 * - 互动历史:GET /api/live/events?limit=N(新→旧)
 *
 * 纯数据层,组件无关;状态徽标映射(LIVE_EVENT_STATUS_META)为展示单一事实源,
 * 组件与测试共用,避免各处硬编码 tone。
 */
import { apiFetch, authHeaders } from "./api";

// ---------- 类型(与后端 response_model 对齐) ----------

export interface LiveKB {
  id: string;
  trigger_words: string[];
  reply_type: "text" | "video";
  reply_text: string;
  reply_asset_url: string;
  priority: number;
  enabled: boolean;
  created_at?: string;
  updated_at?: string;
}

export interface LiveKBCreate {
  trigger_words: string[];
  reply_type: "text" | "video";
  reply_text: string;
  reply_asset_url: string;
  priority: number;
  enabled: boolean;
}

export interface LiveBannedWord {
  id: string;
  word: string;
  created_at?: string;
}

export type LiveEventStatus = "banned" | "replied" | "no_session" | "spoken" | "speak_failed";

export interface LiveEvent {
  id: string;
  source: string;
  author: string;
  text: string;
  matched_kb_id: string | null;
  reply_text: string;
  reply_type: string;
  status: string;
  created_at: string;
}

export interface LiveSessionStatus {
  active: boolean;
  session_id: string | null;
}

// ---------- 事件状态徽标(展示单一事实源) ----------
// spoken 绿 / speak_failed 红 / banned 灰 / replied 蓝 / no_session 黄;未知态按 replied 兜底。
export const LIVE_EVENT_STATUS_META: Record<LiveEventStatus, { label: string; tone: "ok" | "err" | "neutral" | "accent" | "warn" }> = {
  spoken: { label: "已播报", tone: "ok" },
  speak_failed: { label: "播报失败", tone: "err" },
  banned: { label: "已拦截", tone: "neutral" },
  replied: { label: "已回复", tone: "accent" },
  no_session: { label: "未开播", tone: "warn" },
};

export function liveEventStatusMeta(status: string): { label: string; tone: "ok" | "err" | "neutral" | "accent" | "warn" } {
  return LIVE_EVENT_STATUS_META[status as LiveEventStatus] ?? { label: status || "未知", tone: "neutral" };
}

// ---------- 内部统一请求 ----------

async function req<T>(path: string, init?: RequestInit, fallback = "直播助手请求失败"): Promise<T> {
  const res = await apiFetch(path, {
    ...init,
    headers: { "Content-Type": "application/json", ...authHeaders(), ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
    throw new Error(typeof detail?.detail === "string" ? detail.detail : `${fallback} (${res.status})`);
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

// ---------- 知识库 ----------

export async function listLiveKB(): Promise<LiveKB[]> {
  return req<LiveKB[]>("/api/live/kb", undefined, "知识库加载失败");
}

export async function createLiveKB(body: LiveKBCreate): Promise<LiveKB> {
  return req<LiveKB>("/api/live/kb", { method: "POST", body: JSON.stringify(body) }, "知识库创建失败");
}

export async function patchLiveKB(id: string, patch: Partial<LiveKBCreate>): Promise<LiveKB> {
  return req<LiveKB>(`/api/live/kb/${encodeURIComponent(id)}`, { method: "PATCH", body: JSON.stringify(patch) }, "知识库更新失败");
}

export async function deleteLiveKB(id: string): Promise<void> {
  return req<void>(`/api/live/kb/${encodeURIComponent(id)}`, { method: "DELETE" }, "知识库删除失败");
}

// ---------- 违禁词 ----------

export async function listLiveBanned(): Promise<LiveBannedWord[]> {
  return req<LiveBannedWord[]>("/api/live/banned", undefined, "违禁词加载失败");
}

export async function createLiveBanned(word: string): Promise<LiveBannedWord> {
  return req<LiveBannedWord>("/api/live/banned", { method: "POST", body: JSON.stringify({ word }) }, "违禁词添加失败");
}

export async function deleteLiveBanned(id: string): Promise<void> {
  return req<void>(`/api/live/banned/${encodeURIComponent(id)}`, { method: "DELETE" }, "违禁词删除失败");
}

// ---------- 互动摄入 / 历史 ----------

export async function ingestLive(input: { text: string; author?: string }): Promise<LiveEvent> {
  return req<LiveEvent>(
    "/api/live/ingest",
    { method: "POST", body: JSON.stringify({ text: input.text, author: input.author ?? "", source: "manual" }) },
    "互动摄入失败",
  );
}

export async function listLiveEvents(limit = 50): Promise<LiveEvent[]> {
  return req<LiveEvent[]>(`/api/live/events?limit=${Math.max(1, Math.min(200, Math.round(limit)))}`, undefined, "互动历史加载失败");
}

// ---------- 会话管理 ----------

export async function startLiveSession(input: { avatar_image: string; avatar_worker: string }): Promise<LiveSessionStatus> {
  return req<LiveSessionStatus>(
    "/api/live/session/start",
    { method: "POST", body: JSON.stringify(input) },
    "开播失败",
  );
}

export async function stopLiveSession(): Promise<LiveSessionStatus> {
  return req<LiveSessionStatus>("/api/live/session/stop", { method: "POST", body: JSON.stringify({}) }, "停播失败");
}

export async function getLiveSessionStatus(): Promise<LiveSessionStatus> {
  return req<LiveSessionStatus>("/api/live/session/status", undefined, "会话状态查询失败");
}

// ---------- 表单辅助(纯函数,便于单测) ----------

/** 触发词输入(逗号/顿号/换行分隔)→ 去空白去重数组;空结果返回 [](后端 min_length=1 会 422,由 UI 拦截)。 */
export function parseTriggerWords(raw: string): string[] {
  const seen = new Set<string>();
  for (const part of raw.split(/[,，、\n]/)) {
    const w = part.trim();
    if (w && !seen.has(w)) seen.add(w);
  }
  return [...seen];
}
