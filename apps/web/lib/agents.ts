import { API_BASE, getToken } from "./api";

/**
 * 智能体驱动的提示词优化 —— 前端 API client + 本地持久化。
 *
 * 后端契约见 docs/2026-07-14-agent-optimizer-design.md。
 * listAgents 出错时返回空数组(优雅降级:让 AgentSwitcher / OptimizeButton
 * 退化到"无智能体可选,走原默认 system prompt"路径,不阻塞主流程)。
 *
 * 注意:后端 applies_to 在响应中可能是逗号串(老路径)或数组(契约理想态),
 * 这里统一归一化为数组,消费方无需关心。
 */

export interface Agent {
  id: string;
  name: string;
  description: string;
  icon: string;
  /** 后端逗号串 → 前端数组;含 "all" 表示适用所有 kind */
  applies_to: string[];
  system_prompt: string;
  is_nsfw: boolean;
  is_builtin: boolean;
  llm_model_override: string | null;
  sort: number;
}

/** localStorage 键:当前选中的全局默认智能体 id(顶栏切换用)。 */
export const DEFAULT_AGENT_KEY = "toiv_default_agent";

function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { Authorization: `Bearer ${t}` } : {};
}

/** 把后端 applies_to(可能是逗号串或数组)归一化为数组。 */
function normalizeAppliesTo(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map((x) => String(x)).filter(Boolean);
  if (typeof raw === "string") {
    return raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  return ["all"];
}

/** 把后端原始对象(可能是 snake_case + applies_to 串)归一化为前端 Agent。 */
function normalizeAgent(raw: unknown): Agent {
  const a = raw as Record<string, unknown>;
  return {
    id: String(a.id ?? ""),
    name: String(a.name ?? ""),
    description: String(a.description ?? ""),
    icon: String(a.icon ?? "sparkles"),
    applies_to: normalizeAppliesTo(a.applies_to),
    system_prompt: String(a.system_prompt ?? ""),
    is_nsfw: a.is_nsfw === true || a.is_nsfw === 1,
    is_builtin: a.is_builtin === true || a.is_builtin === 1,
    llm_model_override:
      a.llm_model_override == null ? null : String(a.llm_model_override),
    sort: typeof a.sort === "number" ? a.sort : Number(a.sort ?? 100) || 100,
  };
}

async function parseErr(res: Response, fallback: string): Promise<Error> {
  const detail = await res.json().catch(() => null);
  return new Error(detail?.detail ?? `${fallback} (${res.status})`);
}

/**
 * 拉智能体列表。
 * @param kind 可选,按 applies_to 过滤(后端按用户 R18 状态自动过滤 NSFW)
 * @returns 失败时返回 [] 而非抛错(优雅降级,避免阻断 UI)
 */
export async function listAgents(kind?: string): Promise<Agent[]> {
  try {
    const qs = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    const res = await fetch(`${API_BASE}/api/agents${qs}`, {
      headers: authHeaders(),
    });
    if (!res.ok) return [];
    const data = (await res.json()) as unknown;
    const list = Array.isArray(data)
      ? data
      : Array.isArray((data as { items?: unknown[] })?.items)
        ? (data as { items: unknown[] }).items
        : [];
    return list.map(normalizeAgent);
  } catch {
    return [];
  }
}

/** 智能体详情;NSFW 智能体需 R18 鉴权,失败抛错。 */
export async function getAgent(id: string): Promise<Agent> {
  const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}`, {
    headers: authHeaders(),
  });
  if (!res.ok) throw await parseErr(res, "加载智能体失败");
  return normalizeAgent(await res.json());
}

/** 创建自定义智能体(admin);is_builtin 由后端强制 false。 */
export async function createAgent(data: Partial<Agent>): Promise<Agent> {
  const res = await fetch(`${API_BASE}/api/agents`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(serializeAgent(data)),
  });
  if (!res.ok) throw await parseErr(res, "创建智能体失败");
  return normalizeAgent(await res.json());
}

/** 改智能体(内置可改不可删);system_prompt 可改。 */
export async function updateAgent(id: string, data: Partial<Agent>): Promise<Agent> {
  const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(serializeAgent(data)),
  });
  if (!res.ok) throw await parseErr(res, "保存智能体失败");
  return normalizeAgent(await res.json());
}

/** 删智能体;内置拒删返 403。 */
export async function deleteAgent(id: string): Promise<void> {
  const res = await fetch(`${API_BASE}/api/agents/${encodeURIComponent(id)}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw await parseErr(res, "删除失败");
}

/** 把前端 Agent 部分字段序列化为后端期望的形态(applies_to 回写成逗号串)。 */
function serializeAgent(data: Partial<Agent>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (data.name != null) out.name = data.name;
  if (data.description != null) out.description = data.description;
  if (data.icon != null) out.icon = data.icon;
  if (data.applies_to != null) out.applies_to = data.applies_to.join(",");
  if (data.system_prompt != null) out.system_prompt = data.system_prompt;
  if (data.is_nsfw != null) out.is_nsfw = data.is_nsfw;
  if (data.llm_model_override !== undefined)
    out.llm_model_override = data.llm_model_override;
  if (data.sort != null) out.sort = data.sort;
  return out;
}

/** 持久化 PUT /api/account/preferences { default_agent_id }。失败只 console.warn。 */
export async function persistDefaultAgent(id: string | null): Promise<void> {
  try {
    const res = await fetch(`${API_BASE}/api/account/preferences`, {
      method: "PUT",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ default_agent_id: id ?? null }),
    });
    if (!res.ok) {
      console.warn("[agents] persist preferences failed:", res.status);
    }
  } catch (e) {
    console.warn("[agents] persist preferences error:", e);
  }
}

/**
 * 调 /api/optimize(带 agent_id + kind + model + style_hint)→ 返回 { optimized, negative }。
 * 由 OptimizeButton 在新式调用下使用;失败抛错(按钮 loading 态由调用方管)。
 * styleHint:用户自由描述的风格方向,后端按最高优先级注入系统提示。
 */
export async function optimizeWithAgent(params: {
  prompt: string;
  kind: string;
  model?: string;
  agentId?: string | null;
  styleHint?: string;
}): Promise<{ optimized: string; negative: string | null }> {
  const { prompt, kind, model, agentId, styleHint } = params;
  const res = await fetch(`${API_BASE}/api/optimize`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({
      prompt,
      kind,
      ...(model ? { model } : {}),
      ...(agentId ? { agent_id: agentId } : {}),
      ...(styleHint?.trim() ? { style_hint: styleHint.trim() } : {}),
    }),
  });
  if (!res.ok) throw await parseErr(res, "优化失败");
  const data = (await res.json()) as { optimized?: string; negative?: string | null };
  return {
    optimized: (data.optimized as string) ?? prompt,
    negative: data.negative ?? null,
  };
}

// ---------- localStorage 持久化(顶栏全局默认智能体)----------

export function getLocalAgent(): string | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(DEFAULT_AGENT_KEY);
    return v && v.length > 0 ? v : null;
  } catch {
    return null;
  }
}

export function setLocalAgent(id: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (id) window.localStorage.setItem(DEFAULT_AGENT_KEY, id);
    else window.localStorage.removeItem(DEFAULT_AGENT_KEY);
  } catch {
    /* localStorage 不可用时静默忽略(隐私模式 / 配额满) */
  }
}
