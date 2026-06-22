"use client";

import { Handle, Position, type NodeProps } from "@xyflow/react";

import { OptimizeButton } from "@/components/ui/OptimizeButton";

import { useCanvas } from "../CanvasContext";
import type { TextNodeData } from "../types";
import { NodeShell } from "./NodeShell";

/** 📝 文本节点:提示词输入 + AI 优化。输出口:text。无入口(管线起点)。 */
export function TextNode({ id, data, selected }: NodeProps) {
  const d = data as unknown as TextNodeData;
  const { patchNodeData, deleteNode } = useCanvas();

  return (
    <NodeShell type="text" selected={selected} onDelete={() => deleteNode(id)}>
      <textarea
        className="cv-text nodrag"
        rows={4}
        placeholder="写下你的创意提示词,如:雪山日出,云海翻涌,电影感"
        value={d.prompt}
        onChange={(e) => patchNodeData(id, { prompt: e.target.value })}
      />
      <div className="cv-row cv-row--end nodrag">
        <OptimizeButton
          value={d.prompt}
          kind="image"
          onResult={(opt) => patchNodeData(id, { prompt: opt })}
        />
      </div>

      <Handle
        type="source"
        position={Position.Right}
        id="text"
        className="cv-handle cv-handle--text"
      />
    </NodeShell>
  );
}
