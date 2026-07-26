/** 画布模块 API 客户端 —— 对接后端 /api/canvas* REST + SSE 端点。
 *
 * 所有方法自动带 JWT 鉴权头(复用 lib/api.ts 的 authHeaders)。
 */

import { API_BASE, authHeaders } from "@/lib/api";
import type {
  Canvas,
  CanvasEdge,
  CanvasNode,
  CanvasNodeKind,
  CanvasSnapshot,
} from "./types";

const BASE = `${API_BASE}/api/canvas`;

// ---------- 画布 CRUD ----------

export async function listCanvases(): Promise<Canvas[]> {
  const res = await fetch(`${BASE}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`列表失败 (${res.status})`);
  const data = await res.json();
  return data.items ?? [];
}

export async function getCanvas(id: string): Promise<CanvasSnapshot> {
  const res = await fetch(`${BASE}/${id}`, { headers: authHeaders() });
  if (!res.ok) throw new Error(`获取画布失败 (${res.status})`);
  return res.json();
}

export async function createCanvas(name?: string): Promise<Canvas> {
  const res = await fetch(`${BASE}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ name: name ?? "未命名画布" }),
  });
  if (!res.ok) throw new Error(`创建画布失败 (${res.status})`);
  return res.json();
}

export async function updateCanvas(
  id: string,
  patch: Partial<Pick<Canvas, "name" | "voice_active" | "default_ref_audio">>
): Promise<Canvas> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`更新画布失败 (${res.status})`);
  return res.json();
}

export async function deleteCanvas(id: string): Promise<void> {
  const res = await fetch(`${BASE}/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`删除画布失败 (${res.status})`);
}

// ---------- 节点 CRUD ----------

export interface CreateNodeInput {
  kind: CanvasNodeKind;
  title?: string;
  position_x: number;
  position_y: number;
  payload?: Record<string, unknown>;
  width?: number;
  height?: number;
}

export async function addNode(
  canvasId: string,
  input: CreateNodeInput
): Promise<CanvasNode> {
  const res = await fetch(`${BASE}/${canvasId}/nodes`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`添加节点失败 (${res.status})`);
  return res.json();
}

export interface UpdateNodeInput {
  title?: string;
  position_x?: number;
  position_y?: number;
  width?: number;
  height?: number;
  payload?: Record<string, unknown>;
  status?: CanvasNode["status"];
  error?: string;
}

export async function updateNode(
  canvasId: string,
  nodeId: string,
  patch: UpdateNodeInput
): Promise<CanvasNode> {
  const res = await fetch(`${BASE}/${canvasId}/nodes/${nodeId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(patch),
  });
  if (!res.ok) throw new Error(`更新节点失败 (${res.status})`);
  return res.json();
}

export async function deleteNode(
  canvasId: string,
  nodeId: string
): Promise<void> {
  const res = await fetch(`${BASE}/${canvasId}/nodes/${nodeId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`删除节点失败 (${res.status})`);
}

// ---------- 边 CRUD ----------

export interface CreateEdgeInput {
  source: string;
  target: string;
  source_handle?: string;
  target_handle?: string;
  label?: string;
}

export async function addEdge(
  canvasId: string,
  input: CreateEdgeInput
): Promise<CanvasEdge> {
  const res = await fetch(`${BASE}/${canvasId}/edges`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw new Error(`添加边失败 (${res.status})`);
  return res.json();
}

export async function deleteEdge(
  canvasId: string,
  edgeId: string
): Promise<void> {
  const res = await fetch(`${BASE}/${canvasId}/edges/${edgeId}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`删除边失败 (${res.status})`);
}

// ---------- 节点执行 ----------

export async function runNode(
  canvasId: string,
  nodeId: string
): Promise<CanvasNode> {
  const res = await fetch(`${BASE}/${canvasId}/run/${nodeId}`, {
    method: "POST",
    headers: authHeaders(),
  });
  if (!res.ok) throw new Error(`执行节点失败 (${res.status})`);
  return res.json();
}

// ---------- M2:ComfyUI 工作流模板库 + 子图执行 ----------

export interface WorkflowTemplate {
  id: string;
  name: string;
  description: string;
  kind_hint: string;
}

/** 模板库列表。契约:GET /api/canvas/workflows/templates → {items: WorkflowTemplate[]}
 * 注:实际路由在 /api/canvas 下(避免与 routes/workflows.py 的 /api/workflows 冲突)。 */
export async function listWorkflowTemplates(): Promise<WorkflowTemplate[]> {
  const res = await fetch(`${BASE}/workflows/templates`, {
    headers: authHeaders(),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `加载模板库失败 (${res.status})`);
  }
  const data = await res.json();
  return data.items ?? [];
}

/** 把模板 / ComfyUI prompt 解析为画布子图落库。
 * 契约:POST /api/canvas/{cid}/import_workflow
 * 成功返回新增节点/边 id 列表;节点经 SSE node_added 推送到 store。 */
export async function importWorkflow(
  canvasId: string,
  opts: { template_id?: string; comfy_prompt?: Record<string, unknown> }
): Promise<{ node_ids: string[]; edge_ids: string[]; count: number }> {
  const res = await fetch(`${BASE}/${canvasId}/import_workflow`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify(opts),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `导入工作流失败 (${res.status})`);
  }
  return res.json();
}

/** 把选定节点集合提交 ComfyUI 执行。
 * 契约:POST /api/canvas/{cid}/run_subgraph {node_ids}
 * 节点 status 由后端置 running 并经 SSE node_updated 推送。 */
export interface RunSubgraphResult {
  prompt_id: string;
  worker: string;
  report: { workflow_node_id: string; overrides: Record<string, string> };
  files: Array<{ filename: string; subfolder: string; type: string }>;
  urls: string[];
  /** M3.1:自动 pin 的产物节点(auto_pin=false 时为空数组) */
  pinned: CanvasNode[];
}

export async function runSubgraph(
  canvasId: string,
  nodeIds: string[]
): Promise<RunSubgraphResult> {
  const res = await fetch(`${BASE}/${canvasId}/run_subgraph`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...authHeaders() },
    body: JSON.stringify({ node_ids: nodeIds }),
  });
  if (!res.ok) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `执行子图失败 (${res.status})`);
  }
  return res.json();
}

// ---------- 画布事件 SSE 流 ----------
// 后端通过 SSE 推送节点状态变更(node_updated / node_added / edge_added 等)
// 返回 EventSource(调用方负责关闭)

export interface CanvasEvent {
  type:
    | "node_added"
    | "node_updated"
    | "node_deleted"
    | "edge_added"
    | "edge_deleted";
  canvas_id: string;
  node?: CanvasNode;
  edge?: CanvasEdge;
  node_id?: string;
  edge_id?: string;
}

export function subscribeCanvasEvents(
  canvasId: string,
  onEvent: (ev: CanvasEvent) => void,
  onError?: (err: Event) => void
): EventSource {
  // EventSource 不支持自定义 header,JWT 通过 URL query 传(后端 ?token= 兼容)
  const token = typeof window !== "undefined" ? window.localStorage.getItem("toiv_token") : null;
  const url = `${BASE}/${canvasId}/events${token ? `?token=${encodeURIComponent(token)}` : ""}`;
  const es = new EventSource(url);
  es.onmessage = (e) => {
    try {
      const ev = JSON.parse(e.data) as CanvasEvent;
      onEvent(ev);
    } catch {
      // 忽略解析失败的心跳等
    }
  };
  if (onError) es.onerror = onError;
  return es;
}
