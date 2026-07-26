"use client";

import { memo, useCallback, useMemo } from "react";
import { useCanvasStore } from "@/lib/canvas/store";
import type { CanvasNodeData, ComfyWorkflowPayload } from "@/lib/canvas/types";

interface ComfyWorkflowNodeBodyProps {
  data: CanvasNodeData;
  nodeId: string;
}

/** ComfyUI 工作流节点 body —— JSON 文本框 + 摘要展示,失焦回写 payload.graph。 */
function ComfyWorkflowNodeBodyImpl({ data, nodeId }: ComfyWorkflowNodeBodyProps) {
  const updateNodePayload = useCanvasStore((s) => s.updateNodePayload);
  const payload = data.payload as ComfyWorkflowPayload;

  // graph 序列化为可编辑 JSON;按 graph 引用缓存,避免每次渲染重复 stringify
  const graph = payload.graph;
  const graphText = useMemo(() => {
    try {
      return JSON.stringify(graph ?? {}, null, 2);
    } catch {
      return "{}";
    }
  }, [graph]);

  const onBlur = useCallback(
    (e: React.FocusEvent<HTMLTextAreaElement>) => {
      const next = e.target.value;
      let parsed: Record<string, unknown> = {};
      try {
        parsed = JSON.parse(next) as Record<string, unknown>;
      } catch {
        // 解析失败不回写,等用户修正
        return;
      }
      void updateNodePayload(nodeId, { graph: parsed });
    },
    [nodeId, updateNodePayload],
  );

  return (
    <>
      {payload.summary && (
        <div className="tn-response" style={{ maxHeight: 60 }}>
          {payload.summary}
        </div>
      )}
      <div className="tn-field">
        <label className="tn-field-label">工作流 JSON</label>
        <textarea
          className="tn-textarea"
          rows={6}
          defaultValue={graphText}
          onBlur={onBlur}
          placeholder='{"3": {"class_type": "KSampler", "inputs": {…}}}'
          spellCheck={false}
        />
      </div>
    </>
  );
}

// 只比较渲染用到的关键字段:payload.graph 引用 / payload.summary / status
export const ComfyWorkflowNodeBody = memo(
  ComfyWorkflowNodeBodyImpl,
  (prev, next) => {
    if (prev.nodeId !== next.nodeId || prev.data.status !== next.data.status) {
      return false;
    }
    const pp = prev.data.payload as ComfyWorkflowPayload;
    const np = next.data.payload as ComfyWorkflowPayload;
    return pp.graph === np.graph && pp.summary === np.summary;
  },
);
