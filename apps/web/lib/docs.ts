/**
 * 文档上传与长文本理解 —— /api/docs 系列接口 + 支持 document_ids 的对话请求。
 *
 * 独立于 lib/api.ts(该文件由另一条线并行维护):复用其导出的 apiFetch/authHeaders,
 * agentChatWithDocs 是 agentChat 的 document_ids 变体(SSE 解析逻辑一致)。
 */
import { apiFetch, authHeaders } from "@/lib/api";
import type { AgentEvent } from "@/lib/api";
import type { IconName } from "@/components/ui/Icon";

/**
 * 全格式文件识别(2026-08-28):与后端 services/docs.py 的 _KINDS 对齐。
 * 图片走 VLM 反推描述;csv/json 结构化预览;office 转 markdown;代码/文本直读。
 */
export const DOC_IMAGE_EXTS = ["jpg", "jpeg", "png", "webp", "gif", "bmp", "tiff", "tif"];
export const DOC_OFFICE_EXTS = ["pdf", "docx", "xlsx", "pptx"];
export const DOC_DATA_EXTS = ["csv", "json"];
export const DOC_TEXT_EXTS = [
  "txt", "md", "markdown", "log",
  "py", "js", "jsx", "ts", "tsx", "mjs", "cjs", "vue", "svelte",
  "html", "htm", "css", "scss", "less", "xml", "svg",
  "yaml", "yml", "toml", "ini", "cfg", "env",
  "sh", "bash", "zsh", "sql", "graphql",
  "java", "c", "h", "cpp", "hpp", "cc", "go", "rs", "rb", "php",
  "swift", "kt", "kts", "lua", "r", "scala", "pl", "ipynb",
];
export const DOC_ALL_EXTS = [
  ...DOC_OFFICE_EXTS,
  ...DOC_DATA_EXTS,
  ...DOC_TEXT_EXTS,
  ...DOC_IMAGE_EXTS,
];

/** 文件选择器 accept 串(扩展名形式,浏览器过滤灰掉不支持项) */
export const DOC_ACCEPT = DOC_ALL_EXTS.map((e) => `.${e}`).join(",");

/** 上传按钮旁的格式提示文案 */
export const DOC_FORMAT_HINT = "文档 / 表格 / 演示 / 数据 / 代码 / 图片,≤50MB";

/** 文件名 → 扩展名 kind(历史消息 chip 只存 filename,按扩展名推图标用) */
export function docKindFromFilename(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
}

/** 文档类型 → 图标(未知类型回退通用文件图标) */
export function docKindIcon(kind: string): IconName {
  const k = kind.toLowerCase();
  if (DOC_IMAGE_EXTS.includes(k)) return "fileimage";
  if (k === "xlsx" || k === "csv") return "sheet";
  if (k === "pptx") return "slides";
  if (k === "json" || k === "ipynb") return "filejson";
  if (k === "pdf" || k === "docx" || k === "txt" || k === "md" || k === "markdown" || k === "log") {
    return "file";
  }
  // 代码/标记文本;白名单外的未知类型回退通用文件图标
  return DOC_ALL_EXTS.includes(k) ? "filecode" : "file";
}

export interface DocItem {
  id: string;
  filename: string;
  kind: string; // pdf | docx | xlsx | pptx | txt | md | csv | json | 代码扩展 | 图片扩展
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
