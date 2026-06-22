"use client";

import type { Edge, Node } from "@xyflow/react";

import type { CanvasDraft } from "./types";

const DRAFT_KEY = "toiv_canvas_draft_v1";

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
