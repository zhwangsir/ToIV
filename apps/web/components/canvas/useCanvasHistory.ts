// 画布操作历史:撤销/重做(CV2 操作手感)。
// 约定:在「变更发生前」调用 record() 压入当前快照;撤销/重做在 past/future 间切换。
// 只记录离散结构变更(连线 / 增删节点 / 配方 / 粘贴),不记录拖动中间态——拖动撤销价值低、噪声大。
import { useCallback, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";
import type { Edge, Node } from "@xyflow/react";

interface Snap {
  nodes: Node[];
  edges: Edge[];
}

const LIMIT = 60;

export function useCanvasHistory(
  nodes: Node[],
  edges: Edge[],
  setNodes: Dispatch<SetStateAction<Node[]>>,
  setEdges: Dispatch<SetStateAction<Edge[]>>,
) {
  const past = useRef<Snap[]>([]);
  const future = useRef<Snap[]>([]);
  // 始终持有「最新一次渲染」的 nodes/edges,作为变更前快照来源。
  const cur = useRef<Snap>({ nodes, edges });
  cur.current = { nodes, edges };
  // 仅用于在栈变化时触发重渲染,让 canUndo/canRedo 驱动按钮 disabled。
  const [, setVer] = useState(0);

  const record = useCallback(() => {
    past.current.push({ nodes: cur.current.nodes, edges: cur.current.edges });
    if (past.current.length > LIMIT) past.current.shift();
    future.current = [];
    setVer((v) => v + 1);
  }, []);

  const undo = useCallback(() => {
    const prev = past.current.pop();
    if (!prev) return;
    future.current.push({ nodes: cur.current.nodes, edges: cur.current.edges });
    setNodes(prev.nodes);
    setEdges(prev.edges);
    setVer((v) => v + 1);
  }, [setNodes, setEdges]);

  const redo = useCallback(() => {
    const next = future.current.pop();
    if (!next) return;
    past.current.push({ nodes: cur.current.nodes, edges: cur.current.edges });
    setNodes(next.nodes);
    setEdges(next.edges);
    setVer((v) => v + 1);
  }, [setNodes, setEdges]);

  return {
    record,
    undo,
    redo,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
