"use client";

import type { Edge, Node } from "@xyflow/react";

import type { CanvasDraft } from "./types";

const DRAFT_KEY = "toiv_canvas_draft_v1";
const LIBRARY_KEY = "toiv_canvas_workflows_v1";
const ARCHIVE_KEY = "toiv_canvas_archive_v1";

/** 把易变的运行态从节点 data 中剥掉(产物 URL 带 token 会过期,不入库)。 */
function stripRun(nodes: Node[]): Node[] {
  return nodes.map((n) => {
    const data = n.data as Record<string, unknown>;
    if (!data || !("run" in data)) return n;
    return {
      ...n,
      data: {
        ...data,
        run: {
          busy: false,
          stage: "",
          progress: null,
          error: null,
          outputUrl: null,
        },
      },
    };
  });
}

/** 存草稿(节点位置 + 参数 + 连线);静默失败不阻断创作。 */
export function saveDraft(nodes: Node[], edges: Edge[]): boolean {
  if (typeof window === "undefined") return false;
  try {
    const draft: CanvasDraft = { nodes: stripRun(nodes), edges, version: 1 };
    window.localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
    return true;
  } catch {
    return false;
  }
}

/** 读草稿;无 / 损坏返回 null。 */
export function loadDraft(): CanvasDraft | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CanvasDraft;
    if (parsed?.version !== 1 || !Array.isArray(parsed.nodes)) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function clearDraft(): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.removeItem(DRAFT_KEY);
  } catch {
    /* ignore */
  }
}

// ── 命名工作流库(多草稿) ───────────────────────────────────
//   localStorage 一个 key 存「工作流列表」,每条含 id/名称/时间戳/快照。
//   live 草稿(DRAFT_KEY)仍独立自动保存当前编辑态;命名工作流是显式存档点。

/** 库内一条命名工作流。 */
export interface SavedWorkflow {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodes: Node[];
  edges: Edge[];
}

/** 列表项(不含重负载 nodes/edges,供菜单轻量渲染)。 */
export interface WorkflowSummary {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
}

interface WorkflowLibrary {
  version: 1;
  items: SavedWorkflow[];
}

let _wfSeq = 0;
function newWorkflowId(): string {
  return `wf-${Date.now().toString(36)}-${_wfSeq++}`;
}

function readLibrary(): WorkflowLibrary {
  if (typeof window === "undefined") return { version: 1, items: [] };
  try {
    const raw = window.localStorage.getItem(LIBRARY_KEY);
    if (!raw) return { version: 1, items: [] };
    const parsed = JSON.parse(raw) as WorkflowLibrary;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) {
      return { version: 1, items: [] };
    }
    return parsed;
  } catch {
    return { version: 1, items: [] };
  }
}

function writeLibrary(lib: WorkflowLibrary): boolean {
  if (typeof window === "undefined") return false;
  try {
    window.localStorage.setItem(LIBRARY_KEY, JSON.stringify(lib));
    return true;
  } catch {
    return false;
  }
}

/** 列出所有命名工作流(按更新时间倒序),仅摘要。 */
export function listWorkflows(): WorkflowSummary[] {
  return readLibrary()
    .items.map((w) => ({
      id: w.id,
      name: w.name,
      createdAt: w.createdAt,
      updatedAt: w.updatedAt,
      nodeCount: w.nodes.length,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** 读取单条完整工作流(打开用);不存在返回 null。 */
export function getWorkflow(id: string): SavedWorkflow | null {
  return readLibrary().items.find((w) => w.id === id) ?? null;
}

/** 新建命名工作流(另存为);返回新 id,失败返回 null。 */
export function createWorkflow(
  name: string,
  nodes: Node[],
  edges: Edge[],
): string | null {
  const lib = readLibrary();
  const now = Date.now();
  const item: SavedWorkflow = {
    id: newWorkflowId(),
    name: name.trim() || "未命名工作流",
    createdAt: now,
    updatedAt: now,
    nodes: stripRun(nodes),
    edges,
  };
  // 不可变更新:追加新条目。
  const next: WorkflowLibrary = { version: 1, items: [...lib.items, item] };
  return writeLibrary(next) ? item.id : null;
}

/** 覆盖保存已存在的工作流(保存当前)。不存在返回 false。 */
export function updateWorkflow(
  id: string,
  nodes: Node[],
  edges: Edge[],
): boolean {
  const lib = readLibrary();
  let found = false;
  const items = lib.items.map((w) => {
    if (w.id !== id) return w;
    found = true;
    return { ...w, nodes: stripRun(nodes), edges, updatedAt: Date.now() };
  });
  if (!found) return false;
  return writeLibrary({ version: 1, items });
}

/** 重命名工作流。不存在返回 false。 */
export function renameWorkflow(id: string, name: string): boolean {
  const lib = readLibrary();
  let found = false;
  const items = lib.items.map((w) => {
    if (w.id !== id) return w;
    found = true;
    return { ...w, name: name.trim() || w.name, updatedAt: Date.now() };
  });
  if (!found) return false;
  return writeLibrary({ version: 1, items });
}

/** 删除工作流。 */
export function deleteWorkflow(id: string): boolean {
  const lib = readLibrary();
  const items = lib.items.filter((w) => w.id !== id);
  if (items.length === lib.items.length) return false;
  return writeLibrary({ version: 1, items });
}

// ── 产物归档(客户端作品库标记) ─────────────────────────────
//   画布产物本身经由 /api/generate/* 已落库进作品库(/api/jobs);
//   这里额外维护一份「画布归档」客户端清单,作为用户主动收藏的标记,
//   不依赖后端新端点(优先客户端实现),去重按 url。

/** 一条归档记录。 */
export interface ArchivedAsset {
  url: string;
  /** 来源节点类型(image/video/character/threed…),供作品库分类展示。 */
  kind: string;
  /** 关联提示词/描述(可空)。 */
  prompt: string;
  archivedAt: number;
}

interface ArchiveStore {
  version: 1;
  items: ArchivedAsset[];
}

function readArchive(): ArchiveStore {
  if (typeof window === "undefined") return { version: 1, items: [] };
  try {
    const raw = window.localStorage.getItem(ARCHIVE_KEY);
    if (!raw) return { version: 1, items: [] };
    const parsed = JSON.parse(raw) as ArchiveStore;
    if (parsed?.version !== 1 || !Array.isArray(parsed.items)) {
      return { version: 1, items: [] };
    }
    return parsed;
  } catch {
    return { version: 1, items: [] };
  }
}

/** 列出已归档产物(倒序)。 */
export function listArchived(): ArchivedAsset[] {
  return [...readArchive().items].sort((a, b) => b.archivedAt - a.archivedAt);
}

/** 某 url 是否已归档(节点按钮态判断)。 */
export function isArchived(url: string): boolean {
  return readArchive().items.some((a) => a.url === url);
}

/** 归档一个产物 url(已存在则幂等返回 true)。 */
export function archiveAsset(
  url: string,
  kind: string,
  prompt: string,
): boolean {
  if (typeof window === "undefined") return false;
  const store = readArchive();
  if (store.items.some((a) => a.url === url)) return true; // 去重幂等
  const item: ArchivedAsset = {
    url,
    kind,
    prompt: prompt.trim(),
    archivedAt: Date.now(),
  };
  const next: ArchiveStore = { version: 1, items: [...store.items, item] };
  try {
    window.localStorage.setItem(ARCHIVE_KEY, JSON.stringify(next));
    return true;
  } catch {
    return false;
  }
}
