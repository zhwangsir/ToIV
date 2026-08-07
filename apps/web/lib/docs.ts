/**
 * 文档上传与长文本理解 —— /api/docs 系列接口 + 支持 document_ids 的对话请求。
 *
 * 独立于 lib/api.ts(该文件由另一条线并行维护):复用其导出的 apiFetch/authHeaders,
 * agentChatWithDocs 是 agentChat 的 document_ids 变体(SSE 解析逻辑一致)。
 */
import { apiFetch, authHeaders } from "@/lib/api";
import type { AgentEvent } from "@/lib/api";

export interface DocItem {
  id: string;
  filename: string;
  kind: string; // pdf | docx | txt | md
  size: number;
  chunk_count: number;
  status: "ready" | "partial" | "no_embed" | string;
  created_at: string;
}

async function raiseApiError(res: Response, fallback: string): Promise<never> {
  const detail = (await res.json().catch(() => null)) as { detail?: unknown } | null;
  throw new Error(
    typeof detail?.detail === "string" ? detail.detail : `${fallback} (${res.status})`,
  );
}

export async function listDocs(signal?: AbortSignal): Promise<DocItem[]> {
  const res = await apiFetch("/api/docs", { headers: authHeaders(), signal });
  if (!res.ok) await raiseApiError(res, "获取文档列表失败");
  return (await res.json()) as DocItem[];
}

export async function uploadDoc(file: File): Promise<DocItem> {
  const form = new FormData();
  form.append("file", file);
  const res = await apiFetch(
    "/api/docs/upload",
    { method: "POST", headers: authHeaders(), body: form },
    { longRequest: true }, // 大文件解析+embedding 可能数十秒
  );
  if (!res.ok) await raiseApiError(res, "文档上传失败");
  return (await res.json()) as DocItem;
}

export async function deleteDoc(id: string): Promise<void> {
  const res = await apiFetch(`/api/docs/${id}`, {
    method: "DELETE",
    headers: authHeaders(),
  });
  if (!res.ok) await raiseApiError(res, "删除文档失败");
}

/** 文档状态展示文案(与后端 status 对齐) */
export function docStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "已索引";
    case "partial":
      return "部分索引(超长截断)";
    case "no_embed":
      return "未索引(向量服务不可用)";
    default:
      return status;
  }
}

export function formatDocSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}

/**
 * agentChat 的文档挂载变体:请求体多带 document_ids。
 * 无挂载(documentIds 为空)时行为与 lib/api.ts 的 agentChat 一致。
 */
export async function agentChatWithDocs(
  messages: { role: string; content: string }[],
  documentIds: string[],
  onEvent: (ev: AgentEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await apiFetch(
    `/api/agent/chat`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", ...authHeaders() },
      body: JSON.stringify({ messages, document_ids: documentIds }),
      signal,
      // SSE 流式响应:不设超时(timeoutMs: 0),取消由调用方 signal 控制。
    },
    { timeoutMs: 0 },
  );
  if (!res.ok || !res.body) {
    const detail = await res.json().catch(() => null);
    throw new Error(detail?.detail ?? `对话失败 (${res.status})`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    // 事件以空行分隔;兼容 \r\n\r\n(sse-starlette/反代)与 \n\n
    const parts = buf.split(/\r?\n\r?\n/);
    buf = parts.pop() ?? "";
    for (const block of parts) {
      let event = "message";
      let data = "";
      for (const line of block.split(/\r?\n/)) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (event === "done") return;
      if (data) {
        try {
          onEvent(JSON.parse(data) as AgentEvent);
        } catch {
          /* ignore malformed chunk */
        }
      }
    }
  }
}
