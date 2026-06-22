/** 管线编排:拓扑排序 + 从上游已连接节点取输入。纯函数,便于测试。 */

import type { Edge, Node } from "@xyflow/react";

import type { CanvasNodeType } from "./types";

/** 上游解析结果:连到某节点入口的源节点及其类型。 */
export interface UpstreamRef {
  sourceId: string;
  sourceType: CanvasNodeType;
}

/** 找到所有连入 targetId 入口的源节点。 */
export function upstreamOf(
  targetId: string,
  nodes: Node[],
  edges: Edge[],
): UpstreamRef[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const refs: UpstreamRef[] = [];
  for (const e of edges) {
    if (e.target !== targetId) continue;
    const src = byId.get(e.source);
    if (!src?.type) continue;
    refs.push({ sourceId: e.source, sourceType: src.type as CanvasNodeType });
  }
  return refs;
}

/**
 * Kahn 拓扑排序。返回可执行顺序的节点 id 数组。
 * 有环时把剩余节点按原序追加(不阻断,避免死锁)。
 */
export function topoOrder(nodes: Node[], edges: Edge[]): string[] {
  const ids = nodes.map((n) => n.id);
  const indeg = new Map<string, number>(ids.map((id) => [id, 0]));
  const adj = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const e of edges) {
    if (!indeg.has(e.target) || !adj.has(e.source)) continue;
    indeg.set(e.target, (indeg.get(e.target) ?? 0) + 1);
    adj.get(e.source)!.push(e.target);
  }

  const queue = ids.filter((id) => (indeg.get(id) ?? 0) === 0);
  const order: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    order.push(id);
    for (const next of adj.get(id) ?? []) {
      const d = (indeg.get(next) ?? 0) - 1;
      indeg.set(next, d);
      if (d === 0) queue.push(next);
    }
  }

  // 有环:把未排到的节点按原序补上,保证「运行全部」不丢节点。
  if (order.length < ids.length) {
    const seen = new Set(order);
    for (const id of ids) if (!seen.has(id)) order.push(id);
  }
  return order;
}
